/**
 * The host side of a remote terminal (SPEC §20.4 "Remote terminal"): one
 * trusted-link stream from a paired peer, served by running `tmux
 * attach-session` on a local agent's session under a PTY (Bun.Terminal).
 *
 * The client is interactive: whatever it types reaches that tmux client, so a
 * paired peer can use every tmux command, including opening a shell outside
 * the agent's sandbox. The pairing is the only gate (SPEC §20.4).
 *
 * peer-link.ts hands a stream here when its first byte is the open frame's
 * type (terminal-frame.ts). This module never imports peer-link.ts: closing
 * the connection goes through the callbacks in {@link ServeTerminalDeps}.
 */

import type { Agent } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { hasAttachedClient } from "../tmux-poller";
import { PINNED_TMUX_WIDTH } from "../tui/widths";
import { tmuxSessionTarget } from "../validation";
import type { PairStream } from "./pairing";
import { waitForIO } from "./send-frame";
import {
  MAX_TERMINAL_DATA,
  TERMINAL_FRAME,
  TerminalFrameReader,
  TerminalProtocolError,
  encodeTerminalData,
  encodeTerminalExit,
  parseTerminalOpen,
  parseTerminalResize,
  type TerminalFrame,
  type TerminalOpen,
  type TerminalSize,
} from "./terminal-frame";

/** Live terminal sessions one `ib watch` hosts, across all peers. */
export const MAX_TERMINAL_SESSIONS = 8;
/** How often a live session re-reads `peers.json`, so `ib peer remove` ends it. */
export const TERMINAL_PAIRING_CHECK_MS = 5_000;
/**
 * Output queued for the link past this ends the session. Nothing throttles
 * the source: Bun.Terminal reads the PTY as fast as it can and has no pause,
 * and the tmux server (not the attach-session process) writes the PTY, so
 * stopping the client would not slow it either.
 */
export const MAX_TERMINAL_BACKLOG = 4 * 1024 * 1024;
const TERM = "xterm-256color";

/** A process running under a PTY. */
export interface TerminalProcess {
  write(bytes: Uint8Array): void;
  resize(size: TerminalSize): void;
  /** End the process: for `tmux attach-session`, the client detaches and the agent keeps running. */
  kill(): void;
  /** The exit code, once the process has exited and its output has been delivered. */
  exited: Promise<number | null>;
}

export interface TerminalHostDeps {
  /** The tmux session of a local agent; throws with the reason to send back. */
  findSession(agent: string, repo: string | undefined): string;
  spawn(session: string, size: TerminalSize, onData: (bytes: Uint8Array) => void): Promise<TerminalProcess>;
  /** The live sessions of this `ib watch`, shared by every connection. */
  sessions: Set<object>;
}

export interface ServeTerminalDeps extends TerminalHostDeps {
  /** Paired name for this id, re-read on every call. A failed read returns null. */
  peerName(id: string): Promise<string | null>;
  setTimer(ms: number, fn: () => void): () => void;
  log(line: string): void;
  /** Close the connection: the peer is no longer in `peers.json`. */
  closeNotPeer(): void;
  /** Close the connection for a protocol error. */
  closeError(reason: string): void;
}

/** For a responder built without terminal support: every open is refused. */
export const TERMINALS_UNAVAILABLE: TerminalHostDeps = {
  findSession: () => { throw new Error("Remote terminals are unavailable"); },
  spawn: () => Promise.reject(new Error("Remote terminals are unavailable")),
  sessions: new Set(),
};

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Answer with an exit frame alone, and end the stream. */
async function refuse(stream: PairStream, deps: Pick<ServeTerminalDeps, "setTimer">, reason: string): Promise<void> {
  try {
    await waitForIO(deps, () => stream.writeAll(encodeTerminalExit({ code: null, reason })));
    await waitForIO(deps, () => stream.finish());
  } catch {
    await stream.cancel().catch(() => {});
    return;
  }
  await stream.stopReceiving().catch(() => {});
}

/**
 * Serve one terminal stream until it ends. `first` is what peer-link.ts has
 * already read. Checks the pairing again before attaching, and every
 * {@link TERMINAL_PAIRING_CHECK_MS} while attached. Never throws.
 */
export async function serveTerminal(remoteId: string, stream: PairStream, first: Uint8Array, from: string, deps: ServeTerminalDeps): Promise<void> {
  const reader = new TerminalFrameReader();
  let open: TerminalOpen;
  let early: TerminalFrame[];
  try {
    let frames = reader.push(first);
    while (!frames.length) {
      const chunk = await waitForIO(deps, () => stream.read(MAX_TERMINAL_DATA));
      if (!chunk.length) throw new TerminalProtocolError("terminal stream ended before its open frame");
      frames = reader.push(chunk);
    }
    const [head, ...rest] = frames;
    if (head!.type !== TERMINAL_FRAME.open) throw new TerminalProtocolError("terminal stream does not start with an open frame");
    open = parseTerminalOpen(head!.payload, { allowPeer: false });
    early = rest;
  } catch (err) {
    if (err instanceof TerminalProtocolError) {
      deps.log(`peer link: ${err.message}, from ${from}; closing`);
      deps.closeError(err.message);
    } else {
      await refuse(stream, deps, errorDetail(err));
    }
    return;
  }

  const name = await deps.peerName(remoteId);
  if (name === null) {
    deps.log(`peer link: refused a terminal from ${from}: no longer a peer; closing`);
    deps.closeNotPeer();
    return;
  }
  if (deps.sessions.size >= MAX_TERMINAL_SESSIONS) {
    await refuse(stream, deps, `too many remote terminals (${MAX_TERMINAL_SESSIONS}); try again later`);
    return;
  }
  let session: string;
  try {
    session = deps.findSession(open.agent, open.repo);
  } catch (err) {
    deps.log(`peer link: refused a terminal on ${open.agent} from ${name} (${from}): ${errorDetail(err)}`);
    await refuse(stream, deps, errorDetail(err));
    return;
  }

  const token = {};
  deps.sessions.add(token);
  try {
    await runSession(remoteId, stream, reader, early, open, session, `${name} (${from})`, deps);
  } finally {
    deps.sessions.delete(token);
  }
}

async function runSession(
  remoteId: string, stream: PairStream, reader: TerminalFrameReader, early: TerminalFrame[],
  open: TerminalOpen, session: string, who: string, deps: ServeTerminalDeps,
): Promise<void> {
  // The first reason the session ends wins; the process is killed once.
  let reason: string | null = null;
  let proc: TerminalProcess | undefined;
  let killed = false;
  const end = (why: string) => {
    reason ??= why;
    if (proc && !killed) {
      killed = true;
      proc.kill();
    }
  };

  // One writer, in order. Output that outruns the link ends the session
  // instead of growing the queue without bound.
  let writing = Promise.resolve();
  let backlog = 0;
  let writeFailed = false;
  const send = (frame: Uint8Array) => {
    if (writeFailed) return;
    backlog += frame.length;
    if (backlog > MAX_TERMINAL_BACKLOG) end("terminal output outran the link");
    writing = writing.then(() => writeFailed ? undefined : stream.writeAll(frame)).then(
      () => { backlog -= frame.length; },
      err => { writeFailed = true; end(`stream write failed: ${errorDetail(err)}`); },
    );
  };

  try {
    proc = await deps.spawn(session, open, bytes => { for (const frame of encodeTerminalData(bytes)) send(frame); });
  } catch (err) {
    await refuse(stream, deps, `could not attach: ${errorDetail(err)}`);
    return;
  }
  const attached = proc;
  deps.log(`peer link: ${who} attached a terminal to ${open.agent}`);
  if (reason !== null) end(reason); // the output backlog filled before spawn returned

  let clientFinished = false;
  let protocolError: string | null = null;
  const apply = (frame: TerminalFrame) => {
    if (frame.type === TERMINAL_FRAME.data) attached.write(frame.payload);
    else if (frame.type === TERMINAL_FRAME.resize) attached.resize(parseTerminalResize(frame.payload));
    else throw new TerminalProtocolError(`unexpected terminal frame type ${frame.type}`);
  };
  const input = (async () => {
    try {
      for (const frame of early) apply(frame);
      for (;;) {
        const chunk = await stream.read(MAX_TERMINAL_DATA);
        if (!chunk.length) {
          if (reader.pending) throw new TerminalProtocolError("terminal stream ended inside a frame");
          clientFinished = true;
          end("the client detached");
          return;
        }
        for (const frame of reader.push(chunk)) apply(frame);
      }
    } catch (err) {
      if (err instanceof TerminalProtocolError) protocolError = err.message;
      end(errorDetail(err));
    }
  })();

  let ended = false;
  let removed = false;
  let cancelCheck = () => {};
  const armCheck = () => {
    cancelCheck = deps.setTimer(TERMINAL_PAIRING_CHECK_MS, () => {
      void deps.peerName(remoteId).then(name => {
        if (ended) return;
        if (name !== null) { armCheck(); return; }
        removed = true;
        end("no longer a peer");
        deps.log(`peer link: ended a terminal from ${who}: no longer a peer; closing`);
        deps.closeNotPeer();
      });
    });
  };
  armCheck();

  const code = await attached.exited;
  ended = true;
  cancelCheck();
  // Teardown below can fail the input loop too; that is not why the session ended.
  const why: string = reason ??= "exited";
  if (!removed && !writeFailed) {
    send(encodeTerminalExit({ code, reason: why }));
    try {
      await waitForIO(deps, () => writing);
      if (!writeFailed) await waitForIO(deps, () => stream.finish());
    } catch {
      await stream.cancel().catch(() => {});
    }
  }
  if (!clientFinished) await stream.stopReceiving().catch(() => {});
  await input;
  deps.log(`peer link: terminal from ${who} on ${open.agent} ended: ${why}`);
  if (protocolError !== null) deps.closeError(protocolError);
}

/** The real host: `agents` is the watcher's last fully detected list (`lastDetectedAgents`). */
export function localTerminalHost(agents: () => readonly Agent[]): TerminalHostDeps {
  return {
    findSession: (agent, repo) => findAgentSession(agents(), agent, repo),
    spawn: (session, size, onData) => spawnTmuxAttach(session, size, onData),
    sessions: new Set(),
  };
}

/**
 * The tmux session of local agent `agent` (in registry repo `repo`, ignoring
 * case, when given) among the watcher's agents. Never the system coordinator.
 */
export function findAgentSession(agents: readonly Agent[], agent: string, repo: string | undefined): string {
  const matches = agents.filter(a => a.id === agent && a.meta.agentType !== SYSTEM_COORDINATOR_TYPE
    && (repo === undefined || a.repoRegistryName.toLowerCase() === repo.toLowerCase()));
  if (matches.length === 0) throw new Error(`no agent ${agent}${repo === undefined ? "" : ` in ${repo}`} on this machine`);
  if (matches.length > 1) throw new Error(`more than one agent is named ${agent}; name its repo`);
  const session = matches[0]!.meta.tmux_session;
  if (!session || !/^[\w-]+$/.test(session)) throw new Error(`agent ${agent} has no tmux session`);
  return session;
}

/**
 * Run `argv` under a new PTY of `size`. TMUX and TMUX_PANE are removed from
 * its environment, so `tmux attach-session` works when `ib watch` itself runs
 * inside tmux. Input the PTY cannot take yet is queued until it drains.
 */
export function spawnPtyProcess(argv: string[], size: TerminalSize, onData: (bytes: Uint8Array) => void): TerminalProcess {
  const env: Record<string, string | undefined> = { ...process.env, TERM };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const queued: Uint8Array[] = [];
  const eof = Promise.withResolvers<void>();
  let terminal: Bun.Terminal;
  const flush = () => {
    while (queued.length && !terminal.closed) {
      const head = queued[0]!;
      const written = terminal.write(head);
      if (written <= 0) return;
      if (written < head.length) { queued[0] = head.subarray(written); return; }
      queued.shift();
    }
  };
  const proc = Bun.spawn(argv, {
    env,
    terminal: {
      cols: size.cols, rows: size.rows, name: TERM,
      data: (_term, bytes) => onData(bytes),
      exit: () => eof.resolve(),
      drain: () => flush(),
    },
  });
  terminal = proc.terminal!;
  return {
    write: (bytes) => {
      queued.push(Uint8Array.from(bytes));
      if (queued.length === 1) flush();
    },
    resize: ({ cols, rows }) => { if (!terminal.closed) terminal.resize(cols, rows); },
    kill: () => { proc.kill("SIGHUP"); },
    // The PTY can still hold output when the process exits: wait for its EOF,
    // briefly, before the caller sends the exit frame.
    exited: proc.exited.then(async (code) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([eof.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
      clearTimeout(timer);
      terminal.close();
      return code;
    }),
  };
}

export interface TmuxAttachDeps {
  /** Run one tmux command and wait for it; failures are ignored by the caller. */
  runTmux(args: string[]): Promise<unknown>;
  /** Whether any tmux client is still attached to the session. */
  hasClients(session: string): Promise<boolean>;
  spawnPty(argv: string[], size: TerminalSize, onData: (bytes: Uint8Array) => void): TerminalProcess;
}

const defaultTmuxAttachDeps: TmuxAttachDeps = {
  runTmux: async (args) => {
    const proc = Bun.spawn(["tmux", ...args], { stdout: "ignore", stderr: "ignore" });
    return proc.exited;
  },
  hasClients: hasAttachedClient,
  spawnPty: spawnPtyProcess,
};

/**
 * `tmux attach-session` on `session`, sized like the Ghostty attach
 * (src/ghostty.ts): `window-size latest` first, so the window takes the
 * client's size. Once the client exits and no other client (a local Ghostty
 * attach, another remote one) is left, the window is pinned back to
 * PINNED_TMUX_WIDTH, so the dashboard's capture keeps its width; like the
 * dashboard's own re-pin, it waits for the last client to go.
 */
export async function spawnTmuxAttach(
  session: string, size: TerminalSize, onData: (bytes: Uint8Array) => void, deps: TmuxAttachDeps = defaultTmuxAttachDeps,
): Promise<TerminalProcess> {
  const target = tmuxSessionTarget(session);
  await deps.runTmux(["set-option", "-t", target, "window-size", "latest"]).catch(() => {});
  const proc = deps.spawnPty(["tmux", "attach-session", "-t", target], size, onData);
  return {
    ...proc,
    exited: proc.exited.then(async (code) => {
      if (!await deps.hasClients(session).catch(() => true)) {
        await deps.runTmux(["resize-window", "-t", target, "-x", String(PINNED_TMUX_WIDTH)]).catch(() => {});
      }
      return code;
    }),
  };
}

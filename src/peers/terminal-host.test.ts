import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { makeAgent, waitFor } from "../test-utils";
import { PINNED_TMUX_WIDTH } from "../tui/widths";
import { irohAddonLoaderCtx } from "./iroh";
import { PEER_CLOSE, serveTrustedConnection } from "./peer-link";
import type { PairStream } from "./pairing";
import {
  TERMINAL_FRAME,
  TerminalFrameReader,
  encodeTerminalData,
  encodeTerminalFrame,
  encodeTerminalOpen,
  encodeTerminalResize,
  parseTerminalExit,
  type TerminalFrame,
  type TerminalSize,
} from "./terminal-frame";
import {
  MAX_TERMINAL_BACKLOG,
  MAX_TERMINAL_SESSIONS,
  TERMINAL_PAIRING_CHECK_MS,
  TERMINAL_PAUSE_BYTES,
  findAgentSession,
  serveTerminal,
  spawnPtyProcess,
  spawnTmuxAttach,
  type TerminalHostDeps,
  type TerminalProcess,
} from "./terminal-host";
import { createFakeClock, createMemoryLink } from "./test-pair-transport";

const CLIENT = "a1".repeat(32);
const HOST = "b2".repeat(32);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

beforeEach(() => {
  irohAddonLoaderCtx.set(async () => {
    throw new Error("a terminal-host test loaded the iroh addon");
  });
});
afterEach(() => irohAddonLoaderCtx.reset());

/** A process the test drives: it records input and resizes, and exits when told or killed. */
function fakeProcess(onData: (bytes: Uint8Array) => void) {
  const done = Promise.withResolvers<number | null>();
  const proc = {
    input: [] as string[],
    sizes: [] as TerminalSize[],
    kills: 0,
    pauses: 0,
    resumes: 0,
    output: (value: string) => onData(new TextEncoder().encode(value)),
    exit: (code: number | null) => done.resolve(code),
    write: (bytes: Uint8Array) => { proc.input.push(text(bytes)); },
    resize: (size: TerminalSize) => { proc.sizes.push(size); },
    pause: () => { proc.pauses++; },
    resume: () => { proc.resumes++; },
    kill: () => { proc.kills++; done.resolve(129); },
    exited: done.promise,
  };
  return proc;
}

/** The host serves the trusted ALPN on its end of a memory link, with a fake attach. */
function host(options: { terminal?: TerminalHostDeps | null; sessions?: Set<object> } = {}) {
  const link = createMemoryLink(CLIENT, HOST);
  const peers = new Set([CLIENT]);
  const logs: string[] = [];
  const clock = createFakeClock();
  const spawns: Array<{ session: string; size: TerminalSize; proc: ReturnType<typeof fakeProcess> }> = [];
  const terminal: TerminalHostDeps = {
    findSession: (agent, repo) => {
      if (agent !== "worker") throw new Error(`no agent ${agent} on this machine`);
      return repo === undefined ? "itsybitsy-0000abcd-worker" : `itsybitsy-${repo}-worker`;
    },
    spawn: async (session, size, onData) => {
      const proc = fakeProcess(onData);
      spawns.push({ session, size, proc });
      return proc;
    },
    sessions: options.sessions ?? new Set(),
  };
  const done = serveTrustedConnection(link.b, {
    setTimer: clock.setTimer,
    peerName: async (id) => peers.has(id) ? "Alice" : null,
    snapshot: () => ({ coordinator: null, repos: [], agents: [] }),
    ...(options.terminal !== null && { terminal: options.terminal ?? terminal }),
    log: (line) => logs.push(line),
  });
  return { a: link.a, b: link.b, peers, logs, clock, spawns, done };
}

/** Read every frame until the host finishes the stream. */
async function readAll(stream: PairStream): Promise<TerminalFrame[]> {
  const reader = new TerminalFrameReader();
  const frames: TerminalFrame[] = [];
  for (;;) {
    const chunk = await stream.read(65536);
    if (!chunk.length) return frames;
    frames.push(...reader.push(chunk));
  }
}

const outputOf = (frames: TerminalFrame[]) => frames.filter(f => f.type === TERMINAL_FRAME.data).map(f => text(f.payload)).join("");
const exitOf = (frames: TerminalFrame[]) => {
  const last = frames.at(-1);
  return last?.type === TERMINAL_FRAME.exit ? parseTerminalExit(last.payload) : null;
};

describe("remote terminal host", () => {
  test("attaches the agent's session at the client's size, relays both ways, and ends with the exit code", async () => {
    const h = host();
    const stream = await h.a.openBi();
    await stream.writeAll(encodeTerminalOpen({ agent: "worker", repo: "app", cols: 120, rows: 40 }));
    await waitFor(() => h.spawns.length === 1, { message: "attach spawned" });
    const { session, size, proc } = h.spawns[0]!;
    expect(session).toBe("itsybitsy-app-worker");
    expect(size).toMatchObject({ cols: 120, rows: 40 });

    const frames = readAll(stream);
    for (const frame of encodeTerminalData(new TextEncoder().encode("ls\r"))) await stream.writeAll(frame);
    await stream.writeAll(encodeTerminalResize({ cols: 100, rows: 30 }));
    await waitFor(() => proc.sizes.length === 1, { message: "resize applied" });
    expect(proc.input).toEqual(["ls\r"]);
    expect(proc.sizes).toEqual([{ cols: 100, rows: 30 }]);

    proc.output("hello ");
    proc.output("world");
    proc.exit(0);
    const received = await frames;
    expect(outputOf(received)).toBe("hello world");
    expect(exitOf(received)).toEqual({ code: 0, reason: "exited" });
    expect(h.logs).toContain(`peer link: Alice (${CLIENT.slice(0, 10)}) attached a terminal to worker`);
    await waitFor(() => h.logs.some(l => l.includes("ended: exited")), { message: "end logged" });
    expect(h.a.closeInfo()).toBeNull();
  });

  test("input sent in the same chunk as the open frame is applied once attached", async () => {
    const h = host();
    const stream = await h.a.openBi();
    await stream.writeAll(Buffer.concat([
      encodeTerminalOpen({ agent: "worker", cols: 80, rows: 24 }),
      ...encodeTerminalData(new TextEncoder().encode("early")),
    ]));
    await waitFor(() => h.spawns[0]?.proc.input.length === 1, { message: "early input applied" });
    expect(h.spawns[0]!.proc.input).toEqual(["early"]);
    h.spawns[0]!.proc.exit(0);
    await readAll(stream);
  });

  test("the client finishing its side detaches the attach client", async () => {
    const h = host();
    const stream = await h.a.openBi();
    await stream.writeAll(encodeTerminalOpen({ agent: "worker", cols: 80, rows: 24 }));
    await waitFor(() => h.spawns.length === 1, { message: "attach spawned" });
    await stream.finish();
    const frames = await readAll(stream);
    expect(h.spawns[0]!.proc.kills).toBe(1);
    expect(exitOf(frames)).toEqual({ code: 129, reason: "the client detached" });
  });

  test("an agent the host does not have is refused with an exit frame, and nothing is spawned", async () => {
    const h = host();
    const stream = await h.a.openBi();
    await stream.writeAll(encodeTerminalOpen({ agent: "ghost", cols: 80, rows: 24 }));
    const frames = await readAll(stream);
    expect(frames.length).toBe(1);
    expect(exitOf(frames)).toEqual({ code: null, reason: "no agent ghost on this machine" });
    expect(h.spawns.length).toBe(0);
    expect(h.a.closeInfo()).toBeNull();
  });

  test("a responder without terminal support refuses every open", async () => {
    const h = host({ terminal: null });
    const stream = await h.a.openBi();
    await stream.writeAll(encodeTerminalOpen({ agent: "worker", cols: 80, rows: 24 }));
    expect(exitOf(await readAll(stream))).toEqual({ code: null, reason: "Remote terminals are unavailable" });
  });

  test("removing the peer ends a live session and closes the connection as not a peer", async () => {
    const h = host();
    const stream = await h.a.openBi();
    await stream.writeAll(encodeTerminalOpen({ agent: "worker", cols: 80, rows: 24 }));
    await waitFor(() => h.spawns.length === 1, { message: "attach spawned" });
    h.clock.advance(TERMINAL_PAIRING_CHECK_MS);
    await Bun.sleep(5);
    expect(h.spawns[0]!.proc.kills).toBe(0); // still paired: the check re-arms

    h.peers.clear();
    h.clock.advance(TERMINAL_PAIRING_CHECK_MS);
    await waitFor(() => h.a.closeInfo() !== null, { message: "connection closed" });
    expect(h.a.closeInfo()).toMatchObject({ byPeer: true, code: PEER_CLOSE.notPeer });
    expect(h.spawns[0]!.proc.kills).toBe(1);
  });

  test("an open that names a peer is a protocol error that closes the connection", async () => {
    const h = host();
    const stream = await h.a.openBi();
    await stream.writeAll(encodeTerminalOpen({ agent: "worker", cols: 80, rows: 24, peer: "laptop" }));
    await waitFor(() => h.a.closeInfo() !== null, { message: "connection closed" });
    expect(h.a.closeInfo()).toMatchObject({ byPeer: true, code: PEER_CLOSE.error, reason: "terminal open has unknown fields" });
    expect(h.spawns.length).toBe(0);
  });

  test("a frame other than data or resize after the open closes the connection", async () => {
    const h = host();
    const stream = await h.a.openBi();
    await stream.writeAll(encodeTerminalOpen({ agent: "worker", cols: 80, rows: 24 }));
    await waitFor(() => h.spawns.length === 1, { message: "attach spawned" });
    await stream.writeAll(encodeTerminalFrame(TERMINAL_FRAME.exit, new TextEncoder().encode("{}")));
    await waitFor(() => h.a.closeInfo() !== null, { message: "connection closed" });
    expect(h.a.closeInfo()).toMatchObject({ code: PEER_CLOSE.error, reason: "unexpected terminal frame type 4" });
    expect(h.spawns[0]!.proc.kills).toBe(1);
  });

  test(`at most ${MAX_TERMINAL_SESSIONS} sessions run at once`, async () => {
    const sessions = new Set<object>(Array.from({ length: MAX_TERMINAL_SESSIONS }, () => ({})));
    const h = host({ sessions });
    const stream = await h.a.openBi();
    await stream.writeAll(encodeTerminalOpen({ agent: "worker", cols: 80, rows: 24 }));
    expect(exitOf(await readAll(stream))?.reason).toContain("too many remote terminals");
    expect(h.spawns.length).toBe(0);
  });
});

describe("remote terminal flow control", () => {
  /** A stream whose writes wait until the test releases them: a link slower than the PTY. */
  function slowStream() {
    const gates: Array<() => void> = [];
    const written: Uint8Array[] = [];
    const stopped = Promise.withResolvers<never>();
    stopped.promise.catch(() => {});
    const stream: PairStream = {
      read: () => stopped.promise,
      write: async (bytes) => bytes.length,
      writeAll: (bytes) => { written.push(bytes); return new Promise<void>(resolve => gates.push(resolve)); },
      finish: async () => {},
      resetSending: async () => {},
      stopReceiving: async () => { stopped.reject(new Error("stream stopped")); },
      cancel: async () => { stopped.reject(new Error("stream cancelled")); },
      readToEnd: () => stopped.promise,
    };
    /** Let every queued write through, including the ones each release starts (a write starts a turn later). */
    const drain = async () => {
      for (let idle = 0; idle < 5;) {
        await Bun.sleep(0);
        const release = gates.shift();
        if (release) { idle = 0; release(); } else idle++;
      }
    };
    return { stream, written, gates, drain };
  }

  async function serveSlow() {
    const link = slowStream();
    const logs: string[] = [];
    let proc: ReturnType<typeof fakeProcess> | undefined;
    const done = serveTerminal(CLIENT, link.stream, encodeTerminalOpen({ agent: "worker", cols: 80, rows: 24 }), "a1a1a1a1a1", {
      findSession: () => "itsybitsy-0000abcd-worker",
      spawn: async (_session, _size, onData) => (proc = fakeProcess(onData)),
      sessions: new Set(),
      peerName: async () => "Alice",
      setTimer: createFakeClock().setTimer,
      log: (line) => logs.push(line),
      closeNotPeer: () => {},
      closeError: () => {},
    });
    await waitFor(() => proc !== undefined, { message: "attach spawned" });
    const chunk = "x".repeat(64 * 1024);
    /** Output `bytes` (rounded up to 64 KiB chunks) from the PTY at once. */
    const burst = (bytes: number) => { for (let n = 0; n < bytes; n += chunk.length) proc!.output(chunk); };
    return { ...link, logs, done, proc: () => proc!, burst };
  }

  test(`output queued past ${TERMINAL_PAUSE_BYTES} bytes pauses the tmux client until it drains`, async () => {
    const s = await serveSlow();
    s.burst(TERMINAL_PAUSE_BYTES - 64 * 1024);
    expect(s.proc().pauses).toBe(0);
    s.burst(2 * 64 * 1024);
    expect(s.proc().pauses).toBe(1);
    s.burst(4 * 64 * 1024); // still paused: no second pause
    expect(s.proc().pauses).toBe(1);

    await s.drain();
    expect(s.proc().resumes).toBe(1);
    expect(s.proc().kills).toBe(0);
    s.proc().exit(0);
    await s.drain();
    await s.done;
    const frames = new TerminalFrameReader().push(Buffer.concat(s.written));
    expect(exitOf(frames)).toEqual({ code: 0, reason: "exited" });
  });

  test(`output still queued past ${MAX_TERMINAL_BACKLOG} bytes ends the session as outrunning the link`, async () => {
    const s = await serveSlow();
    s.burst(MAX_TERMINAL_BACKLOG + 64 * 1024);
    expect(s.proc().kills).toBe(1);
    await s.drain();
    await s.done;
    const frames = new TerminalFrameReader().push(Buffer.concat(s.written));
    expect(exitOf(frames)).toEqual({ code: 129, reason: "terminal output outran the link" });
  });
});

describe("findAgentSession", () => {
  const agent = (id: string, repo: string, extra: Record<string, unknown> = {}) => {
    const a = makeAgent({ id, repoName: repo, repoRegistryName: repo, repoPath: `/repos/${repo}`, state: "running" });
    Object.assign(a.meta, { tmux_session: `itsybitsy-${repo}-${id}`, ...extra });
    return a;
  };

  test("finds the agent by id, and by repo ignoring case when one is named", () => {
    const agents = [agent("w1", "app"), agent("w1", "web"), agent("w2", "app")];
    expect(findAgentSession(agents, "w2", undefined)).toBe("itsybitsy-app-w2");
    expect(findAgentSession(agents, "w1", "WEB")).toBe("itsybitsy-web-w1");
    expect(() => findAgentSession(agents, "w1", undefined)).toThrow("more than one agent is named w1");
    expect(() => findAgentSession(agents, "w3", "app")).toThrow("no agent w3 in app on this machine");
  });

  test("never the system coordinator, and never a session name tmux could misread", () => {
    expect(() => findAgentSession([agent("sys", "home", { agentType: SYSTEM_COORDINATOR_TYPE })], "sys", undefined)).toThrow("no agent sys");
    expect(() => findAgentSession([agent("w1", "app", { tmux_session: "bad:name" })], "w1", undefined)).toThrow("has no tmux session");
    expect(() => findAgentSession([agent("w1", "app", { tmux_session: undefined })], "w1", undefined)).toThrow("has no tmux session");
  });
});

describe("spawnPtyProcess", () => {
  test("runs the command on a PTY of the given size, without TMUX in its environment", async () => {
    const chunks: string[] = [];
    const previous = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-test,1,0";
    let proc: TerminalProcess;
    try {
      proc = spawnPtyProcess(["sh", "-c", 'stty size; echo "tmux=${TMUX:-unset} term=$TERM"; read line; echo "got:$line"'],
        { cols: 101, rows: 31 }, bytes => chunks.push(text(bytes)));
    } finally {
      if (previous === undefined) delete process.env.TMUX;
      else process.env.TMUX = previous;
    }
    await waitFor(() => chunks.join("").includes("term="), { message: "first output" });
    proc.write(new TextEncoder().encode("hi\r"));
    expect(await proc.exited).toBe(0);
    const output = chunks.join("");
    expect(output).toContain("31 101");
    expect(output).toContain("tmux=unset term=xterm-256color");
    expect(output).toContain("got:hi");
  });

  test("pause stops its output, resume continues it, and kill ends it while paused", async () => {
    let ticks = 0;
    const proc = spawnPtyProcess(["sh", "-c", "while :; do echo tick; sleep 0.02; done"], { cols: 80, rows: 24 },
      bytes => { ticks += text(bytes).split("tick").length - 1; });
    await waitFor(() => ticks >= 2, { message: "first ticks" });
    proc.pause();
    await Bun.sleep(60); // let a tick already in flight arrive
    const pausedAt = ticks;
    await Bun.sleep(150);
    expect(ticks).toBe(pausedAt);
    proc.resume();
    await waitFor(() => ticks > pausedAt, { message: "ticks after resume" });
    proc.pause();
    proc.kill();
    expect(await proc.exited).not.toBe(0);
  });

  test("kill ends the process", async () => {
    const proc = spawnPtyProcess(["sh", "-c", "sleep 30"], { cols: 80, rows: 24 }, () => {});
    proc.kill();
    expect(await proc.exited).not.toBe(0);
  });
});

describe("spawnTmuxAttach", () => {
  async function attach(otherClients: boolean) {
    const calls: string[][] = [];
    const exited = Promise.withResolvers<number | null>();
    const proc = await spawnTmuxAttach("itsybitsy-app-w1", { cols: 90, rows: 20 }, () => {}, {
      runTmux: async (args) => { calls.push(["tmux", ...args]); },
      hasClients: async (session) => { calls.push(["has-clients", session]); return otherClients; },
      spawnPty: (argv, size) => {
        calls.push([...argv, `${size.cols}x${size.rows}`]);
        return { write: () => {}, resize: () => {}, pause: () => {}, resume: () => {}, kill: () => {}, exited: exited.promise };
      },
    });
    return { calls, proc, exited };
  }

  test("sizes the window to the client, attaches, and re-pins the window once the last client exits", async () => {
    const { calls, proc, exited } = await attach(false);
    expect(calls).toEqual([
      ["tmux", "set-option", "-t", "=itsybitsy-app-w1:", "window-size", "latest"],
      ["tmux", "attach-session", "-t", "=itsybitsy-app-w1:", "90x20"],
    ]);
    exited.resolve(0);
    expect(await proc.exited).toBe(0);
    expect(calls.slice(2)).toEqual([
      ["has-clients", "itsybitsy-app-w1"],
      ["tmux", "resize-window", "-t", "=itsybitsy-app-w1:", "-x", String(PINNED_TMUX_WIDTH)],
    ]);
  });

  test("leaves the window sized while another client is still attached", async () => {
    const { calls, proc, exited } = await attach(true);
    exited.resolve(0);
    expect(await proc.exited).toBe(0);
    expect(calls.slice(2)).toEqual([["has-clients", "itsybitsy-app-w1"]]);
  });
});

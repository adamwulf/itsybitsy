import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../test-utils";
import { runAttach, parseAttachTarget, type AttachIO } from "./attach-command";
import { irohAddonLoaderCtx } from "./iroh";
import { serveTrustedConnection } from "./peer-link";
import { encodeTerminalOpen } from "./terminal-frame";
import type { TerminalHostDeps, TerminalProcess } from "./terminal-host";
import { startTerminalRelay, type TerminalRelay } from "./terminal-relay";
import { createFakeClock, createMemoryLink, type MemoryConnection } from "./test-pair-transport";

const LOCAL = "a1".repeat(32);
const REMOTE = "b2".repeat(32);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A terminal the test types into and reads from. */
function fakeTerminal() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true as const,
    modes: [] as boolean[],
    setRawMode(mode: boolean) { stdin.modes.push(mode); return stdin; },
    resume() { return stdin; },
    pause() { return stdin; },
  });
  const written: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true as const,
    columns: 100,
    rows: 30,
    write(chunk: Uint8Array | string) { written.push(typeof chunk === "string" ? chunk : text(chunk)); return true; },
  });
  const errors: string[] = [];
  return {
    stdin, stdout, written, errors,
    output: () => written.join(""),
    io: (socketPath: string): AttachIO => ({
      stdin: stdin as unknown as AttachIO["stdin"],
      stdout: stdout as unknown as AttachIO["stdout"],
      stderr: (line) => { errors.push(line); },
      socketPath,
    }),
  };
}

interface Spawned {
  session: string;
  cols: number;
  rows: number;
  input: string[];
  sizes: string[];
  kills: number;
  output(value: string): void;
  exit(code: number): void;
}

describe("ib peer attach through the ib watch relay", () => {
  let dir: string;
  let socketPath: string;
  let relay: TerminalRelay | null;
  let link: { a: MemoryConnection; b: MemoryConnection };
  let spawns: Spawned[];
  let connected: boolean;
  let logs: string[];

  beforeEach(async () => {
    irohAddonLoaderCtx.set(async () => { throw new Error("a relay test loaded the iroh addon"); });
    dir = await mkdtemp(join(tmpdir(), "ibt-"));
    socketPath = join(dir, "t.sock");
    link = createMemoryLink(LOCAL, REMOTE);
    spawns = [];
    connected = true;
    logs = [];
    const terminal: TerminalHostDeps = {
      findSession: (agent) => {
        if (agent !== "worker") throw new Error(`no agent ${agent} on this machine`);
        return "itsybitsy-0000abcd-worker";
      },
      spawn: async (session, size, onData): Promise<TerminalProcess> => {
        const done = Promise.withResolvers<number | null>();
        const spawned: Spawned = {
          session, ...size, input: [], sizes: [], kills: 0,
          output: (value) => onData(new TextEncoder().encode(value)),
          exit: (code) => done.resolve(code),
        };
        spawns.push(spawned);
        return {
          write: (bytes) => { spawned.input.push(text(bytes)); },
          resize: ({ cols, rows }) => { spawned.sizes.push(`${cols}x${rows}`); },
          pause: () => {},
          resume: () => {},
          kill: () => { spawned.kills++; done.resolve(129); },
          exited: done.promise,
        };
      },
      sessions: new Set(),
    };
    void serveTrustedConnection(link.b, {
      setTimer: createFakeClock().setTimer,
      peerName: async (id) => id === LOCAL ? "local" : null,
      snapshot: () => ({ coordinator: null, repos: [], agents: [] }),
      terminal,
      log: () => {},
    });
    relay = await startTerminalRelay(socketPath, {
      resolvePeer: async (target) => {
        if (target !== "laptop" && target !== REMOTE) throw new Error(`no paired peer has the name or id "${target}"`);
        return { id: REMOTE, name: "laptop" };
      },
      connection: (id) => connected && id === REMOTE ? link.a : null,
      log: (line) => logs.push(line),
    });
  });

  afterEach(async () => {
    irohAddonLoaderCtx.reset();
    await relay?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the socket is private to this user", async () => {
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  test("types into the remote agent's session, follows resizes, shows its output, and exits 0 when it detaches", async () => {
    const term = fakeTerminal();
    const done = runAttach(["laptop/worker"], term.io(socketPath));
    await waitFor(() => spawns.length === 1, { message: "remote attach" });
    expect(spawns[0]).toMatchObject({ session: "itsybitsy-0000abcd-worker", cols: 100, rows: 30 });
    expect(term.stdin.modes).toEqual([true]);

    term.stdin.emit("data", Buffer.from("ls\r"));
    await waitFor(() => spawns[0]!.input.join("") === "ls\r", { message: "input relayed" });
    term.stdout.columns = 120;
    term.stdout.emit("resize");
    await waitFor(() => spawns[0]!.sizes.length === 1, { message: "resize relayed" });
    expect(spawns[0]!.sizes).toEqual(["120x30"]);

    spawns[0]!.output("\x1b[1mhello\x1b[0m");
    await waitFor(() => term.output().includes("hello"), { message: "output shown" });
    expect(term.output()).toBe("\x1b[1mhello\x1b[0m");

    spawns[0]!.exit(0);
    expect(await done).toBe(0);
    expect(term.stdin.modes).toEqual([true, false]);
    expect(term.errors).toEqual([]);
    expect(logs).toContain("peer link: relaying a local terminal to laptop/worker");
  });

  test("a refusal from the remote host is shown, and the window waits for Enter", async () => {
    const term = fakeTerminal();
    const done = runAttach(["laptop/ghost"], term.io(socketPath));
    await waitFor(() => term.errors.join("").includes("Press Enter"), { message: "refusal shown" });
    expect(term.errors.join("")).toContain("[remote terminal ended: no agent ghost on this machine]");
    term.stdin.emit("data", Buffer.from("\n"));
    expect(await done).toBe(1);
  });

  test("an unknown peer and a disconnected peer are refused by the relay", async () => {
    const unknown = fakeTerminal();
    const first = runAttach(["nobody/worker"], unknown.io(socketPath));
    await waitFor(() => unknown.errors.join("").includes("Press Enter"), { message: "unknown peer shown" });
    expect(unknown.errors.join("")).toContain('no paired peer has the name or id "nobody"');
    unknown.stdin.emit("data", Buffer.from("\n"));
    expect(await first).toBe(1);

    connected = false;
    const offline = fakeTerminal();
    const second = runAttach([`${REMOTE}/worker`], offline.io(socketPath));
    await waitFor(() => offline.errors.join("").includes("Press Enter"), { message: "disconnected shown" });
    expect(offline.errors.join("")).toContain("laptop is disconnected");
    offline.stdin.emit("data", Buffer.from("\n"));
    expect(await second).toBe(1);
    expect(spawns.length).toBe(0);
  });

  test("a dropped link ends the session with the reason", async () => {
    const term = fakeTerminal();
    const done = runAttach(["laptop/worker"], term.io(socketPath));
    await waitFor(() => spawns.length === 1, { message: "remote attach" });
    link.a.close(0, "done");
    await waitFor(() => term.errors.join("").includes("Press Enter"), { message: "loss shown" });
    expect(term.errors.join("")).toContain("[remote terminal ended: connection lost");
    term.stdin.emit("data", Buffer.from("\n"));
    expect(await done).toBe(1);
    await waitFor(() => spawns[0]!.kills === 1, { message: "remote client killed" });
  });

  test("a client that goes away detaches the remote tmux client", async () => {
    const socket = connect(socketPath);
    await new Promise(resolve => socket.once("connect", resolve));
    socket.write(encodeTerminalOpen({ peer: "laptop", agent: "worker", cols: 80, rows: 24 }));
    await waitFor(() => spawns.length === 1, { message: "remote attach" });
    socket.destroy();
    await waitFor(() => spawns[0]!.kills === 1, { message: "remote client killed" });
  });

  test("closing the relay ends its sessions and removes the socket", async () => {
    const term = fakeTerminal();
    const done = runAttach(["laptop/worker"], term.io(socketPath));
    await waitFor(() => spawns.length === 1, { message: "remote attach" });
    await relay!.close();
    relay = null;
    await waitFor(() => term.errors.join("").includes("Press Enter"), { message: "end shown" });
    term.stdin.emit("data", Buffer.from("\n"));
    expect(await done).toBe(1);
    await waitFor(() => spawns[0]!.kills === 1, { message: "remote client killed" });
    await expect(stat(socketPath)).rejects.toThrow();
  });
});

describe("ib peer attach without a relay", () => {
  test("says ib watch is unreachable", async () => {
    const term = fakeTerminal();
    expect(await runAttach(["laptop/worker"], term.io(join(tmpdir(), `ibt-missing-${process.pid}.sock`)))).toBe(1);
    expect(term.errors.join("")).toContain("cannot reach the ib watch that owns the peer endpoint");
    expect(term.stdin.modes).toEqual([]);
  });

  test("needs an interactive terminal and a well-formed target", async () => {
    const term = fakeTerminal();
    term.stdin.isTTY = false as true;
    expect(await runAttach(["laptop/worker"], term.io("/nonexistent"))).toBe(1);
    expect(term.errors.join("")).toContain("needs an interactive terminal");

    const usage = fakeTerminal();
    expect(await runAttach(["laptop"], usage.io("/nonexistent"))).toBe(1);
    expect(usage.errors.join("")).toContain("Usage: ib peer attach <peer>/[<repo>/]<agent>");
  });

  test("parses <peer>/<agent> and <peer>/<repo>/<agent>", () => {
    expect(parseAttachTarget("laptop/worker")).toEqual({ peer: "laptop", agent: "worker" });
    expect(parseAttachTarget("my laptop/app/worker")).toEqual({ peer: "my laptop", repo: "app", agent: "worker" });
    expect(parseAttachTarget("laptop/a/b/c")).toBeNull();
    expect(parseAttachTarget("laptop/")).toBeNull();
    expect(parseAttachTarget("laptop/bad;id")).toBeNull();
  });
});

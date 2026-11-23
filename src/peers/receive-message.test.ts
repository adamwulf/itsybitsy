import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createCliFixture, type CliFixture } from "../test-cli-runner";
import { setUserHome, resetUserHome } from "../home";
import { drainOutbox, resetSendSpawnRunner, setSendSpawnRunner } from "../ib-commands";
import { makeAgent, makeSpawnResult, waitFor } from "../test-utils";
import { spawnCtx as paneProbe } from "../tmux-poller";
import { readOutbox } from "../outbox";
import { createMessageReceiver } from "./receive-message";
import { createFakeClock, createMemoryLink } from "./test-pair-transport";
import { serveTrustedConnection } from "./peer-link";
import { encodeSendHeader, type SendHeader } from "./send-frame";

let cli: CliFixture;
let repo: string;
let receiver: ReturnType<typeof createMessageReceiver>;
let lines: string[];
const paired = async () => "desk";
const header = (fields: Partial<SendHeader> = {}): SendHeader => ({
  op: "send", id: crypto.randomUUID(), files: [], message: "/compact",
  from: { kind: "user" }, target: { kind: "agent", agent: "worker" }, ...fields,
});

beforeEach(async () => {
  cli = await createCliFixture();
  setUserHome(cli.home);
  repo = await cli.addRepo("photos");
  for (const id of ["worker", "photos"]) {
    const { agentDir } = await cli.addAgent(repo, id, {
      tmux_session: "ib-" + id, ...(id === "photos" && { agentType: "repo-coordinator" }),
    });
    await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
  }
  lines = [];
  receiver = createMessageReceiver(() => {}, line => lines.push(line));
  setSendSpawnRunner(() => makeSpawnResult());
  paneProbe.set(() => makeSpawnResult(0, "0"));
});
afterEach(async () => {
  resetSendSpawnRunner();
  paneProbe.reset();
  resetUserHome();
  await cli.cleanup();
});

async function exchange(request: SendHeader, name: () => Promise<string | null> = paired, revoked = false) {
  const { a, b } = createMemoryLink("authenticated", "destination");
  const serving = serveTrustedConnection(b, {
    peerName: name, receiveMessage: receiver, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
    log() {}, setTimer(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
  });
  try {
    const stream = await a.openBi();
    await stream.writeAll(encodeSendHeader(request));
    await stream.finish();
    return JSON.parse(new TextDecoder().decode(await stream.readToEnd(4096)));
  } finally { if (revoked) expect(a.closeInfo()).toMatchObject({ code: 1 }); a.close(0, "done"); await serving; }
}

test("concurrent and subsequent repeats acknowledge once, with sender attribution in the real queue", async () => {
  for (const from of [{ kind: "user" }, { kind: "agent", id: "desk/tools/alice" }, { kind: "system" }] as const) {
    const request = header({ from, message: from.kind + " hello" });
    const replies = await Promise.all([exchange(request), exchange(request)]);
    for (const reply of [...replies, await exchange(request)]) expect(reply).toEqual({ ok: true, id: request.id });
  }
  const queued = await readOutbox(join(cli.home, ".itsybitsy", "agents", "worker"));
  expect(queued.map(item => item.fromAgent)).toEqual(["", "desk/tools/alice", "desk/@system"]);
  expect(lines).toEqual(Array(3).fill("desk sent a message to worker"));
});

test("the ordinary drainer applies passthrough and peer labels to the queued text", async () => {
  const calls: string[][] = [];
  setSendSpawnRunner(cmd => { calls.push(cmd); return makeSpawnResult(); });
  for (const [from, message] of [
    [{ kind: "user" }, "/compact"], [{ kind: "user" }, "!pwd"],
    [{ kind: "agent", id: "desk/tools/alice" }, "/compact"], [{ kind: "system" }, "!pwd"],
  ] as const) {
    expect(await exchange(header({ from, message }))).toMatchObject({ ok: true });
  }
  const agent = makeAgent({ id: "worker", repoPath: repo });
  const result = await drainOutbox(agent, join(cli.home, ".itsybitsy", "agents", agent.id));
  expect(result.ok).toBe(true);
  expect(calls.filter(cmd => cmd.includes("-l")).map(cmd => cmd.at(-1))).toEqual([
    "/compact", "!pwd", "[sent by agent desk/tools/alice]: /compact", "[sent by desk/@system]: !pwd",
  ]);
});

test("wire ids ignore recycled nicknames and select the keyed queue of the named repo", async () => {
  await cli.addAgent(repo, "replacement", { nickname: "old-id" });
  expect(await exchange(header({ target: { kind: "agent", repo: "photos", agent: "old-id" } }))).toMatchObject({ ok: false });
  const other = await cli.addRepo("other");
  for (const [path, name] of [[repo, "photos"], [other, "other"]] as const) {
    const key = "home/" + name + "/same";
    const { agentDir } = await cli.addAgent(path, "same", { queue_key: key });
    await mkdir(join(cli.home, ".itsybitsy", "agents", key), { recursive: true });
    await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
  }
  expect(await exchange(header({ target: { kind: "agent", repo: "other", agent: "same" } }))).toMatchObject({ ok: true });
  const base = join(cli.home, ".itsybitsy", "agents", "home");
  expect(await readOutbox(join(base, "photos", "same"))).toHaveLength(0);
  expect(await readOutbox(join(base, "other", "same"))).toHaveLength(1);
});

test("a differently cased UUID is still a replay after the recipient drained", async () => {
  const original = header({ id: "aaaaaaaa-1234-1234-1234-123456789abc" });
  expect(await exchange(original)).toMatchObject({ ok: true });
  const dir = join(cli.home, ".itsybitsy", "agents", "worker");
  await drainOutbox(makeAgent({ id: "worker", repoPath: repo }), dir);
  expect(await exchange({ ...original, id: original.id.toUpperCase() })).toMatchObject({ ok: true });
  expect(await readOutbox(dir)).toEqual([]);
});

test("cache capacity retains accepted ids for ten minutes, independently per peer", async () => {
  let now = 0;
  const receive = createMessageReceiver(() => {}, line => lines.push(line), () => now, 2);
  const request = header();
  await receive(request, "peer-a", paired);
  now++;
  await receive(request, "peer-b", paired);
  now = 599_999;
  await expect(receive(header(), "peer-a", paired)).rejects.toThrow("busy, try again");
  await receive(request, "peer-a", paired);
  expect(lines).toHaveLength(2);
  now++;
  await receive(request, "peer-a", paired);
  await receive(request, "peer-b", paired);
  expect(lines).toHaveLength(3);
});

// The sandbox cannot bind native iroh endpoints. The fake clock drives the
// full idle window and the transport records the QUIC close following FIN.
test.each(["header", "FIN"])("stalled %s stops the receive half and returns the idle error", async stage => {
  const { a, b } = createMemoryLink("sender", "receiver");
  const clock = createFakeClock();
  const serving = serveTrustedConnection(b, { peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
    log() {}, receiveMessage: receiver, setTimer: clock.setTimer });
  const stream = await a.openBi();
  try {
    await stream.writeAll(stage === "header" ? Uint8Array.of(0) : encodeSendHeader(header()));
    await Bun.sleep(0);
    clock.advance(60_000);
    const reply = JSON.parse(new TextDecoder().decode(await stream.readToEnd(4096)));
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining("No progress") });
    await serving;
    expect(a.closeInfo()).toMatchObject({ byPeer: true, reason: "send read stalled" });
    await expect(stream.writeAll(Uint8Array.of(1))).rejects.toThrow();
  } finally { a.close(0, "done"); await serving; }
});

test("unknown, stopped, unpaired and attachment sends are refused before queueing", async () => {
  expect(await exchange(header({ target: { kind: "agent", agent: "missing" } }))).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
  const files = [{ name: "a", size: 0, sha256: "0".repeat(64), spellings: ["a"] }];
  expect(await exchange(header({ files }))).toEqual({ ok: false, error: "attachments are not supported yet" });
  let checks = 0;
  await expect(exchange(header(), async () => ++checks < 4 ? "desk" : null, true)).rejects.toThrow();
  paneProbe.set(cmd => {
    if (cmd[1] === "list-panes") return makeSpawnResult(0, "1\n0"); // live auxiliary window
    expect(cmd).toEqual(["tmux", "display-message", "-p", "-t", "=ib-worker:", "#{pane_dead}"]);
    return makeSpawnResult(0, "1"); // dead delivery pane
  });
  expect(await exchange(header())).toMatchObject({ ok: false, error: expect.stringContaining("not running") });
  paneProbe.set(() => makeSpawnResult(1, "", "no such session"));
  expect(await exchange(header())).toMatchObject({ ok: false, error: expect.stringContaining("not running") });
  expect(lines).toEqual([]);
  expect(await readOutbox(join(cli.home, ".itsybitsy", "agents", "worker"))).toEqual([]);
});

test("repo and system coordinators use their own queues", async () => {
  const request = header({ target: { kind: "repo-coordinator", repo: "PHOTOS" } });
  expect(await exchange(request)).toEqual({ ok: true, id: request.id });
  expect(await readOutbox(join(cli.home, ".itsybitsy", "agents", "photos"))).toMatchObject([{ fromAgent: "", raw: false, message: "/compact" }]);
  paneProbe.set(() => makeSpawnResult(0, "1"));
  expect(await exchange(header({ target: { kind: "system" } }))).toMatchObject({ ok: false, error: expect.stringContaining("not running") });
  paneProbe.set(() => makeSpawnResult(0, "0"));
  // Hold the normal coordinator queue lock until after inspecting the acceptance.
  const dir = join(cli.home, ".itsybitsy");
  await Bun.write(join(dir, ".outbox.lock"), String(process.pid));
  expect(await exchange(header({ target: { kind: "system" } }))).toMatchObject({ ok: true });
  expect(await readOutbox(dir)).toMatchObject([{ message: "/compact", raw: false }]);
  await unlink(join(dir, ".outbox.lock"));
  await waitFor(async () => !(await readOutbox(dir)).length);
});

test("remote @system acknowledges enqueue while the local inline drainer is typing", async () => {
  const release = Promise.withResolvers<number>();
  const entered = Promise.withResolvers<string[]>();
  setSendSpawnRunner(cmd => {
    if (cmd.includes("-l")) {
      entered.resolve(cmd);
      return { ...makeSpawnResult(), exited: release.promise };
    }
    return makeSpawnResult();
  });
  try {
    expect(await exchange(header({ target: { kind: "system" } }))).toMatchObject({ ok: true });
    const typed = await entered.promise;
    expect(typed).toContain("=ib-coordinator:");
    expect(typed.at(-1)).toBe("/compact");
  } finally { release.resolve(0); }
  await waitFor(async () => !(await readOutbox(join(cli.home, ".itsybitsy"))).length);
});

test("a stalled delivery probe is killed and reaped", async () => {
  const { isDeliveryPaneLive } = await import("../tmux-poller");
  const exit = Promise.withResolvers<number>();
  let reaped = false;
  paneProbe.set(() => ({
    ...makeSpawnResult(), exited: exit.promise.then(code => { reaped = true; return code; }),
    kill: () => { exit.resolve(1); },
  }));
  await expect(isDeliveryPaneLive("ib-worker", 5)).rejects.toThrow("timed out");
  expect(reaped).toBe(true);
});

test.each(["write", "finish"] as const)("a stalled acknowledgement %s cancels its stream", async op => {
  const { a, b } = createMemoryLink("sender", "receiver");
  const client = await a.openBi();
  const server = await b.acceptBi();
  const entered = Promise.withResolvers<void>();
  server[op] = () => { entered.resolve(); return new Promise<never>(() => {}); };
  const accept = b.acceptBi.bind(b);
  b.acceptBi = async () => { b.acceptBi = accept; return server; };
  const clock = createFakeClock();
  const serving = serveTrustedConnection(b, {
    peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
    log() {}, receiveMessage: receiver, setTimer: clock.setTimer,
  });
  try {
    await client.writeAll(encodeSendHeader(header()));
    await client.finish();
    await entered.promise;
    const ack = client.readToEnd(4096);
    clock.advance(60_000);
    await expect(ack).rejects.toThrow();
    expect(a.closeInfo()).toBeNull();
    expect(lines).toHaveLength(1);
  } finally { a.close(0, "done"); await serving; }
});

/**
 * Tests for the per-team channel + log persistence (SPEC §17.4).
 *
 * Mirrors the outbox/teams test discipline: a fresh tmpdir per test installed as
 * the coordinator home via `setCoordinatorHome`, so `channelPath`/`teamLogPath`
 * resolve under `<tmpdir>/teams/` and never touch the real `~/.itsybitsy/`.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import {
  type ChannelMessage,
  channelPath,
  teamLogPath,
  appendChannelMessage,
  appendChannelSystemMessage,
  readChannel,
  appendTeamLog,
  deleteChannelFiles,
} from "./team-channel";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "team-channel-test-"));
  setCoordinatorHome(home);
});

afterEach(async () => {
  resetCoordinatorHome();
  await rm(home, { recursive: true, force: true });
});

test("appendChannelMessage → readChannel round-trip preserves all fields", async () => {
  const rec: ChannelMessage = { ts: 1780166606, fromAgent: "agent-a1b2c3d4", message: "ship it" };
  await appendChannelMessage("backend", rec);
  const got = await readChannel("backend");
  expect(got).toEqual([rec]);
});

test("readChannel on a missing file returns []", async () => {
  const got = await readChannel("never-created");
  expect(got).toEqual([]);
});

test("readChannel skips blank and malformed lines, keeps the good one", async () => {
  // Hand-write a channel file mixing junk with one valid record.
  await mkdir(join(home, "teams"), { recursive: true });
  const good = { ts: 100, fromAgent: "agent-x", message: "hello" };
  const content =
    "\n" + // blank line
    "this is not json\n" + // malformed
    JSON.stringify(good) + "\n" +
    "{ broken json\n" + // malformed
    "   \n"; // whitespace-only
  await writeFile(channelPath("mix"), content);
  const got = await readChannel("mix");
  expect(got).toEqual([good]);
});

test("readChannel field-by-field guard: line missing `message` is skipped", async () => {
  await mkdir(join(home, "teams"), { recursive: true });
  const missingMessage = JSON.stringify({ ts: 1, fromAgent: "agent-y" });
  const good = { ts: 2, fromAgent: "agent-z", message: "ok" };
  await writeFile(channelPath("guard"), missingMessage + "\n" + JSON.stringify(good) + "\n");
  const got = await readChannel("guard");
  expect(got).toEqual([good]);
});

test("readChannel field-by-field guard: wrong-typed `ts` is skipped", async () => {
  await mkdir(join(home, "teams"), { recursive: true });
  const badTs = JSON.stringify({ ts: "not-a-number", fromAgent: "agent-y", message: "x" });
  const good = { ts: 5, fromAgent: "agent-z", message: "ok" };
  await writeFile(channelPath("guard2"), badTs + "\n" + JSON.stringify(good) + "\n");
  const got = await readChannel("guard2");
  expect(got).toEqual([good]);
});

test("appendChannelMessage appends — two appends read back in order", async () => {
  const a: ChannelMessage = { ts: 1, fromAgent: "agent-a", message: "first" };
  const b: ChannelMessage = { ts: 2, fromAgent: "", message: "second" }; // "" = human sender
  await appendChannelMessage("ordered", a);
  await appendChannelMessage("ordered", b);
  const got = await readChannel("ordered");
  expect(got).toEqual([a, b]);
});

test("appendTeamLog writes a timestamped line containing the text", async () => {
  await appendTeamLog("logteam", "agent foo joined");
  const raw = await readFile(teamLogPath("logteam"), "utf-8");
  expect(raw).toContain("agent foo joined");
  // Timestamp prefix shape: [YYYY-MM-DD HH:MM:SS] ...
  expect(raw).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] agent foo joined\n$/);
});

test("appendTeamLog appends multiple lines", async () => {
  await appendTeamLog("logteam2", "first event");
  await appendTeamLog("logteam2", "second event");
  const raw = await readFile(teamLogPath("logteam2"), "utf-8");
  const lines = raw.trim().split("\n");
  expect(lines.length).toBe(2);
  expect(lines[0]).toContain("first event");
  expect(lines[1]).toContain("second event");
});

test("deleteChannelFiles removes BOTH the channel and the log file", async () => {
  await appendChannelMessage("doomed", { ts: 1, fromAgent: "a", message: "m" });
  await appendTeamLog("doomed", "an event");
  // Both exist now.
  expect(await Bun.file(channelPath("doomed")).exists()).toBe(true);
  expect(await Bun.file(teamLogPath("doomed")).exists()).toBe(true);
  await deleteChannelFiles("doomed");
  expect(await Bun.file(channelPath("doomed")).exists()).toBe(false);
  expect(await Bun.file(teamLogPath("doomed")).exists()).toBe(false);
});

test("deleteChannelFiles on missing files does not throw", async () => {
  // Neither file exists — must be a silent best-effort no-op.
  await expect(deleteChannelFiles("ghost")).resolves.toBeUndefined();
});

test("channelPath / teamLogPath honor the coordinator-home override", () => {
  expect(channelPath("alpha")).toBe(join(home, "teams", "alpha.channel.jsonl"));
  expect(teamLogPath("alpha")).toBe(join(home, "teams", "alpha.log"));
});

// ===========================================================================
// kind: "chat" | "system" discriminated record shape (§17.4 design update).
// Lifecycle notices (join/leave/team-create) write `kind: "system"` records to
// the channel.jsonl so the chat box can render them dimmed inline with chat.
// Existing on-disk records have NO `kind` field and must continue to round-trip
// and render as chat — the back-compat contract.
// ===========================================================================

test("kind: 'system' round-trips through append + read", async () => {
  const rec: ChannelMessage = {
    ts: 1780166606,
    fromAgent: "agent-joiner",
    message: "joined the team",
    kind: "system",
  };
  await appendChannelMessage("lifecycle", rec);
  const got = await readChannel("lifecycle");
  expect(got).toEqual([rec]);
});

test("kind: 'chat' (explicit) round-trips through append + read", async () => {
  const rec: ChannelMessage = {
    ts: 1780166700,
    fromAgent: "agent-talker",
    message: "hi team",
    kind: "chat",
  };
  await appendChannelMessage("explicit", rec);
  const got = await readChannel("explicit");
  expect(got).toEqual([rec]);
});

test("readChannel back-compat: a record with NO kind field reads back with kind undefined", async () => {
  // Hand-write the historical record shape (no `kind`). The reader must accept
  // it and surface kind as undefined — render-time treats undefined as chat.
  await mkdir(join(home, "teams"), { recursive: true });
  const legacy = JSON.stringify({ ts: 42, fromAgent: "agent-old", message: "legacy" });
  await writeFile(channelPath("legacy"), legacy + "\n");
  const got = await readChannel("legacy");
  expect(got).toEqual([{ ts: 42, fromAgent: "agent-old", message: "legacy" }]);
  // The kind property is NOT set on the object (not even as undefined).
  expect(Object.prototype.hasOwnProperty.call(got[0]!, "kind")).toBe(false);
});

test("appendChannelMessage omits `kind` from the on-disk JSON when undefined (no churn for legacy chat records)", async () => {
  // A bare-chat record (no kind) must serialize to the historical 3-field shape
  // so existing channel files don't churn when a new write lands beside them.
  await appendChannelMessage("nochurn", {
    ts: 100,
    fromAgent: "agent-x",
    message: "hello",
  });
  const raw = await readFile(channelPath("nochurn"), "utf-8");
  const obj = JSON.parse(raw.trim());
  expect(obj).toEqual({ ts: 100, fromAgent: "agent-x", message: "hello" });
  expect(Object.prototype.hasOwnProperty.call(obj, "kind")).toBe(false);
});

test("readChannel skips records with a malformed `kind` value (consistent with field-by-field guard)", async () => {
  await mkdir(join(home, "teams"), { recursive: true });
  const badKind = JSON.stringify({ ts: 1, fromAgent: "agent-y", message: "x", kind: "broadcast" });
  const wrongType = JSON.stringify({ ts: 2, fromAgent: "agent-y", message: "x", kind: 42 });
  const good = { ts: 3, fromAgent: "agent-z", message: "ok", kind: "system" as const };
  await writeFile(
    channelPath("kindguard"),
    badKind + "\n" + wrongType + "\n" + JSON.stringify(good) + "\n",
  );
  const got = await readChannel("kindguard");
  expect(got).toEqual([good]);
});

test("appendChannelSystemMessage writes kind: 'system' and a current epoch-seconds ts", async () => {
  const before = Math.floor(Date.now() / 1000);
  await appendChannelSystemMessage("sysmsg", "agent-actor", "joined the team");
  const after = Math.floor(Date.now() / 1000);

  const got = await readChannel("sysmsg");
  expect(got.length).toBe(1);
  expect(got[0]!.fromAgent).toBe("agent-actor");
  expect(got[0]!.message).toBe("joined the team");
  expect(got[0]!.kind).toBe("system");
  // ts is stamped internally; clamp to the wall-clock window the call straddled.
  expect(got[0]!.ts).toBeGreaterThanOrEqual(before);
  expect(got[0]!.ts).toBeLessThanOrEqual(after);
});

test("appendChannelSystemMessage accepts an @-sentinel actor (e.g. @system for team-create)", async () => {
  await appendChannelSystemMessage("sentinel", "@system", "team created");
  const got = await readChannel("sentinel");
  expect(got.length).toBe(1);
  expect(got[0]!.fromAgent).toBe("@system");
  expect(got[0]!.message).toBe("team created");
  expect(got[0]!.kind).toBe("system");
});

test("mixed chat + system records read back in insertion order with kinds preserved", async () => {
  await appendChannelMessage("mixed", { ts: 1, fromAgent: "agent-a", message: "hey" });
  await appendChannelSystemMessage("mixed", "agent-b", "joined the team");
  await appendChannelMessage("mixed", { ts: 3, fromAgent: "agent-a", message: "welcome" });
  const got = await readChannel("mixed");
  expect(got.length).toBe(3);
  expect(got[0]!.kind).toBeUndefined();
  expect(got[1]!.kind).toBe("system");
  expect(got[2]!.kind).toBeUndefined();
  expect(got.map((r) => r.message)).toEqual(["hey", "joined the team", "welcome"]);
});

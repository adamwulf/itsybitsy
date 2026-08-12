/**
 * Tests for the Teams RESOLVER + FAN-OUT + COMMANDS layer (SPEC §16.3/§16.4).
 *
 * Covers:
 *   - deliverMessage team-prefix rendering (agent / sentinel / human senders,
 *     raw bypass)
 *   - sendMessage threading `team` into the enqueued OutboxMessage
 *   - teamSend fan-out: sender exclusion, empty-set no-op, N-member fan-out,
 *     dead-member roster pruning
 *   - teamCreate validation (reserved / invalid / duplicate / success)
 *   - teamAdd / teamRemove not-found + no-op + join/leave notices
 *   - teamList / teamDelete
 *   - roster not-found / listing / dead-member prune
 *   - resolveTarget team branch (known team, unknown @name error, slashed form
 *     still errors)
 *
 * Isolation strategy mirrors the existing send/teams tests: `setCoordinatorHome`
 * redirects teams.json + repos.json; `setUserConfigPath` isolates `user.name`;
 * `setSendSpawnRunner` fakes tmux. A FRESH transient with a live (mocked)
 * watchdog pid makes sendMessage DEFER delivery — the message stays in the
 * outbox so we can assert `queued.team` survives the round-trip.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join, basename } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import type { Agent } from "./agents";
import {
  readAllAgents,
  writeAgentTransient,
  isPidAliveCtx,
  resetReadAgentMetaCache,
} from "./agents";
import { readOutbox } from "./outbox";
import { saveRegistry } from "./registry";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import { setUserConfigPath, resetUserConfigPath } from "./config";
import { makeAgent as _makeAgent, makeSpawnResult } from "./test-utils";
import type { AgentState } from "./parse-state";
import {
  deliverMessage,
  sendMessage,
  teamSend,
  teamCreate,
  teamAdd,
  teamRemove,
  teamList,
  teamDelete,
  roster,
  setSendSpawnRunner,
  resetSendSpawnRunner,
} from "./ib-commands";
import { createTeam, getTeam, addMember } from "./teams";
import { readChannel, channelPath } from "./team-channel";
import { resolveTarget } from "./index";

// A fresh transient that makes sendMessage believe a live watchdog will drain,
// so the message is ENQUEUED but NOT delivered inline. Lets us inspect the
// outbox to assert the `team` field survived.
async function plantLiveWatchdog(agentDir: string): Promise<void> {
  await writeAgentTransient(agentDir, {
    tmux_compacting: false,
    tmux_rate_limited: false,
    tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
    has_background_tasks: false,
    updated_at_ms: Date.now(),
    watchdog_pid: 4242,
  });
}

describe("teams: deliverMessage team-prefix rendering", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  function makeAgent(id: string): Agent {
    return _makeAgent({ id, repoPath: tempDir, repoName: "test-repo", state: "running" as AgentState });
  }

  beforeEach(async () => {
    spawnCalls = [];
    tempDir = await mkdtemp(join(tmpdir(), "team-deliver-"));
    await mkdir(join(tempDir, ".ittybitty", "agents", "agent-abc"), { recursive: true });
    setUserConfigPath(join(tempDir, "config.json"));
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      // Minimal fake: has-session ok, send-keys ok, Enter ok.
      return makeSpawnResult();
    });
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetUserConfigPath();
    await rm(tempDir, { recursive: true, force: true });
  });

  function sentMessage(): string | undefined {
    const call = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--",
    );
    return call?.[6];
  }

  test("agent sender with team → drops 'agent' and adds ' in @<team>'", async () => {
    const agent = makeAgent("agent-abc");
    await deliverMessage(agent, {
      id: "m1",
      message: "hello room",
      fromAgent: "agent-xyz",
      raw: false,
      enqueuedAtMs: 0,
      team: "backend",
    });
    expect(sentMessage()).toBe("[sent by agent-xyz in @backend]: hello room");
  });

  test("agent sender without team → unchanged point-to-point form", async () => {
    const agent = makeAgent("agent-abc");
    await deliverMessage(agent, {
      id: "m1",
      message: "hi",
      fromAgent: "agent-xyz",
      raw: false,
      enqueuedAtMs: 0,
    });
    expect(sentMessage()).toBe("[sent by agent agent-xyz]: hi");
  });

  test("human sender with team → [sent by user in @<team>]", async () => {
    const agent = makeAgent("agent-abc");
    await deliverMessage(agent, {
      id: "m1",
      message: "ping",
      fromAgent: "",
      raw: false,
      enqueuedAtMs: 0,
      team: "backend",
    });
    expect(sentMessage()).toBe("[sent by user in @backend]: ping");
  });

  test("raw mode with team set → still bare, no prefix at all", async () => {
    const agent = makeAgent("agent-abc");
    await deliverMessage(agent, {
      id: "m1",
      message: "verbatim",
      fromAgent: "agent-xyz",
      raw: true,
      enqueuedAtMs: 0,
      team: "backend",
    });
    expect(sentMessage()).toBe("verbatim");
  });

  test("@system sender with team → keeps @ sentinel, adds team clause", async () => {
    const agent = makeAgent("agent-abc");
    await deliverMessage(agent, {
      id: "m1",
      message: "you joined",
      fromAgent: "@system",
      raw: false,
      enqueuedAtMs: 0,
      team: "backend",
    });
    expect(sentMessage()).toBe("[sent by @system in @backend]: you joined");
  });
});

describe("teams: sendMessage threads team into the outbox", () => {
  let tempDir: string;
  // Per-worktree agent dir hosts meta.transient.json (drives the live-watchdog
  // gate) and agent.log. The outbox queue itself now lives under the central
  // coordinator-home root (`queueDir`), so reads target that path.
  let agentDir: string;
  let queueDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "team-send-thread-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    setCoordinatorHome(join(tempDir, "coord-home"));
    const { agentOutboxDir } = await import("./outbox");
    queueDir = agentOutboxDir("agent-abc");
    await mkdir(queueDir, { recursive: true });
    setUserConfigPath(join(tempDir, "config.json"));
    setSendSpawnRunner(() => makeSpawnResult());
    isPidAliveCtx.set(() => true);
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetUserConfigPath();
    resetCoordinatorHome();
    isPidAliveCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("team opt round-trips through enqueue → readOutbox", async () => {
    await plantLiveWatchdog(agentDir); // defer delivery so the message stays queued
    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const res = await sendMessage(agent, "hi room", { fromAgent: "agent-x", team: "backend" });
    expect(res.ok).toBe(true);

    const queued = await readOutbox(queueDir);
    expect(queued.length).toBe(1);
    expect(queued[0]!.team).toBe("backend");
    expect(queued[0]!.fromAgent).toBe("agent-x");
    expect(queued[0]!.message).toBe("hi room");
  });

  test("no team opt → queued message has undefined team", async () => {
    await plantLiveWatchdog(agentDir);
    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    await sendMessage(agent, "hi", { fromAgent: "agent-x" });
    const queued = await readOutbox(queueDir);
    expect(queued[0]!.team).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shared harness for command-level tests: a fake HOME + coordinator home so
// teams.json/repos.json are isolated; agents planted on disk so readAllAgents
// surfaces them; a fake tmux runner; live-watchdog transients so deliveries
// defer into the outbox (lets us assert notice fan-out by inspecting outboxes).
// ---------------------------------------------------------------------------

describe("teams: command layer (create/add/remove/list/delete/roster/send)", () => {
  let baseDir: string;
  let homeDir: string;
  let repoDir: string;
  let originalHome: string | undefined;

  function repos() {
    return [{ path: repoDir, name: basename(repoDir) }];
  }

  // Returns the CENTRAL outbox queue dir for `id` under our test
  // setCoordinatorHome(homeDir). The per-worktree agent dir still hosts
  // meta.json / meta.transient.json / agent.log — only the message queue
  // lives here.
  function queueDirOf(id: string): string {
    return join(homeDir, "agents", id);
  }

  // Plant an agent on disk so readAllAgents surfaces it, with a live-watchdog
  // transient so any delivery to it DEFERS into its outbox. Returns the
  // WORKTREE agent dir; readers of the outbox queue should use queueDirOf(id).
  async function plantAgent(id: string): Promise<string> {
    const agentDir = join(repoDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    await mkdir(queueDirOf(id), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `t-${id}` }));
    await plantLiveWatchdog(agentDir);
    return agentDir;
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "team-cmd-" + crypto.randomUUID() + "-"));
    homeDir = join(baseDir, ".itsybitsy");
    repoDir = join(baseDir, "repo");
    await mkdir(homeDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = baseDir;
    setCoordinatorHome(homeDir);
    setUserConfigPath(join(homeDir, "config.json"));
    await saveRegistry({ repos: [{ path: repoDir, name: basename(repoDir) }] });
    setSendSpawnRunner(() => makeSpawnResult());
    isPidAliveCtx.set(() => true);
    resetReadAgentMetaCache();
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetUserConfigPath();
    resetCoordinatorHome();
    isPidAliveCtx.reset();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    resetReadAgentMetaCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  // --- teamCreate ---------------------------------------------------------

  test("teamCreate rejects an invalid name (allowlist)", async () => {
    const res = await teamCreate("bad name!");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("invalid team name");
  });

  test("teamCreate rejects a reserved name (@system)", async () => {
    const res = await teamCreate("system");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("reserved");
  });

  test("teamCreate rejects a reserved name (repo basename collision)", async () => {
    const res = await teamCreate(basename(repoDir));
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("reserved");
  });

  test("teamCreate succeeds and persists; duplicate errors", async () => {
    const ok = await teamCreate("backend");
    expect(ok.ok).toBe(true);
    expect(ok.stdout).toBe("Created team @backend");
    expect(await getTeam("backend")).not.toBeNull();

    const dup = await teamCreate("@backend"); // leading @ normalized away
    expect(dup.ok).toBe(false);
    expect(dup.stderr).toContain("already exists");
  });

  test("teamCreate writes a SYSTEM record to the team's channel.jsonl ('team created', @system actor)", async () => {
    const res = await teamCreate("backend");
    expect(res.ok).toBe(true);
    const recs = await readChannel("backend");
    // The team-create system notice should be the ONLY record in the new channel.
    expect(recs.length).toBe(1);
    expect(recs[0]!.kind).toBe("system");
    expect(recs[0]!.fromAgent).toBe("@system");
    // §17.4 design update: chat-box copy drops the "by <user>" attribution
    // suffix that <team>.log keeps. Audit log keeps the full version.
    expect(recs[0]!.message).toBe("team created");
  });

  // --- teamAdd ------------------------------------------------------------

  test("teamAdd errors when the team does not exist", async () => {
    await plantAgent("agent-a");
    const res = await teamAdd("ghost", "agent-a", repos());
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("not found");
  });

  test("teamAdd with a prefix does NOT resolve (exact-only); full id stores + fires join notice", async () => {
    await teamCreate("backend");
    const existingDir = await plantAgent("agent-existing");
    const newDir = await plantAgent("agent-newcomer");
    // Seed an existing member directly so the join notice has a recipient.
    await addMember("backend", "agent-existing");
    resetReadAgentMetaCache();

    // Prefix-only input must be rejected.
    const prefixRes = await teamAdd("backend", "agent-newc", repos());
    expect(prefixRes.ok).toBe(false);
    expect(prefixRes.stderr).toContain("agent not found: agent-newc");

    // Full id resolves and fires the join notice.
    const res = await teamAdd("backend", "agent-newcomer", repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("Added agent-newcomer to @backend");

    const team = await getTeam("backend");
    expect(team!.members).toContain("agent-newcomer");

    // Existing member receives "joined the team" with team prefix.
    const existingQueue = await readOutbox(queueDirOf("agent-existing"));
    expect(existingQueue.length).toBe(1);
    expect(existingQueue[0]!.message).toBe("joined the team");
    expect(existingQueue[0]!.fromAgent).toBe("agent-newcomer");
    expect(existingQueue[0]!.team).toBe("backend");

    // Newcomer receives the reply-protocol instruction from @system.
    const newQueue = await readOutbox(queueDirOf("agent-newcomer"));
    expect(newQueue.length).toBe(1);
    expect(newQueue[0]!.fromAgent).toBe("@system");
    expect(newQueue[0]!.team).toBe("backend");
    expect(newQueue[0]!.message).toContain("ib send @backend");
    expect(newQueue[0]!.message).toContain("ib roster @backend");

    // And the channel.jsonl now carries a SYSTEM `joined the team` record so
    // the chat box renders the lifecycle event dimmed inline with chat (§17.4
    // design update).
    const recs = await readChannel("backend");
    const joins = recs.filter((r) => r.kind === "system" && r.message === "joined the team");
    expect(joins.length).toBe(1);
    expect(joins[0]!.fromAgent).toBe("agent-newcomer");
  });

  test("teamAdd of an already-member is a no-op success (no notice)", async () => {
    await teamCreate("backend");
    const aDir = await plantAgent("agent-a");
    await addMember("backend", "agent-a");
    resetReadAgentMetaCache();

    const res = await teamAdd("backend", "agent-a", repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("already in @backend");
    // No join notice fired (the agent was already a member).
    expect(await readOutbox(queueDirOf("agent-a"))).toEqual([]);
  });

  // --- teamRemove ---------------------------------------------------------

  test("teamRemove errors when the team does not exist", async () => {
    const res = await teamRemove("ghost", "agent-a", repos());
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("not found");
  });

  test("teamRemove fires a per-agent leave notice to survivors, stamped to departed id", async () => {
    await teamCreate("backend");
    const survivorDir = await plantAgent("agent-survivor");
    await plantAgent("agent-leaver");
    await addMember("backend", "agent-survivor");
    await addMember("backend", "agent-leaver");
    resetReadAgentMetaCache();

    const res = await teamRemove("backend", "agent-leaver", repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("Removed agent-leaver from @backend");

    const team = await getTeam("backend");
    expect(team!.members).toEqual(["agent-survivor"]);

    const queue = await readOutbox(queueDirOf("agent-survivor"));
    expect(queue.length).toBe(1);
    expect(queue[0]!.message).toBe("left the team");
    expect(queue[0]!.fromAgent).toBe("agent-leaver");
    expect(queue[0]!.team).toBe("backend");

    // The leave is also mirrored into the channel.jsonl as a SYSTEM record so
    // the chat box renders it dimmed inline with chat (§17.4 design update).
    const recs = await readChannel("backend");
    const leaves = recs.filter((r) => r.kind === "system" && r.message === "left the team");
    expect(leaves.length).toBe(1);
    expect(leaves[0]!.fromAgent).toBe("agent-leaver");
  });

  test("teamRemove of a non-member is a no-op success", async () => {
    await teamCreate("backend");
    await plantAgent("agent-a");
    const res = await teamRemove("backend", "agent-a", repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("was not in @backend");
  });

  // --- teamList / teamDelete ---------------------------------------------

  test("teamList shows member counts; empty → 'No teams.'", async () => {
    const empty = await teamList();
    expect(empty.stdout).toBe("No teams.");

    await teamCreate("backend");
    await teamCreate("frontend");
    await addMember("backend", "agent-a");
    const listed = await teamList();
    expect(listed.stdout).toContain("@backend  1 member(s)");
    expect(listed.stdout).toContain("@frontend  0 member(s)");
  });

  test("teamDelete removes a team; missing team errors", async () => {
    await teamCreate("backend");
    const ok = await teamDelete("backend");
    expect(ok.ok).toBe(true);
    expect(ok.stdout).toBe("Deleted team @backend");
    expect(await getTeam("backend")).toBeNull();

    const missing = await teamDelete("backend");
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toContain("not found");
  });

  // --- roster -------------------------------------------------------------

  test("roster errors when the team does not exist", async () => {
    const res = await roster("ghost", repos());
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("not found");
  });

  test("roster lists members and prunes a dead member from the stored roster", async () => {
    await teamCreate("backend");
    await plantAgent("agent-live");
    // agent-dead is in the roster but never planted on disk → dead.
    await addMember("backend", "agent-live");
    await addMember("backend", "agent-dead");
    resetReadAgentMetaCache();

    const res = await roster("backend", repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("@backend (1 members):");
    expect(res.stdout).toContain("agent-live");
    expect(res.stdout).not.toContain("agent-dead");

    // The dead member was pruned from teams.json.
    const team = await getTeam("backend");
    expect(team!.members).toEqual(["agent-live"]);
  });

  test("roster of an empty team prints '(0 members)'", async () => {
    await teamCreate("backend");
    const res = await roster("backend", repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("@backend (0 members)");
  });

  // FIX 2 (BLOCKER — spec conformance): roster must render the LIVE detected
  // state (§16.3: "state read via detectAgentStates()"), not the uniform
  // "unknown" that readAllAgents stamps. The planted agent carries
  // meta.state === "waiting" + a fresh live-watchdog transient, so
  // detectAgentStates resolves its state to "waiting" via the transient
  // fast-path. Before the fix (no detectAgentStates call) the column read
  // "unknown".
  test("roster renders each member's live detected state, not 'unknown'", async () => {
    await teamCreate("backend");
    const agentDir = join(repoDir, ".ittybitty", "agents", "agent-wait");
    await mkdir(agentDir, { recursive: true });
    // meta.state === "waiting" → detectAgentStates resolves "waiting" through the
    // fresh-watchdog transient fast-path (isPidAliveCtx is stubbed true).
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "agent-wait", tmux_session: "t-agent-wait", state: "waiting" }),
    );
    await plantLiveWatchdog(agentDir);
    await addMember("backend", "agent-wait");
    resetReadAgentMetaCache();

    const res = await roster("backend", repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("agent-wait");
    expect(res.stdout).toContain("waiting");
    expect(res.stdout).not.toContain("unknown");
  });

  // --- teamSend (fan-out) -------------------------------------------------

  async function resolvedMembers(ids: string[]): Promise<Agent[]> {
    const { agents } = await readAllAgents(repos(), false);
    const byId = new Map(agents.map((a) => [a.id, a]));
    return ids.map((id) => byId.get(id)).filter((a): a is Agent => Boolean(a));
  }

  test("teamSend fans out to N members and excludes the sender", async () => {
    await teamCreate("backend");
    const aDir = await plantAgent("agent-a");
    const bDir = await plantAgent("agent-b");
    const cDir = await plantAgent("agent-c");
    await addMember("backend", "agent-a");
    await addMember("backend", "agent-b");
    await addMember("backend", "agent-c");
    resetReadAgentMetaCache();

    const members = await resolvedMembers(["agent-a", "agent-b", "agent-c"]);
    const res = await teamSend("backend", members, "standup time", { fromAgent: "agent-a" }, repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("Sent to 2 member(s) of @backend");

    // Sender excluded.
    expect(await readOutbox(queueDirOf("agent-a"))).toEqual([]);
    // Other two received with team prefix metadata.
    const bQueue = await readOutbox(queueDirOf("agent-b"));
    const cQueue = await readOutbox(queueDirOf("agent-c"));
    expect(bQueue[0]!.message).toBe("standup time");
    expect(bQueue[0]!.team).toBe("backend");
    expect(bQueue[0]!.fromAgent).toBe("agent-a");
    expect(cQueue[0]!.team).toBe("backend");
  });

  test("teamSend with empty team → no-op success", async () => {
    await teamCreate("backend");
    const res = await teamSend("backend", [], "anyone there?", undefined, repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("no recipients in @backend");
  });

  test("teamSend where the only member is the sender → no-op success", async () => {
    await teamCreate("backend");
    await plantAgent("agent-solo");
    await addMember("backend", "agent-solo");
    resetReadAgentMetaCache();
    const members = await resolvedMembers(["agent-solo"]);
    const res = await teamSend("backend", members, "hi", { fromAgent: "agent-solo" }, repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("no recipients in @backend");
  });

  test("teamSend lazy-prunes a dead member from the roster before fanning out", async () => {
    await teamCreate("backend");
    const liveDir = await plantAgent("agent-live");
    // agent-ghost is on the roster but never planted → dead, gets pruned.
    await addMember("backend", "agent-live");
    await addMember("backend", "agent-ghost");
    resetReadAgentMetaCache();

    const members = await resolvedMembers(["agent-live"]); // resolver already dropped ghost
    const res = await teamSend("backend", members, "hello", { fromAgent: "@system" }, repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("Sent to 1 member(s) of @backend");

    // Live member received it; roster pruned to just the live member.
    expect((await readOutbox(queueDirOf("agent-live"))).length).toBe(1);
    const team = await getTeam("backend");
    expect(team!.members).toEqual(["agent-live"]);
  });

  // FIX 1 (BLOCKER) — call-site coverage. teamSend now builds its liveness
  // predicate as `(id) => (await liveAgentIds(repos)).has(id)`, which RECOMPUTES
  // fresh existence on each call rather than closing over a pre-lock Set. This
  // exercises the new predicate end-to-end: a dead member forces the locked
  // prune branch, and a genuinely-live member (planted on disk) MUST survive the
  // in-lock re-scan and still receive the message. The teams.ts contract tests
  // prove the frozen-vs-fresh difference; this confirms the wired-up call-site
  // keeps a live member while pruning a dead one through the real fan-out.
  test("teamSend keeps a live member through the locked prune while a dead one is removed", async () => {
    await teamCreate("backend");
    const liveDir = await plantAgent("agent-keep");
    // agent-dead forces the locked prune branch (it is dead); agent-keep is a
    // real, on-disk live member that the in-lock re-scan must NOT drop.
    await addMember("backend", "agent-dead");
    await addMember("backend", "agent-keep");
    resetReadAgentMetaCache();

    const members = await resolvedMembers(["agent-keep"]);
    const res = await teamSend("backend", members, "still here?", { fromAgent: "@system" }, repos());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("Sent to 1 member(s) of @backend");

    // Live member received it and survived; dead member pruned.
    expect((await readOutbox(queueDirOf("agent-keep"))).length).toBe(1);
    const team = await getTeam("backend");
    expect(team!.members).toEqual(["agent-keep"]);
  });

  // Regression: an ARCHIVED member is dead from the team's perspective.
  // liveAgentIds (in ib-commands.ts) calls readAllAgents(..., false), so an
  // archived agent's id is NOT in the live set; teamSend's lazy-prune must
  // therefore drop it from teams.json instead of treating it as alive.
  test("teamSend prunes an ARCHIVED member (liveAgentIds excludes archived agents)", async () => {
    await teamCreate("backend");
    await plantAgent("agent-keep");
    // Plant an archived agent: same meta.json shape, but under archive/, not agents/.
    // readAllAgents(repos, false) must NOT surface it → liveAgentIds drops it → prune.
    const archivedDir = join(repoDir, ".ittybitty", "archive", "agent-archived");
    await mkdir(archivedDir, { recursive: true });
    await Bun.write(join(archivedDir, "meta.json"), JSON.stringify({ id: "agent-archived", tmux_session: "t-agent-archived" }));
    await addMember("backend", "agent-archived");
    await addMember("backend", "agent-keep");
    resetReadAgentMetaCache();

    const members = await resolvedMembers(["agent-keep"]);
    const res = await teamSend("backend", members, "ping", { fromAgent: "@system" }, repos());
    expect(res.ok).toBe(true);

    // Live member survived; archived member pruned (would have stayed if
    // liveAgentIds erroneously included archived agents in its live set).
    const team = await getTeam("backend");
    expect(team!.members).toEqual(["agent-keep"]);
  });

  // Spec-N1 (§17.4): pin the channel-append placement. The append in teamSend
  // must sit AFTER the team-not-found check and BEFORE the empty-recipient
  // early return — a §16.4-class trap that a future refactor could silently
  // break. Two assertions cover both edges of the placement window:
  //   (1) EXISTING team, zero post-exclusion recipients → still appends 1 record
  //       (sender talking to a room they're alone in is part of the channel).
  //   (2) NONEXISTENT team → no channel file is created and the command errors.
  test("teamSend channel-append placement: existing-empty appends 1, nonexistent appends 0 (§17.4 Spec-N1)", async () => {
    // Case (1): existing team, no recipients after sender-exclusion.
    await teamCreate("backend");
    await plantAgent("agent-solo");
    await addMember("backend", "agent-solo");
    resetReadAgentMetaCache();
    const members = await resolvedMembers(["agent-solo"]);
    const res1 = await teamSend("backend", members, "alone but talking", { fromAgent: "agent-solo" }, repos());
    expect(res1.ok).toBe(true);
    expect(res1.stdout).toBe("no recipients in @backend");
    // The channel now contains TWO records: the SYSTEM `team created` notice
    // written by teamCreate (§17.4 design update) and the chat record this
    // teamSend appended. Filter to the chat path for the placement assertion.
    const channel = await readChannel("backend");
    const chatRecords = channel.filter((r) => r.kind !== "system");
    expect(chatRecords.length).toBe(1);
    expect(chatRecords[0]!.message).toBe("alone but talking");
    expect(chatRecords[0]!.fromAgent).toBe("agent-solo");

    // Case (2): nonexistent team — no append, command errors.
    const res2 = await teamSend("ghost-team", [], "into the void", undefined, repos());
    expect(res2.ok).toBe(false);
    const ghostFileExists = await Bun.file(channelPath("ghost-team")).exists();
    expect(ghostFileExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveTarget team branch (§16.1/§16.4)
// ---------------------------------------------------------------------------

describe("teams: resolveTarget team branch", () => {
  let baseDir: string;
  let homeDir: string;
  let repoDir: string;
  let originalHome: string | undefined;

  function repos() {
    return [{ path: repoDir, name: basename(repoDir) }];
  }

  async function plantAgent(id: string): Promise<void> {
    const agentDir = join(repoDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `t-${id}` }));
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "team-resolve-" + crypto.randomUUID() + "-"));
    homeDir = join(baseDir, ".itsybitsy");
    repoDir = join(baseDir, "repo");
    await mkdir(homeDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = baseDir;
    setCoordinatorHome(homeDir);
    await saveRegistry({ repos: [{ path: repoDir, name: basename(repoDir) }] });
    resetReadAgentMetaCache();
  });

  afterEach(async () => {
    resetCoordinatorHome();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    resetReadAgentMetaCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  test("known @team resolves to a team target with resolved member Agents", async () => {
    await createTeam("backend", "", Math.floor(Date.now() / 1000));
    await plantAgent("agent-a");
    await plantAgent("agent-b");
    await addMember("backend", "agent-a");
    await addMember("backend", "agent-b");
    resetReadAgentMetaCache();

    const result = await resolveTarget("@backend", repos(), "/tmp");
    expect(result.agent).toBeNull();
    expect(result.isSystemCoordinator).toBe(false);
    expect(result.team).toBeDefined();
    expect(result.team!.name).toBe("backend");
    const ids = result.team!.members.map((m) => m.id).sort();
    expect(ids).toEqual(["agent-a", "agent-b"]);
  });

  test("team branch skips members that no longer resolve to an agent", async () => {
    await createTeam("backend", "", Math.floor(Date.now() / 1000));
    await plantAgent("agent-a");
    await addMember("backend", "agent-a");
    await addMember("backend", "agent-gone"); // never planted
    resetReadAgentMetaCache();

    const result = await resolveTarget("@backend", repos(), "/tmp");
    expect(result.team!.members.map((m) => m.id)).toEqual(["agent-a"]);
  });

  test("unknown @name (neither repo nor team) errors, no team target", async () => {
    const result = await resolveTarget("@nope", repos(), "/tmp");
    expect(result.agent).toBeNull();
    expect(result.isSystemCoordinator).toBe(false);
    expect(result.team).toBeUndefined();
  });

  test("@<repo>/<agent> with an unknown repo still errors and is NOT treated as a team", async () => {
    // Even if a team named 'backend' exists, a slashed address can never be a team.
    await createTeam("backend", "", Math.floor(Date.now() / 1000));
    resetReadAgentMetaCache();
    const result = await resolveTarget("@backend/agent-a", repos(), "/tmp");
    expect(result.agent).toBeNull();
    expect(result.team).toBeUndefined();
  });
});

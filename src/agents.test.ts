import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import {
  computeAge,
  buildAgentTree,
  flattenAgentTree,
  readRepoAgents,
  readPendingQuestions,
  readAllAgents,
  computeStateFromContent,
  readAgentMeta,
  isRecentlyCreated,
  writeAgentState,
  readAgentState,
  mutateAgentMeta,
  isCompacting,
  isRateLimited,
  isApiError,
  isApiErrorRateLimited,
  hasBackgroundTasks,
  isDeadPane,
  anyChildActive,
  detectAgentStates,
  CREATING_GRACE_PERIOD_MS,
  isRecentlyCreatedDirCtx,
  classifySpawnLogCtx,
  SPAWN_IN_PROGRESS_WINDOW_MS,
  resetListTmuxSessionsCache,
  resetReapedTmuxSessions,
  readAgentTransient,
  writeAgentTransient,
  deleteAgentTransient,
  updateAgentTransient,
  setAgentOperation,
  clearAgentOperation,
  isPidAliveCtx,
  killPidCtx,
  liveTmuxSessionsCtx,
  nowMsCtx,
  resetReadAgentMetaCache,
  TRANSIENT_FRESH_MS,
  OP_STUCK_TIMEOUT_MS,
  _isPidAliveForTests,
  terminateProcess,
  sleepMsCtx,
} from "./agents";
import type { TransientState, AgentOperation } from "./agents";
import { spawnCtx as tmuxPollerSpawnCtx } from "./tmux-poller";
import type { Agent, AgentMeta, FlatEntry, SpawnedBy } from "./agents";
import { makeAgent } from "./test-utils";

/** Narrow a FlatEntry to kind==="agent" or fail */
function asAgent(entry: FlatEntry) {
  if (entry.kind !== "agent") throw new Error(`Expected agent entry, got ${entry.kind}`);
  return entry;
}

/** Narrow a FlatEntry to kind==="repo-header" or fail */
function asRepoHeader(entry: FlatEntry) {
  if (entry.kind !== "repo-header") throw new Error(`Expected repo-header entry, got ${entry.kind}`);
  return entry;
}

describe("computeAge", () => {
  test("seconds", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now - 30)).toBe("30s");
  });
  test("minutes", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now - 120)).toBe("2m");
  });
  test("hours", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now - 7200)).toBe("2h");
  });
  test("days", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now - 172800)).toBe("2d");
  });
  test("zero seconds", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now)).toBe("0s");
  });
});

describe("buildAgentTree", () => {
  test("single agent with no manager becomes root", () => {
    const agents = [makeAgent({ id: "agent-1" })];
    const roots = buildAgentTree(agents);
    expect(roots.length).toBe(1);
    expect(roots[0]!.id).toBe("agent-1");
    expect(roots[0]!.children.length).toBe(0);
  });

  test("child is nested under manager", () => {
    const manager = makeAgent({ id: "agent-1" });
    const worker = makeAgent({
      id: "agent-2",
      meta: { manager: "agent-1" } as any,
    });
    // Need to set manager on the actual meta
    worker.meta.manager = "agent-1";
    const agents = [manager, worker];
    const roots = buildAgentTree(agents);
    expect(roots.length).toBe(1);
    expect(roots[0]!.id).toBe("agent-1");
    expect(roots[0]!.children.length).toBe(1);
    expect(roots[0]!.children[0]!.id).toBe("agent-2");
  });

  test("agent with missing manager becomes root", () => {
    const agent = makeAgent({ id: "agent-1" });
    agent.meta.manager = "nonexistent";
    const roots = buildAgentTree([agent]);
    expect(roots.length).toBe(1);
    expect(roots[0]!.id).toBe("agent-1");
  });

  test("multi-level tree", () => {
    const root = makeAgent({ id: "root" });
    const mid = makeAgent({ id: "mid" });
    mid.meta.manager = "root";
    const leaf = makeAgent({ id: "leaf" });
    leaf.meta.manager = "mid";

    const roots = buildAgentTree([root, mid, leaf]);
    expect(roots.length).toBe(1);
    expect(roots[0]!.children.length).toBe(1);
    expect(roots[0]!.children[0]!.children.length).toBe(1);
    expect(roots[0]!.children[0]!.children[0]!.id).toBe("leaf");
  });

  test("multiple roots", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const roots = buildAgentTree([a, b]);
    expect(roots.length).toBe(2);
  });

  test("agent with valid manager is not orphaned", () => {
    const manager = makeAgent({ id: "mgr" });
    const worker = makeAgent({ id: "w1" });
    worker.meta.manager = "mgr";
    buildAgentTree([manager, worker]);
    expect(worker.orphaned).toBe(false);
  });

  test("agent with non-existent manager is orphaned", () => {
    const agent = makeAgent({ id: "a1" });
    agent.meta.manager = "does-not-exist";
    buildAgentTree([agent]);
    expect(agent.orphaned).toBe(true);
  });

  test("agent with no manager is not orphaned", () => {
    const agent = makeAgent({ id: "a1" });
    buildAgentTree([agent]);
    expect(agent.orphaned).toBe(false);
  });

  test("orphaned flag resets correctly on second call", () => {
    const agent = makeAgent({ id: "a1" });
    agent.meta.manager = "missing";
    buildAgentTree([agent]);
    expect(agent.orphaned).toBe(true);

    // Now add the missing manager and rebuild
    const manager = makeAgent({ id: "missing" });
    buildAgentTree([manager, agent]);
    expect(agent.orphaned).toBe(false);
  });

  test("agent with archived manager becomes orphaned root", () => {
    const manager = makeAgent({ id: "mgr", archived: true });
    const worker = makeAgent({ id: "w1" });
    worker.meta.manager = "mgr";
    const roots = buildAgentTree([manager, worker]);
    // Worker should be a root (not nested under archived manager)
    expect(roots).toContainEqual(expect.objectContaining({ id: "w1" }));
    expect(worker.orphaned).toBe(true);
    // Archived manager should also be a root
    expect(roots).toContainEqual(expect.objectContaining({ id: "mgr" }));
    // Manager should have no children
    expect(manager.children.length).toBe(0);
  });

  test("active agent with archived manager is visible in flattened tree", () => {
    const manager = makeAgent({ id: "mgr", archived: true });
    const worker = makeAgent({ id: "w1" });
    worker.meta.manager = "mgr";
    const roots = buildAgentTree([manager, worker]);
    const flat = flattenAgentTree(roots);
    // Worker should appear (archived manager is filtered out)
    const agentEntries = flat.filter((e) => e.kind === "agent");
    expect(agentEntries.length).toBe(1);
    expect((agentEntries[0] as any).agent.id).toBe("w1");
  });
});

describe("flattenAgentTree", () => {
  test("flat list with correct depths", () => {
    const root = makeAgent({ id: "root" });
    const child = makeAgent({ id: "child" });
    child.meta.manager = "root";

    const roots = buildAgentTree([root, child]);
    const flat = flattenAgentTree(roots);

    expect(flat.length).toBe(2);
    expect(asAgent(flat[0]!).agent.id).toBe("root");
    expect(asAgent(flat[0]!).depth).toBe(0);
    expect(asAgent(flat[1]!).agent.id).toBe("child");
    expect(asAgent(flat[1]!).depth).toBe(1);
  });

  test("empty tree returns empty list", () => {
    expect(flattenAgentTree([]).length).toBe(0);
  });

  test("three-level depth", () => {
    const root = makeAgent({ id: "root" });
    const mid = makeAgent({ id: "mid" });
    mid.meta.manager = "root";
    const leaf = makeAgent({ id: "leaf" });
    leaf.meta.manager = "mid";

    const roots = buildAgentTree([root, mid, leaf]);
    const flat = flattenAgentTree(roots);
    expect(asAgent(flat[0]!).depth).toBe(0);
    expect(asAgent(flat[1]!).depth).toBe(1);
    expect(asAgent(flat[2]!).depth).toBe(2);
  });

  test("single root has no connector", () => {
    const root = makeAgent({ id: "root" });
    const roots = buildAgentTree([root]);
    const flat = flattenAgentTree(roots);
    expect(asAgent(flat[0]!).connector).toBe("");
  });

  test("multiple roots get ├── and └── connectors", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const roots = buildAgentTree([a, b]);
    const flat = flattenAgentTree(roots);
    expect(asAgent(flat[0]!).connector).toBe("├── ");
    expect(asAgent(flat[1]!).connector).toBe("└── ");
  });

  test("child connectors use ├── and └──", () => {
    const root = makeAgent({ id: "root" });
    const c1 = makeAgent({ id: "c1" });
    c1.meta.manager = "root";
    const c2 = makeAgent({ id: "c2" });
    c2.meta.manager = "root";

    const roots = buildAgentTree([root, c1, c2]);
    const flat = flattenAgentTree(roots);
    expect(asAgent(flat[0]!).connector).toBe("");       // single root
    expect(asAgent(flat[1]!).connector).toBe("├── ");   // first child
    expect(asAgent(flat[2]!).connector).toBe("└── ");   // last child
  });

  test("nested children use │ continuation lines", () => {
    const root = makeAgent({ id: "root" });
    const c1 = makeAgent({ id: "c1" });
    c1.meta.manager = "root";
    const c2 = makeAgent({ id: "c2" });
    c2.meta.manager = "root";
    const leaf = makeAgent({ id: "leaf" });
    leaf.meta.manager = "c1";

    const roots = buildAgentTree([root, c1, c2, leaf]);
    const flat = flattenAgentTree(roots);
    // root (no connector, single root)
    expect(asAgent(flat[0]!).connector).toBe("");
    // c1 (first child of root, not last)
    expect(asAgent(flat[1]!).connector).toBe("├── ");
    // leaf (child of c1, c1 is not last sibling so prefix has │)
    expect(asAgent(flat[2]!).connector).toBe("│   └── ");
    // c2 (last child of root)
    expect(asAgent(flat[3]!).connector).toBe("└── ");
  });

  test("deep nesting with mixed last-sibling flags", () => {
    const root = makeAgent({ id: "root" });
    const a = makeAgent({ id: "a" });
    a.meta.manager = "root";
    const b = makeAgent({ id: "b" });
    b.meta.manager = "root";
    const a1 = makeAgent({ id: "a1" });
    a1.meta.manager = "a";
    const a1x = makeAgent({ id: "a1x" });
    a1x.meta.manager = "a1";

    const roots = buildAgentTree([root, a, b, a1, a1x]);
    const flat = flattenAgentTree(roots);
    // a1x is under a1 (last child of a), a is not last child of root
    expect(asAgent(flat[0]!).connector).toBe("");           // root
    expect(asAgent(flat[1]!).connector).toBe("├── ");       // a
    expect(asAgent(flat[2]!).connector).toBe("│   └── ");   // a1
    expect(asAgent(flat[3]!).connector).toBe("│       └── "); // a1x
    expect(asAgent(flat[4]!).connector).toBe("└── ");       // b
  });

  test("multi-repo: groups agents under sorted repo headers", () => {
    const a = makeAgent({ id: "a1", repoName: "zeta-repo" });
    const b = makeAgent({ id: "b1", repoName: "alpha-repo" });
    const roots = buildAgentTree([a, b]);
    const flat = flattenAgentTree(roots, ["zeta-repo", "alpha-repo"]);

    // Should be sorted alphabetically: alpha-repo first, then zeta-repo
    expect(flat.length).toBe(4); // 2 headers + 2 agents
    expect(asRepoHeader(flat[0]!).repoName).toBe("alpha-repo");
    expect(asRepoHeader(flat[0]!).hasAgents).toBe(true);
    expect(asAgent(flat[1]!).agent.id).toBe("b1");
    expect(asRepoHeader(flat[2]!).repoName).toBe("zeta-repo");
    expect(asRepoHeader(flat[2]!).hasAgents).toBe(true);
    expect(asAgent(flat[3]!).agent.id).toBe("a1");
  });

  test("multi-repo: includes empty repos with repoHasAgents=false", () => {
    const a = makeAgent({ id: "a1", repoName: "has-agents" });
    const roots = buildAgentTree([a]);
    const flat = flattenAgentTree(roots, ["has-agents", "empty-repo"]);

    expect(flat.length).toBe(3); // 2 headers + 1 agent
    // Sorted: empty-repo, has-agents
    expect(asRepoHeader(flat[0]!).repoName).toBe("empty-repo");
    expect(asRepoHeader(flat[0]!).hasAgents).toBe(false);
    expect(asRepoHeader(flat[1]!).repoName).toBe("has-agents");
    expect(asRepoHeader(flat[1]!).hasAgents).toBe(true);
    expect(asAgent(flat[2]!).agent.id).toBe("a1");
  });

  test("multi-repo: empty repos sorted alphabetically with populated repos", () => {
    const flat = flattenAgentTree([], ["charlie", "alpha", "bravo"]);
    expect(flat.length).toBe(3);
    expect(asRepoHeader(flat[0]!).repoName).toBe("alpha");
    expect(asRepoHeader(flat[0]!).hasAgents).toBe(false);
    expect(asRepoHeader(flat[1]!).repoName).toBe("bravo");
    expect(asRepoHeader(flat[1]!).hasAgents).toBe(false);
    expect(asRepoHeader(flat[2]!).repoName).toBe("charlie");
    expect(asRepoHeader(flat[2]!).hasAgents).toBe(false);
  });

  test("single repo: no headers when repoNames has 1 entry", () => {
    const a = makeAgent({ id: "a1" });
    const roots = buildAgentTree([a]);
    const flat = flattenAgentTree(roots, ["test"]);
    expect(flat.length).toBe(1);
    expect(flat[0]!.kind).toBe("agent");
    expect(asAgent(flat[0]!).agent.id).toBe("a1");
  });

  test("multi-repo: coordinator agents are excluded from flat list", () => {
    const now = Math.floor(Date.now() / 1000);
    const regular = makeAgent({ id: "regular-1", repoName: "my-repo", meta: { created_epoch: now - 100 } as any });
    const coord = makeAgent({ id: "coord-1", repoName: "my-repo", meta: { agentType: "coordinator", created_epoch: now - 50 } as any });
    const regular2 = makeAgent({ id: "regular-2", repoName: "my-repo", meta: { created_epoch: now - 200 } as any });
    const roots = buildAgentTree([regular, coord, regular2]);
    // Need 2+ repos for headers to appear
    const flat = flattenAgentTree(roots, ["my-repo", "other-repo"]);

    // Coordinator should be excluded entirely — only regular agents appear
    const agentEntries = flat.filter((f): f is Extract<typeof f, { kind: "agent" }> => f.kind === "agent");
    expect(agentEntries.length).toBe(2);
    expect(agentEntries.every(e => e.agent.meta.agentType !== "coordinator")).toBe(true);
    expect(agentEntries[0]!.agent.id).toBe("regular-2");
    expect(agentEntries[1]!.agent.id).toBe("regular-1");
  });
});

describe("readRepoAgents", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-agents-test-"));
  });

  afterEach(async () => {
    isRecentlyCreatedDirCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reads agents from .ittybitty/agents/", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: "agent-abc",
        session_id: "sess-1",
        tmux_session: "tmux-abc",
        prompt: "do stuff",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: Math.floor(Date.now() / 1000) - 60,
        worktree: true,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "999",
      })
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe("agent-abc");
    expect(agents[0]!.repoName).toBe("test-repo");
    expect(agents[0]!.archived).toBe(false);
  });

  test("reads archived agents", async () => {
    const archiveDir = join(tempDir, ".ittybitty", "archive", "agent-old");
    await mkdir(archiveDir, { recursive: true });
    await Bun.write(
      join(archiveDir, "meta.json"),
      JSON.stringify({
        id: "agent-old",
        session_id: "sess-2",
        tmux_session: "tmux-old",
        prompt: "old task",
        manager: null,
        created: "2026-03-04T00:00:00Z",
        created_epoch: Math.floor(Date.now() / 1000) - 86400,
        worktree: true,
        worker: true,
        yolo: false,
        model: "opus",
        claude_pid: "888",
      })
    );

    // Need agents/ dir to exist (even empty) since readRepoAgents reads both
    await mkdir(join(tempDir, ".ittybitty", "agents"), { recursive: true });

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(1);
    expect(agents[0]!.archived).toBe(true);
    expect(agents[0]!.meta.worker).toBe(true);
  });

  test("returns empty for missing .ittybitty dir", async () => {
    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(0);
  });

  test("includeArchived=false excludes archived agents and does not touch archive dir", async () => {
    // One active agent and one archived agent on disk.
    const activeDir = join(tempDir, ".ittybitty", "agents", "agent-active");
    await mkdir(activeDir, { recursive: true });
    await Bun.write(join(activeDir, "meta.json"), JSON.stringify({
      id: "agent-active", session_id: "s-a", tmux_session: "t-a",
      prompt: "active task", manager: null, created: "2026-03-05",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true, worker: false, yolo: false, model: "sonnet", claude_pid: "1",
    }));

    const archiveDir = join(tempDir, ".ittybitty", "archive", "agent-old");
    await mkdir(archiveDir, { recursive: true });
    await Bun.write(join(archiveDir, "meta.json"), JSON.stringify({
      id: "agent-old", session_id: "s-o", tmux_session: "t-o",
      prompt: "old task", manager: null, created: "2026-03-04",
      created_epoch: Math.floor(Date.now() / 1000) - 86400,
      worktree: true, worker: true, yolo: false, model: "opus", claude_pid: "2",
    }));

    // Proof the archive dir is never read: replace its meta.json with a value
    // that WOULD surface as a malformed-meta error if the archive were scanned.
    // Because includeArchived=false skips the archive dir entirely, no error
    // appears and only the active agent is returned.
    isRecentlyCreatedDirCtx.set(async () => false);
    await Bun.write(join(archiveDir, "meta.json"), "{ this is not valid json");

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo", false);
    expect(errors.length).toBe(0); // archive dir not scanned → no malformed-meta error
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe("agent-active");
    expect(agents.some((a) => a.archived)).toBe(false);
  });

  test("includeArchived=true (default) still reads archived agents", async () => {
    const archiveDir = join(tempDir, ".ittybitty", "archive", "agent-old");
    await mkdir(archiveDir, { recursive: true });
    await Bun.write(join(archiveDir, "meta.json"), JSON.stringify({
      id: "agent-old", session_id: "s-o", tmux_session: "t-o",
      prompt: "old task", manager: null, created: "2026-03-04",
      created_epoch: Math.floor(Date.now() / 1000) - 86400,
      worktree: true, worker: true, yolo: false, model: "opus", claude_pid: "2",
    }));
    await mkdir(join(tempDir, ".ittybitty", "agents"), { recursive: true });

    // Explicit true and the no-arg default must both include archived agents.
    const explicit = await readRepoAgents(tempDir, "test-repo", true);
    expect(explicit.agents.length).toBe(1);
    expect(explicit.agents[0]!.archived).toBe(true);

    const defaulted = await readRepoAgents(tempDir, "test-repo");
    expect(defaulted.agents.length).toBe(1);
    expect(defaulted.agents[0]!.archived).toBe(true);
  });

  test("reports error for malformed meta.json (non-recent dir)", async () => {
    // Override to simulate a directory that's past the grace period
    isRecentlyCreatedDirCtx.set(async () => false);
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-bad");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), '{"not_valid": true}');

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("missing or invalid");
  });

  test("reports error for unparseable meta.json (non-recent dir)", async () => {
    isRecentlyCreatedDirCtx.set(async () => false);
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-corrupt");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), "not json at all");

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("Failed to read");
  });

  test("skips directories without meta.json (non-recent dir)", async () => {
    isRecentlyCreatedDirCtx.set(async () => false);
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-empty");
    await mkdir(agentDir, { recursive: true });
    // No meta.json written

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("Missing");
  });

  test("suppresses errors for recently-created agent directories", async () => {
    // Default isRecentlyCreatedDirCtx uses real birthtime — dirs just created are < 6s old
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-new");
    await mkdir(agentDir, { recursive: true });
    // No meta.json — simulates agent still being set up

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(0); // Error suppressed during grace period
  });

  test("suppresses errors for malformed meta.json in recently-created dirs", async () => {
    const agentDir = join(tempDir, ".ittybitsy", "agents", "agent-new2");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), '{"not_valid": true}');

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(0); // Error suppressed during grace period
  });

  test("renders in-progress spawn (recent [spawn] start, no completion) as creating, not orphan", async () => {
    // Fix 3: when meta.json is missing but agent.log shows a recent [spawn]
    // start with no terminating "spawn OK" / "spawn FAILED", the dashboard
    // should surface this as a creating agent, not an orphan.
    isRecentlyCreatedDirCtx.set(async () => false); // past 6s grace
    classifySpawnLogCtx.set(async () => ({
      kind: "in_progress",
      startEpochMs: Date.now() - 30_000, // 30s ago — well within window
    }));

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-spawning");
    await mkdir(agentDir, { recursive: true });
    // No meta.json — but a `[spawn] start` line in agent.log indicates active spawn.
    await Bun.write(
      join(agentDir, "agent.log"),
      "[2026-04-29 12:00:00] [spawn] start id=agent-spawning repo=/x worktree=true\n",
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe("agent-spawning");
    expect(agents[0]!.state).toBe("creating");
    expect(agents[0]!.meta.state).toBe("creating");

    classifySpawnLogCtx.reset();
  });

  test("flags orphan when [spawn] start is stale (older than the in-progress window)", async () => {
    isRecentlyCreatedDirCtx.set(async () => false);
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-stale");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "agent.log"),
      "[2026-04-29 09:00:00] [spawn] start id=agent-stale repo=/x worktree=true\n",
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("Missing");

    classifySpawnLogCtx.reset();
  });

  test("flags orphan when [spawn] start is followed by 'spawn FAILED' (terminated, not in-progress)", async () => {
    isRecentlyCreatedDirCtx.set(async () => false);
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-failed");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "agent.log"),
      "[2026-04-29 12:00:00] [spawn] start id=agent-failed repo=/x worktree=true\n" +
      "[2026-04-29 12:00:01] [spawn] spawn FAILED: could not create worktree\n",
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);

    classifySpawnLogCtx.reset();
  });

  test("classifySpawnLog default impl: detects recent in-progress spawn from real agent.log", async () => {
    // Exercises the actual classifier (not the injected mock) to verify it
    // parses timestamps and the start-without-terminator condition correctly.
    isRecentlyCreatedDirCtx.set(async () => false);

    // Use a timestamp 1 minute ago (within the 5min in-progress window) in
    // local time, formatted exactly like logAgent() does.
    const oneMinAgo = new Date(Date.now() - 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${oneMinAgo.getFullYear()}-${pad(oneMinAgo.getMonth() + 1)}-${pad(oneMinAgo.getDate())} ` +
      `${pad(oneMinAgo.getHours())}:${pad(oneMinAgo.getMinutes())}:${pad(oneMinAgo.getSeconds())}`;

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-real");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "agent.log"),
      `[${ts}] [spawn] start id=agent-real repo=/x worktree=true\n` +
      `[${ts}] [spawn] git worktree prune → exit=0\n`,
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(1);
    expect(agents[0]!.state).toBe("creating");
  });

  test("SPAWN_IN_PROGRESS_WINDOW_MS is reasonable for slow worktree-add", () => {
    // Sanity: window must comfortably exceed observed slow checkouts.
    expect(SPAWN_IN_PROGRESS_WINDOW_MS).toBeGreaterThanOrEqual(2 * 60 * 1000);
  });
});

describe("readAgentMeta", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-meta-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("meta.json with all correct fields works", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-abc",
        session_id: "sess-1",
        tmux_session: "tmux-abc",
        prompt: "do stuff",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: 1000,
        worktree: true,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "999",
      })
    );

    const { meta, error } = await readAgentMeta(tempDir);
    expect(error).toBeUndefined();
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe("agent-abc");
    expect(meta!.session_id).toBe("sess-1");
    expect(meta!.tmux_session).toBe("tmux-abc");
    expect(meta!.prompt).toBe("do stuff");
    expect(meta!.manager).toBeNull();
    expect(meta!.created).toBe("2026-03-05T00:00:00Z");
    expect(meta!.created_epoch).toBe(1000);
    expect(meta!.worktree).toBe(true);
    expect(meta!.worker).toBe(false);
    expect(meta!.yolo).toBe(false);
    expect(meta!.model).toBe("sonnet");
    expect(meta!.claude_pid).toBe("999");
  });

  test("meta.json with wrong-typed fields gets defaults applied", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-typed",
        session_id: 123,
        tmux_session: false,
        prompt: 42,
        manager: 99,
        created: true,
        created_epoch: "not-a-number",
        worktree: "yes",
        worker: "no",
        yolo: 1,
        model: 777,
        claude_pid: 0,
      })
    );

    const { meta, error } = await readAgentMeta(tempDir);
    expect(error).toBeUndefined();
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe("agent-typed");
    expect(meta!.session_id).toBe("");
    expect(meta!.tmux_session).toBe("");
    expect(meta!.prompt).toBe("");
    expect(meta!.manager).toBeNull();
    expect(meta!.created).toBe("");
    expect(meta!.created_epoch).toBe(0);
    expect(meta!.worktree).toBe(true);
    expect(meta!.worker).toBe(false);
    expect(meta!.yolo).toBe(false);
    expect(meta!.model).toBe("unknown");
    expect(meta!.claude_pid).toBe("");
  });

  test("meta.json with missing fields gets defaults applied", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-minimal",
      })
    );

    const { meta, error } = await readAgentMeta(tempDir);
    expect(error).toBeUndefined();
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe("agent-minimal");
    expect(meta!.session_id).toBe("");
    expect(meta!.tmux_session).toBe("");
    expect(meta!.prompt).toBe("");
    expect(meta!.manager).toBeNull();
    expect(meta!.created).toBe("");
    expect(meta!.created_epoch).toBe(0);
    expect(meta!.worktree).toBe(true);
    expect(meta!.worker).toBe(false);
    expect(meta!.yolo).toBe(false);
    expect(meta!.model).toBe("unknown");
    expect(meta!.claude_pid).toBe("");
    expect(meta!.summary).toBeUndefined();
  });

  test("reads summary field from meta.json when present", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-with-summary",
        summary: "A short task summary",
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.summary).toBe("A short task summary");
  });

  test("strips non-string summary values", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-bad-summary",
        summary: 123,
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.summary).toBeUndefined();
  });

  test("reads a valid nickname from meta.json when present", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({ id: "agent-nick", nickname: "pikachu" })
    );
    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.nickname).toBe("pikachu");
  });

  test("strips a non-string nickname value", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({ id: "agent-bad-nick", nickname: 42 })
    );
    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.nickname).toBeUndefined();
  });

  test("drops an empty-string nickname on read (defensive — should never exist)", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({ id: "agent-empty-nick", nickname: "" })
    );
    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.nickname).toBeUndefined();
  });
});

describe("readPendingQuestions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-questions-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reads pending questions from existing agents", async () => {
    await mkdir(join(tempDir, ".ittybitty", "agents", "agent-1"), { recursive: true });
    await Bun.write(
      join(tempDir, ".ittybitty", "user-questions.json"),
      JSON.stringify({
        questions: [
          { id: "q-1", agent: "agent-1", question: "Should I?", timestamp: "2026-03-05T00:00:00Z", status: "pending" },
          { id: "q-2", agent: "agent-2", question: "Done?", timestamp: "2026-03-05T00:01:00Z", status: "acknowledged" },
        ],
      })
    );

    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(1);
    expect(questions[0]!.id).toBe("q-1");
    expect(questions[0]!.status).toBe("pending");
  });

  test("filters out questions from agents that no longer exist", async () => {
    // Only agent-2 exists in agents dir; agent-1 does not
    await mkdir(join(tempDir, ".ittybitty", "agents", "agent-2"), { recursive: true });
    await Bun.write(
      join(tempDir, ".ittybitty", "user-questions.json"),
      JSON.stringify({
        questions: [
          { id: "q-1", agent: "agent-1", question: "Should I?", timestamp: "2026-03-05T00:00:00Z", status: "pending" },
          { id: "q-2", agent: "agent-2", question: "Done?", timestamp: "2026-03-05T00:01:00Z", status: "pending" },
        ],
      })
    );

    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(1);
    expect(questions[0]!.id).toBe("q-2");
  });

  test("filters out all questions when agents directory does not exist", async () => {
    // Create questions file but no agents/ directory
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    await Bun.write(
      join(tempDir, ".ittybitty", "user-questions.json"),
      JSON.stringify({
        questions: [
          { id: "q-1", agent: "agent-ghost", question: "Hello?", timestamp: "2026-03-05T00:00:00Z", status: "pending" },
        ],
      })
    );

    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(0);
  });

  test("returns empty for missing file", async () => {
    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(0);
  });

  test("returns empty for malformed file", async () => {
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    await Bun.write(join(tempDir, ".ittybitty", "user-questions.json"), "garbage");
    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(0);
  });
});

describe("computeStateFromContent", () => {
  test("empty string → returns 'creating'", () => {
    expect(computeStateFromContent("")).toBe("creating");
  });

  test("< 10 non-empty lines with no startup markers → returns 'creating'", () => {
    const input = "line1\nline2\nline3\n\n\n";
    expect(computeStateFromContent(input)).toBe("creating");
  });

  test("< 10 non-empty lines WITH a startup marker → returns null", () => {
    const input = "Claude Code v1.0\nline2\nline3";
    expect(computeStateFromContent(input)).toBeNull();
  });

  test("exactly 9 non-empty lines with no startup markers → returns 'creating'", () => {
    const lines = Array(9).fill("line").join("\n");
    expect(computeStateFromContent(lines)).toBe("creating");
  });

  test(">= 10 non-empty lines with no startup markers → returns null", () => {
    const lines = Array(10).fill("line").join("\n");
    expect(computeStateFromContent(lines)).toBeNull();
  });

  test("whitespace-only lines don't count as non-empty", () => {
    const input = "   \n  \n\t\n";
    expect(computeStateFromContent(input)).toBe("creating");
  });

  test("output with '[AGENT CONTEXT]' marker → returns null", () => {
    const input = "[AGENT CONTEXT]\nline2\nline3";
    expect(computeStateFromContent(input)).toBeNull();
  });

  test("output with '╭─ Claude Code' marker → returns null", () => {
    const input = "╭─ Claude Code\nline2";
    expect(computeStateFromContent(input)).toBeNull();
  });
});

describe("readAllAgents", () => {
  let tempDir1: string;
  let tempDir2: string;

  beforeEach(async () => {
    tempDir1 = await mkdtemp(join(tmpdir(), "itsybitsy-all-1-"));
    tempDir2 = await mkdtemp(join(tmpdir(), "itsybitsy-all-2-"));
  });

  afterEach(async () => {
    await rm(tempDir1, { recursive: true, force: true });
    await rm(tempDir2, { recursive: true, force: true });
  });

  test("reads across multiple repos", async () => {
    // Create agent in repo 1
    const dir1 = join(tempDir1, ".ittybitty", "agents", "agent-r1");
    await mkdir(dir1, { recursive: true });
    await Bun.write(join(dir1, "meta.json"), JSON.stringify({
      id: "agent-r1", session_id: "s1", tmux_session: "t1",
      prompt: "p1", manager: null, created: "2026-03-05", created_epoch: Date.now() / 1000,
      worktree: true, worker: false, yolo: false, model: "sonnet", claude_pid: "1",
    }));

    // Create agent in repo 2
    const dir2 = join(tempDir2, ".ittybitty", "agents", "agent-r2");
    await mkdir(dir2, { recursive: true });
    await Bun.write(join(dir2, "meta.json"), JSON.stringify({
      id: "agent-r2", session_id: "s2", tmux_session: "t2",
      prompt: "p2", manager: null, created: "2026-03-05", created_epoch: Date.now() / 1000,
      worktree: true, worker: false, yolo: false, model: "opus", claude_pid: "2",
    }));

    const { agents, errors } = await readAllAgents([
      { path: tempDir1, name: "repo1" },
      { path: tempDir2, name: "repo2" },
    ], false);
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(2);
    expect(agents.map((a) => a.repoName).sort()).toEqual(["repo1", "repo2"]);
  });

  test("returns orphanedTmuxSessions field (empty when no stale sessions)", async () => {
    const { orphanedTmuxSessions } = await readAllAgents([
      { path: tempDir1, name: "repo1" },
    ], false);
    // orphanedTmuxSessions should be an array (may be empty depending on system state)
    expect(Array.isArray(orphanedTmuxSessions)).toBe(true);
  });

  test("includeArchived flag controls whether archived agents are returned", async () => {
    // repo1: one active agent
    const active = join(tempDir1, ".ittybitty", "agents", "agent-active");
    await mkdir(active, { recursive: true });
    await Bun.write(join(active, "meta.json"), JSON.stringify({
      id: "agent-active", session_id: "s1", tmux_session: "t1",
      prompt: "p1", manager: null, created: "2026-03-05",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true, worker: false, yolo: false, model: "sonnet", claude_pid: "1",
    }));

    // repo2: one archived agent (and an empty agents/ dir)
    const archived = join(tempDir2, ".ittybitty", "archive", "agent-old");
    await mkdir(archived, { recursive: true });
    await mkdir(join(tempDir2, ".ittybitty", "agents"), { recursive: true });
    await Bun.write(join(archived, "meta.json"), JSON.stringify({
      id: "agent-old", session_id: "s2", tmux_session: "t2",
      prompt: "p2", manager: null, created: "2026-03-04",
      created_epoch: Math.floor(Date.now() / 1000) - 86400,
      worktree: true, worker: true, yolo: false, model: "opus", claude_pid: "2",
    }));

    const repos = [
      { path: tempDir1, name: "repo1" },
      { path: tempDir2, name: "repo2" },
    ];

    // false → only the active agent
    const excluded = await readAllAgents(repos, false);
    expect(excluded.agents.map((a) => a.id).sort()).toEqual(["agent-active"]);
    expect(excluded.agents.some((a) => a.archived)).toBe(false);

    // explicit true → both
    const includedExplicit = await readAllAgents(repos, true);
    expect(includedExplicit.agents.map((a) => a.id).sort()).toEqual(["agent-active", "agent-old"]);
  });
});

describe("isRecentlyCreated", () => {
  test("returns true for agent created less than 6 seconds ago", () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(isRecentlyCreated(nowEpoch)).toBe(true);
    expect(isRecentlyCreated(nowEpoch - 2)).toBe(true);
    expect(isRecentlyCreated(nowEpoch - 5)).toBe(true);
  });

  test("returns false for agent created more than 6 seconds ago", () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(isRecentlyCreated(nowEpoch - 7)).toBe(false);
    expect(isRecentlyCreated(nowEpoch - 60)).toBe(false);
    expect(isRecentlyCreated(nowEpoch - 3600)).toBe(false);
  });

  test("returns false at exactly 6 seconds (boundary)", () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(isRecentlyCreated(nowEpoch - 6)).toBe(false);
  });

  test("returns false for zero epoch", () => {
    expect(isRecentlyCreated(0)).toBe(false);
  });

  test("returns false for undefined/NaN epoch", () => {
    expect(isRecentlyCreated(NaN)).toBe(false);
    expect(isRecentlyCreated(undefined as unknown as number)).toBe(false);
  });
});

describe("writeAgentState / readAgentState", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agents-state-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes state and reads it back", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent", prompt: "hello" }));

    await writeAgentState(tempDir, "waiting");
    const state = await readAgentState(tempDir);
    expect(state).toBe("waiting");
  });

  test("writes state_updated_at alongside state", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent" }));

    const before = Math.floor(Date.now() / 1000);
    await writeAgentState(tempDir, "complete");
    const after = Math.floor(Date.now() / 1000);

    const data = await Bun.file(metaPath).json();
    expect(data.state).toBe("complete");
    expect(data.state_updated_at).toBeGreaterThanOrEqual(before);
    expect(data.state_updated_at).toBeLessThanOrEqual(after);
  });

  test("preserves existing meta.json fields", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent", prompt: "do stuff", model: "opus" }));

    await writeAgentState(tempDir, "running");
    const data = await Bun.file(metaPath).json();
    expect(data.id).toBe("test-agent");
    expect(data.prompt).toBe("do stuff");
    expect(data.model).toBe("opus");
    expect(data.state).toBe("running");
  });

  test("no-op if meta.json doesn't exist", async () => {
    // Should not throw
    await writeAgentState(tempDir, "running");
    const state = await readAgentState(tempDir);
    expect(state).toBeUndefined();
  });

  test("readAgentState returns undefined if state field is absent", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent" }));
    const state = await readAgentState(tempDir);
    expect(state).toBeUndefined();
  });

  test("overwrites previous state", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent", state: "waiting" }));

    await writeAgentState(tempDir, "complete");
    const state = await readAgentState(tempDir);
    expect(state).toBe("complete");
  });
});

describe("mutateAgentMeta — concurrent RMW (codex SessionStart vs PreToolUse race)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agents-meta-mutate-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("two concurrent writers both land — writeAgentState + captureCodexSessionId equivalent", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-x", model: "codex:gpt-5.4-mini" }));

    // Race the equivalent of: SessionStart writes state=running,
    // PreToolUse writes codex_session_id. Both must land.
    await Promise.all([
      writeAgentState(tempDir, "running"),
      mutateAgentMeta(tempDir, (m) => { m.codex_session_id = "rollout-aaa"; }),
    ]);

    const meta = await Bun.file(metaPath).json();
    expect(meta.id).toBe("agent-x");
    expect(meta.state).toBe("running");
    expect(meta.codex_session_id).toBe("rollout-aaa");
  });

  test("ten concurrent counter-bumps all land (lock is correct, not just lucky)", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-y", counter: 0 }));

    const N = 10;
    await Promise.all(
      Array.from({ length: N }, () =>
        mutateAgentMeta(tempDir, (m) => { m.counter = ((m.counter as number) ?? 0) + 1; }),
      ),
    );

    const meta = await Bun.file(metaPath).json();
    expect(meta.counter).toBe(N);
  });

  test("mutator returning null is a no-op (idempotent capture)", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-z", codex_session_id: "original" }));

    const wrote = await mutateAgentMeta(tempDir, (m) => {
      if (m.codex_session_id) return null;
      m.codex_session_id = "newer";
    });

    expect(wrote).toBe(false);
    const meta = await Bun.file(metaPath).json();
    expect(meta.codex_session_id).toBe("original");
  });

  test("returns false when meta.json is missing (best-effort)", async () => {
    const wrote = await mutateAgentMeta(tempDir, (m) => { m.foo = "bar"; });
    expect(wrote).toBe(false);
  });

  test("uses a unique tmp suffix — concurrent writes don't clobber each other's tmp files", async () => {
    // Regression guard for HIGH 2: writeAgentState used to write to
    // metaPath + ".tmp" unconditionally, which two concurrent writers would
    // clobber. The new code uses metaPath + ".tmp.<pid>.<uuid>". This test
    // ensures no stray .tmp file is left behind after a successful write
    // and no shared-suffix collision could happen.
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-tmp" }));

    await Promise.all([
      writeAgentState(tempDir, "running"),
      mutateAgentMeta(tempDir, (m) => { m.codex_session_id = "rollout-tmp"; }),
      mutateAgentMeta(tempDir, (m) => { m.tag = "x"; }),
    ]);

    const { readdir } = await import("fs/promises");
    const files = await readdir(tempDir);
    const stray = files.filter((f) => f.startsWith("meta.json.tmp"));
    expect(stray).toEqual([]);
    const finalMeta = await Bun.file(metaPath).json();
    expect(finalMeta.state).toBe("running");
    expect(finalMeta.codex_session_id).toBe("rollout-tmp");
    expect(finalMeta.tag).toBe("x");
  });

  // HIGH 2 from Phase 4 review: simulate the race the new `ib write-pid`
  // subcommand prevents. The inline `bun -e readFileSync...writeFileSync`
  // in the OLD start.sh had a read-then-write window the codex SessionStart
  // hook could fall inside, losing codex_session_id. Replacing the inline
  // write with `ib write-pid` (which routes through mutateAgentMeta) closes
  // the race. This test asserts the equivalent mutator pattern is safe.
  test("HIGH 2: concurrent claude_pid write + codex_session_id write both land", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-codex01", model: "codex:gpt-5.4-mini" }));

    // Race the equivalent of: start.sh writing claude_pid via
    // `ib write-pid`, and codex SessionStart writing codex_session_id.
    // Both must land in the final file — neither is lost.
    await Promise.all([
      mutateAgentMeta(tempDir, (m) => { m.claude_pid = "12345"; }),
      mutateAgentMeta(tempDir, (m) => { m.codex_session_id = "rollout-bbb"; }),
    ]);

    const meta = await Bun.file(metaPath).json();
    expect(meta.id).toBe("agent-codex01");
    expect(meta.claude_pid).toBe("12345");
    expect(meta.codex_session_id).toBe("rollout-bbb");
  });
});

describe("isCompacting", () => {
  test("detects compacting in last 5 lines", () => {
    const output = "line1\nline2\nline3\nCompacting conversation\nline5";
    expect(isCompacting(output)).toBe(true);
  });

  test("does not detect compacting beyond last 5 lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    lines[0] = "Compacting conversation";
    expect(isCompacting(lines.join("\n"))).toBe(false);
  });

  test("strips ANSI before checking", () => {
    const output = "line1\nline2\nline3\n\x1b[32mCompacting conversation\x1b[0m\nline5";
    expect(isCompacting(output)).toBe(true);
  });
});

describe("isRateLimited", () => {
  test("detects rate_limit_error", () => {
    const lines = Array.from({ length: 14 }, (_, i) => `line${i}`);
    lines.push("rate_limit_error");
    expect(isRateLimited(lines.join("\n"))).toBe(true);
  });

  test("detects usage limit reached (case insensitive)", () => {
    const output = "line1\nline2\nUsage Limit Reached\nline4";
    expect(isRateLimited(output)).toBe(true);
  });

  test("detects hit your limit", () => {
    const output = "line1\nhit your limit\nline3";
    expect(isRateLimited(output)).toBe(true);
  });

  test("returns false when no rate limit patterns", () => {
    const output = "line1\nline2\nline3";
    expect(isRateLimited(output)).toBe(false);
  });

  test("does NOT match server-side transient throttle (routed to api_error instead)", () => {
    // "API Error: Server is temporarily limiting requests (not your usage limit)"
    // is a transient server throttle, NOT a usage-limit exhaustion. It must be
    // handled by isApiError's "please retry" backoff, not the usage-limit path.
    const output = "  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    expect(isRateLimited(output)).toBe(false);
  });
});

describe("isApiError", () => {
  test("detects Stream idle timeout (real example)", () => {
    const output = "line1\nline2\n  ⎿  API Error: Stream idle timeout - partial response received\nline4";
    expect(isApiError(output)).toBe(true);
  });

  test("detects 500 status code", () => {
    const output = "  ⎿  API Error: 500 Internal Server Error";
    expect(isApiError(output)).toBe(true);
  });

  test("detects 502 status code", () => {
    const output = "  ⎿  API Error: 502 Bad Gateway";
    expect(isApiError(output)).toBe(true);
  });

  test("detects 503 status code", () => {
    const output = "  ⎿  API Error: 503 Service Unavailable";
    expect(isApiError(output)).toBe(true);
  });

  test("detects Connection error", () => {
    const output = "  ⎿  API Error: Connection error";
    expect(isApiError(output)).toBe(true);
  });

  test("detects fetch failed", () => {
    const output = "  ⎿  API Error: fetch failed";
    expect(isApiError(output)).toBe(true);
  });

  test("detects Request was aborted", () => {
    const output = "  ⎿  API Error: Request was aborted";
    expect(isApiError(output)).toBe(true);
  });

  test("detects ETIMEDOUT", () => {
    const output = "  ⎿  API Error: ETIMEDOUT";
    expect(isApiError(output)).toBe(true);
  });

  test("detects ECONNRESET", () => {
    const output = "  ⎿  API Error: ECONNRESET";
    expect(isApiError(output)).toBe(true);
  });

  test("detects socket connection closed unexpectedly", () => {
    const output = "  ⎿  API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
    expect(isApiError(output)).toBe(true);
  });

  test("detects server-side transient throttle (not usage limit)", () => {
    const output = "  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    expect(isApiError(output)).toBe(true);
  });

  test("strips ANSI before checking", () => {
    const output = "line1\n\x1b[31m  ⎿  API Error: Stream idle timeout\x1b[0m\nline3";
    expect(isApiError(output)).toBe(true);
  });

  test("returns false on plain text without API Error marker", () => {
    const output = "line1\nline2\nrunning some task\nline4";
    expect(isApiError(output)).toBe(false);
  });

  test("returns false when 'API Error' lacks ⎿ marker (avoids quoting false-positive)", () => {
    // Watchdog nudge that quotes the phrase shouldn't re-fire detection.
    const output = "[watchdog] previous tick observed an API Error: Stream idle timeout — see log";
    expect(isApiError(output)).toBe(false);
  });

  test("returns false when API Error marker present but no recovery-eligible variant matches", () => {
    // Conservative — unknown shapes should NOT match so we don't loop on
    // things we don't know how to recover from.
    const output = "  ⎿  API Error: invalid_request_error - prompt too long";
    expect(isApiError(output)).toBe(false);
  });

  test("only inspects last 15 lines", () => {
    // API Error far above the window — should NOT be detected.
    const oldLines = Array.from({ length: 20 }, () => "filler");
    const output = ["  ⎿  API Error: Stream idle timeout", ...oldLines].join("\n");
    expect(isApiError(output)).toBe(false);
  });

  test("detects retry-countdown line after API Error scrolls out", () => {
    // Real-world capture: original ⎿ API Error line has scrolled out of the
    // last-15 window; only the watchdog nudge + retry countdown remain.
    const output = [
      "❯ [sent by watchdog]: please retry",
      "  ⎿  Retrying in 35s · attempt 9/10",
    ].join("\n");
    expect(isApiError(output)).toBe(true);
  });

  test("detects retry-countdown with single-digit attempt", () => {
    const output = "  ⎿  Retrying in 5s · attempt 1/10";
    expect(isApiError(output)).toBe(true);
  });

  test("returns false on empty input", () => {
    expect(isApiError("")).toBe(false);
  });
});

describe("isApiErrorRateLimited", () => {
  test("detects the server-side rate-limit variant", () => {
    const output = "  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    expect(isApiErrorRateLimited(output)).toBe(true);
  });

  test("returns false for Stream idle timeout (non-rate-limited variant)", () => {
    const output = "  ⎿  API Error: Stream idle timeout - partial response received";
    expect(isApiErrorRateLimited(output)).toBe(false);
  });

  test("returns false for 5xx api_error variants", () => {
    expect(isApiErrorRateLimited("  ⎿  API Error: 500 Internal Server Error")).toBe(false);
    expect(isApiErrorRateLimited("  ⎿  API Error: 502 Bad Gateway")).toBe(false);
    expect(isApiErrorRateLimited("  ⎿  API Error: 503 Service Unavailable")).toBe(false);
  });

  test("returns false for plain text without API Error marker", () => {
    const output = "running some task — temporarily limiting requests is just a string here";
    expect(isApiErrorRateLimited(output)).toBe(false);
  });

  test("returns false when 'API Error' lacks ⎿ marker (avoids quoting false-positive)", () => {
    // A watchdog nudge quoting the phrase should not retrigger detection.
    const output = "[watchdog] previous tick saw API Error: Server is temporarily limiting requests — see log";
    expect(isApiErrorRateLimited(output)).toBe(false);
  });

  test("returns false on empty input", () => {
    expect(isApiErrorRateLimited("")).toBe(false);
  });

  test("strips ANSI before checking", () => {
    const output = "\x1b[31m  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited\x1b[0m";
    expect(isApiErrorRateLimited(output)).toBe(true);
  });
});

describe("hasBackgroundTasks", () => {
  test("detects background task pattern", () => {
    const output = "line1\n⏵⏵ tasks · 3 running\nline3";
    expect(hasBackgroundTasks(output)).toBe(true);
  });

  test("returns false without pattern", () => {
    const output = "line1\nline2\nline3";
    expect(hasBackgroundTasks(output)).toBe(false);
  });

  test("strips ANSI before checking", () => {
    const output = "line1\n\x1b[33m⏵⏵ tasks · 2 running\x1b[0m\nline3";
    expect(hasBackgroundTasks(output)).toBe(true);
  });
});

describe("isDeadPane", () => {
  test("matches the literal 'Pane is dead' banner", () => {
    expect(isDeadPane("Pane is dead (status 0, ...)\n")).toBe(true);
  });
  test("matches when banner is on its own line in a longer pane snapshot", () => {
    const output = [
      "$ tmux capture-pane",
      "Pane is dead (status 143, signal SIGTERM)",
      "",
    ].join("\n");
    expect(isDeadPane(output)).toBe(true);
  });
  test("returns false for normal Claude output", () => {
    expect(isDeadPane("⏵⏵ accept edits on (shift+tab to cycle)")).toBe(false);
  });
  test("returns false for empty input", () => {
    expect(isDeadPane("")).toBe(false);
  });
});

// ── anyChildActive ─────────────────────────────────────────────────────────

describe("anyChildActive", () => {
  const oldEpoch = Math.floor(Date.now() / 1000) - 3600;

  test("returns true for child with meta.state === running", () => {
    const child = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "running", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(true);
  });

  test("returns true for recently created child (creating)", () => {
    const recent = Math.floor(Date.now() / 1000); // within grace period
    const child = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "waiting", created_epoch: recent } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(true);
  });

  test("returns false for child with meta.state === waiting (not recently created)", () => {
    const child = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "waiting", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(false);
  });

  test("returns false for child with meta.state === complete", () => {
    const child = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "complete", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(false);
  });

  test("skips archived children even when state === running", () => {
    const child = makeAgent({
      id: "c1",
      archived: true,
      meta: { manager: "p1", state: "running", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(false);
  });

  test("skips children whose manager field does not match", () => {
    const child = makeAgent({
      id: "c1",
      meta: { manager: "other-parent", state: "running", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(false);
  });

  test("returns true when at least one of many children is active", () => {
    const waitingChild = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "waiting", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    const runningChild = makeAgent({
      id: "c2",
      meta: { manager: "p1", state: "running", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [waitingChild, runningChild])).toBe(true);
  });

  test("returns false when allAgents is empty", () => {
    expect(anyChildActive("p1", [])).toBe(false);
  });
});

// ── detectAgentStates — background-shell override ──────────────────────────

describe("detectAgentStates — waiting + background shell override", () => {
  /** Install a tmux-poller spawn runner that returns the given pane text for all capture-pane calls. */
  function installTmuxRunner(output: string | null): void {
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      if (isCapture && output === null) {
        return {
          stdout: new ReadableStream({
            start(c) { c.close(); },
          }),
          stderr: new ReadableStream({ start(c) { c.close(); } }),
          exited: Promise.resolve(1), // non-zero → captureTmuxOutput returns null
        };
      }
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? (output ?? "") : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    // The 'complete' fast-path now verifies claude_pid liveness — stub alive
    // so existing assertions (which use makeAgent's default claude_pid) still
    // resolve through that path.
    isPidAliveCtx.set(() => true);
    // The 'complete' fast-path also verifies the tmux session is alive —
    // stub the live-session set to include the test session name.
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
  }

  afterEach(() => {
    tmuxPollerSpawnCtx.reset();
    isPidAliveCtx.reset();
    liveTmuxSessionsCtx.reset();
  });

  test("waiting + bg shell → running", async () => {
    installTmuxRunner("⏵⏵ accept edits on · 1 shell");
    const a = makeAgent({
      id: "a1",
      meta: { state: "waiting", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("running");
  });

  test("waiting + no bg shell → waiting", async () => {
    installTmuxRunner("⏵⏵ accept edits on (shift+tab to cycle)");
    const a = makeAgent({
      id: "a1",
      meta: { state: "waiting", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("waiting");
  });

  test("complete + bg shell → complete (not overridden)", async () => {
    installTmuxRunner("⏵⏵ accept edits on · 1 shell");
    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("complete");
  });

  test("running + bg shell → running (unchanged)", async () => {
    installTmuxRunner("⏵⏵ accept edits on · 1 shell");
    const a = makeAgent({
      id: "a1",
      meta: { state: "running", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("running");
  });

  test("waiting + no tmux session → stopped (existing precedence wins)", async () => {
    installTmuxRunner(null);
    const a = makeAgent({
      id: "a1",
      meta: {
        state: "waiting",
        tmux_session: "ib-a1",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
  });
});

// ── detectAgentStates — complete agent fast-path (Change A) ────────────────

describe("detectAgentStates — 'complete' agents skip capture-pane", () => {
  afterEach(() => {
    tmuxPollerSpawnCtx.reset();
    isPidAliveCtx.reset();
    liveTmuxSessionsCtx.reset();
  });

  test("complete agent with tmux session does not invoke captureTmuxOutput", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1", claude_pid: "12345" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("complete");
    expect(captureCalls).toBe(0);
  });

  test("complete agent with dead claude_pid → stopped", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1", claude_pid: "12345" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
    expect(captureCalls).toBe(0);
  });

  test("complete agent with empty claude_pid trusts meta.state (legacy)", async () => {
    let pidChecks = 0;
    isPidAliveCtx.set(() => {
      pidChecks++;
      return false;
    });
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1", claude_pid: "" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("complete");
    expect(pidChecks).toBe(0);
  });

  test("complete agent with live PID but dead tmux session → stopped", async () => {
    // Bug fix: Claude can outlive its tmux session if the tmux server is
    // killed/restarted — the process becomes orphaned, attached to a regular
    // tty. PID alone passes liveness, but the user sees no working pane.
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => true);
    // tmux session list is empty — session "ib-a1" is gone
    liveTmuxSessionsCtx.set(async () => new Set([]));

    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1", claude_pid: "12345" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
    expect(captureCalls).toBe(0);
  });

  test("no complete agents — does not invoke listTmuxSessions", async () => {
    let liveCalls = 0;
    liveTmuxSessionsCtx.set(async () => {
      liveCalls++;
      return new Set();
    });
    isPidAliveCtx.set(() => true);
    tmuxPollerSpawnCtx.set(((_args: any[]) => ({
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("⏵⏵ accept edits on")); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
    })) as any);

    const a = makeAgent({
      id: "a1",
      meta: { state: "running", tmux_session: "ib-a1", claude_pid: "12345" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(liveCalls).toBe(0);
  });

  test("complete agent with no tmux session resolves to 'stopped' (existing path)", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    const a = makeAgent({
      id: "a1",
      meta: {
        state: "complete",
        tmux_session: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
    expect(captureCalls).toBe(0);
  });

  test("running agent still invokes captureTmuxOutput (no regression)", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      if (isCapture) captureCalls++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? "ordinary output\n" : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    const a = makeAgent({
      id: "a1",
      meta: { state: "running", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });
});

// ── detectAgentStates — slow worktree spawn (no tmux + spawn log) ──────────

describe("detectAgentStates — no tmux_session falls back to spawn log", () => {
  afterEach(() => {
    classifySpawnLogCtx.reset();
    nowMsCtx.reset();
  });

  test("no tmux + in_progress spawn within window → creating", async () => {
    classifySpawnLogCtx.set(async () => ({
      kind: "in_progress",
      startEpochMs: Date.now() - 30_000,
    }));
    const a = makeAgent({
      id: "a1",
      meta: {
        // Past 6s grace — without spawn log fallback, would resolve to "stopped".
        tmux_session: "",
        created_epoch: Math.floor(Date.now() / 1000) - 60,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("creating");
  });

  test("no tmux + spawn log orphan + old created_epoch → stopped", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    const a = makeAgent({
      id: "a1",
      meta: {
        tmux_session: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
  });

  test("no tmux + spawn log orphan + recent created_epoch → creating (6s grace fast path)", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    const a = makeAgent({
      id: "a1",
      meta: {
        tmux_session: "",
        // Within 6s grace — preserves existing fast path when spawn log absent.
        created_epoch: Math.floor(Date.now() / 1000) - 1,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("creating");
  });

  test("no tmux + spawn log orphan + old created_epoch (no in-progress signal) → stopped", async () => {
    // Same as case 2 but framed as the auto-recovery scenario: spawn died
    // (5-minute window expired or terminator written), and the agent is no
    // longer recently created — should resolve to "stopped".
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    const a = makeAgent({
      id: "a1",
      meta: {
        tmux_session: "",
        created_epoch: Math.floor(Date.now() / 1000) - SPAWN_IN_PROGRESS_WINDOW_MS / 1000 - 60,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
  });
});

// ── detectAgentStates — orphan Claude PID reaping ─────────────────────────

describe("detectAgentStates — reapOrphanedClaude", () => {
  let tmpLogDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "orphan-kill-log-"));
    logPath = join(tmpLogDir, "watch.log");
    resetReapedTmuxSessions();
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
  });

  afterEach(async () => {
    classifySpawnLogCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    liveTmuxSessionsCtx.reset();
    tmuxPollerSpawnCtx.reset();
    resetReapedTmuxSessions();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  test("no tmux_session + live PID + not creating → SIGTERMs PID and logs", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toEqual([{ pid: 12345, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM sent");
    expect(log).toContain("kind=claude");
    expect(log).toContain("pid=12345");
    expect(log).toContain("agent=");
    expect(log).toContain("agent-1");
    expect(log).toContain("state=stopped");
  });

  test("no tmux_session + live PID but resolved state is 'creating' → does not kill", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        // Within 6s grace → resolves to "creating", NOT "stopped"
        created_epoch: Math.floor(Date.now() / 1000) - 1,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("creating");
    expect(killCalls).toBe(0);
  });

  test("no tmux_session + spawn log in_progress → does not kill (creating path)", async () => {
    classifySpawnLogCtx.set(async () => ({
      kind: "in_progress",
      startEpochMs: Date.now() - 10_000,
    }));
    isPidAliveCtx.set(() => true);
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 60,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("creating");
    expect(killCalls).toBe(0);
  });

  test("no tmux_session + dead PID → does not kill", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0);
  });

  test("no tmux_session + empty claude_pid → does not kill", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0);
  });

  test("complete agent with live PID but dead tmux session → SIGTERMs and logs", async () => {
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set([])); // tmux session "ib-a1" is gone
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "complete",
        tmux_session: "ib-a1",
        claude_pid: "12345",
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toEqual([{ pid: 12345, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM sent");
    expect(log).toContain("pid=12345");
    expect(log).toContain("tmux=ib-a1");
    expect(log).toContain("complete agent: tmux session gone");
  });

  test("running agent + tmux capture returns null + live PID → SIGTERMs and logs", async () => {
    // Tmux capture returning null means the session disappeared mid-tick.
    // Stub spawn so capture-pane fails.
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        // capture-pane → exit 1 so captureTmuxOutput returns null
        exited: Promise.resolve(isCapture ? 1 : 0),
      };
    }) as any);
    isPidAliveCtx.set(() => true);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toEqual([{ pid: 12345, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("tmux capture returned null");
  });

  test("kills both Claude and watchdog when transient file exists", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    // Create a real agent dir with meta.transient.json so readAgentTransient
    // returns the watchdog_pid we expect.
    const agentTmp = await mkdtemp(join(tmpdir(), "orphan-kill-agent-"));
    const agentDir = join(agentTmp, ".ittybitty", "agents", "agent-1");
    await mkdir(agentDir, { recursive: true });
    const transient: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 67890,
    };
    const { writeFile } = await import("fs/promises");
    await writeFile(join(agentDir, "meta.transient.json"), JSON.stringify(transient));

    const a = makeAgent({
      id: "agent-1",
      repoPath: agentTmp,
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // Both PIDs should be SIGTERMed
    expect(killCalls).toEqual([
      { pid: 12345, signal: "SIGTERM" },
      { pid: 67890, signal: "SIGTERM" },
    ]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("kind=claude");
    expect(log).toContain("pid=12345");
    expect(log).toContain("kind=watchdog");
    expect(log).toContain("pid=67890");

    await rm(agentTmp, { recursive: true, force: true });
  });

  test("kills only watchdog when claude_pid is empty", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    const agentTmp = await mkdtemp(join(tmpdir(), "orphan-kill-agent-"));
    const agentDir = join(agentTmp, ".ittybitty", "agents", "agent-1");
    await mkdir(agentDir, { recursive: true });
    const transient: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 67890,
    };
    const { writeFile } = await import("fs/promises");
    await writeFile(join(agentDir, "meta.transient.json"), JSON.stringify(transient));

    const a = makeAgent({
      id: "agent-1",
      repoPath: agentTmp,
      meta: {
        tmux_session: "",
        claude_pid: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(killCalls).toEqual([{ pid: 67890, signal: "SIGTERM" }]);

    await rm(agentTmp, { recursive: true, force: true });
  });

  test("logs SIGTERM failed when killPid returns false", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    killPidCtx.set(() => false); // simulate ESRCH/EPERM

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM failed");
  });
});

// ── detectAgentStates — claude_pid liveness gate (dead-claude detection) ────

describe("detectAgentStates — claude_pid liveness gate", () => {
  let tmpLogDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "claude-liveness-log-"));
    logPath = join(tmpLogDir, "watch.log");
    resetReapedTmuxSessions();
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
  });

  afterEach(async () => {
    classifySpawnLogCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    liveTmuxSessionsCtx.reset();
    tmuxPollerSpawnCtx.reset();
    resetReapedTmuxSessions();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  /** Install a tmux-poller spawn runner that returns the given pane text for capture-pane. */
  function installTmuxRunner(output: string, captureCalls?: { count: number }): void {
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      if (isCapture && captureCalls) captureCalls.count++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? output : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
  }

  // Test 1: regression guard for happy path — running + alive PID + alive tmux → still running
  test("running + claude_pid alive + tmux alive → state stays 'running'", async () => {
    installTmuxRunner("⏵⏵ accept edits on (shift+tab to cycle)");
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("running");
    expect(killCalls).toBe(0);
  });

  // Test 2: running + dead PID + not recently created → reaped to 'stopped'.
  // Use a transient file with an alive watchdog_pid so reapOrphanedClaude has
  // something to actually kill — that way the watch.log entry confirms the
  // reap path ran. (claude_pid itself is dead, so it doesn't get SIGTERMed.)
  test("running + claude_pid dead + NOT recently created → 'stopped' + reapOrphanedClaude called", async () => {
    // claude_pid (12345) is dead, watchdog_pid (67890) is alive
    isPidAliveCtx.set((pid) => pid === 67890);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    // Real on-disk agent dir so readAgentTransient finds the watchdog_pid
    const agentTmp = await mkdtemp(join(tmpdir(), "claude-liveness-agent-"));
    const agentDir = join(agentTmp, ".ittybitty", "agents", "agent-1");
    await mkdir(agentDir, { recursive: true });
    const transient: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: 0, // stale on purpose so the transient fast-path is skipped
      watchdog_pid: 67890,
    };
    const { writeFile } = await import("fs/promises");
    await writeFile(join(agentDir, "meta.transient.json"), JSON.stringify(transient));

    const a = makeAgent({
      id: "agent-1",
      repoPath: agentTmp,
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // claude_pid was dead → not killed. watchdog_pid was alive → SIGTERMed.
    expect(killCalls).toEqual([{ pid: 67890, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM sent");
    expect(log).toContain("kind=watchdog");
    expect(log).toContain("pid=67890");
    expect(log).toContain("claude_pid not alive");

    await rm(agentTmp, { recursive: true, force: true });
  });

  // Test 3: running + dead PID + recently created → grace window protects, stays 'running'
  test("running + claude_pid dead + IS recently created (within 6s) → unaffected, no reap", async () => {
    installTmuxRunner("⏵⏵ accept edits on (shift+tab to cycle)");
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        // Within the 6s grace window (CREATING_GRACE_PERIOD_MS)
        created_epoch: Math.floor(Date.now() / 1000) - 1,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    // The pid liveness gate is skipped during the grace window; falls
    // through to the existing logic. captureTmuxOutput returns benign
    // output, no overrides match, meta.state="running" is trusted.
    expect(a.state).toBe("running");
    expect(killCalls).toBe(0);
  });

  // Test 4: waiting + dead PID → 'stopped' (proves fix isn't scoped to 'running')
  test("waiting + claude_pid dead → 'stopped'", async () => {
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "waiting",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0); // dead PID — no kill issued
  });

  // Test 5: regression guard for the case previously handled inline in the
  // 'complete' branch — make sure removing that inner check didn't break it.
  test("complete + claude_pid dead → 'stopped'", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "complete",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(captureCalls).toBe(0); // complete fast-path still skips capture
  });

  // Regression: the user-hit case where BOTH the pid liveness gate fires
  // (dead claude_pid) AND the tmux session is a dead-pane husk. The pid
  // gate previously short-circuited before the husk-kill path could run,
  // so reapOrphanedClaude reaped the PIDs but left the husk session alive
  // (still counted by listTmuxSessions on subsequent ticks). Husk teardown
  // now happens inside reapOrphanedClaude for resolvedState === "stopped",
  // which covers this branch uniformly.
  test("running + claude_pid dead + dead-pane husk → 'stopped' + kill-session called", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false); // claude_pid is dead
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killPidCalls = 0;
    killPidCtx.set(() => { killPidCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // Husk session should have been torn down via reapOrphanedClaude.
    expect(killSessionCalls).toEqual(["=ib-a1:"]);
    // claude_pid was dead → no SIGTERM to it.
    expect(killPidCalls).toBe(0);
  });

  // Regression: detectAgentStates runs every ~2s over ALL agents. A stopped
  // agent whose meta.json still carries a stale tmux_session must not re-spawn
  // `tmux kill-session` on every tick forever. The reapedTmuxSessions memo
  // guarantees the husk is torn down AT MOST ONCE.
  test("stopped husk → kill-session called once across repeated ticks (memoized)", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false); // claude_pid is dead → resolves to stopped
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    // Three consecutive pollStates ticks over the same stopped agent.
    await detectAgentStates([a], { reap: true });
    await detectAgentStates([a], { reap: true });
    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("stopped");
    // kill-session must have fired exactly ONCE, not once per tick.
    expect(killSessionCalls).toEqual(["=ib-a1:"]);
  });

  // Regression (resume re-arm): the reapedTmuxSessions memo must be CLEARED
  // when an agent is observed alive again, so a stopped -> resume -> stopped
  // cycle re-kills the husk. `resumeAgent` re-creates the tmux session under
  // the SAME name and writes state "running"; without clear-on-alive the memo
  // still holds that name and the second stop would skip teardown, leaking a
  // husk session. We drive three ticks: stop (kill #1, memo set) -> running
  // (memo cleared via the live capture path) -> stop again (kill #2).
  test("stopped -> running -> stopped re-arms husk teardown (kill-session fires twice)", async () => {
    // phase toggles the agent between a dead husk and a live, running pane.
    let phase: "stopped" | "running" = "stopped";
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      // When stopped: capture-pane shows a dead husk pane. When running:
      // capture-pane shows a live Claude pane so detectAgentStates resolves
      // running and clears the memo.
      const paneText =
        phase === "stopped"
          ? "Pane is dead (status 0, signal SIGTERM)\n"
          : "⏵⏵ accept edits on (shift+tab to cycle)";
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? paneText : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    // claude_pid liveness tracks the phase: dead while stopped (drives the
    // husk teardown), alive while running (passes the pid gate so the live
    // capture path runs and clears the memo).
    isPidAliveCtx.set(() => phase === "running");
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    // Tick 1: stopped husk → kill #1, memo arms ib-a1.
    phase = "stopped";
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killSessionCalls).toEqual(["=ib-a1:"]);

    // Tick 2: resumed → live pane → running, memo cleared for ib-a1.
    phase = "running";
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("running");
    // No new kill-session on the running tick.
    expect(killSessionCalls).toEqual(["=ib-a1:"]);

    // Tick 3: stopped again → husk teardown re-armed → kill #2.
    phase = "stopped";
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // The core guarantee: kill-session fired a SECOND time after the resume.
    expect(killSessionCalls).toEqual(["=ib-a1:", "=ib-a1:"]);
  });

  // The memo is per-session-name: a different stopped session is still killed
  // even after another session was already reaped this run.
  test("memo is keyed per session — a different stopped session is still killed", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1", "ib-a2"]));
    killPidCtx.set(() => true);

    const a1 = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    const a2 = makeAgent({
      id: "agent-2",
      meta: {
        state: "running",
        tmux_session: "ib-a2",
        claude_pid: "23456",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a1, a2], { reap: true });
    // Re-run: neither should be re-killed.
    await detectAgentStates([a1, a2], { reap: true });

    expect(killSessionCalls.sort()).toEqual(["=ib-a1:", "=ib-a2:"]);
  });

  // Test 8: empty/legacy claude_pid → no false positive, falls through normally
  test("running + claude_pid='' (empty/legacy) + normal tmux → state follows existing logic, no reap", async () => {
    installTmuxRunner("⏵⏵ accept edits on (shift+tab to cycle)");
    // isPidAlive should never be called since claude_pid parses to NaN (≤ 0).
    let pidChecks = 0;
    isPidAliveCtx.set(() => {
      pidChecks++;
      return false;
    });
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("running");
    expect(pidChecks).toBe(0);
    expect(killCalls).toBe(0);
  });
});

// ── detectAgentStates — dead-pane (remain-on-exit) detection ───────────────

describe("detectAgentStates — dead-pane husk handling", () => {
  let tmpLogDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "dead-pane-log-"));
    logPath = join(tmpLogDir, "watch.log");
    resetReapedTmuxSessions();
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
  });

  afterEach(async () => {
    classifySpawnLogCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    liveTmuxSessionsCtx.reset();
    tmuxPollerSpawnCtx.reset();
    resetReapedTmuxSessions();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  // Test 6: dead pane + alive PID + not recently created → stopped + kill-session called
  test("running + claude_pid alive + 'Pane is dead' output + NOT recently created → 'stopped', kill-session called", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) {
        // args is ["tmux", "kill-session", "-t", "ib-a1"]
        killSessionCalls.push(String(args[3]));
      }
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              isCapture ? "Pane is dead (status 0, signal SIGTERM)\n" : ""
            ));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => true); // claude_pid still alive (zombie state)
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    const killPidCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killPidCalls.push({ pid, signal });
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // Husk session should have been torn down
    expect(killSessionCalls).toEqual(["=ib-a1:"]);
    // reapOrphanedClaude should have been invoked (alive PID → SIGTERMed)
    expect(killPidCalls).toEqual([{ pid: 12345, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM sent");
    expect(log).toContain("tmux pane is dead");
  });

  // Test 7: dead pane + recently created → creating, kill-session NOT called
  test("running + 'Pane is dead' output + IS recently created → 'creating', kill-session NOT called", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              isCapture ? "Pane is dead (status 0, ...)\n" : ""
            ));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killPidCalls = 0;
    killPidCtx.set(() => { killPidCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        // Within 6s grace window
        created_epoch: Math.floor(Date.now() / 1000) - 1,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("creating");
    expect(killSessionCalls).toEqual([]); // grace window protects husk-kill
    expect(killPidCalls).toBe(0); // reapOrphanedClaude returns early on 'creating'
  });
});

// ── readAllAgents — listTmuxSessions TTL cache (Change D) ──────────────────

describe("readAllAgents — listTmuxSessions cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-listcache-"));
    resetListTmuxSessionsCache();
  });

  afterEach(async () => {
    tmuxPollerSpawnCtx.reset();
    resetListTmuxSessionsCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("two consecutive readAllAgents within TTL invoke list-sessions only once", async () => {
    let listCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "list-sessions") listCalls++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    await readAllAgents([{ path: tempDir, name: "test-repo" }], false);
    await readAllAgents([{ path: tempDir, name: "test-repo" }], false);
    expect(listCalls).toBe(1);
  });

  test("after cache reset, list-sessions is invoked again", async () => {
    let listCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "list-sessions") listCalls++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    await readAllAgents([{ path: tempDir, name: "test-repo" }], false);
    resetListTmuxSessionsCache();
    await readAllAgents([{ path: tempDir, name: "test-repo" }], false);
    expect(listCalls).toBe(2);
  });
});

// ── readAgentTransient / writeAgentTransient ─────────────────────────────────

describe("readAgentTransient / writeAgentTransient", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-transient-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns null when meta.transient.json is missing", async () => {
    const result = await readAgentTransient(tempDir);
    expect(result).toBeNull();
  });

  test("happy path: writes data and reads it back", async () => {
    const data: TransientState = {
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: true,
      updated_at_ms: 1_700_000_000_000,
      watchdog_pid: 12345,
    };
    await writeAgentTransient(tempDir, data);
    const result = await readAgentTransient(tempDir);
    // A transient written without `operation` reads back with operation: null
    // (the back-compat default), so compare against the data plus that field.
    expect(result).toEqual({ ...data, operation: null });
  });

  test("returns null when file is malformed", async () => {
    await Bun.write(join(tempDir, "meta.transient.json"), "{ not json");
    const result = await readAgentTransient(tempDir);
    expect(result).toBeNull();
  });

  test("returns null when fields have wrong types", async () => {
    await Bun.write(
      join(tempDir, "meta.transient.json"),
      JSON.stringify({ tmux_compacting: "yes", tmux_rate_limited: false, has_background_tasks: true, updated_at_ms: 0, watchdog_pid: 1 }),
    );
    const result = await readAgentTransient(tempDir);
    expect(result).toBeNull();
  });

  test("write is atomic (.tmp + rename) — second write replaces first", async () => {
    const first: TransientState = { tmux_compacting: true, tmux_rate_limited: false, tmux_api_error: false, has_background_tasks: false, updated_at_ms: 1, watchdog_pid: 100 };
    const second: TransientState = { tmux_compacting: false, tmux_rate_limited: true, tmux_api_error: false, has_background_tasks: false, updated_at_ms: 2, watchdog_pid: 200 };
    await writeAgentTransient(tempDir, first);
    await writeAgentTransient(tempDir, second);
    expect(await readAgentTransient(tempDir)).toEqual({ ...second, operation: null });
  });

  test("deleteAgentTransient removes the file", async () => {
    const data: TransientState = { tmux_compacting: false, tmux_rate_limited: false, tmux_api_error: false, has_background_tasks: false, updated_at_ms: 1, watchdog_pid: 1 };
    await writeAgentTransient(tempDir, data);
    expect(await readAgentTransient(tempDir)).not.toBeNull();
    await deleteAgentTransient(tempDir);
    expect(await readAgentTransient(tempDir)).toBeNull();
  });

  test("deleteAgentTransient is a no-op when file is missing", async () => {
    await deleteAgentTransient(tempDir);
    expect(await readAgentTransient(tempDir)).toBeNull();
  });
});

// ── operation marker: RMW helper, set/clear, back-compat ─────────────────────

describe("updateAgentTransient / setAgentOperation / clearAgentOperation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-op-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("updateAgentTransient seeds a zeroed transient when none exists", async () => {
    await updateAgentTransient(tempDir, (cur) => ({ ...cur, watchdog_pid: 777 }));
    const result = await readAgentTransient(tempDir);
    expect(result).toEqual({
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: 0,
      watchdog_pid: 777,
      operation: null,
    });
  });

  test("updateAgentTransient is ENOENT-safe (missing dir does not throw)", async () => {
    const missing = join(tempDir, "does", "not", "exist");
    // Should not throw — best-effort.
    await updateAgentTransient(missing, (cur) => ({ ...cur, watchdog_pid: 1 }));
    expect(await readAgentTransient(missing)).toBeNull();
  });

  test("setAgentOperation writes the operation field, preserving other fields", async () => {
    await writeAgentTransient(tempDir, {
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: true,
      updated_at_ms: 42,
      watchdog_pid: 9,
    });
    const op: AgentOperation = { kind: "merging", pid: 1234, started_at_ms: 99 };
    await setAgentOperation(tempDir, op);
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toEqual(op);
    // Other fields untouched (RMW, not overwrite).
    expect(result?.tmux_compacting).toBe(true);
    expect(result?.has_background_tasks).toBe(true);
    expect(result?.updated_at_ms).toBe(42);
    expect(result?.watchdog_pid).toBe(9);
  });

  test("clearAgentOperation removes the operation, preserving other fields", async () => {
    // The marker must belong to THIS process for the compare-and-swap clear to fire.
    await setAgentOperation(tempDir, { kind: "restarting", pid: process.pid, started_at_ms: 7 });
    await updateAgentTransient(tempDir, (cur) => ({ ...cur, watchdog_pid: 321 }));
    await clearAgentOperation(tempDir);
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toBeNull();
    expect(result?.watchdog_pid).toBe(321);
  });

  test("clearAgentOperation (CAS) clears a marker owned by THIS process", async () => {
    await setAgentOperation(tempDir, { kind: "merging", pid: process.pid, started_at_ms: 7 });
    await clearAgentOperation(tempDir);
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toBeNull();
  });

  test("clearAgentOperation (CAS) does NOT clear a marker owned by a DIFFERENT pid", async () => {
    // Models the age-reclaim race: op B reclaimed an old marker (so the on-disk
    // pid is B's, not ours), then op A's late `finally` calls clearAgentOperation.
    // A must NOT wipe B's marker. Use a sentinel pid that is not this process.
    const otherPid = process.pid + 1;
    const op: AgentOperation = { kind: "restarting", pid: otherPid, started_at_ms: 7 };
    await setAgentOperation(tempDir, op);
    await clearAgentOperation(tempDir);
    const result = await readAgentTransient(tempDir);
    // The other process's marker survives unchanged.
    expect(result?.operation).toEqual(op);
  });

  test("clearAgentOperation on a removed dir does not throw (ENOENT swallowed)", async () => {
    await setAgentOperation(tempDir, { kind: "merging", pid: 5, started_at_ms: 7 });
    await rm(tempDir, { recursive: true, force: true });
    // No throw — mirrors the post-merge success path where the dir is gone.
    await clearAgentOperation(tempDir);
    expect(await readAgentTransient(tempDir)).toBeNull();
  });

  test("watchdog-style write preserves an existing operation field", async () => {
    // Simulate: merge sets the op, then the watchdog's 5s tick writes its tmux
    // snapshot via updateAgentTransient. The op must survive.
    await setAgentOperation(tempDir, { kind: "merging", pid: 100, started_at_ms: 50 });
    await updateAgentTransient(tempDir, (cur) => ({
      ...cur,
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: 5000,
      watchdog_pid: 200,
    }));
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toEqual({ kind: "merging", pid: 100, started_at_ms: 50 });
    expect(result?.tmux_compacting).toBe(true);
    expect(result?.watchdog_pid).toBe(200);
  });

  test("back-compat: transient without operation reads with operation: null", async () => {
    await Bun.write(
      join(tempDir, "meta.transient.json"),
      JSON.stringify({
        tmux_compacting: false,
        tmux_rate_limited: false,
        tmux_api_error: false,
        has_background_tasks: false,
        updated_at_ms: 1,
        watchdog_pid: 1,
      }),
    );
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toBeNull();
  });

  test("back-compat: malformed operation is ignored without failing the read", async () => {
    const cases: unknown[] = [
      "not-an-object",
      { kind: "bogus_kind", pid: 1, started_at_ms: 1 }, // invalid kind
      { kind: "merging", pid: 0, started_at_ms: 1 }, // pid not > 0
      { kind: "merging", pid: -3, started_at_ms: 1 }, // negative pid
      { kind: "merging", pid: 1, started_at_ms: 0 }, // started_at_ms not > 0
      { kind: "merging", pid: "x", started_at_ms: 1 }, // pid wrong type
      { pid: 1, started_at_ms: 1 }, // missing kind
    ];
    for (const bad of cases) {
      await Bun.write(
        join(tempDir, "meta.transient.json"),
        JSON.stringify({
          tmux_compacting: false,
          tmux_rate_limited: false,
          tmux_api_error: false,
          has_background_tasks: false,
          updated_at_ms: 1,
          watchdog_pid: 1,
          operation: bad,
        }),
      );
      const result = await readAgentTransient(tempDir);
      // The whole read still succeeds; the malformed op is treated as absent.
      expect(result).not.toBeNull();
      expect(result?.operation).toBeNull();
    }
  });

  test("a well-formed operation of each kind round-trips", async () => {
    for (const kind of ["merge_check", "merging", "restarting"] as const) {
      await setAgentOperation(tempDir, { kind, pid: 11, started_at_ms: 22 });
      const result = await readAgentTransient(tempDir);
      expect(result?.operation).toEqual({ kind, pid: 11, started_at_ms: 22 });
    }
  });
});

// ── detectAgentStates — operation op-branch (merging/restarting/op_stuck) ─────

describe("detectAgentStates — operation op-branch", () => {
  let tempDir: string;

  /** Build an agent backed by a real dir, with an explicit claude_pid. */
  async function makeOpAgent(id: string, claudePid: string): Promise<Agent> {
    const agentDir = join(tempDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    return makeAgent({
      id,
      repoPath: tempDir,
      meta: {
        state: "running",
        tmux_session: `ib-${id}`,
        created_epoch: Math.floor(Date.now() / 1000) - 60,
        claude_pid: claudePid,
      } as Partial<AgentMeta> as AgentMeta,
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-opbranch-"));
  });
  afterEach(async () => {
    isPidAliveCtx.reset();
    nowMsCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("fresh, live merging op → state=merging", async () => {
    const a = await makeOpAgent("agent-m", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true); // op holder + claude both alive
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("merging");
  });

  test("fresh, live merge_check op → state=merging (collapsed render label)", async () => {
    const a = await makeOpAgent("agent-mc", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merge_check", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("merging");
  });

  test("fresh, live restarting op → state=restarting", async () => {
    const a = await makeOpAgent("agent-r", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "restarting", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("restarting");
  });

  test("op older than OP_STUCK_TIMEOUT_MS → state=op_stuck", async () => {
    const a = await makeOpAgent("agent-old", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true); // holder alive, but op too old
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, {
      kind: "merging",
      pid: 4242,
      started_at_ms: now - OP_STUCK_TIMEOUT_MS - 1, // just past the timeout
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("op_stuck");
  });

  test("op just under OP_STUCK_TIMEOUT_MS stays merging (boundary)", async () => {
    const a = await makeOpAgent("agent-edge", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, {
      kind: "merging",
      pid: 4242,
      started_at_ms: now - OP_STUCK_TIMEOUT_MS, // exactly at the timeout → not yet stuck (> comparison)
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("merging");
  });

  test("op holder dead → state=op_stuck (even with a fresh started_at)", async () => {
    const a = await makeOpAgent("agent-deadholder", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    // claude_pid 12345 alive, op holder 4242 dead.
    isPidAliveCtx.set((pid: number) => pid !== 4242);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: now - 100 });

    await detectAgentStates([a]);
    expect(a.state).toBe("op_stuck");
  });

  // THE ORDERING REGRESSION GUARD (the showstopper):
  // A wedged merge KILLS claude_pid before removing the dir. The op-branch
  // must run ABOVE the claude_pid liveness gate. This case has a DEAD
  // claude_pid but a LIVE, fresh op holder, so the correct result is the
  // in-flight `merging` label — NOT `stopped`. If the op-branch were placed
  // below the claude_pid gate, the dead claude_pid would paint "stopped"
  // first and the op state would never be reached. (The op_stuck variant —
  // dead holder — is covered by the next test.)
  test("operation set + dead claude_pid + live holder → merging, NOT stopped (op-branch runs above the claude_pid gate)", async () => {
    const a = await makeOpAgent("agent-wedged", "99999");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    // claude_pid 99999 is DEAD; the op holder 4242 is ALIVE (the merge is
    // still grinding away in another process).
    isPidAliveCtx.set((pid: number) => pid === 4242);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("merging"); // live holder, fresh → merging, definitely not stopped
  });

  test("operation set + DEAD claude_pid + DEAD holder → op_stuck (NOT stopped)", async () => {
    const a = await makeOpAgent("agent-crashed", "99999");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    // Both the recorded claude_pid AND the op holder are dead (crash mid-merge).
    // The claude_pid gate, if it ran first, would paint "stopped"; the op-branch
    // above it must win and paint "op_stuck".
    isPidAliveCtx.set(() => false);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("op_stuck");
  });

  test("no operation + dead claude_pid still resolves to stopped (gate unchanged)", async () => {
    const a = await makeOpAgent("agent-nostop", "99999");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => false); // claude_pid dead, no op
    // No operation set.

    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
  });
});

// ── detectAgentStates — meta.transient.json fast-path ────────────────────────

describe("detectAgentStates — meta.transient.json fast-path", () => {
  let tempDir: string;
  let captureCalls: number;

  /** Mock spawn runner that counts capture-pane calls and returns plain output. */
  function installSpyCapture(output = "ordinary output\n"): void {
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      if (isCapture) captureCalls++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? output : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
  }

  /** Build an agent backed by a real .ittybitty/agents/<id>/ directory. */
  async function makeBackedAgent(id: string, metaState: "running" | "waiting" = "running"): Promise<Agent> {
    const agentDir = join(tempDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    return makeAgent({
      id,
      repoPath: tempDir,
      meta: {
        state: metaState,
        tmux_session: `ib-${id}`,
        created_epoch: Math.floor(Date.now() / 1000) - 60,
      } as Partial<AgentMeta> as AgentMeta,
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-fastpath-"));
    captureCalls = 0;
  });

  afterEach(async () => {
    tmuxPollerSpawnCtx.reset();
    isPidAliveCtx.reset();
    nowMsCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("trusts fresh transient file (watchdog alive) — no tmux capture", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-fastpath");

    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 1_000, // 1s old, fresh
      watchdog_pid: 99999,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(0);
  });

  test("trusts fresh transient with tmux_compacting → state=compacting", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-compact");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("compacting");
    expect(captureCalls).toBe(0);
  });

  test("trusts fresh transient with tmux_rate_limited → state=rate_limited", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-rl");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: true,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("rate_limited");
    expect(captureCalls).toBe(0);
  });

  test("waiting + has_background_tasks via fast-path → state=running", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-bg", "waiting");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: true,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(0);
  });

  test("falls back to tmux capture when watchdog PID is dead", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-deadwd");
    isPidAliveCtx.set(() => false);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true, // would say compacting via fast-path
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 99999,
    });

    await detectAgentStates([a]);
    // With dead watchdog, fast-path is bypassed; tmux capture sees plain output.
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });

  test("falls back when transient is older than TRANSIENT_FRESH_MS", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-stale");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true, // would say compacting via fast-path
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - TRANSIENT_FRESH_MS - 1,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });

  test("falls back when transient file is missing", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-missing");
    isPidAliveCtx.set(() => true);

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });

  test("falls back when transient.updated_at_ms is 0 (PID-only seed)", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-seed");
    isPidAliveCtx.set(() => true);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true, // would say compacting via fast-path if trusted
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: 0,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });

  test("re-reads disk snapshot every call (no in-memory caching of transient state)", async () => {
    // detectAgentStates was previously refactored to prefer a preloaded
    // `agent.transient` field over the disk read. That broke pollStates'
    // 2s polling cadence: the watcher reuses _lastAgents from a 10s-old
    // refresh() while the watchdog writes fresh disk snapshots every 5s,
    // so the in-memory copy aged out of the freshness window before disk
    // staleness ever became an issue. The fix removed Agent.transient
    // entirely; this test guards against re-introducing a memory cache
    // by verifying the disk snapshot drives the resolved state on every
    // call (no preload setup possible).
    installSpyCapture();
    const a = await makeBackedAgent("agent-disk-read");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);

    // First call: disk says rate_limited
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: true,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 12345,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("rate_limited");

    // Second call after the watchdog rewrites disk: state must follow
    // the new disk content, not the old. If detectAgentStates were
    // caching transient in-memory, it would still return rate_limited.
    await writeAgentTransient(agentDir, {
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 50,
      watchdog_pid: 12345,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("compacting");
    expect(captureCalls).toBe(0);
  });
});

// ── archive cleanup deletes meta.transient.json ─────────────────────────────

describe("archive cleanup deletes meta.transient.json", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-archive-transient-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("archiveAgent deletes meta.transient.json", async () => {
    const { archiveAgent } = await import("./agent-lifecycle");

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-arch");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-arch" }));
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 12345,
    });

    expect(await readAgentTransient(agentDir)).not.toBeNull();
    await archiveAgent(tempDir, "agent-arch", agentDir);
    expect(await readAgentTransient(agentDir)).toBeNull();
  });
});

// ── readAgentMeta mtime cache (Phase 2) ─────────────────────────────────────

describe("readAgentMeta mtime cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-metacache-"));
    resetReadAgentMetaCache();
  });

  afterEach(async () => {
    resetReadAgentMetaCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns same data on consecutive reads", async () => {
    const agentDir = tempDir;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-cache",
      tmux_session: "ib-agent-cache",
    }));
    const a = await readAgentMeta(agentDir);
    const b = await readAgentMeta(agentDir);
    expect(a.meta?.id).toBe("agent-cache");
    expect(b.meta?.id).toBe("agent-cache");
  });

  test("re-parses when mtime changes", async () => {
    const agentDir = tempDir;
    const path = join(agentDir, "meta.json");
    await Bun.write(path, JSON.stringify({ id: "agent-cache" }));
    const a = await readAgentMeta(agentDir);
    expect(a.meta?.tmux_session).toBe("");

    // Bump mtime by writing different content. Sleep 5ms first to ensure
    // the new mtime differs from the old one even on coarse-grained FS clocks.
    await Bun.sleep(5);
    await Bun.write(path, JSON.stringify({ id: "agent-cache", tmux_session: "ib-new" }));
    const b = await readAgentMeta(agentDir);
    expect(b.meta?.tmux_session).toBe("ib-new");
  });

  test("returns 'Missing' error when meta.json absent", async () => {
    const result = await readAgentMeta(tempDir);
    expect(result.meta).toBeNull();
    expect(result.error).toContain("Missing");
  });

  test("caller can mutate returned meta without polluting cache", async () => {
    await Bun.write(join(tempDir, "meta.json"), JSON.stringify({
      id: "agent-mut",
      tmux_session: "ib-original",
    }));
    const first = await readAgentMeta(tempDir);
    if (first.meta) first.meta.tmux_session = "ib-mutated";
    const second = await readAgentMeta(tempDir);
    expect(second.meta?.tmux_session).toBe("ib-original");
  });

  test("caller can mutate nested spawned_by without polluting cache", async () => {
    await Bun.write(join(tempDir, "meta.json"), JSON.stringify({
      id: "agent-nested",
      tmux_session: "ib-orig",
      spawned_by: { agent_id: "spawner-1", repo_path: "/orig/path" },
    }));
    const first = await readAgentMeta(tempDir);
    if (first.meta?.spawned_by) {
      first.meta.spawned_by.agent_id = "POLLUTED";
      first.meta.spawned_by.repo_path = "/polluted/path";
    }
    const second = await readAgentMeta(tempDir);
    expect(second.meta?.spawned_by?.agent_id).toBe("spawner-1");
    expect(second.meta?.spawned_by?.repo_path).toBe("/orig/path");
  });

  // copyAgentMeta replaced structuredClone for performance. The cache-HIT path
  // must keep the same isolation: mutating spawned_by on a copy returned from a
  // cache hit must not pollute a subsequent cached read, and the two returned
  // copies must not share the same object/spawned_by reference.
  test("cache-hit copies are isolated — distinct objects, mutation does not leak", async () => {
    await Bun.write(join(tempDir, "meta.json"), JSON.stringify({
      id: "agent-hit",
      tmux_session: "ib-orig",
      spawned_by: { agent_id: "spawner-1", repo_path: "/orig/path" },
    }));
    // First read = cache miss (populates cache).
    const miss = await readAgentMeta(tempDir);
    // Second read = cache hit.
    const hit1 = await readAgentMeta(tempDir);
    // Distinct top-level objects and distinct nested spawned_by objects.
    expect(hit1.meta).not.toBe(miss.meta);
    expect(hit1.meta?.spawned_by).not.toBe(miss.meta?.spawned_by);
    // Mutate the cache-hit copy's nested object.
    if (hit1.meta?.spawned_by) {
      hit1.meta.spawned_by.agent_id = "POLLUTED";
      hit1.meta.spawned_by.repo_path = "/polluted/path";
    }
    if (hit1.meta) hit1.meta.tmux_session = "ib-mutated";
    // A subsequent cache hit must still see the original canonical values.
    const hit2 = await readAgentMeta(tempDir);
    expect(hit2.meta?.spawned_by?.agent_id).toBe("spawner-1");
    expect(hit2.meta?.spawned_by?.repo_path).toBe("/orig/path");
    expect(hit2.meta?.tmux_session).toBe("ib-orig");
  });

  // FIX 3 (sync guard): copyAgentMeta must deep-copy EVERY nested mutable
  // (object/array) field of AgentMeta — a shallow spread aliases such fields
  // between the cached canonical reference and the returned copy, so a caller
  // mutation would silently pollute the cache for every later reader. This
  // test has two layers that together fail if a future nested field is added
  // without a matching deep copy in copyAgentMeta:
  //
  //  1. Compile-time: REQUIRED_DEEP_COPY is typed as a record over exactly the
  //     nested-mutable keys of AgentMeta. Adding a new object/array field to
  //     AgentMeta makes this object literal fail to typecheck until the field
  //     is listed here (and, by the reviewer's intent, deep-copied in
  //     copyAgentMeta) — caught by `bunx tsc --noEmit`.
  //  2. Runtime: every nested field is populated, read through the cache twice,
  //     and the first copy's nested fields are mutated; the second cached read
  //     must be untouched, and each nested field must be a DISTINCT object
  //     reference from the cached canonical one. A forgotten deep copy makes
  //     the references identical and the mutation leak — failing the asserts.
  test("copyAgentMeta isolates every nested AgentMeta field (deep-copy guard)", async () => {
    // Distinguish nested mutable (object/array) fields from primitive ones,
    // stripping the optional `undefined`/`null` parts of each field's type.
    type NonNull<T> = Exclude<T, null | undefined>;
    type IsNested<V> = NonNull<V> extends object ? true : false;
    type NestedMutableKeys<T> = {
      [K in keyof T]-?: IsNested<T[K]> extends true ? K : never;
    }[keyof T];

    // The author MUST list every nested-mutable AgentMeta field here. If a new
    // object/array field is added to AgentMeta, this literal stops compiling
    // ("Property '<field>' is missing") — the type-level half of the guard.
    const REQUIRED_DEEP_COPY: Record<NestedMutableKeys<AgentMeta>, true> = {
      spawned_by: true,
    };

    // Construct a meta with every known nested mutable field populated.
    const spawnedBy: SpawnedBy = { agent_id: "spawner-1", repo_path: "/orig/path" };
    await Bun.write(join(tempDir, "meta.json"), JSON.stringify({
      id: "agent-deepcopy",
      tmux_session: "ib-orig",
      spawned_by: spawnedBy,
    }));

    // First read = cache miss (populates the canonical cache entry).
    const first = await readAgentMeta(tempDir);
    expect(first.meta).not.toBeNull();

    // Every nested field on the returned copy must be a DISTINCT object from a
    // subsequent canonical read — the necessary condition for deep isolation.
    // Driven off REQUIRED_DEEP_COPY so a newly-added (and listed) field is
    // automatically exercised here too.
    const canonicalProbe = await readAgentMeta(tempDir);
    for (const key of Object.keys(REQUIRED_DEEP_COPY) as NestedMutableKeys<AgentMeta>[]) {
      const a = first.meta?.[key];
      const b = canonicalProbe.meta?.[key];
      if (a != null && typeof a === "object") {
        expect(a).not.toBe(b);
      }
    }

    // Mutate every nested field on the first copy.
    if (first.meta?.spawned_by) {
      first.meta.spawned_by.agent_id = "POLLUTED";
      first.meta.spawned_by.repo_path = "/polluted/path";
    }

    // A fresh read must see the original canonical values — no leak.
    const second = await readAgentMeta(tempDir);
    expect(second.meta?.spawned_by?.agent_id).toBe("spawner-1");
    expect(second.meta?.spawned_by?.repo_path).toBe("/orig/path");
  });

  test("invalidates cache after .tmp + rename write pattern", async () => {
    const path = join(tempDir, "meta.json");
    const tmpPath = path + ".tmp";
    await Bun.write(path, JSON.stringify({ id: "agent-rename", tmux_session: "ib-v1" }));
    const a = await readAgentMeta(tempDir);
    expect(a.meta?.tmux_session).toBe("ib-v1");

    // Sleep so the new file's mtime is observably newer than the old one.
    await Bun.sleep(5);
    // .tmp + rename is the actual production write pattern (writeAgentState,
    // writeAgentTransient). The cache must invalidate when the inode behind
    // meta.json changes via rename, not just in-place writes.
    await Bun.write(tmpPath, JSON.stringify({ id: "agent-rename", tmux_session: "ib-v2" }));
    const { rename } = await import("fs/promises");
    await rename(tmpPath, path);
    const b = await readAgentMeta(tempDir);
    expect(b.meta?.tmux_session).toBe("ib-v2");
  });
});

// Regression: inside a codex agent sandbox, process.kill(pid, 0) against a PID
// owned by another sandbox (or root) returns EPERM, not ESRCH. The previous
// catch-all branch returned `false` for EPERM and detectAgentStates resolved
// every external agent to "stopped" → reapOrphanedClaude SIGTERM'd them all.
describe("_isPidAlive — EPERM vs ESRCH classification", () => {
  let origKill: typeof process.kill;
  beforeEach(() => {
    origKill = process.kill;
  });
  afterEach(() => {
    process.kill = origKill;
  });

  test("returns true when process.kill throws EPERM (alive but unsignal-able)", () => {
    process.kill = ((_pid: number, _sig?: any) => {
      const err: any = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    }) as unknown as typeof process.kill;
    expect(_isPidAliveForTests(99999)).toBe(true);
  });

  test("returns false when process.kill throws ESRCH (no such process)", () => {
    process.kill = ((_pid: number, _sig?: any) => {
      const err: any = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    }) as unknown as typeof process.kill;
    expect(_isPidAliveForTests(99999)).toBe(false);
  });

  test("returns false for any other error code (e.g. EINVAL)", () => {
    process.kill = ((_pid: number, _sig?: any) => {
      const err: any = new Error("invalid signal");
      err.code = "EINVAL";
      throw err;
    }) as unknown as typeof process.kill;
    expect(_isPidAliveForTests(99999)).toBe(false);
  });

  test("returns true when process.kill succeeds (signal delivered, process alive)", () => {
    process.kill = ((_pid: number, _sig?: any) => true) as unknown as typeof process.kill;
    expect(_isPidAliveForTests(99999)).toBe(true);
  });
});

// Regression: read-only callers (ib list, ib roster, ib info, inject-status)
// must NOT reap. Previously detectAgentStates unconditionally SIGTERM'd any
// agent whose claude_pid looked dead — inside a codex sandbox EPERM was
// misread as dead, so every read of agent state tore down the world.
//
// reapOrphanedClaude has two visible side-effects:
//   1. SIGTERM via killPidCtx (only fires when the inner isPidAliveCtx says
//      the PID is alive)
//   2. `tmux kill-session` via tmuxPollerSpawnCtx (always fires for
//      resolvedState === "stopped" + tmux_session set, regardless of PID
//      liveness)
//
// These tests assert side-effect #2 — it's the unconditional one and the
// most direct proof that reapOrphanedClaude was (or wasn't) reached.
describe("detectAgentStates — reap option", () => {
  let tmpLogDir: string;
  let logPath: string;
  let killSessionCalls: string[];

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "reap-option-log-"));
    logPath = join(tmpLogDir, "watch.log");
    resetReapedTmuxSessions();
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
    killSessionCalls = [];
    // Stub the tmux runner so a `tmux kill-session -t <name>` invocation is
    // captured (and otherwise lets capture-pane / other commands succeed).
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv[0] === "tmux" && argv[1] === "kill-session") {
        const tIdx = argv.indexOf("-t");
        if (tIdx >= 0 && typeof argv[tIdx + 1] === "string") {
          killSessionCalls.push(argv[tIdx + 1]);
        }
      }
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
  });

  afterEach(async () => {
    classifySpawnLogCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    liveTmuxSessionsCtx.reset();
    tmuxPollerSpawnCtx.reset();
    resetReapedTmuxSessions();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  test("reap: false — does NOT call reapOrphanedClaude when claude_pid reads dead", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-2",
      meta: {
        state: "running",
        tmux_session: "ib-a2",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: false });
    // State still resolves correctly — only the reap side-effect is skipped.
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0);
    expect(killSessionCalls).toEqual([]);
  });

  test("reap: false — does NOT tear down husk tmux for complete-with-dead-session", async () => {
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set([])); // session is gone
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-3",
      meta: {
        state: "complete",
        tmux_session: "ib-a3",
        claude_pid: "12345",
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: false });
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0);
    expect(killSessionCalls).toEqual([]);
  });

  test("reap: false — does NOT reap in the no-tmux_session branch", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true); // PID looks alive → SIGTERM would fire if reaped
    const killCalls: number[] = [];
    killPidCtx.set((pid) => { killCalls.push(pid); return true; });

    const a = makeAgent({
      id: "agent-4",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: false });
    expect(a.state).toBe("stopped");
    expect(killCalls).toEqual([]);
  });

  test("reap: true — DOES reap when claude_pid reads dead (husk tmux torn down)", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-5",
      meta: {
        state: "running",
        tmux_session: "ib-a5",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    // Explicit opt-in. The husk tmux teardown is unconditional inside
    // reapOrphanedClaude when resolvedState === "stopped" and tmux_session is
    // set — proves we reached it.
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killSessionCalls).toEqual(["=ib-a5:"]);
  });

  test("default (no opts) — does NOT reap (opt-in semantics)", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-6",
      meta: {
        state: "running",
        tmux_session: "ib-a6",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    // No opts → reap defaults to false. Husk tmux must remain intact.
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
    expect(killSessionCalls).toEqual([]);
  });
});

// ── terminateProcess — canonical kill funnel ─────────────────────────────────
//
// Verifies the structural fix: every kill site outside agents.ts now routes
// through terminateProcess, which itself uses isPidAliveCtx + killPidCtx.
// The EPERM-as-alive regression — fixed in _isPidAlive — is the load-bearing
// behaviour that makes these tests meaningful.
describe("terminateProcess", () => {
  let tmpLogDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "terminate-process-log-"));
    logPath = join(tmpLogDir, "watch.log");
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
    // Make grace-period sleeps a no-op so escalation runs instantly.
    sleepMsCtx.set(async () => {});
  });

  afterEach(async () => {
    isPidAliveCtx.reset();
    killPidCtx.reset();
    sleepMsCtx.reset();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  test("happy path: PID alive → SIGTERM lands → exits in grace → killed, not escalated", async () => {
    let alive = true;
    isPidAliveCtx.set(() => alive);
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      calls.push({ pid, signal });
      if (signal === "SIGTERM") alive = false; // SIGTERM lands → process exits
      return true;
    });

    const result = await terminateProcess({
      pid: 4242,
      label: "test-claude",
      agentId: "agent-abc",
      repoName: "myrepo",
      tmuxSession: "ib-x",
    });

    expect(result).toEqual({ outcome: "term-exited", killed: true, escalated: false });
    expect(calls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[terminate] outcome=term-exited");
    expect(log).toContain("label=test-claude");
    expect(log).toContain("agent=myrepo/agent-abc");
    expect(log).toContain("pid=4242");
    expect(log).toContain("tmux=ib-x");
  });

  test("escalation: PID stays alive after SIGTERM → SIGKILL fires → killed + escalated", async () => {
    let alive = true;
    isPidAliveCtx.set(() => alive);
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      calls.push({ pid, signal });
      if (signal === "SIGKILL") alive = false; // only SIGKILL succeeds
      return true;
    });

    const result = await terminateProcess({
      pid: 1234,
      label: "stuck-proc",
      gracePeriodMs: 200, // 2 polls → fast
    });

    expect(result).toEqual({ outcome: "kill-exited", killed: true, escalated: true });
    expect(calls).toEqual([
      { pid: 1234, signal: "SIGTERM" },
      { pid: 1234, signal: "SIGKILL" },
    ]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[terminate] outcome=kill-exited");
  });

  test("already-dead: liveness probe returns false → no signal sent → not-alive", async () => {
    isPidAliveCtx.set(() => false);
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const result = await terminateProcess({ pid: 999, label: "dead" });

    expect(result).toEqual({ outcome: "not-alive", killed: true, escalated: false });
    expect(killCalls).toBe(0);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[terminate] outcome=not-alive");
  });

  // The original EPERM-as-dead bug: a sandboxed view of a foreign PID returns
  // EPERM from process.kill(pid, 0). Before the fix, callers treated EPERM as
  // "already dead" and silently skipped SIGTERM. Inject isPidAliveCtx → true
  // (mimicking the canonical _isPidAlive's EPERM-aware behaviour) and verify
  // SIGTERM is actually sent.
  test("EPERM-as-alive: probe returns true → SIGTERM IS sent (regression)", async () => {
    isPidAliveCtx.set(() => true); // stays alive throughout — escalation path
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      calls.push({ pid, signal });
      return true;
    });

    const result = await terminateProcess({
      pid: 5555,
      label: "claude",
      agentId: "agent-eperm",
      gracePeriodMs: 100,
    });

    // SIGTERM MUST have been sent — pre-fix code would have early-returned
    // with "already dead" on the same EPERM and never sent any signal.
    expect(calls).toContainEqual({ pid: 5555, signal: "SIGTERM" });
    // Final state: liveness still says alive (stub never flips) → SIGKILL
    // also fires and final outcome is kill-failed.
    expect(calls).toContainEqual({ pid: 5555, signal: "SIGKILL" });
    expect(result.escalated).toBe(true);
    expect(result.outcome).toBe("kill-failed");
  });

  test("invalid pid (NaN / 0 / negative) → no signals, not-alive outcome", async () => {
    isPidAliveCtx.set(() => true);
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const r1 = await terminateProcess({ pid: NaN, label: "bad" });
    const r2 = await terminateProcess({ pid: 0, label: "bad" });
    const r3 = await terminateProcess({ pid: -1, label: "bad" });

    expect(r1.outcome).toBe("not-alive");
    expect(r2.outcome).toBe("not-alive");
    expect(r3.outcome).toBe("not-alive");
    expect(killCalls).toBe(0);
  });

  test("term-failed: SIGTERM syscall returns false → no escalation", async () => {
    isPidAliveCtx.set(() => true);
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      calls.push({ pid, signal });
      return false; // SIGTERM fails
    });

    const result = await terminateProcess({ pid: 7777, label: "term-fail" });

    expect(result).toEqual({ outcome: "term-failed", killed: false, escalated: false });
    // No SIGKILL — escalation only happens if SIGTERM landed.
    expect(calls).toEqual([{ pid: 7777, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[terminate] outcome=term-failed");
  });
});

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
  isCompacting,
  isRateLimited,
  isApiError,
  hasBackgroundTasks,
  anyChildActive,
  detectAgentStates,
  CREATING_GRACE_PERIOD_MS,
  isRecentlyCreatedDirCtx,
  classifySpawnLogCtx,
  SPAWN_IN_PROGRESS_WINDOW_MS,
  resetListTmuxSessionsCache,
  readAgentTransient,
  writeAgentTransient,
  deleteAgentTransient,
  isPidAliveCtx,
  nowMsCtx,
  resetReadAgentMetaCache,
  TRANSIENT_FRESH_MS,
} from "./agents";
import type { TransientState } from "./agents";
import { spawnCtx as tmuxPollerSpawnCtx } from "./tmux-poller";
import type { Agent, AgentMeta, FlatEntry } from "./agents";
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
    const coord = makeAgent({ id: "coord-1", repoName: "my-repo", meta: { coordinator: true, created_epoch: now - 50 } as any });
    const regular2 = makeAgent({ id: "regular-2", repoName: "my-repo", meta: { created_epoch: now - 200 } as any });
    const roots = buildAgentTree([regular, coord, regular2]);
    // Need 2+ repos for headers to appear
    const flat = flattenAgentTree(roots, ["my-repo", "other-repo"]);

    // Coordinator should be excluded entirely — only regular agents appear
    const agentEntries = flat.filter((f): f is Extract<typeof f, { kind: "agent" }> => f.kind === "agent");
    expect(agentEntries.length).toBe(2);
    expect(agentEntries.every(e => !e.agent.meta.coordinator)).toBe(true);
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
    ]);
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(2);
    expect(agents.map((a) => a.repoName).sort()).toEqual(["repo1", "repo2"]);
  });

  test("returns orphanedTmuxSessions field (empty when no stale sessions)", async () => {
    const { orphanedTmuxSessions } = await readAllAgents([
      { path: tempDir1, name: "repo1" },
    ]);
    // orphanedTmuxSessions should be an array (may be empty depending on system state)
    expect(Array.isArray(orphanedTmuxSessions)).toBe(true);
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

  test("returns false on empty input", () => {
    expect(isApiError("")).toBe(false);
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
  }

  afterEach(() => {
    tmuxPollerSpawnCtx.reset();
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

    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("complete");
    expect(captureCalls).toBe(0);
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

    await readAllAgents([{ path: tempDir, name: "test-repo" }]);
    await readAllAgents([{ path: tempDir, name: "test-repo" }]);
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

    await readAllAgents([{ path: tempDir, name: "test-repo" }]);
    resetListTmuxSessionsCache();
    await readAllAgents([{ path: tempDir, name: "test-repo" }]);
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
    expect(result).toEqual(data);
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
    expect(await readAgentTransient(tempDir)).toEqual(second);
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

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
  hasBackgroundTasks,
  CREATING_GRACE_PERIOD_MS,
  isRecentlyCreatedDirCtx,
} from "./agents";
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

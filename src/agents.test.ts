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
} from "./agents";
import type { Agent, AgentMeta } from "./agents";

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    repoPath: "/tmp/test",
    repoName: "test",
    state: "unknown",
    age: "1m",
    archived: false,
    children: [],
    meta: {
      id: overrides.id,
      session_id: "sess-1",
      tmux_session: `tmux-${overrides.id}`,
      prompt: "test prompt",
      manager: null,
      created: "2026-03-05T00:00:00Z",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true,
      worker: false,
      yolo: false,
      model: "sonnet",
      claude_pid: "1234",
      ...(overrides.meta ?? {}),
    } as AgentMeta,
    ...overrides,
  };
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
});

describe("flattenAgentTree", () => {
  test("flat list with correct depths", () => {
    const root = makeAgent({ id: "root" });
    const child = makeAgent({ id: "child" });
    child.meta.manager = "root";

    const roots = buildAgentTree([root, child]);
    const flat = flattenAgentTree(roots);

    expect(flat.length).toBe(2);
    expect(flat[0]!.agent.id).toBe("root");
    expect(flat[0]!.depth).toBe(0);
    expect(flat[1]!.agent.id).toBe("child");
    expect(flat[1]!.depth).toBe(1);
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
    expect(flat[0]!.depth).toBe(0);
    expect(flat[1]!.depth).toBe(1);
    expect(flat[2]!.depth).toBe(2);
  });

  test("single root has no connector", () => {
    const root = makeAgent({ id: "root" });
    const roots = buildAgentTree([root]);
    const flat = flattenAgentTree(roots);
    expect(flat[0]!.connector).toBe("");
  });

  test("multiple roots get ├── and └── connectors", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const roots = buildAgentTree([a, b]);
    const flat = flattenAgentTree(roots);
    expect(flat[0]!.connector).toBe("├── ");
    expect(flat[1]!.connector).toBe("└── ");
  });

  test("child connectors use ├── and └──", () => {
    const root = makeAgent({ id: "root" });
    const c1 = makeAgent({ id: "c1" });
    c1.meta.manager = "root";
    const c2 = makeAgent({ id: "c2" });
    c2.meta.manager = "root";

    const roots = buildAgentTree([root, c1, c2]);
    const flat = flattenAgentTree(roots);
    expect(flat[0]!.connector).toBe("");       // single root
    expect(flat[1]!.connector).toBe("├── ");   // first child
    expect(flat[2]!.connector).toBe("└── ");   // last child
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
    expect(flat[0]!.connector).toBe("");
    // c1 (first child of root, not last)
    expect(flat[1]!.connector).toBe("├── ");
    // leaf (child of c1, c1 is not last sibling so prefix has │)
    expect(flat[2]!.connector).toBe("│   └── ");
    // c2 (last child of root)
    expect(flat[3]!.connector).toBe("└── ");
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
    expect(flat[0]!.connector).toBe("");           // root
    expect(flat[1]!.connector).toBe("├── ");       // a
    expect(flat[2]!.connector).toBe("│   └── ");   // a1
    expect(flat[3]!.connector).toBe("│       └── "); // a1x
    expect(flat[4]!.connector).toBe("└── ");       // b
  });
});

describe("readRepoAgents", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-agents-test-"));
  });

  afterEach(async () => {
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

  test("reports error for malformed meta.json", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-bad");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), '{"not_valid": true}');

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("missing or invalid");
  });

  test("reports error for unparseable meta.json", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-corrupt");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), "not json at all");

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("Failed to read");
  });

  test("skips directories without meta.json", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-empty");
    await mkdir(agentDir, { recursive: true });
    // No meta.json written

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(0);
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

  test("reads pending questions", async () => {
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
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
});

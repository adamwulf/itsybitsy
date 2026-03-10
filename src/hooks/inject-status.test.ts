import { test, expect, describe, afterEach } from "bun:test";
import {
  shouldInjectStatus,
  formatAgentStatus,
  buildStatusText,
  briefSummary,
  countPendingQuestions,
  checkAndUpdateHash,
} from "./inject-status";
import type { AgentDataSource } from "./inject-status";
import type { RepoEntry } from "../registry";
import type { Agent, AgentMeta } from "../agents";
import { unlink } from "node:fs/promises";

// ── Helper to create mock agents ──────────────────────────────────────────

function mockAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    repoPath: "/Users/test/project",
    repoName: "project",
    meta: {
      id: overrides.id,
      session_id: "session-1",
      tmux_session: "tmux-1",
      prompt: overrides.meta?.prompt ?? "do something",
      manager: overrides.meta?.manager ?? null,
      created: "2024-01-01T00:00:00Z",
      created_epoch: 1704067200,
      worktree: true,
      worker: overrides.meta?.worker ?? false,
      yolo: false,
      model: overrides.meta?.model ?? "opus",
      claude_pid: "12345",
    } as AgentMeta,
    state: overrides.state ?? "running",
    age: overrides.age ?? "5m",
    archived: overrides.archived ?? false,
    children: [],
    ...overrides,
  };
}

// ── shouldInjectStatus ────────────────────────────────────────────────────

describe("shouldInjectStatus", () => {
  test("skip-agent-worktree: cwd inside agent repo returns false", () => {
    expect(
      shouldInjectStatus({ cwd: "/Users/test/project/.ittybitty/agents/abc123/repo" })
    ).toBe(false);
  });

  test("skip-agent-subdir: cwd inside agent repo subdir returns false", () => {
    expect(
      shouldInjectStatus({
        cwd: "/Users/test/project/.ittybitty/agents/hook-filter/repo/src/components",
      })
    ).toBe(false);
  });

  test("inject-main-repo: cwd at project root returns true", () => {
    expect(shouldInjectStatus({ cwd: "/Users/test/project" })).toBe(true);
  });

  test("inject-ittybitty-dir-not-repo: cwd at agent dir (not /repo) returns true", () => {
    expect(
      shouldInjectStatus({ cwd: "/Users/test/project/.ittybitty/agents/abc123" })
    ).toBe(true);
  });

  test("inject for home directory", () => {
    expect(shouldInjectStatus({ cwd: "/Users/test" })).toBe(true);
  });

  test("inject for random path", () => {
    expect(shouldInjectStatus({ cwd: "/tmp/build" })).toBe(true);
  });
});

// ── formatAgentStatus ─────────────────────────────────────────────────────

describe("formatAgentStatus", () => {
  test("returns empty string for no repos", () => {
    expect(formatAgentStatus([], new Map())).toBe("");
  });

  test("shows (no agents) for repo with no agents", () => {
    const repos: RepoEntry[] = [{ path: "/Users/test/project", name: "project" }];
    const result = formatAgentStatus(repos, new Map());
    expect(result).toContain("<ittybitty-status>");
    expect(result).toContain("project: (no agents)");
    expect(result).toContain("</ittybitty-status>");
  });

  test("shows agents with state, age, and prompt", () => {
    const repos: RepoEntry[] = [{ path: "/Users/test/project", name: "project" }];
    const agents = [
      mockAgent({ id: "agent-aaa", state: "running", age: "5m" }),
      mockAgent({
        id: "agent-bbb",
        state: "complete",
        age: "12m",
        meta: { worker: true, prompt: "fix the bug" } as AgentMeta,
      }),
    ];
    const agentsByRepo = new Map([["/Users/test/project", agents]]);
    const result = formatAgentStatus(repos, agentsByRepo);

    expect(result).toContain("project:");
    expect(result).toContain("m agent-aaa [running] 5m");
    expect(result).toContain("w agent-bbb [complete] 12m");
    expect(result).toContain("fix the bug");
  });

  test("filters out archived agents", () => {
    const repos: RepoEntry[] = [{ path: "/Users/test/project", name: "project" }];
    const agents = [
      mockAgent({ id: "agent-active", state: "running", archived: false }),
      mockAgent({ id: "agent-archived", state: "stopped", archived: true }),
    ];
    const agentsByRepo = new Map([["/Users/test/project", agents]]);
    const result = formatAgentStatus(repos, agentsByRepo);

    expect(result).toContain("agent-active");
    expect(result).not.toContain("agent-archived");
  });

  test("displays unknown state as running", () => {
    const repos: RepoEntry[] = [{ path: "/Users/test/project", name: "project" }];
    const agents = [mockAgent({ id: "agent-unk", state: "unknown" })];
    const agentsByRepo = new Map([["/Users/test/project", agents]]);
    const result = formatAgentStatus(repos, agentsByRepo);

    expect(result).toContain("[running]");
    expect(result).not.toContain("[unknown]");
  });

  test("shows multiple repos", () => {
    const repos: RepoEntry[] = [
      { path: "/Users/test/project-a", name: "project-a" },
      { path: "/Users/test/project-b", name: "project-b" },
    ];
    const agentsByRepo = new Map<string, Agent[]>([
      ["/Users/test/project-a", [mockAgent({ id: "agent-a1", repoPath: "/Users/test/project-a" })]],
      ["/Users/test/project-b", [mockAgent({ id: "agent-b1", repoPath: "/Users/test/project-b" })]],
    ]);
    const result = formatAgentStatus(repos, agentsByRepo);

    expect(result).toContain("project-a:");
    expect(result).toContain("agent-a1");
    expect(result).toContain("project-b:");
    expect(result).toContain("agent-b1");
  });

  test("uses repo nickname when set", () => {
    const repos: RepoEntry[] = [{ path: "/Users/test/project", name: "project", nickname: "my-proj" }];
    const agents = [mockAgent({ id: "agent-a" })];
    const agentsByRepo = new Map([["/Users/test/project", agents]]);
    const result = formatAgentStatus(repos, agentsByRepo);

    expect(result).toContain("my-proj:");
    expect(result).not.toContain("project:");
  });

  test("truncates long prompts", () => {
    const repos: RepoEntry[] = [{ path: "/p", name: "p" }];
    const longPrompt = "a".repeat(200);
    const agents = [
      mockAgent({
        id: "agent-x",
        meta: { prompt: longPrompt } as AgentMeta,
      }),
    ];
    const agentsByRepo = new Map([["/p", agents]]);
    const result = formatAgentStatus(repos, agentsByRepo);

    // Prompt should be truncated to 80 chars
    const lines = result.split("\n");
    const agentLine = lines.find((l) => l.includes("agent-x"))!;
    // The prompt portion should not contain the full 200 chars
    expect(agentLine.length).toBeLessThan(200);
  });
});

// ── briefSummary ──────────────────────────────────────────────────────────

describe("briefSummary", () => {
  test("returns 'no agents' for empty list", () => {
    expect(briefSummary([])).toBe("no agents");
  });

  test("returns 'no agents' when all agents are archived", () => {
    const agents = [
      mockAgent({ id: "a1", state: "running", archived: true }),
      mockAgent({ id: "a2", state: "complete", archived: true }),
    ];
    expect(briefSummary(agents)).toBe("no agents");
  });

  test("counts single state correctly", () => {
    const agents = [
      mockAgent({ id: "a1", state: "running" }),
      mockAgent({ id: "a2", state: "running" }),
    ];
    expect(briefSummary(agents)).toBe("2 running");
  });

  test("counts multiple states in correct order", () => {
    const agents = [
      mockAgent({ id: "a1", state: "complete" }),
      mockAgent({ id: "a2", state: "running" }),
      mockAgent({ id: "a3", state: "waiting" }),
      mockAgent({ id: "a4", state: "running" }),
    ];
    expect(briefSummary(agents)).toBe("2 running, 1 waiting, 1 complete");
  });

  test("maps unknown state to running", () => {
    const agents = [mockAgent({ id: "a1", state: "unknown" })];
    expect(briefSummary(agents)).toBe("1 running");
  });

  test("maps compacting state to running", () => {
    const agents = [
      mockAgent({ id: "a1", state: "compacting" }),
      mockAgent({ id: "a2", state: "running" }),
    ];
    expect(briefSummary(agents)).toBe("2 running");
  });

  test("includes rate_limited and stopped", () => {
    const agents = [
      mockAgent({ id: "a1", state: "rate_limited" }),
      mockAgent({ id: "a2", state: "stopped" }),
    ];
    expect(briefSummary(agents)).toBe("1 rate_limited, 1 stopped");
  });

  test("skips archived agents", () => {
    const agents = [
      mockAgent({ id: "a1", state: "running", archived: false }),
      mockAgent({ id: "a2", state: "running", archived: true }),
    ];
    expect(briefSummary(agents)).toBe("1 running");
  });

  test("includes creating state", () => {
    const agents = [
      mockAgent({ id: "a1", state: "creating" }),
      mockAgent({ id: "a2", state: "running" }),
    ];
    expect(briefSummary(agents)).toBe("1 running, 1 creating");
  });
});

// ── briefSummary with questionCount ───────────────────────────────────────

describe("briefSummary with questionCount", () => {
  test("questionCount=0 does not include questions", () => {
    const agents = [mockAgent({ id: "a1", state: "running" })];
    expect(briefSummary(agents, 0)).toBe("1 running");
  });

  test("questionCount=2 includes '2 questions'", () => {
    const agents = [mockAgent({ id: "a1", state: "running" })];
    expect(briefSummary(agents, 2)).toBe("1 running, 2 questions");
  });

  test("questionCount=1 includes '1 question' (singular)", () => {
    const agents = [mockAgent({ id: "a1", state: "waiting" })];
    expect(briefSummary(agents, 1)).toBe("1 waiting, 1 question");
  });

  test("questions with multiple states", () => {
    const agents = [
      mockAgent({ id: "a1", state: "running" }),
      mockAgent({ id: "a2", state: "complete" }),
    ];
    expect(briefSummary(agents, 3)).toBe("1 running, 1 complete, 3 questions");
  });

  test("questions only (no active agents) still returns 'no agents'", () => {
    // questionCount is irrelevant when no active agents exist
    expect(briefSummary([], 5)).toBe("no agents");
  });
});

// ── countPendingQuestions ─────────────────────────────────────────────────

describe("countPendingQuestions", () => {
  const tmpDir = "/tmp/ib-test-questions-" + Date.now();

  afterEach(async () => {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("returns 0 when no questions file exists", async () => {
    const repos: RepoEntry[] = [{ path: tmpDir, name: "test" }];
    const agents = [mockAgent({ id: "a1", state: "running" })];
    const count = await countPendingQuestions(repos, agents);
    expect(count).toBe(0);
  });

  test("counts pending questions from active agents", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const questionsDir = join(tmpDir, ".ittybitty");
    await mkdir(questionsDir, { recursive: true });
    await writeFile(
      join(questionsDir, "user-questions.json"),
      JSON.stringify({
        questions: [
          { agent: "a1", status: "pending", question: "q1" },
          { agent: "a2", status: "pending", question: "q2" },
          { agent: "a1", status: "answered", question: "q3" },
        ],
      })
    );

    const repos: RepoEntry[] = [{ path: tmpDir, name: "test" }];
    const agents = [
      mockAgent({ id: "a1", state: "running" }),
      mockAgent({ id: "a2", state: "waiting" }),
    ];
    const count = await countPendingQuestions(repos, agents);
    expect(count).toBe(2);
  });

  test("filters out questions from archived agents", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const questionsDir = join(tmpDir, ".ittybitty");
    await mkdir(questionsDir, { recursive: true });
    await writeFile(
      join(questionsDir, "user-questions.json"),
      JSON.stringify({
        questions: [
          { agent: "a1", status: "pending", question: "q1" },
          { agent: "a2", status: "pending", question: "q2" },
        ],
      })
    );

    const repos: RepoEntry[] = [{ path: tmpDir, name: "test" }];
    const agents = [
      mockAgent({ id: "a1", state: "running", archived: false }),
      mockAgent({ id: "a2", state: "stopped", archived: true }),
    ];
    const count = await countPendingQuestions(repos, agents);
    expect(count).toBe(1);
  });

  test("filters out questions from unknown agents", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const questionsDir = join(tmpDir, ".ittybitty");
    await mkdir(questionsDir, { recursive: true });
    await writeFile(
      join(questionsDir, "user-questions.json"),
      JSON.stringify({
        questions: [
          { agent: "a1", status: "pending", question: "q1" },
          { agent: "unknown-agent", status: "pending", question: "q2" },
        ],
      })
    );

    const repos: RepoEntry[] = [{ path: tmpDir, name: "test" }];
    const agents = [mockAgent({ id: "a1", state: "running" })];
    const count = await countPendingQuestions(repos, agents);
    expect(count).toBe(1);
  });
});

// ── checkAndUpdateHash ────────────────────────────────────────────────────

describe("checkAndUpdateHash", () => {
  const testCwd = "/tmp/ib-test-hash-check";
  const cachePath = `/tmp/ib-status-hash--tmp-ib-test-hash-check`;

  afterEach(async () => {
    try {
      await unlink(cachePath);
    } catch {
      // ignore
    }
  });

  test("returns true on first call (no cache)", async () => {
    const result = await checkAndUpdateHash("some content", testCwd);
    expect(result).toBe(true);
  });

  test("returns false on second identical call", async () => {
    await checkAndUpdateHash("same content", testCwd);
    const result = await checkAndUpdateHash("same content", testCwd);
    expect(result).toBe(false);
  });

  test("returns true when content changes", async () => {
    await checkAndUpdateHash("content v1", testCwd);
    const result = await checkAndUpdateHash("content v2", testCwd);
    expect(result).toBe(true);
  });
});

// ── buildStatusText with mock provider ────────────────────────────────────

describe("buildStatusText", () => {
  test("returns empty result when no repos registered", async () => {
    const provider: AgentDataSource = {
      getRepos: async () => [],
      getAgents: async () => ({ agents: [] }),
      detectStates: async () => {},
    };
    const { text, agents, repos } = await buildStatusText(provider);
    expect(text).toBe("");
    expect(agents).toEqual([]);
    expect(repos).toEqual([]);
  });

  test("returns formatted status with agents", async () => {
    const repos: RepoEntry[] = [{ path: "/Users/test/project", name: "project" }];
    const agents = [
      mockAgent({ id: "agent-aaa", state: "running", age: "3m" }),
      mockAgent({
        id: "agent-bbb",
        state: "waiting",
        age: "10m",
        meta: { worker: true, prompt: "review code" } as AgentMeta,
      }),
    ];

    const provider: AgentDataSource = {
      getRepos: async () => repos,
      getAgents: async () => ({ agents }),
      detectStates: async () => {},
    };

    const { text, agents: returnedAgents, repos: returnedRepos } = await buildStatusText(provider);
    expect(text).toContain("<ittybitty-status>");
    expect(text).toContain("project:");
    expect(text).toContain("m agent-aaa [running] 3m");
    expect(text).toContain("w agent-bbb [waiting] 10m");
    expect(text).toContain("</ittybitty-status>");
    expect(returnedAgents).toHaveLength(2);
    expect(returnedRepos).toEqual(repos);
  });

  test("groups agents by repo correctly", async () => {
    const repos: RepoEntry[] = [
      { path: "/repo-a", name: "repo-a" },
      { path: "/repo-b", name: "repo-b" },
    ];
    const agents = [
      mockAgent({ id: "agent-1", repoPath: "/repo-a", repoName: "repo-a" }),
      mockAgent({ id: "agent-2", repoPath: "/repo-b", repoName: "repo-b" }),
    ];

    const provider: AgentDataSource = {
      getRepos: async () => repos,
      getAgents: async () => ({ agents }),
      detectStates: async () => {},
    };

    const { text } = await buildStatusText(provider);
    expect(text).toContain("repo-a:");
    expect(text).toContain("agent-1");
    expect(text).toContain("repo-b:");
    expect(text).toContain("agent-2");
  });

  test("repo with no agents shows (no agents)", async () => {
    const repos: RepoEntry[] = [{ path: "/empty", name: "empty-repo" }];

    const provider: AgentDataSource = {
      getRepos: async () => repos,
      getAgents: async () => ({ agents: [] }),
      detectStates: async () => {},
    };

    const { text } = await buildStatusText(provider);
    expect(text).toContain("empty-repo: (no agents)");
  });

  test("inject-no-cwd: falls through to inject when cwd is absent", () => {
    // When no cwd is provided, shouldInjectStatus should return true
    // (empty string doesn't match agent pattern)
    expect(shouldInjectStatus({ cwd: "" })).toBe(true);
  });
});

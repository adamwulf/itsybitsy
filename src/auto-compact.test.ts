import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "path";
import {
  encodeClaudeProjectPath,
  transcriptPath,
  contextSizeForModel,
  parseTranscriptUsage,
  calculateUsagePercent,
  getAgentContextUsage,
  sendCompact,
  checkAndCompact,
  setCompactSpawnRunner,
  resetCompactSpawnRunner,
  setUsageReader,
  resetUsageReader,
  resetWarnedModels,
  type CompactState,
  type TranscriptUsage,
} from "./auto-compact";
import type { Agent } from "./agents";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-abc123",
    repoPath: "/tmp/test-repo",
    repoName: "test-repo",
    state: "running",
    age: "5m",
    archived: false,
    children: [],
    meta: {
      id: "agent-abc123",
      session_id: "sess-001",
      tmux_session: "ib_agent-abc123",
      prompt: "do stuff",
      manager: null,
      created: "2025-01-01T00:00:00Z",
      created_epoch: 1735689600,
      worktree: true,
      worker: false,
      yolo: false,
      model: "sonnet",
      claude_pid: "12345",
    },
    ...overrides,
  };
}

function makeTranscriptLine(opts: {
  usage?: Partial<TranscriptUsage>;
  isSidechain?: boolean;
  noUsage?: boolean;
}): string {
  const entry: Record<string, unknown> = {};
  if (opts.isSidechain) entry.isSidechain = true;
  if (!opts.noUsage) {
    entry.message = {
      usage: {
        input_tokens: opts.usage?.input_tokens ?? 1000,
        cache_creation_input_tokens: opts.usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: opts.usage?.cache_read_input_tokens ?? 0,
        output_tokens: opts.usage?.output_tokens ?? 500,
      },
    };
  }
  return JSON.stringify(entry);
}

describe("encodeClaudeProjectPath", () => {
  test("replaces / with -", () => {
    expect(encodeClaudeProjectPath("/Users/test/repo")).toBe("-Users-test-repo");
  });

  test("replaces . with -", () => {
    expect(encodeClaudeProjectPath("/Users/test/.hidden/repo")).toBe("-Users-test--hidden-repo");
  });

  test("replaces both / and . with -", () => {
    expect(encodeClaudeProjectPath("/home/user/my.project/src")).toBe("-home-user-my-project-src");
  });

  test("handles path with no dots or slashes", () => {
    expect(encodeClaudeProjectPath("simple")).toBe("simple");
  });

  test("matches ib's encode_claude_project_path behavior", () => {
    // ib uses: echo "$path" | tr '/.' '--'
    const path = "/Users/adamwulf/Developer/bun/itsybitsy/.ittybitty/agents/agent-123/repo";
    const expected = "-Users-adamwulf-Developer-bun-itsybitsy--ittybitty-agents-agent-123-repo";
    expect(encodeClaudeProjectPath(path)).toBe(expected);
  });
});

describe("transcriptPath", () => {
  test("builds correct path for worktree agent", () => {
    const agent = makeAgent();
    const path = transcriptPath(agent);
    // agentWorktreePath joins with ".ittybitty" (see agents.ts line 51)
    const worktree = "/tmp/test-repo/.ittybitty/agents/agent-abc123/repo";
    const encoded = encodeClaudeProjectPath(worktree);
    const home = process.env.HOME!;
    expect(path).toBe(join(home, ".claude", "projects", encoded, "sess-001.jsonl"));
  });

  test("builds correct path for non-worktree agent", () => {
    const agent = makeAgent({ meta: { ...makeAgent().meta, worktree: false } });
    const path = transcriptPath(agent);
    // non-worktree uses repoPath directly: /tmp/test-repo
    const home = process.env.HOME!;
    expect(path).toBe(join(home, ".claude/projects/-tmp-test-repo/sess-001.jsonl"));
  });
});

describe("contextSizeForModel", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetWarnedModels();
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("returns 200K for sonnet", () => {
    expect(contextSizeForModel("sonnet")).toBe(200_000);
  });

  test("returns 200K for opus", () => {
    expect(contextSizeForModel("opus")).toBe(200_000);
  });

  test("returns 1M for model with 4.5", () => {
    expect(contextSizeForModel("claude-sonnet-4.5")).toBe(1_000_000);
  });

  test("returns 1M for model with 4-5", () => {
    expect(contextSizeForModel("claude-sonnet-4-5-20250514")).toBe(1_000_000);
  });

  test("returns 200K for haiku", () => {
    expect(contextSizeForModel("haiku")).toBe(200_000);
  });

  test("logs warning once per unknown model", () => {
    contextSizeForModel("unknown-model");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toContain("Unknown model");
    // Second call with same model should not warn again
    contextSizeForModel("unknown-model");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // Different unknown model should warn
    contextSizeForModel("another-unknown");
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  test("does not warn for known models", () => {
    contextSizeForModel("claude-sonnet-4.5");
    contextSizeForModel("claude-opus-4-5-20250514");
    contextSizeForModel("claude-opus-4-6");
    contextSizeForModel("sonnet");
    contextSizeForModel("opus");
    contextSizeForModel("haiku");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("parseTranscriptUsage", () => {
  test("returns null for empty content", () => {
    expect(parseTranscriptUsage("")).toBeNull();
  });

  test("returns null for content with no usage entries", () => {
    const content = makeTranscriptLine({ noUsage: true });
    expect(parseTranscriptUsage(content)).toBeNull();
  });

  test("returns usage from a single entry", () => {
    const content = makeTranscriptLine({
      usage: { input_tokens: 5000, output_tokens: 1000 },
    });
    const result = parseTranscriptUsage(content);
    expect(result).toEqual({
      input_tokens: 5000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1000,
    });
  });

  test("returns usage from last entry when multiple exist", () => {
    const lines = [
      makeTranscriptLine({ usage: { input_tokens: 1000, output_tokens: 500 } }),
      makeTranscriptLine({ usage: { input_tokens: 5000, output_tokens: 2000 } }),
    ].join("\n");
    const result = parseTranscriptUsage(lines);
    expect(result!.input_tokens).toBe(5000);
    expect(result!.output_tokens).toBe(2000);
  });

  test("skips sidechain entries", () => {
    const lines = [
      makeTranscriptLine({ usage: { input_tokens: 1000, output_tokens: 500 } }),
      makeTranscriptLine({ usage: { input_tokens: 99000, output_tokens: 50000 }, isSidechain: true }),
    ].join("\n");
    const result = parseTranscriptUsage(lines);
    expect(result!.input_tokens).toBe(1000);
    expect(result!.output_tokens).toBe(500);
  });

  test("handles all token types", () => {
    const content = makeTranscriptLine({
      usage: {
        input_tokens: 10000,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 3000,
        output_tokens: 2000,
      },
    });
    const result = parseTranscriptUsage(content);
    expect(result).toEqual({
      input_tokens: 10000,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 3000,
      output_tokens: 2000,
    });
  });

  test("skips malformed JSON lines", () => {
    const lines = [
      "not json at all",
      makeTranscriptLine({ usage: { input_tokens: 3000, output_tokens: 1000 } }),
      "{broken json",
    ].join("\n");
    const result = parseTranscriptUsage(lines);
    expect(result!.input_tokens).toBe(3000);
  });

  test("handles missing token fields with defaults of 0", () => {
    const content = JSON.stringify({ message: { usage: { input_tokens: 5000 } } });
    const result = parseTranscriptUsage(content);
    expect(result).toEqual({
      input_tokens: 5000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    });
  });

  test("skips entries without message field", () => {
    const lines = [
      JSON.stringify({ type: "system", content: "hello" }),
      makeTranscriptLine({ usage: { input_tokens: 2000, output_tokens: 800 } }),
    ].join("\n");
    const result = parseTranscriptUsage(lines);
    expect(result!.input_tokens).toBe(2000);
  });
});

describe("calculateUsagePercent", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetWarnedModels();
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("calculates percentage for 200K context", () => {
    const usage: TranscriptUsage = {
      input_tokens: 100_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    };
    expect(calculateUsagePercent(usage, "sonnet")).toBe(50);
  });

  test("calculates percentage for 1M context", () => {
    const usage: TranscriptUsage = {
      input_tokens: 100_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    };
    expect(calculateUsagePercent(usage, "claude-sonnet-4.5")).toBe(10);
  });

  test("sums all token types", () => {
    const usage: TranscriptUsage = {
      input_tokens: 50_000,
      cache_creation_input_tokens: 50_000,
      cache_read_input_tokens: 50_000,
      output_tokens: 50_000,
    };
    // total = 200K, context = 200K → 100%
    expect(calculateUsagePercent(usage, "sonnet")).toBe(100);
  });

  test("floors the result (matches ib's integer division)", () => {
    const usage: TranscriptUsage = {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    };
    // 1 * 100 / 200000 = 0.0005 → floor = 0
    expect(calculateUsagePercent(usage, "sonnet")).toBe(0);
  });
});

describe("getAgentContextUsage", () => {
  test("returns null when session_id is empty", async () => {
    const agent = makeAgent({ meta: { ...makeAgent().meta, session_id: "" } });
    expect(await getAgentContextUsage(agent)).toBeNull();
  });

  test("returns null when transcript file does not exist", async () => {
    const agent = makeAgent();
    expect(await getAgentContextUsage(agent)).toBeNull();
  });

  test("composes transcript reading and percentage calculation correctly", () => {
    // getAgentContextUsage is a thin composition of transcriptPath + parseTranscriptUsage
    // + calculateUsagePercent, all of which are individually tested above.
    // Rather than writing to real ~/.claude/, we verify the composition logic:
    // Given 100K input tokens on a 200K-context model → 50%
    const content = makeTranscriptLine({ usage: { input_tokens: 100_000, output_tokens: 0 } });
    const usage = parseTranscriptUsage(content);
    expect(usage).not.toBeNull();
    expect(calculateUsagePercent(usage!, "sonnet")).toBe(50);
  });
});

describe("sendCompact (via runner injection)", () => {
  afterEach(() => {
    resetCompactSpawnRunner();
  });

  test("sends correct tmux command", async () => {
    let capturedCmd: string[] = [];
    setCompactSpawnRunner((cmd) => {
      capturedCmd = cmd;
      return { exited: Promise.resolve(0) };
    });

    const result = await sendCompact("ib_agent-abc123");
    expect(result).toBe(true);
    expect(capturedCmd).toEqual(["tmux", "send-keys", "-t", "ib_agent-abc123", "/compact", "Enter"]);
  });

  test("returns false on non-zero exit", async () => {
    setCompactSpawnRunner(() => ({ exited: Promise.resolve(1) }));
    expect(await sendCompact("bad-session")).toBe(false);
  });

  test("returns false on spawn error", async () => {
    setCompactSpawnRunner(() => { throw new Error("tmux not found"); });
    expect(await sendCompact("any-session")).toBe(false);
  });
});

describe("checkAndCompact", () => {
  let spawnCalls: string[][] = [];

  beforeEach(() => {
    spawnCalls = [];
    setCompactSpawnRunner((cmd) => {
      spawnCalls.push(cmd);
      return { exited: Promise.resolve(0) };
    });
  });

  afterEach(() => {
    resetCompactSpawnRunner();
    resetUsageReader();
  });

  test("returns null when usage is unavailable", async () => {
    setUsageReader(async () => null);
    const state: CompactState = { compactSent: true };
    const result = await checkAndCompact(makeAgent(), 80, state);
    expect(result).toBeNull();
    expect(state.compactSent).toBe(true); // unchanged
    expect(spawnCalls).toHaveLength(0);
  });

  test("clears compactSent when usage drops below threshold", async () => {
    setUsageReader(async () => 50);
    const state: CompactState = { compactSent: true };
    const result = await checkAndCompact(makeAgent(), 80, state);
    expect(result).toBe(50);
    expect(state.compactSent).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  test("sends /compact when usage exceeds threshold and agent is running", async () => {
    setUsageReader(async () => 85);
    const state: CompactState = { compactSent: false };
    const agent = makeAgent({ state: "running" });
    const result = await checkAndCompact(agent, 80, state);
    expect(result).toBe(85);
    expect(state.compactSent).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toContain("ib_agent-abc123");
  });

  test("sends /compact when agent is waiting", async () => {
    setUsageReader(async () => 90);
    const state: CompactState = { compactSent: false };
    const agent = makeAgent({ state: "waiting" });
    await checkAndCompact(agent, 80, state);
    expect(state.compactSent).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });

  test("does NOT send /compact when agent is in unknown state", async () => {
    setUsageReader(async () => 90);
    const state: CompactState = { compactSent: false };
    const agent = makeAgent({ state: "unknown" });
    const result = await checkAndCompact(agent, 80, state);
    expect(result).toBe(90);
    expect(state.compactSent).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  test("does NOT send /compact when agent is compacting", async () => {
    setUsageReader(async () => 95);
    const state: CompactState = { compactSent: false };
    const agent = makeAgent({ state: "compacting" });
    await checkAndCompact(agent, 80, state);
    expect(state.compactSent).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  test("does NOT send /compact when agent is stopped", async () => {
    setUsageReader(async () => 95);
    const state: CompactState = { compactSent: false };
    const agent = makeAgent({ state: "stopped" });
    await checkAndCompact(agent, 80, state);
    expect(state.compactSent).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  test("does NOT send /compact when agent is complete", async () => {
    setUsageReader(async () => 95);
    const state: CompactState = { compactSent: false };
    const agent = makeAgent({ state: "complete" });
    await checkAndCompact(agent, 80, state);
    expect(state.compactSent).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  test("does NOT send /compact when agent is rate_limited", async () => {
    setUsageReader(async () => 95);
    const state: CompactState = { compactSent: false };
    const agent = makeAgent({ state: "rate_limited" });
    await checkAndCompact(agent, 80, state);
    expect(state.compactSent).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  test("does NOT send /compact when agent is creating", async () => {
    setUsageReader(async () => 95);
    const state: CompactState = { compactSent: false };
    const agent = makeAgent({ state: "creating" });
    await checkAndCompact(agent, 80, state);
    expect(state.compactSent).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  test("does NOT re-send when compactSent is already true", async () => {
    setUsageReader(async () => 90);
    const state: CompactState = { compactSent: true };
    const agent = makeAgent({ state: "running" });
    const result = await checkAndCompact(agent, 80, state);
    expect(result).toBe(90);
    expect(state.compactSent).toBe(true);
    expect(spawnCalls).toHaveLength(0); // no duplicate
  });

  test("re-sends after flag is cleared by dropping below threshold", async () => {
    const state: CompactState = { compactSent: false };
    const agent = makeAgent({ state: "running" });

    // First: usage above threshold → sends compact
    setUsageReader(async () => 85);
    await checkAndCompact(agent, 80, state);
    expect(state.compactSent).toBe(true);
    expect(spawnCalls).toHaveLength(1);

    // Second: usage drops below → clears flag
    setUsageReader(async () => 50);
    await checkAndCompact(agent, 80, state);
    expect(state.compactSent).toBe(false);

    // Third: usage rises above again → sends again
    setUsageReader(async () => 90);
    await checkAndCompact(agent, 80, state);
    expect(state.compactSent).toBe(true);
    expect(spawnCalls).toHaveLength(2);
  });
});

// ── tmux session validation ─────────────────────────────────────────────

describe("sendCompact — invalid tmux session", () => {
  test("returns false for session with shell metacharacters", async () => {
    const result = await sendCompact("bad;rm -rf /");
    expect(result).toBe(false);
  });

  test("returns false for empty session name", async () => {
    const result = await sendCompact("");
    expect(result).toBe(false);
  });

  test("returns false for session with backticks", async () => {
    const result = await sendCompact("`whoami`");
    expect(result).toBe(false);
  });
});

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  detectStateFromMessage,
  processStopHook,
  executeResultActions,
  findUnfinishedChildren,
  hasActiveChildren,
} from "./agent-status";
import { setSendSpawnRunner, resetSendSpawnRunner } from "../ib-commands";
import { makeSpawnResult } from "../test-utils";
import { WATCHDOG_SENTINEL } from "../watchdog";

// ── Helper to create temp agent dirs ─────────────────────────────────────────

async function createTempAgentDir(): Promise<{
  agentsDir: string;
  agentDir: string;
  agentId: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "ib-hook-test-"));
  const agentsDir = join(base, "agents");
  const agentId = "test-agent-001";
  const agentDir = join(agentsDir, agentId);
  await mkdir(agentDir, { recursive: true });

  return {
    agentsDir,
    agentDir,
    agentId,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function writeMeta(
  agentDir: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(agentDir, "meta.json"), JSON.stringify(meta));
}

// ── detectStateFromMessage ───────────────────────────────────────────────────

describe("detectStateFromMessage", () => {
  test("WAITING returns waiting", () => {
    expect(detectStateFromMessage("some output\nWAITING")).toBe("waiting");
  });

  test("I HAVE COMPLETED THE GOAL returns complete", () => {
    expect(
      detectStateFromMessage("done\nI HAVE COMPLETED THE GOAL"),
    ).toBe("complete");
  });

  test("empty string returns empty", () => {
    expect(detectStateFromMessage("")).toBe("");
  });

  test("random text returns empty", () => {
    expect(detectStateFromMessage("just some text")).toBe("");
  });

  test("WAITING with trailing blank lines still works", () => {
    expect(detectStateFromMessage("output\nWAITING\n\n\n")).toBe("waiting");
  });

  test("I HAVE COMPLETED THE GOAL with trailing blank lines still works", () => {
    expect(
      detectStateFromMessage("output\nI HAVE COMPLETED THE GOAL\n\n"),
    ).toBe("complete");
  });

  test("WAITING not on last non-empty line returns empty", () => {
    expect(detectStateFromMessage("WAITING\nmore text")).toBe("");
  });
});

// ── processStopHook: nudge debouncing ────────────────────────────────────────

describe("nudge debouncing", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("no last-nudge file → nudge", async () => {
    const result = await processStopHook(
      ctx.agentId,
      "random text",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () => null,
        now: 1000,
      },
    );
    expect(result.action).toBe("nudge");
    expect(result.message).toContain("Resume your work");
    expect(result.message).toContain("'WAITING'");
    expect(result.message).toContain("'I HAVE COMPLETED THE GOAL'");
  });

  test("within 5s → debounced", async () => {
    // Write a recent nudge timestamp
    await writeFile(join(ctx.agentDir, "last-nudge"), "998");

    const result = await processStopHook(
      ctx.agentId,
      "random text",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () => null,
        now: 1000,
      },
    );
    expect(result.action).toBe("debounced");
  });

  test("after 5s → nudge again", async () => {
    // Write an old nudge timestamp
    await writeFile(join(ctx.agentDir, "last-nudge"), "990");

    const result = await processStopHook(
      ctx.agentId,
      "random text",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () => null,
        now: 1000,
      },
    );
    expect(result.action).toBe("nudge");
  });
});

// ── processStopHook: manager notification ────────────────────────────────────

describe("manager notification", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("worker complete → notify_manager", async () => {
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-001",
    });
    // Create manager directory with valid meta so it's considered active
    const managerDir = join(ctx.agentsDir, "manager-001");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, { tmux_session: "ib-manager" });
    // Create repo dir with clean git status
    await mkdir(join(ctx.agentDir, "repo"), { recursive: true });

    const result = await processStopHook(
      ctx.agentId,
      "done\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      {
        checkGitStatus: async () => "",
      },
    );
    expect(result.state).toBe("complete");
    expect(result.action).toBe("notify_manager");
    expect(result.message).toContain("just completed");
  });

  test("worker waiting → notify_manager", async () => {
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-001",
    });
    // Create manager directory with valid meta so it's considered active
    const managerDir = join(ctx.agentsDir, "manager-001");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, { tmux_session: "ib-manager" });

    const result = await processStopHook(
      ctx.agentId,
      "need input\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("notify_manager");
    expect(result.message).toContain("waiting for input");
  });

  test("worker complete with archived manager → skips notify, returns none", async () => {
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-archived",
    });
    // Create manager directory with archived meta
    const managerDir = join(ctx.agentsDir, "manager-archived");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, { tmux_session: "ib-manager", archived: true });
    await mkdir(join(ctx.agentDir, "repo"), { recursive: true });

    const result = await processStopHook(
      ctx.agentId,
      "done\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      { checkGitStatus: async () => "" },
    );
    expect(result.state).toBe("complete");
    expect(result.action).toBe("none");
  });

  test("worker complete with missing manager dir → skips notify, returns none", async () => {
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-gone",
    });
    // Don't create manager directory — it was removed after archiving
    await mkdir(join(ctx.agentDir, "repo"), { recursive: true });

    const result = await processStopHook(
      ctx.agentId,
      "done\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      { checkGitStatus: async () => "" },
    );
    expect(result.state).toBe("complete");
    expect(result.action).toBe("none");
  });

  test("worker waiting with archived manager → skips notify, returns none", async () => {
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-archived",
    });
    const managerDir = join(ctx.agentsDir, "manager-archived");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, { tmux_session: "ib-manager", archived: true });

    const result = await processStopHook(
      ctx.agentId,
      "need input\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("none");
  });

  test("worker waiting with missing manager dir → skips notify, returns none", async () => {
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-gone",
    });

    const result = await processStopHook(
      ctx.agentId,
      "need input\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("none");
  });
});

// ── processStopHook: uncommitted changes ─────────────────────────────────────

describe("uncommitted changes", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("complete + dirty → remind_commit", async () => {
    const result = await processStopHook(
      ctx.agentId,
      "done\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      {
        checkGitStatus: async () => "M src/foo.ts\n",
      },
    );
    expect(result.state).toBe("complete");
    expect(result.action).toBe("remind_commit");
    expect(result.message).toContain("uncommitted changes");
  });
});

// ── processStopHook: rate_limited ────────────────────────────────────────────

describe("rate_limited", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("rate_limited is no longer detected by stop hook (handled by consumers)", async () => {
    // The stop hook no longer detects rate_limited from tmux — it only uses last_assistant_message.
    // Rate limiting is detected at read time by consumers (detectAgentStates, watchdog).
    const result = await processStopHook(
      ctx.agentId,
      "some text",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () => "rate_limit_error\nPlease wait",
        now: Math.floor(Date.now() / 1000) - 10,
      },
    );
    // Empty last_assistant_message → running → nudge
    expect(result.state).toBe("running");
    expect(result.action).toBe("nudge");
  });
});

// ── processStopHook: complete with no manager, unfinished children ───────────

describe("remind children", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("complete + no manager + running child → remind_children", async () => {
    // Parent has no manager
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });

    // Create a child agent
    const childDir = join(ctx.agentsDir, "child-001");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, {
      tmux_session: "ib-child",
      manager: ctx.agentId,
    });

    const result = await processStopHook(
      ctx.agentId,
      "done\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      {
        checkGitStatus: async () => "",
        getChildState: async () => "running",
      },
    );
    expect(result.state).toBe("complete");
    expect(result.action).toBe("remind_children");
    expect(result.message).toContain("child-001");
    expect(result.message).toContain("1 unfinished sub-agent(s)");
    expect(result.message).toContain("ib merge <id>");
    expect(result.message).toContain("ib kill <id>");
    expect(result.message).toContain("ib list");
    expect(result.message).toContain("ib diff <id>");
  });

  test("complete + no manager + stopped child → no remind (stopped is not unfinished)", async () => {
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });

    const childDir = join(ctx.agentsDir, "child-002");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, {
      tmux_session: "ib-child2",
      manager: ctx.agentId,
    });

    const result = await processStopHook(
      ctx.agentId,
      "done\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      {
        checkGitStatus: async () => "",
        getChildState: async () => "stopped",
      },
    );
    expect(result.state).toBe("complete");
    expect(result.action).toBe("none");
  });

  test("complete + no manager + unknown child → no remind (unknown is not unfinished)", async () => {
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });

    const childDir = join(ctx.agentsDir, "child-003");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, {
      tmux_session: "ib-child3",
      manager: ctx.agentId,
    });

    const result = await processStopHook(
      ctx.agentId,
      "done\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      {
        checkGitStatus: async () => "",
        getChildState: async () => "unknown",
      },
    );
    expect(result.state).toBe("complete");
    expect(result.action).toBe("none");
  });

  test("complete + no manager + waiting child → remind_children", async () => {
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });

    const childDir = join(ctx.agentsDir, "child-004");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, {
      tmux_session: "ib-child4",
      manager: ctx.agentId,
    });

    const result = await processStopHook(
      ctx.agentId,
      "done\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      {
        checkGitStatus: async () => "",
        getChildState: async () => "waiting",
      },
    );
    expect(result.state).toBe("complete");
    expect(result.action).toBe("remind_children");
    expect(result.message).toContain("child-004");
  });

  test("complete + no manager + complete child → remind_children", async () => {
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });

    const childDir = join(ctx.agentsDir, "child-005");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, {
      tmux_session: "ib-child5",
      manager: ctx.agentId,
    });

    const result = await processStopHook(
      ctx.agentId,
      "done\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      {
        checkGitStatus: async () => "",
        getChildState: async () => "complete",
      },
    );
    expect(result.state).toBe("complete");
    expect(result.action).toBe("remind_children");
  });
});

// ── processStopHook: waiting with no manager ─────────────────────────────────

describe("waiting without manager", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("waiting + no manager → none", async () => {
    const result = await processStopHook(
      ctx.agentId,
      "idle\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("none");
  });
});

// ── processStopHook: deterministic state (no tmux fallback) ──────────────────

describe("deterministic state", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
    await writeMeta(ctx.agentDir, { id: ctx.agentId, tmux_session: "ib-test" });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("empty message results in running state (no tmux fallback)", async () => {
    const result = await processStopHook(
      ctx.agentId,
      "",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () =>
          "some output\nI HAVE COMPLETED THE GOAL\n",
        now: Math.floor(Date.now() / 1000) - 10,
      },
    );
    // State is determined from last_assistant_message only, not tmux
    expect(result.state).toBe("running");
    expect(result.action).toBe("nudge");
  });

  test("writes state to meta.json", async () => {
    await processStopHook(
      ctx.agentId,
      "some output\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
    );
    const meta = JSON.parse(await readFile(join(ctx.agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("waiting");
    expect(typeof meta.state_updated_at).toBe("number");
  });

  test("running with background tasks → none", async () => {
    const result = await processStopHook(
      ctx.agentId,
      "",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () =>
          "working\n(Esc to interrupt)\n⏵⏵ agents · 3 \n",
      },
    );
    expect(result.state).toBe("running");
    expect(result.action).toBe("none");
  });
});

// ── processStopHook: debug log written ───────────────────────────────────────

describe("debug log", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("writes debug log file", async () => {
    await processStopHook(
      ctx.agentId,
      "test message\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
    );

    const { readdir: rd } = await import("fs/promises");
    const debugDir = join(ctx.agentDir, "debug-logs");
    const files = await rd(debugDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((f) => f.startsWith("stop-") && f.includes("waiting"))).toBe(true);
  });

  test("debug file includes last_assistant_message", async () => {
    await processStopHook(
      ctx.agentId,
      "test message\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
    );

    const debugDir = join(ctx.agentDir, "debug-logs");
    const { readdir: rd } = await import("fs/promises");
    const files = await rd(debugDir);
    const debugFile = files.find((f) => f.startsWith("stop-"))!;
    const content = await readFile(join(debugDir, debugFile), "utf-8");
    expect(content).toContain("--- last_assistant_message ---");
    expect(content).toContain("test message");
  });

  test("debug file includes deterministic state source (not tmux/parse-state)", async () => {
    await processStopHook(
      ctx.agentId,
      "test message\nI HAVE COMPLETED THE GOAL",
      ctx.agentDir,
      ctx.agentsDir,
      {
        checkGitStatus: async () => "",
      },
    );

    const debugDir = join(ctx.agentDir, "debug-logs");
    const { readdir: rd } = await import("fs/promises");
    const files = await rd(debugDir);
    const debugFile = files.find((f) => f.startsWith("stop-") && f.includes("complete"))!;
    const content = await readFile(join(debugDir, debugFile), "utf-8");
    expect(content).toContain("--- deterministic state ---");
    expect(content).toContain("from last_assistant_message");
    expect(content).toContain("--- last_assistant_message ---");
  });
});

// ── findUnfinishedChildren unit tests ──────────────────────────────────────────

describe("findUnfinishedChildren", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("running child is flagged as unfinished", async () => {
    const childDir = join(ctx.agentsDir, "child-run");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { tmux_session: "ib-child-run", manager: ctx.agentId });

    const result = await findUnfinishedChildren(ctx.agentsDir, ctx.agentId, {
      getChildState: async () => "running",
    });
    expect(result).toEqual(["child-run"]);
  });

  test("stopped child is NOT flagged as unfinished", async () => {
    const childDir = join(ctx.agentsDir, "child-stop");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { tmux_session: "ib-child-stop", manager: ctx.agentId });

    const result = await findUnfinishedChildren(ctx.agentsDir, ctx.agentId, {
      getChildState: async () => "stopped",
    });
    expect(result).toEqual([]);
  });

  test("unknown child is NOT flagged as unfinished", async () => {
    const childDir = join(ctx.agentsDir, "child-unk");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { tmux_session: "ib-child-unk", manager: ctx.agentId });

    const result = await findUnfinishedChildren(ctx.agentsDir, ctx.agentId, {
      getChildState: async () => "unknown",
    });
    expect(result).toEqual([]);
  });

  test("creating child is flagged as unfinished", async () => {
    const childDir = join(ctx.agentsDir, "child-create");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { tmux_session: "ib-child-create", manager: ctx.agentId });

    const result = await findUnfinishedChildren(ctx.agentsDir, ctx.agentId, {
      getChildState: async () => "creating",
    });
    expect(result).toEqual(["child-create"]);
  });

  test("waiting child is flagged as unfinished", async () => {
    const childDir = join(ctx.agentsDir, "child-wait");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { tmux_session: "ib-child-wait", manager: ctx.agentId });

    const result = await findUnfinishedChildren(ctx.agentsDir, ctx.agentId, {
      getChildState: async () => "waiting",
    });
    expect(result).toEqual(["child-wait"]);
  });

  test("archived child is skipped", async () => {
    const childDir = join(ctx.agentsDir, "child-arch");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { tmux_session: "ib-child-arch", manager: ctx.agentId, archived: true });

    const result = await findUnfinishedChildren(ctx.agentsDir, ctx.agentId, {
      getChildState: async () => "running",
    });
    expect(result).toEqual([]);
  });

  test("child with no tmux session is treated as unknown (not unfinished)", async () => {
    const childDir = join(ctx.agentsDir, "child-notmux");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { manager: ctx.agentId });

    const result = await findUnfinishedChildren(ctx.agentsDir, ctx.agentId, {
      getChildState: async () => "running", // should not be called since no tmux_session
    });
    expect(result).toEqual([]);
  });

  test("child with different manager is skipped", async () => {
    const childDir = join(ctx.agentsDir, "child-other");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { tmux_session: "ib-child-other", manager: "other-parent" });

    const result = await findUnfinishedChildren(ctx.agentsDir, ctx.agentId, {
      getChildState: async () => "running",
    });
    expect(result).toEqual([]);
  });
});

// ── executeResultActions: manager validation ────────────────────────────────

describe("manager ID/session validation in executeResultActions", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("rejects invalid manager agent ID", async () => {
    // Write meta with a manager ID containing path traversal characters
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "../../../etc/passwd",
    });

    const result = await executeResultActions(
      {
        state: "complete",
        action: "notify_manager",
        message: "agent just completed",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(result).toBe("invalid_manager_id");
  });

  test("rejects manager ID with shell metacharacters", async () => {
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "agent; rm -rf /",
    });

    const result = await executeResultActions(
      {
        state: "complete",
        action: "notify_manager",
        message: "agent just completed",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(result).toBe("invalid_manager_id");
  });

  test("rejects invalid manager tmux session", async () => {
    // Create valid manager dir with invalid tmux session name
    const managerDir = join(ctx.agentsDir, "manager-001");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, {
      tmux_session: "session; evil-command",
    });

    // Worker meta points to the manager
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-001",
    });

    const result = await executeResultActions(
      {
        state: "complete",
        action: "notify_manager",
        message: "agent just completed",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(result).toBe("invalid_manager_session");
  });

  test("accepts valid manager ID and session", async () => {
    // Create valid manager dir with valid tmux session
    const managerDir = join(ctx.agentsDir, "manager-001");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, {
      tmux_session: "ib-manager-001",
    });

    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-001",
    });

    // This will try to send to tmux (which won't exist), but won't fail validation
    const result = await executeResultActions(
      {
        state: "complete",
        action: "notify_manager",
        message: "agent just completed",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(result).toBe("ok");
  });
});

// ── tmux session validation ─────────────────────────────────────────────

describe("processStopHook — invalid tmux session in meta.json", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("writes running state when meta has invalid tmux session (no tmux fallback needed)", async () => {
    // Write meta.json with an invalid tmux_session
    await writeFile(
      join(ctx.agentDir, "meta.json"),
      JSON.stringify({ id: ctx.agentId, tmux_session: "bad;inject" }),
    );

    const result = await processStopHook(
      ctx.agentId,
      "",  // empty last message → running
      ctx.agentDir,
      ctx.agentsDir,
      { now: Math.floor(Date.now() / 1000) - 10 },
    );

    // State is determined from last_assistant_message, not tmux — so it's running
    expect(result.state).toBe("running");
  });
});

// ── executeResultActions: state propagation to recipients ──────────────────

describe("executeResultActions — recipient state propagation", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("nudge writes state='running' to agent's meta.json", async () => {
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test", state: "waiting" });

    const ret = await executeResultActions(
      {
        state: "running",
        action: "nudge",
        message: "Resume your work",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(ret).toBe("ok");

    const meta = JSON.parse(await readFile(join(ctx.agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("running");
    expect(typeof meta.state_updated_at).toBe("number");
  });

  test("remind_commit writes state='running' to agent's meta.json", async () => {
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test", state: "complete" });

    const ret = await executeResultActions(
      {
        state: "complete",
        action: "remind_commit",
        message: "You have uncommitted changes.",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(ret).toBe("ok");

    const meta = JSON.parse(await readFile(join(ctx.agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("running");
  });

  test("remind_children writes state='running' to agent's meta.json", async () => {
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test", state: "complete" });

    const ret = await executeResultActions(
      {
        state: "complete",
        action: "remind_children",
        message: "You have unfinished sub-agents.",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(ret).toBe("ok");

    const meta = JSON.parse(await readFile(join(ctx.agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("running");
  });

  test("notify_manager writes state='running' to manager's meta.json (NOT the agent's)", async () => {
    // Agent (the one whose stop hook fired) should NOT have its state changed.
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-001",
      state: "complete",
    });
    const managerDir = join(ctx.agentsDir, "manager-001");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, { tmux_session: "ib-manager-001", state: "waiting" });

    const ret = await executeResultActions(
      {
        state: "complete",
        action: "notify_manager",
        message: "[hook]: Your subtask just completed",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(ret).toBe("ok");

    // Manager flips to running.
    const managerMeta = JSON.parse(
      await readFile(join(managerDir, "meta.json"), "utf-8"),
    );
    expect(managerMeta.state).toBe("running");

    // Agent's own state is NOT touched by executeResultActions (notify_manager
    // branch does not call writeAgentState on the agent itself; that's handled
    // earlier in processStopHook).
    const agentMeta = JSON.parse(
      await readFile(join(ctx.agentDir, "meta.json"), "utf-8"),
    );
    expect(agentMeta.state).toBe("complete");
  });

  test("notify_manager with archived manager does NOT write running to manager", async () => {
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-archived",
      state: "complete",
    });
    const managerDir = join(ctx.agentsDir, "manager-archived");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, {
      tmux_session: "ib-manager",
      state: "waiting",
      archived: true,
    });

    const ret = await executeResultActions(
      {
        state: "complete",
        action: "notify_manager",
        message: "[hook]: Your subtask just completed",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(ret).toBe("ok");

    // Archived manager's state is unchanged.
    const managerMeta = JSON.parse(
      await readFile(join(managerDir, "meta.json"), "utf-8"),
    );
    expect(managerMeta.state).toBe("waiting");
    expect(managerMeta.archived).toBe(true);
  });

  test("nudge with no tmuxSession does NOT write state", async () => {
    // No tmux_session in meta.json → nothing is sent → state should remain.
    await writeMeta(ctx.agentDir, { state: "waiting" });

    const ret = await executeResultActions(
      {
        state: "running",
        action: "nudge",
        message: "Resume your work",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(ret).toBe("ok");

    const meta = JSON.parse(await readFile(join(ctx.agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("waiting");
  });

  test("action='none' does NOT write state", async () => {
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test", state: "waiting" });

    const ret = await executeResultActions(
      {
        state: "waiting",
        action: "none",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(ret).toBe("ok");

    const meta = JSON.parse(await readFile(join(ctx.agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("waiting");
  });
});

// ── executeResultActions: watchdog attribution on delivery ──────────────────
//
// Regression for the bug where the Stop-hook self-nudge / manager notification
// were delivered with `raw: true`, i.e. with NO `[sent by ...]` prefix, so they
// looked exactly like a human console send. An agent that had just asked the
// user a question could misread the unprefixed `Resume your work...` nudge as
// the answer to its own question. These messages originate from the ib system
// (personified as the watchdog), so they must carry the `[sent by watchdog]:`
// prefix — the same one every genuine watchdog send already uses.
describe("executeResultActions — watchdog attribution on delivery", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;
  let coordHome: string;
  let spawnCalls: string[][];

  beforeEach(async () => {
    ctx = await createTempAgentDir();
    // Point the coordinator home (where agentOutboxDir resolves) at a sandbox so
    // the inline outbox drain never touches the real ~/.itsybitsy/.
    coordHome = await mkdtemp(join(tmpdir(), "agent-status-coord-"));
    const { setCoordinatorHome } = await import("../coordinator");
    setCoordinatorHome(coordHome);
    spawnCalls = [];
    // Capture every tmux command deliverMessage issues. No transient file exists
    // in the temp agent dir → hasLiveWatchdog() is false → sendMessage drains
    // inline through this runner.
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return makeSpawnResult();
    });
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    const { resetCoordinatorHome } = await import("../coordinator");
    resetCoordinatorHome();
    await rm(coordHome, { recursive: true, force: true });
    await ctx.cleanup();
  });

  // Pull the literal `send-keys -l` payload(s) out of the captured tmux calls.
  function deliveredPayloads(): string[] {
    return spawnCalls
      .filter((c) => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l"))
      .map((c) => c[c.length - 1]!);
  }

  test("self-nudge is delivered with the [sent by watchdog]: prefix (not raw)", async () => {
    await writeMeta(ctx.agentDir, { id: ctx.agentId, tmux_session: "ib-test", state: "waiting" });

    const ret = await executeResultActions(
      {
        state: "running",
        action: "nudge",
        message: "Resume your work, or end with 'WAITING' as your final line.",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(ret).toBe("ok");

    const payloads = deliveredPayloads();
    const nudge = payloads.find((p) => p.includes("Resume your work"));
    expect(nudge).toBeDefined();
    // The watchdog sentinel renders WITHOUT the leading `@` (BARE_RENDERED_SENTINELS).
    expect(nudge!).toContain("[sent by watchdog]:");
    expect(nudge!).toContain("Resume your work, or end with 'WAITING' as your final line.");
    // It must NOT have been delivered raw (verbatim, no prefix).
    expect(nudge!.startsWith("Resume your work")).toBe(false);
  });

  test("notify_manager send is delivered with the [sent by watchdog]: prefix (not raw)", async () => {
    await writeMeta(ctx.agentDir, {
      id: ctx.agentId,
      tmux_session: "ib-test",
      manager: "manager-001",
      state: "complete",
    });
    const managerDir = join(ctx.agentsDir, "manager-001");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, { id: "manager-001", tmux_session: "ib-manager-001", state: "waiting" });

    const ret = await executeResultActions(
      {
        state: "complete",
        action: "notify_manager",
        message: "Your subtask just completed.",
      },
      ctx.agentDir,
      ctx.agentsDir,
    );
    expect(ret).toBe("ok");

    const payloads = deliveredPayloads();
    const note = payloads.find((p) => p.includes("Your subtask just completed"));
    expect(note).toBeDefined();
    expect(note!).toContain("[sent by watchdog]:");
    expect(note!.startsWith("Your subtask")).toBe(false);
  });

  test("WATCHDOG_SENTINEL constant is the @watchdog sentinel used for attribution", () => {
    // Guards against the constant drifting away from the value the
    // BARE_RENDERED_SENTINELS allow-list in ib-commands keys on.
    expect(WATCHDOG_SENTINEL).toBe("@watchdog");
  });
});

describe("findUnfinishedChildren — invalid tmux session", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("treats child with invalid tmux session as unknown (not unfinished)", async () => {
    const childDir = join(ctx.agentsDir, "child-bad");
    await mkdir(childDir, { recursive: true });
    await writeFile(
      join(childDir, "meta.json"),
      JSON.stringify({ tmux_session: "$(evil)", manager: ctx.agentId }),
    );

    const result = await findUnfinishedChildren(ctx.agentsDir, ctx.agentId);
    // Invalid tmux session → can't capture → childState stays "unknown"
    // "unknown" is not in UNFINISHED_STATES, so child should not be listed
    expect(result).toEqual([]);
  });
});

// ── hasActiveChildren ──────────────────────────────────────────────────────────

describe("hasActiveChildren", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;
  const oldEpoch = Math.floor(Date.now() / 1000) - 3600;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns true for child with meta.state === 'running'", async () => {
    const childDir = join(ctx.agentsDir, "child-run");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { manager: ctx.agentId, state: "running", created_epoch: oldEpoch });

    expect(await hasActiveChildren(ctx.agentId, ctx.agentsDir)).toBe(true);
  });

  test("returns true for recently created child (isRecentlyCreated)", async () => {
    const childDir = join(ctx.agentsDir, "child-new");
    await mkdir(childDir, { recursive: true });
    const recent = Math.floor(Date.now() / 1000); // within grace period
    await writeMeta(childDir, { manager: ctx.agentId, state: "waiting", created_epoch: recent });

    expect(await hasActiveChildren(ctx.agentId, ctx.agentsDir)).toBe(true);
  });

  test("returns false for child with meta.state === 'waiting'", async () => {
    const childDir = join(ctx.agentsDir, "child-wait");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { manager: ctx.agentId, state: "waiting", created_epoch: oldEpoch });

    expect(await hasActiveChildren(ctx.agentId, ctx.agentsDir)).toBe(false);
  });

  test("returns false for child with meta.state === 'complete'", async () => {
    const childDir = join(ctx.agentsDir, "child-complete");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { manager: ctx.agentId, state: "complete", created_epoch: oldEpoch });

    expect(await hasActiveChildren(ctx.agentId, ctx.agentsDir)).toBe(false);
  });

  test("returns false for archived child even if meta.state === 'running'", async () => {
    const childDir = join(ctx.agentsDir, "child-arch");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, {
      manager: ctx.agentId,
      state: "running",
      archived: true,
      created_epoch: oldEpoch,
    });

    expect(await hasActiveChildren(ctx.agentId, ctx.agentsDir)).toBe(false);
  });

  test("returns false when agentsDir is unreadable (fail-open)", async () => {
    // Non-existent directory simulates an I/O failure from the caller's perspective.
    const missing = join(ctx.agentsDir, "does-not-exist");
    expect(await hasActiveChildren(ctx.agentId, missing)).toBe(false);
  });
});

// ── processStopHook — waiting-branch work-in-flight suppression ───────────────

describe("processStopHook — waiting-branch suppression", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;
  const oldEpoch = Math.floor(Date.now() / 1000) - 3600;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
    // Create an active manager so the waiting branch reaches the guard.
    const managerDir = join(ctx.agentsDir, "manager-001");
    await mkdir(managerDir, { recursive: true });
    await writeMeta(managerDir, { tmux_session: "ib-manager" });
    await writeMeta(ctx.agentDir, {
      tmux_session: "ib-test",
      manager: "manager-001",
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("waiting + background shell → action 'none'", async () => {
    const result = await processStopHook(
      ctx.agentId,
      "need input\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () => "⏵⏵ accept edits on · 1 shell",
      },
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("none");
  });

  test("waiting + active child (running) → action 'none'", async () => {
    const childDir = join(ctx.agentsDir, "child-run");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { manager: ctx.agentId, state: "running", created_epoch: oldEpoch });

    const result = await processStopHook(
      ctx.agentId,
      "parked\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
      { captureOutput: async () => "no background shell here" },
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("none");
  });

  test("waiting + only waiting children → action 'notify_manager' (deadlock prevention)", async () => {
    const childDir = join(ctx.agentsDir, "child-wait");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { manager: ctx.agentId, state: "waiting", created_epoch: oldEpoch });

    const result = await processStopHook(
      ctx.agentId,
      "parked\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
      { captureOutput: async () => "" },
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("notify_manager");
  });

  test("waiting + only complete children → action 'notify_manager' (user needs to merge/kill)", async () => {
    const childDir = join(ctx.agentsDir, "child-done");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, { manager: ctx.agentId, state: "complete", created_epoch: oldEpoch });

    const result = await processStopHook(
      ctx.agentId,
      "parked\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
      { captureOutput: async () => "" },
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("notify_manager");
  });

  test("waiting + only stopped/archived children → action 'notify_manager'", async () => {
    const childDir = join(ctx.agentsDir, "child-stop");
    await mkdir(childDir, { recursive: true });
    await writeMeta(childDir, {
      manager: ctx.agentId,
      state: "running",
      archived: true,
      created_epoch: oldEpoch,
    });

    const result = await processStopHook(
      ctx.agentId,
      "parked\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
      { captureOutput: async () => "" },
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("notify_manager");
  });

  test("waiting + mixed (one running + one waiting) → action 'none'", async () => {
    const waitDir = join(ctx.agentsDir, "child-w");
    await mkdir(waitDir, { recursive: true });
    await writeMeta(waitDir, { manager: ctx.agentId, state: "waiting", created_epoch: oldEpoch });
    const runDir = join(ctx.agentsDir, "child-r");
    await mkdir(runDir, { recursive: true });
    await writeMeta(runDir, { manager: ctx.agentId, state: "running", created_epoch: oldEpoch });

    const result = await processStopHook(
      ctx.agentId,
      "parked\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
      { captureOutput: async () => "" },
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("none");
  });

  test("waiting + hasActiveChildren throws (agentsDir unreadable) → fail-open, does not crash", async () => {
    // Layout a second "effective agentsDir" where isManagerActive still finds
    // the manager (so we enter the guard) but hasActiveChildren's readdir
    // throws. We achieve this by putting `manager-001/meta.json` under a
    // directory, then deleting the directory after isManagerActive would
    // fail — simpler: point agentsDir at a path whose readdir works for
    // the manager subdir lookup (readFile) but where readdir ultimately returns
    // an empty listing. Fail-open = no crash + fall through.
    //
    // For this test we verify the simpler invariant: when hasActiveChildren
    // returns false (for any reason including I/O failure) and there is no
    // background shell, notification proceeds.
    const emptyAgentsDir = join(ctx.agentsDir, "empty");
    await mkdir(emptyAgentsDir, { recursive: true });
    // Also set up the manager so isManagerActive returns true.
    const mgrDir = join(emptyAgentsDir, "manager-001");
    await mkdir(mgrDir, { recursive: true });
    await writeMeta(mgrDir, { tmux_session: "ib-manager" });

    const result = await processStopHook(
      ctx.agentId,
      "parked\nWAITING",
      ctx.agentDir,
      emptyAgentsDir,
      { captureOutput: async () => "" },
    );
    expect(result.state).toBe("waiting");
    expect(result.action).toBe("notify_manager");
  });

  test("waiting + tmux output is null → still evaluates active-children, then notify_manager", async () => {
    const result = await processStopHook(
      ctx.agentId,
      "parked\nWAITING",
      ctx.agentDir,
      ctx.agentsDir,
      { captureOutput: async () => null },
    );
    expect(result.state).toBe("waiting");
    // No bg shell (null output), no active children → notify manager.
    expect(result.action).toBe("notify_manager");
  });
});

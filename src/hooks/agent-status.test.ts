import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  detectStateFromMessage,
  processStopHook,
  executeResultActions,
  findUnfinishedChildren,
} from "./agent-status";

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

  test("rate_limited → none", async () => {
    const result = await processStopHook(
      ctx.agentId,
      "some text",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () => "rate_limit_error\nPlease wait",
      },
    );
    expect(result.state).toBe("rate_limited");
    expect(result.action).toBe("none");
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

// ── processStopHook: tmux fallback ───────────────────────────────────────────

describe("tmux fallback", () => {
  let ctx: Awaited<ReturnType<typeof createTempAgentDir>>;

  beforeEach(async () => {
    ctx = await createTempAgentDir();
    await writeMeta(ctx.agentDir, { tmux_session: "ib-test" });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("empty message falls back to captureOutput", async () => {
    const result = await processStopHook(
      ctx.agentId,
      "",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () =>
          "some output\nI HAVE COMPLETED THE GOAL\n",
        checkGitStatus: async () => "",
      },
    );
    expect(result.state).toBe("complete");
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

  test("debug file includes tmux output and parse-state reason when tmux fallback used", async () => {
    await processStopHook(
      ctx.agentId,
      "",
      ctx.agentDir,
      ctx.agentsDir,
      {
        captureOutput: async () => "some tmux output\nI HAVE COMPLETED THE GOAL\n",
        checkGitStatus: async () => "",
      },
    );

    const debugDir = join(ctx.agentDir, "debug-logs");
    const { readdir: rd } = await import("fs/promises");
    const files = await rd(debugDir);
    const debugFile = files.find((f) => f.startsWith("stop-") && f.includes("complete"))!;
    const content = await readFile(join(debugDir, debugFile), "utf-8");
    expect(content).toContain("some tmux output");
    expect(content).toContain("--- parse-state -v output ---");
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

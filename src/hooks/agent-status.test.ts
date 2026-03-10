import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  detectStateFromMessage,
  processStopHook,
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

  test("complete + no manager + unfinished children → remind_children", async () => {
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
});

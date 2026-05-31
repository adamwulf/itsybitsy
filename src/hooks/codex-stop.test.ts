import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  deriveCodexStopState,
  hookCodexStop,
  hookCodexStopDryRun,
} from "./codex-stop";

function captureStdout(): { capture: string[]; restore: () => void } {
  const original = process.stdout.write;
  const capture: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    capture.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  return {
    capture,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

describe("deriveCodexStopState", () => {
  test("defaults to waiting when there's no last message", () => {
    expect(deriveCodexStopState()).toBe("waiting");
    expect(deriveCodexStopState("")).toBe("waiting");
  });

  test("returns complete when the message ends with the completion sentinel", () => {
    expect(deriveCodexStopState("done\nI HAVE COMPLETED THE GOAL")).toBe("complete");
  });

  test("returns waiting when the message ends with WAITING", () => {
    expect(deriveCodexStopState("paused\nWAITING")).toBe("waiting");
  });

  test("returns waiting for ordinary closing prose", () => {
    expect(deriveCodexStopState("Done with that batch — let me know what's next.")).toBe(
      "waiting",
    );
  });
});

describe("hookCodexStop — writes deterministic state", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-stop-"));
    agentDir = join(tempDir, "agent-x");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: "agent-stop01",
        model: "codex:gpt-5.4-mini",
        state: "running",
      }),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes state=waiting on a plain Stop firing", async () => {
    const { capture, restore } = captureStdout();
    try {
      await hookCodexStop("agent-stop01", {
        rawStdin: JSON.stringify({ cwd: agentDir }),
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.state).toBe("waiting");
    const parsed = JSON.parse(capture.join(""));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  });

  test("writes state=complete when the last message signals completion", async () => {
    const { restore } = captureStdout();
    try {
      await hookCodexStop("agent-stop01", {
        rawStdin: JSON.stringify({
          cwd: agentDir,
          last_assistant_message: "all clean\nI HAVE COMPLETED THE GOAL",
        }),
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.state).toBe("complete");
  });

  test("emits valid JSON and exits 0 on invalid agent id (argv parse failure)", async () => {
    const { capture, restore } = captureStdout();
    try {
      await hookCodexStop("bad id", { rawStdin: "{}" });
    } finally {
      restore();
    }
    const parsed = JSON.parse(capture.join(""));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  });

  test("emits valid JSON on malformed stdin", async () => {
    const { capture, restore } = captureStdout();
    try {
      await hookCodexStop("agent-stop01", {
        rawStdin: "{not json",
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const parsed = JSON.parse(capture.join(""));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  });
});

// ── HIGH 3 from Phase 4 review: dry-run must actually exercise the handler ──
describe("hookCodexStopDryRun — exercises real handler with synthetic payload", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let agentDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codex-stop-dryrun-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    agentDir = join(tempHome, ".ittybitty", "agents", "agent-dryrun01");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: "agent-dryrun01",
        worktree: true,
        model: "codex:gpt-5.4-mini",
        state: "running",
      }),
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("succeeds when meta.json exists", async () => {
    const origCwd = process.cwd();
    process.chdir(tempHome);
    try {
      await hookCodexStopDryRun("agent-dryrun01");
    } finally {
      process.chdir(origCwd);
    }
  });

  test("throws when meta.json is missing", async () => {
    const origCwd = process.cwd();
    process.chdir(tempHome);
    try {
      await expect(hookCodexStopDryRun("agent-missing")).rejects.toThrow(/meta\.json not found/);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("throws when agent id is invalid", async () => {
    await expect(hookCodexStopDryRun("bad agent id")).rejects.toThrow(/Invalid agent id/);
  });

  test("does NOT mutate meta.json state (skipMetaWrites is set)", async () => {
    const before = await Bun.file(join(agentDir, "meta.json")).text();
    const origCwd = process.cwd();
    process.chdir(tempHome);
    try {
      await hookCodexStopDryRun("agent-dryrun01");
    } finally {
      process.chdir(origCwd);
    }
    const after = await Bun.file(join(agentDir, "meta.json")).text();
    expect(after).toBe(before);
  });
});

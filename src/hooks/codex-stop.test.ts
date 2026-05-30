import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { deriveCodexStopState, hookCodexStop } from "./codex-stop";

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

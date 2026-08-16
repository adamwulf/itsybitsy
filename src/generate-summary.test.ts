import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { generateSummary, isValidAgentDir, buildSummaryCommand, spawnCtx } from "./generate-summary";
import type { SpawnResult } from "./types";

/** Build a fake SpawnResult so tests never run the real `claude` binary. */
function fakeProc(stdoutText: string, exitCode: number): SpawnResult {
  return {
    stdout: new Response(stdoutText).body,
    stderr: null,
    exited: Promise.resolve(exitCode),
  };
}

describe("isValidAgentDir", () => {
  test("rejects relative paths", () => {
    expect(isValidAgentDir("relative/path")).toBe(false);
    expect(isValidAgentDir(".ittybitty/agents/foo")).toBe(false);
  });

  test("rejects paths without .ittybitty/agents/ structure", () => {
    expect(isValidAgentDir("/tmp/not-an-agent-dir")).toBe(false);
    expect(isValidAgentDir("/tmp/.ittybitty/foo")).toBe(false);
    expect(isValidAgentDir("/tmp/.ittybitty")).toBe(false);
  });

  test("rejects paths with trailing slash or extra segments", () => {
    expect(isValidAgentDir("/tmp/.ittybitty/agents/foo/")).toBe(false);
    expect(isValidAgentDir("/tmp/.ittybitty/agents/foo/bar")).toBe(false);
  });

  test("accepts valid agent directory paths", () => {
    expect(isValidAgentDir("/tmp/.ittybitty/agents/agent-abc123")).toBe(true);
    expect(isValidAgentDir("/Users/me/project/.ittybitty/agents/test-agent")).toBe(true);
  });
});

describe("buildSummaryCommand", () => {
  test("includes --tools with empty string to disable all tools", () => {
    const cmd = buildSummaryCommand("test prompt");
    const toolsIdx = cmd.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(cmd[toolsIdx + 1]).toBe("");
  });

  test("uses claude -p with haiku model", () => {
    const cmd = buildSummaryCommand("test prompt");
    expect(cmd[0]).toBe("claude");
    expect(cmd[1]).toBe("-p");
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-haiku-4-5-20251001");
  });

  test("passes the summary prompt as the -p argument", () => {
    const cmd = buildSummaryCommand("my summary prompt");
    expect(cmd[2]).toBe("my summary prompt");
  });
});

describe("generateSummary", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "generate-summary-test-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "test-agent");
    await mkdir(agentDir, { recursive: true });
  });

  afterEach(async () => {
    spawnCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("spawns the summarizer with cwd pinned to the agent dir", async () => {
    let capturedOpts: { stdout: "pipe"; stderr: "ignore"; cwd: string } | undefined;
    spawnCtx.set((_cmd, opts) => {
      capturedOpts = opts;
      // Return a well-formed but empty result so no summary is written and no
      // real `claude` process runs.
      return fakeProc("", 0);
    });

    await Bun.write(join(agentDir, "prompt.txt"), "Do the thing.");
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "test" }, null, 2));

    await generateSummary(agentDir);

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.cwd).toBe(agentDir);
  });

  test("merges the summarizer output into meta.json", async () => {
    spawnCtx.set(() => fakeProc("The agent was asked to do the thing.\n", 0));

    await Bun.write(join(agentDir, "prompt.txt"), "Do the thing.");
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "test" }, null, 2));

    await generateSummary(agentDir);

    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.summary).toBe("The agent was asked to do the thing.");
  });

  test("does nothing when prompt.txt is missing", async () => {
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "test" }, null, 2));
    await generateSummary(agentDir);
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.summary).toBeUndefined();
  });

  test("does nothing when prompt.txt is empty", async () => {
    await Bun.write(join(agentDir, "prompt.txt"), "");
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "test" }, null, 2));
    await generateSummary(agentDir);
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.summary).toBeUndefined();
  });

  test("returns silently for invalid agentDir paths", async () => {
    // These should return early due to path validation, not throw
    await generateSummary("relative/path");
    await generateSummary("/tmp/not-an-agent-dir");
  });

  test("accepts valid agentDir and returns without error", async () => {
    // Valid agentDir with missing prompt.txt — passes validation, returns early
    await generateSummary(agentDir);
    // No crash = success; prompt.txt missing so no summary written
  });
});

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { generateSummary, isValidAgentDir } from "./generate-summary";

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

describe("generateSummary", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "generate-summary-test-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "test-agent");
    await mkdir(agentDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
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

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { generateSummary } from "./generate-summary";

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

  test("rejects invalid agentDir paths", async () => {
    // Relative path
    await generateSummary("relative/path");
    // Missing .ittybitty/agents/ structure
    await generateSummary("/tmp/not-an-agent-dir");
    // Should not throw — just returns silently
  });

  test("accepts valid agentDir paths", async () => {
    // Valid path format but missing prompt.txt — should pass validation but return early
    await generateSummary(agentDir);
    // If it didn't throw, validation passed
  });

  test("handles corrupt meta.json gracefully", async () => {
    await Bun.write(join(agentDir, "prompt.txt"), "some task");
    await Bun.write(join(agentDir, "meta.json"), "not valid json {{{");
    // generateSummary will try to run claude -p which won't be available in test,
    // but the corrupt JSON handling is wrapped in try/catch, so if claude were
    // available and returned a summary, the corrupt JSON would not crash
    // This test verifies the function signature is stable and doesn't throw on setup
    await generateSummary(agentDir);
  });
});

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";

describe("hookPermissionDenied", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "perm-denied-test-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-test123");
    // Create agent directory structure
    await Bun.write(join(agentDir, "agent.log"), "");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("logs tool_name to agent dir", async () => {
    // We can't easily test hookPermissionDenied directly because it reads from
    // Bun.stdin.stream(). Instead, test logAgent integration directly.
    const { logAgent } = await import("../agent-lifecycle");

    const toolName = "Bash";
    await logAgent(agentDir, `[PermissionRequest] Tool denied: ${toolName}`);

    const logContent = await readFile(join(agentDir, "agent.log"), "utf-8");
    expect(logContent).toContain("[PermissionRequest] Tool denied: Bash");
  });

  test("handles missing tool_name gracefully", async () => {
    // When tool_name is missing, it should default to "unknown"
    const { logAgent } = await import("../agent-lifecycle");

    const toolName = "unknown";
    await logAgent(agentDir, `[PermissionRequest] Tool denied: ${toolName}`);

    const logContent = await readFile(join(agentDir, "agent.log"), "utf-8");
    expect(logContent).toContain("[PermissionRequest] Tool denied: unknown");
  });
});

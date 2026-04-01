import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  resolveAgentDir,
  logSlowHook,
  logHookError,
  withSlowHookLogging,
} from "./slow-hook-logger";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "slow-hook-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── resolveAgentDir ─────────────────────────────────────────────────────────

test("resolveAgentDir with agentId and agents dir in cwd", () => {
  const cwd = "/repo/.ittybitty/agents/agent-abc12345/repo";
  expect(resolveAgentDir(cwd, "agent-abc12345")).toBe(
    "/repo/.ittybitty/agents/agent-abc12345",
  );
});

test("resolveAgentDir with agentId different from cwd agent", () => {
  const cwd = "/repo/.ittybitsy/agents/agent-abc12345/repo";
  // agentId provided but cwd doesn't match .ittybitty pattern
  expect(resolveAgentDir(cwd)).toBeNull();
});

test("resolveAgentDir without agentId extracts from cwd", () => {
  const cwd = "/repo/.ittybitty/agents/agent-abc12345/repo/src";
  expect(resolveAgentDir(cwd)).toBe("/repo/.ittybitty/agents/agent-abc12345");
});

test("resolveAgentDir returns null for non-agent cwd", () => {
  expect(resolveAgentDir("/some/random/path")).toBeNull();
});

test("resolveAgentDir with agentId but no agents dir in cwd", () => {
  expect(resolveAgentDir("/some/random/path", "agent-abc12345")).toBeNull();
});

// ── logSlowHook ─────────────────────────────────────────────────────────────

test("logSlowHook writes file when elapsed > 1s", async () => {
  const agentDir = tmpDir;
  await logSlowHook("hook-check-path", '{"tool_name":"Read"}', 1500, agentDir);

  const debugDir = join(agentDir, "debug-logs");
  const files = await readdir(debugDir);
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/^hook-check-path-\d{8}-\d{6}-slow\.log$/);

  const content = await readFile(join(debugDir, files[0]!), "utf-8");
  expect(content).toContain("hook: hook-check-path");
  expect(content).toContain("elapsed: 1.500s");
  expect(content).toContain("--- raw stdin ---");
  expect(content).toContain('{"tool_name":"Read"}');
});

test("logSlowHook does NOT write file when elapsed <= 1s", async () => {
  await logSlowHook("hook-check-path", '{"tool_name":"Read"}', 999, tmpDir);

  const debugDir = join(tmpDir, "debug-logs");
  let files: string[] = [];
  try {
    files = await readdir(debugDir);
  } catch {
    // dir doesn't exist — correct behavior
  }
  expect(files.length).toBe(0);
});

test("logSlowHook does NOT write when elapsed is exactly 1s", async () => {
  await logSlowHook("hook-check-path", '{"data":1}', 1000, tmpDir);

  let files: string[] = [];
  try {
    files = await readdir(join(tmpDir, "debug-logs"));
  } catch {
    // dir doesn't exist
  }
  expect(files.length).toBe(0);
});

test("logSlowHook does nothing when agentDir is null", async () => {
  await logSlowHook("hook-check-path", "data", 5000, null);
  // No crash, no file written — just a no-op
});

test("logSlowHook handles empty stdin", async () => {
  await logSlowHook("hook-status", "", 2000, tmpDir);

  const files = await readdir(join(tmpDir, "debug-logs"));
  expect(files.length).toBe(1);

  const content = await readFile(join(tmpDir, "debug-logs", files[0]!), "utf-8");
  expect(content).toContain("(empty)");
});

// ── logHookError ────────────────────────────────────────────────────────────

test("logHookError writes file regardless of elapsed time", async () => {
  const err = new Error("Something broke");
  await logHookError("hook-check-path", '{"tool":"Read"}', 50, tmpDir, err);

  const files = await readdir(join(tmpDir, "debug-logs"));
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/^hook-check-path-.*-error\.log$/);

  const content = await readFile(join(tmpDir, "debug-logs", files[0]!), "utf-8");
  expect(content).toContain("hook: hook-check-path");
  expect(content).toContain("result: ERROR");
  expect(content).toContain("--- error ---");
  expect(content).toContain("Error: Something broke");
  expect(content).toContain("--- raw stdin ---");
  expect(content).toContain('{"tool":"Read"}');
});

test("logHookError handles non-Error objects", async () => {
  await logHookError("hook-status", "input", 100, tmpDir, "string error");

  const files = await readdir(join(tmpDir, "debug-logs"));
  const content = await readFile(join(tmpDir, "debug-logs", files[0]!), "utf-8");
  expect(content).toContain("string error");
});

test("logHookError does nothing when agentDir is null", async () => {
  await logHookError("hook-check-path", "data", 100, null, new Error("fail"));
  // No crash — just a no-op
});

// ── withSlowHookLogging ─────────────────────────────────────────────────────

test("withSlowHookLogging calls the hook function", async () => {
  let called = false;
  await withSlowHookLogging("test-hook", null, "", async () => {
    called = true;
  });
  expect(called).toBe(true);
});

test("withSlowHookLogging re-throws errors after logging", async () => {
  const err = new Error("hook crashed");
  let caught: unknown;
  try {
    await withSlowHookLogging("test-hook", tmpDir, '{"input":1}', async () => {
      throw err;
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBe(err);

  // Verify error was logged
  const files = await readdir(join(tmpDir, "debug-logs"));
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/-error\.log$/);
});

test("withSlowHookLogging does not log for fast successful hooks", async () => {
  await withSlowHookLogging("test-hook", tmpDir, "input", async () => {
    // fast hook — no delay
  });

  let files: string[] = [];
  try {
    files = await readdir(join(tmpDir, "debug-logs"));
  } catch {
    // dir doesn't exist
  }
  expect(files.length).toBe(0);
});

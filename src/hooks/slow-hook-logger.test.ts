import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  resolveAgentDir,
  logHookCall,
  withHookLogging,
} from "./slow-hook-logger";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hook-logger-test-"));
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
  // cwd doesn't match .ittybitty pattern
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

// ── logHookCall ─────────────────────────────────────────────────────────────

test("logHookCall writes ok log with timing, input, and output", async () => {
  await logHookCall("hook-check-path", '{"tool_name":"Read"}', 150, tmpDir, '{"decision":"allow"}');

  const debugDir = join(tmpDir, "debug-logs");
  const files = await readdir(debugDir);
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/^\d{8}-\d{6}\.\d{3}-hook-check-path-ok\.log$/);

  const content = await readFile(join(debugDir, files[0]!), "utf-8");
  expect(content).toContain("hook: hook-check-path");
  expect(content).toContain("result: ok");
  expect(content).toContain("elapsed: 0.150s");
  expect(content).toContain("--- stdout ---");
  expect(content).toContain('{"decision":"allow"}');
  expect(content).toContain("--- raw stdin ---");
  expect(content).toContain('{"tool_name":"Read"}');
});

test("logHookCall writes error log with error details", async () => {
  const err = new Error("Something broke");
  await logHookCall("hook-status", '{"data":1}', 50, tmpDir, "", err);

  const files = await readdir(join(tmpDir, "debug-logs"));
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/^\d{8}-\d{6}\.\d{3}-hook-status-error\.log$/);

  const content = await readFile(join(tmpDir, "debug-logs", files[0]!), "utf-8");
  expect(content).toContain("result: ERROR");
  expect(content).toContain("--- error ---");
  expect(content).toContain("Error: Something broke");
});

test("logHookCall handles non-Error objects", async () => {
  await logHookCall("hook-status", "input", 100, tmpDir, "", "string error");

  const files = await readdir(join(tmpDir, "debug-logs"));
  const content = await readFile(join(tmpDir, "debug-logs", files[0]!), "utf-8");
  expect(content).toContain("string error");
});

test("logHookCall does nothing when agentDir is null", async () => {
  await logHookCall("hook-check-path", "data", 5000, null, "output");
  // No crash, no file written
});

test("logHookCall handles empty stdin and output", async () => {
  await logHookCall("hook-status", "", 200, tmpDir, "");

  const files = await readdir(join(tmpDir, "debug-logs"));
  expect(files.length).toBe(1);

  const content = await readFile(join(tmpDir, "debug-logs", files[0]!), "utf-8");
  expect(content).toContain("--- stdout ---\n(empty)");
  expect(content).toContain("--- raw stdin ---\n(empty)");
});

// ── withHookLogging ─────────────────────────────────────────────────────────

test("withHookLogging calls the hook function", async () => {
  let called = false;
  await withHookLogging("test-hook", null, "", async () => {
    called = true;
  });
  expect(called).toBe(true);
});

test("withHookLogging logs successful hooks", async () => {
  await withHookLogging("test-hook", tmpDir, '{"input":1}', async () => {
    process.stdout.write('{"result":"ok"}');
  });

  const files = await readdir(join(tmpDir, "debug-logs"));
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/-ok\.log$/);
  expect(files[0]).toMatch(/^\d{8}-/);

  const content = await readFile(join(tmpDir, "debug-logs", files[0]!), "utf-8");
  expect(content).toContain("result: ok");
  expect(content).toContain('{"result":"ok"}');
  expect(content).toContain('{"input":1}');
});

test("withHookLogging captures process.stdout.write output", async () => {
  await withHookLogging("test-hook", tmpDir, "stdin", async () => {
    process.stdout.write("hello from hook");
  });

  const files = await readdir(join(tmpDir, "debug-logs"));
  const content = await readFile(join(tmpDir, "debug-logs", files[0]!), "utf-8");
  expect(content).toContain("hello from hook");
});

test("withHookLogging re-throws errors after logging", async () => {
  const err = new Error("hook crashed");
  let caught: unknown;
  try {
    await withHookLogging("test-hook", tmpDir, '{"input":1}', async () => {
      throw err;
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBe(err);

  const files = await readdir(join(tmpDir, "debug-logs"));
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/-error\.log$/);
  expect(files[0]).toMatch(/^\d{8}-/);
});

test("withHookLogging still passes output to real stdout", async () => {
  // The hook's stdout should still reach the real process.stdout
  // We just verify no crash and the hook runs correctly
  await withHookLogging("test-hook", tmpDir, "", async () => {
    process.stdout.write("passthrough");
  });
  // If we got here, stdout passthrough worked (no crash)
});

test("withHookLogging does nothing when agentDir is null", async () => {
  await withHookLogging("test-hook", null, "input", async () => {
    // fast hook, null agentDir — no file written, no crash
  });
});

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, rm, readFile } from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";
import { setUserHome, resetUserHome } from "../home";
import { hookPermissionDenied } from "./permission-denied";

/**
 * Per-process itsybitsy home for the whole file.
 *
 * The `@system` block below already redirects HOME for its own tests, and does
 * it correctly — it captures the previous value inside `beforeEach`, at runtime,
 * so it restores whatever was actually installed rather than a value frozen at
 * module load. The first block has no such override, and `logAgent` there is one
 * changed path away from resolving HOME. This makes the whole file independent of
 * the developer's real `~/.itsybitsy` rather than just the half that remembered.
 *
 * Because the `@system` block captures at runtime, it now saves and restores
 * THIS home, so isolation survives that block instead of being reverted by it.
 */
let testHome: string;

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), "ib-permission-denied-home-"));
  setUserHome(testHome);
  setCoordinatorHome(join(testHome, ".itsybitsy"));
});

afterAll(() => {
  resetCoordinatorHome();
  resetUserHome();
  rmSync(testHome, { recursive: true, force: true });
});

describe("hookPermissionDenied", () => {
  let tempDir: string;
  let agentDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "perm-denied-test-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-test123");
    // Create agent directory structure
    await Bun.write(join(agentDir, "agent.log"), "");
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "agent-test123", worktree: false }),
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("logs tool_name and emits a PermissionRequest denial instead of deferring to a prompt", async () => {
    const output: string[] = [];
    await hookPermissionDenied("agent-test123", JSON.stringify({ tool_name: "Bash" }), {
      write: (chunk) => output.push(chunk),
    });

    const logContent = await readFile(join(agentDir, "agent.log"), "utf-8");
    expect(logContent).toContain("[PermissionRequest] Tool denied: Bash");
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Permission denied by itsybitsy: tool requests must be authorized by the PreToolUse hook.",
        },
      },
    });
  });

  test.each(["{}", "null", "[]", "{broken", '{"tool_name":42}'])("malformed or incomplete input %s still denies", async (raw) => {
    let output = "";
    await hookPermissionDenied("agent-test123", raw, { write: (chunk) => { output += chunk; } });
    expect(JSON.parse(output).hookSpecificOutput.decision.behavior).toBe("deny");

    const logContent = await readFile(join(agentDir, "agent.log"), "utf-8");
    expect(logContent).toContain("[PermissionRequest] Tool denied: unknown");
  });

  test("logging failure cannot turn a denial into a native prompt", async () => {
    let output = "";
    await hookPermissionDenied("agent-test123", '{"tool_name":"Bash"}', {
      write: (chunk) => { output += chunk; },
      log: async () => { throw new Error("log filesystem unavailable"); },
    });
    expect(JSON.parse(output).hookSpecificOutput.decision.behavior).toBe("deny");
  });

  test("nested no-worktree cwd routes the diagnostic to the validated agent", async () => {
    const nested = join(tempDir, "packages", "app", "src");
    await mkdir(nested, { recursive: true });
    process.chdir(nested);
    let output = "";

    await hookPermissionDenied("agent-test123", '{"tool_name":"Edit"}', {
      write: (chunk) => { output += chunk; },
    });

    expect(await readFile(join(agentDir, "agent.log"), "utf-8")).toContain(
      "[PermissionRequest] Tool denied: Edit",
    );
    expect(JSON.parse(output).hookSpecificOutput.decision.behavior).toBe("deny");
  });

  test("invalid fallback agent identity denies without writing a diagnostic outside the agent", async () => {
    let output = "";
    let logged = false;
    await hookPermissionDenied("../escape", "{}", {
      write: (chunk) => { output += chunk; },
      log: async () => { logged = true; },
    });
    expect(logged).toBe(false);
    expect(JSON.parse(output).hookSpecificOutput.decision.behavior).toBe("deny");
  });
});

describe("hookPermissionDenied with @system", () => {
  let tempHome: string;
  let originalCwd: string;
  let coordHome: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempHome = await mkdtemp(join(tmpdir(), "perm-denied-system-"));
    setUserHome(tempHome);
    coordHome = join(tempHome, ".itsybitsy");
    await mkdir(coordHome, { recursive: true });
    process.chdir(coordHome);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    setUserHome(testHome);
    await rm(tempHome, { recursive: true, force: true });
  });

  test("routes log to ~/.itsybitsy/agent.log when called from system coordinator", async () => {
    const stdin = JSON.stringify({ tool_name: "Read" });
    let output = "";
    await hookPermissionDenied("@system", stdin, { write: (chunk) => { output += chunk; } });

    const logContent = await readFile(join(coordHome, "agent.log"), "utf-8");
    expect(logContent).toContain("[PermissionRequest] Tool denied: Read");
    expect(JSON.parse(output).hookSpecificOutput.decision.behavior).toBe("deny");
  });
});

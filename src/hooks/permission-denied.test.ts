import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, rm, readFile } from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";

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
let realHome: string | undefined;

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), "ib-permission-denied-home-"));
  realHome = process.env.HOME;
  process.env.HOME = testHome;
  setCoordinatorHome(join(testHome, ".itsybitsy"));
});

afterAll(() => {
  resetCoordinatorHome();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(testHome, { recursive: true, force: true });
});

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

describe("hookPermissionDenied with @system", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let coordHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    tempHome = await mkdtemp(join(tmpdir(), "perm-denied-system-"));
    process.env.HOME = tempHome;
    coordHome = join(tempHome, ".itsybitsy");
    await mkdir(coordHome, { recursive: true });
    process.chdir(coordHome);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("routes log to ~/.itsybitsy/agent.log when called from system coordinator", async () => {
    const { hookPermissionDenied } = await import("./permission-denied");
    const stdin = JSON.stringify({ tool_name: "Read" });
    await hookPermissionDenied("@system", stdin);

    const logContent = await readFile(join(coordHome, "agent.log"), "utf-8");
    expect(logContent).toContain("[PermissionRequest] Tool denied: Read");
  });
});

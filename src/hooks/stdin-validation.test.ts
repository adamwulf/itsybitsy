/**
 * Tests for malformed stdin handling in hook CLI entry points.
 * Each hook should gracefully handle invalid JSON, non-object input,
 * and schema violations (wrong types for tool_name, tool_input).
 */
import { test, expect, describe, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";

// Every test here spawns a real `bun` subprocess, which has to transpile the
// whole index.ts import graph before it does anything. That is far more
// load-sensitive than an in-process unit test: normally a few hundred ms, but
// measured at 156s for a single spawn during a pathologically loaded run,
// which blew bun's 5s default and failed a test that was otherwise correct.
// Raising the bound only changes how long a genuinely stuck spawn takes to
// fail; it weakens no assertion, and passing tests are unaffected.
setDefaultTimeout(60_000);

const INDEX_PATH = join(import.meta.dir, "..", "index.ts");

// Temp directory structured as .ittybitty/agents/<id>/repo so that
// resolveAgentDir() points debug-logs writes into /tmp instead of the
// real agents directory.
let tempBase: string;
let hookCwd: string;

/**
 * Per-process itsybitsy home for the whole file.
 *
 * The `hookCwd` above only redirects paths derived from the CWD. It does
 * nothing for paths derived from HOME, and every hook entry point invoked here
 * resolves `$HOME/.itsybitsy` (via `resolveAgentFromCwd`) before it looks at the
 * cwd at all.
 *
 * The override that matters for this file is `process.env.HOME`, and only that
 * one: these tests do not call hook code in-process, they spawn a real
 * `bun index.ts` SUBPROCESS. `setCoordinatorHome` is in-process state and does
 * not cross a process boundary, so it would do nothing here — whereas `Bun.spawn`
 * inherits `process.env`, so redirecting HOME in the parent is what actually
 * moves the child off the developer's real `~/.itsybitsy`.
 *
 * Deliberately NOT seeded with `ensureAgentTypesDir()`: these tests feed
 * malformed stdin and assert the hooks reject it, so no agent-type lookup is
 * reached. Verified — the whole file passes against an empty home.
 */
let testHome: string;
let realHome: string | undefined;

beforeAll(async () => {
  tempBase = await mkdtemp(join(tmpdir(), "ib-hook-test-"));
  hookCwd = join(tempBase, ".ittybitty", "agents", "agent-test1234", "repo");
  await mkdir(hookCwd, { recursive: true });

  testHome = await mkdtemp(join(tmpdir(), "ib-stdin-validation-home-"));
  realHome = process.env.HOME;
  process.env.HOME = testHome;
});

afterAll(async () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  await rm(testHome, { recursive: true, force: true });
  await rm(tempBase, { recursive: true, force: true });
});

/** Run a hook subcommand via `bun index.ts`, piping stdin, returning stdout/stderr/exitCode. */
async function runHook(
  args: string[],
  stdin: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", INDEX_PATH, ...args], {
    cwd: hookCwd,
    stdin: new Response(stdin).body!,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// ── hook-check-path stdin validation ──────────────────────────────────────────

describe("hook-check-path stdin validation", () => {
  const cmd = ["hook-check-path", "agent-test1234"];

  test("malformed JSON exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(cmd, "not json{{{");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("failed to parse stdin JSON");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("non-object JSON (string) exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(cmd, '"just a string"');
    expect(exitCode).toBe(0);
    expect(stderr).toContain("not a JSON object");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("non-object JSON (array) exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(cmd, "[1,2,3]");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("not a JSON object");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("non-object JSON (null) exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(cmd, "null");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("not a JSON object");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("tool_name not a string exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(
      cmd,
      JSON.stringify({ tool_name: 42, tool_input: {} })
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("tool_name is not a string");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("tool_input not an object exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(
      cmd,
      JSON.stringify({ tool_name: "Read", tool_input: "bad" })
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("tool_input is not an object");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("tool_input null exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(
      cmd,
      JSON.stringify({ tool_name: "Read", tool_input: null })
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("tool_input is not an object");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("empty object is valid input (exits 0)", async () => {
    const { stdout, exitCode } = await runHook(cmd, "{}");
    expect(exitCode).toBe(0);
    // Should proceed normally — empty tool_name defaults to ""
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput).toBeDefined();
  });
});

// ── hooks intercept-task stdin validation ─────────────────────────────────────

describe("hooks intercept-task stdin validation", () => {
  const cmd = ["hooks", "intercept-task"];

  test("malformed JSON exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(cmd, "{bad json");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("failed to parse stdin JSON");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("non-object JSON (number) exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(cmd, "42");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("not a JSON object");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("tool_name not a string exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(
      cmd,
      JSON.stringify({ tool_name: { nested: true }, tool_input: {} })
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("tool_name is not a string");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("tool_input not an object exits 0 and outputs allow", async () => {
    const { stdout, stderr, exitCode } = await runHook(
      cmd,
      JSON.stringify({ tool_name: "Task", tool_input: 123 })
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("tool_input is not an object");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("empty object proceeds normally", async () => {
    const { stdout, exitCode } = await runHook(cmd, "{}");
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput).toBeDefined();
  });
});

// ── hooks session-start stdin validation ──────────────────────────────────────

describe("hooks session-start stdin validation", () => {
  const cmd = ["hooks", "session-start"];

  test("malformed JSON exits 0 and outputs empty context", async () => {
    const { stdout, stderr, exitCode } = await runHook(cmd, "<<<not json>>>");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("failed to parse stdin JSON");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toBe("");
  });

  test("non-object JSON (boolean) exits 0 and outputs empty context", async () => {
    const { stdout, stderr, exitCode } = await runHook(cmd, "true");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("not a JSON object");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toBe("");
  });

  test("empty object proceeds normally", async () => {
    const { stdout, exitCode } = await runHook(cmd, "{}");
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    // additionalContext will contain role-specific instructions (depends on cwd)
    expect(typeof out.hookSpecificOutput.additionalContext).toBe("string");
    expect(out.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
  });
});

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  hookCodexSessionStart,
  hookCodexSessionStartDryRun,
} from "./codex-session-start";

function captureStdout(): {
  capture: string[];
  restore: () => void;
} {
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

describe("hookCodexSessionStart — meta.codex_session_id capture (gate (f))", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-ss-"));
    agentDir = join(tempDir, "agent-x");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "agent-test01", model: "codex:gpt-5.4-mini" }),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes codex_session_id on first firing", async () => {
    const { capture, restore } = captureStdout();
    try {
      await hookCodexSessionStart("agent-test01", {
        rawStdin: JSON.stringify({ session_id: "rollout-aaaa", cwd: agentDir }),
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.codex_session_id).toBe("rollout-aaaa");

    // Also: state is flipped to "running"
    expect(meta.state).toBe("running");

    // Also: stdout was valid JSON with SessionStart event name
    const parsed = JSON.parse(capture.join(""));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("is idempotent — does not overwrite an existing codex_session_id", async () => {
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: "agent-test01",
        model: "codex:gpt-5.4-mini",
        codex_session_id: "rollout-original",
      }),
    );
    const { restore } = captureStdout();
    try {
      await hookCodexSessionStart("agent-test01", {
        rawStdin: JSON.stringify({ session_id: "rollout-newer", cwd: agentDir }),
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.codex_session_id).toBe("rollout-original");
  });
});

// ── (g) defensive sessionId / session_id read ─────────────────────────────────

describe("hookCodexSessionStart — defensive session id field reading (gate (g))", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-ss-g-"));
    agentDir = join(tempDir, "agent-x");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "agent-test02", model: "codex:gpt-5.4-mini" }),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reads snake_case session_id (v0.135.0 spelling)", async () => {
    const { restore } = captureStdout();
    try {
      await hookCodexSessionStart("agent-test02", {
        rawStdin: JSON.stringify({ session_id: "rollout-snake", cwd: agentDir }),
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.codex_session_id).toBe("rollout-snake");
  });

  test("reads camelCase sessionId (future-compat / rename guard)", async () => {
    const { restore } = captureStdout();
    try {
      await hookCodexSessionStart("agent-test02", {
        rawStdin: JSON.stringify({ sessionId: "rollout-camel", cwd: agentDir }),
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.codex_session_id).toBe("rollout-camel");
  });

  test("snake_case takes precedence when both spellings are present", async () => {
    const { restore } = captureStdout();
    try {
      await hookCodexSessionStart("agent-test02", {
        rawStdin: JSON.stringify({
          session_id: "snake-wins",
          sessionId: "camel-loses",
          cwd: agentDir,
        }),
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.codex_session_id).toBe("snake-wins");
  });
});

// ── State write + fail-open hardening ────────────────────────────────────────

describe("hookCodexSessionStart — state write + fail-open", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-ss-state-"));
    agentDir = join(tempDir, "agent-x");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "agent-test03", model: "codex:gpt-5.4-mini" }),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes state=running to meta.json", async () => {
    const { restore } = captureStdout();
    try {
      await hookCodexSessionStart("agent-test03", {
        rawStdin: JSON.stringify({ cwd: agentDir }),
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.state).toBe("running");
  });

  test("emits valid SessionStart JSON even with no stdin", async () => {
    const { capture, restore } = captureStdout();
    try {
      await hookCodexSessionStart("agent-test03", {
        rawStdin: "",
        agentDirOverride: agentDir,
      });
    } finally {
      restore();
    }
    const parsed = JSON.parse(capture.join(""));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("emits valid SessionStart JSON on invalid agent id (argv parse failure)", async () => {
    const { capture, restore } = captureStdout();
    try {
      await hookCodexSessionStart("bad id with spaces", {
        rawStdin: "{}",
      });
    } finally {
      restore();
    }
    const parsed = JSON.parse(capture.join(""));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });
});

// ── HIGH 3 from Phase 4 review: dry-run must actually exercise the handler ──
describe("hookCodexSessionStartDryRun — exercises real handler with synthetic payload", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let agentDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codex-ss-dryrun-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    agentDir = join(tempHome, ".ittybitty", "agents", "agent-dryrun01");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: "agent-dryrun01",
        worktree: true,
        model: "codex:gpt-5.4-mini",
      }),
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("succeeds when meta.json exists", async () => {
    const origCwd = process.cwd();
    process.chdir(tempHome);
    try {
      await hookCodexSessionStartDryRun("agent-dryrun01");
    } finally {
      process.chdir(origCwd);
    }
  });

  test("throws when meta.json is missing", async () => {
    const origCwd = process.cwd();
    process.chdir(tempHome);
    try {
      await expect(hookCodexSessionStartDryRun("agent-missing")).rejects.toThrow(/meta\.json not found/);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("throws when agent id is invalid", async () => {
    await expect(hookCodexSessionStartDryRun("bad agent id")).rejects.toThrow(/Invalid agent id/);
  });

  test("does NOT mutate meta.json (skipMetaWrites is set)", async () => {
    const before = await Bun.file(join(agentDir, "meta.json")).text();
    const origCwd = process.cwd();
    process.chdir(tempHome);
    try {
      await hookCodexSessionStartDryRun("agent-dryrun01");
    } finally {
      process.chdir(origCwd);
    }
    const after = await Bun.file(join(agentDir, "meta.json")).text();
    expect(after).toBe(before);
  });
});

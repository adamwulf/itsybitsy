import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readFile, readdir, mkdir } from "fs/promises";
import { tmpdir } from "os";
import {
  IB_COORDINATOR_SESSION,
  SYSTEM_COORDINATOR_PROMPT,
  buildSystemCoordinatorSettings,
  sanitizeTmuxInput,
  ensureSystemCoordinator,
  acquireSystemCoordinator,
  releaseSystemCoordinator,
  restartSystemCoordinator,
  detectSystemCoordinatorState,
  coordinatorSpawnCtx,
  setCoordinatorHome,
  resetCoordinatorHome,
  setCoordinatorSleepFn,
  resetCoordinatorSleepFn,
  buildPerRepoCoordinatorSettings,
  perRepoCoordinatorPrompt,
  getCoordinatorAgentId,
  checkCoordinatorExists,
  getRepoBasename,
} from "./coordinator";
import { spawnCtx as tmuxSpawnCtx } from "./tmux-poller";

describe("IB_COORDINATOR_SESSION", () => {
  test("has expected session name", () => {
    expect(IB_COORDINATOR_SESSION).toBe("ib-coordinator");
  });
});

describe("SYSTEM_COORDINATOR_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof SYSTEM_COORDINATOR_PROMPT).toBe("string");
    expect(SYSTEM_COORDINATOR_PROMPT.length).toBeGreaterThan(0);
  });

  test("mentions ib commands", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib list");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib send");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib merge");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib kill");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib new-agent");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib status");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib diff");
  });

  test("mentions inbox commands", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib inbox count");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib inbox list");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib inbox read");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib inbox ack");
  });

  test("warns against sending to self", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain(
      "Do NOT use `ib send coordinator`"
    );
  });

  test("explains delegation to per-repo coordinators", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("per-repo coordinators");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib send <repo-name>");
  });

  test("states no file tool access", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain(
      "do NOT have access to Read, Write, Edit, or any file tools"
    );
  });
});

describe("buildSystemCoordinatorSettings", () => {
  test("returns permissions object with allow and deny", () => {
    const settings = buildSystemCoordinatorSettings();
    expect(settings).toHaveProperty("permissions");
    expect(settings.permissions).toHaveProperty("allow");
    expect(settings.permissions).toHaveProperty("deny");
  });

  test("allows Bash(ib:*) and ToolSearch", () => {
    const settings = buildSystemCoordinatorSettings();
    expect(settings.permissions.allow).toEqual(["Bash(ib:*)", "ToolSearch"]);
  });

  test("does not deny unqualified Bash (would remove tool entirely)", () => {
    const settings = buildSystemCoordinatorSettings();
    expect(settings.permissions.deny).not.toContain("Bash");
  });

  test("denies all file access tools", () => {
    const settings = buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("Read");
    expect(deny).toContain("Write");
    expect(deny).toContain("Edit");
    expect(deny).toContain("MultiEdit");
    expect(deny).toContain("Glob");
    expect(deny).toContain("Grep");
    expect(deny).toContain("LS");
  });

  test("denies web access tools", () => {
    const settings = buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("WebFetch");
    expect(deny).toContain("WebSearch");
  });

  test("denies agent/task spawning tools", () => {
    const settings = buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("Task");
    expect(deny).toContain("TaskOutput");
    expect(deny).toContain("Agent");
  });

  test("denies other restricted tools", () => {
    const settings = buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("NotebookEdit");
    expect(deny).toContain("KillShell");
    expect(deny).toContain("EnterPlanMode");
    expect(deny).toContain("ExitPlanMode");
  });

  test("deny list has exactly 17 entries", () => {
    const settings = buildSystemCoordinatorSettings();
    expect(settings.permissions.deny).toHaveLength(16);
  });

  test("returns fresh arrays on each call (no shared mutation)", () => {
    const a = buildSystemCoordinatorSettings();
    const b = buildSystemCoordinatorSettings();
    expect(a.permissions.allow).not.toBe(b.permissions.allow);
    expect(a.permissions.deny).not.toBe(b.permissions.deny);
    a.permissions.allow.push("extra");
    expect(b.permissions.allow).not.toContain("extra");
  });
});

// -------------------------------------------------------------------
// sanitizeTmuxInput
// -------------------------------------------------------------------
describe("sanitizeTmuxInput", () => {
  test("passes through normal text", () => {
    expect(sanitizeTmuxInput("Hello, world!")).toBe("Hello, world!");
  });

  test("strips null byte", () => {
    expect(sanitizeTmuxInput("abc\x00def")).toBe("abcdef");
  });

  test("strips Ctrl-C (0x03)", () => {
    expect(sanitizeTmuxInput("hello\x03world")).toBe("helloworld");
  });

  test("strips Ctrl-D (0x04)", () => {
    expect(sanitizeTmuxInput("hello\x04world")).toBe("helloworld");
  });

  test("strips Escape (0x1B)", () => {
    expect(sanitizeTmuxInput("hello\x1Bworld")).toBe("helloworld");
  });

  test("strips DEL (0x7F)", () => {
    expect(sanitizeTmuxInput("hello\x7Fworld")).toBe("helloworld");
  });

  test("strips newline (0x0A) and carriage return (0x0D)", () => {
    expect(sanitizeTmuxInput("line1\nline2\r")).toBe("line1line2");
  });

  test("strips tab (0x09)", () => {
    expect(sanitizeTmuxInput("col1\tcol2")).toBe("col1col2");
  });

  test("preserves space (0x20)", () => {
    expect(sanitizeTmuxInput("hello world")).toBe("hello world");
  });

  test("preserves unicode", () => {
    expect(sanitizeTmuxInput("hello 🌍 world")).toBe("hello 🌍 world");
  });

  test("strips all C0 controls in mixed text", () => {
    expect(sanitizeTmuxInput("\x01\x02hello\x03\x04 world\x1B\x7F!")).toBe("hello world!");
  });

  test("returns empty string for all-control input", () => {
    expect(sanitizeTmuxInput("\x00\x01\x02\x03\x1B\x7F")).toBe("");
  });

  test("returns empty string for empty input", () => {
    expect(sanitizeTmuxInput("")).toBe("");
  });
});

// -------------------------------------------------------------------
// Helper: mock spawn for coordinator and tmux-poller contexts
// -------------------------------------------------------------------
function mockStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.close(); } });
}

/** Create a spawn mock that routes commands to different handlers based on the command. */
function createCommandRouter(handlers: Record<string, { stdout?: string; exitCode?: number }>) {
  return (cmd: string[], _opts?: any) => {
    // Build a key from the command for matching
    const cmdStr = cmd.join(" ");
    for (const [pattern, response] of Object.entries(handlers)) {
      if (cmdStr.includes(pattern)) {
        return {
          stdout: mockStream(response.stdout ?? ""),
          stderr: emptyStream(),
          exited: Promise.resolve(response.exitCode ?? 0),
        };
      }
    }
    // Default: success with no output
    return {
      stdout: mockStream(""),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    };
  };
}

// -------------------------------------------------------------------
// ensureSystemCoordinator
// -------------------------------------------------------------------
describe("ensureSystemCoordinator", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coord-test-"));
    setCoordinatorHome(tmpDir);
    setCoordinatorSleepFn(async () => {}); // No-op sleep for tests
  });

  afterEach(async () => {
    coordinatorSpawnCtx.reset();
    resetCoordinatorHome();
    resetCoordinatorSleepFn();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns session name when session already exists", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 0 },
    }));

    const result = await ensureSystemCoordinator();
    expect(result).toBe("ib-coordinator");
  });

  test("creates session when none exists", async () => {
    const commands: string[][] = [];
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return {
          stdout: mockStream(""),
          stderr: emptyStream(),
          exited: Promise.resolve(1), // No session
        };
      }
      return {
        stdout: mockStream(""),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    const result = await ensureSystemCoordinator();
    expect(result).toBe("ib-coordinator");

    // Verify the sequence of tmux commands
    const cmdStrs = commands.map((c) => c.join(" "));
    expect(cmdStrs.some((c) => c.includes("has-session"))).toBe(true);
    expect(cmdStrs.some((c) => c.includes("new-session"))).toBe(true);
    expect(cmdStrs.some((c) => c.includes("send-keys") && c.includes("claude --model"))).toBe(true);
    expect(cmdStrs.some((c) => c.includes("send-keys") && c.includes("-l"))).toBe(true);
  });

  test("writes settings.local.json during creation", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 1 },
    }));

    await ensureSystemCoordinator();

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    const content = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    expect(settings.permissions.allow).toEqual(["Bash(ib:*)", "ToolSearch"]);
    expect(settings.permissions.deny).not.toContain("Bash");
  });

  test("writes coordinator-prompt.txt during creation", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 1 },
    }));

    await ensureSystemCoordinator();

    const promptPath = join(tmpDir, "coordinator-prompt.txt");
    const content = await readFile(promptPath, "utf-8");
    expect(content).toContain("itsybitsy system coordinator");
  });

  test("writes .gitignore with *", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 1 },
      "rev-parse": { exitCode: 1 }, // Not a git repo yet
    }));

    await ensureSystemCoordinator();

    const gitignorePath = join(tmpDir, ".gitignore");
    const content = await readFile(gitignorePath, "utf-8");
    expect(content.trim()).toBe("*");
  });

  test("runs git init when directory is not a git repo", async () => {
    const commands: string[][] = [];
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      if (cmdStr.includes("rev-parse")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await ensureSystemCoordinator();

    const cmdStrs = commands.map((c) => c.join(" "));
    expect(cmdStrs.some((c) => c.includes("git init"))).toBe(true);
  });

  test("skips git init when directory is already a git repo", async () => {
    const commands: string[][] = [];
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      if (cmdStr.includes("rev-parse")) {
        return { stdout: mockStream(".git"), stderr: emptyStream(), exited: Promise.resolve(0) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await ensureSystemCoordinator();

    const cmdStrs = commands.map((c) => c.join(" "));
    expect(cmdStrs.some((c) => c.includes("git init"))).toBe(false);
  });

  test("TOCTOU: falls through when new-session fails but session exists", async () => {
    let hasSessionCallCount = 0;
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        hasSessionCallCount++;
        // First call: no session. Second call: session exists (race winner created it).
        const exitCode = hasSessionCallCount === 1 ? 1 : 0;
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(exitCode) };
      }
      if (cmdStr.includes("new-session")) {
        // Session creation fails — another instance won the race
        return { stdout: mockStream(""), stderr: mockStream("duplicate session"), exited: Promise.resolve(1) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    const result = await ensureSystemCoordinator();
    expect(result).toBe("ib-coordinator");
  });

  test("TOCTOU: throws when new-session fails and session does not exist", async () => {
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      if (cmdStr.includes("new-session")) {
        return { stdout: mockStream(""), stderr: mockStream("error"), exited: Promise.resolve(1) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await expect(ensureSystemCoordinator()).rejects.toThrow("Failed to create system coordinator tmux session");
  });

  test("uses coordinator.model from config", async () => {
    // Write a config file with a custom model
    const { mkdir } = await import("fs/promises");
    await mkdir(tmpDir, { recursive: true });
    const configPath = join(tmpDir, "config.json");
    await Bun.write(configPath, JSON.stringify({ coordinator: { model: "sonnet" } }));

    // Override config path
    const { setUserConfigPath, resetUserConfigPath } = await import("./config");
    setUserConfigPath(configPath);

    const commands: string[][] = [];
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    try {
      await ensureSystemCoordinator();

      const cmdStrs = commands.map((c) => c.join(" "));
      const claudeCmd = cmdStrs.find((c) => c.includes("claude --model"));
      expect(claudeCmd).toContain("claude --model sonnet");
    } finally {
      resetUserConfigPath();
    }
  });

  test("sanitizes prompt text before sending via tmux", async () => {
    const commands: string[][] = [];
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await ensureSystemCoordinator();

    // Find the send-keys -l command and verify it doesn't contain control chars
    const sendKeysCmd = commands.find((c) => c.includes("-l"));
    expect(sendKeysCmd).toBeDefined();
    if (sendKeysCmd) {
      const promptArg = sendKeysCmd[sendKeysCmd.indexOf("-l") + 1]!;
      // Verify no control chars
      for (let i = 0; i < promptArg.length; i++) {
        const code = promptArg.charCodeAt(i);
        expect(code >= 0x20 && code !== 0x7f).toBe(true);
      }
    }
  });
});

// -------------------------------------------------------------------
// PID reference counting
// -------------------------------------------------------------------
describe("acquireSystemCoordinator / releaseSystemCoordinator", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coord-refs-"));
    setCoordinatorHome(tmpDir);
  });

  afterEach(async () => {
    coordinatorSpawnCtx.reset();
    resetCoordinatorHome();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("acquire writes current PID to refs file", async () => {
    await acquireSystemCoordinator();

    const content = await readFile(join(tmpDir, "coordinator.refs"), "utf-8");
    expect(content).toContain(String(process.pid));
  });

  test("acquire is idempotent — same PID not duplicated", async () => {
    await acquireSystemCoordinator();
    await acquireSystemCoordinator();

    const content = await readFile(join(tmpDir, "coordinator.refs"), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const myPidCount = lines.filter((l) => l.trim() === String(process.pid)).length;
    expect(myPidCount).toBe(1);
  });

  test("release removes current PID from refs file", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({}));

    await acquireSystemCoordinator();
    await releaseSystemCoordinator();

    const content = await readFile(join(tmpDir, "coordinator.refs"), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.filter((l) => l.trim() === String(process.pid))).toHaveLength(0);
  });

  test("release kills session when no live PIDs remain", async () => {
    const commands: string[][] = [];
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await acquireSystemCoordinator();
    await releaseSystemCoordinator();

    const cmdStrs = commands.map((c) => c.join(" "));
    expect(cmdStrs.some((c) => c.includes("kill-session") && c.includes("ib-coordinator"))).toBe(true);
  });

  test("release does not kill session when other live PIDs remain", async () => {
    const commands: string[][] = [];
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    // Use parent PID which is guaranteed to be alive during tests
    const otherPid = process.ppid;
    const refsFile = join(tmpDir, "coordinator.refs");
    await Bun.write(refsFile, `${otherPid}\n${process.pid}\n`);

    await releaseSystemCoordinator();

    const cmdStrs = commands.map((c) => c.join(" "));
    expect(cmdStrs.some((c) => c.includes("kill-session"))).toBe(false);
  });

  test("release calls onLastRef callback before killing session", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({}));

    let callbackCalled = false;
    await acquireSystemCoordinator();
    await releaseSystemCoordinator(async () => {
      callbackCalled = true;
    });

    expect(callbackCalled).toBe(true);
  });

  test("release does not call onLastRef when other PIDs remain", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({}));

    // Use parent PID which is guaranteed to be alive during tests
    const otherPid = process.ppid;
    const refsFile = join(tmpDir, "coordinator.refs");
    await Bun.write(refsFile, `${otherPid}\n${process.pid}\n`);

    let callbackCalled = false;
    await releaseSystemCoordinator(async () => {
      callbackCalled = true;
    });

    expect(callbackCalled).toBe(false);
  });

  test("stale PIDs are pruned during acquire", async () => {
    // Write a PID that doesn't exist (99999999)
    const refsFile = join(tmpDir, "coordinator.refs");
    await Bun.write(refsFile, "99999999\n");

    await acquireSystemCoordinator();

    const content = await readFile(refsFile, "utf-8");
    expect(content).not.toContain("99999999");
    expect(content).toContain(String(process.pid));
  });

  test("stale PIDs are pruned during release", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({}));

    // Write a stale PID plus our PID
    const refsFile = join(tmpDir, "coordinator.refs");
    await Bun.write(refsFile, `99999999\n${process.pid}\n`);

    await releaseSystemCoordinator();

    const content = await readFile(refsFile, "utf-8");
    expect(content).not.toContain("99999999");
  });

  test("handles missing refs file gracefully on release", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({}));

    // No refs file exists — should not throw
    await releaseSystemCoordinator();

    // Should have killed session since no PIDs remain
    // (Nothing to check beyond no-throw)
  });

  test("handles empty refs file", async () => {
    const refsFile = join(tmpDir, "coordinator.refs");
    await Bun.write(refsFile, "\n");

    await acquireSystemCoordinator();

    const content = await readFile(refsFile, "utf-8");
    expect(content).toContain(String(process.pid));
  });

  test("handles malformed refs file content", async () => {
    const refsFile = join(tmpDir, "coordinator.refs");
    await Bun.write(refsFile, "not-a-number\nabc\n");

    await acquireSystemCoordinator();

    const content = await readFile(refsFile, "utf-8");
    // Malformed entries should be pruned (NaN filtered out)
    expect(content).toContain(String(process.pid));
    expect(content).not.toContain("not-a-number");
  });
});

// -------------------------------------------------------------------
// restartSystemCoordinator
// -------------------------------------------------------------------
describe("restartSystemCoordinator", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coord-restart-"));
    setCoordinatorHome(tmpDir);
    setCoordinatorSleepFn(async () => {});
  });

  afterEach(async () => {
    coordinatorSpawnCtx.reset();
    resetCoordinatorHome();
    resetCoordinatorSleepFn();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("kills existing session then creates new one", async () => {
    const commands: string[][] = [];
    let hasSessionCallCount = 0;
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        hasSessionCallCount++;
        // After kill, session doesn't exist
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await restartSystemCoordinator();

    const cmdStrs = commands.map((c) => c.join(" "));
    // Should kill first, then create
    const killIdx = cmdStrs.findIndex((c) => c.includes("kill-session"));
    const newIdx = cmdStrs.findIndex((c) => c.includes("new-session"));
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeGreaterThan(killIdx);
  });
});

// -------------------------------------------------------------------
// detectSystemCoordinatorState
// -------------------------------------------------------------------
describe("detectSystemCoordinatorState", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coord-state-"));
    setCoordinatorHome(tmpDir);
  });

  afterEach(() => {
    coordinatorSpawnCtx.reset();
    tmuxSpawnCtx.reset();
    resetCoordinatorHome();
  });

  test("returns 'stopped' when no tmux session exists", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 1 },
    }));

    const state = await detectSystemCoordinatorState();
    expect(state).toBe("stopped");
  });

  test("returns 'stopped' when captureTmuxOutput returns null", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 0 },
    }));
    // captureTmuxOutput uses tmuxSpawnCtx
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream(""),
      stderr: emptyStream(),
      exited: Promise.resolve(1), // tmux capture fails
    }));

    const state = await detectSystemCoordinatorState();
    expect(state).toBe("stopped");
  });

  test("returns 'compacting' when compacting text in last 5 lines", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 0 },
    }));
    const output = "line1\nline2\nline3\nCompacting conversation\nline5";
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream(output),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    }));

    const state = await detectSystemCoordinatorState();
    expect(state).toBe("compacting");
  });

  test("returns 'rate_limited' when rate limit text in last 15 lines", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 0 },
    }));
    const lines = Array.from({ length: 14 }, (_, i) => `line${i}`);
    lines.push("You've hit your limit for the day");
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream(lines.join("\n")),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    }));

    const state = await detectSystemCoordinatorState();
    expect(state).toBe("rate_limited");
  });

  test("returns 'rate_limited' for rate_limit_error pattern", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 0 },
    }));
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream("some output\nrate_limit_error\nmore output"),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    }));

    const state = await detectSystemCoordinatorState();
    expect(state).toBe("rate_limited");
  });

  test("returns 'running' for normal output", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 0 },
    }));
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream("Claude is running\nProcessing request\nDone"),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    }));

    const state = await detectSystemCoordinatorState();
    expect(state).toBe("running");
  });

  test("compacting takes priority over rate_limited", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 0 },
    }));
    // Both patterns present — compacting should win
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream("rate_limit_error\nCompacting conversation\nlast line"),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    }));

    const state = await detectSystemCoordinatorState();
    expect(state).toBe("compacting");
  });

  test("returns 'running' for empty output", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 0 },
    }));
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream(""),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    }));

    const state = await detectSystemCoordinatorState();
    expect(state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Per-repo coordinator tests (SPEC §12.2)
// ---------------------------------------------------------------------------

describe("getCoordinatorAgentId", () => {
  test("returns repo basename", () => {
    expect(getCoordinatorAgentId("/Users/adam/Developer/muse-ios")).toBe("muse-ios");
    expect(getCoordinatorAgentId("/home/user/itsybitsy")).toBe("itsybitsy");
  });
});

describe("getRepoBasename", () => {
  test("returns basename of a path", () => {
    expect(getRepoBasename("/Users/adam/Developer/muse-ios")).toBe("muse-ios");
    expect(getRepoBasename("/home/user/itsybitsy")).toBe("itsybitsy");
  });
});

describe("perRepoCoordinatorPrompt", () => {
  test("includes repo name", () => {
    const prompt = perRepoCoordinatorPrompt("muse-ios");
    expect(prompt).toContain("muse-ios");
  });

  test("mentions Read, Glob, Grep, LS", () => {
    const prompt = perRepoCoordinatorPrompt("test-repo");
    expect(prompt).toContain("Read");
    expect(prompt).toContain("Glob");
    expect(prompt).toContain("Grep");
    expect(prompt).toContain("LS");
  });

  test("mentions ib new-agent --worker", () => {
    const prompt = perRepoCoordinatorPrompt("test-repo");
    expect(prompt).toContain("ib new-agent --worker");
  });

  test("mentions ib send coordinator for system coordinator messaging", () => {
    const prompt = perRepoCoordinatorPrompt("test-repo");
    expect(prompt).toContain('ib send coordinator "message"');
  });

  test("says coordinator does not write code", () => {
    const prompt = perRepoCoordinatorPrompt("test-repo");
    expect(prompt).toContain("do NOT write code directly");
  });

  test("includes agent ID equal to repo name", () => {
    const prompt = perRepoCoordinatorPrompt("muse-ios");
    expect(prompt).toContain("Your agent ID is `muse-ios`");
  });

  test("mentions workers send messages via repo name", () => {
    const prompt = perRepoCoordinatorPrompt("muse-ios");
    expect(prompt).toContain('ib send muse-ios "message"');
  });
});

describe("buildPerRepoCoordinatorSettings", () => {
  test("includes Read, Write, Edit, MultiEdit, Glob, Grep, LS in allow list", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Write");
    expect(settings.permissions.allow).toContain("Edit");
    expect(settings.permissions.allow).toContain("MultiEdit");
    expect(settings.permissions.allow).toContain("Glob");
    expect(settings.permissions.allow).toContain("Grep");
    expect(settings.permissions.allow).toContain("LS");
  });

  test("includes Bash(ib:*) in allow list", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Bash(ib:*)");
  });

  test("includes git read and write commands in allow list", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Bash(git status:*)");
    expect(settings.permissions.allow).toContain("Bash(git log:*)");
    expect(settings.permissions.allow).toContain("Bash(git diff:*)");
    expect(settings.permissions.allow).toContain("Bash(git show:*)");
    expect(settings.permissions.allow).toContain("Bash(git ls-files:*)");
    expect(settings.permissions.allow).toContain("Bash(git add:*)");
    expect(settings.permissions.allow).toContain("Bash(git commit:*)");
    expect(settings.permissions.allow).toContain("Bash(git merge:*)");
    expect(settings.permissions.allow).toContain("Bash(git rebase:*)");
  });

  test("includes Task, Agent, WebFetch, WebSearch in allow list", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Task");
    expect(settings.permissions.allow).toContain("Agent");
    expect(settings.permissions.allow).toContain("WebFetch");
    expect(settings.permissions.allow).toContain("WebSearch");
    expect(settings.permissions.allow).toContain("TaskOutput");
    expect(settings.permissions.allow).toContain("KillShell");
    expect(settings.permissions.allow).toContain("NotebookEdit");
    expect(settings.permissions.allow).toContain("ToolSearch");
  });

  test("includes cat, head, tail, grep bash commands", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Bash(cat:*)");
    expect(settings.permissions.allow).toContain("Bash(head:*)");
    expect(settings.permissions.allow).toContain("Bash(tail:*)");
    expect(settings.permissions.allow).toContain("Bash(grep:*)");
    expect(settings.permissions.allow).toContain("Bash(git grep:*)");
  });

  test("denies EnterPlanMode and ExitPlanMode", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.deny).toContain("EnterPlanMode");
    expect(settings.permissions.deny).toContain("ExitPlanMode");
  });

  test("does not deny unqualified Bash", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.deny).not.toContain("Bash");
  });
});

describe("checkCoordinatorExists", () => {
  test("returns false when no agents directory", async () => {
    const td = join(tmpdir(), `coord-nodir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(td, { recursive: true });
    const result = await checkCoordinatorExists(td);
    expect(result.exists).toBe(false);
    if (!result.exists) {
      expect(result.collision).toBe(false);
    }
    await rm(td, { recursive: true, force: true });
  });

  test("returns exists when any agent has coordinator:true", async () => {
    const td = join(tmpdir(), `coord-true-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const coordDir = join(td, ".ittybitty", "agents", "my-repo");
    await mkdir(coordDir, { recursive: true });
    await Bun.write(join(coordDir, "meta.json"), JSON.stringify({ id: "my-repo", coordinator: true }));

    const result = await checkCoordinatorExists(td);
    expect(result.exists).toBe(true);
    if (result.exists) {
      expect(result.isCoordinator).toBe(true);
      expect(result.agentId).toBe("my-repo");
    }
    await rm(td, { recursive: true, force: true });
  });

  test("returns collision when basename-named agent exists without coordinator flag", async () => {
    // Repo path ends in "coord-repo" so basename is "coord-repo"
    const td = join(tmpdir(), `coord-repo`);
    const agentDir = join(td, ".ittybitty", "agents", "coord-repo");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "coord-repo" }));

    const result = await checkCoordinatorExists(td);
    expect(result.exists).toBe(false);
    if (!result.exists) {
      expect(result.collision).toBe(true);
    }
    await rm(td, { recursive: true, force: true });
  });

  test("returns no collision when agents exist but none match basename", async () => {
    const td = join(tmpdir(), `coord-nocol-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const agentDir = join(td, ".ittybitty", "agents", "agent-abc123");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc123" }));

    const result = await checkCoordinatorExists(td);
    expect(result.exists).toBe(false);
    if (!result.exists) {
      expect(result.collision).toBe(false);
    }
    await rm(td, { recursive: true, force: true });
  });

  test("finds coordinator regardless of agent directory name", async () => {
    const td = join(tmpdir(), `coord-anyname-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Agent named with suffix due to collision, but still has coordinator:true
    const coordDir = join(td, ".ittybitty", "agents", "my-repo-a3f2");
    await mkdir(coordDir, { recursive: true });
    await Bun.write(join(coordDir, "meta.json"), JSON.stringify({ id: "my-repo-a3f2", coordinator: true }));

    const result = await checkCoordinatorExists(td);
    expect(result.exists).toBe(true);
    if (result.exists) {
      expect(result.isCoordinator).toBe(true);
      expect(result.agentId).toBe("my-repo-a3f2");
    }
    await rm(td, { recursive: true, force: true });
  });
});

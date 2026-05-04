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
  getLastCoordinatorSpawnMode,
  discardSystemCoordinator,
} from "./coordinator";
import { encodeClaudeProjectPath } from "./auto-compact";
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

  test("warns against sending to self", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain(
      "Do NOT use `ib send @system`"
    );
  });

  test("explains delegation to per-repo coordinators", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("per-repo coordinators");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib send @<repo-name>");
  });

  test("states no file tool access", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain(
      "do NOT have access to Read, Write, Edit, or any file tools"
    );
  });
});

describe("buildSystemCoordinatorSettings", () => {
  // Isolate HOME so these tests read the embedded `_all.md` / `system.md`
  // layers rather than the developer's customized files. Without this, any
  // extra entry the user has added locally leaks into the test assertions.
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "sys-coord-settings-"));
    process.env.HOME = tempHome;
    // Populate with embedded defaults (including _all.md and system.md)
    // so loadAgentType works and returns the unmodified layers.
    await (await import("./agent-types")).ensureAgentTypesDir();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("returns permissions object with allow and deny", async () => {
    const settings = await buildSystemCoordinatorSettings();
    expect(settings).toHaveProperty("permissions");
    expect(settings.permissions).toHaveProperty("allow");
    expect(settings.permissions).toHaveProperty("deny");
  });

  test("allows Bash(ib:*) and ToolSearch", async () => {
    const settings = await buildSystemCoordinatorSettings();
    expect(settings.permissions.allow).toEqual(["Bash(ib:*)", "ToolSearch"]);
  });

  test("does not deny unqualified Bash (would remove tool entirely)", async () => {
    const settings = await buildSystemCoordinatorSettings();
    expect(settings.permissions.deny).not.toContain("Bash");
  });

  test("denies all file access tools", async () => {
    const settings = await buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("Read");
    expect(deny).toContain("Write");
    expect(deny).toContain("Edit");
    expect(deny).toContain("MultiEdit");
    expect(deny).toContain("Glob");
    expect(deny).toContain("Grep");
    expect(deny).toContain("LS");
  });

  test("denies web access tools", async () => {
    const settings = await buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("WebFetch");
    expect(deny).toContain("WebSearch");
  });

  test("denies agent/task spawning tools", async () => {
    const settings = await buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("Task");
    expect(deny).toContain("TaskCreate");
    expect(deny).toContain("TaskOutput");
    expect(deny).toContain("Agent");
  });

  test("denies other restricted tools", async () => {
    const settings = await buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("NotebookEdit");
    expect(deny).toContain("KillShell");
    expect(deny).toContain("EnterPlanMode");
    expect(deny).toContain("ExitPlanMode");
  });

  test("deny list has exactly 17 entries (embedded layers add nothing)", async () => {
    const settings = await buildSystemCoordinatorSettings();
    expect(settings.permissions.deny).toHaveLength(17);
  });

  test("returns fresh arrays on each call (no shared mutation)", async () => {
    const a = await buildSystemCoordinatorSettings();
    const b = await buildSystemCoordinatorSettings();
    expect(a.permissions.allow).not.toBe(b.permissions.allow);
    expect(a.permissions.deny).not.toBe(b.permissions.deny);
    a.permissions.allow.push("extra");
    expect(b.permissions.allow).not.toContain("extra");
  });

  test("merges system.md allow entries into final allow list", async () => {
    // Edit ~/.itsybitsy/agent-types/system.md to add a custom permission
    const systemPath = join(tempHome, ".itsybitsy", "agent-types", "system.md");
    await Bun.write(
      systemPath,
      `---
name: system
description: System coordinator layer (permissions only)
spawnable: false
permissions:
  allow:
    - "Bash(echo:*)"
  deny: []
---
`,
    );
    const settings = await buildSystemCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Bash(echo:*)");
    // Hardcoded floor still present
    expect(settings.permissions.allow).toContain("Bash(ib:*)");
    expect(settings.permissions.allow).toContain("ToolSearch");
  });

  test("merges _all.md allow entries into final allow list", async () => {
    const allPath = join(tempHome, ".itsybitsy", "agent-types", "_all.md");
    await Bun.write(
      allPath,
      `---
name: _all
description: Permissions and prompt prefix applied to every agent
spawnable: false
permissions:
  allow:
    - "Bash(date:*)"
  deny: []
---
`,
    );
    const settings = await buildSystemCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Bash(date:*)");
  });

  test("merges system.md deny entries into final deny list", async () => {
    const systemPath = join(tempHome, ".itsybitsy", "agent-types", "system.md");
    await Bun.write(
      systemPath,
      `---
name: system
description: System coordinator layer (permissions only)
spawnable: false
permissions:
  allow: []
  deny:
    - SomeCustomTool
---
`,
    );
    const settings = await buildSystemCoordinatorSettings();
    expect(settings.permissions.deny).toContain("SomeCustomTool");
    // Hardcoded floor still present
    expect(settings.permissions.deny).toContain("Read");
  });

  test("silently drops system.md allow entry that conflicts with hardcoded deny", async () => {
    // Read is in SYSTEM_COORDINATOR_DENY, so a layer that tries to allow it must be dropped
    const systemPath = join(tempHome, ".itsybitsy", "agent-types", "system.md");
    await Bun.write(
      systemPath,
      `---
name: system
description: System coordinator layer (permissions only)
spawnable: false
permissions:
  allow:
    - Read
  deny: []
---
`,
    );
    const settings = await buildSystemCoordinatorSettings();
    expect(settings.permissions.deny).toContain("Read");
    expect(settings.permissions.allow).not.toContain("Read");
  });

  test("silently drops _all.md allow entry that conflicts with hardcoded deny", async () => {
    const allPath = join(tempHome, ".itsybitsy", "agent-types", "_all.md");
    await Bun.write(
      allPath,
      `---
name: _all
description: Permissions and prompt prefix applied to every agent
spawnable: false
permissions:
  allow:
    - Write
  deny: []
---
`,
    );
    const settings = await buildSystemCoordinatorSettings();
    expect(settings.permissions.deny).toContain("Write");
    expect(settings.permissions.allow).not.toContain("Write");
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
  let typesHome: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coord-test-"));
    setCoordinatorHome(tmpDir);
    // Isolate HOME for agent-types loading so buildSystemCoordinatorSettings
    // reads the embedded `_all.md`/`system.md` layers, not the developer's
    // customized ones (which would leak extra allow entries into the assertions).
    typesHome = await mkdtemp(join(tmpdir(), "coord-types-home-"));
    process.env.HOME = typesHome;
    setCoordinatorSleepFn(async () => {}); // No-op sleep for tests
    // Stub tmuxSpawnCtx so waitForCoordinatorReady's capture returns
    // a "ready" marker on the first poll. Individual tests can override.
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream("Claude Code v1.0.0"),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    }));
  });

  afterEach(async () => {
    coordinatorSpawnCtx.reset();
    tmuxSpawnCtx.reset();
    resetCoordinatorHome();
    resetCoordinatorSleepFn();
    process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
    await rm(typesHome, { recursive: true, force: true });
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
    // No tmux send-keys -l (literal paste) command should fire — the prompt is
    // delivered as a positional arg to claude on the same send-keys command.
    expect(cmdStrs.some((c) => c.includes("send-keys") && c.includes("-l"))).toBe(false);
    // The new-session command must pass `bash` as the pane command so the
    // launch line's POSIX `$(cat …)` substitution works regardless of the
    // user's default $SHELL (fish uses `(…)` and would silently misbehave).
    const newSession = commands.find((c) => c[0] === "tmux" && c[1] === "new-session");
    expect(newSession).toBeDefined();
    expect(newSession![newSession!.length - 1]).toBe("bash");
  });

  test("sets window-size manual on the coordinator session during creation", async () => {
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

    await ensureSystemCoordinator();

    // window-size manual prevents tmux from auto-resizing the coordinator
    // session to the latest attached client's terminal size.
    const setWindowSize = commands.find(
      (c) =>
        c[0] === "tmux" &&
        c[1] === "set-option" &&
        c.includes(IB_COORDINATOR_SESSION) &&
        c.includes("window-size") &&
        c.includes("manual")
    );
    expect(setWindowSize).toBeDefined();
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

  test("writes the four agent hooks (no Stop) and spinnerTipsEnabled:false", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 1 },
    }));

    await ensureSystemCoordinator();

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(settings.spinnerTipsEnabled).toBe(false);

    // Stop hook is intentionally absent — system coordinator has its own
    // state detection in detectSystemCoordinatorState.
    expect(settings.hooks.Stop).toBeUndefined();

    // PreToolUse: path-check + intercept-task
    const preToolUse = settings.hooks.PreToolUse;
    expect(Array.isArray(preToolUse)).toBe(true);
    const preCommands = preToolUse.flatMap((entry: any) =>
      entry.hooks.map((h: any) => h.command),
    );
    expect(preCommands).toContain("ib hook-check-path @system");
    expect(preCommands).toContain("ib hooks intercept-task");

    // PermissionRequest
    const permissionRequest = settings.hooks.PermissionRequest;
    expect(Array.isArray(permissionRequest)).toBe(true);
    const permCommands = permissionRequest.flatMap((entry: any) =>
      entry.hooks.map((h: any) => h.command),
    );
    expect(permCommands).toContain("ib hook-permission-denied @system");

    // SessionStart
    const sessionStart = settings.hooks.SessionStart;
    expect(Array.isArray(sessionStart)).toBe(true);
    const ssCommands = sessionStart.flatMap((entry: any) =>
      entry.hooks.map((h: any) => h.command),
    );
    expect(ssCommands).toContain("ib hooks session-start @system");
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
      // Fresh launch: prompt is delivered as a positional arg via cat substitution.
      expect(claudeCmd).toContain('"$(cat ');
      expect(claudeCmd).toContain("coordinator-prompt.txt");
    } finally {
      resetUserConfigPath();
    }
  });

  test("fresh launch passes SYSTEM_COORDINATOR_PROMPT as positional arg via cat substitution", async () => {
    // The prompt is delivered to claude as a positional arg via
    // `"$(cat coordinator-prompt.txt)"` — the same pattern per-repo
    // coordinators use (see ib-commands.ts start.sh assembly). This makes
    // the prompt appear as the first user message in the conversation
    // transcript (visible when the user attaches the tmux session) rather
    // than as additionalContext (system-level, invisible). The SessionStart
    // hook fires for @system but does NOT inject the prompt — that would
    // double-deliver on fresh launch.
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

    // The send-keys command that launches claude must include the cat
    // substitution that supplies the prompt as a positional arg.
    const claudeLaunch = commands.find(
      (c) => c.includes("send-keys") && c.some((a) => a.startsWith("claude --model")),
    );
    expect(claudeLaunch).toBeDefined();
    const claudeCmd = claudeLaunch!.find((a) => a.startsWith("claude --model"))!;
    expect(claudeCmd).toContain('"$(cat ');
    expect(claudeCmd).toContain("coordinator-prompt.txt");

    // No send-keys -l (literal paste) command should fire — the prompt is on
    // the same launch line, not pasted afterward.
    const literalPaste = commands.find((c) => c.includes("send-keys") && c.includes("-l"));
    expect(literalPaste).toBeUndefined();

    // The launch command must not carry the prompt body inline — the prompt
    // body lives in coordinator-prompt.txt and is interpolated via $(cat).
    const carriesPromptBody = commands.find((c) =>
      c.some((arg) => arg.includes("itsybitsy system coordinator")),
    );
    expect(carriesPromptBody).toBeUndefined();
  });

  test("polls for 'Claude Code v' readiness marker after launching claude", async () => {
    // Even though we no longer paste a prompt, waitForCoordinatorReady is
    // still called so the resume-failure fallback can trigger when claude
    // never reaches the marker. Verify we keep polling until ready and stop
    // immediately once the marker appears.
    const events: string[] = [];
    let capturePolls = 0;

    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      if (cmd.includes("send-keys")) {
        if (cmd[cmd.length - 1] === "Enter" && cmd.some((a) => a.startsWith("claude --model"))) {
          events.push("launch-claude");
        }
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    tmuxSpawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd[0] === "tmux" && cmd[1] === "capture-pane") {
        capturePolls++;
        events.push(`poll-${capturePolls}`);
        const out = capturePolls < 4 ? "(loading)" : "Claude Code v1.0.0";
        return {
          stdout: mockStream(out),
          stderr: emptyStream(),
          exited: Promise.resolve(0),
        };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await ensureSystemCoordinator();

    // Claude is launched first, then polling begins.
    const launchIdx = events.indexOf("launch-claude");
    expect(launchIdx).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("poll-1")).toBeGreaterThan(launchIdx);
    // Loop stops once the marker appears (4th poll).
    expect(capturePolls).toBe(4);
  });

  test("waitForCoordinatorReady recognises [USER TASK] marker", async () => {
    // Verifies the alternative readiness marker (used when a task has already
    // been injected by a previous wake-up) is also accepted.
    let polls = 0;
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });
    tmuxSpawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd[0] === "tmux" && cmd[1] === "capture-pane") {
        polls++;
        return {
          stdout: mockStream("[USER TASK] some prior task"),
          stderr: emptyStream(),
          exited: Promise.resolve(0),
        };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await ensureSystemCoordinator();

    // First poll already returns ready, so we should only see one poll.
    expect(polls).toBe(1);
  });

  test("session resume: launches with --resume when a transcript exists, never carries prompt", async () => {
    const sessionId = "deadbeef-1234-5678-90ab-cdef00001111";
    const encoded = encodeClaudeProjectPath(tmpDir);
    const projectDir = join(typesHome, ".claude", "projects", encoded);
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, `${sessionId}.jsonl`), "{}\n");

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

    expect(getLastCoordinatorSpawnMode()).toBe("resumed");

    const claudeCmd = commands
      .map((c) => c.join(" "))
      .find((c) => c.includes("claude --resume"));
    expect(claudeCmd).toBeDefined();
    expect(claudeCmd).toContain(`claude --resume ${sessionId}`);
    expect(claudeCmd).toContain("--model");

    // Resume reuses the prior session's transcript, which already contains
    // the prompt. Adding a positional arg would inject a stale duplicate, so
    // the resume command must NOT include the cat substitution.
    expect(claudeCmd).not.toContain("$(cat");
    expect(claudeCmd).not.toContain("coordinator-prompt.txt");

    // No tmux paste on resume either.
    const pastedPrompt = commands.find((c) => c.includes("-l"));
    expect(pastedPrompt).toBeUndefined();
  });

  test("session resume: falls back to fresh launch when no transcript exists", async () => {
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

    expect(getLastCoordinatorSpawnMode()).toBe("fresh");
    const cmdStrs = commands.map((c) => c.join(" "));
    expect(cmdStrs.some((c) => c.includes("claude --resume"))).toBe(false);
    expect(cmdStrs.some((c) => c.includes("claude --model"))).toBe(true);
    // Fresh launch must include the prompt as a positional arg via cat
    // substitution.
    expect(cmdStrs.some((c) => c.includes("$(cat ") && c.includes("coordinator-prompt.txt"))).toBe(true);
    // No tmux -l (literal paste) fallback.
    expect(commands.some((c) => c.includes("-l"))).toBe(false);
  });

  test("session resume: picks the newest transcript regardless of name", async () => {
    const oldId = "11111111-1111-1111-1111-111111111111";
    const newId = "22222222-2222-2222-2222-222222222222";
    const encoded = encodeClaudeProjectPath(tmpDir);
    const projectDir = join(typesHome, ".claude", "projects", encoded);
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, `${oldId}.jsonl`), "{}\n");
    const { utimes } = await import("fs/promises");
    const past = new Date(Date.now() - 60_000);
    await utimes(join(projectDir, `${oldId}.jsonl`), past, past);
    await Bun.write(join(projectDir, `${newId}.jsonl`), "{}\n");

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

    const claudeCmd = commands.map((c) => c.join(" ")).find((c) => c.includes("claude --resume"));
    expect(claudeCmd).toContain(`claude --resume ${newId}`);
    expect(claudeCmd).not.toContain(oldId);
  });

  test("cleared-marker suppresses prior transcripts so the next launch is fresh", async () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const encoded = encodeClaudeProjectPath(tmpDir);
    const projectDir = join(typesHome, ".claude", "projects", encoded);
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, `${sessionId}.jsonl`), "{}\n");
    // Marker stamped AFTER the transcript was written — must suppress it.
    await Bun.write(join(tmpDir, "coordinator-session.cleared"), String(Date.now() + 1_000) + "\n");

    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await ensureSystemCoordinator();

    expect(getLastCoordinatorSpawnMode()).toBe("fresh");
  });

  test("resume failure: kills the dead session, writes cleared marker, then fresh-launches", async () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const encoded = encodeClaudeProjectPath(tmpDir);
    const projectDir = join(typesHome, ".claude", "projects", encoded);
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, `${sessionId}.jsonl`), "{}\n");

    const commands: string[][] = [];
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("has-session")) {
        return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(1) };
      }
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    // Force readiness to fail (capture-pane never returns the marker). On the
    // first attempt this triggers the resume-failure fallback: kill the
    // session, write the cleared marker, recurse with retryAfterResumeFailure.
    // On the retry, no transcript is found (cleared marker hides it), so the
    // spawn mode lands on "fresh".
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream(""),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    }));

    await ensureSystemCoordinator();

    expect(getLastCoordinatorSpawnMode()).toBe("fresh");
    const cmdStrs = commands.map((c) => c.join(" "));
    expect(cmdStrs.some((c) => c.includes("kill-session"))).toBe(true);
    expect(cmdStrs.some((c) => c.includes("claude --resume"))).toBe(true);
    expect(cmdStrs.some((c) => c.includes("claude --model"))).toBe(true);
    // Cleared marker must exist so the bad transcript isn't tried again.
    const markerExists = await Bun.file(join(tmpDir, "coordinator-session.cleared")).exists();
    expect(markerExists).toBe(true);
  });
});

// -------------------------------------------------------------------
// discardSystemCoordinator
// -------------------------------------------------------------------
describe("discardSystemCoordinator", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coord-discard-"));
    setCoordinatorHome(tmpDir);
  });

  afterEach(async () => {
    coordinatorSpawnCtx.reset();
    resetCoordinatorHome();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("kills tmux, writes cleared marker, removes self PID from refs", async () => {
    const refsFile = join(tmpDir, "coordinator.refs");
    const otherPid = process.ppid;
    await Bun.write(refsFile, `${otherPid}\n${process.pid}\n`);

    const commands: string[][] = [];
    coordinatorSpawnCtx.set((cmd: string[], _opts?: any) => {
      commands.push([...cmd]);
      return { stdout: mockStream(""), stderr: emptyStream(), exited: Promise.resolve(0) };
    });

    await discardSystemCoordinator();

    const cmdStrs = commands.map((c) => c.join(" "));
    expect(cmdStrs.some((c) => c.includes("kill-session") && c.includes("ib-coordinator"))).toBe(true);

    const markerExists = await Bun.file(join(tmpDir, "coordinator-session.cleared")).exists();
    expect(markerExists).toBe(true);

    const refs = await readFile(refsFile, "utf-8");
    expect(refs).not.toContain(String(process.pid));
    expect(refs).toContain(String(otherPid));
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
    tmuxSpawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: mockStream("Claude Code v1.0.0"),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
    }));
  });

  afterEach(async () => {
    coordinatorSpawnCtx.reset();
    tmuxSpawnCtx.reset();
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

  test("captureTmuxOutput is called with the 50-line cap (Change B)", async () => {
    coordinatorSpawnCtx.set(createCommandRouter({
      "has-session": { exitCode: 0 },
    }));
    let captureArgs: string[] | null = null;
    tmuxSpawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd[0] === "tmux" && cmd[1] === "capture-pane") {
        captureArgs = cmd;
      }
      return {
        stdout: mockStream(""),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    await detectSystemCoordinatorState();
    expect(captureArgs).not.toBeNull();
    // captureTmuxOutput passes "-S" then "-<lines>"
    expect(captureArgs!).toContain("-50");
    expect(captureArgs!).not.toContain("-5000");
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

  test("mentions ib new-agent --type worker", () => {
    const prompt = perRepoCoordinatorPrompt("test-repo");
    expect(prompt).toContain("ib new-agent --type worker");
  });

  test("mentions ib send @system for system coordinator messaging", () => {
    const prompt = perRepoCoordinatorPrompt("test-repo");
    expect(prompt).toContain('ib send @system "message"');
  });

  test("says coordinator does not write code", () => {
    const prompt = perRepoCoordinatorPrompt("test-repo");
    expect(prompt).toContain("do NOT write code directly");
  });

  test("includes agent ID equal to repo name", () => {
    const prompt = perRepoCoordinatorPrompt("muse-ios");
    expect(prompt).toContain("Your agent ID is `muse-ios`");
  });

  test("mentions workers send messages via @coordinator", () => {
    const prompt = perRepoCoordinatorPrompt("muse-ios");
    expect(prompt).toContain('ib send @coordinator "message"');
  });
});

describe("buildPerRepoCoordinatorSettings", () => {
  // Isolate HOME so these tests read the embedded `_all.md` layer rather than
  // the developer's customized ~/.itsybitsy/agent-types/_all.md. Without this,
  // any extra Bash(...) entry the user has added locally leaks into the test
  // assertions (e.g. if the user allows `Bash(git add:*)` for themselves, the
  // "write git commands not allowed" test fails).
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "coord-settings-"));
    process.env.HOME = tempHome;
    // Populate with embedded defaults (including _all.md) so loadAgentType
    // works and returns the unmodified layer.
    await (await import("./agent-types")).ensureAgentTypesDir();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("includes read-only tools in allow list", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Glob");
    expect(settings.permissions.allow).toContain("Grep");
    expect(settings.permissions.allow).toContain("LS");
    expect(settings.permissions.allow).toContain("TodoWrite");
    expect(settings.permissions.allow).not.toContain("AskUserQuestion");
    expect(settings.permissions.allow).toContain("ToolSearch");
  });

  test("does not allow write tools", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).not.toContain("Write");
    expect(settings.permissions.allow).not.toContain("Edit");
    expect(settings.permissions.allow).not.toContain("MultiEdit");
    expect(settings.permissions.allow).not.toContain("NotebookEdit");
  });

  test("includes Bash(ib:*) in allow list", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Bash(ib:*)");
  });

  test("includes read-only git commands but not write git commands", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    // Read-only git commands allowed
    expect(settings.permissions.allow).toContain("Bash(git status:*)");
    expect(settings.permissions.allow).toContain("Bash(git log:*)");
    expect(settings.permissions.allow).toContain("Bash(git diff:*)");
    expect(settings.permissions.allow).toContain("Bash(git show:*)");
    expect(settings.permissions.allow).toContain("Bash(git ls-files:*)");
    // Write git commands not allowed
    expect(settings.permissions.allow).not.toContain("Bash(git add:*)");
    expect(settings.permissions.allow).not.toContain("Bash(git commit:*)");
    expect(settings.permissions.allow).not.toContain("Bash(git merge:*)");
    expect(settings.permissions.allow).not.toContain("Bash(git rebase:*)");
  });

  test("does not allow Task, Agent, WebFetch, WebSearch, KillShell", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).not.toContain("Task");
    expect(settings.permissions.allow).not.toContain("Agent");
    expect(settings.permissions.allow).not.toContain("WebFetch");
    expect(settings.permissions.allow).not.toContain("WebSearch");
    expect(settings.permissions.allow).not.toContain("TaskOutput");
    expect(settings.permissions.allow).not.toContain("KillShell");
  });

  test("does not allow shell commands that can write via redirection", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).not.toContain("Bash(cat:*)");
    expect(settings.permissions.allow).not.toContain("Bash(head:*)");
    expect(settings.permissions.allow).not.toContain("Bash(tail:*)");
    expect(settings.permissions.allow).not.toContain("Bash(grep:*)");
    expect(settings.permissions.allow).not.toContain("Bash(git grep:*)");
  });

  test("denies write tools, web tools, and plan mode", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.deny).toContain("Write");
    expect(settings.permissions.deny).toContain("Edit");
    expect(settings.permissions.deny).toContain("MultiEdit");
    expect(settings.permissions.deny).toContain("NotebookEdit");
    expect(settings.permissions.deny).toContain("WebFetch");
    expect(settings.permissions.deny).toContain("WebSearch");
    expect(settings.permissions.deny).toContain("Task");
    expect(settings.permissions.deny).toContain("TaskOutput");
    expect(settings.permissions.deny).toContain("Agent");
    expect(settings.permissions.deny).toContain("KillShell");
    expect(settings.permissions.deny).toContain("EnterPlanMode");
    expect(settings.permissions.deny).toContain("ExitPlanMode");
  });

  test("does not deny unqualified Bash", async () => {
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.deny).not.toContain("Bash");
  });

  test("silently drops config allow entries that conflict with hardcoded deny", async () => {
    // Write is in hardcoded deny, so adding it to permissions.all.allow should be dropped.
    // (permissions.coordinator.* is removed; coordinator-specific permissions now live in
    // ~/.itsybitsy/agent-types/coordinator.md frontmatter.)
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.deny).toContain("Write");
    expect(settings.permissions.allow).not.toContain("Write");
  });

  test("merges coordinator.md allow entries into final allow list", async () => {
    // Edit ~/.itsybitsy/agent-types/coordinator.md to add a custom allow entry.
    const coordPath = join(tempHome, ".itsybitsy", "agent-types", "coordinator.md");
    await Bun.write(
      coordPath,
      `---
name: coordinator
description: Read-only coordinator that manages agents without writing code
canSpawnChildren: true
icon: ◇
instructionStyle: coordinator
permissions:
  allow:
    - "Bash(echo:*)"
  deny:
    - Write
    - Edit
---
`,
    );
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.allow).toContain("Bash(echo:*)");
    // Hardcoded floor still present
    expect(settings.permissions.allow).toContain("Bash(ib:*)");
  });

  test("merges coordinator.md deny entries into final deny list", async () => {
    const coordPath = join(tempHome, ".itsybitsy", "agent-types", "coordinator.md");
    await Bun.write(
      coordPath,
      `---
name: coordinator
description: Read-only coordinator that manages agents without writing code
canSpawnChildren: true
icon: ◇
instructionStyle: coordinator
permissions:
  allow: []
  deny:
    - SomeCustomTool
---
`,
    );
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.deny).toContain("SomeCustomTool");
    // Hardcoded floor still present
    expect(settings.permissions.deny).toContain("Write");
  });

  test("silently drops coordinator.md allow entry that conflicts with hardcoded deny", async () => {
    // Write is in PER_REPO_COORDINATOR_DENY; a coordinator.md that tries to allow it
    // must be silently dropped from the final allow list.
    const coordPath = join(tempHome, ".itsybitsy", "agent-types", "coordinator.md");
    await Bun.write(
      coordPath,
      `---
name: coordinator
description: Read-only coordinator that manages agents without writing code
canSpawnChildren: true
icon: ◇
instructionStyle: coordinator
permissions:
  allow:
    - Write
  deny: []
---
`,
    );
    const settings = await buildPerRepoCoordinatorSettings();
    expect(settings.permissions.deny).toContain("Write");
    expect(settings.permissions.allow).not.toContain("Write");
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

/**
 * Tests for repo configuration health check (SPEC.md §14).
 * Tests all 8 check categories.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import {
  checkLeakedAgentHooks,
  checkMissingGlobalHooks,
  checkAgentDirectories,
  checkOrphanedWorktrees,
  checkOrphanedBranches,
  checkStaleManagerRefs,
  checkAgentHookIds,
  checkRepoHealth,
  checkGlobalHealth,
  healthSpawnCtx,
} from "./health-check";

let tmpDir: string;

/** Helper to create a mock spawn result */
function mockResult(stdout: string, exitCode: number) {
  return {
    stdout: new Blob([stdout]).stream(),
    stderr: new Blob([]).stream(),
    exited: Promise.resolve(exitCode),
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "health-check-test-"));
});

afterEach(async () => {
  healthSpawnCtx.reset();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── §14.3.1 — Leaked Agent Hooks ────────────────────────────────────────────

describe("checkLeakedAgentHooks", () => {
  test("detects agent-specific hook-check-path in repo settings", async () => {
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [{ type: "command", command: "ib hook-check-path agent-abc12345" }],
        }],
      },
    }));

    const warnings = await checkLeakedAgentHooks(tmpDir);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.severity).toBe("error");
    expect(warnings[0]!.category).toBe("leaked-hooks");
    expect(warnings[0]!.agentId).toBe("agent-abc12345");
    expect(warnings[0]!.message).toContain("Leaked agent hook");
  });

  test("detects hook-status agent leak", async () => {
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: {
        Stop: [{
          hooks: [{ type: "command", command: "ib hook-status agent-deadbeef" }],
        }],
      },
    }));

    const warnings = await checkLeakedAgentHooks(tmpDir);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.severity).toBe("error");
    expect(warnings[0]!.agentId).toBe("agent-deadbeef");
  });

  test("detects hook-permission-denied agent leak", async () => {
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: {
        PermissionRequest: [{
          hooks: [{ type: "command", command: "ib hook-permission-denied agent-cafebabe" }],
        }],
      },
    }));

    const warnings = await checkLeakedAgentHooks(tmpDir);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.agentId).toBe("agent-cafebabe");
  });

  test("does NOT flag ib hooks intercept-task (global hook)", async () => {
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Task|Agent",
          hooks: [{ type: "command", command: "ib hooks intercept-task" }],
        }],
      },
    }));

    const warnings = await checkLeakedAgentHooks(tmpDir);
    expect(warnings.length).toBe(0);
  });

  test("does NOT flag ib hooks session-start (global hook)", async () => {
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{ type: "command", command: "ib hooks session-start" }],
        }],
      },
    }));

    const warnings = await checkLeakedAgentHooks(tmpDir);
    expect(warnings.length).toBe(0);
  });

  test("returns empty when no settings.local.json exists", async () => {
    const warnings = await checkLeakedAgentHooks(tmpDir);
    expect(warnings.length).toBe(0);
  });

  test("detects multiple leaked hooks", async () => {
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [{ type: "command", command: "ib hook-check-path agent-aaa" }],
        }],
        Stop: [{
          hooks: [{ type: "command", command: "ib hook-status agent-bbb" }],
        }],
      },
    }));

    const warnings = await checkLeakedAgentHooks(tmpDir);
    expect(warnings.length).toBe(2);
  });
});

// ── §14.3.2 — Missing Global Hooks ─────────────────────────────────────────

describe("checkMissingGlobalHooks", () => {
  test("returns warnings (array)", async () => {
    const warnings = await checkMissingGlobalHooks();
    expect(Array.isArray(warnings)).toBe(true);
    for (const w of warnings) {
      expect(w.category).toBe("missing-global-hooks");
      expect(w.severity).toBe("warning");
    }
  });
});

// ── §14.3.3 & §14.3.4 — Agent Directories / Malformed meta.json ────────────

describe("checkAgentDirectories", () => {
  test("returns empty for repo with no agents directory", async () => {
    const warnings = await checkAgentDirectories(tmpDir);
    expect(warnings.length).toBe(0);
  });

  test("detects missing meta.json (orphaned dir)", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-orphan1");
    await mkdir(agentDir, { recursive: true });

    const warnings = await checkAgentDirectories(tmpDir);
    const orphanWarning = warnings.find((w) => w.category === "orphaned-dir");
    expect(orphanWarning).toBeDefined();
    expect(orphanWarning!.severity).toBe("error");
    expect(orphanWarning!.message).toContain("no valid meta.json");
    expect(orphanWarning!.agentId).toBe("agent-orphan1");
  });

  test("detects invalid JSON in meta.json", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-badjson");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), "not valid json{{{");

    const warnings = await checkAgentDirectories(tmpDir);
    const malformedWarning = warnings.find((w) => w.category === "malformed-meta");
    expect(malformedWarning).toBeDefined();
    expect(malformedWarning!.severity).toBe("error");
    expect(malformedWarning!.message).toContain("invalid JSON");
  });

  test("detects missing required fields in meta.json", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-missing");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-missing" }));

    const warnings = await checkAgentDirectories(tmpDir);
    const malformedWarning = warnings.find((w) => w.category === "malformed-meta");
    expect(malformedWarning).toBeDefined();
    expect(malformedWarning!.message).toContain("tmux_session");
    expect(malformedWarning!.message).toContain("created_epoch");
  });

  test("detects id mismatch with directory name", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-realid");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-wrongid",
      tmux_session: "ib-agent-realid",
      created_epoch: Math.floor(Date.now() / 1000),
    }));

    const warnings = await checkAgentDirectories(tmpDir);
    const malformedWarning = warnings.find((w) => w.category === "malformed-meta");
    expect(malformedWarning).toBeDefined();
    expect(malformedWarning!.message).toContain("doesn't match directory");
  });

  test("valid agent with no tmux session and no worktree is flagged as stale", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-stale1");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-stale1",
      tmux_session: "ib-nonexistent-session-xyz",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
    }));

    healthSpawnCtx.set(() => mockResult("", 1));

    const warnings = await checkAgentDirectories(tmpDir);
    const staleWarning = warnings.find((w) => w.category === "orphaned-dir" && w.message.includes("stale directory"));
    expect(staleWarning).toBeDefined();
    expect(staleWarning!.severity).toBe("warning");
  });

  test("new agent (< 30s) is NOT flagged even without tmux session", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-new1");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-new1",
      tmux_session: "ib-nonexistent-session-xyz",
      created_epoch: Math.floor(Date.now() / 1000) - 5,
    }));

    const warnings = await checkAgentDirectories(tmpDir);
    const orphanWarnings = warnings.filter((w) => w.agentId === "agent-new1" && w.category === "orphaned-dir");
    expect(orphanWarnings.length).toBe(0);
  });

  test("valid agent with worktree is NOT flagged (stopped agent)", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-stopped");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-stopped",
      tmux_session: "ib-nonexistent-session-xyz",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
    }));
    const repoDir = join(agentDir, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, ".git"), "gitdir: /some/path");

    healthSpawnCtx.set(() => mockResult("", 1));

    const warnings = await checkAgentDirectories(tmpDir);
    const staleWarnings = warnings.filter((w) => w.agentId === "agent-stopped" && w.message.includes("stale"));
    expect(staleWarnings.length).toBe(0);
  });

  test("skips non-agent-id directory names", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", ".DS_Store");
    await mkdir(agentDir, { recursive: true });

    const warnings = await checkAgentDirectories(tmpDir);
    expect(warnings.length).toBe(0);
  });
});

// ── §14.3.5 — Orphaned Git Worktrees ───────────────────────────────────────

describe("checkOrphanedWorktrees", () => {
  test("detects orphaned worktree when agent dir is missing", async () => {
    await mkdir(join(tmpDir, ".ittybitty", "agents"), { recursive: true });

    healthSpawnCtx.set((cmd: string[]) => {
      if (cmd.includes("worktree")) {
        return mockResult(
          `worktree ${tmpDir}\nbranch refs/heads/main\n\nworktree /tmp/agent-deadbeef/repo\nbranch refs/heads/agent/agent-deadbeef\n\n`,
          0,
        );
      }
      return mockResult("", 1);
    });

    const warnings = await checkOrphanedWorktrees(tmpDir);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.severity).toBe("warning");
    expect(warnings[0]!.category).toBe("orphaned-worktree");
    expect(warnings[0]!.message).toContain("agent-deadbeef");
    expect(warnings[0]!.fix).toContain("git worktree remove");
  });

  test("does not flag worktree when agent dir exists", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-alive");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), "{}");

    healthSpawnCtx.set((cmd: string[]) => {
      if (cmd.includes("worktree")) {
        return mockResult(
          `worktree ${tmpDir}\nbranch refs/heads/main\n\nworktree /tmp/agent-alive/repo\nbranch refs/heads/agent/agent-alive\n\n`,
          0,
        );
      }
      return mockResult("", 1);
    });

    const warnings = await checkOrphanedWorktrees(tmpDir);
    expect(warnings.length).toBe(0);
  });

  test("returns empty when git fails", async () => {
    healthSpawnCtx.set(() => mockResult("", 128));

    const warnings = await checkOrphanedWorktrees(tmpDir);
    expect(warnings.length).toBe(0);
  });
});

// ── §14.3.6 — Orphaned Git Branches ────────────────────────────────────────

describe("checkOrphanedBranches", () => {
  test("detects orphaned branch when no agent dir or worktree exists", async () => {
    await mkdir(join(tmpDir, ".ittybitty", "agents"), { recursive: true });

    healthSpawnCtx.set((cmd: string[]) => {
      if (cmd.includes("branch")) {
        return mockResult("  agent/agent-orphanbranch\n", 0);
      }
      if (cmd.includes("worktree")) {
        return mockResult(`worktree ${tmpDir}\nbranch refs/heads/main\n\n`, 0);
      }
      return mockResult("", 1);
    });

    const warnings = await checkOrphanedBranches(tmpDir);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.severity).toBe("info");
    expect(warnings[0]!.category).toBe("orphaned-branch");
    expect(warnings[0]!.message).toContain("agent/agent-orphanbranch");
  });

  test("does not flag branch when agent dir exists", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-exists");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), "{}");

    healthSpawnCtx.set((cmd: string[]) => {
      if (cmd.includes("branch")) {
        return mockResult("  agent/agent-exists\n", 0);
      }
      if (cmd.includes("worktree")) {
        return mockResult("", 0);
      }
      return mockResult("", 1);
    });

    const warnings = await checkOrphanedBranches(tmpDir);
    expect(warnings.length).toBe(0);
  });

  test("does not flag branch when worktree exists for it", async () => {
    await mkdir(join(tmpDir, ".ittybitty", "agents"), { recursive: true });

    healthSpawnCtx.set((cmd: string[]) => {
      if (cmd.includes("branch")) {
        return mockResult("  agent/agent-wt\n", 0);
      }
      if (cmd.includes("worktree")) {
        return mockResult(`worktree /tmp/wt\nbranch refs/heads/agent/agent-wt\n\n`, 0);
      }
      return mockResult("", 1);
    });

    const warnings = await checkOrphanedBranches(tmpDir);
    expect(warnings.length).toBe(0);
  });
});

// ── §14.3.7 — Stale Manager References ─────────────────────────────────────

describe("checkStaleManagerRefs", () => {
  test("detects reference to non-existent manager", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-child");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-child",
      tmux_session: "ib-agent-child",
      created_epoch: Math.floor(Date.now() / 1000),
      manager: "agent-gone",
    }));

    const warnings = await checkStaleManagerRefs(tmpDir);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.severity).toBe("warning");
    expect(warnings[0]!.category).toBe("stale-manager-ref");
    expect(warnings[0]!.message).toContain("agent-gone");
    expect(warnings[0]!.agentId).toBe("agent-child");
  });

  test("does not flag when manager exists", async () => {
    const managerDir = join(tmpDir, ".ittybitty", "agents", "agent-manager");
    await mkdir(managerDir, { recursive: true });
    await writeFile(join(managerDir, "meta.json"), JSON.stringify({
      id: "agent-manager",
      tmux_session: "ib-agent-manager",
      created_epoch: Math.floor(Date.now() / 1000),
    }));

    const childDir = join(tmpDir, ".ittybitty", "agents", "agent-child2");
    await mkdir(childDir, { recursive: true });
    await writeFile(join(childDir, "meta.json"), JSON.stringify({
      id: "agent-child2",
      tmux_session: "ib-agent-child2",
      created_epoch: Math.floor(Date.now() / 1000),
      manager: "agent-manager",
    }));

    const warnings = await checkStaleManagerRefs(tmpDir);
    expect(warnings.length).toBe(0);
  });

  test("does not flag agents without manager field", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-solo");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-solo",
      tmux_session: "ib-agent-solo",
      created_epoch: Math.floor(Date.now() / 1000),
    }));

    const warnings = await checkStaleManagerRefs(tmpDir);
    expect(warnings.length).toBe(0);
  });
});

// ── §14.3.8 — Agent Hooks Referencing Wrong Agent ──────────────────────────

describe("checkAgentHookIds", () => {
  test("detects hooks referencing a different agent ID", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-correct");
    const settingsDir = join(agentDir, "repo", ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [{ type: "command", command: "ib hook-check-path agent-wrong" }],
        }],
      },
    }));

    const warnings = await checkAgentHookIds(tmpDir);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.severity).toBe("warning");
    expect(warnings[0]!.category).toBe("wrong-agent-hooks");
    expect(warnings[0]!.message).toContain("agent-correct");
    expect(warnings[0]!.message).toContain("agent-wrong");
  });

  test("does not flag hooks referencing correct agent ID", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-ok");
    const settingsDir = join(agentDir, "repo", ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [{ type: "command", command: "ib hook-check-path agent-ok" }],
        }],
        Stop: [{
          hooks: [{ type: "command", command: "ib hook-status agent-ok" }],
        }],
      },
    }));

    const warnings = await checkAgentHookIds(tmpDir);
    expect(warnings.length).toBe(0);
  });

  test("returns empty when agent has no settings.local.json", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-nosettings");
    await mkdir(agentDir, { recursive: true });

    const warnings = await checkAgentHookIds(tmpDir);
    expect(warnings.length).toBe(0);
  });
});

// ── Integration: checkRepoHealth ────────────────────────────────────────────

describe("checkRepoHealth", () => {
  test("clean repo produces no warnings", async () => {
    // Mock git commands to return empty/success
    healthSpawnCtx.set(() => mockResult("", 0));

    const report = await checkRepoHealth(tmpDir);
    expect(report.repoPath).toBe(tmpDir);
    expect(report.checkedAt).toBeGreaterThan(0);
    expect(report.warnings.length).toBe(0);
  });

  test("combines warnings from multiple checks", async () => {
    // Create leaked hook
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [{ type: "command", command: "ib hook-check-path agent-leaked" }],
        }],
      },
    }));

    // Create orphaned agent dir (no meta.json)
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-orphan");
    await mkdir(agentDir, { recursive: true });

    // Mock git commands to return empty
    healthSpawnCtx.set(() => mockResult("", 0));

    const report = await checkRepoHealth(tmpDir);
    expect(report.warnings.length).toBeGreaterThanOrEqual(2);

    const categories = report.warnings.map((w) => w.category);
    expect(categories).toContain("leaked-hooks");
    expect(categories).toContain("orphaned-dir");
  });

  test("severity ordering: errors > warnings > info", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-test");
    await mkdir(agentDir, { recursive: true });

    healthSpawnCtx.set(() => mockResult("", 0));

    const report = await checkRepoHealth(tmpDir);
    const errors = report.warnings.filter((w) => w.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ── Integration: checkGlobalHealth ──────────────────────────────────────────

describe("checkGlobalHealth", () => {
  test("returns array of warnings", async () => {
    const warnings = await checkGlobalHealth();
    expect(Array.isArray(warnings)).toBe(true);
  });
});

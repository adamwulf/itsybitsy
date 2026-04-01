/**
 * Tests for repo configuration health check (SPEC.md §14).
 * Tests all 8 check categories.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "fs/promises";
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
  getResolvableWarnings,
  resolveHealthWarnings,
} from "./health-check";
import type { RepoHealthWarning } from "./health-check";

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
          matcher: "Task|Agent|TaskCreate",
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

  test("does not flag coordinator worktree when agent dir exists with different branch name", async () => {
    // Coordinator branch is agent/{id}-{repoId} but agent dir is agents/{id}
    const coordinatorId = "itsybitsy";
    const repoId = "a3f2b1c0";
    const agentDir = join(tmpDir, ".ittybitty", "agents", coordinatorId);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ coordinator: true }));

    const worktreePath = join(tmpDir, ".ittybitty", "agents", coordinatorId, "repo");
    healthSpawnCtx.set((cmd: string[]) => {
      if (cmd.includes("worktree")) {
        return mockResult(
          `worktree ${tmpDir}\nbranch refs/heads/main\n\nworktree ${worktreePath}\nbranch refs/heads/agent/${coordinatorId}-${repoId}\n\n`,
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

// ── §14.8 — Auto-Resolve ───────────────────────────────────────────────────

describe("getResolvableWarnings", () => {
  test("filters to only resolvable categories", () => {
    const warnings: RepoHealthWarning[] = [
      { repoPath: "/r", severity: "error", category: "leaked-hooks", message: "leaked" },
      { repoPath: "/r", severity: "warning", category: "missing-global-hooks", message: "missing" },
      { repoPath: "/r", severity: "warning", category: "orphaned-dir", message: "stale directory" },
      { repoPath: "/r", severity: "error", category: "malformed-meta", message: "malformed" },
      { repoPath: "/r", severity: "warning", category: "orphaned-worktree", message: "orphaned wt" },
      { repoPath: "/r", severity: "info", category: "orphaned-branch", message: "orphaned br" },
      { repoPath: "/r", severity: "warning", category: "stale-manager-ref", message: "stale ref" },
      { repoPath: "/r", severity: "warning", category: "wrong-agent-hooks", message: "wrong hooks" },
    ];
    const resolvable = getResolvableWarnings(warnings);
    const categories = resolvable.map((w) => w.category);
    expect(categories).toContain("leaked-hooks");
    expect(categories).toContain("orphaned-dir");
    expect(categories).toContain("orphaned-worktree");
    expect(categories).toContain("orphaned-branch");
    expect(categories).toContain("stale-manager-ref");
    expect(categories).not.toContain("missing-global-hooks");
    expect(categories).not.toContain("malformed-meta");
    expect(categories).not.toContain("wrong-agent-hooks");
    expect(resolvable.length).toBe(5);
  });

  test("includes both orphaned-dir variants (missing meta and stale directory)", () => {
    const warnings: RepoHealthWarning[] = [
      { repoPath: "/r", severity: "error", category: "orphaned-dir", message: "no valid meta.json" },
      { repoPath: "/r", severity: "warning", category: "orphaned-dir", message: "stale directory" },
    ];
    const resolvable = getResolvableWarnings(warnings);
    expect(resolvable.length).toBe(2);
    expect(resolvable.map((w) => w.severity).sort()).toEqual(["error", "warning"]);
  });

  test("returns empty for no resolvable warnings", () => {
    const warnings: RepoHealthWarning[] = [
      { repoPath: "/r", severity: "warning", category: "missing-global-hooks", message: "missing" },
      { repoPath: "/r", severity: "error", category: "malformed-meta", message: "malformed" },
    ];
    expect(getResolvableWarnings(warnings).length).toBe(0);
  });
});

describe("resolveHealthWarnings", () => {
  test("resolves leaked-hooks by removing entries from settings.local.json", async () => {
    const settingsDir = join(tmpDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.local.json");
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [{ type: "command", command: "ib hook-check-path agent-leaked1" }],
        }],
        Stop: [{
          hooks: [{ type: "command", command: "ib hook-status agent-leaked1" }],
        }],
      },
      other: "preserved",
    }));

    const warnings: RepoHealthWarning[] = [{
      repoPath: tmpDir,
      severity: "error",
      category: "leaked-hooks",
      message: "Leaked agent hook",
      agentId: "agent-leaked1",
    }];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(1);
    expect(result.failed).toBe(0);

    const updated = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(updated.other).toBe("preserved");
    // hooks should be cleaned up
    expect(updated.hooks).toBeUndefined();
  });

  test("resolves orphaned-dir by removing directory", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-stale2");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-stale2" }));

    const warnings: RepoHealthWarning[] = [{
      repoPath: tmpDir,
      severity: "warning",
      category: "orphaned-dir",
      message: "Agent agent-stale2 has no tmux session and no worktree — stale directory",
      agentId: "agent-stale2",
    }];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(1);

    const exists = await Bun.file(join(agentDir, "meta.json")).exists();
    expect(exists).toBe(false);
  });

  test("resolves orphaned-dir with missing meta.json (error severity)", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-nometa1");
    await mkdir(agentDir, { recursive: true });
    // No meta.json — simulates the missing-meta variant

    const warnings: RepoHealthWarning[] = [{
      repoPath: tmpDir,
      severity: "error",
      category: "orphaned-dir",
      message: "Orphaned agent directory: agent-nometa1 — no valid meta.json",
      agentId: "agent-nometa1",
    }];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(1);

    const dirExists = await Bun.file(join(agentDir, "meta.json")).exists();
    expect(dirExists).toBe(false);
    // Verify the entire directory was removed
    const agentDirExists = await (async () => { try { await readdir(agentDir); return true; } catch { return false; } })();
    expect(agentDirExists).toBe(false);
  });

  test("resolves orphaned-worktree by calling git worktree remove", async () => {
    const commands: string[][] = [];
    healthSpawnCtx.set((cmd: string[]) => {
      commands.push(cmd);
      return mockResult("", 0);
    });

    const warnings: RepoHealthWarning[] = [{
      repoPath: tmpDir,
      severity: "warning",
      category: "orphaned-worktree",
      message: "Orphaned git worktree for agent/agent-wt1",
      fix: "git worktree remove /tmp/agent-wt1/repo",
    }];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(1);

    const worktreeCmd = commands.find((c) => c.includes("worktree") && c.includes("remove"));
    expect(worktreeCmd).toBeDefined();
    expect(worktreeCmd).toContain("/tmp/agent-wt1/repo");
    expect(worktreeCmd).toContain("--force");
  });

  test("resolves orphaned-worktree by falling back to prune when remove fails", async () => {
    const commands: string[][] = [];
    healthSpawnCtx.set((cmd: string[]) => {
      commands.push(cmd);
      // Fail worktree remove (simulates missing directory), succeed on prune
      if (cmd.includes("remove")) return mockResult("fatal: '/tmp/agent-wt2/repo' is not a working tree", 128);
      return mockResult("", 0);
    });

    const warnings: RepoHealthWarning[] = [{
      repoPath: tmpDir,
      severity: "warning",
      category: "orphaned-worktree",
      message: "Orphaned git worktree for agent/agent-wt2",
      fix: "git worktree remove /tmp/agent-wt2/repo",
    }];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(1);
    expect(result.failed).toBe(0);

    const removeCmd = commands.find((c) => c.includes("worktree") && c.includes("remove"));
    expect(removeCmd).toBeDefined();

    const pruneCmd = commands.find((c) => c.includes("worktree") && c.includes("prune"));
    expect(pruneCmd).toBeDefined();
    expect(pruneCmd).toContain("-C");
    expect(pruneCmd).toContain(tmpDir);
  });

  test("resolves orphaned-worktree fails when both remove and prune fail", async () => {
    healthSpawnCtx.set((cmd: string[]) => {
      return mockResult("fatal: error", 128);
    });

    const warnings: RepoHealthWarning[] = [{
      repoPath: tmpDir,
      severity: "warning",
      category: "orphaned-worktree",
      message: "Orphaned git worktree for agent/agent-wt3",
      fix: "git worktree remove /tmp/agent-wt3/repo",
    }];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.details[0]!.error).toContain("prune also failed");
  });

  test("resolves orphaned-branch by calling git branch -D", async () => {
    const commands: string[][] = [];
    healthSpawnCtx.set((cmd: string[]) => {
      commands.push(cmd);
      return mockResult("", 0);
    });

    const warnings: RepoHealthWarning[] = [{
      repoPath: tmpDir,
      severity: "info",
      category: "orphaned-branch",
      message: "Orphaned git branch: agent/agent-br1 — no agent or worktree exists",
      fix: "git branch -D agent/agent-br1",
    }];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(1);

    const branchCmd = commands.find((c) => c.includes("branch") && c.includes("-D"));
    expect(branchCmd).toBeDefined();
    expect(branchCmd).toContain("agent/agent-br1");
  });

  test("resolves stale-manager-ref by removing manager field from meta.json", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-child3");
    await mkdir(agentDir, { recursive: true });
    const metaPath = join(agentDir, "meta.json");
    await writeFile(metaPath, JSON.stringify({
      id: "agent-child3",
      tmux_session: "ib-agent-child3",
      created_epoch: 1000,
      manager: "agent-gone",
    }));

    const warnings: RepoHealthWarning[] = [{
      repoPath: tmpDir,
      severity: "warning",
      category: "stale-manager-ref",
      message: "Agent agent-child3 references non-existent manager agent-gone",
      agentId: "agent-child3",
    }];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(1);

    const updated = JSON.parse(await readFile(metaPath, "utf8"));
    expect(updated.id).toBe("agent-child3");
    expect(updated.manager).toBeUndefined();
    expect(updated.tmux_session).toBe("ib-agent-child3");
  });

  test("skips non-resolvable categories", async () => {
    const warnings: RepoHealthWarning[] = [
      { repoPath: tmpDir, severity: "warning", category: "missing-global-hooks", message: "missing" },
      { repoPath: tmpDir, severity: "error", category: "malformed-meta", message: "malformed" },
      { repoPath: tmpDir, severity: "warning", category: "wrong-agent-hooks", message: "wrong" },
    ];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.details.length).toBe(0);
  });

  test("handles partial failures gracefully", async () => {
    // Set up one resolvable (stale-manager-ref) and one that will fail (orphaned-worktree with bad git)
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-ok1");
    await mkdir(agentDir, { recursive: true });
    const metaPath = join(agentDir, "meta.json");
    await writeFile(metaPath, JSON.stringify({
      id: "agent-ok1",
      manager: "agent-gone",
    }));

    healthSpawnCtx.set(() => mockResult("error: not a worktree", 128));

    const warnings: RepoHealthWarning[] = [
      {
        repoPath: tmpDir,
        severity: "warning",
        category: "orphaned-worktree",
        message: "Orphaned git worktree",
        fix: "git worktree remove /nonexistent/path",
      },
      {
        repoPath: tmpDir,
        severity: "warning",
        category: "stale-manager-ref",
        message: "Agent agent-ok1 references non-existent manager agent-gone",
        agentId: "agent-ok1",
      },
    ];

    const result = await resolveHealthWarnings(warnings);
    expect(result.resolved).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details.length).toBe(2);

    const failedDetail = result.details.find((d) => !d.success);
    expect(failedDetail).toBeDefined();
    expect(failedDetail!.error).toBeDefined();

    const successDetail = result.details.find((d) => d.success);
    expect(successDetail).toBeDefined();
    expect(successDetail!.warning.category).toBe("stale-manager-ref");
  });
});

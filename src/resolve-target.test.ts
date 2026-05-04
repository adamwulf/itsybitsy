import { test, expect, describe, beforeEach, afterEach, jest, mock } from "bun:test";
import type { Agent } from "./agents";
import { makeAgent } from "./test-utils";
import type { RepoEntry } from "./registry";

// --- Test approach ---
// resolveTarget() internally calls readAllAgents() which reads from disk,
// and checkCoordinatorExists() which also reads from disk.
//
// We use REAL temp directories with real meta.json files instead of mock.module,
// because bun's mock.module is global and leaks to other test files.
// For checkCoordinatorExists, we create real coordinator agents in the temp dirs.
//
// matchAgentById is a pure function we can test directly.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const { resolveTarget, matchAgentById } = await import("./index");

// --- Temp directory management ---
let _tempDirs: string[] = [];

function makeTempRepo(name: string): RepoEntry {
  const dir = mkdtempSync(join(tmpdir(), `ib-test-${name}-`));
  mkdirSync(join(dir, ".ittybitty", "agents"), { recursive: true });
  _tempDirs.push(dir);
  return { path: dir, name };
}

function makeTempRepoWithNickname(name: string, nickname: string): RepoEntry {
  const entry = makeTempRepo(name);
  return { ...entry, nickname };
}

function addAgentToRepo(repoPath: string, id: string, extra: Record<string, any> = {}) {
  const agentDir = join(repoPath, ".ittybitty", "agents", id);
  mkdirSync(agentDir, { recursive: true });
  const meta = {
    id,
    session_id: "test-session",
    tmux_session: `ittybitty-test-${id}`,
    prompt: "test",
    manager: null,
    created: "2026-01-01T00:00:00Z",
    created_epoch: Math.floor(Date.now() / 1000) - 60,
    worktree: true,
    worker: false,
    yolo: false,
    model: "sonnet",
    claude_pid: "99999",
    ...extra,
  };
  writeFileSync(join(agentDir, "meta.json"), JSON.stringify(meta));
}

function addCoordinatorToRepo(repoPath: string, id: string) {
  addAgentToRepo(repoPath, id, { agentType: "coordinator" });
}

// --- Test helpers ---
let repoA: RepoEntry;
let repoB: RepoEntry;
let repoC: RepoEntry;
let repos: RepoEntry[];

// Capture console.error output
let errorOutput: string[];
const origError = console.error;

beforeEach(() => {
  errorOutput = [];
  console.error = (...args: any[]) => { errorOutput.push(args.join(" ")); };
  // Create fresh temp dirs for each test
  repoA = makeTempRepo("app");
  repoB = makeTempRepoWithNickname("lib", "libs");
  repoC = makeTempRepoWithNickname("api", "backend");
  repos = [repoA, repoB, repoC];
});

afterEach(() => {
  console.error = origError;
  // Cleanup temp dirs
  for (const dir of _tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  _tempDirs = [];
});

// ============================================================
// Group A: @system addressing
// ============================================================
describe("Group A: @system addressing", () => {
  test("A1: @system returns system coordinator", async () => {
    const result = await resolveTarget("@system", repos);
    expect(result).toEqual({ agent: null, isSystemCoordinator: true });
  });

  test("A2: @system is a fast path (returns immediately without agent lookup)", async () => {
    // @system returns isSystemCoordinator=true and agent=null, no agent resolution needed
    const result = await resolveTarget("@system", repos);
    expect(result.agent).toBeNull();
    expect(result.isSystemCoordinator).toBe(true);
  });

  test("A3: @System (wrong case) is not treated as @system", async () => {
    // No agents added, repos are empty — that's fine, tests the error path
    const result = await resolveTarget("@System", repos, "/somewhere");
    expect(result.isSystemCoordinator).toBe(false);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("repo not found: System"))).toBe(true);
  });
});

// ============================================================
// Group B: @coordinator with CWD contexts
// ============================================================
describe("Group B: @coordinator addressing", () => {
  test("B1: @coordinator inside repo, coordinator exists", async () => {
    addCoordinatorToRepo(repoA.path, "coord-xyz");
    const result = await resolveTarget("@coordinator", repos, repoA.path);
    expect(result.agent?.id).toBe("coord-xyz");
    expect(result.isSystemCoordinator).toBe(false);
  });

  test("B2: @coordinator inside repo, no coordinator", async () => {
    // No coordinator added, should fail
    const result = await resolveTarget("@coordinator", repos, repoA.path);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("no coordinator found for repo app"))).toBe(true);
  });

  test("B3: @coordinator outside all repos", async () => {
    const result = await resolveTarget("@coordinator", repos, "/tmp/outside-all-repos");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("@coordinator requires running from within a repo"))).toBe(true);
  });

  test("B4: CWD exact match finds own repo", async () => {
    addCoordinatorToRepo(repoA.path, "coord-a");
    const result = await resolveTarget("@coordinator", repos, repoA.path);
    expect(result.agent?.id).toBe("coord-a");
  });

  test("B5: CWD inside repo (subdirectory) finds own repo via prefix", async () => {
    addCoordinatorToRepo(repoA.path, "coord-a");
    const cwdInside = join(repoA.path, "src", "components");
    const result = await resolveTarget("@coordinator", repos, cwdInside);
    expect(result.agent?.id).toBe("coord-a");
  });

  test("B6: CWD in worktree finds own repo", async () => {
    addCoordinatorToRepo(repoA.path, "coord-a");
    const cwdWorktree = join(repoA.path, ".ittybitty", "agents", "agent-abc", "repo");
    const result = await resolveTarget("@coordinator", repos, cwdWorktree);
    expect(result.agent?.id).toBe("coord-a");
  });

  test("B7: CWD prefix collision - /app-data does NOT match /app", async () => {
    // repoA.path is something like /tmp/ib-test-app-xyz
    // Create a sibling path that starts with the same prefix
    const prefixCollision = repoA.path + "-data";
    const result = await resolveTarget("@coordinator", repos, prefixCollision);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("@coordinator requires running from within a repo"))).toBe(true);
  });
});

// ============================================================
// Group C: @repo-name coordinator lookup
// ============================================================
describe("Group C: @repo-name coordinator lookup", () => {
  test("C1: @app finds Repo A coordinator by basename", async () => {
    addCoordinatorToRepo(repoA.path, "coord-app");
    const result = await resolveTarget("@app", repos);
    expect(result.agent?.id).toBe("coord-app");
  });

  test("C2: @libs finds Repo B coordinator by nickname", async () => {
    addCoordinatorToRepo(repoB.path, "coord-lib");
    const result = await resolveTarget("@libs", repos);
    expect(result.agent?.id).toBe("coord-lib");
  });

  test("C3: @lib fails because nickname 'libs' overrides basename 'lib'", async () => {
    const result = await resolveTarget("@lib", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("repo not found: lib"))).toBe(true);
  });

  test("C4: @unknown fails with repo not found", async () => {
    const result = await resolveTarget("@unknown", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("repo not found: unknown"))).toBe(true);
  });

  test("C5: @app but no coordinator exists", async () => {
    // No coordinator added to repoA — should fail
    const result = await resolveTarget("@app", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("no coordinator found for repo app"))).toBe(true);
  });
});

// ============================================================
// Group D: @repo/agent-id scoped lookup
// ============================================================
describe("Group D: @repo/agent-id scoped lookup", () => {
  beforeEach(() => {
    addAgentToRepo(repoA.path, "agent-111");
    addAgentToRepo(repoA.path, "agent-abc");
    addAgentToRepo(repoB.path, "agent-222");
    addAgentToRepo(repoB.path, "agent-abd");
  });

  test("D1: @app/agent-111 exact match in Repo A", async () => {
    const result = await resolveTarget("@app/agent-111", repos);
    expect(result.agent?.id).toBe("agent-111");
  });

  test("D2: @app/agent-1 prefix match (unique in Repo A)", async () => {
    const result = await resolveTarget("@app/agent-1", repos);
    expect(result.agent?.id).toBe("agent-111");
  });

  test("D3: @app/agent-222 not in Repo A (only in Repo B)", async () => {
    const result = await resolveTarget("@app/agent-222", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("Agent not found: agent-222 in repo app"))).toBe(true);
  });

  test("D4: @unknown/agent-111 fails with repo not found", async () => {
    const result = await resolveTarget("@unknown/agent-111", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("repo not found: unknown"))).toBe(true);
  });

  test("D5: @libs/agent-111 cross-repo forbidden (agent-111 is in app, not libs)", async () => {
    const result = await resolveTarget("@libs/agent-111", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("Agent not found: agent-111 in repo libs"))).toBe(true);
  });

  test("D6: @app/agent-a prefix ambiguous with agent-abc only (agent-abd is in Repo B)", async () => {
    // Only agent-abc is in repoA, agent-abd is in repoB, so prefix "agent-a" matches only 1 in repoA
    const result = await resolveTarget("@app/agent-a", repos);
    expect(result.agent?.id).toBe("agent-abc");
  });

  test("D7: @app/agent-a ambiguous when Repo A has both agent-abc and agent-abd", async () => {
    addAgentToRepo(repoA.path, "agent-abd");
    const result = await resolveTarget("@app/agent-a", repos);
    expect(result.agent).toBeNull();
    const hasError = errorOutput.some((e) =>
      e.includes('Ambiguous ID "agent-a" in repo app matches:') &&
      e.includes("agent-abc") &&
      e.includes("agent-abd")
    );
    expect(hasError).toBe(true);
  });
});

// ============================================================
// Group E: Bare agent-id with same-repo-first logic
// ============================================================
describe("Group E: Bare agent-id (same-repo-first)", () => {
  beforeEach(() => {
    addAgentToRepo(repoA.path, "agent-111");
    addAgentToRepo(repoA.path, "agent-abc");
    addAgentToRepo(repoA.path, "worker-001");
    addAgentToRepo(repoB.path, "agent-222");
    addAgentToRepo(repoB.path, "agent-abd");
    addAgentToRepo(repoB.path, "worker-002");
  });

  test("E1: exact match in same repo", async () => {
    const result = await resolveTarget("agent-111", repos, repoA.path);
    expect(result.agent?.id).toBe("agent-111");
  });

  test("E2: same-repo-first - agent-abc in alpha AND agent-abc prefix in beta, alpha wins", async () => {
    // agent-abc is in repoA; from repoA CWD, it should find same-repo match first
    const result = await resolveTarget("agent-abc", repos, repoA.path);
    expect(result.agent?.id).toBe("agent-abc");
    expect(result.agent?.repoPath).toBe(repoA.path);
  });

  test("E3: prefix match unique in same repo", async () => {
    const result = await resolveTarget("agent-1", repos, repoA.path);
    expect(result.agent?.id).toBe("agent-111");
  });

  test("E4: prefix ambiguous in same repo does NOT fall back to global", async () => {
    // "agent-" matches agent-111 and agent-abc in repoA (2 matches)
    const result = await resolveTarget("agent-", repos, repoA.path);
    expect(result.agent).toBeNull();
    const hasError = errorOutput.some((e) =>
      e.includes('Ambiguous ID "agent-" in app matches:') &&
      e.includes("agent-111") &&
      e.includes("agent-abc")
    );
    expect(hasError).toBe(true);
  });

  test("E5: not in same repo, falls back to global", async () => {
    const result = await resolveTarget("agent-222", repos, repoA.path);
    expect(result.agent?.id).toBe("agent-222");
  });

  test("E6: not in same repo, prefix match in global", async () => {
    const result = await resolveTarget("agent-2", repos, repoA.path);
    expect(result.agent?.id).toBe("agent-222");
  });

  test("E7: global prefix ambiguous", async () => {
    // Add agent-2yy to repoB so "agent-2" matches 2 globally
    addAgentToRepo(repoB.path, "agent-2yy");
    const result = await resolveTarget("agent-2", repos, repoA.path);
    expect(result.agent).toBeNull();
    const hasError = errorOutput.some((e) =>
      e.includes('Ambiguous ID "agent-2" matches:') &&
      e.includes("agent-222") &&
      e.includes("agent-2yy")
    );
    expect(hasError).toBe(true);
  });

  test("E8: same-repo takes precedence when agent-id exists in both repos", async () => {
    // Put agent-xyz in both repos; from repoA, same-repo should win
    addAgentToRepo(repoA.path, "agent-xyz");
    addAgentToRepo(repoB.path, "agent-xyz");
    const result = await resolveTarget("agent-xyz", repos, repoA.path);
    expect(result.agent?.id).toBe("agent-xyz");
    expect(result.agent?.repoPath).toBe(repoA.path);
  });

  test("E9: outside all repos, global search finds agent", async () => {
    const result = await resolveTarget("agent-111", repos, "/tmp/outside");
    expect(result.agent?.id).toBe("agent-111");
  });

  test("E10: outside all repos, not found globally", async () => {
    const result = await resolveTarget("nonexistent-id", repos, "/tmp/outside");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("Agent not found: nonexistent-id"))).toBe(true);
  });

  test("E11: worker-001 found in same repo via prefix", async () => {
    const result = await resolveTarget("worker-0", repos, repoA.path);
    expect(result.agent?.id).toBe("worker-001");
  });
});

// ============================================================
// Group F: matchAgentById unit tests
// ============================================================
describe("Group F: matchAgentById unit tests", () => {
  const agents = [
    makeAgent({ id: "agent-111" }),
    makeAgent({ id: "agent-abc" }),
    makeAgent({ id: "worker-001" }),
  ];

  test("F1: exact match returns agent", () => {
    const result = matchAgentById("agent-111", agents);
    expect(result.match?.id).toBe("agent-111");
    expect(result.ambiguous).toEqual([]);
  });

  test("F2: prefix match (unique) returns agent", () => {
    const result = matchAgentById("agent-1", agents);
    expect(result.match?.id).toBe("agent-111");
    expect(result.ambiguous).toEqual([]);
  });

  test("F3: prefix match ambiguous returns null + ids", () => {
    const result = matchAgentById("agent-", agents);
    expect(result.match).toBeNull();
    expect(result.ambiguous).toEqual(["agent-111", "agent-abc"]);
  });

  test("F4: no match returns null + empty ambiguous", () => {
    const result = matchAgentById("nonexistent", agents);
    expect(result.match).toBeNull();
    expect(result.ambiguous).toEqual([]);
  });

  test("F5: exact match takes precedence over prefix matches", () => {
    const agentsWithOverlap = [
      makeAgent({ id: "agent-1" }),
      makeAgent({ id: "agent-11" }),
      makeAgent({ id: "agent-111" }),
    ];
    const result = matchAgentById("agent-1", agentsWithOverlap);
    expect(result.match?.id).toBe("agent-1");
    expect(result.ambiguous).toEqual([]);
  });

  test("F6: empty string prefix matches all agents (ambiguous)", () => {
    const result = matchAgentById("", agents);
    expect(result.match).toBeNull();
    expect(result.ambiguous).toEqual(["agent-111", "agent-abc", "worker-001"]);
  });

  test("F7: case-sensitive matching", () => {
    const result = matchAgentById("Agent-111", agents);
    expect(result.match).toBeNull();
    expect(result.ambiguous).toEqual([]);
  });

  test("F8: single agent in list, prefix match", () => {
    const single = [makeAgent({ id: "agent-foo-bar" })];
    const result = matchAgentById("agent-foo", single);
    expect(result.match?.id).toBe("agent-foo-bar");
    expect(result.ambiguous).toEqual([]);
  });
});

// ============================================================
// Group G: findOwnRepo edge cases via CWD param
// ============================================================
describe("Group G: findOwnRepo edge cases", () => {
  // We test findOwnRepo indirectly through resolveTarget's bare lookup behavior
  beforeEach(() => {
    addAgentToRepo(repoA.path, "agent-aaa");
  });

  test("G1: CWD exact match", async () => {
    const result = await resolveTarget("agent-aaa", repos, repoA.path);
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G2: CWD inside repo subdirectory (prefix match)", async () => {
    const cwdInside = join(repoA.path, "src", "deep", "nested");
    const result = await resolveTarget("agent-aaa", repos, cwdInside);
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G3: CWD in worktree path", async () => {
    const cwdWorktree = join(repoA.path, ".ittybitty", "agents", "agent-with-hyphens-123", "repo");
    const result = await resolveTarget("agent-aaa", repos, cwdWorktree);
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G4: CWD in worktree subdir does NOT match worktree regex", async () => {
    // Ends with /repo/src, not /repo — worktree regex fails, falls back to prefix match
    // But the path starts with repoA.path so prefix match succeeds
    const cwdWorktreeSubdir = join(repoA.path, ".ittybitty", "agents", "agent-abc", "repo", "src");
    const result = await resolveTarget("agent-aaa", repos, cwdWorktreeSubdir);
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G5: CWD outside all repos, ownRepo is null", async () => {
    // Still finds agent-aaa via global fallback
    const result = await resolveTarget("agent-aaa", repos, "/tmp/other/place");
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G6: worktree path with no matching repo returns null ownRepo", async () => {
    // Worktree path for unknown repo: extracts a path but no repo matches
    // Falls back to global search
    const unknownWorktree = "/tmp/unknown/.ittybitty/agents/agent-xyz/repo";
    const result = await resolveTarget("agent-aaa", repos, unknownWorktree);
    // ownRepo=null, falls back to global search
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G7: CWD is a prefix collision path (/app-data)", async () => {
    // repoA.path + "-data" does not match repoA.path path boundary, so ownRepo should be null
    // Agent found via global fallback
    const collisionPath = repoA.path + "-data";
    const result = await resolveTarget("agent-aaa", repos, collisionPath);
    expect(result.agent?.id).toBe("agent-aaa");
  });
});

// ============================================================
// Group K: Cross-cutting edge cases
// ============================================================
describe("Group K: Cross-cutting edge cases", () => {
  test("K1: @app/ with empty agentId falls through to coordinator lookup", async () => {
    // agentId = "" is falsy, so code treats @app/ same as @app (coordinator lookup)
    // No coordinator added, should fail
    const result = await resolveTarget("@app/", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("no coordinator found for repo app"))).toBe(true);
  });

  test("K2: @ alone treated as repo name empty string", async () => {
    const result = await resolveTarget("@", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("repo not found:"))).toBe(true);
  });

  test("K3: multi-repo same agent ID - same-repo first wins", async () => {
    addAgentToRepo(repoA.path, "agent-123");
    addAgentToRepo(repoB.path, "agent-123");
    const result = await resolveTarget("agent-123", repos, repoA.path);
    expect(result.agent?.repoPath).toBe(repoA.path);
  });

  test("K4: multi-repo same agent ID - explicit repo scoping overrides", async () => {
    addAgentToRepo(repoA.path, "agent-123");
    addAgentToRepo(repoB.path, "agent-123");
    const result = await resolveTarget("@libs/agent-123", repos);
    expect(result.agent?.repoPath).toBe(repoB.path);
  });

  test("K5: multi-repo coordinator routing via @coordinator uses CWD repo", async () => {
    addCoordinatorToRepo(repoA.path, "coord-a");
    addCoordinatorToRepo(repoB.path, "coord-b");
    const result = await resolveTarget("@coordinator", repos, repoA.path);
    expect(result.agent?.id).toBe("coord-a");
  });

  test("K6: multi-repo coordinator routing via @repo-name", async () => {
    addCoordinatorToRepo(repoA.path, "coord-a");
    addCoordinatorToRepo(repoB.path, "coord-b");
    const result = await resolveTarget("@libs", repos);
    expect(result.agent?.id).toBe("coord-b");
  });

  test("K7: special characters in bare ID - no match", async () => {
    // No agents added, test error path
    const result = await resolveTarget("agent@123", repos, "/tmp/outside");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("Agent not found: agent@123"))).toBe(true);
  });

  test("K8: multiple slashes in @-addressing parses first slash only", async () => {
    // No agents added, test error path
    const result = await resolveTarget("@app/agent/extra", repos);
    expect(result.agent).toBeNull();
    // agentId = "agent/extra", won't match any agent
    expect(errorOutput.some((e) => e.includes("Agent not found: agent/extra in repo app"))).toBe(true);
  });

  test("K9: @system/something treated as repo name 'system/something' — fails differently", async () => {
    // target starts with @ but is not "@system" exactly
    // afterAt = "system/something", slashIdx = 6, repoName = "system", agentId = "something"
    const result = await resolveTarget("@system/something", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("repo not found: system"))).toBe(true);
  });

  test("K10: agents are found and routed correctly from temp repos", async () => {
    // Verify that agents created in real temp directories are found and routed
    addAgentToRepo(repoA.path, "agent-111");
    const result = await resolveTarget("agent-111", repos, repoA.path);
    expect(result.agent?.id).toBe("agent-111");
  });
});

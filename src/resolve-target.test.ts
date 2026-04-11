import { test, expect, describe, beforeEach, jest, mock } from "bun:test";
import type { Agent } from "./agents";
import { makeAgent } from "./test-utils";
import type { RepoEntry } from "./registry";

// --- Mock agents module ---
const mockReadAllAgents = jest.fn<() => Promise<{ agents: Agent[]; errors: any[] }>>();

mock.module("./agents", () => ({
  readAllAgents: mockReadAllAgents,
  detectAgentStates: jest.fn(),
  buildAgentTree: jest.fn(),
  flattenAgentTree: jest.fn(),
  readPendingQuestions: jest.fn(),
  computeAge: () => "1m",
  isCompacting: () => false,
  isRateLimited: () => false,
  isWorkerLike: () => false,
  getAgentType: () => null,
}));

// --- Mock coordinator module ---
const mockCheckCoordinatorExists = jest.fn<(repoPath: string) => Promise<any>>();

mock.module("./coordinator", () => ({
  checkCoordinatorExists: mockCheckCoordinatorExists,
  coordinatorSpawnCtx: { runner: null },
}));

// Import after mocking
const { resolveTarget, matchAgentById } = await import("./index");

// --- Test helpers ---
const repoA: RepoEntry = { path: "/home/user/projects/app", name: "app" };
const repoB: RepoEntry = { path: "/home/user/projects/lib", name: "lib", nickname: "libs" };
const repoC: RepoEntry = { path: "/home/user/projects/api", name: "api", nickname: "backend" };
const repos = [repoA, repoB, repoC];

function agentIn(id: string, repo: RepoEntry): Agent {
  return makeAgent({ id, repoPath: repo.path, repoName: repo.nickname ?? repo.name });
}

function setupAgents(...agents: Agent[]) {
  mockReadAllAgents.mockResolvedValue({ agents, errors: [] });
}

// Capture console.error output
let errorOutput: string[];
const origError = console.error;
beforeEach(() => {
  errorOutput = [];
  console.error = (...args: any[]) => { errorOutput.push(args.join(" ")); };
  mockReadAllAgents.mockReset();
  mockCheckCoordinatorExists.mockReset();
});

// Restore after all tests (best effort)
process.on("exit", () => { console.error = origError; });

// ============================================================
// Group A: @system addressing
// ============================================================
describe("Group A: @system addressing", () => {
  test("A1: @system returns system coordinator", async () => {
    const result = await resolveTarget("@system", repos);
    expect(result).toEqual({ agent: null, isSystemCoordinator: true });
  });

  test("A2: @system does NOT call readAllAgents (fast path)", async () => {
    await resolveTarget("@system", repos);
    expect(mockReadAllAgents).not.toHaveBeenCalled();
  });

  test("A3: @System (wrong case) is not treated as @system", async () => {
    setupAgents();
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
    const coordAgent = agentIn("coord-xyz", repoA);
    setupAgents(coordAgent);
    mockCheckCoordinatorExists.mockResolvedValue({ exists: true, isCoordinator: true, agentId: "coord-xyz" });
    const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("coord-xyz");
    expect(result.isSystemCoordinator).toBe(false);
  });

  test("B2: @coordinator inside repo, no coordinator", async () => {
    mockCheckCoordinatorExists.mockResolvedValue({ exists: false, collision: false });
    const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("no coordinator found for repo app"))).toBe(true);
  });

  test("B3: @coordinator outside all repos", async () => {
    const result = await resolveTarget("@coordinator", repos, "/home/other/place");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("@coordinator requires running from within a repo"))).toBe(true);
  });

  test("B4: CWD exact match finds own repo", async () => {
    const coordAgent = agentIn("coord-a", repoA);
    setupAgents(coordAgent);
    mockCheckCoordinatorExists.mockResolvedValue({ exists: true, isCoordinator: true, agentId: "coord-a" });
    const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("coord-a");
    expect(mockCheckCoordinatorExists).toHaveBeenCalledWith("/home/user/projects/app");
  });

  test("B5: CWD inside repo (subdirectory) finds own repo via prefix", async () => {
    const coordAgent = agentIn("coord-a", repoA);
    setupAgents(coordAgent);
    mockCheckCoordinatorExists.mockResolvedValue({ exists: true, isCoordinator: true, agentId: "coord-a" });
    const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app/src/components");
    expect(result.agent?.id).toBe("coord-a");
  });

  test("B6: CWD in worktree finds own repo", async () => {
    const coordAgent = agentIn("coord-a", repoA);
    setupAgents(coordAgent);
    mockCheckCoordinatorExists.mockResolvedValue({ exists: true, isCoordinator: true, agentId: "coord-a" });
    const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app/.ittybitty/agents/agent-abc/repo");
    expect(result.agent?.id).toBe("coord-a");
  });

  test("B7: CWD prefix collision - /app-data does NOT match /app", async () => {
    setupAgents();
    // /home/user/projects/app-data doesn't start with /home/user/projects/app/
    const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app-data");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("@coordinator requires running from within a repo"))).toBe(true);
  });
});

// ============================================================
// Group C: @repo-name coordinator lookup
// ============================================================
describe("Group C: @repo-name coordinator lookup", () => {
  test("C1: @app finds Repo A coordinator by basename", async () => {
    const coordAgent = agentIn("coord-app", repoA);
    setupAgents(coordAgent);
    mockCheckCoordinatorExists.mockResolvedValue({ exists: true, isCoordinator: true, agentId: "coord-app" });
    const result = await resolveTarget("@app", repos);
    expect(result.agent?.id).toBe("coord-app");
  });

  test("C2: @libs finds Repo B coordinator by nickname", async () => {
    const coordAgent = agentIn("coord-lib", repoB);
    setupAgents(coordAgent);
    mockCheckCoordinatorExists.mockResolvedValue({ exists: true, isCoordinator: true, agentId: "coord-lib" });
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
    mockCheckCoordinatorExists.mockResolvedValue({ exists: false, collision: false });
    const result = await resolveTarget("@app", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("no coordinator found for repo app"))).toBe(true);
  });
});

// ============================================================
// Group D: @repo/agent-id scoped lookup
// ============================================================
describe("Group D: @repo/agent-id scoped lookup", () => {
  const agent111 = agentIn("agent-111", repoA);
  const agentAbc = agentIn("agent-abc", repoA);
  const agent222 = agentIn("agent-222", repoB);
  const agentAbd = agentIn("agent-abd", repoB);

  beforeEach(() => {
    setupAgents(agent111, agentAbc, agent222, agentAbd);
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
    const abdInA = agentIn("agent-abd", repoA);
    setupAgents(agent111, agentAbc, abdInA, agent222);
    const result = await resolveTarget("@app/agent-a", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes('Ambiguous ID "agent-a" in repo app matches: agent-abc, agent-abd'))).toBe(true);
  });
});

// ============================================================
// Group E: Bare agent-id with same-repo-first logic
// ============================================================
describe("Group E: Bare agent-id (same-repo-first)", () => {
  const agent111 = agentIn("agent-111", repoA);
  const agentAbc = agentIn("agent-abc", repoA);
  const worker001 = agentIn("worker-001", repoA);
  const agent222 = agentIn("agent-222", repoB);
  const agentAbd = agentIn("agent-abd", repoB);
  const worker002 = agentIn("worker-002", repoB);

  beforeEach(() => {
    setupAgents(agent111, agentAbc, worker001, agent222, agentAbd, worker002);
  });

  test("E1: exact match in same repo", async () => {
    const result = await resolveTarget("agent-111", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("agent-111");
  });

  test("E2: same-repo-first - agent-abc in alpha AND agent-abc prefix in beta, alpha wins", async () => {
    // agent-abc is in repoA; from repoA CWD, it should find same-repo match first
    const result = await resolveTarget("agent-abc", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("agent-abc");
    expect(result.agent?.repoPath).toBe(repoA.path);
  });

  test("E3: prefix match unique in same repo", async () => {
    const result = await resolveTarget("agent-1", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("agent-111");
  });

  test("E4: prefix ambiguous in same repo does NOT fall back to global", async () => {
    // "agent-" matches agent-111 and agent-abc in repoA (2 matches)
    const result = await resolveTarget("agent-", repos, "/home/user/projects/app");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes('Ambiguous ID "agent-" in app matches: agent-111, agent-abc'))).toBe(true);
  });

  test("E5: not in same repo, falls back to global", async () => {
    const result = await resolveTarget("agent-222", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("agent-222");
  });

  test("E6: not in same repo, prefix match in global", async () => {
    const result = await resolveTarget("agent-2", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("agent-222");
  });

  test("E7: global prefix ambiguous", async () => {
    // Add agent-2yy to repoB so "agent-2" matches 2 globally
    const agent2yy = agentIn("agent-2yy", repoB);
    setupAgents(agent111, agentAbc, worker001, agent222, agentAbd, worker002, agent2yy);
    const result = await resolveTarget("agent-2", repos, "/home/user/projects/app");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes('Ambiguous ID "agent-2" matches:'))).toBe(true);
  });

  test("E8: same-repo takes precedence when agent-id exists in both repos", async () => {
    // Put agent-xyz in both repos; from repoA, same-repo should win
    const xyzA = agentIn("agent-xyz", repoA);
    const xyzB = agentIn("agent-xyz", repoB);
    setupAgents(xyzA, xyzB);
    const result = await resolveTarget("agent-xyz", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("agent-xyz");
    expect(result.agent?.repoPath).toBe(repoA.path);
  });

  test("E9: outside all repos, global search finds agent", async () => {
    const result = await resolveTarget("agent-111", repos, "/home/other");
    expect(result.agent?.id).toBe("agent-111");
  });

  test("E10: outside all repos, not found globally", async () => {
    const result = await resolveTarget("nonexistent-id", repos, "/home/other");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("Agent not found: nonexistent-id"))).toBe(true);
  });

  test("E11: worker-001 found in same repo via prefix", async () => {
    const result = await resolveTarget("worker-0", repos, "/home/user/projects/app");
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
  const agentA = agentIn("agent-aaa", repoA);

  beforeEach(() => {
    setupAgents(agentA);
  });

  test("G1: CWD exact match", async () => {
    const result = await resolveTarget("agent-aaa", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G2: CWD inside repo subdirectory (prefix match)", async () => {
    const result = await resolveTarget("agent-aaa", repos, "/home/user/projects/app/src/deep/nested");
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G3: CWD in worktree path", async () => {
    const result = await resolveTarget("agent-aaa", repos, "/home/user/projects/app/.ittybitty/agents/agent-with-hyphens-123/repo");
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G4: CWD in worktree subdir does NOT match worktree regex", async () => {
    // Ends with /repo/src, not /repo — worktree regex fails, falls back to prefix match
    // But /home/user/projects/app/.ittybitty/agents/.../repo/src starts with /home/user/projects/app/
    // so prefix match succeeds
    const result = await resolveTarget("agent-aaa", repos, "/home/user/projects/app/.ittybitty/agents/agent-abc/repo/src");
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G5: CWD outside all repos, ownRepo is null", async () => {
    // Still finds agent-aaa via global fallback
    const result = await resolveTarget("agent-aaa", repos, "/home/other/place");
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G6: worktree path with no matching repo returns null ownRepo", async () => {
    // Worktree path for unknown repo: extracts /home/user/projects/unknown but no repo matches
    setupAgents(agentA);
    const result = await resolveTarget("agent-aaa", repos, "/home/user/projects/unknown/.ittybitty/agents/agent-xyz/repo");
    // ownRepo=null, falls back to global search
    expect(result.agent?.id).toBe("agent-aaa");
  });

  test("G7: CWD is a prefix collision path (/app-data)", async () => {
    // /app-data does not start with /app/, so ownRepo should be null
    // Agent found via global fallback
    const result = await resolveTarget("agent-aaa", repos, "/home/user/projects/app-data");
    expect(result.agent?.id).toBe("agent-aaa");
  });
});

// ============================================================
// Group K: Cross-cutting edge cases
// ============================================================
describe("Group K: Cross-cutting edge cases", () => {
  test("K1: @app/ with empty agentId falls through to coordinator lookup", async () => {
    // agentId = "" is falsy, so code treats @app/ same as @app (coordinator lookup)
    mockCheckCoordinatorExists.mockResolvedValue({ exists: false, collision: false });
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
    const a123A = agentIn("agent-123", repoA);
    const a123B = agentIn("agent-123", repoB);
    setupAgents(a123A, a123B);
    const result = await resolveTarget("agent-123", repos, "/home/user/projects/app");
    expect(result.agent?.repoPath).toBe(repoA.path);
  });

  test("K4: multi-repo same agent ID - explicit repo scoping overrides", async () => {
    const a123A = agentIn("agent-123", repoA);
    const a123B = agentIn("agent-123", repoB);
    setupAgents(a123A, a123B);
    const result = await resolveTarget("@libs/agent-123", repos);
    expect(result.agent?.repoPath).toBe(repoB.path);
  });

  test("K5: multi-repo coordinator routing via @coordinator uses CWD repo", async () => {
    const coordA = agentIn("coord-a", repoA);
    const coordB = agentIn("coord-b", repoB);
    setupAgents(coordA, coordB);
    mockCheckCoordinatorExists.mockResolvedValue({ exists: true, isCoordinator: true, agentId: "coord-a" });
    const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("coord-a");
  });

  test("K6: multi-repo coordinator routing via @repo-name", async () => {
    const coordA = agentIn("coord-a", repoA);
    const coordB = agentIn("coord-b", repoB);
    setupAgents(coordA, coordB);
    mockCheckCoordinatorExists.mockResolvedValue({ exists: true, isCoordinator: true, agentId: "coord-b" });
    const result = await resolveTarget("@libs", repos);
    expect(result.agent?.id).toBe("coord-b");
  });

  test("K7: special characters in bare ID - no match", async () => {
    setupAgents();
    const result = await resolveTarget("agent@123", repos, "/home/other");
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("Agent not found: agent@123"))).toBe(true);
  });

  test("K8: multiple slashes in @-addressing parses first slash only", async () => {
    setupAgents();
    const result = await resolveTarget("@app/agent/extra", repos);
    expect(result.agent).toBeNull();
    // agentId = "agent/extra", won't match any agent
    expect(errorOutput.some((e) => e.includes("Agent not found: agent/extra in repo app"))).toBe(true);
  });

  test("K9: @system/something treated as repo name 'system/something' — fails differently", async () => {
    // target starts with @ but is not "@system" exactly
    // afterAt = "system/something", slashIdx = 6, repoName = "system", agentId = "something"
    setupAgents();
    const result = await resolveTarget("@system/something", repos);
    expect(result.agent).toBeNull();
    expect(errorOutput.some((e) => e.includes("repo not found: system"))).toBe(true);
  });

  test("K10: readAllAgents returns errors but still has agents — routing still works", async () => {
    const a1 = agentIn("agent-111", repoA);
    mockReadAllAgents.mockResolvedValue({ agents: [a1], errors: [{ path: "/broken", error: "bad" }] });
    const result = await resolveTarget("agent-111", repos, "/home/user/projects/app");
    expect(result.agent?.id).toBe("agent-111");
  });
});

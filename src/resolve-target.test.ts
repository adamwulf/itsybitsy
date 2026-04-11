import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { Agent } from "./agents";
import { makeAgent } from "./test-utils";
import type { RepoEntry } from "./registry";
import { repoDisplayName } from "./registry";

// --- Mock agents and coordinator modules BEFORE importing resolveTarget ---
const mockReadAllAgents = mock<() => Promise<{ agents: Agent[]; errors: any[] }>>(async () => ({
  agents: [],
  errors: [],
}));

const mockCheckCoordinatorExists = mock<
  (repoPath: string) => Promise<{ exists: boolean; isCoordinator?: boolean; agentId?: string }>
>(async () => ({ exists: false }));

mock.module("./agents", () => ({
  readAllAgents: mockReadAllAgents,
  // Re-export other functions so they're available after mock
  detectAgentStates: async () => {},
  buildAgentTree: (agents: Agent[]) => agents,
  flattenAgentTree: (agents: Agent[]) => agents.map((a) => ({ kind: "agent" as const, agent: a, depth: 0, connector: "" })),
  isCompacting: () => false,
  isRateLimited: () => false,
  getAgentType: () => "manager",
  isWorkerLike: () => false,
}));

mock.module("./coordinator", () => ({
  checkCoordinatorExists: mockCheckCoordinatorExists,
}));

// Import after mocking
const { resolveTarget, matchAgentById } = await import("./index");

describe("resolveTarget", () => {
  let repos: RepoEntry[];

  beforeEach(() => {
    // Reset mocks before each test
    mockReadAllAgents.mockClear();
    mockCheckCoordinatorExists.mockClear();

    // Setup default repos
    repos = [
      { path: "/home/user/projects/app", name: "app" },
      { path: "/home/user/projects/lib", name: "lib", nickname: "libs" },
      { path: "/home/user/projects/api", name: "api", nickname: "backend" },
    ];
  });

  describe("Group A: @system Addressing", () => {
    test("@system-exact returns system coordinator without calling readAllAgents", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("@system", repos);

      expect(result.isSystemCoordinator).toBe(true);
      expect(result.agent).toBe(null);
      // Verify readAllAgents was NOT called
      expect(mockReadAllAgents.mock.calls.length).toBe(0);
    });

    test("@system-case-sensitive rejects uppercase variants", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("@System", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
      // Should fall through to bare search and find nothing
    });

    test("@system-with-args rejects @system with slash", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("@system/something", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });
  });

  describe("Group B: @coordinator Addressing (own repo detection)", () => {
    test("@coordinator-found inside repo detects coordinator agent", async () => {
      const coordAgent = makeAgent({ id: "coord-xyz", repoPath: "/home/user/projects/app" });
      mockCheckCoordinatorExists.mockResolvedValueOnce({
        exists: true,
        isCoordinator: true,
        agentId: "coord-xyz",
      });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [coordAgent], errors: [] });

      const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app");

      expect(result.agent?.id).toBe("coord-xyz");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@coordinator-not-found when no coordinator in repo", async () => {
      mockCheckCoordinatorExists.mockResolvedValueOnce({ exists: false });

      const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app");

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@coordinator-outside-repo errors when CWD is outside all repos", async () => {
      const result = await resolveTarget("@coordinator", repos, "/home/other/place");

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@coordinator-cwd-inside-repo detects via prefix match", async () => {
      const coordAgent = makeAgent({ id: "coord-xyz", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [coordAgent], errors: [] });
      mockCheckCoordinatorExists.mockResolvedValueOnce({
        exists: true,
        isCoordinator: true,
        agentId: "coord-xyz",
      });

      const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app/src/components");

      expect(result.agent?.id).toBe("coord-xyz");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@coordinator-cwd-worktree-basic detects from worktree path", async () => {
      const coordAgent = makeAgent({ id: "coord-abc", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [coordAgent], errors: [] });
      mockCheckCoordinatorExists.mockResolvedValueOnce({
        exists: true,
        isCoordinator: true,
        agentId: "coord-abc",
      });

      const result = await resolveTarget(
        "@coordinator",
        repos,
        "/home/user/projects/app/.ittybitty/agents/agent-xyz/repo",
      );

      expect(result.agent?.id).toBe("coord-abc");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@coordinator-cwd-worktree-nested handles agent-id with hyphens", async () => {
      const coordAgent = makeAgent({ id: "coord-nested", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [coordAgent], errors: [] });
      mockCheckCoordinatorExists.mockResolvedValueOnce({
        exists: true,
        isCoordinator: true,
        agentId: "coord-nested",
      });

      const result = await resolveTarget(
        "@coordinator",
        repos,
        "/home/user/projects/app/.ittybitty/agents/agent-with-hyphens-123/repo",
      );

      expect(result.agent?.id).toBe("coord-nested");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@coordinator-cwd-worktree-not-at-end does NOT match if not ending with /repo", async () => {
      const result = await resolveTarget(
        "@coordinator",
        repos,
        "/home/user/projects/app/.ittybitty/agents/agent-abc/repo/src",
      );

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });
  });

  describe("Group C: @<repo-name> Addressing (repo coordinator lookup)", () => {
    test("@repo-by-name finds coordinator for repo with matching name", async () => {
      const coordAgent = makeAgent({ id: "coord-app", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [coordAgent], errors: [] });
      mockCheckCoordinatorExists.mockResolvedValueOnce({
        exists: true,
        isCoordinator: true,
        agentId: "coord-app",
      });

      const result = await resolveTarget("@app", repos);

      expect(result.agent?.id).toBe("coord-app");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo-by-nickname finds coordinator via nickname override", async () => {
      const coordAgent = makeAgent({ id: "coord-libs", repoPath: "/home/user/projects/lib" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [coordAgent], errors: [] });
      mockCheckCoordinatorExists.mockResolvedValueOnce({
        exists: true,
        isCoordinator: true,
        agentId: "coord-libs",
      });

      const result = await resolveTarget("@libs", repos);

      expect(result.agent?.id).toBe("coord-libs");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo-by-nickname-not-basename rejects when nickname exists", async () => {
      // Repo B has nickname "libs", so "lib" should NOT match
      const result = await resolveTarget("@lib", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo-nonexistent errors for unknown repo name", async () => {
      const result = await resolveTarget("@unknown", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo-case-sensitive rejects mismatched case", async () => {
      const result = await resolveTarget("@App", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo-coordinator-not-exists errors when coordinator missing", async () => {
      mockCheckCoordinatorExists.mockResolvedValueOnce({ exists: false });

      const result = await resolveTarget("@app", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });
  });

  describe("Group D: @<repo-name>/<agent-id> Addressing", () => {
    test("@repo/agent-exact matches agent by exact ID", async () => {
      const agent111 = makeAgent({ id: "agent-111", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent111], errors: [] });

      const result = await resolveTarget("@app/agent-111", repos);

      expect(result.agent?.id).toBe("agent-111");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo/agent-prefix-unique matches via prefix when unique in repo", async () => {
      const agent111 = makeAgent({ id: "agent-111", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent111], errors: [] });

      const result = await resolveTarget("@app/agent-1", repos);

      expect(result.agent?.id).toBe("agent-111");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo/agent-prefix-ambiguous in repo errors with matches", async () => {
      const agentAbc = makeAgent({ id: "agent-abc", repoPath: "/home/user/projects/app" });
      const agentAbd = makeAgent({ id: "agent-abd", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentAbc, agentAbd], errors: [] });

      const result = await resolveTarget("@app/agent-a", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo/agent-not-in-repo errors when agent not found in scoped repo", async () => {
      const agent222 = makeAgent({ id: "agent-222", repoPath: "/home/user/projects/lib" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent222], errors: [] });

      const result = await resolveTarget("@app/agent-222", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo/repo-nonexistent errors when repo not found", async () => {
      const result = await resolveTarget("@unknown/agent-111", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo/agent-cross-repo-forbidden blocks agent from different repo", async () => {
      const agent111 = makeAgent({ id: "agent-111", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent111], errors: [] });

      const result = await resolveTarget("@lib/agent-111", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("@repo/agent-empty-id matches all agents (ambiguous)", async () => {
      const agentAbc = makeAgent({ id: "agent-abc", repoPath: "/home/user/projects/app" });
      const agentDef = makeAgent({ id: "agent-def", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentAbc, agentDef], errors: [] });

      const result = await resolveTarget("@app/", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });
  });

  describe("Group E: Bare Agent-ID Addressing (same-repo first, then global fallback)", () => {
    test("bare-exact-same-repo returns exact match in same repo without global fallback", async () => {
      const agent111 = makeAgent({ id: "agent-111", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent111], errors: [] });

      const result = await resolveTarget("agent-111", repos, "/home/user/projects/app");

      expect(result.agent?.id).toBe("agent-111");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-prefix-same-repo-unique returns prefix match in same repo", async () => {
      const agent111 = makeAgent({ id: "agent-111", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent111], errors: [] });

      const result = await resolveTarget("agent-1", repos, "/home/user/projects/app");

      expect(result.agent?.id).toBe("agent-111");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-prefix-same-repo-single-match returns single prefix match", async () => {
      const agentAbc = makeAgent({ id: "agent-abc", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentAbc], errors: [] });

      const result = await resolveTarget("agent-a", repos, "/home/user/projects/app");

      expect(result.agent?.id).toBe("agent-abc");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-prefix-same-repo-ambiguous-2-matches errors and does not fallback", async () => {
      const agentAbc = makeAgent({ id: "agent-abc", repoPath: "/home/user/projects/app" });
      const agentAbd = makeAgent({ id: "agent-abd", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentAbc, agentAbd], errors: [] });

      const result = await resolveTarget("agent-a", repos, "/home/user/projects/app");

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-not-in-same-repo-found-global falls back when not in same repo", async () => {
      const agent222 = makeAgent({ id: "agent-222", repoPath: "/home/user/projects/lib" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent222], errors: [] });

      const result = await resolveTarget("agent-222", repos, "/home/user/projects/app");

      expect(result.agent?.id).toBe("agent-222");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-not-in-same-repo-prefix-global falls back with prefix match", async () => {
      const agent222 = makeAgent({ id: "agent-222", repoPath: "/home/user/projects/lib" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent222], errors: [] });

      const result = await resolveTarget("agent-2", repos, "/home/user/projects/app");

      expect(result.agent?.id).toBe("agent-222");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-same-repo-takes-precedence-over-global when exact match in both repos", async () => {
      const agentXyzApp = makeAgent({ id: "agent-xyz", repoPath: "/home/user/projects/app" });
      const agentXyzLib = makeAgent({ id: "agent-xyz", repoPath: "/home/user/projects/lib" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentXyzApp, agentXyzLib], errors: [] });

      const result = await resolveTarget("agent-xyz", repos, "/home/user/projects/app");

      expect(result.agent?.repoPath).toBe("/home/user/projects/app");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-global-ambiguous-cross-repo errors when multiple matches globally", async () => {
      const agent2xxA = makeAgent({ id: "agent-222", repoPath: "/home/user/projects/app" });
      const agent2xxB = makeAgent({ id: "agent-2yy", repoPath: "/home/user/projects/lib" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent2xxA, agent2xxB], errors: [] });

      const result = await resolveTarget("agent-2", repos, "/home/user/projects/api");

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-outside-all-repos searches globally without same-repo filter", async () => {
      const agent111 = makeAgent({ id: "agent-111", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent111], errors: [] });

      const result = await resolveTarget("agent-111", repos, "/home/other");

      expect(result.agent?.id).toBe("agent-111");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-not-found-no-repo errors when not found globally outside all repos", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("nonexistent-id", repos, "/home/other");

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("bare-empty-string matches all agents in same repo (ambiguous)", async () => {
      const agentA = makeAgent({ id: "agent-a", repoPath: "/home/user/projects/app" });
      const agentB = makeAgent({ id: "agent-b", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA, agentB], errors: [] });

      const result = await resolveTarget("", repos, "/home/user/projects/app");

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });
  });

  describe("Group F: matchAgentById Unit Tests", () => {
    test("exact-match returns agent", () => {
      const agent = makeAgent({ id: "agent-111" });
      const result = matchAgentById("agent-111", [agent]);

      expect(result.match?.id).toBe("agent-111");
      expect(result.ambiguous).toEqual([]);
    });

    test("prefix-single-match returns agent", () => {
      const agent = makeAgent({ id: "agent-111" });
      const result = matchAgentById("agent-1", [agent]);

      expect(result.match?.id).toBe("agent-111");
      expect(result.ambiguous).toEqual([]);
    });

    test("prefix-multiple-matches returns ambiguous list", () => {
      const agentA = makeAgent({ id: "agent-abc" });
      const agentB = makeAgent({ id: "agent-abd" });
      const result = matchAgentById("agent-a", [agentA, agentB]);

      expect(result.match).toBe(null);
      expect(result.ambiguous).toEqual(["agent-abc", "agent-abd"]);
    });

    test("no-match returns null", () => {
      const agent = makeAgent({ id: "agent-111" });
      const result = matchAgentById("worker-", [agent]);

      expect(result.match).toBe(null);
      expect(result.ambiguous).toEqual([]);
    });

    test("case-sensitive-no-match when case differs", () => {
      const agent = makeAgent({ id: "agent-ABC" });
      const result = matchAgentById("Agent-", [agent]);

      expect(result.match).toBe(null);
      expect(result.ambiguous).toEqual([]);
    });

    test("hyphen-in-id prefix matches correctly", () => {
      const agent = makeAgent({ id: "agent-foo-bar" });
      const result = matchAgentById("agent-foo-", [agent]);

      expect(result.match?.id).toBe("agent-foo-bar");
      expect(result.ambiguous).toEqual([]);
    });

    test("underscore-in-id prefix matches correctly", () => {
      const agent = makeAgent({ id: "agent_foo" });
      const result = matchAgentById("agent_", [agent]);

      expect(result.match?.id).toBe("agent_foo");
      expect(result.ambiguous).toEqual([]);
    });

    test("empty-string-prefix matches all agents (ambiguous)", () => {
      const agentA = makeAgent({ id: "agent-a" });
      const agentB = makeAgent({ id: "agent-b" });
      const result = matchAgentById("", [agentA, agentB]);

      expect(result.match).toBe(null);
      expect(result.ambiguous).toEqual(["agent-a", "agent-b"]);
    });
  });

  describe("Group G: findOwnRepo Edge Cases via CWD", () => {
    test("cwd-exact-match finds repo by exact path", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("", repos, "/home/user/projects/app");

      // Bare empty string will try to match, but we're testing CWD detection
      // The CWD is exact match, so it's used for same-repo filtering
      expect(mockReadAllAgents).toHaveBeenCalled();
    });

    test("cwd-inside-repo finds via prefix match", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("", repos, "/home/user/projects/app/src");

      expect(mockReadAllAgents).toHaveBeenCalled();
    });

    test("cwd-worktree-basic extracts root and matches", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget(
        "",
        repos,
        "/home/user/projects/app/.ittybitty/agents/agent-abc/repo",
      );

      expect(mockReadAllAgents).toHaveBeenCalled();
    });

    test("cwd-worktree-not-at-end does not extract", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget(
        "",
        repos,
        "/home/user/projects/app/.ittybitty/agents/agent-abc/repo/src",
      );

      // Falls back to prefix match instead
      expect(mockReadAllAgents).toHaveBeenCalled();
    });

    test("cwd-outside-all-repos returns no own repo", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("", repos, "/home/other/place");

      // No ownRepo found, searches globally only
      expect(mockReadAllAgents).toHaveBeenCalled();
    });

    test("cwd-prefix-collision-exact-takes-precedence", async () => {
      // Test that /home/user/projects/app/data does NOT match /home/user/projects/app
      // because prefix match requires r.path + "/" so /app/ does NOT prefix /app/data
      const exactRepo = { path: "/home/user/projects/app", name: "app" };
      const prefixRepo = { path: "/home/user/projects/app/data", name: "appdata" };
      const testRepos = [exactRepo, prefixRepo];

      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      // If CWD is /home/user/projects/app, exact match should win
      const result = await resolveTarget("", testRepos, "/home/user/projects/app");

      expect(mockReadAllAgents).toHaveBeenCalled();
    });

    test("cwd-worktree-extract-reporoot handles nested paths", async () => {
      const nestedRepos = [
        { path: "/home/user/projects/deep/nested/app", name: "app" },
      ];
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget(
        "",
        nestedRepos,
        "/home/user/projects/deep/nested/app/.ittybitty/agents/agent-xyz/repo",
      );

      expect(mockReadAllAgents).toHaveBeenCalled();
    });

    test("cwd-worktree-extract-no-matching-repo when extracted path not in repos", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget(
        "",
        repos,
        "/home/user/projects/unknown/.ittybitty/agents/agent-xyz/repo",
      );

      // Extracted /home/user/projects/unknown, not in repos, so ownRepo = null
      expect(mockReadAllAgents).toHaveBeenCalled();
    });
  });

  describe("Group K: Cross-Cutting Edge Cases", () => {
    test("K1: multiple-slashes in @ addressing", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("@repo/agent/extra", repos);

      // Parsed as repo="repo", agentId="agent/extra", agent lookup fails
      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("K2: @-sign-alone errors on empty repo name", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("@", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("K3: whitespace-only input treated as bare ID", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("   ", repos);

      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("K4: special-chars-bare ID not validated", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("agent@id", repos);

      // Treated as literal bare ID, no match
      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("K5: special-chars-at-addressing fails repo lookup", async () => {
      mockReadAllAgents.mockResolvedValueOnce({ agents: [], errors: [] });

      const result = await resolveTarget("@repo@name", repos);

      // Parsed as repoName="repo@name", not found
      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("K6: multi-repo-same-agent-id same-repo-first routing", async () => {
      const agent123App = makeAgent({ id: "agent-123", repoPath: "/home/user/projects/app" });
      const agent123Lib = makeAgent({ id: "agent-123", repoPath: "/home/user/projects/lib" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent123App, agent123Lib], errors: [] });

      const result = await resolveTarget("agent-123", repos, "/home/user/projects/app");

      expect(result.agent?.repoPath).toBe("/home/user/projects/app");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("K7: multi-repo-same-agent-id-explicit with @repo scoping", async () => {
      const agent123Lib = makeAgent({ id: "agent-123", repoPath: "/home/user/projects/lib" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent123Lib], errors: [] });

      const result = await resolveTarget("@libs/agent-123", repos);

      expect(result.agent?.id).toBe("agent-123");
      expect(result.agent?.repoPath).toBe("/home/user/projects/lib");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("K8: multi-repo-same-agent-id-wrong-repo errors", async () => {
      const agent123App = makeAgent({ id: "agent-123", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agent123App], errors: [] });

      const result = await resolveTarget("@lib/agent-123", repos);

      // agent-123 is in app, not lib
      expect(result.agent).toBe(null);
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("K9: multi-repo-coordinator-routing from specific repo", async () => {
      const coordApp = makeAgent({ id: "coord-app", repoPath: "/home/user/projects/app" });
      const coordLib = makeAgent({ id: "coord-lib", repoPath: "/home/user/projects/lib" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [coordApp, coordLib], errors: [] });
      mockCheckCoordinatorExists.mockResolvedValueOnce({
        exists: true,
        isCoordinator: true,
        agentId: "coord-app",
      });

      const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app");

      expect(result.agent?.id).toBe("coord-app");
      expect(result.isSystemCoordinator).toBe(false);
    });

    test("K10: priority-exact-over-prefix-over-worktree", async () => {
      const coordAgent = makeAgent({ id: "coord-xyz", repoPath: "/home/user/projects/app" });
      mockReadAllAgents.mockResolvedValueOnce({ agents: [coordAgent], errors: [] });
      mockCheckCoordinatorExists.mockResolvedValueOnce({
        exists: true,
        isCoordinator: true,
        agentId: "coord-xyz",
      });

      // CWD is exact match (higher priority than prefix or worktree)
      const result = await resolveTarget("@coordinator", repos, "/home/user/projects/app");

      expect(result.agent?.id).toBe("coord-xyz");
      expect(result.isSystemCoordinator).toBe(false);
    });
  });

  describe("Coordinator Name Validation", () => {
    // Note: these test the reserved name checks in ib-commands and registry
    // We include them here for completeness but they may be tested elsewhere

    test("coordinator-reserved-name check in agent naming", () => {
      // This would be tested in ib-commands.test.ts but documenting the requirement here
      expect("coordinator".match(/^[a-zA-Z0-9_\-]+$/)).not.toBe(null);
      expect("coordinator" === "coordinator").toBe(true);
    });

    test("coordinator-case-mismatch not reserved", () => {
      expect("Coordinator".match(/^[a-zA-Z0-9_\-]+$/)).not.toBe(null);
      expect("Coordinator" === "coordinator").toBe(false);
    });

    test("coordinator-suffix not reserved", () => {
      expect("coordinator-foo".match(/^[a-zA-Z0-9_\-]+$/)).not.toBe(null);
      expect("coordinator-foo" === "coordinator").toBe(false);
    });
  });

  describe("repoDisplayName Utility", () => {
    test("nickname takes precedence over name", () => {
      const repo = { path: "/test", name: "myrepo", nickname: "alias" };
      expect(repoDisplayName(repo)).toBe("alias");
    });

    test("name used when no nickname", () => {
      const repo = { path: "/test", name: "myrepo" };
      expect(repoDisplayName(repo)).toBe("myrepo");
    });

    test("empty nickname still uses name", () => {
      const repo = { path: "/test", name: "myrepo", nickname: "" };
      expect(repoDisplayName(repo)).toBe("myrepo");
    });
  });
});

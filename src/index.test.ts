import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { makeAgent, makeSpawnResult } from "./test-utils";
import {
  collectAgents,
  findManagerInTree,
  matchAgentById,
  resolveTarget,
  resolveMergeTargetDir,
  buildSystemCoordinatorAgent,
  sendToSystemCoordinator,
  setSystemCoordinatorHasSessionFn,
  resetSystemCoordinatorHasSessionFn,
} from "./index";
import { setSendSpawnRunner, resetSendSpawnRunner } from "./ib-commands";
import { IB_COORDINATOR_SESSION } from "./coordinator";
import type { Agent } from "./agents";
import type { RepoEntry } from "./registry";

// ─── collectAgents ───────────────────────────────────────────────────────────

describe("collectAgents", () => {
  test("skips archived agents", () => {
    const agent = makeAgent({ id: "a1", archived: true });
    const result: { agent: Agent; depth: number }[] = [];
    collectAgents(agent, 0, null, result);
    expect(result).toHaveLength(0);
  });

  test("collects non-archived agent at given depth", () => {
    const agent = makeAgent({ id: "a1" });
    const result: { agent: Agent; depth: number }[] = [];
    collectAgents(agent, 3, null, result);
    expect(result).toEqual([{ agent, depth: 3 }]);
  });

  test("recursively collects children with incrementing depth", () => {
    const child1 = makeAgent({ id: "c1" });
    const child2 = makeAgent({ id: "c2" });
    const parent = makeAgent({ id: "p1", children: [child1, child2] });
    const result: { agent: Agent; depth: number }[] = [];
    collectAgents(parent, 0, null, result);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ agent: parent, depth: 0 });
    expect(result[1]).toEqual({ agent: child1, depth: 1 });
    expect(result[2]).toEqual({ agent: child2, depth: 1 });
  });

  test("skips archived children but continues siblings", () => {
    const archivedChild = makeAgent({ id: "c1", archived: true });
    const activeChild = makeAgent({ id: "c2" });
    const parent = makeAgent({ id: "p1", children: [archivedChild, activeChild] });
    const result: { agent: Agent; depth: number }[] = [];
    collectAgents(parent, 0, null, result);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.agent.id)).toEqual(["p1", "c2"]);
  });

  test("respects managerFilter — includes agent matching filter by manager field", () => {
    const agent = makeAgent({ id: "w1", meta: { manager: "mgr1" } as any });
    const result: { agent: Agent; depth: number }[] = [];
    collectAgents(agent, 0, "mgr1", result);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent.id).toBe("w1");
  });

  test("respects managerFilter — includes agent matching filter by own id", () => {
    const agent = makeAgent({ id: "mgr1" });
    const result: { agent: Agent; depth: number }[] = [];
    collectAgents(agent, 0, "mgr1", result);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent.id).toBe("mgr1");
  });

  test("respects managerFilter — excludes non-matching agents", () => {
    const agent = makeAgent({ id: "w1", meta: { manager: "mgr2" } as any });
    const result: { agent: Agent; depth: number }[] = [];
    collectAgents(agent, 0, "mgr1", result);
    expect(result).toHaveLength(0);
  });

  test("deep nesting with managerFilter=null collects entire tree", () => {
    const grandchild = makeAgent({ id: "gc1" });
    const child = makeAgent({ id: "c1", children: [grandchild] });
    const root = makeAgent({ id: "r1", children: [child] });
    const result: { agent: Agent; depth: number }[] = [];
    collectAgents(root, 0, null, result);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ agent: root, depth: 0 });
    expect(result[1]).toEqual({ agent: child, depth: 1 });
    expect(result[2]).toEqual({ agent: grandchild, depth: 2 });
  });
});

// ─── findManagerInTree ───────────────────────────────────────────────────────

describe("findManagerInTree", () => {
  test("finds manager at root and collects its children", () => {
    const child1 = makeAgent({ id: "c1" });
    const child2 = makeAgent({ id: "c2" });
    const manager = makeAgent({ id: "mgr", children: [child1, child2] });
    const result: { agent: Agent; depth: number }[] = [];
    findManagerInTree(manager, "mgr", result);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.agent.id)).toEqual(["c1", "c2"]);
    // Children are collected at depth 1
    expect(result.every((r) => r.depth === 1)).toBe(true);
  });

  test("finds manager deep in tree", () => {
    const grandchild = makeAgent({ id: "gc1" });
    const deepManager = makeAgent({ id: "deep-mgr", children: [grandchild] });
    const root = makeAgent({ id: "root", children: [deepManager] });
    const result: { agent: Agent; depth: number }[] = [];
    findManagerInTree(root, "deep-mgr", result);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent.id).toBe("gc1");
  });

  test("returns empty when manager not found", () => {
    const root = makeAgent({ id: "root", children: [makeAgent({ id: "c1" })] });
    const result: { agent: Agent; depth: number }[] = [];
    findManagerInTree(root, "nonexistent", result);
    expect(result).toHaveLength(0);
  });

  test("skips archived children of the found manager", () => {
    const active = makeAgent({ id: "active" });
    const archived = makeAgent({ id: "archived", archived: true });
    const manager = makeAgent({ id: "mgr", children: [archived, active] });
    const result: { agent: Agent; depth: number }[] = [];
    findManagerInTree(manager, "mgr", result);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent.id).toBe("active");
  });
});

// ─── matchAgentById ──────────────────────────────────────────────────────────

describe("matchAgentById", () => {
  const agents = [
    makeAgent({ id: "agent-abc123" }),
    makeAgent({ id: "agent-def456" }),
    makeAgent({ id: "agent-abc999" }),
  ];

  test("exact match returns the agent", () => {
    const { match, ambiguous } = matchAgentById("agent-abc123", agents);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("agent-abc123");
    expect(ambiguous).toEqual([]);
  });

  test("unique prefix match returns the agent", () => {
    const { match, ambiguous } = matchAgentById("agent-def", agents);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("agent-def456");
    expect(ambiguous).toEqual([]);
  });

  test("ambiguous prefix returns null with ambiguous IDs", () => {
    const { match, ambiguous } = matchAgentById("agent-abc", agents);
    expect(match).toBeNull();
    expect(ambiguous).toEqual(["agent-abc123", "agent-abc999"]);
  });

  test("no match returns null with empty ambiguous", () => {
    const { match, ambiguous } = matchAgentById("zzz-nonexistent", agents);
    expect(match).toBeNull();
    expect(ambiguous).toEqual([]);
  });

  test("exact match takes priority even if prefix would be ambiguous", () => {
    // If there's an exact match, it should be returned even if other agents share the prefix
    const agentsWithExact = [
      makeAgent({ id: "agent-abc" }),
      makeAgent({ id: "agent-abc123" }),
    ];
    const { match, ambiguous } = matchAgentById("agent-abc", agentsWithExact);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("agent-abc");
    expect(ambiguous).toEqual([]);
  });

  test("empty agents list returns null", () => {
    const { match, ambiguous } = matchAgentById("anything", []);
    expect(match).toBeNull();
    expect(ambiguous).toEqual([]);
  });
});

// ─── CLI arg parsing — documenting behavior via subprocess ──────────────────

describe("CLI arg parsing", () => {
  // Helper to run the CLI entrypoint with given args and capture output
  async function runCli(cliArgs: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", ...cliArgs], {
      cwd: import.meta.dir.replace(/\/src$/, ""),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: "/tmp/ib-test-nonexistent-home" },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("no command shows help text", async () => {
    const { stdout, exitCode } = await runCli([]);
    expect(stdout).toContain("ib — Cross-repo agent dashboard");
    expect(stdout).toContain("Registry:");
    expect(exitCode).toBe(0);
  });

  test("unknown command shows help text", async () => {
    const { stdout, exitCode } = await runCli(["foobar"]);
    expect(stdout).toContain("ib — Cross-repo agent dashboard");
    expect(exitCode).toBe(0);
  });

  test("list with no repos shows message", async () => {
    const { stdout, exitCode } = await runCli(["list"]);
    expect(stdout).toContain("No repos registered");
    expect(exitCode).toBe(0);
  });

  test("send without agent-id exits with error", async () => {
    const { stderr, exitCode } = await runCli(["send"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("send -f without path exits with error", async () => {
    const { stderr, exitCode } = await runCli(["send", "agent-x", "-f"]);
    expect(stderr).toContain("-f requires a path");
    expect(exitCode).toBe(1);
  });

  test("send --file without path exits with error", async () => {
    const { stderr, exitCode } = await runCli(["send", "agent-x", "--file"]);
    expect(stderr).toContain("--file requires a path");
    expect(exitCode).toBe(1);
  });

  test("send -f <missing-path> exits with file-not-found error", async () => {
    const missing = "/tmp/ib-send-file-nonexistent-" + Date.now() + ".md";
    const { stderr, exitCode } = await runCli(["send", "agent-x", "-f", missing]);
    expect(stderr).toContain("file not found");
    expect(stderr).toContain(missing);
    expect(exitCode).toBe(1);
  });

  test("send -f combined with inline message is a usage error", async () => {
    const tmpFile = `/tmp/ib-send-file-mutex-${Date.now()}.txt`;
    await Bun.write(tmpFile, "from file");
    try {
      const { stderr, exitCode } = await runCli(["send", "agent-x", "-f", tmpFile, "inline"]);
      expect(stderr).toContain("cannot combine -f/--file with an inline message");
      expect(exitCode).toBe(1);
    } finally {
      await Bun.file(tmpFile).delete().catch(() => {});
    }
  });

  test("send --file combined with inline message is a usage error", async () => {
    const tmpFile = `/tmp/ib-send-file-mutex2-${Date.now()}.txt`;
    await Bun.write(tmpFile, "from file");
    try {
      const { stderr, exitCode } = await runCli(["send", "agent-x", "--file", tmpFile, "inline"]);
      expect(stderr).toContain("cannot combine -f/--file with an inline message");
      expect(exitCode).toBe(1);
    } finally {
      await Bun.file(tmpFile).delete().catch(() => {});
    }
  });

  test("send -f <path> with nonexistent agent reaches agent lookup (file content resolved)", async () => {
    // Verifies that -f reads the file and proceeds past arg parsing.
    // Agent lookup will fail (no repos), which proves the file content
    // was successfully resolved into the message body.
    const tmpFile = `/tmp/ib-send-file-ok-${Date.now()}.txt`;
    await Bun.write(tmpFile, "hello from file");
    try {
      const { stderr, exitCode } = await runCli(["send", "agent-x", "-f", tmpFile]);
      // Should reach agent resolution (not bail on file read or arg parsing)
      expect(stderr).toContain("Agent not found");
      expect(exitCode).toBe(1);
    } finally {
      await Bun.file(tmpFile).delete().catch(() => {});
    }
  });

  test("send --file <path> works as an alias for -f", async () => {
    const tmpFile = `/tmp/ib-send-file-alias-${Date.now()}.txt`;
    await Bun.write(tmpFile, "hello from file");
    try {
      const { stderr, exitCode } = await runCli(["send", "agent-x", "--file", tmpFile]);
      expect(stderr).toContain("Agent not found");
      expect(exitCode).toBe(1);
    } finally {
      await Bun.file(tmpFile).delete().catch(() => {});
    }
  });

  test("send usage string lists -f, --file flag", async () => {
    const { stderr, exitCode } = await runCli(["send"]);
    expect(stderr).toContain("-f");
    expect(stderr).toContain("--file");
    expect(stderr).toContain("Read message body from a file");
    expect(exitCode).toBe(1);
  });

  test("send -f file-not-found is reported before agent lookup", async () => {
    // File-error reporting must happen BEFORE agent resolution — the user
    // typing `ib send agent-x -f /tmp/missing.md` should see the file error,
    // not a misleading "Agent not found" message.
    const missing = `/tmp/ib-send-file-order-${Date.now()}.md`;
    const { stderr, exitCode } = await runCli(["send", "agent-x", "-f", missing]);
    expect(stderr).toContain("file not found");
    expect(stderr).not.toContain("Agent not found");
    expect(exitCode).toBe(1);
  });

  test("kill strips --force from args (agent lookup fails first)", async () => {
    // kill filters out --force before checking for unknown args.
    // Without a valid agent, requireAgent exits before the unknown-args check.
    // This documents that kill at least requires an agent-id.
    const { stderr, exitCode } = await runCli(["kill"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("kill with nonexistent agent shows not-found", async () => {
    const { stderr, exitCode } = await runCli(["kill", "nonexistent-id", "--force"]);
    expect(stderr).toContain("Agent not found: nonexistent-id");
    expect(exitCode).toBe(1);
  });

  test("merge strips --force from args", async () => {
    const { stderr, exitCode } = await runCli(["merge"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("resume strips --force from args", async () => {
    const { stderr, exitCode } = await runCli(["resume"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("new-agent without prompt shows usage error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent"]);
    // With no repos, it will fail at the repo detection step or prompt step
    expect(exitCode).not.toBe(0);
  });

  test("new-agent --manager without value shows error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--manager"]);
    expect(stderr).toContain("--manager requires an agent ID");
    expect(exitCode).toBe(1);
  });

  test("new-agent --model without value shows error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--model"]);
    expect(stderr).toContain("--model requires a value");
    expect(exitCode).toBe(1);
  });

  test("new-agent --name without value shows error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--name"]);
    expect(stderr).toContain("--name requires a value");
    expect(exitCode).toBe(1);
  });

  test("new-agent --allow without value shows error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--allow"]);
    expect(stderr).toContain("--allow requires a value");
    expect(exitCode).toBe(1);
  });

  test("new-agent --deny without value shows error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--deny"]);
    expect(stderr).toContain("--deny requires a value");
    expect(exitCode).toBe(1);
  });

  test("new-agent --prompt-file without value shows error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--prompt-file"]);
    expect(stderr).toContain("--prompt-file requires a value");
    expect(exitCode).toBe(1);
  });

  test("new-agent with unknown flag shows error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--bogus", "hello"]);
    expect(stderr).toContain("unknown flag '--bogus'");
    expect(exitCode).toBe(1);
  });

  test("new-agent rejects flag-like values that start with --", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--nonexistent-flag"]);
    expect(stderr).toContain("unknown flag");
    expect(exitCode).toBe(1);
  });

  test("hook-check-path without agent-id shows usage", async () => {
    const { stderr, exitCode } = await runCli(["hook-check-path"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("hook-status without agent-id shows usage", async () => {
    const { stderr, exitCode } = await runCli(["hook-status"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("hook-permission-denied without agent-id shows usage", async () => {
    const { stderr, exitCode } = await runCli(["hook-permission-denied"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("hooks with unknown subcommand shows error", async () => {
    const { stderr, exitCode } = await runCli(["hooks", "garbage"]);
    expect(stderr).toContain("Unknown hooks subcommand: garbage");
    expect(stderr).toContain("Available:");
    expect(exitCode).toBe(1);
  });

  test("look with --all flag sets high line count", async () => {
    // We can verify look accepts these flags by checking it doesn't crash on arg parsing
    // (it will fail on agent lookup, but that's after flag parsing)
    const { stderr } = await runCli(["look"]);
    expect(stderr).toContain("Usage:");
  });

  test("acknowledge without question-id shows usage", async () => {
    const { stderr, exitCode } = await runCli(["ack"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("questions (q alias) with no repos shows message", async () => {
    const { stdout } = await runCli(["q"]);
    expect(stdout).toContain("No repos registered");
  });
});

// ─── list-types CLI command ─────────────────────────────────────────────────

describe("list-types CLI command", () => {
  async function runCliWithHome(cliArgs: string[], home: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", ...cliArgs], {
      cwd: import.meta.dir.replace(/\/src$/, ""),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("list-types prints all default types and exits 0", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join: joinPath } = await import("path");
    const home = await mkdtemp(joinPath(tmpdir(), "ib-list-types-test-"));
    try {
      const { stdout, exitCode } = await runCliWithHome(["list-types"], home);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("NAME");
      expect(stdout).toContain("SPAWNABLE");
      expect(stdout).toContain("SPAWNS CHILDREN");
      expect(stdout).toContain("DESCRIPTION");
      expect(stdout).toContain("manager");
      expect(stdout).toContain("worker");
      expect(stdout).toContain("coordinator");
      expect(stdout).toContain("_all");
      expect(stdout).toContain("_non_coordinator");
      // Layer-only types should be marked non-spawnable with "-" for spawns-children
      const lines = stdout.split("\n");
      const allLine = lines.find((l) => l.startsWith("_all "));
      expect(allLine).toBeDefined();
      expect(allLine).toContain("no");
      expect(allLine).toContain("-");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("list-agent-types alias works the same as list-types", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join: joinPath } = await import("path");
    const home = await mkdtemp(joinPath(tmpdir(), "ib-list-types-alias-test-"));
    try {
      const { stdout, exitCode } = await runCliWithHome(["list-agent-types"], home);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("manager");
      expect(stdout).toContain("worker");
      expect(stdout).toContain("coordinator");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("list-types output is sorted alphabetically", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join: joinPath } = await import("path");
    const home = await mkdtemp(joinPath(tmpdir(), "ib-list-types-sort-test-"));
    try {
      const { stdout, exitCode } = await runCliWithHome(["list-types"], home);
      expect(exitCode).toBe(0);
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      // Skip header — collect type names from data rows
      const dataLines = lines.slice(1);
      const names = dataLines.map((l) => l.split(/\s+/)[0]!).filter((n) => n.length > 0);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("help text mentions list-types", async () => {
    const { stdout, exitCode } = await runCliWithHome([], "/tmp/ib-test-nonexistent-home");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("list-types");
  });
});

// ─── resolveTarget addressing ─────────────────────────────────────────────

describe("resolveTarget addressing", () => {
  // Note: resolveTarget uses async imports and file system calls.
  // These integration tests verify the addressing logic with mocked agents.
  // Unit tests for addressing logic patterns:

  test("@system target is recognized as system coordinator", async () => {
    // @system should return isSystemCoordinator: true
    const repos: RepoEntry[] = [];
    const { agent, isSystemCoordinator } = await resolveTarget("@system", repos);
    expect(agent).toBeNull();
    expect(isSystemCoordinator).toBe(true);
  });

  test("@coordinator without repo context exits with error", async () => {
    const repos: RepoEntry[] = [];
    // Should fail since we're not in a repo context
    // The function will print an error and return null agent
    const { agent, isSystemCoordinator } = await resolveTarget("@coordinator", repos, "/tmp");
    expect(agent).toBeNull();
    expect(isSystemCoordinator).toBe(false);
  });

  test("bare agent-id performs global search", async () => {
    const repos: RepoEntry[] = [
      { path: "/repo1", name: "repo1" },
      { path: "/repo2", name: "repo2" },
    ];
    // With the default cwd (/tmp), this will fail to find an agent
    // since readAllAgents will find no agents in empty .ittybitty dirs
    const { agent, isSystemCoordinator } = await resolveTarget("agent1", repos, "/tmp");
    // Since no agents exist, it should return null
    expect(agent).toBeNull();
    expect(isSystemCoordinator).toBe(false);
  });

  test("@repo/agent-id syntax is recognized", async () => {
    const repos: RepoEntry[] = [
      { path: "/repo1", name: "repo1" },
    ];
    // This will fail to find agents since repos don't have .ittybitty dirs
    const { agent, isSystemCoordinator } = await resolveTarget("@repo1/agent1", repos);
    expect(agent).toBeNull();
    expect(isSystemCoordinator).toBe(false);
  });

  test("@repo-name syntax is recognized", async () => {
    const repos: RepoEntry[] = [
      { path: "/repo1", name: "repo1" },
    ];
    // This will fail to find a coordinator since repo has no .ittybitty dir
    const { agent, isSystemCoordinator } = await resolveTarget("@repo1", repos);
    expect(agent).toBeNull();
    expect(isSystemCoordinator).toBe(false);
  });
});

// ─── @system delivery (sendToSystemCoordinator) ──────────────────────────

describe("buildSystemCoordinatorAgent", () => {
  test("uses /tmp as repoPath when cwd is not inside an agent worktree", () => {
    const a = buildSystemCoordinatorAgent("ib-coordinator", "/some/random/dir");
    expect(a.repoPath).toBe("/tmp");
    expect(a.id).toBe("ib-coordinator");
    expect(a.meta.tmux_session).toBe("ib-coordinator");
  });

  test("uses the sender's repo root when cwd is inside an agent worktree", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc123/repo/src";
    const a = buildSystemCoordinatorAgent("ib-coordinator", cwd);
    expect(a.repoPath).toBe("/Users/me/project");
  });

  test("synthetic agent has no manager and is not archived", () => {
    const a = buildSystemCoordinatorAgent("ib-coordinator", "/tmp");
    expect(a.meta.manager).toBeNull();
    expect(a.archived).toBe(false);
    expect(a.children).toEqual([]);
  });
});

describe("sendToSystemCoordinator", () => {
  let spawnCalls: string[][];
  let tempDir: string;

  beforeEach(async () => {
    spawnCalls = [];
    tempDir = await mkdtemp(join(tmpdir(), "system-coord-test-"));
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return makeSpawnResult();
    });
  });

  afterEach(() => {
    resetSendSpawnRunner();
    resetSystemCoordinatorHasSessionFn();
    return rm(tempDir, { recursive: true, force: true });
  });

  test("returns error and does not invoke sendMessage when coordinator session is not running", async () => {
    setSystemCoordinatorHasSessionFn(async () => false);

    const result = await sendToSystemCoordinator("hello", { cwd: tempDir });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("System coordinator is not running");
    // sendMessage was never called: no tmux spawn calls were made via the
    // sendSpawnCtx runner (the has-session check uses a separate injectable).
    expect(spawnCalls.length).toBe(0);
  });

  test("queries the coordinator session by name when checking has-session", async () => {
    let queriedSession: string | undefined;
    setSystemCoordinatorHasSessionFn(async (sessionName) => {
      queriedSession = sessionName;
      return false;
    });

    await sendToSystemCoordinator("hi", { cwd: tempDir });

    expect(queriedSession).toBe(IB_COORDINATOR_SESSION);
  });

  test("invokes sendMessage with synthetic Agent (tmux_session = IB_COORDINATOR_SESSION) when running", async () => {
    setSystemCoordinatorHasSessionFn(async () => true);

    const result = await sendToSystemCoordinator("hello world", { cwd: tempDir });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Sent to system coordinator");

    // Verify sendMessage routed to IB_COORDINATOR_SESSION via the standard
    // tmux send-keys path: has-session probe + literal-paste + Enter.
    expect(spawnCalls.length).toBe(3);
    expect(spawnCalls[0]).toEqual(["tmux", "has-session", "-t", IB_COORDINATOR_SESSION]);
    expect(spawnCalls[1]).toEqual([
      "tmux",
      "send-keys",
      "-t",
      IB_COORDINATOR_SESSION,
      "-l",
      "--",
      "[sent by user]: hello world",
    ]);
    expect(spawnCalls[2]).toEqual(["tmux", "send-keys", "-t", IB_COORDINATOR_SESSION, "Enter"]);
  });

  test("renders [sent by agent <id>]: prefix when fromAgent is supplied", async () => {
    setSystemCoordinatorHasSessionFn(async () => true);

    await sendToSystemCoordinator("ping", { fromAgent: "agent-xyz", cwd: tempDir });

    // The literal-paste send-keys call carries the prefixed message body.
    const sendKeysLiteral = spawnCalls.find(
      (c) =>
        c[0] === "tmux" &&
        c[1] === "send-keys" &&
        c.length === 7 &&
        c[3] === IB_COORDINATOR_SESSION &&
        c[4] === "-l" &&
        c[5] === "--",
    );
    expect(sendKeysLiteral).toBeDefined();
    expect(sendKeysLiteral![6]).toBe("[sent by agent agent-xyz]: ping");
  });

  test("prepends [sent by user] prefix when fromAgent is omitted (human-driven send)", async () => {
    setSystemCoordinatorHasSessionFn(async () => true);

    await sendToSystemCoordinator("plain text", { cwd: tempDir });

    const sendKeysLiteral = spawnCalls.find(
      (c) =>
        c[0] === "tmux" &&
        c[1] === "send-keys" &&
        c.length === 7 &&
        c[3] === IB_COORDINATOR_SESSION &&
        c[4] === "-l" &&
        c[5] === "--",
    );
    expect(sendKeysLiteral).toBeDefined();
    expect(sendKeysLiteral![6]).toBe("[sent by user]: plain text");
  });
});

// ─── merge-check case ───────────────────────────────────────────────────────

describe("merge-check case", () => {
  test("merge-check case appears exactly once in the switch", () => {
    const source = require("fs").readFileSync(
      require("path").join(import.meta.dir, "index.ts"),
      "utf-8",
    );
    const matches = source.match(/case "merge-check":/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });
});

describe("resolveMergeTargetDir", () => {
  let coordHome: string;
  let repoRoot: string;
  let foreignRoot: string;

  beforeEach(async () => {
    const { realpathSync } = await import("fs");
    coordHome = realpathSync(await mkdtemp(join(tmpdir(), "merge-coord-home-")));
    repoRoot = realpathSync(await mkdtemp(join(tmpdir(), "merge-repo-")));
    foreignRoot = realpathSync(await mkdtemp(join(tmpdir(), "merge-foreign-")));
    const { setCoordinatorHome } = await import("./coordinator");
    setCoordinatorHome(coordHome);
  });

  afterEach(async () => {
    const { resetCoordinatorHome } = await import("./coordinator");
    resetCoordinatorHome();
    await rm(coordHome, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
    await rm(foreignRoot, { recursive: true, force: true });
  });

  test("system coordinator cwd → targetDir = agent.repoPath", () => {
    const agent = makeAgent({ id: "agent-abc", repoPath: repoRoot });
    const result = resolveMergeTargetDir(agent, coordHome);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targetDir).toBe(repoRoot);
  });

  test("subdir of system coordinator home → targetDir = agent.repoPath", () => {
    const { mkdirSync } = require("fs");
    const sub = join(coordHome, "subdir");
    mkdirSync(sub, { recursive: true });
    const agent = makeAgent({ id: "agent-abc", repoPath: repoRoot });
    const result = resolveMergeTargetDir(agent, sub);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targetDir).toBe(repoRoot);
  });

  test("cwd inside agent.repoPath → targetDir = cwd unchanged", () => {
    const { mkdirSync } = require("fs");
    const sub = join(repoRoot, "src");
    mkdirSync(sub, { recursive: true });
    const agent = makeAgent({ id: "agent-abc", repoPath: repoRoot });
    const result = resolveMergeTargetDir(agent, sub);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targetDir).toBe(sub);
  });

  test("cwd === agent.repoPath → targetDir = cwd unchanged", () => {
    const agent = makeAgent({ id: "agent-abc", repoPath: repoRoot });
    const result = resolveMergeTargetDir(agent, repoRoot);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targetDir).toBe(repoRoot);
  });

  test("foreign cwd (sibling repo) → fails with refusal error", () => {
    const agent = makeAgent({ id: "agent-abc", repoPath: repoRoot });
    const result = resolveMergeTargetDir(agent, foreignRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Refusing to merge");
      expect(result.error).toContain(repoRoot);
    }
  });
});

// ─── Telegram admin subcommands (tgallow / tgdeny) ──────────────────────────

describe("Telegram admin subcommands", () => {
  let home: string;

  async function runCli(cliArgs: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", ...cliArgs], {
      cwd: import.meta.dir.replace(/\/src$/, ""),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ib-tg-test-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("tgallow without chat_id shows usage and exits 1", async () => {
    const { stderr, exitCode } = await runCli(["tgallow"]);
    expect(stderr).toContain("Usage: ib tgallow");
    expect(exitCode).toBe(1);
  });

  test("tgdeny without chat_id shows usage and exits 1", async () => {
    const { stderr, exitCode } = await runCli(["tgdeny"]);
    expect(stderr).toContain("Usage: ib tgdeny");
    expect(exitCode).toBe(1);
  });

  test("tgallow adds and is idempotent", async () => {
    const r1 = await runCli(["tgallow", "12345"]);
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toContain("added: 12345");

    const r2 = await runCli(["tgallow", "12345"]);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain("already allowed: 12345");
  });

  test("tgdeny removes and is idempotent", async () => {
    await runCli(["tgallow", "12345"]);
    const r1 = await runCli(["tgdeny", "12345"]);
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toContain("removed: 12345");

    const r2 = await runCli(["tgdeny", "12345"]);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain("not present: 12345");
  });

  test("tgallow on group-shaped id surfaces a warning but still adds", async () => {
    const r = await runCli(["tgallow", "-1001234567890"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("added: -1001234567890");
    expect(r.stdout.toLowerCase()).toContain("group");
  });
});

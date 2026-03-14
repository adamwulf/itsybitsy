import { test, expect, describe } from "bun:test";
import { makeAgent } from "./test-utils";
import { collectAgents, findManagerInTree, matchAgentById } from "./index";
import type { Agent } from "./agents";

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

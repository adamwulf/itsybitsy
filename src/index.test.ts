import { test, expect, describe, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
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
import { setUserConfigPath, resetUserConfigPath } from "./config";
import { IB_COORDINATOR_SESSION } from "./coordinator";
import type { Agent } from "./agents";
import type { RepoEntry } from "./registry";

// Several describes below spawn a real `bun run src/index.ts` subprocess per
// assertion, and some spawn two. Each spawn has to transpile the whole
// index.ts import graph first, which is far more load-sensitive than an
// in-process unit test — a single spawn was measured at 156s during a
// pathologically loaded run. bun's 5s default leaves no headroom for that.
// Raising the bound only changes how long a genuinely stuck spawn takes to
// fail; it weakens no assertion, and passing tests are unaffected.
setDefaultTimeout(60_000);

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
    const match = matchAgentById("agent-abc123", agents);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("agent-abc123");
  });

  test("unique prefix does NOT match (exact-only)", () => {
    expect(matchAgentById("agent-def", agents)).toBeNull();
  });

  test("non-unique prefix does NOT match (exact-only)", () => {
    expect(matchAgentById("agent-abc", agents)).toBeNull();
  });

  test("no match returns null", () => {
    expect(matchAgentById("zzz-nonexistent", agents)).toBeNull();
  });

  test("exact match still resolves when other agents share the prefix", () => {
    const agentsWithExact = [
      makeAgent({ id: "agent-abc" }),
      makeAgent({ id: "agent-abc123" }),
    ];
    const match = matchAgentById("agent-abc", agentsWithExact);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("agent-abc");
  });

  test("empty agents list returns null", () => {
    expect(matchAgentById("anything", [])).toBeNull();
  });

  // ─── nickname resolution ───────────────────────────────────────────────
  test("resolves an agent by its exact nickname", () => {
    const withNick = [
      makeAgent({ id: "agent-zzz111", meta: { nickname: "pikachu" } as any }),
      makeAgent({ id: "agent-yyy222" }),
    ];
    expect(matchAgentById("pikachu", withNick)!.id).toBe("agent-zzz111");
  });

  test("exact id wins over a matching nickname (precedence)", () => {
    // "agent-abc" is BOTH agent A's id and agent B's nickname. Id must win,
    // regardless of array order.
    const a = makeAgent({ id: "agent-abc" });
    const b = makeAgent({ id: "agent-bbb", meta: { nickname: "agent-abc" } as any });
    expect(matchAgentById("agent-abc", [b, a])!.id).toBe("agent-abc");
    expect(matchAgentById("agent-abc", [a, b])!.id).toBe("agent-abc");
  });

  test("nickname is matched EXACTLY only, never as a prefix", () => {
    const withNick = [makeAgent({ id: "agent-zzz111", meta: { nickname: "pikachu" } as any })];
    // A prefix of the nickname does not match via the nickname tier.
    expect(matchAgentById("pika", withNick)).toBeNull();
    // The exact nickname still resolves.
    expect(matchAgentById("pikachu", withNick)!.id).toBe("agent-zzz111");
  });

  test("exact nickname resolves; prefix of another id does NOT", () => {
    // "alpha" is an exact nickname on A, and also a prefix of B's id. The
    // nickname tier matches; the prefix tier no longer exists (exact-only).
    const a = makeAgent({ id: "agent-aaa", meta: { nickname: "alpha" } as any });
    const b = makeAgent({ id: "alpha-999" });
    expect(matchAgentById("alpha", [a, b])!.id).toBe("agent-aaa");
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

  test("--help shows usage block including list-models", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(stdout).toContain("ib — Cross-repo agent dashboard");
    expect(stdout).toContain("list-models");
    expect(exitCode).toBe(0);
  });

  test("-h shows usage block", async () => {
    const { stdout, exitCode } = await runCli(["-h"]);
    expect(stdout).toContain("ib — Cross-repo agent dashboard");
    expect(stdout).toContain("list-models");
    expect(exitCode).toBe(0);
  });

  test("help command shows usage block", async () => {
    const { stdout, exitCode } = await runCli(["help"]);
    expect(stdout).toContain("ib — Cross-repo agent dashboard");
    expect(stdout).toContain("list-models");
    expect(exitCode).toBe(0);
  });

  test("list-models prints grouped selectors for both CLIs", async () => {
    const { stdout, exitCode } = await runCli(["list-models"]);
    expect(stdout).toContain("CLAUDE");
    expect(stdout).toContain("CODEX");
    expect(stdout).toContain("claude:opus");
    expect(stdout).toContain("codex:gpt-5.6-sol");
    expect(stdout).toContain("codex:gpt-5.5");
    expect(exitCode).toBe(0);
  });

  test("models alias works", async () => {
    const { stdout, exitCode } = await runCli(["models"]);
    expect(stdout).toContain("claude:opus");
    expect(stdout).toContain("codex:gpt-5.5");
    expect(exitCode).toBe(0);
  });

  test("list-models --json emits valid JSON of known models", async () => {
    const { stdout, exitCode } = await runCli(["list-models", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(typeof entry.cli).toBe("string");
      expect(typeof entry.model).toBe("string");
      expect(entry.full).toBe(`${entry.cli}:${entry.model}`);
    }
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

  test("retire strips --force from args (agent lookup fails first)", async () => {
    // retire filters out --force before checking for unknown args.
    // Without a valid agent, requireAgent exits before the unknown-args check.
    // This documents that retire at least requires an agent-id.
    const { stderr, exitCode } = await runCli(["retire"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("retire with nonexistent agent shows not-found", async () => {
    const { stderr, exitCode } = await runCli(["retire", "nonexistent-id", "--force"]);
    expect(stderr).toContain("Agent not found: nonexistent-id");
    expect(exitCode).toBe(1);
  });

  test("rehire requires an exact agent id", async () => {
    const { stderr, exitCode } = await runCli(["rehire"]);
    expect(stderr).toContain("Usage: ib rehire <agent-id>");
    expect(exitCode).toBe(1);
  });

  test("rehire reports a missing retired agent", async () => {
    const { stderr, exitCode } = await runCli(["rehire", "nonexistent-id"]);
    expect(stderr).toContain("Retired agent not found");
    expect(exitCode).toBe(1);
  });

  test("kill is no longer a supported subcommand", async () => {
    const { stdout, stderr, exitCode } = await runCli(["kill", "nonexistent-id", "--force"]);
    expect(stdout).toContain("ib — Cross-repo agent dashboard");
    expect(stderr).not.toContain("Agent not found");
    expect(exitCode).toBe(0);
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

  test("new-agent rejects unknown short flag '-x' before the prompt", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "-x", "bar"]);
    expect(stderr).toContain("unknown flag '-x'");
    expect(exitCode).toBe(1);
  });

  test("new-agent rejects '-F' (uppercase) as unknown short flag", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "-F", "/tmp/foo.md"]);
    expect(stderr).toContain("unknown flag '-F'");
    expect(exitCode).toBe(1);
  });

  test("new-agent -f without value shows error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "-f"]);
    expect(stderr).toContain("-f requires a value");
    expect(exitCode).toBe(1);
  });

  test("new-agent --file without value shows error", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--file"]);
    expect(stderr).toContain("--file requires a value");
    expect(exitCode).toBe(1);
  });

  test("new-agent -f <missing-path> shows file-not-found error", async () => {
    const missing = `/tmp/ib-newagent-f-missing-${Date.now()}.md`;
    const { stderr, exitCode } = await runCli(["new-agent", "-f", missing]);
    expect(stderr).toContain("prompt file not found");
    expect(stderr).toContain(missing);
    expect(exitCode).toBe(1);
  });

  test("new-agent --file is an alias for --prompt-file (reads file body)", async () => {
    const tmpFile = `/tmp/ib-newagent-file-alias-${Date.now()}.md`;
    await Bun.write(tmpFile, "prompt from file");
    try {
      // Arg parsing should succeed; spawn will fail downstream (no repos),
      // but reaching that failure proves --file was accepted as an alias.
      const { stderr, exitCode } = await runCli(["new-agent", "--file", tmpFile]);
      expect(stderr).not.toContain("unknown flag");
      expect(exitCode).not.toBe(0);
    } finally {
      await Bun.file(tmpFile).delete().catch(() => {});
    }
  });

  test("new-agent -f is an alias for --prompt-file (reads file body)", async () => {
    const tmpFile = `/tmp/ib-newagent-f-alias-${Date.now()}.md`;
    await Bun.write(tmpFile, "prompt from file");
    try {
      const { stderr, exitCode } = await runCli(["new-agent", "-f", tmpFile]);
      expect(stderr).not.toContain("unknown flag");
      expect(exitCode).not.toBe(0);
    } finally {
      await Bun.file(tmpFile).delete().catch(() => {});
    }
  });

  test("new-agent allows '-x' after the first prompt token (treated as prompt body)", async () => {
    // After the first positional prompt token, a leading '-' is part of the
    // prompt body, not a flag — so this should NOT error on '-x'.
    const { stderr, exitCode } = await runCli(["new-agent", "hello", "-x", "world"]);
    expect(stderr).not.toContain("unknown flag '-x'");
    // Spawn will still fail (no repos), but not due to flag rejection.
    expect(exitCode).not.toBe(0);
  });

  test("send rejects unknown long flag before target", async () => {
    const { stderr, exitCode } = await runCli(["send", "--bogus", "agent-x", "hello"]);
    expect(stderr).toContain("unknown flag '--bogus'");
    expect(exitCode).toBe(1);
  });

  test("send rejects unknown short flag before target", async () => {
    const { stderr, exitCode } = await runCli(["send", "-x", "agent-x", "hello"]);
    expect(stderr).toContain("unknown flag '-x'");
    expect(exitCode).toBe(1);
  });

  test("send treats '-n hello' as message body when it comes after the target", async () => {
    // After the target, a leading '-' is part of the message — must not be
    // rejected as an unknown flag. Quoted single-arg form arrives as one token.
    const { stderr, exitCode } = await runCli(["send", "agent-x", "-n hello"]);
    expect(stderr).not.toContain("unknown flag");
    expect(stderr).toContain("Agent not found");
    expect(exitCode).toBe(1);
  });

  test("send treats unquoted '-n' as message body when it comes after the target", async () => {
    // Unquoted form: shell splits into multiple argv tokens; the first
    // non-flag token is the target, and subsequent tokens (including '-n')
    // are joined as the message body.
    const { stderr, exitCode } = await runCli(["send", "agent-x", "-n", "hello"]);
    expect(stderr).not.toContain("unknown flag");
    expect(stderr).toContain("Agent not found");
    expect(exitCode).toBe(1);
  });

  // ── Heredoc / stdin fallback (mirrors `ib send`) ──────────────────────────
  // `runCli` above leaves stdin unset, so Bun gives the child an empty (/dev/null)
  // stdin — a non-TTY that reads as "". `runCliStdin` instead pipes a string into
  // the child's stdin so the heredoc fallback path is exercised. Both set HOME to a
  // nonexistent dir so listRepos() returns [] unless a test overrides HOME.
  async function runCliStdin(
    cliArgs: string[],
    stdinBody: string,
    env?: Record<string, string>,
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // bun's spawn needs an absolute path for the script, since `cwd` is set
    // per-test to a clean fixture dir to avoid newAgent's spawner-clean check
    // tripping on this repo's own uncommitted changes.
    const repoRoot = import.meta.dir.replace(/\/src$/, "");
    const proc = Bun.spawn(["bun", "run", `${repoRoot}/src/index.ts`, ...cliArgs], {
      cwd: cwd ?? repoRoot,
      stdin: new TextEncoder().encode(stdinBody),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: "/tmp/ib-test-nonexistent-home", ...env },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("ask reads question from stdin when no positional question (heredoc)", async () => {
    // No positional question; --id given so agent-ID detection succeeds. The
    // question comes from stdin, so we must reach agent lookup (Agent not found),
    // NOT the 'Usage: ib ask' error — proving stdin was consumed into the question.
    const { stderr, exitCode } = await runCliStdin(
      ["ask", "--id", "agent-deadbeef"],
      "what should I do next?\n",
    );
    expect(stderr).not.toContain("Usage: ib ask");
    expect(stderr).toContain("Agent not found: agent-deadbeef");
    expect(exitCode).toBe(1);
  });

  test("ask with empty stdin and no positional still shows usage error (TTY-parity)", async () => {
    // Empty piped stdin resolves to "" — same as a TTY with no arg — so the
    // existing usage error must still fire.
    const { stderr, exitCode } = await runCliStdin(["ask", "--id", "agent-deadbeef"], "");
    expect(stderr).toContain("Usage: ib ask");
    expect(exitCode).toBe(1);
  });

  test("ask positional question takes precedence over stdin", async () => {
    // A positional question is present, so stdin must be IGNORED (precedence:
    // positional > stdin). Reaches agent lookup, not the usage error.
    const { stderr, exitCode } = await runCliStdin(
      ["ask", "--id", "agent-deadbeef", "inline question"],
      "stdin question that should be ignored\n",
    );
    expect(stderr).not.toContain("Usage: ib ask");
    expect(stderr).toContain("Agent not found: agent-deadbeef");
    expect(exitCode).toBe(1);
  });

  test("new-agent reads prompt from stdin (heredoc) — passes the prompt-required check", async () => {
    // Register a repo so repo-determination succeeds and newAgent() is reached.
    // newAgent()'s FIRST step is the empty-prompt check; an unknown --type fails
    // immediately after. So with a heredoc prompt we must get the unknown-type
    // error (proving the stdin prompt was consumed and is non-empty), NOT
    // 'prompt required'. Metachars in the body are preserved verbatim — the
    // stdin reader does no expansion (only .trim()), and a quoted heredoc keeps
    // the shell from expanding them before ib sees stdin.
    const { mkdtemp } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-newagent-stdin-home-"));
    const repoDir = await mkdtemp(join(tmpdir(), "ib-newagent-stdin-repo-"));
    await Bun.write(
      join(fakeHome, ".itsybitsy", "repos.json"),
      JSON.stringify({ version: 1, repos: [{ path: repoDir, name: "stdinrepo" }] }),
    );
    try {
      const { stderr, exitCode } = await runCliStdin(
        ["new-agent", "--repo", "stdinrepo", "--type", "bogus-nonexistent-type"],
        "fix $(whoami) and `date` for $USER literally\n",
        { HOME: fakeHome },
        repoDir,
      );
      expect(stderr).not.toContain("prompt required");
      expect(stderr).toContain("unknown agent type 'bogus-nonexistent-type'");
      expect(exitCode).toBe(1);
    } finally {
      const { rm } = await import("fs/promises");
      await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("new-agent with empty stdin + registered repo still errors 'prompt required'", async () => {
    // Empty piped stdin → empty prompt → newAgent()'s first-line check fires.
    // This proves the TTY-parity error is preserved when nothing is piped.
    const { mkdtemp } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-newagent-empty-home-"));
    const repoDir = await mkdtemp(join(tmpdir(), "ib-newagent-empty-repo-"));
    await Bun.write(
      join(fakeHome, ".itsybitsy", "repos.json"),
      JSON.stringify({ version: 1, repos: [{ path: repoDir, name: "emptyrepo" }] }),
    );
    try {
      const { stderr, exitCode } = await runCliStdin(
        ["new-agent", "--repo", "emptyrepo"],
        "",
        { HOME: fakeHome },
      );
      expect(stderr).toContain("prompt required");
      expect(exitCode).toBe(1);
    } finally {
      const { rm } = await import("fs/promises");
      await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("new-agent positional prompt takes precedence over stdin", async () => {
    // A positional prompt is present, so stdin must be IGNORED. With an unknown
    // --type we still reach the unknown-type error (past the prompt check),
    // confirming the positional prompt satisfied it without consuming stdin.
    const { mkdtemp } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-newagent-prec-home-"));
    const repoDir = await mkdtemp(join(tmpdir(), "ib-newagent-prec-repo-"));
    await Bun.write(
      join(fakeHome, ".itsybitsy", "repos.json"),
      JSON.stringify({ version: 1, repos: [{ path: repoDir, name: "precrepo" }] }),
    );
    try {
      const { stderr, exitCode } = await runCliStdin(
        ["new-agent", "--repo", "precrepo", "--type", "bogus-nonexistent-type", "inline prompt"],
        "stdin prompt that should be ignored\n",
        { HOME: fakeHome },
        repoDir,
      );
      expect(stderr).not.toContain("prompt required");
      expect(stderr).toContain("unknown agent type 'bogus-nonexistent-type'");
      expect(exitCode).toBe(1);
    } finally {
      const { rm } = await import("fs/promises");
      await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("new-agent -f <empty-file> suppresses stdin fallback (prompt required)", async () => {
    // Precedence guarantee: an explicit -f wins over stdin even when the file is
    // empty (matching `send`'s "-f > stdin"). So with an empty -f file AND a
    // piped heredoc body, the stdin must NOT leak in — newAgent() sees an empty
    // prompt and emits "prompt required". (Note: the empty-prompt check fires
    // before --type validation, so we get "prompt required" not unknown-type.)
    const { mkdtemp } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-newagent-femptystdin-home-"));
    const repoDir = await mkdtemp(join(tmpdir(), "ib-newagent-femptystdin-repo-"));
    // Genuinely empty (0-byte) file — this is the exact root cause: -f pushes
    // "" into promptParts, prompt becomes "" (falsy), and WITHOUT the
    // promptFromFile guard the `if (!prompt)` fallback would read stdin.
    const emptyFile = join(tmpdir(), `ib-newagent-empty-promptfile-${Date.now()}.md`);
    await Bun.write(emptyFile, "");
    await Bun.write(
      join(fakeHome, ".itsybitsy", "repos.json"),
      JSON.stringify({ version: 1, repos: [{ path: repoDir, name: "femptyrepo" }] }),
    );
    try {
      const { stderr, exitCode } = await runCliStdin(
        ["new-agent", "--repo", "femptyrepo", "-f", emptyFile],
        "stdin body that must NOT leak in\n",
        { HOME: fakeHome },
      );
      expect(stderr).toContain("prompt required");
      expect(exitCode).toBe(1);
    } finally {
      const { rm } = await import("fs/promises");
      await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
      await Bun.file(emptyFile).delete().catch(() => {});
    }
  });

  test("new-agent -f <non-empty-file> wins over stdin (file content used)", async () => {
    // The complementary case: a non-empty -f file beats a piped heredoc body.
    // With an unknown --type we reach the unknown-type error past the prompt
    // check, confirming the file content (not stdin) satisfied the prompt.
    const { mkdtemp } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-newagent-fwins-home-"));
    const repoDir = await mkdtemp(join(tmpdir(), "ib-newagent-fwins-repo-"));
    const promptFile = join(tmpdir(), `ib-newagent-fwins-promptfile-${Date.now()}.md`);
    await Bun.write(promptFile, "real prompt from file\n");
    await Bun.write(
      join(fakeHome, ".itsybitsy", "repos.json"),
      JSON.stringify({ version: 1, repos: [{ path: repoDir, name: "fwinsrepo" }] }),
    );
    try {
      const { stderr, exitCode } = await runCliStdin(
        ["new-agent", "--repo", "fwinsrepo", "--type", "bogus-nonexistent-type", "-f", promptFile],
        "stdin body that should be ignored\n",
        { HOME: fakeHome },
        repoDir,
      );
      expect(stderr).not.toContain("prompt required");
      expect(stderr).toContain("unknown agent type 'bogus-nonexistent-type'");
      expect(exitCode).toBe(1);
    } finally {
      const { rm } = await import("fs/promises");
      await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
      await Bun.file(promptFile).delete().catch(() => {});
    }
  });

  test("new-agent still rejects flag typos before reading stdin (guard intact)", async () => {
    // The flag-typo guard must fire during arg parsing, before any stdin read,
    // so a piped body does not mask a typo like '-F'.
    const { stderr, exitCode } = await runCliStdin(
      ["new-agent", "-F", "/tmp/foo.md"],
      "some piped body\n",
    );
    expect(stderr).toContain("unknown flag '-F'");
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

  // ── HIGH 2 from Phase 4 review: write-pid CLI surface ─────────────────────
  test("write-pid with no args shows usage", async () => {
    const { stderr, exitCode } = await runCli(["write-pid"]);
    expect(stderr).toContain("Usage: ib write-pid <agent-id> <pid>");
    expect(exitCode).toBe(1);
  });

  test("write-pid with only agent-id shows usage", async () => {
    const { stderr, exitCode } = await runCli(["write-pid", "agent-abc"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("write-pid with invalid agent-id rejects", async () => {
    const { stderr, exitCode } = await runCli(["write-pid", "bad agent id", "12345"]);
    expect(stderr).toContain("Invalid agent ID");
    expect(exitCode).toBe(1);
  });

  test("write-pid with non-numeric pid rejects", async () => {
    const { stderr, exitCode } = await runCli(["write-pid", "agent-abc", "notanumber"]);
    expect(stderr).toContain("Invalid PID");
    expect(exitCode).toBe(1);
  });

  test("write-pid with negative pid rejects", async () => {
    const { stderr, exitCode } = await runCli(["write-pid", "agent-abc", "-1"]);
    expect(stderr).toContain("Invalid PID");
    expect(exitCode).toBe(1);
  });

  test("write-pid with leading-zero pid rejects (defense in depth)", async () => {
    const { stderr, exitCode } = await runCli(["write-pid", "agent-abc", "012"]);
    expect(stderr).toContain("Invalid PID");
    expect(exitCode).toBe(1);
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

// ─── show-type CLI command ─────────────────────────────────────────────────

describe("show-type CLI command", () => {
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

  test("show-type prints the manager definition and exits 0", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join: joinPath } = await import("path");
    const home = await mkdtemp(joinPath(tmpdir(), "ib-show-type-test-"));
    try {
      const { stdout, exitCode } = await runCliWithHome(["show-type", "manager"], home);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("NAME: manager");
      expect(stdout).toContain("DESCRIPTION:");
      expect(stdout).toContain("SPAWNABLE: yes");
      expect(stdout).toContain("SPAWNS CHILDREN: yes");
      expect(stdout).toContain("INSTRUCTION STYLE: manager");
      expect(stdout).toContain("PERMISSIONS ALLOW");
      expect(stdout).toContain("PERMISSIONS DENY");
      expect(stdout).toContain("PROMPT BODY");
      expect(stdout).toContain("substituted at spawn time");
      // Prompt body should contain a templated placeholder from the manager type
      expect(stdout).toContain("{{agentId}}");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("show-type --json emits valid JSON with expected fields", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join: joinPath } = await import("path");
    const home = await mkdtemp(joinPath(tmpdir(), "ib-show-type-json-test-"));
    try {
      const { stdout, exitCode } = await runCliWithHome(["show-type", "worker", "--json"], home);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.name).toBe("worker");
      expect(typeof parsed.description).toBe("string");
      expect(parsed.instructionStyle).toBe("worker");
      expect(typeof parsed.canSpawnChildren).toBe("boolean");
      expect(typeof parsed.markdownBody).toBe("string");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("show-agent-type alias works the same as show-type", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join: joinPath } = await import("path");
    const home = await mkdtemp(joinPath(tmpdir(), "ib-show-type-alias-test-"));
    try {
      const { stdout, exitCode } = await runCliWithHome(["show-agent-type", "worker"], home);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("NAME: worker");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("show-type with unknown name errors and exits 1", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join: joinPath } = await import("path");
    const home = await mkdtemp(joinPath(tmpdir(), "ib-show-type-missing-test-"));
    try {
      const { stderr, exitCode } = await runCliWithHome(["show-type", "nonexistent-type-xyz"], home);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("nonexistent-type-xyz");
      expect(stderr).toContain("ib list-types");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("show-type with no name prints usage and exits 1", async () => {
    const { stderr, exitCode } = await runCliWithHome(["show-type"], "/tmp/ib-test-nonexistent-home");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  test("help text mentions show-type", async () => {
    const { stdout, exitCode } = await runCliWithHome([], "/tmp/ib-test-nonexistent-home");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("show-type");
  });
});

// ─── nickname CLI command ───────────────────────────────────────────────────

describe("nickname CLI command", () => {
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

  // Build a temp HOME with a registry pointing at a temp repo that holds one
  // agent dir. Returns { home, repoPath, cleanup }.
  async function setupRepoWithAgent(id: string, extraMeta: Record<string, unknown> = {}) {
    const { mkdtemp, rm, mkdir } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join: joinPath } = await import("path");
    const home = await mkdtemp(joinPath(tmpdir(), "ib-nick-home-"));
    const repoPath = await mkdtemp(joinPath(tmpdir(), "ib-nick-repo-"));
    await mkdir(joinPath(home, ".itsybitsy"), { recursive: true });
    await Bun.write(
      joinPath(home, ".itsybitsy", "repos.json"),
      JSON.stringify({ repos: [{ path: repoPath, name: "nick-repo" }] }),
    );
    const agentDir = joinPath(repoPath, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      joinPath(agentDir, "meta.json"),
      JSON.stringify({ id, tmux_session: `t-${id}`, ...extraMeta }),
    );
    const cleanup = async () => {
      await rm(home, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    };
    return { home, repoPath, agentDir, cleanup };
  }

  test("set nickname writes it and exits 0", async () => {
    const { home, agentDir, cleanup } = await setupRepoWithAgent("agent-nick1");
    try {
      const { exitCode } = await runCliWithHome(["nickname", "agent-nick1", "pikachu"], home);
      expect(exitCode).toBe(0);
      const { join: joinPath } = await import("path");
      const meta = await Bun.file(joinPath(agentDir, "meta.json")).json();
      expect(meta.nickname).toBe("pikachu");
    } finally {
      await cleanup();
    }
  });

  test("no-arg shows the current nickname", async () => {
    const { home, cleanup } = await setupRepoWithAgent("agent-nick2", { nickname: "charmander" });
    try {
      const { stdout, exitCode } = await runCliWithHome(["nickname", "agent-nick2"], home);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("charmander");
    } finally {
      await cleanup();
    }
  });

  test("no-arg shows placeholder when no nickname set", async () => {
    const { home, cleanup } = await setupRepoWithAgent("agent-nick3");
    try {
      const { stdout, exitCode } = await runCliWithHome(["nickname", "agent-nick3"], home);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("(no nickname set)");
    } finally {
      await cleanup();
    }
  });

  test("--clear deletes the nickname field", async () => {
    const { home, agentDir, cleanup } = await setupRepoWithAgent("agent-nick4", { nickname: "squirtle" });
    try {
      const { exitCode } = await runCliWithHome(["nickname", "agent-nick4", "--clear"], home);
      expect(exitCode).toBe(0);
      const { join: joinPath } = await import("path");
      const meta = await Bun.file(joinPath(agentDir, "meta.json")).json();
      expect("nickname" in meta).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("the agent resolves by its nickname (requireAgent)", async () => {
    // Set a nickname, then run a command (`look`) addressed by the nickname.
    const { home, cleanup } = await setupRepoWithAgent("agent-nick5", { nickname: "snorlax" });
    try {
      // `look <nickname>` must resolve to the agent (it won't have a tmux
      // session, but resolution succeeding means it gets past requireAgent —
      // a "not found" error would mean nickname resolution failed).
      const { stderr } = await runCliWithHome(["look", "snorlax"], home);
      expect(stderr).not.toContain("Agent not found");
    } finally {
      await cleanup();
    }
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
    // Isolate user config — sendMessage reads `user.name` to format
    // human-driven sends. Without isolation tests would pick up whatever's
    // in the developer's ~/.itsybitsy/config.json (e.g. if user.name is set
    // the `[sent by user]` prefix asserts would break).
    setUserConfigPath(join(tempDir, "config.json"));
    // Isolate the coordinator home — sendToSystemCoordinator now enqueues to
    // (and drains from) an outbox.jsonl + .outbox.lock in the coordinator home.
    // Without isolation these tests would write into the developer's real
    // ~/.itsybitsy/. Use a SUBDIR distinct from `cwd: tempDir` so the
    // sender-from-cwd auto-detection does not mis-stamp the human send as
    // @system (it would if cwd === coordinatorHome).
    const { setCoordinatorHome } = await import("./coordinator");
    setCoordinatorHome(join(tempDir, "coord-home"));
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return makeSpawnResult();
    });
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetUserConfigPath();
    resetSystemCoordinatorHasSessionFn();
    const { resetCoordinatorHome } = await import("./coordinator");
    resetCoordinatorHome();
    await rm(tempDir, { recursive: true, force: true });
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
    expect(spawnCalls[0]).toEqual(["tmux", "has-session", "-t", "=" + IB_COORDINATOR_SESSION + ":"]);
    expect(spawnCalls[1]).toEqual([
      "tmux",
      "send-keys",
      "-t",
      "=" + IB_COORDINATOR_SESSION + ":",
      "-l",
      "--",
      "[sent by user]: hello world",
    ]);
    expect(spawnCalls[2]).toEqual(["tmux", "send-keys", "-t", "=" + IB_COORDINATOR_SESSION + ":", "Enter"]);
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
        c[3] === "=" + IB_COORDINATOR_SESSION + ":" &&
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
        c[3] === "=" + IB_COORDINATOR_SESSION + ":" &&
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

  /**
   * Run the CLI as a SETUP step and require it to have succeeded.
   *
   * A setup command whose result is discarded turns any failure of that
   * command into a confusing assertion failure on the *next* command — e.g. a
   * `tgallow` that never seeded the allowlist shows up as `tgdeny` reporting
   * "not present: 12345" instead of "removed: 12345", pointing the reader at
   * the wrong command entirely. Checking the setup here attributes the failure
   * to the step that actually broke, and includes the subprocess's own
   * stdout/stderr so the reason is visible rather than swallowed.
   */
  async function runCliSetup(cliArgs: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const r = await runCli(cliArgs);
    if (r.exitCode !== 0) {
      throw new Error(
        `setup command \`ib ${cliArgs.join(" ")}\` failed: exit=${r.exitCode}\n` +
        `stdout: ${JSON.stringify(r.stdout)}\nstderr: ${JSON.stringify(r.stderr)}`,
      );
    }
    return r;
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
    const setup = await runCliSetup(["tgallow", "12345"]);
    expect(setup.stdout).toContain("added: 12345");
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

  test("tgtyping no-ops cleanly (exit 0, silent) when Telegram is unconfigured", async () => {
    // Fresh HOME → no config.json, no chat-id cache. The hook is best-effort
    // and must exit 0 without writing anything to stderr/stdout so that
    // misconfigured systems don't spam the agent log on every prompt.
    const { stdout, stderr, exitCode } = await runCli(["tgtyping"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});

// ─── CLI entry points ────────────────────────────────────────────────────────

describe("CLI entry points", () => {
  const repoRoot = import.meta.dir.replace(/\/src$/, "");

  async function runEntry(
    entry: string,
    cliArgs: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "run", `${repoRoot}/${entry}`, ...cliArgs], {
      cwd: repoRoot,
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

  // Both files are real entry points and the project builds the binary from
  // BOTH depending on which instruction you follow: package.json's `build`
  // script compiles src/index.ts, while CLAUDE.md documents
  // `bun build --compile ... index.ts` (the root shim). Dispatch is guarded by
  // `import.meta.main`, which is per-module — so a guard that only covers one
  // file silently produces a binary that starts up and does nothing. That is
  // not a theoretical worry: guarding only src/index.ts did exactly that, and
  // no existing test caught it because every other CLI test spawns
  // src/index.ts, the entry that still worked.
  test.each([["index.ts"], ["src/index.ts"]])(
    "%s dispatches commands when run as the entry point",
    async (entry) => {
      const { stdout, exitCode } = await runEntry(entry, ["list-types"]);
      expect(exitCode).toBe(0);
      // A known row from the agent-type table — proves the command actually ran
      // rather than the process merely exiting 0 with no output.
      expect(stdout).toContain("coordinator");
    },
  );

  // The other half of the contract: importing must NOT dispatch. Without this,
  // `bun test <filter>` runs main() inside the test runner with the filter bound
  // to process.argv[2], so `bun test send` / `merge` / `nuke` would execute those
  // commands for real against the developer's repos.
  test.each([["index.ts"], ["src/index.ts"]])(
    "importing %s runs no CLI dispatch",
    async (entry) => {
      const proc = Bun.spawn(
        ["bun", "-e", `await import("${repoRoot}/${entry}"); console.log("IMPORT_OK");`],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          // argv[2] would be the command if the guard leaked. "list-types"
          // prints a distinctive table we can assert the absence of.
          env: { ...process.env, HOME: "/tmp/ib-test-nonexistent-home" },
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(stdout).toContain("IMPORT_OK");
      // No usage block (the default branch) and no agent-type table.
      expect(stdout).not.toContain("SPAWNABLE");
      expect(stdout).not.toContain("Usage: ib");
      expect(stderr).not.toContain("Usage: ib");
    },
  );
});

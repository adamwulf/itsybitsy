import { test, expect, describe, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { makeAgent, makeSpawnResult } from "./test-utils";
import {
  collectAgents,
  findManagerInTree,
  matchAgentById,
  formatAgentPathPolicy,
  resolveTarget,
  resolveMergeTargetDir,
  parseMergeArgs,
  buildSystemCoordinatorAgent,
  sendToSystemCoordinator,
  findAgentByIdInRepo,
  setSystemCoordinatorHasSessionFn,
  resetSystemCoordinatorHasSessionFn,
  messageBodyReader,
} from "./index";
import { setSendSpawnRunner, resetSendSpawnRunner } from "./ib-commands";
import { setUserConfigPath, resetUserConfigPath } from "./config";
import { IB_COORDINATOR_SESSION } from "./coordinator";
import type { Agent } from "./agents";
import type { RepoEntry } from "./registry";
import type { RecordedCliAction } from "./test-cli-driver";
import {
  createCliFixture,
  runEntryPointImport,
  runInertEntryPoint,
  runIsolatedCli,
  type CliFixture,
  type IsolatedCliOptions,
} from "./test-cli-runner";

// Several describes below spawn a CLI subprocess per assertion, and some spawn
// two. Each spawn has to transpile the whole
// index.ts import graph first, which is far more load-sensitive than an
// in-process unit test — a single spawn was measured at 156s during a
// pathologically loaded run. bun's 5s default leaves no headroom for that.
// Raising the bound only changes how long a genuinely stuck spawn takes to
// fail; it weakens no assertion, and passing tests are unaffected.
setDefaultTimeout(60_000);

describe("findAgentByIdInRepo", () => {
  test("duplicate exact IDs resolve only inside the explicitly selected repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "ib-scoped-agent-"));
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    try {
      for (const [repoPath, marker] of [[repoA, "A"], [repoB, "B"]] as const) {
        const agentDir = join(repoPath, ".itsybitsy", "agents", "agent-duplicate");
        await mkdir(agentDir, { recursive: true });
        await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
          id: "agent-duplicate",
          prompt: marker,
          tmux_session: `tmux-${marker}`,
        }));
      }

      const resolved = await findAgentByIdInRepo(
        "agent-duplicate",
        { path: repoB, name: "repo-b" },
      );
      expect(resolved?.repoPath).toBe(repoB);
      expect(resolved?.meta.prompt).toBe("B");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

describe("formatAgentPathPolicy", () => {
  test.each([{}, { allowRead: ["/read"] }, { allowWrite: ["/write"] }, { deny: ["/secret"] }])(
    "omitted lists in partial path metadata default to empty: %j", (paths) => {
      const lines = formatAgentPathPolicy({ paths } as any);
      expect(lines).toContain("  read-only:");
      expect(lines).toContain("  read+write:");
      expect(lines).toContain("  deny:");
      expect(lines).toContain("    (none)");
    },
  );

  test("agy reports the resolved kernel wrapper state", () => {
    // Every CLI supports enabled and disabled kernel policies.
    expect(formatAgentPathPolicy({ model: "agy:default", sandbox: { enabled: true } } as any)[0])
      .toBe("Sandbox:      enabled");
    expect(formatAgentPathPolicy({ model: "agy:default", sandbox: { enabled: false } } as any)[0])
      .toBe("Sandbox:      disabled");
  });

  test.each(["sonnet", "opus", "unknown"])("legacy %s metadata keeps Claude display behavior", (model) => {
    expect(formatAgentPathPolicy({ model })[0]).toBe("Sandbox:      enabled");
  });

  test("prints sandbox state and all resolved lists in read/write/deny order", () => {
    expect(formatAgentPathPolicy({
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: {
        allowRead: ["/read"],
        allowWrite: ["/write"],
        deny: ["**/.env"],
      },
    })).toEqual([
      "Sandbox:      enabled",
      "Paths:",
      "  read-only:",
      "    - /read",
      "  read+write:",
      "    - /write",
      "  deny:",
      "    - **/.env",
    ]);
  });

  test("prints the enabled default and strict runtime roots for legacy meta", () => {
    expect(formatAgentPathPolicy({})).toEqual([
      "Sandbox:      enabled",
      "Paths:        none (worktree and runtime roots only)",
    ]);
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
  // Every run goes through the guarded driver in a temporary cwd and HOME: the
  // handler a command reaches refuses unless the test names it, so these tests
  // assert what the parser produced instead of relying on a downstream failure.
  // (A sandboxed agent once ran them against its own watchdog, and "spawn will
  // fail: no repos" spawned three real agents.) Sandbox routing has its own tests
  // in src/cli-isolation.test.ts.
  let cli: CliFixture;
  beforeEach(async () => { cli = await createCliFixture(); });
  afterEach(async () => { await cli.cleanup(); });

  const runCli = (cliArgs: string[], options?: IsolatedCliOptions) => cli.run(cliArgs, options);

  /** A registered agent, so a command's arguments can be followed to its handler. */
  async function addTarget(id = "agent-x") {
    return cli.addAgent(await cli.addRepo("target-repo"), id);
  }

  /** The one handler call a run made. */
  function onlyAction(result: { actions: RecordedCliAction[] }): RecordedCliAction {
    expect(result.actions.length).toBe(1);
    return result.actions[0]!;
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
    const missing = join(cli.root, "missing.md");
    const { stderr, exitCode } = await runCli(["send", "agent-x", "-f", missing]);
    expect(stderr).toContain("file not found");
    expect(stderr).toContain(missing);
    expect(exitCode).toBe(1);
  });

  test("send -f combined with inline message is a usage error", async () => {
    const file = join(cli.root, "body.txt");
    await Bun.write(file, "from file");
    const { stderr, exitCode } = await runCli(["send", "agent-x", "-f", file, "inline"]);
    expect(stderr).toContain("cannot combine -f/--file with an inline message");
    expect(exitCode).toBe(1);
  });

  test("send --file combined with inline message is a usage error", async () => {
    const file = join(cli.root, "body.txt");
    await Bun.write(file, "from file");
    const { stderr, exitCode } = await runCli(["send", "agent-x", "--file", file, "inline"]);
    expect(stderr).toContain("cannot combine -f/--file with an inline message");
    expect(exitCode).toBe(1);
  });

  test("send -f <path> passes the file content to sendMessage", async () => {
    const target = await addTarget();
    const file = join(cli.root, "body.txt");
    await Bun.write(file, "hello from file\n");
    const result = await runCli(["send", "agent-x", "-f", file], { actions: { sendMessage: "record" } });
    expect(result.exitCode).toBe(0);
    const { name, args } = onlyAction(result);
    expect(name).toBe("sendMessage");
    expect((args[0] as Agent).id).toBe(target.id);
    expect(args[1]).toBe("hello from file");
  });

  test("send --file <path> works as an alias for -f", async () => {
    await addTarget();
    const file = join(cli.root, "body.txt");
    await Bun.write(file, "hello from file");
    const result = await runCli(["send", "agent-x", "--file", file], { actions: { sendMessage: "record" } });
    expect(onlyAction(result).args[1]).toBe("hello from file");
  });

  test("send --from reaches sendMessage as the sender", async () => {
    await addTarget();
    const result = await runCli(["send", "--from", "agent-sender", "agent-x", "hi"], { actions: { sendMessage: "record" } });
    const { args } = onlyAction(result);
    expect(args[1]).toBe("hi");
    expect(args[2]).toEqual({ fromAgent: "agent-sender" });
  });

  test("send precedence: inline beats stdin, -f beats stdin, stdin is the fallback", async () => {
    await addTarget();
    const file = join(cli.root, "body.txt");
    await Bun.write(file, "from file");
    const actions = { sendMessage: "record" } as const;
    const inline = await runCli(["send", "agent-x", "from inline"], { stdin: "from stdin\n", actions });
    expect(onlyAction(inline).args[1]).toBe("from inline");
    const fromFile = await runCli(["send", "agent-x", "-f", file], { stdin: "from stdin\n", actions });
    expect(onlyAction(fromFile).args[1]).toBe("from file");
    const fromStdin = await runCli(["send", "agent-x"], { stdin: "from stdin\n", actions });
    expect(onlyAction(fromStdin).args[1]).toBe("from stdin");
  });

  test("send with no message anywhere shows usage and reaches no handler", async () => {
    await addTarget();
    const { stderr, exitCode, actions } = await runCli(["send", "agent-x"], { actions: { sendMessage: "record" } });
    expect(stderr).toContain("Usage: ib send");
    expect(exitCode).toBe(1);
    expect(actions).toEqual([]);
  });

  test("send to an unknown agent reads -f, then reports the target as not found", async () => {
    const file = join(cli.root, "body.txt");
    await Bun.write(file, "hello from file");
    const { stderr, exitCode } = await runCli(["send", "agent-x", "-f", file]);
    expect(stderr).toContain("Agent not found");
    expect(exitCode).toBe(1);
  });

  test("send @system reaches the system coordinator handler", async () => {
    const result = await runCli(["send", "@system", "hello system"], { actions: { sendToSystemCoordinator: "record" } });
    const { name, args } = onlyAction(result);
    expect(name).toBe("sendToSystemCoordinator");
    expect(args[0]).toBe("hello system");
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
    const missing = join(cli.root, "missing.md");
    const { stderr, exitCode } = await runCli(["send", "agent-x", "-f", missing]);
    expect(stderr).toContain("file not found");
    expect(stderr).not.toContain("Agent not found");
    expect(exitCode).toBe(1);
  });

  test("retire strips --force from args", async () => {
    const target = await addTarget();
    const result = await runCli(["retire", "agent-x", "--force"], { actions: { retireAgent: "record" } });
    expect(result.stderr).not.toContain("unknown arguments");
    expect((onlyAction(result).args[0] as Agent).id).toBe(target.id);
  });

  test("retire warns about other arguments and still retires", async () => {
    await addTarget();
    const result = await runCli(["retire", "agent-x", "--bogus"], { actions: { retireAgent: "record" } });
    expect(result.stderr).toContain("Warning: unknown arguments ignored: --bogus");
    expect(onlyAction(result).name).toBe("retireAgent");
  });

  test("retire without an agent-id shows usage", async () => {
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

  test("rehire passes the id as typed to rehireAgent", async () => {
    const result = await runCli(["rehire", "agent-y"], { actions: { rehireAgent: "record" } });
    expect(onlyAction(result).args).toEqual(["agent-y"]);
  });

  test("rehire reports a missing retired agent", async () => {
    const { stderr, exitCode } = await runCli(["rehire", "nonexistent-id"], { actions: { rehireAgent: "real" } });
    expect(stderr).toContain("Retired agent not found");
    expect(exitCode).toBe(1);
  });

  test("kill is no longer a supported subcommand", async () => {
    const { stdout, stderr, exitCode } = await runCli(["kill", "nonexistent-id", "--force"]);
    expect(stdout).toContain("ib — Cross-repo agent dashboard");
    expect(stderr).not.toContain("Agent not found");
    expect(exitCode).toBe(0);
  });

  test("merge without an agent-id shows usage", async () => {
    const { stderr, exitCode } = await runCli(["merge"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("merge strips --force and passes --keep to mergeAgent, into the caller's directory", async () => {
    const target = await addTarget();
    const result = await runCli(["merge", "agent-x", "--force", "--keep"], {
      cwd: target.repoPath,
      actions: { mergeAgent: "record" },
    });
    expect(result.stderr).not.toContain("unknown arguments");
    const { args } = onlyAction(result);
    expect((args[0] as Agent).id).toBe(target.id);
    expect(args[1]).toBe(result.context.cwd);
    expect(args[2]).toEqual({ keep: true });
  });

  test("merge refuses a cwd outside the agent's repo before reaching a handler", async () => {
    await addTarget();
    const { stderr, exitCode, actions } = await runCli(["merge", "agent-x"], { actions: { mergeAgent: "record" } });
    expect(stderr).toContain("Refusing to merge: cwd is not inside agent's repo");
    expect(exitCode).toBe(1);
    expect(actions).toEqual([]);
  });

  test("resume strips --force from args", async () => {
    const { stderr, exitCode } = await runCli(["resume"]);
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  test("nuke by a human caller reaches nukeAgent", async () => {
    const target = await addTarget();
    const result = await runCli(["nuke", "agent-x"], { actions: { nukeAgent: "record" } });
    expect((onlyAction(result).args[0] as Agent).id).toBe(target.id);
  });

  test("new-agent without prompt reaches newAgent, which requires one", async () => {
    await cli.addRepo("only-repo");
    const { stderr, exitCode } = await runCli(["new-agent"], { actions: { newAgent: "real" } });
    expect(stderr).toContain("prompt required");
    expect(exitCode).toBe(1);
  });

  test("new-agent with no registered repo cannot choose a target", async () => {
    const { stderr, exitCode, actions } = await runCli(["new-agent", "hello"], { actions: { newAgent: "record" } });
    expect(stderr).toContain("Cannot determine target repo");
    expect(exitCode).toBe(1);
    expect(actions).toEqual([]);
  });

  test("new-agent parses every option into newAgent's arguments", async () => {
    const repo = await cli.addRepo("only-repo");
    const result = await runCli(
      [
        "new-agent", "--type", "worker", "--model", "claude:opus", "--effort", "high", "--manager", "agent-mgr",
        "--name", "the-name", "--no-worktree", "--repo", "only-repo", "--spawned-by", "agent-spawner",
        "--spawned-by-repo", "/some/repo", "do", "the", "thing",
      ],
      { actions: { newAgent: "record" } },
    );
    expect(result.exitCode).toBe(0);
    const { name, args } = onlyAction(result);
    expect(name).toBe("newAgent");
    expect(args).toEqual([
      repo,
      "do the thing",
      {
        type: "worker",
        model: "claude:opus",
        effort: "high",
        manager: "agent-mgr",
        name: "the-name",
        noWorktree: true,
        spawnedBy: { agent_id: "agent-spawner", repo_path: "/some/repo" },
      },
    ]);
  });

  test("new is an alias of new-agent, and --spawned-by defaults its repo to the cwd", async () => {
    await cli.addRepo("only-repo");
    const result = await runCli(["new", "--spawned-by", "agent-spawner", "hello"], { actions: { newAgent: "record" } });
    const { args } = onlyAction(result);
    expect(args[1]).toBe("hello");
    expect(args[2]).toEqual({ spawnedBy: { agent_id: "agent-spawner", repo_path: result.context.cwd } });
  });

  test("new-agent --spawned-by-repo without --spawned-by is rejected", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--spawned-by-repo", "/some/repo", "hello"]);
    expect(stderr).toContain("--spawned-by-repo requires --spawned-by");
    expect(exitCode).toBe(1);
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

  test("new-agent --allow is now rejected as an unknown flag", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--allow", "Read", "hello"]);
    expect(stderr).toContain("unknown flag '--allow'");
    expect(exitCode).toBe(1);
  });

  test("new-agent --deny is now rejected as an unknown flag", async () => {
    const { stderr, exitCode } = await runCli(["new-agent", "--deny", "Read", "hello"]);
    expect(stderr).toContain("unknown flag '--deny'");
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
    const missing = join(cli.root, "missing.md");
    const { stderr, exitCode } = await runCli(["new-agent", "-f", missing]);
    expect(stderr).toContain("prompt file not found");
    expect(stderr).toContain(missing);
    expect(exitCode).toBe(1);
  });

  test.each([["--prompt-file"], ["--file"], ["-f"]])(
    "new-agent %s reads the prompt from the file",
    async (flag) => {
      await cli.addRepo("only-repo");
      const file = join(cli.root, "prompt.md");
      await Bun.write(file, "prompt from file");
      const result = await runCli(["new-agent", flag, file], { actions: { newAgent: "record" } });
      expect(result.exitCode).toBe(0);
      expect(onlyAction(result).args[1]).toBe("prompt from file");
    },
  );

  test("new-agent allows '-x' after the first prompt token (treated as prompt body)", async () => {
    // After the first positional prompt token, a leading '-' is part of the
    // prompt body, not a flag.
    await cli.addRepo("only-repo");
    const result = await runCli(["new-agent", "hello", "-x", "world"], { actions: { newAgent: "record" } });
    expect(result.stderr).not.toContain("unknown flag");
    expect(onlyAction(result).args[1]).toBe("hello -x world");
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
    await addTarget();
    const result = await runCli(["send", "agent-x", "-n hello"], { actions: { sendMessage: "record" } });
    expect(result.stderr).not.toContain("unknown flag");
    expect(onlyAction(result).args[1]).toBe("-n hello");
  });

  test("send treats unquoted '-n' as message body when it comes after the target", async () => {
    // Unquoted form: shell splits into multiple argv tokens; the first
    // non-flag token is the target, and subsequent tokens (including '-n')
    // are joined as the message body.
    await addTarget();
    const result = await runCli(["send", "agent-x", "-n", "hello"], { actions: { sendMessage: "record" } });
    expect(result.stderr).not.toContain("unknown flag");
    expect(onlyAction(result).args[1]).toBe("-n hello");
  });

  // ── Heredoc / stdin fallback (mirrors `ib send`) ──────────────────────────
  // Without a `stdin` option the child's stdin is /dev/null, a non-TTY that reads
  // as "". With one, that text is piped in and the heredoc fallback runs.

  test("ask reads question from stdin when no positional question (heredoc)", async () => {
    const target = await addTarget("agent-deadbeef");
    const result = await runCli(["ask", "--id", "agent-deadbeef"], {
      stdin: "what should I do next?\n",
      actions: { askQuestion: "record" },
    });
    expect(result.stderr).not.toContain("Usage: ib ask");
    expect(onlyAction(result).args).toEqual([target.repoPath, "agent-deadbeef", "what should I do next?"]);
  });

  test("ask with empty stdin and no positional still shows usage error (TTY-parity)", async () => {
    // Empty piped stdin resolves to "" — same as a TTY with no arg — so the
    // existing usage error must still fire.
    const { stderr, exitCode } = await runCli(["ask", "--id", "agent-deadbeef"], { stdin: "" });
    expect(stderr).toContain("Usage: ib ask");
    expect(exitCode).toBe(1);
  });

  test("ask positional question takes precedence over stdin", async () => {
    await addTarget("agent-deadbeef");
    const result = await runCli(["ask", "--id", "agent-deadbeef", "inline question"], {
      stdin: "stdin question that should be ignored\n",
      actions: { askQuestion: "record" },
    });
    expect(onlyAction(result).args[2]).toBe("inline question");
  });

  test("ask for an unregistered agent reports it after reading the question", async () => {
    const { stderr, exitCode } = await runCli(["ask", "--id", "agent-deadbeef"], { stdin: "a question\n" });
    expect(stderr).not.toContain("Usage: ib ask");
    expect(stderr).toContain("Agent not found: agent-deadbeef");
    expect(exitCode).toBe(1);
  });

  test("ask detects the agent id from an agent-shaped cwd", async () => {
    const target = await addTarget("agent-fromcwd");
    const result = await runCli(["ask", "a question"], { cwd: target.sessionCwd, actions: { askQuestion: "record" } });
    expect(onlyAction(result).args[1]).toBe("agent-fromcwd");
  });

  test("ask outside an agent worktree without --id cannot detect an agent", async () => {
    const { stderr, exitCode } = await runCli(["ask", "a question"]);
    expect(stderr).toContain("Could not detect agent ID");
    expect(exitCode).toBe(1);
  });

  test("new-agent reads prompt from stdin (heredoc) with metachars preserved", async () => {
    // The stdin reader does no expansion (only .trim()), and a quoted heredoc
    // keeps the shell from expanding them before ib sees stdin.
    const repo = await cli.addRepo("stdinrepo");
    const result = await runCli(["new-agent", "--repo", "stdinrepo", "--type", "worker"], {
      stdin: "fix $(whoami) and `date` for $USER literally\n",
      actions: { newAgent: "record" },
    });
    expect(result.stderr).not.toContain("prompt required");
    expect(onlyAction(result).args).toEqual([repo, "fix $(whoami) and `date` for $USER literally", { type: "worker" }]);
  });

  test("new-agent with empty stdin + registered repo still errors 'prompt required'", async () => {
    // Empty piped stdin → empty prompt → newAgent()'s first-line check fires.
    // This proves the TTY-parity error is preserved when nothing is piped.
    await cli.addRepo("emptyrepo");
    const { stderr, exitCode } = await runCli(["new-agent", "--repo", "emptyrepo"], {
      stdin: "",
      actions: { newAgent: "real" },
    });
    expect(stderr).toContain("prompt required");
    expect(exitCode).toBe(1);
  });

  test("new-agent positional prompt takes precedence over stdin", async () => {
    await cli.addRepo("precrepo");
    const result = await runCli(["new-agent", "--repo", "precrepo", "inline prompt"], {
      stdin: "stdin prompt that should be ignored\n",
      actions: { newAgent: "record" },
    });
    expect(onlyAction(result).args[1]).toBe("inline prompt");
  });

  test("new-agent -f <empty-file> suppresses stdin fallback (prompt required)", async () => {
    // Precedence guarantee: an explicit -f wins over stdin even when the file is
    // empty (matching `send`'s "-f > stdin"). A genuinely empty (0-byte) file is
    // the exact root cause: -f pushes "" into promptParts, prompt becomes ""
    // (falsy), and WITHOUT the promptFromFile guard the `if (!prompt)` fallback
    // would read stdin.
    await cli.addRepo("femptyrepo");
    const emptyFile = join(cli.root, "empty.md");
    await Bun.write(emptyFile, "");
    const piped = "stdin body that must NOT leak in\n";
    const recorded = await runCli(["new-agent", "--repo", "femptyrepo", "-f", emptyFile], {
      stdin: piped,
      actions: { newAgent: "record" },
    });
    expect(onlyAction(recorded).args[1]).toBe("");
    const real = await runCli(["new-agent", "--repo", "femptyrepo", "-f", emptyFile], {
      stdin: piped,
      actions: { newAgent: "real" },
    });
    expect(real.stderr).toContain("prompt required");
    expect(real.exitCode).toBe(1);
  });

  test("new-agent -f <non-empty-file> wins over stdin (file content used)", async () => {
    await cli.addRepo("fwinsrepo");
    const promptFile = join(cli.root, "prompt.md");
    await Bun.write(promptFile, "real prompt from file\n");
    const result = await runCli(["new-agent", "--repo", "fwinsrepo", "-f", promptFile], {
      stdin: "stdin body that should be ignored\n",
      actions: { newAgent: "record" },
    });
    expect(onlyAction(result).args[1]).toBe("real prompt from file\n");
  });

  // --- new-agent --repo resolution (shared resolveRepo) ---
  // Each case registers a repo whose registry id (nickname) differs from its
  // directory basename, then proves which path `--repo <key>` hands to newAgent —
  // or that it fails with the right message and reaches no handler.

  /** A registry mirroring the reported bug: nickname "passwhats", basename "Pandora". */
  async function writePasswhatsRegistry(): Promise<string> {
    const path = join(cli.root, "ib-resolve-pandora");
    await cli.writeRegistry({ version: 1, repos: [{ path, name: "Pandora", nickname: "passwhats" }] });
    return path;
  }

  test.each([
    ["registry id (nickname)", "passwhats"],
    ["directory basename even when a nickname is set", "Pandora"],
    ["basename case-insensitively", "pandora"],
  ])("new-agent --repo resolves by %s", async (_label, key) => {
    const repo = await writePasswhatsRegistry();
    const result = await runCli(["new-agent", "--repo", key, "hi"], { actions: { newAgent: "record" } });
    expect(result.stderr).not.toContain("Repo not found");
    expect(onlyAction(result).args[0]).toBe(repo);
  });

  test("new-agent --repo still reports 'Repo not found' for a genuinely unknown key", async () => {
    await writePasswhatsRegistry();
    const { stderr, exitCode, actions } = await runCli(["new-agent", "--repo", "does-not-exist", "hi"], {
      actions: { newAgent: "record" },
    });
    expect(stderr).toContain("Repo not found: does-not-exist");
    expect(exitCode).toBe(1);
    expect(actions).toEqual([]);
  });

  test("new-agent --repo fails with a candidate list on an ambiguous key", async () => {
    const pathA = join(cli.root, "ib-resolve-a-foo");
    const pathB = join(cli.root, "ib-resolve-b-bar");
    await cli.writeRegistry({
      version: 1,
      repos: [
        { path: pathA, name: "foo" },
        { path: pathB, name: "bar", nickname: "foo" },
      ],
    });
    const { stderr, exitCode, actions } = await runCli(["new-agent", "--repo", "foo", "hi"], {
      actions: { newAgent: "record" },
    });
    expect(stderr).toContain("Ambiguous repo");
    expect(stderr).toContain(pathA);
    expect(stderr).toContain(pathB);
    expect(exitCode).toBe(1);
    expect(actions).toEqual([]);
  });

  test("new-agent picks the repo containing the cwd when several are registered", async () => {
    const repoA = await cli.addRepo("repo-a");
    await cli.addRepo("repo-b");
    const result = await runCli(["new-agent", "hi"], { cwd: repoA, actions: { newAgent: "record" } });
    expect(onlyAction(result).args[0]).toBe(repoA);
  });

  test("new-agent still rejects flag typos before reading stdin (guard intact)", async () => {
    // The flag-typo guard must fire during arg parsing, before any stdin read,
    // so a piped body does not mask a typo like '-F'.
    const { stderr, exitCode } = await runCli(["new-agent", "-F", "/tmp/foo.md"], { stdin: "some piped body\n" });
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

  test("look without an agent-id shows usage", async () => {
    const { stderr } = await runCli(["look"]);
    expect(stderr).toContain("Usage:");
  });

  test("acknowledge without question-id shows usage", async () => {
    const { stderr, exitCode } = await runCli(["acknowledge"]);
    expect(stderr).toContain("Usage: ib acknowledge <question-id>");
    expect(exitCode).toBe(1);
  });

  test("bare ack requires a manager session", async () => {
    const { stderr, exitCode } = await runCli(["ack"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("manager's own agent session");
    expect(stderr).toContain("ib acknowledge <question-id>");
  });

  test("ack --help prints the ack help, not the question help", async () => {
    const { stdout } = await runCli(["ack", "--help"]);
    expect(stdout).toContain("Usage: ib ack [agent-id]");
    expect(stdout).toContain("Omit agent-id");
    expect(stdout).not.toContain("question-id");
  });

  test("questions (q alias) with no repos shows message", async () => {
    const { stdout } = await runCli(["q"]);
    expect(stdout).toContain("No repos registered");
  });

  // ── HIGH 2 from Phase 4 review: write-pid CLI surface ─────────────────────
  async function makeDuplicatePidFixture(worktree: boolean): Promise<{
    root: string;
    home: string;
    agentDirA: string;
    agentDirB: string;
    cwdB: string;
  }> {
    const root = cli.root;
    const home = cli.home;
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    const agentId = "agent-duplicate-pid";
    const agentDirA = join(repoA, ".itsybitsy", "agents", agentId);
    const agentDirB = join(repoB, ".itsybitsy", "agents", agentId);
    const cwdA = worktree ? join(agentDirA, "repo") : repoA;
    const cwdB = worktree ? join(agentDirB, "repo") : repoB;
    await mkdir(cwdA, { recursive: true });
    await mkdir(cwdB, { recursive: true });
    await cli.writeRegistry({ repos: [
      { path: repoA, name: "repo-a" },
      { path: repoB, name: "repo-b" },
    ] });
    await Bun.write(join(agentDirA, "meta.json"), JSON.stringify({
      id: agentId,
      worktree,
      marker: "A",
    }));
    await Bun.write(join(agentDirB, "meta.json"), JSON.stringify({
      id: agentId,
      worktree,
      marker: "B",
    }));
    return { root, home, agentDirA, agentDirB, cwdB };
  }

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

  test("write-pid binds a duplicate no-worktree ID to the registered launcher cwd", async () => {
    const fixture = await makeDuplicatePidFixture(false);
    const { stderr, exitCode } = await runCli(
      ["write-pid", "agent-duplicate-pid", "43210"],
      { stdin: "", cwd: fixture.cwdB },
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const metaA = await Bun.file(join(fixture.agentDirA, "meta.json")).json();
    const metaB = await Bun.file(join(fixture.agentDirB, "meta.json")).json();
    expect(metaA.claude_pid).toBeUndefined();
    expect(metaB.claude_pid).toBe("43210");
    expect(metaB.claude_pid_epoch).toBeNumber();
  });

  test("write-proxy-pid binds a duplicate worktree ID to the registered launcher cwd", async () => {
    const fixture = await makeDuplicatePidFixture(true);
    const { stderr, exitCode } = await runCli(
      ["write-proxy-pid", "agent-duplicate-pid", "43211", "43212"],
      { stdin: "", cwd: fixture.cwdB },
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const metaA = await Bun.file(join(fixture.agentDirA, "meta.json")).json();
    const metaB = await Bun.file(join(fixture.agentDirB, "meta.json")).json();
    expect(metaA.sandbox_proxy_pid).toBeUndefined();
    expect(metaB.sandbox_proxy_pid).toBe(43211);
    expect(metaB.sandbox_proxy_port).toBe(43212);
  });

  test("PID writers reject duplicate IDs when cwd is not either registered launch path", async () => {
    const fixture = await makeDuplicatePidFixture(false);
    const { stderr, exitCode } = await runCli(
      ["write-pid", "agent-duplicate-pid", "43213"],
      { stdin: "", cwd: fixture.root },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("is not registered for launcher cwd");
    const metaA = await Bun.file(join(fixture.agentDirA, "meta.json")).json();
    const metaB = await Bun.file(join(fixture.agentDirB, "meta.json")).json();
    expect(metaA.claude_pid).toBeUndefined();
    expect(metaB.claude_pid).toBeUndefined();
  });
});

// ─── list-types CLI command ─────────────────────────────────────────────────

describe("list-types CLI command", () => {
  test("list-types prints all default types and exits 0", async () => {
    const { stdout, exitCode } = await runIsolatedCli(["list-types"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("NAME");
    expect(stdout).toContain("SPAWNABLE");
    expect(stdout).toContain("SPAWNS CHILDREN");
    expect(stdout).toContain("DESCRIPTION");
    expect(stdout).toContain("manager");
    expect(stdout).toContain("worker");
    expect(stdout).toContain("repo-coordinator");
    expect(stdout).toContain("system-coordinator");
    expect(stdout).toContain("_all");
    expect(stdout).toContain("_non_coordinator");
    // Layer-only types should be marked non-spawnable with "-" for spawns-children
    const lines = stdout.split("\n");
    const allLine = lines.find((l) => l.startsWith("_all "));
    expect(allLine).toBeDefined();
    expect(allLine).toContain("no");
    expect(allLine).toContain("-");
  });

  test("list-agent-types alias works the same as list-types", async () => {
    const { stdout, exitCode } = await runIsolatedCli(["list-agent-types"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("manager");
    expect(stdout).toContain("worker");
    expect(stdout).toContain("repo-coordinator");
  });

  test("list-types output is sorted alphabetically", async () => {
    const { stdout, exitCode } = await runIsolatedCli(["list-types"]);
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    // Skip header — collect type names from data rows
    const dataLines = lines.slice(1);
    const names = dataLines.map((l) => l.split(/\s+/)[0]!).filter((n) => n.length > 0);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  test("help text mentions list-types", async () => {
    const { stdout, exitCode } = await runIsolatedCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("list-types");
  });
});

// ─── show-type CLI command ─────────────────────────────────────────────────

describe("show-type CLI command", () => {
  test("show-type prints the manager definition and exits 0", async () => {
    const { stdout, exitCode } = await runIsolatedCli(["show-type", "manager"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("NAME: manager");
    expect(stdout).toContain("DESCRIPTION:");
    expect(stdout).toContain("SPAWNABLE: yes");
    expect(stdout).toContain("SPAWNS CHILDREN: yes");
    expect(stdout).not.toContain("INSTRUCTION STYLE");
    expect(stdout).toContain("PERMISSIONS ALLOW");
    expect(stdout).toContain("PERMISSIONS DENY");
    expect(stdout).toContain("PROMPT BODY");
    expect(stdout).toContain("substituted at spawn time");
    // Prompt body should contain a templated placeholder from the manager type
    expect(stdout).toContain("{{agentId}}");
  });

  test("show-type --json emits valid JSON with expected fields", async () => {
    const { stdout, exitCode } = await runIsolatedCli(["show-type", "worker", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe("worker");
    expect(typeof parsed.description).toBe("string");
    expect(typeof parsed.canSpawnChildren).toBe("boolean");
    expect(typeof parsed.markdownBody).toBe("string");
  });

  test("show-agent-type alias works the same as show-type", async () => {
    const { stdout, exitCode } = await runIsolatedCli(["show-agent-type", "worker"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("NAME: worker");
  });

  test("show-type with unknown name errors and exits 1", async () => {
    const { stderr, exitCode } = await runIsolatedCli(["show-type", "nonexistent-type-xyz"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("nonexistent-type-xyz");
    expect(stderr).toContain("ib list-types");
  });

  test("show-type with no name prints usage and exits 1", async () => {
    const { stderr, exitCode } = await runIsolatedCli(["show-type"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  test("help text mentions show-type", async () => {
    const { stdout, exitCode } = await runIsolatedCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("show-type");
  });
});

// ─── nickname CLI command ───────────────────────────────────────────────────

describe("nickname CLI command", () => {
  let cli: CliFixture;
  beforeEach(async () => { cli = await createCliFixture(); });
  afterEach(async () => { await cli.cleanup(); });

  async function addAgent(id: string, extraMeta: Record<string, unknown> = {}) {
    return cli.addAgent(await cli.addRepo("nick-repo"), id, extraMeta);
  }

  test("set nickname writes it and exits 0", async () => {
    const { agentDir } = await addAgent("agent-nick1");
    const { exitCode } = await cli.run(["nickname", "agent-nick1", "pikachu"]);
    expect(exitCode).toBe(0);
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.nickname).toBe("pikachu");
  });

  test("no-arg shows the current nickname", async () => {
    await addAgent("agent-nick2", { nickname: "charmander" });
    const { stdout, exitCode } = await cli.run(["nickname", "agent-nick2"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("charmander");
  });

  test("no-arg shows placeholder when no nickname set", async () => {
    await addAgent("agent-nick3");
    const { stdout, exitCode } = await cli.run(["nickname", "agent-nick3"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("(no nickname set)");
  });

  test("--clear deletes the nickname field", async () => {
    const { agentDir } = await addAgent("agent-nick4", { nickname: "squirtle" });
    const { exitCode } = await cli.run(["nickname", "agent-nick4", "--clear"]);
    expect(exitCode).toBe(0);
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect("nickname" in meta).toBe(false);
  });

  test("the agent resolves by its nickname (requireAgent)", async () => {
    await addAgent("agent-nick5", { nickname: "snorlax" });
    const result = await cli.run(["retire", "snorlax"], { actions: { retireAgent: "record" } });
    expect(result.stderr).not.toContain("Agent not found");
    expect(result.actions.length).toBe(1);
    expect((result.actions[0]!.args[0] as Agent).id).toBe("agent-nick5");
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
    // since readAllAgents will find no agents in empty .itsybitsy dirs
    const { agent, isSystemCoordinator } = await resolveTarget("agent1", repos, "/tmp");
    // Since no agents exist, it should return null
    expect(agent).toBeNull();
    expect(isSystemCoordinator).toBe(false);
  });

  test("@repo/agent-id syntax is recognized", async () => {
    const repos: RepoEntry[] = [
      { path: "/repo1", name: "repo1" },
    ];
    // This will fail to find agents since repos don't have .itsybitsy dirs
    const { agent, isSystemCoordinator } = await resolveTarget("@repo1/agent1", repos);
    expect(agent).toBeNull();
    expect(isSystemCoordinator).toBe(false);
  });

  test("@repo-name syntax is recognized", async () => {
    const repos: RepoEntry[] = [
      { path: "/repo1", name: "repo1" },
    ];
    // This will fail to find a coordinator since repo has no .itsybitsy dir
    const { agent, isSystemCoordinator } = await resolveTarget("@repo1", repos);
    expect(agent).toBeNull();
    expect(isSystemCoordinator).toBe(false);
  });
});

// ─── @system delivery (sendToSystemCoordinator) ──────────────────────────

describe("messageBodyReader (ib send)", () => {
  /** Like real stdin: the text on the first read, "" after it is consumed. */
  function fakeStdin(text: string) {
    let reads = 0;
    return {
      read: async (): Promise<string> => (reads++ === 0 ? text : ""),
      reads: () => reads,
    };
  }

  // The send broker reads the body first; when its watchdog cannot take the
  // request, the direct path reads it again. Both must see the same text.
  test("stdin is read once, and every call returns the same text", async () => {
    const stdin = fakeStdin("from a heredoc");
    const read = messageBodyReader("", undefined, stdin.read);
    expect(await read()).toBe("from a heredoc");
    expect(await read()).toBe("from a heredoc");
    expect(stdin.reads()).toBe(1);
  });

  test("an inline message wins, and stdin is never read", async () => {
    const stdin = fakeStdin("ignored");
    const read = messageBodyReader("inline text", "file text", stdin.read);
    expect(await read()).toBe("inline text");
    expect(stdin.reads()).toBe(0);
  });

  test("a file body wins over stdin, even when it is empty", async () => {
    const stdin = fakeStdin("ignored");
    expect(await messageBodyReader("", "file text", stdin.read)()).toBe("file text");
    expect(await messageBodyReader("", "", stdin.read)()).toBe("");
    expect(stdin.reads()).toBe(0);
  });
});

describe("buildSystemCoordinatorAgent", () => {
  test("uses /tmp as repoPath when cwd is not inside an agent worktree", () => {
    const a = buildSystemCoordinatorAgent("ib-coordinator", "/some/random/dir");
    expect(a.repoPath).toBe("/tmp");
    expect(a.id).toBe("ib-coordinator");
    expect(a.meta.tmux_session).toBe("ib-coordinator");
  });

  test("uses the sender's repo root when cwd is inside an agent worktree", () => {
    const cwd = "/Users/me/project/.itsybitsy/agents/agent-abc123/repo/src";
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
    // tmux send-keys path: has-session probe + pane-mode probe + literal-paste
    // + Enter.
    expect(spawnCalls.length).toBe(4);
    expect(spawnCalls[0]).toEqual(["tmux", "has-session", "-t", "=" + IB_COORDINATOR_SESSION + ":"]);
    expect(spawnCalls[1]).toEqual([
      "tmux",
      "display-message",
      "-p",
      "-t",
      "=" + IB_COORDINATOR_SESSION + ":",
      "#{pane_in_mode}",
    ]);
    expect(spawnCalls[2]).toEqual([
      "tmux",
      "send-keys",
      "-t",
      "=" + IB_COORDINATOR_SESSION + ":",
      "-l",
      "--",
      "[sent by user]: hello world",
    ]);
    expect(spawnCalls[3]).toEqual(["tmux", "send-keys", "-t", "=" + IB_COORDINATOR_SESSION + ":", "Enter"]);
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

// ─── parseMergeArgs ──────────────────────────────────────────────────────────
//
// `ib merge <id> [--force] [--keep]`: the id is the first non-flag argument,
// --keep turns on the merge-without-closing path, --force is a compatibility
// no-op, and anything else is reported back as unknown (the CLI warns and
// ignores it — matching the pre-existing behaviour for stray arguments).

describe("parseMergeArgs", () => {
  test("bare id: no keep, nothing unknown", () => {
    expect(parseMergeArgs(["agent-abc"])).toEqual({ agentId: "agent-abc", keep: false, unknown: [] });
  });

  test("no arguments: undefined id so requireAgent prints usage", () => {
    expect(parseMergeArgs([])).toEqual({ agentId: undefined, keep: false, unknown: [] });
  });

  test("--keep after the id", () => {
    expect(parseMergeArgs(["agent-abc", "--keep"])).toEqual({ agentId: "agent-abc", keep: true, unknown: [] });
  });

  test("--keep before the id", () => {
    expect(parseMergeArgs(["--keep", "agent-abc"])).toEqual({ agentId: "agent-abc", keep: true, unknown: [] });
  });

  test("--force is accepted and ignored, on either side of the id", () => {
    expect(parseMergeArgs(["agent-abc", "--force"])).toEqual({ agentId: "agent-abc", keep: false, unknown: [] });
    expect(parseMergeArgs(["--force", "agent-abc"])).toEqual({ agentId: "agent-abc", keep: false, unknown: [] });
  });

  test("--keep and --force combine", () => {
    expect(parseMergeArgs(["agent-abc", "--force", "--keep"])).toEqual({ agentId: "agent-abc", keep: true, unknown: [] });
  });

  test("unknown flags and extra positionals are reported, not swallowed", () => {
    expect(parseMergeArgs(["agent-abc", "--into", "main", "--keep"])).toEqual({
      agentId: "agent-abc", keep: true, unknown: ["--into", "main"],
    });
  });

  test("a flag alone never becomes the id", () => {
    expect(parseMergeArgs(["--keep"])).toEqual({ agentId: undefined, keep: true, unknown: [] });
    expect(parseMergeArgs(["--bogus"])).toEqual({ agentId: undefined, keep: false, unknown: ["--bogus"] });
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
  let cli: CliFixture;

  const runCli = (cliArgs: string[]) => cli.run(cliArgs);

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
  async function runCliSetup(cliArgs: string[]) {
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
    cli = await createCliFixture();
  });

  afterEach(async () => {
    await cli.cleanup();
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
  // Both files are real entry points and the project builds the binary from
  // BOTH depending on which instruction you follow: package.json's `build`
  // script compiles src/index.ts, while AGENTS.md documents
  // `bun build --compile ... index.ts` (the root shim). Dispatch is guarded by
  // `import.meta.main`, which is per-module — so a guard that only covers one
  // file silently produces a binary that starts up and does nothing. That is
  // not a theoretical worry: guarding only src/index.ts did exactly that, and
  // no existing test caught it because every other CLI test spawns
  // src/index.ts, the entry that still worked. Those tests now go through the
  // test driver, so these are the only ones that run either real entry point,
  // and they are limited to inert commands (runInertEntryPoint).
  test.each([["index.ts"], ["src/index.ts"]] as const)(
    "%s dispatches commands when run as the entry point",
    async (entry) => {
      const { stdout, exitCode } = await runInertEntryPoint(entry, ["list-types"]);
      expect(exitCode).toBe(0);
      // A known row from the agent-type table — proves the command actually ran
      // rather than the process merely exiting 0 with no output.
      expect(stdout).toContain("repo-coordinator");
    },
  );

  // The other half of the contract: importing must NOT dispatch. Without this,
  // `bun test <filter>` runs main() inside the test runner with the filter bound
  // to process.argv[2], so `bun test send` / `merge` / `nuke` would execute those
  // commands for real against the developer's repos.
  test.each([["index.ts"], ["src/index.ts"]] as const)(
    "importing %s runs no CLI dispatch",
    async (entry) => {
      const { stdout, stderr, exitCode } = await runEntryPointImport(entry);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("IMPORT_OK");
      // Assert against the banner printUsage() actually emits. Under `bun -e`
      // argv[2] is undefined, so a leaked dispatch lands on main()'s DEFAULT
      // branch — it does NOT print "Usage: ib" (that string only appears in
      // per-command help) and it does NOT print the list-types table. Asserting
      // absence of those made this test pass under the very regression it
      // exists to catch; these two strings are what a leak really prints.
      expect(stdout).not.toContain("Cross-repo agent dashboard");
      expect(stdout).not.toContain("Registry:");
      expect(stderr).not.toContain("Cross-repo agent dashboard");
    },
  );
});

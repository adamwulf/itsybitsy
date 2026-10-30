/**
 * The regression tests for CLI test isolation, and the routing the old tests could
 * only reach by accident.
 *
 * The observed failure: a parsing test launched the CLI from the real agent's
 * worktree with only HOME overridden, inside that agent's sandbox. Routing
 * identified the real agent from the cwd, found its live watchdog and queued a
 * spawn, so three tests that expected "spawn fails: no repos" created three real
 * agents. Nothing here touches a real agent, queue, registry or tmux server: the
 * "live" state is a sentinel fixture, shaped so that it WOULD receive traffic (one
 * test proves that it does), and compared byte for byte after every run.
 *
 * Client side: the real main(), the real brokers and the real caller check. Server
 * side: the real queue handling (processSpawnRequests) with fake terminal operations.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { writeAgentTransient, type Agent } from "./agents";
import { ensureSpawnBrokerDirs, spawnRequestDir, spawnResultDir, type SpawnServerDeps } from "./spawn-broker";
import { CLI_DRIVER_CONFIG_ENV, type CliActionName, type CliDriverConfig } from "./test-cli-driver";
import {
  createCliFixture,
  isInertCliCommand,
  runEntryPointImport,
  runInertEntryPoint,
  runIsolatedCli,
  withFixtureWatchdog,
  type CliFixture,
  type FixtureAgent,
} from "./test-cli-runner";
import { makeAgent } from "./test-utils";

setDefaultTimeout(60_000);

const REPO_ROOT = join(import.meta.dir, "..");

interface BrokerCall {
  op: string;
  args: unknown[];
}

/**
 * A watchdog's dependencies, with every terminal operation recorded and nothing
 * real behind it. The seal check and the lookups that would read the real registry
 * are fixed; callers override what a test is about.
 */
function fakeWatchdogDeps(calls: BrokerCall[], repoPath: string, overrides: Partial<SpawnServerDeps> = {}): SpawnServerDeps {
  const record = (op: string) => async (...args: unknown[]) => {
    calls.push({ op, args });
    return { ok: true, exitCode: 0, stdout: `fake ${op} done`, stderr: "" };
  };
  return {
    verifySeal: async () => ({ ok: true }),
    newAgent: record("newAgent"),
    askQuestion: record("askQuestion"),
    lifecycle: {
      authorize: async () => null,
      findAgent: async (repo, id) => makeAgent({ id, repoPath: repo, storageDir: join(repo, ".ittybitty", "agents", id) }),
      retire: record("retire"),
      merge: record("merge"),
      rehire: record("rehire"),
    },
    send: {
      listRepos: async () => [{ path: repoPath, name: "caller-repo" }],
      sendMessage: record("sendMessage"),
      teamSend: record("teamSend"),
      sendToSystemCoordinator: record("sendToSystemCoordinator"),
    },
    ...overrides,
  };
}

/** A heartbeat that says this agent's watchdog is alive, with nothing serving its queue. */
async function writeHeartbeat(agent: FixtureAgent): Promise<void> {
  await writeAgentTransient(agent.agentDir, {
    tmux_compacting: false,
    tmux_rate_limited: false,
    tmux_api_error: false,
    tmux_api_terms: false,
    tmux_api_safeguard: false,
    has_background_tasks: false,
    updated_at_ms: Date.now(),
    watchdog_pid: process.pid,
  });
}

/** Every path under a directory with its mtime and content, to prove nothing changed. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const { mtimeMs } = await stat(path);
      if (entry.isDirectory()) {
        result[relative(root, path)] = `dir ${mtimeMs}`;
        await walk(path);
      } else {
        result[relative(root, path)] = `file ${mtimeMs} ${await readFile(path, "utf-8")}`;
      }
    }
  };
  await walk(root);
  return result;
}

async function queueEntries(agent: FixtureAgent): Promise<string[]> {
  const list = (dir: string) => readdir(dir).catch(() => [] as string[]);
  return [...await list(spawnRequestDir(agent.agentDir)), ...await list(spawnResultDir(agent.agentDir))];
}

describe("the isolated CLI runner", () => {
  test("the child gets only an explicit environment, a temporary cwd and HOME, and an absolute entry", async () => {
    process.env.IB_TEST_SENTINEL_INHERITED = "must-not-reach-the-child";
    try {
      const { context } = await runIsolatedCli(["list-models"]);
      expect(context.envKeys).toEqual(["HOME", CLI_DRIVER_CONFIG_ENV, "PATH", "TMPDIR"].sort());
      const temp = realpathSync(tmpdir());
      expect(context.cwd.startsWith(`${temp}/`)).toBe(true);
      expect(context.home.startsWith(`${temp}/`)).toBe(true);
      expect(context.cwd).not.toBe(context.home);
      expect(context.cwd).not.toBe(realpathSync(process.cwd()));
      expect(context.entry).toBe(join(import.meta.dir, "test-cli-driver.ts"));
      expect(context.execPath).toBe(process.execPath);
    } finally {
      delete process.env.IB_TEST_SENTINEL_INHERITED;
    }
  });

  test("refuses this checkout as cwd or HOME before launching anything", async () => {
    await expect(runIsolatedCli(["new-agent", "x"], { cwd: process.cwd(), sandboxed: true })).rejects.toThrow("must be a temporary directory");
    await expect(runIsolatedCli(["new-agent", "x"], { cwd: REPO_ROOT })).rejects.toThrow("must be a temporary directory");
    await expect(runIsolatedCli(["list"], { home: process.cwd() })).rejects.toThrow("must be a temporary directory");
    await expect(runInertEntryPoint("index.ts", ["list-types"], { cwd: process.cwd() })).rejects.toThrow("must be a temporary directory");
  });

  test("refuses an agent-shaped temp directory, which would make every fixture look like that agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ib-cli-agent-tmp-"));
    const agentShaped = join(root, ".ittybitty", "agents", "agent-tmp", "repo");
    await mkdir(agentShaped, { recursive: true });
    const realTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = agentShaped;
    try {
      await expect(runIsolatedCli(["list"])).rejects.toThrow("is inside an agent directory");
    } finally {
      if (realTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = realTmpdir;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a real entry point runs inert commands only", () => {
    expect(() => runInertEntryPoint("index.ts", ["new-agent", "x"])).toThrow("use runIsolatedCli");
    expect(() => runInertEntryPoint("src/index.ts", ["send", "agent-x", "hi"])).toThrow("use runIsolatedCli");
    expect(isInertCliCommand(["init-types"])).toBe(false);
    expect(isInertCliCommand(["init-types", "--check"])).toBe(true);
    expect(isInertCliCommand(["retire", "agent-x", "--help"])).toBe(true);
    expect(isInertCliCommand([])).toBe(true);
  });

  test("a real entry point dispatches an inert command and importing one dispatches nothing", async () => {
    const run = await runInertEntryPoint("index.ts", ["list-models"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("claude:opus");
    const imported = await runEntryPointImport("src/index.ts");
    expect(imported.exitCode).toBe(0);
    expect(imported.stdout).toBe("IMPORT_OK\n");
  });

  test("the driver will not run without its config, or outside the fixture the config names", async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "ib-cli-driver-direct-")));
    const driver = join(import.meta.dir, "test-cli-driver.ts");
    const launch = async (env: Record<string, string>) => {
      const proc = Bun.spawn([process.execPath, "run", driver, "list-models"], {
        cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { HOME: dir, PATH: "/usr/bin:/bin", ...env },
      });
      const stderr = await new Response(proc.stderr).text();
      return { stderr, exitCode: await proc.exited };
    };
    try {
      const unconfigured = await launch({});
      expect(unconfigured.exitCode).toBe(2);
      expect(unconfigured.stderr).toContain(`${CLI_DRIVER_CONFIG_ENV} is not set`);

      const config: CliDriverConfig = { cwd: join(dir, "elsewhere"), home: dir, logDir: dir, sandboxed: false, actions: {}, allowedProcesses: [] };
      const misplaced = await launch({ [CLI_DRIVER_CONFIG_ENV]: JSON.stringify(config) });
      expect(misplaced.exitCode).toBe(2);
      expect(misplaced.stderr).toContain("started outside its fixture");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("production code never reads the driver's config or imports the test modules", async () => {
    const offenders: string[] = [];
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: REPO_ROOT, followSymlinks: false })) {
      if (path.startsWith("node_modules/") || path.startsWith(".ittybitty/")) continue;
      if (path.endsWith(".test.ts") || path === "test-preload.ts") continue;
      if (path === "src/test-cli-driver.ts" || path === "src/test-cli-runner.ts" || path === "src/test-utils.ts") continue;
      const source = await Bun.file(join(REPO_ROOT, path)).text();
      if (source.includes(CLI_DRIVER_CONFIG_ENV) || /(from\s+|import\(\s*|require\(\s*)["'][^"'\n]*test-cli-/.test(source)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no test launches a CLI entry point except through this runner", async () => {
    // A direct launch inherits the agent's cwd, environment and live routing. The
    // one exception starts the real proxy helper, which has no routing or caller check.
    const allowed = new Set(["src/sandbox-proxy.test.ts"]);
    const offenders: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.test.ts").scan({ cwd: REPO_ROOT, followSymlinks: false })) {
      if (allowed.has(path)) continue;
      const source = await Bun.file(join(REPO_ROOT, path)).text();
      const launches = source.match(/\[\s*(?:"bun"|process\.execPath)\s*,[^\]\n]*index\.ts[^\]\n]*\]/g) ?? [];
      offenders.push(...launches.filter((launch) => !launch.includes('"build"')).map((launch) => `${path}: ${launch}`));
    }
    expect(offenders).toEqual([]);
  });
});

describe("CLI routing cannot reach a live agent", () => {
  let cli: CliFixture;
  let live: CliFixture;
  let liveAgent: FixtureAgent;
  let liveBefore: Record<string, string>;
  let repo: string;
  let caller: FixtureAgent;
  let calls: BrokerCall[];
  /** What the observed failure inherited: a harness context that names the live agent. */
  let inheritedContext: Record<string, string>;

  beforeEach(async () => {
    live = await createCliFixture();
    liveAgent = await live.addAgent(await live.addRepo("live-repo"), "agent-live", { canSpawnChildren: true });
    await live.addAgent(liveAgent.repoPath, "agent-peer", { manager: "agent-live" });
    await ensureSpawnBrokerDirs(liveAgent.agentDir);
    await writeHeartbeat(liveAgent);
    liveBefore = await snapshot(live.root);
    inheritedContext = {
      PWD: liveAgent.sessionCwd,
      OLDPWD: liveAgent.sessionCwd,
      CLAUDE_PROJECT_DIR: liveAgent.sessionCwd,
      CLAUDE_SESSION_ID: "live-session",
      TMUX: join(live.root, "tmux-socket,1,0"),
      TMUX_PANE: "%0",
    };

    cli = await createCliFixture();
    repo = await cli.addRepo("caller-repo");
    caller = await cli.addAgent(repo, "agent-caller", { canSpawnChildren: true });
    await cli.addAgent(repo, "agent-peer", { manager: "agent-caller" });
    calls = [];
  });

  afterEach(async () => {
    await cli.cleanup();
    await live.cleanup();
  });

  const brokerRoutes: { args: string[]; op: string; expectArgs: (args: unknown[]) => void }[] = [
    {
      args: ["new-agent", "--type", "worker", "--name", "kid", "--effort", "high", "--manager", "agent-caller", "--no-worktree", "spawn", "this"],
      op: "newAgent",
      expectArgs: (args) => {
        expect(args[1]).toBe("spawn this");
        expect(args[2]).toMatchObject({ type: "worker", name: "kid", effort: "high", manager: "agent-caller", noWorktree: true });
      },
    },
    {
      args: ["send", "agent-peer", "hello", "peer"],
      op: "sendMessage",
      expectArgs: (args) => {
        expect((args[0] as Agent).id).toBe("agent-peer");
        expect(args[1]).toBe("hello peer");
        expect(args[2]).toEqual({ fromAgent: "agent-caller" });
      },
    },
    { args: ["retire", "agent-peer", "--force"], op: "retire", expectArgs: (args) => expect((args[0] as Agent).id).toBe("agent-peer") },
    {
      args: ["merge", "agent-peer", "--keep"],
      op: "merge",
      expectArgs: (args) => {
        expect((args[0] as Agent).id).toBe("agent-peer");
        expect(args[2]).toMatchObject({ keep: true });
      },
    },
    { args: ["rehire", "agent-gone"], op: "rehire", expectArgs: (args) => expect(args[0]).toBe("agent-gone") },
    { args: ["ask", "a", "question"], op: "askQuestion", expectArgs: (args) => expect(args.slice(1)).toEqual(["agent-caller", "a question"]) },
  ];

  test.each(brokerRoutes)("sandboxed $args.0 from an agent-shaped cwd uses only the fixture's queue", async ({ args, op, expectArgs }) => {
    const result = await withFixtureWatchdog(caller, fakeWatchdogDeps(calls, repo), () =>
      cli.run(args, { cwd: caller.sessionCwd, sandboxed: true, env: inheritedContext }));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`fake ${op} done`);
    expect(result.actions).toEqual([]); // the broker, not the direct path
    expect(calls.map((call) => call.op)).toEqual([op]);
    expectArgs(calls[0]!.args);
    expect(await queueEntries(caller)).toEqual([]);
    expect(await snapshot(live.root)).toEqual(liveBefore);
  });

  const directRoutes: { args: string[]; action: CliActionName }[] = [
    { args: ["new-agent", "spawn this"], action: "newAgent" },
    { args: ["send", "agent-peer", "hello peer"], action: "sendMessage" },
    { args: ["retire", "agent-peer"], action: "retireAgent" },
    { args: ["merge", "agent-peer"], action: "mergeAgent" },
    { args: ["rehire", "agent-gone"], action: "rehireAgent" },
    { args: ["ask", "a question"], action: "askQuestion" },
  ];

  test.each(directRoutes)("unsandboxed $args.0 from an agent-shaped cwd takes the direct path", async ({ args, action }) => {
    await writeHeartbeat(caller);
    const result = await cli.run(args, { cwd: caller.sessionCwd, env: inheritedContext, actions: { [action]: "record" } });

    expect(result.exitCode).toBe(0);
    expect(result.actions.map((recorded) => recorded.name)).toEqual([action]);
    expect(await queueEntries(caller)).toEqual([]);
    expect(await snapshot(live.root)).toEqual(liveBefore);
  });

  test("the observed failure, on sentinel data: the route follows the cwd, whatever HOME says", async () => {
    // What the old helper did: launch from the agent's worktree and override HOME.
    // The sentinel really does receive the request, which is why a temporary HOME
    // was never enough, and why the assertions above can be trusted.
    const result = await withFixtureWatchdog(liveAgent, fakeWatchdogDeps(calls, liveAgent.repoPath), () =>
      cli.run(["new-agent", "accidental spawn"], { cwd: liveAgent.sessionCwd, sandboxed: true, env: inheritedContext }));

    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.op)).toEqual(["newAgent"]);
    const opts = calls[0]!.args[2] as { _trustedCaller: { agentDir: string; meta: { id: string } } };
    expect(opts._trustedCaller.agentDir).toBe(liveAgent.agentDir);
    expect(opts._trustedCaller.meta.id).toBe("agent-live");
    // HOME was the fixture's, with no sign of the live repo in its registry.
    expect(await Bun.file(join(cli.home, ".itsybitsy", "repos.json")).text()).not.toContain("live-repo");
    expect(await queueEntries(caller)).toEqual([]);
    // And the snapshot every other test compares does notice this traffic.
    expect(await snapshot(live.root)).not.toEqual(liveBefore);
  });

  test("a run that outlives its deadline is killed and reported", async () => {
    await writeHeartbeat(caller); // looks alive, but nobody serves the queue
    await expect(
      cli.run(["retire", "agent-peer"], { cwd: caller.sessionCwd, sandboxed: true, timeoutMs: 1_500 }),
    ).rejects.toThrow("did not finish within 1500ms");
    expect(await snapshot(live.root)).toEqual(liveBefore);
  });

  describe("permissions on the broker route", () => {
    test.each([
      { args: ["new-agent", "--model", "claude:opus", "x"], message: "cannot pass --model" },
      { args: ["new-agent", "--repo", "caller-repo", "x"], message: "--repo is not supported inside the sandbox" },
      { args: ["new-agent", "--spawned-by", "agent-x", "x"], message: "--spawned-by / --spawned-by-repo are internal" },
      { args: ["send", "--from", "agent-other", "agent-peer", "x"], message: "--from for another agent is not supported" },
      { args: ["ask", "--id", "agent-other", "x"], message: "--id for another agent is not supported" },
    ])("the client refuses `ib $args.0 $args.1` before anything is queued", async ({ args, message }) => {
      await writeHeartbeat(caller);
      const result = await cli.run([...args], { cwd: caller.sessionCwd, sandboxed: true });
      expect(result.stderr).toContain(message);
      expect(result.exitCode).toBe(1);
      expect(result.actions).toEqual([]);
      expect(await queueEntries(caller)).toEqual([]);
    });

    test("a sandboxed shell that is not an agent cannot spawn: there is no watchdog to ask", async () => {
      const result = await cli.run(["new-agent", "x"], { sandboxed: true });
      expect(result.stderr).toContain("this shell is not inside a registered agent");
      expect(result.exitCode).toBe(1);
    });

    test("a request the watchdog's seal check rejects does nothing", async () => {
      const deps = fakeWatchdogDeps(calls, repo, {
        verifySeal: async () => ({ ok: false, field: "canSpawnChildren", reason: "edited" }),
      });
      const result = await withFixtureWatchdog(caller, deps, () =>
        cli.run(["new-agent", "x"], { cwd: caller.sessionCwd, sandboxed: true }));
      expect(result.stderr).toContain("does not match its sealed record (canSpawnChildren)");
      expect(result.exitCode).toBe(1);
      expect(calls).toEqual([]);
    });

    test("the real lifecycle rule lets a manager retire its child, and nobody else", async () => {
      const deps = (() => {
        const base = fakeWatchdogDeps(calls, repo);
        return { ...base, lifecycle: { ...base.lifecycle, authorize: undefined } };
      })();
      await cli.addAgent(repo, "agent-stranger", { manager: "agent-someone-else" });

      const denied = await withFixtureWatchdog(caller, deps, () =>
        cli.run(["retire", "agent-stranger"], { cwd: caller.sessionCwd, sandboxed: true }));
      expect(denied.exitCode).toBe(1);
      expect(denied.stderr).not.toBe("");
      expect(calls).toEqual([]);

      const allowed = await withFixtureWatchdog(caller, deps, () =>
        cli.run(["retire", "agent-peer"], { cwd: caller.sessionCwd, sandboxed: true }));
      expect(allowed.exitCode).toBe(0);
      expect(calls.map((call) => call.op)).toEqual(["retire"]);
    });
  });

  describe("when the watchdog is not live", () => {
    test.each([
      { args: ["new-agent", "x"], message: "the watchdog for 'agent-caller' is not running" },
      { args: ["retire", "agent-peer"], message: "the watchdog for 'agent-caller' is not running" },
      { args: ["ask", "x"], message: "the watchdog for 'agent-caller' is not running" },
    ])("`ib $args.0` fails at once and queues nothing", async ({ args, message }) => {
      const result = await cli.run([...args], { cwd: caller.sessionCwd, sandboxed: true });
      expect(result.stderr).toContain(message);
      expect(result.exitCode).toBe(1);
      expect(result.actions).toEqual([]);
      expect(await queueEntries(caller)).toEqual([]);
    });

    test("`ib send` falls back to the direct path", async () => {
      const result = await cli.run(["send", "agent-peer", "hello"], {
        cwd: caller.sessionCwd,
        sandboxed: true,
        actions: { sendMessage: "record" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.actions.map((recorded) => recorded.name)).toEqual(["sendMessage"]);
      expect(await queueEntries(caller)).toEqual([]);
    });
  });

  describe("who is routed", () => {
    test("a send to the caller itself stays direct", async () => {
      await writeHeartbeat(caller);
      const result = await cli.run(["send", "agent-caller", "note to self"], {
        cwd: caller.sessionCwd,
        sandboxed: true,
        actions: { sendMessage: "record" },
      });
      expect(result.actions.map((recorded) => recorded.name)).toEqual(["sendMessage"]);
      expect(await queueEntries(caller)).toEqual([]);
    });

    test("a sandboxed shell that is not an agent runs lifecycle commands directly", async () => {
      const result = await cli.run(["retire", "agent-peer"], { sandboxed: true, actions: { retireAgent: "record" } });
      expect(result.actions.map((recorded) => recorded.name)).toEqual(["retireAgent"]);
    });

    test("an agent with its itsybitsy sandbox off runs lifecycle commands directly but still spawns through the broker", async () => {
      const disabled = await cli.addAgent(repo, "agent-disabled", { sandbox: { enabled: false } });
      const retire = await cli.run(["retire", "agent-peer"], {
        cwd: disabled.sessionCwd,
        sandboxed: true,
        actions: { retireAgent: "record" },
      });
      expect(retire.actions.map((recorded) => recorded.name)).toEqual(["retireAgent"]);

      const spawn = await withFixtureWatchdog(disabled, fakeWatchdogDeps(calls, repo), () =>
        cli.run(["new-agent", "x"], { cwd: disabled.sessionCwd, sandboxed: true }));
      expect(spawn.exitCode).toBe(0);
      expect(spawn.actions).toEqual([]);
      expect(calls.map((call) => call.op)).toEqual(["newAgent"]);
    });
  });

  describe("a worktree:false caller, proven by process ancestry", () => {
    const CLI_PID = 4242;
    const ownAncestry = { pid: 5000, parents: [[5000, CLI_PID], [CLI_PID, 1]] as [number, number][], identityCurrent: true };
    let shared: FixtureAgent;

    beforeEach(async () => {
      shared = await cli.addAgent(repo, "agent-shared", {
        worktree: false,
        claude_pid: String(CLI_PID),
        claude_pid_epoch: 1_700_000_000,
      });
    });

    test("the real caller check finds it through the fixture registry and the injected ancestry", async () => {
      // Only the fixture's HOME has this record: if the driver read the OS account's
      // registry, or the real ancestry, this caller would look human and nuke would run.
      const result = await cli.run(["nuke", "agent-peer"], { cwd: repo, ancestry: ownAncestry, actions: { nukeAgent: "record" } });
      expect(result.stderr).toContain("'agent-shared' cannot run 'ib nuke'");
      expect(result.exitCode).toBe(1);
      expect(result.actions).toEqual([]);
    });

    test("a process outside that ancestry is a human", async () => {
      const result = await cli.run(["nuke", "agent-peer"], {
        cwd: repo,
        ancestry: { pid: 5000, parents: [[5000, 1]], identityCurrent: true },
        actions: { nukeAgent: "record" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.actions.map((recorded) => recorded.name)).toEqual(["nukeAgent"]);
    });

    test("a process whose identity changed fails closed", async () => {
      const result = await cli.run(["nuke", "agent-peer"], {
        cwd: repo,
        ancestry: { ...ownAncestry, identityCurrent: false },
        actions: { nukeAgent: "record" },
      });
      expect(result.stderr).toContain("cannot verify caller");
      expect(result.exitCode).toBe(1);
      expect(result.actions).toEqual([]);
    });

    test("sandboxed, it spawns through its own queue and runs lifecycle commands directly", async () => {
      const spawn = await withFixtureWatchdog(shared, fakeWatchdogDeps(calls, repo), () =>
        cli.run(["new-agent", "x"], { cwd: repo, sandboxed: true, ancestry: ownAncestry }));
      expect(spawn.exitCode).toBe(0);
      expect(calls.map((call) => call.op)).toEqual(["newAgent"]);

      const retire = await cli.run(["retire", "agent-peer"], {
        cwd: repo,
        sandboxed: true,
        ancestry: ownAncestry,
        actions: { retireAgent: "record" },
      });
      expect(retire.actions.map((recorded) => recorded.name)).toEqual(["retireAgent"]);
    });

    test("an unforeseen ancestry read is a violation, not a guess", async () => {
      const result = await cli.run(["nuke", "agent-peer"], { cwd: repo, expectViolations: true, actions: { nukeAgent: "record" } });
      expect(result.violations.map((violation) => violation.kind)).toEqual(["process-ancestry"]);
      expect(result.stderr).toContain("cannot verify caller");
      expect(result.exitCode).toBe(1);
      expect(result.actions).toEqual([]);
    });
  });

  describe("every CLI route stays inside the fixture", () => {
    /** Run forever, or take over the terminal; a test has no reason to launch them. */
    const NOT_SWEPT = new Set(["watch", "watchdog"]);
    const PEER = "agent-peer";
    const SELF = "agent-caller";
    /** `$ROOT` is the fixture root, `$AGENT` the caller's agent directory. */
    const ROUTES: string[][] = [
      ["add", "$ROOT"], ["remove", "caller-repo"], ["push", "caller-repo"],
      ["list"], ["ls"], ["agents"], ["tree"], ["questions"], ["q"],
      ["state"], ["state", "--cleanup"],
      ["generate-summary", "$AGENT"],
      ["sandbox-log-stream", "--predicate", "x"],
      ["sandbox-collector", "status"], ["sandbox-collector", "stop"], ["sandbox-collector", "restart"],
      ["sandbox-collector", "serve"],
      ["sandbox-collector", "attach", "--dir", "$ROOT/sandbox-log.abc", "--owner", "1", "--agent-log", "$ROOT/agent.log"],
      ...["sandbox-proxy", "sandbox-proxy-launch"].map((command) => [
        command, "--port", "49152", "--domains", "$ROOT/domains.txt", "--log", "$ROOT/proxy.log",
        "--agent-log", "$ROOT/agent.log", "--pid-file", "$ROOT/proxy.pid", "--ready-file", "$ROOT/proxy.ready",
      ]),
      ["write-proxy-pid", SELF, "1234", "4321"], ["write-pid", SELF, "1234"],
      ["look", PEER], ["info", PEER], ["diff", PEER], ["status", PEER],
      ["send", PEER, "x"], ["send", "@system", "x"], ["send", "@coordinator", "x"],
      ["nickname", PEER, "nick"],
      ["retire", PEER], ["rehire", PEER], ["nuke", PEER], ["merge-check", PEER], ["merge", PEER],
      ["sandbox", "refresh", PEER], ["sandbox", "refresh", "--all"],
      ["resume", PEER], ["respawn", PEER], ["restart", PEER], ["respawn-self", SELF],
      ["new-agent", "x"], ["new", "x"],
      ["ack"], ["ack", PEER], ["acknowledge", "q1"], ["ask", "q"], ["log", "msg"], ["parse-state"],
      ["hook-check-path", SELF], ["hook-status", SELF], ["hook-permission-denied", SELF], ["hook-mark-running", SELF],
      ["init-types"], ["init-agent-types"], ["list-types"], ["list-agent-types"],
      ["show-type", "worker"], ["show-agent-type", "worker"], ["list-models"], ["models"],
      ["config", "set", "hooks.injectTimestamp", "true"],
      ["hooks", "install"], ["hooks", "uninstall"], ["hooks", "intercept-install"], ["hooks", "intercept-uninstall"],
      ["hooks", "session-start", SELF], ["hooks", "main-path"], ["hooks", "inject-status"], ["hooks", "inject-timestamp", SELF],
      ["hooks", "statusline", SELF], ["hooks", "intercept-task", SELF],
      ["team", "create", "t1"], ["team", "add", "t1", PEER], ["team", "remove", "t1", PEER], ["team", "delete", "t1"],
      ["roster", "t1"],
      ["tgallow", "1"], ["tgdeny", "1"], ["tgsend", "x"], ["tgreact", "x"], ["tgsendfile", "$ROOT/domains.txt"], ["tgtyping"],
    ];

    test("the sweep covers every command the dispatcher handles", async () => {
      const source = await Bun.file(join(import.meta.dir, "index.ts")).text();
      const dispatched = [...source.matchAll(/^ {4}case "([^"]+)":/gm)].map((match) => match[1]!);
      expect(dispatched.length).toBeGreaterThan(50);
      const swept = new Set(ROUTES.map((route) => route[0]!));
      expect(dispatched.filter((command) => !swept.has(command) && !NOT_SWEPT.has(command))).toEqual([]);
    });

    test.each(ROUTES.flatMap((route) => [
      { route, label: "sandboxed", sandboxed: true },
      { route, label: "unsandboxed", sandboxed: false },
    ]))("$label: ib $route", async ({ route, sandboxed }) => {
      await Bun.write(join(cli.root, "domains.txt"), "allowed.example\n");
      const args = route.map((arg) => arg.replace("$ROOT", cli.root).replace("$AGENT", caller.agentDir));
      // Every external effect is blocked and logged, so the only question left is
      // whether a route found its way to state that is not the fixture's.
      const result = await cli.run(args, { cwd: caller.sessionCwd, sandboxed, stdin: "{}", expectViolations: true });
      expect(await snapshot(live.root)).toEqual(liveBefore);
      expect(result.context.home).toBe(cli.home);
    });
  });

  describe("unexpected external effects fail loudly", () => {
    test("a handler the test did not name refuses, and the runner throws", async () => {
      await expect(cli.run(["retire", "agent-peer"])).rejects.toThrow("attempted blocked external effects");
    });

    test("the refusal is a failure of the command, not a fabricated success", async () => {
      const result = await cli.run(["retire", "agent-peer"], { expectViolations: true });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("test-cli-driver blocked action");
      expect(result.actions).toEqual([]);
      expect(result.violations[0]).toMatchObject({ kind: "action", detail: { name: "retireAgent" } });
    });

    test("a real handler's commands are blocked, not run, even with fakes first on PATH", async () => {
      const bin = join(cli.root, "bin");
      const marker = join(cli.root, "external-command-ran");
      await mkdir(bin);
      for (const name of ["tmux", "git", "ib", "ps", "say"]) {
        await Bun.write(join(bin, name), `#!/bin/sh\necho ${name} >> '${marker}'\n`);
        await chmod(join(bin, name), 0o755);
      }
      const result = await cli.run(["retire", "agent-peer"], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        actions: { retireAgent: "real" },
        expectViolations: true,
      });
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations.every((violation) => violation.kind === "process")).toBe(true);
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(await snapshot(live.root)).toEqual(liveBefore);
    });

    test("asking which tmux sessions exist does not start tmux", async () => {
      const bin = join(cli.root, "bin");
      const marker = join(cli.root, "tmux-ran");
      await mkdir(bin);
      await Bun.write(join(bin, "tmux"), `#!/bin/sh\necho tmux >> '${marker}'\n`);
      await chmod(join(bin, "tmux"), 0o755);
      const result = await cli.run(["list"], { env: { PATH: `${bin}:/usr/bin:/bin` } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("caller-repo");
      expect(await Bun.file(marker).exists()).toBe(false);
    });

    test("an effect production swallows still fails the test", async () => {
      // telegramFireTypingAction catches every error, so the command looks clean.
      await Bun.write(join(cli.home, ".itsybitsy", "config.json"), JSON.stringify({ channels: { telegram: { bot_token: "fixture-token" } } }));
      await Bun.write(
        join(cli.home, ".itsybitsy", "channels", "telegram", "chat-id-cache.json"),
        JSON.stringify({ chat_id: "12345", cached_at: "2026-01-01T00:00:00Z" }),
      );
      const seen = await cli.run(["tgtyping"], { expectViolations: true });
      expect(seen.exitCode).toBe(0);
      expect(seen.stderr).toBe("");
      expect(seen.violations.map((violation) => violation.kind)).toEqual(["network"]);
      await expect(cli.run(["tgtyping"])).rejects.toThrow("attempted blocked external effects");
    });

    test("a command a test owns may run, and only that command", async () => {
      await writeUserStatusline(cli.home);
      const allowed = await cli.run(["hooks", "statusline", "agent-cli"], {
        stdin: "{}",
        allowedProcesses: [["/bin/sh", "-c"]],
      });
      expect(allowed.stdout).toBe("from the fixture statusline");

      const blocked = await cli.run(["hooks", "statusline", "agent-cli"], {
        stdin: "{}",
        allowedProcesses: [["/bin/sh", "-c", "something else"]],
        expectViolations: true,
      });
      expect(blocked.violations.map((violation) => violation.kind)).toEqual(["process"]);
    });
  });
});

async function writeUserStatusline(home: string): Promise<void> {
  await Bun.write(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: "printf 'from the fixture statusline'" } }),
  );
}

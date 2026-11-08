import * as runtimeNames from "./runtime-names";
/**
 * The shared way for a test to run the `ib` CLI in a subprocess. See
 * test-cli-driver.ts for why a subprocess needs more than a temporary HOME.
 *
 * Every launch uses process.execPath, an absolute entry path, a temporary cwd and
 * HOME, an explicit minimal environment (nothing inherited from the agent running
 * the tests), controlled stdin, and a deadline after which the process is killed.
 *
 *   runIsolatedCli    the normal path, through the guarded driver. Any blocked
 *                     external effect makes it throw unless the test expects it.
 *   createCliFixture  a registry, repos, agents and a real broker queue to run against.
 *   runInertEntryPoint  a real entry point, unguarded, for commands that cannot
 *                     mutate anything. Anything else is refused before launch.
 */

import { realpathSync } from "fs";
import { mkdir, mkdtemp, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { SpawnServerDeps } from "./spawn-broker";
import {
  CLI_DRIVER_CONFIG_ENV,
  type CliActionMode,
  type CliActionName,
  type CliAncestry,
  type CliDriverConfig,
  type CliDriverContext,
  type CliViolation,
  type RecordedCliAction,
} from "./test-cli-driver";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DRIVER_PATH = join(import.meta.dir, "test-cli-driver.ts");
const DEFAULT_TIMEOUT_MS = 55_000;
/** After the kill: how long to wait for the pipes to close before giving up on them. */
const KILL_GRACE_MS = 2_000;

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface IsolatedCliOptions {
  /** Default: an empty directory that exists for this run only. */
  cwd?: string;
  /** Default: an empty directory that exists for this run only. */
  home?: string;
  /** Piped to the child. Default: no stdin at all (/dev/null). */
  stdin?: string;
  /** Extra environment. Nothing else is inherited. */
  env?: Record<string, string>;
  /** What isSandboxedProcess() answers in the child. Default false. */
  sandboxed?: boolean;
  /** Handlers this test expects to reach; every other handler refuses. */
  actions?: Partial<Record<CliActionName, CliActionMode>>;
  /** Argv prefixes that may really run, for a command the test owns. */
  allowedProcesses?: string[][];
  ancestry?: CliAncestry;
  /** Return blocked effects instead of throwing, to assert on them. */
  expectViolations?: boolean;
  timeoutMs?: number;
}

export interface IsolatedCliResult extends CliRunResult {
  actions: RecordedCliAction[];
  violations: CliViolation[];
  context: CliDriverContext;
}

function isolatedTempRoot(): string {
  const root = realpathSync(tmpdir());
  // An agent-shaped TMPDIR would make every fixture cwd resolve to that agent.
  if (runtimeNames.containsRuntimeDir(root)) {
    throw new Error(`Refusing to run CLI tests: the temp directory ${root} is inside an agent directory`);
  }
  return root;
}

async function assertIsolatedPath(path: string, label: string): Promise<string> {
  const real = await realpath(path);
  const inside = (dir: string) => real === dir || real.startsWith(`${dir}/`);
  if (!inside(isolatedTempRoot()) || inside(realpathSync(REPO_ROOT)) || inside(realpathSync(process.cwd()))) {
    throw new Error(`Refusing to run the CLI with ${label} ${real}: it must be a temporary directory outside this checkout`);
  }
  return real;
}

/** Everything the child inherits. PATH has no `ib`, tmux or bun on it. */
function minimalEnv(home: string, tmp: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: tmp, ...extra };
}

/** Wait for a process and its output, killing it at the deadline. */
async function collect(
  proc: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill: (signal?: number) => void },
  timeoutMs: number,
  label: string,
): Promise<CliRunResult> {
  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
  const overdue = new Error(`${label} did not finish within ${timeoutMs}ms; killed`);
  let killed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      killed = true;
      proc.kill(9);
      timer = setTimeout(() => reject(overdue), KILL_GRACE_MS);
    }, timeoutMs);
  });
  try {
    const run = await Promise.race([finished, deadline]);
    if (killed) throw overdue;
    return run;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return (await file.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

/** Run `ib <cliArgs>` through the guarded driver. */
export async function runIsolatedCli(cliArgs: string[], options: IsolatedCliOptions = {}): Promise<IsolatedCliResult> {
  const runDir = await mkdtemp(join(isolatedTempRoot(), "ib-cli-run-"));
  try {
    const logDir = join(runDir, "driver");
    const tmp = join(runDir, "tmp");
    await mkdir(logDir);
    await mkdir(tmp);
    const defaults = async (given: string | undefined, name: string, label: string): Promise<string> => {
      if (given !== undefined) return assertIsolatedPath(given, label);
      const dir = join(runDir, name);
      await mkdir(dir);
      return dir;
    };
    const home = await defaults(options.home, "home", "HOME");
    const cwd = await defaults(options.cwd, "cwd", "cwd");

    const config: CliDriverConfig = {
      cwd,
      home,
      logDir,
      sandboxed: options.sandboxed ?? false,
      actions: options.actions ?? {},
      allowedProcesses: options.allowedProcesses ?? [],
      ...(options.ancestry ? { ancestry: options.ancestry } : {}),
    };
    const proc = Bun.spawn([process.execPath, "run", DRIVER_PATH, ...cliArgs], {
      cwd,
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...minimalEnv(home, tmp, options.env), [CLI_DRIVER_CONFIG_ENV]: JSON.stringify(config) },
    });
    const label = `ib ${cliArgs.join(" ")}`;
    const run = await collect(proc, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, label);

    const contextFile = Bun.file(join(logDir, "context.json"));
    if (!(await contextFile.exists())) {
      throw new Error(`${label}: the driver never started (exit ${run.exitCode})\nstderr: ${run.stderr}`);
    }
    const violations = await readJsonLines<CliViolation>(join(logDir, "violations.jsonl"));
    if (violations.length > 0 && !options.expectViolations) {
      throw new Error(
        `${label}: attempted blocked external effects:\n${violations.map((v) => JSON.stringify(v)).join("\n")}\n` +
          `exit ${run.exitCode}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
      );
    }
    return {
      ...run,
      actions: await readJsonLines<RecordedCliAction>(join(logDir, "actions.jsonl")),
      violations,
      context: (await contextFile.json()) as CliDriverContext,
    };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

export interface FixtureAgent {
  id: string;
  repoPath: string;
  agentDir: string;
  /** `<agentDir>/repo`; for a worktree:false agent, the repo root. */
  sessionCwd: string;
}

export interface CliFixture {
  root: string;
  home: string;
  /** An empty directory that is not inside any repo. */
  cwd: string;
  /** Create a repo with an agents directory and add it to the registry. */
  addRepo(name: string, options?: { nickname?: string }): Promise<string>;
  /** Replace the registry with arbitrary content. */
  writeRegistry(registry: unknown): Promise<void>;
  /** Add an agent. A worktree agent gets the git backlink a real worktree has, written without git. */
  addAgent(repoPath: string, id: string, meta?: Record<string, unknown>): Promise<FixtureAgent>;
  run(cliArgs: string[], options?: IsolatedCliOptions): Promise<IsolatedCliResult>;
  cleanup(): Promise<void>;
}

export async function createCliFixture(): Promise<CliFixture> {
  const root = await mkdtemp(join(isolatedTempRoot(), "ib-cli-fixture-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  await mkdir(join(home, ".itsybitsy"), { recursive: true });
  await mkdir(cwd);
  const repos: { path: string; name: string; nickname?: string }[] = [];

  const writeRegistry = async (registry: unknown) => {
    await Bun.write(join(home, ".itsybitsy", "repos.json"), JSON.stringify(registry));
  };

  return {
    root,
    home,
    cwd,
    writeRegistry,
    async addRepo(name, options = {}) {
      const path = join(root, "repos", `${repos.length}`, name);
      await mkdir(join(path, ".git", "worktrees"), { recursive: true });
      await mkdir(runtimeNames.agentsDir(path), { recursive: true });
      repos.push({ path, name, ...(options.nickname ? { nickname: options.nickname } : {}) });
      await writeRegistry({ version: 1, repos });
      return path;
    },
    async addAgent(repoPath, id, meta = {}) {
      const agentDir = runtimeNames.agentDir(repoPath, id);
      const worktree = meta.worktree !== false;
      await mkdir(agentDir, { recursive: true });
      await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `ib-fixture-${id}`, worktree, ...meta }));
      if (!worktree) return { id, repoPath, agentDir, sessionCwd: repoPath };
      const sessionCwd = join(agentDir, "repo");
      const gitDir = join(repoPath, ".git", "worktrees", id);
      await mkdir(sessionCwd, { recursive: true });
      await mkdir(gitDir, { recursive: true });
      await Bun.write(join(sessionCwd, ".git"), `gitdir: ${gitDir}\n`);
      await Bun.write(join(gitDir, "gitdir"), `${join(sessionCwd, ".git")}\n`);
      return { id, repoPath, agentDir, sessionCwd };
    },
    run: (cliArgs, options = {}) => runIsolatedCli(cliArgs, { home, cwd, ...options }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * A stand-in watchdog for one fixture agent, for the length of `run`: the real
 * heartbeat, the real queue and the real request handling (processSpawnRequests)
 * in this test process, with the terminal operations supplied by `deps`.
 */
export async function withFixtureWatchdog<T>(
  agent: FixtureAgent,
  deps: SpawnServerDeps,
  run: () => Promise<T>,
): Promise<T> {
  const { writeAgentTransient } = await import("./agents");
  const { processSpawnRequests } = await import("./spawn-broker");
  const beat = () => writeAgentTransient(agent.agentDir, {
    tmux_compacting: false,
    tmux_rate_limited: false,
    tmux_api_error: false,
    tmux_api_terms: false,
    tmux_api_safeguard: false,
    has_background_tasks: false,
    updated_at_ms: Date.now(),
    // The test runner: alive for as long as the heartbeat has to be believed.
    watchdog_pid: process.pid,
  });
  await beat();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await beat();
      await processSpawnRequests(agent.id, agent.repoPath, deps);
      await Bun.sleep(20);
    }
  })();
  try {
    return await run();
  } finally {
    stopped = true;
    await loop;
  }
}

// ── Real entry points ────────────────────────────────────────────────────────

/** Commands with no external effect, so they may run outside the driver's guards. */
export function isInertCliCommand(cliArgs: string[]): boolean {
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) return true;
  if (cliArgs[0] === "init-types" || cliArgs[0] === "init-agent-types") return cliArgs[1] === "--check";
  return cliArgs.length === 0 || [
    "help", "list-types", "list-agent-types", "show-type", "show-agent-type", "list-models", "models",
  ].includes(cliArgs[0]!);
}

async function runUnguarded(
  command: string[],
  options: { cwd?: string; home?: string; timeoutMs?: number },
  label: string,
): Promise<CliRunResult> {
  const runDir = await mkdtemp(join(isolatedTempRoot(), "ib-cli-entry-"));
  try {
    const tmp = join(runDir, "tmp");
    const defaultDir = join(runDir, "work");
    await mkdir(tmp);
    await mkdir(defaultDir);
    const cwd = options.cwd === undefined ? defaultDir : await assertIsolatedPath(options.cwd, "cwd");
    const home = options.home === undefined ? defaultDir : await assertIsolatedPath(options.home, "HOME");
    const proc = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: minimalEnv(home, tmp) });
    return await collect(proc, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, label);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

/**
 * Run a real entry point of this checkout, with no driver in between. Limited to
 * inert commands: on the real path, sandbox routing and caller checks are live.
 */
export function runInertEntryPoint(
  entry: "index.ts" | "src/index.ts",
  cliArgs: string[],
  options: { cwd?: string; home?: string; timeoutMs?: number } = {},
): Promise<CliRunResult> {
  if (!isInertCliCommand(cliArgs)) {
    throw new Error(`Refusing to run \`ib ${cliArgs.join(" ")}\` on a real entry point: use runIsolatedCli`);
  }
  return runUnguarded([process.execPath, "run", join(REPO_ROOT, entry), ...cliArgs], options, `${entry} ${cliArgs.join(" ")}`);
}

/** Import a real entry point in a fresh process, as a library user would. */
export function runEntryPointImport(entry: "index.ts" | "src/index.ts"): Promise<CliRunResult> {
  const script = `await import(${JSON.stringify(join(REPO_ROOT, entry))}); console.log("IMPORT_OK");`;
  return runUnguarded([process.execPath, "-e", script], {}, `import ${entry}`);
}

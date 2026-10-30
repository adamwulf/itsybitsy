/**
 * Test-only CLI entry point. Launched by src/test-cli-runner.ts; nothing in
 * production imports it, and it is not part of the `ib` binary.
 *
 * A CLI test runs in its own process, so the `bun test` preload and in-process
 * mocks do not reach it, and neither a temporary cwd nor a temporary HOME is
 * enough: the caller check reads the OS account's registry (`userInfo()`, not
 * HOME) and the real process ancestry, and sandbox routing asks the kernel. Left
 * alone, a parsing test run by a sandboxed agent identified that real agent and
 * asked its real watchdog to spawn. So before main() runs this driver:
 *
 *   - blocks every external effect a CLI route can reach (processes, signals,
 *     network). A blocked attempt is logged for the runner and then thrown:
 *     production code that swallows the error cannot turn it into a pass;
 *   - answers isSandboxedProcess() from the test's config;
 *   - runs the real caller algorithm against the fixture registry and the
 *     test's ancestry, so routing is real and its evidence is not;
 *   - reports no tmux sessions, so looking up an agent does not read real tmux;
 *   - makes each `cliActions` handler refuse unless the test named it: "record"
 *     to assert what the parser produced, "real" to run the handler itself.
 *
 * Production modules load through dynamic import after the guards go in, because
 * SpawnContext captures `Bun.spawn` when its module loads. Static imports here
 * are limited to node builtins and types.
 */

import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import type { cliActions } from "./index";

/** Read only by this file. Production code never looks at it (test-isolation test). */
export const CLI_DRIVER_CONFIG_ENV = "IB_TEST_CLI_DRIVER_CONFIG";

export type CliActionName = keyof typeof cliActions;
export type CliActionMode = "record" | "real";

export interface CliAncestry {
  /** The pid the caller check starts from. */
  pid: number;
  /** [pid, parent pid] pairs, as `ps` would report them. */
  parents: [number, number][];
  /** The answer to "is this recorded CLI process still the same process?". */
  identityCurrent: boolean;
}

export interface CliDriverConfig {
  /** The cwd and HOME this process must have been started with. */
  cwd: string;
  home: string;
  /** Receives context.json, actions.jsonl and violations.jsonl. */
  logDir: string;
  /** What isSandboxedProcess() answers. */
  sandboxed: boolean;
  /** Handlers the test expects to be reached. Any other handler refuses. */
  actions: Partial<Record<CliActionName, CliActionMode>>;
  /** Argv prefixes that may really run. Empty unless a test owns the command. */
  allowedProcesses: string[][];
  /** Observations for the caller check. Without them, reading ancestry is a violation. */
  ancestry?: CliAncestry;
}

/** What the driver saw of its own launch. */
export interface CliDriverContext {
  cwd: string;
  home: string;
  entry: string;
  execPath: string;
  envKeys: string[];
}

export interface RecordedCliAction {
  name: CliActionName;
  args: unknown[];
}

export interface CliViolation {
  kind: "process" | "signal" | "network" | "action" | "process-ancestry";
  detail: unknown;
}

function installExternalGuards(config: CliDriverConfig, block: (violation: CliViolation) => never): void {
  const argvOf = (first: unknown): string[] => {
    const cmd = Array.isArray(first) ? first : (first as { cmd?: unknown[] } | undefined)?.cmd ?? [];
    return (cmd as unknown[]).map(String);
  };
  const allowed = (argv: string[]) =>
    config.allowedProcesses.some((prefix) => prefix.every((token, index) => argv[index] === token));
  const realSpawn = Bun.spawn as (...spawnArgs: unknown[]) => unknown;
  const realSpawnSync = Bun.spawnSync as (...spawnArgs: unknown[]) => unknown;
  const realKill = process.kill.bind(process);

  // Every agent lookup asks tmux which sessions exist, which would read the user's
  // real server. A fixture has no tmux server: these two read-only questions get
  // the answer tmux gives then, and every other tmux command stays blocked.
  const askedForSessions = (argv: string[]) => argv[0] === "tmux" && (argv[1] === "list-sessions" || argv[1] === "has-session");

  Object.assign(Bun, {
    spawn: (...spawnArgs: unknown[]) => {
      const argv = argvOf(spawnArgs[0]);
      if (askedForSessions(argv)) {
        return { stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(1), exitCode: 1, kill: () => {} };
      }
      if (!allowed(argv)) block({ kind: "process", detail: { argv } });
      return realSpawn(...spawnArgs);
    },
    spawnSync: (...spawnArgs: unknown[]) => {
      const argv = argvOf(spawnArgs[0]);
      if (!allowed(argv)) block({ kind: "process", detail: { argv } });
      return realSpawnSync(...spawnArgs);
    },
    connect: (options: unknown) => block({ kind: "network", detail: { api: "Bun.connect", options } }),
    listen: (options: unknown) => block({ kind: "network", detail: { api: "Bun.listen", options } }),
  });
  Object.assign(globalThis, {
    fetch: (input: unknown) => block({ kind: "network", detail: { api: "fetch", url: String(input) } }),
  });
  // Signal 0 only asks whether a process exists; hasLiveWatchdog depends on it.
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal !== 0) block({ kind: "signal", detail: { pid, signal: signal ?? "SIGTERM" } });
    return realKill(pid, 0);
  }) as typeof process.kill;
}

async function installFixtureCallerEvidence(config: CliDriverConfig, block: (violation: CliViolation) => never): Promise<void> {
  const { resolveNoWorktreeCaller } = await import("./no-worktree-caller");
  const { setNewAgentNoWorktreeCallerResolver } = await import("./ib-commands");
  const { setBoundNoWorktreeCallerResolver, setNoWorktreeRepoRootsLoader } = await import("./hooks/agent-context");

  const ancestry = (): CliAncestry => config.ancestry ?? block({ kind: "process-ancestry", detail: {} });
  const resolver = (cwd: string) => resolveNoWorktreeCaller(cwd, {
    registryHome: config.home,
    pid: config.ancestry?.pid,
    readParents: () => new Map(ancestry().parents),
    identityCurrent: () => ancestry().identityCurrent,
  });
  setNewAgentNoWorktreeCallerResolver(resolver);
  setBoundNoWorktreeCallerResolver(resolver);
  setNoWorktreeRepoRootsLoader(async () => {
    const registry = join(config.home, ".itsybitsy", "repos.json");
    if (!existsSync(registry)) return [];
    return (JSON.parse(readFileSync(registry, "utf-8")).repos as { path: string }[]).map((repo) => repo.path);
  });
}

async function runDriver(): Promise<void> {
  const encoded = process.env[CLI_DRIVER_CONFIG_ENV];
  if (!encoded) {
    console.error(`test-cli-driver: ${CLI_DRIVER_CONFIG_ENV} is not set; start this through test-cli-runner.ts`);
    process.exit(2);
  }
  const config = JSON.parse(encoded) as CliDriverConfig;
  const cwd = realpathSync(process.cwd());
  if (cwd !== config.cwd || process.env.HOME !== config.home) {
    console.error(`test-cli-driver: started outside its fixture (cwd ${cwd}, HOME ${process.env.HOME})`);
    process.exit(2);
  }

  const context: CliDriverContext = {
    cwd,
    home: config.home,
    entry: import.meta.path,
    execPath: process.execPath,
    envKeys: Object.keys(process.env).sort(),
  };
  writeFileSync(join(config.logDir, "context.json"), JSON.stringify(context));

  const block = (violation: CliViolation): never => {
    appendFileSync(join(config.logDir, "violations.jsonl"), `${JSON.stringify(violation)}\n`);
    throw new Error(`test-cli-driver blocked ${violation.kind}: ${JSON.stringify(violation.detail)}`);
  };
  installExternalGuards(config, block);

  const { setSandboxedProcessOverride } = await import("./sandbox-detect");
  setSandboxedProcessOverride(() => config.sandboxed);
  await installFixtureCallerEvidence(config, block);

  const { cliActions: actions, main } = await import("./index");
  for (const name of Object.keys(actions) as CliActionName[]) {
    const mode = config.actions[name];
    if (mode === "real") continue;
    const replacement = async (...args: unknown[]) => {
      if (mode !== "record") block({ kind: "action", detail: { name, args } });
      appendFileSync(join(config.logDir, "actions.jsonl"), `${JSON.stringify({ name, args })}\n`);
      return { ok: true, exitCode: 0, stdout: `recorded ${name}`, stderr: "" };
    };
    Object.assign(actions, { [name]: replacement });
  }

  await main();
}

if (import.meta.main) {
  runDriver().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

/**
 * Shared types used across multiple modules.
 */

/** Result of a spawned process — matches the subset of Bun.spawn we use. */
export type SpawnResult = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
};

/** Injectable spawn function signature. */
export type SpawnFn = (cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }) => SpawnResult;

/** Injectable fetch function signature. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Run a spawned command draining both stdout and stderr via Promise.all
 * to avoid pipe buffer deadlocks. Uses the provided spawn function.
 */
export async function runCmd(
  spawnFn: SpawnFn,
  cmd: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawnFn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/**
 * Injectable spawn context — holds a spawn runner with set/reset methods.
 * Centralizes the DI pattern used across all modules that need test injection.
 */
export class SpawnContext {
  private _runner: SpawnFn;
  private readonly _default: SpawnFn;

  constructor(defaultRunner: SpawnFn = Bun.spawn as SpawnFn) {
    this._default = defaultRunner;
    this._runner = defaultRunner;
  }

  get runner(): SpawnFn {
    return this._runner;
  }

  set(runner: SpawnFn): void {
    this._runner = runner;
  }

  reset(): void {
    this._runner = this._default;
  }

  /** Convenience: run a command using this context's spawn runner. */
  async run(cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return runCmd(this._runner, cmd);
  }
}

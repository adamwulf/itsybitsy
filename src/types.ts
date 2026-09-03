/**
 * Shared types used across multiple modules.
 */

/** Result of a spawned process — matches the subset of Bun.spawn we use. */
export type SpawnResult = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  /**
   * Best-effort process kill. Optional so hand-built fake `SpawnResult`s in
   * tests need not provide it; Bun's real `Subprocess` always does. Used by the
   * `agy --version` probe to terminate a child that outlives its hard timeout
   * (agy 1.1.23 hangs on an inherited unclosed stdin).
   */
  kill?: (signal?: number | string) => void;
};

/**
 * Injectable spawn function signature.
 *
 * `stdin` is optional and defaults (in every existing caller) to Bun's default;
 * the `agy --version` probe passes `"ignore"` explicitly so the child never
 * inherits an open stdin pipe (agy 1.1.23 blocks forever on one). Adding the
 * optional field is backward-compatible — every current call site passes only
 * `{ stdout, stderr }`.
 */
export type SpawnFn = (
  cmd: string[],
  opts?: { stdout: "pipe"; stderr: "pipe"; stdin?: "ignore" | "inherit" | "pipe" | null },
) => SpawnResult;

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
 * Generic injection context for dependency injection in tests.
 * Holds a function (or value) with set/reset methods.
 */
export class InjectionContext<T> {
  private _value: T;
  private _default: T;

  constructor(defaultValue: T) {
    this._default = defaultValue;
    this._value = defaultValue;
  }

  get fn(): T {
    return this._value;
  }

  set(value: T): void {
    this._value = value;
  }

  reset(): void {
    this._value = this._default;
  }

  /**
   * Replace the baseline that {@link reset} restores to, and snap the current
   * value to it as well.
   *
   * The production default for a `SpawnContext` is the live `Bun.spawn`, so a
   * plain {@link reset} after a per-test `.set(mock)` restores the ability to
   * launch real subprocesses. The global `bun test` preload (test-preload.ts)
   * uses this to swap that live default for a safe no-op stub, so that EVERY
   * reset during the test run — including one that fires from async work still
   * draining after a test has torn its mock down — lands on the stub instead of
   * the real process spawner. Not called from any production code path.
   */
  setDefault(value: T): void {
    this._default = value;
    this._value = value;
  }
}

/**
 * Injectable spawn context — extends InjectionContext with a `runner` alias
 * and a convenience `run()` method that drains stdout/stderr via Promise.all.
 */
export class SpawnContext extends InjectionContext<SpawnFn> {
  constructor(defaultRunner: SpawnFn = Bun.spawn as SpawnFn) {
    super(defaultRunner);
  }

  /** Alias for `fn` — kept for backwards compatibility with existing call sites. */
  get runner(): SpawnFn {
    return this.fn;
  }

  /** Convenience: run a command using this context's spawn runner. */
  async run(cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return runCmd(this.fn, cmd);
  }
}

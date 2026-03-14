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
 * Generic injection context for dependency injection in tests.
 * Holds a function (or value) with set/reset methods.
 */
export class InjectionContext<T> {
  private _value: T;
  private readonly _default: T;

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

  /** Returns true if the value has been overridden from its default. */
  get isOverridden(): boolean {
    return this._value !== this._default;
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

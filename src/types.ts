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

/**
 * Shared, injectable accessor for the current user's home directory.
 *
 * Every production path that resolves a user-home location — `~/.itsybitsy`,
 * `~/.claude`, `~/.codex`, `~/.gemini`, `~/Library/Caches`, or a bare `~` in an
 * agent-type path — resolves it through {@link userHome} so there is ONE place
 * to redirect at a temporary home during tests. Previously each call site
 * inlined `process.env.HOME || homedir()` (or the `??` variant), and tests
 * redirected them by mutating `process.env.HOME` directly. That global mutation
 * leaked across tests and once caused the real, fixed-name `ib-coordinator`
 * tmux session to be killed and recreated under a temp home. Injecting the
 * override here — via {@link setUserHome} / {@link resetUserHome} — keeps the
 * redirection scoped and off the process environment.
 *
 * Resolution order:
 *   1. the test override, when set via {@link setUserHome};
 *   2. `process.env.HOME`, when it is a non-empty string;
 *   3. `os.homedir()`.
 *
 * The `process.env.HOME || homedir()` step uses `||` (not `??`) on purpose: an
 * empty-string `$HOME` (env -i, systemd units, some sandboxes) must fall back
 * to `homedir()` rather than yielding "" — otherwise callers that join onto it
 * would produce relative paths like `Library/Caches` or an absolute `/.itsybitsy`.
 */

import { homedir } from "os";

/** Test-only override of the resolved home directory (undefined = not set). */
let overrideHome: string | undefined;

/**
 * Resolve the current user's home directory. See the module header for the
 * resolution order and the empty-`$HOME` rationale.
 */
export function userHome(): string {
  return overrideHome ?? (process.env.HOME || homedir());
}

/** Override the user home directory for testing. */
export function setUserHome(path: string): void {
  overrideHome = path;
}

/** Clear the test override so {@link userHome} resolves from the environment. */
export function resetUserHome(): void {
  overrideHome = undefined;
}

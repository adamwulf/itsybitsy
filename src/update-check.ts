/**
 * Update checker — compares local package version against npm registry.
 * Fetches in the background via setTimeout, never blocks startup or rendering.
 * Caches result and re-checks once per hour.
 */

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 5_000; // 5s timeout
const REGISTRY_URL = "https://registry.npmjs.org/itsybitsy/latest";

import type { FetchLike } from "./types";

/** For test injection */
let fetchFn: FetchLike = globalThis.fetch;

export function setTestFetch(fn: FetchLike): void {
  fetchFn = fn;
}

export function resetTestOverrides(): void {
  fetchFn = globalThis.fetch;
}

/**
 * Compare two semver version strings. Returns:
 *  1 if b > a, -1 if a > b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (vb > va) return 1;
    if (va > vb) return -1;
  }
  return 0;
}

let lastCheckTime = 0;
let timerHandle: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

/**
 * Perform a single check against the npm registry.
 * Returns 'vX.X.X' if a newer version exists, null otherwise.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  if (!currentVersion) return null;
  try {
    const resp = await fetchFn(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { version?: string };
    const latest = body.version;
    if (typeof latest !== "string") return null;
    if (compareVersions(currentVersion, latest) > 0) {
      return `v${latest.replace(/^v/, "")}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Start periodic background update checks.
 * First check runs after a short delay (not immediately) to avoid blocking startup.
 * Re-checks once per hour.
 */
export function startUpdateChecker(currentVersion: string, onResult: (version: string) => void): void {
  stopUpdateChecker();
  stopped = false;

  const doCheck = async () => {
    const now = Date.now();
    if (now - lastCheckTime < CHECK_INTERVAL_MS && lastCheckTime > 0) return;
    lastCheckTime = now;
    const result = await checkForUpdate(currentVersion);
    if (stopped) return;
    if (result !== null) onResult(result);
  };

  // First check after 2s delay to avoid blocking startup
  timerHandle = setTimeout(() => {
    doCheck();
    // Then re-check every hour
    timerHandle = setInterval(doCheck, CHECK_INTERVAL_MS);
  }, 2_000);
}

/** Stop the background checker. */
export function stopUpdateChecker(): void {
  stopped = true;
  if (timerHandle !== null) {
    clearTimeout(timerHandle);
    clearInterval(timerHandle);
    timerHandle = null;
  }
  lastCheckTime = 0;
}

/** The `ib watch` top-bar stoplight for the shared sandbox denial collector
 * (docs/SANDBOX-SHARED-COLLECTOR.md). It reads what `ib sandbox-collector status`
 * reads — the lock state and `heartbeat.json` — in process, never by spawning.
 *
 * The probes never take a role and never wait: `sandboxCollectorRunning` is a
 * shared LOCK_SH|LOCK_NB probe of `daemon.lock`, and only when no daemon holds
 * that role is `clients.lock` probed with LOCK_EX|LOCK_NB, released at once.
 * Every attach holds `clients.lock` LOCK_SH for its whole life, so a failed
 * probe means launches are attached. Every fd opened here is closed here.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { sandboxCollectorPaths, sandboxCollectorRunning, tryCollectorLock, type SandboxCollectorPaths } from "./sandbox-collector";
import { SANDBOX_DENIAL_COLLECTOR_ENABLED } from "./sandbox-log-launch";

export type CollectorLight = "grey" | "green" | "yellow" | "red";

export type CollectorState =
  | "off"        // grey: collection is switched off in this build
  | "idle"       // grey: no daemon and no attached launch (the daemon exits by design)
  | "ok"         // green: a daemon holds the role and its heartbeat is fresh
  | "starting"   // yellow: a daemon (or the attach starting it) holds the role; no heartbeat yet
  | "stale"      // yellow: a daemon holds the role but its heartbeat is old (stuck but alive)
  | "no-daemon"  // yellow: launches are attached and no daemon holds the role (first sighting)
  | "broken";    // red: launches are attached and no daemon held the role on two probes in a row

/** The daemon rewrites its heartbeat about every second; older than this means
 * it holds its role but no longer ticks. */
export const COLLECTOR_HEARTBEAT_STALE_MS = 10_000;

export interface CollectorHealth {
  light: CollectorLight;
  state: CollectorState;
  /** From the heartbeat, while a daemon holds the role. */
  pid: number | null;
  heartbeatAgeMs: number | null;
  launches: number | null;
}

export interface CollectorHealthOptions {
  home?: string;
  enabled?: boolean;
  now?: number;
  /** The previous probe. An attach holds `clients.lock` before it starts a
   * daemon, and an exiting daemon frees `daemon.lock` before `clients.lock`,
   * so "attached, no daemon" is normal for a moment; only two probes in a row
   * turn red. */
  previous?: CollectorHealth | null;
}

const LIGHTS: Record<CollectorState, CollectorLight> = {
  off: "grey", idle: "grey", ok: "green", starting: "yellow", stale: "yellow", "no-daemon": "yellow", broken: "red",
};

function health(state: CollectorState, beat: Heartbeat | null = null, now = 0): CollectorHealth {
  return { light: LIGHTS[state], state, pid: beat?.pid ?? null,
    heartbeatAgeMs: beat ? Math.max(0, now - beat.updatedAt) : null, launches: beat?.launches ?? null };
}

interface Heartbeat { pid: number | null; updatedAt: number; launches: number | null }

/** `{v, pid, nonce, updatedAt, launches}`; null when missing or unreadable. */
function readHeartbeat(path: string): Heartbeat | null {
  let fd: number | undefined;
  try {
    // Never follow a symlink, never block on a FIFO, read only a small regular file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return null;
    const beat = JSON.parse(readFileSync(fd, "utf8"));
    if (typeof beat?.updatedAt !== "number" || !Number.isFinite(beat.updatedAt)) return null;
    const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
    return { pid: count(beat.pid), updatedAt: beat.updatedAt, launches: count(beat.launches) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function launchesAttached(paths: SandboxCollectorPaths): boolean {
  try {
    const fd = tryCollectorLock(paths.clientsLock); // LOCK_EX|LOCK_NB
    if (fd === null) return true;
    closeSync(fd);
  } catch { /* no state directory: no launch ever attached */ }
  return false;
}

export function sandboxCollectorHealth(opts: CollectorHealthOptions = {}): CollectorHealth {
  if (!(opts.enabled ?? SANDBOX_DENIAL_COLLECTOR_ENABLED)) return health("off");
  const paths = sandboxCollectorPaths(opts.home);
  if (sandboxCollectorRunning(paths)) {
    const now = opts.now ?? Date.now();
    const beat = readHeartbeat(paths.heartbeat);
    if (!beat) return health("starting");
    return health(now - beat.updatedAt > COLLECTOR_HEARTBEAT_STALE_MS ? "stale" : "ok", beat, now);
  }
  if (!launchesAttached(paths)) return health("idle");
  const previous = opts.previous?.state;
  return health(previous === "no-daemon" || previous === "broken" ? "broken" : "no-daemon");
}

/** One short line for the help panel (about 48 columns are free there). */
export function collectorHealthDetail(status: CollectorHealth): string {
  const beat = () => {
    const seconds = Math.round((status.heartbeatAgeMs ?? 0) / 1000);
    const launches = status.launches === null ? "" : `, ${status.launches} launch${status.launches === 1 ? "" : "es"}`;
    return `${status.state}: pid ${status.pid ?? "?"}, heartbeat ${seconds}s ago${launches}`;
  };
  switch (status.state) {
    case "off": return "off: switched off in this build";
    case "idle": return "idle: no daemon, no attached launch";
    case "ok": case "stale": return beat();
    case "starting": return "starting: daemon has no heartbeat yet";
    case "no-daemon": return "starting: launches attached, no daemon yet";
    case "broken": return "broken: launches attached, no daemon";
  }
}

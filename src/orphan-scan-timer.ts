/**
 * `ib watch`'s orphan-scan timer (SPEC.md §8.3). Runs the process-wide orphan
 * scan (scanAndKillOrphans in src/agent-lifecycle.ts) once shortly after
 * startup and then once an hour, so an orphan that outlived a teardown the scan
 * never saw (a `bun test` started by an agent, spinning after the agent's
 * worktree was removed) does not live until the next retire, merge or nuke.
 *
 * One timer per `ib watch`, not one per repo: the scan reads the whole process
 * table. It runs from a timer callback, never from render(). A scan still
 * running when the next one is due is not doubled up. A failure is logged to
 * watch.log and never thrown. Both timers are unref'd, so they never keep the
 * process alive, and stop() clears them on shutdown.
 */

/**
 * Delay from `ib watch` startup to the first scan: soon enough that an orphan
 * is gone almost at launch, late enough that the scan's `ps` + `lsof` do not
 * compete with the rest of startup (first refresh, fs.watch setup, coordinator).
 */
export const ORPHAN_SCAN_STARTUP_DELAY_MS = 5_000;
/** Interval between the hourly scans, counted from startup. */
export const ORPHAN_SCAN_INTERVAL_MS = 60 * 60_000;

/** What the timer needs from a timer handle. */
export interface OrphanScanTimerHandle {
  unref(): unknown;
}

/** The timer functions; a test passes fakes. */
export interface OrphanScanTimerFns {
  setTimeout(fn: () => void, ms: number): OrphanScanTimerHandle;
  setInterval(fn: () => void, ms: number): OrphanScanTimerHandle;
  clearTimeout(handle: OrphanScanTimerHandle): void;
  clearInterval(handle: OrphanScanTimerHandle): void;
}

const realTimers: OrphanScanTimerFns = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface OrphanScanTimerDeps {
  /** The scan; resolves to the number of orphans it killed. */
  scan: () => Promise<number>;
  /** watch.log writer. */
  log: (line: string) => void;
  timers?: OrphanScanTimerFns;
}

export interface OrphanScanTimer {
  /** Clear both timers. A scan already running finishes on its own. */
  stop(): void;
}

export function startOrphanScanTimer(deps: OrphanScanTimerDeps): OrphanScanTimer {
  const timers = deps.timers ?? realTimers;
  let stopped = false;
  let inFlight = false;

  const run = async (trigger: "startup" | "hourly"): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const killed = await deps.scan();
      deps.log(`[orphan-scan] ${trigger} scan killed ${killed} orphan(s)`);
    } catch (err) {
      deps.log(`[orphan-scan] ${trigger} scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = false;
    }
  };

  const startup = timers.setTimeout(() => void run("startup"), ORPHAN_SCAN_STARTUP_DELAY_MS);
  const hourly = timers.setInterval(() => void run("hourly"), ORPHAN_SCAN_INTERVAL_MS);
  startup.unref();
  hourly.unref();

  return {
    stop() {
      stopped = true;
      timers.clearTimeout(startup);
      timers.clearInterval(hourly);
    },
  };
}

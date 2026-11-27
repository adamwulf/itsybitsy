import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  ORPHAN_SCAN_INTERVAL_MS,
  ORPHAN_SCAN_STARTUP_DELAY_MS,
  startOrphanScanTimer,
  type OrphanScanTimerFns,
  type OrphanScanTimerHandle,
} from "./orphan-scan-timer";

/** A fake timer: records what was scheduled; a test fires it by hand. */
interface FakeTimer extends OrphanScanTimerHandle {
  kind: "timeout" | "interval";
  ms: number;
  fire: () => void;
  unrefed: boolean;
  cleared: boolean;
}

function fakeTimers(): { fns: OrphanScanTimerFns; timers: FakeTimer[] } {
  const timers: FakeTimer[] = [];
  const make = (kind: FakeTimer["kind"]) => (fn: () => void, ms: number): FakeTimer => {
    const timer: FakeTimer = {
      kind, ms, fire: fn, unrefed: false, cleared: false,
      unref() { timer.unrefed = true; },
    };
    timers.push(timer);
    return timer;
  };
  const clear = (kind: FakeTimer["kind"]) => (handle: OrphanScanTimerHandle) => {
    const timer = handle as FakeTimer;
    if (timer.kind !== kind) throw new Error(`cleared a ${timer.kind} as a ${kind}`);
    timer.cleared = true;
  };
  return {
    fns: { setTimeout: make("timeout"), setInterval: make("interval"), clearTimeout: clear("timeout"), clearInterval: clear("interval") },
    timers,
  };
}

/** Let the scan's promise chain settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("startOrphanScanTimer", () => {
  test("schedules one scan shortly after startup and one every hour, both unref'd, and scans nothing yet", () => {
    const { fns, timers } = fakeTimers();
    let scans = 0;
    startOrphanScanTimer({ scan: async () => { scans++; return 0; }, log: () => {}, timers: fns });

    expect(ORPHAN_SCAN_STARTUP_DELAY_MS).toBe(60_000);
    expect(ORPHAN_SCAN_INTERVAL_MS).toBe(3_600_000);
    expect(timers.map(({ kind, ms, unrefed }) => ({ kind, ms, unrefed }))).toEqual([
      { kind: "timeout", ms: ORPHAN_SCAN_STARTUP_DELAY_MS, unrefed: true },
      { kind: "interval", ms: ORPHAN_SCAN_INTERVAL_MS, unrefed: true },
    ]);
    expect(scans).toBe(0);
  });

  test("the startup timer and each hourly tick run one scan and log its count", async () => {
    const { fns, timers } = fakeTimers();
    const lines: string[] = [];
    let scans = 0;
    startOrphanScanTimer({ scan: async () => { scans++; return scans === 1 ? 2 : 0; }, log: (l) => lines.push(l), timers: fns });
    const [startup, hourly] = timers;

    startup!.fire();
    await settle();
    hourly!.fire();
    await settle();
    hourly!.fire();
    await settle();

    expect(scans).toBe(3);
    expect(lines).toEqual([
      "[orphan-scan] startup scan killed 2 orphan(s)",
      "[orphan-scan] hourly scan killed 0 orphan(s)",
      "[orphan-scan] hourly scan killed 0 orphan(s)",
    ]);
  });

  test("a failing scan is logged, never thrown, and the next tick still scans", async () => {
    const { fns, timers } = fakeTimers();
    const lines: string[] = [];
    let scans = 0;
    startOrphanScanTimer({
      scan: async () => {
        scans++;
        if (scans === 1) throw new Error("lsof exploded");
        return 1;
      },
      log: (l) => lines.push(l),
      timers: fns,
    });

    expect(() => timers[0]!.fire()).not.toThrow();
    await settle();
    timers[1]!.fire();
    await settle();

    expect(lines).toEqual([
      "[orphan-scan] startup scan failed: lsof exploded",
      "[orphan-scan] hourly scan killed 1 orphan(s)",
    ]);
  });

  test("a scan that throws synchronously is logged too", async () => {
    const { fns, timers } = fakeTimers();
    const lines: string[] = [];
    startOrphanScanTimer({ scan: () => { throw new Error("no ps"); }, log: (l) => lines.push(l), timers: fns });

    expect(() => timers[0]!.fire()).not.toThrow();
    await settle();

    expect(lines).toEqual(["[orphan-scan] startup scan failed: no ps"]);
  });

  test("a tick while a scan is still running does not start a second one", async () => {
    const { fns, timers } = fakeTimers();
    let scans = 0;
    let finish: (n: number) => void = () => {};
    startOrphanScanTimer({
      scan: () => { scans++; return new Promise<number>((resolve) => { finish = resolve; }); },
      log: () => {},
      timers: fns,
    });

    timers[0]!.fire();
    timers[1]!.fire();
    await settle();
    expect(scans).toBe(1);

    finish(0);
    await settle();
    timers[1]!.fire();
    await settle();
    expect(scans).toBe(2);
  });

  test("stop() clears both timers, and a callback that still fires scans nothing", async () => {
    const { fns, timers } = fakeTimers();
    let scans = 0;
    const timer = startOrphanScanTimer({ scan: async () => { scans++; return 0; }, log: () => {}, timers: fns });

    timer.stop();
    expect(timers.map(({ kind, cleared }) => ({ kind, cleared }))).toEqual([
      { kind: "timeout", cleared: true },
      { kind: "interval", cleared: true },
    ]);

    timers[0]!.fire();
    timers[1]!.fire();
    await settle();
    expect(scans).toBe(0);
  });
});

describe("ib watch wiring", () => {
  // startDashboard only runs in a real `ib watch`, so its wiring is checked in
  // the source, as watch-crash.test.ts checks the crash-handler wiring.
  test("startDashboard starts one process-wide orphan scan timer and quitDashboard stops it", async () => {
    const source = await Bun.file(join(import.meta.dir, "tui", "dashboard.ts")).text();
    const start = source.indexOf("async function startDashboard(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start);

    // Exactly one timer, started in startDashboard (not per repo, and not in
    // startPolling, which dashboard tests call constantly).
    expect(source.match(/startOrphanScanTimer\(/g)).toHaveLength(1);
    expect(body).toContain("orphanScanTimer = startOrphanScanTimer({ scan: () => scanAndKillOrphans(), log: logToWatchLog });");

    const quit = body.slice(body.indexOf("const quitDashboard = "), body.indexOf("process.on(BOUNCE_SIGNAL"));
    expect(quit).toContain("orphanScanTimer?.stop();");
  });
});

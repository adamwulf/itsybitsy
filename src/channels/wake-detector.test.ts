import { test, expect, describe } from "bun:test";
import { WakeDetector, WAKE_INTERVAL_MS, WAKE_SLACK_MS, type WakeEvent, type WakeTimer } from "./wake-detector";

/** A clock and interval timer the test drives by hand. `advance(ms)` moves
 *  the wall clock without firing; `tick()` fires the interval callback once,
 *  the way a real timer would fire after each interval (or once after a wake,
 *  however long the machine slept). */
function harness() {
  let now = 1_000_000;
  let fn: (() => void) | null = null;
  let intervalMs: number | null = null;
  let cleared = 0;
  const timer: WakeTimer = {
    setInterval(cb, ms) {
      fn = cb;
      intervalMs = ms;
      return "handle";
    },
    clearInterval(handle) {
      expect(handle).toBe("handle");
      fn = null;
      cleared += 1;
    },
  };
  return {
    timer,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => {
      if (!fn) throw new Error("timer not running");
      fn();
    },
    running: () => fn !== null,
    intervalMs: () => intervalMs,
    cleared: () => cleared,
  };
}

describe("WakeDetector", () => {
  test("normal ticks never fire", () => {
    const h = harness();
    const d = new WakeDetector({ now: h.now, timer: h.timer });
    const events: WakeEvent[] = [];
    d.onWake((e) => events.push(e));
    d.start();
    expect(h.intervalMs()).toBe(WAKE_INTERVAL_MS);
    for (let i = 0; i < 10; i++) {
      h.advance(WAKE_INTERVAL_MS);
      h.tick();
    }
    // A late tick inside the slack (a busy event loop) is not a wake.
    h.advance(WAKE_INTERVAL_MS + WAKE_SLACK_MS);
    h.tick();
    expect(events).toEqual([]);
  });

  test("a gap beyond interval + slack fires once with the slept time", () => {
    const h = harness();
    const d = new WakeDetector({ now: h.now, timer: h.timer });
    const events: WakeEvent[] = [];
    d.onWake((e) => events.push(e));
    d.start();
    h.advance(WAKE_INTERVAL_MS);
    h.tick();
    // The machine sleeps 10 minutes; the timer fires once after the wake.
    h.advance(10 * 60_000 + WAKE_INTERVAL_MS);
    h.tick();
    expect(events).toEqual([{ sleptMs: 10 * 60_000 }]);
    // The next normal tick is measured from the wake, so it does not refire.
    h.advance(WAKE_INTERVAL_MS);
    h.tick();
    expect(events.length).toBe(1);
  });

  test("custom interval and slack", () => {
    const h = harness();
    const d = new WakeDetector({ now: h.now, timer: h.timer, intervalMs: 1_000, slackMs: 2_000 });
    const events: WakeEvent[] = [];
    d.onWake((e) => events.push(e));
    d.start();
    h.advance(3_000);
    h.tick();
    expect(events).toEqual([]);
    h.advance(3_001);
    h.tick();
    expect(events).toEqual([{ sleptMs: 2_001 }]);
  });

  test("a backwards clock jump never fires", () => {
    const h = harness();
    const d = new WakeDetector({ now: h.now, timer: h.timer });
    const events: WakeEvent[] = [];
    d.onWake((e) => events.push(e));
    d.start();
    h.advance(-3_600_000);
    h.tick();
    expect(events).toEqual([]);
  });

  test("every listener hears a wake, even after one throws; unsubscribe works", () => {
    const h = harness();
    const logs: string[] = [];
    const d = new WakeDetector({ now: h.now, timer: h.timer, log: (l) => logs.push(l) });
    const heard: string[] = [];
    d.onWake(() => {
      heard.push("a");
      throw new Error("listener a broke");
    });
    const unsubscribeB = d.onWake(() => heard.push("b"));
    d.start();
    h.advance(60_000);
    h.tick();
    expect(heard).toEqual(["a", "b"]);
    expect(logs).toEqual(["wake detector: listener threw: listener a broke"]);
    unsubscribeB();
    h.advance(60_000);
    h.tick();
    expect(heard).toEqual(["a", "b", "a"]);
  });

  test("start is idempotent; stop clears the timer and is safe twice", () => {
    const h = harness();
    const d = new WakeDetector({ now: h.now, timer: h.timer });
    d.stop(); // not started: no-op
    expect(h.cleared()).toBe(0);
    d.start();
    d.start();
    expect(h.running()).toBe(true);
    d.stop();
    d.stop();
    expect(h.running()).toBe(false);
    expect(h.cleared()).toBe(1);
  });

  test("a restart measures from the restart, not the old tick", () => {
    const h = harness();
    const d = new WakeDetector({ now: h.now, timer: h.timer });
    const events: WakeEvent[] = [];
    d.onWake((e) => events.push(e));
    d.start();
    d.stop();
    h.advance(60 * 60_000); // stopped for an hour
    d.start();
    h.advance(WAKE_INTERVAL_MS);
    h.tick();
    expect(events).toEqual([]);
  });

  test("the default (real, unref'd) timer starts and stops cleanly", () => {
    // start() calls unref() on the real handle; it must not throw, and stop()
    // must clear it so the test process is not held open.
    const d = new WakeDetector();
    d.start();
    d.stop();
  });
});

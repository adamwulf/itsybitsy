import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { TelegramConnectionMonitor } from "./connection-monitor";
import type { TelegramConnectionView } from "./connection-view";
import {
  readTelegramStatus,
  resetStatusDir,
  setStatusDir,
  telegramStatusPath,
  type TelegramConnectionStatus,
} from "./connection-status";
import type {
  DispatcherHealth,
  DispatcherStateChange,
  DispatcherStateChangeFn,
  TelegramDispatcher,
} from "./dispatcher";
import {
  TelegramDispatcher as RealDispatcher,
  sendCtx,
  sleepCtx as dispatcherSleepCtx,
  logCtx as dispatcherLogCtx,
} from "./dispatcher";
import type { OutboxHealth, OutboxHealthChangeFn } from "./outbox";
import { TelegramOutbox, setOutboxDir, resetOutboxDir } from "./outbox";
import { resetMessageCache } from "./message-cache";
import {
  TelegramClient,
  fetchCtx as clientFetchCtx,
  sleepCtx as clientSleepCtx,
  logCtx as clientLogCtx,
} from "./telegram-client";
import type { WakeListener, WakeSource } from "./wake-detector";

/* ------------------------------------------------------------------ */
/*  Fakes                                                              */
/* ------------------------------------------------------------------ */

function makeFakeDispatcher() {
  let health: DispatcherHealth = { state: "down", lastSuccessAt: null, reason: null, reasonAt: null };
  const listeners = new Set<DispatcherStateChangeFn>();
  const reconnects: string[] = [];
  const fake = {
    getHealth: () => health,
    onStateChange(cb: DispatcherStateChangeFn) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    reconnectNow: (reason: string) => {
      reconnects.push(reason);
    },
  };
  return {
    dispatcher: fake as unknown as TelegramDispatcher,
    reconnects,
    listenerCount: () => listeners.size,
    /** Move to a state; like the real one, fire only on an actual change. */
    transition(to: DispatcherHealth["state"], reason: string | null, reasonAt: number | null = null) {
      const change: DispatcherStateChange = { from: health.state, to, reason };
      health = { ...health, state: to, reason: to === "polling" ? null : reason, reasonAt: to === "polling" ? null : reasonAt };
      if (change.from === change.to) return;
      for (const cb of [...listeners]) cb(change);
    },
  };
}

function makeFakeOutbox() {
  let health: OutboxHealth = { pending: 0, stalled: false, lastError: null, lastErrorAt: null };
  const listeners = new Set<OutboxHealthChangeFn>();
  let kicks = 0;
  const fake = {
    getHealth: () => health,
    onHealthChange(cb: OutboxHealthChangeFn) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    kick: () => {
      kicks += 1;
    },
  };
  return {
    outbox: fake as unknown as TelegramOutbox,
    kicks: () => kicks,
    listenerCount: () => listeners.size,
    /** Change health and fire the event. */
    set(next: Partial<OutboxHealth>) {
      health = { ...health, ...next };
      for (const cb of [...listeners]) cb(health);
    },
    /** Change health WITHOUT an event (only refresh() can see it). */
    setQuietly(next: Partial<OutboxHealth>) {
      health = { ...health, ...next };
    },
  };
}

function makeFakeWake(): WakeSource & { fire: (sleptMs: number) => void; listenerCount: () => number } {
  const listeners = new Set<WakeListener>();
  return {
    onWake(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fire(sleptMs) {
      for (const listener of [...listeners]) listener({ sleptMs });
    },
    listenerCount: () => listeners.size,
  };
}

interface Harness {
  monitor: TelegramConnectionMonitor;
  views: TelegramConnectionView[];
  writes: TelegramConnectionStatus[];
  clears: number[];
  logs: string[];
  wake: ReturnType<typeof makeFakeWake>;
  setNow: (ms: number) => void;
}

function makeMonitor(opts: { writeStatus?: (s: TelegramConnectionStatus) => Promise<void> } = {}): Harness {
  let now = 1_000;
  const views: TelegramConnectionView[] = [];
  const writes: TelegramConnectionStatus[] = [];
  const clears: number[] = [];
  const logs: string[] = [];
  const wake = makeFakeWake();
  const monitor = new TelegramConnectionMonitor({
    log: (line) => logs.push(line),
    onChange: (v) => views.push(v),
    wake,
    now: () => now,
    pid: 4242,
    writeStatus:
      opts.writeStatus ??
      (async (status) => {
        writes.push(status);
      }),
    clearStatus: async (pid) => {
      clears.push(pid);
    },
  });
  return { monitor, views, writes, clears, logs, wake, setNow: (ms) => { now = ms; } };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("TelegramConnectionMonitor", () => {
  test("first refresh publishes connecting; boot retries update it; a repeated reason keeps its time", async () => {
    const h = makeMonitor();
    h.monitor.refresh();
    expect(h.views.map((v) => v.state)).toEqual(["connecting"]);

    h.setNow(2_000);
    h.monitor.bootRetry("HTTP 502");
    h.setNow(9_000);
    h.monitor.bootRetry("HTTP 502"); // same reason: no change
    h.monitor.bootRetry("errno:ETIMEDOUT");
    expect(h.views.slice(1)).toEqual([
      { state: "connecting", lastError: "HTTP 502", lastErrorAt: 2_000, outboxPending: 0 },
      { state: "connecting", lastError: "errno:ETIMEDOUT", lastErrorAt: 9_000, outboxPending: 0 },
    ]);
    await h.monitor.flush();
    expect(h.writes.map((w) => [w.state, w.lastError, w.pid])).toEqual([
      ["connecting", null, 4242],
      ["connecting", "HTTP 502", 4242],
      ["connecting", "errno:ETIMEDOUT", 4242],
    ]);
  });

  test("bootDisabled publishes disabled with the reason minus boot's prefix", async () => {
    const h = makeMonitor();
    h.monitor.bootDisabled("Telegram routing disabled: bot token rejected (HTTP 401)");
    expect(h.monitor.view()).toEqual({
      state: "disabled",
      lastError: "bot token rejected (HTTP 401)",
      lastErrorAt: 1_000,
      outboxPending: 0,
    });
    await h.monitor.flush();
    expect(h.writes.length).toBe(1);
  });

  test("attach: connecting until start() settles, then connected", () => {
    const h = makeMonitor();
    const d = makeFakeDispatcher();
    const o = makeFakeOutbox();
    h.monitor.attach(d.dispatcher, o.outbox);
    expect(h.monitor.view()?.state).toBe("connecting");
    d.transition("polling", null); // start(): optimistic down → polling
    expect(h.monitor.view()?.state).toBe("connected");
    h.monitor.dispatcherStartSettled();
    expect(h.monitor.view()?.state).toBe("connected");
    // The initial transition is silent in watch.log.
    expect(h.logs).toEqual([]);
  });

  test("a 409 at the dispatcher's startup probe (down after start) shows disabled", () => {
    const h = makeMonitor();
    const d = makeFakeDispatcher();
    const o = makeFakeOutbox();
    h.monitor.attach(d.dispatcher, o.outbox);
    // start() saw 409: state stays down (no event), reason set.
    d.transition("down", "409 Conflict", 1_000);
    h.monitor.dispatcherStartSettled();
    expect(h.monitor.view()).toEqual({ state: "disabled", lastError: "409 Conflict", lastErrorAt: 1_000, outboxPending: 0 });
  });

  test("retrying → reconnecting and logs disconnected; recovery logs reconnected and kicks the outbox", () => {
    const h = makeMonitor();
    const d = makeFakeDispatcher();
    const o = makeFakeOutbox();
    h.monitor.attach(d.dispatcher, o.outbox);
    d.transition("polling", null);
    h.monitor.dispatcherStartSettled();

    d.transition("retrying", "HTTP 502", 5_000);
    expect(h.monitor.view()).toEqual({ state: "reconnecting", lastError: "HTTP 502", lastErrorAt: 5_000, outboxPending: 0 });
    expect(o.kicks()).toBe(0);

    d.transition("polling", "reconnected after 40s");
    expect(h.monitor.view()?.state).toBe("connected");
    expect(o.kicks()).toBe(1);
    expect(h.logs).toEqual(["telegram: disconnected (HTTP 502)", "telegram: reconnected after 40s"]);
  });

  test("a stalled outbox shows reconnecting with its error and pending count; recovery shows connected", () => {
    const h = makeMonitor();
    const d = makeFakeDispatcher();
    const o = makeFakeOutbox();
    h.monitor.attach(d.dispatcher, o.outbox);
    d.transition("polling", null);
    h.monitor.dispatcherStartSettled();

    o.set({ pending: 2, stalled: true, lastError: "sendMessage failed: HTTP 502", lastErrorAt: 7_000 });
    expect(h.monitor.view()).toEqual({
      state: "reconnecting",
      lastError: "sendMessage failed: HTTP 502",
      lastErrorAt: 7_000,
      outboxPending: 2,
    });
    o.set({ pending: 0, stalled: false, lastError: null, lastErrorAt: null });
    expect(h.monitor.view()?.state).toBe("connected");
  });

  test("a stall keeps the time its label first appeared while the outbox refreshes lastErrorAt each retry", async () => {
    const h = makeMonitor();
    const d = makeFakeDispatcher();
    const o = makeFakeOutbox();
    h.monitor.attach(d.dispatcher, o.outbox);
    d.transition("polling", null);
    h.monitor.dispatcherStartSettled();

    o.set({ pending: 1, stalled: true, lastError: "HTTP 502", lastErrorAt: 10_000 });
    const views = h.views.length;
    // Each stall retry: the real outbox moves lastErrorAt and fires no event.
    o.setQuietly({ lastErrorAt: 12_000 });
    h.monitor.refresh();
    o.setQuietly({ lastErrorAt: 16_000 });
    h.monitor.refresh();
    expect(h.views.length).toBe(views);
    expect(h.monitor.view()?.lastErrorAt).toBe(10_000);

    // A new label is a new error: its own first time.
    o.set({ lastError: "errno:ECONNRESET", lastErrorAt: 20_000 });
    expect(h.monitor.view()?.lastErrorAt).toBe(20_000);
    // After the stall ends, a later stall starts fresh even with the old label.
    o.set({ stalled: false, lastError: null, lastErrorAt: null });
    o.set({ stalled: true, lastError: "errno:ECONNRESET", lastErrorAt: 30_000 });
    expect(h.monitor.view()?.lastErrorAt).toBe(30_000);
    await h.monitor.flush();
    const stallWrites = h.writes.filter((w) => w.state === "reconnecting");
    expect(stallWrites.map((w) => w.lastErrorAt)).toEqual([10_000, 20_000, 30_000]);
  });

  test("refresh() is the backstop for a change that fired no event", () => {
    const h = makeMonitor();
    const d = makeFakeDispatcher();
    const o = makeFakeOutbox();
    h.monitor.attach(d.dispatcher, o.outbox);
    d.transition("polling", null);
    const before = h.views.length;
    o.setQuietly({ pending: 3 });
    expect(h.views.length).toBe(before);
    h.monitor.refresh();
    expect(h.monitor.view()?.outboxPending).toBe(3);
  });

  test("status writes are edge-triggered and never overlap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const h = makeMonitor({
      writeStatus: async (status) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((r) => setTimeout(r, 5));
        order.push(`${status.state}:${status.lastError}`);
        inFlight -= 1;
      },
    });
    h.monitor.refresh();
    h.monitor.refresh(); // no change: no write
    h.monitor.bootRetry("HTTP 502");
    h.monitor.bootRetry("HTTP 503");
    h.monitor.bootDisabled("Telegram routing disabled: another poller or webhook is active");
    h.monitor.refresh(); // no change: no write
    await h.monitor.flush();
    expect(order).toEqual([
      "connecting:null",
      "connecting:HTTP 502",
      "connecting:HTTP 503",
      "disabled:another poller or webhook is active",
    ]);
    expect(maxInFlight).toBe(1);
  });

  test("a failed write is logged and later writes still run", async () => {
    let calls = 0;
    const h = makeMonitor({
      writeStatus: async () => {
        calls += 1;
        if (calls === 1) throw new Error("EACCES: permission denied");
      },
    });
    h.monitor.refresh();
    h.monitor.bootRetry("HTTP 502");
    await h.monitor.flush();
    expect(calls).toBe(2);
    expect(h.logs).toEqual(["telegram: status file write failed: EACCES: permission denied"]);
  });

  test("dispose stops publishing, waits for queued writes, clears the file, and unsubscribes; idempotent", async () => {
    const order: string[] = [];
    const clears: number[] = [];
    const wake = makeFakeWake();
    const monitor = new TelegramConnectionMonitor({
      log: () => {},
      wake,
      pid: 77,
      writeStatus: async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
        order.push("write");
      },
      clearStatus: async (pid) => {
        order.push("clear");
        clears.push(pid);
      },
    });
    const d = makeFakeDispatcher();
    const o = makeFakeOutbox();
    monitor.attach(d.dispatcher, o.outbox);
    const first = monitor.dispose();
    const second = monitor.dispose();
    expect(second).toBe(first);
    // Changes after dispose publish nothing.
    d.transition("polling", null);
    monitor.refresh();
    await first;
    expect(order).toEqual(["write", "clear"]);
    expect(clears).toEqual([77]);
    expect(d.listenerCount()).toBe(0);
    expect(o.listenerCount()).toBe(0);
    expect(wake.listenerCount()).toBe(0);
  });

  test("wake while running: logs, drops the dispatcher's poll, kicks the outbox", () => {
    const h = makeMonitor();
    const d = makeFakeDispatcher();
    const o = makeFakeOutbox();
    h.monitor.attach(d.dispatcher, o.outbox);
    h.wake.fire(600_400);
    expect(h.logs).toEqual(["telegram: wake from sleep detected (slept ~600s); reconnecting"]);
    expect(d.reconnects).toEqual(["wake from sleep"]);
    expect(o.kicks()).toBe(1);
  });

  test("wake while boot is retrying only logs (boot handles its own backoff); disabled or disposed ignores it", async () => {
    const h = makeMonitor();
    h.monitor.bootRetry("HTTP 502");
    h.wake.fire(60_000);
    expect(h.logs).toEqual(["telegram: wake from sleep detected (slept ~60s); reconnecting"]);

    const disabled = makeMonitor();
    disabled.monitor.bootDisabled("Telegram routing disabled: no bot token configured");
    disabled.wake.fire(60_000);
    expect(disabled.logs).toEqual([]);

    const disposed = makeMonitor();
    await disposed.monitor.dispose();
    disposed.wake.fire(60_000);
    expect(disposed.logs).toEqual([]);
  });

  test("a throwing onChange is logged and the write still happens", async () => {
    const writes: TelegramConnectionStatus[] = [];
    const logs: string[] = [];
    const monitor = new TelegramConnectionMonitor({
      log: (l) => logs.push(l),
      onChange: () => {
        throw new Error("render failed");
      },
      writeStatus: async (s) => {
        writes.push(s);
      },
      clearStatus: async () => {},
    });
    monitor.refresh();
    await monitor.flush();
    expect(logs).toEqual(["telegram: status listener threw: render failed"]);
    expect(writes.length).toBe(1);
  });
});

describe("TelegramConnectionMonitor with the real status file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tg-monitor-status-"));
    setStatusDir(dir);
  });

  afterEach(async () => {
    resetStatusDir();
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the current state for readers and removes the file on dispose", async () => {
    const monitor = new TelegramConnectionMonitor({ log: () => {}, now: () => 123 });
    monitor.bootRetry("HTTP 502");
    await monitor.flush();
    const read = await readTelegramStatus();
    expect(read?.live).toBe(true);
    expect(read?.status).toEqual({
      state: "connecting",
      lastError: "HTTP 502",
      lastErrorAt: 123,
      outboxPending: 0,
      pid: process.pid,
      updatedAt: 123,
    });
    await monitor.dispose();
    expect(await Bun.file(telegramStatusPath()).exists()).toBe(false);
  });
});

describe("TelegramConnectionMonitor with a real TelegramOutbox", () => {
  let root: string;
  let outboxDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tg-monitor-outbox-"));
    outboxDir = join(root, "outbox");
    setOutboxDir(outboxDir);
    clientSleepCtx.set(async () => {}); // inline retries fast-forward
    clientLogCtx.set(() => {});
    resetMessageCache();
  });

  afterEach(async () => {
    resetOutboxDir();
    clientFetchCtx.reset();
    clientSleepCtx.reset();
    clientLogCtx.reset();
    resetMessageCache();
    await rm(root, { recursive: true, force: true });
  });

  test("a stalled outbox shows reconnecting; the poll loop's recovery kicks it and the message goes out", async () => {
    const state = { down: true };
    const sends: string[] = [];
    clientFetchCtx.set(async (_input, init) => {
      sends.push((JSON.parse(init!.body as string) as { text: string }).text);
      if (state.down) {
        return Response.json({ ok: false, error_code: 502, description: "Bad Gateway" }, { status: 502 });
      }
      return Response.json({ ok: true, result: { message_id: 77, chat: { id: 1 } } });
    });
    // A stall that only kick() can end inside the test.
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      log: () => {},
      stallBackoff: { initialMs: 60_000, maxMs: 60_000 },
    });
    const d = makeFakeDispatcher();
    const views: TelegramConnectionView[] = [];
    const monitor = new TelegramConnectionMonitor({
      log: () => {},
      onChange: (v) => views.push(v),
      writeStatus: async () => {},
      clearStatus: async () => {},
    });
    monitor.attach(d.dispatcher, outbox);
    d.transition("polling", null);
    monitor.dispatcherStartSettled();
    await outbox.start();

    // Drop a message the way `ib tgsend` does (.tmp + rename).
    const base = `${Date.now()}-aaaaaa.txt`;
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, `${base}.tmp`), "hello after the outage");
    await rename(join(outboxDir, `${base}.tmp`), join(outboxDir, base));

    const startedAt = Date.now();
    const waitUntil = async (pred: () => boolean, label: string) => {
      while (!pred()) {
        if (Date.now() - startedAt > 10_000) throw new Error(`timed out: ${label}`);
        await new Promise<void>((r) => setTimeout(r, 5));
      }
    };
    await waitUntil(() => monitor.view()?.state === "reconnecting", "stall shows as reconnecting");
    expect(monitor.view()).toMatchObject({ state: "reconnecting", lastError: "HTTP 502", outboxPending: 1 });
    const attemptsWhileStalled = sends.length;
    expect(attemptsWhileStalled).toBeGreaterThan(0);

    // The poll loop drops and recovers once Telegram is back.
    state.down = false;
    d.transition("retrying", "HTTP 502", Date.now());
    expect(sends.length).toBe(attemptsWhileStalled); // nothing kicked yet
    d.transition("polling", "reconnected after 3s");

    await waitUntil(() => monitor.view()?.state === "connected" && monitor.view()?.outboxPending === 0, "delivered");
    expect(sends.length).toBe(attemptsWhileStalled + 1);
    expect(sends[sends.length - 1]).toBe("hello after the outage");
    const result = JSON.parse(await readFile(join(outboxDir, `${base}.result`), "utf8")) as { ok: boolean; message: string };
    expect(result).toEqual({ ok: true, message: "ok (message_id 77)" });
    // Light path: connected → reconnecting (stall) → ... → connected.
    expect(views.map((v) => v.state)).toContain("reconnecting");
    expect(views[views.length - 1]!.state).toBe("connected");

    await monitor.dispose();
    await outbox.stop();
  });
});

describe("TelegramConnectionMonitor with a real dispatcher", () => {
  afterEach(() => {
    clientFetchCtx.reset();
    clientSleepCtx.reset();
    clientLogCtx.reset();
    sendCtx.reset();
    dispatcherSleepCtx.reset();
    dispatcherLogCtx.reset();
  });

  test("the poll loop's retrying → polling recovery kicks the outbox once", async () => {
    // Startup probe ok, one failed long-poll, one good one, then idle.
    const replies: Array<() => Response> = [
      () => Response.json({ ok: true, result: [] }),
      () => {
        throw new Error("ECONNRESET");
      },
      () => Response.json({ ok: true, result: [] }),
    ];
    clientFetchCtx.set(async (_input, init) => {
      const next = replies.shift();
      if (next) return next();
      return await new Promise<Response>((_, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    clientSleepCtx.set(async () => {});
    clientLogCtx.set(() => {});
    dispatcherSleepCtx.set(async () => {});
    dispatcherLogCtx.set(() => {});
    sendCtx.set(async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }));

    const dispatcher = new RealDispatcher({
      client: new TelegramClient({ token: "T" }),
      allowedChatIds: ["100"],
      allowedUserIds: [],
      chatId: "100",
    });
    const o = makeFakeOutbox();
    const logs: string[] = [];
    const monitor = new TelegramConnectionMonitor({
      log: (l) => logs.push(l),
      writeStatus: async () => {},
      clearStatus: async () => {},
    });
    monitor.attach(dispatcher, o.outbox);
    await dispatcher.start();
    monitor.dispatcherStartSettled();
    const startedAt = Date.now();
    while (o.kicks() === 0 && Date.now() - startedAt < 2_000) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(o.kicks()).toBe(1);
    expect(logs[0]).toBe("telegram: disconnected (errno:ECONNRESET)");
    expect(logs[1]).toMatch(/^telegram: reconnected after \d+s$/);
    expect(monitor.view()?.state).toBe("connected");
    await monitor.dispose();
    await dispatcher.stop();
  });
});

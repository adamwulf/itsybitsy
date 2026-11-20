/**
 * The inbound path against a fake Telegram Bot API over real HTTP: a real
 * TelegramClient and a real TelegramDispatcher talk to `Bun.serve({ port: 0 })`.
 * Each test injects one fault into the long-poll — a 5xx burst, a 429 with
 * Retry-After, a poll that never answers, a body cut off mid-poll, a poll
 * stranded on a dead socket until a wake — and then checks the real update
 * queued behind it is delivered to the coordinator exactly once and the
 * offset moves past it.
 *
 * Long-polls use `timeout: 0` and a 300 ms client deadline, and the server
 * holds an idle poll for 30 ms, so the whole file runs in about a second.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { TelegramClient, sleepCtx as clientSleepCtx, logCtx as clientLogCtx } from "./telegram-client";
import { TelegramDispatcher, sendCtx, sleepCtx as dispatcherSleepCtx, logCtx as dispatcherLogCtx } from "./dispatcher";
import type { DispatcherHealthState } from "./dispatcher";
import { randomCtx } from "./backoff";
import { setStateDir as setLastMsgStateDir, resetStateDir as resetLastMsgStateDir } from "./last-message-cache";
import { resetMessageCache } from "./message-cache";
import type { TelegramUpdate } from "./types";

const TOKEN = "123:FAKE_TOKEN";
const CHAT_ID = 100;

/** What the fake does with the next long-poll. */
type Fault =
  | { kind: "status"; status: number }
  | { kind: "429"; retryAfterSec: number }
  | { kind: "hang" }
  | { kind: "truncate" };

interface FakeTelegram {
  baseUrl: string;
  /** Faults applied to the next long-polls, in order. */
  faults: Fault[];
  /** Updates Telegram holds; served while `update_id >= offset`. */
  pending: TelegramUpdate[];
  /** `offset` of every long-poll received (undefined = none sent). */
  pollOffsets: Array<number | undefined>;
  stop(): void;
}

function startFakeTelegram(): FakeTelegram {
  const hung: Array<(r: Response) => void> = [];
  const fake: Omit<FakeTelegram, "baseUrl" | "stop"> = { faults: [], pending: [], pollOffsets: [] };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== `/bot${TOKEN}/getUpdates`) {
        // sendMessage etc.: nothing in these tests depends on the reply.
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      const body = (await req.json()) as { offset?: number; limit?: number };
      // The dispatcher's startup probe (offset -1, limit 1).
      if (body.limit === 1) return Response.json({ ok: true, result: [] });

      fake.pollOffsets.push(body.offset);
      const fault = fake.faults.shift();
      if (fault?.kind === "status") {
        return Response.json({ ok: false, error_code: fault.status, description: "fault" }, { status: fault.status });
      }
      if (fault?.kind === "429") {
        return Response.json(
          { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: fault.retryAfterSec } },
          { status: 429, headers: { "retry-after": String(fault.retryAfterSec) } },
        );
      }
      if (fault?.kind === "hang") {
        // Never answers on its own (a dead socket). Released at stop().
        return await new Promise<Response>((resolve) => hung.push(resolve));
      }
      const offset = body.offset ?? 0;
      const ready = fake.pending.filter((u) => u.update_id >= offset);
      if (fault?.kind === "truncate") {
        // Promise 500 bytes, send a fragment, close: the connection drops
        // mid-body and the client's JSON parse fails.
        const fragment = JSON.stringify({ ok: true, result: ready }).slice(0, 20);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(fragment));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/json", "content-length": "500" } });
      }
      if (ready.length === 0) await Bun.sleep(30); // a short idle long-poll
      return Response.json({ ok: true, result: ready });
    },
  });
  return {
    ...fake,
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop() {
      for (const release of hung.splice(0)) release(new Response("", { status: 499 }));
      server.stop(true);
    },
  } as FakeTelegram;
}

function textUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      chat: { id: CHAT_ID, type: "private" },
      from: { id: 7, username: "alice" },
      date: 1_700_000_000,
      text,
    },
  };
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!pred()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`waitFor: ${label}`);
    await Bun.sleep(5);
  }
}

describe("inbound against a fake Telegram server", () => {
  let fake: FakeTelegram;
  let stateRoot: string;
  let deliveries: string[];
  let clientWaits: number[];
  let clientLogs: string[];
  let dispatcher: TelegramDispatcher | null;
  let states: DispatcherHealthState[];

  beforeEach(async () => {
    fake = startFakeTelegram();
    stateRoot = await mkdtemp(join(tmpdir(), "tg-reconnect-"));
    setLastMsgStateDir(join(stateRoot, "channels", "telegram"));
    resetMessageCache();
    deliveries = [];
    clientWaits = [];
    clientLogs = [];
    states = [];
    dispatcher = null;
    sendCtx.set(async (message) => {
      deliveries.push(message);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });
    // Record the client's backoff waits but only sleep a moment, so the
    // test sees the real wait the client chose without paying for it.
    clientSleepCtx.set(async (ms) => {
      clientWaits.push(ms);
      await Bun.sleep(1);
    });
    clientLogCtx.set((line) => clientLogs.push(line));
    dispatcherSleepCtx.set(async () => {});
    dispatcherLogCtx.set(() => {});
    randomCtx.set(() => 0); // no jitter
  });

  afterEach(async () => {
    await dispatcher?.stop();
    fake.stop();
    sendCtx.reset();
    clientSleepCtx.reset();
    clientLogCtx.reset();
    dispatcherSleepCtx.reset();
    dispatcherLogCtx.reset();
    randomCtx.reset();
    resetLastMsgStateDir();
    resetMessageCache();
    await rm(stateRoot, { recursive: true, force: true });
  });

  async function startDispatcher(getUpdatesBufferMs = 300): Promise<TelegramDispatcher> {
    const client = new TelegramClient({
      token: TOKEN,
      baseUrl: fake.baseUrl,
      timeouts: { getUpdatesBufferMs, probeMs: 2_000 },
    });
    const d = new TelegramDispatcher({
      client,
      allowedChatIds: [String(CHAT_ID)],
      allowedUserIds: [],
      chatId: String(CHAT_ID),
      pollTimeoutSec: 0,
    });
    d.onStateChange((change) => states.push(change.to));
    dispatcher = d;
    await d.start();
    return d;
  }

  /** The update was delivered once, the next polls asked past it, and two
   *  more polls did not deliver it again. */
  async function expectDeliveredOnce(updateId: number, text: string): Promise<void> {
    await waitFor(() => deliveries.length >= 1, `update ${updateId} delivered`);
    const pollsAfter = () => fake.pollOffsets.filter((o) => o === updateId + 1).length;
    await waitFor(() => pollsAfter() >= 2, `offset advanced to ${updateId + 1}`);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]).toContain(text);
    expect(dispatcher!.getHealth().state).toBe("polling");
  }

  test("a 5xx burst is retried with backoff, then the update arrives once", async () => {
    fake.faults.push({ kind: "status", status: 502 }, { kind: "status", status: 502 }, { kind: "status", status: 503 });
    fake.pending.push(textUpdate(41, "after the burst"));
    await startDispatcher();
    await expectDeliveredOnce(41, "after the burst");
    expect(clientWaits.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
    expect(clientLogs).toEqual([
      "telegram getUpdates: HTTP 502, retrying with backoff",
      "telegram getUpdates: HTTP 503, retrying with backoff",
    ]);
    expect(states).toEqual(["polling", "retrying", "polling"]);
  });

  test("a 429 waits out Retry-After, then the update arrives once", async () => {
    fake.faults.push({ kind: "429", retryAfterSec: 3 });
    fake.pending.push(textUpdate(7, "after the 429"));
    await startDispatcher();
    await expectDeliveredOnce(7, "after the 429");
    expect(clientWaits[0]).toBe(3_000);
  });

  test("a long-poll that never answers times out client-side and is retried", async () => {
    fake.faults.push({ kind: "hang" });
    fake.pending.push(textUpdate(12, "after the timeout"));
    const startedAt = Date.now();
    await startDispatcher(300);
    await expectDeliveredOnce(12, "after the timeout");
    // The client deadline (0 s long-poll + 300 ms) ended the hung poll.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(dispatcher!.getHealth().state).toBe("polling");
    expect(clientLogs).toEqual(["telegram getUpdates: errno:ETIMEDOUT, retrying with backoff"]);
  });

  test("a connection dropped mid-body (truncated reply) is retried", async () => {
    fake.faults.push({ kind: "truncate" });
    fake.pending.push(textUpdate(20, "after the drop"));
    await startDispatcher();
    await expectDeliveredOnce(20, "after the drop");
    expect(clientLogs.length).toBe(1);
    expect(clientLogs[0]).toStartWith("telegram getUpdates: ");
    expect(states).toEqual(["polling", "retrying", "polling"]);
  });

  test("reconnectNow (a wake) drops a poll stranded on a dead socket and the update arrives once", async () => {
    fake.faults.push({ kind: "hang" });
    fake.pending.push(textUpdate(30, "after the wake"));
    // A 30 s client deadline: without the reconnect this poll would sit for
    // 30 s, like one in flight when the machine slept.
    const d = await startDispatcher(30_000);
    await waitFor(() => fake.pollOffsets.length === 1, "first poll reached the server");
    await Bun.sleep(20);
    expect(deliveries).toEqual([]);
    d.reconnectNow("wake from sleep");
    await expectDeliveredOnce(30, "after the wake");
    // Not a failure: no client backoff wait, no retry state.
    expect(clientWaits).toEqual([]);
    expect(states).toEqual(["polling"]);
  });

  test("the token never appears in client log lines", async () => {
    fake.faults.push({ kind: "status", status: 500 }, { kind: "hang" }, { kind: "truncate" });
    fake.pending.push(textUpdate(50, "x"));
    await startDispatcher();
    await expectDeliveredOnce(50, "x");
    expect(clientLogs.length).toBeGreaterThan(0);
    expect(clientLogs.some((l) => l.includes("FAKE_TOKEN"))).toBe(false);
  });
});

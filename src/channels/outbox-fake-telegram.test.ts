/**
 * End-to-end outbox delivery against a fake Telegram Bot API server.
 *
 * A real `TelegramClient` (real fetch, short timeouts) and a real
 * `TelegramOutbox` (real fs.watch on a tmp outbox dir) talk to a local
 * `Bun.serve` that scripts the failures seen in Adam's watch.log: 502 bursts,
 * a 429 with a `Retry-After` header, and a request that never answers. The
 * assertions are made on what the SERVER saw: order, and no duplicates.
 *
 * Only `sleepCtx` (the inline retry waits) is fast-forwarded; it records the
 * requested delays so the Retry-After handling is visible.
 */

import { test, expect, describe, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readFile, rename, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import type { Server } from "bun";
import { TelegramOutbox, setOutboxDir, resetOutboxDir } from "./outbox";
import { TelegramClient, fetchCtx, sleepCtx, logCtx } from "./telegram-client";
import { randomCtx } from "./backoff";
import { resetMessageCache } from "./message-cache";

setDefaultTimeout(30_000);

const TOKEN = "FAKE_TOKEN_123";

let tmpRoot: string;
let outboxDir: string;
let server: Server<undefined> | null = null;
let sleeps: number[];

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "outbox-fake-tg-"));
  outboxDir = join(tmpRoot, "outbox");
  setOutboxDir(outboxDir);
  fetchCtx.reset(); // real fetch
  sleeps = [];
  sleepCtx.set(async (ms) => {
    sleeps.push(ms);
  });
  logCtx.set(() => { /* silence the client */ });
  randomCtx.set(() => 0); // no jitter: delays are exact
  resetMessageCache();
});

afterEach(async () => {
  server?.stop(true);
  server = null;
  resetOutboxDir();
  sleepCtx.reset();
  logCtx.reset();
  randomCtx.reset();
  resetMessageCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

type Handler = (method: string, body: Record<string, unknown>, attempt: number) => Response | Promise<Response>;

/** Start the fake server. `handler` gets the Bot API method, the JSON body and
 *  the 1-based attempt number for that exact request body. */
function startServer(handler: Handler): string {
  const attempts = new Map<string, number>();
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const prefix = `/bot${TOKEN}/`;
      if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
      const method = path.slice(prefix.length);
      const body = (await req.json()) as Record<string, unknown>;
      const key = `${method} ${JSON.stringify(body)}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      return handler(method, body, attempt);
    },
  });
  return server.url.origin;
}

function ok(result: unknown): Response {
  return Response.json({ ok: true, result });
}

async function drop(base: string, content: string): Promise<void> {
  await mkdir(outboxDir, { recursive: true });
  await writeFile(join(outboxDir, `${base}.tmp`), content);
  await rename(join(outboxDir, `${base}.tmp`), join(outboxDir, base));
}

async function finalResult(base: string): Promise<{ ok: boolean; message: string }> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const parsed = JSON.parse(await readFile(join(outboxDir, `${base}.result`), "utf8"));
      if (parsed.queued !== true) return parsed;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`no final result for ${base}`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

describe("outbox against a fake Telegram server", () => {
  test("502 burst, 429 Retry-After and a hung request: each item arrives once, in order", async () => {
    // What the server accepted, in arrival order.
    const delivered: string[] = [];
    let nextId = 100;
    const baseUrl = startServer((method, body, attempt) => {
      if (method === "sendMessage") {
        const text = String(body.text);
        if (text === "A") {
          // 429 (Retry-After 3), then a 502 burst that exhausts the inline
          // retries and stalls the queue, then success on the stall retry.
          if (attempt === 1) {
            return Response.json(
              { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } },
              { status: 429, headers: { "retry-after": "3" } },
            );
          }
          if (attempt <= 3) return new Response("<html>502 Bad Gateway</html>", { status: 502 });
        }
        delivered.push(`text:${text}`);
        return ok({ message_id: nextId++, chat: { id: 1 } });
      }
      if (method === "setMessageReaction") {
        // The first attempt never answers: the client's 200ms timeout fires.
        if (attempt === 1) return new Promise<Response>(() => {});
        delivered.push(`react:${String(body.message_id)}`);
        return ok(true);
      }
      return new Response("unexpected", { status: 404 });
    });

    const client = new TelegramClient({ token: TOKEN, baseUrl, timeouts: { sendMessageMs: 200 } });
    const outbox = new TelegramOutbox({
      client,
      chatId: "1",
      log: () => {},
      stallBackoff: { initialMs: 10, maxMs: 20 },
    });
    await outbox.start();

    const t = Date.now();
    await drop(`${t}-aaaaaa.txt`, "A");
    await drop(`${t + 1}-bbbbbb.react.json`, JSON.stringify({ message_id: 7, emoji: "👍" }));
    await drop(`${t + 2}-cccccc.txt`, "C");

    expect(await finalResult(`${t}-aaaaaa.txt`)).toEqual({ ok: true, message: "ok (message_id 100)" });
    expect(await finalResult(`${t + 1}-bbbbbb.react.json`)).toEqual({ ok: true, message: "ok" });
    expect(await finalResult(`${t + 2}-cccccc.txt`)).toEqual({ ok: true, message: "ok (message_id 101)" });

    expect(delivered).toEqual(["text:A", "react:7", "text:C"]);
    // Inline waits: max(Retry-After 3s, backoff 1s), then backoff 2s for the
    // 502; then the reaction's timeout retry waits backoff 1s.
    expect(sleeps).toEqual([3_000, 2_000, 1_000]);
    expect(outbox.getHealth()).toEqual({ pending: 0, stalled: false, lastError: null, lastErrorAt: null });

    await outbox.stop();
  });

  test("CAVEAT: a timeout after Telegram accepted the message duplicates it on retry", async () => {
    // sendMessage has no idempotency key. When the server accepts the message
    // but the answer arrives after the client's timeout, the retry sends it
    // again. We accept that over losing the message; this test pins the
    // trade-off so it is a decision, not a surprise.
    const delivered: string[] = [];
    const baseUrl = startServer(async (method, body, attempt) => {
      delivered.push(String(body.text));
      if (attempt === 1) await new Promise<void>((r) => setTimeout(r, 400));
      return ok({ message_id: 200 + attempt, chat: { id: 1 } });
    });

    const client = new TelegramClient({ token: TOKEN, baseUrl, timeouts: { sendMessageMs: 200 } });
    const outbox = new TelegramOutbox({ client, chatId: "1", log: () => {} });
    await outbox.start();

    const base = `${Date.now()}-dddddd.txt`;
    await drop(base, "slow ack");
    expect(await finalResult(base)).toEqual({ ok: true, message: "ok (message_id 202)" });
    expect(delivered).toEqual(["slow ack", "slow ack"]);

    await outbox.stop();
  });
});

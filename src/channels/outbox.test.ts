/**
 * Tests for the Phase B Telegram outbox + the file-drop tgsend client.
 *
 * Most paths are exercised against a real `fs.watch` on a tmpdir, with
 * `TelegramClient.fetch` stubbed via the existing `fetchCtx` injection.
 * Tests that need to assert on serialization or timeout-cancellation rely
 * on a fake client we hand-roll inline rather than the real one.
 */

import { test, expect, describe, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readdir, writeFile, readFile, chmod, mkdir, unlink } from "fs/promises";
import { tmpdir } from "os";
import {
  TelegramOutbox,
  setOutboxDir,
  resetOutboxDir,
  defaultOutboxDir,
  formatSendOk,
  extractMessageId,
  queuedTelegramUnreachable,
  type OutboxHealth,
} from "./outbox";
import { randomCtx } from "./backoff";
import {
  lookupMessage,
  resetMessageCache,
  messageCacheSize,
  MAX_TEXT_CHARS,
} from "./message-cache";
import {
  TelegramClient,
  fetchCtx as clientFetchCtx,
  sleepCtx as clientSleepCtx,
  logCtx as clientLogCtx,
} from "./telegram-client";

// Raise the per-test timeout above MIN_WAIT_BOUND_MS below. bun's default is
// 5s, which would kill a test before its own wait could report WHAT it was
// waiting for — the informative failure has to win that race. This only
// affects how long a hung test takes to fail; passing tests are unaffected,
// since every wait here returns as soon as its predicate holds.
setDefaultTimeout(30_000);

let tmpRoot: string;
let outboxDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "outbox-test-"));
  outboxDir = join(tmpRoot, "outbox");
  setOutboxDir(outboxDir);
  clientSleepCtx.set(async () => { /* fast-forward */ });
  clientLogCtx.set(() => { /* silence */ });
  // The message cache is a module-level singleton shared across the whole
  // process, so one test's sent messages would otherwise be visible to the next.
  resetMessageCache();
});

afterEach(async () => {
  resetOutboxDir();
  resetMessageCache();
  clientFetchCtx.reset();
  clientSleepCtx.reset();
  clientLogCtx.reset();
  randomCtx.reset();
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Drop an item the way the `ib` clients do (`.tmp` + rename). Returns `base`. */
async function drop(base: string, content: string): Promise<string> {
  const { mkdir, rename } = await import("fs/promises");
  await mkdir(outboxDir, { recursive: true });
  const finalPath = join(outboxDir, base);
  await writeFile(`${finalPath}.tmp`, content);
  await rename(`${finalPath}.tmp`, finalPath);
  return base;
}

interface ResultBody {
  ok: boolean;
  message: string;
  queued?: boolean;
}

/** The item's `.result` body, or null when there is none (yet). */
async function readResultFile(base: string): Promise<ResultBody | null> {
  try {
    return JSON.parse(await readFile(join(outboxDir, `${base}.result`), "utf8")) as ResultBody;
  } catch {
    return null;
  }
}

/** Wait for the item's FINAL result (an interim `queued:true` one does not
 *  count) and return it. */
async function waitForFinalResult(base: string): Promise<ResultBody> {
  let result: ResultBody | null = null;
  await waitFor(async () => {
    result = await readResultFile(base);
    return result !== null && result.queued !== true;
  });
  return result!;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function okMessage(messageId: number): Response {
  return jsonResponse(200, { ok: true, result: { message_id: messageId, chat: { id: 0 } } });
}

function badGateway(): Response {
  return jsonResponse(502, { ok: false, error_code: 502, description: "Bad Gateway" });
}

function urlOf(input: Parameters<Parameters<typeof clientFetchCtx.set>[0]>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/** Stall backoff long enough that only `kick()` (or `stop()`) ends a stall
 *  inside a test. */
const KICK_ONLY = { initialMs: 60_000, maxMs: 60_000 };

/** Stall backoff short enough that the timer retries within a test. */
const FAST_STALL = { initialMs: 10, maxMs: 20 };

/** Stub fetch that returns 200 ok for every sendMessage. Captures the bodies. */
function makeOkFetch(captured: Array<{ url: string; body: unknown }>): void {
  clientFetchCtx.set(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    captured.push({ url, body });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 0 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

/**
 * Lower bound on how long any wait below is allowed to run before it gives up.
 *
 * The `timeoutMs` each caller passes is a FAILURE bound, not a wait: waitFor
 * returns the instant `pred()` holds, so a generous bound costs nothing on the
 * passing path — it only decides how long we tolerate before declaring a hang.
 * The per-call values (1-3s) were tuned on an idle machine, and the work here
 * goes through a real fs.watch plus the outbox's own poll cadence, which takes
 * several times longer when the machine is busy. That failed the "text,
 * reaction, and file descriptors all flow through the one outbox" test at its
 * 2s bound during a loaded full-suite run, for machine-speed reasons rather
 * than anything the test asserts. Flooring the bound fixes every wait in this
 * file at once while still catching a genuine hang.
 */
const MIN_WAIT_BOUND_MS = 15_000;

/** Wait until `pred()` returns true or the (floored) bound elapses. Accepts
 *  sync or async predicates. Tight 5ms cadence so tests stay snappy without
 *  spinning — a satisfied predicate still returns in ~5ms. */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const bound = Math.max(timeoutMs, MIN_WAIT_BOUND_MS);
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > bound) {
      throw new Error(`waitFor: timeout after ${bound}ms`);
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

describe("defaultOutboxDir", () => {
  test("respects setOutboxDir override", () => {
    expect(defaultOutboxDir()).toBe(outboxDir);
  });

  test("falls back to ~/.itsybitsy/... when no override", () => {
    resetOutboxDir();
    const dir = defaultOutboxDir();
    expect(dir.endsWith(join(".itsybitsy", "channels", "telegram", "outbox"))).toBe(true);
    setOutboxDir(outboxDir); // restore for afterEach symmetry
  });
});

describe("startup sweep", () => {
  test("processes orphan .txt files left from a previous run", async () => {
    // Pre-seed the dir with an orphan .txt before start().
    const { mkdir } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });
    const stem = `${Date.now()}-aaaaaa`;
    await writeFile(join(outboxDir, `${stem}.txt`), "orphan-message");

    const captured: Array<{ url: string; body: unknown }> = [];
    makeOkFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    await waitFor(() => captured.length >= 1, 2_000);
    expect(captured.length).toBe(1);
    expect((captured[0]!.body as { text: string }).text).toBe("orphan-message");
    expect((captured[0]!.body as { chat_id: string }).chat_id).toBe("555");

    // Result file should be written.
    await waitFor(async () => {
      try {
        const entries = await readdir(outboxDir);
        return entries.some((e) => e.endsWith(".result"));
      } catch {
        return false;
      }
    }, 2_000);

    await outbox.stop();
  });

  test("unlinks stale .tmp and .result files", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, "stale.txt.tmp"), "partial");
    await writeFile(join(outboxDir, "stale.txt.result"), '{"ok":true,"message":"ok"}');
    // Also a chat-id artifact from Phase A — actually that lives in the
    // parent dir, not the outbox dir. But verify the sweep is conservative
    // and only touches .tmp/.result/.txt under outbox dir.

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    // Sweep ran inside start() — verify the .tmp and .result are gone.
    const entries = await readdir(outboxDir);
    expect(entries).not.toContain("stale.txt.tmp");
    expect(entries).not.toContain("stale.txt.result");

    await outbox.stop();
  });
});

describe("file-drop round trip via TelegramOutbox", () => {
  test("a .txt file appearing after start() is sent and produces a .result", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    makeOkFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "777" });
    await outbox.start();

    // Drop a message file the way `tgsend` would: write tmp + rename.
    const stem = `${Date.now()}-bbbbbb`;
    const txtPath = join(outboxDir, `${stem}.txt`);
    const tmpPath = `${txtPath}.tmp`;
    await writeFile(tmpPath, "hello via outbox");
    const { rename } = await import("fs/promises");
    await rename(tmpPath, txtPath);

    await waitFor(() => captured.length >= 1, 2_000);
    expect((captured[0]!.body as { text: string }).text).toBe("hello via outbox");

    // Result file is written and contains ok:true.
    await waitFor(async () => {
      try {
        return (await readdir(outboxDir)).some((e) => e === `${stem}.txt.result`);
      } catch {
        return false;
      }
    }, 2_000);
    // The result echoes the Telegram message id (makeOkFetch returns 1) so
    // `ib tgsend` can print it — the coordinator needs the id in its own
    // history to correlate a later reaction.
    const resultText = await readFile(join(outboxDir, `${stem}.txt.result`), "utf8");
    expect(JSON.parse(resultText)).toEqual({ ok: true, message: "ok (message_id 1)" });

    await outbox.stop();
  });

  test("empty message produces ok:false 'empty message' result", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    makeOkFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "777" });
    await outbox.start();

    const stem = `${Date.now()}-cccccc`;
    const txtPath = join(outboxDir, `${stem}.txt`);
    await writeFile(`${txtPath}.tmp`, "   \n");
    const { rename } = await import("fs/promises");
    await rename(`${txtPath}.tmp`, txtPath);

    await waitFor(async () => {
      try {
        return (await readdir(outboxDir)).some((e) => e === `${stem}.txt.result`);
      } catch {
        return false;
      }
    }, 2_000);
    const resultText = await readFile(join(outboxDir, `${stem}.txt.result`), "utf8");
    expect(JSON.parse(resultText)).toEqual({ ok: false, message: "empty message" });
    expect(captured).toEqual([]); // never hit the wire

    await outbox.stop();
  });
});

/* ------------------------------------------------------------------ */
/*  Half A: the result echoes the Telegram message id(s)               */
/* ------------------------------------------------------------------ */

describe("formatSendOk", () => {
  test("single part with an id", () => {
    expect(formatSendOk(1, [1584])).toBe("ok (message_id 1584)");
  });

  test("multi part with all ids uses the plural label", () => {
    expect(formatSendOk(3, [1584, 1585, 1586])).toBe("ok (3 parts, message_ids 1584, 1585, 1586)");
  });

  test("no ids degrades to exactly the pre-feature shapes", () => {
    expect(formatSendOk(1, [])).toBe("ok");
    expect(formatSendOk(3, [])).toBe("ok (3 parts)");
  });

  test("partial ids report honestly, with the label keyed on the id count", () => {
    // A 3-part send where only one chunk's id came back: singular label, one id.
    expect(formatSendOk(3, [1584])).toBe("ok (3 parts, message_id 1584)");
    expect(formatSendOk(3, [1584, 1586])).toBe("ok (3 parts, message_ids 1584, 1586)");
  });
});

describe("extractMessageId", () => {
  test("pulls a positive integer message_id", () => {
    expect(extractMessageId({ message_id: 1584 })).toBe(1584);
  });

  test("returns null for an absent, non-numeric, or non-positive message_id", () => {
    // `{}` is the shape the client can genuinely produce: it does
    // `raw.body.result ?? {}`, so a 2xx {ok:true} body with no result yields an
    // empty object despite the TelegramMessage static type. The rest are
    // defensive — not reachable through TelegramClient today, asserted so a
    // future caller can't reintroduce the crash.
    expect(extractMessageId({})).toBeNull();
    expect(extractMessageId(null)).toBeNull();
    expect(extractMessageId(undefined)).toBeNull();
    expect(extractMessageId("nope")).toBeNull();
    expect(extractMessageId({ message_id: "1584" })).toBeNull();
    expect(extractMessageId({ message_id: 0 })).toBeNull();
    expect(extractMessageId({ message_id: -1 })).toBeNull();
    expect(extractMessageId({ message_id: NaN })).toBeNull();
  });
});

describe("outbound message ids reach the result and the cache", () => {
  /** Fetch stub returning an incrementing message_id per sendMessage call. */
  function makeIdFetch(startId: number, captured: Array<{ text: string }> = []): () => number {
    let next = startId;
    clientFetchCtx.set(async (_input, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      captured.push({ text: (body as { text: string })?.text ?? "" });
      const id = next++;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: id, chat: { id: 0 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    return () => next;
  }

  /** Drop a `.txt` the way `tgsend` does and return the parsed FINAL result
   *  body (a retried send first writes an interim `queued:true` result). */
  async function dropAndRead(stem: string, text: string): Promise<ResultBody> {
    return waitForFinalResult(await drop(`${stem}.txt`, text));
  }

  test("a single-chunk send echoes its id and caches its text", async () => {
    makeIdFetch(1584);
    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "900" });
    await outbox.start();

    const result = await dropAndRead(`${Date.now()}-aaa111`, "Ready to merge?");
    expect(result).toEqual({ ok: true, message: "ok (message_id 1584)" });

    const cached = lookupMessage("900", 1584);
    expect(cached).not.toBeNull();
    expect(cached!.text).toBe("Ready to merge?");
    expect(cached!.direction).toBe("out");

    await outbox.stop();
  });

  test("a chunked send echoes every id and caches EACH chunk's own text", async () => {
    // Two chunks: the user reacts to a specific one, so the preview must be
    // that chunk's text — not the whole message, not the first chunk.
    const captured: Array<{ text: string }> = [];
    makeIdFetch(200, captured);
    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "900" });
    await outbox.start();

    const { TELEGRAM_CHUNK_LIMIT } = await import("./telegram-client");
    const partA = "A".repeat(TELEGRAM_CHUNK_LIMIT);
    const partB = "B".repeat(50);
    const result = await dropAndRead(`${Date.now()}-bbb222`, partA + partB);

    expect(captured.length).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("ok (2 parts, message_ids 200, 201)");

    // `.slice` is a valid oracle here ONLY because these chunks are pure ASCII
    // (one code unit per code point). It is not the cap's semantics — see the
    // astral cases in message-cache.test.ts.
    expect(lookupMessage("900", 200)!.text).toBe(captured[0]!.text.slice(0, MAX_TEXT_CHARS));
    expect(lookupMessage("900", 201)!.text).toBe(captured[1]!.text.slice(0, MAX_TEXT_CHARS));
    // Distinct chunks really did produce distinct cached text.
    expect(lookupMessage("900", 200)!.text.startsWith("A")).toBe(true);
    expect(lookupMessage("900", 201)!.text.startsWith("B")).toBe(true);

    await outbox.stop();
  });

  test("an id delivered only by the post-429 retry is still captured", async () => {
    // The retry path is a separate call site and easy to miss — a chunk that
    // needed a retry would otherwise vanish from both the echo and the cache.
    let call = 0;
    clientFetchCtx.set(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests" }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 4242, chat: { id: 0 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "900" });
    await outbox.start();

    const result = await dropAndRead(`${Date.now()}-ccc333`, "retried text");
    expect(call).toBe(2); // really did go through the retry
    expect(result).toEqual({ ok: true, message: "ok (message_id 4242)" });
    expect(lookupMessage("900", 4242)!.text).toBe("retried text");

    await outbox.stop();
  });

  test("a 2xx body with no result still succeeds, with the pre-feature message", async () => {
    // The client turns a missing `result` into {}, so message_id is absent at
    // runtime. The send landed; we just can't name it. Never invent an id.
    clientFetchCtx.set(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "900" });
    await outbox.start();

    const result = await dropAndRead(`${Date.now()}-ddd444`, "no id available");
    expect(result).toEqual({ ok: true, message: "ok" });
    expect(messageCacheSize()).toBe(0);

    await outbox.stop();
  });

  test("a failed send caches nothing and reports the failure unchanged", async () => {
    clientFetchCtx.set(async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "900" });
    await outbox.start();

    const result = await dropAndRead(`${Date.now()}-eee555`, "doomed");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("sendMessage failed: Bad Request");
    expect(messageCacheSize()).toBe(0);

    await outbox.stop();
  });

  // Checks the CAP is applied on the outbound path. It does NOT check the
  // retention property that motivates the cap — whether the stored string is a
  // copy or a view onto the payload is not observable from JS. See the note in
  // message-cache.test.ts.
  test("the cached text is capped on the send path", async () => {
    makeIdFetch(7000);
    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "900" });
    await outbox.start();

    await dropAndRead(`${Date.now()}-fff666`, "q".repeat(1_000));
    // Code points — the cap's actual unit. Equal to `.length` only because this
    // payload is ASCII.
    expect(Array.from(lookupMessage("900", 7000)!.text).length).toBe(MAX_TEXT_CHARS);

    await outbox.stop();
  });
});

describe("outbox queue serializes back-to-back drops", () => {
  test("two .txt files dropped in quick succession hit the client in order", async () => {
    const captured: Array<{ text: string }> = [];

    // A delayed fetch so we can observe ordering: each call resolves after
    // a short timeout. If the queue did NOT serialize, the second send
    // could complete before the first.
    let firstResolved = false;
    clientFetchCtx.set(async (_input, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      captured.push({ text: (body as { text: string }).text });
      // First call: sleep 50ms before resolving. Second call: sleep 5ms.
      // If the queue is serialized, captured[] reflects insertion order.
      const isFirst = !firstResolved;
      firstResolved = true;
      await new Promise<void>((r) => setTimeout(r, isFirst ? 50 : 5));
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 0 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "777" });
    await outbox.start();

    const { rename } = await import("fs/promises");
    const stem1 = `${Date.now()}-dddddd`;
    const stem2 = `${Date.now() + 1}-eeeeee`;
    await writeFile(join(outboxDir, `${stem1}.txt.tmp`), "first");
    await rename(join(outboxDir, `${stem1}.txt.tmp`), join(outboxDir, `${stem1}.txt`));
    await writeFile(join(outboxDir, `${stem2}.txt.tmp`), "second");
    await rename(join(outboxDir, `${stem2}.txt.tmp`), join(outboxDir, `${stem2}.txt`));

    await waitFor(() => captured.length >= 2, 3_000);
    expect(captured.map((c) => c.text)).toEqual(["first", "second"]);

    await outbox.stop();
  });
});

describe("stop() cancels pending cleanup timeouts and unlinks immediately", () => {
  test("after stop(), the .txt and .result are gone and no late timer fires", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    makeOkFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "777" });
    await outbox.start();

    const { rename } = await import("fs/promises");
    const stem = `${Date.now()}-ffffff`;
    await writeFile(join(outboxDir, `${stem}.txt.tmp`), "bye");
    await rename(join(outboxDir, `${stem}.txt.tmp`), join(outboxDir, `${stem}.txt`));

    // Wait for the .result to appear so we know the cleanup timer was scheduled.
    await waitFor(async () => {
      try {
        return (await readdir(outboxDir)).some((e) => e === `${stem}.txt.result`);
      } catch {
        return false;
      }
    }, 2_000);

    // stop() should clear the pending 5s timer and unlink both files immediately.
    await outbox.stop();

    const entries = await readdir(outboxDir).catch(() => [] as string[]);
    expect(entries).not.toContain(`${stem}.txt`);
    expect(entries).not.toContain(`${stem}.txt.result`);
  });
});

// These four tests replace the pre-retry "edge-transition logging" tests,
// which pinned a transient failure (HTTP 500, a fetch throw, a timeout) as an
// `ok:false` result. A transient failure now keeps the item and stalls the
// queue, so the logging contract is "one stall line per streak, one recovery
// line", and the token-safety checks moved onto the stall line, the interim
// result and the health label.
describe("outbox logging for transient failures", () => {
  test("a stall streak logs one 'send stalled' line and one 'send recovered' line", async () => {
    // 9 failed attempts = 3 rounds of INLINE_ATTEMPTS (3 stall retries), then
    // success. The timer drives the retries (FAST_STALL).
    let calls = 0;
    clientFetchCtx.set(async () => {
      calls += 1;
      return calls <= 9
        ? jsonResponse(500, { ok: false, error_code: 500, description: "boom" })
        : okMessage(42);
    });

    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "777",
      log: (line) => logs.push(line),
      stallBackoff: FAST_STALL,
    });
    await outbox.start();

    const base = await drop(`${Date.now()}-aa1111.txt`, "msg1");
    expect(await waitForFinalResult(base)).toEqual({ ok: true, message: "ok (message_id 42)" });
    expect(calls).toBe(10);

    expect(logs.filter((l) => l.startsWith("telegram outbox: send stalled (")).length).toBe(1);
    expect(logs.filter((l) => l.startsWith("telegram outbox: send recovered")).length).toBe(1);
    expect(logs).toContain("telegram outbox: send recovered after 3 stalled retries");
    // The inline retries of a healthy queue log; the stall retries do not.
    expect(logs.filter((l) => l.includes("; retrying (attempt")).length).toBe(2);
    expect(outbox.getHealth().stalled).toBe(false);

    await outbox.stop();
  });

  test("a hung sendMessage (TimeoutError) keeps the item queued and never leaks the bot token", async () => {
    // A dead TCP socket on outbound: fetch rejects with TimeoutError (what
    // AbortSignal.timeout produces). The item must stay on disk, stalled, not
    // fail — and the token in err.message must not reach any output.
    clientFetchCtx.set((async () => {
      throw new DOMException(
        "fetch https://api.telegram.org/botSECRET_TOKEN_OUTBOX_TIMEOUT/sendMessage timed out",
        "TimeoutError",
      );
    }) as Parameters<typeof clientFetchCtx.set>[0]);

    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "SECRET_TOKEN_OUTBOX_TIMEOUT" }),
      chatId: "777",
      log: (line) => logs.push(line),
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    const base = await drop(`${Date.now()}-tt1111.txt`, "hung-socket");
    await waitFor(() => outbox.getHealth().stalled);

    const interim = await readResultFile(base);
    expect(interim!.ok).toBe(true);
    expect(interim!.queued).toBe(true);
    expect(interim!.message.startsWith("queued: Telegram is unreachable (")).toBe(true);
    expect((await readdir(outboxDir))).toContain(base);

    const health = outbox.getHealth();
    for (const text of [interim!.message, health.lastError ?? "", ...logs]) {
      expect(text.includes("SECRET_TOKEN_OUTBOX_TIMEOUT")).toBe(false);
    }
    expect(logs.some((l) => l.startsWith("telegram outbox: send stalled (sendMessage failed:"))).toBe(true);

    await outbox.stop();
  });

  test("the stall log line never embeds the bot token (token-safety regression)", async () => {
    clientFetchCtx.set((async () => {
      throw new Error(
        "request to https://api.telegram.org/botSECRET_TOKEN_OUTBOX_LOG/sendMessage failed",
      );
    }) as Parameters<typeof clientFetchCtx.set>[0]);

    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "SECRET_TOKEN_OUTBOX_LOG" }),
      chatId: "777",
      log: (line) => logs.push(line),
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    await drop(`${Date.now()}-zz1111.txt`, "msg");
    await waitFor(() => outbox.getHealth().stalled);

    const stallLine = logs.find((l) => l.startsWith("telegram outbox: send stalled ("));
    expect(stallLine).toBeDefined();
    expect(stallLine!.includes("SECRET_TOKEN_OUTBOX_LOG")).toBe(false);
    expect(logs.some((l) => l.includes("SECRET_TOKEN_OUTBOX_LOG"))).toBe(false);
    expect((outbox.getHealth().lastError ?? "").includes("SECRET_TOKEN_OUTBOX_LOG")).toBe(false);

    await outbox.stop();
  });

  test("a permanent failure logs its own line and does not stall", async () => {
    clientFetchCtx.set(async () =>
      jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    );
    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "777",
      log: (line) => logs.push(line),
    });
    await outbox.start();

    const base = await drop(`${Date.now()}-pp1111.txt`, "msg");
    await waitForFinalResult(base);
    expect(logs).toContain(
      "telegram outbox: 3 chars -> chat 777: failed (sendMessage failed: Bad Request: chat not found)",
    );
    expect(logs.some((l) => l.includes("send stalled"))).toBe(false);

    await outbox.stop();
  });
});

describe("reaction descriptors (.react.json)", () => {
  /** Stub fetch that returns 200 ok=true for setMessageReaction and captures
   *  the request bodies + URLs. */
  function makeReactionFetch(captured: Array<{ url: string; body: unknown }>): void {
    clientFetchCtx.set(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? JSON.parse(init.body as string) : null;
      captured.push({ url, body });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  test("drops a reaction → calls setMessageReaction with the emoji array", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });

    const captured: Array<{ url: string; body: unknown }> = [];
    makeReactionFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    // Atomic drop: .tmp then rename to .react.json.
    const stem = `${Date.now()}-bbbbbb`;
    const finalPath = join(outboxDir, `${stem}.react.json`);
    await writeFile(`${finalPath}.tmp`, JSON.stringify({ message_id: 77, emoji: "👍" }));
    await rename(`${finalPath}.tmp`, finalPath);

    await waitFor(() => captured.length >= 1, 2_000);
    expect(captured[0]!.url).toContain("/setMessageReaction");
    const body = captured[0]!.body as { chat_id: string; message_id: number; reaction: unknown };
    expect(body.chat_id).toBe("555");
    expect(body.message_id).toBe(77);
    expect(body.reaction).toEqual([{ type: "emoji", emoji: "👍" }]);

    await outbox.stop();
  });

  test("emoji null clears the reaction (empty array)", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });

    const captured: Array<{ url: string; body: unknown }> = [];
    makeReactionFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const stem = `${Date.now()}-cccccc`;
    const finalPath = join(outboxDir, `${stem}.react.json`);
    await writeFile(`${finalPath}.tmp`, JSON.stringify({ message_id: 5, emoji: null }));
    await rename(`${finalPath}.tmp`, finalPath);

    await waitFor(() => captured.length >= 1, 2_000);
    const body = captured[0]!.body as { reaction: unknown };
    expect(body.reaction).toEqual([]);

    await outbox.stop();
  });

  test("writes an ok result file the sender can read", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });

    const captured: Array<{ url: string; body: unknown }> = [];
    makeReactionFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const stem = `${Date.now()}-dddddd`;
    const finalPath = join(outboxDir, `${stem}.react.json`);
    await writeFile(`${finalPath}.tmp`, JSON.stringify({ message_id: 9, emoji: "🔥" }));
    await rename(`${finalPath}.tmp`, finalPath);

    let resultText = "";
    await waitFor(async () => {
      try {
        resultText = await readFile(`${finalPath}.result`, "utf8");
        return true;
      } catch {
        return false;
      }
    }, 2_000);
    const parsed = JSON.parse(resultText) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    await outbox.stop();
  });

  test("a malformed descriptor yields an ok=false result, no API call", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });

    const captured: Array<{ url: string; body: unknown }> = [];
    makeReactionFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const stem = `${Date.now()}-eeeeee`;
    const finalPath = join(outboxDir, `${stem}.react.json`);
    await writeFile(`${finalPath}.tmp`, "{not valid json");
    await rename(`${finalPath}.tmp`, finalPath);

    let resultText = "";
    await waitFor(async () => {
      try {
        resultText = await readFile(`${finalPath}.result`, "utf8");
        return true;
      } catch {
        return false;
      }
    }, 2_000);
    const parsed = JSON.parse(resultText) as { ok: boolean; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain("bad reaction descriptor");
    // No setMessageReaction call should have been made.
    expect(captured.length).toBe(0);

    await outbox.stop();
  });

  test("a text message and a reaction can both flow through the outbox", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });

    const captured: Array<{ url: string; body: unknown }> = [];
    clientFetchCtx.set(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? JSON.parse(init.body as string) : null;
      captured.push({ url, body });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const base = `${Date.now()}`;
    const txtPath = join(outboxDir, `${base}-ffffff.txt`);
    await writeFile(`${txtPath}.tmp`, "hello");
    await rename(`${txtPath}.tmp`, txtPath);

    const reactPath = join(outboxDir, `${base}-gggggg.react.json`);
    await writeFile(`${reactPath}.tmp`, JSON.stringify({ message_id: 3, emoji: "🎉" }));
    await rename(`${reactPath}.tmp`, reactPath);

    await waitFor(() => captured.length >= 2, 2_000);
    expect(captured.some((c) => c.url.includes("/sendMessage"))).toBe(true);
    expect(captured.some((c) => c.url.includes("/setMessageReaction"))).toBe(true);

    await outbox.stop();
  });
});

describe("file descriptors (.file.json)", () => {
  /** Stub fetch that returns 200 ok=true for sendPhoto/sendDocument and
   *  captures the request URLs + (multipart) bodies. */
  function makeFileFetch(captured: Array<{ url: string; form: FormData | null }>): void {
    clientFetchCtx.set(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const form = init?.body instanceof FormData ? init.body : null;
      captured.push({ url, form });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 0 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  /** Write a small temp file the outbox can upload, return its absolute path. */
  async function makeTempFile(bytes: Uint8Array): Promise<string> {
    const { join } = await import("path");
    const p = join(tmpRoot, `payload-${Math.round(bytes.byteLength)}.bin`);
    await Bun.write(p, bytes);
    return p;
  }

  test("drops a document descriptor → calls sendDocument with the file + caption", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });
    const filePath = await makeTempFile(new Uint8Array([1, 2, 3, 4]));

    const captured: Array<{ url: string; form: FormData | null }> = [];
    makeFileFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const stem = `${Date.now()}-hhhhhh`;
    const finalPath = join(outboxDir, `${stem}.file.json`);
    await writeFile(`${finalPath}.tmp`, JSON.stringify({ path: filePath, kind: "document", caption: "a diff" }));
    await rename(`${finalPath}.tmp`, finalPath);

    await waitFor(() => captured.length >= 1, 2_000);
    expect(captured[0]!.url).toContain("/sendDocument");
    const form = captured[0]!.form!;
    expect(form.get("chat_id")).toBe("555");
    expect(form.get("caption")).toBe("a diff");
    expect(form.get("document")).toBeInstanceOf(Blob);

    await outbox.stop();
  });

  test("kind=photo calls sendPhoto", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });
    const filePath = await makeTempFile(new Uint8Array([5, 6, 7]));

    const captured: Array<{ url: string; form: FormData | null }> = [];
    makeFileFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const stem = `${Date.now()}-iiiiii`;
    const finalPath = join(outboxDir, `${stem}.file.json`);
    await writeFile(`${finalPath}.tmp`, JSON.stringify({ path: filePath, kind: "photo" }));
    await rename(`${finalPath}.tmp`, finalPath);

    await waitFor(() => captured.length >= 1, 2_000);
    expect(captured[0]!.url).toContain("/sendPhoto");
    expect(captured[0]!.form!.get("photo")).toBeInstanceOf(Blob);

    await outbox.stop();
  });

  test("writes an ok result file the sender can read", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });
    const filePath = await makeTempFile(new Uint8Array([1]));

    const captured: Array<{ url: string; form: FormData | null }> = [];
    makeFileFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const stem = `${Date.now()}-jjjjjj`;
    const finalPath = join(outboxDir, `${stem}.file.json`);
    await writeFile(`${finalPath}.tmp`, JSON.stringify({ path: filePath, kind: "document" }));
    await rename(`${finalPath}.tmp`, finalPath);

    let resultText = "";
    await waitFor(async () => {
      try {
        resultText = await readFile(`${finalPath}.result`, "utf8");
        return true;
      } catch {
        return false;
      }
    }, 2_000);
    expect((JSON.parse(resultText) as { ok: boolean }).ok).toBe(true);

    await outbox.stop();
  });

  test("a missing file yields ok=false with a clear message, no API call", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });

    const captured: Array<{ url: string; form: FormData | null }> = [];
    makeFileFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const stem = `${Date.now()}-kkkkkk`;
    const finalPath = join(outboxDir, `${stem}.file.json`);
    await writeFile(`${finalPath}.tmp`, JSON.stringify({ path: "/no/such/file.png", kind: "document" }));
    await rename(`${finalPath}.tmp`, finalPath);

    let resultText = "";
    await waitFor(async () => {
      try {
        resultText = await readFile(`${finalPath}.result`, "utf8");
        return true;
      } catch {
        return false;
      }
    }, 2_000);
    const parsed = JSON.parse(resultText) as { ok: boolean; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain("file not found");
    expect(captured.length).toBe(0); // never hit the API

    await outbox.stop();
  });

  test("a malformed descriptor yields ok=false, no API call", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });

    const captured: Array<{ url: string; form: FormData | null }> = [];
    makeFileFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const stem = `${Date.now()}-llllll`;
    const finalPath = join(outboxDir, `${stem}.file.json`);
    await writeFile(`${finalPath}.tmp`, "{not json");
    await rename(`${finalPath}.tmp`, finalPath);

    let resultText = "";
    await waitFor(async () => {
      try {
        resultText = await readFile(`${finalPath}.result`, "utf8");
        return true;
      } catch {
        return false;
      }
    }, 2_000);
    const parsed = JSON.parse(resultText) as { ok: boolean; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain("bad file descriptor");
    expect(captured.length).toBe(0);

    await outbox.stop();
  });

  test("an oversized photo is rejected locally before any API call", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });
    // 11 MB > the ~10 MB sendPhoto cap.
    const filePath = await makeTempFile(new Uint8Array(11 * 1024 * 1024));

    const captured: Array<{ url: string; form: FormData | null }> = [];
    makeFileFetch(captured);

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const stem = `${Date.now()}-mmmmmm`;
    const finalPath = join(outboxDir, `${stem}.file.json`);
    await writeFile(`${finalPath}.tmp`, JSON.stringify({ path: filePath, kind: "photo" }));
    await rename(`${finalPath}.tmp`, finalPath);

    let resultText = "";
    await waitFor(async () => {
      try {
        resultText = await readFile(`${finalPath}.result`, "utf8");
        return true;
      } catch {
        return false;
      }
    }, 2_000);
    const parsed = JSON.parse(resultText) as { ok: boolean; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain("too large for photo");
    expect(captured.length).toBe(0);

    await outbox.stop();
  });

  test("text, reaction, and file descriptors all flow through the one outbox", async () => {
    const { mkdir, rename } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });
    const filePath = await makeTempFile(new Uint8Array([1, 2]));

    const captured: Array<{ url: string }> = [];
    clientFetchCtx.set(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      captured.push({ url });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 0 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({ client, chatId: "555" });
    await outbox.start();

    const base = `${Date.now()}`;
    const txtPath = join(outboxDir, `${base}-aaa111.txt`);
    await writeFile(`${txtPath}.tmp`, "hi");
    await rename(`${txtPath}.tmp`, txtPath);

    const reactPath = join(outboxDir, `${base}-bbb222.react.json`);
    await writeFile(`${reactPath}.tmp`, JSON.stringify({ message_id: 3, emoji: "🎉" }));
    await rename(`${reactPath}.tmp`, reactPath);

    const filePathDesc = join(outboxDir, `${base}-ccc333.file.json`);
    await writeFile(`${filePathDesc}.tmp`, JSON.stringify({ path: filePath, kind: "document" }));
    await rename(`${filePathDesc}.tmp`, filePathDesc);

    await waitFor(() => captured.length >= 3, 2_000);
    expect(captured.some((c) => c.url.includes("/sendMessage"))).toBe(true);
    expect(captured.some((c) => c.url.includes("/setMessageReaction"))).toBe(true);
    expect(captured.some((c) => c.url.includes("/sendDocument"))).toBe(true);

    await outbox.stop();
  });
});

/* ------------------------------------------------------------------ */
/*  Reliable delivery: inline retry, stall + hold, progress, health    */
/* ------------------------------------------------------------------ */

describe("transient failures are retried inline", () => {
  test("a 5xx burst then success delivers once and reports ok", async () => {
    // Two 502s (the 2026-11-20 watch.log burst), then success. The waits come
    // from backoffDelayMs with jitter pinned: ~1s, then ~2s.
    randomCtx.set(() => 0);
    const sleeps: number[] = [];
    clientSleepCtx.set(async (ms) => {
      sleeps.push(ms);
    });
    const texts: string[] = [];
    clientFetchCtx.set(async (_input, init) => {
      texts.push((JSON.parse(init!.body as string) as { text: string }).text);
      return texts.length <= 2 ? badGateway() : okMessage(77);
    });

    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      log: (line) => logs.push(line),
    });
    await outbox.start();

    const base = await drop(`${Date.now()}-a00001.txt`, "burst");
    expect(await waitForFinalResult(base)).toEqual({ ok: true, message: "ok (message_id 77)" });
    expect(texts).toEqual(["burst", "burst", "burst"]);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(outbox.getHealth().stalled).toBe(false);
    expect(logs.some((l) => l.includes("send stalled"))).toBe(false);

    await outbox.stop();
  });

  test("a 429 waits at least the server's retry_after", async () => {
    randomCtx.set(() => 0);
    const sleeps: number[] = [];
    clientSleepCtx.set(async (ms) => {
      sleeps.push(ms);
    });
    let calls = 0;
    clientFetchCtx.set(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(
            429,
            { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" },
            { "retry-after": "5" },
          )
        : okMessage(8);
    });

    const outbox = new TelegramOutbox({ client: new TelegramClient({ token: "T" }), chatId: "1" });
    await outbox.start();

    const base = await drop(`${Date.now()}-a00002.txt`, "slow down");
    expect(await waitForFinalResult(base)).toEqual({ ok: true, message: "ok (message_id 8)" });
    // max(retry_after 5s, backoff 1s).
    expect(sleeps).toEqual([5_000]);
    expect(calls).toBe(2);

    await outbox.stop();
  });

  test("a fast network throw (refused connection) then success delivers once", async () => {
    // A fast failure. A HUNG request (the watch.log `errno:23` lines, really
    // a timeout) is covered against a real server in
    // outbox-fake-telegram.test.ts.
    let calls = 0;
    clientFetchCtx.set((async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
      return okMessage(9);
    }) as Parameters<typeof clientFetchCtx.set>[0]);

    const outbox = new TelegramOutbox({ client: new TelegramClient({ token: "T" }), chatId: "1" });
    await outbox.start();

    const base = await drop(`${Date.now()}-a00003.txt`, "after a refused connection");
    expect(await waitForFinalResult(base)).toEqual({ ok: true, message: "ok (message_id 9)" });
    expect(calls).toBe(2);

    await outbox.stop();
  });

  test("a reaction and a file retry a transient failure the same way", async () => {
    const counts = { react: 0, doc: 0 };
    clientFetchCtx.set((async (input: Parameters<Parameters<typeof clientFetchCtx.set>[0]>[0]) => {
      const url = urlOf(input);
      if (url.endsWith("/setMessageReaction")) {
        counts.react += 1;
        return counts.react === 1 ? badGateway() : jsonResponse(200, { ok: true, result: true });
      }
      counts.doc += 1;
      if (counts.doc === 1) throw new TypeError("fetch failed");
      return okMessage(3);
    }) as Parameters<typeof clientFetchCtx.set>[0]);

    const filePath = join(tmpRoot, "doc.bin");
    await Bun.write(filePath, new Uint8Array([1, 2, 3]));
    const outbox = new TelegramOutbox({ client: new TelegramClient({ token: "T" }), chatId: "1" });
    await outbox.start();

    const t = Date.now();
    const react = await drop(`${t}-b00001.react.json`, JSON.stringify({ message_id: 5, emoji: "👍" }));
    const file = await drop(`${t + 1}-b00002.file.json`, JSON.stringify({ path: filePath, kind: "document" }));
    expect(await waitForFinalResult(react)).toEqual({ ok: true, message: "ok" });
    expect(await waitForFinalResult(file)).toEqual({ ok: true, message: "ok" });
    expect(counts).toEqual({ react: 2, doc: 2 });

    await outbox.stop();
  });

  test("a permanent 400 is not retried", async () => {
    const sleeps: number[] = [];
    clientSleepCtx.set(async (ms) => {
      sleeps.push(ms);
    });
    let calls = 0;
    clientFetchCtx.set(async () => {
      calls += 1;
      return jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
    });

    const outbox = new TelegramOutbox({ client: new TelegramClient({ token: "T" }), chatId: "1" });
    await outbox.start();

    const base = await drop(`${Date.now()}-a00004.txt`, "doomed");
    expect(await waitForFinalResult(base)).toEqual({
      ok: false,
      message: "sendMessage failed: Bad Request: chat not found",
    });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(outbox.getHealth()).toEqual({ pending: 0, stalled: false, lastError: null, lastErrorAt: null });

    await outbox.stop();
  });
});

describe("exhausted retries keep the item and hold the queue", () => {
  /** Fetch stub that answers 502 while `state.down`, otherwise delivers.
   *  Records every attempt and every delivery as `text:<t>`, `react:<id>` or
   *  `file`. */
  function makeOutage(state: { down: boolean }, attempts: string[], delivered: string[]): void {
    clientFetchCtx.set((async (
      input: Parameters<Parameters<typeof clientFetchCtx.set>[0]>[0],
      init?: RequestInit,
    ) => {
      const url = urlOf(input);
      let label: string;
      if (url.endsWith("/sendMessage")) {
        label = `text:${(JSON.parse(init!.body as string) as { text: string }).text}`;
      } else if (url.endsWith("/setMessageReaction")) {
        label = `react:${(JSON.parse(init!.body as string) as { message_id: number }).message_id}`;
      } else {
        label = "file";
      }
      attempts.push(label);
      if (state.down) return badGateway();
      delivered.push(label);
      return okMessage(delivered.length);
    }) as Parameters<typeof clientFetchCtx.set>[0]);
  }

  test("exhaustion stalls on the head; later items wait; kick() delivers A, B, C in order exactly once", async () => {
    const state = { down: true };
    const attempts: string[] = [];
    const delivered: string[] = [];
    makeOutage(state, attempts, delivered);

    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      log: (line) => logs.push(line),
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    const t = Date.now();
    const a = await drop(`${t}-aaaaaa.txt`, "A");
    await waitFor(() => outbox.getHealth().stalled);
    expect(outbox.getHealth().lastError).toBe("HTTP 502");
    expect(typeof outbox.getHealth().lastErrorAt).toBe("number");
    // The interim result tells a waiting client why it has not gone out.
    expect(await readResultFile(a)).toEqual({
      ok: true,
      queued: true,
      message: queuedTelegramUnreachable("HTTP 502"),
    });

    const filePath = join(tmpRoot, "c.bin");
    await Bun.write(filePath, new Uint8Array([1]));
    const b = await drop(`${t + 1}-bbbbbb.react.json`, JSON.stringify({ message_id: 5, emoji: "👍" }));
    const c = await drop(`${t + 2}-cccccc.file.json`, JSON.stringify({ path: filePath, kind: "document" }));
    await waitFor(() => outbox.getHealth().pending === 3);
    // Give fs.watch and a few safety rescans the chance to (wrongly) send B or C.
    await new Promise<void>((r) => setTimeout(r, 1_200));
    expect(attempts).toEqual(["text:A", "text:A", "text:A"]);
    const entries = await readdir(outboxDir);
    expect(entries).toContain(a);
    expect(entries).toContain(b);
    expect(entries).toContain(c);
    expect(await readResultFile(b)).toBeNull();

    state.down = false;
    outbox.kick();
    expect(await waitForFinalResult(a)).toEqual({ ok: true, message: "ok (message_id 1)" });
    expect(await waitForFinalResult(b)).toEqual({ ok: true, message: "ok" });
    expect(await waitForFinalResult(c)).toEqual({ ok: true, message: "ok" });
    expect(delivered).toEqual(["text:A", "react:5", "file"]);
    expect(outbox.getHealth()).toEqual({ pending: 0, stalled: false, lastError: null, lastErrorAt: null });
    expect(logs.filter((l) => l.includes("send stalled")).length).toBe(1);
    expect(logs.filter((l) => l.includes("send recovered")).length).toBe(1);

    await outbox.stop();
  });

  test("kick() is a no-op while the queue is healthy, and while a 429's retry_after runs", async () => {
    let calls = 0;
    clientFetchCtx.set(async () => {
      calls += 1;
      return jsonResponse(
        429,
        { ok: false, error_code: 429, description: "Too Many Requests: retry after 3600" },
        { "retry-after": "3600" },
      );
    });
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    outbox.kick(); // nothing queued, nothing stalled
    expect(calls).toBe(0);

    await drop(`${Date.now()}-k00001.txt`, "flooded");
    await waitFor(() => outbox.getHealth().stalled);
    // A retry_after above the inline cap stalls after ONE attempt: no inline
    // hour-long sleep that stop() could not cancel.
    expect(calls).toBe(1);
    outbox.kick(); // retry_after (1h) has not passed
    await new Promise<void>((r) => setTimeout(r, 200));
    expect(calls).toBe(1);

    await outbox.stop();
  });

  test("a stalled head that turns permanent fails, and the queue moves on", async () => {
    let mode: "down" | "reject" = "down";
    const texts: string[] = [];
    clientFetchCtx.set(async (_input, init) => {
      const text = (JSON.parse(init!.body as string) as { text: string }).text;
      texts.push(text);
      if (text === "A" && mode === "down") return badGateway();
      if (text === "A") {
        return jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: message is too long" });
      }
      return okMessage(2);
    });
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    const t = Date.now();
    const a = await drop(`${t}-p00001.txt`, "A");
    await waitFor(() => outbox.getHealth().stalled);
    const b = await drop(`${t + 1}-p00002.txt`, "B");
    await waitFor(() => outbox.getHealth().pending === 2);

    mode = "reject";
    outbox.kick();
    expect(await waitForFinalResult(a)).toEqual({
      ok: false,
      message: "sendMessage failed: Bad Request: message is too long",
    });
    expect(await waitForFinalResult(b)).toEqual({ ok: true, message: "ok (message_id 2)" });
    expect(texts).toEqual(["A", "A", "A", "A", "B"]);
    expect(outbox.getHealth().stalled).toBe(false);

    await outbox.stop();
  });

  test("a read error other than ENOENT holds the item (never unlinks it); a retry then sends it", async () => {
    const sent: string[] = [];
    clientFetchCtx.set(async (_input, init) => {
      sent.push((JSON.parse(init!.body as string) as { text: string }).text);
      return okMessage(5);
    });
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      stallBackoff: KICK_ONLY,
    });
    // Unreadable before start(), so the very first read fails with EACCES.
    await mkdir(outboxDir, { recursive: true });
    const base = `${Date.now()}-e00001.txt`;
    const itemPath = join(outboxDir, base);
    await writeFile(itemPath, "hold me");
    await chmod(itemPath, 0o000);
    await outbox.start();

    await waitFor(() => outbox.getHealth().stalled);
    expect(outbox.getHealth()).toMatchObject({ pending: 1, stalled: true, lastError: "outbox read failed (EACCES)" });
    expect(await readdir(outboxDir)).toContain(base);
    expect(await readResultFile(base)).toBeNull();
    expect(sent).toEqual([]);

    await chmod(itemPath, 0o600);
    outbox.kick();
    expect(await waitForFinalResult(base)).toEqual({ ok: true, message: "ok (message_id 5)" });
    expect(sent).toEqual(["hold me"]);

    await outbox.stop();
  });

  test("a stalled head deleted by hand clears the stall (health event); the next item starts a fresh streak", async () => {
    const state = { down: true };
    const attempts: string[] = [];
    const delivered: string[] = [];
    makeOutage(state, attempts, delivered);
    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      log: (line) => logs.push(line),
      stallBackoff: KICK_ONLY,
    });
    const events: OutboxHealth[] = [];
    outbox.onHealthChange((h) => events.push(h));
    await outbox.start();

    const t = Date.now();
    const a = await drop(`${t}-v00001.txt`, "A");
    await waitFor(() => outbox.getHealth().stalled);
    await unlink(join(outboxDir, a));
    outbox.kick();
    await waitFor(() => outbox.getHealth().pending === 0);
    expect(outbox.getHealth()).toEqual({ pending: 0, stalled: false, lastError: null, lastErrorAt: null });
    expect(events.at(-1)).toEqual({ pending: 0, stalled: false, lastError: null, lastErrorAt: null });
    expect(logs).toContain(`telegram outbox: stalled item ${a} left the queue without a Telegram answer; clearing the stall`);

    // A later item is a new streak: its own stall line, and a recovery count
    // that does not carry A's retries over.
    const b = await drop(`${t + 1}-v00002.txt`, "B");
    await waitFor(() => outbox.getHealth().stalled);
    state.down = false;
    outbox.kick();
    expect(await waitForFinalResult(b)).toEqual({ ok: true, message: "ok (message_id 1)" });
    expect(delivered).toEqual(["text:B"]);
    expect(logs.filter((l) => l.includes("send stalled")).length).toBe(2);
    expect(logs).toContain("telegram outbox: send recovered after 1 stalled retry");

    await outbox.stop();
  });

  test("a stalled file whose path is deleted fails permanently and clears the stall", async () => {
    const state = { down: true };
    makeOutage(state, [], []);
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    const filePath = join(tmpRoot, "gone.bin");
    await Bun.write(filePath, new Uint8Array([1]));
    const f = await drop(`${Date.now()}-v00003.file.json`, JSON.stringify({ path: filePath, kind: "document" }));
    await waitFor(() => outbox.getHealth().stalled);
    await unlink(filePath);
    outbox.kick();
    expect(await waitForFinalResult(f)).toEqual({ ok: false, message: `file not found: ${filePath}` });
    await waitFor(() => outbox.getHealth().pending === 0);
    expect(outbox.getHealth()).toEqual({ pending: 0, stalled: false, lastError: null, lastErrorAt: null });

    await outbox.stop();
  });

  test("an upload that times out on every inline attempt fails permanently, and the queue moves on", async () => {
    let docCalls = 0;
    const texts: string[] = [];
    clientFetchCtx.set((async (input: Parameters<Parameters<typeof clientFetchCtx.set>[0]>[0], init?: RequestInit) => {
      if (urlOf(input).endsWith("/sendDocument")) {
        docCalls += 1;
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      texts.push((JSON.parse(init!.body as string) as { text: string }).text);
      return okMessage(6);
    }) as Parameters<typeof clientFetchCtx.set>[0]);
    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      log: (line) => logs.push(line),
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    const filePath = join(tmpRoot, "big.bin");
    await Bun.write(filePath, new Uint8Array([1, 2, 3]));
    const t = Date.now();
    const f = await drop(`${t}-u00001.file.json`, JSON.stringify({ path: filePath, kind: "document" }));
    const after = await drop(`${t + 1}-u00002.txt`, "after the upload");
    expect(await waitForFinalResult(f)).toEqual({
      ok: false,
      message: "sendDocument timed out 3 times (upload too slow?); not retrying",
    });
    expect(await waitForFinalResult(after)).toEqual({ ok: true, message: "ok (message_id 6)" });
    expect(docCalls).toBe(3);
    expect(texts).toEqual(["after the upload"]);
    expect(logs.some((l) => l.includes("send stalled"))).toBe(false);
    expect(outbox.getHealth().stalled).toBe(false);

    await outbox.stop();
  });

  test("an upload whose attempts are not ALL timeouts still stalls", async () => {
    let docCalls = 0;
    clientFetchCtx.set((async () => {
      docCalls += 1;
      if (docCalls === 2) return badGateway();
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as Parameters<typeof clientFetchCtx.set>[0]);
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    const filePath = join(tmpRoot, "flaky.bin");
    await Bun.write(filePath, new Uint8Array([1]));
    const f = await drop(`${Date.now()}-u00003.file.json`, JSON.stringify({ path: filePath, kind: "photo" }));
    await waitFor(() => outbox.getHealth().stalled);
    expect(docCalls).toBe(3);
    expect((await readResultFile(f))?.queued).toBe(true);
    expect(await readdir(outboxDir)).toContain(f);

    await outbox.stop();
  });

  test("stop() during a stall leaves the item on disk with no final result", async () => {
    clientFetchCtx.set(async () => badGateway());
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    const base = await drop(`${Date.now()}-s00001.txt`, "keep me");
    await waitFor(() => outbox.getHealth().stalled);
    await outbox.stop();

    expect(await readdir(outboxDir)).toContain(base);
    expect((await readResultFile(base))?.queued).toBe(true);
  });
});

describe("multi-chunk texts resume from the .progress sidecar", () => {
  /** Fetch stub: a chunk is identified by its first character. Chunks
   *  starting with "B" fail with 502 while `state.failB`. */
  function makeChunkFetch(state: { failB: boolean; nextId: number }, seen: string[]): void {
    clientFetchCtx.set(async (_input, init) => {
      const text = (JSON.parse(init!.body as string) as { text: string }).text;
      seen.push(text[0]!);
      if (text[0] === "B" && state.failB) return badGateway();
      return okMessage(state.nextId++);
    });
  }

  async function twoChunkText(): Promise<string> {
    const { TELEGRAM_CHUNK_LIMIT } = await import("./telegram-client");
    return "A".repeat(TELEGRAM_CHUNK_LIMIT) + "B".repeat(10);
  }

  test("chunk 2 failing after chunk 1 landed does not resend chunk 1", async () => {
    const state = { failB: true, nextId: 10 };
    const seen: string[] = [];
    makeChunkFetch(state, seen);
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      stallBackoff: KICK_ONLY,
    });
    await outbox.start();

    const base = await drop(`${Date.now()}-m00001.txt`, await twoChunkText());
    await waitFor(() => outbox.getHealth().stalled);
    expect(seen).toEqual(["A", "B", "B", "B"]);
    expect(JSON.parse(await readFile(join(outboxDir, `${base}.progress`), "utf8"))).toEqual({
      sent: 1,
      message_ids: [10],
    });

    state.failB = false;
    outbox.kick();
    expect(await waitForFinalResult(base)).toEqual({ ok: true, message: "ok (2 parts, message_ids 10, 11)" });
    expect(seen).toEqual(["A", "B", "B", "B", "B"]);

    // stop() cleans a finished item at once, its .progress included.
    await outbox.stop();
    const entries = await readdir(outboxDir);
    expect(entries).not.toContain(base);
    expect(entries).not.toContain(`${base}.progress`);
  });

  test("a NEW TelegramOutbox (ib watch restart) resumes from the .progress file", async () => {
    const state = { failB: true, nextId: 10 };
    const seen: string[] = [];
    makeChunkFetch(state, seen);
    const first = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      stallBackoff: KICK_ONLY,
    });
    await first.start();
    const base = await drop(`${Date.now()}-m00002.txt`, await twoChunkText());
    await waitFor(() => first.getHealth().stalled);
    await first.stop();
    expect(await readdir(outboxDir)).toContain(`${base}.progress`);

    state.failB = false;
    const logs: string[] = [];
    const second = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      log: (line) => logs.push(line),
    });
    await second.start();
    expect(await waitForFinalResult(base)).toEqual({ ok: true, message: "ok (2 parts, message_ids 10, 11)" });
    expect(seen.filter((c) => c === "A").length).toBe(1);
    expect(logs).toContain(`telegram outbox: resuming ${base} at part 2 of 2`);

    await second.stop();
  });

  test("the startup sweep keeps a .progress beside its item and drops an orphan one", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(outboxDir, { recursive: true });
    const stem = `${Date.now()}-m00003`;
    await writeFile(join(outboxDir, `${stem}.txt`), await twoChunkText());
    await writeFile(join(outboxDir, `${stem}.txt.progress`), JSON.stringify({ sent: 1, message_ids: [500] }));
    await writeFile(join(outboxDir, "1-orphan.txt.progress"), JSON.stringify({ sent: 1, message_ids: [1] }));

    const state = { failB: false, nextId: 501 };
    const seen: string[] = [];
    makeChunkFetch(state, seen);
    const outbox = new TelegramOutbox({ client: new TelegramClient({ token: "T" }), chatId: "1" });
    await outbox.start();
    expect(await readdir(outboxDir)).not.toContain("1-orphan.txt.progress");

    expect(await waitForFinalResult(`${stem}.txt`)).toEqual({
      ok: true,
      message: "ok (2 parts, message_ids 500, 501)",
    });
    expect(seen).toEqual(["B"]);

    await outbox.stop();
  });
});

describe("cleanup race (regression: ENOENT 5s after an ok send)", () => {
  test("a finished item is never re-enqueued, re-read or re-sent after its retention", async () => {
    let calls = 0;
    clientFetchCtx.set(async () => {
      calls += 1;
      return okMessage(calls);
    });
    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      log: (line) => logs.push(line),
    });
    await outbox.start();

    const t = Date.now();
    const bases: string[] = [];
    for (let i = 0; i < 3; i++) bases.push(await drop(`${t + i}-r0000${i}.txt`, `msg ${i}`));
    for (const base of bases) await waitForFinalResult(base);

    // Past the 5s retention, the files are gone; two more safety rescans run.
    await waitFor(async () => (await readdir(outboxDir)).length === 0);
    await new Promise<void>((r) => setTimeout(r, 1_100));

    expect(calls).toBe(3);
    expect(logs.some((l) => l.includes("failed to read"))).toBe(false);
    expect(outbox.getHealth().pending).toBe(0);

    await outbox.stop();
  });

  test("a rescan that overlaps an item's cleanup does not re-enqueue it", async () => {
    // The old bug, driven directly: the cleanup timer forgot the item BEFORE
    // unlinking it, so a rescan whose readdir listed the item re-enqueued it
    // (ENOENT, or a second send if the read won the race). The timer and the
    // rescan are both internal, so start them in the same tick by hand.
    let calls = 0;
    clientFetchCtx.set(async () => {
      calls += 1;
      return okMessage(calls);
    });
    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      log: (line) => logs.push(line),
    });
    const internals = outbox as unknown as {
      rescan(): Promise<void>;
      cleanupItem(base: string): Promise<void>;
    };
    await outbox.start();

    const t = Date.now();
    for (let i = 0; i < 20; i++) {
      const base = await drop(`${t + i}-q${String(i).padStart(5, "0")}.txt`, `msg ${i}`);
      await waitForFinalResult(base);
      const scan = internals.rescan();
      const clean = internals.cleanupItem(base);
      await Promise.all([scan, clean]);
    }
    await new Promise<void>((r) => setTimeout(r, 600)); // let any wrong re-enqueue run

    expect(calls).toBe(20);
    expect(logs.some((l) => l.includes("failed to read"))).toBe(false);
    expect(outbox.getHealth().pending).toBe(0);

    await outbox.stop();
  });
});

describe("a finished item is never sent again", () => {
  test("the item and its .progress are unlinked as soon as the final result is written; only the .result stays", async () => {
    let calls = 0;
    clientFetchCtx.set(async () => {
      calls += 1;
      return okMessage(calls);
    });
    const outbox = new TelegramOutbox({ client: new TelegramClient({ token: "T" }), chatId: "1" });
    await outbox.start();

    const { TELEGRAM_CHUNK_LIMIT } = await import("./telegram-client");
    const base = await drop(`${Date.now()}-f00001.txt`, "A".repeat(TELEGRAM_CHUNK_LIMIT) + "B");
    expect(await waitForFinalResult(base)).toEqual({ ok: true, message: "ok (2 parts, message_ids 1, 2)" });
    // Well inside the 5s retention window.
    const entries = await readdir(outboxDir);
    expect(entries).toContain(`${base}.result`);
    expect(entries).not.toContain(base);
    expect(entries).not.toContain(`${base}.progress`);
    expect(outbox.getHealth().pending).toBe(0);

    await outbox.stop();
  });

  test("a restart over an item with a FINAL .result unlinks it instead of sending it", async () => {
    // The previous run stopped between writing the result and unlinking the
    // item. An interim (queued) result does not count as finished.
    await mkdir(outboxDir, { recursive: true });
    const t = Date.now();
    const done = `${t}-f00002.file.json`;
    const queued = `${t + 1}-f00003.txt`;
    const filePath = join(tmpRoot, "sent-once.bin");
    await Bun.write(filePath, new Uint8Array([1]));
    await writeFile(join(outboxDir, done), JSON.stringify({ path: filePath, kind: "document" }));
    await writeFile(join(outboxDir, `${done}.result`), JSON.stringify({ ok: true, message: "ok" }));
    await writeFile(join(outboxDir, queued), "still queued");
    await writeFile(
      join(outboxDir, `${queued}.result`),
      JSON.stringify({ ok: true, queued: true, message: queuedTelegramUnreachable("HTTP 502") }),
    );

    const urls: string[] = [];
    clientFetchCtx.set((async (input: Parameters<Parameters<typeof clientFetchCtx.set>[0]>[0]) => {
      urls.push(urlOf(input));
      return okMessage(9);
    }) as Parameters<typeof clientFetchCtx.set>[0]);
    const logs: string[] = [];
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      log: (line) => logs.push(line),
    });
    await outbox.start();

    expect(await waitForFinalResult(queued)).toEqual({ ok: true, message: "ok (message_id 9)" });
    expect(urls.length).toBe(1);
    expect(urls[0]!.endsWith("/sendMessage")).toBe(true);
    expect(await readdir(outboxDir)).not.toContain(done);
    expect(logs).toContain(`telegram outbox: ${done} already finished before the restart; not sending it again`);

    await outbox.stop();
  });

  test("stop() cleans up finished items BEFORE it waits for the in-flight request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    clientFetchCtx.set(async () => {
      calls += 1;
      if (calls === 2) await gate; // B hangs until released
      return okMessage(calls);
    });
    const outbox = new TelegramOutbox({ client: new TelegramClient({ token: "T" }), chatId: "1" });
    await outbox.start();

    const t = Date.now();
    const a = await drop(`${t}-f00004.txt`, "A");
    await waitForFinalResult(a);
    const b = await drop(`${t + 1}-f00005.txt`, "B");
    await waitFor(() => calls === 2);

    const stopping = outbox.stop();
    await waitFor(async () => !(await readdir(outboxDir)).includes(`${a}.result`));
    // B is still in flight and still queued on disk.
    expect(await readdir(outboxDir)).toContain(b);
    release();
    await stopping;
  });
});

describe("outbox health API", () => {
  test("pending counts undelivered items (the one in flight included); events fire only on change", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    clientFetchCtx.set(async () => {
      await gate;
      return okMessage(1);
    });
    const outbox = new TelegramOutbox({ client: new TelegramClient({ token: "T" }), chatId: "1" });
    const events: OutboxHealth[] = [];
    const unsubscribe = outbox.onHealthChange((h) => events.push(h));
    await outbox.start();

    const t = Date.now();
    const a = await drop(`${t}-h00001.txt`, "A");
    const b = await drop(`${t + 1}-h00002.txt`, "B");
    await waitFor(() => outbox.getHealth().pending === 2);
    expect(outbox.getHealth()).toEqual({ pending: 2, stalled: false, lastError: null, lastErrorAt: null });

    // A snapshot is a copy.
    const snap = outbox.getHealth();
    snap.pending = 99;
    expect(outbox.getHealth().pending).toBe(2);

    outbox.kick(); // not stalled: no event, no retry
    release();
    await waitForFinalResult(a);
    await waitForFinalResult(b);
    await waitFor(() => outbox.getHealth().pending === 0);
    expect(events.map((e) => e.pending)).toEqual([1, 2, 1, 0]);
    expect(events.every((e) => !e.stalled && e.lastError === null)).toBe(true);

    unsubscribe();
    await waitForFinalResult(await drop(`${t + 2}-h00003.txt`, "C"));
    expect(events.length).toBe(4);

    await outbox.stop();
  });

  test("a stall and its recovery each fire one health change", async () => {
    const state = { down: true };
    clientFetchCtx.set(async () => (state.down ? badGateway() : okMessage(5)));
    const outbox = new TelegramOutbox({
      client: new TelegramClient({ token: "T" }),
      chatId: "1",
      stallBackoff: KICK_ONLY,
    });
    const events: OutboxHealth[] = [];
    outbox.onHealthChange((h) => events.push(h));
    await outbox.start();

    const base = await drop(`${Date.now()}-h00004.txt`, "A");
    await waitFor(() => outbox.getHealth().stalled);
    state.down = false;
    outbox.kick();
    await waitForFinalResult(base);
    await waitFor(() => outbox.getHealth().pending === 0);

    expect(events.map((e) => ({ pending: e.pending, stalled: e.stalled, lastError: e.lastError }))).toEqual([
      { pending: 1, stalled: false, lastError: null },
      { pending: 1, stalled: true, lastError: "HTTP 502" },
      { pending: 1, stalled: false, lastError: null },
      { pending: 0, stalled: false, lastError: null },
    ]);

    await outbox.stop();
  });
});

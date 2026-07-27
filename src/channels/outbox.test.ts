/**
 * Tests for the Phase B Telegram outbox + the file-drop tgsend client.
 *
 * Most paths are exercised against a real `fs.watch` on a tmpdir, with
 * `TelegramClient.fetch` stubbed via the existing `fetchCtx` injection.
 * Tests that need to assert on serialization or timeout-cancellation rely
 * on a fake client we hand-roll inline rather than the real one.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  TelegramOutbox,
  setOutboxDir,
  resetOutboxDir,
  defaultOutboxDir,
  formatSendOk,
  extractMessageId,
} from "./outbox";
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
  await rm(tmpRoot, { recursive: true, force: true });
});

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

/** Wait until `pred()` returns true or `timeoutMs` elapses. Accepts sync or
 *  async predicates. Tight 5ms cadence so tests stay snappy without spinning. */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timeout after ${timeoutMs}ms`);
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

  test("returns null for the shapes the client can actually hand us", () => {
    // TelegramClient does `raw.body.result ?? {}`, so a 2xx {ok:true} body with
    // no result yields {} despite the TelegramMessage static type.
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

  /** Drop a `.txt` the way `tgsend` does and return the parsed result body. */
  async function dropAndRead(stem: string, text: string): Promise<{ ok: boolean; message: string }> {
    const { rename } = await import("fs/promises");
    await writeFile(join(outboxDir, `${stem}.txt.tmp`), text);
    await rename(join(outboxDir, `${stem}.txt.tmp`), join(outboxDir, `${stem}.txt`));
    await waitFor(async () => {
      try {
        return (await readdir(outboxDir)).some((e) => e === `${stem}.txt.result`);
      } catch {
        return false;
      }
    }, 3_000);
    return JSON.parse(await readFile(join(outboxDir, `${stem}.txt.result`), "utf8"));
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

  test("the cached text is capped so a huge message cannot sit in memory", async () => {
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

describe("outbox edge-transition logging for send failures", () => {
  /** Drop a `.txt` file via tmp + rename and wait until the `.result` appears.
   *  Returns the `.result` body so callers can check ok/message. */
  async function dropAndWait(stemSuffix: string, text: string): Promise<{ ok: boolean; message: string }> {
    const stem = `${Date.now()}-${stemSuffix}`;
    const txtPath = join(outboxDir, `${stem}.txt`);
    await writeFile(`${txtPath}.tmp`, text);
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
    return JSON.parse(resultText) as { ok: boolean; message: string };
  }

  test("first failure of a streak does NOT log 'send failed' (baseline-silent); subsequent failures also silent", async () => {
    // All sends return HTTP 500 (non-2xx, not 429 — so no retry).
    let calls = 0;
    clientFetchCtx.set(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ ok: false, error_code: 500, description: "boom" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });

    const logs: string[] = [];
    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({
      client,
      chatId: "777",
      log: (line) => logs.push(line),
    });
    await outbox.start();

    // Three failures in a streak (the first sets the baseline silently,
    // because the first attempt has no prior state to flip from).
    const r1 = await dropAndWait("aa1111", "msg1");
    const r2 = await dropAndWait("aa2222", "msg2");
    const r3 = await dropAndWait("aa3333", "msg3");
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
    expect(calls).toBe(3);

    // Per-message logs always fire ("failed (...)") for each send. We're
    // verifying the *edge-transition* layer — `send failed (...)` (without
    // the chars/chat prefix) fires zero or one time depending on whether
    // the first send establishes the streak silently. Spec: first send
    // sets state without logging; subsequent same-state failures are also
    // silent. So zero edge-transition lines for an all-failure streak.
    const edgeFailLogs = logs.filter((l) => l === "telegram outbox: send failed (sendMessage failed: boom)");
    expect(edgeFailLogs.length).toBe(0);

    await outbox.stop();
  });

  test("success → failure → success transitions log 'send failed' once and 'send recovered' once", async () => {
    // Pattern: ok, fail, fail, ok, ok. Expected log:
    //   ok      (silent first-attempt baseline)
    //   fail    (transition: log "send failed (...)")
    //   fail    (no transition; silent)
    //   ok      (transition: log "send recovered")
    //   ok      (no transition; silent)
    let attempt = 0;
    const responses = [
      { status: 200, body: { ok: true, result: { message_id: 1, chat: { id: 0 } } } },
      { status: 500, body: { ok: false, error_code: 500, description: "bad" } },
      { status: 500, body: { ok: false, error_code: 500, description: "bad" } },
      { status: 200, body: { ok: true, result: { message_id: 2, chat: { id: 0 } } } },
      { status: 200, body: { ok: true, result: { message_id: 3, chat: { id: 0 } } } },
    ];
    clientFetchCtx.set(async () => {
      const resp = responses[attempt]!;
      attempt += 1;
      return new Response(
        JSON.stringify(resp.body),
        { status: resp.status, headers: { "content-type": "application/json" } },
      );
    });

    const logs: string[] = [];
    const client = new TelegramClient({ token: "T" });
    const outbox = new TelegramOutbox({
      client,
      chatId: "777",
      log: (line) => logs.push(line),
    });
    await outbox.start();

    await dropAndWait("bb1111", "first");
    await dropAndWait("bb2222", "second");
    await dropAndWait("bb3333", "third");
    await dropAndWait("bb4444", "fourth");
    await dropAndWait("bb5555", "fifth");

    // Edge-transition lines are exact match — no per-message prefix.
    const failedEdgeLogs = logs.filter((l) => l.startsWith("telegram outbox: send failed (") && !l.includes("chars ->"));
    const recoveredEdgeLogs = logs.filter((l) => l === "telegram outbox: send recovered");
    expect(failedEdgeLogs.length).toBe(1);
    expect(recoveredEdgeLogs.length).toBe(1);

    await outbox.stop();
  });

  test("hung sendMessage (TimeoutError) surfaces as ok:false; never logs the bot token", async () => {
    // Simulate a dead TCP socket on outbound: fetch rejects with TimeoutError
    // (what AbortSignal.timeout actually produces). The outbox should turn
    // that into an `ok: false` result file and a per-message log line —
    // never blocking the queue indefinitely.
    clientFetchCtx.set((async () => {
      // Embed the bot-token URL in the error message so the token-leak
      // assertion below has something to detect if classifyError is bypassed.
      throw new DOMException(
        "fetch https://api.telegram.org/botSECRET_TOKEN_OUTBOX_TIMEOUT/sendMessage timed out",
        "TimeoutError",
      );
    }) as Parameters<typeof clientFetchCtx.set>[0]);

    const logs: string[] = [];
    const client = new TelegramClient({ token: "SECRET_TOKEN_OUTBOX_TIMEOUT" });
    const outbox = new TelegramOutbox({
      client,
      chatId: "777",
      log: (line) => logs.push(line),
    });
    await outbox.start();

    const stem = `${Date.now()}-tt1111`;
    const txtPath = join(outboxDir, `${stem}.txt`);
    await writeFile(`${txtPath}.tmp`, "hung-socket");
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
    const result = JSON.parse(resultText) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    // Token must NEVER appear in any log line or in the result message —
    // this is the regression we care about. classifyError surfaces a
    // bounded label (DOMException's `code` wins, producing `errno:23`),
    // never the raw err.message that would carry the URL.
    expect(result.message.includes("SECRET_TOKEN_OUTBOX_TIMEOUT")).toBe(false);
    expect(logs.some((l) => l.includes("SECRET_TOKEN_OUTBOX_TIMEOUT"))).toBe(false);
    // Should be prefixed with "sendMessage failed:" — the error class label
    // follows but its exact form depends on classifyError's priority order.
    expect(result.message.startsWith("sendMessage failed:")).toBe(true);

    await outbox.stop();
  });

  test("send-failure log line never embeds the bot token (token-safety regression)", async () => {
    // Force two consecutive failures so the edge-transition log line fires.
    let calls = 0;
    clientFetchCtx.set((async () => {
      calls += 1;
      if (calls === 1) {
        // First send: success, baseline.
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 0 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Subsequent sends: throw with token in the message.
      throw new Error(
        "request to https://api.telegram.org/botSECRET_TOKEN_OUTBOX_LOG/sendMessage failed",
      );
    }) as Parameters<typeof clientFetchCtx.set>[0]);

    const logs: string[] = [];
    const client = new TelegramClient({ token: "SECRET_TOKEN_OUTBOX_LOG" });
    const outbox = new TelegramOutbox({
      client,
      chatId: "777",
      log: (line) => logs.push(line),
    });
    await outbox.start();

    const { rename } = await import("fs/promises");
    for (const suffix of ["zz1111", "zz2222"]) {
      const stem = `${Date.now()}-${suffix}`;
      const txtPath = join(outboxDir, `${stem}.txt`);
      await writeFile(`${txtPath}.tmp`, "msg");
      await rename(`${txtPath}.tmp`, txtPath);
      await waitFor(async () => {
        try {
          return (await readdir(outboxDir)).some((e) => e === `${stem}.txt.result`);
        } catch {
          return false;
        }
      }, 2_000);
    }

    // The transition log fires once (success → fail). It must not contain the token.
    const edgeLog = logs.find((l) => l.startsWith("telegram outbox: send failed (") && !l.includes("chars ->"));
    expect(edgeLog).toBeDefined();
    expect(edgeLog!.includes("SECRET_TOKEN_OUTBOX_LOG")).toBe(false);
    // No log line at all should contain the token.
    expect(logs.some((l) => l.includes("SECRET_TOKEN_OUTBOX_LOG"))).toBe(false);

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

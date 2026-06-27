import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  TelegramClient,
  TELEGRAM_API_BASE,
  TELEGRAM_CHUNK_LIMIT,
  chunk,
  fetchCtx,
  sleepCtx,
  logCtx,
} from "./telegram-client";
import type { FetchLike } from "../types";

/** Build a Response object whose `.json()` resolves to `body`, with the
 *  given status and optional headers. */
function makeResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  // Bun's Response treats body=undefined as no-body; serialize so .json() works.
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A queue-driven fetch mock. Each call shifts the next response (or thrower)
 *  off the queue. Call `calls` to see the URLs/inits captured. */
type ResponseProducer = () => Response | Promise<Response>;
interface MockFetch {
  fn: FetchLike;
  enqueue: (producer: ResponseProducer) => void;
  enqueueResponse: (body: unknown, status?: number, headers?: Record<string, string>) => void;
  enqueueError: (err: unknown) => void;
  callCount: () => number;
  lastInit: () => RequestInit | undefined;
  allInits: () => Array<RequestInit | undefined>;
  allUrls: () => string[];
}

function makeMockFetch(): MockFetch {
  const queue: ResponseProducer[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const urls: string[] = [];
  const fn: FetchLike = async (input, init) => {
    inits.push(init);
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const next = queue.shift();
    if (!next) throw new Error("mockFetch: response queue empty");
    return await next();
  };
  return {
    fn,
    enqueue: (p) => queue.push(p),
    enqueueResponse: (body, status, headers) => queue.push(() => makeResponse(body, status, headers)),
    enqueueError: (err) => queue.push(() => { throw err; }),
    callCount: () => inits.length,
    lastInit: () => inits[inits.length - 1],
    allInits: () => inits,
    allUrls: () => urls,
  };
}

describe("chunk", () => {
  test("returns single chunk for short input", () => {
    expect(chunk("hello", 4000)).toEqual(["hello"]);
  });

  test("returns single chunk at exactly the limit", () => {
    const s = "a".repeat(4000);
    expect(chunk(s, 4000)).toEqual([s]);
  });

  test("splits 4500-char input into two chunks at limit 4000", () => {
    const s = "a".repeat(4500);
    const chunks = chunk(s, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(4000);
    expect(chunks[1]!.length).toBe(500);
    expect(chunks.join("")).toBe(s);
  });

  test("splits very long input into many chunks", () => {
    const s = "x".repeat(12_345);
    const chunks = chunk(s, 4000);
    expect(chunks.length).toBe(4);
    expect(chunks[0]!.length).toBe(4000);
    expect(chunks[1]!.length).toBe(4000);
    expect(chunks[2]!.length).toBe(4000);
    expect(chunks[3]!.length).toBe(345);
    expect(chunks.join("")).toBe(s);
  });

  test("default limit is TELEGRAM_CHUNK_LIMIT (4000)", () => {
    expect(TELEGRAM_CHUNK_LIMIT).toBe(4000);
    const s = "a".repeat(4500);
    const chunks = chunk(s);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(4000);
  });

  test("hard cuts — does not look for whitespace boundaries", () => {
    // v1 explicitly drops the `mode` param and never looks for newlines/spaces.
    const s = "abcdefghij";
    expect(chunk(s, 3)).toEqual(["abc", "def", "ghi", "j"]);
  });

  test("throws on non-positive limit", () => {
    expect(() => chunk("x", 0)).toThrow();
    expect(() => chunk("x", -1)).toThrow();
  });
});

describe("TelegramClient construction", () => {
  test("requires a token", () => {
    expect(() => new TelegramClient({ token: "" })).toThrow();
  });

  test("uses the hardcoded base URL by default", () => {
    expect(TELEGRAM_API_BASE).toBe("https://api.telegram.org");
  });
});

describe("getUpdates", () => {
  let mock: MockFetch;
  let sleeps: number[];
  let logs: string[];

  beforeEach(() => {
    mock = makeMockFetch();
    fetchCtx.set(mock.fn);
    sleeps = [];
    sleepCtx.set(async (ms) => {
      sleeps.push(ms);
      // resolve immediately so tests don't actually wait
    });
    logs = [];
    logCtx.set((line) => logs.push(line));
  });

  afterEach(() => {
    fetchCtx.reset();
    sleepCtx.reset();
    logCtx.reset();
  });

  test("happy path returns parsed updates", async () => {
    const updates = [
      { update_id: 1, message: { message_id: 10, chat: { id: 99 }, text: "hi" } },
    ];
    mock.enqueueResponse({ ok: true, result: updates });
    const client = new TelegramClient({ token: "TEST_TOKEN" });

    const result = await client.getUpdates({ offset: 0 });
    expect(result).toEqual(updates);
    expect(mock.callCount()).toBe(1);
  });

  test("uses POST with JSON body and default allowed_updates=['message','message_reaction']", async () => {
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    await client.getUpdates({ offset: 5, timeout: 30, limit: 50 });

    const init = mock.lastInit();
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init?.body as string);
    expect(body.offset).toBe(5);
    expect(body.timeout).toBe(30);
    expect(body.limit).toBe(50);
    // Default now includes message_reaction so the dispatcher learns about
    // inbound reactions (Telegram only delivers them when explicitly listed).
    expect(body.allowed_updates).toEqual(["message", "message_reaction"]);
  });

  test("caller can still override allowed_updates", async () => {
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    await client.getUpdates({ offset: 1, allowed_updates: ["message"] });

    const body = JSON.parse(mock.lastInit()?.body as string);
    expect(body.allowed_updates).toEqual(["message"]);
  });

  test("URL embeds the token but is not logged verbatim on success", async () => {
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "SECRET_TOKEN_123" });

    await client.getUpdates();

    expect(mock.allUrls()[0]).toContain("SECRET_TOKEN_123"); // sanity check on test mock
    // No log line on success
    expect(logs.filter((l) => l.includes("SECRET_TOKEN_123")).length).toBe(0);
  });

  test("429 → sleeps Retry-After then retries", async () => {
    mock.enqueueResponse({ ok: false, error_code: 429, description: "rate limited" }, 429, { "retry-after": "3" });
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    const result = await client.getUpdates();
    expect(result).toEqual([]);
    expect(mock.callCount()).toBe(2);
    expect(sleeps[0]).toBe(3_000);
  });

  test("429 with parameters.retry_after in body (no header) is honored", async () => {
    mock.enqueueResponse(
      { ok: false, error_code: 429, parameters: { retry_after: 7 } },
      429,
    );
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    await client.getUpdates();
    expect(sleeps[0]).toBe(7_000);
  });

  test("409 mid-poll → retries with backoff (does not crash, does not skip-startup)", async () => {
    mock.enqueueResponse({ ok: false, error_code: 409, description: "Conflict" }, 409);
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    const result = await client.getUpdates();
    expect(result).toEqual([]);
    expect(mock.callCount()).toBe(2);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]!).toBeGreaterThan(0);
    expect(sleeps[0]!).toBeLessThanOrEqual(30_000);
    // Should log a warning about the 409
    expect(logs.some((l) => l.includes("409"))).toBe(true);
  });

  test("network throw → backoff, retry, no crash", async () => {
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    const result = await client.getUpdates();
    expect(result).toEqual([]);
    expect(mock.callCount()).toBe(2);
    expect(sleeps.length).toBe(1);
  });

  test("5xx → retries with backoff", async () => {
    mock.enqueueResponse({}, 503);
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    const result = await client.getUpdates();
    expect(result).toEqual([]);
    expect(mock.callCount()).toBe(2);
  });

  test("backoff resets after success: a fresh getUpdates call starts at attempt 1", async () => {
    // First getUpdates: one error then success.
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    await client.getUpdates();
    const firstCallSleeps = sleeps.slice();
    expect(firstCallSleeps.length).toBe(1);

    sleeps.length = 0;

    // Second getUpdates: one error then success again — backoff should be the
    // same magnitude as the first call (i.e., reset between calls).
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueResponse({ ok: true, result: [] });

    await client.getUpdates();
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBe(firstCallSleeps[0]);
  });

  test("AbortController → cancels in-flight fetch within ~1s", async () => {
    const controller = new AbortController();
    const client = new TelegramClient({ token: "T" });

    // Mock fetch that respects the abort signal: rejects with AbortError when
    // the signal fires.
    mock.enqueue(() => new Promise<Response>((_, reject) => {
      // Wire abort listener to reject on signal trigger. The signal is the one
      // passed via init from the client.
      // We need access to the signal — capture via the fetch wrapper.
    }));

    // Override mock with a smarter fetch that hooks the signal.
    fetchCtx.set(((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (sig?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as FetchLike);

    const startedAt = Date.now();
    const promise = client.getUpdates({ signal: controller.signal });

    // Fire abort almost immediately.
    setTimeout(() => controller.abort(), 5);

    await expect(promise).rejects.toThrow();
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1000);
  });

  test("AbortController fires during backoff sleep → rejects without another fetch", async () => {
    const controller = new AbortController();
    const client = new TelegramClient({ token: "T" });

    // First fetch errors, triggering the backoff sleep. The sleepCtx mock above
    // resolves immediately, so we replace it with one we can intercept.
    sleepCtx.set((_ms) => new Promise(() => { /* never resolves on its own */ }));

    mock.enqueueError(new Error("ETIMEDOUT"));
    // No second response — if the loop misbehaves it'll throw "queue empty".

    const promise = client.getUpdates({ signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    await expect(promise).rejects.toThrow();
    expect(mock.callCount()).toBe(1); // no retry attempted after abort
  });

  test("pre-aborted signal short-circuits before first fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new TelegramClient({ token: "T" });

    await expect(client.getUpdates({ signal: controller.signal })).rejects.toThrow();
    expect(mock.callCount()).toBe(0);
  });

  test("one warning per error class: 5 consecutive ETIMEDOUTs produce exactly 1 log line", async () => {
    for (let i = 0; i < 5; i++) {
      mock.enqueueError(new Error("ETIMEDOUT"));
    }
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    await client.getUpdates();

    const timeoutWarnings = logs.filter((l) => l.includes("ETIMEDOUT"));
    expect(timeoutWarnings.length).toBe(1);
  });

  test("error class change re-logs: ETIMEDOUT then ECONNRESET produce 2 warnings", async () => {
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueError(new Error("ECONNRESET"));
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    await client.getUpdates();

    expect(logs.filter((l) => l.includes("ETIMEDOUT")).length).toBe(1);
    expect(logs.filter((l) => l.includes("ECONNRESET")).length).toBe(1);
  });

  test("alternating error classes within one streak still log only once per class", async () => {
    // 4 attempts alternating ETIMEDOUT/ECONNRESET, then success on attempt 5.
    // The single-slot last-seen tracker would have logged all 4 because the
    // class flips every attempt. The Set-based tracker logs exactly 2 — one
    // line per unique class for the streak.
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueError(new Error("ECONNRESET"));
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueError(new Error("ECONNRESET"));
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    await client.getUpdates();

    expect(logs.filter((l) => l.includes("ETIMEDOUT")).length).toBe(1);
    expect(logs.filter((l) => l.includes("ECONNRESET")).length).toBe(1);
  });

  test("successful poll clears the seen-set so the next streak logs fresh", async () => {
    // First streak: ETIMEDOUT then success. One log line.
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });
    await client.getUpdates();
    expect(logs.filter((l) => l.includes("ETIMEDOUT")).length).toBe(1);

    // Second streak: another ETIMEDOUT then success. Should log again because
    // the success between the two streaks cleared the seen-set.
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueResponse({ ok: true, result: [] });
    await client.getUpdates();
    expect(logs.filter((l) => l.includes("ETIMEDOUT")).length).toBe(2);
  });

  test("response with bad envelope (ok:false, no error_code mapping) retries", async () => {
    mock.enqueueResponse({ ok: false, description: "weird" });
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });

    const result = await client.getUpdates();
    expect(result).toEqual([]);
    expect(mock.callCount()).toBe(2);
  });
});

describe("sendMessage", () => {
  let mock: MockFetch;
  let logs: string[];

  beforeEach(() => {
    mock = makeMockFetch();
    fetchCtx.set(mock.fn);
    logs = [];
    logCtx.set((line) => logs.push(line));
  });

  afterEach(() => {
    fetchCtx.reset();
    logCtx.reset();
  });

  test("happy path posts JSON body to /sendMessage and returns parsed envelope", async () => {
    const sent = { message_id: 42, chat: { id: 99 }, text: "hello" };
    mock.enqueueResponse({ ok: true, result: sent });
    const client = new TelegramClient({ token: "TEST" });

    const result = await client.sendMessage({ chat_id: 99, text: "hello" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual(sent);
    }

    const url = mock.allUrls()[0];
    expect(url).toContain("/botTEST/sendMessage");

    const init = mock.lastInit();
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ chat_id: 99, text: "hello" });
  });

  test("non-2xx returns the parsed body instead of throwing", async () => {
    mock.enqueueResponse({ ok: false, error_code: 400, description: "Bad Request" }, 400);
    const client = new TelegramClient({ token: "T" });

    const result = await client.sendMessage({ chat_id: 1, text: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe(400);
    }
  });

  test("logs status only — never the URL with the token", async () => {
    mock.enqueueResponse({ ok: false, error_code: 500, description: "boom" }, 500);
    const client = new TelegramClient({ token: "VERYSECRET" });

    await client.sendMessage({ chat_id: 1, text: "x" });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("VERYSECRET"))).toBe(false);
    expect(logs.some((l) => l.includes("status=500"))).toBe(true);
  });

  test("429 with only Retry-After header (no body parameter) surfaces retryAfterSec", async () => {
    // Some 429 responses arrive with only the HTTP header set and no
    // parameters.retry_after in the body. Callers must still see the actual
    // backoff value rather than falling back to a 1s default.
    mock.enqueueResponse(
      { ok: false, error_code: 429, description: "Too Many Requests" },
      429,
      { "retry-after": "7" },
    );
    const client = new TelegramClient({ token: "T" });

    const result = await client.sendMessage({ chat_id: 1, text: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.error_code).toBe(429);
      expect(result.retryAfterSec).toBe(7);
    }
  });

  test("429 with only body parameter (no Retry-After header) falls back to body", async () => {
    mock.enqueueResponse(
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 4 } },
      429,
    );
    const client = new TelegramClient({ token: "T" });

    const result = await client.sendMessage({ chat_id: 1, text: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfterSec).toBe(4);
    }
  });
});

describe("sendChatAction", () => {
  let mock: MockFetch;
  let logs: string[];

  beforeEach(() => {
    mock = makeMockFetch();
    fetchCtx.set(mock.fn);
    logs = [];
    logCtx.set((line) => logs.push(line));
  });

  afterEach(() => {
    fetchCtx.reset();
    logCtx.reset();
  });

  test("posts JSON body to /sendChatAction with chat_id + action", async () => {
    mock.enqueueResponse({ ok: true, result: true });
    const client = new TelegramClient({ token: "TEST" });

    await client.sendChatAction({ chat_id: 99, action: "typing" });

    const url = mock.allUrls()[0];
    expect(url).toContain("/botTEST/sendChatAction");

    const init = mock.lastInit();
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ chat_id: 99, action: "typing" });
  });

  test("swallows network errors silently — does not throw, does not log", async () => {
    mock.enqueueError(new Error("network boom"));
    const client = new TelegramClient({ token: "T" });

    await expect(client.sendChatAction({ chat_id: 1, action: "typing" })).resolves.toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("swallows non-2xx responses silently — does not throw, does not log", async () => {
    mock.enqueueResponse({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    const client = new TelegramClient({ token: "T" });

    await expect(client.sendChatAction({ chat_id: 1, action: "typing" })).resolves.toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("accepts string chat_id (sentinel/group form)", async () => {
    mock.enqueueResponse({ ok: true, result: true });
    const client = new TelegramClient({ token: "T" });

    await client.sendChatAction({ chat_id: "-1001234567890", action: "typing" });

    const body = JSON.parse(mock.lastInit()?.body as string);
    expect(body.chat_id).toBe("-1001234567890");
  });
});

describe("setMessageReaction", () => {
  let mock: MockFetch;
  let logs: string[];

  beforeEach(() => {
    mock = makeMockFetch();
    fetchCtx.set(mock.fn);
    logs = [];
    logCtx.set((line) => logs.push(line));
  });

  afterEach(() => {
    fetchCtx.reset();
    logCtx.reset();
  });

  test("posts a one-element emoji reaction array to /setMessageReaction", async () => {
    mock.enqueueResponse({ ok: true, result: true });
    const client = new TelegramClient({ token: "TEST" });

    const result = await client.setMessageReaction({ chat_id: 99, message_id: 7, emoji: "👍" });

    expect(result.ok).toBe(true);
    const url = mock.allUrls()[0];
    expect(url).toContain("/botTEST/setMessageReaction");

    const init = mock.lastInit();
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      chat_id: 99,
      message_id: 7,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  });

  test("null emoji sends an empty reaction array (clears the reaction)", async () => {
    mock.enqueueResponse({ ok: true, result: true });
    const client = new TelegramClient({ token: "T" });

    await client.setMessageReaction({ chat_id: 1, message_id: 2, emoji: null });

    const body = JSON.parse(mock.lastInit()?.body as string);
    expect(body.reaction).toEqual([]);
  });

  test("non-2xx returns the parsed body instead of throwing", async () => {
    mock.enqueueResponse(
      { ok: false, error_code: 400, description: "REACTION_INVALID" },
      400,
    );
    const client = new TelegramClient({ token: "T" });

    const result = await client.setMessageReaction({ chat_id: 1, message_id: 2, emoji: "👍" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe(400);
      expect(result.description).toBe("REACTION_INVALID");
    }
  });

  test("logs status only — never the URL with the token", async () => {
    mock.enqueueResponse({ ok: false, error_code: 500, description: "boom" }, 500);
    const client = new TelegramClient({ token: "VERYSECRET" });

    await client.setMessageReaction({ chat_id: 1, message_id: 2, emoji: "👍" });

    expect(logs.some((l) => l.includes("VERYSECRET"))).toBe(false);
    expect(logs.some((l) => l.includes("status=500"))).toBe(true);
  });

  test("surfaces retryAfterSec from a 429 for the outbox 429-retry", async () => {
    mock.enqueueResponse(
      { ok: false, error_code: 429, description: "Too Many Requests" },
      429,
      { "retry-after": "3" },
    );
    const client = new TelegramClient({ token: "T" });

    const result = await client.setMessageReaction({ chat_id: 1, message_id: 2, emoji: "👍" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.retryAfterSec).toBe(3);
    }
  });
});

describe("getUpdates per-request timeout & onPollOutcome", () => {
  let mock: MockFetch;
  let sleeps: number[];
  let logs: string[];

  beforeEach(() => {
    mock = makeMockFetch();
    fetchCtx.set(mock.fn);
    sleeps = [];
    sleepCtx.set(async (ms) => { sleeps.push(ms); });
    logs = [];
    logCtx.set((line) => logs.push(line));
  });

  afterEach(() => {
    fetchCtx.reset();
    sleepCtx.reset();
    logCtx.reset();
  });

  test("timer-fired abort surfaces as a retry, not a user-abort exit", async () => {
    // Simulate the per-request timer firing on a hung socket. The user's
    // own AbortSignal stays unaborted — we throw TimeoutError directly to
    // mimic what `AbortSignal.timeout` produces. The client must treat
    // that as a transient ETIMEDOUT-class failure and retry, NOT throw out
    // of getUpdates as if the user cancelled.
    const userController = new AbortController();
    let attempts = 0;
    fetchCtx.set(((_url: string | URL | Request, _init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) {
        // First attempt: timer fires. User signal is NOT aborted.
        expect(userController.signal.aborted).toBe(false);
        return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      }
      // Second attempt: succeed immediately.
      return Promise.resolve(makeResponse({ ok: true, result: [] }));
    }) as FetchLike);

    const client = new TelegramClient({ token: "T" });
    const result = await client.getUpdates({ signal: userController.signal });
    expect(result).toEqual([]);
    expect(attempts).toBe(2);
    // The retry log should fire once (one ETIMEDOUT class). The timer-fired
    // abort is mapped to errno:ETIMEDOUT.
    expect(logs.filter((l) => l.includes("ETIMEDOUT")).length).toBe(1);
  });

  test("user-aborted signal terminates the loop even if a TimeoutError is in flight", async () => {
    const userController = new AbortController();
    fetchCtx.set(((_url: string | URL | Request, init?: RequestInit) => {
      const sig = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_, reject) => {
        if (sig?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        sig?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as FetchLike);

    const client = new TelegramClient({ token: "T" });
    const promise = client.getUpdates({ signal: userController.signal });
    setTimeout(() => userController.abort(), 5);

    await expect(promise).rejects.toThrow();
    // No retry attempted — we exited on user abort, not timer.
    expect(logs.filter((l) => l.includes("ETIMEDOUT")).length).toBe(0);
  });

  test("onPollOutcome fires 'success' on a 2xx response", async () => {
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });
    const outcomes: Array<"success" | { kind: "retry"; reason: string }> = [];

    await client.getUpdates({ onPollOutcome: (o) => outcomes.push(o) });

    expect(outcomes).toEqual(["success"]);
  });

  test("onPollOutcome fires retry events on transient failures, then success on recovery", async () => {
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueError(new Error("ETIMEDOUT"));
    mock.enqueueResponse({ ok: true, result: [] });

    const client = new TelegramClient({ token: "T" });
    const outcomes: Array<"success" | { kind: "retry"; reason: string }> = [];

    await client.getUpdates({ onPollOutcome: (o) => outcomes.push(o) });

    expect(outcomes.length).toBe(3);
    expect(outcomes[0]).toEqual({ kind: "retry", reason: "errno:ETIMEDOUT" });
    expect(outcomes[1]).toEqual({ kind: "retry", reason: "errno:ETIMEDOUT" });
    expect(outcomes[2]).toBe("success");
  });

  test("five consecutive errors fire one log line, but onPollOutcome fires every attempt", async () => {
    for (let i = 0; i < 5; i++) {
      mock.enqueueError(new Error("ETIMEDOUT"));
    }
    mock.enqueueResponse({ ok: true, result: [] });
    const client = new TelegramClient({ token: "T" });
    const outcomes: Array<"success" | { kind: "retry"; reason: string }> = [];

    await client.getUpdates({ onPollOutcome: (o) => outcomes.push(o) });

    // Existing behavior: one log line per error class per streak.
    expect(logs.filter((l) => l.includes("ETIMEDOUT")).length).toBe(1);
    // New behavior: every attempt fires the outcome callback, so the
    // dispatcher can drive its own streak counter / state machine.
    expect(outcomes.length).toBe(6);
    expect(outcomes.slice(0, 5).every((o) => typeof o !== "string" && o.kind === "retry")).toBe(true);
    expect(outcomes[5]).toBe("success");
  });

  test("onPollOutcome fires BEFORE the backoff sleep (dashboard reacts in ms, not seconds)", async () => {
    // Dispatcher contract: the dashboard's traffic light must flip yellow as
    // soon as the failure is observed, not after the backoff window. We
    // verify by replacing sleepCtx with a never-resolving promise — once the
    // first error has been processed, onPollOutcome must have already fired
    // even though no sleep has completed.
    let sleepStarted = false;
    sleepCtx.set(() => {
      sleepStarted = true;
      return new Promise<void>(() => { /* never resolves */ });
    });

    mock.enqueueError(new Error("ETIMEDOUT"));
    // No second response — if the loop misbehaved and tried another fetch,
    // we'd hit "queue empty".

    const outcomes: Array<"success" | { kind: "retry"; reason: string }> = [];
    const controller = new AbortController();
    const client = new TelegramClient({ token: "T" });
    const promise = client.getUpdates({
      signal: controller.signal,
      onPollOutcome: (o) => {
        outcomes.push(o);
        // At this exact moment the sleep has not yet been entered. If
        // ordering were reversed (sleep before callback), this assertion
        // would fire after sleepStarted=true.
        expect(sleepStarted).toBe(false);
      },
    });

    // Wait until the outcome was recorded (with a small spin so we don't
    // race the await chain in `attemptOnce`).
    const startedAt = Date.now();
    while (outcomes.length === 0 && Date.now() - startedAt < 1000) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    expect(outcomes.length).toBe(1);
    expect(outcomes[0]).toEqual({ kind: "retry", reason: "errno:ETIMEDOUT" });
    expect(sleepStarted).toBe(true); // sleep started after the callback fired

    // Clean up the hung loop.
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  test("probeOnce per-request timeout: TimeoutError surfaces and the call rejects (regression for hung-socket)", async () => {
    // probeOnce wraps fetch with composeAbortSignal(userSig, PROBE_TIMEOUT_MS).
    // Simulate the timer firing on a hung socket by having the mock fetch
    // reject with a TimeoutError. Without the per-request timeout this
    // would be the kind of failure that hangs the dashboard for minutes.
    fetchCtx.set((async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as FetchLike);

    const client = new TelegramClient({ token: "T" });
    // probeOnce does NOT have an internal retry loop, so the TimeoutError
    // surfaces as a thrown error. This is the contract — the dispatcher's
    // start() catches it and proceeds with `starting main loop anyway`.
    await expect(client.probeOnce({ offset: -1, limit: 1, timeout: 0 })).rejects.toThrow(/timed out/i);
  });

  test("sendMessage per-request timeout: TimeoutError surfaces", async () => {
    fetchCtx.set((async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as FetchLike);

    const client = new TelegramClient({ token: "T" });
    // sendMessage doesn't have a retry loop — a hung socket surfaces as
    // a thrown error to the caller (outbox catches it and writes a
    // ok:false result file).
    await expect(client.sendMessage({ chat_id: 1, text: "x" })).rejects.toThrow(/timed out/i);
  });
});

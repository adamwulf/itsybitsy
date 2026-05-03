/**
 * Tests for the Phase A three-step Telegram subsystem boot.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { bootTelegramSubsystem } from "./boot";
import {
  TelegramClient,
  fetchCtx as clientFetchCtx,
  sleepCtx as clientSleepCtx,
  logCtx as clientLogCtx,
} from "./telegram-client";
import { TelegramDispatcher } from "./dispatcher";
import type { DispatcherOptions } from "./dispatcher";
import { TelegramOutbox } from "./outbox";
import type { OutboxOptions } from "./outbox";
import type { AccessState } from "./access";
import {
  setStateDir as setAccessStateDir,
  resetStateDir as resetAccessStateDir,
  readAccess,
} from "./access";
import {
  setStateDir as setCacheStateDir,
  resetStateDir as resetCacheStateDir,
  writeCachedChatId,
  readCachedChatId,
} from "./chat-id-cache";
import type { FetchLike } from "../types";
import type { TelegramUpdate } from "./types";

/* ------------------------------------------------------------------ */
/*  Test helpers                                                       */
/* ------------------------------------------------------------------ */

function makeResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface MockFetch {
  fn: FetchLike;
  enqueueResponse: (body: unknown, status?: number, headers?: Record<string, string>) => void;
  enqueueError: (err: unknown) => void;
  callCount: () => number;
}

function makeMockFetch(): MockFetch {
  const queue: Array<() => Response | Promise<Response>> = [];
  let count = 0;
  const fn: FetchLike = async () => {
    count += 1;
    const next = queue.shift();
    if (!next) throw new Error("mock fetch: queue exhausted");
    return await next();
  };
  return {
    fn,
    enqueueResponse: (body, status, headers) => queue.push(() => makeResponse(body, status, headers)),
    enqueueError: (err) => queue.push(() => { throw err; }),
    callCount: () => count,
  };
}

/** Build an update with a given chat shape for chat-id resolution tests. */
function update(
  update_id: number,
  chat: { id: number; type?: string },
  fromId = 7,
  text = "hello",
): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id * 10,
      chat,
      from: { id: fromId, username: "alice" },
      date: 1_700_000_000,
      text,
    },
  };
}

const EMPTY_ACCESS: AccessState = { allowed_chat_ids: [], allowed_user_ids: [] };

interface BootHarness {
  mock: MockFetch;
  logs: string[];
  client: TelegramClient | null;
  dispatchers: TelegramDispatcher[];
  outboxOpts: OutboxOptions[];
  buildClient: (token: string) => TelegramClient;
  buildDispatcher: (opts: DispatcherOptions) => TelegramDispatcher;
  buildOutbox: (opts: OutboxOptions) => TelegramOutbox;
  log: (line: string) => void;
}

function makeHarness(): BootHarness {
  const mock = makeMockFetch();
  const logs: string[] = [];
  const dispatchers: TelegramDispatcher[] = [];
  const outboxOpts: OutboxOptions[] = [];
  let client: TelegramClient | null = null;

  // Inject the mock fetch so any TelegramClient built in this test uses it.
  clientFetchCtx.set(mock.fn);
  clientSleepCtx.set(async () => { /* fast-forward */ });
  clientLogCtx.set(() => { /* silence */ });

  return {
    mock,
    logs,
    client,
    dispatchers,
    outboxOpts,
    buildClient: (token) => {
      client = new TelegramClient({ token });
      return client;
    },
    buildDispatcher: (opts) => {
      const d = new TelegramDispatcher(opts);
      dispatchers.push(d);
      return d;
    },
    buildOutbox: (opts) => {
      // Capture the options for assertion. We construct a real TelegramOutbox
      // but never call start() — its constructor does no I/O, so this is safe.
      outboxOpts.push(opts);
      return new TelegramOutbox(opts);
    },
    log: (line) => { logs.push(line); },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("bootTelegramSubsystem", () => {
  let h: BootHarness;
  let cacheRoot: string;
  let cacheDir: string;

  beforeEach(async () => {
    h = makeHarness();
    cacheRoot = await mkdtemp(join(tmpdir(), "boot-cache-"));
    cacheDir = join(cacheRoot, "channels", "telegram");
    setCacheStateDir(cacheDir);
    // The first-use path writes to access.json; redirect so we never touch
    // the user's real ~/.itsybitsy.
    setAccessStateDir(cacheDir);
  });

  afterEach(async () => {
    clientFetchCtx.reset();
    clientSleepCtx.reset();
    clientLogCtx.reset();
    resetCacheStateDir();
    resetAccessStateDir();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  test("step 1: empty token → disabled with 'no bot token configured'", async () => {
    const result = await bootTelegramSubsystem({
      token: "",
      access: EMPTY_ACCESS,
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-token");
    expect(result.message).toBe("Telegram routing disabled: no bot token configured");
    expect(h.logs).toEqual([result.message]);
    expect(h.mock.callCount()).toBe(0);
    expect(h.outboxOpts).toEqual([]);
  });

  test("step 1: probe 409 → disabled with 'another poller or webhook is active'", async () => {
    h.mock.enqueueResponse({ ok: false, error_code: 409, description: "Conflict" }, 409);
    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("probe-409");
    expect(result.message).toBe("Telegram routing disabled: another poller or webhook is active");
    expect(h.logs).toEqual([result.message]);
    expect(h.mock.callCount()).toBe(1); // only the connect probe
    expect(h.outboxOpts).toEqual([]);
  });

  test("step 1: probe 401 → disabled with 'bot token rejected (HTTP 401)'", async () => {
    h.mock.enqueueResponse({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("probe-auth");
    expect(result.message).toBe("Telegram routing disabled: bot token rejected (HTTP 401)");
    expect(h.logs).toEqual([result.message]);
  });

  test("step 1: probe 403 → disabled with 'bot token rejected (HTTP 403)'", async () => {
    h.mock.enqueueResponse({ ok: false, error_code: 403, description: "Forbidden" }, 403);
    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("probe-auth");
    expect(result.message).toBe("Telegram routing disabled: bot token rejected (HTTP 403)");
  });

  test("step 1: probe network failure → disabled with 'probe failed'", async () => {
    h.mock.enqueueError(new Error("ECONNRESET"));
    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("probe-network");
    expect(result.message).toContain("Telegram routing disabled: probe failed");
    expect(result.message).toContain("ECONNRESET");
  });

  test("step 1: probe other 4xx (e.g. 502) → disabled with 'probe failed (HTTP 502)'", async () => {
    h.mock.enqueueResponse({ ok: false, description: "Bad Gateway" }, 502);
    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("probe-other");
    expect(result.message).toBe("Telegram routing disabled: probe failed (HTTP 502)");
  });

  test("step 2: no allowlisted private inbound → disabled with the inbound message", async () => {
    // Step 1 probe: success, no updates.
    h.mock.enqueueResponse({ ok: true, result: [] });
    // Step 2 probe: success, no updates.
    h.mock.enqueueResponse({ ok: true, result: [] });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-allowlisted-inbound");
    expect(result.message).toContain("no recent inbound from an allowlisted private chat");
    expect(result.message).toContain("DM your bot, then restart ib watch");
    expect(h.mock.callCount()).toBe(2);
    expect(h.outboxOpts).toEqual([]);
  });

  test("step 2: skips group-chat updates", async () => {
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { id: -1001234567890, type: "supergroup" }, 7),
        update(2, { id: -10099, type: "group" }, 8),
      ],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      // The negative chat IDs ARE in the allowlist — but they're groups,
      // so we still skip them.
      access: { allowed_chat_ids: ["-1001234567890", "-10099"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-allowlisted-inbound");
    expect(h.outboxOpts).toEqual([]);
  });

  test("step 2: skips non-allowlisted private chats", async () => {
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { id: 999, type: "private" }, 7),
        update(2, { id: 888, type: "private" }, 8),
      ],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-allowlisted-inbound");
  });

  test("step 2: picks the FIRST allowlisted private chat, even when later groups appear", async () => {
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { id: -1001234567890, type: "supergroup" }), // skipped (group)
        update(2, { id: 999, type: "private" }),               // skipped (not allowlisted)
        update(3, { id: 100, type: "private" }),               // first match
        update(4, { id: 200, type: "private" }),               // ignored (later)
      ],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100", "200"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe("100");
    expect(h.outboxOpts.length).toBe(1);
    expect(h.outboxOpts[0]!.chatId).toBe("100");
  });

  test("happy path: probe + resolve + dispatcher constructed with offset hint", async () => {
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [
        update(10, { id: 100, type: "private" }, 7, "first"),
        update(11, { id: 100, type: "private" }, 7, "second"),
      ],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: ["7"] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe("100");
    expect(h.dispatchers.length).toBe(1);
    expect(h.outboxOpts.length).toBe(1);
    expect(h.outboxOpts[0]!.chatId).toBe("100");
    expect(h.logs).toEqual([]); // happy path is silent
  });

  test("offset hint: dispatcher's first getUpdates call uses max(consumed)+1", async () => {
    // Steps 1 + 2 probes consumed update_ids 10 and 11. The dispatcher
    // should start from offset=12 to skip them.
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [
        update(10, { id: 100, type: "private" }, 7),
        update(11, { id: 100, type: "private" }, 7),
      ],
    });
    // The dispatcher's startup probe (offset=-1, limit=1) — return empty so
    // it doesn't try to overwrite our offset hint.
    h.mock.enqueueResponse({ ok: true, result: [] });

    // Capture the first getUpdates call body so we can read its offset.
    let firstLongPollOffset: number | undefined;
    const oldFetch = clientFetchCtx.fn;
    clientFetchCtx.set(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? JSON.parse(init.body as string) : null;
      // Skip the steps 1, 2, and the dispatcher startup probe; intercept the
      // FIRST long-poll (timeout >= 1, the dispatcher default is 25).
      if (url.includes("/getUpdates") && body && typeof body.timeout === "number" && body.timeout > 0) {
        if (firstLongPollOffset === undefined) {
          firstLongPollOffset = body.offset;
          // Hang the long-poll forever; the test will stop the dispatcher.
          return await new Promise<Response>((_, reject) => {
            const sig = init?.signal as AbortSignal | undefined;
            if (sig?.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            sig?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
      }
      return await oldFetch(input, init);
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.dispatcher.start();
    // Wait for the dispatcher's first long-poll to fire.
    const startedAt = Date.now();
    while (firstLongPollOffset === undefined) {
      if (Date.now() - startedAt > 1_000) throw new Error("long-poll never fired");
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    await result.dispatcher.stop();
    expect(firstLongPollOffset).toBe(12);
  });

  test("dispatcher startup probe does NOT overwrite a constructor-supplied initialOffset", async () => {
    // Direct dispatcher unit test (not via boot): construct with
    // initialOffset=42 and a probe that returns one update with id=99.
    // The dispatcher must keep 42, not switch to 100.
    h.mock.enqueueResponse({
      ok: true,
      result: [
        { update_id: 99, message: { message_id: 990, chat: { id: 100 }, date: 1_700_000_000, text: "x" } },
      ],
    });
    let observedOffset: number | undefined;
    const oldFetch = clientFetchCtx.fn;
    clientFetchCtx.set(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? JSON.parse(init.body as string) : null;
      if (url.includes("/getUpdates") && body && typeof body.timeout === "number" && body.timeout > 0) {
        if (observedOffset === undefined) {
          observedOffset = body.offset;
          return await new Promise<Response>((_, reject) => {
            const sig = init?.signal as AbortSignal | undefined;
            if (sig?.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            sig?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
      }
      return await oldFetch(input, init);
    });

    const client = new TelegramClient({ token: "T" });
    const dispatcher = new TelegramDispatcher({
      client,
      allowedChatIds: ["100"],
      allowedUserIds: [],
      chatId: "100",
      initialOffset: 42,
    });
    await dispatcher.start();
    const startedAt = Date.now();
    while (observedOffset === undefined) {
      if (Date.now() - startedAt > 1_000) throw new Error("long-poll never fired");
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    await dispatcher.stop();
    expect(observedOffset).toBe(42);
  });

  /* ------------------------------------------------------------------ */
  /*  Step 1.5: chat-id cache                                            */
  /* ------------------------------------------------------------------ */

  test("cache hit: skips inbound walk when cached id is allowlisted", async () => {
    // Cache pre-populated with an allowlisted id. Boot should make only the
    // step 1 connect probe (1 call) and skip the step 2 limit=100 probe.
    await writeCachedChatId("100");
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1 connect probe

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe("100");
    expect(h.mock.callCount()).toBe(1); // ONLY the connect probe
    expect(h.dispatchers.length).toBe(1);
    expect(h.outboxOpts.length).toBe(1);
    expect(h.outboxOpts[0]!.chatId).toBe("100");
    expect(h.logs).toEqual([]);
  });

  test("cache hit: dispatcher receives no initialOffset (left undefined)", async () => {
    await writeCachedChatId("100");
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1 connect probe

    // Capture the dispatcher options to assert on initialOffset.
    const dispatcherOpts: DispatcherOptions[] = [];
    const buildDispatcher = (opts: DispatcherOptions): TelegramDispatcher => {
      dispatcherOpts.push(opts);
      return new TelegramDispatcher(opts);
    };

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    expect(dispatcherOpts.length).toBe(1);
    expect(dispatcherOpts[0]!.initialOffset).toBeUndefined();
  });

  test("cache miss (no file): falls through to resolve flow and writes the cache", async () => {
    // No pre-populated cache. Boot should fall through, resolve via inbound,
    // and write the cache after success.
    expect(await readCachedChatId()).toBeNull();

    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [update(10, { id: 100, type: "private" }, 7, "hello")],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe("100");
    expect(h.mock.callCount()).toBe(2); // step 1 + step 2 probes
    // Cache was written after the successful resolve.
    expect(await readCachedChatId()).toBe("100");

    // The cache file lives in the dir we configured (and not on top of access.json).
    const entries = await readdir(cacheDir);
    expect(entries).toContain("chat-id-cache.json");
  });

  test("cache stale (id removed from allowlist): falls through to resolve flow", async () => {
    // Cache holds an id that is no longer allowlisted. Boot must not trust
    // it — fall through to step 2 and re-resolve.
    await writeCachedChatId("100"); // stale: not in allowlist below

    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [update(20, { id: 200, type: "private" }, 7, "hi")],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["200"], allowed_user_ids: [] }, // 100 removed
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe("200");
    expect(h.mock.callCount()).toBe(2);
    // Cache was overwritten with the new resolved id.
    expect(await readCachedChatId()).toBe("200");
  });

  test("cache stale (empty allowlist / deny-all): falls through to step 2 instead of trusting cache", async () => {
    // Cache holds an id, but the allowlist is empty (deny-all). The cache
    // hit MUST be rejected by the `Set.has()` guard — boot falls through to
    // step 2's update walk, which finds nothing → no-allowlisted-inbound.
    await writeCachedChatId("100");

    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 2 — no updates

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: [], allowed_user_ids: [] }, // deny-all
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-allowlisted-inbound");
    // Confirms the cache was NOT used: both probes fired.
    expect(h.mock.callCount()).toBe(2);
    // Cache untouched — failed boot does not overwrite or clear it.
    expect(await readCachedChatId()).toBe("100");
  });

  test("cache write happens after successful resolve, file persists with id", async () => {
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [update(5, { id: 100, type: "private" }, 7, "hello")],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);

    const cachePath = join(cacheDir, "chat-id-cache.json");
    const file = Bun.file(cachePath);
    expect(await file.exists()).toBe(true);
    const parsed = JSON.parse(await file.text());
    expect(parsed.chat_id).toBe("100");
    expect(typeof parsed.cached_at).toBe("string");
  });

  test("cache write failure does NOT fail the boot", async () => {
    // Point the cache state dir at a path we can't create (a file masquerading
    // as a directory). The write will throw; boot must still succeed.
    resetCacheStateDir();
    const blockedPath = join(cacheRoot, "blocker");
    await Bun.write(blockedPath, "i am a file, not a dir");
    setCacheStateDir(join(blockedPath, "subdir"));

    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [update(5, { id: 100, type: "private" }, 7, "hello")],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: ["100"], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe("100");
    // The write-failure log line is the only entry — boot itself stayed silent.
    expect(h.logs.length).toBe(1);
    expect(h.logs[0]).toContain("Telegram chat-id cache write failed");
  });

  /* ------------------------------------------------------------------ */
  /*  Step 2: trust-on-first-use auto-allowlist                          */
  /* ------------------------------------------------------------------ */

  test("first-use: empty access + exactly one private chat → auto-add and succeed", async () => {
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [update(7, { id: 100, type: "private" }, 7, "hi")],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: [], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe("100");

    // access.json now contains the auto-added chat.
    const persisted = await readAccess();
    expect(persisted.allowed_chat_ids).toEqual(["100"]);
    expect(persisted.allowed_user_ids).toEqual([]);

    // The dispatcher saw the mutated allowlist (otherwise it would reject
    // updates from chat 100).
    expect(h.dispatchers.length).toBe(1);
    expect(h.outboxOpts.length).toBe(1);
    expect(h.outboxOpts[0]!.chatId).toBe("100");

    // One log line announces the auto-add.
    expect(h.logs.length).toBe(1);
    expect(h.logs[0]).toContain("first-use auto-allowlist");
    expect(h.logs[0]).toContain("100");
  });

  test("first-use: empty access + multiple distinct private chats → ambiguous-first-use", async () => {
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { id: 100, type: "private" }, 7),
        update(2, { id: 200, type: "private" }, 8),
      ],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: [], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous-first-use");
    expect(result.message).toContain("2 private chats are pending");
    expect(result.message).toContain("100");
    expect(result.message).toContain("200");
    expect(result.message).toContain("ib tgallow");

    // No write happened.
    const persisted = await readAccess();
    expect(persisted.allowed_chat_ids).toEqual([]);
    expect(h.outboxOpts).toEqual([]);
  });

  test("first-use: empty access + zero private chats → no-allowlisted-inbound (unchanged)", async () => {
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 2 — empty

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: [], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-allowlisted-inbound");

    const persisted = await readAccess();
    expect(persisted.allowed_chat_ids).toEqual([]);
  });

  test("first-use: deduplicates the same private chat across multiple updates", async () => {
    // Two updates from the SAME chat id should still count as one — boot
    // adopts the single chat instead of refusing as ambiguous.
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { id: 100, type: "private" }, 7, "first"),
        update(2, { id: 100, type: "private" }, 7, "second"),
      ],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: [], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe("100");
  });

  test("first-use: skips group/supergroup updates when counting candidates", async () => {
    // A pending group update + one private chat → should NOT trigger
    // ambiguity, because groups are filtered out before the count.
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { id: -1001234567890, type: "supergroup" }, 7),
        update(2, { id: 100, type: "private" }, 8),
      ],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: [], allowed_user_ids: [] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe("100");

    const persisted = await readAccess();
    expect(persisted.allowed_chat_ids).toEqual(["100"]);
  });

  test("first-use does NOT fire when allowed_user_ids is non-empty (chat list empty)", async () => {
    // The user has configured a user-id allowlist but no chat ids. That's a
    // deliberate configuration — first-use must NOT silently auto-add a new
    // chat in this case. The boot must fall through to no-allowlisted-inbound
    // and leave the on-disk access file untouched (no auto-add).
    h.mock.enqueueResponse({ ok: true, result: [] }); // step 1
    h.mock.enqueueResponse({
      ok: true,
      result: [update(1, { id: 100, type: "private" }, 7)],
    });

    const result = await bootTelegramSubsystem({
      token: "TEST_TOKEN",
      access: { allowed_chat_ids: [], allowed_user_ids: ["7"] },
      buildClient: h.buildClient,
      buildDispatcher: h.buildDispatcher,
      buildOutbox: h.buildOutbox,
      log: h.log,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-allowlisted-inbound");

    // Boot did not write to access.json — chat list stays empty. (The
    // in-memory `["7"]` user list was never persisted, so readAccess()
    // returns the on-disk default.)
    const persisted = await readAccess();
    expect(persisted.allowed_chat_ids).toEqual([]);
  });
});

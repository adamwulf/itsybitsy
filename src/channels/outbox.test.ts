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
} from "./outbox";
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
});

afterEach(async () => {
  resetOutboxDir();
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
    const resultText = await readFile(join(outboxDir, `${stem}.txt.result`), "utf8");
    expect(JSON.parse(resultText)).toEqual({ ok: true, message: "ok" });

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

/**
 * Integration test for reaction context — the loop the unit tests can't see.
 *
 * Unit tests cover each half in isolation. What actually has to work is the
 * whole round trip, across two objects that only meet through a module-level
 * singleton:
 *
 *   1. `ib tgsend` drops a file; the REAL `TelegramOutbox` picks it up and
 *      sends it; the (faked) Telegram API returns `message_id: N`.
 *   2. `telegramSend`'s return value — what `ib tgsend` prints to stdout —
 *      carries N.
 *   3. A `message_reaction` update for `message_id: N` arrives at the REAL
 *      `TelegramDispatcher`.
 *   4. The block delivered to the coordinator carries that message's text.
 *
 * Both halves run here as the production objects, wired the way `boot.ts` step
 * 3 wires them: one `TelegramClient`, one resolved chat id, one process. Only
 * the HTTP layer and the coordinator send are faked (via the existing
 * `fetchCtx` / `sendCtx` injection points that the other channel tests use).
 *
 * SCOPE HONESTY: this is not end-to-end against Telegram. No bot token, no real
 * chat, no real HTTP. It proves the wiring between our own components and the
 * shape of what we'd send; it cannot prove Telegram returns the message_id
 * where we expect, or that a real reaction update carries the fields we read.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { TelegramOutbox, setOutboxDir, resetOutboxDir } from "./outbox";
import {
  TelegramDispatcher,
  sendCtx,
  sleepCtx as dispSleepCtx,
  nowCtx,
  logCtx as dispLogCtx,
} from "./dispatcher";
import type { SendToCoordinatorFn } from "./dispatcher";
import { resetMessageCache } from "./message-cache";
import {
  TelegramClient,
  fetchCtx as clientFetchCtx,
  sleepCtx as clientSleepCtx,
  logCtx as clientLogCtx,
} from "./telegram-client";
import {
  setStateDir as setAccessStateDir,
  resetStateDir as resetAccessStateDir,
} from "./access";
import {
  setStateDir as setLastMsgStateDir,
  resetStateDir as resetLastMsgStateDir,
} from "./last-message-cache";
import { setInboundDir, resetInboundDir } from "./inbound-store";
import type { TelegramUpdate } from "./types";

const CHAT_ID = "100";

let tmpRoot: string;
let coordinatorBlocks: string[];
/** Updates the faked `getUpdates` will hand the dispatcher, in order. */
let pendingUpdates: TelegramUpdate[];
/** Next message_id the faked `sendMessage` will return. */
let nextSentId: number;
/** Every text the faked `sendMessage` received, in send order. */
let sentTexts: string[];

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: timeout after ${timeoutMs}ms`);
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

/** One fetch stub for BOTH clients — the outbox and the dispatcher share a
 *  single `TelegramClient`, so routing is by API method in the URL. */
function installFetchRouter(): void {
  clientFetchCtx.set(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/sendMessage")) {
      const body = init?.body ? (JSON.parse(init.body as string) as { text: string }) : { text: "" };
      sentTexts.push(body.text);
      const id = nextSentId++;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: id, chat: { id: Number(CHAT_ID) } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/getUpdates")) {
      const next = pendingUpdates.shift();
      if (next) {
        return new Response(JSON.stringify({ ok: true, result: [next] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Nothing queued: return an empty batch after a short beat rather than
      // hanging, so the loop keeps ticking and picks up whatever the test
      // enqueues next. The delay keeps this from becoming a hot loop.
      await new Promise<void>((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function reactionUpdate(updateId: number, messageId: number, emoji: string): TelegramUpdate {
  return {
    update_id: updateId,
    message_reaction: {
      chat: { id: Number(CHAT_ID) },
      message_id: messageId,
      user: { id: 7, username: "adam" },
      date: 1_700_000_000,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji }],
    },
  };
}

function textUpdate(updateId: number, messageId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: Number(CHAT_ID) },
      from: { id: 7, username: "adam" },
      date: 1_700_000_000,
      text,
    },
  };
}

describe("reaction context: outbound send → id echo → reaction carries the text", () => {
  let client: TelegramClient;
  let outbox: TelegramOutbox;
  let dispatcher: TelegramDispatcher;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "reaction-ctx-"));
    setOutboxDir(join(tmpRoot, "outbox"));
    setAccessStateDir(join(tmpRoot, "channels", "telegram"));
    setLastMsgStateDir(join(tmpRoot, "channels", "telegram"));
    setInboundDir(join(tmpRoot, "channels", "telegram", "inbound"));
    resetMessageCache();

    coordinatorBlocks = [];
    pendingUpdates = [];
    sentTexts = [];
    nextSentId = 1584;

    const captureSend: SendToCoordinatorFn = async (message) => {
      coordinatorBlocks.push(message);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    };
    sendCtx.set(captureSend);
    dispSleepCtx.set(async () => { /* fast-forward */ });
    clientSleepCtx.set(async () => { /* fast-forward */ });
    nowCtx.set(() => 1_700_000_000_000);
    dispLogCtx.set(() => { /* silence */ });
    clientLogCtx.set(() => { /* silence */ });

    installFetchRouter();

    // Exactly the boot.ts step-3 wiring: one client, one chat id, two objects.
    client = new TelegramClient({ token: "TEST_TOKEN" });
    outbox = new TelegramOutbox({ client, chatId: CHAT_ID, log: () => { /* silence */ } });
    dispatcher = new TelegramDispatcher({
      client,
      allowedChatIds: [CHAT_ID],
      allowedUserIds: [],
      chatId: CHAT_ID,
    });
    await outbox.start();
    await dispatcher.start();
  });

  afterEach(async () => {
    await outbox.stop();
    await dispatcher.stop();
    resetOutboxDir();
    resetAccessStateDir();
    resetLastMsgStateDir();
    resetInboundDir();
    resetMessageCache();
    sendCtx.reset();
    dispSleepCtx.reset();
    nowCtx.reset();
    dispLogCtx.reset();
    clientFetchCtx.reset();
    clientSleepCtx.reset();
    clientLogCtx.reset();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("the full loop: tgsend prints the id, and a reaction to it carries the text", async () => {
    const { telegramSend } = await import("../ib-commands");

    // 1 + 2. The real file-drop client, the real outbox, the real result file.
    const sendResult = await telegramSend(
      "Ready to merge — want me to squash first, or keep the history as-is?",
    );
    expect(sendResult.ok).toBe(true);
    // Not "queued": the outbox really processed it inside the 1s poll window.
    expect(sendResult.message).toBe("ok (message_id 1584)");
    expect(sentTexts.length).toBe(1);

    // 3. The user reacts to that exact message.
    pendingUpdates.push(reactionUpdate(1, 1584, "👍"));

    // 4. The coordinator's block names the message AND quotes what it said.
    await waitFor(() => coordinatorBlocks.length >= 1);
    const block = coordinatorBlocks[0]!;
    expect(block).toContain('kind="reaction"');
    expect(block).toContain('message_id="1584"');
    expect(block).toContain("Reacted 👍 to message 1584 (your message):");
    expect(block).toContain("Ready to merge — want me to squash first");
  });

  test("a reaction to the user's OWN inbound message reads as theirs", async () => {
    pendingUpdates.push(textUpdate(1, 900, "here is the log you asked for"));
    await waitFor(() => coordinatorBlocks.length >= 1);

    pendingUpdates.push(reactionUpdate(2, 900, "🔥"));
    await waitFor(() => coordinatorBlocks.length >= 2);

    const block = coordinatorBlocks[1]!;
    expect(block).toContain(
      'Reacted 🔥 to message 900 (their own message): "here is the log you asked for"',
    );
  });

  test("a chunked send: reacting to the SECOND chunk quotes the second chunk", async () => {
    const { telegramSend } = await import("../ib-commands");
    const { TELEGRAM_CHUNK_LIMIT } = await import("./telegram-client");
    const head = "H".repeat(TELEGRAM_CHUNK_LIMIT);
    const tail = "the tail chunk says this";

    const sendResult = await telegramSend(head + tail);
    expect(sendResult.message).toBe("ok (2 parts, message_ids 1584, 1585)");

    pendingUpdates.push(reactionUpdate(1, 1585, "👍"));
    await waitFor(() => coordinatorBlocks.length >= 1);

    const block = coordinatorBlocks[0]!;
    expect(block).toContain("to message 1585 (your message):");
    expect(block).toContain("the tail chunk says this");
    expect(block).not.toContain("HHHH");
  });

  test("RESTART GAP: an unknown id degrades to exactly the id-only block", async () => {
    // The common real-world case — `ib watch` went down, outbound messages
    // queued, and the cache came back empty. Simulate by sending, then wiping
    // the cache the way a process restart would.
    const { telegramSend } = await import("../ib-commands");
    const sent = await telegramSend("a message nobody will remember");
    expect(sent.message).toBe("ok (message_id 1584)");

    resetMessageCache(); // <- the restart

    pendingUpdates.push(reactionUpdate(1, 1584, "👍"));
    await waitFor(() => coordinatorBlocks.length >= 1);

    const block = coordinatorBlocks[0]!;
    const bodyLine = block.split("\n")[1];
    // Byte for byte the pre-feature body: no preview, no empty quotes, no
    // "(unknown)", no error.
    expect(bodyLine).toBe("Reacted 👍 to message 1584");
    expect(block).not.toContain('""');
    expect(block).not.toContain("unknown");
    // And the id echo — the half that survives a restart — still did its job
    // above, which is exactly why this degradation is acceptable.
  });
});

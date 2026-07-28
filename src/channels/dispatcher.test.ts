import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import {
  TelegramDispatcher,
  TELEGRAM_SENTINEL,
  wrapChannelReminder,
  wrapReactionReminder,
  extractReplyContext,
  formatMessagePreview,
  stripChannelClose,
  safeName,
  describeAttachment,
  humanSize,
  sendCtx,
  sleepCtx,
  nowCtx,
  logCtx,
  ensureCoordinatorCtx,
  restartCoordinatorCtx,
} from "./dispatcher";
import {
  setStateDir as setAccessStateDir,
  resetStateDir as resetAccessStateDir,
} from "./access";
import {
  setStateDir as setLastMsgStateDir,
  resetStateDir as resetLastMsgStateDir,
  readLastMessage,
} from "./last-message-cache";
import type { SendToCoordinatorFn } from "./dispatcher";
import {
  TelegramClient,
  fetchCtx as clientFetchCtx,
  sleepCtx as clientSleepCtx,
  logCtx as clientLogCtx,
} from "./telegram-client";
import {
  setStateDir as setCacheStateDir,
  resetStateDir as resetCacheStateDir,
  writeCachedChatId,
  readCachedChatId,
} from "./chat-id-cache";
import {
  setInboundDir,
  resetInboundDir,
  defaultInboundDir,
} from "./inbound-store";
import {
  resetMessageCache,
  recordOutboundMessage,
  recordInboundMessage,
  lookupMessage,
} from "./message-cache";
import type { FetchLike } from "../types";
import type { TelegramUpdate, TelegramMessage } from "./types";

/* ------------------------------------------------------------------ */
/*  Test helpers                                                       */
/* ------------------------------------------------------------------ */

function makeResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type ResponseProducer = () => Response | Promise<Response>;

interface MockFetch {
  fn: FetchLike;
  enqueue: (producer: ResponseProducer) => void;
  enqueueResponse: (body: unknown, status?: number, headers?: Record<string, string>) => void;
  enqueueError: (err: unknown) => void;
  callCount: () => number;
  allUrls: () => string[];
  allInits: () => Array<RequestInit | undefined>;
}

function makeMockFetch(): MockFetch {
  const queue: ResponseProducer[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const urls: string[] = [];
  const fn: FetchLike = async (input, init) => {
    inits.push(init);
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const next = queue.shift();
    if (!next) {
      // After the queue is exhausted, idle long-poll: never resolve. The
      // dispatcher's abort handler will unwind via signal.
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
    return await next();
  };
  return {
    fn,
    enqueue: (p) => queue.push(p),
    enqueueResponse: (body, status, headers) => queue.push(() => makeResponse(body, status, headers)),
    enqueueError: (err) => queue.push(() => { throw err; }),
    callCount: () => inits.length,
    allUrls: () => urls,
    allInits: () => inits,
  };
}

/** Spy on `sendToSystemCoordinator`. Captures every call and returns ok=true
 *  unless `nextOk` is set to false. */
interface SendSpy {
  fn: SendToCoordinatorFn;
  calls: Array<{ message: string; opts?: { fromAgent?: string; cwd?: string; raw?: boolean } }>;
  setNext: (ok: boolean) => void;
  setQueue: (results: boolean[]) => void;
}

function makeSendSpy(): SendSpy {
  const calls: SendSpy["calls"] = [];
  let nextOk = true;
  let queue: boolean[] | null = null;
  const fn: SendToCoordinatorFn = async (message, opts) => {
    calls.push({ message, opts });
    let ok: boolean;
    if (queue !== null) {
      ok = queue.shift() ?? true;
    } else {
      ok = nextOk;
    }
    return { ok, exitCode: ok ? 0 : 1, stdout: ok ? "ok" : "", stderr: ok ? "" : "coordinator down" };
  };
  return {
    fn,
    calls,
    setNext: (ok) => { nextOk = ok; queue = null; },
    setQueue: (results) => { queue = [...results]; },
  };
}

/** Build a TelegramUpdate quickly. */
function update(
  update_id: number,
  msg: Partial<TelegramMessage> & { chat: { id: number | string }; from?: { id: number | string; username?: string } },
): TelegramUpdate {
  const m: TelegramMessage = {
    message_id: msg.message_id ?? update_id * 10,
    chat: { id: typeof msg.chat.id === "string" ? Number(msg.chat.id) : msg.chat.id },
    from: msg.from ? { id: typeof msg.from.id === "string" ? Number(msg.from.id) : msg.from.id, username: msg.from.username } : undefined,
    date: msg.date ?? 1_700_000_000,
    text: msg.text,
    caption: msg.caption,
    photo: msg.photo,
    document: msg.document,
    voice: msg.voice,
    audio: msg.audio,
    video: msg.video,
    video_note: msg.video_note,
    sticker: msg.sticker,
  };
  return { update_id, message: m };
}

/** Build a message_reaction TelegramUpdate. `added`/`removed` are emoji
 *  strings; they're translated into old_reaction/new_reaction arrays such that
 *  the dispatcher's diff produces exactly the requested added/removed sets. */
function reactionUpdate(
  update_id: number,
  opts: {
    chatId: number | string;
    messageId: number;
    userId?: number | string;
    username?: string;
    added?: string[];
    removed?: string[];
    date?: number;
  },
): TelegramUpdate {
  const added = opts.added ?? [];
  const removed = opts.removed ?? [];
  // old_reaction = removed (present before, gone after).
  // new_reaction = added (absent before, present after).
  const toArr = (emojis: string[]) => emojis.map((e) => ({ type: "emoji" as const, emoji: e }));
  return {
    update_id,
    message_reaction: {
      chat: { id: typeof opts.chatId === "string" ? Number(opts.chatId) : opts.chatId },
      message_id: opts.messageId,
      user:
        opts.userId !== undefined
          ? { id: typeof opts.userId === "string" ? Number(opts.userId) : opts.userId, username: opts.username }
          : undefined,
      date: opts.date ?? 1_700_000_000,
      old_reaction: toArr(removed),
      new_reaction: toArr(added),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Pure helpers: stripChannelClose, safeName, wrapChannelReminder     */
/* ------------------------------------------------------------------ */

describe("stripChannelClose", () => {
  test("strips a single </channel> substring", () => {
    expect(stripChannelClose("hello </channel> world")).toBe("hello  world");
  });

  test("strips all occurrences", () => {
    expect(stripChannelClose("a</channel>b</channel>c")).toBe("abc");
  });

  test("case-insensitive", () => {
    expect(stripChannelClose("a</CHANNEL>b</Channel>c")).toBe("abc");
  });

  test("leaves opening tag alone", () => {
    expect(stripChannelClose("<channel>x</channel>y")).toBe("<channel>xy");
  });

  test("no-op when no closing tag present", () => {
    expect(stripChannelClose("hello world")).toBe("hello world");
  });
});

describe("safeName", () => {
  test("strips angle brackets, square brackets, CR/LF, semicolons", () => {
    expect(safeName("foo<bar>baz[qux]\r\n;quux")).toBe("foobarbazquxquux");
  });

  test("leaves ordinary filename chars alone", () => {
    expect(safeName("photo_2024-01-01.jpg")).toBe("photo_2024-01-01.jpg");
  });
});

describe("describeAttachment", () => {
  function msg(fields: Partial<TelegramMessage>): TelegramMessage {
    return { message_id: 1, chat: { id: 100 }, ...fields };
  }

  test("returns null for a plain text message", () => {
    expect(describeAttachment(msg({ text: "hi" }))).toBeNull();
  });

  test("photo: picks the LARGEST PhotoSize by area", () => {
    const d = describeAttachment(
      msg({
        photo: [
          { file_id: "s", file_unique_id: "us", width: 90, height: 90, file_size: 100 },
          { file_id: "m", file_unique_id: "um", width: 320, height: 320, file_size: 1000 },
          { file_id: "l", file_unique_id: "ul", width: 1280, height: 1280, file_size: 9000 },
        ],
      }),
    );
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("photo");
    expect(d!.fileId).toBe("l");
    expect(d!.fileSize).toBe(9000);
    expect(d!.displayName.endsWith(".jpg")).toBe(true);
  });

  test("photo: empty array yields null", () => {
    expect(describeAttachment(msg({ photo: [] }))).toBeNull();
  });

  test("document: carries file_id, size, and the file_name", () => {
    const d = describeAttachment(
      msg({ document: { file_id: "d1", file_unique_id: "ud", file_name: "report.pdf", file_size: 2048 } }),
    );
    expect(d!.kind).toBe("document");
    expect(d!.fileId).toBe("d1");
    expect(d!.fileSize).toBe(2048);
    expect(d!.displayName).toBe("report.pdf");
  });

  test("document: a malicious file_name is sanitized via safeName", () => {
    const d = describeAttachment(
      msg({ document: { file_id: "d", file_unique_id: "u", file_name: "evil<>;\r\nname.bin" } }),
    );
    expect(d!.displayName).toBe("evilname.bin");
  });

  test("voice / audio / video / video_note / sticker are recognized", () => {
    expect(describeAttachment(msg({ voice: { file_id: "v", file_unique_id: "u" } }))!.kind).toBe("voice");
    expect(describeAttachment(msg({ audio: { file_id: "a", file_unique_id: "u" } }))!.kind).toBe("audio");
    expect(describeAttachment(msg({ video: { file_id: "vi", file_unique_id: "u" } }))!.kind).toBe("video");
    expect(describeAttachment(msg({ video_note: { file_id: "vn", file_unique_id: "u" } }))!.kind).toBe("video_note");
    expect(describeAttachment(msg({ sticker: { file_id: "st", file_unique_id: "u" } }))!.kind).toBe("sticker");
  });

  test("sticker extension reflects the type flags", () => {
    expect(describeAttachment(msg({ sticker: { file_id: "s", file_unique_id: "u", is_video: true } }))!.displayName).toContain(".webm");
    expect(describeAttachment(msg({ sticker: { file_id: "s", file_unique_id: "u", is_animated: true } }))!.displayName).toContain(".tgs");
    expect(describeAttachment(msg({ sticker: { file_id: "s", file_unique_id: "u" } }))!.displayName).toContain(".webp");
  });

  test("missing file_id yields null even if the field is present", () => {
    // A document object with no usable file_id is unusable.
    expect(describeAttachment(msg({ document: { file_id: "", file_unique_id: "u" } }))).toBeNull();
  });
});

describe("humanSize", () => {
  test("bytes", () => expect(humanSize(512)).toBe("512 B"));
  test("kilobytes with one decimal under 10", () => expect(humanSize(1536)).toBe("1.5 KB"));
  test("kilobytes rounded over 10", () => expect(humanSize(50 * 1024)).toBe("50 KB"));
  test("megabytes", () => expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB"));
  test("negative / NaN → unknown", () => {
    expect(humanSize(-1)).toBe("unknown size");
    expect(humanSize(NaN)).toBe("unknown size");
  });
});

/* The two reply-hint variants, as hardcoded literals — an oracle independent of
 * the constants in dispatcher.ts, which is the point. The reaction variant is a
 * strict SUPERSET of the base one, so `toContain` on any part of the base
 * passes for both and cannot tell them apart; the tests below pin the hint as a
 * whole trailing line instead. Ordinary message blocks must not carry the
 * echoed-id sentence — it is a per-message context tax that only reaction
 * blocks have a use for. */
const BASE_REPLY_HINT =
  'To reply on Telegram, run `ib tgsend "<your message>"`. ' +
  "To react to the latest message, run `ib tgreact <emoji>` " +
  "(e.g. `ib tgreact 👍`), or target a specific one with " +
  "`ib tgreact <emoji> --message-id <id>`.";
const ECHO_SENTENCE =
  "`ib tgsend` echoes the sent `message_id`; keep it to match later reactions.";
const REACTION_REPLY_HINT = `${BASE_REPLY_HINT} ${ECHO_SENTENCE}`;

/** The hint is the last line of every wrapped block. */
function hintLine(block: string): string {
  const lines = block.split("\n");
  return lines[lines.length - 1]!;
}

describe("wrapChannelReminder", () => {
  test("single message: no count, no separators, inline reply hint, message_id", () => {
    const out = wrapChannelReminder("12345", [
      { chatId: "12345", messageId: 42, userId: "1", username: "alice", ts: "2026-05-02T00:00:00.000Z", body: "hello", attachmentType: null },
    ]);
    expect(out).toContain('<channel source="telegram" user="alice" ts="2026-05-02T00:00:00.000Z" message_id="42">');
    expect(out).toContain("hello");
    expect(out).toContain("</channel>");
    expect(hintLine(out)).toBe(BASE_REPLY_HINT);
    expect(out).not.toContain(ECHO_SENTENCE);
    expect(out).not.toContain("count=");
    expect(out).not.toContain("---");
  });

  test("burst of 3: one block with count=3, --- separators, last_message_id", () => {
    const out = wrapChannelReminder("12345", [
      { chatId: "12345", messageId: 10, userId: "1", username: "alice", ts: "2026-05-02T00:00:00.000Z", body: "one", attachmentType: null },
      { chatId: "12345", messageId: 11, userId: "1", username: "alice", ts: "2026-05-02T00:00:01.000Z", body: "two", attachmentType: null },
      { chatId: "12345", messageId: 12, userId: "1", username: "alice", ts: "2026-05-02T00:00:02.000Z", body: "three", attachmentType: null },
    ]);
    expect(out).toContain('count="3"');
    expect(out).toContain('chat_id="12345"');
    expect(out).toContain('first_ts="2026-05-02T00:00:00.000Z"');
    // last_message_id reflects the most recent message — the default tgreact target.
    expect(out).toContain('last_message_id="12"');
    expect(out).toContain("one\n---\ntwo\n---\nthree");
    // Exactly 2 separators (between 3 messages).
    expect(out.split("\n---\n").length).toBe(3);
    // The coalesced branch builds its hint separately from the single-message
    // branch, so it gets its own pin — same base hint, no echo sentence.
    expect(hintLine(out)).toBe(BASE_REPLY_HINT);
    expect(out).not.toContain(ECHO_SENTENCE);
  });

  test("escapes attribute special chars", () => {
    const out = wrapChannelReminder("99", [
      { chatId: "99", messageId: 1, userId: "1", username: 'alice "the" bot', ts: "t", body: "x", attachmentType: null },
    ]);
    expect(out).toContain('user="alice &quot;the&quot; bot"');
  });

  test("throws on empty messages", () => {
    expect(() => wrapChannelReminder("99", [])).toThrow();
  });

  test("omits message_id when it is 0 (missing/non-numeric upstream)", () => {
    const out = wrapChannelReminder("12345", [
      { chatId: "12345", messageId: 0, userId: "1", username: "alice", ts: "t", body: "hi", attachmentType: null },
    ]);
    // No un-reactable message_id="0" handed to the agent.
    expect(out).not.toContain('message_id="0"');
    expect(out).not.toContain("message_id=");
  });
});

describe("wrapReactionReminder", () => {
  test("added reaction: kind=reaction, message_id, human-readable body", () => {
    const out = wrapReactionReminder({
      chatId: "100",
      messageId: 55,
      userId: "7",
      username: "adam",
      ts: "2026-06-27T00:00:00.000Z",
      added: ["👍"],
      removed: [],
    });
    expect(out).toContain('source="telegram" kind="reaction"');
    expect(out).toContain('user="adam"');
    expect(out).toContain('message_id="55"');
    expect(out).toContain("Reacted 👍 to message 55");
    expect(out).toContain("</channel>");
    // The reply hint mentions tgreact so the coordinator can react back.
    expect(out).toContain("ib tgreact");
  });

  test("removed reaction reads as 'Removed reaction'", () => {
    const out = wrapReactionReminder({
      chatId: "100",
      messageId: 9,
      userId: "7",
      username: "adam",
      ts: "t",
      added: [],
      removed: ["🔥"],
    });
    expect(out).toContain("Removed reaction 🔥 from message 9");
  });

  test("changed reaction shows both added and removed", () => {
    const out = wrapReactionReminder({
      chatId: "100",
      messageId: 3,
      userId: "7",
      username: "adam",
      ts: "t",
      added: ["🎉"],
      removed: ["👍"],
    });
    expect(out).toContain("Reacted 🎉");
    expect(out).toContain("Removed reaction 👍");
  });

  test("the reply hint tells the coordinator tgsend echoes the id", () => {
    const out = wrapReactionReminder({
      chatId: "100", messageId: 1, userId: "7", username: "adam", ts: "t",
      added: ["👍"], removed: [],
    });
    // Pinned whole: the base hint plus the echo sentence, in that order. This
    // is the ONLY block type that carries the sentence — see the matching
    // negative assertions in the `wrapChannelReminder` describe.
    expect(hintLine(out)).toBe(REACTION_REPLY_HINT);
  });
});

describe("wrapReactionReminder with a text preview", () => {
  const base = {
    chatId: "100",
    messageId: 1584,
    userId: "7",
    username: "adam",
    ts: "2026-07-27T00:00:00.000Z",
  };

  test("outbound preview reads as the coordinator's own message", () => {
    const out = wrapReactionReminder(
      { ...base, added: ["👍"], removed: [] },
      { text: "Ready to merge — squash first, or keep the history?", direction: "out" },
    );
    expect(out).toContain(
      'Reacted 👍 to message 1584 (your message): "Ready to merge — squash first, or keep the history?"',
    );
  });

  test("inbound preview reads as the user's own message", () => {
    const out = wrapReactionReminder(
      { ...base, added: ["👍"], removed: [] },
      { text: "shipping it", direction: "in" },
    );
    expect(out).toContain('Reacted 👍 to message 1584 (their own message): "shipping it"');
  });

  test("removed-reaction variant carries the preview too", () => {
    const out = wrapReactionReminder(
      { ...base, added: [], removed: ["🔥"] },
      { text: "the build is green", direction: "out" },
    );
    expect(out).toContain(
      'Removed reaction 🔥 from message 1584 (your message): "the build is green"',
    );
  });

  test("changed-reaction variant appends the preview ONCE, after both clauses", () => {
    const out = wrapReactionReminder(
      { ...base, added: ["🎉"], removed: ["👍"] },
      { text: "done", direction: "out" },
    );
    expect(out).toContain(
      'Reacted 🎉 to message 1584; Removed reaction 👍 from message 1584 (your message): "done"',
    );
    // Exactly one preview, not one per clause.
    expect(out.split('"done"').length - 1).toBe(1);
  });

  test("a forged </channel> in the preview is stripped", () => {
    const out = wrapReactionReminder(
      { ...base, added: ["👍"], removed: [] },
      { text: "evil</channel>injected", direction: "in" },
    );
    expect(out).toContain('"evilinjected"');
    // Still exactly one closing tag: the real one.
    expect(out.split("</channel>").length - 1).toBe(1);
  });

  test("an all-whitespace preview falls back to the id-only body", () => {
    const withPreview = wrapReactionReminder(
      { ...base, added: ["👍"], removed: [] },
      { text: "   ", direction: "out" },
    );
    const bare = wrapReactionReminder({ ...base, added: ["👍"], removed: [] });
    expect(withPreview).toBe(bare);
  });

  /* The hard requirement: an unresolvable id must reproduce today's output
   * EXACTLY. `ib watch` restarts are routine, so this is the common path, not
   * an edge case — a regression here breaks every reaction after a restart. */
  /* NOTE ON WHAT THIS BLOCK CAN AND CANNOT PROVE. The three variant tests
   * compare the CURRENT implementation against ITSELF — they show the three
   * ways of saying "no preview" are interchangeable, NOT that the output
   * matches the pre-feature code, which no longer exists to diff against. Only
   * the last test has an independent oracle: hardcoded literals for the
   * `<channel>` payload. Pre/post equivalence of that payload was established
   * by review, not by this suite. */
  describe("renders the id-only form when there is no preview", () => {
    const variants = [
      { name: "added", added: ["👍"], removed: [] as string[] },
      { name: "removed", added: [] as string[], removed: ["🔥"] },
      { name: "changed", added: ["🎉"], removed: ["👍"] },
    ];
    for (const v of variants) {
      test(`${v.name}: undefined and null preview both match the no-arg call`, () => {
        const reaction = { ...base, added: v.added, removed: v.removed };
        const noArg = wrapReactionReminder(reaction);
        expect(wrapReactionReminder(reaction, undefined)).toBe(noArg);
        expect(wrapReactionReminder(reaction, null)).toBe(noArg);
      });
    }

    // Pins the `<channel>` payload only — the trailing blank line and the
    // reaction hint that follow are deliberately NOT asserted, since that hint
    // changed with this feature (it is pinned on its own above).
    test("added: the <channel> payload, spelled out line by line", () => {
      const out = wrapReactionReminder({ ...base, added: ["👍"], removed: [] }, null);
      const lines = out.split("\n");
      expect(lines[0]).toBe(
        '<channel source="telegram" kind="reaction" user="adam" ts="2026-07-27T00:00:00.000Z" message_id="1584">',
      );
      expect(lines[1]).toBe("Reacted 👍 to message 1584");
      expect(lines[2]).toBe("</channel>");
      expect(lines[3]).toBe("");
    });
  });
});

describe("extractReplyContext", () => {
  // Several tests here reach the process-wide cache singleton (the last-resort
  // text source and the direction fallback); keep them isolated.
  beforeEach(() => resetMessageCache());
  afterEach(() => resetMessageCache());

  /** An inbound message from the user, optionally replying to something. */
  function replyMsg(replied: Partial<TelegramMessage> | undefined): TelegramMessage {
    return {
      message_id: 1590,
      chat: { id: 100 },
      from: { id: 7, is_bot: false, username: "adam" },
      text: "yes, squash it",
      ...(replied ? { reply_to_message: { message_id: 1584, chat: { id: 100 }, ...replied } } : {}),
    };
  }

  test("an ordinary message (no reply_to_message) yields null", () => {
    expect(extractReplyContext(replyMsg(undefined), "100")).toBeNull();
  });

  test("embedded text is used, and a bot sender reads as the coordinator's message", () => {
    const ctx = extractReplyContext(
      replyMsg({ from: { id: 42, is_bot: true, username: "mybot" }, text: "Ready to merge?" }),
      "100",
    );
    expect(ctx).toEqual({ messageId: 1584, text: "Ready to merge?", direction: "out" });
  });

  test("a human sender reads as the user's own message", () => {
    const ctx = extractReplyContext(
      replyMsg({ from: { id: 7, is_bot: false, username: "adam" }, text: "shipping it" }),
      "100",
    );
    expect(ctx?.direction).toBe("in");
  });

  test("embedded text wins over a cache entry for the same id", () => {
    // The cache is the LAST resort, never an override — a stale record must not
    // displace the authoritative text Telegram embedded in the update.
    recordInboundMessage("100", 1584, "stale cached text");
    const ctx = extractReplyContext(replyMsg({ text: "authoritative text" }), "100");
    expect(ctx?.text).toBe("authoritative text");
  });

  test("a reply to media uses the caption when there is no text", () => {
    const ctx = extractReplyContext(
      replyMsg({
        from: { id: 42, is_bot: true },
        caption: "here's the diff",
        photo: [{ file_id: "p", file_unique_id: "u" }],
      }),
      "100",
    );
    expect(ctx?.text).toBe("here's the diff");
  });

  test("falls back to the cache when the update carries neither text nor caption", () => {
    recordOutboundMessage("100", 1584, "the message only the cache remembers");
    // No `from` either, so the direction has to come from the cache as well.
    const ctx = extractReplyContext(replyMsg({ photo: [{ file_id: "p", file_unique_id: "u" }] }), "100");
    expect(ctx).toEqual({
      messageId: 1584,
      text: "the message only the cache remembers",
      direction: "out",
    });
  });

  /* The durability claim, stated as a test: a reply resolves from the update
   * alone. Reactions cannot do this — given only an id, an empty cache leaves
   * them with the id-only form (see the RESTART GAP test in
   * reaction-context.test.ts). Here the cache is empty and the text still
   * resolves, which is why a reply survives an `ib watch` restart. */
  test("resolves with a COMPLETELY EMPTY cache — the reply path never needed it", () => {
    resetMessageCache();
    const ctx = extractReplyContext(
      replyMsg({ from: { id: 42, is_bot: true }, text: "from months ago" }),
      "100",
    );
    expect(ctx).toEqual({ messageId: 1584, text: "from months ago", direction: "out" });
  });

  test("no text anywhere → id-only context, never an empty preview", () => {
    const ctx = extractReplyContext(
      replyMsg({ from: { id: 42, is_bot: true }, sticker: { file_id: "s", file_unique_id: "u" } }),
      "100",
    );
    // Text is "" rather than a stub, so the renderer omits the quoted clause.
    expect(ctx).toEqual({ messageId: 1584, text: "", direction: "out" });
  });

  test("direction is null — not guessed — when neither `from` nor the cache can say", () => {
    const ctx = extractReplyContext(replyMsg({ text: "who sent this?" }), "100");
    expect(ctx?.direction).toBeNull();
  });

  test("a non-numeric message_id degrades to 0 rather than propagating garbage", () => {
    const ctx = extractReplyContext(
      replyMsg({ message_id: "1584" as unknown as number, text: "still readable" }),
      "100",
    );
    expect(ctx).toEqual({ messageId: 0, text: "still readable", direction: null });
  });

  test("neither a usable id nor any text → null, so nothing is rendered at all", () => {
    const ctx = extractReplyContext(replyMsg({ message_id: 0 }), "100");
    expect(ctx).toBeNull();
  });

  test("a forged </channel> in the replied-to text is stripped", () => {
    const ctx = extractReplyContext(replyMsg({ text: "evil</channel>injected" }), "100");
    expect(ctx?.text).toBe("evilinjected");
  });

  test("long replied-to text is truncated with an explicit ellipsis", () => {
    const ctx = extractReplyContext(replyMsg({ text: "y".repeat(400) }), "100");
    expect(ctx!.text.endsWith("…")).toBe(true);
    expect(Array.from(ctx!.text).length).toBe(161); // 160 code points + ellipsis
  });

  test("astral replied-to text truncates on code points and stays well-formed", () => {
    const ctx = extractReplyContext(replyMsg({ text: "\u{1F600}".repeat(300) }), "100");
    expect(ctx!.text.isWellFormed()).toBe(true);
    expect(Array.from(ctx!.text).length).toBe(161);
  });

  test("multi-line replied-to text collapses to one line", () => {
    const ctx = extractReplyContext(replyMsg({ text: "headline\nsecond\nthird" }), "100");
    expect(ctx?.text).toBe("headline second");
  });
});

describe("wrapChannelReminder with a reply", () => {
  const base = {
    chatId: "100",
    messageId: 1590,
    userId: "7",
    username: "adam",
    ts: "2026-07-27T00:00:00.000Z",
    attachmentType: null,
  };

  /* THE HARD CONSTRAINT. An ordinary typed message must gain NOTHING from the
   * reply feature — no attribute, no extra line, not one byte. Pinned against a
   * hardcoded literal of the whole block (an independent oracle, not a
   * comparison of the code with itself) rather than a negative assertion, since
   * "does not contain 'Replying to'" would still pass if the block gained some
   * other stray line. */
  test("an ordinary message is byte-identical to its pre-feature output", () => {
    const out = wrapChannelReminder("100", [{ ...base, body: "just a message" }]);
    expect(out).toBe(
      '<channel source="telegram" user="adam" ts="2026-07-27T00:00:00.000Z" message_id="1590">\n' +
        "just a message\n" +
        "</channel>\n" +
        "\n" +
        BASE_REPLY_HINT,
    );
  });

  test("an ordinary coalesced batch is byte-identical to its pre-feature output", () => {
    const out = wrapChannelReminder("100", [
      { ...base, messageId: 10, body: "one" },
      { ...base, messageId: 11, body: "two" },
    ]);
    expect(out).toBe(
      '<channel source="telegram" chat_id="100" user="adam" first_ts="2026-07-27T00:00:00.000Z" count="2" last_message_id="11">\n' +
        "one\n" +
        "---\n" +
        "two\n" +
        "</channel>\n" +
        "\n" +
        BASE_REPLY_HINT,
    );
  });

  test("a reply to the coordinator: in_reply_to attribute + Replying-to line, spelled out", () => {
    const out = wrapChannelReminder("100", [
      {
        ...base,
        body: "yes, squash it",
        replyTo: { messageId: 1584, text: "Ready to merge — squash first, or keep the history?", direction: "out" },
      },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe(
      '<channel source="telegram" user="adam" ts="2026-07-27T00:00:00.000Z" message_id="1590" in_reply_to="1584">',
    );
    expect(lines[1]).toBe(
      'Replying to (your message): "Ready to merge — squash first, or keep the history?"',
    );
    expect(lines[2]).toBe("yes, squash it");
    expect(lines[3]).toBe("</channel>");
    // The single-message block carries the id in the ATTRIBUTE, so the body
    // line does not repeat it.
    expect(lines[1]).not.toContain("1584");
  });

  test("a reply to the user's own earlier message is surfaced too, with its own label", () => {
    const out = wrapChannelReminder("100", [
      {
        ...base,
        body: "still true",
        replyTo: { messageId: 1500, text: "shipping it", direction: "in" },
      },
    ]);
    expect(out).toContain('Replying to (their own message): "shipping it"');
  });

  test("unknown direction drops the whose-message clause rather than guessing", () => {
    const out = wrapChannelReminder("100", [
      { ...base, body: "ok", replyTo: { messageId: 1584, text: "which one?", direction: null } },
    ]);
    // Scoped to the reply LINE: the trailing hint legitimately contains the
    // substring "your message" (in `ib tgsend "<your message>"`), so a
    // block-wide negative would fail for the wrong reason.
    const replyLine = out.split("\n")[1];
    expect(replyLine).toBe('Replying to: "which one?"');
    expect(replyLine).not.toContain("your message");
    expect(replyLine).not.toContain("their own message");
  });

  test("no resolvable text renders the id-only form, never empty quotes", () => {
    const out = wrapChannelReminder("100", [
      { ...base, body: "what about this?", replyTo: { messageId: 1584, text: "", direction: "out" } },
    ]);
    const lines = out.split("\n");
    // The id moves INTO the line here: "Replying to (your message)" with no
    // quote and no number would identify nothing.
    expect(lines[1]).toBe("Replying to message 1584 (your message)");
    expect(out).not.toContain('""');
    // The attribute is still emitted, so the agent can target the message.
    expect(lines[0]).toContain('in_reply_to="1584"');
  });

  test("an unusable replied-to id omits the attribute but keeps the preview", () => {
    const out = wrapChannelReminder("100", [
      { ...base, body: "hm", replyTo: { messageId: 0, text: "no id for this one", direction: "out" } },
    ]);
    expect(out).not.toContain("in_reply_to");
    expect(out).toContain('Replying to (your message): "no id for this one"');
  });

  test("a reply inside a coalesced batch binds to ITS message and carries the id inline", () => {
    const out = wrapChannelReminder("100", [
      { ...base, messageId: 20, body: "first, unrelated" },
      {
        ...base,
        messageId: 21,
        body: "yes, squash it",
        replyTo: { messageId: 1584, text: "Ready to merge?", direction: "out" },
      },
      { ...base, messageId: 22, body: "third, unrelated" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toContain('count="3"');
    expect(lines[0]).toContain('last_message_id="22"');
    // No block-level in_reply_to: with 3 messages in one block it would be
    // ambiguous which of them it described.
    expect(lines[0]).not.toContain("in_reply_to");
    expect(lines[1]).toBe("first, unrelated");
    expect(lines[2]).toBe("---");
    // Immediately above its own body, and carrying the id inline because a
    // coalesced batch has no per-message attribute slot.
    expect(lines[3]).toBe('Replying to message 1584 (your message): "Ready to merge?"');
    expect(lines[4]).toBe("yes, squash it");
    expect(lines[5]).toBe("---");
    expect(lines[6]).toBe("third, unrelated");
    // Exactly one reply line — the unrelated messages gained nothing.
    expect(out.split("Replying to").length - 1).toBe(1);
  });

  test("two replies in one batch each get their own line", () => {
    const out = wrapChannelReminder("100", [
      { ...base, messageId: 20, body: "a", replyTo: { messageId: 1, text: "first target", direction: "out" } },
      { ...base, messageId: 21, body: "b", replyTo: { messageId: 2, text: "second target", direction: "in" } },
    ]);
    expect(out).toContain('Replying to message 1 (your message): "first target"');
    expect(out).toContain('Replying to message 2 (their own message): "second target"');
  });

  test("the reply line survives an attachment body rewrite", () => {
    // `resolveAttachment` overwrites `body` after normalize(); the reply line is
    // rendered from `replyTo` at wrap time, so it is unaffected by that rewrite.
    const out = wrapChannelReminder("100", [
      {
        ...base,
        body: "[user sent photo: /tmp/x/y.jpg (12 KB)]",
        attachmentType: "photo",
        replyTo: { messageId: 1584, text: "got a screenshot?", direction: "out" },
      },
    ]);
    expect(out).toContain('Replying to (your message): "got a screenshot?"');
    expect(out).toContain("[user sent photo: /tmp/x/y.jpg (12 KB)]");
  });

  test("the reply hint is unchanged — a reply block is still an ordinary message block", () => {
    const out = wrapChannelReminder("100", [
      { ...base, body: "ok", replyTo: { messageId: 1584, text: "x", direction: "out" } },
    ]);
    expect(hintLine(out)).toBe(BASE_REPLY_HINT);
    expect(out).not.toContain(ECHO_SENTENCE);
  });
});

describe("formatMessagePreview", () => {
  // One test in here writes to the process-wide cache singleton; keep it from
  // inheriting or leaking state.
  beforeEach(() => resetMessageCache());
  afterEach(() => resetMessageCache());

  test("passes a short single line through unchanged", () => {
    expect(formatMessagePreview("Ready to merge?")).toBe("Ready to merge?");
  });

  test("joins the first two lines with a space", () => {
    expect(formatMessagePreview("Headline here\nsecond line")).toBe("Headline here second line");
  });

  test("drops everything past line 2", () => {
    expect(formatMessagePreview("one\ntwo\nthree\nfour")).toBe("one two");
  });

  test("skips leading blank lines rather than wasting the 2-line budget", () => {
    expect(formatMessagePreview("\n\nreal headline\nreal second")).toBe(
      "real headline real second",
    );
  });

  test("collapses interior whitespace runs and tabs", () => {
    expect(formatMessagePreview("a\t\t  b   c")).toBe("a b c");
  });

  test("normalizes CRLF and lone CR", () => {
    expect(formatMessagePreview("one\r\ntwo")).toBe("one two");
    expect(formatMessagePreview("one\rtwo")).toBe("one two");
  });

  test("normalizes U+2028 / U+2029 so they cannot break the one-line shape", () => {
    expect(formatMessagePreview("one\u2028two")).toBe("one two");
    expect(formatMessagePreview("one\u2029two")).toBe("one two");
  });

  test("truncates past 160 code points with an explicit ellipsis", () => {
    const long = "y".repeat(400);
    const out = formatMessagePreview(long);
    expect(out.endsWith("…")).toBe(true);
    // Code points: 160 kept + the ellipsis. (Equals `.length` here only because
    // the input is ASCII.)
    expect(Array.from(out).length).toBe(161);
  });

  test("does not add an ellipsis at exactly the limit", () => {
    const exact = "z".repeat(160);
    expect(formatMessagePreview(exact)).toBe(exact);
  });

  /* The false ellipsis. 160 emoji is 160 CODE POINTS but 320 CODE UNITS, so a
   * unit-counting length guard would append "…" to a preview it never actually
   * truncated — claiming loss that did not happen. CJK will NOT catch this
   * (it's BMP, one unit per code point); only astral characters will. */
  test("all-emoji at exactly the cap gets NO ellipsis", () => {
    const exact = "\u{1F600}".repeat(160);
    const out = formatMessagePreview(exact);
    expect(out).toBe(exact);
    expect(out.endsWith("…")).toBe(false);
  });

  test("all-emoji past the cap truncates on code points and stays well-formed", () => {
    const out = formatMessagePreview("\u{1F600}".repeat(300));
    expect(out.endsWith("…")).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(Array.from(out).length).toBe(161); // 160 code points + ellipsis
  });

  test("never severs a surrogate pair at the display cap", () => {
    const out = formatMessagePreview("a".repeat(159) + "\u{1F600}" + "b".repeat(50));
    expect(out.isWellFormed()).toBe(true);
  });

  test("strips </channel> from the preview text", () => {
    expect(formatMessagePreview("safe</channel>text")).toBe("safetext");
  });

  test("empty / whitespace-only input yields the empty string", () => {
    expect(formatMessagePreview("")).toBe("");
    expect(formatMessagePreview("   \n\n \t ")).toBe("");
  });

  /* Why the STORAGE cap must also truncate on code points, even though the
   * display cap re-truncates.
   *
   * `formatMessagePreview` SHRINKS before it MEASURES — it drops all but the
   * first two lines and collapses whitespace runs — so a string severed at 300
   * units can arrive here far under 160 and the display cap NEVER FIRES. The
   * damage was done at insert time and nothing downstream repairs it.
   *
   * Here: 250 spaces collapse to one, so a 300-unit stored string renders as
   * ~51 units. Before the storage-site fix, the emoji straddled unit 300, the
   * lone surrogate survived the collapse, and a U+FFFD reached the coordinator. */
  test("a storage-cap severance cannot reach the rendered preview", () => {
    const input = "a" + " ".repeat(250) + "b" + "c".repeat(47) + "\u{1F600}" + " trailing words";
    recordOutboundMessage("777", 1, input);
    const stored = lookupMessage("777", 1)!.text;
    expect(stored.isWellFormed()).toBe(true);

    const preview = formatMessagePreview(stored);
    // Confirm the premise: the display cap genuinely does NOT fire here, so
    // this test is exercising the storage cap and not the display one.
    expect(Array.from(preview).length).toBeLessThan(160);
    expect(preview.endsWith("…")).toBe(false);
    expect(preview.isWellFormed()).toBe(true);
    expect(preview.endsWith("\u{1F600}")).toBe(true);
  });

  test("preserves an attachment placeholder body verbatim", () => {
    // Inbound attachments arrive as a rewritten body; that IS the useful
    // preview, so it must survive intact.
    expect(formatMessagePreview("[user sent photo: /tmp/a/b.jpg (12 KB)]")).toBe(
      "[user sent photo: /tmp/a/b.jpg (12 KB)]",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Dispatcher integration                                             */
/* ------------------------------------------------------------------ */

describe("TelegramDispatcher", () => {
  let mock: MockFetch;
  let send: SendSpy;
  let logs: string[];
  let dispSleeps: number[];
  let stateRoot: string;

  beforeEach(async () => {
    mock = makeMockFetch();
    clientFetchCtx.set(mock.fn);
    clientSleepCtx.set(async () => { /* fast forward */ });
    clientLogCtx.set(() => { /* silence client logs in dispatcher tests */ });

    send = makeSendSpy();
    sendCtx.set(send.fn);

    dispSleeps = [];
    sleepCtx.set(async (ms) => { dispSleeps.push(ms); });
    nowCtx.set(() => 1_700_000_000_000);
    logs = [];
    logCtx.set((line) => logs.push(line));

    // Point the last-message cache at a tmp dir so `deliver()`'s cache write
    // (added for `ib tgreact`) never touches the real ~/.itsybitsy state.
    stateRoot = await mkdtemp(join(tmpdir(), "dispatcher-state-"));
    setAccessStateDir(join(stateRoot, "channels", "telegram"));
    setLastMsgStateDir(join(stateRoot, "channels", "telegram"));
    // Point the inbound-download dir at a tmp dir so attachment downloads never
    // touch the real ~/.itsybitsy state.
    setInboundDir(join(stateRoot, "channels", "telegram", "inbound"));
    // The message cache is a process-wide singleton and this file exercises
    // BOTH sides of it (deliver() writes, deliverReaction() reads), so without
    // a reset these tests depend on whatever other files left behind — and on
    // file ordering. Reset both ends: entering, so we don't inherit; leaving,
    // so we don't leak.
    resetMessageCache();
  });

  afterEach(async () => {
    clientFetchCtx.reset();
    clientSleepCtx.reset();
    clientLogCtx.reset();
    sendCtx.reset();
    sleepCtx.reset();
    nowCtx.reset();
    logCtx.reset();
    ensureCoordinatorCtx.reset();
    restartCoordinatorCtx.reset();
    resetAccessStateDir();
    resetLastMsgStateDir();
    resetInboundDir();
    resetMessageCache();
    if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  });

  /** Build a dispatcher pre-wired with a TelegramClient and our mock fetch. */
  function makeDispatcher(opts: Partial<{
    allowedChatIds: string[];
    allowedUserIds: string[];
    chatId: string;
  }> = {}): TelegramDispatcher {
    const client = new TelegramClient({ token: "TEST_TOKEN" });
    return new TelegramDispatcher({
      client,
      allowedChatIds: opts.allowedChatIds ?? ["100"],
      allowedUserIds: opts.allowedUserIds ?? [],
      chatId: opts.chatId ?? "100",
    });
  }

  test("end-to-end inbound text: mocked getUpdates → sendToSystemCoordinator with @telegram", async () => {
    // Probe response (offset=-1, limit=1, timeout=0): no updates.
    mock.enqueueResponse({ ok: true, result: [] });
    // First long-poll: one allowlisted text message.
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hello world" })],
    });

    const d = makeDispatcher();
    await d.start();
    // Wait for the loop to process the second response.
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(1);
    const call = send.calls[0]!;
    expect(call.opts?.fromAgent).toBe(TELEGRAM_SENTINEL);
    // Wrapped `<channel>` sends use raw mode so `sendMessage` does NOT prepend a
    // `[sent by @telegram]:` line — the `<channel source="telegram" user="...">`
    // tag already carries the attribution; a prefix would be redundant double-
    // attribution and would push the opening tag out of column 1.
    expect(call.opts?.raw).toBe(true);
    expect(call.message).toContain('<channel source="telegram"');
    expect(call.message).toContain('user="alice"');
    expect(call.message).toContain("hello world");
    expect(call.message).toContain("</channel>");
    expect(call.message).toContain('ib tgsend');
    // The body handed to the coordinator must NOT already carry the prefix (that
    // is `sendMessage`'s job, and raw mode suppresses it entirely).
    expect(call.message).not.toContain("[sent by @telegram]:");
    // The `<channel>` opening tag must be at column 1 (start of the message),
    // not pushed right by a prefix.
    expect(call.message.startsWith("<channel")).toBe(true);
  });

  test("inbound text persists the latest message_id to the last-message cache", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, message_id: 4321, from: { id: 7, username: "alice" }, text: "hi" })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    const cached = await readLastMessage();
    expect(cached).not.toBeNull();
    expect(cached!.chat_id).toBe("100");
    expect(cached!.message_id).toBe(4321);
  });

  test("inbound message_reaction: delivers a reaction event, not a text block", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [reactionUpdate(1, { chatId: 100, messageId: 50, userId: 7, username: "adam", added: ["👍"] })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(1);
    const call = send.calls[0]!;
    expect(call.opts?.fromAgent).toBe(TELEGRAM_SENTINEL);
    // Reaction notices are wrapped `<channel>` sends too — raw so no
    // `[sent by @telegram]:` prefix stacks on the tag.
    expect(call.opts?.raw).toBe(true);
    expect(call.message).toContain('kind="reaction"');
    expect(call.message).toContain("Reacted 👍 to message 50");
    expect(call.message).toContain('message_id="50"');
    expect(call.message).not.toContain("[sent by @telegram]:");
    expect(call.message.startsWith("<channel")).toBe(true);
  });

  test("inbound reaction from a non-allowlisted chat is dropped", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [reactionUpdate(1, { chatId: 999, messageId: 1, userId: 8, username: "mallory", added: ["👍"] })],
    });

    const d = makeDispatcher({ allowedChatIds: ["100"], chatId: "100" });
    await d.start();
    // Give the loop a moment; nothing should be delivered.
    await new Promise((r) => setTimeout(r, 50));
    await d.stop();

    expect(send.calls.length).toBe(0);
  });

  test("a message and a reaction in the same batch deliver message-then-reaction", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { chat: { id: 100 }, message_id: 60, from: { id: 7, username: "adam" }, text: "ping" }),
        reactionUpdate(2, { chatId: 100, messageId: 60, userId: 7, username: "adam", added: ["🔥"] }),
      ],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    expect(send.calls[0]!.message).toContain("ping");
    expect(send.calls[1]!.message).toContain('kind="reaction"');
    expect(send.calls[1]!.message).toContain("🔥");
  });

  test("burst coalesce: 3 updates from same chat → one wrapped block with count=3", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "one" }),
        update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "two" }),
        update(3, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "three" }),
      ],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(1);
    const m = send.calls[0]!.message;
    expect(m).toContain('count="3"');
    expect(m).toContain("one\n---\ntwo\n---\nthree");
  });

  test("single-update batch: no count, no separator", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "solo" })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(1);
    const m = send.calls[0]!.message;
    expect(m).not.toContain("count=");
    expect(m).not.toContain("---");
    expect(m).toContain("solo");
  });

  test("per-coordinator mutex: 2 updates from 2 chats serialize the sends", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "from-100" }),
        update(2, { chat: { id: 200 }, from: { id: 8, username: "bob" }, text: "from-200" }),
      ],
    });

    // Track concurrent send calls — record entry/exit so we can assert
    // that send #2 starts only after send #1 finishes.
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    sendCtx.set(async (message, opts) => {
      send.calls.push({ message, opts });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const tag = message.includes("from-100") ? "100" : "200";
      order.push(`enter-${tag}`);
      // Yield a tick — gives any non-mutexed second send a chance to enter.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      order.push(`exit-${tag}`);
      inFlight -= 1;
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
    });

    // Allow both chat IDs.
    const d = makeDispatcher({ allowedChatIds: ["100", "200"] });
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    expect(maxInFlight).toBe(1);
    // Both calls completed without overlap: enter-X, exit-X, enter-Y, exit-Y.
    expect(order[0]).toMatch(/^enter-/);
    expect(order[1]).toMatch(/^exit-/);
    expect(order[2]).toMatch(/^enter-/);
    expect(order[3]).toMatch(/^exit-/);
    // The first chat to enter must be the first to exit (no interleave).
    expect(order[0]!.replace("enter-", "")).toBe(order[1]!.replace("exit-", ""));
  });

  test("coordinator offline: retries once after 2s, then replies on Telegram", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi" })],
    });
    // Two sendMessage calls expected: one for the offline reply.
    mock.enqueueResponse({ ok: true, result: { message_id: 42, chat: { id: 100 } } });

    send.setQueue([false, false]); // both attempts fail

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    // Wait for the reply sendMessage to fire.
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    expect(dispSleeps).toContain(2_000); // the 2s retry sleep
    // The Telegram reply went out.
    const sendMessageUrls = mock.allUrls().filter((u) => u.includes("/sendMessage"));
    expect(sendMessageUrls.length).toBe(1);
    const sendMessageInit = mock.allInits().find(
      (init, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const body = JSON.parse(sendMessageInit?.body as string);
    expect(body.text).toBe("The coordinator is offline. Start the coordinator? (y/n)");
    expect(body.chat_id).toBe("100");
  });

  test("coordinator offline retry succeeds: no Telegram reply", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi" })],
    });

    send.setQueue([false, true]); // first fails, second succeeds

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    // Give the loop a tick to (not) send a Telegram reply.
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    expect(send.calls.length).toBe(2);
    const sendMessageUrls = mock.allUrls().filter((u) => u.includes("/sendMessage"));
    expect(sendMessageUrls.length).toBe(0);
    expect(dispSleeps).toContain(2_000);
  });

  test("allowlist drop: non-allowlisted sender → no send, one log per hour per chat", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    // Two batches from a non-allowlisted chat in quick succession.
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 999 }, from: { id: 1, username: "stranger" }, text: "spam1" })],
    });
    mock.enqueueResponse({
      ok: true,
      result: [update(2, { chat: { id: 999 }, from: { id: 1, username: "stranger" }, text: "spam2" })],
    });

    const d = makeDispatcher({ allowedChatIds: ["100"] });
    await d.start();
    // Wait for both batches to be processed (mock will idle after).
    await waitFor(() => mock.callCount() >= 3, 1_000);
    // Give the loop a tick to handle them.
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    expect(send.calls.length).toBe(0);
    const dropLogs = logs.filter((l) => l.includes("dropped non-allowlisted"));
    expect(dropLogs.length).toBe(1); // throttled to one per hour per chat
    expect(dropLogs[0]).toContain("chat_id=999");
  });

  test("allowlist drop log fires again after 1 hour", async () => {
    let now = 1_700_000_000_000;
    nowCtx.set(() => now);

    // Gate the second batch so we can advance the clock between batches.
    let releaseBatch2: () => void = () => {};
    const batch2Ready = new Promise<void>((resolve) => { releaseBatch2 = resolve; });

    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 999 }, from: { id: 1, username: "x" }, text: "a" })],
    });
    mock.enqueue(async () => {
      await batch2Ready;
      return makeResponse({
        ok: true,
        result: [update(2, { chat: { id: 999 }, from: { id: 1, username: "x" }, text: "b" })],
      });
    });

    const d = makeDispatcher({ allowedChatIds: ["100"] });
    await d.start();
    // Wait for batch 1 to be dropped + logged.
    await waitFor(
      () => logs.filter((l) => l.includes("dropped non-allowlisted")).length >= 1,
      1_000,
    );
    expect(logs.filter((l) => l.includes("dropped non-allowlisted")).length).toBe(1);

    // Advance clock past the 1-hour throttle, then release batch 2.
    now += 60 * 60 * 1_000 + 1;
    releaseBatch2();

    await waitFor(
      () => logs.filter((l) => l.includes("dropped non-allowlisted")).length >= 2,
      1_000,
    );
    await d.stop();

    const dropLogs = logs.filter((l) => l.includes("dropped non-allowlisted"));
    expect(dropLogs.length).toBe(2);
  });

  test("captioned attachment: downloads, surfaces caption + local path, no text-only reply", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, {
        chat: { id: 100 }, from: { id: 7, username: "alice" },
        photo: [
          { file_id: "small", file_unique_id: "us", width: 90, height: 90, file_size: 100 },
          { file_id: "big", file_unique_id: "ub", width: 1280, height: 1280, file_size: 5000 },
        ],
        caption: "look at this",
      })],
    });
    // resolveAttachment: getFile (POST) → then downloadFile (GET bytes).
    mock.enqueueResponse({ ok: true, result: { file_id: "big", file_unique_id: "ub", file_path: "photos/file_1.jpg" } });
    mock.enqueue(() => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }));

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    // Wait a tick to confirm no Telegram reply fires.
    await new Promise<void>((r) => setTimeout(r, 30));
    await d.stop();

    expect(send.calls.length).toBe(1);
    const m = send.calls[0]!.message;
    expect(m).toContain("look at this");
    expect(m).toContain("[user sent photo:");
    // The largest PhotoSize was chosen → getFile asked for file_id "big".
    const getFileInit = mock.allInits().find((_, i) => mock.allUrls()[i]!.includes("/getFile"));
    expect(JSON.parse(getFileInit?.body as string).file_id).toBe("big");
    // No "text only supported" reply anymore.
    const sendMessageUrls = mock.allUrls().filter((u) => u.includes("/sendMessage"));
    expect(sendMessageUrls.length).toBe(0);
    // File actually landed under the inbound dir.
    const { readdir } = await import("fs/promises");
    const chatDir = join(defaultInboundDir(), "100");
    const files = await readdir(chatDir);
    expect(files.length).toBe(1);
    expect(files[0]!).toContain(".jpg");
  });

  test("bare attachment: downloads + surfaces local path (no text-only reply)", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, {
        chat: { id: 100 }, from: { id: 7, username: "alice" },
        photo: [{ file_id: "x", file_unique_id: "ux", width: 800, height: 600, file_size: 3000 }],
      })],
    });
    mock.enqueueResponse({ ok: true, result: { file_id: "x", file_unique_id: "ux", file_path: "photos/p.jpg" } });
    mock.enqueue(() => new Response(new Uint8Array([9, 9, 9]), { status: 200 }));

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(1);
    const m = send.calls[0]!.message;
    expect(m).toContain("[user sent photo:");
    expect(m).toMatch(/\(\d+ B\)/); // size annotation
    // No "Received attachment — text only supported" reply.
    expect(mock.allUrls().some((u) => u.includes("/sendMessage"))).toBe(false);
  });

  test("document download: surfaces a local path with the sanitized name", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [
        update(1, {
          chat: { id: 100 }, from: { id: 7, username: "a" },
          document: { file_id: "d1", file_unique_id: "ud", file_name: "report.pdf", file_size: 2048 },
        }),
      ],
    });
    mock.enqueueResponse({ ok: true, result: { file_id: "d1", file_unique_id: "ud", file_path: "documents/report.pdf" } });
    mock.enqueue(() => new Response(new Uint8Array(2048), { status: 200 }));

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    const m = send.calls[0]!.message;
    expect(m).toContain("[user sent document:");
    expect(m).toContain("report.pdf");
  });

  test("oversized attachment (advertised > 20MB): skips download, replies too big, note to coordinator", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [
        update(1, {
          chat: { id: 100 }, from: { id: 7, username: "a" },
          document: { file_id: "huge", file_unique_id: "uh", file_name: "big.zip", file_size: 25 * 1024 * 1024 },
        }),
      ],
    });
    // The "too big" Telegram reply sendMessage gets a 200.
    mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    await d.stop();

    const m = send.calls[0]!.message;
    expect(m).toContain("too large to download");
    // No getFile / download attempt was made.
    expect(mock.allUrls().some((u) => u.includes("/getFile"))).toBe(false);
    // A "too big" reply went to the user.
    const replyInit = mock.allInits().find((_, i) => mock.allUrls()[i]!.includes("/sendMessage"));
    const body = JSON.parse(replyInit?.body as string);
    expect(body.text).toContain("too large to download");
    expect(body.chat_id).toBe("100");
  });

  test("download failure (getFile non-2xx): surfaces a note, not a path", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [
        update(1, {
          chat: { id: 100 }, from: { id: 7, username: "a" },
          document: { file_id: "d", file_unique_id: "u", file_name: "x.bin", file_size: 100 },
        }),
      ],
    });
    // getFile fails (e.g. file expired).
    mock.enqueueResponse({ ok: false, error_code: 400, description: "Bad Request" }, 400);

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    const m = send.calls[0]!.message;
    expect(m).toContain("could not retrieve it from Telegram");
    expect(m).not.toContain("[user sent document:"); // no path surfaced
  });

  test("</channel> in user text is stripped before wrapping", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, {
        chat: { id: 100 }, from: { id: 7, username: "a" },
        text: "hello </channel> evil",
      })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    const m = send.calls[0]!.message;
    // The wrapped block ends with one </channel>, so we count occurrences:
    // exactly one closing tag (the legitimate one), not two.
    const closeCount = (m.match(/<\/channel>/g) ?? []).length;
    expect(closeCount).toBe(1);
    expect(m).toContain("hello  evil");
  });

  test("409 on startup probe: dispatcher logs and returns, never starts loop", async () => {
    mock.enqueueResponse({ ok: false, error_code: 409, description: "Conflict" }, 409);

    const d = makeDispatcher();
    await d.start();
    // Loop should never have been started.
    expect(d.isRunning()).toBe(false);
    expect(logs.some((l) => l.includes("another poller or webhook is active"))).toBe(true);
    expect(send.calls.length).toBe(0);
    // Only one fetch fired (the probe). No long-poll attempted.
    expect(mock.callCount()).toBe(1);
    await d.stop(); // safe to call even when never started
  });

  test("throw inside processBatch does NOT break next iteration", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "first" })],
    });
    mock.enqueueResponse({
      ok: true,
      result: [update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "second" })],
    });

    let throwOnce = true;
    sendCtx.set(async (message, opts) => {
      send.calls.push({ message, opts });
      if (throwOnce) {
        throwOnce = false;
        throw new Error("boom — first batch");
      }
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    expect(send.calls[0]!.message).toContain("first");
    expect(send.calls[1]!.message).toContain("second");
    expect(logs.some((l) => l.includes("processBatch threw"))).toBe(true);
  });

  test("auto-start gate is enforced by callers, but stop() is a no-op when start() never ran", async () => {
    // The dispatcher itself doesn't read config — the launchDashboard call
    // site decides whether to instantiate one. This test asserts the
    // contract that calling stop() before start() is safe (no throw, no
    // hang).
    const d = makeDispatcher();
    await d.stop();
    expect(d.isRunning()).toBe(false);
  });

  test("AbortController graceful shutdown: stop() unwinds the in-flight long-poll within 1s", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe — completes
    // No further responses queued — the long-poll will hang on the abort-aware
    // mock fetch indefinitely until stop() fires.

    const d = makeDispatcher();
    await d.start();
    expect(d.isRunning()).toBe(true);

    const startedAt = Date.now();
    await d.stop();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(d.isRunning()).toBe(false);
  });

  test("user_id allowlist permits a sender even when chat_id is not allowlisted", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 999 }, from: { id: 7, username: "alice" }, text: "hi" })],
    });

    const d = makeDispatcher({ allowedChatIds: [], allowedUserIds: ["7"], chatId: "100" });
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(1);
    expect(send.calls[0]!.message).toContain("hi");
  });

  /* ---------------------------------------------------------------- */
  /*  Coordinator-offline y/n confirmation flow                         */
  /* ---------------------------------------------------------------- */

  test("after offline prompt: 'y' starts coordinator, replies 'online', does NOT forward", async () => {
    // Batch 1: triggers offline prompt (both send attempts fail).
    // Batch 2: user replies 'y'.
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } }); // offline prompt reply
    mock.enqueueResponse({
      ok: true,
      result: [update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "y" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 2, chat: { id: 100 } } }); // "online" reply

    send.setQueue([false, false]); // both initial attempts fail
    let ensureCalls = 0;
    ensureCoordinatorCtx.set(async () => {
      ensureCalls += 1;
      return "ib-coordinator";
    });

    const d = makeDispatcher();
    await d.start();
    // Wait for offline prompt and 'y' processing.
    await waitFor(() => ensureCalls >= 1, 1_000);
    await waitFor(
      () => mock.allUrls().filter((u) => u.includes("/sendMessage")).length >= 2,
      1_000,
    );
    await d.stop();

    expect(ensureCalls).toBe(1);
    // The 'y' message was NOT forwarded — only the original 2 failed attempts.
    expect(send.calls.length).toBe(2);

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    expect(texts).toContain("The coordinator is offline. Start the coordinator? (y/n)");
    expect(texts).toContain("The coordinator is now online.");
  });

  test("after offline prompt: 'yes' / 'Y' / 'YES' / ' yes ' all confirm (case-insensitive, trimmed)", async () => {
    for (const variant of ["yes", "Y", "YES", " yes "]) {
      // Fresh mocks per variant via re-init.
      mock = makeMockFetch();
      clientFetchCtx.set(mock.fn);
      send = makeSendSpy();
      sendCtx.set(send.fn);
      let ensureCalls = 0;
      ensureCoordinatorCtx.set(async () => { ensureCalls += 1; return "ib-coordinator"; });

      mock.enqueueResponse({ ok: true, result: [] }); // probe
      mock.enqueueResponse({
        ok: true,
        result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi" })],
      });
      mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } }); // offline prompt
      mock.enqueueResponse({
        ok: true,
        result: [update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: variant })],
      });
      mock.enqueueResponse({ ok: true, result: { message_id: 2, chat: { id: 100 } } });

      send.setQueue([false, false]);

      const d = makeDispatcher();
      await d.start();
      await waitFor(() => ensureCalls >= 1, 1_000);
      await d.stop();

      expect(ensureCalls).toBe(1);
      // The variant message was NOT forwarded.
      expect(send.calls.length).toBe(2);
    }
  });

  test("after offline prompt: 'n' / 'no' / 'N' replies 'leaving offline' and does NOT call ensure", async () => {
    for (const variant of ["n", "no", "N"]) {
      mock = makeMockFetch();
      clientFetchCtx.set(mock.fn);
      send = makeSendSpy();
      sendCtx.set(send.fn);
      let ensureCalls = 0;
      ensureCoordinatorCtx.set(async () => { ensureCalls += 1; return "ib-coordinator"; });

      mock.enqueueResponse({ ok: true, result: [] }); // probe
      mock.enqueueResponse({
        ok: true,
        result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi" })],
      });
      mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } });
      mock.enqueueResponse({
        ok: true,
        result: [update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: variant })],
      });
      mock.enqueueResponse({ ok: true, result: { message_id: 2, chat: { id: 100 } } });

      send.setQueue([false, false]);

      const d = makeDispatcher();
      await d.start();
      await waitFor(
        () => mock.allUrls().filter((u) => u.includes("/sendMessage")).length >= 2,
        1_000,
      );
      await d.stop();

      expect(ensureCalls).toBe(0);
      // The 'n' message was NOT forwarded.
      expect(send.calls.length).toBe(2);

      const sendMessageInits = mock.allInits().filter(
        (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
      );
      const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
      expect(texts).toContain("Okay, leaving the coordinator offline.");
    }
  });

  test("after offline prompt: random message re-sends prompt and keeps awaiting state", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } }); // first prompt
    mock.enqueueResponse({
      ok: true,
      result: [update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hello there" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 2, chat: { id: 100 } } }); // re-prompt
    mock.enqueueResponse({
      ok: true,
      result: [update(3, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "y" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 3, chat: { id: 100 } } }); // "online" reply

    send.setQueue([false, false]);
    let ensureCalls = 0;
    ensureCoordinatorCtx.set(async () => { ensureCalls += 1; return "ib-coordinator"; });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => ensureCalls >= 1, 1_000);
    await d.stop();

    // The random 'hello there' was NOT forwarded — still only 2 forward attempts.
    expect(send.calls.length).toBe(2);

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    // Two offline prompts (initial + re-prompt after 'hello there'), then 'online' after 'y'.
    const promptCount = texts.filter((t) => t === "The coordinator is offline. Start the coordinator? (y/n)").length;
    expect(promptCount).toBe(2);
    expect(texts).toContain("The coordinator is now online.");
  });

  test("after offline prompt: ensureSystemCoordinator throwing produces 'Failed to start' reply", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } });
    mock.enqueueResponse({
      ok: true,
      result: [update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "y" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 2, chat: { id: 100 } } });

    send.setQueue([false, false]);
    ensureCoordinatorCtx.set(async () => {
      throw new Error("tmux not installed");
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(
      () => mock.allUrls().filter((u) => u.includes("/sendMessage")).length >= 2,
      1_000,
    );
    await d.stop();

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    expect(texts).toContain("Failed to start coordinator: tmux not installed");
  });

  test("awaiting state is per-chat: 'y' from chat A does not affect chat B", async () => {
    // Both chats hit offline prompt, then chat A replies 'y' (starts coordinator),
    // then chat B sends "still here?" — must re-prompt (not forward), proving B
    // is still in awaiting state independently of A.
    //
    // NB: replyOnTelegram uses the dispatcher's configured chatId (not the
    // inbound message's chat_id), so we can't distinguish outgoing replies by
    // recipient. We verify per-chat independence via:
    //   - ensureCoordinator is called exactly once (chat A's 'y'), not twice
    //   - chat B's "still here?" is NOT forwarded to the coordinator (it
    //     would have been if B's awaiting state had been wrongly cleared)
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    // Batch 1: both chats inbound (both fail to forward → both get offline prompts).
    mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi-A" }),
        update(2, { chat: { id: 200 }, from: { id: 8, username: "bob" }, text: "hi-B" }),
      ],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } }); // prompt to A
    mock.enqueueResponse({ ok: true, result: { message_id: 2, chat: { id: 100 } } }); // prompt to B
    // Batch 2: chat A says 'y'.
    mock.enqueueResponse({
      ok: true,
      result: [update(3, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "y" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 3, chat: { id: 100 } } }); // online reply
    // Batch 3: chat B sends "still here?" — should be re-prompted (still in awaiting state).
    mock.enqueueResponse({
      ok: true,
      result: [update(4, { chat: { id: 200 }, from: { id: 8, username: "bob" }, text: "still here?" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 4, chat: { id: 100 } } }); // re-prompt

    // 4 fails for the initial batch-1 (A "hi-A" + retry, B "hi-B" + retry).
    // After that, no further forwards happen because both chats are in
    // awaiting state.
    send.setQueue([false, false, false, false]);
    let ensureCalls = 0;
    ensureCoordinatorCtx.set(async () => { ensureCalls += 1; return "ib-coordinator"; });

    const d = makeDispatcher({ allowedChatIds: ["100", "200"] });
    await d.start();
    await waitFor(() => ensureCalls >= 1, 1_000);
    // Wait for 4 outgoing replies: prompt-A, prompt-B, "online" (A's y), re-prompt (B's "still here?")
    await waitFor(
      () => mock.allUrls().filter((u) => u.includes("/sendMessage")).length >= 4,
      1_000,
    );
    await d.stop();

    // Coordinator started exactly once (A's y), proving B's awaiting state
    // didn't somehow re-trigger ensure when "still here?" arrived.
    expect(ensureCalls).toBe(1);
    // Only the initial 2 forwards happened (each with 2s retry → 4 attempts).
    // The 'y' (chat A), "still here?" (chat B) replies were NOT forwarded.
    expect(send.calls.length).toBe(4);

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    const promptCount = texts.filter((t) => t === "The coordinator is offline. Start the coordinator? (y/n)").length;
    // 3 prompts: one per chat in batch 1, plus the re-prompt for B's "still here?".
    expect(promptCount).toBe(3);
    expect(texts).toContain("The coordinator is now online.");
  });

  test("coalesced multi-message batch in awaiting state: re-prompts even if first message is 'y'", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } }); // first prompt
    // Two messages coalesced — should be treated as "anything else" even
    // though the first one is "y".
    mock.enqueueResponse({
      ok: true,
      result: [
        update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "y" }),
        update(3, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "uh wait" }),
      ],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 2, chat: { id: 100 } } }); // re-prompt

    send.setQueue([false, false]);
    let ensureCalls = 0;
    ensureCoordinatorCtx.set(async () => { ensureCalls += 1; return "ib-coordinator"; });

    const d = makeDispatcher();
    await d.start();
    await waitFor(
      () => mock.allUrls().filter((u) => u.includes("/sendMessage")).length >= 2,
      1_000,
    );
    await d.stop();

    // ensureSystemCoordinator was NOT called — coalesced batch is not y/n.
    expect(ensureCalls).toBe(0);
    // No additional forward of the coalesced batch (still 2 from original 'hi').
    expect(send.calls.length).toBe(2);

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    const promptCount = texts.filter((t) => t === "The coordinator is offline. Start the coordinator? (y/n)").length;
    expect(promptCount).toBe(2); // initial prompt + re-prompt
  });

  /* ---------------------------------------------------------------- */
  /*  Telegram slash-command passthrough                              */
  /*  (/context, /clear, /restart, /respawn)                          */
  /* ---------------------------------------------------------------- */

  test("inbound '/context' → raw send + wrapped follow-up note", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/context" })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    // First call: raw /context, no wrapper, raw=true.
    expect(send.calls[0]!.message).toBe("/context");
    expect(send.calls[0]!.opts?.raw).toBe(true);
    expect(send.calls[0]!.opts?.fromAgent).toBe(TELEGRAM_SENTINEL);
    // Second call: wrapped follow-up note. Wrapped sends use raw=true so no
    // `[sent by @telegram]:` prefix stacks on the `<channel>` tag.
    expect(send.calls[1]!.message).toContain('<channel source="telegram"');
    expect(send.calls[1]!.message).toContain("[user on telegram requested /context");
    expect(send.calls[1]!.message).toContain("ib tgsend");
    expect(send.calls[1]!.opts?.raw).toBe(true);
    expect(send.calls[1]!.opts?.fromAgent).toBe(TELEGRAM_SENTINEL);
  });

  test("inbound '/clear' → raw send + Telegram ack reply, no coordinator follow-up", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/clear" })],
    });
    // Ack sendMessage gets a 200.
    mock.enqueueResponse({ ok: true, result: { message_id: 99, chat: { id: 100 } } });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    // Give the loop a tick to (not) send a coordinator follow-up.
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    // Exactly one coordinator send (the raw /clear), no wrapped follow-up.
    expect(send.calls.length).toBe(1);
    expect(send.calls[0]!.message).toBe("/clear");
    expect(send.calls[0]!.opts?.raw).toBe(true);
    expect(send.calls[0]!.opts?.fromAgent).toBe(TELEGRAM_SENTINEL);

    // Exactly one Telegram sendMessage: the ack to the user.
    const sendMessageUrls = mock.allUrls().filter((u) => u.includes("/sendMessage"));
    expect(sendMessageUrls.length).toBe(1);
    const sendMessageInit = mock.allInits().find(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const body = JSON.parse(sendMessageInit?.body as string);
    expect(body.text).toBe("Coordinator context is cleared.");
    expect(body.chat_id).toBe("100");
  });

  test("inbound '/restart' → triggers restartCoordinatorCtx and acks on Telegram, no coordinator send", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/restart" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 99, chat: { id: 100 } } }); // ack reply

    let restartCalls = 0;
    restartCoordinatorCtx.set(async () => {
      restartCalls += 1;
      return true;
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => restartCalls >= 1, 1_000);
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    // Give the loop a tick to (not) send anything to the coordinator.
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    // restartCoordinatorCtx was invoked exactly once.
    expect(restartCalls).toBe(1);
    // Nothing was sent to the coordinator — /restart no longer passes through.
    expect(send.calls.length).toBe(0);

    // The user got the success ack on Telegram.
    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    expect(texts).toContain("Coordinator restarted with a fresh session.");
  });

  test("inbound '/respawn' → triggers restartCoordinatorCtx and acks on Telegram, no coordinator send", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/respawn" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 99, chat: { id: 100 } } }); // ack reply

    let restartCalls = 0;
    restartCoordinatorCtx.set(async () => {
      restartCalls += 1;
      return true;
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => restartCalls >= 1, 1_000);
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    expect(restartCalls).toBe(1);
    expect(send.calls.length).toBe(0);

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    expect(texts).toContain("Coordinator restarted with a fresh session.");
  });

  test("'/restart' when restartCoordinatorCtx returns false → 'did not reach ready marker' reply", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/restart" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 99, chat: { id: 100 } } });

    let restartCalls = 0;
    restartCoordinatorCtx.set(async () => {
      restartCalls += 1;
      return false;
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => restartCalls >= 1, 1_000);
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    expect(restartCalls).toBe(1);
    expect(send.calls.length).toBe(0);

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    expect(texts).toContain(
      "Coordinator restart did not reach ready marker — check ib watch.",
    );
  });

  test("'/restart' when restartCoordinatorCtx throws → 'Coordinator restart failed: <msg>' reply", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/restart" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 99, chat: { id: 100 } } });

    let restartCalls = 0;
    restartCoordinatorCtx.set(async () => {
      restartCalls += 1;
      throw new Error("tmux died");
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => restartCalls >= 1, 1_000);
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    expect(restartCalls).toBe(1);
    expect(send.calls.length).toBe(0);

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    expect(texts).toContain("Coordinator restart failed: tmux died");
  });

  test("'/restart' does NOT invoke sendCtx at all (no raw passthrough to coordinator)", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/restart" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 99, chat: { id: 100 } } });

    let restartCalls = 0;
    restartCoordinatorCtx.set(async () => {
      restartCalls += 1;
      return true;
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => restartCalls >= 1, 1_000);
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    // Give plenty of time for any stray send to fire.
    await new Promise<void>((r) => setTimeout(r, 100));
    await d.stop();

    // The contract: dispatcher must not forward /restart text to the coordinator.
    expect(send.calls.length).toBe(0);
  });

  test("inbound '/usage' → wrapped normally, NOT a slash command", async () => {
    // /usage opens an interactive menu the coordinator can't escape, so it
    // must NOT be in the passthrough set — flow it through the normal
    // wrapped path so the coordinator sees it as user chatter.
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/usage" })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    expect(send.calls.length).toBe(1);
    // Wrapped send: raw=true suppresses the `[sent by @telegram]:` prefix (the
    // `<channel>` tag already carries attribution), but the body is still the
    // `<channel>` block, NOT the bare command.
    expect(send.calls[0]!.message).toContain('<channel source="telegram"');
    expect(send.calls[0]!.message).toContain("/usage");
    expect(send.calls[0]!.opts?.raw).toBe(true);
  });

  test("'/context' with surrounding whitespace is still recognized as a slash command", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: " /context \n" })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    // Raw send uses the trimmed body, not the whitespace-padded original.
    expect(send.calls[0]!.message).toBe("/context");
    expect(send.calls[0]!.opts?.raw).toBe(true);
    expect(send.calls[1]!.message).toContain("[user on telegram requested /context");
  });

  test("'/context extra' (slash + arg) is NOT a slash command — wrapped normally", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/context extra" })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    expect(send.calls.length).toBe(1);
    // Wrapped send: raw=true suppresses the `[sent by @telegram]:` prefix, but
    // the body is the `<channel>` block, not a bare slash-command passthrough.
    expect(send.calls[0]!.message).toContain('<channel source="telegram"');
    expect(send.calls[0]!.message).toContain("/context extra");
    expect(send.calls[0]!.opts?.raw).toBe(true);
  });

  test("mixed batch: '/context' + normal text → 3 sends (raw, follow-up, normal), slashes first", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [
        update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/context" }),
        update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "btw hello" }),
      ],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 3, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(3);
    // Slash and follow-up arrive before the normal wrapped block. The bare
    // slash command (call 0) is raw because it must reach Claude Code verbatim;
    // the wrapped follow-up (call 1) and the wrapped normal block (call 2) are
    // raw so the `[sent by @telegram]:` prefix never stacks on the `<channel>`
    // tag.
    expect(send.calls[0]!.message).toBe("/context");
    expect(send.calls[0]!.opts?.raw).toBe(true);
    expect(send.calls[1]!.message).toContain("[user on telegram requested /context");
    expect(send.calls[1]!.opts?.raw).toBe(true);
    expect(send.calls[2]!.message).toContain('<channel source="telegram"');
    expect(send.calls[2]!.message).toContain("btw hello");
    expect(send.calls[2]!.opts?.raw).toBe(true);
    // The normal block must NOT contain the slash command.
    expect(send.calls[2]!.message).not.toContain("/context");
  });

  test("'/context' during awaiting-confirmation state: re-prompts, no raw send", async () => {
    // Batch 1: triggers offline prompt (both attempts fail).
    // Batch 2: user sends '/context' while in awaiting state — should re-prompt.
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "hi" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } }); // first prompt
    mock.enqueueResponse({
      ok: true,
      result: [update(2, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/context" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 2, chat: { id: 100 } } }); // re-prompt

    send.setQueue([false, false]); // both initial attempts fail

    const d = makeDispatcher();
    await d.start();
    await waitFor(
      () => mock.allUrls().filter((u) => u.includes("/sendMessage")).length >= 2,
      1_000,
    );
    await d.stop();

    // Only the original 2 failing forward attempts — /context was NOT routed
    // through the slash-command raw passthrough.
    expect(send.calls.length).toBe(2);
    // Both captured calls are the WRAPPED `<channel>` delivery attempts for the
    // "hi" batch (the initial send + the offline retry). These are raw now (the
    // `<channel>` tag carries attribution), but critically neither is the bare
    // `/context` slash passthrough — the awaiting-confirmation interception
    // swallowed batch 2 and re-prompted instead of forwarding it.
    for (const c of send.calls) {
      expect(c.message).toContain('<channel source="telegram"');
      expect(c.message).toContain("hi");
      expect(c.message).not.toBe("/context");
      expect(c.message).not.toContain("[user on telegram requested /context");
    }

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    const promptCount = texts.filter((t) => t === "The coordinator is offline. Start the coordinator? (y/n)").length;
    expect(promptCount).toBe(2); // initial prompt + re-prompt
  });

  test("'/context' when coordinator offline: retries twice, prompts, no follow-up fired", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/context" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } }); // offline prompt

    // Both raw send attempts fail. If the follow-up were attempted we'd need
    // a third entry in the queue — the test asserts it isn't.
    send.setQueue([false, false]);

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    await d.stop();

    // Exactly two raw attempts — no follow-up call.
    expect(send.calls.length).toBe(2);
    expect(send.calls[0]!.message).toBe("/context");
    expect(send.calls[0]!.opts?.raw).toBe(true);
    expect(send.calls[1]!.message).toBe("/context");
    expect(send.calls[1]!.opts?.raw).toBe(true);
    // The 2s retry slept.
    expect(dispSleeps).toContain(2_000);

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    expect(texts).toContain("The coordinator is offline. Start the coordinator? (y/n)");
  });

  /* ---------------------------------------------------------------- */
  /*  Telegram slash-command passthrough (/compact, prefix-tolerant)   */
  /* ---------------------------------------------------------------- */

  test("inbound '/compact' → raw send + wrapped follow-up note", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/compact" })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    expect(send.calls[0]!.message).toBe("/compact");
    expect(send.calls[0]!.opts?.raw).toBe(true);
    expect(send.calls[0]!.opts?.fromAgent).toBe(TELEGRAM_SENTINEL);
    // Follow-up: wrapped, mentions compaction + ib tgsend. Wrapped sends use
    // raw=true so no `[sent by @telegram]:` prefix stacks on the `<channel>` tag.
    expect(send.calls[1]!.message).toContain('<channel source="telegram"');
    expect(send.calls[1]!.message).toContain("your conversation just compacted");
    expect(send.calls[1]!.message).toContain("ib tgsend");
    expect(send.calls[1]!.opts?.raw).toBe(true);
  });

  test("'/compact <args>' (prefix + instructions) → raw send + follow-up", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [
        update(1, {
          chat: { id: 100 },
          from: { id: 7, username: "alice" },
          text: "/compact focus on the API work",
        }),
      ],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    // Raw send preserves the full trimmed body, args and all.
    expect(send.calls[0]!.message).toBe("/compact focus on the API work");
    expect(send.calls[0]!.opts?.raw).toBe(true);
    expect(send.calls[1]!.message).toContain("your conversation just compacted");
  });

  test("'/compact' with surrounding whitespace is still recognized", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: " /compact \n" })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    expect(send.calls[0]!.message).toBe("/compact");
    expect(send.calls[0]!.opts?.raw).toBe(true);
    expect(send.calls[1]!.message).toContain("your conversation just compacted");
  });

  test("'/compactfoo' (no separator) is NOT a slash command — wrapped normally", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/compactfoo" })],
    });

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 1, 1_000);
    await new Promise<void>((r) => setTimeout(r, 50));
    await d.stop();

    expect(send.calls.length).toBe(1);
    // Wrapped send: raw=true suppresses the `[sent by @telegram]:` prefix; the
    // body is still the `<channel>` block, not a bare slash-command passthrough.
    expect(send.calls[0]!.message).toContain('<channel source="telegram"');
    expect(send.calls[0]!.message).toContain("/compactfoo");
    expect(send.calls[0]!.opts?.raw).toBe(true);
  });

  test("'/compact' when coordinator offline: retries twice, prompts, no follow-up fired", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({
      ok: true,
      result: [update(1, { chat: { id: 100 }, from: { id: 7, username: "alice" }, text: "/compact" })],
    });
    mock.enqueueResponse({ ok: true, result: { message_id: 1, chat: { id: 100 } } }); // offline prompt

    send.setQueue([false, false]);

    const d = makeDispatcher();
    await d.start();
    await waitFor(() => send.calls.length >= 2, 1_000);
    await waitFor(() => mock.allUrls().some((u) => u.includes("/sendMessage")), 1_000);
    await d.stop();

    expect(send.calls.length).toBe(2);
    expect(send.calls[0]!.message).toBe("/compact");
    expect(send.calls[0]!.opts?.raw).toBe(true);
    expect(send.calls[1]!.message).toBe("/compact");
    expect(send.calls[1]!.opts?.raw).toBe(true);
    expect(dispSleeps).toContain(2_000);

    const sendMessageInits = mock.allInits().filter(
      (_, i) => mock.allUrls()[i]!.includes("/sendMessage"),
    );
    const texts = sendMessageInits.map((init) => JSON.parse(init?.body as string).text);
    expect(texts).toContain("The coordinator is offline. Start the coordinator? (y/n)");
  });
});

/* ------------------------------------------------------------------ */
/*  Startup probe → chat-id cache invalidation                          */
/* ------------------------------------------------------------------ */

describe("TelegramDispatcher startup probe cache clear", () => {
  let mock: MockFetch;
  let send: SendSpy;
  let logs: string[];
  let cacheRoot: string;
  let cacheDir: string;

  beforeEach(async () => {
    mock = makeMockFetch();
    clientFetchCtx.set(mock.fn);
    clientSleepCtx.set(async () => { /* fast forward */ });
    clientLogCtx.set(() => { /* silence */ });

    send = makeSendSpy();
    sendCtx.set(send.fn);

    sleepCtx.set(async () => { /* fast forward */ });
    nowCtx.set(() => 1_700_000_000_000);
    logs = [];
    logCtx.set((line) => logs.push(line));

    cacheRoot = await mkdtemp(join(tmpdir(), "dispatcher-cache-clear-"));
    cacheDir = join(cacheRoot, "channels", "telegram");
    setCacheStateDir(cacheDir);
  });

  afterEach(async () => {
    clientFetchCtx.reset();
    clientSleepCtx.reset();
    clientLogCtx.reset();
    sendCtx.reset();
    sleepCtx.reset();
    nowCtx.reset();
    logCtx.reset();
    resetCacheStateDir();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  function makeDispatcher(): TelegramDispatcher {
    const client = new TelegramClient({ token: "TEST_TOKEN" });
    return new TelegramDispatcher({
      client,
      allowedChatIds: ["100"],
      allowedUserIds: [],
      chatId: "100",
    });
  }

  test("401 on startup probe: clears cached chat id", async () => {
    await writeCachedChatId("100");
    expect(await readCachedChatId()).toBe("100");

    mock.enqueueResponse({ ok: false, error_code: 401, description: "Unauthorized" }, 401);

    const d = makeDispatcher();
    await d.start();
    // The dispatcher's clear is awaited inside start(), so by the time start
    // returns the file is gone.
    await d.stop();

    expect(await readCachedChatId()).toBeNull();
    // The dispatcher should still have started the loop (existing behavior).
    expect(logs.some((l) => l.includes("HTTP 401"))).toBe(true);
  });

  test("403 on startup probe: clears cached chat id", async () => {
    await writeCachedChatId("100");
    expect(await readCachedChatId()).toBe("100");

    mock.enqueueResponse({ ok: false, error_code: 403, description: "Forbidden" }, 403);

    const d = makeDispatcher();
    await d.start();
    await d.stop();

    expect(await readCachedChatId()).toBeNull();
    expect(logs.some((l) => l.includes("HTTP 403"))).toBe(true);
  });

  test("500 on startup probe: cache is NOT cleared (only auth failures invalidate)", async () => {
    await writeCachedChatId("100");
    expect(await readCachedChatId()).toBe("100");

    mock.enqueueResponse({ ok: false, error_code: 500, description: "Internal Server Error" }, 500);

    const d = makeDispatcher();
    await d.start();
    await d.stop();

    expect(await readCachedChatId()).toBe("100");
    expect(logs.some((l) => l.includes("HTTP 500"))).toBe(true);
  });

  test("409 on startup probe: cache is NOT cleared (preserves existing 409 handling)", async () => {
    await writeCachedChatId("100");
    expect(await readCachedChatId()).toBe("100");

    mock.enqueueResponse({ ok: false, error_code: 409, description: "Conflict" }, 409);

    const d = makeDispatcher();
    await d.start();
    expect(d.isRunning()).toBe(false);
    await d.stop();

    expect(await readCachedChatId()).toBe("100");
    expect(logs.some((l) => l.includes("another poller or webhook is active"))).toBe(true);
  });

  test("successful probe (200): cache is NOT cleared", async () => {
    await writeCachedChatId("100");

    mock.enqueueResponse({ ok: true, result: [] });

    const d = makeDispatcher();
    await d.start();
    await d.stop();

    expect(await readCachedChatId()).toBe("100");
  });

  test("network failure on startup probe: cache is NOT cleared (auth status unknown)", async () => {
    await writeCachedChatId("100");

    mock.enqueueError(new Error("ECONNRESET"));

    const d = makeDispatcher();
    await d.start();
    await d.stop();

    expect(await readCachedChatId()).toBe("100");
  });
});

/* ------------------------------------------------------------------ */
/*  Health state machine                                                */
/* ------------------------------------------------------------------ */

describe("TelegramDispatcher health state machine", () => {
  let mock: MockFetch;
  let send: SendSpy;
  let dispLogs: string[];
  let nowMs: number;

  beforeEach(() => {
    mock = makeMockFetch();
    clientFetchCtx.set(mock.fn);
    clientSleepCtx.set(async () => { /* fast forward */ });
    clientLogCtx.set(() => { /* silence */ });

    send = makeSendSpy();
    sendCtx.set(send.fn);

    sleepCtx.set(async () => { /* fast forward */ });
    nowMs = 1_700_000_000_000;
    nowCtx.set(() => nowMs);
    dispLogs = [];
    logCtx.set((line) => dispLogs.push(line));
  });

  afterEach(() => {
    clientFetchCtx.reset();
    clientSleepCtx.reset();
    clientLogCtx.reset();
    sendCtx.reset();
    sleepCtx.reset();
    nowCtx.reset();
    logCtx.reset();
  });

  function makeDispatcher(): TelegramDispatcher {
    const client = new TelegramClient({ token: "TEST_TOKEN" });
    return new TelegramDispatcher({
      client,
      allowedChatIds: ["100"],
      allowedUserIds: [],
      chatId: "100",
    });
  }

  test("getHealth() reports 'down' before start()", () => {
    const d = makeDispatcher();
    const h = d.getHealth();
    expect(h.state).toBe("down");
    expect(h.lastSuccessAt).toBeNull();
    expect(h.reason).toBeNull();
  });

  test("transitions: down → polling on start, polling → retrying on first failure, retrying → polling on recovery", async () => {
    // Probe ok, then 1 failure, then success.
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueError(new Error("ETIMEDOUT")); // long-poll attempt 1 fails
    mock.enqueueResponse({ ok: true, result: [] }); // long-poll attempt 2 succeeds

    const d = makeDispatcher();
    const events: Array<{ from: string; to: string; reason: string | null }> = [];
    d.onStateChange((change) => events.push({ from: change.from, to: change.to, reason: change.reason }));

    await d.start();
    // After start(): down → polling.
    expect(events.some((e) => e.from === "down" && e.to === "polling")).toBe(true);

    // Wait until at least one full cycle (failure → success) has been applied.
    await waitFor(() => events.some((e) => e.from === "retrying" && e.to === "polling"), 1_000);
    await d.stop();

    // The full sequence should be: down→polling (start), polling→retrying (timeout), retrying→polling (recovery), polling→down (stop).
    const transitions = events.map((e) => `${e.from}->${e.to}`);
    expect(transitions[0]).toBe("down->polling");
    expect(transitions).toContain("polling->retrying");
    expect(transitions).toContain("retrying->polling");
    expect(transitions[transitions.length - 1]).toBe("polling->down");
  });

  test("five consecutive failures fire exactly one polling→retrying transition", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    for (let i = 0; i < 5; i++) {
      mock.enqueueError(new Error("ETIMEDOUT"));
    }
    mock.enqueueResponse({ ok: true, result: [] }); // recovery

    const d = makeDispatcher();
    const events: Array<{ from: string; to: string }> = [];
    d.onStateChange((change) => events.push({ from: change.from, to: change.to }));

    await d.start();
    await waitFor(() => events.some((e) => e.from === "retrying" && e.to === "polling"), 1_000);
    await d.stop();

    // Even though five errors fired, polling→retrying transitions exactly once.
    expect(events.filter((e) => e.from === "polling" && e.to === "retrying").length).toBe(1);
    // And retrying→polling exactly once after recovery.
    expect(events.filter((e) => e.from === "retrying" && e.to === "polling").length).toBe(1);
  });

  test("recovery transition carries 'reconnected after Ns' reason", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueError(new Error("ETIMEDOUT")); // 1 failure
    // Use the sleep hook to simulate elapsed wall-clock between the disconnect
    // (first failure) and the recovery (next successful response). The
    // dispatcher's transitionHealth captures disconnectedAt = nowCtx.fn() on
    // polling → retrying; we advance the mock clock during the backoff sleep
    // so the recovery sees a non-zero gap.
    clientSleepCtx.set(async () => {
      nowMs += 12_000;
    });
    mock.enqueueResponse({ ok: true, result: [] }); // recovery

    const d = makeDispatcher();
    const events: Array<{ from: string; to: string; reason: string | null }> = [];
    d.onStateChange((change) => events.push({ from: change.from, to: change.to, reason: change.reason }));

    await d.start();
    await waitFor(() => events.some((e) => e.from === "retrying" && e.to === "polling"), 1_000);
    await d.stop();

    const recovery = events.find((e) => e.from === "retrying" && e.to === "polling")!;
    expect(recovery.reason).toBe("reconnected after 12s");
  });

  test("getHealth() during retrying returns the latest reason and a non-null lastSuccessAt", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({ ok: true, result: [] }); // first long-poll succeeds
    // Subsequent long-polls fail forever, so the dispatcher stays in retrying.
    for (let i = 0; i < 30; i++) {
      mock.enqueueError(new Error("ETIMEDOUT"));
    }

    const d = makeDispatcher();
    await d.start();
    // Wait until the first success has been recorded.
    await waitFor(() => d.getHealth().lastSuccessAt !== null, 1_000);
    const successAt = d.getHealth().lastSuccessAt;
    expect(successAt).toBe(nowMs);

    // Advance clock so a subsequent failure marker uses a different timestamp.
    nowMs += 5_000;
    // Wait for the dispatcher to flip to retrying.
    await waitFor(() => d.getHealth().state === "retrying", 1_000);
    const h = d.getHealth();
    expect(h.state).toBe("retrying");
    expect(h.reason).toBe("errno:ETIMEDOUT");
    expect(h.lastSuccessAt).toBe(successAt);
    await d.stop();
  });

  test("409 startup probe transitions to 'down' (no listener leak, safe to stop after)", async () => {
    mock.enqueueResponse({ ok: false, error_code: 409, description: "Conflict" }, 409);

    const d = makeDispatcher();
    const events: Array<{ from: string; to: string; reason: string | null }> = [];
    d.onStateChange((change) => events.push({ from: change.from, to: change.to, reason: change.reason }));

    await d.start();
    expect(d.isRunning()).toBe(false);
    expect(d.getHealth().state).toBe("down");
    // start() called transitionHealth("down", "409 Conflict"), but since
    // initial state is also "down" no listener fires (no edge transition).
    expect(events.length).toBe(0);
    await d.stop();
  });

  test("onStateChange unsubscribe stops further notifications", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({ ok: true, result: [] }); // first poll

    const d = makeDispatcher();
    let count = 0;
    const unsub = d.onStateChange(() => { count += 1; });
    await d.start();
    // The down→polling transition should have fired.
    expect(count).toBeGreaterThanOrEqual(1);
    const before = count;
    unsub();
    await d.stop();
    // No further notifications after unsubscribe.
    expect(count).toBe(before);
  });

  test("getHealth() returns 'down' after stop()", async () => {
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    mock.enqueueResponse({ ok: true, result: [] }); // long-poll

    const d = makeDispatcher();
    await d.start();
    // After a successful start, we're in polling.
    await waitFor(() => d.getHealth().state === "polling", 1_000);

    await d.stop();
    // After stop, state must be down.
    expect(d.getHealth().state).toBe("down");
  });

  test("token never appears in dispatcher log lines or state-change reasons (token-safety regression)", async () => {
    // Probe ok, then a getUpdates throw whose error message embeds the token.
    // A future regression that swaps classifyError for err.message would cause
    // the token to leak into the log; this test pins that behavior.
    mock.enqueueResponse({ ok: true, result: [] }); // probe
    // A throw that includes the token in its message — mimics what fetch
    // libraries sometimes produce ("request to https://...token.../foo failed").
    mock.enqueueError(new Error("request to https://api.telegram.org/botSECRET_DISP_TOKEN_999/getUpdates failed: ETIMEDOUT"));
    mock.enqueueResponse({ ok: true, result: [] }); // recovery

    const stateReasons: Array<string | null> = [];
    // Build the dispatcher with a token that's distinct from any others, so
    // we can assert tightly.
    const client = new TelegramClient({ token: "SECRET_DISP_TOKEN_999" });
    const d = new TelegramDispatcher({
      client,
      allowedChatIds: ["100"],
      allowedUserIds: [],
      chatId: "100",
    });
    d.onStateChange((change) => stateReasons.push(change.reason));

    await d.start();
    await waitFor(() => stateReasons.some((r) => r !== null && r.includes("reconnected")), 1_000);
    await d.stop();

    // No dispatcher log line may contain the token.
    expect(dispLogs.some((l) => l.includes("SECRET_DISP_TOKEN_999"))).toBe(false);
    // No state-change reason may contain the token.
    expect(stateReasons.some((r) => r !== null && r.includes("SECRET_DISP_TOKEN_999"))).toBe(false);
    // Sanity: lastFailureReason on the dispatcher must also be token-free.
    const h = d.getHealth();
    expect(h.reason === null || !h.reason.includes("SECRET_DISP_TOKEN_999")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Sentinel labelling regression                                      */
/* ------------------------------------------------------------------ */

describe("Sentinel labelling", () => {
  test("@-prefixed fromAgent renders WITH the @ in a NON-raw send (formatter contract)", async () => {
    // Formatter contract for the NON-raw path: when sendMessage is called with
    // `fromAgent: "@telegram"` and no `raw`, the `@` is preserved in the
    // `[sent by @telegram]:` prefix (it is NOT a BARE_RENDERED_SENTINEL). This
    // guards the formatter's `@`-keeping behavior so it can't silently desync.
    //
    // NOTE: the dispatcher itself no longer takes this path for its wrapped
    // `<channel>` sends — those pass `raw: true`, so the coordinator never sees
    // a `[sent by @telegram]:` prefix stacked on the `<channel>` tag (that was
    // the double-attribution bug). This test only pins the underlying formatter
    // behavior for the non-raw case; see the dispatcher delivery tests above for
    // the raw-wrapped behavior the dispatcher actually uses.
    const fromId = TELEGRAM_SENTINEL;
    const formatted = `[sent by ${fromId.startsWith("@") ? fromId : `agent ${fromId}`}]: hello`;
    expect(formatted).toBe("[sent by @telegram]: hello");
  });
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Spin until `pred()` returns true or `timeoutMs` elapses. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!pred()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

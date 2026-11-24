import { test, expect, describe } from "bun:test";
import {
  HELP_DETAIL_WIDTH,
  deriveTelegramConnection,
  disabledReason,
  formatAgo,
  sameTelegramConnection,
  telegramHelpDetail,
  telegramLight,
  type TelegramConnectionView,
} from "./connection-view";
import type { DispatcherHealth } from "./dispatcher";
import type { OutboxHealth } from "./outbox";

const polling: DispatcherHealth = { state: "polling", lastSuccessAt: 1, reason: null, reasonAt: null };
const healthyOutbox: OutboxHealth = { pending: 0, stalled: false, lastError: null, lastErrorAt: null };

function view(partial: Partial<TelegramConnectionView>): TelegramConnectionView {
  return { state: "connected", lastError: null, lastErrorAt: null, outboxPending: 0, ...partial };
}

describe("deriveTelegramConnection", () => {
  test("boot connecting, with and without an error yet, carries the queued item count", () => {
    expect(deriveTelegramConnection({ phase: "connecting", lastError: null, lastErrorAt: null, outboxPending: 0 })).toEqual(
      view({ state: "connecting" }),
    );
    expect(
      deriveTelegramConnection({ phase: "connecting", lastError: "HTTP 502", lastErrorAt: 500, outboxPending: 2 }),
    ).toEqual(view({ state: "connecting", lastError: "HTTP 502", lastErrorAt: 500, outboxPending: 2 }));
  });

  test("boot disabled carries the reason and the queued item count", () => {
    expect(
      deriveTelegramConnection({ phase: "disabled", reason: "bot token rejected (HTTP 401)", at: 9, outboxPending: 1 }),
    ).toEqual(view({ state: "disabled", lastError: "bot token rejected (HTTP 401)", lastErrorAt: 9, outboxPending: 1 }));
  });

  test("running: polling and a healthy outbox is connected, with the pending count", () => {
    expect(
      deriveTelegramConnection({
        phase: "running",
        dispatcherStarted: true,
        dispatcher: polling,
        outbox: { ...healthyOutbox, pending: 1 },
      }),
    ).toEqual(view({ state: "connected", outboxPending: 1 }));
  });

  test("running: a retrying dispatcher is reconnecting with its reason and time", () => {
    expect(
      deriveTelegramConnection({
        phase: "running",
        dispatcherStarted: true,
        dispatcher: { state: "retrying", lastSuccessAt: 1, reason: "HTTP 502", reasonAt: 40 },
        outbox: { pending: 2, stalled: true, lastError: "sendMessage failed: HTTP 502", lastErrorAt: 50 },
      }),
    ).toEqual(view({ state: "reconnecting", lastError: "HTTP 502", lastErrorAt: 40, outboxPending: 2 }));
  });

  test("running: a stalled outbox under a polling dispatcher is reconnecting with the outbox's error", () => {
    expect(
      deriveTelegramConnection({
        phase: "running",
        dispatcherStarted: true,
        dispatcher: polling,
        outbox: { pending: 3, stalled: true, lastError: "errno:ECONNRESET", lastErrorAt: 70 },
      }),
    ).toEqual(view({ state: "reconnecting", lastError: "errno:ECONNRESET", lastErrorAt: 70, outboxPending: 3 }));
  });

  test("running: down before start() settles is connecting; after, it is disabled", () => {
    const down: DispatcherHealth = { state: "down", lastSuccessAt: null, reason: "409 Conflict", reasonAt: 5 };
    expect(
      deriveTelegramConnection({ phase: "running", dispatcherStarted: false, dispatcher: down, outbox: healthyOutbox }),
    ).toEqual(view({ state: "connecting" }));
    expect(
      deriveTelegramConnection({ phase: "running", dispatcherStarted: true, dispatcher: down, outbox: healthyOutbox }),
    ).toEqual(view({ state: "disabled", lastError: "409 Conflict", lastErrorAt: 5 }));
    expect(
      deriveTelegramConnection({
        phase: "running",
        dispatcherStarted: true,
        dispatcher: { state: "down", lastSuccessAt: null, reason: null, reasonAt: null },
        outbox: healthyOutbox,
      }),
    ).toEqual(view({ state: "disabled", lastError: "poll loop stopped" }));
  });
});

describe("telegramLight", () => {
  test("green connected, yellow connecting/reconnecting, red disabled", () => {
    expect(telegramLight(view({ state: "connected" }))).toBe("green");
    expect(telegramLight(view({ state: "connecting" }))).toBe("yellow");
    expect(telegramLight(view({ state: "reconnecting" }))).toBe("yellow");
    expect(telegramLight(view({ state: "disabled" }))).toBe("red");
  });
});

describe("telegramHelpDetail", () => {
  const now = 1_000_000;

  test("connected, with and without queued items", () => {
    expect(telegramHelpDetail(view({ state: "connected" }), now)).toEqual(["connected"]);
    expect(telegramHelpDetail(view({ state: "connected", outboxPending: 2 }), now)).toEqual(["connected; 2 queued"]);
  });

  test("reconnecting shows the error, its age and the queue", () => {
    expect(
      telegramHelpDetail(
        view({ state: "reconnecting", lastError: "HTTP 502", lastErrorAt: now - 40_000, outboxPending: 2 }),
        now,
      ),
    ).toEqual(["reconnecting — HTTP 502 (40s ago); 2 queued"]);
  });

  test("connecting with and without an error", () => {
    expect(telegramHelpDetail(view({ state: "connecting" }), now)).toEqual(["connecting"]);
    expect(
      telegramHelpDetail(view({ state: "connecting", lastError: "errno:ETIMEDOUT", lastErrorAt: now - 12_000 }), now),
    ).toEqual(["connecting — errno:ETIMEDOUT (12s ago)"]);
    // Messages dropped while boot is still connecting are counted too.
    expect(
      telegramHelpDetail(
        view({ state: "connecting", lastError: "HTTP 502", lastErrorAt: now - 40_000, outboxPending: 2 }),
        now,
      ),
    ).toEqual(["connecting — HTTP 502 (40s ago); 2 queued"]);
  });

  test("disabled shows the reason and no age", () => {
    expect(
      telegramHelpDetail(view({ state: "disabled", lastError: "bot token rejected (HTTP 401)", lastErrorAt: now - 5_000 }), now),
    ).toEqual(["disabled — bot token rejected (HTTP 401)"]);
  });

  test("a long reason wraps at word boundaries within the panel width", () => {
    const reason = "no recent inbound from an allowlisted private chat. DM your bot, then restart ib watch.";
    const lines = telegramHelpDetail(view({ state: "disabled", lastError: reason }), now);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(HELP_DETAIL_WIDTH);
    expect(lines.join(" ")).toBe(`disabled — ${reason}`);
  });
});

describe("formatAgo", () => {
  test("seconds, minutes, hours; negative clamps to 0s", () => {
    expect(formatAgo(0)).toBe("0s ago");
    expect(formatAgo(59_999)).toBe("59s ago");
    expect(formatAgo(60_000)).toBe("1m ago");
    expect(formatAgo(59 * 60_000 + 59_000)).toBe("59m ago");
    expect(formatAgo(3_600_000)).toBe("1h ago");
    expect(formatAgo(24 * 3_600_000 - 1)).toBe("23h ago");
    expect(formatAgo(24 * 3_600_000)).toBe("1d ago");
    expect(formatAgo(50 * 3_600_000)).toBe("2d ago");
    expect(formatAgo(-5_000)).toBe("0s ago");
  });
});

describe("disabledReason", () => {
  test("strips boot's prefix; keeps other text whole", () => {
    expect(disabledReason("Telegram routing disabled: bot token rejected (HTTP 403)")).toBe("bot token rejected (HTTP 403)");
    expect(disabledReason("something else")).toBe("something else");
  });
});

describe("sameTelegramConnection", () => {
  test("compares every field; null only equals null", () => {
    const a = view({ state: "reconnecting", lastError: "HTTP 502", lastErrorAt: 1, outboxPending: 1 });
    expect(sameTelegramConnection(a, { ...a })).toBe(true);
    expect(sameTelegramConnection(a, { ...a, outboxPending: 2 })).toBe(false);
    expect(sameTelegramConnection(a, { ...a, lastErrorAt: 2 })).toBe(false);
    expect(sameTelegramConnection(a, { ...a, lastError: "HTTP 503" })).toBe(false);
    expect(sameTelegramConnection(a, { ...a, state: "connecting" })).toBe(false);
    expect(sameTelegramConnection(null, a)).toBe(false);
    expect(sameTelegramConnection(null, null)).toBe(true);
  });
});

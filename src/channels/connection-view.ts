/**
 * The Telegram connection as `ib watch` shows it: one state derived from the
 * boot, the inbound poll loop (dispatcher.ts) and the outbox (outbox.ts).
 * Pure functions only, so every mapping is unit-tested without a dashboard:
 *
 *   - {@link deriveTelegramConnection}: inputs → state, last error, pending.
 *   - {@link telegramLight}: state → header light color.
 *   - {@link telegramHelpDetail}: state → the `?` help panel's Telegram row.
 *
 * The same view is written to the status file (connection-status.ts) by the
 * monitor (connection-monitor.ts).
 *
 * | state          | when                                                  | light  |
 * |----------------|-------------------------------------------------------|--------|
 * | `connecting`   | boot retrying, or dispatcher not started yet          | yellow |
 * | `connected`    | dispatcher polling and outbox not stalled             | green  |
 * | `reconnecting` | dispatcher retrying, or outbox stalled                | yellow |
 * | `disabled`     | boot returned ok:false, or the poll loop went down    | red    |
 */

import type { TelegramConnectionState } from "./connection-status";
import type { DispatcherHealth } from "./dispatcher";
import type { OutboxHealth } from "./outbox";

export interface TelegramConnectionView {
  state: TelegramConnectionState;
  /** Token-safe label of the failure behind the state, or the reason routing
   *  is off for `disabled`. Null when there is nothing to report. */
  lastError: string | null;
  /** When `lastError` first appeared (epoch ms), or null. */
  lastErrorAt: number | null;
  /** Outbox items not yet delivered; 0 before the outbox exists. */
  outboxPending: number;
}

/** What the monitor knows. `running` means boot succeeded and the dispatcher
 *  and outbox exist; `dispatcherStarted` is false until the dispatcher's
 *  `start()` (its startup probe) has settled. */
export type TelegramConnectionInputs =
  | { phase: "connecting"; lastError: string | null; lastErrorAt: number | null }
  | { phase: "disabled"; reason: string; at: number | null }
  | {
      phase: "running";
      dispatcherStarted: boolean;
      dispatcher: DispatcherHealth;
      outbox: OutboxHealth;
    };

export function deriveTelegramConnection(inputs: TelegramConnectionInputs): TelegramConnectionView {
  if (inputs.phase === "connecting") {
    return { state: "connecting", lastError: inputs.lastError, lastErrorAt: inputs.lastErrorAt, outboxPending: 0 };
  }
  if (inputs.phase === "disabled") {
    return { state: "disabled", lastError: inputs.reason, lastErrorAt: inputs.at, outboxPending: 0 };
  }
  const { dispatcher, outbox } = inputs;
  const pending = outbox.pending;
  if (dispatcher.state === "down") {
    // Before start() settles the loop simply has not begun. After, `down`
    // means it will not poll this session (a 409 at the startup probe).
    if (!inputs.dispatcherStarted) {
      return { state: "connecting", lastError: null, lastErrorAt: null, outboxPending: pending };
    }
    return {
      state: "disabled",
      lastError: dispatcher.reason ?? "poll loop stopped",
      lastErrorAt: dispatcher.reasonAt,
      outboxPending: pending,
    };
  }
  if (dispatcher.state === "retrying") {
    return { state: "reconnecting", lastError: dispatcher.reason, lastErrorAt: dispatcher.reasonAt, outboxPending: pending };
  }
  if (outbox.stalled) {
    return { state: "reconnecting", lastError: outbox.lastError, lastErrorAt: outbox.lastErrorAt, outboxPending: pending };
  }
  return { state: "connected", lastError: null, lastErrorAt: null, outboxPending: pending };
}

/** True when two views would render and write the same. */
export function sameTelegramConnection(a: TelegramConnectionView | null, b: TelegramConnectionView | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.state === b.state &&
    a.lastError === b.lastError &&
    a.lastErrorAt === b.lastErrorAt &&
    a.outboxPending === b.outboxPending
  );
}

export type TelegramLight = "green" | "yellow" | "red";

export function telegramLight(view: TelegramConnectionView): TelegramLight {
  switch (view.state) {
    case "connected":
      return "green";
    case "connecting":
    case "reconnecting":
      return "yellow";
    case "disabled":
      return "red";
  }
}

/** Boot's disabled lines all start with this; the view keeps what follows. */
const DISABLED_PREFIX = "Telegram routing disabled: ";

/** The reason part of a boot `BootDisabled.message`, e.g. `bot token
 *  rejected (HTTP 401)`. A message without the prefix is kept whole. */
export function disabledReason(message: string): string {
  return message.startsWith(DISABLED_PREFIX) ? message.slice(DISABLED_PREFIX.length) : message;
}

/** Columns free for a help-panel detail (see remoteControlDetail). */
export const HELP_DETAIL_WIDTH = 48;

/**
 * The `?` help row for the light, word-wrapped to {@link HELP_DETAIL_WIDTH}:
 *
 *   connected
 *   connected; 2 queued
 *   connecting — errno:ETIMEDOUT (12s ago)
 *   reconnecting — HTTP 502 (40s ago); 2 queued
 *   disabled — bot token rejected (HTTP 401)
 *
 * The age is shown only while still trying (connecting / reconnecting).
 */
export function telegramHelpDetail(view: TelegramConnectionView, now: number): string[] {
  let text: string = view.state;
  if (view.lastError !== null) {
    text += ` — ${view.lastError}`;
    if (view.state !== "disabled" && view.lastErrorAt !== null) {
      text += ` (${formatAgo(now - view.lastErrorAt)})`;
    }
  }
  if (view.outboxPending > 0) text += `; ${view.outboxPending} queued`;
  return wrapWords(text, HELP_DETAIL_WIDTH);
}

/** `40s ago`, `5m ago`, `2h ago`. A negative age (clock skew) reads `0s`. */
export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Greedy word wrap. A word longer than `width` gets a line of its own. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

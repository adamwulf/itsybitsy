/**
 * Tests for ChannelPaneComponent — the main-area team chat box (SPEC §17.4).
 *
 * Seeds a real `<team>.channel.jsonl` via `appendChannelMessage` under a tmpdir
 * coordinator home (`setCoordinatorHome`), so `load()` reads genuine records. The
 * human-form prefix depends on `user.name`, isolated via `setUserConfigPath`.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ChannelPaneComponent, formatChannelLine, formatChannelSystemLine } from "./channel-pane";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";
import { setUserConfigPath, resetUserConfigPath } from "../config";
import { appendChannelMessage } from "../team-channel";
import { stripAnsi } from "../parse-state";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "channel-pane-test-"));
  setCoordinatorHome(home);
  // Default: no user.name configured (bare-user human form). Tests that want a
  // name write the config file and re-point. Point at a path that does not exist
  // yet so readConfig falls back to defaults (user.name = "").
  setUserConfigPath(join(home, "config.json"));
});

afterEach(async () => {
  resetCoordinatorHome();
  resetUserConfigPath();
  await rm(home, { recursive: true, force: true });
});

describe("ChannelPaneComponent", () => {
  test("teamName null → 'Select a team' placeholder", async () => {
    const pane = new ChannelPaneComponent();
    pane.displayHeight = 5;
    pane.teamName = null;
    await pane.load();
    const lines = pane.render(60);
    expect(lines.length).toBe(5);
    expect(stripAnsi(lines[0]!)).toContain("Select a team to view its channel");
  });

  test("teamName set + empty channel → 'No messages' placeholder", async () => {
    const pane = new ChannelPaneComponent();
    pane.displayHeight = 5;
    pane.teamName = "backend";
    await pane.load(); // no channel file yet → readChannel returns []
    const lines = pane.render(60);
    expect(lines.length).toBe(5);
    expect(stripAnsi(lines[0]!)).toContain("No messages in @backend yet");
  });

  test("renders seeded messages newest-at-bottom", async () => {
    await appendChannelMessage("backend", { ts: 100, fromAgent: "agent-aaa", message: "first" });
    await appendChannelMessage("backend", { ts: 200, fromAgent: "agent-bbb", message: "second" });

    const pane = new ChannelPaneComponent();
    pane.displayHeight = 10;
    pane.teamName = "backend";
    await pane.load();
    const text = pane.render(80).map(stripAnsi);
    const firstIdx = text.findIndex((l) => l.includes("first"));
    const secondIdx = text.findIndex((l) => l.includes("second"));
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThanOrEqual(0);
    // Newest ("second") is below the oldest ("first").
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  test("agent-sender line renders without the word 'agent'", async () => {
    await appendChannelMessage("backend", { ts: 100, fromAgent: "agent-aaa", message: "hi team" });
    const pane = new ChannelPaneComponent();
    pane.displayHeight = 10;
    pane.teamName = "backend";
    await pane.load();
    const text = pane.render(80).map(stripAnsi).join("\n");
    expect(text).toContain("[sent by agent-aaa in @backend]: hi team");
    expect(text).not.toContain("[sent by agent agent-aaa");
  });

  test("@system-sender line keeps the sentinel verbatim", async () => {
    await appendChannelMessage("backend", { ts: 100, fromAgent: "@system", message: "deploy now" });
    const pane = new ChannelPaneComponent();
    pane.displayHeight = 10;
    pane.teamName = "backend";
    await pane.load();
    const text = pane.render(80).map(stripAnsi).join("\n");
    expect(text).toContain("[sent by @system in @backend]: deploy now");
  });

  test("human sender with NO user.name → bare 'user' form", async () => {
    await appendChannelMessage("backend", { ts: 100, fromAgent: "", message: "ping" });
    const pane = new ChannelPaneComponent();
    pane.displayHeight = 10;
    pane.teamName = "backend";
    await pane.load(); // config path points at a missing file → user.name = ""
    const text = pane.render(80).map(stripAnsi).join("\n");
    expect(text).toContain("[sent by user in @backend]: ping");
    // The bare form has NO name token between "user" and "in".
    expect(text).not.toMatch(/\[sent by user \S+ in @backend\]/);
  });

  test("human sender WITH user.name configured → 'user <name>' form", async () => {
    await appendChannelMessage("backend", { ts: 100, fromAgent: "", message: "ping" });
    // Configure user.name via the isolated config path.
    await Bun.write(join(home, "config.json"), JSON.stringify({ user: { name: "Adam" } }, null, 2));

    const pane = new ChannelPaneComponent();
    pane.displayHeight = 10;
    pane.teamName = "backend";
    await pane.load();
    const text = pane.render(80).map(stripAnsi).join("\n");
    expect(text).toContain("[sent by user Adam in @backend]: ping");
  });

  test("scrollBack shifts which lines render (older lines come into view)", async () => {
    // Seed more messages than the pane height so some scroll off the top.
    for (let i = 0; i < 10; i++) {
      await appendChannelMessage("backend", {
        ts: 100 + i,
        fromAgent: "agent-x",
        message: `msg-${i}`,
      });
    }
    const pane = new ChannelPaneComponent();
    pane.displayHeight = 4;
    pane.teamName = "backend";
    await pane.load();

    // At scrollBack 0 (follow newest): the newest message is visible, the oldest is not.
    const atBottom = pane.render(80).map(stripAnsi).join("\n");
    expect(atBottom).toContain("msg-9");
    expect(atBottom).not.toContain("msg-0");

    // Scroll back to the maximum: the oldest line comes fully into view and the
    // newest has scrolled off the bottom. With 10 messages each separated by a
    // blank line (19 wrapped lines) and displayHeight 4, the max scrollBack
    // (15) brings the oldest messages into view alongside the scroll indicator.
    pane.scrollUp(15);
    const scrolled = pane.render(80).map(stripAnsi).join("\n");
    expect(scrolled).toContain("msg-1");
    expect(scrolled).not.toContain("msg-9");
    expect(scrolled).toContain("lines below"); // scroll indicator present
  });

  test("render pads to displayHeight for vertical alignment", async () => {
    await appendChannelMessage("backend", { ts: 100, fromAgent: "agent-x", message: "only" });
    const pane = new ChannelPaneComponent();
    pane.displayHeight = 12;
    pane.teamName = "backend";
    await pane.load();
    const lines = pane.render(80);
    expect(lines.length).toBe(12);
  });

  test("resetForTeam clears the cache and scroll", async () => {
    await appendChannelMessage("backend", { ts: 100, fromAgent: "agent-x", message: "hi" });
    const pane = new ChannelPaneComponent();
    pane.teamName = "backend";
    await pane.load();
    pane.scrollUp(3);
    expect(pane.messages.length).toBe(1);
    pane.resetForTeam();
    expect(pane.messages.length).toBe(0);
    expect(pane.scrollBack).toBe(0);
  });

  // Corr-N1: a fast team-switch A→B must not leave team A's messages cached
  // under team B's header even when A's readChannel resolves AFTER B's. The
  // load() snapshot-and-discard guard mirrors TmuxPoller's pattern.
  test("stale load for old team is discarded after switch (Corr-N1)", async () => {
    await appendChannelMessage("alpha", { ts: 100, fromAgent: "agent-a", message: "from-alpha" });
    await appendChannelMessage("beta", { ts: 200, fromAgent: "agent-b", message: "from-beta" });

    const pane = new ChannelPaneComponent();
    pane.displayHeight = 10;

    // Start the "slow" load for alpha but don't await yet. Switching teamName
    // mid-await simulates a user navigating to beta before alpha's read settles.
    pane.teamName = "alpha";
    const loadAlpha = pane.load();

    // Switch to beta synchronously, then trigger and await its load.
    pane.teamName = "beta";
    await pane.load();
    // Now let the alpha load settle. Its guard must see teamName !== "alpha"
    // and discard its result instead of overwriting beta's messages.
    await loadAlpha;

    expect(pane.teamName).toBe("beta");
    expect(pane.messages.length).toBe(1);
    expect(pane.messages[0]!.message).toBe("from-beta");
  });

  describe("formatChannelLine grammar", () => {
    test("agent id drops 'agent' word", () => {
      const line = formatChannelLine({ ts: 0, fromAgent: "agent-z", message: "m" }, "backend", null);
      expect(stripAnsi(line)).toBe("[sent by agent-z in @backend]: m");
    });
    test("@-sentinel kept verbatim", () => {
      const line = formatChannelLine({ ts: 0, fromAgent: "@system", message: "m" }, "backend", null);
      expect(stripAnsi(line)).toBe("[sent by @system in @backend]: m");
    });
    test("human with no user.name → bare user", () => {
      const line = formatChannelLine({ ts: 0, fromAgent: "", message: "m" }, "backend", null);
      expect(stripAnsi(line)).toBe("[sent by user in @backend]: m");
    });
    test("human with user.name → user <name>", () => {
      const line = formatChannelLine({ ts: 0, fromAgent: "", message: "m" }, "backend", "Adam");
      expect(stripAnsi(line)).toBe("[sent by user Adam in @backend]: m");
    });
    test("sender prefix carries BOLD + color ANSI", () => {
      const line = formatChannelLine({ ts: 0, fromAgent: "agent-z", message: "m" }, "backend", null);
      // BOLD = \x1b[1m, CYAN = \x1b[36m, RESET = \x1b[0m
      expect(line).toContain("\x1b[1m");
      expect(line).toContain("\x1b[36m");
      expect(line).toContain("\x1b[0m");
    });
  });

  // -------------------------------------------------------------------------
  // System (lifecycle) record rendering (§17.4 design update). Lifecycle
  // notices (join/leave/team-create) are written to channel.jsonl with
  // kind: "system" and rendered as a dimmed `── … ──` separator line so they
  // read distinctly from chat without disappearing from the room history.
  // -------------------------------------------------------------------------
  describe("formatChannelSystemLine", () => {
    test("agent actor prepends the id to the message", () => {
      const line = formatChannelSystemLine({
        ts: 0,
        fromAgent: "agent-abc123",
        message: "joined the team",
        kind: "system",
      });
      expect(stripAnsi(line)).toBe("── agent-abc123 joined the team ──");
    });
    test("@system actor renders the message bare (sentinel dropped)", () => {
      const line = formatChannelSystemLine({
        ts: 0,
        fromAgent: "@system",
        message: "team created",
        kind: "system",
      });
      expect(stripAnsi(line)).toBe("── team created ──");
    });
    test("system line is wrapped in DIM/RESET so the chat box renders it dimmed", () => {
      const line = formatChannelSystemLine({
        ts: 0,
        fromAgent: "@system",
        message: "team created",
        kind: "system",
      });
      // The DIM SGR ("\x1b[2m") opens the line and the universal RESET closes
      // it — both must be present for the dim styling to render correctly.
      expect(line.startsWith("\x1b[2m")).toBe(true);
      expect(line.endsWith("\x1b[0m")).toBe(true);
    });
    test("coalesced-leave actor (@system) still renders bare even with a count phrase", () => {
      const line = formatChannelSystemLine({
        ts: 0,
        fromAgent: "@system",
        message: "3 members left",
        kind: "system",
      });
      expect(stripAnsi(line)).toBe("── 3 members left ──");
    });
  });

  describe("render dispatch by kind", () => {
    test("system records render as `── … ──` (NOT the `[sent by …]` chat grammar)", async () => {
      await appendChannelMessage("backend", {
        ts: 100,
        fromAgent: "agent-joiner",
        message: "joined the team",
        kind: "system",
      });
      const pane = new ChannelPaneComponent();
      pane.displayHeight = 10;
      pane.teamName = "backend";
      await pane.load();
      const text = pane.render(80).map(stripAnsi).join("\n");
      expect(text).toContain("── agent-joiner joined the team ──");
      // Crucially, the system render branch does NOT produce the chat-grammar
      // bracket prefix — that would conflate lifecycle notices with chat.
      expect(text).not.toContain("[sent by agent-joiner");
    });

    test("@system actor renders bare (no actor token); chat-grammar prefix is NOT emitted", async () => {
      await appendChannelMessage("backend", {
        ts: 100,
        fromAgent: "@system",
        message: "team created",
        kind: "system",
      });
      const pane = new ChannelPaneComponent();
      pane.displayHeight = 10;
      pane.teamName = "backend";
      await pane.load();
      const text = pane.render(80).map(stripAnsi).join("\n");
      expect(text).toContain("── team created ──");
      expect(text).not.toContain("[sent by @system");
    });

    test("rendered system line carries DIM/RESET ANSI in the visible output", async () => {
      await appendChannelMessage("backend", {
        ts: 100,
        fromAgent: "@system",
        message: "team created",
        kind: "system",
      });
      const pane = new ChannelPaneComponent();
      pane.displayHeight = 10;
      pane.teamName = "backend";
      await pane.load();
      const joined = pane.render(80).join("\n");
      // Expect both the DIM SGR open and the RESET close present in the raw
      // ANSI output (the system line is wrapped end-to-end in DIM/RESET).
      expect(joined).toContain("\x1b[2m");
      expect(joined).toContain("\x1b[0m");
    });

    test("mixed chat + system records: chat keeps its grammar, system gets the separator form", async () => {
      await appendChannelMessage("backend", {
        ts: 100,
        fromAgent: "agent-a",
        message: "hello",
      });
      await appendChannelMessage("backend", {
        ts: 200,
        fromAgent: "agent-b",
        message: "joined the team",
        kind: "system",
      });
      const pane = new ChannelPaneComponent();
      pane.displayHeight = 10;
      pane.teamName = "backend";
      await pane.load();
      const text = pane.render(80).map(stripAnsi).join("\n");
      expect(text).toContain("[sent by agent-a in @backend]: hello");
      expect(text).toContain("── agent-b joined the team ──");
    });

    test("a record with no `kind` field still renders as chat (back-compat)", async () => {
      // Hand-seed a legacy record shape (no kind) to confirm the render branch
      // treats undefined as chat — the on-disk back-compat contract.
      await appendChannelMessage("backend", {
        ts: 100,
        fromAgent: "agent-legacy",
        message: "still chat",
      });
      const pane = new ChannelPaneComponent();
      pane.displayHeight = 10;
      pane.teamName = "backend";
      await pane.load();
      const text = pane.render(80).map(stripAnsi).join("\n");
      expect(text).toContain("[sent by agent-legacy in @backend]: still chat");
      expect(text).not.toContain("── agent-legacy");
    });
  });
});

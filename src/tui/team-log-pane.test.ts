/**
 * Tests for TeamLogPaneComponent — the right-pane companion to the channel
 * chat box. Mirrors the channel-pane test isolation pattern: seeds a real
 * `<team>.log` via `appendTeamLog` under a tmpdir coordinator home so `load()`
 * reads genuine records.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { visibleWidth } from "@mariozechner/pi-tui";
import { TeamLogPaneComponent } from "./team-log-pane";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";
import { appendTeamLog } from "../team-channel";
import { stripAnsi } from "../parse-state";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "team-log-pane-test-"));
  setCoordinatorHome(home);
});

afterEach(async () => {
  resetCoordinatorHome();
  await rm(home, { recursive: true, force: true });
});

describe("TeamLogPaneComponent", () => {
  test("teamName null → 'Select a team' placeholder", async () => {
    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 5;
    pane.teamName = null;
    await pane.load();
    const lines = pane.render(60);
    expect(lines.length).toBe(5);
    expect(stripAnsi(lines[0]!)).toContain("Select a team to view its log");
  });

  test("teamName set + empty log → 'No log entries' placeholder", async () => {
    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 5;
    pane.teamName = "backend";
    await pane.load();
    const lines = pane.render(60);
    expect(lines.length).toBe(5);
    expect(stripAnsi(lines[0]!)).toContain("No log entries for @backend yet");
  });

  test("renders seeded log lines newest-at-bottom", async () => {
    await appendTeamLog("backend", "first event");
    await appendTeamLog("backend", "second event");
    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 10;
    pane.teamName = "backend";
    await pane.load();
    const text = pane.render(80).map(stripAnsi);
    const firstIdx = text.findIndex((l) => l.includes("first event"));
    const secondIdx = text.findIndex((l) => l.includes("second event"));
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  test("render pads to displayHeight for vertical alignment", async () => {
    await appendTeamLog("backend", "only event");
    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 12;
    pane.teamName = "backend";
    await pane.load();
    const lines = pane.render(80);
    expect(lines.length).toBe(12);
  });

  test("resetForTeam clears cache + scroll", async () => {
    await appendTeamLog("backend", "first");
    const pane = new TeamLogPaneComponent();
    pane.teamName = "backend";
    await pane.load();
    pane.scrollUp(3);
    expect(pane.lines.length).toBe(1);
    pane.resetForTeam();
    expect(pane.lines.length).toBe(0);
    expect(pane.scrollBack).toBe(0);
  });

  test("stale load for old team is discarded after switch", async () => {
    await appendTeamLog("alpha", "from-alpha-log");
    await appendTeamLog("beta", "from-beta-log");

    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 10;
    pane.teamName = "alpha";
    const loadAlpha = pane.load();
    pane.teamName = "beta";
    await pane.load();
    await loadAlpha;

    expect(pane.teamName).toBe("beta");
    expect(pane.lines.length).toBe(1);
    expect(pane.lines[0]).toContain("from-beta-log");
  });

  test("scrollBack shows older lines + scroll indicator", async () => {
    for (let i = 0; i < 10; i++) {
      await appendTeamLog("backend", `event-${i}`);
    }
    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 4;
    pane.teamName = "backend";
    await pane.load();

    const atBottom = pane.render(80).map(stripAnsi).join("\n");
    expect(atBottom).toContain("event-9");
    expect(atBottom).not.toContain("event-0");

    // 10 lines, displayHeight 4, scrollBack reserves 1 row for the indicator
    // → max scrollBack = 6 → visible window is lines[1..4) (event-1..event-3).
    pane.scrollUp(6);
    const scrolled = pane.render(80).map(stripAnsi).join("\n");
    expect(scrolled).toContain("event-1");
    expect(scrolled).not.toContain("event-9");
    expect(scrolled).toContain("lines below");
  });

  test("timestamp prefix is dimmed in the rendered output", async () => {
    await appendTeamLog("backend", "did a thing");
    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 5;
    pane.teamName = "backend";
    await pane.load();
    const raw = pane.render(80).join("\n");
    // DIM SGR \x1b[2m and RESET \x1b[0m wrap the bracketed timestamp.
    expect(raw).toContain("\x1b[2m[");
    expect(raw).toContain("\x1b[0m");
  });

  test("word-wraps the log at word boundaries, not mid-token", async () => {
    // A long message that must wrap several times at a narrow width. Word wrap
    // breaks at spaces; character wrap would split a word across the width
    // boundary (e.g. "wordfi" / "ve"). Distinct whole words let us assert every
    // continuation row carries ONLY complete words.
    const words = ["wordone", "wordtwo", "wordthree", "wordfour", "wordfive", "wordsix", "wordseven"];
    await appendTeamLog("backend", words.join(" "));
    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 20;
    pane.teamName = "backend";
    await pane.load();

    const rows = pane.render(30).map(stripAnsi);
    const contentRows = rows.filter((r) => r.trim().length > 0);
    // The message spanned more than one physical row → it actually wrapped.
    expect(contentRows.length).toBeGreaterThan(1);

    // Row 0 carries the `[timestamp]` prefix; every CONTINUATION row (row ≥ 1)
    // holds message text only, and must contain whole words exclusively —
    // never a mid-word fragment.
    const wordSet = new Set(words);
    for (let i = 1; i < contentRows.length; i++) {
      const tokens = contentRows[i]!.trim().split(/\s+/);
      for (const tok of tokens) {
        expect(wordSet.has(tok)).toBe(true);
      }
    }
  });

  test("collapses an over-width ───── separator to a single row", async () => {
    // A log entry whose body carries a full-width ── rule on its own physical
    // line (embedded newline). Character wrapping would explode it into many
    // full-width separator rows; word wrap collapses it to a single truncated
    // row (isSeparatorLine).
    const rule = "─".repeat(200);
    await appendTeamLog("backend", `context line\n${rule}`);
    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 20;
    pane.teamName = "backend";
    await pane.load();

    const rows = pane.render(40).map(stripAnsi);
    // Exactly one physical row is an all-─ separator (not the ~5 char wrap makes).
    const separatorRows = rows.filter((r) => r.trim().length > 0 && /^─+$/.test(r.trim()));
    expect(separatorRows.length).toBe(1);
  });

  test("reflows a box-drawing table as a block (whole-log join path)", async () => {
    // The whole log is joined and wrapped as ONE block, so a box-drawing table
    // in the log flows through wordWrapLines' table reflow, same as the agent /
    // center pane. appendTeamLog prefixes only the FIRST physical line of the
    // entry with a `[timestamp]`, and the table detector matches `^┌[─┬]+┐$` on
    // the stripped/trimmed line — so the table must sit on CONTINUATION lines
    // (a leading text line first), leaving its rules un-prefixed.
    //
    // The long cell is a multi-word value wide enough that the table's widest
    // physical line exceeds the render width — that forces the reflow branch
    // (a table whose every line already fits the width passes through untouched,
    // never reflowing).
    const longVal =
      "a much longer value here that keeps going well past forty columns to force a reflow";
    const table = [
      "┌──────────┬──────────┐",
      "│ alpha    │ beta     │",
      "├──────────┼──────────┤",
      `│ ${longVal} │ b-value │`,
      "└──────────┴──────────┘",
    ];
    await appendTeamLog("backend", `results:\n${table.join("\n")}`);
    const pane = new TeamLogPaneComponent();
    pane.displayHeight = 30;
    pane.teamName = "backend";
    await pane.load();

    const width = 40;
    const rows = pane.render(width).map(stripAnsi);
    const trimmed = rows.map((r) => r.trim());

    // The frame survives as a reflowed frame: a top rule and a bottom rule.
    expect(trimmed.some((r) => /^┌[─┬]+┐$/.test(r))).toBe(true);
    expect(trimmed.some((r) => /^└[─┴]+┘$/.test(r))).toBe(true);

    // Every rendered row fits the pane — it did NOT explode into over-width rows.
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(width);

    // Reflow (not a clip): the long cell was re-laid across multiple cell rows,
    // so every one of its words survives. A per-line clip would truncate the
    // data row at the pane edge and drop the tail words.
    const joined = rows.join(" ");
    for (const word of longVal.split(" ")) {
      expect(joined).toContain(word);
    }
  });
});

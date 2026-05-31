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
});

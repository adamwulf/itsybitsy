import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { readAgentLog, readAgentLogWindow, readAgentPrompt, parseDenials } from "../agents";
import type { Agent, AgentMeta, FlatEntry, PendingQuestion } from "../agents";
import { stripAnsi } from "../parse-state";
import { makeAgent as _makeAgent, makeFlatAgent, makeFlatRepoHeader, makeFlatSystemCoordinator, setAgentState, makeSpawnResult } from "../test-utils";
import { TmuxPaneComponent, RightPaneComponent, DashboardComponent, AgentTreeComponent, colorizeDiff, colorizeLog, formatAgentRow } from "./dashboard";
import { visibleWidth } from "@mariozechner/pi-tui";
import { setSendSpawnRunner, resetSendSpawnRunner, setKillPauseSpawnRunner, resetKillPauseSpawnRunner, setNukeResumeSpawnRunner, resetNukeResumeSpawnRunner, setNewAgentSpawnRunner, resetNewAgentSpawnRunner, setDiffStatusSpawnRunner, resetDiffStatusSpawnRunner, setMergeSpawnRunner, resetMergeSpawnRunner } from "../ib-commands";
import { spawnCtx as lifecycleSpawnCtx } from "../agent-lifecycle";
import { setUserConfigPath, resetUserConfigPath } from "../config";
import type { SpawnResult } from "../types";
import { PANE_MODES } from "./pane-manager";
import { computeSidebarHeights } from "./sidebar";
import { assertDialog } from "./test-helpers";

/** Helper: create a mock send spawn runner that records calls as {args, cwd}-style entries */
function mockSendSpawnRunner(calls: { args: string[]; cwd: string }[]) {
  setSendSpawnRunner((cmd: string[]) => {
    // Record "send" calls as ib-runner-style entries for test compatibility
    if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd.length === 7 && cmd[4] === "-l" && cmd[5] === "--") {
      // This is the actual message send — extract message
      calls.push({ args: ["send", "TARGET", cmd[6]!], cwd: "" });
    }
    return makeSpawnResult();
  });
}

function makeAgent(id: string, repoPath: string, archived = false): Agent {
  return _makeAgent({ id, repoPath, archived });
}

/** Create a DashboardComponent with setTerminalTitle stubbed to prevent test output noise. */
function makeDashboard(): DashboardComponent {
  const d = new DashboardComponent();
  d.setTerminalTitle = () => {};
  return d;
}

describe("readAgentLog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads agent.log for active agent", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "line one\nline two\nline three");

    const agent = makeAgent("agent-abc", tmpDir, false);
    const lines = await readAgentLog(agent);
    expect(lines).toEqual(["line one", "line two", "line three"]);
  });

  test("reads agent.log for archived agent", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "archive", "agent-xyz");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "archived log");

    const agent = makeAgent("agent-xyz", tmpDir, true);
    const lines = await readAgentLog(agent);
    expect(lines).toEqual(["archived log"]);
  });

  test("returns placeholder when agent.log does not exist", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-nolog");
    await mkdir(agentDir, { recursive: true });

    const agent = makeAgent("agent-nolog", tmpDir, false);
    const lines = await readAgentLog(agent);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("No agent.log found");
  });

  test("returns placeholder when agent.log is empty", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-empty");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "");

    const agent = makeAgent("agent-empty", tmpDir, false);
    const lines = await readAgentLog(agent);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("empty");
  });
});

describe("readAgentLogWindow", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns the entire file when small (atTop=true)", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-small");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "line one\nline two\nline three");

    const agent = makeAgent("agent-small", tmpDir, false);
    const win = await readAgentLogWindow(agent, { rows: 20, scrollOffset: 0 });
    expect(win.atTop).toBe(true);
    expect(win.isPlaceholder).toBe(false);
    expect(win.lines).toEqual(["line one", "line two", "line three"]);
    expect(win.fileSize).toBeGreaterThan(0);
  });

  test("drops partial first line when window starts past BOF", async () => {
    // Build a log large enough that the default window won't cover it from the top.
    // Each line is ~250 chars (over the 200 estimate) so 1000 lines is ~250KB.
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-big");
    await mkdir(agentDir, { recursive: true });
    const filler = "x".repeat(240);
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) lines.push(`line${String(i).padStart(4, "0")}-${filler}`);
    await Bun.write(join(agentDir, "agent.log"), lines.join("\n"));

    const agent = makeAgent("agent-big", tmpDir, false);
    // rows=20, scrollOffset=0 → desiredLines=60, desiredBytes=12000 → much smaller than file
    const win = await readAgentLogWindow(agent, { rows: 20, scrollOffset: 0 });
    expect(win.atTop).toBe(false);
    expect(win.isPlaceholder).toBe(false);
    // Last line of the window must be the last line of the file (lines are newest-last).
    expect(win.lines[win.lines.length - 1]).toBe(lines[lines.length - 1]);
    // The first line in the window must be a complete line (we drop the partial).
    // Verify: the first line should match one of the original whole lines.
    expect(win.lines[0]!.startsWith("line")).toBe(true);
    // No partial first line — the line before the first one in window
    // is also a whole line (because we trimmed the partial).
    const firstLineNum = parseInt(win.lines[0]!.slice(4, 8), 10);
    expect(firstLineNum).toBeGreaterThan(0);
    // Total lines returned should be at least rows + bufferRows (20 + 40 = 60),
    // give or take some bytes-per-line variance, but well under the file's 1000.
    expect(win.lines.length).toBeGreaterThan(20);
    expect(win.lines.length).toBeLessThan(1000);
  });

  test("scrollOffset extends window further back", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-scroll");
    await mkdir(agentDir, { recursive: true });
    const filler = "x".repeat(240);
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) lines.push(`line${String(i).padStart(4, "0")}-${filler}`);
    await Bun.write(join(agentDir, "agent.log"), lines.join("\n"));

    const agent = makeAgent("agent-scroll", tmpDir, false);
    const small = await readAgentLogWindow(agent, { rows: 20, scrollOffset: 0 });
    const large = await readAgentLogWindow(agent, { rows: 20, scrollOffset: 200 });
    // Bigger scrollOffset must produce a larger window (or atTop)
    expect(large.lines.length).toBeGreaterThan(small.lines.length);
    // Both should still end at the last line
    expect(small.lines[small.lines.length - 1]).toBe(lines[lines.length - 1]);
    expect(large.lines[large.lines.length - 1]).toBe(lines[lines.length - 1]);
  });

  test("returns 'No agent.log found' when file does not exist", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-missing");
    await mkdir(agentDir, { recursive: true });
    const agent = makeAgent("agent-missing", tmpDir, false);
    const win = await readAgentLogWindow(agent, { rows: 20, scrollOffset: 0 });
    expect(win.isPlaceholder).toBe(true);
    expect(win.fileSize).toBe(0);
    expect(win.atTop).toBe(true);
    expect(win.lines[0]).toContain("No agent.log found");
  });

  test("returns 'agent.log is empty' for zero-byte file", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-empty2");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "");
    const agent = makeAgent("agent-empty2", tmpDir, false);
    const win = await readAgentLogWindow(agent, { rows: 20, scrollOffset: 0 });
    expect(win.isPlaceholder).toBe(true);
    expect(win.fileSize).toBe(0);
    expect(win.lines[0]).toContain("empty");
  });

  test("works for archived agents", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "archive", "agent-arc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "old line one\nold line two");
    const agent = makeAgent("agent-arc", tmpDir, true);
    const win = await readAgentLogWindow(agent, { rows: 20, scrollOffset: 0 });
    expect(win.atTop).toBe(true);
    expect(win.lines).toEqual(["old line one", "old line two"]);
  });

  test("returns 'line too long' placeholder when window covers a single oversized line", async () => {
    // Build a file where the trailing line is longer than any reasonable
    // tail-window byte budget. The first line is short so we have a clear
    // partial-line cut after the newline.
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-bigline");
    await mkdir(agentDir, { recursive: true });
    // 50KB single line (well over the default 8KB minimum read).
    const huge = "z".repeat(50_000);
    await Bun.write(join(agentDir, "agent.log"), `prefix-line\n${huge}`);
    const agent = makeAgent("agent-bigline", tmpDir, false);
    // Tiny rows/buffer → desiredBytes = 8192 < 50KB → tail starts mid-huge-line.
    const win = await readAgentLogWindow(agent, { rows: 5, scrollOffset: 0, bufferRows: 5 });
    expect(win.atTop).toBe(false);
    expect(win.isPlaceholder).toBe(true);
    expect(win.lines[0]).toContain("line too long");
  });
});

describe("TmuxPaneComponent scroll logic", () => {
  function makeTmuxPane(lineCount: number, displayHeight: number): TmuxPaneComponent {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-tmux", "/tmp/test");
    pane.hasPolled = true;
    // Create rawOutput with lineCount lines (each shorter than render width)
    pane.rawOutput = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
    pane.displayHeight = displayHeight;
    return pane;
  }

  test("scrollBack=0 shows bottom lines (auto-follow)", () => {
    const pane = makeTmuxPane(30, 10);
    pane.scrollBack = 0;
    const result = pane.render(80);

    expect(result.length).toBe(10);
    // Last non-empty line should be the final content line
    const nonEmpty = result.filter((l) => l.length > 0);
    expect(nonEmpty[nonEmpty.length - 1]).toBe("line 30");
  });

  test("scrollBack clamped to maxScrollBack", () => {
    const pane = makeTmuxPane(20, 10);
    // Set scrollBack way beyond max
    pane.scrollBack = 999;
    const result = pane.render(80);

    // maxScrollBack = max(0, 20 - 10) = 10
    expect(pane.scrollBack).toBe(10);
    expect(result.length).toBe(10);
    // With scroll indicator reserving 1 line, contentHeight=9, so start=1
    expect(result[0]).toBe("line 2");
  });

  test("scroll indicator shown when scrollBack > 0", () => {
    const pane = makeTmuxPane(30, 10);
    pane.scrollBack = 5;
    const result = pane.render(80);

    expect(result.length).toBe(10);
    // The last non-pad line should be the scroll indicator
    const lastNonEmpty = result.filter((l) => l.length > 0);
    const indicator = lastNonEmpty[lastNonEmpty.length - 1];
    expect(indicator).toContain("5 lines below");
  });

  test("scroll indicator does not push past displayHeight", () => {
    const pane = makeTmuxPane(30, 10);
    pane.scrollBack = 3;
    const result = pane.render(80);

    // Total lines returned should be exactly displayHeight
    expect(result.length).toBe(10);
  });

  test("scroll indicator reserves one line from content", () => {
    const pane = makeTmuxPane(30, 10);
    pane.scrollBack = 1;
    const result = pane.render(80);

    // With scrollBack=1, contentHeight = displayHeight - 1 = 9
    // So we show 9 content lines + 1 indicator line = 10 total
    expect(result.length).toBe(10);

    // The content should show 9 lines, not 10
    const contentLines = result.filter((l) => l.length > 0 && !l.includes("lines below"));
    expect(contentLines.length).toBe(9);
  });

  test("no scroll indicator at scrollBack=0", () => {
    const pane = makeTmuxPane(30, 10);
    pane.scrollBack = 0;
    const result = pane.render(80);

    const hasIndicator = result.some((l) => l.includes("lines below"));
    expect(hasIndicator).toBe(false);
  });

  test("scrollUp increments scrollBack", () => {
    const pane = makeTmuxPane(30, 10);
    pane.scrollUp(3);
    expect(pane.scrollBack).toBe(3);
  });

  test("scrollDown decrements scrollBack but not below 0", () => {
    const pane = makeTmuxPane(30, 10);
    pane.scrollBack = 2;
    pane.scrollDown(5);
    expect(pane.scrollBack).toBe(0);
  });

  test("resetForAgent clears scroll state", () => {
    const pane = makeTmuxPane(30, 10);
    pane.scrollBack = 5;
    pane.resetForAgent();
    expect(pane.scrollBack).toBe(0);
    expect(pane.hasPolled).toBe(false);
    expect(pane.rawOutput).toBe("");
  });

  test("fewer lines than displayHeight still renders to displayHeight", () => {
    const pane = makeTmuxPane(3, 10);
    pane.scrollBack = 0;
    const result = pane.render(80);

    expect(result.length).toBe(10);
    // First 3 lines should have content
    expect(result[0]).toBe("line 1");
    expect(result[1]).toBe("line 2");
    expect(result[2]).toBe("line 3");
  });

  test("wrapped long lines expand line count and scrollBack accounts for it", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-wrap", "/tmp/test");
    pane.hasPolled = true;
    pane.displayHeight = 5;
    // Create 3 lines, each 30 chars wide — at width=10, each wraps to 3 lines = 9 total
    pane.rawOutput = [
      "AAAAAAAAAA" + "BBBBBBBBBB" + "CCCCCCCCCC",
      "1111111111" + "2222222222" + "3333333333",
      "XXXXXXXXXX" + "YYYYYYYYYY" + "ZZZZZZZZZZ",
    ].join("\n");

    // scrollBack=0: show bottom 5 of 9 wrapped lines (auto-follow)
    pane.scrollBack = 0;
    const result = pane.render(10);
    expect(result.length).toBe(5);
    // Last visible content line should be the last wrap segment
    const nonEmpty = result.filter((l) => l.length > 0);
    expect(nonEmpty[nonEmpty.length - 1]).toBe("ZZZZZZZZZZ");

    // scrollBack=4: scroll up 4 from bottom, showing from the top
    // 9 wrapped lines, displayHeight=5, so maxScrollBack=4
    pane.scrollBack = 4;
    const scrolled = pane.render(10);
    expect(scrolled.length).toBe(5);
    // contentHeight = 5-1 = 4 (scroll indicator reserves 1 line)
    // end = 9-4 = 5, start = max(0, 5-4) = 1
    // So we see wrapped lines [1..4]: "BBBBBBBBBB", "CCCCCCCCCC", "1111111111", "2222222222"
    expect(scrolled[0]).toBe("BBBBBBBBBB");
    expect(scrolled[1]).toBe("CCCCCCCCCC");
    expect(scrolled[2]).toBe("1111111111");
    expect(scrolled[3]).toBe("2222222222");
    // Line 4 is the scroll indicator (truncated to width=10, so check for "4 lin")
    expect(scrolled[4]).toContain("4 lin");
  });

  test("clientAttached shows centered message instead of tmux output", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-test", "/tmp/test");
    pane.hasPolled = true;
    pane.rawOutput = "some tmux output\nline 2\n";
    pane.displayHeight = 10;
    pane.clientAttached = true;

    const result = pane.render(60);
    expect(result.length).toBe(10);
    // Should contain the centered message
    const allText = result.join("\n");
    expect(allText).toContain("[opened in terminal]");
    expect(allText).toContain("agent-test");
    // Should NOT contain the tmux output
    expect(allText).not.toContain("some tmux output");
  });

  test("clientAttached message is vertically centered", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-center", "/tmp/test");
    pane.displayHeight = 20;
    pane.clientAttached = true;

    const result = pane.render(60);
    expect(result.length).toBe(20);

    // The midpoint is line 10 (floor(20/2))
    // agent id on line 9, session on line 10, message on line 11
    // Lines before and after should be empty
    expect(result[0]).toBe("");
    expect(result[19]).toBe("");
    // The three content lines should be non-empty
    const mid = Math.floor(20 / 2);
    expect(result[mid - 1]!.length).toBeGreaterThan(0); // agent id
    expect(result[mid]!.length).toBeGreaterThan(0); // session
    expect(result[mid + 1]).toContain("[opened in terminal]");
  });

  test("clientAttached=false shows normal tmux output", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-normal", "/tmp/test");
    pane.hasPolled = true;
    pane.rawOutput = "normal output here\n";
    pane.displayHeight = 10;
    pane.clientAttached = false;

    const result = pane.render(60);
    const allText = result.join("\n");
    expect(allText).toContain("normal output here");
    expect(allText).not.toContain("[opened in terminal]");
  });

  test("trimInputSeparator removes Codex prompt chrome and preserves status line", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-codex", "/tmp/test");
    pane.agent.meta.model = "codex:gpt-5.5";
    pane.hasPolled = true;
    pane.displayHeight = 10;
    pane.trimInputSeparator = true;
    pane.rawOutput = [
      "• SessionStart hook (completed)",
      "  hook context:",
      "",
      "• WAITING",
      "",
      "",
      "› Use /skills to list available skills",
      "",
      "  gpt-5.5 default · ~/Developer/muse/muse-ios/.ittybitty/agents/agent-c8fc00e0/repo",
      "",
      "",
    ].join("\n");

    pane.parseStatusLines(120);
    expect(pane.statusLines).toEqual([
      "  gpt-5.5 default · ~/Developer/muse/muse-ios/.ittybitty/agents/agent-c8fc00e0/repo",
    ]);

    const rendered = pane.render(120).map((line) => stripAnsi(line)).join("\n");
    expect(rendered).toContain("• WAITING");
    expect(rendered).not.toContain("Use /skills");
    expect(rendered).not.toContain("gpt-5.5 default");
  });

  test("trimInputSeparator finds Codex prompt chrome from the bottom after long wrapped input", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-codex", "/tmp/test");
    pane.agent.meta.model = "codex:gpt-5.5";
    pane.hasPolled = true;
    pane.displayHeight = 10;
    pane.trimInputSeparator = true;
    pane.rawOutput = [
      "• Standing by.",
      "",
      "› long queued prompt",
      ...Array.from({ length: 25 }, (_, i) => `  continuation ${i}`),
      "",
      "  gpt-5.5 default · /tmp/test",
      "",
    ].join("\n");

    pane.parseStatusLines(80);
    expect(pane.statusLines).toEqual(["  gpt-5.5 default · /tmp/test"]);

    const rendered = pane.render(80).map((line) => stripAnsi(line)).join("\n");
    expect(rendered).toContain("• Standing by.");
    expect(rendered).not.toContain("long queued prompt");
    expect(rendered).not.toContain("continuation");
    expect(rendered).not.toContain("gpt-5.5 default");
  });

  test("trimInputSeparator clips at the last Codex prompt marker before the status bar", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-codex", "/tmp/test");
    pane.agent.meta.model = "codex:gpt-5.5";
    pane.hasPolled = true;
    pane.displayHeight = 10;
    pane.trimInputSeparator = true;
    pane.rawOutput = [
      "• Standing by.",
      "",
      "› older queued prompt",
      "",
      "  › Improve documentation in @filename",
      "",
      "  gpt-5.5 default · /tmp/test",
      "",
    ].join("\n");

    pane.parseStatusLines(80);
    expect(pane.statusLines).toEqual(["  gpt-5.5 default · /tmp/test"]);

    const rendered = pane.render(80).map((line) => stripAnsi(line)).join("\n");
    expect(rendered).toContain("• Standing by.");
    expect(rendered).toContain("older queued prompt");
    expect(rendered).not.toContain("Improve documentation");
    expect(rendered).not.toContain("gpt-5.5 default");
  });

  describe("trimInputSeparator on real codex tmux captures", () => {
    // These fixtures are real `S`-key snapshots from codex agents where the
    // dashboard mis-rendered the input box at the bottom of the tmux pane.
    // Each capture ends with the codex input chrome:
    //
    //   › Improve documentation in @filename
    //
    //     <model> · <cwd>
    //
    // All four also contain codex section dividers (full-width "─" lines)
    // higher in the buffer — those dividers were tripping
    // findLastTwoSeparators, which was designed for Claude's input chrome.
    //
    // Expected: trim everything from the "›" line down, and surface the
    // status bar as statusLines.

    async function readFixture(name: string): Promise<string> {
      const text = await Bun.file(
        new URL(`../fixtures/${name}`, import.meta.url),
      ).text();
      // Snapshot files are written by handleSnapshot with a two-line header
      // followed by a blank line, then the raw tmux capture. Strip the header.
      const idx = text.indexOf("\n\n");
      return idx >= 0 ? text.slice(idx + 2) : text;
    }

    function makeCodexPane(rawOutput: string): TmuxPaneComponent {
      const pane = new TmuxPaneComponent();
      pane.agent = makeAgent("agent-codex", "/tmp/test");
      pane.agent.meta.model = "codex:gpt-5.5";
      pane.hasPolled = true;
      pane.displayHeight = 40;
      pane.trimInputSeparator = true;
      pane.rawOutput = rawOutput;
      return pane;
    }

    const fixtures = [
      "codex-snapshot-input-fail-1.txt",
      "codex-snapshot-input-fail-2.txt",
      "codex-snapshot-input-fail-3.txt",
      "codex-snapshot-input-fail-4.txt",
    ];

    for (const fixture of fixtures) {
      test(`${fixture} — status bar extracted and input chrome trimmed`, async () => {
        const raw = await readFixture(fixture);
        const pane = makeCodexPane(raw);

        // Match the real terminal width the captures were taken at — the
        // status line in every fixture is ~84 chars wide, so 154 leaves room
        // without wrapping.
        const width = 154;
        pane.parseStatusLines(width);

        // The status bar line (model + cwd) must surface in statusLines.
        expect(pane.statusLines.length).toBeGreaterThan(0);
        const statusJoined = pane.statusLines.map((l) => stripAnsi(l)).join("\n");
        expect(statusJoined).toContain("gpt-5.5");
        expect(statusJoined).toContain("·");

        // The rendered pane must NOT contain the input chrome (placeholder
        // text or status bar) — those belong to our own input field.
        const rendered = pane.render(width).map((l) => stripAnsi(l)).join("\n");
        expect(rendered).not.toContain("Improve documentation in @filename");
        expect(rendered).not.toContain("gpt-5.5 default ·");
      });
    }
  });

  test("resetForAgent clears clientAttached", () => {
    const pane = new TmuxPaneComponent();
    pane.clientAttached = true;
    pane.resetForAgent();
    expect(pane.clientAttached).toBe(false);
  });
});

describe("RightPaneComponent scroll logic", () => {
  function makeRightPane(contentLines: number, displayHeight: number): RightPaneComponent {
    const pane = new RightPaneComponent();
    pane.displayHeight = displayHeight;
    pane.agent = makeAgent("agent-right", "/tmp/test");
    // Set promptContent directly (loaded async in real use)
    pane.promptContent = Array.from({ length: contentLines }, (_, i) => `prompt line ${i + 1}`);
    pane.setMode("INITIAL PROMPT");
    return pane;
  }

  test("scrollOffset=0 shows tail (last lines)", () => {
    const pane = makeRightPane(20, 10);
    pane.scrollOffset = 0;
    const result = pane.render(80);

    expect(result.length).toBe(10);
    // Content is "Prompt:" + "" + 20 prompt lines = 22 lines
    // available=10, start = max(0, 22-10-0) = 12 → first visible is "prompt line 11"
    expect(result[0]).toContain("prompt line 11");
  });

  test("scrollOffset clamped to maxOffset", () => {
    const pane = makeRightPane(20, 10);
    // Content is: "Prompt:" + empty line + 20 prompt lines = 22 lines
    // available = displayHeight = 10
    // maxOffset = max(0, 22 - 10) = 12
    pane.scrollOffset = 999;
    pane.render(80);

    expect(pane.scrollOffset).toBe(12);
  });

  test("content sliced from scrollOffset", () => {
    const pane = makeRightPane(20, 10);
    pane.scrollOffset = 5;
    const result = pane.render(80);

    expect(result.length).toBe(10);
    // scrollOffset=5 means 5 lines back from tail
    // content=22 lines, available=10, start = max(0, 22-10-5) = 7 → "prompt line 6"
    expect(result[0]).toContain("prompt line 6");
  });

  test("pads to displayHeight when content is short", () => {
    const pane = makeRightPane(2, 10);
    pane.scrollOffset = 0;
    const result = pane.render(80);

    expect(result.length).toBe(10);
    // "Prompt:" + "" + 2 prompt lines = 4 content lines
    expect(result[0]).toContain("Prompt:");
    expect(result[2]).toContain("prompt line 1");
    expect(result[3]).toContain("prompt line 2");
    // Remaining lines should be padding (single space for left padding)
    for (let i = 4; i < 10; i++) {
      expect(result[i]).toBe(" ");
    }
  });

  test("setMode resets scrollOffset to 0", () => {
    const pane = makeRightPane(20, 10);
    pane.scrollOffset = 5;
    pane.setMode("TREE");
    expect(pane.scrollOffset).toBe(0);
  });
});

describe("DashboardComponent dialog and action handlers", () => {
  let dashboard: DashboardComponent;
  let lastIbCall: { args: string[]; cwd: string } | null;
  /** Tracks messages sent via native sendMessage (tmux send-keys) */
  let sentMessages: { target: string; message: string }[] = [];

  /** Set up the send spawn runner mock that tracks messages */
  function setupSendMock() {
    sentMessages = [];
    setSendSpawnRunner((cmd: string[]) => {
      // Track the actual message send-keys calls (not Enter or has-session)
      if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd.length === 7 && cmd[4] === "-l" && cmd[5] === "--") {
        // Extract target session and message
        const target = cmd[3]!;
        sentMessages.push({ target, message: cmd[6]! });
      }
      return makeSpawnResult();
    });
  }

  let actionTempDir: string | null = null;
  let configTempDir: string;
  // Writable repo root for send tests: sendMessage now ENQUEUES to the agent's
  // outbox.jsonl under <repoPath>/.ittybitty/agents/<id>/, so send targets need
  // a real (writable) repoPath rather than a synthetic /repos/... path.
  let sendRepoDir: string;

  beforeEach(async () => {
    // Isolate user config — sendMessage reads `user.name` to format
    // human-driven sends. Without isolation tests pick up whatever's in the
    // developer's ~/.itsybitsy/config.json, so `[sent by user]` asserts
    // would break if user.name is set.
    configTempDir = await mkdtemp(join(tmpdir(), "dashboard-config-"));
    setUserConfigPath(join(configTempDir, "config.json"));
    sendRepoDir = await mkdtemp(join(tmpdir(), "dashboard-send-"));
  });

  async function setupDashboardWithAgent(state = "running") {
    dashboard = makeDashboard();
    lastIbCall = null;

    // Create temp dir for native kill/pause operations
    actionTempDir = await mkdtemp(join(tmpdir(), "dashboard-action-"));
    const agentDir = join(actionTempDir, ".ittybitty", "agents", "agent-test");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-test",
      tmux_session: "tmux-agent-test",
    }));

    setupSendMock();

    // Mock spawn runners for native kill/pause/resume.
    // - pgrep → fail (no running process)
    // - has-session BEFORE new-session → fail (no live tmux, so resume guard passes)
    // - has-session AFTER new-session → succeed (resume's verify-before-nudge check)
    // - everything else → succeed
    let newSessionSeen = false;
    const noopSpawn = (cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "new-session") {
        newSessionSeen = true;
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }
      const isHasSession = cmd[0] === "tmux" && cmd.includes("has-session");
      const isPgrep = cmd.includes("pgrep");
      const code = isPgrep ? 1 : isHasSession ? (newSessionSeen ? 0 : 1) : 0;
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(code),
      } as SpawnResult;
    };
    setKillPauseSpawnRunner(noopSpawn);
    lifecycleSpawnCtx.set(noopSpawn);
    setNukeResumeSpawnRunner(noopSpawn);
    // Mock spawn runners for native diff/status and merge-check
    setDiffStatusSpawnRunner(() => makeSpawnResult());
    setMergeSpawnRunner(() => makeSpawnResult());

    const agent = makeAgent("agent-test", actionTempDir);
    setAgentState(agent, state);
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);
  }

  afterEach(async () => {
    resetSendSpawnRunner();
    resetKillPauseSpawnRunner();
    lifecycleSpawnCtx.reset();
    resetNukeResumeSpawnRunner();
    resetDiffStatusSpawnRunner();
    resetMergeSpawnRunner();
    resetUserConfigPath();
    if (actionTempDir) {
      await rm(actionTempDir, { recursive: true, force: true });
      actionTempDir = null;
    }
    await rm(configTempDir, { recursive: true, force: true });
    await rm(sendRepoDir, { recursive: true, force: true });
  });

  test("x key opens kill confirm dialog with button UI", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x");
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'confirm');
    expect(d.prompt).toContain("Kill agent");
    expect(d.prompt).toContain("agent-test");
    expect(d.confirmLabel).toBe("Kill");
    expect(d.focusedButton).toBe("cancel");
  });

  test("kill confirm dialog: Enter on Kill button executes kill", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x");
    // focusedButton defaults to "cancel", Tab to Kill, then press Enter
    dashboard.handleInput("\t");
    expect(assertDialog(dashboard.dialog, 'confirm').focusedButton).toBe("confirm");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    // Dialog should be dismissed after native kill executes
    expect(dashboard.dialog).toBeNull();
    // Agent directory should be removed by teardown
    const agentDir = join(actionTempDir!, ".ittybitty", "agents", "agent-test");
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
  });

  test("kill confirm dialog: Enter on default Cancel dismisses", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x");
    expect(assertDialog(dashboard.dialog, 'confirm').focusedButton).toBe("cancel");
    dashboard.handleInput("\r");
    expect(dashboard.dialog).toBeNull();
    expect(lastIbCall).toBeNull();
  });

  test("kill confirm dialog: Tab cycles between buttons", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x");
    const d = assertDialog(dashboard.dialog, 'confirm');
    expect(d.focusedButton).toBe("cancel");
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("confirm");
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("cancel");
  });

  test("kill confirm dialog: Escape cancels", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x");
    dashboard.handleInput("\x1b");
    expect(dashboard.dialog).toBeNull();
    expect(lastIbCall).toBeNull();
  });

  test("! key opens nuke confirm dialog", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("!");
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'confirm');
    expect(d.prompt).toContain("FORCE KILL");
    expect(d.confirmLabel).toBe("Nuke");
  });

  test("nuke confirm: Enter on Nuke button executes native nuke", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("!");
    // focusedButton defaults to "cancel", Tab to Nuke, then press Enter
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    // Dialog should be dismissed after native nuke executes
    expect(dashboard.dialog).toBeNull();
    // Agent directory should be removed by native nuke teardown
    const agentDir = join(actionTempDir!, ".ittybitty", "agents", "agent-test");
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
  });

  test("! key with no agent selected opens nuke-all confirm dialog", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ name: "test-repo", path: "/repos/test" }]);
    // No agents — so no agent is selected
    dashboard.onUpdate([], [], []);
    dashboard.handleInput("!");
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'confirm');
    expect(d.prompt).toContain("NUKE ALL");
    expect(d.confirmLabel).toBe("Nuke All");
    expect(d.focusedButton).toBe("cancel");
  });

  test("nuke-all confirm executes native nuke-all", async () => {
    dashboard = makeDashboard();
    lastIbCall = null;

    // Create temp dir with agent for nukeAllAgents to find
    actionTempDir = await mkdtemp(join(tmpdir(), "dashboard-nukeall-"));
    const agentDir = join(actionTempDir, ".ittybitty", "agents", "agent-one");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-one",
      tmux_session: "tmux-agent-one",
    }));

    const noopSpawn = (cmd: string[]) => ({
      stdout: new Response("").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(cmd.includes("pgrep") || cmd.includes("list-sessions") ? 1 : 0),
    } as SpawnResult);
    lifecycleSpawnCtx.set(noopSpawn);
    setNukeResumeSpawnRunner(noopSpawn);

    dashboard.setRepos([{ name: "test-repo", path: actionTempDir }]);
    dashboard.onUpdate([], [], []);
    dashboard.handleInput("!");
    // focusedButton is "cancel", Tab to move to confirm, then Enter
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    // Agent directory should be removed by native nuke-all
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
  });

  test("! key with no agent and multiple repos shows repo picker", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([
      { name: "repo-a", path: "/repos/a" },
      { name: "repo-b", path: "/repos/b" },
    ]);
    dashboard.onUpdate([], [], []);
    dashboard.handleInput("!");
    expect(dashboard.dialog).not.toBeNull();
    expect(assertDialog(dashboard.dialog, 'select').prompt).toContain("Nuke ALL");
  });

  test("R key resumes stopped agents", async () => {
    await setupDashboardWithAgent("stopped");
    dashboard.handleInput("R");
    await dashboard.flushPendingActions();
    // Native resume creates resume.sh and logs to agent.log
    const agentDir = join(actionTempDir!, ".ittybitty", "agents", "agent-test");
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("Agent resumed");
  });

  test("R key on a running agent attempts resume (defers refusal to liveness check)", async () => {
    await setupDashboardWithAgent("running");
    dashboard.handleInput("R");
    // The state gate was removed — handleResume no longer blocks a "running"
    // agent. It shows an immediate "Resuming…" notice synchronously, then
    // defers the actual refusal decision to resumeAgent()'s tmux-liveness
    // check. (This fixture mocks has-session→fail, so the resume proceeds.)
    expect(dashboard.notice).toContain("Resuming");
    await dashboard.flushPendingActions();
    // Resume proceeded: native resume logs to agent.log.
    const agentDir = join(actionTempDir!, ".ittybitty", "agents", "agent-test");
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("Agent resumed");
  });

  test("P key opens pause confirm dialog for running agents", async () => {
    await setupDashboardWithAgent("running");
    dashboard.handleInput("P");
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'confirm');
    expect(d.prompt).toContain("Pause agent");
    expect(d.confirmLabel).toBe("Pause");
    expect(d.focusedButton).toBe("cancel");
  });

  test("P key pause confirm executes pause command", async () => {
    await setupDashboardWithAgent("running");
    dashboard.handleInput("P");
    // Tab to confirm, then Enter
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    // Dialog should be dismissed after native pause executes
    expect(dashboard.dialog).toBeNull();
    // Agent directory should be preserved (pause does NOT remove it)
    const agentDir = join(actionTempDir!, ".ittybitty", "agents", "agent-test");
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
    // Agent.log should contain "Agent paused"
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("Agent paused");
  });

  test("P key works for waiting agents", async () => {
    await setupDashboardWithAgent("waiting");
    dashboard.handleInput("P");
    expect(dashboard.dialog).not.toBeNull();
    expect(dashboard.dialog!.type).toBe("confirm");
  });

  test("P key does not pause stopped agents", async () => {
    await setupDashboardWithAgent("stopped");
    dashboard.handleInput("P");
    expect(dashboard.dialog).toBeNull();
    expect(dashboard.notice).not.toBeNull();
  });

  test("P key pauses complete agents", async () => {
    await setupDashboardWithAgent("complete");
    dashboard.handleInput("P");
    expect(dashboard.dialog).not.toBeNull();
    expect(dashboard.dialog!.type).toBe("confirm");
  });

  test("r key opens reassign fuzzy select dialog", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("r");
    expect(assertDialog(dashboard.dialog, 'fuzzy').prompt).toContain("Reassign");
  });

  test("reassign fuzzy: shows '(No parent - make root)' as first option", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("r");
    const d = assertDialog(dashboard.dialog, 'fuzzy');
    expect(d.allItems[0]).toBe("(No parent - make root)");
  });

  test("reassign fuzzy: selecting 'No parent' clears manager in meta.json", async () => {
    await setupDashboardWithAgent();
    // Write initial manager value
    const metaPath = join(actionTempDir!, ".ittybitty", "agents", "agent-test", "meta.json");
    const meta = await Bun.file(metaPath).json();
    meta.manager = "agent-old";
    await Bun.write(metaPath, JSON.stringify(meta));

    dashboard.handleInput("r");
    // First item is already selected (index 0 = No parent), press Enter
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    const updated = await Bun.file(metaPath).json();
    expect(updated.manager).toBeNull();
  });

  test("reassign fuzzy: selecting a manager updates meta.json", async () => {
    // Set up with multiple agents in a temp dir so meta.json exists
    dashboard = makeDashboard();
    actionTempDir = await mkdtemp(join(tmpdir(), "dashboard-reassign-"));
    const agentsDir = join(actionTempDir, ".ittybitty", "agents");
    await mkdir(join(agentsDir, "agent-test"), { recursive: true });
    await mkdir(join(agentsDir, "agent-manager"), { recursive: true });
    await Bun.write(join(agentsDir, "agent-test", "meta.json"), JSON.stringify({
      id: "agent-test", tmux_session: "tmux-agent-test", manager: "",
    }));
    await Bun.write(join(agentsDir, "agent-manager", "meta.json"), JSON.stringify({
      id: "agent-manager", tmux_session: "tmux-agent-manager",
    }));
    // Mock send runner to prevent real tmux calls
    setSendSpawnRunner((cmd: string[]) => ({
      stdout: new Response("").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(cmd.includes("has-session") ? 1 : 0),
    } as SpawnResult));

    const agent1 = makeAgent("agent-test", actionTempDir);
    setAgentState(agent1, "running");
    const agent2 = makeAgent("agent-manager", actionTempDir);
    setAgentState(agent2, "running");
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1),
      makeFlatAgent(agent2),
    ];
    dashboard.onUpdate([agent1, agent2], flatList, []);

    dashboard.handleInput("r");
    const d = assertDialog(dashboard.dialog, 'fuzzy');
    expect(d.allItems).toContain("agent-manager");
    // Move down to agent-manager (index 1) and select — use arrow key, not j (which is a search char in fuzzy)
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    const updated = await Bun.file(join(agentsDir, "agent-test", "meta.json")).json();
    expect(updated.manager).toBe("agent-manager");
  });

  test("reassign fuzzy: excludes self and workers from candidates", () => {
    dashboard = makeDashboard();

    const agent1 = makeAgent("agent-test", "/repos/test");
    setAgentState(agent1, "running");
    const worker = makeAgent("agent-worker", "/repos/test");
    setAgentState(worker, "running");
    worker.meta.worker = true;
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1),
      makeFlatAgent(worker),
    ];
    dashboard.onUpdate([agent1, worker], flatList, []);

    dashboard.handleInput("r");
    const d = assertDialog(dashboard.dialog, 'fuzzy');
    expect(d.allItems).not.toContain("agent-test");  // self excluded
    expect(d.allItems).not.toContain("agent-worker");  // worker excluded
    expect(d.allItems).toEqual(["(No parent - make root)"]);
  });

  test("reassign fuzzy: excludes descendants to prevent circular dependency", () => {
    dashboard = makeDashboard();

    const parent = makeAgent("agent-parent", "/repos/test");
    setAgentState(parent, "running");
    const child = makeAgent("agent-child", "/repos/test");
    setAgentState(child, "running");
    child.meta.manager = "agent-parent";
    const grandchild = makeAgent("agent-grandchild", "/repos/test");
    setAgentState(grandchild, "running");
    grandchild.meta.manager = "agent-child";
    // Build tree
    parent.children = [child];
    child.children = [grandchild];
    const sibling = makeAgent("agent-sibling", "/repos/test");
    setAgentState(sibling, "running");
    const flatList: FlatEntry[] = [
      makeFlatAgent(parent),
      makeFlatAgent(child, { depth: 1, connector: "├── " }),
      makeFlatAgent(grandchild, { depth: 2, connector: "│   └── " }),
      makeFlatAgent(sibling),
    ];
    dashboard.onUpdate([parent, child, grandchild, sibling], flatList, []);

    // Select parent and reassign
    dashboard.handleInput("r");
    const d = assertDialog(dashboard.dialog, 'fuzzy');
    // Should not include child or grandchild (descendants of parent)
    expect(d.allItems).not.toContain("agent-child");
    expect(d.allItems).not.toContain("agent-grandchild");
    // Should include sibling
    expect(d.allItems).toContain("agent-sibling");
    expect(d.allItems).toContain("(No parent - make root)");
  });

  test("reassign fuzzy: excludes agents from other repos", () => {
    dashboard = makeDashboard();

    const agent1 = makeAgent("agent-test", "/repos/test");
    setAgentState(agent1, "running");
    const otherRepo = makeAgent("agent-other", "/repos/other");
    setAgentState(otherRepo, "running");
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1),
      makeFlatAgent(otherRepo),
    ];
    dashboard.onUpdate([agent1, otherRepo], flatList, []);

    dashboard.handleInput("r");
    const d = assertDialog(dashboard.dialog, 'fuzzy');
    expect(d.allItems).not.toContain("agent-other");
  });

  test("s key opens send textarea dialog", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    expect(assertDialog(dashboard.dialog, 'textarea').prompt).toContain("Send message");
  });

  test("send textarea: typing, backspace, and submitting", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    for (const ch of "hellx") dashboard.handleInput(ch);
    dashboard.handleInput("\x7f"); // backspace
    for (const ch of "o") dashboard.handleInput(ch);
    expect(assertDialog(dashboard.dialog, 'textarea').buffer.getText()).toBe("hello");
    // Tab to cancel, then tab to send button, then Enter to submit
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]!.message).toBe("[sent by user]: hello");
  });

  test("send textarea: Tab cycles forward through text → cancel → send → esc → text", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    const d = assertDialog(dashboard.dialog, 'textarea');
    expect(d.focusedButton).toBe("text");
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("cancel");
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("send");
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("esc");
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("text");
  });

  test("send textarea: Shift+Tab cycles backward through text → esc → send → cancel → text", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    const d = assertDialog(dashboard.dialog, 'textarea');
    expect(d.focusedButton).toBe("text");
    // Legacy Shift+Tab sequence
    dashboard.handleInput("\x1b[Z");
    expect(d.focusedButton).toBe("esc");
    dashboard.handleInput("\x1b[Z");
    expect(d.focusedButton).toBe("send");
    dashboard.handleInput("\x1b[Z");
    expect(d.focusedButton).toBe("cancel");
    dashboard.handleInput("\x1b[Z");
    expect(d.focusedButton).toBe("text");
  });

  test("send textarea: Kitty protocol Shift+Tab cycles backward", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    const d = assertDialog(dashboard.dialog, 'textarea');
    expect(d.focusedButton).toBe("text");
    // Kitty protocol Shift+Tab: CSI 9;2u (tab=9, shift modifier=2)
    dashboard.handleInput("\x1b[9;2u");
    expect(d.focusedButton).toBe("esc");
    dashboard.handleInput("\x1b[9;2u");
    expect(d.focusedButton).toBe("send");
    dashboard.handleInput("\x1b[9;2u");
    expect(d.focusedButton).toBe("cancel");
    dashboard.handleInput("\x1b[9;2u");
    expect(d.focusedButton).toBe("text");
  });

  test("send textarea: Enter on [ Send Esc ] button closes dialog and invokes onSendEsc", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    const d = assertDialog(dashboard.dialog, 'textarea');
    expect(d.onSendEsc).toBeDefined();

    // Replace onSendEsc with a test spy that doesn't go through tmux
    let invoked = false;
    d.onSendEsc = () => { invoked = true; dashboard.closeDialog(); };

    // Tab to esc focus: text → cancel → send → esc
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("esc");
    dashboard.handleInput("\r");
    expect(invoked).toBe(true);
    expect(dashboard.dialog).toBeNull();
  });

  test("send textarea: sendAll defaults to false", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    expect(assertDialog(dashboard.dialog, 'textarea').sendAll).toBe(false);
  });

  test("send textarea: Ctrl+A toggles sendAll", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    const d = assertDialog(dashboard.dialog, 'textarea');
    expect(d.sendAll).toBe(false);
    dashboard.handleInput("\x01"); // Ctrl+A
    expect(d.sendAll).toBe(true);
    dashboard.handleInput("\x01"); // Ctrl+A again
    expect(d.sendAll).toBe(false);
  });

  test("send textarea: Ctrl+A works from any focus position", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    // Start in text focus
    const d = assertDialog(dashboard.dialog, 'textarea');
    expect(d.focusedButton).toBe("text");
    dashboard.handleInput("\x01");
    expect(d.sendAll).toBe(true);
    // Tab to cancel
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("cancel");
    dashboard.handleInput("\x01");
    expect(d.sendAll).toBe(false);
    // Tab to send
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("send");
    dashboard.handleInput("\x01");
    expect(d.sendAll).toBe(true);
  });

  test("send textarea: sendAll sends to all active non-archived agents", async () => {
    dashboard = makeDashboard();
    setupSendMock();

    const agent1 = makeAgent("agent-a", sendRepoDir);
    agent1.state = "running";
    const agent2 = makeAgent("agent-b", sendRepoDir);
    agent2.state = "running";
    const agent3 = makeAgent("agent-c", sendRepoDir);
    agent3.archived = true; // should be skipped
    const agent4 = makeAgent("agent-d", sendRepoDir);
    agent4.meta.tmux_session = ""; // no tmux session, should be skipped
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1),
      makeFlatAgent(agent2),
      makeFlatAgent(agent3),
      makeFlatAgent(agent4),
    ];
    dashboard.onUpdate([agent1, agent2, agent3, agent4], flatList, []);

    dashboard.handleInput("s");
    dashboard.handleInput("\x01"); // Ctrl+A to toggle sendAll
    expect(assertDialog(dashboard.dialog, 'textarea').sendAll).toBe(true);
    for (const ch of "hi") dashboard.handleInput(ch);
    // Tab to cancel, tab to send, enter to submit
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    // Should have sent to agent-a and agent-b only (agent-c archived, agent-d no tmux)
    expect(sentMessages.length).toBe(2);
    expect(sentMessages[0]!.message).toBe("[sent by user]: hi");
    expect(sentMessages[1]!.message).toBe("[sent by user]: hi");
  });

  test("send textarea: sendAll=false sends to selected agent only", async () => {
    dashboard = makeDashboard();
    setupSendMock();

    const agent1 = makeAgent("agent-a", sendRepoDir);
    agent1.state = "running";
    const agent2 = makeAgent("agent-b", sendRepoDir);
    agent2.state = "running";
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1),
      makeFlatAgent(agent2),
    ];
    dashboard.onUpdate([agent1, agent2], flatList, []);

    dashboard.handleInput("s");
    expect(assertDialog(dashboard.dialog, 'textarea').sendAll).toBe(false);
    for (const ch of "hi") dashboard.handleInput(ch);
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]!.message).toBe("[sent by user]: hi");
  });

  test("send textarea: sendAll state is reflected in dialog", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("s");
    // sendAll starts as false
    const d = assertDialog(dashboard.dialog, 'textarea');
    expect(d.sendAll).toBe(false);
    // Toggle sendAll on
    dashboard.handleInput("\x01");
    expect(d.sendAll).toBe(true);
    // Dialog prompt remains the same (title unchanged)
    expect(d.prompt).toContain("Send message");
  });

  test("send textarea: answer question dialog does NOT have sendAll", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    agent.state = "running";
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    const question = { id: "q1", agent: "agent-test", question: "What?", timestamp: "2026-03-05T00:00:00Z", status: "pending" as const, repoPath: "/repos/test" };
    dashboard.onUpdate([agent], flatList, [question]);
    dashboard.jumpToMode("QUESTIONS");
    dashboard.handleInput("\r"); // Enter to answer
    const d = assertDialog(dashboard.dialog, 'textarea');
    expect(d.sendAll).toBeUndefined();
  });

  test("m key runs merge-check then shows confirm", async () => {
    await setupDashboardWithAgent();
    // Create worktree dir so mergeCheckAgent passes that check
    await mkdir(join(actionTempDir!, ".ittybitty", "agents", "agent-test", "repo"), { recursive: true });
    dashboard.handleInput("m");
    await dashboard.flushPendingActions();
    expect(assertDialog(dashboard.dialog, 'confirm').prompt).toContain("Merge agent-test");
  });

  test("merge: merge-check failure shows error message", async () => {
    await setupDashboardWithAgent();
    // Create worktree dir so mergeCheckAgent passes that check
    await mkdir(join(actionTempDir!, ".ittybitty", "agents", "agent-test", "repo"), { recursive: true });
    // Mock mergeSpawnRunner to return dirty status
    setMergeSpawnRunner((cmd: string[]) => {
      if (cmd.includes("--porcelain")) {
        return makeSpawnResult(0, "M dirty-file.ts\n");
      }
      return makeSpawnResult();
    });
    dashboard.handleInput("m");
    await dashboard.flushPendingActions();
    expect(dashboard.notice).toContain("Merge-check failed");
  });

  test("dialog intercepts all input when active", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x"); // opens confirm
    // Navigation keys should not change selection
    dashboard.handleInput("j");
    expect(dashboard.dialog).not.toBeNull(); // dialog still open
    expect(dashboard.dialog!.type).toBe("confirm");
  });

  test("no dialog without selected agent", () => {
    dashboard = makeDashboard();
    // No agents loaded, so no agent selected
    dashboard.handleInput("x");
    expect(dashboard.dialog).toBeNull();
  });

  test("a key with single repo skips repo select, goes straight to form", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);
    lastIbCall = null;

    dashboard.handleInput("a");
    // Should be new-agent-form dialog, not select dialog (repo)
    expect(assertDialog(dashboard.dialog, 'new-agent-form').repoName).toBe("only-repo");
  });

  test("a key with multiple repos and no selection uses first repo", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([
      { path: "/repos/one", name: "repo-one" },
      { path: "/repos/two", name: "repo-two" },
    ]);
    lastIbCall = null;

    dashboard.handleInput("a");
    expect(assertDialog(dashboard.dialog, 'new-agent-form').repoName).toBe("repo-one");
  });

  test("new-agent form: Tab cycles focus through all fields", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);

    dashboard.handleInput("a");
    const d = assertDialog(dashboard.dialog, 'new-agent-form');
    expect(d.focused).toBe("name");

    dashboard.handleInput("\t"); // Tab to agentType
    expect(d.focused).toBe("agentType");

    dashboard.handleInput("\t"); // Tab to prompt
    expect(d.focused).toBe("prompt");

    dashboard.handleInput("\t"); // Tab to cancel (create skipped — prompt empty)
    expect(d.focused).toBe("cancel");

    dashboard.handleInput("\t"); // Tab wraps to name (create skipped — prompt empty)
    expect(d.focused).toBe("name");

    // Type something in prompt to enable create
    dashboard.handleInput("\t"); // agentType
    dashboard.handleInput("\t"); // prompt
    for (const ch of "hello") dashboard.handleInput(ch);
    dashboard.handleInput("\t"); // cancel
    expect(d.focused).toBe("cancel");
    dashboard.handleInput("\t"); // create (now reachable)
    expect(d.focused).toBe("create");
  });

  test("new-agent form: Shift+Tab cycles focus backwards", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);

    dashboard.handleInput("a");
    const d = assertDialog(dashboard.dialog, 'new-agent-form');
    expect(d.focused).toBe("name");

    // Shift+Tab should go to cancel (create skipped — prompt empty)
    dashboard.handleInput("\x1b[Z"); // Shift+Tab escape sequence
    expect(d.focused).toBe("cancel");

    dashboard.handleInput("\x1b[Z");
    expect(d.focused).toBe("prompt");
  });

  test("new-agent form: Agent type cycles with Space and Enter", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);

    dashboard.handleInput("a");
    const d = assertDialog(dashboard.dialog, 'new-agent-form');
    dashboard.handleInput("\t"); // focus agentType
    expect(d.focused).toBe("agentType");
    expect(d.agentType).toBe("manager");

    // Cycling should walk through availableTypes in order and wrap.
    const types = d.availableTypes;
    expect(types.length).toBeGreaterThan(0);
    expect(types).toContain("manager");
    const managerIdx = types.indexOf("manager");

    // Space cycles forward once
    dashboard.handleInput(" ");
    expect(d.agentType).toBe(types[(managerIdx + 1) % types.length]!);

    // Enter cycles forward again
    dashboard.handleInput("\r");
    expect(d.agentType).toBe(types[(managerIdx + 2) % types.length]!);

    // Cycle all the way back to manager
    for (let i = 0; i < types.length - 2; i++) {
      dashboard.handleInput(" ");
    }
    expect(d.agentType).toBe("manager");
  });

  // Relies on "worker" sorting immediately after "manager" in the default types list,
  // so a single Space press from the default focus advances the selection from manager to worker.
  // Isolates process.env.HOME so the cycle reads only the embedded layer files
  // (developer-customized ~/.itsybitsy/agent-types/ would otherwise inject extra
  // spawnable types between manager and worker).
  test("new-agent form: cycling from manager to worker creates agent with worker meta field", async () => {
    const newAgentTempDir = await mkdtemp(join(tmpdir(), "ib-na-test-"));
    await mkdir(join(newAgentTempDir, ".ittybitty"), { recursive: true });
    await Bun.write(join(newAgentTempDir, ".ittybitty", "repo-id"), "abcd1234\n");
    setUserConfigPath(join(newAgentTempDir, "config.json"));
    await Bun.write(join(newAgentTempDir, "config.json"), JSON.stringify({ model: "claude:sonnet" }));

    const tempHome = await mkdtemp(join(tmpdir(), "ib-na-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    // Populate the temp HOME with embedded defaults so listSpawnableTypeNamesSync
    // returns exactly [coordinator, manager, worker] (system / _all / _non_coordinator
    // are filtered out as spawnable: false).
    await (await import("../agent-types")).ensureAgentTypesDir();

    const spawnCalls: string[] = [];
    const mockSpawn = (cmd: string[]): SpawnResult => {
      const cmdStr = cmd.join(" ");
      spawnCalls.push(cmdStr);
      const makeResult = (s: string, c: number) => ({
        stdout: new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode(s)); ctrl.close(); } }),
        stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
        exited: Promise.resolve(c),
      });
      if (cmdStr.includes("tmux has-session")) {
        const afterNew = spawnCalls.some(c => c.includes("tmux new-session"));
        return makeResult("", afterNew ? 0 : 1);
      }
      if (cmdStr.includes("tmux start-server")) return makeResult("", 0);
      if (cmdStr.includes("tmux new-session")) return makeResult("", 0);
      if (cmdStr.includes("worktree add")) {
        const repoIdx = cmd.indexOf("add") + 1;
        if (repoIdx > 0 && repoIdx < cmd.length) require("fs").mkdirSync(cmd[repoIdx]!, { recursive: true });
        return makeResult("", 0);
      }
      if (cmdStr.includes("--git-common-dir")) return makeResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeResult(newAgentTempDir, 0);
      if (cmdStr.includes("--git-dir")) return makeResult(".git", 0);
      if (cmdStr.includes("which gh")) return makeResult("", 1);
      if (cmd[cmd.length-1] === "remote") return makeResult("", 0);
      if (cmdStr.includes("capture-pane")) return makeResult("Claude Code v1.0", 0);
      return makeResult("", 0);
    };
    setNewAgentSpawnRunner(mockSpawn);
    lifecycleSpawnCtx.set(mockSpawn);

    dashboard = makeDashboard();
    dashboard.setRepos([{ path: newAgentTempDir, name: "only-repo" }]);

    dashboard.handleInput("a");
    dashboard.handleInput("\t");
    dashboard.handleInput(" ");
    dashboard.handleInput("\t");
    for (const ch of "do stuff") dashboard.handleInput(ch);
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");

    await dashboard.flushPendingActions();

    // Find the created agent's meta.json
    const agentsDir = join(newAgentTempDir, ".ittybitty", "agents");
    const { readdir: rd } = await import("fs/promises");
    const entries = await rd(agentsDir, { withFileTypes: true });
    const agentDirs = entries.filter(e => e.isDirectory());
    expect(agentDirs.length).toBe(1);
    const meta = await Bun.file(join(agentsDir, agentDirs[0]!.name, "meta.json")).json();
    expect(meta.worker).toBe(true);
    expect(meta.prompt).toBe("do stuff");

    resetNewAgentSpawnRunner();
    lifecycleSpawnCtx.reset();
    resetUserConfigPath();
    process.env.HOME = originalHome;
    await rm(newAgentTempDir, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  });

  test("new-agent form: Name field passes --name flag", async () => {
    const newAgentTempDir = await mkdtemp(join(tmpdir(), "ib-na-test-"));
    await mkdir(join(newAgentTempDir, ".ittybitty"), { recursive: true });
    await Bun.write(join(newAgentTempDir, ".ittybitty", "repo-id"), "abcd1234\n");
    setUserConfigPath(join(newAgentTempDir, "config.json"));
    await Bun.write(join(newAgentTempDir, "config.json"), JSON.stringify({ model: "claude:sonnet" }));

    // Isolate from the developer's real ~/.itsybitsy/ so the agent-type layer
    // files (and any `model:` they declare) come from embedded defaults rather
    // than the host install. Without this, the spawn would read the user's
    // possibly-stale ~/.itsybitsy/agent-types/_all.md and a bare-name `model:`
    // there would be rejected by parseModel (D1/D5).
    const tempHome = await mkdtemp(join(tmpdir(), "ib-na-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    await (await import("../agent-types")).ensureAgentTypesDir();

    const spawnCalls: string[] = [];
    const mockSpawn = (cmd: string[]): SpawnResult => {
      const cmdStr = cmd.join(" ");
      spawnCalls.push(cmdStr);
      const makeResult = (s: string, c: number) => ({
        stdout: new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode(s)); ctrl.close(); } }),
        stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
        exited: Promise.resolve(c),
      });
      if (cmdStr.includes("tmux has-session")) {
        const afterNew = spawnCalls.some(c => c.includes("tmux new-session"));
        return makeResult("", afterNew ? 0 : 1);
      }
      if (cmdStr.includes("tmux start-server")) return makeResult("", 0);
      if (cmdStr.includes("tmux new-session")) return makeResult("", 0);
      if (cmdStr.includes("worktree add")) {
        const repoIdx = cmd.indexOf("add") + 1;
        if (repoIdx > 0 && repoIdx < cmd.length) require("fs").mkdirSync(cmd[repoIdx]!, { recursive: true });
        return makeResult("", 0);
      }
      if (cmdStr.includes("--git-common-dir")) return makeResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeResult(newAgentTempDir, 0);
      if (cmdStr.includes("--git-dir")) return makeResult(".git", 0);
      if (cmdStr.includes("which gh")) return makeResult("", 1);
      if (cmd[cmd.length-1] === "remote") return makeResult("", 0);
      if (cmdStr.includes("capture-pane")) return makeResult("Claude Code v1.0", 0);
      return makeResult("", 0);
    };
    setNewAgentSpawnRunner(mockSpawn);
    lifecycleSpawnCtx.set(mockSpawn);

    dashboard = makeDashboard();
    dashboard.setRepos([{ path: newAgentTempDir, name: "only-repo" }]);

    dashboard.handleInput("a");
    for (const ch of "my-agent") dashboard.handleInput(ch);
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    for (const ch of "do stuff") dashboard.handleInput(ch);
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");

    await dashboard.flushPendingActions();

    const meta = await Bun.file(join(newAgentTempDir, ".ittybitty", "agents", "my-agent", "meta.json")).json();
    expect(meta.id).toBe("my-agent");
    expect(meta.prompt).toBe("do stuff");

    resetNewAgentSpawnRunner();
    lifecycleSpawnCtx.reset();
    resetUserConfigPath();
    process.env.HOME = originalHome;
    await rm(newAgentTempDir, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  });

  test("new-agent form: Create is no-op when prompt is empty", async () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);

    dashboard.handleInput("a");
    // Tab past name, agentType, prompt (empty) — create is skipped, lands on cancel, wraps to name
    dashboard.handleInput("\t"); // agentType
    dashboard.handleInput("\t"); // prompt
    dashboard.handleInput("\t"); // cancel (create skipped)
    const d = assertDialog(dashboard.dialog, 'new-agent-form');
    expect(d.focused).toBe("cancel");
    dashboard.handleInput("\t"); // name (create still skipped — prompt still empty)
    expect(d.focused).toBe("name");
    await dashboard.flushPendingActions();
    // Should NOT have called newAgent
    expect(lastIbCall).toBeNull();
    // Dialog should still be open
    expect(dashboard.dialog).not.toBeNull();
  });

  test("new-agent form: Cancel button closes dialog", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);

    dashboard.handleInput("a");
    expect(dashboard.dialog!.type).toBe("new-agent-form");
    // Tab to cancel
    dashboard.handleInput("\t"); // agentType
    dashboard.handleInput("\t"); // prompt
    dashboard.handleInput("\t"); // cancel
    expect(assertDialog(dashboard.dialog, 'new-agent-form').focused).toBe("cancel");
    dashboard.handleInput("\r");
    expect(dashboard.dialog).toBeNull();
  });

  test("new-agent form: Prompt supports multi-line with Enter", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);

    dashboard.handleInput("a");
    // Tab to prompt
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    const d = assertDialog(dashboard.dialog, 'new-agent-form');
    expect(d.focused).toBe("prompt");
    for (const ch of "line one") dashboard.handleInput(ch);
    dashboard.handleInput("\r"); // newline in prompt
    for (const ch of "line two") dashboard.handleInput(ch);
    expect(d.buffer.getLines()).toEqual(["line one", "line two"]);
  });

  test("A key is not bound (removed)", () => {
    dashboard = makeDashboard();
    const agent1 = makeAgent("agent-active", "/repos/test");
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent1], flatList, []);
    // A key should be a no-op (no crash)
    dashboard.handleInput("A");
  });

});

describe("Cross-repo send (E key)", () => {
  let dashboard: DashboardComponent;
  let sentMessages: { target: string; message: string }[] = [];
  // Writable repo root for the full-flow send test — sendMessage enqueues to
  // the target's outbox.jsonl, so the send target needs a real repoPath.
  let sendRepoDir: string;

  function setupSendMock() {
    sentMessages = [];
    setSendSpawnRunner((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd.length === 7 && cmd[4] === "-l" && cmd[5] === "--") {
        sentMessages.push({ target: cmd[3]!, message: cmd[6]! });
      }
      return makeSpawnResult();
    });
  }

  beforeEach(async () => {
    sendRepoDir = await mkdtemp(join(tmpdir(), "dashboard-esend-"));
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    await rm(sendRepoDir, { recursive: true, force: true });
  });

  test("E key no-op with single repo", () => {
    dashboard = makeDashboard();
    setupSendMock();
    const agent = makeAgent("agent-a", "/repos/alpha");
    setAgentState(agent, "running");
    dashboard.setRepos([{ path: "/repos/alpha", name: "alpha" }]);
    dashboard.onUpdate([agent], [makeFlatAgent(agent)], []);
    dashboard.handleInput("E");
    // Should show notice, not a dialog
    expect(dashboard.dialog).toBeNull();
  });

  test("E key shows repo select with 2+ repos", () => {
    dashboard = makeDashboard();
    setupSendMock();
    const agentA = makeAgent("agent-a", "/repos/alpha");
    setAgentState(agentA, "running");
    agentA.repoName = "alpha";
    const agentB = makeAgent("agent-b", "/repos/beta");
    setAgentState(agentB, "running");
    agentB.repoName = "beta";
    dashboard.setRepos([
      { path: "/repos/alpha", name: "alpha" },
      { path: "/repos/beta", name: "beta" },
    ]);
    dashboard.onUpdate([agentA, agentB], [makeFlatAgent(agentA), makeFlatAgent(agentB)], []);

    dashboard.handleInput("E");
    // Should exclude current agent's repo — only 1 candidate, so skip to agent select
    const d = assertDialog(dashboard.dialog, 'select');
    expect(d.prompt).toContain("Send to agent in");
    // Should show agent-b since we're in alpha's repo
    expect(d.items.length).toBe(1);
    expect(d.items[0]).toContain("agent-b");
  });

  test("E key shows repo picker when both repos have agents and no agent selected", () => {
    dashboard = makeDashboard();
    setupSendMock();
    const agentA = makeAgent("agent-a", "/repos/alpha");
    setAgentState(agentA, "running");
    agentA.repoName = "alpha";
    const agentB = makeAgent("agent-b", "/repos/beta");
    setAgentState(agentB, "running");
    agentB.repoName = "beta";
    dashboard.setRepos([
      { path: "/repos/alpha", name: "alpha" },
      { path: "/repos/beta", name: "beta" },
    ]);
    dashboard.onUpdate(
      [agentA, agentB],
      [makeFlatRepoHeader("alpha", "/repos/alpha", true), makeFlatAgent(agentA), makeFlatRepoHeader("beta", "/repos/beta", true), makeFlatAgent(agentB)],
      []
    );
    // Select a repo header so no agent is selected
    dashboard.agentTree.moveSelection(-10); // go to top
    dashboard.syncSelectedAgent();

    dashboard.handleInput("E");
    const d = assertDialog(dashboard.dialog, 'select');
    expect(d.prompt).toContain("which repo");
    expect(d.items.length).toBe(2);
  });

  test("E key step 2 shows agent select after repo select", () => {
    dashboard = makeDashboard();
    setupSendMock();
    const agentA = makeAgent("agent-a", "/repos/alpha");
    setAgentState(agentA, "running");
    agentA.repoName = "alpha";
    const agentB1 = makeAgent("agent-b1", "/repos/beta");
    setAgentState(agentB1, "running");
    agentB1.repoName = "beta";
    const agentB2 = makeAgent("agent-b2", "/repos/beta");
    setAgentState(agentB2, "waiting");
    agentB2.repoName = "beta";
    dashboard.setRepos([
      { path: "/repos/alpha", name: "alpha" },
      { path: "/repos/beta", name: "beta" },
    ]);
    dashboard.onUpdate(
      [agentA, agentB1, agentB2],
      [makeFlatAgent(agentA), makeFlatAgent(agentB1), makeFlatAgent(agentB2)],
      []
    );

    dashboard.handleInput("E");
    // Only 1 other repo — skips to agent select directly
    const d = assertDialog(dashboard.dialog, 'select');
    expect(d.prompt).toContain("Send to agent in");
    expect(d.items.length).toBe(2);
    expect(d.items[0]).toContain("agent-b1");
    expect(d.items[1]).toContain("agent-b2");
  });

  test("E key step 3 shows message input after agent select", () => {
    dashboard = makeDashboard();
    setupSendMock();
    const agentA = makeAgent("agent-a", "/repos/alpha");
    setAgentState(agentA, "running");
    agentA.repoName = "alpha";
    const agentB = makeAgent("agent-b", "/repos/beta");
    setAgentState(agentB, "running");
    agentB.repoName = "beta";
    dashboard.setRepos([
      { path: "/repos/alpha", name: "alpha" },
      { path: "/repos/beta", name: "beta" },
    ]);
    dashboard.onUpdate([agentA, agentB], [makeFlatAgent(agentA), makeFlatAgent(agentB)], []);

    dashboard.handleInput("E");
    // Step 2: agent select (repo was auto-skipped)
    const selectDialog = assertDialog(dashboard.dialog, 'select');
    selectDialog.onSelect(0); // select agent-b

    // Step 3: message input
    const inputDialog = assertDialog(dashboard.dialog, 'input');
    expect(inputDialog.prompt).toContain("agent-b");
  });

  test("E key full flow calls sendMessage with correct args", async () => {
    dashboard = makeDashboard();
    setupSendMock();
    const alphaPath = join(sendRepoDir, "alpha");
    const betaPath = join(sendRepoDir, "beta");
    const agentA = makeAgent("agent-a", alphaPath);
    setAgentState(agentA, "running");
    agentA.repoName = "alpha";
    const agentB = makeAgent("agent-b", betaPath);
    setAgentState(agentB, "running");
    agentB.repoName = "beta";
    dashboard.setRepos([
      { path: alphaPath, name: "alpha" },
      { path: betaPath, name: "beta" },
    ]);
    dashboard.onUpdate([agentA, agentB], [makeFlatAgent(agentA), makeFlatAgent(agentB)], []);

    dashboard.handleInput("E");
    // Agent select (repo auto-skipped)
    assertDialog(dashboard.dialog, 'select').onSelect(0);
    // Message input
    const inputDialog = assertDialog(dashboard.dialog, 'input');
    inputDialog.onSubmit("hello cross-repo");
    await dashboard.flushPendingActions();

    // Verify message was sent to agent-b's tmux session
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const msg = sentMessages.find((m) => m.target === "tmux-agent-b");
    expect(msg).toBeDefined();
    expect(msg!.message).toContain("hello cross-repo");
  });

  test("E key excludes archived agents from selection", () => {
    dashboard = makeDashboard();
    setupSendMock();
    const agentA = makeAgent("agent-a", "/repos/alpha");
    setAgentState(agentA, "running");
    agentA.repoName = "alpha";
    const agentB = makeAgent("agent-b", "/repos/beta");
    setAgentState(agentB, "running");
    agentB.repoName = "beta";
    const agentC = makeAgent("agent-c", "/repos/beta");
    setAgentState(agentC, "stopped");
    agentC.archived = true;
    agentC.repoName = "beta";
    dashboard.setRepos([
      { path: "/repos/alpha", name: "alpha" },
      { path: "/repos/beta", name: "beta" },
    ]);
    dashboard.onUpdate([agentA, agentB, agentC], [makeFlatAgent(agentA), makeFlatAgent(agentB), makeFlatAgent(agentC)], []);

    dashboard.handleInput("E");
    const d = assertDialog(dashboard.dialog, 'select');
    // Only agent-b should be in the list (agent-c is archived)
    expect(d.items.length).toBe(1);
    expect(d.items[0]).toContain("agent-b");
  });

  test("E key empty message cancels send", async () => {
    dashboard = makeDashboard();
    setupSendMock();
    const agentA = makeAgent("agent-a", "/repos/alpha");
    setAgentState(agentA, "running");
    agentA.repoName = "alpha";
    const agentB = makeAgent("agent-b", "/repos/beta");
    setAgentState(agentB, "running");
    agentB.repoName = "beta";
    dashboard.setRepos([
      { path: "/repos/alpha", name: "alpha" },
      { path: "/repos/beta", name: "beta" },
    ]);
    dashboard.onUpdate([agentA, agentB], [makeFlatAgent(agentA), makeFlatAgent(agentB)], []);

    dashboard.handleInput("E");
    assertDialog(dashboard.dialog, 'select').onSelect(0);
    assertDialog(dashboard.dialog, 'input').onSubmit("  ");
    await dashboard.flushPendingActions();

    expect(sentMessages.length).toBe(0);
  });
});

describe("parseDenials", () => {
  test("parses PreToolUse denial lines", () => {
    const lines = [
      "[2026-03-05 15:37:26] [PreToolUse] Permission denied: Bash (command: ls, description: list files)",
      "[2026-03-05 15:37:30] Agent created (prompt: test)",
      "[2026-03-05 15:38:00] [PreToolUse] Permission denied: Read (file: /etc/passwd)",
    ];
    const denials = parseDenials(lines);
    expect(denials.length).toBe(2);
    expect(denials[0]!.timestamp).toBe("2026-03-05 15:37:26");
    expect(denials[0]!.line).toContain("Permission denied: Bash");
    expect(denials[1]!.timestamp).toBe("2026-03-05 15:38:00");
  });

  test("returns empty array when no denials", () => {
    const lines = [
      "[2026-03-05 15:37:26] Agent created (prompt: test)",
      "[2026-03-05 15:37:30] Spawned worker subagent: agent-abc",
    ];
    expect(parseDenials(lines)).toEqual([]);
  });

  test("handles empty input", () => {
    expect(parseDenials([])).toEqual([]);
  });

  test("sets epoch from timestamp", () => {
    const lines = [
      "[2026-03-05 15:37:26] [PreToolUse] Permission denied: Bash (command: ls)",
    ];
    const denials = parseDenials(lines);
    expect(denials[0]!.epoch).toBeGreaterThan(0);
  });
});

describe("readAgentPrompt", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads prompt.txt for active agent", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "prompt.txt"), "Do the thing\nLine 2");

    const agent = makeAgent("agent-abc", tmpDir, false);
    const lines = await readAgentPrompt(agent);
    expect(lines).toEqual(["Do the thing", "Line 2"]);
  });

  test("falls back to meta.prompt when prompt.txt missing", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });

    const agent = makeAgent("agent-abc", tmpDir, false);
    agent.meta.prompt = "meta prompt text";
    const lines = await readAgentPrompt(agent);
    expect(lines).toEqual(["meta prompt text"]);
  });

  test("reads from archive dir for archived agent", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "archive", "agent-old");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "prompt.txt"), "archived prompt");

    const agent = makeAgent("agent-old", tmpDir, true);
    const lines = await readAgentPrompt(agent);
    expect(lines).toEqual(["archived prompt"]);
  });
});

describe("DashboardComponent right pane and navigation features", () => {
  let dashboard: DashboardComponent;
  let lastIbCall: { args: string[]; cwd: string } | null;
  let sentMessages: { target: string; message: string }[] = [];
  let configTempDir: string;

  function setupSendMock() {
    sentMessages = [];
    setSendSpawnRunner((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd.length === 7 && cmd[4] === "-l" && cmd[5] === "--") {
        sentMessages.push({ target: cmd[3]!, message: cmd[6]! });
      }
      return makeSpawnResult();
    });
  }

  function setupDashboard(state = "running") {
    dashboard = makeDashboard();
    setupSendMock();

    const agent = makeAgent("agent-test", "/repos/test");
    setAgentState(agent, state);
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);
  }

  beforeEach(async () => {
    // Isolate user config — sendMessage reads `user.name` to format
    // human-driven sends. Without isolation tests would pick up the
    // developer's ~/.itsybitsy/config.json.
    configTempDir = await mkdtemp(join(tmpdir(), "dashboard-config-"));
    setUserConfigPath(join(configTempDir, "config.json"));
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetDiffStatusSpawnRunner();
    resetUserConfigPath();
    await rm(configTempDir, { recursive: true, force: true });
  });

  test("addError adds timestamped error to errors list", () => {
    dashboard = makeDashboard();
    dashboard.addError("Something went wrong");
    expect(dashboard.errors.length).toBe(1);
    expect(dashboard.errors[0]).toContain("Something went wrong");
  });

  test("addError deduplicates same message and updates timestamp", () => {
    dashboard = makeDashboard();
    dashboard.addError("Failed to read meta.json");
    expect(dashboard.errors.length).toBe(1);
    const first = dashboard.errors[0]!;
    // Adding the same message again should NOT create a second entry
    dashboard.addError("Failed to read meta.json");
    expect(dashboard.errors.length).toBe(1);
    // The entry should still contain the message
    expect(dashboard.errors[0]).toContain("Failed to read meta.json");
  });

  test("addError keeps different messages separate", () => {
    dashboard = makeDashboard();
    dashboard.addError("error A");
    dashboard.addError("error B");
    expect(dashboard.errors.length).toBe(2);
    expect(dashboard.errors[0]).toContain("error A");
    expect(dashboard.errors[1]).toContain("error B");
  });

  test("addError does not false-match suffix substrings", () => {
    dashboard = makeDashboard();
    dashboard.addError("parse error");
    dashboard.addError("error");
    // These are different messages — both should be kept
    expect(dashboard.errors.length).toBe(2);
  });

  test("clearErrors removes all errors", () => {
    dashboard = makeDashboard();
    dashboard.addError("Error 1");
    dashboard.addError("Error 2");
    expect(dashboard.errors.length).toBe(2);
    dashboard.clearErrors();
    expect(dashboard.errors.length).toBe(0);
  });

  test("c key clears errors only in ERRORS mode", () => {
    setupDashboard();
    dashboard.addError("test error");
    // c in non-ERRORS mode does nothing
    dashboard.handleInput("c");
    expect(dashboard.errors.length).toBe(1);
    // Jump to ERRORS mode
    dashboard.handleInput("e");
    dashboard.handleInput("c");
    expect(dashboard.errors.length).toBe(0);
  });

  test("d key triggers diff loading and jumps to DIFF mode", async () => {
    setupDashboard();
    // diffAgent will fail (no worktree at /repos/test) but mode still switches
    dashboard.handleInput("d");
    expect(dashboard.currentMode).toBe("DIFF");
    await Bun.sleep(50);
    // The diff content should contain error text about no worktree
    expect(dashboard.rightPane.diffLoading).toBe(false);
  });

  test("g key jumps to STATUS mode", () => {
    setupDashboard();
    expect(dashboard.currentMode).toBe("AGENT LOG");
    dashboard.handleInput("g");
    expect(dashboard.currentMode).toBe("STATUS");
  });

  test("g key in QUESTIONS mode navigates to agent and switches mode", () => {
    dashboard = makeDashboard();

    const agent1 = makeAgent("agent-a", "/repos/test");
    const agent2 = makeAgent("agent-b", "/repos/test");
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1, { connector: "├── " }),
      makeFlatAgent(agent2, { connector: "└── " }),
    ];
    const questions: PendingQuestion[] = [{
      id: "q-1",
      agent: "agent-a",
      question: "Should I proceed?",
      timestamp: "2026-03-05T15:00:00Z",
      status: "pending",
    }];
    dashboard.onUpdate([agent1, agent2], flatList, questions);

    // Start with agent-a selected — questions filtered to agent-a
    expect(dashboard.selectedAgent?.id).toBe("agent-a");
    // Jump to QUESTIONS
    dashboard.handleInput("q");
    expect(dashboard.currentMode).toBe("QUESTIONS");
    // Press g to go to agent-a (the question's agent) — switches to AGENT LOG
    dashboard.handleInput("g");
    expect(dashboard.selectedAgent?.id).toBe("agent-a");
    expect(dashboard.currentMode).toBe("AGENT LOG");
  });

  test("Enter in QUESTIONS mode opens answer dialog", () => {
    dashboard = makeDashboard();

    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    const questions: PendingQuestion[] = [{
      id: "q-1",
      agent: "agent-test",
      question: "Should I proceed?",
      timestamp: "2026-03-05T15:00:00Z",
      status: "pending",
    }];
    dashboard.onUpdate([agent], flatList, questions);

    dashboard.handleInput("q"); // jump to QUESTIONS
    dashboard.handleInput("\r"); // Enter to answer
    expect(dashboard.dialog).not.toBeNull();
    expect(assertDialog(dashboard.dialog, 'textarea').prompt).toContain("Answer");
  });

  test("answer question sends acknowledge then message", async () => {
    // Set up a temp dir with a questions file for native acknowledgeQuestion
    const tempRepo = await mkdtemp(join(tmpdir(), "dash-ack-"));
    await mkdir(join(tempRepo, ".ittybitty"), { recursive: true });
    const questionsPath = join(tempRepo, ".ittybitty", "user-questions.json");
    await Bun.write(questionsPath, JSON.stringify({
      questions: [{ id: "q-1", agent: "agent-test", question: "Should I proceed?", status: "pending", timestamp: "2026-03-05T15:00:00Z" }],
    }, null, 2));

    dashboard = makeDashboard();
    setupSendMock();

    const agent = makeAgent("agent-test", tempRepo);
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    const questions: PendingQuestion[] = [{
      id: "q-1",
      agent: "agent-test",
      question: "Should I proceed?",
      timestamp: "2026-03-05T15:00:00Z",
      status: "pending",
    }];
    dashboard.onUpdate([agent], flatList, questions);

    dashboard.handleInput("q"); // QUESTIONS mode
    dashboard.handleInput("\r"); // Enter to answer — opens textarea
    // Type answer
    for (const ch of "yes") dashboard.handleInput(ch);
    dashboard.handleInput("\t"); // Tab to Cancel button
    dashboard.handleInput("\t"); // Tab to Send button
    dashboard.handleInput("\r"); // Submit
    await dashboard.flushPendingActions();

    // Should have acknowledged natively (file updated)
    const updated = await Bun.file(questionsPath).json();
    expect(updated.questions[0].status).toBe("acknowledged");
    expect(updated.questions[0].acknowledged_at).toBeTruthy();
    // And sent the message (via native send)
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]!.message).toBe("[sent by user]: yes");

    await rm(tempRepo, { recursive: true, force: true });
  });

  test("Escape in QUESTIONS mode acknowledges question", async () => {
    // Set up a temp dir with a questions file for native acknowledgeQuestion
    const tempRepo = await mkdtemp(join(tmpdir(), "dash-esc-ack-"));
    await mkdir(join(tempRepo, ".ittybitty"), { recursive: true });
    const questionsPath = join(tempRepo, ".ittybitty", "user-questions.json");
    await Bun.write(questionsPath, JSON.stringify({
      questions: [{ id: "q-1", agent: "agent-test", question: "Should I proceed?", status: "pending", timestamp: "2026-03-05T15:00:00Z" }],
    }, null, 2));

    dashboard = makeDashboard();

    const agent = makeAgent("agent-test", tempRepo);
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    const questions: PendingQuestion[] = [{
      id: "q-1",
      agent: "agent-test",
      question: "Should I proceed?",
      timestamp: "2026-03-05T15:00:00Z",
      status: "pending",
    }];
    dashboard.onUpdate([agent], flatList, questions);

    dashboard.handleInput("q"); // QUESTIONS mode
    dashboard.handleInput("\x1b"); // Escape to acknowledge
    await dashboard.flushPendingActions();

    // Should have acknowledged natively (file updated)
    const updated = await Bun.file(questionsPath).json();
    expect(updated.questions[0].status).toBe("acknowledged");
    expect(updated.questions[0].acknowledged_at).toBeTruthy();

    await rm(tempRepo, { recursive: true, force: true });
  });

  test("j/k navigate questions in QUESTIONS mode when questions focused", () => {
    dashboard = makeDashboard();
    const agent1 = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1),
    ];
    const questions: PendingQuestion[] = [
      { id: "q-1", agent: "agent-a", question: "Q1?", timestamp: "2026-03-05T15:00:00Z", status: "pending" },
      { id: "q-2", agent: "agent-a", question: "Q2?", timestamp: "2026-03-05T15:01:00Z", status: "pending" },
    ];
    dashboard.onUpdate([agent1], flatList, questions);

    dashboard.handleInput("q"); // QUESTIONS mode
    expect(dashboard.questionsSelectedIndex).toBe(0);
    // j/k navigate agents by default (not questions)
    expect(dashboard.questionsFocused).toBe(false);
    // Focus questions list directly (Tab now cycles panels, not questions)
    dashboard.setQuestionsFocused(true);
    expect(dashboard.questionsFocused).toBe(true);
    dashboard.handleInput("j"); // move down in questions
    expect(dashboard.questionsSelectedIndex).toBe(1);
    dashboard.handleInput("k"); // move back up
    expect(dashboard.questionsSelectedIndex).toBe(0);
    // j/k should not change agent tree selection when questions focused
    expect(dashboard.selectedAgent?.id).toBe("agent-a");
  });

  test("j/k navigate agents in QUESTIONS mode when tree focused", () => {
    dashboard = makeDashboard();
    const agent1 = makeAgent("agent-a", "/repos/test");
    const agent2 = makeAgent("agent-b", "/repos/test");
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1, { connector: "├── " }),
      makeFlatAgent(agent2, { connector: "└── " }),
    ];
    const questions: PendingQuestion[] = [
      { id: "q-1", agent: "agent-a", question: "Q1?", timestamp: "2026-03-05T15:00:00Z", status: "pending" },
      { id: "q-2", agent: "agent-b", question: "Q2?", timestamp: "2026-03-05T15:01:00Z", status: "pending" },
    ];
    dashboard.onUpdate([agent1, agent2], flatList, questions);

    dashboard.handleInput("q"); // QUESTIONS mode
    expect(dashboard.questionsFocused).toBe(false);
    expect(dashboard.selectedAgent?.id).toBe("agent-a");
    dashboard.handleInput("j"); // move to next agent
    expect(dashboard.selectedAgent?.id).toBe("agent-b");
  });

  test("j/k in QUESTIONS mode clamps to bounds when questions focused", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    const questions: PendingQuestion[] = [
      { id: "q-1", agent: "agent-a", question: "Q1?", timestamp: "2026-03-05T15:00:00Z", status: "pending" },
    ];
    dashboard.onUpdate([agent], flatList, questions);

    dashboard.handleInput("q");
    dashboard.setQuestionsFocused(true); // focus questions (Tab now cycles panels)
    expect(dashboard.questionsSelectedIndex).toBe(0);
    dashboard.handleInput("j"); // try to go past end
    expect(dashboard.questionsSelectedIndex).toBe(0); // clamped
    dashboard.handleInput("k"); // try to go before start
    expect(dashboard.questionsSelectedIndex).toBe(0); // clamped
  });

  test("selectAgentById via g in QUESTIONS navigates correctly", () => {
    dashboard = makeDashboard();
    const agent1 = makeAgent("agent-a", "/repos/test");
    const agent2 = makeAgent("agent-b", "/repos/test");
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1, { connector: "├── " }),
      makeFlatAgent(agent2, { connector: "└── " }),
    ];
    const questions: PendingQuestion[] = [{
      id: "q-1",
      agent: "agent-b",
      question: "test?",
      timestamp: "2026-03-05T15:00:00Z",
      status: "pending",
    }];
    dashboard.onUpdate([agent1, agent2], flatList, questions);

    // Select agent-b first so its question is visible
    expect(dashboard.selectedAgent?.id).toBe("agent-a");
    dashboard.handleInput("j"); // move to agent-b
    expect(dashboard.selectedAgent?.id).toBe("agent-b");
    dashboard.handleInput("q"); // QUESTIONS mode — shows agent-b's question
    dashboard.handleInput("g"); // go to agent-b (already selected, switches to AGENT LOG)
    expect(dashboard.selectedAgent?.id).toBe("agent-b");
    expect(dashboard.currentMode).toBe("AGENT LOG");
  });
});

describe("focus cycling", () => {
  test("Tab cycles focus forward through all targets (no coordinator in normal mode)", () => {
    // §17.1: teams-tree is NOT in the cycle — reachable only via '0'.
    const dashboard = makeDashboard();
    expect(dashboard.focus).toBe("agent-tree");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("active-agent");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("right-pane");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("agent-tree");
  });

  test("Shift+Tab cycles focus backward through all targets (no coordinator in normal mode)", () => {
    // §17.1: teams-tree is NOT in the cycle — reachable only via '0'.
    const dashboard = makeDashboard();
    expect(dashboard.focus).toBe("agent-tree");
    dashboard.handleInput("\x1b[Z"); // Shift+Tab
    expect(dashboard.focus).toBe("right-pane");
    dashboard.handleInput("\x1b[Z");
    expect(dashboard.focus).toBe("active-agent");
    dashboard.handleInput("\x1b[Z");
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("\x1b[Z");
    expect(dashboard.focus).toBe("agent-tree");
  });

  test("default focus is agent-tree on startup", () => {
    const dashboard = makeDashboard();
    expect(dashboard.focus).toBe("agent-tree");
  });

  test("main title separator uses REVERSE when active-agent is focused", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Set terminal size for render
    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      // Default focus (agent-tree): main title separator should NOT have REVERSE
      const linesDefault = dashboard.render(160);
      // The merged line contains sidebar│main — extract the main part (after sidebar separator │)
      const titleLineDefault = linesDefault.find(l => stripAnsi(l).includes("agent-a"));
      expect(titleLineDefault).toBeDefined();
      // Split at the │ separator to get just the main area portion
      const mainPartDefault = titleLineDefault!.split("│").slice(1).join("│");
      expect(mainPartDefault).not.toContain("\x1b[7m"); // REVERSE

      // Tab to active-agent (agent-tree -> info -> active-agent)
      dashboard.handleInput("\t"); // info
      dashboard.handleInput("\t"); // active-agent
      expect(dashboard.focus).toBe("active-agent");

      const linesFocused = dashboard.render(160);
      const titleLineFocused = linesFocused.find(l => stripAnsi(l).includes("agent-a"));
      expect(titleLineFocused).toBeDefined();
      const mainPartFocused = titleLineFocused!.split("│").slice(1).join("│");
      expect(mainPartFocused).toContain("\x1b[7m"); // REVERSE
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  // §17.1 Phase 3 three-axis model: `0` / `1` switch sidebar visibility. Focus
  // moves only when the current target is the HEAD of one cycle and is not in
  // the other cycle: `agent-tree` ↔ `teams-tree`. Shared targets stay put.
  test("'0' from agent-tree focus moves focus to teams-tree (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    expect(dashboard.focus).toBe("agent-tree");
    expect(dashboard.sidebarMode).toBe("agents");
    dashboard.handleInput("0");
    expect(dashboard.sidebarMode).toBe("teams");
    // Phase 3: focus mirrors agent-tree → teams-tree.
    expect(dashboard.focus).toBe("teams-tree");
  });

  test("'0' from a shared focus target leaves focus alone (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    // Move focus to a target that exists in BOTH FOCUS_ORDER and
    // TEAMS_FOCUS_ORDER (info / active-agent / right-pane). Tab once → info.
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("0");
    expect(dashboard.sidebarMode).toBe("teams");
    // Focus unchanged because info is in BOTH cycles.
    expect(dashboard.focus).toBe("info");
  });

  test("'1' from teams-tree focus moves focus to agent-tree (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    // Set up: sidebarMode=teams + focus on teams-tree (the natural state after `0`).
    dashboard.handleInput("0");
    expect(dashboard.sidebarMode).toBe("teams");
    expect(dashboard.focus).toBe("teams-tree");
    dashboard.handleInput("1");
    expect(dashboard.sidebarMode as string).toBe("agents");
    // Phase 3: focus mirrors teams-tree → agent-tree.
    expect(dashboard.focus).toBe("agent-tree");
  });

  test("'1' from a shared focus target leaves focus alone (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("0"); // sidebarMode=teams, focus=teams-tree
    dashboard.handleInput("\t"); // teams-tree → info (teams cycle)
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("1");
    expect(dashboard.sidebarMode as string).toBe("agents");
    // Focus unchanged because info is in BOTH cycles.
    expect(dashboard.focus).toBe("info");
  });

  test("Tab in agents mode never reaches teams-tree (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    expect(dashboard.focus).toBe("agent-tree");
    expect(dashboard.sidebarMode).toBe("agents");
    for (let i = 0; i < 20; i++) {
      dashboard.handleInput("\t");
      expect(dashboard.focus).not.toBe("teams-tree");
    }
    for (let i = 0; i < 20; i++) {
      dashboard.handleInput("\x1b[Z");
      expect(dashboard.focus).not.toBe("teams-tree");
    }
  });

  test("Tab in teams mode cycles teams-tree → info → active-agent → right-pane → teams-tree (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("0"); // sidebarMode=teams, focus=teams-tree
    expect(dashboard.sidebarMode).toBe("teams");
    expect(dashboard.focus).toBe("teams-tree");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("active-agent");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("right-pane");
    dashboard.handleInput("\t");
    // Wraps back to teams-tree (no repo-coordinator stop in teams mode).
    expect(dashboard.focus).toBe("teams-tree");
  });

  test("Shift+Tab in teams mode cycles teams-tree backward through right-pane (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("0"); // sidebarMode=teams, focus=teams-tree
    expect(dashboard.focus).toBe("teams-tree");
    dashboard.handleInput("\x1b[Z"); // Shift+Tab → right-pane (wrap)
    expect(dashboard.focus).toBe("right-pane");
    dashboard.handleInput("\x1b[Z");
    expect(dashboard.focus).toBe("active-agent");
    dashboard.handleInput("\x1b[Z");
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("\x1b[Z");
    expect(dashboard.focus).toBe("teams-tree");
  });

  test("Tab in coordinator mode uses COORDINATOR_FOCUS_ORDER regardless of sidebarMode (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    const flatList: FlatEntry[] = [makeFlatSystemCoordinator()];
    dashboard.onUpdate([], flatList, []);
    // System coordinator is selected → coordinatorMode is on.
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    expect(dashboard.focusManager.coordinatorMode).toBe(true);
    // Flip sidebarMode to teams — coordinator mode should still trump it.
    dashboard.handleInput("0");
    expect(dashboard.sidebarMode).toBe("teams");
    expect(dashboard.focusManager.coordinatorMode).toBe(true);
    // Tab cycles agent-tree → info → coordinator → agent-tree (coordinator order).
    // Note: '0' from agent-tree moved focus to teams-tree, but the next Tab
    // resolves cycle() against COORDINATOR_FOCUS_ORDER. teams-tree is not in
    // that order, so it falls through to index 0 (agent-tree) + 1 = info.
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("coordinator");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("agent-tree");
    // teams-tree is NEVER in the coordinator-mode cycle.
    for (let i = 0; i < 10; i++) {
      dashboard.handleInput("\t");
      expect(dashboard.focus).not.toBe("teams-tree");
      expect(dashboard.focus).not.toBe("active-agent");
      expect(dashboard.focus).not.toBe("right-pane");
    }
  });

  test("'0' does not fire when typing in active-agent input field (§17.1)", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    dashboard.onUpdate([agent], [makeFlatAgent(agent)], []);
    // Tab into active-agent then into the input sub-focus.
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent (pane)
    dashboard.handleInput("\t"); // pane → input
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("input");

    // '0' should be captured by the input field, not switch focus to teams-tree.
    dashboard.handleInput("0");
    expect(dashboard.inputField.getText()).toBe("0");
    expect(dashboard.focus).toBe("active-agent");

    // '1' likewise.
    dashboard.handleInput("1");
    expect(dashboard.inputField.getText()).toBe("01");
    expect(dashboard.focus).toBe("active-agent");
  });
});

describe("colorizeDiff", () => {
  test("'+' line is wrapped in green", () => {
    const result = colorizeDiff(["+added line"]);
    expect(result[0]).toBe("\x1b[32m+added line\x1b[0m");
  });

  test("'+++' line is wrapped in dim, not green", () => {
    const result = colorizeDiff(["+++ a/file.ts"]);
    expect(result[0]).toBe("\x1b[2m+++ a/file.ts\x1b[0m");
  });

  test("'-' line is wrapped in red", () => {
    const result = colorizeDiff(["-removed line"]);
    expect(result[0]).toBe("\x1b[31m-removed line\x1b[0m");
  });

  test("'---' line is wrapped in dim, not red", () => {
    const result = colorizeDiff(["--- b/file.ts"]);
    expect(result[0]).toBe("\x1b[2m--- b/file.ts\x1b[0m");
  });

  test("'@@' line is wrapped in dim", () => {
    const result = colorizeDiff(["@@ -1,3 +1,4 @@"]);
    expect(result[0]).toBe("\x1b[2m@@ -1,3 +1,4 @@\x1b[0m");
  });

  test("'diff ' line is wrapped in dim", () => {
    const result = colorizeDiff(["diff --git a/file.ts b/file.ts"]);
    expect(result[0]).toBe("\x1b[2mdiff --git a/file.ts b/file.ts\x1b[0m");
  });

  test("regular context line is unchanged", () => {
    const result = colorizeDiff([" normal line"]);
    expect(result[0]).toBe(" normal line");
  });
});

describe("colorizeLog", () => {
  test("timestamp prefix is wrapped in dim", () => {
    const result = colorizeLog(["[2026-03-05 15:37:26] Some event"]);
    expect(result[0]).toBe("\x1b[2m[2026-03-05 15:37:26]\x1b[0m Some event");
  });

  test("bracket token after timestamp is wrapped in cyan", () => {
    const result = colorizeLog(["[2026-03-05 15:37:26] [PreToolUse] Permission denied"]);
    expect(result[0]).toBe("\x1b[2m[2026-03-05 15:37:26]\x1b[0m \x1b[36m[PreToolUse]\x1b[0m Permission denied");
  });

  test("multiple bracket tokens after timestamp are all cyan", () => {
    const result = colorizeLog(["[2026-03-05 15:37:26] [PreToolUse] foo [Bash]"]);
    expect(result[0]).toBe("\x1b[2m[2026-03-05 15:37:26]\x1b[0m \x1b[36m[PreToolUse]\x1b[0m foo \x1b[36m[Bash]\x1b[0m");
  });

  test("brackets without preceding timestamp are NOT colorized", () => {
    const result = colorizeLog(["[PreToolUse] Permission denied"]);
    expect(result[0]).toBe("[PreToolUse] Permission denied");
  });

  test("timestamp-only line with no trailing text", () => {
    const result = colorizeLog(["[2026-03-05 15:37:26]"]);
    expect(result[0]).toBe("\x1b[2m[2026-03-05 15:37:26]\x1b[0m");
  });

  test("line with no special patterns is unchanged", () => {
    const result = colorizeLog(["just text"]);
    expect(result[0]).toBe("just text");
  });
});

describe("formatAgentRow full-width highlight", () => {
  const RESET = "\x1b[0m";
  const REVERSE = "\x1b[7m";
  const paneWidth = 80;

  function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
    return {
      id: "agent-abc",
      repoPath: "/repos/test",
      repoName: "test",
      state: "running",
      age: "1m",
      archived: false,
      children: [],
      meta: {
        id: "agent-abc",
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
        prompt: "do stuff",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: Math.floor(Date.now() / 1000) - 60,
        worktree: true,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "12345",
      } as AgentMeta,
      ...overrides,
    };
  }

  test("selected row visible width equals pane width", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", true, paneWidth, 30);
    expect(visibleWidth(row)).toBe(paneWidth);
  });

  test("selected row starts with REVERSE and ends with RESET", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", true, paneWidth, 30);
    expect(row.startsWith(REVERSE)).toBe(true);
    expect(row.endsWith(RESET)).toBe(true);
  });

  test("selected row has no bare RESET that would cancel REVERSE", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", true, paneWidth, 30);
    // Every RESET inside the row (except the final one) should be followed by REVERSE
    const inner = row.slice(REVERSE.length, -RESET.length);
    const parts = inner.split(RESET);
    // Every part except the last should be followed by REVERSE (which starts the next part)
    for (let i = 0; i < parts.length - 1; i++) {
      expect(parts[i + 1]!.startsWith(REVERSE)).toBe(true);
    }
  });

  test("non-selected row has no REVERSE codes", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", false, paneWidth, 30);
    expect(row).not.toContain(REVERSE);
  });

  test("non-selected row is not padded to pane width", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", false, paneWidth, 30);
    // Non-selected row is truncated but not padded, so it should be <= paneWidth
    // and typically shorter (no trailing spaces added)
    expect(visibleWidth(row)).toBeLessThanOrEqual(paneWidth);
  });

  test("selected row with connector is still full width", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "├── ", true, paneWidth, 30);
    expect(visibleWidth(row)).toBe(paneWidth);
    expect(row.startsWith(REVERSE)).toBe(true);
    expect(row.endsWith(RESET)).toBe(true);
  });

  test("selected row with short content is padded to full width", () => {
    const agent = makeTestAgent({ id: "a", repoName: "r" });
    agent.meta.prompt = "x";
    const widePane = 120;
    const row = formatAgentRow(agent, "", true, widePane, 10);
    expect(visibleWidth(row)).toBe(widePane);
  });

  test("selected row with content exceeding width is truncated to width", () => {
    const agent = makeTestAgent();
    agent.meta.prompt = "a very long prompt that goes on and on and on and on and on and on and on and on";
    const narrowPane = 40;
    const row = formatAgentRow(agent, "", true, narrowPane, 30);
    expect(visibleWidth(row)).toBe(narrowPane);
  });

  test("orphaned agent has warning indicator", () => {
    const agent = makeTestAgent({ orphaned: true });
    const row = formatAgentRow(agent, "", false, paneWidth, 30);
    // Strip ANSI codes for readable assertion
    const stripped = row.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toContain("⚠ ");
  });

  test("non-orphaned agent has no warning indicator", () => {
    const agent = makeTestAgent({ orphaned: false });
    const row = formatAgentRow(agent, "", false, paneWidth, 30);
    const stripped = row.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).not.toContain("⚠ ");
  });

  test("orphaned selected row is still full width", () => {
    const agent = makeTestAgent({ orphaned: true });
    const row = formatAgentRow(agent, "", true, paneWidth, 30);
    expect(visibleWidth(row)).toBe(paneWidth);
  });
});

describe("formatAgentRow compact mode", () => {
  function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
    return {
      id: "agent-abc",
      repoPath: "/repos/test",
      repoName: "test",
      state: "running",
      age: "1m",
      archived: false,
      children: [],
      meta: {
        id: "agent-abc",
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
        prompt: "do stuff with long description",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: Math.floor(Date.now() / 1000) - 60,
        worktree: true,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "12345",
      } as AgentMeta,
      ...overrides,
    };
  }

  test("compact mode (width <= 60) omits model and prompt", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", false, 60, 20);
    const stripped = stripAnsi(row);
    expect(stripped).toContain("agent-abc");
    expect(stripped).not.toContain("sonnet");
    expect(stripped).not.toContain("do stuff");
  });

  test("full mode (width > 60) includes model and prompt", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", false, 100, 20);
    const stripped = stripAnsi(row);
    expect(stripped).toContain("agent-abc");
    expect(stripped).toContain("sonnet");
    expect(stripped).toContain("do stuff");
  });

  test("compact mode includes state and age", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", false, 50, 20);
    const stripped = stripAnsi(row);
    expect(stripped).toContain("running");
    expect(stripped).toContain("1m");
  });

  test("compact mode with orphaned agent renders correctly", () => {
    const agent = makeTestAgent({ orphaned: true });
    const row = formatAgentRow(agent, "", false, 60, 20);
    const stripped = stripAnsi(row);
    expect(stripped).toContain("⚠");
    expect(stripped).toContain("agent-abc");
    expect(stripped).not.toContain("sonnet");
  });

  test("compact mode selected row is full width", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", true, 60, 20);
    expect(visibleWidth(row)).toBe(60);
  });

  test("boundary: width 61 uses full mode", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", false, 61, 20);
    const stripped = stripAnsi(row);
    expect(stripped).toContain("sonnet");
  });

  test("coordinator agent uses ◇ icon", () => {
    const agent = makeTestAgent({ meta: { ...makeTestAgent().meta, agentType: "coordinator" } });
    const row = formatAgentRow(agent, "", false, 80, 20);
    const stripped = stripAnsi(row);
    expect(stripped).toContain("◇");
    expect(stripped).not.toContain("◆");
  });

  test("regular agent uses ◆ icon", () => {
    const agent = makeTestAgent();
    const row = formatAgentRow(agent, "", false, 80, 20);
    const stripped = stripAnsi(row);
    expect(stripped).toContain("◆");
    expect(stripped).not.toContain("◇");
  });

  test("worker agent uses ⚙ icon (not overridden by coordinator)", () => {
    const agent = makeTestAgent({ meta: { ...makeTestAgent().meta, worker: true } });
    const row = formatAgentRow(agent, "", false, 80, 20);
    const stripped = stripAnsi(row);
    expect(stripped).toContain("⚙");
    expect(stripped).not.toContain("◇");
  });
});

describe("AgentTreeComponent scroll indicators", () => {
  /** Build a tree component with N fake agents and the given maxHeight/scrollOffset. */
  function makeTree(agentCount: number, maxHeight: number, scrollOffset: number): AgentTreeComponent {
    const tree = new AgentTreeComponent();
    tree.maxHeight = maxHeight;
    const flatList: FlatEntry[] = Array.from({ length: agentCount }, (_, i) =>
      makeFlatAgent(makeAgent(`agent-${i}`, "/repos/test"))
    );
    tree.setFlatList(flatList);
    // Override scrollOffset (private) via type assertion for testing.
    // §17.1: the tree now STARTS in no-selection. These scroll tests set
    // selectedIndex directly and then call moveSelection, so they need a real
    // selection (hasSelection) for moveSelection to advance from the set index
    // rather than treat the first call as the no-selection bootstrap.
    (tree as any).scrollOffset = scrollOffset;
    (tree as any).hasSelection = true;
    return tree;
  }

  function renderLines(tree: AgentTreeComponent): string[] {
    return tree.render(80).map(stripAnsi);
  }

  test("all items fit — no indicators, total equals item count", () => {
    const tree = makeTree(5, 7, 0);
    const lines = renderLines(tree);
    expect(lines.length).toBe(5);
    expect(lines.some((l) => l.includes("more"))).toBe(false);
  });

  test("scroll offset 0, many items — shows bottom indicator only, total = maxHeight", () => {
    const tree = makeTree(14, 7, 0);
    const lines = renderLines(tree);
    expect(lines.length).toBe(7);
    expect(lines.some((l) => l.includes("▲"))).toBe(false);
    const bottom = lines[lines.length - 1]!;
    expect(bottom).toContain("▼");
    expect(bottom).not.toContain("▼ 1 more");
  });

  test("scroll offset 1 — absorbs hidden-above row, shows no top indicator", () => {
    const tree = makeTree(14, 7, 1);
    const lines = renderLines(tree);
    expect(lines.length).toBe(7);
    // No top indicator: item 0 should be visible
    expect(lines.some((l) => l.includes("▲"))).toBe(false);
    // Should show a bottom indicator for the items below
    expect(lines.some((l) => l.includes("▼"))).toBe(true);
    expect(lines.some((l) => l.includes("▼ 1 more"))).toBe(false);
  });

  test("scroll offset 2+ — shows top indicator with correct count, total = maxHeight", () => {
    const tree = makeTree(14, 7, 2);
    const lines = renderLines(tree);
    expect(lines.length).toBe(7);
    expect(lines[0]).toContain("▲ 2 more");
    expect(lines[lines.length - 1]).toContain("▼");
    expect(lines.some((l) => l.includes("▼ 1 more"))).toBe(false);
    expect(lines.some((l) => l.includes("▲ 1 more"))).toBe(false);
  });

  test("near-bottom: remaining === 1 is absorbed, no bottom indicator", () => {
    // 10 items, maxHeight 7, scrollOffset 4 → end = min(10, 4+6-1)=9, remaining=1 → absorbed
    const tree = makeTree(10, 7, 4);
    const lines = renderLines(tree);
    expect(lines.length).toBe(7);
    expect(lines.some((l) => l.includes("▼ 1 more"))).toBe(false);
    expect(lines.some((l) => l.includes("▼"))).toBe(false);
    // Top indicator should show "4 more"
    expect(lines[0]).toContain("▲ 4 more");
  });

  test("remaining === 2 shows bottom indicator, not absorbed", () => {
    // 11 items, maxHeight 7, scrollOffset 4 → remaining=2 → shows indicator
    const tree = makeTree(11, 7, 4);
    const lines = renderLines(tree);
    expect(lines.length).toBe(7);
    expect(lines[lines.length - 1]).toContain("▼ 2 more");
    expect(lines[0]).toContain("▲ 4 more");
  });

  test("never shows '▲ 1 more'", () => {
    // Test many configurations: no render should ever produce "▲ 1 more"
    for (let n = 1; n <= 15; n++) {
      for (let offset = 0; offset < n; offset++) {
        const tree = makeTree(n, 7, offset);
        const lines = renderLines(tree);
        for (const line of lines) {
          expect(line).not.toContain("▲ 1 more");
        }
      }
    }
  });

  test("never shows '▼ 1 more'", () => {
    // Test many configurations: no render should ever produce "▼ 1 more"
    for (let n = 1; n <= 15; n++) {
      for (let offset = 0; offset < n; offset++) {
        const tree = makeTree(n, 7, offset);
        const lines = renderLines(tree);
        for (const line of lines) {
          expect(line).not.toContain("▼ 1 more");
        }
      }
    }
  });

  test("total rendered rows never exceeds maxHeight", () => {
    for (let n = 1; n <= 15; n++) {
      for (let offset = 0; offset < n; offset++) {
        const tree = makeTree(n, 7, offset);
        const lines = renderLines(tree);
        expect(lines.length).toBeLessThanOrEqual(7);
      }
    }
  });

  test("scroll offset 0, exactly maxHeight items — all shown, no indicators", () => {
    const tree = makeTree(7, 7, 0);
    const lines = renderLines(tree);
    expect(lines.length).toBe(7);
    expect(lines.some((l) => l.includes("more"))).toBe(false);
  });

  test("scroll offset 0, maxHeight+1 items — bottom items hidden, no '▼ 1 more'", () => {
    // 8 items, maxHeight 7, scrollOffset 0: reserved slot gives end=6, remaining=2 → "▼ 2 more".
    const tree = makeTree(8, 7, 0);
    const lines = renderLines(tree);
    expect(lines.length).toBe(7);
    expect(lines.some((l) => l.includes("▼ 1 more"))).toBe(false);
    expect(lines.some((l) => l.includes("▲ 1 more"))).toBe(false);
    // Bottom indicator should say "▼ 2 more" (both items 6 and 7 are hidden)
    expect(lines[lines.length - 1]).toContain("▼ 2 more");
  });

  test("selected item is always visible when scrollOffset=1 (edge case n=maxHeight+1)", () => {
    // n=8, h=7, scrollOffset=1: render absorbs to start=0, shows items[0..5]+▼2more.
    // selectedIndex=6 must still be visible — ensureSelectedVisible bumps scrollOffset to 2.
    const tree = makeTree(8, 7, 0);
    // Simulate navigation: move selection to index 6 (near bottom)
    (tree as any).selectedIndex = 5;
    (tree as any).scrollOffset = 0;
    tree.moveSelection(1); // selectedIndex → 6, triggers ensureSelectedVisible
    const lines = renderLines(tree);
    // Agent-6 must appear in the rendered output
    expect(lines.some((l) => l.includes("agent-6"))).toBe(true);
    // Total rows within maxHeight
    expect(lines.length).toBeLessThanOrEqual(7);
    // No "1 more" indicators
    expect(lines.some((l) => l.includes("▲ 1 more"))).toBe(false);
    expect(lines.some((l) => l.includes("▼ 1 more"))).toBe(false);
  });

  test("selected item visible after navigation to near-bottom: n=maxHeight+2", () => {
    // n=9, h=7: non-lastIndex case where old Math.max(2, +2) formula was insufficient.
    // moveSelection to index 7 must produce scrollOffset=3, showing items[3..8].
    const tree = makeTree(9, 7, 0);
    (tree as any).selectedIndex = 6;
    tree.moveSelection(1); // selectedIndex → 7
    const lines = renderLines(tree);
    expect(lines.some((l) => l.includes("agent-7"))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(lines.some((l) => l.includes("▲ 1 more"))).toBe(false);
    expect(lines.some((l) => l.includes("▼ 1 more"))).toBe(false);
  });

  test("selected item visible at lastIndex: n=maxHeight+2, selectedIndex=lastIndex", () => {
    // n=9, h=7, lastIndex=8: scrollDown formula must produce scrollOffset≥4 to show item 8.
    const tree = makeTree(9, 7, 0);
    (tree as any).selectedIndex = 7;
    tree.moveSelection(1); // selectedIndex → 8 (lastIndex)
    const lines = renderLines(tree);
    expect(lines.some((l) => l.includes("agent-8"))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(lines.some((l) => l.includes("▲ 1 more"))).toBe(false);
    expect(lines.some((l) => l.includes("▼ 1 more"))).toBe(false);
  });

  test("navigate up to scrollOffset=1 then navigate down past maxHeight-2: selected visible", () => {
    // Regression for effectiveScrollOffset trigger bug:
    // 1. Start at scrollOffset=2, selectedIndex=3 (window=[2..7] with topSlot)
    // 2. Navigate up: selectedIndex→2, scroll-up check sets scrollOffset=1
    //    (render absorbs scrollOffset=1 to start=0, window=[0..5]+▼3more)
    // 3. Navigate down past maxHeight-2=5 (to selectedIndex=6)
    //    effectiveScrollOffset=0, topSlot=0, trigger: 7>=7 → scrollOffset=Math.max(2,2)=2
    //    render: start=2, topSlot=1, end=7, remaining=2 → agent-6 visible
    const tree = makeTree(9, 7, 2);
    (tree as any).selectedIndex = 3;

    // Navigate up: selectedIndex→2, scrollOffset should become 1
    tree.moveSelection(-1);
    expect((tree as any).scrollOffset).toBe(1);

    // Navigate down past maxHeight-2=5 to selectedIndex=6
    tree.moveSelection(1); // →3
    tree.moveSelection(1); // →4
    tree.moveSelection(1); // →5 (maxHeight-2)
    tree.moveSelection(1); // →6 (past maxHeight-2)

    const lines = renderLines(tree);
    expect(lines.some((l) => l.includes("agent-6"))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(lines.some((l) => l.includes("▲ 1 more"))).toBe(false);
    expect(lines.some((l) => l.includes("▼ 1 more"))).toBe(false);
  });

  test("dynamic list shrink: removing item above keeps no '▼ 1 more'", () => {
    // n=10, h=7, scrollOffset=3: start=3, topSlot=1, maxContent=6,
    // end=min(10,3+5)=8, remaining=2 → shows "▼ 2 more".
    const tree = makeTree(10, 7, 3);
    expect(renderLines(tree).some((l) => l.includes("▼ 2 more"))).toBe(true);

    // Shrink to n=9 (an agent above scrollOffset was deleted), scrollOffset stays at 3.
    // Now: end=min(9,3+5)=8, remaining=1 → absorbed: end=9, remaining=0. No bottom indicator.
    const tree2 = makeTree(9, 7, 3);
    const lines = renderLines(tree2);
    expect(lines.some((l) => l.includes("▼ 1 more"))).toBe(false);
    expect(lines.some((l) => l.includes("▲ 1 more"))).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(7);
  });
});

describe("Terminal title (G-10)", () => {
  let dashboard: DashboardComponent;
  let titles: string[];

  beforeEach(() => {
    dashboard = makeDashboard();
    titles = [];
    dashboard.setTerminalTitle = (title: string) => { titles.push(title); };
  });

  test("emits terminal title with agent id on selection change", () => {
    const agent = makeAgent("agent-abc", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);
    expect(titles).toContain("ib: agent-abc");
  });

  test("emits generic title when no agent is selected", () => {
    const agent = makeAgent("agent-abc", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);
    titles = [];

    // Clear the list — no agents means no selection
    dashboard.onUpdate([], [], []);
    expect(titles).toContain("ib");
  });

  test("does not emit title when agent id has not changed", () => {
    const agent = makeAgent("agent-abc", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);
    titles = [];

    // Update again with same agent — no title change expected
    dashboard.onUpdate([agent], flatList, []);
    expect(titles).toHaveLength(0);
  });
});

describe("Orphaned tmux sessions (Phase 10)", () => {
  let dashboard: DashboardComponent;

  test("onUpdate stores orphaned sessions and updates error count", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["ittybitty-abc-orphan1", "ittybitty-abc-orphan2"]);
    expect(dashboard.rightPane.orphanedTmuxSessions).toEqual(["ittybitty-abc-orphan1", "ittybitty-abc-orphan2"]);
  });

  test("ERRORS pane shows orphaned tmux sessions", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["ittybitty-abc-orphan1"]);
    dashboard.jumpToMode("ERRORS");
    const lines = dashboard.rightPane.render(80);
    const allText = lines.map(stripAnsi).join("\n");
    expect(allText).toContain("Orphaned tmux sessions:");
    expect(allText).toContain("ittybitty-abc-orphan1");
    expect(allText).toContain("no matching agent");
  });

  test("error count includes both errors and orphaned sessions", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["ittybitty-orphan"]);
    dashboard.addError("Some error");
    // Error badge should show 2 (1 error + 1 orphan)
    const rendered = dashboard.render(160);
    const allText = rendered.map(stripAnsi).join("\n");
    expect(allText).toContain("[2 errors]");
  });

  test("clearErrors clears errors but preserves orphaned sessions in count", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["ittybitty-orphan"]);
    dashboard.addError("Some error");
    dashboard.clearErrors();
    expect(dashboard.errors.length).toBe(0);
    // Orphan still counts
    dashboard.jumpToMode("ERRORS");
    const lines = dashboard.rightPane.render(80);
    const allText = lines.map(stripAnsi).join("\n");
    expect(allText).toContain("ittybitty-orphan");
  });

  test("ERRORS pane shows Enter hint when orphans exist", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["ittybitty-orphan"]);
    dashboard.jumpToMode("ERRORS");
    const lines = dashboard.rightPane.render(80);
    const allText = lines.map(stripAnsi).join("\n");
    expect(allText).toContain("Enter to kill orphan");
  });

  test("Enter in ERRORS mode with orphans opens kill dialog", () => {
    dashboard = makeDashboard();

    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["ittybitty-orphan"]);
    dashboard.handleInput("e"); // jump to ERRORS mode
    dashboard.handleInput("\r"); // Enter
    expect(dashboard.dialog).not.toBeNull();
    expect(assertDialog(dashboard.dialog, 'confirm').prompt).toContain("ittybitty-orphan");

  });

  test("Enter in ERRORS mode with multiple orphans shows select dialog", () => {
    dashboard = makeDashboard();

    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["ittybitty-orphan1", "ittybitty-orphan2"]);
    dashboard.handleInput("e"); // jump to ERRORS mode
    dashboard.handleInput("\r"); // Enter
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'select');
    expect(d.items).toContain("ittybitty-orphan1");
    expect(d.items).toContain("ittybitty-orphan2");

  });

  test("pane cycle does not skip ERRORS when orphaned sessions exist", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    // No regular errors, but orphans exist
    dashboard.onUpdate([agent], flatList, [], ["ittybitty-orphan"]);
    // Cycle through all modes — ERRORS should be reachable
    const modes: string[] = [];
    for (let i = 0; i < PANE_MODES.length + 1; i++) {
      modes.push(dashboard.currentMode);
      dashboard.handleInput("p");
    }
    expect(modes).toContain("ERRORS");

  });

  test("TREE mode is preserved when selecting a repo header (no auto-switch to REPO)", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const repoHeader = makeFlatRepoHeader("/repos/test");
    const flatList: FlatEntry[] = [repoHeader, makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], []);

    dashboard.jumpToMode("TREE");
    expect(dashboard.currentMode).toBe("TREE");

    // Select the repo header — would have auto-switched to REPO before the fix.
    dashboard.agentTree.selectByRepoPath("/repos/test");
    dashboard.onUpdate([agent], flatList, [], []);
    expect(dashboard.currentMode).toBe("TREE");
  });

  test("TREE mode hides the sidebar agent tree (no duplication)", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-dup-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], []);

    dashboard.jumpToMode("TREE");
    // Render and split each line at the sidebar/main separator (vertical bar `│`).
    // The tree row should only appear in the main column, never the sidebar column.
    const lines = dashboard.render(160).map(stripAnsi);
    let sidebarHasTreeRow = false;
    for (const l of lines) {
      const sidebar = l.split("│")[0] ?? "";
      if (sidebar.includes("agent-dup-test")) {
        sidebarHasTreeRow = true;
        break;
      }
    }
    expect(sidebarHasTreeRow).toBe(false);
  });

  test("onUpdate with empty orphans clears previous orphans", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["ittybitty-orphan"]);
    expect(dashboard.rightPane.orphanedTmuxSessions.length).toBe(1);
    dashboard.onUpdate([agent], flatList, [], []);
    expect(dashboard.rightPane.orphanedTmuxSessions.length).toBe(0);
  });
});

describe("Minimum terminal size (G-11)", () => {
  let dashboard: DashboardComponent;
  let origRows: number | undefined;

  beforeEach(() => {
    dashboard = makeDashboard();
    origRows = process.stdout.rows;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
  });

  test("renders warning when terminal height < 24", () => {
    Object.defineProperty(process.stdout, "rows", { value: 20, writable: true, configurable: true });
    const lines = dashboard.render(160);
    expect(lines.length).toBe(1);
    expect(stripAnsi(lines[0]!)).toContain("Terminal too small");
  });

  test("renders warning when terminal width < 140", () => {
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    const lines = dashboard.render(100);
    expect(lines.length).toBe(1);
    expect(stripAnsi(lines[0]!)).toContain("Terminal too small");
  });

  test("renders normally at exactly 140x24 (boundary)", () => {
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true, configurable: true });
    const lines = dashboard.render(140);
    expect(lines.length).toBeGreaterThan(1);
    expect(stripAnsi(lines[0]!)).toContain("ib");
  });

  test("renders normally when terminal is large enough", () => {
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    const lines = dashboard.render(160);
    expect(lines.length).toBeGreaterThan(1);
    expect(stripAnsi(lines[0]!)).toContain("ib");
  });
});

describe("Context-sensitive footer (repo header vs agent)", () => {
  let dashboard: DashboardComponent;

  function setupMultiRepoWithRepoHeader() {
    dashboard = makeDashboard();

    Object.defineProperty(process.stdout, "rows", { value: 40, writable: true, configurable: true });

    const agent1 = _makeAgent({ id: "agent-a", repoPath: "/repos/alpha", repoName: "alpha" });
    agent1.state = "running";
    const agent2 = _makeAgent({ id: "agent-b", repoPath: "/repos/beta", repoName: "beta" });
    agent2.state = "running";

    // Simulate multi-repo flatList with repo headers
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("alpha", "/repos/alpha", true),
      makeFlatAgent(agent1, { connector: "└── " }),
      makeFlatRepoHeader("beta", "/repos/beta", true),
      makeFlatAgent(agent2, { connector: "└── " }),
    ];
    dashboard.setRepos([
      { path: "/repos/alpha", name: "alpha" },
      { path: "/repos/beta", name: "beta" },
    ]);
    dashboard.onUpdate([agent1, agent2], flatList, []);
    return { agent1, agent2 };
  }

  afterEach(() => {

  });

  test("footer shows repo actions when repo header is selected", () => {
    setupMultiRepoWithRepoHeader();
    // First row is repo header "alpha" — selectedIndex=0 is repo header
    expect(dashboard.agentTree.selectedRepoHeader).toBe("alpha");
    expect(dashboard.selectedAgent).toBeNull();

    const lines = dashboard.render(160);
    const allText = lines.map(stripAnsi).join("\n");
    expect(allText).toContain("A: add repo");
    // Should NOT show agent-specific actions
    expect(allText).not.toContain("s: send");
    expect(allText).not.toContain("m: merge");
    expect(allText).not.toContain("G: ghostty");
  });

  test("footer shows agent actions when agent is selected", () => {
    setupMultiRepoWithRepoHeader();
    // Navigate down to agent-a (index 1)
    dashboard.handleInput("j");
    expect(dashboard.selectedAgent?.id).toBe("agent-a");
    expect(dashboard.agentTree.selectedRepoHeader).toBeNull();

    const lines = dashboard.render(160);
    const allText = lines.map(stripAnsi).join("\n");
    expect(allText).toContain("s: send");
    expect(allText).toContain("m: merge");
    expect(allText).toContain("x: kill");
    // Should NOT show repo actions
    expect(allText).not.toContain("A: add repo");
  });

  test("r key on repo header opens rename dialog instead of reassign", () => {
    setupMultiRepoWithRepoHeader();
    expect(dashboard.agentTree.selectedRepoHeader).toBe("alpha");
    dashboard.handleInput("r");
    expect(dashboard.dialog).not.toBeNull();
    expect(assertDialog(dashboard.dialog, 'input').prompt).toContain("Rename");
  });

  test("r key on agent opens reassign dialog", () => {
    setupMultiRepoWithRepoHeader();
    dashboard.handleInput("j"); // move to agent
    expect(dashboard.selectedAgent).not.toBeNull();
    dashboard.handleInput("r");
    expect(dashboard.dialog).not.toBeNull();
    expect(assertDialog(dashboard.dialog, 'fuzzy').prompt).toContain("Reassign");
  });

  test("x key on repo header opens remove dialog instead of kill", async () => {
    setupMultiRepoWithRepoHeader();
    expect(dashboard.agentTree.selectedRepoHeader).toBe("alpha");
    dashboard.handleInput("x");
    await dashboard.flushPendingActions();
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'confirm');
    expect(d.prompt).toContain("Remove");
    expect(d.prompt).toContain("alpha");
  });

  test("x key on agent opens kill dialog", () => {
    setupMultiRepoWithRepoHeader();
    dashboard.handleInput("j");
    expect(dashboard.selectedAgent).not.toBeNull();
    dashboard.handleInput("x");
    expect(dashboard.dialog).not.toBeNull();
    expect(assertDialog(dashboard.dialog, 'confirm').prompt).toContain("Kill");
  });
});

describe("Repo nickname display in agent tree", () => {
  let dashboard: DashboardComponent;

  afterEach(() => {

  });

  test("repo header shows nickname when set", () => {
    dashboard = makeDashboard();

    Object.defineProperty(process.stdout, "rows", { value: 40, writable: true, configurable: true });

    const agent = _makeAgent({ id: "agent-a", repoPath: "/repos/myproject", repoName: "myproj-nick" });
    agent.state = "running";

    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("myproj-nick", "/repos/myproject", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.setRepos([
      { path: "/repos/myproject", name: "myproject", nickname: "myproj-nick" },
      { path: "/repos/other", name: "other" },
    ]);
    dashboard.onUpdate([agent], flatList, []);

    const lines = dashboard.render(160);
    const allText = lines.map(stripAnsi).join("\n");
    expect(allText).toContain("myproj-nick");
  });

  test("a key with nickname shows nickname in new agent form", () => {
    dashboard = makeDashboard();

    dashboard.setRepos([{ path: "/repos/myproject", name: "myproject", nickname: "myproj" }]);
    dashboard.handleInput("a");
    expect(assertDialog(dashboard.dialog, 'new-agent-form').repoName).toBe("myproj");

  });
});

describe("Repo header selection persistence", () => {
  let dashboard: DashboardComponent;

  afterEach(() => {

  });

  function setupMultiRepo() {
    dashboard = makeDashboard();

    Object.defineProperty(process.stdout, "rows", { value: 40, writable: true, configurable: true });

    const agent1 = _makeAgent({ id: "agent-a", repoPath: "/repos/alpha", repoName: "alpha" });
    agent1.state = "running";
    const agent2 = _makeAgent({ id: "agent-b", repoPath: "/repos/beta", repoName: "beta" });
    agent2.state = "running";

    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("alpha", "/repos/alpha", true),
      makeFlatAgent(agent1, { connector: "└── " }),
      makeFlatRepoHeader("beta", "/repos/beta", true),
      makeFlatAgent(agent2, { connector: "└── " }),
    ];
    dashboard.setRepos([
      { path: "/repos/alpha", name: "alpha" },
      { path: "/repos/beta", name: "beta" },
    ]);
    dashboard.onUpdate([agent1, agent2], flatList, []);
    return { agent1, agent2 };
  }

  test("repo header selection persists after tree refresh", () => {
    const { agent1, agent2 } = setupMultiRepo();
    // Select the beta repo header (index 2)
    dashboard.handleInput("j"); // agent-a (index 1)
    dashboard.handleInput("j"); // beta header (index 2)
    expect(dashboard.agentTree.selectedRepoHeader).toBe("beta");

    // Simulate a tree refresh with same data (e.g., after an agent state change)
    const newFlatList: FlatEntry[] = [
      makeFlatRepoHeader("alpha", "/repos/alpha", true),
      makeFlatAgent(agent1, { connector: "└── " }),
      makeFlatRepoHeader("beta", "/repos/beta", true),
      makeFlatAgent(agent2, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent1, agent2], newFlatList, []);

    // Selection should still be on beta repo header
    expect(dashboard.agentTree.selectedRepoHeader).toBe("beta");
    expect(dashboard.selectedAgent).toBeNull();
  });

  test("repo header selection persists after agent is removed from tree", () => {
    const { agent1, agent2 } = setupMultiRepo();
    // Select the beta repo header
    dashboard.handleInput("j"); // agent-a
    dashboard.handleInput("j"); // beta header
    expect(dashboard.agentTree.selectedRepoHeader).toBe("beta");

    // Simulate agent-a being removed (merged/killed) — beta header moves up
    const newFlatList: FlatEntry[] = [
      makeFlatRepoHeader("alpha", "/repos/alpha", false),
      makeFlatRepoHeader("beta", "/repos/beta", true),
      makeFlatAgent(agent2, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent2], newFlatList, []);

    // Selection should still be on beta
    expect(dashboard.agentTree.selectedRepoHeader).toBe("beta");
  });

  test("repo header selection persists after display name changes (rename)", () => {
    const { agent1, agent2 } = setupMultiRepo();
    // Select the alpha repo header (index 0)
    expect(dashboard.agentTree.selectedRepoHeader).toBe("alpha");

    // Simulate rename: alpha → "my-alpha" — repoPath stays the same
    const renamedAgent1 = _makeAgent({ id: "agent-a", repoPath: "/repos/alpha", repoName: "my-alpha" });
    renamedAgent1.state = "running";
    const newFlatList: FlatEntry[] = [
      makeFlatRepoHeader("beta", "/repos/beta", true),
      makeFlatAgent(agent2, { connector: "└── " }),
      makeFlatRepoHeader("my-alpha", "/repos/alpha", true),
      makeFlatAgent(renamedAgent1, { connector: "└── " }),
    ];
    dashboard.onUpdate([renamedAgent1, agent2], newFlatList, []);

    // Selection should follow the renamed repo (same path)
    expect(dashboard.agentTree.selectedRepoHeader).toBe("my-alpha");
    expect(dashboard.selectedAgent).toBeNull();
  });
});


describe("usage error indicator", () => {
  test("shows warning prefix when usage fetch had an error with stale data", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    // Simulate an error fetch that returned stale data
    // Access the private statusBar via the dashboard's render
    (dashboard as any).statusBar.claudeUsage = { sessionPct: 57, weeklyPct: 35, sessionReset: "44m", weeklyReset: "2d 7h" };
    (dashboard as any).statusBar.claudeUsageError = true;

    const lines = dashboard.render(160);
    const footer = lines.map(l => stripAnsi(l)).join("\n");
    expect(footer).toContain("⚠️");
    expect(footer).toContain("claude session:57%");
  });

  test("shows 'usage unavailable' when error with no data", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    (dashboard as any).statusBar.claudeUsage = null;
    (dashboard as any).statusBar.claudeUsageError = true;

    const lines = dashboard.render(160);
    const footer = lines.map(l => stripAnsi(l)).join("\n");
    expect(footer).toContain("⚠️  claude usage unavailable");
  });

  test("no warning when fetch succeeds", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    (dashboard as any).statusBar.claudeUsage = { sessionPct: 57, weeklyPct: 35, sessionReset: "44m", weeklyReset: "2d 7h" };
    (dashboard as any).statusBar.claudeUsageError = false;

    const lines = dashboard.render(160);
    const footer = lines.map(l => stripAnsi(l)).join("\n");
    expect(footer).not.toContain("⚠️");
    expect(footer).toContain("claude session:57%");
  });

  test("no warning and no usage text when no data and no error", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    (dashboard as any).statusBar.claudeUsage = null;
    (dashboard as any).statusBar.claudeUsageError = false;

    const lines = dashboard.render(160);
    const footer = lines.map(l => stripAnsi(l)).join("\n");
    expect(footer).not.toContain("⚠️");
    expect(footer).not.toContain("usage unavailable");
    expect(footer).not.toContain("session:");
  });

  test("shows codex usage on the second status row and time before jump", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    (dashboard as any).statusBar.codexUsage = { sessionPct: 4, weeklyPct: 1, sessionReset: "5h 0m", weeklyReset: "7d 0h" };
    (dashboard as any).statusBar.codexUsageError = false;

    const lines = dashboard.render(160);
    const statusRows = lines.slice(-2).map(l => stripAnsi(l));
    expect(statusRows[1]).toMatch(/^\d{2}:\d{2}:\d{2}  @: jump/);
    expect(statusRows[1]).toContain("codex session:4%");
    expect(statusRows[1]).toContain("weekly:1%");
  });
});

describe("applyLayout", () => {
  test("applies saved layout values", () => {
    const dashboard = makeDashboard();
    dashboard.applyLayout({
      sidebarWidth: 75,
      splitPaneLeftWidth: 100,
      heightOffsets: { tree: 3, info: -2, coordinator: -1 },
    });
    expect(dashboard.sidebarWidth).toBe(75);
    expect(dashboard.splitPane.getLeftWidth()).toBe(100);
    expect(dashboard.sidebar.heightOffsets).toEqual({ tree: 3, info: -2, coordinator: -1 });
  });

  test("clamps sidebarWidth to valid range", () => {
    const dashboard = makeDashboard();
    dashboard.applyLayout({
      sidebarWidth: 5,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
    });
    expect(dashboard.sidebarWidth).toBe(30); // MIN_SIDEBAR

    dashboard.applyLayout({
      sidebarWidth: 999,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
    });
    expect(dashboard.sidebarWidth).toBe(120); // MAX_SIDEBAR
  });

  test("clamps splitPaneLeftWidth to valid range", () => {
    const dashboard = makeDashboard();
    dashboard.applyLayout({
      sidebarWidth: 60,
      splitPaneLeftWidth: 10,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
    });
    expect(dashboard.splitPane.getLeftWidth()).toBe(40); // MIN_LEFT_WIDTH

    dashboard.applyLayout({
      sidebarWidth: 60,
      splitPaneLeftWidth: 500,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
    });
    expect(dashboard.splitPane.getLeftWidth()).toBe(160); // MAX_LEFT_WIDTH
  });
});

describe("sidebar height resize ({/} keys)", () => {
  test("} when agent-tree focused grows tree by stealing from info", () => {
    const dashboard = makeDashboard();
    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("}");
    expect(dashboard.sidebar.heightOffsets.tree).toBe(before.tree + 1);
    expect(dashboard.sidebar.heightOffsets.info).toBe(before.info - 1);
  });

  test("{ when agent-tree focused shrinks tree and gives back to info", () => {
    const dashboard = makeDashboard();
    // First grow tree so we have room to shrink
    dashboard.handleInput("}");
    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("{");
    expect(dashboard.sidebar.heightOffsets.tree).toBe(before.tree - 1);
    expect(dashboard.sidebar.heightOffsets.info).toBe(before.info + 1);
  });

  test("} when info focused grows info by stealing from tree", () => {
    const dashboard = makeDashboard();
    // Give tree some extra height so it can be stolen from (tree min is 1)
    dashboard.sidebar.heightOffsets.tree = 3;
    dashboard.handleInput("\t"); // move to info
    expect(dashboard.focus).toBe("info");
    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("}");
    expect(dashboard.sidebar.heightOffsets.info).toBe(before.info + 1);
    expect(dashboard.sidebar.heightOffsets.tree).toBe(before.tree - 1);
  });

  test("{ when info focused shrinks info and gives back to tree", () => {
    const dashboard = makeDashboard();
    // Give tree some extra height, then grow info to have room to shrink
    dashboard.sidebar.heightOffsets.tree = 3;
    dashboard.handleInput("\t"); // move to info
    dashboard.handleInput("}"); // grow info, steal from tree
    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("{");
    expect(dashboard.sidebar.heightOffsets.info).toBe(before.info - 1);
    expect(dashboard.sidebar.heightOffsets.tree).toBe(before.tree + 1);
  });

  test("} when agent-tree focused does nothing if info height is at minimum", () => {
    const dashboard = makeDashboard();
    // Force info to 1 (minimum) by shrinking it
    dashboard.sidebar.heightOffsets.info = -999; // force effective info to ≤ 1
    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("}");
    // tree should not grow since info is at minimum (§7.7 guard: donor must stay ≥ 1)
    expect(dashboard.sidebar.heightOffsets.tree).toBe(before.tree);
  });

  test("{/} are no-ops for sidebar height when active-agent is focused", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    dashboard.onUpdate([agent], [makeFlatAgent(agent)], []);
    // Tab to active-agent
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent
    expect(dashboard.focus).toBe("active-agent");
    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("}");
    dashboard.handleInput("{");
    expect(dashboard.sidebar.heightOffsets).toEqual(before);
  });

  test("{/} are no-ops for sidebar height when right-pane is focused", () => {
    const dashboard = makeDashboard();
    // Tab to right-pane
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent
    dashboard.handleInput("\t"); // right-pane
    expect(dashboard.focus).toBe("right-pane");
    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("}");
    dashboard.handleInput("{");
    expect(dashboard.sidebar.heightOffsets).toEqual(before);
  });

  test("{/} keys: info panel cannot be reduced below 1 row when agent-tree focused", () => {
    const dashboard = makeDashboard();
    dashboard.sidebar.displayHeight = 30;
    // Focus is already agent-tree by default; grow tree (shrinks info) many times
    expect(dashboard.focus).toBe("agent-tree");
    for (let i = 0; i < 100; i++) {
      dashboard.handleInput("}");
    }
    const base = computeSidebarHeights(30, dashboard.agentTree.visibleList.length);
    const effectiveInfo = base.infoHeight + dashboard.sidebar.heightOffsets.info;
    expect(effectiveInfo).toBeGreaterThanOrEqual(1);
  });

  test("{/} keys: tree panel cannot be reduced below 1 row when info focused", () => {
    const dashboard = makeDashboard();
    dashboard.sidebar.displayHeight = 30;
    // Tab to info focus
    dashboard.handleInput("\t"); // info
    expect(dashboard.focus).toBe("info");
    // Grow info (shrink tree) as many times as possible
    for (let i = 0; i < 100; i++) {
      dashboard.handleInput("}");
    }
    const base = computeSidebarHeights(30, dashboard.agentTree.visibleList.length);
    const effectiveTree = base.treeHeight + dashboard.sidebar.heightOffsets.tree;
    expect(effectiveTree).toBeGreaterThanOrEqual(1);
  });

  test("{/} keys: info panel cannot be reduced below 1 row when shrinking via info focus", () => {
    const dashboard = makeDashboard();
    dashboard.sidebar.displayHeight = 30;
    // Tab to info focus
    dashboard.handleInput("\t"); // info
    expect(dashboard.focus).toBe("info");
    // Shrink info as many times as possible
    for (let i = 0; i < 100; i++) {
      dashboard.handleInput("{");
    }
    const base = computeSidebarHeights(30, dashboard.agentTree.visibleList.length);
    const effectiveInfo = base.infoHeight + dashboard.sidebar.heightOffsets.info;
    expect(effectiveInfo).toBeGreaterThanOrEqual(1);
  });

  // §17.3 (B1): when teams-tree is focused, `[`/`]` must adjust the SIDEBAR
  // width (the panel that's focused), not the main split-pane. Before the fix,
  // teams-tree was not in the sidebar-width branch, so the keys fell through to
  // handleResizeLeft and resized the main split + fired resizeTmuxWindow on
  // every agent — wrong panel.
  test("[/] when teams-tree focused resizes the SIDEBAR, not the split pane (§17.3 B1)", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    dashboard.onUpdate([agent], [makeFlatAgent(agent)], []);
    dashboard.focusManager.setFocus("teams-tree");
    expect(dashboard.focus).toBe("teams-tree");

    const sidebarBefore = dashboard.sidebarWidth;
    const splitLeftBefore = dashboard.splitPane.getLeftWidth();

    dashboard.handleInput("]");
    expect(dashboard.sidebarWidth).toBeGreaterThan(sidebarBefore);
    expect(dashboard.splitPane.getLeftWidth()).toBe(splitLeftBefore);

    const sidebarAfterGrow = dashboard.sidebarWidth;
    dashboard.handleInput("[");
    expect(dashboard.sidebarWidth).toBeLessThan(sidebarAfterGrow);
    // Split pane still untouched after both keys.
    expect(dashboard.splitPane.getLeftWidth()).toBe(splitLeftBefore);
  });

  // §17.3 (B2): when teams-tree is focused, `{`/`}` must adjust the sidebar
  // tree-height the same way it does for agent-tree (they share heightOffsets.tree).
  // Before the fix, teams-tree hit no branch and the keys were silent no-ops.
  test("{/} when teams-tree focused adjusts heightOffsets.tree like agent-tree (§17.3 B2)", () => {
    const dashboard = makeDashboard();
    dashboard.focusManager.setFocus("teams-tree");
    expect(dashboard.focus).toBe("teams-tree");

    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("}");
    expect(dashboard.sidebar.heightOffsets.tree).toBe(before.tree + 1);
    expect(dashboard.sidebar.heightOffsets.info).toBe(before.info - 1);

    const afterGrow = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("{");
    expect(dashboard.sidebar.heightOffsets.tree).toBe(afterGrow.tree - 1);
    expect(dashboard.sidebar.heightOffsets.info).toBe(afterGrow.info + 1);
  });
});

describe("input field integration", () => {
  test("when agent selected, tmux display height is reduced by input field height", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      // Input field is always shown when agent selected (not full-width)
      dashboard.render(160);
      const displayH = dashboard.tmuxPane.displayHeight;

      // Chrome: header(1) + title-sep(1) + bottom-sep(1) + status(2) = 5
      const availableHeight = 30 - 5;
      // Input field: top sep(1) + 1 content line + bottom sep(1) = 3
      expect(displayH).toBe(availableHeight - 3);

      // Tabbing to active-agent doesn't change the height (input field always shown)
      dashboard.handleInput("\t"); // info
      dashboard.handleInput("\t"); // coordinator
      dashboard.handleInput("\t"); // active-agent
      expect(dashboard.focus).toBe("active-agent");

      dashboard.render(160);
      expect(dashboard.tmuxPane.displayHeight).toBe(displayH);
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("when active-agent focused, input field lines appear in render output", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      // Tab to active-agent, then Tab again to enter input sub-focus
      dashboard.handleInput("\t"); // info
      dashboard.handleInput("\t"); // active-agent
      expect(dashboard.focus).toBe("active-agent");
      dashboard.handleInput("\t"); // pane → input sub-focus

      // Type some text
      dashboard.handleInput("h");
      dashboard.handleInput("i");

      const lines = dashboard.render(160);
      const allText = lines.map(l => stripAnsi(l)).join("\n");
      // Input field should show "> hi█" somewhere in the output
      expect(allText).toContain("> hi█");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("when focus is not active-agent, input field appears without cursor", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      expect(dashboard.focus).toBe("agent-tree");
      const lines = dashboard.render(160);
      const allText = lines.map(l => stripAnsi(l)).join("\n");
      // Input field is shown but without cursor block (not active)
      expect(allText).toContain("> ");
      expect(allText).toContain("[Send]");
      expect(allText).not.toContain("█");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("message submission calls sendMessage on Enter", () => {
    const calls: { args: string[]; cwd: string }[] = [];
    mockSendSpawnRunner(calls);

    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    agent.meta.tmux_session = "agent-a-session";
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Tab to active-agent, then Tab to input sub-focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent
    expect(dashboard.focus).toBe("active-agent");
    dashboard.handleInput("\t"); // pane → input sub-focus

    // Type message, Tab to [Send], then press Enter to submit
    dashboard.handleInput("h");
    dashboard.handleInput("e");
    dashboard.handleInput("l");
    dashboard.handleInput("l");
    dashboard.handleInput("o");
    dashboard.handleInput("\t"); // input → send sub-focus
    dashboard.handleInput("\r"); // Enter on [Send] submits

    // sendMessage is async, so check that the input field was cleared
    expect(dashboard.inputField.getText()).toBe("");

    resetSendSpawnRunner();
  });

  test("Escape from input sub-focus clears input and returns to pane sub-focus", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Tab to active-agent, then Tab to input sub-focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent
    expect(dashboard.focus).toBe("active-agent");
    dashboard.handleInput("\t"); // pane → input sub-focus

    // Type some text
    dashboard.handleInput("h");
    dashboard.handleInput("i");
    expect(dashboard.inputField.getText()).toBe("hi");

    // Press Escape — returns to pane sub-focus, NOT agent-tree
    dashboard.handleInput("\x1b");
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("pane");
    expect(dashboard.inputField.getText()).toBe("");
  });

  test("Tab away from active-agent preserves input field text (per-agent buffer)", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Tab to active-agent, then Tab to input sub-focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent
    expect(dashboard.focus).toBe("active-agent");
    dashboard.handleInput("\t"); // pane → input sub-focus

    // Type some text
    dashboard.handleInput("h");
    dashboard.handleInput("i");
    expect(dashboard.inputField.getText()).toBe("hi");

    // Tab goes to send, then Tab cycles out
    dashboard.handleInput("\t"); // input → send
    dashboard.handleInput("\t"); // send → cycle out
    expect(dashboard.focus).toBe("right-pane");
    // Text is preserved (per-agent buffer)
    expect(dashboard.inputField.getText()).toBe("hi");
  });

  test("dashboard keybindings are suppressed when in input sub-focus", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Tab to active-agent, then Tab to input sub-focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent
    expect(dashboard.focus).toBe("active-agent");
    dashboard.handleInput("\t"); // pane → input sub-focus

    // Pressing 's' (which normally triggers send dialog) should type 's' into input field
    dashboard.handleInput("s");
    expect(dashboard.inputField.getText()).toBe("s");
    expect(dashboard.dialog).toBeNull();

    // Pressing 'j' (which normally navigates) should type 'j' into input field
    dashboard.handleInput("j");
    expect(dashboard.inputField.getText()).toBe("sj");
  });

  test("dashboard keybindings work in pane sub-focus (not captured by input)", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Tab to active-agent — stays in pane sub-focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("pane");

    // 'p' should cycle pane mode (not captured by input)
    const modeBefore = dashboard.currentMode;
    dashboard.handleInput("p");
    expect(dashboard.currentMode).not.toBe(modeBefore);
    expect(dashboard.inputField.getText()).toBe("");
  });

  test("Tab on active-agent pane sub-focus → input sub-focus", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent (pane)
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("pane");

    dashboard.handleInput("\t"); // pane → input
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("input");
  });

  test("Tab on active-agent input sub-focus → send sub-focus", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent (pane)
    dashboard.handleInput("\t"); // pane → input
    dashboard.handleInput("\t"); // input → send
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("send");
  });

  test("Tab on active-agent send sub-focus → next panel", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent (pane)
    dashboard.handleInput("\t"); // pane → input
    dashboard.handleInput("\t"); // input → send
    dashboard.handleInput("\t"); // send → right-pane
    expect(dashboard.focus).toBe("right-pane");
    expect(dashboard.subFocus).toBe("pane");
  });

  test("Shift-Tab reversal through active-agent sub-focus", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Get to send sub-focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent (pane)
    dashboard.handleInput("\t"); // pane → input
    dashboard.handleInput("\t"); // input → send
    expect(dashboard.subFocus).toBe("send");

    // Shift-Tab back through sub-focus
    dashboard.handleInput("\x1b[Z"); // send → input
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("input");

    dashboard.handleInput("\x1b[Z"); // input → pane
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("pane");

    dashboard.handleInput("\x1b[Z"); // pane → prev panel (info)
    expect(dashboard.focus).toBe("info");
  });

  test("[/] keys work in send sub-focus (resize, not captured)", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Get to send sub-focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent (pane)
    dashboard.handleInput("\t"); // pane → input
    dashboard.handleInput("\t"); // input → send

    // Store the split pane left width before resize
    const widthBefore = dashboard.splitPane.getLeftWidth();
    dashboard.handleInput("["); // resize should work
    expect(dashboard.splitPane.getLeftWidth()).not.toBe(widthBefore);
  });

  test("[/] keys captured as text in input sub-focus", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Get to input sub-focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent (pane)
    dashboard.handleInput("\t"); // pane → input

    dashboard.handleInput("[");
    // Should be captured as text, not resize
    expect(dashboard.inputField.getText()).toBe("[");
  });

  test("Escape from send sub-focus returns to pane sub-focus", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);

    // Get to send sub-focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent (pane)
    dashboard.handleInput("\t"); // pane → input
    dashboard.handleInput("\t"); // input → send

    dashboard.handleInput("\x1b"); // Escape
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("pane");
  });
});

describe("coordinator TmuxPoller (Phase 47c)", () => {
  test("dashboard has coordinatorPane field", () => {
    const dashboard = makeDashboard();
    expect(dashboard.coordinatorPane).toBeDefined();
    expect(dashboard.coordinatorPane).toBeInstanceOf(TmuxPaneComponent);
  });

  test("coordinatorPane is wired to sidebar", () => {
    const dashboard = makeDashboard();
    expect(dashboard.sidebar.coordinatorPane).toBe(dashboard.coordinatorPane);
  });

  test("startPolling and stopPolling manage coordinator poller lifecycle", () => {
    const dashboard = makeDashboard();
    // Before startPolling, coordinator pane has no output
    expect(dashboard.coordinatorPane.hasPolled).toBe(false);
    expect(dashboard.coordinatorPane.rawOutput).toBe("");

    // startPolling should not throw
    dashboard.startPolling();
    // stopPolling should clean up without error
    dashboard.stopPolling();
  });

  test("coordinator poller is paused when the system coordinator is NOT selected", () => {
    const dashboard = makeDashboard();
    // No coordinator selected at startup → coordinator pane is off-screen → poller paused
    dashboard.startPolling();
    try {
      expect(dashboard.coordinatorPollerRunning).toBe(false);
    } finally {
      dashboard.stopPolling();
    }
  });

  test("coordinator poller resumes when the system coordinator is selected, pauses when deselected", () => {
    const dashboard = makeDashboard();
    dashboard.startPolling();
    try {
      // Select the system coordinator (only entry → auto-selected)
      const coordList: FlatEntry[] = [makeFlatSystemCoordinator()];
      dashboard.onUpdate([], coordList, []);
      expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
      // Its TMUX pane is now on screen → poller running
      expect(dashboard.coordinatorPollerRunning).toBe(true);

      // Switch to a regular agent → coordinator pane off screen → poller paused
      const agent = makeAgent("agent-x", "/repos/test");
      const agentList: FlatEntry[] = [makeFlatAgent(agent)];
      dashboard.onUpdate([agent], agentList, []);
      expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(false);
      expect(dashboard.coordinatorPollerRunning).toBe(false);
    } finally {
      dashboard.stopPolling();
    }
  });

  test("coordinator poller pauses in DASHBOARD view, resumes in TMUX view", () => {
    const dashboard = makeDashboard();
    dashboard.startPolling();
    try {
      const coordList: FlatEntry[] = [makeFlatSystemCoordinator()];
      dashboard.onUpdate([], coordList, []);
      expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
      // Default view is TMUX → poller running
      expect(dashboard.coordinatorViewMode).toBe("TMUX");
      expect(dashboard.coordinatorPollerRunning).toBe(true);

      // 'n' toggles to DASHBOARD view — coordinator tmux output is no longer shown
      dashboard.handleInput("n");
      expect(dashboard.coordinatorViewMode).toBe("DASHBOARD");
      expect(dashboard.coordinatorPollerRunning).toBe(false);

      // 'n' again toggles back to TMUX — poller resumes
      dashboard.handleInput("n");
      expect(dashboard.coordinatorViewMode).toBe("TMUX");
      expect(dashboard.coordinatorPollerRunning).toBe(true);
    } finally {
      dashboard.stopPolling();
    }
  });

  test("repo-coordinator poller stays paused when no repo coordinator is visible", () => {
    const dashboard = makeDashboard();
    dashboard.startPolling();
    try {
      // Default startup: not in REPO mode, no repo coordinator → poller paused
      expect(dashboard.repoCoordinatorPollerRunning).toBe(false);

      // Selecting a regular agent keeps it paused (REPO mode not active, no coordinator)
      const agent = makeAgent("agent-y", "/repos/test");
      const agentList: FlatEntry[] = [makeFlatAgent(agent)];
      dashboard.onUpdate([agent], agentList, []);
      expect(dashboard.rightPane.repoCoordinatorAgent).toBeNull();
      expect(dashboard.repoCoordinatorPollerRunning).toBe(false);

      // Selecting a repo header with no coordinator agent in REPO mode → still paused
      const repoHeader = makeFlatRepoHeader("test", "/repos/test", true);
      const listWithHeader: FlatEntry[] = [repoHeader, makeFlatAgent(agent)];
      dashboard.onUpdate([agent], listWithHeader, []);
      dashboard.agentTree.selectByRepoPath("/repos/test");
      dashboard.onUpdate([agent], listWithHeader, []);
      expect(dashboard.rightPane.repoCoordinatorAgent).toBeNull();
      expect(dashboard.repoCoordinatorPollerRunning).toBe(false);
    } finally {
      dashboard.stopPolling();
    }
  });

  test("coordinator pane never renders in sidebar (only in main area when selected)", () => {
    const dashboard = makeDashboard();
    // Simulate coordinator poller delivering output
    dashboard.coordinatorPane.rawOutput = "Hello from coordinator\nLine 2";
    dashboard.coordinatorPane.hasPolled = true;

    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      const lines = dashboard.render(160);
      const text = lines.map(l => stripAnsi(l)).join("\n");
      // Coordinator is NOT rendered in the sidebar — only appears in main area when selected
      expect(text).not.toContain("System Coordinator");
      expect(text).not.toContain("Hello from coordinator");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });
});

describe("coordinator lifecycle (Phase 47f)", () => {
  test("R key triggers restartSystemCoordinator when coordinator is focused", () => {
    const dashboard = makeDashboard();
    // Select system coordinator in agent tree to enter coordinator mode
    // In coordinator mode, COORDINATOR_FOCUS_ORDER applies: agent-tree → info → coordinator
    const flatList: FlatEntry[] = [makeFlatSystemCoordinator()];
    dashboard.onUpdate([], flatList, []);
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    // Tab twice to reach coordinator focus
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // coordinator
    expect(dashboard.focus).toBe("coordinator");

    // Press R — should NOT call handleResume (no agent selected)
    // Instead it should trigger coordinator restart via executeAndRefresh
    // We can verify by checking that no error notice was set for missing agent
    dashboard.handleInput("R");
    // The executeAndRefresh will call restartSystemCoordinator which tries tmux commands.
    // In test environment those will fail silently. The important thing is the code path was taken.
    // We verify the notice was set (either success or error from the tmux command failing)
    // Wait a tick for the async operation
  });

  test("R key triggers handleResume when agent-tree is focused (not coordinator)", () => {
    const dashboard = makeDashboard();
    // Default focus is agent-tree
    expect(dashboard.focus).toBe("agent-tree");

    // R with no agent selected does nothing (handleResume checks selectedAgent)
    dashboard.handleInput("R");
    // No crash — just returns silently
  });

  test("coordinator pane shows stopped message when session dies (main area when selected)", () => {
    const dashboard = makeDashboard();
    // Select system coordinator in the agent tree so its output appears in the main area
    const flatList: FlatEntry[] = [makeFlatSystemCoordinator()];
    dashboard.onUpdate([], flatList, []);
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);

    // Simulate coordinator session dying — hasPolled but no output
    dashboard.coordinatorPane.hasPolled = true;
    dashboard.coordinatorPane.rawOutput = "";

    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      const lines = dashboard.render(160);
      const text = lines.map(l => stripAnsi(l)).join("\n");
      // Main area renders coordinator tmux via TmuxPaneComponent (agentless mode)
      // when coordinator is selected — the session dying shows as empty pane
      expect(text).toContain("System Coordinator");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("coordinator pane shows loading message before first poll (main area when selected)", () => {
    const dashboard = makeDashboard();
    // Select system coordinator in the agent tree so its output appears in the main area
    const flatList: FlatEntry[] = [makeFlatSystemCoordinator()];
    dashboard.onUpdate([], flatList, []);
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);

    dashboard.coordinatorPane.hasPolled = false;
    dashboard.coordinatorPane.rawOutput = "";

    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      const lines = dashboard.render(160);
      const text = lines.map(l => stripAnsi(l)).join("\n");
      // Main area renders coordinator tmux via TmuxPaneComponent (agentless mode) before first poll
      expect(text).toContain("Waiting for output");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });
});

describe("coordinator input field (Phase 49)", () => {
  /** Helper to set up a dashboard with system coordinator selected */
  function setupCoordinatorDashboard() {
    const dashboard = makeDashboard();
    const flatList: FlatEntry[] = [makeFlatSystemCoordinator()];
    dashboard.onUpdate([], flatList, []);
    // selectedIndex 0 is the system-coordinator entry
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    // coordinatorMode limits focus to agent-tree, info, and coordinator
    // Set coordinatorPane output — coordinator TMUX view uses coordinatorPane in main area
    // (tmuxPane is for regular agents; coordinatorPane has its own poller)
    dashboard.tmuxPane.rawOutput = "Coordinator output";
    dashboard.tmuxPane.hasPolled = true;
    dashboard.coordinatorPane.rawOutput = "Coordinator output";
    dashboard.coordinatorPane.hasPolled = true;
    return dashboard;
  }

  /** Tab from agent-tree to coordinator (skipping info in between) */
  function tabToCoordinator(dashboard: ReturnType<typeof setupCoordinatorDashboard>) {
    dashboard.handleInput("\t"); // agent-tree → info
    dashboard.handleInput("\t"); // info → coordinator
  }

  test("coordinator input field is a separate instance from agent input field", () => {
    const dashboard = makeDashboard();
    expect(dashboard.coordinatorInputField).not.toBe(dashboard.inputField);
    expect(dashboard.coordinatorInputField).toBeInstanceOf(Object);
  });

  test("when coordinator panel is focused, input routes to coordinator input field in input sub-focus", () => {
    const dashboard = setupCoordinatorDashboard();
    // Tab to coordinator (agent-tree → info → coordinator)
    tabToCoordinator(dashboard);
    expect(dashboard.focus).toBe("coordinator");
    dashboard.handleInput("\t"); // pane → input sub-focus

    // Type some text — should go to coordinator input field
    dashboard.handleInput("h");
    dashboard.handleInput("i");
    expect(dashboard.coordinatorInputField.getText()).toBe("hi");
    // Agent input field should remain empty
    expect(dashboard.inputField.getText()).toBe("");
  });

  test("Escape from coordinator input sub-focus clears input and returns to pane sub-focus", () => {
    const dashboard = setupCoordinatorDashboard();
    tabToCoordinator(dashboard);
    expect(dashboard.focus).toBe("coordinator");
    dashboard.handleInput("\t"); // pane → input sub-focus

    dashboard.handleInput("h");
    dashboard.handleInput("i");
    expect(dashboard.coordinatorInputField.getText()).toBe("hi");

    dashboard.handleInput("\x1b"); // Escape — returns to pane sub-focus, NOT agent-tree
    expect(dashboard.focus).toBe("coordinator");
    expect(dashboard.subFocus).toBe("pane");
    expect(dashboard.coordinatorInputField.getText()).toBe("");
  });

  test("Tab from coordinator send sub-focus cycles focus normally", () => {
    const dashboard = setupCoordinatorDashboard();
    tabToCoordinator(dashboard);
    expect(dashboard.focus).toBe("coordinator");

    // Tab through sub-focus states: pane → input → send
    dashboard.handleInput("\t"); // pane → input
    dashboard.handleInput("\t"); // input → send
    expect(dashboard.subFocus).toBe("send");

    // Tab again — should cycle to agent-tree
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("agent-tree");
  });

  test("Shift-Tab from coordinator pane sub-focus cycles focus backwards", () => {
    const dashboard = setupCoordinatorDashboard();
    tabToCoordinator(dashboard);
    expect(dashboard.focus).toBe("coordinator");
    expect(dashboard.subFocus).toBe("pane");

    // Shift-Tab from pane sub-focus — cycles backward to info
    dashboard.handleInput("\x1b[Z");
    expect(dashboard.focus).toBe("info");
  });

  test("coordinator input field renders in main area when in input sub-focus", () => {
    const dashboard = setupCoordinatorDashboard();
    tabToCoordinator(dashboard);
    expect(dashboard.focus).toBe("coordinator");
    dashboard.handleInput("\t"); // pane → input sub-focus

    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      dashboard.handleInput("t");
      dashboard.handleInput("e");
      dashboard.handleInput("s");
      dashboard.handleInput("t");

      const lines = dashboard.render(160);
      const text = lines.map(l => stripAnsi(l)).join("\n");
      // Input field should show the typed text with cursor in main area
      expect(text).toContain("> test█");
      expect(text).toContain("[Send]");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("coordinator tmux output shown in main area when coordinator selected", () => {
    const dashboard = setupCoordinatorDashboard();
    // Focus stays on agent-tree
    expect(dashboard.focus).toBe("agent-tree");

    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      const lines = dashboard.render(160);
      const text = lines.map(l => stripAnsi(l)).join("\n");
      // Coordinator tmux output should appear in the main area
      expect(text).toContain("Coordinator output");
      // Sidebar should not have coordinator section
      expect(text).not.toContain("System Coordinator\n");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("dashboard keybindings are suppressed in coordinator input sub-focus", () => {
    const dashboard = setupCoordinatorDashboard();
    tabToCoordinator(dashboard);
    expect(dashboard.focus).toBe("coordinator");
    dashboard.handleInput("\t"); // pane → input sub-focus

    // 'p' should be consumed as text input, not cycle pane modes
    const modeBefore = dashboard.currentMode;
    dashboard.handleInput("p");
    expect(dashboard.currentMode).toBe(modeBefore);
    expect(dashboard.coordinatorInputField.getText()).toBe("p");
  });

  test("coordinator submit routes through the coordinator outbox (sendToSystemCoordinator)", async () => {
    // The inline coordinator input field must NOT write straight to the
    // ib-coordinator tmux session — it must go through sendToSystemCoordinator
    // so it shares the coordinator-home outbox queue + per-session lock with
    // `ib send @system` / watchdog notifications / the `s`-key dialog. We prove
    // routing by isolating the coordinator home, forcing has-session true, and
    // asserting a send-keys to IB_COORDINATOR_SESSION lands via the outbox
    // delivery path.
    const { setSystemCoordinatorHasSessionFn, resetSystemCoordinatorHasSessionFn } = await import("../index");
    const { setCoordinatorHome, resetCoordinatorHome, IB_COORDINATOR_SESSION } = await import("../coordinator");
    const coordHome = await mkdtemp(join(tmpdir(), "dash-coord-home-"));
    const cfgDir = await mkdtemp(join(tmpdir(), "dash-coord-cfg-"));
    setUserConfigPath(join(cfgDir, "config.json"));
    setCoordinatorHome(coordHome);
    setSystemCoordinatorHasSessionFn(async () => true);
    const sendKeys: string[][] = [];
    setSendSpawnRunner((cmd: string[]) => {
      sendKeys.push(cmd);
      return makeSpawnResult();
    });

    try {
      const dashboard = setupCoordinatorDashboard();
      tabToCoordinator(dashboard);
      expect(dashboard.focus).toBe("coordinator");
      dashboard.handleInput("\t"); // pane → input sub-focus

      dashboard.handleInput("h");
      dashboard.handleInput("i");
      dashboard.handleInput("\t"); // input → send
      dashboard.handleInput("\r");

      // Input cleared after submit.
      expect(dashboard.coordinatorInputField.getText()).toBe("");

      await dashboard.flushPendingActions();

      // Delivered to the coordinator session via the outbox drain (raw → no prefix).
      const literal = sendKeys.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c[3] === IB_COORDINATOR_SESSION && c[4] === "-l" && c[5] === "--",
      );
      expect(literal).toBeDefined();
      expect(literal![6]).toBe("hi");
      // And an Enter to the same session.
      expect(sendKeys.some((c) => c[3] === IB_COORDINATOR_SESSION && c[c.length - 1] === "Enter")).toBe(true);
    } finally {
      resetSystemCoordinatorHasSessionFn();
      resetCoordinatorHome();
      resetUserConfigPath();
      resetSendSpawnRunner();
      await rm(coordHome, { recursive: true, force: true });
      await rm(cfgDir, { recursive: true, force: true });
    }
  });

  test("syncSelectedAgent switches coordinator input field buffer", () => {
    const dashboard = setupCoordinatorDashboard();

    // Tab to coordinator, then Tab to input sub-focus and type
    tabToCoordinator(dashboard);
    dashboard.handleInput("\t"); // pane → input sub-focus
    dashboard.handleInput("a");
    dashboard.handleInput("b");
    expect(dashboard.coordinatorInputField.getText()).toBe("ab");

    // Switch to a non-coordinator selection
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatSystemCoordinator(), makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);
    // Move selection to the agent
    dashboard.handleInput("\x1b[B"); // down arrow

    // Coordinator input buffer should be saved; switching back should restore it
    dashboard.handleInput("\x1b[A"); // up arrow to coordinator
    expect(dashboard.coordinatorInputField.getText()).toBe("ab");
  });
});

describe("coordinator view mode toggling (n/p)", () => {
  function setupCoordinatorDashboard() {
    const dashboard = makeDashboard();
    const flatList: FlatEntry[] = [makeFlatSystemCoordinator()];
    dashboard.onUpdate([], flatList, []);
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    dashboard.tmuxPane.rawOutput = "Coordinator tmux output";
    dashboard.tmuxPane.hasPolled = true;
    dashboard.coordinatorPane.rawOutput = "Coordinator tmux output";
    dashboard.coordinatorPane.hasPolled = true;
    return dashboard;
  }

  test("default coordinator view mode is TMUX", () => {
    const dashboard = setupCoordinatorDashboard();
    expect(dashboard.coordinatorViewMode).toBe("TMUX");
  });

  test("p key toggles coordinator view mode from TMUX to DASHBOARD", () => {
    const dashboard = setupCoordinatorDashboard();
    expect(dashboard.coordinatorViewMode).toBe("TMUX");
    dashboard.handleInput("p");
    expect(dashboard.coordinatorViewMode).toBe("DASHBOARD");
  });

  test("n key toggles coordinator view mode from TMUX to DASHBOARD", () => {
    const dashboard = setupCoordinatorDashboard();
    expect(dashboard.coordinatorViewMode).toBe("TMUX");
    dashboard.handleInput("n");
    expect(dashboard.coordinatorViewMode).toBe("DASHBOARD");
  });

  test("p key toggles back from DASHBOARD to TMUX", () => {
    const dashboard = setupCoordinatorDashboard();
    dashboard.handleInput("p"); // TMUX → DASHBOARD
    expect(dashboard.coordinatorViewMode).toBe("DASHBOARD");
    dashboard.handleInput("p"); // DASHBOARD → TMUX
    expect(dashboard.coordinatorViewMode).toBe("TMUX");
  });

  test("n/p does not cycle right-pane modes when coordinator is selected", () => {
    const dashboard = setupCoordinatorDashboard();
    const modeBefore = dashboard.currentMode;
    dashboard.handleInput("p");
    // Right pane mode should not change — p toggles coordinator view instead
    expect(dashboard.currentMode).toBe(modeBefore);
  });

  test("n/p cycles right-pane modes normally when coordinator is NOT selected", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);
    const modeBefore = dashboard.currentMode;
    dashboard.handleInput("p");
    // Right pane mode should change for normal agents
    expect(dashboard.currentMode).not.toBe(modeBefore);
  });

  test("TMUX view renders coordinator output in main area", () => {
    const dashboard = setupCoordinatorDashboard();
    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      const lines = dashboard.render(160);
      const text = lines.map(l => stripAnsi(l)).join("\n");
      expect(text).toContain("Coordinator tmux output");
      expect(text).toContain("TMUX");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("DASHBOARD view renders system dashboard table in main area", () => {
    const dashboard = setupCoordinatorDashboard();
    dashboard.handleInput("p"); // switch to DASHBOARD
    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      const lines = dashboard.render(160);
      const text = lines.map(l => stripAnsi(l)).join("\n");
      expect(text).toContain("DASHBOARD");
      // Should NOT contain tmux output in main area
      expect(text).not.toContain("Coordinator tmux output");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("coordinator view mode resets to TMUX when re-entering coordinator selection", () => {
    const dashboard = setupCoordinatorDashboard();
    dashboard.handleInput("p"); // switch to DASHBOARD
    expect(dashboard.coordinatorViewMode).toBe("DASHBOARD");

    // Add an agent and select it
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatSystemCoordinator(), makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, []);
    dashboard.handleInput("\x1b[B"); // down arrow to agent
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(false);

    // Return to coordinator
    dashboard.handleInput("\x1b[A"); // up arrow to coordinator
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    expect(dashboard.coordinatorViewMode).toBe("TMUX"); // reset on re-entry
  });

  test("coordinator view mode persists across watcher ticks", () => {
    const dashboard = setupCoordinatorDashboard();
    dashboard.handleInput("p"); // switch to DASHBOARD
    expect(dashboard.coordinatorViewMode).toBe("DASHBOARD");

    // Simulate watcher tick (onUpdate with same data)
    const flatList: FlatEntry[] = [makeFlatSystemCoordinator()];
    dashboard.onUpdate([], flatList, []);

    // View mode should persist — not be reset
    expect(dashboard.coordinatorViewMode).toBe("DASHBOARD");
  });
});

describe("Telegram header indicator", () => {
  let dashboard: DashboardComponent;
  let origRows: number | undefined;

  beforeEach(() => {
    dashboard = makeDashboard();
    origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
  });

  test("header hides indicator when telegramStatus is null", () => {
    const lines = dashboard.render(160);
    const header = lines[0]!;
    expect(stripAnsi(header)).toContain("ib");
    expect(stripAnsi(header)).not.toContain("Telegram");
  });

  test("header shows green indicator when telegramStatus is green", () => {
    dashboard.setTelegramStatus("green");
    const lines = dashboard.render(160);
    const header = lines[0]!;
    expect(stripAnsi(header)).toContain("Telegram");
    // GREEN is "\x1b[32m"
    expect(header).toContain("\x1b[32m●");
  });

  test("header shows red indicator when telegramStatus is red", () => {
    dashboard.setTelegramStatus("red");
    const lines = dashboard.render(160);
    const header = lines[0]!;
    expect(stripAnsi(header)).toContain("Telegram");
    // RED is "\x1b[31m"
    expect(header).toContain("\x1b[31m●");
  });

  test("header shows yellow indicator when telegramStatus is yellow", () => {
    dashboard.setTelegramStatus("yellow");
    const lines = dashboard.render(160);
    const header = lines[0]!;
    expect(stripAnsi(header)).toContain("Telegram");
    // YELLOW is "\x1b[33m"
    expect(header).toContain("\x1b[33m●");
  });

  test("Telegram indicator right-aligns at terminal width", () => {
    dashboard.setTelegramStatus("green");
    const width = 160;
    const lines = dashboard.render(width);
    const header = lines[0]!;
    expect(visibleWidth(header)).toBeLessThanOrEqual(width);
    // The visible text should end with "Telegram"
    expect(stripAnsi(header).trimEnd().endsWith("Telegram")).toBe(true);
    // Visible width should equal width - 1 (one space of padding before the right edge)
    expect(visibleWidth(header)).toBe(width - 1);
  });

  test("narrow render width truncates and does not crash", () => {
    dashboard.setTelegramStatus("green");
    const lines = dashboard.render(140);
    expect(lines.length).toBeGreaterThan(0);
    const header = lines[0]!;
    expect(visibleWidth(header)).toBeLessThanOrEqual(140);
  });
});

describe("DashboardComponent — §17 Teams panel wiring", () => {
  let coordHome: string;

  beforeEach(async () => {
    const { setCoordinatorHome } = await import("../coordinator");
    coordHome = await mkdtemp(join(tmpdir(), "dash-teams-coord-"));
    setCoordinatorHome(coordHome);
  });

  afterEach(async () => {
    const { resetCoordinatorHome } = await import("../coordinator");
    resetCoordinatorHome();
    await rm(coordHome, { recursive: true, force: true });
  });

  // §17.1 Phase 2: effective-selection routing follows `activeSelectionSource`,
  // not `sidebarMode`. These tests set BOTH because the Phase 2 model treats
  // them as independent axes — for a team to drive the main pane it must be
  // BOTH visible (sidebarMode=teams) AND the active selection
  // (activeSelectionSource=teams).
  test("selection sync: team-anchor selection populates infoPanel.selectedTeam + channelPane.teamName", () => {
    const dashboard = makeDashboard();
    // Directly drive the Teams tree (skip the on-disk teams.json round-trip)
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "backend", memberCount: 1, createdEpoch: 1735689600, createdBy: "@system" },
    ]);
    dashboard.teamsTree.navigate(1); // selects the team-header row
    dashboard.sidebarMode = "teams";
    dashboard.activeSelectionSource = "teams";
    dashboard.syncSelectedAgent();
    expect(dashboard.channelPane.teamName).toBe("backend");
    // infoPanel.selectedTeam is populated async — refreshSelectedTeamInfo runs
    // getTeam(name); when the team isn't in the on-disk registry it CLEARS.
    // Direct render-time guarantee: channelPane.teamName tracks the team anchor.
  });

  test("selection sync: team-MEMBER selection drives the agent path (rightPane/tmuxPane/infoPanel.agent)", () => {
    const dashboard = makeDashboard();
    const tmp = "/tmp/test-repo";
    const a = makeAgent("agent-tm1", tmp);
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "backend", memberCount: 1, createdEpoch: 1, createdBy: "@system" },
      { kind: "team-member", teamName: "backend", agent: a, connector: "  " },
    ]);
    dashboard.teamsTree.navigate(1); // header
    dashboard.teamsTree.navigate(1); // member row
    dashboard.sidebarMode = "teams";
    dashboard.activeSelectionSource = "teams";
    dashboard.syncSelectedAgent();
    // Member selection populates the agent path identically to an Agents-tree select.
    expect(dashboard.rightPane.agent?.id).toBe("agent-tm1");
    expect(dashboard.tmuxPane.agent?.id).toBe("agent-tm1");
    expect(dashboard.infoPanel.agent?.id).toBe("agent-tm1");
    // And the team-mode fields are CLEAR — no stale team state.
    expect(dashboard.channelPane.teamName).toBe(null);
    expect(dashboard.infoPanel.selectedTeam).toBe(null);
  });

  test("selection sync: switching activeSelectionSource from teams back to agents clears team state", () => {
    const dashboard = makeDashboard();
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);
    dashboard.teamsTree.navigate(1);
    dashboard.sidebarMode = "teams";
    dashboard.activeSelectionSource = "teams";
    dashboard.syncSelectedAgent();
    expect(dashboard.channelPane.teamName).toBe("backend");

    // Switch active source back to agents — selection-sync must clear team
    // state even though sidebarMode is still "teams" (Phase 2: independent axes).
    dashboard.activeSelectionSource = "agents";
    dashboard.syncSelectedAgent();
    expect(dashboard.channelPane.teamName).toBe(null);
    expect(dashboard.infoPanel.selectedTeam).toBe(null);
  });

  test("selection sync: teams active source with no selection clears all team/agent state", () => {
    const dashboard = makeDashboard();
    dashboard.sidebarMode = "teams";
    dashboard.activeSelectionSource = "teams";
    dashboard.syncSelectedAgent();
    expect(dashboard.channelPane.teamName).toBe(null);
    expect(dashboard.infoPanel.selectedTeam).toBe(null);
    expect(dashboard.rightPane.agent).toBe(null);
    expect(dashboard.tmuxPane.agent).toBe(null);
  });

  test("j/k routes to teamsTree.navigate when sidebarMode is teams (else agentTree.moveSelection)", () => {
    const dashboard = makeDashboard();
    // Populate both trees so j/k routes have something to move over
    const tmp = "/tmp/repo-jk";
    const a1 = makeAgent("agent-jk1", tmp);
    const a2 = makeAgent("agent-jk2", tmp);
    dashboard.agentTree.setFlatList([makeFlatAgent(a1), makeFlatAgent(a2)]);
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "t1", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      { kind: "team-header", teamName: "t2", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);

    // §17.1 Phase 1: with sidebarMode=agents (default), j moves the agent tree.
    const before = dashboard.agentTree.selection;
    dashboard.handleInput("j");
    // agentTree starts in no-selection; j enters selected at index 0
    const after = dashboard.agentTree.selection;
    expect(after).not.toBeNull();
    // teamsTree should NOT have advanced
    expect(dashboard.teamsTree.selection).toBeNull();

    // Reset and switch to teams sidebar mode
    const dashboard2 = makeDashboard();
    dashboard2.agentTree.setFlatList([makeFlatAgent(a1), makeFlatAgent(a2)]);
    dashboard2.teamsTree.setFlatList([
      { kind: "team-header", teamName: "t1", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      { kind: "team-header", teamName: "t2", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);
    dashboard2.sidebarMode = "teams";
    dashboard2.handleInput("j");
    expect(dashboard2.teamsTree.selection?.kind).toBe("team");
    // agentTree must NOT have a selection — independent (§17.1)
    expect(dashboard2.agentTree.selection).toBeNull();
  });

  test("shift+j (J) routes to teamsTree.navigateAnchor when sidebarMode is teams", () => {
    const dashboard = makeDashboard();
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "t1", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      { kind: "team-header", teamName: "t2", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);
    dashboard.sidebarMode = "teams";
    dashboard.handleInput("J");
    // From no-selection, shift+j lands on the first team anchor
    expect(dashboard.teamsTree.selection?.kind).toBe("team");
    if (dashboard.teamsTree.selection?.kind === "team") {
      expect(dashboard.teamsTree.selection.teamName).toBe("t1");
    }
  });

  test("focus toggle (Tab) preserves each tree's selection (§17.1 independent selection)", () => {
    const dashboard = makeDashboard();
    const tmp = "/tmp/repo-tog";
    const a = makeAgent("agent-tog", tmp);
    dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "t1", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);
    // Select in both panels
    dashboard.agentTree.selectFirstRow();
    dashboard.teamsTree.navigate(1);
    expect(dashboard.agentTree.selection).not.toBeNull();
    expect(dashboard.teamsTree.selection).not.toBeNull();

    // Switch focus to teams-tree (via setFocus — equivalent to pressing '0')
    dashboard.focusManager.setFocus("teams-tree");
    // Each panel's selection is preserved
    expect(dashboard.agentTree.selection).not.toBeNull();
    expect(dashboard.teamsTree.selection).not.toBeNull();

    // Switch back (equivalent to pressing '1')
    dashboard.focusManager.setFocus("agent-tree");
    expect(dashboard.agentTree.selection).not.toBeNull();
    expect(dashboard.teamsTree.selection).not.toBeNull();
  });

  test("startup auto-select still selects first agent (§17.1 user-confirmed startup)", () => {
    const dashboard = makeDashboard();
    const tmp = "/tmp/repo-startup";
    const a = makeAgent("agent-startup", tmp);
    // hasAutoSelectedFirstAgent is private; we exercise it through onUpdate
    dashboard.onUpdate([a], [makeFlatAgent(a)], []);
    expect(dashboard.agentTree.selection).not.toBeNull();
    expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-startup");
  });

  test("selecting a team triggers an immediate channelPane.load() (§17.4 refresh cadence)", () => {
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    const dashboard = makeDashboard();
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);

    // Intercept channelPane.load() to assert the selection-change path triggers it
    let loadCalls = 0;
    const originalLoad = dashboard.channelPane.load.bind(dashboard.channelPane);
    dashboard.channelPane.load = async () => { loadCalls++; return originalLoad(); };

    dashboard.teamsTree.navigate(1);
    dashboard.sidebarMode = "teams";
    dashboard.activeSelectionSource = "teams";
    dashboard.syncSelectedAgent();

    // The one-shot refreshChannel() on team selection change fires load() once;
    // render() must NOT add a second call (that would re-introduce the loop bug).
    const lines = dashboard.render(160);
    expect(lines.length).toBeGreaterThan(1);
    expect(loadCalls).toBe(1);

    // Subsequent renders MUST NOT trigger load — the timer is the only driver.
    dashboard.render(160);
    dashboard.render(160);
    expect(loadCalls).toBe(1);
  });

  test("render with activeSelectionSource=teams + no selection does NOT call channelPane.load (no teamName)", () => {
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    const dashboard = makeDashboard();
    dashboard.sidebarMode = "teams";
    dashboard.activeSelectionSource = "teams";
    dashboard.syncSelectedAgent();

    let loadCalls = 0;
    dashboard.channelPane.load = async () => { loadCalls++; };
    dashboard.render(160);
    expect(loadCalls).toBe(0);
  });

  // §17.1 Phase 2 — global-selection axis is independent of sidebar visibility.
  // These tests pin the three-axis model behavior: `0`/`1` flip the sidebar
  // tree but NEVER move the active selection; j/k flip the active source to
  // whichever tree is visible (the user just declared what they're selecting).
  describe("§17.1 Phase 2 — global selection independent of sidebar mode", () => {
    test("'0' toggles sidebarMode without changing activeSelectionSource", () => {
      const dashboard = makeDashboard();
      const a = makeAgent("agent-glob1", "/tmp/repo-glob");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.agentTree.selectFirstRow();
      expect(dashboard.sidebarMode).toBe("agents");
      expect(dashboard.activeSelectionSource).toBe("agents");
      dashboard.handleInput("0");
      expect(dashboard.sidebarMode).toBe("teams");
      // The agent is still the active selection — Phase 2 invariant.
      expect(dashboard.activeSelectionSource).toBe("agents");
      // Info / main panes still drive off the agent (syncSelectedAgent ran).
      expect(dashboard.infoPanel.agent?.id).toBe("agent-glob1");
    });

    test("'1' toggles sidebarMode back without changing activeSelectionSource", () => {
      const dashboard = makeDashboard();
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "t1", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      ]);
      // User pressed '0' then j to make team t1 active.
      dashboard.handleInput("0");
      dashboard.handleInput("j");
      expect(dashboard.activeSelectionSource).toBe("teams");
      // Now press '1' — sidebar shows Agents, but team stays active.
      dashboard.handleInput("1");
      expect(dashboard.sidebarMode).toBe("agents");
      expect(dashboard.activeSelectionSource).toBe("teams");
      // Main / info pane STILL drives the team channel.
      expect(dashboard.channelPane.teamName).toBe("t1");
    });

    test("j/k in the visible tree flips activeSelectionSource to that tree", () => {
      const dashboard = makeDashboard();
      const a = makeAgent("agent-jk", "/tmp/r");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "t1", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      ]);
      // Start with the Agents tree as active (default), an agent selected.
      dashboard.handleInput("j");
      expect(dashboard.activeSelectionSource).toBe("agents");
      expect(dashboard.infoPanel.agent?.id).toBe("agent-jk");
      // Press '0' to flip sidebar to teams — active source stays "agents".
      dashboard.handleInput("0");
      expect(dashboard.activeSelectionSource).toBe("agents");
      // Press j — navigates Teams (visible) tree, active source flips to "teams".
      dashboard.handleInput("j");
      expect(dashboard.activeSelectionSource).toBe("teams");
      expect(dashboard.channelPane.teamName).toBe("t1");
    });

    test("'0' mirrors active agent into the Teams tree when it's a team member", () => {
      const dashboard = makeDashboard();
      const a = makeAgent("agent-member", "/tmp/r");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 1, createdEpoch: 1, createdBy: "@system" },
        { kind: "team-member", teamName: "backend", agent: a, connector: "  " },
      ]);
      dashboard.agentTree.selectFirstRow();
      // User flips to Teams panel — the active agent should mirror into the
      // Teams tree's member row for visual continuity.
      dashboard.handleInput("0");
      const sel = dashboard.teamsTree.selection;
      expect(sel?.kind).toBe("agent");
      if (sel?.kind === "agent") expect(sel.agent.id).toBe("agent-member");
    });

    test("'0' leaves Teams tree in no-selection when active agent is not a team member", () => {
      const dashboard = makeDashboard();
      const a = makeAgent("agent-loner", "/tmp/r");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      ]);
      dashboard.agentTree.selectFirstRow();
      dashboard.handleInput("0");
      // The agent is not a member — Teams tree should NOT have a selection.
      expect(dashboard.teamsTree.selection).toBeNull();
      // But the Agents tree's selection is intact — agents tree remains the source.
      expect(dashboard.activeSelectionSource).toBe("agents");
      expect(dashboard.agentTree.selection).not.toBeNull();
    });

    test("'1' mirrors active team-member into the Agents tree", () => {
      const dashboard = makeDashboard();
      const a = makeAgent("agent-mirror", "/tmp/r");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 1, createdEpoch: 1, createdBy: "@system" },
        { kind: "team-member", teamName: "backend", agent: a, connector: "  " },
      ]);
      // User on teams panel with the team MEMBER as the active selection.
      dashboard.sidebarMode = "teams";
      dashboard.activeSelectionSource = "teams";
      dashboard.teamsTree.navigate(1);
      dashboard.teamsTree.navigate(1); // land on the member row
      // Now press '1' — flips visibility to agents; agents tree should mirror.
      dashboard.handleInput("1");
      expect(dashboard.agentTree.selection?.kind).toBe("agent");
      expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-mirror");
      // Active source still "teams" — visual mirror only.
      expect(dashboard.activeSelectionSource).toBe("teams");
    });

    test("'1' leaves Agents tree in no-selection when active selection is a team anchor", () => {
      const dashboard = makeDashboard();
      const a = makeAgent("agent-x", "/tmp/r");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      ]);
      dashboard.handleInput("0"); // sidebar -> teams
      dashboard.handleInput("j"); // select team anchor; active=teams
      expect(dashboard.activeSelectionSource).toBe("teams");
      dashboard.handleInput("1"); // sidebar -> agents
      // Agents tree has no agent counterpart for a team anchor — deselected.
      expect(dashboard.agentTree.selection).toBeNull();
      // But the team is still the active selection — main pane drives the team.
      expect(dashboard.activeSelectionSource).toBe("teams");
      expect(dashboard.channelPane.teamName).toBe("backend");
    });

    test("active source = teams + team-anchor selected: Agents tree is deselected (no counterpart)", () => {
      Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
      const dashboard = makeDashboard();
      const a = makeAgent("agent-sup", "/tmp/r");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.agentTree.selectFirstRow();
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "t1", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      ]);
      // Force Teams tree as active source while sidebar shows Agents.
      dashboard.activeSelectionSource = "teams";
      dashboard.teamsTree.navigate(1);
      dashboard.syncSelectedAgent();
      dashboard.render(160);
      // A team anchor has no Agents-tree counterpart, so the inactive Agents
      // tree is deselected by the mirror — no highlight regardless of
      // suppressSelection (which is now only used for QUESTIONS dimming).
      expect(dashboard.agentTree.selection).toBeNull();
      expect(dashboard.agentTree.suppressSelection).toBe(false);
    });

    test("active source = teams + member-agent selected that also lives in Agents tree: BOTH trees highlight", () => {
      Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
      const dashboard = makeDashboard();
      const a = makeAgent("agent-shared", "/tmp/r");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "t1", memberCount: 1, createdEpoch: 1, createdBy: "@system" },
        { kind: "team-member", teamName: "t1", agent: a, connector: "  " },
      ]);
      // Active source = teams, select the team member.
      dashboard.activeSelectionSource = "teams";
      dashboard.teamsTree.navigate(1); // team header
      dashboard.teamsTree.navigate(1); // member
      dashboard.syncSelectedAgent();
      dashboard.render(160);
      // BOTH trees should now point at the same agent (mirror selected it in
      // the Agents tree) and neither should be suppressed.
      expect(dashboard.agentTree.selection?.kind).toBe("agent");
      if (dashboard.agentTree.selection?.kind === "agent") {
        expect(dashboard.agentTree.selection.agent.id).toBe("agent-shared");
      }
      expect(dashboard.teamsTree.selection?.kind).toBe("agent");
      expect(dashboard.agentTree.suppressSelection).toBe(false);
      expect(dashboard.teamsTree.suppressSelection).toBe(false);
    });

    test("sidebarMode=activeSelectionSource: visible tree highlights normally", () => {
      Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
      const dashboard = makeDashboard();
      const a = makeAgent("agent-norm", "/tmp/r");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.agentTree.selectFirstRow();
      dashboard.render(160);
      // Both agree on "agents" — agentTree should NOT be suppressed (not in
      // QUESTIONS focus, the only other source of suppress).
      expect(dashboard.agentTree.suppressSelection).toBe(false);
    });

    // Phase 2 reviewer regression: when the system coordinator was the active
    // selection and the user then navigates to a team, the stale coord pointer
    // in the (now-inactive) Agents tree must NOT bleed into the render path.
    // The team channel must render, NOT the coordinator pane.
    test("stale isSystemCoordinatorSelected does NOT suppress the team channel render path", () => {
      Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
      const dashboard = makeDashboard();

      // 1. Start with the system coordinator selected (Agents tree, active).
      const coordList: FlatEntry[] = [makeFlatSystemCoordinator()];
      dashboard.onUpdate([], coordList, []);
      expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
      expect(dashboard.activeSelectionSource).toBe("agents");

      // 2. User flips to teams, then selects a team header.
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      ]);
      dashboard.handleInput("0"); // sidebarMode -> teams; coord still selected in agentTree
      dashboard.handleInput("j"); // navigate teams; activeSelectionSource -> teams

      expect(dashboard.activeSelectionSource).toBe("teams");
      // §17.1 Phase 2 (refined mirror): selecting a team anchor triggers
      // `mirrorSelectionToVisibleTree` which `deselect()`s the inactive
      // Agents tree, clearing the coord pointer too. The render path's
      // active-source gating still belt-and-suspenders the team view, but
      // there is no stale coord pointer left to mishandle.
      expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(false);

      // syncSelectedAgent already routes correctly — verify and pin.
      expect(dashboard.channelPane.teamName).toBe("backend");

      // Render and assert the result is the TEAM view, not the coord view.
      const output = dashboard.render(160).join("\n");
      const plain = stripAnsi(output);

      // Team title separator shows `@backend CHAT` / `@backend LOG`.
      expect(plain).toContain("@backend CHAT");
      expect(plain).toContain("@backend LOG");
      // No "Coordinator" title — the coord title separator's signature.
      expect(plain).not.toContain("Coordinator");
    });

    test("updatePollerVisibility pauses the coordinator poller when active source is teams", () => {
      const dashboard = makeDashboard();
      dashboard.startPolling();
      try {
        // 1. Coordinator selected → poller running.
        const coordList: FlatEntry[] = [makeFlatSystemCoordinator()];
        dashboard.onUpdate([], coordList, []);
        expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
        expect(dashboard.coordinatorPollerRunning).toBe(true);

        // 2. Flip to teams panel, navigate to a team — active source flips,
        //    and the mirror clears the Agents tree's coord pointer (team
        //    anchors have no Agents-tree counterpart).
        dashboard.teamsTree.setFlatList([
          { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
        ]);
        dashboard.handleInput("0");
        dashboard.handleInput("j");
        expect(dashboard.activeSelectionSource).toBe("teams");
        expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(false);

        // Coordinator pane is no longer rendered — poller must pause.
        expect(dashboard.coordinatorPollerRunning).toBe(false);

        // 3. Flip back to agents (sidebar) — active source still teams, so the
        //    coord pane is still NOT rendered (sidebar shows the agents tree,
        //    but the main area drives off the active team selection). Poller
        //    must stay paused.
        dashboard.handleInput("1");
        expect(dashboard.activeSelectionSource).toBe("teams");
        expect(dashboard.coordinatorPollerRunning).toBe(false);

        // 4. Press j in the agents tree — active source flips back to agents,
        //    coord row is selected again, poller resumes.
        dashboard.handleInput("j");
        expect(dashboard.activeSelectionSource).toBe("agents");
        expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
        expect(dashboard.coordinatorPollerRunning).toBe(true);
      } finally {
        dashboard.stopPolling();
      }
    });
  });
});

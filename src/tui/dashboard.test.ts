import { useAttachmentTemp } from "../test-attachment-temp";
import { test, expect, describe, beforeEach, afterEach, setDefaultTimeout, setSystemTime, mock, spyOn } from "bun:test";
import { join } from "path";
import { mkdirSync } from "fs";
import { mkdtemp, rm, mkdir, readdir, realpath, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { readAgentLog, readAgentFileWindow, readAgentPrompt, parseDenials } from "../agents";
import type { Agent, AgentMeta, FlatEntry, PendingQuestion } from "../agents";
import { stripAnsi } from "../parse-state";
import { makeAgent as _makeAgent, makeFlatAgent, makeFlatRepoHeader, makeFlatSystemCoordinator, setAgentState, makeSpawnResult, waitFor, waitForValue } from "../test-utils";
import { TmuxPaneComponent, RightPaneComponent, DashboardComponent, AgentTreeComponent, colorizeDiff, colorizeLog, formatAgentRow, formatFooterClock, usageFetchCtx, CODEX_LIVE_PROBE_INTERVAL_MS } from "./dashboard";
import type { CodexUsageReading, GeminiUsageResult } from "../usage";
import type { CodexLiveUsageResult } from "../codex-live-usage";
import { TUI, visibleWidth } from "@mariozechner/pi-tui";
import type { CollectorHealth } from "../sandbox-collector-light";
import type { RemoteControlStatus } from "../remote-control-light";
import { setSendSpawnRunner, resetSendSpawnRunner, setKillPauseSpawnRunner, resetKillPauseSpawnRunner, setNukeResumeSpawnRunner, resetNukeResumeSpawnRunner, setNewAgentSpawnRunner, resetNewAgentSpawnRunner, setNewAgentCallerMetaReader, resetNewAgentCallerMetaReader, setDiffStatusSpawnRunner, resetDiffStatusSpawnRunner, setMergeSpawnRunner, resetMergeSpawnRunner, sealAgentRecord } from "../ib-commands";
import { spawnCtx as lifecycleSpawnCtx } from "../agent-lifecycle";
import { spawnCtx as tmuxPollerSpawnCtx } from "../tmux-poller";
import { gitStatusSpawnCtx } from "../git-status";
import { IB_COORDINATOR_SESSION, setCoordinatorHome, resetCoordinatorHome } from "../coordinator";
import { setUserConfigPath, resetUserConfigPath } from "../config";
import { setUserHome, resetUserHome } from "../home";
import { cloneRepoSpawnCtx } from "../clone-repo";
import * as cloneRepoModule from "../clone-repo";
import type { SpawnFn, SpawnResult } from "../types";
import type { TeamFlatEntry } from "./teams-tree";
import { PANE_MODES, FULL_WIDTH_MODES, type PaneMode } from "./pane-manager";
import { computeSidebarHeights } from "./sidebar";
import { assertDialog } from "./test-helpers";
import { DIALOG_WIDTH, buildNewAgentFormContent, dialogTitleMaxWidth, elideLeft } from "./dialog-handler";
import { clonePrompt, newRepoPrompt } from "./agent-actions";
import { TypePickerKeyboard } from "./type-picker-keyboard";
import { setStagedSenderForTests, resetStagedSenderForTests } from "./message-send";
import { setLayoutPath, loadLayout, flushPendingSave, cancelPendingSave } from "./layout";
import type { PeersDialogService } from "./peers-dialog";
import type { PeerServiceView } from "../peers/service";
import { parsePairTarget, type PairStage } from "../peers/pairing";
import type { RemoteAgent, RemoteQuestion } from "../peers/peer-link";
import type { PeerLinkState } from "../peers/poller";
import { remoteTerminalSession, terminalWindowCtx } from "../peers/terminal-window";
import { peerEntryKey } from "./peer-repos";
import { keyOf as treeKeyOf, selectById } from "./test-tree-keys";
import { MIN_TERMINAL_WIDTH, REMOTE_READ_ONLY_NOTICE, REMOTE_RIGHT_PANE_TEXT, isRemoteAllowedKey } from "./dashboard";
import { BOLD, DIM, GREEN, ITALIC, RED, RESET, REVERSE, YELLOW } from "./colors";
import { setSandboxedProcessOverride } from "../sandbox-detect";
import { getStateColors } from "./color-scheme";
import * as settings from "../config";
import * as agentActions from "./agent-actions";
import * as ghostty from "../ghostty";
import * as paneManager from "./pane-manager";
import * as runtimeNames from "../runtime-names";
import { sweepDiffCopies } from "../peers/transfer-owner";

// Many tests below simulate resize keystrokes, which call persistLayout() and
// schedule debounced layout saves. Route them to a temp file so a test run can
// never clobber the user's real ~/.itsybitsy/layout.json. This backstops the
// NODE_ENV=test default in layout.ts in case NODE_ENV is overridden.
//
// Deliberately never reset: layoutPath is module state in ./layout, and every
// value it can hold from here is a tmpdir() path, so leaving the override in
// place for the rest of the run is strictly safer than restoring the default.
// bun runs test files sequentially in one process, so no concurrently-running
// file can flip it back mid-file either. See also the cancelPendingSave() in
// the file-scope afterEach below, which stops a debounced write from outliving
// the test that scheduled it.
setLayoutPath(join(tmpdir(), `itsybitsy-layout-dashboard-test-${process.pid}.json`));

// FAILURE BOUND, not a wait: this caps how long a *stuck* test takes to report,
// and no test waits on it — every wait below polls a real condition and returns
// the moment it holds. bun's 5s default was too tight even for this in-process
// file: under load (measured with 20 CPU burners) a single `setTimeout(0)` turn
// took seconds of wall-clock, and the 5s bound tripped in the middle of the
// pinned-width migration test. Raising it changes no assertion and does not slow
// a passing run. 30s matches the bound src/channels/outbox.test.ts uses and
// leaves >5x headroom over the worst overrun observed (5.6s).
setDefaultTimeout(30_000);

/**
 * Timeout for the condition waits in this file. Sits well under the 30s test
 * bound so a wait that never comes true fails with a message naming *what* it
 * was waiting for instead of losing the race to a generic "test timed out" —
 * and well above the worst observed under-load latency so a busy machine can
 * never expire it on a healthy run. Like the bound above, it only shapes the
 * failure path: a satisfied condition returns immediately.
 */
const WAIT_TIMEOUT_MS = 20_000;

/**
 * Helper: create a mock send spawn runner that records calls as {args, cwd}-style entries.
 *
 * Note the shape: the runner closes over the ARRAY INSTANCE it was handed, so
 * whatever it records lands in the array belonging to the test that installed
 * it. A recorder that instead re-read a describe-scoped `let` at push time
 * would append to whichever array is current *when the call happens* — which,
 * for work that outlives its test, is the next test's freshly-emptied fixture.
 * Every recorder in this file follows this instance-capturing shape.
 */
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
  const agent = _makeAgent({ id, repoPath, archived });
  agent.meta.tmux_session = `itsybitsy-abcdef01-${id}`;
  return agent;
}

/**
 * Every dashboard makeDashboard() built during the CURRENT test, so the
 * file-scope afterEach can stop it. See that hook for why this exists.
 */
const dashboardsThisTest: DashboardComponent[] = [];

/** Create a DashboardComponent with setTerminalTitle stubbed to prevent test output noise. */
function makeDashboard(): DashboardComponent {
  const d = new DashboardComponent();
  d.setTerminalTitle = () => {};
  dashboardsThisTest.push(d);
  return d;
}

/**
 * startPolling() runs the status-bar usage fetchers, which read the real
 * ~/.itsybitsy and ~/.codex (and fetchGeminiUsage can run agy). Every test
 * starts with inert ones; a usage-polling test installs its own in its body.
 */
beforeEach(() => {
  usageFetchCtx.set({
    readClaudeUsage: async () => ({ data: null, error: false }),
    fetchGeminiUsage: async () => ({ data: null, error: false }),
    readCodexLogUsage: async () => null,
    fetchCodexLiveUsage: async () => ({ reading: null, error: "inert test fetcher" }),
  });
});

/**
 * Stop everything the finished test left running. Runs after EVERY test in this
 * file — including one that failed or timed out, which is the case that matters.
 *
 * A dashboard starts interval timers on its own: selecting the system
 * coordinator (a plain `onUpdate([], [makeFlatSystemCoordinator()], [])`, no
 * startPolling() required) runs syncSelectedAgent → updatePollerVisibility,
 * which resumes the 1s coordinator TmuxPoller and starts the 3s coordinator
 * client-attach check. Nothing in a `const d = makeDashboard()` test ever
 * stopped them, so those timers ran for the rest of the process. Two
 * consequences, both real:
 *
 *  - Cross-test contamination. Every tick calls through the tmux spawn context.
 *    A dashboard from an earlier test therefore records `list-clients` /
 *    `resize-window` calls into a LATER test's mock — a fixture that test
 *    believes only it can write to.
 *  - Escaping the test process. Once the mock is reset the same ticks reach the
 *    real Bun.spawn and run `tmux capture-pane` / `list-clients` against the
 *    user's live `ib-coordinator` session, once a second, forever.
 *
 * Stopping the dashboards makes both structurally impossible rather than
 * merely unlikely. stopPolling() only clears timers (it spawns nothing), so it
 * is safe regardless of hook ordering relative to a describe's own afterEach,
 * and it is a no-op on a dashboard that never started polling.
 */
afterEach(() => {
  for (const d of dashboardsThisTest.splice(0)) {
    d.stopPolling();
  }
  usageFetchCtx.reset();
  // persistLayout() debounces a 500ms write in ./layout module state. A test
  // that pressed a resize key leaves that timer armed; cancel it so the write
  // cannot land during an unrelated later test. Tests that need the write to
  // happen await flushPendingSave() inside the test body, before this runs.
  cancelPendingSave();
});

describe("readAgentLog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads agent.log for active agent", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "line one\nline two\nline three");

    const agent = makeAgent("agent-abc", tmpDir, false);
    const lines = await readAgentLog(agent);
    expect(lines).toEqual(["line one", "line two", "line three"]);
  });

  test("reads agent.log for archived agent", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "archive", "agent-xyz");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "archived log");

    const agent = makeAgent("agent-xyz", tmpDir, true);
    const lines = await readAgentLog(agent);
    expect(lines).toEqual(["archived log"]);
  });

  test("returns placeholder when agent.log does not exist", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-nolog");
    await mkdir(agentDir, { recursive: true });

    const agent = makeAgent("agent-nolog", tmpDir, false);
    const lines = await readAgentLog(agent);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("No agent.log found");
  });

  test("returns placeholder when agent.log is empty", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-empty");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "");

    const agent = makeAgent("agent-empty", tmpDir, false);
    const lines = await readAgentLog(agent);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("empty");
  });
});

describe("readAgentFileWindow (agent.log)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns the entire file when small (atTop=true)", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-small");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "line one\nline two\nline three");

    const agent = makeAgent("agent-small", tmpDir, false);
    const win = await readAgentFileWindow(agent, "agent.log", { rows: 20, scrollOffset: 0 });
    expect(win.atTop).toBe(true);
    expect(win.isPlaceholder).toBe(false);
    expect(win.lines).toEqual(["line one", "line two", "line three"]);
    expect(win.fileSize).toBeGreaterThan(0);
  });

  test("drops partial first line when window starts past BOF", async () => {
    // Build a log large enough that the default window won't cover it from the top.
    // Each line is ~250 chars (over the 200 estimate) so 1000 lines is ~250KB.
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-big");
    await mkdir(agentDir, { recursive: true });
    const filler = "x".repeat(240);
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) lines.push(`line${String(i).padStart(4, "0")}-${filler}`);
    await Bun.write(join(agentDir, "agent.log"), lines.join("\n"));

    const agent = makeAgent("agent-big", tmpDir, false);
    // rows=20, scrollOffset=0 → desiredLines=60, desiredBytes=12000 → much smaller than file
    const win = await readAgentFileWindow(agent, "agent.log", { rows: 20, scrollOffset: 0 });
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
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-scroll");
    await mkdir(agentDir, { recursive: true });
    const filler = "x".repeat(240);
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) lines.push(`line${String(i).padStart(4, "0")}-${filler}`);
    await Bun.write(join(agentDir, "agent.log"), lines.join("\n"));

    const agent = makeAgent("agent-scroll", tmpDir, false);
    const small = await readAgentFileWindow(agent, "agent.log", { rows: 20, scrollOffset: 0 });
    const large = await readAgentFileWindow(agent, "agent.log", { rows: 20, scrollOffset: 200 });
    // Bigger scrollOffset must produce a larger window (or atTop)
    expect(large.lines.length).toBeGreaterThan(small.lines.length);
    // Both should still end at the last line
    expect(small.lines[small.lines.length - 1]).toBe(lines[lines.length - 1]);
    expect(large.lines[large.lines.length - 1]).toBe(lines[lines.length - 1]);
  });

  test("returns 'No agent.log found' when file does not exist", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-missing");
    await mkdir(agentDir, { recursive: true });
    const agent = makeAgent("agent-missing", tmpDir, false);
    const win = await readAgentFileWindow(agent, "agent.log", { rows: 20, scrollOffset: 0 });
    expect(win.isPlaceholder).toBe(true);
    expect(win.fileSize).toBe(0);
    expect(win.atTop).toBe(true);
    expect(win.lines[0]).toContain("No agent.log found");
  });

  test("returns 'agent.log is empty' for zero-byte file", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-empty2");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "");
    const agent = makeAgent("agent-empty2", tmpDir, false);
    const win = await readAgentFileWindow(agent, "agent.log", { rows: 20, scrollOffset: 0 });
    expect(win.isPlaceholder).toBe(true);
    expect(win.fileSize).toBe(0);
    expect(win.lines[0]).toContain("empty");
  });

  test("works for archived agents", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "archive", "agent-arc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "agent.log"), "old line one\nold line two");
    const agent = makeAgent("agent-arc", tmpDir, true);
    const win = await readAgentFileWindow(agent, "agent.log", { rows: 20, scrollOffset: 0 });
    expect(win.atTop).toBe(true);
    expect(win.lines).toEqual(["old line one", "old line two"]);
  });

  test("returns 'line too long' placeholder when window covers a single oversized line", async () => {
    // Build a file where the trailing line is longer than any reasonable
    // tail-window byte budget. The first line is short so we have a clear
    // partial-line cut after the newline.
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-bigline");
    await mkdir(agentDir, { recursive: true });
    // 50KB single line (well over the default 8KB minimum read).
    const huge = "z".repeat(50_000);
    await Bun.write(join(agentDir, "agent.log"), `prefix-line\n${huge}`);
    const agent = makeAgent("agent-bigline", tmpDir, false);
    // Tiny rows/buffer → desiredBytes = 8192 < 50KB → tail starts mid-huge-line.
    const win = await readAgentFileWindow(agent, "agent.log", { rows: 5, scrollOffset: 0, bufferRows: 5 });
    expect(win.atTop).toBe(false);
    expect(win.isPlaceholder).toBe(true);
    // Not a stable missing/empty state, so callers must not cache it.
    expect(win.fileState).toBeUndefined();
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
      "  gpt-5.5 default · ~/Developer/muse/muse-ios/.itsybitsy/agents/agent-c8fc00e0/repo",
      "",
      "",
    ].join("\n");

    pane.parseStatusLines(120);
    expect(pane.statusLines).toEqual([
      "  gpt-5.5 default · ~/Developer/muse/muse-ios/.itsybitsy/agents/agent-c8fc00e0/repo",
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
      "codex-snapshot-input-fail-5.txt",
      "codex-snapshot-input-fail-6.txt",
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

describe("TmuxPaneComponent word-wrap + memoization", () => {
  test("getWrapped word-wraps -J logical lines to the pane width", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-wrap", "/tmp/test");
    // A single long logical line (as tmux -J returns it) with spaces — word-wrap
    // must break at spaces, and every output row must be within width.
    pane.rawOutput =
      "the quick brown fox jumps over the lazy dog and then keeps running down the road for a while";
    const width = 20;
    const wrapped = pane.getWrapped(width);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const row of wrapped) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
    // Word-wrap (not char-wrap): no word straddles a row boundary.
    expect(wrapped.join(" ").replace(/\s+/g, " ").trim()).toBe(pane.rawOutput);
  });

  test("getWrapped returns the SAME array on a cache hit (same raw + width)", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-memo", "/tmp/test");
    pane.rawOutput = "some output line that is long enough to wrap at a narrow width here";
    const first = pane.getWrapped(20);
    const second = pane.getWrapped(20);
    // Identity check: a cache hit must not recompute (returns the memoized array).
    expect(second).toBe(first);
  });

  test("getWrapped recomputes on a width change (cache miss)", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-memo", "/tmp/test");
    pane.rawOutput = "some output line that is long enough to wrap at a narrow width here";
    const atTwenty = pane.getWrapped(20);
    const atForty = pane.getWrapped(40);
    expect(atForty).not.toBe(atTwenty);
    // And re-requesting width 20 recomputes (the memo only holds the latest).
    const atTwentyAgain = pane.getWrapped(20);
    expect(atTwentyAgain).not.toBe(atTwenty);
  });

  test("getWrapped recomputes when rawOutput content changes (cache miss)", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-memo", "/tmp/test");
    pane.rawOutput = "first output";
    const first = pane.getWrapped(20);
    // Each poll assigns fresh content; `raw === this.rawOutput` (string value
    // equality) busts the cache when the captured text differs.
    pane.rawOutput = "second output entirely different";
    const second = pane.getWrapped(20);
    expect(second).not.toBe(first);
    expect(second).not.toEqual(first);
  });

  test("resetForAgent clears the wrap cache", () => {
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-memo", "/tmp/test");
    const raw = "some output line that is long enough to wrap at a narrow width here";
    pane.rawOutput = raw;
    const before = pane.getWrapped(20);
    pane.resetForAgent();
    // rawOutput is now "" — restore the SAME string object; the cache was
    // cleared so this must recompute rather than return the stale array.
    pane.rawOutput = raw;
    const after = pane.getWrapped(20);
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });

  test("a linked status line cut at the pane width closes its link", () => {
    const sep = "─".repeat(1000);
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-claude", "/tmp/test");
    pane.hasPolled = true;
    pane.displayHeight = 20;
    pane.trimInputSeparator = true;
    pane.rawOutput = [
      "⏺ Reply",
      sep,
      "❯ ",
      sep,
      `  \x1b]8;;https://example.com/pull/1\x07${"x".repeat(100)}\x1b]8;;\x07`,
      "",
    ].join("\n");

    pane.parseStatusLines(40);

    expect(pane.statusLines).toHaveLength(1);
    expect(pane.statusLines[0]!).toContain("\x1b]8;;https://example.com/pull/1\x07");
    expect(pane.statusLines[0]!.endsWith("\x1b]8;;\x07")).toBe(true);
    expect(stripAnsi(pane.statusLines[0]!).length).toBeLessThanOrEqual(40);
  });

  test("render and parseStatusLines share the same memoized wrap (Claude chrome)", () => {
    // Claude input chrome: two ─ separator lines with a status bar below. Both
    // render() and parseStatusLines() must wrap identically so the status-line
    // detection lines up with the rendered output.
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-claude", "/tmp/test");
    pane.hasPolled = true;
    pane.displayHeight = 20;
    pane.trimInputSeparator = true;
    pane.rawOutput = [
      "⏺ Done with the task.",
      "",
      "────────────────────",
      "❯ ",
      "────────────────────",
      "  ⏵⏵ accept edits on · 2 background tasks",
      "",
    ].join("\n");

    const width = 60;
    pane.parseStatusLines(width);
    // Status line (below the lower separator) is surfaced for our input overlay.
    const statusJoined = pane.statusLines.map((l) => stripAnsi(l)).join("\n");
    expect(statusJoined).toContain("accept edits on");

    const rendered = pane.render(width).map((l) => stripAnsi(l)).join("\n");
    // The Claude input chrome (separators + prompt + status bar) is trimmed.
    expect(rendered).toContain("Done with the task.");
    expect(rendered).not.toContain("accept edits on");
  });

  test("PINNED-width Claude chrome: a 1000-col separator is detected on logical lines, never leaks into the narrow-pane render", () => {
    // The pinned-tmux-width scenario this whole feature targets: at width 1000
    // the input-box separators are SINGLE ~1000-col logical lines. Rendering the
    // pane at a narrow display width (80) must still (a) trim the input chrome
    // and (b) never show a row of ─ separators — which is exactly what happened
    // when chrome was detected AFTER word-wrapping (the 1000-col separator
    // exploded into ~13 rows and mis-sliced).
    const sep = "─".repeat(1000);
    const pane = new TmuxPaneComponent();
    pane.agent = makeAgent("agent-claude", "/tmp/test");
    pane.hasPolled = true;
    pane.displayHeight = 20;
    pane.trimInputSeparator = true;
    pane.rawOutput = [
      "⏺ Finished a long reply that itself stays well under the pinned width.",
      "",
      sep,
      "❯ ",
      sep,
      "  ⏵⏵ accept edits on · 2 background tasks",
      "",
    ].join("\n");

    const width = 80;
    pane.parseStatusLines(width);
    // Status line surfaced (chrome), truncated to width — never wrapped.
    expect(pane.statusLines.every((l) => stripAnsi(l).length <= width)).toBe(true);
    expect(pane.statusLines.map((l) => stripAnsi(l)).join("\n")).toContain("accept edits on");

    const renderedLines = pane.render(width).map((l) => stripAnsi(l));
    const rendered = renderedLines.join("\n");
    expect(rendered).toContain("Finished a long reply");
    expect(rendered).not.toContain("accept edits on");
    // No rendered row is an all-─ separator row, and every row is within width.
    for (const line of renderedLines) {
      expect(/^─+$/.test(line.trim())).toBe(false);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("PINNED-width codex chrome: › prompt + status bar detected on logical lines at a narrow pane", () => {
    const bigDivider = "─".repeat(1000); // codex content divider, NOT the input box
    const codexStatus = "gpt-5-codex · ~/proj · Context 42% · 3h left";
    const pane = new TmuxPaneComponent();
    // makeAgent defaults to a claude model; force a codex model so isCodexAgent()
    // routes through the codex chrome detector.
    const agent = makeAgent("agent-codex", "/tmp/test");
    agent.meta.model = "codex:gpt-5-codex";
    pane.agent = agent;
    pane.hasPolled = true;
    pane.displayHeight = 20;
    pane.trimInputSeparator = true;
    pane.rawOutput = [
      "codex: produced some transcript output above the input box",
      bigDivider,
      "› ",
      codexStatus,
    ].join("\n");

    const width = 70;
    pane.parseStatusLines(width);
    expect(pane.statusLines.map((l) => stripAnsi(l)).join("\n")).toContain("Context 42%");
    expect(pane.statusLines.every((l) => stripAnsi(l).length <= width)).toBe(true);

    const renderedLines = pane.render(width).map((l) => stripAnsi(l));
    expect(renderedLines.join("\n")).toContain("transcript output above the input box");
    // The status bar (chrome) is trimmed from the transcript render.
    expect(renderedLines.join("\n")).not.toContain("Context 42%");
    for (const line of renderedLines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
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
  let lastIbCall: { args: string[]; cwd: string } | null = null;
  /** Tracks messages sent via native sendMessage (tmux send-keys) */
  let sentMessages: { target: string; message: string }[] = [];

  /**
   * Set up the send spawn runner mock that tracks messages. The runner captures
   * THIS test's array instead of re-reading `sentMessages` at push time, so a
   * send that outlives its test can only append to its own recording — see
   * mockSendSpawnRunner's note at the top of the file.
   */
  function setupSendMock() {
    const recorded: { target: string; message: string }[] = [];
    sentMessages = recorded;
    setSendSpawnRunner((cmd: string[]) => {
      // Track the actual message send-keys calls (not Enter or has-session)
      if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd.length === 7 && cmd[4] === "-l" && cmd[5] === "--") {
        // Extract target session and message
        const target = cmd[3]!;
        recorded.push({ target, message: cmd[6]! });
      }
      return makeSpawnResult();
    });
  }

  let actionTempDir: string | null = null;
  let configTempDir: string;
  // Writable repo root for send tests: sendMessage ENQUEUES to the agent's
  // flat outbox dir (`<coordinatorHome>/agents/<agent>/`). The recipient's
  // log and state writes go to the per-worktree agent dir, so send targets
  // need a real (writable) repoPath rather than a synthetic /repos/... path.
  // The coordinator home itself is pinned to configTempDir/coord-home in
  // beforeEach so the central queue stays inside the sandbox.
  let sendRepoDir: string;

  beforeEach(async () => {
    // Isolate user config — sendMessage reads `user.name` to format
    // human-driven sends. Without isolation tests pick up whatever's in the
    // developer's ~/.itsybitsy/config.json, so `[sent by user]` asserts
    // would break if user.name is set.
    configTempDir = await mkdtemp(join(tmpdir(), "dashboard-config-"));
    setUserConfigPath(join(configTempDir, "config.json"));
    sendRepoDir = await mkdtemp(join(tmpdir(), "dashboard-send-"));
    // The keyless fixtures use getCoordinatorHome() / agents / <agent>.
    // Without this isolation, dashboard sends from this test suite would
    // accumulate in the developer's real ~/.itsybitsy/agents/agent-test/
    // outbox.jsonl, then leak into the next test run when sendMessage drains
    // them inline (no live watchdog in test setup), inflating sentMessages.
    const { setCoordinatorHome } = await import("../coordinator");
    setCoordinatorHome(join(configTempDir, "coord-home"));
    // Agent seals belong to the fixture, not the developer's home directory.
    setUserHome(configTempDir);
    await Bun.write(join(configTempDir, ".itsybitsy", "machine-name"), "studio");
    await (await import("../agent-types")).ensureAgentTypesDir();
  });

  test("registry errors in repo settings surface a notice and leave failed notes available for retry", async () => {
    const repo = { path: "/repos/test", name: "test", defaultAgentType: "worker", notes: "before" };
    const registry = join(configTempDir, ".itsybitsy", "repos.json");
    const view = makeDashboard();
    view.setRepos([repo]);
    view.onUpdate([], [makeFlatRepoHeader("test", repo.path, false, false, false)], [], []);
    expect(view.agentTree.selectByRepoPath(repo.path)).toBe(true);
    view.syncSelectedAgent();
    await Bun.write(registry, "{");
    view.handleInput("\t"); // focus the default type
    view.handleInput("\x7f"); // clear type
    await waitFor(() => view.notice?.includes(registry) === true);
    expect(repo.defaultAgentType).toBe("worker");
    view.setNotice("", "info");
    view.handleInput("\t"); // focus notes
    view.infoPanel.notesEditor.setText("new draft");
    view.handleInput("\x1b[Z"); // blur notes
    await waitFor(() => view.notice?.includes(registry) === true);
    expect(repo.notes).toBe("before");
    await Bun.write(registry, JSON.stringify({ repos: [repo] }));
    view.handleInput("\t");
    view.handleInput("\x1b[Z"); // retry the same draft
    await waitFor(async () => (await Bun.file(registry).json()).repos[0].notes === "new draft");
  });

  async function setupDashboardWithAgent(state = "running") {
    dashboard = makeDashboard();
    lastIbCall = null;

    // Create temp dir for native kill/pause operations
    actionTempDir = await mkdtemp(join(tmpdir(), "dashboard-action-"));
    const agentDir = join(actionTempDir, ".itsybitsy", "agents", "agent-test");
    await mkdir(agentDir, { recursive: true });
    // Mandatory sandbox: a resumable agent carries an enabled sandbox + paths.
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-test",
      tmux_session: "itsybitsy-abcdef01-agent-test",
      worktree: false,
      agentType: "manager",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    }));

    setupSendMock();

    // Mock spawn runners for native kill/pause/resume.
    // - pgrep → fail (no running process)
    // - has-session BEFORE new-session → fail (no live tmux, so resume guard passes)
    // - has-session AFTER new-session → succeed (resume's verify-before-nudge check)
    // - everything else → succeed
    let newSessionSeen = false;
    const spawnResult = (stdout: string, code: number): SpawnResult => ({
      stdout: new Response(stdout).body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(code),
    } as SpawnResult);
    const noopSpawn = (cmd: string[]) => {
      // Mandatory sandbox: resume runs prepareSandbox, so answer `which
      // sandbox-exec`, the compile lint, and the git common dir.
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return spawnResult("/usr/bin/sandbox-exec\n", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return spawnResult("", 0);
      if (cmd.includes("--git-common-dir")) return spawnResult(".git", 0);
      if (cmd[0] === "tmux" && cmd[1] === "new-session") {
        newSessionSeen = true;
        return spawnResult("", 0);
      }
      const isHasSession = cmd[0] === "tmux" && cmd.includes("has-session");
      const isPgrep = cmd.includes("pgrep");
      const code = isPgrep ? 1 : isHasSession ? (newSessionSeen ? 0 : 1) : 0;
      return spawnResult("", code);
    };
    setKillPauseSpawnRunner(noopSpawn);
    lifecycleSpawnCtx.set(noopSpawn);
    setNukeResumeSpawnRunner(noopSpawn);
    // Mock spawn runners for native diff/status and merge-check
    setDiffStatusSpawnRunner(() => makeSpawnResult());
    setMergeSpawnRunner(() => makeSpawnResult());

    const agent = makeAgent("agent-test", actionTempDir);
    agent.meta.worktree = false;
    // Mandatory sandbox: arm the in-memory agent (resume reads agent.meta) and
    // seal it so R-key resume clears the fail-closed precondition + seal-verify.
    agent.meta.sandbox = { enabled: true, rawAllow: [], domains: [] };
    agent.meta.paths = { allowRead: [], allowWrite: [], deny: [] };
    agent.meta.agentType = "manager";
    await sealAgentRecord(actionTempDir, "agent-test", agent.meta as unknown as Record<string, unknown>, agentDir);
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
    resetNewAgentSpawnRunner();
    resetUserConfigPath();
    // Reset the fixture home installed in beforeEach, including any override
    // made by individual new-agent tests, so it cannot leak into later tests.
    resetUserHome();
    const { resetCoordinatorHome } = await import("../coordinator");
    resetCoordinatorHome();
    if (actionTempDir) {
      await rm(actionTempDir, { recursive: true, force: true });
      actionTempDir = null;
    }
    await rm(configTempDir, { recursive: true, force: true });
    await rm(sendRepoDir, { recursive: true, force: true });
  });

  test("x key opens retire confirm dialog with button UI", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x");
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'confirm');
    expect(d.prompt).toContain("Retire agent");
    expect(d.prompt).toContain("agent-test");
    expect(d.confirmLabel).toBe("Retire");
    expect(d.focusedButton).toBe("cancel");
    const rendered = stripAnsi((dashboard as any).dialogOverlay.render(80).join("\n"));
    expect(rendered).toContain("[ Cancel ]   [ Retire ]");
    expect(rendered).not.toContain("[ ]");
    expect(rendered).not.toContain("Space to toggle");
  });

  test("retire confirm dialog: Enter on Retire button executes retire", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x");
    // focusedButton defaults to "cancel", Tab to Retire, then press Enter
    dashboard.handleInput("\t");
    expect(assertDialog(dashboard.dialog, 'confirm').focusedButton).toBe("confirm");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    // Dialog should be dismissed after native retire executes
    expect(dashboard.dialog).toBeNull();
    // Agent directory should be removed by teardown
    const agentDir = join(actionTempDir!, ".itsybitsy", "agents", "agent-test");
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
  });

  test.each(["repo header", "coordinator row"])("reset from the %s shows cleanup warnings even when respawn fails", async entry => {
    await setupDashboardWithAgent();
    const repo = { path: actionTempDir!, name: "project" };
    const agent = makeAgent("agent-test", repo.path);
    const key = "studio/project/agent-test";
    const agentDir = join(repo.path, ".itsybitsy", "agents", agent.id);
    agent.meta = {
      ...await Bun.file(join(agentDir, "meta.json")).json(),
      agentType: "repo-coordinator",
      prompt: "Coordinate work in this repository.",
      queue_key: key,
    };
    await sealAgentRecord(repo.path, agent.id, agent.meta as unknown as Record<string, unknown>, agentDir);
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(agent.meta));
    const leftover = join(configTempDir, "coord-home", "agents", key, "outbox.jsonl");
    await mkdir(leftover, { recursive: true });
    await Bun.write(join(configTempDir, ".itsybitsy", "repos.json"), "{");
    setNewAgentCallerMetaReader(() => null);
    setNewAgentSpawnRunner(() => makeSpawnResult(1));

    dashboard.setRepos([repo]);
    dashboard.setWatcher({ lastAgents: [agent], refresh: () => {}, setGroupByParent: () => {}, healthReports: new Map() } as any);
    dashboard.onUpdate([agent], [
      makeFlatRepoHeader(repo.name, repo.path, false, false, false),
      makeFlatAgent(agent),
    ], []);
    if (entry === "repo header") expect(dashboard.agentTree.selectByRepoPath(repo.path)).toBe(true);
    else expect(dashboard.agentTree.selectAgent(agent)).toBe(true);
    dashboard.syncSelectedAgent();
    try {
      dashboard.handleInput("R");
      await dashboard.flushPendingActions();
    } finally {
      resetNewAgentCallerMetaReader();
    }
    expect({ dialog: dashboard.dialog, notice: dashboard.notice }).toMatchObject({ dialog: { type: "cleanup-warnings" } });
    const dialog = assertDialog(dashboard.dialog, "cleanup-warnings");
    expect(dialog.text).toContain("Reset failed during respawn");
    expect(dialog.text).toContain(`could not unlink ${leftover}:`);
  });

  test.each([false, true])("reset from a repo header tears down only that repo's same-named coordinator (duplicate display names: %p)", async duplicateNames => {
    await setupDashboardWithAgent();
    const nickname = duplicateNames ? "shared" : undefined;
    const first = { path: join(actionTempDir!, "first", "project"), name: "first", nickname };
    const second = { path: join(actionTempDir!, "second", "project"), name: "second", nickname };
    await mkdir(first.path, { recursive: true });
    await mkdir(second.path, { recursive: true });

    // The registry path may have a different spelling from the watched path.
    const linkedParent = join(actionTempDir!, "linked");
    await mkdir(linkedParent);
    const linkedSecond = { ...second, path: join(linkedParent, "project") };
    await symlink(second.path, linkedSecond.path);

    async function plantCoordinator(repo: typeof first, repoId: string) {
      const repoPath = await realpath(repo.path);
      const agent = makeAgent("project", repoPath);
      agent.repoName = repo.nickname ?? repo.name;
      agent.repoRegistryName = repo.name;
      Object.assign(agent.meta, {
        agentType: "repo-coordinator",
        prompt: "Coordinate work in this repository.",
        worktree: false,
        sandbox: { enabled: false, rawAllow: [], domains: [] },
        tmux_session: `itsybitsy-${repoId}-project`,
        queue_key: `studio/${repo.name}/project`,
      });
      const metaPath = join(repoPath, ".itsybitsy", "agents", agent.id, "meta.json");
      await Bun.write(join(repoPath, ".itsybitsy", "repo-id"), repoId);
      await Bun.write(metaPath, JSON.stringify(agent.meta));
      return { agent, metaPath };
    }

    const a = await plantCoordinator(first, "a1b2c3d4");
    const b = await plantCoordinator(second, "e5f6a7b8");
    const agents = [a.agent, b.agent];
    const repos = [first, linkedSecond];
    await Bun.write(join(configTempDir, ".itsybitsy", "repos.json"), JSON.stringify({ repos }));
    dashboard.setRepos(repos);
    dashboard.setWatcher({ lastAgents: agents, refresh: () => {}, setGroupByParent: () => {}, healthReports: new Map() } as any);
    dashboard.onUpdate(agents, [
      makeFlatRepoHeader(a.agent.repoName, first.path, false, false, false, first.name),
      makeFlatAgent(a.agent),
      makeFlatRepoHeader(b.agent.repoName, linkedSecond.path, false, false, false, linkedSecond.name),
      makeFlatAgent(b.agent),
    ], []);
    expect(dashboard.agentTree.selectByRepoPath(linkedSecond.path)).toBe(true);
    dashboard.syncSelectedAgent();

    const kills: string[] = [];
    setNukeResumeSpawnRunner(cmd => {
      if (cmd[1] === "list-sessions") {
        return makeSpawnResult(0, agents.map(agent => agent.meta.tmux_session).join("\n"));
      }
      if (cmd[1] === "kill-session") kills.push(cmd[cmd.indexOf("-t") + 1]!);
      return makeSpawnResult();
    });
    setNewAgentSpawnRunner(() => makeSpawnResult(1)); // Stop the reset at respawn.
    setNewAgentCallerMetaReader(() => null);
    try {
      dashboard.handleInput("R");
      await dashboard.flushPendingActions();
    } finally {
      resetNewAgentCallerMetaReader();
    }
    expect(dashboard.notice).toContain("Reset failed during respawn");
    expect(await Bun.file(a.metaPath).json()).toEqual(a.agent.meta);
    expect(kills).toEqual([`=${b.agent.meta.tmux_session}:`]);
    const archive = join(b.agent.repoPath, ".itsybitsy", "archive");
    const entries = await readdir(archive);
    expect(entries).toHaveLength(1);
    expect(await Bun.file(join(archive, entries[0]!, "meta.json")).json()).toEqual(b.agent.meta);
  });

  test("cleanup warnings wait for a send draft opened while teardown runs", async () => {
    await setupDashboardWithAgent();
    const departing = dashboard.agentTree.selectedAgent!;
    const recipient = makeAgent("agent-recipient", sendRepoDir);
    dashboard.onUpdate([departing, recipient], [makeFlatAgent(departing), makeFlatAgent(recipient)], []);
    expect(dashboard.agentTree.selectAgent(departing)).toBe(true);
    dashboard.syncSelectedAgent();

    const leftover = join(configTempDir, "coord-home", "agents", departing.id, "outbox.jsonl");
    await mkdir(leftover, { recursive: true });
    const teardownStarted = Promise.withResolvers<void>();
    const finishProbe = Promise.withResolvers<number>();
    lifecycleSpawnCtx.set(cmd => {
      if (cmd[0] === "tmux" && cmd[1] === "has-session") {
        teardownStarted.resolve();
        return { ...makeSpawnResult(1), exited: finishProbe.promise };
      }
      return makeSpawnResult();
    });

    dashboard.handleInput("!");
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");
    await teardownStarted.promise;
    try {
      expect(dashboard.agentTree.selectAgent(recipient)).toBe(true);
      dashboard.syncSelectedAgent();
      dashboard.handleInput("s");
      const draft = assertDialog(dashboard.dialog, "textarea");
      for (const ch of "message in progress") dashboard.handleInput(ch);
      finishProbe.resolve(1);
      await dashboard.flushPendingActions();

      expect(dashboard.dialog).toBe(draft);
      expect(draft.buffer.getText()).toBe("message in progress");
      dashboard.handleInput("\x1b");
      await Promise.resolve();
      const warnings = assertDialog(dashboard.dialog, "cleanup-warnings");
      expect(warnings.text).toContain(`could not unlink ${leftover}:`);
    } finally {
      finishProbe.resolve(1);
    }
  });

  test.each([["x", "Retired"], ["m", "Merged"], ["!", "Nuked"]])("%s shows complete, scrollable cleanup warnings at 80 columns", async (key, summary) => {
    await setupDashboardWithAgent();
    if (key === "m") {
      await mkdir(join(actionTempDir!, ".itsybitsy", "agents", "agent-test", "repo"), { recursive: true });
    }
    const dir = join(configTempDir, "coord-home", "agents", "agent-test");
    const paths = ["outbox.jsonl", "claude-rate-limits.json"].map(name => join(dir, name));
    for (const path of paths) await mkdir(path, { recursive: true });

    dashboard.handleInput(key);
    await dashboard.flushPendingActions();
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    const dialog = assertDialog(dashboard.dialog, "cleanup-warnings");

    const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { value: 10, configurable: true });
    try {
      const render = () => ((dashboard as any).dialogOverlay.render(80) as string[])
        .slice(1, -2).map(row => stripAnsi(row).slice(3, -1).trimEnd());
      const rows = render();
      expect(rows[0]).toContain(summary);
      expect(paths.some(path => !rows.join("").includes(`could not unlink ${path}:`))).toBe(true);
      let stabilized = false;
      // Each additional wrapped row consumes at least one character or newline.
      for (let presses = 0; presses < dialog.text.length; presses++) {
        const offset = dialog.offset;
        dashboard.handleInput("j");
        const viewport = render();
        if (dialog.offset === offset) {
          stabilized = true;
          break;
        }
        rows.push(viewport.at(-1)!);
      }
      expect(stabilized).toBe(true);
      expect(dialog.offset).toBeGreaterThan(0);
      const text = rows.join("");
      for (const path of paths) expect(text).toContain(`could not unlink ${path}:`);
      dashboard.handleInput("\x1b");
      expect(dashboard.dialog).toBeNull();
    } finally {
      if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
      else Reflect.deleteProperty(process.stdout, "rows");
    }
  });

  test("retire confirm dialog: Enter on default Cancel dismisses", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x");
    expect(assertDialog(dashboard.dialog, 'confirm').focusedButton).toBe("cancel");
    dashboard.handleInput("\r");
    expect(dashboard.dialog).toBeNull();
    expect(lastIbCall).toBeNull();
  });

  test("retire confirm dialog: Tab cycles between buttons", async () => {
    await setupDashboardWithAgent();
    dashboard.handleInput("x");
    const d = assertDialog(dashboard.dialog, 'confirm');
    expect(d.focusedButton).toBe("cancel");
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("confirm");
    dashboard.handleInput("\t");
    expect(d.focusedButton).toBe("cancel");
  });

  test("retire confirm dialog: Escape cancels", async () => {
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
    const agentDir = join(actionTempDir!, ".itsybitsy", "agents", "agent-test");
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
    const agentDir = join(actionTempDir, ".itsybitsy", "agents", "agent-one");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-one",
      tmux_session: "itsybitsy-abcdef01-agent-one",
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
    const agentDir = join(actionTempDir!, ".itsybitsy", "agents", "agent-test");
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
    const agentDir = join(actionTempDir!, ".itsybitsy", "agents", "agent-test");
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
    const agentDir = join(actionTempDir!, ".itsybitsy", "agents", "agent-test");
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
    const metaPath = join(actionTempDir!, ".itsybitsy", "agents", "agent-test", "meta.json");
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
    const agentsDir = join(actionTempDir, ".itsybitsy", "agents");
    await mkdir(join(agentsDir, "agent-test"), { recursive: true });
    await mkdir(join(agentsDir, "agent-manager"), { recursive: true });
    await Bun.write(join(agentsDir, "agent-test", "meta.json"), JSON.stringify({
      id: "agent-test", tmux_session: "itsybitsy-abcdef01-agent-test", manager: "",
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
    await mkdir(join(actionTempDir!, ".itsybitsy", "agents", "agent-test", "repo"), { recursive: true });
    dashboard.handleInput("m");
    await dashboard.flushPendingActions();
    expect(assertDialog(dashboard.dialog, 'confirm').prompt).toContain("Merge agent-test");
    const dialog = assertDialog(dashboard.dialog, "confirm");
    expect(dialog.focusedButton).toBe("cancel");
    expect(dialog.checkbox).toEqual({ label: "Keep agent after merge", checked: false });
    const overlay = (dashboard as any).dialogOverlay;
    expect(stripAnsi(overlay.render(80).join("\n"))).toContain("[ ] Keep agent after merge");
    expect(stripAnsi(overlay.render(80).join("\n"))).toContain("Space to toggle");
    dashboard.handleInput("\x1b[Z");
    expect(dialog.focusedButton).toBe("checkbox");
    expect(overlay.render(80).join("\n")).toContain("\x1b[7m[ ] Keep agent after merge");
    dashboard.handleInput(" ");
    expect(stripAnsi(overlay.render(80).join("\n"))).toContain("[x] Keep agent after merge");
    dashboard.handleInput("\x1b");
    dashboard.handleInput("m");
    await dashboard.flushPendingActions();
    expect(assertDialog(dashboard.dialog, "confirm").checkbox?.checked).toBe(false);
  });

  for (const keep of [false, true]) {
    test(`merge confirmation ${keep ? "keeps the agent when checked" : "closes the agent by default"}`, async () => {
      await setupDashboardWithAgent();
      const agentDir = join(actionTempDir!, ".itsybitsy", "agents", "agent-test");
      await mkdir(join(agentDir, "repo"), { recursive: true });
      const commands: string[][] = [];
      setMergeSpawnRunner((cmd: string[]) => {
        commands.push(cmd);
        if (cmd.includes("log") && cmd.includes("--oneline")) return makeSpawnResult(0, "abc123 Agent change\n");
        if (cmd.includes("rev-parse") && cmd.includes("HEAD")) return makeSpawnResult(0, "a".repeat(40) + "\n");
        return makeSpawnResult();
      });
      dashboard.handleInput("m");
      await dashboard.flushPendingActions();
      if (keep) {
        dashboard.handleInput("\x1b[Z");
        dashboard.handleInput(" ");
        dashboard.handleInput("\x1b[Z");
      } else {
        dashboard.handleInput("\t");
      }
      dashboard.handleInput("\r");
      await dashboard.flushPendingActions();
      expect(dashboard.dialog).toBeNull();
      expect(dashboard.notice).toBe(keep
        ? "agent-test kept running: merge complete"
        : "Merged agent-test");
      expect(commands.some(cmd => cmd.includes("merge"))).toBe(true);
      expect(commands.some(cmd => cmd.includes("kill-session"))).toBe(!keep);
      expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(keep);
    });
  }

  // merge.pushAfterMerge (SPEC.md §3.4): a push that fails after the merge
  // leaves the merge done, and the header shows the failure as an alert.
  for (const keep of [false, true]) {
    test(`a ${keep ? "--keep" : "closing"} merge whose push fails shows the failure in red`, async () => {
      await setupDashboardWithAgent();
      const agentDir = join(actionTempDir!, ".itsybitsy", "agents", "agent-test");
      await mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(join(configTempDir, "config.json"), JSON.stringify({ merge: { pushAfterMerge: true } }));
      setSandboxedProcessOverride(() => false);
      const commands: string[][] = [];
      // Every git call is stubbed; `push` is rejected as git reports it.
      setMergeSpawnRunner((cmd: string[]) => {
        commands.push(cmd);
        if (cmd.includes("--show-current") || cmd.includes("symbolic-ref")) return makeSpawnResult(0, "main");
        if (cmd.includes("remote") && cmd.includes("-v")) return makeSpawnResult(0, "origin\t/remotes/origin.git (fetch)\norigin\t/remotes/origin.git (push)");
        if (cmd.includes("push")) {
          return makeSpawnResult(1, "", "To /remotes/origin.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/remotes/origin.git'\nhint: Updates were rejected because the remote contains work that you do not");
        }
        if (cmd.includes("log") && cmd.includes("--oneline")) return makeSpawnResult(0, "abc123 Agent change\n");
        if (cmd.includes("rev-parse") && cmd.includes("HEAD")) return makeSpawnResult(0, "a".repeat(40) + "\n");
        return makeSpawnResult();
      });
      try {
        dashboard.handleInput("m");
        await dashboard.flushPendingActions();
        if (keep) {
          dashboard.handleInput("\x1b[Z");
          dashboard.handleInput(" ");
          dashboard.handleInput("\x1b[Z");
        } else {
          dashboard.handleInput("\t");
        }
        dashboard.handleInput("\r");
        await dashboard.flushPendingActions();
        // The one-row notice drops git's `To <url>` and `hint:` lines, so the rejection shows.
        const notice = `${keep ? "agent-test kept running: merge complete" : "Merged agent-test"} · push failed: origin: ! [rejected]        main -> main (fetch first) · error: failed to push some refs to '/remotes/origin.git'`;
        expect(dashboard.notice).toBe(notice);
        expect(dashboard.render(200)[0]).toContain(`${RED}${notice}`);
        expect(dashboard.dialog).toBeNull();
        expect(commands).toContainEqual(["git", "-C", actionTempDir!, "push", "origin", "main"]);
        // The merge itself went ahead: a closing merge still closed the agent.
        expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(keep);
      } finally {
        setSandboxedProcessOverride(null);
      }
    });
  }

  test("keep merge with no new commits reports nothing to merge", async () => {
    await setupDashboardWithAgent();
    const agentDir = join(actionTempDir!, ".itsybitsy", "agents", "agent-test");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    dashboard.handleInput("m");
    await dashboard.flushPendingActions();
    dashboard.handleInput("\x1b[Z");
    dashboard.handleInput(" ");
    dashboard.handleInput("\x1b[Z");
    dashboard.handleInput("\r");
    await dashboard.flushPendingActions();
    expect(dashboard.notice).toBe("agent-test kept running: nothing to merge");
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
  });

  test("merge: merge-check failure shows error message", async () => {
    await setupDashboardWithAgent();
    // Create worktree dir so mergeCheckAgent passes that check
    await mkdir(join(actionTempDir!, ".itsybitsy", "agents", "agent-test", "repo"), { recursive: true });
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

  test("new-agent form: Kitty protocol Shift+Space cycles agent type backwards", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);

    dashboard.handleInput("a");
    const d = assertDialog(dashboard.dialog, 'new-agent-form');
    dashboard.handleInput("\t"); // focus agentType
    expect(d.focused).toBe("agentType");
    expect(d.agentType).toBe("manager");

    const types = d.availableTypes;
    expect(types.length).toBeGreaterThan(1);
    const managerIdx = types.indexOf("manager");
    // Kitty protocol Shift+Space: CSI 32;2u (space=32, shift modifier=2)
    const shiftSpace = "\x1b[32;2u";

    // Shift+Space steps backward once, wrapping to the end when at index 0
    dashboard.handleInput(shiftSpace);
    expect(d.agentType).toBe(types[(managerIdx - 1 + types.length) % types.length]!);
    expect(d.focused).toBe("agentType");

    // Space then Shift+Space is a round trip
    dashboard.handleInput(" ");
    expect(d.agentType).toBe("manager");
    dashboard.handleInput(" ");
    expect(d.agentType).toBe(types[(managerIdx + 1) % types.length]!);
    dashboard.handleInput(shiftSpace);
    expect(d.agentType).toBe("manager");

    // A full backward lap returns to manager
    for (let i = 0; i < types.length; i++) {
      dashboard.handleInput(shiftSpace);
    }
    expect(d.agentType).toBe("manager");
  });

  test("new-agent form: negotiates text-key reporting and restores it after Type loses focus", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);
    let flags = 7; // ProcessTerminal's initial Kitty flags
    const keyboard = new TypePickerKeyboard({
      kittyProtocolActive: true,
      write(sequence) {
        const match = sequence.match(/^\x1b\[=(\d+);([23])u$/)!;
        flags = match[2] === "2" ? flags | Number(match[1]) : flags & ~Number(match[1]);
      },
    }, () => dashboard.dialog?.type === "new-agent-form" && dashboard.dialog.focused === "agentType");
    const input = (data: string) => keyboard.handleInput(data, data => dashboard.handleInput(data));
    input("a");
    expect(flags).toBe(7);
    const d = assertDialog(dashboard.dialog, "new-agent-form");
    input("\t");
    expect(flags).toBe(31);
    d.agentType = d.availableTypes[0]!;
    // A terminal sends plain text unless report-all-keys is enabled.
    input(flags & 8 ? "\x1b[32;2;32u" : " ");
    expect(d.agentType).toBe(d.availableTypes.at(-1)!);
    input("\x1b[32;2:3u"); // release must not cycle a second time
    expect(d.agentType).toBe(d.availableTypes.at(-1)!);
    input("\x1b[32;1;32u"); // encoded plain Space still cycles forward
    expect(d.agentType).toBe(d.availableTypes[0]!);
    input("\x1b[9u"); // Tab to Prompt
    expect(d.focused).toBe("prompt");
    expect(flags).toBe(7);
    // Input may already be queued in the previous reporting mode.
    input("\x1b[97:65;2;65u");
    input("\x1b[32;2;32u");
    input("normal text");
    expect(d.buffer.getText()).toBe("A normal text");
    input("\x1b[9;2u"); // Shift+Tab back to Type
    expect(flags).toBe(31);
    input("\x1b[27u"); // Escape closes the form and restores reporting
    expect(dashboard.dialog).toBeNull();
    expect(flags).toBe(7);
  });

  test("new-agent form: Left/Right cycle without Kitty support", () => {
    dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);
    const writes: string[] = [];
    const keyboard = new TypePickerKeyboard({ kittyProtocolActive: false, write: data => { writes.push(data); } },
      () => dashboard.dialog?.type === "new-agent-form" && dashboard.dialog.focused === "agentType");
    const input = (data: string) => keyboard.handleInput(data, data => dashboard.handleInput(data));
    input("a");
    input("\t");
    const d = assertDialog(dashboard.dialog, "new-agent-form");
    d.agentType = d.availableTypes[0]!;
    input("\x1b[D");
    expect(d.agentType).toBe(d.availableTypes.at(-1)!);
    input("\x1b[C");
    expect(d.agentType).toBe(d.availableTypes[0]!);
    expect(d.focused).toBe("agentType");
    expect(writes).toEqual([]);
  });

  // Relies on the form's Type cycle for the embedded spawnable types being
  // [manager, worker, repo-coordinator] (repo-coordinator is always last in the
  // form), so a single Space press from the default focus advances the
  // selection from manager to worker. Isolates the home directory (via
  // setUserHome) so the cycle reads only the embedded layer files
  // (developer-customized ~/.itsybitsy/agent-types/ would otherwise inject
  // extra spawnable types between manager and worker).
  test("new-agent form: cycling from manager to worker creates agent with worker meta field", async () => {
    const newAgentTempDir = await mkdtemp(join(tmpdir(), "ib-na-test-"));
    await mkdir(join(newAgentTempDir, ".itsybitsy"), { recursive: true });
    await Bun.write(join(newAgentTempDir, ".itsybitsy", "repo-id"), "abcd1234\n");
    setUserConfigPath(join(newAgentTempDir, "config.json"));
    await Bun.write(join(newAgentTempDir, "config.json"), JSON.stringify({ model: "claude:sonnet" }));

    const tempHome = await mkdtemp(join(tmpdir(), "ib-na-home-"));
    setUserHome(tempHome);
    // Populate the temp home with embedded defaults so the form's Type cycle is
    // exactly [manager, worker, repo-coordinator] (system-coordinator / _all /
    // _non_coordinator are filtered out as spawnable: false).
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
      if (cmdStr.includes("--git-common-dir --git-dir --show-toplevel")) return makeResult(`.git\n.git\n${newAgentTempDir}`, 0);
      if (cmdStr.includes("--git-common-dir") || cmdStr.includes("--git-dir")) return makeResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeResult(newAgentTempDir, 0);
      if (cmdStr.includes("which gh")) return makeResult("", 1);
      if (cmd[cmd.length-1] === "remote") return makeResult("", 0);
      if (cmdStr.includes("capture-pane")) return makeResult("Claude Code v1.0", 0);
      return makeResult("", 0);
    };
    setNewAgentSpawnRunner(mockSpawn);
    setNewAgentCallerMetaReader(() => null);
    lifecycleSpawnCtx.set(mockSpawn);

    dashboard = makeDashboard();
    dashboard.setRepos([{ path: newAgentTempDir, name: "only-repo" }]);

    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    expect(form.availableTypes).toEqual(["manager", "worker", "repo-coordinator"]);
    dashboard.handleInput("\t");
    dashboard.handleInput(" "); // manager → worker
    expect(form.agentType).toBe("worker");
    dashboard.handleInput("\t");
    for (const ch of "do stuff") dashboard.handleInput(ch);
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");

    await dashboard.flushPendingActions();

    // Find the created agent's meta.json
    const agentsDir = join(newAgentTempDir, ".itsybitsy", "agents");
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
    resetUserHome();
    await rm(newAgentTempDir, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  });

  test("new-agent form: repo-coordinator is last in the Type cycle even when custom types sort after it", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "ib-na-order-home-"));
    setUserHome(tempHome);
    try {
      const { ensureAgentTypesDir, listSpawnableTypeNamesSync } = await import("../agent-types");
      await ensureAgentTypesDir();
      // Both names sort after "repo-coordinator" alphabetically.
      const typesDir = join(tempHome, ".itsybitsy", "agent-types");
      await Bun.write(join(typesDir, "researcher.md"), "---\nname: researcher\ndescription: r\ncanSpawnChildren: false\n---\nbody");
      await Bun.write(join(typesDir, "zeta.md"), "---\nname: zeta\ndescription: z\ncanSpawnChildren: false\n---\nbody");

      // The shared list stays alphabetical (ib list-types and the info panel use it)...
      expect(listSpawnableTypeNamesSync()).toEqual(["manager", "repo-coordinator", "researcher", "worker", "zeta"]);

      // ...but the new-agent form puts the per-repo coordinator last.
      dashboard = makeDashboard();
      dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);
      dashboard.handleInput("a");
      const form = assertDialog(dashboard.dialog, "new-agent-form");
      expect(form.availableTypes).toEqual(["manager", "researcher", "worker", "zeta", "repo-coordinator"]);
      expect(form.agentType).toBe("manager");
    } finally {
      resetUserHome();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("new-agent form: Name field passes --name flag", async () => {
    const newAgentTempDir = await mkdtemp(join(tmpdir(), "ib-na-test-"));
    await mkdir(join(newAgentTempDir, ".itsybitsy"), { recursive: true });
    await Bun.write(join(newAgentTempDir, ".itsybitsy", "repo-id"), "abcd1234\n");
    setUserConfigPath(join(newAgentTempDir, "config.json"));
    await Bun.write(join(newAgentTempDir, "config.json"), JSON.stringify({ model: "claude:sonnet" }));

    // Isolate from the developer's real ~/.itsybitsy/ so the agent-type layer
    // files (and any `model:` they declare) come from embedded defaults rather
    // than the host install. Without this, the spawn would read the user's
    // possibly-stale ~/.itsybitsy/agent-types/_all.md and a bare-name `model:`
    // there would be rejected by parseModel (D1/D5).
    const tempHome = await mkdtemp(join(tmpdir(), "ib-na-home-"));
    setUserHome(tempHome);
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
      if (cmdStr.includes("--git-common-dir --git-dir --show-toplevel")) return makeResult(`.git\n.git\n${newAgentTempDir}`, 0);
      if (cmdStr.includes("--git-common-dir") || cmdStr.includes("--git-dir")) return makeResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeResult(newAgentTempDir, 0);
      if (cmdStr.includes("which gh")) return makeResult("", 1);
      if (cmd[cmd.length-1] === "remote") return makeResult("", 0);
      if (cmdStr.includes("capture-pane")) return makeResult("Claude Code v1.0", 0);
      return makeResult("", 0);
    };
    setNewAgentSpawnRunner(mockSpawn);
    setNewAgentCallerMetaReader(() => null);
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

    const meta = await Bun.file(join(newAgentTempDir, ".itsybitsy", "agents", "my-agent", "meta.json")).json();
    expect(meta.id).toBe("my-agent");
    expect(meta.prompt).toBe("do stuff");

    resetNewAgentSpawnRunner();
    lifecycleSpawnCtx.reset();
    resetUserConfigPath();
    resetUserHome();
    await rm(newAgentTempDir, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  });

  // SPEC §17.1 Favorites tab: an agent made from the Favorites tab becomes a
  // favorite (and is persisted); one made from the Agents or Teams tab does not,
  // and neither does a coordinator (it has no Agents-tree row).
  for (const [tabKey, tab, agentType, expectFavorite] of [
    ["3", "favorites", "manager", true],
    ["1", "agents", "manager", false],
    ["2", "teams", "manager", false],
    ["3", "favorites", "repo-coordinator", false],
  ] as const) {
    test(`new-agent form: a ${agentType} made from the ${tab} tab ${expectFavorite ? "is" : "is not"} a favorite`, async () => {
      const newAgentTempDir = await mkdtemp(join(tmpdir(), "ib-na-fav-"));
      await mkdir(join(newAgentTempDir, ".itsybitsy"), { recursive: true });
      await Bun.write(join(newAgentTempDir, ".itsybitsy", "repo-id"), "abcd1234\n");
      setUserConfigPath(join(newAgentTempDir, "config.json"));
      await Bun.write(join(newAgentTempDir, "config.json"), JSON.stringify({ model: "claude:sonnet" }));

      const tempHome = await mkdtemp(join(tmpdir(), "ib-na-fav-home-"));
      setUserHome(tempHome);
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
        // The kernel sandbox is on by default: answer its preflight (`which
        // sandbox-exec` + the profile compile lint) so the spawn succeeds.
        if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeResult("/usr/bin/sandbox-exec\n", 0);
        if (cmd[0] === "/usr/bin/sandbox-exec") return makeResult("", 0);
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
        if (cmdStr.includes("--git-common-dir --git-dir --show-toplevel")) return makeResult(`.git\n.git\n${newAgentTempDir}`, 0);
        if (cmdStr.includes("--git-common-dir") || cmdStr.includes("--git-dir")) return makeResult(".git", 0);
        if (cmdStr.includes("--show-toplevel")) return makeResult(newAgentTempDir, 0);
        if (cmdStr.includes("which gh")) return makeResult("", 1);
        if (cmd[cmd.length-1] === "remote") return makeResult("", 0);
        if (cmdStr.includes("capture-pane")) return makeResult("Claude Code v1.0", 0);
        return makeResult("", 0);
      };
      setNewAgentSpawnRunner(mockSpawn);
      setNewAgentCallerMetaReader(() => null);
      lifecycleSpawnCtx.set(mockSpawn);

      try {
        dashboard = makeDashboard();
        dashboard.setMachineName("studio");
        dashboard.setRepos([{ path: newAgentTempDir, name: "only-repo" }]);

        dashboard.handleInput(tabKey);
        expect(dashboard.sidebarMode).toBe(tab);
        dashboard.handleInput("a");
        assertDialog(dashboard.dialog, "new-agent-form").agentType = agentType;
        // Name left blank: the id is generated, so the favorite must be the id
        // newAgent returned, not anything typed in the form.
        dashboard.handleInput("\t");
        dashboard.handleInput("\t");
        for (const ch of "do stuff") dashboard.handleInput(ch);
        dashboard.handleInput("\t");
        dashboard.handleInput("\t");
        dashboard.handleInput("\r");

        await dashboard.flushPendingActions();

        const agentsDir = join(newAgentTempDir, ".itsybitsy", "agents");
        const { readdir: rd } = await import("fs/promises");
        const agentDirs = (await rd(agentsDir, { withFileTypes: true })).filter(e => e.isDirectory());
        expect(agentDirs.length).toBe(1);
        const meta = await Bun.file(join(agentsDir, agentDirs[0]!.name, "meta.json")).json();
        expect(meta.agentType).toBe(agentType);
        // meta.json is written before the late spawn steps — only the notice
        // shows that newAgent returned ok.
        expect(dashboard.notice).toBe("Created new agent in only-repo");
        // The favorite is the new agent's fully qualified id: machine/repo/id.
        const fullId = `studio/only-repo/${meta.id}`;
        expect([...dashboard.agentTree.favoriteAgentIds]).toEqual(expectFavorite ? [fullId] : []);
        if (expectFavorite) {
          await flushPendingSave();
          expect((await loadLayout())!.favoriteAgentIds).toEqual([fullId]);
        }
      } finally {
        cancelPendingSave();
        resetNewAgentCallerMetaReader();
        resetNewAgentSpawnRunner();
        lifecycleSpawnCtx.reset();
        resetUserConfigPath();
        resetUserHome();
        await rm(newAgentTempDir, { recursive: true, force: true });
        await rm(tempHome, { recursive: true, force: true });
      }
    });
  }

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

  test("new-agent form: stays open and shows notice when spawn fails", async () => {
    const newAgentTempDir = await mkdtemp(join(tmpdir(), "ib-na-fail-"));
    await mkdir(join(newAgentTempDir, ".itsybitsy"), { recursive: true });
    await Bun.write(join(newAgentTempDir, ".itsybitsy", "repo-id"), "deadbeef\n");
    setUserConfigPath(join(newAgentTempDir, "config.json"));
    await Bun.write(join(newAgentTempDir, "config.json"), JSON.stringify({ model: "claude:sonnet" }));

    const tempHome = await mkdtemp(join(tmpdir(), "ib-na-fail-home-"));
    setUserHome(tempHome);
    await (await import("../agent-types")).ensureAgentTypesDir();

    // Mock spawn so the dirty-worktree gate fires: porcelain returns a dirty
    // status line, which makes newAgent() return ok: false. checkTargetWorktreeClean
    // drains stdout/stderr concurrently via Promise.all, so we must enqueue real
    // streams (the default makeSpawnResult only fakes exited/stdout).
    const mockSpawn = (cmd: string[]): SpawnResult => {
      const cmdStr = cmd.join(" ");
      const makeResult = (s: string, c: number) => ({
        stdout: new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode(s)); ctrl.close(); } }),
        stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
        exited: Promise.resolve(c),
      });
      if (cmdStr.includes("is-inside-work-tree")) return makeResult("true\n", 0);
      if (cmdStr.includes("status --porcelain")) return makeResult(" M dirty-file.ts\n", 0);
      if (cmdStr.includes("--git-common-dir --git-dir --show-toplevel")) return makeResult(`.git\n.git\n${newAgentTempDir}`, 0);
      if (cmdStr.includes("--git-common-dir") || cmdStr.includes("--git-dir")) return makeResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeResult(newAgentTempDir, 0);
      if (cmdStr.includes("worktree add")) return makeResult("fatal: simulated failure\n", 1);
      return makeResult("", 0);
    };
    setNewAgentSpawnRunner(mockSpawn);
    setNewAgentCallerMetaReader(() => null);
    lifecycleSpawnCtx.set(mockSpawn);

    dashboard = makeDashboard();
    dashboard.setRepos([{ path: newAgentTempDir, name: "only-repo" }]);

    dashboard.handleInput("a");
    // Tab through name→agentType→prompt, type something, tab to cancel→create, press enter
    dashboard.handleInput("\t"); // name → agentType
    dashboard.handleInput("\t"); // agentType → prompt
    for (const ch of "do stuff") dashboard.handleInput(ch);
    dashboard.handleInput("\t"); // prompt → cancel
    dashboard.handleInput("\t"); // cancel → create
    dashboard.handleInput("\r"); // submit

    await dashboard.flushPendingActions();

    // Dialog must stay open so the user doesn't lose their prompt
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'new-agent-form');
    expect(d.buffer.getText()).toBe("do stuff");
    expect(dashboard.notice).toContain("New agent failed");

    resetNewAgentSpawnRunner();
    lifecycleSpawnCtx.reset();
    resetUserConfigPath();
    resetUserHome();
    await rm(newAgentTempDir, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
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
  // the target's flat outbox dir (`<coordinatorHome>/agents/<agent>/`), so
  // the send target needs both a real repoPath (for log/state writes) and a
  // pinned coordinator home (so the central queue dir resolves into the
  // sandbox, not the developer's real ~/.itsybitsy/).
  let sendRepoDir: string;

  /** Instance-capturing recorder — see mockSendSpawnRunner at the top of the file. */
  function setupSendMock() {
    const recorded: { target: string; message: string }[] = [];
    sentMessages = recorded;
    setSendSpawnRunner((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd.length === 7 && cmd[4] === "-l" && cmd[5] === "--") {
        recorded.push({ target: cmd[3]!, message: cmd[6]! });
      }
      return makeSpawnResult();
    });
  }

  beforeEach(async () => {
    sendRepoDir = await mkdtemp(join(tmpdir(), "dashboard-esend-"));
    // These keyless fixtures use getCoordinatorHome() / agents / <agent>.
    // Without this isolation, queued messages from the full-flow send test
    // would land in the developer's real ~/.itsybitsy/agents/agent-b/ and
    // leak into subsequent runs (sendMessage drains inline when no live
    // watchdog), inflating sentMessages.
    const { setCoordinatorHome } = await import("../coordinator");
    setCoordinatorHome(join(sendRepoDir, "coord-home"));
    setUserHome(sendRepoDir);
    await Bun.write(join(sendRepoDir, ".itsybitsy", "machine-name"), "studio");
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    const { resetCoordinatorHome } = await import("../coordinator");
    resetCoordinatorHome();
    resetUserHome();
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
    const msg = sentMessages.find((m) => m.target === "=itsybitsy-abcdef01-agent-b:");
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
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "prompt.txt"), "Do the thing\nLine 2");

    const agent = makeAgent("agent-abc", tmpDir, false);
    const lines = await readAgentPrompt(agent);
    expect(lines).toEqual(["Do the thing", "Line 2"]);
  });

  test("falls back to meta.prompt when prompt.txt missing", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });

    const agent = makeAgent("agent-abc", tmpDir, false);
    agent.meta.prompt = "meta prompt text";
    const lines = await readAgentPrompt(agent);
    expect(lines).toEqual(["meta prompt text"]);
  });

  test("reads from archive dir for archived agent", async () => {
    const agentDir = join(tmpDir, ".itsybitsy", "archive", "agent-old");
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

  /** Instance-capturing recorder — see mockSendSpawnRunner at the top of the file. */
  function setupSendMock() {
    const recorded: { target: string; message: string }[] = [];
    sentMessages = recorded;
    setSendSpawnRunner((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd.length === 7 && cmd[4] === "-l" && cmd[5] === "--") {
        recorded.push({ target: cmd[3]!, message: cmd[6]! });
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
    setUserHome(configTempDir);
    await Bun.write(join(configTempDir, ".itsybitsy", "machine-name"), "studio");
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetDiffStatusSpawnRunner();
    resetUserConfigPath();
    resetUserHome();
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
    // Wait for the load to actually finish rather than guessing at 50ms. The
    // load runs git in a subprocess, so its duration tracks how busy the
    // machine is; a fixed sleep asserts diffLoading===false while the load is
    // still in flight the moment the box is loaded enough.
    await waitFor(() => dashboard.rightPane.diffLoading === false, { message: "diff load to settle" });
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
      repoPath: "/repos/test",
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
      repoPath: "/repos/test",
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
    await mkdir(join(tempRepo, ".itsybitsy"), { recursive: true });
    const questionsPath = join(tempRepo, ".itsybitsy", "user-questions.json");
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
      repoPath: tempRepo,
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
    await mkdir(join(tempRepo, ".itsybitsy"), { recursive: true });
    const questionsPath = join(tempRepo, ".itsybitsy", "user-questions.json");
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
      repoPath: tempRepo,
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
      { id: "q-1", agent: "agent-a", question: "Q1?", timestamp: "2026-03-05T15:00:00Z", status: "pending", repoPath: "/repos/test" },
      { id: "q-2", agent: "agent-a", question: "Q2?", timestamp: "2026-03-05T15:01:00Z", status: "pending", repoPath: "/repos/test" },
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
      { id: "q-1", agent: "agent-a", question: "Q1?", timestamp: "2026-03-05T15:00:00Z", status: "pending", repoPath: "/repos/test" },
      { id: "q-2", agent: "agent-b", question: "Q2?", timestamp: "2026-03-05T15:01:00Z", status: "pending", repoPath: "/repos/test" },
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
      { id: "q-1", agent: "agent-a", question: "Q1?", timestamp: "2026-03-05T15:00:00Z", status: "pending", repoPath: "/repos/test" },
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

  test("g in QUESTIONS selects the question's agent", () => {
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
      repoPath: "/repos/test",
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

  test("a fresh dashboard starts on AGENT LOG (not PANE_MODES[0])", () => {
    dashboard = makeDashboard();
    expect(dashboard.currentMode).toBe("AGENT LOG");
    expect(dashboard.rightPane.mode).toBe("AGENT LOG");
    setupDashboard();
    expect(dashboard.currentMode).toBe("AGENT LOG");
  });

  test("n from AGENT LOG goes to WATCHDOG LOG then PROXY LOG; p from AGENT LOG goes to INITIAL PROMPT", () => {
    setupDashboard();
    dashboard.handleInput("n");
    expect(dashboard.currentMode).toBe("WATCHDOG LOG");
    dashboard.handleInput("n");
    expect(dashboard.currentMode).toBe("PROXY LOG");
    dashboard.handleInput("p");
    dashboard.handleInput("p");
    expect(dashboard.currentMode).toBe("AGENT LOG");
    dashboard.handleInput("p");
    expect(dashboard.currentMode).toBe("INITIAL PROMPT");
  });

  test("moving between two agents with one id in two repos reloads the right pane and the info panel", async () => {
    const base = await mkdtemp(join(tmpdir(), "ib-dash-twin-"));
    try {
      const twins: Agent[] = [];
      for (const repo of ["alpha", "beta"]) {
        const repoPath = join(base, repo);
        const agentDir = join(repoPath, ".itsybitsy", "agents", "dup");
        await mkdir(agentDir, { recursive: true });
        await writeFile(join(agentDir, "agent.log"), `log of ${repo}/dup\n`);
        twins.push(_makeAgent({ id: "dup", repoPath, repoName: repo, state: "running" }));
      }
      const [alpha, beta] = twins as [Agent, Agent];
      dashboard = makeDashboard();
      dashboard.setMachineName("studio");
      dashboard.onUpdate([alpha, beta], [
        makeFlatRepoHeader("alpha", alpha.repoPath, true, true, true),
        makeFlatAgent(alpha),
        makeFlatRepoHeader("beta", beta.repoPath, true, true, true),
        makeFlatAgent(beta),
      ], []);
      const logText = () => (dashboard.rightPane.agentLogContent ?? []).map(stripAnsi).join("\n");

      dashboard.handleInput("j"); // alpha's dup
      expect(dashboard.currentAgentKey).toBe("studio/alpha/dup");
      await waitFor(() => logText().includes("log of alpha/dup"), { timeoutMs: WAIT_TIMEOUT_MS, message: "alpha's log" });

      dashboard.handleInput("j"); // beta's header
      dashboard.handleInput("j"); // beta's dup: the same bare id, another agent
      expect(dashboard.selectedAgent).toBe(beta);
      expect(dashboard.currentAgentKey).toBe("studio/beta/dup");
      expect(dashboard.infoPanel.agent).toBe(beta);
      await waitFor(() => logText().includes("log of beta/dup"), { timeoutMs: WAIT_TIMEOUT_MS, message: "beta's log" });
      expect(logText()).not.toContain("alpha");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("the input draft is kept per agent: two agents with one id in two repos do not share it", () => {
    dashboard = makeDashboard();
    dashboard.setMachineName("studio");
    const alpha = _makeAgent({ id: "dup", repoPath: "/repos/alpha", repoName: "alpha" });
    const beta = _makeAgent({ id: "dup", repoPath: "/repos/beta", repoName: "beta" });
    dashboard.onUpdate([alpha, beta], [
      makeFlatRepoHeader("alpha", "/repos/alpha", true, true, true),
      makeFlatAgent(alpha),
      makeFlatRepoHeader("beta", "/repos/beta", true, true, true),
      makeFlatAgent(beta),
    ], []);
    const select = (agent: Agent) => {
      dashboard.agentTree.selectAgent(agent);
      dashboard.syncSelectedAgent();
    };
    select(alpha);
    for (const ch of "for alpha") dashboard.inputField.handleInput(ch);
    expect(dashboard.inputField.getText()).toBe("for alpha");
    select(beta);
    expect(dashboard.inputField.getText()).toBe("");
    select(alpha);
    expect(dashboard.inputField.getText()).toBe("for alpha");
  });

  test("the per-repo coordinator draft is kept per repo, also when two repos' coordinators share an id", () => {
    tmuxPollerSpawnCtx.set(() => makeSpawnResult(1));
    try {
      dashboard = makeDashboard();
      dashboard.setMachineName("studio");
      // Two folders named "app": the second registered as `ib add <path> app-two`.
      // A per-repo coordinator's id is its folder's name, so both are "app".
      const coordA = _makeAgent({ id: "app", repoPath: "/x/app", repoName: "app" });
      const coordB = _makeAgent({ id: "app", repoPath: "/y/app", repoName: "app-two", repoRegistryName: "app-two" });
      for (const coord of [coordA, coordB]) coord.meta.agentType = "repo-coordinator";
      dashboard.watcher = {
        lastAgents: [coordA, coordB],
        lastLiveTmuxSessions: new Set<string>(),
        healthReports: new Map(),
        refresh: () => {},
        updateRepos: () => {},
        recheckHealth: () => {},
      } as unknown as DashboardComponent["watcher"];
      dashboard.onUpdate([coordA, coordB], [
        makeFlatRepoHeader("app", "/x/app"),
        makeFlatRepoHeader("app-two", "/y/app", false, false, false, "app-two"),
      ], []);
      const selectRepo = (path: string) => {
        dashboard.agentTree.selectByRepoPath(path);
        dashboard.syncSelectedAgent();
      };
      selectRepo("/x/app");
      expect(dashboard.rightPane.repoCoordinatorAgent).toBe(coordA);
      for (const ch of "to the first") dashboard.repoCoordinatorInputField.handleInput(ch);
      selectRepo("/y/app");
      expect(dashboard.rightPane.repoCoordinatorAgent).toBe(coordB);
      expect(dashboard.repoCoordinatorInputField.getText()).toBe("");
      selectRepo("/x/app");
      expect(dashboard.repoCoordinatorInputField.getText()).toBe("to the first");
    } finally {
      tmuxPollerSpawnCtx.reset();
    }
  });

  test("a question marks (red) and filters to its own repo's agent, not another repo's agent with the same id", () => {
    dashboard = makeDashboard();
    dashboard.setMachineName("studio");
    const alpha = _makeAgent({ id: "dup", repoPath: "/repos/alpha", repoName: "alpha" });
    const beta = _makeAgent({ id: "dup", repoPath: "/repos/beta", repoName: "beta" });
    const question: PendingQuestion = { id: "q-1", agent: "dup", question: "?", timestamp: "t", status: "pending", repoPath: "/repos/beta" };
    dashboard.onUpdate([alpha, beta], [
      makeFlatRepoHeader("alpha", "/repos/alpha", true, true, true),
      makeFlatAgent(alpha),
      makeFlatRepoHeader("beta", "/repos/beta", true, true, true),
      makeFlatAgent(beta),
    ], [question]);
    expect([...dashboard.agentTree.questionAgentKeys]).toEqual(["studio/beta/dup"]);
    dashboard.agentTree.maxHeight = 20;
    const redRows = dashboard.agentTree.render(60).filter((l) => l.includes(`${RED}dup`));
    expect(redRows).toHaveLength(1);
    // The QUESTIONS list of alpha's agent is empty; beta's has the question.
    dashboard.agentTree.selectAgent(alpha);
    dashboard.syncSelectedAgent();
    expect(dashboard.rightPane.filteredQuestions).toEqual([]);
    dashboard.agentTree.selectAgent(beta);
    dashboard.syncSelectedAgent();
    expect(dashboard.rightPane.filteredQuestions).toEqual([question]);
  });

  test("selecting another agent drops every log mode's content and cached window", () => {
    dashboard = makeDashboard();
    const agent1 = makeAgent("agent-a", "/repos/test");
    const agent2 = makeAgent("agent-b", "/repos/test");
    const flatList: FlatEntry[] = [
      makeFlatAgent(agent1, { connector: "├── " }),
      makeFlatAgent(agent2, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent1, agent2], flatList, []);
    dashboard.jumpToMode("WATCHDOG LOG");
    const staleWindow = {
      agentKey: dashboard.agentTree.agentKey(agent1), fileSize: 1, atTop: true, loadedLineCount: 1,
      displayHeight: 10, scrollOffset: 0, bufferRows: 20,
    };
    const rp = dashboard.rightPane;
    rp.agentLogContent = ["stale agent.log"];
    rp.watchdogLogContent = ["stale watchdog.log"];
    rp.proxyLogContent = ["stale sandbox-proxy.log"];
    rp.loadedLogWindow = staleWindow;
    rp.loadedWatchdogLogWindow = staleWindow;
    rp.loadedProxyLogWindow = staleWindow;

    dashboard.handleInput("j"); // move to agent-b
    expect(dashboard.selectedAgent?.id).toBe("agent-b");
    expect(dashboard.currentMode).toBe("WATCHDOG LOG");
    // The reloads for agent-b are async; synchronously the stale agent-a
    // content and windows must already be gone.
    expect(rp.agentLogContent).toBeNull();
    expect(rp.watchdogLogContent).toBeNull();
    expect(rp.proxyLogContent).toBeNull();
    expect(rp.loadedLogWindow).toBeNull();
    expect(rp.loadedWatchdogLogWindow).toBeNull();
    expect(rp.loadedProxyLogWindow).toBeNull();
  });
});

describe("focus cycling", () => {
  test("Tab cycles focus forward through all targets (no coordinator in normal mode)", () => {
    // §17.1: teams-tree is NOT in the agents cycle — reachable via '2'.
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
    // §17.1: teams-tree is NOT in the agents cycle — reachable via '2'.
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

  // §17.1 Phase 3 three-axis model: `1` / `2` / `3` switch the sidebar tab
  // (Agents / Teams / Favorites). Focus moves only when the current target
  // would not exist in the new cycle: `agent-tree` ↔ `teams-tree` (Favorites
  // uses the agents cycle). Shared targets stay put.
  test("'1' / '2' / '3' set sidebarMode to agents / teams / favorites", () => {
    const dashboard = makeDashboard();
    expect(dashboard.sidebarMode).toBe("agents");
    dashboard.handleInput("3");
    expect(dashboard.sidebarMode).toBe("favorites");
    expect(dashboard.focusManager.sidebarMode).toBe("favorites");
    expect(dashboard.agentTree.favoritesOnly).toBe(true);
    dashboard.handleInput("2");
    expect(dashboard.sidebarMode as string).toBe("teams");
    expect(dashboard.focusManager.sidebarMode as string).toBe("teams");
    expect(dashboard.agentTree.favoritesOnly).toBe(false);
    dashboard.handleInput("1");
    expect(dashboard.sidebarMode as string).toBe("agents");
    expect(dashboard.focusManager.sidebarMode as string).toBe("agents");
    expect(dashboard.agentTree.favoritesOnly).toBe(false);
  });

  test("'0' no longer switches the sidebar tab", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("0");
    expect(dashboard.sidebarMode).toBe("agents");
    expect(dashboard.focus).toBe("agent-tree");
    dashboard.handleInput("2");
    dashboard.handleInput("0");
    expect(dashboard.sidebarMode as string).toBe("teams");
    expect(dashboard.focus).toBe("teams-tree");
  });

  test("'2' from agent-tree focus moves focus to teams-tree (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    expect(dashboard.focus).toBe("agent-tree");
    expect(dashboard.sidebarMode).toBe("agents");
    dashboard.handleInput("2");
    expect(dashboard.sidebarMode).toBe("teams");
    // Phase 3: focus mirrors agent-tree → teams-tree.
    expect(dashboard.focus).toBe("teams-tree");
  });

  test("'2' from a shared focus target leaves focus alone (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    // Move focus to a target that exists in BOTH FOCUS_ORDER and
    // TEAMS_FOCUS_ORDER (info / active-agent / right-pane). Tab once → info.
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("2");
    expect(dashboard.sidebarMode).toBe("teams");
    // Focus unchanged because info is in BOTH cycles.
    expect(dashboard.focus).toBe("info");
  });

  test("'2' from repo-coordinator focus moves focus to teams-tree", () => {
    const dashboard = makeDashboard();
    dashboard.focusManager.setFocus("repo-coordinator");
    dashboard.handleInput("2");
    expect(dashboard.focus).toBe("teams-tree");
  });

  test("'1' from teams-tree focus moves focus to agent-tree (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    // Set up: sidebarMode=teams + focus on teams-tree (the natural state after `2`).
    dashboard.handleInput("2");
    expect(dashboard.sidebarMode).toBe("teams");
    expect(dashboard.focus).toBe("teams-tree");
    dashboard.handleInput("1");
    expect(dashboard.sidebarMode as string).toBe("agents");
    // Phase 3: focus mirrors teams-tree → agent-tree.
    expect(dashboard.focus).toBe("agent-tree");
  });

  test("'1' from a shared focus target leaves focus alone (§17.1 Phase 3)", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("2"); // sidebarMode=teams, focus=teams-tree
    dashboard.handleInput("\t"); // teams-tree → info (teams cycle)
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("1");
    expect(dashboard.sidebarMode as string).toBe("agents");
    // Focus unchanged because info is in BOTH cycles.
    expect(dashboard.focus).toBe("info");
  });

  test("'3' from teams-tree focus moves focus to agent-tree", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("2");
    expect(dashboard.focus).toBe("teams-tree");
    dashboard.handleInput("3");
    expect(dashboard.sidebarMode as string).toBe("favorites");
    expect(dashboard.focus).toBe("agent-tree");
  });

  test("'3' keeps agent-tree and shared focus targets", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("3");
    expect(dashboard.focus).toBe("agent-tree");
    dashboard.handleInput("1");
    dashboard.focusManager.setFocus("info");
    dashboard.handleInput("3");
    expect(dashboard.focus).toBe("info");
  });

  test("'2' from the Favorites tab moves agent-tree focus to teams-tree", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("3");
    expect(dashboard.focus).toBe("agent-tree");
    dashboard.handleInput("2");
    expect(dashboard.sidebarMode as string).toBe("teams");
    expect(dashboard.focus).toBe("teams-tree");
  });

  test("Tab in favorites mode uses the agents cycle", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("3");
    expect(dashboard.focus).toBe("agent-tree");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("active-agent");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("right-pane");
    dashboard.handleInput("\t");
    // repo-coordinator is skipped outside REPO mode; wraps to agent-tree.
    expect(dashboard.focus).toBe("agent-tree");
  });

  test("j/k in favorites mode navigate the filtered Agents tree and keep activeSelectionSource 'agents'", () => {
    const dashboard = makeDashboard();
    const fav = makeAgent("agent-fav", "/repos/test");
    const plain = makeAgent("agent-plain", "/repos/test");
    dashboard.agentTree.setFlatList([makeFlatAgent(fav), makeFlatAgent(plain)]);
    dashboard.agentTree.toggleFavorite(treeKeyOf(dashboard.agentTree, "agent-fav"));
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "t1", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);
    // Make the Teams tree the active source first, so j/k must flip it back.
    dashboard.handleInput("2");
    dashboard.handleInput("j");
    expect(dashboard.activeSelectionSource).toBe("teams");
    dashboard.handleInput("3");
    dashboard.handleInput("j");
    expect(dashboard.activeSelectionSource).toBe("agents");
    expect(dashboard.infoPanel.agent?.id).toBe("agent-fav");
    // The non-favorite is not in the view, so j wraps back to the favorite.
    dashboard.handleInput("j");
    expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-fav");
    dashboard.handleInput("K");
    expect(dashboard.activeSelectionSource).toBe("agents");
    expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-fav");
  });

  test("'3' keeps the selected non-favorite agent as the selection", () => {
    const dashboard = makeDashboard();
    const fav = makeAgent("agent-fav", "/repos/test");
    const plain = makeAgent("agent-plain", "/repos/test");
    dashboard.onUpdate([fav, plain], [makeFlatAgent(fav), makeFlatAgent(plain)], []);
    dashboard.agentTree.toggleFavorite(treeKeyOf(dashboard.agentTree, "agent-fav"));
    expect(selectById(dashboard.agentTree, "agent-plain")).toBe(true);
    dashboard.syncSelectedAgent();
    dashboard.handleInput("3");
    expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-plain");
    expect(dashboard.infoPanel.agent?.id).toBe("agent-plain");
    // Moving away drops the non-favorite out of the view.
    dashboard.handleInput("k");
    expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-fav");
    expect(dashboard.agentTree.visibleList.length).toBe(1);
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
    dashboard.handleInput("2"); // sidebarMode=teams, focus=teams-tree
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
    dashboard.handleInput("2"); // sidebarMode=teams, focus=teams-tree
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
    dashboard.handleInput("2");
    expect(dashboard.sidebarMode).toBe("teams");
    expect(dashboard.focusManager.coordinatorMode).toBe(true);
    // Tab cycles agent-tree → info → coordinator → agent-tree (coordinator order).
    // Note: '2' from agent-tree moved focus to teams-tree, but the next Tab
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

  test("'1' / '2' / '3' do not fire when typing in active-agent input field (§17.1)", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-a", "/repos/test");
    dashboard.onUpdate([agent], [makeFlatAgent(agent)], []);
    // Tab into active-agent then into the input sub-focus.
    dashboard.handleInput("\t"); // info
    dashboard.handleInput("\t"); // active-agent (pane)
    dashboard.handleInput("\t"); // pane → input
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.subFocus).toBe("input");

    // '2' should be captured by the input field, not switch focus to teams-tree.
    dashboard.handleInput("2");
    expect(dashboard.inputField.getText()).toBe("2");
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.sidebarMode).toBe("agents");

    // '1' and '3' likewise.
    dashboard.handleInput("1");
    dashboard.handleInput("3");
    expect(dashboard.inputField.getText()).toBe("213");
    expect(dashboard.focus).toBe("active-agent");
    expect(dashboard.sidebarMode).toBe("agents");
  });

  test("'1' / '2' / '3' typed into the repo notes editor stay in the notes", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-notes", "/repos/test");
    dashboard.onUpdate([agent], [makeFlatRepoHeader("test", "/repos/test", true, true, true), makeFlatAgent(agent)], [], []);
    expect(dashboard.agentTree.selectByRepoPath("/repos/test")).toBe(true);
    dashboard.syncSelectedAgent();
    dashboard.handleInput("\t"); // agent-tree → info
    dashboard.handleInput("\t"); // info default-type → notes sub-field
    expect(dashboard.focus).toBe("info");
    expect(dashboard.infoPanel.subField).toBe("notes");

    for (const ch of "x123y") dashboard.handleInput(ch);
    expect(dashboard.infoPanel.notesEditor.getText()).toBe("x123y");
    expect(dashboard.sidebarMode).toBe("agents");
    expect(dashboard.agentTree.favoritesOnly).toBe(false);
    expect(dashboard.focus).toBe("info");
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
      repoRegistryName: "test",
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
      repoRegistryName: "test",
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
    const agent = makeTestAgent({ meta: { ...makeTestAgent().meta, agentType: "repo-coordinator" } });
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
    // n=9, h=7, lastIndex=8: the stored offset is maxScrollOffset(9, 7) = 3, which shows item 8.
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
    dashboard.onUpdate([agent], flatList, [], ["itsybitsy-abc-orphan1", "itsybitsy-abc-orphan2"]);
    expect(dashboard.rightPane.orphanedTmuxSessions).toEqual(["itsybitsy-abc-orphan1", "itsybitsy-abc-orphan2"]);
  });

  test("ERRORS pane shows orphaned tmux sessions", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["itsybitsy-abc-orphan1"]);
    dashboard.jumpToMode("ERRORS");
    const lines = dashboard.rightPane.render(80);
    const allText = lines.map(stripAnsi).join("\n");
    expect(allText).toContain("Orphaned tmux sessions:");
    expect(allText).toContain("itsybitsy-abc-orphan1");
    expect(allText).toContain("no matching agent");
  });

  test("error count includes both errors and orphaned sessions", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["itsybitsy-orphan"]);
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
    dashboard.onUpdate([agent], flatList, [], ["itsybitsy-orphan"]);
    dashboard.addError("Some error");
    dashboard.clearErrors();
    expect(dashboard.errors.length).toBe(0);
    // Orphan still counts
    dashboard.jumpToMode("ERRORS");
    const lines = dashboard.rightPane.render(80);
    const allText = lines.map(stripAnsi).join("\n");
    expect(allText).toContain("itsybitsy-orphan");
  });

  test("ERRORS pane shows Enter hint when orphans exist", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["itsybitsy-orphan"]);
    dashboard.jumpToMode("ERRORS");
    const lines = dashboard.rightPane.render(80);
    const allText = lines.map(stripAnsi).join("\n");
    expect(allText).toContain("Enter to kill orphan");
  });

  test("Enter in ERRORS mode with orphans opens kill dialog", () => {
    dashboard = makeDashboard();

    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["itsybitsy-orphan"]);
    dashboard.handleInput("e"); // jump to ERRORS mode
    dashboard.handleInput("\r"); // Enter
    expect(dashboard.dialog).not.toBeNull();
    expect(assertDialog(dashboard.dialog, 'confirm').prompt).toContain("itsybitsy-orphan");

  });

  test("Enter in ERRORS mode with multiple orphans shows select dialog", () => {
    dashboard = makeDashboard();

    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], ["itsybitsy-orphan1", "itsybitsy-orphan2"]);
    dashboard.handleInput("e"); // jump to ERRORS mode
    dashboard.handleInput("\r"); // Enter
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'select');
    expect(d.items).toContain("itsybitsy-orphan1");
    expect(d.items).toContain("itsybitsy-orphan2");

  });

  test("pane cycle does not skip ERRORS when orphaned sessions exist", () => {
    dashboard = makeDashboard();
    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    // No regular errors, but orphans exist
    dashboard.onUpdate([agent], flatList, [], ["itsybitsy-orphan"]);
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
    // The tree row should only appear in the main column, never the sidebar
    // column (whose info panel names the agent only in its "Full id:" row).
    const lines = dashboard.render(160).map(stripAnsi);
    let sidebarHasTreeRow = false;
    for (const l of lines) {
      const sidebar = l.split("│")[0] ?? "";
      if (sidebar.includes("agent-dup-test") && !sidebar.includes("Full id:")) {
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
    dashboard.onUpdate([agent], flatList, [], ["itsybitsy-orphan"]);
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
    expect(allText).toContain("x: retire");
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

  test("x key on repo header opens remove dialog instead of retire", async () => {
    setupMultiRepoWithRepoHeader();
    expect(dashboard.agentTree.selectedRepoHeader).toBe("alpha");
    dashboard.handleInput("x");
    await dashboard.flushPendingActions();
    expect(dashboard.dialog).not.toBeNull();
    const d = assertDialog(dashboard.dialog, 'confirm');
    expect(d.prompt).toContain("Remove");
    expect(d.prompt).toContain("alpha");
  });

  test("x key on agent opens retire dialog", () => {
    setupMultiRepoWithRepoHeader();
    dashboard.handleInput("j");
    expect(dashboard.selectedAgent).not.toBeNull();
    dashboard.handleInput("x");
    expect(dashboard.dialog).not.toBeNull();
    expect(assertDialog(dashboard.dialog, 'confirm').prompt).toContain("Retire");
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

  test("leaves out the session segment when the session window has ended", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    (dashboard as any).statusBar.claudeUsage = { sessionPct: 0, weeklyPct: 15, sessionReset: null, weeklyReset: "5d 18h", sessionWindowEnded: true };
    (dashboard as any).statusBar.claudeUsageError = false;

    const footer = dashboard.render(160).map(l => stripAnsi(l)).join("\n");
    expect(footer).not.toContain("session:");
    expect(footer).toContain("claude weekly:15% (5d 18h)");
  });

  test("still shows a session segment at 0% while the window is live", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    (dashboard as any).statusBar.claudeUsage = { sessionPct: 0, weeklyPct: 15, sessionReset: "4h 59m", weeklyReset: "5d 18h" };
    (dashboard as any).statusBar.claudeUsageError = false;

    const footer = dashboard.render(160).map(l => stripAnsi(l)).join("\n");
    expect(footer).toContain("claude session:0% (4h 59m)");
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
    expect(statusRows[1]).toMatch(/^\d{2}:\d{2}  @: jump/);
    expect(statusRows[1]).toContain("codex session:4%");
    expect(statusRows[1]).toContain("weekly:1%");
  });

  test("shows gemini usage to the left of codex usage on the second status row", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    (dashboard as any).statusBar.geminiUsage = { sessionPct: 1, weeklyPct: 0, sessionReset: "9h 53m", weeklyReset: "7d 4h" };
    (dashboard as any).statusBar.geminiUsageError = false;
    (dashboard as any).statusBar.codexUsage = { sessionPct: 4, weeklyPct: 1, sessionReset: "5h 0m", weeklyReset: "7d 0h" };
    (dashboard as any).statusBar.codexUsageError = false;

    const lines = dashboard.render(180);
    const statusRows = lines.slice(-2).map(l => stripAnsi(l));
    expect(statusRows[1]).toContain("gemini session:1%");
    expect(statusRows[1]).toContain("codex session:4%");
    expect(statusRows[1]!.indexOf("gemini")).toBeLessThan(statusRows[1]!.indexOf("codex"));
  });

  test("shows only weekly gemini usage when user has no session limits", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    (dashboard as any).statusBar.geminiUsage = { sessionPct: null, weeklyPct: 15, sessionReset: null, weeklyReset: "7d 4h" };
    (dashboard as any).statusBar.geminiUsageError = false;

    const lines = dashboard.render(160);
    const statusRows = lines.slice(-2).map(l => stripAnsi(l));
    expect(statusRows[1]).toContain("gemini weekly:15%");
    expect(statusRows[1]).not.toContain("gemini session:");
  });

  test("shows gemini usage unavailable when error with no data", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-1", "/repos/a");
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", true),
      makeFlatAgent(agent, { connector: "└── " }),
    ];
    dashboard.onUpdate([agent], flatList, []);

    (dashboard as any).statusBar.geminiUsage = null;
    (dashboard as any).statusBar.geminiUsageError = true;

    const lines = dashboard.render(160);
    const statusRows = lines.slice(-2).map(l => stripAnsi(l));
    expect(statusRows[1]).toContain("⚠️  gemini usage unavailable");
  });
});

describe("agy usage polling", () => {
  // Every `agy -p /usage` run can open a browser login window when agy cannot
  // read its stored token, so the dashboard polls agy only while a live agy
  // agent exists, and stops for good after a run that looks like a login prompt.
  const GEMINI_DATA = { sessionPct: 5, weeklyPct: 10, sessionReset: "4h 0m", weeklyReset: "6d 0h" };

  afterEach(() => {
    usageFetchCtx.reset();
  });

  function makeAgyAgent(id: string, state = "running"): Agent {
    const agent = makeAgent(id, "/repos/a");
    agent.meta.model = "agy:gemini-3.7-flash-low";
    setAgentState(agent, state);
    return agent;
  }

  /**
   * Install inert Claude/Codex fetchers and a gemini fetcher that returns
   * `results` in order (the last one repeats). The returned object counts the
   * gemini calls; the fetch is counted synchronously when it is called.
   */
  function installUsageFetchers(results: GeminiUsageResult[]): { gemini: number } {
    const calls = { gemini: 0 };
    usageFetchCtx.set({
      readClaudeUsage: async () => ({ data: null, error: false }),
      readCodexLogUsage: async () => null,
      fetchCodexLiveUsage: async () => ({ reading: null, error: "inert test fetcher" }),
      fetchGeminiUsage: async () => {
        const result = results[Math.min(calls.gemini, results.length - 1)]!;
        calls.gemini++;
        return result;
      },
    });
    return calls;
  }

  function update(dashboard: DashboardComponent, agents: Agent[]): void {
    const flatList: FlatEntry[] = [
      makeFlatRepoHeader("a", "/repos/a", agents.length > 0),
      ...agents.map((a) => makeFlatAgent(a)),
    ];
    dashboard.onUpdate(agents, flatList, []);
  }

  function statusRows(dashboard: DashboardComponent): string[] {
    return dashboard.render(180).slice(-2).map((l) => stripAnsi(l));
  }

  /**
   * Like installUsageFetchers, but each gemini fetch stays pending until the
   * test calls `resolve` (which settles the most recent fetch).
   */
  function installDeferredGeminiFetcher(): { calls: number; resolve: (result: GeminiUsageResult) => void } {
    const state = { calls: 0, resolve: (_result: GeminiUsageResult) => {} };
    usageFetchCtx.set({
      readClaudeUsage: async () => ({ data: null, error: false }),
      readCodexLogUsage: async () => null,
      fetchCodexLiveUsage: async () => ({ reading: null, error: "inert test fetcher" }),
      fetchGeminiUsage: () => {
        state.calls++;
        return new Promise<GeminiUsageResult>((resolve) => {
          state.resolve = resolve;
        });
      },
    });
    return state;
  }

  async function waitForGeminiIdle(dashboard: DashboardComponent): Promise<void> {
    await waitFor(() => (dashboard as any).geminiUsageInFlight === false, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "gemini usage fetch to settle",
    });
  }

  test("does not poll agy usage when no agy agent exists", () => {
    const calls = installUsageFetchers([{ data: GEMINI_DATA, error: false }]);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    update(dashboard, [makeAgent("agent-1", "/repos/a")]);
    (dashboard as any).refreshUsage();

    expect(calls.gemini).toBe(0);
    expect((dashboard as any).statusBar.geminiUsage).toBeNull();
    expect((dashboard as any).statusBar.geminiUsageError).toBe(false);
    expect(statusRows(dashboard)[1]).not.toContain("gemini");
  });

  test("does not poll agy usage for stopped or archived agy agents", () => {
    const calls = installUsageFetchers([{ data: GEMINI_DATA, error: false }]);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    const archived = makeAgyAgent("agy-archived");
    archived.archived = true;
    update(dashboard, [makeAgyAgent("agy-stopped", "stopped"), archived]);
    (dashboard as any).refreshUsage();

    expect(calls.gemini).toBe(0);
    expect(statusRows(dashboard)[1]).not.toContain("gemini");
  });

  test("polls agy usage when a live agy agent exists", async () => {
    const calls = installUsageFetchers([{ data: GEMINI_DATA, error: false }]);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    // startPolling's first usage poll runs before the watcher reports any agent.
    expect(calls.gemini).toBe(0);

    // The first update with a live agy agent polls at once, not on the next tick.
    update(dashboard, [makeAgyAgent("agy-1", "waiting")]);
    expect(calls.gemini).toBe(1);
    await waitForGeminiIdle(dashboard);
    expect(statusRows(dashboard)[1]).toContain("gemini session:5%");

    // Each later tick polls again.
    (dashboard as any).refreshUsage();
    expect(calls.gemini).toBe(2);
  });

  test("clears the gemini status when the last live agy agent stops", async () => {
    const calls = installUsageFetchers([{ data: GEMINI_DATA, error: false }]);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    update(dashboard, [makeAgyAgent("agy-1")]);
    await waitForGeminiIdle(dashboard);
    expect(statusRows(dashboard)[1]).toContain("gemini session:5%");

    update(dashboard, [makeAgyAgent("agy-1", "stopped")]);
    expect((dashboard as any).statusBar.geminiUsage).toBeNull();
    expect((dashboard as any).statusBar.geminiUsageError).toBe(false);
    expect(statusRows(dashboard)[1]).not.toContain("gemini");
    expect(calls.gemini).toBe(1);
  });

  test("drops a result that arrives after the last live agy agent stopped", async () => {
    const pending = installDeferredGeminiFetcher();
    const dashboard = makeDashboard();
    dashboard.startPolling();
    update(dashboard, [makeAgyAgent("agy-1")]);
    expect(pending.calls).toBe(1);

    update(dashboard, [makeAgyAgent("agy-1", "stopped")]);
    pending.resolve({ data: GEMINI_DATA, error: false });
    await waitForGeminiIdle(dashboard);

    expect((dashboard as any).statusBar.geminiUsage).toBeNull();
    expect((dashboard as any).statusBar.geminiUsageError).toBe(false);
    expect(statusRows(dashboard)[1]).not.toContain("gemini");
  });

  test("does not start a second agy run while one is in flight", async () => {
    const pending = installDeferredGeminiFetcher();
    const dashboard = makeDashboard();
    dashboard.startPolling();
    update(dashboard, [makeAgyAgent("agy-1")]);
    expect(pending.calls).toBe(1);

    // A tick and a live-agy flip while the first run is pending start no run.
    (dashboard as any).refreshUsage();
    update(dashboard, []);
    update(dashboard, [makeAgyAgent("agy-2")]);
    expect(pending.calls).toBe(1);

    // A live agy agent exists again, so the pending result is shown.
    pending.resolve({ data: GEMINI_DATA, error: false });
    await waitForGeminiIdle(dashboard);
    expect(statusRows(dashboard)[1]).toContain("gemini session:5%");

    // Once the run settles, the next tick polls again.
    (dashboard as any).refreshUsage();
    expect(pending.calls).toBe(2);
  });

  test("an auth failure stops agy polling and shows a login warning", async () => {
    const calls = installUsageFetchers([
      { data: null, error: true, authFailed: true },
      { data: GEMINI_DATA, error: false },
    ]);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    update(dashboard, [makeAgyAgent("agy-1")]);
    expect(calls.gemini).toBe(1);
    await waitForGeminiIdle(dashboard);

    // Later ticks do not run agy again.
    (dashboard as any).refreshUsage();
    (dashboard as any).refreshUsage();
    expect(calls.gemini).toBe(1);

    // Neither does a new live agy agent.
    update(dashboard, []);
    update(dashboard, [makeAgyAgent("agy-2")]);
    expect(calls.gemini).toBe(1);

    const rows = statusRows(dashboard);
    expect(rows[1]).toContain("⚠️  gemini: agy login needed");
    expect(rows[1]).not.toContain("gemini usage unavailable");
  });

  test("a failure that is not an auth failure keeps polling", async () => {
    const calls = installUsageFetchers([
      { data: null, error: true },
      { data: GEMINI_DATA, error: false },
    ]);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    update(dashboard, [makeAgyAgent("agy-1")]);
    await waitForGeminiIdle(dashboard);
    expect(statusRows(dashboard)[1]).toContain("⚠️  gemini usage unavailable");

    (dashboard as any).refreshUsage();
    expect(calls.gemini).toBe(2);
    await waitForGeminiIdle(dashboard);
    const row = statusRows(dashboard)[1];
    expect(row).toContain("gemini session:5%");
    expect(row).not.toContain("agy login needed");
  });
});

describe("codex live usage", () => {
  // The session logs go stale when a window resets and no codex session runs,
  // so the dashboard also asks the account (`codex app-server`) at start, every
  // 8 hours, and once per passed reset time it shows.
  const DAY_MS = 86_400_000;
  const FAILED: CodexLiveUsageResult = { reading: null, error: "probe failed" };

  afterEach(() => {
    usageFetchCtx.reset();
    setSystemTime();
  });

  function weeklyReading(usedPercent: number, resetsAtMs: number, observedAtMs: number): CodexUsageReading {
    return {
      rateLimits: { primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAtMs / 1000 }, secondary: null },
      observedAtMs,
    };
  }

  /**
   * Install inert Claude/Gemini fetchers, a log reader that returns `log()`,
   * and a live fetcher whose calls each stay pending until `resolve(i, result)`.
   */
  function installCodexFetchers(log: () => CodexUsageReading | null) {
    const live = {
      calls: 0,
      resolvers: [] as ((result: CodexLiveUsageResult) => void)[],
      resolve(index: number, result: CodexLiveUsageResult) { live.resolvers[index]!(result); },
    };
    usageFetchCtx.set({
      readClaudeUsage: async () => ({ data: null, error: false }),
      fetchGeminiUsage: async () => ({ data: null, error: false }),
      readCodexLogUsage: async () => log(),
      fetchCodexLiveUsage: () => {
        live.calls++;
        return new Promise<CodexLiveUsageResult>((resolve) => { live.resolvers.push(resolve); });
      },
    });
    return live;
  }

  function codexRow(dashboard: DashboardComponent): string {
    return dashboard.render(180).slice(-2).map((l) => stripAnsi(l))[1]!;
  }

  async function waitForCodexWeekly(dashboard: DashboardComponent, pct: number): Promise<void> {
    await waitFor(() => (dashboard as any).statusBar.codexUsage?.weeklyPct === pct, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: `codex weekly ${pct}% on the status bar`,
    });
  }

  async function waitForCodexIdle(dashboard: DashboardComponent): Promise<void> {
    await waitFor(() => (dashboard as any).codexLiveProbeInFlight === false, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the codex live probe to settle",
    });
  }

  /** Run `body` with setInterval/clearInterval handed to the test, as the footer clock test does for timeouts. */
  async function withCapturedIntervals(
    body: (armed: { fn: () => void; ms: number; handle: object }[]) => Promise<void>,
  ): Promise<void> {
    const g = globalThis as unknown as {
      setInterval: (fn: () => void, ms?: number) => unknown;
      clearInterval: (handle?: unknown) => void;
    };
    const realSetInterval = g.setInterval;
    const realClearInterval = g.clearInterval;
    const armed: { fn: () => void; ms: number; handle: object }[] = [];
    g.setInterval = (fn: () => void, ms = 0) => {
      const handle = {};
      armed.push({ fn, ms, handle });
      return handle;
    };
    g.clearInterval = (handle?: unknown) => {
      const i = armed.findIndex((a) => a.handle === handle);
      if (i !== -1) armed.splice(i, 1);
      else realClearInterval(handle);
    };
    try {
      await body(armed);
    } finally {
      g.setInterval = realSetInterval;
      g.clearInterval = realClearInterval;
    }
  }

  test("probes once when polling starts", () => {
    const live = installCodexFetchers(() => null);
    const dashboard = makeDashboard();
    expect(live.calls).toBe(0);
    dashboard.startPolling();
    expect(live.calls).toBe(1);
  });

  test("probes again from an 8-hour timer, which stopPolling clears", async () => {
    await withCapturedIntervals(async (armed) => {
      const live = installCodexFetchers(() => null);
      const dashboard = makeDashboard();
      dashboard.startPolling();
      const timer = armed.find((a) => a.ms === CODEX_LIVE_PROBE_INTERVAL_MS);
      expect(timer).toBeDefined();
      expect(CODEX_LIVE_PROBE_INTERVAL_MS).toBe(8 * 60 * 60 * 1000);

      live.resolve(0, FAILED);
      await waitForCodexIdle(dashboard);
      timer!.fn();
      expect(live.calls).toBe(2);

      dashboard.stopPolling();
      expect(armed.some((a) => a.ms === CODEX_LIVE_PROBE_INTERVAL_MS)).toBe(false);
    });
  });

  test("a timer tick while a probe is in flight starts no second probe", async () => {
    await withCapturedIntervals(async (armed) => {
      const live = installCodexFetchers(() => null);
      const dashboard = makeDashboard();
      dashboard.startPolling();
      const timer = armed.find((a) => a.ms === CODEX_LIVE_PROBE_INTERVAL_MS)!;

      timer.fn();
      expect(live.calls).toBe(1);

      live.resolve(0, FAILED);
      await waitForCodexIdle(dashboard);
      timer.fn();
      expect(live.calls).toBe(2);
      dashboard.stopPolling();
    });
  });

  test("shows a live reading newer than the log, then a log record written after the probe", async () => {
    const nowMs = Date.now();
    // The newest log record is two days old and its weekly window reset yesterday.
    let log: CodexUsageReading | null = weeklyReading(100, nowMs - DAY_MS, nowMs - 2 * DAY_MS);
    const live = installCodexFetchers(() => log);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    await waitForCodexWeekly(dashboard, 100);
    expect(codexRow(dashboard)).toContain("codex weekly:100% (now)");

    live.resolve(0, { reading: weeklyReading(3, nowMs + 7 * DAY_MS, nowMs), error: null });
    await waitForCodexWeekly(dashboard, 3);
    expect(codexRow(dashboard)).toContain("codex weekly:3% (6d 23h)");

    // A codex agent runs after the probe, so its log record is newer.
    log = weeklyReading(9, nowMs + 7 * DAY_MS, nowMs + 1_000);
    (dashboard as any).refreshUsage();
    await waitForCodexWeekly(dashboard, 9);
    expect(codexRow(dashboard)).toContain("codex weekly:9%");
    expect(live.calls).toBe(1);
  });

  test("a failed probe keeps the previous reading and adds no warning", async () => {
    const nowMs = Date.now();
    const live = installCodexFetchers(() => null);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    live.resolve(0, { reading: weeklyReading(3, nowMs + 7 * DAY_MS, nowMs), error: null });
    await waitForCodexWeekly(dashboard, 3);
    await waitForCodexIdle(dashboard);

    (dashboard as any).probeCodexLiveUsage();
    expect(live.calls).toBe(2);
    live.resolve(1, FAILED);
    await waitForCodexIdle(dashboard);
    (dashboard as any).refreshUsage();
    await Bun.sleep(25);

    const row = codexRow(dashboard);
    expect(row).toContain("codex weekly:3%");
    expect(row).not.toContain("⚠️");
    expect((dashboard as any).statusBar.codexUsageError).toBe(false);
  });

  test("a failed probe with no session logs shows the same warning as before", async () => {
    const live = installCodexFetchers(() => null);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    live.resolve(0, FAILED);
    await waitForCodexIdle(dashboard);
    await waitFor(() => (dashboard as any).statusBar.codexUsageError === true, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the no-logs codex warning",
    });
    expect(codexRow(dashboard)).toContain("⚠️  codex usage unavailable");
  });

  test("reset times are formatted from the stored reading on every refresh", async () => {
    const base = new Date("2026-11-07T22:00:00Z").getTime();
    setSystemTime(new Date(base));
    const live = installCodexFetchers(() => null);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    live.resolve(0, { reading: weeklyReading(3, base + 7 * DAY_MS, base), error: null });
    await waitForCodexWeekly(dashboard, 3);
    expect((dashboard as any).statusBar.codexUsage.weeklyReset).toBe("7d 0h");

    // The next 4-minute tick: same stored reading, later clock.
    setSystemTime(new Date(base + 4 * 60_000));
    (dashboard as any).refreshUsage();
    await waitFor(() => (dashboard as any).statusBar.codexUsage.weeklyReset === "6d 23h", {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the reset time re-formatted against the later clock",
    });

    setSystemTime(new Date(base + 8 * 3_600_000));
    (dashboard as any).refreshUsage();
    await waitFor(() => (dashboard as any).statusBar.codexUsage.weeklyReset === "6d 16h", {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the reset time 8 hours later",
    });
  });

  test("a passed reset time probes once per reset value, and never while a probe is in flight", async () => {
    const nowMs = Date.now();
    let log: CodexUsageReading | null = weeklyReading(100, nowMs - DAY_MS, nowMs - 2 * DAY_MS);
    const live = installCodexFetchers(() => log);
    const dashboard = makeDashboard();
    dashboard.startPolling();
    // The launch probe is in flight when the stale "(now)" reading shows.
    await waitForCodexWeekly(dashboard, 100);
    await Bun.sleep(25);
    expect(live.calls).toBe(1);

    live.resolve(0, FAILED);
    await waitForCodexIdle(dashboard);
    (dashboard as any).refreshUsage();
    await waitFor(() => live.calls === 2, { timeoutMs: WAIT_TIMEOUT_MS, message: "the probe for the passed reset" });

    live.resolve(1, FAILED);
    await waitForCodexIdle(dashboard);
    (dashboard as any).refreshUsage();
    (dashboard as any).refreshUsage();
    await Bun.sleep(25);
    expect(live.calls).toBe(2);

    // A different passed reset time gets its own single probe.
    log = weeklyReading(100, nowMs - 1_000, nowMs - DAY_MS);
    (dashboard as any).refreshUsage();
    await waitFor(() => live.calls === 3, { timeoutMs: WAIT_TIMEOUT_MS, message: "the probe for the second reset" });
    live.resolve(2, FAILED);
    await waitForCodexIdle(dashboard);
    (dashboard as any).refreshUsage();
    await Bun.sleep(25);
    expect(live.calls).toBe(3);
  });

  test("a passed reset does not probe once polling has stopped", async () => {
    const nowMs = Date.now();
    const live = installCodexFetchers(() => weeklyReading(100, nowMs - DAY_MS, nowMs - 2 * DAY_MS));
    const dashboard = makeDashboard();
    dashboard.startPolling();
    live.resolve(0, FAILED);
    await waitForCodexIdle(dashboard);
    dashboard.stopPolling();

    (dashboard as any).refreshUsage();
    await waitForCodexWeekly(dashboard, 100);
    await Bun.sleep(25);
    expect(live.calls).toBe(1);
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

  // BUG-1: pinned repos are persisted in layout.json and restored on startup.
  test("applyLayout restores pinnedRepoPaths into the agent tree", () => {
    const dashboard = makeDashboard();
    dashboard.applyLayout({
      sidebarWidth: 60,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
      pinnedRepoPaths: ["/repos/alpha", "/repos/beta"],
    });
    expect(dashboard.agentTree.pinnedRepoPaths.has("/repos/alpha")).toBe(true);
    expect(dashboard.agentTree.pinnedRepoPaths.has("/repos/beta")).toBe(true);
    expect(dashboard.agentTree.pinnedRepoPaths.size).toBe(2);
  });

  // BUG-1: applyLayout without pinnedRepoPaths (old layout.json) leaves the
  // tree's existing pin set untouched rather than clobbering it.
  test("applyLayout without pinnedRepoPaths does not disturb existing pins", () => {
    const dashboard = makeDashboard();
    dashboard.agentTree.togglePinnedRepo("/repos/existing");
    dashboard.applyLayout({
      sidebarWidth: 60,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
    });
    expect(dashboard.agentTree.pinnedRepoPaths.has("/repos/existing")).toBe(true);
  });

  // BUG-1 end-to-end: pressing '.' on a selected repo header pins it AND
  // persists the pin; a fresh dashboard restores it via applyLayout(loadLayout).
  test("'.' pins a repo, persists it, and applyLayout(loadLayout()) restores it", async () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-pin", "/repos/test");
    const flatList: FlatEntry[] = [makeFlatRepoHeader("test", "/repos/test", true, true, true), makeFlatAgent(agent)];
    dashboard.onUpdate([agent], flatList, [], []);
    // Select the repo header, then press '.' to pin it.
    expect(dashboard.agentTree.selectByRepoPath("/repos/test")).toBe(true);
    dashboard.handleInput(".");
    expect(dashboard.agentTree.pinnedRepoPaths.has("/repos/test")).toBe(true);

    // persistLayout() is debounced — flush it so the write lands, then read it.
    await flushPendingSave();
    const saved = await loadLayout();
    expect(saved).not.toBeNull();
    expect(saved!.pinnedRepoPaths).toContain("/repos/test");

    // A fresh dashboard restores the pin from the saved layout.
    const restored = makeDashboard();
    restored.applyLayout(saved!);
    expect(restored.agentTree.pinnedRepoPaths.has("/repos/test")).toBe(true);

    cancelPendingSave();
  });

  test("applyLayout restores favoriteAgentIds; a layout without them leaves existing favorites", () => {
    const dashboard = makeDashboard();
    dashboard.applyLayout({
      sidebarWidth: 60,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
      favoriteAgentIds: ["studio/web/agent-1", "studio/api/agent-2"],
    });
    expect([...dashboard.agentTree.favoriteAgentIds]).toEqual(["studio/web/agent-1", "studio/api/agent-2"]);
    dashboard.applyLayout({
      sidebarWidth: 60,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
    });
    expect([...dashboard.agentTree.favoriteAgentIds]).toEqual(["studio/web/agent-1", "studio/api/agent-2"]);
  });

  test("'.' on an agent toggles it as a favorite, persists its fully qualified id, and applyLayout(loadLayout()) restores it", async () => {
    const dashboard = makeDashboard();
    dashboard.setMachineName("studio");
    const agent = makeAgent("agent-star", "/repos/test");
    dashboard.onUpdate([agent], [makeFlatRepoHeader("test", "/repos/test", true, true, true), makeFlatAgent(agent)], [], []);
    expect(selectById(dashboard.agentTree, "agent-star")).toBe(true);
    dashboard.handleInput(".");
    expect(dashboard.agentTree.favoriteAgentIds.has(treeKeyOf(dashboard.agentTree, "agent-star"))).toBe(true);
    expect(dashboard.notice).toBe("Favorited agent-star");
    // The repo is not pinned — '.' on an agent never pins.
    expect(dashboard.agentTree.pinnedRepoPaths.size).toBe(0);

    await flushPendingSave();
    const saved = await loadLayout();
    expect(saved!.favoriteAgentIds).toEqual(["studio/test/agent-star"]);
    const restored = makeDashboard();
    restored.setMachineName("studio");
    restored.applyLayout(saved!);
    restored.onUpdate([agent], [makeFlatRepoHeader("test", "/repos/test", true, true, true), makeFlatAgent(agent)], [], []);
    expect(restored.agentTree.isFavorite(agent)).toBe(true);

    // Second press unfavorites and persists the removal.
    dashboard.handleInput(".");
    expect(dashboard.agentTree.favoriteAgentIds.has(treeKeyOf(dashboard.agentTree, "agent-star"))).toBe(false);
    expect(dashboard.notice).toBe("Unfavorited agent-star");
    await flushPendingSave();
    expect((await loadLayout())!.favoriteAgentIds).toEqual([]);

    cancelPendingSave();
  });

  test("after '.', the ★ renders in the Agents tree and the Teams tree, and reaches the right pane", () => {
    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
    try {
      const dashboard = makeDashboard();
      const agent = makeAgent("agent-star", "/repos/test");
      dashboard.onUpdate([agent], [makeFlatAgent(agent)], []);
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 1, createdEpoch: 1, createdBy: "@system" },
        { kind: "team-member", teamName: "backend", agent, connector: "  " },
      ]);
      selectById(dashboard.agentTree, "agent-star");
      expect(stripAnsi(dashboard.render(160).join("\n"))).not.toContain("★");
      dashboard.handleInput(".");
      expect(stripAnsi(dashboard.render(160).join("\n"))).toMatch(/★ agent-star/);
      expect(dashboard.rightPane.favoriteAgentIds.has("local/test/agent-star")).toBe(true);
      dashboard.handleInput("2");
      expect(stripAnsi(dashboard.render(160).join("\n"))).toMatch(/★ \S*agent-star/);
      cancelPendingSave();
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("two local repos with one agent id: j reaches each, the info panel shows its full id, '.' favorites only it", () => {
    const dashboard = makeDashboard();
    dashboard.setMachineName("studio");
    const alpha = _makeAgent({ id: "dup", repoPath: "/repos/alpha", repoName: "alpha" });
    const beta = _makeAgent({ id: "dup", repoPath: "/repos/beta", repoName: "beta" });
    dashboard.onUpdate([alpha, beta], [
      makeFlatRepoHeader("alpha", "/repos/alpha", true, true, true),
      makeFlatAgent(alpha),
      makeFlatRepoHeader("beta", "/repos/beta", true, true, true),
      makeFlatAgent(beta),
    ], []);
    dashboard.infoPanel.displayHeight = 20;
    const fullId = () => dashboard.infoPanel.render(60).map(stripAnsi).find((l) => l.startsWith("Full id:"));

    dashboard.handleInput("j"); // the first row was auto-selected: now alpha's dup
    expect(dashboard.selectedAgent).toBe(alpha);
    expect(fullId()).toBe("Full id: studio/alpha/dup");
    dashboard.handleInput("j");
    dashboard.handleInput("j");
    expect(dashboard.selectedAgent).toBe(beta);
    expect(fullId()).toBe("Full id: studio/beta/dup");

    dashboard.handleInput(".");
    expect([...dashboard.agentTree.favoriteAgentIds]).toEqual(["studio/beta/dup"]);
    expect(dashboard.agentTree.isFavorite(alpha)).toBe(false);
    cancelPendingSave();
  });

  test("'.' notice uses the agent's nickname", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-nick", "/repos/test");
    agent.meta.nickname = "builder";
    dashboard.onUpdate([agent], [makeFlatAgent(agent)], []);
    selectById(dashboard.agentTree, "agent-nick");
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Favorited builder");
  });

  test("'.' on a team member in the Teams tree favorites that agent", () => {
    const dashboard = makeDashboard();
    const agent = makeAgent("agent-member", "/repos/test");
    dashboard.agentTree.setFlatList([makeFlatAgent(agent)]);
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "backend", memberCount: 1, createdEpoch: 1, createdBy: "@system" },
      { kind: "team-member", teamName: "backend", agent, connector: "  " },
    ]);
    dashboard.handleInput("2");
    dashboard.handleInput("j"); // team header
    dashboard.handleInput("j"); // member
    expect(dashboard.activeSelectionSource).toBe("teams");
    dashboard.handleInput(".");
    expect(dashboard.agentTree.favoriteAgentIds.has(treeKeyOf(dashboard.agentTree, "agent-member"))).toBe(true);
    expect(dashboard.notice).toBe("Favorited agent-member");
  });

  test("'.' on a team anchor or the system coordinator changes nothing and shows a hint", () => {
    const dashboard = makeDashboard();
    dashboard.onUpdate([], [makeFlatSystemCoordinator()], []);
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Select an agent or repo header");
    expect(dashboard.agentTree.favoriteAgentIds.size).toBe(0);
    expect(dashboard.agentTree.pinnedRepoPaths.size).toBe(0);

    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);
    dashboard.handleInput("2");
    dashboard.handleInput("j");
    expect(dashboard.activeSelectionSource).toBe("teams");
    dashboard.setNotice("reset", "info");
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Select an agent or repo header");
    expect(dashboard.agentTree.favoriteAgentIds.size).toBe(0);
  });

  test("the Favorites tab always lists the system coordinator, which '.' cannot favorite", () => {
    const dashboard = makeDashboard();
    const a = makeAgent("agent-a", "/repos/test");
    dashboard.onUpdate([a], [makeFlatSystemCoordinator(), makeFlatAgent(a)], []);
    dashboard.handleInput("3");
    expect(dashboard.agentTree.visibleList.map((f) => f.kind)).toEqual(["system-coordinator"]);
    dashboard.agentTree.selectFirstRow();
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Select an agent or repo header");
    expect(dashboard.agentTree.favoriteAgentIds.size).toBe(0);
    dashboard.agentTree.toggleFavorite(treeKeyOf(dashboard.agentTree, "agent-a"));
    dashboard.handleInput("j");
    expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-a");
    expect(dashboard.agentTree.visibleList[0]!.kind).toBe("system-coordinator");
  });

  test("'.' in the Favorites tab keeps the unfavorited agent visible until the selection moves", () => {
    const dashboard = makeDashboard();
    const a = makeAgent("agent-a", "/repos/test");
    const b = makeAgent("agent-b", "/repos/test");
    dashboard.onUpdate([a, b], [makeFlatAgent(a), makeFlatAgent(b)], []);
    dashboard.agentTree.toggleFavorite(treeKeyOf(dashboard.agentTree, "agent-a"));
    dashboard.agentTree.toggleFavorite(treeKeyOf(dashboard.agentTree, "agent-b"));
    dashboard.handleInput("3");
    selectById(dashboard.agentTree, "agent-b");
    dashboard.handleInput(".");
    expect(dashboard.agentTree.favoriteAgentIds.has(treeKeyOf(dashboard.agentTree, "agent-b"))).toBe(false);
    expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-b");
    dashboard.handleInput("k");
    expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-a");
    expect(dashboard.agentTree.visibleList.length).toBe(1);
    cancelPendingSave();
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
    // Give tree some extra height so it can be stolen from (tree min is 1).
    // The offsets are a pair: each row the tree gains, info loses.
    dashboard.sidebar.heightOffsets = { tree: 3, info: -3, coordinator: 0 };
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
    dashboard.sidebar.heightOffsets = { tree: 3, info: -3, coordinator: 0 };
    dashboard.handleInput("\t"); // move to info
    dashboard.handleInput("}"); // grow info, steal from tree
    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("{");
    expect(dashboard.sidebar.heightOffsets.info).toBe(before.info - 1);
    expect(dashboard.sidebar.heightOffsets.tree).toBe(before.tree + 1);
  });

  test("} when agent-tree focused does nothing if info height is at minimum", () => {
    const dashboard = makeDashboard();
    // Grow the tree until info is at its 1-row minimum (the offsets are a pair).
    const base = computeSidebarHeights(dashboard.sidebar.displayHeight, 0);
    dashboard.sidebar.heightOffsets = { tree: base.infoHeight - 1, info: 1 - base.infoHeight, coordinator: 0 };
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

  test("{ in the Teams tab sizes from the Teams tree, as the sidebar render does", () => {
    const dashboard = makeDashboard();
    dashboard.sidebar.displayHeight = 30;
    const agents = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map((id) => makeAgent(id, "/repos/test"));
    dashboard.agentTree.setFlatList(agents.map((a) => makeFlatAgent(a)));
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);
    dashboard.handleInput("2");
    expect(dashboard.focus).toBe("teams-tree");
    // The Teams tree is one row, so the tree region is already at its 1-row
    // minimum: { must not shrink it (the 7-row Agents tree would allow it).
    const before = { ...dashboard.sidebar.heightOffsets };
    dashboard.handleInput("{");
    expect(dashboard.sidebar.heightOffsets).toEqual(before);
  });

  test("} acts at once on a tree offset past the clamp", () => {
    const dashboard = makeDashboard();
    dashboard.sidebar.displayHeight = 30;
    const agent = makeAgent("agent-a", "/repos/test");
    dashboard.agentTree.setFlatList([makeFlatAgent(agent)]);
    // Base tree height 1; a shrink of 6 rows left over from a taller tab.
    dashboard.sidebar.heightOffsets = { tree: -6, info: 6, coordinator: 0 };
    dashboard.handleInput("}");
    // Clamped to 0 (1 row), then grown by 1: the tree is 2 rows now.
    expect(dashboard.sidebar.heightOffsets).toEqual({ tree: 1, info: -1, coordinator: 0 });
  });

  test("} held in a tall tab stops with info at 1 row after a key in a short tab", () => {
    const dashboard = makeDashboard();
    dashboard.sidebar.displayHeight = 30;
    const agents = Array.from({ length: 10 }, (_, i) => makeAgent(`a${i}`, "/repos/test"));
    dashboard.agentTree.setFlatList(agents.map((a) => makeFlatAgent(a)));
    dashboard.agentTree.toggleFavorite(treeKeyOf(dashboard.agentTree, "a0"));
    for (let i = 0; i < 4; i++) dashboard.handleInput("{"); // Agents tree 7 → 3 rows
    dashboard.handleInput("3");
    dashboard.handleInput("}"); // Favorites (base 1): clamped, then grown
    dashboard.handleInput("1");
    for (let i = 0; i < 40; i++) dashboard.handleInput("}");
    // Agents base: tree 7, info 30 - 1 - 7 - 1 = 21. Info stops at 1 row.
    expect(dashboard.sidebar.heightOffsets).toEqual({ tree: 20, info: -20, coordinator: 0 });
    dashboard.sidebar.sidebarMode = "agents";
    const lines = dashboard.sidebar.render(60).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    const infoAt = lines.findIndex((l) => l.includes("Info"));
    expect(infoAt).toBe(1 + 27); // tab line + 27 tree rows
    expect(lines.length - infoAt - 1).toBe(1); // 1 info row
  });

  test("{ that the guard stops leaves a shrink made in a taller tab alone", () => {
    const dashboard = makeDashboard();
    dashboard.sidebar.displayHeight = 30;
    const agents = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map((id) => makeAgent(id, "/repos/test"));
    dashboard.agentTree.setFlatList(agents.map((a) => makeFlatAgent(a)));
    // Agents (base 7) shrunk to 5 rows.
    dashboard.sidebar.heightOffsets = { tree: -2, info: 2, coordinator: 0 };
    dashboard.agentTree.toggleFavorite(treeKeyOf(dashboard.agentTree, "a1"));
    dashboard.agentTree.toggleFavorite(treeKeyOf(dashboard.agentTree, "a2"));
    dashboard.handleInput("3");
    // Favorites (base 2) shows the tree at its 1-row minimum: { can't shrink it.
    dashboard.handleInput("{");
    expect(dashboard.sidebar.heightOffsets).toEqual({ tree: -2, info: 2, coordinator: 0 });
    // } grows it at once from the clamped 1 row, and stores that.
    dashboard.handleInput("}");
    expect(dashboard.sidebar.heightOffsets).toEqual({ tree: 0, info: 0, coordinator: 0 });
  });

  test("applyLayout keeps a saved tree shrink", () => {
    const dashboard = makeDashboard();
    dashboard.applyLayout({
      sidebarWidth: 60,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: -3, info: 3, coordinator: 0 },
    });
    expect(dashboard.sidebar.heightOffsets).toEqual({ tree: -3, info: 3, coordinator: 0 });
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
      // Input field should show "❯ hi█" somewhere in the output
      expect(allText).toContain("❯ hi█");
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
      expect(allText).toContain("❯ ");
      expect(allText).toContain("[Send]");
      expect(allText).not.toContain("█");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    }
  });

  test("message submission sends the draft and clears the field only once accepted", async () => {
    // Deterministic acceptance via the staged-send seam — the field now clears
    // on ACCEPTANCE (ok:true), not synchronously at submit time.
    const sends: string[] = [];
    setStagedSenderForTests(async (_agent, message) => {
      sends.push(message);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });
    try {
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

      // The draft is preserved while the send is in flight — NOT cleared before
      // the send resolves — so a failed staged send could keep it.
      expect(dashboard.inputField.getText()).toBe("hello");

      await dashboard.flushPendingActions();
      expect(sends).toEqual(["hello"]);
      // Accepted → the field is cleared.
      expect(dashboard.inputField.getText()).toBe("");
    } finally {
      resetStagedSenderForTests();
    }
  });

  test("a failed inline send preserves the draft (real handleInput Send path)", async () => {
    setStagedSenderForTests(async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "cannot stage /tmp/missing.png" }));
    try {
      const dashboard = makeDashboard();
      const agent = makeAgent("agent-a", "/repos/test");
      agent.meta.tmux_session = "agent-a-session";
      const flatList: FlatEntry[] = [makeFlatAgent(agent)];
      dashboard.onUpdate([agent], flatList, []);

      dashboard.handleInput("\t"); // info
      dashboard.handleInput("\t"); // active-agent
      dashboard.handleInput("\t"); // pane → input
      for (const ch of "hello") dashboard.handleInput(ch);
      dashboard.handleInput("\t"); // input → send
      dashboard.handleInput("\r"); // submit

      await dashboard.flushPendingActions();
      // Send failed → the draft is preserved so the user can fix the path and retry.
      expect(dashboard.inputField.getText()).toBe("hello");
    } finally {
      resetStagedSenderForTests();
    }
  });

  test("a duplicate inline Send while a send is in flight is ignored (real handleInput)", async () => {
    let calls = 0;
    let resolve!: (r: { ok: boolean; exitCode: number; stdout: string; stderr: string }) => void;
    const pending = new Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }>((r) => { resolve = r; });
    setStagedSenderForTests(async () => { calls++; return pending; });
    try {
      const dashboard = makeDashboard();
      const agent = makeAgent("agent-a", "/repos/test");
      agent.meta.tmux_session = "agent-a-session";
      const flatList: FlatEntry[] = [makeFlatAgent(agent)];
      dashboard.onUpdate([agent], flatList, []);

      dashboard.handleInput("\t"); // info
      dashboard.handleInput("\t"); // active-agent
      dashboard.handleInput("\t"); // pane → input
      for (const ch of "hello") dashboard.handleInput(ch);
      dashboard.handleInput("\t"); // input → send
      dashboard.handleInput("\r"); // submit 1 → in flight (sub-focus returns to pane)

      // Navigate back to [Send] and press Enter again while the send is pending.
      dashboard.handleInput("\t"); // pane → input
      dashboard.handleInput("\t"); // input → send
      dashboard.handleInput("\r"); // submit 2 → guarded, no second send
      expect(calls).toBe(1);

      resolve({ ok: true, exitCode: 0, stdout: "", stderr: "" });
      await dashboard.flushPendingActions();
    } finally {
      resetStagedSenderForTests();
    }
  });

  test("inline send with candidate attachment paths opens multi-select dialog and stages on confirm", async () => {
    const testDir = join(process.cwd(), `.test-db-send-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    const file = join(testDir, "doc.txt");
    await Bun.write(file, "some content");

    const sends: string[] = [];
    setStagedSenderForTests(async (_agent, message) => {
      sends.push(message);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });

    const restoreTemp = useAttachmentTemp(testDir);
    try {
      const dashboard = makeDashboard();
      const agent = makeAgent("agent-a", testDir);
      agent.meta.tmux_session = "agent-a-session";
      const flatList: FlatEntry[] = [makeFlatAgent(agent)];
      dashboard.onUpdate([agent], flatList, []);

      // Focus input field
      dashboard.handleInput("\t"); // info
      dashboard.handleInput("\t"); // active-agent
      dashboard.handleInput("\t"); // pane → input

      // Type message with file path
      const msg = `check ${file}`;
      for (const ch of msg) dashboard.handleInput(ch);
      dashboard.handleInput("\t"); // input → send
      dashboard.handleInput("\r"); // submit

      await new Promise((r) => setTimeout(r, 20));

      expect(dashboard.dialog).not.toBeNull();
      expect(dashboard.dialog?.type).toBe("multi-select");
      const dlg = dashboard.dialog as Extract<NonNullable<typeof dashboard.dialog>, { type: "multi-select" }>;
      expect(dlg.items).toEqual([file]);

      // Confirm with the item checked
      await (dlg.onSubmit as any)([0]);

      await dashboard.flushPendingActions();

      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain(testDir + "/itsybitsy-attachments-");
      expect(sends[0]).not.toContain(file);
      expect(dashboard.inputField.getText()).toBe("");
    } finally {
      restoreTemp();
      resetStagedSenderForTests();
      await rm(testDir, { recursive: true, force: true });
    }
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
  test("R key triggers restartSystemCoordinator when coordinator is focused", async () => {
    // ESCAPE-VECTOR REGRESSION GUARD. This test formerly pressed R and returned
    // WITHOUT awaiting the restart, leaking a live async kill-then-recreate into
    // whichever test ran next:
    //
    //   R → handleResume → handleRestartSystemCoordinator →
    //       executeAndRefresh(async () => { await restartSystemCoordinator(); … })
    //
    // restartSystemCoordinator() synchronously launches a REAL `tmux kill-session
    // -t ib-coordinator` (its first line runs before the first await), then its
    // ensureSystemCoordinator() continuation resolves the home dir and recreates
    // `ib-coordinator` there. Un-awaited, that continuation resolved LATER —
    // while a subsequent new-agent test had pointed the home dir at a temp
    // `ib-na-home-*` — so the coordinator was recreated inside that unrelated
    // test's temp home. The file-scope afterEach only stops poller timers, so it
    // never caught this dangling promise.
    //
    // The fix pins the vector two ways: inject a coordinator spawn mock so no
    // real tmux runs and ensureSystemCoordinator short-circuits (has-session → 0)
    // before it writes anything in the home dir, and AWAIT flushPendingActions so the
    // full kill-then-recreate completes inside this test instead of escaping.
    const dashboard = makeDashboard();
    const { coordinatorSpawnCtx } = await import("../coordinator");
    const coordCommands: string[][] = [];
    // Exit 0 for every command: `tmux has-session` → 0 makes
    // ensureSystemCoordinator believe the session is already live and return
    // immediately, so it only checks the home dir for a bounce marker and never
    // writes coordinator files; `tmux kill-session` → 0 is a recorded no-op
    // instead of a real kill.
    coordinatorSpawnCtx.set((cmd: string[]) => {
      coordCommands.push([...cmd]);
      return makeSpawnResult(0);
    });
    try {
      // Select system coordinator in agent tree to enter coordinator mode.
      // In coordinator mode, COORDINATOR_FOCUS_ORDER applies: agent-tree → info → coordinator
      const flatList: FlatEntry[] = [makeFlatSystemCoordinator()];
      dashboard.onUpdate([], flatList, []);
      expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
      // Tab twice to reach coordinator focus
      dashboard.handleInput("\t"); // info
      dashboard.handleInput("\t"); // coordinator
      expect(dashboard.focus).toBe("coordinator");

      // Press R — the system coordinator is selected, so handleResume delegates
      // to handleRestartSystemCoordinator, which queues the restart via
      // executeAndRefresh.
      dashboard.handleInput("R");
      // Drain the queued restart so it runs to completion HERE. Without this
      // await the kill-then-recreate escapes into a later test (see header).
      await dashboard.flushPendingActions();

      // Proof the restart ran to completion within the test: kill-session was
      // issued through the injected mock, so nothing reached real tmux.
      const issued = coordCommands.map((c) => c.join(" "));
      expect(issued.some((c) => c.includes("kill-session"))).toBe(true);
    } finally {
      coordinatorSpawnCtx.reset();
    }
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
      expect(text).toContain("❯ test█");
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
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c[3] === "=" + IB_COORDINATOR_SESSION + ":" && c[4] === "-l" && c[5] === "--",
      );
      expect(literal).toBeDefined();
      expect(literal![6]).toBe("hi");
      // And an Enter to the same session.
      expect(sendKeys.some((c) => c[3] === "=" + IB_COORDINATOR_SESSION + ":" && c[c.length - 1] === "Enter")).toBe(true);
    } finally {
      resetSystemCoordinatorHasSessionFn();
      resetCoordinatorHome();
      resetUserConfigPath();
      resetSendSpawnRunner();
      await rm(coordHome, { recursive: true, force: true });
      await rm(cfgDir, { recursive: true, force: true });
    }
  });

  for (const cmd of ["/restart", "/respawn"]) {
    test(`coordinator submit of '${cmd}' fresh-restarts the coordinator and does NOT send it verbatim`, async () => {
      // Parity with the Telegram /restart dispatch: typing /restart or /respawn
      // into the coordinator chat box must tear down + rebuild a FRESH session
      // (cleared marker so the prior transcript is not resumed) via
      // restartSystemCoordinatorFresh — NOT be typed into Claude's prompt. We
      // prove it by (a) driving the coordinator lifecycle spawns through the
      // injected coordinatorSpawnCtx and asserting kill-session precedes
      // new-session + a cleared marker is written, and (b) asserting the outbox
      // send runner never emitted a verbatim send-keys carrying the command.
      const {
        setCoordinatorHome, resetCoordinatorHome, coordinatorSpawnCtx,
        setCoordinatorSleepFn, resetCoordinatorSleepFn,
      } = await import("../coordinator");
      const coordHome = await mkdtemp(join(tmpdir(), "dash-restart-home-"));
      const typesHome = await mkdtemp(join(tmpdir(), "dash-restart-types-"));
      const cfgDir = await mkdtemp(join(tmpdir(), "dash-restart-cfg-"));
      setUserConfigPath(join(cfgDir, "config.json"));
      setCoordinatorHome(coordHome);
      setUserHome(typesHome);
      setCoordinatorSleepFn(async () => {});

      // coordinatorSpawnCtx / tmuxPollerSpawnCtx are SpawnContexts whose runner
      // returns a spawn-like object ({stdout, stderr, exited}) — not the flat
      // SpawnResult that setSendSpawnRunner takes. Build streams for them.
      const streamOf = (text: string): ReadableStream<Uint8Array> => {
        const enc = new TextEncoder();
        return new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });
      };
      const emptyStreamOf = (): ReadableStream<Uint8Array> =>
        new ReadableStream({ start(c) { c.close(); } });

      const coordCommands: string[][] = [];
      coordinatorSpawnCtx.set((cmd2: string[], _opts?: any) => {
        coordCommands.push([...cmd2]);
        const s = cmd2.join(" ");
        // has-session must report "gone" after the discard so ensure spawns anew.
        const exit = s.includes("has-session") ? 1 : 0;
        return { stdout: streamOf(""), stderr: emptyStreamOf(), exited: Promise.resolve(exit) } as any;
      });
      // waitForCoordinatorReady captures the pane via the tmux-poller spawnCtx —
      // return the ready marker so the fresh restart resolves true.
      tmuxPollerSpawnCtx.set((_cmd: string[], _opts?: any) =>
        ({ stdout: streamOf("Claude Code v1.0.0"), stderr: emptyStreamOf(), exited: Promise.resolve(0) } as any));

      const sendKeys: string[][] = [];
      setSendSpawnRunner((c: string[]) => {
        sendKeys.push(c);
        return makeSpawnResult();
      });

      try {
        const dashboard = setupCoordinatorDashboard();
        tabToCoordinator(dashboard);
        dashboard.handleInput("\t"); // pane → input sub-focus
        for (const ch of cmd) dashboard.handleInput(ch);
        dashboard.handleInput("\t"); // input → send
        dashboard.handleInput("\r");

        await dashboard.flushPendingActions();

        // Fresh-restart lifecycle ran: kill (discard) precedes new-session (ensure).
        const coordStrs = coordCommands.map((c) => c.join(" "));
        const killIdx = coordStrs.findIndex((c) => c.includes("kill-session"));
        const newIdx = coordStrs.findIndex((c) => c.includes("new-session"));
        expect(killIdx).toBeGreaterThanOrEqual(0);
        expect(newIdx).toBeGreaterThan(killIdx);

        // Cleared marker written → this is a FRESH restart, not a resume.
        const markerExists = await Bun.file(join(coordHome, "coordinator-session.cleared")).exists();
        expect(markerExists).toBe(true);

        // The command was NOT sent verbatim to the coordinator via the outbox.
        const verbatim = sendKeys.find(
          (c) => c[0] === "tmux" && c[1] === "send-keys" && c[4] === "-l" && typeof c[6] === "string" && c[6].includes(cmd),
        );
        expect(verbatim).toBeUndefined();
      } finally {
        coordinatorSpawnCtx.reset();
        tmuxPollerSpawnCtx.reset();
        resetCoordinatorHome();
        resetCoordinatorSleepFn();
        resetUserConfigPath();
        resetSendSpawnRunner();
        resetUserHome();
        await rm(coordHome, { recursive: true, force: true });
        await rm(typesHome, { recursive: true, force: true });
        await rm(cfgDir, { recursive: true, force: true });
      }
    });
  }

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

function collectorHealth(light: CollectorHealth["light"], heartbeatAgeMs: number | null = null): CollectorHealth {
  const state = ({ grey: "idle", green: "ok", yellow: "stale", red: "broken" } as const)[light];
  return { light, state, pid: null, heartbeatAgeMs, launches: null };
}

describe("Collector header indicator", () => {
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

  test("header hides the indicator until a status is set", () => {
    expect(stripAnsi(dashboard.render(160)[0]!)).not.toContain("Collector");
  });

  test("renders to the left of Telegram, right-aligned with it", () => {
    dashboard.setCollectorStatus(collectorHealth("green"));
    dashboard.setTelegramStatus("green");
    const width = 160;
    const header = dashboard.render(width)[0]!;
    const text = stripAnsi(header).trimEnd();
    expect(text.endsWith("● Collector  ● Telegram")).toBe(true);
    expect(visibleWidth(header)).toBe(width - 1);
  });

  test("without Telegram it right-aligns on its own", () => {
    dashboard.setCollectorStatus(collectorHealth("green"));
    const header = dashboard.render(160)[0]!;
    expect(stripAnsi(header).trimEnd().endsWith("● Collector")).toBe(true);
    expect(visibleWidth(header)).toBe(159);
  });

  test("each light uses the stoplight color; grey dims the whole indicator", () => {
    const header = (light: CollectorHealth["light"]) => {
      dashboard.setCollectorStatus(collectorHealth(light));
      return dashboard.render(160)[0]!;
    };
    expect(header("green")).toContain("\x1b[32m●\x1b[0m Collector");
    expect(header("yellow")).toContain("\x1b[33m●\x1b[0m Collector");
    expect(header("red")).toContain("\x1b[31m●\x1b[0m Collector");
    expect(header("grey")).toContain("\x1b[90m●\x1b[0m \x1b[2mCollector\x1b[0m");
  });

  test("narrow width keeps both indicators inside the line", () => {
    dashboard.setCollectorStatus(collectorHealth("yellow"));
    dashboard.setTelegramStatus("green");
    const header = dashboard.render(140)[0]!;
    expect(visibleWidth(header)).toBeLessThanOrEqual(140);
    expect(stripAnsi(header).trimEnd().endsWith("● Collector  ● Telegram")).toBe(true);
  });
});

function remoteControl(state: RemoteControlStatus["state"]): RemoteControlStatus {
  const lights = { off: null, on: "green", "pending-on": "yellow", "pending-off": "yellow", stopped: "yellow" } as const;
  return { light: lights[state], state };
}

describe("Remote Control header indicator", () => {
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

  test("hidden before the first probe and while both are off", () => {
    expect(stripAnsi(dashboard.render(160)[0]!)).not.toContain("Remote Control");
    dashboard.setRemoteControlStatus(remoteControl("off"));
    expect(stripAnsi(dashboard.render(160)[0]!)).not.toContain("Remote Control");
  });

  test("green when on; yellow in both mismatch directions", () => {
    const header = (state: RemoteControlStatus["state"]) => {
      dashboard.setRemoteControlStatus(remoteControl(state));
      return dashboard.render(160)[0]!;
    };
    expect(header("on")).toContain("\x1b[32m●\x1b[0m Remote Control");
    expect(header("pending-on")).toContain("\x1b[33m●\x1b[0m Remote Control");
    expect(header("pending-off")).toContain("\x1b[33m●\x1b[0m Remote Control");
  });

  test("sits between Collector and Telegram, right-aligned with the same spacing", () => {
    dashboard.setCollectorStatus(collectorHealth("green"));
    dashboard.setRemoteControlStatus(remoteControl("on"));
    dashboard.setTelegramStatus("green");
    const width = 160;
    const header = dashboard.render(width)[0]!;
    expect(stripAnsi(header).trimEnd().endsWith("● Collector  ● Remote Control  ● Telegram")).toBe(true);
    expect(visibleWidth(header)).toBe(width - 1);
  });

  test("follows Collector when Telegram is not configured", () => {
    dashboard.setCollectorStatus(collectorHealth("green"));
    dashboard.setRemoteControlStatus(remoteControl("pending-on"));
    const header = dashboard.render(160)[0]!;
    expect(stripAnsi(header).trimEnd().endsWith("● Collector  ● Remote Control")).toBe(true);
    expect(visibleWidth(header)).toBe(159);
  });

  test("narrow width keeps all three indicators inside the line", () => {
    dashboard.setCollectorStatus(collectorHealth("yellow"));
    dashboard.setRemoteControlStatus(remoteControl("pending-off"));
    dashboard.setTelegramStatus("green");
    const header = dashboard.render(140)[0]!;
    expect(visibleWidth(header)).toBeLessThanOrEqual(140);
    expect(stripAnsi(header).trimEnd().endsWith("● Collector  ● Remote Control  ● Telegram")).toBe(true);
  });
});

describe("Remote Control light inputs", () => {
  let dir: string;
  let settingsPath: string;
  let configured: boolean;
  let dashboard: DashboardComponent;
  let counter: ReturnType<typeof countingTui>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "itsybitsy-remote-control-"));
    settingsPath = join(dir, "settings.local.json");
    configured = true;
    dashboard = makeDashboard();
    counter = countingTui();
    dashboard.setTui(counter.tui);
    // Temp files only; never the real system-coordinator.md or settings file.
    dashboard.remoteControlProbe = { settingsPath, loadSystemCoordinatorType: async () => ({ remoteControl: configured }) };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The settings file a launch writes. */
  const launchedWith = (on: boolean) =>
    writeFile(settingsPath, JSON.stringify(on ? { spinnerTipsEnabled: false } : { disableRemoteControl: true }));
  /** One watcher update with the system coordinator in `state` (undefined: no entry). */
  const watcherUpdate = (state?: string) =>
    dashboard.onUpdate([], state === undefined ? [] : [makeFlatSystemCoordinator(state)], []);

  test("refreshRemoteControlStatus picks up a coordinator restart on the next tick", async () => {
    // Turned on in system-coordinator.md; the running coordinator was launched with it off.
    await launchedWith(false);
    await dashboard.refreshRemoteControlStatus();
    await dashboard.refreshRemoteControlStatus();
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("pending-on"));
    expect(counter.renders()).toBe(1);

    // The restart's relaunch rewrites the settings file without the key.
    await launchedWith(true);
    await dashboard.refreshRemoteControlStatus();
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("on"));
    expect(counter.renders()).toBe(2);
  });

  test("a stopped coordinator turns green to yellow once two watcher updates in a row say so", async () => {
    await launchedWith(true);
    await dashboard.refreshRemoteControlStatus();
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("on"));

    watcherUpdate("stopped");
    expect(dashboard.isSystemCoordinatorStopped()).toBe(false);
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("on"));
    watcherUpdate("stopped");
    expect(dashboard.isSystemCoordinatorStopped()).toBe(true);
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("stopped"));
    // The stop left the settings file in place; the next tick's read keeps it yellow.
    await dashboard.refreshRemoteControlStatus();
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("stopped"));

    // Started again: green on the next update.
    watcherUpdate("running");
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("on"));
  });

  test("not configured and stopped: hidden, although the last launch had it on", async () => {
    configured = false;
    await launchedWith(true);
    await dashboard.refreshRemoteControlStatus();
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("pending-off"));
    watcherUpdate("stopped");
    watcherUpdate("stopped");
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("off"));
  });

  test("only an explicit stopped counts: any other state or a missing entry starts the count over", async () => {
    await launchedWith(true);
    await dashboard.refreshRemoteControlStatus();
    for (const between of ["running", "compacting", "rate_limited", undefined]) {
      watcherUpdate("stopped");
      watcherUpdate(between);
      watcherUpdate("stopped");
      expect(dashboard.isSystemCoordinatorStopped(), String(between)).toBe(false);
      expect(dashboard.remoteControlStatus).toEqual(remoteControl("on"));
      watcherUpdate("running");
    }
  });

  test("refreshRemoteControlAfterLaunch re-reads once the startup launch ends, even a failed one", async () => {
    await launchedWith(false); // the previous run's file
    await dashboard.refreshRemoteControlStatus();
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("pending-on"));

    let endLaunch!: () => void;
    const startup = new Promise<void>((resolve) => { endLaunch = resolve; });
    const refreshed = dashboard.refreshRemoteControlAfterLaunch(startup);
    await launchedWith(true); // the startup launch writes the new file
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("pending-on"));
    endLaunch();
    await refreshed;
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("on"));

    await launchedWith(false);
    await dashboard.refreshRemoteControlAfterLaunch(Promise.reject(new Error("launch failed")));
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("pending-on"));
  });

  test("a refresh asked for while a read is in flight runs once more after it", async () => {
    await launchedWith(true);
    configured = false;
    let releaseFirstRead: (() => void) | undefined;
    let reads = 0;
    dashboard.remoteControlProbe = {
      settingsPath,
      loadSystemCoordinatorType: async () => {
        const value = configured; // what the file says when this read looks
        if (++reads === 1) await new Promise<void>((resolve) => { releaseFirstRead = resolve; });
        return { remoteControl: value };
      },
    };
    const first = dashboard.refreshRemoteControlStatus();
    await waitFor(() => releaseFirstRead !== undefined, { message: "first read started" });
    configured = true; // changed after the first read looked
    await dashboard.refreshRemoteControlStatus(); // queued behind the first read
    releaseFirstRead!();
    await first;
    expect(reads).toBe(2);
    expect(dashboard.remoteControlStatus).toEqual(remoteControl("on"));
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

    // Switch focus to teams-tree (via setFocus — the focus move pressing '2' makes)
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
  // These tests pin the three-axis model behavior: `1`/`2`/`3` flip the
  // sidebar tab but NEVER move the active selection; j/k flip the active
  // source to whichever tree is visible (the user just declared what they're
  // selecting).
  describe("§17.1 Phase 2 — global selection independent of sidebar mode", () => {
    test("'2' toggles sidebarMode without changing activeSelectionSource", () => {
      const dashboard = makeDashboard();
      const a = makeAgent("agent-glob1", "/tmp/repo-glob");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.agentTree.selectFirstRow();
      expect(dashboard.sidebarMode).toBe("agents");
      expect(dashboard.activeSelectionSource).toBe("agents");
      dashboard.handleInput("2");
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
      // User pressed '2' then j to make team t1 active.
      dashboard.handleInput("2");
      dashboard.handleInput("j");
      expect(dashboard.activeSelectionSource).toBe("teams");
      // Now press '1' — sidebar shows Agents, but team stays active.
      dashboard.handleInput("1");
      expect(dashboard.sidebarMode).toBe("agents");
      expect(dashboard.activeSelectionSource).toBe("teams");
      // Main / info pane STILL drives the team channel.
      expect(dashboard.channelPane.teamName).toBe("t1");
      // '3' likewise leaves the team as the active selection.
      dashboard.handleInput("3");
      expect(dashboard.sidebarMode as string).toBe("favorites");
      expect(dashboard.activeSelectionSource).toBe("teams");
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
      // Press '2' to flip sidebar to teams — active source stays "agents".
      dashboard.handleInput("2");
      expect(dashboard.activeSelectionSource).toBe("agents");
      // Press j — navigates Teams (visible) tree, active source flips to "teams".
      dashboard.handleInput("j");
      expect(dashboard.activeSelectionSource).toBe("teams");
      expect(dashboard.channelPane.teamName).toBe("t1");
    });

    test("'2' mirrors active agent into the Teams tree when it's a team member", () => {
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
      dashboard.handleInput("2");
      const sel = dashboard.teamsTree.selection;
      expect(sel?.kind).toBe("agent");
      if (sel?.kind === "agent") expect(sel.agent.id).toBe("agent-member");
    });

    test("'2' leaves Teams tree in no-selection when active agent is not a team member", () => {
      const dashboard = makeDashboard();
      const a = makeAgent("agent-loner", "/tmp/r");
      dashboard.agentTree.setFlatList([makeFlatAgent(a)]);
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      ]);
      dashboard.agentTree.selectFirstRow();
      dashboard.handleInput("2");
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
      dashboard.handleInput("2"); // sidebar -> teams
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
      dashboard.handleInput("2"); // sidebarMode -> teams; coord still selected in agentTree
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

    // The team title tabs (@team CHAT / @team LOG) must carry the same REVERSE
    // focus highlight as the AGENT LOG tab when tabbed to. In the team view the
    // LEFT (CHAT) pane is the "active-agent" focus target and the RIGHT (LOG)
    // pane is "right-pane" (TEAMS_FOCUS_ORDER).
    test("team title tab shows the REVERSE focus highlight on the focused pane", () => {
      Object.defineProperty(process.stdout, "rows", { value: 30, writable: true, configurable: true });
      const dashboard = makeDashboard();

      // Get into the team view (mirror the setup above): coordinator selected,
      // then flip to teams and navigate to the team header.
      const coordList: FlatEntry[] = [makeFlatSystemCoordinator()];
      dashboard.onUpdate([], coordList, []);
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
      ]);
      dashboard.handleInput("2"); // sidebarMode -> teams
      dashboard.handleInput("j"); // navigate to the team header
      expect(dashboard.activeSelectionSource).toBe("teams");
      expect(dashboard.channelPane.teamName).toBe("backend");

      // Focused title tabs are wrapped in REVERSE+BOLD (`\x1b[7m\x1b[1m`); an
      // unfocused tab is plain BOLD (`\x1b[1m`, no preceding REVERSE).
      const REV_BOLD = "\x1b[7m\x1b[1m";

      // Focus the LOG (right) pane → @backend LOG is REVERSE, CHAT stays plain.
      dashboard.focusManager.setFocus("right-pane");
      let raw = dashboard.render(160).join("\n");
      expect(raw).toContain(`${REV_BOLD} @backend LOG `);
      expect(raw).not.toContain(`${REV_BOLD} @backend CHAT `);

      // Focus the CHAT (left) pane → @backend CHAT is REVERSE, LOG stays plain.
      dashboard.focusManager.setFocus("active-agent");
      raw = dashboard.render(160).join("\n");
      expect(raw).toContain(`${REV_BOLD} @backend CHAT `);
      expect(raw).not.toContain(`${REV_BOLD} @backend LOG `);

      // Focus the Teams tree (sidebar) → NEITHER tab is REVERSE.
      dashboard.focusManager.setFocus("teams-tree");
      raw = dashboard.render(160).join("\n");
      expect(raw).not.toContain(`${REV_BOLD} @backend CHAT `);
      expect(raw).not.toContain(`${REV_BOLD} @backend LOG `);

      // Focus the Info panel (sidebar) → NEITHER tab is REVERSE (same as tree).
      dashboard.focusManager.setFocus("info");
      raw = dashboard.render(160).join("\n");
      expect(raw).not.toContain(`${REV_BOLD} @backend CHAT `);
      expect(raw).not.toContain(`${REV_BOLD} @backend LOG `);
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
        dashboard.handleInput("2");
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

  describe("manage roster ('t' on a team anchor)", () => {
    // saveRegistry writes to `<home>/.itsybitsy/repos.json` (registry.ts resolves
    // the home dir through the injectable home seam). Isolate the home dir for
    // every test in this sub-describe so a successful or aborted test cannot
    // bleed a `repos.json` entry into the developer's real ~/.itsybitsy/.
    let homeTmp: string;
    beforeEach(async () => {
      homeTmp = await mkdtemp(join(tmpdir(), "dash-roster-home-"));
      setUserHome(homeTmp);
      await Bun.write(join(homeTmp, ".itsybitsy", "machine-name"), "studio");
      // Stub the send spawn runner. These tests plant REAL agent dirs so the
      // roster wrappers can resolve bare ids, which means teamAdd/teamRemove's
      // join/leave fan-out reaches the real delivery path and spawns real tmux
      // subprocesses (against sessions that do not exist) with the real
      // inter-keystroke delays. That is seconds of unrelated work on a busy
      // machine — enough to blow the 5s per-test timeout — and none of it is
      // what these tests assert on. Stubbing keeps the roster assertions and
      // drops the dependency on tmux.
      setSendSpawnRunner(() => makeSpawnResult());
    });
    afterEach(async () => {
      resetSendSpawnRunner();
      resetUserHome();
      await rm(homeTmp, { recursive: true, force: true });
    });

    test("opens a multi-select dialog with current members pre-toggled ON; confirm adds/removes the diff", async () => {
      const { createTeam, addMember, readTeams } = await import("../teams");
      const { saveRegistry } = await import("../registry");
      // Plant a team with one existing member.
      await createTeam("backend", "user", 1700000000);
      await addMember("backend", "agent-existing");

      const dashboard = makeDashboard();
      // Plant real agent dirs so teamAdd/teamRemove's resolveFullAgentId
      // can resolve the bare ids — the wrappers walk repos.json + agent
      // dirs rather than trusting the in-memory lastAgents list.
      const repoTmp = await mkdtemp(join(tmpdir(), "dash-roster-repo-"));
      const { writeAgentTransient } = await import("../agents");
      async function plant(id: string) {
        const agentDir = join(repoTmp, ".itsybitsy", "agents", id);
        await mkdir(agentDir, { recursive: true });
        await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `t-${id}` }));
        await writeAgentTransient(agentDir, {
          tmux_compacting: false,
          tmux_rate_limited: false,
          tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
          has_background_tasks: false,
          updated_at_ms: Date.now(),
          watchdog_pid: 4242,
        });
      }
      await plant("agent-existing");
      await plant("agent-new");
      const repoEntry = { path: repoTmp, name: "repo-a" };
      // saveRegistry writes to <home>/.itsybitsy/repos.json; the home dir is the
      // isolated tmp set in beforeEach, so this is sandboxed.
      await saveRegistry({ repos: [repoEntry] });
      dashboard.repos = [repoEntry];

      // Three live agents: one already a member, two not.
      const a1 = makeAgent("agent-existing", repoTmp);
      const a2 = makeAgent("agent-new", repoTmp);
      const a3 = makeAgent("agent-other", "/tmp/repo-b");
      // Inject a fake watcher exposing lastAgents — the only thing
      // handleManageRoster reads off the watcher handle.
      dashboard.watcher = {
        lastAgents: [a1, a2, a3],
        refresh: () => {},
        updateRepos: () => {},
        recheckHealth: () => {},
      } as unknown as DashboardComponent["watcher"];

      // Drive the Teams tree to a team-header selection; the manage-roster
      // dispatch keys off `activeSelectionSource === "teams"` (Phase 2
      // §17.1) — set BOTH so the team panel is the active source.
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 1, createdEpoch: 1700000000, createdBy: "user" },
      ]);
      dashboard.teamsTree.navigate(1); // header selected
      dashboard.sidebarMode = "teams";
      dashboard.activeSelectionSource = "teams";

      // Press 't' — should open the multi-select roster dialog.
      dashboard.handleInput("t");
      await dashboard.flushPendingActions();

      const dlg = assertDialog(dashboard.dialog, "multi-select");
      expect(dlg.prompt).toContain("Manage roster: @backend");
      expect(dlg.items.length).toBe(3);
      // Pre-check state reflects current roster: only agent-existing is ON.
      expect(dlg.checked).toEqual([true, false, false]);

      // Confirm with NEW selection — keep only `agent-new` (index 1) so the
      // diff is: -agent-existing, +agent-new. The handler reads
      // `checkedIndices` directly (NOT `dlg.checked`), so passing [1] is
      // the correct way to simulate the dialog-level toggle that
      // dialog-handler.ts builds before calling onSubmit.
      dlg.onSubmit([1]);
      await dashboard.flushPendingActions();

      // Roster after the diff: agent-new added, agent-existing removed.
      const reg = await readTeams();
      expect(reg.teams["backend"]!.members).toEqual(["agent-new"]);

      await rm(repoTmp, { recursive: true, force: true });
    });

    test("'t' when the active selection is NOT a team-header opens the add-to-team picker, NOT the manage-roster dialog", async () => {
      const { createTeam, addMember } = await import("../teams");
      // Plant a team so handleAddAgentToTeam's listTeams() branch into the
      // fuzzy picker (the path it takes when at least one team exists).
      await createTeam("backend", "user", 1700000000);
      await addMember("backend", "agent-other");

      const dashboard = makeDashboard();
      const a = makeAgent("agent-sel", "/tmp/repo");
      // Set up an Agents-tree selection so handleAddAgentToTeam has a
      // selectedAgent to add. Driving onUpdate populates the tree.
      const flatList: FlatEntry[] = [makeFlatAgent(a)];
      dashboard.onUpdate([a], flatList, []);
      dashboard.watcher = {
        lastAgents: [a],
        refresh: () => {},
        updateRepos: () => {},
        recheckHealth: () => {},
      } as unknown as DashboardComponent["watcher"];

      // Active selection is in the AGENTS tree (the dashboard default).
      // Even though the teams tree carries a header row, sidebarMode is
      // "agents" and activeSelectionSource is "agents", so `t` MUST route
      // to handleAddAgentToTeam — not handleManageRoster.
      dashboard.teamsTree.setFlatList([
        { kind: "team-header", teamName: "backend", memberCount: 1, createdEpoch: 1, createdBy: "user" },
      ]);
      expect(dashboard.sidebarMode).toBe("agents");
      expect(dashboard.activeSelectionSource).toBe("agents");

      // Sanity: the auto-select on first onUpdate should have selected
      // agent-sel — the precondition for handleAddAgentToTeam to do work.
      expect(dashboard.agentTree.selectedAgent?.id).toBe("agent-sel");

      dashboard.handleInput("t");
      // handleAddAgentToTeam uses fire-and-forget listTeams().then(...) — not
      // executeAndRefresh — so flushPendingActions doesn't track it. Wait on
      // the dialog the assertions below check, not on a fixed 50ms: the .then()
      // is gated on a real file read, so how long it takes tracks how busy the
      // machine is, and a fixed sleep asserts "no dialog opened" the moment the
      // box is loaded enough to miss the deadline.
      await waitFor(() => dashboard.dialog !== null, {
        timeoutMs: WAIT_TIMEOUT_MS,
        message: "the add-to-team picker dialog to open",
      });

      // Positive assertion: the add-to-team picker opened (fuzzy picker
      // because at least one team exists). NOT a multi-select roster.
      expect(dashboard.dialog).not.toBeNull();
      const dlg = dashboard.dialog!;
      expect(dlg.type).toBe("fuzzy");
      // Belt-and-suspenders: if any future refactor changed the dialog
      // type, this still rules out the manage-roster path explicitly.
      if (dlg.type === "multi-select") {
        expect(dlg.prompt).not.toContain("Manage roster:");
      }
    });
  });

  describe("team-member picker ('x' / 't' on a member row)", () => {
    // Same isolation as the manage-roster tests above: a private home for
    // repos.json, and a stubbed send runner so teamRemove's leave notices
    // never reach tmux.
    let homeTmp: string;
    beforeEach(async () => {
      homeTmp = await mkdtemp(join(tmpdir(), "dash-member-home-"));
      setUserHome(homeTmp);
      await Bun.write(join(homeTmp, ".itsybitsy", "machine-name"), "studio");
      setSendSpawnRunner(() => makeSpawnResult());
    });
    afterEach(async () => {
      resetSendSpawnRunner();
      resetUserHome();
      await rm(homeTmp, { recursive: true, force: true });
    });

    const header = (teamName: string): TeamFlatEntry =>
      ({ kind: "team-header", teamName, memberCount: 1, createdEpoch: 1700000000, createdBy: "user" });
    const member = (teamName: string, agent: Agent): TeamFlatEntry =>
      ({ kind: "team-member", teamName, agent, connector: "  " });

    /**
     * A dashboard whose Agents tree holds `agents` and whose Teams tree holds
     * `rows`. Both lists are set directly: onUpdate would start an async
     * rebuild of the Teams tree from teams.json that lands mid-test.
     */
    function dashboardWith(agents: Agent[], rows: TeamFlatEntry[]): DashboardComponent {
      const dashboard = makeDashboard();
      dashboard.agentTree.setFlatList(agents.map((a) => makeFlatAgent(a)));
      dashboard.teamsTree.setFlatList(rows);
      return dashboard;
    }

    test("'x' on a member row opens the picker and does NOT open the retire confirm", () => {
      const a = makeAgent("agent-tm1", "/tmp/repo-x");
      const dashboard = dashboardWith([a], [header("backend"), member("backend", a)]);
      dashboard.handleInput("2"); // Teams tab
      dashboard.handleInput("j"); // @backend
      dashboard.handleInput("j"); // its member row
      expect(dashboard.activeSelectionSource).toBe("teams");
      expect(dashboard.teamsTree.selectedMember).toEqual({ teamName: "backend", agent: a });

      dashboard.handleInput("x");
      const d = assertDialog(dashboard.dialog, "select");
      expect(d.prompt).toBe(`${a.repoName}/agent-tm1 in @backend`);
      expect(d.items).toEqual([
        `Remove ${a.repoName}/agent-tm1 from @backend`,
        `Retire ${a.repoName}/agent-tm1…`,
      ]);
      expect(d.selectedIndex).toBe(0);

      // A second 'x' is swallowed by the picker, and Esc closes it: nothing ran.
      dashboard.handleInput("x");
      expect(assertDialog(dashboard.dialog, "select")).toBe(d);
      dashboard.handleInput("\x1b");
      expect(dashboard.dialog).toBeNull();
    });

    test("'x' then the Retire row reaches the retire confirm, still unconfirmed", () => {
      const a = makeAgent("agent-tm1", "/tmp/repo-x");
      const dashboard = dashboardWith([a], [header("backend"), member("backend", a)]);
      dashboard.handleInput("2");
      dashboard.handleInput("j");
      dashboard.handleInput("j");
      dashboard.handleInput("x");
      dashboard.handleInput("j");  // down to "Retire …"
      dashboard.handleInput("\r");
      const d = assertDialog(dashboard.dialog, "confirm");
      expect(d.prompt).toBe("Retire agent agent-tm1?");
      expect(d.confirmLabel).toBe("Retire");
      expect(d.focusedButton).toBe("cancel");
      // Enter on the default Cancel button dismisses without retiring.
      dashboard.handleInput("\r");
      expect(dashboard.dialog).toBeNull();
    });

    test("'x' then the Remove row removes the agent from the team its ROW is under, and keeps the agent", async () => {
      const { createTeam, addMember, readTeams } = await import("../teams");
      const { saveRegistry } = await import("../registry");
      const { writeAgentTransient } = await import("../agents");
      const repoTmp = await mkdtemp(join(tmpdir(), "dash-member-repo-"));
      try {
        // A real agent dir: teamRemove resolves the id from disk.
        const agentDir = join(repoTmp, ".itsybitsy", "agents", "agent-two");
        await mkdir(agentDir, { recursive: true });
        await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-two", tmux_session: "t-agent-two" }));
        await writeAgentTransient(agentDir, {
          tmux_compacting: false,
          tmux_rate_limited: false,
          tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
          has_background_tasks: false,
          updated_at_ms: Date.now(),
          watchdog_pid: 4242,
        });
        const repoEntry = { path: repoTmp, name: "repo-a" };
        await saveRegistry({ repos: [repoEntry] });
        // The agent is on TWO teams, so it has two rows.
        await createTeam("alpha", "user", 1700000000);
        await createTeam("beta", "user", 1700000000);
        await addMember("alpha", "agent-two");
        await addMember("beta", "agent-two");

        const a = makeAgent("agent-two", repoTmp);
        const dashboard = dashboardWith([a], [
          header("alpha"), member("alpha", a),
          header("beta"), member("beta", a),
        ]);
        dashboard.repos = [repoEntry];
        dashboard.handleInput("2");
        for (let i = 0; i < 4; i++) dashboard.handleInput("j"); // the row under @beta
        expect(dashboard.teamsTree.selectedMember?.teamName).toBe("beta");

        dashboard.handleInput("x");
        dashboard.handleInput("\r"); // "Remove … from @beta" is the default row
        const confirm = assertDialog(dashboard.dialog, "confirm");
        expect(confirm.prompt).toBe(`Remove ${a.repoName}/agent-two from @beta?`);
        expect(confirm.focusedButton).toBe("cancel");
        // Still nothing removed.
        expect((await readTeams()).teams["beta"]!.members).toEqual(["agent-two"]);

        dashboard.handleInput("\t"); // to [ Remove ]
        dashboard.handleInput("\r");
        await dashboard.flushPendingActions();

        const reg = await readTeams();
        expect(reg.teams["beta"]!.members).toEqual([]);
        expect(reg.teams["alpha"]!.members).toEqual(["agent-two"]);
        // Removed from a team, not retired.
        expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
        expect(dashboard.dialog).toBeNull();
      } finally {
        await rm(repoTmp, { recursive: true, force: true });
      }
    });

    test("'x' on a member row the mirror highlighted (Agents tree owns the selection) opens the picker too", () => {
      const a = makeAgent("agent-tm1", "/tmp/repo-x");
      const dashboard = dashboardWith([a], [header("backend"), member("backend", a)]);
      dashboard.handleInput("j"); // select the agent in the Agents tab
      dashboard.handleInput("2"); // show Teams: the mirror highlights its member row
      expect(dashboard.activeSelectionSource).toBe("agents");
      expect(dashboard.teamsTree.selectedMember?.teamName).toBe("backend");

      dashboard.handleInput("x");
      expect(assertDialog(dashboard.dialog, "select").items[0]).toBe(`Remove ${a.repoName}/agent-tm1 from @backend`);
    });

    test("the mirror never highlights ANOTHER repo's same-id agent, and 'x' acts on the selected agent", () => {
      // api/review is selected in the Agents tab and is on no team; the
      // roster's "review" is web/review. The mirror matches by fully
      // qualified id, so it leaves web/review's row alone.
      const selected = makeAgent("review", "/tmp/repo-api");
      selected.repoName = "api";
      const twin = makeAgent("review", "/tmp/repo-web");
      twin.repoName = "web";
      const dashboard = dashboardWith([selected], [header("backend"), member("backend", twin)]);
      dashboard.handleInput("j"); // select api/review in the Agents tab
      dashboard.handleInput("2"); // no Teams row is this agent's
      expect(dashboard.activeSelectionSource).toBe("agents");
      expect(dashboard.agentTree.selectedAgent).toBe(selected);
      expect(dashboard.teamsTree.selectedMember).toBeNull();

      // No picker offering to remove or retire web/review: `x` is the retire
      // confirm for the Agents-tree selection, as before the picker existed.
      dashboard.handleInput("x");
      expect(assertDialog(dashboard.dialog, "confirm").prompt).toBe("Retire agent review?");
      dashboard.handleInput("\x1b");

      // Once j/k puts the selection on the row itself, the row is the
      // selection and the picker is for web/review.
      dashboard.handleInput("j");
      dashboard.handleInput("j");
      expect(dashboard.activeSelectionSource).toBe("teams");
      expect(dashboard.teamsTree.selectedMember?.agent).toBe(twin);
      dashboard.handleInput("x");
      expect(assertDialog(dashboard.dialog, "select").items).toEqual([
        "Remove web/review from @backend",
        "Retire web/review…",
      ]);
    });

    test("'x' with the Agents or Favorites tab showing is the retire confirm, as before", () => {
      const a = makeAgent("agent-tm1", "/tmp/repo-x");
      for (const tab of ["1", "3"]) {
        // The Teams tree owns the member selection, but its tab is not showing.
        const dashboard = dashboardWith([a], [header("backend"), member("backend", a)]);
        dashboard.handleInput("2");
        dashboard.handleInput("j");
        dashboard.handleInput("j");
        dashboard.handleInput(tab);
        expect(dashboard.activeSelectionSource).toBe("teams");
        dashboard.handleInput("x");
        expect(assertDialog(dashboard.dialog, "confirm").prompt).toBe("Retire agent agent-tm1?");
      }

      // And the plain case: an agent selected in the Agents tab that happens
      // to be on a team.
      const dashboard = dashboardWith([a], [header("backend"), member("backend", a)]);
      dashboard.handleInput("j");
      expect(dashboard.teamsTree.selectedMember?.teamName).toBe("backend"); // mirrored, not showing
      dashboard.handleInput("x");
      expect(assertDialog(dashboard.dialog, "confirm").prompt).toBe("Retire agent agent-tm1?");
    });

    test("'x' on a team anchor still opens the manage-team picker", async () => {
      const { createTeam, addMember } = await import("../teams");
      await createTeam("backend", "user", 1700000000);
      await addMember("backend", "agent-tm1");
      const a = makeAgent("agent-tm1", "/tmp/repo-x");
      const dashboard = dashboardWith([a], [header("backend"), member("backend", a)]);
      dashboard.handleInput("2");
      dashboard.handleInput("j"); // the @backend anchor
      dashboard.handleInput("x");
      await dashboard.flushPendingActions();
      const d = assertDialog(dashboard.dialog, "select");
      expect(d.prompt).toBe("Manage team @backend");
      expect(d.items[0]).toBe("Disband team @backend");
    });

    test("'t' on a member row offers 'Remove from @<team>' for the ROW's agent, without an Agents-tree row", async () => {
      const { createTeam, addMember } = await import("../teams");
      await createTeam("alpha", "user", 1700000000);
      await createTeam("beta", "user", 1700000000);
      await addMember("beta", "agent-tm1");
      const a = makeAgent("agent-tm1", "/tmp/repo-x");
      // No Agents-tree row for the agent (as for a per-repo coordinator).
      const dashboard = dashboardWith([], [header("alpha"), header("beta"), member("beta", a)]);
      dashboard.handleInput("2");
      for (let i = 0; i < 3; i++) dashboard.handleInput("j");
      expect(dashboard.agentTree.selectedAgent).toBeNull();

      dashboard.handleInput("t");
      // The picker opens in a .then off listTeams(), not via executeAndRefresh.
      await waitFor(() => dashboard.dialog !== null, {
        timeoutMs: WAIT_TIMEOUT_MS,
        message: "the team picker dialog to open",
      });
      const d = assertDialog(dashboard.dialog, "fuzzy");
      expect(d.prompt).toBe("Team for agent-tm1:");
      expect(d.allItems).toEqual(["alpha", "Remove from @beta", "+ Create new team…"]);
    });
  });
});

describe("pinned-width resize side-effects", () => {
  /**
   * Install a tmux mock that records `tmux resize-window -t <target> -x <width>`
   * calls and answers `list-clients`, driven through the tmux-poller spawnCtx
   * seam (the same context resizeTmuxWindow + hasAttachedClient use). Returns
   * the recorder, which the CALLING TEST owns.
   *
   * Per-test ownership is the point. These tests drive fire-and-forget async
   * work (resizeTmuxWindow and hasAttachedClient are unawaited by the code
   * under test), and bun does not cancel a test's continuation when it times
   * out — it abandons it and starts the next test, so the orphan resumes
   * later, in the middle of a DIFFERENT test. While the recording array was a
   * describe-scoped `let` emptied in beforeEach, that orphan read and wrote the
   * next test's fixture: the observed failure was this describe's first test
   * timing out and then reporting "Expected: 3, Received: 1" as an "Unhandled
   * error between tests", i.e. against the wrong test's data entirely. Because
   * the runner closure below captures the array it created, an orphan can only
   * ever touch its own recording, so a slow or timed-out test cannot corrupt a
   * later one no matter when it resumes. (The file-scope afterEach separately
   * stops the dashboards, which kills the repeating writers — the coordinator
   * pollers and the 3s client-attach check.)
   */
  function installTmuxRecorder() {
    const resizes: { session: string; width: number }[] = [];
    // Held in an object, not a closed-over `let`, purely so the accessor below
    // reads the same box the runner does.
    const live = { clientsAttached: false };
    tmuxPollerSpawnCtx.set((cmd: string[]) => {
      if (cmd[1] === "resize-window") {
        const tIdx = cmd.indexOf("-t");
        const xIdx = cmd.indexOf("-x");
        // tmuxSessionTarget wraps the name as "=<session>:" — unwrap it.
        const target = (cmd[tIdx + 1] ?? "").replace(/^=/, "").replace(/:$/, "");
        resizes.push({ session: target, width: Number(cmd[xIdx + 1]) });
        return makeSpawnResult(0);
      }
      if (cmd[1] === "list-clients") {
        return makeSpawnResult(0, live.clientsAttached ? "client-0\n" : "");
      }
      // has-session / capture-pane / anything else: succeed with empty output.
      return makeSpawnResult(0);
    });
    return {
      /** Every resize recorded so far, in order. */
      all: resizes,
      /** Resizes recorded for one session — the shape every assertion here checks. */
      forSession: (session: string) => resizes.filter((r) => r.session === session),
      /** What the next `tmux list-clients` should report. */
      setClientsAttached(attached: boolean) { live.clientsAttached = attached; },
      /** Drop everything recorded so far (this array, never a later test's). */
      clear() { resizes.length = 0; },
    };
  }

  /**
   * Track every coordinator client-attach check the dashboard starts, so a
   * test can wait for all of them to finish before it changes the live tmux
   * state or asserts.
   *
   * Making a coordinator pane visible fires one immediate check that the
   * dashboard does NOT await (updateCoordinatorClientCheck), and the 3s
   * interval it starts fires more. Each check samples `list-clients` when it
   * starts and writes the cached attach state when it finishes, so when two
   * checks overlap after sampling different live states, the one that
   * finishes LAST wins the cache. Starting first does not mean finishing
   * first, even with the mocked tmux: hasAttachedClient's
   * `await new Response(proc.stdout).text()` resolves an empty stream later
   * than a non-empty one (measured on Bun 1.3.14: 3 microtask turns against
   * 1), so an earlier check that read "no client" finishes after a later one
   * that read "client-0" and overwrites it with a stale `false`. Bun 1.3.10
   * finished the same pair in the other order, which is how these tests used
   * to pass while silently depending on it.
   *
   * Shadowing the method on the instance catches every caller: the immediate
   * check and the interval both call this.checkCoordinatorClients(), and the
   * test's own explicit checks go through it too.
   */
  function trackCoordinatorChecks(dashboard: DashboardComponent) {
    const started: Promise<void>[] = [];
    const run = dashboard.checkCoordinatorClients.bind(dashboard);
    dashboard.checkCoordinatorClients = () => {
      const check = run();
      started.push(check);
      return check;
    };
    return {
      /** Resolve once every check started so far has finished. */
      async settle() {
        let seen = -1;
        while (seen !== started.length) {
          seen = started.length;
          await Promise.all(started);
        }
      },
    };
  }

  afterEach(() => {
    tmuxPollerSpawnCtx.reset();
  });

  test("re-pin migration resizes every live agent + the system coordinator once, to 1000", async () => {
    const tmux = installTmuxRecorder();
    const dashboard = makeDashboard();
    const agentA = makeAgent("agent-a", "/repos/test");
    const agentB = makeAgent("agent-b", "/repos/test");
    const sessionA = agentA.meta.tmux_session!;
    const sessionB = agentB.meta.tmux_session!;
    const flatList: FlatEntry[] = [makeFlatAgent(agentA), makeFlatAgent(agentB)];

    // Arm the one-time migration (boot path calls this) and fire the first update.
    dashboard.requestTmuxRepin();
    dashboard.onUpdate([agentA, agentB], flatList, []);

    // Wait for the three re-pins the assertions below check — the real
    // condition — not for a fixed number of event-loop turns. onUpdate fires
    // resizeTmuxWindow() and hasAttachedClient() without awaiting them, and the
    // turn count it takes those to reach the recorder is an implementation
    // detail; the two-turn guess this replaces (`await Promise.resolve()` then
    // `await setTimeout(0)`) held only on an idle machine. Under load a single
    // setTimeout(0) turn was measured taking seconds, blowing the whole test's
    // time budget before the assertions ran. This wait returns the instant the
    // recorder holds what the test is about to assert, so it is both more
    // robust and faster.
    await waitFor(
      () =>
        tmux.forSession(sessionA).length === 1
        && tmux.forSession(sessionB).length === 1
        && tmux.forSession(IB_COORDINATOR_SESSION).length === 1,
      {
        timeoutMs: WAIT_TIMEOUT_MS,
        message: "the re-pin migration to resize agent-a, agent-b and the system coordinator",
      },
    );

    // Every live agent session + the system coordinator pinned to 1000.
    expect(tmux.forSession(sessionA)).toEqual([{ session: sessionA, width: 1000 }]);
    expect(tmux.forSession(sessionB)).toEqual([{ session: sessionB, width: 1000 }]);
    expect(tmux.forSession(IB_COORDINATOR_SESSION)).toEqual([
      { session: IB_COORDINATOR_SESSION, width: 1000 },
    ]);
    // Every recorded resize is the pin width — nothing follows a display pane.
    expect(tmux.all.every((r) => r.width === 1000)).toBe(true);

    // Idempotent: a SECOND update does NOT re-run the migration. This is a
    // NEGATIVE assertion — "no further resize is recorded" names no condition
    // that can be polled for, so it gets the one legitimate fixed wait in this
    // test: a single turn for anything the second onUpdate might have queued,
    // then a count that must not have moved.
    const before = tmux.all.length;
    dashboard.onUpdate([agentA, agentB], flatList, []);
    await Bun.sleep(0);
    expect(tmux.all.length).toBe(before);
  });

  test("migration re-pins the system coordinator even when there are ZERO agents", async () => {
    const tmux = installTmuxRecorder();
    const dashboard = makeDashboard();
    dashboard.requestTmuxRepin();
    dashboard.onUpdate([], [], []); // empty flatList
    // Wait on the coordinator re-pin itself — the assertion that follows.
    await waitFor(() => tmux.forSession(IB_COORDINATOR_SESSION).length === 1, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the migration to re-pin the system coordinator with zero agents",
    });
    expect(tmux.forSession(IB_COORDINATOR_SESSION)).toEqual([
      { session: IB_COORDINATOR_SESSION, width: 1000 },
    ]);
  });

  test("coordinator detach transition re-pins the displayed coordinator once, to 1000", async () => {
    const tmux = installTmuxRecorder();
    const dashboard = makeDashboard();
    const checks = trackCoordinatorChecks(dashboard);
    // Make the system coordinator the displayed pane so checkCoordinatorClients
    // considers IB_COORDINATOR_SESSION (onUpdate auto-selects it).
    //
    // Selecting it also makes updateCoordinatorClientCheck start the 3s
    // client-attach interval and fire one immediate, UNAWAITED check, which
    // samples "no client". Let it finish before tick 1 stages an attach. Left
    // running, it overlaps tick 1 and can finish after it (see
    // trackCoordinatorChecks): it then reads wasAttached=true from tick 1,
    // records the detach re-pin itself with its stale "no client", and tick 2
    // finds no transition left to observe. The interval it started is
    // cancelled by the file-scope afterEach (stopPolling), which is what stops
    // it ticking into a later test's recorder.
    dashboard.onUpdate([], [makeFlatSystemCoordinator()], []);
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    await checks.settle();
    // Ignore any resizes from selection wiring (there should be none — the pin
    // means nothing follows the pane) so the assertions below measure only the
    // detach transition.
    tmux.clear();

    // Tick 1: a client is attached — record the attached state, no re-pin.
    tmux.setClientsAttached(true);
    await dashboard.checkCoordinatorClients();
    expect(tmux.forSession(IB_COORDINATOR_SESSION)).toEqual([]);

    // Tick 2: the client detached — exactly one re-pin to 1000.
    tmux.setClientsAttached(false);
    await dashboard.checkCoordinatorClients();
    expect(tmux.forSession(IB_COORDINATOR_SESSION)).toEqual([
      { session: IB_COORDINATOR_SESSION, width: 1000 },
    ]);

    // Tick 3: still detached — no duplicate re-pin (transition already consumed).
    await dashboard.checkCoordinatorClients();
    expect(tmux.forSession(IB_COORDINATOR_SESSION).length).toBe(1);
  });

  test("detach that happens WHILE the coordinator is off-screen still re-pins on return (state preserved across visibility)", async () => {
    // The missed-detach scenario: attach observed while visible → navigate away
    // (pane hidden, timer stops) → Ghostty detaches while away → navigate back.
    // The last-observed attach state must survive the away period so the return
    // check sees the attached→detached transition and re-pins. If _coordClient-
    // Attached were dropped on hide, wasAttached would read false on return and
    // the window would stay stuck at the Ghostty width forever.
    const tmux = installTmuxRecorder();
    const dashboard = makeDashboard();
    const checks = trackCoordinatorChecks(dashboard);
    const agent = makeAgent("agent-a", "/repos/test");

    // Visible + attached: observe the attached state (no re-pin yet).
    // Selecting the coordinator fires an immediate UNAWAITED check that samples
    // "no client". Let it finish before staging the attach. Left running, it
    // can finish after the explicit check below (see trackCoordinatorChecks),
    // overwrite attached=true with its stale false and re-pin while we are
    // away, which also erases the attach state this test needs preserved.
    dashboard.onUpdate([], [makeFlatSystemCoordinator()], []);
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    await checks.settle();
    tmux.setClientsAttached(true);
    await dashboard.checkCoordinatorClients();
    tmux.clear();

    // Navigate AWAY (select a regular agent): the coordinator is no longer
    // visible, so a check now computes no visible coordinator sessions and does
    // not touch its preserved attach state.
    dashboard.onUpdate([agent], [makeFlatAgent(agent)], []);
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(false);
    // Ghostty detaches while we're away.
    tmux.setClientsAttached(false);
    await dashboard.checkCoordinatorClients(); // no visible coord → no-op, state kept
    expect(tmux.forSession(IB_COORDINATOR_SESSION)).toEqual([]);

    // Navigate BACK to the coordinator: the re-selection's immediate check
    // meets the preserved wasAttached=true with the now-detached live state
    // → exactly one re-pin. Settle that check instead of polling for the
    // re-pin, so the count asserted is final, not just the first value a
    // poll happened to see.
    dashboard.onUpdate([], [makeFlatSystemCoordinator()], []);
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    await checks.settle();
    expect(tmux.forSession(IB_COORDINATOR_SESSION)).toEqual([
      { session: IB_COORDINATOR_SESSION, width: 1000 },
    ]);
    // Exactly one re-pin total across the return: a further check while still
    // detached finds the transition already consumed and does not re-pin.
    await dashboard.checkCoordinatorClients();
    expect(tmux.forSession(IB_COORDINATOR_SESSION)).toEqual([
      { session: IB_COORDINATOR_SESSION, width: 1000 },
    ]);
  });
});

describe("Git Status commit count (§11.4)", () => {
  afterEach(() => {
    gitStatusSpawnCtx.reset();
  });

  /**
   * Fake git for the Git Status probes. Returns the array it records every
   * `rev-list` range into, and answers 5 for a range against `main` and 3 for
   * a range against a manager's branch, so a test can tell the two apart.
   */
  function fakeGit(): string[] {
    const ranges: string[] = [];
    gitStatusSpawnCtx.set((cmd: string[]) => {
      if (cmd.includes("rev-list")) {
        const range = cmd[cmd.length - 1]!;
        ranges.push(range);
        return makeSpawnResult(0, range.startsWith("main..") ? "5\n" : "3\n");
      }
      if (cmd.includes("rev-parse")) return makeSpawnResult(0, "abc1234\n");
      return makeSpawnResult(0, "");
    });
    return ranges;
  }

  test("counts against the manager's branch for an agent with a manager", async () => {
    const ranges = fakeGit();
    const dashboard = makeDashboard();
    const child = makeAgent("agent-child", "/tmp/repo-git-count");
    child.meta.manager = "agent-mgr";
    dashboard.onUpdate([child], [makeFlatAgent(child)], []);

    await waitFor(() => dashboard.infoPanel.gitCommitCount === 3, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the commit count against the manager's branch",
    });
    expect(ranges).toEqual(["agent/agent-mgr..HEAD"]);
    expect(dashboard.infoPanel.gitHead).toBe("abc1234");
  });

  test("counts against main for an agent with no manager", async () => {
    const ranges = fakeGit();
    const dashboard = makeDashboard();
    const top = makeAgent("agent-top", "/tmp/repo-git-count");
    top.meta.manager = null;
    dashboard.onUpdate([top], [makeFlatAgent(top)], []);

    await waitFor(() => dashboard.infoPanel.gitCommitCount === 5, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the commit count against main",
    });
    expect(ranges).toEqual(["main..HEAD"]);
  });

  test("a selection change clears the count, then probes the new agent", async () => {
    const ranges = fakeGit();
    const dashboard = makeDashboard();
    const top = makeAgent("agent-top", "/tmp/repo-git-count");
    top.meta.manager = null;
    const child = makeAgent("agent-child", "/tmp/repo-git-count");
    child.meta.manager = "agent-mgr";
    dashboard.onUpdate([top, child], [makeFlatAgent(top), makeFlatAgent(child)], []);
    await waitFor(() => dashboard.infoPanel.gitCommitCount === 5, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the first agent's commit count",
    });

    dashboard.agentTree.moveSelection(1);
    dashboard.syncSelectedAgent();
    // Reset is synchronous: the previous agent's count never shows for the new one.
    expect(dashboard.infoPanel.agent?.id).toBe("agent-child");
    expect(dashboard.infoPanel.gitCommitCount).toBeNull();
    expect(dashboard.infoPanel.gitHead).toBeNull();

    await waitFor(() => dashboard.infoPanel.gitCommitCount === 3, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the second agent's commit count",
    });
    expect(ranges).toEqual(["main..HEAD", "agent/agent-mgr..HEAD"]);
  });
});

/** A TUI stand-in that only counts requestRender() calls. */
function countingTui(): { tui: TUI; renders: () => number } {
  let renders = 0;
  const tui = { requestRender: () => { renders++; } } as unknown as TUI;
  return { tui, renders: () => renders };
}

describe("footer clock", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("formats 24-hour HH:MM with no seconds", () => {
    expect(formatFooterClock(new Date(2026, 9, 5, 0, 7, 59))).toBe("00:07");
    expect(formatFooterClock(new Date(2026, 9, 5, 9, 5, 0))).toBe("09:05");
    expect(formatFooterClock(new Date(2026, 9, 5, 23, 59, 30))).toBe("23:59");
  });

  test("the status bar shows HH:MM", () => {
    setSystemTime(new Date(2026, 9, 5, 14, 3, 27));
    const dashboard = makeDashboard();
    const rows = (dashboard as any).statusBar.render(160).map((l: string) => stripAnsi(l));
    expect(rows[1]).toStartWith("14:03  @: jump");
  });

  test("startPolling renders at the next minute boundary, then re-arms for the following one", () => {
    // Hand the timeouts to the test (the poller tests do the same for
    // setInterval), so the boundary render fires without waiting a minute.
    const g = globalThis as unknown as {
      setTimeout: (fn: () => void, ms?: number) => unknown;
      clearTimeout: (handle?: unknown) => void;
    };
    const realSetTimeout = g.setTimeout;
    const realClearTimeout = g.clearTimeout;
    const armed: { fn: () => void; ms: number; handle: object }[] = [];
    g.setTimeout = (fn: () => void, ms = 0) => {
      const handle = {};
      armed.push({ fn, ms, handle });
      return handle;
    };
    g.clearTimeout = (handle?: unknown) => {
      const i = armed.findIndex((a) => a.handle === handle);
      if (i !== -1) armed.splice(i, 1);
      else realClearTimeout(handle);
    };
    try {
      const dashboard = makeDashboard();
      const counter = countingTui();
      dashboard.setTui(counter.tui);
      setSystemTime(new Date(2026, 9, 5, 14, 3, 27, 250));
      dashboard.startPolling();

      // 32.75s to 14:04:00.000.
      const first = armed.find((a) => a.ms === 32_750);
      expect(first).toBeDefined();
      const before = counter.renders();

      setSystemTime(new Date(2026, 9, 5, 14, 4, 0, 10));
      first!.fn();
      expect(counter.renders()).toBe(before + 1);
      // Re-armed from the real clock: 59.99s to 14:05:00.000.
      expect(armed.some((a) => a.ms === 59_990)).toBe(true);

      dashboard.stopPolling();
      expect(armed.some((a) => a.ms === 59_990)).toBe(false);
    } finally {
      g.setTimeout = realSetTimeout;
      g.clearTimeout = realClearTimeout;
    }
  });
});

describe("idle render checks", () => {
  test("setTelegramStatus renders only when the status changes", () => {
    const dashboard = makeDashboard();
    const counter = countingTui();
    dashboard.setTui(counter.tui);

    dashboard.setTelegramStatus("green");
    dashboard.setTelegramStatus("green");
    dashboard.setTelegramStatus("green");
    expect(counter.renders()).toBe(1);

    dashboard.setTelegramStatus("red");
    expect(counter.renders()).toBe(2);
  });

  test("setTelegramConnection drives the light and keeps the view for help; renders only on a light change", () => {
    const dashboard = makeDashboard();
    const counter = countingTui();
    dashboard.setTui(counter.tui);
    const connected = { state: "connected" as const, lastError: null, lastErrorAt: null, outboxPending: 0 };

    dashboard.setTelegramConnection({ state: "connecting", lastError: null, lastErrorAt: null, outboxPending: 0 });
    expect(dashboard.render(160)[0]!).toContain("\x1b[33m●\x1b[0m Telegram");
    dashboard.setTelegramConnection(connected);
    expect(dashboard.render(160)[0]!).toContain("\x1b[32m●\x1b[0m Telegram");
    const rendersBefore = counter.renders();
    // A new error or pending count with the same light: the view updates for
    // the help panel, but the header does not re-render.
    dashboard.setTelegramConnection({ ...connected, outboxPending: 3 });
    expect(counter.renders()).toBe(rendersBefore);
    expect(dashboard.telegramConnection?.outboxPending).toBe(3);
    dashboard.setTelegramConnection({ state: "reconnecting", lastError: "HTTP 502", lastErrorAt: 1, outboxPending: 3 });
    expect(dashboard.render(160)[0]!).toContain("\x1b[33m●\x1b[0m Telegram");
    dashboard.setTelegramConnection({ state: "disabled", lastError: "bot token rejected (HTTP 401)", lastErrorAt: 1, outboxPending: 0 });
    expect(dashboard.render(160)[0]!).toContain("\x1b[31m●\x1b[0m Telegram");
    dashboard.setTelegramConnection(null);
    expect(stripAnsi(dashboard.render(160)[0]!)).not.toContain("Telegram");
    expect(dashboard.telegramConnection).toBeNull();
  });

  test("setCollectorStatus renders only when the light changes", () => {
    const dashboard = makeDashboard();
    const counter = countingTui();
    dashboard.setTui(counter.tui);

    dashboard.setCollectorStatus(collectorHealth("green", 900));
    // Every 5s probe sees a new heartbeat age; the light is unchanged.
    dashboard.setCollectorStatus(collectorHealth("green", 1100));
    dashboard.setCollectorStatus(collectorHealth("green", 700));
    expect(counter.renders()).toBe(1);
    // The newest probe is kept for the help panel even without a render.
    expect(dashboard.collectorStatus?.heartbeatAgeMs).toBe(700);

    dashboard.setCollectorStatus(collectorHealth("yellow", 12_000));
    expect(counter.renders()).toBe(2);
  });

  test("setRemoteControlStatus renders only when the light changes", () => {
    const dashboard = makeDashboard();
    const counter = countingTui();
    dashboard.setTui(counter.tui);

    // Hidden before the first probe and hidden after it: nothing to draw.
    dashboard.setRemoteControlStatus(remoteControl("off"));
    dashboard.setRemoteControlStatus(remoteControl("off"));
    expect(counter.renders()).toBe(0);

    dashboard.setRemoteControlStatus(remoteControl("pending-on"));
    expect(counter.renders()).toBe(1);
    // Still yellow; the newest probe is kept for the help panel without a render.
    dashboard.setRemoteControlStatus(remoteControl("pending-on"));
    dashboard.setRemoteControlStatus(remoteControl("pending-off"));
    expect(counter.renders()).toBe(1);
    expect(dashboard.remoteControlStatus?.state).toBe("pending-off");

    dashboard.setRemoteControlStatus(remoteControl("on"));
    expect(counter.renders()).toBe(2);
    dashboard.setRemoteControlStatus(remoteControl("off"));
    expect(counter.renders()).toBe(3);
  });

  test("a refreshed Teams tree renders only when the Teams tree can be on screen", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "itsybitsy-teams-render-"));
    setUserHome(tempHome);
    try {
      const dashboard = makeDashboard();
      const counter = countingTui();
      dashboard.setTui(counter.tui);

      // Agents tab, Agents selection: the Teams tree is not drawn.
      await (dashboard as any).refreshTeamsTree([]);
      expect(counter.renders()).toBe(0);

      // Teams tab visible: the refreshed list must show.
      dashboard.setSidebarMode("teams");
      await (dashboard as any).refreshTeamsTree([]);
      expect(counter.renders()).toBe(1);

      // Agents tab again, but the Teams tree owns the selection (main area).
      dashboard.setSidebarMode("agents");
      dashboard.setActiveSelectionSource("teams");
      await (dashboard as any).refreshTeamsTree([]);
      expect(counter.renders()).toBe(2);
    } finally {
      resetUserHome();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("an unchanged usage reading does not render", async () => {
    const reading = { sessionPct: 10, weeklyPct: 20, sessionReset: "1h", weeklyReset: "2d" };
    let current = { ...reading };
    // A Codex log reading that resets in 30d 0h 30m, so its "30d 0h" text does not change between refreshes.
    const codexLog = {
      rateLimits: { primary: { used_percent: 30, window_minutes: 10080, resets_at: Date.now() / 1000 + 30 * 86_400 + 1_800 }, secondary: null },
      observedAtMs: Date.now(),
    };
    usageFetchCtx.set({
      readClaudeUsage: async () => ({ data: { ...current }, error: false }),
      fetchGeminiUsage: async () => ({ data: null, error: false }),
      readCodexLogUsage: async () => ({ ...codexLog }),
      fetchCodexLiveUsage: async () => ({ reading: null, error: "inert test fetcher" }),
    });
    const dashboard = makeDashboard();
    const counter = countingTui();
    dashboard.setTui(counter.tui);

    // The first readings render once each: claude, then codex.
    (dashboard as any).refreshUsage();
    await waitFor(() => (dashboard as any).statusBar.claudeUsage !== null && (dashboard as any).statusBar.codexUsage !== null, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the first claude and codex usage readings",
    });
    expect(counter.renders()).toBe(2);

    // Same values in new objects: no render.
    (dashboard as any).refreshUsage();
    await Bun.sleep(25);
    expect(counter.renders()).toBe(2);

    current = { ...reading, sessionPct: 11 };
    (dashboard as any).refreshUsage();
    await waitFor(() => (dashboard as any).statusBar.claudeUsage.sessionPct === 11, {
      timeoutMs: WAIT_TIMEOUT_MS,
      message: "the changed claude usage reading",
    });
    expect(counter.renders()).toBe(3);
  });

  test("a coordinator pane reset is refilled by the next poll even when the capture is unchanged", async () => {
    // The pollers deliver only changed output. resetForAgent() (run after a
    // coordinator restart) clears the pane on the SAME session, so without a
    // re-delivery a still-dead coordinator would sit on "Waiting for output..."
    // instead of "Session stopped".
    tmuxPollerSpawnCtx.set(() => makeSpawnResult(1));
    try {
      const dashboard = makeDashboard();
      dashboard.startPolling();
      dashboard.onUpdate([], [makeFlatSystemCoordinator()], []);
      expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
      await waitFor(() => dashboard.coordinatorPane.hasPolled, {
        timeoutMs: WAIT_TIMEOUT_MS,
        message: "the coordinator pane's first (failed) capture",
      });
      expect(dashboard.coordinatorPane.rawOutput).toBe("");

      dashboard.coordinatorPane.resetForAgent();
      expect(dashboard.coordinatorPane.hasPolled).toBe(false);
      // The next 1s tick captures the same failure and must deliver it.
      await waitFor(() => dashboard.coordinatorPane.hasPolled, {
        timeoutMs: WAIT_TIMEOUT_MS,
        message: "the capture after the pane reset",
      });
      expect(dashboard.coordinatorPane.rawOutput).toBe("");
    } finally {
      tmuxPollerSpawnCtx.reset();
    }
  });
});

/**
 * A real pi-tui TUI over an inert terminal. It is stopped, so the render
 * that showOverlay() schedules never reaches doRender() (which writes a
 * crash log under the real home on an over-width row); the test runs
 * compositeOverlays() itself — the exact step doRender takes between
 * render() and its width check. compositeOverlays is private in the typings.
 */
function overlayTui(width: number, height: number): { tui: TUI; composite: (lines: string[]) => string[] } {
  const terminal = {
    start() {}, stop() {}, async drainInput() {}, write() {},
    get columns() { return width; }, get rows() { return height; },
    get kittyProtocolActive() { return false; },
    moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {},
  };
  const tui = new TUI(terminal);
  tui.stop();
  const internals = tui as unknown as { compositeOverlays(lines: string[], width: number, height: number): string[] };
  return { tui, composite: (lines) => internals.compositeOverlays(lines, width, height) };
}

describe("tabs on screen under an overlay", () => {
  // pi-tui's visibleWidth() counts \t as 3 columns, but the slicing it uses to
  // composite an overlay onto a row counts it as 0. A tab on a row under an
  // overlay (or inside the overlay) made that row 3 columns too wide, and
  // doRender threw "Rendered line N exceeds terminal width". Seen live: the
  // command palette over AGENT LOG showing a codex stderr Ruby backtrace.
  const WIDTH = 160;
  const ROWS = 30;
  // At 160x30 the 80-column command palette covers columns 40-119 of rows
  // 10-18. A tab in those columns is cut out with them; a tab left or right of
  // them on a palette row overflows that row. Every fixture below places its
  // tabs so (checked with the fix reverted): each case overflows 5-9 rows.
  // The narrow right pane starts at column 142: a tab-first line, one row each.
  const narrowLines = (): string[] => Array.from({ length: 40 }, (_, i) => `\tfrom x.rb:${i}`);
  // Full-width views start their text at column 62: the tab is 60 columns in.
  const wideLines = (): string[] => Array.from({ length: 40 }, (_, i) => `${"x".repeat(60)}\tfrom x.rb:${i}`);

  let origRows: number;
  beforeEach(() => {
    origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: ROWS, writable: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
  });

  /** A dashboard on the overlay TUI, with `agents` in the tree (the first selected). */
  function dashboardWith(agents: Agent[]): { dashboard: DashboardComponent; composite: (lines: string[]) => string[] } {
    const dashboard = makeDashboard();
    const { tui, composite } = overlayTui(WIDTH, ROWS);
    dashboard.setTui(tui);
    dashboard.onUpdate(agents, agents.map((agent) => makeFlatAgent(agent)), []);
    return { dashboard, composite };
  }

  /** Render, composite the open overlay, and check no row overflows and no tab reaches the screen. */
  function expectRowsFit(dashboard: DashboardComponent, composite: (lines: string[]) => string[], overlayTitle: string) {
    const rendered = dashboard.render(WIDTH);
    expect(stripAnsi(rendered.join("\n"))).toContain("from x.rb");
    const rows = composite(rendered);
    expect(stripAnsi(rows.join("\n"))).toContain(overlayTitle);
    const overWidth = rows.map((row, i) => ({ i, width: visibleWidth(row) })).filter((r) => r.width > WIDTH);
    expect(overWidth).toEqual([]);
    expect(rows.filter((row) => row.includes("\t"))).toEqual([]);
  }

  test("witness: pi-tui overflows a row whose tab is beside an overlay", () => {
    // No expansion anywhere: this proves the harness reproduces pi-tui's bug,
    // and fails loudly if an upgrade changes how pi-tui slices a tab.
    const { tui, composite } = overlayTui(WIDTH, ROWS);
    tui.showOverlay({ render: (width: number) => ["#".repeat(width)], invalidate() {} }, { width: 80, anchor: "center" });
    const base = Array.from({ length: ROWS }, () => `${"a".repeat(130)}\t${"b".repeat(27)}`);
    expect(visibleWidth(base[0]!)).toBe(WIDTH);
    expect(composite(base).map((row) => visibleWidth(row)).filter((width) => width > WIDTH)).toEqual([WIDTH + 3]);
  });

  // Every right-pane view that shows file or command text. DIFF / STATUS are
  // filled before jumpToMode so it does not spawn `ib diff` / `ib status`.
  const views: { mode: PaneMode; fill: (rp: RightPaneComponent, lines: string[]) => void }[] = [
    { mode: "AGENT LOG", fill: (rp, lines) => { rp.agentLogContent = lines; } },
    { mode: "WATCHDOG LOG", fill: (rp, lines) => { rp.watchdogLogContent = lines; } },
    { mode: "PROXY LOG", fill: (rp, lines) => { rp.proxyLogContent = lines; } },
    { mode: "INITIAL PROMPT", fill: (rp, lines) => { rp.promptContent = lines; } },
    { mode: "DENIALS", fill: (rp, lines) => {
      rp.denialsContent = lines.map((line) => ({ timestamp: "13:00:00", epoch: 0, line: `[13:00:00] ${line}` }));
    } },
    { mode: "ERRORS", fill: (rp, lines) => { rp.errors = lines; } },
    { mode: "DIFF", fill: (rp, lines) => { rp.diffContent = lines; } },
    { mode: "STATUS", fill: (rp, lines) => { rp.statusContent = lines; } },
    { mode: "QUESTIONS", fill: (rp, lines) => {
      rp.questions = lines.map((question, i) => ({ id: `q${i}`, agent: "agent-a", question, timestamp: "", status: "pending", repoPath: "/repos/test" }));
    } },
  ];

  for (const { mode, fill } of views) {
    test(`${mode}: every row fits the terminal with the command palette open`, () => {
      const { dashboard, composite } = dashboardWith([makeAgent("agent-a", "/repos/test")]);
      fill(dashboard.rightPane, FULL_WIDTH_MODES.has(mode) ? wideLines() : narrowLines());
      dashboard.jumpToMode(mode);
      dashboard.handleInput("/");
      expectRowsFit(dashboard, composite, "Command palette");
    });
  }

  // Tree rows and @-jump items show `meta.summary ?? meta.prompt` unexpanded.
  const tabPromptAgents = (prompt: (i: number) => string): Agent[] => Array.from({ length: 20 }, (_, i) => {
    const agent = makeAgent(`agent-${i}`, "/repos/test");
    agent.meta.prompt = prompt(i);
    return agent;
  });

  test("TREE: every row fits the terminal with the command palette open", () => {
    // Each tree row's tab lands at column 129; the selected agent's sidebar
    // Summary adds one at column 26.
    const { dashboard, composite } = dashboardWith(tabPromptAgents((i) => `Fix the crash. Backtrace:\n\tfrom x.rb:${i}`));
    dashboard.jumpToMode("TREE");
    dashboard.handleInput("/");
    expectRowsFit(dashboard, composite, "Command palette");
  });

  test("@ jump dialog: its own rows fit the terminal", () => {
    // The dialog IS the overlay, so a tab in one of its items overflows at any column.
    const { dashboard, composite } = dashboardWith(tabPromptAgents((i) => `\tfrom x.rb:${i}`));
    dashboard.handleInput("@");
    expectRowsFit(dashboard, composite, "Jump to agent, repo, or coordinator");
  });
});

// The folder browser's [ New Repo ] asks for a folder name in an `input`
// dialog, whose prompt is drawn as the title in the top border.
describe("New Repo folder-name dialog title", () => {
  function topBorder(parentPath: string): string {
    const dashboard = makeDashboard();
    dashboard.showDialog({ type: "input", prompt: newRepoPrompt(parentPath), value: "", onSubmit: () => {} });
    return stripAnsi((dashboard as any).dialogOverlay.render(DIALOG_WIDTH)[0]);
  }

  test("a long parent path is cut from the left so the title fits the box", () => {
    const parent = "/Users/someone/Developer/clients/acme-corporation/projects/2026/q4/experiments/backend";
    const prompt = newRepoPrompt(parent);
    expect(prompt).toStartWith("New repo in …");
    expect(prompt).toEndWith("/experiments/backend:");
    const border = topBorder(parent);
    expect(border).toContain(` ${prompt} `);
    expect(visibleWidth(border)).toBe(DIALOG_WIDTH);
    expect(border).toEndWith("┐");
  });

  test("a short parent path is shown whole", () => {
    expect(newRepoPrompt("/tmp/projects")).toBe("New repo in /tmp/projects:");
    const border = topBorder("/tmp/projects");
    expect(border).toStartWith("┌─ New repo in /tmp/projects: ─");
    expect(visibleWidth(border)).toBe(DIALOG_WIDTH);
  });
});

const PEERS_SELF = "5e".repeat(32);
const PEERS_OTHER = "0a".repeat(32);

/**
 * A scripted stand-in for the peer service (src/peers/service.ts), for the
 * Peers tab and the tree's remote rows. `set` changes its view and
 * notifies like the real one.
 */
class FakePeerService implements PeersDialogService {
  cancelReceipt = mock((_id: string) => {});
  sendRemoteMessage = mock<PeersDialogService["sendRemoteMessage"]>(async (_id, header) => header.id);
  fetchPane = mock(async (_peerId: string, _target: import("../peers/peer-link").PeerPaneTarget, _lines: number) => ({ state: "running", text: "peer capture" }));
  fetchAgentDiff = mock<PeersDialogService["fetchAgentDiff"]>(async () => { throw new Error("No changes to show — diff is empty"); });
  fetchAgentPrompt = mock<PeersDialogService["fetchAgentPrompt"]>(async (_peerId, _repo, id) => `Prompt for ${id}\nsecond line`);
  remoteStartDenial: string | null = null;
  runRemoteLifecycle: PeersDialogService["runRemoteLifecycle"] = async () => { throw new Error("Unexpected lifecycle request"); };
  acknowledgeRemoteQuestion = mock<PeersDialogService["acknowledgeRemoteQuestion"]>(async () => {});
  startRemoteAgent: PeersDialogService["startRemoteAgent"] = async () => { throw new Error("Unexpected remote start"); };
  state: PeerServiceView = {
    status: { kind: "listening" },
    selfId: PEERS_SELF,
    identityError: null,
    peers: [],
    peersError: null,
    session: null,
    links: [],
  };
  calls: string[] = [];
  private listeners = new Set<() => void>();
  private nextId = 0;

  view(): PeerServiceView {
    return this.state;
  }
  openDialog(): void {
    this.calls.push("open");
  }
  closeDialog(): void {
    this.calls.push("close");
  }
  /** Validates with the real parsePairTarget, so inline errors are the real ones. */
  pairWith(input: string): string | null {
    this.calls.push(`pair:${input}`);
    const target = parsePairTarget(input, this.state.selfId);
    if (!target.ok) return target.error;
    this.setSession("initiator", { stage: "connecting" });
    return null;
  }
  submitCode(code: string): void {
    this.calls.push(`code:${code}`);
  }
  submitName(name: string | null): void {
    this.calls.push(`name:${name}`);
  }
  cancel(): void {
    this.calls.push("cancel");
  }
  dismiss(): void {
    this.calls.push("dismiss");
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(view: Partial<PeerServiceView>): void {
    this.state = { ...this.state, ...view };
    for (const listener of this.listeners) listener();
  }
  /** A new session (new id) in `stage`. */
  setSession(role: "initiator" | "responder", stage: PairStage): void {
    this.set({ session: { id: ++this.nextId, role, peerId: PEERS_OTHER, stage } });
  }
  /** The same session, moved to `stage`. */
  setStage(stage: PairStage): void {
    this.set({ session: { ...this.state.session!, stage } });
  }
}

// The Peers tab (`I`, src/tui/peers-dialog.ts). The dashboard gets a
// scripted fake service, never the real one, so no test here binds an endpoint
// or loads the iroh addon.
describe("setup Peers tab", () => {
  const SELF = PEERS_SELF;
  const OTHER = PEERS_OTHER;
  const OTHER_SHORT = OTHER.slice(0, 10);

  function open(): { dashboard: DashboardComponent; service: FakePeerService } {
    const dashboard = makeDashboard();
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    dashboard.handleInput("I");
    return { dashboard, service };
  }

  function peersTab(dashboard: DashboardComponent) {
    const dialog = assertDialog(dashboard.dialog, "setup");
    expect(dialog.tab).toBe(2);
    expect(dialog.peers).toBeDefined();
    return dialog.peers!;
  }

  function rendered(dashboard: DashboardComponent): string[] {
    return (dashboard as any).dialogOverlay.render(DIALOG_WIDTH) as string[];
  }

  const text = (dashboard: DashboardComponent) => stripAnsi(rendered(dashboard).join("\n"));

  test("I opens setup on Peers and asks the service to start once", () => {
    const { dashboard, service } = open();
    expect(peersTab(dashboard).idValue).toBe("");
    expect(service.calls).toEqual(["open"]);
    const out = text(dashboard);
    expect(out).toContain("┌─ Peers ─");
    expect(out).toContain("[Hooks]  [Config]  [Peers]");
    expect(out).toContain("This install's id");
    expect(out).toContain(SELF);
    expect(out).toContain("accepting pairing requests while this tab is visible");
    expect(out).toContain("Paired peers");
    expect(out).toContain("none yet");
    expect(out).toContain("Pair with id");
    expect(out).toContain("Enter: pair    Esc: close");
  });

  test("only the visible Peers tab opens the service, including after re-entry", () => {
    const dashboard = makeDashboard();
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    dashboard.handleInput("h");
    const tab = () => assertDialog(dashboard.dialog, "setup").tab;
    expect(tab()).toBe(0);
    dashboard.handleInput("\t");
    expect(tab()).toBe(1);
    expect(service.calls).toEqual([]);
    dashboard.handleInput("3");
    expect(tab()).toBe(2);
    expect(service.calls).toEqual(["open"]);
    dashboard.handleInput("\x1b[Z");
    expect(tab()).toBe(1);
    expect(service.calls).toEqual(["open", "close"]);
    dashboard.handleInput("\t");
    expect(tab()).toBe(2);
    dashboard.handleInput("\t");
    expect(tab()).toBe(0);
    dashboard.handleInput("\x1b[Z");
    expect(tab()).toBe(2);
    dashboard.handleInput("\x1b");
    expect(dashboard.dialog).toBeNull();
    expect(service.calls).toEqual(["open", "close", "open", "close", "open", "close"]);
  });

  test.each(["Config", "Peers"])("settings finish loading with %s visible", async visible => {
    const dashboard = makeDashboard();
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    const { promise, resolve } = Promise.withResolvers<settings.ConfigResult>();
    const read = spyOn(settings, "readConfig").mockReturnValue(promise);
    try {
      dashboard.handleInput("h");
      expect(text(dashboard)).toContain("Loading settings…");
      dashboard.handleInput("2");
      expect(text(dashboard)).toContain("Loading settings…");
      expect(text(dashboard)).not.toContain("No configuration keys found");
      await waitFor(() => read.mock.calls.length === 1, { message: "pending settings read" });
      if (visible === "Peers") dashboard.handleInput("3");
      resolve(Object.fromEntries(settings.CONFIG_KEYS.map(def => [def.key, { value: def.default, source: "default" }])));
      await new Promise<void>(done => setImmediate(done));
      if (visible === "Peers") {
        expect(peersTab(dashboard)).toBeDefined();
        expect(service.calls).toEqual(["open"]);
        dashboard.handleInput("\x1b[Z");
      }
      expect(text(dashboard)).toContain(settings.CONFIG_KEYS[0]!.key);
      dashboard.handleInput("1");
      expect(text(dashboard)).toContain("Safety hooks");
      dashboard.handleInput("2");
      expect(text(dashboard)).toContain(settings.CONFIG_KEYS[0]!.key);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  test("Config edits live attachment limits and keeps invalid edits open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-attachment-config-"));
    const path = join(dir, "config.json");
    setUserConfigPath(path);
    const dashboard = makeDashboard();
    try {
      dashboard.handleInput("h");
      dashboard.handleInput("2");
      async function edit(key: string) {
        await waitFor(() => dashboard.dialog?.type === "setup" && !!dashboard.dialog.configItems?.length);
        const setup = assertDialog(dashboard.dialog, "setup");
        setup.configSelectedIndex = setup.configItems!.findIndex(item => item.key === "peering.attachments." + key);
        dashboard.handleInput("\r");
        expect(text(dashboard)).toContain("0 = attachments disabled");
        if (key.endsWith("MB")) expect(text(dashboard)).toContain("MB");
        return assertDialog(dashboard.dialog, "input");
      }
      const file = await edit("maxFileMB");
      for (const [value, reason] of [["1.5", "integer"], ["65537", "between 0 and 65536"], ["2049", "≤ maxMessageMB (2048)"]] as const) {
        file.onSubmit(value);
        await waitFor(() => dashboard.notice?.includes(reason) === true);
        expect(dashboard.dialog).toBe(file);
        expect(await Bun.file(path).exists()).toBe(false);
      }
      dashboard.handleInput("\x1b");
      dashboard.handleInput("h");
      dashboard.handleInput("2");
      (await edit("maxMessageMB")).onSubmit("0");
      const disabled = await edit("maxMessageMB");
      expect(disabled.value).toBe("0");
      expect((await settings.readTransferLimits()).maxMessageBytes).toBe(0);
      disabled.onSubmit("2048");
      const restored = await edit("maxFileMB");
      expect((await settings.readTransferLimits()).maxMessageBytes).toBe(2048 * 1024 ** 2);
      restored.onSubmit("25");
      const message = await edit("maxMessageMB");
      message.onSubmit("24");
      await waitFor(() => dashboard.notice?.includes("≥ maxFileMB (25)") === true);
      message.onSubmit("100");
      const count = await edit("maxFiles");
      count.onSubmit("0");
      await waitFor(() => dashboard.dialog?.type === "setup" && !!dashboard.dialog.configItems?.length);
      expect((await Bun.file(path).json()).peering.attachments).toEqual({ maxFileMB: 25, maxMessageMB: 100, maxFiles: 0 });
      expect(await settings.readTransferLimits()).toEqual({ maxFileBytes: 25 * 1024 ** 2, maxMessageBytes: 100 * 1024 ** 2, maxFiles: 0 });
    } finally {
      resetUserConfigPath();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("saving repos.cloneRoot in Config re-reads the relPath each repo sends to peers", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ib-clone-root-config-")));
    const repoPath = join(dir, "work", "app");
    await mkdir(repoPath, { recursive: true });
    setUserConfigPath(join(dir, "config.json"));
    const dashboard = makeDashboard();
    try {
      dashboard.setRepos([{ name: "app", path: repoPath }]);
      // Under the default ~/Developer root, the repo has no relPath.
      await waitFor(() => dashboard.repoCloneInfo.has(repoPath));
      expect(dashboard.repoCloneInfo.get(repoPath)).toEqual({ remoteUrl: null, relPath: null });

      dashboard.handleInput("h");
      dashboard.handleInput("2");
      await waitFor(() => dashboard.dialog?.type === "setup" && !!dashboard.dialog.configItems?.length);
      const setup = assertDialog(dashboard.dialog, "setup");
      setup.configSelectedIndex = setup.configItems!.findIndex(item => item.key === "repos.cloneRoot");
      dashboard.handleInput("\r");
      assertDialog(dashboard.dialog, "input").onSubmit(dir);
      await waitFor(() => dashboard.repoCloneInfo.get(repoPath)?.relPath === "work/app");
      expect((await Bun.file(join(dir, "config.json")).json()).repos).toEqual({ cloneRoot: dir });
    } finally {
      resetUserConfigPath();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Config shows a stored 512 MB message limit that conflicts with the default file limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-config-repair-"));
    const path = join(dir, "config.json");
    setUserConfigPath(path);
    try {
      await Bun.write(path, JSON.stringify({ peering: { attachments: { maxMessageMB: 512 } } }));
      const dashboard = makeDashboard();
      dashboard.handleInput("h");
      dashboard.handleInput("2");
      await waitFor(() => dashboard.dialog?.type === "setup" && !!dashboard.dialog.configItems?.length);
      const setup = assertDialog(dashboard.dialog, "setup");
      setup.configSelectedIndex = setup.configItems!.findIndex(item => item.key.endsWith(".maxMessageMB"));
      expect(text(dashboard)).toContain("512 (needs repair)");
      dashboard.handleInput("\r");
      expect(assertDialog(dashboard.dialog, "input").value).toBe("512");
      expect(text(dashboard)).toContain("maxMessageMB = 512");
      expect(text(dashboard)).toContain("maxFileMB (1024)");
      await expect(settings.writeConfig(path, "peering.attachments.maxFileMB", 700)).rejects.toThrow("≤ maxMessageMB (512)");
      await settings.writeConfig(path, "peering.attachments.maxFileMB", 512);
      expect((await settings.readTransferLimits()).maxMessageBytes).toBe(512 * 1024 ** 2);
    } finally {
      resetUserConfigPath();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Config displays the malformed companion and enforces its effective budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-attachment-companion-"));
    const path = join(dir, "config.json");
    setUserConfigPath(path);
    const original = JSON.stringify({ peering: { attachments: { maxFileMB: "typo" } } });
    try {
      await Bun.write(path, original);
      const dashboard = makeDashboard();
      dashboard.handleInput("h");
      dashboard.handleInput("2");
      await waitFor(() => dashboard.dialog?.type === "setup" && !!dashboard.dialog.configItems?.length);
      const setup = assertDialog(dashboard.dialog, "setup");
      setup.configSelectedIndex = setup.configItems!.findIndex(item => item.key.endsWith(".maxMessageMB"));
      dashboard.handleInput("\r");
      expect(text(dashboard)).toContain('maxFileMB = "typo" (using 1024)');
      assertDialog(dashboard.dialog, "input").onSubmit("512");
      await waitFor(() => dashboard.notice?.includes("≥ maxFileMB (1024)") === true);
      expect(await Bun.file(path).text()).toBe(original);
    } finally {
      resetUserConfigPath();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Kitty Tab and Shift+Tab cycle setup in both directions", () => {
    const { dashboard, service } = open();
    dashboard.handleInput("\x1b[9u");
    expect(assertDialog(dashboard.dialog, "setup").tab).toBe(0);
    dashboard.handleInput("\x1b[9;2u");
    expect(peersTab(dashboard)).toBeDefined();
    expect(service.calls).toEqual(["open", "close", "open"]);
  });

  test("the numbered tab shortcuts type into every pairing field", () => {
    const { dashboard, service } = open();
    const typeDigits = () => { for (const digit of "123") dashboard.handleInput(digit); };
    typeDigits();
    expect(peersTab(dashboard).idValue).toBe("123");
    service.setSession("initiator", { stage: "code-entry" });
    typeDigits();
    expect(peersTab(dashboard).sessionValue).toBe("123");
    service.setStage({ stage: "naming", savedName: OTHER_SHORT });
    typeDigits();
    expect(peersTab(dashboard).sessionValue).toBe("123");
    expect(service.calls).toEqual(["open"]);
    service.setStage({ stage: "verifying" });
    dashboard.handleInput("1");
    expect(assertDialog(dashboard.dialog, "setup").tab).toBe(0);
    expect(service.calls).toEqual(["open", "close"]);
  });

  test("without a peer service, I shows a notice and opens nothing", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("I");
    expect(dashboard.dialog).toBeNull();
  });

  test("the help lists I, and its whole description fits the help dialog", () => {
    const dashboard = makeDashboard();
    dashboard.handleInput("?");
    const lines = assertDialog(dashboard.dialog, "help").lines.map(stripAnsi);
    expect(lines).toContain(`  ${"I".padEnd(18)}setup: Peers tab (id and pairing)`);
    // The help dialog is 72 wide (68 inside), so the row is drawn uncut.
    const drawn = stripAnsi(((dashboard as any).dialogOverlay.render(72) as string[]).join("\n"));
    expect(drawn).toMatch(/│ {4}I {17}setup: Peers tab \(id and pairing\) +│/);
  });

  test("the / command palette has a peers entry that opens the dialog", () => {
    const dashboard = makeDashboard();
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    dashboard.handleInput("/");
    const palette = assertDialog(dashboard.dialog, "fuzzy");
    const index = palette.allItems.indexOf("setup: Peers tab — I");
    expect(index).toBeGreaterThanOrEqual(0);
    palette.onSelect(index);
    expect(peersTab(dashboard)).toBeTruthy();
    expect(service.calls).toEqual(["open"]);
  });

  test("the idle view lists paired peers and every endpoint status", () => {
    const { dashboard, service } = open();
    service.set({ peers: [{ id: OTHER, name: "Laptop B", pairedAt: "x" }, { id: "1b".repeat(32), name: "C", pairedAt: "y" }] });
    let out = text(dashboard);
    expect(out).toContain(`Laptop B  ${OTHER_SHORT}`);
    expect(out).toContain(`C         ${"1b".repeat(5)}`);
    service.set({ status: { kind: "starting" } });
    expect(text(dashboard)).toContain("starting…");
    service.set({ status: { kind: "disabled", ownerPid: 4242 } });
    expect(text(dashboard)).toContain("peering disabled: ib watch pid 4242 owns the endpoint");
    service.set({ status: { kind: "error", message: "load: dlopen failed", retryAt: null } });
    out = text(dashboard);
    expect(out).toContain("peering unavailable: load: dlopen failed");
    expect(out).not.toContain("retrying");
    // A pending automatic rebind: the countdown, rounded up, and the last error.
    service.set({ status: { kind: "error", message: "load: dlopen failed", retryAt: Date.now() + 9_500 } });
    out = text(dashboard);
    expect(out).toContain("peering unavailable; retrying in 10 s");
    expect(out).toContain("last error: load: dlopen failed");
    service.set({ status: { kind: "error", message: "load: dlopen failed", retryAt: Date.now() - 50 } });
    expect(text(dashboard)).toContain("retrying in 1 s");
    service.set({ selfId: null });
    expect(text(dashboard)).toContain("loading…");
    service.set({ identityError: "secret.key is not 64 lowercase hex characters", peersError: "peers.json: not valid JSON" });
    out = text(dashboard);
    expect(out).toContain("unavailable: secret.key is not 64 lowercase hex characters");
    expect(out).toContain("peers.json: not valid JSON");
  });

  test("shows how to replace a legacy peer name starting with @", () => {
    const { dashboard, service } = open();
    service.set({ peers: [{ id: OTHER, name: "@legacy", pairedAt: "x" }] });
    expect(text(dashboard)).toContain("@legacy");
    expect(text(dashboard)).toContain("Remove and re-pair");
  });

  test("paired peers show a colored link status and the last error under an offline peer", () => {
    const { dashboard, service } = open();
    const C = "1b".repeat(32);
    const D = "2c".repeat(32);
    const E = "3d".repeat(32);
    service.set({
      peers: [
        { id: OTHER, name: "Laptop B", pairedAt: "x" },
        { id: C, name: "C", pairedAt: "x" },
        { id: D, name: "D", pairedAt: "x" },
        { id: E, name: "E", pairedAt: "x" },
      ],
      links: [
        { id: OTHER, name: "Laptop B", connected: true, connectedAt: Date.now(), lastOkAt: Date.now(), coordinator: null, lastError: null, repos: [], agents: [], questions: [] },
        { id: C, name: "C", connected: false, connectedAt: null, lastOkAt: Date.now(), coordinator: null, lastError: "closed by the other side", repos: [], agents: [], questions: [] },
        { id: D, name: "D", connected: false, connectedAt: null, lastOkAt: null, coordinator: null, lastError: "timed out", repos: null, agents: null, questions: null },
      ],
    });
    function expectRow(id: string, word: string, color: string, error?: string) {
      const rows = rendered(dashboard);
      const short = id.slice(0, 10);
      const index = rows.findIndex(row => row.includes(short));
      expect(stripAnsi(rows[index]!)).toContain(`${short}  ${word}`);
      expect(rows[index]).toContain(`${color}${word}${RESET}`);
      if (error) expect(stripAnsi(rows[index + 1]!)).toContain(`    ${error}`);
    }
    expectRow(OTHER, "connected", GREEN);
    expectRow(C, "offline", RED, "closed by the other side");
    expectRow(D, "offline", RED, "timed out");
    expectRow(E, "connecting", YELLOW); // newly paired, before the poller lists it
    service.set({ links: [{ id: E, name: "E", connected: false, connectedAt: null, lastOkAt: null, coordinator: null, lastError: null, repos: null, agents: null, questions: null }] });
    expectRow(E, "connecting", YELLOW); // first dial in progress
  });

  test("a long peer name leaves the short id and status visible at 40 columns", () => {
    const { dashboard, service } = open();
    service.set({ peers: [{ id: OTHER, name: "N".repeat(32), pairedAt: "x" }] });
    const rows = (dashboard as any).dialogOverlay.render(40) as string[];
    const peer = rows.map(stripAnsi).find(row => row.includes(OTHER_SHORT))!;
    expect(peer).toMatch(new RegExp(`N+…  ${OTHER_SHORT}  connecting`));
    expect(visibleWidth(peer)).toBe(40);
  });

  test("with no peer section on screen, a service change renders only while the Peers tab is open", () => {
    const dashboard = makeDashboard();
    // Counts renders, and stands in for the overlay the dialog opens.
    let renders = 0;
    const counter = { renders: () => renders };
    dashboard.setTui({
      requestRender: () => {
        renders++;
      },
      showOverlay: () => ({ hide: () => {} }),
    } as unknown as TUI);
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    const link = { id: OTHER, name: "B", connected: true, connectedAt: Date.now(), lastOkAt: Date.now(), coordinator: null, lastError: null, repos: [], agents: [], questions: [] };
    // The Teams tab draws only its local tree.
    dashboard.setSidebarMode("teams");

    // Closed: the poller's background changes draw nothing.
    service.set({ links: [link] });
    service.set({ links: [{ ...link, connected: false, connectedAt: null, coordinator: null, lastError: "timed out" }] });
    expect(counter.renders()).toBe(0);

    dashboard.handleInput("I");
    const opened = counter.renders();
    service.set({ links: [link] });
    expect(counter.renders()).toBe(opened + 1);
    // The open dialog redraws on every change, one the sections do not show included.
    service.set({ status: { kind: "starting" } });
    expect(counter.renders()).toBe(opened + 2);

    dashboard.handleInput("\x1b[Z"); // Config is visible.
    const hidden = counter.renders();
    service.set({ status: { kind: "listening" } });
    expect(counter.renders()).toBe(hidden);
    dashboard.handleInput("3");
    const reopened = counter.renders();
    service.set({ status: { kind: "starting" } });
    expect(counter.renders()).toBe(reopened + 1);
    dashboard.handleInput("\x1b");
    const closed = counter.renders();
    service.set({ links: [{ ...link, connected: false, connectedAt: null }] });
    expect(counter.renders()).toBe(closed);
  });

  test("a narrow dialog wraps the full id instead of cutting it", () => {
    const { dashboard } = open();
    const narrow = stripAnsi(((dashboard as any).dialogOverlay.render(40) as string[]).join("\n"));
    expect(narrow.replace(/[│\s]/g, "")).toContain(SELF);
  });

  for (const [label, paste] of [
    ["a bracketed paste", (id: string) => [`\x1b[200~${id}\x1b[201~`]],
    ["a bracketed paste split across reads", (id: string) => [`\x1b[200~${id.slice(0, 30)}`, `${id.slice(30)}\n\x1b[201~`]],
    ["a plain multi-character paste", (id: string) => [id]],
  ] as const) {
    test(`a pasted 64-character id (${label}) fills the input, and Enter pairs with it`, () => {
      const { dashboard, service } = open();
      for (const chunk of paste(`  ${OTHER.toUpperCase()}`)) dashboard.handleInput(chunk);
      const dialog = peersTab(dashboard);
      const typed = dialog.idValue;
      expect(typed.trim()).toBe(OTHER.toUpperCase());
      expect(text(dashboard)).toContain(OTHER.toUpperCase());
      dashboard.handleInput("\r");
      expect(service.calls.at(-1)).toBe(`pair:${typed}`);
      expect(dialog.error).toBeNull();
      expect(dialog.idValue).toBe("");
      expect(text(dashboard)).toContain(`Connecting to ${OTHER_SHORT}…`);
    });
  }

  test("tab switches and digits inside a chunked paste stay in the input", () => {
    const { dashboard, service } = open();
    for (const chunk of ["\x1b[200~id", "\t", "3", "\x1b[201~"]) dashboard.handleInput(chunk);
    expect(peersTab(dashboard).idValue).toBe("id 3");
    expect(service.calls).toEqual(["open"]);
  });

  test("an invalid id shows the error inline; typing clears it", () => {
    const { dashboard } = open();
    for (const ch of "abc123") dashboard.handleInput(ch);
    dashboard.handleInput("\r");
    expect(text(dashboard)).toContain("Not an id: an id is 64 hex characters.");
    dashboard.handleInput("\x7f");
    expect(text(dashboard)).not.toContain("Not an id");
    expect(peersTab(dashboard).idValue).toBe("abc12");
    // This install's own id is refused too.
    peersTab(dashboard).idValue = SELF;
    dashboard.handleInput("\r");
    expect(text(dashboard)).toContain("That is this install's own id.");
  });

  test("initiator: connecting → code entry (with this install's short id) → verifying → naming → result", () => {
    const { dashboard, service } = open();
    service.setSession("initiator", { stage: "connecting" });
    expect(text(dashboard)).toContain(`Connecting to ${OTHER_SHORT}…`);
    expect(text(dashboard)).toContain("Esc: cancel");

    service.setStage({ stage: "code-entry" });
    let out = text(dashboard);
    expect(out).toContain(`${OTHER_SHORT} is showing a pairing code. Type it here.`);
    expect(out).toContain(`Code  (your id: ${SELF.slice(0, 10)})`);
    expect(out).toContain("Enter: send code    Esc: cancel");

    // A malformed code stays local (B allows one attempt) and shows inline.
    for (const ch of "abc") dashboard.handleInput(ch);
    dashboard.handleInput("\r");
    expect(text(dashboard)).toContain("A code is 8 characters, like ABCD-1234.");
    expect(service.calls.some((c) => c.startsWith("code:"))).toBe(false);
    for (const ch of "d-l2o4") dashboard.handleInput(ch);
    dashboard.handleInput("\r");
    expect(service.calls.at(-1)).toBe("code:ABCD1204");

    service.setStage({ stage: "verifying" });
    expect(text(dashboard)).toContain(`Checking the code with ${OTHER_SHORT}…`);

    service.setStage({ stage: "naming", savedName: OTHER_SHORT });
    out = text(dashboard);
    expect(out).toContain(`Paired with ${OTHER_SHORT}.`);
    expect(out).toContain(`Name for ${OTHER_SHORT}:`);
    expect(out).toContain(`Esc: keep "${OTHER_SHORT}"`);
    for (const ch of "Laptop B") dashboard.handleInput(ch);
    dashboard.handleInput("\r");
    expect(service.calls.at(-1)).toBe("name:Laptop B");

    service.setStage({ stage: "done", name: "Laptop B", alreadyPaired: false });
    expect(text(dashboard)).toContain(`Paired with "Laptop B" (${OTHER_SHORT}).`);
    expect(text(dashboard)).toContain("Enter or Esc: return to Peers");
    service.calls = [];
    dashboard.handleInput("x");
    expect(service.calls).toEqual([]);
    dashboard.handleInput("\r");
    expect(service.calls).toEqual(["dismiss"]);
    expect(peersTab(dashboard)).toBeTruthy();
  });

  test("responder: the request with its code, exactly as specified, then naming", () => {
    const { dashboard, service } = open();
    service.setSession("responder", { stage: "incoming" });
    expect(text(dashboard)).toContain(`Pairing request from ${OTHER_SHORT}…`);
    service.setStage({ stage: "code-shown", code: "ABCD1234", expiresAt: 0 });
    expect(text(dashboard)).toContain(`Pairing request from ${OTHER_SHORT}. Code: ABCD-1234. Expires in 2 min.`);
    expect(text(dashboard)).toContain("Esc: cancel");
    service.setStage({ stage: "naming", savedName: OTHER_SHORT });
    expect(text(dashboard)).toContain(`Name for ${OTHER_SHORT}:`);
    service.setStage({ stage: "done", name: "Old name", alreadyPaired: true });
    expect(text(dashboard)).toContain(`${OTHER_SHORT} was already paired, as "Old name".`);
  });

  test("the name prompt refuses, inline, another peer's name, this machine's name, and a /", () => {
    const dashboard = makeDashboard();
    dashboard.setMachineName("Studio");
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    dashboard.handleInput("I");
    const THIRD = "0b".repeat(32);
    service.set({
      peers: [
        { id: THIRD, name: "Laptop", pairedAt: "x" },
        // The peer being named is already saved, under its short id.
        { id: OTHER, name: OTHER_SHORT, pairedAt: "x" },
      ],
    });
    service.setSession("initiator", { stage: "naming", savedName: OTHER_SHORT });
    service.calls = [];
    const submit = (name: string) => {
      const dialog = peersTab(dashboard);
      dialog.sessionValue = "";
      for (const ch of name) dashboard.handleInput(ch);
      dashboard.handleInput("\r");
      return dialog;
    };

    expect(submit("laptop").error).toBe(`Another peer is already named "Laptop".`);
    expect(text(dashboard)).toContain(`Another peer is already named "Laptop".`);
    expect(submit(" STUDIO ").error).toBe(`"Studio" is this machine's name.`);
    expect(submit("@office").error).toBe("A machine name cannot start with @.");
    expect(submit("home/office").error).toBe(`A name cannot contain "/".`);
    expect(service.calls).toEqual([]);

    // Typing clears the error; the peer's own saved name and a new name are fine.
    dashboard.handleInput("x");
    expect(peersTab(dashboard).error).toBeNull();
    submit(OTHER_SHORT.toUpperCase());
    expect(service.calls).toEqual([`name:${OTHER_SHORT.toUpperCase()}`]);
    submit("Desk");
    expect(service.calls.at(-1)).toBe("name:Desk");
    // Esc and a blank name still keep the saved name.
    submit("   ");
    expect(service.calls.at(-1)).toBe("name:   ");
    dashboard.handleInput("\x1b");
    expect(service.calls.at(-1)).toBe("name:null");
  });

  test("every failure renders its message", () => {
    const { dashboard, service } = open();
    const cases: Array<[PairStage, string]> = [
      [{ stage: "failed", failure: { kind: "refused", reason: "not-accepting" } }, `Pairing refused: ${OTHER_SHORT} does not have its Peers tab open.`],
      [{ stage: "failed", failure: { kind: "refused", reason: "busy" } }, `Pairing refused: ${OTHER_SHORT} is busy with another pairing.`],
      [{ stage: "failed", failure: { kind: "wrong-code" } }, "Wrong code."],
      [{ stage: "failed", failure: { kind: "expired" } }, "The code expired."],
      [{ stage: "failed", failure: { kind: "cancelled" } }, "Pairing cancelled."],
      [{ stage: "failed", failure: { kind: "connection-failed", detail: "timed out" } }, "Connection failed: timed out"],
      [{ stage: "failed", failure: { kind: "error", detail: "message is not JSON" } }, "Pairing failed: message is not JSON"],
    ];
    for (const [stage, message] of cases) {
      service.setSession("initiator", stage);
      expect(text(dashboard)).toContain(message);
      expect(text(dashboard)).toContain("Enter or Esc: return to Peers");
    }
  });

  test("Esc: cancels while pairing runs, keeps the name at the name prompt, leaves a result, closes from idle", () => {
    const { dashboard, service } = open();
    for (const stage of [
      { stage: "connecting" },
      { stage: "code-entry" },
      { stage: "verifying" },
      { stage: "incoming" },
      { stage: "code-shown", code: "ABCD1234", expiresAt: 0 },
    ] as PairStage[]) {
      service.setSession("initiator", stage);
      service.calls = [];
      dashboard.handleInput("\x1b");
      expect(service.calls).toEqual(["cancel"]);
      expect(peersTab(dashboard)).toBeTruthy();
    }
    service.setSession("responder", { stage: "naming", savedName: OTHER_SHORT });
    service.calls = [];
    dashboard.handleInput("\x1b");
    expect(service.calls).toEqual(["name:null"]);
    service.setStage({ stage: "failed", failure: { kind: "cancelled" } });
    service.calls = [];
    dashboard.handleInput("x");
    expect(service.calls).toEqual([]);
    dashboard.handleInput("\x1b");
    expect(service.calls).toEqual(["dismiss"]);

    service.set({ session: null });
    service.calls = [];
    dashboard.handleInput("\x1b");
    expect(dashboard.dialog).toBeNull();
    expect(service.calls).toEqual(["close"]);
  });

  test("keys that pick other actions do nothing while the dialog is open", () => {
    const { dashboard, service } = open();
    service.setSession("responder", { stage: "code-shown", code: "ABCD1234", expiresAt: 0 });
    service.calls = [];
    for (const key of ["x", "?", "a", "\r", "j"]) dashboard.handleInput(key);
    expect(service.calls).toEqual([]);
    expect(peersTab(dashboard)).toBeTruthy();
  });

  test("a new session starts with an empty input and no stale error", () => {
    const { dashboard, service } = open();
    service.setSession("initiator", { stage: "code-entry" });
    for (const ch of "zz") dashboard.handleInput(ch);
    dashboard.handleInput("\r");
    const dialog = peersTab(dashboard);
    expect(dialog.sessionValue).toBe("zz");
    expect(dialog.error).not.toBeNull();
    service.setSession("responder", { stage: "naming", savedName: OTHER_SHORT });
    expect(dialog.sessionValue).toBe("");
    expect(dialog.error).toBeNull();
  });

  test("replacing the dialog closes it on the service (pairing is accepted only while it is open)", () => {
    const { dashboard, service } = open();
    dashboard.showDialog({ type: "help", lines: ["x"] });
    expect(service.calls).toEqual(["open", "close"]);
  });

  test("a 24-row terminal keeps code entry, its validation error and the hint on screen", () => {
    const originalRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true, configurable: true });
    try {
      const dashboard = makeDashboard();
      const { tui, composite } = overlayTui(140, 24);
      dashboard.setTui(tui);
      const service = new FakePeerService();
      const peers = Array.from({ length: 11 }, (_, i) => ({ id: i.toString(16).repeat(64), name: `peer-${i}`, pairedAt: "x" }));
      service.set({ peers, links: peers.map(peer => ({ ...peer, connected: false, connectedAt: null, lastOkAt: null,
        coordinator: null, lastError: "connection refused", repos: null, agents: null, questions: null })) });
      dashboard.setPeerService(service);
      dashboard.handleInput("I");
      service.setSession("initiator", { stage: "code-entry" });
      dashboard.handleInput("12");
      dashboard.handleInput("\r");
      const visible = stripAnsi(composite(dashboard.render(140)).slice(-24).join("\n"));
      expect(visible).toContain("Code  (your id:");
      expect(visible).toContain("> 12█");
      expect(visible).toContain("A code is 8 characters");
      expect(visible).toContain("Enter: send code    Esc: cancel");
      expect(visible).toContain("connection refused");
      expect(visible).toMatch(/…and \d+ more/);
      expect(visible).toContain("└" + "─".repeat(68) + "┘");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: originalRows, writable: true, configurable: true });
    }
  });

  test.each(["code-entry", "naming"] as const)("40x24 keeps the first peer visible alongside a %s error", stage => {
    const originalRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true, configurable: true });
    try {
      const dashboard = makeDashboard();
      const { tui, composite } = overlayTui(40, 24);
      dashboard.setTui(tui);
      const service = new FakePeerService();
      const peers = Array.from({ length: 11 }, (_, i) => ({ id: i.toString(16).repeat(64), name: `peer-${i}`, pairedAt: "x" }));
      service.set({ peers, links: peers.map(peer => ({ ...peer, connected: false, connectedAt: null, lastOkAt: null,
        coordinator: null, lastError: "connection refused while trying to reach the other endpoint during the most recent polling attempt", repos: null, agents: null, questions: null })) });
      dashboard.setPeerService(service);
      dashboard.handleInput("I");
      service.setSession("initiator", stage === "code-entry" ? { stage } : { stage, savedName: OTHER_SHORT });
      const value = stage === "code-entry" ? "12" : "peer-0";
      dashboard.handleInput(value);
      dashboard.handleInput("\r");
      const screen = composite(dashboard.render(40)).slice(-24).map(stripAnsi);
      const lines = screen.map(line => line.slice(1, -1).trim());
      const content = lines.join(" ");
      expect(content).toContain("0000000000  offline");
      expect(content).toContain("connection refused");
      expect(lines).toContain("…and 10 more");
      expect(content).toContain(`> ${value}█`);
      if (stage === "code-entry") {
        expect(content).toContain("Code  (your id:");
        expect(content).toContain("A code is 8 characters, like ABCD-1234.");
        expect(content).toContain("Enter: send code    Esc: cancel");
      } else {
        expect(content).toContain(`Name for ${OTHER_SHORT}:`);
        expect(content).toContain('Another peer is already named "peer-0".');
        expect(content).toContain(`Enter: save    Esc: keep "${OTHER_SHORT}"`);
      }
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: originalRows, writable: true, configurable: true });
    }
  });

  test.each([70, 40])("the %i-column Peers overlay shows status, count, field, hint and borders", width => {
    const height = 24;
    const originalRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: height, writable: true, configurable: true });
    try {
      const dashboard = makeDashboard();
      const { tui, composite } = overlayTui(width, height);
      dashboard.setTui(tui);
      const service = new FakePeerService();
      const peers = Array.from({ length: 11 }, (_, i) => ({ id: i.toString(16).repeat(64), name: "N".repeat(32), pairedAt: "x" }));
      service.set({ peers, links: peers.map(peer => ({ ...peer, connected: false, connectedAt: null, lastOkAt: null,
        coordinator: null, lastError: "connection refused", repos: null, agents: null, questions: null })) });
      dashboard.setPeerService(service);
      dashboard.handleInput("I");
      dashboard.handleInput("abc");
      const screen = composite(dashboard.render(width)).slice(-height).map(stripAnsi);
      const start = screen.findIndex(line => line.startsWith("┌─ Peers "));
      const end = screen.indexOf("└" + "─".repeat(width - 2) + "┘");
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const body = screen.slice(start + 1, end);
      for (const line of body) {
        expect(line).toStartWith("│");
        expect(line).toEndWith("│");
        expect(visibleWidth(line)).toBe(width);
      }
      const shown = body.filter(line => /\d{10}  offline/.test(line)).length;
      expect(shown).toBeGreaterThan(0);
      const content = body.map(line => line.slice(1, -1).trim()).join(" ");
      expect(content).toContain(`…and ${11 - shown} more (ib peer list shows all)`);
      expect(content).toContain("Pair with id > abc█");
      expect(content).toContain("Enter: pair    Esc: close");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: originalRows, writable: true, configurable: true });
    }
  });

  test("every row fits the dialog in every stage", () => {
    const { dashboard, service } = open();
    service.set({
      peers: [{ id: OTHER, name: "N".repeat(32), pairedAt: "x" }],
      links: [{ id: OTHER, name: "N".repeat(32), connected: false, connectedAt: null, lastOkAt: Date.now() - 50 * 3_600_000, coordinator: null, lastError: "e".repeat(160), repos: null, agents: null, questions: null }],
    });
    const stages: PairStage[] = [
      { stage: "connecting" },
      { stage: "code-entry" },
      { stage: "code-shown", code: "ABCD1234", expiresAt: 0 },
      { stage: "naming", savedName: "N".repeat(32) },
      { stage: "failed", failure: { kind: "error", detail: "x".repeat(120) } },
    ];
    peersTab(dashboard).idValue = "y".repeat(200);
    for (const width of [70, 40]) {
      service.set({ session: null });
      const idle = (dashboard as any).dialogOverlay.render(width) as string[];
      expect(idle.filter((row) => visibleWidth(row) !== width)).toEqual([]);
      for (const stage of stages) {
        service.setSession("initiator", stage);
        const rows = (dashboard as any).dialogOverlay.render(width) as string[];
        expect(rows.filter((row) => visibleWidth(row) !== width)).toEqual([]);
      }
    }
  });
});

// The unified Agents tree and the read-only guard (SPEC §20.5). The
// poller's state comes from the scripted FakePeerService; tmux and git go
// through recording fakes, so nothing here reaches a real session or worktree.
describe("Unified peer repos in the Agents tree", () => {
  const PEER_B = "0b".repeat(32);
  const PEER_C = "0c".repeat(32);
  const PEER_D = "0d".repeat(32);
  const WIDTH = 160;
  /** The peers' names in links(): a remote row's key starts with its peer's name. */
  const PEER_NAMES: Record<string, string> = { [PEER_B]: "Laptop B", [PEER_C]: "Laptop C", [PEER_D]: "Laptop D" };
  /** A remote agent's selection key (peer-repos.ts peerEntryKey): `<peer name>/<repo>/<id>`. */
  const agentKey = (peer: string, repo: string, id: string) => `${PEER_NAMES[peer]}/${repo}/${id}`;
  const repoKey = (repo: string) => `/${repo.toLowerCase()}`;
  const repos = (...names: string[]) => names.map((name) => ({ registryName: name, displayName: name, remoteUrl: null, relPath: null }));
  const WORKER_KEY = agentKey(PEER_B, "itsybitsy", "worker-abc");

  let origRows: number;
  let spawns: string[][];
  beforeEach(() => {
    origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 40, writable: true, configurable: true });
    const recorded: string[][] = [];
    spawns = recorded;
    tmuxPollerSpawnCtx.set((cmd: string[]) => {
      recorded.push(cmd);
      return makeSpawnResult(1);
    });
    gitStatusSpawnCtx.set((cmd: string[]) => {
      recorded.push(cmd);
      return makeSpawnResult(1);
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
    tmuxPollerSpawnCtx.reset();
    gitStatusSpawnCtx.reset();
  });

  function remote(id: string, repoName: string, overrides: Partial<RemoteAgent> = {}): RemoteAgent {
    return { id, nickname: null, repoName, repoRegistryName: repoName, repoPath: `/remote/${repoName}`, state: "running", agentType: "worker", manager: null, createdEpoch: Math.floor(Date.now() / 1000), ...overrides };
  }

  /** Laptop B connected; Laptop C unreachable, offline; Laptop D never answered. */
  function links(): PeerLinkState[] {
    const now = Date.now();
    return [
      {
        id: PEER_B, name: "Laptop B", connected: true, connectedAt: now - 300_000, lastOkAt: now, coordinator: null, lastError: null,
        repos: repos("itsybitsy", "other-repo"),
        agents: [
          remote("worker-abc", "itsybitsy", { manager: "manager-def", nickname: "abc-nick" }),
          remote("manager-def", "itsybitsy", { state: "waiting", agentType: "manager" }),
          remote("agent-1", "other-repo", { state: "complete" }),
        ],
        questions: [],
      },
      { id: PEER_C, name: "Laptop C", connected: false, connectedAt: null, lastOkAt: now - 125_000, coordinator: null, lastError: "timed out", repos: repos("app"), agents: [remote("agent-1", "app")], questions: [] },
      { id: PEER_D, name: "Laptop D", connected: false, connectedAt: null, lastOkAt: null, coordinator: null, lastError: "timed out", repos: null, agents: null, questions: null },
    ];
  }

  /** A dashboard whose one local agent is `agent-1` (selected), with `links()` as the poller's state. */
  function setup(): { dashboard: DashboardComponent; service: FakePeerService; local: Agent } {
    const dashboard = makeDashboard();
    const local = makeAgent("agent-1", "/repos/local");
    dashboard.onUpdate([local], [makeFlatAgent(local)], []);
    const service = new FakePeerService();
    const current = links();
    service.state = { ...service.state, links: current, peers: current.map(link => ({ id: link.id, name: link.name, pairedAt: "x" })) };
    dashboard.setPeerService(service);
    return { dashboard, service, local };
  }

  const keyOf = (dashboard: DashboardComponent): string | null => {
    const row = dashboard.agentTree.selectedRemote;
    return row ? peerEntryKey(row) : null;
  };

  /** Press j until the selected row is `key`: real navigation, through the guard. */
  function selectByKey(dashboard: DashboardComponent, key: string): void {
    for (let i = 0; i < 30 && keyOf(dashboard) !== key; i++) dashboard.handleInput("j");
    expect(keyOf(dashboard)).toBe(key);
  }

  /** Tab to the selected remote row's message editor (`s` opens the send dialog instead). */
  function focusEditor(dashboard: DashboardComponent): void {
    const inEditor = () => dashboard.focus === "active-agent" && dashboard.focusManager.subFocus === "input";
    for (let i = 0; i < 10 && !inEditor(); i++) dashboard.handleInput("\t");
    expect(inEditor()).toBe(true);
  }

  /** Wait for a send's path dialog, expect its `items` all unchecked, check the ones in `attach`, and submit it with Enter. */
  async function submitPathDialog(dashboard: DashboardComponent, items: readonly string[], attach: readonly string[] = items) {
    await waitFor(() => dashboard.dialog?.type === "multi-select", { message: "the path dialog" });
    const picker = assertDialog(dashboard.dialog, "multi-select");
    expect(picker.prompt).toBe("Send as attachments to Laptop B:");
    expect(picker.items).toEqual([...items]);
    expect(picker.checked).toEqual(items.map(() => false));
    for (const [index, item] of items.entries()) {
      if (index) dashboard.handleInput("j");
      if (attach.includes(item)) dashboard.handleInput(" ");
    }
    dashboard.handleInput("\r");
  }

  /** Every row of the Agents tree at `width`, uncut by the sidebar's height. */
  function treeRows(dashboard: DashboardComponent, width = 60): string[] {
    dashboard.agentTree.maxHeight = 100;
    return dashboard.agentTree.render(width);
  }

  const resetNotice = (dashboard: DashboardComponent) => {
    (dashboard as any).lastSentNotice = null;
  };

  /**
   * The text of the main area's center (`pane` 2) or right (`pane` 1) pane in
   * rendered `lines`, its wrapped lines joined: the cells after the sidebar's
   * seam, split on the panes' seam.
   */
  function paneText(lines: string[], pane: 1 | 2): string {
    return lines
      .map((line) => stripAnsi(line).split("│"))
      .filter((cells) => cells.length >= 3)
      .map((cells) => cells[cells.length - pane]!.trim())
      .filter((cell) => cell !== "")
      .join(" ");
  }

  test("j from the local coordinator output, Tab, k cannot edit the hidden coordinator", () => {
    const { dashboard } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    dashboard.agentTree.selectSystemCoordinator();
    dashboard.syncSelectedAgent();
    dashboard.coordinatorPane.hasPolled = true;
    dashboard.focusManager.setFocus("coordinator");
    dashboard.focusManager.setSubFocus("pane");
    dashboard.handleInput("j");
    expect(keyOf(dashboard)).toBe(PEER_B + "/@system");
    expect(dashboard.focusManager.current()).toBe("agent-tree");
    dashboard.handleInput("\t");
    expect(dashboard.focusManager.current()).toBe("info");
    dashboard.handleInput("k");
    expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
    expect(dashboard.coordinatorInputField.getText()).toBe("");
  });

  test("on the Teams tab j from the local coordinator, Tab, k uses the visible tree", () => {
    const { dashboard } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    dashboard.agentTree.selectSystemCoordinator();
    dashboard.syncSelectedAgent();
    dashboard.coordinatorPane.hasPolled = true;
    dashboard.focusManager.setFocus("coordinator");
    dashboard.handleInput("2");
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "east", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);
    dashboard.handleInput("j");
    expect(dashboard.activeSelectionSource).toBe("teams");
    expect(dashboard.focus).toBe("teams-tree");
    dashboard.handleInput("\t");
    expect(dashboard.focus).toBe("info");
    dashboard.handleInput("k");
    expect(dashboard.coordinatorInputField.getText()).toBe("");
    expect(dashboard.activeSelectionSource).toBe("teams");
  });

  test("Tab visits the full-width peer capture, its editor and Send", () => {
    const { dashboard } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    dashboard.focusManager.setFocus("right-pane");
    selectByKey(dashboard, PEER_B + "/@system");
    expect(dashboard.focus).toBe("active-agent");
    for (const sub of ["input", "send"] as const) {
      dashboard.handleInput("\t");
      expect(dashboard.focusManager.subFocus).toBe(sub);
    }
    for (const stop of ["agent-tree", "info", "active-agent"] as const) {
      dashboard.handleInput("\t");
      expect(dashboard.focus).toBe(stop);
      expect(dashboard.focusManager.subFocus).toBe("pane");
    }
    expect(dashboard.render(180).join("")).toContain(REVERSE + BOLD + " Laptop B/@system ");
    for (const stop of ["info", "agent-tree", "active-agent"] as const) {
      dashboard.handleInput("\x1b[Z");
      expect(dashboard.focus).toBe(stop);
    }
  });

  test.each(["1", "2"])("the peer coordinator replaces TREE with a fixed capture on sidebar %s", async tab => {
    const { dashboard, service, local } = setup();
    const peer = { ...links()[0]!, repos: [], agents: [] };
    service.set({ peers: [{ id: peer.id, name: peer.name, pairedAt: "now" }], links: [peer] });
    dashboard.onUpdate([local], [{ kind: "system-coordinator", state: "running", age: "1m" },
      makeFlatRepoHeader("local", local.repoPath), makeFlatAgent(local)], []);
    dashboard.persistLayout();
    await flushPendingSave();
    const saved = await loadLayout();
    const persist = spyOn(dashboard, "persistLayout");
    dashboard.teamsTree.setFlatList([
      { kind: "team-header", teamName: "east", memberCount: 0, createdEpoch: 1, createdBy: "@system" },
    ]);
    const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
    const screen = () => dashboard.render(180);
    const expectSidebar = (name: "Agents" | "Teams") => {
      const title = screen().find(line => line.includes(REVERSE + BOLD + ` ${name} ` + RESET));
      expect(title).toBeDefined();
      expect(visibleWidth(title!.split("│")[0]!)).toBe(saved!.sidebarWidth);
      expect(dashboard.focus).toBe(name === "Teams" ? "teams-tree" : "agent-tree");
    };
    try {
      if (tab === "1") dashboard.agentTree.selectAgent(local);
      else dashboard.agentTree.selectByRepoPath(local.repoPath);
      dashboard.syncSelectedAgent();
      for (let i = 0; i < PANE_MODES.length && dashboard.rightPane.mode !== "TREE"; i++) dashboard.handleInput("p");
      dashboard.handleInput(tab);
      expect(dashboard.rightPane.mode).toBe("TREE");
      expect(stripAnsi(screen().join(" "))).toContain(" TREE ");
      expect(dashboard.focus).toBe("agent-tree");
      if (tab === "1") {
        dashboard.handleInput("j"); // wrap to local @system, then its paired child
        expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
        dashboard.handleInput("j");
      } else {
        dashboard.handleInput("k"); // the peer is immediately above the repo in the expanded Agents tree
      }
      expect(keyOf(dashboard)).toBe(PEER_B + "/@system");
      await waitFor(() => stripAnsi(screen().join(" ")).includes("peer capture"));
      expectSidebar(tab === "1" ? "Agents" : "Teams");
      for (const key of ["p", "n", "\x1b[D", "\x1b[C", "[", "]", "{", "}"]) {
        resetNotice(dashboard);
        dashboard.handleInput(key);
        expect(dashboard.notice).toBe("[]{}".includes(key) ? "resize from a local row" : "view mode is fixed for remote coordinators");
        expect(dashboard.rightPane.mode).toBe("AGENT LOG");
        expect(stripAnsi(screen().join(" "))).toContain("peer capture");
      }
      expect(stripAnsi(screen().at(-2)!)).not.toContain("p/n: pane");
      if (tab === "2") {
        // Carry the peer selection across sidebar switches. From Teams, j selects the team.
        dashboard.handleInput("1");
        dashboard.handleInput("2");
        expect(keyOf(dashboard)).toBe(PEER_B + "/@system");
        dashboard.handleInput("j");
        expect(dashboard.channelPane.teamName).toBe("east");
        expectSidebar("Teams");
        dashboard.handleInput("1");
        selectByKey(dashboard, PEER_B + "/@system");
      }
      dashboard.handleInput(tab === "1" ? "\t" : "\x1b[9u");
      expect(dashboard.focus).toBe("info");
      dashboard.handleInput("j");
      expect(dashboard.agentTree.selectedRepoPath).toBe(local.repoPath);
      expect(dashboard.rightPane.mode).toBe("REPO");
      expectSidebar("Agents");
      dashboard.handleInput("2");
      dashboard.handleInput("j");
      expect(dashboard.channelPane.teamName).toBe("east");
      expectSidebar("Teams");
      expect(persist).not.toHaveBeenCalled();
      await flushPendingSave();
      expect(await loadLayout()).toEqual(saved);
    } finally {
      running.mockRestore();
      dashboard.stopPolling();
    }
  });

  test.each(["?", "/", "@", "I"])("dialog %s pauses coordinator reads and resumes once", async key => {
    const { dashboard, service } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
    const timers = new Set<() => void>();
    (dashboard as any).remotePane.every = (_ms: number, tick: () => void) => {
      timers.add(tick);
      return () => timers.delete(tick);
    };
    const pending = Promise.withResolvers<{ state: string; text: string }>();
    service.fetchPane.mockImplementationOnce(() => pending.promise);
    try {
      selectByKey(dashboard, PEER_B + "/@system");
      dashboard.handleInput(key);
      expect(dashboard.dialog).not.toBeNull();
      for (let tick = 0; tick < 3; tick++) for (const poll of timers) poll();
      expect(timers.size).toBe(0);
      expect(service.fetchPane).toHaveBeenCalledTimes(1);
      pending.resolve({ state: "running", text: "late reply" });
      await Promise.resolve();
      expect((dashboard as any).remotePane.render(60, 3).join(" ")).not.toContain("late reply");
      dashboard.closeDialog();
      expect(timers.size).toBe(1);
      expect(service.fetchPane).toHaveBeenCalledTimes(2);
    } finally {
      running.mockRestore();
      dashboard.stopPolling();
    }
  });

  test("the peer coordinator uses main width and its scroll keys affect only its capture", async () => {
    const { dashboard, service } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
    const last = "peer-output-".repeat(8);
    service.fetchPane.mockResolvedValue({ state: "running", text: [
      ...Array.from({ length: (process.stdout.rows || 24) + 20 }, (_, i) => "line " + i), last,
    ].join("\n") });
    try {
      selectByKey(dashboard, PEER_B + "/@system");
      await Promise.resolve();
      const screen = () => stripAnsi(dashboard.render(180).join("\n"));
      expect(screen()).toContain(last);
      dashboard.handleInput(";");
      expect(screen()).not.toContain(last);
      expect(dashboard.coordinatorPane.scrollBack).toBe(0);
      expect(dashboard.rightPane.scrollOffset).toBe(0);
      dashboard.handleInput("l");
      expect(screen()).toContain(last);
    } finally {
      running.mockRestore();
      dashboard.stopPolling();
    }
  });

  test("scrolling a remote agent requests older history on the next poll", async () => {
    const { dashboard, service } = setup();
    const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
    let poll: () => void = () => {};
    (dashboard as any).remotePane.every = (_ms: number, tick: () => void) => { poll = tick; return () => {}; };
    service.fetchPane.mockImplementation(async (_peer, _target, lines) => ({
      state: "running", text: Array.from({ length: lines }, (_, i) => "history " + (lines - i)).join("\n"),
    }));
    try {
      selectByKey(dashboard, WORKER_KEY);
      const screen = () => stripAnsi(dashboard.render(180).join("\n"));
      await waitFor(() => screen().includes("history 1"));
      for (let i = 0; i < 80; i++) { dashboard.handleInput(";"); screen(); }
      poll();
      await Promise.resolve();
      const lines = service.fetchPane.mock.calls.at(-1)![2];
      expect(lines).toBeGreaterThan(210);
      expect(screen()).toMatch(/history [2-9]\d\d/);
      dashboard.handleInput("s");
      expect(assertDialog(dashboard.dialog, "textarea").prompt).toBe("Send message to Laptop B/abc-nick:");
    } finally {
      running.mockRestore();
      dashboard.stopPolling();
    }
  });

  test("the peer coordinator's own input box is trimmed and its status lines sit below the dashboard editor", async () => {
    const { dashboard, service } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
    const sep = "─".repeat(300);
    service.fetchPane.mockResolvedValue({ state: "running",
      text: ["peer reply", sep, "❯ /rc", sep, "  ⏵⏵ auto mode on", ""].join("\n") });
    try {
      selectByKey(dashboard, PEER_B + "/@system");
      await Promise.resolve();
      const main = dashboard.render(180).map((line) => stripAnsi(line).split("│").at(-1)!.trim()).filter(Boolean);
      expect(main).not.toContain("❯ /rc");
      const reply = main.indexOf("peer reply");
      const prompt = main.indexOf("❯");
      const status = main.indexOf("⏵⏵ auto mode on");
      expect(reply).toBeGreaterThan(0);
      expect(prompt).toBeGreaterThan(reply);
      expect(main[prompt + 1]).toMatch(/^─+ \[Send\] ─+$/);
      expect(status).toBe(prompt + 2);
      expect(main.slice(reply + 1, prompt - 1).every((line) => !/^─+$/.test(line))).toBe(true);

      // More status lines than the main area holds (a `/` menu on the peer)
      // still fill the terminal exactly, with the editor kept on screen.
      const menu = Array.from({ length: 60 }, (_, i) => `  /command-${i}`);
      service.fetchPane.mockResolvedValue({ state: "running", text: ["peer reply", sep, "❯ /", sep, ...menu].join("\n") });
      const pane = (dashboard as any).remotePane;
      pane.poll(pane.active);
      await waitFor(() => stripAnsi(dashboard.render(180).join("\n")).includes("/command-0"));
      const lines = dashboard.render(180);
      expect(lines).toHaveLength(process.stdout.rows);
      expect(stripAnsi(lines.join("\n"))).toContain("[Send]");
    } finally {
      running.mockRestore();
      dashboard.stopPolling();
    }
  });

  test("a highlighted coordinator shows the startup denial, then the remote capture when permitted", async () => {
    const { dashboard, service } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
    try {
      service.remoteStartDenial = "Dashboard is inside tmux";
      selectByKey(dashboard, PEER_B + "/@system");
      expect(stripAnsi(dashboard.render(180).join("\n"))).toContain("Dashboard is inside tmux");
      expect(service.fetchPane).not.toHaveBeenCalled();
      service.remoteStartDenial = null;
      service.set({});
      await waitFor(() => stripAnsi(dashboard.render(180).join("\n")).includes("peer capture"));
      expect(service.fetchPane.mock.calls).toEqual([[PEER_B, { op: "coordinator-pane" }, 200]]);
      dashboard.handleInput("s");
      const send = assertDialog(dashboard.dialog, "textarea");
      expect(send.prompt).toBe("Send message to Laptop B/@system:");
      send.onSubmit("hi");
      await waitFor(() => dashboard.dialog === null);
      expect(service.sendRemoteMessage.mock.calls[0]?.slice(0, 2)).toMatchObject([PEER_B, {
        from: { kind: "user" }, target: { kind: "system" }, message: "hi", files: [],
      }]);
      dashboard.handleInput("k");
      expect(stripAnsi(dashboard.render(180).join("\n"))).not.toContain("peer capture");
    } finally {
      running.mockRestore();
      dashboard.stopPolling();
    }
  });

  test("unpairing the selected coordinator returns to @system while the stale link still exists", () => {
    const { dashboard, service } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
    const cancel = mock(() => {});
    (dashboard as any).remotePane.every = () => cancel;
    try {
      selectByKey(dashboard, PEER_B + "/@system");
      const remaining = [{ id: PEER_C, name: "Renamed machine", pairedAt: "now" }];
      service.set({ peers: remaining });
      expect(service.state.links.some(link => link.id === PEER_B)).toBe(true);
      expect(dashboard.agentTree.isSystemCoordinatorSelected).toBe(true);
      expect(dashboard.agentTree.visibleList.filter(row => row.kind === "remote-coordinator").map(row => row.peerName))
        .toEqual(["Renamed machine"]);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(service.fetchPane).toHaveBeenCalledTimes(1);
    } finally {
      running.mockRestore();
      dashboard.stopPolling();
    }
  });

  test("paired coordinators are selectable children of @system, including offline peers", () => {
    const { dashboard, service } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    const [b, c] = links();
    for (const count of [0, 1, 2]) {
      const current = [b!, c!].slice(0, count);
      service.set({ peers: current.map(link => ({ ...link, pairedAt: "x" })),
        links: current.map(link => ({ ...link, coordinator: { state: "compacting" } })) });
      expect(dashboard.agentTree.visibleList.filter(row => row.kind === "remote-coordinator")).toHaveLength(count);
      expect(dashboard.agentTree.visibleList.slice(0, 1 + count).map(row => row.kind)).toEqual([
        "system-coordinator", ...Array(count).fill("remote-coordinator"),
      ]);
    }
    const rows = treeRows(dashboard);
    expect(stripAnsi(rows[0]!)).toContain("running");
    expect(rows[1]).toContain(ITALIC + "Laptop B");
    expect(rows[1]).toContain(GREEN + "connected" + RESET);
    expect(rows[2]).toContain(RED + "offline" + RESET);
    // Connected: the link word and how long it has been up, without the coordinator's state.
    expect(stripAnsi(rows[1]!).trimEnd()).toMatch(/Laptop B +connected +5m$/);
    expect(stripAnsi(rows[2]!)).toContain("compacting");
    expect(rows[2]).toContain(DIM);
    expect(stripAnsi(rows[2]!)).toContain("2m ago");
    selectByKey(dashboard, PEER_B + "/@system");
    expect(stripAnsi(dashboard.infoPanel.render(60).join("\n"))).toContain("State: compacting");
    selectByKey(dashboard, PEER_C + "/@system");
    service.set({ peers: [c!, b!].map(link => ({ ...link, pairedAt: "x" })), links: [c!, b!] });
    expect(keyOf(dashboard)).toBe(PEER_C + "/@system");
    expect(stripAnsi(dashboard.infoPanel.render(60).join("\n"))).toContain("Machine: Laptop C · offline");
    const permittedAscii = new Set([..."jkJK123V@?/I;ls.ahATEH", "\t", "\x03"]);
    const ascii = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));
    for (const key of permittedAscii) expect(dashboard.refuseOnRemoteRow(key)).toBe(false);
    const refused = new Set([
      ...ascii.filter(key => !permittedAscii.has(key)),
      "i", " ", "\r", "edit these notes", "x", "!", "R", "P", "r", "m", "N",
      "d", "o", "O", "G", "C", "\x1b[200~pasted text\x1b[201~",
    ]);
    const handlers = [
      ...Object.keys(agentActions).filter(name => typeof (agentActions as Record<string, unknown>)[name] === "function")
        .map(name => spyOn(agentActions as Record<string, any>, name).mockImplementation(() => undefined)),
      spyOn(dashboard, "jumpToMode"), spyOn(dashboard.infoPanel.notesEditor, "handleInput"),
      spyOn(dashboard.inputField, "handleInput"), spyOn(dashboard.coordinatorInputField, "handleInput"),
    ];
    try {
      for (const key of refused) {
        resetNotice(dashboard);
        dashboard.handleInput(key);
        const notice = ["[", "]", "{", "}"].includes(key) ? "resize from a local row"
          : ["p", "n", "d", "e", "g"].includes(key) ? "view mode is fixed for remote coordinators" : REMOTE_READ_ONLY_NOTICE;
        expect(dashboard.notice).toBe(notice);
        expect(dashboard.dialog).toBeNull();
      }
      for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
    } finally {
      for (const handler of handlers) handler.mockRestore();
    }
    expect(dashboard.agentTree.selectedAgent).toBeNull();
    expect(keyOf(dashboard)).toBe(PEER_C + "/@system");
    service.set({ peers: [{ ...b!, pairedAt: "x" }], links: [{ ...b!, connected: false, connectedAt: null, lastError: null, lastOkAt: null }] });
    expect(treeRows(dashboard)[1]).toContain(YELLOW + "connecting" + RESET);
  });

  test("a connected peer with no coordinator row says unavailable in the info panel, not the tree", () => {
    const { dashboard, service } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    const [b] = links();
    service.set({ peers: [{ ...b!, pairedAt: "x" }], links: [b!] });
    expect(stripAnsi(treeRows(dashboard)[1]!).trimEnd()).toMatch(/Laptop B +connected +5m$/);
    selectByKey(dashboard, PEER_B + "/@system");
    expect(stripAnsi(dashboard.infoPanel.render(60).join("\n"))).toContain("State: unavailable");
  });

  test("peer coordinator and remote agent rows share the local rows' state and age columns", () => {
    const { dashboard, service, local } = setup();
    dashboard.onUpdate([local], [{ kind: "system-coordinator", state: "running", age: "1m" }, makeFlatAgent(local)], []);
    const [b, c, d] = links();
    // D has not answered yet (connecting); C is offline and last reported a coordinator state.
    const current = [b!, { ...c!, coordinator: { state: "compacting" } }, { ...d!, lastError: null }];
    service.set({ peers: current.map(link => ({ id: link.id, name: link.name, pairedAt: "x" })), links: current });
    const rows = treeRows(dashboard).map(row => stripAnsi(row).trimEnd());
    const stateCol =(row: string) => row.search(/ (running|waiting|complete|connected|offline|connecting)\b/) + 1;
    /** Where the age ends: the state word, its padding, then the age. */
    const ageEnd = (row: string) => stateCol(row) + row.slice(stateCol(row)).match(/^\S+ +\S+/)![0].length;
    const coordinator = rows.find(row => row.includes("◆ coordinator"))!;
    const peer = (name: string) => rows.find(row => row.includes(name))!;
    const stated = rows.filter(row => stateCol(row) > 0);
    // The coordinator, three peers, the local agent and four remote agents.
    expect(stated).toHaveLength(9);
    for (const row of stated) expect(stateCol(row)).toBe(stateCol(coordinator));
    expect(peer("Laptop B")).toMatch(/connected +5m$/);
    expect(peer("Laptop C")).toMatch(/offline +2m ago  compacting$/);
    expect(peer("Laptop D")).toMatch(/Laptop D +connecting$/);
    for (const name of ["Laptop B", "Laptop C"]) expect(ageEnd(peer(name))).toBe(ageEnd(coordinator));
  });

  test("remote-only repos follow local rows in display order, with italic agents and dim stale rows", () => {
    const { dashboard } = setup();
    const raw = treeRows(dashboard);
    expect(raw.map(stripAnsi).slice(1).map((r) => r.trimEnd().replace(/  +(waiting|running|complete)/, " $1"))).toEqual([
      "▾ app", "└── agent-1 running",
      "▾ itsybitsy", "└── manager-def waiting", "    └── abc-nick running",
      "▾ other-repo", "└── agent-1 complete",
    ]);
    expect(raw.map((r) => r.includes(ITALIC))).toEqual([false, false, true, false, true, true, false, true]);
    expect(raw[2]).toContain(DIM);
    expect(raw[2]).not.toContain(getStateColors().running!);
    expect(raw[4]).toContain(getStateColors().waiting!);
  });

  test("matches registry name across paths and case, keeping local order, labels, actions and selection", () => {
    const dashboard = makeDashboard();
    const local = makeAgent("manager", "/here/app");
    const localChild = makeAgent("kid", "/here/app");
    const header = makeFlatRepoHeader("Local nickname", "/here/app", true, true, true, "App");
    const localOnly = makeFlatRepoHeader("Only here", "/here/other");
    const localRows = [header, { ...makeFlatAgent(local), connector: "└── " },
      { ...makeFlatAgent(localChild), depth: 1, connector: "    └── " }, localOnly];
    dashboard.onUpdate([local, localChild], localRows, []);
    dashboard.agentTree.selectByRepoPath(header.repoPath);
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    const peer = (index: number, registry: string) => ({
      ...links()[index]!, repos: [...repos(registry), { registryName: "remote", displayName: "Empty remote", remoteUrl: null, relPath: null }],
      agents: [remote("kid", registry, { manager: "manager" }), remote("manager", registry)],
    });
    service.set({ links: [peer(0, "APP"), peer(1, "app")] });
    expect(dashboard.agentTree.selectedRepoPath).toBe(header.repoPath);
    expect(dashboard.agentTree.visibleList.map((r) => {
      if (r.kind === "agent") return r.connector + r.agent.id;
      if (r.kind === "remote-agent") return r.connector + peerEntryKey(r);
      if (r.kind === "repo-header" || r.kind === "remote-repo-header") return [r.kind, r.repoName];
    })).toEqual([
      ["repo-header", "Local nickname"], "├── manager", "│   └── kid",
      "├── Laptop B/APP/manager", "│   └── Laptop B/APP/kid",
      "└── Laptop C/app/manager", "    └── Laptop C/app/kid",
      ["repo-header", "Only here"], ["remote-repo-header", "Empty remote"],
    ]);
    const newAgent = spyOn(agentActions, "handleNewAgent").mockImplementation(() => {});
    try {
      dashboard.handleInput("a");
      expect(newAgent).toHaveBeenCalledWith(dashboard);
      dashboard.handleInput(".");
      expect(dashboard.agentTree.pinnedRepoPaths.has(header.repoPath)).toBe(true);
      expect(dashboard.agentTree.pinnedRemoteRepoNames.size).toBe(0);
    } finally {
      newAgent.mockRestore();
    }
    // Dropping and restoring the local registration keeps the same selected header.
    dashboard.onUpdate([], [localOnly], []);
    expect(keyOf(dashboard)).toBe("/app");
    dashboard.onUpdate([local, localChild], localRows, []);
    expect(dashboard.agentTree.selectedRepoPath).toBe(header.repoPath);
    service.set({ links: [] });
    expect(dashboard.agentTree.selectedRepoPath).toBe(header.repoPath);
  });

  test("one empty local registration still owns its shared header under running-only", () => {
    const dashboard = makeDashboard();
    dashboard.setRepos([{ name: "APP", nickname: "Local app", path: "/here/empty" }]);
    dashboard.onUpdate([], [], []);
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    service.set({ links: [links()[1]!] });
    dashboard.agentTree.setRepoFilter("running-only");
    expect(dashboard.agentTree.visibleList.map((row) => row.kind)).toEqual(["repo-header", "remote-agent"]);
    expect(dashboard.agentTree.selectByRepoPath("/here/empty")).toBe(true);
    service.set({ links: [] });
    expect(dashboard.agentTree.selectedRepoHeader).toBe("Local app");
  });

  for (const hasLocalAgent of [false, true]) {
    test(`synthesized header opens its local path and shows its local repo summary (local agent: ${hasLocalAgent})`, () => {
      const dashboard = makeDashboard();
      const repoPath = "/here/Local App";
      dashboard.setRepos([{ name: "APP", nickname: "Local app", path: repoPath }]);
      const agents = hasLocalAgent ? [makeAgent("local-worker", repoPath)] : [];
      dashboard.onUpdate(agents, agents.map((agent) => makeFlatAgent(agent)), []);
      const service = new FakePeerService();
      dashboard.setPeerService(service);
      service.set({ links: [links()[1]!] });
      expect(dashboard.agentTree.selectByRepoPath(repoPath)).toBe(true);
      dashboard.syncSelectedAgent();
      const open = spyOn(ghostty, "openPathInGhostty").mockResolvedValue({ ok: true, message: "opened" });
      try {
        dashboard.handleInput("G");
        expect(open).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith(repoPath);
      } finally {
        open.mockRestore();
      }
      for (const mode of ["REPO", "AGENT LOG"] as const) {
        dashboard.rightPane.setMode(mode);
        const rows = dashboard.rightPane.render(80).join("\n");
        expect(rows).toContain("\x1b]8;;file:///here/Local%20App\x07/here/Local App\x1b]8;;\x07");
        if (mode === "AGENT LOG") {
          expect(stripAnsi(rows)).toContain(hasLocalAgent ? "▾ Local app" : "▸ Local app");
          expect(stripAnsi(rows)).toContain(`Agents: ${agents.length}`);
        }
      }
    });
  }

  test("Favorites repaints its selected local favorite when a peer adds or removes the single-repo header", () => {
    const dashboard = makeDashboard();
    const counter = countingTui();
    dashboard.setTui(counter.tui);
    const local = makeAgent("fav", "/here/app");
    dashboard.setRepos([{ name: "app", path: local.repoPath }]);
    dashboard.onUpdate([local], [makeFlatAgent(local)], []);
    dashboard.agentTree.addFavorite(dashboard.agentTree.agentKey(local));
    dashboard.setSidebarMode("favorites");
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    const kinds = () => dashboard.agentTree.visibleList.map((row) => row.kind);
    const before = counter.renders();
    expect(kinds()).toEqual(["agent"]);
    service.set({ links: [links()[1]!] });
    expect(counter.renders()).toBe(before + 1);
    expect(kinds()).toEqual(["repo-header", "agent"]);
    service.set({ links: [] });
    expect(counter.renders()).toBe(before + 2);
    expect(kinds()).toEqual(["agent"]);
    expect(dashboard.selectedAgent).toBe(local);
  });

  test("reuses merged rows across renders and invalidates on peer, local, filter and carve-out changes", () => {
    const { dashboard, service, local } = setup();
    const tree = dashboard.agentTree;
    const initial = tree.visibleList;
    treeRows(dashboard, 40);
    treeRows(dashboard, 80);
    expect(tree.visibleList).toBe(initial);
    service.set({ links: [links()[1]!] });
    const changed = tree.visibleList;
    expect(changed).not.toBe(initial);
    tree.setFlatList([makeFlatAgent(local)]);
    expect(tree.visibleList).not.toBe(changed);
    tree.setFavoritesOnly(true);
    const favorites = tree.visibleList;
    expect(favorites.map((r) => r.kind)).toEqual(["agent"]);
    tree.deselect();
    expect(tree.visibleList).toEqual([]);
    expect(tree.visibleList).not.toBe(favorites);
    tree.addFavorite(tree.agentKey(local));
    expect(tree.visibleList.map((r) => r.kind)).toEqual(["agent"]);
  });

  test("identical paths with different registry names keep separate headers", () => {
    const dashboard = makeDashboard();
    const service = new FakePeerService();
    dashboard.onUpdate([], [makeFlatRepoHeader("Same label", "/local", false, false, false, "a")], []);
    dashboard.setPeerService(service);
    service.set({ links: [{ ...links()[0]!, repos: [{ registryName: "b", displayName: "Same label", remoteUrl: null, relPath: null }],
      agents: [remote("worker", "Same label", { repoRegistryName: "b", repoPath: "/local" })] }] });
    expect(dashboard.agentTree.visibleList.map((row) => row.kind)).toEqual(["repo-header", "remote-repo-header", "remote-agent"]);
  });

  test("a remote state that names an inherited property is drawn as text, never as the property", () => {
    const { dashboard, service } = setup();
    const odd = ["constructor", "toString", "__proto__", "hasOwnProperty"];
    service.set({ links: [{ ...links()[0]!, repos: repos("app"), agents: odd.map((state, i) => remote(`odd-${i}`, "app", { state })) }] });
    const rows = treeRows(dashboard).join("\n");
    for (const state of odd) expect(stripAnsi(rows)).toContain(state);
    expect(rows).not.toContain("function");
    expect(rows).not.toContain("[object");
    selectByKey(dashboard, agentKey(PEER_B, "app", "odd-0"));
    dashboard.infoPanel.displayHeight = 20;
    const info = dashboard.infoPanel.render(60).join("\n");
    expect(stripAnsi(info)).toContain("State: constructor");
    expect(info).not.toContain("function");
  });

  test("running-only hides stopped remote agents and their empty header", () => {
    const { dashboard, service } = setup();
    service.set({ links: [{ ...links()[0]!, repos: repos("app"), agents: [remote("old", "app", { state: "stopped" })] }] });
    dashboard.agentTree.setRepoFilter("running-only");
    expect(dashboard.agentTree.visibleList.map((row) => row.kind)).toEqual(["agent"]);
  });

  test.each([
    ["remote agent", agentKey(PEER_B, "app", "old")],
    ["peer coordinator", PEER_B + "/@system"],
    ["empty remote-only header", repoKey("empty")],
  ])("V cycles the filter and keeps the selected %s", (_, key) => {
    const { dashboard, service } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    service.set({ links: [{ ...links()[0]!, repos: repos("app", "empty"), agents: [remote("old", "app", { state: "stopped" })] }] });
    selectByKey(dashboard, key);

    for (const filter of ["non-empty", "running-only", "all"] as const) {
      dashboard.handleInput("V");
      expect(dashboard.agentTree.repoFilter).toBe(filter);
      expect(keyOf(dashboard)).toBe(key);
      const visible = dashboard.agentTree.visibleList;
      expect(visible.some(row => row.kind === "remote-agent")).toBe(filter !== "running-only" || key === agentKey(PEER_B, "app", "old"));
      expect(visible.some(row => row.kind === "remote-repo-header" && peerEntryKey(row) === repoKey("empty")))
        .toBe(filter === "all" || key === repoKey("empty"));
    }
  });

  for (const width of [40, 80]) {
    test(`at ${width} columns a truncated nickname preserves state styling through selection and disconnect`, () => {
      const { dashboard, service } = setup();
      const name = "P".repeat(32);
      const agent = remote("worker", "app", { nickname: "long nickname ".repeat(12), state: "waiting" });
      const peer = { ...links()[0]!, name, repos: repos("app"), agents: [agent] };
      service.set({ links: [peer] });
      const assertStyle = (stale: boolean, selected: boolean) => {
        const line = treeRows(dashboard, width).find((row) => row.includes("long nickname"))!;
        expect(stripAnsi(line)).toContain("…");
        // SGR 0 clears all three attributes. Look after the last reset before the state.
        const atState = line.slice(0, line.indexOf("waiting")).split("\x1b[0m").at(-1)!;
        expect(line).toContain("waiting");
        expect(atState).toContain(ITALIC);
        expect(atState.includes(DIM)).toBe(stale);
        expect(atState.includes("\x1b[7m")).toBe(selected);
        // The styling ends at the state word, not after the state column's
        // padding: under REVERSE a style left on paints the padding cells.
        expect(line).toContain("waiting\x1b[0m");
        // No styling stays open past the row: nothing follows its last reset
        // but padding (an unselected row resets after the state word, before
        // the state column's padding, as a local row does).
        expect(line).toContain("\x1b[0m");
        expect(line.slice(line.lastIndexOf("\x1b[0m") + "\x1b[0m".length)).not.toContain("\x1b[");
        expect(visibleWidth(line)).toBe(width);
      };
      assertStyle(false, false);
      selectByKey(dashboard, `${name}/app/worker`);
      assertStyle(false, true);
      dashboard.infoPanel.displayHeight = 20;
      const machine = () => dashboard.infoPanel.render(width).find(row => stripAnsi(row).startsWith("Machine:"))!;
      const expectedLine = (connection: string) => {
        const available = width - visibleWidth(`Machine:  · ${connection}`);
        const label = available >= name.length ? name : name.slice(0, available - 1) + "…";
        return `Machine: ${label} · ${connection}`;
      };
      expect(stripAnsi(machine()).trimEnd()).toBe(expectedLine("connected"));
      expect(machine()).toContain(`${GREEN}connected${RESET}`);
      service.set({ links: [{ ...peer, connected: false, connectedAt: null, lastOkAt: Date.now() - 125_000 }] });
      assertStyle(true, true);
      expect(stripAnsi(machine()).trimEnd()).toBe(expectedLine("offline"));
      expect(machine()).toContain(`${RED}offline${RESET}`);
      dashboard.handleInput("k");
      assertStyle(true, false);
    });

    test(`at ${width} columns every row fits, long remote values are cut, and short states stay on screen`, () => {
      const { dashboard, service } = setup();
      const long = remote("n".repeat(100), "r".repeat(100), { repoPath: `/${"p".repeat(200)}`, state: "s".repeat(50), agentType: "t".repeat(100), manager: "m".repeat(100) });
      const short = remote("short", "r".repeat(100), { repoPath: `/${"p".repeat(200)}` });
      service.set({ links: [{ id: PEER_B, name: "P".repeat(32), connected: true, connectedAt: Date.now(), lastOkAt: Date.now(), coordinator: null, lastError: null, repos: repos(long.repoName), agents: [long, short], questions: [] }] });
      const rows = treeRows(dashboard, width);
      expect(rows.filter((r) => visibleWidth(r) > width)).toEqual([]);
      const text = rows.map(stripAnsi);
      expect(text.find((r) => r.includes("short"))).toContain("running");
      expect(text.find((r) => r.includes("nnn"))).toContain("…");
      // The info panel and the whole screen fit too, with the long row selected.
      selectByKey(dashboard, `${"P".repeat(32)}/${"r".repeat(100)}/${"n".repeat(100)}`);
      dashboard.infoPanel.displayHeight = 20;
      expect(dashboard.infoPanel.render(width).filter((r) => visibleWidth(r) > width)).toEqual([]);
      dashboard.sidebarWidth = width;
      expect(dashboard.render(WIDTH).filter((r) => visibleWidth(r) > WIDTH)).toEqual([]);
    });
  }

  test("same-id agents in a shared repo keep their own highlight and info when peer rows move or disconnect", () => {
    const { dashboard, service, local } = setup();
    const name = local.repoRegistryName;
    dashboard.setRepos([{ name, path: local.repoPath }]);
    const peer = (base: PeerLinkState, state: string): PeerLinkState => ({
      ...base, connected: true, connectedAt: Date.now(), coordinator: null, lastError: null, repos: repos(name), agents: [remote(local.id, name, { state })],
    });
    const [first, second] = links();
    const b = peer(first!, "waiting");
    const c = peer(second!, "complete");
    service.set({ links: [b, c] });
    expect(treeRows(dashboard).map(stripAnsi).filter((line) => line.includes(local.id))).toHaveLength(3);
    selectByKey(dashboard, agentKey(PEER_B, name, local.id));
    expect(dashboard.infoPanel.remote).toMatchObject({ peerId: PEER_B });
    const key = agentKey(PEER_C, name, local.id);
    selectByKey(dashboard, key);
    const checkSelection = (linkState: string) => {
      expect(keyOf(dashboard)).toBe(key);
      const highlighted = treeRows(dashboard).filter((r) => r.includes("\x1b[7m")).map(stripAnsi);
      expect(highlighted).toEqual([expect.stringContaining("complete")]);
      dashboard.infoPanel.displayHeight = 20;
      const info = dashboard.infoPanel.render(60).map(stripAnsi).join("\n");
      expect(info).toContain(`Machine: Laptop C · ${linkState}`);
      expect(info).toContain(`Full id: ${key}`);
      expect(dashboard.selectedAgent).toBeNull();
    };
    checkSelection("connected");
    const index = () => dashboard.agentTree.visibleList.findIndex((r) => r.kind === "remote-agent" && peerEntryKey(r) === key);
    const originalIndex = index();
    service.set({ links: [c] });
    expect(index()).toBe(originalIndex - 1);
    checkSelection("connected");
    service.set({ links: [b, c] });
    expect(index()).toBe(originalIndex);
    checkSelection("connected");
    service.set({ links: [b, { ...c, connected: false, connectedAt: null, lastOkAt: Date.now() - 125_000 }] });
    checkSelection("offline");
  });

  test("the @ jump lists only local rows", () => {
    const { dashboard } = setup();
    dashboard.handleInput("@");
    const items = assertDialog(dashboard.dialog, "fuzzy").allItems.map(stripAnsi);
    expect(items.filter((item) => item.includes("agent-1"))).toHaveLength(1);
    expect(items.some((item) => /Laptop|worker-abc|manager-def|itsybitsy|other-repo/.test(item))).toBe(false);
  });

  test("a selected remote agent shows its capture in the center and its fields in the info panel", async () => {
    const { dashboard, service } = setup();
    const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
    try {
      selectByKey(dashboard, WORKER_KEY);
      await waitFor(() => paneText(dashboard.render(WIDTH), 2).startsWith("peer capture"));
      expect(service.fetchPane.mock.calls.at(-1)).toEqual([PEER_B, { op: "agent-pane", repo: "itsybitsy", id: "worker-abc" }, 200]);
      // TREE draws the tree, and QUESTIONS the agent's questions full-width.
      for (const mode of PANE_MODES.filter((m) => m !== "TREE" && m !== "QUESTIONS")) {
        dashboard.jumpToMode(mode);
        // INITIAL PROMPT shows the agent's prompt, read from the peer, instead of the placeholder.
        const prompt = mode === "INITIAL PROMPT";
        if (prompt) await waitFor(() => paneText(dashboard.render(WIDTH), 1).startsWith("Prompt:"));
        const lines = dashboard.render(WIDTH);
        // The message editor sits at the bottom of the center pane, under the
        // capture, as on a local agent's tmux pane, and never spans the right pane.
        expect(paneText(lines, 2)).toMatch(/^peer capture ─+ ❯ ─+ \[Send\] ─+$/);
        // The right pane is narrow at this width: the placeholder wraps rather than being cut.
        expect(paneText(lines, 1)).toBe(prompt ? "Prompt: Prompt for worker-abc second line" : REMOTE_RIGHT_PANE_TEXT);
        expect(stripAnsi(lines[1]!)).toContain(` Laptop B/abc-nick ─`);
        expect(stripAnsi(lines[1]!)).toContain(` ${mode} `);
      }
      // Read once, while INITIAL PROMPT showed the agent; never in the other modes.
      expect(service.fetchAgentPrompt.mock.calls).toEqual([[PEER_B, "itsybitsy", "worker-abc"]]);
      dashboard.infoPanel.displayHeight = 20;
      const info = dashboard.infoPanel.render(60).map((r) => stripAnsi(r).trimEnd()).filter((r) => r !== "");
      expect(info).toEqual([
        "Remote agent (read-only)",
        "Machine: Laptop B · connected",
        "Id: worker-abc",
        "Full id: Laptop B/itsybitsy/worker-abc",
        "Nickname: abc-nick",
        "Repo: itsybitsy",
        "Path: /remote/itsybitsy",
        "State: running",
        "Type: worker",
        "Manager: manager-def",
      ]);

      // Cycling to TREE is still available. Selecting the manager opens its own capture.
      dashboard.jumpToMode("TREE");
      const tree = stripAnsi(dashboard.render(WIDTH).join("\n"));
      expect(tree).toContain("abc-nick");
      expect(tree).not.toContain(REMOTE_RIGHT_PANE_TEXT);
      dashboard.handleInput("k");
      expect(dashboard.rightPane.mode).not.toBe("TREE");
      await waitFor(() => paneText(dashboard.render(WIDTH), 2).startsWith("peer capture"));
      expect(service.fetchPane.mock.calls.at(-1)?.[1]).toEqual({ op: "agent-pane", repo: "itsybitsy", id: "manager-def" });
    } finally {
      running.mockRestore();
      dashboard.stopPolling();
    }
  });

  test("INITIAL PROMPT reads a remote agent's prompt while it shows the agent, caches it per agent, and scrolls it with ; and l", async () => {
    const { dashboard, service } = setup();
    const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
    const replies = new Map<string, PromiseWithResolvers<string>>();
    service.fetchAgentPrompt.mockImplementation((_peerId, _repo, id) => {
      const reply = Promise.withResolvers<string>();
      replies.set(id, reply);
      return reply.promise;
    });
    const right = () => paneText(dashboard.render(WIDTH), 1);
    const ids = () => service.fetchAgentPrompt.mock.calls.map((call) => call[2]);
    try {
      selectByKey(dashboard, WORKER_KEY);
      expect(ids()).toEqual([]);
      dashboard.jumpToMode("INITIAL PROMPT");
      expect(right()).toBe("Loading prompt.txt...");
      const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
      replies.get("worker-abc")!.resolve(long);
      // Anchored at the bottom, as a local agent's prompt is.
      await waitFor(() => right().endsWith("line 99 line 100"));
      // A dialog over the pane pauses the read; closing it reads again at once.
      dashboard.handleInput("?");
      expect(dashboard.dialog).not.toBeNull();
      dashboard.handleInput("\x1b");
      expect(dashboard.dialog).toBeNull();
      expect(ids()).toEqual(["worker-abc", "worker-abc"]);
      replies.get("worker-abc")!.resolve(long);
      await Bun.sleep(0);
      for (let i = 0; i < 40; i++) dashboard.handleInput(";");
      expect(right()).toStartWith("Prompt: line 1 line 2 ");
      for (let i = 0; i < 40; i++) dashboard.handleInput("l");
      expect(right()).toEndWith("line 99 line 100");

      // A failed read shows its reason, as a local read failure does.
      dashboard.handleInput("k");
      expect(keyOf(dashboard)).toBe(agentKey(PEER_B, "itsybitsy", "manager-def"));
      expect(right()).toBe("Loading prompt.txt...");
      replies.get("manager-def")!.reject(new Error("Machine is disconnected"));
      await waitFor(() => right() === "Prompt: Machine is disconnected");

      // Back on the worker, its cached prompt shows at once while it is read again.
      dashboard.handleInput("j");
      expect(right()).toEndWith("line 99 line 100");
      expect(ids()).toEqual(["worker-abc", "worker-abc", "manager-def", "worker-abc"]);
      // That read finishes after the selection moved: it is cached, not shown.
      dashboard.handleInput("k");
      replies.get("worker-abc")!.resolve("a changed prompt");
      await Bun.sleep(0);
      expect(right()).toBe("Loading prompt.txt...");
      dashboard.handleInput("j");
      expect(right()).toBe("Prompt: a changed prompt");

      // Passing the manager starts no second read while its last one is pending.
      // A remote repo header keeps the placeholder and reads nothing.
      dashboard.handleInput("k");
      dashboard.handleInput("k");
      expect(keyOf(dashboard)).toBe(repoKey("itsybitsy"));
      expect(right()).toBe(REMOTE_RIGHT_PANE_TEXT);
      expect(ids()).toEqual(["worker-abc", "worker-abc", "manager-def", "worker-abc", "manager-def", "worker-abc"]);
    } finally {
      running.mockRestore();
      dashboard.stopPolling();
    }
  });

  test("a remote-only header keeps the repo placeholder, and a stale agent shows its last contact", () => {
    const { dashboard } = setup();
    selectByKey(dashboard, repoKey("itsybitsy"));
    expect(paneText(dashboard.render(WIDTH), 2)).toBe("Remote repo on Laptop B (read-only)");
    dashboard.infoPanel.displayHeight = 20;
    expect(dashboard.infoPanel.render(60).map(stripAnsi).join("\n")).toContain("Agents: 2");
    selectByKey(dashboard, agentKey(PEER_C, "app", "agent-1"));
    expect(dashboard.infoPanel.render(60).map(stripAnsi).join("\n")).toContain("Machine: Laptop C · offline");
  });

  test("on a remote row no local path runs: no tmux setAgent, no git probe, no right-pane loader", async () => {
    const { dashboard } = setup();
    // Let the local agent's first git probe finish before recording.
    await waitFor(() => !(dashboard as any).gitStatusInFlight, { timeoutMs: WAIT_TIMEOUT_MS, message: "the local git probe" });
    const sessions: (string | null)[] = [];
    for (const name of ["tmuxPoller", "coordinatorPoller", "repoCoordinatorPoller"]) {
      const poller = (dashboard as any)[name];
      const setAgent = poller.setAgent.bind(poller);
      poller.setAgent = (session: string | null) => {
        sessions.push(session);
        setAgent(session);
      };
    }
    const realTrigger = paneManager.triggerAsyncLoadIfNeeded;
    const triggeredWith: unknown[] = [];
    const loaders = [
      spyOn(paneManager, "loadAgentLog"),
      spyOn(paneManager, "loadTailLog"),
      spyOn(paneManager, "loadAgentPrompt"),
    ];
    const trigger = spyOn(paneManager, "triggerAsyncLoadIfNeeded").mockImplementation((ctx, force) => {
      triggeredWith.push(ctx.agentTree.selectedAgent);
      realTrigger(ctx, force);
    });
    try {
      spawns.length = 0;
      selectByKey(dashboard, WORKER_KEY);
      for (const mode of PANE_MODES) dashboard.jumpToMode(mode);
      dashboard.jumpToMode("AGENT LOG");
      for (const key of ["p", "n", "j", "k"]) dashboard.handleInput(key);
      dashboard.loadTailLogIfNeeded("WATCHDOG LOG");
      await (dashboard as any).refreshGitStatus();
      dashboard.render(WIDTH);
      await Bun.sleep(5);

      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((s) => s === null)).toBe(true);
      for (const loader of loaders) expect(loader).not.toHaveBeenCalled();
      expect(triggeredWith.length).toBeGreaterThan(0);
      expect(triggeredWith.every((agent) => agent === null)).toBe(true);
      expect(spawns).toEqual([]);
      expect(dashboard.rightPane.agent).toBeNull();
      expect(dashboard.tmuxPane.agent).toBeNull();
      expect(dashboard.infoPanel.agent).toBeNull();
    } finally {
      for (const loader of loaders) loader.mockRestore();
      trigger.mockRestore();
    }
  });

  test("remote text input retains a refused draft and clears it on acceptance", async () => {
    const { dashboard, service } = setup();
    selectByKey(dashboard, WORKER_KEY);
    focusEditor(dashboard);
    dashboard.handleInput("/compact");
    service.remoteStartDenial = "Remote starts are disabled inside tmux";
    dashboard.inputField.submit();
    await Bun.sleep(0);
    expect(dashboard.notice).toBe("Remote sends are disabled while ib watch runs inside tmux; restart ib watch from a terminal outside tmux");
    service.remoteStartDenial = "Only a human can start an agent on another machine";
    dashboard.inputField.submit();
    await Bun.sleep(0);
    expect(dashboard.notice).toBe("Only a human can send to another machine");
    expect(service.sendRemoteMessage).not.toHaveBeenCalled();
    expect(dashboard.inputField.getText()).toBe("/compact");

    service.remoteStartDenial = null;
    service.sendRemoteMessage.mockRejectedValueOnce(new Error("Machine is disconnected"));
    dashboard.inputField.submit();
    await waitFor(() => dashboard.notice !== "Only a human can send to another machine");
    expect(dashboard.notice).toBe("Machine is disconnected");
    expect(dashboard.inputField.getText()).toBe("/compact");

    const pending = Promise.withResolvers<string>();
    service.sendRemoteMessage.mockImplementationOnce(() => pending.promise);
    dashboard.inputField.submit();
    await Bun.sleep(3100);
    expect(stripAnsi(dashboard.render(WIDTH).join("\n"))).toContain("sending to Laptop B/");
    const [peer, header] = service.sendRemoteMessage.mock.calls[1]!;
    expect(peer).toBe(PEER_B);
    expect(header).toMatchObject({ from: { kind: "user" }, message: "/compact", files: [],
      target: { kind: "agent", repo: "itsybitsy", agent: "worker-abc" } });
    pending.resolve(header.id);
    await waitFor(() => dashboard.inputField.getText() === "");
    expect(dashboard.notice).toContain("Sent to Laptop B/");
  });

  test("s on a remote agent opens the send dialog: a failure keeps the draft, acceptance closes it", async () => {
    const { dashboard, service } = setup();
    selectByKey(dashboard, WORKER_KEY);
    dashboard.handleInput("s");
    const send = assertDialog(dashboard.dialog, "textarea");
    expect(send.prompt).toBe("Send message to Laptop B/abc-nick:");
    expect(send.sendAll).toBeUndefined();
    expect(send.onSendEsc).toBeUndefined();
    expect(dashboard.focusManager.subFocus).toBe("pane");
    for (const ch of "/compact") dashboard.handleInput(ch);
    dashboard.handleInput("\x1b[Z");
    expect(send.focusedButton).toBe("send");
    // Enter on [ Send ]; focus stays there for the retry.
    const submit = () => dashboard.handleInput("\r");

    service.sendRemoteMessage.mockRejectedValueOnce(new Error("Machine is disconnected"));
    submit();
    await waitFor(() => dashboard.notice === "Machine is disconnected");
    await Bun.sleep(0);
    expect(dashboard.dialog).toBe(send);
    expect(send.inFlight).toBe(false);
    expect(send.buffer.getText()).toBe("/compact");

    const pending = Promise.withResolvers<string>();
    service.sendRemoteMessage.mockImplementationOnce(() => pending.promise);
    submit();
    expect(send.inFlight).toBe(true);
    await waitFor(() => service.sendRemoteMessage.mock.calls.length === 2);
    const [peer, header] = service.sendRemoteMessage.mock.calls[1]!;
    expect(peer).toBe(PEER_B);
    expect(header).toMatchObject({ from: { kind: "user" }, message: "/compact", files: [],
      target: { kind: "agent", repo: "itsybitsy", agent: "worker-abc" } });
    pending.resolve(header.id);
    await waitFor(() => dashboard.dialog === null);
    expect(dashboard.notice).toBe("Sent to Laptop B/abc-nick");
  });

  test("Esc cancels a remote send in flight from the dialog and keeps the draft", async () => {
    const { dashboard, service } = setup();
    service.sendRemoteMessage.mockImplementationOnce((_peer, header, _source, transfer) =>
      new Promise((_, reject) => transfer!.signal!.addEventListener("abort", () => reject(transfer!.signal!.reason))));
    selectByKey(dashboard, WORKER_KEY);
    dashboard.handleInput("s");
    const send = assertDialog(dashboard.dialog, "textarea");
    for (const ch of "hello") dashboard.handleInput(ch);
    dashboard.handleInput("\x1b[Z");
    dashboard.handleInput("\r");
    await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
    const overlay = () => stripAnsi(((dashboard as any).dialogOverlay.render(80) as string[]).join("\n"));
    expect(overlay()).toContain("Sending… Esc: cancel");
    dashboard.handleInput("x");
    expect(send.buffer.getText()).toBe("hello");
    dashboard.handleInput("\x1b");
    await waitFor(() => dashboard.notice === "Send cancelled");
    await Bun.sleep(0);
    expect(dashboard.dialog).toBe(send);
    expect(send.inFlight).toBe(false);
    expect(send.buffer.getText()).toBe("hello");
    expect(overlay()).not.toContain("Sending…");
    dashboard.handleInput("\x1b");
    expect(dashboard.dialog).toBeNull();
  });

  test("a pending remote send shows in the header alert and leaves the layout in place", async () => {
    const { dashboard, service } = setup();
    selectByKey(dashboard, WORKER_KEY);
    const before = dashboard.render(WIDTH).map(stripAnsi);
    const pending = Promise.withResolvers<string>();
    service.sendRemoteMessage.mockImplementationOnce(() => pending.promise);
    dashboard.handleInput("s");
    assertDialog(dashboard.dialog, "textarea").onSubmit("hello");
    await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
    dashboard.closeDialog();
    const during = dashboard.render(WIDTH);
    expect(during).toHaveLength(before.length);
    expect(stripAnsi(during[0]!)).toStartWith("ib — sending to Laptop B/abc-nick…");
    expect(during[0]).toContain(YELLOW);
    expect(during.slice(1).map(stripAnsi)).toEqual(before.slice(1));
    // A long alert ends in "…", and leaves any indicators on the line.
    dashboard.setNotice("x".repeat(WIDTH), "info");
    const bare = stripAnsi(dashboard.render(WIDTH)[0]!);
    expect(bare).toEndWith("…");
    expect(visibleWidth(bare)).toBeLessThanOrEqual(WIDTH);
    dashboard.setTelegramStatus("green");
    const header = stripAnsi(dashboard.render(WIDTH)[0]!);
    expect(header).toMatch(/…\s+● Telegram$/);
    expect(visibleWidth(header)).toBeLessThanOrEqual(WIDTH);
    pending.resolve(service.sendRemoteMessage.mock.calls[0]![1].id);
    await waitFor(() => dashboard.notice === "Sent to Laptop B/abc-nick");
  });

  test("a multi-line notice is joined onto the header's one row", () => {
    const { dashboard } = setup();
    // The shape of a failed pull before `ib merge` (status lines with indented detail).
    dashboard.setNotice("Merge failed: Pull of main failed, so nothing was merged:\n✗ origin: fatal: no repo\n  fatal: Could not read\n", "error");
    expect(dashboard.notice).toBe("Merge failed: Pull of main failed, so nothing was merged: · ✗ origin: fatal: no repo · fatal: Could not read");
    // A "\n" inside the header row would push the rest of the screen down a row.
    const header = dashboard.render(WIDTH)[0]!;
    expect(header).not.toContain("\n");
    expect(stripAnsi(header)).toStartWith("ib — Merge failed: Pull of main failed");
  });

  test.each(["Esc", "shutdown"])("remote row detects files, shows progress and cleans staging on %s", async action => {
    const home = await mkdtemp(join(tmpdir(), "ib-dashboard-transfer-"));
    setUserHome(home);
    const { processStartEpochSecondsCtx } = await import("../agents");
    const stagingRoot = spyOn(await import("../runtime-names"), "transferStagingRoot").mockReturnValue(join(home, "staging"));
    processStartEpochSecondsCtx.set(() => 123);
    try {
      await Bun.write(join(home, ".itsybitsy/machine-name"), "sender");
      const source = join(home, "notes.txt");
      await Bun.write(source, "contents");
      const { dashboard, service } = setup();
      const entered = Promise.withResolvers<void>();
      let staged: string | undefined;
      service.sendRemoteMessage.mockImplementationOnce(async (_peer, header, _source, transfer) => {
        expect(header.files).toHaveLength(1);
        expect(header.files[0]?.spellings).toContain(source);
        staged = join(transfer!.filesDir!, "0");
        expect(await Bun.file(staged).text()).toBe("contents");
        transfer!.onProgress!(3);
        entered.resolve();
        return new Promise((_, reject) => transfer!.signal!.addEventListener("abort", () => reject(transfer!.signal!.reason)));
      });
      selectByKey(dashboard, WORKER_KEY);
      focusEditor(dashboard);
      dashboard.handleInput(`Read ${source} and ./live.ts`);
      dashboard.inputField.submit();
      await submitPathDialog(dashboard, [source]);
      await entered.promise;
      expect(stripAnsi(dashboard.render(WIDTH).join("\n"))).toContain("3 / 8 bytes");
      if (action === "Esc") dashboard.handleInput("\x1b");
      else await dashboard.stopRemoteSends();
      await waitFor(() => dashboard.notice === (action === "Esc" ? "Send cancelled" : "Dashboard shutting down"));
      await waitFor(async () => !await Bun.file(staged!).exists());
      expect(dashboard.inputField.getText()).toContain(source);
    } finally { stagingRoot.mockRestore(); processStartEpochSecondsCtx.reset(); resetUserHome(); await rm(home, { recursive: true, force: true }); }
  });

  test("a dashboard snapshot whose owner cannot be verified is refused locally", async () => {
    const home = await mkdtemp(join(tmpdir(), "ib-dashboard-owner-"));
    const { processStartEpochSecondsCtx } = await import("../agents");
    setUserHome(home);
    const stagingRoot = spyOn(await import("../runtime-names"), "transferStagingRoot").mockReturnValue(join(home, "staging"));
    processStartEpochSecondsCtx.set(() => null);
    try {
      const path = join(home, "file");
      await Bun.write(path, "contents");
      await Bun.write(join(home, ".itsybitsy/machine-name"), "sender");
      const { dashboard, service } = setup();
      selectByKey(dashboard, WORKER_KEY);
      focusEditor(dashboard);
      dashboard.handleInput(path);
      dashboard.inputField.submit();
      await submitPathDialog(dashboard, [path]);
      await waitFor(() => dashboard.notice === "Cannot verify the outgoing attachment owner");
      expect(service.sendRemoteMessage).not.toHaveBeenCalled();
      await dashboard.stopRemoteSends();
    } finally { stagingRoot.mockRestore(); processStartEpochSecondsCtx.reset(); resetUserHome(); await rm(home, { recursive: true, force: true }); }
  });

  test("a mixed-case local registry root resolves a relative reference for the peer", async () => {
    const project = await mkdtemp(join(tmpdir(), "ib-project-case-"));
    try {
      await Bun.write(join(project, "file"), "live");
      const { dashboard, service } = setup();
      dashboard.setRepos([{ name: "ITSYBITSY", path: project }]);
      selectByKey(dashboard, WORKER_KEY);
      focusEditor(dashboard);
      dashboard.handleInput("./file");
      dashboard.inputField.submit();
      await submitPathDialog(dashboard, ["./file"], []);
      await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
      expect(service.sendRemoteMessage.mock.calls[0]![1]).toMatchObject({ files: [], message: "./file", noPassthrough: true });
    } finally { await rm(project, { recursive: true, force: true }); }
  });

  test("a missing path is sent as raw text without a path dialog", async () => {
    const { dashboard, service } = setup();
    const shown = spyOn(dashboard, "showDialog");
    selectByKey(dashboard, WORKER_KEY);
    focusEditor(dashboard);
    dashboard.handleInput("/nonexistent/fake.png is gone");
    dashboard.inputField.submit();
    await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
    expect(service.sendRemoteMessage.mock.calls[0]![1]).toMatchObject({ files: [], message: "/nonexistent/fake.png is gone", noPassthrough: true });
    expect(shown).not.toHaveBeenCalled();
    await waitFor(() => dashboard.notice === "Sent to Laptop B/abc-nick");
  });

  test("checked paths are attached and unchecked ones are sent as raw text", async () => {
    const home = await mkdtemp(join(tmpdir(), "ib-dashboard-pick-"));
    setUserHome(home);
    const { processStartEpochSecondsCtx } = await import("../agents");
    const stagingRoot = spyOn(await import("../runtime-names"), "transferStagingRoot").mockReturnValue(join(home, "staging"));
    processStartEpochSecondsCtx.set(() => 123);
    try {
      await Bun.write(join(home, ".itsybitsy/machine-name"), "sender");
      const picked = join(home, "picked.txt");
      const left = join(home, "left.txt");
      await Bun.write(picked, "picked");
      await Bun.write(left, "left");
      const { dashboard, service } = setup();
      let copied: string | undefined;
      service.sendRemoteMessage.mockImplementationOnce(async (_peer, header, _source, transfer) => {
        copied = await Bun.file(join(transfer!.filesDir!, "0")).text();
        return header.id;
      });
      selectByKey(dashboard, WORKER_KEY);
      focusEditor(dashboard);
      const text = `Compare ${picked} with ${left}`;
      dashboard.handleInput(text);
      dashboard.inputField.submit();
      await waitFor(() => dashboard.dialog?.type === "multi-select");
      const picker = assertDialog(dashboard.dialog, "multi-select");
      expect(picker.items).toEqual([picked, left]);
      expect(picker.checked).toEqual([false, false]);
      for (const key of [" ", "\r"]) dashboard.handleInput(key);
      await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
      const header = service.sendRemoteMessage.mock.calls[0]![1];
      expect(header.message).toBe(text);
      expect(header.files).toHaveLength(1);
      expect(header.files[0]!.spellings).toContain(picked);
      expect(header.files[0]!.spellings).not.toContain(left);
      await waitFor(() => dashboard.inputField.getText() === "");
      expect(copied).toBe("picked");
    } finally { stagingRoot.mockRestore(); processStartEpochSecondsCtx.reset(); resetUserHome(); await rm(home, { recursive: true, force: true }); }
  });

  test("two spellings of one file are one row, and checking it attaches the file with both", async () => {
    const home = await mkdtemp(join(tmpdir(), "ib-dashboard-one-row-"));
    setUserHome(home);
    const { processStartEpochSecondsCtx } = await import("../agents");
    const stagingRoot = spyOn(await import("../runtime-names"), "transferStagingRoot").mockReturnValue(join(home, "staging"));
    processStartEpochSecondsCtx.set(() => 123);
    try {
      await Bun.write(join(home, ".itsybitsy/machine-name"), "sender");
      const checkout = join(home, "checkout");
      const live = join(checkout, "live.ts");
      await Bun.write(live, "live");
      const { dashboard, service } = setup();
      dashboard.setRepos([{ name: "itsybitsy", path: checkout }]);
      selectByKey(dashboard, WORKER_KEY);
      focusEditor(dashboard);
      const text = `Compare ./live.ts with ${live}`;
      dashboard.handleInput(text);
      dashboard.inputField.submit();
      await submitPathDialog(dashboard, ["./live.ts"]);
      await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
      const header = service.sendRemoteMessage.mock.calls[0]![1];
      expect(header.message).toBe(text);
      expect(header.files).toHaveLength(1);
      expect(header.files[0]!.spellings).toEqual(expect.arrayContaining(["./live.ts", live]));
    } finally { stagingRoot.mockRestore(); processStartEpochSecondsCtx.reset(); resetUserHome(); await rm(home, { recursive: true, force: true }); }
  });

  test("cancelling the path dialog sends nothing and keeps the draft", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-dashboard-cancel-"));
    try {
      const file = join(dir, "notes.txt");
      await Bun.write(file, "notes");
      const { dashboard, service } = setup();
      selectByKey(dashboard, WORKER_KEY);
      focusEditor(dashboard);
      const draft = `Read ${file}`;
      dashboard.handleInput(draft);
      dashboard.inputField.submit();
      await waitFor(() => dashboard.dialog?.type === "multi-select");
      // The dialog asks before the send is pending.
      expect(stripAnsi(dashboard.render(WIDTH)[0]!)).not.toContain("sending to");
      dashboard.handleInput("\x1b");
      await waitFor(() => dashboard.notice === "Send cancelled");
      await Bun.sleep(0);
      expect(dashboard.dialog).toBeNull();
      expect(service.sendRemoteMessage).not.toHaveBeenCalled();
      expect(dashboard.inputField.getText()).toBe(draft);

      // The kept draft sends on the next submit, here with the path unchecked.
      dashboard.inputField.submit();
      await waitFor(() => dashboard.dialog?.type === "multi-select");
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.inputField.getText() === "");
      expect(service.sendRemoteMessage.mock.calls.map(call => call[1])).toMatchObject([{ message: draft, files: [] }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("the s dialog comes back when the path dialog closes, frozen while the send waits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-dashboard-restore-"));
    try {
      const file = join(dir, "notes.txt");
      await Bun.write(file, "notes");
      const { dashboard, service } = setup();
      selectByKey(dashboard, WORKER_KEY);
      dashboard.handleInput("s");
      const send = assertDialog(dashboard.dialog, "textarea");
      const draft = `Read ${file}`;
      for (const ch of draft) dashboard.handleInput(ch);
      dashboard.handleInput("\x1b[Z");
      const submit = async () => {
        dashboard.handleInput("\r");
        await waitFor(() => dashboard.dialog?.type === "multi-select");
        expect(send.inFlight).toBe(true);
      };

      // Esc on the path dialog: the s dialog is back with its draft, editable.
      await submit();
      dashboard.handleInput("\x1b");
      expect(dashboard.dialog).toBe(send);
      await waitFor(() => !send.inFlight);
      expect(dashboard.notice).toBe("Send cancelled");
      expect(send.buffer.getText()).toBe(draft);
      expect(service.sendRemoteMessage).not.toHaveBeenCalled();

      // Unchecked and submitted: the s dialog is back, frozen, and Esc cancels the send.
      service.sendRemoteMessage.mockImplementationOnce((_peer, _header, _source, transfer) =>
        new Promise((_, reject) => transfer!.signal!.addEventListener("abort", () => reject(transfer!.signal!.reason))));
      await submit();
      dashboard.handleInput("\r");
      expect(dashboard.dialog).toBe(send);
      await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
      expect(service.sendRemoteMessage.mock.calls[0]![1]).toMatchObject({ message: draft, files: [] });
      const overlay = () => stripAnsi(((dashboard as any).dialogOverlay.render(80) as string[]).join("\n"));
      expect(overlay()).toContain("Sending… Esc: cancel");
      dashboard.handleInput("\x1b");
      await waitFor(() => !send.inFlight);
      expect(dashboard.dialog).toBe(send);
      expect(dashboard.notice).toBe("Send cancelled");
      expect(send.buffer.getText()).toBe(draft);

      // Acceptance closes the s dialog, not some other one.
      await submit();
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog === null);
      expect(dashboard.notice).toBe("Sent to Laptop B/abc-nick");
      expect(service.sendRemoteMessage).toHaveBeenCalledTimes(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("Esc on the s dialog while its paths are looked up cancels before any path dialog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-dashboard-early-esc-"));
    try {
      const file = join(dir, "notes.txt");
      await Bun.write(file, "notes");
      const { dashboard, service } = setup();
      const shown = spyOn(dashboard, "showDialog");
      selectByKey(dashboard, WORKER_KEY);
      dashboard.handleInput("s");
      const send = assertDialog(dashboard.dialog, "textarea");
      for (const ch of `Read ${file}`) dashboard.handleInput(ch);
      dashboard.handleInput("\x1b[Z");
      dashboard.handleInput("\r");
      dashboard.handleInput("\x1b");
      await waitFor(() => !send.inFlight);
      expect(dashboard.notice).toBe("Send cancelled");
      expect(dashboard.dialog).toBe(send);
      expect(shown).toHaveBeenCalledTimes(1);
      expect(service.sendRemoteMessage).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("a local editor keeps Escape while remote requests have duplicate display labels", async () => {
    const { dashboard, service, local } = setup();
    const result = Promise.withResolvers<string>();
    service.sendRemoteMessage.mockImplementation(() => result.promise);
    const sameLabel = links();
    sameLabel[0]!.agents = sameLabel[0]!.agents!.map(agent => ({ ...agent, nickname: "duplicate" }));
    service.set({ links: sameLabel });
    for (const key of [WORKER_KEY, agentKey(PEER_B, "itsybitsy", "manager-def")]) {
      dashboard.focusManager.setFocus("agent-tree");
      selectByKey(dashboard, key);
      focusEditor(dashboard);
      dashboard.handleInput("hello");
      dashboard.inputField.submit();
    }
    await waitFor(() => service.sendRemoteMessage.mock.calls.length === 2);
    // Both pending sends share the header line's alert.
    const header = () => stripAnsi(dashboard.render(WIDTH)[0]!);
    expect(header().match(/sending to Laptop B\/duplicate…/g)).toHaveLength(2);
    expect(header().match(/Esc: cancel/g)).toHaveLength(1);
    dashboard.agentTree.selectAgent(local);
    dashboard.syncSelectedAgent();
    dashboard.focusManager.setFocus("active-agent");
    dashboard.focusManager.setSubFocus("input");
    expect(header().match(/sending to Laptop B\/duplicate…/g)).toHaveLength(2);
    expect(header()).not.toContain("Esc: cancel");
    dashboard.handleInput("\x1b");
    expect(dashboard.focusManager.subFocus).toBe("pane");
    expect(service.sendRemoteMessage.mock.calls.every(call => !call[3]?.signal?.aborted)).toBe(true);
    result.resolve("accepted");
  });

  test("dashboard submission and incoming admission reserve the same temporary volume", async () => {
    const { createCliFixture } = await import("../test-cli-runner");
    const { createMessageReceiver } = await import("../peers/receive-message");
    const { createAttachmentReceiver } = await import("../peers/receive-attachments");
    const { textHeader } = await import("../peers/peer-outbox");
    const space = await import("../peers/attachment-space");
    const cli = await createCliFixture();
    setUserHome(cli.home);
    const { processStartEpochSecondsCtx } = await import("../agents");
    const stagingRoot = spyOn(await import("../runtime-names"), "transferStagingRoot").mockReturnValue(join(cli.root, "staging"));
    processStartEpochSecondsCtx.set(() => 123);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen: number[] = [];
    const receiver = createMessageReceiver(() => {}, () => {}, Date.now, 4096, createAttachmentReceiver({
      tempDir: "/tmp", hasFreeSpace: async (_dir, bytes) => { seen.push(bytes); return false; },
    }));
    const actual = space.hasFreeSpace;
    const spy = spyOn(space, "hasFreeSpace").mockImplementation(async (dir, bytes) => {
      if (!dir.startsWith(join(cli.root, "staging/outgoing") + "/")) return actual(dir, bytes);
      entered.resolve(); await release.promise; return true;
    });
    try {
      await Bun.write(join(cli.home, ".itsybitsy/machine-name"), "local");
      const repo = await cli.addRepo("example");
      await cli.addAgent(repo, "worker", { tmux_session: "ib-worker" });
      tmuxPollerSpawnCtx.set(() => makeSpawnResult(0, "0"));
      const source = join(cli.home, "report");
      await Bun.write(source, "abc");
      const { dashboard, service } = setup();
      selectByKey(dashboard, WORKER_KEY);
      focusEditor(dashboard);
      dashboard.handleInput(source);
      dashboard.inputField.submit();
      await submitPathDialog(dashboard, [source]);
      await entered.promise;
      const header = textHeader({ kind: "agent", agent: "worker" }, "read", { kind: "user" });
      header.files = [{ name: "file", size: 4, sha256: "0".repeat(64), spellings: ["file"] }];
      await expect(receiver(header, "peer", async () => "desk", { read: async () => Buffer.alloc(0) })).rejects.toThrow("Insufficient space");
      expect(seen).toEqual([7]);
      release.resolve();
      await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
      await dashboard.stopRemoteSends();
    } finally { stagingRoot.mockRestore(); processStartEpochSecondsCtx.reset(); release.resolve(); spy.mockRestore(); resetUserHome(); await cli.cleanup(); }
  });

  test("dashboard quit closes a held reset before exit and startup reclaims stranded staging", async () => {
    const { PeerService, defaultPeerServiceDeps } = await import("../peers/service");
    const { requestSend } = await import("../peers/peer-link");
    const { createMemoryLink } = await import("../peers/test-pair-transport");
    const owners = await import("../peers/transfer-owner");
    const { processStartEpochSecondsCtx } = await import("../agents");
    const fs = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "ib-quit-recovery-"));
    setUserHome(root);
    processStartEpochSecondsCtx.set(() => 123);
    const create = owners.makeOutgoingDirectory;
    let staged = "";
    const make = spyOn(owners, "makeOutgoingDirectory").mockImplementation(async () => staged = await create(root));
    const remove = fs.rm;
    const failCleanup = spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (staged && path === staged) throw Error("storage temporarily unavailable");
      return remove(path, options);
    });
    const { a, b } = createMemoryLink("sender", "peer");
    const started = Promise.withResolvers<void>();
    const open = a.openBi.bind(a);
    a.openBi = async () => {
      const stream = await open();
      stream.write = async () => { started.resolve(); return new Promise(() => {}); };
      stream.cancel = () => new Promise(() => {});
      return stream;
    };
    const deps = { ...defaultPeerServiceDeps("local", () => {}, () => ({ agents: [], repos: [], coordinator: null, questions: [] }), () => {}, null),
      readPeers: async () => [], recoverTransfers: () => owners.sweepOutgoingDirectories(root) };
    const next = new PeerService(deps);
    try {
      const source = join(root, "report");
      await Bun.write(source, "file");
      await Bun.write(join(root, ".itsybitsy/machine-name"), "sender");
      const { dashboard, service } = setup();
      service.sendRemoteMessage.mockImplementation((_peer, header, _source, transfer) =>
        requestSend(a, header, (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }, transfer));
      selectByKey(dashboard, WORKER_KEY);
      focusEditor(dashboard);
      dashboard.handleInput(source);
      dashboard.inputField.submit();
      await submitPathDialog(dashboard, [source]);
      await started.promise;
      await dashboard.shutdownPeerTransfers(new PeerService(deps));
      expect(b.closeInfo()?.reason).toBe("send reset stalled");
      expect(await Bun.file(join(staged, "owner.json")).json()).toEqual({ pid: process.pid, start: 123 });
      failCleanup.mockRestore();
      processStartEpochSecondsCtx.set(() => 124);
      await next.bootIfPaired();
      expect(await Bun.file(join(staged, "owner.json")).exists()).toBe(false);
    } finally {
      await next.shutdown(); a.close(0, "done");
      failCleanup.mockRestore(); make.mockRestore(); processStartEpochSecondsCtx.reset();
      resetUserHome(); await remove(root, { recursive: true, force: true });
    }
  });

  test("a local selection renders receipt admission, one coalesced progress burst, and removal", async () => {
    const { PeerService, defaultPeerServiceDeps } = await import("../peers/service");
    const { textHeader } = await import("../peers/peer-outbox");
    const release = Promise.withResolvers<void>();
    const service = new PeerService({ ...defaultPeerServiceDeps("local", () => {}, () => ({ agents: [], repos: [], coordinator: null, questions: [] }), () => {}, null),
      receiveMessage: async (_header, _peer, _name, _body, options) => {
        options?.admitted?.(true);
        for (let byte = 1; byte <= 100; byte++) options?.onProgress?.(byte);
        await release.promise;
      },
    });
    const { dashboard } = setup();
    const counter = countingTui();
    dashboard.setTui(counter.tui);
    let beforeNotify = 0;
    service.onChange(() => { beforeNotify = counter.renders(); });
    dashboard.setPeerService(service);
    expect(dashboard.remoteSelection).toBeNull();
    const notifications = mock(() => { expect(counter.renders()).toBe(beforeNotify + 1); });
    service.onChange(notifications);
    const header = textHeader({ kind: "system" }, "read", { kind: "user" });
    header.files = [{ name: "f", size: 100, sha256: "0".repeat(64), spellings: ["f"] }];
    const transfer = service.receiveTracked(header, PEER_B, async () => "peer");
    try {
      expect(notifications).toHaveBeenCalledTimes(1);
      await waitFor(() => notifications.mock.calls.length === 2);
      expect(stripAnsi(dashboard.render(WIDTH).join("\n"))).toContain("100 / 100 bytes");
    } finally { release.resolve(); await transfer; }
    expect(notifications).toHaveBeenCalledTimes(3);
  });

  test("an inbound transfer shows in the header alert; Ctrl-T selects it and Esc aborts that receipt", () => {
    const { dashboard, service } = setup();
    const before = dashboard.render(WIDTH).map(stripAnsi);
    service.set({ incoming: [{ id: "first", label: "Laptop → worker", bytes: 3, total: 12 }] });
    const header = () => stripAnsi(dashboard.render(WIDTH)[0]!);
    expect(header()).toStartWith("ib — receiving Laptop → worker  3 / 12 bytes  Ctrl-T: select");
    expect(dashboard.render(WIDTH).slice(1).map(stripAnsi)).toEqual(before.slice(1));
    dashboard.handleInput("\x14");
    expect(header()).toStartWith("ib — › receiving Laptop → worker  3 / 12 bytes  Esc: cancel");
    dashboard.handleInput("\x1b");
    expect(service.cancelReceipt.mock.calls).toEqual([["first"]]);
  });

  test("a Ctrl-T-selected receipt leads the header alert ahead of a pending send", async () => {
    const { dashboard, service } = setup();
    const pending = Promise.withResolvers<string>();
    service.sendRemoteMessage.mockImplementationOnce(() => pending.promise);
    selectByKey(dashboard, WORKER_KEY);
    dashboard.handleInput("s");
    assertDialog(dashboard.dialog, "textarea").onSubmit("hello");
    await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
    dashboard.closeDialog();
    service.set({ incoming: [{ id: "first", label: "Laptop → worker", bytes: 3, total: 12 }] });
    const header = () => stripAnsi(dashboard.render(WIDTH)[0]!);
    expect(header()).toStartWith("ib — sending to Laptop B/abc-nick…  Esc: cancel  ·  receiving Laptop → worker");
    dashboard.handleInput("\x14");
    expect(header()).toStartWith("ib — › receiving Laptop → worker  3 / 12 bytes  Esc: cancel  ·  sending to Laptop B/abc-nick…");
    expect(header().match(/Esc: cancel/g)).toHaveLength(1);
    pending.resolve(service.sendRemoteMessage.mock.calls[0]![1].id);
    await waitFor(() => dashboard.notice === "Sent to Laptop B/abc-nick");
  });

  test("incoming notices and overlapping completions leave each pending send visible", async () => {
    const { dashboard, service } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    dashboard.agentTree.selectSystemCoordinator();
    dashboard.syncSelectedAgent();
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    service.sendRemoteMessage.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    for (const key of [PEER_B + "/@system", WORKER_KEY]) {
      dashboard.focusManager.setFocus("agent-tree");
      selectByKey(dashboard, key);
      focusEditor(dashboard);
      dashboard.handleInput("hello");
      dashboard.inputField.submit();
    }
    await waitFor(() => service.sendRemoteMessage.mock.calls.length === 2);
    const content = () => stripAnsi(dashboard.render(WIDTH).join("\n"));
    dashboard.setNotice("Incoming peer message", "info");
    // The notice comes first, then each send; the one Esc cancels leads.
    expect(stripAnsi(dashboard.render(WIDTH)[0]!)).toMatch(
      /^ib — Incoming peer message {2}· {2}sending to Laptop B\/abc-nick… {2}Esc: cancel {2}· {2}sending to Laptop B\/@system…/);
    expect(content().match(/sending to Laptop B\//g)).toHaveLength(2);
    first.resolve("first");
    await Bun.sleep(0);
    expect(content()).toContain("Sent to Laptop B/@system");
    expect(content()).not.toContain("sending to Laptop B/@system");
    expect(content()).toContain("sending to Laptop B/");
    second.reject(new Error("disconnected"));
    await Bun.sleep(0);
    expect(content()).toContain("disconnected");
    expect(content()).not.toContain("sending to Laptop B/");
  });

  test("remote m checks before confirming keep, x confirms retirement, and R resumes directly", async () => {
    const { dashboard, service } = setup();
    selectByKey(dashboard, WORKER_KEY);
    const run = spyOn(service, "runRemoteLifecycle").mockResolvedValue({ output: "Ready to merge" });
    dashboard.handleInput("m");
    await Bun.sleep(0);
    const merge = assertDialog(dashboard.dialog, "confirm");
    expect(merge.prompt).toContain("Ready to merge");
    expect(merge.focusedButton).toBe("cancel");
    expect(run.mock.calls).toEqual([[PEER_B, { id: "worker-abc", repo: "itsybitsy", action: "merge", checkOnly: true }]]);
    merge.checkbox!.checked = true;
    run.mockResolvedValueOnce({ output: "Nothing to merge: branch is current" });
    merge.onYes();
    await Bun.sleep(0);
    expect(run.mock.calls.at(-1)?.[1]).toMatchObject({ action: "merge", keep: true });
    expect(dashboard.notice).toBe(WORKER_KEY + ": Nothing to merge: branch is current");
    dashboard.handleInput("x");
    expect(assertDialog(dashboard.dialog, "confirm").focusedButton).toBe("cancel");
    dashboard.closeDialog();
    expect(run).toHaveBeenCalledTimes(2);
    const before = dashboard.render(WIDTH).map(stripAnsi);
    dashboard.handleInput("x");
    const pending = Promise.withResolvers<{ output: string }>();
    run.mockReturnValueOnce(pending.promise);
    assertDialog(dashboard.dialog, "confirm").onYes();
    // The pending command is a yellow alert in the header row, after the
    // notice, and leaves every other row in place.
    const rows = dashboard.render(WIDTH);
    expect(rows[0]).toContain(`${YELLOW}retire ${WORKER_KEY}…`);
    expect(stripAnsi(rows[0]!)).toStartWith(`ib — ${WORKER_KEY}: Nothing to merge: branch is current  ·  retire ${WORKER_KEY}…`);
    expect(rows).toHaveLength(before.length);
    expect(rows.slice(1).map(stripAnsi)).toEqual(before.slice(1));
    pending.resolve({ output: "" });
    await Bun.sleep(0);
    expect(dashboard.notice).toContain("retired");
    run.mockRejectedValueOnce(new Error("Agent is already running"));
    dashboard.handleInput("R");
    await Bun.sleep(0);
    expect(dashboard.dialog).toBeNull();
    expect(run.mock.calls.at(-1)?.[1]).toMatchObject({ action: "resume" });
    expect(dashboard.notice).toContain("Agent is already running");
  });

  test("a remote merge whose push failed on the peer shows the failure in red", async () => {
    const { dashboard, service } = setup();
    selectByKey(dashboard, WORKER_KEY);
    const run = spyOn(service, "runRemoteLifecycle").mockResolvedValue({ output: "Ready to merge" });
    // git's whole error, as the peer sends it: later lines indented.
    const pushFailure = "origin: To /remotes/origin.git\n  ! [rejected] main -> main (fetch first)\n  hint: Updates were rejected";
    const report = `✗ ${pushFailure}\nWarning: merged, but the push of main failed. Run \`ib push itsybitsy\` on Laptop B to push it.`;
    const warnings = "Could not remove the agent directory";
    // The peer's replies (remote-lifecycle.ts): a closing merge's output is its
    // teardown warnings plus its merge report, with the warnings also apart.
    const cases = [
      { keep: false, reply: { output: `Closed agent: worker-abc\n${report}`, pushFailure } },
      { keep: false, reply: { output: `${warnings}\nClosed agent: worker-abc\n${report}`, pushFailure, warnings } },
      { keep: true, reply: { output: `Merged agent worker-abc into main (1 commit(s), agent kept running)\n${report}`, pushFailure } },
    ];
    for (const { keep, reply } of cases) {
      dashboard.handleInput("m");
      await Bun.sleep(0);
      const merge = assertDialog(dashboard.dialog, "confirm");
      merge.checkbox!.checked = keep;
      run.mockResolvedValueOnce(reply);
      merge.onYes();
      await Bun.sleep(0);
      expect(run.mock.calls.at(-1)?.[1]).toMatchObject({ action: "merge", keep });
      // The one-row notice drops git's `To <url>` and `hint:` lines.
      const notice = `${WORKER_KEY} merged · push failed: origin: ! [rejected] main -> main (fetch first)`;
      expect(dashboard.notice).toBe(notice);
      expect(dashboard.render(WIDTH)[0]).toContain(`${RED}${notice}`);
      // As for a local merge, teardown warnings open the cleanup-warnings dialog.
      if (reply.warnings) {
        expect(assertDialog(dashboard.dialog, "cleanup-warnings").text).toBe(`${notice}\n\n${warnings}`);
        dashboard.closeDialog();
      } else {
        expect(dashboard.dialog).toBeNull();
      }
    }
    // Without a push failure the same merge is an info notice, as before.
    dashboard.handleInput("m");
    await Bun.sleep(0);
    run.mockResolvedValueOnce({ output: "" });
    assertDialog(dashboard.dialog, "confirm").onYes();
    await Bun.sleep(0);
    expect(dashboard.notice).toBe(`${WORKER_KEY} merged`);
    expect(dashboard.render(WIDTH)[0]).toContain(`${YELLOW}${WORKER_KEY} merged`);
  });

  test("on the machine that ran a peer's merge, a failed push is a red notice too", () => {
    const { dashboard } = setup();
    const failed = "Laptop B merged worker in itsybitsy · push failed: origin: ! [rejected] main -> main (fetch first)";
    dashboard.remoteAgentStarted(failed, "error");
    expect(dashboard.render(WIDTH)[0]).toContain(`${RED}${failed}`);
    dashboard.remoteAgentStarted("Laptop B retired worker in itsybitsy");
    expect(dashboard.render(WIDTH)[0]).toContain(`${YELLOW}Laptop B retired worker in itsybitsy`);
  });

  test("o opens only a remote agent diff, requiring the tool, human caller and local registration", async () => {
    const { dashboard, service } = setup();
    selectByKey(dashboard, WORKER_KEY);
    dashboard.diffTool = undefined;
    dashboard.handleInput("o");
    expect(dashboard.notice).toContain("No diff tool configured");
    dashboard.diffTool = "diff-tool";
    service.remoteStartDenial = "Human caller required";
    dashboard.handleInput("o");
    expect(dashboard.notice).toBe("Human caller required");
    service.remoteStartDenial = null;
    dashboard.handleInput("o");
    expect(dashboard.notice).toBe("Open diff needs itsybitsy on this machine");
    expect(service.fetchAgentDiff).not.toHaveBeenCalled();
    dashboard.repos = [{ name: "ITSYBITSY", path: "/local/app" }];
    dashboard.handleInput("o");
    await waitFor(() => dashboard.notice === "No changes to show — diff is empty");
    expect(service.fetchAgentDiff.mock.calls).toEqual([[PEER_B, "itsybitsy", "worker-abc"]]);
    selectByKey(dashboard, repoKey("other-repo"));
    expect(dashboard.refuseOnRemoteRow("o")).toBe(true);
  });

  test("remote o passes the merge base to the tool and retains its fresh checkout after the launcher exits", async () => {
    const { dashboard, service } = setup();
    selectByKey(dashboard, WORKER_KEY);
    const root = await mkdtemp(join(tmpdir(), "remote-tool-"));
    const staging = join(root, "staging");
    const stage = spyOn(runtimeNames, "transferStagingRoot").mockReturnValue(staging);
    try {
      const repo = join(root, "local");
      await mkdir(repo);
      await Bun.$`git init -qb main`.cwd(repo).quiet();
      await Bun.write(join(repo, "tracked"), "before\n");
      await Bun.$`git add tracked`.cwd(repo).quiet();
      await Bun.$`git -c user.name=test -c user.email=test@example.org commit -qm base`.cwd(repo).quiet();
      const base = (await Bun.$`git rev-parse HEAD`.cwd(repo).text()).trim();
      await Bun.write(join(repo, "tracked"), "after\n");
      const patch = (await Bun.$`git diff --binary HEAD`.cwd(repo).quiet()).stdout;
      await Bun.$`git restore tracked`.cwd(repo).quiet();
      service.fetchAgentDiff.mockResolvedValue({ base, patch });
      dashboard.repos = [{ name: "itsybitsy", path: repo }];
      const tool = join(root, "tool");
      await writeFile(tool, '#!/bin/bash\nprintf "%s\\n" "$1" > ../launched\n', { mode: 0o700 });
      dashboard.diffTool = tool;
      dashboard.handleInput("o");
      await waitFor(() => dashboard.notice === `Opened diff vs merge-base with main in ${tool}` && !agentActions.getDiffToolLaunching());
      const [name] = await readdir(join(staging, "diffs"));
      const dir = join(staging, "diffs", name!);
      await waitFor(() => agentActions.getActiveDiffProc() === null);
      await sweepDiffCopies(staging);
      expect((await Bun.file(join(dir, "launched")).text()).trim()).toBe(base);
      expect(await Bun.file(join(dir, "repo/tracked")).text()).toBe("after\n");
      expect(await Bun.file(join(repo, "tracked")).text()).toBe("before\n");
    } finally {
      const active = agentActions.getActiveDiffProc();
      agentActions.killActiveDiffProc();
      await active?.proc.exited;
      stage.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the guard refuses action keys on a remote row with the notice, and none of their handlers run", () => {
    const { dashboard } = setup();
    selectByKey(dashboard, WORKER_KEY);
    const favorites = [...dashboard.agentTree.favoriteAgentIds];
    const handlers = Object.keys(agentActions)
      .filter((name) => typeof (agentActions as Record<string, unknown>)[name] === "function")
      .map((name) => spyOn(agentActions as Record<string, any>, name).mockImplementation(() => undefined));
    try {
      for (const key of ["c", "t", "!", "S", "O", "b"]) {
        resetNotice(dashboard);
        dashboard.handleInput(key);
        expect(dashboard.notice).toBe(REMOTE_READ_ONLY_NOTICE);
        expect(dashboard.dialog).toBeNull();
      }
      for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
      expect([...dashboard.agentTree.favoriteAgentIds]).toEqual(favorites);
      expect(keyOf(dashboard)).toBe(WORKER_KEY);
    } finally {
      for (const handler of handlers) handler.mockRestore();
    }
  });

  test.each([0, 1, 2])("new-agent form with %i connected matching peers", count => {
    const dashboard = makeDashboard();
    dashboard.setRepos([{ path: "/local/project", name: "App", nickname: "Project" }]);
    const service = new FakePeerService();
    const linked = links().map((link, index) => ({ ...link, repos: repos("aPP"), connected: index < count }));
    service.set({ links: [...linked, { ...linked[0]!, id: "other", connected: true, repos: repos("Project") }] });
    dashboard.setPeerService(service);
    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    const text = () => stripAnsi(buildNewAgentFormContent(form, 70).contentLines.join("\n"));
    expect(form.machine).toEqual({ id: null, name: "This machine" });
    expect(text().includes("Machine:")).toBe(count > 0);
    expect(text()).not.toContain("Attachments");
    expect(form.machines().map(m => m.id)).toEqual([null, ...linked.slice(0, count).map(l => l.id)]);
    dashboard.handleInput("\t");
    expect(form.focused).toBe(count ? "machine" : "agentType");
    if (!count) return;
    const types = [...form.availableTypes];
    dashboard.handleInput(" ");
    expect(form.machine?.id).toBe(PEER_B);
    expect(text()).not.toContain("Attachments");
    expect(form.availableTypes).toEqual(types);
    dashboard.handleInput("\x1b[D");
    expect(form.machine?.id).toBeNull();
    dashboard.handleInput("\x1b[D");
    expect(form.machine?.id).toBe(count === 1 ? PEER_B : PEER_C);
    dashboard.handleInput("\r");
    expect(form.machine?.id).toBeNull();
  });

  test("a on a remote-only header starts on its first connected peer, preserves the draft on failure and submits once", async () => {
    const { dashboard, service } = setup();
    const [b, c] = links();
    service.set({ links: [{ ...b!, connected: false }, { ...c!, repos: repos("itsybitsy"), connected: true }] });
    selectByKey(dashboard, repoKey("itsybitsy"));
    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    expect(form.machine).toEqual({ id: PEER_C, name: "Laptop C" });
    expect(form.machines().map(m => m.id)).toEqual([PEER_C]);
    form.name = "builder";
    form.agentType = "worker";
    // A missing path stays in the prompt and opens no path dialog.
    const prompt = "Inspect /no/such/dir/report.txt";
    form.buffer.handleInput("\x1b[200~" + prompt + "\x1b[201~");
    form.focused = "create";
    const start = spyOn(service, "startRemoteAgent").mockRejectedValueOnce(new Error("Type unavailable"));
    dashboard.handleInput("\r");
    await waitFor(() => form.error === "Remote start on Laptop C: Type unavailable");
    expect(dashboard.dialog).toBe(form);
    expect(buildNewAgentFormContent(form, 70).contentLines.join(" ")).toContain("Type unavailable");
    expect(form.buffer.getText()).toBe(prompt);
    const longId = "builder-" + "w".repeat(240);
    start.mockResolvedValue(longId);
    dashboard.handleInput("\r");
    dashboard.handleInput("\r");
    await waitFor(() => dashboard.dialog === null);
    expect(start.mock.calls).toEqual(Array(2).fill([PEER_C, { repo: "itsybitsy", type: "worker", name: "builder", prompt }, { signal: expect.any(AbortSignal) }]));
    expect(dashboard.notice).toBe(`Created agent ${longId.slice(0, 79)}… on Laptop C`);
  });

  /** The New Agent form on the remote-only `itsybitsy` header, whose first machine is Laptop B, with `prompt` typed. */
  function remoteStartForm(prompt: string) {
    const { dashboard, service } = setup();
    selectByKey(dashboard, repoKey("itsybitsy"));
    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    expect(form.machine).toEqual({ id: PEER_B, name: "Laptop B" });
    form.agentType = "worker";
    form.buffer.handleInput("\x1b[200~" + prompt + "\x1b[201~");
    form.focused = "create";
    return { dashboard, service, form };
  }

  test("a peer start asks which paths to attach and sends the checked ones as files", async () => {
    const home = await mkdtemp(join(tmpdir(), "ib-dashboard-start-pick-"));
    setUserHome(home);
    const { processStartEpochSecondsCtx } = await import("../agents");
    const stagingRoot = spyOn(runtimeNames, "transferStagingRoot").mockReturnValue(join(home, "staging"));
    processStartEpochSecondsCtx.set(() => 123);
    try {
      await Bun.write(join(home, ".itsybitsy/machine-name"), "sender");
      const picked = join(home, "picked.txt");
      const left = join(home, "left.txt");
      await Bun.write(picked, "picked");
      await Bun.write(left, "left");
      const prompt = `Compare ${picked} with ${left}`;
      const { dashboard, service, form } = remoteStartForm(prompt);
      const result = Promise.withResolvers<string>();
      let copied: string | undefined;
      const start = spyOn(service, "startRemoteAgent").mockImplementation(async (_peer, _request, transfer) => {
        copied = await Bun.file(join(transfer!.filesDir!, "0")).text();
        return result.promise;
      });
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog?.type === "multi-select", { message: "the path dialog" });
      const picker = assertDialog(dashboard.dialog, "multi-select");
      expect(picker.prompt).toBe("Send as attachments to Laptop B:");
      expect(picker.items).toEqual([picked, left]);
      expect(picker.checked).toEqual([false, false]);
      // The start holds the pending slot while the path dialog is open.
      expect(dashboard.remoteStartPending).toBe(true);
      for (const key of [" ", "\r"]) dashboard.handleInput(key);
      // The frozen form is back while the start is in flight.
      expect(dashboard.dialog).toBe(form);
      await waitFor(() => start.mock.calls.length === 1);
      expect(form.inFlight).toBe("Laptop B");
      const [peer, request, transfer] = start.mock.calls[0]!;
      expect(peer).toBe(PEER_B);
      expect(request).toMatchObject({ repo: "itsybitsy", type: "worker", prompt });
      expect(request.files).toHaveLength(1);
      expect(request.files![0]!.spellings).toContain(picked);
      expect(request.files![0]!.spellings).not.toContain(left);
      await waitFor(() => copied !== undefined);
      expect(copied).toBe("picked");
      result.resolve("builder");
      await waitFor(() => dashboard.dialog === null);
      expect(dashboard.notice).toBe("Created agent builder on Laptop B");
      await waitFor(() => !dashboard.remoteStartPending);
      expect(await Bun.file(join(transfer!.filesDir!, "0")).exists()).toBe(false);
    } finally { stagingRoot.mockRestore(); processStartEpochSecondsCtx.reset(); resetUserHome(); await rm(home, { recursive: true, force: true }); }
  });

  test("cancelling the path dialog keeps the form and its draft, and unchecked paths stay in the prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-dashboard-start-cancel-"));
    try {
      const file = join(dir, "notes.txt");
      await Bun.write(file, "notes");
      const prompt = `Read ${file}`;
      const { dashboard, service, form } = remoteStartForm(prompt);
      const start = spyOn(service, "startRemoteAgent").mockResolvedValue("builder");
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog?.type === "multi-select");
      dashboard.handleInput("\x1b");
      expect(dashboard.dialog).toBe(form);
      await waitFor(() => !dashboard.remoteStartPending);
      expect(dashboard.notice).toBe("New agent cancelled");
      expect(form.inFlight).toBeUndefined();
      expect(form.buffer.getText()).toBe(prompt);
      expect(start).not.toHaveBeenCalled();

      // The kept draft submits again; with the path unchecked it stays raw text and no file is sent.
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog?.type === "multi-select");
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog === null);
      expect(start.mock.calls).toEqual([[PEER_B, { repo: "itsybitsy", type: "worker", prompt }, { signal: expect.any(AbortSignal) }]]);
      expect(dashboard.notice).toBe("Created agent builder on Laptop B");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("Esc on the form restored after the path dialog dismisses it, and the start's failure is a notice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-dashboard-start-detach-"));
    try {
      const file = join(dir, "notes.txt");
      await Bun.write(file, "notes");
      const { dashboard, service, form } = remoteStartForm(`Read ${file}`);
      const result = Promise.withResolvers<string>();
      const start = spyOn(service, "startRemoteAgent").mockReturnValue(result.promise);
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog?.type === "multi-select");
      dashboard.handleInput("\r");
      expect(dashboard.dialog).toBe(form);
      await waitFor(() => start.mock.calls.length === 1);
      dashboard.handleInput("\x1b");
      expect(dashboard.dialog).toBeNull();
      expect(dashboard.remoteStartPending).toBe(true);
      result.reject(new Error("spawn failed"));
      await waitFor(() => !dashboard.remoteStartPending);
      expect(dashboard.notice).toBe("Remote start on Laptop B: spawn failed");
      expect(dashboard.dialog).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("a prompt with no attachable paths starts with the JSON request and no path dialog", async () => {
    const prompt = "Inspect /no/such/dir/report.txt and ./relative.txt";
    const { dashboard, service } = remoteStartForm(prompt);
    const shown = spyOn(dashboard, "showDialog");
    const start = spyOn(service, "startRemoteAgent").mockResolvedValue("builder");
    dashboard.handleInput("\r");
    await waitFor(() => dashboard.dialog === null);
    expect(shown).not.toHaveBeenCalled();
    expect(start.mock.calls).toEqual([[PEER_B, { repo: "itsybitsy", type: "worker", prompt }, { signal: expect.any(AbortSignal) }]]);
    expect(start.mock.calls[0]![1].files).toBeUndefined();
  });

  test("a relative path in this machine's checkout of the repo starts unchecked", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "ib-dashboard-start-local-"));
    try {
      await Bun.write(join(checkout, "src/app.ts"), "app");
      const dashboard = makeDashboard();
      dashboard.setRepos([{ name: "itsybitsy", path: checkout }]);
      const service = new FakePeerService();
      service.set({ links: [links()[0]!] });
      dashboard.setPeerService(service);
      dashboard.handleInput("a");
      const form = assertDialog(dashboard.dialog, "new-agent-form");
      form.machine = form.machines().find(machine => machine.id === PEER_B)!;
      form.agentType = "worker";
      form.buffer.handleInput("\x1b[200~Review ./src/app.ts\x1b[201~");
      form.focused = "create";
      const start = spyOn(service, "startRemoteAgent").mockResolvedValue("builder");
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog?.type === "multi-select");
      const picker = assertDialog(dashboard.dialog, "multi-select");
      expect(picker.items).toEqual(["./src/app.ts"]);
      expect(picker.checked).toEqual([false]);
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog === null);
      expect(start.mock.calls[0]![1]).toEqual({ repo: "itsybitsy", type: "worker", prompt: "Review ./src/app.ts" });
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });

  test("dashboard shutdown aborts a pending remote start", async () => {
    const { dashboard, service } = remoteStartForm("hello");
    spyOn(service, "startRemoteAgent").mockImplementation((_peer, _request, transfer) =>
      new Promise((_, reject) => transfer!.signal!.addEventListener("abort", () => reject(transfer!.signal!.reason))));
    dashboard.handleInput("\r");
    await waitFor(() => dashboard.remoteStart !== null);
    await dashboard.stopRemoteSends();
    expect(dashboard.remoteStartPending).toBe(false);
    expect(dashboard.remoteStart).toBeNull();
  });

  test("dashboard shutdown while the start's path dialog is open settles at once and closes the dialog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-dashboard-start-quit-dialog-"));
    try {
      const file = join(dir, "notes.txt");
      await Bun.write(file, "notes");
      const { dashboard, service, form } = remoteStartForm(`Read ${file}`);
      const start = spyOn(service, "startRemoteAgent");
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog?.type === "multi-select");
      await dashboard.stopRemoteSends();
      expect(dashboard.remoteStartPending).toBe(false);
      expect(dashboard.remoteStart).toBeNull();
      expect(dashboard.dialog).toBe(form);
      expect(start).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  /** A home whose staging root is under it, as in the dashboard send tests that stage files. */
  async function withStagingHome(use: (home: string) => Promise<void>) {
    const home = await mkdtemp(join(tmpdir(), "ib-dashboard-start-stage-"));
    setUserHome(home);
    const { processStartEpochSecondsCtx } = await import("../agents");
    const stagingRoot = spyOn(runtimeNames, "transferStagingRoot").mockReturnValue(join(home, "staging"));
    processStartEpochSecondsCtx.set(() => 123);
    try {
      await Bun.write(join(home, ".itsybitsy/machine-name"), "sender");
      await use(home);
    } finally { stagingRoot.mockRestore(); processStartEpochSecondsCtx.reset(); resetUserHome(); await rm(home, { recursive: true, force: true }); }
  }

  test.each(["shutdown", "failure"])("a start with staged files removes its staging directory on %s", async outcome => {
    await withStagingHome(async home => {
      const file = join(home, "notes.txt");
      await Bun.write(file, "notes");
      const { dashboard, service, form } = remoteStartForm(`Read ${file}`);
      let filesDir: string | undefined;
      let staged: string | undefined;
      spyOn(service, "startRemoteAgent").mockImplementation(async (_peer, _request, transfer) => {
        staged = await Bun.file(join(transfer!.filesDir!, "0")).text();
        filesDir = transfer!.filesDir;
        if (outcome === "failure") throw new Error("spawn failed");
        return new Promise((_, reject) => transfer!.signal!.addEventListener("abort", () => reject(transfer!.signal!.reason)));
      });
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog?.type === "multi-select");
      dashboard.handleInput(" ");
      dashboard.handleInput("\r");
      await waitFor(() => filesDir !== undefined, { message: "the start with its staged files" });
      expect(staged).toBe("notes");
      if (outcome === "shutdown") await dashboard.stopRemoteSends();
      await waitFor(() => !dashboard.remoteStartPending);
      expect(await Bun.file(join(filesDir!, "0")).exists()).toBe(false);
      expect(await Array.fromAsync(new Bun.Glob("staging/outgoing/*").scan({ cwd: home, onlyFiles: false }))).toEqual([]);
      expect(dashboard.dialog).toBe(form);
      expect(form.error).toEqual(outcome === "failure" ? "Remote start on Laptop B: spawn failed" : expect.stringContaining("Remote start on Laptop B"));
    });
  });

  test.each(["failure first", "peer update first"])("renders both the original peer failure and the new machine (%s)", async order => {
    const { dashboard, service } = setup();
    const [b, c] = links();
    const replacement = { ...c!, repos: repos("itsybitsy"), connected: true };
    service.set({ links: [b!, replacement] });
    selectByKey(dashboard, repoKey("itsybitsy"));
    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    const pending = Promise.withResolvers<string>();
    spyOn(service, "startRemoteAgent").mockReturnValue(pending.promise);
    form.onSubmit("", "worker", "hello");
    if (order === "peer update first") service.set({ links: [replacement] });
    pending.reject(new Error("Type unavailable"));
    await waitFor(() => !dashboard.remoteStartPending);
    if (order === "failure first") service.set({ links: [replacement] });
    form.focused = "agentType";
    dashboard.handleInput(" ");
    const rendered = buildNewAgentFormContent(form, 80).contentLines.map(stripAnsi);
    expect(rendered).toContain("Remote start on Laptop B: Type unavailable");
    expect(rendered).toContain("Machine changed to Laptop C. Review before creating the agent.");
  });

  test("the pending remote start status fits the 66-column form", async () => {
    const { dashboard, service } = setup();
    const name = "界".repeat(16);
    service.set({ links: [{ ...links()[0]!, name }] });
    selectByKey(dashboard, repoKey("itsybitsy"));
    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    const pending = Promise.withResolvers<string>();
    spyOn(service, "startRemoteAgent").mockReturnValue(pending.promise);
    const submitted = form.onSubmit("", "worker", "hello");
    const lines = buildNewAgentFormContent(form, 66).contentLines;
    expect(lines.map(stripAnsi).join(" ")).toContain(`Starting agent on ${name}… (Esc to dismiss)`);
    expect(Math.max(...lines.map(visibleWidth))).toBeLessThanOrEqual(66);
    pending.resolve("worker");
    await submitted;
  });

  test.each(["success", "failure"])("a detached %s is reported without replacing the next dialog", async outcome => {
    const { dashboard, service } = setup();
    selectByKey(dashboard, repoKey("itsybitsy"));
    dashboard.handleInput("a");
    const first = assertDialog(dashboard.dialog, "new-agent-form");
    const pending = Promise.withResolvers<string>();
    const start = spyOn(service, "startRemoteAgent").mockReturnValue(pending.promise);
    first.onSubmit("builder", "worker", "hello");
    dashboard.handleInput("\x1b");
    expect(dashboard.dialog).toBeNull();
    dashboard.handleInput("a");
    const second = assertDialog(dashboard.dialog, "new-agent-form");
    second.onSubmit("", "worker", "another draft");
    const rendered = () => buildNewAgentFormContent(second, 70).contentLines.map(stripAnsi).join(" ");
    expect(rendered()).toContain("already pending");
    await waitFor(() => start.mock.calls.length === 1);
    await Bun.sleep(0);
    expect(start).toHaveBeenCalledTimes(1);
    if (outcome === "success") pending.resolve("builder");
    else pending.reject(new Error("spawn failed"));
    await waitFor(() => !dashboard.remoteStartPending);
    expect(dashboard.dialog).toBe(second);
    expect(dashboard.notice).toBe(outcome === "success" ? "Created agent builder on Laptop B" : "Remote start on Laptop B: spawn failed");
    expect(rendered()).not.toContain("already pending");
    start.mockResolvedValueOnce("second-agent");
    second.buffer.handleInput("x");
    second.focused = "create";
    dashboard.handleInput("\r");
    await waitFor(() => dashboard.dialog === null);
    expect(start).toHaveBeenCalledTimes(2);
    expect(dashboard.notice).toBe("Created agent second-agent on Laptop B");
  });

  test("an open remote form shows the startup check and enables Create when the decision allows it", async () => {
    const { dashboard, service } = setup();
    service.remoteStartDenial = "checking whether remote starts are allowed";
    selectByKey(dashboard, repoKey("itsybitsy"));
    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    form.buffer.handleInput("x");
    const rendered = () => buildNewAgentFormContent(form, 70).contentLines.map(stripAnsi).join(" ");
    const start = spyOn(service, "startRemoteAgent").mockResolvedValue("builder");
    expect(rendered()).toContain("checking whether remote starts are allowed");
    await form.onSubmit("", "worker", "x");
    expect(start).not.toHaveBeenCalled();
    service.remoteStartDenial = null;
    service.set({});
    expect(rendered()).not.toContain("checking whether remote starts are allowed");
    form.focused = "create";
    dashboard.handleInput("\r");
    await waitFor(() => dashboard.dialog === null);
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("a denied remote-start decision is displayed and prevents form submission", () => {
    const { dashboard, service } = setup();
    service.remoteStartDenial = "Remote starts require an interactive terminal";
    selectByKey(dashboard, repoKey("itsybitsy"));
    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    form.buffer.handleInput("x");
    expect(buildNewAgentFormContent(form, 70).contentLines.join(" ")).toContain(service.remoteStartDenial);
    const start = spyOn(service, "startRemoteAgent");
    form.focused = "create";
    dashboard.handleInput("\r");
    form.onSubmit("", "worker", "x");
    expect(start).not.toHaveBeenCalled();
  });

  test("losing the selected peer on a shared repo makes the local replacement visible", () => {
    const dashboard = makeDashboard();
    dashboard.setRepos([{ name: "itsybitsy", path: "/local/project" }]);
    const service = new FakePeerService();
    dashboard.setPeerService(service);
    service.set({ links: links() });
    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    dashboard.handleInput("\t");
    dashboard.handleInput(" ");
    expect(form.machine?.id).toBe(PEER_B);
    form.focused = "create";
    service.set({ links: [] });
    expect(form.machine).toEqual({ id: null, name: "This machine" });
    const text = buildNewAgentFormContent(form, 70).contentLines.join(" ");
    expect(text).toContain("Machine changed to This machine");
    expect(assertDialog(dashboard.dialog, "new-agent-form").focused).toBe("agentType");
  });

  test("an incoming successful start requests a watcher refresh without waiting for the scan", () => {
    const dashboard = makeDashboard();
    const scan = Promise.withResolvers<void>();
    const refresh = mock(() => scan.promise);
    dashboard.watcher = { refresh } as unknown as NonNullable<DashboardComponent["watcher"]>;
    expect(dashboard.remoteAgentStarted("Laptop B started agent builder in app")).toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(dashboard.notice).toBe("Laptop B started agent builder in app");
    scan.resolve();
  });

  test("peer updates keep the open draft, reconcile by id, and disable Create when its last host vanishes", () => {
    const { dashboard, service } = setup();
    const [b, c] = links();
    const second = { ...c!, connected: true, repos: repos("itsybitsy") };
    service.set({ links: [b!, second] });
    selectByKey(dashboard, repoKey("itsybitsy"));
    dashboard.handleInput("a");
    const form = assertDialog(dashboard.dialog, "new-agent-form");
    form.buffer.handleInput("x");
    service.set({ links: [second, { ...b!, name: "Renamed" }] });
    expect(form.machine).toEqual({ id: PEER_B, name: "Renamed" });
    form.focused = "create";
    service.set({ links: [second, { ...b!, connected: false }] });
    expect(form.machine?.id).toBe(PEER_C);
    expect(assertDialog(dashboard.dialog, "new-agent-form").focused).toBe("machine");
    expect(buildNewAgentFormContent(form, 70).contentLines.join(" ")).toContain("Machine changed to Laptop C");
    service.set({ links: [{ ...second, repos: [] }] });
    expect(form.machine).toBeNull();
    expect(form.buffer.getText()).toBe("x");
    expect(buildNewAgentFormContent(form, 70).contentLines.join(" ")).toContain("No connected machine");
    const start = spyOn(service, "startRemoteAgent");
    form.focused = "cancel";
    dashboard.handleInput("\t");
    expect(assertDialog(dashboard.dialog, "new-agent-form").focused).toBe("name"); // disabled Create is skipped
    form.onSubmit("", "worker", "x");
    expect(start).not.toHaveBeenCalled();
    service.set({ links: [b!] });
    expect(form.machine?.id).toBe(PEER_B);
    expect(assertDialog(dashboard.dialog, "new-agent-form").focused).toBe("machine");
    // A change unseen by the listener must still be reconciled before submission.
    service.state.links = [second];
    form.onSubmit("", "worker", "x");
    expect(start).not.toHaveBeenCalled();
    expect(form.machine?.id).toBe(PEER_C);
    expect(form.buffer.getText()).toBe("x");
  });

  test("a on a disconnected remote-only header identifies the unavailable repo", () => {
    const { dashboard } = setup();
    selectByKey(dashboard, repoKey("app"));
    dashboard.handleInput("a");
    expect(dashboard.dialog).toBeNull();
    expect(dashboard.notice).toBe("No connected machine has app");
  });

  test("c reaches Clone here only on a remote-only header; with no remote URL it shows a notice and opens nothing", () => {
    const { dashboard, local } = setup();
    const clone = spyOn(agentActions, "handleCloneHere");
    try {
      // A remote agent row: refused by the guard.
      selectByKey(dashboard, WORKER_KEY);
      resetNotice(dashboard);
      dashboard.handleInput("c");
      expect(dashboard.notice).toBe(REMOTE_READ_ONLY_NOTICE);
      expect(clone).not.toHaveBeenCalled();

      // A remote-only header whose peer reports no remote.
      selectByKey(dashboard, repoKey("other-repo"));
      resetNotice(dashboard);
      dashboard.handleInput("c");
      expect(clone).toHaveBeenCalledTimes(1);
      expect(dashboard.dialog).toBeNull();
      expect(dashboard.notice).toBe("Laptop B reports no remote for other-repo");

      // A local row: c is the ERRORS-mode "clear errors" key, as before.
      for (let i = 0; i < 20 && dashboard.selectedAgent !== local; i++) dashboard.handleInput("k");
      expect(dashboard.selectedAgent).toBe(local);
      dashboard.handleInput("c");
      expect(clone).toHaveBeenCalledTimes(1);
    } finally {
      clone.mockRestore();
    }
  });

  test("c on a header whose peer repo name is not a valid repo name shows a notice and opens no dialog", async () => {
    const { dashboard, service } = setup();
    service.set({ links: links().map((link) => link.id === PEER_B
      ? { ...link, repos: [{ registryName: "bad.name", displayName: "bad", remoteUrl: "git@github.com:o/r.git", relPath: null }, ...repos("other-repo")] }
      : link) });
    selectByKey(dashboard, repoKey("bad.name"));
    resetNotice(dashboard);
    await agentActions.handleCloneHere(dashboard);
    expect(dashboard.dialog).toBeNull();
    expect(dashboard.notice).toBe("Will not clone: Laptop B reports a repo name that is not valid here");
  });

  test("c on a header whose remote URL the grammar refuses shows the refusal and opens no dialog", async () => {
    const { dashboard, service } = setup();
    const clone = spyOn(cloneRepoModule, "cloneRepo");
    try {
      for (const remoteUrl of ["file:///tmp/evil", "ext::sh -c id", "ssh://-oProxyCommand=x@host/repo"]) {
        service.set({ links: links().map((link) => link.id === PEER_B
          ? { ...link, repos: [{ registryName: "itsybitsy", displayName: "itsybitsy", remoteUrl, relPath: null }, ...repos("other-repo")] }
          : link) });
        selectByKey(dashboard, repoKey("itsybitsy"));
        resetNotice(dashboard);
        await agentActions.handleCloneHere(dashboard);
        expect(dashboard.dialog).toBeNull();
        // The notice names the rule the URL breaks (clone-repo.test.ts covers each rule's text).
        const checked = cloneRepoModule.checkCloneUrl(remoteUrl);
        expect("refusal" in checked && dashboard.notice === checked.refusal).toBe(true);
      }
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  // clonePrompt allocates columns: the floor is `Clone <name cut to 4> from
  // <host left-cut to 24> (<owner>…) into:`; spare columns go to the host, the
  // name, the rest of the path, then " via <peer>". `title(cols, …)` is the
  // title for a dialog that many columns wide.
  const title = (cols: number, name: string, path: string, host: string, peer = "Laptop B") =>
    clonePrompt(name, path, host, peer, dialogTitleMaxWidth(cols));
  const NAME = "muse-ios-shared-utils";
  const ORIGINAL = "museapphq/muse-ios-shared-utils.git";
  const FORK = "someoneelse/muse-ios-shared-utils.git";

  test("the Clone here title: everything fits, then the spare columns go to the host, the name, the path, the peer", () => {
    expect(title(80, "foo", "o/foo.git", "github.com", "Desk")).toBe("Clone foo from github.com (o/foo.git) via Desk into:");
    expect(title(80, "itsybitsy", "owner/itsybitsy.git", "github.com")).toBe("Clone itsybitsy from github.com (owner/itsybitsy.git) via Laptop B into:");
    // Not enough for the peer: the path takes the rest.
    expect(title(80, NAME, ORIGINAL, "github.com")).toBe("Clone muse-ios-shared-utils from github.com (museapphq/muse-ios-sha…) into:");
    // The name grows before the path: only the owner shows.
    expect(title(64, NAME, ORIGINAL, "github.com")).toBe("Clone muse-ios-shared-u… from github.com (museapphq…) into:");
    // The host grows first, from its left-cut toward the whole host...
    expect(title(66, NAME, ORIGINAL, "gitlab.internal.example.com")).toBe("Clone mus… from …tlab.internal.example.com (museapphq…) into:");
    // ...and once it is whole, the name gets the rest.
    expect(title(68, NAME, ORIGINAL, "gitlab.internal.example.com")).toBe("Clone muse… from gitlab.internal.example.com (museapphq…) into:");
    // A long owner beside a long host: the host is left-cut, the owner kept.
    expect(title(80, "app", "averylongownername/repo.git", "hhhhhhhhhhhhhhhhhhhhhhhhhhhh.example.com"))
      .toBe("Clone app from …hhhhhhhhhhhhhhhhhhh.example.com (averylongownername…) into:");
    // A 64-character name takes what the floor leaves.
    expect(title(80, "n".repeat(64), "o/r.git", "github.com")).toBe(`Clone ${"n".repeat(41)}… from github.com (o…) into:`);
  });

  test.each([
    // github.com, at 60 and 80 columns.
    [60, "github.com", "Clone muse-ios-shar… from github.com (museapphq…) into:", "Clone muse-ios-sh… from github.com (someoneelse…) into:"],
    [80, "github.com", "Clone muse-ios-shared-utils from github.com (museapphq/muse-ios-sha…) into:",
      "Clone muse-ios-shared-utils from github.com (someoneelse/muse-ios-s…) into:"],
    // A 27-character self-hosted GitLab host, at 64 to 68 columns.
    [64, "gitlab.internal.example.com", "Clone mus… from …ab.internal.example.com (museapphq…) into:",
      "Clone muse-ios-shar… from gitlab.internal.example.com into:"],
    [66, "gitlab.internal.example.com", "Clone mus… from …tlab.internal.example.com (museapphq…) into:",
      "Clone mus… from …ab.internal.example.com (someoneelse…) into:"],
    [68, "gitlab.internal.example.com", "Clone muse… from gitlab.internal.example.com (museapphq…) into:",
      "Clone mus… from …tlab.internal.example.com (someoneelse…) into:"],
    // A 29-character one.
    [64, "git.internal.company-name.com", "Clone mus… from …ternal.company-name.com (museapphq…) into:",
      "Clone muse-ios-sh… from git.internal.company-name.com into:"],
    [66, "git.internal.company-name.com", "Clone mus… from …internal.company-name.com (museapphq…) into:",
      "Clone mus… from …ternal.company-name.com (someoneelse…) into:"],
    [68, "git.internal.company-name.com", "Clone mus… from …t.internal.company-name.com (museapphq…) into:",
      "Clone mus… from …internal.company-name.com (someoneelse…) into:"],
  ] as const)("at %i columns on %s, the original and a fork with another owner get different titles", (cols, host, original, fork) => {
    expect(title(cols, NAME, ORIGINAL, host)).toBe(original);
    expect(title(cols, NAME, FORK, host)).toBe(fork);
  });

  test("the Clone here title measures wide characters by their columns, not their length", () => {
    // A CJK owner: 3 characters but 6 columns, so the floor is 41 columns wide.
    expect(clonePrompt("app", "日本語/app.git", "github.com", "Laptop B", 41)).toBe("Clone app from github.com (日本語…) into:");
    expect(clonePrompt("app", "日本語/app.git", "github.com", "Laptop B", 42)).toBe("Clone app from github.com (日本語/…) into:");
    // One column short of the floor: the owner is left out, not cut to "日…".
    expect(clonePrompt("app", "日本語/app.git", "github.com", "Laptop B", 40)).toBe("Clone app from github.com into:");
    // A CJK peer: " via 東京のMac" is 11 characters but 14 columns.
    for (const max of [55, 56]) {
      expect(clonePrompt("foo", "o/foo.git", "github.com", "東京のMac", max)).toBe("Clone foo from github.com (o/foo.git) into:");
    }
    const withPeer = clonePrompt("foo", "o/foo.git", "github.com", "東京のMac", 57);
    expect(withPeer).toBe("Clone foo from github.com (o/foo.git) via 東京のMac into:");
    expect(visibleWidth(withPeer)).toBe(57);
  });

  test.each([
    // No room for the owner: the host takes what is beside the 3-character name, and keeps its end.
    [45, "Clone app from …l.company-name.com into:"],
    [43, "Clone app from …company-name.com into:"],
    [41, "Clone app from …mpany-name.com into:"],
  ] as const)("at %i columns the host's end survives: %s", (cols, expected) => {
    expect(title(cols, "app", "team/app.git", "git.internal.company-name.com")).toBe(expected);
  });

  test("across widths and hosts: never wider than max; the owner shows whenever the floor fits; forks differ; the host keeps its end", () => {
    const longHost = `${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(20)}.evil.example`;
    const hosts = ["github.com", "gitlab.example.com", "gitlab.internal.example.com", "git.internal.company-name.com", longHost];
    const names = ["app", "itsybitsy", NAME, "n".repeat(64)];
    const pairs = [[ORIGINAL, FORK], ["team/app.git", "teamx/app.git"], ["o/r.git", "averylongownername/r.git"],
      // Wide owners: their columns, not their length, decide the floor.
      ["日本語/app.git", "中文组织/app.git"]] as const;
    const ownerOf = (path: string) => path.split("/")[0]!;
    // The floor, as clonePrompt's doc defines it, in columns.
    const floorFits = (max: number, name: string, path: string, host: string) =>
      21 + Math.min(name.length, 4) + Math.min(host.length, 24) + Math.min(visibleWidth(path), visibleWidth(ownerOf(path)) + 1) <= max;
    for (let cols = 10; cols <= 100; cols++) {
      const max = dialogTitleMaxWidth(cols);
      for (const host of hosts) for (const name of names) for (const [original, fork] of pairs) {
        const shown = [original, fork].map((path) => clonePrompt(name, path, host, "Laptop B", max));
        for (const [i, path] of [original, fork].entries()) {
          const text = shown[i]!;
          expect(visibleWidth(text)).toBeLessThanOrEqual(max);
          expect(text).not.toContain("\x1b");
          if (floorFits(max, name, path, host)) expect(text).toContain(` (${ownerOf(path)}`);
          // Unless it is cut at its end, the title keeps the host's last character.
          if (max >= 18 + Math.min(name.length, 4) + 2) expect(text).toMatch(new RegExp(`${host.at(-1)} (\\(|via |into:)`));
        }
        if (floorFits(max, name, original, host) || floorFits(max, name, fork, host)) expect(shown[0]).not.toBe(shown[1]);
      }
    }
  });

  test("the Clone here title is built at each render, so a terminal that shrinks after open keeps the host whole", async () => {
    const { dashboard, service } = setup();
    service.set({ links: links().map((link) => link.id === PEER_B
      ? { ...link, repos: [{ registryName: "itsybitsy", displayName: "itsybitsy", remoteUrl: "git@github.com:museapphq/muse-ios-shared-utils.git", relPath: null }, ...repos("other-repo")] }
      : link) });
    selectByKey(dashboard, repoKey("itsybitsy"));
    await agentActions.handleCloneHere(dashboard);
    const titleRow = (width: number) => stripAnsi(((dashboard as any).dialogOverlay.render(width) as string[])[0]!);
    // Opened at the dialog's 80 columns...
    expect(titleRow(80)).toContain(" Clone itsybitsy from github.com (museapphq/muse-ios-shared-utils.git) into: ");
    // ...then drawn at 50: the title is rebuilt for 45 columns; the name is cut
    // so the owner still shows, and the host stays whole.
    const narrow = titleRow(50);
    expect(narrow).toContain(" Clone its… from github.com (museapphq…) into: ");
    expect(visibleWidth(narrow)).toBe(50);
  });

  test("c on a remote-only header with a remote URL clones into the peer's exact folder under the clone root, and the header turns local", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "ib-dashboard-clone-")));
    await mkdir(join(home, ".itsybitsy"));
    setUserHome(home);
    setCoordinatorHome(join(home, ".itsybitsy"));
    const clones: string[][] = [];
    const url = "git@github.com:owner/itsybitsy.git";
    cloneRepoSpawnCtx.set(((cmd: string[]) => {
      if (cmd[3] === "clone") {
        clones.push(cmd);
        mkdirSync(join(cmd.at(-1)!, ".git"), { recursive: true });
        return makeSpawnResult(0);
      }
      // A repo's origin (the clone's, once registered); no core.sshCommand (read from "/").
      return cmd.at(-1) === "remote.origin.url" ? makeSpawnResult(0, url) : makeSpawnResult(1);
    }) as SpawnFn);
    try {
      const { dashboard, service } = setup();
      // Laptop C reports a URL for itsybitsy too, but Laptop B is first.
      service.set({ links: links().map((link) => link.id === PEER_B
        ? { ...link, repos: [{ registryName: "itsybitsy", displayName: "itsybitsy", remoteUrl: url, relPath: "bun/ItsyBitsy" }, ...repos("other-repo")] }
        : link.id === PEER_C
          ? { ...link, repos: [...repos("app"), { registryName: "itsybitsy", displayName: "itsybitsy", remoteUrl: "https://elsewhere/x", relPath: null }] }
          : link) });
      selectByKey(dashboard, repoKey("itsybitsy"));
      dashboard.handleInput("c");
      const dialog = await waitForValue(() => dashboard.dialog?.type === "input" ? dashboard.dialog : null);
      // The title names the host git will connect to and the URL's path, whose
      // owner tells a fork or a stale remote apart; it is built for the overlay's width.
      expect(typeof dialog.prompt === "function" && dialog.prompt(dialogTitleMaxWidth()))
        .toBe("Clone itsybitsy from github.com (owner/itsybitsy.git) via Laptop B into:");
      // The peer's folder name, in its case; the clone still registers as itsybitsy.
      const dest = join(home, "Developer", "bun", "ItsyBitsy");
      expect(dialog.value).toBe(dest);

      dialog.onSubmit(dialog.value);
      expect(dashboard.dialog).toBeNull();
      expect(dashboard.notice).toBe("Cloning itsybitsy…");
      // A second c while the clone runs opens no second dialog.
      dashboard.handleInput("c");
      expect(dashboard.notice).toBe("Already cloning itsybitsy");
      await waitFor(() => dashboard.repos.length === 1);
      expect(dashboard.notice).toBe(`Cloned and added: itsybitsy (${dest})`);
      expect(clones).toEqual([["git", "-C", "/", "clone", "--quiet", "--", url, dest]]);
      expect(dashboard.repos).toEqual([{ path: dest, name: "itsybitsy" }]);
      // The reload went through setRepos: the peer snapshot's cache now has the clone.
      await waitFor(() => dashboard.repoCloneInfo.has(dest));
      expect(dashboard.repoCloneInfo.get(dest)).toEqual({ remoteUrl: url, relPath: "bun/ItsyBitsy" });

      // The watcher's next list carries the new local header under the same key:
      // the selection stays on it, now a shared local header.
      dashboard.onUpdate([], [makeFlatRepoHeader("itsybitsy", dest, false, false, false, "itsybitsy")], []);
      expect(dashboard.remoteSelection).toBeNull();
      expect(dashboard.agentTree.selectedRepoPath).toBe(dest);
      expect(treeRows(dashboard).map((r) => stripAnsi(r).trim()).filter((r) => r.startsWith("▾ itsybitsy"))).toHaveLength(1);
    } finally {
      cloneRepoSpawnCtx.reset();
      resetCoordinatorHome();
      resetUserHome();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("c checks the prefilled destination against the clone root it was built from, so a symlink cannot take it out", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "ib-dashboard-clone-")));
    await mkdir(join(home, ".itsybitsy"));
    setUserHome(home);
    setCoordinatorHome(join(home, ".itsybitsy"));
    // An earlier clone under the default root (~/Developer) tracks a link out of it.
    const outside = join(home, "outside");
    await mkdir(join(outside, ".config"), { recursive: true });
    await mkdir(join(home, "Developer", "A"), { recursive: true });
    await symlink(outside, join(home, "Developer", "A", "esc"));
    const gitCalls: string[][] = [];
    cloneRepoSpawnCtx.set(((cmd: string[]) => {
      gitCalls.push(cmd);
      return makeSpawnResult(1);
    }) as SpawnFn);
    try {
      const { dashboard, service } = setup();
      const url = "git@github.com:owner/itsybitsy.git";
      service.set({ links: links().map((link) => link.id === PEER_B
        ? { ...link, repos: [{ registryName: "itsybitsy", displayName: "itsybitsy", remoteUrl: url, relPath: "A/esc/.config/git" }, ...repos("other-repo")] }
        : link) });
      selectByKey(dashboard, repoKey("itsybitsy"));
      dashboard.handleInput("c");
      const dialog = await waitForValue(() => dashboard.dialog?.type === "input" ? dashboard.dialog : null);
      expect(dialog.value).toBe(join(home, "Developer", "A", "esc", ".config", "git"));

      dialog.onSubmit(dialog.value);
      await waitFor(() => dashboard.notice !== "Cloning itsybitsy…");
      expect(dashboard.notice).toBe(`Will not clone: the destination leaves the clone root through a symlink (${join(outside, ".config", "git")})`);
      expect(gitCalls).toEqual([]);
      expect(await readdir(join(outside, ".config"))).toEqual([]);
      expect(dashboard.repos).toEqual([]);
    } finally {
      cloneRepoSpawnCtx.reset();
      resetCoordinatorHome();
      resetUserHome();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("all non-allowlisted keys are refused on a remote-only header before dispatch", () => {
    const key = repoKey("itsybitsy");
    const { dashboard } = setup();
    selectByKey(dashboard, key);
    const pinned = [...dashboard.agentTree.pinnedRepoPaths];
    const handlers = Object.keys(agentActions)
      .filter((name) => typeof (agentActions as Record<string, unknown>)[name] === "function")
      .map((name) => spyOn(agentActions as Record<string, any>, name).mockImplementation(() => undefined));
    try {
      const header = dashboard.agentTree.selectedRemote!;
      for (const k of Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).filter((k) => k !== "c" && !isRemoteAllowedKey(k, header))) {
        resetNotice(dashboard);
        dashboard.handleInput(k);
        expect(dashboard.notice).toBe(REMOTE_READ_ONLY_NOTICE);
        expect(dashboard.dialog).toBeNull();
      }
      for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
      expect([...dashboard.agentTree.pinnedRepoPaths]).toEqual(pinned);
      expect(keyOf(dashboard)).toBe(key);
    } finally {
      for (const handler of handlers) handler.mockRestore();
    }
  });

  test("one agent id in two repos of one peer: each row selects on its own, and the rows below stay reachable", () => {
    const { dashboard, service } = setup();
    const agents = () => [remote("dup", "alpha"), remote("dup", "beta", { state: "waiting" }), remote("after", "gamma")];
    service.set({ links: [{ ...links()[0]!, repos: repos("alpha", "beta", "gamma"), agents: agents() }] });
    const alpha = agentKey(PEER_B, "alpha", "dup");
    const beta = agentKey(PEER_B, "beta", "dup");
    selectByKey(dashboard, alpha);
    expect(dashboard.infoPanel.remote).toMatchObject({ kind: "remote-agent", remote: { repoPath: "/remote/alpha" } });
    dashboard.handleInput("j"); // beta's repo header
    dashboard.handleInput("j");
    expect(keyOf(dashboard)).toBe(beta);
    expect(dashboard.infoPanel.remote).toMatchObject({ kind: "remote-agent", remote: { repoPath: "/remote/beta", state: "waiting" } });
    expect(treeRows(dashboard).filter((r) => r.includes("\x1b[7m")).map((r) => stripAnsi(r).trim())).toEqual([expect.stringMatching(/^└── dup +waiting$/)]);
    dashboard.handleInput("j");
    dashboard.handleInput("j");
    expect(keyOf(dashboard)).toBe(agentKey(PEER_B, "gamma", "after"));

    // J from alpha's row lands on beta's; a refresh with new objects keeps beta's; so does the Favorites carve-out.
    selectByKey(dashboard, alpha);
    dashboard.handleInput("J");
    expect(keyOf(dashboard)).toBe(beta);
    service.set({ links: [{ ...links()[0]!, repos: repos("alpha", "beta", "gamma"), agents: agents() }] });
    expect(keyOf(dashboard)).toBe(beta);
    dashboard.handleInput("3");
    expect(treeRows(dashboard).map((r) => stripAnsi(r).trim()).filter((r) => /▾|└──/.test(r))).toEqual([
      "▾ beta",
      expect.stringMatching(/^└── dup +waiting$/),
    ]);
  });

  test("a vanished bottom-most local agent selects the local row above it", () => {
    const dashboard = makeDashboard();
    const a = makeAgent("agent-a", "/repos/local");
    const b = makeAgent("agent-b", "/repos/local");
    dashboard.onUpdate([a, b], [makeFlatAgent(a), makeFlatAgent(b)], []);
    const service = new FakePeerService();
    service.state = { ...service.state, links: links() };
    dashboard.setPeerService(service);
    dashboard.handleInput("j");
    expect(dashboard.selectedAgent?.id).toBe("agent-b");

    // agent-b is retired: the watcher's next list lacks it.
    dashboard.onUpdate([a], [makeFlatAgent(a)], []);
    expect(dashboard.selectedAgent?.id).toBe("agent-a");
    expect(keyOf(dashboard)).toBeNull();
    expect(dashboard.infoPanel.remote).toBeNull();
  });

  test("the footer lists only the keys a remote row allows, and the agent hints come back on a local row", () => {
    const { dashboard, local } = setup();
    const footer = () => ((dashboard as any).statusBar.render(WIDTH) as string[]).map(stripAnsi).join("\n");
    expect(footer()).toContain("s: send");

    selectByKey(dashboard, WORKER_KEY);
    const text = footer();
    const shown = [";/l: scroll", "j/k: select", "J/K: repo", "p/n: pane", "1/2/3: tab", "V: filter", "[ ] { }: resize", "@: jump", "/: commands", "?: help", "I: peers tab", "C: terminal"];
    for (const hint of shown) expect(text).toContain(hint);
    // Nothing is cut at the narrowest width the dashboard draws.
    const narrow = ((dashboard as any).statusBar.render(MIN_TERMINAL_WIDTH) as string[]).map(stripAnsi).join("\n");
    for (const hint of ["C: terminal", ".: favorite", "s: send"]) expect(narrow).toContain(hint);
    expect(text).toContain("s: send");
    for (const hint of [".: favorite", "o: diff", "m: merge", "x: retire", "R: resume", "q: questions"]) expect(text).toContain(hint);
    // The global dialogs come last on the row, after the row's own actions.
    const wide = ((dashboard as any).statusBar.render(240) as string[]).map(stripAnsi).join("\n");
    expect(wide).toMatch(/\.: favorite +a: new agent +h: setup/);
    // A global hint that does not fit whole is left out, never cut in half.
    for (const cols of [MIN_TERMINAL_WIDTH, 150, 158]) {
      const row2 = stripAnsi(((dashboard as any).statusBar.render(cols) as string[])[1]!).trimEnd();
      expect(row2).toMatch(/(\.: favorite|a: new agent|h: setup)$/);
    }
    // Nor does one push the version on the right out of the row.
    (dashboard as any).statusBar.version = "0.1.0";
    let shownWithVersion = 0;
    for (let cols = MIN_TERMINAL_WIDTH; cols <= 200; cols++) {
      const row2 = stripAnsi(((dashboard as any).statusBar.render(cols) as string[])[1]!).trimEnd();
      if (row2.includes("a: new agent")) {
        expect(row2).toEndWith("v0.1.0");
        shownWithVersion++;
      }
    }
    expect(shownWithVersion).toBeGreaterThan(0);
    (dashboard as any).statusBar.version = "";
    for (const hint of ["c: clone here", "A: add repo", "f: fix"]) {
      expect(text).not.toContain(hint);
    }
    // Every key the remote footer names is one the guard allows.
    for (const key of ["j", "k", "J", "K", "p", "n", "1", "2", "3", "[", "]", "{", "}", "@", "/", "?", "I", "a", "h"]) {
      expect(isRemoteAllowedKey(key)).toBe(true);
    }
    expect(isRemoteAllowedKey("q", dashboard.agentTree.selectedRemote!)).toBe(true);

    selectByKey(dashboard, repoKey("itsybitsy"));
    expect(footer()).toContain(".: pin");
    expect(footer()).not.toContain("q: questions");
    expect(isRemoteAllowedKey("q", dashboard.agentTree.selectedRemote!)).toBe(false);
    // A remote-only header adds the two keys it alone takes.
    for (const hint of ["a: new agent", "c: clone here"]) expect(footer()).toContain(hint);
    expect(footer()).not.toContain("s: send");
    for (let i = 0; i < 20 && dashboard.selectedAgent !== local; i++) dashboard.handleInput("k");
    expect(footer()).toContain("s: send");
    expect(footer()).not.toContain("C: terminal");
    expect(footer()).not.toContain("c: clone here");
  });

  test("C on a remote agent opens a local tmux session running ib peer attach on it; a remote repo header refuses C", async () => {
    const calls: string[][] = [];
    const opened: string[] = [];
    terminalWindowCtx.set({
      runTmux: async (args) => { calls.push(args); return args[0] === "has-session" ? 1 : 0; },
      openInGhostty: async (session) => { opened.push(session); return { ok: true, message: "Opened in Ghostty" }; },
    });
    try {
      const { dashboard } = setup();
      selectByKey(dashboard, WORKER_KEY);
      resetNotice(dashboard);
      dashboard.handleInput("C");
      await waitFor(() => opened.length === 1, { message: "Ghostty opened" });
      const session = remoteTerminalSession(PEER_B, "itsybitsy", "worker-abc");
      expect(calls).toEqual([
        ["has-session", "-t", `=${session}`],
        ["new-session", "-d", "-s", session, "ib", "peer", "attach", `${PEER_B}/itsybitsy/worker-abc`],
      ]);
      expect(opened).toEqual([session]);
      await waitFor(() => dashboard.notice === "Opened Laptop B/itsybitsy/worker-abc in Ghostty", { message: "notice" });

      selectByKey(dashboard, repoKey("other-repo"));
      resetNotice(dashboard);
      dashboard.handleInput("C");
      expect(dashboard.notice).toBe(REMOTE_READ_ONLY_NOTICE);
      expect(calls.length).toBe(2);
    } finally {
      terminalWindowCtx.reset();
    }
  });

  test("C on a remote agent shows the startup human-caller denial and starts nothing", () => {
    const calls: string[][] = [];
    terminalWindowCtx.set({
      runTmux: async (args) => { calls.push(args); return 0; },
      openInGhostty: async () => ({ ok: true, message: "Opened in Ghostty" }),
    });
    try {
      const { dashboard, service } = setup();
      service.remoteStartDenial = "Remote starts are disabled inside tmux";
      selectByKey(dashboard, WORKER_KEY);
      resetNotice(dashboard);
      dashboard.handleInput("C");
      expect(dashboard.notice).toBe("Remote terminals are disabled while ib watch runs inside tmux; restart ib watch from a terminal outside tmux");
      expect(calls).toEqual([]);
    } finally {
      terminalWindowCtx.reset();
    }
  });

  test("@ works on a remote row: it lists only local rows and lands on one", () => {
    const { dashboard, local } = setup();
    selectByKey(dashboard, WORKER_KEY);
    resetNotice(dashboard);
    dashboard.handleInput("@");
    expect(dashboard.notice).not.toBe(REMOTE_READ_ONLY_NOTICE);
    const jump = assertDialog(dashboard.dialog, "fuzzy");
    const items = jump.allItems.map(stripAnsi);
    expect(items.some((item) => /Laptop|worker-abc|manager-def|itsybitsy/.test(item))).toBe(false);
    jump.onSelect(items.findIndex((item) => item.includes("agent-1")));
    expect(dashboard.selectedAgent).toBe(local);
    expect(keyOf(dashboard)).toBeNull();
    expect(dashboard.infoPanel.remote).toBeNull();
    expect(dashboard.infoPanel.agent).toBe(local);
  });

  test("every allowlisted key still works on a remote row", () => {
    const onRemote = (): DashboardComponent => {
      const { dashboard } = setup();
      selectByKey(dashboard, WORKER_KEY);
      resetNotice(dashboard);
      return dashboard;
    };
    const notRefused = (dashboard: DashboardComponent) => expect(dashboard.notice).not.toBe(REMOTE_READ_ONLY_NOTICE);

    // j / k / ↓ / ↑ move one row; J / K jump between repo anchors, remote ones included.
    let d = onRemote();
    d.handleInput("j");
    expect(keyOf(d)).toBe(repoKey("other-repo"));
    d.handleInput("k");
    expect(keyOf(d)).toBe(WORKER_KEY);
    d.handleInput("\x1b[B");
    expect(keyOf(d)).toBe(repoKey("other-repo"));
    d.handleInput("\x1b[A");
    expect(keyOf(d)).toBe(WORKER_KEY);
    d.handleInput("J");
    expect(keyOf(d)).toBe(agentKey(PEER_B, "other-repo", "agent-1"));
    d.handleInput("J");
    expect(keyOf(d)).toBe(agentKey(PEER_C, "app", "agent-1"));
    d.handleInput("K");
    expect(keyOf(d)).toBe(agentKey(PEER_B, "other-repo", "agent-1"));
    notRefused(d);

    // Tab / Shift+Tab move the focus; [ ] { } resize the sidebar.
    d = onRemote();
    d.handleInput("\t");
    expect(d.focus).toBe("info");
    d.handleInput("\x1b[Z");
    expect(d.focus).toBe("agent-tree");
    const width = d.sidebarWidth;
    d.handleInput("]");
    expect(d.sidebarWidth).toBe(width + 5);
    d.handleInput("[");
    expect(d.sidebarWidth).toBe(width);
    d.handleInput("}");
    expect(d.sidebar.heightOffsets.tree).toBe(1);
    d.handleInput("{");
    expect(d.sidebar.heightOffsets.tree).toBe(0);
    notRefused(d);

    // 1 / 2 / 3 switch the tab; the remote row stays the global selection.
    d = onRemote();
    d.handleInput("2");
    expect(d.sidebarMode).toBe("teams");
    expect(keyOf(d)).toBe(WORKER_KEY);
    d.handleInput("3");
    expect(d.sidebarMode).toBe("favorites");
    expect(keyOf(d)).toBe(WORKER_KEY);
    d.handleInput("1");
    expect(d.sidebarMode).toBe("agents");
    expect(keyOf(d)).toBe(WORKER_KEY);
    notRefused(d);

    // p / n and ← / → cycle the right pane's mode.
    d = onRemote();
    for (const key of ["p", "n", "\x1b[D", "\x1b[C"]) {
      const before = d.currentMode;
      d.handleInput(key);
      expect(d.currentMode).not.toBe(before);
    }
    notRefused(d);

    // a opens the New Agent form (its peer has the repo).
    d = onRemote();
    d.handleInput("a");
    expect(d.dialog?.type).toBe("new-agent-form");
    notRefused(d);

    // ? / / / I / h open their dialogs; Ctrl+C (handled before the dashboard) is never refused.
    d = onRemote();
    d.setPeerService(new FakePeerService());
    for (const [key, type] of [["?", "help"], ["/", "fuzzy"], ["I", "setup"], ["h", "setup"]] as const) {
      d.handleInput(key);
      expect(d.dialog?.type).toBe(type);
      d.closeDialog();
    }
    d.handleInput("\x03");
    notRefused(d);
  });

  test("the global actions A, T, E and H reach their handlers on a remote agent and a remote-only header", () => {
    const { dashboard } = setup();
    const spies = {
      A: spyOn(agentActions, "handleAddRepo").mockImplementation(async () => {}),
      T: spyOn(agentActions, "handleCreateTeam").mockImplementation(() => {}),
      E: spyOn(agentActions, "handleCrossRepoSend").mockImplementation(() => {}),
    };
    const recheck = mock(() => {});
    (dashboard as any).watcher = { recheckHealth: recheck };
    try {
      for (const key of [WORKER_KEY, repoKey("other-repo")]) {
        selectByKey(dashboard, key);
        for (const [k, spy] of Object.entries(spies)) {
          const before = spy.mock.calls.length;
          resetNotice(dashboard);
          dashboard.handleInput(k);
          expect(dashboard.notice).not.toBe(REMOTE_READ_ONLY_NOTICE);
          expect(spy.mock.calls.length).toBe(before + 1);
          dashboard.closeDialog();
        }
        const checks = recheck.mock.calls.length;
        dashboard.handleInput("H");
        expect(dashboard.notice).toBe("Re-checking repo health...");
        expect(recheck.mock.calls.length).toBe(checks + 1);
      }
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
    }
  });

  test("a remote row opens Setup with h, and Tab reaches Hooks and Config from Peers", () => {
    const { dashboard } = setup();
    selectByKey(dashboard, WORKER_KEY);
    resetNotice(dashboard);
    dashboard.handleInput("h");
    expect(assertDialog(dashboard.dialog, "setup").tab).toBe(0);
    dashboard.closeDialog();
    dashboard.handleInput("I");
    expect(assertDialog(dashboard.dialog, "setup").tab).toBe(2);
    dashboard.handleInput("\t");
    expect(assertDialog(dashboard.dialog, "setup").tab).toBe(0);
    dashboard.handleInput("\x1b[Z");
    expect(assertDialog(dashboard.dialog, "setup").tab).toBe(2);
    dashboard.handleInput("\x1b[Z");
    expect(assertDialog(dashboard.dialog, "setup").tab).toBe(1);
    expect(dashboard.notice).not.toBe(REMOTE_READ_ONLY_NOTICE);
  });

  test("a on a remote agent opens the New Agent form for that agent's repo", () => {
    const { dashboard } = setup();
    selectByKey(dashboard, WORKER_KEY);
    // Not registered here: the form names the remote repo and offers only its peer.
    dashboard.repos = [{ name: "local", path: "/repos/local" }];
    dashboard.handleInput("a");
    let form = assertDialog(dashboard.dialog, "new-agent-form");
    expect(form.repoName).toBe("itsybitsy");
    expect(form.machines()).toEqual([{ id: PEER_B, name: "Laptop B" }]);
    expect(form.machine).toEqual({ id: PEER_B, name: "Laptop B" });
    dashboard.closeDialog();

    // Registered here under another case: this machine comes first, under its display name.
    dashboard.repos = [{ name: "local", path: "/repos/local" }, { name: "ItsyBitsy", path: "/repos/itsy", nickname: "Itsy" }];
    dashboard.handleInput("a");
    form = assertDialog(dashboard.dialog, "new-agent-form");
    expect(form.repoName).toBe("Itsy");
    expect(form.machines()).toEqual([{ id: null, name: "This machine" }, { id: PEER_B, name: "Laptop B" }]);
    dashboard.closeDialog();

    // An offline peer's agent, its repo registered nowhere else: the form's no-host notice.
    selectByKey(dashboard, agentKey(PEER_C, "app", "agent-1"));
    resetNotice(dashboard);
    dashboard.handleInput("a");
    expect(dashboard.dialog).toBeNull();
    expect(dashboard.notice).toBe("No connected machine has app");
  });

  test("a on a remote agent looks for the prompt's files in this machine's checkout of the repo", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "ib-dashboard-remote-agent-start-"));
    try {
      await Bun.write(join(checkout, "src/app.ts"), "app");
      const { dashboard, service } = setup();
      selectByKey(dashboard, WORKER_KEY);
      const start = spyOn(service, "startRemoteAgent").mockResolvedValue("builder");
      const openForm = (repos: typeof dashboard.repos) => {
        dashboard.repos = repos;
        dashboard.handleInput("a");
        const form = assertDialog(dashboard.dialog, "new-agent-form");
        form.machine = { id: PEER_B, name: "Laptop B" };
        form.agentType = "worker";
        form.buffer.handleInput("\x1b[200~Review ./src/app.ts\x1b[201~");
        form.focused = "create";
        return form;
      };

      // Registered here under another case: the relative path resolves in that checkout and is offered, unchecked.
      const form = openForm([{ name: "ItsyBitsy", path: checkout }]);
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog?.type === "multi-select", { message: "the path dialog" });
      const picker = assertDialog(dashboard.dialog, "multi-select");
      expect(picker.items).toEqual(["./src/app.ts"]);
      expect(picker.checked).toEqual([false]);
      dashboard.handleInput("\x1b");
      expect(dashboard.dialog).toBe(form);
      await waitFor(() => !dashboard.remoteStartPending);
      dashboard.closeDialog();

      // Not registered here: no local checkout, so the relative path stays text with no dialog.
      openForm([{ name: "local", path: "/repos/local" }]);
      const shown = spyOn(dashboard, "showDialog");
      dashboard.handleInput("\r");
      await waitFor(() => dashboard.dialog === null);
      expect(shown).not.toHaveBeenCalled();
      expect(start.mock.calls).toEqual([[PEER_B, { repo: "itsybitsy", type: "worker", prompt: "Review ./src/app.ts" }, { signal: expect.any(AbortSignal) }]]);
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });

  test("the command palette goes through the same guard", () => {
    const { dashboard, service } = setup();
    selectByKey(dashboard, WORKER_KEY);
    const retire = spyOn(agentActions, "handleRetire").mockImplementation(() => {});
    try {
      const pick = (label: string) => {
        dashboard.handleInput("/");
        const palette = assertDialog(dashboard.dialog, "fuzzy");
        palette.onSelect(palette.allItems.indexOf(label));
      };
      resetNotice(dashboard);
      pick("retire agent — x");
      expect(retire).toHaveBeenCalledTimes(1);
      resetNotice(dashboard);
      pick("force kill agent — !");
      expect(dashboard.notice).toBe(REMOTE_READ_ONLY_NOTICE);
      expect(dashboard.dialog).toBeNull();
      // Clone here is a remote-only header's key, not a remote agent's.
      resetNotice(dashboard);
      pick("clone repo here (peer-only repo) — c");
      expect(dashboard.notice).toBe(REMOTE_READ_ONLY_NOTICE);
      selectByKey(dashboard, repoKey("other-repo"));
      pick("clone repo here (peer-only repo) — c");
      expect(dashboard.notice).toBe("Laptop B reports no remote for other-repo");
      pick("setup: Peers tab — I");
      expect(assertDialog(dashboard.dialog, "setup").tab).toBe(2);
      expect(service.calls).toContain("open");
    } finally {
      retire.mockRestore();
    }
  });

  test("palette mode jumps and d/e/g work on a remote agent; a peer coordinator keeps its fixed view", () => {
    const pick = (dashboard: DashboardComponent, label: string) => {
      dashboard.handleInput("/");
      const palette = assertDialog(dashboard.dialog, "fuzzy");
      palette.onSelect(palette.allItems.findIndex((item) => item.startsWith(label + " —")));
    };
    const { dashboard } = setup();
    selectByKey(dashboard, WORKER_KEY);
    for (const mode of ["AGENT LOG", "INITIAL PROMPT", "WATCHDOG LOG", "PROXY LOG", "DENIALS", "DIFF", "STATUS", "ERRORS", "TREE"] as const) {
      resetNotice(dashboard);
      pick(dashboard, mode);
      expect(dashboard.notice).toBeNull();
      expect(dashboard.currentMode).toBe(mode);
    }
    for (const [key, mode] of [["d", "DIFF"], ["e", "ERRORS"], ["g", "STATUS"]] as const) {
      resetNotice(dashboard);
      dashboard.handleInput(key);
      expect(dashboard.notice).toBeNull();
      expect(dashboard.currentMode).toBe(mode);
    }
    expect(keyOf(dashboard)).toBe(WORKER_KEY);

    const { dashboard: coordinator, service } = setup();
    coordinator.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    const [b] = links();
    service.set({ peers: [{ ...b!, pairedAt: "x" }], links: [b!] });
    selectByKey(coordinator, PEER_B + "/@system");
    const mode = coordinator.currentMode;
    for (const press of [() => pick(coordinator, "AGENT LOG"), () => coordinator.handleInput("d")]) {
      resetNotice(coordinator);
      press();
      expect(coordinator.notice).toBe("view mode is fixed for remote coordinators");
      expect(coordinator.currentMode).toBe(mode);
    }
  });

  test("remote favorites toggle locally, dim when offline, and survive a missing snapshot row", async () => {
    const { dashboard, service, local } = setup();
    const tree = dashboard.agentTree;
    selectByKey(dashboard, WORKER_KEY);
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Favorited abc-nick");
    tree.selectAgent(local);
    dashboard.syncSelectedAgent();
    dashboard.handleInput("3");
    const rows = () => treeRows(dashboard);
    const favorite = () => rows().find(row => row.includes("abc-nick"));
    expect(rows().map(stripAnsi)).toContain("▾ itsybitsy");
    expect(favorite()).toContain(YELLOW + "★" + RESET + ITALIC + " abc-nick");
    expect(rows().join("")).not.toContain("manager-def");
    expect(rows().join("")).not.toContain("No favorites");
    const peer = links()[0]!;
    service.set({ links: [{ ...peer, connected: false, connectedAt: null, lastError: "offline" }] });
    expect(favorite()).toContain(ITALIC + DIM + " abc-nick");
    service.set({ links: [{ ...peer, agents: [] }] });
    expect(favorite()).toBeUndefined();
    await flushPendingSave();
    expect((await loadLayout())?.favoriteAgentIds).toEqual([WORKER_KEY]);
    service.set({ links: [peer] });
    selectByKey(dashboard, WORKER_KEY);
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Unfavorited abc-nick");
    expect(tree.favoriteAgentIds.size).toBe(0);
    dashboard.handleInput("k");
    expect(favorite()).toBeUndefined();
    expect(service.calls).toEqual([]);
  });

  test("favoriting a remote manager shows its descendants under their shared local header", () => {
    const { dashboard, local } = setup();
    dashboard.setRepos([{ name: "ItsyBitsy", nickname: "Local label", path: local.repoPath }]);
    selectByKey(dashboard, agentKey(PEER_B, "itsybitsy", "manager-def"));
    dashboard.handleInput(".");
    dashboard.agentTree.selectByRepoPath(local.repoPath);
    dashboard.syncSelectedAgent();
    dashboard.handleInput("3");
    const rows = treeRows(dashboard).map(row => stripAnsi(row).trimEnd());
    expect(rows).toEqual(["▾ Local label", expect.stringContaining("└── ★ manager-def"), expect.stringContaining("    └── abc-nick")]);
  });

  test("a remote repo pin follows its registry name across peers under V", async () => {
    const { dashboard, service, local } = setup();
    const tree = dashboard.agentTree;
    const [first, second] = links();
    service.set({ links: [{ ...first!, repos: repos("App"), agents: [] }] });
    selectByKey(dashboard, repoKey("App"));
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Pinned App");
    tree.selectAgent(local);
    dashboard.syncSelectedAgent();
    await flushPendingSave();
    const saved = await loadLayout();
    expect(saved?.pinnedRemoteRepoNames).toEqual(["app"]);
    expect(saved?.pinnedRepoPaths).toEqual([]);
    expect(saved?.favoriteAgentIds).toEqual([]);
    const restored = makeDashboard();
    restored.applyLayout(saved!);
    expect([...restored.agentTree.pinnedRemoteRepoNames]).toEqual(["app"]);
    service.set({ links: [{ ...second!, repos: [{ registryName: "APP", displayName: "Renamed", remoteUrl: null, relPath: null }], agents: [] }] });
    for (const filter of ["non-empty", "running-only"] as const) {
      tree.setRepoFilter(filter);
      expect(treeRows(dashboard).map(stripAnsi)).toContain("⚲ Renamed");
    }
    selectByKey(dashboard, repoKey("APP"));
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Unpinned Renamed");
    tree.selectAgent(local);
    expect(treeRows(dashboard).join("")).not.toContain("Renamed");
    expect(tree.pinnedRemoteRepoNames.size).toBe(0);
    expect(service.calls).toEqual([]);
  });

  test("dot on either system coordinator gives the same informational notice", () => {
    const { dashboard } = setup();
    dashboard.onUpdate([], [{ kind: "system-coordinator", state: "running", age: "1m" }], []);
    dashboard.agentTree.selectSystemCoordinator();
    dashboard.syncSelectedAgent();
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Select an agent or repo header");
    selectByKey(dashboard, PEER_B + "/@system");
    resetNotice(dashboard);
    dashboard.handleInput(".");
    expect(dashboard.notice).toBe("Select an agent or repo header");
    expect(dashboard.agentTree.favoriteAgentIds.size).toBe(0);
    expect(dashboard.agentTree.pinnedRemoteRepoNames.size).toBe(0);
  });

  test("without remote favorites, Favorites only keeps the selected peer row and its header", () => {
    const { dashboard } = setup();
    dashboard.handleInput("3");
    expect(treeRows(dashboard).map(stripAnsi).some((r) => r.includes("Laptop"))).toBe(false);
    dashboard.handleInput("1");
    selectByKey(dashboard, WORKER_KEY);
    dashboard.handleInput("3");
    const rows = treeRows(dashboard).map((r) => stripAnsi(r).trimEnd());
    expect(rows.filter((r) => /Laptop|▾|└──/.test(r))).toEqual([
      "▾ itsybitsy",
      "└── abc-nick  running",
    ]);
    expect(keyOf(dashboard)).toBe(WORKER_KEY);
  });

  test("poll updates redraw only a visible change in the Agents tab or TREE mode", () => {
    const dashboard = makeDashboard();
    const counter = countingTui();
    dashboard.setTui(counter.tui);
    const local = makeAgent("agent-1", "/repos/local");
    dashboard.onUpdate([local], [makeFlatAgent(local)], []);
    const service = new FakePeerService();
    dashboard.setPeerService(service);

    let renders = counter.renders();
    service.set({ links: links() });
    expect(counter.renders()).toBe(renders + 1);
    expect(treeRows(dashboard).map(stripAnsi).some((r) => r.includes("abc-nick"))).toBe(true);

    // Nothing the sections show: the same peers and lists, a dialog-only change.
    renders = counter.renders();
    service.set({ links: [...service.state.links] });
    service.set({ status: { kind: "starting" } });
    const connectedB = service.state.links[0]!;
    service.set({ links: [{ ...connectedB, lastOkAt: connectedB.lastOkAt! + 5_000 }, ...service.state.links.slice(1)] });
    expect(counter.renders()).toBe(renders);

    // Disk paths appear only in the selected agent's info. Poll errors appear only in Peers.
    const b = service.state.links[0]!;
    const c = service.state.links[1]!;
    service.set({ links: [{ ...b, agents: b.agents!.map((agent) => ({ ...agent, repoPath: "/elsewhere" })) },
      { ...c, coordinator: null, lastError: "still unreachable" }, ...service.state.links.slice(2)] });
    expect(counter.renders()).toBe(renders);

    // The Teams tab draws no section: rebuilt, but no render.
    dashboard.setSidebarMode("teams");
    service.set({ links: [{ ...service.state.links[0]!, connected: false }, ...service.state.links.slice(1)] });
    expect(counter.renders()).toBe(renders);
    expect(dashboard.agentTree.visibleList.find((r) => r.kind === "remote-agent" && r.peerId === PEER_B)).toMatchObject({ linkStatus: "offline" });
    // TREE mode draws the Agents tree in the main area, whatever the tab.
    dashboard.jumpToMode("TREE");
    renders = counter.renders();
    service.set({ links: [{ ...service.state.links[0]!, connected: true }, ...service.state.links.slice(1)] });
    expect(counter.renders()).toBe(renders + 1);
  });

  test("a selected remote row that its peer drops moves the selection, and the panes follow", () => {
    const { dashboard, service, local } = setup();
    selectByKey(dashboard, repoKey("other-repo"));
    service.set({ links: [] });
    expect(keyOf(dashboard)).toBeNull();
    expect(dashboard.selectedAgent).toBe(local);
    expect(dashboard.infoPanel.remote).toBeNull();
    expect(dashboard.infoPanel.agent).toBe(local);
  });

  describe("peer questions (SPEC §20.5)", () => {
    const asked = (agent: string, repo: string): RemoteQuestion =>
      ({ id: `q-${agent}`, agent, repoRegistryName: repo, question: `${agent} asks?\nsecond line`, timestamp: "2026-11-24T10:00:00Z" });
    const footer = (dashboard: DashboardComponent) => ((dashboard as any).statusBar.render(WIDTH) as string[]).map(stripAnsi).join("\n");
    const listed = (dashboard: DashboardComponent) => dashboard.rightPane.questions.map((q) => `${q.peer?.name ?? "local"}:${q.agent}`);
    const screen = (dashboard: DashboardComponent) => stripAnsi(dashboard.render(WIDTH).join("\n"));

    /**
     * setup() with the local agent asking a question, Laptop B's worker-abc
     * asking one (and one for an agent it has no row for), and offline
     * Laptop C's agent-1 asking one. `peerAgentAt` moves Laptop B's agent-1
     * to that path.
     */
    function setupQuestions(peerAgentAt?: string) {
      const { dashboard, service, local } = setup();
      dashboard.onUpdate([local], [makeFlatAgent(local)], [
        { id: "q-local", agent: local.id, question: "Local asks?", timestamp: "2026-11-24T09:00:00Z", status: "pending", repoPath: local.repoPath },
      ]);
      const [b, c, d] = links();
      const agents = b!.agents!.map((agent) => agent.id === "agent-1" && peerAgentAt ? { ...agent, repoPath: peerAgentAt } : agent);
      service.set({ links: [
        { ...b!, agents, questions: [asked("worker-abc", "itsybitsy"), asked("gone", "itsybitsy"), ...peerAgentAt ? [asked("agent-1", "other-repo")] : []] },
        { ...c!, questions: [asked("agent-1", "app")] },
        d!,
      ] });
      return { dashboard, service, local };
    }

    test("follow the local questions in the list and the count, from connected peers only, and turn the name red", () => {
      const { dashboard, service, local } = setupQuestions();
      expect(listed(dashboard)).toEqual(["local:agent-1", "Laptop B:worker-abc"]);
      expect(dashboard.rightPane.questions[1]).toMatchObject({
        id: "q-worker-abc", question: "worker-abc asks?\nsecond line", repoPath: "/remote/itsybitsy",
        peer: { id: PEER_B, name: "Laptop B", repo: "itsybitsy" },
      });
      expect(footer(dashboard)).toContain("q: questions (2)");
      expect([...dashboard.agentTree.questionAgentKeys]).toEqual([dashboard.agentTree.agentKey(local), WORKER_KEY]);
      expect(treeRows(dashboard).some((row) => row.includes(RED + "abc-nick"))).toBe(true);

      // A new local list keeps the peer's after it.
      dashboard.onUpdate([local], [makeFlatAgent(local)], []);
      expect(listed(dashboard)).toEqual(["Laptop B:worker-abc"]);
      expect(footer(dashboard)).toContain("q: questions (1)");

      // Laptop B drops: its question and red name go with it.
      const [b, ...rest] = service.state.links;
      service.set({ links: [{ ...b!, connected: false, connectedAt: null, lastError: "timed out" }, ...rest] });
      expect(listed(dashboard)).toEqual([]);
      expect(footer(dashboard)).not.toContain("q: questions (");
      expect(dashboard.agentTree.questionAgentKeys.size).toBe(0);
    });

    test("g on a remote-only header left in QUESTIONS jumps to STATUS, not to a question it hides", () => {
      const { dashboard } = setupQuestions();
      dashboard.handleInput("q");
      selectByKey(dashboard, repoKey("other-repo"));
      expect(dashboard.currentMode).toBe("QUESTIONS");
      expect(dashboard.rightPane.filteredQuestions.length).toBeGreaterThan(0);
      resetNotice(dashboard);
      dashboard.handleInput("g");
      expect(keyOf(dashboard)).toBe(repoKey("other-repo"));
      expect(dashboard.currentMode).toBe("STATUS");
      expect(dashboard.notice).toBeNull();
    });

    test("with no agent selected every question is listed, a peer's under its machine, and g selects its remote row", () => {
      const { dashboard } = setupQuestions();
      dashboard.agentTree.deselect();
      dashboard.syncSelectedAgent();
      dashboard.handleInput("q");
      const text = screen(dashboard);
      expect(text).toContain("agent-1: Local asks?");
      expect(text).toContain("Laptop B/worker-abc: worker-abc asks?");
      expect(text).toContain("second line");
      dashboard.setQuestionsFocused(true);
      dashboard.handleInput("j");
      dashboard.handleInput("g");
      expect(keyOf(dashboard)).toBe(WORKER_KEY);
      expect(dashboard.activeSelectionSource).toBe("agents");
      expect(dashboard.currentMode).toBe("AGENT LOG");
    });

    test("q on a remote agent shows its questions full-width and pauses its pane read while they show", () => {
      const { dashboard } = setupQuestions();
      const running = spyOn((dashboard as any).tmuxPoller, "isRunning").mockReturnValue(true);
      const timers = new Set<() => void>();
      (dashboard as any).remotePane.every = (_ms: number, tick: () => void) => {
        timers.add(tick);
        return () => timers.delete(tick);
      };
      try {
        selectByKey(dashboard, WORKER_KEY);
        expect(timers.size).toBe(1);
        resetNotice(dashboard);
        dashboard.handleInput("q");
        expect(dashboard.notice).toBeNull();
        expect(dashboard.currentMode).toBe("QUESTIONS");
        expect(timers.size).toBe(0);
        const text = screen(dashboard);
        expect(text).toContain("Laptop B/worker-abc: worker-abc asks?");
        expect(text).not.toContain("Local asks?");
        expect(text).not.toContain(REMOTE_RIGHT_PANE_TEXT);
        expect(text).not.toContain("peer capture");
        // p/n cycle out to the split view and its read, and back to the same questions.
        dashboard.handleInput("n");
        expect(dashboard.currentMode).not.toBe("QUESTIONS");
        expect(timers.size).toBe(1);
        dashboard.handleInput("p");
        expect(dashboard.currentMode).toBe("QUESTIONS");
        expect(timers.size).toBe(0);
        expect(screen(dashboard)).toContain("Laptop B/worker-abc: worker-abc asks?");

        selectByKey(dashboard, agentKey(PEER_B, "itsybitsy", "manager-def"));
        expect(dashboard.currentMode).toBe("QUESTIONS");
        expect(screen(dashboard)).toContain("No pending questions for Laptop B/manager-def");
      } finally {
        running.mockRestore();
        dashboard.stopPolling();
      }
    });

    test("Enter answers with the remote send, then acknowledges on the peer; a failed acknowledge never resends", async () => {
      const { dashboard, service } = setupQuestions();
      selectByKey(dashboard, WORKER_KEY);
      dashboard.handleInput("q");
      dashboard.handleInput("\r");
      const dialog = assertDialog(dashboard.dialog, "textarea");
      expect(dialog.prompt).toBe("Answer Laptop B/worker-abc's question:");
      service.acknowledgeRemoteQuestion.mockRejectedValueOnce(new Error("Laptop B is disconnected"));
      dialog.onSubmit("Yes, ship it");
      await waitFor(() => !dialog.inFlight && service.acknowledgeRemoteQuestion.mock.calls.length === 1);
      expect(service.sendRemoteMessage.mock.calls.map((call) => call.slice(0, 2))).toMatchObject([[PEER_B, {
        from: { kind: "user" }, target: { kind: "agent", repo: "itsybitsy", agent: "worker-abc" }, message: "Yes, ship it", files: [],
      }]]);
      expect(dashboard.dialog).toBe(dialog);
      expect(dashboard.notice).toBe("Answered Laptop B/worker-abc, but acknowledge failed: Laptop B is disconnected");
      expect(listed(dashboard)).toContain("Laptop B:worker-abc");

      // The retry acknowledges only.
      dialog.onSubmit("Yes, ship it");
      await waitFor(() => dashboard.dialog === null);
      expect(service.sendRemoteMessage).toHaveBeenCalledTimes(1);
      expect(service.acknowledgeRemoteQuestion.mock.calls).toEqual([
        [PEER_B, "itsybitsy", "q-worker-abc"], [PEER_B, "itsybitsy", "q-worker-abc"],
      ]);
      expect(dashboard.notice).toBe("Answered Laptop B/worker-abc");
      expect(listed(dashboard)).toEqual(["local:agent-1"]);
    });

    test("an answer naming a file asks for attachments over the answer dialog, which comes back until the acknowledge", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ib-dashboard-answer-"));
      try {
        const file = join(dir, "log.txt");
        await Bun.write(file, "log");
        const { dashboard, service } = setupQuestions();
        selectByKey(dashboard, WORKER_KEY);
        dashboard.handleInput("q");
        dashboard.handleInput("\r");
        const dialog = assertDialog(dashboard.dialog, "textarea");
        const answer = `See ${file}`;
        dialog.onSubmit(answer);
        await waitFor(() => dashboard.dialog?.type === "multi-select");
        dashboard.handleInput("\x1b");
        expect(dashboard.dialog).toBe(dialog);
        await waitFor(() => !dialog.inFlight);
        expect(dashboard.notice).toBe("Send cancelled");
        expect(service.sendRemoteMessage).not.toHaveBeenCalled();
        expect(service.acknowledgeRemoteQuestion).not.toHaveBeenCalled();

        dialog.onSubmit(answer);
        await waitFor(() => dashboard.dialog?.type === "multi-select");
        dashboard.handleInput("\r");
        expect(dashboard.dialog).toBe(dialog);
        await waitFor(() => dashboard.dialog === null);
        expect(service.sendRemoteMessage.mock.calls.map(call => call[1])).toMatchObject([{ message: answer, files: [] }]);
        expect(service.acknowledgeRemoteQuestion).toHaveBeenCalledTimes(1);
        expect(dashboard.notice).toBe("Answered Laptop B/worker-abc");
      } finally { await rm(dir, { recursive: true, force: true }); }
    });

    test("Esc cancels a pending send first, then acknowledges, and the question leaves at once until a poll drops it", async () => {
      const { dashboard, service } = setupQuestions();
      selectByKey(dashboard, WORKER_KEY);
      dashboard.handleInput("q");
      service.sendRemoteMessage.mockImplementationOnce((_peer, _header, _source, transfer) => new Promise((_resolve, reject) => {
        transfer!.signal!.addEventListener("abort", () => reject(transfer!.signal!.reason));
      }));
      dashboard.handleInput("s");
      assertDialog(dashboard.dialog, "textarea").onSubmit("hello");
      await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
      dashboard.closeDialog();
      dashboard.handleInput("\x1b");
      await waitFor(() => dashboard.notice === "Send cancelled");
      expect(service.acknowledgeRemoteQuestion).not.toHaveBeenCalled();

      service.acknowledgeRemoteQuestion.mockRejectedValueOnce(new Error("Question 'q-worker-abc' not found"));
      dashboard.handleInput("\x1b");
      await dashboard.flushPendingActions();
      expect(dashboard.notice).toBe("Acknowledge failed: Question 'q-worker-abc' not found");
      expect(listed(dashboard)).toContain("Laptop B:worker-abc");

      dashboard.handleInput("\x1b");
      await dashboard.flushPendingActions();
      expect(dashboard.notice).toBe("Acknowledged q-worker-abc");
      expect(service.acknowledgeRemoteQuestion.mock.calls.at(-1)).toEqual([PEER_B, "itsybitsy", "q-worker-abc"]);
      expect(listed(dashboard)).toEqual(["local:agent-1"]);
      expect(dashboard.agentTree.questionAgentKeys.has(WORKER_KEY)).toBe(false);
      expect(screen(dashboard)).toContain("No pending questions for Laptop B/worker-abc");

      // A poll that still lists it keeps it hidden; one that drops it forgets it.
      const [b, ...rest] = service.state.links;
      service.set({ links: [{ ...b!, questions: [...b!.questions!] }, ...rest] });
      expect(listed(dashboard)).toEqual(["local:agent-1"]);
      service.set({ links: [{ ...b!, questions: [] }, ...rest] });
      service.set({ links: [{ ...b!, questions: [asked("worker-abc", "itsybitsy")] }, ...rest] });
      expect(listed(dashboard)).toEqual(["local:agent-1", "Laptop B:worker-abc"]);
    });

    /** Open the answer dialog for the selected remote agent's question and press Send on `draft`. */
    function submitAnswer(dashboard: DashboardComponent, draft: string) {
      dashboard.handleInput("q");
      dashboard.handleInput("\r");
      const dialog = assertDialog(dashboard.dialog, "textarea");
      for (const ch of draft) dashboard.handleInput(ch);
      dashboard.handleInput("\x1b[Z");
      dashboard.handleInput("\r");
      return dialog;
    }

    test("a failed answer send keeps the dialog and its draft, and acknowledges nothing", async () => {
      const { dashboard, service } = setupQuestions();
      selectByKey(dashboard, WORKER_KEY);
      service.sendRemoteMessage.mockRejectedValueOnce(new Error("Laptop B is disconnected"));
      const dialog = submitAnswer(dashboard, "yes");
      await waitFor(() => dashboard.notice === "Laptop B is disconnected" && !dialog.inFlight);
      expect(service.sendRemoteMessage).toHaveBeenCalledTimes(1);
      expect(dashboard.dialog).toBe(dialog);
      expect(dialog.buffer.getText()).toBe("yes");
      expect(service.acknowledgeRemoteQuestion).not.toHaveBeenCalled();
      expect(listed(dashboard)).toContain("Laptop B:worker-abc");
    });

    test("Esc while the answer is sending cancels it, keeps the draft and acknowledges nothing", async () => {
      const { dashboard, service } = setupQuestions();
      selectByKey(dashboard, WORKER_KEY);
      service.sendRemoteMessage.mockImplementationOnce((_peer, _header, _source, transfer) =>
        new Promise((_, reject) => transfer!.signal!.addEventListener("abort", () => reject(transfer!.signal!.reason))));
      const dialog = submitAnswer(dashboard, "yes");
      await waitFor(() => service.sendRemoteMessage.mock.calls.length === 1);
      expect(dialog.inFlight).toBe(true);
      dashboard.handleInput("\x1b");
      await waitFor(() => dashboard.notice === "Send cancelled" && !dialog.inFlight);
      expect(dashboard.dialog).toBe(dialog);
      expect(dialog.buffer.getText()).toBe("yes");
      expect(service.acknowledgeRemoteQuestion).not.toHaveBeenCalled();
      expect(listed(dashboard)).toContain("Laptop B:worker-abc");
    });

    test("; and l scroll a remote agent's questions, not its hidden capture", () => {
      const { dashboard } = setupQuestions();
      selectByKey(dashboard, WORKER_KEY);
      const pane = (dashboard as any).remotePane;
      dashboard.handleInput("q");
      dashboard.handleInput(";");
      expect(pane.scrollBack).toBe(0);
      expect(dashboard.rightPane.scrollOffset).toBeGreaterThan(0);
      dashboard.handleInput("l");
      expect(dashboard.rightPane.scrollOffset).toBe(0);
      // In the split view `;` scrolls the capture again.
      dashboard.handleInput("n");
      dashboard.handleInput(";");
      expect(pane.scrollBack).toBeGreaterThan(0);
    });

    test("the palette's QUESTIONS entry passes the guard as q: allowed on a remote agent, refused on a remote header", () => {
      const { dashboard } = setupQuestions();
      const runQuestions = () => {
        dashboard.handleInput("/");
        const palette = assertDialog(dashboard.dialog, "fuzzy");
        palette.onSelect(palette.allItems.findIndex((item) => item.startsWith("QUESTIONS")));
      };
      selectByKey(dashboard, WORKER_KEY);
      resetNotice(dashboard);
      runQuestions();
      expect(dashboard.notice).toBeNull();
      expect(dashboard.currentMode).toBe("QUESTIONS");
      expect(screen(dashboard)).toContain("Laptop B/worker-abc: worker-abc asks?");

      dashboard.handleInput("n");
      const mode = dashboard.currentMode;
      selectByKey(dashboard, repoKey("other-repo"));
      runQuestions();
      expect(dashboard.notice).toBe(REMOTE_READ_ONLY_NOTICE);
      expect(dashboard.currentMode).toBe(mode);
    });

    test("a local agent with the peer agent's id and path never gets the peer's question", () => {
      const { dashboard, local } = setupQuestions("/repos/local");
      expect(local.repoPath).toBe("/repos/local");
      expect(dashboard.selectedAgent).toBe(local);
      dashboard.handleInput("q");
      expect(dashboard.rightPane.filteredQuestions.map((q) => q.id)).toEqual(["q-local"]);
      expect(screen(dashboard)).not.toContain("Laptop B/agent-1");
      expect(dashboard.agentTree.questionAgentKeys.has(agentKey(PEER_B, "other-repo", "agent-1"))).toBe(true);
      dashboard.onUpdate([local], [makeFlatAgent(local)], []);
      expect(dashboard.rightPane.filteredQuestions).toEqual([]);
      expect(screen(dashboard)).toContain("No pending questions for agent-1");
      expect(dashboard.agentTree.questionAgentKeys.has(dashboard.agentTree.agentKey(local))).toBe(false);
      resetNotice(dashboard);
      dashboard.handleInput("\r");
      dashboard.handleInput("\x1b");
      expect(dashboard.dialog).toBeNull();
      expect(dashboard.notice).toBeNull();
    });
  });
});

// What the peer snapshot sends with each repo (SPEC §20.4): read in the
// background by setRepos, through a fake git.
describe("the peer snapshot's clone-info cache", () => {
  afterEach(() => cloneRepoSpawnCtx.reset());

  /** A fake git whose `config --get remote.origin.url` for each repo answers once its gate opens. */
  function gatedGit() {
    const gates = new Map<string, () => void>();
    cloneRepoSpawnCtx.set(((cmd: string[]) => {
      const path = cmd[2]!;
      const open = new Promise<void>((resolve) => gates.set(path, resolve));
      const stdout = new ReadableStream<Uint8Array>({
        async start(c) {
          await open;
          c.enqueue(new TextEncoder().encode(`git@github.com:owner/${path.split("/").pop()}.git\n`));
          c.close();
        },
      });
      return { stdout, stderr: new Response("").body, exited: open.then(() => 0) };
    }) as SpawnFn);
    return gates;
  }

  test("setRepos re-reads each repo's origin URL in the background", async () => {
    const gates = gatedGit();
    const dashboard = makeDashboard();
    dashboard.setRepos([{ name: "app", path: "/repos/app" }, { name: "lib", path: "/repos/lib" }]);
    expect(dashboard.repoCloneInfo.size).toBe(0);
    // By path: a re-read an earlier test's dashboard left running can reach this fake too.
    await waitFor(() => gates.has("/repos/app") && gates.has("/repos/lib"));
    for (const open of gates.values()) open();
    await waitFor(() => dashboard.repoCloneInfo.size === 2);
    expect([...dashboard.repoCloneInfo]).toEqual([
      ["/repos/app", { remoteUrl: "git@github.com:owner/app.git", relPath: null }],
      ["/repos/lib", { remoteUrl: "git@github.com:owner/lib.git", relPath: null }],
    ]);
  });

  test("a re-read that a newer one overtook is dropped", async () => {
    const gates = gatedGit();
    const dashboard = makeDashboard();
    dashboard.repos = [{ name: "old", path: "/repos/old" }];
    const older = dashboard.refreshRepoCloneInfo();
    dashboard.repos = [{ name: "new", path: "/repos/new" }];
    const newer = dashboard.refreshRepoCloneInfo();
    await waitFor(() => gates.has("/repos/old") && gates.has("/repos/new"));
    gates.get("/repos/new")!();
    await newer;
    gates.get("/repos/old")!();
    await older;
    expect([...dashboard.repoCloneInfo]).toEqual([["/repos/new", { remoteUrl: "git@github.com:owner/new.git", relPath: null }]]);
  });
});

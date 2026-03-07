import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { readAgentLog, readAgentPrompt, parseDenials } from "../agents";
import type { Agent, AgentMeta, FlatAgent, PendingQuestion } from "../agents";
import { TmuxPaneComponent, RightPaneComponent, DashboardComponent, AgentTreeComponent, colorizeDiff, colorizeLog, formatAgentRow } from "./dashboard";
import { visibleWidth } from "@mariozechner/pi-tui";
import { setRunner, resetRunner } from "../ib-commands";

function makeAgent(id: string, repoPath: string, archived = false): Agent {
  return {
    id,
    repoPath,
    repoName: "test",
    state: "unknown",
    age: "1m",
    archived,
    children: [],
    meta: {
      id,
      session_id: "sess-1",
      tmux_session: `tmux-${id}`,
      prompt: "test prompt",
      manager: null,
      created: "2026-03-05T00:00:00Z",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true,
      worker: false,
      yolo: false,
      model: "sonnet",
      claude_pid: "12345",
    } as AgentMeta,
  };
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

  function setupDashboardWithAgent(state = "running") {
    dashboard = new DashboardComponent();
    lastIbCall = null;
    setRunner(async (args, cwd) => {
      lastIbCall = { args, cwd };
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
    });

    const agent = makeAgent("agent-test", "/repos/test");
    agent.state = state as any;
    const flatList: FlatAgent[] = [{ agent, depth: 0, connector: "" }];
    dashboard.onUpdate([agent], flatList, []);
  }

  afterEach(() => {
    resetRunner();
  });

  test("x key opens kill confirm dialog with button UI", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("x");
    expect(dashboard.dialog).not.toBeNull();
    expect(dashboard.dialog!.type).toBe("confirm");
    expect((dashboard.dialog as any).prompt).toContain("Kill agent");
    expect((dashboard.dialog as any).prompt).toContain("agent-test");
    expect((dashboard.dialog as any).confirmLabel).toBe("Kill");
    expect((dashboard.dialog as any).focusedButton).toBe("cancel");
  });

  test("kill confirm dialog: Enter on Kill button executes kill", async () => {
    setupDashboardWithAgent();
    dashboard.handleInput("x");
    // focusedButton defaults to "cancel", Tab to Kill, then press Enter
    dashboard.handleInput("\t");
    expect((dashboard.dialog as any).focusedButton).toBe("confirm");
    dashboard.handleInput("\r");
    // Wait for async execution
    await Bun.sleep(10);
    expect(lastIbCall).not.toBeNull();
    expect(lastIbCall!.args).toEqual(["kill", "agent-test", "--force"]);
    expect(lastIbCall!.cwd).toBe("/repos/test");
  });

  test("kill confirm dialog: Enter on default Cancel dismisses", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("x");
    expect((dashboard.dialog as any).focusedButton).toBe("cancel");
    dashboard.handleInput("\r");
    expect(dashboard.dialog).toBeNull();
    expect(lastIbCall).toBeNull();
  });

  test("kill confirm dialog: Tab cycles between buttons", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("x");
    expect((dashboard.dialog as any).focusedButton).toBe("cancel");
    dashboard.handleInput("\t");
    expect((dashboard.dialog as any).focusedButton).toBe("confirm");
    dashboard.handleInput("\t");
    expect((dashboard.dialog as any).focusedButton).toBe("cancel");
  });

  test("kill confirm dialog: Escape cancels", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("x");
    dashboard.handleInput("\x1b");
    expect(dashboard.dialog).toBeNull();
    expect(lastIbCall).toBeNull();
  });

  test("! key opens nuke confirm dialog", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("!");
    expect(dashboard.dialog).not.toBeNull();
    expect(dashboard.dialog!.type).toBe("confirm");
    expect((dashboard.dialog as any).prompt).toContain("FORCE KILL");
    expect((dashboard.dialog as any).confirmLabel).toBe("Nuke");
  });

  test("nuke confirm: Enter on Nuke button executes kill --force", async () => {
    setupDashboardWithAgent();
    dashboard.handleInput("!");
    // focusedButton defaults to "confirm" (Nuke), press Enter
    dashboard.handleInput("\r");
    await Bun.sleep(10);
    expect(lastIbCall!.args).toEqual(["kill", "agent-test", "--force"]);
  });

  test("R key resumes stopped agents", async () => {
    setupDashboardWithAgent("stopped");
    dashboard.handleInput("R");
    await Bun.sleep(10);
    expect(lastIbCall!.args).toEqual(["resume", "agent-test"]);
  });

  test("R key does not resume running agents", async () => {
    setupDashboardWithAgent("running");
    dashboard.handleInput("R");
    await Bun.sleep(10);
    expect(lastIbCall).toBeNull();
    // Should show a notice in the header instead
    expect(dashboard.notice).not.toBeNull();
  });

  test("r key opens reassign input dialog", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("r");
    expect(dashboard.dialog!.type).toBe("input");
    expect((dashboard.dialog as any).prompt).toContain("Reassign");
  });

  test("reassign input: typing and submitting", async () => {
    setupDashboardWithAgent();
    dashboard.handleInput("r");
    // Type "agent-new"
    for (const ch of "agent-new") {
      dashboard.handleInput(ch);
    }
    expect((dashboard.dialog as any).value).toBe("agent-new");
    // Submit
    dashboard.handleInput("\r");
    await Bun.sleep(10);
    expect(lastIbCall!.args).toEqual(["reassign", "agent-test", "agent-new"]);
  });

  test("reassign input: empty submit cancels", async () => {
    setupDashboardWithAgent();
    dashboard.handleInput("r");
    dashboard.handleInput("\r");
    await Bun.sleep(10);
    expect(lastIbCall).toBeNull();
  });

  test("s key opens send textarea dialog", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("s");
    expect(dashboard.dialog!.type).toBe("textarea");
    expect((dashboard.dialog as any).prompt).toContain("Send message");
  });

  test("send textarea: typing, backspace, and submitting", async () => {
    setupDashboardWithAgent();
    dashboard.handleInput("s");
    for (const ch of "hellx") dashboard.handleInput(ch);
    dashboard.handleInput("\x7f"); // backspace
    for (const ch of "o") dashboard.handleInput(ch);
    expect((dashboard.dialog as any).lines.join("\n")).toBe("hello");
    // Tab to cancel, then tab to send button, then Enter to submit
    dashboard.handleInput("\t");
    dashboard.handleInput("\t");
    dashboard.handleInput("\r");
    await Bun.sleep(10);
    expect(lastIbCall!.args).toEqual(["send", "agent-test", "hello"]);
  });

  test("send textarea: Tab cycles forward through text → cancel → send → text", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("s");
    expect((dashboard.dialog as any).focusedButton).toBe("text");
    dashboard.handleInput("\t");
    expect((dashboard.dialog as any).focusedButton).toBe("cancel");
    dashboard.handleInput("\t");
    expect((dashboard.dialog as any).focusedButton).toBe("send");
    dashboard.handleInput("\t");
    expect((dashboard.dialog as any).focusedButton).toBe("text");
  });

  test("send textarea: Shift+Tab cycles backward through text → send → cancel → text", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("s");
    expect((dashboard.dialog as any).focusedButton).toBe("text");
    // Legacy Shift+Tab sequence
    dashboard.handleInput("\x1b[Z");
    expect((dashboard.dialog as any).focusedButton).toBe("send");
    dashboard.handleInput("\x1b[Z");
    expect((dashboard.dialog as any).focusedButton).toBe("cancel");
    dashboard.handleInput("\x1b[Z");
    expect((dashboard.dialog as any).focusedButton).toBe("text");
  });

  test("send textarea: Kitty protocol Shift+Tab cycles backward", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("s");
    expect((dashboard.dialog as any).focusedButton).toBe("text");
    // Kitty protocol Shift+Tab: CSI 9;2u (tab=9, shift modifier=2)
    dashboard.handleInput("\x1b[9;2u");
    expect((dashboard.dialog as any).focusedButton).toBe("send");
    dashboard.handleInput("\x1b[9;2u");
    expect((dashboard.dialog as any).focusedButton).toBe("cancel");
    dashboard.handleInput("\x1b[9;2u");
    expect((dashboard.dialog as any).focusedButton).toBe("text");
  });

  test("m key runs merge-check then shows confirm", async () => {
    setupDashboardWithAgent();
    dashboard.handleInput("m");
    // Wait for merge-check to complete
    await Bun.sleep(50);
    expect(dashboard.dialog!.type).toBe("confirm");
    expect((dashboard.dialog as any).prompt).toContain("Merge agent-test");
  });

  test("merge: merge-check failure shows error message", async () => {
    setupDashboardWithAgent();
    setRunner(async () => ({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "not ready",
    }));
    dashboard.handleInput("m");
    await Bun.sleep(50);
    expect(dashboard.notice).toContain("Merge-check failed");
  });

  test("dialog intercepts all input when active", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("x"); // opens confirm
    // Navigation keys should not change selection
    dashboard.handleInput("j");
    expect(dashboard.dialog).not.toBeNull(); // dialog still open
    expect(dashboard.dialog!.type).toBe("confirm");
  });

  test("no dialog without selected agent", () => {
    dashboard = new DashboardComponent();
    setRunner(async (args, cwd) => {
      lastIbCall = { args, cwd };
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });
    lastIbCall = null;
    // No agents loaded, so no agent selected
    dashboard.handleInput("x");
    expect(dashboard.dialog).toBeNull();
  });

  test("a key with single repo skips repo select, goes straight to prompt", () => {
    dashboard = new DashboardComponent();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);
    lastIbCall = null;

    dashboard.handleInput("a");
    // Should be input dialog (prompt), not select dialog (repo)
    expect(dashboard.dialog!.type).toBe("input");
    expect((dashboard.dialog as any).prompt).toContain("only-repo");
  });

  test("a key with multiple repos shows repo select first", () => {
    dashboard = new DashboardComponent();
    dashboard.setRepos([
      { path: "/repos/one", name: "repo-one" },
      { path: "/repos/two", name: "repo-two" },
    ]);
    lastIbCall = null;

    dashboard.handleInput("a");
    expect(dashboard.dialog!.type).toBe("select");
    expect((dashboard.dialog as any).prompt).toContain("Select repo");
  });

  test("new-agent flag options: Worker sets worker flag", async () => {
    dashboard = new DashboardComponent();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);
    lastIbCall = null;
    setRunner(async (args, cwd) => {
      lastIbCall = { args, cwd };
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
    });

    dashboard.handleInput("a");
    // Type prompt
    for (const ch of "do stuff") dashboard.handleInput(ch);
    dashboard.handleInput("\r");
    // Flag select: pick "Worker (--worker)" (index 1)
    expect(dashboard.dialog!.type).toBe("select");
    dashboard.handleInput("j"); // move to index 1
    dashboard.handleInput("\r");
    await Bun.sleep(10);
    expect(lastIbCall!.args).toEqual(["new-agent", "--worker", "do stuff"]);
  });

  test("new-agent flag options: Manager + YOLO sets yolo flag", async () => {
    dashboard = new DashboardComponent();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);
    lastIbCall = null;
    setRunner(async (args, cwd) => {
      lastIbCall = { args, cwd };
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
    });

    dashboard.handleInput("a");
    for (const ch of "do stuff") dashboard.handleInput(ch);
    dashboard.handleInput("\r");
    // Pick "Manager + YOLO (--yolo)" (index 2)
    dashboard.handleInput("j");
    dashboard.handleInput("j");
    dashboard.handleInput("\r");
    await Bun.sleep(10);
    expect(lastIbCall!.args).toEqual(["new-agent", "--yolo", "do stuff"]);
  });

  test("new-agent flag options: Worker + YOLO sets both flags", async () => {
    dashboard = new DashboardComponent();
    dashboard.setRepos([{ path: "/repos/only", name: "only-repo" }]);
    lastIbCall = null;
    setRunner(async (args, cwd) => {
      lastIbCall = { args, cwd };
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
    });

    dashboard.handleInput("a");
    for (const ch of "do stuff") dashboard.handleInput(ch);
    dashboard.handleInput("\r");
    // Pick "Worker + YOLO (--worker --yolo)" (index 3)
    dashboard.handleInput("j");
    dashboard.handleInput("j");
    dashboard.handleInput("j");
    dashboard.handleInput("\r");
    await Bun.sleep(10);
    expect(lastIbCall!.args).toEqual(["new-agent", "--worker", "--yolo", "do stuff"]);
  });

  test("A key toggles archived agents", () => {
    dashboard = new DashboardComponent();
    const agent1 = makeAgent("agent-active", "/repos/test");
    const agent2 = makeAgent("agent-old", "/repos/test", true);
    const flatList: FlatAgent[] = [
      { agent: agent1, depth: 0, connector: "├── " },
      { agent: agent2, depth: 0, connector: "└── " },
    ];
    dashboard.onUpdate([agent1, agent2], flatList, []);
    // Initially archived agents are hidden
    dashboard.handleInput("A");
    // After toggle, archived agents should be visible (we just verify no crash)
    dashboard.handleInput("A");
    // Toggle back
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

  function setupDashboard(state = "running") {
    dashboard = new DashboardComponent();
    lastIbCall = null;
    setRunner(async (args, cwd) => {
      lastIbCall = { args, cwd };
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
    });

    const agent = makeAgent("agent-test", "/repos/test");
    agent.state = state as any;
    const flatList: FlatAgent[] = [{ agent, depth: 0, connector: "" }];
    dashboard.onUpdate([agent], flatList, []);
  }

  afterEach(() => {
    resetRunner();
  });

  test("addError adds timestamped error to errors list", () => {
    dashboard = new DashboardComponent();
    dashboard.addError("Something went wrong");
    expect(dashboard.errors.length).toBe(1);
    expect(dashboard.errors[0]).toContain("Something went wrong");
  });

  test("clearErrors removes all errors", () => {
    dashboard = new DashboardComponent();
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

  test("t key cycles denials filter only in DENIALS mode", () => {
    setupDashboard();
    expect(dashboard.denialFilter).toBe("all");
    // t outside DENIALS does nothing
    dashboard.handleInput("t");
    expect(dashboard.denialFilter).toBe("all");
    // Cycle to DENIALS mode (mode index 2)
    dashboard.handleInput("p"); // 0→1
    dashboard.handleInput("p"); // 1→2 (DENIALS)
    expect(dashboard.currentMode).toBe("DENIALS");
    dashboard.handleInput("t"); // cycle filter: all → 24h
    expect(dashboard.denialFilter).toBe("24h");
    dashboard.handleInput("t"); // 24h → 7d
    expect(dashboard.denialFilter).toBe("7d");
    dashboard.handleInput("t"); // 7d → all
    expect(dashboard.denialFilter).toBe("all");
  });

  test("d key triggers diff loading and jumps to DIFF mode", async () => {
    setupDashboard();
    let diffCalled = false;
    setRunner(async (args, cwd) => {
      if (args[0] === "diff") diffCalled = true;
      return { ok: true, exitCode: 0, stdout: "diff output", stderr: "" };
    });
    dashboard.handleInput("d");
    expect(dashboard.currentMode).toBe("DIFF");
    await Bun.sleep(50);
    expect(diffCalled).toBe(true);
  });

  test("g key jumps to STATUS mode", () => {
    setupDashboard();
    expect(dashboard.currentMode).toBe("AGENT LOG");
    dashboard.handleInput("g");
    expect(dashboard.currentMode).toBe("STATUS");
  });

  test("g key in QUESTIONS mode navigates to agent and switches mode", () => {
    dashboard = new DashboardComponent();
    setRunner(async (args, cwd) => {
      lastIbCall = { args, cwd };
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });

    const agent1 = makeAgent("agent-a", "/repos/test");
    const agent2 = makeAgent("agent-b", "/repos/test");
    const flatList: FlatAgent[] = [
      { agent: agent1, depth: 0, connector: "├── " },
      { agent: agent2, depth: 0, connector: "└── " },
    ];
    const questions: PendingQuestion[] = [{
      id: "q-1",
      agent: "agent-b",
      question: "Should I proceed?",
      timestamp: "2026-03-05T15:00:00Z",
      status: "pending",
    }];
    dashboard.onUpdate([agent1, agent2], flatList, questions);

    // Start with agent-a selected
    expect(dashboard.selectedAgent?.id).toBe("agent-a");
    // Jump to QUESTIONS
    dashboard.handleInput("q");
    expect(dashboard.currentMode).toBe("QUESTIONS");
    // Press g to go to agent-b (the question's agent)
    dashboard.handleInput("g");
    // Should navigate to agent-b and switch mode
    expect(dashboard.selectedAgent?.id).toBe("agent-b");
    expect(dashboard.currentMode).toBe("AGENT LOG");
  });

  test("Enter in QUESTIONS mode opens answer dialog", () => {
    dashboard = new DashboardComponent();
    setRunner(async (args, cwd) => {
      lastIbCall = { args, cwd };
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });

    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatAgent[] = [{ agent, depth: 0, connector: "" }];
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
    expect(dashboard.dialog!.type).toBe("textarea");
    expect((dashboard.dialog as any).prompt).toContain("Answer");
  });

  test("answer question sends acknowledge then message", async () => {
    dashboard = new DashboardComponent();
    const calls: string[][] = [];
    setRunner(async (args, cwd) => {
      calls.push(args);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });

    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatAgent[] = [{ agent, depth: 0, connector: "" }];
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
    await Bun.sleep(50);

    // Should have called acknowledge then send
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toEqual(["acknowledge", "q-1"]);
    expect(calls[1]).toEqual(["send", "agent-test", "yes"]);
  });

  test("Escape in QUESTIONS mode acknowledges question", async () => {
    dashboard = new DashboardComponent();
    const calls: string[][] = [];
    setRunner(async (args, cwd) => {
      calls.push(args);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });

    const agent = makeAgent("agent-test", "/repos/test");
    const flatList: FlatAgent[] = [{ agent, depth: 0, connector: "" }];
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
    await Bun.sleep(50);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toEqual(["acknowledge", "q-1"]);
  });

  test("j/k navigate questions in QUESTIONS mode", () => {
    dashboard = new DashboardComponent();
    const agent1 = makeAgent("agent-a", "/repos/test");
    const agent2 = makeAgent("agent-b", "/repos/test");
    const flatList: FlatAgent[] = [
      { agent: agent1, depth: 0, connector: "├── " },
      { agent: agent2, depth: 0, connector: "└── " },
    ];
    const questions: PendingQuestion[] = [
      { id: "q-1", agent: "agent-a", question: "Q1?", timestamp: "2026-03-05T15:00:00Z", status: "pending" },
      { id: "q-2", agent: "agent-b", question: "Q2?", timestamp: "2026-03-05T15:01:00Z", status: "pending" },
    ];
    dashboard.onUpdate([agent1, agent2], flatList, questions);

    dashboard.handleInput("q"); // QUESTIONS mode
    expect(dashboard.questionsSelectedIndex).toBe(0);
    dashboard.handleInput("j"); // move down
    expect(dashboard.questionsSelectedIndex).toBe(1);
    dashboard.handleInput("k"); // move back up
    expect(dashboard.questionsSelectedIndex).toBe(0);
    // j/k should not change agent tree selection in QUESTIONS mode
    expect(dashboard.selectedAgent?.id).toBe("agent-a");
  });

  test("j/k in QUESTIONS mode clamps to bounds", () => {
    dashboard = new DashboardComponent();
    const agent = makeAgent("agent-a", "/repos/test");
    const flatList: FlatAgent[] = [{ agent, depth: 0, connector: "" }];
    const questions: PendingQuestion[] = [
      { id: "q-1", agent: "agent-a", question: "Q1?", timestamp: "2026-03-05T15:00:00Z", status: "pending" },
    ];
    dashboard.onUpdate([agent], flatList, questions);

    dashboard.handleInput("q");
    expect(dashboard.questionsSelectedIndex).toBe(0);
    dashboard.handleInput("j"); // try to go past end
    expect(dashboard.questionsSelectedIndex).toBe(0); // clamped
    dashboard.handleInput("k"); // try to go before start
    expect(dashboard.questionsSelectedIndex).toBe(0); // clamped
  });

  test("selectAgentById via g in QUESTIONS navigates correctly", () => {
    dashboard = new DashboardComponent();
    const agent1 = makeAgent("agent-a", "/repos/test");
    const agent2 = makeAgent("agent-b", "/repos/test");
    const flatList: FlatAgent[] = [
      { agent: agent1, depth: 0, connector: "├── " },
      { agent: agent2, depth: 0, connector: "└── " },
    ];
    const questions: PendingQuestion[] = [{
      id: "q-1",
      agent: "agent-b",
      question: "test?",
      timestamp: "2026-03-05T15:00:00Z",
      status: "pending",
    }];
    dashboard.onUpdate([agent1, agent2], flatList, questions);

    expect(dashboard.selectedAgent?.id).toBe("agent-a");
    dashboard.handleInput("q"); // QUESTIONS mode
    dashboard.handleInput("g"); // go to agent-b
    expect(dashboard.selectedAgent?.id).toBe("agent-b");
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
        session_id: "sess-1",
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
});

describe("AgentTreeComponent scroll indicators", () => {
  /** Build a tree component with N fake agents and the given maxHeight/scrollOffset. */
  function makeTree(agentCount: number, maxHeight: number, scrollOffset: number): AgentTreeComponent {
    const tree = new AgentTreeComponent();
    tree.maxHeight = maxHeight;
    const flatList: FlatAgent[] = Array.from({ length: agentCount }, (_, i) => ({
      agent: makeAgent(`agent-${i}`, "/repos/test"),
      depth: 0,
      connector: "",
    }));
    tree.setFlatList(flatList);
    // Override scrollOffset (private) via type assertion for testing
    (tree as any).scrollOffset = scrollOffset;
    return tree;
  }

  /** Strip ANSI escape codes for plain-text assertions. */
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, "");
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

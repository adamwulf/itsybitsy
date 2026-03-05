import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { readAgentLog } from "../agents";
import type { Agent, AgentMeta, FlatAgent } from "../agents";
import { TmuxPaneComponent, RightPaneComponent, DashboardComponent } from "./dashboard";
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

  test("scrollOffset=0 shows content from start", () => {
    const pane = makeRightPane(20, 10);
    pane.scrollOffset = 0;
    const result = pane.render(80);

    expect(result.length).toBe(10);
    // First line is the header
    expect(result[0]).toContain("INITIAL PROMPT");
    // Content starts with "Prompt:" header then blank line then first prompt line
    expect(result[1]).toContain("Prompt:");
    expect(result[2]).toBe("");
    expect(result[3]).toContain("prompt line 1");
  });

  test("scrollOffset clamped to maxOffset", () => {
    const pane = makeRightPane(20, 10);
    // Content is: "Prompt:" + empty line + 20 prompt lines = 22 lines
    // available = displayHeight - 1 = 9
    // maxOffset = max(0, 22 - 9) = 13
    pane.scrollOffset = 999;
    pane.render(80);

    expect(pane.scrollOffset).toBe(13);
  });

  test("content sliced from scrollOffset", () => {
    const pane = makeRightPane(20, 10);
    pane.scrollOffset = 5;
    const result = pane.render(80);

    expect(result.length).toBe(10);
    // Header is always first
    expect(result[0]).toContain("INITIAL PROMPT");
    // Content starts at offset 5: "Prompt:", "", "line1", "line2", "line3" skipped
    // So next is "prompt line 4"
    expect(result[1]).toContain("prompt line 4");
  });

  test("pads to displayHeight when content is short", () => {
    const pane = makeRightPane(2, 10);
    pane.scrollOffset = 0;
    const result = pane.render(80);

    expect(result.length).toBe(10);
    // Header + "Prompt:" + "" + 2 prompt lines = 4 content lines after header
    expect(result[0]).toContain("INITIAL PROMPT");
    expect(result[1]).toContain("Prompt:");
    expect(result[3]).toContain("prompt line 1");
    expect(result[4]).toContain("prompt line 2");
    // Remaining lines should be empty padding
    for (let i = 5; i < 10; i++) {
      expect(result[i]).toBe("");
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
    const flatList: FlatAgent[] = [{ agent, depth: 0 }];
    dashboard.onUpdate([agent], flatList, []);
  }

  afterEach(() => {
    resetRunner();
  });

  test("x key opens kill confirm dialog", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("x");
    expect(dashboard.dialog).not.toBeNull();
    expect(dashboard.dialog!.type).toBe("confirm");
    expect((dashboard.dialog as any).prompt).toContain("Kill agent");
    expect((dashboard.dialog as any).prompt).toContain("agent-test");
  });

  test("kill confirm dialog: y executes kill", async () => {
    setupDashboardWithAgent();
    dashboard.handleInput("x");
    dashboard.handleInput("y");
    // Wait for async execution
    await Bun.sleep(10);
    expect(lastIbCall).not.toBeNull();
    expect(lastIbCall!.args).toEqual(["kill", "agent-test"]);
    expect(lastIbCall!.cwd).toBe("/repos/test");
  });

  test("kill confirm dialog: n cancels", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("x");
    dashboard.handleInput("n");
    expect(dashboard.dialog).toBeNull();
    expect(lastIbCall).toBeNull();
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
  });

  test("nuke confirm: y executes kill --force", async () => {
    setupDashboardWithAgent();
    dashboard.handleInput("!");
    dashboard.handleInput("y");
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
    // Should show a message instead
    expect(dashboard.dialog).not.toBeNull();
    expect(dashboard.dialog!.type).toBe("message");
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

  test("s key opens send input dialog", () => {
    setupDashboardWithAgent();
    dashboard.handleInput("s");
    expect(dashboard.dialog!.type).toBe("input");
    expect((dashboard.dialog as any).prompt).toContain("Send message");
  });

  test("send input: typing, backspace, and submitting", async () => {
    setupDashboardWithAgent();
    dashboard.handleInput("s");
    for (const ch of "hellx") dashboard.handleInput(ch);
    dashboard.handleInput("\x7f"); // backspace
    for (const ch of "o") dashboard.handleInput(ch);
    expect((dashboard.dialog as any).value).toBe("hello");
    dashboard.handleInput("\r");
    await Bun.sleep(10);
    expect(lastIbCall!.args).toEqual(["send", "agent-test", "hello"]);
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
    expect(dashboard.dialog!.type).toBe("message");
    expect((dashboard.dialog as any).text).toContain("Merge-check failed");
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
      { agent: agent1, depth: 0 },
      { agent: agent2, depth: 0 },
    ];
    dashboard.onUpdate([agent1, agent2], flatList, []);
    // Initially archived agents are hidden
    dashboard.handleInput("A");
    // After toggle, archived agents should be visible (we just verify no crash)
    dashboard.handleInput("A");
    // Toggle back
  });
});

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { readAgentLog } from "../agents";
import type { Agent, AgentMeta } from "../agents";
import { TmuxPaneComponent, RightPaneComponent } from "./dashboard";

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
    // Use INITIAL PROMPT mode and set a long prompt to generate content
    pane.agent!.meta.prompt = Array.from({ length: contentLines }, (_, i) => `prompt line ${i + 1}`).join("\n");
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

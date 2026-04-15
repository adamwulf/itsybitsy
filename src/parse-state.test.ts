import { test, expect, describe } from "bun:test";
import { parseState, stripAnsi, STARTUP_MARKERS } from "./parse-state";

describe("STARTUP_MARKERS", () => {
  test("has exactly 4 markers", () => {
    expect(STARTUP_MARKERS.length).toBe(4);
  });
  test("contains 'Claude Code v'", () => {
    expect(STARTUP_MARKERS).toContain("Claude Code v");
  });
  test("contains '[USER TASK]'", () => {
    expect(STARTUP_MARKERS).toContain("[USER TASK]");
  });
  test("contains '╭─ Claude Code'", () => {
    expect(STARTUP_MARKERS).toContain("╭─ Claude Code");
  });
  test("contains '[AGENT CONTEXT]'", () => {
    expect(STARTUP_MARKERS).toContain("[AGENT CONTEXT]");
  });
});

describe("stripAnsi", () => {
  test("strips color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });
  test("strips OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });
  test("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

describe("parseState", () => {
  test("empty input → unknown", () => {
    expect(parseState("")).toEqual({ state: "unknown", reason: "empty input" });
    expect(parseState("   ")).toEqual({ state: "unknown", reason: "empty input" });
  });

  describe("creating", () => {
    test("workspace trust prompt (old format)", () => {
      const input = "Do you trust the files in this folder?\nEnter to confirm";
      expect(parseState(input).state).toBe("creating");
    });
    test("workspace trust prompt (new format)", () => {
      const input = "I trust this folder\nEnter to confirm";
      expect(parseState(input).state).toBe("creating");
    });
    test("external imports prompt", () => {
      const input = "Allow external CLAUDE.md file imports?\nEnter to confirm";
      expect(parseState(input).state).toBe("creating");
    });
    test("MCP server prompt", () => {
      const input = "New MCP server found in .mcp.json: activepieces\n\nMCP servers may execute code or access system resources.\n\n❯ 1. Use this and all future MCP servers\n  2. Use this MCP server\n  3. Continue without using\n\nEnter to confirm · Esc to cancel";
      expect(parseState(input).state).toBe("creating");
    });
    test("NOT creating at top if Claude Code v is present (falls through to later check)", () => {
      // The first creating check skips if "Claude Code v" is in full input,
      // but the second check (in last 15 lines) still catches it as creating
      const input = "Claude Code v1.0\nDo you trust the files\nEnter to confirm\nsome other text";
      expect(parseState(input).state).toBe("creating");
    });
    test("NOT creating at top if [USER TASK] is present (falls through to later check)", () => {
      const input = "[USER TASK]\nDo you trust the files\nEnter to confirm";
      expect(parseState(input).state).toBe("creating");
    });
    test("permission prompt in last 15 lines after Claude started", () => {
      // Claude has started (has Claude Code v), but permission prompt appears in recent lines
      const lines = Array(10).fill("some output");
      lines.push("Claude Code v1.0");
      lines.push("Do you trust the files");
      lines.push("Enter to confirm");
      const input = lines.join("\n");
      expect(parseState(input).state).toBe("creating");
    });
    test("MCP server prompt in last 15 lines after Claude started", () => {
      const lines = Array(10).fill("some output");
      lines.push("Claude Code v1.0");
      lines.push("New MCP server found in .mcp.json: activepieces");
      lines.push("Enter to confirm");
      const input = lines.join("\n");
      expect(parseState(input).state).toBe("creating");
    });
  });

  describe("compacting", () => {
    test("Compacting conversation in last 5 lines", () => {
      const input = "line1\nline2\nline3\nCompacting conversation\nline5";
      expect(parseState(input).state).toBe("compacting");
    });
    test("compacting takes priority over running indicators", () => {
      const input = "line1\n(Esc to interrupt)\nCompacting conversation\nline4\nline5";
      expect(parseState(input).state).toBe("compacting");
    });
  });

  describe("waiting", () => {
    test("tool waiting (⎿ Waiting)", () => {
      const input = "line1\nline2\n⎿  Waiting\nline4\nline5";
      expect(parseState(input).state).toBe("waiting");
    });
    test("WAITING on its own line", () => {
      const input = "some output\n  WAITING\n";
      expect(parseState(input).state).toBe("waiting");
    });
    test("⏺ WAITING format", () => {
      const input = "some output\n⏺ WAITING\n";
      expect(parseState(input).state).toBe("waiting");
    });
    test("stale WAITING — ⏺ after WAITING means running", () => {
      const input = "some output\n  WAITING\n⏺ Some new output";
      expect(parseState(input).state).toBe("running");
      expect(parseState(input).reason).toContain("stale WAITING");
    });
  });

  describe("running", () => {
    test("(Esc to interrupt) in last 5 lines", () => {
      const input = "line1\nline2\nline3\n(Esc to interrupt)\nline5";
      expect(parseState(input).state).toBe("running");
    });
    test("(esc to interrupt) lowercase", () => {
      const input = "line1\nline2\nline3\n(esc to interrupt)\nline5";
      expect(parseState(input).state).toBe("running");
    });
    test("(ctrl+c to interrupt)", () => {
      const input = "line1\nline2\nline3\n(ctrl+c to interrupt)\nline5";
      expect(parseState(input).state).toBe("running");
    });
    test("⎿  Running indicator", () => {
      const input = "line1\nline2\nline3\n⎿  Running something\nline5";
      expect(parseState(input).state).toBe("running");
    });
    test("modern format with extra content", () => {
      const input = "line1\nline2\nline3\n(Esc to interrupt · 31s · thought for 1s)\nline5";
      expect(parseState(input).state).toBe("running");
    });
    test("ctrl+b ctrl+b indicator", () => {
      const lines = Array(14).fill("line");
      lines.push("ctrl+b ctrl+b for tmux");
      expect(parseState(lines.join("\n")).state).toBe("running");
    });
    test("thinking) indicator", () => {
      const lines = Array(14).fill("line");
      lines.push("some thinking)");
      expect(parseState(lines.join("\n")).state).toBe("running");
    });
    test("active spinner with interrupt marker", () => {
      const lines = Array(13).fill("line");
      lines.push("✽ Processing… (Esc to interrupt)");
      lines.push("more");
      expect(parseState(lines.join("\n")).state).toBe("running");
    });
    test("active spinner with token transfer arrows", () => {
      const lines = Array(13).fill("line");
      lines.push("· Smooshing… (6m 14s · ↑ 16.7k tokens)");
      lines.push("more");
      expect(parseState(lines.join("\n")).state).toBe("running");
    });
    test("active spinner (not completion timer)", () => {
      const lines = Array(13).fill("line");
      lines.push("✽ Processing something");
      lines.push("more");
      expect(parseState(lines.join("\n")).state).toBe("running");
    });
    test("completion timer spinner is NOT running", () => {
      // "✻ Cogitated for 4m 4s" = completion timer, not running
      const lines = Array(13).fill("line");
      lines.push("✻ Cogitated for 4m 4s");
      lines.push("more");
      const result = parseState(lines.join("\n"));
      expect(result.state).not.toBe("running");
    });
    test("thought for spinner is NOT running", () => {
      const lines = Array(13).fill("line");
      lines.push("· Photosynthesizing… (10m 57s · thought for 254s)");
      lines.push("more");
      const result = parseState(lines.join("\n"));
      expect(result.state).not.toBe("running");
    });
    test("hook spinners are filtered out", () => {
      const lines = Array(13).fill("line");
      lines.push("✽ running stop hook");
      lines.push("more");
      const result = parseState(lines.join("\n"));
      expect(result.state).not.toBe("running");
    });
    test("broader 20-line window catches active spinners", () => {
      const lines = Array(16).fill("queued message");
      // Put spinner beyond 15-line window but within 20
      lines[2] = "✽ Processing… (Esc to interrupt)";
      lines.push("more");
      lines.push("more");
      lines.push("more");
      expect(parseState(lines.join("\n")).state).toBe("running");
    });
    test("background tasks in status bar", () => {
      const lines = Array(14).fill("line");
      lines.push("⏵⏵ accept edits on · 2 bashes");
      expect(parseState(lines.join("\n")).state).toBe("running");
    });
  });

  describe("rate_limited", () => {
    test("rate_limit_error", () => {
      const lines = Array(14).fill("line");
      lines.push('Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}');
      expect(parseState(lines.join("\n")).state).toBe("rate_limited");
    });
    test("usage limit reached (case insensitive)", () => {
      const lines = Array(14).fill("line");
      lines.push("Claude Usage Limit Reached. Your limit will reset at 3pm");
      expect(parseState(lines.join("\n")).state).toBe("rate_limited");
    });
    test("hit your limit", () => {
      const lines = Array(14).fill("line");
      lines.push("You've hit your limit · resets 1am");
      expect(parseState(lines.join("\n")).state).toBe("rate_limited");
    });
  });

  describe("complete", () => {
    test("I HAVE COMPLETED THE GOAL", () => {
      const lines = Array(10).fill("line");
      lines.push("I HAVE COMPLETED THE GOAL");
      expect(parseState(lines.join("\n")).state).toBe("complete");
    });
    test("quoted occurrence is excluded", () => {
      const lines = Array(10).fill("line");
      lines.push("Signal 'I HAVE COMPLETED THE GOAL' when done");
      // Only quoted version, no actual signal
      expect(parseState(lines.join("\n")).state).not.toBe("complete");
    });
    test("both quoted and unquoted — unquoted wins", () => {
      const lines = Array(10).fill("line");
      lines.push("Signal 'I HAVE COMPLETED THE GOAL' when done");
      lines.push("I HAVE COMPLETED THE GOAL");
      expect(parseState(lines.join("\n")).state).toBe("complete");
    });
  });

  describe("race condition", () => {
    test("stop hook without output = creating", () => {
      const lines = Array(14).fill("line");
      lines.push("running stop hook");
      // No ⏺ in last 15 lines
      const input = lines.join("\n");
      expect(parseState(input).state).toBe("creating");
    });
    test("stop hook WITH output = not creating", () => {
      const lines = Array(13).fill("line");
      lines.push("⏺ Some output");
      lines.push("running stop hook");
      const input = lines.join("\n");
      // Has ⏺, so not the race condition
      expect(parseState(input).state).not.toBe("creating");
    });
  });

  describe("trailing blank lines", () => {
    test("WAITING detected despite trailing blank lines pushing it out of last-15 window", () => {
      // Simulate real tmux output: agent content ending with WAITING,
      // followed by many trailing blank lines (terminal height padding).
      // Without stripping, the blanks push WAITING out of the last-15 window.
      const content = Array(10).fill("some agent output");
      content.push("⏺ WAITING");
      // Trailing blank lines from terminal padding
      for (let i = 0; i < 30; i++) {
        content.push("");
      }
      const input = content.join("\n");
      const result = parseState(input);
      expect(result.state).toBe("waiting");
      expect(result.reason).toContain("WAITING");
    });

    test("WAITING with status bar and trailing blanks is detected", () => {
      // More realistic: content + status bar + terminal padding
      const content = Array(5).fill("some agent output");
      content.push("⏺ WAITING");
      // Claude Code status bar (~8 lines)
      content.push("─────────────────────────────────────");
      content.push("❯ ");
      content.push("─────────────────────────────────────");
      content.push("/Users/user/repo");
      content.push("agent-abc12345");
      content.push("ctx: 45% ····················");
      content.push("⏵⏵ accept edits on (shift+tab to cycle)");
      content.push("");
      // Terminal height padding
      for (let i = 0; i < 30; i++) {
        content.push("");
      }
      const input = content.join("\n");
      const result = parseState(input);
      // WAITING should be in the last-15 window (6 content + 8 status bar = 14 lines)
      expect(result.state).toBe("waiting");
    });

    test("WAITING with trailing whitespace-only lines is still detected", () => {
      const lines = Array(5).fill("output");
      lines.push("WAITING");
      // Add whitespace-only trailing lines
      lines.push("   ");
      lines.push("\t");
      lines.push("  \t  ");
      for (let i = 0; i < 20; i++) {
        lines.push("");
      }
      expect(parseState(lines.join("\n")).state).toBe("waiting");
    });

    test("blank lines within content are preserved (not stripped)", () => {
      // Ensure internal blank lines don't get stripped
      const lines = [
        "line1",
        "",
        "line3",
        "",
        "⎿  Waiting",
        "",
        "line7",
        "line8",
        "line9",
      ];
      expect(parseState(lines.join("\n")).state).toBe("waiting");
    });
  });

  describe("idle at prompt", () => {
    test("bare ❯ prompt with status bar → waiting", () => {
      const lines = Array(10).fill("some output");
      lines.push("────────────────────────────────────");
      lines.push("❯ ");
      lines.push("────────────────────────────────────");
      lines.push("  repo | Model: Son...");
      lines.push("⏵⏵ accept edits on (shift+tab to cycle)");
      expect(parseState(lines.join("\n")).state).toBe("waiting");
      expect(parseState(lines.join("\n")).reason).toContain("idle at input prompt");
    });

    test("❯ with text after it is NOT idle prompt", () => {
      const lines = Array(10).fill("some output");
      lines.push("❯ what does HDA mean");
      lines.push("────────────────────────────────────");
      lines.push("⏵⏵ accept edits on (shift+tab to cycle)");
      expect(parseState(lines.join("\n")).state).not.toBe("waiting");
    });

    test("bare ❯ without status bar is not detected as idle", () => {
      const lines = Array(10).fill("some output");
      lines.push("❯ ");
      lines.push("some other text");
      expect(parseState(lines.join("\n")).state).toBe("unknown");
    });

    test("fixture snapshot-idle-prompt-1 → waiting", async () => {
      const fixture = await Bun.file(
        new URL("fixtures/snapshot-idle-prompt-1.txt", import.meta.url),
      ).text();
      const result = parseState(fixture);
      expect(result.state).toBe("waiting");
    });

    test("fixture snapshot-idle-prompt-2 → waiting", async () => {
      const fixture = await Bun.file(
        new URL("fixtures/snapshot-idle-prompt-2.txt", import.meta.url),
      ).text();
      const result = parseState(fixture);
      expect(result.state).toBe("waiting");
    });
  });

  describe("priority", () => {
    test("compacting beats running", () => {
      const input = "line1\n(Esc to interrupt)\nCompacting conversation\nline4\nline5";
      expect(parseState(input).state).toBe("compacting");
    });
    test("running in last 5 beats tool waiting in last 15", () => {
      // Order: compacting (5) → running (5) → tool waiting (15)
      // Active running in last 5 takes priority over stale tool waiting
      const lines = Array(10).fill("line");
      lines.push("⎿  Waiting");
      lines.push("(Esc to interrupt)");
      lines.push("line");
      lines.push("line");
      lines.push("line");
      expect(parseState(lines.join("\n")).state).toBe("running");
    });
    test("tool waiting wins when no running indicator in last 5", () => {
      const lines = Array(10).fill("line");
      lines.push("⎿  Waiting");
      lines.push("line");
      lines.push("line");
      lines.push("line");
      lines.push("line");
      expect(parseState(lines.join("\n")).state).toBe("waiting");
    });
    test("active running in last 5 beats WAITING further up", () => {
      const lines = Array(8).fill("line");
      lines.push("WAITING");
      lines.push("line");
      lines.push("line");
      lines.push("line");
      lines.push("(Esc to interrupt)");
      lines.push("line");
      lines.push("line");
      // WAITING is in last 15 but (Esc to interrupt) is in last 5
      // Running check in last 5 comes before WAITING check in last 15
      expect(parseState(lines.join("\n")).state).toBe("running");
    });
  });
});

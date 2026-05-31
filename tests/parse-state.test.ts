import { describe, test, expect } from "bun:test";
import { isCodexTmuxOutput, parseCodexState, parseState, parseStateForCli } from "../src/parse-state";

// Real codex tmux capture (Codex CLI v0.135.0, gpt-5.5) — abridged from
// /Users/adamwulf/Developer/muse/muse-ios/.ittybitty/agents/agent-2a4815af/debug-logs/
//   snapshot-2026-05-31T19-31-32-456Z-waiting.txt
// with the leading "State: ... Reason: ..." header line stripped (per the task).
// This is the load-bearing fixture: it MUST parse as `waiting`, not `unknown`.
const CODEX_IDLE_SNAPSHOT = `
⚠ \`--dangerously-bypass-hook-trust\` is enabled. Enabled hooks may run without review for this
  invocation.

╭──────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.135.0)                               │
│                                                          │
│ model:     gpt-5.5   /model to change                    │
│ directory: ~/Developer/muse/…/agents/agent-2a4815af/repo │
╰──────────────────────────────────────────────────────────╯

  Tip: New For a limited time, Codex is included in your plan for free – let's build together.


› Standby agent in muse-ios. Read the repo's CLAUDE.md and memory to understand the project,
  then await further instructions. Report your understanding of the codebase and set status to
  WAITING.


⚠ \`--dangerously-bypass-hook-trust\` is enabled. Enabled hooks may run without review for this
  invocation.

• SessionStart hook (completed)
  hook context:

• I'll inspect the repo guidance first, then check available memory files so I can summarize
  the project accurately before standing by.

• Ran pwd
  └ /Users/adamwulf/Developer/muse/muse-ios/.ittybitty/agents/agent-2a4815af/repo

• PreToolUse hook (blocked)
  feedback: Tool not in allow list

───────────────────────────────────────────────────────────────────────────────────────────────

• rg is blocked in this harness, so I'm falling back to simple single shell commands that stay
  within the allowed command set.

• Explored
  └ List ls
    Read CLAUDE.md

───────────────────────────────────────────────────────────────────────────────────────────────

• Read CLAUDE.md, global memory at /Users/adamwulf/.claude/CLAUDE.md, and repo overview docs.

  Understanding:

  - Muse is a Swift/UIKit visual thinking app for iPhone, iPad, and Mac Catalyst.

  WAITING

• Stop hook (failed)
  error: hook returned invalid stop hook JSON output

─ Worked for 1m 11s ───────────────────────────────────────────────────────────────────────────


› [sent by user Adam]: great work, thanks!


• Standing by for the next task.

  WAITING

• Stop hook (failed)
  error: hook returned invalid stop hook JSON output


› is it possible to turn off the example "Explain this codebase" in the prompt field?


• Probably not from inside this agent session. That placeholder/example text is usually
  controlled by the client UI, not by repo config or AGENTS.md/CLAUDE.md instructions.

  If this is the Codex prompt box, I don't know of a per-project setting to disable the example
  text. The practical options are likely client-side: a UI preference if the app exposes one,
  or changing the client code/config that renders the prompt field.

  WAITING

• Stop hook (failed)
  error: hook returned invalid stop hook JSON output


› Explain this codebase

  gpt-5.5 default · ~/Developer/muse/muse-ios/.ittybitty/agents/agent-2a4815af/repo
`;

// Synthetic minimal codex idle pane — banner + queued prompt + status bar.
const CODEX_MINIMAL_IDLE = `╭──────────────────────────────────────╮
│ >_ OpenAI Codex (v0.135.0)           │
│ model:     gpt-5.5                   │
│ directory: ~/some/path               │
╰──────────────────────────────────────╯

›

  gpt-5.5 default · /some/path
`;

const CODEX_WITH_COMPLETION = `╭──────────────────────────────────────╮
│ >_ OpenAI Codex (v0.135.0)           │
╰──────────────────────────────────────╯

• Looks good — pushing now.

  I HAVE COMPLETED THE GOAL

• Stop hook (completed)

  gpt-5.5 default · /some/path
`;

const CODEX_WITH_WAITING = `╭──────────────────────────────────────╮
│ >_ OpenAI Codex (v0.135.0)           │
╰──────────────────────────────────────╯

• Standing by for the next task.

  WAITING
`;

// Real-ish claude pane shape (uses ❯ + ⏵⏵ status bar). Should NOT be detected as codex.
const CLAUDE_IDLE = `╭─ Claude Code v1.0 ─╮
│ Some text here     │
╰────────────────────╯

❯

⏵⏵ accept edits on
`;

describe("isCodexTmuxOutput", () => {
  test("detects codex by banner header", () => {
    const input = `\n\n╭──────╮\n│ >_ OpenAI Codex (v0.135.0) │\n╰──────╯\n\nmore\n`;
    expect(isCodexTmuxOutput(input)).toBe(true);
  });

  test("detects codex by tail status bar even without banner", () => {
    // Long-running session where the banner has scrolled out — only the status bar remains.
    const input = `some earlier output line\n\n• Output\n\n› query\n\n  gpt-5.5 default · ~/repo/path\n`;
    expect(isCodexTmuxOutput(input)).toBe(true);
  });

  test("returns false for claude pane", () => {
    expect(isCodexTmuxOutput(CLAUDE_IDLE)).toBe(false);
  });

  test("returns false for empty input", () => {
    expect(isCodexTmuxOutput("")).toBe(false);
  });

  test("does not false-positive on prose that contains '·' but no path", () => {
    const input = `Some sentence with · a centered dot but no path here.\n`;
    expect(isCodexTmuxOutput(input)).toBe(false);
  });
});

describe("parseCodexState", () => {
  test("idle at codex prompt → waiting", () => {
    const r = parseCodexState(CODEX_MINIMAL_IDLE);
    expect(r.state).toBe("waiting");
  });

  test("real captured codex snapshot → waiting (not unknown)", () => {
    const r = parseCodexState(CODEX_IDLE_SNAPSHOT);
    expect(r.state).toBe("waiting");
  });

  test("long codex input prompt is parsed bottom-up from the last prompt", () => {
    const input = [
      "• Standing by.",
      "",
      "› " + "Explain this codebase in detail",
      ...Array.from({ length: 25 }, (_, i) => `  wrapped input ${i}`),
      "",
      "  gpt-5.5 default · /repo",
    ].join("\n");
    const r = parseCodexState(input);
    expect(r.state).toBe("waiting");
    expect(r.reason).toBe("idle at codex input prompt");
  });

  test("completion sentinel → complete", () => {
    const r = parseCodexState(CODEX_WITH_COMPLETION);
    expect(r.state).toBe("complete");
  });

  test("WAITING marker → waiting", () => {
    const r = parseCodexState(CODEX_WITH_WAITING);
    expect(r.state).toBe("waiting");
  });

  test("quoted 'I HAVE COMPLETED THE GOAL' does NOT trigger completion", () => {
    // Watchdog nudges quote the phrase in single quotes — those must not match.
    const input = `╭──────╮
│ >_ OpenAI Codex (v0.135.0) │
╰──────╯

› Reminder: say 'I HAVE COMPLETED THE GOAL' when you finish.

  gpt-5.5 default · /repo
`;
    const r = parseCodexState(input);
    expect(r.state).toBe("waiting");
  });

  test("empty input → unknown", () => {
    const r = parseCodexState("");
    expect(r.state).toBe("unknown");
  });

  test("no recognizable patterns → unknown", () => {
    const r = parseCodexState("just some random text\nwith no codex markers\n");
    expect(r.state).toBe("unknown");
  });
});

describe("parseState codex dispatch", () => {
  test("real codex snapshot routed through parseState → waiting (not unknown)", () => {
    // This is the bug the task is fixing: the real captured snapshot was previously
    // landing as `state: "unknown"` because every claude-shaped pattern fell through.
    const r = parseState(CODEX_IDLE_SNAPSHOT);
    expect(r.state).toBe("waiting");
  });

  test("minimal codex idle routed through parseState → waiting", () => {
    const r = parseState(CODEX_MINIMAL_IDLE);
    expect(r.state).toBe("waiting");
  });

  test("codex with completion routed through parseState → complete", () => {
    const r = parseState(CODEX_WITH_COMPLETION);
    expect(r.state).toBe("complete");
  });
});

describe("parseStateForCli", () => {
  test("uses explicit codex cli instead of detecting from tmux text", () => {
    const input = "› hello\n\n  gpt-5.5 default · /repo\n";
    const r = parseStateForCli(input, "codex");
    expect(r.state).toBe("waiting");
  });

  test("uses explicit claude cli instead of codex status bar detection", () => {
    const input = "› hello\n\n  gpt-5.5 default · /repo\n";
    const r = parseStateForCli(input, "claude");
    expect(r.state).toBe("unknown");
  });
});

describe("parseState claude regression guard", () => {
  // These cases MUST still go through the claude branch and return the same results
  // as before the codex dispatch was added. If the codex detector mis-classifies any
  // claude output, this section turns red.

  test("empty input → unknown", () => {
    const r = parseState("");
    expect(r.state).toBe("unknown");
  });

  test("claude idle pane (❯ + ⏵⏵) → waiting via the claude branch", () => {
    const r = parseState(CLAUDE_IDLE);
    expect(r.state).toBe("waiting");
    expect(r.reason).toBe("idle at input prompt");
  });

  test("claude 'I HAVE COMPLETED THE GOAL' → complete via the claude branch", () => {
    const input = `[USER TASK]
Some task.

⏺ Done.

I HAVE COMPLETED THE GOAL
`;
    const r = parseState(input);
    expect(r.state).toBe("complete");
    expect(r.reason).toContain("I HAVE COMPLETED THE GOAL");
  });

  test("claude 'esc to interrupt' → running via the claude branch", () => {
    const input = `[USER TASK]
Working on something.

✻ Thinking… (esc to interrupt)
`;
    const r = parseState(input);
    expect(r.state).toBe("running");
  });

  test("claude rate-limit pattern → rate_limited via the claude branch", () => {
    const input = `[USER TASK]
Hit your limit
`;
    const r = parseState(input);
    expect(r.state).toBe("rate_limited");
  });

  test("claude 'Compacting conversation' → compacting via the claude branch", () => {
    const input = `[USER TASK]

Compacting conversation
`;
    const r = parseState(input);
    expect(r.state).toBe("compacting");
  });
});

/**
 * Phase 3 (SPEC-ANTIGRAVITY-CLI.md §4.6) — Antigravity CLI (`agy`) state
 * detection: isAgyTmuxOutput, parseAgyState, and the agy dispatch in
 * parseState / parseStateForCli. Fixtures are built from the verbatim captures
 * in ANTIGRAVITY-CLI-NOTES.md §17.1 (trust card) and §17.7 (rendering).
 *
 * Also guards that the claude-shaped tmux override detectors
 * (isCompacting / isRateLimited / isApiError) never false-positive on an agy
 * pane — agy's rate_limited/api_error/compacting strings aren't captured yet, so
 * those states must stay unknown for agy (D10).
 */

import { test, expect, describe } from "bun:test";
import {
  parseAgyState,
  isAgyTmuxOutput,
  isCodexTmuxOutput,
  parseState,
  parseStateForCli,
} from "./parse-state";
import { isCompacting, isRateLimited, isApiError, isApiTerms, isApiSafeguard } from "./agents";

async function fixture(name: string): Promise<string> {
  return await Bun.file(new URL(`fixtures/${name}`, import.meta.url)).text();
}

describe("isAgyTmuxOutput", () => {
  test("detects the welcome banner (Antigravity in head)", async () => {
    expect(isAgyTmuxOutput(await fixture("agy-welcome.txt"))).toBe(true);
  });
  test("detects the trust card", async () => {
    expect(isAgyTmuxOutput(await fixture("agy-trust-card.txt"))).toBe(true);
  });
  test("detects the idle prompt via the accept-edits · status segment", async () => {
    expect(isAgyTmuxOutput(await fixture("agy-idle-prompt.txt"))).toBe(true);
  });
  test("detects the working screen via the accept-edits · status segment", async () => {
    expect(isAgyTmuxOutput(await fixture("agy-working-spinner.txt"))).toBe(true);
  });
  test("all five agy fixtures still detect", async () => {
    for (const name of [
      "agy-welcome.txt",
      "agy-idle-prompt.txt",
      "agy-working-spinner.txt",
      "agy-trust-card.txt",
      "agy-survey-overlay.txt",
    ]) {
      expect(isAgyTmuxOutput(await fixture(name))).toBe(true);
    }
  });
  test("empty input is not agy", () => {
    expect(isAgyTmuxOutput("")).toBe(false);
  });
  test("a bare 'Antigravity' mention (not the 'Antigravity CLI' banner) is not agy", () => {
    // A claude agent working on THIS feature has "Antigravity" all over its
    // transcript/prompt; only the literal banner counts.
    const claudeWorkingOnAgy = [
      "⏺ I'm implementing the Antigravity agy support in parse-state.ts.",
      "  Here's what the Antigravity docs say about hooks…",
      "❯",
      "  ⏵⏵ accept edits on (shift+tab to cycle)          ? for shortcuts",
    ].join("\n");
    expect(isAgyTmuxOutput(claudeWorkingOnAgy)).toBe(false);
  });
  test("the literal 'Antigravity CLI' banner IS agy", () => {
    expect(isAgyTmuxOutput(["  ▲ Antigravity CLI", "  Account: x"].join("\n"))).toBe(true);
  });
  test("a lone 'accept-edits ·' with no model label after it is not enough", () => {
    // Guards the `· <label>` requirement (e.g. a prose echo of the mode word).
    expect(isAgyTmuxOutput(["quoting accept-edits ·", "> "].join("\n"))).toBe(false);
  });
  test("a claude pane is not misdetected as agy", () => {
    const claude = [
      "Claude Code v1.0.0",
      "[USER TASK]",
      "────────────────",
      "❯ ",
      "────────────────",
      "  repo | Model: Sonnet",
    ].join("\n");
    expect(isAgyTmuxOutput(claude)).toBe(false);
  });
  test("a claude idle pane with '? for shortcuts' is NOT misdetected as agy (regression)", async () => {
    // Recent claude builds render `? for shortcuts` in their idle footer. That
    // string must NOT be an agy signal — agy is identified by `accept-edits · …`
    // (claude uses "accept edits on", no hyphen/·) or `esc to cancel`.
    expect(isAgyTmuxOutput(await fixture("claude-idle-shortcuts.txt"))).toBe(false);
  });
  test("'? for shortcuts' alone (no accept-edits · / esc to cancel) is not agy", () => {
    const claudeFooter = [
      "⏺ done",
      "────────",
      "> ",
      "────────",
      "  ? for shortcuts",
    ].join("\n");
    expect(isAgyTmuxOutput(claudeFooter)).toBe(false);
  });
  test("claude's 'accept edits on' footer (no hyphen, no ·) is not agy", () => {
    const claudeFooter = ["⏺ done", "  ⏵⏵ accept edits on (shift+tab to cycle)"].join("\n");
    expect(isAgyTmuxOutput(claudeFooter)).toBe(false);
  });
  test("a codex pane is not misdetected as agy (and vice versa)", () => {
    const codex = [
      "OpenAI Codex (v1.2.3)",
      "› ",
      "gpt-5.1-codex default · ~/repo",
    ].join("\n");
    expect(isAgyTmuxOutput(codex)).toBe(false);
    // Sanity: the agy fixtures are not misdetected as codex either.
    // (guards the parseState dispatch order)
    expect(isCodexTmuxOutput("? for shortcuts   accept-edits · Gemini 3.7 Flash · low")).toBe(false);
  });
});

describe("parseAgyState — fixtures", () => {
  test("welcome screen → waiting (idle at prompt)", async () => {
    expect(parseAgyState(await fixture("agy-welcome.txt")).state).toBe("waiting");
  });
  test("idle prompt → waiting", async () => {
    const r = parseAgyState(await fixture("agy-idle-prompt.txt"));
    expect(r.state).toBe("waiting");
    expect(r.reason).toContain("idle at agy input prompt");
  });
  test("working spinner → running", async () => {
    expect(parseAgyState(await fixture("agy-working-spinner.txt")).state).toBe("running");
  });
  test("trust card → creating", async () => {
    const r = parseAgyState(await fixture("agy-trust-card.txt"));
    expect(r.state).toBe("creating");
    expect(r.reason).toContain("trust card");
  });
  test("survey overlay over idle → waiting (survey does not change state)", async () => {
    expect(parseAgyState(await fixture("agy-survey-overlay.txt")).state).toBe("waiting");
  });
  test("empty → unknown", () => {
    expect(parseAgyState("").state).toBe("unknown");
    expect(parseAgyState("   \n  \n").state).toBe("unknown");
  });
});

describe("parseAgyState — sentinels and spinner shapes", () => {
  test("WAITING sentinel → waiting", () => {
    const out = ["some transcript", "", "WAITING", ""].join("\n");
    expect(parseAgyState(out).state).toBe("waiting");
  });
  test("I HAVE COMPLETED THE GOAL → complete", () => {
    const out = ["did the work", "", "I HAVE COMPLETED THE GOAL"].join("\n");
    expect(parseAgyState(out).state).toBe("complete");
  });
  test("quoted completion sentinel does NOT count as complete", () => {
    const out = ["reminder: say 'I HAVE COMPLETED THE GOAL' when done", "", "> "].join("\n");
    expect(parseAgyState(out).state).not.toBe("complete");
  });
  test("esc to cancel → running (beats a trailing idle prompt)", () => {
    const out = [
      "⣻  Reading file...",
      "────────",
      "> ",
      "────────",
      "esc to cancel                 accept-edits · Gemini 3.7 Flash · low",
    ].join("\n");
    expect(parseAgyState(out).state).toBe("running");
  });
  test("Braille spinner + Running command → running (each documented variant)", () => {
    for (const line of ["⢿  Running command...", "⣯  Generating...", "⣻  Reading file..."]) {
      const out = ["● Bash(x)", line, "└ Tip: ..."].join("\n");
      expect(parseAgyState(out).state).toBe("running");
    }
  });
  test("running beats a stale WAITING higher in the window", () => {
    const out = ["WAITING", "⣯  Generating...", "esc to cancel  ·  accept-edits"].join("\n");
    expect(parseAgyState(out).state).toBe("running");
  });
});

describe("parseState (content-sniffing) dispatches agy panes to parseAgyState", () => {
  test("agy working fixture → running via parseState", async () => {
    expect(parseState(await fixture("agy-working-spinner.txt")).state).toBe("running");
  });
  test("agy trust card → creating via parseState", async () => {
    expect(parseState(await fixture("agy-trust-card.txt")).state).toBe("creating");
  });
  test("a claude idle pane with '? for shortcuts' still routes through the claude parser (waiting)", async () => {
    // Regression: before the fix isAgyTmuxOutput matched `? for shortcuts` and
    // parseState would mis-route this claude pane to parseAgyState.
    const claudeIdle = await fixture("claude-idle-shortcuts.txt");
    expect(isAgyTmuxOutput(claudeIdle)).toBe(false);
    expect(parseState(claudeIdle).state).toBe("waiting");
  });

  test("a RATE-LIMITED claude pane mentioning 'Antigravity' + '? for shortcuts' → rate_limited, not waiting (correctness regression)", () => {
    // The proven bug: a claude agent working on THIS feature has "Antigravity" in
    // its transcript head AND a "? for shortcuts" footer; the old isAgyTmuxOutput
    // matched either, routed the pane to parseAgyState (which ignores the
    // usage-limit banner), and returned `waiting` — short-circuiting the watchdog
    // rate-limit bypass loop. The fix requires the literal "Antigravity CLI"
    // banner / trust card / `accept-edits · <label>`, none of which are present.
    const rateLimitedClaude = [
      "⏺ Implementing the Antigravity agy support now.",
      "  Reading the Antigravity docs for the hook payloads.",
      "",
      "Claude usage limit reached · Your limit will reset at 3pm",
      "",
      "❯",
      "  ⏵⏵ accept edits on (shift+tab to cycle)          ? for shortcuts",
    ].join("\n");
    expect(isAgyTmuxOutput(rateLimitedClaude)).toBe(false);
    expect(parseState(rateLimitedClaude).state).toBe("rate_limited");
  });
});

describe("parseStateForCli routes agy", () => {
  test("cli=agy → parseAgyState (idle fixture → waiting)", async () => {
    expect(parseStateForCli(await fixture("agy-idle-prompt.txt"), "agy").state).toBe("waiting");
  });
  test("cli=agy → running on the working fixture", async () => {
    expect(parseStateForCli(await fixture("agy-working-spinner.txt"), "agy").state).toBe("running");
  });
});

describe("claude-shaped override detectors do NOT false-positive on agy panes", () => {
  const names = [
    "agy-welcome.txt",
    "agy-idle-prompt.txt",
    "agy-working-spinner.txt",
    "agy-trust-card.txt",
    "agy-survey-overlay.txt",
  ];
  for (const name of names) {
    test(`${name}: isCompacting/isRateLimited/isApiError/isApiTerms/isApiSafeguard all false`, async () => {
      const out = await fixture(name);
      expect(isCompacting(out)).toBe(false);
      expect(isRateLimited(out)).toBe(false);
      expect(isApiError(out)).toBe(false);
      expect(isApiTerms(out)).toBe(false);
      expect(isApiSafeguard(out)).toBe(false);
    });
  }
});

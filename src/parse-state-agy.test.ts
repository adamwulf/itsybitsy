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
  test("detects the idle prompt via the accept-edits status + ? for shortcuts", async () => {
    expect(isAgyTmuxOutput(await fixture("agy-idle-prompt.txt"))).toBe(true);
  });
  test("detects the working screen via esc to cancel", async () => {
    expect(isAgyTmuxOutput(await fixture("agy-working-spinner.txt"))).toBe(true);
  });
  test("empty input is not agy", () => {
    expect(isAgyTmuxOutput("")).toBe(false);
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

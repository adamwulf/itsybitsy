/**
 * Port of ib's parse_state bash function to TypeScript.
 * Pure string matching — no side effects.
 */

export type AgentState =
  | "creating"
  | "running"
  | "waiting"
  | "complete"
  | "compacting"
  | "rate_limited"
  | "stopped"
  | "unknown";

export interface ParseStateResult {
  state: AgentState;
  reason: string;
}

/** Strip ANSI escape sequences from text */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b_.*?\x07|\x1b[()][AB012]/g, "");
}

/** Get the last N lines from text */
function lastNLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

/** Filter out hook spinner lines (spinner char at start + "hook" in the line) */
function filterHookSpinners(text: string): string {
  const spinnerChars = "✽✶✢·✻✳";
  return text
    .split("\n")
    .filter((line) => {
      if (spinnerChars.includes(line.charAt(0)) && line.includes("hook")) {
        return false;
      }
      return true;
    })
    .join("\n");
}

/**
 * Parse agent state from tmux output text.
 * This is a direct port of ib's parse_state() bash function.
 *
 * Note: "stopped" state is NOT detected here — the caller must check
 * whether the tmux session exists before calling parseState.
 */
export function parseState(input: string): ParseStateResult {
  if (!input || input.trim() === "") {
    return { state: "unknown", reason: "empty input" };
  }

  // Check for 'creating' state — permission screens before Claude starts
  // Only if Claude logo/[USER TASK] is NOT present
  if (!input.includes("Claude Code v") && !input.includes("[USER TASK]")) {
    if (input.includes("Enter to confirm")) {
      if (
        input.includes("Do you trust the files") ||
        input.includes("trust this folder") ||
        input.includes("Allow external CLAUDE.md file imports")
      ) {
        return { state: "creating", reason: "permission prompt (workspace trust or external imports)" };
      }
    }
  }

  const last15 = lastNLines(input, 15);
  const last5 = lastNLines(input, 5);

  // Compacting — highest priority among running states
  // Checked before running since compacting also shows "(esc to interrupt)"
  if (last5.includes("Compacting conversation")) {
    return { state: "compacting", reason: "Compacting conversation in last 5 lines" };
  }

  // Tool waiting: "⎿  Waiting" means a tool is executing
  if (/⎿\s*Waiting/.test(last15)) {
    return { state: "waiting", reason: "tool waiting (⎿ Waiting)" };
  }

  // Active running indicators in last 5 lines
  if (/\([Ee]sc to interrupt|\(ctrl\+c to interrupt|⎿  Running/.test(last5)) {
    return { state: "running", reason: "active execution indicator in last 5 lines" };
  }

  // Rate limit checks in last 15 lines
  if (last15.includes("rate_limit_error")) {
    return { state: "rate_limited", reason: "rate_limit_error in output" };
  }
  const lower15 = last15.toLowerCase();
  if (
    lower15.includes("usage limit reached") ||
    lower15.includes("limit will reset at") ||
    lower15.includes("hit your limit") ||
    lower15.includes("/upgrade to increase your usage limit")
  ) {
    return { state: "rate_limited", reason: "usage limit pattern in output" };
  }

  // Completion signal — exclude quoted occurrences (in watchdog nudge prompts)
  const unquoted15 = last15.replace(/'I HAVE COMPLETED THE GOAL'/g, "");
  if (unquoted15.includes("I HAVE COMPLETED THE GOAL")) {
    return { state: "complete", reason: "I HAVE COMPLETED THE GOAL in last 15 lines" };
  }

  // Explicit WAITING — standalone on its own line
  const waitingRegex = /(^|\n)\s*WAITING\s*($|\n)/;
  const waitingMarkerRegex = /(^|\n)⏺\s*WAITING\s*($|\n)/;
  if (waitingRegex.test(last15) || waitingMarkerRegex.test(last15)) {
    // Stale WAITING check: if ⏺ appears after the last WAITING, agent has resumed
    const afterWaiting = last15.split("WAITING").pop() ?? "";
    if (afterWaiting.includes("⏺")) {
      return { state: "running", reason: "agent output ⏺ after stale WAITING" };
    }
    return { state: "waiting", reason: "WAITING in last 15 lines" };
  }

  // Other running indicators: ctrl+b ctrl+b, thinking)
  if (/ctrl\+b ctrl\+b|thinking\)/.test(last15)) {
    return { state: "running", reason: "ctrl+b ctrl+b or thinking) in last 15 lines" };
  }

  // Thinking spinners at start of line
  const spinnerRegex = /(^|\n)[✽✶✢·✻✳]\s/;
  const filtered15 = filterHookSpinners(last15);

  if (spinnerRegex.test(filtered15)) {
    // With interrupt marker = actively thinking
    if (/(?:Esc|ctrl\+c)\s+to\s+interrupt/.test(filtered15)) {
      return { state: "running", reason: "thinking spinner with interrupt marker" };
    }
    // Token transfer arrows = actively processing
    if (/(^|\n)[✽✶✢·✻✳].*[↑↓]/.test(filtered15)) {
      return { state: "running", reason: "thinking spinner with active token transfer" };
    }
    // Not a completion time indicator = active spinner
    const completionOld = /(^|\n)[✽✶✢·✻✳]\s+[A-Za-z]+\s+for/;
    const completionNew = /(^|\n)[✽✶✢·✻✳].*thought\s+for/;
    if (!completionOld.test(filtered15) && !completionNew.test(filtered15)) {
      return { state: "running", reason: "active thinking spinner (not completion timer)" };
    }
  }

  // Permission prompts in last 15 lines (after Claude has started)
  if (last15.includes("Enter to confirm")) {
    if (
      last15.includes("Do you trust the files") ||
      last15.includes("trust this folder") ||
      last15.includes("Allow external CLAUDE.md file imports")
    ) {
      return { state: "creating", reason: "permission prompt in last 15 lines" };
    }
  }

  // Broader 20-line window for active spinners with interrupt markers
  const last20 = lastNLines(input, 20);
  const filtered20 = filterHookSpinners(last20);
  if (spinnerRegex.test(filtered20)) {
    if (/(?:Esc|ctrl\+c)\s+to\s+interrupt/.test(filtered20)) {
      return { state: "running", reason: "active spinner in broader 20-line window" };
    }
  }

  // Background tasks in status bar
  if (/⏵⏵.*·\s[0-9]+\s/.test(last15)) {
    return { state: "running", reason: "background tasks in status bar" };
  }

  // Race condition: Stop hook fired before terminal rendered Claude's response
  if (last15.includes("running stop hook") && !last15.includes("⏺")) {
    return { state: "creating", reason: "hook fired before terminal rendered response (race condition)" };
  }

  return { state: "unknown", reason: "no patterns matched" };
}

/**
 * Port of ib's parse_state bash function to TypeScript.
 * Pure string matching — no side effects.
 */

/** Claude startup markers that indicate the session has progressed past initial creation */
export const STARTUP_MARKERS = ["Claude Code v", "[USER TASK]", "╭─ Claude Code", "[AGENT CONTEXT]"];

export type AgentState =
  | "creating"
  | "running"
  | "waiting"
  | "complete"
  | "compacting"
  | "rate_limited"
  | "api_error"
  | "stopped"
  | "unknown";

export interface ParseStateResult {
  state: AgentState;
  reason: string;
}

// Window sizes for line-based pattern matching
const RECENT_WINDOW = 5;
const STANDARD_WINDOW = 15;
const BROAD_WINDOW = 20;

/** Strip ANSI escape sequences from text */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b_.*?\x07|\x1b[()][AB012]/g, "");
}

/** Strip trailing blank/whitespace-only lines from an array of lines */
function stripTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") {
    end--;
  }
  return lines.slice(0, end);
}

/** Get the last N lines from text, ignoring trailing blank lines */
function lastNLines(text: string, n: number): string {
  const lines = stripTrailingBlanks(text.split("\n"));
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
 * @deprecated Legacy — no longer used for primary state detection. State is now determined
 * deterministically by the stop hook writing to meta.json (Phase 42). This function is retained
 * for backward compatibility with the bash ib reference implementation and for the rate limit
 * bypass retry loop in the watchdog (which checks tmux output after sending Enter).
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
  if (!STARTUP_MARKERS.some((m) => input.includes(m))) {
    if (input.includes("Enter to confirm")) {
      if (
        input.includes("Do you trust the files") ||
        input.includes("trust this folder") ||
        input.includes("Allow external CLAUDE.md file imports") ||
        input.includes("New MCP server found") ||
        /\d+ new MCP servers? found/i.test(input)
      ) {
        return { state: "creating", reason: "permission prompt (workspace trust, external imports, or MCP server)" };
      }
    }
  }

  const last15 = lastNLines(input, STANDARD_WINDOW);
  const last5 = lastNLines(input, RECENT_WINDOW);

  // Compacting — highest priority among running states
  // Checked before running since compacting also shows "(esc to interrupt)"
  if (last5.includes("Compacting conversation")) {
    return { state: "compacting", reason: "Compacting conversation in last 5 lines" };
  }

  // Active running indicators in last 5 lines — checked BEFORE tool waiting
  // because if agent resumed running (showing Esc to interrupt in last 5),
  // a stale ⎿ Waiting in lines 6-15 should not override it.
  if (/\([Ee]sc to interrupt|\(ctrl\+c to interrupt|⎿  Running/.test(last5)) {
    return { state: "running", reason: "active execution indicator in last 5 lines" };
  }

  // Tool waiting: "⎿  Waiting" means a tool is executing
  if (/⎿\s*Waiting/.test(last15)) {
    return { state: "waiting", reason: "tool waiting (⎿ Waiting)" };
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
      last15.includes("Allow external CLAUDE.md file imports") ||
      last15.includes("New MCP server found") ||
      /\d+ new MCP servers? found/i.test(last15)
    ) {
      return { state: "creating", reason: "permission prompt in last 15 lines" };
    }
  }

  // Broader window for active spinners with interrupt markers
  const last20 = lastNLines(input, BROAD_WINDOW);
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

  // Idle at input prompt — bare ❯ line (no text after it) with status bar visible
  // This means the agent finished its work and is sitting at the prompt waiting for input
  if (/(^|\n)❯\s*($|\n)/.test(last15) && last15.includes("⏵⏵")) {
    return { state: "waiting", reason: "idle at input prompt" };
  }

  return { state: "unknown", reason: "no patterns matched" };
}

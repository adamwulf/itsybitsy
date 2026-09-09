/**
 * Port of ib's parse_state bash function to TypeScript.
 * Pure string matching — no side effects.
 */

import { isCodexBackedCli, type AgentCli } from "./agent-cli";

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
  | "api_terms"
  | "api_safeguard"
  | "stopped"
  | "merging" // render label for both merge_check and merging op kinds
  | "restarting" // resume / coordinator-reset in flight
  | "op_stuck" // op present, holder dead OR started_at older than OP_STUCK_TIMEOUT_MS
  | "unknown";

export interface ParseStateResult {
  state: AgentState;
  reason: string;
}

// Window sizes for line-based pattern matching.
//
// NOTE ON UNITS (tmux -J): captures now pass `-J`, so these windows count
// LOGICAL lines, not physical terminal rows. One logical line can carry the
// content of several old physical rows. The generic windows below (RECENT /
// STANDARD / BROAD) size the running / waiting / complete / tool-waiting
// checks and are left at their historical values — shrinking them risks
// FALSE NEGATIVES on those non-stale detectors (e.g. a spinner or WAITING
// marker sitting a few lines up would drop out of range).
const RECENT_WINDOW = 5;
const STANDARD_WINDOW = 15;
const BROAD_WINDOW = 20;

// Stale-marker windows (F1): rate-limit and compacting banners are STICKY —
// once a banner is on screen it lingers as the agent scrolls past it. Under
// -J each logical line holds more than an old physical row, so the same
// last-N-line window now spans MORE content and a recovered banner lingers
// in range longer, which can re-nudge an already-resumed agent. These checks
// therefore use tighter, dedicated windows than the historical 15 so a
// recovered banner leaves the window sooner.
//
// CRUCIAL SIZING CONSTRAINT (F1 follow-up): a CURRENT banner does not render at
// the very tail — it renders ABOVE the live TUI chrome. In a `-J -E -` capture
// the tail below a current banner is, after `lastNLines`/`stripTrailingBlanks`
// removes the padding rows, SEVEN non-blank logical lines: an interior blank
// separator + the input box (top border, `❯` prompt, bottom border) + the
// three status-bar lines. A single-line banner therefore sits at [-8] and a
// two-line banner box at [-9]. The window must clear (chrome + separator +
// banner) so a current banner is NEVER missed — a MISSED rate limit / compaction
// is far worse than re-nudging a recovered agent. We size with a small margin
// for banner boxes / an extra chrome line, staying comfortably under the old 15.
const COMPACTING_STALE_WINDOW = 10; // was RECENT_WINDOW (5); 7 chrome + 1-line banner + margin
const RATE_LIMIT_STALE_WINDOW = 12; // was STANDARD_WINDOW (15); 7 chrome + multi-line banner box + margin

/** Strip ANSI escape sequences from text */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b_.*?\x07|\x1b[()][AB012]/g, "");
}

/**
 * Strip trailing blank/whitespace-only lines from an array of lines.
 *
 * Exported so `src/agents.ts`'s sticky-banner detectors share this ONE
 * implementation rather than each re-deriving a trailing-blank strip. tmux
 * `capture-pane -J -E -` appends blank padding rows below the live TUI chrome
 * (input box + status bar), so a last-N-line slice taken WITHOUT this strip
 * spends its window on trailing blanks and can miss a current banner that
 * renders above the chrome. Keep this the single source of truth for both
 * files so the two paths can't drift.
 */
export function stripTrailingBlanks(lines: string[]): string[] {
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
 * Detect whether the tmux output came from a codex agent rather than a claude agent.
 * Two complementary signals (either is enough):
 *   1. The codex banner ("OpenAI Codex (v") appears near the top of the pane.
 *   2. The codex-shaped status bar appears near the very end of the pane.
 *
 * The banner check is the strongest signal (it scrolls out after enough output,
 * so we also check the status bar as a fallback for long-running sessions).
 */
export function isCodexTmuxOutput(input: string): boolean {
  if (!input) return false;
  const lines = input.split("\n");

  // Banner check — first 15 lines (codex's box layout occupies ~7 lines after blank space).
  const head = lines.slice(0, 15).join("\n");
  if (head.includes("OpenAI Codex (v")) return true;

  // Status-bar check — last 5 non-blank lines. Codex's bottom status line can be
  // path-shaped ("<model> default · <path>") or telemetry-shaped
  // ("<model> default · Context ... · ... left").
  const tail = stripTrailingBlanks(lines).slice(-5).join("\n");
  if (tail.split("\n").some(isCodexStatusLine)) return true;

  return false;
}

/**
 * Detect whether the tmux output came from an Antigravity CLI (`agy`) agent
 * rather than claude or codex (SPEC-ANTIGRAVITY-CLI.md §4.6). Only agy-UNIQUE
 * signals are used (any one is enough):
 *   1. The trust card's unique question, present anywhere.
 *   2. The literal `Antigravity CLI` welcome banner near the top.
 *   3. The bottom status bar's agy-only segment `accept-edits · <model>` (or
 *      `plan · <model>`) — the mode word followed by `·` and a model label.
 *
 * DELIBERATELY NOT signals (they false-positive claude panes — proven in review):
 *   - `? for shortcuts` — recent claude builds render this in their idle footer.
 *   - `esc to cancel` — claude's permission modal shows "Esc to cancel".
 *   - a bare "Antigravity" substring — a claude agent working on THIS feature has
 *     "Antigravity" all over its transcript/prompt; only the exact `Antigravity
 *     CLI` banner counts.
 * Claude renders "accept edits on" (no hyphen, no `·`), so the `accept-edits · `
 * segment is agy-only. These strings are also disjoint from codex's
 * (`OpenAI Codex (v`, `gpt-/codex-` + `·` status line), so the detectors don't
 * collide.
 */
export function isAgyTmuxOutput(input: string): boolean {
  if (!input) return false;
  const lines = input.split("\n");

  // Trust card — agy-unique and unambiguous.
  if (input.includes("Do you trust the contents of this project?")) return true;

  // Welcome banner — the literal "Antigravity CLI" text near the top.
  const head = lines.slice(0, 12).join("\n");
  if (head.includes("Antigravity CLI")) return true;

  // Status-bar segment — last few non-blank lines. Require the agy-only
  // `accept-edits ·`/`plan ·` mode word FOLLOWED BY a model label (a non-space
  // token after the `·`) ON THE SAME LINE (horizontal whitespace only, so a
  // line-ending `accept-edits ·` plus content on the next line can't match), so
  // a lone `accept-edits ·` echoed in prose can't match.
  const tail = stripTrailingBlanks(lines).slice(-8).join("\n");
  if (/\b(?:accept-edits|plan)[ \t]+·[ \t]+\S/.test(tail)) return true;

  return hasAgyBackgroundTasks(input);
}

/**
 * Parse Antigravity CLI (`agy`) agent state from tmux output
 * (SPEC-ANTIGRAVITY-CLI.md §4.6). Like codex, agy's PRIMARY state is written to
 * meta.json by its hooks; this tmux parser is the fallback / override path.
 *
 * agy's TUI: a `>` input line between `────` separators, `? for shortcuts`
 * bottom-left when idle and `esc to cancel` when a turn is running, a right-side
 * `accept-edits · <model> · <effort>` status, and Braille-spinner activity lines
 * (`⢿  Running command...`, `⣯  Generating...`, `⣻  Reading file...`).
 *
 * Priority order (mirrors codex's intent):
 *   1. Active work — `esc to cancel` bottom-left OR a Braille-spinner activity
 *      line in the last 15 lines → running.
 *   2. Completion sentinel ("I HAVE COMPLETED THE GOAL", unquoted) → complete.
 *      Otherwise a live background task below the input box → running.
 *   3. Standalone WAITING marker → waiting.
 *   4. Trust card ("Do you trust the contents of this project?") → creating.
 *   5. Idle at the input prompt (`? for shortcuts`, or a bare `>` between
 *      `────` separators) → waiting (defers to the meta state the hooks write).
 *   6. Default → unknown.
 *
 * rate_limited / api_error / compacting are deliberately NOT detected here — agy's
 * strings for those aren't captured yet, so those override states stay `unknown`
 * for agy (D10).
 */
export function parseAgyState(input: string): ParseStateResult {
  if (!input || input.trim() === "") {
    return { state: "unknown", reason: "empty input" };
  }

  const last15 = lastNLines(input, STANDARD_WINDOW);

  // 1. Active work. `esc to cancel` is agy's bottom-left hint while a turn runs;
  // the Braille-spinner activity line (⢀-⣿ range, U+2800–U+28FF) leads
  // "Running command..." / "Generating..." / "Reading file..." and similar.
  if (/(^|\n)\s*esc to cancel\b/i.test(last15)) {
    return { state: "running", reason: "agy 'esc to cancel' hint in last 15 lines" };
  }
  if (/(^|\n)[ \t]*[⠀-⣿][ \t]+(Running|Generating|Reading|Thinking|Working|Searching|Editing|Analyzing|Planning)/.test(last15)) {
    return { state: "running", reason: "agy Braille spinner activity line in last 15 lines" };
  }

  // 2. Completion sentinel — exclude quoted occurrences (watchdog nudge prompts).
  const unquoted15 = last15.replace(/'I HAVE COMPLETED THE GOAL'/g, "");
  if (unquoted15.includes("I HAVE COMPLETED THE GOAL")) {
    return { state: "complete", reason: "I HAVE COMPLETED THE GOAL in last 15 lines (agy)" };
  }

  // A live background task beats WAITING/idle, but preserves intentional completion.
  if (hasAgyBackgroundTasks(input)) {
    return { state: "running", reason: "agy background task below input prompt" };
  }

  // 3. Explicit WAITING — standalone on its own line (agy doesn't use ⏺).
  const waitingRegex = /(^|\n)\s*WAITING\s*($|\n)/;
  if (waitingRegex.test(last15)) {
    return { state: "waiting", reason: "WAITING in last 15 lines (agy)" };
  }

  // 4. Trust card — startup screen before the first turn.
  if (input.includes("Do you trust the contents of this project?")) {
    return { state: "creating", reason: "agy trust card" };
  }

  // 5. Idle at the input prompt. `? for shortcuts` is the bottom-left hint only
  // rendered when idle; a bare `>` between the two input-box `────` separators is
  // the secondary signal. Defers to the meta state (waiting/complete) the hooks
  // write on the primary path.
  if (/(^|\n)\s*\? for shortcuts\b/.test(last15)) {
    return { state: "waiting", reason: "idle at agy input prompt (? for shortcuts)" };
  }
  if (hasAgyBarePromptBetweenSeparators(input)) {
    return { state: "waiting", reason: "idle at agy input prompt (bare > between separators)" };
  }

  return { state: "unknown", reason: "no agy patterns matched" };
}

/**
 * Recognizable agy status chrome, including the model/context footer captured
 * in current Gemini builds. Caller must also validate the surrounding input box;
 * the shortcut/cancel hints alone are shared with other CLIs.
 */
export function isAgyStatusLine(line: string): boolean {
  const text = stripAnsi(line).trim();
  return /^(?:\? for shortcuts|esc to cancel)\b/.test(text)
    || /\b(?:accept-edits|plan)[ \t]+·[ \t]+\S/.test(text)
    || /^\S[^\n]*[ \t]+\|[ \t]+Context:[ \t]*\d{1,3}%$/.test(text);
}

/** Locate the latest agy input box, even when a task section adds a third divider. */
export function findAgyInputBox(lines: string[]): { upperIndex: number; lowerIndex: number } | null {
  const plain = stripTrailingBlanks(lines.map(stripAnsi));
  if (!plain.slice(-2).some(isAgyStatusLine)) return null;
  const isSep = (line: string): boolean => /^─+$/.test(line.trim());
  const prompt = plain.findLastIndex((line) => /^>(\s|$)/.test(line.trimStart()));
  if (prompt < 1 || !isSep(plain[prompt - 1]!)) return null;
  const belowPrompt = plain.slice(prompt + 1);
  const bottom = belowPrompt.findIndex(isSep);
  if (bottom < 0) return null;
  return { upperIndex: prompt - 1, lowerIndex: prompt + 1 + bottom };
}

/**
 * Detect agy's live background-task section below its input box. Captured from
 * sub-builder on 2026-09-08; see fixtures/agy-background-task.txt.
 */
export function hasAgyBackgroundTasks(input: string): boolean {
  const lines = stripTrailingBlanks(stripAnsi(input).split("\n"));
  const isSep = (line: string): boolean => /^─+$/.test(line.trim());
  // Only inspect the latest input box. A task row in transcript/scrollback must
  // not keep a finished agent running. Unlike Claude's fixed footer window, this
  // section can grow with the number of tasks.
  const box = findAgyInputBox(lines);
  if (!box) return false;
  const belowInput = lines.slice(box.lowerIndex + 1);
  const tasksBottom = belowInput.findIndex(isSep);
  if (tasksBottom < 1) return false;
  // The task section is followed only by the status footer (at most two lines).
  const footer = belowInput.slice(tasksBottom + 1);
  if (footer.length > 2 || !footer.some(isAgyStatusLine)) return false;
  return belowInput.slice(0, tasksBottom).some((line) =>
    /^[ \t]*●[ \t]+\[\d{2}:\d{2}:\d{2}\][ \t]+\S.*[ \t]running[ \t]*$/.test(line),
  );
}

/** True when the tail carries agy's `── > ──` input-box chrome. */
function hasAgyBarePromptBetweenSeparators(input: string): boolean {
  const lines = stripTrailingBlanks(input.split("\n"));
  // Find the last bare `>` prompt line (optionally followed by placeholder text).
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^>(\s|$)/.test((lines[i] ?? "").trimStart())) { promptIdx = i; break; }
  }
  if (promptIdx < 0) return false;
  const isSep = (s: string): boolean => /^─+$/.test(stripAnsi(s).trim());
  const hasSepAbove = lines.slice(0, promptIdx).some(isSep);
  const hasSepBelow = lines.slice(promptIdx + 1).some(isSep);
  return hasSepAbove && hasSepBelow;
}

/**
 * Parse codex agent state from tmux output. Codex's TUI differs from claude's — different
 * glyphs (› for input prompt, • for output bullets), no surrounding box, and a status
 * bar that may show either cwd or context/quota telemetry on the last line.
 *
 * Priority order (mirrors claude's intent):
 *   1. Active work marker ("Working (... esc to interrupt)") in last 15 lines → running.
 *   2. Completion sentinel ("I HAVE COMPLETED THE GOAL") in last 15 lines (excluding quoted) → complete.
 *   3. Standalone WAITING marker in last 15 lines → waiting.
 *   4. Idle at codex input prompt (a line starting with "›" near the tail AND a status-bar
 *      line at the very end) → waiting.
 *   5. Default → unknown.
 */
export function parseCodexState(input: string): ParseStateResult {
  if (!input || input.trim() === "") {
    return { state: "unknown", reason: "empty input" };
  }

  const last15 = lastNLines(input, STANDARD_WINDOW);

  // Codex keeps its native input chrome visible while work is active. The
  // "Working (... esc to interrupt)" line must therefore win over the trailing
  // "›" prompt/status bar, otherwise active agents are misclassified as idle.
  if (/\bWorking\s*\([^)]*(?:esc|ctrl\+c) to interrupt/i.test(last15)) {
    return { state: "running", reason: "codex Working interrupt marker in last 15 lines" };
  }

  // Completion signal — exclude quoted occurrences (in watchdog nudge prompts)
  const unquoted15 = last15.replace(/'I HAVE COMPLETED THE GOAL'/g, "");
  if (unquoted15.includes("I HAVE COMPLETED THE GOAL")) {
    return { state: "complete", reason: "I HAVE COMPLETED THE GOAL in last 15 lines (codex)" };
  }

  // Explicit WAITING — standalone on its own line (codex agents emit this verbatim
  // per the standby-agent instruction). Codex doesn't use ⏺, so no marker variant.
  const waitingRegex = /(^|\n)\s*WAITING\s*($|\n)/;
  if (waitingRegex.test(last15)) {
    return { state: "waiting", reason: "WAITING in last 15 lines (codex)" };
  }

  // Out-of-usage — codex renders "■ You've hit your usage limit. …" (real
  // captured samples across tiers: "Upgrade to Pro … purchase more credits" and
  // "Upgrade to Plus …" — both carry the stable stem "hit your usage limit").
  // Anchor on that stem (apostrophe-agnostic; distinct from claude's
  // "hit your limit"). Mirrors agents.ts isRateLimited.
  //
  // Ordered as a FALLBACK — after Working/complete/WAITING but BEFORE the
  // idle-at-prompt block. Two reasons for this exact slot:
  //  - It MUST beat idle-at-prompt: codex keeps its "›" input prompt + status
  //    bar visible even while out of usage, so idle-at-prompt would otherwise
  //    misread it as `waiting`.
  //  - It must NOT beat a more-recent Working/complete/WAITING signal: the
  //    usage-limit line is a scrollback transcript line (not a dismissable
  //    modal), so a recovered agent can still have a stale copy inside the
  //    last-15 window after it has moved on. Checking those fresher signals
  //    first prevents a recovered/completed agent from flickering to
  //    rate_limited. (The primary path in agents.ts guards the completed case
  //    via its own complete fast-path before isRateLimited runs.)
  if (last15.toLowerCase().includes("hit your usage limit")) {
    return { state: "rate_limited", reason: "codex usage-limit message in last 15 lines" };
  }

  // Idle at codex input prompt — walk from the bottom to the last "›" prompt,
  // then inspect the tail block after it. Codex can wrap long typed prompts
  // across many terminal lines, so fixed "last 5 lines" prompt lookbacks are
  // brittle.
  const tailLines = stripTrailingBlanks(input.split("\n"));
  const last = tailLines[tailLines.length - 1] ?? "";
  const hasStatusBar = isCodexStatusLine(last);
  if (hasStatusBar) {
    const promptIndex = findLastCodexPromptIndex(tailLines);
    if (promptIndex >= 0) {
      return { state: "waiting", reason: "idle at codex input prompt" };
    }
    // Even without a "›" in the last 5 lines, a trailing status bar alone is a
    // strong signal of idle — codex only renders the status bar when the prompt
    // is interactive. Fall through to a softer waiting verdict.
    return { state: "waiting", reason: "codex status bar at tail (no visible › in last 5)" };
  }

  return { state: "unknown", reason: "no codex patterns matched" };
}

function findLastCodexPromptIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^›(?:\s|$)/.test((lines[i] ?? "").trimStart())) return i;
  }
  return -1;
}

export function isCodexStatusLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("·")) return false;
  if (!/^(?:gpt|codex)-[A-Za-z0-9._-]+(?:\s+\S+)?\s+·\s+/.test(trimmed)) return false;
  if (/\s·\s+(?:~|\/)/.test(trimmed)) return true;
  return /\bContext\s+\d+%|\b\d+[hm]\b.*\bleft\b|\bweekly\b.*\bleft\b/.test(trimmed);
}

export function parseStateForCli(input: string, cli: AgentCli): ParseStateResult {
  if (!input || input.trim() === "") {
    return { state: "unknown", reason: "empty input" };
  }
  if (isCodexBackedCli(cli)) return parseCodexState(input);
  if (cli === "agy") return parseAgyState(input);
  return parseClaudeState(input);
}

/**
 * Parse agent state from tmux output text.
 *
 * Originally a direct port of ib's parse_state() bash function. It has since
 * diverged materially from the bash reference: captures now use `tmux
 * capture-pane -J`, so the input is LOGICAL lines (soft-wrapped rows rejoined,
 * trailing spaces preserved) rather than physical terminal rows, and the
 * stale-sensitive windows were tightened accordingly (compacting via
 * COMPACTING_STALE_WINDOW=10, rate-limit via RATE_LIMIT_STALE_WINDOW=12 — both
 * still wide enough to clear the TUI chrome below a current banner; the generic
 * running/waiting/complete windows stay at RECENT/STANDARD/BROAD).
 * See SPEC.md §1.3 "Capture unit — logical lines (-J)".
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

  // Codex agents have a different TUI shape — dispatch to the codex parser early
  // so the claude-shaped patterns below don't accidentally match (or fail to match)
  // against codex output. The detector checks for the codex banner ("OpenAI Codex (v")
  // OR the codex status-bar shape at the tail.
  if (isCodexTmuxOutput(input)) {
    return parseCodexState(input);
  }

  // agy agents have their own TUI shape too — dispatch to the agy parser before
  // the claude-shaped patterns below. The detector keys ONLY on agy-unique
  // signals: the trust card question, the literal "Antigravity CLI" banner, and
  // the `accept-edits ·`/`plan ·` + model-label status segment — all disjoint
  // from codex and claude (see isAgyTmuxOutput for why the shared strings
  // `? for shortcuts` / `esc to cancel` / bare "Antigravity" are excluded).
  if (isAgyTmuxOutput(input)) {
    return parseAgyState(input);
  }

  return parseClaudeState(input);
}

export function parseClaudeState(input: string): ParseStateResult {
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
  // Uses the tighter COMPACTING_STALE_WINDOW (F1) so a finished "Compacting
  // conversation" banner leaves the window quickly and doesn't keep the agent
  // pinned to compacting after it has resumed — but the window is still wide
  // enough to clear the input-box + status-bar chrome below a CURRENT banner
  // (see the COMPACTING_STALE_WINDOW sizing note).
  const compactingWindow = lastNLines(input, COMPACTING_STALE_WINDOW);
  if (compactingWindow.includes("Compacting conversation")) {
    return { state: "compacting", reason: "Compacting conversation in compacting window" };
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

  // Rate limit checks — uses the tighter RATE_LIMIT_STALE_WINDOW (F1). The
  // window still clears the input-box + status-bar chrome below a CURRENT
  // usage-limit banner (single- or multi-line box) so a current banner is
  // never missed, while letting a recovered one age out of range faster than
  // the old 15-line window did (see the RATE_LIMIT_STALE_WINDOW sizing note).
  const rateLimitWindow = lastNLines(input, RATE_LIMIT_STALE_WINDOW);
  if (rateLimitWindow.includes("rate_limit_error")) {
    return { state: "rate_limited", reason: "rate_limit_error in output" };
  }
  const lowerRate = rateLimitWindow.toLowerCase();
  if (
    lowerRate.includes("usage limit reached") ||
    lowerRate.includes("limit will reset at") ||
    lowerRate.includes("hit your limit") ||
    lowerRate.includes("/upgrade to increase your usage limit")
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

/**
 * Pane mode management, RightPaneComponent, and async content loading.
 * Extracted from dashboard.ts.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { Agent, FlatEntry, PendingQuestion, DenialEntry } from "../agents";
import { readAgentLog, readAgentPrompt, parseDenials } from "../agents";
import { diffAgent, statusAgent } from "../ib-commands";
import { wrapLines } from "./wrap";
import { getStateColors } from "./color-scheme";
import { displayState, computeStateColWidth, AGE_COL_WIDTH } from "./agent-tree";
import { RESET, BOLD, DIM, RED, GREEN, CYAN, REVERSE, DIM_GRAY } from "./colors";

// Right pane modes
export const PANE_MODES = [
  "AGENT LOG", "INITIAL PROMPT", "DENIALS", "TREE", "ERRORS", "DIFF", "QUESTIONS", "STATUS",
] as const;
export type PaneMode = (typeof PANE_MODES)[number];

export const FULL_WIDTH_MODES: Set<PaneMode> = new Set(["DENIALS", "ERRORS", "DIFF", "QUESTIONS"]);
export const TOP_ANCHORED_MODES: Set<PaneMode> = new Set(["DIFF", "ERRORS", "STATUS", "QUESTIONS"]);
const AGENT_SPECIFIC_MODES: Set<PaneMode> = new Set(["AGENT LOG", "INITIAL PROMPT", "DENIALS", "DIFF", "STATUS"]);

// Denials time filter levels
export const DENIAL_FILTERS = ["all", "24h", "7d"] as const;
export type DenialFilter = (typeof DENIAL_FILTERS)[number];

/** Escape a string for use in a RegExp */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const OSC8_OPEN = "\x1b]8;;";
export const OSC8_CLOSE = "\x1b]8;;\x07";

/**
 * Ensure any unclosed OSC 8 hyperlink is terminated after truncation.
 * Also strips partial OSC sequences left by mid-sequence truncation
 * (e.g. truncation cut between \x1b]8;; and the \x07 terminator).
 */
export function closeOsc8(line: string): string {
  if (!line.includes(OSC8_OPEN)) return line;
  const lastOpen = line.lastIndexOf(OSC8_OPEN);
  const lastClose = line.indexOf(OSC8_CLOSE, lastOpen);
  if (lastClose !== -1) return line;
  // Check for partial OSC: open tag found but no BEL terminator after it
  // means truncation cut inside the URI portion — strip the partial sequence
  const belAfterOpen = line.indexOf("\x07", lastOpen);
  if (belAfterOpen === -1) {
    // Truncated mid-OSC — remove the partial sequence and close cleanly
    return line.slice(0, lastOpen) + OSC8_CLOSE;
  }
  // BEL present means the open sequence completed (we're in display text) — just close it
  return line + OSC8_CLOSE;
}

/** Colorize diff output lines */
export function colorizeDiff(lines: string[]): string[] {
  return lines.map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ")) {
      return `${DIM}${line}${RESET}`;
    } else if (line.startsWith("+")) {
      return `${GREEN}${line}${RESET}`;
    } else if (line.startsWith("-")) {
      return `${RED}${line}${RESET}`;
    }
    return line;
  });
}

/** Colorize agent log lines — dim timestamps, cyan bracket markers */
export function colorizeLog(lines: string[]): string[] {
  return lines.map((line) => {
    let result = line.replace(/^(\[\d{4}-[^\]]*\])/, `${DIM}$1${RESET}`);
    result = result.replace(new RegExp(`(?<=${escapeForRegex(RESET)}.*)(\\[[^\\]]+\\])`, "g"), `${CYAN}$1${RESET}`);
    return result;
  });
}

/** Right pane content component */
export class RightPaneComponent implements Component {
  mode: PaneMode = "AGENT LOG";
  agent: Agent | null = null;
  selectedRepoHeader: string | null = null;
  questions: PendingQuestion[] = [];
  allAgents: FlatEntry[] = [];
  scrollOffset = 0;
  displayHeight = 20;
  agentLogContent: string[] | null = null;
  promptContent: string[] | null = null;
  denialsContent: DenialEntry[] | null = null;
  denialFilter: DenialFilter = "all";
  errors: string[] = [];
  orphanedTmuxSessions: string[] = [];
  diffContent: string[] | null = null;
  diffLoading = false;
  statusContent: string[] | null = null;
  statusLoading = false;
  questionsSelectedIndex = 0;
  questionsFocused = false;
  private content: string[] = [];

  /** Return questions filtered by the currently selected agent. If no agent, return all. */
  get filteredQuestions(): PendingQuestion[] {
    if (!this.agent) return this.questions;
    return this.questions.filter((q) => q.agent === this.agent!.id);
  }

  invalidate(): void {}

  setMode(mode: PaneMode) {
    this.mode = mode;
    this.scrollOffset = 0;
    this.updateContent();
  }

  private buildRepoSummary(): string[] {
    const repoName = this.selectedRepoHeader!;
    const repoAgents = this.allAgents.filter(
      (f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent" && f.agent.repoName === repoName
    );
    const stateCounts = new Map<string, number>();
    for (const { agent } of repoAgents) {
      stateCounts.set(agent.state, (stateCounts.get(agent.state) ?? 0) + 1);
    }
    const lines: string[] = [];
    const headerEntry = this.allAgents.find((f): f is Extract<FlatEntry, { kind: "repo-header" }> => f.kind === "repo-header" && f.repoName === repoName);
    const triangle = headerEntry?.hasAgents ? "▾" : "▸";
    lines.push(`${BOLD}${triangle} ${repoName}${RESET}`);
    lines.push("");
    const repoPath = headerEntry?.repoPath ?? repoAgents[0]?.agent.repoPath ?? "";
    if (repoPath) {
      const encodedPath = repoPath.replace(/%/g, "%25").replace(/ /g, "%20").replace(/#/g, "%23").replace(/\?/g, "%3F");
      const hyperlink = `\x1b]8;;file://${encodedPath}\x07${repoPath}\x1b]8;;\x07`;
      lines.push(`${DIM}Path:${RESET} ${hyperlink}`);
      lines.push("");
    }
    lines.push(`${BOLD}Agents: ${repoAgents.length}${RESET}`);
    if (stateCounts.size > 0) {
      for (const [state, count] of stateCounts) {
        const stateColor = getStateColors()[state] ?? getStateColors().unknown;
        lines.push(`  ${stateColor}${state}${RESET}: ${count}`);
      }
    }
    return lines;
  }

  updateContent() {
    // When a repo header is selected, show repo summary for agent-specific modes
    if (this.selectedRepoHeader && !this.agent) {
      if (AGENT_SPECIFIC_MODES.has(this.mode)) {
        this.content = this.buildRepoSummary();
        return;
      }
    }

    switch (this.mode) {
      case "AGENT LOG":
        this.content = this.agentLogContent
          ?? (this.agent
            ? [`${DIM}Loading agent.log...${RESET}`]
            : [`${DIM}No agent selected${RESET}`]);
        break;
      case "INITIAL PROMPT":
        if (!this.agent) { this.content = [`${DIM}No agent selected${RESET}`]; }
        else if (this.promptContent) { this.content = [`${BOLD}Prompt:${RESET}`, "", ...this.promptContent]; }
        else { this.content = [`${DIM}Loading prompt.txt...${RESET}`]; }
        break;
      case "DENIALS":
        if (!this.agent) { this.content = [`${DIM}No agent selected${RESET}`]; }
        else if (!this.denialsContent) { this.content = [`${DIM}Loading denials...${RESET}`]; }
        else {
          const filtered = this.filterDenials(this.denialsContent);
          const filterLabel = this.denialFilter === "all" ? "all time" : `last ${this.denialFilter}`;
          this.content = [`${DIM}Filter: ${filterLabel} (t to cycle)  ${filtered.length} denial(s)${RESET}`];
          if (filtered.length === 0) { this.content.push(`${DIM}No denials found${RESET}`); }
          else { for (const d of filtered) {
            const stripped = d.line.replace(/^\[.*?\] \[PreToolUse\] /, "");
            this.content.push(`${DIM}[${d.timestamp}]${RESET} ${stripped}`);
          } }
        }
        break;
      case "TREE": {
        const treeStateColWidth = computeStateColWidth(this.allAgents);
        this.content = this.allAgents.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent").map(({ agent, connector }) => {
          const icon = agent.meta.worker ? "⚙" : "◆";
          const state = displayState(agent.state);
          const stateColor = getStateColors()[state] ?? getStateColors().unknown;
          const promptText = (agent.meta.summary ?? agent.meta.prompt).replace(/\n/g, " ");
          const coloredState = `${stateColor}${state}${RESET}${" ".repeat(Math.max(0, treeStateColWidth - state.length))}`;
          const paddedAge = agent.age.padStart(AGE_COL_WIDTH);
          return `${connector}${icon} ${agent.id}  ${coloredState}  ${paddedAge}  ${agent.meta.model}  ${promptText}`;
        });
        if (this.content.length === 0) this.content = [`${DIM}No agents${RESET}`];
        break;
      }
      case "ERRORS": {
        const totalErrors = this.errors.length + this.orphanedTmuxSessions.length;
        if (totalErrors === 0) { this.content = [`${DIM}No errors${RESET}`]; }
        else {
          const hints: string[] = [];
          if (this.errors.length > 0) hints.push("'c' to clear");
          if (this.orphanedTmuxSessions.length > 0) hints.push("Enter to kill orphan");
          this.content = [`${DIM}${totalErrors} error(s) — ${hints.join(", ")}${RESET}`, ""];
          this.content.push(...this.errors);
          if (this.orphanedTmuxSessions.length > 0) {
            if (this.errors.length > 0) this.content.push("");
            this.content.push(`${BOLD}Orphaned tmux sessions:${RESET}`);
            for (const session of this.orphanedTmuxSessions) {
              this.content.push(`  ${RED}⚠${RESET} ${session} ${DIM}(no matching agent)${RESET}`);
            }
          }
        }
        break;
      }
      case "DIFF":
        if (!this.agent) { this.content = [`${DIM}No agent selected${RESET}`]; }
        else if (this.diffLoading) { this.content = [`${DIM}Loading diff...${RESET}`]; }
        else if (this.diffContent) { this.content = this.diffContent; }
        else { this.content = [`${DIM}Loading diff...${RESET}`]; }
        break;
      case "STATUS":
        if (!this.agent) { this.content = [`${DIM}No agent selected${RESET}`]; }
        else if (this.statusLoading) { this.content = [`${DIM}Loading status...${RESET}`]; }
        else if (this.statusContent) { this.content = this.statusContent; }
        else { this.content = [`${DIM}Loading status...${RESET}`]; }
        break;
      case "QUESTIONS": {
        const filtered = this.filteredQuestions;
        if (filtered.length === 0) {
          const label = this.agent
            ? `${DIM}No pending questions for ${this.agent.id}${RESET}`
            : `${DIM}No pending questions${RESET}`;
          this.content = [label];
        } else {
          this.content = [];
          for (let i = 0; i < filtered.length; i++) {
            const q = filtered[i]!;
            const isSel = i === this.questionsSelectedIndex;
            const showHighlight = isSel && this.questionsFocused;
            const sel = isSel ? (showHighlight ? `${REVERSE}> ` : `${GREEN}> `) : "  ";
            const selEnd = isSel ? RESET : "";
            const prefix = showHighlight
              ? `${sel}${BOLD}${q.agent}:${RESET}${REVERSE} `
              : `${sel}${BOLD}${q.agent}:${RESET} `;
            const indent = "    ";
            const selStart = showHighlight ? REVERSE : (isSel ? GREEN : "");
            const fullText = `${prefix}${q.question}${selEnd}`;
            const textLines = fullText.split("\n");
            this.content.push(textLines[0]!);
            for (let j = 1; j < textLines.length; j++) {
              this.content.push(`${selStart}${indent}${textLines[j]}${selEnd}`);
            }
          }
          this.content.push("", `${DIM}Tab:focus tree  Enter:answer  Esc:acknowledge  g:go to agent${RESET}`);
        }
        break;
      }
    }
  }

  private filterDenials(denials: DenialEntry[]): DenialEntry[] {
    if (this.denialFilter === "all") return denials;
    const now = Math.floor(Date.now() / 1000);
    const cutoff = this.denialFilter === "24h" ? now - 86400 : now - 604800;
    return denials.filter((d) => d.epoch >= cutoff);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = width - 1;
    const available = Math.max(1, this.displayHeight);
    const maxOffset = Math.max(0, this.content.length - available);
    if (this.scrollOffset > maxOffset) { this.scrollOffset = maxOffset; }
    let start: number;
    if (TOP_ANCHORED_MODES.has(this.mode)) {
      start = this.scrollOffset;
    } else {
      start = Math.max(0, this.content.length - available - this.scrollOffset);
    }
    const visible = this.content.slice(start, start + available);
    if (this.mode === "QUESTIONS" || this.mode === "AGENT LOG" || this.mode === "INITIAL PROMPT" || this.mode === "ERRORS") {
      for (const line of visible) {
        if (lines.length >= this.displayHeight) break;
        const isQ = this.mode === "QUESTIONS";
        const wrapped = isQ ? wrapLines(line, innerWidth - 2) : wrapLines(line, innerWidth);
        for (let wi = 0; wi < wrapped.length; wi++) {
          if (lines.length >= this.displayHeight) break;
          if (isQ && wi > 0) {
            lines.push(closeOsc8("   " + truncateToWidth(wrapped[wi]!, innerWidth - 2, "")));
          } else {
            lines.push(closeOsc8(" " + truncateToWidth(wrapped[wi]!, innerWidth, "")));
          }
        }
      }
    } else {
      for (const line of visible) {
        lines.push(closeOsc8(" " + truncateToWidth(line, innerWidth, "")));
      }
    }
    while (lines.length < this.displayHeight) { lines.push(" "); }
    return lines;
  }
}

// --- Pane mode cycling and async loading ---

/** Context for pane management functions */
export interface PaneCtx {
  rightPane: RightPaneComponent;
  agentTree: { selectedAgent: Agent | null };
  splitPane: { fullWidth: boolean };
  modeIndex: number;
  currentAgentId: string | null;
  tui: { requestRender(): void } | null;
  setQuestionsFocused(value: boolean): void;
}

export function cyclePaneMode(ctx: PaneCtx, delta: number) {
  const startIndex = ctx.modeIndex;
  let nextIndex = (ctx.modeIndex + PANE_MODES.length + delta) % PANE_MODES.length;

  const maxSteps = PANE_MODES.length;
  for (let i = 0; i < maxSteps; i++) {
    const candidate = PANE_MODES[nextIndex]!;
    const skip =
      (candidate === "ERRORS" && ctx.rightPane.errors.length === 0 && ctx.rightPane.orphanedTmuxSessions.length === 0) ||
      (candidate === "QUESTIONS" && ctx.rightPane.questions.length === 0);
    if (!skip || nextIndex === startIndex) break;
    nextIndex = (nextIndex + PANE_MODES.length + delta) % PANE_MODES.length;
  }

  ctx.modeIndex = nextIndex;
  const mode = PANE_MODES[ctx.modeIndex]!;
  ctx.rightPane.setMode(mode);
  ctx.splitPane.fullWidth = FULL_WIDTH_MODES.has(mode);
  if (mode !== "QUESTIONS") ctx.setQuestionsFocused(false);
  triggerAsyncLoadIfNeeded(ctx);
}

export function jumpToMode(ctx: PaneCtx, mode: PaneMode, forceRefresh = false) {
  const idx = PANE_MODES.indexOf(mode);
  if (idx !== -1) {
    ctx.modeIndex = idx;
    ctx.rightPane.setMode(mode);
    ctx.splitPane.fullWidth = FULL_WIDTH_MODES.has(mode);
    if (mode !== "QUESTIONS") ctx.setQuestionsFocused(false);
    triggerAsyncLoadIfNeeded(ctx, forceRefresh);
  }
}

export function triggerAsyncLoadIfNeeded(ctx: PaneCtx, forceRefresh = false) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  const mode = PANE_MODES[ctx.modeIndex]!;
  if (mode === "DIFF" && (forceRefresh || (!ctx.rightPane.diffContent && !ctx.rightPane.diffLoading))) {
    loadDiff(ctx, agent, forceRefresh);
  } else if (mode === "STATUS" && (forceRefresh || (!ctx.rightPane.statusContent && !ctx.rightPane.statusLoading))) {
    loadStatus(ctx, agent, forceRefresh);
  }
}

export async function loadAgentLog(ctx: PaneCtx, agent: Agent) {
  const content = await readAgentLog(agent);
  if (ctx.currentAgentId === agent.id) {
    ctx.rightPane.agentLogContent = colorizeLog(content);
    ctx.rightPane.denialsContent = parseDenials(content);
    ctx.rightPane.updateContent();
    ctx.tui?.requestRender();
  }
}

export async function loadAgentPrompt(ctx: PaneCtx, agent: Agent) {
  const content = await readAgentPrompt(agent);
  if (ctx.currentAgentId === agent.id) {
    ctx.rightPane.promptContent = content;
    ctx.rightPane.updateContent();
    ctx.tui?.requestRender();
  }
}

export async function loadDiff(ctx: PaneCtx, agent: Agent, forceRefresh = false) {
  if (ctx.rightPane.diffLoading) return;
  if (forceRefresh) ctx.rightPane.diffContent = null;
  ctx.rightPane.diffLoading = true;
  ctx.rightPane.updateContent();
  ctx.tui?.requestRender();
  try {
    const result = await diffAgent(agent);
    if (ctx.currentAgentId === agent.id) {
      const output = result.stdout || result.stderr || "(no output)";
      ctx.rightPane.diffContent = colorizeDiff(output.split("\n"));
      ctx.rightPane.diffLoading = false;
      ctx.rightPane.updateContent();
      ctx.tui?.requestRender();
    }
  } catch (err) {
    if (ctx.currentAgentId === agent.id) {
      ctx.rightPane.diffContent = [`Error loading diff: ${err}`];
      ctx.rightPane.diffLoading = false;
      ctx.rightPane.updateContent();
      ctx.tui?.requestRender();
    }
  }
}

export async function loadStatus(ctx: PaneCtx, agent: Agent, forceRefresh = false) {
  if (ctx.rightPane.statusLoading) return;
  if (forceRefresh) ctx.rightPane.statusContent = null;
  ctx.rightPane.statusLoading = true;
  ctx.rightPane.updateContent();
  ctx.tui?.requestRender();
  try {
    const result = await statusAgent(agent);
    if (ctx.currentAgentId === agent.id) {
      const output = result.stdout || result.stderr || "(no output)";
      ctx.rightPane.statusContent = output.split("\n");
      ctx.rightPane.statusLoading = false;
      ctx.rightPane.updateContent();
      ctx.tui?.requestRender();
    }
  } catch (err) {
    if (ctx.currentAgentId === agent.id) {
      ctx.rightPane.statusContent = [`Error loading status: ${err}`];
      ctx.rightPane.statusLoading = false;
      ctx.rightPane.updateContent();
      ctx.tui?.requestRender();
    }
  }
}

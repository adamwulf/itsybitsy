/**
 * SystemDashboardComponent — full-width agent overview table shown when the
 * system coordinator is selected in the agent tree.
 *
 * See SPEC.md §12.1.4 for the full specification.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { FlatEntry } from "../agents";
import { displayState } from "./agent-tree";
import { getStateColors } from "./color-scheme";
import { RESET, BOLD, DIM } from "./colors";

/** Column widths per SPEC */
const COL_REPO = 15;
const COL_AGENT = 20;
const COL_ROLE = 5;
const COL_STATE = 12;
const COL_MODEL = 8;
const COL_AGE = 6;
/** Fixed-width columns total (excluding Summary): 15+20+5+12+8+6 + 5 separators (2-char each) = 76 */
const SEPARATOR = "  ";

/** Narrow-terminal thresholds */
const HIDE_SUMMARY_THRESHOLD = 80;
const HIDE_MODEL_AGE_THRESHOLD = 60;

export interface SystemDashboardRow {
  repo: string;
  agent: string;
  role: string;
  state: string;
  model: string;
  age: string;
  summary: string;
  isHeader: boolean;
}

/** Build rows from the flat agent list for the system dashboard table */
export function buildDashboardRows(flatList: FlatEntry[]): SystemDashboardRow[] {
  const rows: SystemDashboardRow[] = [];
  let currentRepo = "";

  for (const entry of flatList) {
    if (entry.kind === "system-coordinator") {
      // System coordinator is not shown in the dashboard table — it IS the dashboard
      continue;
    }
    if (entry.kind === "repo-header") {
      currentRepo = entry.repoName;
      rows.push({
        repo: entry.repoName,
        agent: "",
        role: "",
        state: "",
        model: "",
        age: "",
        summary: "",
        isHeader: true,
      });
      continue;
    }
    // kind === "agent"
    const agent = entry.agent;
    const isCoordinator = !!agent.meta.coordinator;
    const role = isCoordinator ? "coord" : (agent.meta.type ?? (agent.meta.worker ? "wkr" : "mgr"));
    const summary = (agent.meta.summary ?? agent.meta.prompt).replace(/\n/g, " ");

    rows.push({
      repo: currentRepo,
      agent: agent.id,
      role,
      state: displayState(agent.state),
      model: agent.meta.model,
      age: agent.age,
      summary,
      isHeader: false,
    });
  }

  return rows;
}

/** Format a single dashboard row into a string */
export function formatDashboardRow(
  row: SystemDashboardRow,
  width: number,
  selected: boolean = false,
): string {
  if (row.isHeader) {
    const line = `${BOLD}${row.repo}${RESET}`;
    return truncateToWidth(line, width, "");
  }

  const showSummary = width >= HIDE_SUMMARY_THRESHOLD;
  const showModelAge = width >= HIDE_MODEL_AGE_THRESHOLD;

  const stateColor = getStateColors()[row.state] ?? getStateColors().unknown;

  // Build columns
  const repoPart = pad(row.repo, COL_REPO);
  const agentPart = pad(row.agent, COL_AGENT);
  const rolePart = pad(row.role, COL_ROLE);
  const statePart = `${stateColor}${pad(row.state, COL_STATE)}${RESET}`;

  let line: string;
  if (!showModelAge) {
    // Narrowest: Repo + Agent + Role + State
    line = `  ${repoPart}${SEPARATOR}${agentPart}${SEPARATOR}${rolePart}${SEPARATOR}${statePart}`;
  } else if (!showSummary) {
    // Medium: + Model + Age
    const modelPart = pad(row.model, COL_MODEL);
    const agePart = row.age.padStart(COL_AGE);
    line = `  ${repoPart}${SEPARATOR}${agentPart}${SEPARATOR}${rolePart}${SEPARATOR}${statePart}${SEPARATOR}${modelPart}${SEPARATOR}${agePart}`;
  } else {
    // Full: + Summary
    const modelPart = pad(row.model, COL_MODEL);
    const agePart = row.age.padStart(COL_AGE);
    const fixedWidth = 2 + COL_REPO + 2 + COL_AGENT + 2 + COL_ROLE + 2 + COL_STATE + 2 + COL_MODEL + 2 + COL_AGE + 2;
    const summaryWidth = Math.max(1, width - fixedWidth);
    const summaryPart = truncateToWidth(row.summary, summaryWidth, "…");
    line = `  ${repoPart}${SEPARATOR}${agentPart}${SEPARATOR}${rolePart}${SEPARATOR}${statePart}${SEPARATOR}${modelPart}${SEPARATOR}${agePart}${SEPARATOR}${summaryPart}`;
  }

  return truncateToWidth(line, width, "");
}

/** Pad or truncate a string to exact width */
function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

/** Format the column header row */
export function formatHeaderRow(width: number): string {
  const showSummary = width >= HIDE_SUMMARY_THRESHOLD;
  const showModelAge = width >= HIDE_MODEL_AGE_THRESHOLD;

  let line: string;
  if (!showModelAge) {
    line = `  ${pad("Repo", COL_REPO)}${SEPARATOR}${pad("Agent", COL_AGENT)}${SEPARATOR}${pad("Role", COL_ROLE)}${SEPARATOR}${pad("State", COL_STATE)}`;
  } else if (!showSummary) {
    line = `  ${pad("Repo", COL_REPO)}${SEPARATOR}${pad("Agent", COL_AGENT)}${SEPARATOR}${pad("Role", COL_ROLE)}${SEPARATOR}${pad("State", COL_STATE)}${SEPARATOR}${pad("Model", COL_MODEL)}${SEPARATOR}${"Age".padStart(COL_AGE)}`;
  } else {
    line = `  ${pad("Repo", COL_REPO)}${SEPARATOR}${pad("Agent", COL_AGENT)}${SEPARATOR}${pad("Role", COL_ROLE)}${SEPARATOR}${pad("State", COL_STATE)}${SEPARATOR}${pad("Model", COL_MODEL)}${SEPARATOR}${"Age".padStart(COL_AGE)}${SEPARATOR}Summary`;
  }

  return truncateToWidth(`${DIM}${line}${RESET}`, width, "");
}

/**
 * System dashboard component — renders all agents in a scrollable table.
 */
export class SystemDashboardComponent implements Component {
  /** Flat agent list from watcher */
  flatList: FlatEntry[] = [];
  /** Available display height, set by dashboard before render */
  displayHeight = 20;
  /** Lines scrolled from the top */
  scrollOffset = 0;

  invalidate(): void {}

  scrollUp(amount = 1) {
    this.scrollOffset = Math.max(0, this.scrollOffset - amount);
  }

  scrollDown(amount = 1) {
    const rows = buildDashboardRows(this.flatList);
    const maxOffset = Math.max(0, rows.length - this.displayHeight + 2); // +2 for header + separator
    this.scrollOffset = Math.min(maxOffset, this.scrollOffset + amount);
  }

  render(width: number): string[] {
    const rows = buildDashboardRows(this.flatList);
    const lines: string[] = [];

    // Header row
    lines.push(formatHeaderRow(width));
    // Separator
    lines.push(truncateToWidth(`${DIM}${"─".repeat(width)}${RESET}`, width, ""));

    // Content rows with scrolling
    const contentHeight = Math.max(1, this.displayHeight - 2); // minus header + separator
    const maxOffset = Math.max(0, rows.length - contentHeight);
    if (this.scrollOffset > maxOffset) {
      this.scrollOffset = maxOffset;
    }

    const visibleRows = rows.slice(this.scrollOffset, this.scrollOffset + contentHeight);
    for (const row of visibleRows) {
      lines.push(formatDashboardRow(row, width));
    }

    // Pad to fill available height
    while (lines.length < this.displayHeight) {
      lines.push("");
    }

    return lines.slice(0, this.displayHeight);
  }
}

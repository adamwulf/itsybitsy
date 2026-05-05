/**
 * InfoPanelComponent — displays details for the currently selected agent or repo header.
 *
 * Mostly read-only. The single interactive element is the "Default Agent Type"
 * row rendered in repo-info mode: when this panel has focus and a repo header
 * is selected, the row becomes the focused sub-field and accepts Space (cycle)
 * and Backspace/Delete (clear) via the dashboard's input handler.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { Agent, FlatEntry } from "../agents";
import type { RepoHealthReport } from "../health-check";
import { getStateColors } from "./color-scheme";
import { displayState } from "./agent-tree";
import { wrapLines, padLines } from "./wrap";
import { RESET, BOLD, DIM, GREEN, RED, YELLOW } from "./colors";
import { resolveDefaultAgentType } from "./default-agent-type";

/** Check if a PID refers to a running process */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class InfoPanelComponent implements Component {
  agent: Agent | null = null;
  isSystemCoordinatorSelected = false;
  selectedRepoHeader: string | null = null;
  selectedRepoPath: string | null = null;
  allAgents: FlatEntry[] = [];
  healthReport: RepoHealthReport | undefined = undefined;
  /** Set of live tmux session names — used to render the agent's tmux stoplight. */
  liveTmuxSessions: Set<string> = new Set();
  /** The selected repo's coordinator agent, if any — drives the repo-info stoplights. */
  repoCoordinatorAgent: Agent | null = null;
  /** The currently saved default agent type for the selected repo, if any. */
  selectedRepoDefaultAgentType: string | undefined = undefined;
  /** Spawnable agent type names the cycle field can choose from. */
  availableAgentTypes: string[] = [];
  /** Whether this panel has focus (drives Default Agent Type sub-field styling). */
  focused = false;
  /** Whether the Default Agent Type row is the focused sub-field within the panel. */
  subFocusOnDefaultType = false;
  displayHeight = 5;

  invalidate(): void {}

  render(width: number): string[] {
    if (this.agent) {
      return this.renderAgentInfo(width);
    }
    if (this.isSystemCoordinatorSelected) {
      // System coordinator uses full-width mode; info panel renders empty/minimal
      return padLines([truncateToWidth(`${DIM}System Coordinator${RESET}`, width, "")], this.displayHeight);
    }
    if (this.selectedRepoHeader) {
      return this.renderRepoInfo(width);
    }
    return padLines([truncateToWidth(`${DIM}No selection${RESET}`, width, "")], this.displayHeight);
  }

  private renderStoplights(agent: Agent, width: number, labelPrefix = ""): string[] {
    const lines: string[] = [];

    const claudePid = agent.meta.claude_pid ? parseInt(agent.meta.claude_pid, 10) : NaN;
    const claudeAlive = !isNaN(claudePid) && isPidAlive(claudePid);
    const claudeColor = claudeAlive ? GREEN : RED;
    lines.push(truncateToWidth(`${claudeColor}●${RESET} ${labelPrefix}Claude`, width, ""));

    const watchdogPid = agent.meta.watchdog_pid;
    const watchdogAlive = typeof watchdogPid === "number" && isPidAlive(watchdogPid);
    const watchdogColor = watchdogAlive ? GREEN : RED;
    lines.push(truncateToWidth(`${watchdogColor}●${RESET} ${labelPrefix}Watchdog`, width, ""));

    const tmuxSession = agent.meta.tmux_session;
    const tmuxAlive = !!tmuxSession && this.liveTmuxSessions.has(tmuxSession);
    const tmuxColor = tmuxAlive ? GREEN : RED;
    lines.push(truncateToWidth(`${tmuxColor}●${RESET} ${labelPrefix}Tmux`, width, ""));

    return lines;
  }

  private renderAgentInfo(width: number): string[] {
    const agent = this.agent!;
    const lines: string[] = [];

    lines.push(...this.renderStoplights(agent, width));

    // Orphan warning
    if (agent.orphaned && agent.meta.manager) {
      const managerId = agent.meta.manager;
      const managerEntry = this.allAgents.find(
        (f) => f.kind === "agent" && f.agent.id === managerId
      );
      const reason =
        managerEntry && managerEntry.kind === "agent" && managerEntry.agent.archived
          ? "archived"
          : "not found";
      lines.push(truncateToWidth(`${YELLOW}⚠ Manager ${reason}: ${managerId}${RESET}`, width, ""));
    }

    // Model
    lines.push(truncateToWidth(`${DIM}Model:${RESET} ${agent.meta.model}`, width, ""));

    // Summary or prompt
    const text = agent.meta.summary ?? agent.meta.prompt;
    if (text) {
      lines.push(truncateToWidth(`${DIM}Summary:${RESET}`, width, ""));
      const wrapped = wrapLines(text.replace(/\n/g, " "), width);
      for (const wl of wrapped) {
        lines.push(truncateToWidth(wl, width, ""));
      }
    }

    return padLines(lines, this.displayHeight);
  }

  /**
   * Render the Default Agent Type row for repo info. Returns 1 line.
   * Saved value still in `availableAgentTypes` → shows the type. Otherwise
   * shows '(default)' but the underlying saved value is preserved on disk
   * (see spec §3) so a temporarily-missing type comes back when restored.
   */
  private renderDefaultAgentTypeRow(width: number): string[] {
    const saved = this.selectedRepoDefaultAgentType;
    const isValid = !!(saved && this.availableAgentTypes.includes(saved));
    const focused = this.focused && this.subFocusOnDefaultType;

    const valueText = isValid ? saved! : `${DIM}(default)${RESET}`;

    if (focused) {
      const cycleHint = ` ${DIM}[Space to cycle, Del to reset]${RESET}`;
      const valueColored = isValid ? `${BOLD}${GREEN}${saved}${RESET}` : valueText;
      return [
        truncateToWidth(
          `${BOLD}${GREEN}Default Agent Type:${RESET} ${valueColored}${cycleHint}`,
          width,
          "",
        ),
      ];
    }
    return [truncateToWidth(`${DIM}Default Agent Type:${RESET} ${valueText}`, width, "")];
  }

  /**
   * Compute the next agent type when cycling. From the saved value (or the
   * resolved default if unset), advance one step in `availableAgentTypes`.
   * If the saved value is missing from the available list, jump to the first
   * available type. Returns null when no types are available.
   */
  computeNextAgentType(): string | null {
    if (this.availableAgentTypes.length === 0) return null;
    const saved = this.selectedRepoDefaultAgentType;
    if (saved && !this.availableAgentTypes.includes(saved)) {
      return this.availableAgentTypes[0]!;
    }
    const startFrom = saved ?? resolveDefaultAgentType(saved, this.availableAgentTypes);
    const idx = this.availableAgentTypes.indexOf(startFrom);
    const next = this.availableAgentTypes[(idx + 1) % this.availableAgentTypes.length]!;
    return next;
  }

  private renderRepoInfo(width: number): string[] {
    const lines: string[] = [];

    // Coordinator stoplights — Claude/Watchdog/Tmux for the repo's coordinator agent
    if (this.repoCoordinatorAgent) {
      lines.push(...this.renderStoplights(this.repoCoordinatorAgent, width, "Coord "));
    }

    // Repo path
    const repoPath = this.selectedRepoPath ?? this.selectedRepoHeader ?? "";
    lines.push(truncateToWidth(`${DIM}Path:${RESET} ${repoPath}`, width, ""));

    // Default Agent Type — focusable cycle field
    lines.push(...this.renderDefaultAgentTypeRow(width));

    // Count active (non-archived) agents and state breakdown
    const agentsInRepo = this.allAgents.filter(
      (f): f is Extract<FlatEntry, { kind: "agent" }> =>
        f.kind === "agent" && f.agent.repoName === this.selectedRepoHeader && !f.agent.archived
    );
    lines.push(truncateToWidth(`${DIM}Agents:${RESET} ${agentsInRepo.length}`, width, ""));

    // Per-state breakdown
    const stateCounts = new Map<string, number>();
    for (const f of agentsInRepo) {
      const state = displayState(f.agent.state);
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
    }
    if (stateCounts.size > 0) {
      const stateColors = getStateColors();
      const parts: string[] = [];
      for (const [state, count] of stateCounts) {
        const color = stateColors[state] ?? stateColors.unknown;
        parts.push(`${color}${state}: ${count}${RESET}`);
      }
      const breakdownStr = parts.join(", ");
      lines.push(truncateToWidth(breakdownStr, width, ""));
    }

    // Health summary
    if (this.healthReport) {
      const warnings = this.healthReport.warnings;
      if (warnings.length === 0) {
        lines.push(truncateToWidth(`${DIM}Health:${RESET} ✅ OK`, width, ""));
      } else {
        const errorCount = warnings.filter((w) => w.severity === "error").length;
        const warnCount = warnings.filter((w) => w.severity === "warning").length;
        const parts: string[] = [];
        if (errorCount > 0) parts.push(`🔴 ${errorCount} error${errorCount !== 1 ? "s" : ""}`);
        if (warnCount > 0) parts.push(`⚠️  ${warnCount} warning${warnCount !== 1 ? "s" : ""}`);
        if (parts.length === 0) {
          const infoCount = warnings.length;
          parts.push(`ℹ️  ${infoCount} info`);
        }
        lines.push(truncateToWidth(`${DIM}Health:${RESET} ${parts.join(", ")}`, width, ""));
      }
    }

    return padLines(lines, this.displayHeight);
  }
}


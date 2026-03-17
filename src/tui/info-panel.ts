/**
 * InfoPanelComponent — displays details for the currently selected agent or repo header.
 * Read-only, no focus or interactive elements.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { Agent, FlatEntry } from "../agents";
import { getStateColors } from "./color-scheme";
import { displayState } from "./agent-tree";
import { wrapLines, padLines } from "./wrap";
import { RESET, BOLD, DIM, GREEN, RED, YELLOW } from "./colors";

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
  selectedRepoHeader: string | null = null;
  selectedRepoPath: string | null = null;
  allAgents: FlatEntry[] = [];
  displayHeight = 5;

  invalidate(): void {}

  render(width: number): string[] {
    if (this.agent) {
      return this.renderAgentInfo(width);
    }
    if (this.selectedRepoHeader) {
      return this.renderRepoInfo(width);
    }
    return padLines([truncateToWidth(`${DIM}No selection${RESET}`, width, "")], this.displayHeight);
  }

  private renderAgentInfo(width: number): string[] {
    const agent = this.agent!;
    const lines: string[] = [];

    // Stoplight indicators
    const claudePid = agent.meta.claude_pid ? parseInt(agent.meta.claude_pid, 10) : NaN;
    const claudeAlive = !isNaN(claudePid) && isPidAlive(claudePid);
    const claudeColor = claudeAlive ? GREEN : RED;
    lines.push(truncateToWidth(`${claudeColor}●${RESET} Claude`, width, ""));

    const watchdogPid = agent.meta.watchdog_pid;
    const watchdogAlive = typeof watchdogPid === "number" && isPidAlive(watchdogPid);
    const watchdogColor = watchdogAlive ? GREEN : RED;
    lines.push(truncateToWidth(`${watchdogColor}●${RESET} Watchdog`, width, ""));

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

  private renderRepoInfo(width: number): string[] {
    const lines: string[] = [];

    // Repo path
    const repoPath = this.selectedRepoPath ?? this.selectedRepoHeader ?? "";
    lines.push(truncateToWidth(`${DIM}Path:${RESET} ${repoPath}`, width, ""));

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

    return padLines(lines, this.displayHeight);
  }
}


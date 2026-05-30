/**
 * InfoPanelComponent — displays details for the currently selected agent or repo header.
 * The Default Agent Type row in repo-info mode is interactive when this panel
 * has focus (Space cycles, Backspace/Delete clears).
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
import { NotesEditorComponent } from "./notes-editor";
import { _formatTimestamp } from "../agent-lifecycle";

/**
 * Team-mode payload for the info panel (SPEC §17.3c). Parallel to the
 * `isSystemCoordinatorSelected` / `selectedRepoHeader` modes — the dashboard's
 * selection-sync populates this from the `Team` record on a team-anchor
 * selection and clears it to `null` otherwise. Holds exactly the data the team
 * render branch shows.
 */
export interface SelectedTeamInfo {
  /** Bare team name (no `@`). */
  name: string;
  /** `Team.created_epoch` — epoch SECONDS (§16.2). */
  createdEpoch: number;
  /** `Team.created_by` — an agent id, an `@`-sentinel, or `""` (a human). */
  createdBy: string;
  /** Live member count (`Team.members.length`). */
  memberCount: number;
}

/** Sub-field within the Info panel that has focus when the panel is focused. */
export type InfoSubField = "default-type" | "notes";

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
  /**
   * Team mode (§17.3c): when set, the render branch shows team metadata. The
   * dashboard's selection-sync sets this on a team-anchor selection and clears
   * it to `null` on any non-team / no selection (parallel to
   * `isSystemCoordinatorSelected` / `selectedRepoHeader`).
   */
  selectedTeam: SelectedTeamInfo | null = null;
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
  /** Which sub-field is focused when the panel is focused (repo-info mode only). */
  subField: InfoSubField = "default-type";
  /** Notes editor instance — owns its own TextBuffer; dashboard drives it. */
  notesEditor = new NotesEditorComponent();
  displayHeight = 5;

  invalidate(): void {}

  render(width: number): string[] {
    if (this.agent) {
      return this.renderAgentInfo(width);
    }
    if (this.selectedTeam) {
      return this.renderTeamInfo(width);
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

    // Identity line — only shown when a nickname is set, so the canonical id
    // stays visible/copyable: `nickname (id: <id>)`. The sidebar tree shows the
    // nickname ALONE, so without this the real id would be hidden. When there's
    // no nickname the id is already the tree label, so we omit the line to
    // avoid duplicating it in the sidebar.
    if (agent.meta.nickname) {
      lines.push(truncateToWidth(`${BOLD}${agent.meta.nickname}${RESET} ${DIM}(id: ${agent.id})${RESET}`, width, ""));
    }

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
   * Team mode (§17.3c) — renders the selected team's metadata: name (`@<name>`),
   * live member count, `created_by`, and creation date. Visual style mirrors the
   * other branches (same `DIM` label + value idiom, same `truncateToWidth`/
   * `padLines` width handling).
   */
  private renderTeamInfo(width: number): string[] {
    const team = this.selectedTeam!;
    const lines: string[] = [];

    // Team name as `@<name>`.
    lines.push(truncateToWidth(`${BOLD}@${team.name}${RESET}`, width, ""));

    // Live member count.
    lines.push(truncateToWidth(`${DIM}Members:${RESET} ${team.memberCount}`, width, ""));

    // created_by — an agent id, an `@`-sentinel (kept verbatim), or `""` → "user".
    const createdBy = team.createdBy === "" ? "user" : team.createdBy;
    lines.push(truncateToWidth(`${DIM}Created by:${RESET} ${createdBy}`, width, ""));

    // Creation date — created_epoch is SECONDS (§16.2), formatted with the
    // shared `_formatTimestamp` helper (`agent-lifecycle.ts`).
    const created = _formatTimestamp(new Date(team.createdEpoch * 1000));
    lines.push(truncateToWidth(`${DIM}Created:${RESET} ${created}`, width, ""));

    return padLines(lines, this.displayHeight);
  }

  // A saved value missing from `availableAgentTypes` renders as '(default)'
  // but the underlying value is preserved so a temporarily-missing type
  // (e.g. user editing agent-types/) comes back when restored.
  private renderDefaultAgentTypeRow(width: number): string[] {
    const saved = this.selectedRepoDefaultAgentType;
    const isValid = !!(saved && this.availableAgentTypes.includes(saved));
    const focused = this.focused && this.subField === "default-type";

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

  private renderNotesSection(width: number): string[] {
    const focused = this.focused && this.subField === "notes";
    const labelStyle = focused ? `${BOLD}${GREEN}` : DIM;
    const hint = focused ? ` ${DIM}[Esc to cancel]${RESET}` : "";
    const header = truncateToWidth(`${labelStyle}Notes:${RESET}${hint}`, width, "");
    this.notesEditor.active = focused;
    return [header, ...this.notesEditor.render(width)];
  }

  computeNextAgentType(): string | null {
    if (this.availableAgentTypes.length === 0) return null;
    const saved = this.selectedRepoDefaultAgentType;
    if (saved && !this.availableAgentTypes.includes(saved)) {
      return this.availableAgentTypes[0]!;
    }
    const startFrom = saved ?? resolveDefaultAgentType(undefined, this.availableAgentTypes);
    const idx = this.availableAgentTypes.indexOf(startFrom);
    return this.availableAgentTypes[(idx + 1) % this.availableAgentTypes.length]!;
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

    // Notes — focusable multi-line editor
    lines.push(...this.renderNotesSection(width));

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


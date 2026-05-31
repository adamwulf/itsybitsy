/**
 * Teams tree component (SPEC §17.2) — a flat-across-repos tree grouped by TEAM.
 *
 * Unlike the repo-grouped Agents tree (`AgentTreeComponent`), teams span repos,
 * so the Teams tree is NOT nested under repo headers: each team is a top-level
 * anchor whose member agents may live in any repo. This is a PARALLEL component
 * to `AgentTreeComponent` (the spec's recommended approach — not a mode flag on
 * the Agents tree) and owns its OWN selection state, independent of the Agents
 * tree (§17.1 independent-selection invariant).
 *
 * Like `AgentTreeComponent`, this is a PURE RENDER component: it does no I/O.
 * The dashboard owns the data fetch (`listTeams()` + `readAllAgents()`) and runs
 * `detectAgentStates()` over the member agents on its existing refresh cadence
 * (§17.2), then hands the already-state-detected agents to `flattenTeamsTree()`
 * (as a `Map<agentId, Agent>`) and calls `setFlatList()` with the result. This
 * mirrors how the dashboard drives `AgentTreeComponent` and keeps the Teams tree
 * free of any polling loop of its own.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { resolveAgentIcon } from "../agents";
import type { Agent } from "../agents";
import type { Team } from "../teams";
import type { Selection } from "./selection";
import { getStateColors } from "./color-scheme";
import {
  MAX_TREE_HEIGHT,
  COMPACT_WIDTH_THRESHOLD,
  AGE_COL_WIDTH,
  displayState,
  agentDisplayName,
} from "./agent-tree";
import { RESET, BOLD, DIM, REVERSE } from "./colors";

const MIN_STATE_COL_WIDTH = 8; // length of "complete"

/**
 * One row in the Teams tree. Analogous to `FlatEntry` (`src/agents.ts`):
 *  - `team-header` is an anchor row (the analogue of `repo-header`).
 *  - `team-member` is a child agent row beneath its team header.
 */
export type TeamFlatEntry =
  | { kind: "team-header"; teamName: string; memberCount: number; createdEpoch: number; createdBy: string }
  | { kind: "team-member"; teamName: string; agent: Agent; connector: string };

/**
 * Build the flat Teams-tree row list (§17.2).
 *
 * @param teams   The output of `listTeams()` (`{ name } & Team`) — an UNLOCKED
 *                pure read. Sorted by name here for stable order.
 * @param agentsById  A map from agent id to the LIVE, ALREADY-STATE-DETECTED
 *                Agent (the caller runs `detectAgentStates()` first, §17.2).
 *
 * For each team, emits one `team-header` followed by one `team-member` per
 * RESOLVABLE member id. A member id with no live agent is OMITTED (the tree is
 * read-only and must NOT mutate teams.json / take the lock — lazy pruning stays
 * the job of `ib send @<team>`/`ib roster`, §16.5). The `memberCount` on the
 * header reflects the LIVE (resolvable) member count, matching the rendered
 * children. An empty team still emits its header (teams persist when pruned to
 * empty, §16.3).
 */
export function flattenTeamsTree(
  teams: Array<{ name: string } & Team>,
  agentsById: Map<string, Agent>,
): TeamFlatEntry[] {
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
  const result: TeamFlatEntry[] = [];
  for (const team of sorted) {
    const members: Agent[] = [];
    for (const memberId of team.members) {
      const agent = agentsById.get(memberId);
      if (agent) members.push(agent);
    }
    result.push({
      kind: "team-header",
      teamName: team.name,
      memberCount: members.length,
      createdEpoch: team.created_epoch,
      createdBy: team.created_by,
    });
    for (const agent of members) {
      result.push({ kind: "team-member", teamName: team.name, agent, connector: "  " });
    }
  }
  return result;
}

/** Compute the state column width from the team-member rows being displayed. */
function computeTeamStateColWidth(rows: TeamFlatEntry[]): number {
  let maxLen = MIN_STATE_COL_WIDTH;
  for (const r of rows) {
    if (r.kind === "team-member") {
      maxLen = Math.max(maxLen, displayState(r.agent.state).length);
    }
  }
  return maxLen;
}

/** The `<repo>/<id>` name token for a cross-repo member (§17.2). */
function repoQualifiedName(agent: Agent): string {
  return `${agent.repoName}/${agentDisplayName(agent)}`;
}

/** Width of the member row name prefix (connector + icon + repo/display-name). */
function memberNamePrefixWidth(agent: Agent, connector: string): number {
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = resolveAgentIcon(agent.meta);
  return visibleWidth(`${connector}${orphanedPrefix}${icon} ${repoQualifiedName(agent)}`);
}

/**
 * Format a team-member row (§17.2). Mirrors `formatAgentRow`'s column order
 * exactly; the only difference is that the cross-repo name is qualified as
 * `<repo>/<id>` (e.g. `frontend/agent-6f61e45b`) so members from different
 * repos are disambiguated. The model lives in its own column after age, same
 * as the Agents tree, instead of being bundled with the repo.
 *
 * Compact mode (width <= COMPACT_WIDTH_THRESHOLD):
 *   `<connector><icon> <repo>/<id>  <state>  <age>`
 * Full mode (wider): additionally appends the model and prompt/summary, in
 * the same order as `formatAgentRow`.
 */
export function formatTeamMemberRow(
  agent: Agent,
  connector: string,
  selected: boolean,
  width: number,
  nameColWidth: number,
  stateColWidth: number = MIN_STATE_COL_WIDTH,
): string {
  const compact = width <= COMPACT_WIDTH_THRESHOLD;
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = resolveAgentIcon(agent.meta);
  const state = displayState(agent.state);
  const stateColor = getStateColors()[state] ?? getStateColors().unknown;

  const namePrefix = `${connector}${orphanedPrefix}${icon} ${repoQualifiedName(agent)}`;
  const namePad = Math.max(0, nameColWidth - visibleWidth(namePrefix));
  const coloredState = `${stateColor}${state}${RESET}${" ".repeat(Math.max(0, stateColWidth - state.length))}`;
  const paddedAge = agent.age.padStart(AGE_COL_WIDTH);

  let line: string;
  if (compact) {
    line = `${namePrefix}${" ".repeat(namePad)}  ${coloredState}  ${paddedAge}`;
  } else {
    const promptText = (agent.meta.summary ?? agent.meta.prompt).replace(/\n/g, " ");
    line = `${namePrefix}${" ".repeat(namePad)}  ${coloredState}  ${paddedAge}  ${agent.meta.model}  ${promptText}`;
  }

  const truncated = truncateToWidth(line, width, "");
  if (selected) {
    const pad = Math.max(0, width - visibleWidth(truncated));
    const highlighted = truncated.replaceAll(RESET, RESET + REVERSE);
    return `${REVERSE}${highlighted}${" ".repeat(pad)}${RESET}`;
  }
  return truncated;
}

/**
 * Format a team-header row (§17.2): bold, with a disclosure triangle, the
 * `@name`, and the live member count. e.g. `▾ @backend  (3)`. For an empty team
 * (0 members) it reads `▾ @backend  (0 members)` (§17.2). The anchor renders
 * even at 0 members.
 */
export function formatTeamHeaderRow(
  teamName: string,
  memberCount: number,
  selected: boolean,
  width: number,
): string {
  const triangle = "▾";
  const countBadge = memberCount === 0 ? "(0 members)" : `(${memberCount})`;
  const line = `${BOLD}${triangle} @${teamName}  ${countBadge}${RESET}`;
  const truncated = truncateToWidth(line, width, "");
  if (selected) {
    const pad = Math.max(0, width - visibleWidth(truncated));
    const highlighted = truncated.replaceAll(RESET, RESET + REVERSE);
    return `${REVERSE}${highlighted}${" ".repeat(pad)}${RESET}`;
  }
  return truncated;
}

/**
 * Teams tree component. Parallel to `AgentTreeComponent` and shares its no-
 * selection discipline (§17.1) and scroll/height behavior (§17.2).
 */
export class TeamsTreeComponent implements Component {
  private _flatList: TeamFlatEntry[] = [];
  private selectedIndex = 0;
  maxHeight = MAX_TREE_HEIGHT;
  private scrollOffset = 0;
  /**
   * Whether the Teams panel currently has a selected row (§17.1, symmetric with
   * the Agents tree). Starts false (no-selection). selectedIndex is kept at a
   * non-negative value for the scroll math even when nothing is selected.
   */
  private hasSelection = false;
  /** Focus-driven dimming, matching AgentTreeComponent.suppressSelection. */
  suppressSelection = false;

  get flatList(): TeamFlatEntry[] {
    return this._flatList;
  }

  /**
   * Replace the row list. §17.1: does NOT (re-)assert a selection — the panel
   * starts and stays in no-selection until the user navigates. When a real
   * selection already exists, it is clamped to the new list's bounds.
   */
  setFlatList(list: TeamFlatEntry[]) {
    this._flatList = list;
    if (this.hasSelection) {
      if (list.length === 0) {
        // Nothing left to select.
        this.hasSelection = false;
        this.selectedIndex = 0;
        this.scrollOffset = 0;
      } else if (this.selectedIndex >= list.length) {
        this.selectedIndex = list.length - 1;
        this.ensureSelectedVisible();
      }
    } else {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
    }
  }

  /**
   * Discriminated-union selection (§17.3):
   *  - `{ kind: "team", teamName }` when a `team-header` row is selected,
   *  - `{ kind: "agent", agent }` when a `team-member` row is selected,
   *  - `null` when nothing is selected.
   */
  get selection(): Selection {
    if (!this.hasSelection) return null;
    const list = this._flatList;
    if (this.selectedIndex >= 0 && this.selectedIndex < list.length) {
      const item = list[this.selectedIndex]!;
      if (item.kind === "team-header") return { kind: "team", teamName: item.teamName };
      return { kind: "agent", agent: item.agent };
    }
    return null;
  }

  /** The selected team name, or null when no team header is selected. */
  get selectedTeamName(): string | null {
    const sel = this.selection;
    return sel?.kind === "team" ? sel.teamName : null;
  }

  /** The selected member agent, or null when no team-member row is selected. */
  get selectedMemberAgent(): Agent | null {
    const sel = this.selection;
    return sel?.kind === "agent" ? sel.agent : null;
  }

  /**
   * j/k: move ONE row at a time over the flat list (team header -> its first
   * member -> ... -> next team header -> ...). From no-selection, j (delta>0)
   * selects the FIRST row, k (delta<0) the LAST (§17.1). Subsequent moves wrap.
   */
  navigate(delta: number) {
    const list = this._flatList;
    if (list.length === 0) return;
    const len = list.length;
    if (!this.hasSelection) {
      this.hasSelection = true;
      this.selectedIndex = delta < 0 ? len - 1 : 0;
      this.ensureSelectedVisible();
      return;
    }
    this.selectedIndex = ((this.selectedIndex + delta) % len + len) % len;
    this.ensureSelectedVisible();
  }

  /**
   * shift+j/k: move ANCHOR-TO-ANCHOR between TEAM HEADERS. Landing on a team
   * selects its HEADER (a `{ kind: "team" }` selection — §17.2 resolved
   * default). From no-selection, shift+j (delta>0) lands on the FIRST team
   * anchor, shift+k (delta<0) on the LAST (§17.1).
   */
  navigateAnchor(delta: 1 | -1) {
    const list = this._flatList;
    if (list.length === 0) return;
    const anchors = list
      .map((r, i) => (r.kind === "team-header" ? i : -1))
      .filter((i) => i !== -1);
    if (anchors.length === 0) return;

    if (!this.hasSelection) {
      this.hasSelection = true;
      this.selectedIndex = delta === 1 ? anchors[0]! : anchors[anchors.length - 1]!;
      this.ensureSelectedVisible();
      return;
    }

    // Find the anchor at or above the current selection (the team we're under).
    let currentAnchorIdx = 0;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i]! <= this.selectedIndex) {
        currentAnchorIdx = i;
        break;
      }
    }
    const targetAnchorIdx =
      ((currentAnchorIdx + delta) % anchors.length + anchors.length) % anchors.length;
    this.selectedIndex = anchors[targetAnchorIdx]!;
    this.ensureSelectedVisible();
  }

  /**
   * §17.1 Phase 2 mirror: find the FIRST `team-member` row whose agent id
   * matches and select it (visual only — the dashboard updates
   * `activeSelectionSource` separately when appropriate). If the agent appears
   * under multiple teams, the first occurrence wins (the team registry order
   * from `listTeams()` is stable). Returns true on a hit, false otherwise.
   *
   * Used by the dashboard's `mirrorSelectionToVisibleTree()` so a `0`/`1`
   * sidebar toggle visually highlights the active agent in the newly visible
   * tree when possible.
   */
  selectMemberByAgentId(agentId: string): boolean {
    const list = this._flatList;
    for (let i = 0; i < list.length; i++) {
      const row = list[i]!;
      if (row.kind === "team-member" && row.agent.id === agentId) {
        this.selectedIndex = i;
        this.hasSelection = true;
        this.ensureSelectedVisible();
        return true;
      }
    }
    return false;
  }

  /**
   * §17.1 Phase 2: return the tree to the no-selection state. Visual only —
   * does NOT change which tree owns the active selection. Used by the
   * dashboard when the active selection lives in the Agents tree but has no
   * counterpart in the Teams tree (a repo header, the system coordinator, or
   * an agent that is not a member of any team).
   */
  deselect(): void {
    this.hasSelection = false;
  }

  /** Keep the selected index within the visible scroll window (mirror AgentTree). */
  private ensureSelectedVisible() {
    const lastIndex = this._flatList.length - 1;

    if (this.selectedIndex > 0 && this.selectedIndex - 1 < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex - 1;
    } else if (this.selectedIndex === 0) {
      this.scrollOffset = 0;
    }

    const effectiveScrollOffset = this.scrollOffset === 1 ? 0 : this.scrollOffset;
    const topSlot = effectiveScrollOffset > 0 ? 1 : 0;
    if (this.selectedIndex < lastIndex && this.selectedIndex + 1 >= effectiveScrollOffset + this.maxHeight - topSlot) {
      this.scrollOffset = Math.max(2, this.selectedIndex - this.maxHeight + 3);
    } else if (this.selectedIndex === lastIndex && this.selectedIndex >= effectiveScrollOffset + this.maxHeight - topSlot) {
      this.scrollOffset = Math.max(2, this.selectedIndex - this.maxHeight + 3);
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const list = this._flatList;
    if (list.length === 0) {
      return [truncateToWidth(`${DIM}  No teams (create with: ib team create @<name>)${RESET}`, width, "")];
    }

    const lines: string[] = [];
    let start = this.scrollOffset;

    // §17.1: no row renders in reverse video unless a selection actually exists.
    const selectionActive = this.hasSelection && !this.suppressSelection;

    // If only 1 hidden above, absorb it instead of showing a "▲ 1 more" line.
    if (start === 1) start = 0;

    const topSlot = start > 0 ? 1 : 0;
    const maxContent = this.maxHeight - topSlot;

    let end = Math.min(list.length, start + Math.max(0, maxContent - 1));
    let remaining = list.length - end;

    if (remaining === 0) {
      end = Math.min(list.length, start + maxContent);
      remaining = list.length - end;
    } else if (remaining === 1) {
      end = list.length;
      remaining = 0;
    }

    // Compute name-prefix and state column widths across member rows.
    let maxNameWidth = 0;
    for (const item of list) {
      if (item.kind === "team-member") {
        maxNameWidth = Math.max(maxNameWidth, memberNamePrefixWidth(item.agent, item.connector));
      }
    }
    const stateColWidth = computeTeamStateColWidth(list);

    if (start > 0) {
      lines.push(truncateToWidth(`${DIM}  ▲ ${start} more${RESET}`, width, ""));
    }

    for (let i = start; i < end; i++) {
      const item = list[i]!;
      const selected = selectionActive && i === this.selectedIndex;
      if (item.kind === "team-header") {
        lines.push(formatTeamHeaderRow(item.teamName, item.memberCount, selected, width));
      } else {
        lines.push(formatTeamMemberRow(item.agent, item.connector, selected, width, maxNameWidth, stateColWidth));
      }
    }

    if (remaining > 0) {
      lines.push(truncateToWidth(`${DIM}  ▼ ${remaining} more${RESET}`, width, ""));
    }

    return lines;
  }
}

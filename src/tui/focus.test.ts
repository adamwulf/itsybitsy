import { test, expect, describe } from "bun:test";
import { FocusManager, buildFocusSeparator, buildTabbedFocusSeparator } from "./focus";
import { RESET, BOLD, DIM, DIM_GRAY, REVERSE, BG_DIM_GRAY } from "./colors";

describe("FocusManager", () => {
  test("defaults to agent-tree on startup", () => {
    const fm = new FocusManager();
    expect(fm.current()).toBe("agent-tree");
  });

  test("accepts a custom initial focus", () => {
    const fm = new FocusManager("coordinator");
    expect(fm.current()).toBe("coordinator");
  });

  test("cycle(+1) moves forward through focus order", () => {
    // §17.1: teams-tree is NOT in the cycle — reachable only via the '0' key.
    const fm = new FocusManager("agent-tree");
    fm.cycle(1);
    expect(fm.current()).toBe("info");
    fm.cycle(1);
    expect(fm.current()).toBe("active-agent");
    fm.cycle(1);
    expect(fm.current()).toBe("right-pane");
  });

  test("cycle(+1) wraps from right-pane back to agent-tree", () => {
    const fm = new FocusManager("right-pane");
    fm.cycle(1);
    expect(fm.current()).toBe("agent-tree");
  });

  test("cycle(-1) moves backward through focus order", () => {
    // §17.1: teams-tree is NOT in the cycle — reachable only via the '0' key.
    const fm = new FocusManager("right-pane");
    fm.cycle(-1);
    expect(fm.current()).toBe("active-agent");
    fm.cycle(-1);
    expect(fm.current()).toBe("info");
    fm.cycle(-1);
    expect(fm.current()).toBe("agent-tree");
  });

  test("cycle(-1) wraps from agent-tree to right-pane", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(-1);
    expect(fm.current()).toBe("right-pane");
  });

  test("full forward cycle returns to start", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(1); // info
    fm.cycle(1); // active-agent
    fm.cycle(1); // right-pane
    fm.cycle(1); // agent-tree (repo-coordinator skipped)
    expect(fm.current()).toBe("agent-tree");
  });

  test("full backward cycle returns to start", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(-1); // right-pane (repo-coordinator skipped)
    fm.cycle(-1); // active-agent
    fm.cycle(-1); // info
    fm.cycle(-1); // agent-tree
    expect(fm.current()).toBe("agent-tree");
  });

  test("setFocus() jumps directly to a target", () => {
    const fm = new FocusManager("agent-tree");
    fm.setFocus("active-agent");
    expect(fm.current()).toBe("active-agent");
    fm.setFocus("coordinator");
    expect(fm.current()).toBe("coordinator");
    fm.setFocus("info");
    expect(fm.current()).toBe("info");
    fm.setFocus("right-pane");
    expect(fm.current()).toBe("right-pane");
    fm.setFocus("agent-tree");
    expect(fm.current()).toBe("agent-tree");
  });

  test("setFocus() then cycle() continues from new position", () => {
    const fm = new FocusManager("agent-tree");
    fm.setFocus("info");
    fm.cycle(1);
    expect(fm.current()).toBe("active-agent");
  });

  test("multiple rapid cycles are stable", () => {
    const fm = new FocusManager("agent-tree");
    for (let i = 0; i < 100; i++) fm.cycle(1);
    // 4 active stops (agent-tree, info, active-agent, right-pane;
    // repo-coordinator skipped, teams-tree no longer in cycle).
    // 100 % 4 = 0, so back at index 0 = agent-tree.
    expect(fm.current()).toBe("agent-tree");
  });

  test("subFocus defaults to 'pane'", () => {
    const fm = new FocusManager();
    expect(fm.subFocus).toBe("pane");
  });

  test("setSubFocus changes sub-focus state", () => {
    const fm = new FocusManager();
    fm.setSubFocus("input");
    expect(fm.subFocus).toBe("input");
    fm.setSubFocus("send");
    expect(fm.subFocus).toBe("send");
    fm.setSubFocus("pane");
    expect(fm.subFocus).toBe("pane");
  });

  test("cycle() resets subFocus to 'pane'", () => {
    const fm = new FocusManager("active-agent");
    fm.setSubFocus("input");
    fm.cycle(1); // move to right-pane
    expect(fm.subFocus).toBe("pane");
  });

  test("setFocus() resets subFocus to 'pane'", () => {
    const fm = new FocusManager("agent-tree");
    fm.setSubFocus("send");
    fm.setFocus("coordinator");
    expect(fm.subFocus).toBe("pane");
  });

  test("panelHasInput returns true for active-agent, coordinator, and repo-coordinator", () => {
    expect(FocusManager.panelHasInput("active-agent")).toBe(true);
    expect(FocusManager.panelHasInput("coordinator")).toBe(true);
    expect(FocusManager.panelHasInput("repo-coordinator")).toBe(true);
  });

  test("panelHasInput returns false for other panels", () => {
    expect(FocusManager.panelHasInput("agent-tree")).toBe(false);
    expect(FocusManager.panelHasInput("info")).toBe(false);
    expect(FocusManager.panelHasInput("right-pane")).toBe(false);
    // §17.1: teams-tree is a tree like agent-tree — it has NO input field.
    expect(FocusManager.panelHasInput("teams-tree")).toBe(false);
  });

  test("teams-tree is NOT in cycle but is reachable via setFocus (§17.1)", () => {
    // §17.1: teams-tree was removed from FOCUS_ORDER; the '0' key (handled at
    // the dashboard level) is the only entry point. setFocus must still work.
    const fm = new FocusManager();
    fm.setFocus("teams-tree");
    expect(fm.current()).toBe("teams-tree");
  });

  test("cycle() never lands on teams-tree when sidebarMode='agents' (§17.1 Phase 3)", () => {
    const fm = new FocusManager("agent-tree");
    // Default sidebarMode is "agents" — teams-tree is not in that order.
    fm.skipTargets.delete("repo-coordinator");
    // Cycle many times in both directions and confirm teams-tree is never reached.
    for (let i = 0; i < 50; i++) {
      fm.cycle(1);
      expect(fm.current()).not.toBe("teams-tree");
    }
    for (let i = 0; i < 50; i++) {
      fm.cycle(-1);
      expect(fm.current()).not.toBe("teams-tree");
    }
    // And starting from teams-tree (set via setFocus), a forward cycle must
    // also leave it — cycle() resolves an unknown-position to index 0 and
    // advances from there, landing on the first non-skipped FOCUS_ORDER entry.
    fm.skipTargets.add("repo-coordinator");
    fm.setFocus("teams-tree");
    fm.cycle(1);
    expect(fm.current()).not.toBe("teams-tree");
  });

  test("teams-tree remains reachable via setFocus() (§17.1)", () => {
    const fm = new FocusManager("agent-tree");
    fm.setFocus("teams-tree");
    expect(fm.current()).toBe("teams-tree");
    fm.setFocus("agent-tree");
    expect(fm.current()).toBe("agent-tree");
    fm.setFocus("teams-tree");
    expect(fm.current()).toBe("teams-tree");
  });

  test("repo-coordinator is skipped by default", () => {
    const fm = new FocusManager("right-pane");
    fm.cycle(1);
    expect(fm.current()).toBe("agent-tree");
  });

  test("repo-coordinator is included when removed from skipTargets", () => {
    const fm = new FocusManager("right-pane");
    fm.skipTargets.delete("repo-coordinator");
    fm.cycle(1);
    expect(fm.current()).toBe("repo-coordinator");
  });

  test("cycle forward through all targets including repo-coordinator", () => {
    const fm = new FocusManager("agent-tree");
    fm.skipTargets.delete("repo-coordinator");
    fm.cycle(1); // info
    expect(fm.current()).toBe("info");
    fm.cycle(1); // active-agent
    expect(fm.current()).toBe("active-agent");
    fm.cycle(1); // right-pane
    expect(fm.current()).toBe("right-pane");
    fm.cycle(1); // repo-coordinator
    expect(fm.current()).toBe("repo-coordinator");
    fm.cycle(1); // agent-tree (wrap)
    expect(fm.current()).toBe("agent-tree");
  });

  test("cycle backward through all targets including repo-coordinator", () => {
    const fm = new FocusManager("agent-tree");
    fm.skipTargets.delete("repo-coordinator");
    fm.cycle(-1); // repo-coordinator
    expect(fm.current()).toBe("repo-coordinator");
    fm.cycle(-1); // right-pane
    expect(fm.current()).toBe("right-pane");
    fm.cycle(-1); // active-agent
    expect(fm.current()).toBe("active-agent");
    fm.cycle(-1); // info
    expect(fm.current()).toBe("info");
    fm.cycle(-1); // agent-tree (wrap)
    expect(fm.current()).toBe("agent-tree");
  });

  test("skipTargets can skip multiple targets", () => {
    const fm = new FocusManager("agent-tree");
    fm.skipTargets.delete("repo-coordinator");
    fm.skipTargets.add("info");
    fm.skipTargets.add("active-agent");
    fm.cycle(1); // skips info and active-agent
    expect(fm.current()).toBe("right-pane");
  });

  test("cycle does not infinite loop when all targets are skipped", () => {
    const fm = new FocusManager("agent-tree");
    fm.skipTargets.add("info");
    fm.skipTargets.add("active-agent");
    fm.skipTargets.add("right-pane");
    // repo-coordinator already skipped by default
    fm.cycle(1);
    // Should land on agent-tree (the only non-skipped target)
    expect(fm.current()).toBe("agent-tree");
  });

  // §17.1 Phase 3: cycle() picks TEAMS_FOCUS_ORDER when sidebarMode === "teams".
  // Coordinator mode trumps both — COORDINATOR_FOCUS_ORDER wins regardless of
  // sidebarMode.
  test("sidebarMode='teams' makes cycle use TEAMS_FOCUS_ORDER (§17.1 Phase 3)", () => {
    const fm = new FocusManager("teams-tree");
    fm.sidebarMode = "teams";
    fm.cycle(1);
    expect(fm.current()).toBe("info");
    fm.cycle(1);
    expect(fm.current()).toBe("active-agent");
    fm.cycle(1);
    expect(fm.current()).toBe("right-pane");
    fm.cycle(1);
    // Wraps to teams-tree (no repo-coordinator stop).
    expect(fm.current()).toBe("teams-tree");
  });

  test("sidebarMode='teams' Shift+Tab wraps to right-pane (§17.1 Phase 3)", () => {
    const fm = new FocusManager("teams-tree");
    fm.sidebarMode = "teams";
    fm.cycle(-1);
    expect(fm.current()).toBe("right-pane");
    fm.cycle(-1);
    expect(fm.current()).toBe("active-agent");
    fm.cycle(-1);
    expect(fm.current()).toBe("info");
    fm.cycle(-1);
    expect(fm.current()).toBe("teams-tree");
  });

  test("sidebarMode='teams' cycle never lands on agent-tree or repo-coordinator (§17.1 Phase 3)", () => {
    const fm = new FocusManager("teams-tree");
    fm.sidebarMode = "teams";
    for (let i = 0; i < 50; i++) {
      fm.cycle(1);
      expect(fm.current()).not.toBe("agent-tree");
      expect(fm.current()).not.toBe("repo-coordinator");
    }
    for (let i = 0; i < 50; i++) {
      fm.cycle(-1);
      expect(fm.current()).not.toBe("agent-tree");
      expect(fm.current()).not.toBe("repo-coordinator");
    }
  });

  test("flipping sidebarMode mid-cycle changes which order Tab uses (§17.1 Phase 3)", () => {
    const fm = new FocusManager("agent-tree");
    fm.sidebarMode = "agents";
    fm.cycle(1);
    expect(fm.current()).toBe("info");
    // Flip to teams; the next cycle should advance in TEAMS_FOCUS_ORDER from info.
    fm.sidebarMode = "teams";
    fm.cycle(1);
    expect(fm.current()).toBe("active-agent");
    fm.cycle(1);
    expect(fm.current()).toBe("right-pane");
    fm.cycle(1);
    // Teams order wraps right-pane → teams-tree, not back to agent-tree.
    expect(fm.current()).toBe("teams-tree");
  });

  test("coordinatorMode trumps sidebarMode='teams' (§17.1 Phase 3)", () => {
    const fm = new FocusManager("agent-tree");
    fm.sidebarMode = "teams";
    fm.coordinatorMode = true;
    fm.cycle(1);
    expect(fm.current()).toBe("info");
    fm.cycle(1);
    // Coordinator order is agent-tree → info → coordinator, not teams-tree.
    expect(fm.current()).toBe("coordinator");
    fm.cycle(1);
    expect(fm.current()).toBe("agent-tree");
  });

  test("sidebarMode defaults to 'agents' (§17.1 Phase 3)", () => {
    const fm = new FocusManager();
    expect(fm.sidebarMode).toBe("agents");
  });
});

describe("buildFocusSeparator", () => {
  test("focused separator contains REVERSE escape code on title only", () => {
    const sep = buildFocusSeparator("Agents", 30, true);
    expect(sep).toContain(REVERSE);
    expect(sep).toContain("Agents");
  });

  test("unfocused separator contains DIM escape code", () => {
    const sep = buildFocusSeparator("Agents", 30, false);
    expect(sep).toContain(DIM);
    expect(sep).toContain("Agents");
    expect(sep).not.toContain(REVERSE);
  });

  test("focused separator uses BOLD for title", () => {
    const sep = buildFocusSeparator("Info", 20, true);
    expect(sep).toContain(BOLD);
  });

  test("focused separator dashes use DIM_GRAY not REVERSE", () => {
    const sep = buildFocusSeparator("Test", 30, true);
    // The dashes should be in DIM_GRAY, and REVERSE should only appear around the title
    // Split on the title to check dashes
    const parts = sep.split("Test");
    // Left dashes part should contain DIM_GRAY but not start with REVERSE
    expect(parts[0]).toContain(DIM_GRAY);
  });

  test("separator contains dash characters", () => {
    const sep = buildFocusSeparator("Test", 20, true);
    expect(sep).toContain("─");
  });

  test("uses fixed 4-dash left pad like buildSectionSeparator", () => {
    const sep = buildFocusSeparator("Agents", 40, false);
    // Should start with DIM + DIM_GRAY + 4 dashes (left pad)
    expect(sep).toContain("────");
  });

  test("right pad has at least 1 dash", () => {
    // leftPad(4) + " Test "(6) + rightPad(1 min) = 11 minimum visible chars
    // Use width=12 so truncateToWidth doesn't clip the title
    const sep = buildFocusSeparator("Test", 12, false);
    expect(sep).toContain("Test");
    expect(sep).toContain("─");
  });

  test("separator handles width smaller than title", () => {
    // Should not crash — truncateToWidth will handle overflow
    const sep = buildFocusSeparator("Very Long Title", 5, false);
    // truncateToWidth may truncate the content, but it shouldn't crash
    expect(typeof sep).toBe("string");
  });

  test("focused and unfocused separators are visually distinct", () => {
    const focused = buildFocusSeparator("Agents", 30, true);
    const unfocused = buildFocusSeparator("Agents", 30, false);
    expect(focused).not.toBe(unfocused);
  });
});

describe("buildTabbedFocusSeparator", () => {
  test("focused tab A + pane focused applies REVERSE+BOLD to its label, not the other", () => {
    const sep = buildTabbedFocusSeparator(
      [{ label: "Agents", focused: true }, { label: "Teams", focused: false }],
      40,
      true,
    );
    expect(sep).toContain("Agents");
    expect(sep).toContain("Teams");
    // Find the position of each label's wrapper. The focused tab uses REVERSE+BOLD.
    // We verify by splitting on the label and inspecting the preceding escape.
    const beforeAgents = sep.slice(0, sep.indexOf("Agents"));
    expect(beforeAgents).toContain(REVERSE);
    expect(beforeAgents).toContain(BOLD);
    // The Teams label should be DIM (unfocused tab styling).
    const beforeTeams = sep.slice(0, sep.indexOf("Teams"));
    // Find the most recent DIM in the prefix BEFORE Teams (after the focused
    // RESET that closes the Agents tab).
    const lastReset = beforeTeams.lastIndexOf(RESET);
    const afterReset = beforeTeams.slice(lastReset);
    expect(afterReset).toContain(DIM);
  });

  test("focused tab B + pane focused applies REVERSE+BOLD to its label, not the other", () => {
    const sep = buildTabbedFocusSeparator(
      [{ label: "Agents", focused: false }, { label: "Teams", focused: true }],
      40,
      true,
    );
    expect(sep).toContain("Agents");
    expect(sep).toContain("Teams");
    const beforeTeams = sep.slice(0, sep.indexOf("Teams"));
    // Find the most recent REVERSE after the last RESET — that's the styling
    // applied to the Teams label.
    const lastReset = beforeTeams.lastIndexOf(RESET);
    const afterReset = beforeTeams.slice(lastReset);
    expect(afterReset).toContain(REVERSE);
    expect(afterReset).toContain(BOLD);
    // And the Agents label is DIM (unfocused).
    const beforeAgents = sep.slice(0, sep.indexOf("Agents"));
    expect(beforeAgents).toContain(DIM);
  });

  test("active tab + pane unfocused uses muted BG_DIM_GRAY (no REVERSE)", () => {
    const sep = buildTabbedFocusSeparator(
      [{ label: "Agents", focused: true }, { label: "Teams", focused: false }],
      40,
      false,
    );
    expect(sep).toContain("Agents");
    expect(sep).toContain("Teams");
    // The whole line is wrapped in DIM (matching the unfocused look of
    // buildFocusSeparator) and contains NO REVERSE.
    expect(sep.startsWith(DIM)).toBe(true);
    expect(sep).not.toContain(REVERSE);
    // The active tab's label uses the muted grey background.
    const beforeAgents = sep.slice(0, sep.indexOf("Agents"));
    const lastReset = beforeAgents.lastIndexOf(RESET);
    const afterReset = beforeAgents.slice(lastReset);
    expect(afterReset).toContain(BG_DIM_GRAY);
  });

  test("paneFocused defaults to true (preserves prior behavior)", () => {
    const sep = buildTabbedFocusSeparator(
      [{ label: "Agents", focused: true }, { label: "Teams", focused: false }],
      40,
    );
    expect(sep).toContain(REVERSE);
    expect(sep).toContain(BOLD);
  });

  test("contains 4-dash left pad like buildFocusSeparator", () => {
    const sep = buildTabbedFocusSeparator(
      [{ label: "Agents", focused: true }, { label: "Teams", focused: false }],
      60,
      true,
    );
    expect(sep).toContain("────");
  });

  test("contains dash characters between and around tabs", () => {
    const sep = buildTabbedFocusSeparator(
      [{ label: "Agents", focused: true }, { label: "Teams", focused: false }],
      50,
      true,
    );
    expect(sep).toContain("─");
  });

  test("dashes always use DIM_GRAY", () => {
    const sep = buildTabbedFocusSeparator(
      [{ label: "Agents", focused: true }, { label: "Teams", focused: false }],
      40,
      true,
    );
    expect(sep).toContain(DIM_GRAY);
  });

  test("handles narrow width without crashing", () => {
    const sep = buildTabbedFocusSeparator(
      [{ label: "Agents", focused: true }, { label: "Teams", focused: false }],
      5,
      true,
    );
    expect(typeof sep).toBe("string");
  });
});

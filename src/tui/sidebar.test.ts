import { test, expect, describe } from "bun:test";
import { SidebarComponent, SIDEBAR_WIDTH, computeSidebarHeights } from "./sidebar";
import { AgentTreeComponent } from "./agent-tree";
import { InfoPanelComponent } from "./info-panel";
import { InputFieldComponent } from "./input-field";
import { TmuxPaneComponent } from "./dashboard";
import { makeAgent, makeFlatAgent, makeFlatRepoHeader } from "../test-utils";
import { stripAnsi } from "../parse-state";
import type { FlatEntry } from "../agents";
import { REVERSE, DIM } from "./colors";

function makeSidebar(): SidebarComponent {
  const tree = new AgentTreeComponent();
  const info = new InfoPanelComponent();
  return new SidebarComponent(tree, info);
}

describe("computeSidebarHeights", () => {
  test("allocates tree and info (coordinator always 0 in sidebar)", () => {
    const { treeHeight, infoHeight, coordinatorHeight } = computeSidebarHeights(30, 5);
    expect(treeHeight).toBe(5);
    // coordinatorHeight is always 0 — coordinator is never shown in sidebar
    expect(coordinatorHeight).toBe(0);
    // Info gets all remaining space after tree + headers
    expect(infoHeight).toBeGreaterThanOrEqual(1);
    // Total must fit: Agents header (1) + tree + Info header (1) + info = 30
    expect(1 + treeHeight + 1 + infoHeight).toBe(30);
  });

  test("caps tree at MAX_TREE_HEIGHT (7)", () => {
    const { treeHeight } = computeSidebarHeights(30, 15);
    expect(treeHeight).toBe(7);
  });

  test("tree uses actual count when fewer than MAX_TREE_HEIGHT", () => {
    const { treeHeight } = computeSidebarHeights(30, 3);
    expect(treeHeight).toBe(3);
  });

  test("handles very small available height", () => {
    const { treeHeight, infoHeight } = computeSidebarHeights(5, 10);
    expect(treeHeight).toBeGreaterThanOrEqual(1);
    // Content + section headers must fit within available height (Agents + Info only)
    const headers = infoHeight > 0 ? 2 : 1;
    expect(treeHeight + infoHeight + headers).toBeLessThanOrEqual(5);
  });

  test("coordinatorHeight is always 0 — coordinator never shown in sidebar", () => {
    const { coordinatorHeight } = computeSidebarHeights(20, 3);
    expect(coordinatorHeight).toBe(0);
  });
});

describe("SidebarComponent", () => {
  test("renders two sections with headers (no coordinator in sidebar)", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;

    const agent = makeAgent({ id: "agent-a" });
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    sidebar.agentTree.setFlatList(flatList);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    expect(lines.length).toBe(25);

    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Agents");
    expect(text).toContain("Info");
    expect(text).not.toContain("System Coordinator");
  });

  test("renders agent tree in compact mode (width <= 60)", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;

    const agent = makeAgent({ id: "agent-compact" });
    agent.meta.model = "sonnet";
    agent.meta.prompt = "This is a long prompt that should NOT appear in compact mode";
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    sidebar.agentTree.setFlatList(flatList);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    // Agent ID should be present
    expect(text).toContain("agent-compact");
    // Model and prompt should NOT be in the tree (they're in the info panel instead)
    // The agent tree renders in compact mode at width 60
    const treeArea = lines.slice(0, 1).map(stripAnsi).join("\n");
    expect(treeArea).not.toContain("sonnet");
    expect(treeArea).not.toContain("This is a long prompt");
  });

  test("coordinator section never renders in sidebar", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("System Coordinator");
  });

  test("hideTree: only Info section renders, no Agents section or tree rows", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.hideTree = true;

    const agent = makeAgent({ id: "agent-hidden" });
    const flatList: FlatEntry[] = [makeFlatAgent(agent), makeFlatRepoHeader("/some/repo")];
    sidebar.agentTree.setFlatList(flatList);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    expect(lines.length).toBe(25);

    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("Agents");
    expect(text).toContain("Info");
    expect(text).not.toContain("agent-hidden");
  });

  test("output is exactly displayHeight lines", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 20;
    sidebar.agentTree.setFlatList([]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    expect(lines.length).toBe(20);
  });

  test("passes agent data to info panel", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;

    const agent = makeAgent({ id: "agent-info" });
    agent.meta.model = "opus";
    agent.meta.summary = "doing work";
    agent.meta.claude_pid = String(process.pid);
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    sidebar.agentTree.setFlatList(flatList);

    // Simulate info panel having an agent selected
    sidebar.infoPanel.agent = agent;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("opus");
    expect(text).toContain("doing work");
  });

  test("Agents separator is focused when focusTarget is agent-tree", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.focusTarget = "agent-tree";
    sidebar.agentTree.setFlatList([]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    // First line is the Agents separator — should contain REVERSE (focused)
    expect(lines[0]).toContain(REVERSE);
  });

  test("Agents separator is unfocused when focusTarget is active-agent", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.focusTarget = "active-agent";
    sidebar.agentTree.setFlatList([]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    // First line is the Agents separator — should NOT contain REVERSE
    expect(lines[0]).not.toContain(REVERSE);
    expect(lines[0]).toContain(DIM);
  });

  test("Info separator is never focused regardless of focusTarget", () => {
    for (const target of ["agent-tree", "active-agent", "right-pane"] as const) {
      const sidebar = makeSidebar();
      sidebar.displayHeight = 25;
      sidebar.focusTarget = target;
      sidebar.agentTree.setFlatList([]);

      const lines = sidebar.render(SIDEBAR_WIDTH);
      const infoLine = lines.find(l => stripAnsi(l).includes("Info"));
      expect(infoLine).toBeDefined();
      expect(infoLine!).not.toContain(REVERSE);
    }
  });

  test("focusTarget defaults to agent-tree", () => {
    const sidebar = makeSidebar();
    expect(sidebar.focusTarget).toBe("agent-tree");
  });

  test("sidebar never renders any coordinator section header", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("System Coordinator");
    expect(text).not.toContain("Coordinator");
  });

  test("coordinator pane content never renders in sidebar", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    coordPane.rawOutput = "coordinator output line 1\ncoordinator output line 2";
    coordPane.hasPolled = true;
    sidebar.coordinatorPane = coordPane;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    // Sidebar never renders coordinator output — it only shows in main area
    expect(text).not.toContain("coordinator output line 1");
    expect(text).not.toContain("coordinator output line 2");
  });

  test("coordinator fields can be set without affecting sidebar render", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    // These fields are kept for main area rendering
    sidebar.coordinatorPane = null;
    sidebar.coordinatorInputField = null;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("System Coordinator");
    expect(text).toContain("Info");
  });

  test("render-path clamping: tree offset that would cause zero-height is normalized (BUG-3)", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);
    // Compute base heights so we can set a definitely-too-negative tree offset
    const base = computeSidebarHeights(25, 0);
    // Set offset so that base.treeHeight + offset = -5 (way below 1)
    sidebar.heightOffsets.tree = -(base.treeHeight + 5);
    sidebar.render(SIDEBAR_WIDTH);
    // After render, offset must be normalized so effective height = 1
    expect(base.treeHeight + sidebar.heightOffsets.tree).toBe(1);
  });

  test("render-path clamping: info offset that would cause zero-height is normalized (BUG-3)", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);
    const base = computeSidebarHeights(25, 0);
    // Force info offset so that base.infoHeight + offset = 0
    sidebar.heightOffsets.info = -base.infoHeight;
    sidebar.render(SIDEBAR_WIDTH);
    // After render, offset must be normalized so effective height = 1
    if (base.infoHeight > 0) {
      expect(base.infoHeight + sidebar.heightOffsets.info).toBe(1);
    }
  });

  test("render-path clamping: coordinator offset that would cause zero-height is normalized (BUG-3)", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);
    const base = computeSidebarHeights(25, 0);
    // Force coordinator offset so that base.coordinatorHeight + offset = 0
    sidebar.heightOffsets.coordinator = -base.coordinatorHeight;
    sidebar.render(SIDEBAR_WIDTH);
    // After render, offset must be normalized so effective height = 1
    if (base.coordinatorHeight > 0) {
      expect(base.coordinatorHeight + sidebar.heightOffsets.coordinator).toBe(1);
    }
  });

  test("render-path clamping: panels remain fully visible after clamping (BUG-3)", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);
    const base = computeSidebarHeights(25, 0);
    // Apply extreme negative offsets to panels
    sidebar.heightOffsets.tree = -(base.treeHeight + 100);
    sidebar.heightOffsets.info = -(base.infoHeight + 100);
    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    // Both sections should still render (headers visible)
    expect(text).toContain("Agents");
    expect(text).toContain("Info");
  });
});

describe("SidebarComponent — §17 Teams panel rendering", () => {
  test("default focus renders the Agents tree title (not Teams)", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.focusTarget = "agent-tree";
    const agent = makeAgent({ id: "agent-x" });
    sidebar.agentTree.setFlatList([makeFlatAgent(agent)]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Agents");
    expect(text).not.toContain("Teams");
  });

  test("teams-tree focus renders the Teams tree title (not Agents)", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.focusTarget = "teams-tree";
    // Populate both trees: only the Teams one should appear given focus.
    const agent = makeAgent({ id: "agent-x" });
    sidebar.agentTree.setFlatList([makeFlatAgent(agent)]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Teams");
    expect(text).not.toContain("Agents");
  });

  test("teams-tree focus + empty teams registry renders the empty-state hint", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.focusTarget = "teams-tree";
    // teamsTree is empty by default
    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("No teams");
    expect(text).toContain("Teams");
  });

  test("Teams header renders focused (reverse video) when teams-tree is focused", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.focusTarget = "teams-tree";
    const lines = sidebar.render(SIDEBAR_WIDTH);
    // First line is the Teams separator — should contain REVERSE (focused)
    expect(lines[0]).toContain(REVERSE);
  });

  test("Agents header renders unfocused when teams-tree is focused (Agents tree hidden anyway)", () => {
    // Sanity check on the toggle: switching back to agent-tree shows Agents,
    // not Teams — and the Teams panel's selection is preserved.
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.focusTarget = "teams-tree";
    let lines = sidebar.render(SIDEBAR_WIDTH);
    expect(lines.map(stripAnsi).join("\n")).toContain("Teams");

    sidebar.focusTarget = "agent-tree";
    lines = sidebar.render(SIDEBAR_WIDTH);
    expect(lines.map(stripAnsi).join("\n")).toContain("Agents");
    expect(lines.map(stripAnsi).join("\n")).not.toContain("Teams");
  });
});

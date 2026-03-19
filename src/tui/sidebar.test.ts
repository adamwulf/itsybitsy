import { test, expect, describe } from "bun:test";
import { SidebarComponent, SIDEBAR_WIDTH, computeSidebarHeights } from "./sidebar";
import { AgentTreeComponent } from "./agent-tree";
import { InfoPanelComponent } from "./info-panel";
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
  test("allocates tree, info, and coordinator with standard available height", () => {
    const { treeHeight, infoHeight, coordinatorHeight } = computeSidebarHeights(30, 5);
    expect(treeHeight).toBe(5);
    // remaining = 30 - 1(Agents header) - 5 = 24
    // coordinator = max(5, floor(24*0.4)) = max(5, 9) = 9
    // info = 24 - 9 - 1(Coordinator header) - 1(Info header) = 13
    expect(coordinatorHeight).toBe(9);
    expect(infoHeight).toBe(13);
    // Total with headers: 1 + 5 + 1 + 13 + 1 + 9 = 30
    expect(1 + treeHeight + 1 + infoHeight + 1 + coordinatorHeight).toBe(30);
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
    const { treeHeight, infoHeight, coordinatorHeight } = computeSidebarHeights(5, 10);
    expect(treeHeight).toBeGreaterThanOrEqual(1);
    // Content + section headers must fit within available height
    const headers = infoHeight > 0 ? 3 : (coordinatorHeight > 0 ? 2 : 1);
    expect(treeHeight + infoHeight + coordinatorHeight + headers).toBeLessThanOrEqual(5);
  });

  test("minimum coordinator height is 5", () => {
    const { coordinatorHeight } = computeSidebarHeights(20, 3);
    expect(coordinatorHeight).toBeGreaterThanOrEqual(5);
  });
});

describe("SidebarComponent", () => {
  test("renders three sections with headers", () => {
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
    expect(text).toContain("Coordinator");
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

  test("coordinator section shows placeholder", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("coordinator");
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

  test("Agents separator is unfocused when focusTarget is coordinator", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.focusTarget = "coordinator";
    sidebar.agentTree.setFlatList([]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    // First line is the Agents separator — should NOT contain REVERSE
    expect(lines[0]).not.toContain(REVERSE);
    expect(lines[0]).toContain(DIM);
  });

  test("Coordinator separator is focused when focusTarget is coordinator", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.focusTarget = "coordinator";
    sidebar.agentTree.setFlatList([]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.join("\n");
    // Find the Coordinator separator line
    const coordLine = lines.find(l => stripAnsi(l).includes("Coordinator"));
    expect(coordLine).toBeDefined();
    expect(coordLine!).toContain(REVERSE);
  });

  test("Info separator is never focused regardless of focusTarget", () => {
    for (const target of ["agent-tree", "coordinator", "active-agent"] as const) {
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

  test("section header says 'System Coordinator' not 'Coordinator'", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("System Coordinator");
    // Should NOT have bare "Coordinator" without "System" prefix
    // (other than as part of "System Coordinator")
    const bare = lines.filter(l => {
      const s = stripAnsi(l);
      return s.includes("Coordinator") && !s.includes("System Coordinator");
    });
    expect(bare.length).toBe(0);
  });

  test("renders coordinator pane content when coordinatorPane is set", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    // Create a coordinator pane with some output
    const coordPane = new TmuxPaneComponent();
    coordPane.rawOutput = "coordinator output line 1\ncoordinator output line 2";
    coordPane.hasPolled = true;
    // TmuxPaneComponent needs an agent to render output, but for coordinator
    // we use it without an agent — it shows "No agent selected" placeholder.
    // The dashboard will set a fake agent for the coordinator pane.
    sidebar.coordinatorPane = coordPane;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    // Without an agent set, it shows "No agent selected"
    expect(text).toContain("No agent selected");
  });

  test("renders placeholder when coordinatorPane is null", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);
    sidebar.coordinatorPane = null;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("coordinator");
    expect(text).toContain("not yet active");
  });
});

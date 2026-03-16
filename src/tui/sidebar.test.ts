import { test, expect, describe } from "bun:test";
import { SidebarComponent, SIDEBAR_WIDTH, computeSidebarHeights } from "./sidebar";
import { AgentTreeComponent } from "./agent-tree";
import { InfoPanelComponent } from "./info-panel";
import { makeAgent, makeFlatAgent, makeFlatRepoHeader } from "../test-utils";
import { stripAnsi } from "../parse-state";
import type { FlatEntry } from "../agents";

function makeSidebar(): SidebarComponent {
  const tree = new AgentTreeComponent();
  const info = new InfoPanelComponent();
  return new SidebarComponent(tree, info);
}

describe("computeSidebarHeights", () => {
  test("allocates tree, info, and coordinator with standard available height", () => {
    const { treeHeight, infoHeight, coordinatorHeight } = computeSidebarHeights(30, 5);
    expect(treeHeight).toBe(5);
    // afterTree = 30 - 5 = 25
    // coordinator = max(5, floor(25*0.4)) = max(5, 10) = 10
    // info = 25 - 10 - 2(separators) = 13
    expect(coordinatorHeight).toBe(10);
    expect(infoHeight).toBe(13);
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
    // May not have room for info or coordinator
    expect(treeHeight + infoHeight + coordinatorHeight).toBeLessThanOrEqual(5 + 2); // +2 for separators
  });

  test("minimum coordinator height is 5", () => {
    const { coordinatorHeight } = computeSidebarHeights(20, 3);
    expect(coordinatorHeight).toBeGreaterThanOrEqual(5);
  });
});

describe("SidebarComponent", () => {
  test("renders three sections with separators", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;

    const agent = makeAgent({ id: "agent-a" });
    const flatList: FlatEntry[] = [makeFlatAgent(agent)];
    sidebar.agentTree.setFlatList(flatList);

    const lines = sidebar.render(SIDEBAR_WIDTH);
    expect(lines.length).toBe(25);

    const text = lines.map(stripAnsi).join("\n");
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
});

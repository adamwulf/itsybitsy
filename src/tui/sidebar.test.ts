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
    sidebar.coordinatorPane = coordPane;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    // Sidebar renders coordinator output directly (bypasses TmuxPaneComponent agent check)
    expect(text).toContain("coordinator output line 1");
    expect(text).toContain("coordinator output line 2");
  });

  test("renders stopped message when coordinator has polled but no output", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    coordPane.hasPolled = true;
    coordPane.rawOutput = "";
    sidebar.coordinatorPane = coordPane;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("System coordinator stopped");
    expect(text).toContain("Press R to restart");
  });

  test("renders loading message when coordinator has not polled yet", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    coordPane.hasPolled = false;
    coordPane.rawOutput = "";
    sidebar.coordinatorPane = coordPane;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Starting system coordinator");
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

  test("renders coordinator input field when active", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    coordPane.rawOutput = "coordinator output";
    coordPane.hasPolled = true;
    sidebar.coordinatorPane = coordPane;

    const inputField = new InputFieldComponent();
    inputField.active = true;
    sidebar.coordinatorInputField = inputField;

    // Type text into input field
    inputField.handleInput("h");
    inputField.handleInput("i");

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("> hi█");
    expect(text).toContain("[Send]");
    expect(text).toContain("coordinator output");
  });

  test("does not render coordinator input field when not active", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    coordPane.rawOutput = "coordinator output";
    coordPane.hasPolled = true;
    sidebar.coordinatorPane = coordPane;

    const inputField = new InputFieldComponent();
    inputField.active = false;
    sidebar.coordinatorInputField = inputField;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("[Send]");
    expect(text).not.toContain("█");
    expect(text).toContain("coordinator output");
  });

  test("coordinator input field reduces coordinator output height", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    coordPane.rawOutput = "line\n".repeat(50);
    coordPane.hasPolled = true;
    sidebar.coordinatorPane = coordPane;

    // Render without input field
    const inputField = new InputFieldComponent();
    inputField.active = false;
    sidebar.coordinatorInputField = inputField;
    const linesWithout = sidebar.render(SIDEBAR_WIDTH);

    // Render with input field active
    inputField.active = true;
    const linesWith = sidebar.render(SIDEBAR_WIDTH);

    // Total height should be the same (displayHeight)
    expect(linesWith.length).toBe(linesWithout.length);
    // But input field lines should appear at the bottom of the coordinator section
    const textWith = linesWith.map(stripAnsi).join("\n");
    expect(textWith).toContain("[Send]");
  });

  test("coordinator status lines appear after input field when focused", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    // Simulate tmux output with two separators and status text after the lower one
    const sep = "─".repeat(SIDEBAR_WIDTH);
    coordPane.rawOutput = `some output\n${sep}\nmiddle text\n${sep}\nstatus info`;
    coordPane.hasPolled = true;
    sidebar.coordinatorPane = coordPane;

    const inputField = new InputFieldComponent();
    inputField.active = true;
    sidebar.coordinatorInputField = inputField;
    inputField.handleInput("h");
    inputField.handleInput("i");

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");

    // Input field should be present
    expect(text).toContain("> hi█");
    expect(text).toContain("[Send]");
    // Status info (after lower separator) should appear after the input field
    expect(text).toContain("status info");
    // The output above the upper separator should still be visible
    expect(text).toContain("some output");
    // The "middle text" between separators should be trimmed (it's between upper and lower)
    expect(text).not.toContain("middle text");

    // Verify order: status info comes after [Send]
    const sendIdx = text.indexOf("[Send]");
    const statusIdx = text.indexOf("status info");
    expect(statusIdx).toBeGreaterThan(sendIdx);
  });

  test("coordinator output trims trailing blank lines for bottom-pin", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    coordPane.rawOutput = "line one\nline two\n\n\n\n";
    coordPane.hasPolled = true;
    sidebar.coordinatorPane = coordPane;

    const inputField = new InputFieldComponent();
    inputField.active = false;
    sidebar.coordinatorInputField = inputField;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const stripped = lines.map(stripAnsi);

    // "line two" should be the last non-empty line in the coordinator section
    // Find where "line two" appears
    const lineTwoIdx = stripped.findIndex((l) => l.includes("line two"));
    expect(lineTwoIdx).toBeGreaterThan(-1);
    // All lines after "line two" within the coordinator section should be empty
    // (the next non-empty content would be the status bar or end of render)
    // The point is that blank lines from the tmux output don't push content up
    const lineOneIdx = stripped.findIndex((l) => l.includes("line one"));
    expect(lineOneIdx).toBe(lineTwoIdx - 1);
  });

  test("coordinator status lines trim trailing blanks from tmux padding", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 30;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    const sep = "─".repeat(SIDEBAR_WIDTH);
    // Simulate tmux capture-pane output: status text followed by many trailing blank lines
    coordPane.rawOutput = `some output\n${sep}\nmiddle\n${sep}\nstatus\n\n\n\n\n\n\n\n\n\n`;
    coordPane.hasPolled = true;
    sidebar.coordinatorPane = coordPane;

    const inputField = new InputFieldComponent();
    inputField.active = true;
    sidebar.coordinatorInputField = inputField;

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const stripped = lines.map(stripAnsi);
    const text = stripped.join("\n");

    // Status line should appear but trailing blanks should not inflate the layout
    expect(text).toContain("status");
    expect(text).toContain("[Send]");
    expect(text).toContain("some output");

    // "status" should be the last non-empty line (trailing blanks trimmed)
    const statusIdx = stripped.findLastIndex((l) => l.includes("status"));
    expect(statusIdx).toBeGreaterThan(-1);
    // No non-empty lines after "status" in the rendered output (except padding)
    const linesAfterStatus = stripped.slice(statusIdx + 1).filter((l) => l.trim() !== "");
    expect(linesAfterStatus.length).toBe(0);
  });

  test("coordinator input field renders in full-width coordinator layout", () => {
    const sidebar = makeSidebar();
    sidebar.displayHeight = 25;
    sidebar.coordinatorFullWidth = true;
    sidebar.agentTree.setFlatList([]);

    const coordPane = new TmuxPaneComponent();
    coordPane.rawOutput = "coordinator output";
    coordPane.hasPolled = true;
    sidebar.coordinatorPane = coordPane;

    const inputField = new InputFieldComponent();
    inputField.active = true;
    sidebar.coordinatorInputField = inputField;
    inputField.handleInput("t");
    inputField.handleInput("e");
    inputField.handleInput("s");
    inputField.handleInput("t");

    const lines = sidebar.render(SIDEBAR_WIDTH);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("> test█");
    expect(text).toContain("[Send]");
    expect(text).toContain("coordinator output");
  });
});

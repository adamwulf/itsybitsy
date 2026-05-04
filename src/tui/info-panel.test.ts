import { test, expect, describe } from "bun:test";
import { InfoPanelComponent } from "./info-panel";
import { makeAgent, makeFlatAgent, makeFlatRepoHeader, setAgentState } from "../test-utils";
import { stripAnsi } from "../parse-state";
import type { FlatEntry } from "../agents";

describe("InfoPanelComponent", () => {
  test("renders 'No selection' when nothing selected", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 5;
    const lines = panel.render(60);
    expect(lines.length).toBe(5);
    expect(stripAnsi(lines[0]!)).toContain("No selection");
  });

  test("renders agent info with stoplight indicators", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 10;
    const agent = makeAgent({ id: "agent-abc" });
    // Use current process PID so the "alive" check passes
    agent.meta.claude_pid = String(process.pid);
    agent.meta.watchdog_pid = 99999999; // non-existent PID
    agent.meta.model = "opus";
    agent.meta.summary = "Test summary text";
    panel.agent = agent;

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Claude");
    expect(text).toContain("Watchdog");
    expect(text).toContain("opus");
    expect(text).toContain("Test summary text");
    expect(lines.length).toBe(10);
  });

  test("renders model name from agent meta", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 8;
    const agent = makeAgent({ id: "agent-xyz" });
    agent.meta.model = "sonnet";
    agent.meta.prompt = "build a widget";
    panel.agent = agent;

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("sonnet");
    expect(text).toContain("build a widget");
  });

  test("renders repo info when repo header selected", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 5;
    panel.selectedRepoHeader = "my-repo";
    panel.selectedRepoPath = "/path/to/my-repo";

    const agent1 = makeAgent({ id: "agent-a", repoName: "my-repo" });
    setAgentState(agent1, "running");
    const agent2 = makeAgent({ id: "agent-b", repoName: "my-repo" });
    setAgentState(agent2, "waiting");

    panel.allAgents = [
      makeFlatAgent(agent1),
      makeFlatAgent(agent2),
    ];

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("/path/to/my-repo");
    expect(text).toContain("Agents: 2");
    expect(text).toContain("running: 1");
    expect(text).toContain("waiting: 1");
  });

  test("pads output to displayHeight", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 15;
    const agent = makeAgent({ id: "agent-short" });
    agent.meta.prompt = "short";
    panel.agent = agent;

    const lines = panel.render(60);
    expect(lines.length).toBe(15);
  });

  test("truncates output to displayHeight when content is long", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 3;
    const agent = makeAgent({ id: "agent-long" });
    agent.meta.prompt = "a very long prompt that spans multiple lines when wrapped within 60 columns or less";
    panel.agent = agent;

    const lines = panel.render(60);
    expect(lines.length).toBe(3);
  });

  test("claude PID alive shows green indicator (current PID)", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 5;
    const agent = makeAgent({ id: "agent-pid" });
    agent.meta.claude_pid = String(process.pid);
    panel.agent = agent;

    const lines = panel.render(60);
    // Green ANSI code \x1b[32m should appear for Claude
    expect(lines[0]!).toContain("\x1b[32m");
  });

  test("shows orphan warning with 'not found' when manager missing", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 10;
    const agent = makeAgent({ id: "agent-orphan" });
    agent.orphaned = true;
    agent.meta.manager = "agent-gone";
    panel.agent = agent;
    panel.allAgents = [makeFlatAgent(agent)];

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Manager not found: agent-gone");
    // Verify YELLOW ANSI color is used for the warning
    const rawText = lines.join("\n");
    expect(rawText).toContain("\x1b[33m");
  });

  test("shows orphan warning with 'archived' when manager is archived", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 10;
    const agent = makeAgent({ id: "agent-orphan2" });
    agent.orphaned = true;
    agent.meta.manager = "agent-old-mgr";
    const archivedManager = makeAgent({ id: "agent-old-mgr" });
    archivedManager.archived = true;
    panel.agent = agent;
    panel.allAgents = [makeFlatAgent(agent), makeFlatAgent(archivedManager)];

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Manager archived: agent-old-mgr");
    // Verify YELLOW ANSI color is used for the warning
    const rawText = lines.join("\n");
    expect(rawText).toContain("\x1b[33m");
  });

  test("no orphan warning for non-orphaned agent", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 10;
    const agent = makeAgent({ id: "agent-ok" });
    agent.orphaned = false;
    agent.meta.manager = "agent-mgr";
    panel.agent = agent;

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("Manager not found");
    expect(text).not.toContain("Manager archived");
  });

  test("orphan warning truncates gracefully at narrow width", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 10;
    const agent = makeAgent({ id: "agent-narrow" });
    agent.orphaned = true;
    agent.meta.manager = "agent-long-manager-id";
    panel.agent = agent;
    panel.allAgents = [];

    const lines = panel.render(15);
    const stripped = lines.map(stripAnsi);
    // Warning should be present but truncated — no crash
    expect(stripped.join("\n")).toContain("Manager");
    expect(lines.length).toBe(10);
    // Every visible line must fit within the requested width
    for (const line of stripped) {
      expect(line.length).toBeLessThanOrEqual(15);
    }
  });

  test("repo info shows coordinator stoplights when coordinator agent is set", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 10;
    panel.selectedRepoHeader = "my-repo";
    panel.selectedRepoPath = "/path/to/my-repo";

    const coord = makeAgent({ id: "agent-coord", repoName: "my-repo" });
    coord.meta.coordinator = true;
    coord.meta.claude_pid = String(process.pid); // alive
    coord.meta.watchdog_pid = 99999999; // dead
    coord.meta.tmux_session = "ib-coord-my-repo";
    panel.repoCoordinatorAgent = coord;
    panel.liveTmuxSessions = new Set(["ib-coord-my-repo"]);

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Coord Claude");
    expect(text).toContain("Coord Watchdog");
    expect(text).toContain("Coord Tmux");
    expect(text).toContain("/path/to/my-repo");
    // Claude should be green (alive PID)
    expect(lines[0]!).toContain("\x1b[32m");
    // Watchdog should be red (dead PID)
    expect(lines[1]!).toContain("\x1b[31m");
    // Tmux should be green (in liveTmuxSessions)
    expect(lines[2]!).toContain("\x1b[32m");
  });

  test("repo info omits coordinator stoplights when no coordinator agent", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 5;
    panel.selectedRepoHeader = "my-repo";
    panel.selectedRepoPath = "/path/to/my-repo";
    panel.repoCoordinatorAgent = null;

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("Coord Claude");
    expect(text).not.toContain("Coord Watchdog");
    expect(text).not.toContain("Coord Tmux");
    expect(text).toContain("/path/to/my-repo");
  });

  test("claude PID dead shows red indicator", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 5;
    const agent = makeAgent({ id: "agent-dead" });
    agent.meta.claude_pid = "99999999";
    panel.agent = agent;

    const lines = panel.render(60);
    // Red ANSI code \x1b[31m should appear for Claude
    expect(lines[0]!).toContain("\x1b[31m");
  });
});

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

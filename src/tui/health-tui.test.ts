/**
 * Tests for health check TUI integration:
 * - Agent tree repo header warning indicators
 * - Info panel health summary line
 * - REPO pane mode health section (rendered at full main width)
 */

import { test, expect, describe } from "bun:test";
import { AgentTreeComponent } from "./agent-tree";
import { InfoPanelComponent } from "./info-panel";
import { RightPaneComponent } from "./pane-manager";
import { makeAgent, makeFlatAgent, makeFlatRepoHeader, setAgentState } from "../test-utils";
import { stripAnsi } from "../parse-state";
import type { RepoHealthReport, RepoHealthWarning } from "../health-check";

function makeWarning(overrides: Partial<RepoHealthWarning> = {}): RepoHealthWarning {
  return {
    repoPath: "/test/repo",
    severity: "warning",
    category: "test",
    message: "Test warning",
    ...overrides,
  };
}

function makeReport(repoPath: string, warnings: RepoHealthWarning[] = []): RepoHealthReport {
  return {
    repoPath,
    checkedAt: Date.now(),
    warnings,
  };
}

describe("Agent tree health indicators", () => {
  test("shows 🔴 when repo has error-severity warnings", () => {
    const tree = new AgentTreeComponent();
    const repoPath = "/test/repo";
    tree.setFlatList([
      makeFlatRepoHeader("my-repo", repoPath, true),
      makeFlatAgent(makeAgent({ id: "agent-a", repoName: "my-repo", repoPath })),
    ]);
    tree.healthReports.set(repoPath, makeReport(repoPath, [
      makeWarning({ repoPath, severity: "error", message: "Broken config" }),
    ]));

    const lines = tree.render(80);
    const headerLine = stripAnsi(lines[0]!);
    expect(headerLine).toContain("my-repo");
    expect(lines[0]).toContain("🔴");
  });

  test("shows ⚠️ when repo has warning-severity but no errors", () => {
    const tree = new AgentTreeComponent();
    const repoPath = "/test/repo";
    tree.setFlatList([
      makeFlatRepoHeader("my-repo", repoPath, true),
      makeFlatAgent(makeAgent({ id: "agent-a", repoName: "my-repo", repoPath })),
    ]);
    tree.healthReports.set(repoPath, makeReport(repoPath, [
      makeWarning({ repoPath, severity: "warning", message: "Minor issue" }),
    ]));

    const lines = tree.render(80);
    expect(lines[0]).toContain("⚠️");
    expect(lines[0]).not.toContain("🔴");
  });

  test("shows no indicator when repo is clean", () => {
    const tree = new AgentTreeComponent();
    const repoPath = "/test/repo";
    tree.setFlatList([
      makeFlatRepoHeader("my-repo", repoPath, true),
      makeFlatAgent(makeAgent({ id: "agent-a", repoName: "my-repo", repoPath })),
    ]);
    tree.healthReports.set(repoPath, makeReport(repoPath, []));

    const lines = tree.render(80);
    expect(lines[0]).not.toContain("🔴");
    expect(lines[0]).not.toContain("⚠️");
  });

  test("shows no indicator when no health report exists yet", () => {
    const tree = new AgentTreeComponent();
    const repoPath = "/test/repo";
    tree.setFlatList([
      makeFlatRepoHeader("my-repo", repoPath, true),
      makeFlatAgent(makeAgent({ id: "agent-a", repoName: "my-repo", repoPath })),
    ]);
    // No healthReports.set()

    const lines = tree.render(80);
    expect(lines[0]).not.toContain("🔴");
    expect(lines[0]).not.toContain("⚠️");
  });

  test("🔴 takes priority over ⚠️ when both severities present", () => {
    const tree = new AgentTreeComponent();
    const repoPath = "/test/repo";
    tree.setFlatList([
      makeFlatRepoHeader("my-repo", repoPath, true),
      makeFlatAgent(makeAgent({ id: "agent-a", repoName: "my-repo", repoPath })),
    ]);
    tree.healthReports.set(repoPath, makeReport(repoPath, [
      makeWarning({ repoPath, severity: "warning", message: "Minor" }),
      makeWarning({ repoPath, severity: "error", message: "Critical" }),
      makeWarning({ repoPath, severity: "info", message: "FYI" }),
    ]));

    const lines = tree.render(80);
    expect(lines[0]).toContain("🔴");
  });
});

describe("Info panel health summary", () => {
  test("shows Health: ✅ OK when no warnings", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 10;
    panel.selectedRepoHeader = "my-repo";
    panel.selectedRepoPath = "/test/repo";
    panel.allAgents = [];
    panel.healthReport = makeReport("/test/repo", []);

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Health:");
    expect(text).toContain("OK");
  });

  test("shows error and warning counts", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 10;
    panel.selectedRepoHeader = "my-repo";
    panel.selectedRepoPath = "/test/repo";
    panel.allAgents = [];
    panel.healthReport = makeReport("/test/repo", [
      makeWarning({ severity: "error", message: "E1" }),
      makeWarning({ severity: "error", message: "E2" }),
      makeWarning({ severity: "warning", message: "W1" }),
    ]);

    const lines = panel.render(80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("2 errors");
    expect(text).toContain("1 warning");
  });

  test("no health line when healthReport is undefined", () => {
    const panel = new InfoPanelComponent();
    panel.displayHeight = 10;
    panel.selectedRepoHeader = "my-repo";
    panel.selectedRepoPath = "/test/repo";
    panel.allAgents = [];
    panel.healthReport = undefined;

    const lines = panel.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("Health:");
  });
});

describe("REPO pane health section", () => {
  test("shows health section with warnings sorted by severity", () => {
    const pane = new RightPaneComponent();
    pane.selectedRepoHeader = "my-repo";
    pane.allAgents = [makeFlatRepoHeader("my-repo", "/test/repo", false)];
    pane.healthReport = makeReport("/test/repo", [
      makeWarning({ severity: "info", message: "Info msg" }),
      makeWarning({ severity: "error", message: "Error msg" }),
      makeWarning({ severity: "warning", message: "Warning msg" }),
    ]);
    pane.setMode("REPO");

    const lines = pane.render(80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Health");
    expect(text).toContain("Error msg");
    expect(text).toContain("Warning msg");
    expect(text).toContain("Info msg");

    // Error should appear before warning
    const errorIdx = text.indexOf("Error msg");
    const warningIdx = text.indexOf("Warning msg");
    const infoIdx = text.indexOf("Info msg");
    expect(errorIdx).toBeLessThan(warningIdx);
    expect(warningIdx).toBeLessThan(infoIdx);
  });

  test("shows fix suggestions when available", () => {
    const pane = new RightPaneComponent();
    pane.selectedRepoHeader = "my-repo";
    pane.allAgents = [makeFlatRepoHeader("my-repo", "/test/repo", false)];
    pane.healthReport = makeReport("/test/repo", [
      makeWarning({ severity: "error", message: "Leaked hook", fix: "Remove the hook entry" }),
    ]);
    pane.setMode("REPO");

    const lines = pane.render(80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Fix: Remove the hook entry");
  });

  test("shows ✅ when clean", () => {
    const pane = new RightPaneComponent();
    pane.selectedRepoHeader = "my-repo";
    pane.allAgents = [makeFlatRepoHeader("my-repo", "/test/repo", false)];
    pane.healthReport = makeReport("/test/repo", []);
    pane.setMode("REPO");

    const lines = pane.render(80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("No configuration issues detected");
  });

  test("shows ✅ when no health report", () => {
    const pane = new RightPaneComponent();
    pane.selectedRepoHeader = "my-repo";
    pane.allAgents = [makeFlatRepoHeader("my-repo", "/test/repo", false)];
    pane.healthReport = undefined;
    pane.setMode("REPO");

    const lines = pane.render(80);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("No configuration issues detected");
  });
});

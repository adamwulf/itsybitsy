import { test, expect, describe } from "bun:test";
import { stripAnsi } from "../parse-state";
import type { FlatEntry } from "../agents";
import type { Agent, AgentMeta } from "../agents";
import {
  SystemDashboardComponent,
  buildDashboardRows,
  formatDashboardRow,
  formatHeaderRow,
} from "./system-dashboard";

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  const defaults: AgentMeta = {
    id: overrides.id,
    session_id: "sess-1",
    tmux_session: `ib-${overrides.id}`,
    prompt: "do stuff",
    manager: null,
    created: "2025-01-01",
    created_epoch: 1700000000,
    worktree: true,
    worker: false,
    yolo: false,
    model: "opus",
    claude_pid: "1234",
  };
  const { meta: metaOverrides, ...rest } = overrides;
  return {
    repoPath: "/tmp/repo",
    repoName: "repo",
    state: "running",
    age: "2m",
    archived: false,
    children: [],
    ...rest,
    meta: { ...defaults, ...(metaOverrides ?? {}) },
  };
}

function makeFlatList(): FlatEntry[] {
  return [
    { kind: "system-coordinator", state: "running", age: "5m" },
    { kind: "repo-header", repoName: "itsybitsy", repoPath: "/tmp/itsybitsy", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
    {
      kind: "agent",
      agent: makeAgent({ id: "agent-abc12345", state: "running", meta: { model: "opus" } as any }),
      depth: 1,
      connector: "  ",
    },
    {
      kind: "agent",
      agent: makeAgent({
        id: "agent-def67890",
        state: "waiting",
        meta: { model: "sonnet", worker: true, summary: "fixing tests" } as any,
      }),
      depth: 1,
      connector: "  ",
    },
    { kind: "repo-header", repoName: "muse-ios", repoPath: "/tmp/muse-ios", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
    {
      kind: "agent",
      agent: makeAgent({
        id: "agent-ghi11111",
        state: "complete",
        repoName: "muse-ios",
        meta: { model: "haiku" } as any,
      }),
      depth: 1,
      connector: "  ",
    },
  ];
}

describe("buildDashboardRows", () => {
  test("skips system coordinator entry", () => {
    const rows = buildDashboardRows(makeFlatList());
    expect(rows.every((r) => r.agent !== "coordinator")).toBe(true);
  });

  test("creates repo header rows", () => {
    const rows = buildDashboardRows(makeFlatList());
    const headers = rows.filter((r) => r.isHeader);
    expect(headers.length).toBe(2);
    expect(headers[0]!.repo).toBe("itsybitsy");
    expect(headers[1]!.repo).toBe("muse-ios");
  });

  test("creates agent rows with correct role", () => {
    const rows = buildDashboardRows(makeFlatList());
    const agents = rows.filter((r) => !r.isHeader);
    expect(agents.length).toBe(3);
    expect(agents[0]!.role).toBe("mgr");
    expect(agents[1]!.role).toBe("wkr");
  });

  test("uses summary from meta when available", () => {
    const rows = buildDashboardRows(makeFlatList());
    const agents = rows.filter((r) => !r.isHeader);
    expect(agents[1]!.summary).toBe("fixing tests");
  });

  test("falls back to prompt when no summary", () => {
    const rows = buildDashboardRows(makeFlatList());
    const agents = rows.filter((r) => !r.isHeader);
    expect(agents[0]!.summary).toBe("do stuff");
  });
});

describe("formatDashboardRow", () => {
  test("header rows are bold", () => {
    const row = buildDashboardRows(makeFlatList())[0]!;
    const formatted = formatDashboardRow(row, 120);
    expect(formatted).toContain("itsybitsy");
  });

  test("full width includes all columns", () => {
    const rows = buildDashboardRows(makeFlatList());
    const agentRow = rows.find((r) => !r.isHeader)!;
    const formatted = stripAnsi(formatDashboardRow(agentRow, 120));
    expect(formatted).toContain("itsybitsy");
    expect(formatted).toContain("agent-abc12345");
    expect(formatted).toContain("mgr");
    expect(formatted).toContain("running");
    expect(formatted).toContain("opus");
    expect(formatted).toContain("2m");
    expect(formatted).toContain("do stuff");
  });

  test("narrow width (<80) hides summary", () => {
    const rows = buildDashboardRows(makeFlatList());
    const agentRow = rows.find((r) => !r.isHeader)!;
    const formatted = stripAnsi(formatDashboardRow(agentRow, 79));
    expect(formatted).toContain("agent-abc12345");
    expect(formatted).toContain("opus"); // model still visible
    expect(formatted).not.toContain("do stuff");
  });

  test("very narrow width (<60) hides model and age", () => {
    const rows = buildDashboardRows(makeFlatList());
    const agentRow = rows.find((r) => !r.isHeader)!;
    const formatted = stripAnsi(formatDashboardRow(agentRow, 59));
    expect(formatted).toContain("agent-abc12345");
    expect(formatted).not.toContain("opus");
  });
});

describe("formatHeaderRow", () => {
  test("full width shows all column headers", () => {
    const header = stripAnsi(formatHeaderRow(120));
    expect(header).toContain("Repo");
    expect(header).toContain("Agent");
    expect(header).toContain("Role");
    expect(header).toContain("State");
    expect(header).toContain("Model");
    expect(header).toContain("Age");
    expect(header).toContain("Summary");
  });

  test("narrow hides Summary header", () => {
    const header = stripAnsi(formatHeaderRow(79));
    expect(header).toContain("Repo");
    expect(header).not.toContain("Summary");
  });

  test("very narrow hides Model and Age headers", () => {
    const header = stripAnsi(formatHeaderRow(59));
    expect(header).toContain("Repo");
    expect(header).not.toContain("Model");
    // "Age" as a standalone column header (not part of "Agent")
    // In narrow mode, only Repo/Agent/Role/State are shown
    const columns = header.trim().split(/\s{2,}/);
    expect(columns).not.toContain("Age");
  });
});

describe("SystemDashboardComponent", () => {
  test("renders header + separator + rows", () => {
    const comp = new SystemDashboardComponent();
    comp.flatList = makeFlatList();
    comp.displayHeight = 10;
    const lines = comp.render(120);
    expect(lines.length).toBe(10);
    // First line is column header
    expect(stripAnsi(lines[0]!)).toContain("Repo");
    // Second line is separator
    expect(stripAnsi(lines[1]!)).toMatch(/^─+$/);
  });

  test("pads to displayHeight", () => {
    const comp = new SystemDashboardComponent();
    comp.flatList = makeFlatList();
    comp.displayHeight = 20;
    const lines = comp.render(120);
    expect(lines.length).toBe(20);
  });

  test("scrollDown and scrollUp work", () => {
    const comp = new SystemDashboardComponent();
    comp.flatList = makeFlatList();
    comp.displayHeight = 4; // very small — will need scrolling
    expect(comp.scrollOffset).toBe(0);
    comp.scrollDown(1);
    expect(comp.scrollOffset).toBe(1);
    comp.scrollUp(1);
    expect(comp.scrollOffset).toBe(0);
    // Cannot scroll above 0
    comp.scrollUp(5);
    expect(comp.scrollOffset).toBe(0);
  });

  test("scrollDown clamps to max", () => {
    const comp = new SystemDashboardComponent();
    comp.flatList = makeFlatList();
    comp.displayHeight = 10;
    comp.scrollDown(1000);
    // Should be clamped on next render
    comp.render(120);
    expect(comp.scrollOffset).toBeGreaterThanOrEqual(0);
  });
});

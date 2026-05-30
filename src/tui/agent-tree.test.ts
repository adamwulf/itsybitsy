import { test, expect, describe } from "bun:test";
import { agentDisplayName, formatAgentRow, COMPACT_WIDTH_THRESHOLD } from "./agent-tree";
import { makeAgent } from "../test-utils";
import { stripAnsi } from "../parse-state";

describe("agentDisplayName", () => {
  test("returns the nickname when set", () => {
    const agent = makeAgent({ id: "agent-abc123" });
    agent.meta.nickname = "pikachu";
    expect(agentDisplayName(agent)).toBe("pikachu");
  });

  test("falls back to the id when no nickname is set", () => {
    const agent = makeAgent({ id: "agent-abc123" });
    expect(agentDisplayName(agent)).toBe("agent-abc123");
  });
});

describe("formatAgentRow nickname rendering", () => {
  test("compact row shows the nickname ALONE (not the id)", () => {
    const agent = makeAgent({ id: "agent-longidhere" });
    agent.meta.nickname = "snorlax";
    // Width at/below the compact threshold forces compact mode.
    const row = stripAnsi(formatAgentRow(agent, "", false, COMPACT_WIDTH_THRESHOLD, 20, 8));
    expect(row).toContain("snorlax");
    expect(row).not.toContain("agent-longidhere");
  });

  test("full-width row also shows the nickname in the name column", () => {
    const agent = makeAgent({ id: "agent-longidhere" });
    agent.meta.nickname = "snorlax";
    const row = stripAnsi(formatAgentRow(agent, "", false, 160, 20, 8));
    expect(row).toContain("snorlax");
    expect(row).not.toContain("agent-longidhere");
  });

  test("row shows the id when no nickname is set", () => {
    const agent = makeAgent({ id: "agent-plainid" });
    const row = stripAnsi(formatAgentRow(agent, "", false, 160, 20, 8));
    expect(row).toContain("agent-plainid");
  });
});

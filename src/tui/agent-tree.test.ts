import { test, expect, describe } from "bun:test";
import {
  AgentTreeComponent,
  formatAgentRow,
  displayState,
  computeStateColWidth,
  MAX_TREE_HEIGHT,
} from "./agent-tree";
import type { Agent, FlatEntry } from "../agents";

function makeAgent(id: string, state: string = "running", overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    repoPath: `/repos/${id}`,
    repoName: "myrepo",
    meta: {
      id,
      session_id: `sess-${id}`,
      tmux_session: `ittybitty-myrepo-${id}`,
      prompt: `Task for ${id}`,
      manager: null,
      created: "2025-01-01T00:00:00Z",
      created_epoch: 1735689600,
      worktree: true,
      worker: false,
      yolo: false,
      model: "sonnet",
      claude_pid: "12345",
    },
    state: state as Agent["state"],
    age: "5m",
    archived: false,
    children: [],
    ...overrides,
  };
}

function makeFlat(agents: Agent[]): FlatEntry[] {
  return agents.map((agent) => ({
    kind: "agent" as const,
    agent,
    depth: 0,
    connector: "",
  }));
}

/** A flat list with a repo header anchor preceding each repo group. */
function makeFlatWithHeaders(groups: Array<{ repoName: string; repoPath: string; agents: Agent[] }>): FlatEntry[] {
  const result: FlatEntry[] = [];
  for (const g of groups) {
    result.push({ kind: "repo-header", repoName: g.repoName, repoPath: g.repoPath, hasAgents: g.agents.length > 0 });
    for (const agent of g.agents) {
      result.push({ kind: "agent", agent, depth: 1, connector: "" });
    }
  }
  return result;
}

describe("AgentTreeComponent", () => {
  test("starts empty", () => {
    const tree = new AgentTreeComponent();
    expect(tree.flatList).toEqual([]);
  });

  test("setFlatList populates the list", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2")];
    tree.setFlatList(makeFlat(agents));
    expect(tree.flatList.length).toBe(2);
  });

  // §17.1: the Agents panel STARTS in no-selection — no row is auto-selected
  // on first populate.
  test("starts in no-selection after first populate (§17.1)", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2")];
    tree.setFlatList(makeFlat(agents));
    expect(tree.selection).toBeNull();
    expect(tree.selectedAgent).toBeNull();
  });

  // §17.1: repopulating while in no-selection STAYS in no-selection — setFlatList
  // must not silently re-assert a selection.
  test("repopulating while in no-selection stays in no-selection (§17.1)", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlat([makeAgent("agent-1")]));
    expect(tree.selection).toBeNull();
    tree.setFlatList(makeFlat([makeAgent("agent-1"), makeAgent("agent-2")]));
    expect(tree.selection).toBeNull();
    expect(tree.selectedAgent).toBeNull();
  });

  // §17.1: j (delta>0) from no-selection selects the FIRST visible row.
  test("j from no-selection selects the first row (§17.1)", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2"), makeAgent("agent-3")];
    tree.setFlatList(makeFlat(agents));
    tree.moveSelection(1);
    expect(tree.selectedAgent?.id).toBe("agent-1");
  });

  // §17.1: k (delta<0) from no-selection selects the LAST visible row.
  test("k from no-selection selects the last row (§17.1)", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2"), makeAgent("agent-3")];
    tree.setFlatList(makeFlat(agents));
    tree.moveSelection(-1);
    expect(tree.selectedAgent?.id).toBe("agent-3");
  });

  // Once a selection exists, j/k behave as before (move + wrap-around).
  test("moveSelection moves down once a selection exists", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2")];
    tree.setFlatList(makeFlat(agents));
    tree.moveSelection(1); // no-selection -> first (agent-1)
    expect(tree.selectedAgent?.id).toBe("agent-1");
    tree.moveSelection(1); // first -> second (agent-2)
    expect(tree.selectedAgent?.id).toBe("agent-2");
  });

  test("moveSelection wraps around once a selection exists", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2")];
    tree.setFlatList(makeFlat(agents));
    tree.moveSelection(1); // -> agent-1
    tree.moveSelection(-1); // wrap up from first -> last (agent-2)
    expect(tree.selectedAgent?.id).toBe("agent-2");
  });

  test("selectAgentById selects by id and sets a selection (§17.1)", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2"), makeAgent("agent-3")];
    tree.setFlatList(makeFlat(agents));
    expect(tree.selection).toBeNull(); // starts in no-selection
    const found = tree.selectAgentById("agent-2");
    expect(found).toBe(true);
    expect(tree.selectedAgent?.id).toBe("agent-2");
    expect(tree.selection).not.toBeNull();
  });

  test("selectAgentById returns false for unknown id and leaves no-selection", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1")];
    tree.setFlatList(makeFlat(agents));
    const found = tree.selectAgentById("nonexistent");
    expect(found).toBe(false);
    expect(tree.selection).toBeNull();
  });

  // §17.1: shift+j (moveToRepo +1) from no-selection lands on the FIRST anchor.
  test("shift+j from no-selection lands on the first anchor (§17.1)", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatWithHeaders([
      { repoName: "alpha", repoPath: "/repos/alpha", agents: [makeAgent("a1"), makeAgent("a2")] },
      { repoName: "beta", repoPath: "/repos/beta", agents: [makeAgent("b1"), makeAgent("b2")] },
    ]));
    expect(tree.selection).toBeNull();
    tree.moveToRepo(1);
    // First anchor (alpha) -> its first agent.
    expect(tree.selectedAgent?.id).toBe("a1");
  });

  // §17.1: shift+k (moveToRepo -1) from no-selection lands on the LAST anchor.
  test("shift+k from no-selection lands on the last anchor (§17.1)", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatWithHeaders([
      { repoName: "alpha", repoPath: "/repos/alpha", agents: [makeAgent("a1"), makeAgent("a2")] },
      { repoName: "beta", repoPath: "/repos/beta", agents: [makeAgent("b1"), makeAgent("b2")] },
    ]));
    expect(tree.selection).toBeNull();
    tree.moveToRepo(-1);
    // Last anchor (beta) -> its last agent.
    expect(tree.selectedAgent?.id).toBe("b2");
  });

  test("render shows agents", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2")];
    tree.setFlatList(makeFlat(agents));
    const lines = tree.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  // §17.1: with no selection, no row is rendered in reverse video.
  test("render shows no reverse-video row in no-selection (§17.1)", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2")];
    tree.setFlatList(makeFlat(agents));
    const reverse = "\x1b[7m";
    const joined = tree.render(80).join("\n");
    expect(joined).not.toContain(reverse);
    // After selecting, the selected row DOES render in reverse video.
    tree.moveSelection(1);
    const joined2 = tree.render(80).join("\n");
    expect(joined2).toContain(reverse);
  });

  test("render shows empty message", () => {
    const tree = new AgentTreeComponent();
    const lines = tree.render(80);
    expect(lines[0]).toContain("No agents found");
  });

  test("scroll indicators appear with many agents", () => {
    const tree = new AgentTreeComponent();
    const agents = Array.from({ length: 20 }, (_, i) => makeAgent(`agent-${i}`));
    tree.setFlatList(makeFlat(agents));
    tree.moveSelection(1); // need a selection to anchor the scroll window
    const lines = tree.render(80);
    const joined = lines.join("\n");
    expect(joined).toContain("more");
  });

  test("moveToRepo with no repo headers does nothing harmful", () => {
    const tree = new AgentTreeComponent();
    const agents = [makeAgent("agent-1"), makeAgent("agent-2")];
    tree.setFlatList(makeFlat(agents));
    tree.moveToRepo(1);
    // With no repo headers, selection should remain valid (an agent row).
    expect(tree.selectedAgent).toBeTruthy();
  });
});

describe("agent-tree helpers", () => {
  test("displayState maps unknown to running", () => {
    expect(displayState("unknown")).toBe("running");
    expect(displayState("waiting")).toBe("waiting");
  });

  test("computeStateColWidth respects the minimum", () => {
    const flat = makeFlat([makeAgent("a", "running")]);
    expect(computeStateColWidth(flat)).toBeGreaterThanOrEqual(8);
  });

  test("formatAgentRow renders the id", () => {
    const row = formatAgentRow(makeAgent("agent-x"), "", false, 80, 20);
    expect(row).toContain("agent-x");
  });

  test("MAX_TREE_HEIGHT is 7", () => {
    expect(MAX_TREE_HEIGHT).toBe(7);
  });
});

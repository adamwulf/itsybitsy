import { test, expect, describe } from "bun:test";
import {
  AgentTreeComponent,
  formatAgentRow,
  displayState,
  computeStateColWidth,
  MAX_TREE_HEIGHT,
  nextRepoFilter,
} from "./agent-tree";
import { isRunningState, type Agent, type FlatEntry } from "../agents";

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
    const hasRunningAgents = g.agents.some((a) => isRunningState(a.state));
    result.push({ kind: "repo-header", repoName: g.repoName, repoPath: g.repoPath, hasAgents: g.agents.length > 0, hasRunningAgents });
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

  // HIGH 1 regression: moving off a selected-empty-repo header must leave
  // selectedIndex, selectedId, and visibleList[selectedIndex] mutually
  // consistent. Pre-fix, the sticky-reveal repo path was derived from the
  // live selectedId inside visibleList, so visibleList shrank between the
  // updateSelectedId and ensureSelectedVisible reads — leaving selectedIndex
  // pointing one row past the intended landing in the shrunken list.
  test("HIGH 1: j off a selected empty repo header keeps selection consistent", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      // Non-empty repo A with one agent
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      // Empty repo X (this is the one we'll sit on)
      { kind: "repo-header", repoName: "xerox", repoPath: "/repos/xerox", hasAgents: false, hasRunningAgents: false },
      // Non-empty repo Z with one agent
      { kind: "repo-header", repoName: "zulu", repoPath: "/repos/zulu", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: makeAgent("z1", "running", { repoName: "zulu", repoPath: "/repos/zulu" }), depth: 1, connector: "" },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("non-empty");
    // Sit on the empty repo header. With "non-empty" filter on, it remains
    // visible because it is the current selection — visibleList is
    // [headerA, agentA1, headerX (sticky), headerZ, agentZ1] = length 5.
    expect(tree.selectByRepoPath("/repos/xerox")).toBe(true);
    expect(tree.visibleList.length).toBe(5);
    expect(tree.selectedRepoPath).toBe("/repos/xerox");

    // Press j — should land on the next visible row (headerZ).
    tree.moveSelection(1);

    // headerX should now be hidden again (selection moved off it). visibleList
    // is now [headerA, agentA1, headerZ, agentZ1] (length 4), and selection
    // should be on headerZ at index 2.
    const visible = tree.visibleList;
    expect(visible.length).toBe(4);
    expect(visible.some((f) => f.kind === "repo-header" && f.repoPath === "/repos/xerox")).toBe(false);
    expect(tree.selectedRepoPath).toBe("/repos/zulu");
    // Crux: selectedIndex must point to the row matching selectedId in the
    // POST-mutation visibleList.
    const sel = tree.selection;
    expect(sel?.kind).toBe("repo-header");
    if (sel?.kind === "repo-header") {
      expect(sel.repoPath).toBe("/repos/zulu");
    }
    const matched = visible.findIndex(
      (f) => f.kind === "repo-header" && f.repoPath === "/repos/zulu"
    );
    expect(matched).not.toBe(-1);
    // The visibleList row reachable via the public selection getter must be
    // the same row identified by selectedRepoPath/selectedId — that's the
    // consistency invariant the bug violated.
    const selRepoPath = (sel?.kind === "repo-header") ? sel.repoPath : null;
    expect(selRepoPath).toBe(visible[matched]!.kind === "repo-header" ? "/repos/zulu" : null);
  });

  // Cycling repoFilter back to "all" while sitting on an empty header should
  // leave the selection intact (the header was visible-when-selected, and is
  // now visible unconditionally).
  test("setRepoFilter('all') while on an empty header preserves selection", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "repo-header", repoName: "xerox", repoPath: "/repos/xerox", hasAgents: false, hasRunningAgents: false },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("non-empty");
    tree.selectByRepoPath("/repos/xerox");
    expect(tree.selectedRepoPath).toBe("/repos/xerox");
    tree.setRepoFilter("all");
    expect(tree.selectedRepoPath).toBe("/repos/xerox");
    expect(tree.visibleList.length).toBe(3); // both headers + one agent
  });

  // The @ fuzzy-jump scenario: selecting an agent in an otherwise-hidden empty
  // repo should reveal that repo's header. (The repo has an agent so it isn't
  // strictly "empty", but this also covers the case where selectAgentById is
  // called on a freshly-spawned agent in a previously-empty repo before the
  // flatList catches up — sticky stays null and the header reappears via
  // hasAgents on the next setFlatList.)
  test("selectAgentById on an agent in a non-empty repo leaves sticky null", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: false, hasRunningAgents: false },
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: makeAgent("b1", "running", { repoName: "beta", repoPath: "/repos/beta" }), depth: 1, connector: "" },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("non-empty");
    // Alpha is hidden (empty, not selected). Beta is visible.
    expect(tree.visibleList.length).toBe(2);
    // Select b1 — beta is already visible via hasAgents.
    expect(tree.selectAgentById("b1")).toBe(true);
    expect(tree.selectedAgent?.id).toBe("b1");
    // Alpha is still hidden because nothing in alpha is selected.
    expect(tree.visibleList.some((f) => f.kind === "repo-header" && f.repoPath === "/repos/alpha")).toBe(false);
  });

  // --- running-only filter -------------------------------------------------

  test("running-only hides repos with no running agents", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      // Repo with a running agent
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      // Repo with only waiting agents (no running)
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: true, hasRunningAgents: false },
      { kind: "agent", agent: makeAgent("b1", "waiting", { repoName: "beta", repoPath: "/repos/beta" }), depth: 1, connector: "" },
      // Empty repo
      { kind: "repo-header", repoName: "gamma", repoPath: "/repos/gamma", hasAgents: false, hasRunningAgents: false },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    // Only alpha's header and a1 remain.
    expect(visible.length).toBe(2);
    expect(visible[0]!.kind).toBe("repo-header");
    if (visible[0]!.kind === "repo-header") expect(visible[0]!.repoPath).toBe("/repos/alpha");
    expect(visible[1]!.kind).toBe("agent");
  });

  test("running-only hides non-running agents within visible repos", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a2", "waiting", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a3", "creating", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a4", "compacting", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a5", "complete", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    // Header + a1 (running) + a3 (creating) + a4 (compacting); a2/a5 hidden.
    const agentIds = visible.filter((f) => f.kind === "agent").map((f) => (f as Extract<FlatEntry, { kind: "agent" }>).agent.id);
    expect(agentIds).toEqual(["a1", "a3", "a4"]);
  });

  test("running-only keeps the selected non-running agent visible (sticky)", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: false },
      { kind: "agent", agent: makeAgent("a1", "waiting", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a2", "waiting", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
    ];
    tree.setFlatList(flat);
    expect(tree.selectAgentById("a1")).toBe(true);
    tree.setRepoFilter("running-only");
    // Alpha's header has no running agents but is sticky-revealed because a1
    // is selected. a1 itself stays visible; a2 (also waiting, not selected)
    // is hidden.
    const visible = tree.visibleList;
    expect(visible.some((f) => f.kind === "repo-header" && f.repoPath === "/repos/alpha")).toBe(true);
    const agentIds = visible.filter((f) => f.kind === "agent").map((f) => (f as Extract<FlatEntry, { kind: "agent" }>).agent.id);
    expect(agentIds).toEqual(["a1"]);
  });

  // running-only must show the ancestors of a running agent — a 'waiting'
  // manager with a 'running' child stays visible so the child isn't orphaned
  // under a hidden parent.
  test("running-only keeps a waiting manager whose child is running visible", () => {
    const tree = new AgentTreeComponent();
    const child = makeAgent("child-1", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: {
        ...makeAgent("child-1").meta,
        manager: "mgr-1",
      },
    });
    const mgr = makeAgent("mgr-1", "waiting", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      children: [child],
    });
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: mgr, depth: 0, connector: "└── " },
      { kind: "agent", agent: child, depth: 1, connector: "    └── " },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    const agentIds = visible.filter((f) => f.kind === "agent").map((f) => (f as Extract<FlatEntry, { kind: "agent" }>).agent.id);
    expect(agentIds).toEqual(["mgr-1", "child-1"]);
  });

  // After filtering, connectors must reflect ONLY the visible subset: a single
  // visible child of a single visible parent gets a '└── ' connector under its
  // parent, not '├── ' pointing at hidden siblings.
  test("running-only recomputes connectors for the visible subset", () => {
    const tree = new AgentTreeComponent();
    // Tree: mgr (waiting)
    //   ├── child-a (running)
    //   ├── child-b (waiting)   <-- hidden by filter
    //   └── child-c (waiting)   <-- hidden by filter
    const childA = makeAgent("child-a", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("child-a").meta, manager: "mgr-1" },
    });
    const childB = makeAgent("child-b", "waiting", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("child-b").meta, manager: "mgr-1" },
    });
    const childC = makeAgent("child-c", "waiting", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("child-c").meta, manager: "mgr-1" },
    });
    const mgr = makeAgent("mgr-1", "waiting", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      children: [childA, childB, childC],
    });
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: mgr, depth: 0, connector: "└── " },
      { kind: "agent", agent: childA, depth: 1, connector: "    ├── " },
      { kind: "agent", agent: childB, depth: 1, connector: "    ├── " },
      { kind: "agent", agent: childC, depth: 1, connector: "    └── " },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    const agentEntries = visible.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent");
    expect(agentEntries.map((e) => e.agent.id)).toEqual(["mgr-1", "child-a"]);
    // mgr is the sole visible root in its repo group → its connector starts with the root marker.
    expect(agentEntries[0]!.connector).toBe("└── ");
    // child-a is the sole visible child of mgr → '└── ' under mgr (which itself was last),
    // so the prefix for mgr's level is 4 spaces, then '└── ' for child-a.
    expect(agentEntries[1]!.connector).toBe("    └── ");
  });

  // The 'non-empty' and 'all' modes must NOT recompute connectors — they use
  // the precomputed values from flattenAgentTree as-is.
  test("non-empty and all modes preserve precomputed connectors", () => {
    const tree = new AgentTreeComponent();
    const childA = makeAgent("child-a", "waiting", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("child-a").meta, manager: "mgr-1" },
    });
    const childB = makeAgent("child-b", "waiting", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("child-b").meta, manager: "mgr-1" },
    });
    const mgr = makeAgent("mgr-1", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      children: [childA, childB],
    });
    // Use deliberately-distinctive sentinel connectors so a recomputation
    // would replace them with the canonical box-drawing strings and fail.
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: mgr, depth: 0, connector: "SENTINEL-MGR" },
      { kind: "agent", agent: childA, depth: 1, connector: "SENTINEL-A" },
      { kind: "agent", agent: childB, depth: 1, connector: "SENTINEL-B" },
    ];
    tree.setFlatList(flat);
    for (const mode of ["all", "non-empty"] as const) {
      tree.setRepoFilter(mode);
      const visible = tree.visibleList;
      const agentEntries = visible.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent");
      expect(agentEntries.map((e) => e.connector)).toEqual(["SENTINEL-MGR", "SENTINEL-A", "SENTINEL-B"]);
    }
  });

  // Defensive: a cycle in meta.manager (self-reference or A→B→A) must NOT
  // hang the connector walk. visibleList is called every render — an infinite
  // loop here would freeze the TUI. The chief guarantee is termination with a
  // valid connector for every visible agent; the specific shape under a
  // degenerate cycle is whatever the chain walk happens to produce.
  test("running-only handles meta.manager cycles without hanging", () => {
    const tree = new AgentTreeComponent();
    // Self-cycle: agent's manager is itself. The walk drops the self-edge
    // immediately, so this agent has no effective ancestors (a root).
    const selfCycle = makeAgent("self-cycle", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("self-cycle").meta, manager: "self-cycle" },
    });
    // Two-cycle: A.manager=B, B.manager=A. Each walk takes one step into the
    // other before the visited-set guard breaks the loop.
    const cycleA = makeAgent("cycle-a", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("cycle-a").meta, manager: "cycle-b" },
    });
    const cycleB = makeAgent("cycle-b", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("cycle-b").meta, manager: "cycle-a" },
    });
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: selfCycle, depth: 0, connector: "├── " },
      { kind: "agent", agent: cycleA, depth: 0, connector: "├── " },
      { kind: "agent", agent: cycleB, depth: 0, connector: "└── " },
    ];
    tree.setFlatList(flat);
    // The real assertion is that the call returns (i.e. does not hang).
    const visible = tree.visibleList;
    tree.setRepoFilter("running-only");
    const filtered = tree.visibleList;
    expect(visible.length).toBeGreaterThan(0);
    const agentEntries = filtered.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent");
    expect(agentEntries.map((e) => e.agent.id)).toEqual(["self-cycle", "cycle-a", "cycle-b"]);
    // Every visible agent must have a non-empty, well-formed connector
    // (ending in '└── ' or '├── '); we don't pin the exact shape under a
    // pathological cycle.
    for (const entry of agentEntries) {
      expect(entry.connector.endsWith("└── ") || entry.connector.endsWith("├── ")).toBe(true);
    }
  });

  // Orphaned manager: meta.manager points at a non-existent id. The chain
  // walker must drop it and treat the agent as a visible root.
  test("running-only treats an orphaned manager id as a root", () => {
    const tree = new AgentTreeComponent();
    const orphan = makeAgent("orphan", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("orphan").meta, manager: "ghost-id-does-not-exist" },
    });
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: orphan, depth: 0, connector: "└── " },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    const agentEntries = visible.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent");
    expect(agentEntries.map((e) => e.agent.id)).toEqual(["orphan"]);
    // Sole visible root in a repo group → '└── '.
    expect(agentEntries[0]!.connector).toBe("└── ");
  });

  // Cross-repo meta.manager: an agent in repo alpha whose meta.manager points
  // at an agent in repo beta must be treated as a root inside repo alpha. The
  // beta agent must NOT be admitted to alpha's ancestor chain (which would
  // produce a phantom indent referencing a parent that isn't in the group).
  test("running-only does not connect agents across repo boundaries", () => {
    const tree = new AgentTreeComponent();
    const betaMgr = makeAgent("beta-mgr", "running", {
      repoName: "beta",
      repoPath: "/repos/beta",
    });
    const alphaChild = makeAgent("alpha-child", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("alpha-child").meta, manager: "beta-mgr" },
    });
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: alphaChild, depth: 0, connector: "└── " },
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: betaMgr, depth: 0, connector: "└── " },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    const agentEntries = visible.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent");
    expect(agentEntries.map((e) => e.agent.id)).toEqual(["alpha-child", "beta-mgr"]);
    // Both should be effective roots in their own repo group → '└── '.
    expect(agentEntries[0]!.connector).toBe("└── ");
    expect(agentEntries[1]!.connector).toBe("└── ");
  });

  // Multi-root single-repo (no repo headers): two visible running roots must
  // both get depth-0 ├── / └── connectors — exercises the visibleRootCount > 1
  // path, which is the branch that must NOT fall into the empty-connector
  // carve-out.
  test("running-only single-repo multi-root produces ├── / └──", () => {
    const tree = new AgentTreeComponent();
    const rootA = makeAgent("root-a", "running", {
      repoName: "myrepo",
      repoPath: "/repos/myrepo",
    });
    const rootB = makeAgent("root-b", "running", {
      repoName: "myrepo",
      repoPath: "/repos/myrepo",
    });
    const flat: FlatEntry[] = [
      { kind: "agent", agent: rootA, depth: 0, connector: "├── " },
      { kind: "agent", agent: rootB, depth: 0, connector: "└── " },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    const agentEntries = visible.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent");
    expect(agentEntries.map((e) => e.agent.id)).toEqual(["root-a", "root-b"]);
    expect(agentEntries[0]!.connector).toBe("├── ");
    expect(agentEntries[1]!.connector).toBe("└── ");
  });

  // Multi-repo: sibling state must reset at each group boundary. Two agents
  // share the same effective parent (null) in their own repo, and each is the
  // sole / last sibling in its repo group — neither should bleed lastByParent
  // from the other repo.
  test("running-only resets sibling state across repo groups", () => {
    const tree = new AgentTreeComponent();
    const alphaChild = makeAgent("child-a", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
    });
    const betaChild = makeAgent("child-X", "running", {
      repoName: "beta",
      repoPath: "/repos/beta",
    });
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: alphaChild, depth: 0, connector: "└── " },
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: true, hasRunningAgents: true },
      { kind: "agent", agent: betaChild, depth: 0, connector: "└── " },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    const agentEntries = visible.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent");
    expect(agentEntries.map((e) => e.agent.id)).toEqual(["child-a", "child-X"]);
    // Each is the sole visible root within its own repo group → '└── '. If
    // group state bled across, child-a would become non-last ('├── ').
    expect(agentEntries[0]!.connector).toBe("└── ");
    expect(agentEntries[1]!.connector).toBe("└── ");
  });

  test("nextRepoFilter cycles all → non-empty → running-only → all", () => {
    expect(nextRepoFilter("all")).toBe("non-empty");
    expect(nextRepoFilter("non-empty")).toBe("running-only");
    expect(nextRepoFilter("running-only")).toBe("all");
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

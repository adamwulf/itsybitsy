import { test, expect, describe } from "bun:test";
import {
  AgentTreeComponent,
  formatAgentRow,
  displayState,
  computeStateColWidth,
  MAX_TREE_HEIGHT,
  nextRepoFilter,
} from "./agent-tree";
import { isRunningState, isVisibleUnderRunningFilter, type Agent, type FlatEntry } from "../agents";

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
    const hasNonStoppedAgents = g.agents.some((a) => isVisibleUnderRunningFilter(a.state));
    result.push({ kind: "repo-header", repoName: g.repoName, repoPath: g.repoPath, hasAgents: g.agents.length > 0, hasRunningAgents, hasNonStoppedAgents });
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      // Empty repo X (this is the one we'll sit on)
      { kind: "repo-header", repoName: "xerox", repoPath: "/repos/xerox", hasAgents: false, hasRunningAgents: false, hasNonStoppedAgents: false },
      // Non-empty repo Z with one agent
      { kind: "repo-header", repoName: "zulu", repoPath: "/repos/zulu", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "repo-header", repoName: "xerox", repoPath: "/repos/xerox", hasAgents: false, hasRunningAgents: false, hasNonStoppedAgents: false },
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: false, hasRunningAgents: false, hasNonStoppedAgents: false },
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
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

  // running-only now hides ONLY stopped agents (and repos whose agents are
  // ALL stopped). A repo with a waiting/complete agent is NON-stopped, so it
  // stays visible; only the all-stopped repo (and the empty repo) drop out.
  test("running-only hides repos whose agents are all stopped", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      // Repo with a running agent
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      // Repo with only waiting agents (no running, but NON-stopped) — now shown.
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("b1", "waiting", { repoName: "beta", repoPath: "/repos/beta" }), depth: 1, connector: "" },
      // Repo whose only agent is stopped — hidden (all agents stopped).
      { kind: "repo-header", repoName: "delta", repoPath: "/repos/delta", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: false },
      { kind: "agent", agent: makeAgent("d1", "stopped", { repoName: "delta", repoPath: "/repos/delta" }), depth: 1, connector: "" },
      // Empty repo — hidden.
      { kind: "repo-header", repoName: "gamma", repoPath: "/repos/gamma", hasAgents: false, hasRunningAgents: false, hasNonStoppedAgents: false },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    // alpha (running) + a1, and beta (waiting) + b1 remain; delta and gamma drop.
    const repoPaths = visible.filter((f) => f.kind === "repo-header").map((f) => (f as Extract<FlatEntry, { kind: "repo-header" }>).repoPath);
    expect(repoPaths).toEqual(["/repos/alpha", "/repos/beta"]);
    const agentIds = visible.filter((f) => f.kind === "agent").map((f) => (f as Extract<FlatEntry, { kind: "agent" }>).agent.id);
    expect(agentIds).toEqual(["a1", "b1"]);
  });

  // running-only hides ONLY stopped agents within a visible repo; every other
  // state (running/waiting/complete/creating/compacting) stays shown.
  test("running-only hides only stopped agents within visible repos", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a2", "waiting", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a3", "creating", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a4", "compacting", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a5", "complete", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a6", "stopped", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    // All non-stopped agents shown (a1..a5); only a6 (stopped) is hidden.
    const agentIds = visible.filter((f) => f.kind === "agent").map((f) => (f as Extract<FlatEntry, { kind: "agent" }>).agent.id);
    expect(agentIds).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  // A STOPPED agent (the only state running-only hides) that is SELECTED stays
  // visible via the selection carve-out, along with its sticky-revealed header;
  // the other, unselected stopped agent stays hidden.
  test("running-only keeps the selected stopped agent visible (sticky)", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: false },
      { kind: "agent", agent: makeAgent("a1", "stopped", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a2", "stopped", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
    ];
    tree.setFlatList(flat);
    expect(tree.selectAgentById("a1")).toBe(true);
    tree.setRepoFilter("running-only");
    // Alpha's header has no non-stopped agents but is sticky-revealed because
    // a1 is selected. a1 itself stays visible; a2 (also stopped, not selected)
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
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
    //   ├── child-b (stopped)   <-- hidden by filter
    //   └── child-c (stopped)   <-- hidden by filter
    const childA = makeAgent("child-a", "running", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("child-a").meta, manager: "mgr-1" },
    });
    const childB = makeAgent("child-b", "stopped", {
      repoName: "alpha",
      repoPath: "/repos/alpha",
      meta: { ...makeAgent("child-b").meta, manager: "mgr-1" },
    });
    const childC = makeAgent("child-c", "stopped", {
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: alphaChild, depth: 0, connector: "└── " },
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
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
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: alphaChild, depth: 0, connector: "└── " },
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
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

  // --- pinned repos --------------------------------------------------------

  test("togglePinnedRepo flips membership true then false", () => {
    const tree = new AgentTreeComponent();
    expect(tree.pinnedRepoPaths.has("/repos/alpha")).toBe(false);
    expect(tree.togglePinnedRepo("/repos/alpha")).toBe(true);
    expect(tree.pinnedRepoPaths.has("/repos/alpha")).toBe(true);
    expect(tree.togglePinnedRepo("/repos/alpha")).toBe(false);
    expect(tree.pinnedRepoPaths.has("/repos/alpha")).toBe(false);
  });

  test("a pinned empty repo header stays visible under 'non-empty'", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      // Empty repo — normally hidden under 'non-empty'.
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: false, hasRunningAgents: false, hasNonStoppedAgents: false },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("non-empty");
    // beta is hidden before pinning.
    expect(tree.visibleList.some((f) => f.kind === "repo-header" && f.repoPath === "/repos/beta")).toBe(false);
    // Pin beta — its header now appears despite being empty.
    tree.togglePinnedRepo("/repos/beta");
    expect(tree.visibleList.some((f) => f.kind === "repo-header" && f.repoPath === "/repos/beta")).toBe(true);
  });

  test("a pinned repo's stopped children still filter out under 'running-only'", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      // Repo with only stopped agents — the only state running-only hides.
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: false },
      { kind: "agent", agent: makeAgent("a1", "stopped", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
      { kind: "agent", agent: makeAgent("a2", "stopped", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "" },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    // Header is hidden before pinning (all agents stopped, nothing selected).
    expect(tree.visibleList.some((f) => f.kind === "repo-header" && f.repoPath === "/repos/alpha")).toBe(false);
    tree.togglePinnedRepo("/repos/alpha");
    const visible = tree.visibleList;
    // The pinned header is force-shown...
    expect(visible.some((f) => f.kind === "repo-header" && f.repoPath === "/repos/alpha")).toBe(true);
    // ...but its stopped children remain filtered out (children filter normally).
    const agentIds = visible.filter((f) => f.kind === "agent").map((f) => (f as Extract<FlatEntry, { kind: "agent" }>).agent.id);
    expect(agentIds).toEqual([]);
  });

  // BUG-2 acceptance: running-only shows EVERY non-stopped state — running,
  // waiting, complete, and the transient states (merging, rate_limited, …) —
  // and hides ONLY stopped. Nothing but 'stopped' should ever drop out.
  test("running-only shows all non-stopped states and hides only stopped", () => {
    const tree = new AgentTreeComponent();
    const states = [
      "running", "waiting", "complete", "creating", "compacting",
      "rate_limited", "api_error", "api_terms", "merging", "restarting",
      "op_stuck", "unknown", "stopped",
    ];
    const flat: FlatEntry[] = [
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      ...states.map((s, i) => ({
        kind: "agent" as const,
        agent: makeAgent(`a-${s}`, s, { repoName: "alpha", repoPath: "/repos/alpha" }),
        depth: 1,
        connector: i === states.length - 1 ? "└── " : "├── ",
      })),
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visibleIds = tree.visibleList
      .filter((f) => f.kind === "agent")
      .map((f) => (f as Extract<FlatEntry, { kind: "agent" }>).agent.id);
    // Every state except 'stopped' is shown, in order.
    expect(visibleIds).toEqual(states.filter((s) => s !== "stopped").map((s) => `a-${s}`));
    expect(visibleIds).not.toContain("a-stopped");
  });

  // BUG-2 acceptance: a repo whose agents are ALL stopped is hidden under
  // running-only, while a repo with a (non-running) waiting agent is shown.
  test("running-only hides an all-stopped repo but shows a waiting-only repo", () => {
    const tree = new AgentTreeComponent();
    const flat: FlatEntry[] = [
      // Repo whose only agents are stopped — must be HIDDEN.
      { kind: "repo-header", repoName: "alpha", repoPath: "/repos/alpha", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: false },
      { kind: "agent", agent: makeAgent("a1", "stopped", { repoName: "alpha", repoPath: "/repos/alpha" }), depth: 1, connector: "└── " },
      // Repo with a single waiting agent (non-running, non-stopped) — must be SHOWN.
      { kind: "repo-header", repoName: "beta", repoPath: "/repos/beta", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("b1", "waiting", { repoName: "beta", repoPath: "/repos/beta" }), depth: 1, connector: "└── " },
    ];
    tree.setFlatList(flat);
    tree.setRepoFilter("running-only");
    const visible = tree.visibleList;
    const repoPaths = visible.filter((f) => f.kind === "repo-header").map((f) => (f as Extract<FlatEntry, { kind: "repo-header" }>).repoPath);
    expect(repoPaths).toEqual(["/repos/beta"]);
    const agentIds = visible.filter((f) => f.kind === "agent").map((f) => (f as Extract<FlatEntry, { kind: "agent" }>).agent.id);
    expect(agentIds).toEqual(["b1"]);
  });

  test("nextRepoFilter cycles all → non-empty → running-only → all", () => {
    expect(nextRepoFilter("all")).toBe("non-empty");
    expect(nextRepoFilter("non-empty")).toBe("running-only");
    expect(nextRepoFilter("running-only")).toBe("all");
  });
});

describe("AgentTreeComponent parent-header (groupByParent)", () => {
  /** A flat list with a parent-header above two repo groups nested under it. */
  function makeFlatWithParent(): FlatEntry[] {
    return [
      { kind: "parent-header", parentDir: "/Users/x/Developer", displayName: "Developer" },
      { kind: "repo-header", repoName: "alpha", repoPath: "/Users/x/Developer/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/Users/x/Developer/alpha" }), depth: 0, connector: "" },
      { kind: "repo-header", repoName: "bravo", repoPath: "/Users/x/Developer/bravo", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("b1", "running", { repoName: "bravo", repoPath: "/Users/x/Developer/bravo" }), depth: 0, connector: "" },
    ];
  }

  test("visibleList passes parent-header through under filter=all", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatWithParent());
    const kinds = tree.visibleList.map((f) => f.kind);
    expect(kinds[0]).toBe("parent-header");
    expect(tree.visibleList.some((f) => f.kind === "parent-header")).toBe(true);
  });

  test("visibleList passes parent-header through under running-only filter", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatWithParent());
    tree.setRepoFilter("running-only");
    // Parent-header survives even the strictest filter (it's a pure display device).
    expect(tree.visibleList.some((f) => f.kind === "parent-header")).toBe(true);
    // ...and the running agents/repos are still there.
    const agentIds = tree.visibleList.filter((f) => f.kind === "agent").map((f) => (f as Extract<FlatEntry, { kind: "agent" }>).agent.id);
    expect(agentIds).toEqual(["a1", "b1"]);
  });

  test("running-only still hides a stopped repo but keeps the parent-header", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList([
      { kind: "parent-header", parentDir: "/Users/x/Developer", displayName: "Developer" },
      { kind: "repo-header", repoName: "alpha", repoPath: "/Users/x/Developer/alpha", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: false },
      { kind: "agent", agent: makeAgent("a1", "stopped", { repoName: "alpha", repoPath: "/Users/x/Developer/alpha" }), depth: 0, connector: "" },
      { kind: "repo-header", repoName: "bravo", repoPath: "/Users/x/Developer/bravo", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("b1", "running", { repoName: "bravo", repoPath: "/Users/x/Developer/bravo" }), depth: 0, connector: "" },
    ]);
    tree.setRepoFilter("running-only");
    const repoPaths = tree.visibleList.filter((f) => f.kind === "repo-header").map((f) => (f as Extract<FlatEntry, { kind: "repo-header" }>).repoPath);
    // Stopped 'alpha' repo hidden; 'bravo' kept. The parent-header stays because
    // 'bravo' (one of its repos) survives.
    expect(repoPaths).toEqual(["/Users/x/Developer/bravo"]);
    expect(tree.visibleList.some((f) => f.kind === "parent-header")).toBe(true);
  });

  // BUG (2026-07-19): under 'running-only', a parent-header whose repos ALL get
  // filtered out (empty or all-stopped) must NOT keep rendering an empty group.
  // Repro from the screenshot: 'automerge'/'ruby' parent groups (no running
  // agents) still appeared as bold-underlined headers with no rows beneath.
  test("running-only hides a parent-header when ALL its repos are filtered out", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList([
      // Group 1: 'Developer' — has a running repo, so it must survive.
      { kind: "parent-header", parentDir: "/Users/x/Developer", displayName: "Developer" },
      { kind: "repo-header", repoName: "alpha", repoPath: "/Users/x/Developer/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/Users/x/Developer/alpha" }), depth: 0, connector: "" },
      // Group 2: 'automerge' — a single repo with only stopped agents. Its lone
      // repo-header is hidden, so the parent-header must be hidden too.
      { kind: "parent-header", parentDir: "/Users/x/automerge", displayName: "automerge" },
      { kind: "repo-header", repoName: "amr", repoPath: "/Users/x/automerge/amr", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: false },
      { kind: "agent", agent: makeAgent("m1", "stopped", { repoName: "amr", repoPath: "/Users/x/automerge/amr" }), depth: 0, connector: "" },
      // Group 3: 'ruby' — a single EMPTY repo (no agents at all). Under
      // running-only its repo-header is hidden, so the parent-header must be too.
      { kind: "parent-header", parentDir: "/Users/x/ruby", displayName: "ruby" },
      { kind: "repo-header", repoName: "rb", repoPath: "/Users/x/ruby/rb", hasAgents: false, hasRunningAgents: false, hasNonStoppedAgents: false },
    ]);
    tree.setRepoFilter("running-only");
    const parentNames = tree.visibleList
      .filter((f) => f.kind === "parent-header")
      .map((f) => (f as Extract<FlatEntry, { kind: "parent-header" }>).displayName);
    // Only 'Developer' (with a surviving repo) remains; the two empty groups go.
    expect(parentNames).toEqual(["Developer"]);
    const repoPaths = tree.visibleList
      .filter((f) => f.kind === "repo-header")
      .map((f) => (f as Extract<FlatEntry, { kind: "repo-header" }>).repoPath);
    expect(repoPaths).toEqual(["/Users/x/Developer/alpha"]);
  });

  // Same rule under the milder 'non-empty' filter: a parent-header whose repos
  // are ALL empty (0 agents) must be hidden.
  test("non-empty hides a parent-header when all its repos are empty", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList([
      { kind: "parent-header", parentDir: "/Users/x/Developer", displayName: "Developer" },
      { kind: "repo-header", repoName: "alpha", repoPath: "/Users/x/Developer/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/Users/x/Developer/alpha" }), depth: 0, connector: "" },
      // 'empty' group: a single repo with no agents — hidden under non-empty.
      { kind: "parent-header", parentDir: "/Users/x/empty", displayName: "empty" },
      { kind: "repo-header", repoName: "e1", repoPath: "/Users/x/empty/e1", hasAgents: false, hasRunningAgents: false, hasNonStoppedAgents: false },
    ]);
    tree.setRepoFilter("non-empty");
    const parentNames = tree.visibleList
      .filter((f) => f.kind === "parent-header")
      .map((f) => (f as Extract<FlatEntry, { kind: "parent-header" }>).displayName);
    expect(parentNames).toEqual(["Developer"]);
  });

  // A parent-header with a SURVIVING repo but also a filtered-out repo must
  // still render (survives because at least one child repo survives).
  test("running-only keeps a parent-header when at least one of its repos survives", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList([
      { kind: "parent-header", parentDir: "/Users/x/Developer", displayName: "Developer" },
      // Stopped repo — hidden.
      { kind: "repo-header", repoName: "alpha", repoPath: "/Users/x/Developer/alpha", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: false },
      { kind: "agent", agent: makeAgent("a1", "stopped", { repoName: "alpha", repoPath: "/Users/x/Developer/alpha" }), depth: 0, connector: "" },
      // Running repo — kept, so the parent-header must be kept.
      { kind: "repo-header", repoName: "bravo", repoPath: "/Users/x/Developer/bravo", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("b1", "running", { repoName: "bravo", repoPath: "/Users/x/Developer/bravo" }), depth: 0, connector: "" },
    ]);
    tree.setRepoFilter("running-only");
    const parentNames = tree.visibleList
      .filter((f) => f.kind === "parent-header")
      .map((f) => (f as Extract<FlatEntry, { kind: "parent-header" }>).displayName);
    expect(parentNames).toEqual(["Developer"]);
  });

  // A pinned repo keeps its parent-header visible even under running-only, since
  // the pinned repo-header itself survives the filter.
  test("running-only keeps a parent-header whose only surviving repo is pinned", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList([
      { kind: "parent-header", parentDir: "/Users/x/pinned", displayName: "pinned" },
      { kind: "repo-header", repoName: "p1", repoPath: "/Users/x/pinned/p1", hasAgents: true, hasRunningAgents: false, hasNonStoppedAgents: false },
      { kind: "agent", agent: makeAgent("p1a", "stopped", { repoName: "p1", repoPath: "/Users/x/pinned/p1" }), depth: 0, connector: "" },
    ]);
    tree.pinnedRepoPaths.add("/Users/x/pinned/p1");
    tree.setRepoFilter("running-only");
    // The pinned repo survives → its parent-header must survive too.
    expect(tree.visibleList.some((f) => f.kind === "parent-header")).toBe(true);
    const repoPaths = tree.visibleList
      .filter((f) => f.kind === "repo-header")
      .map((f) => (f as Extract<FlatEntry, { kind: "repo-header" }>).repoPath);
    expect(repoPaths).toEqual(["/Users/x/pinned/p1"]);
  });

  test("render does not crash and shows the parent displayName + indented repos", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatWithParent());
    const lines = tree.render(80);
    const joined = lines.join("\n");
    expect(joined).toContain("Developer");
    // Repo-headers are indented 2 spaces under the parent when grouping is active.
    const alphaLine = lines.find((l) => l.includes("alpha"));
    expect(alphaLine).toBeDefined();
    expect(alphaLine!).toContain("  ");
  });

  test("moveSelection skips the inert parent-header (never selects it)", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatWithParent());
    // j from no-selection selects the FIRST row; index 0 is a parent-header,
    // which must be skipped — selection lands on the alpha repo-header instead.
    tree.moveSelection(1);
    expect(tree.selection).not.toBeNull();
    expect(tree.selection?.kind).not.toBe("parent-header");
    expect(tree.selection?.kind).toBe("repo-header");
    expect((tree.selection as { repoPath: string }).repoPath).toBe("/Users/x/Developer/alpha");
  });

  test("cycling j all the way down never crashes on the parent-header", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatWithParent());
    // Press j through the whole list twice; must never throw or select the parent-header.
    for (let i = 0; i < 12; i++) {
      tree.moveSelection(1);
      expect(tree.selection?.kind).not.toBe("parent-header");
    }
  });

  test("selectByRepoPath works with a parent-header in the list", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatWithParent());
    const found = tree.selectByRepoPath("/Users/x/Developer/bravo");
    expect(found).toBe(true);
    expect(tree.selectedRepoPath).toBe("/Users/x/Developer/bravo");
  });

  // Reviewer's exact repro layout: TWO parent groups, each with one repo + one
  // agent, so a parent-header sits BETWEEN two selectable regions. This is what
  // exposes the up-navigation dead-end.
  //   0 parent Developer / 1 repo alpha / 2 agent a1
  //   3 parent Projects  / 4 repo charlie / 5 agent c1
  function makeFlatTwoGroups(): FlatEntry[] {
    return [
      { kind: "parent-header", parentDir: "/Users/x/Developer", displayName: "Developer" },
      { kind: "repo-header", repoName: "alpha", repoPath: "/Users/x/Developer/alpha", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("a1", "running", { repoName: "alpha", repoPath: "/Users/x/Developer/alpha" }), depth: 0, connector: "" },
      { kind: "parent-header", parentDir: "/Users/x/Projects", displayName: "Projects" },
      { kind: "repo-header", repoName: "charlie", repoPath: "/Users/x/Projects/charlie", hasAgents: true, hasRunningAgents: true, hasNonStoppedAgents: true },
      { kind: "agent", agent: makeAgent("c1", "running", { repoName: "charlie", repoPath: "/Users/x/Projects/charlie" }), depth: 0, connector: "" },
    ];
  }

  // BLOCKER regression: moveSelection(-1) INTO a parent-header must continue
  // UPWARD (skip past it) instead of bouncing back down.
  test("k (up) into a parent-header lands on the previous group's last agent", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatTwoGroups());
    // Land on 'charlie' repo-header (idx 4), the first selectable row after the
    // 'Projects' parent-header at idx 3.
    tree.selectByRepoPath("/Users/x/Projects/charlie");
    expect(tree.selectedRepoPath).toBe("/Users/x/Projects/charlie");
    // Press k: idx 4 → 3 (parent-header) must be SKIPPED UPWARD to idx 2 (a1),
    // NOT bounced back to charlie.
    tree.moveSelection(-1);
    expect(tree.selection?.kind).toBe("agent");
    expect(tree.selectedAgent?.id).toBe("a1");
  });

  // BLOCKER regression: k from the FIRST selectable row (with a parent-header
  // above it at idx 0) must WRAP to the last row, not dead-end.
  test("k from the first selectable row wraps past the top parent-header to the last row", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatTwoGroups());
    // Select alpha (idx 1) — the first selectable row (idx 0 is a parent-header).
    tree.selectByRepoPath("/Users/x/Developer/alpha");
    expect(tree.selectedRepoPath).toBe("/Users/x/Developer/alpha");
    // Press k: idx 1 → 0 (parent-header) → wrap to last selectable (idx 5, c1).
    tree.moveSelection(-1);
    expect(tree.selection?.kind).toBe("agent");
    expect(tree.selectedAgent?.id).toBe("c1");
  });

  // Down-navigation still works (j across a parent-header boundary).
  test("j (down) across a parent-header lands on the next group's repo-header", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatTwoGroups());
    // Select a1 (idx 2), the last row of the first group.
    tree.selectAgentById("a1");
    expect(tree.selectedAgent?.id).toBe("a1");
    // Press j: idx 2 → 3 (Projects parent-header) skipped DOWN to idx 4 (charlie).
    tree.moveSelection(1);
    expect(tree.selection?.kind).toBe("repo-header");
    expect(tree.selectedRepoPath).toBe("/Users/x/Projects/charlie");
  });

  // Full up-cycle never crashes and never lands on a parent-header.
  test("cycling k all the way up never crashes on a parent-header", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatTwoGroups());
    tree.moveSelection(-1); // no-selection + k → last row (c1)
    for (let i = 0; i < 12; i++) {
      tree.moveSelection(-1);
      expect(tree.selection?.kind).not.toBe("parent-header");
      expect(tree.selection).not.toBeNull();
    }
  });

  test("render: agent rows indent under their repo (agent not left of its repo-header)", () => {
    const tree = new AgentTreeComponent();
    tree.setFlatList(makeFlatTwoGroups());
    const lines = tree.render(80);
    const parentLine = lines.find((l) => l.includes("Developer"))!;
    const repoLine = lines.find((l) => l.includes("alpha"))!;
    const agentLine = lines.find((l) => l.includes("a1"))!;
    // Leading-space count: parent (0) < repo (2) <= agent (2). The agent must
    // NOT sit left of its repo-header.
    const lead = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").match(/^ */)![0].length;
    expect(lead(parentLine)).toBe(0);
    expect(lead(repoLine)).toBe(2);
    expect(lead(agentLine)).toBeGreaterThanOrEqual(2);
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

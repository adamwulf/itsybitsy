import { test, expect, describe } from "bun:test";
import { AgentTreeComponent } from "./agent-tree";
import {
  makeAgent,
  makeFlatAgent,
  makeFlatRepoHeader,
  makeFlatSystemCoordinator,
} from "../test-utils";
import type { Agent, FlatEntry } from "../agents";

/** Build an agent with a specific id, repo, and state. */
function agentInRepo(id: string, repoName: string, state: Agent["state"]): Agent {
  return makeAgent({ id, repoName, repoPath: `/tmp/${repoName}`, state });
}

/** Construct a tree from a flat list and select a starting agent by id. */
function treeWith(list: FlatEntry[], startId: string): AgentTreeComponent {
  const tree = new AgentTreeComponent();
  tree.setFlatList(list);
  expect(tree.selectAgentById(startId)).toBe(true);
  return tree;
}

describe("moveToRepo skips stopped agents when jumping between agents", () => {
  test("jumping forward skips a repo whose agents are all stopped", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const b = agentInRepo("b1", "repoB", "stopped");
    const c = agentInRepo("c1", "repoC", "running");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b),
      makeFlatRepoHeader("repoC", "/tmp/repoC", true),
      makeFlatAgent(c),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    // repoB is all-stopped, so it is skipped and we land on repoC's agent.
    expect(tree.selectedAgent?.id).toBe("c1");
  });

  test("jumping backward skips a repo whose agents are all stopped", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const b = agentInRepo("b1", "repoB", "stopped");
    const c = agentInRepo("c1", "repoC", "running");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b),
      makeFlatRepoHeader("repoC", "/tmp/repoC", true),
      makeFlatAgent(c),
    ];
    const tree = treeWith(list, "c1");
    tree.moveToRepo(-1);
    // repoB is all-stopped, so jumping back from repoC lands on repoA's agent.
    expect(tree.selectedAgent?.id).toBe("a1");
  });

  test("lands on the first non-stopped agent of the target repo (forward)", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const bStopped = agentInRepo("b1", "repoB", "stopped");
    const bLive = agentInRepo("b2", "repoB", "running");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(bStopped),
      makeFlatAgent(bLive),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    // First agent in repoB is stopped — skip it, land on the live one.
    expect(tree.selectedAgent?.id).toBe("b2");
  });

  test("lands on the last non-stopped agent of the target repo (backward)", () => {
    const aLive = agentInRepo("a1", "repoA", "running");
    const aStopped = agentInRepo("a2", "repoA", "stopped");
    const b = agentInRepo("b1", "repoB", "running");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(aLive),
      makeFlatAgent(aStopped),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b),
    ];
    const tree = treeWith(list, "b1");
    tree.moveToRepo(-1);
    // Last agent in repoA is stopped — skip it, land on the live one.
    expect(tree.selectedAgent?.id).toBe("a1");
  });
});

describe("moveToRepo skips interior stopped agents within a repo", () => {
  test("forward lands on the first live agent past a stopped one (not the interior stopped)", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const b1 = agentInRepo("b1", "repoB", "running");
    const b2 = agentInRepo("b2", "repoB", "stopped");
    const b3 = agentInRepo("b3", "repoB", "running");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b1),
      makeFlatAgent(b2),
      makeFlatAgent(b3),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    // First live agent in repoB is b1; the interior stopped b2 is never a target.
    expect(tree.selectedAgent?.id).toBe("b1");
  });

  test("backward lands on the last live agent (skipping a trailing stopped one)", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const b1 = agentInRepo("b1", "repoB", "running");
    const b2 = agentInRepo("b2", "repoB", "stopped");
    const b3 = agentInRepo("b3", "repoB", "running");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b1),
      makeFlatAgent(b2),
      makeFlatAgent(b3),
    ];
    // Start on repoA, jump backward — wraps to repoB and should land on its
    // last LIVE agent (b3), not the interior-trailing stopped b2.
    const tree = treeWith(list, "a1");
    tree.moveToRepo(-1);
    expect(tree.selectedAgent?.id).toBe("b3");
  });
});

describe("moveToRepo with empty and all-stopped repos composed", () => {
  test("forward skips both an empty repo and an all-stopped repo to reach a live one", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const cStopped = agentInRepo("c1", "repoC", "stopped");
    const d = agentInRepo("d1", "repoD", "running");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", false), // empty
      makeFlatRepoHeader("repoC", "/tmp/repoC", true), // all stopped
      makeFlatAgent(cStopped),
      makeFlatRepoHeader("repoD", "/tmp/repoD", true),
      makeFlatAgent(d),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    // repoB (empty) and repoC (all stopped) are both skipped; land on repoD.
    expect(tree.selectedAgent?.id).toBe("d1");
  });
});

describe("moveToRepo when the only live agent is the current selection", () => {
  test("forward stays put (no live agent to jump to)", () => {
    const a = agentInRepo("a1", "repoA", "running"); // the only live agent
    const b = agentInRepo("b1", "repoB", "stopped");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    // Everything else is stopped; the only live landing spot is ourselves.
    expect(tree.selectedAgent?.id).toBe("a1");
  });

  test("backward stays put (no live agent to jump to)", () => {
    const a = agentInRepo("a1", "repoA", "stopped");
    const b = agentInRepo("b1", "repoB", "running"); // the only live agent
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b),
    ];
    const tree = treeWith(list, "b1");
    tree.moveToRepo(-1);
    expect(tree.selectedAgent?.id).toBe("b1");
  });
});

describe("moveToRepo falls back when everything is stopped", () => {
  test("all agents stopped: still cycles between repos as before (forward)", () => {
    const a = agentInRepo("a1", "repoA", "stopped");
    const b = agentInRepo("b1", "repoB", "stopped");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    // No live agent anywhere — fall back to the original repo-jumping behavior.
    expect(tree.selectedAgent?.id).toBe("b1");
  });

  test("all agents stopped: cycles backward to the other repo", () => {
    const a = agentInRepo("a1", "repoA", "stopped");
    const b = agentInRepo("b1", "repoB", "stopped");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b),
    ];
    const tree = treeWith(list, "b1");
    tree.moveToRepo(-1);
    expect(tree.selectedAgent?.id).toBe("a1");
  });
});

describe("moveToRepo unchanged behavior when no agents are stopped", () => {
  test("forward jump lands on the next repo's first agent", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const b1 = agentInRepo("b1", "repoB", "running");
    const b2 = agentInRepo("b2", "repoB", "waiting");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b1),
      makeFlatAgent(b2),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    expect(tree.selectedAgent?.id).toBe("b1");
  });

  test("empty repos are still skipped", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const c = agentInRepo("c1", "repoC", "running");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", false),
      makeFlatRepoHeader("repoC", "/tmp/repoC", true),
      makeFlatAgent(c),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    expect(tree.selectedAgent?.id).toBe("c1");
  });
});

describe("moveToRepo and the system coordinator", () => {
  test("a live coordinator is a valid landing spot when jumping forward", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const list: FlatEntry[] = [
      makeFlatSystemCoordinator("running"),
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    // Only the coordinator and repoA exist — forward from repoA wraps to coordinator.
    expect(tree.selection?.kind).toBe("system-coordinator");
  });

  test("a stopped coordinator is skipped when a live agent exists", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const b = agentInRepo("b1", "repoB", "running");
    const list: FlatEntry[] = [
      makeFlatSystemCoordinator("stopped"),
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b),
    ];
    const tree = treeWith(list, "b1");
    tree.moveToRepo(1);
    // Forward from repoB would hit the coordinator next, but it is stopped,
    // so skip past it to repoA's live agent.
    expect(tree.selectedAgent?.id).toBe("a1");
  });

  test("a stopped coordinator is still reachable when everything else is stopped", () => {
    const a = agentInRepo("a1", "repoA", "stopped");
    const list: FlatEntry[] = [
      makeFlatSystemCoordinator("stopped"),
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
    ];
    const tree = treeWith(list, "a1");
    tree.moveToRepo(1);
    // Nothing is live — fall back, and the coordinator is the only other anchor.
    expect(tree.selection?.kind).toBe("system-coordinator");
  });
});

describe("moveToRepo repo-header selection is unaffected", () => {
  test("with a repo header selected, it still cycles repo headers only", () => {
    const a = agentInRepo("a1", "repoA", "running");
    const b = agentInRepo("b1", "repoB", "stopped");
    const list: FlatEntry[] = [
      makeFlatRepoHeader("repoA", "/tmp/repoA", true),
      makeFlatAgent(a),
      makeFlatRepoHeader("repoB", "/tmp/repoB", true),
      makeFlatAgent(b),
    ];
    const tree = new AgentTreeComponent();
    tree.setFlatList(list);
    expect(tree.selectByRepoPath("/tmp/repoA")).toBe(true);
    tree.moveToRepo(1);
    // Repo-header mode is independent of agent state — lands on repoB's header.
    expect(tree.selectedRepoPath).toBe("/tmp/repoB");
  });
});

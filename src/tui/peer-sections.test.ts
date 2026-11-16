import { describe, expect, test } from "bun:test";
import type { PeerSectionEntry } from "../agents";
import { REPO_COORDINATOR_TYPE } from "../coordinator-type-names";
import type { RemoteAgent } from "../peers/peer-link";
import type { PeerLinkState } from "../peers/poller";
import { MAX_REMOTE_DEPTH, flattenPeerSections, isPeerEntryKey, peerEntryKey, remoteDisplayName, samePeerLinks } from "./peer-sections";

const PEER_A = "a1".repeat(32);
const PEER_B = "b2".repeat(32);

function remote(id: string, overrides: Partial<RemoteAgent> = {}): RemoteAgent {
  return { id, nickname: null, repoName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: null, ...overrides };
}

function link(id: string, agents: RemoteAgent[] | null, overrides: Partial<PeerLinkState> = {}): PeerLinkState {
  return { id, name: `peer-${id.slice(0, 2)}`, connected: true, lastOkAt: 1_000, lastError: null, agents, ...overrides };
}

/** A row as `<kind> <label> <connector>`, so a test reads the whole section at once. */
function describeRow(e: PeerSectionEntry): string {
  switch (e.kind) {
    case "peer-header":
      return `peer ${e.peerName}`;
    case "remote-repo-header":
      return `repo ${e.repoName} ${e.repoPath}`;
    case "remote-agent":
      return `agent ${e.connector}${e.remote.id}`;
  }
}

describe("flattenPeerSections", () => {
  test("a connected peer: its header, then its repos by name, each with its agents nested by manager", () => {
    const rows = flattenPeerSections([
      link(PEER_A, [
        remote("worker-abc", { manager: "manager-def" }),
        remote("agent-123", { repoName: "other-repo", repoPath: "/repos/other" }),
        remote("manager-def"),
        remote("worker-ghi", { manager: "manager-def" }),
        remote("solo"),
      ]),
    ]);
    expect(rows.map(describeRow)).toEqual([
      "peer peer-a1",
      "repo app /repos/app",
      "agent ├── manager-def",
      "agent │   ├── worker-abc",
      "agent │   └── worker-ghi",
      "agent └── solo",
      "repo other-repo /repos/other",
      "agent └── agent-123",
    ]);
    expect(rows[0]).toEqual({
      kind: "peer-header", peerId: PEER_A, peerName: "peer-a1", connected: true, lastOkAt: 1_000, lastError: null,
      repoCount: 2, agentCount: 5,
    });
    expect(rows.filter((r) => r.kind !== "peer-header").every((r) => "stale" in r && r.stale === false)).toBe(true);
  });

  test("an unreachable peer keeps its last list, marked stale; one that never answered is its header only", () => {
    const rows = flattenPeerSections([
      link(PEER_A, [remote("agent-1")], { connected: false, lastOkAt: 500, lastError: "timed out" }),
      link(PEER_B, null, { connected: false, lastOkAt: null, lastError: "not a peer" }),
    ]);
    expect(rows.map(describeRow)).toEqual(["peer peer-a1", "repo app /repos/app", "agent └── agent-1", "peer peer-b2"]);
    expect(rows[1]).toMatchObject({ kind: "remote-repo-header", stale: true, agentCount: 1 });
    expect(rows[2]).toMatchObject({ kind: "remote-agent", stale: true });
    expect(rows[3]).toMatchObject({ kind: "peer-header", connected: false, lastOkAt: null, lastError: "not a peer", repoCount: null, agentCount: null });
  });

  test("a peer that answered with no agents is its header only, with zero counts", () => {
    const rows = flattenPeerSections([link(PEER_A, [])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "peer-header", repoCount: 0, agentCount: 0 });
  });

  test("repos group on repoPath: two repos with one name are two headers", () => {
    const rows = flattenPeerSections([
      link(PEER_A, [remote("x", { repoPath: "/b/app" }), remote("y", { repoPath: "/a/app" }), remote("z", { repoPath: "/b/app" })]),
    ]);
    expect(rows.map(describeRow)).toEqual([
      "peer peer-a1",
      "repo app /a/app",
      "agent └── y",
      "repo app /b/app",
      "agent ├── x",
      "agent └── z",
    ]);
  });

  test("a manager in another repo, or missing, leaves the agent a root of its own repo", () => {
    const rows = flattenPeerSections([
      link(PEER_A, [
        remote("mgr", { repoName: "a", repoPath: "/a" }),
        remote("child", { repoName: "b", repoPath: "/b", manager: "mgr" }),
        remote("orphan", { repoName: "b", repoPath: "/b", manager: "gone" }),
      ]),
    ]);
    expect(rows.map(describeRow)).toEqual(["peer peer-a1", "repo a /a", "agent └── mgr", "repo b /b", "agent ├── child", "agent └── orphan"]);
  });

  test("a manager cycle or a self-manager draws every agent exactly once", () => {
    const rows = flattenPeerSections([
      link(PEER_A, [
        remote("a", { manager: "b" }),
        remote("b", { manager: "a" }),
        remote("c", { manager: "b" }),
        remote("self", { manager: "self" }),
      ]),
    ]);
    const agents = rows.filter((r) => r.kind === "remote-agent").map((r) => (r.kind === "remote-agent" ? r.remote.id : ""));
    expect(agents.sort()).toEqual(["a", "b", "c", "self"]);
    // The cycle is entered at its first agent in list order.
    expect(rows.map(describeRow).slice(2)).toEqual([
      "agent ├── self",
      "agent └── a",
      "agent     └── b",
      "agent         └── c",
    ]);
  });

  test("a long manager chain is drawn no deeper than MAX_REMOTE_DEPTH levels", () => {
    const chain = Array.from({ length: 40 }, (_, i) => remote(`a${i}`, { manager: i === 0 ? null : `a${i - 1}` }));
    const rows = flattenPeerSections([link(PEER_A, chain)]).filter((r) => r.kind === "remote-agent");
    expect(rows).toHaveLength(40);
    const widest = Math.max(...rows.map((r) => (r.kind === "remote-agent" ? r.connector.length : 0)));
    expect(widest).toBe(MAX_REMOTE_DEPTH * 4);
  });
});

describe("peerEntryKey", () => {
  test("rows are keyed by their peer: the same agent id on two peers, or equal to a local id, is two keys and no local key", () => {
    const rows = flattenPeerSections([link(PEER_A, [remote("agent-1")]), link(PEER_B, [remote("agent-1")])]);
    const keys = rows.map(peerEntryKey);
    expect(keys).toEqual([
      `peer:${PEER_A}`,
      `remoterepo:${PEER_A}:/repos/app`,
      `remote:${JSON.stringify([PEER_A, "/repos/app", "agent-1"])}`,
      `peer:${PEER_B}`,
      `remoterepo:${PEER_B}:/repos/app`,
      `remote:${JSON.stringify([PEER_B, "/repos/app", "agent-1"])}`,
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    // A local agent is keyed by its bare id (agent-1), and a local repo header by `repopath:`.
    expect(keys).not.toContain("agent-1");
    expect(keys.some((k) => k.startsWith("repopath:"))).toBe(false);
    expect(keys.every(isPeerEntryKey)).toBe(true);
    for (const local of ["agent-1", "repopath:/repos/app", "__system-coordinator__"]) expect(isPeerEntryKey(local)).toBe(false);
  });

  test("one agent id in two repos of one peer is two keys, even when the paths and ids hold colons", () => {
    const rows = flattenPeerSections([
      link(PEER_A, [
        remote("agent-1", { repoName: "a", repoPath: "/repos/a" }),
        remote("agent-1", { repoName: "b", repoPath: "/repos/b" }),
        // Split at a colon, these two would read the same.
        remote("y:z", { repoName: "c", repoPath: "/x" }),
        remote("z", { repoName: "d", repoPath: "/x:y" }),
      ]),
    ]);
    const agentKeys = rows.filter((r) => r.kind === "remote-agent").map(peerEntryKey);
    expect(agentKeys).toHaveLength(4);
    expect(new Set(agentKeys).size).toBe(4);
  });
});

describe("remote repo coordinators", () => {
  test("are left out like local ones: their agents become roots, a coordinator-only repo has no header, the counts count only drawn rows", () => {
    const rows = flattenPeerSections([
      link(PEER_A, [
        remote("coord", { agentType: REPO_COORDINATOR_TYPE, state: "stopped" }),
        remote("worker-1", { manager: "coord" }),
        remote("worker-2", { manager: "coord" }),
        remote("child", { manager: "worker-1" }),
        remote("lonely-coord", { agentType: REPO_COORDINATOR_TYPE, repoName: "empty", repoPath: "/repos/empty" }),
      ]),
    ]);
    expect(rows.map(describeRow)).toEqual([
      "peer peer-a1",
      "repo app /repos/app",
      "agent ├── worker-1",
      "agent │   └── child",
      "agent └── worker-2",
    ]);
    expect(rows[0]).toMatchObject({ kind: "peer-header", repoCount: 1, agentCount: 3 });
    expect(rows[1]).toMatchObject({ kind: "remote-repo-header", agentCount: 3 });
  });
});

describe("remoteDisplayName", () => {
  test("the nickname when set, else the id", () => {
    expect(remoteDisplayName(remote("agent-1"))).toBe("agent-1");
    expect(remoteDisplayName(remote("agent-1", { nickname: "nick" }))).toBe("nick");
  });
});

describe("samePeerLinks", () => {
  const agents = [remote("agent-1")];
  const base = link(PEER_A, agents);

  test("the same peers, names, connection, error and list (by reference) are the same", () => {
    expect(samePeerLinks([base], [{ ...base }])).toBe(true);
    expect(samePeerLinks([], [])).toBe(true);
  });

  test("lastOkAt counts only while the peer is not connected (it shows as last seen)", () => {
    expect(samePeerLinks([base], [{ ...base, lastOkAt: 9_999 }])).toBe(true);
    const down = { ...base, connected: false };
    expect(samePeerLinks([down], [{ ...down, lastOkAt: 9_999 }])).toBe(false);
  });

  test("any other visible change differs", () => {
    expect(samePeerLinks([base], [{ ...base, name: "renamed" }])).toBe(false);
    expect(samePeerLinks([base], [{ ...base, connected: false }])).toBe(false);
    expect(samePeerLinks([base], [{ ...base, lastError: "timed out" }])).toBe(false);
    expect(samePeerLinks([base], [{ ...base, agents: [...agents] }])).toBe(false);
    expect(samePeerLinks([base], [base, link(PEER_B, null)])).toBe(false);
    expect(samePeerLinks([base, link(PEER_B, null)], [link(PEER_B, null), base])).toBe(false);
  });
});

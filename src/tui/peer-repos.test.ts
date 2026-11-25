import { expect, test } from "bun:test";
import type { RemoteAgent } from "../peers/peer-link";
import type { PeerLinkState } from "../peers/poller";
import { collectPeerRepos, visibleRemoteAgents, MAX_REMOTE_DEPTH } from "./peer-repos";

function agent(id: string, manager: string | null = null, createdEpoch = 0): RemoteAgent {
  return { id, manager, state: "running", agentType: "worker", nickname: null,
    repoRegistryName: "App", repoName: "App", repoPath: "/peer/app", createdEpoch };
}

function link(id: string, name: string, agents: RemoteAgent[]): PeerLinkState {
  return { id, name, connected: true, connectedAt: 1, lastOkAt: 1, coordinator: null, lastError: null,
    repos: [{ registryName: "APP", displayName: "Remote App", remoteUrl: null, relPath: null }], agents, questions: [] };
}

function rows(agents: RemoteAgent[], keep = (_: RemoteAgent) => true) {
  const repos = collectPeerRepos([link("peer", "Desk", agents)]);
  return visibleRemoteAgents(repos.get("/app")!, (row) => keep(row.remote));
}

test("siblings draw in spawn order, oldest first, whatever order the peer sent them in", () => {
  const agents = [agent("new-root", null, 300), agent("late-kid", "old-root", 250), agent("old-root", null, 100),
    agent("early-kid", "old-root", 200), agent("same-second", null, 300)];
  expect(rows(agents).map((r) => r.connector + r.remote.id)).toEqual([
    "├── old-root", "│   ├── early-kid", "│   └── late-kid", "├── new-root", "└── same-second",
  ]);
});

test("the roots of several peers interleave in spawn order, each keeping its own children", () => {
  const repo = collectPeerRepos([
    link("a", "Desk", [agent("desk-new", null, 400), agent("desk-old", null, 100), agent("desk-kid", "desk-old", 500)]),
    link("b", "Laptop", [agent("laptop-mid", null, 200)]),
  ]).get("/app")!;
  expect(visibleRemoteAgents(repo, () => true).map((r) => `${r.connector}${r.peerName}/${r.remote.id}`)).toEqual([
    "├── Desk/desk-old", "│   └── Desk/desk-kid", "├── Laptop/laptop-mid", "└── Desk/desk-new",
  ]);
  expect(repo.header.agentCount).toBe(4);
});

test("skips repo coordinators and attaches children to their nearest visible manager", () => {
  const agents = [{ ...agent("coord"), agentType: "repo-coordinator" }, agent("root", "coord"),
    agent("hidden", "root"), agent("leaf", "hidden"), agent("solo")];
  expect(rows(agents, (row) => row.id !== "hidden").map((r) => r.connector + r.remote.id)).toEqual([
    "├── root", "│   └── leaf", "└── solo",
  ]);
});

test("cycles, self managers and duplicate ids each draw once per received agent", () => {
  const agents = [agent("a", "b"), agent("b", "a"), agent("c", "b"), agent("self", "self"), agent("a")];
  expect(rows(agents).map((row) => row.remote.id).sort()).toEqual(["a", "a", "b", "c", "self"]);
});

test("a remote-only header takes its clone fields from the first peer that reports a remote URL", () => {
  const link = (name: string, remoteUrl: string | null, relPath: string | null, displayName = name) =>
    ({ id: name, name, connected: true, connectedAt: 1, lastOkAt: 1, coordinator: null, lastError: null, agents: [], questions: [],
      repos: [{ registryName: "app", displayName, remoteUrl, relPath }] });
  const header = (...links: ReturnType<typeof link>[]) => collectPeerRepos(links).get("/app")!.header;

  // The first peer still names the repo; the second supplies URL and path together.
  expect(header(link("Desk", null, "ignored/App", "Desk app"), link("Laptop", "git@h:o/app.git", "swift/App"),
    link("Mini", "https://h/o/app", "html/App"))).toMatchObject({
    peerName: "Desk", repoName: "Desk app", remoteUrl: "git@h:o/app.git", relPath: "swift/App", remoteUrlPeer: "Laptop",
  });
  expect(header(link("Desk", "git@h:o/app.git", null), link("Laptop", "https://h/o/app", "swift/App"))).toMatchObject({
    peerName: "Desk", remoteUrl: "git@h:o/app.git", relPath: null, remoteUrlPeer: "Desk",
  });
  expect(header(link("Desk", null, "swift/App"), link("Laptop", null, null))).toMatchObject({
    peerName: "Desk", remoteUrl: null, relPath: null, remoteUrlPeer: null,
  });
});

test("deep manager chains keep bounded connectors", () => {
  const agents = Array.from({ length: 40 }, (_, i) => agent(String(i), i ? String(i - 1) : null));
  const drawn = rows(agents);
  expect(drawn).toHaveLength(40);
  expect(Math.max(...drawn.map((r) => r.connector.length))).toBe(MAX_REMOTE_DEPTH * 4);
});

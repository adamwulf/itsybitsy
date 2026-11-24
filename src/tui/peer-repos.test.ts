import { expect, test } from "bun:test";
import type { RemoteAgent } from "../peers/peer-link";
import { collectPeerRepos, visibleRemoteAgents, MAX_REMOTE_DEPTH } from "./peer-repos";

function agent(id: string, manager: string | null = null): RemoteAgent {
  return { id, manager, state: "running", agentType: "worker", nickname: null,
    repoRegistryName: "App", repoName: "App", repoPath: "/peer/app" };
}

function rows(agents: RemoteAgent[], keep = (_: RemoteAgent) => true) {
  const repos = collectPeerRepos([{ id: "peer", name: "Desk", connected: true, connectedAt: 1, lastOkAt: 1, coordinator: null, lastError: null,
    repos: [{ registryName: "APP", displayName: "Remote App" }], agents, questions: [] }]);
  return visibleRemoteAgents(repos.get("/app")!, (row) => keep(row.remote));
}

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

test("deep manager chains keep bounded connectors", () => {
  const agents = Array.from({ length: 40 }, (_, i) => agent(String(i), i ? String(i - 1) : null));
  const drawn = rows(agents);
  expect(drawn).toHaveLength(40);
  expect(Math.max(...drawn.map((r) => r.connector.length))).toBe(MAX_REMOTE_DEPTH * 4);
});

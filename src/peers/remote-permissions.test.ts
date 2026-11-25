import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsDir } from "../runtime-names";
import { makeAgent } from "../test-utils";
import { REPO_COORDINATOR_TYPE } from "../coordinator-type-names";
import { acceptRemotePermission, parsePermissionRequest, type RemotePermissionDeps, type RemotePermissionRequest } from "./remote-permissions";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ib-remote-permissions-"));
  await Bun.write(join(agentsDir(repo), "worker", "meta.json"), JSON.stringify(makeAgent({ id: "worker" }).meta));
  await Bun.write(join(agentsDir(repo), "coord", "meta.json"), JSON.stringify({ ...makeAgent({ id: "coord" }).meta, agentType: REPO_COORDINATOR_TYPE }));
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

/** The real registry lookup and agent records; the changes themselves are mocks. */
function fixture(repos = () => [{ name: "App", path: repo }]) {
  const logs: string[] = [];
  const deps = {
    listRepos: async () => repos(),
    effectiveSpawnCapability: mock<RemotePermissionDeps["effectiveSpawnCapability"]>(async agent => agent.meta.canSpawnChildren ?? false),
    grantAgentPermission: mock<RemotePermissionDeps["grantAgentPermission"]>(async () => ({ ok: true })),
    setAgentSpawnCapability: mock<RemotePermissionDeps["setAgentSpawnCapability"]>(async (agent, next) => {
      agent.meta.canSpawnChildren = next;
      return { ok: true };
    }),
    notice: mock((_line: string, _kind: "info" | "error") => {}),
  } satisfies RemotePermissionDeps;
  const accept = (request: Partial<RemotePermissionRequest>, peer: string | null = "Laptop") =>
    acceptRemotePermission({ repo: "app", id: "worker", ...request }, async () => peer, deps, line => logs.push(line));
  return { deps, logs, accept };
}

test("a read returns the agent's spawn capability and changes, logs and notices nothing", async () => {
  const { deps, logs, accept } = fixture();
  expect(await accept({})).toEqual({ canSpawnChildren: false });
  expect(deps.effectiveSpawnCapability.mock.calls[0]![0]).toMatchObject({ id: "worker", repoPath: repo });
  expect(deps.grantAgentPermission).not.toHaveBeenCalled();
  expect(deps.setAgentSpawnCapability).not.toHaveBeenCalled();
  expect(logs).toEqual([]);
  expect(deps.notice).not.toHaveBeenCalled();
});

test("an allow entry is granted to the agent matched in the repo ignoring case, then logged and noticed", async () => {
  const { deps, logs, accept } = fixture();
  expect(await accept({ allow: "Bash(git status:*)" })).toEqual({ canSpawnChildren: false });
  expect(deps.grantAgentPermission.mock.calls).toEqual([[expect.objectContaining({ id: "worker" }), "Bash(git status:*)"]]);
  expect(logs).toEqual(["Laptop added Bash(git status:*) to worker allow list in App"]);
  expect(deps.notice.mock.calls).toEqual([["Laptop added Bash(git status:*) to worker allow list in App", "info"]]);
});

test("a spawn change sets the override and reports the new capability", async () => {
  const { deps, logs, accept } = fixture();
  expect(await accept({ canSpawnChildren: true })).toEqual({ canSpawnChildren: true });
  expect(deps.setAgentSpawnCapability.mock.calls).toEqual([[expect.objectContaining({ id: "worker" }), true]]);
  expect(await accept({ canSpawnChildren: false })).toEqual({ canSpawnChildren: false });
  expect(logs).toEqual([
    "Laptop enabled sub-agent spawning for worker in App",
    "Laptop disabled sub-agent spawning for worker in App",
  ]);
});

test("a change whose notify failed still succeeds, and says so in the reply, the log and a red notice", async () => {
  const { deps, logs, accept } = fixture();
  deps.grantAgentPermission.mockResolvedValueOnce({ ok: true, notifyError: "No active tmux session\nfor worker" });
  expect(await accept({ allow: "Read" })).toEqual({ canSpawnChildren: false, notifyError: "No active tmux session\nfor worker" });
  const line = "Laptop added Read to worker allow list in App · notify failed: No active tmux session for worker";
  expect(logs).toEqual([line]);
  expect(deps.notice.mock.calls).toEqual([[line, "error"]]);
});

test("a failed change fails with the local dialog's notice and notices nothing", async () => {
  const { deps, logs, accept } = fixture();
  deps.grantAgentPermission.mockResolvedValueOnce({ ok: false, error: "Already in allow list" });
  await expect(accept({ allow: "Read" })).rejects.toThrow("Already in allow list");
  deps.setAgentSpawnCapability.mockResolvedValueOnce({ ok: false, error: "Failed to re-seal worker; spawn toggle rolled back: disk full" });
  await expect(accept({ canSpawnChildren: true })).rejects.toThrow("Failed to re-seal worker; spawn toggle rolled back: disk full");
  expect(logs).toEqual([]);
  expect(deps.notice).not.toHaveBeenCalled();
});

test("a coordinator, an unknown agent or repo, and a lost pairing are refused before anything changes", async () => {
  const { deps, accept } = fixture();
  await expect(accept({ id: "coord", allow: "Read" })).rejects.toThrow("Remote coordinators are read-only");
  await expect(accept({ id: "ghost", allow: "Read" })).rejects.toThrow("ghost");
  await expect(accept({ repo: "other", allow: "Read" })).rejects.toThrow("Repo is not uniquely registered on this machine");
  await expect(accept({ canSpawnChildren: true }, null)).rejects.toThrow("Machine is no longer paired");
  expect(deps.grantAgentPermission).not.toHaveBeenCalled();
  expect(deps.setAgentSpawnCapability).not.toHaveBeenCalled();
  expect(deps.notice).not.toHaveBeenCalled();

  const twice = fixture(() => [{ name: "App", path: repo }, { name: "APP", path: repo }]);
  await expect(twice.accept({ allow: "Read" })).rejects.toThrow("Repo is not uniquely registered on this machine");
});

test("a malformed request is refused", () => {
  const parse = (raw: Record<string, unknown>) => () => parsePermissionRequest({ repo: "app", id: "worker", ...raw });
  expect(parse({})()).toEqual({ repo: "app", id: "worker" });
  expect(parse({ allow: "Bash(git status:*)" })()).toEqual({ repo: "app", id: "worker", allow: "Bash(git status:*)" });
  expect(parse({ canSpawnChildren: false })()).toEqual({ repo: "app", id: "worker", canSpawnChildren: false });
  for (const repo of [7, "", "a/b", "..", "a\0b"]) expect(parse({ repo })).toThrow("Invalid repo registry name");
  for (const id of [7, "", "../x", "a b", "@system"]) expect(parse({ id })).toThrow("Invalid agent id");
  for (const allow of [7, "", "  ", " Read", "Bash(foo; rm -rf /)", "Read\n"]) expect(parse({ allow })).toThrow("Invalid permission entry");
  expect(parse({ canSpawnChildren: "yes" })).toThrow("Invalid spawn capability");
  expect(parse({ allow: "Read", canSpawnChildren: true })).toThrow("A permission request changes one thing");
});

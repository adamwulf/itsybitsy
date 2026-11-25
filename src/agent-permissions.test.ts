import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "./agents";
import { agentsDir } from "./runtime-names";
import { makeAgent } from "./test-utils";
import { agentSettingsLocalPath, grantAgentPermission, INVALID_PERMISSION_ENTRY, setAgentSpawnCapability } from "./agent-permissions";

let repo: string;
let agent: Agent;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ib-agent-permissions-"));
  agent = makeAgent({ id: "worker", repoPath: repo });
  // No tmux session: telling the agent fails at once, without reaching tmux.
  agent.meta.tmux_session = "";
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

const allowList = async () => (await Bun.file(agentSettingsLocalPath(agent)).json()).permissions.allow;

test("grantAgentPermission adds the entry, then reports a failed notify without undoing it", async () => {
  expect(await grantAgentPermission(agent, "Bash(git status:*)")).toEqual({ ok: true, notifyError: "Agent has no tmux session" });
  expect(await allowList()).toEqual(["Bash(git status:*)"]);
});

test("grantAgentPermission refuses a listed entry, a malformed settings file and a disallowed entry with the dialog's notice", async () => {
  await grantAgentPermission(agent, "Read");
  expect(await grantAgentPermission(agent, "Read")).toEqual({ ok: false, error: "Already in allow list" });
  expect(await allowList()).toEqual(["Read"]);

  expect(await grantAgentPermission(agent, "Bash(foo; rm -rf /)")).toEqual({ ok: false, error: INVALID_PERMISSION_ENTRY });
  expect(await allowList()).toEqual(["Read"]);

  await Bun.write(agentSettingsLocalPath(agent), "{ not json");
  const malformed = await grantAgentPermission(agent, "Write");
  expect(malformed.ok).toBe(false);
  expect(!malformed.ok && malformed.error).toStartWith("Failed: Malformed JSON");
  expect(await Bun.file(agentSettingsLocalPath(agent)).text()).toBe("{ not json");
});

test("setAgentSpawnCapability writes the override and the in-memory record, or fails when meta.json is missing", async () => {
  expect(await setAgentSpawnCapability(agent, true)).toEqual({ ok: false, error: "Failed: meta.json missing for worker" });
  expect(agent.meta.canSpawnChildren).toBeUndefined();

  const metaPath = join(agentsDir(repo), "worker", "meta.json");
  await Bun.write(metaPath, JSON.stringify(agent.meta));
  expect(await setAgentSpawnCapability(agent, true)).toEqual({ ok: true, notifyError: "Agent has no tmux session" });
  expect((await Bun.file(metaPath).json()).canSpawnChildren).toBe(true);
  expect(agent.meta.canSpawnChildren).toBe(true);
});

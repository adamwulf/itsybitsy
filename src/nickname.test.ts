/**
 * Agent nickname feature — renameAgent + global collision + buildAgentTree
 * shadow-guard coverage.
 *
 * This lives in its own file (rather than ib-commands.test.ts) on purpose:
 * watcher.test.ts does a GLOBAL `mock.module("./agents", ...)` that replaces
 * readAllAgents / buildAgentTree with jest.fn() stubs for every file whose
 * `./agents` binding resolves after that mock registers. renameAgent's collision
 * scan and the byId shadow-guard both need the REAL readAllAgents / buildAgentTree,
 * so they must run in a module graph that captured the real ./agents before the
 * mock — a dedicated `nickname.test.ts` (alphabetically before watcher.test.ts)
 * does exactly that. See the comment block at the top of watcher.test.ts.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join, basename } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { renameAgent, newAgent, setNewAgentSpawnRunner, resetNewAgentSpawnRunner } from "./ib-commands";
import { readAllAgents, buildAgentTree, resetReadAgentMetaCache } from "./agents";
import { matchAgentById } from "./index";
import { saveRegistry } from "./registry";
import { spawnCtx as lifecycleSpawnCtx } from "./agent-lifecycle";
import { makeAgent as _makeAgent, makeSpawnResult } from "./test-utils";
import type { Agent } from "./agents";
import type { AgentState } from "./parse-state";
import type { SpawnResult } from "./types";

function makeAgent(id: string, repoPath: string, state: string = "running"): Agent {
  return _makeAgent({ id, repoPath, repoName: "test-repo", state: state as AgentState });
}

describe("renameAgent (native, nickname)", () => {
  let tempDir: string;
  let secondRepo: string;
  let originalHome: string | undefined;
  let fakeHome: string;

  // Register the agent's repo (and optionally a second repo) so renameAgent's
  // listRepos()/readAllAgents() global scans see the agents on disk.
  async function registerRepos(paths: string[]): Promise<void> {
    await saveRegistry({
      repos: paths.map((p) => ({ path: p, name: basename(p) })),
    });
  }

  // Write a meta.json for an agent under <repoPath>/.ittybitty/agents/<id>/.
  async function writeAgentMeta(repoPath: string, id: string, extra: Record<string, unknown> = {}): Promise<string> {
    const agentDir = join(repoPath, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `t-${id}`, ...extra }));
    return agentDir;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rename-test-"));
    secondRepo = await mkdtemp(join(tmpdir(), "rename-test2-"));
    originalHome = process.env.HOME;
    fakeHome = await mkdtemp(join(tmpdir(), "rename-home-"));
    process.env.HOME = fakeHome;
    resetReadAgentMetaCache();
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
    await rm(secondRepo, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
    resetReadAgentMetaCache();
  });

  test("happy path: writes nickname, resolvable by nickname, id still resolves", async () => {
    const agentDir = await writeAgentMeta(tempDir, "agent-abc");
    await registerRepos([tempDir]);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await renameAgent(agent, "pikachu");
    expect(result.ok).toBe(true);

    // Field written to meta.json
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.nickname).toBe("pikachu");

    // Resolvable by nickname AND by id
    resetReadAgentMetaCache();
    const { agents } = await readAllAgents([{ path: tempDir, name: basename(tempDir) }]);
    expect(matchAgentById("pikachu", agents).match?.id).toBe("agent-abc");
    expect(matchAgentById("agent-abc", agents).match?.id).toBe("agent-abc");
  });

  test("precedence: exact id wins over a matching nickname", async () => {
    // One agent has id "agent-abc"; another has nickname "agent-abc".
    // (The validator forbids creating this, but matchAgentById must still
    // encode id-wins so a stale meta can't produce nondeterminism.)
    const a = makeAgent("agent-abc", tempDir);
    const b = makeAgent("agent-xyz", tempDir);
    b.meta.nickname = "agent-abc";
    const agents = [b, a]; // nickname-holder FIRST in the array
    expect(matchAgentById("agent-abc", agents).match?.id).toBe("agent-abc");
  });

  test("precedence: nickname matched exactly only, never as a prefix", async () => {
    const a = makeAgent("agent-abc", tempDir);
    a.meta.nickname = "pikachu";
    const agents = [a];
    // Exact nickname resolves
    expect(matchAgentById("pikachu", agents).match?.id).toBe("agent-abc");
    // A prefix of the nickname does NOT resolve via the nickname tier
    expect(matchAgentById("pika", agents).match).toBeNull();
  });

  test("overwrite: setting a new nickname replaces the old one", async () => {
    const agentDir = await writeAgentMeta(tempDir, "agent-abc", { nickname: "old-name" });
    await registerRepos([tempDir]);

    const agent = makeAgent("agent-abc", tempDir);
    agent.meta.nickname = "old-name";
    const result = await renameAgent(agent, "new-name");
    expect(result.ok).toBe(true);

    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.nickname).toBe("new-name");
  });

  test("clear: deletes the field (not empty string)", async () => {
    const agentDir = await writeAgentMeta(tempDir, "agent-abc", { nickname: "pikachu" });
    await registerRepos([tempDir]);

    const agent = makeAgent("agent-abc", tempDir);
    agent.meta.nickname = "pikachu";
    const result = await renameAgent(agent, null);
    expect(result.ok).toBe(true);

    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect("nickname" in meta).toBe(false);
    expect(meta.nickname).toBeUndefined();
  });

  test("negative: invalid regex rejected", async () => {
    await writeAgentMeta(tempDir, "agent-abc");
    await registerRepos([tempDir]);
    const agent = makeAgent("agent-abc", tempDir);
    const result = await renameAgent(agent, "has spaces");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("letters, digits");
  });

  test("negative: reserved coordinator/system rejected", async () => {
    await writeAgentMeta(tempDir, "agent-abc");
    await registerRepos([tempDir]);
    const agent = makeAgent("agent-abc", tempDir);
    expect((await renameAgent(agent, "coordinator")).stderr).toContain("reserved");
    expect((await renameAgent(agent, "system")).stderr).toContain("reserved");
  });

  test("negative: collision with repo basename AND repo nickname rejected", async () => {
    await writeAgentMeta(tempDir, "agent-abc");
    // Register a repo whose basename is "tools" with a repo-nickname "alpha".
    await saveRegistry({
      repos: [
        { path: tempDir, name: basename(tempDir) },
        { path: "/tmp/tools-repo", name: "tools", nickname: "alpha" },
      ],
    });
    const agent = makeAgent("agent-abc", tempDir);
    // repo basename
    expect((await renameAgent(agent, "tools")).stderr).toContain("collides with registered repo name");
    // repo (display) nickname
    expect((await renameAgent(agent, "alpha")).stderr).toContain("collides with registered repo name");
  });

  test("negative: nickname == an existing agent id (global) rejected", async () => {
    await writeAgentMeta(tempDir, "agent-abc");
    await writeAgentMeta(tempDir, "agent-other");
    await registerRepos([tempDir]);
    const agent = makeAgent("agent-abc", tempDir);
    const result = await renameAgent(agent, "agent-other");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("collides with an existing agent id");
  });

  test("negative: nickname == another agent's nickname (cross-repo) rejected", async () => {
    await writeAgentMeta(tempDir, "agent-abc");
    // A DIFFERENT repo holds an agent that already owns the nickname "shared".
    await writeAgentMeta(secondRepo, "agent-far", { nickname: "shared" });
    await registerRepos([tempDir, secondRepo]);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await renameAgent(agent, "shared");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("already used by agent agent-far");
  });

  test("negative: nickname == own id rejected (points at --clear)", async () => {
    await writeAgentMeta(tempDir, "agent-abc");
    await registerRepos([tempDir]);
    const agent = makeAgent("agent-abc", tempDir);
    const result = await renameAgent(agent, "agent-abc");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("--clear");
  });

  test("allows re-setting THIS agent's own existing nickname value", async () => {
    // Setting the same nickname again should not trip the "another agent's
    // nickname" check (it's this agent's own).
    const agentDir = await writeAgentMeta(tempDir, "agent-abc", { nickname: "pikachu" });
    await registerRepos([tempDir]);
    const agent = makeAgent("agent-abc", tempDir);
    agent.meta.nickname = "pikachu";
    const result = await renameAgent(agent, "pikachu");
    expect(result.ok).toBe(true);
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.nickname).toBe("pikachu");
  });

  test("byId shadow guard: a nickname equal to another agent's id does not shadow it in buildAgentTree", async () => {
    // manager "agent-mgr" + child whose manager points at "agent-mgr".
    // A third agent carries nickname "agent-mgr". buildAgentTree's byId map is
    // keyed by real id, so the child must still resolve to the real manager.
    const mgr = makeAgent("agent-mgr", tempDir);
    const child = makeAgent("agent-child", tempDir);
    child.meta.manager = "agent-mgr";
    const impostor = makeAgent("agent-impostor", tempDir);
    impostor.meta.nickname = "agent-mgr"; // would shadow if nickname were keyed

    const roots = buildAgentTree([impostor, mgr, child]);
    // The real manager owns the child; the impostor does not.
    const realMgr = roots.find((a) => a.id === "agent-mgr");
    expect(realMgr).toBeDefined();
    expect(realMgr!.children.map((c) => c.id)).toContain("agent-child");
    const imp = roots.find((a) => a.id === "agent-impostor");
    expect(imp?.children.length ?? 0).toBe(0);
  });

  test("clear on an agent that has no nickname is a no-op success", async () => {
    const agentDir = await writeAgentMeta(tempDir, "agent-abc");
    await registerRepos([tempDir]);
    const agent = makeAgent("agent-abc", tempDir);
    const result = await renameAgent(agent, null);
    expect(result.ok).toBe(true);
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect("nickname" in meta).toBe(false);
  });

  test("agent not found (set) returns error", async () => {
    await registerRepos([tempDir]);
    const agent = makeAgent("agent-missing", tempDir);
    const result = await renameAgent(agent, "pikachu");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });
});

describe("newAgent nickname collision", () => {
  let tempDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "newagent-nick-repo-"));
    fakeHome = await mkdtemp(join(tmpdir(), "newagent-nick-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    // Stable repo-id so getRepoId() doesn't depend on randomness.
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    await Bun.write(join(tempDir, ".ittybitty", "repo-id"), "abcd1234\n");
    // newAgent calls ensureAgentTypesDir(); populate embedded defaults.
    await (await import("./agent-types")).ensureAgentTypesDir();
    // resolveGitRoot uses the lifecycle spawn ctx.
    lifecycleSpawnCtx.set((cmd: string[]): SpawnResult => {
      const s = cmd.join(" ");
      if (s.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
      if (s.includes("--show-toplevel")) return makeSpawnResult(0, tempDir);
      if (s.includes("--git-dir")) return makeSpawnResult(0, ".git");
      return makeSpawnResult(0);
    });
    // The collision check fires BEFORE any worktree/tmux spawn; the only spawn
    // call reached is `tmux has-session`, which must fail (id not taken yet).
    setNewAgentSpawnRunner((cmd: string[]): SpawnResult => {
      if (cmd.join(" ").includes("tmux has-session")) return makeSpawnResult(1);
      return makeSpawnResult(0);
    });
    resetReadAgentMetaCache();
  });

  afterEach(async () => {
    resetNewAgentSpawnRunner();
    lifecycleSpawnCtx.reset();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
    resetReadAgentMetaCache();
  });

  test("rejects --name matching an existing agent's nickname (global)", async () => {
    // Register the repo, then plant an existing agent whose nickname is "taken".
    await saveRegistry({ repos: [{ path: tempDir, name: "nick-repo" }] });
    const existingDir = join(tempDir, ".ittybitty", "agents", "agent-existing");
    await mkdir(existingDir, { recursive: true });
    await Bun.write(join(existingDir, "meta.json"), JSON.stringify({ id: "agent-existing", nickname: "taken", tmux_session: "t-existing" }));
    resetReadAgentMetaCache();

    const result = await newAgent(tempDir, "do work", { name: "taken", _cwd: tempDir });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("collides with an existing agent nickname");
  });
});

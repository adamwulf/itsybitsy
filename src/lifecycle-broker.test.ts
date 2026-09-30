import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Agent, AgentMeta } from "./agents";
import { resetUserHome, setUserHome } from "./home";
import type { IbCommandResult, NewAgentOptions, ResolvedCallerContext } from "./ib-commands";
import {
  LIFECYCLE_CLIENT_TIMEOUT_MS,
  LIFECYCLE_OPS,
  parseLifecycleRequest,
  requestLifecycleViaWatchdog,
  routeLifecycleThroughWatchdog,
  type LifecycleServerDeps,
} from "./lifecycle-broker";
import { setSandboxedProcessOverride } from "./sandbox-detect";
import { processSpawnRequests, spawnRequestDir, spawnResultDir, type SpawnServerDeps } from "./spawn-broker";

const MANAGER_ID = "agent-manager";
const CHILD_ID = "agent-child";
const ID_A = "a".repeat(32);

describe("lifecycle broker", () => {
  let home: string;
  let repo: string;
  let agentsDir: string;
  let agentDir: string;

  beforeEach(async () => {
    // The authorization rule looks the target up in the registry when it is not
    // in the caller's repo; keep that lookup away from the real ~/.itsybitsy.
    home = await mkdtemp(join(tmpdir(), "ib-lifecycle-home-"));
    setUserHome(home);
    repo = await mkdtemp(join(tmpdir(), "ib-lifecycle-"));
    agentsDir = join(repo, ".ittybitty", "agents");
    agentDir = join(agentsDir, MANAGER_ID);
    await mkdir(agentDir, { recursive: true });
  });
  afterEach(async () => {
    setSandboxedProcessOverride(null);
    resetUserHome();
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const managerMeta = (overrides: Record<string, unknown> = {}): AgentMeta =>
    ({ id: MANAGER_ID, worktree: true, canSpawnChildren: true, ...overrides }) as unknown as AgentMeta;

  const caller = (): ResolvedCallerContext => ({ meta: { id: MANAGER_ID }, agentDir, repoPath: repo });

  /** Put an agent's meta.json on disk, where the authorization rule reads it. */
  async function writeAgent(id: string, meta: Record<string, unknown>): Promise<void> {
    await mkdir(join(agentsDir, id), { recursive: true });
    await Bun.write(join(agentsDir, id, "meta.json"), JSON.stringify({ id, ...meta }));
  }

  const agentRecord = (id: string): Agent =>
    ({ id, repoPath: repo, repoName: "repo", meta: { id } as unknown as AgentMeta, state: "waiting", age: "", archived: false, children: [] }) as Agent;

  async function queue(id: string, body: unknown): Promise<void> {
    await mkdir(spawnRequestDir(agentDir), { recursive: true });
    await Bun.write(join(spawnRequestDir(agentDir), `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
  }
  const retireRequest = (id: string, extra: Record<string, unknown> = {}) => ({ v: 1, id, op: "retire", target: CHILD_ID, ...extra });

  async function result(id: string): Promise<any> {
    return Bun.file(join(spawnResultDir(agentDir), `${id}.json`)).json();
  }

  /** Server deps that record every command the watchdog would run. */
  function server(over: Partial<LifecycleServerDeps> = {}, spawnOver: Partial<SpawnServerDeps> = {}) {
    const retired: Agent[] = [];
    const spawned: Array<{ prompt: string; opts: NewAgentOptions }> = [];
    const deps: SpawnServerDeps = {
      readMeta: async () => ({ meta: managerMeta() }),
      verifySeal: async () => ({ ok: true }) as any,
      newAgent: async (_repoPath, prompt, opts) => {
        spawned.push({ prompt, opts });
        return { ok: true, exitCode: 0, stdout: "agent-new", stderr: "" };
      },
      lifecycle: {
        findAgent: async (_repoPath, id) => agentRecord(id),
        retire: async (agent) => {
          retired.push(agent);
          return { ok: true, exitCode: 0, stdout: `Closed agent: ${agent.id}`, stderr: "" };
        },
        ...over,
      },
      ...spawnOver,
    };
    return { deps, retired, spawned };
  }

  // ── request parsing (untrusted input) ──────────────────────────────────────

  describe("parseLifecycleRequest", () => {
    test("accepts an op and a target, and nothing else", () => {
      expect(parseLifecycleRequest(JSON.stringify(retireRequest(ID_A)), ID_A)).toEqual({
        ok: true,
        request: { v: 1, id: ID_A, op: "retire", target: CHILD_ID },
      });
    });

    test.each([
      ["repo", { repo: "/somewhere" }],
      ["prompt", { prompt: "do it" }],
      ["manager", { manager: "someone" }],
      ["_cwd", { _cwd: "/" }],
      ["targetDir", { targetDir: "/" }],
    ])("rejects the unsupported field %s", (field, extra) => {
      const parsed = parseLifecycleRequest(JSON.stringify(retireRequest(ID_A, extra)), ID_A);
      expect(parsed.ok).toBe(false);
      expect((parsed as any).error).toContain(`'${field}'`);
    });

    test.each([
      ["not JSON", "{oops"],
      ["an array", "[]"],
      ["a wrong version", JSON.stringify({ ...retireRequest(ID_A), v: 2 })],
      ["an id that does not match the file", JSON.stringify(retireRequest("b".repeat(32)))],
      ["an unknown op", JSON.stringify(retireRequest(ID_A, { op: "nuke" }))],
      ["a non-string op", JSON.stringify(retireRequest(ID_A, { op: 5 }))],
      ["a missing target", JSON.stringify({ v: 1, id: ID_A, op: "retire" })],
      ["a non-string target", JSON.stringify(retireRequest(ID_A, { target: 5 }))],
      ["a path as the target", JSON.stringify(retireRequest(ID_A, { target: "../other" }))],
      ["a target with shell text", JSON.stringify(retireRequest(ID_A, { target: "kid; ib nuke" }))],
    ])("rejects %s", (_label, text) => {
      expect(parseLifecycleRequest(text, ID_A).ok).toBe(false);
    });
  });

  // ── server (unsandboxed watchdog) ──────────────────────────────────────────

  describe("the watchdog's queue handler", () => {
    test("retires a child for its verified manager and writes the result", async () => {
      await writeAgent(CHILD_ID, { manager: MANAGER_ID });
      const { deps, retired, spawned } = server();
      await queue(ID_A, retireRequest(ID_A));

      expect(await processSpawnRequests(MANAGER_ID, repo, deps)).toBe(1);

      expect(retired.map((agent) => agent.id)).toEqual([CHILD_ID]);
      // A lifecycle request is never treated as a spawn.
      expect(spawned).toEqual([]);
      expect(await result(ID_A)).toEqual({ v: 1, id: ID_A, ok: true, exitCode: 0, stdout: `Closed agent: ${CHILD_ID}`, stderr: "" });
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
    });

    test("a spawn request in the same queue still spawns", async () => {
      const { deps, retired, spawned } = server();
      await queue(ID_A, { v: 1, id: ID_A, prompt: "build it" });
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(spawned.map((call) => call.prompt)).toEqual(["build it"]);
      expect(retired).toEqual([]);
    });

    test("an agent that is not the target's manager or spawner is refused", async () => {
      await writeAgent(CHILD_ID, { manager: "someone-else" });
      const { deps, retired } = server();
      await queue(ID_A, retireRequest(ID_A));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(retired).toEqual([]);
      const written = await result(ID_A);
      expect(written.ok).toBe(false);
      expect(written.stderr).toContain(`only the manager or spawner of '${CHILD_ID}' can run 'ib retire'`);
    });

    // The rule is the PreToolUse hook's, and the hook allows any command it
    // does not know. Every brokered op must therefore be one the hook gates.
    test.each([...LIFECYCLE_OPS])("'%s' is gated: a stranger is refused", async (op) => {
      await writeAgent(CHILD_ID, { manager: "someone-else" });
      const { deps, retired } = server();
      await queue(ID_A, retireRequest(ID_A, { op }));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(retired).toEqual([]);
      expect((await result(ID_A)).stderr).toContain("Access denied");
    });

    test("the spawner of the target may act on it", async () => {
      await writeAgent(CHILD_ID, { spawned_by: { agent_id: MANAGER_ID, repo_path: repo } });
      const { deps, retired } = server();
      await queue(ID_A, retireRequest(ID_A));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(retired.map((agent) => agent.id)).toEqual([CHILD_ID]);
    });

    test("a target that exists nowhere is refused", async () => {
      const { deps, retired } = server();
      await queue(ID_A, retireRequest(ID_A));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(retired).toEqual([]);
      expect((await result(ID_A)).stderr).toContain("not found in any registered repo");
    });

    test("a permitted target outside the caller's repo is refused", async () => {
      const { deps, retired } = server({ authorize: async () => null, findAgent: async () => null });
      await queue(ID_A, retireRequest(ID_A));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(retired).toEqual([]);
      expect((await result(ID_A)).stderr).toContain("only agents in its own repo");
    });

    test("the caller is the watchdog's own agent, whatever the request says", async () => {
      const seen: string[] = [];
      const { deps } = server({ authorize: async (_op, _target, callerId) => { seen.push(callerId); return null; } });
      await queue(ID_A, retireRequest(ID_A));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(seen).toEqual([MANAGER_ID]);
    });

    test("meta that no longer matches its sealed record is refused", async () => {
      await writeAgent(CHILD_ID, { manager: MANAGER_ID });
      const { deps, retired } = server({}, { verifySeal: async () => ({ ok: false, field: "agentType" }) as any });
      await queue(ID_A, retireRequest(ID_A));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(retired).toEqual([]);
      expect((await result(ID_A)).stderr).toContain("does not match its sealed record (agentType); refusing to retire");
    });

    test("an invalid request is answered, not acted on", async () => {
      const { deps, retired } = server();
      await queue(ID_A, retireRequest(ID_A, { target: "../escape" }));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(retired).toEqual([]);
      expect((await result(ID_A)).stderr).toContain("invalid target");
    });

    test("at-most-once: a retire that throws is consumed and answered, never retried", async () => {
      await writeAgent(CHILD_ID, { manager: MANAGER_ID });
      let attempts = 0;
      const { deps } = server({ retire: async () => { attempts++; throw new Error("boom"); } });
      await queue(ID_A, retireRequest(ID_A));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(attempts).toBe(1);
      expect((await result(ID_A)).stderr).toContain("boom");
    });

    test("relays the command's failure to the client", async () => {
      await writeAgent(CHILD_ID, { manager: MANAGER_ID });
      const failure: IbCommandResult = { ok: false, exitCode: 1, stdout: "", stderr: `Could not retire agent '${CHILD_ID}'` };
      const { deps } = server({ retire: async () => failure });
      await queue(ID_A, retireRequest(ID_A));
      await processSpawnRequests(MANAGER_ID, repo, deps);
      expect(await result(ID_A)).toMatchObject({ ok: false, exitCode: 1, stderr: failure.stderr });
    });
  });

  // ── client (runs inside the sandbox) ───────────────────────────────────────

  describe("requestLifecycleViaWatchdog", () => {
    const clientDeps = (over: Record<string, unknown> = {}) => ({
      resolveCaller: async () => caller(),
      watchdogLive: async () => true,
      sleep: async () => {},
      ...over,
    });

    test("round trip: the request reaches the watchdog and its answer comes back", async () => {
      await writeAgent(CHILD_ID, { manager: MANAGER_ID });
      const { deps, retired } = server();
      const out = await requestLifecycleViaWatchdog(
        { op: "retire", target: CHILD_ID },
        // Each poll gap, run the watchdog once — as it would between ticks.
        clientDeps({ sleep: async () => { await processSpawnRequests(MANAGER_ID, repo, deps); } }),
      );
      expect(out).toEqual({ ok: true, exitCode: 0, stdout: `Closed agent: ${CHILD_ID}`, stderr: "" });
      expect(retired.map((agent) => agent.id)).toEqual([CHILD_ID]);
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
      expect(await readdir(spawnResultDir(agentDir))).toEqual([]);
    });

    test("fails immediately, writing nothing, when the watchdog is not live", async () => {
      const out = await requestLifecycleViaWatchdog({ op: "retire", target: CHILD_ID }, clientDeps({ watchdogLive: async () => false }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain(`watchdog for '${MANAGER_ID}' is not running`);
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test("times out after the deadline and withdraws the unclaimed request", async () => {
      let clock = 0;
      const out = await requestLifecycleViaWatchdog({ op: "retire", target: CHILD_ID }, clientDeps({
        now: () => clock,
        sleep: async (ms: number) => { clock += ms; },
      }));
      expect(clock).toBeGreaterThanOrEqual(LIFECYCLE_CLIENT_TIMEOUT_MS);
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain(`timed out after 100s waiting for the watchdog of '${MANAGER_ID}' to retire '${CHILD_ID}'`);
      expect(out.stderr).toContain("withdrawn");
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
    });

    test("the default deadline is 100 seconds, under the 120s tool timeout", () => {
      expect(LIFECYCLE_CLIENT_TIMEOUT_MS).toBe(100_000);
    });

    test("a timeout after the watchdog took the request says the command may still finish", async () => {
      let clock = 0;
      const out = await requestLifecycleViaWatchdog({ op: "retire", target: CHILD_ID }, clientDeps({
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
          // The watchdog claims (removes) the request but never answers.
          for (const name of await readdir(spawnRequestDir(agentDir))) await rm(join(spawnRequestDir(agentDir), name));
        },
        timeoutMs: 1000,
      }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("already started the retire, so it may still finish");
    });

    test("a watchdog that predates the broker gets a restart hint, not a spawn error", async () => {
      const out = await requestLifecycleViaWatchdog({ op: "retire", target: CHILD_ID }, clientDeps({
        sleep: async () => {
          // An old watchdog parses every request as a spawn request.
          const [name] = await readdir(spawnRequestDir(agentDir));
          const id = name!.replace(".json", "");
          await rm(join(spawnRequestDir(agentDir), name!));
          await mkdir(spawnResultDir(agentDir), { recursive: true });
          await Bun.write(
            join(spawnResultDir(agentDir), `${id}.json`),
            JSON.stringify({ v: 1, id, ok: false, exitCode: 1, stdout: "", stderr: "Error: spawn request has unsupported field 'op'" }),
          );
        },
      }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain(`the watchdog for '${MANAGER_ID}' predates sandboxed 'ib retire'`);
      expect(out.stderr).toContain("Restart this agent");
    });

    test("a shell that is not inside an agent gets a clear error", async () => {
      const out = await requestLifecycleViaWatchdog({ op: "retire", target: CHILD_ID }, clientDeps({ resolveCaller: async () => null }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("not inside a registered agent");
    });

    test("an unverifiable caller is an error, not a direct run", async () => {
      const out = await requestLifecycleViaWatchdog({ op: "retire", target: CHILD_ID }, clientDeps({
        resolveCaller: async () => { throw new Error("Cannot verify no-worktree caller"); },
      }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("Cannot verify no-worktree caller");
    });
  });

  // ── routing from the CLI ───────────────────────────────────────────────────

  describe("routeLifecycleThroughWatchdog", () => {
    test("returns null when the process is not sandboxed (run directly, as before)", async () => {
      setSandboxedProcessOverride(() => false);
      expect(await routeLifecycleThroughWatchdog({ op: "retire", target: CHILD_ID })).toBeNull();
    });

    test("routes a sandboxed command through the watchdog", async () => {
      setSandboxedProcessOverride(() => true);
      await writeAgent(CHILD_ID, { manager: MANAGER_ID });
      const { deps } = server();
      const out = await routeLifecycleThroughWatchdog({ op: "retire", target: CHILD_ID }, {
        resolveCaller: async () => caller(),
        watchdogLive: async () => true,
        sleep: async () => { await processSpawnRequests(MANAGER_ID, repo, deps); },
      });
      expect(out).toEqual({ ok: true, exitCode: 0, stdout: `Closed agent: ${CHILD_ID}`, stderr: "" });
    });
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentMeta } from "./agents";
import type { IbCommandResult, NewAgentOptions, ResolvedCallerContext } from "./ib-commands";
import { setSandboxedProcessOverride } from "./sandbox-detect";
import {
  SPAWN_CLIENT_TIMEOUT_MS,
  SPAWN_MAX_PROMPT_BYTES,
  SPAWN_STALE_RESULT_MS,
  parseSpawnRequest,
  processSpawnRequests,
  requestSpawnViaWatchdog,
  routeNewAgentThroughWatchdog,
  spawnRequestDir,
  spawnResultDir,
  type SpawnServerDeps,
} from "./spawn-broker";

const AGENT_ID = "agent-spawner";
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

describe("spawn broker", () => {
  let repo: string;
  let agentDir: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ib-broker-"));
    agentDir = join(repo, ".ittybitty", "agents", AGENT_ID);
    await mkdir(agentDir, { recursive: true });
  });
  afterEach(async () => {
    setSandboxedProcessOverride(null);
    await rm(repo, { recursive: true, force: true });
  });

  const meta = (overrides: Record<string, unknown> = {}): AgentMeta =>
    ({ id: AGENT_ID, worktree: true, canSpawnChildren: true, ...overrides }) as unknown as AgentMeta;

  const caller = (): ResolvedCallerContext => ({ meta: { id: AGENT_ID }, agentDir, repoPath: repo });

  async function queue(id: string, body: unknown): Promise<void> {
    await mkdir(spawnRequestDir(agentDir), { recursive: true });
    await Bun.write(join(spawnRequestDir(agentDir), `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
  }
  const validRequest = (id: string, extra: Record<string, unknown> = {}) => ({ v: 1, id, prompt: "do the thing", ...extra });

  async function result(id: string): Promise<any> {
    return Bun.file(join(spawnResultDir(agentDir), `${id}.json`)).json();
  }

  /** Server deps whose newAgent records calls. */
  function server(over: Partial<SpawnServerDeps> = {}) {
    const calls: Array<{ repoPath: string; prompt: string; opts: NewAgentOptions }> = [];
    const deps: SpawnServerDeps = {
      readMeta: async () => ({ meta: meta() }),
      verifySeal: async () => ({ ok: true }) as any,
      newAgent: async (repoPath, prompt, opts) => {
        calls.push({ repoPath, prompt, opts });
        return { ok: true, exitCode: 0, stdout: "agent-child", stderr: "" };
      },
      ...over,
    };
    return { deps, calls };
  }

  // ── request parsing (untrusted input) ──────────────────────────────────────

  describe("parseSpawnRequest", () => {
    test("accepts the allowlisted fields and nothing else", () => {
      const parsed = parseSpawnRequest(
        JSON.stringify(validRequest(ID_A, { type: "worker", name: "kid", effort: "high", manager: "m", noWorktree: true })),
        ID_A,
      );
      expect(parsed).toEqual({
        ok: true,
        request: { v: 1, id: ID_A, prompt: "do the thing", type: "worker", name: "kid", effort: "high", manager: "m", noWorktree: true },
      });
    });

    test.each([
      ["model", { model: "claude:opus" }],
      ["repo", { repo: "/somewhere" }],
      ["spawnedBy", { spawnedBy: { agent_id: "x" } }],
      ["_trustedCaller", { _trustedCaller: {} }],
      ["_cwd", { _cwd: "/" }],
    ])("rejects the unsupported field %s", (field, extra) => {
      const parsed = parseSpawnRequest(JSON.stringify(validRequest(ID_A, extra)), ID_A);
      expect(parsed.ok).toBe(false);
      expect((parsed as any).error).toContain(`'${field}'`);
    });

    test.each([
      ["not JSON", "{oops"],
      ["an array", "[]"],
      ["a wrong version", JSON.stringify({ ...validRequest(ID_A), v: 2 })],
      ["an id that does not match the file", JSON.stringify(validRequest(ID_B))],
      ["an empty prompt", JSON.stringify(validRequest(ID_A, { prompt: "   " }))],
      ["a non-string prompt", JSON.stringify(validRequest(ID_A, { prompt: 5 }))],
      ["a non-string type", JSON.stringify(validRequest(ID_A, { type: 5 }))],
      ["an oversize field", JSON.stringify(validRequest(ID_A, { name: "n".repeat(500) }))],
      ["a non-boolean noWorktree", JSON.stringify(validRequest(ID_A, { noWorktree: "yes" }))],
    ])("rejects %s", (_label, text) => {
      expect(parseSpawnRequest(text, ID_A).ok).toBe(false);
    });

    test("rejects a prompt over the size cap", () => {
      const big = "x".repeat(SPAWN_MAX_PROMPT_BYTES + 1);
      expect(parseSpawnRequest(JSON.stringify(validRequest(ID_A, { prompt: big })), ID_A).ok).toBe(false);
    });
  });

  // ── server (unsandboxed watchdog) ──────────────────────────────────────────

  describe("processSpawnRequests", () => {
    test("spawns on behalf of the verified caller and writes the result", async () => {
      const { deps, calls } = server();
      await queue(ID_A, validRequest(ID_A, { type: "worker", name: "kid" }));

      expect(await processSpawnRequests(AGENT_ID, repo, deps)).toBe(1);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.repoPath).toBe(repo);
      expect(calls[0]!.prompt).toBe("do the thing");
      expect(calls[0]!.opts.type).toBe("worker");
      expect(calls[0]!.opts.name).toBe("kid");
      // The caller is the agent's own record, not anything from the request.
      expect(calls[0]!.opts._trustedCaller).toEqual({
        meta: meta() as unknown as Record<string, unknown>,
        agentDir,
        repoPath: repo,
      });
      expect(calls[0]!.opts._cwd).toBe(join(agentDir, "repo"));
      expect(calls[0]!.opts.model).toBeUndefined();
      expect(await result(ID_A)).toEqual({ v: 1, id: ID_A, ok: true, exitCode: 0, stdout: "agent-child", stderr: "" });
      // The request is consumed.
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
    });

    test("a worktree:false agent is 'located' at the repo root", async () => {
      const { deps, calls } = server({ readMeta: async () => ({ meta: meta({ worktree: false }) }) });
      await queue(ID_A, validRequest(ID_A));
      await processSpawnRequests(AGENT_ID, repo, deps);
      expect(calls[0]!.opts._cwd).toBe(repo);
    });

    test("relays newAgent's failure to the client", async () => {
      const failure: IbCommandResult = { ok: false, exitCode: 1, stdout: "", stderr: "Error: cannot spawn sub-agents" };
      const { deps } = server({ newAgent: async () => failure });
      await queue(ID_A, validRequest(ID_A));
      await processSpawnRequests(AGENT_ID, repo, deps);
      expect(await result(ID_A)).toMatchObject({ ok: false, exitCode: 1, stderr: "Error: cannot spawn sub-agents" });
    });

    test("an unsupported field is rejected without spawning", async () => {
      const { deps, calls } = server();
      await queue(ID_A, validRequest(ID_A, { model: "claude:opus" }));
      await processSpawnRequests(AGENT_ID, repo, deps);
      expect(calls).toHaveLength(0);
      expect((await result(ID_A)).stderr).toContain("unsupported field 'model'");
    });

    test("invalid JSON is answered, not spawned", async () => {
      const { deps, calls } = server();
      await queue(ID_A, "{broken");
      await processSpawnRequests(AGENT_ID, repo, deps);
      expect(calls).toHaveLength(0);
      expect((await result(ID_A)).ok).toBe(false);
    });

    test("meta that no longer matches its sealed record is refused (no privilege by editing meta.json)", async () => {
      const { deps, calls } = server({
        verifySeal: async () => ({ ok: false, field: "canSpawnChildren" }) as any,
      });
      await queue(ID_A, validRequest(ID_A));
      await processSpawnRequests(AGENT_ID, repo, deps);
      expect(calls).toHaveLength(0);
      expect((await result(ID_A)).stderr).toContain("does not match its sealed record (canSpawnChildren)");
    });

    test("a missing sealed record is refused with the refresh hint", async () => {
      const { deps, calls } = server({ verifySeal: async () => ({ ok: false, field: "(missing)" }) as any });
      await queue(ID_A, validRequest(ID_A));
      await processSpawnRequests(AGENT_ID, repo, deps);
      expect(calls).toHaveLength(0);
      expect((await result(ID_A)).stderr).toContain("ib sandbox refresh agent-spawner");
    });

    test("a seal check that throws is an error result, not a crash", async () => {
      const { deps, calls } = server({ verifySeal: async () => { throw new Error("seal store unreadable"); } });
      await queue(ID_A, validRequest(ID_A));
      await processSpawnRequests(AGENT_ID, repo, deps);
      expect(calls).toHaveLength(0);
      expect((await result(ID_A)).stderr).toContain("seal store unreadable");
    });

    test("meta that cannot be read, or names another agent, is refused", async () => {
      for (const readMeta of [
        async () => ({ meta: null }),
        async () => ({ meta: meta({ id: "someone-else" }) }),
      ] as SpawnServerDeps["readMeta"][]) {
        const { deps, calls } = server({ readMeta });
        await queue(ID_A, validRequest(ID_A));
        await processSpawnRequests(AGENT_ID, repo, deps);
        expect(calls).toHaveLength(0);
        expect((await result(ID_A)).ok).toBe(false);
        await rm(join(spawnResultDir(agentDir), `${ID_A}.json`));
      }
    });

    test("at-most-once: a request whose spawn throws is consumed and answered, never retried", async () => {
      let attempts = 0;
      const { deps } = server({ newAgent: async () => { attempts++; throw new Error("boom"); } });
      await queue(ID_A, validRequest(ID_A));
      await processSpawnRequests(AGENT_ID, repo, deps);
      await processSpawnRequests(AGENT_ID, repo, deps);
      expect(attempts).toBe(1);
      expect((await result(ID_A)).stderr).toContain("boom");
    });

    test("only plain 32-hex request files are ever acted on", async () => {
      const { deps, calls } = server();
      await queue("evil", validRequest(ID_A));
      await queue("..%2fescape", validRequest(ID_A));
      await Bun.write(join(spawnRequestDir(agentDir), `${ID_A}.json.tmp`), "x");
      expect(await processSpawnRequests(AGENT_ID, repo, deps)).toBe(0);
      expect(calls).toHaveLength(0);
    });

    test("handles several requests in order", async () => {
      const { deps, calls } = server();
      await queue(ID_B, validRequest(ID_B, { prompt: "second" }));
      await queue(ID_A, validRequest(ID_A, { prompt: "first" }));
      expect(await processSpawnRequests(AGENT_ID, repo, deps)).toBe(2);
      expect(calls.map((c) => c.prompt)).toEqual(["first", "second"]);
    });

    test("oversize output is clipped in the result", async () => {
      const { deps } = server({ newAgent: async () => ({ ok: true, exitCode: 0, stdout: "x".repeat(200_000), stderr: "" }) });
      await queue(ID_A, validRequest(ID_A));
      await processSpawnRequests(AGENT_ID, repo, deps);
      const written = await result(ID_A);
      expect(written.stdout.length).toBeLessThan(70_000);
      expect(written.stdout).toContain("(truncated)");
    });

    test("prunes results the client never collected, and only old ones", async () => {
      await mkdir(spawnResultDir(agentDir), { recursive: true });
      const stale = join(spawnResultDir(agentDir), `${ID_A}.json`);
      const fresh = join(spawnResultDir(agentDir), `${ID_B}.json`);
      await Bun.write(stale, "{}");
      await Bun.write(fresh, "{}");
      const old = new Date(Date.now() - SPAWN_STALE_RESULT_MS - 60_000);
      await utimes(stale, old, old);
      await processSpawnRequests(AGENT_ID, repo, server().deps);
      expect(await Bun.file(stale).exists()).toBe(false);
      expect(await Bun.file(fresh).exists()).toBe(true);
    });

    test("no queue directory is a no-op", async () => {
      expect(await processSpawnRequests(AGENT_ID, repo, server().deps)).toBe(0);
    });
  });

  // ── client (runs inside the sandbox) ───────────────────────────────────────

  describe("requestSpawnViaWatchdog", () => {
    const clientDeps = (over: Record<string, unknown> = {}) => ({
      resolveCaller: async () => caller(),
      watchdogLive: async () => true,
      sleep: async () => {},
      ...over,
    });

    test("round trip: the request reaches the watchdog and its answer comes back", async () => {
      const { deps, calls } = server();
      const out = await requestSpawnViaWatchdog(
        "build the thing",
        { type: "worker", name: "kid", manager: "boss", effort: "low" },
        // Each poll gap, run the watchdog once — as it would between ticks.
        clientDeps({ sleep: async () => { await processSpawnRequests(AGENT_ID, repo, deps); } }),
      );
      expect(out).toEqual({ ok: true, exitCode: 0, stdout: "agent-child", stderr: "" });
      expect(calls[0]!.prompt).toBe("build the thing");
      expect(calls[0]!.opts).toMatchObject({ type: "worker", name: "kid", manager: "boss", effort: "low" });
      // Both queues are left clean.
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
      expect(await readdir(spawnResultDir(agentDir))).toEqual([]);
    });

    test("carries the FULL prompt text in the request, never a file path", async () => {
      let seen = "";
      const out = await requestSpawnViaWatchdog("line one\nline two — ünïcode", {}, clientDeps({
        sleep: async () => {
          const [name] = await readdir(spawnRequestDir(agentDir));
          seen = await Bun.file(join(spawnRequestDir(agentDir), name!)).text();
          await processSpawnRequests(AGENT_ID, repo, server().deps);
        },
      }));
      expect(out.ok).toBe(true);
      expect(JSON.parse(seen).prompt).toBe("line one\nline two — ünïcode");
    });

    test("fails immediately, writing nothing, when the watchdog is not live", async () => {
      const out = await requestSpawnViaWatchdog("hi", {}, clientDeps({ watchdogLive: async () => false }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("watchdog for 'agent-spawner' is not running");
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test("times out after the deadline and withdraws the unclaimed request", async () => {
      let clock = 0;
      const out = await requestSpawnViaWatchdog("hi", {}, clientDeps({
        now: () => clock,
        sleep: async (ms: number) => { clock += ms; },
        timeoutMs: SPAWN_CLIENT_TIMEOUT_MS,
      }));
      expect(clock).toBeGreaterThanOrEqual(SPAWN_CLIENT_TIMEOUT_MS);
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("timed out after 30s");
      expect(out.stderr).toContain("withdrawn");
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
    });

    test("the default deadline is 30 seconds", () => {
      expect(SPAWN_CLIENT_TIMEOUT_MS).toBe(30_000);
    });

    test("a timeout after the watchdog took the request says the spawn may still complete", async () => {
      let clock = 0;
      const out = await requestSpawnViaWatchdog("hi", {}, clientDeps({
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
          // The watchdog claims (removes) the request but never answers.
          for (const name of await readdir(spawnRequestDir(agentDir))) await rm(join(spawnRequestDir(agentDir), name));
        },
        timeoutMs: 1000,
      }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("may still appear");
    });

    test("--model is refused before anything is written", async () => {
      const out = await requestSpawnViaWatchdog("hi", { model: "claude:opus" }, clientDeps());
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("cannot pass --model");
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test("an oversize prompt is refused before anything is written", async () => {
      const out = await requestSpawnViaWatchdog("x".repeat(SPAWN_MAX_PROMPT_BYTES + 1), {}, clientDeps());
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("prompt is larger");
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test("a shell that is not inside an agent gets a clear error", async () => {
      const out = await requestSpawnViaWatchdog("hi", {}, clientDeps({ resolveCaller: async () => null }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("not inside a registered agent");
    });

    test("an unverifiable caller is an error, not an unrestricted spawn", async () => {
      const out = await requestSpawnViaWatchdog("hi", {}, clientDeps({
        resolveCaller: async () => { throw new Error("Cannot verify no-worktree caller"); },
      }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("Cannot verify no-worktree caller");
    });

    test("a malformed result is an error", async () => {
      const out = await requestSpawnViaWatchdog("hi", {}, clientDeps({
        sleep: async () => {
          const [name] = await readdir(spawnRequestDir(agentDir));
          const id = name!.replace(".json", "");
          await mkdir(spawnResultDir(agentDir), { recursive: true });
          await Bun.write(join(spawnResultDir(agentDir), `${id}.json`), JSON.stringify({ id, ok: true }));
        },
      }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("malformed");
    });
  });

  // ── routing from `ib new-agent` ────────────────────────────────────────────

  describe("routeNewAgentThroughWatchdog", () => {
    test("returns null when the process is not sandboxed (spawn directly, as before)", async () => {
      setSandboxedProcessOverride(() => false);
      expect(await routeNewAgentThroughWatchdog("hi", {}, {})).toBeNull();
    });

    test("--repo and --spawned-by are refused inside the sandbox", async () => {
      setSandboxedProcessOverride(() => true);
      const repoOut = await routeNewAgentThroughWatchdog("hi", {}, { repoArg: "other" });
      expect(repoOut?.stderr).toContain("--repo is not supported inside the sandbox");
      const spawnedBy = await routeNewAgentThroughWatchdog("hi", {}, { spawnedByFlags: true });
      expect(spawnedBy?.stderr).toContain("internal");
    });

    test("routes a sandboxed spawn through the watchdog", async () => {
      setSandboxedProcessOverride(() => true);
      const { deps } = server();
      const out = await routeNewAgentThroughWatchdog("hi", {}, {}, {
        resolveCaller: async () => caller(),
        watchdogLive: async () => true,
        sleep: async () => { await processSpawnRequests(AGENT_ID, repo, deps); },
      });
      expect(out).toEqual({ ok: true, exitCode: 0, stdout: "agent-child", stderr: "" });
    });
  });
});

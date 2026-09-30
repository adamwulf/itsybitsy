import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Agent, AgentMeta } from "./agents";
import {
  ASK_OP,
  parseAskRequest,
  requestAskViaWatchdog,
  routeAskThroughWatchdog,
} from "./ask-broker";
import { resetUserConfigPath, setUserConfigPath } from "./config";
import { resetUserHome, setUserHome } from "./home";
import {
  resetAskQuestionTelegramRunner,
  resetSayRunner,
  setAskQuestionTelegramRunner,
  setSayRunner,
} from "./ib-commands";
import type { IbCommandResult, NewAgentOptions, ResolvedCallerContext } from "./ib-commands";
import { setSandboxedProcessOverride } from "./sandbox-detect";
import {
  SPAWN_CLIENT_TIMEOUT_MS,
  SPAWN_MAX_PROMPT_BYTES,
  processSpawnRequests,
  spawnRequestDir,
  spawnResultDir,
  type SpawnServerDeps,
} from "./spawn-broker";

const ASKER_ID = "agent-asker";
const OTHER_ID = "agent-other";
const ID_A = "a".repeat(32);
const QUESTION = "Should I proceed with the refactoring?";

describe("ask broker", () => {
  let home: string;
  let repo: string;
  let agentsDir: string;
  let agentDir: string;
  let said: string[][];
  let telegrams: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ib-ask-home-"));
    setUserHome(home);
    setUserConfigPath(join(home, "config.json"));
    repo = await mkdtemp(join(tmpdir(), "ib-ask-"));
    agentsDir = join(repo, ".ittybitty", "agents");
    agentDir = join(agentsDir, ASKER_ID);
    await writeAgent(ASKER_ID, {});
    // The real askQuestion() notifies the user; never run `say` or touch the
    // real Telegram outbox from a test.
    said = [];
    telegrams = [];
    setSayRunner((cmd) => { said.push(cmd); });
    setAskQuestionTelegramRunner(async (text) => {
      telegrams.push(text);
      return { ok: true, message: "stub" };
    });
  });
  afterEach(async () => {
    setSandboxedProcessOverride(null);
    resetSayRunner();
    resetAskQuestionTelegramRunner();
    resetUserConfigPath();
    resetUserHome();
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const askerMeta = (overrides: Record<string, unknown> = {}): AgentMeta =>
    ({ id: ASKER_ID, worktree: true, ...overrides }) as unknown as AgentMeta;

  const caller = (): ResolvedCallerContext => ({ meta: { id: ASKER_ID }, agentDir, repoPath: repo });

  /** Put an agent's meta.json on disk, where askQuestion() reads it. */
  async function writeAgent(id: string, meta: Record<string, unknown>): Promise<void> {
    await mkdir(join(agentsDir, id), { recursive: true });
    await Bun.write(join(agentsDir, id, "meta.json"), JSON.stringify({ id, ...meta }));
  }

  async function queue(id: string, body: unknown): Promise<void> {
    await mkdir(spawnRequestDir(agentDir), { recursive: true });
    await Bun.write(join(spawnRequestDir(agentDir), `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
  }
  const askRequest = (id: string, extra: Record<string, unknown> = {}) => ({ v: 1, id, op: ASK_OP, question: QUESTION, ...extra });

  async function result(id: string): Promise<any> {
    return Bun.file(join(spawnResultDir(agentDir), `${id}.json`)).json();
  }

  async function questionsOnDisk(): Promise<any[]> {
    const file = Bun.file(join(repo, ".ittybitty", "user-questions.json"));
    return (await file.exists()) ? (await file.json()).questions : [];
  }

  /** Server deps that record every command the watchdog would run. */
  function server(over: Partial<SpawnServerDeps> = {}) {
    const asked: Array<{ repoPath: string; agentId: string; question: string }> = [];
    const retired: Agent[] = [];
    const spawned: Array<{ prompt: string; opts: NewAgentOptions }> = [];
    const deps: SpawnServerDeps = {
      readMeta: async () => ({ meta: askerMeta() }),
      verifySeal: async () => ({ ok: true }) as any,
      newAgent: async (_repoPath, prompt, opts) => {
        spawned.push({ prompt, opts });
        return { ok: true, exitCode: 0, stdout: "agent-new", stderr: "" };
      },
      lifecycle: {
        authorize: async () => null,
        findAgent: async (_repoPath, id) =>
          ({ id, repoPath: repo, repoName: "repo", meta: { id } as unknown as AgentMeta, state: "waiting", age: "", archived: false, children: [] }) as Agent,
        retire: async (agent) => {
          retired.push(agent);
          return { ok: true, exitCode: 0, stdout: `Closed agent: ${agent.id}`, stderr: "" };
        },
      },
      askQuestion: async (repoPath, agentId, question) => {
        asked.push({ repoPath, agentId, question });
        return { ok: true, exitCode: 0, stdout: "Question submitted (q-1-abcdef)", stderr: "" };
      },
      ...over,
    };
    return { deps, asked, retired, spawned };
  }

  // ── request parsing (untrusted input) ──────────────────────────────────────

  describe("parseAskRequest", () => {
    test("accepts a question, and nothing else", () => {
      expect(parseAskRequest(JSON.stringify(askRequest(ID_A)), ID_A)).toEqual({
        ok: true,
        request: { v: 1, id: ID_A, op: "ask", question: QUESTION },
      });
    });

    test.each([
      ["agent", { agent: OTHER_ID }],
      ["repo", { repo: "/somewhere" }],
      ["fromHarness", { fromHarness: true }],
      ["target", { target: OTHER_ID }],
      ["prompt", { prompt: "do it" }],
    ])("rejects the unsupported field %s", (field, extra) => {
      const parsed = parseAskRequest(JSON.stringify(askRequest(ID_A, extra)), ID_A);
      expect(parsed.ok).toBe(false);
      expect((parsed as any).error).toContain(`'${field}'`);
    });

    test.each([
      ["not JSON", "{oops"],
      ["an array", "[]"],
      ["a wrong version", JSON.stringify({ ...askRequest(ID_A), v: 2 })],
      ["an id that does not match the file", JSON.stringify(askRequest("b".repeat(32)))],
      ["another op", JSON.stringify(askRequest(ID_A, { op: "retire" }))],
      ["a missing question", JSON.stringify({ v: 1, id: ID_A, op: "ask" })],
      ["an empty question", JSON.stringify(askRequest(ID_A, { question: "  \n" }))],
      ["a non-string question", JSON.stringify(askRequest(ID_A, { question: 5 }))],
      ["an oversize question", JSON.stringify(askRequest(ID_A, { question: "x".repeat(SPAWN_MAX_PROMPT_BYTES + 1) }))],
    ])("rejects %s", (_label, text) => {
      expect(parseAskRequest(text, ID_A).ok).toBe(false);
    });
  });

  // ── server (unsandboxed watchdog) ──────────────────────────────────────────

  describe("the watchdog's queue handler", () => {
    test("asks as the watchdog's own agent and writes the result", async () => {
      const { deps, asked, spawned, retired } = server();
      await queue(ID_A, askRequest(ID_A));

      expect(await processSpawnRequests(ASKER_ID, repo, deps)).toBe(1);

      expect(asked).toEqual([{ repoPath: repo, agentId: ASKER_ID, question: QUESTION }]);
      // A question is never treated as a spawn or as a lifecycle command.
      expect(spawned).toEqual([]);
      expect(retired).toEqual([]);
      expect(await result(ID_A)).toEqual({ v: 1, id: ID_A, ok: true, exitCode: 0, stdout: "Question submitted (q-1-abcdef)", stderr: "" });
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
    });

    test("the other kinds of request in the same queue are still dispatched", async () => {
      await writeAgent(OTHER_ID, { manager: ASKER_ID });
      const { deps, asked, spawned, retired } = server();
      await queue(ID_A, { v: 1, id: ID_A, prompt: "build it" });
      await queue("b".repeat(32), { v: 1, id: "b".repeat(32), op: "retire", target: OTHER_ID });
      await processSpawnRequests(ASKER_ID, repo, deps);
      expect(spawned.map((call) => call.prompt)).toEqual(["build it"]);
      expect(retired.map((agent) => agent.id)).toEqual([OTHER_ID]);
      expect(asked).toEqual([]);
    });

    // No askQuestion seam from here: the production command runs against the
    // files on disk.
    test("the real command records the question in the repo's questions file and notifies the user", async () => {
      const { deps } = server({ askQuestion: undefined });
      await queue(ID_A, askRequest(ID_A));
      await processSpawnRequests(ASKER_ID, repo, deps);

      const written = await result(ID_A);
      expect(written).toMatchObject({ ok: true, exitCode: 0, stderr: "" });
      expect(written.stdout).toMatch(/^Question submitted \(q-\d+-[0-9a-f]{6}\)$/);
      const questions = await questionsOnDisk();
      expect(questions).toHaveLength(1);
      expect(questions[0]).toMatchObject({ agent: ASKER_ID, question: QUESTION, status: "pending" });
      expect(await Bun.file(join(agentDir, "agent.log")).text()).toContain(`Asked question: ${QUESTION}`);
      expect(telegrams).toHaveLength(1);
      expect(telegrams[0]).toContain(QUESTION);
    });

    test("the top-level rule applies: an agent with a live manager is refused", async () => {
      await writeAgent(OTHER_ID, {});
      await writeAgent(ASKER_ID, { manager: OTHER_ID });
      const { deps } = server({ askQuestion: undefined });
      await queue(ID_A, askRequest(ID_A));
      await processSpawnRequests(ASKER_ID, repo, deps);

      const written = await result(ID_A);
      expect(written.ok).toBe(false);
      expect(written.stderr).toContain(`Agent has a manager (${OTHER_ID})`);
      expect(await questionsOnDisk()).toEqual([]);
      expect(telegrams).toEqual([]);
    });

    test("the config check applies: allowAgentQuestions=false is refused", async () => {
      await Bun.write(join(home, "config.json"), JSON.stringify({ allowAgentQuestions: false }));
      const { deps } = server({ askQuestion: undefined });
      await queue(ID_A, askRequest(ID_A));
      await processSpawnRequests(ASKER_ID, repo, deps);
      expect((await result(ID_A)).stderr).toContain("Agent questions are disabled");
      expect(await questionsOnDisk()).toEqual([]);
    });

    test("a request cannot ask in another agent's name", async () => {
      await writeAgent(OTHER_ID, {});
      const { deps, asked } = server();
      await queue(ID_A, askRequest(ID_A, { agent: OTHER_ID }));
      await processSpawnRequests(ASKER_ID, repo, deps);
      expect(asked).toEqual([]);
      expect((await result(ID_A)).stderr).toContain("unsupported field 'agent'");
    });

    test("a request cannot claim to be a harness question", async () => {
      const { deps, asked } = server();
      await queue(ID_A, askRequest(ID_A, { fromHarness: true }));
      await processSpawnRequests(ASKER_ID, repo, deps);
      expect(asked).toEqual([]);
      expect((await result(ID_A)).stderr).toContain("unsupported field 'fromHarness'");
    });

    test("meta that no longer matches its sealed record is refused", async () => {
      const { deps, asked } = server({ verifySeal: async () => ({ ok: false, field: "agentType" }) as any });
      await queue(ID_A, askRequest(ID_A));
      await processSpawnRequests(ASKER_ID, repo, deps);
      expect(asked).toEqual([]);
      expect((await result(ID_A)).stderr).toContain("does not match its sealed record (agentType); refusing to ask");
    });

    test("an invalid request is answered, not acted on", async () => {
      const { deps, asked } = server();
      await queue(ID_A, askRequest(ID_A, { question: "" }));
      await processSpawnRequests(ASKER_ID, repo, deps);
      expect(asked).toEqual([]);
      expect((await result(ID_A)).stderr).toBe("Error: ask request needs a non-empty question");
    });

    test("at-most-once: an ask that throws is consumed and answered, never retried", async () => {
      let attempts = 0;
      const { deps } = server({ askQuestion: async () => { attempts++; throw new Error("boom"); } });
      await queue(ID_A, askRequest(ID_A));
      await processSpawnRequests(ASKER_ID, repo, deps);
      await processSpawnRequests(ASKER_ID, repo, deps);
      expect(attempts).toBe(1);
      expect((await result(ID_A)).stderr).toBe("Error: ask failed: boom");
    });

    test("relays the command's failure to the client", async () => {
      const failure: IbCommandResult = { ok: false, exitCode: 1, stdout: "", stderr: "Agent questions are disabled (allowAgentQuestions=false)" };
      const { deps } = server({ askQuestion: async () => failure });
      await queue(ID_A, askRequest(ID_A));
      await processSpawnRequests(ASKER_ID, repo, deps);
      expect(await result(ID_A)).toMatchObject({ ok: false, exitCode: 1, stderr: failure.stderr });
    });
  });

  // ── client (runs inside the sandbox) ───────────────────────────────────────

  describe("requestAskViaWatchdog", () => {
    const clientDeps = (over: Record<string, unknown> = {}) => ({
      resolveCaller: async () => caller(),
      watchdogLive: async () => true,
      sleep: async () => {},
      ...over,
    });

    /** Answer the queued request the way a given old watchdog would. */
    const answerWith = (stderr: string) => async (): Promise<void> => {
      const [name] = await readdir(spawnRequestDir(agentDir));
      const id = name!.replace(".json", "");
      await rm(join(spawnRequestDir(agentDir), name!));
      await mkdir(spawnResultDir(agentDir), { recursive: true });
      await Bun.write(
        join(spawnResultDir(agentDir), `${id}.json`),
        JSON.stringify({ v: 1, id, ok: false, exitCode: 1, stdout: "", stderr }),
      );
    };

    test("round trip: the question reaches the questions file through the watchdog", async () => {
      const { deps } = server({ askQuestion: undefined });
      const out = await requestAskViaWatchdog(
        QUESTION,
        // Each poll gap, run the watchdog once — as it would between ticks.
        clientDeps({ sleep: async () => { await processSpawnRequests(ASKER_ID, repo, deps); } }),
      );
      expect(out.ok).toBe(true);
      expect(out.stdout).toMatch(/^Question submitted \(q-\d+-[0-9a-f]{6}\)$/);
      expect((await questionsOnDisk()).map((q) => ({ agent: q.agent, question: q.question }))).toEqual([
        { agent: ASKER_ID, question: QUESTION },
      ]);
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
      expect(await readdir(spawnResultDir(agentDir))).toEqual([]);
    });

    test("the request carries the question text and nothing that names an agent", async () => {
      const { deps } = server();
      const seen: Array<Record<string, unknown>> = [];
      await requestAskViaWatchdog(QUESTION, clientDeps({
        sleep: async () => {
          for (const name of await readdir(spawnRequestDir(agentDir))) {
            seen.push(await Bun.file(join(spawnRequestDir(agentDir), name)).json());
          }
          await processSpawnRequests(ASKER_ID, repo, deps);
        },
      }));
      expect(seen).toHaveLength(1);
      expect(Object.keys(seen[0]!)).toEqual(["v", "id", "op", "question"]);
      expect(seen[0]).toMatchObject({ v: 1, op: "ask", question: QUESTION });
    });

    test("fails immediately, writing nothing, when the watchdog is not live", async () => {
      const out = await requestAskViaWatchdog(QUESTION, clientDeps({ watchdogLive: async () => false }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain(`watchdog for '${ASKER_ID}' is not running`);
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    // A sub-agent must get the "use ib send" hint whatever the state of its
    // watchdog (old, stopped): a restart hint would send it the wrong way.
    test("a sub-agent with a live manager is refused before the watchdog is asked", async () => {
      await writeAgent(OTHER_ID, {});
      const out = await requestAskViaWatchdog(QUESTION, clientDeps({
        resolveCaller: async () => ({ ...caller(), meta: { id: ASKER_ID, manager: OTHER_ID } }),
        watchdogLive: async (): Promise<boolean> => { throw new Error("the watchdog must not be asked"); },
      }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toBe(`Agent has a manager (${OTHER_ID}). Use 'ib send ${OTHER_ID} "message"' to communicate with your manager.`);
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test("an agent whose manager is gone is sent to the watchdog", async () => {
      const { deps, asked } = server();
      const out = await requestAskViaWatchdog(QUESTION, clientDeps({
        resolveCaller: async () => ({ ...caller(), meta: { id: ASKER_ID, manager: "agent-gone" } }),
        sleep: async () => { await processSpawnRequests(ASKER_ID, repo, deps); },
      }));
      expect(out.ok).toBe(true);
      expect(asked).toHaveLength(1);
    });

    test("times out after the deadline and withdraws the unclaimed request", async () => {
      let clock = 0;
      const out = await requestAskViaWatchdog(QUESTION, clientDeps({
        now: () => clock,
        sleep: async (ms: number) => { clock += ms; },
      }));
      expect(clock).toBeGreaterThanOrEqual(SPAWN_CLIENT_TIMEOUT_MS);
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain(`timed out after 30s waiting for the watchdog of '${ASKER_ID}' to record the question`);
      expect(out.stderr).toContain("withdrawn");
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
    });

    test("a timeout after the watchdog took the request says the question may still reach the user", async () => {
      let clock = 0;
      const out = await requestAskViaWatchdog(QUESTION, clientDeps({
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
          // The watchdog claims (removes) the request but never answers.
          for (const name of await readdir(spawnRequestDir(agentDir))) await rm(join(spawnRequestDir(agentDir), name));
        },
        timeoutMs: 1000,
      }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("already taken the question, so it may still reach the user");
    });

    test.each([
      ["has no broker for an op", "Error: spawn request has unsupported field 'op'"],
      ["has the lifecycle broker only", "Error: lifecycle request has unsupported field 'question'"],
    ])("a watchdog that %s gets a restart hint", async (_label, stderr) => {
      const out = await requestAskViaWatchdog(QUESTION, clientDeps({ sleep: answerWith(stderr) }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain(`the watchdog for '${ASKER_ID}' predates sandboxed 'ib ask'`);
      expect(out.stderr).toContain("Restart this agent");
    });

    test("an oversize question is refused before anything is written", async () => {
      const out = await requestAskViaWatchdog("x".repeat(SPAWN_MAX_PROMPT_BYTES + 1), clientDeps());
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain(`question is larger than ${SPAWN_MAX_PROMPT_BYTES} bytes`);
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    // The router never sends these two callers here (it runs them directly);
    // asked anyway, the client refuses rather than guess an agent.
    test("a shell that is not inside an agent gets a clear error", async () => {
      const out = await requestAskViaWatchdog(QUESTION, clientDeps({ resolveCaller: async () => null }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("not inside a registered agent");
    });

    test("an unverifiable caller is an error", async () => {
      const out = await requestAskViaWatchdog(QUESTION, clientDeps({
        resolveCaller: async () => { throw new Error("Cannot verify no-worktree caller"); },
      }));
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("Cannot verify no-worktree caller");
    });
  });

  // ── routing from the CLI ───────────────────────────────────────────────────

  describe("routeAskThroughWatchdog", () => {
    test("returns null when the process is not sandboxed (ask directly, as before)", async () => {
      setSandboxedProcessOverride(() => false);
      expect(await routeAskThroughWatchdog(QUESTION, ASKER_ID)).toBeNull();
    });

    test("routes a sandboxed worktree agent through the watchdog", async () => {
      setSandboxedProcessOverride(() => true);
      const { deps, asked } = server();
      const out = await routeAskThroughWatchdog(QUESTION, ASKER_ID, {
        resolveCaller: async () => caller(),
        watchdogLive: async () => true,
        sleep: async () => { await processSpawnRequests(ASKER_ID, repo, deps); },
      });
      expect(out).toEqual({ ok: true, exitCode: 0, stdout: "Question submitted (q-1-abcdef)", stderr: "" });
      expect(asked).toEqual([{ repoPath: repo, agentId: ASKER_ID, question: QUESTION }]);
    });

    test("--id for another agent is refused, and nothing is queued", async () => {
      setSandboxedProcessOverride(() => true);
      const out = await routeAskThroughWatchdog(QUESTION, OTHER_ID, {
        resolveCaller: async () => caller(),
        watchdogLive: async (): Promise<boolean> => { throw new Error("the broker must not be asked"); },
      });
      expect(out?.ok).toBe(false);
      expect(out?.stderr).toContain("--id for another agent is not supported inside the sandbox");
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    // Callers that keep the direct path. None of them may reach the broker:
    // `watchdogLive` throws if the client gets that far.
    const directOnly = (resolveCaller: () => Promise<ResolvedCallerContext | null>) => ({
      resolveCaller,
      watchdogLive: async (): Promise<boolean> => { throw new Error("the broker must not be asked"); },
    });
    const callerWith = (meta: Record<string, unknown>): ResolvedCallerContext =>
      ({ meta: { id: ASKER_ID, ...meta }, agentDir, repoPath: repo });

    test("a worktree:false agent asks directly (it has no per-agent watchdog)", async () => {
      setSandboxedProcessOverride(() => true);
      const out = await routeAskThroughWatchdog(QUESTION, ASKER_ID, directOnly(async () => callerWith({ worktree: false })));
      expect(out).toBeNull();
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test("an agent whose itsybitsy sandbox is off asks directly (e.g. codex in its own sandbox)", async () => {
      setSandboxedProcessOverride(() => true);
      const out = await routeAskThroughWatchdog(
        QUESTION,
        ASKER_ID,
        directOnly(async () => callerWith({ sandbox: { enabled: false, rawAllow: [], domains: [] } })),
      );
      expect(out).toBeNull();
    });

    test("a sandboxed shell that is not an agent asks directly", async () => {
      setSandboxedProcessOverride(() => true);
      expect(await routeAskThroughWatchdog(QUESTION, ASKER_ID, directOnly(async () => null))).toBeNull();
    });

    test("a caller that cannot be verified asks directly", async () => {
      setSandboxedProcessOverride(() => true);
      const out = await routeAskThroughWatchdog(
        QUESTION,
        ASKER_ID,
        directOnly(async () => { throw new Error("Cannot verify no-worktree caller"); }),
      );
      expect(out).toBeNull();
    });
  });
});

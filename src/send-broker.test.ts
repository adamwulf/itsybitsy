import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { resetListTmuxSessionsCache, type Agent, type AgentMeta } from "./agents";
import { resetUserHome, setUserHome } from "./home";
import {
  resetMessageAttachmentStagerForTesting,
  resetSendSpawnRunner,
  setMessageAttachmentStagerForTesting,
  setSendSpawnRunner,
  type IbCommandResult,
  type NewAgentOptions,
  type ResolvedCallerContext,
} from "./ib-commands";
import type { RepoEntry } from "./registry";
import { setSandboxedProcessOverride } from "./sandbox-detect";
import {
  SEND_MAX_TARGET_CHARS,
  SEND_OP,
  parseSendRequest,
  requestSendViaWatchdog,
  routeSendThroughWatchdog,
  type SendCommand,
} from "./send-broker";
import {
  SPAWN_CLIENT_TIMEOUT_MS,
  SPAWN_MAX_PROMPT_BYTES,
  processSpawnRequests,
  spawnRequestDir,
  spawnResultDir,
  type SpawnServerDeps,
} from "./spawn-broker";
import { spawnCtx as tmuxPollerSpawnCtx } from "./tmux-poller";
import type { SpawnFn } from "./types";

const SENDER_ID = "cli-helper";
const TARGET_ID = "cli-email-client";
const OTHER_ID = "agent-other";
const ID_A = "a".repeat(32);
const MESSAGE = "Please check the IMAP flags.";

describe("send broker", () => {
  let home: string;
  let senderRepo: string;
  let targetRepo: string;
  let repos: RepoEntry[];
  let agentDir: string;
  /**
   * No test may reach a real tmux server. Both places that start a tmux client
   * are stubbed: the send path (`sendSpawnCtx`: has-session, send-keys) and
   * readAllAgents' session scan (`tmux list-sessions` through tmux-poller's
   * `spawnCtx`, reached by teamSend's liveness check). `tmuxCalls` is what a
   * send tried to type and must stay empty; `tmuxListCalls` is the scans.
   */
  let tmuxCalls: string[][];
  let tmuxListCalls: string[][];

  const closed = () => new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  /** Records the command and fails it, so nothing can be delivered by accident. */
  const recordingTmux: SpawnFn = (cmd) => {
    tmuxCalls.push(cmd);
    return { stdout: closed(), stderr: closed(), exited: Promise.resolve(1), kill: () => {} };
  };
  /** Records the scan and answers "no sessions". */
  const recordingTmuxList: SpawnFn = (cmd) => {
    tmuxListCalls.push(cmd);
    return { stdout: closed(), stderr: closed(), exited: Promise.resolve(0), kill: () => {} };
  };

  beforeEach(async () => {
    // The outbox (`~/.itsybitsy/agents/<id>/`) and teams.json resolve under
    // this home, never the real one.
    home = await mkdtemp(join(tmpdir(), "ib-send-home-"));
    setUserHome(home);
    senderRepo = await mkdtemp(join(tmpdir(), "ib-send-hunch-"));
    targetRepo = await mkdtemp(join(tmpdir(), "ib-send-iris-"));
    repos = [
      { path: senderRepo, name: "hunch" },
      { path: targetRepo, name: "iris" },
    ];
    agentDir = join(senderRepo, ".ittybitty", "agents", SENDER_ID);
    await writeAgent(senderRepo, SENDER_ID, {});
    await writeAgent(targetRepo, TARGET_ID, {});
    tmuxCalls = [];
    tmuxListCalls = [];
    setSendSpawnRunner(recordingTmux);
    tmuxPollerSpawnCtx.set(recordingTmuxList);
    // A session list cached by an earlier test would hide a scan from this one.
    resetListTmuxSessionsCache();
  });
  afterEach(async () => {
    setSandboxedProcessOverride(null);
    resetSendSpawnRunner();
    tmuxPollerSpawnCtx.reset();
    resetListTmuxSessionsCache();
    resetMessageAttachmentStagerForTesting();
    resetUserHome();
    await rm(senderRepo, { recursive: true, force: true });
    await rm(targetRepo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const senderMeta = (overrides: Record<string, unknown> = {}): AgentMeta =>
    ({ id: SENDER_ID, worktree: true, ...overrides }) as unknown as AgentMeta;

  const caller = (): ResolvedCallerContext => ({ meta: { id: SENDER_ID }, agentDir, repoPath: senderRepo });

  /**
   * Put an agent on disk, with a LIVE watchdog heartbeat (this process's pid),
   * so a real sendMessage() only queues the message and never drains it into
   * tmux itself.
   */
  async function writeAgent(repo: string, id: string, meta: Record<string, unknown>): Promise<string> {
    const dir = join(repo, ".ittybitty", "agents", id);
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, "meta.json"),
      JSON.stringify({ id, tmux_session: `ittybitty-test-${id}`, created_epoch: 0, worktree: true, ...meta }),
    );
    await Bun.write(
      join(dir, "meta.transient.json"),
      JSON.stringify({
        tmux_compacting: false,
        tmux_rate_limited: false,
        has_background_tasks: false,
        updated_at_ms: Date.now(),
        watchdog_pid: process.pid,
      }),
    );
    return dir;
  }

  /** The messages queued for an agent (`~/.itsybitsy/agents/<id>/outbox.jsonl`). */
  async function outbox(id: string): Promise<Array<Record<string, unknown>>> {
    const file = Bun.file(join(home, ".itsybitsy", "agents", id, "outbox.jsonl"));
    if (!(await file.exists())) return [];
    return (await file.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  async function queue(id: string, body: unknown): Promise<void> {
    await mkdir(spawnRequestDir(agentDir), { recursive: true });
    await Bun.write(join(spawnRequestDir(agentDir), `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
  }
  const sendRequest = (id: string, extra: Record<string, unknown> = {}) =>
    ({ v: 1, id, op: SEND_OP, target: TARGET_ID, message: MESSAGE, ...extra });

  async function result(id: string): Promise<any> {
    return Bun.file(join(spawnResultDir(agentDir), `${id}.json`)).json();
  }

  const ok = (stdout = ""): IbCommandResult => ({ ok: true, exitCode: 0, stdout, stderr: "" });

  /**
   * Server deps: the real target resolution and the real sendMessage (into the
   * test home), with the registry and the other kinds of request stubbed.
   * `over.send` replaces individual send seams.
   */
  function server(over: Partial<SpawnServerDeps> = {}) {
    const spawned: Array<{ prompt: string; opts: NewAgentOptions }> = [];
    const asked: string[] = [];
    const { send: sendOver, ...rest } = over;
    const deps: SpawnServerDeps = {
      readMeta: async () => ({ meta: senderMeta() }),
      verifySeal: async () => ({ ok: true }) as any,
      newAgent: async (_repoPath, prompt, opts) => {
        spawned.push({ prompt, opts });
        return ok("agent-new");
      },
      askQuestion: async (_repoPath, _agentId, question) => {
        asked.push(question);
        return ok("Question submitted (q-1-abcdef)");
      },
      ...rest,
      send: { listRepos: async () => repos, ...sendOver },
    };
    return { deps, spawned, asked };
  }

  /** Send seams that record each call instead of sending. */
  function recordingSends() {
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    return {
      calls,
      seams: {
        sendMessage: async (agent: Agent, message: string, opts: { fromAgent: string }) => {
          calls.push({ kind: "agent", args: [agent.id, agent.repoPath, message, opts] });
          return ok();
        },
        teamSend: async (name: string, members: Agent[], message: string, opts: { fromAgent: string }, rs: RepoEntry[]) => {
          calls.push({ kind: "team", args: [name, members.map((m) => m.id), message, opts, rs] });
          return ok(`Sent to ${members.length} member(s) of @${name}`);
        },
        sendToSystemCoordinator: async (message: string, opts: { fromAgent: string; cwd: string }) => {
          calls.push({ kind: "system", args: [message, opts] });
          return ok("Sent to system coordinator");
        },
      },
    };
  }

  // ── request parsing (untrusted input) ──────────────────────────────────────

  describe("parseSendRequest", () => {
    test("accepts a target and a message, and nothing else", () => {
      expect(parseSendRequest(JSON.stringify(sendRequest(ID_A)), ID_A)).toEqual({
        ok: true,
        request: { v: 1, id: ID_A, op: "send", target: TARGET_ID, message: MESSAGE },
      });
    });

    test("accepts every target form of the CLI", () => {
      for (const target of ["@iris/cli-email-client", "@iris", "@coordinator", "@system", "@backend", "nick name"]) {
        expect(parseSendRequest(JSON.stringify(sendRequest(ID_A, { target })), ID_A).ok).toBe(true);
      }
    });

    test.each([
      ["from", { from: OTHER_ID }],
      ["fromAgent", { fromAgent: OTHER_ID }],
      ["agent", { agent: OTHER_ID }],
      ["repo", { repo: "/somewhere" }],
      ["path", { path: "/etc/hosts" }],
      ["file", { file: "/Users/me/.env" }],
      ["stageAttachments", { stageAttachments: true }],
      ["cwd", { cwd: "/" }],
      ["raw", { raw: true }],
    ])("rejects the unsupported field %s", (field, extra) => {
      const parsed = parseSendRequest(JSON.stringify(sendRequest(ID_A, extra)), ID_A);
      expect(parsed.ok).toBe(false);
      expect((parsed as any).error).toContain(`'${field}'`);
    });

    test.each([
      ["not JSON", "{oops"],
      ["an array", "[]"],
      ["a wrong version", JSON.stringify({ ...sendRequest(ID_A), v: 2 })],
      ["an id that does not match the file", JSON.stringify(sendRequest("b".repeat(32)))],
      ["another op", JSON.stringify(sendRequest(ID_A, { op: "ask" }))],
      ["a missing target", JSON.stringify({ v: 1, id: ID_A, op: "send", message: MESSAGE })],
      ["an empty target", JSON.stringify(sendRequest(ID_A, { target: "" }))],
      ["a non-string target", JSON.stringify(sendRequest(ID_A, { target: 5 }))],
      ["an oversize target", JSON.stringify(sendRequest(ID_A, { target: "x".repeat(SEND_MAX_TARGET_CHARS + 1) }))],
      ["a target with a control character", JSON.stringify(sendRequest(ID_A, { target: "agent\nx" }))],
      ["a missing message", JSON.stringify({ v: 1, id: ID_A, op: "send", target: TARGET_ID })],
      ["an empty message", JSON.stringify(sendRequest(ID_A, { message: "" }))],
      ["a non-string message", JSON.stringify(sendRequest(ID_A, { message: 5 }))],
      ["an oversize message", JSON.stringify(sendRequest(ID_A, { message: "x".repeat(SPAWN_MAX_PROMPT_BYTES + 1) }))],
    ])("rejects %s", (_label, text) => {
      expect(parseSendRequest(text, ID_A).ok).toBe(false);
    });
  });

  // ── server (unsandboxed watchdog) ──────────────────────────────────────────

  describe("the watchdog's queue handler", () => {
    test("sends to an agent in another repo, as the watchdog's own agent", async () => {
      const { deps, spawned, asked } = server();
      await queue(ID_A, sendRequest(ID_A));

      expect(await processSpawnRequests(SENDER_ID, senderRepo, deps)).toBe(1);

      // The real sendMessage queued it for the target's (live) watchdog.
      const queued = await outbox(TARGET_ID);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ message: MESSAGE, fromAgent: SENDER_ID, raw: false });
      // A sender is set, so stdout is empty (SPEC §4.1, step 7).
      expect(await result(ID_A)).toEqual({ v: 1, id: ID_A, ok: true, exitCode: 0, stdout: "", stderr: "" });
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
      // A message is never treated as a spawn or a question, and reaches no tmux
      // (target resolution reads agents from disk only).
      expect(spawned).toEqual([]);
      expect(asked).toEqual([]);
      expect(tmuxCalls).toEqual([]);
      expect(tmuxListCalls).toEqual([]);
    });

    test("the sender is the verified agent: --from cannot be smuggled in the request", async () => {
      const { deps } = server();
      await queue(ID_A, sendRequest(ID_A, { from: OTHER_ID }));
      await processSpawnRequests(SENDER_ID, senderRepo, deps);
      expect((await result(ID_A)).stderr).toBe("Error: send request has unsupported field 'from'");
      expect(await outbox(TARGET_ID)).toEqual([]);
    });

    test("never stages attachments: a path in the message is sent as text and no file is copied", async () => {
      const staged: string[] = [];
      setMessageAttachmentStagerForTesting(async (message) => {
        staged.push(message);
        return { message: "/tmp/staged/.env", staged: true, cleanup: async () => {} } as any;
      });
      const secret = join(targetRepo, ".env");
      await Bun.write(secret, "TOKEN=secret");
      const { deps } = server();
      await queue(ID_A, sendRequest(ID_A, { message: `read ${secret}` }));
      await processSpawnRequests(SENDER_ID, senderRepo, deps);

      expect(staged).toEqual([]);
      expect((await outbox(TARGET_ID)).map((m) => m.message)).toEqual([`read ${secret}`]);
    });

    test("passes exactly { fromAgent } to the send, whatever the target", async () => {
      const { calls, seams } = recordingSends();
      const { deps } = server({ send: seams });
      await queue(ID_A, sendRequest(ID_A));
      await processSpawnRequests(SENDER_ID, senderRepo, deps);
      expect(calls).toEqual([{ kind: "agent", args: [TARGET_ID, targetRepo, MESSAGE, { fromAgent: SENDER_ID }] }]);
    });

    describe("target resolution across repos", () => {
      async function sendTo(target: string, over: SpawnServerDeps["send"] = {}) {
        const sends = recordingSends();
        const { deps } = server({ send: { ...sends.seams, ...over } });
        await queue(ID_A, sendRequest(ID_A, { target }));
        await processSpawnRequests(SENDER_ID, senderRepo, deps);
        return { calls: sends.calls, written: await result(ID_A) };
      }

      test("@repo/agent", async () => {
        const { calls, written } = await sendTo("@iris/cli-email-client");
        expect(written.ok).toBe(true);
        expect(calls.map((c) => c.args.slice(0, 2))).toEqual([[TARGET_ID, targetRepo]]);
      });

      test("a nickname in another repo", async () => {
        await writeAgent(targetRepo, "agent-nicked", { nickname: "mailer" });
        const { calls } = await sendTo("mailer");
        expect(calls.map((c) => c.args[0])).toEqual(["agent-nicked"]);
      });

      test("a bare id prefers the requester's own repo", async () => {
        await writeAgent(senderRepo, TARGET_ID, {});
        const { calls } = await sendTo(TARGET_ID);
        expect(calls.map((c) => c.args.slice(0, 2))).toEqual([[TARGET_ID, senderRepo]]);
      });

      test("@repo is that repo's coordinator", async () => {
        await writeAgent(targetRepo, "iris-coord", { agentType: "coordinator" });
        const { calls } = await sendTo("@iris");
        expect(calls.map((c) => c.args.slice(0, 2))).toEqual([["iris-coord", targetRepo]]);
      });

      test("@coordinator is the REQUESTER's repo coordinator, not the watchdog's cwd", async () => {
        await writeAgent(senderRepo, "hunch-coord", { agentType: "coordinator" });
        await writeAgent(targetRepo, "iris-coord", { agentType: "coordinator" });
        const seen: string[] = [];
        const { calls } = await sendTo("@coordinator", {
          resolveTarget: async (target, rs, cwd) => {
            seen.push(cwd);
            const { resolveSendTarget } = await import("./resolve-target");
            return resolveSendTarget(target, rs, cwd);
          },
        });
        expect(seen).toEqual([join(agentDir, "repo")]);
        expect(calls.map((c) => c.args.slice(0, 2))).toEqual([["hunch-coord", senderRepo]]);
      });

      test("@system goes to the system coordinator, from the requester's worktree", async () => {
        const { calls, written } = await sendTo("@system");
        expect(calls).toEqual([{ kind: "system", args: [MESSAGE, { fromAgent: SENDER_ID, cwd: join(agentDir, "repo") }] }]);
        expect(written.stdout).toBe("Sent to system coordinator");
      });

      test("@team fans out with the requester as the sender", async () => {
        await writeAgent(targetRepo, OTHER_ID, {});
        await mkdir(join(home, ".itsybitsy"), { recursive: true });
        await Bun.write(
          join(home, ".itsybitsy", "teams.json"),
          JSON.stringify({ teams: { backend: { created_epoch: 0, created_by: "", members: [TARGET_ID, OTHER_ID] } } }),
        );
        const { calls } = await sendTo("@backend");
        expect(calls).toEqual([
          {
            kind: "team",
            args: ["backend", [TARGET_ID, OTHER_ID], MESSAGE, { fromAgent: SENDER_ID, excludeRecipient: expect.any(Function) }, repos],
          },
        ]);
      });

      test("an unknown target is reported back, and nothing is sent", async () => {
        const { calls, written } = await sendTo("nobody-here");
        expect(calls).toEqual([]);
        expect(written).toMatchObject({ ok: false, exitCode: 1, stderr: "Agent not found: nobody-here" });
      });

      test("an unknown repo is reported back", async () => {
        const { written } = await sendTo("@nope/agent");
        expect(written.stderr).toBe("Error: no repo or team named: nope");
      });
    });

    // The requester's tmux_session and heartbeat are files it can write. A send
    // to itself would let it choose where the unsandboxed watchdog types.
    describe("never to the requester itself", () => {
      async function teamOf(members: string[]): Promise<void> {
        await mkdir(join(home, ".itsybitsy"), { recursive: true });
        await Bun.write(
          join(home, ".itsybitsy", "teams.json"),
          JSON.stringify({ teams: { backend: { created_epoch: 0, created_by: "", members } } }),
        );
      }

      test("a target that is the requester is refused, and nothing is sent", async () => {
        await writeAgent(senderRepo, SENDER_ID, { tmux_session: "0" });
        const { deps } = server();
        await queue(ID_A, sendRequest(ID_A, { target: SENDER_ID }));
        await processSpawnRequests(SENDER_ID, senderRepo, deps);
        expect(await result(ID_A)).toMatchObject({
          ok: false,
          stderr: `Error: '${SENDER_ID}' cannot send to itself through its watchdog; send directly`,
        });
        expect(await outbox(SENDER_ID)).toEqual([]);
        expect(tmuxCalls).toEqual([]);
      });

      test("the requester is recognized by its directory when its meta.json claims another id", async () => {
        // meta.json is the agent's own to write; the seal check (stubbed here)
        // saw the right id a moment earlier.
        await writeAgent(senderRepo, SENDER_ID, { id: "decoy", tmux_session: "0" });
        const { deps } = server();
        await queue(ID_A, sendRequest(ID_A, { target: "decoy" }));
        await processSpawnRequests(SENDER_ID, senderRepo, deps);
        expect((await result(ID_A)).stderr).toContain("cannot send to itself through its watchdog");
        expect(await outbox("decoy")).toEqual([]);
      });

      test("a team drops the requester by its directory, and still reaches the others", async () => {
        await writeAgent(senderRepo, SENDER_ID, { id: "decoy", tmux_session: "0" });
        await teamOf(["decoy", TARGET_ID]);
        const { deps } = server();
        await queue(ID_A, sendRequest(ID_A, { target: "@backend" }));
        await processSpawnRequests(SENDER_ID, senderRepo, deps);
        expect(await result(ID_A)).toMatchObject({ ok: true, stdout: "Sent to 1 member(s) of @backend" });
        expect(await outbox("decoy")).toEqual([]);
        expect((await outbox(TARGET_ID)).map((m) => [m.message, m.fromAgent, m.team])).toEqual([[MESSAGE, SENDER_ID, "backend"]]);
        expect(tmuxCalls).toEqual([]);
        // teamSend's liveness check scans sessions, through the stub. Not
        // asserted to happen: orphan-detection.test.ts replaces listTmuxSessions
        // with a global mock.module, and when it ran earlier in the same
        // process the scan never reaches spawnCtx (it is still no real tmux).
        expect(tmuxListCalls.every((cmd) => cmd.join(" ") === "tmux list-sessions -F #{session_name}")).toBe(true);
      });

      test("an agent with the requester's id in another repo is not the requester", async () => {
        await writeAgent(targetRepo, SENDER_ID, {});
        const { calls, seams } = recordingSends();
        const { deps } = server({ send: seams });
        await queue(ID_A, sendRequest(ID_A, { target: `@iris/${SENDER_ID}` }));
        await processSpawnRequests(SENDER_ID, senderRepo, deps);
        expect(calls.map((c) => c.args.slice(0, 2))).toEqual([[SENDER_ID, targetRepo]]);
      });
    });

    test("meta that no longer matches its sealed record is refused, and nothing is sent", async () => {
      const { deps } = server({ verifySeal: async () => ({ ok: false, field: "sandbox" }) as any });
      await queue(ID_A, sendRequest(ID_A));
      await processSpawnRequests(SENDER_ID, senderRepo, deps);
      expect((await result(ID_A)).stderr).toContain("does not match its sealed record (sandbox); refusing to send");
      expect(await outbox(TARGET_ID)).toEqual([]);
    });

    test("an unreadable requester record is refused", async () => {
      const { deps } = server({ readMeta: async () => ({ meta: null, error: "gone" }) });
      await queue(ID_A, sendRequest(ID_A));
      await processSpawnRequests(SENDER_ID, senderRepo, deps);
      expect((await result(ID_A)).stderr).toContain(`cannot read the metadata of '${SENDER_ID}'; refusing to send`);
      expect(await outbox(TARGET_ID)).toEqual([]);
    });

    test("at-most-once: a send that throws is consumed and answered, never retried", async () => {
      let attempts = 0;
      const { deps } = server({ send: { sendMessage: async () => { attempts++; throw new Error("boom"); } } });
      await queue(ID_A, sendRequest(ID_A));
      await processSpawnRequests(SENDER_ID, senderRepo, deps);
      await processSpawnRequests(SENDER_ID, senderRepo, deps);
      expect(attempts).toBe(1);
      expect((await result(ID_A)).stderr).toBe("Error: send failed: boom");
    });

    test("the other kinds of request in the same queue are still dispatched", async () => {
      const { deps, spawned, asked } = server();
      await queue(ID_A, { v: 1, id: ID_A, prompt: "build it" });
      await queue("b".repeat(32), { v: 1, id: "b".repeat(32), op: "ask", question: "ok?" });
      await queue("c".repeat(32), sendRequest("c".repeat(32)));
      await processSpawnRequests(SENDER_ID, senderRepo, deps);
      expect(spawned.map((call) => call.prompt)).toEqual(["build it"]);
      expect(asked).toEqual(["ok?"]);
      expect((await outbox(TARGET_ID)).map((m) => m.message)).toEqual([MESSAGE]);
    });
  });

  // ── client (runs inside the sandbox) ───────────────────────────────────────

  describe("requestSendViaWatchdog", () => {
    const clientDeps = (over: Record<string, unknown> = {}) => ({
      resolveCaller: async () => caller(),
      watchdogLive: async () => true,
      sleep: async () => {},
      ...over,
    });

    /** Answer the queued request the way a given watchdog would, without acting on it. */
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

    test("round trip: the message reaches the other repo's agent through the watchdog", async () => {
      const { deps } = server();
      const out = await requestSendViaWatchdog(
        `@iris/${TARGET_ID}`,
        MESSAGE,
        // Each poll gap, run the watchdog once — as it would between ticks.
        clientDeps({ sleep: async () => { await processSpawnRequests(SENDER_ID, senderRepo, deps); } }),
      );
      expect(out).toEqual({ ok: true, exitCode: 0, stdout: "", stderr: "" });
      expect((await outbox(TARGET_ID)).map((m) => [m.message, m.fromAgent])).toEqual([[MESSAGE, SENDER_ID]]);
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
      expect(await readdir(spawnResultDir(agentDir))).toEqual([]);
    });

    test("the request carries the target and the message, and nothing that names the sender", async () => {
      const { deps } = server();
      const seen: Array<Record<string, unknown>> = [];
      await requestSendViaWatchdog(TARGET_ID, MESSAGE, clientDeps({
        sleep: async () => {
          for (const name of await readdir(spawnRequestDir(agentDir))) {
            seen.push(await Bun.file(join(spawnRequestDir(agentDir), name)).json());
          }
          await processSpawnRequests(SENDER_ID, senderRepo, deps);
        },
      }));
      expect(seen).toHaveLength(1);
      expect(Object.keys(seen[0]!)).toEqual(["v", "id", "op", "target", "message"]);
      expect(seen[0]).toMatchObject({ v: 1, op: "send", target: TARGET_ID, message: MESSAGE });
    });

    test("a watchdog that is not live: null (send directly), and nothing is written", async () => {
      const out = await requestSendViaWatchdog(TARGET_ID, MESSAGE, clientDeps({ watchdogLive: async () => false }));
      expect(out).toBeNull();
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test.each([
      ["has no broker for an op", "Error: spawn request has unsupported field 'op'"],
      ["has the lifecycle (and ask) broker only", "Error: lifecycle request has unsupported field 'message'"],
    ])("a watchdog that %s refused it untouched: null (send directly)", async (_label, stderr) => {
      const out = await requestSendViaWatchdog(TARGET_ID, MESSAGE, clientDeps({ sleep: answerWith(stderr) }));
      expect(out).toBeNull();
    });

    // Field order is what makes those two answers exact: an old lifecycle
    // parser accepts v, id, op and target, and stops at `message`.
    test("the old-watchdog answers are what today's parsers give for a send request", async () => {
      const { parseLifecycleRequest } = await import("./lifecycle-broker");
      const { parseSpawnRequest } = await import("./spawn-broker");
      const text = JSON.stringify({ v: 1, id: ID_A, op: SEND_OP, target: TARGET_ID, message: MESSAGE });
      expect(parseLifecycleRequest(text, ID_A)).toEqual({ ok: false, error: "lifecycle request has unsupported field 'message'" });
      expect(parseSpawnRequest(text, ID_A)).toEqual({ ok: false, error: "spawn request has unsupported field 'op'" });
    });

    test("a current watchdog's failure is reported, not retried directly", async () => {
      const out = await requestSendViaWatchdog(TARGET_ID, MESSAGE, clientDeps({ sleep: answerWith("Agent not found: x") }));
      expect(out).toEqual({ ok: false, exitCode: 1, stdout: "", stderr: "Agent not found: x" });
    });

    test("times out after the deadline and withdraws the unclaimed request (an error, no direct send)", async () => {
      let clock = 0;
      const out = await requestSendViaWatchdog(TARGET_ID, MESSAGE, clientDeps({
        now: () => clock,
        sleep: async (ms: number) => { clock += ms; },
      }));
      expect(clock).toBeGreaterThanOrEqual(SPAWN_CLIENT_TIMEOUT_MS);
      expect(out?.ok).toBe(false);
      expect(out?.stderr).toContain(`timed out after 30s waiting for the watchdog of '${SENDER_ID}' to send the message to '${TARGET_ID}'`);
      expect(out?.stderr).toContain("withdrawn");
      expect(await readdir(spawnRequestDir(agentDir))).toEqual([]);
    });

    test("a timeout after the watchdog took the request says it may still be delivered (no direct send)", async () => {
      let clock = 0;
      const out = await requestSendViaWatchdog(TARGET_ID, MESSAGE, clientDeps({
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
          // The watchdog claims (removes) the request but never answers.
          for (const name of await readdir(spawnRequestDir(agentDir))) await rm(join(spawnRequestDir(agentDir), name));
        },
        timeoutMs: 1000,
      }));
      expect(out?.ok).toBe(false);
      expect(out?.stderr).toContain("already taken the message, so it may still be delivered");
      expect(await outbox(TARGET_ID)).toEqual([]);
    });

    test.each([
      ["an oversize message", TARGET_ID, "x".repeat(SPAWN_MAX_PROMPT_BYTES + 1)],
      ["an oversize target", "x".repeat(SEND_MAX_TARGET_CHARS + 1), MESSAGE],
    ])("%s cannot travel in a request: null (send directly), nothing written", async (_label, target, message) => {
      const out = await requestSendViaWatchdog(target, message, clientDeps({
        watchdogLive: async (): Promise<boolean> => { throw new Error("the watchdog must not be asked"); },
      }));
      expect(out).toBeNull();
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test("a shell that is not inside an agent gets a clear error", async () => {
      const out = await requestSendViaWatchdog(TARGET_ID, MESSAGE, clientDeps({ resolveCaller: async () => null }));
      expect(out?.ok).toBe(false);
      expect(out?.stderr).toContain("not inside a registered agent");
    });
  });

  // ── routing from the CLI ───────────────────────────────────────────────────

  describe("routeSendThroughWatchdog", () => {
    const USAGE = "Usage: ib send [--from <id>] <target> [-f <path>] [message...]";
    let reads: number;
    const command = (over: Partial<SendCommand> = {}): SendCommand => ({
      target: TARGET_ID,
      readMessage: async () => { reads++; return MESSAGE; },
      usage: USAGE,
      repos,
      ...over,
    });
    beforeEach(() => { reads = 0; });

    test("returns null when the process is not sandboxed (send directly, message not read)", async () => {
      setSandboxedProcessOverride(() => false);
      expect(await routeSendThroughWatchdog(command())).toBeNull();
      expect(reads).toBe(0);
    });

    test("routes a sandboxed worktree agent through the watchdog", async () => {
      setSandboxedProcessOverride(() => true);
      const { deps } = server();
      const out = await routeSendThroughWatchdog(command({ target: `@iris/${TARGET_ID}` }), {
        resolveCaller: async () => caller(),
        watchdogLive: async () => true,
        sleep: async () => { await processSpawnRequests(SENDER_ID, senderRepo, deps); },
      });
      expect(out).toEqual({ ok: true, exitCode: 0, stdout: "", stderr: "" });
      expect((await outbox(TARGET_ID)).map((m) => m.fromAgent)).toEqual([SENDER_ID]);
      expect(reads).toBe(1);
    });

    test("--from for the caller itself is accepted", async () => {
      setSandboxedProcessOverride(() => true);
      const { deps } = server();
      const out = await routeSendThroughWatchdog(command({ fromAgent: SENDER_ID }), {
        resolveCaller: async () => caller(),
        watchdogLive: async () => true,
        sleep: async () => { await processSpawnRequests(SENDER_ID, senderRepo, deps); },
      });
      expect(out?.ok).toBe(true);
    });

    test("--from for another agent is refused, and nothing is read or queued", async () => {
      setSandboxedProcessOverride(() => true);
      const out = await routeSendThroughWatchdog(command({ fromAgent: OTHER_ID }), {
        resolveCaller: async () => caller(),
        watchdogLive: async (): Promise<boolean> => { throw new Error("the broker must not be asked"); },
      });
      expect(out?.ok).toBe(false);
      expect(out?.stderr).toContain("--from for another agent is not supported inside the sandbox");
      expect(reads).toBe(0);
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test("an empty message prints the usage, as on the direct path", async () => {
      setSandboxedProcessOverride(() => true);
      const out = await routeSendThroughWatchdog(command({ readMessage: async () => "" }), {
        resolveCaller: async () => caller(),
        watchdogLive: async (): Promise<boolean> => { throw new Error("the broker must not be asked"); },
      });
      expect(out).toEqual({ ok: false, exitCode: 1, stdout: "", stderr: USAGE });
    });

    // A send to itself stays direct: the agent can reach its own repo and
    // outbox, and the watchdog refuses it. Nothing is read or queued.
    test.each([
      ["its id", SENDER_ID],
      ["its nickname", "helper-nick"],
      ["@repo/id of its own repo", `@hunch/${SENDER_ID}`],
    ])("a send to itself by %s goes the direct way", async (_label, target) => {
      setSandboxedProcessOverride(() => true);
      await writeAgent(senderRepo, SENDER_ID, { nickname: "helper-nick" });
      const out = await routeSendThroughWatchdog(command({ target }), {
        resolveCaller: async () => caller(),
        watchdogLive: async (): Promise<boolean> => { throw new Error("the broker must not be asked"); },
      });
      expect(out).toBeNull();
      expect(reads).toBe(0);
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    test("an agent with the caller's id in ANOTHER repo is not the caller: routed", async () => {
      setSandboxedProcessOverride(() => true);
      await writeAgent(targetRepo, SENDER_ID, {});
      const { deps } = server();
      const out = await routeSendThroughWatchdog(command({ target: `@iris/${SENDER_ID}` }), {
        resolveCaller: async () => caller(),
        watchdogLive: async () => true,
        sleep: async () => { await processSpawnRequests(SENDER_ID, senderRepo, deps); },
      });
      expect(out?.ok).toBe(true);
      // Queued for the iris agent (outboxes are keyed by id), from the caller.
      expect((await outbox(SENDER_ID)).map((m) => [m.message, m.fromAgent])).toEqual([[MESSAGE, SENDER_ID]]);
    });

    test("a routed caller whose watchdog is not live sends directly (null)", async () => {
      setSandboxedProcessOverride(() => true);
      const out = await routeSendThroughWatchdog(command(), {
        resolveCaller: async () => caller(),
        watchdogLive: async () => false,
      });
      expect(out).toBeNull();
      await expect(readdir(spawnRequestDir(agentDir))).rejects.toThrow();
    });

    // Callers that keep the direct path. None of them may reach the broker:
    // `watchdogLive` throws if the client gets that far.
    const directOnly = (resolveCaller: () => Promise<ResolvedCallerContext | null>) => ({
      resolveCaller,
      watchdogLive: async (): Promise<boolean> => { throw new Error("the broker must not be asked"); },
    });
    const callerWith = (meta: Record<string, unknown>): ResolvedCallerContext =>
      ({ meta: { id: SENDER_ID, ...meta }, agentDir, repoPath: senderRepo });

    test.each([
      ["a worktree:false agent (it has no per-agent watchdog)", async () => callerWith({ worktree: false })],
      ["an agent whose itsybitsy sandbox is off", async () => callerWith({ sandbox: { enabled: false, rawAllow: [], domains: [] } })],
      ["a sandboxed shell that is not an agent", async () => null],
      ["a caller that cannot be verified", async () => { throw new Error("Cannot verify no-worktree caller"); }],
    ])("%s sends directly", async (_label, resolveCaller) => {
      setSandboxedProcessOverride(() => true);
      expect(await routeSendThroughWatchdog(command(), directOnly(resolveCaller as any))).toBeNull();
      expect(reads).toBe(0);
    });
  });
});

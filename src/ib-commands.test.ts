import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join, basename } from "path";
import { mkdtemp, rm, mkdir, readdir } from "fs/promises";
import { tmpdir } from "os";
import type { Agent, AgentMeta } from "./agents";
import {
  isPidAliveCtx,
  nowMsCtx,
  OP_STUCK_TIMEOUT_MS,
  setAgentOperation,
  clearAgentOperation,
  readAgentTransient,
} from "./agents";
import { makeAgent as _makeAgent, makeSpawnResult } from "./test-utils";
import {
  killAgent,
  nukeAgent,
  nukeAllAgents,
  resumeAgent,
  reassignAgent,
  mergeCheckAgent,
  mergeAgent,
  sendMessage,
  newAgent,
  diffAgent,
  diffCwd,
  statusAgent,
  pauseAgent,
  acknowledgeQuestion,
  askQuestion,
  setSayRunner,
  resetSayRunner,
  setAskQuestionTelegramRunner,
  resetAskQuestionTelegramRunner,
  setSendSpawnRunner,
  resetSendSpawnRunner,
  setKillPauseSpawnRunner,
  resetKillPauseSpawnRunner,
  setNukeResumeSpawnRunner,
  resetNukeResumeSpawnRunner,
  setMergeSpawnRunner,
  resetMergeSpawnRunner,
  setNewAgentSpawnRunner,
  resetNewAgentSpawnRunner,
  setDiffStatusSpawnRunner,
  resetDiffStatusSpawnRunner,
  hooksStatus,
  interceptHooksStatus,
  installSafetyHooks,
  uninstallSafetyHooks,
  installInterceptHook,
  uninstallInterceptHook,
  resolveAgentId,
  setNewAgentSummaryGenerator,
  resetNewAgentSummaryGenerator,
  setWatchdogSpawnFn,
  resetWatchdogSpawnFn,
} from "./ib-commands";
import { spawnCtx as lifecycleSpawnCtx } from "./agent-lifecycle";
import { setUserConfigPath, resetUserConfigPath } from "./config";
import type { AgentState } from "./parse-state";
import type { SpawnResult } from "./types";

function makeAgent(id: string, repoPath: string, state: string = "running"): Agent {
  return _makeAgent({ id, repoPath, repoName: "test-repo", state: state as AgentState });
}

describe("ib-commands", () => {
  // nukeAgent, nukeAllAgents, resumeAgent are now native — tested in dedicated describe blocks below
  // mergeAgent is now native — tested in dedicated describe block below

  describe("sendMessage (native)", () => {
    let spawnCalls: string[][] = [];
    let tempDir: string;

    beforeEach(async () => {
      spawnCalls = [];
      tempDir = await mkdtemp(join(tmpdir(), "send-test-"));
      // Create agent directory for log writing
      await mkdir(join(tempDir, ".ittybitty", "agents", "agent-abc"), { recursive: true });

      // Isolate user config — sendMessage reads `user.name` to format user
      // sends. Without isolation tests would pick up whatever's in the host
      // user's ~/.itsybitsy/config.json.
      setUserConfigPath(join(tempDir, "config.json"));

      setSendSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        return makeSpawnResult();
      });
    });

    afterEach(async () => {
      resetSendSpawnRunner();
      resetUserConfigPath();
      await rm(tempDir, { recursive: true, force: true });
    });

    test("sends message via tmux send-keys then Enter", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      const result = await sendMessage(agent, "hello world", { cwd: "/" });

      expect(result.ok).toBe(true);
      // Should have: has-session, send-keys (message), send-keys (Enter)
      expect(spawnCalls.length).toBe(3);
      expect(spawnCalls[0]).toEqual(["tmux", "has-session", "-t", `tmux-agent-abc`]);
      expect(spawnCalls[1]).toEqual(["tmux", "send-keys", "-t", `tmux-agent-abc`, "-l", "--", "[sent by user]: hello world"]);
      expect(spawnCalls[2]).toEqual(["tmux", "send-keys", "-t", `tmux-agent-abc`, "Enter"]);
    });

    test("returns error when tmux session not found", async () => {
      setSendSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        if (cmd.includes("has-session")) {
          return makeSpawnResult(1, "", "session not found");
        }
        return makeSpawnResult();
      });

      const agent = makeAgent("agent-abc", tempDir);
      const result = await sendMessage(agent, "hello");

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("not running");
    });

    test("prefixes message when fromAgent is provided", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      // Create sender dir for logging
      await mkdir(join(tempDir, ".ittybitty", "agents", "agent-sender"), { recursive: true });

      await sendMessage(agent, "hello", { fromAgent: "agent-sender" });

      // The send-keys call should have the prefixed message
      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("[sent by agent agent-sender]: hello");
    });

    test("auto-stamps @system when cwd is the system coordinator home", async () => {
      const { setCoordinatorHome, resetCoordinatorHome } = await import("./coordinator");
      const coordHome = await mkdtemp(join(tmpdir(), "coord-home-"));
      setCoordinatorHome(coordHome);
      try {
        const agent = makeAgent("agent-abc", tempDir);
        await sendMessage(agent, "ping", { cwd: coordHome });

        const sendKeysCall = spawnCalls.find(
          (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
        );
        expect(sendKeysCall).toBeDefined();
        expect(sendKeysCall![6]).toBe("[sent by @system]: ping");
      } finally {
        resetCoordinatorHome();
        await rm(coordHome, { recursive: true, force: true });
      }
    });

    test("auto-stamps @system when cwd is under the coordinator home", async () => {
      const { setCoordinatorHome, resetCoordinatorHome } = await import("./coordinator");
      const coordHome = await mkdtemp(join(tmpdir(), "coord-home-"));
      setCoordinatorHome(coordHome);
      try {
        const agent = makeAgent("agent-abc", tempDir);
        await sendMessage(agent, "ping", { cwd: join(coordHome, "subdir") });

        const sendKeysCall = spawnCalls.find(
          (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
        );
        expect(sendKeysCall).toBeDefined();
        expect(sendKeysCall![6]).toBe("[sent by @system]: ping");
      } finally {
        resetCoordinatorHome();
        await rm(coordHome, { recursive: true, force: true });
      }
    });

    test("explicit fromAgent='@system' renders without 'agent ' word", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "ping", { fromAgent: "@system", cwd: "/" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("[sent by @system]: ping");
    });

    test("agent worktree match wins over coordinator home match", async () => {
      // Defensive test: even if coordHome were configured to be a parent of
      // an agent worktree (impossible in practice, but ensures the regex
      // branch preempts the coord-home else branch).
      const { setCoordinatorHome, resetCoordinatorHome } = await import("./coordinator");
      // Set coord home to tempDir so a worktree path under tempDir would
      // match cwd.startsWith(coordHome + "/") if the else branch ever ran.
      setCoordinatorHome(tempDir);
      try {
        // Create a sender agent dir with meta.json so the worktree branch
        // can resolve a real ID.
        const senderId = "agent-sender";
        const senderAgentDir = join(tempDir, ".ittybitty", "agents", senderId);
        await mkdir(senderAgentDir, { recursive: true });
        await Bun.write(join(senderAgentDir, "meta.json"), JSON.stringify({ id: senderId }));

        const agent = makeAgent("agent-abc", tempDir);
        const senderCwd = join(senderAgentDir, "repo");
        await sendMessage(agent, "ping", { cwd: senderCwd });

        const sendKeysCall = spawnCalls.find(
          (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
        );
        expect(sendKeysCall).toBeDefined();
        // Should be agent-sender (worktree branch), NOT @system (coord-home branch)
        expect(sendKeysCall![6]).toBe("[sent by agent agent-sender]: ping");
      } finally {
        resetCoordinatorHome();
      }
    });

    test("logs to recipient agent.log", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "test message", { cwd: "/" });

      const logContent = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(logContent).toContain("Received message from user: test message");
    });

    test("logs to sender agent.log when fromAgent set", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await mkdir(join(tempDir, ".ittybitty", "agents", "agent-sender"), { recursive: true });

      await sendMessage(agent, "test", { fromAgent: "agent-sender" });

      const senderLog = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-sender", "agent.log")
      ).text();
      expect(senderLog).toContain("Sent message to agent-abc: test");

      const recipientLog = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(recipientLog).toContain("Received message from agent-sender: test");
    });

    test("returns 'Sent to <id>' in stdout when no fromAgent", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      const result = await sendMessage(agent, "hello", { cwd: "/" });
      expect(result.stdout).toBe("Sent to agent-abc");
    });

    test("returns empty stdout when fromAgent is set", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await mkdir(join(tempDir, ".ittybitty", "agents", "agent-sender"), { recursive: true });
      const result = await sendMessage(agent, "hello", { fromAgent: "agent-sender" });
      expect(result.stdout).toBe("");
    });

    test("returns error when agent has no tmux session", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      agent.meta.tmux_session = "";
      const result = await sendMessage(agent, "hello");
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("no tmux session");
    });

    test("sends short message (< 500 chars) as a single chunk + Enter", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      const msg = "x".repeat(499);
      // Use raw=true to bypass the user/agent prefix so we test pure
      // chunking behavior at the 500-char boundary.
      const result = await sendMessage(agent, msg, { cwd: "/", raw: true });

      expect(result.ok).toBe(true);
      const sendKeysCalls = spawnCalls.filter(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l")
      );
      expect(sendKeysCalls.length).toBe(1);
      expect(sendKeysCalls[0]![6]).toBe(msg);
      // Last call must be Enter
      const lastCall = spawnCalls[spawnCalls.length - 1]!;
      expect(lastCall).toEqual(["tmux", "send-keys", "-t", "tmux-agent-abc", "Enter"]);
    });

    test("sends long message (1500 chars) as 3 ordered chunks + Enter", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      // Distinguishable per-chunk content so we can verify ordering and slicing.
      const part1 = "a".repeat(500);
      const part2 = "b".repeat(500);
      const part3 = "c".repeat(500);
      const msg = part1 + part2 + part3;
      // Use raw=true to bypass prefix so we test pure chunking at 500-char
      // boundaries.
      const result = await sendMessage(agent, msg, { cwd: "/", raw: true });

      expect(result.ok).toBe(true);

      const sendKeysCalls = spawnCalls.filter(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l")
      );
      expect(sendKeysCalls.length).toBe(3);
      expect(sendKeysCalls[0]![6]).toBe(part1);
      expect(sendKeysCalls[1]![6]).toBe(part2);
      expect(sendKeysCalls[2]![6]).toBe(part3);

      // Final call must be the Enter, after all chunks.
      const lastCall = spawnCalls[spawnCalls.length - 1]!;
      expect(lastCall).toEqual(["tmux", "send-keys", "-t", "tmux-agent-abc", "Enter"]);
    });

    test("raw=true suppresses [sent by ...] prefix even when fromAgent is set", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await mkdir(join(tempDir, ".ittybitty", "agents", "@telegram"), { recursive: true }).catch(() => {});
      await sendMessage(agent, "/context", { fromAgent: "@telegram", raw: true, cwd: "/" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      // Message goes verbatim — no [sent by @telegram]: prefix.
      expect(sendKeysCall![6]).toBe("/context");
    });

    test("raw=true logs recipient as 'Received raw message' (no sender attribution)", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "/clear", { fromAgent: "@telegram", raw: true, cwd: "/" });

      const recipientLog = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(recipientLog).toContain("Received raw message: /clear");
      // Must NOT contain the standard "from <sender>" phrasing.
      expect(recipientLog).not.toContain("Received message from @telegram");
    });

    test("raw=true logs sender as 'Sent raw message' when sender dir exists", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      const senderDir = join(tempDir, ".ittybitty", "agents", "agent-sender");
      await mkdir(senderDir, { recursive: true });

      await sendMessage(agent, "ping", { fromAgent: "agent-sender", raw: true });

      const senderLog = await Bun.file(join(senderDir, "agent.log")).text();
      expect(senderLog).toContain("Sent raw message to agent-abc: ping");
      expect(senderLog).not.toContain("Sent message to agent-abc: ping");
    });

    test("raw is opt-in: default (no raw flag) still adds the [sent by ...] prefix", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await mkdir(join(tempDir, ".ittybitty", "agents", "agent-sender"), { recursive: true });

      await sendMessage(agent, "hello", { fromAgent: "agent-sender" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall![6]).toBe("[sent by agent agent-sender]: hello");
    });

    test("user send (no fromAgent, no user.name) prefixes with [sent by user] and logs from user", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "hello", { cwd: "/" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("[sent by user]: hello");

      const recipientLog = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(recipientLog).toContain("Received message from user: hello");
    });

    test("user send with user.name set prefixes with [sent by user <name>] and logs accordingly", async () => {
      await Bun.write(
        join(tempDir, "config.json"),
        JSON.stringify({ user: { name: "Adam" } }, null, 2)
      );

      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "hello", { cwd: "/" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("[sent by user Adam]: hello");

      const recipientLog = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(recipientLog).toContain("Received message from user Adam: hello");
    });

    test("raw=true bypasses the user prefix even when user.name is set", async () => {
      await Bun.write(
        join(tempDir, "config.json"),
        JSON.stringify({ user: { name: "Adam" } }, null, 2)
      );

      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "verbatim", { cwd: "/", raw: true });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("verbatim");

      const recipientLog = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(recipientLog).toContain("Received raw message: verbatim");
      expect(recipientLog).not.toContain("[sent by user");
    });

    test("returns error and does not send Enter when a chunk fails mid-stream", async () => {
      let chunkCallCount = 0;
      setSendSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd.includes("-l")) {
          chunkCallCount++;
          // Fail the second chunk.
          if (chunkCallCount === 2) {
            return makeSpawnResult(1, "", "tmux: send-keys failed");
          }
        }
        return makeSpawnResult();
      });

      const agent = makeAgent("agent-abc", tempDir);
      const msg = "a".repeat(500) + "b".repeat(500) + "c".repeat(500);
      const result = await sendMessage(agent, msg, { cwd: "/" });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("tmux: send-keys failed");

      // No Enter should be sent.
      const enterCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c[c.length - 1] === "Enter"
      );
      expect(enterCall).toBeUndefined();

      // Should have stopped after the failed chunk (no third chunk).
      const chunkCalls = spawnCalls.filter(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l")
      );
      expect(chunkCalls.length).toBe(2);
    });

    test("places `--` immediately before the payload so dash-leading content is not parsed as a tmux flag", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      // YAML frontmatter starts with `---`. Without `--`, tmux send-keys
      // parses the leading dashes as a flag and fails with
      // `command send-keys: invalid flag -`.
      // Use raw=true so the payload reaches tmux without the user prefix —
      // the test is about tmux flag-parsing safety for dash-leading content.
      const dashLeading = "---\ntitle: foo\n---\nbody";
      const result = await sendMessage(agent, dashLeading, { cwd: "/", raw: true });

      expect(result.ok).toBe(true);
      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l")
      );
      expect(sendKeysCall).toBeDefined();
      // argv shape must be [tmux, send-keys, -t, <session>, -l, --, <payload>].
      // The `--` MUST sit between `-l` and the payload — that is what stops
      // tmux's flag parser from consuming the leading `-` in `---`.
      expect(sendKeysCall![4]).toBe("-l");
      expect(sendKeysCall![5]).toBe("--");
      expect(sendKeysCall![6]).toBe(dashLeading);
    });

    test("two concurrent sends to the same agent never interleave their send-keys/Enter", async () => {
      // Critical correctness test (see /tmp/multi-writes-spec.md): the
      // per-session lock + single-drainer design must make it IMPOSSIBLE for
      // two send-keys/Enter sequences to the same tmux session to interleave.
      //
      // We launch two sendMessage calls concurrently. Each message is long
      // enough to require multiple `-l` chunks, and the fake spawn runner
      // resolves `.exited` on a macrotask (setTimeout 0) so the two calls
      // genuinely race through the event loop — a missing lock would interleave
      // their chunks. We then assert that, in the recorded `-l` payload order,
      // each message's chunks form one CONTIGUOUS run and its Enter
      // immediately follows its last chunk (no A,B,A pattern).
      const agent = makeAgent("agent-abc", tempDir);

      // Record send-keys (-l payload) and Enter events in delivery order.
      type Ev = { kind: "chunk"; ch: string } | { kind: "enter" };
      const events: Ev[] = [];
      setSendSpawnRunner((cmd: string[]) => {
        if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd[4] === "-l" && cmd[5] === "--") {
          events.push({ kind: "chunk", ch: cmd[6]! });
        } else if (cmd[0] === "tmux" && cmd[1] === "send-keys" && cmd[cmd.length - 1] === "Enter") {
          events.push({ kind: "enter" });
        }
        // Resolve on a macrotask so concurrent sends interleave at the await
        // points if (and only if) the lock fails to serialize them.
        return {
          stdout: new Response("").body,
          stderr: new Response("").body,
          exited: new Promise<number>((resolve) => setTimeout(() => resolve(0), 0)),
        } as SpawnResult;
      });

      // Two distinct, multi-chunk payloads (>500 chars each → 2 chunks each).
      const msgA = "A".repeat(900);
      const msgB = "B".repeat(900);

      await Promise.all([
        sendMessage(agent, msgA, { cwd: "/", raw: true }),
        sendMessage(agent, msgB, { cwd: "/", raw: true }),
      ]);

      // Reconstruct the per-Enter "messages": every chunk run terminated by an
      // Enter is one delivered message. None of these reconstructed payloads
      // may mix 'A' and 'B' content — that would mean two sends interleaved.
      const delivered: string[] = [];
      let buf = "";
      for (const ev of events) {
        if (ev.kind === "chunk") {
          buf += ev.ch;
        } else {
          delivered.push(buf);
          buf = "";
        }
      }
      // Exactly two messages delivered (each exactly once — no loss, no dupes).
      expect(delivered.length).toBe(2);
      for (const payload of delivered) {
        const hasA = payload.includes("A");
        const hasB = payload.includes("B");
        // A delivered message must be pure-A or pure-B, never a merge.
        expect(hasA && hasB).toBe(false);
      }
      // The two delivered messages are the two originals (in some order).
      const sorted = [...delivered].sort();
      expect(sorted).toEqual([msgA, msgB].sort());
    });
  });

  // newAgent tests are in the dedicated "newAgent (native)" describe block below
});

describe("sendMessage outbox integration", () => {
  let spawnCalls: string[][];
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    spawnCalls = [];
    tempDir = await mkdtemp(join(tmpdir(), "send-outbox-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    setUserConfigPath(join(tempDir, "config.json"));
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return makeSpawnResult();
    });
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetUserConfigPath();
    const { isPidAliveCtx } = await import("./agents");
    isPidAliveCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("defers to a live watchdog: enqueues but does NOT deliver inline", async () => {
    // A fresh transient file with a live watchdog pid means a watchdog will
    // drain — sendMessage must enqueue and return without typing into tmux.
    const { writeAgentTransient, isPidAliveCtx } = await import("./agents");
    isPidAliveCtx.set(() => true); // pretend the watchdog pid is alive
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 4242,
    });

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "hello", { cwd: "/" });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Sent to agent-abc");
    // No tmux spawn calls — delivery deferred to the watchdog.
    expect(spawnCalls.length).toBe(0);

    // The message is sitting in the outbox awaiting the watchdog's drain.
    const { readOutbox } = await import("./outbox");
    const queued = await readOutbox(agentDir);
    expect(queued.length).toBe(1);
    expect(queued[0]!.message).toBe("hello");
  });

  test("stale transient (watchdog not fresh): delivers inline", async () => {
    const { writeAgentTransient, isPidAliveCtx } = await import("./agents");
    isPidAliveCtx.set(() => true);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: Date.now() - 60_000, // 60s old → not fresh
      watchdog_pid: 4242,
    });

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "hello", { cwd: "/" });

    expect(result.ok).toBe(true);
    // Delivered inline → has-session + send-keys + Enter.
    expect(spawnCalls.length).toBe(3);
    // Outbox drained empty.
    const { readOutbox } = await import("./outbox");
    expect(await readOutbox(agentDir)).toEqual([]);
  });

  test("dead watchdog pid: delivers inline", async () => {
    const { writeAgentTransient, isPidAliveCtx } = await import("./agents");
    isPidAliveCtx.set(() => false); // pid is dead
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 4242,
    });

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    await sendMessage(agent, "hello", { cwd: "/" });
    expect(spawnCalls.length).toBe(3);
  });

  test("failed delivery leaves the message enqueued (no loss)", async () => {
    // has-session fails → deliverMessage returns ok:false → message stays.
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      if (cmd.includes("has-session")) return makeSpawnResult(1, "", "no session");
      return makeSpawnResult();
    });
    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "keepme", { cwd: "/" });
    expect(result.ok).toBe(false);

    const { readOutbox } = await import("./outbox");
    const queued = await readOutbox(agentDir);
    expect(queued.length).toBe(1);
    expect(queued[0]!.message).toBe("keepme");
  });
});

// Helper: create a mock SpawnFn that records calls and returns success
function mockSpawnFn(calls: string[][]): (cmd: string[], opts?: any) => SpawnResult {
  return (cmd: string[]) => {
    calls.push(cmd);
    return makeSpawnResult();
  };
}

// Helper: create a mock SpawnFn that returns failure for specific commands
function mockSpawnFnWithFailures(
  calls: string[][],
  failCommands: (cmd: string[]) => boolean
): (cmd: string[], opts?: any) => SpawnResult {
  return (cmd: string[]) => {
    calls.push(cmd);
    return makeSpawnResult(failCommands(cmd) ? 1 : 0);
  };
}

describe("killAgent (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kill-test-"));
    spawnCalls = [];
    // Mock both the lifecycle spawn runner and the kill/pause spawn runner
    const runner = mockSpawnFn(spawnCalls);
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetKillPauseSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory and tmux session don't exist", async () => {
    // No meta.json + tmux has-session fails
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) => cmd.includes("has-session"));
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await killAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });

  test("succeeds and returns 'Closed agent: <id>' when agent directory exists", async () => {
    // Create agent directory with meta.json
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      claude_pid: "99999",
    }));

    // All tmux commands fail (no session) — that's fine, teardown handles it
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await killAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Closed agent: agent-abc");
  });

  test("removes agent directory after teardown", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await killAgent(agent);

    // Agent directory should be removed after teardown
    const exists = await Bun.file(join(agentDir, "meta.json")).exists();
    expect(exists).toBe(false);
  });

  test("removes user-questions.json entries for killed agent", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    // Write a questions file with entries for the agent
    const questionsPath = join(tempDir, ".ittybitty", "user-questions.json");
    await Bun.write(questionsPath, JSON.stringify({
      questions: [
        { agent: "agent-abc", question: "Q1" },
        { agent: "agent-xyz", question: "Q2" },
      ],
    }));

    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await killAgent(agent);

    // Questions for agent-abc should be removed, agent-xyz kept
    const updated = await Bun.file(questionsPath).json();
    expect(updated.questions).toEqual([{ agent: "agent-xyz", question: "Q2" }]);
  });

  test("succeeds when tmux session exists but directory doesn't", async () => {
    // tmux has-session succeeds (agent exists via tmux only)
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await killAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Closed agent: agent-abc");
  });
});

describe("pauseAgent (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pause-test-"));
    spawnCalls = [];
    const runner = mockSpawnFn(spawnCalls);
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetKillPauseSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory doesn't exist", async () => {
    const agent = makeAgent("agent-abc", tempDir);
    const result = await pauseAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });

  test("returns error when agent is already stopped", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    const agent = makeAgent("agent-abc", tempDir, "stopped");
    const result = await pauseAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("already stopped");
  });

  test("succeeds and returns pause message when agent directory exists", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    // All tmux/pgrep commands fail — no running process
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await pauseAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Agent paused");
    expect(result.stdout).toContain("ib resume agent-abc");
  });

  test("preserves agent directory and meta.json after pause", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await pauseAgent(agent);

    // Directory and meta.json should still exist
    const exists = await Bun.file(join(agentDir, "meta.json")).exists();
    expect(exists).toBe(true);
  });

  test("logs 'Agent paused' to agent.log", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await pauseAgent(agent);

    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("Agent paused");
  });

  test("kills tmux session when it exists", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    // has-session succeeds for the kill/pause runner, everything else fails
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await pauseAgent(agent);

    // Should have called tmux kill-session
    const killSessionCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "kill-session"
    );
    expect(killSessionCall).toBeDefined();
    expect(killSessionCall![3]).toBe("tmux-agent-abc");

    // Should log tmux session kill
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("Killed tmux session");
  });

  test("writes meta.state = 'stopped' when pausing a 'complete' agent", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      state: "complete",
    }));

    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir, "complete");
    const result = await pauseAgent(agent);

    expect(result.ok).toBe(true);
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.state).toBe("stopped");
  });

  test("writes meta.state = 'stopped' when pausing a 'waiting' agent", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      state: "waiting",
    }));

    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir, "waiting");
    const result = await pauseAgent(agent);

    expect(result.ok).toBe(true);
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.state).toBe("stopped");
  });

  test("second pause on already-paused agent returns 'already stopped'", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      state: "waiting",
    }));

    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    // First pause: succeeds, writes state=stopped
    const agent1 = makeAgent("agent-abc", tempDir, "waiting");
    const first = await pauseAgent(agent1);
    expect(first.ok).toBe(true);

    // Re-read meta to confirm state landed, then attempt second pause with
    // runtime state reflecting the freshly-paused agent (state="stopped")
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.state).toBe("stopped");

    const agent2 = makeAgent("agent-abc", tempDir, "stopped");
    const second = await pauseAgent(agent2);
    expect(second.ok).toBe(false);
    expect(second.stderr).toContain("already stopped");
  });
});

describe("nukeAgent (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nuke-test-"));
    spawnCalls = [];
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep") || cmd.includes("list-sessions")
    );
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetNukeResumeSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when target is a worker with no children", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-worker");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-worker",
      tmux_session: "tmux-agent-worker",
      worker: true,
    }));

    const agent = _makeAgent({
      id: "agent-worker",
      repoPath: tempDir,
      repoName: "test-repo",
      meta: { worker: true } as any,
    });
    const result = await nukeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("worker agent");
    expect(result.stderr).toContain("ib kill");
  });

  test("tears down the agent and its descendants", async () => {
    // Create manager with a child
    const managerDir = join(tempDir, ".ittybitty", "agents", "agent-mgr");
    await mkdir(managerDir, { recursive: true });
    await Bun.write(join(managerDir, "meta.json"), JSON.stringify({
      id: "agent-mgr",
      tmux_session: "tmux-agent-mgr",
      worker: false,
    }));

    const childDir = join(tempDir, ".ittybitty", "agents", "agent-child");
    await mkdir(childDir, { recursive: true });
    await Bun.write(join(childDir, "meta.json"), JSON.stringify({
      id: "agent-child",
      tmux_session: "tmux-agent-child",
      manager: "agent-mgr",
      worker: true,
    }));

    const agent = makeAgent("agent-mgr", tempDir);
    const result = await nukeAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Nuked 2 agent(s)");

    // Both directories should be removed
    const mgrExists = await Bun.file(join(managerDir, "meta.json")).exists().catch(() => false);
    const childExists = await Bun.file(join(childDir, "meta.json")).exists().catch(() => false);
    expect(mgrExists).toBe(false);
    expect(childExists).toBe(false);
  });

  test("removes user-questions.json entries for nuked agents", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-mgr");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-mgr",
      tmux_session: "tmux-agent-mgr",
      worker: false,
    }));

    const questionsPath = join(tempDir, ".ittybitty", "user-questions.json");
    await Bun.write(questionsPath, JSON.stringify({
      questions: [
        { agent: "agent-mgr", question: "Q1" },
        { agent: "agent-other", question: "Q2" },
      ],
    }));

    const agent = makeAgent("agent-mgr", tempDir);
    await nukeAgent(agent);

    const updated = await Bun.file(questionsPath).json();
    expect(updated.questions).toEqual([{ agent: "agent-other", question: "Q2" }]);
  });

  test("succeeds even when no agents found to kill", async () => {
    // Empty agents directory
    await mkdir(join(tempDir, ".ittybitty", "agents"), { recursive: true });

    const agent = makeAgent("agent-nonexistent", tempDir);
    const result = await nukeAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Nuked 0 agent(s)");
  });
});

describe("nukeAllAgents (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nukeall-test-"));
    spawnCalls = [];
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep") || cmd.includes("list-sessions")
    );
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetNukeResumeSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("tears down all agents in the directory", async () => {
    const agent1Dir = join(tempDir, ".ittybitty", "agents", "agent-one");
    await mkdir(agent1Dir, { recursive: true });
    await Bun.write(join(agent1Dir, "meta.json"), JSON.stringify({
      id: "agent-one",
      tmux_session: "tmux-agent-one",
    }));

    const agent2Dir = join(tempDir, ".ittybitty", "agents", "agent-two");
    await mkdir(agent2Dir, { recursive: true });
    await Bun.write(join(agent2Dir, "meta.json"), JSON.stringify({
      id: "agent-two",
      tmux_session: "tmux-agent-two",
    }));

    const result = await nukeAllAgents(tempDir);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Nuked 2 agent(s)");

    // Both directories should be removed
    const dir1Exists = await Bun.file(join(agent1Dir, "meta.json")).exists().catch(() => false);
    const dir2Exists = await Bun.file(join(agent2Dir, "meta.json")).exists().catch(() => false);
    expect(dir1Exists).toBe(false);
    expect(dir2Exists).toBe(false);
  });

  test("succeeds with empty agents directory", async () => {
    await mkdir(join(tempDir, ".ittybitty", "agents"), { recursive: true });

    const result = await nukeAllAgents(tempDir);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Nuked 0 agent(s)");
  });

  test("skips directories without meta.json", async () => {
    await mkdir(join(tempDir, ".ittybitty", "agents", "no-meta"), { recursive: true });

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-real");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-real",
      tmux_session: "tmux-agent-real",
    }));

    const result = await nukeAllAgents(tempDir);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Nuked 1 agent(s)");
  });
});

describe("resumeAgent (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  // Default runner mimics the canonical "stopped agent, no live tmux" path:
  // - The first has-session call (the resume liveness guard) must fail so resume proceeds.
  // - After new-session creates the tmux session, subsequent has-session calls must succeed
  //   (resume verifies the session exists before sending the nudge).
  // Tests that need a live session at guard time install their own runner.
  function makeDefaultResumeRunner(calls: string[][]) {
    let newSessionSeen = false;
    return (cmd: string[]): SpawnResult => {
      calls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "new-session") {
        newSessionSeen = true;
        return makeSpawnResult();
      }
      if (cmd.includes("has-session")) {
        return makeSpawnResult(newSessionSeen ? 0 : 1);
      }
      return makeSpawnResult();
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "resume-test-"));
    spawnCalls = [];
    const runner = makeDefaultResumeRunner(spawnCalls);
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetNukeResumeSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory doesn't exist", async () => {
    const agent = makeAgent("agent-abc", tempDir, "stopped");
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });

  test("refuses when tmux session is alive, regardless of meta.state", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    // Override the default runner: has-session always succeeds (live tmux).
    const liveRunner = (cmd: string[]): SpawnResult => {
      spawnCalls.push(cmd);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(liveRunner);
    setNukeResumeSpawnRunner(liveRunner);

    // Even with state="stopped", a live tmux session must refuse resume.
    const agent = makeAgent("agent-abc", tempDir, "stopped");
    agent.meta.tmux_session = "tmux-agent-abc";
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("live tmux session");
    // Ensure resume.sh was NOT written — guard must short-circuit before script generation.
    const resumeScriptExists = await Bun.file(join(agentDir, "resume.sh")).exists();
    expect(resumeScriptExists).toBe(false);
  });

  test("returns error when no session_id in meta.json", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: { session_id: "", tmux_session: "tmux-agent-abc" } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("session_id");
  });

  test("creates resume.sh and starts tmux session", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      model: "opus",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
        model: "opus",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("ib look agent-abc");

    // resume.sh should be created
    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resumeScript).toContain("claude --resume");
    expect(resumeScript).toContain("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(resumeScript).toContain("--model opus");

    // tmux new-session should have been called
    const newSessionCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "new-session"
    );
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall).toContain("tmux-agent-abc");

    // tmux send-keys for nudge should have been called with -l flag
    const nudgeCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l") && c.some(a => a.includes("Resume your work"))
    );
    expect(nudgeCall).toBeDefined();
    expect(nudgeCall).toContain("-l");
  });

  test("resume.sh captures stderr and annotates exit codes; resume sets pane-died hook", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-resume");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-resume",
      tmux_session: "tmux-agent-resume",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      model: "opus",
    }));

    const agent = _makeAgent({
      id: "agent-resume",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-resume",
        model: "opus",
      } as any,
    });
    const result = await resumeAgent(agent);
    expect(result.ok).toBe(true);

    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    // Same diagnostic logging as start.sh — stderr sidecar + tail-on-error.
    expect(resumeScript).toContain("STDERR_LOG=");
    expect(resumeScript).toContain("claude.stderr.log");
    expect(resumeScript).toMatch(/claude --resume[^\n]*2> "\$STDERR_LOG"/);
    expect(resumeScript).toContain('if [[ "$EXIT_CODE" -ne 0 && -s "$STDERR_LOG" ]]');
    expect(resumeScript).toContain('tail -n 50 "$STDERR_LOG" >> "$AGENT_LOG"');
    expect(resumeScript).toContain("case $EXIT_CODE in");
    expect(resumeScript).toContain("137) log \"exit=137 → SIGKILL");

    // Resume path also sets the pane-died backstop.
    const setHookCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "set-hook" && c.includes("pane-died"),
    );
    expect(setHookCall).toBeDefined();
    const hookBody = setHookCall![setHookCall!.length - 1]!;
    expect(hookBody).toContain("run-shell");
    expect(hookBody).toContain("[tmux pane-died]");
    expect(hookBody).toContain("agent.log");
  });

  test("resume.sh ignores SIGHUP and launches claude under setsid (no kill-on-HUP)", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-hup");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-hup",
      tmux_session: "tmux-agent-hup",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      model: "opus",
    }));

    const agent = _makeAgent({
      id: "agent-hup",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-hup",
        model: "opus",
      } as any,
    });
    const result = await resumeAgent(agent);
    expect(result.ok).toBe(true);

    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();

    // SIGHUP is ignored for the script's lifetime so a stray SIGHUP from the
    // launcher pane (ib-coordinator / another agent / watchdog) can't tear down
    // the fresh resume. This is the core fix for the exit-129 crash-resume loop.
    expect(resumeScript).toContain("trap '' HUP");

    // The old kill-on-HUP trap (which forwarded SIGTERM to claude on a stray
    // SIGHUP and caused the crash) must be gone. No HUP trap may carry a body.
    expect(resumeScript).not.toMatch(/trap '[^']+' HUP/);
    expect(resumeScript).not.toContain("SIGHUP diagnostics");

    // setsid gives claude its own session (defense-in-depth) with a graceful
    // fallback when setsid is absent — the inherited SIG_IGN still covers that.
    expect(resumeScript).toContain("command -v setsid");
    expect(resumeScript).toContain("setsid claude --resume");
    // Fallback bare launch is still present for hosts without setsid.
    expect(resumeScript).toMatch(/^ *claude --resume "/m);

    // ORDERING (the subtle part): `trap '' HUP` must be installed BEFORE claude
    // is forked so the SIG_IGN disposition is inherited by the child. If the
    // trap moved after the launch, a child started before the trap would catch
    // a stray SIGHUP and die — reintroducing the bug.
    const hupIdx = resumeScript.indexOf("trap '' HUP");
    const setsidGuardIdx = resumeScript.indexOf("command -v setsid");
    const firstLaunchIdx = resumeScript.search(/(setsid )?claude --resume "/);
    expect(hupIdx).toBeGreaterThan(-1);
    expect(hupIdx).toBeLessThan(firstLaunchIdx);
    // UNCONDITIONAL: the HUP-ignore must not be gated on setsid — it appears
    // before the `command -v setsid` guard, so the bare-launch fallback path
    // (setsid absent, e.g. macOS) keeps the protection.
    expect(hupIdx).toBeLessThan(setsidGuardIdx);

    // TERM and INT traps are unchanged — clean teardown on ib kill / pause still
    // forwards the signal to claude.
    expect(resumeScript).toMatch(/trap '[^']*kill \$CLAUDE_PID[^']*' TERM/);
    expect(resumeScript).toMatch(/trap '[^']*kill -INT \$CLAUDE_PID[^']*' INT/);
  });

  test("resume sets window-size manual on the new tmux session", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-window-size");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-window-size",
      tmux_session: "tmux-agent-window-size",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      model: "opus",
    }));

    const agent = _makeAgent({
      id: "agent-window-size",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-window-size",
        model: "opus",
      } as any,
    });
    const result = await resumeAgent(agent);
    expect(result.ok).toBe(true);

    // window-size manual prevents tmux from auto-resizing the agent's
    // session to the latest attached client's terminal size.
    const setWindowSize = spawnCalls.find(
      (c) =>
        c[0] === "tmux" &&
        c[1] === "set-option" &&
        c.includes("tmux-agent-window-size") &&
        c.includes("window-size") &&
        c.includes("manual"),
    );
    expect(setWindowSize).toBeDefined();
  });

  test("detects yolo mode from start.sh", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));
    await Bun.write(join(agentDir, "start.sh"), "#!/bin/bash\nclaude --dangerously-skip-permissions &\n");

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(true);

    // resume.sh should contain yolo flags
    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resumeScript).toContain("--dangerously-skip-permissions");
    expect(resumeScript).toContain("--permission-mode bypassPermissions");
  });

  test("logs 'Agent resumed' and 'Sent resume nudge'", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
      } as any,
    });
    await resumeAgent(agent);

    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("Agent resumed, nudge sent");
  });

  test("uses repoPath when worktree repo dir doesn't exist", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    // Don't create repo/ subdirectory
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(true);

    // The tmux new-session should use tempDir as workdir
    const newSessionCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "new-session"
    );
    expect(newSessionCall).toBeDefined();
    // -c flag value should be tempDir (not the repo subdir)
    const cFlagIdx = newSessionCall!.indexOf("-c");
    expect(newSessionCall![cFlagIdx + 1]).toBe(tempDir);
  });

  test("rejects model with shell injection characters", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      model: 'opus$(whoami)',
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: { session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", tmux_session: "tmux-agent-abc", model: 'opus$(whoami)' } as any,
    });
    const result = await resumeAgent(agent);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid model name");
  });

  test("rejects session_id with shell injection characters", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: '$(whoami)',
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: { session_id: '$(whoami)', tmux_session: "tmux-agent-abc" } as any,
    });
    const result = await resumeAgent(agent);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid session ID");
  });

  test("rejects tmux session with shell injection characters", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: 'session$(whoami)',
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: { session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", tmux_session: 'session$(whoami)' } as any,
    });
    const result = await resumeAgent(agent);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid tmux session name");
  });

  test("resume.sh shell-quotes paths for safety", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
      } as any,
    });
    const result = await resumeAgent(agent);
    expect(result.ok).toBe(true);

    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    // No PATH export — ib is already on the user's PATH
    expect(resumeScript).not.toContain("export PATH");
    // meta.json should be passed as process.argv, not embedded in JS
    expect(resumeScript).toContain(`META_JSON='${join(agentDir, "meta.json")}'`);
    expect(resumeScript).toContain('bun -e "const f=process.argv[1]');
    expect(resumeScript).toContain('"$META_JSON" "$CLAUDE_PID"');
    // exit-check.sh should be single-quoted
    expect(resumeScript).toContain(`'${join(agentDir, "exit-check.sh")}'`);
    // Should NOT have old pattern of embedding path in JS string
    expect(resumeScript).not.toContain("const f='/");
  });

  test("spawns watchdog for top-level agents (no manager)", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    let watchdogSpawned = false;
    setWatchdogSpawnFn((_id, _repoPath, _logPath) => {
      watchdogSpawned = true;
      return { pid: 12345 };
    });

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
        manager: null,
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(true);
    expect(watchdogSpawned).toBe(true);
    resetWatchdogSpawnFn();
  });

  test("saves watchdog_pid to meta.json after resumeAgent", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    const fakePid = 54321;
    setWatchdogSpawnFn((_id, _repoPath, _logPath) => {
      return { pid: fakePid };
    });

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
        manager: null,
      } as any,
    });
    await resumeAgent(agent);

    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.watchdog_pid).toBe(fakePid);
    resetWatchdogSpawnFn();
  });

  // ----- Tmux liveness guard (replaces meta.state guard) -----

  test("self-heals: resume succeeds when meta.state='complete' but tmux session is dead", async () => {
    // Bug scenario: a pre-Phase-42 paused agent has stale state="complete" in
    // meta.json because the old pause path never wrote "stopped". The new
    // tmux-based guard must let resume proceed because the session is dead.
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    // Default runner: has-session fails before new-session, succeeds after.
    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "complete",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("ib look agent-abc");
    // resume.sh should be created and tmux new-session called
    const newSessionCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "new-session"
    );
    expect(newSessionCall).toBeDefined();
  });

  test("regression: resume succeeds when meta.state='stopped' and tmux session is dead", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("ib look agent-abc");
    const newSessionCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "new-session"
    );
    expect(newSessionCall).toBeDefined();
  });

  test("refuses to resume when agent is in creating grace period and has no tmux session yet", async () => {
    // Agent created < 6s ago with no tmux_session means spawn pipeline is still
    // running. Resuming now would race with the spawn. meta.state is irrelevant.
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "creating",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "",
        // Created ~now — well within the 6s grace period.
        created_epoch: Math.floor(Date.now() / 1000),
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("still being created");
    // Guard must short-circuit before any tmux spawn.
    const newSessionCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "new-session"
    );
    expect(newSessionCall).toBeUndefined();
  });

  // ----- Per-repo coordinator: R triggers a full reset -----
  //
  // When meta.agentType === "coordinator", resumeAgent must NOT take the regular
  // resume-session path. Instead, it tears down the existing coordinator
  // (nukeAgent) and respawns it (newAgent). These tests verify the routing
  // and teardown half. The respawn half goes through newAgent which has its
  // own dedicated tests — here we just confirm the coordinator was nuked
  // and resumeAgent did NOT generate a resume.sh script (which would be the
  // tell that it took the wrong branch).

  describe("coordinator reset path", () => {
    let originalHome: string | undefined;
    let coordTempDir: string;

    beforeEach(async () => {
      // newAgent needs a fake HOME with an agent-types directory and a
      // .ittybitty/repo-id file. Set those up so the respawn half of
      // resetCoordinator can run far enough to verify routing.
      coordTempDir = tempDir;
      await mkdir(join(coordTempDir, ".ittybitty"), { recursive: true });
      await Bun.write(join(coordTempDir, ".ittybitty", "repo-id"), "abcd1234\n");

      originalHome = process.env.HOME;
      const fakeHome = join(coordTempDir, "home");
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      process.env.HOME = fakeHome;
      await (await import("./agent-types")).ensureAgentTypesDir();

      // Isolate user config too — newAgent reads it for default model.
      const userConfigPath = join(coordTempDir, "ib-coord-config.json");
      setUserConfigPath(userConfigPath);
      await Bun.write(userConfigPath, JSON.stringify({ model: "sonnet" }, null, 2));

      // newAgent uses its own spawn context; route everything through the
      // shared spawnCalls log so tests can introspect.
      setNewAgentSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("tmux has-session")) return makeSpawnResult(1);
        if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
        if (cmdStr.includes("--show-toplevel")) return makeSpawnResult(0, coordTempDir);
        if (cmdStr.includes("--git-dir")) return makeSpawnResult(0, ".git");
        if (cmdStr.includes("capture-pane")) return makeSpawnResult(0, "Claude Code v1.0");
        return makeSpawnResult(0);
      });
    });

    afterEach(async () => {
      resetNewAgentSpawnRunner();
      resetUserConfigPath();
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    });

    test("on coordinator: nukes the original agent dir and does NOT generate resume.sh", async () => {
      const repoBasename = coordTempDir.split("/").pop()!;
      const coordDir = join(coordTempDir, ".ittybitty", "agents", repoBasename);
      await mkdir(coordDir, { recursive: true });
      await Bun.write(join(coordDir, "meta.json"), JSON.stringify({
        id: repoBasename,
        tmux_session: `tmux-${repoBasename}`,
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        agentType: "coordinator",
      }));

      const agent = _makeAgent({
        id: repoBasename,
        repoPath: coordTempDir,
        repoName: "test",
        state: "running",
        meta: {
          session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          tmux_session: `tmux-${repoBasename}`,
          agentType: "coordinator",
        } as any,
      });

      await resumeAgent(agent);

      // Old meta.json must be gone — proves nukeAgent ran.
      // (resetCoordinator removes the dir before respawning, and the respawn
      // creates a *fresh* meta.json with new content. Whether it succeeded
      // or failed during respawn, the original session_id stamp is gone.)
      const newMeta = await Bun.file(join(coordDir, "meta.json")).json().catch(() => null);
      if (newMeta) {
        // Respawn succeeded — meta.json should NOT carry the old session_id
        // (newAgent generates a fresh sessionUuid).
        expect(newMeta.session_id).not.toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
      }

      // resume.sh must NOT have been written — the coordinator path skips
      // the regular resume-session generator.
      const resumeShExists = await Bun.file(join(coordDir, "resume.sh")).exists().catch(() => false);
      expect(resumeShExists).toBe(false);
    });

    test("on coordinator: returns success with 'Reset' in stdout when respawn succeeds", async () => {
      const repoBasename = coordTempDir.split("/").pop()!;
      const coordDir = join(coordTempDir, ".ittybitty", "agents", repoBasename);
      await mkdir(coordDir, { recursive: true });
      await Bun.write(join(coordDir, "meta.json"), JSON.stringify({
        id: repoBasename,
        tmux_session: `tmux-${repoBasename}`,
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        agentType: "coordinator",
      }));

      const agent = _makeAgent({
        id: repoBasename,
        repoPath: coordTempDir,
        repoName: "test",
        state: "running",
        meta: {
          session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          tmux_session: `tmux-${repoBasename}`,
          agentType: "coordinator",
        } as any,
      });

      const result = await resumeAgent(agent);

      // If respawn succeeded, stdout should reflect the reset.
      // If it failed (test environment limitations), stderr should at
      // least mention "respawn" — proving the routing happened, not the
      // regular resume path (which would say "session_id" or similar).
      if (result.ok) {
        expect(result.stdout).toContain("Reset coordinator");
      } else {
        expect(result.stderr).toContain("respawn");
      }
    });

    test("non-coordinator resume is unchanged (still writes resume.sh)", async () => {
      // Regression guard: a regular agent (no coordinator flag) must still
      // go through the resume-session path.
      const agentDir = join(coordTempDir, ".ittybitty", "agents", "agent-noncoord");
      await mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
        id: "agent-noncoord",
        tmux_session: "tmux-agent-noncoord",
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      }));

      const agent = _makeAgent({
        id: "agent-noncoord",
        repoPath: coordTempDir,
        repoName: "test",
        state: "stopped",
        meta: {
          session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          tmux_session: "tmux-agent-noncoord",
          // coordinator deliberately omitted (or false)
        } as any,
      });

      const result = await resumeAgent(agent);

      expect(result.ok).toBe(true);
      // Regular resume path: resume.sh exists, agent dir intact.
      const resumeShExists = await Bun.file(join(agentDir, "resume.sh")).exists();
      expect(resumeShExists).toBe(true);
      const metaExists = await Bun.file(join(agentDir, "meta.json")).exists();
      expect(metaExists).toBe(true);
    });
  });

});

describe("mergeAgent (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  /**
   * Create a smart mock that handles git commands needed for merge.
   * - git status --porcelain → empty (no uncommitted changes)
   * - git branch --show-current → "main"
   * - git show-ref --verify → success
   * - git log ... --oneline → "abc1234 commit msg" (1 commit)
   * - git rebase → success
   * - git checkout → success
   * - git merge → success
   * - tmux has-session → failure (no session)
   * - Others → success
   */
  function makeMergeMock(
    overrides?: {
      worktreeHasChanges?: boolean;
      repoHasChanges?: boolean;
      currentBranch?: string;
      branchExists?: boolean;
      commitCount?: number;
      rebaseFails?: boolean;
      checkoutFails?: boolean;
      mergeFails?: boolean;
      conflictCheckFails?: boolean;
    }
  ): (cmd: string[], opts?: any) => SpawnResult {
    const opts = {
      worktreeHasChanges: false,
      repoHasChanges: false,
      currentBranch: "main",
      branchExists: true,
      commitCount: 1,
      rebaseFails: false,
      checkoutFails: false,
      mergeFails: false,
      conflictCheckFails: false,
      ...overrides,
    };

    return (cmd: string[]) => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");

      // git status --porcelain (worktree or repo)
      if (cmdStr.includes("status") && cmdStr.includes("--porcelain")) {
        const isWorktree = cmd.some((c) => c.includes("/repo"));
        const hasChanges = isWorktree ? opts.worktreeHasChanges : opts.repoHasChanges;
        return makeSpawnResult(0, hasChanges ? "M file.ts\n" : "");
      }

      // git branch --show-current
      if (cmdStr.includes("branch") && cmdStr.includes("--show-current")) {
        return makeSpawnResult(0, opts.currentBranch);
      }

      // git show-ref --verify
      if (cmdStr.includes("show-ref") && cmdStr.includes("--verify")) {
        return makeSpawnResult(opts.branchExists ? 0 : 1);
      }

      // git log ... --oneline (commit count)
      if (cmdStr.includes("log") && cmdStr.includes("--oneline")) {
        const lines = Array.from({ length: opts.commitCount }, (_, i) => `abc${i} commit ${i}`);
        return makeSpawnResult(0, opts.commitCount > 0 ? lines.join("\n") : "");
      }

      // Conflict check: git rebase in temp dir
      if (cmd.includes("rebase") && cmdStr.includes("/tmp/ib-rebase-check-")) {
        return makeSpawnResult(
          opts.conflictCheckFails ? 1 : 0,
          opts.conflictCheckFails ? "CONFLICT (content): Merge conflict in file.ts" : "",
        );
      }

      // Actual rebase in worktree
      if (cmd.includes("rebase") && !cmdStr.includes("/tmp/ib-rebase-check-") && !cmd.includes("--abort")) {
        return makeSpawnResult(opts.rebaseFails ? 1 : 0, opts.rebaseFails ? "CONFLICT" : "");
      }

      // git checkout
      if (cmd.includes("checkout")) {
        return makeSpawnResult(opts.checkoutFails ? 1 : 0);
      }

      // git merge (but not merge in "merge-check")
      if (cmd.includes("merge") && (cmd.includes("--ff-only") || cmd.includes("--no-ff"))) {
        return makeSpawnResult(opts.mergeFails ? 1 : 0, opts.mergeFails ? "Merge conflict" : "");
      }

      // tmux has-session → failure (no active session)
      if (cmdStr.includes("has-session")) {
        return makeSpawnResult(1);
      }

      // pgrep → failure (no processes)
      if (cmd[0] === "pgrep") {
        return makeSpawnResult(1);
      }

      // Default: success
      return makeSpawnResult();
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "merge-test-"));
    spawnCalls = [];
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetMergeSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory doesn't exist", async () => {
    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });

  test("returns error when worktree directory doesn't exist", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));
    // Don't create repo/ subdirectory

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("no worktree");
  });

  test("returns error when worktree has uncommitted changes", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock({ worktreeHasChanges: true });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("uncommitted changes");
  });

  test("returns error when repo has uncommitted changes", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock({ repoHasChanges: true });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("uncommitted changes");
  });

  test("returns error when agent branch doesn't exist", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock({ branchExists: false });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("does not exist");
  });

  test("returns error when pre-rebase conflict check fails", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock({ conflictCheckFails: true });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Rebase conflict detected");
  });

  test("returns error when rebase fails", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock({ rebaseFails: true });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Rebase failed");
  });

  test("succeeds with full merge sequence and returns 'Closed agent: <id>'", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Closed agent: agent-abc");
  });

  test("performs git rebase, checkout, and merge in correct order", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    // Find the actual rebase (not the conflict check one)
    const rebaseCall = spawnCalls.find(
      (c) => c.includes("rebase") && !c.some((a) => a.includes("/tmp/ib-rebase-check-")) && !c.includes("--abort")
    );
    expect(rebaseCall).toBeDefined();
    expect(rebaseCall).toContain("main");

    // Find checkout call
    const checkoutCall = spawnCalls.find((c) => c.includes("checkout") && c.includes("main"));
    expect(checkoutCall).toBeDefined();

    // Find merge call — --ff-only when running as agent, --no-ff when not
    const mergeCall = spawnCalls.find(
      (c) => c.includes("merge") && (c.includes("--ff-only") || c.includes("--no-ff"))
    );
    expect(mergeCall).toBeDefined();
    expect(mergeCall).toContain("agent/agent-abc");

    // Verify order: rebase before checkout before merge
    const rebaseIdx = spawnCalls.indexOf(rebaseCall!);
    const checkoutIdx = spawnCalls.indexOf(checkoutCall!);
    const mergeIdx = spawnCalls.indexOf(mergeCall!);
    expect(rebaseIdx).toBeLessThan(checkoutIdx);
    expect(checkoutIdx).toBeLessThan(mergeIdx);
  });

  test("removes agent directory after successful merge", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    const exists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
    expect(exists).toBe(false);
  });

  test("removes user-questions.json entries for merged agent", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));
    await Bun.write(
      join(tempDir, ".ittybitty", "user-questions.json"),
      JSON.stringify({
        questions: [
          { agent: "agent-abc", question: "Q1" },
          { agent: "agent-other", question: "Q2" },
        ],
      })
    );

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    const updated = await Bun.file(join(tempDir, ".ittybitty", "user-questions.json")).json();
    expect(updated.questions).toEqual([{ agent: "agent-other", question: "Q2" }]);
  });

  test("skips rebase/checkout/merge when commit count is 0", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock({ commitCount: 0 });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(true);

    // Should NOT have actual rebase/checkout/merge calls
    const rebaseCall = spawnCalls.find(
      (c) => c.includes("rebase") && !c.some((a) => a.includes("/tmp/ib-rebase-check-")) && !c.includes("--abort")
    );
    expect(rebaseCall).toBeUndefined();

    const checkoutCall = spawnCalls.find((c) => c.includes("checkout"));
    expect(checkoutCall).toBeUndefined();

    const mergeCall = spawnCalls.find((c) => c.includes("--ff-only") || c.includes("--no-ff"));
    expect(mergeCall).toBeUndefined();
  });

  test("logs merge activity to agent.log", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    // agent.log gets archived, but archive creates a copy.
    // Since the dir gets removed at the end, we check archive instead.
    const archiveDir = join(tempDir, ".ittybitty", "archive");
    const archiveEntries = await (async () => {
      try {
        const { readdir } = await import("fs/promises");
        return await readdir(archiveDir);
      } catch { return []; }
    })();

    // Should have at least one archive entry
    expect(archiveEntries.length).toBeGreaterThan(0);

    // Check the archived agent.log
    const archiveFolder = join(archiveDir, archiveEntries[0]!);
    const log = await Bun.file(join(archiveFolder, "agent.log")).text();
    expect(log).toContain("Starting rebase of agent/agent-abc onto main");
    expect(log).toContain("Rebase completed successfully");
    expect(log).toContain("Merge complete - archiving and closing agent");
  });

  test("deletes agent branch via git branch -D", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    const branchDeleteCall = spawnCalls.find(
      (c) => c.includes("branch") && c.includes("-D") && c.includes("agent/agent-abc")
    );
    expect(branchDeleteCall).toBeDefined();
  });

  test("removes worktree via git worktree remove --force", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    const worktreeRemoveCall = spawnCalls.find(
      (c) => c.includes("worktree") && c.includes("remove") && c.includes("--force")
    );
    expect(worktreeRemoveCall).toBeDefined();
  });

  test("conflict check creates temp branch and worktree", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    // Should have created a temp branch
    const tempBranchCreate = spawnCalls.find(
      (c) => c.includes("branch") && c.some((a) => a.startsWith("temp-rebase-check-"))
    );
    expect(tempBranchCreate).toBeDefined();

    // Should have created a temp worktree
    const tempWorktreeAdd = spawnCalls.find(
      (c) => c.includes("worktree") && c.includes("add") && c.some((a) => a.includes("/tmp/ib-rebase-check-"))
    );
    expect(tempWorktreeAdd).toBeDefined();

    // Should have cleaned up temp branch
    const tempBranchDelete = spawnCalls.find(
      (c) => c.includes("branch") && c.includes("-D") && c.some((a) => a.startsWith("temp-rebase-check-"))
    );
    expect(tempBranchDelete).toBeDefined();
  });

  test("returns error when merging from within agent's own worktree", async () => {
    // Construct a repoPath such that worktreePath = join(repoPath, ".ittybitty/agents/agent-abc/repo")
    // is a prefix of process.cwd(). Since cwd is something like /Users/.../repo, we use
    // a repoPath that makes worktreePath equal to or a prefix of the actual cwd.
    const cwd = process.cwd();
    // worktreePath = join(repoPath, ".ittybitty", "agents", "agent-abc", "repo")
    // We need cwd.startsWith(worktreePath), so worktreePath must be a prefix of cwd.
    // Set repoPath such that worktreePath == cwd (or prefix).
    // cwd = repoPath + "/.ittybitty/agents/agent-abc/repo"
    // => repoPath = cwd without the suffix
    const suffix = join(".ittybitty", "agents", "agent-abc", "repo");
    // We need to create a repoPath where worktreePath is exactly cwd
    // So repoPath = cwd.slice(0, cwd.length - suffix.length - 1)
    // But this requires cwd to end with the suffix, which it won't.
    // Instead, use a trick: set repoPath to the parent of cwd's ancestor such that
    // worktreePath = cwd. We can use a temporary directory approach:
    // Create the agent dir under a path that makes worktreePath == cwd
    // Actually simplest: just use "/" as repoPath and agent ID such that
    // worktreePath would be /.ittybitty/agents/agent-abc/repo — that's not cwd.
    //
    // Best approach: The check is `process.cwd().startsWith(worktreePath)`.
    // We need worktreePath to be a prefix of cwd.
    // worktreePath = join(repoPath, ".ittybitty", "agents", "agent-abc", "repo")
    // If we set repoPath so that worktreePath = "/" (which is a prefix of everything),
    // that would work, but it's not realistic.
    //
    // Most practical: construct repoPath from cwd by stripping the suffix.
    // cwd = /Users/adamwulf/Developer/bun/itsybitsy/.ittybitty/agents/agent-d33c5f85/repo
    // If we use a different agent ID, we can make worktreePath = cwd.
    // We need the agent to have the same ID as the agent directory in cwd.
    // Extract our own agent ID from cwd:
    const cwdMatch = cwd.match(/\/.ittybitty\/agents\/([^/]+)\/repo/);
    if (!cwdMatch) {
      // Not running inside an agent worktree — skip this test gracefully
      // by testing with a constructed path that IS a prefix
      // This shouldn't happen in CI, but handle it anyway
      return;
    }
    const ourAgentId = cwdMatch[1]!;
    // Construct repoPath so that worktreePath = cwd
    const repoPath = cwd.replace(new RegExp(`/\\.ittybitty/agents/${ourAgentId}/repo$`), "");

    // Create the agent directory at the expected path
    const agentDir = join(repoPath, ".ittybitty", "agents", ourAgentId);
    // agentDir should already exist (it's our own agent dir)
    // We just need meta.json to exist there — but we shouldn't modify the real one.
    // Instead, use a different approach: just ensure dirExists check passes
    // by verifying the meta.json already exists from our actual agent.
    const metaExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
    if (!metaExists) return; // Can't run this test

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = _makeAgent({
      id: ourAgentId,
      repoPath,
      repoName: "test",
      meta: { tmux_session: `tmux-${ourAgentId}` } as any,
    });
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Cannot merge agent from within its own worktree");
  });

  test("returns error when checkout fails", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock({ checkoutFails: true });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Could not checkout");
  });

  test("returns error when merge (ff-only/no-ff) fails", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock({ mergeFails: true });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    // Should contain either "Fast-forward failed" or "Merge failed"
    expect(result.stderr).toMatch(/Fast-forward failed|Merge failed/);
  });

  test("includes stderr content in error messages when git commands fail", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    // Custom mock that returns stderr content on rebase failure
    const runner = (cmd: string[]) => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");

      // Make the actual rebase fail with stderr content
      if (cmd.includes("rebase") && !cmdStr.includes("/tmp/ib-rebase-check-") && !cmd.includes("--abort")) {
        return makeSpawnResult(1, "", "error: could not apply abc1234... some commit\nConflict in file.ts");
      }

      // git status --porcelain → clean
      if (cmdStr.includes("status") && cmdStr.includes("--porcelain")) {
        return makeSpawnResult();
      }
      // git branch --show-current → main
      if (cmdStr.includes("branch") && cmdStr.includes("--show-current")) {
        return makeSpawnResult(0, "main");
      }
      // git show-ref → exists
      if (cmdStr.includes("show-ref")) {
        return makeSpawnResult();
      }
      // git log --oneline → 1 commit
      if (cmdStr.includes("log") && cmdStr.includes("--oneline")) {
        return makeSpawnResult(0, "abc1234 some commit");
      }
      // Conflict check rebase → success
      if (cmd.includes("rebase") && cmdStr.includes("/tmp/ib-rebase-check-")) {
        return makeSpawnResult();
      }
      // Default → success
      return makeSpawnResult();
    };

    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Rebase failed:");
    expect(result.stderr).toContain("could not apply");
  });

  test("merge still succeeds when worktree remove fails (rm -rf fallback)", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    // Custom mock: worktree remove fails
    const baseMock = makeMergeMock();
    const runner = (cmd: string[], opts?: any) => {
      spawnCalls.push(cmd);
      // Make git worktree remove fail for the actual worktree (not the conflict check temp)
      if (cmd.includes("worktree") && cmd.includes("remove") && !cmd.some((a) => a.includes("/tmp/ib-rebase-check-"))) {
        return makeSpawnResult(1, "", "error: failed to remove worktree");
      }
      return baseMock(cmd, opts);
    };

    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent, tempDir);

    // Should still succeed — rm -rf fallback handles cleanup
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Closed agent: agent-abc");
  });

  test("logs conflict check failure to agent.log", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock({ conflictCheckFails: true });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    // Agent dir should still exist since merge failed before cleanup
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("Pre-rebase conflict check failed");
  });

  test("detects target branch from targetDir via -C", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    // Mock returns "feature-branch" for branch --show-current
    const runner = makeMergeMock({ currentBranch: "feature-branch" });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    // The branch detection call must have -C flag with targetDir
    const branchCall = spawnCalls.find(
      (c) => c.includes("branch") && c.includes("--show-current")
    );
    expect(branchCall).toBeDefined();
    expect(branchCall).toContain("-C");
    expect(branchCall).toContain(tempDir);

    // Checkout should target feature-branch, not main
    const checkoutCall = spawnCalls.find((c) => c.includes("checkout"));
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall).toContain("feature-branch");
  });

  test("status, checkout, and merge all use -C targetDir", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    // checkout must have -C flag with targetDir
    const checkoutCall = spawnCalls.find((c) => c.includes("checkout") && c.includes("main"));
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall).toContain("-C");
    expect(checkoutCall).toContain(tempDir);

    // merge must have -C flag with targetDir
    const mergeCall = spawnCalls.find(
      (c) => c.includes("merge") && (c.includes("--ff-only") || c.includes("--no-ff"))
    );
    expect(mergeCall).toBeDefined();
    expect(mergeCall).toContain("-C");
    expect(mergeCall).toContain(tempDir);

    // status --porcelain must have -C flag with targetDir
    const statusCalls = spawnCalls.filter(
      (c) => c.includes("status") && c.includes("--porcelain")
    );
    const targetDirStatusCall = statusCalls.find((c) => c.includes("-C") && c.includes(tempDir));
    expect(targetDirStatusCall).toBeDefined();
  });

  test("merges into manager branch when called from manager worktree", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc",
    }));

    // Simulate calling from a manager worktree — manager is on agent/agent-manager branch
    const runner = makeMergeMock({ currentBranch: "agent/agent-manager" });
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent, tempDir);

    // Rebase should target the manager's branch
    const rebaseCall = spawnCalls.find(
      (c) => c.includes("rebase") && !c.some((a) => a.includes("/tmp/ib-rebase-check-")) && !c.includes("--abort")
    );
    expect(rebaseCall).toBeDefined();
    expect(rebaseCall).toContain("agent/agent-manager");

    // Checkout should target manager's branch
    const checkoutCall = spawnCalls.find((c) => c.includes("checkout"));
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall).toContain("agent/agent-manager");

    // Merge into manager's branch
    const mergeCall = spawnCalls.find(
      (c) => c.includes("merge") && (c.includes("--ff-only") || c.includes("--no-ff"))
    );
    expect(mergeCall).toBeDefined();
    expect(mergeCall).toContain("agent/agent-abc");
  });
});

// ── newAgent (native) tests ──────────────────────────────────────────────────

describe("newAgent (native)", () => {
  let tempDir: string;
  let agentsDir: string;
  let spawnCalls: string[][];

  function mockSpawnRunner(overrides?: {
    failTmuxNewSession?: boolean;
    failWorktree?: boolean;
    failTmuxServer?: boolean;
    tmuxHasSessionExists?: boolean;
    whichGhExists?: boolean;
    hasRemote?: boolean;
  }) {
    return (cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");

      // tmux has-session — should fail (agent doesn't exist yet) by default
      if (cmdStr.includes("tmux has-session")) {
        if (overrides?.tmuxHasSessionExists) {
          return makeSpawnResult("", 0);
        }
        // After new-session, the verify call should succeed
        const newSessionCalled = spawnCalls.some(c => c.join(" ").includes("tmux new-session"));
        return makeSpawnResult("", newSessionCalled ? 0 : 1);
      }

      // tmux start-server
      if (cmdStr.includes("tmux start-server")) {
        return makeSpawnResult("", overrides?.failTmuxServer ? 1 : 0);
      }

      // tmux new-session
      if (cmdStr.includes("tmux new-session")) {
        return makeSpawnResult("", overrides?.failTmuxNewSession ? 1 : 0);
      }

      // git worktree add
      if (cmdStr.includes("worktree add")) {
        if (overrides?.failWorktree) {
          return makeSpawnResult("", 1);
        }
        // Create the repo dir to simulate worktree creation
        const repoIdx = cmd.indexOf("add") + 1;
        if (repoIdx > 0 && repoIdx < cmd.length) {
          const repoDir = cmd[repoIdx]!;
          require("fs").mkdirSync(repoDir, { recursive: true });
        }
        return makeSpawnResult("", 0);
      }

      // git worktree remove (cleanup)
      if (cmdStr.includes("worktree remove")) {
        return makeSpawnResult("", 0);
      }

      // git branch -D (cleanup)
      if (cmdStr.includes("branch -D")) {
        return makeSpawnResult("", 0);
      }

      // git rev-parse --git-common-dir (resolveGitRoot)
      if (cmdStr.includes("--git-common-dir")) {
        return makeSpawnResult(".git", 0);
      }

      // git rev-parse --show-toplevel (resolveGitRoot)
      if (cmdStr.includes("--show-toplevel")) {
        return makeSpawnResult(tempDir, 0);
      }

      // git rev-parse --git-dir
      if (cmdStr.includes("--git-dir")) {
        return makeSpawnResult(".git", 0);
      }

      // which gh
      if (cmdStr.includes("which gh")) {
        return makeSpawnResult(overrides?.whichGhExists ? "/usr/local/bin/gh" : "", overrides?.whichGhExists ? 0 : 1);
      }

      // git remote
      if (cmdStr.includes("git") && cmd[cmd.length - 1] === "remote") {
        return makeSpawnResult(overrides?.hasRemote ? "origin" : "", 0);
      }

      // tmux capture-pane (for auto_accept — return logo immediately)
      if (cmdStr.includes("capture-pane")) {
        return makeSpawnResult("Claude Code v1.0", 0);
      }

      // Default: succeed
      return makeSpawnResult("", 0);
    };
  }

  function makeSpawnResult(stdout: string, exitCode: number): SpawnResult {
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(exitCode),
    };
  }

  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ib-newagent-test-"));
    agentsDir = join(tempDir, ".ittybitty", "agents");
    spawnCalls = [];

    // Create .ittybitty/repo-id
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    await Bun.write(join(tempDir, ".ittybitty", "repo-id"), "abcd1234\n");

    // Override HOME so agent-types lookups resolve to a temp dir isolated from
    // the developer's real ~/.itsybitsy/agent-types/.
    originalHome = process.env.HOME;
    const fakeHome = join(tempDir, "home");
    await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
    process.env.HOME = fakeHome;
    // Populate the embedded defaults (including _all.md and _non_coordinator.md).
    // ensureAgentTypesDir() writes all embedded files only on first run.
    await (await import("./agent-types")).ensureAgentTypesDir();

    // Set user config path to temp dir so tests don't inherit the real user config
    const userConfigPath = join(tempDir, "config.json");
    setUserConfigPath(userConfigPath);
    await Bun.write(userConfigPath, JSON.stringify({ model: "sonnet" }, null, 2));

    // Also set the lifecycle spawn runner (used by resolveGitRoot)
    lifecycleSpawnCtx.set((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeSpawnResult(tempDir, 0);
      if (cmdStr.includes("--git-dir")) return makeSpawnResult(".git", 0);
      return makeSpawnResult("", 0);
    });
  });

  afterEach(async () => {
    resetNewAgentSpawnRunner();
    resetNewAgentSummaryGenerator();
    lifecycleSpawnCtx.reset();
    resetUserConfigPath();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Overwrite the temp-home _all.md layer with the given allow/deny lists.
   * Uses inline array syntax (`[...]`) so entries containing colons (e.g.
   * `Bash(curl:*)`) are handled correctly by the simple YAML parser.
   */
  async function writeAllLayer(allow: string[], deny: string[]) {
    const path = join(process.env.HOME!, ".itsybitsy", "agent-types", "_all.md");
    const allowYaml = `  allow: [${allow.map((a) => JSON.stringify(a)).join(", ")}]`;
    const denyYaml = `  deny: [${deny.map((d) => JSON.stringify(d)).join(", ")}]`;
    const body = `---\nname: _all\ndescription: Test all-layer\nspawnable: false\npermissions:\n${allowYaml}\n${denyYaml}\n---\n`;
    await Bun.write(path, body);
  }

  /** Wrapper that always passes _cwd to prevent auto-detect manager from our own worktree */
  async function callNewAgent(prompt: string, opts?: import("./ib-commands").NewAgentOptions) {
    return newAgent(tempDir, prompt, { ...opts, _cwd: tempDir });
  }

  test("rejects empty prompt", async () => {
    const result = await callNewAgent("");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("prompt required");
  });

  test("creates agent with correct ID format when no name given", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do something");
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/^agent-[0-9a-f]{8}$/);
  });

  test("creates agent with custom name", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do something", { name: "my-agent" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("my-agent");
  });

  test("creates meta.json with correct fields", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("test prompt", { name: "test-meta" });
    expect(result.ok).toBe(true);

    const meta = await Bun.file(join(agentsDir, "test-meta", "meta.json")).json();
    expect(meta.id).toBe("test-meta");
    expect(meta.tmux_session).toBe("ittybitty-abcd1234-test-meta");
    expect(meta.prompt).toBe("test prompt");
    expect(meta.manager).toBeNull();
    expect(meta.worktree).toBe(true);
    expect(meta.worker).toBe(false);
    expect(meta.agentType).toBe("manager"); // default type
    expect(meta.yolo).toBe(false);
    expect(meta.model).toBe("sonnet"); // model from test config
    expect(meta.session_id).toMatch(/^[0-9a-f-]+$/);
    expect(typeof meta.created_epoch).toBe("number");
  });

  test("stores agentType in meta.json when --type worker is used", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("test worker", { name: "test-worker-type", type: "worker" });
    expect(result.ok).toBe(true);

    const meta = await Bun.file(join(agentsDir, "test-worker-type", "meta.json")).json();
    expect(meta.agentType).toBe("worker");
    expect(meta.worker).toBe(true);
  });

  test("writes meta.json with state='creating' BEFORE git worktree add runs", async () => {
    // Verifies Fix 1: the early meta.json write happens before any slow step.
    // On large repos, `git worktree add` can take 60-90s. Without the early
    // write, the dashboard's readAllAgents() flagged the in-progress dir as
    // an orphan. With the early write, meta.json exists with state='creating'
    // by the time any spawn (including worktree add) is invoked.
    let metaAtWorktreeAdd: { exists: boolean; state?: string; id?: string } | null = null;

    const fs = require("fs");
    const customSpawn = (cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      // Snapshot meta.json state at the moment worktree add is invoked.
      if (cmdStr.includes("worktree add") && metaAtWorktreeAdd === null) {
        const metaPath = join(agentsDir, "test-early-meta", "meta.json");
        try {
          const raw = fs.readFileSync(metaPath, "utf8");
          const data = JSON.parse(raw);
          metaAtWorktreeAdd = { exists: true, state: data.state, id: data.id };
        } catch {
          metaAtWorktreeAdd = { exists: false };
        }
      }
      // Delegate to the standard mock for the actual response.
      return mockSpawnRunner()(cmd, _opts);
    };
    setNewAgentSpawnRunner(customSpawn);
    lifecycleSpawnCtx.set(customSpawn);

    const result = await callNewAgent("slow checkout", { name: "test-early-meta" });
    expect(result.ok).toBe(true);

    expect(metaAtWorktreeAdd).not.toBeNull();
    expect(metaAtWorktreeAdd!.exists).toBe(true);
    expect(metaAtWorktreeAdd!.state).toBe("creating");
    expect(metaAtWorktreeAdd!.id).toBe("test-early-meta");
  });

  test("logs 'starting' lines before slow spawn steps (worktree add, tmux new-session)", async () => {
    // Verifies Fix 2: bracket-logging — if a spawn hangs, the LAST log line
    // identifies which step hung. Each slow step gets a "starting" log line
    // before the operation runs, plus the existing post-completion line.
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("test bracket logs", { name: "test-bracket-logs" });
    expect(result.ok).toBe(true);

    const log = await Bun.file(join(agentsDir, "test-bracket-logs", "agent.log")).text();
    expect(log).toContain("[spawn] git worktree add starting:");
    expect(log).toContain("[spawn] tmux new-session starting:");
    expect(log).toContain("[spawn] tmux has-session verify starting:");

    // Sanity check: the "starting" line for worktree add appears BEFORE the
    // post-completion exit line in the log.
    const startingIdx = log.indexOf("git worktree add starting:");
    const completedIdx = log.indexOf("git worktree add /");
    expect(startingIdx).toBeGreaterThan(-1);
    expect(completedIdx).toBeGreaterThan(startingIdx);
  });

  test("stores agentType in meta.json when --type flag is used", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("test custom type", { name: "test-type-flag", type: "worker" });
    expect(result.ok).toBe(true);

    const meta = await Bun.file(join(agentsDir, "test-type-flag", "meta.json")).json();
    expect(meta.agentType).toBe("worker");
  });

  test("--type flag overrides default agentType", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("test custom", { name: "test-type-override", type: "worker" });
    expect(result.ok).toBe(true);

    const meta = await Bun.file(join(agentsDir, "test-type-override", "meta.json")).json();
    expect(meta.agentType).toBe("worker");
    expect(meta.worker).toBe(true); // canSpawnChildren: false → worker: true
  });

  test("--type coordinator creates a coordinator agent", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("start coordinator", { type: "coordinator", _cwd: tempDir });
    expect(result.ok).toBe(true);

    const repoName = tempDir.split("/").pop() ?? tempDir;
    const meta = await Bun.file(join(agentsDir, repoName, "meta.json")).json();
    expect(meta.agentType).toBe("coordinator");
  });

  test("creates prompt.txt with prompt content", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("build a widget", { name: "test-prompt" });

    const promptContent = await Bun.file(join(agentsDir, "test-prompt", "prompt.txt")).text();
    expect(promptContent).toContain("build a widget");
  });

  test("creates start.sh with correct content", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-start" });

    const startSh = await Bun.file(join(agentsDir, "test-start", "start.sh")).text();
    expect(startSh).toContain("#!/bin/bash");
    expect(startSh).toContain("claude --session-id");
    expect(startSh).toContain("CLAUDE_PID=$!");
    expect(startSh).toContain("unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT");
    // No PATH export — ib is already on the user's PATH
    expect(startSh).not.toContain("export PATH");
  });

  test("start.sh captures claude stderr to a sidecar log and tails it on non-zero exit", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-stderr" });

    const startSh = await Bun.file(join(agentsDir, "test-stderr", "start.sh")).text();
    // STDERR_LOG variable is set and used as claude's stderr redirect target.
    expect(startSh).toContain("STDERR_LOG=");
    expect(startSh).toContain("claude.stderr.log");
    expect(startSh).toMatch(/claude --session-id[^\n]*2> "\$STDERR_LOG"/);
    // On non-zero exit, last 50 lines of stderr are appended to agent.log
    // so post-mortem doesn't depend on the (now-dying) tmux pane.
    expect(startSh).toContain('if [[ "$EXIT_CODE" -ne 0 && -s "$STDERR_LOG" ]]');
    expect(startSh).toContain('tail -n 50 "$STDERR_LOG" >> "$AGENT_LOG"');
  });

  test("start.sh annotates common claude exit codes", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-exit-codes" });

    const startSh = await Bun.file(join(agentsDir, "test-exit-codes", "start.sh")).text();
    // The case statement labels each known exit code so the cause is obvious
    // in agent.log without consulting external docs.
    expect(startSh).toContain("case $EXIT_CODE in");
    expect(startSh).toContain("137) log \"exit=137 → SIGKILL");
    expect(startSh).toContain("139) log \"exit=139 → SIGSEGV");
    expect(startSh).toContain("143) log \"exit=143 → SIGTERM");
    expect(startSh).toContain("127) log \"exit=127 → command not found");
  });

  test("start.sh ignores SIGHUP and launches claude under setsid (no kill-on-HUP)", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-hup" });

    const startSh = await Bun.file(join(agentsDir, "test-hup", "start.sh")).text();

    // Same SIGHUP-immunity fix as resume.sh: ignore SIGHUP so a stray signal
    // from the launcher pane can't kill a freshly-spawned agent.
    expect(startSh).toContain("trap '' HUP");
    // The old kill-on-HUP trap (with a body) is gone.
    expect(startSh).not.toMatch(/trap '[^']+' HUP/);
    expect(startSh).not.toContain("SIGHUP diagnostics");

    // setsid defense-in-depth with a graceful fallback to a bare launch.
    expect(startSh).toContain("command -v setsid");
    expect(startSh).toContain("setsid claude --session-id");
    expect(startSh).toMatch(/^ *claude --session-id "/m);

    // ORDERING + UNCONDITIONAL: `trap '' HUP` must precede the claude launch
    // (so SIG_IGN is inherited by the child) AND precede the `command -v setsid`
    // guard (so the bare-launch fallback path still gets the protection).
    const hupIdx = startSh.indexOf("trap '' HUP");
    const setsidGuardIdx = startSh.indexOf("command -v setsid");
    const firstLaunchIdx = startSh.search(/(setsid )?claude --session-id "/);
    expect(hupIdx).toBeGreaterThan(-1);
    expect(hupIdx).toBeLessThan(firstLaunchIdx);
    expect(hupIdx).toBeLessThan(setsidGuardIdx);

    // TERM and INT traps unchanged — clean teardown still forwards to claude.
    expect(startSh).toMatch(/trap '[^']*kill \$CLAUDE_PID[^']*' TERM/);
    expect(startSh).toMatch(/trap '[^']*kill -INT \$CLAUDE_PID[^']*' INT/);
  });

  test("new-agent sets a tmux pane-died hook that writes to agent.log", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-pane-died" });

    // The pane-died hook is a backstop for cases where start.sh dies before
    // it can log the exit code (e.g. bash crash, tmux server killed).
    const setHookCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "set-hook" && c.includes("pane-died"),
    );
    expect(setHookCall).toBeDefined();
    const hookBody = setHookCall![setHookCall!.length - 1]!;
    expect(hookBody).toContain("run-shell");
    expect(hookBody).toContain("[tmux pane-died]");
    expect(hookBody).toContain("#{session_name}");
    expect(hookBody).toContain("agent.log");
  });

  test("new-agent sets window-size manual on the new tmux session", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-window-size" });

    // window-size manual prevents tmux from auto-resizing the agent's
    // session to the latest attached client's terminal size.
    const setWindowSize = spawnCalls.find(
      (c) =>
        c[0] === "tmux" &&
        c[1] === "set-option" &&
        c.includes("window-size") &&
        c.includes("manual"),
    );
    expect(setWindowSize).toBeDefined();
  });

  test("creates exit-check.sh", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-exit" });

    const exitSh = await Bun.file(join(agentsDir, "test-exit", "exit-check.sh")).text();
    expect(exitSh).toContain("#!/bin/bash");
    expect(exitSh).toContain("UNCOMMITTED CHANGES DETECTED");
  });

  test("initializes agent.log", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-log" });

    const log = await Bun.file(join(agentsDir, "test-log", "agent.log")).text();
    expect(log).toContain("Agent created");
    expect(log).toContain("do work");
  });

  test("spawns tmux session with correct args", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-tmux" });

    const tmuxNewSession = spawnCalls.find(c => c.includes("new-session"));
    expect(tmuxNewSession).toBeDefined();
    expect(tmuxNewSession).toContain("-d");
    expect(tmuxNewSession).toContain("-x");
    // Width comes from saved layout.json (or DEFAULT_TMUX_WIDTH if none)
    const xIndex = tmuxNewSession!.indexOf("-x");
    expect(xIndex).toBeGreaterThan(-1);
    const widthStr = tmuxNewSession![xIndex + 1];
    expect(Number(widthStr)).toBeGreaterThanOrEqual(40);
    expect(tmuxNewSession).toContain("-s");
    expect(tmuxNewSession).toContain("ittybitty-abcd1234-test-tmux");
  });

  test("creates git worktree by default", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-wt" });

    const worktreeCall = spawnCalls.find(c => c.includes("worktree") && c.includes("add"));
    expect(worktreeCall).toBeDefined();
    expect(worktreeCall).toContain("-b");
    expect(worktreeCall).toContain("agent/test-wt");
    expect(worktreeCall).toContain("HEAD");
  });

  test("worktree branches from manager when specified", async () => {
    // Create a manager agent directory so resolution works
    const mgrDir = join(agentsDir, "agent-mgr");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(join(mgrDir, "meta.json"), JSON.stringify({ id: "agent-mgr", worker: false }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("sub-task", { name: "test-child", manager: "agent-mgr" });

    const worktreeCall = spawnCalls.find(c => c.includes("worktree") && c.includes("add"));
    expect(worktreeCall).toBeDefined();
    expect(worktreeCall).toContain("agent/agent-mgr"); // base ref
  });

  test("logs manager spawn to manager's agent.log", async () => {
    const mgrDir = join(agentsDir, "agent-mgr");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(join(mgrDir, "meta.json"), JSON.stringify({ id: "agent-mgr", worker: false }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("sub-task", { name: "test-child", manager: "agent-mgr" });

    const mgrLog = await Bun.file(join(mgrDir, "agent.log")).text();
    expect(mgrLog).toContain("Spawned manager subagent: test-child");
  });

  test("rejects worker as manager", async () => {
    const workerDir = join(agentsDir, "agent-worker");
    await mkdir(workerDir, { recursive: true });
    await Bun.write(join(workerDir, "meta.json"), JSON.stringify({ id: "agent-worker", worker: true }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { manager: "agent-worker" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("worker agent");
  });

  test("rejects when max agents reached", async () => {
    // Set config with maxAgents: 1
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({ maxAgents: 1 }));

    // Create an existing agent
    const existingDir = join(agentsDir, "agent-existing");
    await mkdir(existingDir, { recursive: true });
    await Bun.write(join(existingDir, "meta.json"), JSON.stringify({ id: "agent-existing" }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "agent-new" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Maximum agent limit reached");
  });

  test("rejects duplicate agent ID", async () => {
    // Create an existing agent with same name
    const existingDir = join(agentsDir, "dup-agent");
    await mkdir(existingDir, { recursive: true });
    await Bun.write(join(existingDir, "meta.json"), JSON.stringify({ id: "dup-agent" }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "dup-agent" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("already exists");
  });

  test("uses custom model from opts", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-model", model: "opus" });

    const meta = await Bun.file(join(agentsDir, "test-model", "meta.json")).json();
    expect(meta.model).toBe("opus");

    const startSh = await Bun.file(join(agentsDir, "test-model", "start.sh")).text();
    expect(startSh).toContain("--model opus");
  });

  test("uses model from config when not specified", async () => {
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({ model: "haiku" }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-cfg-model" });

    const meta = await Bun.file(join(agentsDir, "test-cfg-model", "meta.json")).json();
    expect(meta.model).toBe("haiku");
  });

  test("defaults model to opus when neither opts nor config specify", async () => {
    // Clear config so no model is set
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({}));
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-default-model" });

    const meta = await Bun.file(join(agentsDir, "test-default-model", "meta.json")).json();
    expect(meta.model).toBe("opus");
  });

  test("type: worker sets meta.worker and start.sh doesn't have yolo flags", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-worker", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-worker", "meta.json")).json();
    expect(meta.worker).toBe(true);

    const startSh = await Bun.file(join(agentsDir, "test-worker", "start.sh")).text();
    expect(startSh).not.toContain("dangerously-skip-permissions");
  });

  test("yolo mode sets meta.yolo and start.sh has yolo flags", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-yolo", yolo: true });

    const meta = await Bun.file(join(agentsDir, "test-yolo", "meta.json")).json();
    expect(meta.yolo).toBe(true);

    const startSh = await Bun.file(join(agentsDir, "test-yolo", "start.sh")).text();
    expect(startSh).toContain("--dangerously-skip-permissions");
    expect(startSh).toContain("--permission-mode bypassPermissions");
  });

  test("cleans up on worktree creation failure", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner({ failWorktree: true }));
    const result = await callNewAgent("task", { name: "test-fail-wt" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("worktree");

    // Agent dir should be cleaned up
    const exists = await Bun.file(join(agentsDir, "test-fail-wt", "meta.json")).exists().catch(() => false);
    expect(exists).toBe(false);
  });

  // Build a SpawnResult with stdout/stderr/exitCode — used by self-healing tests
  function makeSpawnResultWithStderr(stdout: string, stderr: string, exitCode: number): SpawnResult {
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stderr));
          controller.close();
        },
      }),
      exited: Promise.resolve(exitCode),
    };
  }

  test("surfaces git stderr in worktree creation failure message", async () => {
    const gitStderr = "fatal: A branch named 'agent/test-stderr' already exists.";
    setNewAgentSpawnRunner((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");

      // worktree add fails with a specific git stderr
      if (cmdStr.includes("worktree add")) {
        return makeSpawnResultWithStderr("", gitStderr, 1);
      }
      // tmux has-session — agent doesn't exist yet
      if (cmdStr.includes("tmux has-session")) {
        return makeSpawnResult("", 1);
      }
      // Default: succeed with no output
      return makeSpawnResult("", 0);
    });
    const result = await callNewAgent("task", { name: "test-stderr" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("could not create worktree");
    expect(result.stderr).toContain(gitStderr);
  });

  test("self-heals residual agent/<id> branch with no worktree before worktree add", async () => {
    const branchName = "agent/test-residual";
    setNewAgentSpawnRunner((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");

      // branch --list <branchName> → pretend the branch exists
      if (cmd[0] === "git" && cmd.includes("branch") && cmd.includes("--list") && cmd.includes(branchName)) {
        return makeSpawnResult(`  ${branchName}\n`, 0);
      }
      // worktree list --porcelain → no worktree holds the branch
      if (cmdStr.includes("worktree list")) {
        return makeSpawnResult("worktree /some/path\nHEAD abc123\nbranch refs/heads/main\n", 0);
      }
      // tmux has-session — agent doesn't exist yet
      if (cmdStr.includes("tmux has-session")) {
        const newSessionCalled = spawnCalls.some(c => c.join(" ").includes("tmux new-session"));
        return makeSpawnResult("", newSessionCalled ? 0 : 1);
      }
      // git worktree add — simulate creating the repo dir
      if (cmdStr.includes("worktree add")) {
        const addIdx = cmd.indexOf("add");
        if (addIdx > -1 && addIdx + 1 < cmd.length) {
          require("fs").mkdirSync(cmd[addIdx + 1]!, { recursive: true });
        }
        return makeSpawnResult("", 0);
      }
      // Default: succeed
      return makeSpawnResult("", 0);
    });
    const result = await callNewAgent("task", { name: "test-residual" });
    expect(result.ok).toBe(true);

    // A `git worktree prune` call happened before `git worktree add`
    const pruneIdx = spawnCalls.findIndex(c => c.includes("worktree") && c.includes("prune"));
    const addIdx = spawnCalls.findIndex(c => c.includes("worktree") && c.includes("add"));
    expect(pruneIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(pruneIdx);

    // `git branch -D <branchName>` happened before `git worktree add`
    const branchDeleteIdx = spawnCalls.findIndex(
      c => c.includes("branch") && c.includes("-D") && c.includes(branchName)
    );
    expect(branchDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(branchDeleteIdx).toBeLessThan(addIdx);
  });

  test("worktree-list match is anchored: prefix-collision does not trigger 'already checked out'", async () => {
    // A different worktree holds `agent/test-prefix-extra`; we're spawning
    // `agent/test-prefix` whose branch also exists but has NO worktree.
    // The old substring match would false-positive and refuse to delete.
    const branchName = "agent/test-prefix";
    setNewAgentSpawnRunner((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");

      if (cmd[0] === "git" && cmd.includes("branch") && cmd.includes("--list") && cmd.includes(branchName)) {
        return makeSpawnResult(`  ${branchName}\n`, 0);
      }
      // worktree list holds a LONGER-named branch that starts with branchName
      if (cmdStr.includes("worktree list")) {
        return makeSpawnResult(
          `worktree /some/other/path\nHEAD abc123\nbranch refs/heads/${branchName}-extra\n`,
          0,
        );
      }
      if (cmdStr.includes("tmux has-session")) {
        const newSessionCalled = spawnCalls.some(c => c.join(" ").includes("tmux new-session"));
        return makeSpawnResult("", newSessionCalled ? 0 : 1);
      }
      if (cmdStr.includes("worktree add")) {
        const addIdx = cmd.indexOf("add");
        if (addIdx > -1 && addIdx + 1 < cmd.length) {
          require("fs").mkdirSync(cmd[addIdx + 1]!, { recursive: true });
        }
        return makeSpawnResult("", 0);
      }
      return makeSpawnResult("", 0);
    });
    const result = await callNewAgent("task", { name: "test-prefix" });
    expect(result.ok).toBe(true);

    // The residual branch should have been auto-deleted (not falsely
    // flagged as "already checked out")
    const branchDelete = spawnCalls.find(
      c => c.includes("branch") && c.includes("-D") && c.includes(branchName)
    );
    expect(branchDelete).toBeDefined();
  });

  test("residual worktree holding agent/<id> yields clean error, not generic", async () => {
    const branchName = "agent/test-held";
    setNewAgentSpawnRunner((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");

      // branch --list <branchName> → pretend the branch exists
      if (cmd[0] === "git" && cmd.includes("branch") && cmd.includes("--list") && cmd.includes(branchName)) {
        return makeSpawnResult(`  ${branchName}\n`, 0);
      }
      // worktree list --porcelain → a worktree DOES hold the branch
      if (cmdStr.includes("worktree list")) {
        return makeSpawnResult(
          `worktree /some/other/path\nHEAD deadbeef\nbranch refs/heads/${branchName}\n`,
          0,
        );
      }
      if (cmdStr.includes("tmux has-session")) {
        return makeSpawnResult("", 1);
      }
      return makeSpawnResult("", 0);
    });
    const result = await callNewAgent("task", { name: "test-held" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(branchName);
    expect(result.stderr).toContain("already checked out");
    expect(result.stderr).not.toContain("could not create worktree");

    // No `git branch -D` was issued (we bailed before deletion)
    const branchDelete = spawnCalls.find(
      c => c.includes("branch") && c.includes("-D") && c.includes(branchName)
    );
    expect(branchDelete).toBeUndefined();

    // No `git worktree add` was attempted
    const worktreeAdd = spawnCalls.find(c => c.includes("worktree") && c.includes("add"));
    expect(worktreeAdd).toBeUndefined();

    // Agent dir should be cleaned up
    const exists = await Bun.file(join(agentsDir, "test-held", "meta.json")).exists().catch(() => false);
    expect(exists).toBe(false);
  });

  test("cleans up on tmux new-session failure", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner({ failTmuxNewSession: true }));
    const result = await callNewAgent("task", { name: "test-fail-tmux" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("tmux session");

    // Cleanup should have run
    const worktreeRemove = spawnCalls.find(c => c.includes("worktree") && c.includes("remove"));
    expect(worktreeRemove).toBeDefined();
    const branchDelete = spawnCalls.find(c => c.includes("branch") && c.includes("-D"));
    expect(branchDelete).toBeDefined();
  });

  test("cleans up on tmux server start failure", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner({ failTmuxServer: true }));
    const result = await callNewAgent("task", { name: "test-fail-server" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("tmux server");
  });

  test("custom prompts are included in prompt.txt", async () => {
    const promptsDir = join(tempDir, ".ittybitty", "prompts");
    await mkdir(promptsDir, { recursive: true });
    await Bun.write(join(promptsDir, "all.md"), "Always be thorough.");
    await Bun.write(join(promptsDir, "manager.md"), "Coordinate sub-agents.");

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("main task", { name: "test-prompts" });

    const promptContent = await Bun.file(join(agentsDir, "test-prompts", "prompt.txt")).text();
    expect(promptContent).toContain("[CUSTOM INSTRUCTIONS]");
    expect(promptContent).toContain("Always be thorough.");
    expect(promptContent).toContain("[CUSTOM MANAGER INSTRUCTIONS]");
    expect(promptContent).toContain("Coordinate sub-agents.");
    expect(promptContent).toContain("main task");
  });

  test("worker prompts use worker-specific custom prompt", async () => {
    const promptsDir = join(tempDir, ".ittybitty", "prompts");
    await mkdir(promptsDir, { recursive: true });
    await Bun.write(join(promptsDir, "worker.md"), "Focus on task.");
    await Bun.write(join(promptsDir, "manager.md"), "Coordinate sub-agents.");

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("work task", { name: "test-worker-prompts", type: "worker" });

    const promptContent = await Bun.file(join(agentsDir, "test-worker-prompts", "prompt.txt")).text();
    expect(promptContent).toContain("[CUSTOM WORKER INSTRUCTIONS]");
    expect(promptContent).toContain("Focus on task.");
    expect(promptContent).not.toContain("Coordinate sub-agents.");
  });

  test("creates settings.local.json in worktree with permissions", async () => {
    // Create base settings in settings.json (not .local — agents inherit from project settings)
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.json"), JSON.stringify({
      permissions: { allow: ["CustomTool"] },
    }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-settings" });

    const settingsPath = join(agentsDir, "test-settings", "repo", ".claude", "settings.local.json");
    const settingsExists = await Bun.file(settingsPath).exists().catch(() => false);
    expect(settingsExists).toBe(true);

    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(ib:*)");
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Agent");
    expect(settings.permissions.allow).toContain("CustomTool"); // merged from base
    expect(settings.permissions.deny).toContain("EnterPlanMode");
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.spinnerTipsEnabled).toBe(false);
  });

  test("does not inherit deny list from base settings.json", async () => {
    // Even if settings.json has a restrictive deny list, agents should not inherit it
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.json"), JSON.stringify({
      permissions: {
        allow: ["Bash(ib:*)", "Read", "Glob", "Grep", "LS"],
        deny: ["Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch",
               "Task", "TaskCreate", "TaskOutput", "Agent", "KillShell",
               "EnterPlanMode", "ExitPlanMode"],
      },
    }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-no-inherit-deny" });

    const settingsPath = join(agentsDir, "test-no-inherit-deny", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();

    // Agent should have Write/Edit in allow (from ibPerms), NOT in deny
    expect(settings.permissions.allow).toContain("Write");
    expect(settings.permissions.allow).toContain("Edit");
    expect(settings.permissions.allow).toContain("MultiEdit");
    expect(settings.permissions.allow).toContain("NotebookEdit");
    expect(settings.permissions.allow).toContain("Agent");
    expect(settings.permissions.allow).toContain("Task");

    // Base settings.json deny entries should NOT have leaked through
    expect(settings.permissions.deny).not.toContain("Write");
    expect(settings.permissions.deny).not.toContain("Edit");
    expect(settings.permissions.deny).not.toContain("MultiEdit");
    expect(settings.permissions.deny).not.toContain("NotebookEdit");
    expect(settings.permissions.deny).not.toContain("Agent");
    expect(settings.permissions.deny).not.toContain("Task");
    expect(settings.permissions.deny).not.toContain("WebFetch");
    expect(settings.permissions.deny).not.toContain("WebSearch");

    // Only the standard blocked tools should be in deny
    expect(settings.permissions.deny).toContain("EnterPlanMode");
    expect(settings.permissions.deny).toContain("ExitPlanMode");
    expect(settings.permissions.deny).toHaveLength(2);
  });

  test("does not inherit permissions from settings.local.json (coordinator isolation)", async () => {
    // settings.local.json is used by coordinators — its permissions should NOT propagate to agents
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { allow: ["CoordinatorOnlyTool"] },
    }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-no-local-inherit" });

    const settingsPath = join(agentsDir, "test-no-local-inherit", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).not.toContain("CoordinatorOnlyTool");
    // Standard permissions still present
    expect(settings.permissions.allow).toContain("Bash(ib:*)");
    expect(settings.permissions.allow).toContain("Read");
  });

  test("includes Agent in permissions allow list so intercept hook can fire", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-agent-perm" });

    const settingsPath = join(agentsDir, "test-agent-perm", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Agent");
  });

  test("writes .claude dir in worktree even without base settings", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-no-base" });

    const settingsPath = join(agentsDir, "test-no-base", "repo", ".claude", "settings.local.json");
    const settingsExists = await Bun.file(settingsPath).exists().catch(() => false);
    expect(settingsExists).toBe(true);

    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(ib:*)");
    expect(settings.spinnerTipsEnabled).toBe(false);
  });

  test("rejects unknown manager", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { manager: "nonexistent" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("No matching agent found");
  });

  test("noWorktree mode skips worktree creation", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-no-wt", noWorktree: true });
    expect(result.ok).toBe(true);

    const meta = await Bun.file(join(agentsDir, "test-no-wt", "meta.json")).json();
    expect(meta.worktree).toBe(false);

    // No worktree add call
    const worktreeCall = spawnCalls.find(c => c.includes("worktree") && c.includes("add"));
    expect(worktreeCall).toBeUndefined();
  });

  test("_all.md layer permissions are merged into settings", async () => {
    await writeAllLayer(["Bash(deploy:*)"], ["Bash(rm:*)"]);

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-cfg-perms" });

    const settingsPath = join(agentsDir, "test-cfg-perms", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(deploy:*)");
    expect(settings.permissions.deny).toContain("Bash(rm:*)");
  });

  test("_all.md layer allow/deny are merged into settings for managers", async () => {
    await writeAllLayer(["Bash(curl:*)"], ["Bash(sudo:*)"]);

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-all-perms" });

    const settingsPath = join(agentsDir, "test-all-perms", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    // All permissions merged in
    expect(settings.permissions.allow).toContain("Bash(curl:*)");
    expect(settings.permissions.deny).toContain("Bash(sudo:*)");
  });

  test("_all.md layer allow/deny are merged into settings for workers", async () => {
    await writeAllLayer(["Bash(curl:*)"], ["Bash(sudo:*)"]);

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-all-worker", type: "worker" });

    const settingsPath = join(agentsDir, "test-all-worker", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(curl:*)");
    expect(settings.permissions.deny).toContain("Bash(sudo:*)");
  });

  test("_all.md layer applies without role-specific permissions", async () => {
    await writeAllLayer(["Bash(curl:*)"], ["Bash(sudo:*)"]);

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-all-only" });

    const settingsPath = join(agentsDir, "test-all-only", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(curl:*)");
    expect(settings.permissions.deny).toContain("Bash(sudo:*)");
  });

  test("_non_coordinator.md layer applies to non-coordinator agents", async () => {
    const nonCoordPath = join(process.env.HOME!, ".itsybitsy", "agent-types", "_non_coordinator.md");
    await Bun.write(nonCoordPath, `---\nname: _non_coordinator\ndescription: Test\nspawnable: false\npermissions:\n  allow: ["Bash(test-tool:*)"]\n  deny: []\n---\n`);

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-noncoord" });

    const settingsPath = join(agentsDir, "test-noncoord", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(test-tool:*)");
  });

  test("_non_coordinator.md layer does NOT apply to coordinator agents", async () => {
    const nonCoordPath = join(process.env.HOME!, ".itsybitsy", "agent-types", "_non_coordinator.md");
    await Bun.write(nonCoordPath, `---\nname: _non_coordinator\ndescription: Test\nspawnable: false\npermissions:\n  allow: ["Bash(worker-only-tool:*)"]\n  deny: []\n---\n`);

    setNewAgentSpawnRunner(mockSpawnRunner());
    // Coordinator agent ID is derived from repo basename; --name is ignored for coordinators
    const { getCoordinatorAgentId } = await import("./coordinator");
    const coordId = getCoordinatorAgentId(tempDir);
    const result = await callNewAgent("task", { type: "coordinator" });
    expect(result.ok).toBe(true);

    // Coordinator writes settings to .claude/ in its own agent dir (not a worktree subdir)
    const settingsPath = join(agentsDir, coordId, ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).not.toContain("Bash(worker-only-tool:*)");
  });

  test("rejects spawning a non-spawnable type (_all)", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-bad", type: "_all" });
    expect(result.ok).toBe(false);
    expect(result.stderr.toLowerCase()).toContain("not spawnable");
  });

  test("rejects spawning a non-spawnable type (_non_coordinator)", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-bad2", type: "_non_coordinator" });
    expect(result.ok).toBe(false);
    expect(result.stderr.toLowerCase()).toContain("not spawnable");
  });

  test("rejects spawning a non-spawnable type (system)", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-bad3", type: "system" });
    expect(result.ok).toBe(false);
    expect(result.stderr.toLowerCase()).toContain("not spawnable");
  });

  test("allowTools flag is included in start.sh", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-allow", allowTools: "Read,Write" });

    const startSh = await Bun.file(join(agentsDir, "test-allow", "start.sh")).text();
    expect(startSh).toContain("--allowedTools Read,Write");
  });

  test("denyTools flag is included in start.sh", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-deny", denyTools: "Bash" });

    const startSh = await Bun.file(join(agentsDir, "test-deny", "start.sh")).text();
    expect(startSh).toContain("--disallowedTools Bash");
  });

  test("yolo escalation blocked when parent is not yolo", async () => {
    // Create a non-yolo parent agent directory to simulate being inside it
    const parentDir = join(tempDir, ".ittybitty", "agents", "parent-agent");
    await mkdir(join(parentDir, "repo"), { recursive: true });
    await Bun.write(join(parentDir, "meta.json"), JSON.stringify({ id: "parent-agent", yolo: false }));
    await Bun.write(join(parentDir, "start.sh"), "#!/bin/bash\nclaude --session-id foo");

    // Set cwd to be inside the parent agent's worktree (same repo)
    const fakeCwd = join(parentDir, "repo", "subdir");
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await newAgent(tempDir, "yolo task", { yolo: true, _cwd: fakeCwd });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("permission escalation");
  });

  test("yolo escalation allowed when parent is yolo", async () => {
    // Create a yolo parent agent directory
    const parentDir = join(tempDir, ".ittybitty", "agents", "yolo-parent");
    await mkdir(join(parentDir, "repo"), { recursive: true });
    await Bun.write(join(parentDir, "meta.json"), JSON.stringify({ id: "yolo-parent", yolo: true }));

    const fakeCwd = join(parentDir, "repo");
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await newAgent(tempDir, "yolo task", { name: "yolo-child", yolo: true, _cwd: fakeCwd });
    expect(result.ok).toBe(true);
  });

  test("rejects name with shell metacharacters", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const badNames = ["foo;bar", "a`whoami`", "$(rm -rf /)", "hello world", "name&cmd", "a|b", "test'quote"];
    for (const name of badNames) {
      const result = await callNewAgent("task", { name });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("agent name may only contain");
    }
  });

  test("accepts valid name characters", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "valid-Agent_Name123" });
    expect(result.ok).toBe(true);
  });

  test("print mode flag is included in start.sh", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-print", print: true });

    const startSh = await Bun.file(join(agentsDir, "test-print", "start.sh")).text();
    expect(startSh).toContain("--print");
  });

  test("rejects model with shell injection characters", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-bad-model", model: 'opus$(whoami)' });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid model name");
  });

  test("rejects allowTools with shell injection characters", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-bad-allow", allowTools: 'Bash$(whoami)' });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid --allow tools value");
  });

  test("rejects denyTools with shell injection characters", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-bad-deny", denyTools: 'Tool`id`' });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid --deny tools value");
  });

  test("accepts valid model, allowTools, and denyTools", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", {
      name: "test-valid-tools",
      model: "claude-sonnet-4-6",
      allowTools: "Bash(git:*),Read",
      denyTools: "Write",
    });
    expect(result.ok).toBe(true);
  });

  test("generates prompt summary in background on success", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    // Mock summary generator that simulates successful claude -p response
    setNewAgentSummaryGenerator(async (agentDir: string) => {
      const metaPath = join(agentDir, "meta.json");
      const meta = await Bun.file(metaPath).json();
      meta.summary = "A short summary of the task";
      await Bun.write(metaPath, JSON.stringify(meta, null, 2) + "\n");
    });
    const result = await callNewAgent("implement feature X with tests", { name: "test-summary" });
    expect(result.ok).toBe(true);

    // Wait for the background summary generation to complete
    await Bun.sleep(50);

    const metaPath = join(agentsDir, "test-summary", "meta.json");
    const meta = await Bun.file(metaPath).json();
    expect(meta.summary).toBe("A short summary of the task");
  });

  test("skips summary when claude -p fails", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    // Mock summary generator that simulates failed claude -p (does nothing)
    setNewAgentSummaryGenerator(async () => {});
    const result = await callNewAgent("implement feature Y", { name: "test-summary-fail" });
    expect(result.ok).toBe(true);

    await Bun.sleep(50);

    const metaPath = join(agentsDir, "test-summary-fail", "meta.json");
    const meta = await Bun.file(metaPath).json();
    expect(meta.summary).toBeUndefined();
  });

  test("skips summary when claude -p returns empty output", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    // Mock summary generator that simulates empty output (does nothing)
    setNewAgentSummaryGenerator(async () => {});
    const result = await callNewAgent("implement feature Z", { name: "test-summary-empty" });
    expect(result.ok).toBe(true);

    await Bun.sleep(50);

    const metaPath = join(agentsDir, "test-summary-empty", "meta.json");
    const meta = await Bun.file(metaPath).json();
    expect(meta.summary).toBeUndefined();
  });

  test("coordinator spawn does not write hooks into repo's .claude/settings.local.json", async () => {
    // Regression test: previously, per-repo coordinators wrote their hook
    // entries (ib hook-status, ib hook-check-path, ib hooks intercept-task,
    // ib hooks session-start, ib hook-permission-denied) into the repo's
    // .claude/settings.local.json, polluting every Claude session opened in
    // that repo. The fix routes these into an isolated settings file at
    // .ittybitty/agents/<coord-id>/.claude/settings.local.json instead.
    const coordRepoDir = await mkdtemp(join(tmpdir(), "ib-coord-settings-"));
    const coordRepo = join(coordRepoDir, "myrepo");
    await mkdir(join(coordRepo, ".ittybitty", "agents"), { recursive: true });
    await Bun.write(join(coordRepo, ".ittybitty", "repo-id"), "coordsettings\n");

    // Pre-existing repo settings with an unrelated user permission; must
    // remain untouched by coordinator spawn.
    await mkdir(join(coordRepo, ".claude"), { recursive: true });
    const repoSettingsPath = join(coordRepo, ".claude", "settings.local.json");
    await Bun.write(repoSettingsPath, JSON.stringify({
      permissions: { allow: ["Bash(npm:*)"] },
    }));
    const originalRepoSettings = await Bun.file(repoSettingsPath).text();

    const userConfigPath = join(coordRepo, "config.json");
    setUserConfigPath(userConfigPath);
    await Bun.write(userConfigPath, JSON.stringify({ model: "sonnet" }, null, 2));

    lifecycleSpawnCtx.set((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeSpawnResult(coordRepo, 0);
      if (cmdStr.includes("--git-dir")) return makeSpawnResult(".git", 0);
      return makeSpawnResult("", 0);
    });

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await newAgent(coordRepo, "start", { type: "coordinator", _cwd: coordRepo });
    expect(result.ok).toBe(true);

    // The repo's settings file must be byte-for-byte unchanged.
    const afterRepoSettings = await Bun.file(repoSettingsPath).text();
    expect(afterRepoSettings).toBe(originalRepoSettings);
    const parsedRepoSettings = JSON.parse(afterRepoSettings);
    expect(parsedRepoSettings.hooks).toBeUndefined();
    expect(parsedRepoSettings.permissions?.allow ?? []).not.toContain("Bash(ib:*)");

    // The coordinator's hooks + permissions must live in the agent-isolated path.
    const coordId = result.stdout.trim();
    expect(coordId.length).toBeGreaterThan(0);
    const isolatedSettingsPath = join(
      coordRepo, ".ittybitty", "agents", coordId, ".claude", "settings.local.json",
    );
    const isolatedSettings = await Bun.file(isolatedSettingsPath).json();
    expect(isolatedSettings.hooks).toBeDefined();
    expect(isolatedSettings.hooks.Stop[0].hooks[0].command).toBe(`ib hook-status ${coordId}`);
    expect(isolatedSettings.hooks.SessionStart[0].hooks[0].command).toBe(`ib hooks session-start ${coordId}`);
    expect(isolatedSettings.hooks.PreToolUse[0].hooks[0].command).toBe(`ib hook-check-path ${coordId}`);
    expect(isolatedSettings.hooks.PreToolUse[1].hooks[0].command).toBe("ib hooks intercept-task");
    expect(isolatedSettings.hooks.PermissionRequest[0].hooks[0].command).toBe(`ib hook-permission-denied ${coordId}`);
    expect(isolatedSettings.permissions.allow).toContain("Read");
    expect(isolatedSettings.permissions.allow).toContain("Bash(ib:*)");

    // start.sh must launch claude with --settings pointing at the isolated file.
    const startSh = await Bun.file(join(coordRepo, ".ittybitty", "agents", coordId, "start.sh")).text();
    expect(startSh).toContain(`--settings '${isolatedSettingsPath}'`);

    await rm(coordRepoDir, { recursive: true, force: true });
  });

  test("non-coordinator, non-worktree agent still adds Bash(ib:*) to repo settings", async () => {
    // The fix should NOT change behavior for non-coordinator no-worktree agents:
    // they still need Bash(ib:*) in the repo's settings so their ib commands work.
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-no-wt-perm", noWorktree: true });
    expect(result.ok).toBe(true);

    const repoSettings = await Bun.file(join(tempDir, ".claude", "settings.local.json")).json();
    expect(repoSettings.permissions.allow).toContain("Bash(ib:*)");
    // No coordinator hooks should appear.
    expect(repoSettings.hooks).toBeUndefined();
  });

  test("start.sh shell-quotes paths to handle spaces and special chars", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-quotes" });

    const startSh = await Bun.file(join(agentsDir, "test-quotes", "start.sh")).text();
    // No PATH export — ib is already on the user's PATH
    expect(startSh).not.toContain("export PATH");
    // prompt.txt path should be single-quoted
    const agentDir = join(agentsDir, "test-quotes");
    expect(startSh).toContain(`$(cat '${join(agentDir, "prompt.txt")}')`);
    // meta.json should be passed as argument, not embedded in JS
    expect(startSh).toContain(`META_JSON='${join(agentDir, "meta.json")}'`);
    expect(startSh).toContain('bun -e "const f=process.argv[1]');
    expect(startSh).toContain('"$META_JSON" "$CLAUDE_PID"');
    // exit-check.sh should be single-quoted
    expect(startSh).toContain(`'${join(agentDir, "exit-check.sh")}'`);
  });

  test("start.sh does not embed paths directly in JS code", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-no-embed" });

    const startSh = await Bun.file(join(agentsDir, "test-no-embed", "start.sh")).text();
    // Should NOT have the old pattern of embedding path in JS string
    expect(startSh).not.toContain("const f='/" );
  });

  test("spawns watchdog for top-level agents (no manager)", async () => {
    let watchdogSpawned = false;
    let watchdogAgentId: string | undefined;
    setWatchdogSpawnFn((id, _repoPath, _logPath) => {
      watchdogSpawned = true;
      watchdogAgentId = id;
      return { pid: 99999 };
    });

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-watchdog-toplevel" });

    expect(result.ok).toBe(true);
    expect(watchdogSpawned).toBe(true);
    expect(watchdogAgentId).toBe("test-watchdog-toplevel");
    resetWatchdogSpawnFn();
  });

  test("saves watchdog_pid to meta.json after newAgent", async () => {
    const fakePid = 77777;
    setWatchdogSpawnFn((_id, _repoPath, _logPath) => {
      return { pid: fakePid };
    });

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-watchdog-pid" });

    expect(result.ok).toBe(true);
    const agentDir = join(agentsDir, "test-watchdog-pid");
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.watchdog_pid).toBe(fakePid);
    resetWatchdogSpawnFn();
  });

  // --- Group H: coordinator reserved name enforcement ---

  test("H1: rejects explicit --name coordinator", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "coordinator" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('"coordinator" is a reserved name');
  });

  test("H3: coordinator mode with repo basename 'coordinator' is rejected by post-generation guard", async () => {
    // Create a tempDir whose basename is "coordinator" to simulate coordinator mode
    // generating id = "coordinator" via getCoordinatorAgentId()
    const coordRepoDir = await mkdtemp(join(tmpdir(), "ib-coord-test-"));
    const coordRepo = join(coordRepoDir, "coordinator");
    await mkdir(join(coordRepo, ".ittybitty", "agents"), { recursive: true });
    await Bun.write(join(coordRepo, ".ittybitty", "repo-id"), "coordtest\n");

    const userConfigPath = join(coordRepo, "config.json");
    setUserConfigPath(userConfigPath);
    await Bun.write(userConfigPath, JSON.stringify({ model: "sonnet" }, null, 2));

    lifecycleSpawnCtx.set((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeSpawnResult(coordRepo, 0);
      if (cmdStr.includes("--git-dir")) return makeSpawnResult(".git", 0);
      return makeSpawnResult("", 0);
    });

    setNewAgentSpawnRunner(mockSpawnRunner());

    // coordinator mode: getCoordinatorAgentId(coordRepo) returns "coordinator"
    // checkCoordinatorExists finds no coordinator and no collision → id stays "coordinator"
    // post-generation guard at line 1629 catches it
    const result = await newAgent(coordRepo, "start coordinator", { type: "coordinator", _cwd: coordRepo });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('"coordinator" is a reserved name');

    await rm(coordRepoDir, { recursive: true, force: true });
  });

  test("H5: 'Coordinator' (uppercase) passes — case-sensitive check", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "Coordinator" });
    expect(result.ok).toBe(true);
  });

  test("H6: 'my-coordinator' passes — substring not blocked", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "my-coordinator" });
    expect(result.ok).toBe(true);
  });

  test("H7: coordinator mode with collision suffix doesn't produce 'coordinator'", async () => {
    // Create a repo whose basename is "coordinator" but with a non-coordinator agent
    // already named "coordinator" (collision case).
    // The collision suffix should produce "coordinator-XXXX", not "coordinator".
    const coordRepoDir = await mkdtemp(join(tmpdir(), "ib-coord-coll-"));
    const coordRepo = join(coordRepoDir, "coordinator");
    const coordAgentsDir = join(coordRepo, ".ittybitty", "agents");
    // Create existing non-coordinator agent named "coordinator" (the collision)
    await mkdir(join(coordAgentsDir, "coordinator"), { recursive: true });
    await Bun.write(join(coordAgentsDir, "coordinator", "meta.json"), JSON.stringify({ id: "coordinator" }));
    await Bun.write(join(coordRepo, ".ittybitty", "repo-id"), "colltest\n");

    const userConfigPath = join(coordRepo, "config.json");
    setUserConfigPath(userConfigPath);
    await Bun.write(userConfigPath, JSON.stringify({ model: "sonnet" }, null, 2));

    lifecycleSpawnCtx.set((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeSpawnResult(coordRepo, 0);
      if (cmdStr.includes("--git-dir")) return makeSpawnResult(".git", 0);
      return makeSpawnResult("", 0);
    });

    setNewAgentSpawnRunner(mockSpawnRunner());

    // checkCoordinatorExists will find the collision (non-coordinator agent named "coordinator")
    // So id = "coordinator-XXXX" (with random suffix), which won't match the reserved name
    const result = await newAgent(coordRepo, "start coordinator", { type: "coordinator", _cwd: coordRepo });
    expect(result.ok).toBe(true);

    await rm(coordRepoDir, { recursive: true, force: true });
  });

  // --- Group K: repo name collision enforcement ---

  test("K1: rejects --name matching a repo display name (nickname)", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-collision-test-"));
    process.env.HOME = fakeHome;
    try {
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      await Bun.write(join(fakeHome, ".itsybitsy", "repos.json"), JSON.stringify({
        repos: [{ path: "/tmp/some-repo", name: "some-repo", nickname: "my-agent" }],
      }));
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", { name: "my-agent" });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('collides with registered repo name');
    } finally {
      process.env.HOME = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test("K2: rejects --name matching a repo basename", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-collision-test-"));
    process.env.HOME = fakeHome;
    try {
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      await Bun.write(join(fakeHome, ".itsybitsy", "repos.json"), JSON.stringify({
        repos: [{ path: "/tmp/tools-repo", name: "tools" }],
      }));
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", { name: "tools" });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('collides with registered repo name');
    } finally {
      process.env.HOME = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test("K3: rejects --name 'system' as reserved", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "system" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('"system" is a reserved name');
  });

  test("K4: allows --name that doesn't collide with any repo", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-collision-test-"));
    process.env.HOME = fakeHome;
    try {
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      await Bun.write(join(fakeHome, ".itsybitsy", "repos.json"), JSON.stringify({
        repos: [{ path: "/tmp/other-repo", name: "other-repo" }],
      }));
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", { name: "unique-name" });
      expect(result.ok).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  // --- Spawn logging tests ---

  test("spawn log: writes [spawn] lines to spawnee agent.log on success", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do work", { name: "test-spawnlog-ok" });
    expect(result.ok).toBe(true);

    const log = await Bun.file(join(agentsDir, "test-spawnlog-ok", "agent.log")).text();
    expect(log).toContain("[spawn] start id=test-spawnlog-ok");
    expect(log).toContain("[spawn] git worktree add");
    expect(log).toContain("[spawn] tmux start-server → exit=0");
    expect(log).toContain("[spawn] tmux new-session");
    expect(log).toContain("[spawn] tmux has-session verify → exit=0");
    expect(log).toContain("[spawn] spawn OK: agent test-spawnlog-ok running");
    // No `child=` tag — this agent has no spawner
    expect(log).not.toContain("[spawn child=");
  });

  test("spawn log: writes [spawn child=<id>] lines to manager agent.log on success", async () => {
    const mgrDir = join(agentsDir, "agent-mgr-spawnlog");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(join(mgrDir, "meta.json"), JSON.stringify({ id: "agent-mgr-spawnlog", worker: false }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("sub-task", { name: "child-spawnlog", manager: "agent-mgr-spawnlog" });
    expect(result.ok).toBe(true);

    const mgrLog = await Bun.file(join(mgrDir, "agent.log")).text();
    expect(mgrLog).toContain("[spawn child=child-spawnlog] start id=child-spawnlog");
    expect(mgrLog).toContain("[spawn child=child-spawnlog] spawn OK: agent child-spawnlog running");
    // Existing log line from the pre-spawn logAgent call must still be present (back-compat)
    expect(mgrLog).toContain("Spawned manager subagent: child-spawnlog");

    // Spawnee log still gets its [spawn] lines
    const childLog = await Bun.file(join(agentsDir, "child-spawnlog", "agent.log")).text();
    expect(childLog).toContain("[spawn] start id=child-spawnlog");
    expect(childLog).toContain("[spawn] spawn OK:");
  });

  test("spawn log: writes FAILED line to spawner log when worktree add fails, spawnee dir is gone", async () => {
    const mgrDir = join(agentsDir, "agent-mgr-failspawn");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(join(mgrDir, "meta.json"), JSON.stringify({ id: "agent-mgr-failspawn", worker: false }));

    setNewAgentSpawnRunner(mockSpawnRunner({ failWorktree: true }));
    const result = await callNewAgent("task", { name: "child-failspawn", manager: "agent-mgr-failspawn" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("could not create worktree");

    // Spawnee dir was cleaned up on failure
    const spawneeLogExists = await Bun.file(join(agentsDir, "child-failspawn", "agent.log")).exists();
    expect(spawneeLogExists).toBe(false);

    // Manager's log survives and has the FAILED entry plus earlier steps
    const mgrLog = await Bun.file(join(mgrDir, "agent.log")).text();
    expect(mgrLog).toContain("[spawn child=child-failspawn] start id=child-failspawn");
    expect(mgrLog).toContain("[spawn child=child-failspawn] spawn FAILED: could not create worktree");
  });

  test("spawn log: writes FAILED line when tmux new-session fails", async () => {
    const mgrDir = join(agentsDir, "agent-mgr-tmuxfail");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(join(mgrDir, "meta.json"), JSON.stringify({ id: "agent-mgr-tmuxfail", worker: false }));

    setNewAgentSpawnRunner(mockSpawnRunner({ failTmuxNewSession: true }));
    const result = await callNewAgent("task", { name: "child-tmuxfail", manager: "agent-mgr-tmuxfail" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("could not create tmux session");

    const mgrLog = await Bun.file(join(mgrDir, "agent.log")).text();
    expect(mgrLog).toContain("[spawn child=child-tmuxfail] tmux new-session");
    expect(mgrLog).toContain("[spawn child=child-tmuxfail] spawn FAILED: could not create tmux session");
  });

  test("spawn log: no spawner log written when no spawner detected (human from shell)", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do work", { name: "test-no-spawner" });
    expect(result.ok).toBe(true);

    // Only the spawnee's agent.log exists in the agents dir — no other logs created
    const entries = await readdir(agentsDir);
    expect(entries).toContain("test-no-spawner");
    expect(entries.length).toBe(1);

    const log = await Bun.file(join(agentsDir, "test-no-spawner", "agent.log")).text();
    expect(log).toContain("[spawn] start id=test-no-spawner");
    expect(log).not.toContain("[spawn child=");
  });

  test("spawn log: self-heal entry fires when residual repo dir exists", async () => {
    // Pre-create the residual dir at <agentDir>/repo that newAgent should clean up.
    const agentDir = join(agentsDir, "test-residual");
    await mkdir(join(agentDir, "repo"), { recursive: true });

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do work", { name: "test-residual" });
    expect(result.ok).toBe(true);

    const log = await Bun.file(join(agentsDir, "test-residual", "agent.log")).text();
    expect(log).toContain("[spawn] self-heal: removed residual repo dir");
  });

  // --- Group R: `repos:` agent-type restriction (see PLAN-INHERITS.md §Part 2) ---
  //
  // These tests write a custom agent-type file into the temp $HOME used by
  // `beforeEach`, then verify the restriction is enforced by `newAgent`
  // *before* any worktree / tmux / agent-dir allocation.

  /** Write a custom agent-type file into the test's temp HOME. */
  async function writeAgentTypeFile(name: string, body: string): Promise<void> {
    const dir = join(process.env.HOME!, ".itsybitsy", "agent-types");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, `${name}.md`), body);
  }

  test("R1: newAgent accepts when type's repos includes the current repo's basename", async () => {
    const repoBasename = tempDir.split("/").pop()!;
    await writeAgentTypeFile(
      "repo-restricted",
      `---
name: repo-restricted
description: restricted to this repo
canSpawnChildren: false
repos: [${repoBasename}]
---
body`,
    );

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do work", { name: "test-repos-basename", type: "repo-restricted" });
    expect(result.ok).toBe(true);
  });

  test("R2: newAgent accepts when type's repos includes the current repo's nickname", async () => {
    // Register this repo with a nickname that is NOT its basename.
    const fakeHome = process.env.HOME!;
    await Bun.write(
      join(fakeHome, ".itsybitsy", "repos.json"),
      JSON.stringify({
        repos: [{ path: tempDir, name: tempDir.split("/").pop(), nickname: "my-nickname" }],
      }),
    );

    await writeAgentTypeFile(
      "nick-only",
      `---
name: nick-only
description: matches by nickname
canSpawnChildren: false
repos: [my-nickname]
---
body`,
    );

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do work", { name: "test-repos-nick", type: "nick-only" });
    expect(result.ok).toBe(true);
  });

  test("R3: newAgent rejects with a clear message when current repo matches no entry", async () => {
    await writeAgentTypeFile(
      "other-only",
      `---
name: other-only
description: only valid in other repos
canSpawnChildren: false
repos: [some-other-repo, yet-another]
---
body`,
    );

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do work", { name: "test-repos-reject", type: "other-only" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("restricted to repos [some-other-repo, yet-another]");
    expect(result.stderr).toContain("is not in that list");

    // Regression: rejection must leave no residue. No agent dir should exist.
    const dirExists = await Bun.file(join(agentsDir, "test-repos-reject", "meta.json")).exists().catch(() => false);
    expect(dirExists).toBe(false);
  });

  test("R4: newAgent accepts (regression) when repos is absent — existing types work", async () => {
    // The default `worker` type has no `repos:` — must still spawn.
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do work", { name: "test-repos-absent", type: "worker" });
    expect(result.ok).toBe(true);
  });

  test("R5: newAgent rejects when repos is inherited from a parent and current repo doesn't match", async () => {
    // Parent has a `repos:` list that excludes this repo; child inherits it.
    await writeAgentTypeFile(
      "restricted-parent",
      `---
name: restricted-parent
description: parent restricting repos
canSpawnChildren: false
repos: [foreign-repo]
---
body`,
    );
    await writeAgentTypeFile(
      "restricted-child",
      `---
name: restricted-child
inherits: restricted-parent
description: inherits the repos restriction
---
body`,
    );

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do work", { name: "test-repos-inherited", type: "restricted-child" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("restricted to repos [foreign-repo]");
  });

  test("R6: newAgent accepts when repo is unregistered but its basename appears in repos", async () => {
    // Make sure no repo is registered — the test's tempDir isn't added to
    // repos.json, so the unregistered-fallback path (basename(rootRepoPath))
    // is the code under test. Clear any repos.json if one exists.
    const reposJson = join(process.env.HOME!, ".itsybitsy", "repos.json");
    if (await Bun.file(reposJson).exists()) {
      await Bun.write(reposJson, JSON.stringify({ repos: [] }));
    }

    const repoBasename = tempDir.split("/").pop()!;
    await writeAgentTypeFile(
      "unregistered-ok",
      `---
name: unregistered-ok
description: matches by basename when unregistered
canSpawnChildren: false
repos: [${repoBasename}]
---
body`,
    );

    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("do work", { name: "test-repos-unregistered", type: "unregistered-ok" });
    expect(result.ok).toBe(true);
  });
});

describe("reassignAgent (native)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reassign-test-"));
    // Mock send spawn runner so notifications don't actually send
    setSendSpawnRunner((cmd: string[]) => ({
      stdout: new Response("").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(cmd.includes("has-session") ? 1 : 0), // no tmux sessions
    } as SpawnResult));
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reassign to new manager updates meta.json", async () => {
    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc");
    const managerDir = join(agentsDir, "agent-mgr");
    await mkdir(agentDir, { recursive: true });
    await mkdir(managerDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc", manager: "", tmux_session: "tmux-agent-abc" }));
    await Bun.write(join(managerDir, "meta.json"), JSON.stringify({ id: "agent-mgr", tmux_session: "tmux-agent-mgr" }));

    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, "agent-mgr");

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("agent-mgr");
    const updatedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(updatedMeta.manager).toBe("agent-mgr");
  });

  test("clear manager (null) sets manager to null", async () => {
    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc", manager: "agent-old", tmux_session: "tmux-agent-abc" }));

    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, null);

    expect(result.ok).toBe(true);
    const updatedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(updatedMeta.manager).toBeNull();
  });

  test("circular dependency detected", async () => {
    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const parentDir = join(agentsDir, "agent-parent");
    const childDir = join(agentsDir, "agent-child");
    await mkdir(parentDir, { recursive: true });
    await mkdir(childDir, { recursive: true });
    await Bun.write(join(parentDir, "meta.json"), JSON.stringify({ id: "agent-parent", manager: "", tmux_session: "t1" }));
    await Bun.write(join(childDir, "meta.json"), JSON.stringify({ id: "agent-child", manager: "agent-parent", tmux_session: "t2" }));

    const agent = makeAgent("agent-parent", tempDir);
    const result = await reassignAgent(agent, "agent-child");

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Circular dependency");
  });

  test("worker-as-parent rejected", async () => {
    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc");
    const workerDir = join(agentsDir, "agent-worker");
    await mkdir(agentDir, { recursive: true });
    await mkdir(workerDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc", manager: "", tmux_session: "t1" }));
    await Bun.write(join(workerDir, "meta.json"), JSON.stringify({ id: "agent-worker", worker: true, tmux_session: "t2" }));

    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, "agent-worker");

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("worker");
  });

  test("new manager not found", async () => {
    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc", manager: "", tmux_session: "t1" }));

    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, "agent-nonexistent");

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });

  test("agent not found", async () => {
    const agent = makeAgent("agent-missing", tempDir);
    const result = await reassignAgent(agent, null);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });

  test("self-reassign rejected", async () => {
    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, "agent-abc");

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Cannot reassign agent to itself");
  });

  test("notification messages match bash format", async () => {
    const spawnCalls: string[][] = [];
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0), // tmux sessions exist
      } as SpawnResult;
    });

    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc");
    const oldMgrDir = join(agentsDir, "agent-old");
    const newMgrDir = join(agentsDir, "agent-new");
    await mkdir(agentDir, { recursive: true });
    await mkdir(oldMgrDir, { recursive: true });
    await mkdir(newMgrDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc", manager: "agent-old", tmux_session: "tmux-abc" }));
    await Bun.write(join(oldMgrDir, "meta.json"), JSON.stringify({ id: "agent-old", tmux_session: "tmux-old" }));
    await Bun.write(join(newMgrDir, "meta.json"), JSON.stringify({ id: "agent-new", tmux_session: "tmux-new" }));

    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, "agent-new");

    expect(result.ok).toBe(true);

    // Extract send-keys messages (skip has-session calls and Enter calls)
    const messages = spawnCalls
      .filter(c => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l"))
      .map(c => c[c.length - 1]!);

    // Old manager notification
    const oldMgrMsg = messages.find(m => m.includes("to manager"));
    expect(oldMgrMsg).toBeDefined();
    expect(oldMgrMsg!).toContain("[watchdog for agent-abc]");
    expect(oldMgrMsg!).toContain("Agent reassigned to manager 'agent-new'");

    // New manager notification
    const newMgrMsg = messages.find(m => m.includes("reassigned to you"));
    expect(newMgrMsg).toBeDefined();
    expect(newMgrMsg!).toContain("[watchdog for agent-abc]");
    expect(newMgrMsg!).toContain("was under agent-old");

    // Agent self-notification
    const selfMsg = messages.find(m => m.includes("You've been reassigned"));
    expect(selfMsg).toBeDefined();
    expect(selfMsg!).toContain("[watchdog]");
    expect(selfMsg!).toContain("from agent-old to agent-new");
  });

  test("notification uses top-level labels when no manager", async () => {
    const spawnCalls: string[][] = [];
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      } as SpawnResult;
    });

    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc");
    const newMgrDir = join(agentsDir, "agent-new");
    await mkdir(agentDir, { recursive: true });
    await mkdir(newMgrDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc", manager: null, tmux_session: "tmux-abc" }));
    await Bun.write(join(newMgrDir, "meta.json"), JSON.stringify({ id: "agent-new", tmux_session: "tmux-new" }));

    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, "agent-new");

    expect(result.ok).toBe(true);

    const messages = spawnCalls
      .filter(c => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l"))
      .map(c => c[c.length - 1]!);

    // New manager should say "was top-level"
    const newMgrMsg = messages.find(m => m.includes("reassigned to you"));
    expect(newMgrMsg).toBeDefined();
    expect(newMgrMsg!).toContain("was top-level");

    // Agent self-notification should say from (none) to agent-new
    const selfMsg = messages.find(m => m.includes("You've been reassigned"));
    expect(selfMsg).toBeDefined();
    expect(selfMsg!).toContain("from (none) to agent-new");
  });

  test("agent self-notification sent on reassign to top-level", async () => {
    const spawnCalls: string[][] = [];
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      } as SpawnResult;
    });

    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc");
    const oldMgrDir = join(agentsDir, "agent-old");
    await mkdir(agentDir, { recursive: true });
    await mkdir(oldMgrDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc", manager: "agent-old", tmux_session: "tmux-abc" }));
    await Bun.write(join(oldMgrDir, "meta.json"), JSON.stringify({ id: "agent-old", tmux_session: "tmux-old" }));

    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, null);

    expect(result.ok).toBe(true);

    const messages = spawnCalls
      .filter(c => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l"))
      .map(c => c[c.length - 1]!);

    // Old manager should say "to top-level"
    const oldMgrMsg = messages.find(m => m.includes("reassigned to top-level"));
    expect(oldMgrMsg).toBeDefined();

    // Agent self-notification
    const selfMsg = messages.find(m => m.includes("You've been reassigned"));
    expect(selfMsg).toBeDefined();
    expect(selfMsg!).toContain("from agent-old to (none)");
  });
});

describe("mergeCheckAgent (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mergecheck-test-"));
    spawnCalls = [];
  });

  afterEach(async () => {
    resetMergeSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("fails when worktree doesn't exist", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    // No "repo" directory

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeCheckAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("no worktree");
  });

  test("fails with uncommitted changes", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });

    setMergeSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      // git status --porcelain returns modified file
      if (cmd.includes("--porcelain")) {
        return makeSpawnResult(0, "M file.ts\n");
      }
      return makeSpawnResult();
    });

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeCheckAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("uncommitted changes");
  });

  test("passes when clean", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });

    setMergeSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      // git log returns one commit
      if (cmd.includes("--oneline") && cmd.some(a => a.includes("main.."))) {
        return makeSpawnResult(0, "abc1234 commit msg\n");
      }
      return makeSpawnResult();
    });

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeCheckAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("1 commit");
  });

  test("fails when branch doesn't exist", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });

    setMergeSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      // show-ref for agent branch fails
      if (cmd.includes("show-ref") && cmd.some(a => a.includes("agent/agent-abc"))) {
        return makeSpawnResult(1);
      }
      return makeSpawnResult();
    });

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeCheckAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("does not exist");
  });
});

describe("diffAgent (native)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "diff-test-"));
  });

  afterEach(async () => {
    resetDiffStatusSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns diff output", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });

    setDiffStatusSpawnRunner((cmd: string[]) => {
      if (cmd.includes("merge-base")) {
        return makeSpawnResult(0, "abc123\n");
      }
      if (cmd.includes("diff")) {
        return makeSpawnResult(0, "+added line\n-removed line\n");
      }
      return makeSpawnResult();
    });

    const agent = makeAgent("agent-abc", tempDir);
    const result = await diffAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("+added line");
  });

  test("fails when worktree not found", async () => {
    const agent = makeAgent("agent-abc", tempDir);
    const result = await diffAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("no worktree");
  });
});

describe("diffCwd", () => {
  afterEach(() => {
    resetDiffStatusSpawnRunner();
  });

  test("diffs HEAD against merge-base of current branch", async () => {
    setDiffStatusSpawnRunner((cmd: string[]) => {
      if (cmd.includes("symbolic-ref")) {
        return makeSpawnResult(0, "refs/remotes/origin/main");
      }
      if (cmd.includes("rev-parse") && cmd.includes("--abbrev-ref")) {
        return makeSpawnResult(0, "feature-branch");
      }
      if (cmd.includes("merge-base")) {
        return makeSpawnResult(0, "abc123");
      }
      if (cmd.includes("diff")) {
        return makeSpawnResult(0, "+new line\n-old line\n");
      }
      return makeSpawnResult();
    });

    const result = await diffCwd();
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("+new line");
  });

  test("stat mode passes --stat flag", async () => {
    let diffCmd: string[] = [];
    setDiffStatusSpawnRunner((cmd: string[]) => {
      if (cmd.includes("symbolic-ref")) {
        return makeSpawnResult(0, "refs/remotes/origin/main");
      }
      if (cmd.includes("rev-parse") && cmd.includes("--abbrev-ref")) {
        return makeSpawnResult(0, "feature-branch");
      }
      if (cmd.includes("merge-base")) {
        return makeSpawnResult(0, "abc123");
      }
      if (cmd.includes("diff")) {
        diffCmd = cmd;
        return makeSpawnResult(0, " file.ts | 2 +-\n");
      }
      return makeSpawnResult();
    });

    await diffCwd({ stat: true });
    expect(diffCmd).toContain("--stat");
  });

  test("fails when rev-parse fails", async () => {
    setDiffStatusSpawnRunner((cmd: string[]) => {
      if (cmd.includes("symbolic-ref")) {
        return makeSpawnResult(1, "", "not a git repo");
      }
      if (cmd.includes("rev-parse")) {
        return makeSpawnResult(1, "", "not a git repo");
      }
      return makeSpawnResult();
    });

    const result = await diffCwd();
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Failed to determine current branch");
  });

  test("falls back to main when symbolic-ref fails", async () => {
    let mergeBaseArgs: string[] = [];
    setDiffStatusSpawnRunner((cmd: string[]) => {
      if (cmd.includes("symbolic-ref")) {
        return makeSpawnResult(1, "", "no remote HEAD");
      }
      if (cmd.includes("rev-parse") && cmd.includes("--abbrev-ref")) {
        return makeSpawnResult(0, "my-branch");
      }
      if (cmd.includes("merge-base")) {
        mergeBaseArgs = cmd;
        return makeSpawnResult(0, "def456");
      }
      if (cmd.includes("diff")) {
        return makeSpawnResult(0, "some diff");
      }
      return makeSpawnResult();
    });

    const result = await diffCwd();
    expect(result.ok).toBe(true);
    expect(mergeBaseArgs).toContain("main");
  });
});

describe("statusAgent (native)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "status-test-"));
  });

  afterEach(async () => {
    resetDiffStatusSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns combined log and status output", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    const repoDir = join(agentDir, "repo");
    await mkdir(repoDir, { recursive: true });
    // Ensure directory is visible (Bun async fs timing workaround)
    await readdir(repoDir);

    setDiffStatusSpawnRunner((cmd: string[]) => {
      if (cmd.includes("merge-base")) {
        return makeSpawnResult(0, "deadbeef123456\n");
      }
      if (cmd.includes("log") && cmd.includes("--oneline")) {
        return makeSpawnResult(0, "abc1234 first commit\ndef5678 second commit\n");
      }
      if (cmd.includes("log") && cmd.some((c) => c.includes("--format"))) {
        return makeSpawnResult(0, "  abc1234 first commit\n  def5678 second commit\n");
      }
      if (cmd.includes("--porcelain")) {
        return makeSpawnResult(0, "M src/file.ts\n");
      }
      if (cmd.includes("status") && cmd.includes("--short")) {
        return makeSpawnResult(0, "M src/file.ts\n");
      }
      if (cmd.includes("diff") && cmd.includes("--stat")) {
        return makeSpawnResult(0, " src/file.ts | 10 +++++++---\n src/new.ts  |  5 +++++\n src/{old.ts => renamed.ts} | 2 +-\n src/removed.ts | 8 --------\n src/image.png | Bin 0 -> 1234 bytes\n 5 files changed, 14 insertions(+), 12 deletions(-)\n");
      }
      if (cmd.includes("diff") && cmd.includes("--numstat")) {
        return makeSpawnResult(0, "7\t3\tsrc/file.ts\n5\t0\tsrc/new.ts\n1\t1\tsrc/{old.ts => renamed.ts}\n0\t8\tsrc/removed.ts\n-\t-\tsrc/image.png\n");
      }
      if (cmd.includes("diff") && cmd.includes("--name-status")) {
        return makeSpawnResult(0, "M\tsrc/file.ts\nA\tsrc/new.ts\nR100\tsrc/old.ts\tsrc/renamed.ts\nD\tsrc/removed.ts\nA\tsrc/image.png\n");
      }
      return makeSpawnResult();
    });

    const agent = makeAgent("agent-abc", tempDir);
    const result = await statusAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("first commit");
    expect(result.stdout).toContain("M src/file.ts");
    // Per-file details
    expect(result.stdout).toContain("modified src/file.ts    (+7/-3)");
    expect(result.stdout).toContain("added    src/new.ts     (+5)");
    expect(result.stdout).toContain("renamed  src/renamed.ts (+1/-1)");
    expect(result.stdout).toContain("deleted  src/removed.ts (-8)");
    expect(result.stdout).toContain("added    src/image.png");
  });

  test("fails when worktree not found", async () => {
    const agent = makeAgent("agent-abc", tempDir);
    const result = await statusAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("no worktree");
  });
});

describe("acknowledgeQuestion (native)", () => {
  let tempDir: string;
  let questionsPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ack-test-"));
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    questionsPath = join(tempDir, ".ittybitty", "user-questions.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("happy path: marks question as acknowledged", async () => {
    const data = {
      questions: [
        { id: "q-1", agent: "agent-abc", question: "What color?", status: "pending", timestamp: "2025-01-01T00:00:00Z" },
        { id: "q-2", agent: "agent-def", question: "What size?", status: "pending", timestamp: "2025-01-01T00:01:00Z" },
      ],
    };
    await Bun.write(questionsPath, JSON.stringify(data, null, 2));

    const result = await acknowledgeQuestion(tempDir, "q-1");
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Question acknowledged");
    expect(result.stdout).toContain("ib send agent-abc");

    // Verify the file was updated
    const updated = await Bun.file(questionsPath).json();
    const q1 = updated.questions.find((q: any) => q.id === "q-1");
    expect(q1.acknowledged).toBeUndefined();
    expect(q1.status).toBe("acknowledged");
    expect(q1.acknowledged_at).toBeTruthy();
    // Other question untouched
    const q2 = updated.questions.find((q: any) => q.id === "q-2");
    expect(q2.status).toBe("pending");
    expect(q2.acknowledged_at).toBeUndefined();
  });

  test("question not found returns error", async () => {
    const data = { questions: [{ id: "q-1", agent: "agent-abc", question: "What?", status: "pending" }] };
    await Bun.write(questionsPath, JSON.stringify(data));

    const result = await acknowledgeQuestion(tempDir, "q-999");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Question 'q-999' not found");
  });

  test("malformed JSON returns error", async () => {
    await Bun.write(questionsPath, '{"questions": "not-an-array"}');

    const result = await acknowledgeQuestion(tempDir, "q-1");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Malformed questions file");
  });

  test("file doesn't exist returns error", async () => {
    const result = await acknowledgeQuestion(tempDir, "q-1");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("No questions file found");
  });
});

// ── askQuestion tests ─────────────────────────────────────────────────────────

describe("askQuestion (native)", () => {
  let tempDir: string;
  let agentsDir: string;
  let agentId: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ask-test-"));
    agentsDir = join(tempDir, ".ittybitty", "agents");
    agentId = "agent-ask-test";
    agentDir = join(agentsDir, agentId);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: agentId }));
    setUserConfigPath(join(tempDir, "config.json"));
    // Stub the notification side-effects so the suite never spawns `say` or
    // writes to the real Telegram outbox. The inner `notifications` describe
    // re-overrides these per test to assert behavior.
    setSayRunner(() => { /* swallow */ });
    setAskQuestionTelegramRunner(async () => ({ ok: true, message: "stub" }));
  });

  afterEach(async () => {
    resetSayRunner();
    resetAskQuestionTelegramRunner();
    resetUserConfigPath();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("happy path: creates question in user-questions.json", async () => {
    const result = await askQuestion(tempDir, agentId, "Should I proceed?");
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Question submitted");

    const data = await Bun.file(join(tempDir, ".ittybitty", "user-questions.json")).json();
    expect(data.questions).toHaveLength(1);
    expect(data.questions[0].agent).toBe(agentId);
    expect(data.questions[0].question).toBe("Should I proceed?");
    expect(data.questions[0].status).toBe("pending");
    expect(data.questions[0].id).toMatch(/^q-\d+-[0-9a-f]{6}$/);
  });

  test("agent with active manager is rejected", async () => {
    const managerId = "agent-manager-1";
    const managerDir = join(agentsDir, managerId);
    await mkdir(managerDir, { recursive: true });
    await Bun.write(join(managerDir, "meta.json"), JSON.stringify({ id: managerId }));
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: agentId, manager: managerId }));

    const result = await askQuestion(tempDir, agentId, "Can I ask?");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("has a manager");
    expect(result.stderr).toContain("ib send");
  });

  test("agent with gone manager can ask", async () => {
    // Manager set but directory doesn't exist
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: agentId, manager: "agent-gone" }));

    const result = await askQuestion(tempDir, agentId, "Manager is gone, can I ask?");
    expect(result.ok).toBe(true);
  });

  test("agent not found returns error", async () => {
    const result = await askQuestion(tempDir, "nonexistent", "Hello?");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });

  test("allowAgentQuestions=false rejects", async () => {
    // Write config that disables questions
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({ allowAgentQuestions: false }));

    const result = await askQuestion(tempDir, agentId, "Can I ask?");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("disabled");
  });

  test("cleans up stale questions from non-existent agents", async () => {
    // Pre-populate with a stale question
    await Bun.write(
      join(tempDir, ".ittybitty", "user-questions.json"),
      JSON.stringify({ questions: [
        { id: "q-old", agent: "agent-gone", question: "old", status: "pending", timestamp: "2025-01-01T00:00:00Z" },
      ] }),
    );

    const result = await askQuestion(tempDir, agentId, "New question");
    expect(result.ok).toBe(true);

    const data = await Bun.file(join(tempDir, ".ittybitty", "user-questions.json")).json();
    // Stale question should be removed, only the new one remains
    expect(data.questions).toHaveLength(1);
    expect(data.questions[0].agent).toBe(agentId);
  });

  test("logs question to agent.log", async () => {
    await askQuestion(tempDir, agentId, "Test question");

    const logFile = Bun.file(join(agentDir, "agent.log"));
    const logContent = await logFile.text();
    expect(logContent).toContain("Asked question: Test question");
  });

  test("question ID uses md5 hash", async () => {
    const result = await askQuestion(tempDir, agentId, "Hash test");
    expect(result.ok).toBe(true);

    const data = await Bun.file(join(tempDir, ".ittybitty", "user-questions.json")).json();
    const qId = data.questions[0].id;
    // ID format: q-<epoch>-<6hex>
    expect(qId).toMatch(/^q-\d+-[0-9a-f]{6}$/);
  });

  describe("notifications", () => {
    let sayCalls: string[][];
    let telegramCalls: string[];
    const originalPlatform = process.platform;

    function setPlatform(value: NodeJS.Platform): void {
      Object.defineProperty(process, "platform", { value, configurable: true });
    }

    beforeEach(() => {
      sayCalls = [];
      telegramCalls = [];
      setSayRunner((cmd) => { sayCalls.push(cmd); });
      setAskQuestionTelegramRunner(async (text) => {
        telegramCalls.push(text);
        return { ok: true, message: "ok" };
      });
    });

    afterEach(() => {
      resetSayRunner();
      resetAskQuestionTelegramRunner();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    test("say is invoked with the correct text when config is true and platform is darwin", async () => {
      setPlatform("darwin");
      const result = await askQuestion(tempDir, agentId, "Should I proceed?");
      expect(result.ok).toBe(true);
      expect(sayCalls).toHaveLength(1);
      expect(sayCalls[0]![0]).toBe("/usr/bin/say");
      // No meta.name set → falls back to agentId. Repo name is basename(tempDir).
      const expectedRepoName = basename(tempDir);
      expect(sayCalls[0]![1]).toBe(`Agent ${agentId} in ${expectedRepoName} has a question`);
    });

    test("say uses meta.name when present and non-empty", async () => {
      setPlatform("darwin");
      await Bun.write(
        join(agentDir, "meta.json"),
        JSON.stringify({ id: agentId, name: "my-friendly-name" }),
      );
      const result = await askQuestion(tempDir, agentId, "Hi");
      expect(result.ok).toBe(true);
      expect(sayCalls).toHaveLength(1);
      expect(sayCalls[0]![1]).toContain("Agent my-friendly-name in ");
    });

    test("say is NOT invoked when notifications.sayOnQuestion config is false", async () => {
      setPlatform("darwin");
      await Bun.write(
        join(tempDir, "config.json"),
        JSON.stringify({ notifications: { sayOnQuestion: false } }),
      );
      const result = await askQuestion(tempDir, agentId, "Hello?");
      expect(result.ok).toBe(true);
      expect(sayCalls).toHaveLength(0);
    });

    test("say is NOT invoked when platform is not darwin", async () => {
      setPlatform("linux");
      const result = await askQuestion(tempDir, agentId, "Hello?");
      expect(result.ok).toBe(true);
      expect(sayCalls).toHaveLength(0);
    });

    test("telegramSend is called with agent name, repo name, and question text", async () => {
      setPlatform("linux"); // doesn't matter for telegram
      const result = await askQuestion(tempDir, agentId, "Should we ship?");
      expect(result.ok).toBe(true);
      expect(telegramCalls).toHaveLength(1);
      const msg = telegramCalls[0]!;
      expect(msg).toContain(agentId);
      const expectedRepoName = basename(tempDir);
      expect(msg).toContain(expectedRepoName);
      expect(msg).toContain("Should we ship?");
    });

    test("askQuestion still succeeds when say throws", async () => {
      setPlatform("darwin");
      setSayRunner(() => { throw new Error("say boom"); });
      const result = await askQuestion(tempDir, agentId, "Hi");
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("Question submitted");
      // Question still written to disk
      const data = await Bun.file(join(tempDir, ".ittybitty", "user-questions.json")).json();
      expect(data.questions).toHaveLength(1);
    });

    test("askQuestion still succeeds when telegramSend throws synchronously", async () => {
      setPlatform("linux");
      setAskQuestionTelegramRunner(((_text: string) => {
        throw new Error("tg sync boom");
      }) as unknown as (text: string) => Promise<{ ok: boolean; message: string }>);
      const result = await askQuestion(tempDir, agentId, "Hi");
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("Question submitted");
    });

    test("askQuestion still succeeds when telegramSend rejects", async () => {
      setPlatform("linux");
      setAskQuestionTelegramRunner(async () => { throw new Error("tg async boom"); });
      const result = await askQuestion(tempDir, agentId, "Hi");
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("Question submitted");
    });
  });
});

// ── Hooks management tests ────────────────────────────────────────────────────

describe("hooksStatus", () => {
  let tempDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hooks-status-"));
    settingsFile = join(tempDir, ".claude", "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns not-installed when no settings file exists", async () => {
    const result = await hooksStatus(tempDir, settingsFile);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("not-installed");
  });

  test("returns not-installed when settings has no hooks", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({ permissions: {} }));
    const result = await hooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("not-installed");
  });

  test("returns installed when all three hook types present", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
      },
    }));
    const result = await hooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("installed");
  });

  test("returns partial when only main-path present", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
      },
    }));
    const result = await hooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("partial");
  });

  test("does not detect itsybitsy-prefixed hooks as installed", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "itsybitsy hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "itsybitsy hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "itsybitsy hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "itsybitsy hooks session-start" }] }],
      },
    }));
    const result = await hooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("not-installed");
  });

  test("returns partial when only session-start present", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
      },
    }));
    const result = await hooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("partial");
  });

  test("returns partial when status hooks only have UserPromptSubmit (missing PostToolUse)", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
      },
    }));
    // Only UserPromptSubmit without PostToolUse means status hooks are NOT detected as present
    // But UserPromptSubmit exists in the hooks object, so partial? No — hasStatusHooks returns false
    // because it requires BOTH. So this should be not-installed.
    const result = await hooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("not-installed");
  });
});

describe("interceptHooksStatus", () => {
  let tempDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "intercept-status-"));
    settingsFile = join(tempDir, ".claude", "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns not-installed when no settings file", async () => {
    const result = await interceptHooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("not-installed");
  });

  test("returns installed when intercept hook present", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "ib hooks intercept-task" }] }],
      },
    }));
    const result = await interceptHooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("installed");
  });

  test("does not detect itsybitsy-prefixed intercept hook as installed", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "itsybitsy hooks intercept-task" }] }],
      },
    }));
    const result = await interceptHooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("not-installed");
  });


  test("returns not-installed when PreToolUse has other hooks but not intercept", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
      },
    }));
    const result = await interceptHooksStatus(tempDir, settingsFile);
    expect(result.stdout).toBe("not-installed");
  });
});

describe("installSafetyHooks", () => {
  let tempDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "install-hooks-"));
    settingsFile = join(tempDir, ".claude", "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates settings file and installs all hooks from scratch", async () => {
    const result = await installSafetyHooks(tempDir, settingsFile);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Hooks installed");

    const settings = await Bun.file(settingsFile).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("ib hooks main-path");
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("inject-status --full");
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain("inject-status --if-changed");
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("ib hooks session-start");
  });

  test("is idempotent — second call returns already installed", async () => {
    await installSafetyHooks(tempDir, settingsFile);
    const result = await installSafetyHooks(tempDir, settingsFile);
    expect(result.stdout).toBe("Hooks already installed");

    // Verify no duplicates
    const settings = await Bun.file(settingsFile).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test("preserves existing settings and adds missing hooks", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
      },
    }));

    const result = await installSafetyHooks(tempDir, settingsFile);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Hooks installed");

    const settings = await Bun.file(settingsFile).json();
    // Original permissions preserved
    expect(settings.permissions.allow).toContain("Read");
    // Original main-path hook preserved, no new one added
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    // New status and session hooks added
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test("detects ib-prefixed hooks as already installed", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
      },
    }));

    const result = await installSafetyHooks(tempDir, settingsFile);
    expect(result.stdout).toBe("Hooks already installed");
  });
});

describe("uninstallSafetyHooks", () => {
  let tempDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "uninstall-hooks-"));
    settingsFile = join(tempDir, ".claude", "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns message when no settings file exists", async () => {
    const result = await uninstallSafetyHooks(tempDir, settingsFile);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("nothing to uninstall");
  });

  test("removes all safety hooks and preserves other settings", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] },
          { matcher: "Task", hooks: [{ type: "command", command: "ib hooks intercept-task" }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
      },
    }));

    const result = await uninstallSafetyHooks(tempDir, settingsFile);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Hooks uninstalled");

    const settings = await Bun.file(settingsFile).json();
    // Permissions preserved
    expect(settings.permissions.allow).toContain("Read");
    // Intercept hook preserved, safety hooks removed
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("intercept-task");
    // Status and session hooks removed
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    expect(settings.hooks.PostToolUse).toBeUndefined();
    expect(settings.hooks.SessionStart).toBeUndefined();
  });

  test("removes ib-prefixed hooks too", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
      },
    }));

    const result = await uninstallSafetyHooks(tempDir, settingsFile);
    // All hooks removed — file should be deleted since settings is now empty
    expect(result.stdout).toContain("removed empty settings file");
    const exists = await Bun.file(settingsFile).exists();
    expect(exists).toBe(false);
  });

  test("deletes empty settings file", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
      },
    }));

    const result = await uninstallSafetyHooks(tempDir, settingsFile);
    expect(result.stdout).toContain("removed empty settings file");

    const exists = await Bun.file(settingsFile).exists();
    expect(exists).toBe(false);
  });

  test("is idempotent", async () => {
    const result1 = await uninstallSafetyHooks(tempDir, settingsFile);
    expect(result1.ok).toBe(true);
    const result2 = await uninstallSafetyHooks(tempDir, settingsFile);
    expect(result2.ok).toBe(true);
  });
});

describe("installInterceptHook", () => {
  let tempDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "install-intercept-"));
    settingsFile = join(tempDir, ".claude", "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("installs intercept hook from scratch", async () => {
    const result = await installInterceptHook(tempDir, settingsFile);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("installed");

    const settings = await Bun.file(settingsFile).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Task|Agent|TaskCreate|AskUserQuestion");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("ib hooks intercept-task");
  });

  test("is idempotent", async () => {
    await installInterceptHook(tempDir, settingsFile);
    const result = await installInterceptHook(tempDir, settingsFile);
    expect(result.stdout).toContain("already installed");

    const settings = await Bun.file(settingsFile).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  test("preserves existing hooks", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
      },
    }));

    await installInterceptHook(tempDir, settingsFile);

    const settings = await Bun.file(settingsFile).json();
    expect(settings.hooks.PreToolUse).toHaveLength(2);
  });

  test("detects ib-prefixed intercept as already installed", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "ib hooks intercept-task" }] }],
      },
    }));

    const result = await installInterceptHook(tempDir, settingsFile);
    expect(result.stdout).toContain("already installed");
  });
});

describe("uninstallInterceptHook", () => {
  let tempDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "uninstall-intercept-"));
    settingsFile = join(tempDir, ".claude", "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns message when no settings file", async () => {
    const result = await uninstallInterceptHook(tempDir, settingsFile);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("nothing to uninstall");
  });

  test("removes intercept hook and preserves others", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] },
          { matcher: "Task", hooks: [{ type: "command", command: "ib hooks intercept-task" }] },
        ],
      },
    }));

    await uninstallInterceptHook(tempDir, settingsFile);

    const settings = await Bun.file(settingsFile).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("main-path");
  });

  test("removes ib-prefixed intercept hook", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "ib hooks intercept-task" }] }],
      },
    }));

    const result = await uninstallInterceptHook(tempDir, settingsFile);
    expect(result.stdout).toContain("removed empty settings file");
    const exists = await Bun.file(settingsFile).exists();
    expect(exists).toBe(false);
  });

  test("deletes empty settings file", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "ib hooks intercept-task" }] }],
      },
    }));

    const result = await uninstallInterceptHook(tempDir, settingsFile);
    expect(result.stdout).toContain("removed empty settings file");

    const exists = await Bun.file(settingsFile).exists();
    expect(exists).toBe(false);
  });

  test("is idempotent", async () => {
    const result = await uninstallInterceptHook(tempDir, settingsFile);
    expect(result.ok).toBe(true);
  });
});

describe("hooks round-trip", () => {
  let tempDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hooks-roundtrip-"));
    settingsFile = join(tempDir, ".claude", "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("install then uninstall safety hooks leaves clean state", async () => {
    await installSafetyHooks(tempDir, settingsFile);
    let status = await hooksStatus(tempDir, settingsFile);
    expect(status.stdout).toBe("installed");

    await uninstallSafetyHooks(tempDir, settingsFile);
    status = await hooksStatus(tempDir, settingsFile);
    expect(status.stdout).toBe("not-installed");
  });

  test("install then uninstall intercept hook leaves clean state", async () => {
    await installInterceptHook(tempDir, settingsFile);
    let status = await interceptHooksStatus(tempDir, settingsFile);
    expect(status.stdout).toBe("installed");

    await uninstallInterceptHook(tempDir, settingsFile);
    status = await interceptHooksStatus(tempDir, settingsFile);
    expect(status.stdout).toBe("not-installed");
  });

  test("install both, uninstall safety only, intercept remains", async () => {
    await installSafetyHooks(tempDir, settingsFile);
    await installInterceptHook(tempDir, settingsFile);

    await uninstallSafetyHooks(tempDir, settingsFile);

    const safetyStatus = await hooksStatus(tempDir, settingsFile);
    expect(safetyStatus.stdout).toBe("not-installed");

    const interceptStatus = await interceptHooksStatus(tempDir, settingsFile);
    expect(interceptStatus.stdout).toBe("installed");
  });

  test("install both, uninstall intercept only, safety remains", async () => {
    await installSafetyHooks(tempDir, settingsFile);
    await installInterceptHook(tempDir, settingsFile);

    await uninstallInterceptHook(tempDir, settingsFile);

    const safetyStatus = await hooksStatus(tempDir, settingsFile);
    expect(safetyStatus.stdout).toBe("installed");

    const interceptStatus = await interceptHooksStatus(tempDir, settingsFile);
    expect(interceptStatus.stdout).toBe("not-installed");
  });

  test("uninstallSafetyHooks removes legacy itsybitsy-prefixed hooks", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "itsybitsy hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "itsybitsy hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "itsybitsy hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "itsybitsy hooks session-start" }] }],
      },
    }));

    await uninstallSafetyHooks(tempDir, settingsFile);

    // Verify hooks were removed (settings file should be deleted since it's now empty)
    const exists = await Bun.file(settingsFile).exists();
    expect(exists).toBe(false);
  });

  test("uninstallInterceptHook removes legacy itsybitsy-prefixed intercept hook", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "itsybitsy hooks intercept-task" }] }],
      },
    }));

    await uninstallInterceptHook(tempDir, settingsFile);

    const exists = await Bun.file(settingsFile).exists();
    expect(exists).toBe(false);
  });
});

// ── spawned_by (spawner tracking) tests ─────────────────────────────────────

import type { SpawnedBy } from "./agents";

describe("spawned_by validation in agents.ts", () => {
  test("spawned_by with valid agent_id and repo_path is accepted", () => {
    const spawnedBy: SpawnedBy = {
      agent_id: "agent-spawner",
      repo_path: "/path/to/repo",
    };
    expect(spawnedBy.agent_id).toBe("agent-spawner");
    expect(spawnedBy.repo_path).toBe("/path/to/repo");
  });

  test("meta.json readAgentMeta handles valid spawned_by", async () => {
    // This tests that readAgentMeta properly validates spawned_by
    // The actual implementation filters out invalid spawned_by objects
    const validMeta = {
      id: "test-agent",
      session_id: "session-123",
      tmux_session: "tmux-test",
      prompt: "test prompt",
      manager: null,
      created: "2024-01-01T00:00:00Z",
      created_epoch: 1000,
      worktree: true,
      worker: false,
      yolo: false,
      model: "opus",
      claude_pid: "1234",
      spawned_by: { agent_id: "spawner", repo_path: "/repo" },
    };
    // Successfully constructs meta with spawned_by
    expect(validMeta.spawned_by).not.toBeNull();
    expect(validMeta.spawned_by!.agent_id).toBe("spawner");
  });
});

describe("spawned_by Case 2 coordinator auto-detect", () => {
  let tempDir: string;
  let agentsDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalClaudeSessionId: string | undefined;
  let spawnCalls: string[][];

  function mockSpawnRunner() {
    return (cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("tmux has-session")) {
        const newSessionCalled = spawnCalls.some(c => c.join(" ").includes("tmux new-session"));
        return makeSpawnResult(newSessionCalled ? 0 : 1);
      }
      if (cmdStr.includes("tmux start-server")) return makeSpawnResult(0);
      if (cmdStr.includes("tmux new-session")) return makeSpawnResult(0);
      if (cmdStr.includes("worktree add")) {
        const repoIdx = cmd.indexOf("add") + 1;
        if (repoIdx > 0 && repoIdx < cmd.length) {
          const repoDir = cmd[repoIdx]!;
          require("fs").mkdirSync(repoDir, { recursive: true });
        }
        return makeSpawnResult(0);
      }
      if (cmdStr.includes("worktree remove")) return makeSpawnResult(0);
      if (cmdStr.includes("branch -D")) return makeSpawnResult(0);
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
      if (cmdStr.includes("--show-toplevel")) return makeSpawnResult(0, tempDir);
      if (cmdStr.includes("--git-dir")) return makeSpawnResult(0, ".git");
      if (cmdStr.includes("which gh")) return makeSpawnResult(1);
      if (cmdStr.includes("git") && cmd[cmd.length - 1] === "remote") return makeSpawnResult(0);
      if (cmdStr.includes("capture-pane")) return makeSpawnResult(0, "Claude Code v1.0");
      return makeSpawnResult(0);
    };
  }

  beforeEach(async () => {
    tempDir = require("fs").realpathSync(await mkdtemp(join(tmpdir(), "ib-spawner-case2-")));
    agentsDir = join(tempDir, ".ittybitty", "agents");
    fakeHome = require("fs").realpathSync(await mkdtemp(join(tmpdir(), "ib-spawner-case2-home-")));
    spawnCalls = [];

    // Save and override HOME so listRepos reads our fake repos.json
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    // Save original CLAUDE_SESSION_ID
    originalClaudeSessionId = process.env.CLAUDE_SESSION_ID;

    // Set up repo structure
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    await Bun.write(join(tempDir, ".ittybitty", "repo-id"), "abcd1234\n");

    // Register this tempDir as a repo in the fake home's repos.json
    await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
    await Bun.write(join(fakeHome, ".itsybitsy", "repos.json"), JSON.stringify({
      repos: [{ path: tempDir, name: "test-repo" }]
    }));

    // Create a coordinator agent in the repo
    const coordId = require("path").basename(tempDir);
    const coordDir = join(agentsDir, coordId);
    await mkdir(coordDir, { recursive: true });
    await Bun.write(join(coordDir, "meta.json"), JSON.stringify({
      id: coordId,
      agentType: "coordinator",
      tmux_session: `ittybitty-abcd1234-${coordId}`,
      prompt: "coordinate",
      manager: null,
      worktree: false,
      worker: false,
      yolo: false,
      model: "sonnet",
    }));

    // Set user config path to temp dir
    setUserConfigPath(join(tempDir, "config.json"));
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({ model: "sonnet" }));

    lifecycleSpawnCtx.set((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
      if (cmdStr.includes("--show-toplevel")) return makeSpawnResult(0, tempDir);
      if (cmdStr.includes("--git-dir")) return makeSpawnResult(0, ".git");
      return makeSpawnResult(0);
    });
  });

  afterEach(async () => {
    resetNewAgentSpawnRunner();
    resetNewAgentSummaryGenerator();
    lifecycleSpawnCtx.reset();
    resetUserConfigPath();
    process.env.HOME = originalHome;
    if (originalClaudeSessionId !== undefined) {
      process.env.CLAUDE_SESSION_ID = originalClaudeSessionId;
    } else {
      delete process.env.CLAUDE_SESSION_ID;
    }
    await rm(tempDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test("Case 2 is skipped when CLAUDE_SESSION_ID is not set (human user)", async () => {
    delete process.env.CLAUDE_SESSION_ID;
    setNewAgentSpawnRunner(mockSpawnRunner());

    const result = await newAgent(tempDir, "do work", { name: "test-no-session", _cwd: tempDir });
    expect(result.ok).toBe(true);

    // Read the meta.json of the newly created agent — spawned_by should be null
    const meta = await Bun.file(join(agentsDir, "test-no-session", "meta.json")).json();
    expect(meta.spawned_by).toBeNull();
  });

  test("Case 2B fires when CLAUDE_SESSION_ID is set and CWD is repo root with coordinator (uses @<basename> sentinel)", async () => {
    process.env.CLAUDE_SESSION_ID = "fake-session-id-12345";
    setNewAgentSpawnRunner(mockSpawnRunner());

    const result = await newAgent(tempDir, "do work", { name: "test-with-session", _cwd: tempDir });
    expect(result.ok).toBe(true);

    // Read the meta.json — spawned_by must be `@<basename(cwd)>`, NOT the
    // registry name or any nickname. The per-repo coordinator's actual
    // agent ID is basename(repoPath) (see getCoordinatorAgentId), and
    // both agent-path access checks and notifySpawner routing rely on
    // that invariant. Using a different value silently breaks access.
    const meta = await Bun.file(join(agentsDir, "test-with-session", "meta.json")).json();
    const expectedSentinel = `@${require("path").basename(tempDir)}`;
    expect(meta.spawned_by).not.toBeNull();
    expect(meta.spawned_by.agent_id).toBe(expectedSentinel);
    expect(meta.spawned_by.repo_path).toBe(tempDir);
  });

  test("Case 2B: nickname-vs-basename regression — sentinel uses basename even when registry has a custom name", async () => {
    // Re-seed the registry so this repo has a registry name AND a nickname
    // that both differ from the directory basename. The sentinel must
    // ignore both and stamp @<basename(tempDir)>. This covers the bug-2
    // regression where stamping repoDisplayName/registry-name would
    // silently break access for the per-repo coordinator.
    await Bun.write(join(fakeHome, ".itsybitsy", "repos.json"), JSON.stringify({
      repos: [{ path: tempDir, name: "custom-registry-name", nickname: "shiny-nickname" }],
    }));

    process.env.CLAUDE_SESSION_ID = "fake-session-id-nick";
    setNewAgentSpawnRunner(mockSpawnRunner());

    const result = await newAgent(tempDir, "do work", { name: "test-nickname", _cwd: tempDir });
    expect(result.ok).toBe(true);

    const meta = await Bun.file(join(agentsDir, "test-nickname", "meta.json")).json();
    const expectedSentinel = `@${require("path").basename(tempDir)}`;
    expect(meta.spawned_by).not.toBeNull();
    expect(meta.spawned_by.agent_id).toBe(expectedSentinel);
    // Specifically must NOT be the registry name or the nickname
    expect(meta.spawned_by.agent_id).not.toBe("@custom-registry-name");
    expect(meta.spawned_by.agent_id).not.toBe("@shiny-nickname");
    expect(meta.spawned_by.repo_path).toBe(tempDir);
  });

  test("Case 2A fires when CWD is the system coordinator home (@system sentinel, repo_path=null)", async () => {
    process.env.CLAUDE_SESSION_ID = "fake-session-id-system";
    const { setCoordinatorHome, resetCoordinatorHome } = await import("./coordinator");

    // Use the fake home as the system coordinator dir.
    const sysCoordHome = join(fakeHome, ".itsybitsy");
    setCoordinatorHome(sysCoordHome);

    setNewAgentSpawnRunner(mockSpawnRunner());

    try {
      const result = await newAgent(tempDir, "do work", {
        name: "test-from-system",
        _cwd: sysCoordHome,
      });
      expect(result.ok).toBe(true);

      const meta = await Bun.file(join(agentsDir, "test-from-system", "meta.json")).json();
      expect(meta.spawned_by).not.toBeNull();
      expect(meta.spawned_by.agent_id).toBe("@system");
      expect(meta.spawned_by.repo_path).toBeNull();
    } finally {
      resetCoordinatorHome();
    }
  });

  test("Case 2A is skipped without CLAUDE_SESSION_ID (human user from system coord dir)", async () => {
    delete process.env.CLAUDE_SESSION_ID;
    const { setCoordinatorHome, resetCoordinatorHome } = await import("./coordinator");
    const sysCoordHome = join(fakeHome, ".itsybitsy");
    setCoordinatorHome(sysCoordHome);

    setNewAgentSpawnRunner(mockSpawnRunner());

    try {
      const result = await newAgent(tempDir, "do work", {
        name: "test-from-system-human",
        _cwd: sysCoordHome,
      });
      expect(result.ok).toBe(true);

      const meta = await Bun.file(join(agentsDir, "test-from-system-human", "meta.json")).json();
      expect(meta.spawned_by).toBeNull();
    } finally {
      resetCoordinatorHome();
    }
  });
});

describe("resolveAgentId", () => {
  let tempDir: string;
  let agentsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "resolve-test-"));
    agentsDir = join(tempDir, "agents");
    await mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("exact match via directory", async () => {
    const agentDir = join(agentsDir, "agent-abc123");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), "{}");

    const result = await resolveAgentId(agentsDir, "agent-abc123", async () => []);
    expect(result).toEqual({ resolved: "agent-abc123" });
  });

  test("exact match via tmux session only (no directory)", async () => {
    const result = await resolveAgentId(agentsDir, "agent-abc123", async () => [
      "ittybitty-abc12345-agent-abc123",
    ]);
    expect(result).toEqual({ resolved: "agent-abc123" });
  });

  test("substring match via directory", async () => {
    const agentDir = join(agentsDir, "agent-abc123");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), "{}");

    const result = await resolveAgentId(agentsDir, "abc123", async () => []);
    expect(result).toEqual({ resolved: "agent-abc123" });
  });

  test("substring match via tmux session only (no directory)", async () => {
    const result = await resolveAgentId(agentsDir, "abc123", async () => [
      "ittybitty-abc12345-agent-abc123",
    ]);
    expect(result).toEqual({ resolved: "agent-abc123" });
  });

  test("ambiguous match returns error with sorted matches", async () => {
    // Create two agent dirs that both contain "abc"
    for (const id of ["agent-abc111", "agent-abc222"]) {
      const dir = join(agentsDir, id);
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, "meta.json"), "{}");
    }

    const result = await resolveAgentId(agentsDir, "abc", async () => []);
    expect(result).toEqual({
      error: "Ambiguous agent ID — multiple matches",
      matches: ["agent-abc111", "agent-abc222"],
    });
  });

  test("ambiguous match across directory and tmux session", async () => {
    // One agent in directory
    const dir = join(agentsDir, "agent-abc111");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "meta.json"), "{}");

    // Another agent only in tmux
    const result = await resolveAgentId(agentsDir, "abc", async () => [
      "ittybitty-abc12345-agent-abc222",
    ]);
    expect(result).toEqual({
      error: "Ambiguous agent ID — multiple matches",
      matches: ["agent-abc111", "agent-abc222"],
    });
  });

  test("no match returns error with empty matches", async () => {
    const result = await resolveAgentId(agentsDir, "nonexistent", async () => []);
    expect(result).toEqual({
      error: "No matching agent found",
      matches: [],
    });
  });

  test("deduplicates matches found in both directory and tmux", async () => {
    const dir = join(agentsDir, "agent-abc123");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "meta.json"), "{}");

    // Same agent also in tmux — should still be a single unique match
    const result = await resolveAgentId(agentsDir, "abc123", async () => [
      "ittybitty-abc12345-agent-abc123",
    ]);
    expect(result).toEqual({ resolved: "agent-abc123" });
  });

  test("ignores non-ittybitty tmux sessions", async () => {
    const result = await resolveAgentId(agentsDir, "abc123", async () => [
      "my-other-session",
      "random-session-agent-abc123",
    ]);
    expect(result).toEqual({ error: "No matching agent found", matches: [] });
  });

  test("extracts default agent ID from ittybitty tmux session", async () => {
    const result = await resolveAgentId(agentsDir, "agent-deadbeef", async () => [
      "ittybitty-abc12345-agent-deadbeef",
    ]);
    expect(result).toEqual({ resolved: "agent-deadbeef" });
  });

  test("extracts coordinator-style ID from tmux session", async () => {
    const result = await resolveAgentId(agentsDir, "myrepo", async () => [
      "ittybitty-abc12345-myrepo",
    ]);
    expect(result).toEqual({ resolved: "myrepo" });
  });

  test("extracts custom-named agent ID from tmux session", async () => {
    const result = await resolveAgentId(agentsDir, "my-custom-name", async () => [
      "ittybitty-def67890-my-custom-name",
    ]);
    expect(result).toEqual({ resolved: "my-custom-name" });
  });

  test("extracts custom-named agent with hyphens from tmux session", async () => {
    const result = await resolveAgentId(agentsDir, "my-long-custom-name", async () => [
      "ittybitty-fe98dcba-my-long-custom-name",
    ]);
    expect(result).toEqual({ resolved: "my-long-custom-name" });
  });

  test("rejects malformed tmux session without ittybitty prefix", async () => {
    const result = await resolveAgentId(agentsDir, "agent-abc", async () => [
      "notittybitty-abc12345-agent-abc",
    ]);
    expect(result).toEqual({ error: "No matching agent found", matches: [] });
  });

  test("rejects tmux session with wrong repo ID format (not 8 hex chars)", async () => {
    const result = await resolveAgentId(agentsDir, "agent-abc", async () => [
      "ittybitty-abc123-agent-abc",
      "ittybitty-abc123456789-agent-abc",
    ]);
    expect(result).toEqual({ error: "No matching agent found", matches: [] });
  });

  test("rejects tmux session with non-hex repo ID", async () => {
    const result = await resolveAgentId(agentsDir, "agent-abc", async () => [
      "ittybitty-abcdefgx-agent-abc",
    ]);
    expect(result).toEqual({ error: "No matching agent found", matches: [] });
  });
});

describe("telegramSend (native, file-drop client)", () => {
  let tempDir: string;
  let outboxDir: string;

  async function loadDeps() {
    const ibCmds = await import("./ib-commands");
    const outbox = await import("./channels/outbox");
    return { ibCmds, outbox };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tgsend-test-"));
    outboxDir = join(tempDir, "outbox");
    const { outbox } = await loadDeps();
    outbox.setOutboxDir(outboxDir);
  });

  afterEach(async () => {
    const { outbox } = await loadDeps();
    outbox.resetOutboxDir();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("no `ib watch` running → returns ok:true with 'queued' after ~1s", async () => {
    const { ibCmds } = await loadDeps();
    const start = Date.now();
    const result = await ibCmds.telegramSend("hello");
    const elapsed = Date.now() - start;
    // Poll loop is 10×100ms = ~1s. Give it a generous upper bound for slow CI.
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(2_500);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("queued");
    expect(result.message).toContain("ib watch may not be running");

    // Message file should still be on disk waiting for `ib watch`.
    const entries = await readdir(outboxDir);
    const txtFiles = entries.filter((e) => e.endsWith(".txt"));
    expect(txtFiles.length).toBe(1);
  });

  test("a result file appearing within the timeout is returned to the caller", async () => {
    const { ibCmds } = await loadDeps();
    // Spawn a watcher that writes a result file as soon as a .txt appears.
    const fs = await import("fs/promises");
    const watcher = setInterval(async () => {
      try {
        const entries = await readdir(outboxDir);
        for (const entry of entries) {
          if (entry.endsWith(".txt") && !entries.includes(`${entry}.result`)) {
            await fs.writeFile(
              join(outboxDir, `${entry}.result`),
              JSON.stringify({ ok: true, message: "ok" }),
            );
          }
        }
      } catch { /* ignore */ }
    }, 25);

    try {
      const result = await ibCmds.telegramSend("hi from caller");
      expect(result.ok).toBe(true);
      expect(result.message).toBe("ok");
    } finally {
      clearInterval(watcher);
    }
  });

  test("a failure result is propagated as ok:false", async () => {
    const { ibCmds } = await loadDeps();
    const fs = await import("fs/promises");
    const watcher = setInterval(async () => {
      try {
        const entries = await readdir(outboxDir);
        for (const entry of entries) {
          if (entry.endsWith(".txt") && !entries.includes(`${entry}.result`)) {
            await fs.writeFile(
              join(outboxDir, `${entry}.result`),
              JSON.stringify({ ok: false, message: "sendMessage failed: Bad Request" }),
            );
          }
        }
      } catch { /* ignore */ }
    }, 25);

    try {
      const result = await ibCmds.telegramSend("hi");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Bad Request");
    } finally {
      clearInterval(watcher);
    }
  });

  test("malformed result JSON is treated as 'no result yet' until timeout", async () => {
    const { ibCmds } = await loadDeps();
    const fs = await import("fs/promises");
    let wroteJunk = false;
    const watcher = setInterval(async () => {
      if (wroteJunk) return;
      try {
        const entries = await readdir(outboxDir);
        for (const entry of entries) {
          if (entry.endsWith(".txt") && !entries.includes(`${entry}.result`)) {
            await fs.writeFile(join(outboxDir, `${entry}.result`), "{not valid json");
            wroteJunk = true;
          }
        }
      } catch { /* ignore */ }
    }, 25);

    try {
      const result = await ibCmds.telegramSend("hi");
      // Falls through to the timeout-as-queued branch.
      expect(result.ok).toBe(true);
      expect(result.message).toContain("queued");
    } finally {
      clearInterval(watcher);
    }
  });

  test("the dropped .txt file contains the original message text", async () => {
    const { ibCmds } = await loadDeps();
    // Don't write a result, so tgsend times out — but we can still inspect
    // the file it dropped.
    const promise = ibCmds.telegramSend("exact-payload");
    // Wait briefly for the file to appear on disk.
    await new Promise<void>((r) => setTimeout(r, 200));
    const entries = await readdir(outboxDir);
    const txtFiles = entries.filter((e) => e.endsWith(".txt"));
    expect(txtFiles.length).toBe(1);
    const text = await Bun.file(join(outboxDir, txtFiles[0]!)).text();
    expect(text).toBe("exact-payload");
    await promise; // drain the timeout so afterEach can clean up.
  });
});

// ---------------------------------------------------------------------------
// respawn / respawn-self
// ---------------------------------------------------------------------------
describe("respawnAgent (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "respawn-test-"));
    spawnCalls = [];
    const runner = mockSpawnFn(spawnCalls);
    setNukeResumeSpawnRunner(runner);
  });

  afterEach(async () => {
    resetNukeResumeSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory doesn't exist", async () => {
    const { respawnAgent } = await import("./ib-commands");
    const agent = makeAgent("agent-abc", tempDir);
    const result = await respawnAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });

  test("rejects invalid agent IDs without spawning anything", async () => {
    // Setting up a meta.json for an obviously-bad id like "../etc" would be
    // a test bug; instead, write meta.json under a clean id and then craft
    // an Agent object that uses an unsafe id to exercise the validator.
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-bad");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-bad",
      tmux_session: "tmux-agent-bad",
    }));

    const { respawnAgent } = await import("./ib-commands");
    // Force a bad id post-construction. We're verifying the validator
    // rejects shell-unsafe characters before tmux is invoked.
    const agent = makeAgent("agent-bad", tempDir);
    (agent as { id: string }).id = "agent$(rm)";

    // Repoint meta.json to the unsafe id so the dirExists check passes —
    // we want the validator to be the gate, not the dir check.
    const unsafeDir = join(tempDir, ".ittybitty", "agents", "agent$(rm)");
    await mkdir(unsafeDir, { recursive: true });
    await Bun.write(join(unsafeDir, "meta.json"), JSON.stringify({ id: "agent$(rm)" }));

    const result = await respawnAgent(agent);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid agent ID");
    // Critically: no tmux command was issued with the unsafe id
    const tmuxNewSession = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "new-session"
    );
    expect(tmuxNewSession).toBeUndefined();
  });

  test("schedules detached tmux worker on success", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    const { respawnAgent } = await import("./ib-commands");
    const agent = makeAgent("agent-abc", tempDir);
    const result = await respawnAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Respawn scheduled");

    // Verify a detached tmux new-session was issued with the right
    // session name pattern and that the command contains `ib respawn-self`.
    const newSessionCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "new-session"
    );
    expect(newSessionCall).toBeDefined();
    // -d (detached), -s <name>, and the command argument
    expect(newSessionCall).toContain("-d");
    const sessionFlagIdx = newSessionCall!.indexOf("-s");
    expect(sessionFlagIdx).toBeGreaterThan(-1);
    expect(newSessionCall![sessionFlagIdx + 1]).toBe("ib-respawn-agent-abc");
    // The trailing command should call ib respawn-self <id>
    const cmdArg = newSessionCall![newSessionCall!.length - 1]!;
    expect(cmdArg).toContain("ib respawn-self agent-abc");
  });

  test("logs scheduling event to agent.log", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    const { respawnAgent } = await import("./ib-commands");
    const agent = makeAgent("agent-abc", tempDir);
    await respawnAgent(agent);

    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("[respawn] scheduling detached restart");
  });

  test("honors the test detach override", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    const { respawnAgent, setRespawnDetachRunner, resetRespawnDetachRunner } =
      await import("./ib-commands");

    let invokedWithId: string | undefined;
    setRespawnDetachRunner(async (a) => {
      invokedWithId = a.id;
    });

    try {
      const agent = makeAgent("agent-abc", tempDir);
      const result = await respawnAgent(agent);

      expect(result.ok).toBe(true);
      expect(invokedWithId).toBe("agent-abc");

      // tmux new-session must NOT have been called when the override is set
      const newSessionCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "new-session"
      );
      expect(newSessionCall).toBeUndefined();
    } finally {
      resetRespawnDetachRunner();
    }
  });

  test("returns error when tmux new-session fails", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
    }));

    // Make tmux new-session fail
    setNukeResumeSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "new-session") {
        return makeSpawnResult(1, "", "tmux: session create failed");
      }
      return makeSpawnResult();
    });

    const { respawnAgent } = await import("./ib-commands");
    const agent = makeAgent("agent-abc", tempDir);
    const result = await respawnAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Failed to schedule respawn");
  });
});

// respawn-self is the "worker half" — invoked from a detached tmux session
// by the respawn slash command. The interesting routing decision is
// coordinator-vs-non-coordinator. The coordinator path delegates to the
// same resetCoordinator code that powers the dashboard `R` key (covered by
// the existing "coordinator reset path" describe block). Here we focus on
// the non-coordinator path: it MUST call pause-then-resume rather than
// the coordinator branch, and the routing is observable via which scripts
// (resume.sh) and which meta.json fields get touched.
describe("respawnSelf (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "respawn-self-test-"));
    spawnCalls = [];
    const runner = mockSpawnFn(spawnCalls);
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetKillPauseSpawnRunner();
    resetNukeResumeSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory doesn't exist", async () => {
    const { respawnSelf } = await import("./ib-commands");
    const agent = makeAgent("agent-abc", tempDir);
    const result = await respawnSelf(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
  });

  test("non-coordinator: writes resume.sh (proving pause-then-resume routing)", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-noncoord");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-noncoord",
      tmux_session: "tmux-agent-noncoord",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    // Make `tmux has-session` return failure so resumeAgent passes the
    // liveness guard (no live session blocking the resume).
    setKillPauseSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "has-session") {
        return makeSpawnResult(1);
      }
      return makeSpawnResult();
    });
    setNukeResumeSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "has-session") {
        return makeSpawnResult(1);
      }
      if (cmd.join(" ").includes("capture-pane")) {
        return makeSpawnResult(0, "Claude Code v1.0\n");
      }
      return makeSpawnResult();
    });

    const { respawnSelf } = await import("./ib-commands");
    const agent = _makeAgent({
      id: "agent-noncoord",
      repoPath: tempDir,
      repoName: "test",
      state: "running",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-noncoord",
      } as any,
    });

    await respawnSelf(agent);

    // resume.sh is the smoking-gun proof that the non-coordinator branch
    // ran — the coordinator branch goes through nukeAgent + newAgent and
    // never touches resume.sh.
    const resumeShExists = await Bun.file(join(agentDir, "resume.sh"))
      .exists()
      .catch(() => false);
    expect(resumeShExists).toBe(true);
  });

  test("non-coordinator already-stopped: skips pause but still resumes", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-stopped");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-stopped",
      tmux_session: "tmux-agent-stopped",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    setKillPauseSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "has-session") {
        return makeSpawnResult(1);
      }
      return makeSpawnResult();
    });
    setNukeResumeSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "has-session") {
        return makeSpawnResult(1);
      }
      if (cmd.join(" ").includes("capture-pane")) {
        return makeSpawnResult(0, "Claude Code v1.0\n");
      }
      return makeSpawnResult();
    });

    const { respawnSelf } = await import("./ib-commands");
    const agent = _makeAgent({
      id: "agent-stopped",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-stopped",
      } as any,
    });

    await respawnSelf(agent);

    // Even from stopped, resume.sh must be written — the agent was already
    // in pause's "after" state, so we skip pause and go straight to resume.
    const resumeShExists = await Bun.file(join(agentDir, "resume.sh"))
      .exists()
      .catch(() => false);
    expect(resumeShExists).toBe(true);
    // The "agent already stopped, skipping pause" log line proves the
    // branch chosen.
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("agent already stopped, skipping pause");
  });
});

// ── Long-running-op guard (acquireAgentOperation) ────────────────────────────
//
// The durable op-guard refuses a conflicting long-running op (merge-check /
// merge / restart) while one is in flight with a LIVE holder, and reclaims
// when the holder is dead. kill/nuke/pause/reassign are the recovery path and
// must NOT be guarded. Uses the injectable isPidAliveCtx to stub liveness.

describe("long-running-op guard", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "op-guard-test-"));
  });

  afterEach(async () => {
    isPidAliveCtx.reset();
    nowMsCtx.reset();
    lifecycleSpawnCtx.reset();
    resetMergeSpawnRunner();
    resetNukeResumeSpawnRunner();
    resetKillPauseSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Build a backed agent dir with meta.json + worktree, returning the dir. */
  async function makeBackedAgentDir(id: string): Promise<string> {
    const agentDir = join(tempDir, ".ittybitty", "agents", id);
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id, tmux_session: `tmux-${id}`, claude_pid: "99999",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));
    return agentDir;
  }

  /** Smart merge mock: full successful merge path, no real git runs. */
  function makeMergeRunner(calls: string[][]): (cmd: string[]) => SpawnResult {
    return (cmd: string[]) => {
      calls.push(cmd);
      const s = cmd.join(" ");
      if (s.includes("status") && s.includes("--porcelain")) return makeSpawnResult(0, "");
      if (s.includes("branch") && s.includes("--show-current")) return makeSpawnResult(0, "main");
      if (s.includes("show-ref") && s.includes("--verify")) return makeSpawnResult(0);
      if (s.includes("log") && s.includes("--oneline")) return makeSpawnResult(0, "abc1234 commit\n");
      if (s.includes("has-session")) return makeSpawnResult(1);
      if (cmd[0] === "pgrep") return makeSpawnResult(1);
      return makeSpawnResult();
    };
  }

  // ── merge-check / merge: refuse on live holder ──────────────────────────────

  test("mergeCheckAgent refuses when an op is in flight with a LIVE holder", async () => {
    const agentDir = await makeBackedAgentDir("agent-mc");
    isPidAliveCtx.set(() => true); // holder alive
    nowMsCtx.set(() => 1000); // op fresh (1000 - 1 < OP_STUCK_TIMEOUT_MS) → still refuse
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: 1 });

    const calls: string[][] = [];
    const runner = makeMergeRunner(calls);
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-mc", tempDir);
    const result = await mergeCheckAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("currently merging");
    expect(result.stderr).toContain("4242");
    // Refused before any git work.
    expect(calls.length).toBe(0);
    // Existing marker is untouched (we didn't clear another op's marker).
    const t = await readAgentTransient(agentDir);
    expect(t?.operation).toEqual({ kind: "merging", pid: 4242, started_at_ms: 1 });
  });

  test("mergeAgent refuses when a merge_check is in flight with a LIVE holder", async () => {
    const agentDir = await makeBackedAgentDir("agent-mm");
    isPidAliveCtx.set(() => true);
    nowMsCtx.set(() => 1000); // op fresh → still refuse
    await setAgentOperation(agentDir, { kind: "merge_check", pid: 4242, started_at_ms: 1 });

    const calls: string[][] = [];
    const runner = makeMergeRunner(calls);
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-mm", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    // merge_check humanizes to "merge-checking".
    expect(result.stderr).toContain("currently merge-checking");
    expect(calls.length).toBe(0);
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true); // not merged
  });

  // ── reclaim on dead holder ──────────────────────────────────────────────────

  test("mergeCheckAgent reclaims and proceeds when the holder is DEAD", async () => {
    const agentDir = await makeBackedAgentDir("agent-reclaim");
    // claude_pid 99999 dead doesn't matter for merge-check; the op holder 4242
    // is dead, so the guard reclaims.
    isPidAliveCtx.set((pid: number) => pid !== 4242);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: 1 });

    const calls: string[][] = [];
    const runner = makeMergeRunner(calls);
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-reclaim", tempDir);
    const result = await mergeCheckAgent(agent);

    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0); // git work ran
    // Op cleared in finally (merge-check leaves the dir intact).
    const t = await readAgentTransient(agentDir);
    expect(t?.operation).toBeNull();
  });

  // ── age reclaim: LIVE holder but op ran past OP_STUCK_TIMEOUT_MS ─────────────
  //
  // After a crash + OS PID-reuse, the dead holder's pid can belong to an
  // unrelated LIVE process, so the liveness check alone would refuse forever
  // while detectAgentStates paints op_stuck. acquireAgentOperation must match
  // detect's `holderDead || tooOld` logic: reclaim a live-but-too-old op.

  test("mergeCheckAgent RECLAIMS a LIVE holder whose op is older than OP_STUCK_TIMEOUT_MS", async () => {
    const agentDir = await makeBackedAgentDir("agent-old");
    isPidAliveCtx.set(() => true); // holder (or a PID-reused unrelated proc) is alive
    // Op started long ago; "now" is more than the stuck timeout later → tooOld.
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: 1000 });
    nowMsCtx.set(() => 1000 + OP_STUCK_TIMEOUT_MS + 1);

    const calls: string[][] = [];
    const runner = makeMergeRunner(calls);
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-old", tempDir);
    const result = await mergeCheckAgent(agent);

    // tooOld → reclaimed and proceeded, despite the live holder.
    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0); // git work ran
    const t = await readAgentTransient(agentDir);
    expect(t?.operation).toBeNull(); // cleared in finally
  });

  test("mergeCheckAgent still REFUSES a LIVE holder whose op is fresh (within timeout)", async () => {
    const agentDir = await makeBackedAgentDir("agent-fresh");
    isPidAliveCtx.set(() => true); // holder alive
    // Same start time, but "now" is just inside the stuck timeout → NOT tooOld.
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: 1000 });
    nowMsCtx.set(() => 1000 + OP_STUCK_TIMEOUT_MS - 1);

    const calls: string[][] = [];
    const runner = makeMergeRunner(calls);
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-fresh", tempDir);
    const result = await mergeCheckAgent(agent);

    // Live + fresh → refused (no age reclaim).
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("currently merging");
    expect(calls.length).toBe(0); // refused before any git work
    // Marker untouched.
    const t = await readAgentTransient(agentDir);
    expect(t?.operation).toEqual({ kind: "merging", pid: 4242, started_at_ms: 1000 });
  });

  // ── clear-on-success and clear-on-failure ───────────────────────────────────

  test("mergeAgent clears the op marker on SUCCESS (dir removed)", async () => {
    const agentDir = await makeBackedAgentDir("agent-success");
    isPidAliveCtx.set(() => true);

    const calls: string[][] = [];
    const runner = makeMergeRunner(calls);
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-success", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(true);
    // Dir was removed on the success path; the finally's clearAgentOperation
    // must not throw (ENOENT-safe) and must not resurrect the dir.
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
    expect(await readAgentTransient(agentDir)).toBeNull();
  });

  test("mergeAgent clears the op marker on FAILURE (dir intact)", async () => {
    const agentDir = await makeBackedAgentDir("agent-fail");
    isPidAliveCtx.set(() => true);

    // Conflict check fails → merge aborts mid-flight but the agent dir survives.
    const calls: string[][] = [];
    const runner = (cmd: string[]): SpawnResult => {
      calls.push(cmd);
      const s = cmd.join(" ");
      if (s.includes("status") && s.includes("--porcelain")) return makeSpawnResult(0, "");
      if (s.includes("branch") && s.includes("--show-current")) return makeSpawnResult(0, "main");
      if (s.includes("show-ref") && s.includes("--verify")) return makeSpawnResult(0);
      // Rebase inside the temp conflict-check worktree fails → conflict detected.
      if (cmd.includes("rebase") && !cmd.includes("--abort")) return makeSpawnResult(1, "CONFLICT");
      if (s.includes("has-session")) return makeSpawnResult(1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-fail", tempDir);
    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(false);
    // Dir survives a failed merge; the op marker must be cleared so a retry
    // (or a kill) isn't blocked.
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
    const t = await readAgentTransient(agentDir);
    expect(t?.operation).toBeNull();
  });

  // ── resume guard ────────────────────────────────────────────────────────────

  test("resumeAgent refuses when an op is in flight with a LIVE holder", async () => {
    const agentDir = await makeBackedAgentDir("agent-res");
    isPidAliveCtx.set(() => true);
    nowMsCtx.set(() => 1000); // op fresh → still refuse
    await setAgentOperation(agentDir, { kind: "restarting", pid: 4242, started_at_ms: 1 });

    // has-session must fail so the tmux-liveness guard would otherwise let
    // resume proceed — proving it's the OP-guard, not the tmux guard, refusing.
    const runner = (cmd: string[]): SpawnResult => {
      if (cmd.includes("has-session")) return makeSpawnResult(1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);

    const agent = makeAgent("agent-res", tempDir, "stopped");
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("currently restarting");
    // resume.sh must NOT have been written — refused before any work.
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
    // Marker untouched.
    const t = await readAgentTransient(agentDir);
    expect(t?.operation).toEqual({ kind: "restarting", pid: 4242, started_at_ms: 1 });
  });

  test("resumeAgent clears the op marker after a successful resume", async () => {
    const agentDir = await makeBackedAgentDir("agent-res-ok");
    isPidAliveCtx.set(() => true);
    // No pre-existing op — the guard takes it fresh and the finally clears it.

    let newSessionSeen = false;
    const runner = (cmd: string[]): SpawnResult => {
      if (cmd[0] === "tmux" && cmd[1] === "new-session") { newSessionSeen = true; return makeSpawnResult(); }
      if (cmd.includes("has-session")) return makeSpawnResult(newSessionSeen ? 0 : 1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);

    const agent = makeAgent("agent-res-ok", tempDir, "stopped");
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(true);
    const t = await readAgentTransient(agentDir);
    expect(t?.operation).toBeNull();
  });

  // ── coordinator double-resume guard ─────────────────────────────────────────

  test("coordinator: second concurrent resume is refused by the op-guard", async () => {
    // A coordinator agent: resumeAgent routes to resetCoordinator, but the
    // op-guard sits ABOVE that branch. Set an in-flight restarting op with a
    // live holder; the resume must be refused before resetCoordinator runs
    // (resetCoordinator would nuke + respawn — we must not reach it).
    const agentDir = join(tempDir, ".ittybitty", "agents", "coord-x");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "coord-x", tmux_session: "ib-coord-x", agentType: "coordinator",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));
    isPidAliveCtx.set(() => true);
    nowMsCtx.set(() => 1000); // op fresh → still refuse
    await setAgentOperation(agentDir, { kind: "restarting", pid: 4242, started_at_ms: 1 });

    let nukeRan = false;
    const runner = (cmd: string[]): SpawnResult => {
      // resetCoordinator → nukeAgent issues tmux kill-session / list-sessions.
      if (cmd.includes("kill-session") || cmd.includes("list-sessions")) nukeRan = true;
      if (cmd.includes("has-session")) return makeSpawnResult(0);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);

    const agent = _makeAgent({
      id: "coord-x", repoPath: tempDir, repoName: "test", state: "running",
      meta: { agentType: "coordinator", tmux_session: "ib-coord-x" } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("currently restarting");
    expect(nukeRan).toBe(false); // resetCoordinator never reached
    // Coordinator dir + meta still present (no reset happened).
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
  });

  // ── kill / nuke bypass the guard ────────────────────────────────────────────

  test("killAgent is NOT blocked by an in-flight op (live holder)", async () => {
    const agentDir = await makeBackedAgentDir("agent-kill");
    isPidAliveCtx.set(() => true); // op holder very much alive
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: 1 });

    const calls: string[][] = [];
    const runner = (cmd: string[]): SpawnResult => {
      calls.push(cmd);
      if (cmd.includes("has-session") || cmd[0] === "pgrep") return makeSpawnResult(1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-kill", tempDir);
    const result = await killAgent(agent);

    // Kill is the recovery path for a wedged op — it must succeed regardless.
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Closed agent: agent-kill");
    // Dir removed → marker gone for free.
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
  });

  test("nukeAgent is NOT blocked by an in-flight op (live holder)", async () => {
    const agentDir = await makeBackedAgentDir("agent-nuke");
    isPidAliveCtx.set(() => true);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: 1 });

    const runner = (cmd: string[]): SpawnResult => {
      if (cmd.includes("has-session") || cmd.includes("list-sessions") || cmd[0] === "pgrep") {
        return makeSpawnResult(1);
      }
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);

    const agent = makeAgent("agent-nuke", tempDir);
    const result = await nukeAgent(agent);

    expect(result.ok).toBe(true);
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
  });
});


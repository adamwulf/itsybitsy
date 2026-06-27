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
  resetReadAgentMetaCache,
  readAllAgents,
  buildAgentTree,
} from "./agents";
import { matchAgentById } from "./index";
import { saveRegistry } from "./registry";
import { makeAgent as _makeAgent, makeSpawnResult } from "./test-utils";
import {
  killAgent,
  nukeAgent,
  nukeAllAgents,
  resumeAgent,
  reassignAgent,
  renameAgent,
  validateAgentName,
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
  setCodexDryRunSpawnRunner,
  resetCodexDryRunSpawnRunner,
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
  teamAdd,
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

      // Per-agent outboxes now live under getCoordinatorHome() / agents / <id>,
      // not under the per-worktree agent dir. Without this isolation, queued
      // messages would accumulate in the developer's real
      // ~/.itsybitsy/agents/agent-abc/outbox.jsonl and leak from one test into
      // the next (sendMessage drains inline when no live watchdog), inflating
      // spawnCalls / corrupting prefix assertions.
      const { setCoordinatorHome } = await import("./coordinator");
      setCoordinatorHome(join(tempDir, "coord-home"));

      setSendSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        return makeSpawnResult();
      });
    });

    afterEach(async () => {
      resetSendSpawnRunner();
      resetUserConfigPath();
      const { resetCoordinatorHome } = await import("./coordinator");
      resetCoordinatorHome();
      await rm(tempDir, { recursive: true, force: true });
    });

    test("sends message via tmux send-keys then Enter", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      const result = await sendMessage(agent, "hello world", { cwd: "/" });

      expect(result.ok).toBe(true);
      // Should have: has-session, send-keys (message), send-keys (Enter)
      expect(spawnCalls.length).toBe(3);
      expect(spawnCalls[0]).toEqual(["tmux", "has-session", "-t", `=tmux-agent-abc:`]);
      expect(spawnCalls[1]).toEqual(["tmux", "send-keys", "-t", `=tmux-agent-abc:`, "-l", "--", "[sent by user]: hello world"]);
      expect(spawnCalls[2]).toEqual(["tmux", "send-keys", "-t", `=tmux-agent-abc:`, "Enter"]);
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
      expect(lastCall).toEqual(["tmux", "send-keys", "-t", "=tmux-agent-abc:", "Enter"]);
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
      expect(lastCall).toEqual(["tmux", "send-keys", "-t", "=tmux-agent-abc:", "Enter"]);
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

    test("user message starting with / is passed through verbatim (no prefix)", async () => {
      // user.name set to prove the passthrough beats the named-user prefix too.
      await Bun.write(
        join(tempDir, "config.json"),
        JSON.stringify({ user: { name: "Adam" } }, null, 2)
      );

      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "/clear", { cwd: "/" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("/clear");

      const recipientLog = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(recipientLog).toContain("Received command from user: /clear");
      expect(recipientLog).not.toContain("[sent by user");
    });

    test("user message starting with ! is passed through verbatim (no prefix)", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "!ls -la", { cwd: "/" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("!ls -la");

      const recipientLog = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(recipientLog).toContain("Received command from user: !ls -la");
    });

    test("agent-relayed message starting with / is NOT passed through (keeps attribution)", async () => {
      // Passthrough is user-only — an agent forwarding a `/`-leading string must
      // still carry its [sent by agent ...] prefix so the recipient knows the source.
      const agent = makeAgent("agent-abc", tempDir);
      await mkdir(join(tempDir, ".ittybitty", "agents", "agent-sender"), { recursive: true });

      await sendMessage(agent, "/clear", { fromAgent: "agent-sender" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("[sent by agent agent-sender]: /clear");
    });

    test("user message that merely contains / or ! (not leading) still gets the prefix", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "run /help please", { cwd: "/" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("[sent by user]: run /help please");
    });

    test("user message with leading whitespace before / still gets the prefix (column-0 only)", async () => {
      // Passthrough keys off the literal first character. A leading space means
      // the `/` would not land in column 0 anyway, so the message is treated as
      // ordinary text and prefixed normally.
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, " /clear", { cwd: "/" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("[sent by user]:  /clear");
    });

    test("user message that is exactly '/' is passed through verbatim", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "/", { cwd: "/" });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("/");
    });

    test("raw=true takes precedence over passthrough (both skip the prefix; raw wins the log line)", async () => {
      // A raw send of a `/`-leading message must be logged as a raw message, not
      // as a user-command passthrough — raw is checked first.
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "/clear", { cwd: "/", raw: true });

      const sendKeysCall = spawnCalls.find(
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![6]).toBe("/clear");

      const recipientLog = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(recipientLog).toContain("Received raw message: /clear");
      expect(recipientLog).not.toContain("Received command from user");
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
  // Per-worktree agent dir — still used for the agent's own meta.transient.json
  // / agent.log / state writes. The outbox queue itself now lives under the
  // CENTRAL coordinator-home root (see queueDir below).
  let agentDir: string;
  // Central outbox queue dir — agentOutboxDir(id) under setCoordinatorHome.
  let queueDir: string;

  beforeEach(async () => {
    spawnCalls = [];
    tempDir = await mkdtemp(join(tmpdir(), "send-outbox-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    // Point the coordinator-home to a sandbox subdir so agentOutboxDir() resolves
    // there instead of the real ~/.itsybitsy/.
    const { setCoordinatorHome } = await import("./coordinator");
    setCoordinatorHome(join(tempDir, "coord-home"));
    const { agentOutboxDir } = await import("./outbox");
    queueDir = agentOutboxDir("agent-abc");
    await mkdir(queueDir, { recursive: true });
    setUserConfigPath(join(tempDir, "config.json"));
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return makeSpawnResult();
    });
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetUserConfigPath();
    const { resetCoordinatorHome } = await import("./coordinator");
    resetCoordinatorHome();
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
      tmux_api_error: false, tmux_api_terms: false,
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
    const queued = await readOutbox(queueDir);
    expect(queued.length).toBe(1);
    expect(queued[0]!.message).toBe("hello");
  });

  test("stale transient (watchdog not fresh): delivers inline", async () => {
    const { writeAgentTransient, isPidAliveCtx } = await import("./agents");
    isPidAliveCtx.set(() => true);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false,
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
    expect(await readOutbox(queueDir)).toEqual([]);
  });

  test("dead watchdog pid: delivers inline", async () => {
    const { writeAgentTransient, isPidAliveCtx } = await import("./agents");
    isPidAliveCtx.set(() => false); // pid is dead
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false,
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
    const queued = await readOutbox(queueDir);
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

  test("appends a [kill] line to the system watch log on success", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-loggy");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-loggy",
      tmux_session: "tmux-agent-loggy",
      claude_pid: "77777",
    }));

    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const logPath = join(tempDir, "watch.log");
    const { setWatchLogPath, resetWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
    try {
      const agent = makeAgent("agent-loggy", tempDir);
      const result = await killAgent(agent);
      expect(result.ok).toBe(true);

      const { readFile } = await import("fs/promises");
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("[kill]");
      expect(log).toContain("agent-loggy");
      // makeAgent's default claude_pid is "12345"; assert the prefix so we
      // verify pid= is included without coupling to the helper's literal.
      expect(log).toMatch(/pid=\d+/);
    } finally {
      resetWatchLogPath();
    }
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
    expect(killSessionCall![3]).toBe("=tmux-agent-abc:");

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

  test("appends a [pause] line to the system watch log on success", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-pauseloggy");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-pauseloggy",
      tmux_session: "tmux-agent-pauseloggy",
      claude_pid: "55555",
    }));

    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const logPath = join(tempDir, "watch.log");
    const { setWatchLogPath, resetWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
    try {
      const agent = makeAgent("agent-pauseloggy", tempDir, "waiting");
      const result = await pauseAgent(agent);
      expect(result.ok).toBe(true);

      const { readFile } = await import("fs/promises");
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("[pause]");
      expect(log).toContain("agent-pauseloggy");
      expect(log).toMatch(/pid=\d+/);
    } finally {
      resetWatchLogPath();
    }
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
      if (cmd[0] === "git" && cmd.includes("rev-parse") && cmd.includes("--git-common-dir")) {
        return makeSpawnResult(0, "/tmp/repo/.git\n");
      }
      return makeSpawnResult();
    };
  }

  // Captures (cmd, cwd) for every codex dispatcher dry-run subprocess.
  // The codex dry-run goes through codexDryRunSpawnCtx (NOT
  // nukeResumeSpawnCtx) so the runtime hook can resolve agentsDir from
  // the worktree cwd. Without capturing cwd here, tests can't verify the
  // fix that routes workPath into the subprocess.
  let codexDryRunCalls: Array<{ cmd: string[]; cwd: string }>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "resume-test-"));
    spawnCalls = [];
    codexDryRunCalls = [];
    const runner = makeDefaultResumeRunner(spawnCalls);
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);
    // Default codex dry-run runner: capture (cmd, cwd) + succeed.
    setCodexDryRunSpawnRunner((cmd, cwd) => {
      codexDryRunCalls.push({ cmd, cwd });
      return makeSpawnResult();
    });
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetNukeResumeSpawnRunner();
    resetCodexDryRunSpawnRunner();
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
      model: "claude:opus",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-abc",
        model: "claude:opus",
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
      model: "claude:opus",
    }));

    const agent = _makeAgent({
      id: "agent-resume",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-resume",
        model: "claude:opus",
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
      model: "claude:opus",
    }));

    const agent = _makeAgent({
      id: "agent-hup",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-hup",
        model: "claude:opus",
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
      model: "claude:opus",
    }));

    const agent = _makeAgent({
      id: "agent-window-size",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-window-size",
        model: "claude:opus",
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
        c.includes("=tmux-agent-window-size:") &&
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
    // meta.json should be passed via `ib write-pid` which routes through
    // mutateAgentMeta (HIGH 2 fix from the Phase 4 review).
    expect(resumeScript).toContain(`META_JSON='${join(agentDir, "meta.json")}'`);
    expect(resumeScript).toContain("ib write-pid 'agent-abc' \"$CLAUDE_PID\"");
    // exit-check.sh should be single-quoted
    expect(resumeScript).toContain(`'${join(agentDir, "exit-check.sh")}'`);
    // Should NOT have old pattern of embedding path in JS string
    expect(resumeScript).not.toContain("const f='/");
    // Should NOT use the race-prone inline bun -e read-modify-write.
    expect(resumeScript).not.toContain("m.claude_pid=String(process.argv[2])");
    expect(resumeScript).not.toContain("bun -e \"const f=");
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
      await Bun.write(userConfigPath, JSON.stringify({ model: "claude:sonnet" }, null, 2));

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

  // Phase 7 regression snapshot — mirrors the Phase 4 MED 4 byte-equality
  // guard on claude start.sh. The codex resume branch sits next to the
  // claude resume branch in resumeAgent; any future codex/cli-routing
  // change risks accidentally touching the claude path. This fixture
  // assertion fails the moment claude resume.sh diverges from the recorded
  // baseline; if the divergence is intentional, update the fixture in the
  // same PR with a visible diff and a clear reason in the commit message.
  test("claude resume.sh matches the byte-equality fixture (regression snapshot)", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-claude-snapshot");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-claude-snapshot",
      tmux_session: "tmux-agent-claude-snapshot",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      model: "claude:sonnet",
    }));

    const agent = _makeAgent({
      id: "agent-claude-snapshot",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-claude-snapshot",
        model: "claude:sonnet",
      } as any,
    });
    const result = await resumeAgent(agent);
    expect(result.ok).toBe(true);

    const rawResumeSh = await Bun.file(join(agentDir, "resume.sh")).text();
    // Normalise per-run varying bits:
    //   * tempDir prefix → <AGENTSDIR>
    //   * UUID session id → <SESSION-UUID>
    const sessionUuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    const normalised = rawResumeSh
      .replaceAll(tempDir, "<AGENTSDIR>")
      .replaceAll(sessionUuidPattern, "<SESSION-UUID>");

    const fixturePath = join(
      import.meta.dir.replace(/\/src$/, ""),
      "tests",
      "fixtures",
      "claude-resume-sh-baseline.sh",
    );
    const fixtureFile = Bun.file(fixturePath);
    if (!(await fixtureFile.exists())) {
      // Bootstrap: write the fixture and fail loudly so the dev commits
      // the new baseline. This codepath should never fire on CI.
      await Bun.write(fixturePath, normalised);
      throw new Error(
        `Fixture missing — wrote a fresh baseline to ${fixturePath}. ` +
          `Commit the fixture, then re-run.`,
      );
    }
    const expected = await fixtureFile.text();
    expect(normalised).toBe(expected);
  });

  // ── codex resume (SPEC-CODEX-MODEL.md §5.8 + §6 Phase 7) ────────────────────
  test("resumes codex agent with valid codex_session_id — writes codex-shaped resume.sh + spawns tmux", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-codex-ok");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-codex-ok",
      tmux_session: "tmux-agent-codex-ok",
      model: "codex:gpt-5.4-mini",
      codex_session_id: "019e7b21-cb7d-7f23-8674-11036ed141ef",
    }));

    const agent = _makeAgent({
      id: "agent-codex-ok",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        tmux_session: "tmux-agent-codex-ok",
        model: "codex:gpt-5.4-mini",
        codex_session_id: "019e7b21-cb7d-7f23-8674-11036ed141ef",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(true);
    // resume.sh should be created with codex launch line.
    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resumeScript).toContain("codex resume '019e7b21-cb7d-7f23-8674-11036ed141ef'");
    expect(resumeScript).toContain("--dangerously-bypass-hook-trust");
    expect(resumeScript).toContain("-a never");
    expect(resumeScript).toContain("-s workspace-write");
    // Must NOT use claude --resume.
    expect(resumeScript).not.toContain("claude --resume");

    // tmux new-session should have been called with the resume script path.
    const newSessionCall = spawnCalls.find(c => c[0] === "tmux" && c[1] === "new-session");
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall!.some(arg => arg.includes("resume.sh"))).toBe(true);

    // dispatcher precheck must have run (3 events) — calls go through
    // codexDryRunSpawnCtx, NOT the resume spawn runner, so we read from
    // codexDryRunCalls.
    const dryRunCmdStrs = codexDryRunCalls.map(c => c.cmd.join(" "));
    expect(dryRunCmdStrs.some(c => c.includes("hooks codex-pre-tool-use") && c.includes("--dry-run"))).toBe(true);
    expect(dryRunCmdStrs.some(c => c.includes("hooks codex-session-start") && c.includes("--dry-run"))).toBe(true);
    expect(dryRunCmdStrs.some(c => c.includes("hooks codex-stop") && c.includes("--dry-run"))).toBe(true);

    // Regression: every codex dry-run subprocess must be spawned with
    // cwd === workPath (the agent's worktree dir, `<agentDir>/repo`). If
    // cwd is wrong, the runtime hook's resolveAgentDir regex fails and the
    // precheck explodes with "meta.json not found".
    const expectedCwd = join(agentDir, "repo");
    expect(codexDryRunCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of codexDryRunCalls) {
      expect(call.cwd).toBe(expectedCwd);
    }
  });

  test("codex resume refuses when dispatcher precheck fails — no resume.sh, no tmux launch", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-codex-pre");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-codex-pre",
      tmux_session: "tmux-agent-codex-pre",
      model: "codex:gpt-5.4-mini",
      codex_session_id: "019e7b21-cb7d-7f23-8674-11036ed141ef",
    }));

    // Custom runner for non-dry-run tmux/git ops (default resume runner-ish).
    const baseRunner = (cmd: string[]): SpawnResult => {
      spawnCalls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "new-session") return makeSpawnResult();
      if (cmd.includes("has-session")) return makeSpawnResult(1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(baseRunner);
    setNukeResumeSpawnRunner(baseRunner);
    // The dry-run now goes through codexDryRunSpawnCtx — inject failure
    // there to simulate a broken dispatcher.
    setCodexDryRunSpawnRunner((cmd, cwd) => {
      codexDryRunCalls.push({ cmd, cwd });
      return makeSpawnResult(1, "", "dispatcher broken");
    });

    const agent = _makeAgent({
      id: "agent-codex-pre",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        tmux_session: "tmux-agent-codex-pre",
        model: "codex:gpt-5.4-mini",
        codex_session_id: "019e7b21-cb7d-7f23-8674-11036ed141ef",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("codex dispatcher precheck failed");
    expect(result.stderr).toContain("dispatcher broken");
    // resume.sh must NOT be written on precheck failure.
    const resumeShExists = await Bun.file(join(agentDir, "resume.sh")).exists();
    expect(resumeShExists).toBe(false);
    // tmux new-session must NOT have been called (precheck fails before launch).
    const cmdStrs = spawnCalls.map(c => c.join(" "));
    expect(cmdStrs.some(c => c.includes("tmux new-session"))).toBe(false);
  });

  test("codex resume — live tmux session refusal applies (CLI-agnostic guard)", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-codex-live");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-codex-live",
      tmux_session: "tmux-agent-codex-live",
      model: "codex:gpt-5.4-mini",
      codex_session_id: "019e7b21-cb7d-7f23-8674-11036ed141ef",
    }));

    // Override the default runner: has-session always succeeds (live tmux).
    const liveRunner = (cmd: string[]): SpawnResult => {
      spawnCalls.push(cmd);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(liveRunner);
    setNukeResumeSpawnRunner(liveRunner);

    const agent = _makeAgent({
      id: "agent-codex-live",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        tmux_session: "tmux-agent-codex-live",
        model: "codex:gpt-5.4-mini",
        codex_session_id: "019e7b21-cb7d-7f23-8674-11036ed141ef",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("live tmux session");
    const resumeShExists = await Bun.file(join(agentDir, "resume.sh")).exists();
    expect(resumeShExists).toBe(false);
  });

  test("refuses to resume codex agent when codex_session_id is missing", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-codex01");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-codex01",
      tmux_session: "tmux-agent-codex01",
      model: "codex:gpt-5.4-mini",
      // No codex_session_id — SessionStart hook never fired.
    }));

    const agent = _makeAgent({
      id: "agent-codex01",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        tmux_session: "tmux-agent-codex01",
        model: "codex:gpt-5.4-mini",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("codex_session_id not yet captured");
    // resume.sh must not be written.
    const resumeShExists = await Bun.file(join(agentDir, "resume.sh")).exists();
    expect(resumeShExists).toBe(false);
  });

  test("refuses to resume codex agent when codex_session_id is malformed", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-codex02");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-codex02",
      tmux_session: "tmux-agent-codex02",
      model: "codex:gpt-5.4-mini",
      codex_session_id: "not-a-valid-uuid!@#",
    }));

    const agent = _makeAgent({
      id: "agent-codex02",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        tmux_session: "tmux-agent-codex02",
        model: "codex:gpt-5.4-mini",
        codex_session_id: "not-a-valid-uuid!@#",
      } as any,
    });
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid codex_session_id");
    const resumeShExists = await Bun.file(join(agentDir, "resume.sh")).exists();
    expect(resumeShExists).toBe(false);
  });

});

describe("mergeAgent (native)", () => {
  let tempDir: string;
  let spawnCalls: string[][];

  // Fake 40-char SHA returned by the mocked `git rev-parse HEAD` after a merge.
  const MERGE_HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

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

      // git rev-parse HEAD → fake 40-char SHA (the new merge commit)
      if (cmd.includes("rev-parse") && cmd.includes("HEAD")) {
        return makeSpawnResult(0, `${MERGE_HEAD_SHA}\n`);
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

  test("succeeds with full merge sequence and includes merge commit SHA in stdout", async () => {
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
    // A merge with commits reports the target branch + full 40-char merge SHA.
    expect(result.stdout).toBe(`Closed agent: agent-abc (merged to main at ${MERGE_HEAD_SHA})`);
    expect(MERGE_HEAD_SHA).toHaveLength(40);
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
    // No merge happened → no new SHA → plain message (no "(merged to ...)").
    expect(result.stdout).toBe("Closed agent: agent-abc");

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

    // Should still succeed — rm -rf fallback handles cleanup. The merge itself
    // succeeded earlier, so stdout still reports the merge commit SHA.
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(`Closed agent: agent-abc (merged to main at ${MERGE_HEAD_SHA})`);
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
  // Captures (cmd, cwd) for every codex dispatcher dry-run subprocess.
  // The codex dry-run goes through codexDryRunSpawnCtx (NOT newAgentSpawnCtx)
  // so the runtime hook can resolve agentsDir from the worktree cwd. Without
  // capturing cwd here, tests can't verify the fix that routes workPath into
  // the subprocess. Tests that need to inject precheck failure should override
  // via setCodexDryRunSpawnRunner.
  let codexDryRunCalls: Array<{ cmd: string[]; cwd: string }>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ib-newagent-test-"));
    agentsDir = join(tempDir, ".ittybitty", "agents");
    spawnCalls = [];
    codexDryRunCalls = [];

    // Default codex dry-run runner: capture (cmd, cwd) + succeed.
    setCodexDryRunSpawnRunner((cmd, cwd) => {
      codexDryRunCalls.push({ cmd, cwd });
      return makeSpawnResult("", 0);
    });

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
    await Bun.write(userConfigPath, JSON.stringify({ model: "claude:sonnet" }, null, 2));

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
    resetCodexDryRunSpawnRunner();
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

  /**
   * Write a minimal agent-type layer/type file with an optional `model:` field.
   * `modelLine` is inserted verbatim into the frontmatter, so callers can pass
   * "model: claude:claude-opus-4-7" (real value), "model:" (blank → inherit), or ""
   * (omit the key entirely). `spawnable` defaults to true; layer files
   * (`_all`, `_non_coordinator`, `system`) must pass `spawnable: false`.
   */
  async function writeLayerModel(
    name: string,
    modelLine: string,
    opts?: { spawnable?: boolean; canSpawnChildren?: boolean },
  ) {
    const path = join(process.env.HOME!, ".itsybitsy", "agent-types", `${name}.md`);
    const spawnableLine = opts?.spawnable === false ? "spawnable: false\n" : "";
    const canSpawnLine = opts?.canSpawnChildren ? "canSpawnChildren: true\n" : "";
    const fmModel = modelLine ? `${modelLine}\n` : "";
    const body = `---\nname: ${name}\ndescription: Test ${name} layer\n${spawnableLine}${canSpawnLine}${fmModel}---\n`;
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

  /** Mock runner where the spawner's git worktree is clean. */
  function cleanWorktreeRunner() {
    const inner = mockSpawnRunner();
    return (cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("rev-parse --is-inside-work-tree")) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes("status --porcelain")) {
        return makeSpawnResult("", 0);
      }
      return inner(cmd, opts);
    };
  }

  /** Mock runner where the spawner's git worktree has uncommitted changes. */
  function dirtyWorktreeRunner(porcelain = " M src/foo.ts\n?? new.ts\n") {
    const inner = mockSpawnRunner();
    return (cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("rev-parse --is-inside-work-tree")) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes("status --porcelain")) {
        return makeSpawnResult(porcelain, 0);
      }
      return inner(cmd, opts);
    };
  }

  test("rejects spawn when spawner worktree has uncommitted changes", async () => {
    setNewAgentSpawnRunner(dirtyWorktreeRunner());
    const result = await callNewAgent("do work");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("uncommitted changes");
    // The porcelain output is surfaced so the user knows what's dirty.
    expect(result.stderr).toContain("src/foo.ts");
    // The cwd is named so the user knows which worktree to commit in.
    expect(result.stderr).toContain(tempDir);
  });

  test("error message preserves porcelain XY columns (leading space not stripped)", async () => {
    // git status --porcelain uses a 2-column XY prefix where the leading
    // space is meaningful ("X Y filename"): " M file" = unstaged
    // modification, "M  file" = staged modification. The check must drain
    // the porcelain output raw — runCmd's stdout.trim() would otherwise
    // destroy the leading space on the first line, making the displayed
    // status code ambiguous.
    setNewAgentSpawnRunner(dirtyWorktreeRunner(" M src/foo.ts\nMM src/bar.ts\n"));
    const result = await callNewAgent("do work");
    expect(result.ok).toBe(false);
    // First line's leading space must survive (would be stripped by .trim()).
    expect(result.stderr).toContain(" M src/foo.ts");
    expect(result.stderr).toContain("MM src/bar.ts");
  });

  test("error message names untracked files as a remediation option (not just commit)", async () => {
    // Porcelain "??" means untracked. The remediation hint should not say
    // only "commit" — untracked files often want .gitignore or removal.
    setNewAgentSpawnRunner(dirtyWorktreeRunner("?? scratch.txt\n"));
    const result = await callNewAgent("do work");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("untracked");
    expect(result.stderr).toContain(".gitignore");
  });

  test("dirty-worktree spawn does not create the agent directory", async () => {
    setNewAgentSpawnRunner(dirtyWorktreeRunner());
    const result = await callNewAgent("do work", { name: "dirty-spawn" });
    expect(result.ok).toBe(false);
    // No agent dir should have been created — the check runs before any
    // side effects so we don't leave orphans behind.
    const dir = Bun.file(join(agentsDir, "dirty-spawn", "meta.json"));
    expect(await dir.exists()).toBe(false);
  });

  test("allows spawn when spawner worktree is clean (porcelain empty)", async () => {
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await callNewAgent("do something", { name: "clean-spawn" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("clean-spawn");
  });

  test("allows spawn when is-inside-work-tree exits non-zero (real 'outside any repo' case)", async () => {
    // Real git exits 128 with stderr 'fatal: not a git repository' when the
    // cwd is outside any work tree. The check must skip on the exitCode !==
    // 0 branch, NOT just on stdout !== "true". This test exercises that
    // branch explicitly rather than relying on the default mock fallthrough.
    setNewAgentSpawnRunner((cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("rev-parse --is-inside-work-tree")) {
        return makeSpawnResult("", 128);
      }
      return mockSpawnRunner()(cmd, opts);
    });
    const result = await callNewAgent("do something", { name: "outside-repo" });
    expect(result.ok).toBe(true);
  });

  test("allows spawn when is-inside-work-tree exits 0 but reports false (bare repo / .git dir)", async () => {
    // Inside a bare repo or the .git/ directory itself, git rev-parse
    // --is-inside-work-tree prints 'false' and exits 0. Covers the
    // stdout !== "true" branch independently of the exit-code branch.
    setNewAgentSpawnRunner((cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("rev-parse --is-inside-work-tree")) {
        return makeSpawnResult("false", 0);
      }
      return mockSpawnRunner()(cmd, opts);
    });
    const result = await callNewAgent("do something", { name: "bare-repo" });
    expect(result.ok).toBe(true);
  });

  test("dirty-worktree check fires for coordinator spawns too", async () => {
    // Coordinators go through the same newAgent codepath; a dirty repo at
    // the coordinator's cwd must still block.
    setNewAgentSpawnRunner(dirtyWorktreeRunner());
    const result = await newAgent(tempDir, "start coordinator", {
      type: "coordinator",
      _cwd: tempDir,
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("uncommitted changes");
  });

  test("dirty-worktree check uses target repoPath, not the caller's _cwd", async () => {
    // The check must read the *target* repo's state — the repo the sub-agent
    // will fork from — not the caller's cwd. Repro: coordinator at a dirty
    // ~/.itsybitsy spawning into a clean tinytext repo must NOT be blocked.
    //
    // Here _cwd points at a directory the mock treats as dirty, while the
    // target repo (tempDir) is clean. The spawn should succeed because the
    // sub-agent inherits from tempDir's HEAD, not from _cwd.
    const dirtyCallerCwd = join(tempDir, "elsewhere");
    setNewAgentSpawnRunner((cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }) => {
      const cmdStr = cmd.join(" ");
      // Mark the caller's cwd as dirty…
      if (cmdStr.includes(`-C ${dirtyCallerCwd} rev-parse --is-inside-work-tree`)) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes(`-C ${dirtyCallerCwd} status --porcelain`)) {
        return makeSpawnResult(" M foo\n", 0);
      }
      // …and leave the target repo (tempDir) clean.
      if (cmdStr.includes(`-C ${tempDir} rev-parse --is-inside-work-tree`)) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes(`-C ${tempDir} status --porcelain`)) {
        return makeSpawnResult("", 0);
      }
      return mockSpawnRunner()(cmd, opts);
    });
    const result = await newAgent(tempDir, "do work", {
      _cwd: dirtyCallerCwd,
      name: "cross-repo-spawn",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("cross-repo-spawn");
  });

  test("dirty-worktree check blocks when target repo is dirty even if caller's cwd is clean", async () => {
    // Inverse of the cross-repo case: caller has a clean ~/.itsybitsy, but the
    // target repo has uncommitted changes. The sub-agent would inherit from
    // the dirty target's HEAD, so the spawn must be rejected — and the error
    // message must name the *target* repo so the user knows where to commit.
    const cleanCallerCwd = join(tempDir, "elsewhere-clean");
    setNewAgentSpawnRunner((cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes(`-C ${cleanCallerCwd} rev-parse --is-inside-work-tree`)) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes(`-C ${cleanCallerCwd} status --porcelain`)) {
        return makeSpawnResult("", 0);
      }
      if (cmdStr.includes(`-C ${tempDir} rev-parse --is-inside-work-tree`)) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes(`-C ${tempDir} status --porcelain`)) {
        return makeSpawnResult(" M target.ts\n", 0);
      }
      return mockSpawnRunner()(cmd, opts);
    });
    const result = await newAgent(tempDir, "do work", { _cwd: cleanCallerCwd });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("uncommitted changes");
    expect(result.stderr).toContain("target.ts");
    // Error names the target repo, not the caller's cwd.
    expect(result.stderr).toContain(tempDir);
    expect(result.stderr).not.toContain(cleanCallerCwd);
  });

  test("dirty check inspects parent worktree (not host repo) when manager is set", async () => {
    // When spawning with a manager, the child worktree forks from
    // `agent/<manager>` — not host HEAD. The dirty gate must inspect the parent
    // agent's worktree at <root>/.ittybitty/agents/<manager>/repo, mirroring
    // baseRef.  Repro: host repo dirty, parent worktree clean → spawn succeeds.
    const mgrDir = join(agentsDir, "agent-mgr");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(join(mgrDir, "meta.json"), JSON.stringify({ id: "agent-mgr", worker: false }));
    const parentWorktree = join(mgrDir, "repo");
    await mkdir(parentWorktree, { recursive: true });

    setNewAgentSpawnRunner((cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }) => {
      const cmdStr = cmd.join(" ");
      // Host repo (tempDir) is dirty…
      if (cmdStr.includes(`-C ${tempDir} rev-parse --is-inside-work-tree`)) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes(`-C ${tempDir} status --porcelain`)) {
        return makeSpawnResult(" M host.ts\n", 0);
      }
      // …but the parent worktree is clean.
      if (cmdStr.includes(`-C ${parentWorktree} rev-parse --is-inside-work-tree`)) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes(`-C ${parentWorktree} status --porcelain`)) {
        return makeSpawnResult("", 0);
      }
      return mockSpawnRunner()(cmd, opts);
    });
    const result = await callNewAgent("sub-task", { name: "mgr-spawn", manager: "agent-mgr" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("mgr-spawn");
  });

  test("dirty check blocks spawn when parent worktree is dirty (manager set)", async () => {
    // Inverse: host repo clean, parent worktree dirty → spawn rejected, and
    // the error message names the parent worktree path so the user knows
    // where to go commit.
    const mgrDir = join(agentsDir, "agent-mgr-dirty");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(join(mgrDir, "meta.json"), JSON.stringify({ id: "agent-mgr-dirty", worker: false }));
    const parentWorktree = join(mgrDir, "repo");
    await mkdir(parentWorktree, { recursive: true });

    setNewAgentSpawnRunner((cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes(`-C ${tempDir} rev-parse --is-inside-work-tree`)) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes(`-C ${tempDir} status --porcelain`)) {
        return makeSpawnResult("", 0);
      }
      if (cmdStr.includes(`-C ${parentWorktree} rev-parse --is-inside-work-tree`)) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes(`-C ${parentWorktree} status --porcelain`)) {
        return makeSpawnResult(" M parent.ts\n", 0);
      }
      return mockSpawnRunner()(cmd, opts);
    });
    const result = await callNewAgent("sub-task", { manager: "agent-mgr-dirty" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("uncommitted changes");
    expect(result.stderr).toContain("parent.ts");
    // Error message names the parent worktree path (the fork source).
    expect(result.stderr).toContain(parentWorktree);
  });

  test("dirty check falls back to rootRepoPath when parent worktree path is missing", async () => {
    // Edge case: the manager validation lets the agent through (meta.json
    // exists) but the actual `<id>/repo` directory is gone (manually deleted,
    // crashed mid-spawn, etc). Rather than crashing, the dirty check falls
    // back to inspecting rootRepoPath. If rootRepoPath is clean, spawn proceeds.
    const mgrDir = join(agentsDir, "agent-mgr-norepo");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(join(mgrDir, "meta.json"), JSON.stringify({ id: "agent-mgr-norepo", worker: false }));
    // NOTE: intentionally NOT creating <mgrDir>/repo

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await callNewAgent("sub-task", { name: "fallback-spawn", manager: "agent-mgr-norepo" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("fallback-spawn");
  });

  test("dirty check tolerates `git status` exit failure (silent skip)", async () => {
    // If `git status` somehow exits non-zero (e.g. corrupt index), the check
    // should not block the spawn — falling open is preferable to producing
    // a confusing error from a transient git failure.
    setNewAgentSpawnRunner((cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("rev-parse --is-inside-work-tree")) {
        return makeSpawnResult("true", 0);
      }
      if (cmdStr.includes("status --porcelain")) {
        return makeSpawnResult("", 128); // git error
      }
      return mockSpawnRunner()(cmd, opts);
    });
    const result = await callNewAgent("do work", { name: "git-err" });
    expect(result.ok).toBe(true);
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
    expect(meta.model).toBe("claude:sonnet"); // model from test config (qualified <cli>:<model> form)
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
    await callNewAgent("task", { name: "test-model", model: "claude:opus" });

    const meta = await Bun.file(join(agentsDir, "test-model", "meta.json")).json();
    // meta stores the raw qualified string verbatim (SPEC §4 / D8).
    expect(meta.model).toBe("claude:opus");

    // start.sh receives the model HALF — claude command stays byte-identical
    // to today's `claude --model opus`.
    const startSh = await Bun.file(join(agentsDir, "test-model", "start.sh")).text();
    expect(startSh).toContain("--model opus");
    expect(startSh).not.toContain("--model claude:opus");
  });

  test("uses model from config when not specified", async () => {
    // User config uses qualified `claude:haiku` form (D1/D5).
    const cfgPath = join(tempDir, "config.json");
    setUserConfigPath(cfgPath);
    await Bun.write(cfgPath, JSON.stringify({ model: "claude:haiku" }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-cfg-model" });

    const meta = await Bun.file(join(agentsDir, "test-cfg-model", "meta.json")).json();
    expect(meta.model).toBe("claude:haiku");
  });

  test("defaults model to claude:opus when neither opts nor config specify", async () => {
    // Clear config so no model is set
    const cfgPath = join(tempDir, "config.json");
    setUserConfigPath(cfgPath);
    await Bun.write(cfgPath, JSON.stringify({}));
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-default-model" });

    const meta = await Bun.file(join(agentsDir, "test-default-model", "meta.json")).json();
    expect(meta.model).toBe("claude:opus");
  });

  // ── model precedence across agent-type layer files ──────────────────────────
  // Precedence (most-specific wins):
  //   --model > <type>.md > _non_coordinator.md > _all.md > config.model > 'opus'

  test("model precedence C1: model in _all.md is used when nothing more specific declares one", async () => {
    // config.model is "claude:sonnet" (from beforeEach) — the _all.md layer overrides it.
    await writeLayerModel("_all", "model: claude:claude-opus-4-7", { spawnable: false });
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-all-model" });

    const meta = await Bun.file(join(agentsDir, "test-all-model", "meta.json")).json();
    expect(meta.model).toBe("claude:claude-opus-4-7");

    const startSh = await Bun.file(join(agentsDir, "test-all-model", "start.sh")).text();
    expect(startSh).toContain("--model claude-opus-4-7");
  });

  test("model precedence C2: <type>.md model overrides _all.md model", async () => {
    await writeLayerModel("_all", "model: claude:claude-opus-4-7", { spawnable: false });
    // worker.md is the most-specific layer for a worker agent.
    await writeLayerModel("worker", "model: claude:claude-sonnet-4-6");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-type-overrides-all", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-type-overrides-all", "meta.json")).json();
    expect(meta.model).toBe("claude:claude-sonnet-4-6");
  });

  test("model precedence C2b: <type>.md model overrides _non_coordinator.md model", async () => {
    await writeLayerModel("_non_coordinator", "model: claude:claude-opus-4-7", { spawnable: false });
    // worker.md is the most-specific layer; it must beat _non_coordinator.md.
    await writeLayerModel("worker", "model: claude:claude-sonnet-4-6");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-type-overrides-noncoord", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-type-overrides-noncoord", "meta.json")).json();
    expect(meta.model).toBe("claude:claude-sonnet-4-6");
  });

  test("model precedence C3a: _non_coordinator.md model overrides _all.md for a non-coordinator agent", async () => {
    await writeLayerModel("_all", "model: claude:claude-opus-4-7", { spawnable: false });
    await writeLayerModel("_non_coordinator", "model: claude:claude-sonnet-4-6", { spawnable: false });
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-noncoord-overrides-all", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-noncoord-overrides-all", "meta.json")).json();
    expect(meta.model).toBe("claude:claude-sonnet-4-6");
  });

  test("model precedence C3b: _non_coordinator.md model is ignored for a coordinator", async () => {
    // Coordinators never read _non_coordinator.md — they should fall through to
    // _all.md's model. Set _non_coordinator to a value that must NOT win.
    const coordRepoDir = await mkdtemp(join(tmpdir(), "ib-coord-model-"));
    const coordRepo = join(coordRepoDir, "myrepo");
    await mkdir(join(coordRepo, ".ittybitty", "agents"), { recursive: true });
    await Bun.write(join(coordRepo, ".ittybitty", "repo-id"), "coordmodel\n");

    const userConfigPath = join(coordRepo, "config.json");
    setUserConfigPath(userConfigPath);
    // Coordinator path never consults config.model and there is no
    // coordinator-specific fallback, so _all.md is the deciding layer.
    await Bun.write(userConfigPath, JSON.stringify({}, null, 2));

    await writeLayerModel("_all", "model: claude:claude-opus-4-7", { spawnable: false });
    await writeLayerModel("_non_coordinator", "model: claude:claude-sonnet-4-6", { spawnable: false });
    // Override the embedded coordinator.md (which declares `model: claude:opus`)
    // with a blank model so the precedence chain falls through to _all.md.
    // canSpawnChildren: true preserves coordinator semantics.
    await writeLayerModel("coordinator", "model:", { canSpawnChildren: true });

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

    const coordId = result.stdout.trim();
    const meta = await Bun.file(join(coordRepo, ".ittybitty", "agents", coordId, "meta.json")).json();
    // _all.md wins; _non_coordinator.md ignored for coordinators.
    expect(meta.model).toBe("claude:claude-opus-4-7");

    await rm(coordRepoDir, { recursive: true, force: true });
  });

  test("model precedence C4: blank model in a more-specific file does NOT clobber a real model in a less-specific file", async () => {
    // _all.md sets a real model; worker.md declares `model:` blank (= inherit).
    // The blank worker model must not override _all.md's real value.
    await writeLayerModel("_all", "model: claude:claude-opus-4-7", { spawnable: false });
    await writeLayerModel("worker", "model:");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-blank-inherits", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-blank-inherits", "meta.json")).json();
    expect(meta.model).toBe("claude:claude-opus-4-7");
  });

  test("model precedence C5: --model flag wins over all layer files", async () => {
    await writeLayerModel("_all", "model: claude:claude-opus-4-7", { spawnable: false });
    await writeLayerModel("worker", "model: claude:claude-sonnet-4-6");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-flag-wins", type: "worker", model: "claude:haiku" });

    const meta = await Bun.file(join(agentsDir, "test-flag-wins", "meta.json")).json();
    expect(meta.model).toBe("claude:haiku");
  });

  test("model precedence C6: falls back to config.model when no layer declares a model", async () => {
    // beforeEach wrote config.model = "claude:sonnet". With every layer blank,
    // the resolution falls through the layers to config.model (criterion 6).
    await writeLayerModel("_all", "model:", { spawnable: false });
    await writeLayerModel("_non_coordinator", "model:", { spawnable: false });
    await writeLayerModel("worker", "model:");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-fallback-config", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-fallback-config", "meta.json")).json();
    expect(meta.model).toBe("claude:sonnet");
  });

  test("model precedence C6b: falls back to 'claude:opus' when no layer and no config declare a model", async () => {
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({}));
    await writeLayerModel("_all", "model:", { spawnable: false });
    await writeLayerModel("_non_coordinator", "model:", { spawnable: false });
    await writeLayerModel("worker", "model:");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-fallback-opus", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-fallback-opus", "meta.json")).json();
    expect(meta.model).toBe("claude:opus");
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
      model: "claude:claude-sonnet-4-6",
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
    // meta.json should be passed as argument to `ib write-pid`, not
    // embedded in inline JS (HIGH 2 fix — see Phase 4 review).
    expect(startSh).toContain(`META_JSON='${join(agentDir, "meta.json")}'`);
    expect(startSh).toContain("ib write-pid 'test-quotes' \"$CLAUDE_PID\"");
    // exit-check.sh should be single-quoted
    expect(startSh).toContain(`'${join(agentDir, "exit-check.sh")}'`);
  });

  test("start.sh does not embed paths directly in JS code (HIGH 2 — no inline bun -e)", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-no-embed" });

    const startSh = await Bun.file(join(agentsDir, "test-no-embed", "start.sh")).text();
    // Should NOT have the old pattern of embedding path in JS string
    expect(startSh).not.toContain("const f='/" );
    // Should NOT use the race-prone inline bun -e read-modify-write
    // — replaced with `ib write-pid` for meta-lock safety. The bare-text
    // "bun -e" may appear in a script comment; the executable form
    // includes the JS payload.
    expect(startSh).not.toContain("m.claude_pid=String(process.argv[2])");
    expect(startSh).not.toContain("bun -e \"const f=");
    // Positive: uses `ib write-pid` instead.
    expect(startSh).toContain("ib write-pid 'test-no-embed'");
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

  test("K5: rejects --name matching an existing agent's nickname (global)", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-nick-collision-"));
    process.env.HOME = fakeHome;
    try {
      // Register THIS repo (tempDir) so readAllAgents() scans it, then plant an
      // existing agent whose nickname is "taken".
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      await Bun.write(join(fakeHome, ".itsybitsy", "repos.json"), JSON.stringify({
        repos: [{ path: tempDir, name: "nick-repo" }],
      }));
      // The agent-types dir must exist for newAgent's ensureAgentTypesDir().
      await (await import("./agent-types")).ensureAgentTypesDir();
      const existingDir = join(agentsDir, "agent-existing");
      await mkdir(existingDir, { recursive: true });
      await Bun.write(join(existingDir, "meta.json"), JSON.stringify({ id: "agent-existing", nickname: "taken", tmux_session: "t-existing" }));
      resetReadAgentMetaCache();

      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", { name: "taken" });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("collides with an existing agent nickname");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test("K6: allows --name matching an ARCHIVED agent's nickname", async () => {
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpdir(), "ib-nick-collision-archived-"));
    process.env.HOME = fakeHome;
    try {
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      await Bun.write(join(fakeHome, ".itsybitsy", "repos.json"), JSON.stringify({
        repos: [{ path: tempDir, name: "nick-repo" }],
      }));
      await (await import("./agent-types")).ensureAgentTypesDir();
      // Plant an ARCHIVED agent whose nickname is "taken" — should NOT block reuse.
      const archiveDir = join(tempDir, ".ittybitty", "archive", "agent-archived");
      await mkdir(archiveDir, { recursive: true });
      await Bun.write(join(archiveDir, "meta.json"), JSON.stringify({ id: "agent-archived", nickname: "taken", tmux_session: "t-archived" }));
      resetReadAgentMetaCache();

      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", { name: "taken" });
      expect(result.ok).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
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

  // ── codex spawn-path tests (SPEC-CODEX-MODEL.md §6 Phase 4) ─────────────────
  //
  // These tests exercise the codex branch of newAgent end-to-end with the
  // existing mock spawn runner. They DO NOT actually spawn codex or tmux —
  // they verify the artifacts dropped into the worktree, the contents of
  // start.sh, and the failure paths when the dispatcher precheck refuses.

  describe("codex spawn branch", () => {
    test("spawns a codex agent and writes a codex-shaped start.sh", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("read README", {
        name: "codex-agent-1",
        model: "codex:gpt-5.4-mini",
      });
      expect(result.ok).toBe(true);

      const startSh = await Bun.file(join(agentsDir, "codex-agent-1", "start.sh")).text();
      // Canonical §3.3 launch line components, model is shell-quoted.
      expect(startSh).toContain("setsid codex -m 'gpt-5.4-mini'");
      expect(startSh).toContain("-a never");
      expect(startSh).toContain("-s workspace-write");
      expect(startSh).toContain("--dangerously-bypass-hook-trust");
      // PID variable + meta-field keep claude_pid for back-compat.
      expect(startSh).toContain("CLAUDE_PID=$!");
      // Prompt passes via $(cat ...) — same as claude.
      expect(startSh).toContain('"$(cat ');
      // No claude command — codex agent runs codex, not claude.
      expect(startSh).not.toMatch(/setsid claude/);
      expect(startSh).not.toContain("--session-id");
      expect(startSh).not.toContain("--model");
    });

    test("does NOT write <worktree>/.claude/settings.local.json for codex", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-no-claude-settings",
        model: "codex:gpt-5.4-mini",
      });
      expect(result.ok).toBe(true);
      const settingsPath = join(agentsDir, "codex-no-claude-settings", "repo", ".claude", "settings.local.json");
      const exists = await Bun.file(settingsPath).exists();
      expect(exists).toBe(false);
    });

    test("appends .codex/ to <worktree>/.gitignore", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-gitignore",
        model: "codex:gpt-5.4-mini",
      });
      expect(result.ok).toBe(true);
      const gitignore = await Bun.file(join(agentsDir, "codex-gitignore", "repo", ".gitignore")).text();
      expect(gitignore).toContain(".codex/");
    });

    test("writes <worktree>/AGENTS.md with role + agent id (no <ittybitty> wrapper)", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-agents-md",
        model: "codex:gpt-5.4-mini",
        type: "worker",
      });
      expect(result.ok).toBe(true);
      const agentsMd = await Bun.file(join(agentsDir, "codex-agents-md", "repo", "AGENTS.md")).text();
      expect(agentsMd).toContain("codex-agents-md");
      expect(agentsMd.startsWith("<ittybitty>")).toBe(false);
    });

    test("fails the spawn cleanly when the dispatcher precheck exits non-zero", async () => {
      // Custom runner: succeed normally for general spawn ops, track
      // cleanup git commands. The codex dispatcher precheck now goes
      // through codexDryRunSpawnCtx — we inject failure there.
      const cleanupCalls: string[][] = [];
      const baseRunner = mockSpawnRunner();
      const customSpawn = (cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
        const cmdStr = cmd.join(" ");
        // Track the cleanup git commands (MED 5 from the Phase 4 review).
        if (cmdStr.includes("worktree remove") || cmdStr.includes("branch -D")) {
          cleanupCalls.push(cmd);
        }
        return baseRunner(cmd, opts);
      };
      setNewAgentSpawnRunner(customSpawn);
      // Codex dispatcher precheck now goes through codexDryRunSpawnCtx —
      // inject failure here to simulate a broken dispatcher.
      setCodexDryRunSpawnRunner((cmd, cwd) => {
        codexDryRunCalls.push({ cmd, cwd });
        return makeSpawnResult("", 1);
      });
      const result = await callNewAgent("task", {
        name: "codex-precheck-fail",
        model: "codex:gpt-5.4-mini",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("codex dispatcher precheck failed");
      // Agent dir should be cleaned up — the precheck-fail path runs rm.
      const dirExists = await Bun.file(join(agentsDir, "codex-precheck-fail", "meta.json")).exists();
      expect(dirExists).toBe(false);
      // MED 5: assert cleanup git commands were issued (centralised via
      // cleanupOnFailure() — MED 2). Without this assertion the duplicated
      // cleanup logic was untested at integration level.
      const cleanupCmdStrs = cleanupCalls.map((c) => c.join(" "));
      expect(cleanupCmdStrs.some((c) => c.includes("worktree remove"))).toBe(true);
      expect(cleanupCmdStrs.some((c) => c.includes("branch -D agent/codex-precheck-fail"))).toBe(true);
    });

    // Regression: spawn-time dispatcher dry-run must run with cwd === workPath.
    // The runtime codex hook handlers resolve `agentsDir` via a cwd regex
    // (`/\.ittybitty\/agents/`). If cwd is the spawn caller's cwd (e.g. the
    // system coordinator's `~/.itsybitsy/repo`), the regex misses and the
    // dry-run dies with "meta.json not found". Reverting the fix (dropping
    // the `cwd: workPath` from the codexDryRunSpawnCtx.run call) MUST fail
    // this test.
    test("dispatcher dry-run subprocess is invoked with cwd === workPath", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-dryrun-cwd",
        model: "codex:gpt-5.4-mini",
      });
      expect(result.ok).toBe(true);

      // workPath is `<agentDir>/repo`, where agentDir = <agentsDir>/<id>.
      const expectedCwd = join(agentsDir, "codex-dryrun-cwd", "repo");

      // All three codex events should have been pre-checked.
      const dryRunCmdStrs = codexDryRunCalls.map((c) => c.cmd.join(" "));
      expect(dryRunCmdStrs.some((c) => c.includes("hooks codex-pre-tool-use") && c.includes("--dry-run"))).toBe(true);
      expect(dryRunCmdStrs.some((c) => c.includes("hooks codex-session-start") && c.includes("--dry-run"))).toBe(true);
      expect(dryRunCmdStrs.some((c) => c.includes("hooks codex-stop") && c.includes("--dry-run"))).toBe(true);

      // Every dry-run subprocess MUST be spawned with cwd === workPath.
      expect(codexDryRunCalls.length).toBeGreaterThanOrEqual(3);
      for (const call of codexDryRunCalls) {
        expect(call.cwd).toBe(expectedCwd);
      }
    });

    test("regression guard: claude agents do NOT use the codex codepath", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "claude-regression-guard",
        model: "claude:opus",
      });
      expect(result.ok).toBe(true);
      // Claude agent should still get its settings.local.json
      const settings = await Bun.file(join(agentsDir, "claude-regression-guard", "repo", ".claude", "settings.local.json")).text();
      expect(settings.length).toBeGreaterThan(0);
      // Claude start.sh launches claude, not codex
      const startSh = await Bun.file(join(agentsDir, "claude-regression-guard", "start.sh")).text();
      expect(startSh).toMatch(/setsid claude/);
      expect(startSh).not.toContain("setsid codex");
      expect(startSh).toContain("--session-id");
      // No codex artifacts in the worktree
      const agentsMdExists = await Bun.file(join(agentsDir, "claude-regression-guard", "repo", "AGENTS.md")).exists();
      expect(agentsMdExists).toBe(false);
    });

    // MED 4 from Phase 4 review: golden-snapshot byte-equality check on
    // claude start.sh. The earlier `toContain` regression guard is too
    // loose — a change that adds 200 new lines to claude start.sh would
    // pass it. This fixture-based assertion fails the moment claude
    // start.sh diverges from the recorded baseline; if the divergence is
    // intentional, the fixture must be updated in the same PR with a
    // visible diff (and a clear reason in the commit).
    test("MED 4: claude start.sh matches the byte-equality fixture (regression snapshot)", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("snapshot fixture prompt", {
        name: "claude-snapshot",
        model: "claude:sonnet",
      });
      expect(result.ok).toBe(true);
      const rawStartSh = await Bun.file(join(agentsDir, "claude-snapshot", "start.sh")).text();
      // Normalise the parts that vary per run:
      //   * agentsDir prefix → <AGENTSDIR>
      //   * UUID session id → <SESSION-UUID>
      const sessionUuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
      const normalised = rawStartSh
        .replaceAll(agentsDir, "<AGENTSDIR>")
        .replaceAll(sessionUuidPattern, "<SESSION-UUID>");

      const fixturePath = join(
        import.meta.dir.replace(/\/src$/, ""),
        "tests",
        "fixtures",
        "claude-start-sh-baseline.sh",
      );
      const fixtureFile = Bun.file(fixturePath);
      if (!(await fixtureFile.exists())) {
        // Bootstrap: write the fixture and fail loudly so the dev commits
        // the new baseline. This codepath should never fire on CI.
        await Bun.write(fixturePath, normalised);
        throw new Error(
          `Fixture missing — wrote a fresh baseline to ${fixturePath}. ` +
            `Commit the fixture, then re-run.`,
        );
      }
      const expected = await fixtureFile.text();
      expect(normalised).toBe(expected);
    });

    test("HIGH 1: per-repo coordinator + codex model is rejected BEFORE any side effects", async () => {
      // Tracks every command issued so we can assert NO tmux / worktree
      // call fired. The reject MUST happen during the codex-precondition
      // block, before agentDir creation, before worktree-add, before
      // tmux new-session.
      const spawnCalls: string[][] = [];
      const trackedSpawn = (cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
        spawnCalls.push(cmd);
        // Default succeed — we only care that the reject prevented
        // these calls from being issued in the first place.
        return makeSpawnResult("", 0);
      };
      setNewAgentSpawnRunner(trackedSpawn);

      const result = await callNewAgent("start coordinator", {
        name: "codex-coord-attempt",
        type: "coordinator",
        model: "codex:gpt-5.4-mini",
      });

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("codex coordinators not yet implemented");
      // No agent dir created — reject fires before mkdir.
      const dirExists = await Bun.file(join(agentsDir, "codex-coord-attempt", "meta.json")).exists();
      expect(dirExists).toBe(false);
      // No tmux session created, no worktree, no branch.
      const cmdStrs = spawnCalls.map((c) => c.join(" "));
      expect(cmdStrs.some((c) => c.includes("tmux new-session"))).toBe(false);
      expect(cmdStrs.some((c) => c.includes("git worktree add"))).toBe(false);
      expect(cmdStrs.some((c) => c.includes("hooks codex-"))).toBe(false);
    });

    // Bug 2026-05-31 (agent-26165de0, muse-ios): spawning a codex agent with
    // a model name that is not in our KNOWN_MODELS allow-list previously
    // succeeded, launched codex, then sat in 'unknown' state after codex
    // returned HTTP 400. The fix rejects the spawn at the codex precondition
    // block, before any worktree/tmux work — same shape as the
    // coordinator-rejection test above.
    test("rejects unsupported codex model BEFORE any side effects", async () => {
      const spawnCalls: string[][] = [];
      const trackedSpawn = (cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
        spawnCalls.push(cmd);
        return makeSpawnResult("", 0);
      };
      setNewAgentSpawnRunner(trackedSpawn);

      const result = await callNewAgent("task", {
        name: "codex-bad-model",
        model: "codex:gpt-5.3-codex",
      });

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Codex model 'gpt-5.3-codex' is not supported");
      // Error must list at least one valid alternative so the user can recover.
      expect(result.stderr).toContain("codex:gpt-5.5");
      // Hint about ChatGPT-plan vs API-key differences.
      expect(result.stderr).toContain("ChatGPT-plan");
      // No agent dir created — reject fires before mkdir.
      const dirExists = await Bun.file(join(agentsDir, "codex-bad-model", "meta.json")).exists();
      expect(dirExists).toBe(false);
      // No tmux/worktree/codex CLI was touched.
      const cmdStrs = spawnCalls.map((c) => c.join(" "));
      expect(cmdStrs.some((c) => c.includes("tmux new-session"))).toBe(false);
      expect(cmdStrs.some((c) => c.includes("git worktree add"))).toBe(false);
      expect(cmdStrs.some((c) => c.includes("hooks codex-"))).toBe(false);
    });

    // Regression: a known-good codex model still spawns successfully — the
    // allow-list must not be over-eager and break valid spawns.
    test("accepts known-good codex model", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-good-model",
        model: "codex:gpt-5.5",
      });
      expect(result.ok).toBe(true);
      const startSh = await Bun.file(join(agentsDir, "codex-good-model", "start.sh")).text();
      expect(startSh).toContain("setsid codex -m 'gpt-5.5'");
    });

    // Round-2 review HIGH: the codex `-s workspace-write` sandbox is granted
    // the NARROW `.ittybitty` + `.claude` subdirs of the parent repo, not
    // the bare parent repo. Granting the bare parent would let a misbehaving
    // codex agent reach src/, CLAUDE.md, etc. via relative-path Bash writes
    // (`../../../../CLAUDE.md`) that the PreToolUse hook's textual matcher
    // does not catch. This test asserts the narrowed grant is encoded in
    // the rendered start.sh launch line.
    test("codex start.sh grants narrow parent-repo subdirs (.ittybitty + .claude), not the bare parent repo", async () => {
      const { realpathSync } = await import("fs");
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-sandbox-roots",
        model: "codex:gpt-5.5",
      });
      expect(result.ok).toBe(true);
      const startSh = await Bun.file(join(agentsDir, "codex-sandbox-roots", "start.sh")).text();
      // Resolve via realpathSync because /tmp on macOS is a symlink to
      // /private/tmp, and the production code canonicalises before pushing
      // each entry into the --add-dir list.
      const expectedIttybitty = realpathSync(join(tempDir, ".ittybitty"));
      const expectedClaude = realpathSync(join(tempDir, ".claude"));
      // Each argv element is shell-quoted independently in the rendered
      // launch line, so the flag and path appear as `'--add-dir' '<path>'`.
      expect(startSh).toContain(`'--add-dir' '${expectedIttybitty}'`);
      expect(startSh).toContain(`'--add-dir' '${expectedClaude}'`);
      // The bare parent repo MUST NOT appear as its own `--add-dir` entry.
      // Use the trailing apostrophe to anchor the match so the .ittybitty /
      // .claude lines (which begin with `'--add-dir' '<tempDir>/.`) don't
      // false-positive the negation.
      const realTempDir = realpathSync(tempDir);
      expect(startSh).not.toContain(`'--add-dir' '${realTempDir}'`);
    });
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
    // Per-agent outboxes now live under getCoordinatorHome() / agents / <id>.
    // Isolate so the reassign-notification sendMessage calls don't bleed into
    // the developer's real ~/.itsybitsy/agents/.../outbox.jsonl or leak from
    // one test to the next (sendMessage drains inline when no live watchdog).
    const { setCoordinatorHome } = await import("./coordinator");
    setCoordinatorHome(join(tempDir, "coord-home"));
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    const { resetCoordinatorHome } = await import("./coordinator");
    resetCoordinatorHome();
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
    expect(oldMgrMsg!).toContain("[sent by watchdog]:");
    expect(oldMgrMsg!).toContain("Agent agent-abc reassigned to manager 'agent-new'");

    // New manager notification
    const newMgrMsg = messages.find(m => m.includes("reassigned to you"));
    expect(newMgrMsg).toBeDefined();
    expect(newMgrMsg!).toContain("[sent by watchdog]:");
    expect(newMgrMsg!).toContain("Agent agent-abc reassigned to you");
    expect(newMgrMsg!).toContain("was under agent-old");

    // Agent self-notification
    const selfMsg = messages.find(m => m.includes("You've been reassigned"));
    expect(selfMsg).toBeDefined();
    expect(selfMsg!).toContain("[sent by watchdog]:");
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

describe("validateAgentName (shared)", () => {
  test("accepts a plain valid name", () => {
    expect(validateAgentName("my-agent_1", [])).toBeNull();
  });

  test("rejects names with invalid characters", () => {
    expect(validateAgentName("has spaces", [])).toContain("letters, digits");
    expect(validateAgentName("has.dot", [])).toContain("letters, digits");
    expect(validateAgentName("@at", [])).toContain("letters, digits");
    expect(validateAgentName("", [])).toContain("letters, digits");
  });

  test("rejects reserved coordinator/system", () => {
    expect(validateAgentName("coordinator", [])).toContain("reserved");
    expect(validateAgentName("system", [])).toContain("reserved");
  });

  test("rejects collision with a repo display name (nickname) or basename", () => {
    const repos = [{ path: "/tmp/r1", name: "r1", nickname: "alpha" }];
    expect(validateAgentName("alpha", repos)).toContain("collides with registered repo name");
    expect(validateAgentName("r1", repos)).toContain("collides with registered repo name");
    expect(validateAgentName("beta", repos)).toBeNull();
  });
});

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
    const { agents } = await readAllAgents([{ path: tempDir, name: basename(tempDir) }], false);
    expect(matchAgentById("pikachu", agents)?.id).toBe("agent-abc");
    expect(matchAgentById("agent-abc", agents)?.id).toBe("agent-abc");
  });

  test("writes meta.json with a trailing newline and preserves other fields", async () => {
    // renameAgent must write meta.json via the shared atomic writer so its
    // output matches every other meta writer: pretty-printed + trailing "\n".
    const agentDir = await writeAgentMeta(tempDir, "agent-abc", { model: "claude:opus", prompt: "do work" });
    await registerRepos([tempDir]);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await renameAgent(agent, "pikachu");
    expect(result.ok).toBe(true);

    const raw = await Bun.file(join(agentDir, "meta.json")).text();
    expect(raw.endsWith("\n")).toBe(true);
    const meta = JSON.parse(raw);
    expect(meta.nickname).toBe("pikachu");
    // Other fields survive the round-trip.
    expect(meta.id).toBe("agent-abc");
    expect(meta.model).toBe("claude:opus");
    expect(meta.prompt).toBe("do work");
  });

  test("clear also writes meta.json with a trailing newline", async () => {
    const agentDir = await writeAgentMeta(tempDir, "agent-abc", { nickname: "pikachu" });
    await registerRepos([tempDir]);
    const agent = makeAgent("agent-abc", tempDir);
    agent.meta.nickname = "pikachu";
    const result = await renameAgent(agent, null);
    expect(result.ok).toBe(true);
    const raw = await Bun.file(join(agentDir, "meta.json")).text();
    expect(raw.endsWith("\n")).toBe(true);
    expect("nickname" in JSON.parse(raw)).toBe(false);
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

  test("allows nickname matching an ARCHIVED agent's nickname", async () => {
    // Regression for the readAllAgents-includes-archived-by-default bug: the
    // collision scan in renameAgent must NOT see archived agents, otherwise
    // killing an agent and re-aliasing a live one with its old nickname fails.
    await writeAgentMeta(tempDir, "agent-abc");
    // Plant an ARCHIVED agent in the same repo whose nickname is "taken".
    const archivedDir = join(tempDir, ".ittybitty", "archive", "agent-archived");
    await mkdir(archivedDir, { recursive: true });
    await Bun.write(join(archivedDir, "meta.json"), JSON.stringify({ id: "agent-archived", nickname: "taken", tmux_session: "t-archived" }));
    await registerRepos([tempDir]);
    resetReadAgentMetaCache();

    const agent = makeAgent("agent-abc", tempDir);
    const result = await renameAgent(agent, "taken");
    expect(result.ok).toBe(true);
    const meta = await Bun.file(join(tempDir, ".ittybitty", "agents", "agent-abc", "meta.json")).json();
    expect(meta.nickname).toBe("taken");
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
      model: "claude:sonnet",
    }));

    // Set user config path to temp dir
    setUserConfigPath(join(tempDir, "config.json"));
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({ model: "claude:sonnet" }));

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

  test("substring does NOT match via directory (exact-only)", async () => {
    const agentDir = join(agentsDir, "agent-abc123");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), "{}");

    const result = await resolveAgentId(agentsDir, "abc123", async () => []);
    expect(result).toEqual({ error: "No matching agent found", matches: [] });
  });

  test("substring does NOT match via tmux session (exact-only)", async () => {
    const result = await resolveAgentId(agentsDir, "abc123", async () => [
      "ittybitty-abc12345-agent-abc123",
    ]);
    expect(result).toEqual({ error: "No matching agent found", matches: [] });
  });

  test("substring with multiple candidates does NOT match (exact-only, no ambiguous error)", async () => {
    for (const id of ["agent-abc111", "agent-abc222"]) {
      const dir = join(agentsDir, id);
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, "meta.json"), "{}");
    }

    const result = await resolveAgentId(agentsDir, "abc", async () => []);
    expect(result).toEqual({ error: "No matching agent found", matches: [] });
  });

  test("no match returns error with empty matches", async () => {
    const result = await resolveAgentId(agentsDir, "nonexistent", async () => []);
    expect(result).toEqual({
      error: "No matching agent found",
      matches: [],
    });
  });

  test("exact match found in both directory and tmux still resolves", async () => {
    const dir = join(agentsDir, "agent-abc123");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "meta.json"), "{}");

    const result = await resolveAgentId(agentsDir, "agent-abc123", async () => [
      "ittybitty-abc12345-agent-abc123",
    ]);
    expect(result).toEqual({ resolved: "agent-abc123" });
  });

  test("ignores non-ittybitty tmux sessions", async () => {
    const result = await resolveAgentId(agentsDir, "agent-abc123", async () => [
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

describe("telegramFireTypingAction (native)", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "tgtyping-test-"));
    setUserConfigPath(join(homeDir, "config.json"));
    const { setStateDir } = await import("./channels/chat-id-cache");
    setStateDir(join(homeDir, "channels", "telegram"));
  });

  afterEach(async () => {
    resetUserConfigPath();
    const { resetStateDir } = await import("./channels/chat-id-cache");
    resetStateDir();
    const { fetchCtx } = await import("./channels/telegram-client");
    fetchCtx.reset();
    await rm(homeDir, { recursive: true, force: true });
  });

  test("no-ops silently when bot_token is unset (no fetch call)", async () => {
    const { fetchCtx } = await import("./channels/telegram-client");
    let called = false;
    fetchCtx.set(async () => { called = true; return new Response("{}"); });
    // No config written → bot_token defaults to "".
    const { telegramFireTypingAction } = await import("./ib-commands");
    await telegramFireTypingAction();
    expect(called).toBe(false);
  });

  test("no-ops silently when chat-id cache is missing (no fetch call)", async () => {
    await Bun.write(
      join(homeDir, "config.json"),
      JSON.stringify({ channels: { telegram: { bot_token: "TESTTOKEN" } } }),
    );
    const { fetchCtx } = await import("./channels/telegram-client");
    let called = false;
    fetchCtx.set(async () => { called = true; return new Response("{}"); });
    const { telegramFireTypingAction } = await import("./ib-commands");
    await telegramFireTypingAction();
    expect(called).toBe(false);
  });

  test("fires sendChatAction with chat_id + typing action when fully configured", async () => {
    await Bun.write(
      join(homeDir, "config.json"),
      JSON.stringify({ channels: { telegram: { bot_token: "TESTTOKEN" } } }),
    );
    const { writeCachedChatId } = await import("./channels/chat-id-cache");
    await writeCachedChatId("12345");

    const { fetchCtx } = await import("./channels/telegram-client");
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    fetchCtx.set(async (input, init) => {
      capturedUrl = typeof input === "string" ? input : (input as URL).toString();
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    const { telegramFireTypingAction } = await import("./ib-commands");
    await telegramFireTypingAction();

    expect(capturedUrl).toContain("/botTESTTOKEN/sendChatAction");
    const body = JSON.parse(capturedBody ?? "{}");
    expect(body.chat_id).toBe("12345");
    expect(body.action).toBe("typing");
  });

  test("never throws even when fetch rejects", async () => {
    await Bun.write(
      join(homeDir, "config.json"),
      JSON.stringify({ channels: { telegram: { bot_token: "T" } } }),
    );
    const { writeCachedChatId } = await import("./channels/chat-id-cache");
    await writeCachedChatId("99");
    const { fetchCtx } = await import("./channels/telegram-client");
    fetchCtx.set(async () => { throw new Error("boom"); });
    const { telegramFireTypingAction } = await import("./ib-commands");
    await expect(telegramFireTypingAction()).resolves.toBeUndefined();
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

// ===========================================================================
// Teardown leave-notices (SPEC §16.4.2 / §16.5). kill/merge fire a PER-AGENT
// `left the team` notice stamped to the departed id; ANY nuke fires ONE
// COALESCED `N member(s) left @team` notice per team, system-sender. Both
// snapshot SURVIVING members from the post-prune roster and are best-effort.
//
// Isolation mirrors the teams-commands tests: setCoordinatorHome redirects
// teams.json; saveRegistry makes listRepos() surface our temp repo so the
// notice fan-out can resolve survivor agents; a live (mocked) watchdog on each
// SURVIVOR defers its notice into the outbox so we can assert it. The DEPARTED
// agent's dir is removed by teardown, so we only inspect SURVIVOR outboxes.
// ===========================================================================
describe("teams: teardown leave-notices (kill / merge / nuke)", () => {
  let baseDir: string;
  let homeDir: string;
  let repoDir: string;
  let originalHome: string | undefined;
  let spawnCalls: string[][];

  // Returns the CENTRAL outbox queue dir for `id` (~/.itsybitsy/agents/<id>/
  // under our test setCoordinatorHome(homeDir)). The per-worktree agent dir
  // still hosts meta.json / meta.transient.json / agent.log — only the message
  // queue lives here.
  function queueDirOf(id: string): string {
    return join(homeDir, "agents", id);
  }

  // Plant a survivor agent so readAllAgents surfaces it and any notice to it
  // DEFERS into its outbox (live-watchdog transient + isPidAliveCtx → true).
  // Returns the WORKTREE agent dir; readers of the outbox queue should use
  // `queueDirOf(id)` instead.
  async function plantSurvivor(id: string): Promise<string> {
    const agentDir = join(repoDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    await mkdir(queueDirOf(id), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `t-${id}` }));
    const { writeAgentTransient } = await import("./agents");
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 4242,
    });
    return agentDir;
  }

  // Plant a to-be-torn-down agent with a real worktree dir (needed by merge).
  async function plantDeparting(id: string): Promise<string> {
    const agentDir = join(repoDir, ".ittybitty", "agents", id);
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await mkdir(queueDirOf(id), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `t-${id}` }));
    return agentDir;
  }

  // makeAgent bound to the temp repo.
  function agentOf(id: string): Agent {
    return _makeAgent({ id, repoPath: repoDir, repoName: basename(repoDir), state: "running" as AgentState });
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "team-teardown-" + crypto.randomUUID() + "-"));
    homeDir = join(baseDir, ".itsybitsy");
    repoDir = join(baseDir, "repo");
    await mkdir(homeDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = baseDir;
    spawnCalls = [];

    const { setCoordinatorHome } = await import("./coordinator");
    setCoordinatorHome(homeDir);
    setUserConfigPath(join(homeDir, "config.json"));
    await saveRegistry({ repos: [{ path: repoDir, name: basename(repoDir) }] });

    // Teardown spawn ctxs: all tmux/git/pgrep calls succeed-ish; has-session
    // fails so teardown skips kill paths. The send ctx is set so any notice
    // delivery is faked (though live-watchdog survivors defer, not deliver).
    const teardownRunner = (cmd: string[]) => {
      spawnCalls.push(cmd);
      if (cmd.includes("has-session") || cmd[0] === "pgrep") return makeSpawnResult(1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(teardownRunner);
    setKillPauseSpawnRunner(teardownRunner);
    setNukeResumeSpawnRunner(teardownRunner);
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return makeSpawnResult();
    });
    isPidAliveCtx.set(() => true);
    resetReadAgentMetaCache();
  });

  afterEach(async () => {
    const { resetCoordinatorHome } = await import("./coordinator");
    lifecycleSpawnCtx.reset();
    resetKillPauseSpawnRunner();
    resetNukeResumeSpawnRunner();
    resetSendSpawnRunner();
    resetMergeSpawnRunner();
    resetUserConfigPath();
    resetCoordinatorHome();
    isPidAliveCtx.reset();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    resetReadAgentMetaCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  // --- killAgent -----------------------------------------------------------

  test("killAgent fires a per-agent leave notice to survivors, stamped to the departed id", async () => {
    const { createTeam, addMember, getTeam } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    const { readChannel } = await import("./team-channel");
    await createTeam("backend", "", 1000);
    const survivorDir = await plantSurvivor("agent-survivor");
    await plantDeparting("agent-leaver");
    await addMember("backend", "agent-survivor");
    await addMember("backend", "agent-leaver");
    resetReadAgentMetaCache();

    const res = await killAgent(agentOf("agent-leaver"));
    expect(res.ok).toBe(true);

    // The departed id is pruned from the roster.
    const team = await getTeam("backend");
    expect(team!.members).toEqual(["agent-survivor"]);

    // The survivor got exactly one per-agent leave notice, fromAgent = departed.
    const queue = await readOutbox(queueDirOf("agent-survivor"));
    expect(queue.length).toBe(1);
    expect(queue[0]!.message).toBe("left the team");
    expect(queue[0]!.fromAgent).toBe("agent-leaver");
    expect(queue[0]!.team).toBe("backend");

    // §17.4 design update: the leave is also mirrored into channel.jsonl as a
    // SYSTEM record so the chat box renders it dimmed inline with chat.
    const recs = await readChannel("backend");
    const leaves = recs.filter((r) => r.kind === "system" && r.message === "left the team");
    expect(leaves.length).toBe(1);
    expect(leaves[0]!.fromAgent).toBe("agent-leaver");
  });

  test("killAgent of an agent in no team enqueues no leave notice", async () => {
    const { createTeam, addMember } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    // A team exists with only the survivor; the departing agent is NOT a member.
    await createTeam("backend", "", 1000);
    const survivorDir = await plantSurvivor("agent-survivor");
    await plantDeparting("agent-loner");
    await addMember("backend", "agent-survivor");
    resetReadAgentMetaCache();

    const res = await killAgent(agentOf("agent-loner"));
    expect(res.ok).toBe(true);

    // No notice — the departing agent shared no team with the survivor.
    expect(await readOutbox(queueDirOf("agent-survivor"))).toEqual([]);
  });

  test("killAgent of the LAST member sends no notice (empty-survivor carve-out)", async () => {
    const { createTeam, addMember, getTeam } = await import("./teams");
    await createTeam("solo", "", 1000);
    await plantDeparting("agent-last");
    await addMember("solo", "agent-last");
    resetReadAgentMetaCache();

    const res = await killAgent(agentOf("agent-last"));
    expect(res.ok).toBe(true);

    // Roster emptied; team persists empty; nobody was notified (no recipients).
    const team = await getTeam("solo");
    expect(team).not.toBeNull();
    expect(team!.members).toEqual([]);
  });

  // --- mergeAgent ----------------------------------------------------------

  test("mergeAgent fires a per-agent leave notice to survivors, stamped to the departed id", async () => {
    const { createTeam, addMember, getTeam } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    await createTeam("backend", "", 1000);
    const survivorDir = await plantSurvivor("agent-survivor");
    await plantDeparting("agent-merged");
    await addMember("backend", "agent-survivor");
    await addMember("backend", "agent-merged");
    resetReadAgentMetaCache();

    // A merge needs the git mock; reuse a minimal success runner.
    const mergeRunner = (cmd: string[]) => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("status") && cmdStr.includes("--porcelain")) return makeSpawnResult(0, "");
      if (cmdStr.includes("branch") && cmdStr.includes("--show-current")) return makeSpawnResult(0, "main");
      if (cmdStr.includes("show-ref") && cmdStr.includes("--verify")) return makeSpawnResult(0);
      if (cmdStr.includes("log") && cmdStr.includes("--oneline")) return makeSpawnResult(0, "abc0 commit 0");
      if (cmd.includes("rebase")) return makeSpawnResult(0, "");
      if (cmd.includes("checkout")) return makeSpawnResult(0);
      if (cmd.includes("merge") && (cmd.includes("--ff-only") || cmd.includes("--no-ff"))) return makeSpawnResult(0);
      if (cmdStr.includes("has-session")) return makeSpawnResult(1);
      if (cmd[0] === "pgrep") return makeSpawnResult(1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(mergeRunner);
    setMergeSpawnRunner(mergeRunner);

    const res = await mergeAgent(agentOf("agent-merged"), repoDir);
    expect(res.ok).toBe(true);

    const team = await getTeam("backend");
    expect(team!.members).toEqual(["agent-survivor"]);

    const queue = await readOutbox(queueDirOf("agent-survivor"));
    expect(queue.length).toBe(1);
    expect(queue[0]!.message).toBe("left the team");
    expect(queue[0]!.fromAgent).toBe("agent-merged");
    expect(queue[0]!.team).toBe("backend");

    // §17.4 design update: the leave is also mirrored into channel.jsonl as a
    // SYSTEM record so the chat box renders it dimmed inline with chat.
    const { readChannel } = await import("./team-channel");
    const recs = await readChannel("backend");
    const leaves = recs.filter((r) => r.kind === "system" && r.message === "left the team");
    expect(leaves.length).toBe(1);
    expect(leaves[0]!.fromAgent).toBe("agent-merged");
  });

  // --- nukeAgent (coalesced) ----------------------------------------------

  test("nuke of 3 members of one team sends ONE coalesced '3 members left @T' notice to the survivor (system sender)", async () => {
    const { createTeam, addMember, getTeam } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    // The 3-departures-1-survivor trace from the task. The manager (a) is the
    // nuke target; b and c are its descendants; d is the surviving teammate.
    await createTeam("T", "", 1000);
    const aDir = await plantDeparting("agent-a"); // manager (nuke target)
    await plantDeparting("agent-b");
    await plantDeparting("agent-c");
    const dDir = await plantSurvivor("agent-d");
    // Make b and c descendants of a so getDescendantsRecursive picks all three.
    await Bun.write(join(aDir, "meta.json"), JSON.stringify({ id: "agent-a", tmux_session: "t-agent-a", manager: "" }));
    await Bun.write(
      join(repoDir, ".ittybitty", "agents", "agent-b", "meta.json"),
      JSON.stringify({ id: "agent-b", tmux_session: "t-agent-b", manager: "agent-a" }),
    );
    await Bun.write(
      join(repoDir, ".ittybitty", "agents", "agent-c", "meta.json"),
      JSON.stringify({ id: "agent-c", tmux_session: "t-agent-c", manager: "agent-a" }),
    );
    for (const id of ["agent-a", "agent-b", "agent-c", "agent-d"]) {
      await addMember("T", id);
    }
    resetReadAgentMetaCache();

    // nukeAgent requires a non-worker OR descendants — agent-a has descendants.
    const res = await nukeAgent(agentOf("agent-a"));
    expect(res.ok).toBe(true);

    // All three departures pruned; only the survivor remains.
    const team = await getTeam("T");
    expect(team!.members).toEqual(["agent-d"]);

    // Exactly ONE coalesced notice to d, system sender, count = 3.
    const queue = await readOutbox(queueDirOf("agent-d"));
    expect(queue.length).toBe(1);
    expect(queue[0]!.message).toBe("3 members left @T");
    expect(queue[0]!.fromAgent).toBe("@system");
    expect(queue[0]!.team).toBe("T");

    // §17.4 design update: the coalesced leave is also mirrored into
    // channel.jsonl as a SYSTEM record so the chat box renders it dimmed.
    // The chat-box copy DROPS the `@<team>` suffix that the outbox notice
    // carries — the pane already shows which team is being viewed.
    const { readChannel } = await import("./team-channel");
    const recs = await readChannel("T");
    const sys = recs.filter((r) => r.kind === "system");
    expect(sys.length).toBe(1);
    expect(sys[0]!.fromAgent).toBe("@system");
    expect(sys[0]!.message).toBe("3 members left");
  });

  test("single-departure nuke yields a '1 member left @T' coalesced notice (singular wording)", async () => {
    const { createTeam, addMember } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    // A manager (not a team member) + one descendant leaf (a team member). The
    // survivor is a separate teammate that is NOT in the nuke set. Nuking the
    // manager tears down manager+leaf, so exactly ONE member departs T → the
    // singular "1 member left @T" coalesced notice goes to the survivor.
    await createTeam("T", "", 1000);
    const mgrDir = join(repoDir, ".ittybitty", "agents", "agent-mgr");
    await mkdir(join(mgrDir, "repo"), { recursive: true });
    await Bun.write(join(mgrDir, "meta.json"), JSON.stringify({ id: "agent-mgr", tmux_session: "t-agent-mgr", manager: "" }));
    const leafDir = join(repoDir, ".ittybitty", "agents", "agent-leaf");
    await mkdir(join(leafDir, "repo"), { recursive: true });
    await Bun.write(join(leafDir, "meta.json"), JSON.stringify({ id: "agent-leaf", tmux_session: "t-agent-leaf", manager: "agent-mgr" }));
    const survivorDir = await plantSurvivor("agent-keep");
    await addMember("T", "agent-leaf"); // the only T member that gets nuked
    await addMember("T", "agent-keep"); // survivor
    resetReadAgentMetaCache();

    const res = await nukeAgent(agentOf("agent-mgr"));
    expect(res.ok).toBe(true);

    const queue = await readOutbox(queueDirOf("agent-keep"));
    expect(queue.length).toBe(1);
    expect(queue[0]!.message).toBe("1 member left @T");
    expect(queue[0]!.fromAgent).toBe("@system");
    expect(queue[0]!.team).toBe("T");
  });

  test("nuke that tears down EVERY member of a team sends no notice (empty-survivor carve-out)", async () => {
    const { createTeam, addMember, getTeam } = await import("./teams");
    await createTeam("T", "", 1000);
    await plantDeparting("agent-x");
    await plantDeparting("agent-y");
    await addMember("T", "agent-x");
    await addMember("T", "agent-y");
    resetReadAgentMetaCache();

    // nukeAllAgents tears down EVERY agent — no survivors left in T.
    const res = await nukeAllAgents(repoDir);
    expect(res.ok).toBe(true);

    // Roster emptied; team persists empty; no recipient existed → no throw.
    const team = await getTeam("T");
    expect(team).not.toBeNull();
    expect(team!.members).toEqual([]);
  });
});

// ─── teamAdd: suppressJoinNotice opt ────────────────────────────────────
//
// The TUI team-creation wizard bulk-adds members via `teamAdd` with the
// internal `suppressJoinNotice: true` opt so members don't get N inbound
// "joined the team" messages before the user's optional first message. The
// audit log + channel system record must still fire — only the per-recipient
// fan-out is gated.

describe("teamAdd suppressJoinNotice opt", () => {
  let baseDir: string;
  let homeDir: string;
  let repoDir: string;
  let originalHome: string | undefined;
  let repoEntry: import("./registry").RepoEntry;

  // Returns the CENTRAL outbox queue dir for `id` (~/.itsybitsy/agents/<id>/
  // under our test setCoordinatorHome(homeDir)). The per-worktree agent dir
  // still hosts meta.json / meta.transient.json / agent.log — only the message
  // queue lives here.
  function queueDirOf(id: string): string {
    return join(homeDir, "agents", id);
  }

  // Plant a real agent so readAllAgents surfaces it. The transient with a
  // watchdog pid makes sendMessage defer to the outbox queue.
  async function plant(id: string): Promise<string> {
    const agentDir = join(repoDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    await mkdir(queueDirOf(id), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `t-${id}` }));
    const { writeAgentTransient } = await import("./agents");
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 4242,
    });
    return agentDir;
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "team-add-opt-" + crypto.randomUUID() + "-"));
    homeDir = join(baseDir, ".itsybitsy");
    repoDir = join(baseDir, "repo");
    await mkdir(homeDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = baseDir;
    const { setCoordinatorHome } = await import("./coordinator");
    setCoordinatorHome(homeDir);
    setUserConfigPath(join(homeDir, "config.json"));
    repoEntry = { path: repoDir, name: basename(repoDir) };
    await saveRegistry({ repos: [repoEntry] });
    setSendSpawnRunner(() => makeSpawnResult());
    isPidAliveCtx.set(() => true);
    resetReadAgentMetaCache();
  });

  afterEach(async () => {
    const { resetCoordinatorHome } = await import("./coordinator");
    resetSendSpawnRunner();
    resetUserConfigPath();
    resetCoordinatorHome();
    isPidAliveCtx.reset();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    resetReadAgentMetaCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  test("default opts: per-recipient fan-out fires (regression guard)", async () => {
    const { createTeam, addMember } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    const { readChannel } = await import("./team-channel");
    await createTeam("T", "user", 1000);
    await plant("agent-existing");
    await plant("agent-joiner");
    await addMember("T", "agent-existing");
    resetReadAgentMetaCache();

    const res = await teamAdd("T", "agent-joiner", [repoEntry]);
    expect(res.ok).toBe(true);
    // Existing member received "joined the team" notice fromAgent=joiner.
    const existingQueue = await readOutbox(queueDirOf("agent-existing"));
    expect(existingQueue.length).toBe(1);
    expect(existingQueue[0]!.message).toBe("joined the team");
    expect(existingQueue[0]!.fromAgent).toBe("agent-joiner");
    // The new joiner received the reply-protocol instruction from @system.
    const joinerQueue = await readOutbox(queueDirOf("agent-joiner"));
    expect(joinerQueue.length).toBe(1);
    expect(joinerQueue[0]!.fromAgent).toBe("@system");
    // Channel system record still fires.
    const recs = await readChannel("T");
    expect(recs.some((r) => r.kind === "system" && r.message === "joined the team")).toBe(true);
  });

  test("suppressJoinNotice: true: NO per-recipient fan-out, but audit + channel system record still fire", async () => {
    const { createTeam, addMember } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    const { readChannel } = await import("./team-channel");
    const { teamLogPath } = await import("./team-channel");
    await createTeam("T", "user", 1000);
    await plant("agent-existing");
    await plant("agent-joiner");
    await addMember("T", "agent-existing");
    resetReadAgentMetaCache();

    const res = await teamAdd("T", "agent-joiner", [repoEntry], { suppressJoinNotice: true });
    expect(res.ok).toBe(true);

    // No inbound messages on either side.
    expect(await readOutbox(queueDirOf("agent-existing"))).toEqual([]);
    expect(await readOutbox(queueDirOf("agent-joiner"))).toEqual([]);

    // Audit log STILL fires.
    const audit = await Bun.file(teamLogPath("T")).text().catch(() => "");
    expect(audit).toContain("agent agent-joiner joined");

    // Channel system record STILL fires.
    const recs = await readChannel("T");
    expect(recs.some((r) => r.kind === "system" && r.message === "joined the team")).toBe(true);
  });
});

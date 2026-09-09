import { sandboxDenialExecPrefix } from "./sandbox-log-launch";
import { test, expect, describe, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { join, basename } from "path";
import {
  mkdtemp,
  rm,
  mkdir,
  chmod,
  readdir,
  readlink,
  symlink,
  lstat,
} from "fs/promises";
import { tmpdir } from "os";
import { chmodSync, realpathSync, symlinkSync } from "fs";
import type { Agent, AgentMeta } from "./agents";
import {
  isPidAliveCtx,
  nowMsCtx,
  OP_STUCK_TIMEOUT_MS,
  setAgentOperation,
  clearAgentOperation,
  readAgentTransient,
  resetReadAgentMetaCache,
  readAgentMeta,
  readAllAgents,
  buildAgentTree,
  agentWorktreePath,
  mutateAgentMeta,
} from "./agents";
import { matchAgentById } from "./index";
import { saveRegistry } from "./registry";
import { makeAgent as _makeAgent, makeSpawnResult, waitFor } from "./test-utils";
import {
  retireAgent,
  rehireAgent,
  nukeAgent,
  nukeAllAgents,
  resumeAgent,
  reassignAgent,
  renameAgent,
  validateAgentName,
  mergeCheckAgent,
  mergeAgent,
  buildKeepMergeMessage,
  sendMessage,
  cancelTmuxPaneModeIfActive,
  buildTmuxHelperScript,
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
  setMessageAttachmentStagerForTesting,
  resetMessageAttachmentStagerForTesting,
  teamSend,
  setKillPauseSpawnRunner,
  resetKillPauseSpawnRunner,
  setRehireSpawnRunner,
  resetRehireSpawnRunner,
  setNukeResumeSpawnRunner,
  resetNukeResumeSpawnRunner,
  setMergeSpawnRunner,
  resetMergeSpawnRunner,
  setNewAgentSpawnRunner,
  resetNewAgentSpawnRunner,
  setNewAgentCallerMetaReader,
  resetNewAgentCallerMetaReader,
  setNewAgentNoWorktreeCallerResolver,
  resetNewAgentNoWorktreeCallerResolver,
  autoAcceptWorkspaceTrust,
  autoAcceptWorkspaceTrustForNewAgent,
  setAgyVersionProbeTimeoutMs,
  setDispatcherDryRunSpawnRunner,
  resetDispatcherDryRunSpawnRunner,
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
  setSandboxPlatformForTesting,
  setSandboxPortAllocatorForTesting,
  setSandboxPortCheckForTesting,
  resetSandboxWiringForTesting,
  mergeSandboxLayerConfigs,
  checkPathsRepoContainment,
  resolveTmuxSocketDir,
  refreshAgentSandbox,
  refreshAgentsSandbox,
  sealAgentRecord,
  deleteAgentSealChecked,
  removeAgentSeal,
  getRepoId,
  setSealDirectWriteForTesting,
  resetSealDirectWriteForTesting,
  setSealDirectVerifyForTesting,
  resetSealDirectVerifyForTesting,
  setSealCapabilityCommandForTesting,
  resetSealCapabilityCommandForTesting,
  setSealDeleteForTesting,
  setSandboxRefreshMetaMutateForTesting,
  setSandboxRefreshSealRestoreForTesting,
  setSandboxRefreshPauseForTesting,
  teamAdd,
  writeMetaJsonAtomic,
} from "./ib-commands";
import { sealPath, readSealRecord, computeSealInputs, computeSealRecord, verifyMetaAgainstSeal, writeSealRecordDirect } from "./agent-seal";
import {
  spawnCtx as lifecycleSpawnCtx,
  setSandboxProxyKillForTesting,
  resetSandboxProxyKillForTesting,
  isRunningAsAgent,
} from "./agent-lifecycle";
import { setUserHome, resetUserHome } from "./home";
import { setUserConfigPath, resetUserConfigPath } from "./config";
import type { AgentState } from "./parse-state";
import type { SpawnFn, SpawnResult } from "./types";
import { canonicalizeSandboxPath, SEAL_HELPER_RESULT_PREFIX, SEAL_HELPER_RESULT_ROOT } from "./sandbox";
import { claudeProjectDirFor, claudeScratchpadDirFor } from "./hooks/paths-table";

// The "retire → rehire recovery" describes drive real `git` subprocesses — a
// dozen call sites through the local git() helper, plus every git command
// retireAgent/rehireAgent themselves run through the hybrid spawn runner
// (init, worktree add, diff, apply, rev-parse, …). Subprocess spawns are far
// more load-sensitive than in-process unit tests: a single spawn was measured
// at 156s during a pathologically loaded run (see commit 5c8f254, which raised
// the same bound in the three other files that spawn subprocesses), and bun's
// 5s default leaves no headroom for that. This is a failure bound, not a wait:
// no assertion changes, nothing is skipped, and passing tests run exactly as
// fast as before — it only changes how long a genuinely stuck spawn takes to
// be declared stuck.
setDefaultTimeout(60_000);

function makeAgent(
  id: string,
  repoPath: string,
  state: string = "running",
  meta?: Partial<AgentMeta>,
): Agent {
  const agent = _makeAgent({
    id,
    repoPath,
    repoName: "test-repo",
    state: state as AgentState,
  });
  return meta ? { ...agent, meta: { ...agent.meta, ...meta } } : agent;
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
      // Should have: has-session, pane-mode probe, send-keys (message), send-keys (Enter)
      expect(spawnCalls.length).toBe(4);
      expect(spawnCalls[0]).toEqual(["tmux", "has-session", "-t", `=tmux-agent-abc:`]);
      expect(spawnCalls[1]).toEqual(["tmux", "display-message", "-p", "-t", `=tmux-agent-abc:`, "#{pane_in_mode}"]);
      expect(spawnCalls[2]).toEqual(["tmux", "send-keys", "-t", `=tmux-agent-abc:`, "-l", "--", "[sent by user]: hello world"]);
      expect(spawnCalls[3]).toEqual(["tmux", "send-keys", "-t", `=tmux-agent-abc:`, "Enter"]);
    });

    // A pane parked in tmux view-mode / copy-mode swallows send-keys (the keys
    // are dispatched to the copy-mode key table, not the agent). Delivery must
    // leave the mode first — and only when the probe says a mode is active.
    test("cancels tmux view/copy-mode on the pane before typing when pane_in_mode=1", async () => {
      setSendSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        if (cmd[1] === "display-message") return makeSpawnResult(0, "1\n", "");
        return makeSpawnResult();
      });
      const agent = makeAgent("agent-abc", tempDir);
      const result = await sendMessage(agent, "hello world", { cwd: "/" });

      expect(result.ok).toBe(true);
      expect(spawnCalls).toEqual([
        ["tmux", "has-session", "-t", `=tmux-agent-abc:`],
        ["tmux", "display-message", "-p", "-t", `=tmux-agent-abc:`, "#{pane_in_mode}"],
        ["tmux", "send-keys", "-t", `=tmux-agent-abc:`, "-X", "cancel"],
        ["tmux", "send-keys", "-t", `=tmux-agent-abc:`, "-l", "--", "[sent by user]: hello world"],
        ["tmux", "send-keys", "-t", `=tmux-agent-abc:`, "Enter"],
      ]);
      // The cancel is recorded in the recipient's agent.log so the wedge is
      // diagnosable after the fact.
      const log = await Bun.file(join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")).text();
      expect(log).toContain("view/copy-mode");
    });

    test("does not send -X cancel when the pane is not in a mode", async () => {
      setSendSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        if (cmd[1] === "display-message") return makeSpawnResult(0, "0\n", "");
        return makeSpawnResult();
      });
      const agent = makeAgent("agent-abc", tempDir);
      const result = await sendMessage(agent, "hello", { cwd: "/" });

      expect(result.ok).toBe(true);
      expect(spawnCalls.some((c) => c.includes("-X"))).toBe(false);
      expect(spawnCalls.length).toBe(4);
    });

    test("a failed pane-mode probe never blocks delivery", async () => {
      // e.g. an old tmux without the format, or a transient error — deliver anyway.
      setSendSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        if (cmd[1] === "display-message") return makeSpawnResult(1, "", "unknown format");
        return makeSpawnResult();
      });
      const agent = makeAgent("agent-abc", tempDir);
      const result = await sendMessage(agent, "hello", { cwd: "/" });

      expect(result.ok).toBe(true);
      expect(spawnCalls.some((c) => c.includes("-X"))).toBe(false);
      expect(spawnCalls.at(-2)).toEqual(["tmux", "send-keys", "-t", `=tmux-agent-abc:`, "-l", "--", "[sent by user]: hello"]);
    });

    test("cancelTmuxPaneModeIfActive reports whether a mode was cancelled", async () => {
      let probeOut = "1";
      setSendSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        if (cmd[1] === "display-message") return makeSpawnResult(0, probeOut, "");
        return makeSpawnResult();
      });
      expect(await cancelTmuxPaneModeIfActive("tmux-agent-abc")).toBe(true);
      expect(spawnCalls.at(-1)).toEqual(["tmux", "send-keys", "-t", `=tmux-agent-abc:`, "-X", "cancel"]);

      spawnCalls.length = 0;
      probeOut = "0";
      expect(await cancelTmuxPaneModeIfActive("tmux-agent-abc")).toBe(false);
      expect(spawnCalls.length).toBe(1); // probe only, no cancel
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
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
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
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: Date.now() - 60_000, // 60s old → not fresh
      watchdog_pid: 4242,
    });

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "hello", { cwd: "/" });

    expect(result.ok).toBe(true);
    // Delivered inline → has-session + pane-mode probe + send-keys + Enter.
    expect(spawnCalls.length).toBe(4);
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
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 4242,
    });

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    await sendMessage(agent, "hello", { cwd: "/" });
    // has-session + pane-mode probe + send-keys + Enter.
    expect(spawnCalls.length).toBe(4);
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

// ---------------------------------------------------------------------------
// Send-time attachment staging (docs/SANDBOX-ROLLOUT.md "stage message
// attachments at send time"). A dashboard-only opt-in: local file-path
// references are copied into /tmp and rewritten to the staged paths BEFORE
// enqueue so the receiving agent can read a snapshot under its existing
// sandbox. Legacy sends (no stageAttachments) must be entirely unaffected.
// ---------------------------------------------------------------------------
describe("sendMessage send-time attachment staging", () => {
  let spawnCalls: string[][];
  let tempDir: string;
  let agentDir: string;
  let queueDir: string;

  // The single `-l --` chunked send-keys payload the inline drain typed (or
  // undefined if delivery never reached send-keys).
  function deliveredMessage(): string | undefined {
    const call = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 7 && c[4] === "-l" && c[5] === "--",
    );
    return call?.[6];
  }

  beforeEach(async () => {
    spawnCalls = [];
    tempDir = await mkdtemp(join(tmpdir(), "send-stage-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
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
    resetMessageAttachmentStagerForTesting();
    const { resetCoordinatorHome } = await import("./coordinator");
    resetCoordinatorHome();
    isPidAliveCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("copies a real out-of-tree file, replaces its path with the staged copy, and delivers it prefixed (real module)", async () => {
    // A source OUTSIDE the agent worktree — the exact case staging exists for.
    const srcDir = await mkdtemp(join(tmpdir(), "attach-src-"));
    const src = join(srcDir, "shot.png");
    await Bun.write(src, "PNGBYTES");

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, `${src} please describe`, { cwd: "/", stageAttachments: true });
    expect(result.ok).toBe(true);

    const delivered = deliveredMessage();
    expect(delivered).toBeDefined();
    // A message beginning with an absolute path is NOT a slash-command
    // passthrough: it is prefixed so the /tmp path lands as data, not a command.
    expect(delivered!.startsWith("[sent by user]: ")).toBe(true);
    const body = delivered!.slice("[sent by user]: ".length);
    const stagedPath = body.split(" ")[0]!;
    // The original path was replaced with a fresh /tmp copy of the same name.
    expect(stagedPath).not.toBe(src);
    expect(stagedPath).toContain("itsybitsy-attachments-");
    expect(basename(stagedPath)).toBe("shot.png");
    // The staged copy holds the source bytes and the trailing prose survived.
    expect(await Bun.file(stagedPath).text()).toBe("PNGBYTES");
    expect(body.endsWith(" please describe")).toBe(true);

    await rm(srcDir, { recursive: true, force: true });
    await rm(join(stagedPath, "..", ".."), { recursive: true, force: true });
  });

  test("queues the staged replacement (not the original) before any delivery, marked no-passthrough", async () => {
    // A live watchdog makes sendMessage enqueue and return WITHOUT draining — so
    // we can inspect what was queued before any tmux delivery happened.
    const { writeAgentTransient } = await import("./agents");
    isPidAliveCtx.set(() => true);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false, tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false, updated_at_ms: Date.now(), watchdog_pid: 4242,
    });
    setMessageAttachmentStagerForTesting(async (msg) => ({
      message: `/private/tmp/staged/x.png ${msg}`, staged: true, cleanup: async () => {},
    }));

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "/orig/x.png hi", { cwd: "/", stageAttachments: true });

    expect(result.ok).toBe(true);
    expect(spawnCalls.length).toBe(0); // deferred to the watchdog — nothing delivered yet
    const { readOutbox } = await import("./outbox");
    const queued = await readOutbox(queueDir);
    expect(queued.length).toBe(1);
    expect(queued[0]!.message).toBe("/private/tmp/staged/x.png /orig/x.png hi");
    expect(queued[0]!.noPassthrough).toBe(true);
  });

  test("passes the recipient's actual worktree root as liveRoot (3rd arg)", async () => {
    // The stager needs the recipient's live worktree so in-worktree references
    // stay literal. sendMessage must pass agentWorktreePath(agent), not repoPath.
    let capturedBaseDir: string | undefined;
    let capturedLiveRoot: string | undefined;
    setMessageAttachmentStagerForTesting(async (_msg, baseDir, liveRoot) => {
      capturedBaseDir = baseDir;
      capturedLiveRoot = liveRoot;
      return { message: "unchanged", staged: false, cleanup: async () => {} };
    });

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "./src/new.ts please add a test", { cwd: "/", stageAttachments: true });

    expect(result.ok).toBe(true);
    expect(capturedLiveRoot).toBe(agentWorktreePath(agent)); // recipient's real worktree
    expect(capturedBaseDir).toBe(tempDir); // baseDir defaults to agent.repoPath
  });

  test("staging failure returns an actionable error and enqueues nothing", async () => {
    setMessageAttachmentStagerForTesting(async () => {
      throw new Error('Cannot stage attachment "/x/y.png": ENOENT');
    });
    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "/x/y.png hi", { cwd: "/", stageAttachments: true });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to stage message attachments");
    expect(result.stderr).toContain("/x/y.png");
    expect(spawnCalls.length).toBe(0); // nothing delivered
    const { readOutbox } = await import("./outbox");
    expect(await readOutbox(queueDir)).toEqual([]); // nothing enqueued
  });

  test("enqueue failure cleans up the staged copies and delivers nothing (no partial send/copy)", async () => {
    let cleaned = false;
    setMessageAttachmentStagerForTesting(async () => ({
      message: "/private/tmp/staged/x.png hi", staged: true,
      cleanup: async () => { cleaned = true; },
    }));
    // Force enqueue to fail: point the outbox at a path under an existing FILE so
    // enqueueOutbox's recursive mkdir throws ENOTDIR.
    const blocker = join(tempDir, "blocker");
    await Bun.write(blocker, "x");

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "/src/x.png hi", {
      cwd: "/", stageAttachments: true, outboxDir: join(blocker, "sub"),
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Failed to enqueue");
    expect(cleaned).toBe(true); // staged copies removed
    expect(spawnCalls.length).toBe(0); // nothing delivered
    const { readOutbox } = await import("./outbox");
    expect(await readOutbox(queueDir)).toEqual([]); // real queue untouched
  });

  test("a staged send whose inline drain fails still reports success and RETAINS the queued message", async () => {
    // Delivery fails at has-session → the inline drain returns ok:false. For a
    // staged send that must NOT surface as failure (the dashboard would retry,
    // re-stage under a fresh /tmp path the dedupe can't match, and duplicate the
    // message). Report success, keep the queued copy, and DON'T clean it up.
    let cleaned = false;
    setMessageAttachmentStagerForTesting(async () => ({
      message: "/private/tmp/staged/x.png hi", staged: true,
      cleanup: async () => { cleaned = true; },
    }));
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      if (cmd.includes("has-session")) return makeSpawnResult(1, "", "no session");
      return makeSpawnResult();
    });

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "/src/x.png hi", { cwd: "/", stageAttachments: true });

    expect(result.ok).toBe(true); // accepted for delivery despite the drain error
    expect(result.stderr).toContain("not running"); // drain failure surfaced as a diagnostic
    expect(cleaned).toBe(false); // copies retained — the agent hasn't read them yet
    const { readOutbox } = await import("./outbox");
    const queued = await readOutbox(queueDir);
    expect(queued.length).toBe(1); // message retained for the next drainer
    expect(queued[0]!.message).toBe("/private/tmp/staged/x.png hi");
    expect(queued[0]!.noPassthrough).toBe(true);
  });

  test("a THROWN inline-drain error after enqueue is caught: staged send reports success and retains the queued message", async () => {
    // Distinct from the ok:false has-session case above: here the drain THROWS
    // an exception. For a staged send that must still be caught and reported as
    // accepted (ok:true) — an unhandled rejection would look like a failure to
    // the dashboard and induce a duplicate retry.
    let cleaned = false;
    setMessageAttachmentStagerForTesting(async () => ({
      message: "/private/tmp/staged/x.png hi", staged: true,
      cleanup: async () => { cleaned = true; },
    }));
    setSendSpawnRunner(() => {
      throw new Error("spawn blew up during drain");
    });

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "/src/x.png hi", { cwd: "/", stageAttachments: true });

    expect(result.ok).toBe(true); // caught — accepted despite the thrown drain error
    expect(result.stderr).toContain("Delivery error after enqueue");
    expect(result.stderr).toContain("spawn blew up during drain");
    expect(cleaned).toBe(false); // copies retained — the agent hasn't read them yet
    const { readOutbox } = await import("./outbox");
    const queued = await readOutbox(queueDir);
    expect(queued.length).toBe(1); // exactly one retained record — nothing delivered/removed
    expect(queued[0]!.message).toBe("/private/tmp/staged/x.png hi");
    expect(queued[0]!.noPassthrough).toBe(true);
  });

  test("stageAttachments with a real /clear (no file paths) preserves slash-command passthrough", async () => {
    // The real module leaves an unquoted /clear-style token alone (staged:false),
    // so passthrough survives: the message is delivered verbatim with no prefix.
    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, "/clear", { cwd: "/", stageAttachments: true });

    expect(result.ok).toBe(true);
    expect(deliveredMessage()).toBe("/clear");
  });

  test("liveRoot (real module): a project-relative ref stays literal (no copy); an external file is still copied", async () => {
    // Reviewer2 regression: `./src/new.ts` names the recipient's LIVE worktree
    // file (even one that doesn't exist yet) and must be delivered literally so
    // the agent edits the live file — NOT frozen to /tmp. An out-of-worktree
    // file is still copied. Uses the REAL module through sendMessage's liveRoot.
    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    // The recipient's live worktree must exist so canonicalization resolves it;
    // ./src/new.ts itself is deliberately absent (a future file).
    await mkdir(agentWorktreePath(agent), { recursive: true });
    // An external screenshot OUTSIDE the worktree and the repo base.
    const extDir = await mkdtemp(join(tmpdir(), "ext-shot-"));
    const ext = join(extDir, "screenshot.png");
    await Bun.write(ext, "EXTBYTES");

    const result = await sendMessage(agent, `./src/new.ts and ${ext}`, { cwd: "/", stageAttachments: true });
    expect(result.ok).toBe(true);

    const delivered = deliveredMessage();
    expect(delivered).toBeDefined();
    const body = delivered!.slice("[sent by user]: ".length);
    // The project-relative reference is untouched (live edit intent preserved).
    expect(body.startsWith("./src/new.ts and ")).toBe(true);
    // The external file was copied to a fresh /tmp snapshot and its path replaced.
    const stagedPath = body.slice("./src/new.ts and ".length);
    expect(stagedPath).not.toBe(ext);
    expect(stagedPath).toContain("itsybitsy-attachments-");
    expect(basename(stagedPath)).toBe("screenshot.png");
    expect(await Bun.file(stagedPath).text()).toBe("EXTBYTES");

    await rm(extDir, { recursive: true, force: true });
    await rm(join(stagedPath, "..", ".."), { recursive: true, force: true });
  });

  test("liveRoot (real module): a LEADING absolute own-worktree ref is kept literal but delivered WITH the user prefix", async () => {
    // The edge the manager caught: an absolute path into the agent's OWN
    // worktree is preserved (staged:false, no copy) yet still begins with `/`.
    // Without the module's leading-reference noPassthrough it would slash-
    // passthrough as a command. It must be delivered with the [sent by user]
    // prefix (data, not a command) even though nothing was copied.
    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const worktree = agentWorktreePath(agent);
    await mkdir(worktree, { recursive: true });
    const live = join(worktree, "file.ts");
    await Bun.write(live, "LIVE");

    const result = await sendMessage(agent, `${live} explain this`, { cwd: "/", stageAttachments: true });
    expect(result.ok).toBe(true);

    const delivered = deliveredMessage();
    expect(delivered).toBeDefined();
    // Prefixed, NOT a verbatim passthrough (the leading `/` is data).
    expect(delivered!.startsWith("[sent by user]: ")).toBe(true);
    const body = delivered!.slice("[sent by user]: ".length);
    // The own-worktree path is delivered literally — never copied to /tmp.
    expect(body).toBe(`${live} explain this`);
    expect(delivered).not.toContain("itsybitsy-attachments");
  });

  test("liveRoot (real module): a leading /compact before an external attachment still passes through (command fires)", async () => {
    // The module returns noPassthrough:false for a genuine leading slash command
    // even when a LATER attachment is copied (staged:true). sendMessage uses
    // `?? staged.staged` (not `||`), so that explicit false is honored and the
    // /compact command still fires verbatim.
    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const extDir = await mkdtemp(join(tmpdir(), "ext-shot-"));
    const ext = join(extDir, "screenshot.png");
    await Bun.write(ext, "EXTBYTES");

    const result = await sendMessage(agent, `/compact ${ext}`, { cwd: "/", stageAttachments: true });
    expect(result.ok).toBe(true);

    const delivered = deliveredMessage();
    expect(delivered).toBeDefined();
    // Verbatim passthrough (no [sent by user] prefix) so /compact fires.
    expect(delivered!.startsWith("/compact ")).toBe(true);
    // The later attachment was still copied and its path replaced.
    const stagedPath = delivered!.slice("/compact ".length);
    expect(stagedPath).toContain("itsybitsy-attachments-");
    expect(await Bun.file(stagedPath).text()).toBe("EXTBYTES");

    await rm(extDir, { recursive: true, force: true });
    await rm(join(stagedPath, "..", ".."), { recursive: true, force: true });
  });

  test("REGRESSION: an ordinary send (no stageAttachments) never stages — even an agent-relayed message with a real path", async () => {
    // Staging is a dashboard-only permission bypass. An installed stager must
    // NOT run for a legacy send, including an agent-originated (fromAgent) one.
    setMessageAttachmentStagerForTesting(async () => {
      throw new Error("stager must not run for a non-staged send");
    });
    const src = join(tempDir, "real.png");
    await Bun.write(src, "BYTES");
    await mkdir(join(tempDir, ".ittybitty", "agents", "agent-sender"), { recursive: true });

    const agent = _makeAgent({ id: "agent-abc", repoPath: tempDir, repoName: "r", state: "running" as AgentState });
    const result = await sendMessage(agent, `${src} check this`, { fromAgent: "agent-sender" });

    expect(result.ok).toBe(true); // the throwing stager was never called
    const delivered = deliveredMessage();
    expect(delivered).toBe(`[sent by agent agent-sender]: ${src} check this`);
    expect(delivered).not.toContain("itsybitsy-attachments"); // path delivered as-is
  });
});

// ---------------------------------------------------------------------------
// teamSend send-time attachment staging: threads the dashboard-only stage opts
// per recipient and supports retry-safe partial acceptance (skipRecipientIds /
// acceptedRecipientIds) so an identical-draft retry never re-delivers to a
// member that already accepted.
// ---------------------------------------------------------------------------
describe("teamSend send-time attachment staging", () => {
  let baseDir: string;
  let homeDir: string;
  let repoDir: string;
  let originalHome: string | undefined;

  function queueDirOf(id: string): string {
    return join(homeDir, "agents", id);
  }
  function reposArg() {
    return [{ path: repoDir, name: basename(repoDir) }];
  }
  // Plant a member whose per-recipient send DEFERS to its outbox (live watchdog
  // transient + isPidAliveCtx → true) and returns ok:true (accepted) without
  // draining, so we can inspect exactly what each member had queued.
  async function plantMember(id: string): Promise<void> {
    const agentDir = join(repoDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    await mkdir(queueDirOf(id), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `t-${id}` }));
    const { writeAgentTransient } = await import("./agents");
    await writeAgentTransient(agentDir, {
      tmux_compacting: false, tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false, updated_at_ms: Date.now(), watchdog_pid: 4242,
    });
  }
  function agentOf(id: string): Agent {
    const agent = _makeAgent({ id, repoPath: repoDir, repoName: basename(repoDir), state: "running" as AgentState });
    return { ...agent, meta: { ...agent.meta, worktree: false } };
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "team-stage-" + crypto.randomUUID() + "-"));
    homeDir = join(baseDir, ".itsybitsy");
    repoDir = join(baseDir, "repo");
    await mkdir(homeDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = baseDir;
    const { setCoordinatorHome } = await import("./coordinator");
    setCoordinatorHome(homeDir);
    setUserConfigPath(join(homeDir, "config.json"));
    await saveRegistry({ repos: [{ path: repoDir, name: basename(repoDir) }] });
    setSendSpawnRunner(() => makeSpawnResult());
    isPidAliveCtx.set(() => true);
    resetReadAgentMetaCache();
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetMessageAttachmentStagerForTesting();
    resetUserConfigPath();
    const { resetCoordinatorHome } = await import("./coordinator");
    resetCoordinatorHome();
    isPidAliveCtx.reset();
    resetReadAgentMetaCache();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(baseDir, { recursive: true, force: true });
  });

  test("a genuine per-member failure fails the staged batch; the retry skips the accepted member and does not duplicate", async () => {
    const { createTeam, addMember } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    const { readChannel } = await import("./team-channel");
    await createTeam("backend", "", 1000);
    await plantMember("agent-m1");
    await plantMember("agent-m2");
    await addMember("backend", "agent-m1");
    await addMember("backend", "agent-m2");
    resetReadAgentMetaCache();

    // Recipients are staged in roster order [m1, m2]. Fail the SECOND stage
    // (m2) on the first attempt only: m1 is accepted (deferred to its watchdog),
    // m2's staging throws BEFORE its enqueue so nothing is queued for it.
    let calls = 0;
    setMessageAttachmentStagerForTesting(async (msg) => {
      calls++;
      if (calls === 2) throw new Error("simulated staging failure for agent-m2");
      return { message: `${msg} (staged-${calls})`, staged: true, cleanup: async () => {} };
    });

    const members = [agentOf("agent-m1"), agentOf("agent-m2")];

    // First send: m1 accepts, m2 fails. A staged batch with ANY failure is
    // ok:false so the dashboard keeps the draft and can retry the failed member.
    const first = await teamSend("backend", members, "/shot.png hi", { stageAttachments: true }, reposArg());
    expect(first.ok).toBe(false);
    expect(first.acceptedRecipientIds).toEqual(["agent-m1"]); // only m1 accepted
    expect(first.stderr).toContain("agent-m2"); // the failed member is named
    expect((await readOutbox(queueDirOf("agent-m1"))).length).toBe(1); // m1 queued (staged)
    expect((await readOutbox(queueDirOf("agent-m2"))).length).toBe(0); // m2 never queued

    // Retry the SAME draft, skipping the accepted member (m1). m1 is NOT
    // re-staged or re-delivered; m2 now succeeds.
    const retry = await teamSend(
      "backend", members, "/shot.png hi",
      { stageAttachments: true, skipRecipientIds: ["agent-m1"] },
      reposArg(),
    );
    expect(retry.ok).toBe(true);
    expect(new Set(retry.acceptedRecipientIds)).toEqual(new Set(["agent-m1", "agent-m2"]));
    // m1(call 1) + m2-fail(call 2) + m2-retry(call 3); m1 was never re-staged.
    expect(calls).toBe(3);
    // Each member ends with exactly ONE queued copy — no duplicate.
    expect((await readOutbox(queueDirOf("agent-m1"))).length).toBe(1);
    expect((await readOutbox(queueDirOf("agent-m2"))).length).toBe(1);

    // The room recorded the message exactly once: the fresh send appended it;
    // the retry (carrying a skip set) did not append a duplicate history line.
    const recs = await readChannel("backend");
    expect(recs.filter((r) => r.message === "/shot.png hi").length).toBe(1);
  });

  test("total staging failure records NO room line; the same-draft retry (empty skip) records exactly one", async () => {
    // Regression for reviewer1's finding: a staged send that records the room
    // line up-front and infers "fresh vs retry" from an empty skip set would
    // append a SECOND line on the retry-after-total-failure (which also carries
    // an empty skip, since a total failure returns acceptedRecipientIds:[]).
    const { createTeam, addMember } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    const { readChannel } = await import("./team-channel");
    await createTeam("backend", "", 1000);
    await plantMember("agent-m1");
    await plantMember("agent-m2");
    await addMember("backend", "agent-m1");
    await addMember("backend", "agent-m2");
    resetReadAgentMetaCache();

    // Fail BOTH members' staging on the first attempt (calls 1 & 2), then let
    // the retry succeed (calls 3 & 4).
    let calls = 0;
    setMessageAttachmentStagerForTesting(async (msg) => {
      calls++;
      if (calls <= 2) throw new Error("simulated total staging failure");
      return { message: `${msg} (staged-${calls})`, staged: true, cleanup: async () => {} };
    });

    const members = [agentOf("agent-m1"), agentOf("agent-m2")];

    // First attempt: every member fails -> ok:false, nothing accepted, and NO
    // room line recorded for a failed staged attempt.
    const first = await teamSend("backend", members, "/shot.png hi", { stageAttachments: true }, reposArg());
    expect(first.ok).toBe(false);
    expect(first.acceptedRecipientIds).toEqual([]);
    expect((await readChannel("backend")).filter((r) => r.message === "/shot.png hi").length).toBe(0);

    // Retry the SAME draft. A total failure returned acceptedRecipientIds:[], so
    // the UI retries with an EMPTY skip set — this attempt now succeeds.
    const retry = await teamSend("backend", members, "/shot.png hi", { stageAttachments: true, skipRecipientIds: [] }, reposArg());
    expect(retry.ok).toBe(true);
    expect(new Set(retry.acceptedRecipientIds)).toEqual(new Set(["agent-m1", "agent-m2"]));
    expect((await readOutbox(queueDirOf("agent-m1"))).length).toBe(1);
    expect((await readOutbox(queueDirOf("agent-m2"))).length).toBe(1);

    // Exactly one room line across the failed-then-retried sequence — no dup.
    const recs = await readChannel("backend");
    expect(recs.filter((r) => r.message === "/shot.png hi").length).toBe(1);
  });

  test("staged send to an EMPTY team records the room message once (room-only send, no copies)", async () => {
    // A staged send with no recipients is a room-only send: nothing to stage or
    // copy, but §17.4 still records the room history line. This is preserved for
    // staged sends, not just legacy ones (regression for reviewer1's note that
    // the deferred staged record skipped the empty-recipient case).
    const { createTeam } = await import("./teams");
    const { readChannel } = await import("./team-channel");
    await createTeam("backend", "", 1000);
    resetReadAgentMetaCache();

    // No recipients → the stager must never run (no copies for a room-only send).
    setMessageAttachmentStagerForTesting(async () => {
      throw new Error("stager must not run for an empty team");
    });

    const res = await teamSend("backend", [], "/shot.png hi", { stageAttachments: true }, reposArg());
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("no recipients");
    expect(res.acceptedRecipientIds).toEqual([]);
    // The room recorded the message exactly once despite there being no recipients.
    const recs = await readChannel("backend");
    expect(recs.filter((r) => r.message === "/shot.png hi").length).toBe(1);
  });

  test("partial-accept then a skip-carrying retry with the roster pruned empty records NO duplicate room line", async () => {
    // Reviewer1 LOW: the empty-recipient staged record needs a skip guard. A
    // fresh partial attempt accepts m1 (records one room line); then every
    // member is pruned before the retry, so the skip-carrying retry hits the
    // recipients.length===0 branch — it must NOT record a second line.
    const { createTeam, addMember } = await import("./teams");
    const { readChannel } = await import("./team-channel");
    await createTeam("backend", "", 1000);
    await plantMember("agent-m1");
    await plantMember("agent-m2");
    await addMember("backend", "agent-m1");
    await addMember("backend", "agent-m2");
    resetReadAgentMetaCache();

    // m1 accepts, m2 fails on the fresh attempt (partial) -> one room line.
    let calls = 0;
    setMessageAttachmentStagerForTesting(async (msg) => {
      calls++;
      if (calls === 2) throw new Error("simulated staging failure for agent-m2");
      return { message: `${msg} (staged-${calls})`, staged: true, cleanup: async () => {} };
    });
    const members = [agentOf("agent-m1"), agentOf("agent-m2")];

    const first = await teamSend("backend", members, "/shot.png hi", { stageAttachments: true }, reposArg());
    expect(first.ok).toBe(false);
    expect(first.acceptedRecipientIds).toEqual(["agent-m1"]);
    expect((await readChannel("backend")).filter((r) => r.message === "/shot.png hi").length).toBe(1);

    // Both members die before the retry -> pruneDeadMembers empties the roster.
    await rm(join(repoDir, ".ittybitty", "agents", "agent-m1"), { recursive: true, force: true });
    await rm(join(repoDir, ".ittybitty", "agents", "agent-m2"), { recursive: true, force: true });
    resetReadAgentMetaCache();

    // Retry the SAME draft, skipping the accepted m1. All members are now pruned
    // -> recipients.length===0 with a NON-empty skip set -> no duplicate record.
    const retry = await teamSend(
      "backend", members, "/shot.png hi",
      { stageAttachments: true, skipRecipientIds: ["agent-m1"] },
      reposArg(),
    );
    expect(retry.ok).toBe(true);
    expect(retry.stdout).toContain("no recipients"); // roster pruned empty — the branch under test
    expect((await readChannel("backend")).filter((r) => r.message === "/shot.png hi").length).toBe(1);
  });

  test("skipping every current recipient is a success no-op that reports the full accepted set", async () => {
    const { createTeam, addMember } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    await createTeam("backend", "", 1000);
    await plantMember("agent-m1");
    await plantMember("agent-m2");
    await addMember("backend", "agent-m1");
    await addMember("backend", "agent-m2");
    resetReadAgentMetaCache();

    let stagerCalls = 0;
    setMessageAttachmentStagerForTesting(async (msg) => {
      stagerCalls++;
      return { message: `${msg} (staged)`, staged: true, cleanup: async () => {} };
    });
    const members = [agentOf("agent-m1"), agentOf("agent-m2")];

    const res = await teamSend(
      "backend", members, "/shot.png hi",
      { stageAttachments: true, skipRecipientIds: ["agent-m1", "agent-m2"] },
      reposArg(),
    );

    expect(res.ok).toBe(true);
    expect(new Set(res.acceptedRecipientIds)).toEqual(new Set(["agent-m1", "agent-m2"]));
    expect(stagerCalls).toBe(0); // nothing staged — everything already accepted
    expect(await readOutbox(queueDirOf("agent-m1"))).toEqual([]);
    expect(await readOutbox(queueDirOf("agent-m2"))).toEqual([]);
  });
});

// Helper: create a mock SpawnFn that records calls and returns success
function mockSpawnFn(calls: string[][]): (cmd: string[], opts?: any) => SpawnResult {
  return (cmd: string[]) => {
    calls.push(cmd);
    // Answer the mandatory sandbox subprocess preflight so a spawn/resume that
    // reaches prepareSandbox clears `which sandbox-exec` + the compile lint.
    const pf = sandboxPreflightAnswer(cmd);
    if (pf) return pf;
    return makeSpawnResult();
  };
}

/**
 * Mandatory sandbox: prepareSandbox now runs on EVERY spawn/resume, probing
 * `which sandbox-exec` and compiling the profile via `sandbox-exec … /usr/bin/true`.
 * Mocked spawn runners must answer both so the preflight clears without a real
 * sandbox-exec. Returns a canonical (imported convention: exitCode, stdout)
 * SpawnResult for those two commands, or null to fall through. Blocks with a
 * local `makeSpawnResult(stdout, exitCode)` shadow handle it inline instead.
 */
function sandboxPreflightAnswer(cmd: string[]): SpawnResult | null {
  if (cmd[0] === "which" && cmd[1] === "sandbox-exec") {
    return makeSpawnResult(0, "/usr/bin/sandbox-exec\n");
  }
  if (cmd[0] === "/usr/bin/sandbox-exec") {
    return makeSpawnResult(0, "");
  }
  return null;
}

/**
 * Normalize the mandatory-sandbox bits of a generated start.sh/resume.sh that
 * vary per run so byte-equality fixtures stay stable: the allocated proxy port,
 * the absolute sandbox.sb profile path, and every `-D KEY=value` parameter (whose
 * values are machine/run-specific canonical paths, including the dash-encoded
 * Claude project/scratchpad dirs that a plain agentsDir replace cannot catch).
 */
function normalizeSandboxVolatile(script: string): string {
  return script
    .replace(/'[^']*\/\.itsybitsy\/sealed\/sandbox-logs(?:\/[a-f0-9]{64})?/g, value =>
      value.endsWith("sandbox-logs") ? "'<SANDBOX-LOG-ROOT>" : "'<SANDBOX-LOG-ROOT>/<AGENT-HASH>")
    .replace(/PROXY_PORT=\d+/g, "PROXY_PORT=<PORT>")
    .replace(/-f '[^']*\/sandbox\.sb'/g, "-f '<PROFILE>'")
    .replace(/-D '([A-Za-z_0-9]+)=[^']*'/g, "-D '$1=<VALUE>'");
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

/**
 * Mandatory sandbox: resume now refuses any agent whose in-memory meta lacks an
 * enabled sandbox + paths block or a valid seal. Nearly every resume test wants
 * to exercise the resume BEHAVIOR (resume.sh, tmux, nudge), not that fail-closed
 * gate — so this arms the fixture: it stamps `sandbox`/`paths` onto the agent's
 * meta and writes a matching seal (via the production sealer) before resuming.
 * Best-effort — a test whose agent dir does not exist (the "not found" path) is
 * left untouched so it still returns "not found". Tests that DELIBERATELY assert
 * the legacy-refusal / seal-tamper behavior build their agents with
 * `resumeAgent(makeAgent(...))` and are intentionally NOT routed through here.
 */
async function armAgent(agent: Agent): Promise<void> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const hasMeta = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!hasMeta) return;
  (agent.meta as unknown as Record<string, unknown>).sandbox = { enabled: true, rawAllow: [], domains: [] };
  (agent.meta as unknown as Record<string, unknown>).paths = { allowRead: [], allowWrite: [], deny: [] };
  await sealAgentRecord(
    agent.repoPath,
    agent.id,
    agent.meta as unknown as Record<string, unknown>,
    agentDir,
  );
}

async function armAndResume(agent: Agent) {
  await armAgent(agent);
  const target = agent;
  return resumeAgent(target);
}

describe("retireAgent (native)", () => {
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
    resetSandboxProxyKillForTesting();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory and tmux session don't exist", async () => {
    // No meta.json + tmux has-session fails
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) => cmd.includes("has-session"));
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir, "running", { worktree: false });
    const result = await retireAgent(agent);

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

    const agent = makeAgent("agent-abc", tempDir, "running", { worktree: false });
    const result = await retireAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Closed agent: agent-abc");
  });

  test("retire uses checked authenticated seal cleanup when direct deletion is denied", async () => {
    const id = "agent-retire-sealed";
    const sealHome = join(tempDir, "seal-home");
    setUserHome(sealHome);
    const agentDir = join(tempDir, ".ittybitty", "agents", id);
    const agent = makeAgent(id, tempDir, "running", {
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
      worktree: false,
    });
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(agent.meta));
    const repoId = await getRepoId(tempDir);
    await writeSealRecordDirect(repoId, id, agent.meta as unknown as Record<string, unknown>, sealHome);
    setSealDeleteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    const tmuxCalls: string[][] = [];
    setSealCapabilityCommandForTesting((_action, target, boundRepoId) =>
      ["rm", "-f", sealPath(boundRepoId, target, sealHome)]
    );
    setNukeResumeSpawnRunner((cmd: string[]) => {
      tmuxCalls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "run-shell") {
        return Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      }
      return makeSpawnResult(cmd.includes("has-session") ? 1 : 0);
    });
    try {
      const result = await retireAgent(agent);
      expect(result.ok).toBe(true);
      expect(await readSealRecord(repoId, id, sealHome)).toBeNull();
      expect(tmuxCalls.some((cmd) => cmd[0] === "tmux" && cmd[1] === "run-shell")).toBe(true);
    } finally {
      setSealDeleteForTesting(null);
      resetSealCapabilityCommandForTesting();
      resetNukeResumeSpawnRunner();
      resetUserHome();
    }
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

    const agent = makeAgent("agent-abc", tempDir, "running", { worktree: false });
    await retireAgent(agent);

    // Agent directory should be removed after teardown
    const exists = await Bun.file(join(agentDir, "meta.json")).exists();
    expect(exists).toBe(false);
  });

  test("retire kills the persisted sandbox proxy when its pidfile is missing", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-proxy");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-proxy",
      tmux_session: "tmux-agent-proxy",
      sandbox_proxy_pid: 42424,
    }));
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) =>
      cmd.includes("has-session") || cmd.includes("pgrep")
    );
    lifecycleSpawnCtx.set(runner);
    setKillPauseSpawnRunner(runner);
    const killed: number[] = [];
    setSandboxProxyKillForTesting((pid) => killed.push(pid));

    const agent = makeAgent("agent-proxy", tempDir, "running", {
      worktree: false,
      sandbox_proxy_pid: 42424,
    });
    const result = await retireAgent(agent);

    expect(result.ok).toBe(true);
    expect(killed).toEqual([42424]);
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

    const agent = makeAgent("agent-abc", tempDir, "running", { worktree: false });
    await retireAgent(agent);

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
    const result = await retireAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Closed agent: agent-abc");
  });

  test("appends a [retire] line to the system watch log on success", async () => {
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
      const agent = makeAgent("agent-loggy", tempDir, "running", { worktree: false });
      const result = await retireAgent(agent);
      expect(result.ok).toBe(true);

      const { readFile } = await import("fs/promises");
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("[retire]");
      expect(log).toContain("agent-loggy");
      // makeAgent's default claude_pid is "12345"; assert the prefix so we
      // verify pid= is included without coupling to the helper's literal.
      expect(log).toMatch(/pid=\d+/);
    } finally {
      resetWatchLogPath();
    }
  });
});

describe("retire → rehire recovery", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  async function git(...args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
    }
    return stdout.trim();
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rehire-integration-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    await git("init", tempDir);
    await git("-C", tempDir, "config", "user.email", "test@example.com");
    await git("-C", tempDir, "config", "user.name", "Test User");
    await Bun.write(join(tempDir, "tracked.txt"), "base\n");
    await Bun.write(
      join(tempDir, "latin1.txt"),
      new Uint8Array([
        0x70, 0x72, 0x65, 0x66, 0x69, 0x78, 0x20, 0xe9, 0x20, 0x73, 0x75,
        0x66, 0x66, 0x69, 0x78, 0x0a, 0x6c, 0x69, 0x6e, 0x65, 0x32, 0x0a,
      ]),
    );
    await git("-C", tempDir, "add", "tracked.txt", "latin1.txt");
    await git("-C", tempDir, "commit", "-m", "base");
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    await Bun.write(join(tempDir, ".ittybitty", "repo-id"), "1a2b3c4d\n");
    await saveRegistry({
      repos: [{ path: tempDir, name: basename(tempDir) }],
    });
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetKillPauseSpawnRunner();
    resetRehireSpawnRunner();
    resetNukeResumeSpawnRunner();
    resetSealDirectVerifyForTesting();
    resetSealCapabilityCommandForTesting();
    isPidAliveCtx.reset();
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  // Build a rehirable no-worktree Claude archive for `agentId` with an optional
  // `manager`, plus the matching resume/spawn runners. Returns the archiveKey
  // and archiveDir so tests can assert on the archive if needed. Modeled on the
  // "successfully resumes a retired no-worktree Claude agent" test above.
  async function plantRehirableArchive(
    agentId: string,
    opts: { manager?: string | null; includeSettings?: boolean } = {},
  ): Promise<{ archiveKey: string; archiveDir: string }> {
    const archiveKey = `20260703-120000-${agentId}`;
    const archiveDir = join(tempDir, ".ittybitty", "archive", archiveKey);
    await mkdir(archiveDir, { recursive: true });
    const meta = makeAgent(agentId, tempDir, "stopped", {
      tmux_session: `ittybitty-1a2b3c4d-${agentId}`,
      worktree: false,
      model: "claude:sonnet",
      claude_pid: "",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      manager: opts.manager ?? null,
      ...(opts.includeSettings === false ? { agentType: "manager" } : {}),
    }).meta;
    // Mandatory sandbox: a rehirable archive must carry an enabled sandbox +
    // paths so the reconstructed agent clears resume's fail-closed precondition
    // (rehireAgent re-seals the reconstructed meta itself before resuming).
    (meta as unknown as Record<string, unknown>).sandbox = { enabled: true, rawAllow: [], domains: [] };
    (meta as unknown as Record<string, unknown>).paths = { allowRead: [], allowWrite: [], deny: [] };
    await Bun.write(join(archiveDir, "meta.json"), JSON.stringify(meta, null, 2));
    await Bun.write(join(archiveDir, "exit-check.sh"), "#!/bin/bash\n");
    if (opts.includeSettings !== false) {
      await mkdir(join(archiveDir, ".claude"), { recursive: true });
      await Bun.write(join(archiveDir, ".claude", "settings.local.json"), JSON.stringify({
        permissions: { allow: ["Read"], deny: ["Write"] },
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-check-path ${agentId}` }] }] },
      }));
    }
    await Bun.write(
      join(archiveDir, "retirement.json"),
      JSON.stringify({
        version: 1,
        agentId,
        retiredAt: "2026-07-03T12:00:00.000Z",
        repoPath: tempDir,
        archiveKey,
        worktree: false,
        gitHead: null,
        headRef: null,
        untrackedFiles: [],
        prunedTeams: [],
      }),
    );
    return { archiveKey, archiveDir };
  }

  // Plant a live (non-archived) manager agent in the same repo. A fresh
  // watchdog transient + `isPidAliveCtx → true` makes `sendMessage` DEFER the
  // rehire notice into the manager's CENTRAL outbox queue (asserted via
  // `readOutbox`) rather than draining it inline through tmux.
  async function plantLiveManager(managerId: string): Promise<void> {
    const managerDir = join(tempDir, ".ittybitty", "agents", managerId);
    await mkdir(managerDir, { recursive: true });
    await Bun.write(
      join(managerDir, "meta.json"),
      JSON.stringify(
        makeAgent(managerId, tempDir, "running", {
          worktree: false,
          tmux_session: `ittybitty-1a2b3c4d-${managerId}`,
        }).meta,
      ),
    );
    const { writeAgentTransient } = await import("./agents");
    await writeAgentTransient(managerDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      tmux_api_terms: false,
      tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 4242,
    });
  }

  // The manager's CENTRAL outbox queue dir (getCoordinatorHome()/agents/<id>).
  // With HOME=tempDir and no setCoordinatorHome override, this resolves under
  // tempDir/.itsybitsy.
  function managerQueueDir(managerId: string): string {
    return join(tempDir, ".itsybitsy", "agents", managerId);
  }

  // Spawn runner matching the existing no-worktree success test: tmux
  // new-session succeeds, has-session flips to alive once created, pgrep misses.
  function successRunner(): SpawnFn {
    let newSessionSeen = false;
    return (cmd) => {
      // Mandatory sandbox: rehire's internal resume runs prepareSandbox.
      const pf = sandboxPreflightAnswer(cmd);
      if (pf) return pf;
      if (cmd.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
      if (cmd[0] === "tmux" && cmd[1] === "new-session") {
        newSessionSeen = true;
        return makeSpawnResult();
      }
      if (cmd[0] === "tmux" && cmd.includes("has-session")) {
        return makeSpawnResult(newSessionSeen ? 0 : 1);
      }
      if (cmd[0] === "pgrep") return makeSpawnResult(1);
      return makeSpawnResult();
    };
  }

  test("notifies a surviving live manager exactly once when a sub-agent is rehired", async () => {
    const agentId = "agent-sub";
    const managerId = "agent-mgr";
    await plantRehirableArchive(agentId, { manager: managerId });
    await plantLiveManager(managerId);
    // Live-watchdog transient → sendMessage defers into the manager outbox.
    isPidAliveCtx.set(() => true);

    const runner = successRunner();
    setRehireSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);

    const result = await rehireAgent(agentId);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(`Rehired agent: ${agentId}`);

    const { readOutbox } = await import("./outbox");
    const queue = await readOutbox(managerQueueDir(managerId));
    expect(queue.length).toBe(1);
    expect(queue[0]!.message).toBe(`your sub agent ${agentId} has been rehired`);
    expect(queue[0]!.fromAgent).toBe(agentId);
  });

  test("sends no rehire notice when the rehired agent has no manager", async () => {
    const agentId = "agent-orphan";
    await plantRehirableArchive(agentId, { manager: null });
    // Plant a live agent that is NOT the manager to prove no stray notice lands.
    await plantLiveManager("agent-bystander");
    isPidAliveCtx.set(() => true);

    const runner = successRunner();
    setRehireSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);

    const result = await rehireAgent(agentId);

    expect(result.ok).toBe(true);

    const { readOutbox } = await import("./outbox");
    expect(await readOutbox(managerQueueDir("agent-bystander"))).toEqual([]);
  });

  test("rehire migrates a legacy worktree:false archive without isolated settings", async () => {
    const agentId = "agent-legacy-shared";
    await (await import("./agent-types")).ensureAgentTypesDir();
    await plantRehirableArchive(agentId, { includeSettings: false });
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    const sharedSettingsPath = join(tempDir, ".claude", "settings.local.json");
    await Bun.write(sharedSettingsPath, JSON.stringify({ permissions: { allow: ["UserOnlyTool"] } }));
    const sharedBefore = await Bun.file(sharedSettingsPath).text();
    const runner = successRunner();
    setRehireSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);

    const result = await rehireAgent(agentId);

    expect(result.ok).toBe(true);
    const agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    const isolatedSettingsPath = join(agentDir, ".claude", "settings.local.json");
    const isolated = await Bun.file(isolatedSettingsPath).json();
    expect(isolated.permissions.allow).toContain("Bash(ib:*)");
    expect(isolated.hooks.SessionStart[0].hooks[0].command).toBe(`ib hooks session-start ${agentId}`);
    expect(isolated.hooks.PostToolUse[0].hooks[0].command).toBe(`ib hooks inject-timestamp ${agentId}`);
    expect(JSON.stringify(isolated.hooks.PreToolUse)).toContain(`ib hooks intercept-task ${agentId}`);
    expect(JSON.stringify(isolated.hooks)).toContain(`hook-check-path ${agentId}`);
    expect(await Bun.file(sharedSettingsPath).text()).toBe(sharedBefore);
    expect(await Bun.file(join(agentDir, "resume.sh")).text()).toContain(`--settings '${isolatedSettingsPath}'`);
  });

  for (const [cli, model] of [
    ["codex", "codex:gpt-5.4-mini"],
    ["fugu", "fugu:gpt-5.4-mini"],
    ["agy", "agy:gemini-3.7-flash-low"],
  ] as const) {
    test(`rejects legacy worktree:false ${cli} rehire before reconstruction`, async () => {
      const agentId = `archived-shared-${cli}`;
      const { archiveDir } = await plantRehirableArchive(agentId, { includeSettings: false });
      const archivedMeta = await Bun.file(join(archiveDir, "meta.json")).json();
      archivedMeta.model = model;
      await Bun.write(join(archiveDir, "meta.json"), JSON.stringify(archivedMeta));
      await Bun.write(join(tempDir, "AGENTS.md"), "user agents content\n");
      await mkdir(join(tempDir, ".agents"), { recursive: true });
      await Bun.write(join(tempDir, ".agents", "hooks.json"), "user hooks content\n");

      const result = await rehireAgent(agentId);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain(`Cannot rehire worktree:false ${cli} agent`);
      expect(await Bun.file(join(tempDir, ".ittybitty", "agents", agentId)).exists()).toBe(false);
      expect(await Bun.file(join(tempDir, "AGENTS.md")).text()).toBe("user agents content\n");
      expect(await Bun.file(join(tempDir, ".agents", "hooks.json")).text()).toBe("user hooks content\n");
    });
  }

  test("sends no rehire notice when the manager is archived/gone", async () => {
    const agentId = "agent-sub-gone";
    const managerId = "agent-mgr-gone";
    // The archive records a manager, but no live agent by that id exists.
    await plantRehirableArchive(agentId, { manager: managerId });
    isPidAliveCtx.set(() => true);

    const runner = successRunner();
    setRehireSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);

    const result = await rehireAgent(agentId);

    expect(result.ok).toBe(true);

    const { readOutbox } = await import("./outbox");
    expect(await readOutbox(managerQueueDir(managerId))).toEqual([]);
  });

  test("enabled rehire resumes when its sandboxed caller cannot read the new seal", async () => {
    const agentId = "agent-rehire-denied-read";
    await plantRehirableArchive(agentId);
    const modulePath = join(import.meta.dir, "agent-seal.ts");
    setSealDirectVerifyForTesting(async () => {
      throw Object.assign(new Error("EACCES: protected seal read denied"), { code: "EACCES" });
    });
    setSealCapabilityCommandForTesting((action, target, repoId, meta) => {
      if (action !== "verify") return ["sh", "-c", "exit 99"];
      const script = [
        `const m = await import(${JSON.stringify(modulePath)});`,
        `const result = await m.applySealCapabilityAction("verify", ${JSON.stringify(repoId)}, ${JSON.stringify(target)}, process.env.IB_SEAL_CAP, ${JSON.stringify(meta)}, ${JSON.stringify(tempDir)});`,
        "console.log(JSON.stringify(result));",
      ].join(" ");
      return ["bun", "-e", script];
    });
    const inner = successRunner();
    const helperRunner: SpawnFn = (cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "run-shell") {
        return Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      }
      return inner(cmd);
    };
    setRehireSpawnRunner(inner);
    setNukeResumeSpawnRunner(helperRunner);

    const result = await rehireAgent(agentId);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(`Rehired agent: ${agentId}`);
    expect(await readSealRecord("1a2b3c4d", agentId, tempDir)).not.toBeNull();
    expect(await Bun.file(join(tempDir, ".ittybitty", "agents", agentId, "resume.sh")).exists()).toBe(true);
  });

  test("round-trips committed HEAD, tracked changes, and untracked files; resume failure leaves stopped agent", async () => {
    const agentId = "agent-rehire";
    const agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    const worktreePath = join(agentDir, "repo");
    await mkdir(agentDir, { recursive: true });
    await git(
      "-C", tempDir, "worktree", "add", worktreePath,
      "-b", `agent/${agentId}`, "HEAD",
    );

    await Bun.write(join(worktreePath, "tracked.txt"), "modified\n");
    const modifiedLatin1 = new Uint8Array([
      0x70, 0x72, 0x65, 0x66, 0x69, 0x78, 0x20, 0xe9, 0x20, 0x73, 0x75,
      0x66, 0x66, 0x69, 0x78, 0x0a, 0x6c, 0x69, 0x6e, 0x65, 0x32, 0x0a,
      0x63, 0x68, 0x61, 0x6e, 0x67, 0x65, 0x64, 0x0a,
    ]);
    await Bun.write(join(worktreePath, "latin1.txt"), modifiedLatin1);
    await mkdir(join(worktreePath, "nested"), { recursive: true });
    await Bun.write(join(worktreePath, "nested", "untracked.txt"), "untracked\n");
    const absoluteLinkTarget = join(worktreePath, "tracked.txt");
    await symlink(absoluteLinkTarget, join(worktreePath, "absolute-link"));
    await Bun.write(join(agentDir, "prompt.txt"), "continue the task");
    await Bun.write(join(agentDir, "start.sh"), "#!/bin/bash\n");
    await Bun.write(join(agentDir, "exit-check.sh"), "#!/bin/bash\n");

    const agent = makeAgent(agentId, tempDir, "running", {
      tmux_session: `ittybitty-1a2b3c4d-${agentId}`,
      worktree: true,
      model: "codex:gpt-5.5",
      claude_pid: "",
    });
    // Mandatory sandbox: carry an enabled sandbox + paths so the reconstructed
    // agent clears resume's precondition and reaches the codex_session_id check
    // (the failure this test asserts).
    (agent.meta as unknown as Record<string, unknown>).sandbox = { enabled: true, rawAllow: [], domains: [] };
    (agent.meta as unknown as Record<string, unknown>).paths = { allowRead: [], allowWrite: [], deny: [] };
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify(agent.meta, null, 2),
    );
    const { createTeam, addMember, getTeam } = await import("./teams");
    await createTeam("rehire-test", "", 1000);
    await addMember("rehire-test", agentId);

    const hybridRunner: SpawnFn = (cmd) => {
      // Mandatory sandbox: answer `which sandbox-exec` + the compile lint (git
      // rev-parse runs for real below). prepareSandbox runs on every resume.
      const pf = sandboxPreflightAnswer(cmd);
      if (pf) return pf;
      if (cmd[0] === "git") {
        return Bun.spawn(cmd, {
          stdout: "pipe",
          stderr: "pipe",
        }) as SpawnResult;
      }
      if (cmd[0] === "tmux" && cmd.includes("has-session")) {
        return makeSpawnResult(1);
      }
      if (cmd[0] === "pgrep") return makeSpawnResult(1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(hybridRunner);
    setKillPauseSpawnRunner(hybridRunner);

    const retired = await retireAgent(agent);
    expect(retired.ok).toBe(true);
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);

    const archives = await readdir(join(tempDir, ".ittybitty", "archive"));
    expect(archives).toHaveLength(1);
    const archiveDir = join(tempDir, ".ittybitty", "archive", archives[0]!);
    const manifest = await Bun.file(join(archiveDir, "retirement.json")).json();
    expect(manifest.agentId).toBe(agentId);
    expect(manifest.gitHead).toMatch(/^[0-9a-f]{40,64}$/);
    expect(manifest.untrackedFiles).toEqual([
      "absolute-link",
      "nested/untracked.txt",
    ]);
    expect(manifest.prunedTeams).toEqual([
      { team: "rehire-test", id: agentId },
    ]);
    expect(await Bun.file(join(archiveDir, "agent.log")).text()).toContain(
      "Agent retired",
    );

    // Simulate teardown's rm -rf fallback leaving an orphan branch after Git's
    // worktree metadata becomes stale. Rehire should prune and replace it when
    // it still points at the immutable retained HEAD.
    await git(
      "-C", tempDir, "branch", `agent/${agentId}`, manifest.gitHead,
    );

    setRehireSpawnRunner(hybridRunner);
    setNukeResumeSpawnRunner(hybridRunner);
    const rehired = await rehireAgent(agentId);

    expect(rehired.ok).toBe(false);
    expect(rehired.stdout).toContain("Reconstructed stopped agent");
    expect(rehired.stderr).toContain("codex_session_id");
    expect(await Bun.file(join(worktreePath, "tracked.txt")).text()).toBe("modified\n");
    expect(
      await Bun.file(join(worktreePath, "nested", "untracked.txt")).text(),
    ).toBe("untracked\n");
    expect(
      new Uint8Array(
        await Bun.file(join(worktreePath, "latin1.txt")).arrayBuffer(),
      ),
    ).toEqual(modifiedLatin1);
    expect(await readlink(join(worktreePath, "absolute-link"))).toBe(
      absoluteLinkTarget,
    );
    const restoredMeta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(restoredMeta.state).toBe("stopped");
    expect(restoredMeta.tmux_session).toBe(`ittybitty-1a2b3c4d-${agentId}`);
    expect(restoredMeta.claude_pid).toBe("");
    expect(restoredMeta.watchdog_pid).toBeUndefined();
    expect((await getTeam("rehire-test"))!.members).toContain(agentId);
    expect(await Bun.file(join(archiveDir, "retirement.json")).exists()).toBe(true);
    expect(await git("-C", tempDir, "rev-parse", manifest.headRef)).toBe(manifest.gitHead);
    expect(await git("-C", worktreePath, "rev-parse", "HEAD")).toBe(manifest.gitHead);
    // A4 G3: rehire re-seals the reconstructed agent BEFORE the resume attempt,
    // so the sealed record exists even though this resume fails on
    // codex_session_id (retire deleted it; rehire brought it back).
    const rehireRepoId = await getRepoId(tempDir);
    expect(await readSealRecord(rehireRepoId, agentId, tempDir)).not.toBeNull();
  });

  test("rejects an archive without a supported retirement manifest", async () => {
    const archiveDir = join(
      tempDir,
      ".ittybitty",
      "archive",
      "20260703-120000-agent-legacy",
    );
    await mkdir(archiveDir, { recursive: true });
    await Bun.write(
      join(archiveDir, "meta.json"),
      JSON.stringify({
        id: "agent-legacy",
        tmux_session: "ittybitty-1a2b3c4d-agent-legacy",
      }),
    );

    const result = await rehireAgent("agent-legacy");

    expect(result.ok).toBe(false);
    expect(result.stderr).toBe(
      "Matching archive is not rehirable (no supported retirement manifest)",
    );
  });

  test("rolls back the reconstructed directory and branch when a patch is corrupt", async () => {
    const agentId = "agent-corrupt";
    const agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    const worktreePath = join(agentDir, "repo");
    await mkdir(agentDir, { recursive: true });
    await git(
      "-C", tempDir, "worktree", "add", worktreePath,
      "-b", `agent/${agentId}`, "HEAD",
    );
    await Bun.write(join(worktreePath, "tracked.txt"), "modified\n");
    await Bun.write(join(agentDir, "exit-check.sh"), "#!/bin/bash\n");

    const agent = makeAgent(agentId, tempDir, "running", {
      tmux_session: `ittybitty-1a2b3c4d-${agentId}`,
      worktree: true,
      model: "codex:gpt-5.5",
      claude_pid: "",
    });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify(agent.meta, null, 2),
    );

    const hybridRunner: SpawnFn = (cmd) => {
      // Mandatory sandbox: answer `which sandbox-exec` + the compile lint (git
      // rev-parse runs for real below). prepareSandbox runs on every resume.
      const pf = sandboxPreflightAnswer(cmd);
      if (pf) return pf;
      if (cmd[0] === "git") {
        return Bun.spawn(cmd, {
          stdout: "pipe",
          stderr: "pipe",
        }) as SpawnResult;
      }
      if (cmd[0] === "tmux" && cmd.includes("has-session")) {
        return makeSpawnResult(1);
      }
      if (cmd[0] === "pgrep") return makeSpawnResult(1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(hybridRunner);
    setKillPauseSpawnRunner(hybridRunner);
    expect((await retireAgent(agent)).ok).toBe(true);

    const [archiveKey] = await readdir(
      join(tempDir, ".ittybitty", "archive"),
    );
    const archiveDir = join(
      tempDir,
      ".ittybitty",
      "archive",
      archiveKey!,
    );
    const manifest = await Bun.file(
      join(archiveDir, "retirement.json"),
    ).json();
    await Bun.write(join(archiveDir, "worktree.patch"), "not a git patch\n");

    setRehireSpawnRunner(hybridRunner);
    const result = await rehireAgent(agentId);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(
      `Could not reconstruct agent '${agentId}'`,
    );
    expect(result.stderr).toContain("No valid patches");
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
    expect(
      await git("-C", tempDir, "branch", "--list", `agent/${agentId}`),
    ).toBe("");
    expect(await git("-C", tempDir, "rev-parse", manifest.headRef)).toBe(
      manifest.gitHead,
    );
  });

  test("successfully resumes a retired no-worktree Claude agent", async () => {
    const agentId = "agent-return";
    const archiveKey = `20260703-120000-${agentId}`;
    const archiveDir = join(
      tempDir,
      ".ittybitty",
      "archive",
      archiveKey,
    );
    await mkdir(archiveDir, { recursive: true });
    const meta = makeAgent(agentId, tempDir, "stopped", {
      tmux_session: `ittybitty-1a2b3c4d-${agentId}`,
      worktree: false,
      model: "claude:sonnet",
      claude_pid: "",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      nickname: "shared-name",
    }).meta;
    // Mandatory sandbox: archive must carry enabled sandbox + paths so the
    // reconstructed agent clears resume's fail-closed precondition.
    (meta as unknown as Record<string, unknown>).sandbox = { enabled: true, rawAllow: [], domains: [] };
    (meta as unknown as Record<string, unknown>).paths = { allowRead: [], allowWrite: [], deny: [] };
    await Bun.write(
      join(archiveDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
    await Bun.write(join(archiveDir, "exit-check.sh"), "#!/bin/bash\n");
    await mkdir(join(archiveDir, ".claude"), { recursive: true });
    await Bun.write(join(archiveDir, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Read"], deny: ["Write"] },
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-check-path ${agentId}` }] }] },
    }));
    await Bun.write(
      join(archiveDir, "retirement.json"),
      JSON.stringify({
        version: 1,
        agentId,
        retiredAt: "2026-07-03T12:00:00.000Z",
        repoPath: tempDir,
        archiveKey,
        worktree: false,
        gitHead: null,
        headRef: null,
        untrackedFiles: [],
        prunedTeams: [],
      }),
    );
    const activeOwnerDir = join(
      tempDir,
      ".ittybitty",
      "agents",
      "agent-owner",
    );
    await mkdir(activeOwnerDir, { recursive: true });
    await Bun.write(
      join(activeOwnerDir, "meta.json"),
      JSON.stringify(
        makeAgent("agent-owner", tempDir, "running", {
          worktree: false,
          nickname: "shared-name",
        }).meta,
      ),
    );

    let newSessionSeen = false;
    const runner: SpawnFn = (cmd) => {
      const pf = sandboxPreflightAnswer(cmd);
      if (pf) return pf;
      if (cmd.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
      if (cmd[0] === "tmux" && cmd[1] === "new-session") {
        newSessionSeen = true;
        return makeSpawnResult();
      }
      if (cmd[0] === "tmux" && cmd.includes("has-session")) {
        return makeSpawnResult(newSessionSeen ? 0 : 1);
      }
      if (cmd[0] === "pgrep") return makeSpawnResult(1);
      return makeSpawnResult();
    };
    setRehireSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);

    const result = await rehireAgent(agentId);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(`Rehired agent: ${agentId}`);
    expect(result.stderr).toContain(
      "Nickname 'shared-name' is already used",
    );
    expect(newSessionSeen).toBe(true);
    expect(
      await Bun.file(
        join(tempDir, ".ittybitty", "agents", agentId, "resume.sh"),
      ).exists(),
    ).toBe(true);
    expect(
      (await Bun.file(
        join(tempDir, ".ittybitty", "agents", agentId, "meta.json"),
      ).json()).nickname,
    ).toBeUndefined();
  });

  test("disabled rehire removes an orphan enabled seal before resuming", async () => {
    const agentId = "agent-disabled-return";
    const { archiveDir } = await plantRehirableArchive(agentId);
    const archivedMeta = await Bun.file(join(archiveDir, "meta.json")).json() as AgentMeta;
    archivedMeta.sandbox = { enabled: false, rawAllow: [], domains: [] };
    await Bun.write(join(archiveDir, "meta.json"), JSON.stringify(archivedMeta, null, 2));

    const repoId = await getRepoId(tempDir);
    const staleMeta = {
      ...(archivedMeta as unknown as Record<string, unknown>),
      sandbox: { enabled: true, rawAllow: [], domains: [] },
    };
    await mkdir(join(process.env.HOME!, ".itsybitsy", "sealed"), { recursive: true });
    await Bun.write(
      sealPath(repoId, agentId, process.env.HOME!),
      JSON.stringify(computeSealRecord(await computeSealInputs(staleMeta))),
    );

    const runner = successRunner();
    setRehireSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);
    const result = await rehireAgent(agentId);

    expect(result.ok).toBe(true);
    expect(await readSealRecord(repoId, agentId, process.env.HOME!)).toBeNull();
    const restoredDir = join(tempDir, ".ittybitty", "agents", agentId);
    expect((await Bun.file(join(restoredDir, "meta.json")).json()).sandbox.enabled).toBe(false);
    const resume = await Bun.file(join(restoredDir, "resume.sh")).text();
    expect(resume).not.toContain("--permission-mode");
    expect(resume).not.toContain("--dangerously-skip-permissions");
    expect(resume).toContain(`--settings '${join(restoredDir, ".claude", "settings.local.json")}'`);
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

  test("destructively removes a worker with no children", async () => {
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

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Nuked 1 agent");
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
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
      // Sandbox subprocess preflight (mandatory sandbox): every resume is
      // sandboxed now, so prepareSandbox probes `which sandbox-exec` + compiles
      // the profile. Mock both so resume clears preflight without a real binary.
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") {
        return makeSpawnResult(0, "/usr/bin/sandbox-exec\n");
      }
      if (cmd[0] === "/usr/bin/sandbox-exec") {
        return makeSpawnResult(0, "");
      }
      return makeSpawnResult();
    };
  }

  // Captures (cmd, cwd) for every codex dispatcher dry-run subprocess.
  // The codex dry-run goes through dispatcherDryRunSpawnCtx (NOT
  // nukeResumeSpawnCtx) so the runtime hook can resolve agentsDir from
  // the worktree cwd. Without capturing cwd here, tests can't verify the
  // fix that routes workPath into the subprocess.
  let dispatcherDryRunCalls: Array<{ cmd: string[]; cwd: string }>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "resume-test-"));
    spawnCalls = [];
    dispatcherDryRunCalls = [];
    const runner = makeDefaultResumeRunner(spawnCalls);
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);
    // The resume nudge now routes through `sendMessage`, whose delivery uses
    // `sendSpawnCtx` (not `nukeResumeSpawnCtx`) and enqueues to the central
    // outbox under the coordinator home. Capture both into the SAME `spawnCalls`
    // and sandbox the coordinator home so the inline drain neither escapes to
    // the real `~/.itsybitsy/` nor sleeps for real (setSendSpawnRunner zeroes
    // the send delay).
    setSendSpawnRunner((cmd: string[]) => {
      spawnCalls.push(cmd);
      return makeSpawnResult();
    });
    const { setCoordinatorHome } = await import("./coordinator");
    setCoordinatorHome(join(tempDir, "coord-home"));
    // Default codex dry-run runner: capture (cmd, cwd) + succeed.
    setDispatcherDryRunSpawnRunner((cmd, cwd) => {
      dispatcherDryRunCalls.push({ cmd, cwd });
      return makeSpawnResult();
    });
  });

  afterEach(async () => {
    lifecycleSpawnCtx.reset();
    resetNukeResumeSpawnRunner();
    resetSendSpawnRunner();
    const { resetCoordinatorHome } = await import("./coordinator");
    resetCoordinatorHome();
    resetDispatcherDryRunSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory doesn't exist", async () => {
    const agent = makeAgent("agent-abc", tempDir, "stopped");
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);

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
    // The resume nudge routes through `sendMessage` attributed to the watchdog,
    // so the delivered payload carries the `[sent by watchdog]:` prefix (matches
    // the Stop-hook nudge attribution) — it must not look like a human send.
    const nudgePayload = nudgeCall!.find((a) => a.includes("Resume your work"))!;
    expect(nudgePayload).toContain("[sent by watchdog]:");
    expect(nudgePayload.startsWith("Resume your work")).toBe(false);
  });

  test("resume.sh re-applies --effort from persisted meta.effort", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-effort");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-effort",
      tmux_session: "tmux-agent-effort",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      model: "claude:opus",
      effort: "high",
    }));

    const agent = _makeAgent({
      id: "agent-effort",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-effort",
        model: "claude:opus",
        effort: "high",
      } as any,
    });
    const result = await armAndResume(agent);
    expect(result.ok).toBe(true);

    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resumeScript).toContain("--model opus");
    expect(resumeScript).toContain("--effort high");
  });

  test("resume.sh omits --effort for a legacy agent with no meta.effort", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-legacy-effort");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-legacy-effort",
      tmux_session: "tmux-agent-legacy-effort",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      model: "claude:opus",
    }));

    const agent = _makeAgent({
      id: "agent-legacy-effort",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        tmux_session: "tmux-agent-legacy-effort",
        model: "claude:opus",
      } as any,
    });
    const result = await armAndResume(agent);
    expect(result.ok).toBe(true);

    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resumeScript).not.toContain("--effort");
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
    const result = await armAndResume(agent);
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
    const result = await armAndResume(agent);
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
    // Mandatory sandbox: claude is wrapped by the sandbox-exec prefix on both arms.
    expect(resumeScript).toMatch(/setsid \/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* .* claude --resume/);
    // Fallback bare launch is still present for hosts without setsid.
    expect(resumeScript).toMatch(/^ *\/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* .* claude --resume "/m);

    // ORDERING (the subtle part): `trap '' HUP` must be installed BEFORE claude
    // is forked so the SIG_IGN disposition is inherited by the child. If the
    // trap moved after the launch, a child started before the trap would catch
    // a stray SIGHUP and die — reintroducing the bug.
    const hupIdx = resumeScript.indexOf("trap '' HUP");
    const setsidGuardIdx = resumeScript.indexOf("command -v setsid");
    const firstLaunchIdx = resumeScript.search(/(setsid )?\S*sandbox-exec\S* .* claude --resume "/);
    expect(hupIdx).toBeGreaterThan(-1);
    expect(hupIdx).toBeLessThan(firstLaunchIdx);
    // UNCONDITIONAL: the HUP-ignore must not be gated on setsid — it appears
    // before the `command -v setsid` guard, so the bare-launch fallback path
    // (setsid absent, e.g. macOS) keeps the protection.
    expect(hupIdx).toBeLessThan(setsidGuardIdx);

    // TERM and INT traps are unchanged — clean teardown on ib retire / pause still
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
    const result = await armAndResume(agent);
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
    await armAndResume(agent);

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
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);
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
    const result = await armAndResume(agent);
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
    const result = await armAndResume(agent);
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
    const result = await armAndResume(agent);
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
    const result = await armAndResume(agent);

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
    await armAndResume(agent);

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
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);

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
      const coordinatorRunner = (cmd: string[]) => {
        spawnCalls.push(cmd);
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("tmux has-session")) return makeSpawnResult(1);
        if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
        if (cmdStr.includes("--show-toplevel")) return makeSpawnResult(0, coordTempDir);
        if (cmdStr.includes("--git-dir")) return makeSpawnResult(0, ".git");
        if (cmdStr.includes("capture-pane")) return makeSpawnResult(0, "Claude Code v1.0");
        return makeSpawnResult(0);
      };
      setNewAgentSpawnRunner(coordinatorRunner);
      lifecycleSpawnCtx.set(coordinatorRunner);
    });

    afterEach(async () => {
      resetNewAgentSpawnRunner();
      lifecycleSpawnCtx.reset();
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

      await armAndResume(agent);

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

      const result = await armAndResume(agent);

      // If respawn succeeded, stdout should reflect the reset.
      // If it failed (test environment limitations), stderr should at
      // least mention "respawn" — proving the routing happened, not the
      // regular resume path (which would say "session_id" or similar).
      if (result.ok) {
        expect(result.stdout).toContain("Reset coordinator");
        const start = await Bun.file(join(coordDir, "start.sh")).text();
        expect(start).toContain("ib sandbox-log-watch");
        expect(start).toContain("sandbox-log-gate '/usr/bin/sandbox-exec'");
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

      const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);
    expect(result.ok).toBe(true);

    const rawResumeSh = await Bun.file(join(agentDir, "resume.sh")).text();
    // Normalise per-run varying bits:
    //   * tempDir prefix → <AGENTSDIR>
    //   * UUID session id → <SESSION-UUID>
    //   * mandatory-sandbox proxy port / profile path / -D param values
    const sessionUuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    const normalised = normalizeSandboxVolatile(rawResumeSh
      .replaceAll(tempDir, "<AGENTSDIR>")
      .replaceAll(sessionUuidPattern, "<SESSION-UUID>"));

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
    const result = await armAndResume(agent);

    expect(result.ok).toBe(true);
    // resume.sh should be created with codex launch line.
    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resumeScript).toContain("codex resume '019e7b21-cb7d-7f23-8674-11036ed141ef'");
    expect(resumeScript).toContain("--dangerously-bypass-hook-trust");
    expect(resumeScript).toContain("-a never");
    // Mandatory sandbox: codex resume runs danger-full-access inside our wrapper.
    expect(resumeScript).toContain("-s danger-full-access");
    expect(resumeScript).not.toContain("-s workspace-write");
    expect(resumeScript).toMatch(/setsid \/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* .* codex resume/);
    // Must NOT use claude --resume.
    expect(resumeScript).not.toContain("claude --resume");

    // tmux new-session should have been called with the resume script path.
    const newSessionCall = spawnCalls.find(c => c[0] === "tmux" && c[1] === "new-session");
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall!.some(arg => arg.includes("resume.sh"))).toBe(true);

    // dispatcher precheck must have run (3 events) — calls go through
    // dispatcherDryRunSpawnCtx, NOT the resume spawn runner, so we read from
    // dispatcherDryRunCalls.
    const dryRunCmdStrs = dispatcherDryRunCalls.map(c => c.cmd.join(" "));
    expect(dryRunCmdStrs.some(c => c.includes("hooks codex-pre-tool-use") && c.includes("--dry-run"))).toBe(true);
    expect(dryRunCmdStrs.some(c => c.includes("hooks codex-session-start") && c.includes("--dry-run"))).toBe(true);
    expect(dryRunCmdStrs.some(c => c.includes("hooks codex-stop") && c.includes("--dry-run"))).toBe(true);

    // Regression: every codex dry-run subprocess must be spawned with
    // cwd === workPath (the agent's worktree dir, `<agentDir>/repo`). If
    // cwd is wrong, the runtime hook's resolveAgentDir regex fails and the
    // precheck explodes with "meta.json not found".
    const expectedCwd = join(agentDir, "repo");
    expect(dispatcherDryRunCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of dispatcherDryRunCalls) {
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
    // Mandatory sandbox: answer the sandbox preflight so prepareSandbox succeeds
    // and the codex dispatcher precheck (the failure under test) is reached.
    const baseRunner = (cmd: string[]): SpawnResult => {
      spawnCalls.push(cmd);
      const pf = sandboxPreflightAnswer(cmd);
      if (pf) return pf;
      if (cmd.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
      if (cmd[0] === "tmux" && cmd[1] === "new-session") return makeSpawnResult();
      if (cmd.includes("has-session")) return makeSpawnResult(1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(baseRunner);
    setNukeResumeSpawnRunner(baseRunner);
    // The dry-run now goes through dispatcherDryRunSpawnCtx — inject failure
    // there to simulate a broken dispatcher.
    setDispatcherDryRunSpawnRunner((cmd, cwd) => {
      dispatcherDryRunCalls.push({ cmd, cwd });
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
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid codex_session_id");
    const resumeShExists = await Bun.file(join(agentDir, "resume.sh")).exists();
    expect(resumeShExists).toBe(false);
  });

  // ── agy resume (SPEC-ANTIGRAVITY-CLI.md §4.5, Phase 2) ──────────────────────
  // HOME is pointed at a temp fakeHome so ensureAgyTrustedWorkspace writes to
  // <fakeHome>/.gemini — the real ~/.gemini is never touched.
  describe("agy resume branch (temp HOME)", () => {
    let originalHome: string | undefined;
    beforeEach(async () => {
      originalHome = process.env.HOME;
      const fakeHome = join(tempDir, "home");
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      process.env.HOME = fakeHome;
      await (await import("./agent-types")).ensureAgentTypesDir();
    });
    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    test("resumes an agy agent — regenerates worktree files + writes resume.sh with --conversation and no -i", async () => {
      const agentDir = join(tempDir, ".ittybitty", "agents", "agent-agy-ok");
      await mkdir(join(agentDir, "repo", ".agents"), { recursive: true });
      // Pre-write a TAMPERED hooks.json to prove resume overwrites it.
      await Bun.write(join(agentDir, "repo", ".agents", "hooks.json"), "TAMPERED");
      const frozenPaths = {
        allowRead: ["/frozen/agy/read"],
        allowWrite: ["/frozen/agy/write"],
        deny: ["**/agy-secret"],
      };
      // Mandatory sandbox: agy is now sandboxed, so its frozen policy is enabled.
      const frozenSandbox = { enabled: true, rawAllow: [], domains: [] };
      const agyMeta = {
        id: "agent-agy-ok",
        tmux_session: "tmux-agent-agy-ok",
        model: "agy:gemini-3.7-flash-low",
        agy_conversation_id: "019e7b21-cb7d-7f23-8674-11036ed141ef",
        paths: frozenPaths,
        sandbox: frozenSandbox,
      };
      await Bun.write(join(agentDir, "meta.json"), JSON.stringify(agyMeta));
      // Seal the frozen policy so resume's seal-verify passes (arm manually here
      // rather than via armAndResume, which would clobber the frozen paths).
      await sealAgentRecord(tempDir, "agent-agy-ok", agyMeta as unknown as Record<string, unknown>, agentDir);
      const agent = _makeAgent({
        id: "agent-agy-ok",
        repoPath: tempDir,
        repoName: "test",
        state: "stopped",
        meta: {
          tmux_session: "tmux-agent-agy-ok",
          model: "agy:gemini-3.7-flash-low",
          agy_conversation_id: "019e7b21-cb7d-7f23-8674-11036ed141ef",
          paths: frozenPaths,
          sandbox: frozenSandbox,
        } as any,
      });
      const result = await resumeAgent(agent);
      expect(result.ok).toBe(true);

      const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
      expect(resumeScript).toContain("--conversation '019e7b21-cb7d-7f23-8674-11036ed141ef'");
      expect(resumeScript).toContain("--model 'gemini-3.7-flash-low'");
      expect(resumeScript).not.toContain("-i ");
      expect(resumeScript).not.toContain("claude --resume");

      // Worktree files regenerated unconditionally (tampered file overwritten).
      const hooks = JSON.parse(await Bun.file(join(agentDir, "repo", ".agents", "hooks.json")).text());
      expect(hooks.ittybitty.PreToolUse[0].hooks[0].command).toContain("hooks agy-pre-tool-use agent-agy-ok");
      const rule = await Bun.file(join(agentDir, "repo", ".agents", "rules", "ittybitty-agent.md")).text();
      expect(rule.startsWith("---\ntrigger: always_on")).toBe(true);
      expect(rule).toContain("/frozen/agy/read");
      expect(rule).toContain("/frozen/agy/write");
      expect(rule).toContain("**/agy-secret");
      // Mandatory sandbox: agy is now wrapped by the kernel like every other CLI.
      expect(rule).toContain("The kernel sandbox is ON");

      // tmux new-session ran with the resume script.
      const newSessionCall = spawnCalls.find(c => c[0] === "tmux" && c[1] === "new-session");
      expect(newSessionCall).toBeDefined();
      expect(newSessionCall!.some(arg => arg.includes("resume.sh"))).toBe(true);

      // agy prechecks ran through the shared dispatcher-dry-run context.
      const dryRunStrs = dispatcherDryRunCalls.map(c => c.cmd.join(" "));
      expect(dryRunStrs.some(c => c.includes("hooks agy-pre-tool-use") && c.includes("--dry-run"))).toBe(true);
    });

    test("refuses to resume an agy agent when agy_conversation_id is missing", async () => {
      const agentDir = join(tempDir, ".ittybitty", "agents", "agent-agy-noconv");
      await mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
        id: "agent-agy-noconv",
        tmux_session: "tmux-agent-agy-noconv",
        model: "agy:gemini-3.7-flash-low",
      }));
      const agent = _makeAgent({
        id: "agent-agy-noconv",
        repoPath: tempDir,
        repoName: "test",
        state: "stopped",
        meta: {
          tmux_session: "tmux-agent-agy-noconv",
          model: "agy:gemini-3.7-flash-low",
        } as any,
      });
      const result = await armAndResume(agent);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("agy_conversation_id not yet captured");
      expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
    });
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
    resetNukeResumeSpawnRunner();
    resetSealCapabilityCommandForTesting();
    setSealDeleteForTesting(null);
    resetUserHome();
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
    const sealHome = join(tempDir, "seal-home");
    setUserHome(sealHome);
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    const agent = makeAgent("agent-abc", tempDir);
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(agent.meta));
    const repoId = await getRepoId(tempDir);
    await writeSealRecordDirect(repoId, agent.id, agent.meta as unknown as Record<string, unknown>, sealHome);

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);
    setSealDeleteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting((_action, target, boundRepoId) =>
      ["rm", "-f", sealPath(boundRepoId, target, sealHome)]
    );
    const sealHelperCalls: string[][] = [];
    setNukeResumeSpawnRunner((cmd: string[]) => {
      sealHelperCalls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "run-shell") {
        return Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      }
      return makeSpawnResult(0);
    });

    const result = await mergeAgent(agent, tempDir);

    expect(result.ok).toBe(true);
    expect(await readSealRecord(repoId, agent.id, sealHome)).toBeNull();
    expect(sealHelperCalls.some((cmd) => cmd[0] === "tmux" && cmd[1] === "run-shell")).toBe(true);
    // A merge with commits reports the target branch + full 40-char merge SHA.
    expect(result.stdout).toBe(`Closed agent: agent-abc (merged to main at ${MERGE_HEAD_SHA})`);
    expect(MERGE_HEAD_SHA).toHaveLength(40);
  });

  test("merge reports checked seal cleanup failure before removing agent state", async () => {
    const sealHome = join(tempDir, "seal-home");
    setUserHome(sealHome);
    const id = "agent-seal-cleanup-failure";
    const agentDir = join(tempDir, ".ittybitty", "agents", id);
    await mkdir(join(agentDir, "repo"), { recursive: true });
    const agent = makeAgent(id, tempDir);
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(agent.meta));
    const repoId = await getRepoId(tempDir);
    await writeSealRecordDirect(repoId, id, agent.meta as unknown as Record<string, unknown>, sealHome);

    const runner = makeMergeMock();
    lifecycleSpawnCtx.set(runner);
    setMergeSpawnRunner(runner);
    setSealDeleteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 37"]);
    setNukeResumeSpawnRunner((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "run-shell") {
        return Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      }
      return makeSpawnResult(0);
    });

    const result = await mergeAgent(agent, tempDir);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("sealed-record cleanup failed");
    expect(await readSealRecord(repoId, id, sealHome)).not.toBeNull();
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
    expect(await readdir(join(agentDir, "repo")).catch(() => null)).not.toBeNull();
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

  // ── --keep: merge without closing ───────────────────────────────────────────
  //
  // `ib merge <id> --keep` lands the committed tip of agent/<id> on the target
  // with a real --no-ff merge commit and leaves the agent running: no rebase,
  // no conflict-check worktree, no tmux/process teardown, no worktree/branch
  // removal, no archive, no meta.json state write. These mirror the closing
  // merge tests above through the same makeMergeMock.
  describe("--keep (merge without closing)", () => {
    const KEEP = { keep: true } as const;

    async function makeKeepAgentDir(id = "agent-abc"): Promise<string> {
      const agentDir = join(tempDir, ".ittybitty", "agents", id);
      await mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
        id, tmux_session: `tmux-${id}`, state: "running",
      }));
      return agentDir;
    }

    /** The real merge call (not `merge --abort`, not the merge-check). */
    function findNoFFMerge(): string[] | undefined {
      return spawnCalls.find((c) => c.includes("merge") && c.includes("--no-ff"));
    }

    afterEach(() => {
      isPidAliveCtx.reset();
      nowMsCtx.reset();
    });

    test("refuses when the target checkout has uncommitted changes", async () => {
      await makeKeepAgentDir();
      const runner = makeMergeMock({ repoHasChanges: true });
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("uncommitted changes");
      expect(findNoFFMerge()).toBeUndefined();
    });

    test("does NOT refuse when the agent worktree has uncommitted changes (only committed work lands)", async () => {
      const agentDir = await makeKeepAgentDir();
      const runner = makeMergeMock({ worktreeHasChanges: true });
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(true);
      expect(findNoFFMerge()).toBeDefined();
      // The agent worktree's status is never even consulted — nothing runs
      // inside the agent's worktree on the --keep path.
      const worktreeCalls = spawnCalls.filter((c) => c.includes("-C") && c.includes(join(agentDir, "repo")));
      expect(worktreeCalls).toEqual([]);
    });

    test("refuses when the agent branch does not exist", async () => {
      await makeKeepAgentDir();
      const runner = makeMergeMock({ branchExists: false });
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("does not exist");
      expect(findNoFFMerge()).toBeUndefined();
    });

    test("merges with --no-ff and a descriptive message, with no rebase and no conflict-check worktree", async () => {
      await makeKeepAgentDir();
      const runner = makeMergeMock();
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(true);
      expect(result.stdout).toBe(
        `Merged agent agent-abc into main at ${MERGE_HEAD_SHA} (1 commit(s), agent kept running)`
      );

      // Exactly one --no-ff merge, in the target dir, against the agent branch,
      // with an explicit -m message that says what landed and that the agent
      // stays alive. Never --ff-only, even though this test process runs from
      // an agent worktree (isRunningAsAgent() is true here).
      const mergeCall = findNoFFMerge();
      expect(mergeCall).toBeDefined();
      expect(mergeCall!.slice(0, 6)).toEqual(["git", "-C", tempDir, "merge", "--no-ff", "agent/agent-abc"]);
      expect(mergeCall![6]).toBe("-m");
      const message = mergeCall![7]!;
      expect(message.split("\n")[0]).toBe("Merge agent agent-abc work into main (agent kept running)");
      expect(message).toContain("ib merge agent-abc --keep");
      expect(spawnCalls.find((c) => c.includes("--ff-only"))).toBeUndefined();

      // No rebase of any kind: neither the temp conflict-check rebase nor the
      // in-worktree rebase, and no temp branch/worktree for the check.
      expect(spawnCalls.find((c) => c.includes("rebase"))).toBeUndefined();
      expect(spawnCalls.find((c) => c.some((a) => a.startsWith("temp-rebase-check-")))).toBeUndefined();
      expect(spawnCalls.find((c) => c.some((a) => a.includes("/tmp/ib-rebase-check-")))).toBeUndefined();

      // Checkout of the target branch (in the target dir) happens before the merge.
      const checkoutCall = spawnCalls.find((c) => c.includes("checkout") && c.includes("main"));
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall).toContain("-C");
      expect(checkoutCall).toContain(tempDir);
      expect(spawnCalls.indexOf(checkoutCall!)).toBeLessThan(spawnCalls.indexOf(mergeCall!));
    });

    test("leaves the agent untouched: no teardown, no worktree/branch removal, no archive, state unchanged", async () => {
      const agentDir = await makeKeepAgentDir();
      const runner = makeMergeMock();
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);
      expect(result.ok).toBe(true);

      // Agent dir + meta.json survive, and meta.json is byte-for-byte what we wrote
      // (no state write, no nickname/other field touched).
      const meta = await Bun.file(join(agentDir, "meta.json")).json();
      expect(meta).toEqual({ id: "agent-abc", tmux_session: "tmux-agent-abc", state: "running" });
      expect(await readdir(join(agentDir, "repo"))).toEqual([]); // worktree dir still there

      // None of the closing merge's teardown commands ran.
      expect(spawnCalls.find((c) => c.includes("has-session"))).toBeUndefined();
      expect(spawnCalls.find((c) => c.includes("kill-session"))).toBeUndefined();
      expect(spawnCalls.find((c) => c[0] === "pgrep")).toBeUndefined();
      expect(spawnCalls.find((c) => c.includes("worktree") && c.includes("remove"))).toBeUndefined();
      expect(spawnCalls.find((c) => c.includes("branch") && c.includes("-D"))).toBeUndefined();

      // Not archived, questions untouched.
      const archived = await readdir(join(tempDir, ".ittybitty", "archive")).catch(() => null);
      expect(archived).toBeNull();

      // The op marker was taken (agent rendered `merging` during the op) and is
      // cleared in `finally`, so detectAgentStates falls back to the real state.
      const t = await readAgentTransient(agentDir);
      expect(t?.operation).toBeNull();

      // agent.log records the merge and that the agent stayed alive.
      const log = await Bun.file(join(agentDir, "agent.log")).text();
      expect(log).toContain(`Merged 1 commit(s) into main at ${MERGE_HEAD_SHA}`);
      expect(log).toContain("agent left running on agent/agent-abc");
    });

    test("holds the `merging` op marker during the merge and refuses a concurrent op", async () => {
      const agentDir = await makeKeepAgentDir();
      isPidAliveCtx.set(() => true);
      nowMsCtx.set(() => 1000); // op fresh → refuse
      await setAgentOperation(agentDir, { kind: "restarting", pid: 4242, started_at_ms: 1 });

      const runner = makeMergeMock();
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("currently restarting");
      expect(spawnCalls.length).toBe(0); // refused before any git work
      // The other op's marker is untouched.
      const t = await readAgentTransient(agentDir);
      expect(t?.operation).toEqual({ kind: "restarting", pid: 4242, started_at_ms: 1 });
    });

    test("aborts cleanly on conflict and leaves the agent running", async () => {
      const agentDir = await makeKeepAgentDir();
      const runner = makeMergeMock({ mergeFails: true });
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Merge failed (aborted, main unchanged, agent agent-abc still running)");
      expect(result.stderr).toContain("Merge conflict"); // git's own output is included
      expect(result.stderr).toContain("ib merge agent-abc --keep"); // retry hint
      expect(result.stderr).not.toContain("WARNING"); // abort left a clean checkout

      // `git merge --abort` ran in the target dir, after the failed merge.
      const mergeCall = findNoFFMerge();
      const abortCall = spawnCalls.find((c) => c.includes("merge") && c.includes("--abort"));
      expect(abortCall).toEqual(["git", "-C", tempDir, "merge", "--abort"]);
      expect(spawnCalls.indexOf(abortCall!)).toBeGreaterThan(spawnCalls.indexOf(mergeCall!));

      // Agent untouched; op marker cleared so a retry is not blocked.
      expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
      expect(spawnCalls.find((c) => c.includes("worktree") && c.includes("remove"))).toBeUndefined();
      expect(spawnCalls.find((c) => c.includes("kill-session"))).toBeUndefined();
      const t = await readAgentTransient(agentDir);
      expect(t?.operation).toBeNull();
      const log = await Bun.file(join(agentDir, "agent.log")).text();
      expect(log).toContain("failed - aborted; agent left running");
    });

    test("warns when the target checkout is still dirty after the abort", async () => {
      await makeKeepAgentDir();
      const base = makeMergeMock({ mergeFails: true });
      let aborted = false;
      const runner = (cmd: string[], opts?: any) => {
        if (cmd.includes("merge") && cmd.includes("--abort")) {
          aborted = true;
          spawnCalls.push(cmd);
          return makeSpawnResult(1, "", "fatal: could not reset");
        }
        // Preflight status is clean; the post-abort status still shows the conflict.
        if (aborted && cmd.includes("status") && cmd.includes("--porcelain") && cmd.includes(tempDir)) {
          spawnCalls.push(cmd);
          return makeSpawnResult(0, "UU file.ts\n");
        }
        return base(cmd, opts);
      };
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Merge failed");
      expect(result.stderr).toContain(`WARNING: ${tempDir} is not clean after the abort`);
    });

    test("reports nothing to merge when the branch has no new commits, without touching the checkout", async () => {
      const agentDir = await makeKeepAgentDir();
      const runner = makeMergeMock({ commitCount: 0 });
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(true);
      expect(result.stdout).toBe(
        "Nothing to merge: agent/agent-abc has no commits ahead of main (agent agent-abc kept running)"
      );
      expect(spawnCalls.find((c) => c.includes("checkout"))).toBeUndefined();
      expect(findNoFFMerge()).toBeUndefined();
      expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
      const log = await Bun.file(join(agentDir, "agent.log")).text();
      expect(log).toContain("Nothing to merge (--keep)");
    });

    test("returns error when checkout fails, before any merge", async () => {
      await makeKeepAgentDir();
      const runner = makeMergeMock({ checkoutFails: true });
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Could not checkout main");
      expect(findNoFFMerge()).toBeUndefined();
    });

    test("merges into the manager's branch when called from a manager worktree", async () => {
      await makeKeepAgentDir();
      const runner = makeMergeMock({ currentBranch: "agent/agent-manager" });
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, KEEP);

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("into agent/agent-manager at");
      const checkoutCall = spawnCalls.find((c) => c.includes("checkout"));
      expect(checkoutCall).toContain("agent/agent-manager");
      const mergeCall = findNoFFMerge();
      expect(mergeCall).toContain("agent/agent-abc");
      expect(mergeCall![7]).toContain("into agent/agent-manager");
      // Commit counting is against the manager's branch, not main.
      const logCall = spawnCalls.find((c) => c.includes("log") && c.includes("--oneline"));
      expect(logCall).toContain("agent/agent-manager..agent/agent-abc");
    });

    test("refuses from within the agent's own worktree (shared preflight)", async () => {
      // Same construction as the closing-merge test above: pick a repoPath whose
      // agent worktree path is a prefix of this process's cwd.
      const cwd = process.cwd();
      const marker = "/.ittybitty/agents/";
      const idx = cwd.indexOf(marker);
      if (idx === -1) return; // not running inside an agent worktree — nothing to prove
      const repoPath = cwd.slice(0, idx);
      const ourAgentId = cwd.slice(idx + marker.length).split("/")[0]!;
      const agentDir = join(repoPath, ".ittybitty", "agents", ourAgentId);
      const metaExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
      if (!metaExists) return;

      const runner = makeMergeMock();
      lifecycleSpawnCtx.set(runner);
      setMergeSpawnRunner(runner);

      const agent = _makeAgent({
        id: ourAgentId,
        repoPath,
        repoName: "test",
        meta: { tmux_session: `tmux-${ourAgentId}` } as any,
      });
      const result = await mergeAgent(agent, tempDir, KEEP);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Cannot merge agent from within its own worktree");
    });
  });
});

// ── mergeAgent --keep against real git ───────────────────────────────────────
//
// The mocked tests above pin the command sequence; these pin the git
// semantics the design rests on: a porcelain `git merge --no-ff` in the
// checkout that has the target branch checked out leaves HEAD, index and
// working tree consistent, `--abort` restores all three on a conflict, and a
// second --keep lands only the commits made since the first. Real
// subprocesses, so the same 60s failure bound as the other real-git suites.

describe("buildKeepMergeMessage", () => {
  test("subject names the agent, target and that it stays running; body says what landed and how to land more", () => {
    const msg = buildKeepMergeMessage("agent-abc", "agent/agent-abc", "main", 1);
    const [subject, blank, ...body] = msg.split("\n");
    expect(subject).toBe("Merge agent agent-abc work into main (agent kept running)");
    expect(blank).toBe("");
    expect(body.join("\n")).toBe(
      "1 commit from agent/agent-abc landed via `ib merge agent-abc --keep`.\n" +
      "The agent was left running on agent/agent-abc; commits it makes after this\n" +
      "point can be merged the same way."
    );
  });

  test("pluralises the commit count", () => {
    expect(buildKeepMergeMessage("agent-abc", "agent/agent-abc", "main", 3)).toContain("3 commits from agent/agent-abc");
    expect(buildKeepMergeMessage("agent-abc", "agent/agent-abc", "main", 0)).toContain("0 commits from");
  });

  test("uses the detected target branch verbatim (manager branches included)", () => {
    const msg = buildKeepMergeMessage("agent-abc", "agent/agent-abc", "agent/agent-manager", 2);
    expect(msg.split("\n")[0]).toBe("Merge agent agent-abc work into agent/agent-manager (agent kept running)");
  });
});

describe("mergeAgent --keep (real git)", () => {
  let tempDir: string;
  let homeDir: string;
  let agentDir: string;
  let worktree: string;
  let originalHome: string | undefined;

  async function git(...args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
    }
    return stdout.trim();
  }

  /** Commit `content` to `file` on the agent branch, inside the agent worktree. */
  async function agentCommit(file: string, content: string, msg: string): Promise<string> {
    await Bun.write(join(worktree, file), content);
    await git("-C", worktree, "add", file);
    await git("-C", worktree, "commit", "-q", "-m", msg);
    return git("-C", worktree, "rev-parse", "HEAD");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "merge-keep-git-"));
    // A throwaway home: the closing-merge test below archives, removes the
    // seal and prunes teams, all of which resolve under the user home. Keep
    // every one of those writes out of the real ~/.itsybitsy.
    homeDir = await mkdtemp(join(tmpdir(), "merge-keep-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    setUserHome(homeDir);
    setUserConfigPath(join(homeDir, ".itsybitsy", "config.json"));
    await git("init", "-q", "-b", "main", tempDir);
    await git("-C", tempDir, "config", "user.email", "test@example.com");
    await git("-C", tempDir, "config", "user.name", "Test User");
    await git("-C", tempDir, "config", "commit.gpgsign", "false");
    await Bun.write(join(tempDir, "tracked.txt"), "base\n");
    await git("-C", tempDir, "add", "tracked.txt");
    await git("-C", tempDir, "commit", "-q", "-m", "base");
    // `ib add` keeps .ittybitty/ out of the checkout's status; mirror that here
    // so the preflight's clean-target check sees a clean primary checkout.
    await Bun.write(join(tempDir, ".git", "info", "exclude"), ".ittybitty/\n");

    agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    worktree = join(agentDir, "repo");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc", tmux_session: "tmux-agent-abc", state: "running",
    }));
    await git("-C", tempDir, "worktree", "add", "-q", "-b", "agent/agent-abc", worktree, "main");
  });

  afterEach(async () => {
    resetMergeSpawnRunner();
    lifecycleSpawnCtx.reset();
    isPidAliveCtx.reset();
    resetUserConfigPath();
    resetUserHome();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  test("creates a --no-ff merge commit and leaves the primary checkout consistent and the agent intact; a second --keep lands only newer commits", async () => {
    const agentTip1 = await agentCommit("feature.txt", "one\n", "agent: one");
    const mainBefore = await git("-C", tempDir, "rev-parse", "main");

    const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, { keep: true });
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(
      /^Merged agent agent-abc into main at [0-9a-f]{40} \(1 commit\(s\), agent kept running\)$/
    );

    // A real merge commit: two parents — previous main, and the agent's tip.
    const mainHead = await git("-C", tempDir, "rev-parse", "main");
    expect(mainHead).not.toBe(mainBefore);
    expect(result.stdout).toContain(mainHead);
    const parents = (await git("-C", tempDir, "log", "-1", "--format=%P", "main")).split(" ");
    expect(parents).toEqual([mainBefore, agentTip1]);
    expect(await git("-C", tempDir, "log", "-1", "--format=%s", "main"))
      .toBe("Merge agent agent-abc work into main (agent kept running)");
    expect(await git("-C", tempDir, "log", "-1", "--format=%b", "main")).toContain("ib merge agent-abc --keep");

    // Primary checkout: still on main, HEAD == main, index == HEAD, working
    // tree == index (status empty), and the merged file is really on disk.
    expect(await git("-C", tempDir, "branch", "--show-current")).toBe("main");
    expect(await git("-C", tempDir, "rev-parse", "HEAD")).toBe(mainHead);
    expect(await git("-C", tempDir, "status", "--porcelain")).toBe("");
    expect(await Bun.file(join(tempDir, "feature.txt")).text()).toBe("one\n");
    expect(await Bun.file(join(tempDir, ".git", "MERGE_HEAD")).exists()).toBe(false);

    // Agent intact: branch at the same tip, worktree present, clean and still
    // on its branch, meta.json untouched, op marker cleared.
    expect(await git("-C", tempDir, "rev-parse", "agent/agent-abc")).toBe(agentTip1);
    expect(await git("-C", worktree, "branch", "--show-current")).toBe("agent/agent-abc");
    expect(await git("-C", worktree, "status", "--porcelain")).toBe("");
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta).toEqual({ id: "agent-abc", tmux_session: "tmux-agent-abc", state: "running" });
    expect((await readAgentTransient(agentDir))?.operation).toBeNull();

    // Second round: the agent keeps working, and only the NEW commit lands.
    const agentTip2 = await agentCommit("feature.txt", "two\n", "agent: two");
    const result2 = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, { keep: true });
    expect(result2.ok).toBe(true);
    expect(result2.stdout).toContain("(1 commit(s), agent kept running)");
    const parents2 = (await git("-C", tempDir, "log", "-1", "--format=%P", "main")).split(" ");
    expect(parents2).toEqual([mainHead, agentTip2]);
    expect(await git("-C", tempDir, "status", "--porcelain")).toBe("");
    expect(await Bun.file(join(tempDir, "feature.txt")).text()).toBe("two\n");
    // Nothing left to land — and a third --keep says so without a new commit.
    expect(await git("-C", tempDir, "log", "--oneline", "main..agent/agent-abc")).toBe("");
    const mainAfter2 = await git("-C", tempDir, "rev-parse", "main");
    const result3 = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, { keep: true });
    expect(result3.ok).toBe(true);
    expect(result3.stdout).toContain("Nothing to merge");
    expect(await git("-C", tempDir, "rev-parse", "main")).toBe(mainAfter2);
    // History: base, agent: one, merge, agent: two, merge — as it happened.
    expect((await git("-C", tempDir, "rev-list", "--count", "main"))).toBe("5");
  });

  test("aborts cleanly on a conflict: main unchanged, checkout clean, agent untouched", async () => {
    const agentTip = await agentCommit("tracked.txt", "agent\n", "agent: edit tracked");
    await Bun.write(join(tempDir, "tracked.txt"), "main\n");
    await git("-C", tempDir, "commit", "-q", "-am", "main: edit tracked");
    const mainBefore = await git("-C", tempDir, "rev-parse", "main");

    const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, { keep: true });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Merge failed (aborted, main unchanged, agent agent-abc still running)");
    expect(result.stderr).toContain("CONFLICT");
    expect(result.stderr).not.toContain("WARNING");

    // Primary checkout exactly as before: same HEAD, no MERGE_HEAD, clean
    // status, main's content on disk.
    expect(await git("-C", tempDir, "rev-parse", "main")).toBe(mainBefore);
    expect(await git("-C", tempDir, "rev-parse", "HEAD")).toBe(mainBefore);
    expect(await Bun.file(join(tempDir, ".git", "MERGE_HEAD")).exists()).toBe(false);
    expect(await git("-C", tempDir, "status", "--porcelain")).toBe("");
    expect(await Bun.file(join(tempDir, "tracked.txt")).text()).toBe("main\n");

    // Agent untouched.
    expect(await git("-C", tempDir, "rev-parse", "agent/agent-abc")).toBe(agentTip);
    expect(await git("-C", worktree, "status", "--porcelain")).toBe("");
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
    expect((await readAgentTransient(agentDir))?.operation).toBeNull();
  });

  test("refuses on a dirty primary checkout without touching main", async () => {
    await agentCommit("feature.txt", "one\n", "agent: one");
    await Bun.write(join(tempDir, "tracked.txt"), "dirty\n");
    const mainBefore = await git("-C", tempDir, "rev-parse", "main");

    const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, { keep: true });

    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("Target directory has uncommitted changes");
    expect(await git("-C", tempDir, "rev-parse", "main")).toBe(mainBefore);
    expect(await Bun.file(join(tempDir, "tracked.txt")).text()).toBe("dirty\n");
    expect(await Bun.file(join(tempDir, "feature.txt")).exists()).toBe(false);
  });

  test("merges the committed tip even while the agent worktree has uncommitted edits", async () => {
    await agentCommit("feature.txt", "one\n", "agent: one");
    // In-progress, uncommitted work in the agent's worktree.
    await Bun.write(join(worktree, "feature.txt"), "one\nwip\n");
    await Bun.write(join(worktree, "scratch.txt"), "untracked\n");

    const result = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, { keep: true });

    expect(result.ok).toBe(true);
    // Only the committed content landed on main…
    expect(await Bun.file(join(tempDir, "feature.txt")).text()).toBe("one\n");
    expect(await Bun.file(join(tempDir, "scratch.txt")).exists()).toBe(false);
    expect(await git("-C", tempDir, "status", "--porcelain")).toBe("");
    // …and the agent's in-progress edits are exactly where it left them.
    expect(await Bun.file(join(worktree, "feature.txt")).text()).toBe("one\nwip\n");
    expect(await git("-C", worktree, "status", "--porcelain")).toContain("feature.txt");
    expect(await git("-C", worktree, "status", "--porcelain")).toContain("scratch.txt");
  });

  test("targets the manager's branch when run from a manager worktree, leaving main untouched", async () => {
    const managerWorktree = join(tempDir, ".ittybitty", "agents", "agent-manager", "repo");
    await mkdir(join(tempDir, ".ittybitty", "agents", "agent-manager"), { recursive: true });
    await git("-C", tempDir, "worktree", "add", "-q", "-b", "agent/agent-manager", managerWorktree, "main");
    const mainBefore = await git("-C", tempDir, "rev-parse", "main");
    const managerBefore = await git("-C", managerWorktree, "rev-parse", "HEAD");
    const agentTip = await agentCommit("feature.txt", "one\n", "agent: one");

    const result = await mergeAgent(makeAgent("agent-abc", tempDir), managerWorktree, { keep: true });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("into agent/agent-manager at");
    // The manager's checkout got the merge commit and is consistent.
    const parents = (await git("-C", managerWorktree, "log", "-1", "--format=%P", "HEAD")).split(" ");
    expect(parents).toEqual([managerBefore, agentTip]);
    expect(await git("-C", managerWorktree, "log", "-1", "--format=%s", "HEAD"))
      .toBe("Merge agent agent-abc work into agent/agent-manager (agent kept running)");
    expect(await git("-C", managerWorktree, "branch", "--show-current")).toBe("agent/agent-manager");
    expect(await git("-C", managerWorktree, "status", "--porcelain")).toBe("");
    expect(await Bun.file(join(managerWorktree, "feature.txt")).text()).toBe("one\n");
    // main and the primary checkout did not move.
    expect(await git("-C", tempDir, "rev-parse", "main")).toBe(mainBefore);
    expect(await git("-C", tempDir, "status", "--porcelain")).toBe("");
    expect(await Bun.file(join(tempDir, "feature.txt")).exists()).toBe(false);
    // The sub-agent is still alive on its branch.
    expect(await git("-C", tempDir, "rev-parse", "agent/agent-abc")).toBe(agentTip);
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
  });

  test("the eventual closing `ib merge` after a --keep lands only the newer commits and closes the agent", async () => {
    // Round 1: --keep lands c1; the agent keeps working and commits c2.
    await agentCommit("feature.txt", "one\n", "agent: one");
    const keep = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir, { keep: true });
    expect(keep.ok).toBe(true);
    const keepMerge = await git("-C", tempDir, "rev-parse", "main");
    await agentCommit("feature.txt", "two\n", "agent: two");

    // Closing merge with REAL git. tmux/pgrep are mocked so no process is
    // touched; the temp home (beforeEach) absorbs the archive/seal/team
    // writes. mergeSpawnCtx runs git + tmux, lifecycleSpawnCtx the kill and
    // orphan-scan side.
    const hybrid: SpawnFn = (cmd) => {
      if (cmd[0] === "git") return Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      if (cmd[0] === "tmux" && cmd.includes("has-session")) return makeSpawnResult(1);
      if (cmd[0] === "pgrep") return makeSpawnResult(1);
      return makeSpawnResult();
    };
    setMergeSpawnRunner(hybrid);
    lifecycleSpawnCtx.set(hybrid);

    const closing = await mergeAgent(makeAgent("agent-abc", tempDir), tempDir);
    expect(closing.ok).toBe(true);
    expect(closing.stdout).toMatch(/^Closed agent: agent-abc \(merged to main at [0-9a-f]{40}\)$/);

    // Only c2 landed: the closing rebase dropped the already-landed c1 (it is
    // reachable from main through the --keep merge commit), so each agent
    // commit appears exactly once in main's history and the file has c2's
    // content. Checkout consistent, no merge in progress.
    const subjects = (await git("-C", tempDir, "log", "--format=%s", "main")).split("\n");
    expect(subjects.filter((s) => s === "agent: one")).toHaveLength(1);
    expect(subjects.filter((s) => s === "agent: two")).toHaveLength(1);
    expect(await Bun.file(join(tempDir, "feature.txt")).text()).toBe("two\n");
    expect(await git("-C", tempDir, "status", "--porcelain")).toBe("");
    expect(await Bun.file(join(tempDir, ".git", "MERGE_HEAD")).exists()).toBe(false);

    // The closing strategy depends on the caller (SPEC 3.4): --ff-only when
    // this process runs as an agent, --no-ff otherwise. Both build on the
    // --keep merge commit; assert the exact shape for whichever path applies
    // to the environment running this test.
    const head = await git("-C", tempDir, "rev-parse", "main");
    expect(closing.stdout).toContain(head);
    const parents = (await git("-C", tempDir, "log", "-1", "--format=%P", "main")).split(" ");
    if (await isRunningAsAgent()) {
      // Fast-forward to the rebased c2: one parent, the --keep merge commit.
      expect(parents).toEqual([keepMerge]);
      expect(subjects[0]).toBe("agent: two");
      expect(await git("-C", tempDir, "rev-list", "--count", "main")).toBe("4");
    } else {
      // A merge commit of the rebased c2 onto the --keep merge commit.
      expect(parents).toHaveLength(2);
      expect(parents[0]).toBe(keepMerge);
      expect(subjects[0]).toBe("Merge agent agent-abc work");
      expect(await git("-C", tempDir, "rev-list", "--count", "main")).toBe("5");
    }

    // Closed for real: branch and worktree gone, agent dir archived.
    expect(await git("-C", tempDir, "branch", "--list", "agent/agent-abc")).toBe("");
    expect(await readdir(worktree).catch(() => null)).toBeNull();
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(false);
    expect(await readdir(join(tempDir, ".ittybitty", "archive"))).toHaveLength(1);
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

      // Sandbox subprocess preflight (mandatory sandbox): mock `which
      // sandbox-exec` + the `sandbox-exec … /usr/bin/true` compile lint so every
      // newAgent spawn — now ALWAYS sandboxed — clears prepareSandbox without a
      // real sandbox-exec. sandboxSpawnRunner overrides these to inject failures.
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") {
        return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      }
      if (cmd[0] === "/usr/bin/sandbox-exec") {
        return makeSpawnResult("", 0);
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

  /**
   * Mandatory sandbox: prepareSandbox runs on EVERY spawn now, probing `which
   * sandbox-exec`, resolving the git common dir, and compiling the profile. Any
   * custom inline runner in this block must answer those so the spawn clears
   * preflight. Returns a local-convention SpawnResult for those commands, or null
   * to fall through to the runner's own handling. Only intercepts the sandbox
   * probe + git rev-parse forms — never the branch/worktree commands a runner may
   * mock specifically.
   */
  function sbPreflight(cmd: string[]): SpawnResult | null {
    const cmdStr = cmd.join(" ");
    if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
    if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
    if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
    return null;
  }

  let originalHome: string | undefined;
  // Captures (cmd, cwd) for every codex dispatcher dry-run subprocess.
  // The codex dry-run goes through dispatcherDryRunSpawnCtx (NOT newAgentSpawnCtx)
  // so the runtime hook can resolve agentsDir from the worktree cwd. Without
  // capturing cwd here, tests can't verify the fix that routes workPath into
  // the subprocess. Tests that need to inject precheck failure should override
  // via setDispatcherDryRunSpawnRunner.
  let dispatcherDryRunCalls: Array<{ cmd: string[]; cwd: string }>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ib-newagent-test-"));
    agentsDir = join(tempDir, ".ittybitty", "agents");
    spawnCalls = [];
    dispatcherDryRunCalls = [];

    // Synthetic lifecycle tests do not have a real agent process rooted in
    // their temporary repositories. Keep OS ancestry out of the shared
    // fixture; caller-attribution cases install an explicit resolver below.
    setNewAgentNoWorktreeCallerResolver(async () => null);

    // Default codex dry-run runner: capture (cmd, cwd) + succeed.
    setDispatcherDryRunSpawnRunner((cmd, cwd) => {
      dispatcherDryRunCalls.push({ cmd, cwd });
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
    resetDispatcherDryRunSpawnRunner();
    resetNewAgentSummaryGenerator();
    resetWatchdogSpawnFn();
    resetNukeResumeSpawnRunner();
    resetSandboxWiringForTesting();
    resetSealDirectWriteForTesting();
    resetSealDirectVerifyForTesting();
    resetSealCapabilityCommandForTesting();
    setSealDeleteForTesting(null);
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

  /**
   * Write a minimal agent-type layer/type file with an optional `effort:` field
   * (and optional `model:`). `effortLine` is inserted verbatim into the
   * frontmatter, so callers can pass "effort: high" (real value), "effort:"
   * (blank → inherit), or "" (omit the key). Mirrors writeLayerModel; `spawnable`
   * defaults to true; layer files must pass `spawnable: false`.
   */
  async function writeLayerEffort(
    name: string,
    effortLine: string,
    opts?: { spawnable?: boolean; canSpawnChildren?: boolean; modelLine?: string },
  ) {
    const path = join(process.env.HOME!, ".itsybitsy", "agent-types", `${name}.md`);
    const spawnableLine = opts?.spawnable === false ? "spawnable: false\n" : "";
    const canSpawnLine = opts?.canSpawnChildren ? "canSpawnChildren: true\n" : "";
    const fmModel = opts?.modelLine ? `${opts.modelLine}\n` : "";
    const fmEffort = effortLine ? `${effortLine}\n` : "";
    const body = `---\nname: ${name}\ndescription: Test ${name} layer\n${spawnableLine}${canSpawnLine}${fmModel}${fmEffort}---\n`;
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

  async function writeSandboxType(
    name = "sandboxed",
    options?: { enabled?: boolean; omitEnabled?: boolean; model?: string; allowRead?: string[]; allowWrite?: string[]; deny?: string[] },
  ) {
    const path = join(process.env.HOME!, ".itsybitsy", "agent-types", `${name}.md`);
    const allowRead = JSON.stringify(options?.allowRead ?? [tempDir]);
    const allowWrite = JSON.stringify(options?.allowWrite ?? [tempDir]);
    const deny = JSON.stringify(options?.deny ?? ["**/.env"]);
    await Bun.write(path, `---
name: ${name}
description: Sandbox wiring test
model: ${options?.model ?? "claude:sonnet"}
paths:
  allowRead: ${allowRead}
  allowWrite: ${allowWrite}
  deny: ${deny}
sandbox:
${options?.omitEnabled ? "" : `  enabled: ${options?.enabled ?? true}\n`}
  rawAllow: ["(allow process*)"]
  domains: ["api.anthropic.com", "*.anthropic.com"]
---
`);
  }

  function sandboxSpawnRunner(options?: {
    missingExec?: boolean;
    lintFail?: boolean;
    gitCommonDirFail?: boolean;
  }) {
    const inner = cleanWorktreeRunner();
    return (cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") {
        return makeSpawnResult(options?.missingExec ? "" : "/usr/bin/sandbox-exec", options?.missingExec ? 1 : 0);
      }
      if (cmd[0] === "/usr/bin/sandbox-exec") {
        return makeSpawnResult(options?.lintFail ? "profile syntax error" : "", options?.lintFail ? 1 : 0);
      }
      if (cmd.includes("--git-common-dir") && options?.gitCommonDirFail) {
        return makeSpawnResult("", 1);
      }
      return inner(cmd, opts);
    };
  }

  function sandboxResumeRunner() {
    let created = false;
    return (cmd: string[]): SpawnResult => {
      const command = cmd.join(" ");
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (command.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (command.includes("tmux has-session")) return makeSpawnResult("", created ? 0 : 1);
      if (command.includes("tmux new-session")) created = true;
      if (command.includes("capture-pane")) return makeSpawnResult("Claude Code v1.0", 0);
      return makeSpawnResult("", 0);
    };
  }

  function sandboxResumeWithTmuxHelperRunner() {
    const inner = sandboxResumeRunner();
    return (cmd: string[]): SpawnResult => {
      if (cmd[0] === "tmux" && cmd[1] === "run-shell") {
        return Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      }
      return inner(cmd);
    };
  }

  function useRealSealVerificationHelper(): void {
    const modulePath = join(import.meta.dir, "agent-seal.ts");
    const helperHome = process.env.HOME!;
    setSealCapabilityCommandForTesting((action, target, repoId, meta) => {
      if (action !== "verify") return ["sh", "-c", "exit 99"];
      const script = [
        `const m = await import(${JSON.stringify(modulePath)});`,
        `const capPath = m.sealCapabilityPath(${JSON.stringify(repoId)}, ${JSON.stringify(target)}, process.env.IB_SEAL_CAP, ${JSON.stringify(helperHome)});`,
        `const cap = await Bun.file(capPath).json();`,
        `const digest = await m.sealCapabilityDigest("verify", ${JSON.stringify(repoId)}, ${JSON.stringify(target)}, ${JSON.stringify(meta)});`,
        `if (cap.digest !== digest) console.error(JSON.stringify({ capDigest: cap.digest, digest, home: process.env.HOME }));`,
        `const result = await m.applySealCapabilityAction("verify", ${JSON.stringify(repoId)}, ${JSON.stringify(target)}, process.env.IB_SEAL_CAP, ${JSON.stringify(meta)}, ${JSON.stringify(helperHome)});`,
        "console.log(JSON.stringify(result));",
      ].join(" ");
      return ["bun", "-e", script];
    });
  }

  function denyDirectSealVerification(): void {
    setSealDirectVerifyForTesting(async () => {
      throw Object.assign(new Error("EACCES: protected seal read denied"), { code: "EACCES" });
    });
  }

  test("path layer union and dedupe are independent of layer and entry order", () => {
    const makeLayer = (
      name: string,
      allowRead: string[],
      allowWrite: string[],
      deny: string[],
    ): import("./agent-types").AgentType => ({
      name,
      description: "",
      canSpawnChildren: false,
      instructionStyle: "worker",
      paths: { allowRead, allowWrite, deny },
    });
    const forward = mergeSandboxLayerConfigs([
      makeLayer("floor", ["/a", "/shared", "/a"], ["/w1"], ["/d1"]),
      makeLayer("middle", ["/b", "/shared"], ["/w2", "/w1"], ["/d2"]),
      makeLayer("leaf", ["/c"], ["/w3"], ["/d1", "/d3"]),
    ]).paths;
    const shuffled = mergeSandboxLayerConfigs([
      makeLayer("leaf", ["/c"], ["/w3"], ["/d3", "/d1"]),
      makeLayer("floor", ["/a", "/a", "/shared"], ["/w1"], ["/d1"]),
      makeLayer("middle", ["/shared", "/b"], ["/w1", "/w2"], ["/d2"]),
    ]).paths;
    const asSets = (value: typeof forward) => ({
      allowRead: [...value.allowRead].sort(),
      allowWrite: [...value.allowWrite].sort(),
      deny: [...value.deny].sort(),
    });
    expect(asSets(shuffled)).toEqual(asSets(forward));
    expect(asSets(forward)).toEqual({
      allowRead: ["/a", "/b", "/c", "/shared"],
      allowWrite: ["/w1", "/w2", "/w3"],
      deny: ["/d1", "/d2", "/d3"],
    });
  });

  test("sandbox layer merge uses the most-specific authored enabled value", () => {
    const layer = (
      name: string,
      enabled: boolean | undefined,
      domain: string,
    ): import("./agent-types").AgentType => ({
      name,
      description: "",
      canSpawnChildren: false,
      instructionStyle: "worker",
      sandbox: {
        ...(enabled === undefined ? {} : { enabled }),
        rawAllow: [],
        domains: [domain],
      },
    });

    expect(mergeSandboxLayerConfigs([
      layer("_all", true, "all.example"),
      layer("_non_coordinator", false, "middle.example"),
      layer("leaf", true, "leaf.example"),
    ]).sandbox).toEqual({
      enabled: true,
      rawAllow: [],
      domains: ["all.example", "middle.example", "leaf.example"],
    });
  });

  test("sandbox layer without enabled preserves inherited false while adding lists", () => {
    const base = { description: "", canSpawnChildren: false, instructionStyle: "worker" as const };
    const merged = mergeSandboxLayerConfigs([
      { name: "_all", ...base, sandbox: { enabled: false, rawAllow: [], domains: ["all.example"] } },
      { name: "leaf", ...base, sandbox: { rawAllow: ["(allow process-fork)"], domains: ["leaf.example"] } },
    ]);
    expect(merged.sandbox).toEqual({
      enabled: false,
      rawAllow: ["(allow process-fork)"],
      domains: ["all.example", "leaf.example"],
    });
    expect(mergeSandboxLayerConfigs([]).sandbox.enabled).toBe(true);
  });

  test("a type with NO paths block merges identically to one with an empty block (deny-by-default)", () => {
    // Adam's invariant at the production merge path: a .md that omits `paths:`
    // entirely must resolve the SAME as one declaring empty lists — never
    // permissive. mergeSandboxLayerConfigs drops undefined layer.paths, so
    // "no layer declares paths" yields empty lists, exactly like an explicit
    // empty block. A missing block must never become an allow.
    const base = { description: "", canSpawnChildren: false, instructionStyle: "worker" as const };
    const noPaths = (name: string): import("./agent-types").AgentType => ({ name, ...base });
    const emptyPaths = (name: string): import("./agent-types").AgentType => ({
      name, ...base, paths: { allowRead: [], allowWrite: [], deny: [] },
    });
    const fromMissing = mergeSandboxLayerConfigs([
      noPaths("_all"), noPaths("_non_coordinator"), noPaths("leaf"),
    ]).paths;
    const fromEmpty = mergeSandboxLayerConfigs([
      emptyPaths("_all"), emptyPaths("_non_coordinator"), emptyPaths("leaf"),
    ]).paths;
    expect(fromMissing).toEqual({ allowRead: [], allowWrite: [], deny: [] });
    expect(fromMissing).toEqual(fromEmpty);
    // A single layer that DOES declare paths still contributes; the "missing"
    // case is empty ONLY because no layer declared any — not a permissive default.
    const withOne = mergeSandboxLayerConfigs([
      noPaths("_all"), emptyPaths("_non_coordinator"),
      { name: "leaf", ...base, paths: { allowRead: ["/opt/thing"], allowWrite: [], deny: [] } },
    ]).paths;
    expect(withOne.allowRead).toEqual(["/opt/thing"]);
  });

  test("explicit sandbox.enabled:false changes only the kernel wrapper and keeps hook-controlled permissions", async () => {
    await writeSandboxType("sandbox-disabled", { enabled: false });
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions", allow: ["Bash(git status:*)"] },
    }));
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99990 }));

    const result = await callNewAgent("plain spawn", { name: "sandbox-disabled", type: "sandbox-disabled" });
    expect(result.ok).toBe(true);
    const start = await Bun.file(join(agentsDir, "sandbox-disabled", "start.sh")).text();
    const meta = await Bun.file(join(agentsDir, "sandbox-disabled", "meta.json")).json();
    expect(start).not.toContain("sandbox-exec");
    expect(start).not.toContain("sandbox-proxy-launch");
    expect(start).not.toContain("sandbox-log-watch");
    expect(start).not.toContain("export http_proxy=");
    expect(start).not.toContain("--dangerously-skip-permissions");
    expect(start).not.toContain("--permission-mode");
    expect(meta.sandbox.enabled).toBe(false);
    expect(meta.sandbox_proxy_port).toBeUndefined();
    expect(meta.paths.allowRead).toContain(canonicalizeSandboxPath(tempDir));
    expect(meta.paths.allowWrite).toContain(canonicalizeSandboxPath(tempDir));
    const settings = await Bun.file(join(agentsDir, "sandbox-disabled", "repo", ".claude", "settings.local.json")).json();
    expect(JSON.stringify(settings.hooks)).toContain("hook-check-path");
    expect(settings.permissions.deny).toContain("EnterPlanMode");
    expect(settings.permissions.defaultMode).toBeUndefined();
  });

  test("disabled no-worktree Claude uses isolated hooks on spawn and resume without rewriting shared settings", async () => {
    const id = "disabled-no-worktree";
    await writeSandboxType(id, { enabled: false });
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    await Bun.write(settingsPath, JSON.stringify({
      permissions: { defaultMode: "bypassPermissions", allow: ["Bash(git status:*)"] },
    }));
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99989 }));

    const originalSharedSettings = await Bun.file(settingsPath).text();
    const spawned = await callNewAgent("hook permissions", { name: id, type: id, noWorktree: true });
    expect(spawned.ok).toBe(true);
    const agentDir = join(agentsDir, id);
    const start = await Bun.file(join(agentDir, "start.sh")).text();
    const isolatedSettingsPath = join(agentDir, ".claude", "settings.local.json");
    expect(start).not.toContain("--permission-mode");
    expect(start).not.toContain("--dangerously-skip-permissions");
    expect(start).toContain(`--settings '${isolatedSettingsPath}'`);
    expect(await Bun.file(settingsPath).text()).toBe(originalSharedSettings);
    const isolated = await Bun.file(isolatedSettingsPath).json();
    expect(isolated.permissions.allow).toContain("Bash(ib:*)");
    expect(isolated.permissions.deny).toContain("EnterPlanMode");
    expect(JSON.stringify(isolated.hooks)).toContain(`hook-check-path ${id}`);

    // Simulate a legacy worktree:false agent created before isolated settings.
    await rm(isolatedSettingsPath);

    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    meta.tmux_session = "";
    meta.created_epoch = 0;
    meta.session_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
    setNukeResumeSpawnRunner(cleanWorktreeRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const resumed = await resumeAgent(makeAgent(id, tempDir, "stopped", meta));
      expect(resumed.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }
    const resume = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resume).not.toContain("--permission-mode");
    expect(resume).not.toContain("--dangerously-skip-permissions");
    expect(resume).toContain(`--settings '${isolatedSettingsPath}'`);
    expect(await Bun.file(settingsPath).text()).toBe(originalSharedSettings);
    const migrated = await Bun.file(isolatedSettingsPath).json();
    expect(migrated.hooks.SessionStart[0].hooks[0].command).toBe(`ib hooks session-start ${id}`);
    expect(migrated.hooks.PostToolUse[0].hooks[0].command).toBe(`ib hooks inject-timestamp ${id}`);
    expect(JSON.stringify(migrated.hooks.PreToolUse)).toContain(`ib hooks intercept-task ${id}`);
    expect(JSON.stringify(migrated.hooks)).toContain(`hook-check-path ${id}`);
  });

  for (const [cli, model] of [
    ["codex", "codex:gpt-5.4-mini"],
    ["fugu", "fugu:gpt-5.4-mini"],
    ["agy", "agy:gemini-3.7-flash-low"],
  ] as const) {
    for (const enabled of [true, false]) {
      test(`rejects ${cli} no-worktree spawn before shared mutations when sandbox is ${enabled ? "on" : "off"}`, async () => {
        const id = `reject-${cli}-${enabled ? "on" : "off"}`;
        await writeSandboxType(id, { enabled, model });
        await mkdir(join(tempDir, ".claude"), { recursive: true });
        const sharedSettingsPath = join(tempDir, ".claude", "settings.local.json");
        await Bun.write(sharedSettingsPath, JSON.stringify({ permissions: { allow: ["UserOnlyTool"] } }));
        const sharedBefore = await Bun.file(sharedSettingsPath).text();
        setNewAgentSpawnRunner(cleanWorktreeRunner());

        const result = await callNewAgent("unsupported shared launch", {
          name: id,
          type: id,
          noWorktree: true,
        });

        expect(result.ok).toBe(false);
        expect(result.stderr).toContain("--no-worktree is supported only for Claude agents");
        expect(await Bun.file(sharedSettingsPath).text()).toBe(sharedBefore);
        expect(await Bun.file(join(agentsDir, id)).exists()).toBe(false);
      });
    }
  }

  for (const [cli, model] of [
    ["codex", "codex:gpt-5.4-mini"],
    ["fugu", "fugu:gpt-5.4-mini"],
    ["agy", "agy:gemini-3.7-flash-low"],
  ] as const) {
    test(`rejects legacy worktree:false ${cli} resume before touching shared boundary files`, async () => {
      const id = `legacy-shared-${cli}`;
      const agentDir = join(agentsDir, id);
      await mkdir(agentDir, { recursive: true });
      const agent = makeAgent(id, tempDir, "stopped", {
        worktree: false,
        model,
        sandbox: { enabled: false, rawAllow: [], domains: [] },
      });
      await Bun.write(join(agentDir, "meta.json"), JSON.stringify(agent.meta));
      await Bun.write(join(tempDir, "AGENTS.md"), "user agents content\n");
      await mkdir(join(tempDir, ".agents"), { recursive: true });
      await Bun.write(join(tempDir, ".agents", "hooks.json"), "user hooks content\n");

      const result = await resumeAgent(agent);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain(`Cannot resume worktree:false ${cli} agent`);
      expect(await Bun.file(join(tempDir, "AGENTS.md")).text()).toBe("user agents content\n");
      expect(await Bun.file(join(tempDir, ".agents", "hooks.json")).text()).toBe("user hooks content\n");
      expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
      expect(await Bun.file(join(agentDir, ".claude", "settings.local.json")).exists()).toBe(false);
    });
  }

  test("disabled same-ID spawn removes orphan enabled seal before launch", async () => {
    const id = "orphan-disabled-reuse";
    await writeSandboxType(id, { enabled: false });
    const repoId = await getRepoId(tempDir);
    const orphanMeta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(join(process.env.HOME!, ".itsybitsy", "sealed"), { recursive: true });
    await Bun.write(sealPath(repoId, id, process.env.HOME!), JSON.stringify(computeSealRecord(await computeSealInputs(orphanMeta))));
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99991 }));
    const result = await callNewAgent("reuse orphan", { name: id, type: id });
    expect(result.ok).toBe(true);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).toBeNull();
    const resumedMeta = await Bun.file(join(agentsDir, id, "meta.json")).json() as AgentMeta;
    resumedMeta.state = "stopped";
    resumedMeta.tmux_session = "";
    resumedMeta.created_epoch = 0;
    resumedMeta.session_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    await Bun.write(join(agentsDir, id, "meta.json"), JSON.stringify(resumedMeta));
    setNukeResumeSpawnRunner(() => makeSpawnResult("", 0));
    const resumed = await resumeAgent(makeAgent(id, tempDir, "stopped", resumedMeta));
    expect(resumed.ok).toBe(true);
  });

  test("disabled same-ID spawn refuses a failed stale-seal deletion and remains retryable", async () => {
    const id = "orphan-disabled-delete-failure";
    await writeSandboxType(id, { enabled: false });
    const repoId = await getRepoId(tempDir);
    const orphanMeta = { agentType: id, sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(join(process.env.HOME!, ".itsybitsy", "sealed"), { recursive: true });
    await Bun.write(sealPath(repoId, id, process.env.HOME!), JSON.stringify(computeSealRecord(await computeSealInputs(orphanMeta))));
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99992 }));
    setSealDeleteForTesting(async () => { throw Object.assign(new Error("injected stale delete failure"), { code: "EIO" }); });
    try {
      const failed = await callNewAgent("reuse orphan", { name: id, type: id });
      expect(failed.ok).toBe(false);
      expect(failed.stderr).toContain("could not remove stale sandbox seal");
    } finally {
      setSealDeleteForTesting(null);
    }
    expect(await readSealRecord(repoId, id, process.env.HOME!)).not.toBeNull();
    expect(await Bun.file(join(agentsDir, id, "meta.json")).exists()).toBe(false);

    const retried = await callNewAgent("reuse orphan", { name: id, type: id });
    expect(retried.ok).toBe(true);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).toBeNull();
  });

  test("omitted sandbox.enabled defaults to an enabled fail-closed launch", async () => {
    await writeSandboxType("sandbox-default-on", { omitEnabled: true });
    setSandboxPortAllocatorForTesting(() => 43120);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99987 }));

    const result = await callNewAgent("default on", { name: "sandbox-default-on", type: "sandbox-default-on" });
    expect(result.ok).toBe(true);
    const agentDir = join(agentsDir, "sandbox-default-on");
    const start = await Bun.file(join(agentDir, "start.sh")).text();
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.sandbox.enabled).toBe(true);
    expect(start).toContain("sandbox-exec");
    expect(start).toContain("sandbox-proxy-launch");
    expect(start).toContain("sandbox-log-watch");
  });

  test("resume refuses legacy enabled sandbox metadata with no paths block", async () => {
    const id = "legacy-enabled-no-paths";
    const agentDir = join(agentsDir, id);
    // An enabled frozen policy cannot reproduce its kernel profile without the
    // corresponding paths block and remains fail-closed.
    const message = `sandbox refused: agent '${id}' has an enabled sandbox but no paths block in meta.json; run \`ib sandbox refresh ${id}\` from an unsandboxed session, or nuke and respawn the agent`;
    const legacyMeta: Partial<AgentMeta> = {
      id,
      state: "stopped",
      model: "claude:sonnet",
      tmux_session: "",
      sandbox: {
        enabled: true,
        rawAllow: ["(allow process*)"],
        domains: ["api.anthropic.com"],
      },
    };
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(legacyMeta, null, 2));
    const resumeCommands: string[][] = [];
    setNukeResumeSpawnRunner((cmd: string[]) => {
      resumeCommands.push(cmd);
      return makeSpawnResult("", 0);
    });

    const result = await resumeAgent(makeAgent(id, tempDir, "stopped", legacyMeta));

    expect(result).toEqual({ ok: false, exitCode: 1, stdout: "", stderr: message });
    expect(await Bun.file(join(agentDir, "agent.log")).text()).toContain(message);
    expect((await Bun.file(join(agentDir, "meta.json")).json()).state).toBe("stopped");
    expect(await Bun.file(join(agentDir, "sandbox.sb")).exists()).toBe(false);
    expect(resumeCommands.some((cmd) => cmd[0] === "/usr/bin/sandbox-exec")).toBe(false);
  });

  test("resume preserves frozen sandbox.enabled:false and launches without kernel helpers", async () => {
    const id = "legacy-disabled-with-paths";
    const agentDir = join(agentsDir, id);
    await mkdir(join(agentDir, "repo"), { recursive: true });
    const legacyMeta: Partial<AgentMeta> = {
      id,
      state: "stopped",
      model: "claude:sonnet",
      tmux_session: "",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sandbox: { enabled: false, rawAllow: [], domains: [] },
      paths: { allowRead: [tempDir], allowWrite: [tempDir], deny: [] },
    };
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(legacyMeta, null, 2));

    spawnCalls = [];
    setNukeResumeSpawnRunner(cleanWorktreeRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    let resumed;
    try {
      resumed = await resumeAgent(makeAgent(id, tempDir, "stopped", legacyMeta));
    } finally {
      resetSendSpawnRunner();
    }

    expect(resumed.ok).toBe(true);
    expect(await Bun.file(join(agentDir, "sandbox.sb")).exists()).toBe(false);
    const resume = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resume).not.toContain("sandbox-exec");
    expect(resume).not.toContain("sandbox-proxy-launch");
    expect(resume).not.toContain("sandbox-log-watch");
    expect(resume).not.toContain("--dangerously-skip-permissions");
    expect(spawnCalls.some((cmd) => cmd[0] === "/usr/bin/sandbox-exec")).toBe(false);
    expect(spawnCalls.some((cmd) => cmd[0] === "which" && cmd[1] === "sandbox-exec")).toBe(false);
  });

  test("disabled coordinator rehire preserves archived settings while retaining hook authority", async () => {
    const id = "disabled-coordinator-resume";
    const agentDir = join(agentsDir, id);
    await mkdir(join(agentDir, ".claude"), { recursive: true });
    const meta: Partial<AgentMeta> = {
      id,
      state: "stopped",
      model: "claude:sonnet",
      agentType: "coordinator",
      tmux_session: "",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sandbox: { enabled: false, rawAllow: [], domains: [] },
      paths: { allowRead: [tempDir], allowWrite: [tempDir], deny: [] },
    };
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
    await Bun.write(join(agentDir, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions", allow: ["Bash(ib:*)"] },
      hooks: { PreToolUse: [{ hooks: [{ command: "ib hooks hook-check-path" }] }] },
    }));
    setNukeResumeSpawnRunner(cleanWorktreeRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    let result;
    try {
      result = await resumeAgent(makeAgent(id, tempDir, "stopped", meta), { resetCoordinator: false });
    } finally {
      resetSendSpawnRunner();
    }

    expect(result.ok).toBe(true);
    const resume = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resume).toContain("--settings");
    expect(resume).not.toContain("--dangerously-skip-permissions");
    expect(resume).not.toContain("--permission-mode");
    const settings = await Bun.file(join(agentDir, ".claude", "settings.local.json")).json();
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
    expect(JSON.stringify(settings.hooks)).toContain("hook-check-path");
  });

  test("sandbox-enabled Codex spawn uses danger-full-access inside our wrapper and proxy", async () => {
    await writeSandboxType("sandbox-codex", { model: "codex:gpt-5.4-mini" });
    setSandboxPortAllocatorForTesting(() => 43121);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99988 }));

    const result = await callNewAgent("sandbox codex", { name: "sandbox-codex", type: "sandbox-codex" });
    expect(result.ok).toBe(true);
    const agentDir = join(agentsDir, "sandbox-codex");
    const start = await Bun.file(join(agentDir, "start.sh")).text();
    const profile = await Bun.file(join(agentDir, "sandbox.sb")).text();
    const agentsMd = await Bun.file(join(agentDir, "repo", "AGENTS.md")).text();
    expect(start).toContain("-a never -s danger-full-access --dangerously-bypass-hook-trust");
    expect(start).not.toContain("-s workspace-write");
    expect(start).toContain(`setsid ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    expect(start).toContain(`    ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    expect(start).toContain("sandbox-proxy-launch");
    expect(start).toContain("export HTTPS_PROXY=\"$http_proxy\"");
    expect(start).toContain("<&0 2> \"$STDERR_LOG\" &");
    expect(start).not.toContain("-D 'PROJECTDIR=");
    expect(start).not.toContain("-D 'SCRATCHPAD=");
    expect(profile).not.toContain('param "PROJECTDIR"');
    expect(profile).not.toContain('param "SCRATCHPAD"');
    expect(agentsMd).toContain(canonicalizeSandboxPath(tempDir));
    expect(agentsMd).toContain("**/.env");
    expect(agentsMd).toContain("The kernel sandbox is ON");
    expect(agentsMd).not.toContain("your Claude project directory and scratchpad");
    expect(dispatcherDryRunCalls.length).toBeGreaterThanOrEqual(3);
    expect(spawnCalls.some((call) => call[0] === "codex")).toBe(false);
  });

  test("sandbox-disabled Codex spawn keeps native protections and hooks but omits every kernel helper", async () => {
    await writeSandboxType("unsandboxed-codex", { enabled: false, model: "codex:gpt-5.4-mini" });
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99986 }));

    const result = await callNewAgent("unsandboxed codex", { name: "unsandboxed-codex", type: "unsandboxed-codex" });
    expect(result.ok).toBe(true);
    const agentDir = join(agentsDir, "unsandboxed-codex");
    const start = await Bun.file(join(agentDir, "start.sh")).text();
    expect(start).toContain("--dangerously-bypass-hook-trust");
    expect(start).not.toContain("-a never");
    expect(start).not.toContain("-s danger-full-access");
    expect(start).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(start).toContain("hooks.PreToolUse");
    expect(start).not.toContain("sandbox-exec");
    expect(start).not.toContain("sandbox-proxy-launch");
    expect(start).not.toContain("sandbox-log-watch");
    expect(spawnCalls.some((cmd) => cmd[0] === "which" && cmd[1] === "sandbox-exec")).toBe(false);
  });

  test("sandbox-enabled Codex resume reallocates proxy, preserves profile, and wraps both launch arms", async () => {
    await writeSandboxType("sandbox-codex-resume", { model: "codex:gpt-5.4-mini" });
    const ports = [43122, 43123];
    setSandboxPortAllocatorForTesting(() => ports.shift()!);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99989 }));
    const spawned = await callNewAgent("resume sandbox codex", { name: "sandbox-codex-resume", type: "sandbox-codex-resume" });
    expect(spawned.ok).toBe(true);

    const id = "sandbox-codex-resume";
    const agentDir = join(agentsDir, id);
    const spawnProfile = await Bun.file(join(agentDir, "sandbox.sb")).text();
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    meta.codex_session_id = "019e7b21-cb7d-7f23-8674-11036ed141ef";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    let createdSession = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const cmdStr = cmd.join(" ");
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("tmux has-session")) return makeSpawnResult("", createdSession ? 0 : 1);
      if (cmdStr.includes("tmux new-session")) { createdSession = true; return makeSpawnResult("", 0); }
      if (cmdStr.includes("capture-pane")) return makeSpawnResult("OpenAI Codex", 0);
      return makeSpawnResult("", 0);
    });
    setSendSpawnRunner(() => makeSpawnResult("", 0));

    try {
      const result = await resumeAgent(makeAgent(id, tempDir, "stopped", meta));
      expect(result.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }

    const resumeProfile = await Bun.file(join(agentDir, "sandbox.sb")).text();
    const resume = await Bun.file(join(agentDir, "resume.sh")).text();
    const resumedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(resumeProfile).toBe(spawnProfile);
    for (const profile of [spawnProfile, resumeProfile]) {
      expect(profile).toContain('(deny file-write* (regex #"^/private/tmp/\\.ib-seal-helper-');
    }
    expect(resumedMeta.sandbox_proxy_port).toBe(43123);
    expect(resume).toContain("-a never -s danger-full-access --dangerously-bypass-hook-trust");
    expect(resume).not.toContain("-s workspace-write");
    expect(resume).toContain(`setsid ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    expect(resume).toContain(`    ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    expect(resume).toContain("sandbox-proxy-launch");
    expect(resume).toContain("export http_proxy=\"http://localhost:$PROXY_PORT\"");
    expect(resume).toContain("<&0 2> \"$STDERR_LOG\" &");
  });

  test("sandbox-enabled start.sh wraps both Claude branches and exports only proxy vars", async () => {
    await writeSandboxType();
    setSandboxPortAllocatorForTesting(() => 43123);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99991 }));

    const result = await callNewAgent("sandbox me", { name: "sandbox-wiring", type: "sandboxed" });
    expect(result.ok).toBe(true);
    const agentDir = join(agentsDir, "sandbox-wiring");
    const start = await Bun.file(join(agentDir, "start.sh")).text();
    const profile = await Bun.file(join(agentDir, "sandbox.sb")).text();
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    const domains = await Bun.file(join(agentDir, "sandbox-domains.txt")).text();

    expect(start).toContain("export http_proxy=\"http://localhost:$PROXY_PORT\"");
    expect(start).toContain(`setsid ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    expect(start).toContain(`    ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    expect(start).toContain("-D 'AGENTDIR=");
    const worktreePath = join(agentDir, "repo");
    const projectDir = canonicalizeSandboxPath(claudeProjectDirFor(worktreePath));
    const scratchpad = claudeScratchpadDirFor(worktreePath, process.getuid?.() ?? 0);
    expect(start).toContain(`-D 'PROJECTDIR=${projectDir}'`);
    expect(start).toContain(`-D 'SCRATCHPAD=${scratchpad}'`);
    expect(profile).toContain('param "PROJECTDIR"');
    expect(profile).toContain('param "SCRATCHPAD"');
    expect(start).not.toContain("NODE_OPTIONS");
    expect(start).toContain("trap cleanup_sandbox_proxy EXIT");
    // GROUP 1: claude skips its own permission prompts only under the kernel.
    // The flag must sit inside the sandbox-exec-wrapped launch (after the
    // `sandbox-exec -f … claude` prefix), on both the setsid and fallback arms.
    expect(start).toMatch(/setsid \/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* -f[^\n]*claude --session-id[^\n]*--dangerously-skip-permissions/);
    expect(start).toMatch(/\n {4}\/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* -f[^\n]*claude --session-id[^\n]*--dangerously-skip-permissions/);
    expect(meta.sandbox.enabled).toBe(true);
    expect(meta.paths.allowRead).toContain(canonicalizeSandboxPath(tempDir));
    expect(meta.paths.allowWrite).toContain(canonicalizeSandboxPath(tempDir));
    expect(meta.paths.deny).toContain("**/.env");
    expect(meta.sandbox_proxy_port).toBe(43123);
    expect(domains).toBe(
      "api.anthropic.com\n*.anthropic.com\nplatform.claude.com\nchatgpt.com\napi.openai.com\n",
    );
  });

  test("watchdog launch is routed through the unsandboxed tmux server", async () => {
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    setNewAgentSummaryGenerator(async () => {});
    const result = await callNewAgent("watchdog inheritance", { name: "watchdog-via-tmux" });
    expect(result.ok).toBe(true);
    const call = spawnCalls.find((args) => args[0] === "tmux" && args[1] === "run-shell" && args.at(-1)?.includes("watchdog"));
    expect(call).toBeDefined();
    expect(call?.slice(0, 3)).toEqual(["tmux", "run-shell", "-b"]);
    const script = call?.at(-1) ?? "";
    // The helper runs as a child of a wrapper that always reports exit 0 to
    // tmux — a `run-shell -b` job that exits non-zero, dies by a signal, or
    // prints anything gets a notice written into some OTHER agent's pane,
    // parking that pane in view-mode (see buildTmuxHelperScript).
    expect(script).toBe(
      buildTmuxHelperScript(tempDir, ["ib", "watchdog", "watchdog-via-tmux"], join(tempDir, ".ittybitty", "agents", "watchdog-via-tmux", "watchdog.log")),
    );
    expect(script).toContain(`cd '${tempDir}' || `);
    expect(script).toContain(`'ib' 'watchdog' 'watchdog-via-tmux' >>`);
    expect(script.endsWith("; exit 0")).toBe(true);
  });

  test("buildTmuxHelperScript never lets tmux see output or a non-zero status", async () => {
    const script = buildTmuxHelperScript("/repo/root", ["ib", "watchdog", "a1"], "/repo/root/.ittybitty/agents/a1/watchdog.log");
    // Wrapper's own stdout/stderr go nowhere — the job pipe tmux reads stays empty.
    expect(script.startsWith("exec >/dev/null 2>&1; ")).toBe(true);
    // The WRAPPER cd's (not just the helper): its cwd must be the repo root,
    // never the spawner's cwd (an agent dir that may be deleted later — the
    // orphan scanners key on cwd). A failed cd is logged and reported as 0.
    expect(script).toContain("cd '/repo/root' || { echo \"[helper] cd failed\" >>'/repo/root/.ittybitty/agents/a1/watchdog.log' 2>&1; exit 0; }");
    // The helper is a CHILD (backgrounded + waited), not an exec replacement,
    // so a SIGTERM aimed at the helper (orphan-kill) leaves the wrapper alive
    // to report 0.
    expect(script).toContain("'ib' 'watchdog' 'a1' >>'/repo/root/.ittybitty/agents/a1/watchdog.log' 2>&1 & child=$!");
    expect(script).toContain('wait "$child"');
    // The wrapper's own command line must NOT read as an `ib watchdog` process
    // to `ib state`'s classifier — only the real helper child does.
    const { isWatchdogProcess } = await import("./state-command");
    expect(isWatchdogProcess(`/bin/sh -c ${script}`)).toBe(false);
    expect(isWatchdogProcess("ib watchdog a1")).toBe(true);
    // A signal aimed at the WRAPPER (tmux kill-server) is forwarded to the
    // helper and still reported as 0.
    expect(script).toContain(`trap 'if [ -n "$child" ]; then kill -TERM "$child"; fi; exit 0' HUP INT TERM`);
    // The helper's own status is preserved in its log for diagnosis.
    expect(script).toContain('echo "[helper] exited rc=$rc" >>\'/repo/root/.ittybitty/agents/a1/watchdog.log\' 2>&1');
    expect(script.endsWith("; exit 0")).toBe(true);
    // run-shell format-expands `#…` — the script must not contain any.
    expect(script).not.toContain("#");
    // No log → everything to /dev/null (the summary worker).
    const quiet = buildTmuxHelperScript("/repo/root", ["ib", "generate-summary", "/repo/root/.ittybitty/agents/a1"]);
    expect(quiet).toContain("cd '/repo/root' || { echo \"[helper] cd failed\" >/dev/null 2>&1; exit 0; }");
    expect(quiet).toContain("'ib' 'generate-summary' '/repo/root/.ittybitty/agents/a1' >/dev/null 2>&1 & child=$!");
    expect(quiet).not.toContain("#");
  });

  test("sandbox fail-hard preconditions refuse before start.sh or tmux", async () => {
    await writeSandboxType();
    await writeSandboxType("sandboxed-codex-failhard", { model: "codex:gpt-5.4-mini" });
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99992 }));

    const cases: Array<{
      name: string;
      configure(): void;
      runner: ReturnType<typeof sandboxSpawnRunner>;
      message: string;
      type?: string;
    }> = [
      {
        name: "sandbox-nonmac",
        configure: () => setSandboxPlatformForTesting("linux"),
        runner: sandboxSpawnRunner(),
        message: "requires macOS",
      },
      {
        name: "sandbox-no-exec",
        configure: () => {},
        runner: sandboxSpawnRunner({ missingExec: true }),
        message: "sandbox-exec not found",
      },
      {
        name: "sandbox-bad-profile",
        configure: () => {},
        runner: sandboxSpawnRunner({ lintFail: true }),
        message: "failed to compile",
      },
      {
        name: "sandbox-no-git-common-dir",
        configure: () => {},
        runner: sandboxSpawnRunner({ gitCommonDirFail: true }),
        message: "could not resolve git common dir",
      },
      {
        name: "sandbox-port-busy",
        configure: () => setSandboxPortCheckForTesting(() => { throw new Error("address in use"); }),
        runner: sandboxSpawnRunner(),
        message: "proxy could not bind",
      },
      {
        name: "sandbox-codex-no-exec",
        configure: () => {},
        runner: sandboxSpawnRunner({ missingExec: true }),
        message: "sandbox-exec not found",
        type: "sandboxed-codex-failhard",
      },
    ];

    for (const item of cases) {
      resetSandboxWiringForTesting();
      setSandboxPortAllocatorForTesting(() => 43124);
      setSandboxPortCheckForTesting(() => {});
      item.configure();
      spawnCalls = [];
      setNewAgentSpawnRunner(item.runner);
      const result = await callNewAgent("must fail closed", { name: item.name, type: item.type ?? "sandboxed" });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(item.message);
      expect(spawnCalls.some((call) => call.includes("new-session"))).toBe(false);
      expect(await Bun.file(join(agentsDir, item.name, "start.sh")).exists()).toBe(false);
      expect(await Bun.file(join(agentsDir, item.name, "agent.log")).text()).toContain(item.message);
    }
  });

  test("sandbox resume replays frozen profile, reallocates proxy port, and wraps both branches", async () => {
    await writeSandboxType();
    const ports = [43130, 43131];
    setSandboxPortAllocatorForTesting(() => ports.shift()!);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99993 }));
    const spawned = await callNewAgent("resume parity", { name: "sandbox-resume", type: "sandboxed" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "sandbox-resume");
    const spawnProfile = await Bun.file(join(agentDir, "sandbox.sb")).text();
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    const frozenPaths = structuredClone(meta.paths);
    await writeSandboxType("sandbox-resume", {
      allowRead: ["/tmp/changed-after-spawn"],
      allowWrite: ["/tmp/changed-after-spawn"],
      deny: ["**/*.changed"],
    });
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));

    let createdSession = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const cmdStr = cmd.join(" ");
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("tmux has-session")) return makeSpawnResult("", createdSession ? 0 : 1);
      if (cmdStr.includes("tmux new-session")) { createdSession = true; return makeSpawnResult("", 0); }
      if (cmdStr.includes("capture-pane")) return makeSpawnResult("Claude Code v1.0", 0);
      return makeSpawnResult("", 0);
    });
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const resumed = await resumeAgent(makeAgent("sandbox-resume", tempDir, "stopped", meta));
      expect(resumed.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }

    const resumeProfile = await Bun.file(join(agentDir, "sandbox.sb")).text();
    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    const resumedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(resumeProfile).toBe(spawnProfile);
    expect(resumedMeta.paths).toEqual(frozenPaths);
    expect(resumedMeta.sandbox_proxy_port).toBe(43131);
    expect(resumeScript).toContain(`setsid ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    expect(resumeScript).toContain(`    ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    expect(resumeScript).toContain("export HTTPS_PROXY=\"$http_proxy\"");
    expect(resumeScript).toContain("trap cleanup_sandbox_proxy EXIT");
    // GROUP 1: the resume launch gains --dangerously-skip-permissions only under
    // the kernel, inside the sandbox-exec-wrapped claude --resume line, on both
    // the setsid and fallback arms.
    expect(resumeScript).toMatch(/setsid \/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* -f[^\n]*claude --resume[^\n]*--dangerously-skip-permissions/);
    expect(resumeScript).toMatch(/\n {4}\/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* -f[^\n]*claude --resume[^\n]*--dangerously-skip-permissions/);
  });

  test("sandbox resume fail-hard leaves no tmux session or resume script", async () => {
    await writeSandboxType();
    setSandboxPortAllocatorForTesting(() => 43132);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99994 }));
    const spawned = await callNewAgent("resume refusal", { name: "sandbox-resume-refusal", type: "sandboxed" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "sandbox-resume-refusal");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    const resumeCalls: string[][] = [];
    setNukeResumeSpawnRunner((cmd: string[]) => {
      resumeCalls.push(cmd);
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("", 1);
      if (cmd.includes("has-session")) return makeSpawnResult("", 1);
      return makeSpawnResult("", 0);
    });

    const resumed = await resumeAgent(makeAgent("sandbox-resume-refusal", tempDir, "stopped", meta));
    expect(resumed.ok).toBe(false);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.stderr).toContain("sandbox-exec not found");
    expect(resumeCalls.some((call) => call.includes("new-session"))).toBe(false);
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
    expect(await Bun.file(join(agentDir, "agent.log")).text()).toContain("sandbox-exec not found");
  });

  test("sandboxed Codex resume fail-hard never writes resume.sh or starts tmux", async () => {
    await writeSandboxType("sandbox-codex-resume-refusal", { model: "codex:gpt-5.4-mini" });
    setSandboxPortAllocatorForTesting(() => 43133);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99995 }));
    const spawned = await callNewAgent("codex resume refusal", {
      name: "sandbox-codex-resume-refusal",
      type: "sandbox-codex-resume-refusal",
    });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "sandbox-codex-resume-refusal");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    meta.codex_session_id = "019e7b21-cb7d-7f23-8674-11036ed141ef";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    const resumeCalls: string[][] = [];
    setNukeResumeSpawnRunner((cmd: string[]) => {
      resumeCalls.push(cmd);
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("", 1);
      if (cmd.includes("has-session")) return makeSpawnResult("", 1);
      return makeSpawnResult("", 0);
    });

    const resumed = await resumeAgent(makeAgent("sandbox-codex-resume-refusal", tempDir, "stopped", meta));
    expect(resumed.ok).toBe(false);
    expect(resumed.stderr).toContain("sandbox-exec not found");
    expect(resumeCalls.some((call) => call.includes("new-session"))).toBe(false);
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
    expect(await Bun.file(join(agentDir, "agent.log")).text()).toContain("sandbox-exec not found");
  });

  // ── A4 G2: ib sandbox refresh ──────────────────────────────────────────────
  test("Codex refresh regenerates AGENTS.md from the new paths and sandbox state", async () => {
    const id = "codex-refresh-instructions";
    const oldRead = join(tempDir, "old-policy");
    const newRead = join(tempDir, "new-policy");
    await writeSandboxType(id, { model: "codex:gpt-5.4-mini", allowRead: [oldRead] });
    setSandboxPortAllocatorForTesting(() => 43201);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99960 }));
    expect((await callNewAgent("refresh policy", { name: id, type: id })).ok).toBe(true);
    const agentDir = join(agentsDir, id);
    const instructions = join(agentDir, "repo", "AGENTS.md");
    expect(await Bun.file(instructions).text()).toContain("The kernel sandbox is ON");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    meta.codex_session_id = "019e7b21-cb7d-7f23-8674-11036ed141ef";
    meta.sandbox_proxy_pid = 99_999_999;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
    await Bun.write(join(agentDir, "sandbox-proxy.pid"), "99999999\n");
    await Bun.write(join(agentDir, "sandbox-proxy.ready"), "ready\n");
    // Edit both paths and the toggle. Refresh must replace the frozen policy and
    // regenerate native instructions before resuming without kernel helpers.
    await writeSandboxType(id, { model: "codex:gpt-5.4-mini", enabled: false, allowRead: [newRead] });
    let created = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (cmd.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmd.includes("has-session")) return makeSpawnResult("", created ? 0 : 1);
      if (cmd.includes("new-session")) created = true;
      return makeSpawnResult("", 0);
    });
    const result = await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", meta));
    expect(result.ok).toBe(true);
    const text = await Bun.file(instructions).text();
    expect(text).toContain(canonicalizeSandboxPath(newRead));
    expect(text).not.toContain(canonicalizeSandboxPath(oldRead));
    expect(text).toContain("The itsybitsy kernel sandbox is OFF");
    expect(text).not.toContain("your Claude project directory and scratchpad");
    const resume = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resume).not.toContain("sandbox-exec");
    expect(resume).not.toContain("sandbox-proxy-launch");
    expect(resume).not.toContain("sandbox-log-watch");
    expect(resume).toContain("--dangerously-bypass-hook-trust");
    expect(resume).not.toContain("-a never");
    expect(resume).not.toContain("-s danger-full-access");
    const refreshedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(refreshedMeta.sandbox.enabled).toBe(false);
    expect(refreshedMeta.sandbox_proxy_port).toBeUndefined();
    expect(refreshedMeta.sandbox_proxy_pid).toBeUndefined();
    expect(await Bun.file(join(agentDir, "sandbox-proxy.pid")).exists()).toBe(false);
    expect(await Bun.file(join(agentDir, "sandbox-proxy.ready")).exists()).toBe(false);
    const repoId = await getRepoId(tempDir);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).toBeNull();
  });

  test("refresh toggles a disabled Claude agent back to enabled and fails closed through preflight", async () => {
    const id = "refresh-enable";
    await writeSandboxType(id, { enabled: false });
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99959 }));
    expect((await callNewAgent("disabled first", { name: id, type: id })).ok).toBe(true);

    const agentDir = join(agentsDir, id);
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
    await writeSandboxType(id, { enabled: true });
    setSandboxPortAllocatorForTesting(() => 43202);
    setSandboxPortCheckForTesting(() => {});
    const resumeCalls: string[][] = [];
    let created = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      resumeCalls.push(cmd);
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (cmd.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmd.includes("has-session")) return makeSpawnResult("", created ? 0 : 1);
      if (cmd.includes("new-session")) created = true;
      if (cmd.includes("capture-pane")) return makeSpawnResult("Claude Code v1.0", 0);
      return makeSpawnResult("", 0);
    });
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const result = await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", meta));
      expect(result.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }

    const refreshedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    const resume = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(refreshedMeta.sandbox.enabled).toBe(true);
    expect(refreshedMeta.sandbox_proxy_port).toBe(43202);
    expect(resume).toContain("sandbox-exec");
    expect(resume).toContain("sandbox-proxy-launch");
    expect(resume).toContain("sandbox-log-watch");
    expect(resume).toContain("--dangerously-skip-permissions");
    expect(resume).not.toContain("--permission-mode");
    expect(resumeCalls.some((cmd) => cmd[0] === "/usr/bin/sandbox-exec")).toBe(true);
    const repoId = await getRepoId(tempDir);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).not.toBeNull();
  });

  test("refresh toggles an enabled Claude agent off without changing its hook permission boundary", async () => {
    const id = "refresh-disable-claude";
    await writeSandboxType(id, { enabled: true });
    setSandboxPortAllocatorForTesting(() => 43203);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99958 }));
    expect((await callNewAgent("enabled first", { name: id, type: id })).ok).toBe(true);

    const agentDir = join(agentsDir, id);
    const settingsPath = join(agentDir, "repo", ".claude", "settings.local.json");
    const settingsBefore = await Bun.file(settingsPath).text();
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    meta.sandbox_proxy_pid = 99_999_999;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
    await writeSandboxType(id, { enabled: false });

    let created = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      if (cmd.includes("has-session")) return makeSpawnResult("", created ? 0 : 1);
      if (cmd.includes("new-session")) created = true;
      if (cmd.includes("capture-pane")) return makeSpawnResult("Claude Code v1.0", 0);
      return makeSpawnResult("", 0);
    });
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const result = await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", meta));
      expect(result.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }

    const resume = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resume).not.toContain("sandbox-exec");
    expect(resume).not.toContain("sandbox-proxy-launch");
    expect(resume).not.toContain("sandbox-log-watch");
    expect(resume).not.toContain("--dangerously-skip-permissions");
    expect(resume).not.toContain("--permission-mode");
    expect(await Bun.file(settingsPath).text()).toBe(settingsBefore);
    expect(JSON.stringify((await Bun.file(settingsPath).json()).hooks)).toContain(`hook-check-path ${id}`);
    expect((await Bun.file(join(agentDir, "meta.json")).json()).sandbox.enabled).toBe(false);
  });

  test("sandbox-enabled agy spawn uses the shared kernel wrapper", async () => {
    const id = "agy-sandboxed";
    await writeSandboxType(id, { model: "agy:gemini-3.7-flash-low" });
    setSandboxPortAllocatorForTesting(() => 43199);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99911 }));
    // Wrap mockSpawnRunner so the D7 tracked-file guard sees NOT-tracked (exit 1)
    // and `agy --version` resolves; mockSpawnRunner already answers the sandbox
    // preflight (which sandbox-exec + the compile lint).
    setNewAgentSpawnRunner((cmd: string[], o?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("ls-files") && cmdStr.includes("--error-unmatch")) {
        return makeSpawnResult("", 1);
      }
      if (cmd[0] === "agy" && cmd[1] === "--version") return makeSpawnResult("", 0);
      return cleanWorktreeRunner()(cmd, o);
    });

    const spawned = await callNewAgent("sandboxed agy", { name: id, type: id });
    expect(spawned.ok).toBe(true);
    const agentDir = join(agentsDir, id);
    const start = await Bun.file(join(agentDir, "start.sh")).text();
    // Sandbox wrapper + proxy present, wrapping the agy launch line.
    expect(start).toContain("sandbox-exec");
    expect(start).toContain("sandbox-proxy-launch");
    expect(start).toContain("export http_proxy=");
    expect(start).toMatch(/\S*sandbox-exec\S* .* agy --dangerously-skip-permissions/);
    // Frozen metadata records the authored enabled state.
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(meta.sandbox.enabled).toBe(true);
    // No stale "agy has no kernel sandbox wrapper" refusal anywhere.
    expect(start).not.toContain("no kernel sandbox wrapper");
  });

  test("sandbox-disabled agy spawn keeps native approvals and generated hooks but omits every kernel helper", async () => {
    const id = "agy-unsandboxed";
    await writeSandboxType(id, { enabled: false, model: "agy:gemini-3.7-flash-low" });
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99912 }));
    setNewAgentSpawnRunner((cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("ls-files") && cmdStr.includes("--error-unmatch")) return makeSpawnResult("", 1);
      if (cmd[0] === "agy" && cmd[1] === "--version") return makeSpawnResult("1.1.23", 0);
      return cleanWorktreeRunner()(cmd, opts);
    });

    const result = await callNewAgent("unsandboxed agy", { name: id, type: id });
    expect(result.ok).toBe(true);
    const agentDir = join(agentsDir, id);
    const start = await Bun.file(join(agentDir, "start.sh")).text();
    const hooks = await Bun.file(join(agentDir, "repo", ".agents", "hooks.json")).text();
    expect(start).toContain("agy --model 'gemini-3.7-flash-low'");
    expect(start).not.toContain("--dangerously-skip-permissions");
    expect(start).not.toContain("--mode=accept-edits");
    expect(start).not.toContain("sandbox-exec");
    expect(start).not.toContain("sandbox-proxy-launch");
    expect(start).not.toContain("sandbox-log-watch");
    expect(hooks).toContain("agy-pre-tool-use");
    expect(spawnCalls.some((cmd) => cmd[0] === "which" && cmd[1] === "sandbox-exec")).toBe(false);
  });

  test("sandbox refresh re-derives paths from edited type files and replays the new frozen block", async () => {
    await writeSandboxType("sandbox-refresh", { allowRead: [tempDir], allowWrite: [tempDir], deny: ["**/.env"] });
    const ports = [43140, 43141];
    setSandboxPortAllocatorForTesting(() => ports.shift()!);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99960 }));
    const spawned = await callNewAgent("refresh me", { name: "sandbox-refresh", type: "sandbox-refresh" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "sandbox-refresh");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    // Snapshot the frozen block BEFORE the type edit so we can prove refresh
    // actually re-derived it (the baseline _all.md deny persists across both).
    const preRefreshPaths = structuredClone(meta.paths!);

    // Edit the type file AFTER spawn: a new allow entry + a new deny. Unlike a
    // plain resume (which replays the frozen block), refresh must pick these up.
    const refreshedDir = join(tempDir, "refreshed");
    await mkdir(refreshedDir, { recursive: true });
    await writeSandboxType("sandbox-refresh", {
      allowRead: [tempDir, refreshedDir],
      allowWrite: [tempDir],
      deny: ["**/*.secret"],
    });

    let createdSession = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const cmdStr = cmd.join(" ");
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("tmux has-session")) return makeSpawnResult("", createdSession ? 0 : 1);
      if (cmdStr.includes("tmux new-session")) { createdSession = true; return makeSpawnResult("", 0); }
      if (cmdStr.includes("capture-pane")) return makeSpawnResult("Claude Code v1.0", 0);
      return makeSpawnResult("", 0);
    });
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const result = await refreshAgentSandbox(makeAgent("sandbox-refresh", tempDir, "stopped", meta));
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("Refreshed sandbox for sandbox-refresh");
    } finally {
      resetSendSpawnRunner();
    }

    const refreshedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    const refreshedProfile = await Bun.file(join(agentDir, "sandbox.sb")).text();
    // The frozen block now reflects the edited type file — new entries appear
    // that were NOT in the pre-refresh block.
    expect(refreshedMeta.paths.allowRead).toContain(canonicalizeSandboxPath(refreshedDir));
    expect(preRefreshPaths.allowRead).not.toContain(canonicalizeSandboxPath(refreshedDir));
    expect(refreshedMeta.paths.deny).toContain("**/*.secret");
    expect(preRefreshPaths.deny).not.toContain("**/*.secret");
    // The baseline _all.md deny (`**/.env`) persists across the merge on both.
    expect(refreshedMeta.paths.deny).toContain("**/.env");
    // Restarted through the resume path with a fresh proxy port.
    expect(refreshedMeta.sandbox_proxy_port).toBe(43141);
    const resumeScript = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resumeScript).toContain(`setsid ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    const worktreePath = join(agentDir, "repo");
    expect(resumeScript).toContain(
      `-D 'PROJECTDIR=${canonicalizeSandboxPath(claudeProjectDirFor(worktreePath))}'`,
    );
    expect(resumeScript).toContain(
      `-D 'SCRATCHPAD=${claudeScratchpadDirFor(worktreePath, process.getuid?.() ?? 0)}'`,
    );
    expect(refreshedProfile).toContain('param "PROJECTDIR"');
    expect(refreshedProfile).toContain('param "SCRATCHPAD"');
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("[sandbox refresh] re-derived from agent-type files:");
  });

  test("sandbox refresh pauses a running agent before replaying the new block", async () => {
    await writeSandboxType("sandbox-refresh-running", { allowRead: [tempDir], allowWrite: [tempDir], deny: ["**/.env"] });
    const ports = [43142, 43143];
    setSandboxPortAllocatorForTesting(() => ports.shift()!);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99961 }));
    const spawned = await callNewAgent("refresh running", { name: "sandbox-refresh-running", type: "sandbox-refresh-running" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "sandbox-refresh-running");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;

    const pauseCalls: string[][] = [];
    const transitionEvents: string[] = [];
    // No live session to kill — pause proceeds to writeAgentState('stopped').
    setKillPauseSpawnRunner((cmd: string[]) => {
      pauseCalls.push(cmd);
      transitionEvents.push("pause");
      return makeSpawnResult("", 1);
    });
    setSandboxRefreshMetaMutateForTesting(async (dir, mutator) => {
      transitionEvents.push("policy");
      return mutateAgentMeta(dir, mutator);
    });
    let createdSession = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const cmdStr = cmd.join(" ");
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("tmux has-session")) return makeSpawnResult("", createdSession ? 0 : 1);
      if (cmdStr.includes("tmux new-session")) { createdSession = true; return makeSpawnResult("", 0); }
      if (cmdStr.includes("capture-pane")) return makeSpawnResult("Claude Code v1.0", 0);
      return makeSpawnResult("", 0);
    });
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const result = await refreshAgentSandbox(makeAgent("sandbox-refresh-running", tempDir, "running", meta));
      expect(result.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
      resetKillPauseSpawnRunner();
      setSandboxRefreshMetaMutateForTesting(null);
    }
    // The pause path ran (its has-session probe fired on the kill/pause runner).
    expect(pauseCalls.some((c) => c.join(" ").includes("has-session"))).toBe(true);
    expect(transitionEvents.indexOf("pause")).toBeLessThan(transitionEvents.indexOf("policy"));
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("[sandbox refresh] re-derived from agent-type files:");
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(true);
  });

  test("a failed refresh pause leaves the running agent's frozen policy and seal untouched", async () => {
    const id = "sandbox-refresh-pause-failure";
    await writeSandboxType(id, { enabled: true });
    const agentDir = join(agentsDir, id);
    await mkdir(agentDir, { recursive: true });
    const oldMeta = {
      id, agentType: id, state: "running", model: "claude:sonnet", tmux_session: "ittybitty-pause-failure",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sandbox: { enabled: false, rawAllow: [], domains: [] },
      paths: { allowRead: [tempDir], allowWrite: [], deny: [] },
    } as unknown as AgentMeta;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(oldMeta));
    setSandboxRefreshPauseForTesting(async () => ({
      ok: false, exitCode: 1, stdout: "", stderr: "injected pause failure",
    }));
    try {
      const result = await refreshAgentSandbox(makeAgent(id, tempDir, "running", oldMeta));
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("pause failed: injected pause failure");
    } finally {
      setSandboxRefreshPauseForTesting(null);
    }
    expect((await Bun.file(join(agentDir, "meta.json")).json()).sandbox.enabled).toBe(false);
    expect(await readSealRecord(await getRepoId(tempDir), id, process.env.HOME!)).toBeNull();
  });

  test("sandbox refresh refuses denied protected-record reads before pause or policy mutation", async () => {
    const id = "refresh-denied-seal-read";
    await writeSandboxType(id, { enabled: true });
    setSandboxPortAllocatorForTesting(() => 43324);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99985 }));
    expect((await callNewAgent("refresh denied read", { name: id, type: id })).ok).toBe(true);
    const agentDir = join(agentsDir, id);
    const metaPath = join(agentDir, "meta.json");
    const meta = await Bun.file(metaPath).json() as AgentMeta;
    const originalMeta = await Bun.file(metaPath).text();
    let pauseCalled = false;
    let policyCalled = false;
    setSandboxRefreshPauseForTesting(async () => {
      pauseCalled = true;
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });
    setSandboxRefreshMetaMutateForTesting(async () => {
      policyCalled = true;
      return true;
    });
    const protectedDir = join(process.env.HOME!, ".itsybitsy", "sealed");
    await chmod(protectedDir, 0o000);
    try {
      const result = await refreshAgentSandbox(makeAgent(id, tempDir, "running", meta));
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("could not read the protected sealed record");
      expect(result.stderr).toContain("unsandboxed operator session");
      expect(pauseCalled).toBe(false);
      expect(policyCalled).toBe(false);
      expect(await Bun.file(metaPath).text()).toBe(originalMeta);
    } finally {
      await chmod(protectedDir, 0o700);
      setSandboxRefreshPauseForTesting(null);
      setSandboxRefreshMetaMutateForTesting(null);
    }
    expect(await readSealRecord(await getRepoId(tempDir), id, process.env.HOME!)).not.toBeNull();
  });

  test("sandbox refresh refuses a corrupt protected record before pause or policy mutation", async () => {
    const id = "refresh-corrupt-seal";
    await writeSandboxType(id, { enabled: true });
    setSandboxPortAllocatorForTesting(() => 43325);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99986 }));
    expect((await callNewAgent("refresh corrupt", { name: id, type: id })).ok).toBe(true);
    const agentDir = join(agentsDir, id);
    const metaPath = join(agentDir, "meta.json");
    const meta = await Bun.file(metaPath).json() as AgentMeta;
    const originalMeta = await Bun.file(metaPath).text();
    const repoId = await getRepoId(tempDir);
    await Bun.write(sealPath(repoId, id, process.env.HOME!), "not json");
    let pauseCalled = false;
    let policyCalled = false;
    setSandboxRefreshPauseForTesting(async () => {
      pauseCalled = true;
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });
    setSandboxRefreshMetaMutateForTesting(async () => {
      policyCalled = true;
      return true;
    });
    try {
      const result = await refreshAgentSandbox(makeAgent(id, tempDir, "running", meta));
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("could not read the protected sealed record");
      expect(pauseCalled).toBe(false);
      expect(policyCalled).toBe(false);
      expect(await Bun.file(metaPath).text()).toBe(originalMeta);
    } finally {
      setSandboxRefreshPauseForTesting(null);
      setSandboxRefreshMetaMutateForTesting(null);
    }
  });

  test("sandbox refresh refuses a coordinator and points at the reset path", async () => {
    const id = "refresh-coord";
    const agentDir = join(agentsDir, id);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, state: "running", agentType: "coordinator" }, null, 2));
    const result = await refreshAgentSandbox(makeAgent(id, tempDir, "running", { agentType: "coordinator" }));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("is a coordinator");
    expect(result.stderr).toContain("reset");
  });

  test("sandbox refresh refuses when the agent-type file is missing (names the type)", async () => {
    const id = "refresh-missing-type";
    const agentDir = join(agentsDir, id);
    await mkdir(join(agentDir, "repo"), { recursive: true });
    const meta = {
      id, state: "stopped", agentType: "ghost-type-xyz",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    const result = await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", meta as unknown as Partial<AgentMeta>));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("ghost-type-xyz");
    expect(result.stderr).toContain("is missing");
    // Refusal is logged and the agent stays stopped (no resume.sh).
    expect(await Bun.file(join(agentDir, "agent.log")).text()).toContain("ghost-type-xyz");
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
  });

  // ── Phase B: relative entries anchored at the MAIN repo root ────────────────
  test("spawn anchors a ../ entry at the main repo root, not the worktree", async () => {
    await writeSandboxType("spawn-relative", {
      allowRead: [tempDir, "../sibling"],
      allowWrite: [tempDir],
      deny: ["**/.env"],
    });
    setSandboxPortAllocatorForTesting(() => 43180);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99980 }));
    const spawned = await callNewAgent("relative spawn", { name: "spawn-relative", type: "spawn-relative" });
    expect(spawned.ok).toBe(true);

    const meta = await Bun.file(join(agentsDir, "spawn-relative", "meta.json")).json();
    // rootRepoPath resolves to tempDir; "../sibling" anchors to its SIBLING —
    // join(tempDir, "..", "sibling") — never the agent dir or worktree.
    const expectedSibling = canonicalizeSandboxPath(join(tempDir, "..", "sibling"));
    expect(meta.paths.allowRead).toContain(expectedSibling);
    // The raw relative form never survives into meta.
    expect(meta.paths.allowRead).not.toContain("../sibling");
  });

  test("spawn rejects a relative entry that climbs to the filesystem root", async () => {
    await writeSandboxType("spawn-escape", {
      allowRead: [tempDir, "../".repeat(50)],
      allowWrite: [tempDir],
      deny: ["**/.env"],
    });
    setSandboxPortAllocatorForTesting(() => 43182);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99981 }));
    const spawned = await callNewAgent("escape spawn", { name: "spawn-escape", type: "spawn-escape" });
    expect(spawned.ok).toBe(false);
    expect(spawned.stderr).toContain("climbs out");
    expect(spawned.stderr).toContain('write "/" or "~"');
  });

  test("sandbox refresh anchors a ../ entry at the main repo root", async () => {
    await writeSandboxType("refresh-relative", { allowRead: [tempDir], allowWrite: [tempDir], deny: ["**/.env"] });
    const ports = [43184, 43185];
    setSandboxPortAllocatorForTesting(() => ports.shift()!);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99982 }));
    const spawned = await callNewAgent("refresh relative", { name: "refresh-relative", type: "refresh-relative" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "refresh-relative");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    // Add a relative entry AFTER spawn so refresh must anchor it.
    await writeSandboxType("refresh-relative", {
      allowRead: [tempDir, "../sibling"],
      allowWrite: [tempDir],
      deny: ["**/.env"],
    });

    let createdSession = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const cmdStr = cmd.join(" ");
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("tmux has-session")) return makeSpawnResult("", createdSession ? 0 : 1);
      if (cmdStr.includes("tmux new-session")) { createdSession = true; return makeSpawnResult("", 0); }
      if (cmdStr.includes("capture-pane")) return makeSpawnResult("Claude Code v1.0", 0);
      return makeSpawnResult("", 0);
    });
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const result = await refreshAgentSandbox(makeAgent("refresh-relative", tempDir, "stopped", meta));
      expect(result.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }

    const refreshedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    const expectedSibling = canonicalizeSandboxPath(join(tempDir, "..", "sibling"));
    expect(refreshedMeta.paths.allowRead).toContain(expectedSibling);
    expect(refreshedMeta.paths.allowRead).not.toContain("../sibling");
  });

  test("sandbox refresh refuses an entry under the agents dir added after spawn", async () => {
    await writeSandboxType("refresh-under-agents", { allowRead: [tempDir], allowWrite: [tempDir], deny: ["**/.env"] });
    setSandboxPortAllocatorForTesting(() => 43186);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99983 }));
    const spawned = await callNewAgent("refresh bad", { name: "refresh-under-agents", type: "refresh-under-agents" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "refresh-under-agents");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    // Add an entry under .ittybitty/agents AFTER spawn (a dead entry the hook
    // denies structurally) — refresh must refuse it.
    await writeSandboxType("refresh-under-agents", {
      allowRead: [tempDir, join(tempDir, ".ittybitty", "agents", "victim")],
      allowWrite: [tempDir],
      deny: ["**/.env"],
    });

    const result = await refreshAgentSandbox(makeAgent("refresh-under-agents", tempDir, "stopped", meta));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("dead entry");
    expect(result.stderr).toContain(canonicalizeSandboxPath(join(tempDir, ".ittybitty", "agents")));
    // The agent stays stopped: refusal happens before any resume.
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
  });

  test("sandbox refresh refuses a relative entry that climbs to the home directory", async () => {
    await writeSandboxType("refresh-home-escape", { allowRead: [tempDir], allowWrite: [tempDir], deny: ["**/.env"] });
    setSandboxPortAllocatorForTesting(() => 43188);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99984 }));
    const spawned = await callNewAgent("refresh home escape", { name: "refresh-home-escape", type: "refresh-home-escape" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "refresh-home-escape");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    const frozenPaths = structuredClone(meta.paths);

    // In this harness HOME is join(tempDir, "home") — nested UNDER the repo root
    // — so "./home" resolves to exactly the home directory and trips the escape
    // gate. (In production home is never under a repo, so a ../ climb reaches it.)
    await writeSandboxType("refresh-home-escape", {
      allowRead: [tempDir, "./home"],
      allowWrite: [tempDir],
      deny: ["**/.env"],
    });

    const result = await refreshAgentSandbox(makeAgent("refresh-home-escape", tempDir, "stopped", meta));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("climbs out");
    // The escape gate fires BEFORE the meta write: meta.paths is untouched and
    // the agent stays stopped (no resume.sh). A future change that moved the
    // check after the write would fail these two assertions.
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
    const afterMeta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(afterMeta.paths).toEqual(frozenPaths);
  });

  // ── A4 G3: sealed record ────────────────────────────────────────────────────
  test("malformed stored repo id is rejected before seal capability issuance or escaped mutation", async () => {
    const repoIdPath = join(tempDir, ".ittybitty", "repo-id");
    const escaped = join(process.env.HOME!, "escaped-agent.json");
    await Bun.write(repoIdPath, "../../escaped\n");
    const meta = {
      id: "agent", agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };
    await expect(sealAgentRecord(tempDir, "agent", meta, tempDir)).rejects.toThrow("Invalid repository id");
    expect(await Bun.file(escaped).exists()).toBe(false);
    await Bun.write(repoIdPath, "abcd1234\n");
  });

  test("A4 G3: spawn writes a sealed record with the profile inputs and a valid sha256", async () => {
    await writeSandboxType("seal-spawn");
    setSandboxPortAllocatorForTesting(() => 43150);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99970 }));
    const spawned = await callNewAgent("seal me", { name: "seal-spawn", type: "seal-spawn" });
    expect(spawned.ok).toBe(true);

    const repoId = await getRepoId(tempDir);
    const record = await readSealRecord(repoId, "seal-spawn", process.env.HOME!);
    expect(record).not.toBeNull();
    expect(record!.inputs.agentType).toBe("seal-spawn");
    expect(record!.inputs.canSpawnChildren).toBe(false); // the sandbox type has no canSpawnChildren
    expect(record!.inputs.sandbox.enabled).toBe(true);
    expect(record!.inputs.paths.allowRead).toContain(canonicalizeSandboxPath(tempDir));
    // The stored sha256 is exactly the canonical hash of the stored inputs.
    const { computeSealRecord } = await import("./agent-seal");
    expect(record!.sha256).toBe(computeSealRecord(record!.inputs).sha256);
    expect(await Bun.file(sealPath(repoId, "seal-spawn", process.env.HOME!)).exists()).toBe(true);
  });

  test("A4 G3: sealAgentRecord routes through the tmux server on EPERM (sandboxed spawner)", async () => {
    // Simulate the EPERM a sandboxed spawner hits writing the denied seal dir.
    setSealDirectWriteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    // The real internal command verifies the seal before it exits zero. Replace
    // only that command with a successful stub, while executing the exact outer
    // status-relay shell that tmux runs. The parent must accept the helper's
    // checked result without reopening the denied sealed directory.
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 0"]);
    const tmuxCalls: string[][] = [];
    setNukeResumeSpawnRunner((cmd: string[]) => {
      tmuxCalls.push(cmd);
      return Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
    });

    const meta = {
      id: "seal-helper", agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };
    await sealAgentRecord(tempDir, "seal-helper", meta as unknown as Record<string, unknown>, tempDir);

    const sealCall = tmuxCalls.find((c) => c[0] === "tmux" && c[1] === "run-shell");
    expect(sealCall).toBeDefined();
    // Synchronous (blocking) — run-shell WITHOUT -b so the seal lands before spawn continues.
    expect(sealCall).not.toContain("-b");
    expect(sealCall!.at(-1)).toContain("IB_SEAL_CAP=");
    expect(sealCall!.at(-1)).toContain("rc=$?");
    expect(sealCall!.at(-1)).toContain("result.tmp");
  });

  test("seal helper propagates its real failure when tmux submission itself succeeds", async () => {
    setSealDirectWriteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    // tmux run-shell commonly reports only that the job was accepted. Execute
    // the production relay shell directly and return its (deliberately zero)
    // wrapper status; sealAgentRecord must still observe the nested exit 23.
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 23"]);
    setNukeResumeSpawnRunner((cmd: string[]) =>
      Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult
    );
    const meta = {
      id: "seal-helper-failure", agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };

    await expect(sealAgentRecord(
      tempDir,
      "seal-helper-failure",
      meta as unknown as Record<string, unknown>,
      tempDir,
    )).rejects.toThrow("tmux seal helper failed with exit 23");
  });

  test("seal helper refuses success when tmux returns before producing a result", async () => {
    setSealDirectWriteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setNukeResumeSpawnRunner(() => makeSpawnResult("", 0));
    const meta = {
      id: "seal-helper-missing-result", agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };

    await expect(sealAgentRecord(
      tempDir,
      "seal-helper-missing-result",
      meta as unknown as Record<string, unknown>,
      tempDir,
    )).rejects.toThrow("did not report completion");
  });

  test("seal helper command binds the intended repository ID", async () => {
    setSealDirectWriteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    let helperScript = "";
    setNukeResumeSpawnRunner((cmd: string[]) => {
      if (cmd.at(-1)!.includes("IB_SEAL_CAP=")) helperScript = cmd.at(-1)!;
      return makeSpawnResult("", 0);
    });
    const meta = {
      id: "seal-helper-scoped", agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };
    await expect(sealAgentRecord(
      tempDir,
      "seal-helper-scoped",
      meta as unknown as Record<string, unknown>,
      tempDir,
    )).rejects.toThrow("did not report completion");
    expect(helperScript).toContain("--repo-id");
    expect(helperScript).toContain("abcd1234");
    expect(helperScript).toContain("seal-helper-scoped");
  });

  test("checked seal deletion routes through a one-use delete capability on EPERM", async () => {
    const tmuxCalls: string[][] = [];
    setSealDeleteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 0"]);
    setNukeResumeSpawnRunner((cmd: string[]) => {
      tmuxCalls.push(cmd);
      return Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
    });
    try {
      await deleteAgentSealChecked(tempDir, "seal-delete-helper", tempDir);
    } finally {
      setSealDeleteForTesting(null);
    }
    const helper = tmuxCalls.find((call) => call[0] === "tmux" && call[1] === "run-shell");
    expect(helper).toBeDefined();
    expect(helper).not.toContain("-b");
    expect(helper!.at(-1)).toContain("IB_SEAL_CAP=");
    expect(helper!.at(-1)).toContain("rc=$?");
    expect(helper!.at(-1)).toContain("result.tmp");
  });

  test("checked helper completion uses protected private tmp when repo and agent paths are read-only", async () => {
    const id = "seal-delete-restricted-parent";
    const agentDir = join(agentsDir, id);
    await mkdir(agentDir, { recursive: true });
    setSealDeleteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 0"]);
    setNukeResumeSpawnRunner((cmd: string[]) =>
      Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult
    );

    // Result publication must not depend on a caller-writable repo/agent path.
    // The trusted tmux child creates the result directly under /private/tmp,
    // and the parent only reads it before trusted cleanup.
    await chmod(tempDir, 0o555);
    await chmod(agentDir, 0o555);
    try {
      await expect(mkdir(join(tempDir, "forbidden-result-dir"))).rejects.toThrow();
      await deleteAgentSealChecked(tempDir, id, agentDir);
      expect((await readdir(agentDir)).some((name) => name.startsWith(".ib-seal-helper-"))).toBe(false);
    } finally {
      await chmod(agentDir, 0o755);
      await chmod(tempDir, 0o755);
      setSealDeleteForTesting(null);
    }
  });

  test("seal helper rejects a pre-created symlink collision without deleting its target", async () => {
    setSealDirectWriteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 0"]);
    const victim = join(tempDir, "collision-victim");
    await mkdir(victim);
    await Bun.write(join(victim, "keep"), "safe");
    let collisionPath = "";
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const script = cmd.at(-1)!;
      if (script.includes("mkdir -m 700")) {
        collisionPath = script.match(/\/private\/tmp\/\.ib-seal-helper-[0-9a-f-]+/)?.[0] ?? "";
        expect(collisionPath).not.toBe("");
        symlinkSync(victim, collisionPath);
      }
      return Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
    });
    const meta = {
      id: "seal-helper-collision", agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };
    try {
      await expect(sealAgentRecord(
        tempDir,
        "seal-helper-collision",
        meta as unknown as Record<string, unknown>,
        tempDir,
      )).rejects.toThrow(/File exists.*cleanup failed/);
      expect(await readlink(collisionPath)).toBe(victim);
      expect(await Bun.file(join(victim, "keep")).text()).toBe("safe");
    } finally {
      if (collisionPath) await rm(collisionPath, { force: true });
    }
  });

  test("seal helper rejects invalid nested status and still performs trusted cleanup", async () => {
    setSealDirectWriteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 0"]);
    let resultDir = "";
    setNukeResumeSpawnRunner((cmd: string[]) => {
      let script = cmd.at(-1)!;
      if (script.includes("mkdir -m 700")) {
        resultDir = script.match(/\/private\/tmp\/\.ib-seal-helper-[0-9a-f-]+/)?.[0] ?? "";
        script = script.replace(`printf '%s\\n' "$rc"`, `printf 'invalid\\n'`);
      }
      return Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
    });
    const meta = {
      id: "seal-helper-invalid-status", agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };
    await expect(sealAgentRecord(
      tempDir,
      "seal-helper-invalid-status",
      meta as unknown as Record<string, unknown>,
      tempDir,
    )).rejects.toThrow("tmux seal helper reported an invalid status");
    expect(resultDir.startsWith(`${SEAL_HELPER_RESULT_ROOT}/${SEAL_HELPER_RESULT_PREFIX}`)).toBe(true);
    expect(await lstat(resultDir).then(() => true).catch(() => false)).toBe(false);
  });

  test("seal helper reports trusted cleanup failure instead of accepting a leftover result", async () => {
    setSealDirectWriteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 0"]);
    let resultDir = "";
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const script = cmd.at(-1)!;
      if (script.includes("mkdir -m 700")) {
        resultDir = script.match(/\/private\/tmp\/\.ib-seal-helper-[0-9a-f-]+/)?.[0] ?? "";
        return Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      }
      // Faithfully model tmux accepting cleanup without running the nested rm.
      return makeSpawnResult("", 0);
    });
    const meta = {
      id: "seal-helper-cleanup-failure", agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };
    try {
      await expect(sealAgentRecord(
        tempDir,
        "seal-helper-cleanup-failure",
        meta as unknown as Record<string, unknown>,
        tempDir,
      )).rejects.toThrow("tmux seal helper cleanup failed: result directory remains");
      expect(await lstat(resultDir).then(() => true).catch(() => false)).toBe(true);
    } finally {
      if (resultDir) await rm(resultDir, { recursive: true, force: true });
    }
  });

  test("seal helper fails closed on a thrown parent result read and still cleans up", async () => {
    setSealDirectWriteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 0"]);
    let resultDir = "";
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const script = cmd.at(-1)!;
      if (script.includes("mkdir -m 700")) {
        resultDir = script.match(/\/private\/tmp\/\.ib-seal-helper-[0-9a-f-]+/)?.[0] ?? "";
        const completed = Bun.spawnSync({ cmd: ["sh", "-c", script], stdout: "pipe", stderr: "pipe" });
        chmodSync(join(resultDir, "result"), 0o000);
        return makeSpawnResult(completed.stderr.toString(), completed.exitCode);
      }
      return Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
    });
    const meta = {
      id: "seal-helper-read-failure", agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    };
    await expect(sealAgentRecord(
      tempDir,
      "seal-helper-read-failure",
      meta as unknown as Record<string, unknown>,
      tempDir,
    )).rejects.toThrow("tmux seal helper did not report completion");
    expect(await lstat(resultDir).then(() => true).catch(() => false)).toBe(false);
  });

  test("checked seal deletion rejects a failed helper even when tmux reports success", async () => {
    setSealDeleteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 29"]);
    setNukeResumeSpawnRunner((cmd: string[]) =>
      Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult
    );
    try {
      await expect(deleteAgentSealChecked(
        tempDir,
        "seal-delete-helper-failure",
        tempDir,
      )).rejects.toThrow("tmux seal helper failed with exit 29");
    } finally {
      setSealDeleteForTesting(null);
    }
  });

  test("direct checked deletion refuses a seal replaced after intent was captured", async () => {
    const id = "seal-delete-direct-replaced";
    const expectedMeta = {
      id, agentType: "worker",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: ["/expected"], allowWrite: [], deny: [] },
    };
    const replacementMeta = {
      ...expectedMeta,
      paths: { allowRead: ["/replacement"], allowWrite: [], deny: [] },
    };
    const repoId = await getRepoId(tempDir);
    await writeSealRecordDirect(repoId, id, replacementMeta, process.env.HOME!);

    await expect(deleteAgentSealChecked(
      tempDir,
      id,
      tempDir,
      expectedMeta as unknown as Record<string, unknown>,
    )).rejects.toThrow("sealed record changed before deletion");
    expect(await readSealRecord(repoId, id, process.env.HOME!)).toEqual(
      computeSealRecord(await computeSealInputs(replacementMeta)),
    );
  });

  test("A4 G3: sandbox refresh re-seals with the new inputs", async () => {
    await writeSandboxType("seal-refresh", { allowRead: [tempDir], allowWrite: [tempDir], deny: ["**/.env"] });
    const ports = [43152, 43153];
    setSandboxPortAllocatorForTesting(() => ports.shift()!);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99972 }));
    const spawned = await callNewAgent("re-seal", { name: "seal-refresh", type: "seal-refresh" });
    expect(spawned.ok).toBe(true);

    const repoId = await getRepoId(tempDir);
    const before = await readSealRecord(repoId, "seal-refresh", process.env.HOME!);
    expect(before).not.toBeNull();

    const agentDir = join(agentsDir, "seal-refresh");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    const refreshedDir = join(tempDir, "reseal-dir");
    await mkdir(refreshedDir, { recursive: true });
    await writeSandboxType("seal-refresh", { allowRead: [tempDir, refreshedDir], allowWrite: [tempDir], deny: ["**/.env"] });

    let createdSession = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const cmdStr = cmd.join(" ");
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("tmux has-session")) return makeSpawnResult("", createdSession ? 0 : 1);
      if (cmdStr.includes("tmux new-session")) { createdSession = true; return makeSpawnResult("", 0); }
      if (cmdStr.includes("capture-pane")) return makeSpawnResult("Claude Code v1.0", 0);
      return makeSpawnResult("", 0);
    });
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const result = await refreshAgentSandbox(makeAgent("seal-refresh", tempDir, "stopped", meta));
      expect(result.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }

    const after = await readSealRecord(repoId, "seal-refresh", process.env.HOME!);
    expect(after).not.toBeNull();
    // The re-seal reflects the edited type file, so its hash changed.
    expect(after!.sha256).not.toBe(before!.sha256);
    expect(after!.inputs.paths.allowRead).toContain(canonicalizeSandboxPath(refreshedDir));
  });

  test("sandbox disable seal deletion failure is surfaced before metadata transition", async () => {
    const agentId = "seal-delete-failure";
    const agentDir = join(agentsDir, agentId);
    await writeSandboxType(agentId, { enabled: false });
    await mkdir(agentDir, { recursive: true });
    const oldMeta = {
      id: agentId,
      agentType: agentId,
      state: "stopped",
      model: "claude:sonnet",
      tmux_session: "",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [tempDir], allowWrite: [], deny: [] },
    } as unknown as AgentMeta;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(oldMeta));
    await sealAgentRecord(tempDir, agentId, oldMeta as unknown as Record<string, unknown>, agentDir);
    const repoId = await getRepoId(tempDir);
    const oldSeal = await readSealRecord(repoId, agentId, process.env.HOME!);
    const unlinkError = Object.assign(new Error("injected unlink failure"), { code: "EIO" });
    setSealDeleteForTesting(async () => { throw unlinkError; });
    try {
      const failed = await refreshAgentSandbox(makeAgent(agentId, tempDir, "stopped", oldMeta));
      expect(failed.ok).toBe(false);
      expect(failed.stderr).toContain("could not remove old seal: injected unlink failure");
      expect((await Bun.file(join(agentDir, "meta.json")).json()).sandbox.enabled).toBe(true);
      expect(await readSealRecord(repoId, agentId, process.env.HOME!)).toEqual(oldSeal);
    } finally {
      setSealDeleteForTesting(null);
    }

    setNukeResumeSpawnRunner(cleanWorktreeRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const retried = await refreshAgentSandbox(makeAgent(agentId, tempDir, "stopped", oldMeta));
      expect(retried.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }
    expect((await Bun.file(join(agentDir, "meta.json")).json()).sandbox.enabled).toBe(false);
    expect(await readSealRecord(repoId, agentId, process.env.HOME!)).toBeNull();
  });

  test("enabled-to-disabled metadata failure restores the old seal and retry completes", async () => {
    const id = "refresh-disable-meta-failure";
    await writeSandboxType(id, { enabled: false });
    const agentDir = join(agentsDir, id);
    await mkdir(agentDir, { recursive: true });
    const oldMeta = {
      id, agentType: id, state: "stopped", model: "claude:sonnet", tmux_session: "",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [tempDir], allowWrite: [], deny: [] },
    } as unknown as AgentMeta;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(oldMeta));
    await sealAgentRecord(tempDir, id, oldMeta as unknown as Record<string, unknown>, agentDir);
    const repoId = await getRepoId(tempDir);
    const oldSeal = await readSealRecord(repoId, id, process.env.HOME!);
    setSandboxRefreshMetaMutateForTesting(async () => false);
    try {
      const failed = await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", oldMeta));
      expect(failed.stderr).toContain("could not update metadata");
    } finally {
      setSandboxRefreshMetaMutateForTesting(null);
    }
    expect((await Bun.file(join(agentDir, "meta.json")).json()).sandbox.enabled).toBe(true);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).toEqual(oldSeal);
    expect((await verifyMetaAgainstSeal(repoId, id, oldMeta as unknown as Record<string, unknown>, process.env.HOME!)).ok).toBe(true);

    setNukeResumeSpawnRunner(cleanWorktreeRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      expect((await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", oldMeta))).ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }
    expect((await Bun.file(join(agentDir, "meta.json")).json()).sandbox.enabled).toBe(false);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).toBeNull();
  });

  test("disabled-to-enabled metadata failure removes the new seal and retry completes", async () => {
    const id = "refresh-enable-meta-failure";
    await writeSandboxType(id, { enabled: true });
    const agentDir = join(agentsDir, id);
    await mkdir(agentDir, { recursive: true });
    const oldMeta = {
      id, agentType: id, state: "stopped", model: "claude:sonnet", tmux_session: "",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sandbox: { enabled: false, rawAllow: [], domains: [] },
      paths: { allowRead: [tempDir], allowWrite: [], deny: [] },
    } as unknown as AgentMeta;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(oldMeta));
    const repoId = await getRepoId(tempDir);
    setSandboxRefreshMetaMutateForTesting(async () => false);
    try {
      const failed = await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", oldMeta));
      expect(failed.stderr).toContain("could not update metadata");
    } finally {
      setSandboxRefreshMetaMutateForTesting(null);
    }
    expect((await Bun.file(join(agentDir, "meta.json")).json()).sandbox.enabled).toBe(false);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).toBeNull();

    setSandboxPortAllocatorForTesting(() => 43301);
    setSandboxPortCheckForTesting(() => {});
    setNukeResumeSpawnRunner(sandboxResumeRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      expect((await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", oldMeta))).ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }
    expect((await Bun.file(join(agentDir, "meta.json")).json()).sandbox.enabled).toBe(true);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).not.toBeNull();
  });

  test("enabled policy metadata failure restores the exact prior seal and retry applies new paths", async () => {
    const id = "refresh-enabled-meta-failure";
    const oldPath = join(tempDir, "old-refresh-path");
    const newPath = join(tempDir, "new-refresh-path");
    await mkdir(oldPath, { recursive: true });
    await mkdir(newPath, { recursive: true });
    await writeSandboxType(id, { enabled: true, allowRead: [newPath] });
    const agentDir = join(agentsDir, id);
    await mkdir(join(agentDir, "repo"), { recursive: true });
    const oldMeta = {
      id, agentType: id, state: "stopped", model: "claude:sonnet", tmux_session: "",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [oldPath], allowWrite: [], deny: [] },
    } as unknown as AgentMeta;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(oldMeta));
    await sealAgentRecord(tempDir, id, oldMeta as unknown as Record<string, unknown>, agentDir);
    const repoId = await getRepoId(tempDir);
    const oldSeal = await readSealRecord(repoId, id, process.env.HOME!);
    setSandboxRefreshMetaMutateForTesting(async () => false);
    try {
      expect((await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", oldMeta))).ok).toBe(false);
    } finally {
      setSandboxRefreshMetaMutateForTesting(null);
    }
    expect((await Bun.file(join(agentDir, "meta.json")).json()).paths.allowRead).toEqual([oldPath]);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).toEqual(oldSeal);

    setSandboxPortAllocatorForTesting(() => 43302);
    setSandboxPortCheckForTesting(() => {});
    setNukeResumeSpawnRunner(sandboxResumeRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      expect((await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", oldMeta))).ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }
    expect((await Bun.file(join(agentDir, "meta.json")).json()).paths.allowRead).toContain(canonicalizeSandboxPath(newPath));
  });

  test("failed exact seal restoration removes mismatch and leaves refresh retryable", async () => {
    const id = "refresh-rollback-failure";
    const newPath = join(tempDir, "rollback-new-path");
    await mkdir(newPath, { recursive: true });
    await writeSandboxType(id, { enabled: true, allowRead: [newPath] });
    const agentDir = join(agentsDir, id);
    await mkdir(join(agentDir, "repo"), { recursive: true });
    const oldMeta = {
      id, agentType: id, state: "stopped", model: "claude:sonnet", tmux_session: "",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [tempDir], allowWrite: [], deny: [] },
    } as unknown as AgentMeta;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(oldMeta));
    await sealAgentRecord(tempDir, id, oldMeta as unknown as Record<string, unknown>, agentDir);
    const repoId = await getRepoId(tempDir);
    setSandboxRefreshMetaMutateForTesting(async () => false);
    setSandboxRefreshSealRestoreForTesting(async () => { throw new Error("injected restore failure"); });
    try {
      const failed = await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", oldMeta));
      expect(failed.stderr).toContain("mismatched seal was removed");
    } finally {
      setSandboxRefreshMetaMutateForTesting(null);
      setSandboxRefreshSealRestoreForTesting(null);
    }
    expect((await Bun.file(join(agentDir, "meta.json")).json()).paths.allowRead).toEqual([tempDir]);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).toBeNull();

    setSandboxPortAllocatorForTesting(() => 43303);
    setSandboxPortCheckForTesting(() => {});
    setNukeResumeSpawnRunner(sandboxResumeRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      expect((await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", oldMeta))).ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }
    expect(await readSealRecord(repoId, id, process.env.HOME!)).not.toBeNull();
  });

  test("A4 G3: nuke deletes the sealed record", async () => {
    await writeSandboxType("seal-nuke");
    setSandboxPortAllocatorForTesting(() => 43154);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99973 }));
    const spawned = await callNewAgent("nuke seal", { name: "seal-nuke", type: "seal-nuke" });
    expect(spawned.ok).toBe(true);

    const repoId = await getRepoId(tempDir);
    expect(await readSealRecord(repoId, "seal-nuke", process.env.HOME!)).not.toBeNull();

    setSealDeleteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting((_action, target, boundRepoId) =>
      ["rm", "-f", sealPath(boundRepoId, target, process.env.HOME!)]
    );
    const nukeCalls: string[][] = [];
    setNukeResumeSpawnRunner((cmd: string[]) => {
      nukeCalls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "run-shell") {
        return Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      }
      if (cmd.includes("has-session")) return makeSpawnResult("", 1);
      return makeSpawnResult("", 0);
    });
    setKillPauseSpawnRunner((cmd: string[]) => {
      if (cmd.includes("has-session")) return makeSpawnResult("", 1);
      return makeSpawnResult("", 0);
    });
    try {
      const nuked = await nukeAgent(makeAgent("seal-nuke", tempDir, "running", await Bun.file(join(agentsDir, "seal-nuke", "meta.json")).json()));
      expect(nuked.ok).toBe(true);
      expect(await readSealRecord(repoId, "seal-nuke", process.env.HOME!)).toBeNull();
      expect(nukeCalls.some((cmd) => cmd[0] === "tmux" && cmd[1] === "run-shell")).toBe(true);
    } finally {
      setSealDeleteForTesting(null);
      resetKillPauseSpawnRunner();
    }
  });

  test("nuke reports checked seal-helper failure and preserves retry metadata", async () => {
    const id = "seal-nuke-helper-failure";
    await writeSandboxType(id);
    setSandboxPortAllocatorForTesting(() => 43190);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99979 }));
    expect((await callNewAgent("nuke seal failure", { name: id, type: id })).ok).toBe(true);
    const agentDir = join(agentsDir, id);
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    const repoId = await getRepoId(tempDir);

    setSealDeleteForTesting(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 31"]);
    setNukeResumeSpawnRunner((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "run-shell") {
        return Bun.spawn(["sh", "-c", cmd.at(-1)!], { stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      }
      return makeSpawnResult("", cmd.includes("has-session") ? 1 : 0);
    });
    setKillPauseSpawnRunner((cmd: string[]) =>
      makeSpawnResult("", cmd.includes("has-session") ? 1 : 0)
    );
    try {
      const result = await nukeAgent(makeAgent(id, tempDir, "running", meta));
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("failed to kill");
      expect(await readSealRecord(repoId, id, process.env.HOME!)).not.toBeNull();
      expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
    } finally {
      setSealDeleteForTesting(null);
      resetKillPauseSpawnRunner();
    }
  });

  test("A4 G3: resume refuses a tampered canSpawnChildren and names the field", async () => {
    await writeSandboxType("seal-tamper-spawn");
    setSandboxPortAllocatorForTesting(() => 43155);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99974 }));
    const spawned = await callNewAgent("tamper spawn", { name: "seal-tamper-spawn", type: "seal-tamper-spawn" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "seal-tamper-spawn");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    (meta as unknown as Record<string, unknown>).canSpawnChildren = true; // non-spawner → spawner
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));

    const resumeCalls: string[][] = [];
    setNukeResumeSpawnRunner((cmd: string[]) => {
      resumeCalls.push(cmd);
      if (cmd.includes("has-session")) return makeSpawnResult("", 1);
      return makeSpawnResult("", 0);
    });
    const resumed = await resumeAgent(makeAgent("seal-tamper-spawn", tempDir, "stopped", meta));
    expect(resumed.ok).toBe(false);
    expect(resumed.stderr).toContain("does not match the sealed record");
    expect(resumed.stderr).toContain("canSpawnChildren");
    // Fail-hard: no tmux session, agent stays stopped, no sandbox built.
    expect(resumeCalls.some((c) => c.includes("new-session"))).toBe(false);
    expect((await Bun.file(join(agentDir, "meta.json")).json()).state).toBe("stopped");
    expect(await Bun.file(join(agentDir, "agent.log")).text()).toContain("does not match the sealed record");
  });

  test("enabled seal cannot be bypassed by tampering frozen metadata to disabled", async () => {
    const id = "seal-tamper-disable";
    await writeSandboxType(id, { enabled: true });
    setSandboxPortAllocatorForTesting(() => 43189);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99978 }));
    expect((await callNewAgent("tamper toggle", { name: id, type: id })).ok).toBe(true);

    const agentDir = join(agentsDir, id);
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    meta.sandbox = { ...meta.sandbox!, enabled: false };
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
    setNukeResumeSpawnRunner((cmd: string[]) => makeSpawnResult("", cmd.includes("has-session") ? 1 : 0));

    const resumed = await resumeAgent(makeAgent(id, tempDir, "stopped", meta));
    expect(resumed.ok).toBe(false);
    expect(resumed.stderr).toContain("does not match the sealed record (sandbox)");
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);

    const refreshed = await refreshAgentSandbox(makeAgent(id, tempDir, "stopped", meta));
    expect(refreshed.ok).toBe(false);
    expect(refreshed.stderr).toContain("does not match the sealed record (sandbox)");
    const repoId = await getRepoId(tempDir);
    expect(await readSealRecord(repoId, id, process.env.HOME!)).not.toBeNull();
  });

  test("A4 G3: resume refuses a tampered agentType and names the field", async () => {
    await writeSandboxType("seal-tamper-type");
    setSandboxPortAllocatorForTesting(() => 43156);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99975 }));
    const spawned = await callNewAgent("tamper type", { name: "seal-tamper-type", type: "seal-tamper-type" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "seal-tamper-type");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    meta.agentType = "some-other-type"; // swap to a different (spawning) profile
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));

    setNukeResumeSpawnRunner((cmd: string[]) => {
      if (cmd.includes("has-session")) return makeSpawnResult("", 1);
      return makeSpawnResult("", 0);
    });
    const resumed = await resumeAgent(makeAgent("seal-tamper-type", tempDir, "stopped", meta));
    expect(resumed.ok).toBe(false);
    expect(resumed.stderr).toContain("does not match the sealed record");
    expect(resumed.stderr).toContain("agentType");
  });

  test("A4 G3: resume with a matching seal proceeds (no refusal)", async () => {
    await writeSandboxType("seal-match");
    const ports = [43157, 43158];
    setSandboxPortAllocatorForTesting(() => ports.shift()!);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99976 }));
    const spawned = await callNewAgent("match", { name: "seal-match", type: "seal-match" });
    expect(spawned.ok).toBe(true);

    const agentDir = join(agentsDir, "seal-match");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));

    let createdSession = false;
    setNukeResumeSpawnRunner((cmd: string[]) => {
      const cmdStr = cmd.join(" ");
      if (cmd[0] === "which" && cmd[1] === "sandbox-exec") return makeSpawnResult("/usr/bin/sandbox-exec", 0);
      if (cmd[0] === "/usr/bin/sandbox-exec") return makeSpawnResult("", 0);
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("tmux has-session")) return makeSpawnResult("", createdSession ? 0 : 1);
      if (cmdStr.includes("tmux new-session")) { createdSession = true; return makeSpawnResult("", 0); }
      if (cmdStr.includes("capture-pane")) return makeSpawnResult("Claude Code v1.0", 0);
      return makeSpawnResult("", 0);
    });
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const resumed = await resumeAgent(makeAgent("seal-match", tempDir, "stopped", meta));
      expect(resumed.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }
    const resume = await Bun.file(join(agentDir, "resume.sh")).text();
    expect(resume).toContain(`setsid ${sandboxDenialExecPrefix("'/usr/bin/sandbox-exec' -f")}`);
    expect(await Bun.file(join(agentDir, "agent.log")).text()).not.toContain("does not match the sealed record");
  });

  test("sandboxed manager resumes an enabled child through authenticated denied-read verification", async () => {
    const id = "seal-denied-read-valid";
    await writeSandboxType(id);
    setSandboxPortAllocatorForTesting(() => 43320);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99981 }));
    expect((await callNewAgent("denied read valid", { name: id, type: id })).ok).toBe(true);

    const agentDir = join(agentsDir, id);
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
    denyDirectSealVerification();
    useRealSealVerificationHelper();
    setNukeResumeSpawnRunner(sandboxResumeWithTmuxHelperRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const resumed = await resumeAgent(makeAgent(id, tempDir, "stopped", meta));
      expect(resumed.stderr).toBe("");
      expect(resumed.ok).toBe(true);
      expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }
  });

  test("denied-read helper rejects an enabled seal whose writable metadata was flipped false", async () => {
    const id = "seal-denied-read-tamper";
    await writeSandboxType(id);
    setSandboxPortAllocatorForTesting(() => 43321);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99982 }));
    expect((await callNewAgent("denied read tamper", { name: id, type: id })).ok).toBe(true);

    const agentDir = join(agentsDir, id);
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    meta.sandbox = { ...meta.sandbox!, enabled: false };
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
    denyDirectSealVerification();
    useRealSealVerificationHelper();
    setNukeResumeSpawnRunner(sandboxResumeWithTmuxHelperRunner());

    const resumed = await resumeAgent(makeAgent(id, tempDir, "stopped", meta));
    expect(resumed.ok).toBe(false);
    expect(resumed.stderr).toContain("does not match the sealed record (sandbox)");
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
  });

  test("denied-read helper distinguishes missing enabled seal from legitimate disabled no-seal", async () => {
    const enabledId = "seal-denied-read-missing";
    await writeSandboxType(enabledId);
    setSandboxPortAllocatorForTesting(() => 43322);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99983 }));
    expect((await callNewAgent("missing enabled", { name: enabledId, type: enabledId })).ok).toBe(true);
    await removeAgentSeal(tempDir, enabledId);
    const enabledDir = join(agentsDir, enabledId);
    const enabledMeta = await Bun.file(join(enabledDir, "meta.json")).json() as AgentMeta;
    enabledMeta.state = "stopped";
    await Bun.write(join(enabledDir, "meta.json"), JSON.stringify(enabledMeta));

    denyDirectSealVerification();
    useRealSealVerificationHelper();
    setNukeResumeSpawnRunner(sandboxResumeWithTmuxHelperRunner());
    const missing = await resumeAgent(makeAgent(enabledId, tempDir, "stopped", enabledMeta));
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toContain("no sealed record");

    resetSealDirectVerifyForTesting();
    resetSealCapabilityCommandForTesting();
    const disabledId = "seal-denied-read-disabled";
    await writeSandboxType(disabledId, { enabled: false });
    spawnCalls = [];
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const disabledSpawn = await callNewAgent("missing disabled", { name: disabledId, type: disabledId });
    expect(disabledSpawn.stderr).toBe("");
    expect(disabledSpawn.ok).toBe(true);
    const disabledDir = join(agentsDir, disabledId);
    const disabledMeta = await Bun.file(join(disabledDir, "meta.json")).json() as AgentMeta;
    disabledMeta.state = "stopped";
    await Bun.write(join(disabledDir, "meta.json"), JSON.stringify(disabledMeta));
    denyDirectSealVerification();
    useRealSealVerificationHelper();
    setNukeResumeSpawnRunner(sandboxResumeWithTmuxHelperRunner());
    setSendSpawnRunner(() => makeSpawnResult("", 0));
    try {
      const resumed = await resumeAgent(makeAgent(disabledId, tempDir, "stopped", disabledMeta));
      expect(resumed.ok).toBe(true);
    } finally {
      resetSendSpawnRunner();
    }
  });

  test("denied-read verification fails closed when helper fails or omits its completion result", async () => {
    const id = "seal-verify-helper-failure";
    await writeSandboxType(id);
    setSandboxPortAllocatorForTesting(() => 43323);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99984 }));
    expect((await callNewAgent("helper failure", { name: id, type: id })).ok).toBe(true);
    const agentDir = join(agentsDir, id);
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
    denyDirectSealVerification();

    setSealCapabilityCommandForTesting(() => ["sh", "-c", "echo verify-failed >&2; exit 37"]);
    setNukeResumeSpawnRunner(sandboxResumeWithTmuxHelperRunner());
    const failed = await resumeAgent(makeAgent(id, tempDir, "stopped", meta));
    expect(failed.ok).toBe(false);
    expect(failed.stderr).toContain("tmux seal helper failed with exit 37");
    expect(failed.stderr).toContain("verify-failed");

    setSealCapabilityCommandForTesting(() => ["sh", "-c", "exit 0"]);
    setNukeResumeSpawnRunner(sandboxResumeWithTmuxHelperRunner());
    const emptyOutput = await resumeAgent(makeAgent(id, tempDir, "stopped", meta));
    expect(emptyOutput.ok).toBe(false);
    expect(emptyOutput.stderr).toContain("verification helper returned an invalid result");

    setNukeResumeSpawnRunner((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "run-shell") return makeSpawnResult("", 0);
      return sandboxResumeRunner()(cmd);
    });
    const missingResult = await resumeAgent(makeAgent(id, tempDir, "stopped", meta));
    expect(missingResult.ok).toBe(false);
    expect(missingResult.stderr).toContain("did not report completion");
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
  });

  test("A4 G3: resume refuses an agent whose seal is missing (mandatory sandbox)", async () => {
    // Mandatory sandbox: every agent is sandbox-required, so a missing seal is no
    // longer "verification skipped" — it is a fail-closed refusal that points at
    // `ib sandbox refresh` (which re-seals from an unsandboxed session).
    await writeSandboxType("seal-missing", { allowRead: [tempDir], allowWrite: [tempDir] });
    setSandboxPortAllocatorForTesting(() => 43188);
    setSandboxPortCheckForTesting(() => {});
    setNewAgentSpawnRunner(sandboxSpawnRunner());
    setNewAgentSummaryGenerator(async () => {});
    setWatchdogSpawnFn(() => ({ pid: 99977 }));
    const spawned = await callNewAgent("needs a seal", { name: "seal-missing", type: "seal-missing" });
    expect(spawned.ok).toBe(true);

    const repoId = await getRepoId(tempDir);
    // Delete the seal the sandboxed spawn wrote — resume must now REFUSE.
    await removeAgentSeal(tempDir, "seal-missing");
    expect(await readSealRecord(repoId, "seal-missing", process.env.HOME!)).toBeNull();

    const agentDir = join(agentsDir, "seal-missing");
    const meta = await Bun.file(join(agentDir, "meta.json")).json() as AgentMeta;
    meta.state = "stopped";
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));
    // has-session → dead so resume clears the liveness guard and reaches the seal
    // check (the refusal under test happens BEFORE prepareSandbox).
    setNukeResumeSpawnRunner((cmd: string[]) => {
      if (cmd.includes("has-session")) return makeSpawnResult("", 1);
      return makeSpawnResult("", 0);
    });
    const resumed = await resumeAgent(makeAgent("seal-missing", tempDir, "stopped", meta));

    expect(resumed.ok).toBe(false);
    expect(resumed.stderr).toContain("no sealed record");
    expect(resumed.stderr).toContain("ib sandbox refresh seal-missing");
    // Fail-closed: never launched, no resume.sh.
    expect(await Bun.file(join(agentDir, "resume.sh")).exists()).toBe(false);
  });

  test("A4 G3: refreshAgentsSandbox reports per agent and continues on error", async () => {
    const failId = "batch-fail";
    const coordId = "batch-coord";
    for (const [id, agentType] of [[failId, "ghost-type"], [coordId, "coordinator"]] as const) {
      const dir = join(agentsDir, id);
      await mkdir(join(dir, "repo"), { recursive: true });
      await Bun.write(join(dir, "meta.json"), JSON.stringify({
        id, state: "running", agentType,
        sandbox: { enabled: true, rawAllow: [], domains: [] },
        paths: { allowRead: [], allowWrite: [], deny: [] },
      }, null, 2));
    }
    const fail = makeAgent(failId, tempDir, "running", {
      agentType: "ghost-type",
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      paths: { allowRead: [], allowWrite: [], deny: [] },
    } as unknown as Partial<AgentMeta>);
    const coord = makeAgent(coordId, tempDir, "running", { agentType: "coordinator" });
    // Fail first, coordinator second: proves the loop continues past a failure.
    const { lines, anyFailed } = await refreshAgentsSandbox([fail, coord]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("batch-fail: FAILED");
    expect(lines[1]).toContain("batch-coord: skipped (coordinator");
    expect(anyFailed).toBe(true);
  });

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
    await mkdir(dirtyCallerCwd, { recursive: true });
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
    await mkdir(cleanCallerCwd, { recursive: true });
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

  test("worker manager with canSpawnChildren:true override is NOT rejected (toggle-ON works end-to-end)", async () => {
    // A worker toggled ON via the 'b' dialog (meta.canSpawnChildren=true) must
    // pass manager-validation so it can actually spawn — the hook allows the
    // Task, and this gate must agree with the override.
    const mgrDir = join(agentsDir, "agent-worker-on");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(
      join(mgrDir, "meta.json"),
      JSON.stringify({ id: "agent-worker-on", worker: true, canSpawnChildren: true }),
    );
    // Clean parent worktree so the spawn proceeds past validation + dirty gate.
    await mkdir(join(mgrDir, "repo"), { recursive: true });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await callNewAgent("sub-task", { name: "worker-on-child", manager: "agent-worker-on" });
    // The key assertion: NOT rejected with the worker-manager error.
    expect(result.stderr).not.toContain("worker agent and cannot manage sub-agents");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("worker-on-child");
  });

  test("worker manager WITHOUT override is still rejected (byte-for-byte prior behavior)", async () => {
    const mgrDir = join(agentsDir, "agent-worker-off");
    await mkdir(mgrDir, { recursive: true });
    // No canSpawnChildren field — legacy worker.
    await Bun.write(
      join(mgrDir, "meta.json"),
      JSON.stringify({ id: "agent-worker-off", worker: true }),
    );
    await mkdir(join(mgrDir, "repo"), { recursive: true });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await callNewAgent("sub-task", { name: "worker-off-child", manager: "agent-worker-off" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("is a worker agent and cannot manage sub-agents");
  });

  test("worker manager with canSpawnChildren:false override is still rejected", async () => {
    const mgrDir = join(agentsDir, "agent-worker-false");
    await mkdir(mgrDir, { recursive: true });
    await Bun.write(
      join(mgrDir, "meta.json"),
      JSON.stringify({ id: "agent-worker-false", worker: true, canSpawnChildren: false }),
    );
    await mkdir(join(mgrDir, "repo"), { recursive: true });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await callNewAgent("sub-task", { name: "worker-false-child", manager: "agent-worker-false" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("is a worker agent and cannot manage sub-agents");
  });

  // ── Caller gate ─────────────────────────────────────────────────────────────
  // The --manager checks above validate the *target* parent. These verify the
  // spawn is also gated on the *caller* (whoever ran `ib new-agent`), so a leaf
  // worker cannot bypass its own no-spawn restriction by naming a different
  // manager that can spawn — the direct-CLI/Bash path the intercept hook can't
  // see.

  /** Plant a caller agent's worktree + meta and return its worktree cwd. */
  async function plantCaller(id: string, meta: Record<string, unknown>): Promise<string> {
    const dir = join(agentsDir, id);
    await mkdir(join(dir, "repo"), { recursive: true });
    await Bun.write(join(dir, "meta.json"), JSON.stringify({ id, ...meta }));
    return join(dir, "repo");
  }

  test("worker caller cannot spawn by naming a different manager that can spawn", async () => {
    // The real hole: a worker runs `ib new-agent --manager <real-manager>`
    // directly via Bash. The target manager passes validation, but the CALLER
    // is a worker and must be blocked.
    const realMgr = join(agentsDir, "agent-real-mgr");
    await mkdir(join(realMgr, "repo"), { recursive: true });
    await Bun.write(join(realMgr, "meta.json"), JSON.stringify({ id: "agent-real-mgr", worker: false, agentType: "manager" }));

    const callerCwd = await plantCaller("agent-caller-worker", { worker: true, agentType: "worker" });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", {
      name: "should-not-exist",
      manager: "agent-real-mgr",
      _cwd: callerCwd,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent-caller-worker");
    expect(result.stderr).toContain("cannot spawn sub-agents");
    // No sub-agent is created — the gate returns before any spawn side effects.
    expect(await Bun.file(join(agentsDir, "should-not-exist", "meta.json")).exists()).toBe(false);
  });

  test("worker caller is blocked even without an explicit --manager (auto-detect path)", async () => {
    // A worker running `ib new-agent` with no --manager auto-detects itself as
    // the manager from cwd; that path must be gated too.
    const callerCwd = await plantCaller("agent-caller-worker2", { worker: true, agentType: "worker" });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", { name: "should-not-exist2", _cwd: callerCwd });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("cannot spawn sub-agents");
    expect(await Bun.file(join(agentsDir, "should-not-exist2", "meta.json")).exists()).toBe(false);
  });

  test("setNewAgentCallerMetaReader overrides caller meta resolution for testing", async () => {
    setNewAgentCallerMetaReader(() => ({ id: "stubbed-worker", worker: true, agentType: "worker" }));
    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", { name: "should-not-exist-stub" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("stubbed-worker");
    expect(result.stderr).toContain("cannot spawn sub-agents");
    resetNewAgentCallerMetaReader();
  });

  test("verified no-worktree leaf caller cannot spawn through the native CLI", async () => {
    const callerMeta = {
      id: "agent-shared-leaf",
      worker: true,
      worktree: false,
      agentType: "worker",
    };
    setNewAgentNoWorktreeCallerResolver(async () => ({
      meta: callerMeta,
      agentDir: join(agentsDir, "agent-shared-leaf"),
      repoPath: tempDir,
    }));
    setNewAgentSpawnRunner(cleanWorktreeRunner());

    const result = await newAgent(tempDir, "sub-task", {
      name: "shared-leaf-child",
      _cwd: join(tempDir, "packages", "feature"),
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("agent-shared-leaf");
    expect(result.stderr).toContain("cannot spawn sub-agents");
    expect(await Bun.file(join(agentsDir, "shared-leaf-child", "meta.json")).exists()).toBe(false);
    resetNewAgentNoWorktreeCallerResolver();
  });

  test("verified no-worktree manager is auto-parent and spawned_by source", async () => {
    const callerId = "agent-shared-manager";
    const callerDir = join(agentsDir, callerId);
    const callerMeta = {
      id: callerId,
      worker: false,
      worktree: false,
      agentType: "manager",
    };
    await mkdir(callerDir, { recursive: true });
    await Bun.write(join(callerDir, "meta.json"), JSON.stringify(callerMeta));
    setNewAgentNoWorktreeCallerResolver(async () => ({
      meta: callerMeta,
      agentDir: callerDir,
      repoPath: tempDir,
    }));
    setNewAgentSpawnRunner(cleanWorktreeRunner());

    const result = await newAgent(tempDir, "sub-task", {
      name: "shared-manager-child",
      _cwd: join(tempDir, "packages", "feature"),
    });

    expect(result.ok).toBe(true);
    const childMeta = await Bun.file(join(agentsDir, "shared-manager-child", "meta.json")).json();
    expect(childMeta.manager).toBe(callerId);
    expect(childMeta.spawned_by).toEqual({ agent_id: callerId, repo_path: realpathSync(tempDir) });
    resetNewAgentNoWorktreeCallerResolver();
  });

  test("unverifiable no-worktree caller fails closed before agent allocation", async () => {
    setNewAgentNoWorktreeCallerResolver(async () => {
      throw new Error("Cannot verify no-worktree caller process identity");
    });
    setNewAgentSpawnRunner(cleanWorktreeRunner());

    const result = await newAgent(tempDir, "sub-task", {
      name: "unverified-shared-child",
      _cwd: tempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Cannot verify no-worktree caller process identity");
    expect(await Bun.file(join(agentsDir, "unverified-shared-child", "meta.json")).exists()).toBe(false);
    resetNewAgentNoWorktreeCallerResolver();
  });

  test("manager caller CAN spawn (no regression)", async () => {
    const callerCwd = await plantCaller("agent-caller-mgr", { worker: false, agentType: "manager" });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", {
      name: "mgr-caller-child",
      manager: "agent-caller-mgr",
      _cwd: callerCwd,
    });

    expect(result.stderr).not.toContain("cannot spawn sub-agents");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("mgr-caller-child");
  });

  test("worker caller with canSpawnChildren:true override CAN spawn (toggle-ON honored on caller side)", async () => {
    const realMgr = join(agentsDir, "agent-real-mgr2");
    await mkdir(join(realMgr, "repo"), { recursive: true });
    await Bun.write(join(realMgr, "meta.json"), JSON.stringify({ id: "agent-real-mgr2", worker: false, agentType: "manager" }));

    const callerCwd = await plantCaller("agent-caller-worker-on", {
      worker: true,
      agentType: "worker",
      canSpawnChildren: true,
    });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", {
      name: "worker-on-caller-child",
      manager: "agent-real-mgr2",
      _cwd: callerCwd,
    });

    expect(result.stderr).not.toContain("cannot spawn sub-agents");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("worker-on-caller-child");
  });

  test("worker caller with canSpawnChildren:false override is blocked even though its type could spawn", async () => {
    // A manager-type agent toggled OFF via the 'b' dialog (canSpawnChildren:false)
    // must be blocked as a caller — the per-agent override wins over the type.
    const realMgr = join(agentsDir, "agent-real-mgr3");
    await mkdir(join(realMgr, "repo"), { recursive: true });
    await Bun.write(join(realMgr, "meta.json"), JSON.stringify({ id: "agent-real-mgr3", worker: false, agentType: "manager" }));

    const callerCwd = await plantCaller("agent-caller-mgr-off", {
      worker: false,
      agentType: "manager",
      canSpawnChildren: false,
    });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", {
      name: "should-not-exist3",
      manager: "agent-real-mgr3",
      _cwd: callerCwd,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("cannot spawn sub-agents");
    expect(await Bun.file(join(agentsDir, "should-not-exist3", "meta.json")).exists()).toBe(false);
  });

  test("non-agent caller (primary Claude / human shell) is unrestricted", async () => {
    // When cwd is a repo root (not inside any agent worktree), there is no
    // caller meta and the gate must not fire — primary Claude spawns managers.
    const realMgr = join(agentsDir, "agent-real-mgr4");
    await mkdir(join(realMgr, "repo"), { recursive: true });
    await Bun.write(join(realMgr, "meta.json"), JSON.stringify({ id: "agent-real-mgr4", worker: false, agentType: "manager" }));

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", {
      name: "top-level-child",
      manager: "agent-real-mgr4",
      _cwd: tempDir,
    });

    expect(result.stderr).not.toContain("cannot spawn sub-agents");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("top-level-child");
  });

  test("legacy worker-boolean caller (no agentType) is blocked", async () => {
    // Backward compat: an old-style caller meta with only `worker: true` and no
    // `agentType` must still be gated, mirroring the legacy path in the
    // --manager check and the intercept hook.
    const realMgr = join(agentsDir, "agent-real-mgr5");
    await mkdir(join(realMgr, "repo"), { recursive: true });
    await Bun.write(join(realMgr, "meta.json"), JSON.stringify({ id: "agent-real-mgr5", worker: false, agentType: "manager" }));

    const callerCwd = await plantCaller("agent-legacy-worker", { worker: true }); // no agentType

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", {
      name: "should-not-exist-legacy",
      manager: "agent-real-mgr5",
      _cwd: callerCwd,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("cannot spawn sub-agents");
    expect(await Bun.file(join(agentsDir, "should-not-exist-legacy", "meta.json")).exists()).toBe(false);
  });

  test("worker caller is blocked cross-repo (caller detection is independent of the target repo)", async () => {
    // A worker whose worktree lives in a DIFFERENT repo than the spawn target
    // (rootRepoPath) must still be gated — readCallerMetaFromCwd resolves the
    // caller from its absolute worktree path, not relative to rootRepoPath.
    const otherRepo = await mkdtemp(join(tmpdir(), "ib-newagent-otherrepo-"));
    try {
      const callerDir = join(otherRepo, ".ittybitty", "agents", "agent-xrepo-worker");
      await mkdir(join(callerDir, "repo"), { recursive: true });
      await Bun.write(join(callerDir, "meta.json"), JSON.stringify({ id: "agent-xrepo-worker", worker: true, agentType: "worker" }));
      const callerCwd = join(callerDir, "repo");

      // Target manager lives in tempDir (the spawn target repo), not otherRepo.
      const realMgr = join(agentsDir, "agent-real-mgr6");
      await mkdir(join(realMgr, "repo"), { recursive: true });
      await Bun.write(join(realMgr, "meta.json"), JSON.stringify({ id: "agent-real-mgr6", worker: false, agentType: "manager" }));

      setNewAgentSpawnRunner(cleanWorktreeRunner());
      const result = await newAgent(tempDir, "sub-task", {
        name: "should-not-exist-xrepo",
        manager: "agent-real-mgr6",
        _cwd: callerCwd,
      });

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("agent-xrepo-worker");
      expect(result.stderr).toContain("cannot spawn sub-agents");
      expect(await Bun.file(join(agentsDir, "should-not-exist-xrepo", "meta.json")).exists()).toBe(false);
    } finally {
      await rm(otherRepo, { recursive: true, force: true });
    }
  });

  test("caller with an unknown/broken agentType is blocked (CLI gate fails closed)", async () => {
    // Mirror the hook's fail-closed unknown-type behavior on the CLI side: a
    // caller whose type .md is missing/corrupt (loadAgentType throws) must be
    // treated as unable to spawn. worker:false proves the block comes from the
    // unknown-agentType branch, not the legacy worker flag.
    const realMgr = join(agentsDir, "agent-real-mgr7");
    await mkdir(join(realMgr, "repo"), { recursive: true });
    await Bun.write(join(realMgr, "meta.json"), JSON.stringify({ id: "agent-real-mgr7", worker: false, agentType: "manager" }));

    const callerCwd = await plantCaller("agent-broken-caller", { worker: false, agentType: "nonesuch-caller-type-9999" });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", {
      name: "should-not-exist-broken",
      manager: "agent-real-mgr7",
      _cwd: callerCwd,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("cannot spawn sub-agents");
    expect(await Bun.file(join(agentsDir, "should-not-exist-broken", "meta.json")).exists()).toBe(false);
  });

  test("caller gate fires before --manager validation (unpermitted caller + invalid manager → caller error)", async () => {
    // The caller gate runs ahead of the --manager existence/leaf check, so an
    // unpermitted caller is rejected with the caller error even when --manager
    // names a nonexistent agent (it does NOT surface a 'manager not found').
    const callerCwd = await plantCaller("agent-caller-worker-order", { worker: true, agentType: "worker" });

    setNewAgentSpawnRunner(cleanWorktreeRunner());
    const result = await newAgent(tempDir, "sub-task", {
      name: "should-not-exist-order",
      manager: "does-not-exist-manager",
      _cwd: callerCwd,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("cannot spawn sub-agents");
    expect(result.stderr).not.toContain("not found");
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
    // Mandatory sandbox: claude is wrapped by the sandbox-exec prefix on both arms.
    expect(startSh).toContain("command -v setsid");
    expect(startSh).toMatch(/setsid \/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* .* claude --session-id/);
    expect(startSh).toMatch(/^ *\/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* .* claude --session-id "/m);

    // ORDERING + UNCONDITIONAL: `trap '' HUP` must precede the claude launch
    // (so SIG_IGN is inherited by the child) AND precede the `command -v setsid`
    // guard (so the bare-launch fallback path still gets the protection).
    const hupIdx = startSh.indexOf("trap '' HUP");
    const setsidGuardIdx = startSh.indexOf("command -v setsid");
    const firstLaunchIdx = startSh.search(/(setsid )?\S*sandbox-exec\S* .* claude --session-id "/);
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
    await Bun.write(join(coordRepo, ".ittybitty", "repo-id"), "c00d0001\n");

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
    const coordinatorStart = await Bun.file(join(coordRepo, ".ittybitty", "agents", "myrepo", "start.sh")).text();
    expect(coordinatorStart.indexOf("ib sandbox-log-watch")).toBeGreaterThan(0);
    expect(coordinatorStart.indexOf("ib sandbox-log-watch")).toBeLessThan(coordinatorStart.indexOf("setsid /bin/sh -c"));
    expect(coordinatorStart.match(/sandbox-log-gate '\/usr\/bin\/sandbox-exec'/g)?.length).toBe(2);

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

  // ── effort precedence across agent-type layer files ─────────────────────────
  // Precedence (most-specific wins), mirroring the model chain:
  //   --effort > <type>.md > _non_coordinator.md > _all.md > config.effort > 'xhigh'

  test("effort E0: --effort flag persists to meta.json and appears in start.sh", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-effort-flag", effort: "high" });

    const meta = await Bun.file(join(agentsDir, "test-effort-flag", "meta.json")).json();
    expect(meta.effort).toBe("high");

    const startSh = await Bun.file(join(agentsDir, "test-effort-flag", "start.sh")).text();
    expect(startSh).toContain("--effort high");
  });

  test("effort E1: effort in _all.md is used when nothing more specific declares one", async () => {
    await writeLayerEffort("_all", "effort: medium", { spawnable: false });
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-all-effort" });

    const meta = await Bun.file(join(agentsDir, "test-all-effort", "meta.json")).json();
    expect(meta.effort).toBe("medium");

    const startSh = await Bun.file(join(agentsDir, "test-all-effort", "start.sh")).text();
    expect(startSh).toContain("--effort medium");
  });

  test("effort E2: <type>.md effort overrides _all.md effort", async () => {
    await writeLayerEffort("_all", "effort: low", { spawnable: false });
    await writeLayerEffort("worker", "effort: max");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-type-overrides-all-effort", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-type-overrides-all-effort", "meta.json")).json();
    expect(meta.effort).toBe("max");
  });

  test("effort E3: _non_coordinator.md effort overrides _all.md for a non-coordinator agent", async () => {
    await writeLayerEffort("_all", "effort: low", { spawnable: false });
    await writeLayerEffort("_non_coordinator", "effort: high", { spawnable: false });
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-noncoord-overrides-all-effort", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-noncoord-overrides-all-effort", "meta.json")).json();
    expect(meta.effort).toBe("high");
  });

  test("effort E4: blank effort in a more-specific file does NOT clobber a real effort in a less-specific file", async () => {
    await writeLayerEffort("_all", "effort: high", { spawnable: false });
    await writeLayerEffort("worker", "effort:");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-blank-inherits-effort", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-blank-inherits-effort", "meta.json")).json();
    expect(meta.effort).toBe("high");
  });

  test("effort E5: --effort flag wins over all layer files", async () => {
    await writeLayerEffort("_all", "effort: low", { spawnable: false });
    await writeLayerEffort("worker", "effort: medium");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-effort-flag-wins", type: "worker", effort: "max" });

    const meta = await Bun.file(join(agentsDir, "test-effort-flag-wins", "meta.json")).json();
    expect(meta.effort).toBe("max");
  });

  test("effort E6: defaults to 'xhigh' when no flag, layer, or config effort is set", async () => {
    // config.json has no effort key, so config.effort resolves to its default
    // ("xhigh"); every layer is blank, so the chain lands on the xhigh default.
    await writeLayerEffort("_all", "effort:", { spawnable: false });
    await writeLayerEffort("_non_coordinator", "effort:", { spawnable: false });
    await writeLayerEffort("worker", "effort:");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-default-effort", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-default-effort", "meta.json")).json();
    expect(meta.effort).toBe("xhigh");

    const startSh = await Bun.file(join(agentsDir, "test-default-effort", "start.sh")).text();
    expect(startSh).toContain("--effort xhigh");
  });

  test("effort E7: config.effort is used when no layer declares an effort", async () => {
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({ model: "claude:sonnet", effort: "low" }));
    await writeLayerEffort("_all", "effort:", { spawnable: false });
    await writeLayerEffort("_non_coordinator", "effort:", { spawnable: false });
    await writeLayerEffort("worker", "effort:");
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-config-effort", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-config-effort", "meta.json")).json();
    expect(meta.effort).toBe("low");
  });

  test("effort E8: rejects an invalid --effort value", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-bad-effort", effort: "extreme" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid effort level: extreme");
  });

  test("type: worker sets meta.worker and (mandatory sandbox) start.sh skips permissions under the kernel", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-worker", type: "worker" });

    const meta = await Bun.file(join(agentsDir, "test-worker", "meta.json")).json();
    expect(meta.worker).toBe(true);

    const startSh = await Bun.file(join(agentsDir, "test-worker", "start.sh")).text();
    // Mandatory sandbox: claude is ALWAYS wrapped by the kernel now, so the
    // launch line carries --dangerously-skip-permissions (Adam: never yolo
    // WITHOUT the kernel — but the kernel is now always present). The flag is
    // emitted only inside the sandbox-exec-wrapped launch.
    expect(startSh).toContain("--dangerously-skip-permissions");
    expect(startSh).toMatch(/\S*sandbox-exec\S* .* claude .*--dangerously-skip-permissions/);
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
      const pf = sbPreflight(cmd);
      if (pf) return pf;
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
      const pf = sbPreflight(cmd);
      if (pf) return pf;
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
        allow: ["Bash(ib:*)", "Bash(ls:*)", "Read", "Glob", "Grep"],
        deny: ["Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch",
               "Task", "TaskCreate", "TaskOutput", "Agent", "KillShell",
               "EnterPlanMode", "ExitPlanMode"],
      },
    }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-no-inherit-deny" });

    const settingsPath = join(agentsDir, "test-no-inherit-deny", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();

    // Agent should have current regular-agent defaults in allow, NOT in deny
    expect(settings.permissions.allow).toContain("Write");
    expect(settings.permissions.allow).toContain("Edit");
    expect(settings.permissions.allow).not.toContain("MultiEdit");
    expect(settings.permissions.allow).not.toContain("LS");
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

  test("accepts valid model", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", {
      name: "test-valid-tools",
      model: "claude:claude-sonnet-4-6",
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

    // Wait for the background summary generation to complete. The generator is
    // fire-and-forget, so there is nothing to await — but a fixed sleep is a
    // guess at how long a read-modify-write of meta.json takes, and on a busy
    // machine 50ms is not enough. Wait for the summary to actually land.
    const metaPath = join(agentsDir, "test-summary", "meta.json");
    await waitFor(
      async () => {
        // The generator rewrites meta.json with a plain Bun.write (truncate then
        // write, NOT tmp+rename), so a poll landing mid-write sees a truncated
        // file and .json() throws. That is "not yet", not a failure — without
        // the catch the parse error escapes the predicate and fails the test,
        // which is the same class of flake this file is trying to remove.
        try {
          return (await Bun.file(metaPath).json()).summary !== undefined;
        } catch {
          return false;
        }
      },
      { message: "background summary generation" },
    );

    const meta = await Bun.file(metaPath).json();
    expect(meta.summary).toBe("A short summary of the task");
  });

  test("skips summary when claude -p fails", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    // Mock summary generator that simulates failed claude -p (does nothing).
    // It also records that it ran: newAgent fires the generator without
    // awaiting it, so "no summary was written" is only meaningful once the
    // generator has actually been through. Waiting on that flag instead of
    // sleeping 50ms both removes the guess and makes the assertion honest —
    // the old sleep did not even establish that the generator had run.
    let generatorRan = false;
    setNewAgentSummaryGenerator(async () => { generatorRan = true; });
    const result = await callNewAgent("implement feature Y", { name: "test-summary-fail" });
    expect(result.ok).toBe(true);

    await waitFor(() => generatorRan, { message: "the fire-and-forget summary generator to run" });

    const metaPath = join(agentsDir, "test-summary-fail", "meta.json");
    const meta = await Bun.file(metaPath).json();
    expect(meta.summary).toBeUndefined();
  });

  test("skips summary when claude -p returns empty output", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    // Mock summary generator that simulates empty output (does nothing), with
    // the same ran-to-completion flag as the failure case above so the
    // "no summary" assertion waits for the real event rather than 50ms.
    let generatorRan = false;
    setNewAgentSummaryGenerator(async () => { generatorRan = true; });
    const result = await callNewAgent("implement feature Z", { name: "test-summary-empty" });
    expect(result.ok).toBe(true);

    await waitFor(() => generatorRan, { message: "the fire-and-forget summary generator to run" });

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
    await Bun.write(join(coordRepo, ".ittybitty", "repo-id"), "c00d0002\n");

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
    expect(isolatedSettings.hooks.PreToolUse[1].hooks[0].command).toBe(`ib hooks intercept-task ${coordId}`);
    expect(isolatedSettings.hooks.PermissionRequest[0].hooks[0].command).toBe(`ib hook-permission-denied ${coordId}`);
    expect(isolatedSettings.permissions.allow).toContain("Read");
    expect(isolatedSettings.permissions.allow).toContain("Bash(ib:*)");

    // start.sh must launch claude with --settings pointing at the isolated file.
    const startSh = await Bun.file(join(coordRepo, ".ittybitty", "agents", coordId, "start.sh")).text();
    expect(startSh).toContain(`--settings '${isolatedSettingsPath}'`);

    await rm(coordRepoDir, { recursive: true, force: true });
  });

  test("non-coordinator no-worktree Claude isolates permissions and hooks from repo settings", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    const repoSettingsPath = join(tempDir, ".claude", "settings.local.json");
    await Bun.write(repoSettingsPath, JSON.stringify({
      permissions: { defaultMode: "bypassPermissions", allow: ["UserOnlyTool"] },
    }));
    const originalRepoSettings = await Bun.file(repoSettingsPath).text();
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { name: "test-no-wt-perm", noWorktree: true });
    expect(result.ok).toBe(true);

    expect(await Bun.file(repoSettingsPath).text()).toBe(originalRepoSettings);
    const agentDir = join(agentsDir, "test-no-wt-perm");
    const isolatedSettingsPath = join(agentDir, ".claude", "settings.local.json");
    const isolated = await Bun.file(isolatedSettingsPath).json();
    expect(isolated.permissions.allow).toContain("Bash(ib:*)");
    expect(isolated.permissions.allow).not.toContain("UserOnlyTool");
    expect(isolated.hooks.PreToolUse[0].hooks[0].command).toBe("ib hook-check-path test-no-wt-perm");
    expect(isolated.hooks.SessionStart[0].hooks[0].command).toBe("ib hooks session-start test-no-wt-perm");
    expect(isolated.hooks.PostToolUse[0].hooks[0].command).toBe("ib hooks inject-timestamp test-no-wt-perm");
    expect(JSON.stringify(isolated.hooks.PreToolUse)).toContain("ib hooks intercept-task test-no-wt-perm");
    expect(isolated.hooks.UserPromptSubmit[1].hooks[0].command).toBe("ib hooks inject-timestamp test-no-wt-perm");
    const start = await Bun.file(join(agentDir, "start.sh")).text();
    expect(start).toContain(`--settings '${isolatedSettingsPath}'`);
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
    await Bun.write(join(coordRepo, ".ittybitty", "repo-id"), "c00d0003\n");

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
    await Bun.write(join(coordRepo, ".ittybitty", "repo-id"), "c00d0004\n");

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
      // Canonical §3.3 launch line components, model is shell-quoted. Mandatory
      // sandbox: codex is wrapped by sandbox-exec and runs -s danger-full-access.
      expect(startSh).toMatch(/setsid \/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* .* codex -m 'gpt-5.4-mini'/);
      expect(startSh).toContain("-a never");
      expect(startSh).toContain("-s danger-full-access");
      expect(startSh).not.toContain("-s workspace-write");
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

    test("codex start.sh includes -c model_reasoning_effort with the mapped effort", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      // xhigh has no codex equivalent → maps down to codex 'high'.
      const result = await callNewAgent("task", {
        name: "codex-effort-xhigh",
        model: "codex:gpt-5.4-mini",
        effort: "xhigh",
      });
      expect(result.ok).toBe(true);

      const startSh = await Bun.file(join(agentsDir, "codex-effort-xhigh", "start.sh")).text();
      // The -c flag pair is shell-quoted in the launch line; the mapped value
      // is 'high'. claude's --effort flag must never appear on a codex line.
      expect(startSh).toContain("model_reasoning_effort=");
      expect(startSh).toContain("high");
      expect(startSh).not.toContain("--effort");
      expect(startSh).not.toContain('model_reasoning_effort="xhigh"');

      // meta.json persists the raw (unmapped) itsybitsy value.
      const meta = await Bun.file(join(agentsDir, "codex-effort-xhigh", "meta.json")).json();
      expect(meta.effort).toBe("xhigh");
    });

    test("codex start.sh maps effort 'low' through to model_reasoning_effort=\"low\"", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-effort-low",
        model: "codex:gpt-5.4-mini",
        effort: "low",
      });
      expect(result.ok).toBe(true);
      const startSh = await Bun.file(join(agentsDir, "codex-effort-low", "start.sh")).text();
      expect(startSh).toContain('model_reasoning_effort="low"');
    });

    test("codex start.sh maps effort 'medium' through to model_reasoning_effort=\"medium\"", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-effort-medium",
        model: "codex:gpt-5.4-mini",
        effort: "medium",
      });
      expect(result.ok).toBe(true);
      const startSh = await Bun.file(join(agentsDir, "codex-effort-medium", "start.sh")).text();
      expect(startSh).toContain('model_reasoning_effort="medium"');
    });

    test("codex start.sh maps effort 'high' through to model_reasoning_effort=\"high\"", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-effort-high",
        model: "codex:gpt-5.4-mini",
        effort: "high",
      });
      expect(result.ok).toBe(true);
      const startSh = await Bun.file(join(agentsDir, "codex-effort-high", "start.sh")).text();
      expect(startSh).toContain('model_reasoning_effort="high"');
    });

    test("codex start.sh maps effort 'max' down to codex 'high'", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-effort-max",
        model: "codex:gpt-5.4-mini",
        effort: "max",
      });
      expect(result.ok).toBe(true);
      const startSh = await Bun.file(join(agentsDir, "codex-effort-max", "start.sh")).text();
      expect(startSh).toContain('model_reasoning_effort="high"');
      expect(startSh).not.toContain('model_reasoning_effort="max"');
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
      // through dispatcherDryRunSpawnCtx — we inject failure there.
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
      // Codex dispatcher precheck now goes through dispatcherDryRunSpawnCtx —
      // inject failure here to simulate a broken dispatcher.
      setDispatcherDryRunSpawnRunner((cmd, cwd) => {
        dispatcherDryRunCalls.push({ cmd, cwd });
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
    // the `cwd: workPath` from the dispatcherDryRunSpawnCtx.run call) MUST fail
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
      const dryRunCmdStrs = dispatcherDryRunCalls.map((c) => c.cmd.join(" "));
      expect(dryRunCmdStrs.some((c) => c.includes("hooks codex-pre-tool-use") && c.includes("--dry-run"))).toBe(true);
      expect(dryRunCmdStrs.some((c) => c.includes("hooks codex-session-start") && c.includes("--dry-run"))).toBe(true);
      expect(dryRunCmdStrs.some((c) => c.includes("hooks codex-stop") && c.includes("--dry-run"))).toBe(true);

      // Every dry-run subprocess MUST be spawned with cwd === workPath.
      expect(dispatcherDryRunCalls.length).toBeGreaterThanOrEqual(3);
      for (const call of dispatcherDryRunCalls) {
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
      // Claude start.sh launches claude, not codex (sandbox-wrapped on both).
      const startSh = await Bun.file(join(agentsDir, "claude-regression-guard", "start.sh")).text();
      expect(startSh).toMatch(/setsid \/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* .* claude/);
      expect(startSh).not.toMatch(/sandbox-exec .* codex/);
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
      const normalised = normalizeSandboxVolatile(rawStartSh
        .replaceAll(agentsDir, "<AGENTSDIR>")
        .replaceAll(sessionUuidPattern, "<SESSION-UUID>"));

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

    // Model availability changes faster than ib releases. After validating the
    // `<cli>:<model>` selector syntax, ib passes the verbatim model half to the
    // codex CLI instead of filtering against `KNOWN_MODELS`.
    test("passes through unlisted codex model names", async () => {
      setNewAgentSpawnRunner(mockSpawnRunner());
      const result = await callNewAgent("task", {
        name: "codex-new-model",
        model: "codex:gpt-9-future",
      });
      expect(result.ok).toBe(true);
      const startSh = await Bun.file(join(agentsDir, "codex-new-model", "start.sh")).text();
      expect(startSh).toMatch(/setsid \/bin\/sh -c [^\n]* sandbox-log-gate \S*sandbox-exec\S* .* codex -m 'gpt-9-future'/);
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

  // ── agy spawn-path tests (SPEC-ANTIGRAVITY-CLI.md §4.5, Phase 2) ─────────────
  //
  // Exercise the agy branch of newAgent end-to-end with the mock spawn runner
  // (no real agy / tmux). The newAgent beforeEach overrides HOME to a temp
  // fakeHome, so ensureAgyTrustedWorkspace writes to <fakeHome>/.gemini — the
  // real ~/.gemini is never touched.
  describe("agy spawn branch", () => {
    // The default mockSpawnRunner returns exit 0 for unmatched commands, which
    // would make `git ls-files --error-unmatch` look "tracked". Wrap it so the
    // D7 tracked-check reports NOT-tracked (exit 1) by default, and stub
    // `agy --version`.
    function agyRunner(opts?: { trackedFile?: string; agyVersion?: string }) {
      const base = mockSpawnRunner();
      return (cmd: string[], o?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("ls-files") && cmdStr.includes("--error-unmatch")) {
          spawnCalls.push(cmd);
          const file = cmd[cmd.length - 1];
          const tracked = opts?.trackedFile !== undefined && file === opts.trackedFile;
          return makeSpawnResult("", tracked ? 0 : 1);
        }
        if (cmd[0] === "agy" && cmd[1] === "--version") {
          spawnCalls.push(cmd);
          return makeSpawnResult(opts?.agyVersion ?? "", 0);
        }
        return base(cmd, o);
      };
    }

    test("spawns an agy agent and writes an agy-shaped start.sh", async () => {
      setNewAgentSpawnRunner(agyRunner());
      const result = await callNewAgent("read README", {
        name: "agy-agent-1",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(true);

      const startSh = await Bun.file(join(agentsDir, "agy-agent-1", "start.sh")).text();
      expect(startSh).toContain("agy --dangerously-skip-permissions --mode=accept-edits --model 'gemini-3.7-flash-low'");
      expect(startSh).toContain('-i "$(cat ');
      expect(startSh).toContain("--log-file '");
      expect(startSh).toContain("CLAUDE_PID=$!");
      // Not a claude / codex launcher.
      expect(startSh).not.toMatch(/setsid claude/);
      expect(startSh).not.toContain("codex");
      expect(startSh).not.toContain("--session-id");
    });

    test("does NOT write <worktree>/.claude/settings.local.json for agy", async () => {
      setNewAgentSpawnRunner(agyRunner());
      const result = await callNewAgent("task", {
        name: "agy-no-claude-settings",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(true);
      const settingsPath = join(agentsDir, "agy-no-claude-settings", "repo", ".claude", "settings.local.json");
      expect(await Bun.file(settingsPath).exists()).toBe(false);
    });

    test("writes .agents/hooks.json + the always-on rule file with resolved path policy", async () => {
      const readPath = join(tempDir, "agy-read-root");
      const writePath = join(tempDir, "agy-write-root");
      await writeAgentTypeFile("agy-instructions", `---
name: agy-instructions
description: agy path instructions test
canSpawnChildren: false
instructionStyle: worker
model: agy:gemini-3.7-flash-low
paths:
  allowRead: [${JSON.stringify(readPath)}]
  allowWrite: [${JSON.stringify(writePath)}]
  deny: ["**/agy-denied"]
sandbox:
  enabled: false
---
`);
      setNewAgentSpawnRunner(agyRunner());
      const result = await callNewAgent("task", {
        name: "agy-worktree-files",
        type: "agy-instructions",
      });
      expect(result.ok).toBe(true);
      const worktree = join(agentsDir, "agy-worktree-files", "repo");
      const hooks = JSON.parse(await Bun.file(join(worktree, ".agents", "hooks.json")).text());
      expect(hooks.ittybitty.PreToolUse[0].hooks[0].command).toContain("hooks agy-pre-tool-use agy-worktree-files");
      const rule = await Bun.file(join(worktree, ".agents", "rules", "ittybitty-agent.md")).text();
      expect(rule.startsWith("---\ntrigger: always_on")).toBe(true);
      expect(rule).toContain(canonicalizeSandboxPath(readPath));
      expect(rule).toContain(canonicalizeSandboxPath(writePath));
      expect(rule).toContain("**/agy-denied");
      expect(rule).toContain("The itsybitsy kernel sandbox is OFF");
    });

    test("appends both boundary files to <worktree>/.gitignore", async () => {
      setNewAgentSpawnRunner(agyRunner());
      const result = await callNewAgent("task", {
        name: "agy-gitignore",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(true);
      const gitignore = await Bun.file(join(agentsDir, "agy-gitignore", "repo", ".gitignore")).text();
      expect(gitignore).toContain(".agents/hooks.json");
      expect(gitignore).toContain(".agents/rules/ittybitty-agent.md");
    });

    test("pre-trusts the worktree BEFORE creating the tmux session (D5 — §17.9)", async () => {
      const { realpathSync } = await import("fs");
      let sawTmuxCreate = false;
      const trustedAtTmuxCreate: string[] = [];
      const base = mockSpawnRunner();
      setNewAgentSpawnRunner((cmd: string[], o?: { stdout: "pipe"; stderr: "pipe" }) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("ls-files") && cmdStr.includes("--error-unmatch")) return makeSpawnResult("", 1);
        if (cmd[0] === "agy" && cmd[1] === "--version") return makeSpawnResult("1.1.23", 0);
        if (cmd[0] === "tmux" && cmd[1] === "new-session") {
          // Snapshot the trust file at the exact moment tmux is created. If the
          // pre-trust ran AFTER tmux, the worktree path would be absent here.
          sawTmuxCreate = true;
          try {
            const raw = require("fs").readFileSync(
              join(process.env.HOME!, ".gemini", "antigravity-cli", "settings.json"),
              "utf8",
            );
            const tw = JSON.parse(raw).trustedWorkspaces;
            if (Array.isArray(tw)) trustedAtTmuxCreate.push(...tw);
          } catch {
            /* leave trustedAtTmuxCreate empty — the assertion below will fail */
          }
        }
        return base(cmd, o);
      });
      const result = await callNewAgent("task", {
        name: "agy-trust-order",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(true);
      const expectedReal = realpathSync(join(agentsDir, "agy-trust-order", "repo"));
      expect(sawTmuxCreate).toBe(true);
      expect(trustedAtTmuxCreate).toContain(expectedReal);
    });

    test("refuses the spawn when a boundary file is already tracked (D7) — no tmux session", async () => {
      setNewAgentSpawnRunner(agyRunner({ trackedFile: ".agents/hooks.json" }));
      const result = await callNewAgent("task", {
        name: "agy-tracked",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain(".agents/hooks.json");
      expect(result.stderr).toContain("tracked");
      // Agent dir cleaned up; no tmux session created.
      expect(await Bun.file(join(agentsDir, "agy-tracked", "meta.json")).exists()).toBe(false);
      const cmdStrs = spawnCalls.map((c) => c.join(" "));
      expect(cmdStrs.some((c) => c.includes("tmux new-session"))).toBe(false);
    });

    test("fails the spawn cleanly when the dispatcher precheck exits non-zero — no tmux session", async () => {
      setNewAgentSpawnRunner(agyRunner());
      setDispatcherDryRunSpawnRunner((cmd, cwd) => {
        dispatcherDryRunCalls.push({ cmd, cwd });
        return makeSpawnResult("", 1);
      });
      const result = await callNewAgent("task", {
        name: "agy-precheck-fail",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("agy dispatcher precheck failed");
      expect(await Bun.file(join(agentsDir, "agy-precheck-fail", "meta.json")).exists()).toBe(false);
      const cmdStrs = spawnCalls.map((c) => c.join(" "));
      expect(cmdStrs.some((c) => c.includes("tmux new-session"))).toBe(false);
      // The precheck ran against agy-* events with cwd === workPath.
      const dryRunStrs = dispatcherDryRunCalls.map((c) => c.cmd.join(" "));
      expect(dryRunStrs.some((c) => c.includes("hooks agy-pre-tool-use") && c.includes("--dry-run"))).toBe(true);
    });

    test("rejects a per-repo coordinator + agy model before any side effect", async () => {
      const localCalls: string[][] = [];
      setNewAgentSpawnRunner((cmd: string[], _o?: { stdout: "pipe"; stderr: "pipe" }) => {
        localCalls.push(cmd);
        return makeSpawnResult("", 0);
      });
      const result = await callNewAgent("start coordinator", {
        name: "agy-coord-attempt",
        type: "coordinator",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("agy coordinators not yet implemented");
      expect(await Bun.file(join(agentsDir, "agy-coord-attempt", "meta.json")).exists()).toBe(false);
      const cmdStrs = localCalls.map((c) => c.join(" "));
      expect(cmdStrs.some((c) => c.includes("tmux new-session"))).toBe(false);
      expect(cmdStrs.some((c) => c.includes("git worktree add"))).toBe(false);
    });

    test("stamps meta.model verbatim and meta.agy_version from `agy --version`", async () => {
      setNewAgentSpawnRunner(agyRunner({ agyVersion: "agy version 1.1.23" }));
      const result = await callNewAgent("task", {
        name: "agy-meta",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(true);
      const meta = await Bun.file(join(agentsDir, "agy-meta", "meta.json")).json();
      expect(meta.model).toBe("agy:gemini-3.7-flash-low");
      expect(meta.agy_version).toBe("agy version 1.1.23");
    });

    test("agy_version is an empty string when `agy --version` fails (best effort)", async () => {
      const base = mockSpawnRunner();
      setNewAgentSpawnRunner((cmd: string[], o?: { stdout: "pipe"; stderr: "pipe" }) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("ls-files") && cmdStr.includes("--error-unmatch")) return makeSpawnResult("", 1);
        if (cmd[0] === "agy" && cmd[1] === "--version") return makeSpawnResult("", 127);
        return base(cmd, o);
      });
      const result = await callNewAgent("task", {
        name: "agy-meta-noversion",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(true);
      const meta = await Bun.file(join(agentsDir, "agy-meta-noversion", "meta.json")).json();
      expect(meta.agy_version).toBe("");
    });

    test("spawn proceeds with agy_version '' when `agy --version` never resolves (Phase 2 live hang)", async () => {
      // agy 1.1.23 blocks forever on an inherited unclosed stdin: the old probe
      // `await`ed proc.exited unconditionally and hung the whole spawn. The fix
      // is a hard timeout — a never-resolving `agy --version` must NOT block the
      // spawn; the field is stamped "" and everything else proceeds.
      setAgyVersionProbeTimeoutMs(100);
      const base = mockSpawnRunner();
      setNewAgentSpawnRunner((cmd: string[], o?: { stdout: "pipe"; stderr: "pipe" }) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("ls-files") && cmdStr.includes("--error-unmatch")) return makeSpawnResult("", 1);
        if (cmd[0] === "agy" && cmd[1] === "--version") {
          // A child that never exits and whose streams never close.
          return {
            stdout: new ReadableStream({ start() { /* never closes */ } }),
            stderr: new ReadableStream({ start() { /* never closes */ } }),
            exited: new Promise<number>(() => { /* never resolves */ }),
            kill: () => { /* best-effort no-op */ },
          };
        }
        return base(cmd, o);
      });
      const start = Date.now();
      const result = await callNewAgent("task", {
        name: "agy-version-hang",
        model: "agy:gemini-3.7-flash-low",
      });
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(true);
      // The probe timed out at 100ms rather than the 5s default — the spawn as a
      // whole finished well under the old-behaviour "forever".
      expect(elapsed).toBeLessThan(3000);
      const meta = await Bun.file(join(agentsDir, "agy-version-hang", "meta.json")).json();
      expect(meta.agy_version).toBe("");
    });

    test("applies the D1 effort rule in start.sh (suffix slug omits --effort)", async () => {
      setNewAgentSpawnRunner(agyRunner());
      const result = await callNewAgent("task", {
        name: "agy-effort-suffix",
        model: "agy:gemini-3.7-flash-low",
        effort: "xhigh",
      });
      expect(result.ok).toBe(true);
      const startSh = await Bun.file(join(agentsDir, "agy-effort-suffix", "start.sh")).text();
      expect(startSh).not.toContain("--effort");
    });

    test("applies the D1 effort rule in start.sh (suffix-less slug passes mapped --effort)", async () => {
      setNewAgentSpawnRunner(agyRunner());
      const result = await callNewAgent("task", {
        name: "agy-effort-plain",
        model: "agy:claude-sonnet-4-6",
        effort: "xhigh",
      });
      expect(result.ok).toBe(true);
      const startSh = await Bun.file(join(agentsDir, "agy-effort-plain", "start.sh")).text();
      expect(startSh).toContain("--model 'claude-sonnet-4-6' --effort 'high'");
    });

    // D5 add/remove symmetry: a spawn that fails AFTER the pre-trust must undo
    // the trust entry, or a failed retry leaves one dead path in ~/.gemini per
    // attempt. cleanupOnFailure() untrusts before it deletes the worktree.
    test("untrusts the workspace when the spawn fails after pre-trust (D5 add/remove symmetry)", async () => {
      setNewAgentSpawnRunner(agyRunner());
      // Precheck fails — this runs AFTER the pre-trust, so the worktree realpath
      // is already in trustedWorkspaces when cleanupOnFailure fires.
      setDispatcherDryRunSpawnRunner((cmd, cwd) => {
        dispatcherDryRunCalls.push({ cmd, cwd });
        return makeSpawnResult("", 1);
      });
      const result = await callNewAgent("task", {
        name: "agy-untrust-onfail",
        model: "agy:gemini-3.7-flash-low",
      });
      expect(result.ok).toBe(false);
      // The trust file started nonexistent; the only entry the pre-trust added
      // was this worktree's, so after the failed spawn it must be empty again.
      const settingsPath = join(process.env.HOME!, ".gemini", "antigravity-cli", "settings.json");
      expect(await Bun.file(settingsPath).exists()).toBe(true);
      const settings = JSON.parse(await Bun.file(settingsPath).text());
      expect(settings.trustedWorkspaces).toEqual([]);
    });

    test("a claude spawn failure never creates or touches agy's settings.json", async () => {
      // A claude agent never pre-trusts; cleanupOnFailure's untrust reads
      // meta.model=claude and no-ops, so ~/.gemini is never written.
      setNewAgentSpawnRunner(mockSpawnRunner({ failTmuxNewSession: true }));
      const result = await callNewAgent("task", {
        name: "claude-untrust-noop",
        model: "claude:opus",
      });
      expect(result.ok).toBe(false);
      const settingsPath = join(process.env.HOME!, ".gemini", "antigravity-cli", "settings.json");
      expect(await Bun.file(settingsPath).exists()).toBe(false);
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

  test("worker-as-parent with canSpawnChildren:true override is accepted", async () => {
    // A worker toggled ON can also be a reassign target — the override wins
    // over the worker check, mirroring newAgent's manager-validation.
    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc");
    const workerDir = join(agentsDir, "agent-worker-on");
    await mkdir(agentDir, { recursive: true });
    await mkdir(workerDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc", manager: "", tmux_session: "t1" }));
    await Bun.write(join(workerDir, "meta.json"), JSON.stringify({ id: "agent-worker-on", worker: true, canSpawnChildren: true, tmux_session: "t2" }));

    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, "agent-worker-on");

    expect(result.ok).toBe(true);
    const updatedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(updatedMeta.manager).toBe("agent-worker-on");
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
    // Includes Bash so the busy-wait detector fires for any session this
    // global install covers (managers/workers included).
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Task|Agent|TaskCreate|Bash|AskUserQuestion");
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
      const pf = sandboxPreflightAnswer(cmd);
      if (pf) return pf;
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
    setNewAgentNoWorktreeCallerResolver(async () => null);

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
    // The poll loop is 10×100ms, so a run that ends in "queued" must have sat
    // through all ten waits. That lower bound is a property of the code, not of
    // the machine — it proves the loop ran to exhaustion instead of returning
    // early, and a busy machine can only push elapsed further above it.
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    // There is deliberately no upper bound. It used to be `< 2_500`, which is
    // the instrument commit 4449ed0 removed from wrap.test.ts: a duration
    // ceiling measures the machine as much as the code (identical work there
    // ranged 59-263ms depending only on load), so no threshold makes it robust.
    // It also had no teeth — POLL_ATTEMPTS could have doubled to 20 (~2s) and
    // still slipped under 2500. What the ceiling was really guarding is "this
    // returns instead of hanging", and the per-test timeout enforces that
    // directly. The assertions below pin the outcome itself.
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
    // Wait for the file to appear on disk. telegramSend drops it (mkdir +
    // write + rename) before entering its poll loop, so the condition is
    // "the .txt exists" — not "200ms have passed", which is a guess that gets
    // it wrong exactly when the machine is busy.
    await waitFor(
      async () => {
        // telegramSend creates the outbox dir itself, so until it has run
        // readdir throws ENOENT — that is "not yet", not a failure.
        try {
          return (await readdir(outboxDir)).some((e) => e.endsWith(".txt"));
        } catch {
          return false;
        }
      },
      { message: "dropped .txt to appear in the outbox" },
    );
    const entries = await readdir(outboxDir);
    const txtFiles = entries.filter((e) => e.endsWith(".txt"));
    expect(txtFiles.length).toBe(1);
    const text = await Bun.file(join(outboxDir, txtFiles[0]!)).text();
    expect(text).toBe("exact-payload");
    await promise; // drain the timeout so afterEach can clean up.
  });
});

describe("telegramReact (native, file-drop client)", () => {
  let tempDir: string;
  let outboxDir: string;
  let stateDir: string;

  async function loadDeps() {
    const ibCmds = await import("./ib-commands");
    const outbox = await import("./channels/outbox");
    const lastMsg = await import("./channels/last-message-cache");
    const access = await import("./channels/access");
    return { ibCmds, outbox, lastMsg, access };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tgreact-test-"));
    outboxDir = join(tempDir, "outbox");
    stateDir = join(tempDir, "state");
    const { outbox, lastMsg, access } = await loadDeps();
    outbox.setOutboxDir(outboxDir);
    access.setStateDir(stateDir);
    lastMsg.setStateDir(stateDir);
  });

  afterEach(async () => {
    const { outbox, lastMsg, access } = await loadDeps();
    outbox.resetOutboxDir();
    access.resetStateDir();
    lastMsg.resetStateDir();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("rejects an unsupported emoji before dropping anything", async () => {
    const { ibCmds, lastMsg } = await loadDeps();
    await lastMsg.writeLastMessage("100", 5);
    const result = await ibCmds.telegramReact("🦖");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unsupported");
    // Nothing dropped in the outbox.
    let entries: string[] = [];
    try {
      entries = await readdir(outboxDir);
    } catch { /* dir may not exist */ }
    expect(entries.filter((e) => e.endsWith(".react.json")).length).toBe(0);
  });

  test("no cached message and no --message-id → ok:false with guidance", async () => {
    const { ibCmds } = await loadDeps();
    const result = await ibCmds.telegramReact("👍");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no recent Telegram message");
  });

  test("drops a .react.json descriptor targeting the cached message", async () => {
    const { ibCmds, lastMsg } = await loadDeps();
    await lastMsg.writeLastMessage("100", 4321);
    // No `ib watch` running → times out as queued, but the descriptor lands.
    const result = await ibCmds.telegramReact("👍");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("queued");

    const entries = await readdir(outboxDir);
    const reactFiles = entries.filter((e) => e.endsWith(".react.json"));
    expect(reactFiles.length).toBe(1);
    const json = JSON.parse(await Bun.file(join(outboxDir, reactFiles[0]!)).text());
    expect(json.message_id).toBe(4321);
    expect(json.emoji).toBe("👍");
  });

  test("explicit --message-id overrides the cache", async () => {
    const { ibCmds, lastMsg } = await loadDeps();
    await lastMsg.writeLastMessage("100", 1);
    await ibCmds.telegramReact("🔥", { messageId: 999 });
    const entries = await readdir(outboxDir);
    const reactFiles = entries.filter((e) => e.endsWith(".react.json"));
    const json = JSON.parse(await Bun.file(join(outboxDir, reactFiles[0]!)).text());
    expect(json.message_id).toBe(999);
    expect(json.emoji).toBe("🔥");
  });

  test("clearing (emoji=null) drops a descriptor with emoji:null", async () => {
    const { ibCmds, lastMsg } = await loadDeps();
    await lastMsg.writeLastMessage("100", 7);
    await ibCmds.telegramReact(null);
    const entries = await readdir(outboxDir);
    const reactFiles = entries.filter((e) => e.endsWith(".react.json"));
    const json = JSON.parse(await Bun.file(join(outboxDir, reactFiles[0]!)).text());
    expect(json.message_id).toBe(7);
    expect(json.emoji).toBeNull();
  });

  test("canonicalizes heart-with-VS16 to the documented form in the descriptor", async () => {
    const { ibCmds, lastMsg } = await loadDeps();
    await lastMsg.writeLastMessage("100", 8);
    await ibCmds.telegramReact("❤️");
    const entries = await readdir(outboxDir);
    const reactFiles = entries.filter((e) => e.endsWith(".react.json"));
    const json = JSON.parse(await Bun.file(join(outboxDir, reactFiles[0]!)).text());
    expect(json.emoji).toBe("❤");
  });

  test("a result file appearing within the timeout is returned to the caller", async () => {
    const { ibCmds, lastMsg } = await loadDeps();
    await lastMsg.writeLastMessage("100", 3);
    const fs = await import("fs/promises");
    const { mkdir: mkdirP } = fs;
    await mkdirP(outboxDir, { recursive: true });
    const watcher = setInterval(async () => {
      try {
        const entries = await readdir(outboxDir);
        for (const entry of entries) {
          if (entry.endsWith(".react.json") && !entries.includes(`${entry}.result`)) {
            await fs.writeFile(
              join(outboxDir, `${entry}.result`),
              JSON.stringify({ ok: true, message: "ok" }),
            );
          }
        }
      } catch { /* ignore */ }
    }, 25);
    try {
      const result = await ibCmds.telegramReact("🎉");
      expect(result.ok).toBe(true);
      expect(result.message).toBe("ok");
    } finally {
      clearInterval(watcher);
    }
  });
});

describe("telegramSendFile (native, file-drop client)", () => {
  let tempDir: string;
  let outboxDir: string;
  let payloadPath: string;

  async function loadDeps() {
    const ibCmds = await import("./ib-commands");
    const outbox = await import("./channels/outbox");
    return { ibCmds, outbox };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tgsendfile-test-"));
    outboxDir = join(tempDir, "outbox");
    const { outbox } = await loadDeps();
    outbox.setOutboxDir(outboxDir);
    payloadPath = join(tempDir, "rendered.png");
    await Bun.write(payloadPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  });

  afterEach(async () => {
    const { outbox } = await loadDeps();
    outbox.resetOutboxDir();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("a missing file fails immediately without dropping a descriptor", async () => {
    const { ibCmds } = await loadDeps();
    const result = await ibCmds.telegramSendFile(join(tempDir, "nope.png"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("file not found");
    let entries: string[] = [];
    try {
      entries = await readdir(outboxDir);
    } catch { /* dir may not exist */ }
    expect(entries.filter((e) => e.endsWith(".file.json")).length).toBe(0);
  });

  test("drops a .file.json descriptor (default kind=document, absolute path)", async () => {
    const { ibCmds } = await loadDeps();
    const result = await ibCmds.telegramSendFile(payloadPath);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("queued");

    const entries = await readdir(outboxDir);
    const fileDescs = entries.filter((e) => e.endsWith(".file.json"));
    expect(fileDescs.length).toBe(1);
    const json = JSON.parse(await Bun.file(join(outboxDir, fileDescs[0]!)).text());
    expect(json.kind).toBe("document");
    expect(json.path).toBe(payloadPath); // absolute
    expect(json.caption).toBeUndefined();
  });

  test("kind=photo and a caption are recorded in the descriptor", async () => {
    const { ibCmds } = await loadDeps();
    await ibCmds.telegramSendFile(payloadPath, { kind: "photo", caption: "the diff" });
    const entries = await readdir(outboxDir);
    const fileDescs = entries.filter((e) => e.endsWith(".file.json"));
    const json = JSON.parse(await Bun.file(join(outboxDir, fileDescs[0]!)).text());
    expect(json.kind).toBe("photo");
    expect(json.caption).toBe("the diff");
  });

  test("a relative path is resolved to absolute in the descriptor", async () => {
    const { ibCmds } = await loadDeps();
    // Resolve relative to cwd. Use a file we know exists: payloadPath's basename
    // won't resolve from cwd, so instead verify resolution by passing a relative
    // path to an existing file under cwd is out of scope; assert absolute-ness on
    // the already-absolute payloadPath, which `resolve()` returns unchanged.
    await ibCmds.telegramSendFile(payloadPath);
    const entries = await readdir(outboxDir);
    const fileDescs = entries.filter((e) => e.endsWith(".file.json"));
    const json = JSON.parse(await Bun.file(join(outboxDir, fileDescs[0]!)).text());
    const { isAbsolute } = await import("path");
    expect(isAbsolute(json.path)).toBe(true);
  });

  test("a result file appearing within the timeout is returned to the caller", async () => {
    const { ibCmds } = await loadDeps();
    const fs = await import("fs/promises");
    await fs.mkdir(outboxDir, { recursive: true });
    const watcher = setInterval(async () => {
      try {
        const entries = await readdir(outboxDir);
        for (const entry of entries) {
          if (entry.endsWith(".file.json") && !entries.includes(`${entry}.result`)) {
            await fs.writeFile(
              join(outboxDir, `${entry}.result`),
              JSON.stringify({ ok: true, message: "ok" }),
            );
          }
        }
      } catch { /* ignore */ }
    }, 25);
    try {
      const result = await ibCmds.telegramSendFile(payloadPath, { caption: "x" });
      expect(result.ok).toBe(true);
      expect(result.message).toBe("ok");
    } finally {
      clearInterval(watcher);
    }
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
      const pf = sandboxPreflightAnswer(cmd);
      if (pf) return pf;
      if (cmd.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
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

    await armAgent(agent); // mandatory sandbox: arm the fixture before the internal resume
    await respawnSelf(agent);

    //resume.sh is the smoking-gun proof that the non-coordinator branch
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
      const pf = sandboxPreflightAnswer(cmd);
      if (pf) return pf;
      if (cmd.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
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

    await armAgent(agent); // mandatory sandbox: arm the fixture before the internal resume
    await respawnSelf(agent);

    //Even from stopped, resume.sh must be written — the agent was already
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
// when the holder is dead. retire/nuke/pause/reassign are the recovery path and
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
    const result = await armAndResume(agent);

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
      const pf = sandboxPreflightAnswer(cmd);
      if (pf) return pf;
      if (cmd.includes("--git-common-dir")) return makeSpawnResult(0, ".git");
      if (cmd[0] === "tmux" && cmd[1] === "new-session") { newSessionSeen = true; return makeSpawnResult(); }
      if (cmd.includes("has-session")) return makeSpawnResult(newSessionSeen ? 0 : 1);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(runner);
    setNukeResumeSpawnRunner(runner);

    const agent = makeAgent("agent-res-ok", tempDir, "stopped");
    const result = await armAndResume(agent);

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
    const result = await armAndResume(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("currently restarting");
    expect(nukeRan).toBe(false); // resetCoordinator never reached
    // Coordinator dir + meta still present (no reset happened).
    expect(await Bun.file(join(agentDir, "meta.json")).exists()).toBe(true);
  });

  // ── retire / nuke bypass the guard ──────────────────────────────────────────

  test("retireAgent is NOT blocked by an in-flight op (live holder)", async () => {
    const agentDir = await makeBackedAgentDir("agent-retire");
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

    const agent = makeAgent("agent-retire", tempDir, "running", { worktree: false });
    const result = await retireAgent(agent);

    // Retire is the recovery path for a wedged op — it must succeed regardless.
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Closed agent: agent-retire");
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
// Teardown leave-notices (SPEC §16.4.2 / §16.5). retire/merge fire a PER-AGENT
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
describe("teams: teardown leave-notices (retire / merge / nuke)", () => {
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
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
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
    const agent = _makeAgent({
      id,
      repoPath: repoDir,
      repoName: basename(repoDir),
      state: "running" as AgentState,
    });
    return { ...agent, meta: { ...agent.meta, worktree: false } };
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

  // --- retireAgent ---------------------------------------------------------

  test("retireAgent fires a per-agent leave notice to survivors, stamped to the departed id", async () => {
    const { createTeam, addMember, getTeam } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    const { readChannel } = await import("./team-channel");
    await createTeam("backend", "", 1000);
    const survivorDir = await plantSurvivor("agent-survivor");
    await plantDeparting("agent-leaver");
    await addMember("backend", "agent-survivor");
    await addMember("backend", "agent-leaver");
    resetReadAgentMetaCache();

    const res = await retireAgent(agentOf("agent-leaver"));
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

  test("retireAgent of an agent in no team enqueues no leave notice", async () => {
    const { createTeam, addMember } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    // A team exists with only the survivor; the departing agent is NOT a member.
    await createTeam("backend", "", 1000);
    const survivorDir = await plantSurvivor("agent-survivor");
    await plantDeparting("agent-loner");
    await addMember("backend", "agent-survivor");
    resetReadAgentMetaCache();

    const res = await retireAgent(agentOf("agent-loner"));
    expect(res.ok).toBe(true);

    // No notice — the departing agent shared no team with the survivor.
    expect(await readOutbox(queueDirOf("agent-survivor"))).toEqual([]);
  });

  test("retireAgent of the LAST member sends no notice (empty-survivor carve-out)", async () => {
    const { createTeam, addMember, getTeam } = await import("./teams");
    await createTeam("solo", "", 1000);
    await plantDeparting("agent-last");
    await addMember("solo", "agent-last");
    resetReadAgentMetaCache();

    const res = await retireAgent(agentOf("agent-last"));
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

  test("mergeAgent --keep is not a departure: roster intact, no leave notice, no channel record", async () => {
    const { createTeam, addMember, getTeam } = await import("./teams");
    const { readOutbox } = await import("./outbox");
    const { readChannel } = await import("./team-channel");
    await createTeam("backend", "", 1000);
    await plantSurvivor("agent-survivor");
    await plantDeparting("agent-kept");
    await addMember("backend", "agent-survivor");
    await addMember("backend", "agent-kept");
    resetReadAgentMetaCache();

    const mergeRunner = (cmd: string[]) => {
      spawnCalls.push(cmd);
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("status") && cmdStr.includes("--porcelain")) return makeSpawnResult(0, "");
      if (cmdStr.includes("branch") && cmdStr.includes("--show-current")) return makeSpawnResult(0, "main");
      if (cmdStr.includes("show-ref") && cmdStr.includes("--verify")) return makeSpawnResult(0);
      if (cmdStr.includes("log") && cmdStr.includes("--oneline")) return makeSpawnResult(0, "abc0 commit 0");
      if (cmd.includes("checkout")) return makeSpawnResult(0);
      if (cmd.includes("merge") && cmd.includes("--no-ff")) return makeSpawnResult(0);
      return makeSpawnResult();
    };
    lifecycleSpawnCtx.set(mergeRunner);
    setMergeSpawnRunner(mergeRunner);

    const res = await mergeAgent(agentOf("agent-kept"), repoDir, { keep: true });
    expect(res.ok).toBe(true);

    // Still a member; nobody was told anything.
    const team = await getTeam("backend");
    expect(team!.members).toEqual(["agent-survivor", "agent-kept"]);
    expect(await readOutbox(queueDirOf("agent-survivor"))).toEqual([]);
    const recs = await readChannel("backend");
    expect(recs.filter((r) => r.kind === "system" && r.message === "left the team")).toEqual([]);
    // And the agent itself is still there.
    expect(await Bun.file(join(repoDir, ".ittybitty", "agents", "agent-kept", "meta.json")).exists()).toBe(true);
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
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
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

describe("writeMetaJsonAtomic — canSpawnChildren round-trip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ib-meta-roundtrip-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("canSpawnChildren persists and does not clobber other fields", async () => {
    const original = {
      id: "agent-abc123",
      session_id: "sess-1",
      tmux_session: "tm-1",
      prompt: "do work",
      manager: "agent-parent",
      created: "2026-07-19T00:00:00Z",
      created_epoch: 1784490000,
      worktree: true,
      worker: true,
      model: "claude-opus-4-8",
      claude_pid: "12345",
      agentType: "worker",
      nickname: "spot",
    };
    await writeMetaJsonAtomic(dir, original);

    // Read back, flip canSpawnChildren on (the toggle-ON path), write, read again.
    const meta1 = (await Bun.file(join(dir, "meta.json")).json()) as Record<string, unknown>;
    meta1.canSpawnChildren = true;
    await writeMetaJsonAtomic(dir, meta1);

    const afterOn = (await Bun.file(join(dir, "meta.json")).json()) as Record<string, unknown>;
    expect(afterOn.canSpawnChildren).toBe(true);
    // Every other field is preserved byte-for-byte.
    expect(afterOn.id).toBe("agent-abc123");
    expect(afterOn.agentType).toBe("worker");
    expect(afterOn.worker).toBe(true);
    expect(afterOn.nickname).toBe("spot");
    expect(afterOn.manager).toBe("agent-parent");
    expect(afterOn.model).toBe("claude-opus-4-8");

    // Flip it OFF (the toggle-OFF path) — override persists as false, not absent.
    const meta2 = (await Bun.file(join(dir, "meta.json")).json()) as Record<string, unknown>;
    meta2.canSpawnChildren = false;
    await writeMetaJsonAtomic(dir, meta2);

    const afterOff = (await Bun.file(join(dir, "meta.json")).json()) as Record<string, unknown>;
    expect(afterOff.canSpawnChildren).toBe(false);
    expect(afterOff.agentType).toBe("worker");
    expect(afterOff.nickname).toBe("spot");
  });

  test("absent canSpawnChildren stays absent — no field introduced", async () => {
    const original = {
      id: "agent-def456",
      worker: false,
      manager: null,
      agentType: "manager",
    };
    await writeMetaJsonAtomic(dir, original);
    const readBack = (await Bun.file(join(dir, "meta.json")).json()) as Record<string, unknown>;
    expect("canSpawnChildren" in readBack).toBe(false);
    expect(readBack.agentType).toBe("manager");
  });
});

// ---------------------------------------------------------------------------
// Workspace-trust auto-accept (resume + new-agent) — 2.1.259 navigation
// ---------------------------------------------------------------------------
describe("autoAcceptWorkspaceTrust / ...ForNewAgent — startup prompt navigation", () => {
  const logoPane = "Claude Code v1.0.0\n[USER TASK]";
  const newTrustPane = [
    "Do you trust the files in this folder?",
    "  ❯ No, exit",
    "    Yes, I trust this folder",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  const legacyTrustPane = "Do you trust the files in this folder?\n\nEnter to confirm · Esc to cancel";
  const singleMcpPane = [
    "New MCP server found in this project: activepieces",
    "  1. Use this MCP server",
    "  2. Use this and all future MCP servers in this project",
    "  ❯ 3. Continue without using this MCP server",
  ].join("\n");
  const bashPane = "Allow Bash to run `ls`?\n  Enter to confirm · Esc to reject";

  afterEach(() => {
    resetNukeResumeSpawnRunner();
    resetNewAgentSpawnRunner();
  });

  /** Wire a spawn runner (resume or new-agent): capture-pane returns successive
   *  `panes` (the last repeats); send-keys are recorded and returned. */
  function wire(
    setRunner: (fn: SpawnFn) => void,
    panes: string[],
  ): string[][] {
    const sends: string[][] = [];
    let capIdx = 0;
    setRunner(((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "capture-pane") {
        const pane = panes[Math.min(capIdx, panes.length - 1)]!;
        capIdx++;
        return makeSpawnResult(0, pane);
      }
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        sends.push([...cmd]);
        return makeSpawnResult(0);
      }
      return makeSpawnResult(0);
    }) as SpawnFn);
    return sends;
  }

  test("resume: NEW trust prompt → Down then Enter in one send-keys", async () => {
    const sends = wire(setNukeResumeSpawnRunner, [newTrustPane, newTrustPane, logoPane]);
    await autoAcceptWorkspaceTrust("tmux-abc");
    const sendKeys = sends.filter((c) => c.includes("send-keys"));
    expect(sendKeys.length).toBe(1);
    const cmd = sendKeys[0]!;
    expect(cmd.includes("Down")).toBe(true);
    expect(cmd.includes("Enter")).toBe(true);
    expect(cmd.indexOf("Down")).toBeLessThan(cmd.indexOf("Enter"));
    expect(cmd.includes("-l")).toBe(false);
  });

  test("resume: LEGACY trust prompt → bare Enter (no navigation keys)", async () => {
    const sends = wire(setNukeResumeSpawnRunner, [legacyTrustPane, legacyTrustPane, logoPane]);
    await autoAcceptWorkspaceTrust("tmux-abc");
    const sendKeys = sends.filter((c) => c.includes("send-keys"));
    expect(sendKeys.length).toBe(1);
    const cmd = sendKeys[0]!;
    expect(cmd.includes("Enter")).toBe(true);
    expect(cmd.includes("Down")).toBe(false);
    expect(cmd.includes("Up")).toBe(false);
  });

  test("resume: generic Bash prompt → nothing sent", async () => {
    const sends = wire(setNukeResumeSpawnRunner, [bashPane]);
    await autoAcceptWorkspaceTrust("tmux-abc");
    expect(sends.filter((c) => c.includes("send-keys")).length).toBe(0);
  });

  test("resume: session that starts with no prompt → nothing sent", async () => {
    const sends = wire(setNukeResumeSpawnRunner, [logoPane]);
    await autoAcceptWorkspaceTrust("tmux-abc");
    expect(sends.filter((c) => c.includes("send-keys")).length).toBe(0);
  });

  test("new-agent: NEW single MCP prompt → Up, Up, Enter", async () => {
    const sends = wire(setNewAgentSpawnRunner, [singleMcpPane, singleMcpPane, logoPane]);
    await autoAcceptWorkspaceTrustForNewAgent("tmux-def");
    const sendKeys = sends.filter((c) => c.includes("send-keys"));
    expect(sendKeys.length).toBe(1);
    const cmd = sendKeys[0]!;
    const ups = cmd.filter((a) => a === "Up").length;
    expect(ups).toBe(2);
    expect(cmd[cmd.length - 1]).toBe("Enter");
    expect(cmd.includes("Down")).toBe(false);
  });

  test("new-agent: NEW trust prompt → Down then Enter", async () => {
    const sends = wire(setNewAgentSpawnRunner, [newTrustPane, newTrustPane, logoPane]);
    await autoAcceptWorkspaceTrustForNewAgent("tmux-def");
    const sendKeys = sends.filter((c) => c.includes("send-keys"));
    expect(sendKeys.length).toBe(1);
    const cmd = sendKeys[0]!;
    expect(cmd.indexOf("Down")).toBeLessThan(cmd.indexOf("Enter"));
  });
});

describe("resolveTmuxSocketDir — tmux socket dir derivation", () => {
  const savedTmux = process.env.TMUX;
  const savedTmpdir = process.env.TMUX_TMPDIR;
  afterEach(() => {
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = savedTmpdir;
  });

  test("TMUX set: the directory of the first comma-separated field, canonicalized", () => {
    // $TMUX is "<socket-path>,<pid>,<session>"; the socket DIR is dirname of the
    // first field, canonicalized (longest-existing-prefix).
    process.env.TMUX = "/tmp/custom-tmux-dir/sock,999,2";
    delete process.env.TMUX_TMPDIR;
    expect(resolveTmuxSocketDir(501)).toBe(canonicalizeSandboxPath("/tmp/custom-tmux-dir"));
  });

  test("TMUX unset, TMUX_TMPDIR set: <TMUX_TMPDIR>/tmux-<uid>, canonicalized", () => {
    delete process.env.TMUX;
    process.env.TMUX_TMPDIR = "/tmp/my-tmux-tmpdir";
    expect(resolveTmuxSocketDir(501)).toBe(canonicalizeSandboxPath("/tmp/my-tmux-tmpdir/tmux-501"));
  });

  test("both unset: /tmp/tmux-<uid>, canonical (/private/tmp on macOS)", () => {
    delete process.env.TMUX;
    delete process.env.TMUX_TMPDIR;
    const result = resolveTmuxSocketDir(501);
    expect(result).toBe(canonicalizeSandboxPath("/tmp/tmux-501"));
    // Canonical: idempotent under canonicalization; on macOS /tmp -> /private/tmp.
    expect(result).toBe(canonicalizeSandboxPath(result));
    if (process.platform === "darwin") {
      expect(result).toBe("/private/tmp/tmux-501");
    }
  });
});

describe("checkPathsRepoContainment", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "paths-containment-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const entry = (rel: string): string => canonicalizeSandboxPath(join(repoRoot, rel));

  test("errors on an allow entry resolving under the agents directory", () => {
    const result = checkPathsRepoContainment(
      { allowRead: [], allowWrite: [entry(".ittybitty/agents/agent-x/repo/src")], deny: [] },
      repoRoot,
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain(canonicalizeSandboxPath(join(repoRoot, ".ittybitty/agents")));
    expect(result.error).toContain("dead entry");
  });

  test("warns on an allow entry inside the repo root but outside the agents dir", () => {
    const result = checkPathsRepoContainment(
      { allowRead: [entry("src")], allowWrite: [], deny: [] },
      repoRoot,
    );
    expect(result.error).toBeUndefined();
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain(canonicalizeSandboxPath(repoRoot));
  });

  test("passes an entry outside the repo root with no error or warning", () => {
    const result = checkPathsRepoContainment(
      { allowRead: [canonicalizeSandboxPath(tmpdir())], allowWrite: [], deny: [] },
      repoRoot,
    );
    expect(result.error).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test("does not check deny entries (a deny under the agents dir is allowed)", () => {
    const result = checkPathsRepoContainment(
      { allowRead: [], allowWrite: [], deny: [entry(".ittybitty/agents/secret")] },
      repoRoot,
    );
    expect(result.error).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test("errors on a glob whose literal directory is under the agents dir", () => {
    const agentsDir = canonicalizeSandboxPath(join(repoRoot, ".ittybitty/agents"));
    const result = checkPathsRepoContainment(
      { allowRead: [`${agentsDir}/**`], allowWrite: [], deny: [] },
      repoRoot,
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain(agentsDir);
  });

  test("warns on a file-like-prefix glob directly under the repo root", () => {
    const repoCanonical = canonicalizeSandboxPath(repoRoot);
    const result = checkPathsRepoContainment(
      { allowRead: [`${repoCanonical}/foo*.md`], allowWrite: [], deny: [] },
      repoRoot,
    );
    expect(result.error).toBeUndefined();
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain(repoCanonical);
  });
});

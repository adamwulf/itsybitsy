import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, readdir } from "fs/promises";
import { tmpdir } from "os";
import type { Agent, AgentMeta } from "./agents";
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

      setSendSpawnRunner((cmd: string[]) => {
        spawnCalls.push(cmd);
        return makeSpawnResult();
      });
    });

    afterEach(async () => {
      resetSendSpawnRunner();
      await rm(tempDir, { recursive: true, force: true });
    });

    test("sends message via tmux send-keys then Enter", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      const result = await sendMessage(agent, "hello world", { cwd: "/" });

      expect(result.ok).toBe(true);
      // Should have: has-session, send-keys (message), send-keys (Enter)
      expect(spawnCalls.length).toBe(3);
      expect(spawnCalls[0]).toEqual(["tmux", "has-session", "-t", `tmux-agent-abc`]);
      expect(spawnCalls[1]).toEqual(["tmux", "send-keys", "-t", `tmux-agent-abc`, "-l", "hello world"]);
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
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 6 && c[4] === "-l"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![5]).toBe("[sent by agent agent-sender]: hello");
    });

    test("logs to recipient agent.log", async () => {
      const agent = makeAgent("agent-abc", tempDir);
      await sendMessage(agent, "test message", { cwd: "/" });

      const logContent = await Bun.file(
        join(tempDir, ".ittybitty", "agents", "agent-abc", "agent.log")
      ).text();
      expect(logContent).toContain("Received message: test message");
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
  });

  // newAgent tests are in the dedicated "newAgent (native)" describe block below
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "resume-test-"));
    spawnCalls = [];
    const runner = mockSpawnFn(spawnCalls);
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

  test("returns error when agent is not stopped", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }));

    const agent = makeAgent("agent-abc", tempDir, "running");
    const result = await resumeAgent(agent);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not stopped");
    expect(result.stderr).toContain("running");
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
    // PATH export should use single-quoted path
    expect(resumeScript).toContain(`export PATH='${tempDir}'":$PATH"`);
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ib-newagent-test-"));
    agentsDir = join(tempDir, ".ittybitty", "agents");
    spawnCalls = [];

    // Create .ittybitty/repo-id
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    await Bun.write(join(tempDir, ".ittybitty", "repo-id"), "abcd1234\n");

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
    await rm(tempDir, { recursive: true, force: true });
  });

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

  test("stores agentType in meta.json when --worker flag is used", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("test worker", { name: "test-worker-type", worker: true });
    expect(result.ok).toBe(true);

    const meta = await Bun.file(join(agentsDir, "test-worker-type", "meta.json")).json();
    expect(meta.agentType).toBe("worker");
    expect(meta.worker).toBe(true);
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

  test("rejects --type coordinator with helpful message", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("test type coordinator", { name: "test-type-coord", type: "coordinator" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("use --coordinator instead of --type coordinator");
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
    expect(startSh).toContain(`export PATH='${tempDir}'":$PATH"`);
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

  test("worker mode sets meta.worker and start.sh doesn't have yolo flags", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-worker", worker: true });

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
    await callNewAgent("work task", { name: "test-worker-prompts", worker: true });

    const promptContent = await Bun.file(join(agentsDir, "test-worker-prompts", "prompt.txt")).text();
    expect(promptContent).toContain("[CUSTOM WORKER INSTRUCTIONS]");
    expect(promptContent).toContain("Focus on task.");
    expect(promptContent).not.toContain("Coordinate sub-agents.");
  });

  test("creates settings.local.json in worktree with permissions", async () => {
    // Create base settings
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
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

  test("config permissions.all are merged into settings", async () => {
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({
      permissions: {
        all: { allow: ["Bash(deploy:*)"], deny: ["Bash(rm:*)"] },
      },
    }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-cfg-perms" });

    const settingsPath = join(agentsDir, "test-cfg-perms", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(deploy:*)");
    expect(settings.permissions.deny).toContain("Bash(rm:*)");
  });

  test("permissions.all.allow/deny are merged into settings for managers", async () => {
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({
      permissions: {
        all: { allow: ["Bash(curl:*)"], deny: ["Bash(sudo:*)"] },
      },
    }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-all-perms" });

    const settingsPath = join(agentsDir, "test-all-perms", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    // All permissions merged in
    expect(settings.permissions.allow).toContain("Bash(curl:*)");
    expect(settings.permissions.deny).toContain("Bash(sudo:*)");
  });

  test("permissions.all.allow/deny are merged into settings for workers", async () => {
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({
      permissions: {
        all: { allow: ["Bash(curl:*)"], deny: ["Bash(sudo:*)"] },
      },
    }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-all-worker", worker: true });

    const settingsPath = join(agentsDir, "test-all-worker", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(curl:*)");
    expect(settings.permissions.deny).toContain("Bash(sudo:*)");
  });

  test("permissions.all without role-specific permissions still applies", async () => {
    await Bun.write(join(tempDir, "config.json"), JSON.stringify({
      permissions: {
        all: { allow: ["Bash(curl:*)"], deny: ["Bash(sudo:*)"] },
      },
    }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-all-only" });

    const settingsPath = join(agentsDir, "test-all-only", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(curl:*)");
    expect(settings.permissions.deny).toContain("Bash(sudo:*)");
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

  test("start.sh shell-quotes paths to handle spaces and special chars", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("do work", { name: "test-quotes" });

    const startSh = await Bun.file(join(agentsDir, "test-quotes", "start.sh")).text();
    // PATH export should use single-quoted path
    expect(startSh).toContain(`export PATH='${tempDir}'":$PATH"`);
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
    const result = await newAgent(coordRepo, "start coordinator", { coordinator: true, _cwd: coordRepo });
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
    const result = await newAgent(coordRepo, "start coordinator", { coordinator: true, _cwd: coordRepo });
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
  });

  afterEach(async () => {
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
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Task|Agent|TaskCreate");
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

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import type { Agent, AgentMeta } from "./agents";
import { makeAgent as _makeAgent } from "./test-utils";
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
  statusAgent,
  pauseAgent,
  acknowledgeQuestion,
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
} from "./ib-commands";
import {
  setSpawnRunner as setLifecycleSpawnRunner,
  resetSpawnRunner as resetLifecycleSpawnRunner,
} from "./agent-lifecycle";
import type { SpawnResult } from "./types";

function makeAgent(id: string, repoPath: string, state = "running"): Agent {
  return _makeAgent({ id, repoPath, repoName: "test-repo", state: state as any });
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
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
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
          return {
            stdout: new Response("").body!,
            stderr: new Response("session not found").body!,
            exited: Promise.resolve(1),
          } as SpawnResult;
        }
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
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
    return {
      stdout: new Response("").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
    } as SpawnResult;
  };
}

// Helper: create a mock SpawnFn that returns failure for specific commands
function mockSpawnFnWithFailures(
  calls: string[][],
  failCommands: (cmd: string[]) => boolean
): (cmd: string[], opts?: any) => SpawnResult {
  return (cmd: string[]) => {
    calls.push(cmd);
    const exitCode = failCommands(cmd) ? 1 : 0;
    return {
      stdout: new Response("").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(exitCode),
    } as SpawnResult;
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
    setLifecycleSpawnRunner(runner);
    setKillPauseSpawnRunner(runner);
  });

  afterEach(async () => {
    resetLifecycleSpawnRunner();
    resetKillPauseSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory and tmux session don't exist", async () => {
    // No meta.json + tmux has-session fails
    const runner = mockSpawnFnWithFailures(spawnCalls, (cmd) => cmd.includes("has-session"));
    setLifecycleSpawnRunner(runner);
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
    setLifecycleSpawnRunner(runner);
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
    setLifecycleSpawnRunner(runner);
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
    setLifecycleSpawnRunner(runner);
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
    setLifecycleSpawnRunner(runner);
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
    setLifecycleSpawnRunner(runner);
    setKillPauseSpawnRunner(runner);
  });

  afterEach(async () => {
    resetLifecycleSpawnRunner();
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
    setLifecycleSpawnRunner(runner);
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
    setLifecycleSpawnRunner(runner);
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
    setLifecycleSpawnRunner(runner);
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
    setLifecycleSpawnRunner(runner);
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
    setLifecycleSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);
  });

  afterEach(async () => {
    resetLifecycleSpawnRunner();
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
    setLifecycleSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);
  });

  afterEach(async () => {
    resetLifecycleSpawnRunner();
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
    setLifecycleSpawnRunner(runner);
    setNukeResumeSpawnRunner(runner);
  });

  afterEach(async () => {
    resetLifecycleSpawnRunner();
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
      session_id: "sess-123",
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
      session_id: "sess-123",
      model: "opus",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "sess-123",
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
    expect(resumeScript).toContain("sess-123");
    expect(resumeScript).toContain("--model opus");

    // tmux new-session should have been called
    const newSessionCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "new-session"
    );
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall).toContain("tmux-agent-abc");

    // tmux send-keys for nudge should have been called
    const nudgeCall = spawnCalls.find(
      (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 5 && c[4] !== "Enter"
    );
    expect(nudgeCall).toBeDefined();
    expect(nudgeCall![4]).toContain("Resume your work");
  });

  test("detects yolo mode from start.sh", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "sess-123",
    }));
    await Bun.write(join(agentDir, "start.sh"), "#!/bin/bash\nclaude --dangerously-skip-permissions &\n");

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "sess-123",
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
      session_id: "sess-123",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "sess-123",
        tmux_session: "tmux-agent-abc",
      } as any,
    });
    await resumeAgent(agent);

    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("Agent resumed");
    expect(log).toContain("Sent resume nudge");
  });

  test("uses repoPath when worktree repo dir doesn't exist", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    // Don't create repo/ subdirectory
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-abc",
      tmux_session: "tmux-agent-abc",
      session_id: "sess-123",
    }));

    const agent = _makeAgent({
      id: "agent-abc",
      repoPath: tempDir,
      repoName: "test",
      state: "stopped",
      meta: {
        session_id: "sess-123",
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
        return {
          stdout: new Response(hasChanges ? "M file.ts\n" : "").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }

      // git branch --show-current
      if (cmdStr.includes("branch") && cmdStr.includes("--show-current")) {
        return {
          stdout: new Response(opts.currentBranch).body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }

      // git show-ref --verify
      if (cmdStr.includes("show-ref") && cmdStr.includes("--verify")) {
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(opts.branchExists ? 0 : 1),
        } as SpawnResult;
      }

      // git log ... --oneline (commit count)
      if (cmdStr.includes("log") && cmdStr.includes("--oneline")) {
        const lines = Array.from({ length: opts.commitCount }, (_, i) => `abc${i} commit ${i}`);
        return {
          stdout: new Response(opts.commitCount > 0 ? lines.join("\n") : "").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }

      // Conflict check: git rebase in temp dir
      if (cmd.includes("rebase") && cmdStr.includes("/tmp/ib-rebase-check-")) {
        return {
          stdout: new Response(opts.conflictCheckFails ? "CONFLICT (content): Merge conflict in file.ts" : "").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(opts.conflictCheckFails ? 1 : 0),
        } as SpawnResult;
      }

      // Actual rebase in worktree
      if (cmd.includes("rebase") && !cmdStr.includes("/tmp/ib-rebase-check-") && !cmd.includes("--abort")) {
        return {
          stdout: new Response(opts.rebaseFails ? "CONFLICT" : "").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(opts.rebaseFails ? 1 : 0),
        } as SpawnResult;
      }

      // git checkout
      if (cmd.includes("checkout")) {
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(opts.checkoutFails ? 1 : 0),
        } as SpawnResult;
      }

      // git merge (but not merge in "merge-check")
      if (cmd.includes("merge") && (cmd.includes("--ff-only") || cmd.includes("--no-ff"))) {
        return {
          stdout: new Response(opts.mergeFails ? "Merge conflict" : "").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(opts.mergeFails ? 1 : 0),
        } as SpawnResult;
      }

      // tmux has-session → failure (no active session)
      if (cmdStr.includes("has-session")) {
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(1),
        } as SpawnResult;
      }

      // pgrep → failure (no processes)
      if (cmd[0] === "pgrep") {
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(1),
        } as SpawnResult;
      }

      // Default: success
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      } as SpawnResult;
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "merge-test-"));
    spawnCalls = [];
  });

  afterEach(async () => {
    resetLifecycleSpawnRunner();
    resetMergeSpawnRunner();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns error when agent directory doesn't exist", async () => {
    const runner = makeMergeMock();
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = _makeAgent({
      id: ourAgentId,
      repoPath,
      repoName: "test",
      meta: { tmux_session: `tmux-${ourAgentId}` } as any,
    });
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
        return {
          stdout: new Response("").body!,
          stderr: new Response("error: could not apply abc1234... some commit\nConflict in file.ts").body!,
          exited: Promise.resolve(1),
        } as SpawnResult;
      }

      // git status --porcelain → clean
      if (cmdStr.includes("status") && cmdStr.includes("--porcelain")) {
        return { stdout: new Response("").body!, stderr: new Response("").body!, exited: Promise.resolve(0) } as SpawnResult;
      }
      // git branch --show-current → main
      if (cmdStr.includes("branch") && cmdStr.includes("--show-current")) {
        return { stdout: new Response("main").body!, stderr: new Response("").body!, exited: Promise.resolve(0) } as SpawnResult;
      }
      // git show-ref → exists
      if (cmdStr.includes("show-ref")) {
        return { stdout: new Response("").body!, stderr: new Response("").body!, exited: Promise.resolve(0) } as SpawnResult;
      }
      // git log --oneline → 1 commit
      if (cmdStr.includes("log") && cmdStr.includes("--oneline")) {
        return { stdout: new Response("abc1234 some commit").body!, stderr: new Response("").body!, exited: Promise.resolve(0) } as SpawnResult;
      }
      // Conflict check rebase → success
      if (cmd.includes("rebase") && cmdStr.includes("/tmp/ib-rebase-check-")) {
        return { stdout: new Response("").body!, stderr: new Response("").body!, exited: Promise.resolve(0) } as SpawnResult;
      }
      // Default → success
      return { stdout: new Response("").body!, stderr: new Response("").body!, exited: Promise.resolve(0) } as SpawnResult;
    };

    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
        return {
          stdout: new Response("").body!,
          stderr: new Response("error: failed to remove worktree").body!,
          exited: Promise.resolve(1),
        } as SpawnResult;
      }
      return baseMock(cmd, opts);
    };

    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    const result = await mergeAgent(agent);

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
    setLifecycleSpawnRunner(runner);
    setMergeSpawnRunner(runner);

    const agent = makeAgent("agent-abc", tempDir);
    await mergeAgent(agent);

    // Agent dir should still exist since merge failed before cleanup
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("Pre-rebase conflict check failed");
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

    // Create project config to override user-level config (e.g., ~/.ittybitty.json model setting)
    // This ensures tests don't inherit model/permissions from the user's real config
    await Bun.write(join(tempDir, ".ittybitty.json"), JSON.stringify({ model: "sonnet" }, null, 2));

    // Also set the lifecycle spawn runner (used by resolveGitRoot)
    setLifecycleSpawnRunner((cmd: string[], _opts?: { stdout: "pipe"; stderr: "pipe" }): SpawnResult => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("--git-common-dir")) return makeSpawnResult(".git", 0);
      if (cmdStr.includes("--show-toplevel")) return makeSpawnResult(tempDir, 0);
      if (cmdStr.includes("--git-dir")) return makeSpawnResult(".git", 0);
      return makeSpawnResult("", 0);
    });
  });

  afterEach(async () => {
    resetNewAgentSpawnRunner();
    resetLifecycleSpawnRunner();
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
    expect(meta.yolo).toBe(false);
    expect(meta.model).toBe("sonnet"); // default model
    expect(meta.session_id).toMatch(/^[0-9a-f-]+$/);
    expect(typeof meta.created_epoch).toBe("number");
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
    expect(startSh).toContain(`export PATH="${tempDir}:$PATH"`);
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
    expect(tmuxNewSession).toContain("60");
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
    // Create .ittybitty.json with maxAgents: 1
    await Bun.write(join(tempDir, ".ittybitty.json"), JSON.stringify({ maxAgents: 1 }));

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
    await Bun.write(join(tempDir, ".ittybitty.json"), JSON.stringify({ model: "haiku" }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-cfg-model" });

    const meta = await Bun.file(join(agentsDir, "test-cfg-model", "meta.json")).json();
    expect(meta.model).toBe("haiku");
  });

  test("defaults model to sonnet when neither opts nor config specify", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-default-model" });

    const meta = await Bun.file(join(agentsDir, "test-default-model", "meta.json")).json();
    expect(meta.model).toBe("sonnet");
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
    expect(settings.permissions.allow).toContain("Bash(itsybitsy:*)");
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("CustomTool"); // merged from base
    expect(settings.permissions.deny).toContain("EnterPlanMode");
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
  });

  test("writes .claude dir in worktree even without base settings", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-no-base" });

    const settingsPath = join(agentsDir, "test-no-base", "repo", ".claude", "settings.local.json");
    const settingsExists = await Bun.file(settingsPath).exists().catch(() => false);
    expect(settingsExists).toBe(true);

    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(itsybitsy:*)");
  });

  test("rejects unknown manager", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    const result = await callNewAgent("task", { manager: "nonexistent" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not found");
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

  test("config permissions are merged into settings", async () => {
    await Bun.write(join(tempDir, ".ittybitty.json"), JSON.stringify({
      permissions: {
        manager: { allow: ["Bash(deploy:*)"], deny: ["Bash(rm:*)"] },
      },
    }));

    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-cfg-perms" });

    const settingsPath = join(agentsDir, "test-cfg-perms", "repo", ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.permissions.allow).toContain("Bash(deploy:*)");
    expect(settings.permissions.deny).toContain("Bash(rm:*)");
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

  test("print mode flag is included in start.sh", async () => {
    setNewAgentSpawnRunner(mockSpawnRunner());
    await callNewAgent("task", { name: "test-print", print: true });

    const startSh = await Bun.file(join(agentsDir, "test-print", "start.sh")).text();
    expect(startSh).toContain("--print");
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

  test("clear manager (null) sets manager to empty string", async () => {
    const agentsDir = join(tempDir, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-abc", manager: "agent-old", tmux_session: "tmux-agent-abc" }));

    const agent = makeAgent("agent-abc", tempDir);
    const result = await reassignAgent(agent, null);

    expect(result.ok).toBe(true);
    const updatedMeta = await Bun.file(join(agentDir, "meta.json")).json();
    expect(updatedMeta.manager).toBe("");
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
        return {
          stdout: new Response("M file.ts\n").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      } as SpawnResult;
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
        return {
          stdout: new Response("abc1234 commit msg\n").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      } as SpawnResult;
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
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(1),
        } as SpawnResult;
      }
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      } as SpawnResult;
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
        return {
          stdout: new Response("abc123\n").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }
      if (cmd.includes("diff")) {
        return {
          stdout: new Response("+added line\n-removed line\n").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      } as SpawnResult;
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
    await mkdir(join(agentDir, "repo"), { recursive: true });

    setDiffStatusSpawnRunner((cmd: string[]) => {
      if (cmd.includes("log")) {
        return {
          stdout: new Response("abc1234 first commit\ndef5678 second commit\n").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }
      if (cmd.includes("status")) {
        return {
          stdout: new Response("M src/file.ts\n").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      }
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      } as SpawnResult;
    });

    const agent = makeAgent("agent-abc", tempDir);
    const result = await statusAgent(agent);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("first commit");
    expect(result.stdout).toContain("M src/file.ts");
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
    expect(result.stdout).toContain("Acknowledged question 'q-1'");
    expect(result.stdout).toContain("agent-abc");

    // Verify the file was updated
    const updated = await Bun.file(questionsPath).json();
    const q1 = updated.questions.find((q: any) => q.id === "q-1");
    expect(q1.acknowledged).toBe(true);
    expect(q1.status).toBe("acknowledged");
    expect(q1.acknowledged_at).toBeTruthy();
    // Other question untouched
    const q2 = updated.questions.find((q: any) => q.id === "q-2");
    expect(q2.status).toBe("pending");
    expect(q2.acknowledged).toBeUndefined();
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

// ── Hooks management tests ────────────────────────────────────────────────────

describe("hooksStatus", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hooks-status-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns not-installed when no settings file exists", async () => {
    const result = await hooksStatus(tempDir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("not-installed");
  });

  test("returns not-installed when settings has no hooks", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({ permissions: {} }));
    const result = await hooksStatus(tempDir);
    expect(result.stdout).toBe("not-installed");
  });

  test("returns installed when all three hook types present", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
      },
    }));
    const result = await hooksStatus(tempDir);
    expect(result.stdout).toBe("installed");
  });

  test("returns installed with itsybitsy prefix", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "itsybitsy hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "itsybitsy hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "itsybitsy hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "itsybitsy hooks session-start" }] }],
      },
    }));
    const result = await hooksStatus(tempDir);
    expect(result.stdout).toBe("installed");
  });

  test("returns partial when only main-path present", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
      },
    }));
    const result = await hooksStatus(tempDir);
    expect(result.stdout).toBe("partial");
  });

  test("returns partial when only session-start present", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "itsybitsy hooks session-start" }] }],
      },
    }));
    const result = await hooksStatus(tempDir);
    expect(result.stdout).toBe("partial");
  });

  test("returns partial when status hooks only have UserPromptSubmit (missing PostToolUse)", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
      },
    }));
    // Only UserPromptSubmit without PostToolUse means status hooks are NOT detected as present
    // But UserPromptSubmit exists in the hooks object, so partial? No — hasStatusHooks returns false
    // because it requires BOTH. So this should be not-installed.
    const result = await hooksStatus(tempDir);
    expect(result.stdout).toBe("not-installed");
  });
});

describe("interceptHooksStatus", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "intercept-status-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns not-installed when no settings file", async () => {
    const result = await interceptHooksStatus(tempDir);
    expect(result.stdout).toBe("not-installed");
  });

  test("returns installed when intercept hook present", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "ib hooks intercept-task" }] }],
      },
    }));
    const result = await interceptHooksStatus(tempDir);
    expect(result.stdout).toBe("installed");
  });

  test("returns installed with itsybitsy prefix", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "itsybitsy hooks intercept-task" }] }],
      },
    }));
    const result = await interceptHooksStatus(tempDir);
    expect(result.stdout).toBe("installed");
  });

  test("returns not-installed when PreToolUse has other hooks but not intercept", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
      },
    }));
    const result = await interceptHooksStatus(tempDir);
    expect(result.stdout).toBe("not-installed");
  });
});

describe("installSafetyHooks", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "install-hooks-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates settings file and installs all hooks from scratch", async () => {
    const result = await installSafetyHooks(tempDir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Hooks installed");

    const settings = await Bun.file(join(tempDir, ".claude", "settings.local.json")).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("itsybitsy hooks main-path");
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("inject-status --full");
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain("inject-status --if-changed");
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("itsybitsy hooks session-start");
  });

  test("is idempotent — second call returns already installed", async () => {
    await installSafetyHooks(tempDir);
    const result = await installSafetyHooks(tempDir);
    expect(result.stdout).toBe("Hooks already installed");

    // Verify no duplicates
    const settings = await Bun.file(join(tempDir, ".claude", "settings.local.json")).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test("preserves existing settings and adds missing hooks", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
      },
    }));

    const result = await installSafetyHooks(tempDir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Hooks installed");

    const settings = await Bun.file(join(tempDir, ".claude", "settings.local.json")).json();
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
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
      },
    }));

    const result = await installSafetyHooks(tempDir);
    expect(result.stdout).toBe("Hooks already installed");
  });
});

describe("uninstallSafetyHooks", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "uninstall-hooks-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns message when no settings file exists", async () => {
    const result = await uninstallSafetyHooks(tempDir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("nothing to uninstall");
  });

  test("removes all safety hooks and preserves other settings", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "itsybitsy hooks main-path" }] },
          { matcher: "Task", hooks: [{ type: "command", command: "itsybitsy hooks intercept-task" }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "itsybitsy hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "itsybitsy hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "itsybitsy hooks session-start" }] }],
      },
    }));

    const result = await uninstallSafetyHooks(tempDir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Hooks uninstalled");

    const settings = await Bun.file(join(tempDir, ".claude", "settings.local.json")).json();
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
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ib hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
      },
    }));

    const result = await uninstallSafetyHooks(tempDir);
    // All hooks removed — file should be deleted since settings is now empty
    expect(result.stdout).toContain("removed empty settings file");
    const exists = await Bun.file(join(tempDir, ".claude", "settings.local.json")).exists();
    expect(exists).toBe(false);
  });

  test("deletes empty settings file", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "itsybitsy hooks main-path" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "itsybitsy hooks inject-status --full --visible" }] }],
        PostToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "itsybitsy hooks inject-status --if-changed --visible" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "itsybitsy hooks session-start" }] }],
      },
    }));

    const result = await uninstallSafetyHooks(tempDir);
    expect(result.stdout).toContain("removed empty settings file");

    const exists = await Bun.file(join(tempDir, ".claude", "settings.local.json")).exists();
    expect(exists).toBe(false);
  });

  test("is idempotent", async () => {
    const result1 = await uninstallSafetyHooks(tempDir);
    expect(result1.ok).toBe(true);
    const result2 = await uninstallSafetyHooks(tempDir);
    expect(result2.ok).toBe(true);
  });
});

describe("installInterceptHook", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "install-intercept-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("installs intercept hook from scratch", async () => {
    const result = await installInterceptHook(tempDir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("installed");

    const settings = await Bun.file(join(tempDir, ".claude", "settings.local.json")).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Task");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("itsybitsy hooks intercept-task");
  });

  test("is idempotent", async () => {
    await installInterceptHook(tempDir);
    const result = await installInterceptHook(tempDir);
    expect(result.stdout).toContain("already installed");

    const settings = await Bun.file(join(tempDir, ".claude", "settings.local.json")).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  test("preserves existing hooks", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "itsybitsy hooks main-path" }] }],
      },
    }));

    await installInterceptHook(tempDir);

    const settings = await Bun.file(join(tempDir, ".claude", "settings.local.json")).json();
    expect(settings.hooks.PreToolUse).toHaveLength(2);
  });

  test("detects ib-prefixed intercept as already installed", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "ib hooks intercept-task" }] }],
      },
    }));

    const result = await installInterceptHook(tempDir);
    expect(result.stdout).toContain("already installed");
  });
});

describe("uninstallInterceptHook", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "uninstall-intercept-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns message when no settings file", async () => {
    const result = await uninstallInterceptHook(tempDir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("nothing to uninstall");
  });

  test("removes intercept hook and preserves others", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "itsybitsy hooks main-path" }] },
          { matcher: "Task", hooks: [{ type: "command", command: "itsybitsy hooks intercept-task" }] },
        ],
      },
    }));

    await uninstallInterceptHook(tempDir);

    const settings = await Bun.file(join(tempDir, ".claude", "settings.local.json")).json();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("main-path");
  });

  test("removes ib-prefixed intercept hook", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "ib hooks intercept-task" }] }],
      },
    }));

    const result = await uninstallInterceptHook(tempDir);
    expect(result.stdout).toContain("removed empty settings file");
    const exists = await Bun.file(join(tempDir, ".claude", "settings.local.json")).exists();
    expect(exists).toBe(false);
  });

  test("deletes empty settings file", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await Bun.write(join(tempDir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: "itsybitsy hooks intercept-task" }] }],
      },
    }));

    const result = await uninstallInterceptHook(tempDir);
    expect(result.stdout).toContain("removed empty settings file");

    const exists = await Bun.file(join(tempDir, ".claude", "settings.local.json")).exists();
    expect(exists).toBe(false);
  });

  test("is idempotent", async () => {
    const result = await uninstallInterceptHook(tempDir);
    expect(result.ok).toBe(true);
  });
});

describe("hooks round-trip", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hooks-roundtrip-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("install then uninstall safety hooks leaves clean state", async () => {
    await installSafetyHooks(tempDir);
    let status = await hooksStatus(tempDir);
    expect(status.stdout).toBe("installed");

    await uninstallSafetyHooks(tempDir);
    status = await hooksStatus(tempDir);
    expect(status.stdout).toBe("not-installed");
  });

  test("install then uninstall intercept hook leaves clean state", async () => {
    await installInterceptHook(tempDir);
    let status = await interceptHooksStatus(tempDir);
    expect(status.stdout).toBe("installed");

    await uninstallInterceptHook(tempDir);
    status = await interceptHooksStatus(tempDir);
    expect(status.stdout).toBe("not-installed");
  });

  test("install both, uninstall safety only, intercept remains", async () => {
    await installSafetyHooks(tempDir);
    await installInterceptHook(tempDir);

    await uninstallSafetyHooks(tempDir);

    const safetyStatus = await hooksStatus(tempDir);
    expect(safetyStatus.stdout).toBe("not-installed");

    const interceptStatus = await interceptHooksStatus(tempDir);
    expect(interceptStatus.stdout).toBe("installed");
  });

  test("install both, uninstall intercept only, safety remains", async () => {
    await installSafetyHooks(tempDir);
    await installInterceptHook(tempDir);

    await uninstallInterceptHook(tempDir);

    const safetyStatus = await hooksStatus(tempDir);
    expect(safetyStatus.stdout).toBe("installed");

    const interceptStatus = await interceptHooksStatus(tempDir);
    expect(interceptStatus.stdout).toBe("not-installed");
  });
});

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
  setRunner,
  resetRunner,
  setSendSpawnRunner,
  resetSendSpawnRunner,
  setKillPauseSpawnRunner,
  resetKillPauseSpawnRunner,
  setNukeResumeSpawnRunner,
  resetNukeResumeSpawnRunner,
  setMergeSpawnRunner,
  resetMergeSpawnRunner,
} from "./ib-commands";
import {
  setSpawnRunner as setLifecycleSpawnRunner,
  resetSpawnRunner as resetLifecycleSpawnRunner,
} from "./agent-lifecycle";
import type { IbCommandResult } from "./ib-commands";
import type { SpawnResult } from "./types";

function makeAgent(id: string, repoPath: string, state = "running"): Agent {
  return _makeAgent({ id, repoPath, repoName: "test-repo", state: state as any });
}

describe("ib-commands", () => {
  let lastCall: { args: string[]; cwd: string } | null = null;
  const successResult: IbCommandResult = {
    ok: true,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  };

  beforeEach(() => {
    lastCall = null;
    setRunner(async (args, cwd) => {
      lastCall = { args, cwd };
      return successResult;
    });
  });

  afterEach(() => {
    resetRunner();
  });

  // nukeAgent, nukeAllAgents, resumeAgent are now native — tested in dedicated describe blocks below

  test("reassignAgent passes ['reassign', id, newManager]", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await reassignAgent(agent, "agent-xyz");
    expect(lastCall).toEqual({
      args: ["reassign", "agent-abc", "agent-xyz"],
      cwd: "/repos/myproject",
    });
  });

  test("mergeCheckAgent passes ['merge-check', id]", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await mergeCheckAgent(agent);
    expect(lastCall).toEqual({
      args: ["merge-check", "agent-abc"],
      cwd: "/repos/myproject",
    });
  });

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
      expect(spawnCalls[1]).toEqual(["tmux", "send-keys", "-t", `tmux-agent-abc`, "hello world"]);
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
        (c) => c[0] === "tmux" && c[1] === "send-keys" && c.length === 5 && c[4] !== "Enter"
      );
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall![4]).toBe("[sent by agent agent-sender]: hello");
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

  test("newAgent passes ['new-agent', prompt] with repoPath as cwd", async () => {
    await newAgent("/repos/myproject", "build a widget");
    expect(lastCall).toEqual({
      args: ["new-agent", "build a widget"],
      cwd: "/repos/myproject",
    });
  });

  test("newAgent with --worker flag", async () => {
    await newAgent("/repos/myproject", "build it", { worker: true });
    expect(lastCall!.args).toEqual(["new-agent", "--worker", "build it"]);
  });

  test("newAgent with --yolo flag", async () => {
    await newAgent("/repos/myproject", "build it", { yolo: true });
    expect(lastCall!.args).toEqual(["new-agent", "--yolo", "build it"]);
  });

  test("newAgent with --model flag", async () => {
    await newAgent("/repos/myproject", "build it", { model: "opus" });
    expect(lastCall!.args).toEqual(["new-agent", "--model", "opus", "build it"]);
  });

  test("newAgent with --manager flag", async () => {
    await newAgent("/repos/myproject", "build it", { manager: "agent-mgr" });
    expect(lastCall!.args).toEqual(["new-agent", "--manager", "agent-mgr", "build it"]);
  });

  test("newAgent with all options", async () => {
    await newAgent("/repos/myproject", "build it", {
      worker: true,
      yolo: true,
      model: "opus",
      manager: "agent-mgr",
    });
    expect(lastCall!.args).toEqual([
      "new-agent",
      "--worker",
      "--yolo",
      "--model",
      "opus",
      "--manager",
      "agent-mgr",
      "build it",
    ]);
  });

  test("diffAgent passes ['diff', id]", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await diffAgent(agent);
    expect(lastCall).toEqual({
      args: ["diff", "agent-abc"],
      cwd: "/repos/myproject",
    });
  });

  test("statusAgent passes ['status', id]", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await statusAgent(agent);
    expect(lastCall).toEqual({
      args: ["status", "agent-abc"],
      cwd: "/repos/myproject",
    });
  });

  test("acknowledgeQuestion passes ['acknowledge', questionId] with repoPath as cwd", async () => {
    await acknowledgeQuestion("/repos/myproject", "q-1");
    expect(lastCall).toEqual({
      args: ["acknowledge", "q-1"],
      cwd: "/repos/myproject",
    });
  });

  // mergeAgent passthrough tests removed — now native
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

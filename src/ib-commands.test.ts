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

  test("nukeAgent passes ['nuke', id, '--force']", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await nukeAgent(agent);
    expect(lastCall).toEqual({
      args: ["nuke", "agent-abc", "--force"],
      cwd: "/repos/myproject",
    });
  });

  test("nukeAllAgents passes ['nuke', '--force'] with repoPath as cwd", async () => {
    await nukeAllAgents("/repos/myproject");
    expect(lastCall).toEqual({
      args: ["nuke", "--force"],
      cwd: "/repos/myproject",
    });
  });

  test("resumeAgent passes ['resume', id]", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await resumeAgent(agent);
    expect(lastCall).toEqual({
      args: ["resume", "agent-abc"],
      cwd: "/repos/myproject",
    });
  });

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

  test("mergeAgent passes ['merge', id, '--force']", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await mergeAgent(agent);
    expect(lastCall).toEqual({
      args: ["merge", "agent-abc", "--force"],
      cwd: "/repos/myproject",
    });
  });

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

  test("IbRunner passthrough returns result from runner (nukeAgent)", async () => {
    setRunner(async () => ({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "something broke",
    }));
    const agent = makeAgent("agent-abc", "/repos/myproject");
    // nukeAgent still uses IbRunner passthrough (not yet native)
    const result = await nukeAgent(agent);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("something broke");
  });

  test("cwd always matches agent.repoPath", async () => {
    const agent = makeAgent("agent-abc", "/some/deep/path/to/repo");

    await resumeAgent(agent);
    expect(lastCall!.cwd).toBe("/some/deep/path/to/repo");

    await mergeAgent(agent);
    expect(lastCall!.cwd).toBe("/some/deep/path/to/repo");
  });
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

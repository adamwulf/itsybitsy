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
} from "./ib-commands";
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

  test("killAgent passes ['kill', id, '--force'] with agent's repoPath", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await killAgent(agent);
    expect(lastCall).toEqual({
      args: ["kill", "agent-abc", "--force"],
      cwd: "/repos/myproject",
    });
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

  test("pauseAgent passes ['pause', id] with agent's repoPath", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await pauseAgent(agent);
    expect(lastCall).toEqual({
      args: ["pause", "agent-abc"],
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

  test("returns result from runner", async () => {
    setRunner(async () => ({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "something broke",
    }));
    const agent = makeAgent("agent-abc", "/repos/myproject");
    const result = await killAgent(agent);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("something broke");
  });

  test("cwd always matches agent.repoPath", async () => {
    const agent = makeAgent("agent-abc", "/some/deep/path/to/repo");
    await killAgent(agent);
    expect(lastCall!.cwd).toBe("/some/deep/path/to/repo");

    await resumeAgent(agent);
    expect(lastCall!.cwd).toBe("/some/deep/path/to/repo");

    await mergeAgent(agent);
    expect(lastCall!.cwd).toBe("/some/deep/path/to/repo");
  });
});

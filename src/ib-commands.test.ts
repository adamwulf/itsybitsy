import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Agent, AgentMeta } from "./agents";
import {
  killAgent,
  nukeAgent,
  resumeAgent,
  reassignAgent,
  mergeCheckAgent,
  mergeAgent,
  sendMessage,
  newAgent,
  diffAgent,
  statusAgent,
  acknowledgeQuestion,
  setRunner,
  resetRunner,
} from "./ib-commands";
import type { IbCommandResult } from "./ib-commands";

function makeAgent(id: string, repoPath: string, state = "running"): Agent {
  return {
    id,
    repoPath,
    repoName: "test-repo",
    state: state as any,
    age: "1m",
    archived: false,
    children: [],
    meta: {
      id,
      session_id: "sess-1",
      tmux_session: `tmux-${id}`,
      prompt: "test prompt",
      manager: null,
      created: "2026-03-05T00:00:00Z",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true,
      worker: false,
      yolo: false,
      model: "sonnet",
      claude_pid: "12345",
    } as AgentMeta,
  };
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

  test("killAgent passes ['kill', id] with agent's repoPath", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await killAgent(agent);
    expect(lastCall).toEqual({
      args: ["kill", "agent-abc"],
      cwd: "/repos/myproject",
    });
  });

  test("nukeAgent passes ['kill', id, '--force']", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await nukeAgent(agent);
    expect(lastCall).toEqual({
      args: ["kill", "agent-abc", "--force"],
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

  test("sendMessage passes ['send', id, message]", async () => {
    const agent = makeAgent("agent-abc", "/repos/myproject");
    await sendMessage(agent, "hello world");
    expect(lastCall).toEqual({
      args: ["send", "agent-abc", "hello world"],
      cwd: "/repos/myproject",
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

  test("newAgent with all options", async () => {
    await newAgent("/repos/myproject", "build it", {
      worker: true,
      yolo: true,
      model: "opus",
    });
    expect(lastCall!.args).toEqual([
      "new-agent",
      "--worker",
      "--yolo",
      "--model",
      "opus",
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

  test("acknowledgeQuestion passes ['acknowledge', questionId] with repoPath as cwd", async () => {
    await acknowledgeQuestion("/repos/myproject", "q-1");
    expect(lastCall).toEqual({
      args: ["acknowledge", "q-1"],
      cwd: "/repos/myproject",
    });
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

import { test, expect, describe, afterEach } from "bun:test";
import {
  sendStagedMessage,
  setStagedSenderForTests,
  resetStagedSenderForTests,
} from "./message-send";
import type { StagedSendOptions } from "./message-send";
import { makeAgent } from "../test-utils";
import type { IbCommandResult } from "../ib-commands";

describe("sendStagedMessage", () => {
  afterEach(() => {
    resetStagedSenderForTests();
  });

  test("delegates to the active sender with the agent, message, and opts", async () => {
    const calls: Array<{ id: string; message: string; opts?: StagedSendOptions }> = [];
    setStagedSenderForTests(async (agent, message, opts) => {
      calls.push({ id: agent.id, message, opts });
      return { ok: true, exitCode: 0, stdout: "queued", stderr: "" };
    });

    const agent = makeAgent({ id: "agent-1", repoPath: "/repos/one" });
    const result = await sendStagedMessage(agent, "hello", { cwd: "/", attachmentBaseDir: "/repos/one" });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("agent-1");
    expect(calls[0]!.message).toBe("hello");
    // The UI forwards the destination repo as the attachment base dir so ./ and
    // ../ references resolve against the selected repo.
    expect(calls[0]!.opts?.attachmentBaseDir).toBe("/repos/one");
    expect(calls[0]!.opts?.cwd).toBe("/");
  });

  test("propagates a failure result from the sender unchanged", async () => {
    const failure: IbCommandResult = { ok: false, exitCode: 1, stdout: "", stderr: "boom" };
    setStagedSenderForTests(async () => failure);

    const result = await sendStagedMessage(makeAgent({ id: "agent-x" }), "hi", { cwd: "/" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("boom");
  });

  test("the production default sender forwards to the real sendMessage", async () => {
    // No override installed → the default forward path runs. An agent with no
    // tmux session makes the real sendMessage return ok:false BEFORE any
    // enqueue, which both proves the default forwards to sendMessage and that
    // the extra staging opts do not break the current signature.
    const agent = makeAgent({ id: "agent-notmux" });
    agent.meta.tmux_session = ""; // no tmux session → real sendMessage returns ok:false early
    const result = await sendStagedMessage(agent, "anything", { cwd: "/", attachmentBaseDir: "/repos/one" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("no tmux session");
  });

  test("resetStagedSenderForTests restores the default sender", async () => {
    setStagedSenderForTests(async () => ({ ok: true, exitCode: 0, stdout: "stub", stderr: "" }));
    resetStagedSenderForTests();

    // After reset, the stub is gone: a no-tmux agent again hits the real
    // sendMessage failure rather than the stub's ok:true.
    const agent = makeAgent({ id: "agent-reset" });
    agent.meta.tmux_session = "";
    const result = await sendStagedMessage(agent, "hi", { cwd: "/" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("no tmux session");
  });
});

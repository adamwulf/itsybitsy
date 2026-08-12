/**
 * Behavioral tests for the centralized per-agent outbox path.
 *
 * Two guarantees the outbox-path move depends on:
 *  1. `agentOutboxDir(id)` returns `<coordinator-home>/agents/<id>/` — i.e.
 *     the queue lives under `~/.itsybitsy/agents/<id>/`, not beside the
 *     per-worktree `meta.json`.
 *  2. `sendMessage(...)` enqueues into THAT central path — never into the
 *     per-worktree agent directory. This is what lets a codex agent under
 *     `-s workspace-write` deliver to any other agent (it has --add-dir on the
 *     coordinator home).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { agentOutboxDir, readOutbox } from "./outbox";
import { setCoordinatorHome, resetCoordinatorHome, getCoordinatorHome } from "./coordinator";
import { sendMessage, setSendSpawnRunner, resetSendSpawnRunner } from "./ib-commands";
import { setUserConfigPath, resetUserConfigPath } from "./config";
import { makeAgent as _makeAgent, makeSpawnResult } from "./test-utils";
import type { AgentState } from "./parse-state";

describe("agentOutboxDir helper", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "outbox-path-helper-"));
    setCoordinatorHome(tempDir);
  });

  afterEach(async () => {
    resetCoordinatorHome();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("agentOutboxDir(id) returns join(getCoordinatorHome(), 'agents', id)", () => {
    expect(agentOutboxDir("agent-abc")).toBe(join(getCoordinatorHome(), "agents", "agent-abc"));
    expect(agentOutboxDir("agent-abc")).toBe(join(tempDir, "agents", "agent-abc"));
  });

  test("agentOutboxDir tracks setCoordinatorHome changes", () => {
    const other = join(tempDir, "other-home");
    setCoordinatorHome(other);
    expect(agentOutboxDir("agent-xyz")).toBe(join(other, "agents", "agent-xyz"));
  });
});

describe("sendMessage centralized outbox location", () => {
  let baseDir: string;
  let repoDir: string;
  let coordHome: string;
  let perWorktreeAgentDir: string;
  let centralQueueDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "outbox-path-send-"));
    repoDir = join(baseDir, "repo");
    coordHome = join(baseDir, ".itsybitsy");
    perWorktreeAgentDir = join(repoDir, ".ittybitty", "agents", "agent-target");
    // Set the coordinator-home BEFORE computing centralQueueDir so
    // agentOutboxDir resolves into our sandbox.
    setCoordinatorHome(coordHome);
    centralQueueDir = agentOutboxDir("agent-target");
    await mkdir(perWorktreeAgentDir, { recursive: true });
    await mkdir(coordHome, { recursive: true });
    // Note: deliberately do NOT pre-create centralQueueDir — sendMessage's
    // enqueue path mkdir's it on demand. We verify that BELOW.
    setUserConfigPath(join(baseDir, "config.json"));
    setSendSpawnRunner(() => makeSpawnResult());
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetUserConfigPath();
    resetCoordinatorHome();
    await rm(baseDir, { recursive: true, force: true });
  });

  test("sendMessage writes to the central per-agent outbox dir, not the per-worktree path", async () => {
    // Plant a live-watchdog transient so the message DEFERS into the queue
    // instead of being drained inline (we want to inspect the file).
    const { writeAgentTransient, isPidAliveCtx } = await import("./agents");
    isPidAliveCtx.set(() => true);
    try {
      await writeAgentTransient(perWorktreeAgentDir, {
        tmux_compacting: false,
        tmux_rate_limited: false,
        tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
        has_background_tasks: false,
        updated_at_ms: Date.now(),
        watchdog_pid: 4242,
      });
      const agent = _makeAgent({
        id: "agent-target",
        repoPath: repoDir,
        repoName: "r",
        state: "running" as AgentState,
      });

      // Send with cwd: "/" so the sender resolves to "" (the human user) and we
      // don't depend on cwd-detection inside the agent worktree.
      await sendMessage(agent, "hello", { cwd: "/" });

      // The message must be queued in the CENTRAL location.
      const centralQueue = await readOutbox(centralQueueDir);
      expect(centralQueue.length).toBe(1);
      expect(centralQueue[0]!.message).toBe("hello");

      // And it must NOT have appeared in the per-worktree agent dir.
      const perWorktreeQueue = await readOutbox(perWorktreeAgentDir);
      expect(perWorktreeQueue).toEqual([]);
      // Belt-and-suspenders: the per-worktree dir must not contain outbox.jsonl
      // at all (a leftover file would silently break drains).
      const entries = await readdir(perWorktreeAgentDir);
      expect(entries).not.toContain("outbox.jsonl");
    } finally {
      isPidAliveCtx.reset();
    }
  });
});

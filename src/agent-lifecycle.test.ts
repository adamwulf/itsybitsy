import { test, expect, describe, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, readdir } from "fs/promises";
import { tmpdir } from "os";
import {
  logAgent,
  removeAgentQuestions,
  archiveAgent,
  getDescendantsRecursive,
  isRunningAsAgent,
  resolveGitRoot,
  _formatTimestamp,
  _formatArchiveTimestamp,
  setSpawnRunner,
  resetSpawnRunner,
  killAgentProcess,
  captureTmuxOutputToFile,
  teardownAgent,
} from "./agent-lifecycle";
import type { SpawnFn, SpawnResult } from "./types";

/** Create a temp directory for test isolation */
async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lifecycle-test-"));
}

describe("agent-lifecycle", () => {
  afterEach(() => {
    resetSpawnRunner();
  });

  // ── logAgent ───────────────────────────────────────────────────────────

  describe("logAgent", () => {
    test("creates agent.log with timestamped entry", async () => {
      const dir = await makeTempDir();
      await logAgent(dir, "Agent started");
      const content = await Bun.file(join(dir, "agent.log")).text();
      expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] Agent started\n$/);
      await rm(dir, { recursive: true, force: true });
    });

    test("appends to existing agent.log", async () => {
      const dir = await makeTempDir();
      await Bun.write(join(dir, "agent.log"), "[2026-01-01 00:00:00] First entry\n");
      await logAgent(dir, "Second entry");
      const content = await Bun.file(join(dir, "agent.log")).text();
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("[2026-01-01 00:00:00] First entry");
      expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] Second entry$/);
      await rm(dir, { recursive: true, force: true });
    });

    test("silently does nothing if directory doesn't exist", async () => {
      // Should not throw
      await logAgent("/nonexistent/path/agent-xyz", "test message");
    });
  });

  // ── removeAgentQuestions ───────────────────────────────────────────────

  describe("removeAgentQuestions", () => {
    test("removes questions for the given agent", async () => {
      const dir = await makeTempDir();
      const ittyDir = join(dir, ".ittybitty");
      await mkdir(ittyDir, { recursive: true });
      const questionsPath = join(ittyDir, "user-questions.json");
      await Bun.write(
        questionsPath,
        JSON.stringify({
          questions: [
            { agent: "agent-abc", question: "q1", status: "pending" },
            { agent: "agent-xyz", question: "q2", status: "pending" },
            { agent: "agent-abc", question: "q3", status: "pending" },
          ],
        })
      );

      await removeAgentQuestions(dir, "agent-abc");

      const data = await Bun.file(questionsPath).json();
      expect(data.questions).toHaveLength(1);
      expect(data.questions[0].agent).toBe("agent-xyz");
      await rm(dir, { recursive: true, force: true });
    });

    test("does nothing if file doesn't exist", async () => {
      // Should not throw
      await removeAgentQuestions("/nonexistent/path", "agent-abc");
    });

    test("does nothing if no questions array", async () => {
      const dir = await makeTempDir();
      const ittyDir = join(dir, ".ittybitty");
      await mkdir(ittyDir, { recursive: true });
      await Bun.write(join(ittyDir, "user-questions.json"), JSON.stringify({ other: "data" }));
      await removeAgentQuestions(dir, "agent-abc");
      // Should not throw
      await rm(dir, { recursive: true, force: true });
    });
  });

  // ── archiveAgent ───────────────────────────────────────────────────────

  describe("archiveAgent", () => {
    test("archives output.log, agent.log, meta.json", async () => {
      const dir = await makeTempDir();
      const repoPath = dir;
      const agentId = "agent-test";
      const agentDir = join(dir, ".ittybitty", "agents", agentId);
      const archiveDir = join(dir, ".ittybitty", "archive");
      await mkdir(agentDir, { recursive: true });
      await mkdir(archiveDir, { recursive: true });

      await Bun.write(join(agentDir, "output.log"), "tmux output");
      await Bun.write(join(agentDir, "agent.log"), "log entry");
      await Bun.write(join(agentDir, "meta.json"), '{"id":"agent-test"}');

      const result = await archiveAgent(repoPath, agentId, agentDir);
      expect(result).not.toBeNull();

      // Archive folder should exist
      const archiveEntries = await readdir(archiveDir);
      expect(archiveEntries).toHaveLength(1);
      expect(archiveEntries[0]).toMatch(/^\d{8}-\d{6}-agent-test$/);

      const archiveFolder = join(archiveDir, archiveEntries[0]!);

      // output.log was moved (should not exist in source)
      expect(await Bun.file(join(agentDir, "output.log")).exists()).toBe(false);
      expect(await Bun.file(join(archiveFolder, "output.log")).text()).toBe("tmux output");

      // agent.log was copied (should still exist in source)
      expect(await Bun.file(join(agentDir, "agent.log")).exists()).toBe(true);
      expect(await Bun.file(join(archiveFolder, "agent.log")).text()).toBe("log entry");

      // meta.json was copied
      expect(await Bun.file(join(archiveFolder, "meta.json")).text()).toBe('{"id":"agent-test"}');

      await rm(dir, { recursive: true, force: true });
    });

    test("archives settings.local.json (move) and debug-logs/ (copy)", async () => {
      const dir = await makeTempDir();
      const agentDir = join(dir, ".ittybitty", "agents", "agent-test");
      const archiveDir = join(dir, ".ittybitty", "archive");
      await mkdir(agentDir, { recursive: true });
      await mkdir(archiveDir, { recursive: true });
      await mkdir(join(agentDir, "debug-logs"), { recursive: true });

      await Bun.write(join(agentDir, "meta.json"), '{"id":"agent-test"}');
      await Bun.write(join(agentDir, "settings.local.json"), '{"permissions":{}}');
      await Bun.write(join(agentDir, "debug-logs", "capture.log"), "debug data");

      const result = await archiveAgent(dir, "agent-test", agentDir);
      expect(result).not.toBeNull();

      const archiveEntries = await readdir(archiveDir);
      const archiveFolder = join(archiveDir, archiveEntries[0]!);

      // settings.local.json moved
      expect(await Bun.file(join(agentDir, "settings.local.json")).exists()).toBe(false);
      expect(await Bun.file(join(archiveFolder, "settings.local.json")).text()).toBe('{"permissions":{}}');

      // debug-logs/ copied
      expect(await Bun.file(join(agentDir, "debug-logs", "capture.log")).exists()).toBe(true);
      expect(await Bun.file(join(archiveFolder, "debug-logs", "capture.log")).text()).toBe("debug data");

      await rm(dir, { recursive: true, force: true });
    });

    test("returns null if nothing to archive", async () => {
      const dir = await makeTempDir();
      const agentDir = join(dir, ".ittybitty", "agents", "agent-empty");
      await mkdir(agentDir, { recursive: true });

      const result = await archiveAgent(dir, "agent-empty", agentDir);
      expect(result).toBeNull();

      await rm(dir, { recursive: true, force: true });
    });
  });

  // ── getDescendantsRecursive ────────────────────────────────────────────

  describe("getDescendantsRecursive", () => {
    test("returns just the manager when no children exist", async () => {
      const dir = await makeTempDir();
      const agentsDir = join(dir, "agents");
      await mkdir(join(agentsDir, "agent-root"), { recursive: true });
      await Bun.write(
        join(agentsDir, "agent-root", "meta.json"),
        JSON.stringify({ id: "agent-root", manager: null })
      );

      const result = await getDescendantsRecursive(agentsDir, "agent-root");
      expect(result).toEqual(["agent-root"]);
      await rm(dir, { recursive: true, force: true });
    });

    test("returns manager + children + grandchildren depth-first", async () => {
      const dir = await makeTempDir();
      const agentsDir = join(dir, "agents");

      // Create: root -> child1, child2; child1 -> grandchild
      for (const id of ["agent-root", "agent-child1", "agent-child2", "agent-grandchild"]) {
        await mkdir(join(agentsDir, id), { recursive: true });
      }
      await Bun.write(join(agentsDir, "agent-root", "meta.json"), JSON.stringify({ id: "agent-root", manager: null }));
      await Bun.write(join(agentsDir, "agent-child1", "meta.json"), JSON.stringify({ id: "agent-child1", manager: "agent-root" }));
      await Bun.write(join(agentsDir, "agent-child2", "meta.json"), JSON.stringify({ id: "agent-child2", manager: "agent-root" }));
      await Bun.write(join(agentsDir, "agent-grandchild", "meta.json"), JSON.stringify({ id: "agent-grandchild", manager: "agent-child1" }));

      const result = await getDescendantsRecursive(agentsDir, "agent-root");
      expect(result[0]).toBe("agent-root");
      expect(result).toContain("agent-child1");
      expect(result).toContain("agent-child2");
      expect(result).toContain("agent-grandchild");
      expect(result).toHaveLength(4);

      // Grandchild should come after child1 (depth-first)
      const child1Idx = result.indexOf("agent-child1");
      const grandchildIdx = result.indexOf("agent-grandchild");
      expect(grandchildIdx).toBeGreaterThan(child1Idx);

      await rm(dir, { recursive: true, force: true });
    });

    test("handles empty agents directory", async () => {
      const dir = await makeTempDir();
      const agentsDir = join(dir, "agents");
      await mkdir(agentsDir, { recursive: true });

      const result = await getDescendantsRecursive(agentsDir, "nonexistent");
      expect(result).toEqual(["nonexistent"]);
      await rm(dir, { recursive: true, force: true });
    });
  });

  // ── isRunningAsAgent ───────────────────────────────────────────────────

  describe("isRunningAsAgent", () => {
    test("returns true for agent worktree path", async () => {
      expect(await isRunningAsAgent("/repos/proj/.ittybitty/agents/agent-abc/repo")).toBe(true);
      expect(await isRunningAsAgent("/repos/proj/.ittybitty/agents/agent-abc/repo/src")).toBe(true);
    });

    test("returns false for non-agent paths (with TMUX unset)", async () => {
      // Save and clear TMUX to prevent tmux session detection
      const savedTmux = process.env.TMUX;
      delete process.env.TMUX;
      try {
        expect(await isRunningAsAgent("/repos/proj")).toBe(false);
        expect(await isRunningAsAgent("/repos/proj/.ittybitty/agents")).toBe(false);
        expect(await isRunningAsAgent("/repos/proj/.ittybitty/archive/agent-abc/repo")).toBe(false);
      } finally {
        if (savedTmux !== undefined) process.env.TMUX = savedTmux;
      }
    });
  });

  // ── resolveGitRoot ─────────────────────────────────────────────────────

  describe("resolveGitRoot", () => {
    test("resolves a valid git repo root", async () => {
      // Use the current repo as test target
      const calls: string[][] = [];
      setSpawnRunner((cmd: string[]) => {
        calls.push(cmd);
        const cmdStr = cmd.join(" ");
        let stdout = "";
        if (cmdStr.includes("--git-common-dir")) {
          stdout = ".git";
        } else if (cmdStr.includes("--show-toplevel")) {
          stdout = "/repos/myproject";
        } else if (cmdStr.includes("--git-dir")) {
          stdout = ".git";
        }
        return {
          stdout: new Response(stdout).body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      });

      const result = await resolveGitRoot("/repos/myproject");
      expect(result).toBe("/repos/myproject");
    });

    test("resolves worktree with relative commonDir to absolute root", async () => {
      setSpawnRunner((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        let stdout = "";
        if (cmdStr.includes("--git-common-dir")) {
          // Worktree: commonDir is relative path back to main repo's .git
          stdout = "../../.git";
        } else if (cmdStr.includes("--git-dir")) {
          stdout = "/repos/myproject/.git/worktrees/my-worktree";
        }
        return {
          stdout: new Response(stdout).body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      });

      // repoPath is the worktree; "../../.git" resolves relative to it
      const result = await resolveGitRoot("/repos/myproject/worktrees/my-worktree");
      expect(result).toBe("/repos/myproject");
    });

    test("resolves worktree with absolute commonDir", async () => {
      setSpawnRunner((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        let stdout = "";
        if (cmdStr.includes("--git-common-dir")) {
          stdout = "/repos/myproject/.git";
        } else if (cmdStr.includes("--git-dir")) {
          stdout = "/repos/myproject/.git/worktrees/my-worktree";
        }
        return {
          stdout: new Response(stdout).body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        } as SpawnResult;
      });

      const result = await resolveGitRoot("/some/worktree/path");
      expect(result).toBe("/repos/myproject");
    });

    test("returns null for non-git directory", async () => {
      setSpawnRunner(() => ({
        stdout: new Response("").body!,
        stderr: new Response("fatal: not a git repository").body!,
        exited: Promise.resolve(128),
      } as SpawnResult));

      const result = await resolveGitRoot("/not/a/repo");
      expect(result).toBeNull();
    });
  });

  // ── formatTimestamp ────────────────────────────────────────────────────

  describe("formatTimestamp", () => {
    test("formats date as YYYY-MM-DD HH:MM:SS", () => {
      const ts = _formatTimestamp(new Date(2026, 2, 8, 14, 30, 45));
      expect(ts).toBe("2026-03-08 14:30:45");
    });
  });

  describe("formatArchiveTimestamp", () => {
    test("formats date as YYYYMMDD-HHMMSS", () => {
      const ts = _formatArchiveTimestamp(new Date(2026, 2, 8, 14, 30, 45));
      expect(ts).toBe("20260308-143045");
    });
  });

  // ── tmux session validation ─────────────────────────────────────────────

  describe("killAgentProcess — invalid tmux session", () => {
    test("returns false for session with shell metacharacters", async () => {
      const result = await killAgentProcess("bad;rm -rf /", {});
      expect(result).toBe(false);
    });

    test("returns false for session with spaces", async () => {
      const result = await killAgentProcess("bad session", {});
      expect(result).toBe(false);
    });

    test("returns false for empty session name", async () => {
      const result = await killAgentProcess("", {});
      expect(result).toBe(false);
    });
  });

  describe("captureTmuxOutputToFile — invalid tmux session", () => {
    test("returns false for session with shell metacharacters", async () => {
      const result = await captureTmuxOutputToFile("$(whoami)", "/tmp/test-output.log");
      expect(result).toBe(false);
    });

    test("returns false for session with backticks", async () => {
      const result = await captureTmuxOutputToFile("`id`", "/tmp/test-output.log");
      expect(result).toBe(false);
    });
  });

  describe("teardownAgent — invalid tmux session", () => {
    test("returns false for meta with invalid tmux session", async () => {
      const tmpDir = await makeTempDir();
      const agentDir = join(tmpDir, "agents", "test-agent");
      await mkdir(agentDir, { recursive: true });

      const result = await teardownAgent(
        tmpDir,
        "test-agent",
        agentDir,
        { tmux_session: "bad;inject" },
      );
      expect(result).toBe(false);

      await rm(tmpDir, { recursive: true, force: true });
    });
  });
});

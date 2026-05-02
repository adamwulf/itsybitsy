/**
 * Tests for spawned_by (spawner tracking) feature.
 * Covers: SpawnedBy validation in readAgentMeta, checkIbCommandAccess spawner access,
 * detectRole spawner context, and notifySpawner.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { readAgentMeta } from "./agents";
import type { SpawnedBy } from "./agents";
import { checkIbCommandAccess } from "./hooks/agent-path";
import { detectRole, generateInstructions } from "./hooks/session-start";
import { notifySpawner } from "./watchdog";
import type { Agent, AgentMeta } from "./agents";

// ── SpawnedBy validation in readAgentMeta ────────────────────────────────────

describe("readAgentMeta spawned_by validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-spawned-by-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("valid spawned_by is preserved", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-child1",
        spawned_by: {
          agent_id: "agent-parent1",
          repo_path: "/Users/me/repos/other-project",
        },
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.spawned_by).toBeDefined();
    expect(meta!.spawned_by!.agent_id).toBe("agent-parent1");
    expect(meta!.spawned_by!.repo_path).toBe("/Users/me/repos/other-project");
  });

  test("spawned_by null passes through (JSON null is valid absence)", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-child2",
        spawned_by: null,
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    // null in JSON skips validation and stays as-is
    expect(meta!.spawned_by).toBeNull();
  });

  test("spawned_by with missing agent_id is stripped", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-child3",
        spawned_by: { repo_path: "/some/path" },
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.spawned_by).toBeUndefined();
  });

  test("spawned_by with missing repo_path is stripped", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-child4",
        spawned_by: { agent_id: "agent-parent1" },
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.spawned_by).toBeUndefined();
  });

  test("spawned_by with wrong types is stripped", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-child5",
        spawned_by: { agent_id: 123, repo_path: true },
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.spawned_by).toBeUndefined();
  });

  test("spawned_by as non-object is stripped", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-child6",
        spawned_by: "agent-parent1",
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.spawned_by).toBeUndefined();
  });

  test("spawned_by as array is stripped", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-child7",
        spawned_by: ["agent-parent1", "/some/path"],
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.spawned_by).toBeUndefined();
  });

  test("absent spawned_by results in undefined", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({ id: "agent-child8" })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.spawned_by).toBeUndefined();
  });

  test("@system sentinel with null repo_path is preserved", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-childA",
        spawned_by: {
          agent_id: "@system",
          repo_path: null,
        },
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.spawned_by).toBeDefined();
    expect(meta!.spawned_by!.agent_id).toBe("@system");
    expect(meta!.spawned_by!.repo_path).toBeNull();
  });

  test("@<repo-name> sentinel with string repo_path is preserved", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-childB",
        spawned_by: {
          agent_id: "@myrepo",
          repo_path: "/Users/me/repos/myrepo",
        },
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.spawned_by!.agent_id).toBe("@myrepo");
    expect(meta!.spawned_by!.repo_path).toBe("/Users/me/repos/myrepo");
  });
});

// ── checkIbCommandAccess with spawned_by ─────────────────────────────────────

describe("checkIbCommandAccess spawned_by", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ib-test-spawner-access-"));
    agentsDir = join(tmpDir, ".ittybitty", "agents");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeAgentMeta(id: string, meta: object): Promise<void> {
    const agentDir = join(agentsDir, id);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
  }

  test("allows kill when caller is spawned_by.agent_id with matching repo_path", async () => {
    await writeAgentMeta("agent-target1", {
      id: "agent-target1",
      manager: null,
      spawned_by: {
        agent_id: "agent-spawner1",
        repo_path: tmpDir,
      },
    });
    const result = await checkIbCommandAccess("ib kill agent-target1", "agent-spawner1", agentsDir);
    expect(result).toBeNull(); // allowed
  });

  test("denies kill when caller is spawned_by.agent_id but repo_path doesn't match", async () => {
    await writeAgentMeta("agent-target2", {
      id: "agent-target2",
      manager: null,
      spawned_by: {
        agent_id: "agent-spawner2",
        repo_path: "/some/other/repo",
      },
    });
    const result = await checkIbCommandAccess("ib kill agent-target2", "agent-spawner2", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("allows kill when caller is manager even with different spawned_by", async () => {
    await writeAgentMeta("agent-target3", {
      id: "agent-target3",
      manager: "agent-manager3",
      spawned_by: {
        agent_id: "agent-other",
        repo_path: "/other/repo",
      },
    });
    const result = await checkIbCommandAccess("ib kill agent-target3", "agent-manager3", agentsDir);
    expect(result).toBeNull(); // allowed via manager path
  });

  test("allows merge via spawned_by", async () => {
    await writeAgentMeta("agent-target4", {
      id: "agent-target4",
      manager: null,
      spawned_by: {
        agent_id: "agent-spawner4",
        repo_path: tmpDir,
      },
    });
    const result = await checkIbCommandAccess("ib merge agent-target4 --force", "agent-spawner4", agentsDir);
    expect(result).toBeNull();
  });

  test("allows resume via spawned_by", async () => {
    await writeAgentMeta("agent-target5", {
      id: "agent-target5",
      manager: null,
      spawned_by: {
        agent_id: "agent-spawner5",
        repo_path: tmpDir,
      },
    });
    const result = await checkIbCommandAccess("ib resume agent-target5", "agent-spawner5", agentsDir);
    expect(result).toBeNull();
  });

  test("denies when neither manager nor spawner", async () => {
    await writeAgentMeta("agent-target6", {
      id: "agent-target6",
      manager: "agent-manager6",
      spawned_by: {
        agent_id: "agent-spawner6",
        repo_path: "/some/repo",
      },
    });
    const result = await checkIbCommandAccess("ib kill agent-target6", "agent-intruder", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  // ── @<repo-name> sentinel access checks ──────────────────────────────────
  // Per-repo coordinators are stamped as `@<basename>` in spawned_by. The
  // hasAccess path must grant the actual coordinator (whose ID is the
  // basename and meta.coordinator===true) and deny everyone else.

  // We use `ib merge` for these tests instead of `ib kill` because the
  // per-repo coordinator bypass (SPEC §12.2) lets any same-repo coordinator
  // kill/reassign any non-coordinator agent — which would mask whether the
  // @<repo-name> hasAccess branch is doing the work. `merge` exercises only
  // the manager/spawner paths.

  test("@<repo-name> sentinel: ALLOWS merge when caller is the per-repo coordinator", async () => {
    const repoName = require("path").basename(tmpDir);
    await writeAgentMeta(repoName, {
      id: repoName,
      coordinator: true,
      manager: null,
    });
    await writeAgentMeta("agent-targetA", {
      id: "agent-targetA",
      manager: null,
      spawned_by: {
        agent_id: `@${repoName}`,
        repo_path: tmpDir,
      },
    });
    const result = await checkIbCommandAccess("ib merge agent-targetA --force", repoName, agentsDir);
    expect(result).toBeNull(); // allowed via @<repo-name> coordinator-spawner path
  });

  test("@<repo-name> sentinel: DENIES merge when caller is not flagged as coordinator", async () => {
    const repoName = require("path").basename(tmpDir);
    await writeAgentMeta(repoName, {
      id: repoName,
      coordinator: false,
      manager: null,
    });
    await writeAgentMeta("agent-targetB", {
      id: "agent-targetB",
      manager: null,
      spawned_by: {
        agent_id: `@${repoName}`,
        repo_path: tmpDir,
      },
    });
    const result = await checkIbCommandAccess("ib merge agent-targetB --force", repoName, agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("@<repo-name> sentinel: DENIES merge when caller's ID does not match the sentinel suffix", async () => {
    const repoName = require("path").basename(tmpDir);
    await writeAgentMeta("not-the-repo", {
      id: "not-the-repo",
      coordinator: true,
      manager: null,
    });
    await writeAgentMeta("agent-targetC", {
      id: "agent-targetC",
      manager: null,
      spawned_by: {
        agent_id: `@${repoName}`,
        repo_path: tmpDir,
      },
    });
    const result = await checkIbCommandAccess("ib merge agent-targetC --force", "not-the-repo", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("@<repo-name> sentinel: DENIES merge when repo_path doesn't match caller's repo", async () => {
    const repoName = require("path").basename(tmpDir);
    await writeAgentMeta(repoName, {
      id: repoName,
      coordinator: true,
      manager: null,
    });
    await writeAgentMeta("agent-targetD", {
      id: "agent-targetD",
      manager: null,
      spawned_by: {
        agent_id: `@${repoName}`,
        repo_path: "/some/other/repo",
      },
    });
    const result = await checkIbCommandAccess("ib merge agent-targetD --force", repoName, agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("@system sentinel: DENIES merge — @system is never a same-agent access grant", async () => {
    await writeAgentMeta("system-impersonator", {
      id: "system-impersonator",
      coordinator: true,
      manager: null,
    });
    await writeAgentMeta("agent-targetE", {
      id: "agent-targetE",
      manager: null,
      spawned_by: {
        agent_id: "@system",
        repo_path: null,
      },
    });
    const result = await checkIbCommandAccess("ib merge agent-targetE --force", "system-impersonator", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });
});

// ── detectRole spawned_by context ────────────────────────────────────────────

describe("detectRole spawned_by", () => {
  test("sets spawnedBy when spawned_by differs from manager", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-child1/repo";
    const ctx = detectRole(cwd, {
      id: "agent-child1",
      manager: "agent-manager1",
      worker: false,
      spawned_by: {
        agent_id: "agent-cross-repo-spawner",
        repo_path: "/Users/me/repos/other-project",
      },
    });
    expect(ctx.spawnedBy).toBeDefined();
    expect(ctx.spawnedBy!.agent_id).toBe("agent-cross-repo-spawner");
    expect(ctx.spawnedBy!.repo_path).toBe("/Users/me/repos/other-project");
  });

  test("does NOT set spawnedBy when spawned_by matches manager", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-child2/repo";
    const ctx = detectRole(cwd, {
      id: "agent-child2",
      manager: "agent-manager2",
      worker: false,
      spawned_by: {
        agent_id: "agent-manager2",
        repo_path: "/Users/me/project",
      },
    });
    expect(ctx.spawnedBy).toBeUndefined();
  });

  test("does NOT set spawnedBy when spawned_by is absent", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-child3/repo";
    const ctx = detectRole(cwd, {
      id: "agent-child3",
      manager: "agent-manager3",
      worker: false,
    });
    expect(ctx.spawnedBy).toBeUndefined();
  });

  test("sets spawnedBy for manager with no manager field", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-child4/repo";
    const ctx = detectRole(cwd, {
      id: "agent-child4",
      manager: null,
      worker: false,
      spawned_by: {
        agent_id: "agent-cross-spawner",
        repo_path: "/Users/me/repos/other",
      },
    });
    expect(ctx.spawnedBy).toBeDefined();
    expect(ctx.spawnedBy!.agent_id).toBe("agent-cross-spawner");
  });
});

// ── generateInstructions includes spawner info ───────────────────────────────

describe("generateInstructions spawner info", () => {
  test("manager instructions include spawner info when spawnedBy is set", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-child1/repo";
    const ctx = detectRole(cwd, {
      id: "agent-child1",
      manager: "agent-manager1",
      worker: false,
      spawned_by: {
        agent_id: "agent-cross-repo-spawner",
        repo_path: "/Users/me/repos/other-project",
      },
    });
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("agent-cross-repo-spawner");
    expect(instructions).toContain("other-project");
    expect(instructions).toContain("ib send agent-cross-repo-spawner");
  });

  test("worker instructions include spawner info when spawnedBy is set", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-child2/repo";
    const ctx = detectRole(cwd, {
      id: "agent-child2",
      manager: "agent-manager2",
      worker: true,
      spawned_by: {
        agent_id: "agent-cross-spawner",
        repo_path: "/Users/me/repos/other",
      },
    });
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("agent-cross-spawner");
    expect(instructions).toContain("other");
    expect(instructions).toContain("ib send agent-cross-spawner");
  });

  test("manager instructions do NOT include spawner info when spawnedBy matches manager", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-child3/repo";
    const ctx = detectRole(cwd, {
      id: "agent-child3",
      manager: "agent-manager3",
      worker: false,
      spawned_by: {
        agent_id: "agent-manager3",
        repo_path: "/Users/me/project",
      },
    });
    const instructions = await generateInstructions(ctx);
    // Should not contain "spawned by" since spawner == manager
    expect(instructions).not.toContain("You were spawned by");
  });
});

// ── notifySpawner ────────────────────────────────────────────────────────────

describe("notifySpawner", () => {
  function makeAgent(id: string, meta: Partial<AgentMeta>): Agent {
    return {
      id,
      meta: {
        id,
        session_id: "",
        tmux_session: `tmux-${id}`,
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: true,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "",
        ...meta,
      },
      repoPath: "/tmp/test-repo",
      repoName: "test-repo",
      children: [],
      archived: false,
      state: "unknown",
      age: "0s",
    };
  }

  test("returns false when agent has no spawned_by", async () => {
    const agent = makeAgent("agent-child1", {});
    const result = await notifySpawner(agent, "test message", []);
    expect(result).toBe(false);
  });

  test("returns false when spawner.agent_id matches manager (avoids double-notify)", async () => {
    const agent = makeAgent("agent-child2", {
      manager: "agent-manager1",
      spawned_by: {
        agent_id: "agent-manager1",
        repo_path: "/tmp/test-repo",
      },
    });
    const result = await notifySpawner(agent, "test message", []);
    expect(result).toBe(false);
  });

  test("returns false when spawner agent is not found in allAgents", async () => {
    const agent = makeAgent("agent-child3", {
      manager: null,
      spawned_by: {
        agent_id: "agent-gone",
        repo_path: "/tmp/other-repo",
      },
    });
    const result = await notifySpawner(agent, "test message", []);
    expect(result).toBe(false);
  });
});

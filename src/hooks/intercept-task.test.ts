import { test, expect, describe } from "bun:test";
import { processTaskIntercept } from "./intercept-task";

describe("intercept-task", () => {
  test("skip non-Task/Agent tool", async () => {
    const result = await processTaskIntercept({
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: "/some/path",
    });
    expect(result.action).toBe("skip");
  });

  test("intercepts Agent tool like Task tool", async () => {
    const result = await processTaskIntercept(
      {
        tool_name: "Agent",
        tool_input: {
          prompt: "implement feature X",
          description: "feature X",
          subagent_type: "general-purpose",
        },
        cwd: "/some/repo",
      },
      {
        spawnAgent: async () => ({
          ok: true,
          stdout: "Created agent-deadbeef02 in worktree",
          stderr: "",
        }),
      }
    );

    expect(result.action).toBe("intercept");
    expect(result.spawnedAgentId).toBe("agent-deadbeef02");
  });

  test("deny worker agent from spawning sub-agents", async () => {
    // Create a temp directory simulating an agent worktree with worker meta
    const tmpDir = await import("fs/promises").then((fs) =>
      fs.mkdtemp("/tmp/ib-test-worker-")
    );
    const { join } = await import("path");
    const { mkdir } = await import("fs/promises");
    const agentId = "agent-abc12345";
    const agentDir = join(tmpDir, ".ittybitty", "agents", agentId);
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: agentId, worker: true, manager: "agent-parent" })
    );

    const cwd = join(agentDir, "repo");
    const result = await processTaskIntercept({
      tool_name: "Task",
      tool_input: { prompt: "do stuff", description: "stuff" },
      cwd,
    });
    expect(result.action).toBe("intercept");
    const output = result.output as Record<string, unknown>;
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");
    expect(hookOutput.permissionDecisionReason).toContain("Workers cannot create tasks");

    // Cleanup
    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("deny worker agent from using TaskCreate", async () => {
    const tmpDir = await import("fs/promises").then((fs) =>
      fs.mkdtemp("/tmp/ib-test-worker-taskcreate-")
    );
    const { join } = await import("path");
    const { mkdir } = await import("fs/promises");
    const agentId = "agent-abc12345";
    const agentDir = join(tmpDir, ".ittybitty", "agents", agentId);
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: agentId, worker: true, manager: "agent-parent" })
    );

    const cwd = join(agentDir, "repo");
    const result = await processTaskIntercept({
      tool_name: "TaskCreate",
      tool_input: { prompt: "track progress" },
      cwd,
    });
    expect(result.action).toBe("intercept");
    const output = result.output as Record<string, unknown>;
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");

    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("intercept TaskCreate from manager and spawn ib worker", async () => {
    const result = await processTaskIntercept(
      {
        tool_name: "TaskCreate",
        tool_input: { prompt: "implement feature Y", description: "feature Y" },
        cwd: "/some/repo",
      },
      {
        spawnAgent: async () => ({
          ok: true,
          stdout: "Created agent-deadbeef03 in worktree",
          stderr: "",
        }),
      }
    );

    expect(result.action).toBe("intercept");
    expect(result.spawnedAgentId).toBe("agent-deadbeef03");
    const output = result.output as Record<string, unknown>;
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");
    expect(hookOutput.permissionDecisionReason).toContain("agent-deadbeef03");
    expect(hookOutput.permissionDecisionReason).toContain("ib look");
  });

  test("skip subagent_type in skip list", async () => {
    const skipTypes = [
      "Bash",
      "statusline-setup",
      "claude-code-guide",
      "meta-agent",
      "ib-merge",
    ];
    for (const subagentType of skipTypes) {
      const result = await processTaskIntercept({
        tool_name: "Task",
        tool_input: { subagent_type: subagentType, prompt: "do stuff" },
        cwd: "/some/path",
      });
      expect(result.action).toBe("skip");
    }
  });

  test("successful intercept with mock spawnAgent", async () => {
    const result = await processTaskIntercept(
      {
        tool_name: "Task",
        tool_input: {
          prompt: "implement feature X",
          description: "feature X",
          subagent_type: "general-purpose",
        },
        cwd: "/some/repo",
      },
      {
        spawnAgent: async () => ({
          ok: true,
          stdout: "Created agent-deadbeef01 in worktree",
          stderr: "",
        }),
      }
    );

    expect(result.action).toBe("intercept");
    expect(result.spawnedAgentId).toBe("agent-deadbeef01");
    const output = result.output as Record<string, unknown>;
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");
    expect(hookOutput.permissionDecisionReason).toContain("agent-deadbeef01");
    expect(hookOutput.permissionDecisionReason).toContain("ib look");
  });

  test("empty prompt+description → skip", async () => {
    const result = await processTaskIntercept({
      tool_name: "Task",
      tool_input: { prompt: "", description: "  " },
      cwd: "/some/path",
    });
    expect(result.action).toBe("skip");
  });

  test("invalid model sanitized", async () => {
    let capturedOpts: Record<string, unknown> = {};
    await processTaskIntercept(
      {
        tool_name: "Task",
        tool_input: {
          prompt: "do stuff",
          model: "gpt-4",
        },
        cwd: "/some/repo",
      },
      {
        spawnAgent: async (_repoPath, _prompt, spawnOpts) => {
          capturedOpts = spawnOpts;
          return {
            ok: true,
            stdout: "Created agent-aabbccdd00",
            stderr: "",
          };
        },
      }
    );
    // Invalid model should be cleared → model is undefined in spawnOpts
    expect(capturedOpts.model).toBeUndefined();
  });

  test("spawn failure → error stub", async () => {
    const result = await processTaskIntercept(
      {
        tool_name: "Task",
        tool_input: { prompt: "do stuff" },
        cwd: "/some/repo",
      },
      {
        spawnAgent: async () => ({
          ok: false,
          stdout: "",
          stderr: "Failed to create worktree",
        }),
      }
    );

    expect(result.action).toBe("intercept");
    const output = result.output as Record<string, unknown>;
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");
    expect((hookOutput.permissionDecisionReason as string)).toContain("spawn failed");
    expect((hookOutput.permissionDecisionReason as string)).toContain("Failed to create worktree");
  });
});

describe("coordinator Bash restrictions", () => {
  let tmpDir: string;
  let coordCwd: string;

  // Set up a coordinator agent directory with coordinator:true in meta.json
  async function setupCoordinatorDir() {
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    tmpDir = await fs.mkdtemp(join(tmpdir(), "intercept-coord-"));
    const agentDir = join(tmpDir, ".ittybitty", "agents", "coordinator");
    await fs.mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "coordinator", coordinator: true })
    );
    const repoDir = join(agentDir, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    coordCwd = repoDir;
    return coordCwd;
  }

  async function cleanup() {
    if (tmpDir) {
      const fs = await import("fs/promises");
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  test("blocks semicolons in coordinator Bash commands", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib list; cat /etc/passwd" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
    } finally {
      await cleanup();
    }
  });

  test("blocks && in coordinator Bash commands", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib list && cat secret.txt" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
    } finally {
      await cleanup();
    }
  });

  test("blocks pipe in coordinator Bash commands", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib list | grep secret" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
    } finally {
      await cleanup();
    }
  });

  test("blocks backticks in coordinator Bash commands", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib send agent `whoami`" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
    } finally {
      await cleanup();
    }
  });

  test("blocks $() command substitution", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib send agent $(cat /etc/passwd)" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
    } finally {
      await cleanup();
    }
  });

  test("blocks redirect > in coordinator Bash commands", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib list > /tmp/output.txt" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
    } finally {
      await cleanup();
    }
  });

  test("blocks $' ANSI-C quoting", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib list $'\\x0a'cat /etc/passwd" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
    } finally {
      await cleanup();
    }
  });

  test("blocks --output in git commands from coordinator", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "git diff --output=/tmp/secret.txt" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
    } finally {
      await cleanup();
    }
  });

  test("allows clean ib commands from coordinator", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib list" },
        cwd: coordCwd,
      });
      // Bash is not Task/Agent, so it's skipped after passing coordinator check
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows clean git commands from coordinator", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "git status" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("does not block Bash metacharacters from non-coordinator agents", async () => {
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const td = await fs.mkdtemp(join(tmpdir(), "intercept-noncoord-"));
    try {
      const agentDir = join(td, ".ittybitty", "agents", "agent-abcd1234");
      await fs.mkdir(agentDir, { recursive: true });
      await Bun.write(
        join(agentDir, "meta.json"),
        JSON.stringify({ id: "agent-abcd1234", worker: false })
      );
      const repoDir = join(agentDir, "repo");
      await fs.mkdir(repoDir, { recursive: true });

      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ls -la && echo done" },
        cwd: repoDir,
      });
      // Non-coordinator: Bash is not Task/Agent, so skip
      expect(result.action).toBe("skip");
    } finally {
      await fs.rm(td, { recursive: true, force: true });
    }
  });
});

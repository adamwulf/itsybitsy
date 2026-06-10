import { test, expect, describe, beforeEach, afterEach } from "bun:test";
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

  test("AskUserQuestion from manager agent → deny with 'ib ask' message", async () => {
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "ib-test-aq-manager-"));
    try {
      const agentId = "agent-11112222";
      const agentDir = join(tmpDir, ".ittybitty", "agents", agentId);
      await fs.mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(
        join(agentDir, "meta.json"),
        JSON.stringify({ id: agentId, worker: false })
      );

      const result = await processTaskIntercept({
        tool_name: "AskUserQuestion",
        tool_input: { question: "foo?" },
        cwd: join(agentDir, "repo"),
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
      expect(hookOutput.permissionDecisionReason).toContain("ib ask");
      expect(hookOutput.permissionDecisionReason).toContain("dashboard");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("AskUserQuestion from worker agent → deny with 'report to manager' message", async () => {
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "ib-test-aq-worker-"));
    try {
      const agentId = "agent-33334444";
      const agentDir = join(tmpDir, ".ittybitty", "agents", agentId);
      await fs.mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(
        join(agentDir, "meta.json"),
        JSON.stringify({ id: agentId, worker: true, manager: "agent-parent" })
      );

      const result = await processTaskIntercept({
        tool_name: "AskUserQuestion",
        tool_input: { question: "foo?" },
        cwd: join(agentDir, "repo"),
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
      expect(hookOutput.permissionDecisionReason).toContain("Workers cannot ask");
      expect(hookOutput.permissionDecisionReason).toContain("manager");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("AskUserQuestion from non-agent cwd → deny with manager-style message", async () => {
    const result = await processTaskIntercept({
      tool_name: "AskUserQuestion",
      tool_input: { question: "foo?" },
      cwd: "/tmp/not-an-agent",
    });
    expect(result.action).toBe("intercept");
    const output = result.output as Record<string, unknown>;
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");
    expect(hookOutput.permissionDecisionReason).toContain("ib ask");
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

  // Set up a coordinator agent directory with agentType "coordinator" in meta.json
  async function setupCoordinatorDir() {
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    tmpDir = await fs.mkdtemp(join(tmpdir(), "intercept-coord-"));
    const agentDir = join(tmpDir, ".ittybitty", "agents", "coordinator");
    await fs.mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "coordinator", agentType: "coordinator" })
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

  test("blocks git -C from coordinator", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "git -C /other/repo status" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
      expect(hookOutput.permissionDecisionReason).toContain("-C");
    } finally {
      await cleanup();
    }
  });

  test("blocks git --git-dir from coordinator", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "git --git-dir=/other/.git log" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
      expect(hookOutput.permissionDecisionReason).toContain("--git-dir");
    } finally {
      await cleanup();
    }
  });

  test("blocks git --work-tree from coordinator", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "git --work-tree /other/repo diff" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
      expect(hookOutput.permissionDecisionReason).toContain("--work-tree");
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

  // ------------------------------------------------------------------
  // Quote- and heredoc-aware guard (SPEC §12.2.4 / refinement).
  //
  // The original guard was a naive substring scan that false-positived on
  // metacharacters appearing as literal text inside a quoted argument or a
  // quoted-delimiter heredoc body. These tests pin down both directions:
  //   - The genuinely-dangerous constructs must STILL be blocked.
  //   - Literal text inside single quotes, double quotes, or a quoted
  //     heredoc body must now be ALLOWED.
  // ------------------------------------------------------------------

  // --- Cases that must remain blocked ---

  test("still blocks unquoted pipe between two commands", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib list | tee /tmp/out" },
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

  test("still blocks $() command substitution inside double quotes", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: 'ib send agent "hello $(whoami)"' },
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

  test("still blocks backtick command substitution inside double quotes", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: 'ib send agent "hello `whoami`"' },
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

  test("still blocks subshell parentheses outside quotes", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "(ib list)" },
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

  test("still blocks background ampersand outside quotes", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib list & echo done" },
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

  test("still blocks unquoted-delimiter heredoc whose body expands $()", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send agent <<EOF\n$(whoami)\nEOF",
        },
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

  test("still blocks a pipe AFTER a quoted-string argument", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib send agent 'safe text' | tee /tmp/out" },
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

  test("still blocks a pipe AFTER a heredoc opener (rest of opener line)", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send agent <<'EOF' | tee /tmp/out\nliteral body\nEOF",
        },
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

  // --- Cases that must now be allowed ---

  test("allows literal backtick inside single quotes", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send agent-abcd1234 'run the `whoami` command literally'",
        },
        cwd: coordCwd,
      });
      // Bash is not Task/Agent, so it should skip after passing the guard.
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows literal angle brackets inside single quotes (NAME placeholder)", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send agent-abcd1234 'replace <NAME> with the user name'",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows literal pipe inside single quotes", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send agent-abcd1234 'use the | character literally'",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows literal semicolon and ampersand inside single quotes", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send agent-abcd1234 'separators ; and & are fine in prose'",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows literal angle brackets and pipe inside double quotes", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: 'ib send agent-abcd1234 "use <PLACEHOLDER> | as a separator"',
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows quoted-delimiter heredoc with metacharacters in the body", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command:
            "ib send agent-abcd1234 <<'EOF'\nrun the `whoami` command and pipe | the output > somewhere; also $(do_thing)\nEOF",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows backslash-quoted heredoc delimiter (\\EOF) with metacharacters in body", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command:
            "ib send agent-abcd1234 <<\\EOF\nliteral $(stuff) and `things`\nEOF",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows literal newlines inside single quotes", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send agent-abcd1234 'line one\nline two'",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows ${VAR} parameter expansion (no command substitution)", async () => {
    await setupCoordinatorDir();
    try {
      // ${VAR} alone doesn't run a command. The original guard rejected it
      // out of caution; the refined guard allows plain parameter expansion
      // because the coordinator's environment is controlled.
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib send agent-abcd1234 ${MSG}" },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("still blocks $' ANSI-C quoting even when the rest looks safe", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib send agent $'\\x0a' literal" },
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

  // Lock-in tests for adversarial shapes flagged by review — these shapes are
  // already caught by the lexer (the `<` / `>` redirect rules and the inner
  // walk into `${…}` bodies handle them), but pinning them down prevents a
  // future refactor from quietly relaxing the wrong knob.

  test("still blocks <<<word here-string redirect", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib send agent <<<malicious" },
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

  test("still blocks process substitution <(...) and >(...)", async () => {
    await setupCoordinatorDir();
    try {
      const a = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib diff <(cat /etc/passwd)" },
        cwd: coordCwd,
      });
      expect(a.action).toBe("intercept");
      expect(
        (a.output as { hookSpecificOutput: { permissionDecision: string } })
          .hookSpecificOutput.permissionDecision
      ).toBe("deny");

      const b = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib status >(tee /tmp/sink)" },
        cwd: coordCwd,
      });
      expect(b.action).toBe("intercept");
      expect(
        (b.output as { hookSpecificOutput: { permissionDecision: string } })
          .hookSpecificOutput.permissionDecision
      ).toBe("deny");
    } finally {
      await cleanup();
    }
  });

  test("still blocks $( nested inside ${VAR:-…} parameter expansion", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send agent-abcd1234 ${MSG:-$(whoami)}",
        },
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

  // ------------------------------------------------------------------
  // Heredoc state-machine adversarial round (round 2 of review)
  //
  // Reviewer #2 surfaced HOLE-1: the newline that ended the terminator
  // line was being silently consumed, so a second command on the line
  // after `EOF` was approved as long as the second command itself had
  // no scanned metachars. Reviewer #1 surfaced two related concerns:
  // the "no following newline" path used to return null without
  // scanning the opener tail, and the `<<-` tab-stripping was too
  // permissive (stripped spaces too).
  // ------------------------------------------------------------------

  test("blocks a second command on the line AFTER a heredoc terminator", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send a <<'EOF'\nbody\nEOF\nrm -rf /tmp/x",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("intercept");
      const output = result.output as Record<string, unknown>;
      const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(hookOutput.permissionDecision).toBe("deny");
      expect(hookOutput.permissionDecisionReason).toContain("heredoc terminator");
    } finally {
      await cleanup();
    }
  });

  test("blocks a second command after EOF even when the second command has no scanned metachars", async () => {
    await setupCoordinatorDir();
    try {
      // The original HOLE-1 shape: second command is a plain word, so
      // none of the per-char metachar rules fire; only the newline-
      // after-terminator check can catch it.
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send a <<'EOF'\nbody\nEOF\nib kill agent-x",
        },
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

  test("allows a heredoc terminated by EOF at end-of-command (no trailing content)", async () => {
    await setupCoordinatorDir();
    try {
      // The new "block on trailing content" rule must NOT regress the
      // common case of a single heredoc whose terminator is the last
      // thing in the command.
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send a <<'EOF'\nbody line\nEOF",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows a heredoc whose terminator line is followed only by whitespace", async () => {
    await setupCoordinatorDir();
    try {
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send a <<'EOF'\nbody line\nEOF\n  \t\n",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("blocks `<<EOF` opener with no following newline but a `;` in the opener tail (defense-in-depth)", async () => {
    await setupCoordinatorDir();
    try {
      // No newlines anywhere — bash would error, but the guard must not
      // rely on bash to refuse it. The `;` in the opener tail must be
      // caught even though the heredoc body never opens.
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: { command: "ib send a <<EOF garbage ; rm -rf /tmp/x" },
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

  test("`<<-` strips leading TABS only — leading SPACES on terminator do NOT terminate", async () => {
    await setupCoordinatorDir();
    try {
      // With `<<-`, bash strips leading tabs from the terminator. A
      // terminator line indented with spaces does NOT terminate in bash;
      // the body continues. Our lexer must match this so it doesn't
      // approve a heredoc that bash would reject as never-terminated.
      //
      // Note: even when the lexer's terminator detection misses, the
      // overall scan reaches end-of-string still in heredoc mode and
      // returns null (an "allow"). That's fine when there's no following
      // content. We pair this with the next test where there IS a
      // post-body second command to make the requirement crisp.
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send a <<-EOF\n  EOF\n; rm -rf /tmp/x",
        },
        cwd: coordCwd,
      });
      // With proper tab-only stripping, the `  EOF` line is body data,
      // not a terminator. The body continues through `; rm -rf /tmp/x`.
      // Body is `expand=true` (bare delim), so `;` is harmless literal
      // and `rm -rf /tmp/x` has no flagged char. We end in heredoc state
      // at end-of-string → return null → ALLOW. (Bash would also error
      // out at parse time, so nothing executes.)
      //
      // This test pins down that we DON'T misidentify the spaces-prefix
      // line as a terminator, which would otherwise expose the trailing
      // `; rm -rf /tmp/x` as a normal-shell command. We assert ALLOW.
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("allows a heredoc whose body contains a line `EOF ` (trailing space, NOT a bash terminator)", async () => {
    await setupCoordinatorDir();
    try {
      // Reviewer #2 over-block: bash's terminator match is exact — a body
      // line of `EOF` followed by a space is data, not a terminator. The
      // lexer must NOT terminate on that line, otherwise the real `EOF`
      // line that follows would look like a "second command" under the
      // HOLE-1 rule and get rejected. This pins down the exact-match
      // (no trailing-whitespace tolerance) on the terminator line.
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send a <<'EOF'\nEOF \nEOF",
        },
        cwd: coordCwd,
      });
      expect(result.action).toBe("skip");
    } finally {
      await cleanup();
    }
  });

  test("`<<-` with leading TABS on the terminator does terminate (then second command is blocked)", async () => {
    await setupCoordinatorDir();
    try {
      // With `<<-`, leading TABS on the terminator are stripped. The
      // tabbed line terminates the body and the post-body `\nrm -rf …`
      // must be blocked by the new "newline after heredoc terminator"
      // rule.
      const result = await processTaskIntercept({
        tool_name: "Bash",
        tool_input: {
          command: "ib send a <<-EOF\n\tbody\n\tEOF\nrm -rf /tmp/x",
        },
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
});

describe("agent types", () => {
  test("deny agent type with canSpawnChildren=false", async () => {
    // Create a temp directory simulating an agent with a custom type that cannot spawn
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "ib-test-agenttype-"));
    try {
      const agentId = "agent-researcher123";
      const agentDir = join(tmpDir, ".ittybitty", "agents", agentId);
      await fs.mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(
        join(agentDir, "meta.json"),
        JSON.stringify({
          id: agentId,
          worker: false,
          manager: null,
          agentType: "worker", // Built-in worker type has canSpawnChildren: false
        })
      );

      const cwd = join(agentDir, "repo");
      const result = await processTaskIntercept({
        tool_name: "Task",
        tool_input: { prompt: "do stuff", description: "stuff" },
        cwd,
      });
      expect(result.action).toBe("intercept");
      expect((result.output as any).hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("intercept agent type with canSpawnChildren=true", async () => {
    // Create a temp directory simulating an agent with a custom type that can spawn
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "ib-test-agenttype-manager-"));
    try {
      const agentId = "agent-manager456";
      const agentDir = join(tmpDir, ".ittybitty", "agents", agentId);
      await fs.mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(
        join(agentDir, "meta.json"),
        JSON.stringify({
          id: agentId,
          worker: false,
          manager: null,
          agentType: "manager", // Built-in manager type has canSpawnChildren: true
        })
      );

      const cwd = join(agentDir, "repo");
      const result = await processTaskIntercept(
        {
          tool_name: "Task",
          tool_input: { prompt: "implement something", description: "something" },
          cwd,
        },
        {
          spawnAgent: async () => ({
            ok: true,
            stdout: "Created agent-def67890 in worktree",
            stderr: "",
          }),
        }
      );
      expect(result.action).toBe("intercept");
      expect(result.spawnedAgentId).toBe("agent-def67890");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("backward compat: agent with no agentType still uses meta.worker check", async () => {
    // Old-style agent without agentType field - should use meta.worker for decision
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "ib-test-oldstyle-"));
    try {
      const agentId = "agent-oldstyle";
      const agentDir = join(tmpDir, ".ittybitty", "agents", agentId);
      await fs.mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(
        join(agentDir, "meta.json"),
        JSON.stringify({
          id: agentId,
          worker: true,
          manager: "agent-parent",
          // No agentType field
        })
      );

      const cwd = join(agentDir, "repo");
      const result = await processTaskIntercept({
        tool_name: "Task",
        tool_input: { prompt: "do stuff", description: "stuff" },
        cwd,
      });
      expect(result.action).toBe("intercept");
      expect((result.output as any).hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("agentType takes precedence over meta.worker when both present", async () => {
    // If meta.worker=true but agentType says canSpawnChildren=true,
    // the agentType should win and intercept the Task call
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "ib-test-agenttype-precedence-"));
    try {
      const agentId = "agent-mixed";
      const agentDir = join(tmpDir, ".ittybitty", "agents", agentId);
      await fs.mkdir(join(agentDir, "repo"), { recursive: true });
      await Bun.write(
        join(agentDir, "meta.json"),
        JSON.stringify({
          id: agentId,
          worker: true,           // Legacy field says worker (skip intercept)
          manager: null,
          agentType: "manager",   // agentType says canSpawnChildren=true (intercept)
        })
      );

      const cwd = join(agentDir, "repo");
      const result = await processTaskIntercept(
        {
          tool_name: "Task",
          tool_input: { prompt: "do stuff", description: "stuff" },
          cwd,
        },
        {
          spawnAgent: async () => ({
            ok: true,
            stdout: "Created agent-spawned000",
            stderr: "",
          }),
        }
      );
      // agentType should take precedence: canSpawnChildren=true → intercept
      expect(result.action).toBe("intercept");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("@system caller", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let coordHome: string;

  beforeEach(async () => {
    const fs = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    originalHome = process.env.HOME;
    tempHome = await fs.mkdtemp(join(tmpdir(), "intercept-system-"));
    process.env.HOME = tempHome;
    coordHome = join(tempHome, ".itsybitsy");
    await fs.mkdir(coordHome, { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    const fs = await import("fs/promises");
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  test("blocks shell metacharacters in Bash from system coordinator", async () => {
    const result = await processTaskIntercept({
      tool_name: "Bash",
      tool_input: { command: "ib list; cat /etc/passwd" },
      cwd: coordHome,
    });
    expect(result.action).toBe("intercept");
    const output = result.output as Record<string, unknown>;
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");
    expect(hookOutput.permissionDecisionReason).toContain("shell metacharacters");
  });

  test("allows clean ib commands from system coordinator", async () => {
    const result = await processTaskIntercept({
      tool_name: "Bash",
      tool_input: { command: "ib list" },
      cwd: coordHome,
    });
    expect(result.action).toBe("skip");
  });

  test("AskUserQuestion from @system → 'use ib ask' redirect (manager-style)", async () => {
    const result = await processTaskIntercept({
      tool_name: "AskUserQuestion",
      tool_input: { question: "wat" },
      cwd: coordHome,
    });
    expect(result.action).toBe("intercept");
    const output = result.output as Record<string, unknown>;
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");
    // System coordinator is top-level; gets the manager-style 'ib ask' redirect.
    expect(hookOutput.permissionDecisionReason).toContain("ib ask");
    expect(hookOutput.permissionDecisionReason).not.toContain("Workers cannot");
  });

  test("Task from @system → explicit deny pointing at ib new-agent", async () => {
    let spawnCalled = false;
    const result = await processTaskIntercept(
      {
        tool_name: "Task",
        tool_input: { prompt: "do something", description: "x" },
        cwd: coordHome,
      },
      {
        spawnAgent: async () => {
          spawnCalled = true;
          return { ok: true, stdout: "Created agent-deadbeef99", stderr: "" };
        },
      },
    );
    expect(result.action).toBe("intercept");
    expect(spawnCalled).toBe(false);
    const output = result.output as Record<string, unknown>;
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");
    expect(hookOutput.permissionDecisionReason).toContain("ib new-agent --repo");
  });

  test("TaskCreate from @system → explicit deny", async () => {
    const result = await processTaskIntercept({
      tool_name: "TaskCreate",
      tool_input: { prompt: "track" },
      cwd: coordHome,
    });
    expect(result.action).toBe("intercept");
    const hookOutput = (result.output as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("deny");
    expect(hookOutput.permissionDecisionReason).toContain("ib new-agent --repo");
  });
});

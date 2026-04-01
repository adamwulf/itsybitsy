import { test, expect, describe } from "bun:test";
import { detectRole, generateInstructions, type SessionContext } from "./session-start";

describe("session-start", () => {
  test("detectRole non-agent cwd → primary", () => {
    const ctx = detectRole("/Users/me/project");
    expect(ctx.role).toBe("primary");
    expect(ctx.agentId).toBe("");
    expect(ctx.agentManager).toBe("");
  });

  test("detectRole manager cwd (with meta)", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    expect(ctx.role).toBe("manager");
    expect(ctx.agentId).toBe("agent-abc12345");
    expect(ctx.agentManager).toBe("");
    expect(ctx.parentBranch).toBe("main");
    expect(ctx.rootRepoPath).toBe("/Users/me/project");
    expect(ctx.worktreePath).toContain("agent-abc12345/repo");
  });

  test("detectRole worker cwd (with meta)", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-def67890/repo";
    const ctx = detectRole(cwd, {
      id: "agent-def67890",
      manager: "agent-abc12345",
      worker: true,
    });
    expect(ctx.role).toBe("worker");
    expect(ctx.agentId).toBe("agent-def67890");
    expect(ctx.agentManager).toBe("agent-abc12345");
    expect(ctx.parentBranch).toBe("agent/agent-abc12345");
  });

  test("generateInstructions primary contains 'Primary Claude'", async () => {
    const ctx = detectRole("/Users/me/project");
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("Primary Claude");
    expect(instructions).toContain("<ittybitty>");
    expect(instructions).toContain("</ittybitty>");
  });

  test("all roles include Bash Rules", async () => {
    const primaryCtx = detectRole("/Users/me/project");
    const primaryInstructions = await generateInstructions(primaryCtx);
    expect(primaryInstructions).toContain("### Bash Rules");
    expect(primaryInstructions).toContain("Each Bash tool call must run exactly ONE command");

    const managerCwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const managerCtx = detectRole(managerCwd, { id: "agent-abc12345", manager: null, worker: false });
    const managerInstructions = await generateInstructions(managerCtx);
    expect(managerInstructions).toContain("### Bash Rules");
    expect(managerInstructions).toContain("Each Bash tool call must run exactly ONE command");

    const workerCwd = "/Users/me/project/.ittybitty/agents/agent-def67890/repo";
    const workerCtx = detectRole(workerCwd, { id: "agent-def67890", manager: "agent-abc12345", worker: true });
    const workerInstructions = await generateInstructions(workerCtx);
    expect(workerInstructions).toContain("### Bash Rules");
    expect(workerInstructions).toContain("Each Bash tool call must run exactly ONE command");
  });

  test("generateInstructions manager contains agent ID", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("agent-abc12345");
    expect(instructions).toContain("Manager Agent");
    expect(instructions).toContain("ib new-agent --worker");
  });

  test("generateInstructions worker contains manager ID", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-def67890/repo";
    const ctx = detectRole(cwd, {
      id: "agent-def67890",
      manager: "agent-abc12345",
      worker: true,
    });
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("agent-abc12345");
    expect(instructions).toContain("Worker Agent");
    expect(instructions).toContain("ib send agent-abc12345");
  });

  test("top-level manager has 'ib ask'", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("ib ask");
    expect(instructions).toContain("Asking the User Questions");
  });

  test("sub-manager (has manager) no 'ib ask'", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-sub11111/repo";
    const ctx = detectRole(cwd, {
      id: "agent-sub11111",
      manager: "agent-parent00",
      worker: false,
    });
    const instructions = await generateInstructions(ctx);
    expect(instructions).not.toContain("ib ask");
    expect(instructions).not.toContain("Asking the User Questions");
    expect(instructions).toContain("Your manager agent is: agent-parent00");
  });

  test("manager: 'null' string treated as no manager", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: "null" as unknown as string,
      worker: false,
    });
    expect(ctx.agentManager).toBe("");
    expect(ctx.parentBranch).toBe("main");
  });

  test("detectRole coordinator cwd (with meta)", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/coordinator/repo";
    const ctx = detectRole(cwd, {
      id: "coordinator",
      manager: null,
      worker: false,
      coordinator: true,
    });
    expect(ctx.role).toBe("coordinator");
    expect(ctx.agentId).toBe("coordinator");
    expect(ctx.agentManager).toBe("");
    expect(ctx.parentBranch).toBe("main");
    expect(ctx.rootRepoPath).toBe("/Users/me/project");
  });

  test("generateInstructions coordinator contains 'Per-Repo Coordinator'", async () => {
    // Build context directly to test generateInstructions independently
    const ctx: SessionContext = {
      role: "coordinator",
      agentId: "coordinator",
      agentManager: "",
      parentBranch: "main",
      worktreePath: "/Users/me/project/.ittybitty/agents/coordinator/repo",
      rootRepoPath: "/Users/me/project",
    };
    const instructions = await generateInstructions(ctx);
    expect(instructions).not.toContain("Primary Claude");
    expect(instructions).toContain("Per-Repo Coordinator");
    expect(instructions).toContain("project");
    expect(instructions).toContain("ib new-agent --worker");
    expect(instructions).toContain("ib send coordinator");
  });

  test("coordinator instructions mention Read, Glob, Grep, LS", async () => {
    const ctx: SessionContext = {
      role: "coordinator",
      agentId: "coordinator",
      agentManager: "",
      parentBranch: "main",
      worktreePath: "/Users/me/muse-ios/.ittybitty/agents/coordinator/repo",
      rootRepoPath: "/Users/me/muse-ios",
    };
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("Read");
    expect(instructions).toContain("Glob");
    expect(instructions).toContain("Grep");
    expect(instructions).toContain("LS");
  });

  test("worker under coordinator uses repo basename for messaging (SPEC §12.2.6)", async () => {
    const cwd = "/Users/me/muse-ios/.ittybitty/agents/agent-abc12345/repo";
    // After the rename, per-repo coordinators are named by repo basename,
    // so the worker's manager field is "muse-ios" (not "coordinator").
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: "muse-ios",
      worker: true,
    });
    expect(ctx.role).toBe("worker");
    expect(ctx.agentManager).toBe("muse-ios");
    const instructions = await generateInstructions(ctx);
    // Worker should send to manager using the repo basename
    expect(instructions).toContain('ib send muse-ios "msg"');
    expect(instructions).toContain('ib send muse-ios "message"');
  });

  test("detectRole with type field returns custom role", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: "agent-parent00",
      worker: false,
      type: "reviewer",
    });
    expect(ctx.role).toBe("custom");
    expect(ctx.typeName).toBe("reviewer");
    expect(ctx.agentManager).toBe("agent-parent00");
  });

  test("detectRole with type='worker' returns worker role", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: "agent-parent00",
      worker: false,
      type: "worker",
    });
    expect(ctx.role).toBe("worker");
    expect(ctx.typeName).toBe("worker");
  });

  test("detectRole with type='manager' returns manager role", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
      type: "manager",
    });
    expect(ctx.role).toBe("manager");
    expect(ctx.typeName).toBe("manager");
  });

  test("detectRole with type='coordinator' returns coordinator role", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
      type: "coordinator",
    });
    expect(ctx.role).toBe("coordinator");
    expect(ctx.typeName).toBe("coordinator");
  });

  test("backward compat: no type field generates manager instructions", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    expect(ctx.role).toBe("manager");
    expect(ctx.typeName).toBeUndefined();
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("Manager Agent");
  });

  test("backward compat: worker meta still generates worker instructions", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-def67890/repo";
    const ctx = detectRole(cwd, {
      id: "agent-def67890",
      manager: "agent-abc12345",
      worker: true,
    });
    expect(ctx.role).toBe("worker");
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("Worker Agent");
  });

  test("custom type generates custom instructions with common sections", async () => {
    // This test verifies the custom type fallback to manager when type can't be resolved
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: "agent-parent00",
      worker: false,
      type: "nonexistent-type-for-test",
    });
    expect(ctx.role).toBe("custom");
    // When type can't be resolved, should fall back to manager instructions
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("Manager Agent");
  });
});

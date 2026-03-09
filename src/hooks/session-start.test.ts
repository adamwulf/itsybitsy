import { test, expect, describe } from "bun:test";
import { detectRole, generateInstructions } from "./session-start";

describe("session-start", () => {
  test("detectRole non-agent cwd → primary", () => {
    const ctx = detectRole("/Users/me/project");
    expect(ctx.role).toBe("primary");
    expect(ctx.agentId).toBe("");
    expect(ctx.agentManager).toBe("");
  });

  test("detectRole manager cwd (with meta)", () => {
    const cwd = "/Users/me/project/.ittybitsy/agents/agent-abc12345/repo";
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
    const cwd = "/Users/me/project/.ittybitsy/agents/agent-def67890/repo";
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

  test("generateInstructions primary contains 'Primary Claude'", () => {
    const ctx = detectRole("/Users/me/project");
    const instructions = generateInstructions(ctx);
    expect(instructions).toContain("Primary Claude");
    expect(instructions).toContain("<ittybitty>");
    expect(instructions).toContain("</ittybitty>");
  });

  test("generateInstructions manager contains agent ID", () => {
    const cwd = "/Users/me/project/.ittybitsy/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    const instructions = generateInstructions(ctx);
    expect(instructions).toContain("agent-abc12345");
    expect(instructions).toContain("Manager Agent");
    expect(instructions).toContain("ib new-agent --worker");
  });

  test("generateInstructions worker contains manager ID", () => {
    const cwd = "/Users/me/project/.ittybitsy/agents/agent-def67890/repo";
    const ctx = detectRole(cwd, {
      id: "agent-def67890",
      manager: "agent-abc12345",
      worker: true,
    });
    const instructions = generateInstructions(ctx);
    expect(instructions).toContain("agent-abc12345");
    expect(instructions).toContain("Worker Agent");
    expect(instructions).toContain("ib send agent-abc12345");
  });

  test("top-level manager has 'ib ask'", () => {
    const cwd = "/Users/me/project/.ittybitsy/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    const instructions = generateInstructions(ctx);
    expect(instructions).toContain("ib ask");
    expect(instructions).toContain("Asking the User Questions");
  });

  test("sub-manager (has manager) no 'ib ask'", () => {
    const cwd = "/Users/me/project/.ittybitsy/agents/agent-sub11111/repo";
    const ctx = detectRole(cwd, {
      id: "agent-sub11111",
      manager: "agent-parent00",
      worker: false,
    });
    const instructions = generateInstructions(ctx);
    expect(instructions).not.toContain("ib ask");
    expect(instructions).not.toContain("Asking the User Questions");
    expect(instructions).toContain("Your manager agent is: agent-parent00");
  });
});

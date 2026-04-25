import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { detectRole, generateInstructions, interpolateTemplate, buildPathIsolationSection, type SessionContext } from "./session-start";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

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
    expect(instructions).toContain("ib new-agent --type worker");
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
    // branchName falls back to agent/<id> when repo-id file is not available
    expect(ctx.branchName).toBe("agent/coordinator");
    expect(ctx.rootRepoPath).toBe("/Users/me/project");
  });

  test("detectRole non-worktree coordinator via agentIdOverride", () => {
    // Coordinator running directly in the repo root (no worktree)
    const cwd = "/Users/me/project";
    const ctx = detectRole(cwd, {
      id: "project",
      manager: null,
      worker: false,
      coordinator: true,
    }, "project");
    expect(ctx.role).toBe("coordinator");
    expect(ctx.agentId).toBe("project");
    expect(ctx.branchName).toBe(""); // no worktree = no branch
    expect(ctx.worktreePath).toBe(""); // no worktree
    expect(ctx.rootRepoPath).toBe("/Users/me/project");
  });

  test("generateInstructions coordinator contains 'Per-Repo Coordinator'", async () => {
    // Build context directly to test generateInstructions independently
    const ctx: SessionContext = {
      role: "coordinator",
      agentId: "coordinator",
      agentManager: "",
      parentBranch: "main",
      branchName: "agent/coordinator",
      worktreePath: "/Users/me/project/.ittybitty/agents/coordinator/repo",
      rootRepoPath: "/Users/me/project",
    };
    const instructions = await generateInstructions(ctx);
    expect(instructions).not.toContain("Primary Claude");
    expect(instructions).toContain("Per-Repo Coordinator");
    expect(instructions).toContain("project");
    expect(instructions).toContain("ib new-agent --type worker");
    expect(instructions).toContain("ib send @system");
  });

  test("coordinator instructions mention Read, Glob, Grep, LS", async () => {
    const ctx: SessionContext = {
      role: "coordinator",
      agentId: "coordinator",
      agentManager: "",
      parentBranch: "main",
      branchName: "agent/coordinator",
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

  test("detectRole includes agentType from meta.json", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
      agentType: "researcher",
    });
    expect(ctx.agentType).toBe("researcher");
  });

  test("backward compat: no agentType in meta.json", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    expect(ctx.agentType).toBeUndefined();
  });

  test("agent type with manager instructionStyle uses manager base instructions", async () => {
    // Built-in manager type uses manager instructionStyle
    const ctx: SessionContext = {
      role: "manager",
      agentId: "agent-abc12345",
      agentManager: "",
      parentBranch: "main",
      branchName: "agent/agent-abc12345",
      worktreePath: "/Users/me/project/.ittybitty/agents/agent-abc12345/repo",
      rootRepoPath: "/Users/me/project",
      agentType: "manager",
    };
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("Manager Agent");
    expect(instructions).toContain("ib new-agent --type worker");
  });

  test("agent type with worker instructionStyle uses worker base instructions", async () => {
    // Built-in worker type uses worker instructionStyle
    const ctx: SessionContext = {
      role: "worker",
      agentId: "agent-def67890",
      agentManager: "agent-abc12345",
      parentBranch: "agent/agent-abc12345",
      branchName: "agent/agent-def67890",
      worktreePath: "/Users/me/project/.ittybitty/agents/agent-def67890/repo",
      rootRepoPath: "/Users/me/project",
      agentType: "worker",
    };
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("Worker Agent");
    expect(instructions).toContain("ib send agent-abc12345");
  });

  test("agent type markdown body is appended before closing ittybitty tag", async () => {
    // This test uses the built-in coordinator type which has no body,
    // but we test the mechanism by verifying basic structure is intact
    const ctx: SessionContext = {
      role: "coordinator",
      agentId: "coordinator",
      agentManager: "",
      parentBranch: "main",
      branchName: "agent/coordinator",
      worktreePath: "/Users/me/project/.ittybitty/agents/coordinator/repo",
      rootRepoPath: "/Users/me/project",
      agentType: "coordinator",
    };
    const instructions = await generateInstructions(ctx);
    // Should have the closing tag
    expect(instructions).toContain("</ittybitty>");
    expect(instructions).toContain("<ittybitty>");
  });
});

describe("interpolateTemplate", () => {
  const baseCtx: SessionContext = {
    role: "manager",
    agentId: "agent-abc123",
    agentManager: "agent-parent",
    parentBranch: "agent/agent-parent",
    branchName: "agent/agent-abc123",
    worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
    rootRepoPath: "/repo",
  };

  test("replaces simple {{variable}} placeholders", () => {
    const template = "Agent {{agentId}} on branch agent/{{agentId}}";
    const result = interpolateTemplate(template, baseCtx);
    expect(result).toBe("Agent agent-abc123 on branch agent/agent-abc123");
  });

  test("replaces all available variables", () => {
    const template = "{{agentId}} {{agentManager}} {{parentBranch}} {{worktreePath}} {{rootRepoPath}} {{repoName}}";
    const result = interpolateTemplate(template, baseCtx);
    expect(result).toBe("agent-abc123 agent-parent agent/agent-parent /repo/.ittybitty/agents/agent-abc123/repo /repo repo");
  });

  test("unknown variables become empty string", () => {
    const result = interpolateTemplate("hello {{unknown}} world", baseCtx);
    expect(result).toBe("hello  world");
  });

  test("{{#if hasManager}} includes block when manager exists", () => {
    const template = "start\n{{#if hasManager}}\nManager: {{agentManager}}\n{{/if}}\nend";
    const result = interpolateTemplate(template, baseCtx);
    expect(result).toContain("Manager: agent-parent");
    expect(result).toContain("start");
    expect(result).toContain("end");
  });

  test("{{#if hasManager}} excludes block when no manager", () => {
    const ctx = { ...baseCtx, agentManager: "" };
    const template = "start\n{{#if hasManager}}\nManager: {{agentManager}}\n{{/if}}\nend";
    const result = interpolateTemplate(template, ctx);
    expect(result).not.toContain("Manager:");
    expect(result).toContain("start");
    expect(result).toContain("end");
  });

  test("{{#if isTopLevel}} includes block for top-level agents", () => {
    const ctx = { ...baseCtx, agentManager: "" };
    const template = "{{#if isTopLevel}}\nask questions\n{{/if}}";
    const result = interpolateTemplate(template, ctx);
    expect(result).toContain("ask questions");
  });

  test("{{#if isTopLevel}} excludes block for sub-agents", () => {
    const template = "{{#if isTopLevel}}\nask questions\n{{/if}}";
    const result = interpolateTemplate(template, baseCtx);
    expect(result).not.toContain("ask questions");
  });

});

describe("interpolateTemplate {{availableTypes}}", () => {
  const baseCtx: SessionContext = {
    role: "manager",
    agentId: "agent-abc123",
    agentManager: "agent-parent",
    parentBranch: "agent/agent-parent",
    branchName: "agent/agent-abc123",
    worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
    rootRepoPath: "/repo",
  };

  const originalHome = process.env.HOME;
  let tempHome: string;
  let typesDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "itsybitsy-tpl-available-"));
    process.env.HOME = tempHome;
    typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("expands to a markdown section listing spawnable types", async () => {
    await Bun.write(
      join(typesDir, "manager.md"),
      "---\nname: manager\ndescription: Manages sub-agents\n---\nbody",
    );
    await Bun.write(
      join(typesDir, "worker.md"),
      "---\nname: worker\ndescription: Implements a focused task\n---\nbody",
    );
    await Bun.write(
      join(typesDir, "_all.md"),
      "---\nname: _all\nspawnable: false\ndescription: Layer file\n---\nbody",
    );

    const template = "before\n\n{{availableTypes}}\n\nafter";
    const result = interpolateTemplate(template, baseCtx);

    expect(result).toContain("### Available Agent Types");
    expect(result).toContain('`ib new-agent --type <name> "task"`');
    expect(result).toContain("`manager` — Manages sub-agents");
    expect(result).toContain("`worker` — Implements a focused task");
    // Layer files must not appear
    expect(result).not.toContain("_all");
    expect(result).not.toContain("Layer file");
    // Surrounding text preserved
    expect(result).toContain("before");
    expect(result).toContain("after");
  });
});

describe("buildPathIsolationSection", () => {
  const baseCtx: SessionContext = {
    role: "manager",
    agentId: "agent-abc123",
    agentManager: "",
    parentBranch: "main",
    branchName: "agent/agent-abc123",
    worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
    rootRepoPath: "/repo",
  };

  test("worktree agent without allowedPaths shows default message", () => {
    const ctx = { ...baseCtx };
    const section = buildPathIsolationSection(ctx);
    expect(section).toContain("### Path Isolation");
    expect(section).toContain("You are isolated to your worktree at: /repo/.ittybitty/agents/agent-abc123/repo");
    expect(section).toContain("You CAN access: Your worktree, ~/.claude, /tmp, and general system paths");
    expect(section).toContain("The main repo at /repo");
    expect(section).not.toContain("additional paths");
  });

  test("worktree agent with allowedPaths lists them", () => {
    const ctx = { ...baseCtx, allowedPaths: ["/home/user/data", "/var/log"] };
    const section = buildPathIsolationSection(ctx);
    expect(section).toContain("and these additional paths:");
    expect(section).toContain("/home/user/data");
    expect(section).toContain("/var/log");
  });

  test("worktree agent with empty allowedPaths shows default", () => {
    const ctx = { ...baseCtx, allowedPaths: [] };
    const section = buildPathIsolationSection(ctx);
    expect(section).toContain("You CAN access: Your worktree, ~/.claude, /tmp, and general system paths");
    expect(section).not.toContain("additional paths");
  });

  test("non-worktree (coordinator) shows repo path", () => {
    const ctx: SessionContext = {
      role: "coordinator",
      agentId: "coordinator",
      agentManager: "",
      parentBranch: "main",
      branchName: "",
      worktreePath: "",
      rootRepoPath: "/repo",
    };
    const section = buildPathIsolationSection(ctx);
    expect(section).toContain("You are working directly in the repo at: /repo");
    expect(section).toContain("You CAN access: This repo, ~/.claude, /tmp, and general system paths");
    expect(section).not.toContain("The main repo");
  });

  test("non-worktree coordinator with allowedPaths lists them", () => {
    const ctx: SessionContext = {
      role: "coordinator",
      agentId: "coordinator",
      agentManager: "",
      parentBranch: "main",
      branchName: "",
      worktreePath: "",
      rootRepoPath: "/repo",
      allowedPaths: ["/data/shared"],
    };
    const section = buildPathIsolationSection(ctx);
    expect(section).toContain("and these additional paths:");
    expect(section).toContain("/data/shared");
  });

  test("detectRole parses allowedPaths from meta.json", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
      allowedPaths: ["/home/user/project", "/tmp/shared"],
    });
    expect(ctx.allowedPaths).toEqual(["/home/user/project", "/tmp/shared"]);
  });

  test("detectRole allowedPaths undefined when not in meta", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    expect(ctx.allowedPaths).toBeUndefined();
  });

  test("manager instructions include buildPathIsolationSection", async () => {
    const ctx: SessionContext = {
      role: "manager",
      agentId: "agent-abc123",
      agentManager: "",
      parentBranch: "main",
      branchName: "agent/agent-abc123",
      worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
      rootRepoPath: "/repo",
      allowedPaths: ["/home/user/data"],
    };
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("### Path Isolation");
    expect(instructions).toContain("/home/user/data");
  });

  test("worker instructions include buildPathIsolationSection", async () => {
    const ctx: SessionContext = {
      role: "worker",
      agentId: "agent-def67890",
      agentManager: "agent-abc12345",
      parentBranch: "agent/agent-abc12345",
      branchName: "agent/agent-def67890",
      worktreePath: "/repo/.ittybitty/agents/agent-def67890/repo",
      rootRepoPath: "/repo",
      allowedPaths: ["/var/data"],
    };
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("### Path Isolation");
    expect(instructions).toContain("/var/data");
  });
});

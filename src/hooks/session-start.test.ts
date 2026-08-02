import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { detectRole, generateInstructions, teamAwarenessBlock, interpolateTemplate, buildPathIsolationSection, hookSessionStart, type SessionContext } from "./session-start";
import { readAgentState } from "../agents";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";
import { ensureAgentTypesDir } from "../agent-types";
import { createTeam, addMember } from "../teams";

/**
 * Per-process itsybitsy home for the whole file.
 *
 * This file was not merely writing into the developer's real `~/.itsybitsy` —
 * several tests were READING it and depending on its contents. `generateInstructions`
 * calls `loadAgentType`, which resolves `manager` / `worker` / `coordinator` from
 * `$HOME/.itsybitsy/agent-types/<name>.md`. Four tests here therefore asserted
 * against whatever type files this particular machine happens to have, including
 * any local edits, and would fail outright on a machine that had never run
 * `ib init-types`. Redirecting HOME alone proves it: 51 pass / 4 fail.
 *
 * So the isolated home is seeded with the EMBEDDED stock type files via
 * `ensureAgentTypesDir()` — the same content `ib init-types` writes. That keeps
 * all four tests running with no assertion changed, and makes them hermetic:
 * they now exercise the types this repo ships rather than the ones this laptop
 * has lying around.
 *
 * `process.env.HOME` is the half that matters most here, because both
 * `agent-types.ts` and `hooks/shared.ts` read it directly and neither honors the
 * `setCoordinatorHome` override. `setCoordinatorHome` is set alongside it so the
 * outbox/teams paths resolve into the same tree instead of the real one.
 */
let testHome: string;
let realHome: string | undefined;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), "ib-session-start-home-"));
  realHome = process.env.HOME;
  process.env.HOME = testHome;
  setCoordinatorHome(join(testHome, ".itsybitsy"));
  // Populate <testHome>/.itsybitsy/agent-types/ with the embedded defaults.
  // Reads process.env.HOME at call time, so it lands in the isolated home.
  await ensureAgentTypesDir();
});

afterAll(() => {
  resetCoordinatorHome();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(testHome, { recursive: true, force: true });
});

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
      agentType: "coordinator",
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
      agentType: "coordinator",
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

  test("manager State Management warns against sleep/Monitor/poll loops (SPEC §8.5)", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("Manager Agent");
    expect(instructions).toContain("don't \`sleep\`, run \`Monitor\`, or write a \`while\`/\`until\` polling loop to wait");
    // Manager has sub-agents → watchdog framing. Advisory, not "blocked".
    expect(instructions).toContain("the watchdog notifies you when there's something to do");
    expect(instructions).not.toContain("Those are blocked");
  });

  test("worker State Management warns against sleep/Monitor/poll loops (SPEC §8.5)", async () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-def67890/repo";
    const ctx = detectRole(cwd, {
      id: "agent-def67890",
      manager: "agent-abc12345",
      worker: true,
    });
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("Worker Agent");
    expect(instructions).toContain("don't \`sleep\`, run \`Monitor\`, or write a \`while\`/\`until\` polling loop to wait");
    // A worker has no sub-agents — it's resumed by its manager's `ib send`,
    // not its own watchdog. Framing must reference the manager (ISSUE 5).
    expect(instructions).toContain("your manager will message you when there's something to do");
    expect(instructions).not.toContain("Those are blocked");
  });

  test("coordinator State Management warns against sleep/Monitor/poll loops (SPEC §8.5)", async () => {
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
    expect(instructions).toContain("Per-Repo Coordinator");
    expect(instructions).toContain("don't \`sleep\`, run \`Monitor\`, or write a \`while\`/\`until\` polling loop to wait");
    // Coordinator has sub-agents → watchdog framing. Advisory, not "blocked".
    expect(instructions).toContain("the watchdog notifies you when there's something to do");
    expect(instructions).not.toContain("Those are blocked");
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

  let tempHome: string;
  let typesDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "itsybitsy-tpl-available-"));
    process.env.HOME = tempHome;
    typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
  });

  afterEach(async () => {
    // Restore the file-wide isolated home, NOT a `const originalHome` captured
    // in the describe body. That capture ran at module-load time, before
    // `beforeAll` installed the override, so it held the developer's REAL home —
    // restoring it here handed every later test in this file back to the real
    // ~/.itsybitsy and quietly defeated the isolation.
    process.env.HOME = testHome;
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

  test("templates without {{availableTypes}} render unaffected when agent-types dir is empty", () => {
    // HOME points at a tempdir whose agent-types directory exists but is empty.
    // Eagerly invoking buildAvailableTypesSection would still succeed (the
    // empty-types fallback message would be produced), but the rendered
    // template shouldn't contain it because the placeholder isn't referenced.
    const template = "{{agentId}} on {{parentBranch}}";
    const result = interpolateTemplate(template, baseCtx);
    expect(result).toBe("agent-abc123 on agent/agent-parent");
    expect(result).not.toContain("Available Agent Types");
  });

  test("multiple {{availableTypes}} placeholders all expand to the same content", async () => {
    await Bun.write(
      join(typesDir, "manager.md"),
      "---\nname: manager\ndescription: Manages\n---\nbody",
    );
    const template = "{{availableTypes}}\n---\n{{availableTypes}}";
    const result = interpolateTemplate(template, baseCtx);
    const occurrences = result.split("### Available Agent Types").length - 1;
    expect(occurrences).toBe(2);
    // Both copies must list the same type
    expect(result.split("`manager` — Manages").length - 1).toBe(2);
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

describe("hookSessionStart — stale 'creating' state correction", () => {
  let tempDir: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ib-sessstart-"));
    // Silence process.stdout.write — the hook emits a JSON blob.
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((..._args: unknown[]) => true) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Build a minimal meta.json on disk and return the agentDir. */
  async function setup(metaState: string, agentId = "agent-test1"): Promise<{
    agentDir: string;
    cwd: string;
  }> {
    const agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    const cwd = join(agentDir, "repo");
    await mkdir(cwd, { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: agentId,
        manager: null,
        worker: false,
        state: metaState,
      }),
    );
    return { agentDir, cwd };
  }

  test("meta.state === 'creating' is overwritten to 'running'", async () => {
    const { agentDir, cwd } = await setup("creating");
    const stdin = JSON.stringify({ cwd });
    await hookSessionStart(stdin);
    const state = await readAgentState(agentDir);
    expect(state).toBe("running");
  });

  test("meta.state === 'waiting' is preserved (session resume)", async () => {
    const { agentDir, cwd } = await setup("waiting");
    const stdin = JSON.stringify({ cwd });
    await hookSessionStart(stdin);
    const state = await readAgentState(agentDir);
    expect(state).toBe("waiting");
  });

  test("meta.state === 'complete' is preserved (session resume)", async () => {
    const { agentDir, cwd } = await setup("complete");
    const stdin = JSON.stringify({ cwd });
    await hookSessionStart(stdin);
    const state = await readAgentState(agentDir);
    expect(state).toBe("complete");
  });

  test("meta.state === 'creating' for non-worktree agent (agentIdArg) → 'running'", async () => {
    // Coordinator-style: cwd is the repo root, agent ID passed as arg.
    const agentId = "agent-coord";
    const agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: agentId,
        manager: null,
        agentType: "coordinator",
        state: "creating",
      }),
    );
    const stdin = JSON.stringify({ cwd: tempDir });
    await hookSessionStart(stdin, agentId);
    const state = await readAgentState(agentDir);
    expect(state).toBe("running");
  });

  test("missing meta.json is a no-op (does not crash)", async () => {
    // cwd points outside any agent dir — no meta to update.
    const stdin = JSON.stringify({ cwd: tempDir });
    await hookSessionStart(stdin);
    // No exception means pass.
  });
});

describe("hookSessionStart with @system", () => {
  let captured: string;
  let originalWrite: typeof process.stdout.write;
  let tempHome: string;
  let typesDir: string;

  beforeEach(async () => {
    captured = "";
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
      return true;
    }) as typeof process.stdout.write;

    tempHome = await mkdtemp(join(tmpdir(), "itsybitsy-sys-hook-"));
    process.env.HOME = tempHome;
    typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    // Restore the file-wide isolated home — see the note on the equivalent
    // afterEach above for why a describe-body capture is the wrong target.
    process.env.HOME = testHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("injects system.md body via additionalContext, merged with _all.md, skipping _non_coordinator.md", async () => {
    // The system coordinator boots like every other agent type: the SessionStart
    // hook delivers `system.md`'s markdown body via additionalContext. `_all.md`
    // is prepended (applies to every agent); `_non_coordinator.md` is NOT
    // (the system coordinator is its own type, and that layer covers
    // commit-message etiquette and other things @system has no use for).
    await Bun.write(
      join(typesDir, "system.md"),
      "---\nname: system\ndescription: System coordinator\nspawnable: false\n---\nSYSTEM_BODY_MARKER",
    );
    await Bun.write(
      join(typesDir, "_all.md"),
      "---\nname: _all\nspawnable: false\n---\nALL_LAYER_MARKER",
    );
    await Bun.write(
      join(typesDir, "_non_coordinator.md"),
      "---\nname: _non_coordinator\nspawnable: false\n---\nNON_COORDINATOR_LAYER_MARKER",
    );

    const stdin = JSON.stringify({ cwd: "/tmp" });
    await hookSessionStart(stdin, "@system");

    const output = JSON.parse(captured);
    const ctx: string = output.hookSpecificOutput.additionalContext;
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");

    // The body is wrapped in <ittybitty>.
    expect(ctx).toContain("<ittybitty>");
    expect(ctx).toContain("</ittybitty>");

    // system.md body and _all.md content present; _non_coordinator.md absent.
    expect(ctx).toContain("SYSTEM_BODY_MARKER");
    expect(ctx).toContain("ALL_LAYER_MARKER");
    expect(ctx).not.toContain("NON_COORDINATOR_LAYER_MARKER");

    // _all.md prefix appears before system.md body.
    expect(ctx.indexOf("ALL_LAYER_MARKER")).toBeLessThan(ctx.indexOf("SYSTEM_BODY_MARKER"));
  });
});

describe("session-start team awareness (§16.6)", () => {
  // The tmp dir doubles as both HOME (so agent-types load from
  // <tmp>/.itsybitsy/agent-types) AND the coordinator home (teams.json), by
  // pointing setCoordinatorHome at <tmp>/.itsybitsy — mirrors teams.test.ts.
  let baseDir: string;
  let homeDir: string;
  let typesDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "ib-sessionstart-teams-" + crypto.randomUUID() + "-"));
    homeDir = join(baseDir, ".itsybitsy");
    typesDir = join(homeDir, "agent-types");
    await mkdir(typesDir, { recursive: true });
    process.env.HOME = baseDir;
    setCoordinatorHome(homeDir);
  });

  afterEach(async () => {
    // Hand both halves back to the file-wide isolated home rather than clearing
    // the override and restoring a module-load-time HOME capture — either one
    // would drop the remaining tests back onto the real ~/.itsybitsy.
    setCoordinatorHome(join(testHome, ".itsybitsy"));
    process.env.HOME = testHome;
    await rm(baseDir, { recursive: true, force: true });
  });

  test("teamAwarenessBlock returns '' for an agent in no team (no behavior change)", async () => {
    await createTeam("backend", "@system", 100);
    await addMember("backend", "agent-other");
    const block = await teamAwarenessBlock("agent-notamember");
    expect(block).toBe("");
  });

  test("teamAwarenessBlock returns '' when given an empty agent id", async () => {
    const block = await teamAwarenessBlock("");
    expect(block).toBe("");
  });

  test("generateInstructions for a TEAM MEMBER includes the ## Teams section with all required elements", async () => {
    await createTeam("backend", "@system", 100);
    await addMember("backend", "agent-member1");

    const cwd = "/Users/me/project/.ittybitty/agents/agent-member1/repo";
    const ctx = detectRole(cwd, {
      id: "agent-member1",
      manager: "agent-mgr",
      worker: true,
    });
    const instructions = await generateInstructions(ctx);

    // Names the team.
    expect(instructions).toContain("## Teams");
    expect(instructions).toContain("@backend");
    // Imperative reply action naming `ib send @<team>`.
    expect(instructions).toContain('ib send @backend "');
    // Live-roster pointer.
    expect(instructions).toContain("ib roster @backend");
    // Who-spoke / where-to-reply disambiguation of the inbound prefix.
    expect(instructions).toContain("[sent by <agent-id> in @<team>]");
    expect(instructions).toContain("WHO");
    expect(instructions).toContain("WHERE");
    // The block lives inside the <ittybitty> wrapper.
    expect(instructions).toContain("<ittybitty>");
    expect(instructions).toContain("</ittybitty>");
    const teamsIdx = instructions.indexOf("## Teams");
    const closeIdx = instructions.lastIndexOf("</ittybitty>");
    expect(teamsIdx).toBeGreaterThan(-1);
    expect(teamsIdx).toBeLessThan(closeIdx);
  });

  test("generateInstructions names ALL teams an agent belongs to", async () => {
    await createTeam("backend", "@system", 100);
    await createTeam("infra", "@system", 100);
    await addMember("backend", "agent-multi");
    await addMember("infra", "agent-multi");

    const cwd = "/Users/me/project/.ittybitty/agents/agent-multi/repo";
    const ctx = detectRole(cwd, { id: "agent-multi", manager: "agent-mgr", worker: true });
    const instructions = await generateInstructions(ctx);

    expect(instructions).toContain("## Teams");
    expect(instructions).toContain("@backend");
    expect(instructions).toContain("@infra");
  });

  test("generateInstructions for an agent in NO team does NOT include a ## Teams section", async () => {
    await createTeam("backend", "@system", 100);
    await addMember("backend", "agent-someoneelse");

    const cwd = "/Users/me/project/.ittybitty/agents/agent-loner/repo";
    const ctx = detectRole(cwd, { id: "agent-loner", manager: "agent-mgr", worker: true });
    const instructions = await generateInstructions(ctx);

    expect(instructions).not.toContain("## Teams");
    // Worker instructions still render normally (no behavior change).
    expect(instructions).toContain("Worker Agent");
  });

  test("team block appears on the markdownBody path (the real agent path)", async () => {
    // Materialize an agent-type with a markdown body — this is the path real
    // agents hit (generateInstructions wraps the body in <ittybitty>).
    await Bun.write(
      join(typesDir, "_all.md"),
      "---\nname: _all\nspawnable: false\n---\nALL_LAYER_MARKER",
    );
    await Bun.write(
      join(typesDir, "_non_coordinator.md"),
      "---\nname: _non_coordinator\nspawnable: false\n---\nNON_COORDINATOR_LAYER_MARKER",
    );
    await Bun.write(
      join(typesDir, "researcher.md"),
      "---\nname: researcher\ndescription: Researches\n---\nRESEARCHER_BODY_MARKER for {{agentId}}",
    );

    await createTeam("backend", "@system", 100);
    await addMember("backend", "agent-md1");

    const cwd = "/Users/me/project/.ittybitty/agents/agent-md1/repo";
    const ctx = detectRole(cwd, { id: "agent-md1", manager: "agent-mgr", agentType: "researcher" });
    const instructions = await generateInstructions(ctx);

    // The markdownBody content rendered…
    expect(instructions).toContain("RESEARCHER_BODY_MARKER for agent-md1");
    expect(instructions).toContain("ALL_LAYER_MARKER");
    // …AND the team block was spliced in, inside the wrapper.
    expect(instructions).toContain("## Teams");
    expect(instructions).toContain("ib send @backend");
    expect(instructions).toContain("ib roster @backend");
    const teamsIdx = instructions.indexOf("## Teams");
    const closeIdx = instructions.lastIndexOf("</ittybitty>");
    expect(teamsIdx).toBeLessThan(closeIdx);
  });

  test("@system coordinator gets no team block (its id never matches a stored bare agent id)", async () => {
    // Even if a team somehow listed a bare agent, @system's id is "@system" and
    // won't match — confirm no injection.
    await createTeam("backend", "@system", 100);
    await addMember("backend", "agent-x");
    const block = await teamAwarenessBlock("@system");
    expect(block).toBe("");
  });
});


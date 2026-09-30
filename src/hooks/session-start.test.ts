import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { detectRole, generateInstructions, teamAwarenessBlock, interpolateTemplate, buildPathIsolationSection, hookSessionStart, oversizedInstructionsQuestion, HOOK_CONTEXT_CHAR_CAP, type SessionContext } from "./session-start";
import { readAgentState } from "../agents";
import { setSayRunner, resetSayRunner, setAskQuestionTelegramRunner, resetAskQuestionTelegramRunner } from "../ib-commands";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";
import { ensureAgentTypesDir } from "../agent-types";
import { createTeam, addMember } from "../teams";
import { setUserHome, resetUserHome } from "../home";
import {
  resetBoundNoWorktreeCallerResolver,
  resetNoWorktreeRepoRootsLoader,
  setBoundNoWorktreeCallerResolver,
  setNoWorktreeRepoRootsLoader,
} from "./agent-context";

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
 * `setUserHome` redirects the shared user-home seam used by `agent-types.ts`
 * and `hooks/shared.ts`. `setCoordinatorHome` is set alongside it so the
 * outbox/teams paths resolve into the same tree instead of the real one.
 */
let testHome: string;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), "ib-session-start-home-"));
  setUserHome(testHome);
  setCoordinatorHome(join(testHome, ".itsybitsy"));
  // Populate <testHome>/.itsybitsy/agent-types/ with the embedded defaults.
  // Reads userHome() at call time, so it lands in the isolated home.
  await ensureAgentTypesDir();
});

afterAll(() => {
  resetCoordinatorHome();
  resetUserHome();
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

  test("coordinator instructions mention Read, Glob, Grep, and Bash(ls:*)", async () => {
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
    expect(instructions).toContain("Bash(ls:*)");
    expect(instructions).not.toContain("LS");
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
    setUserHome(tempHome);
    typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
  });

  afterEach(async () => {
    // Restore the file-wide isolated home, NOT a `const originalHome` captured
    // in the describe body. That capture ran at module-load time, before
    // `beforeAll` installed the override, so it held the developer's REAL home —
    // restoring it here handed every later test in this file back to the real
    // ~/.itsybitsy and quietly defeated the isolation.
    setUserHome(testHome);
    await rm(tempHome, { recursive: true, force: true });
  });

  test("expands to a pointer at `ib list-types`, not a list of the installed types", async () => {
    await Bun.write(
      join(typesDir, "manager.md"),
      "---\nname: manager\ndescription: Manages sub-agents\n---\nbody",
    );
    await Bun.write(
      join(typesDir, "worker.md"),
      "---\nname: worker\ndescription: Implements a focused task\n---\nbody",
    );

    const template = "before\n\n{{availableTypes}}\n\nafter";
    const result = interpolateTemplate(template, baseCtx);

    expect(result).toContain("### Available Agent Types");
    expect(result).toContain("`ib list-types`");
    expect(result).toContain('`ib new-agent --type <name> "task"`');
    // The installed types stay out of the prompt: the section must not grow
    // with the number of types.
    expect(result).not.toContain("Manages sub-agents");
    expect(result).not.toContain("Implements a focused task");
    // Surrounding text preserved
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  test("the section has the same size whatever types are installed", async () => {
    const empty = interpolateTemplate("{{availableTypes}}", baseCtx);
    for (let i = 0; i < 20; i++) {
      await Bun.write(
        join(typesDir, `type${i}.md`),
        `---\nname: type${i}\ndescription: A long description of agent type number ${i}\n---\nbody`,
      );
    }
    expect(interpolateTemplate("{{availableTypes}}", baseCtx)).toBe(empty);
  });

  test("templates without {{availableTypes}} do not render the section", () => {
    const template = "{{agentId}} on {{parentBranch}}";
    const result = interpolateTemplate(template, baseCtx);
    expect(result).toBe("agent-abc123 on agent/agent-parent");
    expect(result).not.toContain("Available Agent Types");
  });

  test("multiple {{availableTypes}} placeholders all expand to the same content", () => {
    const template = "{{availableTypes}}\n---\n{{availableTypes}}";
    const result = interpolateTemplate(template, baseCtx);
    const occurrences = result.split("### Available Agent Types").length - 1;
    expect(occurrences).toBe(2);
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

  test("worktree agent gets the worktree root and the access rule, not path lists", () => {
    const section = buildPathIsolationSection(baseCtx);
    expect(section).toContain("### Path Isolation");
    expect(section).toContain("You are isolated to your worktree at: /repo/.ittybitty/agents/agent-abc123/repo");
    expect(section).toContain("Your access is limited to your worktree and the paths your agent type needs.");
    expect(section).toContain('If a path you need is blocked ("Access denied" or "Path violation")');
    expect(section).toContain("or use a different path");
    expect(section).toContain("The main repo at /repo");
    expect(section).toContain("A bare `cd`");
    // The resolved `paths:` lists stay out of the prompt: they follow the user's
    // config and pushed the instructions over the hook additionalContext cap.
    expect(section).not.toContain("allowRead");
    expect(section).not.toContain("allowWrite");
    expect(section).not.toContain("(none)");
    // The retired permissive language is gone.
    expect(section).not.toContain("~/.claude, /tmp, and general system paths");
    expect(section).not.toContain("additional paths");
  });

  test("top-level agent is told to ask the user when a needed path is blocked", () => {
    const section = buildPathIsolationSection(baseCtx);
    expect(section).toContain("ask the user for help");
    expect(section).not.toContain("your manager");
  });

  test("sub-agent is told to ask its manager when a needed path is blocked", () => {
    const section = buildPathIsolationSection({ ...baseCtx, agentManager: "agent-parent" });
    expect(section).toContain("ask your manager for help");
    expect(section).not.toContain("ask the user");
  });

  test("sandbox enabled states EPERM and the Denials tab", () => {
    const ctx: SessionContext = {
      ...baseCtx,
      sandbox: { enabled: true, rawAllow: [], domains: [] },
    };
    const section = buildPathIsolationSection(ctx);
    expect(section).toContain("The kernel sandbox is ON");
    expect(section).toContain("EPERM");
    expect(section).toContain("Denials tab of `ib watch`");
  });

  test.each([undefined, {}, { domains: ["example.com"] }])("omitted sandbox enablement defaults on in session instructions (%j)", (sandbox) => {
    const ctx = detectRole(baseCtx.worktreePath, { sandbox });
    expect(buildPathIsolationSection(ctx)).toContain("kernel sandbox is ON");
    if (sandbox) expect(ctx.sandbox?.enabled).toBe(true);
  });

  test("global coordinator remains outside the repository sandbox default", () => {
    const section = buildPathIsolationSection({ ...baseCtx, agentId: "@system" });
    expect(section).toContain("kernel sandbox is OFF");
  });

  test("explicitly disabled sandbox retains hook-controlled approvals and path checks", () => {
    const ctx = { ...baseCtx, sandbox: { enabled: false, rawAllow: [], domains: [] } };
    const section = buildPathIsolationSection(ctx);
    expect(section).toContain("kernel sandbox is OFF");
    expect(section).toContain("hooks enforce tool permissions and path checks without native tool approval prompts");
    expect(section).not.toContain("EPERM");
  });

  test.each(["codex:gpt-5.6-sol", "fugu:fugu"])(
    "%s disabled instructions describe the remaining native sandbox", (model) => {
      const section = buildPathIsolationSection({
        ...baseCtx, model, sandbox: { enabled: false, rawAllow: [], domains: [] },
      });
      expect(section).toContain("Codex's native workspace-write sandbox remains enabled");
    },
  );

  test.each(["codex:gpt-5.6-sol", "fugu:fugu", "agy:default"])(
    "%s instructions report the kernel sandbox ON", (model) => {
      const ctx = detectRole(baseCtx.worktreePath, { model, sandbox: { enabled: true } });
      const section = buildPathIsolationSection(ctx);
      // Mandatory sandbox: every CLI (agy included) is wrapped by the kernel now,
      // so the section reports the kernel ON — no agy-specific "unavailable" case.
      expect(section).toContain("kernel sandbox is ON");
    },
  );

  test.each(["sonnet", "opus", "unknown"])("legacy %s metadata reports the kernel sandbox ON", (model) => {
    const section = buildPathIsolationSection(detectRole(baseCtx.worktreePath, { model }));
    expect(section).toContain("kernel sandbox is ON");
  });

  test("non-worktree (coordinator) shows repo path and 'this repo' root", () => {
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
    expect(section).toContain("Your access is limited to this repo and the paths your agent type needs.");
    expect(section).not.toContain("The main repo");
    expect(section).not.toContain("~/.claude, /tmp, and general system paths");
  });

  test("detectRole parses sandbox.enabled from meta.json", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
      sandbox: { enabled: true, rawAllow: [], domains: [] },
    });
    expect(ctx.sandbox?.enabled).toBe(true);
  });

  test("detectRole sandbox undefined when not in meta", () => {
    const cwd = "/Users/me/project/.ittybitty/agents/agent-abc12345/repo";
    const ctx = detectRole(cwd, {
      id: "agent-abc12345",
      manager: null,
      worker: false,
    });
    expect(ctx.sandbox).toBeUndefined();
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
    };
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("### Path Isolation");
    expect(instructions).toContain("ask the user for help");
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
    };
    const instructions = await generateInstructions(ctx);
    expect(instructions).toContain("### Path Isolation");
    expect(instructions).toContain("ask your manager for help");
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
    setNoWorktreeRepoRootsLoader(async () => [tempDir]);
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    resetNoWorktreeRepoRootsLoader();
    resetBoundNoWorktreeCallerResolver();
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
        worktree: false,
        state: "creating",
      }),
    );
    setBoundNoWorktreeCallerResolver(async () => ({
      meta: await Bun.file(join(agentDir, "meta.json")).json(),
      agentDir,
      repoPath: tempDir,
    }));
    const stdin = JSON.stringify({ cwd: tempDir });
    await hookSessionStart(stdin, agentId);
    const state = await readAgentState(agentDir);
    expect(state).toBe("running");
  });

  test("explicit id injects the no-worktree agent role from a nested cwd", async () => {
    const agentId = "agent-shared-worker";
    const agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    const nested = join(tempDir, "packages", "feature");
    await mkdir(agentDir, { recursive: true });
    await mkdir(nested, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: agentId,
      manager: "agent-parent",
      worker: true,
      worktree: false,
      agentType: "worker",
      state: "waiting",
    }));
    setBoundNoWorktreeCallerResolver(async () => ({
      meta: await Bun.file(join(agentDir, "meta.json")).json(),
      agentDir,
      repoPath: tempDir,
    }));
    let captured = "";
    process.stdout.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    await hookSessionStart(JSON.stringify({ cwd: nested }), agentId);

    const output = JSON.parse(captured);
    expect(output.hookSpecificOutput.additionalContext).toContain(`You are worker agent \`${agentId}\``);
    expect(output.hookSpecificOutput.additionalContext).toContain("Your manager agent is: agent-parent");
  });

  test("explicit id cannot claim a sibling or mutate its startup state", async () => {
    const agentA = "agent-real-a";
    const agentB = "agent-claimed-b";
    const agentDirA = join(tempDir, ".ittybitty", "agents", agentA);
    const agentDirB = join(tempDir, ".ittybitty", "agents", agentB);
    await mkdir(agentDirA, { recursive: true });
    await mkdir(agentDirB, { recursive: true });
    const metaA = { id: agentA, worker: true, worktree: false, state: "running" };
    await Bun.write(join(agentDirA, "meta.json"), JSON.stringify(metaA));
    await Bun.write(join(agentDirB, "meta.json"), JSON.stringify({
      id: agentB,
      worker: false,
      worktree: false,
      state: "creating",
    }));
    setBoundNoWorktreeCallerResolver(async () => ({ meta: metaA, agentDir: agentDirA, repoPath: tempDir }));

    await expect(hookSessionStart(JSON.stringify({ cwd: tempDir }), agentB)).rejects.toThrow("another agent");
    expect(await readAgentState(agentDirB)).toBe("creating");
  });

  test("duplicate registered ids use verified no-worktree process evidence", async () => {
    const otherRepo = await mkdtemp(join(tmpdir(), "duplicate-session-start-"));
    try {
      const agentId = "agent-duplicate";
      const agentDirA = join(tempDir, ".ittybitty", "agents", agentId);
      const agentDirB = join(otherRepo, ".ittybitty", "agents", agentId);
      await mkdir(agentDirA, { recursive: true });
      await mkdir(agentDirB, { recursive: true });
      await Bun.write(join(agentDirA, "meta.json"), JSON.stringify({
        id: agentId, worker: false, worktree: false, state: "waiting",
      }));
      const metaB = {
        id: agentId,
        manager: "agent-parent-b",
        worker: true,
        worktree: false,
        agentType: "worker",
        state: "waiting",
      };
      await Bun.write(join(agentDirB, "meta.json"), JSON.stringify(metaB));
      setNoWorktreeRepoRootsLoader(async () => [tempDir, otherRepo]);
      setBoundNoWorktreeCallerResolver(async () => ({ meta: metaB, agentDir: agentDirB, repoPath: otherRepo }));
      let captured = "";
      process.stdout.write = ((chunk: unknown) => {
        captured += String(chunk);
        return true;
      }) as typeof process.stdout.write;

      await hookSessionStart(JSON.stringify({ cwd: otherRepo }), agentId);

      const output = JSON.parse(captured);
      expect(output.hookSpecificOutput.additionalContext).toContain(`You are worker agent \`${agentId}\``);
      expect(output.hookSpecificOutput.additionalContext).toContain("Your manager agent is: agent-parent-b");
    } finally {
      await rm(otherRepo, { recursive: true, force: true });
    }
  });

  test("standalone forged explicit-id cwd supplies no startup authority", async () => {
    const forgedRoot = await mkdtemp(join(tmpdir(), "forged-session-start-"));
    try {
      const agentId = "agent-forged";
      const agentDir = join(forgedRoot, ".ittybitty", "agents", agentId);
      await mkdir(agentDir, { recursive: true });
      await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
        id: agentId,
        worker: false,
        worktree: false,
        state: "creating",
      }));
      setBoundNoWorktreeCallerResolver(async () => null);

      await expect(hookSessionStart(JSON.stringify({ cwd: forgedRoot }), agentId)).rejects.toThrow("no registered record");
      expect(await readAgentState(agentDir)).toBe("creating");
    } finally {
      await rm(forgedRoot, { recursive: true, force: true });
    }
  });

  test("missing meta.json is a no-op (does not crash)", async () => {
    // cwd points outside any agent dir — no meta to update.
    const stdin = JSON.stringify({ cwd: tempDir });
    await hookSessionStart(stdin);
    // No exception means pass.
  });
});

describe("hookSessionStart — instructions over the hook context cap", () => {
  let tempDir: string;
  let originalWrite: typeof process.stdout.write;
  let stdout: string;
  let sayCalls: string[][];

  /** Write an agent type whose rendered instructions are `bodyChars` + a little. */
  async function writeType(name: string, bodyChars: number): Promise<void> {
    await Bun.write(
      join(testHome, ".itsybitsy", "agent-types", `${name}.md`),
      `---\nname: ${name}\ndescription: size test type\n---\n${"x".repeat(bodyChars)}`,
    );
  }

  async function setupAgent(agentId: string, agentType: string, manager: string | null = null): Promise<{
    agentDir: string;
    cwd: string;
  }> {
    const agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    const cwd = join(agentDir, "repo");
    await mkdir(cwd, { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: agentId, manager, agentType, state: "running" }),
    );
    return { agentDir, cwd };
  }

  async function readQuestions(): Promise<Array<{ agent: string; question: string; status: string }>> {
    const file = Bun.file(join(tempDir, ".ittybitty", "user-questions.json"));
    if (!(await file.exists())) return [];
    return (await file.json()).questions;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ib-sessstart-cap-"));
    stdout = "";
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    sayCalls = [];
    setSayRunner((cmd) => { sayCalls.push(cmd); });
    setAskQuestionTelegramRunner(async () => ({ ok: true, message: "" }));
    await writeType("oversized", HOOK_CONTEXT_CHAR_CAP);
    await writeType("undersized", 100);
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    resetSayRunner();
    resetAskQuestionTelegramRunner();
    await rm(join(testHome, ".itsybitsy", "agent-types", "oversized.md"), { force: true });
    await rm(join(testHome, ".itsybitsy", "agent-types", "undersized.md"), { force: true });
    await rm(tempDir, { recursive: true, force: true });
  });

  test("raises a question from the agent, logs it, and still delivers the full instructions", async () => {
    const { agentDir, cwd } = await setupAgent("agent-big", "oversized");
    await hookSessionStart(JSON.stringify({ cwd }));

    const instructions: string = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(instructions.length).toBeGreaterThan(HOOK_CONTEXT_CHAR_CAP);

    const questions = await readQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.agent).toBe("agent-big");
    expect(questions[0]!.status).toBe("pending");
    expect(questions[0]!.question).toBe(oversizedInstructionsQuestion(instructions.length));
    expect(questions[0]!.question).toContain("10,000-character limit");
    expect(questions[0]!.question).toContain("possibly did not read the rest");

    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain(`[SessionStart] instructions are ${instructions.length} characters`);
    expect(sayCalls).toHaveLength(1);
  });

  test("raises the question for a sub-agent too (ib ask itself refuses agents with a manager)", async () => {
    await setupAgent("agent-parent", "undersized");
    const { cwd } = await setupAgent("agent-child", "oversized", "agent-parent");
    await hookSessionStart(JSON.stringify({ cwd }));

    const questions = await readQuestions();
    expect(questions.map((q) => q.agent)).toEqual(["agent-child"]);
  });

  test("records the question once when the hook fires again (resume, /clear, compaction)", async () => {
    const { cwd } = await setupAgent("agent-big", "oversized");
    await hookSessionStart(JSON.stringify({ cwd }));
    await hookSessionStart(JSON.stringify({ cwd }));
    await hookSessionStart(JSON.stringify({ cwd }));

    expect(await readQuestions()).toHaveLength(1);
    expect(sayCalls).toHaveLength(1);
  });

  test("raises nothing when the instructions are under the cap", async () => {
    const { agentDir, cwd } = await setupAgent("agent-small", "undersized");
    await hookSessionStart(JSON.stringify({ cwd }));

    const instructions: string = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(instructions.length).toBeLessThanOrEqual(HOOK_CONTEXT_CHAR_CAP);
    expect(await readQuestions()).toEqual([]);
    expect(await Bun.file(join(agentDir, "agent.log")).exists()).toBe(false);
    expect(sayCalls).toHaveLength(0);
  });

  test("still delivers the instructions when the question cannot be written", async () => {
    const { cwd } = await setupAgent("agent-big", "oversized");
    // A directory where the questions file belongs makes the write fail.
    await mkdir(join(tempDir, ".ittybitty", "user-questions.json"), { recursive: true });
    const originalErr = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      await hookSessionStart(JSON.stringify({ cwd }));
    } finally {
      process.stderr.write = originalErr;
    }

    const instructions: string = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(instructions.length).toBeGreaterThan(HOOK_CONTEXT_CHAR_CAP);
    expect(stderr).toContain("session-start: could not flag oversized instructions");
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
    setUserHome(tempHome);
    typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    // Restore the file-wide isolated home — see the note on the equivalent
    // afterEach above for why a describe-body capture is the wrong target.
    setUserHome(testHome);
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

  // A minimal system.md so generateInstructions() succeeds for @system.
  async function seedSystemType(): Promise<void> {
    await Bun.write(
      join(typesDir, "system.md"),
      "---\nname: system\ndescription: System coordinator\nspawnable: false\n---\nSYSTEM_BODY_MARKER",
    );
  }

  const coordSessionPath = () => join(tempHome, ".itsybitsy", "coordinator-session.json");

  test("records a valid data.session_id to coordinator-session.json", async () => {
    await seedSystemType();
    const sessionId = "deadbeef-1234-5678-90ab-cdef00001111";
    const stdin = JSON.stringify({ cwd: "/tmp", session_id: sessionId });
    await hookSessionStart(stdin, "@system");

    const file = Bun.file(coordSessionPath());
    expect(await file.exists()).toBe(true);
    const recorded = await file.json();
    expect(recorded.session_id).toBe(sessionId);
    expect(typeof recorded.captured_at).toBe("number");

    // stdout still emits a valid SessionStart payload with the system body.
    const output = JSON.parse(captured);
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toContain("SYSTEM_BODY_MARKER");
  });

  test("missing session_id → no coordinator-session.json written, no crash", async () => {
    await seedSystemType();
    const stdin = JSON.stringify({ cwd: "/tmp" });
    await hookSessionStart(stdin, "@system");

    expect(await Bun.file(coordSessionPath()).exists()).toBe(false);
    const output = JSON.parse(captured);
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("invalid session_id → no coordinator-session.json written, no crash", async () => {
    await seedSystemType();
    // Contains characters isValidSessionId rejects (spaces, punctuation).
    const stdin = JSON.stringify({ cwd: "/tmp", session_id: "not a valid id!" });
    await hookSessionStart(stdin, "@system");

    expect(await Bun.file(coordSessionPath()).exists()).toBe(false);
    const output = JSON.parse(captured);
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("additionalContext is byte-identical with vs without a session_id", async () => {
    await seedSystemType();

    captured = "";
    await hookSessionStart(JSON.stringify({ cwd: "/tmp", session_id: "deadbeef-1234-5678-90ab-cdef00001111" }), "@system");
    const withId = JSON.parse(captured).hookSpecificOutput.additionalContext;

    captured = "";
    await hookSessionStart(JSON.stringify({ cwd: "/tmp" }), "@system");
    const withoutId = JSON.parse(captured).hookSpecificOutput.additionalContext;

    expect(withId).toBe(withoutId);
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
    setUserHome(baseDir);
    setCoordinatorHome(homeDir);
  });

  afterEach(async () => {
    // Hand both halves back to the file-wide isolated home rather than clearing
    // the override and restoring a module-load-time HOME capture — either one
    // would drop the remaining tests back onto the real ~/.itsybitsy.
    setCoordinatorHome(join(testHome, ".itsybitsy"));
    setUserHome(testHome);
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

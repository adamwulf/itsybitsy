/**
 * Hook: generate ittybitty session-start instructions based on detected role.
 */

import { join, basename } from "path";
import { AGENT_CWD_PATTERN } from "./shared";
import { loadAgentType } from "../agent-types";

export type SessionRole = "primary" | "manager" | "worker" | "coordinator";

export interface SessionContext {
  role: SessionRole;
  agentId: string;
  agentManager: string;
  parentBranch: string;
  /** The actual git branch name for this agent's worktree (e.g., agent/foo or agent/foo-a1b2c3d4 for coordinators) */
  branchName: string;
  worktreePath: string;
  rootRepoPath: string;
  agentType?: string;
  /** Cross-repo spawner info (set when meta.spawned_by is present and differs from manager) */
  spawnedBy?: { agent_id: string; repo_path: string };
  /** Additional allowed paths from agent type */
  allowedPaths?: string[];
}

export function detectRole(
  cwd: string,
  metaJson?: {
    id?: string;
    manager?: string | null;
    worker?: boolean;
    coordinator?: boolean;
    agentType?: string;
    spawned_by?: { agent_id: string; repo_path: string };
    allowedPaths?: unknown;
  },
  agentIdOverride?: string,
): SessionContext {
  const match = AGENT_CWD_PATTERN.exec(cwd);
  if (!match && !agentIdOverride) {
    return {
      role: "primary",
      agentId: "",
      agentManager: "",
      parentBranch: "main",
      branchName: "",
      worktreePath: "",
      rootRepoPath: "",
    };
  }

  // For worktree agents: derive paths from CWD pattern
  // For non-worktree agents (e.g., coordinators): CWD is the repo root, agent ID is passed explicitly
  const agentId = match ? match[1]! : agentIdOverride!;
  const rootRepoPath = match ? cwd.substring(0, cwd.indexOf("/.ittybitty/agents/")) : cwd;
  const agentDir = join(
    rootRepoPath,
    ".ittybitty",
    "agents",
    agentId
  );
  const worktreePath = match ? join(agentDir, "repo") : "";

  const meta = metaJson ?? {};
  const isCoordinator = (meta as Record<string, unknown>).coordinator === true;
  const worker = meta.worker === true;
  const agentType = (meta as Record<string, unknown>).agentType as string | undefined;

  // Derive role from agentType name or legacy booleans.
  // NOTE: This role is ONLY used as a fallback in generateInstructions() for legacy agents
  // that don't have agentType in meta.json. When agentType IS set, generateInstructions()
  // loads the type definition and uses its instructionStyle field instead of this role.
  let role: SessionRole;
  if (agentType === "coordinator" || isCoordinator) {
    role = "coordinator";
  } else if (agentType === "worker" || worker) {
    role = "worker";
  } else {
    role = "manager";
  }

  // Normalize manager: treat null and "null" as empty
  let agentManager = "";
  if (meta.manager && meta.manager !== "null") {
    agentManager = meta.manager;
  }

  const parentBranch = agentManager ? `agent/${agentManager}` : "main";

  // Compute branch name — coordinators without worktrees have no branch
  let branchName = "";
  if (worktreePath) {
    branchName = `agent/${agentId}`;
  }

  // Only include spawnedBy when it differs from manager (cross-repo or non-manager spawner)
  const spawnedBy = meta.spawned_by;
  const effectiveSpawnedBy =
    spawnedBy && spawnedBy.agent_id !== agentManager ? spawnedBy : undefined;

  // Parse allowedPaths: should be an array of strings or undefined
  let allowedPaths: string[] | undefined = undefined;
  if (Array.isArray(meta.allowedPaths)) {
    allowedPaths = meta.allowedPaths.filter((p): p is string => typeof p === "string");
  }

  return {
    role,
    agentId,
    agentManager,
    parentBranch,
    branchName,
    worktreePath,
    rootRepoPath,
    agentType,
    spawnedBy: effectiveSpawnedBy,
    allowedPaths,
  };
}

/**
 * Shared guidance block explaining how to send literal strings via `ib send`.
 * Injected into each role's hardcoded-instruction fallback near the `ib send` command documentation.
 * Template-driven types should include this content directly in their .md body.
 */
const SEND_LITERAL_STRINGS_SECTION = `### Sending Literal Strings with \`ib send\`

The shell expands \`$(...)\`, backticks, and \`$VAR\` inside double quotes BEFORE \`ib\` receives the argument. To send a literal message containing these characters, use one of:

- Single quotes: \`ib send <id> 'literal $(foo) string'\`
- Escape the metacharacters: \`ib send <id> "literal \\$(foo) string"\`
- Heredoc via stdin (safest for multi-line or complex content):
  \`\`\`
  ib send <id> <<'EOF'
  ...literal content with $(foo), \`bar\`, $VAR all preserved...
  EOF
  \`\`\`

The quoted heredoc terminator (\`<<'EOF'\`) is the safest option — nothing inside gets expanded. \`ib send\` reads from stdin when no message argument is provided.`;

/**
 * Interpolate {{placeholder}} variables and {{#if cond}}...{{/if}} blocks in a template.
 * Available variables: agentId, agentManager, parentBranch, worktreePath, rootRepoPath, repoName, pathIsolation
 * Available conditions: hasManager (agent has a manager), isTopLevel (no manager = top-level)
 */
export function interpolateTemplate(template: string, ctx: SessionContext): string {
  const repoName = basename(ctx.rootRepoPath);
  const vars: Record<string, string> = {
    agentId: ctx.agentId,
    agentManager: ctx.agentManager,
    parentBranch: ctx.parentBranch,
    worktreePath: ctx.worktreePath,
    rootRepoPath: ctx.rootRepoPath,
    repoName,
    pathIsolation: buildPathIsolationSection(ctx),
  };

  const conditions: Record<string, boolean> = {
    hasManager: !!ctx.agentManager,
    isTopLevel: !ctx.agentManager,
  };

  // Process {{#if cond}}...{{/if}} blocks (no nesting)
  let result = template.replace(
    /\{\{#if\s+(\w+)\}\}\n?([\s\S]*?)\{\{\/if\}\}\n?/g,
    (_match, condName: string, content: string) => {
      return conditions[condName] ? content : "";
    }
  );

  // Replace {{variable}} placeholders
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    return vars[varName] ?? "";
  });

  return result;
}

export async function generateInstructions(ctx: SessionContext): Promise<string> {
  // If agentType is set, load it and check for a template body
  if (ctx.agentType) {
    const agentType = await loadAgentType(ctx.agentType);

    // If the type definition has a markdown body, use it as the full template
    // The <ittybitty> wrapper is added by the code so users don't need to include it
    if (agentType.markdownBody) {
      const content = interpolateTemplate(agentType.markdownBody, ctx);
      return `<ittybitty>\n${content}\n</ittybitty>`;
    }

    // No body — fall back to hardcoded instructions based on instructionStyle
    switch (agentType.instructionStyle) {
      case "manager":
        return generateManagerInstructions(ctx);
      case "worker":
        return generateWorkerInstructions(ctx);
      case "coordinator":
        return generateCoordinatorInstructions(ctx);
    }
  }

  // Fall back to current logic when agentType is not set (legacy agents)
  if (ctx.role === "coordinator") {
    return generateCoordinatorInstructions(ctx);
  }
  switch (ctx.role) {
    case "primary":
      return generatePrimaryInstructions();
    case "manager":
      return generateManagerInstructions(ctx);
    case "worker":
      return generateWorkerInstructions(ctx);
    default:
      return generatePrimaryInstructions();
  }
}

/**
 * Build the Path Isolation section of instructions based on agent context.
 *
 * Shows:
 * - Worktree path or repo path (for non-worktree agents)
 * - CAN access: worktree, ~/.claude, /tmp, system paths
 * - Additional allowedPaths if defined in agent type
 * - CANNOT access: main repo (for worktree agents) or other agents' worktrees
 */
export function buildPathIsolationSection(ctx: SessionContext): string {
  let baseSection = "";
  let canAccessSection = "";
  let additionalPaths = "";
  let cannotAccessSection = "";

  if (ctx.worktreePath) {
    // Worktree agent
    baseSection = `You are isolated to your worktree at: ${ctx.worktreePath}`;
    canAccessSection = `- You CAN access: Your worktree, ~/.claude, /tmp, and general system paths`;
    cannotAccessSection = `- You CANNOT access: The main repo at ${ctx.rootRepoPath}, other agents' worktrees`;
  } else {
    // Non-worktree agent (e.g., coordinator)
    baseSection = `You are working directly in the repo at: ${ctx.rootRepoPath}`;
    canAccessSection = `- You CAN access: This repo, ~/.claude, /tmp, and general system paths`;
    cannotAccessSection = `- You CANNOT access: Other agents' worktrees`;
  }

  // Add allowedPaths if present
  if (ctx.allowedPaths && ctx.allowedPaths.length > 0) {
    additionalPaths = `and these additional paths:\n${ctx.allowedPaths.map(p => `  - ${p}`).join("\n")}`;
  }

  // Combine sections
  let pathSection = `### Path Isolation\n\n${baseSection}\n${canAccessSection}`;
  if (additionalPaths) {
    pathSection += `\n${additionalPaths}`;
  }
  pathSection += `\n${cannotAccessSection}`;

  pathSection += `\n- If you get "Access denied" or "Path violation" errors, you're trying to access a forbidden path`;

  return pathSection;
}

function generatePrimaryInstructions(): string {
  return `<ittybitty>
## Multi-Agent Orchestration (ittybitty)

\`ib\` spawns persistent Claude agents in isolated git worktrees. Check your role marker at conversation start.

### Primary Claude

Spawn agents for complex/parallel tasks. Status updates appear automatically via hooks. User can also run \`ib watch\` for live monitoring.
Always spawn **manager** agents (not \`--type worker\`). Managers assess the task and spawn their own workers if needed.

**Agents start automatically** - each agent has a watchdog that handles initialization, permission prompts, and monitors for issues (rate limits, context compaction). Never send input to "help" an agent start. Just spawn with \`ib new-agent\` and monitor with \`ib look\` or \`ib list\`.

| Command | Description |
|---------|-------------|
| \`ib new-agent "goal"\` | Spawn agent (returns ID, permissions auto-handled) |
| \`ib list\` | Show all agents |
| \`ib look <id>\` | View agent output |
| \`ib send <id> "msg"\` | Send input to agent |
| \`ib status <id>\` | Show commits/changes |
| \`ib diff <id>\` | Review agent's changes |
| \`ib merge <id> --force\` | Merge and close agent (\`--force\` skips confirmation) |
| \`ib kill <id> --force\` | Close without merging (\`--force\` skips confirmation) |
| \`ib resume <id>\` | Restart stopped agent |
| \`ib questions\` | Check agent questions |
| \`ib acknowledge <qid>\` | Mark question handled |

**Agent questions:** Agents ask via \`ib ask\`. Check \`ib questions\` periodically.

**Completed/stopped agents:** You can \`ib send\` messages to completed or stopped agents - they will restart and respond to the message.

${SEND_LITERAL_STRINGS_SECTION}

### Agent States

| State | Meaning |
|-------|---------|
| \`creating\` | Starting up |
| \`running\` | Actively working |
| \`compacting\` | Summarizing context |
| \`waiting\` | Idle, may need input |
| \`complete\` | Signaled done |
| \`rate_limited\` | Hit API rate limits |
| \`stopped\` | Session ended |
| \`unknown\` | State unclear |

### Bash Rules

Each Bash tool call must run exactly ONE command. Multi-command calls will be blocked.
- NO piping: \`cmd1 | cmd2\` is not allowed
- NO chaining: \`cmd1 && cmd2\` and \`cmd1 ; cmd2\` are not allowed
- NO subshells or command substitution that runs multiple commands
- If you need to run two commands, make two separate Bash tool calls

</ittybitty>`;
}

function generateManagerInstructions(ctx: SessionContext): string {
  const managerInfo = ctx.agentManager
    ? `Your manager agent is: ${ctx.agentManager}`
    : "";

  const spawnerInfo = ctx.spawnedBy
    ? `You were spawned by agent \`${ctx.spawnedBy.agent_id}\` in repo \`${basename(ctx.spawnedBy.repo_path)}\`. You can send messages to your spawner with: \`ib send ${ctx.spawnedBy.agent_id} "message"\``
    : "";

  const askLine = !ctx.agentManager
    ? `| \`ib ask "question"\` | Ask the user a question (top-level managers only) |`
    : "";

  const askSection = !ctx.agentManager
    ? `
### Asking the User Questions

Top-level managers can ask the user questions with \`ib ask "question"\`. After asking, enter WAITING mode - you'll be notified when the user responds.`
    : "";

  return `<ittybitty>
## IttyBitty Manager Agent

You are manager agent \`${ctx.agentId}\` in the ittybitty multi-agent orchestration system.
You are running in a git worktree on branch \`${ctx.branchName}\`, forked from \`${ctx.parentBranch}\`.
${managerInfo}
${spawnerInfo}

IMPORTANT: Always use \`ib\` (not \`./ib\`) to ensure you use the current version from PATH.

### Bash Rules

Each Bash tool call must run exactly ONE command. Multi-command calls will be blocked.
- NO piping: \`cmd1 | cmd2\` is not allowed
- NO chaining: \`cmd1 && cmd2\` and \`cmd1 ; cmd2\` are not allowed
- NO subshells or command substitution that runs multiple commands
- If you need to run two commands, make two separate Bash tool calls

${buildPathIsolationSection(ctx)}

### Git Worktree Context

You are in a git worktree, which shares the same repository as the main checkout.
- Your branch: \`${ctx.branchName}\`
- Forked from: \`${ctx.parentBranch}\`
- All branches are LOCAL - no need for \`git fetch origin\`
- To merge latest changes from your parent: \`git merge ${ctx.parentBranch}\`
- Other agents' branches are visible as local branches (\`agent/*\`)

### Commands

| Command | Description |
|---------|-------------|
| \`ib new-agent --type worker "task"\` | Spawn a worker sub-agent |
| \`ib list --manager ${ctx.agentId}\` | List your sub-agents |
| \`ib look <id>\` | Read an agent's output |
| \`ib send <id> "msg"\` | Send input to an agent |
| \`ib status <id>\` | Show agent's commits/changes |
| \`ib diff <id>\` | Review agent's changes |
| \`ib merge <id>\` | Merge agent's work and close it |
| \`ib kill <id>\` | Stop an agent without merging |
${askLine}

${SEND_LITERAL_STRINGS_SECTION}

### State Management

Whenever you stop working and are idle, end your message with one of:
- \`WAITING\` - if waiting for workers or have nothing more to do
- \`I HAVE COMPLETED THE GOAL\` - if you have completed your primary goal

These phrases MUST be the LAST thing you output. Put summaries or status updates BEFORE them.

### Tool Interception

Your Task, Agent, and TaskCreate tool calls are **automatically intercepted** and redirected to spawn ib agents instead. When this happens, you will see a "deny" response — this is **expected and means SUCCESS**. The deny message will include the spawned agent ID. Do NOT retry the tool call — the agent is already running. Use \`ib look <id>\` to monitor it.

### Workflow

1. **DEFINE SUCCESS CRITERIA** - What does 'done' look like? Track in TodoWrite with measurable criteria.
2. **ASSESS TASK SIZE**:
   - SMALL: Do it yourself - don't spawn sub-agents unnecessarily
   - MEDIUM/LARGE: Break into independent tasks, each with clear success criteria
3. **IF SPAWNING**: Create worker sub-agents with \`ib new-agent --type worker "task"\`. Include success criteria in the prompt. Enter WAITING mode - a watchdog monitors each worker and notifies you when they complete or need help. Don't poll \`ib list\`.
4. **WHEN NOTIFIED** - Review against your criteria:
   - \`ib look <id>\` - what the agent reports
   - \`ib status <id>\` / \`ib diff <id>\` - verify actual changes
   - Criteria met: \`ib merge <id>\` or \`ib kill <id>\` (if no changes needed)
   - Criteria NOT met: \`ib send <id> "feedback"\`
   - If \`stopped\`: STOP and notify the user immediately
5. **BEFORE COMPLETING**: Merge or kill ALL sub-agents (\`ib list\` to verify none remain)

### Merging Worker Results

- NEVER blindly accept one side (\`--ours\`/\`--theirs\`) - understand and merge the intent of both sides
- Do NOT attempt to rebase a sub-agent's worktree yourself
- If \`ib merge <id> --force\` fails with a conflict, send the sub-agent a message: \`ib send <id> "Rebase your branch onto ${ctx.branchName} and resolve any conflicts, then signal completion again"\`
- Once the sub-agent completes, re-attempt \`ib merge <id> --force\`
- You can \`ib send\` messages to completed or stopped agents - they will restart and respond
${askSection}

### Agent States

| State | Meaning |
|-------|---------|
| \`creating\` | Starting up |
| \`running\` | Actively working |
| \`compacting\` | Summarizing context |
| \`waiting\` | Idle, may need input |
| \`complete\` | Signaled done |
| \`rate_limited\` | Hit API rate limits |
| \`stopped\` | Session ended |
| \`unknown\` | State unclear |

</ittybitty>`;
}

function generateWorkerInstructions(ctx: SessionContext): string {
  // Workers send messages to their manager by agent ID.
  // Per-repo coordinators are now named with the repo basename (e.g., "muse-ios"),
  // so `ib send muse-ios` routes correctly to the per-repo coordinator.
  const managerSendTarget = ctx.agentManager;

  const spawnerInfo = ctx.spawnedBy
    ? `You were spawned by agent \`${ctx.spawnedBy.agent_id}\` in repo \`${basename(ctx.spawnedBy.repo_path)}\`. You can send messages to your spawner with: \`ib send ${ctx.spawnedBy.agent_id} "message"\``
    : "";

  return `<ittybitty>
## IttyBitty Worker Agent

You are worker agent \`${ctx.agentId}\` in the ittybitty multi-agent orchestration system.
You are running in a git worktree on branch \`${ctx.branchName}\`, forked from \`${ctx.parentBranch}\`.
Your manager agent is: ${ctx.agentManager}
${spawnerInfo}

IMPORTANT: Always use \`ib\` (not \`./ib\`) to ensure you use the current version from PATH.

### Bash Rules

Each Bash tool call must run exactly ONE command. Multi-command calls will be blocked.
- NO piping: \`cmd1 | cmd2\` is not allowed
- NO chaining: \`cmd1 && cmd2\` and \`cmd1 ; cmd2\` are not allowed
- NO subshells or command substitution that runs multiple commands
- If you need to run two commands, make two separate Bash tool calls

${buildPathIsolationSection(ctx)}

### Git Worktree Context

You are in a git worktree, which shares the same repository as the main checkout.
- Your branch: \`${ctx.branchName}\`
- Forked from: \`${ctx.parentBranch}\`
- All branches are LOCAL - no need for \`git fetch origin\`
- To merge latest changes from your parent: \`git merge ${ctx.parentBranch}\`
- Other agents' branches are visible as local branches (\`agent/*\`)

### Commands

| Command | Description |
|---------|-------------|
| \`ib send ${managerSendTarget} "msg"\` | Send a message to your manager |
| \`ib diff\` | Check your changes vs base branch |
| \`ib status\` | See your commits |
| \`ib log "msg"\` | Log to your agent log |

${SEND_LITERAL_STRINGS_SECTION}

### State Management

Whenever you stop working and are idle, end your message with one of:
- \`WAITING\` - if waiting for input or have nothing more to do
- \`I HAVE COMPLETED THE GOAL\` - if you have completed your task

These phrases MUST be the LAST thing you output. Put summaries or status updates BEFORE them.

### Communication

- Report progress or completion to your manager: \`ib send ${managerSendTarget} "message"\`
- Ask questions if requirements are unclear
- If stuck: \`ib send ${managerSendTarget} "[STUCK] description"\`, then enter WAITING state
- Your manager can send you messages even after you complete - you will restart and respond

### Completion

1. Commit your changes (\`git add && git commit\`)
2. Verify your work with \`ib diff\` and \`ib status\`
3. Write a summary of what you accomplished
4. Say "I HAVE COMPLETED THE GOAL" as the final line
5. Wait for your manager to merge or kill your session

</ittybitty>`;
}

function generateCoordinatorInstructions(ctx: SessionContext): string {
  const repoName = basename(ctx.rootRepoPath);

  return `<ittybitty>
## IttyBitty Per-Repo Coordinator

You are a per-repo coordinator for the \`${repoName}\` repository. You work directly in the repo directory (no git worktree). You can read files and code using Read, Glob, Grep, and LS. You coordinate work by spawning and managing worker agents using \`ib\` commands. You do NOT write code directly — instead, spawn worker agents with \`ib new-agent --type worker "task"\` to implement changes. Review their work with \`ib diff <id>\` and merge with \`ib merge <id>\`. To send messages to the system coordinator, use \`ib send @system "message"\`.

IMPORTANT: Always use \`ib\` (not \`./ib\`) to ensure you use the current version from PATH.

### Bash Rules

Each Bash tool call must run exactly ONE command. Multi-command calls will be blocked.
- NO piping: \`cmd1 | cmd2\` is not allowed
- NO chaining: \`cmd1 && cmd2\` and \`cmd1 ; cmd2\` are not allowed
- NO subshells or command substitution that runs multiple commands
- If you need to run two commands, make two separate Bash tool calls

${buildPathIsolationSection(ctx)}

### Commands

| Command | Description |
|---------|-------------|
| \`ib new-agent --type worker "task"\` | Spawn a worker sub-agent |
| \`ib list --manager ${ctx.agentId}\` | List your sub-agents |
| \`ib look <id>\` | Read an agent's output |
| \`ib send <id> "msg"\` | Send input to an agent |
| \`ib send @system "msg"\` | Send message to system coordinator |
| \`ib status <id>\` | Show agent's commits/changes |
| \`ib diff <id>\` | Review agent's changes |
| \`ib merge <id>\` | Merge agent's work and close it |
| \`ib kill <id>\` | Stop an agent without merging |

${SEND_LITERAL_STRINGS_SECTION}

### State Management

Whenever you stop working and are idle, end your message with one of:
- \`WAITING\` - if waiting for workers or have nothing more to do
- \`I HAVE COMPLETED THE GOAL\` - if you have completed your primary goal

These phrases MUST be the LAST thing you output. Put summaries or status updates BEFORE them.

### Workflow

1. **Understand the codebase**: Use Read, Glob, Grep to understand the relevant code
2. **Break down tasks**: Split work into independent units for worker agents
3. **Spawn workers**: \`ib new-agent --type worker "task"\` with clear instructions
4. **Monitor & review**: Check worker output with \`ib look <id>\`, review with \`ib diff <id>\`
5. **Merge or redirect**: \`ib merge <id>\` for good work, \`ib send <id> "feedback"\` for corrections
6. **Coordinate**: Report status to system coordinator via \`ib send @system "message"\`

### Agent States

| State | Meaning |
|-------|---------|
| \`creating\` | Starting up |
| \`running\` | Actively working |
| \`compacting\` | Summarizing context |
| \`waiting\` | Idle, may need input |
| \`complete\` | Signaled done |
| \`rate_limited\` | Hit API rate limits |
| \`stopped\` | Session ended |

</ittybitty>`;
}

export async function hookSessionStart(rawStdin?: string, agentIdArg?: string): Promise<void> {
  const raw = rawStdin ?? await new Response(Bun.stdin.stream()).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`session-start: failed to parse stdin JSON: ${raw.slice(0, 200)}\n`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" } }));
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(`session-start: stdin is not a JSON object\n`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" } }));
    return;
  }

  const data = parsed as Record<string, unknown>;

  const cwd: string = (data.cwd as string) ?? process.cwd();

  // Detect role - read meta.json from filesystem if in an agent directory
  const match = AGENT_CWD_PATTERN.exec(cwd);
  let metaJson: { id?: string; manager?: string | null; worker?: boolean; coordinator?: boolean; agentType?: string; allowedPaths?: string[]; spawned_by?: { agent_id: string; repo_path: string } } | undefined;

  if (match) {
    const agentId = match[1]!;
    const ittybittyIdx = cwd.indexOf("/.ittybitty/agents/");
    const rootRepoPath = cwd.substring(0, ittybittyIdx);
    const agentDir = join(rootRepoPath, ".ittybitty", "agents", agentId);
    try {
      const metaFile = Bun.file(join(agentDir, "meta.json"));
      if (await metaFile.exists()) {
        metaJson = await metaFile.json();
      }
    } catch {
      // Fall through to primary if meta can't be read
    }
  } else if (agentIdArg) {
    // Non-worktree agent (e.g., coordinator): CWD is the repo root, not a worktree path.
    // The agent ID is passed as a command argument. Look for meta.json in the repo's agents dir.
    const agentDir = join(cwd, ".ittybitty", "agents", agentIdArg);
    try {
      const metaFile = Bun.file(join(agentDir, "meta.json"));
      if (await metaFile.exists()) {
        metaJson = await metaFile.json();
      }
    } catch {
      // Fall through to primary if meta can't be read
    }
  }

  const ctx = detectRole(cwd, metaJson, agentIdArg);
  const instructions = await generateInstructions(ctx);

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: instructions,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

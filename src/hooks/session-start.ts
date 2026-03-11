/**
 * Hook: generate ittybitty session-start instructions based on detected role.
 */

import { join } from "path";
import { AGENT_CWD_PATTERN } from "./shared";

export type SessionRole = "primary" | "manager" | "worker";

export interface SessionContext {
  role: SessionRole;
  agentId: string;
  agentManager: string;
  parentBranch: string;
  worktreePath: string;
  rootRepoPath: string;
}

export function detectRole(
  cwd: string,
  metaJson?: { id?: string; manager?: string | null; worker?: boolean }
): SessionContext {
  const match = AGENT_CWD_PATTERN.exec(cwd);
  if (!match) {
    return {
      role: "primary",
      agentId: "",
      agentManager: "",
      parentBranch: "main",
      worktreePath: "",
      rootRepoPath: "",
    };
  }

  const agentId = match[1]!;
  const ittybittyIdx = cwd.indexOf("/.ittybitty/agents/");
  const rootRepoPath = cwd.substring(0, ittybittyIdx);
  const agentDir = join(
    rootRepoPath,
    ".ittybitty",
    "agents",
    agentId
  );
  const worktreePath = join(agentDir, "repo");

  const meta = metaJson ?? {};
  const worker = meta.worker === true;
  const role: SessionRole = worker ? "worker" : "manager";

  // Normalize manager: treat null and "null" as empty
  let agentManager = "";
  if (meta.manager && meta.manager !== "null") {
    agentManager = meta.manager;
  }

  const parentBranch = agentManager ? `agent/${agentManager}` : "main";

  return {
    role,
    agentId,
    agentManager,
    parentBranch,
    worktreePath,
    rootRepoPath,
  };
}

export function generateInstructions(ctx: SessionContext): string {
  switch (ctx.role) {
    case "primary":
      return generatePrimaryInstructions();
    case "manager":
      return generateManagerInstructions(ctx);
    case "worker":
      return generateWorkerInstructions(ctx);
  }
}

function generatePrimaryInstructions(): string {
  return `<ittybitty>
## Multi-Agent Orchestration (ittybitty)

\`ib\` spawns persistent Claude agents in isolated git worktrees. Check your role marker at conversation start.

### Primary Claude

Spawn agents for complex/parallel tasks. Status updates appear automatically via hooks. User can also run \`ib watch\` for live monitoring.
Always spawn **manager** agents (not \`--worker\`). Managers assess the task and spawn their own workers if needed.

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

function generateManagerInstructions(ctx: SessionContext): string {
  const managerInfo = ctx.agentManager
    ? `Your manager agent is: ${ctx.agentManager}`
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
You are running in a git worktree on branch \`agent/${ctx.agentId}\`, forked from \`${ctx.parentBranch}\`.
${managerInfo}

IMPORTANT: Always use \`ib\` (not \`./ib\`) to ensure you use the current version from PATH.

### Path Isolation

You are isolated to your worktree at: ${ctx.worktreePath}
- You CAN access: Your worktree, ~/.claude, /tmp, and general system paths
- You CANNOT access: The main repo at ${ctx.rootRepoPath}, other agents' worktrees
- If you get "Access denied" or "Path violation" errors, you're trying to access a forbidden path

### Git Worktree Context

You are in a git worktree, which shares the same repository as the main checkout.
- Your branch: \`agent/${ctx.agentId}\`
- Forked from: \`${ctx.parentBranch}\`
- All branches are LOCAL - no need for \`git fetch origin\`
- To merge latest changes from your parent: \`git merge ${ctx.parentBranch}\`
- Other agents' branches are visible as local branches (\`agent/*\`)

### Commands

| Command | Description |
|---------|-------------|
| \`ib new-agent --worker "task"\` | Spawn a worker sub-agent |
| \`ib list --manager ${ctx.agentId}\` | List your sub-agents |
| \`ib look <id>\` | Read an agent's output |
| \`ib send <id> "msg"\` | Send input to an agent |
| \`ib status <id>\` | Show agent's commits/changes |
| \`ib diff <id>\` | Review agent's changes |
| \`ib merge <id>\` | Merge agent's work and close it |
| \`ib kill <id>\` | Stop an agent without merging |
${askLine}

### State Management

Whenever you stop working and are idle, end your message with one of:
- \`WAITING\` - if waiting for workers or have nothing more to do
- \`I HAVE COMPLETED THE GOAL\` - if you have completed your primary goal

These phrases MUST be the LAST thing you output. Put summaries or status updates BEFORE them.

### Workflow

1. **DEFINE SUCCESS CRITERIA** - What does 'done' look like? Track in TodoWrite with measurable criteria.
2. **ASSESS TASK SIZE**:
   - SMALL: Do it yourself - don't spawn sub-agents unnecessarily
   - MEDIUM/LARGE: Break into independent tasks, each with clear success criteria
3. **IF SPAWNING**: Create worker sub-agents with \`ib new-agent --worker "task"\`. Include success criteria in the prompt. Enter WAITING mode - a watchdog monitors each worker and notifies you when they complete or need help. Don't poll \`ib list\`.
4. **WHEN NOTIFIED** - Review against your criteria:
   - \`ib look <id>\` - what the agent reports
   - \`ib status <id>\` / \`ib diff <id>\` - verify actual changes
   - Criteria met: \`ib merge <id>\` or \`ib kill <id>\` (if no changes needed)
   - Criteria NOT met: \`ib send <id> "feedback"\`
   - If \`stopped\`: STOP and notify the user immediately
5. **BEFORE COMPLETING**: Merge or kill ALL sub-agents (\`ib list\` to verify none remain)

### Merging Worker Results

- NEVER blindly accept one side (\`--ours\`/\`--theirs\`) - understand and merge the intent of both sides
- Resolve manually, or spawn a worker to handle resolution
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
  return `<ittybitty>
## IttyBitty Worker Agent

You are worker agent \`${ctx.agentId}\` in the ittybitty multi-agent orchestration system.
You are running in a git worktree on branch \`agent/${ctx.agentId}\`, forked from \`${ctx.parentBranch}\`.
Your manager agent is: ${ctx.agentManager}

IMPORTANT: Always use \`ib\` (not \`./ib\`) to ensure you use the current version from PATH.

### Path Isolation

You are isolated to your worktree at: ${ctx.worktreePath}
- You CAN access: Your worktree, ~/.claude, /tmp, and general system paths
- You CANNOT access: The main repo at ${ctx.rootRepoPath}, other agents' worktrees
- If you get "Access denied" or "Path violation" errors, you're trying to access a forbidden path

### Git Worktree Context

You are in a git worktree, which shares the same repository as the main checkout.
- Your branch: \`agent/${ctx.agentId}\`
- Forked from: \`${ctx.parentBranch}\`
- All branches are LOCAL - no need for \`git fetch origin\`
- To merge latest changes from your parent: \`git merge ${ctx.parentBranch}\`
- Other agents' branches are visible as local branches (\`agent/*\`)

### Commands

| Command | Description |
|---------|-------------|
| \`ib send ${ctx.agentManager} "msg"\` | Send a message to your manager |
| \`ib diff\` | Check your changes vs base branch |
| \`ib status\` | See your commits |
| \`ib log "msg"\` | Log to your agent log |

### State Management

Whenever you stop working and are idle, end your message with one of:
- \`WAITING\` - if waiting for input or have nothing more to do
- \`I HAVE COMPLETED THE GOAL\` - if you have completed your task

These phrases MUST be the LAST thing you output. Put summaries or status updates BEFORE them.

### Communication

- Report progress or completion to your manager: \`ib send ${ctx.agentManager} "message"\`
- Ask questions if requirements are unclear
- If stuck: \`ib send ${ctx.agentManager} "[STUCK] description"\`, then enter WAITING state
- Your manager can send you messages even after you complete - you will restart and respond

### Completion

1. Commit your changes (\`git add && git commit\`)
2. Verify your work with \`ib diff\` and \`ib status\`
3. Write a summary of what you accomplished
4. Say "I HAVE COMPLETED THE GOAL" as the final line
5. Wait for your manager to merge or kill your session

</ittybitty>`;
}

export async function hookSessionStart(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();
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
  let metaJson: { id?: string; manager?: string | null; worker?: boolean } | undefined;

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
  }

  const ctx = detectRole(cwd, metaJson);
  const instructions = generateInstructions(ctx);

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: instructions,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

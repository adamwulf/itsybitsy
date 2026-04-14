# Spawner Tracking: Cross-Repo Agent Provenance & Control

## Problem Statement

Today, itsybitsy tracks agent relationships via the `manager` field in meta.json. This field serves double duty: it establishes the parent-child tree (used by `buildAgentTree()`, the TUI, and nuke cascading) AND it gates destructive commands via the path-isolation hook (`checkIbCommandAccess` in `agent-path.ts`).

This works well for same-repo hierarchies, but breaks down for cross-repo scenarios:

1. **System coordinator spawns agents in repo A** via `ib new-agent --repo repoA "task"`. The spawned agent's `manager` is null (auto-detect fails because the coordinator's CWD isn't inside repoA's agent tree). The coordinator has no ability to kill/merge the agent it created.

2. **Per-repo coordinator in repo A spawns an agent in repo B** via `ib new-agent --repo repoB "task"`. Same problem — the spawned agent is in a different `.ittybitty/agents/` directory, so `manager` auto-detect fails and the path hook's `checkIbCommandAccess` can't find the target's meta.json in the calling agent's repo.

3. **A manager agent sends `ib new-agent --repo otherRepo "collaborative task"`** to spin up work in another repo. The spawned agent has no record of who asked for it.

The user wants:
- **Provenance**: Every agent should know which agent spawned it, even across repos
- **Control**: The spawning agent should be allowed to kill agents it spawned cross-repo

## Current Architecture (What Exists)

### meta.json Schema (src/agents.ts:17-36)
```ts
interface AgentMeta {
  id: string;
  session_id: string;
  tmux_session: string;
  prompt: string;
  manager: string | null;     // same-repo manager agent ID
  created: string;
  created_epoch: number;
  worktree: boolean;
  worker: boolean;
  yolo: boolean;
  model: string;
  claude_pid: string;
  summary?: string;
  watchdog_pid?: number;
  coordinator?: boolean;
  type?: string;
  state?: MetaState;
  state_updated_at?: number;
}
```

### Agent Creation (src/ib-commands.ts:1409-1766)
- `newAgent(repoPath, prompt, opts)` creates an agent in the given repo
- `opts.manager` is set explicitly or auto-detected from CWD (lines 1490-1508)
- Auto-detect only works if CWD is inside the same repo's `.ittybitty/agents/` tree
- meta.json is written at line 1747-1766 with `manager: manager || null`

### Manager Auto-Detection (src/ib-commands.ts:1494-1508)
```ts
if (!manager && !coordinatorMode) {
  const cwd = opts?._cwd ?? process.cwd();
  const agentPattern = /\/.ittybitty\/agents\/([^/]+)\/repo/;
  const match = cwd.match(agentPattern);
  if (match && (cwd === rootRepoPath || cwd.startsWith(rootRepoPath + "/"))) {
    // Only auto-detect if CWD is in the SAME repo
    // ...reads meta.json to get calling agent's ID
  }
}
```
The `cwd.startsWith(rootRepoPath + "/")` check explicitly prevents cross-repo auto-detection.

### Permission Enforcement (src/hooks/agent-path.ts:252-338)
`checkIbCommandAccess()` blocks `kill`, `nuke`, `merge`, `resume`, `pause`, `reassign` unless the calling agent is the target's `manager`:
```ts
const targetMetaPath = join(agentsDir, targetId, "meta.json");
// Reads target's meta from the CALLING agent's repo agentsDir
// If target is in a different repo → "agent not found in this repo" → DENY
```

### Intercept Hook (src/hooks/intercept-task.ts:102-242)
When an agent uses the Task/Agent tool, the intercept hook spawns an `ib new-agent` instead. It passes `worker: true` and `manager: callingAgentId`. But the `repoPath` is derived from the calling agent's CWD — there's no mechanism to target a different repo.

### Cross-Repo Agent Resolution (src/index.ts:60-232)
`resolveTarget()` already supports `@`-based addressing for cross-repo sends, and `findAgentById()` searches all repos. `ib send` works cross-repo. `ib kill` uses `requireAgent()` which also searches all repos. **The CLI layer already finds agents cross-repo — it's the agent-level hooks that block access.**

### Watchdog Notifications (src/watchdog.ts:191-203)
`notifyManager()` looks up the manager by ID in `allAgents` (flat list across repos). This already works cross-repo in theory, but since `manager` is null for cross-repo spawns, no notifications are sent.

## Design

### New Field: `spawned_by` in meta.json

Add a `spawned_by` field to meta.json that records the full provenance of who created an agent:

```ts
interface SpawnedBy {
  agent_id: string;     // ID of the spawning agent
  repo_path: string;    // Repo where the spawning agent lives
  repo_name: string;    // Display name of the spawning repo
}
```

In meta.json:
```json
{
  "id": "agent-abc123",
  "manager": "agent-def456",
  "spawned_by": {
    "agent_id": "itsybitsy",
    "repo_path": "/Users/me/repos/other-project",
    "repo_name": "other-project"
  },
  ...
}
```

**Key distinction from `manager`:**
- `manager` = the in-tree parent for nesting, merging, nuke cascading. Always same-repo.
- `spawned_by` = provenance record of who requested creation. Can be cross-repo.
- For same-repo spawns: both point to the same agent. `spawned_by` is redundant but harmless.
- For cross-repo spawns: `manager` is null (no in-tree parent), `spawned_by` records the originator.

### Changes by File

#### 1. `src/agents.ts` — Update AgentMeta interface

Add `spawned_by` to `AgentMeta`:

```ts
export interface SpawnedBy {
  agent_id: string;
  repo_path: string;
  repo_name: string;
}

export interface AgentMeta {
  // ... existing fields ...
  spawned_by?: SpawnedBy;
}
```

Update `readAgentMeta()` to validate the new field (lines 227-256):
- If `spawned_by` exists, validate it's an object with string `agent_id`, `repo_path`, `repo_name`
- If malformed, delete it (same pattern as other optional fields like `coordinator`)

#### 2. `src/ib-commands.ts` — Write `spawned_by` during agent creation

**a) Add `spawned_by` option to `NewAgentOptions` (line 1167):**
```ts
export interface NewAgentOptions {
  // ... existing ...
  spawnedBy?: SpawnedBy;
}
```

**b) Update meta.json writing (line 1747-1766):**

After computing `manager`, also compute `spawned_by`:
```ts
// Compute spawned_by from options or auto-detect
let spawnedBy: SpawnedBy | undefined = opts?.spawnedBy;
if (!spawnedBy && manager) {
  // Same-repo spawn — spawned_by matches manager
  spawnedBy = {
    agent_id: manager,
    repo_path: rootRepoPath,
    repo_name: rootRepoPath.split("/").pop() ?? rootRepoPath,
  };
}

const metaJson: Record<string, unknown> = {
  // ... existing fields ...
  spawned_by: spawnedBy ?? null,
};
```

**c) Update CLI `new-agent` parsing (src/index.ts ~line 760):**

Add `--spawned-by <agent-id>` and `--spawned-by-repo <path>` flags:
```
else if (arg === "--spawned-by") {
  if (!ibArgs[i + 1]) { console.error("Error: --spawned-by requires a value"); process.exit(1); }
  spawnedByAgentId = ibArgs[++i];
}
else if (arg === "--spawned-by-repo") {
  if (!ibArgs[i + 1]) { console.error("Error: --spawned-by-repo requires a value"); process.exit(1); }
  spawnedByRepoPath = ibArgs[++i];
}
```

Then construct `opts.spawnedBy` from these if present.

**d) Auto-detect `spawned_by` from CWD (enhancement to auto-detect block):**

The existing manager auto-detect at line 1494-1508 currently only works for same-repo. We can *also* populate `spawned_by` from CWD even when the repos differ:
```ts
// Auto-detect spawned_by from CWD regardless of repo match
if (!opts?.spawnedBy) {
  const cwd = opts?._cwd ?? process.cwd();
  const agentPattern = /\/.ittybitty\/agents\/([^/]+)\/repo/;
  const match = cwd.match(agentPattern);
  if (match) {
    const spawnerDir = cwd.replace(/(\/.ittybitty\/agents\/[^/]*)\/repo.*/, "$1");
    try {
      const spawnerMeta = await Bun.file(join(spawnerDir, "meta.json")).json();
      if (spawnerMeta.id) {
        const spawnerRepoPath = cwd.substring(0, cwd.indexOf("/.ittybitty/agents/"));
        opts.spawnedBy = {
          agent_id: spawnerMeta.id,
          repo_path: spawnerRepoPath,
          repo_name: spawnerRepoPath.split("/").pop() ?? spawnerRepoPath,
        };
      }
    } catch { /* ignore */ }
  }
}
```

This means: if an agent in repo A runs `ib new-agent --repo repoB "task"`, the CWD reveals who ran the command, and we record it as `spawned_by`.

#### 3. `src/hooks/agent-path.ts` — Allow spawners to kill their cross-repo children

The critical change: `checkIbCommandAccess()` (line 296-338) currently only checks `manager`. We need to also allow operations if the calling agent is the target's `spawned_by.agent_id`.

**Current flow:**
1. Parse `ib kill <target-id>` from bash command
2. Look up `<target-id>/meta.json` in the calling agent's `agentsDir`
3. If not found → deny ("not found in this repo")
4. If found, check `meta.manager === callingAgentId`

**New flow:**
1. Parse `ib kill <target-id>` from bash command
2. Look up `<target-id>/meta.json` in the calling agent's `agentsDir` (same-repo check)
3. If found and `meta.manager === callingAgentId` → allow (existing behavior)
4. If NOT found in this repo → **cross-repo check**:
   - Read all repos from registry
   - Find the target agent across all repos
   - Read its `spawned_by` field
   - If `spawned_by.agent_id === callingAgentId` AND `spawned_by.repo_path` matches calling agent's repo → allow
5. Otherwise → deny

**Important consideration**: The path hook runs as a CLI command (`ib hook-check-path <agentId>`), not as part of the Node process. It needs to be fast. Reading the registry + scanning all repos adds latency. We should:
- Only do the cross-repo lookup if the same-repo lookup fails
- Cache nothing (hooks are stateless, one-shot processes)
- Accept the ~50ms overhead for cross-repo resolution (it's only for destructive commands)

```ts
export async function checkIbCommandAccess(
  command: string,
  callingAgentId: string,
  agentsDir: string
): Promise<HookDecision | null> {
  const parsed = parseIbCommand(command);
  if (!parsed) return null;
  if (!IB_MANAGER_ONLY_COMMANDS.has(parsed.subcommand)) return null;

  const targetId = parsed.targetId;
  const targetMetaPath = join(agentsDir, targetId, "meta.json");

  // Same-repo check (existing)
  try {
    const metaFile = Bun.file(targetMetaPath);
    if (await metaFile.exists()) {
      const meta = await metaFile.json();
      const targetManager = typeof meta.manager === "string" ? meta.manager : undefined;
      if (targetManager === callingAgentId) return null; // allow
      // Same-repo but not manager — deny
      return {
        decision: "deny",
        reason: `Access denied: only the manager of '${targetId}' can run 'ib ${parsed.subcommand}'`,
      };
    }
  } catch { /* fall through to cross-repo check */ }

  // Cross-repo check: target not in this repo — check spawned_by
  try {
    const { listRepos } = await import("../registry");
    const repos = await listRepos();
    for (const repo of repos) {
      const crossRepoMetaPath = join(repo.path, ".ittybitty", "agents", targetId, "meta.json");
      const crossMetaFile = Bun.file(crossRepoMetaPath);
      if (await crossMetaFile.exists()) {
        const meta = await crossMetaFile.json();
        // Check spawned_by
        if (meta.spawned_by?.agent_id === callingAgentId) {
          return null; // allow — spawner can control its children
        }
        // Check manager as fallback (shouldn't normally match cross-repo)
        if (meta.manager === callingAgentId) {
          return null; // allow
        }
        // Found target but calling agent isn't spawner or manager
        return {
          decision: "deny",
          reason: `Access denied: only the spawner or manager of '${targetId}' can run 'ib ${parsed.subcommand}'`,
        };
      }
    }
  } catch { /* ignore — deny below */ }

  return {
    decision: "deny",
    reason: `Access denied: agent '${targetId}' not found in any registered repo`,
  };
}
```

#### 4. `src/hooks/session-start.ts` — Inform agents about their spawner

Update the generated instructions to tell agents who spawned them:

In `generateManagerInstructions()` and `generateWorkerInstructions()`:
```
Your spawner agent is: ${ctx.spawnedBy?.agent_id} (repo: ${ctx.spawnedBy?.repo_name})
```

This helps agents know who to communicate with if they need to report back to their cross-repo originator.

Update `SessionContext` to include `spawnedBy`:
```ts
export interface SessionContext {
  // ... existing ...
  spawnedBy?: SpawnedBy;
}
```

Update `detectRole()` to read `spawned_by` from metaJson and pass it through.

#### 5. `src/watchdog.ts` — Notify spawners cross-repo

Currently `notifyManager()` only notifies the `manager`. Add a parallel `notifySpawner()` that:
1. Reads `spawned_by` from the agent's meta
2. If `spawned_by` differs from `manager`, finds the spawner agent across all repos
3. Sends a notification

This ensures the originating agent gets state change notifications even when it's in a different repo.

```ts
export async function notifySpawner(
  agent: Agent,
  message: string,
  allAgents: Agent[],
): Promise<void> {
  const spawner = agent.meta.spawned_by;
  if (!spawner) return;
  // Don't double-notify if spawner === manager
  if (spawner.agent_id === agent.meta.manager) return;

  const spawnerAgent = findAgent(allAgents, spawner.agent_id);
  if (!spawnerAgent) return;

  await sendMessage(spawnerAgent, message);
}
```

Call both `notifyManager` and `notifySpawner` in the state handlers.

#### 6. `src/hooks/intercept-task.ts` — Pass spawned_by for intercepted spawns

When the intercept hook catches a Task/Agent tool call and spawns an `ib new-agent`, it should pass `spawned_by` if the spawn targets a different repo. Currently the intercept hook always spawns in the calling agent's repo, so this is mostly future-proofing.

#### 7. TUI Updates (`src/tui/info-panel.ts`, `src/tui/dashboard.ts`)

- **Info panel**: Show `spawned_by` info when viewing an agent that has a cross-repo spawner
- **Agent tree**: Potentially show a visual indicator for agents with cross-repo spawners (e.g., a `↗` prefix or colored indicator)

### CLI Changes

#### `ib new-agent` flags
```
--spawned-by <agent-id>        Record which agent is spawning this one
--spawned-by-repo <repo-path>  Repo where the spawning agent lives
```

These flags are primarily for programmatic use (system coordinator, scripts). Normal same-repo spawns auto-detect from CWD.

#### `ib list` output
Show spawner info in verbose/detailed output mode:
```
agent-abc123  running  2m  (spawned by: itsybitsy@other-project)
```

## Migration & Backward Compatibility

- `spawned_by` is an optional field — existing agents without it continue working
- `manager` field is unchanged — same-repo hierarchies are unaffected
- `buildAgentTree()` still uses `manager` for tree construction (not `spawned_by`)
- `checkIbCommandAccess()` tries `manager` first (fast path), falls back to `spawned_by` cross-repo check only when target isn't in same repo

## Open Questions

1. **Should `spawned_by` grant merge access?** Merging a cross-repo agent is unusual — the agent's branch is in repo B, and the spawner in repo A has no branch relationship. Current thinking: yes, allow it. The spawner asked for the work, they should be able to merge or kill it. But this deserves discussion.

2. **Should the TUI show cross-repo spawner relationships?** E.g., draw a dotted line from agent-in-repoB to its spawner-in-repoA? The current tree is per-repo grouped. A cross-reference marker might be sufficient.

3. **Nuke cascading**: When you `ib nuke` an agent, it kills all descendants recursively. Should nuke also cascade to cross-repo children (agents where `spawned_by.agent_id === nuked_agent`)? This could be dangerous but is consistent with the ownership model.

4. **What about the system coordinator?** It runs from `~/.itsybitsy/` with no meta.json and no agent ID. When it spawns an agent via `ib new-agent --repo foo "task"`, what goes in `spawned_by`? Options:
   - `{ agent_id: "system", repo_path: "~/.itsybitsy", repo_name: "system" }`
   - Special-case: system coordinator spawns set `spawned_by.agent_id = "system"`
   - The system coordinator could be granted universal kill access anyway (it already has `Bash(ib:*)` permissions without path isolation)

5. **Coordinator-as-spawner**: Per-repo coordinators run in the repo root (no worktree). When they run `ib new-agent --repo otherRepo "task"`, the CWD is the repo root, not an agent worktree path. The auto-detect logic needs to handle this — we may need to detect coordinator identity from the non-worktree CWD pattern.

## Implementation Order

1. **Phase 1: Data model** — Add `SpawnedBy` type, update `AgentMeta`, update `readAgentMeta()` validation
2. **Phase 2: Write spawned_by** — Update `newAgent()` to compute and write `spawned_by`, add CLI flags, add CWD auto-detection
3. **Phase 3: Permission check** — Update `checkIbCommandAccess()` to allow spawners cross-repo control
4. **Phase 4: Notifications** — Add `notifySpawner()` to watchdog
5. **Phase 5: Session context** — Update session-start hook to inform agents about their spawner
6. **Phase 6: TUI** — Show spawner info in info panel and agent tree
7. **Phase 7: Tests** — Comprehensive tests for all phases

Each phase is independently shippable and testable. Phases 1-3 are the critical path for the core feature.

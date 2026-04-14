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

### Watchdog Agent Loading (src/watchdog.ts:778+)
`loadAllAgentsForNotification()` reads agents from a single repo (the agent's own repo) — NOT all registered repos. This means `findAgent()` can only find agents in the same repo. Cross-repo notifications are fundamentally broken today even for the manager field.

## Design

### New Field: `spawned_by` in meta.json

Add a `spawned_by` field to meta.json that records the full provenance of who created an agent:

```ts
export interface SpawnedBy {
  agent_id: string;     // ID of the spawning agent
  repo_path: string;    // Absolute path to the repo where the spawning agent lives
}
```

`repo_name` is intentionally excluded — it can be derived from `repo_path` at render time via `path.basename()` or registry lookup. Storing it would create a stale-data risk if the user renames a repo in the registry.

In meta.json:
```json
{
  "id": "agent-abc123",
  "manager": "agent-def456",
  "spawned_by": {
    "agent_id": "itsybitsy",
    "repo_path": "/Users/me/repos/other-project"
  },
  ...
}
```

**Key distinction from `manager`:**
- `manager` = the in-tree parent for nesting, merging, nuke cascading. Always same-repo.
- `spawned_by` = provenance record of who requested creation. Can be cross-repo.
- For same-repo spawns: both point to the same agent. `spawned_by` is redundant but harmless.
- For cross-repo spawns: `manager` is null (no in-tree parent), `spawned_by` records the originator.

**System coordinator**: The system coordinator runs from `~/.itsybitsy/` with no meta.json and no agent ID. It already has `Bash(ib:*)` permissions without path isolation hooks (no `hook-check-path` installed for the system coordinator). Therefore, system coordinator spawns **do not set `spawned_by`** — the system coordinator has unrestricted access via existing mechanisms and doesn't need `spawned_by` for kill permissions. If provenance tracking is desired for informational purposes in the future, use `{ agent_id: "system", repo_path: "~/.itsybitsy" }`.

**Spawner lifecycle**: When a spawner agent is killed or archived, its `spawned_by` references in child agents become historical records pointing to a non-existent active agent. This is expected behavior — `notifySpawner` will silently no-op (can't find the agent), and the `spawned_by` data remains useful for audit/provenance. No cascade, no cleanup.

### Changes by File

#### 1. `src/agents.ts` — Update AgentMeta interface

Add `spawned_by` to `AgentMeta`:

```ts
export interface SpawnedBy {
  agent_id: string;
  repo_path: string;
}

export interface AgentMeta {
  // ... existing fields ...
  spawned_by?: SpawnedBy;
}
```

Update `readAgentMeta()` (lines 227-256) to validate the new field. Since `spawned_by` is a nested object (unlike the simple boolean/string fields currently validated), the validation is more involved:

```ts
// Validate spawned_by: must be an object with string agent_id and repo_path
if (data.spawned_by !== undefined && data.spawned_by !== null) {
  if (
    typeof data.spawned_by !== "object" ||
    Array.isArray(data.spawned_by) ||
    typeof data.spawned_by.agent_id !== "string" ||
    typeof data.spawned_by.repo_path !== "string"
  ) {
    delete data.spawned_by;
  }
}
```

#### 2. `src/ib-commands.ts` — Write `spawned_by` during agent creation

**a) Add `spawnedBy` option to `NewAgentOptions` (line 1167):**
```ts
export interface NewAgentOptions {
  // ... existing ...
  spawnedBy?: SpawnedBy;
}
```

**b) Auto-detect `spawned_by` from CWD (new block after the existing manager auto-detect):**

This runs regardless of whether the target repo matches the caller's repo, enabling cross-repo provenance. Uses a local variable to avoid mutating `opts` (which may be undefined).

```ts
// Auto-detect spawned_by from CWD (works cross-repo, unlike manager auto-detect)
let spawnedBy: SpawnedBy | undefined = opts?.spawnedBy;
if (!spawnedBy) {
  const cwd = opts?._cwd ?? process.cwd();

  // Case 1: Worktree agent — CWD matches /.ittybitty/agents/<id>/repo
  const agentPattern = /\/.ittybitty\/agents\/([^/]+)\/repo/;
  const worktreeMatch = cwd.match(agentPattern);
  if (worktreeMatch) {
    const spawnerDir = cwd.replace(/(\/.ittybitty\/agents\/[^/]*)\/repo.*/, "$1");
    try {
      const spawnerMeta = await Bun.file(join(spawnerDir, "meta.json")).json();
      if (spawnerMeta.id) {
        const spawnerRepoPath = cwd.substring(0, cwd.indexOf("/.ittybitty/agents/"));
        spawnedBy = {
          agent_id: spawnerMeta.id,
          repo_path: spawnerRepoPath,
        };
      }
    } catch { /* ignore */ }
  }

  // Case 2: Non-worktree agent (coordinator) — CWD is a registered repo root
  // Coordinators run from the repo root, so CWD won't match the worktree pattern.
  // Detect by checking if CWD is a registered repo with a coordinator agent.
  if (!spawnedBy && !worktreeMatch) {
    try {
      const { listRepos } = await import("./registry");
      const repos = await listRepos();
      const repoMatch = repos.find(r => r.path === cwd);
      if (repoMatch) {
        const { checkCoordinatorExists } = await import("./coordinator");
        const coordStatus = await checkCoordinatorExists(cwd);
        if (coordStatus.exists && coordStatus.agentId) {
          spawnedBy = {
            agent_id: coordStatus.agentId,
            repo_path: cwd,
          };
        }
      }
    } catch { /* ignore */ }
  }
}
```

**c) Update meta.json writing (line 1747-1766):**

```ts
// If spawned_by wasn't auto-detected and we have a same-repo manager,
// set spawned_by to match the manager for consistency
if (!spawnedBy && manager) {
  spawnedBy = {
    agent_id: manager,
    repo_path: rootRepoPath,
  };
}

const metaJson: Record<string, unknown> = {
  // ... existing fields ...
  spawned_by: spawnedBy ?? null,
};
```

**d) Update CLI `new-agent` parsing (src/index.ts ~line 760):**

Add `--spawned-by <agent-id>` and `--spawned-by-repo <path>` flags. Both must be provided together:

```ts
let spawnedByAgentId: string | undefined;
let spawnedByRepoPath: string | undefined;

// ... in the arg parsing loop:
else if (arg === "--spawned-by") {
  if (!ibArgs[i + 1]) { console.error("Error: --spawned-by requires a value"); process.exit(1); }
  spawnedByAgentId = ibArgs[++i];
}
else if (arg === "--spawned-by-repo") {
  if (!ibArgs[i + 1]) { console.error("Error: --spawned-by-repo requires a value"); process.exit(1); }
  spawnedByRepoPath = ibArgs[++i];
}

// ... after parsing, validate co-dependency:
if (spawnedByRepoPath && !spawnedByAgentId) {
  console.error("Error: --spawned-by-repo requires --spawned-by");
  process.exit(1);
}

// Construct spawnedBy if provided
if (spawnedByAgentId) {
  opts.spawnedBy = {
    agent_id: spawnedByAgentId,
    repo_path: spawnedByRepoPath ?? process.cwd(),
  };
}
```

Note: `--spawned-by` without `--spawned-by-repo` is valid — `repo_path` defaults to CWD, which is correct for same-repo spawns.

**e) Validate `repo_path`**: Before writing to meta.json, validate that `spawnedBy.repo_path` is an absolute path:
```ts
if (spawnedBy && !spawnedBy.repo_path.startsWith("/")) {
  spawnedBy.repo_path = resolve(spawnedBy.repo_path);
}
```

#### 3. `src/hooks/agent-path.ts` — Allow spawners to kill their cross-repo children

The critical change: `checkIbCommandAccess()` (line 296-338) currently only checks `manager`. We need to also allow operations if the calling agent is the target's `spawned_by.agent_id` AND the `spawned_by.repo_path` matches the calling agent's repo.

**Updated flow:**
1. Parse `ib kill <target-id>` from bash command
2. Look up `<target-id>/meta.json` in the calling agent's `agentsDir` (same-repo check)
3. If found:
   - `meta.manager === callingAgentId` → allow (existing behavior)
   - `meta.spawned_by?.agent_id === callingAgentId` AND `meta.spawned_by.repo_path` matches calling agent's repo → allow (NEW: same-repo spawner who isn't the tree manager)
   - Otherwise → deny
4. If NOT found in this repo → **cross-repo check**:
   - Derive calling agent's repo root: `resolve(agentsDir, "..", "..")`
   - Read repos from registry, skip the calling agent's own repo (already checked)
   - Find the target agent in other repos
   - If `spawned_by.agent_id === callingAgentId` AND `spawned_by.repo_path` matches calling agent's repo root → allow
   - If `meta.manager === callingAgentId` → allow (fallback)
   - Otherwise → deny
5. Not found anywhere → deny

The `spawned_by.repo_path` check is critical for security: without it, any agent with a matching `agent_id` (possible with `--name`) in any repo could gain control. The repo_path ties the spawner identity to a specific repo, preventing privilege escalation.

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
  const callerRepoRoot = resolve(agentsDir, "..", "..");

  // Same-repo check
  let foundSameRepo = false;
  try {
    const metaFile = Bun.file(targetMetaPath);
    if (await metaFile.exists()) {
      foundSameRepo = true;
      const meta = await metaFile.json();

      // Allow if caller is the manager
      if (typeof meta.manager === "string" && meta.manager === callingAgentId) {
        return null;
      }
      // Allow if caller is the spawner (same-repo case — e.g., coordinator spawned agent in own repo)
      if (
        meta.spawned_by &&
        meta.spawned_by.agent_id === callingAgentId &&
        typeof meta.spawned_by.repo_path === "string" &&
        resolve(meta.spawned_by.repo_path) === callerRepoRoot
      ) {
        return null;
      }
      // Same-repo but neither manager nor spawner
      return {
        decision: "deny",
        reason: `Access denied: only the manager or spawner of '${targetId}' can run 'ib ${parsed.subcommand}'`,
      };
    }
  } catch { /* fall through to cross-repo check */ }

  // Cross-repo check: target not in this repo — search other repos
  if (!foundSameRepo) {
    try {
      const { listRepos } = await import("../registry");
      const repos = await listRepos();
      for (const repo of repos) {
        // Skip our own repo (already checked)
        if (resolve(repo.path) === callerRepoRoot) continue;

        const crossMetaPath = join(repo.path, ".ittybitty", "agents", targetId, "meta.json");
        const crossMetaFile = Bun.file(crossMetaPath);
        if (await crossMetaFile.exists()) {
          const meta = await crossMetaFile.json();
          // Allow if caller is the spawner with matching repo_path
          if (
            meta.spawned_by &&
            meta.spawned_by.agent_id === callingAgentId &&
            typeof meta.spawned_by.repo_path === "string" &&
            resolve(meta.spawned_by.repo_path) === callerRepoRoot
          ) {
            return null;
          }
          // Allow if caller is listed as manager (unusual cross-repo but honor it)
          if (typeof meta.manager === "string" && meta.manager === callingAgentId) {
            return null;
          }
          // Found target but caller has no relationship
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

  return {
    decision: "deny",
    reason: `Access denied: agent '${targetId}' not found in this repo`,
  };
}
```

#### 4. `src/hooks/session-start.ts` — Inform agents about their spawner

**a) Extend the metaJson parameter type in `detectRole()` and the `hookSessionStart()` caller:**

```ts
// In detectRole signature — add spawned_by to the metaJson parameter type:
export function detectRole(
  cwd: string,
  metaJson?: {
    id?: string;
    manager?: string | null;
    worker?: boolean;
    coordinator?: boolean;
    type?: string;
    spawned_by?: { agent_id: string; repo_path: string };
  },
  agentIdOverride?: string,
): SessionContext {
```

**b) Update `SessionContext` to include spawned_by:**

```ts
export interface SessionContext {
  // ... existing fields ...
  /** Cross-repo spawner info (set when meta.spawned_by is present and differs from manager) */
  spawnedBy?: { agent_id: string; repo_path: string };
}
```

**c) Populate spawnedBy in `detectRole()`:**

After computing `agentManager`, add:
```ts
const spawnedBy = (meta as Record<string, unknown>).spawned_by as
  { agent_id: string; repo_path: string } | undefined;

// Only include spawnedBy when it differs from manager (cross-repo or non-manager spawner)
const effectiveSpawnedBy =
  spawnedBy && spawnedBy.agent_id !== agentManager ? spawnedBy : undefined;

return {
  // ... existing fields ...
  spawnedBy: effectiveSpawnedBy,
};
```

**d) Update instruction generators to include spawner info:**

In `generateManagerInstructions()`, `generateWorkerInstructions()`, and `generateCustomTypeInstructions()`, add after the manager info line:
```ts
const spawnerInfo = ctx.spawnedBy
  ? `You were spawned by agent \`${ctx.spawnedBy.agent_id}\` in repo \`${basename(ctx.spawnedBy.repo_path)}\`. You can send messages to your spawner with: \`ib send ${ctx.spawnedBy.agent_id} "message"\``
  : "";
```

Include `spawnerInfo` in the template string output, after the manager info line.

#### 5. `src/watchdog.ts` — Notify spawners cross-repo

**a) Update `loadAllAgentsForNotification()` to read ALL repos, not just the agent's own repo:**

The current implementation (line 778+) only reads agents from the watched agent's repo. For `notifySpawner` to work cross-repo, it needs all agents. Update to:

```ts
async function loadAllAgentsForNotification(repoPath: string): Promise<Agent[]> {
  // Read all registered repos, not just the current one
  const { listRepos } = await import("./registry");
  const repos = await listRepos();
  const { readAllAgents, buildAgentTree } = await import("./agents");
  const { agents } = await readAllAgents(repos.map(r => ({ path: r.path, name: r.name })));
  const roots = buildAgentTree(agents);
  return agents;
}
```

This is safe because `loadAllAgentsForNotification` is only called when a notification is about to be sent (not on every poll tick). The overhead of reading all repos is acceptable for the notification path.

**b) Add `notifySpawner()` function:**

```ts
/**
 * Send a watchdog notification to the agent's spawner (if different from manager).
 * No-op if the agent has no spawned_by, or if spawner === manager, or if
 * spawner agent is not found in any registered repo.
 */
export async function notifySpawner(
  agent: Agent,
  message: string,
  allAgents: Agent[],
): Promise<void> {
  const spawner = agent.meta.spawned_by;
  if (!spawner) return;
  // Don't double-notify if spawner is the same as manager
  if (spawner.agent_id === agent.meta.manager) return;

  const spawnerAgent = findAgent(allAgents, spawner.agent_id);
  if (!spawnerAgent) return;

  await sendMessage(spawnerAgent, message);
}
```

**c) Call `notifySpawner` at every site where `notifyManager` is called:**

In `handleWaiting()`, `handleUnknown()`, `handleComplete()`, and any other state handlers that call `notifyManager`, add a corresponding `notifySpawner` call with the same message and the same guards (debounce, backoff). The spawner notification should use the same `tracker.waitCounter` / `tracker.notifyInterval` thresholds as the manager notification — no separate tracking needed since they fire at the same times.

#### 6. `src/hooks/intercept-task.ts` — Pass spawned_by for intercepted spawns

When the intercept hook catches a Task/Agent tool call and spawns an `ib new-agent`, the `spawnedBy` field is auto-detected from CWD by `newAgent()` (see section 2b above). No changes needed to intercept-task.ts — the auto-detect handles it.

#### 7. TUI Updates (`src/tui/info-panel.ts`, `src/tui/dashboard.ts`)

- **Info panel**: Show `spawned_by` info when viewing an agent that has a cross-repo spawner (where `spawned_by.agent_id !== meta.manager`). Display as: `spawner: <agent_id> (<repo_basename>)`. Derive repo display name from `path.basename(spawned_by.repo_path)`.
- **Agent tree**: No changes to tree structure. Optionally show a `↗` indicator for agents with cross-repo spawners in the compact sidebar format.

### CLI Changes

#### `ib new-agent` flags
```
--spawned-by <agent-id>          Record which agent is spawning this one
--spawned-by-repo <repo-path>    Repo where the spawning agent lives (requires --spawned-by)
```

`--spawned-by` without `--spawned-by-repo` is valid — `repo_path` defaults to CWD.
`--spawned-by-repo` without `--spawned-by` is an error.

These flags are primarily for programmatic use (scripts, unusual flows). Normal spawns auto-detect from CWD.

#### `ib list` output
Show spawner info in verbose/detailed output mode:
```
agent-abc123  running  2m  (spawned by: itsybitsy@other-project)
```

## Migration & Backward Compatibility

- `spawned_by` is an optional field — existing agents without it continue working
- `manager` field is unchanged — same-repo hierarchies are unaffected
- `buildAgentTree()` still uses `manager` for tree construction (not `spawned_by`)
- `checkIbCommandAccess()` tries `manager` first (fast path), falls back to `spawned_by` (same-repo), then cross-repo check only when target isn't found in same repo
- Validation in `readAgentMeta()` silently strips malformed `spawned_by` — won't crash on old or corrupt data

## Resolved Design Decisions

1. **`spawned_by` grants kill/merge/resume/pause/reassign access** — same as manager. The spawner asked for the work and should be able to control it.

2. **No nuke cascading across repos** — `ib nuke` only cascades to same-repo descendants via `manager`. Cross-repo `spawned_by` children are not auto-killed. The spawner can explicitly kill them if needed. This is safer and avoids surprising cross-repo side effects.

3. **System coordinator does NOT use `spawned_by`** — it has no agent ID, no meta.json, and no path isolation hooks. It already has unrestricted `ib` access. System coordinator spawns produce agents with `spawned_by: null`.

4. **Spawner killed before children** — `spawned_by` references become stale pointers. `notifySpawner` silently no-ops. No cascade, no cleanup. This is intentional — `spawned_by` is a historical record.

5. **`repo_name` excluded from `SpawnedBy`** — derived from `repo_path` at render time to avoid stale data.

## Open Questions

1. **Should the TUI show cross-repo spawner relationships?** E.g., draw a dotted line from agent-in-repoB to its spawner-in-repoA? The current tree is per-repo grouped. A cross-reference marker might be sufficient.

## Implementation Order

1. **Phase 1: Data model** — Add `SpawnedBy` type to `agents.ts`, update `AgentMeta`, add validation in `readAgentMeta()`
2. **Phase 2: Write spawned_by** — Update `newAgent()` with auto-detect (worktree + coordinator CWD), add CLI flags with validation, write to meta.json
3. **Phase 3: Permission check** — Update `checkIbCommandAccess()` with same-repo spawner check + cross-repo fallback, verify `spawned_by.repo_path`
4. **Phase 4: Notifications** — Update `loadAllAgentsForNotification()` to read all repos, add `notifySpawner()`, call at all `notifyManager` sites with same guards
5. **Phase 5: Session context** — Extend `SessionContext`, update `detectRole()` to read `spawned_by` from meta, update instruction generators
6. **Phase 6: TUI** — Show spawner info in info panel
7. **Phase 7: Tests** — Comprehensive tests for all phases

Each phase is independently shippable and testable. Phases 1-3 are the critical path for the core feature.

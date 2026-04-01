# Manager/Worker Role System Research

## Complete Role Detection Flow

### Role Detection in session-start.ts

The role system is initialized in `src/hooks/session-start.ts::detectRole()`:

1. **Pattern matching**: Detects if running in an agent worktree via `AGENT_CWD_PATTERN` (matches `/.ittybitty/agents/{agentId}/repo`)
   - Primary Claude: No match → role = `"primary"`
   - Agent worktree: Match found, proceed to step 2

2. **Meta.json read**: Reads `{agentDir}/meta.json` to check role fields:
   - `coordinator === true` → role = `"coordinator"` (highest priority)
   - `worker === true` → role = `"worker"`
   - Otherwise → role = `"manager"` (default for agents)

3. **Manager field**: Reads `meta.json.manager` (can be string, null, or "null" string)
   - Null/"null" normalized to empty string
   - Non-null value becomes `agentManager`
   - Used to set `parentBranch = agentManager ? "agent/{manager}" : "main"`

4. **Context object returned**: `SessionContext` with fields:
   - `role`: "primary" | "manager" | "worker" | "coordinator"
   - `agentId`: Agent ID or empty string
   - `agentManager`: Parent agent ID or empty string
   - `parentBranch`: Git branch agent forked from
   - `worktreePath`: Absolute path to agent's worktree
   - `rootRepoPath`: Absolute path to repo root

### Flow Diagram

```
agent cwd match?
  NO  → primary role (no instructions injected)
  YES → read meta.json
         ├─ coordinator: true → coordinator role
         ├─ worker: true → worker role
         └─ else → manager role
```

---

## Differences Between Roles

### MANAGER ROLE

**Session-start instructions**: `generateManagerInstructions(ctx)`
- Can spawn sub-agents with `ib new-agent --worker "task"`
- Can list sub-agents with `ib list --manager {agentId}`
- Can merge/kill/send messages to sub-agents
- Top-level managers can ask user questions with `ib ask "question"`
- Sub-managers (with `agentManager` set) cannot ask questions

**Intercept behavior** (intercept-task.ts):
- **Managers ARE intercepted**: Task/Agent tool calls are rewritten to spawn ib agents instead
- When a manager calls `Agent(prompt="...", ...)`, it's automatically replaced with `ib new-agent "..."`
- The intercept hook reads `meta.json` and if `worker !== true`, it proceeds with interception

**Permissions** (ib-commands.ts::buildAgentSettings):
- Receive `permissions.manager.allow` + `permissions.all.allow` from config
- Intercept hook only added if already present in base settings (only injected by buildPerRepoCoordinatorSettings)
- Cannot use `EnterPlanMode`/`ExitPlanMode`
- Can use all other tools including `Task`, `Agent`, `Write`, `Edit`, etc.

**Model fallback** (ib-commands.ts::newAgent):
- `--model` CLI arg > config.model > "opus"

**Max agents check**: Blocked by maxAgents config (coordinators bypass this)

**Custom prompts** (ib-commands.ts::loadCustomPrompts):
- `{repo}/.ittybitty/prompts/all.md` - appended to all agents
- `{repo}/.ittybitty/prompts/manager.md` - appended only to managers
- Worker/coordinator versions exist but manager.md is used for non-worker, non-coordinator roles

---

### WORKER ROLE

**Session-start instructions**: `generateWorkerInstructions(ctx)`
- Can ONLY send messages to their manager via `ib send {managerId} "message"`
- Can check own changes with `ib diff` and `ib status`
- Can log to own agent.log with `ib log "message"`
- Cannot spawn sub-agents
- Cannot ask questions
- Must signal completion with "I HAVE COMPLETED THE GOAL"

**Intercept behavior** (intercept-task.ts):
- **Workers are NOT intercepted**: Task/Agent tool calls are allowed through as-is
- Line 137-139: Checks `meta.worker === true` and returns `{ action: "skip" }` immediately
- Workers can use `Agent()` and `Task()` tools directly without spawning ib agents

**Permissions** (ib-commands.ts::buildAgentSettings):
- Receive `permissions.worker.allow` + `permissions.all.allow` from config
- Same mandatory ib permissions as managers
- Same denied tools: `EnterPlanMode`, `ExitPlanMode`

**Model fallback**: Same as managers: `--model` > config.model > "opus"

**Max agents check**: Workers created as sub-agents still count toward maxAgents limit (unless spawned by coordinator)

**Custom prompts**:
- `all.md` appended (same as manager)
- `worker.md` appended only to workers

**Meta.json fields set**:
- `worker: true`
- `manager: "{parentAgentId}"`
- Branch name: `agent/{workerId}` (forked from `agent/{manager}`)

---

### COORDINATOR ROLE

**Session-start instructions**: `generateCoordinatorInstructions(ctx)`
- Reads files and code using Read, Glob, Grep, LS (no Write/Edit)
- Spawns and manages worker agents with `ib new-agent --worker "task"`
- Reviews work with `ib diff <id>` and merges with `ib merge <id>`
- Communicates with system coordinator via `ib send coordinator "message"`
- Does NOT write code directly — only orchestrates workers

**Intercept behavior** (intercept-task.ts):
- Coordinators ARE intercepted for Task/Agent calls (same as managers)
- **ADDITIONAL**: Bash commands are heavily restricted (SPEC §12.2.4):
  - Blocks shell metacharacters: `;|&`><$(){}$'` (newlines, etc.)
  - Blocks `--output` flag in git commands (file write bypass)
  - Allows single Bash commands only via `Bash(ib:*)`

**Permissions** (coordinator.ts):
- Built via `buildPerRepoCoordinatorSettings()`
- Restricted allow list: Read, Glob, Grep, LS, Bash(ib:*), TodoWrite, AskUserQuestion, etc.
- No Write, Edit, or general Bash (only ib commands)
- Intercept hook ALWAYS added (line 1642: `matcher: "Task|Agent|Bash"`)

**Model fallback**: `--model` > coordinator.model config > "opus"

**Max agents check**: Coordinators bypass this check (SPEC §12.4.3)

**One per repo**: Only one coordinator can exist per repo
- Idempotent spawn: attempting to create a second returns the first's ID (line 1443-1447)
- ID generation: `getCoordinatorAgentId(rootRepoPath)` uses repo basename (e.g., "muse-ios")
- Collision handling: if non-coordinator agent has same basename, appends 4-char hex suffix

**Meta.json fields set**:
- `coordinator: true`
- No `worker` field (mutually exclusive with coordinator)
- Branch name includes repo-id: `agent/{id}-{repoId}` (to avoid collision across repos)

---

### PRIMARY ROLE

**Session-start instructions**: `generatePrimaryInstructions()`
- Standard itsybitty primary Claude instructions
- Can spawn managers with `ib new-agent "goal"`
- Cannot ask agent to do things — agents have their own workflows
- Agents start automatically with watchdog; never send unsolicited input

**No intercept**: Task/Agent calls NOT intercepted (always allowed)

**No path isolation**: Can access entire repo

**No role-specific permissions**: Uses global repo settings

---

## How Coordinator Role Fits In

The coordinator is a **per-repo orchestration layer**:

1. **Creation**: Spawned as a special agent with `coordinator: true` in meta.json
2. **One per repo**: Cannot spawn a second coordinator (idempotent)
3. **Permissions**: Severely restricted (read-only except for orchestration)
4. **Task interception**: Like managers, Task/Agent calls are intercepted to spawn workers
5. **Bash restrictions**: ONLY `ib` commands allowed; no chaining, piping, or file writes
6. **System-level**: Reports status to system coordinator via `ib send coordinator "message"`

**Architecture**:
- System coordinator: Single `ib-coordinator` tmux session in `~/.itsybitsy/`, runs Bash(ib:*)
- Per-repo coordinator: One per repo, handles work within that repo
- Relationship: Per-repo coordinators are sub-agents of the system coordinator (can send messages to it)

---

## Custom Prompts System

Located in `.ittybitty/prompts/` directory (sibling to `.ittybitty/agents/`):

### Files

| File | Applied to | Purpose |
|------|-----------|---------|
| `all.md` | All agents (manager, worker, coordinator) | Universal instructions for all roles |
| `manager.md` | Manager and coordinator agents | Role-specific manager/coordinator instructions |
| `worker.md` | Worker agents only | Role-specific worker instructions |

### Loading (loadCustomPrompts in ib-commands.ts)

```typescript
async function loadCustomPrompts(repoPath: string): Promise<{
  all: string;
  manager: string;
  worker: string;
}> {
  // Reads from {repoPath}/.ittybitty/prompts/{all.md, manager.md, worker.md}
  // Returns object with file contents or empty strings if files don't exist
}
```

### Injection (newAgent in ib-commands.ts)

In `prompt.txt` generation (lines 1729-1741):

```
[completion instructions if needed]
[all.md content if exists]
[manager.md or worker.md content if exists]
[original prompt from CLI]
```

**Order**: Completion instructions → all.md → role-specific → original prompt

**Note**: Coordinators use `manager.md` (line 1737), not a separate `coordinator.md`

---

## Meta.json Fields Controlling Role Behavior

| Field | Type | Role Detection | Behavior Control |
|-------|------|-----------------|-----------------|
| `id` | string | Required | Agent identifier |
| `session_id` | string | — | Claude session UUID for resuming |
| `tmux_session` | string | — | tmux session name for display |
| `prompt` | string | — | Original spawn prompt |
| `manager` | string\|null | YES (set parentBranch) | Identifies parent agent for workers; null for top-level |
| `worker` | boolean | YES (role = manager if false) | Controls intercept behavior and instructions |
| `coordinator` | boolean | YES (role = coordinator if true) | Enables coordinator role + special Bash restrictions |
| `yolo` | boolean | — | Skips permission prompts in start.sh |
| `model` | string\|null | — | Claude model (opus/sonnet/haiku) |
| `worktree` | boolean | — | Whether agent uses git worktree or main repo |
| `created` | ISO string | — | Creation timestamp |
| `created_epoch` | number | — | Unix timestamp (used for "creating" state detection) |
| `claude_pid` | string | — | Claude process PID (written by start.sh) |
| `watchdog_pid` | number | — | Watchdog process PID (optional, set by newAgent) |

---

## Hardcoded Assumptions About Roles

### In session-start.ts

1. **Coordinator has highest priority**: `coordinator === true` check before `worker === true`
2. **Null manager normalization**: Both `null` and `"null"` string treated as empty string
3. **Default is manager**: If no coordinator/worker flags, agent is assumed manager

### In intercept-task.ts

1. **Workers skip Task intercept**: Line 137-139: `if (meta.worker === true) { return { action: "skip" } }`
2. **Managers get intercepted**: Only workers skip; coordinators and primary all get intercepted
3. **Coordinator Bash restrictions**: Only when `meta.coordinator === true` (lines 54-65)

### In ib-commands.ts

1. **Manager can have sub-agents**: Check at line 1496-1498 prevents worker from having children
2. **Only managers get intercept hook**: Line 1326: `if (agentType === "manager")` (coordinators always get it from buildPerRepoCoordinatorSettings)
3. **Workers bypass Task intercept**: Interceptor returns `{ action: "skip" }` immediately
4. **Coordinator permissions hardcoded**: `buildPerRepoCoordinatorSettings()` builds fixed allow/deny list
5. **Yolo escalation only from agents**: Line 1505 checks if cwd is in `.ittybitty/agents/` to enable yolo

### In config.ts

1. **Separate permission arrays**: `permissions.manager.*` and `permissions.worker.*` (not merged at config level)
2. **Coordinator model distinct**: `coordinator.model` separate from `model` config key
3. **Coordinator bypass maxAgents**: Line 1559-1566 in newAgent skips check if `coordinatorMode`

### In intercept-task.ts (Task spawning)

1. **Calling context sets worker+manager**: Lines 182-186:
   - If called from agent (callingAgentId exists): `worker: true, manager: callingAgentId`
   - If called from primary: `worker: undefined, manager: undefined` (creates a manager)
2. **No way to spawn a worker from primary**: Only agents can spawn workers (via intercept setting `worker: true`)

---

## Role Hierarchy

```
Primary Claude
├─ Manager Agent (top-level)
│  ├─ Worker Agent
│  ├─ Worker Agent
│  └─ Manager Agent (sub-manager)
│     └─ Worker Agent
├─ Coordinator Agent (per-repo)
│  ├─ Worker Agent
│  ├─ Worker Agent
│  └─ ...
└─ ...
```

**Key rules**:
- **Workers cannot have children**: `ib new-agent --worker` with a worker manager = error
- **Coordinators are always top-level**: Cannot have a manager, cannot spawn from another agent
- **Sub-managers are allowed**: A manager can spawn another manager (which can spawn workers)
- **Intercept cascades**: If manager A spawns manager B with Agent(), manager B's tasks are also intercepted

---

## Summary Table

| Aspect | Primary | Manager | Worker | Coordinator |
|--------|---------|---------|--------|-------------|
| **Spawn sub-agents** | Via intercept | Via intercept | NO (blocked) | Via intercept |
| **Task/Agent intercept** | NO | YES | NO | YES |
| **Bash restrictions** | None | None | None | NO metacharacters/pipes |
| **Ask questions** | N/A | YES (if top-level) | NO | NO |
| **Custom prompt** | N/A | manager.md | worker.md | manager.md |
| **Model default** | N/A | config.model | config.model | coordinator.model |
| **Max agents exempt** | N/A | NO | NO | YES |
| **One per repo** | N/A | NO | NO | YES |
| **Write/Edit allowed** | YES | YES | YES | NO (read-only) |


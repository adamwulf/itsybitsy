# Configuration and Permission System Research

## Executive Summary

Itsybitsy has a multi-layered permission system that combines:
1. **Mandatory permissions** (always granted to agents)
2. **Role-specific config permissions** (per agent type: manager/worker/coordinator)
3. **Global config permissions** (all agents)
4. **CLI flag overrides** (--allow, --deny)
5. **Hardcoded role-specific restrictions** (coordinators only)

The system supports three agent types (manager, worker, coordinator) plus system coordinator, each with distinct capabilities and permission sets.

---

## Configuration System (src/config.ts)

### CONFIG_KEYS Inventory

All user-configurable settings are defined in `CONFIG_KEYS: ConfigKeyDef[]`:

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `maxAgents` | number | 10 | Max concurrent agents per repo |
| `model` | string | "opus" | Default model for manager/worker agents |
| `createPullRequests` | boolean | false | Auto-create PRs on merge (managers only) |
| `allowAgentQuestions` | boolean | true | Allow agents to ask questions |
| `autoCompactThreshold` | number | undefined | Context usage % to trigger auto-compact |
| `externalDiffTool` | string | undefined | External tool for `ib diff` |
| `hooks.injectStatus` | boolean | true | Add stop hook to agents |
| `hooks.statusVisible` | boolean | true | Show stop hook status messages |
| `permissions.all.allow` | string[] | [] | Applies to ALL agents (managers, workers, coordinators) |
| `permissions.all.deny` | string[] | [] | Applies to ALL agents |
| `permissions.manager.allow` | string[] | [] | Manager-only permissions |
| `permissions.manager.deny` | string[] | [] | Manager-only denials |
| `permissions.worker.allow` | string[] | [] | Worker-only permissions |
| `permissions.worker.deny` | string[] | [] | Worker-only denials |
| `coordinator.model` | string | "opus" | Model for both system and per-repo coordinators |
| `permissions.coordinator.allow` | string[] | [] | Per-repo coordinator permissions (system coordinator hardcoded) |
| `permissions.coordinator.deny` | string[] | [] | Per-repo coordinator denials |
| `permissions.repo.allow` | string[] | [] | **Currently unused** (reserved for future per-repo config) |
| `permissions.repo.deny` | string[] | [] | **Currently unused** |

### Config Reading/Writing

**Location:** `~/.itsybitsy/config.json` (user home directory)

**Reading:**
- `readConfig(options?: ReadConfigOptions)` → returns `ConfigResult` (map of key → {value, source})
- Returns default values for any missing keys
- Validates type before returning (rejects mistyped config entries)
- Source field indicates "user" (from config.json) or "default" (built-in)

**Writing:**
- `writeConfig(filePath: string, key: string, value: unknown)`
- Supports nested dot-keys (e.g., "permissions.manager.allow")
- Creates/updates config.json atomically

---

## Permission System (src/ib-commands.ts)

### Permission Layering in buildAgentSettings()

Permissions are merged in this order (highest priority first):

```
1. Mandatory permissions (always added)
   ├─ Bash(ib:*)
   ├─ All git Bash subcommands
   ├─ File system Bash subcommands (pwd, ls, head, tail, cat, grep)
   └─ Core tools: Read, Write, Edit, MultiEdit, Glob, Grep, LS, TodoWrite, Task, Agent, TaskOutput, KillShell, NotebookEdit, WebFetch, WebSearch, AskUserQuestion, ToolSearch

2. Config allow permissions (role-specific + global)
   ├─ permissions.{manager|worker}.allow (if agent type is manager/worker)
   ├─ permissions.all.allow (always)
   └─ Deduplicated with Set

3. CLI --allow flag (NOT IMPLEMENTED IN buildAgentSettings)
   └─ Passed as configAllow parameter, merged in step 2

4. Blocked tools (always denied)
   ├─ EnterPlanMode
   ├─ ExitPlanMode
   └─ Plus config deny entries

5. Config deny permissions (role-specific + global)
   ├─ permissions.{manager|worker}.deny (if agent type is manager/worker)
   └─ permissions.all.deny (always)

6. CLI --deny flag (NOT IMPLEMENTED IN buildAgentSettings)
   └─ Passed as configDeny parameter, merged in step 5
```

**Key Function Signature:**
```typescript
async function buildAgentSettings(
  repoPath: string,
  agentType: "manager" | "worker",
  agentId: string,
  configAllow: string[],    // CLI --allow flags merged with role/all config
  configDeny: string[]       // CLI --deny flags merged with role/all config
): Promise<string>           // Returns JSON settings
```

**Mandatory Permissions Detail:**
```typescript
const ibPerms = [
  "Bash(ib:*)",
  "Bash(git status:*)", "Bash(git add:*)", "Bash(git commit:*)",
  "Bash(git diff:*)", "Bash(git show:*)", "Bash(git log:*)",
  "Bash(git ls-files:*)", "Bash(git grep:*)", "Bash(git rm:*)",
  "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git checkout:*)",
  "Bash(git restore:*)", "Bash(git reset:*)",
  "Bash(pwd:*)", "Bash(ls:*)", "Bash(head:*)", "Bash(tail:*)",
  "Bash(cat:*)", "Bash(grep:*)",
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS",
  "TodoWrite", "Task", "Agent", "TaskOutput", "KillShell", "NotebookEdit",
  "WebFetch", "WebSearch", "AskUserQuestion", "ToolSearch",
];

const blockedTools = ["EnterPlanMode", "ExitPlanMode"];
```

### newAgent() Model Selection Logic

**Priority order:**
```
1. --model CLI flag (if provided)
2. coordinator.model config (if --coordinator flag)
   else config.model (for regular agents)
3. Fallback: "opus"
```

**Code location:** `newAgent()` lines 1531-1543

```typescript
// 7. Model fallback: --model > config.model > 'opus'
//    For coordinators: --model > coordinator.model > 'opus'
let model = opts?.model ?? "";
if (!model) {
  if (coordinatorMode) {
    const coordModel = config["coordinator.model"]?.value as string | undefined;
    if (coordModel) model = coordModel;
  } else {
    const configModel = config.model?.value as string | undefined;
    if (configModel) model = configModel;
  }
}
if (!model) model = "opus";
```

**Validation:** `isValidModel(model)` checks: `/^[a-zA-Z0-9._-]+$/`

### Config Permission Merging in newAgent()

```typescript
const agentType = workerMode ? "worker" : "manager";
const roleAllow = (config[`permissions.${agentType}.allow`]?.value as string[] | undefined) ?? [];
const roleDeny = (config[`permissions.${agentType}.deny`]?.value as string[] | undefined) ?? [];
const allAllow = (config["permissions.all.allow"]?.value as string[] | undefined) ?? [];
const allDeny = (config["permissions.all.deny"]?.value as string[] | undefined) ?? [];
const configAllow = [...new Set([...roleAllow, ...allAllow])];
const configDeny = [...new Set([...roleDeny, ...allDeny])];
```

**Result:** Deduped union of role-specific + global for both allow/deny lists

### Hooks Injection

All agents get these hooks in settings.local.json:
- **Stop hook:** `ib hook-status {agentId}` (detects stuck agents, sends nudge)
- **PermissionRequest hook:** `ib hook-permission-denied {agentId}` (logs permission denials)
- **PreToolUse hooks:**
  - `ib hook-check-path {agentId}` (all agents: path isolation)
  - `ib hooks intercept-task` (managers only: spawn ib agents on Task/Agent tool calls)
- **SessionStart hook:** `ib hooks session-start` (all agents: role-specific context injection)

---

## Coordinator System (src/coordinator.ts)

### System Coordinator

**Hardcoded permissions (not configurable):**
- **Allow:** `["Bash(ib:*)", "ToolSearch"]`
- **Deny:** `["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TaskOutput", "Agent", "KillShell", "EnterPlanMode", "ExitPlanMode"]`

**Model:** `config["coordinator.model"]` or default "opus"

**Location:** `~/.itsybitsy/` (system-wide)

### Per-Repo Coordinator

**Hardcoded allow list:**
```typescript
const PER_REPO_COORDINATOR_ALLOW = [
  "Bash(ib:*)",
  "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
  "Bash(git show:*)", "Bash(git ls-files:*)",
  "Bash(pwd:*)", "Bash(ls:*)",
  "Read", "Glob", "Grep", "LS",
];
```

**Hardcoded deny list:**
```typescript
const PER_REPO_COORDINATOR_DENY = [
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "WebFetch", "WebSearch", "Task", "TaskOutput", "Agent", "KillShell",
  "EnterPlanMode", "ExitPlanMode",
];
```

**Config merge algorithm (`buildPerRepoCoordinatorSettings()`):**
1. Read `permissions.coordinator.allow/deny` and `permissions.all.allow/deny` from config
2. Filter config allow entries that conflict with hardcoded deny (silently drop)
3. Merge: `[...hardcodedAllow, ...filteredConfigAllow]`
4. Merge deny: `[...hardcodedDeny, ...configDeny]`
5. Return final permissions

**Key constraint:** Config allow entries in hardcoded deny list are *dropped*, not applied.

**Model:** `config["coordinator.model"]` or default "opus"

---

## Coordinator-Specific Restrictions (src/hooks/intercept-task.ts)

### Shell Metacharacter Blocking

Coordinator Bash commands cannot contain: `;`, `|`, `&`, `` ` ``, `>`, `<`, `$()`, `${}`, `$'`, newlines

**Regex:** `/[;|&`><]|\$\(|\$\{|\$'|\n|\r/`

**Use case:** Prevents bypassing Bash(ib:*) permission via piped commands

### Git Output Flag Blocking

Coordinator git commands cannot use `--output` flag (prevents file writes without shell metacharacters)

### Task/Agent Tool Interception

Stored in `SKIP_SUBAGENT_TYPES`:
```typescript
const SKIP_SUBAGENT_TYPES = [
  "Bash",
  "statusline-setup",
  "claude-code-guide",
  "meta-agent",
  "ib-merge",
];
```

**Behavior:** These subagent types bypass interception and run directly (not spawned as ib agents)

### Valid Models for Task Interception

```typescript
const VALID_MODELS = new Set(["sonnet", "opus", "haiku", ""]);
```

Invalid model → defaults to empty string (no --model flag passed to spawned agent)

---

## CLI Flags (newAgent Options)

### New-Agent CLI Signature

```typescript
export interface NewAgentOptions {
  worker?: boolean;        // --worker: spawn as worker (not manager)
  coordinator?: boolean;   // --coordinator: spawn as per-repo coordinator
  model?: string;          // --model: override model selection
  yolo?: boolean;          // --yolo: skip permissions, --dangerously-skip-permissions
  name?: string;           // --name: custom agent ID
  noWorktree?: boolean;    // --no-worktree: no git worktree isolation
  allowTools?: string;     // --allow: comma-separated tool list
  denyTools?: string;      // --deny: comma-separated tool list
  print?: boolean;         // --print: print result, don't spawn tmux
  manager?: string;        // --manager: explicit parent agent ID
  _cwd?: string;           // (internal testing) override cwd
}
```

### Validation Rules

| Flag | Validation | Rule |
|------|-----------|------|
| `--model` | `isValidModel()` | `/^[a-zA-Z0-9._-]+$/` |
| `--allow` / `--deny` | `isValidToolList()` | `/^[a-zA-Z0-9_*()\-:,. ]+$/` |
| `--name` | Custom regex | `/^[a-zA-Z0-9_\-]+$/` |
| `--worker` / `--coordinator` | Mutual exclusive | Both cannot be true |
| `--coordinator` + `--no-worktree` | Forbidden | Coordinators require worktree |
| `--yolo` | Escalation check | Parent must also be yolo to escalate |

### Model Fallback Chain

```
--model CLI > config (coordinator.model | model) > "opus"
```

---

## Validation Rules (src/validation.ts)

| Function | Pattern | Purpose |
|----------|---------|---------|
| `isValidModel()` | `/^[a-zA-Z0-9._-]+$/` | Model names (claude-*, sonnet-*, opus-*, etc.) |
| `isValidToolList()` | `/^[a-zA-Z0-9_*()\-:,. ]+$/` | Comma-separated tool names with wildcards |
| `isValidAgentId()` | `/^[a-zA-Z0-9_-]+$/` | Agent IDs, names |
| `isValidTmuxSession()` | `/^[a-zA-Z0-9_-]+$/` | Tmux session names |
| `isValidSessionId()` | `/^[a-fA-F0-9-]+$/` | Claude session UUID |
| `isValidShellPath()` | No null bytes or newlines | File paths in shell scripts |
| `isValidSource()` | `/^[\w-]+$/` | Inbox message sources |
| `isValidInboxFilename()` | `/^\d+-[0-9a-f]{4}-[\w-]+\.msg$/` | Inbox message filenames |

**Shell quoting:** `shellQuote(value)` uses the standard idiom: `'value'.replace(/'/g, "'\\''")` 

---

## Yolo Mode

**Activation:** `--yolo` flag on `ib new-agent`

**Effects:**
1. Agent created with `yolo: true` in meta.json
2. start.sh gets `--dangerously-skip-permissions` flag
3. Skips workspace trust dialogs

**Escalation check:** Can only be enabled if parent agent is also yolo (prevents permission escalation from restricted parent)

**Code:** `newAgent()` lines 1502-1525

---

## Per-Agent-Type Configuration Needs

For a hypothetical new agent type system, these config keys would need to be per-type:

### Knobs That Should Be Per-Type

1. **Permissions**
   - `permissions.{type}.allow` (already exists for manager/worker/coordinator)
   - `permissions.{type}.deny` (already exists)

2. **Model Selection**
   - `model.{type}` (currently only `model` global + `coordinator.model`)

3. **Role-Specific Constraints** (NEW)
   - `{type}.allowWorktree` (boolean) — require/forbid git worktree
   - `{type}.allowWorkerChildren` (boolean) — can spawn worker sub-agents
   - `{type}.allowCoordinatorChildren` (boolean) — can spawn coordinators
   - `{type}.skipPermissionDialogs` (boolean) — auto-accept workspace trust
   - `{type}.allowTaskInterception` (boolean) — intercept Task/Agent tools
   - `{type}.maxConcurrentChildren` (number) — concurrent sub-agents limit

4. **Hooks** (future)
   - `hooks.{type}.PreToolUse` (array) — custom pre-tool hooks
   - `hooks.{type}.PermissionRequest` (array) — custom permission hooks

### Constraints for Validation

Any agent type definition should enforce:

1. **Permission Sets**
   - Hardcoded mandatory allow list (always enforced)
   - Hardcoded deny list (config allow entries conflicting with deny are dropped)
   - Config allow/deny entries are merged/deduplicated

2. **Model Selection**
   - Must be a valid model name per `isValidModel()`
   - Fallback chain: CLI --model > config > default

3. **Tool Lists** (for --allow/--deny)
   - Must match `isValidToolList()` pattern
   - Merged with mandatory permissions (not replaced)

4. **Coordinator-Specific**
   - Read-only file access only (Write/Edit/MultiEdit in deny list)
   - Shell metacharacter blocking via regex
   - Cannot use non-ib Bash commands (require manual approval)
   - Task/Agent tool interception (skips certain types)

5. **Worker-Specific**
   - Cannot manage sub-agents (no Task/Agent tool interception)
   - Cannot spawn other workers or coordinators
   - Cannot escalate permissions via yolo

6. **Manager-Specific**
   - Can spawn worker sub-agents
   - Can use Task/Agent tools (intercepted to spawn ib agents)
   - Can create PRs if config enabled

---

## Existing Permission Merging Examples

### Manager Agent (from ib new-agent)
```javascript
// Config values
roleAllow = config["permissions.manager.allow"]?.value ?? []
roleDeny = config["permissions.manager.deny"]?.value ?? []
allAllow = config["permissions.all.allow"]?.value ?? []
allDeny = config["permissions.all.deny"]?.value ?? []
configAllow = dedup([...roleAllow, ...allAllow])
configDeny = dedup([...roleDeny, ...allDeny])

// buildAgentSettings merges:
finalAllow = dedup([
  ...ibPerms,  // mandatory
  ...configAllow
])
finalDeny = dedup([
  "EnterPlanMode", "ExitPlanMode",  // hardcoded blocked
  ...configDeny
])
```

### Per-Repo Coordinator (from buildPerRepoCoordinatorSettings)
```javascript
configAllow = config["permissions.coordinator.allow"]?.value ?? []
configDeny = config["permissions.coordinator.deny"]?.value ?? []
allAllow = config["permissions.all.allow"]?.value ?? []
allDeny = config["permissions.all.deny"]?.value ?? []

hardcodedDenySet = new Set(PER_REPO_COORDINATOR_DENY)
filteredConfigAllow = filter(
  [...configAllow, ...allAllow],
  entry => !hardcodedDenySet.has(entry)  // drop conflicts
)

finalAllow = dedup([
  ...PER_REPO_COORDINATOR_ALLOW,  // hardcoded
  ...filteredConfigAllow
])
finalDeny = dedup([
  ...PER_REPO_COORDINATOR_DENY,  // hardcoded
  ...configDeny,
  ...allDeny
])
```

**Key difference:** Coordinator config allow entries that conflict with hardcoded deny are *silently filtered*, while manager/worker allow lists are simply merged.

---

## Summary of Knobs in Current System

### Global Knobs (apply to all agents)
- `maxAgents` — max concurrent agents per repo
- `model` — default model (overridden by coordinator.model for coordinators)
- `createPullRequests` — auto-create PRs on merge (managers only)
- `allowAgentQuestions` — allow agents to ask questions
- `autoCompactThreshold` — context usage % for auto-compact
- `externalDiffTool` — diff tool override
- `hooks.injectStatus` — enable stop hook
- `hooks.statusVisible` — show stop hook messages
- `permissions.all.allow/deny` — apply to all agents

### Manager-Specific Knobs
- `permissions.manager.allow/deny`

### Worker-Specific Knobs
- `permissions.worker.allow/deny`

### Coordinator-Specific Knobs
- `coordinator.model` — model for both system and per-repo coordinators
- `permissions.coordinator.allow/deny` — per-repo coordinator only (system coordinator hardcoded)

### CLI-Specific Knobs
- `--worker` — spawn as worker
- `--coordinator` — spawn as per-repo coordinator
- `--model` — override model
- `--yolo` — skip permissions
- `--name` — custom ID
- `--no-worktree` — no git isolation
- `--allow` — comma-separated tool allow list
- `--deny` — comma-separated tool deny list
- `--manager` — explicit parent agent

---

## Notes on Agent Type Extensibility

To support new agent types beyond manager/worker/coordinator, the system would need:

1. **Config schema expansion**
   - `permissions.{newtype}.allow/deny` arrays
   - `model.{newtype}` string (or use global model fallback)
   - Type-specific feature flags (allowWorktree, allowChildren, etc.)

2. **buildAgentSettings() enhancement**
   - Accept agentType parameter (currently hardcoded "manager" | "worker")
   - Extend to support additional types
   - Apply role-specific permission merging based on type

3. **buildPerRepoCoordinatorSettings() pattern**
   - Each type could have hardcoded allow/deny lists
   - Config entries filter against hardcoded deny (not added to allow)
   - Merge with config values

4. **Intercept-task type checking**
   - Extend `SKIP_SUBAGENT_TYPES` to include type-specific skip lists
   - Allow types to opt-in/out of Task/Agent tool interception

5. **Validation layers**
   - Type-specific validation rules for model, tools, paths
   - Type-specific constraints (worktree required? can spawn children?)


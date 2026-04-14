# itsybitsy Hooks System Analysis

## Overview
itsybitsy implements 5 native hooks that intercept Claude's tool calls to enforce security, resource isolation, and agent spawning policies. These hooks run **inside agent sessions** as PreToolUse, PermissionRequest, and SessionStart hooks, and are configured in `settings.json`.

---

## Hook Files & Locations

| File | Hook Type | Purpose |
|------|-----------|---------|
| `src/hooks/intercept-task.ts` | PreToolUse | Intercepts Task/Agent/TaskCreate tools; spawns ib agents instead |
| `src/hooks/agent-path.ts` | PreToolUse | Path isolation; blocks access to other agents' worktrees and main repo |
| `src/hooks/session-start.ts` | SessionStart | Injects role-specific instructions (manager/worker/coordinator/primary) |
| `src/hooks/permission-denied.ts` | PermissionRequest | Logs tool denials to agent.log |
| `src/hooks/shared.ts` | Utilities | Shared patterns: `AGENT_CWD_PATTERN` regex |

---

## Hook Execution Flow

### Input/Output Schema (stdin/stdout JSON)

All **PreToolUse hooks** receive stdin and output stdout as JSON:

#### Input (stdin) — Common format for all PreToolUse hooks:
```json
{
  "tool_name": "Task|Agent|TaskCreate|Read|Write|Bash|...",
  "tool_input": {
    "prompt": "...",           // Task/Agent only
    "description": "...",      // Task/Agent only
    "command": "...",          // Bash only
    "file_path": "...",        // Read/Write/Edit
    "path": "...",             // Glob/Grep
    "notebook_path": "...",    // NotebookEdit
    "subagent_type": "..."     // Agent only
    // ... other tool-specific fields
  },
  "cwd": "/Users/adamwulf/Developer/bun/itsybitsy/.ittybitty/agents/agent-abc123/repo"
}
```

#### Output (stdout) — Allow/Deny decision:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny",
    "permissionDecisionReason": "Human-readable explanation"
  }
}
```

**Decision semantics:**
- `"allow"` — tool call proceeds normally
- `"deny"` — tool call is blocked; Claude sees the reason and does NOT retry

---

## Hook 1: intercept-task.ts (PreToolUse)

**Purpose:** Intercept Task/Agent/TaskCreate tool calls and spawn ib agents instead of executing inline.

### How it works:

1. **Filters for specific tools** (line 121):
   - Only intercepts: `Task`, `Agent`, `TaskCreate`
   - All other tools → `action: "skip"` (allow)

2. **Checks worker restrictions** (lines 125-157):
   - Reads `meta.json` to determine if calling agent is a worker
   - Workers CANNOT spawn sub-agents
   - Returns deny if `worker: true` and `canSpawnChildren()` returns false

3. **Skips certain subagent types** (lines 159-162):
   - Skip list: `Bash`, `statusline-setup`, `claude-code-guide`, `meta-agent`, `ib-merge`
   - These tools bypass the hook entirely

4. **Extracts prompt and model** (lines 165-179):
   - Uses `prompt` field; falls back to `description`
   - Validates model against whitelist: `"sonnet" | "opus" | "haiku" | ""`

5. **Spawns ib agent** (lines 182-205):
   - Determines `repoPath` from `cwd` (strips `.ittybitty/agents/...` portion)
   - Sets spawn options:
     - If called from within an agent: `worker: true`, `manager: <callingAgentId>`
     - If called from primary Claude: `worker: undefined`, `manager: undefined`
   - Calls `newAgent(repoPath, agentPrompt, spawnOpts)`

6. **Returns deny on success** (lines 226-241):
   - Even when spawn succeeds, returns `permissionDecision: "deny"`
   - Reason tells Claude: "ib agent {id} has been spawned — monitor with `ib look {id}`, do NOT retry"
   - This prevents double-spawning if Claude retries the tool call

### Coordinator Bash restrictions (lines 39-100):

Special checks for coordinators (non-worktree agents):

```javascript
// Block shell metacharacters in Bash commands
const SHELL_METACHARACTERS = /[;|&`><]|\$\(|\$\{|\$'|\n|\r/;

// Detects coordinator via meta.json: coordinator === true
// Blocks: ; | & ` > < $() ${ $' newlines
// Blocks: git commands with --output flag (file write bypass)
```

### Key Code Locations:
- Worker check: `canSpawnChildren()` imported from `src/agents.ts`
- Spawn logic: `newAgent()` imported from `src/ib-commands.ts`
- Coordinator detection: lines 56-61

### Tests (intercept-task.test.ts):
- ✓ Skip non-Task/Agent tools
- ✓ Intercept Agent tool
- ✓ Deny worker from spawning Task
- ✓ Deny worker from using TaskCreate
- ✓ Intercept TaskCreate from manager and spawn worker

---

## Hook 2: agent-path.ts (PreToolUse)

**Purpose:** Enforce path isolation — agents can only access files within their own worktree, their agent.log, and system paths.

### How it works:

1. **Validates allow list** (lines 82-94):
   - Checks if tool matches the agent's allow list in `settings.local.json`
   - Supports two patterns:
     - Exact name: `"Read"`, `"Write"`, `"Bash"`
     - Bash prefix: `"Bash(ib:*)"` matches `ib send`, `ib look`, etc.

2. **Bash tool special handling** (lines 96-125):
   - If tool is `Bash` and command is `cd ...`:
     - Extracts cd target, resolves it, checks if it's allowed
     - Blocks cd into other agents' directories
   - If tool is `Bash` but not cd:
     - Calls `checkBashCommandPaths()` to scan for forbidden directory references
     - Blocks paths like `cat /repo/.ittybitty/agents/agent-other/secret.ts`
   - Returns allow if in allow list (no path violation)

3. **File path extraction** (lines 127-136):
   - Looks for one of: `file_path`, `path`, `notebook_path`
   - Calls `checkFilePath()` for validation

4. **Path resolution** (lines 194-241 in checkFilePath):
   - Relative → absolute via `cwd`
   - Normalize via `path.resolve()` and `realpathSync()` (symlink resolution)
   - **Allow** if within worktree: `filePath.startsWith(worktreePath + "/")`
   - **Allow** if accessing own agent.log
   - **Deny** if in other agents' directories
   - **Deny** if in main repo (outside worktree)
   - **Allow** all other system paths (`/tmp`, `~/.claude`, etc.)

5. **ib command manager checks** (lines 244-338):
   - Parses `ib <subcommand> <agent-id>` commands
   - Manager-only commands: `kill`, `nuke`, `merge`, `resume`, `pause`, `reassign`
   - Reads target agent's `meta.json` to get `manager` field
   - Only the agent's manager can run manager-only commands
   - Workers can read: `send`, `look`, `diff`, `status`, `merge-check`

### Pattern Matching (toolMatchesPattern):

```typescript
// Exact match
toolMatchesPattern("Read", {}, "Read") → true

// Bash prefix pattern
toolMatchesPattern("Bash", { command: "ib send foo" }, "Bash(ib:*)") → true
toolMatchesPattern("Bash", { command: "git status" }, "Bash(ib:*)") → false
```

### Bash Command Path Scanning (checkBashCommandPaths):

Scans command string for references to forbidden directories:
```typescript
// Blocks: cat /repo/.ittybitty/agents/agent-other/file
// Blocks: grep -r pattern /repo (when /repo is outside worktree)
// Only matches at word boundaries: space, quote, =, or start of string
```

### Key Code Locations:
- Pattern matching: lines 47-67
- File path validation: lines 194-241
- ib command parsing: lines 272-287
- Manager check: lines 296-338

### Tests (agent-path.test.ts):
- ✓ Allow own worktree path
- ✓ Block other agent directory
- ✓ Block main repo path
- ✓ Allow system paths
- ✓ Allow own agent.log
- ✓ Tool not in allow list
- ✓ Bash cd extraction — blocks cd to other agent
- ✓ Bash non-cd command → allow

---

## Hook 3: session-start.ts (SessionStart)

**Purpose:** Inject role-specific instructions at session start based on agent type.

### Role Detection (detectRole function):

```typescript
// Reads from meta.json:
// - coordinator: true → role = "coordinator"
// - worker: true → role = "worker"
// - type: "custom-type" → role = "custom" (resolves agent type definition)
// - Default → role = "manager"
// - Not in agent context → role = "primary"

// Returns SessionContext:
{
  role: "primary" | "manager" | "worker" | "coordinator" | "custom",
  agentId: string,
  agentManager: string,  // manager's agent ID
  parentBranch: string,  // "agent/{manager}" or "main"
  branchName: string,    // "agent/{agentId}"
  worktreePath: string,
  rootRepoPath: string,
  typeName?: string,
  typeDef?: AgentTypeDefinition
}
```

### Instruction Injection:

The hook generates ~300+ lines of instructions injected into Claude's system context, including:
- Role-specific permissions (manager vs worker)
- Available tools and ib commands
- Git workflow (branch, worktree, merge strategy)
- Task completion signal (WAITING or I HAVE COMPLETED THE GOAL)

### Key Code Locations:
- Role detection: lines 28-99
- Custom agent type resolution: line 8 (resolveAgentType imported)

---

## Hook 4: permission-denied.ts (PermissionRequest)

**Purpose:** Log tool permission denials to agent.log.

### How it works:

1. Reads `tool_name` from stdin JSON
2. Derives agent directory from cwd pattern
3. Logs to agent.log: `[PermissionRequest] Tool denied: {tool_name}`
4. Exits 0 (PermissionRequest hooks cannot override permissions)

### Use case:
Tracks which tools agents attempt but don't have permission for — useful for debugging access issues.

---

## Bash Tool Interception — Current Implementation

### Current flow:

1. **Allow list check** (agent-path.ts):
   - Agent's `settings.local.json` specifies which Bash prefixes are allowed
   - Example: `permissions.allow: ["Read", "Write", "Bash(ib:*)"]`
   - Means: Can run `ib` commands, but not other Bash commands

2. **Path isolation check** (agent-path.ts):
   - For `cd` commands: validates target directory
   - For other commands: scans for forbidden paths (other agents, main repo)
   - Blocks shell metacharacters for coordinators

3. **ib manager check** (agent-path.ts):
   - Parses `ib <subcommand> <agent-id>` commands
   - Validates calling agent is the target's manager
   - Allows read-only: `send`, `look`, `diff`, `status`, `merge-check`

### Bash Metacharacter Blocking (Coordinators only):

```typescript
// Blocked for coordinators:
const SHELL_METACHARACTERS = /[;|&`><]|\$\(|\$\{|\$'|\n|\r/;

// Example denials:
// "ib send agent-123 msg; rm -rf /" → DENY
// "git log | grep pattern" → DENY
// "git log" → ALLOW (no metacharacters)
```

This prevents shell chaining that could bypass `Bash(ib:*)` prefix validation.

---

## Hook Registration & Installation

Hooks are registered in Claude Code's `settings.json`:

```json
{
  "hooks": {
    "session-start": "ib hook-session-start {agentId}",
    "pretooluse": [
      "ib hook-intercept-task",
      "ib hook-check-path {agentId}"
    ],
    "permissionrequest": "ib hook-permission-denied {agentId}"
  }
}
```

Installed by:
- `ib-commands.ts`: `installSafetyHooks()`, `uninstallSafetyHooks()`
- Reads/writes `~/.claude/settings.json`
- Uses `hooksStatus()` to detect current installation state

---

## stdin JSON Schema Summary

### All PreToolUse Hooks receive:

```typescript
{
  tool_name: string;           // "Bash", "Read", "Task", etc.
  tool_input: Record<string, unknown>;  // Tool-specific fields
  cwd: string;                 // Current working directory
}
```

### tool_input fields by tool:

| Tool | Fields | Purpose |
|------|--------|---------|
| Task/Agent/TaskCreate | `prompt`, `description`, `model`, `subagent_type` | Spawn ib agents |
| Bash | `command` | Shell commands |
| Read | `file_path` | Path to read |
| Write | `file_path` | Path to write |
| Edit | `file_path` | Path to edit |
| Glob | `path` | Directory pattern |
| Grep | `path` | File pattern |
| NotebookEdit | `notebook_path` | Notebook path |

---

## Decision Flow Diagram

```
PreToolUse Hook Input (stdin JSON)
↓
[intercept-task.ts]
├─ Is Task/Agent/TaskCreate? → NO → skip (allow)
├─ Is calling agent a worker? → YES → deny (workers can't spawn)
├─ Spawn ib agent → fail? → deny (with error reason)
└─ Spawn ib agent → success? → deny (with "use ib look" message)
↓
[agent-path.ts]
├─ Is tool in allow list? → NO → deny (not in allow list)
├─ Is Bash cd command? → YES → validate path destination
├─ Is Bash non-cd? → YES → scan for forbidden directory refs
├─ Resolve file path (relative→absolute, symlinks)
├─ Is in own worktree? → YES → allow
├─ Is own agent.log? → YES → allow
├─ Is other agent's dir? → YES → deny
├─ Is main repo? → YES → deny
└─ Is system path? → YES → allow
↓
Output: { hookSpecificOutput: { permissionDecision: "allow"|"deny", ... } }
```

---

## Key Insights

1. **Interception model**: Task/Agent tools are intercepted and spawned as ib agents, not executed inline. Claude never directly executes Task tool calls.

2. **Allow list pattern**: `Bash(prefix:*)` is a clever way to whitelist commands by prefix — prevents shell metacharacters from bypassing the whitelist.

3. **Manager relationship enforcement**: ib manager-only commands are blocked unless the calling agent is listed as the target's manager in meta.json.

4. **Coordinator restrictions**: Non-worktree agents (coordinators) have stricter Bash restrictions — no shell metacharacters allowed.

5. **Fail-safe**: All hooks fail open (allow) on parsing/IO errors — prevents agent sessions from breaking due to hook bugs.

6. **Deny on success**: When Task/Agent is successfully spawned, the hook returns "deny" to prevent Claude from retrying the tool call.

---

## Testing

Run all hook tests:
```bash
bun test src/hooks/
```

Individual test files:
- `src/hooks/intercept-task.test.ts` — 20+ tests covering worker restrictions, spawn logic, coordinator blocks
- `src/hooks/agent-path.test.ts` — 30+ tests covering path isolation, pattern matching, ib command access
- `src/hooks/session-start.test.ts` — role detection tests
- `src/hooks/permission-denied.test.ts` — logging tests

---

## Bash Command Interception Summary

**What gets blocked:**
- Shell chains: `cmd1 ; cmd2` / `cmd1 && cmd2` / `cmd1 | cmd2` (for coordinators)
- Command substitution: `$(...)` / `${...}` (for coordinators)
- Redirects: `>`, `<`, `>>` (for coordinators)
- Paths to other agents: `/repo/.ittybitty/agents/agent-other/...`
- Paths to main repo: `/repo/src/...` (when outside worktree)
- cd into forbidden dirs

**What gets allowed:**
- Commands in allow list: `ib send`, `ib look`, `ib merge`, `git status`, etc.
- Any Bash command for agents that have `Bash` in allow list (not prefix-restricted)
- Paths within own worktree
- System paths: `/tmp`, `~/.claude`, `/usr/bin`, etc.
- Own agent.log


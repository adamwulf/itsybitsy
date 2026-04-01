# itsybitsy Config & Permission System Research

## Overview

The itsybitsy permission system operates through two mechanisms:

1. **Global config** (src/config.ts) — loads role-based permissions from `~/.itsybitsy/config.json`
2. **Hook enforcement** (src/hooks/) — applies those permissions at pre-tool-use time

Permissions are **per-role** (manager, worker, coordinator) and **per-scope** (all, repo), allowing fine-grained control over which tools each agent type can use.

---

## 1. Config System (src/config.ts)

### Configuration Keys

The config system defines role-based permissions via **dot-notation keys** (src/config.ts:20-40):

```typescript
// Global allow/deny lists
{ key: "permissions.all.allow", type: "string[]", default: [] }
{ key: "permissions.all.deny", type: "string[]", default: [] }

// Manager-role permissions
{ key: "permissions.manager.allow", type: "string[]", default: [] }
{ key: "permissions.manager.deny", type: "string[]", default: [] }

// Worker-role permissions
{ key: "permissions.worker.allow", type: "string[]", default: [] }
{ key: "permissions.worker.deny", type: "string[]", default: [] }

// Coordinator-role permissions
{ key: "permissions.coordinator.allow", type: "string[]", default: [] }
{ key: "permissions.coordinator.deny", type: "string[]", default: [] }

// Repo-scope permissions (future use)
{ key: "permissions.repo.allow", type: "string[]", default: [] }
{ key: "permissions.repo.deny", type: "string[]", default: [] }
```

### Config Sources & Merging

Config is loaded from **two sources**:

1. **User config** (`~/.itsybitsy/config.json`) — takes precedence
2. **Defaults** — fallback values defined in CONFIG_KEYS

Example (src/config.ts:106-124):

```typescript
export async function readConfig(options?: ReadConfigOptions): Promise<ConfigResult> {
  const userPath = options?.userConfigPath ?? defaultUserConfigPath();
  const userData = await readJsonFile(userPath);  // Load from ~/.itsybitsy/config.json
  
  const result: ConfigResult = {};
  for (const def of CONFIG_KEYS) {
    const userVal = getNestedValue(userData, def.key);
    // If user value exists and is valid type, use it
    if (userVal !== undefined && validateConfigValue(userVal, def.type)) {
      result[def.key] = { value: userVal, source: "user" };
      continue;
    }
    // Otherwise use default
    result[def.key] = { value: def.default, source: "default" };
  }
  return result;
}
```

Each config entry is returned as `ConfigEntry` with `{ value, source }` tuple, allowing the caller to know whether a setting came from the user or defaults.

### Nested Value Access

Config keys use **dot notation** (e.g., `permissions.manager.allow`) and are resolved recursively via `getNestedValue()` (src/config.ts:42-50):

```typescript
function getNestedValue(obj: Record<string, unknown>, dotKey: string): unknown {
  const parts = dotKey.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
```

---

## 2. Per-Role Allow/Deny Lists

### The Four Agent Roles

Each agent role has its own **allow list** (what tools are permitted) and **deny list** (what tools are explicitly blocked):

| Role | Use Case | Default Allow | Default Deny |
|------|----------|----------------|--------------|
| **all** | Global fallback | `[]` | `[]` |
| **manager** | Spawns workers, oversees work | `[]` | `[]` |
| **worker** | Spawned workers, report to manager | `[]` | `[]` |
| **coordinator** | System-wide or per-repo coordination | (fixed, see below) | (fixed, see below) |

### Coordinator Permissions (Fixed)

Unlike manager/worker (configurable), the **coordinator role has fixed, hardcoded permissions** that cannot be overridden by config:

**System Coordinator** (src/coordinator.ts:61-89):

```typescript
const SYSTEM_COORDINATOR_ALLOW = ["Bash(ib:*)", "ToolSearch"];

const SYSTEM_COORDINATOR_DENY = [
  "Read", "Write", "Edit", "MultiEdit",
  "Glob", "Grep", "LS", "NotebookEdit",
  "WebFetch", "WebSearch",
  "Task", "TaskOutput", "Agent",
  "KillShell", "EnterPlanMode", "ExitPlanMode",
];
```

**Intent:** System coordinators can **only** run `ib` commands and search tool availability; they cannot read/write files or spawn agents.

**Per-Repo Coordinator** (src/coordinator.ts:407-410):

Per-repo coordinators blend **hardcoded base** + **config-based override**:

```typescript
const roleAllow = (config["permissions.coordinator.allow"]?.value as string[] | undefined) ?? [];
const roleDeny = (config["permissions.coordinator.deny"]?.value as string[] | undefined) ?? [];
// ... merged with base coordinator allow/deny
```

---

## 3. Hook Validation: intercept-task.ts

The **intercept-task hook** (PreToolUse) intercepts Task and Agent tool calls and converts them to `ib new-agent` spawns instead. It enforces two types of validation:

### A. Agent Spawning Rules

**Skip spawning** (allow Task/Agent to pass through unchanged) for:

- Worker agents calling Task/Agent (workers can't spawn sub-agents)
- Certain safe subagent types: Bash, statusline-setup, claude-code-guide, meta-agent, ib-merge
- Missing or empty prompt/description

Example (src/hooks/intercept-task.ts:123-150):

```typescript
// 2. Check if calling from a worker agent
if (cwdMatch) {
  const agentId = cwdMatch[1]!;
  // ... read meta.json ...
  if (meta.worker === true) {
    return { action: "skip" };  // Workers cannot spawn
  }
}

// 3. Check subagent_type skip list
const SKIP_SUBAGENT_TYPES = [
  "Bash", "statusline-setup", "claude-code-guide", 
  "meta-agent", "ib-merge",
];
if (SKIP_SUBAGENT_TYPES.includes(subagentType)) {
  return { action: "skip" };
}
```

**Intercept & spawn** (convert to `ib new-agent`) for:

- Manager and primary Claude spawning Task/Agent calls
- Valid prompt + description provided
- Valid model (sonnet, opus, haiku, or unspecified)

Spawned agents inherit role context:

```typescript
// 9. Determine spawn options
const spawnOpts: Record<string, unknown> = {
  worker: callingAgentId ? true : undefined,  // Calling agent → make spawn a worker
  manager: callingAgentId,                     // Set the manager relationship
  model: model || undefined,                   // Propagate model preference
};
```

### B. Coordinator Bash Restrictions (SPEC §12.2.4)

Coordinators have **Bash restrictions** to prevent shell injection:

```typescript
// Block shell metacharacters
const SHELL_METACHARACTERS = /[;|&`><]|\$\(|\$\{|\$'|\n|\r/;

// Block --output in git commands (file write bypass)
if (command.startsWith("git") && command.includes("--output")) {
  return { action: "intercept", ... /* deny */ };
}
```

**Intent:** Prevent coordinators from chaining commands or writing files without going through proper file-write tools (which they don't have).

---

## 4. Hook Application: agent-path.ts

The **agent-path hook** (PreToolUse) enforces **path isolation** and uses the **allow list** to gate which tools are available:

### Allow List Pattern Matching

Patterns support two formats (src/hooks/agent-path.ts:47-67):

1. **Exact tool match**: `"Bash"`, `"Read"`, `"Write"`
2. **Bash prefix match**: `"Bash(ib:*)"` — matches Bash commands starting with `ib `

```typescript
export function toolMatchesPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
  pattern: string
): boolean {
  // Bash(prefix:*) pattern
  const bashMatch = pattern.match(/^Bash\(([^:]+):\*\)$/);
  if (bashMatch) {
    const prefix = bashMatch[1]!;
    if (toolName === "Bash") {
      const command = String(toolInput.command ?? "");
      if (command === prefix || command.startsWith(prefix + " ")) {
        return true;
      }
    }
    return false;
  }
  // Exact match
  return pattern === toolName;
}
```

### Allow List Flow

The hook loads the **allow list from `.claude/settings.local.json`** (not from config.json) — settings.local.json is what Claude Code reads:

```typescript
// agent-path.ts:418-428
let allowList: string[] = [];
try {
  const settingsPath = join(worktreePath, ".claude", "settings.local.json");
  const settingsFile = Bun.file(settingsPath);
  if (await settingsFile.exists()) {
    const settings = await settingsFile.json();
    if (Array.isArray(settings?.permissions?.allow)) {
      allowList = settings.permissions.allow;
    }
  }
}
```

The **coordinator module** builds these settings for per-repo coordinators by reading `permissions.coordinator.allow` from config and writing it to settings.local.json (src/coordinator.ts:397-410).

### Path Isolation Decision Tree

Once a tool is allowed by the allow list, path checks are applied:

1. **TaskCreate is always denied** (must use `ib new-agent` instead)
2. **Bash cd commands** — check resolved path is in worktree or `.ittybitty/agents/{self}/`
3. **Other Bash commands** — scan for references to other agents' dirs or main repo
4. **File-path tools** — verify file_path/path/notebook_path resolves to worktree or own agent.log
5. **System paths** — `/usr/bin`, `~/.claude`, etc. are allowed if in allow list

Example denials (src/hooks/agent-path.ts:233-245):

```typescript
// 9. Block: other agents' directories
if (filePath.startsWith(agentsDir + "/")) {
  return { decision: "deny", reason: "Access denied: cannot access other agents' files" };
}

// 10. Block: main repo (outside worktree)
if (rootRepo && filePath.startsWith(rootRepo + "/") && !filePath.startsWith(worktreePath + "/")) {
  return { decision: "deny", reason: "Access denied: work in your worktree, not the main repo" };
}

// 11. Allow: all other paths (system files, ~/.claude, etc.)
return { decision: "allow", reason: "Tool in allow list" };
```

---

## 5. Permission Flow Summary

```
┌─ User calls `ib new-agent --worker "task"`
│
├─ Agent spawned, writes meta.json { worker: true, manager: <caller-id> }
│
├─ Agent session starts → reads `~/.itsybitsy/config.json`
│  └─ Config keys like `permissions.worker.allow` are read but...
│
└─ Claude Code loads `.claude/settings.local.json` in worktree
   ├─ For workers: config.ts builds worker permissions from config
   │  and writes to worktree/.claude/settings.local.json
   │
   ├─ PreToolUse hook (intercept-task) fires
   │  ├─ Task/Agent calls → converted to `ib new-agent` (with worker flag)
   │  └─ Coordinator Bash → blocked if contains metacharacters
   │
   └─ PreToolUse hook (agent-path) fires
      ├─ Loads allow list from settings.local.json
      ├─ Checks tool against allow list
      └─ If allowed, checks path isolation
```

---

## 6. Configuration Example

**User config** (`~/.itsybitsy/config.json`):

```json
{
  "maxAgents": 10,
  "model": "opus",
  "permissions": {
    "worker": {
      "allow": ["Read", "Grep", "Bash(git:*)"],
      "deny": ["Write", "Edit", "Task"]
    },
    "manager": {
      "allow": ["Read", "Write", "Edit", "Bash(ib:*)"],
      "deny": []
    },
    "coordinator": {
      "allow": ["Bash(ib:*)"],
      "deny": ["Write", "Edit"]
    }
  }
}
```

**Result:**

- **Workers** can read files, search content, and run git commands, but cannot write or spawn tasks
- **Managers** can read/write/edit files and run ib commands (to manage workers)
- **Coordinators** (per-repo) can run ib commands only (system coordinators have fixed allow/deny)

---

## Key Insights

1. **Dual-config model**: Global config (`~/.itsybitsy/config.json`) + local settings (`.claude/settings.local.json` in each agent's worktree)
2. **Role hierarchy**: all > manager/worker/coordinator
3. **Allow-list pattern matching**: Supports exact tool names and Bash prefix patterns (`Bash(prefix:*)`)
4. **Coordinator special case**: System coordinators have hardcoded permissions; per-repo coordinators read from config
5. **Path isolation is the second gate**: Even if a tool is in the allow list, file paths are validated
6. **Hook separation**:
   - `intercept-task.ts` — blocks Task/Agent and enforces coordinator Bash restrictions
   - `agent-path.ts` — enforces allow lists and path isolation
7. **Worker constraint**: Workers cannot spawn sub-agents; attempting Task/Agent is silently skipped (allowed but not intercepted)

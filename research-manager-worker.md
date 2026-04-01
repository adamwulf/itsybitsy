# Manager/Worker Agent System — Research Notes

## 1. How meta.json Tracks Agent Type

The `AgentMeta` interface (`src/agents.ts:16-34`) defines the key fields:

```typescript
worker: boolean;           // true = worker, false = manager
manager: string | null;    // parent agent ID (null = top-level)
coordinator?: boolean;     // special coordinator role
```

**Creation flow** (`src/ib-commands.ts:1428-1695`):
- `newAgent()` reads `--worker` and `--coordinator` CLI flags (line 1428-1430)
- Derives `agentType = workerMode ? "worker" : "manager"` (line 1551)
- Writes these fields into `meta.json` (lines 1677-1695)

There is no separate "manager" boolean — an agent is a manager if `worker === false` and `coordinator !== true`. The `manager` field (parent ID) is orthogonal: managers can themselves have managers, enabling hierarchical chains.

## 2. Session-Start Hook: Role-Specific Injection

**File:** `src/hooks/session-start.ts`

### Role detection (`detectRole()`, lines 19-67)

Reads `meta.json` from the agent directory and maps fields to one of four roles:

| meta.json fields | Detected role |
|---|---|
| `coordinator: true` | `"coordinator"` |
| `worker: true` | `"worker"` |
| neither | `"manager"` |
| no agent context (top-level) | `"primary"` |

Returns a `SessionContext` with role, agent ID, parent branch (`agent/{managerId}` or `main`), and paths.

### Instruction generation (`generateInstructions()`, lines 69-83)

Dispatches to role-specific generators:

- **`generateManagerInstructions()`** (lines 140-248): Provides `ib new-agent --worker "task"` commands, sub-agent lifecycle management (`ib list --manager`, `ib merge`, `ib kill`), and top-level-only `ib ask` for user questions. Includes a workflow section encouraging managers to assess task size before spawning.

- **`generateWorkerInstructions()`** (lines 251-322): Provides only `ib send`, `ib diff`, `ib status`, and `ib log` commands. No mention of `ib new-agent`. Workers are told to report to their manager and wait for the manager to merge or kill their session.

- **`generateCoordinatorInstructions()`**: Specialized for the coordinator role with read-only repo access and `ib` management commands.

### Permission differences

`newAgent()` builds per-agent `settings.json` with role-aware permission lists (`src/ib-commands.ts:1552-1557`):

```typescript
const roleAllow = config[`permissions.${agentType}.allow`] ?? [];
const roleDeny  = config[`permissions.${agentType}.deny`]  ?? [];
const allAllow  = config["permissions.all.allow"] ?? [];
const allDeny   = config["permissions.all.deny"]  ?? [];
```

This allows config-level tool restrictions per role (e.g., denying `Task` or `Agent` tools to workers via `permissions.worker.deny` in `~/.itsybitsy/config.json`).

## 3. What Prevents Workers from Spawning Children

Four independent mechanisms enforce the restriction:

### Mechanism A: Intercept hook not installed for workers

`src/ib-commands.ts:1324-1353` — The `Task|Agent` PreToolUse intercept hook is only added to an agent's `settings.json` when `agentType === "manager"`. Workers never get this hook registered, so their Task/Agent tool calls are not converted into `ib new-agent` invocations.

### Mechanism B: intercept-task skips workers

`src/hooks/intercept-task.ts:100-144` — Even if a worker somehow had the intercept hook, `processTaskIntercept()` reads `meta.worker` from the calling agent's `meta.json`. If `worker === true`, it returns `{ action: "skip" }`, bypassing the intercept logic entirely. Only managers proceed to the agent-spawning code path.

### Mechanism C: Workers rejected as parent managers

`src/ib-commands.ts:1493-1500` — When `newAgent()` validates the `--manager` option, it reads the proposed parent's `meta.json`. If `meta.worker === true`, it returns an error: `"Error: '{id}' is a worker agent and cannot manage sub-agents"`. This prevents any agent from designating a worker as its manager.

### Mechanism D: Session instructions omit spawning commands

`src/hooks/session-start.ts:251-322` — Worker instructions never mention `ib new-agent` or any spawning capability. The Claude agent inside a worker session has no prompt-level awareness that spawning is possible, making it extremely unlikely to attempt it even without the other guards.

## Summary

| Aspect | Manager | Worker | Coordinator |
|---|---|---|---|
| `meta.json` identity | `worker: false` | `worker: true` | `coordinator: true` |
| Can spawn children | Yes (via intercept hook) | No (4 mechanisms block it) | Yes |
| Can be a parent | Yes | No (rejected at validation) | Yes |
| Session commands | Full lifecycle + `ib new-agent` | `ib send/diff/status/log` only | Lifecycle + read-only repo |
| Config permissions key | `permissions.manager.*` | `permissions.worker.*` | `permissions.coordinator.*` |

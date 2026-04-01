# Agent Types: Implementation Plan

## Overview

Replace the hardcoded manager/worker/coordinator roles with a user-configurable agent type system. Agent types are `.md` files with YAML front matter (configuration) and a markdown body (prompt injected at session start).

## File Location & Format

### Location

```
~/.itsybitsy/agent-types/
  manager.md          # built-in default
  worker.md           # built-in default
  coordinator.md      # built-in default (per-repo)
  reviewer.md         # user-defined example
  researcher.md       # user-defined example
  fixer.md            # user-defined example
```

**Why `~/.itsybitsy/agent-types/`**: Consistent with existing config at `~/.itsybitsy/config.json`. Simple flat directory — one `.md` file per type, named by the type name. No subdirectories needed since the markdown body contains everything.

### Format

```yaml
---
name: researcher
description: "Investigates codebases and writes research reports"
canSpawnChildren: false
model: sonnet
permissions:
  allow: []
  deny: [Write, Edit, MultiEdit, NotebookEdit]
instructionStyle: worker
---

## Research Agent

You are a research specialist. When given a research task:

1. Explore the codebase thoroughly using Read, Grep, Glob
2. Take detailed notes on architecture, patterns, and relevant code
3. Write a comprehensive report as a markdown file
4. Commit the report and signal completion

## Constraints

- Do not modify existing source code
- Focus on understanding, not implementing
- Reference specific files and line numbers in your findings
```

### Front Matter Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | filename stem | Display name of the agent type |
| `description` | string | `""` | What this agent type does (shown in selection UI) |
| `canSpawnChildren` | boolean | `false` | Whether agents of this type can spawn sub-agents via `ib new-agent` |
| `model` | string | `""` | Default model. Empty = use `config.model` / `config.coordinator.model` |
| `permissions.allow` | string[] | `[]` | Additional tools to allow (added to base set) |
| `permissions.deny` | string[] | `[]` | Additional tools to deny |
| `instructionStyle` | `"manager"` \| `"worker"` \| `"coordinator"` | inferred from `canSpawnChildren` | Which base instruction template to use for session-start |

### Built-in Defaults

Three built-in types ship with itsybitsy and are used when no custom type files exist:

**manager.md** (built-in):
```yaml
---
name: manager
description: "Manages sub-agents and coordinates work"
canSpawnChildren: true
instructionStyle: manager
---
```
(No markdown body — uses the existing hardcoded manager instructions)

**worker.md** (built-in):
```yaml
---
name: worker
description: "Executes tasks assigned by a manager"
canSpawnChildren: false
instructionStyle: worker
---
```

**coordinator.md** (built-in):
```yaml
---
name: coordinator
description: "Read-only coordinator that manages agents without writing code"
canSpawnChildren: true
instructionStyle: coordinator
permissions:
  deny: [Write, Edit, MultiEdit, NotebookEdit, WebFetch, WebSearch]
---
```

## How Type Selection Works

### CLI Changes

```bash
# Current:
ib new-agent --worker "task"
ib new-agent "task"                    # spawns as manager
ib new-agent --coordinator "task"

# New (additive, backward compatible):
ib new-agent --type researcher "task"
ib new-agent --type fixer "task"
ib new-agent --worker "task"           # still works (alias for --type worker)
ib new-agent "task"                    # still defaults to manager type
ib new-agent --coordinator "task"      # still works (alias for --type coordinator)
```

### Type Resolution Priority

1. `--type <name>` flag (explicit)
2. `--worker` flag → resolves to type `"worker"`
3. `--coordinator` flag → resolves to type `"coordinator"`
4. Default → `"manager"`

### Type Lookup Order

1. `~/.itsybitsy/agent-types/<name>.md` (user-defined)
2. Built-in defaults (hardcoded in source)

User-defined types with the same name as built-ins override them completely.

## How meta.json Changes

### Current

```json
{
  "worker": true,
  "coordinator": true
}
```

### New

```json
{
  "worker": true,
  "agentType": "researcher",
  "coordinator": true
}
```

- `agentType` field added with the resolved type name
- `worker` field **kept for backward compatibility** — set to `true` when the agent type has `canSpawnChildren: false` (i.e., it's a leaf node)
- `coordinator` field **kept for backward compatibility** — set to `true` only for the built-in coordinator type
- This ensures existing code that checks `worker === true` or `coordinator === true` continues to work during gradual migration

## How Permissions Work Per Type

### Base Permission Set

All agent types start with the same mandatory base (current `ibPerms` in `buildAgentSettings()`):
- `Bash(ib:*)`, git commands, file tools, etc.

Then the type's `permissions.allow`/`permissions.deny` are applied on top, merged with:
- `permissions.all.allow/deny` from config
- Any `--allow`/`--deny` CLI flags

### canSpawnChildren Effect on Permissions

When `canSpawnChildren: false`:
- The intercept-task hook is **not installed** (same as current worker behavior)
- Workers use Claude Code's native subagent system for Task/Agent calls
- The instruction template omits `ib new-agent` commands

When `canSpawnChildren: true`:
- The intercept-task hook **is installed** (same as current manager behavior)
- Task/Agent calls are intercepted and converted to `ib new-agent` spawns
- The instruction template includes full agent management commands

### Config Permission Keys Migration

Currently: `permissions.manager.allow/deny`, `permissions.worker.allow/deny`

These config keys continue to work by mapping to the corresponding built-in type. A new config pattern is added:

```json
{
  "permissions": {
    "all": { "allow": [], "deny": [] },
    "manager": { "allow": [], "deny": [] },
    "worker": { "allow": [], "deny": [] },
    "coordinator": { "allow": [], "deny": [] },
    "researcher": { "allow": [], "deny": [] }
  }
}
```

Config keys for custom types are dynamically recognized — any `permissions.<typeName>.allow/deny` key that matches a known agent type name is applied.

## How Session-Start Hook Changes

### Current Flow

`detectRole()` checks `worker`/`coordinator` booleans in meta.json → picks one of 4 hardcoded instruction generators.

### New Flow

1. `detectRole()` reads `agentType` from meta.json (falls back to current `worker`/`coordinator` logic for backward compat)
2. Load the type's `.md` file from `~/.itsybitsy/agent-types/<agentType>.md` or built-in defaults
3. Determine base instructions from `instructionStyle` field:
   - `"manager"` → `generateManagerInstructions()` (existing)
   - `"worker"` → `generateWorkerInstructions()` (existing)
   - `"coordinator"` → `generateCoordinatorInstructions()` (existing)
4. If the type `.md` has a markdown body, **append it** to the base instructions inside the `<ittybitty>` block
5. Return the combined instructions as `additionalContext`

This means the markdown body is **additive** — it supplements the base instruction template, not replaces it. This ensures all agent types get the essential operational instructions (bash rules, path isolation, git context, state management) while adding type-specific guidance.

## How Intercept-Task Hook Changes

### Current Behavior

- Workers: skip intercept (use native Claude subagents)
- Managers: intercept Task/Agent → spawn as worker
- Primary: intercept Task/Agent → spawn as manager

### New Behavior

- `canSpawnChildren: false` types: skip intercept (same as current workers)
- `canSpawnChildren: true` types: intercept Task/Agent → spawn as **worker** type (default) unless the parent type specifies a different child type
- Primary: intercept Task/Agent → spawn as **manager** type (unchanged)
- The `meta.worker === true` check in intercept-task.ts is replaced with reading `agentType` and checking `canSpawnChildren` from the type definition

## How Custom Prompts Migrate

### Current: `.ittybitty/prompts/`

- `all.md` → injected for all agents
- `manager.md` → injected for managers
- `worker.md` → injected for workers

### New: Coexistence

Custom prompts in `.ittybitty/prompts/` continue to work unchanged. They are injected into `prompt.txt` at agent creation time (separate from session-start instructions).

Agent type `.md` files in `~/.itsybitsy/agent-types/` are a **different mechanism** — they define the type's session-start instructions and configuration. The two systems are complementary:
- Type `.md` body → injected via session-start hook (system-level context)
- Custom prompts → injected into prompt.txt (per-repo task-level context)

## Implementation Steps

### Step 1: Agent Type Loader (`src/agent-types.ts`)

New module that:
- Defines the `AgentType` interface matching the front matter schema
- `loadAgentType(name: string): Promise<AgentType>` — reads from `~/.itsybitsy/agent-types/<name>.md`, falls back to built-in defaults
- `listAgentTypes(): Promise<AgentType[]>` — lists all available types (built-in + user-defined)
- `parseAgentTypeFile(content: string): AgentType` — parses YAML front matter + markdown body
- Built-in defaults for `manager`, `worker`, `coordinator` types

### Step 2: CLI Changes (`src/index.ts`, `src/ib-commands.ts`)

- Add `--type <name>` flag to `new-agent` command
- Map `--worker` → `--type worker`, `--coordinator` → `--type coordinator`
- Pass resolved type name through to `newAgent()`
- Add `agentType` to `NewAgentOptions`
- Write `agentType` to meta.json

### Step 3: Permission Integration (`src/ib-commands.ts`)

- `newAgent()` loads the agent type definition
- Merges type's `permissions.allow/deny` with existing permission layers
- Sets `worker` boolean in meta.json based on `canSpawnChildren`
- Installs intercept-task hook based on `canSpawnChildren`
- Uses type's `model` as default (between config and hardcoded default)

### Step 4: Session-Start Hook (`src/hooks/session-start.ts`)

- `detectRole()` reads `agentType` from meta.json
- Load the type definition file
- Choose base instruction template from `instructionStyle`
- Append type's markdown body to instructions
- Fall back to current logic when `agentType` is not set (backward compat)

### Step 5: Intercept-Task Hook (`src/hooks/intercept-task.ts`)

- Replace `meta.worker === true` check with loading agent type and checking `canSpawnChildren`
- Keep backward compat: if `agentType` not set, fall back to `worker` boolean

### Step 6: TUI Integration (`src/tui/dashboard.ts`)

- Update new-agent dialog to show agent type selection (fuzzy search of available types)
- Show agent type in info panel
- `--type` flag in agent tree display

### Step 7: Config Integration (`src/config.ts`)

- Dynamic config keys: recognize `permissions.<typeName>.allow/deny` for any loaded agent type
- Model priority: `--model` > type definition `model` > config `model` > `"opus"`

### Step 8: Tests

- Unit tests for agent type loading/parsing
- Unit tests for permission merging with type definitions
- Integration tests for `--type` flag in newAgent
- Update existing session-start and intercept-task tests
- Test backward compatibility (no `--type` flag behaves identically to current)

## Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| `ib new-agent --worker "task"` | Works as before. Resolves to type `worker`. |
| `ib new-agent "task"` | Works as before. Resolves to type `manager`. |
| `ib new-agent --coordinator "task"` | Works as before. Resolves to type `coordinator`. |
| Old agents without `agentType` in meta.json | Fall back to `worker`/`coordinator` boolean logic |
| `permissions.manager.allow` config | Still works, applied to the `manager` type |
| `.ittybitty/prompts/manager.md` | Still works, injected into prompt.txt |
| `--type worker --worker` | Redundant but harmless |
| `--type researcher --worker` | Error: `--type` and `--worker` are mutually exclusive |

## Out of Scope (Future)

- Per-repo agent types (`.ittybitty/agent-types/`) — start with user-global only
- Type inheritance (`extends` field) — keep it simple, each type is self-contained
- Type-specific config model keys (e.g., `researcher.model`) — use the type definition's `model` field instead
- Renaming/removing the `worker` boolean from meta.json — backward compat
- Default child type per parent type — always spawns `worker` type children for now

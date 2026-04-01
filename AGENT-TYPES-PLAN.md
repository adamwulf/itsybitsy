# Agent Types Feature — Implementation Plan

**Date:** 2026-04-01  
**Phase:** Planning (Phase 2)  
**Status:** Ready for Phase 3 (builder agents)

## Executive Summary

Replace itsybitsy's hardcoded `manager`/`worker` binary with a **user-configurable agent type system** based on `.md` files (similar to Claude Code skills). This enables users to define custom roles like "reviewer", "fixer", "researcher", etc., each with:
- Custom prompt/instructions
- Per-type permission controls
- Whether they can spawn children
- Model preferences
- Other role-specific behaviors

## Current System Analysis

### What We Have Now

1. **Meta.json tracking** (simple binary):
   - `worker: boolean` (true = worker, false = manager)
   - `manager: string | null` (parent agent ID)
   - `coordinator?: boolean` (special coordinator role)

2. **Session-start hook injection**:
   - Detects role from meta.json
   - Injects 300+ lines of hardcoded instructions per role
   - Includes workflow guidance, available commands, state management

3. **Permission system** (config.ts):
   - Global keys: `permissions.all.allow/deny`
   - Per-role keys: `permissions.{manager,worker,coordinator}.allow/deny`
   - Also defines unused `permissions.repo.allow/deny`

4. **Spawn prevention** (4 mechanisms):
   - Intercept hook only registered for managers
   - intercept-task.ts explicitly skips workers at line 137-139
   - newAgent() rejects workers as parent managers
   - Worker instructions omit spawning commands

5. **Coordinator system** (special case):
   - Has hardcoded permissions (Bash(ib:*) only, no file access)
   - Can read files via Read/Glob/Grep/LS
   - Has Bash metacharacter restrictions

### Skills Format (Reference)

Claude Code skills use YAML frontmatter + markdown body:

```yaml
---
name: skill-id
description: When/why Claude uses this
allowed-tools: [Read, Bash]
disable-model-invocation: false
user-invocable: true
---

# Prompt body injected at invocation
```

Frontmatter fields:
- **Required**: `name`, `description`
- **Optional**: `allowed-tools`, `disable-model-invocation`, `user-invocable`, `argument-hint`, `context`, `agent`, `version`, `license`

## Proposed Solution: Three Approaches to Compare

### Common Design Elements (All Approaches)

**File location**: `~/.itsybitsy/agent-types/<name>/AGENTTYPE.md` (or similar)

**Naming convention**:
- Built-in: `manager.md`, `worker.md` (with fallback defaults)
- User-defined: `reviewer.md`, `fixer.md`, `researcher.md`, etc.

**Frontmatter fields to define**:
- `name` — agent type identifier (used in meta.json)
- `description` — purpose/intent
- `canSpawnChildren` — boolean (default: false for backward compat)
- `canBeParent` — boolean (default: true for managers, false for workers)
- `permissions.allow` — string[] (overrides config)
- `permissions.deny` — string[] (overrides config)
- `model` — preferred model (opus, sonnet, haiku)
- `coordinator` — boolean (special role like current coordinator)

**Metadata handling**:
- `meta.json` changes from `worker: boolean` → `type: "manager" | "worker" | "reviewer" | ...`
- Keep `manager` field for parent tracking (unchanged)
- Keep `coordinator: true` as override for backward compat

**Permission resolution**:
1. Load agent type definition from disk
2. Check frontmatter `permissions.allow/deny`
3. Fall back to config: `permissions.{type}.allow/deny`
4. Fall back to `permissions.all.allow/deny`

---

## Approach A: Minimal (Focus on Prompt Flexibility)

**Philosophy**: Keep permissions simple; let users mainly customize prompts.

**What changes**:
- Introduce agent type .md files with frontmatter + custom prompt body
- `canSpawnChildren` boolean gates intercept-task behavior
- Minimal frontmatter; most config comes from `~/.itsybitsy/config.json`

**File structure** (minimal frontmatter):
```yaml
---
name: reviewer
description: Review and approve code changes
canSpawnChildren: false
---

# Reviewer Agent Role

You are a code reviewer. Your job is to:
1. Read the PR/code
2. Identify issues
3. Report to your manager
...
```

**Implementation impact**:
- Add type loading to `src/config.ts` or new `src/agent-types.ts`
- Update `session-start.ts` to read `.md` file instead of hardcoded switch
- Update `intercept-task.ts` line 137 to check `canSpawnChildren` flag from type def
- Update `newAgent()` to read type from meta.json
- No change to permissions flow (still uses config.ts)

**Pros**:
- Smallest code change
- Reuses existing permission system
- Good for power users who want custom prompts

**Cons**:
- Permissions still hardcoded per role in config
- Can't define per-type permissions in the .md file
- Coordinator special case still hardcoded

---

## Approach B: Full (Permissions + Prompts)

**Philosophy**: Agent types define everything — prompts, permissions, spawning rules.

**File structure** (full frontmatter):
```yaml
---
name: reviewer
description: Review code changes, report findings
canSpawnChildren: false
canBeParent: false
permissions:
  allow: [Read, Grep, Glob, Write(agent.log)]
  deny: [Task, Agent, Edit]
model: sonnet
coordinator: false
---

# Reviewer Agent

You are a code reviewer...
```

**Implementation impact**:
- New type loader with frontmatter parser
- `session-start.ts` reads type + prompt body
- `intercept-task.ts` checks `canSpawnChildren` from type
- Permission flow: check type frontmatter first, then config, then defaults
- Permissions written to `.claude/settings.local.json` during agent spawn

**Pros**:
- Single source of truth (one .md file per type)
- Full customization: prompts + permissions together
- Users never need to touch config.json for custom types
- Naturally extends to new permission fields

**Cons**:
- Larger code change (new parser, permission loading logic)
- Frontmatter complexity might confuse users
- Need to handle permission format parsing (lists, globs)

---

## Approach C: Hybrid (Prompt in .md, Permissions in Config)

**Philosophy**: .md files for prompts (reusable, versionable); config for policy (enterprise control).

**File structure** (moderate frontmatter):
```yaml
---
name: reviewer
description: Review code changes
canSpawnChildren: false
configKey: reviewer  # Maps to permissions.reviewer.allow/deny in config
---

# Reviewer Agent

You are a code reviewer...
```

**Implementation impact**:
- Type loader reads .md with name + configKey
- `session-start.ts` reads type + prompt body
- `intercept-task.ts` checks `canSpawnChildren`
- Permissions: check `permissions.{configKey}.allow/deny` from config
- Built-in types (manager, worker) pre-defined with no .md file

**Pros**:
- Separates concerns (code structure vs. policy)
- Enterprise teams can control permissions centrally via config
- Simpler than Approach B (less frontmatter parsing)
- Users can define custom type prompts without touching config

**Cons**:
- Two-part definition (split between .md and config)
- Slightly less self-contained than Approach B
- Still requires config entries for custom types

---

## Backward Compatibility

### Option 1: Silent Fallback (Recommended)

If agent type .md not found:
1. Check if `type: "manager"` or `type: "worker"` in meta
2. Use hardcoded fallback instructions
3. Works transparently for existing agents

### Option 2: Auto-Generate Built-in Types

On first startup, generate `.itsybitsy/agent-types/manager.md` and `.itsybitsy/agent-types/worker.md` with current hardcoded instructions.

---

## Migration Path

1. **Phase 3a** (builder agents): Implement one approach (recommend Approach B: Full)
2. **Phase 3b**: Update CLI (`newAgent()`) to accept `--type=reviewer` instead of `--worker`
3. **Phase 3c**: Deprecate `--worker` flag (keep working, emit warning)
4. **Phase 3d**: Tests, documentation, release

---

## Key Files to Modify

### Core Changes

1. **src/agent-types.ts** (NEW)
   - Load and parse agent type .md files
   - Return `AgentType` interface with frontmatter + body

2. **src/hooks/session-start.ts**
   - Call new type loader instead of hardcoded switch
   - Inject body from type .md

3. **src/hooks/intercept-task.ts**
   - Line 137: instead of `if (meta.worker === true)`, check `type.canSpawnChildren`

4. **src/ib-commands.ts**
   - `newAgent()`: read `--type` CLI flag (or keep `--worker` for backward compat)
   - Write `type: string` to meta.json instead of `worker: boolean`

5. **src/agents.ts**
   - Update `AgentMeta` interface: `type: string` (instead of `worker: boolean`)

### Optional (For Approach B/C)

6. **src/config.ts**
   - Add permission keys: `permissions.{customType}.allow/deny`
   - Or refactor to load from type frontmatter

7. **src/ib-commands.ts** (permission building)
   - Read permissions from type definition + config
   - Write to `.claude/settings.local.json`

---

## Testing Strategy

### Unit Tests

- Agent type parser: load .md, extract frontmatter
- Session-start hook: correct instructions for each type
- Intercept-task: canSpawnChildren flag blocks/allows spawns
- newAgent(): correct meta.json fields set

### Integration Tests

- Spawn manager agent: can spawn workers
- Spawn worker agent: cannot spawn children
- Spawn custom "reviewer" agent: correct permissions in settings.json
- Backward compat: existing agents still work

### Manual Testing

- Define custom agent type in ~/.itsybitsy/agent-types/
- Spawn agent with custom type
- Verify prompt injection
- Verify permission enforcement
- Test spawn restrictions

---

## Open Questions / Decisions Needed

1. **File naming**: `AGENTTYPE.md` vs. `agent-type.md` vs. `meta.md`?
   - Recommendation: `AGENTTYPE.md` (parallel to `SKILL.md`)

2. **Built-in types**: Keep hardcoded fallback or generate .md files?
   - Recommendation: Hardcoded fallback for safety, optional .md generation for customization

3. **Directory structure**: `~/.itsybitsy/agent-types/` or `~/.itsybitsy/types/`?
   - Recommendation: `agent-types/` (explicit, searchable)

4. **Which approach?**
   - **A (Minimal)** if: Users mostly want custom prompts, minimal permission tweaking
   - **B (Full)** if: Users want complete self-contained type definitions
   - **C (Hybrid)** if: Enterprise needs centralized policy control
   - **Recommendation**: Start with B (Full), it subsumes the others

5. **Backward compat**: Auto-migrate existing meta.json `worker: true` → `type: "worker"`?
   - Recommendation: On-read migration (lazy conversion in agents.ts)

---

## Success Criteria

Phase 3 implementation is complete when:

1. ✓ Can define custom agent type in `~/.itsybitsy/agent-types/custom.md`
2. ✓ `ib new-agent --type=custom "task"` spawns with custom prompt + permissions
3. ✓ Custom type with `canSpawnChildren: false` cannot spawn sub-agents
4. ✓ Custom type with `canSpawnChildren: true` can spawn sub-agents
5. ✓ Built-in manager/worker types still work (backward compat)
6. ✓ Permission inheritance: type frontmatter > config > defaults
7. ✓ All tests pass: `bun test && bunx tsc --noEmit`
8. ✓ Binary compiles: `bun build --compile index.ts --outfile ib`

---

## Recommendation for Phase 3

**Use Approach B (Full)** because:

1. Single source of truth (one .md per type)
2. Naturally extensible (add new frontmatter fields)
3. Similar to Claude Code skills (familiar to users)
4. Supports the full vision: custom prompts + custom permissions + spawn rules
5. Not significantly more complex than A or C

**Phase 3 structure**:
- 1 builder agent: Implement Approach B with full test coverage
- 2 reviewer agents: Verify implementation, test coverage, backward compat
- Review cycle to ensure design decisions are sound

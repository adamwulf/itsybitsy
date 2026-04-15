# itsybitsy (ib) — Behavioral Specification

This document is the definitive behavioral specification for itsybitsy, a multi-agent orchestration system for Claude Code. It uses tmux sessions, git worktrees, and a hook system to manage isolated, concurrent Claude agents.

**Annotations used in this document:**

- **[^callout]** — Marks an intentional divergence between the bash reference implementation and the TypeScript reimplementation. The description explains what differs and why.
- **[^needs review]** — Marks a claim that could not be fully verified against the source, or where the correct behavior is ambiguous and needs a decision.

---

## 1. Agent Lifecycle

### 1.1 Agent Creation

When a new agent is created (`ib new-agent "prompt"`):

1. **Validate inputs**: A prompt is required. If `--manager` is specified, the manager must exist and must not be a leaf agent (an agent whose type has `canSpawnChildren: false`). Leaf agents cannot manage sub-agents. If `--type` is specified, the type must exist as a `.md` file in `~/.itsybitsy/agent-types/`.

2. **Auto-detect manager**: If no `--manager` is provided and the caller is running inside an agent worktree (CWD matches `/.ittybitty/agents/<id>/repo`), the caller's agent ID is automatically set as the manager.

3. **Yolo escalation prevention**: A `--yolo` child cannot be spawned by a non-yolo parent. This prevents permission escalation where a constrained agent spawns an unconstrained one. The parent's yolo status is checked via `meta.json` or `start.sh`.

4. **Configuration**: Config is loaded from `~/.itsybitsy/config.json` (user-wide). The agent type is resolved by: `--type` flag > default `"manager"`. The type definition is loaded from `~/.itsybitsy/agent-types/<name>.md` — the `.md` file on disk is the sole source of truth (no hardcoded fallback). On first run, `~/.itsybitsy/agent-types/` is auto-populated with embedded default templates (see §2.7). The model is determined by: `--model` flag > type definition `model` > config `model` (or `coordinator.model` for coordinators) > `"opus"` (default).

5. **Max agents check**: The number of active agents (directories with `meta.json` in `.ittybitty/agents/`) must not exceed the `maxAgents` config value (default: 10).

6. **Generate agent ID**: Either `--name NAME` or `agent-<8 random hex chars>` (e.g., `agent-a1b2c3d4`).

7. **Tmux session naming**: The tmux session name is `ittybitty-<repo-id>-<agent-id>`, where `<repo-id>` is an 8-character hex identifier stored in `.ittybitty/repo-id`. This prevents session collisions across different repositories.

8. **Git worktree setup** (default, unless `--no-worktree`):
   - Branch name: `agent/<agent-id>`
   - Base ref: If the agent has a manager, branch from `agent/<manager-id>`. Otherwise, branch from `HEAD`.
   - Command: `git -C <root-repo> worktree add <agent-dir>/repo -b <branch-name> <base-ref>`

9. **Settings**: `<agent-dir>/repo/.claude/settings.local.json` is written with permissions merged from four sources (see §2.3 for full details):
   - Base allow list from `<repo>/.claude/settings.json` (deny entries NOT inherited)
   - Hardcoded mandatory permissions (ib commands, git operations, Claude Code tools)
   - Config-defined permissions from `~/.itsybitsy/config.json` (`permissions.all.*` + role-specific scope)
   - Type-defined permissions from `~/.itsybitsy/agent-types/<type>.md` frontmatter
   - Hook definitions: path-check, stop, permission-denied, session-start, and optionally intercept-task (for agents with `canSpawnChildren: true`)
   - The agent ID placeholder `__AGENT_ID__` is replaced with the actual ID after writing

10. **Write meta.json** to `<agent-dir>/meta.json` (see §5.2 for fields). Includes `agentType` (the resolved type name) and `agentIcon` (the type's icon character, if defined).

11. **Write prompt.txt** with the full prompt including any completion instructions, custom prompts, and the user's task.

12. **Write start.sh**: A bash script that:
    - Clears `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` env vars (allows nesting)
    - Starts `claude --session-id <uuid> <args> "$(cat prompt.txt)"` in background
    - Captures the Claude PID into `meta.json`
    - Runs `exit-check.sh` after Claude exits

13. **Write exit-check.sh**: Interactive script (for manual agent inspection) that checks for uncommitted changes and unpushed commits after the agent session ends.

14. **Start tmux session**: `tmux new-session -d -x 60 -s <session-name> -c <work-path> <start.sh>`

15. **Auto-accept workspace trust**: For non-yolo agents, a background process polls tmux output for permission prompts ("Do you trust the files", "trust this folder", "Allow external CLAUDE.md file imports") and sends Enter to accept them. Runs up to 5 attempts with 4-second waits between each.

16. **Auto-spawn watchdog**: `ib watchdog <id>` is spawned in the background for ALL agents (not just those with a manager), with output redirected to `<agent-dir>/watchdog.log`. The watchdog PID is saved to `meta.json` as `watchdog_pid`.

17. **Output**: The agent ID is printed to stdout immediately after tmux session creation.

18. **Prompt summary generation**: After the watchdog is spawned, `generatePromptSummary()` is called in the background (fire-and-forget) to produce a short human-readable summary of the agent's task. This does not block the creation flow. See §8.9 for details.

### 1.2 Agent States

Agents can be in one of 7 states:

| State | Description |
|-------|-------------|
| `creating` | Agent was created less than 6 seconds ago — derived from `created_epoch` at read time |
| `running` | Agent is actively working — default state after creation grace period |
| `waiting` | Agent is idle, signaled `WAITING` as its last line |
| `complete` | Agent finished its task, signaled `I HAVE COMPLETED THE GOAL` as its last line |
| `compacting` | Context window compaction in progress — detected from tmux output at read time |
| `rate_limited` | Hit API rate limits — detected from tmux output at read time |
| `stopped` | Tmux session does not exist, or agent is archived — detected at read time |

**States stored in meta.json**: Only `running`, `waiting`, and `complete` are written to the `state` field in `meta.json`. The other states (`creating`, `compacting`, `rate_limited`, `stopped`) are derived at read time from timestamps, tmux session existence, or tmux output.

**`unknown` state removed**: The old `unknown` state (no patterns matched) is eliminated. In the new model, if the stop hook cannot determine a clear state from `last_assistant_message`, it nudges the agent and keeps the state as `running`.

### 1.3 Deterministic State Detection

State detection is deterministic — the stop hook writes authoritative state to `meta.json`, and consumers read it. Tmux output parsing is only used for two transient display states (`compacting`, `rate_limited`) and for `stopped` detection.

**State resolution order** (checked top-to-bottom by consumers like `ib list`, `ib watch`, `detectAgentStates()`):

1. **Archived agents** → `stopped` (no further checks).

2. **No tmux session** → `stopped`, unless `created_epoch` is less than 6 seconds ago → `creating`. The 6-second grace period (`CREATING_GRACE_PERIOD_MS`) is purely time-derived from `created_epoch` in meta.json — not written as a state value.

3. **Tmux session exists — check transient overrides** (tmux output parsing, minimal):
   - If "Compacting conversation" appears in last 5 lines of tmux output → `compacting`
   - If `rate_limit_error`, "usage limit reached", "hit your limit", or "/upgrade to increase your usage limit" appears in last 15 lines → `rate_limited`

4. **Read `state` from meta.json** → return the stored value (`running`, `waiting`, or `complete`). If `state` field is absent (legacy agent or freshly created agent before first stop hook fires): if `created_epoch` is less than 6 seconds ago → `creating`; otherwise → `running`.

**ANSI stripping**: Tmux output used for compacting/rate_limited checks must have ANSI escape sequences stripped before pattern matching.

### 1.3.1 State Writes

State is written to `meta.json` by exactly three actors:

| Actor | When | State written |
|-------|------|---------------|
| **Stop hook** (`ib hook-status`) | Claude becomes idle | `waiting`, `complete`, or `running` (nudge case) |
| **`ib send`** | Message sent to agent | `running` |
| **`ib resume`** | Agent resumed from stopped | `running` |

The stop hook is the primary state authority. Its detection logic:

1. Check `last_assistant_message` (from stdin JSON): if the last non-empty line is `"WAITING"` → write `waiting`. If `"I HAVE COMPLETED THE GOAL"` → write `complete`.
2. If neither matched → write `running` and nudge the agent ("Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line.").

The stop hook does NOT parse tmux output for state detection. Tmux parsing for `rate_limited` and `compacting` is done only by state consumers at read time.

**Atomic writes**: State updates to meta.json use atomic write (write temp file, rename) to prevent partial reads. The `state` field is added alongside existing meta.json fields — all other fields remain unchanged.

### 1.3.2 Legacy State Detection (parseState)

The legacy `parseState()` function and its 14-priority tmux pattern matching system remain in the codebase but are no longer used for primary state detection. They are retained for:
- **Compacting detection**: Checking "Compacting conversation" in last 5 lines of tmux output
- **Rate limit detection**: Checking rate limit patterns in last 15 lines of tmux output
- **Backward compatibility**: The bash `ib` reference implementation still uses tmux-based state detection

The legacy parseState priority order is documented here for reference:

   | Priority | Window | Pattern | State |
   |----------|--------|---------|-------|
   | 1 | Full input | Workspace trust/import prompts AND no startup markers | `creating` |
   | 2 | Last 5 lines | "Compacting conversation" | `compacting` |
   | 3 | Last 5 lines | `(Esc to interrupt`, `(ctrl+c to interrupt`, `⎿  Running` | `running` |
   | 4 | Last 15 lines | `⎿  Waiting` (tool waiting) | `waiting` |
   | 5 | Last 15 lines | `rate_limit_error` or usage limit phrases (case-insensitive) | `rate_limited` |
   | 6 | Last 15 lines | `I HAVE COMPLETED THE GOAL` (excluding single-quoted instances) | `complete` |
   | 7 | Last 15 lines | Standalone `WAITING` on its own line (unless ⏺ appears after it = stale) | `waiting` |
   | 8 | Last 15 lines | `ctrl+b ctrl+b` or `thinking)` | `running` |
   | 9 | Last 15 lines | Thinking spinners (✽✶✢·✻✳) at line start (excluding hook spinners, completion timers) | `running` |
   | 10 | Last 15 lines | Permission prompts ("Enter to confirm" + trust/imports) | `creating` |
   | 11 | Last 20 lines | Spinners with interrupt markers (broader window) | `running` |
   | 12 | Last 15 lines | Background tasks pattern (`⏵⏵.*·\s\d+\s`) | `running` |
   | 13 | Last 15 lines | "running stop hook" without ⏺ (race condition) | `creating` |
   | 14 | — | No patterns matched | `unknown` |

### 1.4 Killing an Agent

Kill (`ib kill <id>`) permanently destroys an agent:

1. Remove the agent's questions from `user-questions.json`
2. **Teardown sequence**:
   a. Log "Agent killed" to `agent.log`
   b. Capture tmux pane output to `output.log`
   c. Kill Claude process (SIGTERM → wait 2s → SIGKILL if still alive)
   d. Kill tmux session
   e. Copy `settings.local.json` from worktree to agent dir
   f. Remove git worktree (`git worktree remove --force`, fallback to `rm -rf`)
   g. Delete git branch (`git branch -D agent/<id>`)
   h. Archive artifacts (output.log, agent.log, meta.json, settings.local.json, debug-logs/)
   i. Remove agent directory
3. Scan and kill orphaned Claude processes

### 1.5 Pausing an Agent

Pause (`ib pause <id>`) stops the agent but preserves all state:

1. Kill the Claude process (SIGTERM → SIGKILL)
2. Kill the tmux session (the watchdog will self-exit when it detects the tmux session is gone — see §8.5)
3. Agent directory, meta.json, worktree, branch, and logs are all preserved
4. The agent can be resumed with `ib resume <id>`

### 1.6 Resuming an Agent

Resume (`ib resume <id>`) restarts a stopped agent:

1. Read `session_id` from `meta.json` (required for Claude `--resume`)
2. Detect yolo mode from `start.sh`
3. Write `resume.sh` with `claude --resume <session-id>` command
4. Start new tmux session running `resume.sh`
5. Auto-accept workspace trust (if not yolo)
6. Send resume nudge message: "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line."
7. **Auto-spawn watchdog**: `ib watchdog <id>` is spawned in the background for ALL agents (not just those with a manager). The watchdog PID is saved to `meta.json` as `watchdog_pid`. The bash `cmd_resume()` does not include this step (known divergence).
8. **State reset**: Write `state: "running"` and `state_updated_at` to `meta.json` (atomic merge write). See §1.3.1.

### 1.7 Archiving

Archive moves agent artifacts to `.ittybitty/archive/<YYYYMMDD-HHMMSS>-<agent-id>/`:

| File | Action |
|------|--------|
| `output.log` | Move |
| `agent.log` | Copy |
| `meta.json` | Copy |
| `settings.local.json` | Move |
| `debug-logs/` | Copy (recursive) |

### 1.8 Nuking

Nuke (`ib nuke <id>`) recursively kills a manager and all its descendants:

1. Collect all descendant agent IDs via depth-first traversal of manager relationships
2. Worker agents with no descendants cannot be nuked (use `kill` instead) — but workers that have spawned sub-agents can be nuked
3. For each descendant: remove questions, teardown (same sequence as kill)
4. Clean up orphaned tmux sessions (sessions with `ittybitty-<repo-id>-` prefix that don't match any remaining agent in the same repository) [^callout]: The bash reference checks only sessions matching the current repo's prefix (`ittybitty-<repo-id>-`). The TypeScript `cleanupOrphanedTmuxSessions` checks all sessions starting with `ittybitty-`, which may clean up sessions from other repos. The agent ID extraction logic (stripping the prefix) still works correctly cross-repo.
5. Scan and kill orphaned Claude processes

Nuke-all (`ib nuke` with no agent ID) kills all agents in the repository. The `--force` flag skips confirmation but does not change what gets nuked.

---

## 2. Agent Types

### 2.1 Configurable Agent Types

Agents are assigned a **type** at creation time that determines their behavior, permissions, instructions, and icon. The type system replaces the old binary manager/worker distinction with a configurable, extensible model.

**Type resolution at creation time** (checked in order):
1. `--type <name>` flag — explicit type selection (e.g., `--type worker`, `--type coordinator`)
2. Default → type `"manager"`

**Three default types** are provided via embedded templates that are auto-populated on first run (see §2.7):

| Type | `canSpawnChildren` | Icon | `instructionStyle` | Description |
|------|-------------------|------|-------------------|-------------|
| `manager` | `true` | `◆` | `manager` | Manages sub-agents and coordinates work |
| `worker` | `false` | `⚙` | `worker` | Executes tasks assigned by a manager |
| `coordinator` | `true` | `◇` | `coordinator` | Read-only coordinator that manages agents without writing code |

**All types** are defined as `.md` files in `~/.itsybitsy/agent-types/<name>.md` with YAML frontmatter and an optional markdown body for instructions. The `.md` file on disk is the sole source of truth — there is no hardcoded fallback. Users can edit the default type files, create custom types, or delete the manager/worker files (coordinator types auto-regenerate; see §2.7). See §2.6 for the file format.

### 2.2 Type Properties

The `AgentType` interface defines these properties:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | Yes | Type identifier (derived from filename if not in frontmatter) |
| `description` | string | No | Human-readable description |
| `canSpawnChildren` | boolean | Yes | Whether agents of this type can spawn sub-agents |
| `icon` | string | No | Display icon — first non-whitespace character is extracted |
| `model` | string | No | Default model override (used before config fallback) |
| `permissions` | object | No | Type-specific `allow`/`deny` permission lists |
| `instructionStyle` | `"manager"` \| `"worker"` \| `"coordinator"` | Yes | Maps to base instruction set for session-start (defaults to `"manager"`) |
| `markdownBody` | string | No | Template body for custom instructions (see §6.3.1) |

The key behavioral distinction is `canSpawnChildren`:
- **`true`** (manager-like): Can spawn sub-agents, Task tool is intercepted to spawn ib agents, receives manager-style instructions
- **`false`** (worker-like): Cannot spawn sub-agents, Task tool is denied by intercept hook, receives worker-style instructions

### 2.3 Agent Permissions

When building `<agent-dir>/repo/.claude/settings.local.json` for an agent, permissions are merged from these sources, in order:

1. **Base project settings** — `<repo>/.claude/settings.json`
   - The version-controlled project settings file. Only the `permissions.allow` array is inherited (existing allow entries are harmless — they grant access the project already intended). Existing `permissions.deny` entries are NOT inherited — agent deny lists come exclusively from mandatory, config, and type sources below.
   - NOT `settings.local.json` — the `.local` file may belong to a per-repo coordinator or contain repo-specific overrides that should not propagate to spawned agents.

2. **Mandatory permissions** (hardcoded, always added for all agents):
   - `Bash(ib:*)`, `Bash(./ib:*)` — ib commands (both forms to handle PATH vs relative invocation) [^callout]: The TS implementation only includes `Bash(ib:*)`. The `Bash(./ib:*)` form is bash-only, since the TS `ib` binary is always expected to be on PATH.
   - `Bash(git status:*)`, `Bash(git add:*)`, `Bash(git commit:*)`, `Bash(git diff:*)`, `Bash(git show:*)`, `Bash(git log:*)`, `Bash(git ls-files:*)`, `Bash(git grep:*)`, `Bash(git rm:*)`, `Bash(git merge:*)`, `Bash(git rebase:*)`, `Bash(git checkout:*)`, `Bash(git restore:*)`, `Bash(git reset:*)` — git operations
   - `Bash(pwd:*)`, `Bash(ls:*)`, `Bash(head:*)`, `Bash(tail:*)`, `Bash(cat:*)`, `Bash(grep:*)` — filesystem inspection
   - `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `TodoWrite`, `Task`, `TaskOutput`, `KillShell`, `NotebookEdit`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ToolSearch` — Claude Code tools
   - **Always denied**: `EnterPlanMode`, `ExitPlanMode`

3. **Config-defined permissions** — `~/.itsybitsy/config.json`
   - `permissions.all.allow/deny` — applies to ALL agent types
   - `permissions.coordinator.allow/deny` — applies only to coordinator-type agents
   - `permissions.repo.allow/deny` — applies to all non-coordinator agent types (repo-wide baseline)

4. **Type-defined permissions** — `~/.itsybitsy/agent-types/<type>.md` (frontmatter)
   - `permissions.allow` and `permissions.deny` fields from the agent type definition file's YAML frontmatter

All allow/deny lists are merged and deduplicated. The final result is written to `<agent-dir>/repo/.claude/settings.local.json` along with hook definitions (§6).

**Deprecated config keys**: `permissions.manager.allow/deny` and `permissions.worker.allow/deny` have been removed. If present in `~/.itsybitsy/config.json`, a deprecation warning is shown at `ib watch` startup. Users should move per-type permissions into the agent type `.md` files and use `permissions.repo.*` for repo-wide defaults.

### 2.4 Sub-Agent Spawning

Agents with `canSpawnChildren: true` spawn sub-agents either explicitly with `ib new-agent --type worker "task"` or implicitly via the Task tool (which the intercept hook converts into `ib new-agent --type worker`). In both cases, the parent's agent ID is automatically set as the `--manager` for the child. The child's branch forks from `agent/<parent-id>`. When invoked from the primary Claude session (no agent context), the intercept hook spawns a manager instead of a worker.

### 2.5 Unfinished Children Check

When a top-level agent (no manager of its own) with `canSpawnChildren: true` signals completion, the stop hook checks for unfinished children. Both bash and TS determine "unfinished" by checking actual tmux state (creating, running, waiting, or complete — but NOT stopped/unknown).

Specifically, it looks for children — agents in `.ittybitty/agents/` whose `meta.json` `manager` field matches the completing agent's ID. If any exist, the agent receives a nudge message listing them and instructing it to merge or kill each one before completing.

### 2.6 Agent Type File Format

Agent type files are markdown files with YAML frontmatter:

```markdown
---
name: researcher
description: Specialized research agent
canSpawnChildren: false
icon: 🔍
instructionStyle: worker
model: sonnet
permissions:
  allow:
    - WebFetch
    - WebSearch
  deny:
    - Write
    - Edit
---

## Research Agent Instructions

You are research agent `{{agentId}}`...
(template body with {{variable}} and {{#if condition}}...{{/if}} blocks)
```

**Frontmatter fields**: See §2.2 for the full list.

**Template body**: If present, the markdown body below the frontmatter is used as the instruction template at session start (see §6.3.1). If absent, the hardcoded instructions for the `instructionStyle` are used.

**Icon resolution**: The `icon` field's first non-whitespace character is extracted and stored in `meta.json` as `agentIcon`. This icon is displayed in the TUI agent tree, CLI output (`ib list`), and status injection.

**Location**: All types live in `~/.itsybitsy/agent-types/<name>.md`. The default types (manager, worker, coordinator) are embedded in the `ib` binary and auto-populated on first run (§2.7). Source templates are also available in `docs/agent-types/` in the source repository.

### 2.7 Auto-Population and init-types

**Auto-population**: On first run (when `~/.itsybitsy/agent-types/` does not exist), the directory is created and populated with the embedded default type files (manager.md, worker.md, coordinator.md). This happens automatically at `ib watch` startup and `ib new-agent` execution. If the directory already exists, no files are written — the user's customizations are preserved.

**`ib init-types` command**: Writes any missing embedded type files to `~/.itsybitsy/agent-types/` without overwriting existing files. Use this to restore accidentally deleted defaults or after an `ib` upgrade that adds new built-in types. Alias: `ib init-agent-types`.

**Embedded templates**: The default type `.md` files from `docs/agent-types/` are compiled into the `ib` binary via text imports. Changes to `docs/agent-types/*.md` are reflected in the binary on recompilation.

### 2.8 Startup Validation

When `ib watch` launches, it validates all agent type files in `~/.itsybitsy/agent-types/` before starting the dashboard (after auto-population). If any file has YAML parsing errors, invalid field types (e.g., `canSpawnChildren` is not a boolean), or invalid `instructionStyle` values, the dashboard exits immediately with error messages describing each issue. This prevents runtime failures from malformed type definitions.

### 2.9 Backward Compatibility

Legacy agents (created before the agent types system) that lack `agentType` in their `meta.json` fall back to the old behavior:
- `meta.json` `worker: true` → treated as `worker` type
- `meta.json` `coordinator: true` → treated as `coordinator` type
- Neither → treated as `manager` type

The `worker` boolean field is still written to meta.json for backward compatibility with the bash `ib` reference implementation. Its value is derived from `canSpawnChildren`: `worker: true` when `canSpawnChildren` is `false`, `worker: false` otherwise.

---

## 3. Merge Behavior

### 3.1 is_running_as_agent() Detection

The merge strategy depends on whether the caller is an agent or a user. Detection uses two checks:

1. **CWD path pattern**: `/.ittybitty/agents/<id>/repo` anywhere in the current working directory
2. **TMUX session name**: If inside tmux, the session name starts with `ittybitty-`

If either check matches, the caller is considered an agent.

### 3.2 Pre-Merge Checks

Before merging, the following are verified:

1. Agent directory exists (bash checks directory only; TS also verifies `meta.json` exists)
2. Agent has a worktree directory (`<agent-dir>/repo`)
3. Caller is not inside the agent's own worktree
4. Agent worktree has no uncommitted changes
5. Target branch detection (see §3.3)
6. Agent branch (`agent/<id>`) exists
7. Current directory (caller's CWD) has no uncommitted changes
8. Pre-rebase conflict check passes (creates a temp branch/worktree, attempts rebase, cleans up)

### 3.3 Target Branch Detection

The target branch is determined from the caller's context (unless overridden with `--into BRANCH` in bash):

1. `git branch --show-current` — the caller's current branch
2. Fallback to `main` if it exists
3. Fallback to `master` if it exists
4. Error if none found

**Critical**: The target is the current branch in the CWD, not necessarily `main`. When a manager merges a worker, the target is the manager's branch (`agent/<manager-id>`).

The TS `mergeAgent` always uses auto-detection (no `--into` equivalent) since it runs from the dashboard where CWD context is sufficient.

### 3.4 Merge Execution

1. **Rebase**: `git -C <worktree-path> rebase <target-branch>` — rebase the agent's branch onto the target in the agent's worktree
2. **Checkout**: `git checkout <target-branch>` — switch to target branch in the caller's CWD (no `-C`; when a manager merges, CWD is the manager's worktree, not the root repo)
3. **Merge** (strategy depends on caller):
   - **Agent caller (manager merging sub-agent)**: `git merge --ff-only <agent-branch>` — fast-forward only
   - **User caller (top-level merge)**: `git merge --no-ff <agent-branch> -m "Merge agent <id> work"` — always creates a merge commit

### 3.5 Post-Merge Cleanup

After successful merge:

1. Capture tmux output to `output.log`
2. Kill Claude process
3. Kill tmux session
4. Copy `settings.local.json` from worktree to agent dir [^callout: bash `do_merge` does NOT do this step — it only exists in `teardown_agent` (kill/nuke path). The TS `mergeAgent` added this to preserve hook/permission config in archives.]
5. Remove git worktree
6. Delete git branch
7. Archive artifacts
8. Remove questions for this agent
9. Remove agent directory
10. Scan for orphaned Claude processes

**Note on `mergeCheckAgent`**: The TS implementation hardcodes `"main"` as the target branch for conflict checks and commit counting, rather than using the dynamic detection (current branch → main → master) that bash `cmd_merge_check` uses. It also skips the caller's CWD uncommitted changes check that bash `do_merge_check` performs. [^callout: intentional simplifications in TS — the dashboard always runs merge-check from the root repo context where `main` is the expected target and CWD changes are not a concern (the actual `mergeAgent` checks CWD changes before executing).]

---

## 4. Message Passing

### 4.1 ib send

`ib send <target-id> "message"` sends text to an agent's tmux session:

1. **Resolve target**: Partial ID matching is supported (prefix/substring match against agent directories and tmux sessions). Must resolve to exactly one agent. Per-repo coordinators have agent IDs matching their repo basename (e.g., `itsybitsy`), so `ib send itsybitsy "msg"` naturally routes to them via standard ID resolution. See §12.3.1 for full coordinator addressing details.
2. **Verify running**: The target's tmux session must exist.
3. **Auto-detect sender**: If called from within an agent worktree, the sender's agent ID is read from `meta.json`. An explicit `--from <sender-id>` flag can also be passed to override auto-detection.
4. **Format message**: If a sender is detected, the message is prefixed: `[sent by agent <sender-id>]: <message>`
5. **Send via tmux**: `tmux send-keys -t <session> "<message>"` (no `-l` literal flag), then after a calculated delay, `tmux send-keys -t <session> Enter` separately. [^note] The TypeScript implementation uses `-l` (literal flag) to prevent key interpretation of special characters; the bash version relies on tmux's default key handling without `-l`.
6. **Delay calculation**: `0.1 + (message_length / 100) * 0.5` seconds, clamped to [0.2, 3.0]. Longer messages need more time for the paste to complete in tmux. The `message_length` here is the length of the full formatted message (including the `[sent by agent ...]` prefix if present).
7. **Logging**: Both sender and recipient get entries in their `agent.log`. Recipient log entries are written with `--quiet` (no stdout echo); sender log entries echo to stdout. [^note] The `--quiet` distinction is bash-specific. The TypeScript `logAgent()` is always write-only (appends to `agent.log` without echoing to stdout) for both sender and recipient. Additionally, in bash when `fromId` is set, the sender's log message ("Sent message to ...") is echoed to stdout; in TypeScript, `stdout` is returned as an empty string when `fromId` is set (only returning `"Sent to <id>"` when there is no sender).
8. **Stdin piping**: Messages can also be provided via stdin (`echo "msg" | ib send <id>` or `ib send <id> < file.txt`) when no positional message argument is given. Both bash and TypeScript support stdin piping when no positional message is provided and stdin is not a TTY.
9. **State reset**: After sending the message, write `state: "running"` and `state_updated_at` to the target agent's `meta.json` (atomic merge write). This ensures that agents in `waiting` or `complete` state are immediately marked as `running` when they receive input. See §1.3.1.

### 4.2 ib ask

`ib ask "question"` allows top-level managers to ask the user questions. Both bash and TypeScript implement this command.

1. **Auto-detect agent ID** from CWD if in an agent worktree (or specify `--id <agent-id>` explicitly)
2. **Top-level check**: Only agents with no manager (or whose manager has been merged/killed) can ask. Others are told to use `ib send` to communicate with their manager.
3. **Config check**: `allowAgentQuestions` must be `true` (default)
4. **Question storage**: Stale questions from agents whose directories no longer exist are cleaned up. New questions are appended to `.ittybitty/user-questions.json`
5. **Question ID format**: `q-<unix-epoch>-<6-char-hash>` where the hash is the first 6 hex characters of `md5("$AGENT_ID-$QUESTION\n")` (note: bash `echo` appends a trailing newline to the hash input)
6. **Logging**: The question is logged to the asking agent's `agent.log`.

### 4.3 user-questions.json Structure

```json
{
  "questions": [
    {
      "id": "q-1704825600-abc123",
      "agent": "agent-a1b2c3d4",
      "question": "Should I proceed with the refactoring?",
      "timestamp": "2024-01-09T20:00:00Z",
      "status": "acknowledged",
      "acknowledged_at": "2024-01-09T20:05:00Z"
    }
  ]
}
```

Fields:
- `id`: Unique question identifier
- `agent`: Agent ID that asked the question
- `question`: Question text
- `timestamp`: ISO 8601 UTC timestamp
- `status`: `"pending"` or `"acknowledged"`
- `acknowledged_at`: Set when `ib acknowledge <id>` is called

Questions from agents that no longer exist (no directory in `.ittybitty/agents/`) are filtered out when reading.

### 4.4 ib acknowledge

`ib acknowledge <question-id>` marks a question as handled. Only the primary (user-level) Claude can acknowledge — agents are blocked via `is_running_as_agent()` check. The command finds the question by ID, sets `status` to `"acknowledged"` and records `acknowledged_at` with the current ISO 8601 UTC timestamp. On success, both bash and TypeScript print a hint: "Question acknowledged. Use 'ib send <agent-id> "answer"' to respond."

**[^note]** The TypeScript `acknowledgeQuestion` is only called from the TUI dashboard (always user-level), so it omits the `is_running_as_agent()` guard.

---

## 5. Worktree / Agent Directory Structure

### 5.1 Directory Layout

```
<repo-root>/
  .ittybitty/
    repo-id                          # 8-char hex, unique per repo
    user-questions.json              # Pending agent questions
    agents/
      <agent-id>/
        meta.json                    # Agent metadata
        agent.log                    # Timestamped event log
        prompt.txt                   # Full prompt text
        start.sh                     # Tmux startup script
        exit-check.sh                # Post-session interactive check
        resume.sh                    # Resume startup script (created on resume)
        settings.local.json          # Copied from worktree on kill/nuke; bash skips this during merge but TS copies it (see §3.5 callout)
        output.log                   # Captured tmux output (on kill/merge)
        last-nudge                   # Unix timestamp of last nudge (stop hook debounce)
        nudge-recheck                # Marker file for delayed recheck scheduling
        watchdog.log                 # Watchdog process output
        debug-logs/                  # Debug captures from hooks/watchdog/snapshot
          stop-<epoch>-<state>.txt     # Stop hook triggers
          nudge-<epoch>-<state>.txt    # Nudge recheck captures
          watchdog-<epoch>-unknown.txt  # Watchdog unknown-state captures
          snapshot-<epoch>-<state>.txt # Manual snapshot from `ib watch`
        repo/                        # Git worktree
          .claude/
            settings.local.json      # Agent-specific settings with hooks
          (... project files ...)
    archive/
      <YYYYMMDD-HHMMSS>-<agent-id>/
        output.log
        agent.log
        meta.json
        settings.local.json
        debug-logs/
    prompts/                         # Custom prompt templates
      all.md                         # Injected into all agents
      manager.md                     # Injected into manager agents
      worker.md                      # Injected into worker agents
```

### 5.2 meta.json Fields

```json
{
  "id": "agent-a1b2c3d4",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "tmux_session": "ittybitty-e5f6a7b8-agent-a1b2c3d4",
  "prompt": "Implement the login page",
  "manager": "agent-parent01" | null,
  "created": "2024-01-09T14:30:00-0600",
  "created_epoch": 1704825000,
  "worktree": true,
  "worker": false,
  "agentType": "manager",         // resolved type name (see §2.1)
  "agentIcon": "◆",               // type icon character (see §2.6)
  "yolo": false,
  "model": "sonnet",              // bash defaults to "sonnet"; legacy agents may have null
  "claude_pid": "12345",          // appended after Claude starts (not in initial write)
  "watchdog_pid": "12346",        // appended after watchdog spawns (see §8.5); not in initial write
  "state": "running",             // written by stop hook, ib send, ib resume (see §1.3.1)
  "state_updated_at": 1704825030, // epoch seconds when state was last written
  "coordinator": true             // only present for per-repo coordinators (§12.2.2)
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique agent identifier |
| `session_id` | string | UUID for Claude `--session-id` / `--resume` |
| `tmux_session` | string | Full tmux session name (`ittybitty-<repo-id>-<agent-id>`) |
| `prompt` | string | Original user prompt text |
| `manager` | string \| null | Manager agent ID, or `null` for top-level agents |
| `created` | string | ISO 8601 creation timestamp with timezone |
| `created_epoch` | number | Unix epoch seconds at creation |
| `worktree` | boolean | Whether agent has an isolated git worktree |
| `worker` | boolean | `true` for leaf agents (`canSpawnChildren: false`), `false` otherwise. Retained for backward compatibility with bash `ib`. |
| `agentType` | string \| undefined | Resolved agent type name (e.g., `"manager"`, `"worker"`, `"researcher"`). Absent on legacy agents created before the type system. See §2.1. |
| `agentIcon` | string \| undefined | Single-character icon from the agent type definition. Absent if the type has no icon or for legacy agents. See §2.6. |
| `yolo` | boolean | Whether `--yolo` (skip permissions) was used |
| `model` | string \| null | Claude model name (e.g., "sonnet", "opus", "haiku"), or `null` for legacy agents | [^callout]: Bash defaults `MODEL` to config value then `"sonnet"` before writing meta.json (the null branch in the template is unreachable dead code). TS normalizes null/missing to `"unknown"`. The `string \| null` type is retained because legacy agents may have null values, and display code (bash `ib list`) handles this defensively.
| `claude_pid` | string | PID of the Claude process (appended to meta.json via `sed` after start.sh launches Claude — not present in the initial write) |
| `watchdog_pid` | string | PID of the watchdog process (appended to meta.json after watchdog spawns — not present in the initial write; see §8.5) |
| `state` | string \| undefined | Deterministic agent state written by the stop hook, `ib send`, or `ib resume`. Values: `"running"`, `"waiting"`, `"complete"`. Absent on legacy agents or before the first stop hook fires (treated as `"running"` if agent is older than 6s). See §1.3.1. |
| `state_updated_at` | number \| undefined | Unix epoch seconds when `state` was last written. Used for debugging. |
| `coordinator` | boolean \| undefined | `true` for per-repo coordinators (§12.2.2). Absent for regular agents. |

### 5.3 Worktree ↔ Branch Relationship

Each agent's worktree is linked to a git branch named `agent/<agent-id>`:

- Top-level agents (no `--manager`) branch from `HEAD` of the main repo
- Sub-agents (any agent with `--manager`) branch from `agent/<manager-id>` regardless of worker/manager role
- All branches are local (no remote tracking)
- The worktree is at `.ittybitty/agents/<id>/repo`
- On merge or kill, both the worktree and branch are removed

### 5.4 Diff and Status — Parent Branch Resolution

`ib diff <id>` and `ib status <id>` compare an agent's branch against its parent using `git merge-base`:

- **Sub-agents** (has `manager` in meta.json): diff against `agent/<manager-id>`
- **Top-level agents** (no manager): diff against `main`

**Current limitation**: Top-level agents always diff against `main`, even if the agent was created from a non-main branch (e.g., `fix/my-feature`). This means the diff includes commits that are already on the source branch but not yet on `main`. The correct behavior would be to record the base branch at creation time in `meta.json` (e.g., `base_branch: "fix/my-feature"`) and diff against that instead. Until this is implemented, agents created from non-main branches will show inflated diffs.

The external diff tool (launched via the `d` keybinding in the TUI) has the same limitation — it hardcodes `git merge-base HEAD main` regardless of the agent's actual base branch.

### 5.5 Archive Structure

Archives are stored at `.ittybitty/archive/<YYYYMMDD-HHMMSS>-<agent-id>/` using the local time of archival. The same files as listed in §1.7 are preserved.

---

## 6. Hooks

### 6.0 Execution Contexts

itsybitsy hooks operate across three distinct execution contexts. Each context has different hook installations, permissions, and behavioral constraints:

| Context | CWD | Hooks source | Permissions source | Role detection |
|---------|-----|-------------|-------------------|----------------|
| **Primary Claude** | Any non-worktree path | `~/.claude/settings.json` (global hooks only) | User's own `~/.claude/settings.json` + repo `.claude/settings.local.json` | CWD does NOT match `/.ittybitsy/agents/<id>/repo` |
| **Spawning agent** (`canSpawnChildren: true`) | `<repo>/.ittybitsy/agents/<id>/repo` | Agent's `settings.local.json` (5 hooks: path-check, stop, session-start, permission-denied, intercept-task) | Built per §2.3 with `permissions.repo.*` (or `permissions.coordinator.*`) + `permissions.all.*` + type-defined permissions | CWD matches pattern AND agent type has `canSpawnChildren: true` |
| **Leaf agent** (`canSpawnChildren: false`) | `<repo>/.ittybitty/agents/<id>/repo` | Agent's `settings.local.json` (4 hooks: path-check, stop, session-start, permission-denied — NO intercept-task) | Built per §2.3 with `permissions.repo.*` + `permissions.all.*` + type-defined permissions | CWD matches pattern AND agent type has `canSpawnChildren: false` |

**Key distinction**: Primary Claude uses ONLY the global hooks from `~/.claude/settings.json` (§6.6). Per-agent hooks (§6.1–6.5) are installed ONLY in agent worktree `settings.local.json` files and must never leak into the user's repo-level `settings.local.json`. If agent hooks are left in a repo's `settings.local.json` after an agent is killed or merged, they will incorrectly restrict the user's direct Claude sessions in that repo.

**Hook isolation invariant**: `ib kill`, `ib nuke`, and `ib merge` must ensure agent-specific hooks are cleaned from the repo's `settings.local.json` if they were ever written there. The intended flow is:
1. Agent creation writes hooks to `<agent-dir>/repo/.claude/settings.local.json` (inside the worktree)
2. The worktree is removed on kill/merge/nuke
3. The repo's own `.claude/settings.local.json` is never modified by agent lifecycle operations

**Detection pattern**: The `AGENT_CWD_PATTERN` regex (`/.ittybitty/agents/([^/]+)/repo(/|$)`) is used by all hooks to distinguish agent contexts from primary Claude. If CWD does not match this pattern, the session is treated as primary Claude and per-agent restrictions do not apply.

itsybitsy installs hooks into each agent's `settings.local.json`, plus optional global hooks in `~/.claude/settings.json`. Agents with `canSpawnChildren: true` get five hooks (path isolation, stop, session-start, permission-denied, and intercept-task); leaf agents (`canSpawnChildren: false`) get four (no intercept-task).

### 6.1 Path Isolation Hook (PreToolUse)

**Command**: `ib hook-check-path <agent-id>`
**Matcher**: `*` (all tools)
**Hook type**: PreToolUse (runs before tool execution, can allow/deny)

**Decision logic** (checked in order):

1. **Allow list check**: Tool must match at least one pattern from `settings.local.json` `permissions.allow`. Patterns are either exact tool names (`"Read"`) or bash prefix patterns (`"Bash(git status:*)"` — matches Bash tool where command starts with `git status`).
2. **Bash cd commands**: If the tool is Bash and the command starts with `cd`, the target path is checked against the allowed paths.
3. **Bash command scanning** [^ts-only-bash-scan]: Non-cd bash commands are scanned for path references to:
   - Other agents' directories (`.ittybitty/agents/<other-id>/`)
   - The main repo root (when it differs from the worktree)
   Only paths at word boundaries (preceded by space, quote, `=`, or start of string) are checked.

[^ts-only-bash-scan]: **TS-only behavior.** The bash `ib` immediately allows all non-cd Bash commands after the allow-list check — it does not scan command strings for path references. The TS implementation added `checkBashCommandPaths()` as an extra safeguard that catches commands like `cat /repo/.ittybitty/agents/other-agent/...`.
4. **File path extraction** [^ts-only-notebook-path]: For non-Bash tools, `file_path`, `path`, or `notebook_path` from `tool_input` is checked.

[^ts-only-notebook-path]: **TS-only behavior.** The bash `ib` only extracts `file_path` and `path` from `tool_input`. The TS implementation additionally checks `notebook_path` to cover Jupyter notebook tools.

**Allowed paths**:
- Agent's own worktree (`<agent-dir>/repo/...`)
- Agent's own `agent.log`
- Home directory, `/tmp`, and other system paths (anything not in another agent's dir or the main repo)

**Denied paths**:
- Other agents' directories
- Main repo root (outside the agent's worktree)

**Logging**: Denials are logged to the agent's `agent.log` with format: `[PreToolUse] Permission denied: <tool-name> (<params>)`

### 6.2 Stop Hook (agent-status)

**Command**: `ib hook-status <agent-id>`
**Matcher**: `*`
**Hook type**: Stop (fires when Claude becomes idle)

**Input**: JSON from stdin with `last_assistant_message` field.

**Detection and state write flow**:
1. Check `last_assistant_message` (last non-empty line):
   - `"WAITING"` → write `state: "waiting"` to meta.json
   - `"I HAVE COMPLETED THE GOAL"` → write `state: "complete"` to meta.json
   - Neither → write `state: "running"` to meta.json and nudge (see below)
2. Write `state_updated_at` (epoch seconds) alongside `state` in meta.json
3. Save debug capture to `debug-logs/stop-<epoch>-<state>.txt`

The stop hook does **not** parse tmux output for state detection. It relies solely on `last_assistant_message` for determining state. Tmux-detected states (`compacting`, `rate_limited`) are handled by consumers at read time (see §1.3). However, when the determined state is `running`, the stop hook checks tmux for background tasks (`⏵⏵` pattern) to avoid nudging agents that are actively working via background tasks.

**Rate-limited agents**: If the stop hook fires while a rate limit dialog is showing, `last_assistant_message` won't contain WAITING or COMPLETED, so the hook writes `running` and attempts to nudge. The nudge is debounced (5s) and the rate limit dialog will likely block the nudge from reaching Claude. The watchdog handles rate limit bypass separately (§8.5) by sending Enter and polling the usage API.

**Actions by state**:

| State written | Condition | Action |
|---------------|-----------|--------|
| `running` | Background tasks active (`⏵⏵.*·\s\d+\s` in last 15 lines of tmux) | No action (agent is working via background tasks) |
| `running` | No background tasks | **Nudge** — debounced (5s), sends "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL'" via tmux |
| `complete` | Uncommitted changes | **Remind commit** — sends message telling agent to commit |
| `complete` | Has manager | **Notify manager** — sends "[hook]: Your subtask <id> just completed" to manager's tmux [^notify-mechanism] |
| `complete` | No manager, unfinished children | **Remind children** — tells agent to merge/kill all sub-agents |
| `complete` | No manager, no children | No action |
| `waiting` | Has manager | **Notify manager** — sends "[hook]: Your subtask <id> is now waiting for input" |
| `waiting` | No manager | No action |

**Debounce mechanism**: A `last-nudge` file stores the unix timestamp of the last nudge. If less than 5 seconds have passed, the nudge is suppressed. When debounced, a delayed recheck is scheduled (5s later) via a background `bash -c "sleep 5 && rm -f <recheck-file> && ib hooks agent-status <id>"` process, using a `nudge-recheck` marker file to prevent duplicate rechecks. The marker file is removed just before the recheck call so subsequent debounces can schedule new rechecks.

**meta.json write mechanism**: The stop hook reads the full meta.json, adds/updates the `state` and `state_updated_at` fields, and writes it back atomically (write to temp file, `rename()` over original). This preserves all other meta.json fields. The write is a merge, not a replacement.

[^notify-mechanism]: **Bash/TS divergence.** The bash `ib` notifies managers via `ib send "$manager" "message"`, which resolves the manager's tmux session internally. The TS implementation reads the manager's `meta.json` directly to get `tmux_session` and sends via `tmux send-keys` without going through `ib send`. Same end result (tmux input to manager), different mechanism.

### 6.3 Session Start Hook

**Command**: `ib hooks session-start`
**Matcher**: (none — fires on SessionStart)
**Hook type**: SessionStart

**Input**: JSON from stdin with `cwd` field (falls back to `process.cwd()` if absent).

**Role detection** based on CWD and `meta.json`:
- If CWD does not match `/.ittybitty/agents/<id>/repo` → **primary** (user-level Claude)
- If CWD matches → reads `meta.json` and checks `agentType`, then falls back to legacy booleans:
  - `agentType` is set → role is derived from the type name (`"coordinator"` → coordinator, `"worker"` → worker, else → manager). However, this role is only used as a fallback — the actual instruction generation uses the type's `instructionStyle` field.
  - `agentType` is not set (legacy agent) → `coordinator: true` → coordinator, `worker: true` → worker, else → manager

**Output**: JSON with `hookSpecificOutput.additionalContext` containing role-appropriate instructions wrapped in `<ittybitty>` tags.

### 6.3.1 Instruction Generation

Instructions are generated based on the agent's type definition:

1. **If `agentType` is set in meta.json**: Load the type definition via `loadAgentType()`. If the type has a `markdownBody` (template body from the `.md` file), interpolate it with the session context variables and wrap in `<ittybitty>` tags. If no body, fall back to the hardcoded instructions matching the type's `instructionStyle` field (`"manager"`, `"worker"`, or `"coordinator"`).

2. **If `agentType` is not set (legacy agent)**: Use the detected role (from legacy `worker`/`coordinator` booleans) to select hardcoded instructions.

**Template interpolation**: Template bodies support `{{variable}}` placeholders and `{{#if condition}}...{{/if}}` conditional blocks:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{agentManager}}` | Manager's agent ID (empty if top-level) |
| `{{parentBranch}}` | Parent branch name (`agent/<manager-id>` or `main`) |
| `{{worktreePath}}` | Full path to agent's worktree |
| `{{rootRepoPath}}` | Full path to the root repo |
| `{{repoName}}` | Repository basename |

| Condition | True when |
|-----------|-----------|
| `{{#if hasManager}}` | Agent has a manager |
| `{{#if isTopLevel}}` | Agent has no manager |

**Hardcoded instruction sets** (used when no template body exists):

- **Primary**: Available `ib` commands for spawning and managing agents
- **Manager**: Agent identity, worktree path, git context, sub-agent commands, workflow guidance, merge conflict handling (delegate rebasing to sub-agents), state management (`WAITING`/`I HAVE COMPLETED THE GOAL`), ask capability (top-level only)
- **Worker**: Agent identity, worktree path, git context, send/diff/status commands only, state management, communication with manager
- **Coordinator**: Read-only coordination, `ib` commands, code reading tools, no write access

### 6.4 Intercept Task Hook (PreToolUse)

**Command**: `ib hooks intercept-task`
**Matcher**: `Task|Agent|TaskCreate`
**Hook type**: PreToolUse

Intercepts Claude Code's Task, Agent, and TaskCreate tools and redirects them to spawn ib agents instead:

1. **Leaf agent denial**: If called from a leaf agent (an agent whose type has `canSpawnChildren: false`, detected via CWD + `meta.json`), denies with "Workers cannot create tasks or spawn sub-agents"
2. **Only intercepts `Task`, `Agent`, and `TaskCreate` tools** — all other tools pass through
3. **Skip for certain subagent_types**: `Bash`, `statusline-setup`, `claude-code-guide`, `meta-agent`, `ib-merge` pass through unintercepted
4. **Model validation**: Only `sonnet`, `opus`, `haiku`, or empty string are allowed
5. **Spawn behavior**:
   - When called from an agent context: spawns a `--type worker` with the calling agent as `--manager`
   - When called from primary Claude: spawns a manager (no `--type worker`)
6. **Output**: Rewrites the Task invocation to a `claude-code-guide` subagent that simply reports the spawned agent ID

This hook is installed for agents with `canSpawnChildren: true` (not leaf agents), and only when the main repo's settings already have the intercept hook installed. The hook intercepts `Task`, `Agent`, and `TaskCreate` tool calls. For spawning agents, all three are intercepted and spawn ib workers. For leaf agents, all three are denied with "Workers cannot create tasks or spawn sub-agents." The hook matcher includes `TaskCreate` so it fires for that tool in addition to `Task` and `Agent` (see §2.2).

### 6.5 Permission Denied Hook (PermissionRequest)

**Command**: `ib hook-permission-denied <agent-id>`
**Matcher**: `*`
**Hook type**: PermissionRequest

Fires when Claude requests permission for a tool that isn't auto-allowed. Simply logs `[PermissionRequest] Tool denied: <tool-name>` to `agent.log`. Cannot override permissions — PermissionRequest hooks are informational only. Always exits 0 with no stdout output. [^callout-permission-denied]

[^callout-permission-denied]: **Bash/TS divergence.** The bash `ib` does not have a handler for the `hook-permission-denied` subcommand — the command hits the "Unknown command" default case and exits 1 with an error to stderr. Since PermissionRequest hooks are informational only and Claude Code ignores non-zero exits from them, this means the bash version silently fails to log permission denials. The TS implementation properly handles the command and logs to `agent.log`.

### 6.6 Global Hooks (installed in ~/.claude/settings.json)

These are optional hooks that the user installs globally:

- **Main-path hook** (`ib hooks main-path`): PreToolUse hook on `Bash` matcher that prevents the primary Claude from `cd`-ing into agent worktrees. Only checks Bash `cd` commands — allows Read/Write/Edit to worktree paths. Resolves relative paths via `cwd` from stdin JSON. Exits 0 (allow) or 2 (deny with JSON written to stdout).
- **Intercept-task hook** (`ib hooks intercept-task`): PreToolUse hook on `Task|Agent|TaskCreate` matcher (global version, enables task/agent/TaskCreate interception for all repos)
- **Status injection hooks** (`ib hooks inject-status`): Two hooks — a UserPromptSubmit hook (no matcher, `--full --visible`) and a PostToolUse hook (`Bash|Task` matcher, `--if-changed --visible`). Skips injection when CWD is inside an agent worktree. Supports modes: `--full` (complete agent tree), `--brief` (one-liner summary), `--if-changed` (hash-compared, outputs brief only when changed). `--visible` adds a `systemMessage` field for user-visible status line.
- **Session-start hook** (`ib hooks session-start`): SessionStart hook that injects ittybitty context

Install/uninstall commands modify `~/.claude/settings.json` directly. [^hooks-install-location]

[^hooks-install-location]: **Bash/TS divergence.** The bash `ib hooks install` and `ib hooks install-intercept` write to `.claude/settings.local.json` (per-repo, relative to CWD). The TS implementation writes to `~/.claude/settings.json` (global) — a deliberate change so itsybitsy's safety hooks apply to all Claude sessions, not just ones launched from the project directory.

---

## 7. Configuration

### 7.1 Config File Layering

**[^callout]** The bash reference implementation supports two config files with layered priority: `.ittybitty.json` (project root, highest priority) → `~/.ittybitty.json` (user home) → built-in defaults. The TypeScript reimplementation uses a single `~/.itsybitsy/config.json` file with no per-project configuration.

In the TypeScript implementation, configuration is user-wide only, stored in a single file:

1. **User config**: `~/.itsybitsy/config.json` in the user's home directory
2. **Defaults**: Built-in defaults for each key

For each config key, the first valid value found (user → default) is used.

### 7.2 Config Keys

All keys are read from `~/.itsybitsy/config.json`. If a key is absent or has an invalid type, the built-in default is used.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxAgents` | number | `10` | Maximum number of concurrently active agents. Checked at spawn time in `newAgent()` — the count of agent directories that contain a `meta.json` must not exceed this value. |
| `model` | string | `"opus"` | Default Claude model for new agents. Resolution order at spawn time: `--model` CLI flag → config `model` → `"opus"`. |
| `fps` | number | `10` | TUI screen refresh rate (frames per second) for `ib watch`. |
| `createPullRequests` | boolean | `false` | When `true`, agents are instructed (via their prompt) to create a pull request upon completing their work. |
| `allowAgentQuestions` | boolean | `true` | When `false`, the `askQuestion` (`ib ask`) command returns an error, blocking top-level manager agents from posing questions to the user. (`acknowledgeQuestion` is the user-facing command to mark a question answered and does not check this flag.) |
| `autoCompactThreshold` | number | (none) | Context window usage percentage (0–100) above which the watchdog automatically sends `/compact` to the agent's tmux session. When absent (the default), auto-compact is disabled. |
| `externalDiffTool` | string | (none) | External diff viewer command used by the TUI (`ib watch`). Read from `~/.itsybitsy/config.json` at startup via `readConfig()`; written back via `writeConfig()` when changed in the settings dialog. When absent or empty, the diff action is disabled. |
| `hooks.injectStatus` | boolean | `true` | When `false`, the `inject-status` UserPromptSubmit/PostToolUse hook exits immediately without injecting agent status into the Claude context. |
| `hooks.statusVisible` | boolean | `true` | When `true` (and `hooks.injectStatus` is also `true`), the status injection hook also emits a `systemMessage` field so the injected summary appears visibly to the user in the Claude UI. When `false`, status is injected as silent `additionalContext` only. |
| `permissions.all.allow` | string[] | `[]` | Additional tool names added to the allow list for ALL agents regardless of type (merged with mandatory permissions at spawn time). |
| `permissions.all.deny` | string[] | `[]` | Additional tool names added to the deny list for ALL agents regardless of type. |
| `coordinator.model` | string | `"opus"` | Default model for coordinator agents. Resolution: `--model` > type `model` > `coordinator.model` > `"opus"`. |
| `permissions.coordinator.allow` | string[] | `[]` | Additional tool names added to the allow list for coordinator-type agents. |
| `permissions.coordinator.deny` | string[] | `[]` | Additional tool names added to the deny list for coordinator-type agents. |
| `permissions.repo.allow` | string[] | `[]` | Additional tool names added to the allow list for all non-coordinator agents (repo-wide baseline). |
| `permissions.repo.deny` | string[] | `[]` | Additional tool names added to the deny list for all non-coordinator agents. |

**Deprecated keys**: `permissions.manager.allow/deny` and `permissions.worker.allow/deny` have been removed. If present in the config file, a deprecation warning is shown at `ib watch` startup. Per-type permissions now live in agent type definition files (see §2.6).

### 7.3 Permission Resolution

For a given agent, `buildAgentSettings()` constructs `<agent-dir>/repo/.claude/settings.local.json` by merging permissions from four sources. See §2.3 for the full details and exact file paths.

Summary:

1. **`<repo>/.claude/settings.json`** — base project allow list (deny entries NOT inherited)
2. **Hardcoded mandatory** — ib commands, git operations, filesystem inspection, Claude Code tools
3. **`~/.itsybitsy/config.json`** — `permissions.all.*` + role-specific scope (`permissions.coordinator.*` or `permissions.repo.*`)
4. **`~/.itsybitsy/agent-types/<type>.md`** — `permissions.allow/deny` from type frontmatter
5. Deduplicate all allow/deny lists

[^perm-quirk]: The bash implementation has a quirk: if `CONFIG_WORKER_ALLOW` is empty, it falls through to `CONFIG_MANAGER_ALLOW` (and `deny` follows suit). The TS implementation intentionally does not replicate this — the new system uses explicit scope-based permissions (all/repo/coordinator) with no fallthrough.

### 7.4 Custom Prompts

Custom prompt files in `.ittybitty/prompts/`:

| File | Injected into |
|------|--------------|
| `all.md` | All agents (wrapped in `[CUSTOM INSTRUCTIONS]`) |
| `manager.md` | Manager agents (wrapped in `[CUSTOM MANAGER INSTRUCTIONS]`) |
| `worker.md` | Worker agents (wrapped in `[CUSTOM WORKER INSTRUCTIONS]`) |

### 7.5 ib config

`ib config <subcommand>` reads and writes configuration values in `~/.itsybitsy/config.json`. This is the CLI interface for managing the config keys described in §7.2.

**[^callout]** The bash reference implementation supports `--global` / `-g` flag and per-project `.ittybitty.json` files. The TypeScript reimplementation has no per-project config — all operations target `~/.itsybitsy/config.json`. The `--global` flag is not supported.

#### Config File

All subcommands operate on the single user-wide config file:

| File | Description |
|------|-------------|
| `~/.itsybitsy/config.json` | User-wide configuration (only config source) |

Values not set in this file use built-in defaults (§7.2).

#### Subcommands

##### `ib config list`

Lists all known config keys with their current values and sources.

1. Each line shows the key, its effective value, and a source label: `(user)` or `(default)`.
2. **Unset keys**: Keys with no value and no default display as `(unset)`.
3. **All known keys are listed**, including those not present in the config file. The full key list matches `CONFIG_KEYS` in `config.ts`: `maxAgents`, `model`, `createPullRequests`, `allowAgentQuestions`, `autoCompactThreshold`, `externalDiffTool`, `hooks.injectStatus`, `hooks.statusVisible`, `permissions.all.allow`, `permissions.all.deny`, `coordinator.model`, `permissions.coordinator.allow`, `permissions.coordinator.deny`, `permissions.repo.allow`, `permissions.repo.deny`.
4. A legend line is printed after the list explaining the source labels.
5. Aliases: `ib config ls` is accepted as an alias for `list`.

##### `ib config get <key>`

Gets the effective value for a single config key.

1. **Key required**: Exits with error if no key is provided. Error output includes the list of available keys.
2. Resolves value from user config file, falling back to built-in default.
3. **Unknown keys**: Exits with error `"Unknown config key: '<key>'"` and prints available keys.
4. **Output**: Prints the value to stdout (no label, no formatting). For array values, outputs the JSON array representation. For unset keys with no default, prints empty string.

##### `ib config set <key> <value>`

Sets a scalar config value.

1. **Key and value required**: Exits with error if either is missing.
2. **Config file creation**: If `~/.itsybitsy/config.json` does not exist, the `~/.itsybitsy/` directory and file are created.
3. **Unknown keys rejected**: Only keys defined in `CONFIG_KEYS` are accepted. Unknown keys produce error `"Unknown config key: '<key>'"`.
4. **Array keys rejected**: Keys with type `string[]` (the `permissions.*` keys) are rejected with an error directing the user to use `ib config add` / `ib config remove` instead.
5. **Type validation** for known keys:
   - `number` type keys (`maxAgents`, `autoCompactThreshold`): Must be a non-negative integer (`/^[0-9]+$/`). Error: `"'<key>' must be a number, got '<value>'"`.
   - `boolean` type keys (`createPullRequests`, `allowAgentQuestions`, `hooks.injectStatus`, `hooks.statusVisible`): Must be `"true"` or `"false"`. Error: `"'<key>' must be true or false, got '<value>'"`.
   - `model`: Must be one of `"sonnet"`, `"opus"`, `"haiku"`. Error: `"'<key>' must be one of: sonnet, opus, haiku"`.
6. **Value encoding**: Integers are stored as JSON numbers. `true`/`false` are stored as JSON booleans. All other values are stored as JSON strings.
7. **Dot notation**: Keys use dot notation to access nested paths (e.g., `hooks.injectStatus` maps to `{"hooks": {"injectStatus": ...}}`).
8. **Output**: On success, prints `"Set <key> = <value>"`.

##### `ib config add <key> <value>`

Adds a value to an array config key, preventing duplicates.

1. **Key and value required**: Exits with error if either is missing. Error output lists the valid array keys.
2. **Array keys only**: Only `permissions.all.allow`, `permissions.all.deny`, `permissions.coordinator.allow`, `permissions.coordinator.deny`, `permissions.repo.allow`, and `permissions.repo.deny` are accepted. All other keys are rejected with an error.
3. **Config file creation**: If `~/.itsybitsy/config.json` does not exist, the directory and file are created.
4. **Duplicate prevention**: If the value already exists in the array, prints `"Value '<value>' already exists in <key>"` and exits successfully (exit code 0).
5. **Output**: On success, prints `"Added '<value>' to <key>"`.

##### `ib config remove <key> <value>`

Removes a value from an array config key.

1. **Key and value required**: Exits with error if either is missing. Error output lists the valid array keys.
2. **Array keys only**: Same restriction as `add`.
3. **Config file required**: If the config file does not exist, exits with error `"Config file not found: ~/.itsybitsy/config.json"`.
4. **Missing value**: If the value is not in the array, prints `"Value '<value>' not found in <key>"` and exits successfully (exit code 0).
5. **Output**: On success, prints `"Removed '<value>' from <key>"`.

##### `ib config unset <key>`

Removes a key from the config file, reverting it to its built-in default.

1. **Key required**: Exits with error if no key is provided.
2. **Unknown keys rejected**: Only keys defined in `CONFIG_KEYS` are accepted.
3. **Config file required**: If the config file does not exist, exits with error.
4. **Array keys**: For array keys, removes the entire array from the config file (equivalent to reverting to the default `[]`).
5. **Output**: On success, prints `"Unset <key> (reverted to default)"`. If the key was not set, prints `"Key '<key>' is not set"` and exits successfully.

#### Help and Errors

- `ib config` (no subcommand), `ib config -h`, `ib config --help`, or `ib config help` prints full usage with available subcommands, available keys, examples, and value type documentation.
- Unknown subcommands produce: `"Error: Unknown subcommand '<name>'"` with a brief usage hint and pointer to `--help`.
- All error output goes to stderr. All success output goes to stdout.

#### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success (including idempotent cases like adding a duplicate or removing a missing value) |
| `1` | Error (missing arguments, validation failure, unknown key, file I/O error) |

---

## 8. Supplementary Behaviors

### 8.1 Partial ID Resolution

Agent IDs can be specified as partial strings. Resolution:

1. **Exact match** — check agent directory, then tmux sessions (`ittybitty-*-<partial>`)
2. **Substring match** — scan all agent directories and tmux sessions for the pattern, extracting agent IDs from session names (format: `ittybitty-<repoid>-<agentid>`)
3. If 0 matches → error. If 1 match → use it. If 2+ matches → error listing all matches.

### 8.2 Agent Logging

All agent events are logged to `<agent-dir>/agent.log` with format:
```
[YYYY-MM-DD HH:MM:SS] message
```

In bash, `log_agent()` also echoes the message to stdout unless called with `--quiet`. The TS `logAgent()` only writes to the file (no stdout echo).

> [^callout] TS `logAgent()` is write-only — no stdout echo. Callers that need visible output handle it separately.

### 8.3 Orphan Detection and Cleanup

After kills/nukes, the system scans for orphaned Claude processes:

1. Find all processes matching "claude" via `pgrep`
2. For each, determine its CWD (macOS: `lsof -d cwd`, Linux: `/proc/<pid>/cwd`)
3. If CWD contains `/.ittybitty/agents/` and the agent directory no longer exists → orphan
4. Kill orphans with SIGTERM → wait 2s → SIGKILL

### 8.4 Auto-Compact

Reads Claude transcript JSONL files to determine context window usage percentage. When an agent exceeds the configured threshold (`autoCompactThreshold`), sends `/compact` to the agent's tmux session. In bash, `/compact` is sent in any state except `compacting` (and only if not already sent). A `compactSent` flag prevents duplicate sends; the flag resets when the agent transitions out of `compacting` state.

> [^note] TS restricts auto-compact sends to `running` or `waiting` states only (stricter than bash). TS resets the `compactSent` flag when usage drops below the threshold rather than on state transition out of `compacting`. TS also has a 60-second per-agent cooldown between usage checks (`COMPACT_CHECK_COOLDOWN_MS`); bash checks on every 5-second watchdog poll. See also §8.5 Watchdog for related auto-compact behavior in the watchdog loop.

### 8.5 Watchdog

`ib watchdog <id>` runs as a background loop for a single agent, polling every 5 seconds. ALL agents get a per-agent watchdog — both top-level agents and sub-agents with a manager. The watchdog PID is saved to `meta.json` as `watchdog_pid`.

**State source**: The watchdog reads `state` from `meta.json` (written by the stop hook — see §1.3.1 and §6.2). It does **not** use tmux for primary state detection. For `rate_limited` and `compacting`, the watchdog checks tmux output for those specific patterns only (same minimal tmux parsing that state consumers use — see §1.3 step 3). The rate limit handler also uses tmux to verify dialog dismissal after sending Enter.

**Exit conditions**: The watchdog exits when: (a) the agent's worktree directory is removed (`while [[ -d "$AGENT_DIR/repo" ]]`), which happens on kill/merge/nuke, or (b) in TS, the agent's tmux session has been missing for >10 consecutive seconds (grace period). Bash does **not** check tmux session existence, so it survives pause and must be exited by worktree removal only. On resume, a new watchdog is spawned (§1.6 step 7).

Per-agent watchdogs do not use lock files. There is no global watchdog.

**State resolution per tick**: The watchdog resolves the agent's effective state on each 5-second tick using the same resolution order as consumers (§1.3):
1. No tmux session → `stopped` (or `creating` if within grace period)
2. Tmux "Compacting conversation" in last 5 lines → `compacting`
3. Tmux rate limit patterns in last 15 lines → `rate_limited`
4. Read `state` from meta.json → `running`, `waiting`, or `complete`

**Monitoring behaviors by state:**

| State | Action |
|-------|--------|
| `waiting` | Increment waiting counter. When counter reaches the notification threshold, notify manager: "[watchdog]: Your subtask <id> recently started waiting for input". Uses exponential backoff: initial threshold 30s (6 polls), doubles after each notification, capped at 64 minutes. |
| `complete` | Reset waiting counter and notification interval. Notify manager once: "[watchdog]: Your subtask <id> recently completed". Sets a flag to prevent duplicate notifications. Flag resets if agent returns to `running`. |
| `rate_limited` | Attempt to bypass the rate limit dialog (3-attempt retry loop with 2s sleeps between attempts; checks tmux output for rate limit patterns after each Enter to verify dismissal). Then poll Claude's usage API; when session usage drops below 5%, send nudge: "[watchdog]: Usage has refreshed (<pct>%). Please continue your task." Reset waiting counter and notification interval. |
| `running` | Reset waiting counter, notification interval, and `rateLimitBypassed` flag. Clear completion flag if previously set. |
| `creating` | Treat as running — reset waiting counter, notification interval, and `rateLimitBypassed` flag. |
| `compacting` | Reset waiting counter, notification interval, and `rateLimitBypassed` flag. Wait for completion. |
| `stopped` | Reset waiting counter and notification interval. |

> **`unknown` state removed**: The old `unknown` handler (exponential backoff + debug capture) is no longer needed. With deterministic state tracking, agents always have a known state. If meta.json has no `state` field (legacy agent), it is treated as `running`.

**Auto-compact**: If `autoCompactThreshold` is configured, the watchdog also checks the agent's context window usage on each poll. When usage exceeds the threshold and the agent is not currently compacting, sends `/compact` to the agent's tmux session. The compact flag resets when the agent transitions out of `compacting` state.

> [^callout] TS watchdog auto-compact only runs for agents in `running` or `waiting` states (not any non-compacting state) and enforces a 60-second per-agent cooldown between checks (`COMPACT_CHECK_COOLDOWN_MS`). The compact flag reset behavior differs: TS resets when usage drops below threshold (in `checkAndCompact`), not on state transition out of compacting. See also §8.4 callout.

**Quiet mode** (`--quiet`): Allows monitoring agents without managers. All notifications are logged but not sent.

> [^callout] TS has no `--quiet` mode; agents without managers simply receive no notifications (the `notifyManager` helper no-ops when `meta.manager` is unset). The per-agent TS watchdog adds a tmux session grace period (10s) as an additional exit condition not present in bash.

### 8.6 Root Repo Resolution

When running from a worktree, the root repository is found via:

1. `git rev-parse --git-common-dir` to find the shared `.git` directory
2. If the result is `.git` or matches `--git-dir`, we're in the main repo → use `--show-toplevel`
3. Otherwise, go up one directory from the common dir to find the root

Both bash and TS resolve relative `common_dir` paths to absolute before taking the parent directory. Bash uses `cd "$root_path" && pwd`; TS uses `resolve(repoPath, commonDir)` then `dirname()`. This ensures a correct absolute path regardless of worktree layout or relative `--git-common-dir` output.

### 8.7 Reassign Command

`ib reassign <agent-id> <new-parent-id>` or `ib reassign <agent-id> --none`

Reassigns an agent to a different parent manager (or makes it a root manager with `--none`).

**Validation:**

1. Resolve both agent ID and new parent ID (partial ID resolution)
2. Agent must exist
3. Cannot reassign an agent to itself
4. New parent must exist (unless `--none`)
5. New parent cannot be a leaf agent (`canSpawnChildren: false`)
6. New parent cannot be a descendant of the agent (circular dependency check)
7. No-op if agent already has the requested parent

**On success:**

1. Update `meta.json` — set `manager` to the new parent ID (or `null` for `--none`)
2. Log the change to the agent's `agent.log`
3. Notify the old parent: `"[watchdog for <id>]: Agent reassigned to manager '<new>'"`
4. Notify the new parent: `"[watchdog for <id>]: Agent reassigned to you (was under <old>)"`
5. Notify the agent itself: `"[watchdog]: You've been reassigned from <old> to <new>"`

Notifications are sent via `ib send` (bash) / `sendMessage` (TS) and suppressed if the target agent doesn't exist or isn't running.

### 8.8 Post-Create-Agent Hook

Bash runs `.ittybitty/hooks/post-create-agent` in the background after agent creation, appending its stdout/stderr to `agent.log`. itsybitsy does not implement this hook — it is considered legacy and unused.

### 8.9 Agent Prompt Summary

When a new agent is created, itsybitsy generates a short summary of the agent's prompt using `claude -p` with the `claude-haiku-4-5` model. This runs in the background (fire-and-forget) immediately after agent creation and does not block the creation flow.

**Generation:**
- Command: `claude -p "Summarize the following agent task in 30-40 words:\n\n{prompt}" --model claude-haiku-4-5-20251001`
- Output is trimmed and stored in `meta.json` as `summary`
- If generation fails (claude not on PATH, API error, timeout), `summary` is left unset — no error is surfaced

**Storage:** `meta.json` gains a new optional field:
```json
{ "summary": "Short human-readable description of the agent's task (~30-40 words)" }
```

**Display:** The TUI dashboard (`ib watch`) shows `summary` in the agent list instead of the raw prompt. If `summary` is not yet set (generation still in progress or failed), the prompt is used as fallback. This is an itsybitsy-only feature — bash `ib` has no equivalent.

### 8.10 TUI Dashboard Navigation

The `ib watch` TUI supports the following keyboard navigation for the agent tree:

**Row-by-row navigation (`j`/`k` or arrow keys):** Moves one entry at a time through the flat list (repo headers and agents alike).

**Repo-jump navigation (`J`/`K` — Shift+j/k):** Jumps to the next or previous repo boundary. Behavior depends on what is currently selected:

- **Repo header selected**: `J` moves to the next repo header; `K` moves to the previous repo header. Wraps around.
- **Agent selected**: `J` jumps to the first agent of the next repo that has agents, skipping any repos with no agents. `K` jumps to the last agent of the previous repo that has agents, skipping any repos with no agents. The selection always stays on an agent — repos with no visible agents are skipped entirely. Wraps around.

### 8.11 Repo Info Panel

When a repo header is selected and the current pane mode is agent-specific (AGENT LOG, INITIAL PROMPT, DENIALS, DIFF, STATUS), the right pane displays a repo info summary instead of showing "No agent selected".

The summary always includes:

- **Repo name** with a disclosure triangle (▾ if it has agents, ▸ if empty)
- **Path** — always shown, even when the repo has no agents. The path is rendered as a terminal **OSC 8 hyperlink** using the `file://` scheme (e.g., `\x1b]8;;file:///Users/me/project\x07/Users/me/project\x1b]8;;\x07`), making it clickable in terminals that support OSC 8 (Ghostty, iTerm2, etc.). Clicking opens the path in Finder. Special characters in the path (`%`, space, `#`, `?`) are percent-encoded in the URI portion; the display text shows the raw path.
- **Agent count** and per-state breakdown (e.g., `running: 2`, `waiting: 1`)

The path is sourced from the `repoPath` field on the `repo-header` FlatEntry, which is always available regardless of whether agents exist.

**OSC 8 truncation safety:** Because `truncateToWidth` may drop the closing OSC 8 sequence when truncating long lines, all lines in the non-wrapping render branch pass through `closeOsc8()`, which detects unclosed hyperlinks and either appends the close tag or strips partial OSC sequences left by mid-URI truncation. The wrapping render branch (AGENT LOG, QUESTIONS, etc.) also applies this fix.

### 8.12 Ghostty Integration

The `G` keybinding opens a new Ghostty terminal window. Behavior depends on what is currently selected:

- **Agent selected**: Opens Ghostty attached to the agent's tmux session (using `--command` with `tmux attach -t <session>`). The tmux `window-size` option is set to `latest` so the pane resizes to match Ghostty's dimensions. Requires the agent to have an active tmux session.
- **Repo header selected (no agent)**: Opens Ghostty with a fresh login shell in the repo's directory (using `--command bash -c 'cd "$1" && exec bash -l' _ <path>`). The path is passed as a positional argument — never interpolated into the shell code. No tmux session is involved.
- **Nothing selected**: Shows a notice ("No agent or repo selected").

Both paths validate their inputs (tmux session names against `/^[\w-]+$/`; directory paths against control characters and DEL) before spawning Ghostty. The spawn uses array-based `Bun.spawn` (no shell interpolation) with `stdio: ["ignore", "ignore", "ignore"]` and `proc.unref()` to detach from the parent process.

### 8.13 REPO Pane Mode

The REPO pane mode displays repo-level action hints — available `ib` commands for the selected repository. It is a full-width, top-anchored pane mode (like DIFF, ERRORS, QUESTIONS). REPO mode activates automatically when a repo header is selected in the agent tree, and restores the previous pane mode when an agent is selected. It is skipped during `p`/`n` pane cycling.

---

## 9. Multi-Repo Registry

### 9.1 Registry File

itsybitsy monitors multiple git repositories. The list of watched repos is stored in:

```
~/.itsybitsy/repos.json
```

This file is user-wide and persists across sessions. It is managed exclusively via `ib add` and `ib remove` — do not edit it manually.

### 9.2 Registry Format

```json
{
  "repos": [
    { "path": "/Users/me/projects/my-app", "name": "my-app" },
    { "path": "/Users/me/projects/other-repo", "name": "other-repo" }
  ]
}
```

Each entry is an object with `path` (absolute path to the git repository root), `name` (the repository basename), and an optional `nickname` field for a user-defined display name.

### 9.3 Registry Commands

| Command | Description |
|---------|-------------|
| `ib add [path]` | Add a repo to the registry. Defaults to `git rev-parse --show-toplevel` in the current directory if no path is given. Errors if the path is not a git repository or is already registered. Rejects repos whose basename is `coordinator` (reserved for system coordinator addressing, §12.3.1). |
| `ib remove [path]` | Remove a repo from the registry. Defaults to CWD git root. Errors if the path is not currently registered. |
| `ib list` | List all registered repos and their agents. |

The `ib watch` TUI reads this registry at startup and monitors all registered repos simultaneously.

---

## 10. Setup/Hooks Dialog

### 10.1 Dialog Structure

The Setup dialog is accessible via the `h` keybinding in `ib watch`. It is a tabbed dialog with two tabs:

| Tab Index | Tab Name | Description |
|-----------|----------|-------------|
| 0 | **Hooks** | Manage global hook installation. Shows two items: **Safety hooks** (path isolation + status injection + session-start context, grouped as one toggle) and **Task interception** (intercept-task hook). Per-agent hooks (path-check, stop) are installed automatically per agent and are not shown here. |
| 1 | **Config** | Edit user-wide configuration keys from `~/.itsybitsy/config.json` (e.g., `externalDiffTool`, `autoCompactThreshold`). Changes are written back via `writeConfig()`. |

Tab names are defined in `SETUP_TAB_NAMES = ['Hooks', 'Config']`. Switching between tabs updates the dialog content without closing it.

### 10.2 Permissions Editor

Within the Config tab, a **permissions editor** sub-dialog allows editing the config-level permission lists (`permissions.all.allow/deny`, `permissions.coordinator.allow/deny`, `permissions.repo.allow/deny`) in `~/.itsybitsy/config.json`. Each list is editable independently. Changes take effect for newly created agents (existing agents' `settings.local.json` is not modified retroactively). Per-type permissions are defined in agent type files (§2.6), not in the config.

---

## 11. Sidebar Layout

### 11.1 Layout Structure

The `ib watch` TUI uses a three-column layout:

```
┌──────────────┬──────────────────┬──────────────────────┐
│  LEFT SIDEBAR│  tmux pane       │  right pane (cycling) │
│  (60 cols)   │  (resizable)     │  modes: log / prompt /│
│              │                  │  denials / tree /     │
│  Agent Tree  │                  │  errors / diff /      │
│  (compact)   │                  │  questions / status / │
│              │                  │  repo                 │
│──────────────│                  │                       │
│  Info Panel  │                  │                       │
│  (selected   │                  │                       │
│   agent)     │                  │                       │
│──────────────│                  │                       │
│  Coordinator │                  │                       │
│  Claude      │                  │                       │
│  (tmux out)  │                  │                       │
│──────────────│                  │                       │
│ > input█     │                  │                       │
│──────────────│                  │                       │
└──────────────┴──────────────────┴──────────────────────┘
  status bar (2 lines)
```

The input field location depends on which panel has focus: when the coordinator has focus and is selected (TMUX view in main area), the input field appears at the bottom of the coordinator tmux pane in the main area; when the active agent pane has focus, it appears at the bottom of the tmux pane in the main area (see §13.4).

The left sidebar defaults to 60 columns (resizable via `[`/`]` when a sidebar panel has focus, range 30–120). It is a vertical stack containing two sections: agent tree (top) and info panel (bottom). The system coordinator is never shown in the sidebar — when the coordinator is selected in the agent tree, the main area shows its tmux output at full width. The main area to the right of the sidebar retains the existing split-pane layout: tmux output on the left and cycling right pane on the right.

### 11.2 Left Sidebar

The sidebar defaults to 60 columns wide, resizable via `[`/`]` when any sidebar panel has focus (range: 30–120 columns). A vertical separator (`│`) divides the sidebar from the main area.

The sidebar renders two vertically stacked sections, separated by horizontal rules:

1. **Agent Tree** — compact agent list (see §11.3)
2. **Info Panel** — details for the selected agent (see §11.4)

The relative heights of these sections are determined as follows:

```
available = terminal_rows - header(1) - separator(1) - status_bar(2)
tree_height = min(MAX_TREE_HEIGHT, agent_count + repo_count)  // up to 7
info_height = max(1, available - tree_height - separators(1))
```

- The agent tree occupies up to 7 rows (same as the current `MAX_TREE_HEIGHT`), with scroll indicators (`▲`/`▼`) if more rows exist.
- The info panel fills the rest (minimum 1 row).
- If the terminal is too short to fit both sections, the info panel shrinks first (down to 0 rows — hidden entirely).

### 11.3 Compact Agent Tree

In the sidebar layout, the agent tree uses a compact row format to fit within 60 columns:

```
icon agent-id          state      age
```

Each row shows:
- **Icon**: Resolved from `meta.json` `agentIcon` field, falling back to legacy detection (`◇` coordinator, `⚙` worker, `◆` manager). Custom types can define any icon character (see §2.6). `⚠` prefix if orphaned.
- **Agent ID**: e.g., `agent-a1b2c3d4`
- **State**: color-coded, right-aligned
- **Age**: e.g., `2h`, `3d`

**Omitted from tree rows** (moved to info panel): model name and prompt/summary text. These are displayed in the info panel (§11.4) for the currently selected agent.

Repo headers remain as-is: `▾ repo-name` or `▸ repo-name` (bold).

### 11.4 Info Panel

The info panel displays details for the currently selected item. It is read-only (no interactive elements). When focused via Tab cycling (see §13), `{`/`}` resize its height and `[`/`]` resize the sidebar width.

**When an agent is selected**, the info panel shows:

1. **Stoplight indicators** (one per line):
   - `● Claude` — green if `claude_pid` from `meta.json` refers to a running process (check via `kill -0`), red otherwise
   - `● Watchdog` — green if `watchdog_pid` from `meta.json` refers to a running process, red otherwise
2. **Model**: The agent's model name (e.g., `opus`, `sonnet`)
3. **Summary/Prompt**: The agent's summary (if available) or the first few lines of the prompt, wrapped to sidebar width

**When a repo header is selected**, the info panel shows:

1. **Repo path**
2. **Agent count** and per-state breakdown (e.g., `running: 2, waiting: 1`)

**Process liveness check**: To determine if a PID is alive, use `process.kill(pid, 0)` (signal 0 checks existence without sending a signal). Wrap in try/catch — throws if the process doesn't exist or the user doesn't have permission. Check on each render cycle (the info panel re-renders when the watcher fires or the selection changes).

### 11.5 Terminal Size Requirements

Minimum terminal size: **140 columns × 24 rows**.
- Sidebar: 60 columns (default) + 1 separator
- Main area: 79 columns minimum (same as current 80-column minimum for the split pane)

Terminals narrower than 140 columns or shorter than 24 rows display a warning: `[Terminal too small — resize to at least 140×24]`.

---

## 12. Coordinator System

The coordinator system has two tiers: one **system coordinator** that manages work across all repos, and **per-repo coordinators** that manage work within a single repo. The system coordinator is auto-spawned when `ib watch` launches (§12.1.2). Per-repo coordinators are created manually via CLI, TUI, or the system coordinator (§12.2.3). Together they form a coordination hierarchy: user → system coordinator → per-repo coordinators → agents. Addressing uses `@`-based syntax for coordinator targets and bare agent IDs for direct agent messaging (§12.3.1).

### 12.1 System Coordinator

#### 12.1.1 Purpose

The system coordinator is a Claude Code session that runs from `~/.itsybitsy/` with restricted permissions. Its purpose is to coordinate agents across all registered repos using `ib` commands — it cannot read files, write code, or perform research directly. The user interacts with it via the TUI.

#### 12.1.2 Lifecycle

**Auto-spawn on startup**: When `ib watch` launches, it checks for an existing system coordinator tmux session. If none exists, it spawns one:

1. Ensure `~/.itsybitsy/` exists and is a git repository (`git init` — a standard repo, not `git init --bare`). This is required because Claude Code only loads `<cwd>/.claude/settings.local.json` when the CWD is inside a git repo. Add a `.gitignore` with `*` to prevent accidental commits of coordinator data files.
2. Write `~/.itsybitsy/.claude/settings.local.json` with system coordinator permissions (§12.1.3)
3. Write the system coordinator prompt (§12.1.5) to `~/.itsybitsy/coordinator-prompt.txt`
4. Create a tmux session named `ib-coordinator` with working directory `~/.itsybitsy/`
5. Start Claude Code inside the session in interactive mode: run `tmux send-keys -t ib-coordinator "claude --model <coordinator.model>" Enter` (via `Bun.spawn(["tmux", "send-keys", "-t", "ib-coordinator", "claude --model <model>", "Enter"])`). After a 3-second delay (for Claude to start and accept input), send the initial prompt via two separate `Bun.spawn` calls: first `Bun.spawn(["tmux", "send-keys", "-t", "ib-coordinator", "-l", promptText])`, then `Bun.spawn(["tmux", "send-keys", "-t", "ib-coordinator", "Enter"])`. All tmux interactions use `Bun.spawn` with array arguments — never shell strings. **Note**: The `-p` flag is NOT used because it runs Claude in non-interactive print mode (exits after one response). The system coordinator must run as an interactive session to accept ongoing input. **Failure mode**: If Claude takes longer than 3 seconds to start, the prompt text may be lost (treated as pre-startup input that gets discarded). The observable symptom is the coordinator showing Claude's default greeting without any coordinator context — it will not know about `ib` commands or its role. The user should press `R` to restart.

**Shared across instances**: Multiple `ib watch` instances share the same `ib-coordinator` tmux session. On startup, check if the session already exists (`tmux has-session -t ib-coordinator`). If it does, just display its output — do not create a new one. **TOCTOU note**: There is a race window between the `has-session` check and `new-session` creation. If two `ib watch` instances start simultaneously, both may see no session and attempt to create. Mitigation: `tmux new-session` fails if the session already exists — catch the error and fall through to the "session already exists" path.

**Auto-close on exit**: When `ib watch` exits (Ctrl-C), kill the coordinator tmux session **only if** no other `ib watch` instances are displaying it. Detection uses a PID-based reference file at `~/.itsybitsy/coordinator.refs`: each `ib watch` instance appends its PID on startup and removes it on exit. All reads and writes to this file use atomic operations (read → prune stale → write to temp file → rename over original) to prevent corruption from concurrent `ib watch` instances. Before killing the session, stale PIDs are pruned by checking liveness (`process.kill(pid, 0)`). When no live PIDs remain, the session is killed. This PID-based approach is crash-safe — if an `ib watch` instance crashes without cleanup, its PID will fail the liveness check on the next startup and be pruned automatically. A simple integer counter would leak references on crash. This is necessary because `ib watch` does not *attach* to the coordinator session (it polls via `capture-pane`), so `tmux list-clients` cannot detect active viewers.

**Persistence across restarts**: Killing and restarting `ib watch` preserves the tmux session if references remain. The session is long-lived — it is not killed when the last agent completes.

#### 12.1.3 Permissions

The system coordinator runs from `~/.itsybitsy/`, which is not initially a git repository — it is initialized as one during coordinator startup (§12.1.2 step 1) so that Claude Code loads `settings.local.json`. Claude Code reads `settings.local.json` from `<cwd>/.claude/settings.local.json`. Therefore, the coordinator's permissions file is written to `~/.itsybitsy/.claude/settings.local.json` before spawning:

```json
{
  "permissions": {
    "allow": ["Bash(ib:*)", "ToolSearch"],
    "deny": ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TaskOutput", "Agent", "KillShell", "EnterPlanMode", "ExitPlanMode"]
  }
}
```

**Note**: Claude Code requires a project directory context to load `settings.local.json`. Since `~/.itsybitsy/` is not initially a git repo, the coordinator startup must run `git init` there (a standard repo, not `--bare`). This matches the existing settings pattern and is simpler than passing permissions via `--allowedTools` CLI flags.

This ensures the system coordinator can only run `ib` commands (e.g., `ib list`, `ib send`, `ib merge`, `ib new-agent`, `ib kill`, `ib status`, `ib diff`) and use `ToolSearch` to discover available deferred tools. It cannot access files, browse the web, or spawn sub-agents directly.

#### 12.1.4 Display

**Agent tree**: The system coordinator appears as the **first entry** in the agent tree, before all repo headers. It uses a special icon (`◆`) and displays as:

```
◆ coordinator  running  5m
▾ itsybitsy
  ◇ itsybitsy        running  3m
  ⚙ agent-a1b2c3d4   running  2m
▾ muse-ios
  ◇ muse-ios         running  1m
  ⚙ agent-c9d0e1f2   complete  1h
```

**Layout when system coordinator is selected**: When the system coordinator is selected in the agent tree, the layout changes:

- **Sidebar** shows the normal two-section layout: agent tree (top) + info panel (bottom). The coordinator is never shown in the sidebar.
- **Main area** (middle + right panes) merge into a **single full-width view** that toggles between two modes via `n`/`p`:
  - **TMUX view** (default): Live coordinator tmux output at full width, with input field at the bottom when the coordinator panel has focus (see §13.4). Supports scrollback via `;`/`l` keys.
  - **DASHBOARD view**: A scrollable, read-only system dashboard showing a detailed agent overview table.
- **Focus cycling**: Tab cycles `agent-tree` → `info` → `coordinator` → `agent-tree`. The `coordinator` target represents the main area content (tmux pane in TMUX view). In DASHBOARD view, `;`/`l` scrolls the table regardless of focus.
- **View mode reset**: `coordinatorViewMode` resets to TMUX only when *entering* coordinator mode (transition detection via `currentAgentId`), not on every watcher tick. This ensures the user's view choice persists.

**System dashboard contents** (shown in DASHBOARD view, rendered as a scrollable table):

| Column | Width | Source |
|--------|-------|--------|
| Repo | 15 chars | Repo basename from registry |
| Agent | 20 chars | Agent ID (or "coordinator") |
| Role | 5 chars | `mgr` / `wkr` / `coord` |
| State | 12 chars | Color-coded agent state |
| Model | 8 chars | Model name from meta.json |
| Age | 6 chars | Human-readable age (e.g., `2h`, `3d`) |
| Summary | remaining | First line of summary or prompt |

Rows are grouped by repo (with repo header rows). Coordinators appear first within each repo group. The dashboard supports vertical scrolling via `;`/`l` keys (1 row per keypress, matching the tmux pane scroll increment).

**Narrow-terminal fallback**: If the available width for the system dashboard is less than 80 columns, the Summary column is hidden. If less than 60 columns, the Model and Age columns are also hidden. Column widths are fixed — no proportional scaling.

```
TMUX view (default when coordinator selected):
┌──────────────────────────────────────────────────────────────────┐
│ ib — agent dashboard                                            │
├──── Agents ──────────────────┬─── System Coordinator  TMUX ─────┤
│ ◆ coordinator  running  5m  │ coordinator tmux output           │
│ ▾ itsybitsy                  │ ...                               │
│   ◇ itsybitsy    running 3m │                                   │
│   ⚙ agent-a1b2  running 2m  │                                   │
│ ▾ muse-ios                   │                                   │
│   ◇ muse-ios     running 1m │                                   │
│   ⚙ agent-c9d0  complete 1h │                                   │
├──── Info ────────────────────│ > input field█       [Send]       │
│ System Coordinator           │                                   │
├──────────────────────────────┴───────────────────────────────────┤
│ status bar                                                       │
└──────────────────────────────────────────────────────────────────┘

DASHBOARD view (toggle with n/p):
┌──────────────────────────────────────────────────────────────────┐
│ ib — agent dashboard                                            │
├──── Agents ──────────────────┬─── System Coordinator  DASHBOARD ┤
│ ◆ coordinator  running  5m  │ REPO         AGENT          ROLE  │
│ ▾ itsybitsy                  │ itsybitsy    itsybitsy       coord │
│   ◇ itsybitsy    running 3m │ itsybitsy    agent-a1b2c3d4  wkr  │
│   ⚙ agent-a1b2  running 2m  │ muse-ios     muse-ios        coord │
│ ▾ muse-ios                   │ muse-ios     agent-c9d0e1f2  wkr  │
│   ◇ muse-ios     running 1m │                                   │
│   ⚙ agent-c9d0  complete 1h │                                   │
├──── Info ────────────────────│                                   │
│ System Coordinator           │                                   │
├──────────────────────────────┴───────────────────────────────────┤
│ status bar                                                       │
└──────────────────────────────────────────────────────────────────┘
```

When any other agent or repo header is selected, the layout reverts to the normal two-section sidebar (tree + info) with the standard split-pane main area.

The system coordinator panel uses its own `TmuxPoller` instance (separate from the agent tmux poller) to capture output from the `ib-coordinator` session at ~1s intervals.

#### 12.1.5 Session Start Context

The system coordinator does NOT use the standard session-start hook (§6.3). Instead, it receives a custom initial prompt explaining its role:

> You are the itsybitsy system coordinator. You manage agents across all registered repos using `ib` commands. You can list agents (`ib list`), send messages to agents (`ib send <agent-id> "message"`), merge (`ib merge`), kill (`ib kill`), create agents (`ib new-agent`), and check status (`ib status`, `ib diff`). You do NOT have access to Read, Write, Edit, or any file tools — only `ib` Bash commands. You coordinate work at the system level — for repo-specific coordination, delegate to per-repo coordinators. To send messages to per-repo coordinators, use `ib send @<repo-name> "message"` (e.g., `ib send @itsybitsy "review the latest PR"`). To send to a specific agent in another repo, use `ib send @<repo-name>/<agent-id> "message"`. Do NOT use `ib send @system` — that routes back to you. Periodically check `ib inbox count` for notifications from watchdogs and agents; process with `ib inbox list` / `ib inbox read` / `ib inbox ack`.

#### 12.1.6 Watchdog Behavior

The system coordinator does **not** have a standard watchdog or stop hook. It is not a regular agent — it has no agent directory, no meta.json, and no agent ID in the ib system. Instead:

- No watchdog process is spawned for the system coordinator
- No stop hook is installed — the system coordinator's state is detected purely from tmux session existence and output parsing (similar to how `compacting` and `rate_limited` are detected for regular agents)
- **State detection** (checked in order):
  1. Tmux session `ib-coordinator` does not exist → `stopped`
  2. "Compacting conversation" in last 5 lines of tmux output → `compacting`
  3. Rate limit patterns in last 15 lines of tmux output → `rate_limited`
  4. Otherwise → `running`
- The system coordinator has no `waiting` or `complete` states — it runs indefinitely. There is no meta.json to store state, so tmux is the sole source of truth.
- If the system coordinator session dies unexpectedly, the main area TMUX view shows "Session stopped — press R to restart". The `R` key (same as agent resume) triggers `restartSystemCoordinator()` when the system coordinator is selected.
- The system coordinator is expected to run indefinitely — it is never nudged to complete

### 12.2 Per-Repo Coordinators

#### 12.2.1 Purpose

Per-repo coordinators are Claude Code agents that coordinate work within a single repository. Unlike the system coordinator, they **can** read code in their repo (via Read, Glob, Grep) but cannot write code directly. They are responsible for understanding the codebase context and orchestrating worker agents that do the actual implementation.

#### 12.2.2 Identity

Per-repo coordinators are stored in `.ittybitty/agents/` like regular agents, but with distinguishing characteristics:

- **Agent ID**: The repo basename (e.g., `itsybitsy` for `/Users/adam/Developer/itsybitsy`). This is computed by `getCoordinatorAgentId(repoPath)` which returns `basename(repoPath)`. Only one coordinator per repo. The agent directory is `.ittybitty/agents/<repo-basename>/` (matching the standard `agents/<id>/` convention). Using the repo basename as the agent ID means standard agent ID resolution (§4.1) naturally routes `ib send <repo-basename>` to the per-repo coordinator — no special addressing logic needed. If a non-coordinator agent already has the repo basename as its ID (collision), a random 4-char hex suffix is appended (e.g., `itsybitsy-a3f1`). **Reserved name**: The name `coordinator` is reserved for system coordinator addressing (§12.3.1). Repos with basename `coordinator` are rejected at registration time (`ib add`, §9). As a secondary guard, `newAgent()` also rejects any agent with ID `coordinator`.
- **meta.json flag**: `"coordinator": true` — marks this agent as a coordinator
- **Tmux session naming**: Standard convention: `ittybitty-<repo-id>-<agent-id>` (where `<agent-id>` is the repo basename)
- **Branch name**: `agent/<agent-id>-<repo-id>` (includes repo-id to avoid collision across repos sharing the same git remote — each repo has a unique 8-char hex repo-id in `.ittybitty/repo-id`)

#### 12.2.3 Lifecycle

**Creation**: Per-repo coordinators are created via `ib new-agent --type coordinator`. This:

1. Uses the repo basename as the agent ID (via `getCoordinatorAgentId(repoPath)`)
2. Sets `coordinator: true` in meta.json
3. Uses coordinator-specific permissions (§12.2.4)
4. Uses coordinator-specific session start context (§12.2.6)
5. Does NOT set a `--manager` — coordinators are top-level agents
6. Coordinators work directly in the repo directory (no git worktree) — they are read-only agents that do not need branch isolation
7. Defaults to `coordinator.model` config (§12.5) when no explicit `--model` is provided — overridable with `--model <model>` on `ib new-agent --type coordinator`
8. Otherwise follows the standard agent creation flow (§1.1)

**One-per-repo constraint**: `checkCoordinatorExists(repoPath)` scans all agent directories in `.ittybitty/agents/` for any agent with `coordinator: true` in meta.json. If a coordinator already exists, `ib new-agent --type coordinator` prints `"Coordinator already exists for <repo-name>"` and exits 0 (idempotent no-op). If a non-coordinator agent already has the repo basename as its ID (collision), a random 4-char hex suffix is appended to the coordinator's ID. There is exactly one coordinator per repo, never more. Archived coordinators (in `.ittybitty/archive/`) do not block creation — "active" means a directory in `.ittybitty/agents/` (not `.ittybitty/archive/`). A stopped or paused coordinator whose directory is still in `agents/` DOES block creation — only archiving removes the block.

**No auto-spawn on watch startup**: Per-repo coordinators are NOT auto-spawned when `ib watch` launches. Only the system coordinator is auto-spawned (§12.1.2). Per-repo coordinators are created manually via one of: (a) `ib new-agent --type coordinator` from the CLI, (b) pressing `R` on a repo header in the TUI (which spawns a coordinator if none exists, or resumes a stopped one), or (c) the system coordinator running `ib new-agent --type coordinator` from within a repo directory.

**Auto-close on exit**: When `ib watch` exits, per-repo coordinators are paused (§1.5 — kill Claude process + tmux session, preserve worktree/meta.json/branch; paused coordinators show as `stopped` in state detection since their tmux session no longer exists) **only if** no other `ib watch` instance is running. This uses the same PID-based `~/.itsybitsy/coordinator.refs` file used by the system coordinator (§12.1.2) — a single shared file governs both the system coordinator kill and all per-repo coordinator pauses. When no live PIDs remain, the system coordinator session is killed and per-repo coordinators across **all registered repos** (from `~/.itsybitsy/repos.json`) are paused. If other instances remain, all coordinators are left running.

**Resume**: Paused coordinators can be resumed via `ib resume <repo-basename>` (standard §1.6 resume flow) or by pressing `R` on the repo header in the TUI. The TUI's `R` handler checks `checkCoordinatorExists()` — if a coordinator exists and is stopped/complete, it resumes it; if none exists, it spawns a new one.

**Children**: Agents spawned by a per-repo coordinator (via `ib new-agent --type worker` from within the coordinator's session) will have `manager: "<repo-basename>"` in their meta.json (where `<repo-basename>` is the coordinator's agent ID). This means `buildAgentTree()` will correctly parent them under the coordinator, and `ib nuke <repo-basename>` will recursively kill them.

**Killing/Archiving**: Per-repo coordinators follow the standard kill/archive flow (§1.4, §1.7). `ib kill <repo-basename>` kills only the coordinator itself (standard §1.4 behavior). To recursively kill a coordinator and all its children, use `ib nuke <repo-basename>` (§1.8). The `manager: "<repo-basename>"` field in children's meta.json links them to the coordinator for the nuke traversal.

**Resuming**: Standard resume flow (§1.6). Per-repo coordinators can be paused and resumed like any agent.

#### 12.2.4 Permissions

Per-repo coordinators get a restricted permission set — they can read the codebase and run `ib` commands, but cannot write code:

```json
{
  "permissions": {
    "allow": [
      "Bash(ib:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
      "Bash(git show:*)", "Bash(git ls-files:*)",
      "Bash(pwd:*)", "Bash(ls:*)",
      "Read", "Glob", "Grep", "LS",
      "TodoWrite", "AskUserQuestion", "ToolSearch"
    ],
    "deny": [
      "Write", "Edit", "MultiEdit", "NotebookEdit",
      "WebFetch", "WebSearch", "Task", "TaskCreate", "TaskOutput", "Agent", "KillShell",
      "EnterPlanMode", "ExitPlanMode"
    ]
  }
}
```

Key differences from regular agents:
- **No Write/Edit/MultiEdit** — coordinators cannot modify files
- **Unqualified `Bash` NOT denied** — Claude Code's permission resolution removes the entire Bash tool when unqualified `Bash` appears in the deny list, which prevents qualified allow patterns like `Bash(ib:*)` from working. Instead, only specific Bash patterns are in the allow list — non-matching commands require manual approval (effectively blocking them in unattended sessions).
- **No Bash(cat:*)/Bash(head:*)/Bash(tail:*)/Bash(grep:*)/Bash(git grep:*)** — shell commands like `cat`, `head`, `tail`, `grep` can write files via shell redirection (e.g., `cat > file.txt`, `grep x file > output.txt`). `git grep` is excluded because its `--open-files-in-pager` flag allows arbitrary command execution (e.g., `git grep --open-files-in-pager=malicious-cmd pattern`). Coordinators use `Read`, `Glob`, `Grep`, and `LS` for file inspection instead — these are Claude Code's built-in tools which cannot perform writes.
- **Has Read/Glob/Grep/LS** — coordinators can read the codebase for context via Claude Code's built-in tools (which cannot perform writes)
- **No Task/Agent** — coordinators spawn sub-agents only via `Bash(ib:*)`, not Claude's built-in Task/Agent tools. This ensures all agents are tracked through the ib system.

**Bash permission pattern and shell metacharacters**: Claude Code's `Bash(<command>:*)` permission patterns match based on command prefix — `Bash(ib:*)` allows any command starting with `ib`. This means a chained command like `ib list && cat secret.txt` would match `Bash(ib:*)` because the full string starts with `ib`. **Mitigation**: The existing `intercept-task` hook (§6) is extended to reject Bash tool calls from coordinator sessions that contain shell metacharacters (`;`, `&&`, `||`, `|`, `>`, `>>`, `<`, `` ` ``, `$(`, `${`, `$'`, `\n`, `\r`) anywhere in the raw command string. Newlines and carriage returns are included because they act as command separators in bash. `$'` (ANSI-C quoting) is included because `$'\x0a'` encodes a newline without using any other blocked characters — bash interprets it as a literal newline at execution time, splitting the command (e.g., `ib list $'\x0a'cat /etc/passwd`). Additionally, the hook blocks `--output` (and `--output=`) in git commands from coordinator sessions — `git diff --output=<path>`, `git log --output=<path>`, and `git show --output=<path>` can write files without shell metacharacters, bypassing the Write/Edit deny. The check is a simple substring match for `--output` in the raw command string when the command starts with `git`. The hook inspects the `command` field from the Bash tool's input JSON — this is the unquoted, uninterpreted command string that Claude generated. The check is a simple regex scan for metacharacters; it does not attempt to parse shell quoting (a false positive on `ib send agent "hello; world"` is acceptable — the coordinator can use `ib inbox write` instead). This is a defense-in-depth layer on top of Claude Code's prefix matching — the primary trust boundary is that coordinators are Claude agents following instructions, and the hooks catch edge cases where the agent might attempt to circumvent its role. **Security gate**: This intercept-task extension MUST be implemented and deployed before any **per-repo** coordinator goes live — without it, the `Bash(ib:*)` permission has a known bypass via shell metacharacters. The system coordinator is exempt from this gate: it has no meta.json (so the intercept-task hook cannot detect it), but it also has no Read/Write/Glob/Grep/LS tools and runs in `~/.itsybitsy/` (not a code repository), so a metacharacter bypass can only access `ib` commands and the limited filesystem at `~/.itsybitsy/`. This is an acceptable risk — the system coordinator's deny list prevents meaningful file access.
- **No WebFetch/WebSearch** — coordinators don't need internet access
- **No KillShell** — coordinators don't run long-lived shell processes

These permissions are constructed by a new `buildCoordinatorSettings()` function (parallel to the existing `buildAgentSettings()`). Per-repo coordinator permissions are also configurable via config. **Merge semantics**: Config `allow` entries are appended to the hardcoded allow list. Config `deny` entries are appended to the hardcoded deny list. The hardcoded deny list always takes precedence — `buildCoordinatorSettings()` enforces this at construction time by filtering out any user-configured `allow` entries that appear in the hardcoded `deny` list before building the final permissions object. Adding `"Write"` to `permissions.coordinator.allow` is silently dropped because `Write` is in the hardcoded deny list. This prevents users from accidentally granting write access to coordinators via config:

```json
{
  "permissions": {
    "coordinator": {
      "allow": [],
      "deny": []
    }
  }
}
```

#### 12.2.5 Display

Per-repo coordinators appear in the agent tree as the **first entry** under their repo header, with a special icon to distinguish them from regular agents:

```
◆ coordinator       running  5m       (system coordinator)
▾ itsybitsy
  ◇ itsybitsy        running  3m       (per-repo coordinator, agent ID = repo basename)
  ⚙ agent-a1b2c3d4   running  2m
  ⚙ agent-e5f6a7b8   waiting  10m
▾ muse-ios
  ◇ muse-ios         stopped   1h      (per-repo coordinator)
  ⚙ agent-c9d0e1f2   complete  1h
```

When a per-repo coordinator is selected in the agent tree, it behaves like any other agent — its tmux output shows in the middle pane, and the right pane shows the selected mode (log, prompt, etc.). Per-repo coordinators do NOT get the full-width view that the system coordinator gets.

#### 12.2.6 Session Start Context

Per-repo coordinators use a custom session-start context (injected via the session-start hook, which detects the `coordinator: true` flag in meta.json). The `generateCoordinatorInstructions()` function produces a full `<ittybitty>` block including:

- Role identification and purpose (read code, coordinate workers, don't write code directly)
- Bash rules (single-command enforcement)
- Path isolation (worktree boundaries)
- Git worktree context (branch name, parent branch)
- Command table (`ib new-agent --type worker`, `ib list --manager`, `ib look`, `ib send`, `ib send @system "msg"`, `ib send @coordinator "msg"`, `ib status`, `ib diff`, `ib merge`, `ib kill`)
- State management (`WAITING` / `I HAVE COMPLETED THE GOAL`)
- Workflow steps (understand codebase → break down tasks → spawn workers → monitor → merge → coordinate)
- Agent state reference table

The coordinator is told to send messages to the system coordinator via `ib send @system "message"`. Workers can reach their repo's coordinator via `ib send @coordinator "message"`, or reach the coordinator directly via `ib send <repo-basename> "message"` (standard agent ID resolution).

**Worker session-start context under coordinators**: When the session-start hook detects a worker agent whose `manager` field is a coordinator's agent ID (the repo basename), it injects both `ib send @coordinator "message"` (to reach the repo coordinator) and `ib send <manager-id> "message"` (for direct manager communication, where `<manager-id>` is the agent's `manager` field from meta.json). Workers can also reach the system coordinator via `ib send @system "message"`.

#### 12.2.7 Watchdog Behavior

Per-repo coordinators currently use the **standard watchdog behavior** — no coordinator-specific modifications are implemented. A watchdog process IS spawned (standard agent lifecycle), and it treats coordinators identically to any other agent.

**Not yet implemented** (future enhancements):
- The watchdog does not yet skip completion nudge for coordinators. Coordinators are expected to run indefinitely while they have active sub-agents, so the watchdog should not nudge them to complete.
- The watchdog does not yet notify the system coordinator when a per-repo coordinator enters `waiting` state with no active children.
- The watchdog does not yet send a completion notification to the system coordinator when a per-repo coordinator enters `complete` state.

### 12.3 Addressing Coordinators

#### 12.3.1 CLI Addressing

The `ib send` command uses a hybrid addressing scheme: `@`-prefixed targets for coordinator routing, and bare agent IDs for direct agent messaging. The `@` character is shell-safe (no quoting needed in bash).

**@-based targets** (checked before agent ID resolution):

| Syntax | Description | Resolution |
|--------|-------------|------------|
| `ib send @system "msg"` | System coordinator | Routes to system coordinator via `ib inbox write` (§12.3.4). Works even when the coordinator's tmux session is not running — messages are queued. The `--from` flag value is passed as the inbox source. Output: `"Sent to system coordinator"` on success. |
| `ib send @coordinator "msg"` | Own repo's coordinator | Detects the current repo from CWD (agent worktree or registered repo root), finds the coordinator agent for that repo (the agent with `coordinator: true` in meta.json), and sends via `tmux send-keys`. Error if CWD is not in a registered repo or agent worktree. Error if no coordinator exists for the detected repo. |
| `ib send @muse-ios "msg"` | Named repo's coordinator | Looks up the repo by name in the repo registry (`repos.json`), finds the coordinator agent for that repo, and sends via `tmux send-keys`. Error if no repo with that name is registered. Error if no coordinator exists for the named repo. |
| `ib send @muse-ios/agent-a1b2 "msg"` | Agent in named repo | Looks up the repo by name, then resolves the agent ID within that repo only (exact match, then prefix match). Error if repo not found, agent not found, or ambiguous prefix match. |

**Bare agent ID targets** (standard agent ID resolution):

| Syntax | Description | Resolution |
|--------|-------------|------------|
| `ib send agent-a1b2 "msg"` | Same-repo or global agent | Resolution order below |

Resolution rules for bare agent IDs (no `@` prefix):

1. **Own-repo exact match**: If CWD is in a registered repo or agent worktree, search that repo's agents for an exact ID match
2. **Own-repo prefix match**: Search the same repo for a unique prefix match
3. **Global exact match**: Search all repos for an exact ID match
4. **Global prefix match**: Search all repos for a unique prefix match
5. **Error**: If no match found, or if prefix match is ambiguous (matches agents in multiple repos), print an error with the ambiguous matches

Other commands (`ib kill`, `ib nuke`, `ib status`, `ib diff`, `ib merge`, etc.) continue to use standard agent ID resolution (bare IDs only) — `@`-based addressing is specific to `ib send`:

| Command | Resolution | Notes |
|---------|-----------|-------|
| `ib kill itsybitsy` | Standard: exact match on agent ID | Kills per-repo coordinator |
| `ib nuke itsybitsy` | Standard: exact match on agent ID | Kills coordinator + children (§1.8) |
| `ib status itsybitsy` | Standard: exact match on agent ID | Shows coordinator's commits |

The system coordinator has no agent ID and cannot be targeted by any standard CLI command (only via `@system` in `ib send`). It is not a regular agent — it has no agent directory, no meta.json, and no entry in any repo's `.ittybitty/agents/`. To send messages to the system coordinator programmatically, use `ib send @system` or `ib inbox write` directly (§12.3.4).

**Reserved name `coordinator`**: The name `coordinator` is reserved and cannot be used as an agent ID. `newAgent()` rejects any attempt to create an agent with the ID `coordinator` — whether via `--name coordinator`, or because a repo's basename happens to be `coordinator` (in coordinator mode). This prevents confusion: if someone types `ib send coordinator` (without the `@`), they get "Agent not found" rather than silently messaging the wrong target. The old `ib send coordinator` special routing is removed — use `ib send @system` instead.

**Prefix matching caveat**: If a repo is named `agent` and there's also an `agent-a1b2c3d4`, `ib send agent "msg"` is an exact match on the coordinator's ID (exact matches take priority over prefix). But `ib kill agent` also exact-matches the coordinator — there's no separate resolution for management commands vs messaging commands.

#### 12.3.2 TUI Addressing

- **System coordinator**: Select in agent tree → `s` key to send message, or focus coordinator sidebar panel → type in input field
- **Per-repo coordinator**: Select in agent tree → `s` key to send message (same as any agent)
- Both use the standard TUI input flow — no name resolution needed since selection is explicit

#### 12.3.3 System Coordinator Messaging

The system coordinator has two messaging paths, each for a different context:

**User-interactive (TUI)**: When the user types in the coordinator sidebar input field or uses `s` with the system coordinator selected, `tmux send-keys -t ib-coordinator -l "<message>"` followed by a separate `tmux send-keys -t ib-coordinator Enter` is used. The `-l` (literal) flag prevents tmux from interpreting special key sequences in the message text. **Control character sanitization**: Before sending, all non-printable characters must be stripped: newlines (`\n`, `\r`) to prevent injecting multiple inputs, `\x03` (Ctrl-C) to prevent killing the Claude process, `\x04` (Ctrl-D, EOF), `\x1a` (Ctrl-Z, suspend), and `\x1b` (Escape, which could corrupt terminal state or trigger escape sequences). In practice, strip all characters with code points below `0x20` (this includes tab `0x09`, which is intentionally stripped to prevent unexpected whitespace in messages) and also `0x7F` (DEL). The `-l` flag on `tmux send-keys` prevents tmux from interpreting special key names, but the receiving Claude process would still see control characters in its stdin. This is safe because the user controls timing and can see whether the coordinator is busy.

**Programmatic (watchdog, automated notifications, agents)**: When the watchdog, automated systems, or agents need to notify the system coordinator, they use `ib send @system "message"` (which routes to `ib inbox write`, see §12.3.4). This avoids the race condition of injecting text via `tmux send-keys` while the coordinator is mid-response.

#### 12.3.4 `ib inbox` Command

The system coordinator cannot read files directly (it has only `Bash(ib:*)` permissions). To receive programmatic messages safely, a new `ib inbox` CLI command provides access to a file-based message queue:

**Inbox directory**: `~/.itsybitsy/coordinator-inbox/`. Created automatically on first `ib inbox write`. Message files use the naming pattern `<epoch_ms>-<random4hex>-<source>.msg`.

**Filename format**: `<epoch_ms>-<random4hex>-<source>.msg` — Unix epoch in milliseconds plus 4 random hex characters (e.g., `1704825000123-a3f1-watchdog.msg`). The random suffix prevents collisions when multiple messages arrive in the same millisecond from the same source.

**Source field**: The `<source>` portion of the filename identifies the sender. Values: the calling agent ID (e.g., `agent-a1b2c3d4`), `"watchdog"`, or `"manual"` (for `ib inbox write` called directly by the user or scripts). Source is validated against `/^[\w-]+$/` to prevent path traversal.

**Subcommands**:

##### `ib inbox write "message text"`

Writes a message file to the inbox directory.

- **Source detection** (in priority order): (1) `--source <name>` flag if provided, (2) auto-detected agent ID if called from within an agent worktree, (3) `"manual"` as default. The `--source` flag takes highest priority so that the watchdog can override CWD-based detection (see §12.2.7).
- **Output**: Prints the filename to stdout (e.g., `1704825000123-a3f1-watchdog.msg`)
- **Exit code**: 0 on success, 1 on write failure
- **Retention limit**: After writing the new message, if the inbox exceeds 100 messages, the oldest messages are deleted until exactly 100 remain. This prevents unbounded growth.

##### `ib inbox list`

Lists pending messages, newest first.

- **Output format** (one line per message, tab-separated):
  ```
  <filename>\t<source>\t<first-80-chars-of-message>
  ```
  Example: `1704825000123-a3f1-watchdog.msg\twatchdog\t[coordinator] Agent agent-a1 entered waiting...`
- **Empty inbox**: Prints nothing (empty output), exit code 0
- **Exit code**: 0 on success, 1 on read failure

##### `ib inbox read <filename>`

Reads the full content of a specific message.

- **Filename validation**: Must match `/^\d+-[0-9a-f]{4}-[\w-]+\.msg$/`. Rejects filenames containing `/`, `..`, or other path traversal characters. Returns exit code 1 with error: `"Invalid filename: <name>"`
- **Output**: Full message text to stdout
- **Missing file**: Exit code 1, error: `"Message not found: <filename>"`
- **Exit code**: 0 on success, 1 on error

##### `ib inbox ack <filename>`

Acknowledges (deletes) a processed message.

- **Filename validation**: Same as `read` — must match `/^\d+-[0-9a-f]{4}-[\w-]+\.msg$/`
- **Output**: `"Acknowledged: <filename>"`
- **Missing file**: Exit code 0 (idempotent — already acknowledged)
- **Exit code**: 0 on success, 1 on validation error

##### `ib inbox count`

Returns the number of pending messages.

- **Output**: A single integer to stdout (e.g., `3`). Outputs `0` for an empty inbox.
- **Exit code**: Always 0

**Usage by system coordinator**: The session-start prompt instructs the coordinator to periodically run `ib inbox count` and process messages with `ib inbox list` / `ib inbox read` / `ib inbox ack`. This keeps the system coordinator's permissions minimal (`Bash(ib:*)` covers `ib inbox *`) while giving it access to programmatic notifications.

### 12.4 Coordinator Relationship to Regular Agents

#### 12.4.1 Hierarchy

```
User
 └── System Coordinator (ib-coordinator, ~/.itsybitsy/)
      ├── Per-Repo Coordinator (agent ID: itsybitsy, .ittybitty/agents/itsybitsy/)
      │    ├── agent-a1b2c3d4 (worker, manager: "itsybitsy")
      │    └── agent-e5f6a7b8 (manager, manager: "itsybitsy")
      │         └── agent-f9a0b1c2 (worker, manager: "agent-e5f6a7b8")
      └── Per-Repo Coordinator (agent ID: muse-ios, .ittybitty/agents/muse-ios/)
           └── agent-d3e4f5a6 (worker, manager: "muse-ios")
```

The system coordinator can spawn per-repo coordinators and can send messages to any agent. Per-repo coordinators can spawn agents within their repo and manage their children. Regular agents follow the existing manager/worker hierarchy.

#### 12.4.2 Agent Tree Integration

The agent tree (§11) shows coordinators integrated with the agent hierarchy:

1. **System coordinator**: Always first entry, before all repo headers. Uses `◆` icon.
2. **Per-repo coordinators**: First entry under their repo header. Uses `◇` icon. Sorted before regular agents regardless of creation time.
3. **Regular agents**: Listed below coordinators in their repo section, sorted by creation time (existing behavior).

The `FlatEntry` union type gains a new variant for the system coordinator:

```typescript
export type FlatEntry =
  | { kind: "system-coordinator" }
  | { kind: "agent"; agent: Agent; depth: number; connector: string }
  | { kind: "repo-header"; repoName: string; repoPath: string; hasAgents: boolean };
```

#### 12.4.3 maxAgents

Per-repo coordinators bypass the `maxAgents` check during creation (`ib new-agent --type coordinator` or TUI `R` key) — coordinators are infrastructure, not user tasks. They DO occupy agent directories in `.ittybitty/agents/` and appear in `ib list` output, but they are **excluded from the agent count** when checking `maxAgents` for regular agent creation. Example: if `maxAgents=10` and there are 3 coordinators, you can still create 10 regular agents (not 7). The system coordinator does NOT count — it is not a regular agent and lives outside any repo.

### 12.5 Coordinator-Specific Config

New config keys in `~/.itsybitsy/config.json`:

```json
{
  "coordinator": {
    "model": "opus"
  },
  "permissions": {
    "coordinator": {
      "allow": [],
      "deny": []
    }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `coordinator.model` | string | `"opus"` | Model for both system and per-repo coordinators. A single key is used because both tiers perform the same kind of work (orchestration via `ib` commands). If different models are needed, per-repo coordinators can be spawned with `--model <model>` to override. Changing the system coordinator's model requires restarting it (`R` key in TUI when selected, or kill + re-launch `ib watch`) — the config is read at spawn time. |
| `permissions.coordinator.allow` | string[] | `[]` | Additional permissions for per-repo coordinators |
| `permissions.coordinator.deny` | string[] | `[]` | Additional deny rules for per-repo coordinators |

### 12.6 Affected Files and Modules

The coordinator system touches many modules. This section catalogs the current implementation state.

| Module | Status | Description |
|--------|--------|-------------|
| `src/coordinator.ts` | **Implemented** | System coordinator lifecycle (`ensureSystemCoordinator()`, `releaseSystemCoordinator()`, `restartSystemCoordinator()`), PID-based reference counting, system coordinator permissions/prompt, `sanitizeTmuxInput()`, per-repo coordinator permissions (`buildPerRepoCoordinatorSettings()`), per-repo coordinator prompt (`perRepoCoordinatorPrompt()`), coordinator existence check (`checkCoordinatorExists()`), agent ID generation (`getCoordinatorAgentId()` — returns repo basename). No separate `coordinator-settings.ts` — per-repo settings are in this file. |
| `src/inbox.ts` | **Implemented** | `ib inbox` command implementation (write/list/read/ack/count). File-based message queue at `~/.itsybitsy/coordinator-inbox/`. |
| `src/agents.ts` | **Implemented** | `coordinator?: boolean` in `AgentMeta`. `{ kind: "system-coordinator" }` in `FlatEntry`. `flattenAgentTree()` prepends system coordinator entry. Per-repo coordinators sorted before regular agents within each repo section. |
| `src/ib-commands.ts` | **Implemented** | `newAgent()` extended with `--type coordinator`: uses repo basename as ID (via `getCoordinatorAgentId()`), sets `coordinator: true` in meta.json, one-per-repo validation via `checkCoordinatorExists()`, `coordinator.model` default, max-agents bypass, coordinator-specific `settings.local.json` with hooks. No special `ib send` routing — standard agent ID resolution handles everything. |
| `src/hooks/session-start.ts` | **Implemented** | Detects `coordinator: true` in meta.json. `generateCoordinatorInstructions()` injects coordinator-specific prompt. Worker instructions correctly use manager's agent ID (repo basename) for `ib send`. |
| `src/hooks/intercept-task.ts` | **Implemented** | `checkCoordinatorBashRestrictions()` blocks shell metacharacters and `--output` in git commands for coordinator sessions. Detects coordinators via `coordinator: true` in meta.json. |
| `src/hooks/agent-path.ts` | **No changes needed** | Per-repo coordinators use standard path isolation. |
| `src/hooks/agent-status.ts` | **No changes needed** | Stop hook writes state normally. |
| `src/config.ts` | **Implemented** | Config keys: `coordinator.model`, `permissions.coordinator.allow`, `permissions.coordinator.deny`. |
| `src/watchdog.ts` | **Not yet modified** | Does NOT have coordinator-specific behavior. Treats coordinators identically to regular agents. See §12.2.7. |
| `src/tui/dashboard.ts` | **Implemented** | System coordinator full-width view with TMUX/DASHBOARD toggle, coordinator lifecycle on startup/shutdown, coordinator restart on `R`, input field routing, per-repo coordinator pausing on exit. |
| `src/tui/agent-tree.ts` | **Implemented** | System coordinator as first entry with `◆` icon. Per-repo coordinators with `◇` icon, sorted before regular agents. |
| `src/tui/agent-actions.ts` | **Implemented** | `R` on repo header spawns or resumes per-repo coordinator via `checkCoordinatorExists()`. |
| `src/tui/focus.ts` | **Implemented** | Coordinator focus order: `agent-tree` → `info` → `coordinator`. |
| `src/tui/pane-manager.ts` | **Implemented** | Full-width view when system coordinator is selected. Per-repo coordinator REPO mode with split pane. |
| `src/watcher.ts` | **No changes needed** | Per-repo coordinators are regular agents detected by fs.watch. System coordinator state polled via `getCoordinatorInfo()`. |
| `src/index.ts` | **Implemented** | `ib new-agent --type coordinator` flag handling. `ib inbox` subcommand routing. `@`-based routing in `ib send`: `@system` routes to system coordinator inbox, `@coordinator` routes to own repo's coordinator, `@<repo-name>` routes to named repo's coordinator, `@<repo-name>/<agent-id>` routes to specific agent in named repo (§12.3.1). Bare agent IDs use standard `matchAgentById()` with own-repo-first resolution. |
| `src/auto-compact.ts` | **No changes needed** | Per-repo coordinators get auto-compact as regular agents. System coordinator has no watchdog/auto-compact. |

---

## 13. Focus System

### 13.1 Focus Targets

The TUI has five focusable panels:

| Target | Location | Behavior when focused |
|--------|----------|----------------------|
| `agent-tree` | Sidebar top | `j`/`k` navigate agents, action keys active |
| `info` | Sidebar middle | Read-only info panel; `[`/`]` resize sidebar, `{`/`}` resize height |
| `coordinator` | Sidebar bottom | Input field visible; uses three-level sub-focus (pane → input → send). Dashboard shortcuts work in pane/send sub-focus. |
| `active-agent` | Main area (tmux pane) | Input field visible; uses three-level sub-focus (pane → input → send). Dashboard shortcuts work in pane/send sub-focus. |
| `right-pane` | Main area (right side) | `[`/`]` resize right pane width |

### 13.2 Focus Cycling

- **Tab**: Cycle focus forward through the focus targets in order: `agent-tree` → `info` → `active-agent` → `right-pane` → `agent-tree` → ... (normal mode). In coordinator mode: `agent-tree` → `info` → `coordinator` → `agent-tree` → ...
- **Shift+Tab**: Cycle focus backward.

Tab replaces the previous tree/questions toggle behavior. When in QUESTIONS pane mode, Tab now cycles focus rather than toggling between the tree and the questions list.

### 13.3 Focus Indicators

Each panel shows a visual indicator of its focus state:

- **Focused panel**: Section header/separator title text rendered in **reverse video + bold**; dashes remain dim gray
- **Unfocused panels**: Section header/separator is dim
- **Main area separator**: Left title (agent ID) highlights when `active-agent` is focused; right title (pane mode) highlights when `right-pane` is focused. Dashes are never in reverse video.

### 13.3.1 Panel Resizing

When a panel has focus, `[` and `]` decrease/increase its **width**, and `Shift+[` (`{`) and `Shift+]` (`}`) decrease/increase its **height**.

**Width resizing (`[` / `]`):**

| Focused panel | Steals from |
|---------------|-------------|
| Sidebar (any sidebar panel focused) | Main area shrinks (split pane position is fixed, so the right pane absorbs the change) |
| Agent pane (middle) | Right pane only |
| Right pane | Agent pane only |

Width changes apply in increments (e.g., 5 columns per keypress). Sidebar width is bounded between 30 and 120 columns.

**Height resizing (`{` / `}`):**

Only meaningful for sidebar panels (agent tree, info). Growing one sidebar panel shrinks the other. `{`/`}` when `agent-tree` is focused grows/shrinks the tree by stealing from/giving to info. `{`/`}` when `info` is focused grows/shrinks info by stealing from/giving to tree.

### 13.4 Input Field

When the `coordinator` or `active-agent` panel has focus, an input field appears at the bottom of that panel's tmux output area:

```
│ ...tmux output...       │
│─────────────────────────│
│ > user input here█      │
│─────────────────────────│
```

#### Sub-Focus States

Panels with input fields (`active-agent`, `coordinator`) use a three-level sub-focus system. When Tab moves focus to one of these panels, it enters **pane** sub-focus first — the input field is visible but inactive (no cursor), and all dashboard shortcuts work normally.

| Sub-focus | Input field state | Keyboard routing | Tab action | Shift-Tab action |
|-----------|-------------------|------------------|------------|------------------|
| **pane** | Visible, cursor hidden (`active=false`) | Dashboard shortcuts work normally (`[`/`]` resize, `j`/`k` navigate, action keys) | → **input** | → previous panel |
| **input** | Active, cursor shown (`█`) | All input captured by text field (typing, backspace, Ctrl-A/E/U) | → **send** | → **pane** |
| **send** | Active, `[Send]` highlighted | Enter submits; Escape → **pane**; all other keys fall through to dashboard | → next panel | → **input** |

- **Escape** in **input** sub-focus: clears the input field and returns to **pane** sub-focus (stays on the same panel, does NOT jump to `agent-tree`).
- **Escape** in **send** sub-focus: returns to **pane** sub-focus without clearing input.
- **Enter** in **send** sub-focus: submits the input text. For agents, uses `ib send <agent-id> "<message>"`. For the system coordinator, uses `tmux send-keys -t ib-coordinator -l "<message>"` followed by a separate `tmux send-keys -t ib-coordinator Enter`.
- Supports basic line editing in **input** sub-focus: backspace, Ctrl-A (home), Ctrl-E (end), Ctrl-U (clear line)

The input field takes 3 lines of vertical space: top separator, input line, bottom separator. These lines are subtracted from the tmux output display height.

### 13.5 Keyboard Routing

When a panel with an input field has focus, routing depends on the sub-focus state:

**pane sub-focus** (default when panel receives focus):
- All dashboard keybindings work normally (`[`/`]` resize, `j`/`k` navigate, `p`/`n` cycle pane modes, action keys)
- Tab enters **input** sub-focus; Shift+Tab moves to the previous panel

**input sub-focus**:
- Printable characters, backspace, and line-editing keys go to the input field
- Tab moves to **send** sub-focus; Shift+Tab returns to **pane** sub-focus
- Escape clears input and returns to **pane** sub-focus
- All other dashboard keybindings are **suppressed** — they do not pass through

**send sub-focus**:
- Enter submits the input text
- Escape returns to **pane** sub-focus
- Tab cycles to the next panel; Shift+Tab returns to **input** sub-focus
- All other keys (including `[`/`]` for resize) **fall through** to normal dashboard handling

When `agent-tree` has focus:
- All existing keybindings work as before (j/k navigation, p/n pane cycling, action keys, dialog triggers)
- This is the default focus state on startup

### 13.6 Default Focus

On startup, focus is set to `agent-tree`. This ensures all existing keybindings work immediately without any behavioral change for users who don't use Tab.

### 13.7 Layout Persistence

Panel sizes are persisted across `ib watch` sessions via `~/.itsybitsy/layout.json`. The file stores:

```json
{
  "sidebarWidth": 60,
  "splitPaneLeftWidth": 80,
  "heightOffsets": { "tree": 0, "info": 0, "coordinator": 0 }  // coordinator kept for backward compat, unused
}
```

- **Save**: Debounced (500ms) write after any resize operation. The debounce prevents excessive disk writes during rapid resizing.
- **Restore**: On startup, the saved layout is loaded and applied with validation: NaN and Infinity values are rejected, and all values are clamped to valid ranges (sidebar width [30, 120], etc.).
- **Missing file**: If `layout.json` doesn't exist or is invalid, defaults are used (sidebar 60 cols, default split-pane position, zero height offsets).

### 13.8 Tmux Width Model

Each tmux session type uses a separately-tracked width. The three widths have well-defined dependency relationships:

| Component | Width formula | Persisted in | Used when |
|-----------|--------------|--------------|-----------|
| **Agent tmux** (middle pane) | `splitPaneLeftWidth` | `layout.json` → `splitPaneLeftWidth` | Creating new agents, resuming agents, selecting an agent, `[`/`]` with active-agent focus, layout restore |
| **System coordinator tmux** | `mainWidth` = `terminal_cols - sidebarWidth - 1` | Computed dynamically (not persisted directly) | Creating coordinator session, `[`/`]` with sidebar or coordinator focus, terminal resize (SIGWINCH), layout restore |
| **Per-repo coordinator tmux** | `rightPaneWidth` = `mainWidth - splitPaneLeftWidth - 1` | Computed dynamically | Selecting a repo header, `[`/`]` with sidebar/coordinator focus (via `sidebarWidth` change) or active-agent/right-pane focus (via `splitPaneLeftWidth` change) |

**Key invariant**: `splitPaneLeftWidth` and `sidebarWidth` are the two independent inputs; `mainWidth` and `rightPaneWidth` are derived. A sidebar resize changes `sidebarWidth`, which changes `mainWidth` (affecting the system coordinator and per-repo coordinator) but does not change `splitPaneLeftWidth` (agents). A split-pane resize changes `splitPaneLeftWidth` (agents) and `rightPaneWidth` (per-repo coordinator) but does not change `mainWidth` (system coordinator).

**Tmux width feedback**: The tmux poller reports the polled session's window width back to the dashboard via `onWidth`. This feedback is used to sync `splitPaneLeftWidth` when an external client (e.g., Ghostty) resizes an agent's tmux session. However, the main tmux poller is repointed to the system coordinator's tmux session when the coordinator is selected (to show coordinator output in the middle pane). Since the coordinator runs at `mainWidth` (much wider than `splitPaneLeftWidth`), the `onWidth` callback must be suppressed when the system coordinator is selected — otherwise the coordinator's width would overwrite `splitPaneLeftWidth` and corrupt all agent widths.

**New agent width**: When spawning a new agent (`ib new-agent`) or resuming an agent (`ib resume`), the tmux session is created/resized to `getSavedTmuxWidth()`, which reads `splitPaneLeftWidth` from `layout.json`. This ensures new agents match the dashboard's current split-pane width even when launched outside the TUI.

---

## 14. Repo Configuration Health Check

### 14.1 Purpose

itsybitsy manages complex configuration across multiple locations: global hooks in `~/.claude/settings.json`, per-repo base settings in `<repo>/.claude/settings.local.json`, per-agent settings in agent worktrees, and `meta.json` files for each agent. Configuration can become inconsistent through crashes, partial cleanup, or bugs in the kill/merge/nuke lifecycle. The health check detects these inconsistencies and surfaces them in the TUI so the user can fix them before they cause hard-to-diagnose failures.

**Motivating example**: An agent's `hook-check-path` hook was left in a repo's `.claude/settings.local.json` after the agent was killed. This caused the hook to fire in the user's direct Claude session, blocking all tool calls because the agent ID referenced a non-existent agent. The health check catches this class of issue proactively.

### 14.2 When Health Checks Run

Health checks run automatically at two points:

1. **Dashboard startup**: When `ib watch` launches, all registered repos are checked before the first render.
2. **Add-repo**: When a repo is added (via `ib add` or the `a` keybinding folder browser), the new repo is checked immediately.
3. **On-demand**: The user can manually re-run health checks via a keybinding in the TUI (see §14.6).

Health checks are non-blocking — the dashboard renders immediately and health check results are populated asynchronously. A repo shows no warning indicator until its check completes.

### 14.3 Health Check Categories

Each check produces zero or more **warnings**. Warnings have a severity level and a human-readable message.

| Severity | Display | Meaning |
|----------|---------|---------|
| `error` | `🔴` | Broken configuration that will cause agent failures or block the user |
| `warning` | `⚠️` | Suspicious state that may indicate a problem |
| `info` | `ℹ️` | Non-critical observation |

#### 14.3.1 Leaked Agent Hooks in Repo Settings (error)

**What**: The repo's `.claude/settings.local.json` contains hooks that reference a specific agent ID (e.g., `ib hook-check-path agent-a1b2c3d4` or `ib hook-status agent-a1b2c3d4`).

**Why it's a problem**: Agent-specific hooks should only exist inside an agent's worktree at `<agent-dir>/repo/.claude/settings.local.json`. If they appear in the repo root's settings, they fire for the user's direct Claude session, where the referenced agent may not exist — causing hook failures that block tool calls.

**Detection**: Parse `<repo>/.claude/settings.local.json`. Scan all hook commands (across all hook types: `PreToolUse`, `Stop`, `PermissionRequest`, `SessionStart`) for patterns matching `ib hook-check-path <id>`, `ib hook-status <id>`, or `ib hook-permission-denied <id>` where `<id>` matches the agent ID format (`agent-[0-9a-f]+` or any string matching `isValidAgentId()`). The `ib hooks intercept-task` and `ib hooks session-start` commands (without agent IDs) are legitimate global/repo hooks and should NOT be flagged.

**Message**: `"Leaked agent hook in .claude/settings.local.json: <command> — this will block tool calls in your Claude session. Remove the hook entry or restore settings from version control."`

#### 14.3.2 Missing Global Hooks (warning)

**What**: The global `~/.claude/settings.json` is missing expected itsybitsy hooks (safety hooks or intercept-task hook).

**Why it's a problem**: Without global safety hooks, agents can access each other's worktrees or the main repo, and task interception won't redirect Task/Agent tool calls to `ib new-agent`.

**Detection**: Read `~/.claude/settings.json` and check for the presence of:
- **Safety hooks** (checked as a group): `ib hooks main-path` (PreToolUse), `ib hooks session-start` (SessionStart), and at least one `ib hooks inject-status` hook (UserPromptSubmit or PostToolUse). If ANY of these are missing, warn.
- **Intercept-task hook**: `ib hooks intercept-task` in PreToolUse with `Task|Agent|TaskCreate` matcher. Checked separately since it's an optional but recommended hook.

**Message**: `"Missing global safety hooks in ~/.claude/settings.json — run setup (h) to install"` or `"Missing intercept-task hook in ~/.claude/settings.json — run setup (h) to install"`

#### 14.3.3 Orphaned Agent Directories (warning)

**What**: An agent directory exists in `.ittybitty/agents/<id>/` but has no corresponding tmux session AND no valid `meta.json`, or has a `meta.json` that references a tmux session that doesn't exist and the agent is older than 30 seconds (past the creating grace period).

**Why it's a problem**: Orphaned directories consume the `maxAgents` count and clutter the agent tree. They may indicate a failed kill/nuke that left artifacts behind.

**Detection**: For each agent directory in `.ittybitty/agents/`:
1. Check if `meta.json` exists and is valid JSON with required fields (`id`, `tmux_session`)
2. If `meta.json` is missing or malformed → orphaned (error severity)
3. If `meta.json` is valid but the tmux session doesn't exist and `created_epoch` is older than 30s → check if the agent has a worktree (`<agent-dir>/repo` exists). If no worktree, it's a stale directory (warning). If the worktree exists, it's a stopped agent — not flagged (normal state).

**Message**: `"Orphaned agent directory: <id> — no valid meta.json"` or `"Agent <id> has no tmux session and no worktree — stale directory"`

#### 14.3.4 Malformed meta.json (error)

**What**: An agent's `meta.json` exists but contains invalid JSON or is missing required fields.

**Why it's a problem**: Most itsybitsy operations depend on reading `meta.json`. A malformed file will cause crashes or silent failures in the watcher, hooks, and commands.

**Detection**: For each agent directory, attempt to parse `meta.json` and validate:
- Valid JSON
- Has `id` (string)
- Has `tmux_session` (string)
- Has `created_epoch` (number)
- `id` matches the directory name

**Message**: `"Malformed meta.json for agent <id>: <specific issue>"`

#### 14.3.5 Orphaned Git Worktrees (warning)

**What**: Git worktrees exist for agent branches (`agent/<id>`) that no longer have a corresponding agent directory in `.ittybitty/agents/`.

**Why it's a problem**: Orphaned worktrees consume disk space and may cause branch conflicts when creating new agents.

**Detection**: Run `git worktree list --porcelain` in the repo root. For each worktree whose branch matches `agent/<id>`, check if `.ittybitty/agents/<id>/` exists. If the directory is gone, the worktree is orphaned.

**Message**: `"Orphaned git worktree for agent/<id> — no agent directory exists. Clean up with: git worktree remove <path>"`

#### 14.3.6 Orphaned Git Branches (info)

**What**: Local git branches matching `agent/<id>` exist but have no corresponding agent directory or worktree.

**Why it's a problem**: Low severity — branches are cheap, but many orphaned branches clutter `git branch` output and may indicate incomplete cleanup.

**Detection**: Run `git branch --list 'agent/*'` in the repo root. For each branch `agent/<id>`, check if `.ittybitty/agents/<id>/` exists OR if a worktree is checked out on that branch. If neither, the branch is orphaned.

**Message**: `"Orphaned git branch: agent/<id> — no agent or worktree exists"`

#### 14.3.7 Stale Agent References in meta.json (warning)

**What**: An agent's `meta.json` has a `manager` field pointing to an agent ID that no longer exists (directory removed, not just stopped).

**Why it's a problem**: The stop hook and watchdog attempt to notify the manager agent. If the manager doesn't exist, notifications silently fail. More importantly, the agent tree will show broken parent-child relationships.

**Detection**: For each agent, if `meta.json.manager` is set, check if `.ittybitty/agents/<manager-id>/` exists.

**Message**: `"Agent <id> references non-existent manager <manager-id>"`

#### 14.3.8 Agent Hook Referencing Wrong Agent (warning)

**What**: An agent's worktree `settings.local.json` contains hooks that reference a different agent's ID.

**Why it's a problem**: Hooks like `hook-check-path` and `hook-status` use the agent ID to locate the correct `meta.json` and enforce path isolation. If the ID is wrong, the hook will either fail (agent not found) or enforce the wrong agent's boundaries.

**Detection**: For each active agent, read `<agent-dir>/repo/.claude/settings.local.json` and extract agent IDs from hook commands. Verify each ID matches the agent's own ID from its directory name.

**Message**: `"Agent <id> has hooks referencing wrong agent <other-id> in settings.local.json"`

### 14.4 Warning Data Structure

```typescript
interface RepoHealthWarning {
  repoPath: string;
  severity: "error" | "warning" | "info";
  category: string;       // e.g., "leaked-hooks", "missing-global-hooks", "orphaned-dir"
  message: string;        // Human-readable description
  agentId?: string;       // If the warning is about a specific agent
  fix?: string;           // Optional suggested fix command
}

interface RepoHealthReport {
  repoPath: string;
  checkedAt: number;      // epoch ms
  warnings: RepoHealthWarning[];
}
```

### 14.5 TUI Display

#### 14.5.1 Repo Header Warning Indicator

When a repo has health warnings, the repo header in the agent tree shows a warning indicator:

```
▾ my-app 🔴          ← has error-severity warnings
▾ other-repo ⚠️       ← has warning-severity warnings (no errors)
▸ clean-repo          ← no warnings (no indicator)
```

The indicator shows the highest severity across all warnings for that repo: `🔴` if any errors exist, `⚠️` if only warnings/info, nothing if clean.

#### 14.5.2 REPO Pane Mode Details

When a repo header is selected and the pane mode is REPO, the health warnings are displayed below the existing repo info content:

```
─── Health ───
🔴 Leaked agent hook in .claude/settings.local.json: ib hook-check-path agent-a1b2c3d4
   Fix: Remove the hook entry from .claude/settings.local.json
⚠️ Missing global safety hooks — run setup (h) to install
⚠️ Orphaned git worktree for agent/agent-deadbeef
   Fix: git worktree remove .ittybitty/agents/agent-deadbeef/repo
ℹ️ Orphaned git branch: agent/agent-cafebabe
```

If no warnings exist, the health section shows: `✅ No configuration issues detected`

#### 14.5.3 Info Panel Summary

When a repo header is selected, the info panel (§11.4) includes a one-line health summary after the agent count:

```
Path: /Users/me/projects/my-app
Agents: 3 (running: 2, waiting: 1)
Health: 🔴 1 error, ⚠️ 2 warnings
```

Or: `Health: ✅ OK`

### 14.6 Manual Re-check

The `H` keybinding (Shift+h, distinct from `h` for setup dialog) triggers a re-run of health checks for all repos. A timed message "Re-checking repo health..." is shown in the status bar. Results replace any previous warnings.

### 14.7 Implementation Notes

- Health checks should complete in <100ms per repo for typical repos (a few agents, standard git setup). Git operations (`worktree list`, `branch --list`) are the most expensive and should be batched.
- The global hooks check (`~/.claude/settings.json`) runs once at startup, not per-repo.
- Results are cached in memory as a `Map<repoPath, RepoHealthReport>`. The cache is invalidated on manual re-check or when the watcher detects changes in `.ittybitty/agents/`.
- Health checks must not modify any files — they are strictly read-only and diagnostic.
- The `readAllAgents()` pipeline already reads `meta.json` for every agent — health checks for §14.3.3, §14.3.4, and §14.3.7 can piggyback on this data rather than re-reading.

### 14.8 Auto-Resolve

Some health check categories can be automatically resolved. The `f` keybinding (active only in REPO mode when resolvable warnings exist) triggers auto-resolution after a confirmation dialog.

#### 14.8.1 Resolvable Categories

| Category | Action |
|----------|--------|
| `leaked-hooks` (§14.3.1) | Remove the matching hook entries from `.claude/settings.local.json` |
| `orphaned-dir` (§14.3.3, all variants) | Remove the agent directory (`rm -rf`) — both the "stale directory" variant (warning severity, valid meta but no tmux/worktree) and the "no valid meta.json" variant (error severity). Directories inside `.ittybitty/agents/` with no valid meta.json are clearly abandoned and safe to remove; agent IDs are validated to prevent path traversal. |
| `orphaned-worktree` (§14.3.5) | Run `git worktree remove <path> --force` |
| `orphaned-branch` (§14.3.6) | Run `git branch -D <branch>` |
| `stale-manager-ref` (§14.3.7) | Remove the `manager` field from the agent's `meta.json` |

#### 14.8.2 Non-Resolvable Categories

| Category | Reason |
|----------|--------|
| `missing-global-hooks` (§14.3.2) | Requires running setup (`h` key) — too complex for a single auto-fix |
| `malformed-meta` (§14.3.4) | Risk of data loss — malformed files need manual inspection |
| `wrong-agent-hooks` (§14.3.8) | Modifying a potentially running agent's settings is risky |

#### 14.8.3 User Interaction

1. **Keybinding**: `f` — only active when in REPO mode with at least one resolvable warning. Shown in the REPO pane hint line and status bar when applicable.
2. **Confirmation dialog**: Lists each resolution action (one line per warning with severity icon). Defaults to Cancel.
3. **Post-resolve**: After resolution completes, a timed notice shows the result count (e.g., "Fixed 3 issue(s)"). Health checks are automatically re-run to update the display.

---

## 15. Remote Control Integration

### 15.1 Overview

Claude Code's [Remote Control](https://code.claude.com/docs/en/remote-control) feature allows a local Claude Code session to be controlled from claude.ai/code or the Claude mobile app (iOS/Android). The local session makes outbound HTTPS requests to the Anthropic API — no inbound ports are opened. Remote clients connect through the Anthropic API, which routes messages between the web/mobile interface and the local session. All traffic uses TLS.

Remote Control is relevant to itsybitsy because it enables users to interact with coordinator sessions from a phone, tablet, or any browser — sending messages, reviewing agent output, and orchestrating work without being at the terminal running `ib watch`.

### 15.2 How Remote Control Works

Key characteristics:

- **Outbound-only networking**: The local Claude process polls the Anthropic API. No firewall changes or port forwarding needed.
- **Two modes**: Server mode (`claude remote-control`) runs headlessly waiting for remote connections. Interactive mode (`claude --remote-control` or `/remote-control`) enables remote access alongside local terminal interaction.
- **Session persistence**: If the laptop sleeps or network drops, the session reconnects automatically when the machine comes back online. Extended outages (>10 minutes) cause the session to time out and exit.
- **Authentication**: Requires claude.ai login (`/login`). API keys are not supported for Remote Control.
- **Plan requirements**: Available on Pro, Max, Team, and Enterprise plans. Team/Enterprise admins must enable Claude Code in admin settings.
- **Version requirement**: Claude Code v2.1.51 or later.
- **Server mode features**: `--name` for session title, `--spawn <mode>` for concurrent sessions (`same-dir` or `worktree`), `--capacity <N>` for max concurrent sessions (default 32), `--verbose` for detailed logs, `--sandbox`/`--no-sandbox` for filesystem isolation.
- **Security**: Uses multiple short-lived credentials, each scoped to a single purpose and expiring independently. Same transport security as any Claude Code session.

### 15.3 Integration Design

#### 15.3.1 Scope: System Coordinator Only

Remote Control is enabled **only for the system coordinator** — not for per-repo coordinators or regular agents. Rationale:

1. **The system coordinator is the user-facing orchestration layer.** It is the single entry point for directing work across all repos. Remote control of this one session gives the user full control over the entire itsybitsy fleet.
2. **Per-repo coordinators are internal infrastructure.** They receive direction from the system coordinator, not the user directly. Exposing them via Remote Control would create a confusing multi-session experience on the mobile app (one session per registered repo).
3. **Regular agents should never be user-controlled remotely.** They follow instructions from their manager/coordinator and have no user-facing interaction model.
4. **Resource efficiency.** Each Remote Control session maintains a persistent polling connection. One connection for the system coordinator is lightweight; one per agent would not scale.

The system coordinator already accepts user input via `tmux send-keys` (§12.3.3). Remote Control provides an additional, more ergonomic input path — the user types in the claude.ai/code interface, and the system coordinator receives it as if typed locally.

#### 15.3.2 Launch Mode

The system coordinator uses **interactive mode** with the `--remote-control` flag: `claude --remote-control "<sessionName>" --model <model>`. This preserves the existing prompt delivery via `tmux send-keys` (§12.1.2) while enabling remote access. The session is accessible both locally (via tmux) and remotely (via claude.ai/code).

Server mode (`claude remote-control`) was considered but rejected — it waits for remote connections before accepting input, which would require changing the prompt delivery mechanism from `tmux send-keys` to a `CLAUDE.md` file.

The `--remote-control` flag in interactive mode accepts an optional session name as a positional argument (e.g., `claude --remote-control "itsybitsy coordinator"`). This name appears in the claude.ai/code session list and the Claude mobile app.

#### 15.3.3 Authentication Requirement

Remote Control requires claude.ai authentication (`/login`), not API keys. This means:

- Users must have run `claude` and completed `/login` at least once before enabling remote control.
- The health check (§14) should verify login status when remote control is enabled — add a new check category (§15.7).
- If the user's Claude Code installation uses an API key instead of claude.ai auth, remote control cannot be enabled. The config toggle should warn about this.

#### 15.3.4 Session Naming

The Remote Control session is named `"itsybitsy coordinator"` by default, configurable via config (`remoteControl.sessionName`). This name appears in the claude.ai/code session list and the Claude mobile app, making it easy to find among other sessions.

### 15.4 Configuration

New config keys in `~/.itsybitsy/config.json`:

```json
{
  "remoteControl": {
    "enabled": false,
    "sessionName": "itsybitsy coordinator"
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `remoteControl.enabled` | boolean | `false` | Enable Remote Control for the system coordinator. When `true`, the system coordinator launches with `--remote-control` flag. Requires claude.ai authentication. |
| `remoteControl.sessionName` | string | `"itsybitsy coordinator"` | Session name visible in claude.ai/code and the Claude mobile app session list. |

**Default off**: Remote Control is disabled by default. The TUI coordinator experience is sufficient for most users. Remote Control is opt-in for users who want mobile/browser access to the coordinator.

### 15.5 TUI Integration

#### 15.5.1 Setup Dialog (h key)

The setup dialog (§10) gains a new toggle in the configuration tab:

```
Remote Control: [OFF]     (toggle with Enter)
```

When toggled ON, the dialog shows a confirmation: `"Remote Control requires claude.ai login. The system coordinator will restart with remote access enabled. Continue?"`. On confirmation:

1. Write `remoteControl.enabled: true` to config
2. Restart the system coordinator (`restartSystemCoordinator()`)

When toggled OFF: write config, restart coordinator without the flag.

**Note**: Changing this setting requires restarting the system coordinator because the `--remote-control` flag must be present at launch time — it cannot be toggled on a running session.

#### 15.5.2 Status Indicator

Remote Control status is shown in two places (both visible when the system coordinator is selected, since the info panel is hidden per §12.1.4):

1. **Coordinator panel header** in the sidebar: `──── System Coordinator (remote) ────` when enabled, or the standard `──── System Coordinator ────` when disabled.
2. **System dashboard header**: `"ib — agent dashboard (remote control enabled)"` when active.

The agent tree row for the system coordinator is unchanged — it already shows state and age, and adding a remote indicator would clutter the compact format.

#### 15.5.3 Session Access Information

The session URL and QR code are displayed in the coordinator's tmux output (visible in the coordinator sidebar panel). itsybitsy does not need to parse or extract them — the user can read them directly from the tmux output or find the session in their claude.ai/code session list by the configured session name.

### 15.6 CLI Integration

No new `ib` commands are needed. Remote Control is managed through:

1. **Config**: `remoteControl.enabled` and `remoteControl.sessionName` in `~/.itsybitsy/config.json`
2. **Setup dialog**: Toggle in the TUI (§15.5.1)
3. **System coordinator lifecycle**: `ensureSystemCoordinator()` reads config and adds `--remote-control` flag when enabled

The existing `ib` command pattern (`ib hooks install/uninstall`) is not appropriate here because Remote Control is not a hook — it's a launch flag on the coordinator process. Config + restart is the correct pattern.

### 15.7 Health Check Integration

A new health check category is added to §14.3:

#### 15.7.1 Remote Control Version Check (warning)

**What**: Remote Control is enabled in config but the Claude Code version is too old.

**Detection**: When `remoteControl.enabled` is `true`, check Claude Code version is >= 2.1.51 (parse output of `claude --version`).

**Message**: `"Remote Control enabled but Claude Code version is <version> (requires >= 2.1.51)"`

**Authentication**: There is no reliable programmatic way to detect whether the user has completed `/login` vs using an API key — `ANTHROPIC_API_KEY` may coexist with a valid login. Instead, the setup dialog (§15.5.1) shows a reminder: `"Ensure you've run /login in Claude Code before enabling Remote Control"`. If Remote Control fails at runtime due to missing auth, the error is visible in the coordinator's tmux output.

### 15.8 Security Considerations

#### 15.8.1 Permission Model

Remote Control does not change the system coordinator's permissions. The coordinator still has only `Bash(ib:*)` — it can run `ib` commands and nothing else. A remote user has exactly the same capabilities as someone typing in the TUI's coordinator input field:

- List agents (`ib list`)
- Send messages to agents (`ib send`)
- Merge/kill/create agents
- Check status and diffs

The deny list (Read, Write, Edit, etc.) is enforced by Claude Code's `settings.local.json` regardless of whether input comes from tmux, the TUI, or a remote client. Remote Control is just another input surface — it does not bypass permission enforcement.

#### 15.8.2 Authentication Boundary

Remote Control sessions are tied to the user's claude.ai account. Only someone authenticated with that account can connect to the session. There is no shared-access or team-access model.

**Shared-account risk**: If someone else has access to the same claude.ai account (shared credentials, compromised account, or team admin on a Team/Enterprise plan), they can connect to the Remote Control session and issue `ib` commands — creating agents, merging code, killing work. The trust boundary is the claude.ai account, not the local machine. Mitigation: use a dedicated claude.ai account for itsybitsy in shared environments, and follow standard account security practices (strong password, MFA).

#### 15.8.3 Network Exposure

The system coordinator makes outbound HTTPS connections only. No inbound ports are opened on the user's machine. The Anthropic API acts as a relay — the remote client and local session never communicate directly. This means:

- No firewall configuration is needed
- The machine is not exposed to incoming connections
- Network security posture is unchanged from a standard Claude Code session

#### 15.8.4 Session Lifetime

The Remote Control session lives as long as the system coordinator's tmux session. When `ib watch` exits and the last reference is released (§12.1.2), the coordinator is killed and the Remote Control session ends. The session also times out after ~10 minutes of network unavailability.

**Risk**: If a user enables Remote Control, starts a task from their phone, then closes their laptop, the coordinator continues running (tmux persists across terminal closures). The task completes and agents may be waiting for review. When the user reopens their laptop, the session reconnects and they can continue. This is the intended behavior — Remote Control is designed to survive interruptions.

#### 15.8.5 Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Unauthorized remote access | Low | Tied to claude.ai account auth; same security as any Claude Code session |
| Shared-account access | Medium | Anyone with access to the same claude.ai account can connect and issue `ib` commands. Use a dedicated account in shared environments. See §15.8.2 |
| Coordinator permission bypass via remote input | None | Permissions enforced by `settings.local.json`, not input source |
| Persistent session after `ib watch` exit | Low | Session killed with coordinator tmux session; timeout after 10min network loss |
| Stale session in claude.ai session list | Low | Session shows offline status when coordinator is not running |
| Remote input during confirmation dialog | Low | If remote client sends input while coordinator is mid-interaction (e.g., confirmation prompt), it could confirm an unintended action. Same race condition exists with `tmux send-keys` today; Remote Control makes it more likely since remote user lacks visibility into exact UI state. Coordinator processes input sequentially — no additional mitigation needed beyond existing model |

### 15.9 Affected Files and Modules

| Module | Changes needed |
|--------|---------------|
| `src/config.ts` | New config keys: `remoteControl.enabled` (boolean, default `false`), `remoteControl.sessionName` (string, default `"itsybitsy coordinator"`) |
| `src/coordinator.ts` | `ensureSystemCoordinator()` reads `remoteControl.enabled` from config; if true, adds `--remote-control "<sessionName>"` to the `claude` command in the tmux session |
| `src/tui/dashboard.ts` | System dashboard header shows "(remote control enabled)" when active. |
| `src/tui/sidebar.ts` | Coordinator panel header shows "(remote)" suffix when Remote Control is enabled |
| `src/tui/dialog-handler.ts` | New toggle for Remote Control with restart confirmation and auth reminder |
| `src/health-check.ts` | New check: remote control prerequisites (version, auth) |

### 15.10 Limitations and Future Work

- **Per-repo coordinators**: Remote Control is not enabled for per-repo coordinators in this design. If users need direct remote access to a specific repo's coordinator, they can send commands through the system coordinator (e.g., `ib send itsybitsy "review the latest PR"`). A future enhancement could allow per-repo remote control sessions, but the UX of multiple remote sessions needs careful design.
- **Multi-user access**: Remote Control is single-user (tied to claude.ai account). Team scenarios where multiple users control the same itsybitsy instance are not supported. This would require a different architecture (e.g., a shared web UI).
- **Session recovery**: If the coordinator process crashes, the Remote Control session is lost. The user must restart via the TUI (`R` key). A future enhancement could auto-restart the coordinator with Remote Control re-enabled.
- **Notification forwarding**: Remote Control does not provide push notifications. The user must actively check the session to see coordinator output. Integration with the Claude mobile app's notification system would be a valuable future enhancement.
- **`--spawn worktree` mode**: Not used because the system coordinator has no codebase. If per-repo coordinators gain Remote Control in the future, `--spawn worktree` could be relevant for isolating concurrent sessions.

---

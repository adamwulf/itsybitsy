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

1a. **Spawner worktree cleanliness**: The spawner's CWD (`opts._cwd` if provided by the intercept-task hook, else `process.cwd()`) must have an empty `git status --porcelain`. If non-empty, the spawn is rejected before any side effects (no agent directory created, no worktree allocated, no tmux session started). Skipped when the CWD is not a git working tree (e.g. system coordinator home, raw temp dir) — `git rev-parse --is-inside-work-tree` must exit 0 AND print `true` for the check to fire. Also skipped (falls open) when `git status --porcelain` itself exits non-zero, since a transient git failure shouldn't block spawning. The rationale differs by spawn mode: for worktree spawns, the new sub-agent's worktree forks from HEAD and would silently miss the spawner's pending edits; for `--no-worktree` spawns, the sub-agent runs in the spawner's own CWD and its edits would interleave with the spawner's pending edits, producing incoherent diffs. The error message names both `uncommitted changes` and `untracked files`, suggests `commit` / `.gitignore` / `remove` as remediations, and includes the raw porcelain output for the user to triage.

2. **Auto-detect manager**: If no `--manager` is provided and the caller is running inside an agent worktree (CWD matches `/.ittybitty/agents/<id>/repo`), the caller's agent ID is automatically set as the manager.

3. **Yolo escalation prevention**: A `--yolo` child cannot be spawned by a non-yolo parent. This prevents permission escalation where a constrained agent spawns an unconstrained one. The parent's yolo status is checked via `meta.json` or `start.sh`.

4. **Configuration**: Config is loaded from `~/.itsybitsy/config.json` (user-wide). The agent type is resolved by: `--type` flag > default `"manager"`. The type definition is loaded from `~/.itsybitsy/agent-types/<name>.md` — the `.md` file on disk is the sole source of truth (no hardcoded fallback). On first run, `~/.itsybitsy/agent-types/` is auto-populated with embedded default templates (see §2.7). The model is determined by a most-specific-wins precedence chain across the agent-type layer files (same layer set and gating as the permissions merge, §2.3): `--model` flag > `<type>.md` `model` > `_non_coordinator.md` `model` (non-coordinator agents only) > `_all.md` `model` > config `model` (non-coordinator agents only) > `"opus"` (default). The agent-type layers all override the user's config `model`; config `model` is the final fallback before `"opus"` for non-coordinator agents only. Coordinators deliberately skip config `model` — the coordinator agent-type file is authoritative for coordinators, since otherwise the user's global `model` setting would clobber the coordinator agent-type. A blank `model:` value in any layer (parsed to `undefined`) is skipped, so a more-specific file declaring `model:` with no value does NOT clobber a real model set by a less-specific file. The reasoning-effort level (`--effort <level>` for Claude, `model_reasoning_effort` for codex) is resolved by the identical chain and gating: `--effort` flag > `<type>.md` `effort` > `_non_coordinator.md` `effort` (non-coordinator agents only) > `_all.md` `effort` > config `effort` (non-coordinator agents only) > `"xhigh"` (default). Valid levels are `low|medium|high|xhigh|max`; codex has no `xhigh`/`max`, so those two collapse to codex's `high` (see §18). A blank `effort:` is skipped the same way a blank `model:` is.

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
   - Layer-file permissions from `~/.itsybitsy/agent-types/_all.md` (all agents) and `~/.itsybitsy/agent-types/_non_coordinator.md` (non-coordinator agents only)
   - Type-defined permissions from `~/.itsybitsy/agent-types/<type>.md` frontmatter
   - Hook definitions: path-check, stop, permission-denied, session-start, and optionally intercept-task (for agents with `canSpawnChildren: true`)
   - The agent ID placeholder `__AGENT_ID__` is replaced with the actual ID after writing

10. **Write meta.json** to `<agent-dir>/meta.json` (see §5.2 for fields). Includes `agentType` (the resolved type name), `agentIcon` (the type's icon character, if defined), and `allowedPaths` (resolved absolute paths from the type's `allowedPaths` frontmatter, if defined — see §6.1).

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
   - If stored `meta.state === "waiting"` AND tmux shows `⏵⏵.*·\s\d+\s` (background shells, e.g. `⏵⏵ accept edits on · 1 shell`) in last 15 lines → `running`. Scoped strictly to `waiting` — we do NOT override `complete` (intentional sign-off) or `running` (already correct). See §8.5.1.

4. **Read `state` from meta.json** → return the stored value (`running`, `waiting`, or `complete`). If `state` field is absent (legacy agent or freshly created agent before first stop hook fires): if `created_epoch` is less than 6 seconds ago → `creating`; otherwise → `running`.

**ANSI stripping**: Tmux output used for compacting/rate_limited checks must have ANSI escape sequences stripped before pattern matching.

### 1.3.1 State Writes

State is written to `meta.json` by exactly five actors:

| Actor | When | State written |
|-------|------|---------------|
| **Stop hook** (`ib hook-status`) | Claude becomes idle | `waiting`, `complete`, or `running` (nudge case) |
| **PreToolUse hook** (`ib hook-check-path`) | Before every tool call | `running` |
| **UserPromptSubmit hook** (`ib hook-mark-running`) | Input arrives (incl. `tmux send-keys` from another agent) | `running` (guarded — bails if current state is `complete` or `stopped`) |
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
| `name` | string | Yes | Type identifier. Always derived from the filename — **never inherited** from a parent type, even if the parent's frontmatter declares `name:`. |
| `description` | string | No | Human-readable description. Inheritable (child replaces when present). |
| `canSpawnChildren` | boolean | Yes | Whether agents of this type can spawn sub-agents. Inheritable (child replaces when present, including explicit `false`). |
| `spawnable` | boolean | No | Whether this type can be spawned directly via `ib new-agent --type <name>`. Defaults to `true` when absent. `false` marks layer-only files (e.g. `_all.md`, `_non_coordinator.md`) whose frontmatter permissions and markdown body merge into every spawned agent but which cannot themselves be spawned. **Never inherited** — always read from the target file's own frontmatter. |
| `inherits` | string | No | Name of another agent type (filename minus `.md`) to inherit from. Scalar fields override when the child declares them; `permissions.allow/deny` **merge** across the chain (Set-deduped); `allowedPaths` and `repos` **replace** (not merge) when the child declares them. Cycles and missing parents are errors. Layer files (`spawnable: false`) may NOT use `inherits:`. Empty string (`inherits: ""`) is treated as absent. |
| `icon` | string | No | Display icon — first non-whitespace character is extracted. Inheritable (child replaces when present and non-empty). |
| `model` | string | No | Default model override (used before config fallback). Inheritable (child replaces when present and non-empty — empty string means inherit). |
| `effort` | string | No | Reasoning-effort override (`low\|medium\|high\|xhigh\|max`) threaded to the CLI (Claude `--effort`, codex `model_reasoning_effort`; used before config fallback, default `xhigh`). Inheritable exactly like `model` (child replaces when present and non-empty — empty string means inherit). |
| `permissions` | object | No | Type-specific `allow`/`deny` permission lists. Inheritable — each list is **unioned across the chain** and Set-deduped. |
| `allowedPaths` | string[] | No | Directories the agent can access beyond its worktree. `undefined` = legacy permissive, `[]` = strict (worktree only). Paths may use `~` (expanded at creation time). See §6.1 for enforcement details. Inheritable — **replaces** (not merges) when the child declares it; a child declaring `allowedPaths: []` correctly overrides a permissive parent. |
| `repos` | string[] | No | If defined, this type can only be spawned in repos whose basename or registered nickname matches an entry. Checked by `ib new-agent` before any worktree/tmux/agent-dir allocation. `undefined` = no restriction. **Empty list is rejected at validation** (an unspawnable type is almost always a YAML typo). Inheritable — **replaces** (not merges) when the child declares it. |
| `instructionStyle` | `"manager"` \| `"worker"` \| `"coordinator"` | Yes | Maps to base instruction set for session-start (defaults to `"manager"`). Inheritable (child replaces when present). |
| `markdownBody` | string | No | Template body for custom instructions (see §6.3.1). Inheritable — the final body is the **concatenation of every non-empty body in the inheritance chain, root-first, joined by blank lines**. Root-first means the oldest ancestor's body appears first and the leaf (child) appears last. Example: `C inherits B inherits A` yields `A_body\n\nB_body\n\nC_body`. Empty bodies in the chain are skipped so a missing-body ancestor doesn't leave stray blank lines. |

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
   - `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `TodoWrite`, `Task`, `TaskCreate`, `Agent`, `TaskOutput`, `KillShell`, `NotebookEdit`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ToolSearch` — Claude Code tools
   - **Always denied**: `EnterPlanMode`, `ExitPlanMode`

3. **Layer-file permissions** — `~/.itsybitsy/agent-types/_all.md` and `~/.itsybitsy/agent-types/_non_coordinator.md`
   - `_all.md` — `permissions.allow/deny` from its YAML frontmatter applies to ALL agent types (including coordinators)
   - `_non_coordinator.md` — `permissions.allow/deny` from its YAML frontmatter applies only to non-coordinator agents (i.e. skipped for agents spawned with `--type coordinator`)
   - Both files have `spawnable: false` frontmatter so `ib new-agent --type _all` (or `_non_coordinator`) is rejected — they are permission/prompt layers, not spawnable types.

4. **Type-defined permissions** — `~/.itsybitsy/agent-types/<type>.md` (frontmatter)
   - `permissions.allow` and `permissions.deny` fields from the agent type definition file's YAML frontmatter
   - Coordinator-specific permissions live here (`coordinator.md`), not in `~/.itsybitsy/config.json`

**AskUserQuestion is intercepted and denied**: The intercept-task hook matches `AskUserQuestion` alongside `Task|Agent|TaskCreate` and denies the call with a message directing the agent to use `ib ask "question"` instead. Leaf agents are told to report to their manager rather than asking the user directly. This routes user questions through the dashboard's QUESTIONS pane and the `ib ask` / question-acknowledgement flow rather than Claude Code's built-in multi-choice prompt.

All allow/deny lists are merged and deduplicated. The final result is written to `<agent-dir>/repo/.claude/settings.local.json` along with hook definitions (§6).

**Deprecated config keys**: `permissions.manager.allow/deny`, `permissions.worker.allow/deny`, `permissions.coordinator.allow/deny`, `permissions.all.allow/deny`, and `permissions.repo.allow/deny` have all been removed from `CONFIG_KEYS`. If present in `~/.itsybitsy/config.json`, a deprecation warning is shown at `ib watch` startup directing users to migrate entries into the appropriate agent-type layer file: `permissions.all.*` → `~/.itsybitsy/agent-types/_all.md` frontmatter under `permissions.allow/deny`; `permissions.repo.*` → `~/.itsybitsy/agent-types/_non_coordinator.md`; `permissions.<role>.*` → the corresponding type file.

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
allowedPaths:
  - ~/Developer/shared-lib
  - /tmp
---

## Research Agent Instructions

You are research agent `{{agentId}}`...
(template body with {{variable}} and {{#if condition}}...{{/if}} blocks)
```

**Frontmatter fields**: See §2.2 for the full list.

**Template body**: If present, the markdown body below the frontmatter is used as the instruction template at session start (see §6.3.1). If absent, the hardcoded instructions for the `instructionStyle` are used.

**Icon resolution**: The `icon` field's first non-whitespace character is extracted and stored in `meta.json` as `agentIcon`. This icon is displayed in the TUI agent tree, CLI output (`ib list`), and status injection.

**Location**: All types live in `~/.itsybitsy/agent-types/<name>.md`. The default types (manager, worker, coordinator) plus two layer files (`_all.md`, `_non_coordinator.md`) are embedded in the `ib` binary and auto-populated on first run (§2.7). Source templates are also available in `docs/agent-types/` in the source repository.

**Layer files (`_all.md` and `_non_coordinator.md`)**: These are agent type files with `spawnable: false` frontmatter. They cannot be spawned directly (`ib new-agent --type _all` is rejected with an error), but their `permissions.allow/deny` frontmatter and markdown body merge into every spawned agent: `_all.md` applies to every type; `_non_coordinator.md` applies to every type except `coordinator`. The type body is joined after the applicable layer bodies (layer prefix first, then type) in the session-start instruction output — see §6.3.1. `spawnable` is per-file (never inherited) and layer files (`spawnable: false`) **cannot use `inherits:`** — a layer inheriting another type's body would silently prepend that body to every spawned agent's prompt, which is a high-blast-radius footgun. Validation rejects the combination at `ib watch` startup.

**Inheritance (`inherits:`)**: A type may declare `inherits: <parent>` in its frontmatter to build on another type. Chain resolution walks parent-first; the resolver merges **raw parsed frontmatter objects** rather than already-constructed `AgentType` records. This matters because a child's explicit `canSpawnChildren: false` must override a parent's `true` — merging already-constructed records would collapse the "absent vs. explicit false" distinction. See the field table in §2.2 for per-field override / merge / replace rules. Cycles (`A → B → A`), self-inheritance, and missing parents all surface as errors at `ib watch` startup (§2.8) via `validateAllAgentTypes`.

**Repo restriction (`repos:`)**: A type may declare a `repos:` list in its frontmatter to restrict which registered repos it can be spawned in. Matching: when the current repo is registered in `~/.itsybitsy/repos.json`, a match requires the list to contain the repo's basename (`name`) or its nickname. Unregistered repos match only via basename. The check runs in `ib new-agent` *before* any worktree, tmux, or agent-directory allocation so a rejection leaves no residue. The `--name` flag does not bypass this check. An empty list (`repos: []`) is a YAML typo rather than an intentional "unspawnable" marker — validation rejects it.

### 2.7 Auto-Population and init-types

**Auto-population**: On first run (when `~/.itsybitsy/agent-types/` does not exist), the directory is created and populated with the embedded default type files (manager.md, worker.md, coordinator.md, _all.md, _non_coordinator.md). This happens automatically at `ib watch` startup and `ib new-agent` execution. If the directory already exists, no files are written — the user's customizations are preserved.

**`ib init-types` command**: Writes any missing embedded type files to `~/.itsybitsy/agent-types/` without overwriting existing files. Use this to restore accidentally deleted defaults or after an `ib` upgrade that adds new built-in types. Alias: `ib init-agent-types`.

**Embedded templates**: The default type `.md` files from `docs/agent-types/` are compiled into the `ib` binary via text imports. Changes to `docs/agent-types/*.md` are reflected in the binary on recompilation.

### 2.8 Startup Validation

When `ib watch` launches, it validates all agent type files in `~/.itsybitsy/agent-types/` before starting the dashboard (after auto-population). If any file has YAML parsing errors, invalid field types (e.g., `canSpawnChildren` is not a boolean), invalid `instructionStyle` values, invalid `allowedPaths` entries (must be a list of strings), a non-string `inherits:` value, `inherits:` on a layer file (`spawnable: false`), a malformed `repos:` value (must be a list of strings; empty lists and bare strings are rejected), a **circular inheritance chain** (`A → B → A`), or a **missing parent** in an inheritance chain, the dashboard exits immediately with error messages describing each issue. This prevents runtime failures from malformed type definitions — inheritance-chain errors in particular surface at startup rather than at spawn time.

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
3. **Auto-detect sender**: If called from within an agent worktree, the sender's agent ID is read from `meta.json`. If called from the system coordinator's home (`~/.itsybitsy/`, or any subdirectory), the sender is recorded as the `@system` sentinel. An explicit `--from <sender-id>` flag can also be passed to override auto-detection.
4. **Format message**: If a sender is detected, the message is prefixed. Real agent IDs render as `[sent by agent <sender-id>]: <message>`. Sentinel IDs that begin with `@` (e.g. `@system`, `@<repo-name>`) render as `[sent by <sentinel>]: <message>` — the literal word "agent" is omitted because these are not agent IDs. **User slash/bang passthrough**: a message from the **human user** (no detected sender) whose first character is `/` or `!` is delivered **verbatim with no prefix**, so it reaches the recipient pane in column 0 and fires as a Claude slash command (`/clear`, `/compact`) or a `!`-bang shell command exactly as if the user had typed it directly. The prefix would otherwise push the leading `/`/`!` off the first column and stop the command from running. This is scoped to user sends only: an **agent-relayed** message keeps its `[sent by agent ...]` attribution even when it starts with `/` or `!`, so the recipient still knows the source. Only a leading `/`/`!` triggers passthrough — a message that merely *contains* (but does not start with) `/` or `!`, or one whose first non-space character is preceded by whitespace, is prefixed normally. This is a third, narrower "skip the prefix" path alongside `raw` mode (§4.1.1, used by Telegram slash-command passthrough, which suppresses the prefix unconditionally) and the `@`-sentinel rendering above. `raw` is checked **first** in `deliverMessage`, so on a `raw` send the message is delivered verbatim via the raw branch (logged `Received raw message: …`) and the passthrough branch is never reached — passthrough only governs **non-`raw`** user sends (logged `Received command from user: …`). The two produce the same verbatim pane output; they differ only in mechanism and log line. Because the rule lives at the single delivery chokepoint (`deliverMessage`), every **non-`raw`** user-send path inherits it: CLI `ib send` (including `ib send @system` / `sendToSystemCoordinator`, which is non-`raw` from the CLI), the dashboard **agent** input field (`dashboard.ts` `inputField.onSubmit`), and the dashboard **per-repo coordinator** input field (`repoCoordinatorInputField.onSubmit`). The dashboard's **system-coordinator** send paths are the exception — both the inline coordinator input field (`coordinatorInputField.onSubmit`) and the `s`-key coordinator send dialog (`handleSendToCoordinator`) call `sendToSystemCoordinator(..., { raw: true })`, so a user-typed `/clear` there reaches the coordinator pane verbatim via the `raw` branch, not the passthrough branch (identical pane output, but logged as a raw message). A consequence worth noting: a future "broadcast to all agents" path built on this non-`raw` chokepoint would send a user `/clear` verbatim to every recipient.
5. **Send via tmux**: `tmux send-keys -t <session> "<message>"` (no `-l` literal flag), then after a calculated delay, `tmux send-keys -t <session> Enter` separately. [^note] The TypeScript implementation uses `-l` (literal flag) to prevent key interpretation of special characters; the bash version relies on tmux's default key handling without `-l`.
6. **Delay calculation**: `0.1 + (message_length / 100) * 0.5` seconds, clamped to [0.2, 3.0]. Longer messages need more time for the paste to complete in tmux. The `message_length` here is the length of the full formatted message (including the `[sent by ...]` prefix if present).
7. **Logging**: Both sender and recipient get entries in their `agent.log`. Recipient log entries are written with `--quiet` (no stdout echo); sender log entries echo to stdout. [^note] The `--quiet` distinction is bash-specific. The TypeScript `logAgent()` is always write-only (appends to `agent.log` without echoing to stdout) for both sender and recipient. Additionally, in bash when `fromId` is set, the sender's log message ("Sent message to ...") is echoed to stdout; in TypeScript, `stdout` is returned as an empty string when `fromId` is set (only returning `"Sent to <id>"` when there is no sender).
8. **Stdin piping**: Messages can also be provided via stdin (`echo "msg" | ib send <id>` or `ib send <id> < file.txt`) when no positional message argument is given. Both bash and TypeScript support stdin piping when no positional message is provided and stdin is not a TTY.
9. **State reset**: After sending the message, write `state: "running"` and `state_updated_at` to the target agent's `meta.json` (atomic merge write). This ensures that agents in `waiting` or `complete` state are immediately marked as `running` when they receive input. See §1.3.1.

#### 4.1.1 Per-agent outbox queue (serialized delivery)

[^note] **TypeScript only.** To stop two near-simultaneous sends to the SAME agent from interleaving their `send-keys -l` chunks and `Enter` keystrokes (which would merge two messages into one prompt), every delivery path enqueues to a **per-agent outbox queue** and a single drainer types into the tmux session. There is **no central dispatcher** — the queue and lock are keyed per-agent (i.e. per tmux session), so busy multi-agent communication has no shared bottleneck.

- **Queue file**: `outbox.jsonl` beside `meta.json` (`<repoPath>/.ittybitty/agents/<id>/`). One JSON object per line: `{id, message, fromAgent, raw, enqueuedAtMs}`. `fromAgent` is the resolved sender (real agent id, `@`-sentinel, or `""` for the human user). The `[sent by ...]` prefix is **not** pre-formatted at enqueue time — prefix/label resolution (including the `user.name` config read) happens at DRAIN time so the formatting matches the historical behavior exactly. The one thing resolved at ENQUEUE time is `fromAgent` (cwd-based sender auto-detection depends on the sender process's cwd, which is gone by drain time).
- **`sendMessage` behavior**: resolve sender → enqueue → if a **live watchdog** exists (fresh `meta.transient.json` `watchdog_pid` within `TRANSIENT_FRESH_MS` and `process.kill(pid, 0)` alive), return immediately (the watchdog drains); otherwise **drain inline** under the lock (the sender becomes the drainer for this batch — preserves `ib send` to a stopped/complete agent and the coordinator path). Public signature, return shape, and the `sendSpawnCtx`/`setSendSpawnRunner`/`sendDelayOverrideMs` test hooks are unchanged. With no transient file present (the common unit-test case) the inline drain produces the SAME observable tmux spawn calls in the same order as before this feature.
- **The drainer is the single tmux writer**: `deliverMessage(agent, queued)` does the has-session check, prefix formatting, chunked `send-keys -l`, length-scaled delay, `Enter`, recipient/sender logging, and `writeAgentState("running")` for exactly one message. `drainOutbox` pops messages one at a time under the lock with a 250 ms settle gap between consecutive messages so they land as distinct prompts. A delivered message is removed from the outbox (tmp+rename rewrite of the remainder) only AFTER its `Enter` succeeds and it is logged — so a crash mid-batch never redelivers, and a failed delivery leaves the message enqueued (no loss). Appends that arrive mid-drain are preserved by re-reading the file before each rewrite and picked up on the next drain.
- **Per-session lock**: `.outbox.lock` in the agent dir, an advisory lock via exclusive file creation (`open(path, "wx")`, O_CREAT|O_EXCL). On EEXIST the holder retries with backoff up to ~5 s. The inline fallback may **steal** a lock whose mtime is older than 30 s (crashed holder); the watchdog never steals (it just retries next tick). The holder pid is written into the lock file for debuggability; the lock is always released in a `finally`. Both the watchdog drain and the inline fallback acquire the SAME lock, so even a fallback that races a newly-alive watchdog cannot collide.
- **System coordinator**: the system coordinator has no agent dir and no per-agent watchdog, so its outbox + lock live in the coordinator home (`getCoordinatorHome()`). `sendToSystemCoordinator` routes through `sendMessage` with `outboxDir` pointing at the coordinator home, so all coordinator writes serialize against one queue + lock and always drain inline. Every coordinator-bound send goes through it: CLI `ib send @system`, watchdog `@system` notifications, Telegram `@telegram` passthrough, the dashboard `s`-key coordinator send dialog (`handleSendToCoordinator`), AND the inline coordinator input field in the coordinator TMUX view (`coordinatorInputField.onSubmit`).
- **Hook nudges**: the Stop hook (`agent-status.ts`) routes its self-nudge and `notify_manager` messages through `sendMessage` attributed to the watchdog sentinel (`fromAgent: WATCHDOG_SENTINEL`, delivered as `[sent by watchdog]: <message>`) instead of typing into tmux directly — both so a hook nudge can't collide with a concurrent `ib send` AND so the recipient can tell a system nudge apart from a human console send (without the prefix, an agent that had just asked a question could misread the `Resume your work...` nudge as the answer to its own question).
- **Cleanup**: `outbox.jsonl` and `.outbox.lock` are runtime delivery state with no historical value — `deleteAgentOutbox()` deletes them (does not archive) at the same teardown sites as `deleteAgentTransient()` (see `archiveAgent`).

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
  "coordinator": true,            // only present for per-repo coordinators (§12.2.2)
  "allowedPaths": ["/Users/adam/Developer/shared-lib", "/tmp"]  // optional, from agent type (§6.1)
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
| `effort` | string \| null | Resolved reasoning-effort level (`low\|medium\|high\|xhigh\|max`), or `null`/absent for legacy agents (treated as no override). Stores the **raw itsybitsy level** verbatim; the codex `model_reasoning_effort` mapping happens at launch-arg build time. Re-read by `ib resume` to re-apply the effort flag. See §2 item 4 / §18. |
| `claude_pid` | string | PID of the Claude process (appended to meta.json via `sed` after start.sh launches Claude — not present in the initial write) |
| `watchdog_pid` | string | PID of the watchdog process (appended to meta.json after watchdog spawns — not present in the initial write; see §8.5) |
| `state` | string \| undefined | Deterministic agent state written by the stop hook, `ib send`, or `ib resume`. Values: `"running"`, `"waiting"`, `"complete"`. Absent on legacy agents or before the first stop hook fires (treated as `"running"` if agent is older than 6s). See §1.3.1. |
| `state_updated_at` | number \| undefined | Unix epoch seconds when `state` was last written. Used for debugging. |
| `coordinator` | boolean \| undefined | `true` for per-repo coordinators (§12.2.2). Absent for regular agents. |
| `allowedPaths` | string[] \| undefined | Resolved absolute paths the agent can access beyond its worktree (from agent type `allowedPaths` frontmatter, expanded at creation time). `undefined` = legacy permissive, `[]` = strict mode. See §6.1. |

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
| **Spawning agent** (`canSpawnChildren: true`) | `<repo>/.ittybitsy/agents/<id>/repo` | Agent's `settings.local.json` (5 hooks: path-check, stop, session-start, permission-denied, intercept-task) | Built per §2.3 with `_all.md` (always) + `_non_coordinator.md` (non-coordinators only) + type-defined permissions | CWD matches pattern AND agent type has `canSpawnChildren: true` |
| **Leaf agent** (`canSpawnChildren: false`) | `<repo>/.ittybitty/agents/<id>/repo` | Agent's `settings.local.json` (4 hooks: path-check, stop, session-start, permission-denied — NO intercept-task) | Built per §2.3 with `_all.md` + `_non_coordinator.md` + type-defined permissions | CWD matches pattern AND agent type has `canSpawnChildren: false` |

**Key distinction**: Primary Claude uses ONLY the global hooks from `~/.claude/settings.json` (§6.7). Per-agent hooks (§6.1–6.6) are installed ONLY in agent worktree `settings.local.json` files and must never leak into the user's repo-level `settings.local.json`. If agent hooks are left in a repo's `settings.local.json` after an agent is killed or merged, they will incorrectly restrict the user's direct Claude sessions in that repo.

**Hook isolation invariant**: `ib kill`, `ib nuke`, and `ib merge` must ensure agent-specific hooks are cleaned from the repo's `settings.local.json` if they were ever written there. The intended flow is:
1. Agent creation writes hooks to `<agent-dir>/repo/.claude/settings.local.json` (inside the worktree)
2. The worktree is removed on kill/merge/nuke
3. The repo's own `.claude/settings.local.json` is never modified by agent lifecycle operations

**Detection pattern**: The `AGENT_CWD_PATTERN` regex (`/.ittybitty/agents/([^/]+)/repo(/|$)`) is used by all hooks to distinguish agent contexts from primary Claude. If CWD does not match this pattern, the session is treated as primary Claude and per-agent restrictions do not apply.

itsybitsy installs hooks into each agent's `settings.local.json`, plus optional global hooks in `~/.claude/settings.json`. Agents with `canSpawnChildren: true` get six hooks (path isolation, stop, session-start, permission-denied, mark-running, and intercept-task); leaf agents (`canSpawnChildren: false`) get five (no intercept-task).

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

**Always allowed paths** (steps 6–8):
- Agent's own worktree (`<agent-dir>/repo/...`)
- Agent's own `agent.log`
- Agent's own Claude project directory (`~/.claude/projects/<encoded-worktree-path>/**`) — where Claude Code spills oversized tool responses and stores transcripts. Encoded via replacing `/` and `.` with `-` (see `src/auto-compact.ts::encodeClaudeProjectPath`).

**Always denied paths** (steps 9–10, checked before allowedPaths):
- Other agents' directories
- Main repo root (outside the agent's worktree)

**allowedPaths-based access control** (step 11): If the agent's `meta.json` contains an `allowedPaths` field (set from the agent type's frontmatter at creation time — see §2.2), it controls access to all other paths:
- `allowedPaths` **absent** (`undefined`): Legacy permissive mode — all paths outside the always-denied set are allowed (home directory, `/tmp`, system paths, other repos).
- `allowedPaths: []` (empty array): Strict mode — only the always-allowed paths above are permitted. No system paths, no other repos.
- `allowedPaths` with entries: Only paths under the listed directories are allowed (in addition to the always-allowed paths). Matching is by exact path or directory prefix (`filePath === allowed || filePath.startsWith(allowed + "/")`).

The distinction between `undefined` (absent) and `[]` (empty) is critical for backward compatibility: existing agents without `allowedPaths` in meta.json retain the current permissive behavior.

**Logging**: Denials are logged to the agent's `agent.log` with format: `[PreToolUse] Permission denied: <tool-name> (<params>)`

**State write side effect**: PreToolUse fires before every tool call, so the path-check handler also writes `state: "running"` to the agent's `meta.json` (via `writeAgentState()`). This flips state out of `waiting` when Claude resumes after a background-tool completion. PreToolUse is used (rather than PostToolUse) because it cannot race with Stop — Stop fires after the final tool call has completed, so a late PostToolUse could overwrite a legitimate `complete`/`stopped` state. Skipped for `@system` (no `meta.json`).

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
| `waiting` | Has manager, background tasks active (`⏵⏵.*·\s\d+\s` in last 15 lines of tmux) | No action (agent is working via background tasks — see §8.5.1) |
| `waiting` | Has manager, no background tasks, at least one direct child with `meta.state === "running"` OR `isRecentlyCreated(created_epoch)` | No action (child still working — see §8.5.1) |
| `waiting` | Has manager, no background tasks, no active children | **Notify manager** — sends "[hook]: Your subtask <id> is now waiting for input" |
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
| `{{pathIsolation}}` | Rendered Path Isolation section (from `buildPathIsolationSection()`, includes allowedPaths if defined) |

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
**Matcher**: `Task|Agent|TaskCreate|Bash|AskUserQuestion`
**Hook type**: PreToolUse

Intercepts Claude Code's Task, Agent, TaskCreate, AskUserQuestion, and Bash tools and redirects/restricts them in the ib system instead:

1. **AskUserQuestion denial**: Always denied. Managers (and primary Claude) are told to use `ib ask "question"` — which routes through the dashboard's QUESTIONS pane and the question-acknowledgement flow — instead of Claude Code's built-in multi-choice prompt. Leaf agents are told to report to their manager instead of asking the user directly.
2. **Leaf agent denial**: If Task/Agent/TaskCreate is called from a leaf agent (an agent whose type has `canSpawnChildren: false`, detected via CWD + `meta.json`), denies with "Workers cannot create tasks or spawn sub-agents"
3. **Busy-wait denial**: Bash commands whose purpose is to busy-wait/poll for a sub-agent are denied by the detector wherever this hook runs. The detector itself is identity-independent (it does not branch on agent type), but the SHIPPED coverage is whatever roles actually get the hook installed — in production that is managers and coordinators (spawned workers do not get the intercept hook; see install scope below). Matched conservatively: a command that is or starts with `sleep <number>`, or a `while`/`until` loop whose body contains `sleep`. The agent is told to emit `WAITING` and let the watchdog notify it when a sub-agent completes or needs input (§8.5 / §8.5.1) rather than spinning tokens. Ordinary Bash (and commands that merely mention "sleep", e.g. `grep sleep file`) passes through. This is why `Bash` is in the matcher for regular agents, not just coordinators.
4. **Only redirects `Task`, `Agent`, `TaskCreate`, and `AskUserQuestion`** (and busy-wait Bash, above) — all other tools, including ordinary Bash, pass through
5. **Skip for certain subagent_types**: `Bash`, `statusline-setup`, `claude-code-guide`, `meta-agent`, `ib-merge` pass through unintercepted
6. **Model validation**: Only `sonnet`, `opus`, `haiku`, or empty string are allowed
7. **Spawn behavior**:
   - When called from an agent context: spawns a `--type worker` with the calling agent as `--manager`
   - When called from primary Claude: spawns a manager (no `--type worker`)
8. **Output**: Rewrites the Task invocation to a `claude-code-guide` subagent that simply reports the spawned agent ID

This hook is installed for spawning agents (managers, when the main repo's settings already have the intercept hook installed) and for coordinators (system + per-repo). The hook redirects `Task`, `Agent`, `TaskCreate`, and `AskUserQuestion` tool calls, and additionally denies busy-wait Bash for every agent type that has the hook (which is why `Bash` is in the matcher for regular agents, not only coordinators). For spawning agents, Task/Agent/TaskCreate are intercepted and spawn ib workers. If a leaf agent reaches this hook, those three are denied with "Workers cannot create tasks or spawn sub-agents." `AskUserQuestion` is denied for all callers regardless of role. The hook matcher includes `TaskCreate` so it fires for that tool in addition to `Task` and `Agent` (see §2.2).

### 6.5 Permission Denied Hook (PermissionRequest)

**Command**: `ib hook-permission-denied <agent-id>`
**Matcher**: `*`
**Hook type**: PermissionRequest

Fires when Claude requests permission for a tool that isn't auto-allowed. Simply logs `[PermissionRequest] Tool denied: <tool-name>` to `agent.log`. Cannot override permissions — PermissionRequest hooks are informational only. Always exits 0 with no stdout output. [^callout-permission-denied]

[^callout-permission-denied]: **Bash/TS divergence.** The bash `ib` does not have a handler for the `hook-permission-denied` subcommand — the command hits the "Unknown command" default case and exits 1 with an error to stderr. Since PermissionRequest hooks are informational only and Claude Code ignores non-zero exits from them, this means the bash version silently fails to log permission denials. The TS implementation properly handles the command and logs to `agent.log`.

### 6.6 Mark Running Hook (UserPromptSubmit)

**Command**: `ib hook-mark-running <agent-id>`
**Matcher**: (none — fires on UserPromptSubmit)
**Hook type**: UserPromptSubmit

Writes `state: "running"` to the agent's `meta.json` the instant input arrives. This covers the case where another agent sends a message via `tmux send-keys` (e.g. a `notify_manager` from a child) — without this hook the recipient would stay labeled `waiting` until its next Stop hook fires. PreToolUse covers the post-background-tool case (see §6.1).

**Terminal-state guard**: Reads the current `state` from `meta.json` first; bails if it is `complete` or `stopped`. UserPromptSubmit can in theory fire after Stop, and we never want to resurrect a terminal state. No-op when `meta.json` is missing or unparseable. No logging.

### 6.6.1 Inject Timestamp Hook (PostToolUse)

**Command**: `ib hooks inject-timestamp`
**Matcher**: `*` (fires after every tool call)
**Hook type**: PostToolUse

Injects the current wall-clock time into the agent's context after each tool call, as `additionalContext` of the form `Current time: 2026-05-29 14:32:07 CDT (epoch 1748547127)` — human-readable local time with timezone abbreviation plus the raw epoch in seconds. Claude only ever gives a conversation a coarse session-level timestamp; this gives the agent a per-message sense of elapsed wall-clock time. Because PostToolUse `additionalContext` is written into the transcript, the timestamps persist for the rest of the conversation (until a compaction) and accumulate into a rough timeline.

**Opt-in**: Gated behind the `hooks.injectTimestamp` config key (default `false`). The hook entry is always present in regular agents' `settings.local.json`, but the body short-circuits (no output, exit 0) unless the config is enabled — so toggling the config takes effect on already-running agents without re-spawning them. Also stays silent if CWD is not inside an agent worktree (defense-in-depth) or if stdin is not valid JSON.

**Scope**: Installed for regular agents only (via `buildHooksBlock({ includeTimestamp: true })`). The system coordinator and per-repo coordinators do not get it. Distinct from the global `inject-status` hook (§6.7), which targets the *primary* Claude session with an agents overview rather than agent sessions with a timestamp.

### 6.7 Global Hooks (installed in ~/.claude/settings.json)

These are optional hooks that the user installs globally:

- **Main-path hook** (`ib hooks main-path`): PreToolUse hook on `Bash` matcher that prevents the primary Claude from `cd`-ing into agent worktrees. Only checks Bash `cd` commands — allows Read/Write/Edit to worktree paths. Resolves relative paths via `cwd` from stdin JSON. Exits 0 (allow) or 2 (deny with JSON written to stdout).
- **Intercept-task hook** (`ib hooks intercept-task`): PreToolUse hook on `Task|Agent|TaskCreate|Bash|AskUserQuestion` matcher (global version, enables task/agent/TaskCreate interception, AskUserQuestion denial, and busy-wait Bash denial for all repos). `Bash` is in the matcher so the busy-wait detector fires; ordinary Bash still passes through.
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
| `model` | string | `"opus"` | Default Claude model for new agents — the final fallback before `"opus"` for non-coordinator agents. Full resolution order at spawn time (most-specific wins): `--model` CLI flag → `<type>.md` `model` → `_non_coordinator.md` `model` (non-coordinator agents only) → `_all.md` `model` → config `model` (non-coordinator agents only) → `"opus"`. The agent-type layer files all override this config key; a blank `model:` in a layer is skipped (see §2 item 4). Coordinators deliberately skip this fallback — the coordinator agent-type file is authoritative for coordinators. |
| `effort` | string | `"xhigh"` | Default reasoning-effort level for new agents (`low\|medium\|high\|xhigh\|max`) — the final fallback before `"xhigh"` for non-coordinator agents. Resolved by the exact same chain and gating as `model`: `--effort` CLI flag → `<type>.md` `effort` → `_non_coordinator.md` `effort` (non-coordinator agents only) → `_all.md` `effort` → config `effort` (non-coordinator agents only) → `"xhigh"`. Threaded to the CLI as Claude's `--effort <level>` or codex's `model_reasoning_effort` (codex maps `xhigh`/`max` → `high`; see §18). Coordinators skip this fallback for the same reason as `model`. |
| `fps` | number | `10` | TUI screen refresh rate (frames per second) for `ib watch`. |
| `createPullRequests` | boolean | `false` | When `true`, agents are instructed (via their prompt) to create a pull request upon completing their work. |
| `allowAgentQuestions` | boolean | `true` | When `false`, the `askQuestion` (`ib ask`) command returns an error, blocking top-level manager agents from posing questions to the user. (`acknowledgeQuestion` is the user-facing command to mark a question answered and does not check this flag.) |
| `autoCompactThreshold` | number | (none) | Context window usage percentage (0–100) above which the watchdog automatically sends `/compact` to the agent's tmux session. When absent (the default), auto-compact is disabled. |
| `externalDiffTool` | string | (none) | External diff viewer command used by the TUI (`ib watch`). Read from `~/.itsybitsy/config.json` at startup via `readConfig()`; written back via `writeConfig()` when changed in the settings dialog. When absent or empty, the diff action is disabled. |
| `hooks.injectStatus` | boolean | `true` | When `false`, the `inject-status` UserPromptSubmit/PostToolUse hook exits immediately without injecting agent status into the Claude context. |
| `hooks.statusVisible` | boolean | `true` | When `true` (and `hooks.injectStatus` is also `true`), the status injection hook also emits a `systemMessage` field so the injected summary appears visibly to the user in the Claude UI. When `false`, status is injected as silent `additionalContext` only. |
| `hooks.injectTimestamp` | boolean | `false` | When `true`, the `inject-timestamp` PostToolUse hook (installed in regular agents only) injects the current wall-clock time into the agent's context after every tool call. When `false` (the default), the hook exits immediately without injecting. See §6.6.1. |

**Deprecated keys**: All permission list keys (and the former `coordinator.model`) have been moved out of `config.json` into agent type layer files:

| Deprecated key | New location |
|---|---|
| `coordinator.model` | `~/.itsybitsy/agent-types/coordinator.md` frontmatter (`model:` field) |
| `permissions.all.allow/deny` | `~/.itsybitsy/agent-types/_all.md` frontmatter |
| `permissions.repo.allow/deny` | `~/.itsybitsy/agent-types/_non_coordinator.md` frontmatter |
| `permissions.coordinator.allow/deny` | `~/.itsybitsy/agent-types/coordinator.md` frontmatter |
| `permissions.manager.allow/deny` | `~/.itsybitsy/agent-types/manager.md` frontmatter |
| `permissions.worker.allow/deny` | `~/.itsybitsy/agent-types/worker.md` frontmatter |

If any of these keys remain in the config file, a deprecation warning is shown at `ib watch` startup pointing to the correct replacement file.

### 7.3 Permission Resolution

For a given agent, `buildAgentSettings()` constructs `<agent-dir>/repo/.claude/settings.local.json` by merging permissions from four sources. See §2.3 for the full details and exact file paths.

Summary:

1. **`<repo>/.claude/settings.json`** — base project allow list (deny entries NOT inherited)
2. **Hardcoded mandatory** — ib commands, git operations, filesystem inspection, Claude Code tools
3. **`~/.itsybitsy/agent-types/_all.md`** — frontmatter `permissions.allow/deny` applied to ALL agent types
4. **`~/.itsybitsy/agent-types/_non_coordinator.md`** — frontmatter `permissions.allow/deny` applied to every non-coordinator type (skipped for coordinators)
5. **`~/.itsybitsy/agent-types/<type>.md`** — `permissions.allow/deny` from type frontmatter (coordinator-specific permissions live here, in `coordinator.md`)
6. Deduplicate all allow/deny lists

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
3. **All known keys are listed**, including those not present in the config file. The full key list matches `CONFIG_KEYS` in `config.ts`: `maxAgents`, `model`, `createPullRequests`, `allowAgentQuestions`, `autoCompactThreshold`, `externalDiffTool`, `hooks.injectStatus`, `hooks.statusVisible`, `coordinator.imessage`. (Permission list keys have moved out of `config.json` into agent type layer files — see §2.3. The former `coordinator.model` key now lives in `~/.itsybitsy/agent-types/coordinator.md` as `model:`.)
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
4. **Array keys rejected**: No `string[]` keys are currently defined in `CONFIG_KEYS` (permission lists were migrated out in Phase 50 — see §2.3). Historically this rule rejected such keys and directed users to `ib config add` / `ib config remove`; it remains in the schema for future expansion.
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
2. **Array keys only**: No `string[]` keys are currently defined in `CONFIG_KEYS` — all former permission-list keys moved out of `config.json` into agent-type layer files (see §2.3). The command remains in the schema for future expansion; today all keys are rejected with an error directing the user to the appropriate `.md` file.
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

Per-agent watchdogs do not use a watchdog lock file for state detection, and there is no global watchdog. (The watchdog does acquire the per-session **message-delivery** lock — `.outbox.lock` — while draining that agent's outbox; see below and §4.1.1. That lock is unrelated to state monitoring.)

**Outbox drain (single tmux writer)**: [^note] **TypeScript only.** The per-agent watchdog is the single owner of writes to its agent's tmux session, so it drains the per-agent outbox queue (`outbox.jsonl`, §4.1.1). It drains at the top of every 5 s poll tick (before state handling) AND on an `fs.watch` event on the agent directory (debounced ~50 ms) so delivery feels instant. Drain triggers are coalesced (a redundant trigger while one is queued/running is dropped), and against other processes the drain is serialized by the per-session file lock. The watchdog ALSO makes its own bare keystroke writes — the rate-limit-bypass Enter and the permission auto-accept Enter — which bypass `deliverMessage` and the file lock; those are serialized against the drain by a per-agent **in-process async mutex** (`runSessionExclusive`, keyed by agent id) that wraps both the drain and every bare Enter, so a drain and a bare write can never overlap in either direction (a drain in flight blocks the Enter, and an Enter in flight blocks the drain). If `fs.watch` is unavailable/throws, the watchdog falls back silently to per-tick draining. `POLL_INTERVAL_MS` (state detection cadence) is unchanged. When the watchdog exits (worktree removed, or tmux gone >10 s) it stops the watcher and clears the debounce timer.

**State resolution per tick**: The watchdog resolves the agent's effective state on each 5-second tick using the same resolution order as consumers (§1.3):
1. No tmux session → `stopped` (or `creating` if within grace period)
2. Tmux "Compacting conversation" in last 5 lines → `compacting`
3. Tmux rate limit patterns in last 15 lines → `rate_limited`
4. Stored `meta.state === "waiting"` AND tmux shows background shells (`⏵⏵.*·\s\d+\s` in last 15 lines) → `running` (see §8.5.1). Scoped strictly to `waiting` — not applied to `complete` or `running`.
5. Read `state` from meta.json → `running`, `waiting`, or `complete`

**Monitoring behaviors by state:**

| State | Action |
|-------|--------|
| `waiting` | Increment waiting counter unless (a) tmux shows background shells OR (b) the agent has at least one direct child with `meta.state === "running"` OR `isRecentlyCreated(created_epoch)` — in which case suppress BOTH `notifyManager` AND `notifySpawner` and pause the counter (neither increment nor reset; `notifyInterval` is preserved). Otherwise, when counter reaches the notification threshold, notify manager: "[watchdog]: Your subtask <id> recently started waiting for input". Uses exponential backoff: initial threshold 30s (6 polls), doubles after each notification, capped at 64 minutes. See §8.5.1. |
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

### 8.5.1 Work-in-flight suppression

We suppress upward notification of a waiting agent when that agent has work in flight. "Work in flight" means one of:
1. **Direct background shell** — the agent's own tmux footer shows `⏵⏵.*·\s\d+\s` (e.g., `⏵⏵ accept edits on · 1 shell`), OR
2. **Direct active child** — the agent has at least one immediate child (`meta.manager === parentId`) whose `meta.state === "running"` OR which is within the `isRecentlyCreated` grace period (i.e., still `creating`).

"Transitive" suppression is bounded to this one-level walk. We do NOT recurse into grandchildren to determine a parent's suppression status; the `running`/`creating` check on direct children is sufficient because each layer's watchdog independently applies this guard. If a grandchild is running, the child-manager will have its own direct active child and suppress its own notification; that upward silence propagates naturally without the parent ever needing to look past its immediate children. Critically, `waiting` and `complete` children are **not** "work in flight" — the top of a parked chain must still be told, and `complete` children need user merge/kill.

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

When a repo header is selected, the dashboard auto-switches the pane mode to **REPO** (a full-width mode in `FULL_WIDTH_MODES` — see §8.13). REPO mode renders across the entire main area at `mainWidth` (the same width the system coordinator and per-repo coordinators use — see §13.8), not just the right pane. The previous pane mode is saved; selecting an agent or coordinator afterward restores it. If the saved mode would render empty content (ERRORS with no errors, QUESTIONS with no questions), it falls back to AGENT LOG instead. REPO mode is skipped during `p`/`n` pane cycling, so the only way to reach it is via repo-header selection.

The repo info content shown in REPO mode (and in the sidebar info panel below the agent tree) always includes:

- **Repo name** with a disclosure triangle (▾ if it has agents, ▸ if empty)
- **Path** — always shown, even when the repo has no agents. The path is rendered as a terminal **OSC 8 hyperlink** using the `file://` scheme (e.g., `\x1b]8;;file:///Users/me/project\x07/Users/me/project\x1b]8;;\x07`), making it clickable in terminals that support OSC 8 (Ghostty, iTerm2, etc.). Clicking opens the path in Finder. Special characters in the path (`%`, space, `#`, `?`) are percent-encoded in the URI portion; the display text shows the raw path.
- **Agent count** and per-state breakdown (e.g., `running: 2`, `waiting: 1`)

The path is sourced from the `repoPath` field on the `repo-header` FlatEntry, which is always available regardless of whether agents exist.

**OSC 8 truncation safety:** Because `truncateToWidth` may drop the closing OSC 8 sequence when truncating long lines, all lines in the non-wrapping render branch pass through `closeOsc8()`, which detects unclosed hyperlinks and either appends the close tag or strips partial OSC sequences left by mid-URI truncation. The wrapping render branch (AGENT LOG, QUESTIONS, etc.) also applies this fix.

### 8.12 Ghostty Integration

Two keybindings open a new Ghostty terminal window. They split responsibility along "open the directory" vs. "attach to the Claude tmux session". The system coordinator has no worktree directory, so `G` and `C` collapse to the same behavior when it is selected — both attach to the `ib-coordinator` tmux session.

**`G` — open the repo / worktree directory**

- **Agent selected**: Opens Ghostty with a fresh login shell in the agent's worktree directory (`cd <worktree> && exec bash -l`). If the worktree path doesn't exist or isn't a directory (e.g., the worktree was removed or `worktree: false`), falls back to `agent.repoPath`. The `w` keybinding (open the same directory in Finder) uses the identical fallback rule, so `G` and `w` resolve to the same path for any given agent.
- **Repo header selected (no agent)**: Opens Ghostty with a fresh login shell in the repo's directory.
- **System coordinator selected**: Opens Ghostty attached to the `ib-coordinator` tmux session.
- **Nothing selected**: Shows a notice ("No agent or repo selected").

**`C` — open the Claude tmux session**

- **Agent selected**: Opens Ghostty attached to the agent's tmux session (`tmux attach -t <session>`). The tmux `window-size` option is set to `latest` so the pane resizes to match Ghostty's dimensions. Requires the agent to have an active tmux session.
- **Repo header selected (no agent)**: Opens Ghostty attached to the per-repo coordinator's tmux session if one exists. If the repo has no coordinator, shows a notice ("No coordinator tmux for this repo"). This parallels `G`'s repo-header behavior, which opens the repo's directory.
- **System coordinator selected**: Opens Ghostty attached to the `ib-coordinator` tmux session.
- **Nothing selected**: Shows a notice ("No agent selected").

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

A **permissions editor** sub-dialog exists in the Config tab code for historical reasons, but its target config keys (`permissions.all.*`, `permissions.repo.*`) were removed from `CONFIG_KEYS` when permission lists migrated into agent-type layer files (see §2.3). The UI is retained as defensive dead code and is no longer reachable through normal navigation. All permission edits now happen by editing the corresponding `.md` file directly: `~/.itsybitsy/agent-types/_all.md`, `~/.itsybitsy/agent-types/_non_coordinator.md`, or per-type files (`manager.md`, `worker.md`, `coordinator.md`). Changes take effect for newly created agents — existing agents' `settings.local.json` is not modified retroactively.

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
3. Create a tmux session named `ib-coordinator` with working directory `~/.itsybitsy/`
4. Start Claude Code inside the session in interactive mode (`claude --model <model>` on fresh, `claude --resume <id> --model <model>` on resume — where `<model>` is resolved by walking the precedence chain `~/.itsybitsy/agent-types/coordinator.md` `model:` > `~/.itsybitsy/agent-types/_all.md` `model:` > `claude:opus` (see §12.5)). The tmux session is launched with `bash` as its command (i.e. `tmux new-session -d -s ib-coordinator -c <home> bash`) so the pane always runs bash regardless of the user's default `$SHELL`. The single `tmux send-keys` call carries the full launch line, run via `Bun.spawn(["tmux", "send-keys", "-t", "ib-coordinator", "<launch-line>", "Enter"])`. All tmux interactions use `Bun.spawn` with array arguments — never shell strings. **Note**: The `-p` flag is NOT used because it runs Claude in non-interactive print mode (exits after one response). The system coordinator must run as an interactive session to accept ongoing input. No positional prompt arg is passed — the prompt body is delivered by the SessionStart hook (§12.1.5).

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
  ⚙ agent-a1b2c3d4   running  2m
▾ muse-ios
  ⚙ agent-c9d0e1f2   complete  1h
```

Per-repo coordinators are not shown as tree rows (see §12.2.5) — they are surfaced via REPO mode when the repo header is selected.

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
│   ⚙ agent-a1b2  running 2m  │                                   │
│ ▾ muse-ios                   │                                   │
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
│   ⚙ agent-a1b2  running 2m  │ itsybitsy    agent-a1b2c3d4  wkr  │
│ ▾ muse-ios                   │ muse-ios     muse-ios        coord │
│   ⚙ agent-c9d0  complete 1h │ muse-ios     agent-c9d0e1f2  wkr  │
├──── Info ────────────────────│                                   │
│ System Coordinator           │                                   │
├──────────────────────────────┴───────────────────────────────────┤
│ status bar                                                       │
└──────────────────────────────────────────────────────────────────┘
```

Per-repo coordinators are not shown as tree rows in the sidebar. They DO appear in the DASHBOARD-view system overview table (which lists all agents including coordinators), and are surfaced in the main area when their repo header is selected (REPO mode, §8.11, §12.2.5).

When any other agent or repo header is selected, the layout reverts to the normal two-section sidebar (tree + info) with the standard split-pane main area.

The system coordinator panel uses its own `TmuxPoller` instance (separate from the agent tmux poller) to capture output from the `ib-coordinator` session at ~1s intervals.

#### 12.1.5 Session Start Context

The system coordinator boots like every other agent type. Its prompt body comes from the markdown body of `~/.itsybitsy/agent-types/system.md` (auto-restored on first run from the embedded copy of `docs/agent-types/system.md`) and is delivered via the SessionStart hook's `additionalContext` on **every** session start (fresh AND resume). The `claude` launch command takes no positional prompt arg, and no `coordinator-prompt.txt` is written to disk.

The `ib hooks session-start @system` hook (§12.1.7) builds a `SessionContext` with `agentType: "system"` and runs `generateInstructions(ctx)`. That path:
- Prepends `_all.md`'s markdown body (always — `_all.md` applies to every agent).
- Skips `_non_coordinator.md` (whose body covers commit-message etiquette and other things irrelevant to `@system`, which has no Write/Edit/git access).
- Wraps the resulting content in `<ittybitty>…</ittybitty>` (the wrapper is added by `generateInstructions`, not by the markdown file).

Users can customize the prompt by editing `~/.itsybitsy/agent-types/system.md`. The change takes effect on the next coordinator session start.

The default prompt content (from `docs/agent-types/system.md`):

> You are the itsybitsy system coordinator. You manage agents across all registered repos using `ib` commands. You can list agents (`ib list`), send messages to agents (`ib send <agent-id> "message"`), merge (`ib merge`), kill (`ib kill`), create agents (`ib new-agent`), and check status (`ib status`, `ib diff`). You do NOT have access to Read, Write, Edit, or any file tools — only `ib` Bash commands. You coordinate work at the system level — for repo-specific coordination, delegate to per-repo coordinators. To send messages to per-repo coordinators, use `ib send @<repo-name> "message"` (e.g., `ib send @itsybitsy "review the latest PR"`). Do NOT use `ib send @system` — that routes back to you.

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

#### 12.1.7 Hook Installation

The system coordinator's `~/.itsybitsy/.claude/settings.local.json` includes five of the six agent hooks (§6), all keyed to the `@system` sentinel agent ID:

- `PreToolUse` → `ib hook-check-path @system` (path isolation — `~/.itsybitsy/` is its own worktree, so cross-agent and main-repo blocks are no-ops; the allow-list check still runs. The state-write side effect from §6.1 is skipped for `@system` because there is no `meta.json` to write to.)
- `PreToolUse` → `ib hooks intercept-task` (intercepts Task/Agent/TaskCreate, denies AskUserQuestion, blocks shell metacharacters and `--output` in coordinator Bash commands per §12.2.4)
- `PermissionRequest` → `ib hook-permission-denied @system` (logs denials to `~/.itsybitsy/agent.log`)
- `UserPromptSubmit` → `ib hook-mark-running @system` (no-op for `@system` — there is no `meta.json` to update; the hook entry is installed for uniformity with regular agents and to keep `health-check`'s leaked-hook scan symmetric)
- `SessionStart` → `ib hooks session-start @system` (delivers `system.md`'s markdown body, prefixed with `_all.md`, via `additionalContext` on every session start — see §12.1.5)

The Stop hook is intentionally **not** installed — the system coordinator's state detection lives in `detectSystemCoordinatorState()` (§12.1.6), which polls tmux output and does not need a Claude-driven idle signal. The `@system` sentinel is the system coordinator's identity at every hook callsite; it is not a valid agent ID per `isValidAgentId()` (it begins with `@`), but the four hook entry points (`hook-check-path`, `hook-permission-denied`, `hook-mark-running`, and the optional `agentIdArg` of `hooks session-start`) accept the literal `@system` because it is hardcoded into the coordinator's settings file by `writeCoordinatorFiles()` and is not user input. `ib hook-status` does not accept `@system` — the Stop hook is omitted, so the path is unreachable.

Existing system coordinator sessions must be restarted (e.g., via the dashboard `x` action on the system coordinator) to pick up new hook configurations after upgrading; `ensureSystemCoordinator` only writes `settings.local.json` when the tmux session is absent.

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
7. Defaults to the model resolved by walking `~/.itsybitsy/agent-types/coordinator.md` `model:` > `~/.itsybitsy/agent-types/_all.md` `model:` > `claude:opus` when no explicit `--model` is provided — overridable with `--model <model>` on `ib new-agent --type coordinator`. The user's global `model` config key is NOT consulted on the coordinator path (see §12.5).
8. Otherwise follows the standard agent creation flow (§1.1)

**One-per-repo constraint**: `checkCoordinatorExists(repoPath)` scans all agent directories in `.ittybitty/agents/` for any agent with `coordinator: true` in meta.json. If a coordinator already exists, `ib new-agent --type coordinator` prints `"Coordinator already exists for <repo-name>"` and exits 0 (idempotent no-op). If a non-coordinator agent already has the repo basename as its ID (collision), a random 4-char hex suffix is appended to the coordinator's ID. There is exactly one coordinator per repo, never more. Archived coordinators (in `.ittybitty/archive/`) do not block creation — "active" means a directory in `.ittybitty/agents/` (not `.ittybitty/archive/`). A stopped or paused coordinator whose directory is still in `agents/` DOES block creation — only archiving removes the block.

**No auto-spawn on watch startup**: Per-repo coordinators are NOT auto-spawned when `ib watch` launches. Only the system coordinator is auto-spawned (§12.1.2). Per-repo coordinators are created manually via one of: (a) `ib new-agent --type coordinator` from the CLI, (b) pressing `R` on a repo header in the TUI (which spawns a coordinator if none exists, or resumes a stopped one), or (c) the system coordinator running `ib new-agent --type coordinator` from within a repo directory.

**Auto-close on exit**: When `ib watch` exits, per-repo coordinators are paused (§1.5 — kill Claude process + tmux session, preserve worktree/meta.json/branch; paused coordinators show as `stopped` in state detection since their tmux session no longer exists) **only if** no other `ib watch` instance is running. This uses the same PID-based `~/.itsybitsy/coordinator.refs` file used by the system coordinator (§12.1.2) — a single shared file governs both the system coordinator kill and all per-repo coordinator pauses. When no live PIDs remain, the system coordinator session is killed and per-repo coordinators across **all registered repos** (from `~/.itsybitsy/repos.json`) are paused. If other instances remain, all coordinators are left running.

**Resume**: Paused coordinators can be resumed via `ib resume <repo-basename>` (standard §1.6 resume flow) or by pressing `R` on the repo header in the TUI. The TUI's `R` handler checks `checkCoordinatorExists()` — if a coordinator exists and is stopped/complete, it resumes it; if none exists, it spawns a new one.

**Children**: Agents spawned by a per-repo coordinator (via `ib new-agent --type worker` from within the coordinator's session) will have `manager: "<repo-basename>"` in their meta.json (where `<repo-basename>` is the coordinator's agent ID). This means `buildAgentTree()` will correctly parent them under the coordinator, and `ib nuke <repo-basename>` will recursively kill them.

**Killing/Archiving**: Per-repo coordinators follow the standard kill/archive flow (§1.4, §1.7). `ib kill <repo-basename>` kills only the coordinator itself (standard §1.4 behavior). To recursively kill a coordinator and all its children, use `ib nuke <repo-basename>` (§1.8). The `manager: "<repo-basename>"` field in children's meta.json links them to the coordinator for the nuke traversal.

**Expanded same-repo authority**: Per-repo coordinators may run `ib kill` and `ib reassign` on ANY non-coordinator agent within their own repo, regardless of the target's `manager` field. This is enforced in `checkIbCommandAccess` (src/hooks/agent-path.ts) by checking the caller's `coordinator: true` flag in its own meta.json before falling back to the standard manager/spawner check. Other manager-only operations (`nuke`, `merge`, `resume`, `pause`) still require the standard manager/spawner relationship. Cross-repo `kill`/`reassign` is not permitted — a coordinator in repo A cannot act on agents in repo B. Coordinators cannot kill or reassign other coordinators via this bypass (the target's `coordinator: true` flag disqualifies it from the bypass and falls through to the standard check).

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
      "TodoWrite", "ToolSearch"
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

**Bash permission pattern and shell metacharacters**: Claude Code's `Bash(<command>:*)` permission patterns match based on command prefix — `Bash(ib:*)` allows any command starting with `ib`. This means a chained command like `ib list && cat secret.txt` would match `Bash(ib:*)` because the full string starts with `ib`. **Mitigation**: The existing `intercept-task` hook (§6) is extended to reject Bash tool calls from coordinator sessions that contain shell-active metacharacters (`;`, `&&`, `||`, `|`, `>`, `>>`, `<`, `` ` ``, `$(`, `$'`, `\n`, `\r`, plus subshell `(...)`) anywhere in the command. Newlines and carriage returns are included because they act as command separators in bash. `$'` (ANSI-C quoting) is included because `$'\x0a'` encodes a newline without using any other blocked characters — bash interprets it as a literal newline at execution time, splitting the command (e.g., `ib list $'\x0a'cat /etc/passwd`). Additionally, the hook blocks `--output` (and `--output=`) in git commands from coordinator sessions — `git diff --output=<path>`, `git log --output=<path>`, and `git show --output=<path>` can write files without shell metacharacters, bypassing the Write/Edit deny. The check is a simple substring match for `--output` in the raw command string when the command starts with `git`. The hook inspects the `command` field from the Bash tool's input JSON — this is the unquoted, uninterpreted command string that Claude generated. **Quote- and heredoc-aware**: the metacharacter check is implemented as a small lexical pass (`findShellMetachar`) that tracks single-quote, double-quote, and heredoc state so literal metacharacters inside `'…'`, `"…"`, `<<'EOF' … EOF`, `<<"EOF" … EOF`, or `<<\EOF … EOF` are allowed — those characters are shell-inert in that context, so blocking them just blocks legitimate message text (e.g. `ib send agent 'replace <NAME> in the `whoami` example'`). Inside double quotes, command substitution (`` ` `` and `$(`) and `$'` ANSI-C quoting remain blocked because they are still shell-active there. Inside an unquoted-delimiter heredoc body (`<<EOF`), `` ` `` and `$(` remain blocked because the body still undergoes parameter and command-substitution expansion. Bare `${VAR}` parameter expansion is allowed because plain parameter expansion cannot run arbitrary code — any `$(` or backtick nested inside `${…}` is still caught when the lexer walks into those characters. When the heredoc terminator line is reached, the newline that ends the terminator line is itself a command separator in bash — any non-whitespace content on the lines after the terminator is rejected as a second command (this closes the bypass where a quoted-delimiter heredoc body would otherwise be followed by an unguarded second command on the next line). For the tab-stripping form `<<-EOF`, only leading TABs are stripped from body lines and the terminator, matching bash semantics — a terminator line indented with spaces does NOT terminate. This is a defense-in-depth layer on top of Claude Code's prefix matching — the primary trust boundary is that coordinators are Claude agents following instructions, and the hooks catch edge cases where the agent might attempt to circumvent its role. **Security gate**: This intercept-task extension MUST be implemented and deployed before any **per-repo** coordinator goes live — without it, the `Bash(ib:*)` permission has a known bypass via shell metacharacters. The system coordinator is exempt from this gate: it has no meta.json (so the intercept-task hook cannot detect it), but it also has no Read/Write/Glob/Grep/LS tools and runs in `~/.itsybitsy/` (not a code repository), so a metacharacter bypass can only access `ib` commands and the limited filesystem at `~/.itsybitsy/`. This is an acceptable risk — the system coordinator's deny list prevents meaningful file access.
- **No WebFetch/WebSearch** — coordinators don't need internet access
- **No KillShell** — coordinators don't run long-lived shell processes

These permissions are constructed by a new `buildCoordinatorSettings()` function (parallel to the existing `buildAgentSettings()`). Per-repo coordinator permissions are customized by editing the `permissions.allow` / `permissions.deny` frontmatter in `~/.itsybitsy/agent-types/coordinator.md`. **Merge semantics**: `_all.md` frontmatter entries (applied to every agent type, including coordinators) and the coordinator type file's own frontmatter `allow` entries are appended to the hardcoded allow list. `_non_coordinator.md` is NOT merged for coordinators. The hardcoded deny list always takes precedence — `buildCoordinatorSettings()` enforces this at construction time by filtering out any user-configured `allow` entries that appear in the hardcoded `deny` list before building the final permissions object. Adding `"Write"` to `coordinator.md`'s `permissions.allow` is silently dropped because `Write` is in the hardcoded deny list. This prevents users from accidentally granting write access to coordinators.

The former config keys `permissions.coordinator.allow` and `permissions.coordinator.deny` have been removed; if present in `~/.itsybitsy/config.json`, a deprecation warning is shown at `ib watch` startup directing users to migrate entries into `~/.itsybitsy/agent-types/coordinator.md` frontmatter.

#### 12.2.5 Display

Per-repo coordinators are **not rendered as rows in the agent tree** — `flattenAgentTree()` filters out any agent with `coordinator: true` before emitting tree entries (src/agents.ts). Only the system coordinator and regular agents appear as selectable rows. The repo header itself is the access point for the per-repo coordinator: selecting it surfaces the coordinator in the main area (see below). The system coordinator is the only coordinator shown directly in the tree:

```
◆ coordinator       running  5m       (system coordinator)
▾ itsybitsy
  ⚙ agent-a1b2c3d4   running  2m
  ⚙ agent-e5f6a7b8   waiting  10m
▾ muse-ios
  ⚙ agent-c9d0e1f2   complete  1h
```

When a repo header is selected, the dashboard locates the per-repo coordinator (`watcher.lastAgents.find(a => a.repoPath === ... && a.meta.coordinator)`) and wires it up: the pane mode auto-switches to REPO (§8.11, §8.13), and the main area renders at full main width (`mainWidth`, the same width the system coordinator uses — see §13.8). The repo info summary occupies the top portion and the per-repo coordinator's tmux output occupies the bottom portion of the full main area. Choosing an agent or the system coordinator afterward restores the previous pane mode and the standard split-pane layout. The per-repo coordinator's tmux session is sized to `mainWidth`, matching the system coordinator's width — it is not a right-pane-scoped view.

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
| `ib send @system "msg"` | System coordinator | Delivers directly to the `ib-coordinator` tmux session via `tmux send-keys`, identical to how messages are delivered to any other agent (§12.3.3). The `--from` flag value is rendered as a `[sent by agent <id>]:` prefix (or `[sent by @<sentinel>]:` for `@`-prefixed sentinel senders — see §4.1 step 4). Errors with exit code 1 if the coordinator session is not running. Output: `"Sent to system coordinator"` on success. |
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

The system coordinator has no agent ID and cannot be targeted by any standard CLI command (only via `@system` in `ib send`). It is not a regular agent — it has no agent directory, no meta.json, and no entry in any repo's `.ittybitty/agents/`. To send messages to the system coordinator programmatically, use `ib send @system` (§12.3.3).

**Reserved name `coordinator`**: The name `coordinator` is reserved and cannot be used as an agent ID. `newAgent()` rejects any attempt to create an agent with the ID `coordinator` — whether via `--name coordinator`, or because a repo's basename happens to be `coordinator` (in coordinator mode). This prevents confusion: if someone types `ib send coordinator` (without the `@`), they get "Agent not found" rather than silently messaging the wrong target. The old `ib send coordinator` special routing is removed — use `ib send @system` instead.

**Prefix matching caveat**: If a repo is named `agent` and there's also an `agent-a1b2c3d4`, `ib send agent "msg"` is an exact match on the coordinator's ID (exact matches take priority over prefix). But `ib kill agent` also exact-matches the coordinator — there's no separate resolution for management commands vs messaging commands.

#### 12.3.2 TUI Addressing

- **System coordinator**: Select in agent tree → `s` key to send message, or focus coordinator sidebar panel → type in input field
- **Per-repo coordinator**: Select in agent tree → `s` key to send message (same as any agent)
- Both use the standard TUI input flow — no name resolution needed since selection is explicit

#### 12.3.3 System Coordinator Messaging

All messages to the system coordinator — interactive (TUI) and programmatic (`ib send @system`, watchdog, agents) — are delivered the same way: `tmux send-keys -t ib-coordinator -l "<message>"` followed by a separate `tmux send-keys -t ib-coordinator Enter`. The `-l` (literal) flag prevents tmux from interpreting special key sequences in the message text.

`ib send @system` re-uses the same `sendMessage()` path used for any other agent: the chunked send-keys writes, the post-send Enter, and the `[sent by ...]` prefix when a sender is detected (either via `--from` or by `cwd` matching an agent worktree or the system coordinator home — see §4.1). The only difference is that the synthetic recipient has no agent directory, so the recipient-side log/state writes are no-ops (intentional — the system coordinator has no `meta.json` by design). If the `ib-coordinator` tmux session is not running, `ib send @system` errors with exit code 1 and a message instructing the user to start it (typically by selecting it in the dashboard). Messages are not queued.

**Control character sanitization**: Before sending, all non-printable characters must be stripped: newlines (`\n`, `\r`) to prevent injecting multiple inputs, `\x03` (Ctrl-C) to prevent killing the Claude process, `\x04` (Ctrl-D, EOF), `\x1a` (Ctrl-Z, suspend), and `\x1b` (Escape, which could corrupt terminal state or trigger escape sequences). In practice, strip all characters with code points below `0x20` (this includes tab `0x09`, which is intentionally stripped to prevent unexpected whitespace in messages) and also `0x7F` (DEL). The `-l` flag on `tmux send-keys` prevents tmux from interpreting special key names, but the receiving Claude process would still see control characters in its stdin.

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
2. **Per-repo coordinators**: NOT rendered as tree rows — `flattenAgentTree()` filters them out. They are surfaced via the repo header (selecting a repo header auto-switches the main area to REPO mode at `mainWidth` and shows the per-repo coordinator's tmux output there — see §8.11, §12.2.5).
3. **Regular agents**: Listed below their repo header, sorted by creation time (existing behavior).

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

Coordinator model selection lives in `~/.itsybitsy/agent-types/coordinator.md` frontmatter (the `model:` field), e.g.:

```yaml
---
name: coordinator
description: Read-only coordinator that manages agents without writing code
model: claude:opus
---
```

The system coordinator and per-repo coordinator walk the same precedence chain (most-specific wins): `coordinator.md` `model` > `_all.md` `model` > `"claude:opus"`. `_non_coordinator.md` is by definition not consulted for coordinators, `system.md`'s `model:` field is deliberately not consulted on the system-coordinator path (`system.md` carries permissions and prompt body only — the system coordinator's model is sourced from `coordinator.md`, the same file the per-repo coordinator uses), and the user's global `model` config key is intentionally NOT consulted on the coordinator path — the coordinator agent-type file is authoritative, since otherwise a global `model` setting would clobber the coordinator agent-type. A blank `model:` in any layer parses to `undefined` and is skipped, so a more-specific layer with no value does not clobber a real value set by a less-specific layer. Per-repo coordinators can additionally be spawned with `--model <model>` to override. Changing the system coordinator's model requires restarting it (`R` key in TUI when selected, or kill + re-launch `ib watch`) — the agent-type files are read at spawn time.

The former `coordinator.model` config key has been removed; if present in `~/.itsybitsy/config.json`, a deprecation warning is shown at `ib watch` startup pointing to the new location.

Coordinator permissions (allow/deny lists) also live in `~/.itsybitsy/agent-types/coordinator.md` frontmatter, not in the config file. The former `permissions.coordinator.allow` / `permissions.coordinator.deny` config keys have been removed; if present, a deprecation warning is shown at `ib watch` startup.

### 12.6 Affected Files and Modules

The coordinator system touches many modules. This section catalogs the current implementation state.

| Module | Status | Description |
|--------|--------|-------------|
| `src/coordinator.ts` | **Implemented** | System coordinator lifecycle (`ensureSystemCoordinator()`, `releaseSystemCoordinator()`, `restartSystemCoordinator()`), PID-based reference counting, system coordinator permissions/prompt, `sanitizeTmuxInput()`, per-repo coordinator permissions (`buildPerRepoCoordinatorSettings()`), per-repo coordinator prompt (`perRepoCoordinatorPrompt()`), coordinator existence check (`checkCoordinatorExists()`), agent ID generation (`getCoordinatorAgentId()` — returns repo basename). No separate `coordinator-settings.ts` — per-repo settings are in this file. |
| `src/agents.ts` | **Implemented** | `coordinator?: boolean` in `AgentMeta`. `{ kind: "system-coordinator" }` in `FlatEntry`. `flattenAgentTree()` prepends system coordinator entry and filters out per-repo coordinators (`!a.meta.coordinator`) so they do not appear as tree rows under their repo header. |
| `src/ib-commands.ts` | **Implemented** | `newAgent()` extended with `--type coordinator`: uses repo basename as ID (via `getCoordinatorAgentId()`), sets `coordinator: true` in meta.json, one-per-repo validation via `checkCoordinatorExists()`, model sourced from `coordinator.md` agent-type frontmatter, max-agents bypass, coordinator-specific `settings.local.json` with hooks. No special `ib send` routing — standard agent ID resolution handles everything. |
| `src/hooks/session-start.ts` | **Implemented** | Detects `coordinator: true` in meta.json. `generateCoordinatorInstructions()` injects coordinator-specific prompt. Worker instructions correctly use manager's agent ID (repo basename) for `ib send`. |
| `src/hooks/intercept-task.ts` | **Implemented** | `checkCoordinatorBashRestrictions()` blocks shell metacharacters and `--output` in git commands for coordinator sessions. Detects coordinators via `coordinator: true` in meta.json. |
| `src/hooks/agent-path.ts` | **No changes needed** | Per-repo coordinators use standard path isolation. |
| `src/hooks/agent-status.ts` | **No changes needed** | Stop hook writes state normally. |
| `src/config.ts` | **Implemented** | Config keys: `coordinator.imessage`. (`coordinator.model` removed — coordinator model lives in `~/.itsybitsy/agent-types/coordinator.md` frontmatter. `permissions.coordinator.*` removed — coordinator permissions live in `~/.itsybitsy/agent-types/coordinator.md` frontmatter.) |
| `src/watchdog.ts` | **Not yet modified** | Does NOT have coordinator-specific behavior. Treats coordinators identically to regular agents. See §12.2.7. |
| `src/tui/dashboard.ts` | **Implemented** | System coordinator full-width view with TMUX/DASHBOARD toggle, coordinator lifecycle on startup/shutdown, coordinator restart on `R`, input field routing, per-repo coordinator pausing on exit. |
| `src/tui/agent-tree.ts` | **Implemented** | System coordinator as first entry with `◆` icon. Per-repo coordinators are not rendered as tree rows — they are surfaced via the repo header (REPO mode, §8.11, §12.2.5). |
| `src/tui/agent-actions.ts` | **Implemented** | `R` on repo header spawns or resumes per-repo coordinator via `checkCoordinatorExists()`. |
| `src/tui/focus.ts` | **Implemented** | Coordinator focus order: `agent-tree` → `info` → `coordinator`. |
| `src/tui/pane-manager.ts` | **Implemented** | Full-width view when system coordinator is selected. Per-repo coordinator REPO mode with split pane. |
| `src/watcher.ts` | **No changes needed** | Per-repo coordinators are regular agents detected by fs.watch. System coordinator state polled via `getCoordinatorInfo()`. |
| `src/index.ts` | **Implemented** | `ib new-agent --type coordinator` flag handling. `@`-based routing in `ib send`: `@system` delivers directly to the `ib-coordinator` tmux session via `sendMessage()`, `@coordinator` routes to own repo's coordinator, `@<repo-name>` routes to named repo's coordinator, `@<repo-name>/<agent-id>` routes to specific agent in named repo (§12.3.1). Bare agent IDs use standard `matchAgentById()` with own-repo-first resolution. |
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
| **Per-repo coordinator tmux** | `mainWidth` = `terminal_cols - sidebarWidth - 1` (same as the system coordinator) | Computed dynamically | Selecting a repo header, `[`/`]` with sidebar/coordinator focus (via `sidebarWidth` change → `mainWidth` change), terminal resize (SIGWINCH), layout restore. Independent of `splitPaneLeftWidth`. |

**Key invariant**: `splitPaneLeftWidth` and `sidebarWidth` are the two independent inputs; `mainWidth` and `rightPaneWidth` are derived. A sidebar resize changes `sidebarWidth`, which changes `mainWidth` (affecting both the system coordinator and per-repo coordinators — both follow `mainWidth`) but does not change `splitPaneLeftWidth` (agents). A split-pane resize changes `splitPaneLeftWidth` (agents) and `rightPaneWidth` but does NOT change `mainWidth`, so neither the system coordinator nor per-repo coordinators are affected by split-pane resizes — they only react to sidebar resizes and terminal resizes.

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

**Detection**: Parse `<repo>/.claude/settings.local.json`. Scan all hook commands (across all hook types: `PreToolUse`, `Stop`, `PermissionRequest`, `SessionStart`, `UserPromptSubmit`) for patterns matching `ib hook-check-path <id>`, `ib hook-status <id>`, `ib hook-permission-denied <id>`, or `ib hook-mark-running <id>` where `<id>` matches the agent ID format (`agent-[0-9a-f]+` or any string matching `isValidAgentId()`). The `ib hooks intercept-task` and `ib hooks session-start` commands (without agent IDs) are legitimate global/repo hooks and should NOT be flagged.

**Message**: `"Leaked agent hook in .claude/settings.local.json: <command> — this will block tool calls in your Claude session. Remove the hook entry or restore settings from version control."`

#### 14.3.2 Missing Global Hooks (warning)

**What**: The global `~/.claude/settings.json` is missing expected itsybitsy hooks (safety hooks or intercept-task hook).

**Why it's a problem**: Without global safety hooks, agents can access each other's worktrees or the main repo, and task interception won't redirect Task/Agent tool calls to `ib new-agent`.

**Detection**: Read `~/.claude/settings.json` and check for the presence of:
- **Safety hooks** (checked as a group): `ib hooks main-path` (PreToolUse), `ib hooks session-start` (SessionStart), and at least one `ib hooks inject-status` hook (UserPromptSubmit or PostToolUse). If ANY of these are missing, warn.
- **Intercept-task hook**: `ib hooks intercept-task` in PreToolUse (installed with the `Task|Agent|TaskCreate|Bash|AskUserQuestion` matcher). Detection matches on the command only, not the matcher string, so older Bash-less installs still register as installed. Checked separately since it's an optional but recommended hook.

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

## 16. Teams

A **team** is a named, cross-repo group of agents that share a "chat room": a message sent to the team fans out to every member except the sender. Teams let agents from potentially different repos coordinate without each sender having to know and enumerate every recipient's agent ID. The feature is layered entirely on top of the existing message-passing infrastructure (§4) — a team send is a named fan-out over `sendMessage`, so it inherits per-agent serialization (§4.1.1), cross-repo delivery, the `[sent by ...]` prefix machinery, and the `state: "running"` reset for free.

Teams are a **TypeScript-only** feature with no bash reference equivalent.

### 16.1 The `@`-Sentinel Namespace

itsybitsy already addresses non-agent routing destinations with an `@`-prefixed **sentinel** convention (§4.1, §8.5, the watchdog notify path): `@system` resolves to the system coordinator, and `@<repo-name>` resolves to that repo's per-repo coordinator. A sentinel is a *named destination that resolves to one-or-more real recipients* — which is exactly what a team is.

Teams therefore reuse the same **addressing** namespace: a team is addressed as `@<team-name>`, a deliberate generalization of the existing sentinel — from "resolves to 1 coordinator" to "resolves to N members" — not a new syntax. (This is a statement about the user-facing address space only. It does **not** mean teams drop into the existing resolver code for free — the resolver currently hard-errors on unknown `@name` and returns a single recipient; see §16.4 "Resolver integration is net-new code.")

**Why `@` and not `#`:** an earlier design used `#<team-name>`, but `#` begins a comment in POSIX shells, so a bare `ib team add #team agent-id` would have everything from `#team` onward swallowed by the shell. `@` has no shell-metacharacter problem in any position, so `ib send @team "msg"` and `ib team add @team agent-id` both work unquoted.

**Team-name validation (allowlist):** a team name must match a strict character allowlist before it is ever stored or interpolated into a delivery prefix or session-start injection. The allowed character set mirrors `isValidAgentId` / `isValidTmuxSession` in `validation.ts`: ASCII alphanumerics, hyphen, and underscore (`/^[A-Za-z0-9_-]+$/`), non-empty, with a reasonable length cap. This is **required**, not optional, for three reasons: (a) a name containing `/` would collide with the `@<repo>/<agent>` slash-addressing form (§12.3.1); (b) the name is echoed verbatim into the `[sent by … in @<team>]:` prefix typed into a tmux pane and into the session-start injection, so an unconstrained name is an injection vector; (c) the name is used as a JSON object key and in CLI arguments. `ib team create` rejects any name that fails the allowlist. Case is significant for storage but see the case-folding rule below.

**Flat namespace, collision-prevented at creation (the "Option B" rule):** because `@system`, `@<repo-name>`, `@coordinator`, and `@<team-name>` all share one flat `@` namespace, an ambiguous name would otherwise have to be resolved by guessing precedence at send time. Instead, ambiguity is **refused at creation**:

- `ib team create @<name>` fails if `<name>` is a **reserved word**. The reserved set is the **union of three distinct sources**, NOT a single constant — `BARE_RENDERED_SENTINELS` alone is insufficient (it currently contains only `@watchdog`, `ib-commands.ts`). The implementer must reserve, with the leading `@` stripped: (1) the system coordinator id — `SYSTEM_AGENT_ID` (which is `"@system"` in `hooks/shared.ts`; stripping the `@` yields the reserved word `system`); (2) the literal `coordinator` (already hard-refused as a repo name in `registry.ts`, so teams must mirror it); (3) every member of `BARE_RENDERED_SENTINELS` (`ib-commands.ts` — currently the single entry `@watchdog`, reserving `watchdog`). Derive each from its source constant at build time so the spec and code cannot drift; do not hard-code a literal list. (An earlier draft listed `telegram` here — **dropped**: no `@telegram` *send-target sentinel* exists in source; `channels.telegram` is a config key, not an address, so it is not a collision risk.)
- `ib team create @<name>` fails if `<name>` matches the basename **or the configured nickname** of any registered repo (§9, §12.3.1) — because `@<repo>` (by either name) already routes to that repo's coordinator. Both forms must be checked; checking only the basename leaves a nickname collision open. This mirrors `registry.ts`, which already checks both `repoDisplayName(r)` and `r.name` when refusing a colliding repo add/rename.
- **Case sensitivity — collision and storage are case-SENSITIVE**, to match the resolver. Confirmed against `resolveTarget` (`index.ts`): repo lookup uses strict `===` (`repoDisplayName(r) === repoName`), and the registry's own collision checks (`registry.ts`) are likewise `===` — there is no `toLowerCase` anywhere in the resolution or registry-collision path. Team names are therefore stored as entered and matched with `===` for both collision-prevention and resolution. A case-insensitive rule was considered and **rejected**: it would manufacture an asymmetry the rest of the system does not have (a `@Backend` address would not match a `backend` repo under `===` anyway, so there is nothing to shadow case-insensitively), and would silently introduce case-folding nowhere else in the codebase. If case-insensitive addressing is ever wanted, it must be a deliberate cross-cutting change specified in §12.3.1 — not smuggled in through the teams feature.

**Closing the namespace symmetrically (the repo-add side):** create-time prevention on the team side is not sufficient on its own — a repo added *after* a team of the same name would silently shadow the team, because the resolver checks repos before teams. Two acceptable resolutions, and the spec picks the first:

1. **Hard refusal (chosen):** adding a repo (§9) — or setting/changing a repo nickname via `renameRepo` (`registry.ts`, which already refuses nickname collisions against other repos' display-name and basename) — whose basename/nickname would collide with an existing team name is **refused**, exactly as the team-create side is refused. This keeps the flat namespace genuinely collision-free in both directions. The user must rename or delete the team first, or pick a non-colliding repo nickname.
2. *(Rejected)* A soft warning that lets the repo win and shadows the team — rejected because it reintroduces the silent-ambiguity the Option B rule exists to eliminate.

With bidirectional creation-time prevention, the resolver never has to guess. Resolution order for an `@`-target is documented as: `@system` (exact) → `@coordinator` / `@<repo>` (a registered repo's coordinator, by basename or nickname) → a team. Because both create paths refuse collisions, the first two branches can never overlap with the third — but the order is still specified so behavior is defined even if a stale `teams.json` survives a repo rename.

### 16.2 Team Registry State

Teams span repos, so team state cannot live in any one repo's `.ittybitty/` directory. It lives at the user-wide tier alongside `repos.json` and `config.json` (§9, §7):

- **File**: `~/.itsybitsy/teams.json`

```json
{
  "teams": {
    "backend": {
      "created_epoch": 1780115734,
      "created_by": "@system",
      "members": ["agent-a1b2c3d4", "agent-e5f6a7b8"]
    }
  }
}
```

Fields:
- The map key is the bare team name (no `@` prefix; the `@` is the addressing sigil, not part of the stored name).
- `created_epoch`: unix epoch seconds at creation.
- `created_by`: the sentinel or agent ID that created the team (`@system`, an agent ID, or `""` for a human/CLI creation).
- `members`: array of agent IDs. Membership is **by agent ID** — see §16.5 for the lifecycle/ephemerality consequences.

Reads tolerate a missing file (no teams yet → empty map). Writes are atomic (tmp + rename), consistent with how `meta.json` and other user-tier state are written.

**Concurrency / locking (required).** Atomic rename guarantees no *torn* file, but **not** no *lost update*: a bare read-modify-write race (A reads `{m1}`, B reads `{m1}`, A writes `{m1,m2}`, B writes `{m1,m3}` → `m2` is lost) is real here, because `ib team add`/`remove`, lazy send-time pruning (§16.5), and teardown pruning all do read-modify-write on the single shared `teams.json`. Concurrent team mutations are plausible (e.g. the system coordinator adds a member while a worker's teardown prunes it). The outbox solves the analogous problem with `.outbox.lock` (§4.1.1); teams gets the same treatment:

- **Lock file**: `.teams.lock` beside `teams.json` in `~/.itsybitsy/`, an advisory lock acquired via exclusive create (`open(path, "wx")`, O_CREAT|O_EXCL) with backoff-retry and a stale-steal threshold, mirroring `acquireOutboxLock`/`steal` (§4.1.1). Every **unconditionally-mutating** operation (`create`, `add`, `remove`, `delete`, teardown-prune) performs **read → modify → write entirely under the lock**, released in a `finally`.
- **Three classes of access, not two** (resolving the apparent §16.2↔§16.5 contradiction):
  1. **Pure reads** — `ib team list`, resolver lookups, session-start scan: never take the lock. They tolerate a concurrently-rewritten file because the atomic rename guarantees they see either the whole pre- or whole post-image, never a torn one.
  2. **Unconditional mutations** — `create`/`add`/`remove`/`delete`/teardown-prune: take the lock for the whole read-modify-write, as above.
  3. **Conditional mutations (lazy prune)** — `ib roster` and `ib send @<team>` (§16.5): read **unlocked** first; only **if** a dead member is detected do they then acquire the lock, **re-read** inside it (the roster may have changed since the unlocked read), re-compute the prune against the fresh copy, write, and release. The common case (no dead members) never touches the lock; the rare case (a prune is actually needed) is correctly serialized. This is what reconciles "`ib roster`/`ib send` are readers" (§16.2) with "they lazy-prune" (§16.5) — they are readers that *occasionally* upgrade to a locked write.
- This is a single global lock (one `teams.json`), unlike the per-agent outbox lock. Team mutations are infrequent (membership changes, not message traffic), so a single lock is not a throughput concern — message **delivery** still rides the per-agent outbox queues and is never serialized through this lock.

### 16.3 Commands

All `ib team` subcommands and `ib roster` accept the team name **with or without** a leading `@` and normalize internally (strip a single leading `@`), so `@backend` and `backend` are equivalent on the command line. The team name is always a distinct positional argument, so the leading `@` is never required for disambiguation — accepting both forms simply means the user never has to remember which. (`ib send` is the one place the `@` carries meaning: `ib send @backend` routes to the team/sentinel namespace, whereas `ib send backend` would be a partial agent-id/repo match per §4.1 — so for `ib send` the `@` is significant, not optional.)

| Command | Behavior |
|---------|----------|
| `ib team create @<name>` | Create an empty team. Refuses reserved/colliding names per §16.1. Refuses a name that already exists. |
| `ib team add @<name> <agent-id>` | Add a member. Resolves `<agent-id>` via the same partial-match logic as `ib send` (§4.1). Fans out a join notice to the existing room (§16.4.1). No-op (not an error) if already a member. |
| `ib team remove @<name> <agent-id>` | Remove a member. Fans out a leave notice (§16.4.2). |
| `ib team list` | List all teams with member counts. |
| `ib team delete @<name>` | Tear down a team. Removes `teams.json` entry; does not notify (the team is gone). |
| `ib roster @<name>` | List every member with ID, repo, and current state (state read via `detectAgentStates()`). |
| `ib send @<name> "msg"` | Fan out to all members except the sender (§16.4). |

**Nonexistent-team handling:** every subcommand *except* `create` errors (`team @<name> not found`, non-zero exit) when `@<name>` is not an existing team — this applies to `add`, `remove`, `delete`, `roster`, and `send`. `create` errors instead when the name *already* exists (or fails the §16.1 collision/validation checks). `add` of an already-member agent is the one documented no-op-success (above).

A team **auto-prunes to empty but is not auto-deleted**: lifecycle pruning (§16.5) can leave a team with zero members, but the named team persists until `ib team delete`. The user named it; an empty roster is recoverable by `ib team add`, whereas an auto-delete would silently destroy intent.

### 16.4 Team Send (Fan-Out)

`ib send @<team> "message"` resolves the `@`-target to a team and then, for each member **other than the sender**, performs a standard `sendMessage` enqueue. Each per-member delivery is independent and rides the existing per-agent outbox queue (§4.1.1), so deliveries to different members serialize per-recipient and never interleave.

**Resolver integration is net-new code, not free folding.** An earlier framing claimed teams "fold into" the existing `@`-sentinel resolver for free; that is **not accurate** and the implementer must not assume it. Today the send-target resolver (`resolveTarget`, `index.ts` ~365–401) (a) **hard-errors** on an unknown `@name` rather than falling through, and (b) returns a **single** destination, not an N-recipient set. Team support therefore requires two concrete changes:
1. A **team branch** added to the resolver, ordered per §16.1 (`@system` → `@coordinator`/`@<repo>` → team) — the team lookup must run only after the existing sentinel/repo branches fail, and must be reached *before* the unknown-`@name` hard-error.
2. A **return-shape that can express multiple recipients** (or a dedicated team-send path that bypasses the single-recipient resolver and calls `sendMessage` per member). The spec does not mandate which; it mandates that the single-recipient shape is acknowledged and handled, because silently reusing it would deliver to only one member.
3. The **call-site null-guard must be bypassed for team targets.** Today the `ib send` call site does `if (!resolvedAgent) process.exit(1)` (`index.ts`) — a single-recipient assumption. A team resolves to **zero-or-more** recipients, so a team target with an empty post-exclusion recipient set is a **success** (§ "Empty-team and self-only sends" below), not the `process.exit(1)` error that an unresolved single `@name` produces. The team-send path must branch *before* that guard: an unknown `@name` still exits non-zero ("not a team, repo, or agent"), but a *known* team with no eligible recipients returns success.

**Sender exclusion:** the sender (resolved at enqueue time via the same cwd/`--from` logic as §4.1, `resolveSenderId`) is omitted from the fan-out. An agent never receives an echo of its own team message. If the sender is not a member of the team (e.g. a human via CLI, or `@system`), all members receive it.

- **Caveat — human inside an agent worktree:** sender resolution is cwd-based (`resolveSenderId`), so a *human* who runs `ib send @team` from within an agent's worktree is auto-attributed to that agent and would be excluded from the fan-out as if the agent had sent it. This is the same cwd-attribution behavior as point-to-point `ib send`; the documented escape hatch is `--from` (and the human can pass `--from ""` / omit to force the user-sender path). The implementer should not add special-casing here — just document the `--from` override.

**Membership scope — agents only (v1).** A team's `members` are **agent ids only**. `ib team add` resolves its argument through the same agent-id matcher as `ib send` (§4.1) and **rejects** a sentinel target — you cannot add `@system`, a per-repo coordinator (`@<repo>`/`@coordinator`), or another team to a team. Rationale: coordinators and `@system` already have their own addressing and lifecycle, and allowing a coordinator as a member raises undefined questions (does tearing down/restarting a coordinator fire a leave notice? does a coordinator get the imperative reply-rule injection?) that v1 deliberately sidesteps. Coordinators and `@system` may still **send** to a team (as non-member senders, all members receive it) — they just cannot be *members*. [^needs review] Coordinator-as-member is a plausible later extension; flagged as an explicit v1 scope boundary, not an oversight.

**Empty-team and self-only sends:** after sender-exclusion and dead-member pruning, the recipient set may be empty — either the team has zero members (auto-pruned, §16.3) or its only member is the sender. `ib send @<team>` in that case is a **no-op success** that prints an informational `no recipients in @<team>` line (not an error, not a silent nothing). This must be specified so the implementer does not pick a surprising behavior (error vs. silent).

**Dead/stopped members:** a member whose agent directory no longer exists is **pruned** from the roster at send time (skip-and-prune, see §16.5), not treated as an error. A member that exists but whose tmux session is stopped/complete is delivered to exactly as a point-to-point `ib send` would (the inline drain restarts/queues per §4.1.1) — team send does not special-case agent run state beyond what `sendMessage` already does.

**Delivery prefix:** the per-member message is formatted as:

```
[sent by <agent-id> in @<team-name>]: <message>
```

This extends the §4.1 step-4 prefix grammar. Note two intentional choices:

1. The literal word **"agent" is dropped** here, unlike the point-to-point agent format `[sent by agent <id>]:` (§4.1). In a team context the ` in @<team>` clause already establishes that the sender is an agent in a room, so "agent" is redundant. [^callout] This is a deliberate divergence from the point-to-point label and must not be "normalized" back to include "agent".
2. The `@<team-name>` token appears verbatim in the prefix so the recipient learns the reply target by example — to reply to the room, an agent echoes `ib send @<team-name> "..."`.

For a **human/CLI** sender (no `fromId`), the prefix follows the user form with the team clause: `[sent by user <name> in @<team-name>]: <message>` (or `[sent by user in @<team>]:` when no `user.name` is configured), consistent with §4.1 step 4.

**Implementation note:** the team identity is carried as an optional field on the queued message (`OutboxMessage.team?: string`) and resolved into the prefix at DRAIN time in `deliverMessage` — matching the §4.1.1 invariant that all label/prefix resolution happens at drain time, not enqueue time. Only the team name (a stable string) is captured at enqueue; no cwd-dependent resolution is deferred incorrectly.

> **Concrete trap (must not be missed):** `readOutbox` in `outbox.ts` reconstructs each `OutboxMessage` by **explicitly listing the known fields** when it parses a JSONL line (it does not spread the parsed object). A newly added `team` field will be **silently dropped on the round-trip through the queue file** unless `readOutbox`'s reconstruction (and the type guard it uses to validate a line) is updated to carry `team` through. This is the single most likely implementation bug for this feature — the field will appear to work for inline drains and vanish for watchdog-driven drains. The implementer must update both the `OutboxMessage` type and the `readOutbox` field reconstruction together, with a test that enqueues a team message and asserts it survives a read-back.

**Notice ordering (persist-then-notify).** All membership notices (join, leave) follow the same rule: the roster change is **persisted first** (under the `.teams.lock`, §16.2), and the recipient set is then **snapshotted once from the just-written roster** after the lock is released, and the notice fanned out to that snapshot. Concretely: for a join, the recipient set is the post-write members **minus the newly-joined agent** (who instead gets the new-member instruction, §16.4.1); for a leave, it is the post-write members (the departed agent is already absent from it). Using the post-write snapshot resolves the recipient-timing ambiguity — a member added/removed concurrently is reflected because the snapshot is taken after this operation's own committed write, and any *later* concurrent change carries its own notice. Notices are **best-effort** — a delivery failure does not roll back the membership change (consistent with the outbox being best-effort, §4.1.1). The fan-out happens **outside** the lock (it only reads the snapshot it already holds), so notice delivery never holds the global teams lock.

#### 16.4.1 Join Notice

When an agent is added to a team (`ib team add`), the **existing** members each receive a fan-out notice, and the **newly added** agent receives a notice that informs it of the reply protocol (since session-start, §16.6, only fires once and may have fired before the agent joined):

- To existing members: `[sent by <new-agent-id> in @<team>]: joined the team` (or an equivalent system-phrased line). [^needs review] Exact wording TBD in review.
- To the new member: a one-line instruction that it is now in `@<team>`, that it can see teammates with `ib roster @<team>`, and that it replies to the room with `ib send @<team> "..."`.

#### 16.4.2 Leave Notice

When a member leaves a team — whether via explicit `ib team remove`, single-agent teardown (`ib kill`/`ib merge`), or bulk teardown (any `ib nuke`) — the remaining members receive a leave notice. There are **two notice shapes**, chosen by *which command* drives the departure (§16.5), not by a runtime flag:

- **Per-agent leave notice** (`ib kill`, `ib merge`, `ib team remove`): `[sent by <agent-id> in @<team>]: left the team` (or system-phrased), with `fromAgent` stamped **explicitly** to the departed id (§16.5 sender-attribution rule — never cwd-auto-detected).
- **Coalesced leave notice** (any `ib nuke` — they all route through `nukeAgentList`): **one** notice per affected team summarizing all departures from that team, e.g. `3 members left @<team>` (and `1 member left @<team>` for a single-agent nuke), stamped as a **system send** (`@system` or the no-`fromAgent` user form), not any single departed id.

**Why two shapes — notice-storm avoidance.** A bulk operation (`nukeAllAgents`, `ib nuke <manager>` over many descendants) would otherwise produce an O(N²) storm: N departures from a shared team firing N notices, each to up to N−1 recipients. `nukeAgentList` prevents this by **accumulating** the pruned `(team, id)` pairs (returned up from `archiveAgent`, §16.5) across its whole loop and emitting **one** coalesced notice per affected team afterward, to that team's *surviving* members only. If a team has no survivors (all members torn down), no notice is sent (empty recipient set, §16.5 empty-survivor carve-out). The rule that **bulk teardown must not emit per-agent notices is not optional**; because every `ib nuke` flows through `nukeAgentList`, this is automatic — `nukeAgentList` is *always* the coalesced path, even for a single-agent nuke. [^needs review] The exact coalesced-summary wording is open.

### 16.5 Lifecycle and Membership Pruning

Membership is stored by agent ID, and agent IDs are **ephemeral** — they retire when an agent is merged, killed, or nuked (§1, §3). The roster must therefore be self-healing. The mechanism is two-tier: an **eager** prune at teardown (the primary path, fires the leave notice) and a **lazy** prune on read (a safety net for departures that skipped teardown).

**Eager prune — the membership *write* and the notice *fan-out* live at two different layers, and the fan-out belongs in the `ib-commands.ts` *command* functions, not in `agent-lifecycle.ts`.** This is the subtle part. `archiveAgent` *and* `teardownAgent` (`agent-lifecycle.ts`) are **repo-local**: `archiveAgent` is pure filesystem archival, and `teardownAgent(repoPath, …)` takes a single `repoPath` and has no `listRepos()` / `RepoEntry` access. The notice fan-out needs the **cross-repo `repos` list** (a team's surviving members may live in other repos), which is only reachable from the **`ib-commands.ts` command layer** (`killAgent`, `mergeAgent`, `nukeAgentList`) — these can reach `listRepos()` (it is already imported in `ib-commands.ts`; these three functions don't call it *today* but trivially can). So:

- **Membership write → in `archiveAgent` (per agent, unconditional, no notice).** `archiveAgent` removes this agent's id from every team it belongs to, under the `.teams.lock` (§16.2), beside the existing `deleteAgentOutbox()` call. It emits **no** notice and needs no `repos` data — pruning by agent id only reads/writes `teams.json`. It **also reports the set of `(team, removed-agent-id)` pairs** it pruned: `archiveAgent` currently returns `string | null` (the archive folder path), so this is a **return-type widening** (e.g. to an object/tuple carrying both the existing archive path and the pruned pairs), **not** a replacement — existing callers that read the archive path must keep working. `teardownAgent` **threads the pruned pairs up** to its caller (its `boolean` return likewise widens to carry them).
- **Notice fan-out → in the `ib-commands.ts` command function that drove the teardown**, after `teardownAgent`/`archiveAgent` return the pruned pairs. Each command has `listRepos()` and knows whether it tore down one agent or many:
  - **`killAgent`** (`ib kill`) — calls `teardownAgent` directly for exactly one agent → fans out **one per-agent leave notice** per affected team, `fromAgent: <departed-id>`.
  - **`mergeAgent`** (`ib merge`) — calls `archiveAgent` directly (it does **not** go through `teardownAgent`) for exactly one agent → fans out **one per-agent leave notice** per affected team, `fromAgent: <departed-id>`. (This path must be specified separately precisely because it bypasses `teardownAgent`.)
  - **`nukeAgentList`** (`ib nuke` and `nukeAllAgents`) — **always the coalesced path.** `ib nuke <id>` (even a single leaf), `ib nuke <manager>` (manager + descendants via `getDescendantsRecursive`), and `nukeAllAgents` ALL flow through `nukeAgentList`, which cannot distinguish a 1-agent nuke from an N-agent nuke. It therefore **accumulates** the pruned pairs across its whole loop and emits **one coalesced notice per affected team** afterward — even for a single-agent nuke (which simply yields a `1 member left @<team>` coalesced notice). It never emits a per-agent `fromAgent: <departed-id>` notice.
- **Sender attribution — stamp explicitly, do not auto-detect.** A **per-agent** leave notice (kill, merge) MUST set `fromAgent` explicitly to the **departed agent's id** (the explicit-sender path, like `--from` in §4.1; `resolveSenderId` cwd auto-detection is unusable — the departed worktree is gone and the emitter is the teardown process). A **coalesced** notice (any nuke) is stamped as a system send (the `@system` sentinel, or the no-`fromAgent` user form, §4.1), not any one departed id, and its body names the count, e.g. `3 members left @<team>`.

| Departure path | Membership prune (`archiveAgent`) | Notice (emitting `ib-commands.ts` function) |
|---|---|---|
| `ib kill` (one agent) | prune + return pruned pairs (via `teardownAgent`) | `killAgent` → one per-agent leave notice, `fromAgent: <departed-id>` |
| `ib merge` (one agent) | prune + return pruned pairs (`archiveAgent` direct — no `teardownAgent`) | `mergeAgent` → one per-agent leave notice, `fromAgent: <departed-id>` |
| `ib nuke <id>` (single leaf) | prune + return pairs (via `nukeAgentList`→`teardownAgent`) | `nukeAgentList` → **coalesced** per-team notice (`1 member left`), system sender |
| `ib nuke <manager>` (manager **+ descendants** via `getDescendantsRecursive`) | prune + return pairs per agent | `nukeAgentList` accumulates → **one coalesced** per-team notice, system sender |
| `nukeAllAgents` (bulk) | prune + return pairs per agent | `nukeAgentList` accumulates → **one coalesced** per-team notice, system sender |
| `ib pause` (stops Claude + tmux, does **not** archive) | **none** — pause is not teardown; agent keeps its dir/id and can resume | none — a paused agent stays a member (see below) |
| Manual `rm -rf` / machine crash mid-run | **none at departure** — never reaches `archiveAgent` | none at departure; cleaned up by the silent lazy prune below |

**Empty-survivor carve-out:** when a teardown removes the *last* member(s) of a team (e.g. `nukeAllAgents` tears down every member), there is **no one left to notify** — the coalesced notice for that team is simply not sent (an empty recipient set, consistent with §16.4's empty-set no-op). The team still persists empty (§16.3); it is the roster, not the team, that emptied.

**Paused members retain membership** (the `ib pause` row): a paused agent is dormant, not gone, so it stays in the team. Two consequences are specified: (a) it is **not** lazy-pruned, because its agent directory still exists (lazy prune keys on dir-existence, not run state); (b) a team message sent while it is paused is **enqueued to its outbox** and delivered on resume, exactly as a point-to-point `ib send` to a paused agent would be (§4.1.1) — the fan-out does not skip a paused member or treat its missing tmux session as an error. [^needs review] If product intent is that a paused agent should appear "absent" to the room, that is a separate feature (a per-member dormant flag) and is out of scope here — flagged so it is a conscious choice.

**Lazy prune — on team send and roster read.** Any member whose agent directory no longer exists is pruned lazily (skip-and-prune) during `ib send @<team>` and `ib roster`. This is the safety net for the two "no" rows above (manual deletion, crash) where no teardown ran. **Lazy pruning is silent — it fires no leave notice** (there is no reliable moment-of-departure to attribute it to, and a notice on every read would be noisy and possibly duplicated). The eager teardown path is the *only* path that emits leave notices; the lazy path only keeps the roster honest. This cleanly separates the two and removes any risk of a **duplicated** leave notice (eager fires once at teardown; lazy never fires one).

**Pruning never errors a send:** a fan-out that encounters dead members prunes them (under the lock, §16.2) and delivers to the rest.

**The watchdog has no team role.** [^callout] An earlier draft claimed the watchdog fans out leave notices "via the same `@`-sentinel notify path." That is **incorrect** and has been removed: the watchdog never tears down agents — it only *notifies* a manager/spawner that an agent finished (`notifyManager`/`notifySpawner` in `watchdog.ts`), and the actual teardown is performed later by whoever runs `ib merge`/`ib kill`, which routes through `archiveAgent` (where the eager prune lives). Moreover `notifySpawner` is a single-destination switch, not a reusable N-recipient fan-out primitive. Team leave-notices therefore belong entirely to the `archiveAgent`/CLI path, and the watchdog requires **no** team-specific changes.

### 16.6 Session-Start Awareness (Hook Integration)

Mechanical delivery is necessary but not sufficient: an agent must *know* it is in a team and that replying to the room means `ib send @<team>` rather than a point-to-point reply to whoever it thinks sent the last message. Without this, the "room" illusion collapses into point-to-point messaging.

The session-start hook (§6, `session-start.ts`) injects team awareness, analogous to the existing "Talking to other agents" block. **The pointer alone is not enough.** An agent's strongest default signal is "the last message came from `<agent-id>`, so reply to `<agent-id>`" — point-to-point. Overcoming that default requires more than a passive pointer to `ib roster`; the injection must be **imperative and explicit** about the reply target. The block therefore combines three things:

- **Membership + live-roster pointer:** the block names which team(s) the agent belongs to and instructs it to run `ib roster @<team>` to see current teammates — it does **not** enumerate a static teammate list (which would go stale as members join/leave mid-session). This mirrors how the existing block points agents at `ib list`.
- **Imperative reply rule (the key part):** explicit wording, not a hint — e.g. *"You are in team `@<team>`. When you reply to something a teammate said in the team, send your reply to the WHOLE room with `ib send @<team> \"...\"` — do NOT reply only to the individual agent who messaged you. Use `ib send <agent-id>` only when you specifically intend a private, one-to-one message that the rest of the team should not see."* This directly counters the point-to-point default rather than relying on the agent to infer it.
- **Per-message reinforcement — and resolving the prefix tension:** the delivery prefix `[sent by <agent-id> in @<team>]:` (§16.4) carries the `@<team>` token in every inbound message, reinforcing the reply target continuously, not just once at session-start. But the same prefix also names `<agent-id>` prominently, which on its own pulls *toward* the point-to-point default (the agent sees a specific sender and wants to answer that sender). The imperative rule must therefore explicitly teach how to **read** the prefix: the `<agent-id>` is **who spoke in the room**, and the `@<team>` is **where to reply** — answering goes to `@<team>`, not to `<agent-id>`, unless a private reply is intended. The prefix and the rule are co-designed: the prefix deliberately puts the room token *after* and alongside the speaker so "in @<team>" reads as the context the message lives in. [^needs review] Exact imperative wording is subject to tuning in review; the *requirement* is that it be imperative, name `ib send @<team>` as the default reply action, and explicitly disambiguate "who spoke" (`<agent-id>`) from "where to reply" (`@<team>`) — not merely point at `ib roster`.
- **Mid-session joins:** session-start fires once. An agent added to a team *after* it is already running learns the protocol from the join notice (§16.4.1), which carries the same imperative `ib send @<team>` reply instruction (not just the `ib roster` pointer).

**Implementation reality (not a template edit).** [^callout] The existing "Talking to other agents" block is a **static** `{{...}}`-templated layer body in `~/.itsybitsy/agent-types/_all.md` with no per-agent data. Team membership is **dynamic per agent**, so this is **net-new code** in `generateInstructions` (`session-start.ts`) — either an appended built block computed in code, or a `{{teamMembership}}` template variable populated by code that scans `~/.itsybitsy/teams.json` for `ctx.agentId`. The "analogous to" framing is about placement and tone, not about it being a static-template change.

### 16.7 Cross-Cutting Impact (Four-Perspective Checklist)

Per the project's required review checklist, teams touch each perspective as follows:

1. **General agent functionality** — new user-tier state (`~/.itsybitsy/teams.json`); agent teardown gains a membership-pruning step. No change to how agents are spawned or to `meta.json` shape (team membership is stored centrally, not per-agent, so a coordinator restart or agent re-read does not lose it).
2. **Hooks** — `session-start.ts` gains a team-awareness injection (§16.6). No other agent-session hook is affected; the path-check, stop, permission-denied, and intercept-task hooks are team-agnostic.
3. **Watchdog** — **no changes required.** The watchdog never tears down agents (it only notifies a manager/spawner), so it never reaches the team-prune point; leave-notices are emitted by the `archiveAgent`/CLI teardown path instead (§16.5). Nudge timing, rate-limit recovery, and state detection are all unaffected. This corrects an earlier draft that incorrectly assigned the watchdog a leave-notice role.
4. **`ib watch` / dashboard** — minimum viable: the info panel for a selected agent surfaces its team membership(s) ("member of: @backend"). A dedicated team-chat pane/view was explicitly **deferred to a later phase** — the registry and fan-out are usable from the CLI without it. That deferred dashboard work is **now fully specified in §17** (Teams panel as a focus stop, the cross-repo Teams tree, the shared team-channel chat box, and the cross-cutting/affected-files impact).

### 16.8 Affected Files and Modules

| Module | Changes needed |
|--------|---------------|
| `src/teams.ts` (new) | Registry read/write (`~/.itsybitsy/teams.json`) with **`.teams.lock`** read-modify-write serialization (§16.2, mirrors `acquireOutboxLock`), roster, name allowlist validation (§16.1, mirrors `validation.ts`), collision check (reserved-set **union** of `SYSTEM_AGENT_ID` + literal `coordinator` + `BARE_RENDERED_SENTINELS` members, plus repo basename **and nickname**, all **case-SENSITIVE** `===` to match the resolver), name normalization (strip leading `@`), eager + lazy prune helpers. |
| `src/index.ts` (`resolveTarget` + `ib send` call site) | **Add a team branch** to the send-target resolver, ordered `@system` → `@coordinator`/`@<repo>` → team, reached **before** the unknown-`@name` hard-error; return a shape that expresses multiple recipients (or route team sends down a dedicated per-member `sendMessage` loop). **Also bypass the call-site `if (!resolvedAgent) process.exit(1)` single-recipient guard for team targets** — a known team with an empty recipient set is success, not exit-1 (§16.4 item 3). This is the change that makes `ib send @<team>` actually fan out — it does **not** work for free. |
| `src/ib-commands.ts` | Team-send fan-out (per-member `sendMessage`, excluding sender, empty-set → "no recipients in @<team>" success). `deliverMessage` prefix extension (`in @<team>`, drains the new `team` field at §4.1.1's drain-time). New commands: `teamCreate`, `teamAdd`, `teamRemove`, `teamList`, `teamDelete`, `roster` (nonexistent-team errors per §16.3). **Leave-notice fan-out lives here (this layer has `listRepos()`):** `killAgent` and `mergeAgent` each emit a per-agent leave notice with **explicit `fromAgent: <departed-id>`** after their teardown returns the pruned pairs; `nukeAgentList` accumulates pairs across its loop and emits the **coalesced** per-team notice (system sender). Plus join-notice + `ib team remove` per-agent leave-notice (persist-then-notify, §16.4.1/.2). |
| `src/outbox.ts` | `OutboxMessage` gains optional `team` field — **and BOTH field-by-field reconstruction sites must carry it through**: `enqueueOutbox` (drops `team` at WRITE time) AND `readOutbox` + its line type-guard (drops `team` at READ time). Each rebuilds an explicit `{id, message, fromAgent, raw, enqueuedAtMs}` literal rather than spreading, so a new field is silently lost at *both* ends unless both are patched (§16.4 trap). Add a regression test that enqueues a team message and asserts `team` survives the full enqueue→read round-trip. |
| `src/agent-lifecycle.ts` | **`archiveAgent`** prunes the torn-down agent from all teams (under `.teams.lock`), beside `deleteAgentOutbox` — and **widens its return** (currently `string \| null`, the archive path) to ALSO carry the pruned `(team, removed-id)` pairs (widen, don't replace — existing archive-path callers must keep working); it emits NO notice and needs no `repos` data (it lacks it). **`teardownAgent`** likewise widens its `boolean` return to **thread the pruned pairs up** to its `ib-commands.ts` caller; it does NOT emit notices (it has only a single `repoPath`, no `listRepos()`). No `suppressLeaveNotice` flag — single-vs-bulk is decided by *which command* fans out (see `ib-commands.ts` row), not by a lifecycle-layer parameter. `ib pause` does NOT prune. |
| `src/hooks/session-start.ts` | Inject team-awareness block — **net-new dynamic code** in `generateInstructions` (not a static-template edit), scanning `teams.json` for the agent's ID; imperative reply rule naming `ib send @<team>` (§16.6). |
| `src/registry.ts` / repo-add path | **Hard-refuse** adding a repo whose basename/nickname collides with an existing team name (§16.1) — not a soft warning. |
| `src/validation.ts` | New `isValidTeamName()` allowlist helper (or reuse the agent-id allowlist), used by `teamCreate` (§16.1). |
| `src/tui/dashboard.ts` (later phase) | Surface team membership in the info panel; full team view deferred. |

---

## 17. Teams in the Dashboard (`ib watch`)

§16 built the Teams data layer, the `ib send @<team>` fan-out, the `ib team`/`ib roster` commands, and the join/leave notices — all usable from the CLI. §16.7.4 deferred the dashboard surface. §17 specifies that deferred work: a **Teams panel** that shares the sidebar's tree region with the existing Agents tree, a cross-repo **Teams tree** grouped by team, team-aware **selection / send-target / info** behavior, and a **shared team-channel chat box** rendered in the main area — backed by a new per-team `*.channel.jsonl` persistence layer that mirrors the proven `outbox.ts` append/read discipline (§4.1.1).

Like Teams itself (§16), this is a **TypeScript-only** feature with no bash reference equivalent. It builds on the dashboard architecture in §11–§13: the resizable sidebar (`SidebarComponent`, `src/tui/sidebar.ts`), the focus system (`FocusManager`/`FocusTarget`, `src/tui/focus.ts`), the discriminated `Selection` union (`src/tui/selection.ts`), the `AgentTreeComponent` (`src/tui/agent-tree.ts`), and `layout.json` persistence (`src/tui/layout.ts`). It reuses the `@`-sentinel address namespace and `teams.json` schema from §16 verbatim — the dashboard is a **reader and a sender**, never a new owner of team state.

**One new persistence file pair (`<team>.channel.jsonl` + `<team>.log`) and a new send-path append are the only non-dashboard changes.** Everything else is sidebar/focus/selection/main-area wiring. The cross-cutting impact (§17.5) is therefore almost entirely in the `ib watch` perspective.

### 17.1 Teams Panel as a Focus Stop (the toggle)

The sidebar's tree region (the top section that `SidebarComponent.renderNormalLayout` fills with the `Agents` separator + `AgentTreeComponent`, `src/tui/sidebar.ts`) is **shared** between the existing Agents tree and a new **Teams tree**. They are **two ordered focus stops occupying the same screen region** — only the focused one renders. Agents is the default resting view (§13.6 keeps `agent-tree` as the initial focus). This realizes the settled design: the Agents panel *upgrades* into a Teams view that **replaces** it when selected, rather than adding a third always-visible sidebar section.

**New `FocusTarget`.** Add `"teams-tree"` to the `FocusTarget` union (`src/tui/focus.ts`). `teams-tree` is **NOT** in `FOCUS_ORDER` — it is reached via dedicated keys, not by Tab cycling.

```
FOCUS_ORDER:  agent-tree → info → active-agent → right-pane → repo-coordinator
```

Concretely, `FOCUS_ORDER` becomes `["agent-tree", "info", "active-agent", "right-pane", "repo-coordinator"]` (same as before §17, with `repo-coordinator` still in `skipTargets` by default). `teams-tree` is a valid `FocusTarget` — `setFocus("teams-tree")` works — but `cycle(+1/-1)` never lands on it.

**Switching to/from the Teams panel — the `0` / `1` keys.** Two dedicated top-level keys move focus into and out of the Teams panel:

- **`0`** → `focusManager.setFocus("teams-tree")` (the sidebar tree region renders the Teams tree).
- **`1`** → `focusManager.setFocus("agent-tree")` (the sidebar tree region renders the Agents tree).

These are top-level dashboard keys, mirroring the gating of the existing Tab handler:

- **Suppressed when a dialog is open** (the `handleDialogInput` early-return at the top of `handleInput` already covers this).
- **Suppressed when an input sub-focus is active** (e.g. `active-agent` / `coordinator` / `repo-coordinator` in `subFocus === "input"`). Those panels' sub-focus blocks return before reaching the top-level key handlers, so `0` / `1` typed into the input field are captured as text, not as focus toggles. The `'0'`/`'1'` handlers live at the same scope as the Tab handler — right after the Tab/Shift-Tab block in `handleInput` — and rely on the same early-return gating.

The toggle preserves each panel's selection (§17.1 independent-selection invariant): pressing `0` switches focus only, the Agents tree's selection is untouched, and pressing `1` switches focus back without disturbing the Teams tree's selection. *(Superseded by Phase 2 of the three-axis model — see the **Three-axis model** paragraph below. After Phase 2, selection becomes a single global axis decoupled from sidebar visibility, so the "preserves each panel's selection" framing is replaced by "the global selection persists across toggles; the visible tree mirrors it visually when it can.")*

**Three-axis model (Phase 2, current).** The original §17.1 conflated *which tree the sidebar shows* with *which panel has focus* — pressing `0` both made the Teams tree appear AND moved focus onto it, so Tab cycling would replace the visible tree as a side-effect. The settled mental model now treats these as **three independent axes**:

1. **Sidebar visibility — `sidebarMode: "agents" | "teams"`.** Controls which tree the sidebar renders in its tree region. Toggled exclusively by the `0` (teams) and `1` (agents) keys. Tab cycling never changes it. Defaults to `"agents"` on startup; not persisted.
2. **Focus.** Which panel receives keyboard input. Cycled by Tab / Shift+Tab through `FOCUS_ORDER`. Independent of sidebar visibility — pressing `0`/`1` does NOT move focus, and Tab cycling does NOT change which tree is visible.
3. **Global selection — `activeSelectionSource: "agents" | "teams"`.** Names which tree owns the global selection. The effective selection is the `selection` getter of whichever tree this points to (an agent, a repo header, the system coordinator, a team anchor, a team member, or null). Drives the info panel, the main area's middle (tmux / chat / team channel) pane, and the right pane. Changed by `j`/`k`/`J`/`K` (sets `activeSelectionSource = sidebarMode`) and by jumps that force-select in a specific tree (the `@`-fuzzy jump and the QUESTIONS `g`-go-to-agent both write `activeSelectionSource = "agents"` and `sidebarMode = "agents"`). Toggling `0`/`1` NEVER changes `activeSelectionSource`. Defaults to `"agents"` on startup; not persisted.

Phase 1 (merged) decoupled axis 1 from axis 2. **Phase 2 (current) decouples axis 1 from axis 3:** `sidebarMode` is the user's choice of which sidebar tree to look at, and `activeSelectionSource` is the user's choice of which tree owns the selection that drives the info / main / right panes. They are independent — one can show a tree whose selection is inert (the visible-but-inactive tree renders without a highlighted row), and the other can drive the panes from an invisible tree.

- **Selection persists across visibility toggles.** Pressing `0` after navigating to an agent makes the Teams panel visible but leaves the agent as the active selection — the info / main / right panes still drive off that agent. Pressing `0` then j/k flips the active source to teams; pressing `1` then leaves the team as the active selection while the sidebar shows agents.
- **j/k always navigates the visible tree.** The newly-navigated tree becomes the active source (the user just declared what they're selecting by moving the cursor in this tree). j/k from a no-selection state in the visible tree selects the first or last row of that tree, and that tree becomes active.
- **The visible tree renders its selection highlight whenever it has a selection.** The mirror (next bullet) keeps the inactive tree pointing at the same effective selection when possible, or `deselect()`s it when there's no counterpart — so highlighting can be unconditional on `hasSelection` rather than gated on whether this tree is the active source. An agent that lives in BOTH trees lights up in BOTH; an agent that lives in only one tree (e.g. not a member of any team) lights up only there; a team anchor / repo header / system coordinator lights up only in its owning tree. The `suppressSelection` flag is retained for the QUESTIONS dimming case on the Agents tree (and as a future hook for the Teams tree), but is NO LONGER set as a function of `activeSelectionSource !== sidebarMode`.
- **Visual mirror on every selection change (`mirrorSelectionToVisibleTree`).** Called from `syncSelectedAgent()` — the dashboard-wide "selection changed" chokepoint — so every entry point (j/k, `0`/`1`, `@`-fuzzy jump, `g`-go-to-question) re-mirrors automatically. The mirror pushes the **active source's** selection into the **inactive** tree: if the active selection is an *agent* that appears as a team-member row in the Teams tree, that member row is selected (visual only); if the agent is in multiple teams, the first team (by stable `listTeams()` order) wins. If the active selection is a *team* anchor, a *repo header*, or the *system coordinator*, the other tree has no counterpart and is `deselect()`ed. The mirror NEVER changes `activeSelectionSource` — it is a render-time hint, not a source-of-truth change. Note that this means the inactive tree never holds a stale pointer to something other than the effective selection: navigating to a team clears any prior Agents-tree coord pointer, navigating to an agent in the Teams tree updates the Agents tree, etc.
- **`@`-fuzzy jump and `g`-go-to-question-agent are Agents-panel operations.** Both call `setActiveSelectionSource("agents")` and `setSidebarMode("agents")` before selecting, so the jumped-to agent is the visible and active selection. Even if the user was on the Teams panel with a team selected, the jump pulls everything back to the Agents tree — the rule "the jump always lands in Agents" extends from focus to all three axes.
- **`s`-send team fan-out is gated on the active source.** The `@<team>` fan-out branch in `handleSend` fires only when `activeSelectionSource === "teams"` AND the Teams tree's selection is `{ kind: "team" }`. A team selection that lingers in the Teams tree while the Agents tree is the active source falls through to the agent send path — there is no stale-team-send hazard.

**Worked example (Adam's spec).** Starting from a fresh dashboard with the first agent auto-selected:

1. An agent is the active selection. `sidebarMode=agents`, `activeSelectionSource=agents`. Info / main / right show the agent.
2. Press `0`. `sidebarMode=teams`, `activeSelectionSource` still `=agents` — the agent is still the active selection. The Teams tree appears in the sidebar. If the agent is a member of a team, that team-member row is visually highlighted (mirror); otherwise, the Teams tree renders with no highlight. Info / main / right still show the agent.
3. Press j (or k). j/k navigates the visible tree (Teams). The first team row is selected; `activeSelectionSource=teams`. Info now shows team metadata; main shows the team channel.
4. Press `1`. `sidebarMode=agents`, `activeSelectionSource` still `=teams` — the team is still the active selection. The Agents tree appears in the sidebar but renders with **no row highlighted** (the mirror `deselect()`s it because a team anchor has no Agents-tree counterpart). Info / main still drive the team channel.
5. Press j. j/k navigates the visible tree (Agents). The first agent under the cursor is selected; `activeSelectionSource=agents`. Info / main return to that agent.

**Implementation references.** `activeSelectionSource` is a public field on `DashboardComponent` (`src/tui/dashboard.ts`). The resolver in `syncSelectedAgent` reads it (`const teamsActive = this.activeSelectionSource === "teams"`). The mirror lives in `mirrorSelectionToVisibleTree()` and is invoked at the TOP of `syncSelectedAgent()` — that single chokepoint covers every entry point (j/k, J/K, `0`, `1`, `@`-fuzzy jump, `g`-go-to-question), so each path only has to update the active tree's selection and call `syncSelectedAgent()`. The render path no longer sets `agentTree.suppressSelection` / `teamsTree.suppressSelection` as a function of `activeSelectionSource`; the only remaining writer of `suppressSelection` is the QUESTIONS mode dim on the Agents tree. The ActionCtx setters `setActiveSelectionSource` and `setSidebarMode` are arrow properties on the dashboard so the `@`-fuzzy jump and `g`-go-to-question-agent handlers can write both axes through the ctx.

The legacy `"teams-tree"` focus target is retained in the `FocusTarget` union so existing callers compile, but the dashboard never settles focus there — if a `0`/`1` keypress is observed while focus is already on `"teams-tree"`, focus is reset to `"agent-tree"`. Phase 3 reintroduces `"teams-tree"` as a Tab-reachable target whose inclusion in cycling depends on `sidebarMode`.

**Three-axis model (Phase 3, current).** Phase 3 makes **Tab cycling sidebar-mode-aware** — the third axis becomes load-bearing on Tab behavior. The Phase 2 selection model (axis 3) is untouched; Phase 3 only changes which `FOCUS_ORDER` `cycle()` consults and how `0`/`1` move focus between the two heads (`agent-tree` ↔ `teams-tree`).

- **Two Tab orders.** `focus.ts` exports two cycling orders. `FOCUS_ORDER` = `["agent-tree", "info", "active-agent", "right-pane", "repo-coordinator"]` (the agents-mode order, unchanged from Phase 2). `TEAMS_FOCUS_ORDER` = `["teams-tree", "info", "active-agent", "right-pane"]` (the teams-mode order, new in Phase 3). `repo-coordinator` is **omitted** from teams-mode because a repo header is never a team selection — there is nothing for a repo-coordinator focus stop to address. The middle pane stop (`active-agent`) is **shared** between both orders and represents "the main-area pane" regardless of whether it currently renders an agent tmux pane or a team channel.
- **Mode precedence (coordinator > teams > agents).** `FocusManager.cycle()` picks its order in this priority: `coordinatorMode === true` → `COORDINATOR_FOCUS_ORDER` (regardless of `sidebarMode`); else `sidebarMode === "teams"` → `TEAMS_FOCUS_ORDER`; else `FOCUS_ORDER`. Coordinator mode wins because a system-coordinator active selection IS coordinator mode — the user can still press `0` to view the Teams tree, but Tab respects coord mode.
- **`FocusManager.sidebarMode` mirrors the dashboard.** `FocusManager` has its own `sidebarMode: "agents" | "teams"` field (default `"agents"`). The dashboard's `0`/`1` handlers AND the `setSidebarMode` ActionCtx setter write into `focusManager.sidebarMode` whenever `dashboard.sidebarMode` changes, so `cycle()` always picks the correct order. The mirror covers the `@`-fuzzy jump and `g`-go-to-question-agent paths in addition to the direct `0`/`1` keys.
- **Focus transitions on `0`/`1`.** When `0` (enter teams mode) is pressed: if focus is on `agent-tree` (the head of the agents cycle) or `repo-coordinator` (agents-only target), focus moves to `teams-tree` — the natural mirror. Shared targets (`info`, `active-agent`, `right-pane`) stay where they are. When `1` (enter agents mode) is pressed: if focus is on `teams-tree`, focus moves to `agent-tree`. Other targets are unchanged. The rule: **focus moves only when the current target would not exist in the new cycle.** Shared targets are preserved.
- **Coordinator mode.** `COORDINATOR_FOCUS_ORDER` (`["agent-tree", "info", "coordinator"]`) is the restricted Tab order used when the system coordinator is selected (§12.1.4). It wins over `sidebarMode === "teams"` (a coordinator active selection cannot meaningfully Tab to teams-tree as a focus stop in teams mode — the user can still press `0` to view the Teams tree, but Tab still respects coord mode). `teams-tree` is not in `COORDINATOR_FOCUS_ORDER`; the `0`/`1` keys still toggle `sidebarMode` in coordinator mode, but Tab cycling stays within agent-tree/info/coordinator.
- **Skip behavior.** `skipTargets` (default `{"repo-coordinator"}`) applies to whichever order is active. Since `repo-coordinator` is not in `TEAMS_FOCUS_ORDER` at all, the skip is a no-op in teams mode — but it still gates correctly in agents mode (skipped unless the right pane is in REPO mode).

**Independent selection — the core invariant.** Toggling focus between Agents and Teams **must not change either panel's selection.** The two panels hold **independent selection state**: the Agents tree keeps its `AgentTreeComponent` selection; the Teams tree owns its own selection (a parallel component, §17.2). `FocusManager.cycle()`/`setFocus()` only move the *focus pointer* — they never call `selectAgentById`/`moveSelection`/`moveToRepo` on either tree. This is already how focus works for every other panel; §17 only requires that the Teams toggle preserve it symmetrically.

**Recommendation — a parallel `TeamsTreeComponent`, not a mode flag on `AgentTreeComponent`.** [^needs review] Two implementations were considered:

1. **(Recommended) A new `src/tui/teams-tree.ts` `TeamsTreeComponent`** that reuses the `AgentTreeComponent` *pattern* (a `FlatEntry`-style flat list, `selectedIndex`, `visibleList`, a `selection` getter, `navigate` vs `navigateAnchor`, `MAX_TREE_HEIGHT`, scroll indicators) but groups by **team** instead of repo and owns its own selection state.
2. *(Rejected)* A `mode: "agents" | "teams"` flag on the single `AgentTreeComponent`. Rejected because `AgentTreeComponent` already encodes deep repo-grouping assumptions (the `moveToRepo` anchor logic, `repo-header` rows, repo-path selection ids, the §12.4.2 coordinator integration), and a shared `selectedIndex` would make "independent selection" the hard case rather than the free case — the two views index different flat lists, so one index cannot serve both.

The recommended split keeps `AgentTreeComponent` untouched except for the **no-selection state** below (which the Agents tree needs regardless) and lets `SidebarComponent` render whichever of the two components matches the current focus (`agent-tree` → render `AgentTreeComponent`; `teams-tree` → render `TeamsTreeComponent`). Both are constructed once in the dashboard and held on `SidebarComponent`.

**The Agents tree gains a valid no-selection state.** `AgentTreeComponent` currently *always* points at a row (`selectedIndex` defaults to `0`, and `setFlatList` resets it to `0` on first populate). §17 introduces a genuine **no-selection** state so that the Agents panel does not force a selection the user never made (important now that an `@agent` jump — §17.3 — is the canonical way to force-select an agent). Specify it as a real state, not a sentinel index abuse:

- Add a `hasSelection: boolean` flag (or model `selectedIndex === -1` as "no selection" — pick one consistently; **recommended: a `hasSelection` boolean** alongside the existing index, because so much of the scroll math assumes a non-negative `selectedIndex`). When `hasSelection` is false, the `selection` getter returns `null`, no row renders in reverse video, and `selectedId` is `null`.
- **Startup auto-selects the first agent (user-confirmed); no-selection is a *reachable* state, not the startup state.** On dashboard **startup**, the Agents tree **auto-selects the first agent row** — the familiar pre-§17 behavior is retained (Adam's explicit call when the alternative — an empty Agents panel at launch — was surfaced). The no-selection *machinery* below is still required, but it is reached by the **toggle-back** and **@-jump** flows, not at launch:
  - **Startup select is one-time.** The dashboard's `onUpdate`/wiring selects the first agent on the **very first** populate (the first empty→non-empty transition, guarded by "nothing has ever been selected yet"). It is **not** re-asserted on later refreshes, and it is **never** triggered by a focus toggle.
  - **A focus toggle never auto-selects.** Tabbing Agents↔Teams is a *focus* change, not a populate, so it must not trip the startup select. When the user Shift+Tabs from a selected team back to the Agents panel, the Agents panel keeps whatever selection state it already had — which, after the user has e.g. deselected, can legitimately be **no-selection** (§17.1 independent-selection invariant). This is the case the no-selection state exists for.
  - So: row 0 is selected at launch (familiar), but the panel can still *become* no-selection via the toggle-independence/@-jump flows — and `j`/`k` from that no-selection state behaves as specified below. (§13.6's *focus* default is unchanged — `agent-tree` is still the initially focused panel.)
- **`j`/`k` from no-selection:** `j` selects the **first** visible row; `k` selects the **last** visible row. (After the first move the existing `moveSelection` wrap-around behavior takes over.)
- **`shift+j`/`shift+k` from no-selection:** `shift+j` (forward anchor jump, today `moveToRepo(1)`) selects the **first anchor's** landing row (first repo's first agent, or the coordinator if it sorts first); `shift+k` selects the **last anchor's** landing row. This mirrors the `j`/`k` first/last rule at anchor granularity.
- `setFlatList` must **not** silently re-assert a selection: when the panel is in no-selection and the list is repopulated, it stays in no-selection (today's `wasEmpty` branch that sets `selectedIndex = 0` must be gated on "had a selection before"). An `@agent` jump or a `j`/`k` press is the only thing that leaves no-selection.

**Teams tree initial selection — starts in no-selection.** The Teams tree **starts in no-selection** and owns the **same** no-selection *machinery* as the Agents tree. Note the asymmetry with the Agents tree's *startup auto-select* above is deliberate and correct: the Agents tree is the **initially focused** panel (§13.6), so it gets the one-time launch auto-select; the Teams tree is **never** the initial focus — the user only ever reaches it by Tabbing onto it — so it has no "launch" moment to auto-select at, and forcing a team selection the moment the user first Tabs in would add a selection they never made (the same force-a-selection problem §17.1 removes). The user was explicit that each panel owns its own selection and the toggle preserves it: *"if a team is selected and I shift+tab back to the Agents panel, then no agents should be selected … the selected team/agent stays selected as the user moves between panels."* So the Teams tree mirrors the Agents tree's no-selection rules (below) for its own selection state, and `j`/`k`/`shift+j`/`shift+k` from no-selection behave identically at team granularity:

- **The Teams panel starts in no-selection.** On dashboard startup no team or member row is selected; the `selection` getter returns `null` until the user navigates or a row is otherwise selected.
- **`j`/`k` from no-selection:** `j` selects the **first** visible row (the first team, or first row); `k` selects the **last** visible row. (After the first move the normal `navigate` wrap-around behavior takes over.)
- **`shift+j`/`shift+k` from no-selection:** `shift+j` selects the **first team anchor's** landing row; `shift+k` selects the **last team anchor's** — mirroring the `j`/`k` first/last rule at anchor granularity, exactly as the Agents tree's no-selection `shift+j`/`shift+k` rule does.
- **Empty registry:** the Teams tree is in no-selection by necessity (nothing to select) and renders the empty-state line (§17.2). [^callout] No-selection is therefore the steady state for an empty registry *and* the startup state for a populated one — the two cases share one code path.

### 17.2 The Teams Tree

A **flat-across-repos** tree grouped by **team**. Teams span repos (unlike the repo-grouped Agents tree), so the Teams tree is **not** nested under repo headers — a team is a top-level anchor whose members may live in any repo. It reuses the `FlatEntry`/anchor tree pattern from `AgentTreeComponent`.

**Row kinds.** Define a `TeamFlatEntry` discriminated union analogous to `FlatEntry` (`src/agents.ts`):

```ts
type TeamFlatEntry =
  | { kind: "team-header"; teamName: string; memberCount: number; createdEpoch: number; createdBy: string }
  | { kind: "team-member"; teamName: string; agent: Agent; connector: string };
```

- A **team** is an anchor row (`team-header`), the analogue of today's `repo-header`. It renders bold with a disclosure triangle, e.g. `▾ @backend  (3)`, where `(3)` is the live member count.
- Its **member agents** are `team-member` child rows beneath it (analogous to `{ kind: "agent" }` rows). The same `Agent` object the Agents tree uses is reused, so state/icon/age are identical.

**Building the list.** A `flattenTeamsTree()` helper (sibling to `flattenAgentTree()` in `src/agents.ts`, or co-located in `src/tui/teams-tree.ts`) reads `listTeams()` (`src/teams.ts`, §16.2 — an UNLOCKED pure read) and `readAllAgents()` (`src/agents.ts`), then for each team emits a `team-header` followed by one `team-member` per resolvable member id. **The member state must be the REAL detected state** — run `detectAgentStates()` (`src/agents.ts`) over the resolved member agents before building rows, exactly as the §16.3 `ib roster` fix does. A row must never show `"unknown"` for a member whose state is actually known; `displayState()` (`src/tui/agent-tree.ts`) maps a genuine `"unknown"` to `"running"` for display as it does today. This `detectAgentStates()` pass over the cross-repo member set runs on the dashboard's **existing refresh cadence** (the same per-tick rebuild that re-flattens the Agents tree, §13) — the Teams tree adds no new polling loop, so its cost is bounded by the refresh the dashboard already performs, not a separate timer.

**Member id that no longer resolves.** A member id with no live agent directory is **omitted** from the rendered tree (it is what the §16.5 lazy prune would remove). The Teams tree is a read-only view and must **not** mutate `teams.json` — lazy pruning remains the job of `ib send @<team>`/`ib roster` (§16.5). Showing only resolvable members keeps the tree honest without the dashboard taking the `.teams.lock`.

**Member row format.** Member rows reuse the **exact column order** of `formatAgentRow` (`src/tui/agent-tree.ts`) — icon + name + state + age (compact) and `+ model + prompt/summary` in full mode — so the Teams tree visually aligns with the Agents tree column-for-column. The only difference is that the cross-repo agent identifier is qualified with its repo: `<repo>/<id>` (where `<id>` is `agentDisplayName(agent)` — nickname if set, else id). The model lives in its own column after age, **not** bundled with the repo.

- **Compact mode** (`width <= 60`, the default sidebar width): `<connector><icon> <repo>/<id>  <state>  <age>`. Because the sidebar is narrow, `truncateToWidth` will clip the long `<repo>/<id>` prefix first; that is acceptable (the full data is in the info panel, §17.3). The icon comes from `resolveAgentIcon(agent.meta)`; the state is colored via `getStateColors()` like every other row.
- **Full mode** (wider sidebar): `<connector><icon> <repo>/<id>  <state>  <age>  <model>  <prompt/summary>`, matching `formatAgentRow`'s full-mode order exactly.
- The `<repo>/<id>` name is formatted as `${agent.repoName}/${agentDisplayName(agent)}` — e.g. `frontend/agent-6f61e45b`. The Agents tree omits the repo on each row because it groups by repo header; the Teams tree must add it back as a name prefix because members are cross-repo. Putting the repo on the name (not on the model) keeps the column layout identical to the Agents tree, just with a longer name token.

**Empty team.** A team with 0 members **still renders its anchor** (teams persist per §16.3 even when auto-pruned to empty). The header shows a zero count, e.g. `▾ @backend  (0 members)` (or just `(0)`), and no child rows follow. [^needs review] Exact empty-count wording (`(0)` vs `(0 members)`) is cosmetic and open; recommend `(0 members)` only when expanded/selected and `(0)` in the compact count badge, to match the `(3)` badge form above.

**Empty registry.** When `teams.json` has no teams, the Teams tree renders a single dim placeholder line — e.g. `  No teams (create with: ib team create @<name>)` — mirroring `AgentTreeComponent`'s `No agents found` empty line.

**Navigation (dual, like the Agents tree).** The Teams tree reuses the two-level navigation `AgentTreeComponent` exposes via `moveSelection` (j/k) and `moveToRepo` (shift+j/k):

- **`j`/`k`** move **one row at a time**: team → its first member → … → its last member → next team header → that team's first member → …  (i.e. `navigate(±1)` over the flat visible list).
- **`shift+j`/`shift+k`** move **anchor-to-anchor between teams**: `navigateAnchor(+1)` jumps to the next `team-header`, `navigateAnchor(-1)` to the previous — the analogue of `moveToRepo` cycling repo anchors, where each team is one anchor. Landing on a team header selects the header (a team anchor selection, §17.3). [^needs review] When `shift+j` lands on a team, does it select the **header** or the team's **first member**? Recommended default: **select the header** (so anchor-jump → team-channel view in the main area, the more useful destination), diverging from the Agents tree's `moveToRepo`, which lands on the first *agent* of a repo. Rationale: a repo header has no first-class "view" of its own, but a team header does (the channel). Flagged because matching the Agents-tree convention (land on first member) is the consistency-driven alternative.

**Scroll / height.** Reuse `MAX_TREE_HEIGHT` (7) and the scroll-indicator logic from `AgentTreeComponent.render` (the `▲ N more` / `▼ N more` indicators), so the Teams tree scrolls identically when it exceeds the visible window. Because Agents and Teams share the same sidebar tree region, they share the same height budget from `computeSidebarHeights` (`src/tui/sidebar.ts`) — whichever is focused renders into that budget.

### 17.3 Selection Semantics & the `@agent` Jump

**New `Selection` kind.** Extend the `Selection` union (`src/tui/selection.ts`) with a team-anchor kind; child agents reuse the existing `agent` kind:

```ts
export type Selection =
  | { kind: "agent"; agent: Agent }
  | { kind: "system-coordinator" }
  | { kind: "repo-header"; repoName: string; repoPath: string }
  | { kind: "team"; teamName: string }
  | null;
```

The Teams tree's `selection` getter returns `{ kind: "team", teamName }` when a `team-header` row is selected, and `{ kind: "agent", agent }` when a `team-member` row is selected. (The existing `repo-header`/`system-coordinator` kinds never originate from the Teams tree.)

**Team anchor selected (Teams panel focused, a `team-header` row):**

- **(a) Send dialog targets `@<teamName>`.** The `s`-key send handler (`handleSend`, `src/tui/agent-actions.ts`) currently branches on system-coordinator / repo-coordinator / selected-agent. Add a branch: when the focused panel is `teams-tree` and the selection is `{ kind: "team" }`, the send dialog prompt is `Send message to @<teamName>:` and `onSubmit` routes through the **team fan-out path** (`teamSend`, `src/ib-commands.ts`, §16.4) — i.e. the same code `ib send @<team>` runs, fanning out to all members except the sender. The dialog's existing "send to all" (`sendAll`/`Ctrl-A`) toggle is **not** shown for a team target (a team send already fans out; the all-agents broadcast is a different, repo-wide feature). The send is best-effort like every other dashboard send and reports the `teamSend` result string via `setNotice`. **`ActionCtx` extension required:** `handleSend` reads selection only from `ctx.agentTree` today, and `ActionCtx` (`src/tui/agent-actions.ts`) exposes no focused-panel handle and no Teams-tree selection. This branch needs both — it must know the focused panel is `teams-tree` and read the `{ kind: "team" }` selection from the `TeamsTreeComponent`. See §17.6's `agent-actions.ts` row for the concrete `ctx` fields to add.
- **(b) Main area shows the SHARED TEAM CHANNEL view** (§17.4) — the chat box tailing `<team>.channel.jsonl`. The main-area chat box is a new `ChannelPaneComponent` (§17.6) with a **`teamName` field** naming which team's channel to read — parallel to the info panel's `infoPanel.selectedTeam`. The dashboard's selection-sync sets **both** on a team-anchor selection: `infoPanel.selectedTeam` (info-panel team mode, §17.3c) **and** `channelPane.teamName` (the main-area chat box's read target), alongside the existing `rightPane.agent`/`tmuxPane.agent`/`infoPanel.agent` assignments it sets for agent selections. The channel pane then reads `readChannel(channelPane.teamName)` on the refresh cadence (§17.4). On a non-team or no selection, selection-sync clears `channelPane.teamName` (to `null`) so no stale team channel renders.
- **(c) Info panel shows team metadata.** The info panel (`InfoPanelComponent`, `src/tui/info-panel.ts`) gains a team mode (a `selectedTeam: { name, ... } | null` field set by the dashboard's selection-sync, parallel to `isSystemCoordinatorSelected`/`selectedRepoHeader`). It renders: team name (`@backend`), live member count, `created_by` and creation date — both read from the `Team` record (`teams.json` `Team.created_epoch` / `Team.created_by`, §16.2). Format the date with the existing `formatTimestamp` helper (`src/agent-lifecycle.ts`, exported as `_formatTimestamp`) applied to `new Date(created_epoch * 1000)` (epoch is **seconds**, §16.2).

**Teams panel focused with NO selection (the Teams no-selection main area).** Because the Teams tree starts in no-selection and stays there when the registry is empty (§17.1), the focused Teams panel can have `selection === null`. In that state the main area renders an **empty/placeholder view**, parallel to what the Agents panel shows in *its* no-selection state — **not** a stale prior agent's tmux pane. Recommended default: a single dim hint line such as `Select a team to view its channel`, kept consistent with the Agents-panel no-selection main area (the same placeholder discipline, just team-flavored copy). The info panel correspondingly clears its team mode (`selectedTeam = null`) so no stale team metadata lingers. State this explicitly so the implementer renders a deliberate placeholder rather than inventing a fallback.

**Child agent selected (Teams panel focused, a `team-member` row):** behaves **exactly** like selecting that same agent in the Agents panel:

- Main area shows that agent's tmux pane (the normal `tmuxPane` + `rightPane` split).
- The `s` send dialog sends **point-to-point** to that agent (`sendMessage(agent, …)`), not to the team — selecting a member is a window into the individual agent, not the room.
- The info panel shows the normal agent info (stoplights, model, summary) via the existing `InfoPanelComponent.agent` path.

In other words, a `{ kind: "agent" }` selection that *originated* in the Teams tree is **indistinguishable** downstream from one that originated in the Agents tree. The dashboard's selection-sync should funnel both into the same `rightPane.agent`/`tmuxPane.agent`/`infoPanel.agent` assignments (`src/tui/dashboard.ts` ~1170–1180), keyed only on `selection.kind === "agent"`.

**Selection-sync becomes focus-aware — a structural change, not "just a branch."** Today `syncSelectedAgent` (`src/tui/dashboard.ts` ~1146–1180) reads selection **exclusively** from `this.agentTree` (`this.agentTree.selectedAgent`, `.selectedRepoHeader`, `.isSystemCoordinatorSelected`, `.flatList`, etc.) — it is **focus-blind**. §17 requires selection-sync to gain a **focus-aware "effective selection" resolver** as a first step: when the focused panel is `teams-tree`, the effective selection comes from the `TeamsTreeComponent`; otherwise it comes from the `AgentTreeComponent` (the existing source). The resolver yields a single `Selection` value, and *that* value is then routed:

- For `{ kind: "agent" }` (originating from **either** tree), through the **existing** `rightPane.agent`/`tmuxPane.agent`/`infoPanel.agent` block, unchanged — the agent-origin path is shared verbatim, as stated above.
- For `{ kind: "team" }` (only ever from the Teams tree), through the **new** team-channel main-area path plus the info-panel team mode (§17.3c) and the channel-pane `teamName` (§17.6) — see the selection-sync assignments in §17.6's `dashboard.ts` row.
- For `null` (the focused tree is in no-selection, §17.1), through the corresponding panel's **no-selection** main area (the agent no-selection placeholder, or the Teams no-selection placeholder above).

This is deliberately framed as a **structural** edit: introduce an effective-selection resolver in front of the existing `this.agentTree`-only reads, rather than bolting one extra `if (selection.kind === "team")` onto a still-`agentTree`-rooted function. Underestimating it as "add a branch" leaves selection-sync unable to read the Teams tree at all.

**The `@agent` jump always force-selects in the Agents panel.** The fuzzy jump hotkey `@` (`handleFuzzyAgent`, `src/tui/agent-actions.ts`) always:

1. switches focus to the **Agents** panel (`focusManager.setFocus("agent-tree")`), and
2. highlights the chosen agent there (`agentTree.selectAgentById(id)` + `syncSelectedAgent()`),

**even if that agent is currently visible as a team member** in the Teams tree. The `@agent` jump is the **only** thing that force-selects an agent in the Agents panel — it sets the Agents panel out of its no-selection state (§17.1). Absent a jump, the Agents panel keeps its own independent selection (or no-selection), untouched by anything happening in the Teams panel. This makes "jump to the agent itself" unambiguous: it is always an Agents-panel operation, never a Teams-panel one. (The fuzzy list's contents are unchanged — it still searches agents and repo headers; teams are addressed by selecting a team row in the Teams tree, not via the `@`-fuzzy jump. [^needs review] Whether the `@`-fuzzy list should *also* offer team names as jump targets is a possible later refinement; v1 keeps `@`-fuzzy agent/repo-only to preserve the "jump always lands in the Agents panel" invariant — a team match would have to switch to the Teams panel, muddying the rule. Flagged.)

**Resize.** The Teams panel resizes the same as the other sidebar panels (§11.3, §13.3.1): `[`/`]` adjust width (focus-aware — when `teams-tree` is focused, width changes apply to the sidebar exactly as they do when `agent-tree` is focused, since the two share the sidebar region), and `{`/`}` adjust the sidebar panel's height by stealing from its neighbor. Because Agents and Teams occupy the **same** tree region, they share one width and one height budget; there is no separate Teams width to resize.

### 17.4 The Shared Team Channel (new persistence — the chat box)

**Problem.** Today `ib send @<team>` fans out to each recipient's tmux scrollback (§16.4); there is **no stored team-message log**, so a chat box would have nothing to render. §17 adds a persistent channel so the main-area team view has a real history to tail.

**Two files per team, under `~/.itsybitsy/teams/`** (a new `teams/` subdirectory beside `teams.json`, located via `getCoordinatorHome()`, `src/coordinator.ts` — the same home that owns `teams.json` and `.teams.lock`):

1. **`<team>.channel.jsonl` — the persistent CHAT HISTORY the chat box tails.** Each `ib send @<team>` (and each dashboard team-send) appends **one** JSON line:

   ```json
   { "ts": 1780166606, "fromAgent": "agent-a1b2c3d4", "message": "ship it" }
   ```

   - `ts` — creation time. [^needs review] Exact unit: **epoch seconds** (recommended, to match `Team.created_epoch` and the §16 convention; `Math.floor(Date.now() / 1000)`). Flagged only because the outbox uses `enqueuedAtMs` (ms); the channel is a *display* log, so matching the §16 `_epoch` seconds convention reads more consistently. Pick one and keep it uniform across the record.
   - `fromAgent` — the **resolved** sender id (the same value `teamSend` resolves via `resolveTeamSenderId`/`resolveSenderId`, §16.4): a real agent id, an `@`-sentinel (`@system`), or `""` for a human/CLI sender.
   - `message` — the raw message text (no `[sent by …]` prefix; the prefix is a tmux-delivery concern, reconstructed at render time by the chat box from `fromAgent`).

   [^needs review] The exact field names (`ts`/`fromAgent`/`message`) are open; these three are the recommended default and mirror the `OutboxMessage` field naming (`fromAgent`, `message`) so the two records read alike. Whatever is chosen, the read path must reconstruct **field-by-field** (not by spread), exactly as `readOutbox` does, so a future field can't silently round-trip-drop (§16.4 trap).

2. **`<team>.log` — a free-form per-team interaction LOG** for lifecycle/system events: join, leave, "N members left", team create/delete. One line per event (a timestamp prefix + free-form event text, the same shape `agent.log` uses via `formatTimestamp`). This is the **audit/debug** log and is **NOT** shown in the chat box — the chat box renders only `<team>.channel.jsonl`. The lifecycle notices (§16.4.1/§16.4.2) write a line here on their existing emit paths (`fireJoinNotice`, `emitPerAgentLeaveNotice`, `emitCoalescedLeaveNotice`, `teamRemove`, and `teamCreate`/`teamDelete` in `src/ib-commands.ts`).

   **Negative constraint (explicit):** the chat box **NEVER** reads or interleaves `<team>.log`. It calls `readChannel()` (the `.channel.jsonl`) **only** and ignores the `.log` entirely. The design deliberately separates **messages** (`<team>.channel.jsonl`, shown in the chat box) from **lifecycle/system notices** (`<team>.log`, audit only); do **not** merge the two for a "richer" combined view. A team's join/leave/create/delete events live in the `.log` for post-mortem and `ib state`-style debugging, never in the chat history the chat box tails. [^callout]

**Where the channel write happens.** The `<team>.channel.jsonl` append happens on the **`ib send @<team>` fan-out path — once per team send, not once per recipient.** Concretely, in `teamSend` (`src/ib-commands.ts`, §16.4): after the recipient set is resolved and the message is about to be (or has been) fanned out, append **one** channel record `{ ts, fromAgent: senderId, message }`. Place the append so it records the message **regardless of per-recipient delivery success** (the channel is the *room's* history; a delivery failure to one member does not mean the message wasn't "said"). It must **not** be inside the `for (const recipient of recipients)` loop — that would write N duplicate lines. It should also fire for an **empty-recipient** team send (self-only or zero-survivor) **only if** the team actually exists and the human/agent meant to post to the room — [^needs review] recommended default: **append when the team exists and the message is non-empty, even if the recipient set is empty after sender-exclusion**, so a sender talking to a room they're the sole member of still sees their own line in the channel history. Flagged because the alternative (only append when ≥1 recipient) is also reasonable; the empty-recipient send currently returns `teamOk("no recipients in @<team>")` (§16.4), and the channel should reflect that the message was posted to the room either way.

**Placement note (precise).** In `teamSend` (`src/ib-commands.ts`), the `appendChannelMessage` call must be placed **AFTER the team-not-found check** (`if (!pruneRes.team) return teamErr("Error: team @<name> not found")` — so a nonexistent team writes no channel record) **but BEFORE the empty-recipient early return** (`if (recipients.length === 0) return teamOk("no recipients in @<team>")`). Concretely: insert the append immediately above that early return. This ordering is what makes the recommended "append even for an empty-recipient send when the team exists" default actually fire — an append placed adjacent to the per-recipient `for` loop (which is reached only *after* the early return) would silently skip the empty-recipient case, defeating the default. The sender id must be resolved before the append, since the append records `fromAgent`: `senderId` is already resolved at the top of `teamSend` via `resolveTeamSenderId` (before the not-found check), so it is available at the placement point — pass `fromAgent: senderId` (mapping `""` → human/CLI sender, per the record shape above). Keep the existing guidance otherwise: append **once per send, NOT inside the recipient loop**, and **best-effort** (a failed append never fails the send).

The append is **best-effort** and uses the **same jsonl-append discipline as `outbox.ts`** (§4.1.1): a single-line `appendFile(JSON.stringify(record) + "\n")` after a `mkdir(teamsDir, { recursive: true })` no-message-loss safeguard; a failure to append never fails the send.

**Read / tail semantics (the chat box).** A new module (`src/team-channel.ts`, §17.6) exposes `appendChannelMessage(teamName, record)` and `readChannel(teamName, opts?)`:

- `readChannel` reads the file, splits on `\n`, skips blank/malformed lines (tolerant line-skipping, **never throws** — mirrors `readOutbox` and `readTeams`), and reconstructs each record **field-by-field**. A **missing file** returns `[]` (no channel yet → empty chat box), exactly as `readOutbox` returns `[]` for a missing queue.
- The chat box renders the **last N lines** (newest at the **bottom**, oldest scrolling off the top), scrollable like the tmux pane's scroll-back (`;`/`l` scroll, `scrollBack` from the bottom, §13). N is bounded by the rendered pane height plus a scroll-back budget (the `TmuxPaneComponent` pattern of capturing only as much as the pane will render, `src/tui/dashboard.ts`).
- **Refresh cadence (the chat box stays current — concrete mechanism, not "polls somehow").** The dashboard **re-reads the channel** (`readChannel`) on its **existing main-area refresh cadence for the selected entry** — i.e. the *same* periodic refresh/poll loop that already updates the selected agent's tmux pane and right-pane content (§13 / the `TmuxPoller`-style ~1 s cadence and the watcher refresh that drive `updateContent`/the per-tick re-render, `src/tui/dashboard.ts`). When the selected entry is a team anchor, that same tick re-invokes `readChannel(teamName)` and re-renders the chat box, so the channel updates **while** the team is selected, not only on selection change. **Do NOT** assume "refresh on selection-change only" — that would leave the chat box frozen at its first read for the entire time a team stays selected (a new `ib send @<team>` line would never appear). **Do NOT** introduce a new `fs.watch` on `<team>.channel.jsonl` unless it is trivial; the simplest correct default is exactly this: re-read on the same tick the dashboard already re-renders the selected entry's main area. (Cheap by construction: `readChannel` reads at most the pane-height + scroll-back budget worth of lines, the same bound the tmux pane uses.)
- Each line is **sender-prefixed** like the §16.4 delivery prefix but **without the tmux mechanics AND with the ` in @<team>` clause OMITTED** — the chat box already lives under the selected team's view, so the team name is the panel context and repeating it on every line is noise. The in-pane form is therefore: for an agent sender, `[sent by <repoName>/<fromAgent>]: <message>` **when the agent's repo is known** (cross-repo disambiguation — many teams span repos), falling back to `[sent by <fromAgent>]: <message>` **when the repo lookup misses** (the literal word "agent" is still dropped in both forms, matching §16.4's team-context divergence — the panel context itself establishes that the sender is an agent in this room). For a **human/CLI** sender (`fromAgent === ""`), match §16.4's human-form grammar but with the same in-pane shortening: `[sent by user <name>]: <message>` **when a `user.name` is configured**, and `[sent by user]: <message>` **when it is not** (the bare "user" form is only the no-`user.name` case, not the only case). The delivery prefix (§16.4) — used when the message is actually *typed into* a recipient's tmux pane — keeps the ` in @<team>` clause as documented above. A timestamp gutter (from `ts`) may be shown on the left. [^needs review] Whether to show the `ts` gutter and in what format (relative age vs clock time) is a cosmetic open decision; recommend a short clock time (`HH:MM`) gutter for scannability. [^needs review] The agent → repo lookup is **dashboard-driven**: the dashboard builds an `id → repoName` map from the same `Agent[]` it already passes to `onUpdate` (the watcher's per-tick pass) and assigns it to `channelPane.agentRepoById`; the chat-box renderer threads it into the per-line formatter. Because the watcher reads agents with `includeArchived: false`, **archived agents are not in the map** and their historical chat lines render with the bare-id fallback rather than `<repoName>/<id>` — accepted as the cost of avoiding an unconditional archive scan on every tick. The fallback is also what covers a cross-coordinator sender whose agent record isn't in the local watcher's view at all.

**Concurrency — no lock needed for the channel.** Appends from concurrent `teamSend` calls do **not** require a lock. A single-line `appendFile` of a sub-`PIPE_BUF` record is **atomic on POSIX** (O_APPEND), so concurrent appenders never interleave a half-written line — this is the exact rationale `outbox.ts`/§4.1.1 relies on for `enqueueOutbox`. This is **unlike `teams.json`** (§16.2), which needs `.teams.lock` because it is **read-modify-write** (a lost-update race); the channel is **append-only**, so there is nothing to lose-update. State this explicitly so no one adds a needless `.channel.lock`. The tolerant read (skip a torn final line) covers the vanishingly rare partial-write case, identical to `readOutbox`.

**Cleanup on team delete.** [^needs review] When `ib team delete @<name>` (§16.3) tears down a team, the channel files may either be removed or left as history. Recommended default: **`ib team delete` removes both `<team>.channel.jsonl` and `<team>.log`** (best-effort `unlink`, ignore-if-missing), so a deleted team leaves no orphaned files and a later `ib team create @<name>` of the same name starts with a clean channel rather than inheriting a stale predecessor's chat. Flagged because "leave them as history" is defensible (post-mortem value) — if chosen, document that re-creating a team of the same name would resurrect the old channel, which is the surprising case the recommended default avoids. `deleteTeam` (`src/teams.ts`) does the registry delete under the lock; the file cleanup belongs in the `teamDelete` command wrapper (`src/ib-commands.ts`), beside where it already calls `deleteTeam`, not in the locked registry primitive.

### 17.5 Cross-Cutting Impact (the mandated four perspectives + dashboard)

1. **General agent functionality** — **largely unaffected.** No change to how an agent is spawned, to its `meta.json` shape, or to its lifecycle. The only new behavior on a non-dashboard path is the **channel append** in `teamSend` (a best-effort `appendFile` on the existing fan-out, §17.4) and the lifecycle notices additionally writing to `<team>.log` on their existing emit paths. Team membership remains centrally stored (§16.2), so nothing here touches per-agent state.
2. **Hooks** — **unaffected.** This is a dashboard surface plus a send-path append. None of the agent-session hooks (agent-path, agent-status, permission-denied, intercept-task, session-start) or primary-Claude hooks (main-path, inject-status) change. (The session-start team-awareness injection already landed in §16.6 and is not modified here.) **Confirmed.**
3. **Watchdog** — **unaffected.** The watchdog has no team role (§16.5/§16.7.3 — it never tears down agents, never emits leave notices, and does not read the channel). Nudge timing, rate-limit recovery, and state detection are all untouched. **Confirmed.**
4. **`ib watch` / dashboard** — **this is the main impact.** New `FocusTarget "teams-tree"` and its `FOCUS_ORDER` placement (§17.1); new `Selection` kind `{ kind: "team" }` (§17.3); a new `TeamsTreeComponent` (cross-repo, team-grouped, real detected state) plus `flattenTeamsTree()` and a `TeamFlatEntry` union (§17.2); an info-panel **team mode** (team metadata, §17.3c); a main-area **channel view** (the chat box, §17.4) via a new `ChannelPaneComponent` and the **focus-aware effective-selection resolver** in `syncSelectedAgent` (§17.3); **both** trees' new **no-selection** state (symmetric, §17.1) and the **independent-selection** invariant (§17.1); the `s`-send handler's new **team-target branch** routing to `teamSend` and the `ActionCtx` focus/teams-handle extension it needs (§17.3a); and the `@`-fuzzy jump's **force-select-in-Agents** rule (§17.3). **Layout persistence:** [^needs review] does the Teams panel need its own persisted width/height in `layout.json` (`LayoutState`, `src/tui/layout.ts`)? Recommended default: **no new fields** — because the Teams panel **shares** the sidebar tree region with the Agents panel (§17.1), it shares the existing `sidebarWidth` and `heightOffsets.tree`/`heightOffsets.info`. No `teamsWidth`/`teamsHeightOffset` is added. Flagged so the implementer consciously confirms the shared-region model rather than adding a redundant persisted size. (One small consideration: the *focused-vs-resting* choice between Agents and Teams is **not** persisted — the dashboard always rests on Agents at startup, §13.6; persisting "last viewed Teams" is out of scope.)

### 17.6 Affected Files and Modules

| Module | Changes needed |
|--------|---------------|
| `src/tui/focus.ts` | Add `"teams-tree"` to the `FocusTarget` union and insert it into `FOCUS_ORDER` **between `"agent-tree"` and `"info"`** (§17.1). Do **not** add it to `COORDINATOR_FOCUS_ORDER` or `skipTargets` (§17.1). No change to `cycle()`/`setFocus()` logic beyond the new ordering entry. |
| `src/tui/selection.ts` | Add `{ kind: "team"; teamName: string }` to the `Selection` union (§17.3). |
| `src/tui/teams-tree.ts` (new) | `TeamsTreeComponent` (recommended over a mode flag, §17.1): a `TeamFlatEntry` union (`team-header` \| `team-member`), `flattenTeamsTree()` reading `listTeams()` + `readAllAgents()` + `detectAgentStates()` (real state, §17.2), `selectedIndex` + a **no-selection-aware** `selection` getter returning `{ kind: "team" }` / `{ kind: "agent" }`, `navigate` (j/k one-at-a-time) and `navigateAnchor` (shift+j/k team-to-team), member-row format with `repo/model` (compact-aware via `COMPACT_WIDTH_THRESHOLD`), empty-team anchor `(0 members)`, empty-registry placeholder, and `MAX_TREE_HEIGHT` scroll indicators reused from the agent-tree pattern. |
| `src/agents.ts` | (If `flattenTeamsTree`/`TeamFlatEntry` are co-located with the other tree helpers rather than in `teams-tree.ts`.) Otherwise unchanged — `readAllAgents`, `detectAgentStates`, `resolveAgentIcon` are reused as-is. |
| `src/tui/agent-tree.ts` | Add the **no-selection** state to `AgentTreeComponent` (a `hasSelection` flag; `selection` returns `null` when unset; `j`/`k` from no-selection → first/last; `shift+j`/`shift+k` → first/last anchor; `setFlatList` does not re-assert selection when previously unset — §17.1). `formatAgentRow` is reused by the Teams tree's member rows (extended with the `repo/model` token, or a parallel `formatTeamMemberRow` in `teams-tree.ts`). |
| `src/tui/sidebar.ts` | Render whichever tree matches the focused panel: `agent-tree` → `AgentTreeComponent`, `teams-tree` → `TeamsTreeComponent`, into the **shared** tree region (one `Agents`/`Teams` separator title chosen by focus; the two share `computeSidebarHeights` budget and the sidebar width). Hold the `TeamsTreeComponent` reference alongside `agentTree`. |
| `src/tui/info-panel.ts` | New **team mode**: a `selectedTeam` field (parallel to `isSystemCoordinatorSelected`/`selectedRepoHeader`) and a render branch showing team name, live member count, `created_by`, and creation date (`_formatTimestamp(new Date(created_epoch * 1000))`) from the `Team` record (§17.3c). |
| `src/tui/dashboard.ts` | Wire the new panel: construct `TeamsTreeComponent` and a `ChannelPaneComponent` (the main-area chat box). **Make `syncSelectedAgent` (~1146–1180) focus-aware** (§17.3, structural — not "just a branch"): introduce an **effective-selection resolver** in front of the current `this.agentTree`-only reads — focus `teams-tree` ⇒ selection from `TeamsTreeComponent`, else from `AgentTreeComponent` — then route that one `Selection`: `{ kind: "agent" }` (from **either** tree) → the existing `rightPane.agent`/`tmuxPane.agent`/`infoPanel.agent` assignments (point-to-point send); `{ kind: "team" }` → main area renders the **channel chat box** and selection-sync sets **both** `infoPanel.selectedTeam` (team mode) **and** `channelPane.teamName` (the chat box's read target), with send-target `@<team>`; `null` → the panel's no-selection placeholder (agent or Teams, §17.1/§17.3). Clear `infoPanel.selectedTeam`/`channelPane.teamName` to `null` on any non-team selection so no stale team state lingers. Route Tab/Shift+Tab through the extended `FOCUS_ORDER`. Add the channel chat-box render in the main area (tail `readChannel(channelPane.teamName)` on the **existing per-tick/`TmuxPoller` refresh cadence**, newest-at-bottom, `;`/`l` scroll, sender-prefixed lines incl. the §16.4 named human form, §17.4). |
| `src/tui/agent-actions.ts` | **Extend `ActionCtx` with focus + teams handles (additive).** `handleSend`/`handleFuzzyAgent` read selection only from `ctx.agentTree` today, and `ActionCtx` exposes neither a focused-panel handle nor the Teams-tree selection. Add to `ActionCtx`: a `focusManager` (or focused-panel) handle — needed by the team-send branch (which gates on "focused panel === `teams-tree`") and by the `@`-jump's `setFocus("agent-tree")` — and the `TeamsTreeComponent` selection (e.g. a `teamsTree` field with the `selection` getter). This is structurally satisfied already (`DashboardComponent` holds the `FocusManager` and `TeamsTreeComponent`, so it satisfies the widened `ActionCtx` structurally) — the point is to **add the `ctx` fields** so the handlers can read them, not discover the ctx is focus-blind. `handleSend`: add a **team-target branch** (focused panel `teams-tree` + `{ kind: "team" }` from `ctx`) that opens a `Send message to @<team>:` dialog and routes `onSubmit` through `teamSend` (§16.4); suppress the `sendAll`/`Ctrl-A` toggle for team targets (§17.3a). `handleFuzzyAgent` (`@` jump): on select, `focusManager.setFocus("agent-tree")` then `selectAgentById` so the jump **always** force-selects in the Agents panel and leaves no-selection (§17.3). |
| `src/tui/channel-pane.ts` (new) | `ChannelPaneComponent` — the main-area chat box. Holds a **`teamName` field** (parallel to `infoPanel.selectedTeam`), set by the dashboard's selection-sync on a team-anchor selection and cleared to `null` otherwise (§17.3c). `render(width)` reads `readChannel(teamName)` (`src/team-channel.ts`) on the dashboard's existing refresh tick (§17.4), renders the last N lines newest-at-bottom with sender-prefixed lines (agent form + §16.4 named/anonymous human form, §17.4/§17.3), supports `;`/`l` scroll-back, and renders the no-selection/empty-channel placeholder when `teamName` is `null` or the channel is empty (§17.3). May reuse the `TmuxPaneComponent` scroll/height pattern. |
| `src/team-channel.ts` (new) | The channel persistence module: `channelPath(teamName)` / `teamLogPath(teamName)` under `getCoordinatorHome()/teams/`; `appendChannelMessage(teamName, { ts, fromAgent, message })` (single-line `appendFile` after `mkdir` recursive, best-effort, **no lock** — append-only atomicity, §17.4); `readChannel(teamName)` (tolerant, field-by-field reconstruction, `[]` on missing file); `appendTeamLog(teamName, text)` (timestamped free-form line); `deleteChannelFiles(teamName)` (best-effort `unlink` of both files, used by `teamDelete`). Mirrors `outbox.ts` append/read discipline (§4.1.1). |
| `src/ib-commands.ts` (`teamSend`) | Append **one** channel record per team send via `appendChannelMessage` — outside the per-recipient loop, best-effort, recording the message regardless of per-recipient delivery success and (recommended) even for an empty-recipient send when the team exists (§17.4). |
| `src/ib-commands.ts` (notice + create/delete paths) | The lifecycle notices write a line to `<team>.log` via `appendTeamLog` on their existing emit paths (`fireJoinNotice`, `emitPerAgentLeaveNotice`, `emitCoalescedLeaveNotice`, `teamRemove`); `teamCreate`/`teamDelete` log create/delete events; `teamDelete` also calls `deleteChannelFiles` (recommended cleanup, §17.4). |
| `src/tui/layout.ts` (`LayoutState`) | **No new fields** (recommended, §17.5): the Teams panel shares `sidebarWidth` + `heightOffsets.tree`/`info` with the Agents panel. Confirm the shared-region model rather than adding `teamsWidth`/`teamsHeightOffset`. |

---

## 18. Codex CLI as Alternative Agent Model

This section summarizes the design landed in Phases 0–4 + 6 + 7 of `SPEC-CODEX-MODEL.md` (the design source-of-truth). Phase 5 (codex tmux-overrides parser for `rate_limited`/`api_error`/`compacting`) is **DEFERRED** and runs last; Phase 8 (this docs fold-in) is in flight on `agent/codex-agent`. Everything below is implemented and merged unless explicitly flagged otherwise.

### 18.1 Goal

itsybitsy can launch an agent under either Anthropic's `claude` CLI or OpenAI's `codex` CLI (v0.135.0). The CLI is selected per-agent via a **`<cli>:<model>`** model string (e.g. `claude:opus`, `codex:gpt-5.4-mini`) — itsybitsy parses the prefix to choose the underlying CLI, with **no inference and no hidden model→CLI guessing table**. Codex agents launch the interactive `codex` TUI inside tmux exactly the way Claude agents launch today; their permissions are enforced by a generated PreToolUse hook handler (codex has no `permissions.allow/deny` array equivalent), configured deny-by-default so the agent never shows an approval prompt and runs unattended in tmux. Non-goals: no headless/`codex exec` agent loop, no new dashboard panes, no multi-provider abstraction beyond claude|codex.

### 18.2 Authoritative Decisions

Verbatim from `SPEC-CODEX-MODEL.md` §2:

| # | Decision |
|---|---|
| D1 | **`<cli>:<model>`** is the model string. The CLI is NAMED, not inferred. `claude:` and `codex:` prefixes are **required**. Bare names (`opus`, `o3`) are **rejected** as invalid. |
| D2 | Codex agents launch **headed/interactive in tmux**, like Claude — NOT `codex exec`. Preserves `C` (open-in-Ghostty → live interactive session). |
| D3 | **Reuse the same agent-type permission lists** (`_all.md` / `_non_coordinator.md` / `<type>.md`). Translate `allow`/`deny` into a generated PreToolUse hook handler on the codex side (no `permissions.allow/deny` array equivalent in codex). |
| D4 | **Auto-deny anything not granted by a hook; never prompt.** Codex runs unattended in tmux and must never surface an approval modal. |
| D5 | **No backwards compatibility, no migration.** Existing meta.json / config files with bare names are invalid under the new format; the user fixes them by hand. |
| D6 | **Unknown CLI = hard-reject at spawn** with a clear message ("Unknown CLI '<X>' in model '<X>:<model>'; known: claude, codex"). No silent fallback. |
| D7 | Scope = SPEC + phased implementation, verified incrementally. |
| D8 | **Display the canonical `<cli>:<model>` form everywhere.** Dashboard info-panel, agent-tree column, anywhere the model is shown. Under D1/D5 all stored values are already qualified — UI renders them verbatim. |
| D9 | **Every agent-type's `.md` frontmatter may set `model:`** (qualified `<cli>:<model>` form). Applies to every type: `system.md`, `coordinator.md`, `manager.md`, `worker.md`, plus any user-defined type. Coordinators are NOT claude-only — they may be set to a codex model via their agent-type frontmatter. |

### 18.3 Model String Format

The model string is **always** `<cli>:<model>`. Bare names are rejected.

**Grammar:**

```
model-string := cli ":" model-rest
cli          := [A-Za-z][A-Za-z0-9-]*          ; alphanumeric+dash, must start with a letter
model-rest   := <everything after the FIRST ":">  ; greedy to end; preserved verbatim
```

Split on the **first** colon; the model half is greedy-to-end (`claude:claude-opus-4-7` → `{cli:"claude", model:"claude-opus-4-7"}`). The `cli` half is compared case-insensitive, whitespace-trimmed, against `KNOWN_CLIS = new Set<AgentCli>(["claude", "codex"])`. The `model` half is preserved verbatim (preserves case for `claude --model`).

**Module surface (`src/agent-cli.ts`):**

```ts
export type AgentCli = "claude" | "codex";
export const KNOWN_CLIS = new Set<AgentCli>(["claude", "codex"]);
export interface ParsedModel { cli: AgentCli; model: string; }
export function parseModel(input: string): ParsedModel;     // throws on missing colon, malformed cli, or unknown cli
export function resolveCli(model: string): AgentCli;        // thin wrapper over parseModel(m).cli
```

**Validation order at spawn:**

1. `isValidModel(input)` — shell-safety syntactic check (regex widened to allow `:`).
2. `parseModel(input)` — throws on missing/wrong colon, malformed cli, or unknown cli (D6 hard-reject).
3. Pass `parseModel(input).model` (the model half, e.g. `"opus"`) to the CLI flag; branch the launch on `parseModel(input).cli`.

`meta.json` stores the **raw qualified value** verbatim (e.g. `"claude:opus"`) — never the parsed pieces. `parseModel(meta.model).cli` is computed on demand wherever the discriminator is needed.

**Reasoning effort (codex side).** The resolved effort level (§2 item 4) is threaded to codex as an inline `-c model_reasoning_effort="<level>"` override alongside the other `-c` flags. Codex's value set is only `low`/`medium`/`high` — it has no `xhigh`/`max` — so `mapEffortForCodex` (`src/agent-cli.ts`) collapses the itsybitsy 5-level scale down: `low→low`, `medium→medium`, `high/xhigh/max→high`. `meta.json` stores the **raw itsybitsy level** verbatim (e.g. `"xhigh"`); the codex mapping happens only at launch-arg build time. Because `model_reasoning_effort` is a `-c` config override (not the rollout-bound `-m <model>`), codex **resume** re-applies it via the same `buildCodexLaunchArgs`, so effort carries over on codex resume — unlike `-m <model>`, which codex resume deliberately drops.

### 18.4 Permission Model (Codex side)

Codex has no `permissions.allow/deny` array, no `--allowedTools` / `--disallowedTools` CLI flags. itsybitsy expresses the same agent-type allow/deny lists as a generated PreToolUse hook handler dispatched from `src/index.ts`. The canonical codex launch line is:

```
codex -m <MODEL> -a never -s workspace-write \
      --dangerously-bypass-hook-trust \
      -c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-pre-tool-use <agentId>",timeout=30}]}]' \
      -c 'hooks.SessionStart=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-session-start <agentId>",timeout=30}]}]' \
      -c 'hooks.Stop=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-stop <agentId>",timeout=30}]}]' \
      "<prompt>"
```

Where `<MODEL>` is the model half of the parsed `<cli>:<model>`, `<abs ib>` is the absolute path to the `ib` binary resolved at spawn time, and `<agentId>` is the itsybitsy agent id.

**Permission mode mapping** (the claude-side `--permission-mode` analogue):

| Claude `--permission-mode` | Codex equivalent |
|---|---|
| `acceptEdits` | `-a never -s workspace-write` ← itsybitsy default for codex agents |
| `plan` | `-a untrusted -s read-only` |
| `bypassPermissions` / `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` (aka `--yolo`) |

**Key constraints (the gritty ones):**

- `-a never` is "never PROMPT", not "deny everything by default." Without the PreToolUse hook a tool call would be ALLOWED (subject to sandbox). The hook returning deny-by-default is what makes D4 (auto-deny-anything-not-granted) true.
- `-s workspace-write` is leaky on macOS — it permits writes to `/private/tmp` (`/tmp`), `$TMPDIR`, and `~/.codex/memories` by default. The hook MUST do path-isolation; sandbox alone is insufficient. **Hook is the primary boundary, sandbox is defense-in-depth.**
- `--dangerously-bypass-hook-trust` is **mandatory on every spawn** because codex hashes every hook command and the inline-`-c` payload's hash changes per spawn (the `<agentId>` interpolates into it). Without the bypass, a regenerated hook is silently skipped — a permission-bypass disaster. User-approved bypass per D4.
- The launch line is built by `buildCodexLaunchArgs()` in `src/codex-config.ts`, which reads the SAME merged allow/deny lists used for Claude (`_all.md` + `_non_coordinator.md` + `<type>.md`) via `loadMergedAgentTypePermissions()`.
- `~/.codex/config.toml` is NEVER modified by itsybitsy. The user's existing trust entries, model defaults, and other codex config are left untouched. Inline-`-c` registration bypasses codex's project-trust gate entirely (Phase 2 spike Q2).

### 18.5 Hook Architecture (Codex side)

Three codex-side hook handlers, all dispatched through a fail-open-safe wrapper:

| Hook | Subcommand | Handler | Purpose |
|---|---|---|---|
| **PreToolUse** | `ib hooks codex-pre-tool-use <agentId>` | `src/hooks/codex-pre-tool-use.ts` | Allow/deny + path-isolation for `Bash` AND `apply_patch`. Default: deny. |
| **SessionStart** | `ib hooks codex-session-start <agentId>` | `src/hooks/codex-session-start.ts` | Writes `state: "running"` to `meta.json`; captures `meta.codex_session_id` on first firing (defensive snake_case/camelCase read). |
| **Stop** | `ib hooks codex-stop <agentId>` | `src/hooks/codex-stop.ts` | Writes `state: "waiting"` / `"complete"` to `meta.json` (deterministic state — no tmux scraping). |

**Dispatcher pattern (`src/hooks/codex-dispatcher.ts`):** all three handlers are invoked through a single dispatcher that NEVER throws and ALWAYS exits 0 in the production path. Codex's documented hook failure mode is **FAIL-OPEN** (a hook that crashes, emits malformed JSON, or returns an unsupported `permissionDecision` is marked failed and the tool call PROCEEDS per `developers.openai.com/codex/hooks`). The dispatcher is the defense:

- Wraps all handler logic in try/catch; emits a deny payload on any uncaught exception.
- Validates `<agentId>` as the first argv before doing any other work; emits deny + `exit 0` on parse failure.
- Module-import failure or any other pre-handler error MUST emit a deny payload + `exit 0` — NEVER `exit non-zero` (codex treats any non-zero dispatcher exit as a fail-open crash).
- Supports a `--dry-run` flag for the spawn-time precheck (§18.6 / §18.7). Dry-run is the only path that may exit non-zero (so the spawn caller can fail cleanly).

**PreToolUse JSON contract:**

- **Deny:** `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>"}}` (always include the reason — omitting it triggers a separate codex error path).
- **Allow:** `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":<echo of original tool_input>}}` — standalone `permissionDecision: "allow"` is rejected by codex as "unsupported permissionDecision:allow" and FAIL-OPENs (Phase 2 spike B1). The echo-back-original-input pattern is a documented no-op rewrite, verified working.
- **Default (no match):** deny.

**apply_patch handling:** PreToolUse fires for both `Bash` AND `apply_patch` on v0.135.0. For `apply_patch`, the handler parses the patch body — grepping lines starting with `*** Add File:`, `*** Update File:`, `*** Delete File:` — and extracts the target path. apply_patch is treated as path-only-gated: the handler synthesizes a `{toolName: "Write", toolInput: {file_path: <target>}}` call and reuses `checkPathAccess`'s path-isolation logic (prepending `"Write"` to the allow list for the synthesized call). Operators who want to forbid file edits entirely should use `-a never -s read-only` instead of relying on tool-name allow lists.

### 18.6 Spawn Path

`newAgent()` in `src/ib-commands.ts` branches on `parseModel(model).cli`:

- **claude path:** unchanged (byte-snapshot-guarded at `tests/fixtures/claude-start-sh-baseline.sh` — any drift fails CI).
- **codex path:** generates a codex-shaped `start.sh` via `buildCodexStartContent()` in `src/codex-spawn.ts`. The codex branch:
  1. Skips `<worktree>/.claude/settings.local.json` entirely (codex doesn't read it).
  2. Appends `.codex/` to `<worktree>/.gitignore` via `appendCodexGitignoreEntry()` (idempotent; respects `!.codex/` negation) to cover any incidental files codex itself drops.
  3. Writes a per-agent `<worktree>/AGENTS.md` via `writeCodexAgentsMd()` containing the role/session-start instructions (codex reads `AGENTS.md` natively — replaces what `session-start.ts` injects for Claude). The `<ittybitty>` wrapper from the session-start template is stripped via `stripIttybittyWrapper()` before writing.
  4. Runs a spawn-time precheck: invokes `ib hooks codex-pre-tool-use --dry-run <agentId>` and the SessionStart + Stop counterparts before launching codex. If any dispatcher fails to resolve (binary missing, module-import crash), the spawn fails cleanly — closing the out-of-process fail-open hole.
  5. Generates `start.sh` launching the §18.4 canonical line in tmux. Same `setsid … &` + `wait` + `exit-check` skeleton as the claude path; same SIGHUP-ignore insulation. PID capture goes through the `ib write-pid` subcommand (§18.11), not an inline `bun -e` snippet.

`resolveIbBinaryPath()` resolves the absolute `ib` path with a `Bun.which("ib") → process.execPath` fallback chain (eliminates PATH dependency in codex's spawn environment). `isCodexSafeBinaryPath()` rejects paths containing `'`, `"`, `\`, or control characters — a belt-and-suspenders defense against TOML-in-shell quoting bugs, called both in `buildCodexLaunchArgs()` AND in the upstream `newAgent()` precheck.

Coordinators cannot currently be spawned under codex: `newAgent()` rejects `codex:` for `--coordinator` with `"codex coordinators not yet implemented; use claude:<model>"` (Phase 4 review HIGH 1). Full codex-coordinator support is a later phase.

### 18.7 Resume Path

`resumeAgent()` in `src/ib-commands.ts` branches on `parseModel(meta.model).cli`:

- **claude path:** unchanged (byte-snapshot-guarded at `tests/fixtures/claude-resume-sh-baseline.sh`).
- **codex path:** validates that `meta.codex_session_id` is present (populated by the SessionStart hook on first spawn); runs the same spawn-time dispatcher precheck as `newAgent()`; generates a codex-shaped `resume.sh` via `buildCodexResumeContent()` in `src/codex-spawn.ts`. The resume script invokes `codex resume "<UUID>"` with the SAME re-passed inline `-c` hook flags + `-a never -s workspace-write --dangerously-bypass-hook-trust` flags as the original spawn. Same SIGHUP-ignore insulation, same `ib write-pid` PID capture.

Resume is a hot-reload-equivalent: any change to the agent-type allow/deny lists takes effect on the next resume (codex has no live hot-reload — §18.13 Risk 4).

### 18.8 Watchdog (Codex side)

`runPerAgentWatchdog` in `src/watchdog.ts` branches Claude-specific behaviors behind a `classifyAgentCli(meta)` helper (= `parseModel(meta.model).cli`). Three Claude-only behaviors are gated:

- **`handleRateLimited`** — uses claude's `usage limit reached` / `/upgrade` UI strings and the claude-specific bare-Enter bypass. Skipped for codex agents.
- **`handleApiError`** — uses claude's API error UI signature. Skipped for codex agents.
- **Permission auto-accept** — unnecessary for codex (`-a never` + hooks already prevent prompts). Skipped for codex agents.

Everything else stays CLI-agnostic:

- Per-agent outbox delivery (`drainOutbox` + `runSessionExclusive` mutex).
- `fs.watch`-driven drain coalescing.
- Idle/nudge timing (the nudge text itself is claude-tuned but is short and harmless on codex; refining it is part of the future watchdog Phase 6 work on the codex side).
- Notifications (manager / spawner / coordinator routing through the `@`-sentinel namespace).

### 18.9 State Detection (Codex side)

The deterministic half landed in Phase 3: codex agents reach the canonical `MetaState` (`running` / `waiting` / `complete`) via the SessionStart and Stop hooks writing `state` to `meta.json` through `writeAgentState()`. `detectAgentStates()` reads `state` from meta.json with the same precedence as for claude agents.

The override states (`compacting`, `rate_limited`, `api_error`) are **DEFERRED** to Phase 5 of `SPEC-CODEX-MODEL.md` — they need empirically-captured codex UI strings from real interactive sessions. In the interim, codex agents surface `unknown` for these overrides; the deterministic `running` / `waiting` / `complete` states from the hooks still work correctly. Capturing the codex UI strings synthetically risks chasing the wrong regex, so the parser waits until codex agents from Phases 6/7/8 have generated real transcripts.

### 18.10 meta.json Additions

One new optional field on `AgentMeta` (`src/agents.ts:49`):

```ts
codex_session_id?: string;  // populated on first codex SessionStart hook firing; used by codex resume
```

The existing `session_id` (the spawn-generated UUID) is retained for claude. `codex_session_id` is independent — codex has its own rollout-id model. Defensively read both `session_id` AND `sessionId` from hook payloads in case a future codex version renames the field (Risk 7).

`model` stays the discriminator. No `cli` field is added — `parseModel(meta.model).cli` is computed on demand.

### 18.11 `ib write-pid` subcommand

A small mutate-meta-from-shell helper introduced in Phase 4 review HIGH 2 (commit `85588fd`). Both claude `start.sh` + `resume.sh` AND codex `start.sh` + `resume.sh` write the launched CLI process's PID into `meta.json` via:

```
ib write-pid <agent-id> <pid>
```

The subcommand routes through `mutateAgentMeta()` in `src/agents.ts` so concurrent meta.json writers (the PID write, racing with a SessionStart-driven `codex_session_id` capture, or any other hook-driven mutation) can't clobber each other. Previously the spawn scripts used an inline `bun -e` snippet to merge a PID into the meta file, which had a lost-update race when a SessionStart hook fired before the PID write completed.

### 18.12 Cross-Cutting Impact (Four-Perspective Checklist)

Per the mandated `CLAUDE.md` Cross-Cutting Review Checklist:

1. **General agent functionality** — **affected.** New spawn (§18.6) and resume (§18.7) paths branch on a new CLI discriminator derived from `meta.model`. Codex agents skip the claude-side `settings.local.json` write entirely and instead get a generated `<worktree>/AGENTS.md` + `.codex/` gitignore entry. One new optional meta field (`codex_session_id`, §18.10). One new mutate-meta-from-shell subcommand (`ib write-pid`, §18.11) used by spawn scripts of BOTH CLIs.
2. **Hooks** — **affected.** Three new codex-side hook handlers (PreToolUse, SessionStart, Stop) dispatched through a fail-open-safe dispatcher with `--dry-run` support (§18.5). All three are registered via inline `-c` flags at spawn time (no on-disk codex config is written). Claude-side hooks are unchanged.
3. **Watchdog** — **affected.** Three Claude-specific behaviors (`handleRateLimited`, `handleApiError`, permission auto-accept) are gated behind `classifyAgentCli(meta)` (§18.8). The outbox drain, `fs.watch` coalescing, `runSessionExclusive` mutex, nudge timing, and notification routing stay CLI-agnostic.
4. **`ib watch` / dashboard** — **largely unaffected.** Info-panel and agent-tree render `meta.model` verbatim (D8), so `codex:<model>` displays correctly with no special split required. No new modes, no new panels, no new layout fields. (State detection in the dashboard for codex's override states is deferred — §18.9.)

### 18.13 Open Risks

Open items from `SPEC-CODEX-MODEL.md` §7 that have NOT been closed by the implementation:

| # | Risk |
|---|------|
| 3 | **Hash-pinned trust + mandatory `--dangerously-bypass-hook-trust`.** Codified per-spawn in `buildCodexLaunchArgs()`. User-accepted bypass per D4. Scope of the flag beyond hook-trust is not empirically tested; revisit if codex's release notes change its semantics. |
| 4 | **No hot-reload.** Codex config/hook edits require a fresh session. Mutating an agent's permissions mid-session means killing+respawning, not editing. |
| 5 | **`SubagentStart` is documented but not battle-tested** (issues #14754/#18888). If/when itsybitsy needs to gate codex sub-agent spawning, verify it fires reliably before relying on it. |
| 6 | **State-detection brittleness.** Hook-driven deterministic state is preferred; tmux overrides (§18.9) are a thin supplement deferred to Phase 5. |
| 7 | **Codex version drift.** All facts pinned to v0.135.0; flags/contracts may change. Defensively read hook-payload fields (`session_id` AND `sessionId`) to survive snake_case → camelCase renames. Stamping `codex --version` into `meta.json` at spawn time is a future enhancement. |
| 9 | **No `--allowedTools` / `--disallowedTools` / `permissions.allow/deny`.** The inline-`-c` PreToolUse handler is the only path. Architecturally fine, but more code than Claude needs. |
| 11 | **Codex hook contract is FAIL-OPEN.** Crashes, malformed JSON, standalone `permissionDecision: "allow"`, and unsupported decisions all result in the tool call PROCEEDING. Mitigations layered: handler try/catch, dispatcher fail-open-safe wrap, absolute `<abs ib>` path resolution, spawn-time `--dry-run` precheck. Monitor hook-fail rate via PostToolUse or external telemetry to detect gating regressions in production. |
| 12 | **ChatGPT-account model availability is constrained.** Only models in `~/.codex/models_cache.json` are reachable on ChatGPT-auth: `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review`. `gpt-5-codex` returns HTTP 400. itsybitsy cannot pre-validate client-side; the HTTP 400 surfaces cleanly in the TUI after the first prompt. |
| 14 | **Inline-`-c` TOML-in-shell path safety.** `<abs ib>` is interpolated into a TOML string literal inside a shell single-quoted argument. `isCodexSafeBinaryPath()` rejects paths containing `'`, `"`, `\`, or control characters. itsybitsy's default install paths are safe; this guards against user-customized installs. |

### 18.14 Affected Files and Modules

Grep-able file list for the codex implementation:

| File | Role |
|------|------|
| `src/agent-cli.ts` | `AgentCli` type, `KNOWN_CLIS` set, `parseModel()`, `resolveCli()`, `isCodexModel()` — the model-string parser. |
| `src/codex-config.ts` | `buildCodexLaunchArgs()` (inline-`-c` flag array builder), `isCodexSafeBinaryPath()`, `renderCodexHookFlagPayload()`, `loadMergedAgentTypePermissions()`, `buildCodexDenyOutput()`, `buildCodexAllowOutput()`. |
| `src/codex-spawn.ts` | `buildCodexStartContent()`, `buildCodexResumeContent()`, `appendCodexGitignoreEntry()`, `buildCodexAgentsMd()`, `writeCodexAgentsMd()`, `resolveIbBinaryPath()`, `stripIttybittyWrapper()`. |
| `src/hooks/codex-pre-tool-use.ts` | PreToolUse handler — allow/deny + path-isolation for Bash AND apply_patch. |
| `src/hooks/codex-session-start.ts` | SessionStart handler — writes `state: "running"` + captures `codex_session_id`. |
| `src/hooks/codex-stop.ts` | Stop handler — writes `state: "waiting"` / `"complete"`. |
| `src/hooks/codex-dispatcher.ts` | Fail-open-safe wrapper around all three handlers; supports `--dry-run`. |
| `src/ib-commands.ts` | `newAgent()` + `resumeAgent()` codex branches (calls `buildCodexStartContent` / `buildCodexResumeContent`); rejects `codex` for `--coordinator`. |
| `src/watchdog.ts` | `classifyAgentCli(meta)` gate on `handleRateLimited`, `handleApiError`, permission auto-accept. |
| `src/index.ts` | Routes for `hooks codex-pre-tool-use` / `hooks codex-session-start` / `hooks codex-stop` (all via `codex-dispatcher.ts`); `write-pid` subcommand. |
| `src/agents.ts` | `codex_session_id?: string` on `AgentMeta`; `mutateAgentMeta()` helper used by `ib write-pid`. |
| `tests/fixtures/claude-start-sh-baseline.sh` | Byte-snapshot regression guard — claude spawn script must remain unchanged. |
| `tests/fixtures/claude-resume-sh-baseline.sh` | Byte-snapshot regression guard — claude resume script must remain unchanged. |

### 18.15 Reference: SPEC-CODEX-MODEL.md

The design source-of-truth for codex CLI support is **`SPEC-CODEX-MODEL.md`** in the repo root. It carries the full evidence trail (Phase 2 spike findings, reviewer feedback fold-ins, per-phase commit history) that this §18 summarizes. Future codex SPEC changes update `SPEC-CODEX-MODEL.md` first, then this §18 summary follows. The supporting research docs (`SETTINGS-HOOKS-RESEARCH.md`, `MODEL-NAME-FORMAT-PROPOSAL.md`, `CODEX-CLI-NOTES.md`) referenced from `SPEC-CODEX-MODEL.md` are evidence-only and not summarized here.

---

# itsybitsy (ib) — Behavioral Specification

This document is the definitive behavioral specification for itsybitsy, a multi-agent orchestration system for Claude Code. It uses tmux sessions, git worktrees, and a hook system to manage isolated, concurrent Claude agents.

---

## 1. Agent Lifecycle

### 1.1 Agent Creation

When a new agent is created (`ib new-agent "prompt"`):

1. **Validate inputs**: A prompt is required. If `--manager` is specified, the manager must exist and must not be a worker agent. Worker agents cannot manage sub-agents.

2. **Auto-detect manager**: If no `--manager` is provided and the caller is running inside an agent worktree (CWD matches `/.ittybitty/agents/<id>/repo`), the caller's agent ID is automatically set as the manager.

3. **Yolo escalation prevention**: A `--yolo` child cannot be spawned by a non-yolo parent. This prevents permission escalation where a constrained agent spawns an unconstrained one. The parent's yolo status is checked via `meta.json` or `start.sh`.

4. **Configuration**: Config is loaded from `.ittybitty.json` (project) and `~/.ittybitty.json` (user). The model is determined by: `--model` flag > config `model` > `"sonnet"` (default).

5. **Max agents check**: The number of active agents (directories with `meta.json` in `.ittybitty/agents/`) must not exceed the `maxAgents` config value (default: 10).

6. **Generate agent ID**: Either `--name NAME` or `agent-<8 random hex chars>` (e.g., `agent-a1b2c3d4`).

7. **Tmux session naming**: The tmux session name is `ittybitty-<repo-id>-<agent-id>`, where `<repo-id>` is an 8-character hex identifier stored in `.ittybitty/repo-id`. This prevents session collisions across different repositories.

8. **Git worktree setup** (default, unless `--no-worktree`):
   - Branch name: `agent/<agent-id>`
   - Base ref: If the agent has a manager, branch from `agent/<manager-id>`. Otherwise, branch from `HEAD`.
   - Command: `git -C <root-repo> worktree add <agent-dir>/repo -b <branch-name> <base-ref>`

9. **Settings**: A `settings.local.json` is written to `<agent-dir>/repo/.claude/` containing:
   - Merged permissions (mandatory + config + existing)
   - Hook definitions (path-check, stop, permission-denied, session-start, optionally intercept-task)
   - The agent ID placeholder `__AGENT_ID__` is replaced with the actual ID after writing

10. **Write meta.json** to `<agent-dir>/meta.json` (see §5.2 for fields).

11. **Write prompt.txt** with the full prompt including any completion instructions, custom prompts, and the user's task.

12. **Write start.sh**: A bash script that:
    - Adds the git root to `$PATH` (so `ib` is available)
    - Clears `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` env vars (allows nesting)
    - Starts `claude --session-id <uuid> <args> "$(cat prompt.txt)"` in background
    - Captures the Claude PID into `meta.json`
    - Runs `exit-check.sh` after Claude exits

13. **Write exit-check.sh**: Interactive script (for manual agent inspection) that checks for uncommitted changes and unpushed commits after the agent session ends.

14. **Start tmux session**: `tmux new-session -d -x 60 -s <session-name> -c <work-path> <start.sh>`

15. **Auto-accept workspace trust**: For non-yolo agents, a background process polls tmux output for permission prompts ("Do you trust the files", "trust this folder", "Allow external CLAUDE.md file imports") and sends Enter to accept them. Runs up to 5 attempts with 4-second waits between each.

16. **Auto-spawn watchdog**: If the agent has a manager, `ib watchdog <id>` is spawned in the background.

17. **Output**: The agent ID is printed to stdout immediately after tmux session creation.

### 1.2 Agent States

Agents can be in one of 8 states:

| State | Description |
|-------|-------------|
| `creating` | Claude is initializing — permission screens showing, or tmux output has too few lines and no startup markers |
| `running` | Actively executing — tool calls, thinking spinners, or interrupt markers visible |
| `waiting` | Idle — explicit `WAITING` keyword, or tool-level "⎿ Waiting" indicator. Note: these are semantically different (agent idle vs tool executing) but intentionally map to the same state. |
| `complete` | Agent output contains `I HAVE COMPLETED THE GOAL` not inside single-quoted strings, in last 15 lines |
| `compacting` | Context window compaction in progress ("Compacting conversation" in last 5 lines) |
| `rate_limited` | Hit API rate limits — "rate_limit_error", "usage limit reached", "hit your limit", etc. |
| `stopped` | Tmux session does not exist, or agent is archived |
| `unknown` | No patterns matched, or empty/missing tmux output |

### 1.3 State Detection

State detection follows this flow:

1. **Archived agents** are always `stopped` (no tmux capture attempted).

2. **Missing tmux session** → `stopped`.

3. **Pre-parseState check**: If the tmux output has fewer than 10 non-empty lines AND no startup markers (`"Claude Code v"`, `"[USER TASK]"`, `"╭─ Claude Code"`, `"[AGENT CONTEXT]"`), the state is `creating`. This handles the early startup case before enough output exists for pattern matching. Priority 1 below handles the case where there ARE enough lines but startup markers are still absent (e.g., a workspace trust prompt is showing on a fresh screen).

4. **parseState priority order** (checked top-to-bottom, first match wins):

   | Priority | Window | Pattern | State |
   |----------|--------|---------|-------|
   | 1 | Full input | Workspace trust/import prompts ("Do you trust the files", "trust this folder", "Allow external CLAUDE.md") present AND no startup markers found anywhere in output | `creating` |
   | 2 | Last 5 lines | "Compacting conversation" | `compacting` |
   | 3 | Last 5 lines | `(Esc to interrupt`, `(ctrl+c to interrupt`, `⎿  Running` | `running` |
   | 4 | Last 15 lines | `⎿  Waiting` (tool waiting) | `waiting` |

   > **Note**: The bash reference implementation checks tool waiting (priority 4) before active running (priority 3). The TypeScript reimplementation intentionally reverses this order so that active execution indicators in very recent output (last 5 lines) take precedence over tool waiting in the broader window (last 15 lines). Both orderings are valid; implementers should document which they choose.
   | 5 | Last 15 lines | `rate_limit_error` or usage limit phrases (case-insensitive) | `rate_limited` |
   | 6 | Last 15 lines | Unquoted `I HAVE COMPLETED THE GOAL` | `complete` |
   | 7 | Last 15 lines | Standalone `WAITING` on its own line (unless ⏺ appears after it = stale) | `waiting` |
   | 8 | Last 15 lines | `ctrl+b ctrl+b` or `thinking)` | `running` |
   | 9 | Last 15 lines | Thinking spinners (✽✶✢·✻✳) at line start (excluding hook spinners, completion timers) | `running` |
   | 10 | Last 15 lines | Permission prompts ("Enter to confirm" + trust/imports) | `creating` |
   | 11 | Last 20 lines | Spinners with interrupt markers (broader window) | `running` |
   | 12 | Last 15 lines | Background tasks pattern (`⏵⏵.*·\s\d+\s`) | `running` |
   | 13 | Last 15 lines | "running stop hook" without ⏺ (race condition) | `creating` |
   | 14 | — | No patterns matched | `unknown` |

   **Hook spinner filtering**: Lines beginning with a spinner character (✽✶✢·✻✳) that also contain the word "hook" are excluded before spinner checks.

   **Stale WAITING check**: If `⏺` (Claude's output marker) appears after the last `WAITING` in the window, the agent has resumed work → `running` instead of `waiting`.

   **ANSI stripping**: All tmux output must have ANSI escape sequences stripped before pattern matching.

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
2. Kill the tmux session
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
7. Auto-spawn watchdog

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
2. Worker agents cannot be nuked (use `kill` instead) — only managers with descendants are nuke targets
3. For each descendant: remove questions, teardown (same sequence as kill)
4. Clean up orphaned tmux sessions (sessions with `ittybitty-` prefix that don't match any remaining agent)
5. Scan and kill orphaned Claude processes

Nuke-all (`ib nuke --force`) kills all agents in the repository.

---

## 2. Manager vs Worker Agents

### 2.1 Distinction

The `--worker` flag at creation time determines the agent's role:

| Property | Manager | Worker |
|----------|---------|--------|
| `meta.json` `worker` field | `false` | `true` |
| Can spawn sub-agents | Yes (via `ib new-agent --worker`) | No |
| Can use Task tool | Intercepted → spawns ib agents | Blocked by path hook |
| Can ask user questions | Only if top-level (no manager) | No |
| Permissions source | `permissions.manager.allow/deny` | `permissions.worker.allow/deny` |
| Session-start instructions | Manager template (with sub-agent commands) | Worker template (with send/diff/status only) |
| TaskCreate | Blocked with "Use ib new-agent --worker" message | Blocked with "Workers cannot create tasks" message |

### 2.2 Manager Permissions

When building `settings.local.json` for an agent, permissions come from three sources, merged and deduplicated:

1. **Existing base settings**: From the root repo's `.claude/settings.local.json`
2. **Mandatory permissions** (always added for all agents):
   - `Bash(ib:*)`, `Bash(./ib:*)` — ib commands (both forms to handle PATH vs relative invocation)
   - `Bash(git status:*)`, `Bash(git add:*)`, `Bash(git commit:*)`, `Bash(git diff:*)`, `Bash(git show:*)`, `Bash(git log:*)`, `Bash(git ls-files:*)`, `Bash(git grep:*)`, `Bash(git rm:*)`, `Bash(git merge:*)`, `Bash(git rebase:*)`, `Bash(git checkout:*)`, `Bash(git restore:*)`, `Bash(git reset:*)` — git operations
   - `Bash(pwd:*)`, `Bash(ls:*)`, `Bash(head:*)`, `Bash(tail:*)`, `Bash(cat:*)`, `Bash(grep:*)` — filesystem inspection
   - `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `TodoWrite`, `Task`, `TaskOutput`, `KillShell`, `NotebookEdit`, `WebFetch`, `WebSearch`, `AskUserQuestion` — Claude Code tools
3. **Config-defined permissions**: From `permissions.manager.allow/deny` or `permissions.worker.allow/deny` in `.ittybitsy.json`

**Always denied** (for all agents): `EnterPlanMode`, `ExitPlanMode`

### 2.3 Manager Sub-Agent Spawning

Managers spawn workers with `ib new-agent --worker "task"`. The manager's agent ID is automatically set as the `--manager` for the child. The child's branch forks from `agent/<manager-id>`.

### 2.4 Unfinished Children Check

When a top-level manager (no manager of its own) signals completion, the stop hook checks for unfinished children — agents in `.ittybitty/agents/` whose `meta.json` `manager` field matches the completing agent's ID. If any exist, the agent receives a nudge message listing them and instructing it to merge or kill each one before completing.

---

## 3. Merge Behavior

### 3.1 is_running_as_agent() Detection

The merge strategy depends on whether the caller is an agent or a user. Detection uses two checks:

1. **CWD path pattern**: `/.ittybitty/agents/<id>/repo` anywhere in the current working directory
2. **TMUX session name**: If inside tmux, the session name starts with `ittybitty-`

If either check matches, the caller is considered an agent.

### 3.2 Pre-Merge Checks

Before merging, the following are verified:

1. Agent directory exists with `meta.json`
2. Agent has a worktree directory (`<agent-dir>/repo`)
3. Caller is not inside the agent's own worktree
4. Agent worktree has no uncommitted changes
5. Current directory (caller's repo) has no uncommitted changes
6. Agent branch (`agent/<id>`) exists
7. Pre-rebase conflict check passes (creates a temp branch/worktree, attempts rebase, cleans up)

### 3.3 Target Branch Detection

The target branch is determined from the caller's context:

1. `git branch --show-current` — the caller's current branch
2. Fallback to `main` if it exists
3. Fallback to `master` if it exists
4. Error if none found

**Critical**: The target is the current branch in the CWD, not necessarily `main`. When a manager merges a worker, the target is the manager's branch (`agent/<manager-id>`).

### 3.4 Merge Execution

1. **Rebase**: `git -C <worktree-path> rebase <target-branch>` — rebase the agent's branch onto the target in the agent's worktree
2. **Checkout**: `git -C <repo-path> checkout <target-branch>` — switch to target branch in the caller's repo
3. **Merge** (strategy depends on caller):
   - **Agent caller (manager merging sub-agent)**: `git merge --ff-only <agent-branch>` — fast-forward only
   - **User caller (top-level merge)**: `git merge --no-ff <agent-branch> -m "Merge agent <id> work"` — always creates a merge commit

### 3.5 Post-Merge Cleanup

After successful merge:

1. Capture tmux output to `output.log`
2. Kill Claude process
3. Kill tmux session
4. Copy `settings.local.json` from worktree to agent dir
5. Remove git worktree
6. Delete git branch
7. Archive artifacts
8. Remove questions for this agent
9. Remove agent directory
10. Scan for orphaned Claude processes

---

## 4. Message Passing

### 4.1 ib send

`ib send <target-id> "message"` sends text to an agent's tmux session:

1. **Resolve target**: Partial ID matching is supported (prefix/substring match against agent directories and tmux sessions). Must resolve to exactly one agent.
2. **Verify running**: The target's tmux session must exist.
3. **Auto-detect sender**: If called from within an agent worktree, the sender's agent ID is read from `meta.json`.
4. **Format message**: If a sender is detected, the message is prefixed: `[sent by agent <sender-id>]: <message>`
5. **Send via tmux**: `tmux send-keys -t <session> -l "<message>"` (literal flag prevents key interpretation), then after a calculated delay, `tmux send-keys -t <session> Enter` separately.
6. **Delay calculation**: `0.1 + (message_length / 100) * 0.5` seconds, clamped to [0.2, 3.0]. Longer messages need more time for the paste to complete in tmux.
7. **Logging**: Both sender and recipient get entries in their `agent.log`.

### 4.2 ib ask

`ib ask "question"` allows top-level managers to ask the user questions:

1. **Auto-detect agent ID** from CWD if in an agent worktree
2. **Top-level check**: Only agents with no manager (or whose manager has been merged/killed) can ask. Others are told to use `ib send` to communicate with their manager.
3. **Config check**: `allowAgentQuestions` must be `true` (default)
4. **Question storage**: Questions are appended to `.ittybitty/user-questions.json`
5. **Question ID format**: `q-<unix-epoch>-<6-char-hash>`

### 4.3 user-questions.json Structure

```json
{
  "questions": [
    {
      "id": "q-1704825600-abc123",
      "agent": "agent-a1b2c3d4",
      "question": "Should I proceed with the refactoring?",
      "timestamp": "2024-01-09T20:00:00Z",
      "status": "pending",
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

`ib acknowledge <question-id>` marks a question as handled. Only the primary (user-level) Claude can acknowledge — agents are blocked via `is_running_as_agent()` check.

---

## 5. Worktree / Agent Directory Structure

### 5.1 Directory Layout

```
<repo-root>/
  .ittybitsy/
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
        settings.local.json          # Copied from worktree on kill/merge
        output.log                   # Captured tmux output (on kill/merge)
        last-nudge                   # Unix timestamp of last nudge (stop hook debounce)
        nudge-recheck                # Marker file for delayed recheck scheduling
        watchdog.log                 # Watchdog process output
        debug-logs/                  # Debug captures from stop hook
          stop-<epoch>-<state>.txt
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
  "yolo": false,
  "model": "sonnet",
  "claude_pid": "12345"
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
| `worker` | boolean | `true` for worker agents, `false` for managers |
| `yolo` | boolean | Whether `--yolo` (skip permissions) was used |
| `model` | string | Claude model name (e.g., "sonnet", "opus", "haiku") |
| `claude_pid` | string | PID of the Claude process (added after start.sh launches Claude) |

### 5.3 Worktree ↔ Branch Relationship

Each agent's worktree is linked to a git branch named `agent/<agent-id>`:

- Top-level agents branch from `HEAD` of the main repo
- Worker/sub-agents branch from `agent/<manager-id>`
- All branches are local (no remote tracking)
- The worktree is at `.ittybitty/agents/<id>/repo`
- On merge or kill, both the worktree and branch are removed

### 5.4 Archive Structure

Archives are stored at `.ittybitty/archive/<YYYYMMDD-HHMMSS>-<agent-id>/` using the local time of archival. The same files as listed in §1.7 are preserved.

---

## 6. Hooks

itsybitsy installs five hooks into each agent's `settings.local.json`, plus optional global hooks in `~/.claude/settings.json`.

### 6.1 Path Isolation Hook (PreToolUse)

**Command**: `ib hook-check-path <agent-id>`
**Matcher**: `*` (all tools)
**Hook type**: PreToolUse (runs before tool execution, can allow/deny)

**Decision logic** (checked in order):

1. **TaskCreate always denied**: Workers get "Workers cannot create tasks." Managers get "Use ib new-agent --worker."
2. **Allow list check**: Tool must match at least one pattern from `settings.local.json` `permissions.allow`. Patterns are either exact tool names (`"Read"`) or bash prefix patterns (`"Bash(git status:*)"` — matches Bash tool where command starts with `git status`).
3. **Bash cd commands**: If the tool is Bash and the command starts with `cd`, the target path is checked against the allowed paths.
4. **Bash command scanning**: Non-cd bash commands are scanned for path references to:
   - Other agents' directories (`.ittybitty/agents/<other-id>/`)
   - The main repo root (when it differs from the worktree)
   Only paths at word boundaries (preceded by space, quote, `=`, or start of string) are checked.
5. **File path extraction**: For non-Bash tools, `file_path`, `path`, or `notebook_path` from `tool_input` is checked.

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

**Detection flow**:
1. Try to detect state from `last_assistant_message` (check last non-empty line for "WAITING" or "I HAVE COMPLETED THE GOAL")
2. If no match, fall through to tmux capture + `parseState()`
3. Save debug capture to `debug-logs/stop-<epoch>-<state>.txt`

**Actions by state**:

| State | Action |
|-------|--------|
| `rate_limited` | No action (rate limiter handles itself) |
| `running` with background tasks | No action (agent is still working) |
| `unknown` or `running` (no bg tasks) | **Nudge** — debounced (5s), sends "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL'" via tmux |
| `complete` with uncommitted changes | **Remind commit** — sends message telling agent to commit |
| `complete` with manager | **Notify manager** — sends "[hook]: Your subtask <id> just completed" to manager's tmux |
| `complete` without manager, with unfinished children | **Remind children** — tells agent to merge/kill all sub-agents |
| `complete` without manager, no children | No action |
| `waiting` with manager | **Notify manager** — sends "[hook]: Your subtask <id> is now waiting for input" |
| `waiting` without manager | No action |

**Debounce mechanism**: A `last-nudge` file stores the unix timestamp of the last nudge. If less than 5 seconds have passed, the nudge is suppressed. When debounced, a delayed recheck is scheduled (5s later) via a background `bash -c "sleep 5 && ib hooks agent-status <id>"` process, using a `nudge-recheck` marker file to prevent duplicate rechecks.

### 6.3 Session Start Hook

**Command**: `ib hooks session-start`
**Matcher**: (none — fires on SessionStart)
**Hook type**: SessionStart

**Role detection** based on CWD:
- If CWD does not match `/.ittybitty/agents/<id>/repo` → **primary** (user-level Claude)
- If CWD matches and `meta.json` has `worker: true` → **worker**
- If CWD matches and `worker` is false/absent → **manager**

**Output**: JSON with `hookSpecificOutput.additionalContext` containing role-appropriate instructions wrapped in `<ittybitty>` tags. Instructions include:

- **Primary**: Available `ib` commands for spawning and managing agents
- **Manager**: Agent identity, worktree path, git context, sub-agent commands, workflow guidance, state management (`WAITING`/`I HAVE COMPLETED THE GOAL`), ask capability (top-level only)
- **Worker**: Agent identity, worktree path, git context, send/diff/status commands only, state management, communication with manager

### 6.4 Intercept Task Hook (PreToolUse)

**Command**: `ib hooks intercept-task`
**Matcher**: `Task`
**Hook type**: PreToolUse

Intercepts Claude Code's Task tool and redirects it to spawn ib agents instead:

1. **Only intercepts `Task` tool** — all other tools pass through
2. **Skip for certain subagent_types**: `Bash`, `statusline-setup`, `claude-code-guide`, `meta-agent`, `ib-merge` pass through unintercepted
3. **Model validation**: Only `sonnet`, `opus`, `haiku`, or empty string are allowed
4. **Spawn behavior**:
   - When called from an agent context: spawns a `--worker` with the calling agent as `--manager`
   - When called from primary Claude: spawns a manager (no `--worker`)
5. **Output**: Rewrites the Task invocation to a `claude-code-guide` subagent that simply reports the spawned agent ID

This hook is only installed for manager agents (not workers), and only when the main repo's settings already have the intercept hook installed. Workers' Task calls are instead blocked by the path hook's TaskCreate denial (§6.1).

### 6.5 Permission Denied Hook (PermissionRequest)

**Command**: `ib hook-permission-denied <agent-id>`
**Matcher**: `*`
**Hook type**: PermissionRequest

Fires when Claude requests permission for a tool that isn't auto-allowed. Simply logs `[PermissionRequest] Tool denied: <tool-name>` to `agent.log`. Cannot override permissions — PermissionRequest hooks are informational only. Always exits 0 with no stdout output.

### 6.6 Global Hooks (installed in ~/.claude/settings.json)

These are optional hooks that the user installs globally:

- **Main-path hook** (`ib hooks main-path`): PreToolUse hook on Bash matcher that prevents agents from operating outside their designated paths
- **Intercept-task hook** (`ib hooks intercept-task`): PreToolUse hook on Task matcher (global version, enables task interception for all repos)
- **Status injection hooks** (`ib hooks inject-status`): UserPromptSubmit and PostToolUse hooks that inject agent status information into the primary Claude's context
- **Session-start hook** (`ib hooks session-start`): SessionStart hook that injects ittybitty context

Install/uninstall commands modify `~/.claude/settings.json` directly.

---

## 7. Configuration

### 7.1 Config File Layering

Configuration is read from two files, with project settings taking precedence:

1. **Project config**: `.ittybitsy.json` in the repository root
2. **User config**: `~/.ittybitsy.json` in the user's home directory
3. **Defaults**: Built-in defaults for each key

For each config key, the first valid value found (project → user → default) is used.

### 7.2 Config Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxAgents` | number | `10` | Maximum concurrent agents per repo |
| `model` | string | `"sonnet"` | Default Claude model for new agents |
| `fps` | number | `10` | Target frame rate for `ib watch` TUI |
| `createPullRequests` | boolean | `false` | Instruct agents to create PRs on completion |
| `allowAgentQuestions` | boolean | `true` | Allow top-level managers to ask user questions via `ib ask` |
| `autoCompactThreshold` | number | (none) | Context usage % above which auto-compact triggers |
| `externalDiffTool` | string | (none) | External diff tool command |
| `hooks.injectStatus` | boolean | `true` | Enable status injection hooks |
| `hooks.statusVisible` | boolean | `true` | Make status injection visible in output |
| `permissions.manager.allow` | string[] | `[]` | Additional allowed tools for manager agents |
| `permissions.manager.deny` | string[] | `[]` | Additional denied tools for manager agents |
| `permissions.worker.allow` | string[] | `[]` | Additional allowed tools for worker agents |
| `permissions.worker.deny` | string[] | `[]` | Additional denied tools for worker agents |

### 7.3 Permission Resolution

For a given agent type (manager or worker):

1. Start with the base settings from `.claude/settings.local.json` in the repo root
2. Add mandatory permissions (§2.2)
3. Add config-defined permissions for the agent's role
4. If worker-specific permissions are empty, fall through to manager permissions
5. Deduplicate all allow/deny lists

### 7.4 Custom Prompts

Custom prompt files in `.ittybitsy/prompts/`:

| File | Injected into |
|------|--------------|
| `all.md` | All agents (wrapped in `[CUSTOM INSTRUCTIONS]`) |
| `manager.md` | Manager agents (wrapped in `[CUSTOM MANAGER INSTRUCTIONS]`) |
| `worker.md` | Worker agents (wrapped in `[CUSTOM WORKER INSTRUCTIONS]`) |

---

## 8. Supplementary Behaviors

### 8.1 Partial ID Resolution

Agent IDs can be specified as partial strings. Resolution:

1. **Exact match** — check tmux session and agent directory
2. **Substring match** — scan all agent directories and tmux sessions for the pattern
3. If 0 matches → error. If 1 match → use it. If 2+ matches → error listing all matches.

### 8.2 Agent Logging

All agent events are logged to `<agent-dir>/agent.log` with format:
```
[YYYY-MM-DD HH:MM:SS] message
```

### 8.3 Orphan Detection and Cleanup

After kills/nukes, the system scans for orphaned Claude processes:

1. Find all processes matching "claude" via `pgrep`
2. For each, determine its CWD (macOS: `lsof -d cwd`, Linux: `/proc/<pid>/cwd`)
3. If CWD contains `/.ittybitty/agents/` and the agent directory no longer exists → orphan
4. Kill orphans with SIGTERM → wait 2s → SIGKILL

### 8.4 Auto-Compact

Reads Claude transcript JSONL files to determine context window usage percentage. When an agent exceeds the configured threshold (`autoCompactThreshold`), sends `/compact` to the agent's tmux session.

### 8.5 Watchdog

`ib watchdog <id>` runs as a background loop for agents with a manager, polling agent state every 5 seconds. It continues running while the agent's worktree directory exists.

**Monitoring behaviors by state:**

| State | Action |
|-------|--------|
| `waiting` | Increment waiting counter. When counter reaches the notification threshold, notify manager: "[watchdog]: Your subtask <id> recently started waiting for input". Uses exponential backoff: initial threshold 30s (6 polls), doubles after each notification, capped at 64 minutes. |
| `complete` | Notify manager once: "[watchdog]: Your subtask <id> recently completed". Sets a flag to prevent duplicate notifications. Flag resets if agent returns to `running`. |
| `unknown` | Treat like `waiting` — increment counter with same exponential backoff. Also saves a debug capture of tmux output to `debug-logs/watchdog-<epoch>-unknown.txt`. |
| `rate_limited` | Attempt to bypass the rate limit dialog. Then poll Claude's usage API; when session usage drops below 5%, send nudge: "[watchdog]: Usage has refreshed (<pct>%). Please continue your task." |
| `running` | Reset waiting counter and notification interval. Clear completion flag if previously set. |
| `creating` | Treat as running — reset counters. |
| `compacting` | No action — wait for completion. |
| `stopped` | Reset counters. |

**Auto-compact**: If `autoCompactThreshold` is configured, the watchdog also checks the agent's context window usage on each poll. When usage exceeds the threshold and the agent is not currently compacting, sends `/compact` to the agent's tmux session. The compact flag resets when compacting completes.

**Quiet mode** (`--quiet`): Allows monitoring agents without managers. All notifications are logged but not sent.

### 8.6 Root Repo Resolution

When running from a worktree, the root repository is found via:

1. `git rev-parse --git-common-dir` to find the shared `.git` directory
2. If the result is `.git` or matches `--git-dir`, we're in the main repo → use `--show-toplevel`
3. Otherwise, go up one directory from the common dir to find the root

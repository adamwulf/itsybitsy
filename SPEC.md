# itsybitsy (ib) — Behavioral Specification

This document is the definitive behavioral specification for itsybitsy, a multi-agent orchestration system for Claude Code. It uses tmux sessions, git worktrees, and a hook system to manage isolated, concurrent Claude agents.

**Annotations used in this document:**

- **[^callout]** — Marks an intentional divergence between the bash reference implementation and the TypeScript reimplementation. The description explains what differs and why.
- **[^needs review]** — Marks a claim that could not be fully verified against the source, or where the correct behavior is ambiguous and needs a decision.

---

## 1. Agent Lifecycle

### 1.1 Agent Creation

When a new agent is created (`ib new-agent "prompt"`):

1. **Validate inputs**: A prompt is required. If `--manager` is specified, the manager must exist and must not be a worker agent. Worker agents cannot manage sub-agents.

2. **Auto-detect manager**: If no `--manager` is provided and the caller is running inside an agent worktree (CWD matches `/.ittybitty/agents/<id>/repo`), the caller's agent ID is automatically set as the manager.

3. **Yolo escalation prevention**: A `--yolo` child cannot be spawned by a non-yolo parent. This prevents permission escalation where a constrained agent spawns an unconstrained one. The parent's yolo status is checked via `meta.json` or `start.sh`.

4. **Configuration**: Config is loaded from `~/.itsybitsy/config.json` (user-wide). The model is determined by: `--model` flag > config `model` > `"opus"` (default).

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

16. **Auto-spawn watchdog**: `ib watchdog <id>` is spawned in the background for ALL agents (not just those with a manager), with output redirected to `<agent-dir>/watchdog.log`. The watchdog PID is saved to `meta.json` as `watchdog_pid`.

17. **Output**: The agent ID is printed to stdout immediately after tmux session creation.

18. **Prompt summary generation**: After the watchdog is spawned, `generatePromptSummary()` is called in the background (fire-and-forget) to produce a short human-readable summary of the agent's task. This does not block the creation flow. See §8.9 for details.

### 1.2 Agent States

Agents can be in one of 7 states:

| State | Description |
|-------|-------------|
| `creating` | Agent was created less than 6 seconds ago (derived from `created_epoch`, never written to meta.json) |
| `running` | Agent is actively working — default state after creation grace period; set by stop hook when nudging, by `ib send` when sending a message, by `ib resume` when resuming |
| `waiting` | Agent signaled `WAITING` as its last line — set by the stop hook |
| `complete` | Agent signaled `I HAVE COMPLETED THE GOAL` as its last line — set by the stop hook |
| `compacting` | Context window compaction in progress — detected from tmux output ("Compacting conversation" in last 5 lines), never written to meta.json |
| `rate_limited` | Hit API rate limits — detected from tmux output (same patterns as legacy parseState), never written to meta.json |
| `stopped` | Tmux session does not exist, or agent is archived — detected at read time, never written to meta.json |

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

4. **Read `state` from meta.json** → return the stored value (`running`, `waiting`, or `complete`). If `state` field is absent (legacy agent or freshly created agent before first stop hook fires), treat as `running` if the agent was created more than 6 seconds ago.

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

[^callout]: The legacy `parseState()` function and its 14-priority tmux pattern matching system remain in the codebase but are no longer used for primary state detection. They are retained for:
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

## 2. Manager vs Worker Agents

### 2.1 Distinction

The `--worker` flag at creation time determines the agent's role:

| Property | Manager | Worker |
|----------|---------|--------|
| `meta.json` `worker` field | `false` | `true` |
| Can spawn sub-agents | Yes (via `ib new-agent --worker`) | No |
| Can use Task tool | Intercepted → spawns ib agents (only when intercept hook is installed in parent repo settings) | Native Task allowed (intercept hook skips workers) |
| Can ask user questions | Only if top-level (no manager); bash also allows if manager was merged/killed | No |
| Permissions source | `permissions.manager.allow/deny` | `permissions.worker.allow/deny` |
| Session-start instructions | Manager template (with sub-agent commands) | Worker template (with send/diff/status only) |
| TaskCreate | Blocked with "Use ib new-agent --worker" message | Blocked with "Workers cannot create tasks" message |

### 2.2 Agent Permissions

When building `settings.local.json` for an agent, permissions come from three sources, merged and deduplicated:

1. **Existing base settings**: From the root repo's `.claude/settings.local.json`
2. **Mandatory permissions** (always added for all agents):
   - `Bash(ib:*)`, `Bash(./ib:*)` — ib commands (both forms to handle PATH vs relative invocation) [^callout]: The TS implementation only includes `Bash(ib:*)`. The `Bash(./ib:*)` form is bash-only, since the TS `ib` binary is always expected to be on PATH.
   - `Bash(git status:*)`, `Bash(git add:*)`, `Bash(git commit:*)`, `Bash(git diff:*)`, `Bash(git show:*)`, `Bash(git log:*)`, `Bash(git ls-files:*)`, `Bash(git grep:*)`, `Bash(git rm:*)`, `Bash(git merge:*)`, `Bash(git rebase:*)`, `Bash(git checkout:*)`, `Bash(git restore:*)`, `Bash(git reset:*)` — git operations
   - `Bash(pwd:*)`, `Bash(ls:*)`, `Bash(head:*)`, `Bash(tail:*)`, `Bash(cat:*)`, `Bash(grep:*)` — filesystem inspection
   - `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `TodoWrite`, `Task`, `TaskOutput`, `KillShell`, `NotebookEdit`, `WebFetch`, `WebSearch`, `AskUserQuestion` — Claude Code tools
3. **Config-defined permissions**: From `permissions.manager.allow/deny` or `permissions.worker.allow/deny` in `~/.itsybitsy/config.json`

**Always denied** (for all agents): `EnterPlanMode`, `ExitPlanMode`

### 2.3 Manager Sub-Agent Spawning

Managers spawn workers either explicitly with `ib new-agent --worker "task"` or implicitly via the Task tool (which the intercept hook converts into `ib new-agent --worker`). In both cases, the manager's agent ID is automatically set as the `--manager` for the child. The child's branch forks from `agent/<manager-id>`. When invoked from the primary Claude session (no agent context), the intercept hook spawns a manager instead of a worker.

### 2.4 Unfinished Children Check

When a top-level manager (no manager of its own) signals completion, the stop hook checks for unfinished children. Both bash and TS determine "unfinished" by checking actual tmux state (creating, running, waiting, or complete — but NOT stopped/unknown).

Specifically, it looks for children — agents in `.ittybitty/agents/` whose `meta.json` `manager` field matches the completing agent's ID. If any exist, the agent receives a nudge message listing them and instructing it to merge or kill each one before completing.

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

1. **Resolve target**: Partial ID matching is supported (prefix/substring match against agent directories and tmux sessions). Must resolve to exactly one agent.
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
  "yolo": false,
  "model": "sonnet",              // bash defaults to "sonnet"; legacy agents may have null
  "claude_pid": "12345",          // appended after Claude starts (not in initial write)
  "watchdog_pid": "12346",        // appended after watchdog spawns (see §8.5); not in initial write
  "state": "running",             // written by stop hook, ib send, ib resume (see §1.3.1)
  "state_updated_at": 1704825030  // epoch seconds when state was last written
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
| `model` | string \| null | Claude model name (e.g., "sonnet", "opus", "haiku"), or `null` for legacy agents | [^callout]: Bash defaults `MODEL` to config value then `"sonnet"` before writing meta.json (the null branch in the template is unreachable dead code). TS normalizes null/missing to `"unknown"`. The `string \| null` type is retained because legacy agents may have null values, and display code (bash `ib list`) handles this defensively.
| `claude_pid` | string | PID of the Claude process (appended to meta.json via `sed` after start.sh launches Claude — not present in the initial write) |
| `watchdog_pid` | string | PID of the watchdog process (appended to meta.json after watchdog spawns — not present in the initial write; see §8.5) |
| `state` | string \| undefined | Deterministic agent state written by the stop hook, `ib send`, or `ib resume`. Values: `"running"`, `"waiting"`, `"complete"`. Absent on legacy agents or before the first stop hook fires (treated as `"running"` if agent is older than 6s). See §1.3.1. |
| `state_updated_at` | number \| undefined | Unix epoch seconds when `state` was last written. Used for debugging and staleness checks. |

### 5.3 Worktree ↔ Branch Relationship

Each agent's worktree is linked to a git branch named `agent/<agent-id>`:

- Top-level agents (no `--manager`) branch from `HEAD` of the main repo
- Sub-agents (any agent with `--manager`) branch from `agent/<manager-id>` regardless of worker/manager role
- All branches are local (no remote tracking)
- The worktree is at `.ittybitty/agents/<id>/repo`
- On merge or kill, both the worktree and branch are removed

### 5.4 Archive Structure

Archives are stored at `.ittybitty/archive/<YYYYMMDD-HHMMSS>-<agent-id>/` using the local time of archival. The same files as listed in §1.7 are preserved.

---

## 6. Hooks

itsybitsy installs hooks into each agent's `settings.local.json`, plus optional global hooks in `~/.claude/settings.json`. Managers get five hooks (path isolation, stop, session-start, permission-denied, and intercept-task); workers get four (no intercept-task).

### 6.1 Path Isolation Hook (PreToolUse)

**Command**: `ib hook-check-path <agent-id>`
**Matcher**: `*` (all tools)
**Hook type**: PreToolUse (runs before tool execution, can allow/deny)

**Decision logic** (checked in order):

1. **TaskCreate always denied**: Workers get "Workers cannot create tasks." Managers get "Use ib new-agent --worker."
2. **Allow list check**: Tool must match at least one pattern from `settings.local.json` `permissions.allow`. Patterns are either exact tool names (`"Read"`) or bash prefix patterns (`"Bash(git status:*)"` — matches Bash tool where command starts with `git status`).
3. **Bash cd commands**: If the tool is Bash and the command starts with `cd`, the target path is checked against the allowed paths.
4. **Bash command scanning** [^ts-only-bash-scan]: Non-cd bash commands are scanned for path references to:
   - Other agents' directories (`.ittybitty/agents/<other-id>/`)
   - The main repo root (when it differs from the worktree)
   Only paths at word boundaries (preceded by space, quote, `=`, or start of string) are checked.

[^ts-only-bash-scan]: **TS-only behavior.** The bash `ib` immediately allows all non-cd Bash commands after the allow-list check — it does not scan command strings for path references. The TS implementation added `checkBashCommandPaths()` as an extra safeguard that catches commands like `cat /repo/.ittybitty/agents/other-agent/...`.
5. **File path extraction** [^ts-only-notebook-path]: For non-Bash tools, `file_path`, `path`, or `notebook_path` from `tool_input` is checked.

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

The stop hook does **not** parse tmux output for state detection. It relies solely on `last_assistant_message` for determining state. Tmux-detected states (`compacting`, `rate_limited`) are handled by consumers at read time (see §1.3).

**Actions by state**:

| State written | Condition | Action |
|---------------|-----------|--------|
| `running` | — | **Nudge** — debounced (5s), sends "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL'" via tmux |
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

**Role detection** based on CWD:
- If CWD does not match `/.ittybitty/agents/<id>/repo` → **primary** (user-level Claude)
- If CWD matches and `meta.json` has `worker: true` → **worker**
- If CWD matches and `worker` is false/absent → **manager**

**Output**: JSON with `hookSpecificOutput.additionalContext` containing role-appropriate instructions wrapped in `<ittybitty>` tags. Instructions include:

- **Primary**: Available `ib` commands for spawning and managing agents
- **Manager**: Agent identity, worktree path, git context, sub-agent commands, workflow guidance, merge conflict handling (delegate rebasing to sub-agents), state management (`WAITING`/`I HAVE COMPLETED THE GOAL`), ask capability (top-level only)
- **Worker**: Agent identity, worktree path, git context, send/diff/status commands only, state management, communication with manager

### 6.4 Intercept Task Hook (PreToolUse)

**Command**: `ib hooks intercept-task`
**Matcher**: `Task|Agent`
**Hook type**: PreToolUse

Intercepts Claude Code's Task and Agent tools and redirects them to spawn ib agents instead:

1. **Worker skip**: If called from a worker agent (detected via CWD + `meta.json`), passes through without interception — workers use native Task/Agent
2. **Only intercepts `Task` and `Agent` tools** — all other tools pass through
3. **Skip for certain subagent_types**: `Bash`, `statusline-setup`, `claude-code-guide`, `meta-agent`, `ib-merge` pass through unintercepted
4. **Model validation**: Only `sonnet`, `opus`, `haiku`, or empty string are allowed
5. **Spawn behavior**:
   - When called from an agent context: spawns a `--worker` with the calling agent as `--manager`
   - When called from primary Claude: spawns a manager (no `--worker`)
6. **Output**: Rewrites the Task invocation to a `claude-code-guide` subagent that simply reports the spawned agent ID

This hook is only installed for manager agents (not workers), and only when the main repo's settings already have the intercept hook installed. Workers skip the intercept hook entirely and use the native Task tool directly (see §2.1). Note that `TaskCreate` (a separate tool from `Task`) is blocked for all agents by the path hook (§6.1).

### 6.5 Permission Denied Hook (PermissionRequest)

**Command**: `ib hook-permission-denied <agent-id>`
**Matcher**: `*`
**Hook type**: PermissionRequest

Fires when Claude requests permission for a tool that isn't auto-allowed. Simply logs `[PermissionRequest] Tool denied: <tool-name>` to `agent.log`. Cannot override permissions — PermissionRequest hooks are informational only. Always exits 0 with no stdout output. [^callout-permission-denied]

[^callout-permission-denied]: **Bash/TS divergence.** The bash `ib` does not have a handler for the `hook-permission-denied` subcommand — the command hits the "Unknown command" default case and exits 1 with an error to stderr. Since PermissionRequest hooks are informational only and Claude Code ignores non-zero exits from them, this means the bash version silently fails to log permission denials. The TS implementation properly handles the command and logs to `agent.log`.

### 6.6 Global Hooks (installed in ~/.claude/settings.json)

These are optional hooks that the user installs globally:

- **Main-path hook** (`ib hooks main-path`): PreToolUse hook on `Bash` matcher that prevents the primary Claude from `cd`-ing into agent worktrees. Only checks Bash `cd` commands — allows Read/Write/Edit to worktree paths. Resolves relative paths via `cwd` from stdin JSON. Exits 0 (allow) or 2 (deny with JSON written to stdout).
- **Intercept-task hook** (`ib hooks intercept-task`): PreToolUse hook on `Task|Agent` matcher (global version, enables task/agent interception for all repos; intercepts both Task and Agent tools)
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
| `permissions.manager.allow` | string[] | `[]` | Additional tool names added to the allow list for manager agents (merged with mandatory permissions at spawn time). |
| `permissions.manager.deny` | string[] | `[]` | Additional tool names added to the deny list for manager agents. |
| `permissions.worker.allow` | string[] | `[]` | Additional tool names added to the allow list for worker agents. |
| `permissions.worker.deny` | string[] | `[]` | Additional tool names added to the deny list for worker agents. |

### 7.3 Permission Resolution

For a given agent type (manager or worker):

1. Start with the base settings from `.claude/settings.local.json` in the repo root
2. Add mandatory permissions (§2.2)
3. Add config-defined permissions for the agent's role
4. Workers use `permissions.worker.allow`/`deny`; managers use `permissions.manager.allow`/`deny`. There is no fallthrough between types [^perm-quirk]
5. Deduplicate all allow/deny lists

[^perm-quirk]: The bash implementation has a quirk: if `CONFIG_WORKER_ALLOW` is empty, it falls through to `CONFIG_MANAGER_ALLOW` (and `deny` follows suit). The TS implementation intentionally does not replicate this — workers with empty `permissions.worker.allow` get no extra config permissions rather than inheriting manager permissions.

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
3. **All known keys are listed**, including those not present in the config file. The full key list matches `CONFIG_KEYS` in `config.ts`: `maxAgents`, `model`, `createPullRequests`, `allowAgentQuestions`, `autoCompactThreshold`, `externalDiffTool`, `hooks.injectStatus`, `hooks.statusVisible`, `permissions.manager.allow`, `permissions.manager.deny`, `permissions.worker.allow`, `permissions.worker.deny`.
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
2. **Array keys only**: Only `permissions.manager.allow`, `permissions.manager.deny`, `permissions.worker.allow`, and `permissions.worker.deny` are accepted. All other keys are rejected with an error.
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

**State source**: The watchdog reads `state` from `meta.json` (written by the stop hook — see §1.3.1 and §6.2). It does **not** parse tmux output for state detection. For `rate_limited` and `compacting`, the watchdog checks tmux output only for those specific patterns (same minimal tmux parsing that state consumers use — see §1.3 step 3).

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
5. New parent cannot be a worker
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
| `ib add [path]` | Add a repo to the registry. Defaults to `git rev-parse --show-toplevel` in the current directory if no path is given. Errors if the path is not a git repository or is already registered. |
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

Within the Config tab, a **permissions editor** sub-dialog allows editing the `permissions.manager.allow`, `permissions.manager.deny`, `permissions.worker.allow`, and `permissions.worker.deny` lists in `~/.itsybitsy/config.json`. Each list is editable independently. Changes take effect for newly created agents (existing agents' `settings.local.json` is not modified retroactively).

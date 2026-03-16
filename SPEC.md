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
   - `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `TodoWrite`, `Task`, `TaskOutput`, `KillShell`, `NotebookEdit`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ToolSearch` — Claude Code tools
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
| `state_updated_at` | number \| undefined | Unix epoch seconds when `state` was last written. Used for debugging. |

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

### 6.0 Execution Contexts

itsybitsy hooks operate across three distinct execution contexts. Each context has different hook installations, permissions, and behavioral constraints:

| Context | CWD | Hooks source | Permissions source | Role detection |
|---------|-----|-------------|-------------------|----------------|
| **Primary Claude** | Any non-worktree path | `~/.claude/settings.json` (global hooks only) | User's own `~/.claude/settings.json` + repo `.claude/settings.local.json` | CWD does NOT match `/.ittybitsy/agents/<id>/repo` |
| **Manager agent** | `<repo>/.ittybitsy/agents/<id>/repo` | Agent's `settings.local.json` (5 hooks: path-check, stop, session-start, permission-denied, intercept-task) | Built per §2.2 with `permissions.manager.allow/deny` | CWD matches pattern AND `meta.json` has `worker: false` or absent |
| **Worker agent** | `<repo>/.ittybitty/agents/<id>/repo` | Agent's `settings.local.json` (4 hooks: path-check, stop, session-start, permission-denied — NO intercept-task) | Built per §2.2 with `permissions.worker.allow/deny` | CWD matches pattern AND `meta.json` has `worker: true` |

**Key distinction**: Primary Claude uses ONLY the global hooks from `~/.claude/settings.json` (§6.6). Per-agent hooks (§6.1–6.5) are installed ONLY in agent worktree `settings.local.json` files and must never leak into the user's repo-level `settings.local.json`. If agent hooks are left in a repo's `settings.local.json` after an agent is killed or merged, they will incorrectly restrict the user's direct Claude sessions in that repo.

**Hook isolation invariant**: `ib kill`, `ib nuke`, and `ib merge` must ensure agent-specific hooks are cleaned from the repo's `settings.local.json` if they were ever written there. The intended flow is:
1. Agent creation writes hooks to `<agent-dir>/repo/.claude/settings.local.json` (inside the worktree)
2. The worktree is removed on kill/merge/nuke
3. The repo's own `.claude/settings.local.json` is never modified by agent lifecycle operations

**Detection pattern**: The `AGENT_CWD_PATTERN` regex (`/.ittybitty/agents/([^/]+)/repo(/|$)`) is used by all hooks to distinguish agent contexts from primary Claude. If CWD does not match this pattern, the session is treated as primary Claude and per-agent restrictions do not apply.

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

The input field location depends on which panel has focus: when the coordinator has focus, the input field appears at the bottom of the coordinator section in the sidebar; when the active agent pane has focus, it appears at the bottom of the tmux pane in the main area (see §13.4).

The left sidebar defaults to 60 columns (resizable via `[`/`]` when a sidebar panel has focus, range 30–120). It is a vertical stack containing three sections: agent tree (top), info panel (middle), and coordinator Claude panel (bottom). The main area to the right of the sidebar retains the existing split-pane layout: tmux output on the left and cycling right pane on the right.

### 11.2 Left Sidebar

The sidebar defaults to 60 columns wide, resizable via `[`/`]` when any sidebar panel has focus (range: 30–120 columns). A vertical separator (`│`) divides the sidebar from the main area.

The sidebar renders three vertically stacked sections, separated by horizontal rules:

1. **Agent Tree** — compact agent list (see §11.3)
2. **Info Panel** — details for the selected agent (see §11.4)
3. **Coordinator Claude** — system-wide coordinator session (see §12)

The relative heights of these sections are determined as follows:

```
available = terminal_rows - header(1) - separator(1) - status_bar(2)
tree_height = min(MAX_TREE_HEIGHT, agent_count + repo_count)  // up to 7
coordinator_height = max(5, floor((available - tree_height) * 0.4))
info_height = max(1, available - tree_height - coordinator_height - separators(2))
```

- The agent tree occupies up to 7 rows (same as the current `MAX_TREE_HEIGHT`), with scroll indicators (`▲`/`▼`) if more rows exist.
- The coordinator panel gets 40% of remaining height (minimum 5 rows).
- The info panel fills the rest (minimum 1 row).
- If the terminal is too short to fit all three sections, the coordinator panel shrinks first (down to 3 rows), then the info panel (down to 0 rows — hidden entirely).

### 11.3 Compact Agent Tree

In the sidebar layout, the agent tree uses a compact row format to fit within 60 columns:

```
icon agent-id          state      age
```

Each row shows:
- **Icon**: `◆` (manager) or `⚙` (worker), with `⚠` prefix if orphaned
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

The coordinator system has two tiers: one **system coordinator** that manages work across all repos, and optional **per-repo coordinators** that manage work within a single repo. Together they form a coordination hierarchy: user → system coordinator → per-repo coordinators → agents.

### 12.1 System Coordinator

#### 12.1.1 Purpose

The system coordinator is a Claude Code session that runs from `~/.itsybitsy/` with restricted permissions. Its purpose is to coordinate agents across all registered repos using `ib` commands — it cannot read files, write code, or perform research directly. The user interacts with it via the TUI.

#### 12.1.2 Lifecycle

**Auto-spawn on startup**: When `ib watch` launches, it checks for an existing system coordinator tmux session. If none exists, it spawns one:

1. Ensure `~/.itsybitsy/` exists and has a bare git repo (`git init`) so Claude Code can load `settings.local.json`
2. Write `~/.itsybitsy/.claude/settings.local.json` with system coordinator permissions (§12.1.3)
3. Create a tmux session named `ib-coordinator` with working directory `~/.itsybitsy/`
4. Start Claude Code inside the session with model `opus`

**Shared across instances**: Multiple `ib watch` instances share the same `ib-coordinator` tmux session. On startup, check if the session already exists (`tmux has-session -t ib-coordinator`). If it does, just display its output — do not create a new one.

**Auto-close on exit**: When `ib watch` exits (Ctrl-C), kill the coordinator tmux session **only if** no other `ib watch` instances are displaying it. Detection uses a reference counter file at `~/.itsybitsy/coordinator.refs`: each `ib watch` instance increments the counter on startup and decrements on exit. When the counter reaches 0, the session is killed. This is necessary because `ib watch` does not *attach* to the coordinator session (it polls via `capture-pane`), so `tmux list-clients` cannot detect active viewers.

**Persistence across restarts**: Killing and restarting `ib watch` preserves the tmux session if references remain. The session is long-lived — it is not killed when the last agent completes.

#### 12.1.3 Permissions

The system coordinator runs from `~/.itsybitsy/`, which is not a git repository. Claude Code reads `settings.local.json` from `<cwd>/.claude/settings.local.json`. Therefore, the coordinator's permissions file is written to `~/.itsybitsy/.claude/settings.local.json` before spawning:

```json
{
  "permissions": {
    "allow": ["Bash(ib:*)"],
    "deny": ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"]
  }
}
```

**Note**: Claude Code requires a project directory context to load `settings.local.json`. Since `~/.itsybitsy/` is not a git repo, the coordinator session must either: (a) initialize a bare git repo there (`git init`), or (b) pass permissions via `--allowedTools` CLI flags. The implementation should prefer (a) since it matches the existing settings pattern and is simpler to maintain.

This ensures the system coordinator can only run `ib` commands (e.g., `ib list`, `ib send`, `ib merge`, `ib new-agent`, `ib kill`, `ib status`, `ib diff`). It cannot access files, browse the web, or spawn sub-agents directly.

#### 12.1.4 Display

**Agent tree**: The system coordinator appears as the **first entry** in the agent tree, before all repo headers. It uses a special icon (`◆`) and displays as:

```
◆ coordinator  running  5m
▾ itsybitsy
  ◇ coordinator      running  3m
  ⚙ agent-a1b2c3d4   running  2m
▾ muse-ios
  ◇ coordinator      running  1m
  ⚙ agent-c9d0e1f2   complete  1h
```

**Layout when system coordinator is selected**: When the system coordinator is selected in the agent tree, the entire layout changes:

- **Sidebar** switches to a two-section layout: agent tree (top) + system coordinator tmux output and input field (bottom). The info panel is **hidden** — it is not relevant for the system coordinator.
- **Main area** (middle + right panes) merge into a **single full-width system dashboard** showing the full agent tree across all repos with status overview. This is a dedicated system view, not the regular split-pane layout.

```
┌──────────────────────────────────────────────────────────────────┐
│ ib — agent dashboard                                            │
├──── Agents ──────────────────┬──── System Dashboard ────────────┤
│ ◆ coordinator  running  5m  │                                   │
│ ▾ itsybitsy                  │  Full agent tree across all repos │
│   ◇ coordinator  running 3m │  with status, model, age, summary │
│   ⚙ agent-a1b2  running 2m  │                                   │
│ ▾ muse-ios                   │  (future: system status metrics,  │
│   ◇ coordinator  running 1m │   rate limit overview, etc.)       │
│   ⚙ agent-c9d0  complete 1h │                                   │
├──── System Coordinator ──────│                                   │
│ coordinator tmux output      │                                   │
│ > input field█               │                                   │
├──────────────────────────────┴───────────────────────────────────┤
│ status bar                                                       │
└──────────────────────────────────────────────────────────────────┘
```

When any other agent or repo header is selected, the layout reverts to the normal three-section sidebar (tree + info + coordinator) with the standard split-pane main area.

The system coordinator panel uses its own `TmuxPoller` instance (separate from the agent tmux poller) to capture output from the `ib-coordinator` session at ~1s intervals.

#### 12.1.5 Session Start Context

The system coordinator does NOT use the standard session-start hook (§6.3). Instead, it receives a custom initial prompt explaining its role:

> You are the itsybitsy system coordinator. You manage agents across all registered repos using `ib` commands. You can list agents (`ib list`), send messages (`ib send`), merge (`ib merge`), kill (`ib kill`), create agents (`ib new-agent`), and check status (`ib status`, `ib diff`). You do NOT have access to Read, Write, Edit, or any file tools — only `ib` Bash commands. You coordinate work at the system level — for repo-specific coordination, delegate to per-repo coordinators. Periodically check `ib inbox count` for notifications from watchdogs and agents; process with `ib inbox list` / `ib inbox read` / `ib inbox ack`. To send messages to per-repo coordinators, use `ib send <repo-name> "message"` (e.g., `ib send itsybitsy "review the latest PR"`).

#### 12.1.6 Watchdog Behavior

The system coordinator does **not** have a standard watchdog or stop hook. It is not a regular agent — it has no agent directory, no meta.json, and no agent ID in the ib system. Instead:

- No watchdog process is spawned for the system coordinator
- No stop hook is installed — the system coordinator's state is detected purely from tmux session existence and output parsing (similar to how `compacting` and `rate_limited` are detected for regular agents)
- State detection: tmux session exists → `running`; tmux session gone → `stopped`; rate limit patterns in output → `rate_limited`; compacting pattern → `compacting`
- If the system coordinator session dies unexpectedly, the sidebar panel shows "System coordinator stopped — press Enter to restart" and `ib watch` can restart it on demand
- The system coordinator is expected to run indefinitely — it is never nudged to complete

### 12.2 Per-Repo Coordinators

#### 12.2.1 Purpose

Per-repo coordinators are Claude Code agents that coordinate work within a single repository. Unlike the system coordinator, they **can** read code in their repo (via Read, Glob, Grep) but cannot write code directly. They are responsible for understanding the codebase context and orchestrating worker agents that do the actual implementation.

#### 12.2.2 Identity

Per-repo coordinators are stored in `.ittybitty/agents/` like regular agents, but with distinguishing characteristics:

- **Agent ID**: `coordinator` (not the random `agent-<hex>` format). Only one coordinator per repo.
- **meta.json flag**: `"coordinator": true` — marks this agent as a coordinator
- **Tmux session naming**: Standard convention: `ittybitty-<repo-id>-coordinator`
- **Branch name**: `agent/coordinator-<repo-id>` (includes repo-id to avoid collision across repos sharing the same git remote — each repo has a unique 8-char hex repo-id in `.ittybitty/repo-id`)

#### 12.2.3 Lifecycle

**Creation**: Per-repo coordinators are created via `ib new-agent --coordinator` (new flag). This:

1. Uses agent ID `coordinator` instead of generating a random ID
2. Sets `coordinator: true` in meta.json
3. Uses coordinator-specific permissions (§12.2.4)
4. Uses coordinator-specific session start context (§12.2.6)
5. Does NOT set a `--manager` — coordinators are top-level agents
6. Otherwise follows the standard agent creation flow (§1.1)

**One-per-repo constraint**: If a coordinator already exists for the repo (active `coordinator` agent in `.ittybitty/agents/`), `ib new-agent --coordinator` is a no-op (idempotent). There is exactly one coordinator per repo, never more.

**Auto-spawn on watch startup**: When `ib watch` launches, it auto-spawns a per-repo coordinator for each registered repo that doesn't already have one. This matches the system coordinator's auto-spawn behavior — both tiers start automatically. On exit, per-repo coordinators are killed (their tmux sessions are stopped), unless another `ib watch` instance is running.

**Manual spawning**: Per-repo coordinators can also be created manually via `ib new-agent --coordinator`. The `a` (new agent) action in the TUI offers an additional option: "New coordinator" when the selected repo does not already have one. The system coordinator can also spawn per-repo coordinators via `ib new-agent --coordinator` from within a repo directory.

**Children**: Agents spawned by a per-repo coordinator (via `ib new-agent --worker` from within the coordinator's session) will have `manager: "coordinator"` in their meta.json. This means `buildAgentTree()` will correctly parent them under the coordinator, and `ib nuke coordinator` will recursively kill them.

**Killing/Archiving**: Per-repo coordinators follow the standard kill/archive flow (§1.4, §1.7). Killing a coordinator also kills all its children if it has any (same as nuking a manager — the `manager: "coordinator"` field links children to it).

**Resuming**: Standard resume flow (§1.6). Per-repo coordinators can be paused and resumed like any agent.

#### 12.2.4 Permissions

Per-repo coordinators get a restricted permission set — they can read the codebase and run `ib` commands, but cannot write code:

```json
{
  "permissions": {
    "allow": [
      "Bash(ib:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
      "Bash(git show:*)", "Bash(git ls-files:*)", "Bash(git grep:*)",
      "Bash(pwd:*)", "Bash(ls:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(cat:*)", "Bash(grep:*)",
      "Read", "Glob", "Grep", "LS",
      "TodoWrite", "AskUserQuestion"
    ],
    "deny": [
      "Write", "Edit", "MultiEdit", "NotebookEdit",
      "WebFetch", "WebSearch", "Task", "TaskOutput", "Agent", "KillShell",
      "EnterPlanMode", "ExitPlanMode"
    ]
  }
}
```

Key differences from regular agents:
- **No Write/Edit/MultiEdit** — coordinators cannot modify files
- **Has Read/Glob/Grep/LS** — coordinators can read the codebase for context
- **No Task/Agent** — coordinators spawn sub-agents only via `Bash(ib:*)`, not Claude's built-in Task/Agent tools. This ensures all agents are tracked through the ib system.
- **No WebFetch/WebSearch** — coordinators don't need internet access
- **No KillShell** — coordinators don't run long-lived shell processes

These permissions are constructed by a new `buildCoordinatorSettings()` function (parallel to the existing `buildAgentSettings()`). Per-repo coordinator permissions are also configurable via config:

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
  ◇ coordinator      running  3m       (per-repo coordinator)
  ⚙ agent-a1b2c3d4   running  2m
  ⚙ agent-e5f6a7b8   waiting  10m
▾ muse-ios
  ⚙ agent-c9d0e1f2   complete  1h
```

When a per-repo coordinator is selected in the agent tree, it behaves like any other agent — its tmux output shows in the middle pane, and the right pane shows the selected mode (log, prompt, etc.). Per-repo coordinators do NOT get the full-width view that the system coordinator gets.

#### 12.2.6 Session Start Context

Per-repo coordinators use a custom session-start context (injected via the session-start hook, which detects the `coordinator: true` flag in meta.json):

> You are a per-repo coordinator for the `<repo-name>` repository. You can read files and code in this repo using Read, Glob, Grep, and LS. You coordinate work by spawning and managing worker agents using `ib` commands. You do NOT write code directly — instead, spawn worker agents with `ib new-agent --worker "task"` to implement changes. Review their work with `ib diff <id>` and merge with `ib merge <id>`. To send messages to the system coordinator, use `ib send coordinator "message"`.

#### 12.2.7 Watchdog Behavior

Per-repo coordinators use a modified watchdog behavior:

- A watchdog process IS spawned (to detect rate limiting, compacting, etc.)
- The watchdog does NOT nudge coordinators to complete — coordinators are expected to run indefinitely while they have active sub-agents
- The watchdog DOES notify the system coordinator (if running) when a per-repo coordinator enters `waiting` state with no active children — this allows the system coordinator to decide whether to give it more work or let it idle. Notification uses the file-based message queue (§12.3.4).
- Completion notification goes to the system coordinator instead of a parent manager (since coordinators have no manager)
- **Fallback when system coordinator is not running**: If the system coordinator's tmux session does not exist, notifications are logged to `~/.itsybitsy/coordinator-inbox/` anyway (they will be processed when the system coordinator is restarted). This avoids losing notifications.

### 12.3 Addressing Coordinators

#### 12.3.1 CLI Addressing

Coordinators are addressed by name rather than agent ID:

- **System coordinator**: `ib send coordinator "message"` — the bare name `coordinator` always addresses the system coordinator
- **Per-repo coordinator**: `ib send <repo-name> "message"` — uses the repo basename (e.g., `ib send itsybitsy "message"`) to address the per-repo coordinator for that repo
- **Regular agents**: `ib send <agent-id> "message"` — unchanged, uses standard agent ID

This naming is simple and unambiguous — no CWD-scoped resolution needed. The system coordinator can reach per-repo coordinators via `ib send <repo-name>`, and per-repo coordinators can reach the system coordinator via `ib send coordinator`.

#### 12.3.2 TUI Addressing

- **System coordinator**: Select in agent tree → `s` key to send message, or focus coordinator sidebar panel → type in input field
- **Per-repo coordinator**: Select in agent tree → `s` key to send message (same as any agent)
- Both use the standard TUI input flow — no name resolution needed since selection is explicit

#### 12.3.3 System Coordinator Messaging

The system coordinator has two messaging paths, each for a different context:

**User-interactive (TUI)**: When the user types in the coordinator sidebar input field or uses `s` with the system coordinator selected, `tmux send-keys -t ib-coordinator` is used directly. This is safe because the user controls timing and can see whether the coordinator is busy.

**Programmatic (watchdog, automated notifications)**: When the watchdog or other automated systems need to notify the system coordinator, they use the `ib inbox` command (see §12.3.4). This avoids the race condition of injecting text via `tmux send-keys` while the coordinator is mid-response.

#### 12.3.4 `ib inbox` Command

The system coordinator cannot read files directly (it has only `Bash(ib:*)` permissions). To receive programmatic messages safely, a new `ib inbox` CLI command provides access to a file-based message queue:

**Writing messages** (used by watchdog, other agents):
- `ib inbox write "message text"` — writes a message file to `~/.itsybitsy/coordinator-inbox/<timestamp>-<source>.msg`
- Called by the watchdog's `notifySystemCoordinator()` and by any code that needs to notify the system coordinator programmatically

**Reading messages** (used by the system coordinator itself):
- `ib inbox list` — lists pending message files (returns filenames + preview)
- `ib inbox read <filename>` — reads a specific message
- `ib inbox ack <filename>` — acknowledges (deletes) a processed message
- `ib inbox count` — returns the number of pending messages (useful for polling)

The system coordinator's session-start prompt instructs it to periodically run `ib inbox count` and process messages with `ib inbox list` / `ib inbox read` / `ib inbox ack`. This keeps the system coordinator's permissions minimal (`Bash(ib:*)` covers `ib inbox *`) while giving it access to programmatic notifications.

### 12.4 Coordinator Relationship to Regular Agents

#### 12.4.1 Hierarchy

```
User
 └── System Coordinator (ib-coordinator, ~/.itsybitsy/)
      ├── Per-Repo Coordinator (itsybitsy)
      │    ├── agent-a1b2c3d4 (worker)
      │    └── agent-e5f6a7b8 (manager)
      │         └── agent-f9a0b1c2 (worker)
      └── Per-Repo Coordinator (muse-ios)
           └── agent-d3e4f5a6 (worker)
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

Per-repo coordinators count toward the `maxAgents` limit (they are regular agents). The system coordinator does NOT count — it is not a regular agent and lives outside any repo.

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
| `coordinator.model` | string | `"opus"` | Model for both system and per-repo coordinators. A single key is used because both tiers perform the same kind of work (orchestration via `ib` commands). If different models are needed, per-repo coordinators can be spawned with `--model <model>` to override. |
| `permissions.coordinator.allow` | string[] | `[]` | Additional permissions for per-repo coordinators |
| `permissions.coordinator.deny` | string[] | `[]` | Additional deny rules for per-repo coordinators |

### 12.6 Affected Files and Modules

The coordinator system touches many modules. This section catalogs every file that needs changes.

| Module | Changes needed |
|--------|---------------|
| `src/coordinator.ts` (new) | System coordinator lifecycle: `ensureSystemCoordinator()`, `releaseSystemCoordinator()`, `restartSystemCoordinator()`, reference counting, permissions template, prompt definition |
| `src/agents.ts` | Add `coordinator?: boolean` to `AgentMeta` interface. Add `{ kind: "system-coordinator" }` to `FlatEntry` union. `flattenAgentTree()` prepends system coordinator entry. Sort per-repo coordinators before regular agents within each repo section. |
| `src/agent-lifecycle.ts` | `buildCoordinatorSettings()` — new function producing coordinator-specific permissions (Read/Glob/Grep yes, Write/Edit no). `newAgent()` extended with `--coordinator` flag: uses fixed `coordinator` ID, sets `coordinator: true` in meta.json, one-per-repo validation, mutual exclusivity with `--worker`. |
| `src/ib-commands.ts` | `newAgent()` CLI handler: `--coordinator` flag parsing. `sendMessage()`: resolve `coordinator` → system coordinator, `<repo-name>` → per-repo coordinator. New `ib inbox` command (write/list/read/ack/count). New config keys registered. |
| `src/watchdog.ts` | Detect `coordinator: true` in meta.json. Skip completion nudge for coordinators. `notifySystemCoordinator()` — send messages to system coordinator when per-repo coordinator enters waiting with no children. No watchdog spawned for system coordinator. |
| `src/hooks/session-start.ts` | Detect `coordinator: true` in meta.json. Inject coordinator-specific prompt (SPEC.md §12.2.6) instead of standard manager/worker prompt. |
| `src/hooks/agent-path.ts` | No changes needed — per-repo coordinators use standard path isolation. System coordinator has no worktree to isolate. |
| `src/hooks/agent-status.ts` | No changes needed — stop hook writes state normally. Coordinator-specific behavior is in the watchdog, not the hook. |
| `src/config.ts` | New config keys: `coordinator.autoSpawnPerRepo` (boolean), `coordinator.model` (string), `permissions.coordinator.allow` (string[]), `permissions.coordinator.deny` (string[]). |
| `src/tui/dashboard.ts` | Detect system coordinator selection → switch to full-width view mode (no split-pane). System coordinator lifecycle on startup/shutdown. Coordinator restart on `R` key. Input field routing for coordinator vs agent. |
| `src/tui/agent-tree.ts` | Render system coordinator as first entry with `◆` icon. Render per-repo coordinators with `◇` icon, sorted before regular agents. Handle selection of `kind: "system-coordinator"` entries. |
| `src/tui/sidebar.ts` | Rename "Coordinator" header to "System Coordinator". No structural changes — sidebar coordinator panel still shows system coordinator tmux output. |
| `src/tui/split-pane.ts` | Support conditional full-width mode when system coordinator is selected (may already be partially supported via `fullWidth` flag). |
| `src/tui/pane-manager.ts` | When system coordinator is selected, right pane modes may be limited or hidden. The full-width view replaces the split pane entirely. |
| `src/tui/focus.ts` | No structural changes. The `coordinator` focus target still refers to the sidebar system coordinator panel. |
| `src/tui/agent-actions.ts` | `a` (new agent) dialog: add "Coordinator" option when selected repo has no coordinator. Handle coordinator-specific action keys (no merge/kill for system coordinator). |
| `src/tui/info-panel.ts` | Show coordinator-specific info when a coordinator is selected (per-repo or system). Coordinator type indicator. |
| `src/tui/input-field.ts` | No changes — generic input component used by both coordinator and agent panels. |
| `src/tui/layout.ts` | No changes needed — existing layout persistence covers coordinator panel sizing. |
| `src/index.ts` | CLI: `ib new-agent --coordinator` flag handling. |
| `src/watcher.ts` | No changes needed — per-repo coordinators are regular agents detected by fs.watch. System coordinator state is polled via its TmuxPoller. |
| `src/auto-compact.ts` | No changes needed — auto-compact works generically for all agents via the watchdog. Per-repo coordinators are regular agents and get auto-compact automatically. The system coordinator has no watchdog and no auto-compact (it doesn't use the standard agent lifecycle). |

---

## 13. Focus System

### 13.1 Focus Targets

The TUI has five focusable panels:

| Target | Location | Behavior when focused |
|--------|----------|----------------------|
| `agent-tree` | Sidebar top | `j`/`k` navigate agents, action keys active |
| `info` | Sidebar middle | Read-only info panel; `[`/`]` resize sidebar, `{`/`}` resize height |
| `coordinator` | Sidebar bottom | Input field visible, text input captured (sends to system coordinator) |
| `active-agent` | Main area (tmux pane) | Input field visible, text input captured |
| `right-pane` | Main area (right side) | `[`/`]` resize right pane width |

### 13.2 Focus Cycling

- **Tab**: Cycle focus forward through the focus targets in order: `agent-tree` → `info` → `coordinator` → `active-agent` → `right-pane` → `agent-tree` → ...
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

Only meaningful for sidebar panels (agent tree, info, coordinator). Growing one sidebar panel shrinks the panel(s) below it. The bottom-most panel (coordinator) steals height from its upper neighbor (info panel) instead.

### 13.4 Input Field

When the `coordinator` or `active-agent` panel has focus, an input field appears at the bottom of that panel's tmux output area:

```
│ ...tmux output...       │
│─────────────────────────│
│ > user input here█      │
│─────────────────────────│
```

The input field:
- Captures all alphanumeric and symbol key input while focused
- Shows a cursor indicator (`█`)
- **Enter**: Submits the input text. For agents (including per-repo coordinators), uses `ib send <agent-id> "<message>"`. For the system coordinator, uses `tmux send-keys -t ib-coordinator -l "<message>"` followed by a separate `tmux send-keys -t ib-coordinator Enter`.
- **Escape**: Clears the input field and returns focus to `agent-tree`
- Supports basic line editing: backspace, Ctrl-A (home), Ctrl-E (end), Ctrl-U (clear line)

The input field takes 3 lines of vertical space: top separator, input line, bottom separator. These lines are subtracted from the tmux output display height.

### 13.5 Keyboard Routing

When a panel with an input field has focus:
- Printable characters, backspace, and line-editing keys go to the input field
- Tab/Shift+Tab still cycle focus
- Escape returns focus to `agent-tree`
- All other dashboard keybindings (j/k, p/n, action keys like s/m/x) are **suppressed** — they do not pass through to the dashboard

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
  "heightOffsets": { "tree": 0, "info": 0, "coordinator": 0 }
}
```

- **Save**: Debounced (500ms) write after any resize operation. The debounce prevents excessive disk writes during rapid resizing.
- **Restore**: On startup, the saved layout is loaded and applied with validation: NaN and Infinity values are rejected, and all values are clamped to valid ranges (sidebar width [30, 120], etc.).
- **Missing file**: If `layout.json` doesn't exist or is invalid, defaults are used (sidebar 60 cols, default split-pane position, zero height offsets).

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
- **Intercept-task hook**: `ib hooks intercept-task` in PreToolUse with `Task|Agent` matcher. Checked separately since it's an optional but recommended hook.

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

---

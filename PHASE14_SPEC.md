# Phase 14: Native ib Command Reimplementation — Specification

This document specifies the exact behavior of each ib command to be natively reimplemented in TypeScript, based on the bash source at `~/Developer/bash/ittybitty/ib`.

## Global Constants & Path Setup

```
ITTYBITTY_DIR = ".ittybitty"
TMUX_WIDTH = 60
SESSION_PREFIX = "ittybitty-<repo-id>-"   # repo-id is 8 hex chars from .ittybitty/repo-id
AGENTS_DIR = "<ROOT_REPO_PATH>/.ittybitty/agents"
ARCHIVE_DIR = "<ROOT_REPO_PATH>/.ittybitty/archive"
```

**ROOT_REPO_PATH**: Found via `git rev-parse --git-common-dir`. If it returns `.git` or matches `--git-dir`, use `--show-toplevel`. Otherwise, go up one directory from the common dir. This resolves worktrees to the main repo.

**session_name(id)**: Reads `tmux_session` field from `<AGENTS_DIR>/<id>/meta.json`. Fallback: `${SESSION_PREFIX}${id}`.

**is_running_as_agent()**: True if cwd contains `/.ittybitty/agents/*/repo` OR if inside an ittybitty tmux session.

---

## 1. new-agent (cmd_new_agent)

### Arguments
| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--name NAME` | string | `agent-<8 hex chars>` | Custom agent ID |
| `--manager ID` / `--parent ID` | string | auto-detected | Parent manager |
| `--no-worktree` | bool | false | Use repo root instead of worktree |
| `--allow-tools LIST` | string | "" | Comma-separated allowed tools |
| `--deny-tools LIST` | string | "" | Comma-separated denied tools |
| `--print` | bool | false | One-shot mode |
| `--yolo` | bool | false | Skip all permission prompts |
| `--worker` / `--leaf` | bool | false | Worker agent (no sub-agent spawning) |
| `--model MODEL` | string | from config or "sonnet" | Claude model |
| `--prompt-file FILE` | string | "" | Read prompt from file |
| positional | string | required | The prompt |

### Validation (in order)
1. Prompt required (positional arg or stdin if not a TTY)
2. Must be in a git repo (`require_git_repo`)
3. Create `.ittybitty/agents/` and `.ittybitty/archive/` if needed (`ensure_ittybitty_dirs`)
4. **Auto-detect manager**: If `--manager` not set and cwd matches `*/.ittybitty/agents/*/repo*`, extract agent ID from the path's meta.json
5. **Validate manager**: Resolve partial ID via `resolve_agent_id()`. Error if manager is a worker (`worker: true` in meta.json)
6. **Yolo escalation check**: If `--yolo` and running inside an agent worktree, check that the parent agent is also yolo (from meta.json `yolo` field or `dangerously-skip-permissions` in `start.sh`). Error if parent is not yolo.
7. **Load config**: Read `.ittybitty.json` for model, maxAgents, permissions, custom prompts
8. **Model fallback**: `--model` > `config.model` > `"sonnet"`
9. **Max agents check**: Count agents (directories with meta.json in AGENTS_DIR). Error if >= `config.maxAgents`
10. **Generate ID**: If `--name` provided use it; otherwise `agent-$(openssl rand -hex 4)`
11. **Uniqueness check**: Error if `AGENTS_DIR/<id>` exists or tmux session `session_name(id)` exists

### Files Created

#### `.ittybitty/agents/<id>/` (directory)

#### `.ittybitty/agents/<id>/meta.json`
```json
{
  "id": "<id>",
  "session_id": "<uuid v4 lowercase>",
  "tmux_session": "<SESSION_PREFIX><id>",
  "prompt": "<prompt text>",
  "manager": "<manager-id>" | null,
  "created": "<ISO 8601 date>",
  "created_epoch": <unix timestamp>,
  "worktree": true | false,
  "worker": true | false,
  "yolo": true | false,
  "model": "<model>" | null
}
```
Note: `claude_pid` is later added by `start.sh` via sed insertion before the closing `}`.

#### `.ittybitty/agents/<id>/prompt.txt`
Contains the full assembled prompt with prefix:
- Completion instructions (PR creation for managers with worktree, or no-worktree instructions)
- Custom all-agents prompt from config (`CONFIG_PROMPT_ALL`)
- Custom role-specific prompt from config (`CONFIG_PROMPT_WORKER` or `CONFIG_PROMPT_MANAGER`)
- The user's prompt

#### `.ittybitty/agents/<id>/start.sh` (executable)
```bash
#!/bin/bash
export PATH="<ROOT_REPO_PATH>:$PATH"
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
claude --session-id "<session_uuid>" <CLAUDE_ARGS> "$(cat '<abs_prompt_file>')" &
CLAUDE_PID=$!
# Insert claude_pid into meta.json via sed
wait $CLAUDE_PID
<abs_exit_script>
```

CLAUDE_ARGS composition:
- If yolo: `--dangerously-skip-permissions --permission-mode bypassPermissions`
- If print: `--print`
- If allow-tools: `--allowedTools <LIST>`
- If deny-tools: `--disallowedTools <LIST>`
- If model: `--model <MODEL>`

#### `.ittybitty/agents/<id>/exit-check.sh` (executable)
Interactive script that runs after Claude exits. Checks for uncommitted changes (offers to commit) and unpushed commits (offers to push).

#### `.ittybitty/agents/<id>/agent.log`
Timestamped log entries: `[YYYY-MM-DD HH:MM:SS] <message>`

### Git Commands
1. **Create worktree** (if `USE_WORKTREE=true`):
   ```
   git -C <ROOT_REPO_PATH> worktree add <AGENT_DIR>/repo -b agent/<id> <BASE_REF>
   ```
   - `BASE_REF` = `agent/<manager-id>` if manager specified, else `HEAD`
   - On failure: `rm -rf <AGENT_DIR>`, exit 1

### Settings File
If worktree mode, creates `.ittybitty/agents/<id>/repo/.claude/settings.local.json`:
- Built from `build_agent_settings()` which merges base `.claude/settings.local.json` with configured permissions
- Replaces `__AGENT_ID__` placeholder with actual agent ID via sed

If non-worktree mode, ensures root repo's `.claude/settings.local.json` has `Bash(ib:*)` and `Bash(./ib:*)` in `permissions.allow`.

### Tmux Commands
1. `tmux start-server` — ensure server is running (idempotent)
2. `tmux new-session -d -x 60 -s <tmux_session> -c <WORK_PATH> <abs_start_script>`
3. `tmux has-session -t <tmux_session>` — verify session created

### Post-Creation
1. **Output agent ID** to stdout immediately
2. **Post-create-agent hook**: If `.ittybitty/hooks/post-create-agent` exists and is executable, run it in background with env vars: `IB_AGENT_ID`, `IB_AGENT_TYPE` (worker|manager), `IB_AGENT_DIR`, `IB_AGENT_BRANCH`, `IB_AGENT_MANAGER`, `IB_AGENT_PROMPT`, `IB_AGENT_MODEL`
3. **Auto-accept workspace trust**: If not yolo, run `auto_accept_workspace_trust()` in background — polls tmux output for permissions screen, sends Enter keys to accept
4. **Auto-spawn watchdog**: If agent has a manager, run `ib watchdog <id>` in background, output to `<AGENT_DIR>/watchdog.log`

### Error Cleanup
On any tmux/worktree creation failure:
```
rm -rf <AGENT_DIR>
git -C <ROOT_REPO_PATH> worktree remove <AGENT_DIR>/repo --force
git -C <ROOT_REPO_PATH> branch -D agent/<id>
```

---

## 2. kill (cmd_kill)

### Arguments
| Flag | Type | Default | Description |
|------|------|---------|-------------|
| positional | string | required | Agent ID |
| `--force` | bool | false | Skip confirmation |

### Validation
1. Agent ID required
2. Must be in git repo
3. Resolve partial ID
4. If not `--force`: check agent exists first (directory or tmux session), then prompt for confirmation. If `is_running_as_agent()`, error (can't prompt in non-interactive mode)

### Core Logic (`do_kill`)
1. Check agent exists (directory or tmux session). Set `KILL_STATUS=error` if not found.
2. Remove questions: delete entries for this agent from `.ittybitty/user-questions.json`
3. Call `teardown_agent(id, "", "Agent killed")`
4. Call `scan_and_kill_orphans()` — find Claude processes whose cwd is in a deleted agent dir

### Teardown Agent (`teardown_agent`)
This is the shared cleanup function. Steps in order:

1. **Log** the action to `agent.log`
2. **Capture tmux output** before killing:
   ```
   tmux capture-pane -t <tmux_session> -p -S - > <AGENT_DIR>/output.log
   ```
3. **Kill Claude process** (`kill_agent_process`):
   - Strategy 1: Get pane PID from tmux (`tmux list-panes -t <session> -F '#{pane_pid}'`), then `pgrep -P <pane_pid> -f "claude"`
   - Strategy 2: Read `claude_pid` from meta.json
   - Send SIGTERM, wait up to 2s (20 × 0.1s polls), then SIGKILL if still alive
4. **Kill tmux session**:
   ```
   tmux kill-session -t <tmux_session>
   ```
5. **Copy settings** for archiving:
   ```
   cp <AGENT_DIR>/repo/.claude/settings.local.json <AGENT_DIR>/settings.local.json
   ```
6. **Remove git worktree** (if exists):
   ```
   git worktree remove <AGENT_DIR>/repo --force
   ```
   Fallback: `rm -rf <AGENT_DIR>/repo`
7. **Delete git branch**:
   ```
   git branch -D agent/<id>
   ```
8. **Archive** (`archive_agent_output`):
   - Creates `<ARCHIVE_DIR>/<YYYYMMDD-HHMMSS>-<id>/`
   - Moves/copies: `output.log` (move), `agent.log` (copy), `meta.json` (copy), `settings.local.json` (move), `debug-logs/` (copy recursive)
9. **Remove agent directory**: `rm -rf <AGENT_DIR>`

### Output
- Success: `"Closed agent: <id>"`
- Error: exits 1

---

## 3. pause (cmd_pause)

### Arguments
| Flag | Type | Default | Description |
|------|------|---------|-------------|
| positional | string | required | Agent ID |

### Validation
1. Agent ID required
2. Must be in git repo
3. Resolve partial ID
4. Agent directory must exist
5. Agent state must NOT be "stopped" (checked via `get_state()`)

### Actions
1. **Kill Claude process** via `kill_agent_process(id)` (SIGTERM → wait 2s → SIGKILL)
2. **Kill tmux session**:
   ```
   tmux kill-session -t <tmux_session>
   ```
3. **Log** to agent.log: "Agent paused"

### What is Preserved
- Agent directory and all files
- meta.json (including `session_id` for resume)
- Git worktree and branch
- agent.log history

### What is Removed
- Claude process (killed)
- Tmux session (killed)

### Output
`"Agent paused. Use 'ib resume <id>' to continue."`

---

## 4. resume (cmd_resume)

### Arguments
| Flag | Type | Default | Description |
|------|------|---------|-------------|
| positional | string | required | Agent ID |

### Validation
1. Agent ID required
2. Must be in git repo
3. Resolve partial ID
4. Agent directory must exist
5. Agent state must be "stopped" (checked via `get_state()`). Shows state-specific help for other states.
6. `meta.json` must exist and contain a non-null/non-empty `session_id`

### Reading from meta.json
- `session_id` — the Claude session UUID for `--resume`
- `model` — the model to use (null/"null" treated as empty)

### Detecting Yolo Mode
Reads `start.sh` — if it contains `dangerously-skip-permissions`, yolo mode is true.

### Files Created

#### `.ittybitty/agents/<id>/resume.sh` (executable)
```bash
#!/bin/bash
export PATH="<GIT_ROOT>:$PATH"
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
claude --resume "<session_uuid>" <CLAUDE_ARGS> &
CLAUDE_PID=$!
# Insert claude_pid into meta.json via sed
wait $CLAUDE_PID
<abs_exit_script>
```

`CLAUDE_ARGS`:
- If yolo: `--dangerously-skip-permissions --permission-mode bypassPermissions`
- If model: `--model <model>`

### Work Directory
- If `<AGENT_DIR>/repo` exists → use it
- Otherwise → use `$(pwd)` (cwd at time of resume)

### Tmux Commands
1. `tmux start-server`
2. `tmux new-session -d -x 60 -s <tmux_session> -c <WORK_PATH> <abs_resume_script>`

### Post-Resume
1. If not yolo: `auto_accept_workspace_trust(<tmux_session>)`
2. Log and print: `"Use 'ib look <id>' to view output"`
3. **Send resume nudge** (after a brief delay):
   ```
   tmux send-keys -t <tmux_session> "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line."
   sleep 0.1
   tmux send-keys -t <tmux_session> Enter
   ```
4. Log: "Sent resume nudge"

---

## 5. merge (cmd_merge)

### Arguments
| Flag | Type | Default | Description |
|------|------|---------|-------------|
| positional | string | required | Agent ID |
| `--into BRANCH` | string | auto-detected | Target branch |
| `--force` | bool | false | Skip confirmation |

### Validation (cmd_merge level)
1. Agent ID required
2. Must be in git repo
3. Resolve partial ID
4. Agent directory must exist
5. Agent must have a worktree (`<AGENT_DIR>/repo` must exist)
6. Cannot merge from within the agent's own worktree (cwd check)
7. **Agent's worktree** must have no uncommitted changes (`git -C <worktree> status --porcelain`)
8. **Target branch detection** (if not `--into`): current branch → `main` → `master` → error
9. Agent branch `agent/<id>` must exist (`git show-ref --verify refs/heads/agent/<id>`)
10. **Current directory** must have no uncommitted changes (`git status --porcelain`)
11. **Pre-rebase conflict check** (`check_rebase_conflicts`):
    - Creates temp branch from agent branch
    - Creates temp worktree
    - Attempts `git rebase <target>` in temp worktree
    - If conflicts: abort rebase, clean up, error with detailed conflict info
    - Always cleans up temp branch and worktree
12. Show commits to merge (`git log <target>..<branch> --oneline`), count them
13. If not `--force` and commits > 0: prompt for confirmation (error if `is_running_as_agent()`)

### Core Logic (`do_merge`)
After all cmd_merge validation passes, `do_merge` re-validates then:

1. **Rebase** agent branch onto target (in agent's worktree):
   ```
   git -C <worktree_path> rebase <target_branch>
   ```
2. **Checkout** target branch (in current repo):
   ```
   git checkout <target_branch>
   ```
3. **Merge** — behavior depends on caller:
   - If `is_running_as_agent()` (agent merging sub-agent):
     ```
     git merge --ff-only agent/<id>
     ```
   - If user/root (not in agent):
     ```
     git merge --no-ff agent/<id> -m "Merge agent <id> work"
     ```
4. **Capture tmux output**:
   ```
   tmux capture-pane -t <tmux_session> -p -S - > <AGENT_DIR>/output.log
   ```
5. **Kill Claude process** (`kill_agent_process`)
6. **Kill tmux session**:
   ```
   tmux kill-session -t <tmux_session>
   ```
7. **Remove worktree**:
   ```
   git worktree remove <worktree_path> --force
   ```
   Fallback: `rm -rf <worktree_path>`
8. **Delete branch**:
   ```
   git branch -D agent/<id>
   ```
9. **Archive** (`archive_agent_output`): same as kill
10. **Remove questions** from `.ittybitty/user-questions.json`
11. **Remove agent directory**: `rm -rf <AGENT_DIR>`
12. **Scan for orphaned Claude processes**

### Output
- Success: `"Closed agent: <id>"`
- Error: exits 1 with detailed message

---

## 6. send (cmd_send)

### Arguments
| Flag | Type | Default | Description |
|------|------|---------|-------------|
| positional 1 | string | required | Target agent ID |
| positional 2+ | string | optional | Message text |
| `--from ID` | string | auto-detected | Sender agent ID |
| stdin | string | optional | Message if no positional |

### Validation
1. Target ID required
2. Must be in git repo
3. Resolve partial ID
4. Agent must have an active tmux session (`tmux has-session -t <tmux_session>`)
5. Message required (from args, or from stdin if not a TTY)

### Auto-detect Sender
If `--from` not set and cwd matches `*/.ittybitty/agents/*/repo*`, read sender ID from that agent's `meta.json`.

### Message Formatting
If `FROM_ID` is set: `"[sent by agent <FROM_ID>]: <message>"`

### Tmux Commands
```
tmux send-keys -t <tmux_session> "<message>"
sleep <delay>
tmux send-keys -t <tmux_session> Enter
```

**Delay calculation**: `0.1 + (msg_len / 100) * 0.5` seconds, clamped to `[0.2, 3.0]` seconds.

### Logging
- Log to recipient's `agent.log`: "Received message from <sender>: <msg>" (quiet)
- Log to sender's `agent.log`: "Sent message to <target>: <msg>"
- If no sender: print `"Sent to <id>"` to stdout

---

## 7. nuke (cmd_nuke)

### Arguments
| Flag | Type | Default | Description |
|------|------|---------|-------------|
| positional | string | optional | Target agent ID (if omitted, kills ALL) |
| `--force` | bool | false | Skip confirmation |

### Behavior: With Target ID
1. Resolve partial ID
2. Check if target is a worker with no children → error (use `ib kill` instead)
3. Get all descendants recursively via `get_descendants_recursive(id)`:
   - Includes the target itself as first element
   - Depth-first traversal: for each child, recursively get their descendants
   - Children found by matching `manager` field in meta.json
4. If no agents found → exit

### Behavior: Without Target ID
1. Collect all agents from `AGENTS_DIR/*/` that have `meta.json`

### Confirmation
If not `--force` and agents to kill > 0:
- If `is_running_as_agent()` → error
- List agents to be killed, prompt `[y/N]`

### Core Logic (`do_nuke`)
For each agent in the kill list:
1. Remove questions from `.ittybitty/user-questions.json`
2. Call `teardown_agent(id, "--quiet", "Agent nuked")` — same teardown as kill

After killing agents:
1. **Clean up orphaned tmux sessions**:
   - List all tmux sessions: `tmux list-sessions -F '#{session_name}'`
   - Filter to sessions with `SESSION_PREFIX`
   - Kill any that don't have a matching agent directory
2. **Scan for orphaned Claude processes** (`scan_and_kill_orphans`)

### Output
Reports: `"Results: N agent(s) killed, M orphaned session(s) cleaned up, F failed"`

### Exit Codes
- `NUKE_STATUS=ok` → exit 0
- `NUKE_STATUS=partial` or `error` → exit 1

---

## Shared Helper Functions

### resolve_agent_id(partial)
1. **Exact match**: Check if `AGENTS_DIR/<partial>` exists or `tmux has-session -t session_name(partial)` succeeds → return partial
2. **Partial match**: Scan all `AGENTS_DIR/*/` directories and tmux sessions for IDs containing `partial`
3. 0 matches → error; 1 match → return it; 2+ matches → error listing all

### teardown_agent(id, quiet, log_msg)
See kill section above for full details. Shared by kill, nuke, and merge (merge does its own variant).

### archive_agent_output(id)
1. Capture final tmux output if session still exists
2. Create `<ARCHIVE_DIR>/<YYYYMMDD-HHMMSS>-<id>/`
3. Move/copy: `output.log` (move), `agent.log` (copy), `meta.json` (copy), `settings.local.json` (move), `debug-logs/` (copy recursive)

### kill_agent_process(id)
1. Strategy 1: `tmux list-panes -t <session> -F '#{pane_pid}'` → `pgrep -P <pane_pid> -f "claude"`
2. Strategy 2: Read `claude_pid` from meta.json
3. SIGTERM → wait up to 2s → SIGKILL

### check_rebase_conflicts(target, source)
1. `git branch <temp-branch> <source>`
2. `git worktree add <temp-dir> <temp-branch> --quiet`
3. `cd <temp-dir> && git rebase <target>` — capture output
4. On failure: `git rebase --abort`
5. Cleanup: `git worktree remove <temp-dir> --force`, `git branch -D <temp-branch>`
6. Returns 0 (clean) or 1 (conflicts, with conflict output on stdout)

### count_agents()
Count directories in `AGENTS_DIR/*/` that have `meta.json`.

### ensure_ittybitty_dirs()
```
mkdir -p <ROOT_REPO_PATH>/.ittybitty/agents
mkdir -p <ROOT_REPO_PATH>/.ittybitty/archive
```

### log_agent(id, message, quiet?)
Appends `[YYYY-MM-DD HH:MM:SS] <message>` to `<AGENTS_DIR>/<id>/agent.log`. Echoes to stdout unless `--quiet`.

### auto_accept_workspace_trust(tmux_session)
Polls tmux output waiting for Claude to start. If permissions screen detected (contains "trust" or "Allow external CLAUDE.md file imports" + "Enter to confirm"), sends Enter keys up to 5 times with 4s waits between. Returns when Claude logo appears.

### scan_and_kill_orphans()
Finds Claude processes (`pgrep -f "claude"`) whose cwd contains `/.ittybitty/agents/` but the agent directory no longer exists. Kills them with SIGTERM → SIGKILL. On macOS, uses `lsof -a -d cwd -p <pid> -Fn` to get process cwd.

### get_descendants_recursive(manager_id)
Returns all descendants depth-first, including the manager itself as first element. Finds children by scanning all agents whose `manager` field matches.

### get_children(manager_id, filter)
Scans all agent directories. Returns those whose meta.json `manager` field matches. Filter options: `"all"`, `"unfinished"` (creating/running/waiting/complete), or exact state name.

---

## Config File (.ittybitty.json)

Located at repo root. Relevant fields:
- `maxAgents` (default: 10) — maximum concurrent agents
- `model` — default model for spawned agents
- `createPullRequests` — if true, managers get PR creation instructions
- `allowAgentQuestions` — if true, root managers can use `ib ask`
- `permissions.manager.allow` / `permissions.manager.deny` — tool permissions for managers
- `permissions.worker.allow` / `permissions.worker.deny` — tool permissions for workers
- `prompts.all` — custom instructions for all agents
- `prompts.manager` — custom instructions for managers
- `prompts.worker` — custom instructions for workers

---

## Environment Variables

| Variable | Usage |
|----------|-------|
| `CLAUDECODE` | Set by Claude Code; cleared (`unset`) in start/resume scripts |
| `CLAUDE_CODE_ENTRYPOINT` | Cleared in start/resume scripts to allow nesting |
| `IB_AGENT_ID` | Set for post-create-agent hook |
| `IB_AGENT_TYPE` | "worker" or "manager" for post-create-agent hook |
| `IB_AGENT_DIR` | Agent directory path for hook |
| `IB_AGENT_BRANCH` | Branch name for hook |
| `IB_AGENT_MANAGER` | Manager ID for hook |
| `IB_AGENT_PROMPT` | Prompt text for hook |
| `IB_AGENT_MODEL` | Model for hook |
| `IB_DEBUG_AGENT_DETECTION` | Debug flag for is_running_as_agent |

---

## Key Architectural Notes

1. **Session naming**: `ittybitty-<repo-id>-<agent-id>` — repo-id ensures multiple repos don't collide in tmux
2. **Worktree isolation**: Each agent gets its own worktree branching from parent's branch (or HEAD)
3. **Merge strategy**: Agent-to-agent merges use `--ff-only` (linear history); user-to-agent uses `--no-ff` (preserves merge point)
4. **Rebase-then-merge**: Always rebases agent branch onto target before merging, with pre-check for conflicts
5. **Process management**: Two-phase kill (SIGTERM + 2s timeout + SIGKILL) with both tmux-based and PID-based process discovery
6. **Archiving**: All agent artifacts are archived before deletion, timestamped in `.ittybitty/archive/`
7. **Question cleanup**: All commands that close agents also clean up `.ittybitty/user-questions.json`
8. **Orphan scanning**: Kill and nuke scan for orphaned Claude processes and tmux sessions after cleanup

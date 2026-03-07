# Feature Parity: ittybitty (bash) vs itsybitsy (Bun/TypeScript)

Comprehensive gap analysis. For each feature, documents what ittybitty does, what itsybitsy does, and what's missing.

---

## Table of Contents

1. [CLI Commands](#1-cli-commands)
2. [Agent Spawning (`new-agent`)](#2-agent-spawning-new-agent)
3. [Agent Lifecycle Commands](#3-agent-lifecycle-commands)
4. [Monitoring Commands](#4-monitoring-commands)
5. [Communication](#5-communication)
6. [Watchdog](#6-watchdog)
7. [Hooks System](#7-hooks-system)
8. [Configuration System](#8-configuration-system)
9. [Watch Dashboard](#9-watch-dashboard)
10. [Watch Dialogs](#10-watch-dialogs)
11. [State Detection](#11-state-detection)
12. [Agent Data & Metadata](#12-agent-data--metadata)
13. [Security & Permissions](#13-security--permissions)
14. [Archive System](#14-archive-system)
15. [Miscellaneous Features](#15-miscellaneous-features)
16. [Features That Don't Apply](#16-features-that-dont-apply)
17. [Recommended Implementation Order](#17-recommended-implementation-order)

---

## 1. CLI Commands

### Already Implemented in itsybitsy

| ib Command | itsybitsy Equivalent | Notes |
|---|---|---|
| `ib watch` | `itsybitsy watch` | Core dashboard; see Section 9 for gaps |
| `ib list` | Direct file reads in `agents.ts` | itsybitsy reads `.ittybitty/agents/` directly instead of shelling to `ib list` |
| `ib tree` | Built into dashboard (TREE pane, mode 3) | Rendered in right pane; also used for agent tree at top |

### Missing CLI Commands

These are ib commands that itsybitsy doesn't expose as its own CLI subcommands. Most aren't needed because itsybitsy shells to `ib` for mutations, but some could be useful.

| ib Command | Status | Notes |
|---|---|---|
| `ib config` | Not needed | itsybitsy reads `.ittybitty.json` directly. Could add `itsybitsy config` for `~/.itsybitsy.json` management |
| `ib hooks` | Not needed | itsybitsy doesn't manage hooks — that's ib's job. But see Section 7 for hooks itsybitsy should fire |
| `ib parse-state` | Internal only | itsybitsy has `parseState()` in TypeScript |
| `ib log` | Not exposed | itsybitsy reads `agent.log` directly but doesn't write to it |
| `ib info` | Not needed | itsybitsy reads `meta.json` directly |
| `ib is-in-agent-worktree` | Not needed | Utility command |
| `ib is-in-main-repo` | Not needed | Utility command |
| `ib pause` | **MISSING** | See Section 3 |
| `ib nuke` (targeted) | Partial | See Section 3 |

---

## 2. Agent Spawning (`new-agent`)

### How ittybitty does it (ib lines 6593–7157)

`cmd_new_agent()` is the most complex command. It:

1. **Parses flags:** `--name`, `--manager`/`--parent`, `--no-worktree`, `--allow-tools`, `--deny-tools`, `--print`, `--yolo`, `--worker`/`--leaf`, `--model`, `--prompt-file`
2. **Reads prompt from stdin** if no positional arg and stdin is a pipe
3. **Requires git repo** (`require_git_repo`)
4. **Auto-detects manager** from current worktree path (if running inside an agent worktree)
5. **Validates manager:** resolves partial IDs, checks manager exists, verifies manager is not a worker
6. **Yolo escalation prevention:** if `--yolo` is set and running from a non-yolo agent's worktree, rejects the request (security check, ib lines 6745–6781)
7. **Loads config:** `load_config` + `load_custom_prompts` (reads `.ittybitty/prompts/all.md`, `manager.md`, `worker.md`)
8. **Applies model from config** if `--model` not specified; falls back to `sonnet`
9. **Checks max agents limit** (`CONFIG_MAX_AGENTS`, default 10)
10. **Generates agent ID:** custom `--name` or `agent-$(openssl rand -hex 4)`
11. **Creates git worktree** on branch `agent/{id}`, forked from manager's branch or HEAD
12. **Builds agent settings:** `build_agent_settings()` creates `.claude/settings.local.json` in the worktree with:
    - Merged permissions from base settings + config permissions
    - PreToolUse hook (`ib hooks agent-path {id}`)
    - Stop hook (`ib hooks agent-status {id}`)
    - PermissionRequest hook (deny non-allowed tools)
    - SessionStart hook (`ib hooks session-start`)
    - Auto-compact setting if configured
13. **Writes meta.json** with id, session_id (UUID), tmux_session, prompt, manager, created, created_epoch, worktree, worker, yolo, model
14. **Logs creation** to both agent's log and manager's log
15. **Builds prompt:** PR instructions (if `createPullRequests` config + `gh` available), custom prompts (`all.md`, `manager.md`/`worker.md`), user's task
16. **Writes prompt.txt**
17. **Builds claude command:** `claude --session-id {uuid} [--dangerously-skip-permissions] [--print] [--allowedTools] [--disallowedTools] [--model]`
18. **Creates start.sh** and **exit-check.sh** scripts
19. **Creates tmux session:** `tmux new-session -d -x 60 -s {session} -c {worktree} {start.sh}`
20. **Runs post-create-agent hook** if `.ittybitty/hooks/post-create-agent` exists (in background)
21. **Auto-accepts workspace trust** dialog for non-yolo mode (in background)
22. **Auto-spawns watchdog** if agent has a manager: `ib watchdog {id} > {agent_dir}/watchdog.log 2>&1 &`

### What itsybitsy implements

`ib-commands.ts:newAgent()` shells to `ib new-agent` with flags: `--name`, `--worker`, `--yolo`, `--model`, plus the prompt. Dashboard `a` key opens a dialog with repo picker → name → model → worker toggle → prompt.

### Gaps

| Gap | Detail | Implementation Notes |
|---|---|---|
| **Missing `--manager` flag** | itsybitsy's `newAgent()` doesn't pass `--manager`. When spawning from the TUI, agents created have no manager by default. | Add `manager?: string` to `NewAgentOptions`; if selected agent is a manager, pass `--manager {selected.id}` |
| **Missing `--no-worktree` flag** | Not exposed in dialog or options | Add to `NewAgentOptions` if needed |
| **Missing `--allow-tools` / `--deny-tools`** | Not exposed | Low priority — config-based permissions are preferred |
| **Missing `--print` flag** | One-shot mode not exposed | Low priority |
| **Missing `--prompt-file` flag** | Not exposed | Could use for long prompts |
| **No custom prompts awareness** | itsybitsy doesn't read `.ittybitty/prompts/{all,manager,worker}.md` | Not needed — `ib new-agent` handles this. But dashboard could show custom prompt status |

---

## 3. Agent Lifecycle Commands

### `ib kill` (ib lines 7909–8002)

**ittybitty:** `cmd_kill()` resolves partial ID, confirms unless `--force`, calls `do_kill()` which:
- Calls `teardown_agent()` (logs, captures output, kills Claude process, kills tmux session, archives, removes worktree+branch)
- Removes agent's questions from `user-questions.json`
- Scans for orphaned processes (`scan_and_kill_orphans`)

**itsybitsy:** `killAgent()` shells to `ib kill {id} --force`. Dashboard `x` key shows confirm dialog first.

**Gap:** None significant — itsybitsy correctly delegates to `ib kill`.

### `ib nuke` (ib lines 8007–8167)

**ittybitty:** `cmd_nuke()` has two modes:
- **No ID:** Kill ALL active agents (emergency stop)
- **With ID:** Kill the specified agent AND all its descendants recursively

Supports `--force` flag. Calls `do_nuke()` which iterates agents, removes their questions, calls `teardown_agent()` for each, then `scan_and_kill_orphans()`. Reports counts: killed, failed, orphans cleaned.

**itsybitsy:** `nukeAgent()` just calls `ib kill {id} --force` — same as `killAgent()`. Dashboard `!` key triggers this.

**Gaps:**
| Gap | Detail |
|---|---|
| **No recursive nuke** | itsybitsy's nuke doesn't kill descendants. Should call `ib nuke {id} --force` instead of `ib kill {id} --force` |
| **No nuke-all** | No way to kill all agents at once from TUI. Could add a keybinding or dialog |

### `ib pause` (ib lines 8168–8257)

**ittybitty:** `cmd_pause()` gracefully stops an agent:
- Kills the Claude process via `kill_agent_process()`
- Kills the tmux session
- Preserves: agent directory, meta.json (with session_id), git worktree, agent.log
- Agent shows as "stopped" state, can be resumed with `ib resume`

**itsybitsy:** **Not implemented.** No `pauseAgent()` function, no keybinding.

**Implementation:** Add `pauseAgent()` to `ib-commands.ts` that calls `ib pause {id}`. Add keybinding (e.g., `P`) in dashboard.

### `ib resume` (ib lines 8263–8457)

**ittybitty:** `cmd_resume()`:
- Validates agent is stopped
- Reads session_id, model, yolo mode from meta.json/start.sh
- Builds resume script: `claude --resume {session_uuid} [--model] [--dangerously-skip-permissions]`
- Creates new tmux session with resume script
- Auto-accepts workspace trust for non-yolo
- Sends nudge prompt: "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL'"

**itsybitsy:** `resumeAgent()` shells to `ib resume {id}`. Dashboard `R` key triggers it (only for stopped/complete agents).

**Gap:** None — correctly delegates to `ib resume`.

### `ib reassign` (ib lines 8459–8765)

**ittybitty:** `cmd_reassign()`:
- Validates agent exists, new parent exists (or `--none` to make root)
- Validates new parent is not a worker
- Circular dependency check (`is_descendant_of()`)
- Updates meta.json `manager` field
- Logs the reassignment

**itsybitsy:** `reassignAgent()` shells to `ib reassign {id} {new-manager}`. Dashboard `r` key opens text input dialog.

**Gap:** Dashboard reassign dialog is a free-text input. ib watch uses a **select list** showing all valid managers plus "(No parent - make root)". itsybitsy should show a select list filtered to valid managers.

### `ib merge` (ib lines 8762–8991)

**ittybitty:** `cmd_merge()`:
- Resolves partial ID, determines target branch (current branch or main/master)
- Checks for uncommitted changes in both current dir and agent worktree
- Pre-rebase conflict check (`check_rebase_conflicts()`)
- Shows commit count, confirms
- Calls `do_merge()`: rebases agent branch onto target, then merges
  - Manager→worker merges use `--ff-only` (linear history)
  - User→agent merges use `--no-ff` (preserves branch point)
- Teardown: kills process, kills tmux, archives, removes worktree/branch
- Removes agent's questions from `user-questions.json`

**itsybitsy:** `mergeAgent()` shells to `ib merge {id} --force`. Dashboard `m` key runs `mergeCheckAgent()` first, shows confirm dialog with merge readiness.

**Gap:** None significant — delegates to `ib merge` correctly. The `--into` flag is not exposed but rarely needed from TUI.

### `ib merge-check` (ib lines 8993–9128)

**ittybitty:** `cmd_merge_check()`:
- Checks uncommitted changes in current dir and agent worktree
- Checks for rebase conflicts (`check_rebase_conflicts()`)
- Shows commit count and file summary
- Returns exit code 0 (clean) or 1 (conflicts)

**itsybitsy:** `mergeCheckAgent()` shells to `ib merge-check {id}`. Used by `m` key before merge dialog.

**Gap:** None.

---

## 4. Monitoring Commands

### `ib look` (ib lines 7509–7602)

**ittybitty:** `cmd_look()`:
- Captures tmux output with `tmux capture-pane -p -S -{lines}`
- Supports `--lines N` (default 50), `--all`, `--follow` (attaches to tmux session)
- Falls back to `output.log` if agent is finished

**itsybitsy:** Equivalent is the live tmux pane in the dashboard (TmuxPoller captures 500 lines at ~1s). No standalone CLI command.

**Gap:** No `--follow` mode (attaching to tmux). The `G` key (Ghostty) serves a similar purpose.

### `ib status` (ib lines 7604–7738)

**ittybitty:** Shows branch name, commits vs target branch (merge-base comparison), uncommitted changes, files changed summary.

**itsybitsy:** `statusAgent()` shells to `ib status {id}`. Dashboard mode 6 (STATUS) shows the output.

**Gap:** None.

### `ib diff` (ib lines 7740–7824)

**ittybitty:** Shows full diff using merge-base comparison. Supports `--stat` for summary only.

**itsybitsy:** `diffAgent()` shells to `ib diff {id}`. Dashboard mode 5 (DIFF) shows the output.

**Gap:** `--stat` flag not exposed, but not needed in TUI.

### `ib info` (ib lines 7826–7905)

**ittybitty:** Displays raw `meta.json` contents (pretty-printed).

**itsybitsy:** Reads `meta.json` directly. No dedicated info pane, but data is shown in agent tree (model, state, age) and could be added as a debug view.

**Gap:** No raw meta.json viewer. Low priority — PLAN.md lists this as optional (`i` keybinding).

---

## 5. Communication

### `ib send` (ib lines 7374–7507)

**ittybitty:** `cmd_send()`:
- Resolves target agent, checks tmux session exists
- Reads message from args or stdin (supports pipe: `echo "msg" | ib send {id}`)
- **Auto-detects sender** when running from agent worktree (reads meta.json), prefixes `[sent by agent {from_id}]: `
- Sends to tmux: `tmux send-keys -t {session} "{msg}"` then delay then Enter
  - **Delay scales with message length:** `0.1 + (len/100)*0.5`, min 0.2s, max 3s
- Logs to both sender and recipient

**itsybitsy:** `sendMessage()` shells to `ib send {id} {message}`. Dashboard `s` key opens text input dialog.

**Gaps:**
| Gap | Detail |
|---|---|
| **No send-to-all** | ib watch has `a` toggle in send dialog for "send to all alive agents." itsybitsy's send dialog only sends to selected agent |
| **No `--from` flag** | Not needed from TUI context |

### `ib ask` (ib lines 14057–14199)

**ittybitty:** Allows top-level manager agents to ask the user a question:
- Auto-detects agent ID from worktree
- Validates: must be top-level (no manager), or manager must be dead
- Checks `allowAgentQuestions` config
- Generates question ID (`q-{timestamp}-{hash}`)
- Writes to `.ittybitty/user-questions.json`
- Logs the question

**itsybitsy:** Reads `user-questions.json` directly. Dashboard mode 7 (QUESTIONS) shows pending questions. `Enter` key answers (acknowledges + sends reply).

**Gap:** None — `ib ask` is agent-side, not TUI-side. itsybitsy correctly surfaces questions.

### `ib acknowledge` (ib lines 14205–14286)

**ittybitty:** Marks a question as handled in `user-questions.json`.

**itsybitsy:** `acknowledgeQuestion()` shells to `ib acknowledge {questionId}`. Used by `Enter` in QUESTIONS pane.

**Gap:** None.

### `ib questions` (ib lines 14292–14365)

**ittybitty:** Lists pending (or all with `--all`) questions, filtered to exclude dead agents.

**itsybitsy:** `readPendingQuestions()` reads directly from `user-questions.json`.

**Gap:** itsybitsy doesn't filter out questions from dead agents (agents no longer in `.ittybitty/agents/`). Should add this filter.

---

## 6. Watchdog

### `ib watchdog` (ib lines 14367–14709)

This is a **background monitoring process** that runs for each agent with a manager. It's spawned automatically by `ib new-agent` when the agent has a manager.

**How it works:**
- Polls agent state every 5 seconds (`sleep 5` loop)
- Runs while agent's worktree directory exists
- Tracks `prev_state` to detect state changes
- Uses exponential backoff for notifications (start at 30s, doubles: 30s→1m→2m→4m→8m→16m→32m→64m cap)

**State handlers:**

| State | Watchdog Behavior |
|---|---|
| `waiting` | Increments counter. After threshold reached, sends `ib send {manager} "[watchdog]: Your subtask {id} recently started waiting for input"`. Exponential backoff. |
| `complete` | Sends `ib send {manager} "[watchdog]: Your subtask {id} recently completed"`. Only notifies once (until agent resumes). |
| `running` | Resets waiting counter and backoff interval. Clears completion flag if agent resumed from complete. |
| `creating` | Treats like running (reset counters). |
| `unknown` | Treats like waiting (increments counter, same notification logic). Saves debug log. |
| `rate_limited` | Attempts to bypass rate limit dialog (`bypass_rate_limit`). Checks usage API (`fetch_claude_usage`). When usage drops below 10%, sends nudge to agent. |
| `compacting` | Normal operation, resets counters. |
| `stopped` | Resets counters, no notification. |

**Auto-compact feature:**
- If `autoCompactThreshold` config is set (1-100)
- Watchdog reads `get_agent_context_usage()` from transcript file
- When context usage % exceeds threshold, sends `/compact` to the agent's tmux session
- Tracks `compact_sent` flag to avoid duplicate sends

**itsybitsy status:** **Not implemented.** itsybitsy has no watchdog equivalent. The `watcher.ts` polls states every 2s, but it does NOT:
- Notify managers when workers change state
- Auto-send `/compact` when context usage is high
- Bypass rate limit dialogs
- Send nudge messages to agents

### Implementation Plan for Watchdog in itsybitsy

The watchdog is one of the most valuable features to implement. There are two approaches:

**Option A: Shell to `ib watchdog`** — Simple, but creates N background processes per agent. This is what `ib new-agent` already does, so any agent spawned via `ib new-agent` (which itsybitsy uses) already has a watchdog. **No itsybitsy work needed for agents spawned through itsybitsy.**

**Option B: Built-in watchdog in itsybitsy** — Replace the per-agent bash watchdog with a single in-process watchdog loop in itsybitsy. Advantages: single process, can see all agents, can do cross-repo notifications. Would live in a new `src/watchdog.ts` module.

**Key behaviors to implement:**
1. Track state transitions per agent (previousState map)
2. On `waiting`/`unknown`: exponential backoff notifications to manager
3. On `complete`: one-time notification to manager
4. On `rate_limited`: bypass dialog + usage API check + nudge when recovered
5. On `running`/`creating`: reset counters
6. Auto-compact: read context usage %, send `/compact` when threshold exceeded

**Data needed:**
- Agent's manager ID (from `meta.json`)
- Agent's tmux session (from `meta.json`)
- `autoCompactThreshold` (from `.ittybitty.json`)
- Context usage % (from Claude transcript file: `~/.claude/projects/.../transcript.jsonl`)
- Usage API data (session %, reset time — already implemented in `usage.ts`)

---

## 7. Hooks System

### Overview

ittybitty installs Claude Code hooks in `.claude/settings.local.json`. These hooks fire in response to Claude Code events.

### Agent Hooks (installed per-agent in worktree)

These hooks are installed automatically by `ib new-agent` when building agent settings.

| Hook | Event | Command | What It Does |
|---|---|---|---|
| **agent-path** | `PreToolUse` | `ib hooks agent-path {id}` | Path isolation: blocks file access outside agent's worktree. Checks tool allow list. Blocks `cd` into other agent worktrees or main repo. |
| **agent-status** | `Stop` | `ib hooks agent-status {id}` | Fires when Claude stops (end of turn). Detects state from `last_assistant_message` (more reliable than tmux). Sends nudge if unknown/running. Notifies manager if complete/waiting. Checks for uncommitted changes. Checks for unfinished children (managers only). |
| **PermissionRequest** | `PermissionRequest` | Deny non-allowed tools | Logs denial and returns deny decision. |
| **SessionStart** | `SessionStart` | `ib hooks session-start` | Provides role-specific ittybitty instructions (agent identity, commands, workflow, path isolation rules). |

**itsybitsy implications:** These are all installed by `ib new-agent`, which itsybitsy shells to. No itsybitsy work needed for agent hooks.

### Main Repo Hooks (installed by user via `ib hooks install`)

| Hook | Event | Command | What It Does |
|---|---|---|---|
| **main-path** | `PreToolUse` | `ib hooks main-path` | Blocks primary Claude from `cd`-ing into agent worktrees. Only checks `Bash` tool `cd` commands. |
| **inject-status (full)** | `UserPromptSubmit` | `ib hooks inject-status --full --visible` | Injects full agent status tree into conversation context at start of each user message. Shows `<ittybitty-status>` block with all agents, states, ages, prompts. Includes pending questions. |
| **inject-status (if-changed)** | `PostToolUse` (Bash\|Task) | `ib hooks inject-status --if-changed --visible` | After Bash/Task tools, checks if status changed (SHA-256 hash comparison). If changed, injects brief summary. |
| **session-start** | `SessionStart` | `ib hooks session-start` | Provides primary Claude with ittybitty instructions (available commands, agent states, how to use `ib`). |

**itsybitsy implications:** These hooks are for the PRIMARY Claude session, not for itsybitsy itself. However, itsybitsy could:
1. Show hook installation status (like ib watch's setup dialog)
2. Offer to install hooks (shell to `ib hooks install`)

| Hook Subcommand | ib Command | itsybitsy Status |
|---|---|---|
| `ib hooks status` | Check if hooks installed | **Not implemented** |
| `ib hooks install` | Install all hooks | **Not implemented** |
| `ib hooks uninstall` | Remove all hooks | **Not implemented** |
| `ib hooks install-intercept` | Install Task interception | **Not implemented** |
| `ib hooks uninstall-intercept` | Remove Task interception | **Not implemented** |

### Task Interception Hook (ib lines 12797–12952)

`ib hooks intercept-task` is a `PreToolUse` hook that intercepts Claude's native `Task` tool:
- When Claude tries to use `Task(subagent_type=Explore)` etc., the hook spawns an `ib new-agent --worker` instead
- Uses "allow + updatedInput" strategy to avoid sibling Task cascade errors
- Skip list: `Bash`, `statusline-setup`, `claude-code-guide`, `meta-agent`, `ib-merge` → these use native Task
- Workers don't get interception (they use native Task)
- Returns a stub `claude-code-guide` Task that reports the spawned agent ID

**itsybitsy implications:** This is purely a Claude Code hook. itsybitsy doesn't need to implement it, but should be able to show its status and toggle it (like ib watch's setup dialog).

### `ib hooks inject-status` (ib lines 13165–13417)

Generates agent status for injection into Claude's conversation:
- Three modes: `--full` (complete tree), `--if-changed` (only if hash changed), `--brief` (one-liner)
- `--visible` flag adds `systemMessage` field for user visibility
- Reads config: `hooks.injectStatus` (enable/disable), `hooks.statusVisible` (show to user)
- Skips if running from agent worktree (agents don't see status of other agents)
- Generates `<ittybitty-status>` block with all agents, states, ages, prompts
- Counts pending questions (filtered by alive agents)
- `--if-changed` mode: SHA-256 hash comparison against `/tmp/ib-status-hash-{repo-id}`

**itsybitsy implications:** This is a hook for Claude Code, not for itsybitsy. However, itsybitsy's TREE pane (mode 3) renders similar information.

---

## 8. Configuration System

### `ib config` (ib lines 22977–23442)

**ittybitty:** Full config management CLI:
- `ib config list [--global]` — show all settings with sources (project/user/default)
- `ib config get <key>` — get a value
- `ib config set <key> <value>` — set a scalar value
- `ib config add <key> <value>` — add to array (e.g., `permissions.manager.allow`)
- `ib config remove <key> <value>` — remove from array
- Two config files: `.ittybitty.json` (project, highest priority) and `~/.ittybitty.json` (user)

**Config keys:**

| Key | Default | Type | Description |
|---|---|---|---|
| `maxAgents` | 10 | number | Maximum concurrent agents |
| `model` | (none) | string | Default model for new agents |
| `fps` | 10 | number | Refresh rate for `ib watch` |
| `createPullRequests` | false | boolean | Create PRs on completion |
| `allowAgentQuestions` | true | boolean | Allow `ib ask` |
| `autoCompactThreshold` | (none) | number | Context % to trigger `/compact` |
| `externalDiffTool` | (none) | string | External diff viewer |
| `hooks.injectStatus` | true | boolean | Enable status injection |
| `hooks.statusVisible` | true | boolean | Show status to user |
| `permissions.manager.allow` | [] | string[] | Extra allowed tools for managers |
| `permissions.manager.deny` | [] | string[] | Denied tools for managers |
| `permissions.worker.allow` | [] | string[] | Extra allowed tools for workers |
| `permissions.worker.deny` | [] | string[] | Denied tools for workers |

**itsybitsy:** Reads `.ittybitty.json` values used by the TUI (noted in PLAN.md: `fps`). Has its own `~/.itsybitsy.json` for repo registry + `diffTool`. Does NOT expose `ib config`-equivalent commands.

**Gaps:**
| Gap | Detail |
|---|---|
| **No config reading** | itsybitsy doesn't read most config values (maxAgents, model, createPullRequests, etc.). It could show these in a settings view |
| **No settings dialog** | ib watch has a full setup/settings dialog (`h` key) with tabs for Setup, Project Settings, User Settings. itsybitsy's `h` key shows a read-only help overlay |

---

## 9. Watch Dashboard

### ib watch Overview (ib lines 14793–22976)

ib watch is approximately **8,200 lines** of bash. It implements a full-screen TUI with:

### Features Already Implemented in itsybitsy

| Feature | ib watch | itsybitsy | Notes |
|---|---|---|---|
| Agent tree | Top rows, max 5 visible, scrolls | Top rows, max 7 visible, scrolls | itsybitsy shows more rows |
| State color-coding | Color per state | Color per state | Matching |
| Manager/worker icons | `◆` manager, `⚙` worker | `◆` manager, `⚙` worker | Matching |
| Split pane (tmux + right) | Left=tmux, right=cycling pane | Left=tmux, right=cycling pane | Matching |
| Right pane modes | 8 modes (0–7) | 8 modes (0–7) | Matching |
| `j/k` navigation | Agent tree navigation | Agent tree navigation | Matching |
| `p/n` pane cycling | Forward/backward | Forward/backward | Matching |
| `d` jump to DIFF | Direct jump | Direct jump | Matching |
| `g` jump to STATUS | Direct jump | Direct jump (+ go-to-agent in QUESTIONS) | Matching |
| `e` jump to ERRORS | Direct jump | Direct jump | Matching |
| `q` jump to QUESTIONS | Direct jump | Direct jump | Matching |
| `;/l` scroll | Scroll both panes | Scroll both panes | Matching |
| `@` fuzzy jump | Agent name search | Agent name search | Matching |
| `/` command jump | Panel/command search | Pane mode search | Matching |
| `s` send message | Text input dialog | Text input dialog | See gaps below |
| `m` merge | Merge dialog with diff preview | Confirm dialog with merge-check | ib's is more elaborate |
| `x` kill | Confirm dialog | Confirm dialog | Matching |
| `!` nuke | Confirm dialog | Confirm dialog | See nuke gaps |
| `a` new agent | Multi-step dialog | Multi-step dialog | Matching (itsybitsy has repo picker) |
| `A` toggle archived | Shows/hides archived | Shows/hides archived | Matching |
| `r` reassign | Select list dialog | Text input dialog | itsybitsy should use select list |
| `R` resume | Direct action | Direct action | itsybitsy adds this |
| `G` Ghostty | Not in ib watch | Open in Ghostty | itsybitsy adds this |
| `w` open Finder | Not in ib watch | Open worktree in Finder | itsybitsy adds this |
| `o` external diff | Via setup dialog | Open with diffTool | itsybitsy adds this |
| `S` snapshot | Capture debug snapshot | Capture debug snapshot | Matching |
| `h` help/setup | **Setup dialog** (settings) | **Read-only help** | Major gap — see below |
| `Ctrl-C` quit | Exit | Exit | Matching |
| Status bar | Footer with keybindings | Footer with keybindings | See gaps |
| Usage display | Session + weekly % | Session + weekly % | Matching (itsybitsy uses dedicated `usage.ts`) |
| Pending questions badge | In footer | In footer | Matching |

### Features Missing from itsybitsy

| Feature | ib watch Detail | Priority |
|---|---|---|
| **Setup dialog (`h` key)** | Three tabs: Setup (hooks status, gitignore, config file), Project Settings, User Settings. Toggle hooks install/uninstall. Edit config values. | HIGH — this is how users configure ib |
| **Send-to-all toggle** | Send dialog has `a` key to toggle "send to all alive agents" | MEDIUM |
| **Merge dialog with diff preview** | ib watch's merge dialog shows diff content, conflict files, scroll through diff, merge status indicator | LOW — itsybitsy uses simpler confirm |
| **External diff tool dialog** | In setup dialog, configure `externalDiffTool` | LOW — itsybitsy uses `~/.itsybitsy.json` |
| **Feedback dialog** | After 5+ sessions, asks "Enjoying ittybitty?" with Yes/No/Later, max once per 7 days | NOT NEEDED for itsybitsy |
| **FPS targeting** | 3-frame rolling average for smooth frame rate targeting | LOW — itsybitsy uses pi-tui's rendering |
| **Update notification** | Checks for newer version once per hour, shows in header | LOW |
| **Orphan detection** | Shows warnings for orphaned tmux sessions (sessions without agent data) | MEDIUM — listed in PLAN.md Phase 8 |
| **Terminal title** | Sets terminal title to `ib watch: {selected-agent}` | LOW — listed in Phase 8B |
| **Minimum terminal size** | Shows warning if terminal too small (<20 rows or <80 cols) | LOW — listed in Phase 8B |
| **Diff colorization** | `+` green, `-` red, `@@`/headers dim | MEDIUM — listed in Phase 8C |
| **Agent log colorization** | Timestamps dim, `[bracket]` markers cyan | LOW — listed in Phase 8C |
| **Pane skip empty** | `p/n` cycling skips ERRORS (if 0 errors) and QUESTIONS (if 0 questions) | LOW — listed in Phase 8B |
| **Error count badge** | Red `[N errors]` in footer | LOW — listed in Phase 8B |
| **Scroll step size** | ib uses 10-line scroll steps | LOW — listed in Phase 8D |
| **Denial filter intervals** | ib uses `all/24h/7d`; itsybitsy uses `all/1h/10m` | LOW — listed in Phase 8D |
| **Answer dialog (QUESTIONS)** | ib watch has `a` key in questions pane for answer dialog; `g` key to jump to asking agent | Implemented differently — itsybitsy uses `Enter` |
| **Background diff collector** | ib watch loads diff in background subprocess, caches in temp file, reloads when agent changes | LOW — itsybitsy loads diff async when pane is active |

---

## 10. Watch Dialogs

### ib watch Dialog System (ib lines ~15000–21000)

ib watch implements a full dialog system with 16 dialog modes:

| Mode | Dialog | itsybitsy Status |
|---|---|---|
| 0 | None | ✅ |
| 1 | Send message | ✅ (text input) |
| 2 | Kill confirm | ✅ |
| 3 | Nuke confirm | ✅ |
| 4 | New agent | ✅ (multi-step) |
| 5 | Jump to agent (`@`) | ✅ (fuzzy search) |
| 6 | Setup/Settings (`h`) | ❌ **MISSING** — shows help instead |
| 7 | Merge | ✅ (simpler version) |
| 8 | External diff tool config | ❌ Not needed (uses `~/.itsybitsy.json`) |
| 9 | Command/panel jump (`/`) | ✅ |
| 10 | Feedback | ❌ Not needed |
| 11 | Number input (for settings) | ❌ Not needed without settings dialog |
| 12 | String input (for settings) | ❌ Not needed without settings dialog |
| 13 | Permissions editor | ❌ Not needed without settings dialog |
| 14 | Answer question | ✅ (via `Enter` in QUESTIONS) |
| 15 | Reassign manager | ❌ Uses text input instead of select list |

### Setup Dialog Detail (Mode 6)

The setup dialog (`h` key in ib watch) has **three tabs**:

**Tab 0 — Setup:**
- Safety hooks: installed/not-installed toggle (calls `ib hooks install` / `ib hooks uninstall`)
- Task interception: installed/not-installed toggle (calls `ib hooks install-intercept` / `ib hooks uninstall-intercept`)
- ib instructions in CLAUDE.md: installed/not-installed toggle
- .gitignore: .ittybitty in .gitignore toggle
- Config file: .ittybitty.json exists toggle
- External diff tool: configure tool command

**Tab 1 — Project Settings:**
- Lists all config keys from `.ittybitty.json` with current values
- Edit values (numbers, strings, booleans, arrays)
- Shows source: (project), (user), (default)

**Tab 2 — User Settings:**
- Lists all config keys from `~/.ittybitty.json`
- Same editing capability as project tab

**Implementation for itsybitsy:**
The setup dialog is a significant feature gap. To implement:
1. Add `setupDialog` state to dashboard
2. Read hook installation status via `ib hooks status` and `ib hooks status --intercept`
3. Toggle hooks via `ib hooks install`/`uninstall`
4. Read config via direct `.ittybitty.json` reads
5. Render tabbed dialog with Setup + Settings tabs

---

## 11. State Detection

### `parse_state` in ittybitty (ib lines ~2800–3500)

The bash `parse_state()` function uses ordered pattern matching on ANSI-stripped tmux output:

| Priority | State | Detection Method |
|---|---|---|
| 1 | `compacting` | `"Compacting conversation"` in last 5 lines |
| 2 | `running` (active) | `"(Esc to interrupt"` or `"⎿  Running"` in last 5 lines |
| 3 | `waiting` (tool) | `"⎿  Waiting"` in last 15 lines |
| 4 | `rate_limited` | Various rate limit strings in last 15 lines |
| 5 | `complete` | `"I HAVE COMPLETED THE GOAL"` in last 15 lines |
| 6 | `waiting` (WAITING) | `"WAITING"` as standalone line in last 15 lines, with no `⏺` after it |
| 7 | `running` (other) | `"(Esc to interrupt"` or `"⎿  Running"` in last 15 lines (broader window) |
| 8 | `running` (spinners) | Spinner characters `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` with `(esc to interrupt)` in last 15 lines |
| 9 | `running` (permission) | `"Allow"` + `"Deny"` in last 15 lines |
| 10 | `running` (broad spinners) | Spinners in last 20 lines with `(esc to interrupt)` in last 15 |
| 11 | `running` (background tasks) | `"⏵⏵"` with `"· N bashes"` in last 15 lines |
| 12 | `running` (race condition) | Hook race condition: `"ib hook"` in last line |
| 13 | `unknown` | No match |

**Additional pre-check** (`compute_state_from_content`): If output has <10 non-empty lines and no startup markers (`Claude Code v`, `╭─ Claude Code`, `[AGENT CONTEXT]`), return `creating`.

### itsybitsy `parseState()` (src/parse-state.ts)

Fully ported from bash. 43 tests. Minor ordering difference: checks active-running before tool-waiting (documented deviation).

**Gaps:**

| Gap | Detail |
|---|---|
| **`detect_state_from_message`** | ib's Stop hook uses `last_assistant_message` (from Claude's JSON) for more reliable state detection than tmux scraping. itsybitsy doesn't have this — it only uses tmux output. Not implementable without hook integration. |
| **Missing startup markers** | `"╭─ Claude Code"` and `"[AGENT CONTEXT]"` should be added to startup markers (Phase 8A item). |

---

## 12. Agent Data & Metadata

### meta.json Fields

| Field | itsybitsy Reads | Notes |
|---|---|---|
| `id` | ✅ | |
| `session_id` | ✅ | Used for resume |
| `tmux_session` | ✅ | Used for tmux capture |
| `prompt` | ✅ | Shown in tree, fallback for prompt.txt |
| `manager` | ✅ | Used for tree building |
| `created` | ✅ | |
| `created_epoch` | ✅ | Used for age computation |
| `worktree` | ✅ | |
| `worker` | ✅ | Affects icon display |
| `yolo` | ✅ | Stored in AgentMeta type |
| `model` | ✅ | Shown in tree |
| `claude_pid` | ✅ | Stored but not used |

### agent.log

**ittybitty:** Written by `log_agent()` with format `[YYYY-MM-DD HH:MM:SS] message`. Contains: creation, messages sent/received, watchdog state changes, hook events, denials.

**itsybitsy:** Reads `agent.log` for AGENT LOG pane (mode 0) and parses denials for DENIALS pane (mode 2).

**Gap:** itsybitsy doesn't write to `agent.log`. All log writing is done by `ib` commands. This is fine — itsybitsy is a viewer.

### prompt.txt

**itsybitsy:** `readAgentPrompt()` reads `prompt.txt`, falls back to `meta.prompt`. ✅

### user-questions.json

**itsybitsy:** `readPendingQuestions()` reads and filters for pending status. Used by QUESTIONS pane and badge. ✅

**Gap:** Doesn't filter out questions from dead agents (agents whose directory no longer exists in `.ittybitty/agents/`).

---

## 13. Security & Permissions

### Permission System

**ittybitty:** `build_agent_settings()` creates `.claude/settings.local.json` for each agent worktree:
- Base permissions from user's `.claude/settings.local.json`
- Always-allowed tools: `Bash(ib:*)`, `Bash(./ib:*)`, `Bash(git *)`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, etc.
- Always-denied tools: `EnterPlanMode`, `ExitPlanMode`
- Config-based allow/deny from `.ittybitty.json` `permissions.{manager,worker}.{allow,deny}`
- Workers get additional restrictions (no `Bash(ib new-agent:*)`, etc.)

**itsybitsy:** Not involved in permission management. `ib new-agent` handles this.

### Command Access Control

**ittybitty:** `enforce_command_access()` restricts what commands agents can run:
- Test/debug commands blocked for agents
- `ib watch` blocked for agents (except `--debug`)
- `ib hooks install/uninstall` blocked for agents

**itsybitsy:** Not applicable — this is `ib`'s responsibility.

### Yolo Escalation Prevention

**ittybitty:** Non-yolo agents cannot spawn yolo children (ib lines 6745–6781).

**itsybitsy:** Not applicable — handled by `ib new-agent`.

---

## 14. Archive System

### How Archiving Works

**ittybitty:** `teardown_agent()` (called by kill/merge):
1. Saves full Claude session log: `claude sessions list --json` → finds session by UUID → saves to `session.log`
2. Captures tmux output to `output.log`
3. Kills Claude process
4. Kills tmux session
5. Moves agent directory to `.ittybitty/archive/{timestamp}-{id}/`
6. Removes git worktree and branch

**itsybitsy:** Reads archived agents from `.ittybitty/archive/` directory. Shows/hides with `A` toggle. Archived agents always show as "stopped" state.

**Gap:** None — archiving is handled by `ib kill`/`ib merge`.

---

## 15. Miscellaneous Features

### `ib log` (ib lines 13965–14051)

**ittybitty:** Writes timestamped messages to an agent's `agent.log`. Auto-detects agent ID from worktree path.

**itsybitsy:** Not implemented, not needed (agent-side command).

### Version Checking / Update Notification

**ittybitty:** ib watch checks for updates once per hour:
- Reads `https://raw.githubusercontent.com/adamwulf/ittybitty/main/ib` (first 20 lines)
- Compares `VERSION` variable with current
- Shows "Update available: vX.X.X" in header

**itsybitsy:** Not implemented. Low priority.

### Session Tracking / Feedback

**ittybitty:** Tracks `ib watch` session count in `.ittybitty/feedback.json`. After 5+ sessions, shows "Enjoying ittybitty?" dialog once per 7 days max.

**itsybitsy:** Not implemented. Not needed.

### Orphan Cleanup

**ittybitty:** `scan_and_kill_orphans()` finds tmux sessions with the repo's prefix that have no matching agent directory. Kills them.

**itsybitsy:** Orphan detection listed in PLAN.md Phase 2 as deferred. Could be added.

### `ib tree` (ib lines 14715–14792)

**ittybitty:** CLI tree view with box-drawing characters, state badges, age, model. Shows agent count summary.

**itsybitsy:** Built into dashboard TREE pane (mode 3) and agent tree at top. Not a standalone CLI command.

---

## 16. Features That Don't Apply

| Feature | Reason |
|---|---|
| Browser/web UI | itsybitsy is terminal-only (same as ib) |
| `ib test-*` commands | Internal test commands, not user-facing |
| Pure bash JSON helpers | TypeScript has native JSON |
| `jq`/`osascript` JSON engine | Not needed in TypeScript |
| `check_dependencies()` | itsybitsy uses Bun; checks `ib`/`tmux` at startup |
| `init_paths()` / `get_root_repo()` | itsybitsy uses repo registry |
| `SESSION_PREFIX` / `REPO_ID` | itsybitsy reads `tmux_session` from meta.json directly |
| `auto_accept_workspace_trust()` | Handled by `ib new-agent` |
| `bypass_rate_limit()` | Would be in watchdog if implemented |

---

## 17. Recommended Implementation Order

Ordered by value and dependency, highest value first.

### Tier 1: High Value, Should Implement

1. **Watchdog (built-in)** — Replace per-agent bash watchdog with in-process monitoring in itsybitsy. Track state transitions, notify managers, auto-compact. This is the #1 feature that makes multi-agent work reliable. New file: `src/watchdog.ts`.

2. **Setup Dialog** — Replace `h` help-only overlay with ib watch-style setup dialog. Three tabs: Setup (hooks status/toggle), Project Settings, User Settings. Shells to `ib hooks install/uninstall` for hook management. Reads/writes `.ittybitty.json` for config.

3. **`--manager` flag in `newAgent()`** — When spawning from TUI with an agent selected, pass `--manager {selected.id}` to `ib new-agent`. Critical for proper agent hierarchy.

4. **Fix `nukeAgent()` to use `ib nuke`** — Change from `ib kill --force` to `ib nuke {id} --force` for recursive descendant killing.

5. **Dead-agent question filtering** — Filter out questions from agents no longer in `.ittybitty/agents/`.

### Tier 2: Medium Value

6. **Pause agent (`P` key)** — Add `pauseAgent()` calling `ib pause {id}`. Simple addition.

7. **Send-to-all toggle** — Add `a` toggle in send dialog for "send to all alive agents."

8. **Reassign select list** — Replace free-text reassign dialog with select list of valid managers + "(No parent)" option.

9. **Phase 8 items** (already planned in PLAN.md):
   - Diff colorization (G-04)
   - Pane skip empty (G-03)
   - Error count badge (G-07)
   - Terminal title (G-10)
   - Minimum terminal size (G-11)
   - Agent log colorization (G-05)
   - Orphaned agent indicator (G-06)

### Tier 3: Low Value / Polish

10. **Update notification** — Check for newer itsybitsy version periodically.
11. **Orphan tmux session detection** — Find tmux sessions without matching agent data.
12. **Scroll step size** — Match ib's 10-line steps.
13. **Denial filter intervals** — Change from `all/1h/10m` to `all/24h/7d`.
14. **Tree connector style** — Already implemented in `flattenAgentTree()` with box-drawing.
15. **Scroll direction for top-anchored panes** (G-08)
16. **TREE pane prompt column** (G-09)

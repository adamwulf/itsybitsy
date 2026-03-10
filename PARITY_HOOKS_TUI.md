# Parity Review: Hooks, TUI, and CLI

Comparison of TypeScript itsybitsy (src/) against bash `ib` reference.

---

## 1. Hook Implementations — src/hooks/

### 1.1 agent-path.ts (hook-check-path) vs bash check_pretooluse_access()

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| TaskCreate deny messages | Worker vs manager-specific | Identical messages | **PARITY** |
| Allow list check | Iterates patterns with `tool_matches_pattern` | Iterates with `toolMatchesPattern` | **PARITY** |
| Bash cd extraction | Strips quotes, trims whitespace | Strips quotes, trims | **PARITY** |
| Non-cd Bash commands | Allows without path check | Has extra `checkBashCommandPaths()` that scans full command for restricted paths | **INTENTIONAL IMPROVEMENT** — TS is stricter, catches `cat /path/to/agent/repo/file` |
| `notebook_path` field | Not checked | Checked as additional field | **INTENTIONAL IMPROVEMENT** |
| Relative path resolution | Uses `cwd` from stdin JSON + dirname/pwd | Uses `path.join(cwd, ...)` + `path.resolve` + `realpathSync` | **PARITY** (TS is more robust) |
| Worktree path check | String prefix `==` | `startsWith()` with trailing slash or exact match | **PARITY** |
| Own log access | `$agent_dir/agent.log` | `join(agentDir, "agent.log")` | **PARITY** |
| Other agents block | Different messages for Bash vs non-Bash | Same message differentiation | **PARITY** |
| Root repo block | Blocks if path starts with root repo but not worktree | Same logic | **PARITY** |
| Output format | JSON with `hookSpecificOutput` | Same JSON structure | **PARITY** |
| Denial logging | `log_agent` with `[PreToolUse] Permission denied:` | `logAgent` with `[PreToolUse] Permission denied:` | **PARITY** |

**Summary**: Full parity with intentional improvements (bash command path scanning, notebook_path support).

### 1.2 agent-status.ts (hook-status / Stop hook) vs bash cmd_hooks_agent_status()

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| `detectStateFromMessage()` | Checks last non-empty line for WAITING / I HAVE COMPLETED THE GOAL | Identical logic | **PARITY** |
| Tmux fallback | Falls back to `get_state` (tmux capture + `parse_state`) | Falls back to `captureTmuxOutput` + `parseState` | **PARITY** |
| Debug capture | Saves to `debug-logs/stop-{ts}-{state}.txt`, includes tmux + `last_assistant_message` + parse_state reason | Saves `lastMessage` only, no tmux capture or parse_state reason in debug file | **MISSING** — debug output less verbose |
| Rate limited | Returns state, no nudge (avoids loop) | Returns `{ action: "none" }` | **PARITY** |
| Running with background tasks | Checks `⏵⏵.*·\s\d+\s` pattern, skips nudge | Same regex pattern check | **PARITY** |
| Unknown/running nudge | 5s debounce via `last-nudge` file, schedules delayed recheck via `( sleep 5 && ib hooks agent-status )` | 5s debounce via `last-nudge` file, no delayed recheck | **MISSING** — TS lacks the delayed recheck scheduling |
| Nudge message | `"Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line."` | `"Resume your work, or end with WAITING or I HAVE COMPLETED THE GOAL as your final line."` | **MINOR DIFF** — TS omits quotes around phrases |
| Complete: uncommitted check | Checks `git status --porcelain`, sends commit reminder | Same logic | **PARITY** |
| Complete: worker notify | `ib send "$manager" "[hook]: Your subtask $ID just completed"` | Returns `{ action: "notify_manager", message: "[hook]: Your subtask ... just completed" }` | **PARITY** |
| Complete: unfinished children | Enumerates child agents, sends detailed reminder with commands | Enumerates children (skips archived), sends shorter message without command suggestions | **PARTIAL** — TS message is less detailed |
| Waiting: worker notify | `ib send "$manager" "[hook]: Your subtask $ID is now waiting for input"` | Returns matching `notify_manager` action | **PARITY** |
| Tmux send-keys | Sends message then Enter with 0.1s delay | Sends message + Enter in one `send-keys` call (no delay) | **BEHAVIORAL DIFF** — may be unreliable for long messages |
| Manager notification | Uses `ib send` command | Directly sends tmux keys to manager session | **INTENTIONAL CHANGE** — avoids shell overhead |

**Divergences to address**:
1. Delayed nudge recheck not implemented (could cause stuck agents)
2. Nudge message formatting minor diff (quotes around phrases)
3. Complete + unfinished children message less detailed
4. Debug file content less comprehensive
5. Tmux send-keys without delay between message and Enter

### 1.3 intercept-task.ts vs bash cmd_hooks_intercept_task()

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| Only intercept Task | `exit 0` for non-Task | `{ action: "skip" }` | **PARITY** |
| Worker bypass | Reads `meta.json`, workers skip interception | Same logic | **PARITY** |
| Skip list | `Bash\|statusline-setup\|claude-code-guide\|meta-agent\|ib-merge` | Same 5 entries | **PARITY** |
| Model validation | `sonnet\|opus\|haiku\|""` | `VALID_MODELS = Set(["sonnet", "opus", "haiku", ""])` | **PARITY** |
| Prompt fallback | prompt → description → skip | prompt → description → skip | **PARITY** |
| Spawn method | Writes prompt to temp file, calls `ib new-agent` CLI | Calls native `newAgent()` directly | **INTENTIONAL IMPROVEMENT** |
| Stub strategy | Returns `allow` with `updatedInput` (claude-code-guide stub) | Same strategy | **PARITY** |
| Error handling | mktemp fail, spawn fail, no agent ID — all return stubs | Same error paths via spawn result | **PARITY** |
| Calling agent detection | Regex on cwd for `.ittybitty/agents/<id>/repo` | Same regex | **PARITY** |
| Skip output | `exit 0` (no output) | Outputs `{ permissionDecision: "allow" }` JSON | **BEHAVIORAL DIFF** — bash exits silently, TS always writes JSON |

**Summary**: Near-full parity. Skip behavior differs (TS always outputs allow JSON vs bash exit 0), which is correct for the native hook approach.

### 1.4 session-start.ts vs bash cmd_hooks_session_start()

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| Role detection | cwd regex for `.ittybitty/agents/<id>/repo` | Same regex | **PARITY** |
| Meta.json reading | Reads id, manager, worker fields | Same fields | **PARITY** |
| Parent branch | `agent/$manager` or `main` | Same logic | **PARITY** |
| Null manager handling | `$manager == "null"` treated as empty | `meta.manager !== "null"` treated as empty | **PARITY** |
| Primary instructions | Identical text block | Line-by-line identical | **PARITY** |
| Manager instructions | Includes conditional `ib ask` line/section | Same conditional logic | **PARITY** |
| Worker instructions | Fixed commands table with manager ID | Same structure | **PARITY** |
| Output format | JSON with `hookEventName: "SessionStart"` | Same JSON structure | **PARITY** |

**Summary**: Full parity. Instructions text is character-identical.

### 1.5 inject-status.ts vs bash cmd_hooks_inject_status()

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| Agent cwd skip | Skips if cwd matches agent worktree pattern | Same check via `shouldInjectStatus()` | **PARITY** |
| Config check | `CONFIG_HOOKS_INJECT_STATUS == "false"` | `config["hooks.injectStatus"]?.value === false` | **PARITY** |
| No agents → empty | Exits 0 with no output | Same behavior | **PARITY** |
| Brief summary | Counts by state, joins "N state" parts | Same counting/joining logic | **PARITY** |
| State mapping | Compacting maps to running | `compacting\|unknown` → running | **INTENTIONAL IMPROVEMENT** — TS also maps unknown |
| Pending questions count | Counts from `user-questions.json`, filters dead agents | Not implemented (no question injection in status) | **MISSING** — question counts not shown |
| Full mode format | Lists agents under repo headers | Similar format with repo headers | **PARITY** |
| if-changed hash | SHA-256 via `openssl dgst`, cached in `/tmp/ib-status-hash-{REPO_ID}` | SHA-256 via `Bun.CryptoHasher`, cached in `/tmp/ib-status-hash-{cwd-slug}` | **PARITY** (different hash key scheme) |
| --visible | Adds `systemMessage` if config allows | Same conditional logic | **PARITY** |
| Multi-repo support | Single repo only (uses $AGENTS_DIR) | Multi-repo via registry | **INTENTIONAL IMPROVEMENT** |
| hookEventName | Reads from stdin JSON, defaults to "UserPromptSubmit" | Same behavior | **PARITY** |

**Divergences to address**:
1. Pending question counts not shown in status summary

### 1.6 main-path.ts vs bash cmd_hooks_main_path()

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| Non-Bash tools | `exit 0` (allow) | `{ action: "allow" }` | **PARITY** |
| Non-cd commands | `exit 0` (allow) | `{ action: "allow" }` | **PARITY** |
| Compound command handling | Strips `&&`, `\|\|`, `;`, `\|`, `#` suffixes | Strips via regex `([^&\|;]*?)(\s*&&\|\s*\|\|\|\s*;\s*\|\s*\|)` | **PARTIAL** — TS doesn't strip `#` (comment) suffix |
| Quote removal | Handles both `"path"` and `'path'` | Same logic | **PARITY** |
| Empty cd | Allow | Allow | **PARITY** |
| Path resolution | Uses cwd from JSON, dirname/pwd normalization | Uses `path.join` + `path.resolve` | **PARITY** |
| Agent worktree block | Pattern: `*/.ittybitty/agents/*/repo*` or `*/repo` | Pattern: `\.ittybitty\/agents\/[^/]+\/repo(\/\|$)` | **PARITY** |
| Block message | Stderr: `"Access denied: cannot cd into agent worktrees..."` | JSON deny with reason | **BEHAVIORAL DIFF** — bash uses stderr + exit 2, TS uses JSON + exit 2 |
| Allow output | `exit 0` (no output) | `process.exit(0)` (no output) | **PARITY** |

**Divergences to address**:
1. Missing `#` (comment) stripping from compound commands

---

## 2. CLI Commands — src/index.ts

### 2.1 ib list / ib ls

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| `--manager` filter | Filters by manager field | Implemented (finds manager in tree, shows children) | **PARITY** |
| `--json` output | JSON array of agent objects | Not implemented | **MISSING** |
| Column alignment | Pipe-delimited `column -t` formatting | Manual padding with pi-tui `visibleWidth` | **INTENTIONAL CHANGE** |
| Orphaned session detection | Scans tmux sessions for orphans | Shows `⚠` icon for orphaned agents | **PARITY** |
| Orphaned directory detection | Warns about dirs without meta.json | Handled by `readAllAgents` error reporting | **PARITY** |
| Agent count summary | `"N agents (M max)"` | Not shown | **MISSING** |
| `unknown` → `waiting` display | Maps unknown to waiting for display | Via `displayState()` function | **PARITY** |
| State detection | Uses `get_state` (tmux poll) | Uses `detectAgentStates` | **PARITY** |
| Multi-repo support | Single repo | Multi-repo with headers | **INTENTIONAL IMPROVEMENT** |

### 2.2 ib look

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| `--lines N` | Default 50 | Default 100 | **MINOR DIFF** |
| `--all` | Full scrollback via `-S -` | 10000 lines | **MINOR DIFF** |
| `--follow` | `tmux attach -r` (read-only) | Not implemented | **MISSING** |
| Fallback | `output.log` file | `agent.log` via `readAgentLog` | **BEHAVIORAL DIFF** — different fallback source |

### 2.3 ib questions / ib acknowledge

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| `--all` flag | Shows acknowledged questions | Not implemented | **MISSING** |
| Agent-from-worktree block | `is_running_as_agent` blocks acknowledge | Not checked | **MISSING** |
| Output format | Detailed: status, id, from, time, question | Simple: repo, agent, question, timestamp | **PARTIAL** |
| Question ID in output | Shows question ID | Shows question ID | **PARITY** |

### 2.4 ib diff

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| `--stat` flag | Shows stat-only diff | Not implemented | **MISSING** |
| Merge base | `git merge-base HEAD $BRANCH_NAME` | `git merge-base HEAD main` | **BEHAVIORAL DIFF** — TS always compares to main |

### 2.5 ib status

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| Merge base detection | `git merge-base HEAD $BRANCH_NAME` using current branch | `git log --oneline main..HEAD` | **BEHAVIORAL DIFF** — TS uses fixed `main` ref |
| Header info | Shows agent ID, branch, worktree path | Just shows git log + git status | **MISSING** — less informative |
| Section formatting | `═══ Commits (N) vs $TARGET_BRANCH ═══` with counts | Plain git output | **MISSING** — no structured formatting |
| Files changed summary | `git diff --stat` summary | Not shown | **MISSING** |

### 2.6 ib hooks install/uninstall/status

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| Settings file location | `.claude/settings.local.json` (project-local) | `~/.claude/settings.json` (global) | **CRITICAL DIFF** — bash installs per-project, TS installs globally |
| Hooks checked | main-path, status (inject-status), session-start | Same 3 hooks | **PARITY** |
| Partial detection | "partial" if some but not all installed | Same tri-state logic | **PARITY** |
| Intercept status | Separate `--intercept` flag | Separate `intercept-status` subcommand | **PARITY** |

**Critical**: The settings file location difference means bash hooks are project-scoped while TS hooks are global. This is architecturally significant — installing TS hooks affects all Claude Code sessions, not just the current project.

### 2.7 ib watchdog

| Area | Bash | TypeScript | Status |
|------|------|-----------|--------|
| Architecture | Inline in bash, polls every 5s | Separate `watchdog.ts` module with lock file | **INTENTIONAL IMPROVEMENT** |
| Rate limit handling | `bypass_rate_limit` + usage API check | Not clearly implemented (watchdog.ts not fully reviewed) | **UNKNOWN** |
| Auto-compact | Reads context usage, sends `/compact` | Separate `auto-compact.ts` module | **PARITY** (different architecture) |
| Manager notifications | `ib send` to manager on state changes | Depends on watchdog implementation | **UNKNOWN** |

### 2.8 Missing CLI commands in TS

| Bash Command | Description | Status |
|---|---|---|
| `ib send --from <id>` | Auto-prefixes with sender identity | **MISSING** — TS `send` doesn't support `--from` or auto-detection |
| `ib look --follow` | Live attach to tmux session | **MISSING** |
| `ib list --json` | JSON output for scripting | **MISSING** |
| `ib diff --stat` | Stat-only diff | **MISSING** |
| `ib log` | Write to agent log from CLI | **MISSING** |
| `ib ask` | Agent asks user a question | **MISSING** from CLI (may be available as ib-commands) |
| `ib new-agent --prompt-file` | Read prompt from file | **MISSING** from CLI arg parsing |
| `ib tree` (bash) | Formatted tree with alignment | TS has `agents/tree` command with different formatting | **PARITY** |
| `ib parse-state` | Debug command for state parsing | **MISSING** from CLI |

---

## 3. TUI Watch — src/tui/dashboard.ts

### 3.1 Keybindings Comparison

| Key | Bash | TypeScript | Status |
|-----|------|-----------|--------|
| j/k | Select agent ↓/↑ | Same | **PARITY** |
| Arrow keys ↑↓ | Same as j/k | Same | **PARITY** |
| Arrow keys ←→ | Left=p (next), Right=n (prev) — counterintuitive | Left=n (prev), Right=p (next) | **NOTE**: Both map arrows counterintuitively to match each other |
| p/n | Next/prev right pane | Same | **PARITY** |
| d | Jump to diff pane | Same | **PARITY** |
| g | Jump to status pane (in bash: also "go to agent" in questions) | Jump to status pane | **PARTIAL** — TS lacks "go to agent" function in questions pane |
| e | Jump to errors pane | Same | **PARITY** |
| q | Jump to questions pane | Jump to questions pane | **PARITY** |
| ;/l | Scroll down/up (10 lines) | Same (delegates to agentActions) | **PARITY** |
| s | Send message dialog | Same | **PARITY** |
| m | Merge dialog | Same | **PARITY** |
| x | Kill dialog | Same | **PARITY** |
| ! | Nuke dialog | Same | **PARITY** |
| a | New agent dialog | Same | **PARITY** |
| @ | Fuzzy agent jump | Same | **PARITY** |
| / | Command/panel jump (fuzzy) | Same | **PARITY** |
| h | Setup dialog | Same | **PARITY** |
| S | Capture tmux snapshot | Same | **PARITY** |
| R | Resume agent | Same | **PARITY** |
| r | Reassign agent | Same | **PARITY** |
| t | Toggle time filter (denials) | Not found | **MISSING** |
| w | Open worktree in Finder | Not found | **MISSING** |
| o | Open external diff tool | Not found | **MISSING** |
| c | Clear errors (in errors pane) | Not found | **MISSING** |
| Enter | Open answer dialog (questions) | Not found | **MISSING** |

### 3.2 Right Pane Modes

| Mode | Bash | TypeScript | Status |
|------|------|-----------|--------|
| 0 | Agent log | Same | **PARITY** |
| 1 | Initial prompt | Same | **PARITY** |
| 2 | Denials (with time filter) | Denials | **PARTIAL** — missing time filter toggle |
| 3 | Tree | Same | **PARITY** |
| 4 | Errors | Same | **PARITY** |
| 5 | Diff | Same | **PARITY** |
| 6 | Status | Same | **PARITY** |
| 7 | Questions | Same | **PARITY** |

### 3.3 Dashboard Features

| Feature | Bash | TypeScript | Status |
|---------|------|-----------|--------|
| Usage tracking (session %, weekly %) | Polls `fetch_claude_usage` every 30s | Not visible in dashboard | **MISSING** |
| Feedback dialog | Prompts for feedback after N sessions | Not implemented | **MISSING** (intentional — not needed for new tool) |
| Settings tabs | Setup + Project Settings + User Settings | Setup dialog present | **PARTIAL** — settings editing scope unclear |
| Permissions editor | Full allow/deny list editor | Not visible | **MISSING** |
| Number/string input dialogs | For editing config values | Not visible | **MISSING** |
| Answer question dialog | Text input to respond to agent questions | Not visible | **MISSING** |
| Error notification badge | Shows unread error count | Appears to be implemented | **LIKELY PARITY** |
| Questions badge | Shows unread question count | Appears to be implemented | **LIKELY PARITY** |
| Full-width modes | Denials, diff, questions hide tree | Not verified | **UNKNOWN** |

---

## 4. Critical Issues Summary

### Must-fix (behavioral correctness)

1. **Settings file location** (hooks install/uninstall): Bash writes to `.claude/settings.local.json` (project-local), TS writes to `~/.claude/settings.json` (global). This means TS hooks affect ALL Claude sessions, not just the current project. This is the most impactful difference.

2. **Nudge recheck scheduling**: Bash schedules a delayed `( sleep 5 && ib hooks agent-status )` when debouncing nudges. TS lacks this, meaning debounced agents could get stuck without follow-up.

3. **Stop hook tmux send-keys timing**: Bash sends message then waits 0.1s before Enter. TS sends message+Enter in one call. Long messages may not paste fully before Enter fires.

### Should-fix (feature parity)

4. **Complete + unfinished children message**: TS message is less detailed than bash (missing specific commands like `ib merge`, `ib kill`, `ib list`, `ib look`, `ib status`, `ib diff`).

5. **main-path comment stripping**: Bash strips `#` comments from compound cd commands. TS regex doesn't handle this.

6. **inject-status question counts**: Bash includes pending question count in brief summary. TS doesn't.

7. **Missing TUI keybindings**: `t` (time filter), `w` (open worktree), `o` (external diff), `c` (clear errors), Enter (answer question in questions pane).

8. **ib look --follow**: Missing live tmux attach mode.

9. **ib send --from**: Missing sender identification for agent-to-agent messages.

### Nice-to-have (non-critical)

10. **ib list --json**: Missing JSON output mode.
11. **ib status formatting**: Less structured than bash (no headers, no file change summary).
12. **Debug file content**: Less comprehensive in stop hook (missing tmux capture and parse_state reason).
13. **ib look default lines**: 100 vs bash 50 (minor).
14. **ib questions --all**: Missing flag for showing acknowledged questions.

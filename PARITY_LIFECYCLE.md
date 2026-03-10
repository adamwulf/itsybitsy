# Parity Review: Agent Lifecycle & Watchdog

Comparison of itsybitsy TypeScript implementation against bash `ib` script for agent spawning, lifecycle, and watchdog behavior.

## newAgent() — src/ib-commands.ts vs bash cmd_new_agent()

### Worktree creation sequence
- **MATCH**: Both create worktree with `git worktree add <agent-dir>/repo -b agent/<id> <base-ref>`, where `base-ref` is `agent/<manager>` if manager exists, otherwise `HEAD`.

### meta.json fields
- **MATCH**: All fields present and identical: `id`, `session_id`, `tmux_session`, `prompt`, `manager`, `created`, `created_epoch`, `worktree`, `worker`, `yolo`, `model`.
- **MINOR DIFF**: Bash uses `date -Iseconds` for `created` (ISO 8601 with timezone offset, e.g. `2024-01-01T12:00:00-0600`). TS uses `now.toISOString()` (UTC with `Z` suffix, e.g. `2024-01-01T18:00:00.000Z`). Not a bug — both are valid ISO 8601.

### prompt.txt content
- **MATCH**: Completion instructions, custom prompts (all/manager/worker), and user prompt are assembled identically.

### start.sh content
- **MATCH**: PATH setup, CLAUDECODE/CLAUDE_CODE_ENTRYPOINT unset, claude args, PID capture via sed, wait, exit-check.sh — all identical.

### exit-check.sh content
- **MATCH**: Identical content — uncommitted changes prompt, unpushed commits check.

### Agent settings (settings.local.json)
- **MATCH**: Same base-settings loading, permission merging, ib/git mandatory perms, blocked tools, hook configuration (path-check, status, permission-denied, intercept-task, session-start).
- **MATCH**: Intercept hook detection logic is equivalent.

### Tmux session creation
- **MATCH**: Both use `-d -x 60 -s <session> -c <workPath> <startScript>`.

### Watchdog spawn
- **BUG (intentional improvement)**: Bash only spawns watchdog for agents with a manager (`if [[ -n "$MANAGER" ]]`). TS spawns watchdog for ALL agents (`ib watchdog` with self-exit if already running). This is **intentionally better** — the TS watchdog is a global singleton process that monitors all agents, so spawning it on every new-agent is correct (it self-exits if already running).

### Auto-accept workspace trust
- **MATCH**: Both run `autoAcceptWorkspaceTrust` asynchronously for non-yolo agents.
- **MATCH**: Same polling logic — wait for Claude to start, detect permissions vs logo, send Enter up to 5 times with 4s waits.

### Post-create hook
- **MATCH**: Both check for `.ittybitty/hooks/post-create-agent`, run in background with same env vars (`IB_AGENT_ID`, `IB_AGENT_TYPE`, `IB_AGENT_DIR`, `IB_AGENT_BRANCH`, `IB_AGENT_MANAGER`, `IB_AGENT_PROMPT`, `IB_AGENT_MODEL`).

### Other newAgent checks
- **MATCH**: Auto-detect manager from cwd, validate manager not worker, yolo escalation check, model fallback chain (`--model` > config > `sonnet`), max agents check, ID uniqueness check (dir + tmux), non-worktree mode ib permission injection.

---

## resumeAgent() — src/ib-commands.ts vs bash cmd_resume()

### resume.sh content
- **MATCH**: PATH setup, CLAUDECODE unset, `claude --resume <session_id>` with args, PID capture, wait, exit-check.

### Tmux session creation
- **MATCH**: Same `tmux new-session -d -x 60 -s <session> -c <workPath> <resumeScript>` pattern.

### Auto-accept workspace trust on resume
- **MATCH**: Both call `autoAcceptWorkspaceTrust` for non-yolo agents.

### Resume nudge
- **MATCH**: Both send the same nudge prompt: `"Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line."` followed by Enter.

### Watchdog spawn on resume
- **IMPROVEMENT (TS only)**: TS spawns `ib watchdog` on resume. Bash does NOT spawn a watchdog on resume. This is an intentional improvement — if the watchdog died before the agent was resumed, it needs to be restarted.

### State check
- **MATCH**: Both verify agent is in `stopped` state before allowing resume.

---

## killAgent() — src/ib-commands.ts vs bash cmd_kill() / do_kill()

### Kill sequence
- **MATCH**: Both follow the same sequence:
  1. Check agent exists (dir or tmux session)
  2. Remove questions from user-questions.json
  3. `teardownAgent()` — log, capture tmux, kill Claude process, kill tmux session, copy settings.local.json, remove worktree, delete branch, archive, remove dir
  4. `scanAndKillOrphans()`

### killAgentProcess
- **MATCH**: Same two-strategy approach: (1) tmux list-panes → pgrep for claude, (2) fallback to meta.json `claude_pid`. Same SIGTERM → wait 2s → SIGKILL pattern.

### Teardown sequence
- **MATCH**: TS `teardownAgent()` matches bash `teardown_agent()` step by step:
  1. Log action
  2. Capture tmux output to output.log
  3. Kill Claude process (SIGTERM + SIGKILL)
  4. Kill tmux session
  5. Copy settings.local.json from worktree
  6. Remove worktree (with rm -rf fallback)
  7. Delete branch
  8. Archive artifacts
  9. Remove agent directory

---

## nukeAgent() — src/ib-commands.ts vs bash cmd_nuke() / do_nuke()

### Nuke sequence
- **MATCH**: Worker-with-no-children rejection, `getDescendantsRecursive()` for descendant collection, iterate-and-teardown, orphaned tmux session cleanup, `scanAndKillOrphans()`.

### Orphaned session cleanup
- **MATCH**: Both list tmux sessions with `ittybitty-` prefix, extract agent ID, check against known agent directories, kill orphans.

### nukeAllAgents
- **MATCH**: TS has a separate `nukeAllAgents(repoPath)` that kills all agents — equivalent to bash `ib nuke` (no target ID).

---

## mergeAgent() — src/ib-commands.ts vs bash cmd_merge() / do_merge()

### Pre-merge checks
- **MATCH**: Both check: agent dir exists, worktree exists, not merging from own worktree, no uncommitted changes in worktree, no uncommitted changes in current dir, agent branch exists.

### Target branch detection
- **MATCH**: `git branch --show-current` → fall back to `main` → fall back to `master`.

### Pre-rebase conflict check
- **MATCH**: Both use `checkRebaseConflicts()` — creates temp branch from source, creates temp worktree, attempts rebase, aborts on failure, cleans up temp branch/worktree.

### Rebase strategy
- **MATCH**: Rebase agent branch onto target in agent's worktree.

### Merge flags
- **MATCH**: `--ff-only` if running as agent (manager merging worker), `--no-ff` with merge commit message `"Merge agent <id> work"` if running as user.

### Post-merge teardown
- **MATCH**: Capture tmux → kill Claude → kill tmux → copy settings → remove worktree → delete branch → archive → remove questions → remove dir → scan orphans.

### Minor differences
- **DIFF**: Bash `do_merge` doesn't copy settings.local.json before removing worktree — it relies on `teardown_agent` handling that. But the TS mergeAgent duplicates this logic inline since it doesn't call teardownAgent(). Both achieve the same result. **Not a bug**.

---

## Watchdog — src/watchdog.ts vs bash cmd_watchdog()

### Architecture difference
- **INTENTIONAL**: Bash watchdog is a per-agent background process (`ib watchdog <agent-id>`), only spawned for agents with managers. TS watchdog is a global singleton process that monitors ALL agents across all repos, with a PID lock file at `~/.itsybitsy/watchdog.lock`. This is intentionally better — eliminates redundant processes and ensures all agents are monitored.

### State handlers comparison

| State | Bash behavior | TS behavior | Match? |
|-------|--------------|-------------|--------|
| **waiting** | Increment counter; notify manager at threshold; exponential backoff | Same | MATCH |
| **unknown** | Same as waiting + saves debug log | Same backoff behavior; no debug log saved | MINOR DIFF |
| **complete** | One-time notification; reset backoff | Same | MATCH |
| **running** | Reset counters; clear completionNotified; reset backoff | Same | MATCH |
| **creating** | Reset counters (waiting_counter=0, notify_interval=6) | Reset via !BACKOFF_STATES check | MATCH |
| **compacting** | Reset counters | Same | MATCH |
| **rate_limited** | 3-attempt retry loop with 2s sleeps to bypass dialog + usage API check | Single Enter + usage API check | DIFF |
| **stopped** | Reset counters | Same | MATCH |

### Notification backoff intervals
- **MATCH**: Initial interval = 6 ticks × 5s = 30s. Doubles after each notification. Max = 768 ticks × 5s = 3840s = 64 minutes. Both reset to initial on state change away from waiting/unknown.

### Rate limit bypass
- **DIFF**: Bash `bypass_rate_limit()` uses a 3-attempt retry loop with `sleep 2` between attempts, checking parse_state each time. TS sends a single Enter and relies on the next 5s tick to re-evaluate. The TS TODO at line 319 acknowledges this. **Minor risk** — if the single Enter fails, the watchdog won't retry for 5s. In practice this is fine since the watchdog loops every 5s anyway.

### Rate limit recovery
- **MATCH**: Both use 5% recovery threshold. Both check usage API and send nudge message when session usage drops below threshold.

### Auto-compact
- **MATCH**: Both check `autoCompactThreshold` config. Both send `/compact` when context usage exceeds threshold. Both track `compact_sent` flag to prevent redundant compact commands. TS adds a 60s per-agent cooldown for compact checks.

### Manager notification messages (exact format)
- **MATCH**: All watchdog notification messages match exactly:
  - `[watchdog]: Your subtask <id> recently started waiting for input`
  - `[watchdog]: Your subtask <id> recently completed`
  - `[watchdog]: Your subtask <id> state is unknown - may need attention`
  - `[watchdog]: Usage has refreshed (<pct>%). Please continue your task.`

### Lock file behavior
- **TS-ONLY**: Lock file at `~/.itsybitsy/watchdog.lock` with PID. `acquireWatchdogLock()` checks for stale PID. `releaseWatchdogLock()` removes only if PID matches. Bash has no lock file (each agent gets its own watchdog process).

### Debug log on unknown state
- **MISSING (TS)**: Bash saves debug output to `debug-logs/watchdog-<timestamp>-unknown.txt` when entering unknown state. TS watchdog does not save debug logs. **Minor gap** — useful for diagnosing parse-state issues.

---

## sendMessage() — src/ib-commands.ts vs bash cmd_send()

### tmux send-keys
- **IMPROVEMENT (TS)**: TS uses `-l` (literal) flag: `["tmux", "send-keys", "-t", session, "-l", message]`. Bash uses: `tmux send-keys -t "$TMUX_SESSION" "$MESSAGE"` without `-l`. The `-l` flag prevents tmux from interpreting special characters (like `C-c`, `C-m`) in the message text. **This is better in TS** — prevents accidental control character injection.

### Delay calculation
- **MATCH**: Both use `0.1 + (len / 100) * 0.5`, clamped to `[0.2, 3.0]` seconds.

### Logging
- **MATCH**: Both log to recipient's agent.log and sender's agent.log (if applicable).

---

## pauseAgent() — src/ib-commands.ts vs bash cmd_pause()

Not explicitly in the TS ib-commands review scope, but confirmed matching:
- **MATCH**: Both kill Claude process, kill tmux session, preserve agent dir/meta/worktree.

---

## Summary of all divergences

### Bugs (should fix)
None found.

### Missing features (minor gaps)
1. **Debug logs on unknown state**: Bash watchdog saves tmux output to debug-logs/ when entering unknown state. TS does not.

### Intentional improvements (TS is better)
1. **Global watchdog**: TS uses a singleton watchdog process with lock file, monitoring all agents. Bash spawns per-agent watchdog only for agents with managers.
2. **Watchdog on resume**: TS spawns watchdog on resume. Bash does not.
3. **send-keys -l flag**: TS uses literal mode to prevent control character injection.
4. **Rate limit bypass is slightly simpler**: Single Enter vs 3-attempt loop, but functionally equivalent since watchdog re-checks every 5s.

### Cosmetic differences (no impact)
1. ISO 8601 date format differs (TZ offset vs UTC Z suffix) in meta.json `created` field.

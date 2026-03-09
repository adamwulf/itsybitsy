# Codebase Review 3 — Post-Phase 15 Quality Gate

**Date**: 2026-03-09
**Reviewer**: Code review agent
**Scope**: Full codebase review focusing on Phase 15 (watchdog, auto-compact), Phase 14 (agent-lifecycle, ib-commands), core modules, and TUI.

---

## Overall Grades

| Area | Grade | Notes |
|------|-------|-------|
| **Phase 15 (watchdog, auto-compact)** | A- | Clean design, good test coverage, minor issues |
| **Phase 14 (agent-lifecycle, ib-commands)** | B+ | Solid but complex; some duplicated patterns |
| **Core (agents, watcher, parse-state)** | A | Well-structured, good separation of concerns |
| **TUI (dashboard, pane-manager, agent-actions)** | B+ | Feature-rich but dense; some error handling gaps |
| **Supporting (ghostty, usage, config, tmux-poller)** | A- | Clean and focused |
| **Test coverage** | A- | 226+ tests, good coverage of critical paths |
| **Type safety** | B+ | Only 1 `as any` in production code |

---

## High Priority

### H1. `logAgent` has a read-then-write race condition
**File**: `src/agent-lifecycle.ts:59-72`
**Description**: `logAgent()` reads the entire file, appends, then writes. Two concurrent `logAgent()` calls for the same agent can race — the second call may read stale content and overwrite the first call's append. This is called concurrently during `teardownAgent()` (called for each descendant in nuke) and by the watchdog.
**Fix**: Use `Bun.write()` with `{ mode: "a" }` for atomic appends, or use a file descriptor with `appendFile()`.

### H2. Unhandled promise rejection in watchdog `setInterval` callback
**File**: `src/watchdog.ts:391-396`
**Description**: The `setInterval` callback is `async`, but no `.catch()` wraps it. If `tick()` throws an unhandled error (e.g., `sendMessage` throws), the promise rejection is unhandled and could crash the process in strict mode. The same pattern exists in `watcher.ts:88-90` and `93-95` but those at least have try/catch inside `refresh()` and `pollStates()`.
**Fix**: Wrap the callback body in try/catch, or add `.catch()` to the tick promise.

### H3. `contextSizeForModel` doesn't handle Claude 4.6 / Opus 4.6
**File**: `src/auto-compact.ts:44-49`
**Description**: The function only checks for "4-5" or "4.5" in the model string. Claude 4.6 models (e.g., "claude-opus-4-6", "claude-sonnet-4-6") have a different context window size than 200K. Currently they'd default to 200K, which may be wrong — if they have 1M context, auto-compact thresholds would trigger 5x too early.
**Fix**: Update to also check for "4-6" or "4.6" patterns, or make the mapping more explicit.

---

## Medium Priority

### M1. Duplicated spawn runner injection pattern (6 separate runners in ib-commands.ts)
**File**: `src/ib-commands.ts` (lines 71, 132, 574, 854, 986)
**Description**: `ib-commands.ts` has 6 separate pluggable spawn runners: `currentRunner`, `killPauseSpawnRunner`, `nukeResumeSpawnRunner`, `mergeSpawnRunner`, `sendSpawnRunner`, `newAgentSpawnRunner`. Each has its own `set*`/`reset*` functions. This creates a maintenance burden (12 setter/resetter exports) and makes tests verbose. Combined with the spawn runner in `agent-lifecycle.ts`, `watchdog.ts`, `auto-compact.ts`, and `tmux-poller.ts`, there are 10 separate spawn runner injection points across the codebase.
**Fix**: Consider a single injectable spawn factory or context object pattern. At minimum, consolidate the ib-commands runners since most use the same interface.

### M2. `sendMessage` sends raw user text via `tmux send-keys` — special characters may be interpreted
**File**: `src/ib-commands.ts:930-934`
**Description**: `tmux send-keys` interprets special key names (e.g., "Enter", "Escape", "C-c"). If a user message happens to contain the literal word "Enter" at the boundary of a tmux key-name parse, it could be misinterpreted. The bash `ib` script uses `tmux send-keys -l` (literal mode) for message content.
**Fix**: Add `-l` flag to the send-keys call for the message body (not the follow-up Enter).

### M3. `pollStates` calls `buildAgentTree` which mutates `agent.children` in place
**File**: `src/watcher.ts:127-148`
**Description**: `pollStates()` operates on `this._lastAgents` and calls `buildAgentTree()`, which mutates `agent.children` in place. If a `refresh()` races with `pollStates()`, the same agents array could have its children mutated mid-render. The guard `if (agents !== this._lastAgents) return` at line 134 helps but only catches the swap, not concurrent mutation.
**Fix**: Either clone the agents array before tree-building in `pollStates`, or make `buildAgentTree` return new agent objects instead of mutating.

### M4. `handleFailure` in usage.ts calculates `retryTimestamp` with confusing arithmetic
**File**: `src/usage.ts:199-200`
**Description**: `const retryTimestamp = Math.floor((now + backoffMs - CACHE_TTL_MS) / 1000)` — this calculates a timestamp that, when checked against `CACHE_TTL_MS`, will cause the cache to appear stale after `backoffMs` milliseconds. The logic is correct but non-obvious and has no comment explaining why `CACHE_TTL_MS` is subtracted.
**Fix**: Add a comment explaining: "Set timestamp such that cache expires after backoffMs: (now + backoffMs - TTL) ensures the TTL check `now - timestamp*1000 < TTL` fails after backoffMs".

### M5. `checkAndCompact` only checks `running` and `waiting` states, but comment says "safely receive input"
**File**: `src/auto-compact.ts:187`
**Description**: The check `agent.state === "running" || agent.state === "waiting"` is correct for safety, but the `complete` state is also a valid Claude CLI input state (the agent is at a prompt). If an agent is `complete` and has high context usage, it should arguably also receive `/compact`. However, this matches `ib` bash behavior, so it's intentional — just worth documenting.
**Fix**: Add a comment noting that `complete` state is intentionally excluded (agent may be done).

### M6. `as any` cast in production code
**File**: `src/ib-commands.ts:1129`
**Description**: `const preToolUse = (baseSettings as any)?.hooks?.PreToolUse;` — this bypasses type safety. The `baseSettings` is typed as `Record<string, unknown>`, so proper nested access is needed.
**Fix**: Type the access chain properly: `const hooks = baseSettings.hooks as Record<string, unknown> | undefined; const preToolUse = hooks?.PreToolUse;`

---

## Low Priority

### L1. `backoffMs` in `handleFailure` starts at 60s, not from `CACHE_TTL_MS`
**File**: `src/usage.ts:197`
**Description**: `Math.min(cache.nextBackoffMs ?? 60_000, MAX_BACKOFF_MS)` — the initial backoff is 60s (same as `CACHE_TTL_MS`). This means on first failure, the retry is essentially at the same interval as normal cache refresh. The `nextBackoffMs` then grows by 60s each failure (`backoffMs + 60_000`), which is linear not exponential. This is likely intentional but differs from the exponential backoff used elsewhere (watchdog).
**Fix**: Document the linear backoff choice, or switch to exponential if preferred.

### L2. `cleanupOrphanedTmuxSessions` session name parsing assumes specific format
**File**: `src/ib-commands.ts:185-189`
**Description**: The session format parsing `parts.slice(2).join("-")` assumes the repo ID is always a single part (no hyphens). If the repo ID ever contains hyphens, the agent ID extraction would be wrong. Current repo IDs are 8 hex chars (no hyphens), so this works — but it's fragile.
**Fix**: Add a comment documenting the assumption, or use a more robust parsing approach.

### L3. `parseState` returns "waiting" for `⎿ Waiting` (tool execution wait)
**File**: `src/parse-state.ts:107-109`
**Description**: The `⎿ Waiting` pattern means a tool is currently executing, which the comment correctly notes. However, the returned state is `"waiting"`, which is the same as the `WAITING` signal (agent explicitly waiting for input). The watchdog treats both the same — it will start notifying the manager that the agent needs attention even though the agent is just waiting for a tool to complete.
**Fix**: Consider distinguishing tool-waiting from idle-waiting, or adjust the watchdog to be aware of tool-waiting (shorter/no notification for tool-wait).

### L4. `wrapLines` import used inconsistently for right pane rendering
**File**: `src/tui/pane-manager.ts:257-275`
**Description**: Some modes wrap lines (`QUESTIONS`, `AGENT LOG`, `INITIAL PROMPT`, `ERRORS`), while others truncate. This is intentional for modes like DIFF and TREE, but DENIALS mode is listed in `FULL_WIDTH_MODES` but isn't wrapped. Long denial lines may be truncated.
**Fix**: Consider wrapping DENIALS mode content too, or document the truncation as intentional.

### L5. `resumeAgent` constructs a bash script with string interpolation
**File**: `src/ib-commands.ts:417-440`
**Description**: The resume script template uses string interpolation for `gitRoot`, `sessionId`, `claudeArgs`, `agentDir`, `absExitScript`. While these values come from trusted sources (meta.json, git), a malformed meta.json could inject shell commands. The `sessionId` is a UUID (safe), `gitRoot` and `agentDir` are fs paths (generally safe), but `claudeArgs` includes `model` from meta.json which could be attacker-controlled.
**Fix**: Validate the `model` string against an allowlist of known model names before interpolating into the script.

### L6. `ghostty.ts` passes tmux session name as a positional parameter but still uses string interpolation
**File**: `src/ghostty.ts:51`
**Description**: The session name is validated with `/^[\w-]+$/` (good), but the `--command` flag value embeds it via template literal: `` `--command=bash -c '...' -- ${tmuxSession}` ``. While the regex validation makes this safe, using `Bun.spawn` with proper argument separation would be cleaner.
**Fix**: Minor — the regex validation is sufficient. Could note in a comment that the regex ensures safety.

---

## Test Coverage Assessment

| Module | Test File | Coverage |
|--------|-----------|----------|
| watchdog.ts | watchdog.test.ts | Excellent — all states, backoff, lifecycle |
| auto-compact.ts | auto-compact.test.ts | Excellent — all states, edge cases |
| agent-lifecycle.ts | agent-lifecycle.test.ts | Good |
| ib-commands.ts | ib-commands.test.ts | Good — native kill, nuke, resume, send, merge, newAgent |
| agents.ts | agents.test.ts | Good |
| watcher.ts | watcher.test.ts | Good |
| parse-state.ts | parse-state.test.ts | Excellent |
| usage.ts | usage.test.ts | Good — caching, backoff, auth |
| config.ts | config.test.ts | Good |
| ghostty.ts | ghostty.test.ts | Good |
| dashboard.ts | dashboard.test.ts | Good |
| tmux-poller.ts | tmux-poller.test.ts | Good |
| **Missing**: pane-manager.ts | (none) | Not directly tested — covered via dashboard.test.ts |
| **Missing**: agent-actions.ts | (none) | Not directly tested — action handlers are complex |

**Gap**: `agent-actions.ts` is the largest file without its own test file. Individual action handlers (handleKill, handleNuke, handleMerge, etc.) are tested indirectly through dashboard.test.ts keyboard handling, but direct unit tests would catch edge cases more reliably.

---

## Architecture Notes

**Strengths**:
- Clean module separation (parse-state is pure, agents reads data, watcher orchestrates)
- Consistent test injection patterns (spawn runners, fetch mocks)
- Watchdog design with pluggable state handlers is extensible
- Good race condition guards in TmuxPoller and AgentWatcher

**Areas to watch**:
- The 10+ spawn runner injection points add boilerplate; consider a DI container or factory
- `ib-commands.ts` at ~1500 lines is the largest file; the newAgent function alone is ~250 lines
- Mutable shared state in `watchdog.ts` (module-level `trackers` Map, `watchdogTimer`) is well-managed but could cause issues in test isolation if tests don't properly clean up

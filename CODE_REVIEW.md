# Code Review: itsybitsy codebase

**Date:** 2026-03-10
**Scope:** `src/` directory — comprehensive code quality and architecture review
**Files reviewed:** All 62 source and test files across `src/`, `src/hooks/`, `src/tui/`

---

## High Severity

### H1. Duplicate `case "merge-check"` in CLI switch — dead code
**File:** `src/index.ts:433` and `src/index.ts:451`

The `merge-check` case appears twice in the main switch statement. The second occurrence (line 451-457) is unreachable dead code — JavaScript switch statements execute the first matching case. This suggests a copy-paste error and could mask bugs if only the second block was intended to be the final implementation.

### H2. Shell injection via string interpolation in `resumeAgent` and `newAgent`
**File:** `src/ib-commands.ts:379-401` (resume.sh template), `src/ib-commands.ts:1597-1646` (start.sh/exit-check.sh templates)

The `resumeAgent` function writes bash scripts using string interpolation:
```ts
claude --resume "${sessionId}" ${claudeArgs} &
```
While `sessionId` and `model` are validated with `isValidSessionId` and `isValidModel`, the `claudeArgs` string is assembled by concatenation and interpolated directly. If any component bypasses validation, this creates a shell injection vector. The `agentDir` path is also interpolated into the `sed` command on line 392-395 without explicit validation — though it's constructed from controlled paths, a path with special characters could break the sed.

Additionally, in `newAgent` (line 1617-1646), `exit-check.sh` uses `$commit_msg` directly in a `git commit -m` which is safe since it's user-interactive, but the pattern of writing bash scripts with interpolated values is fragile.

**Recommendation:** Use array-based `Bun.spawn` for all subprocess execution rather than shell scripts where possible, or use `printf %q` to shell-escape all interpolated values.

### H3. `as any` in production code bypasses type safety
**File:** `src/ib-commands.ts:1255`

```ts
const preToolUse = (baseSettings as any)?.hooks?.PreToolUse;
```

This `as any` in `buildAgentSettings` bypasses TypeScript's type checker for reading settings. If the structure changes, this will silently produce incorrect behavior rather than a compile-time error.

**Recommendation:** Define a proper interface for the settings file structure and use it instead of `as any`.

### H4. Race condition in watchdog lock file acquisition
**File:** `src/watchdog.ts:392-411`

The `acquireWatchdogLock()` function has a TOCTOU (time-of-check-time-of-use) race condition:
1. Read lock file and check PID
2. Write our PID

Between steps 1 and 2, another process could also read the file and decide the lock is stale, leading to two watchdogs running simultaneously. The use of synchronous `readFileSync`/`writeFileSync` from `require("fs")` (instead of Bun APIs) is inconsistent with the rest of the codebase and doesn't help with atomicity.

**Recommendation:** Use `O_EXCL` flag for atomic creation, or use a PID file with advisory file locking.

---

## Medium Severity

### M1. Proliferation of spawn runner injection patterns
**Files:** `src/ib-commands.ts` (6 separate spawn runners), `src/agent-lifecycle.ts:12`, `src/watchdog.ts:77`, `src/tmux-poller.ts:11`, `src/usage.ts:27`, `src/auto-compact.ts:139`

There are **10+ separate module-level mutable spawn runner variables**, each with its own `set*/reset*` pair:
- `killPauseSpawnRunner` (ib-commands.ts:36)
- `nukeResumeSpawnRunner` (ib-commands.ts:97)
- `mergeSpawnRunner` (ib-commands.ts:700)
- `sendSpawnRunner` (ib-commands.ts:980)
- `newAgentSpawnRunner` (ib-commands.ts:1112)
- `diffStatusSpawnRunner` (ib-commands.ts:1878)
- `spawnRunner` in agent-lifecycle.ts, watchdog.ts, tmux-poller.ts
- `spawnFn` in usage.ts, `compactSpawnRunner` in auto-compact.ts

This is a significant code smell. Each has nearly identical boilerplate (declare mutable `let`, export `set*`/`reset*`). It's error-prone: a test that forgets to call `resetXSpawnRunner` will leak into other tests via module-level state.

**Recommendation:** Consolidate into a single dependency injection pattern — either a context object passed through functions, or a single module-scoped injectable spawn function.

### M2. `AGENT_CWD_PATTERN` regex duplicated across 3 hook files
**Files:** `src/hooks/intercept-task.ts:25`, `src/hooks/inject-status.ts:37`, `src/hooks/session-start.ts:18`

The regex `/\.ittybitsy\/agents\/([^/]+)\/repo(\/|$)/` is defined identically in three separate files. The variant without the capture group in `inject-status.ts` is functionally different, but the concept is the same.

**Recommendation:** Extract to a shared constant in a common module (e.g., `src/constants.ts` or `src/hooks/shared.ts`).

### M3. `AgentProvider` type defined in two different places with different signatures
**Files:** `src/watchdog.ts:30`, `src/hooks/inject-status.ts:120-124`

Two completely different `AgentProvider` types exist:
- Watchdog: `() => Agent[] | Promise<Agent[]>` (single function)
- inject-status: `{ getRepos(), getAgents(), detectStates() }` (object with three methods)

Same name, different shapes. This creates confusion when navigating the codebase.

**Recommendation:** Rename one to avoid ambiguity (e.g., `AgentDataSource` for inject-status).

### M4. 128 empty catch blocks across 23 source files
**Files:** Multiple — `src/ib-commands.ts` (40), `src/agent-lifecycle.ts` (28), `src/hooks/agent-status.ts` (10), etc.

While many of these are legitimate (ENOENT for optional files), the sheer volume (128 total) makes it hard to distinguish intentional error suppression from bugs. Some are annotated with `/* ignore */` comments, but many are bare `catch { }`.

Notable examples that may hide bugs:
- `src/ib-commands.ts:74` — tmux `has-session` errors silently ignored
- `src/ib-commands.ts:198` — meta.json read failure during nuke silently continues
- `src/ib-commands.ts:451` — watchdog spawn errors silently ignored

**Recommendation:** At minimum, add categorized comments (e.g., `/* expected: file may not exist */` vs `/* todo: should log this */`). Consider logging unexpected errors to stderr or agent.log.

### M5. No test coverage for `src/index.ts` (CLI entrypoint)
**File:** `src/index.ts` (708 lines)

The main CLI entrypoint has no dedicated test file. It contains significant logic: argument parsing, the `list` command formatting, the `tree` command formatting, the `new-agent` flag parsing, and the duplicate `merge-check` case (see H1). The `collect()` and `findManager()` functions defined inside the `list` case are untestable because they're inline closures.

**Recommendation:** Extract CLI logic into testable functions. Add integration tests for common CLI invocations.

### M6. No test coverage for `src/tui/agent-actions.ts`, `src/tui/pane-manager.ts`, `src/tui/dialog-handler.ts`
**Files:** `src/tui/agent-actions.ts`, `src/tui/pane-manager.ts`, `src/tui/dialog-handler.ts`

These TUI modules have no corresponding test files. They contain complex logic (agent actions with error handling, pane mode cycling, dialog state machines) that would benefit from unit testing. The dashboard test file (`dashboard.test.ts`) may cover some of this indirectly, but dedicated tests would improve confidence.

### M7. `readAgentMeta` casts unvalidated JSON to `AgentMeta`
**File:** `src/agents.ts:84`

```ts
return { meta: data as AgentMeta };
```

After checking only that `data.id` is a string and `tmux_session` is a string, the entire JSON blob is cast to `AgentMeta`. Missing or wrong-typed fields (e.g., `created_epoch` not being a number, `worker` not being a boolean) will propagate as incorrect types throughout the system without any runtime error.

**Recommendation:** Validate all required fields or use a schema validation library (e.g., Zod).

### M8. `resumeAgent` writes shell scripts with `sed` to modify JSON
**File:** `src/ib-commands.ts:392-395`

```bash
sed -i '' "s/}$/,\\n  \\"claude_pid\\": \\"$CLAUDE_PID\\"\\n}/" "${agentDir}/meta.json"
```

Using `sed` to modify JSON is brittle — it assumes the closing `}` is the last character on the last line, which is fragile if the JSON formatting changes. This could corrupt meta.json if the structure is different from expected.

**Recommendation:** Use a proper JSON modification approach (read, parse, modify, write) either in the bash script (with a small node/bun one-liner) or restructure so the PID is written separately.

---

## Low Severity

### L1. `require("fs")` used in watchdog lock file management instead of Bun APIs
**File:** `src/watchdog.ts:393,418,432`

The lock file functions use `require("fs")` with synchronous Node.js APIs (`readFileSync`, `writeFileSync`, `unlinkSync`), while the rest of the codebase uses `Bun.file()`, `Bun.write()`, or `fs/promises`. This inconsistency is jarring and unnecessary.

**Recommendation:** Use `Bun.file().text()` and `Bun.write()`, or at least import from `node:fs` instead of using `require`.

### L2. `nukeResumeRunCmd` doesn't drain stderr — potential buffer deadlock
**File:** `src/ib-commands.ts:116-121`

```ts
async function nukeResumeRunCmd(cmd: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = nukeResumeSpawnRunner(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}
```

Stderr is piped but never drained. If a command produces enough stderr output to fill the pipe buffer, the process will deadlock. Compare with `mergeRunCmd` (line 716-724) which correctly drains both streams with `Promise.all`.

Similarly, `newAgentRunCmd` (line 1131-1137) drains stderr but sequentially rather than in parallel — still safe but less efficient.

**Recommendation:** Drain both stdout and stderr with `Promise.all` consistently across all `runCmd` helpers, matching the pattern in `mergeRunCmd`.

### L3. `config.ts` doesn't validate types — `readConfig` trusts file content
**File:** `src/config.ts:88-106`

Values read from `.ittybitsy.json` are stored directly without type checking against the `ConfigKeyDef.type` field. A config file with `"maxAgents": "ten"` would be accepted and propagated as a string where a number is expected.

**Recommendation:** Add runtime type validation matching each `ConfigKeyDef.type`.

### L4. `contextSizeForModel` hardcodes model version patterns
**File:** `src/auto-compact.ts:44-52`

```ts
if (model.includes("4-5") || model.includes("4.5")) return 1_000_000;
if (model.includes("4-6") || model.includes("4.6")) return 200_000;
return 200_000;
```

This hardcodes model context sizes by matching version substrings. New models will silently get the 200K default. The comment says "Sonnet 4.5 / Opus 4.5 have 1M context" but Claude 4.6 Opus also has potentially different sizes. These magic numbers should ideally come from configuration.

### L5. `readPendingQuestions` catches all non-ENOENT errors but still returns empty
**File:** `src/agents.ts:179-185`

Non-ENOENT errors (e.g., permission denied, JSON parse errors) log a warning to stderr but return an empty array, making failures invisible to callers.

### L6. `computeAge` uses integer arithmetic that loses precision
**File:** `src/agents.ts:55-62`

Ages snap to coarse buckets (seconds → minutes → hours → days) with no fractional display. An agent that's been running 59 minutes and 59 seconds shows "59m" instead of "~1h". Minor UX issue.

### L7. `handleFailure` in usage.ts writes a manipulated timestamp to cache
**File:** `src/usage.ts:199-209`

The retry timestamp calculation `Math.floor((now + backoffMs - CACHE_TTL_MS) / 1000)` is non-obvious — it sets the cache timestamp to a future time minus TTL, so the TTL check `now - timestamp * 1000 < CACHE_TTL_MS` won't expire until `backoffMs` has elapsed. While correct, this is confusing and should be documented with a comment explaining the math.

### L8. Test files use `as any` extensively for mock creation
**Files:** `src/ib-commands.test.ts` (17 occurrences), `src/tui/dashboard.test.ts` (40+ occurrences), `src/watcher.test.ts` (12 occurrences)

While acceptable in tests, the heavy use of `as any` to create mock agents suggests the test infrastructure could benefit from a shared mock factory that creates properly-typed Agent objects with sensible defaults. The existing `test-utils.ts` partially addresses this but isn't used consistently.

---

## Informational

### I1. Test coverage summary
28 test files cover 34 source files. The following source modules have **no dedicated test file**:
- `src/index.ts` — CLI entrypoint (708 lines, complex switch)
- `src/tui/agent-actions.ts` — agent action handlers
- `src/tui/pane-manager.ts` — right pane management
- `src/tui/dialog-handler.ts` — dialog state machine
- `src/tui/agent-tree.ts` — agent tree rendering (partially tested via dashboard.test.ts)
- `src/tui/colors.ts` — color constants (trivial)
- `src/tui/split-pane.ts` — split pane layout (has test file)
- `src/types.ts` — type definitions only (no logic to test)

### I2. Codebase size and structure
- **62 total TypeScript files** (34 source + 28 test)
- **968 tests** across 28 test files (per CLAUDE.md)
- Well-organized module structure with clear separation of concerns
- Good use of pure functions for testability (e.g., `checkPathAccess`, `parseState`, `detectRole`)

### I3. CLAUDE.md accuracy
CLAUDE.md is thorough and up-to-date with the current architecture. The implementation notes match the actual code structure. The only potential stale items:
- "968 tests" count may have changed with recent additions
- `contextSizeForModel` comment in auto-compact should note Claude 4.6 models

### I4. Code duplication in `runCmd` helper variants
There are 5 nearly-identical `runCmd` helper functions:
1. `nukeResumeRunCmd` (ib-commands.ts:116)
2. `mergeRunCmd` (ib-commands.ts:716)
3. `newAgentRunCmd` (ib-commands.ts:1131)
4. `runCmd` (agent-lifecycle.ts:45)
5. Inline pattern in tmux-poller.ts

Each wraps the same pattern: spawn → read stdout → await exit → return. They differ slightly in whether stderr is drained. This is related to M1 (spawn runner proliferation).

### I5. Good practices observed
- **Validation module** (`src/validation.ts`) with strict allowlists for shell-interpolated values
- **Pure function separation** for hook logic (checkPathAccess, processStopHook, detectRole)
- **Consistent error handling** in `IbCommandResult` return type
- **Comprehensive test coverage** for core modules (parse-state, agents, auto-compact, watchdog)
- **Config system** properly layered with project > user > default precedence
- **Race condition guard** in `TmuxPoller.setAgent()` (documented in CLAUDE.md)
- **Defensive ENOENT handling** throughout filesystem operations

### I6. Hardcoded values that could be configurable
- `POLL_INTERVAL_MS = 5_000` in watchdog.ts:44
- `COMPACT_CHECK_COOLDOWN_MS = 60_000` in watchdog.ts:47
- `INITIAL_NOTIFY_TICKS = 6` in watchdog.ts:50
- `MAX_NOTIFY_TICKS = 768` in watchdog.ts:53
- `CACHE_TTL_MS = 180_000` in usage.ts:43
- `API_TIMEOUT_MS = 5_000` in usage.ts:45
- Dashboard `DEFAULT_LEFT_WIDTH = 80`, `DIALOG_WIDTH = 60` in dashboard.ts:58-59
- Fallback poll interval `10_000` in watcher.ts:54
- State poll interval `2_000` in watcher.ts:59

These are reasonable defaults but some power users may want to tune polling intervals or timeouts.

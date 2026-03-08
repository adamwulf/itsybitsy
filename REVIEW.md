# itsybitsy Code Review

## Executive Summary

Solid, well-structured TUI application. 13 source files, 10 test files, 333 passing tests. Code is generally clean, well-named, and consistent. Main concerns: **dashboard.ts is a 2983-line monolith**, significant **duplicate code in dialog input handling and test helpers**, a few **shell safety edge cases**, and **no tests for ghostty.ts or index.ts**. The test suite is genuine and thorough where it exists — no vacuously passing tests.

---

## Per-File Findings

### src/agents.ts (388 lines)
- **Clarity**: Good. Types are well-defined. Functions have clear single responsibilities.
- **Consistency**: Uses `readdir` from `fs/promises` consistently. `Bun.file()` for reads.
- **Safety**: Bare `catch {}` blocks in `readAgentsFromDir` and `readPendingQuestions` swallow all errors silently — acceptable for "directory doesn't exist" but makes debugging harder if something unexpected fails.
- **Duplicate**: `readAgentLog` and `readAgentPrompt` follow the same pattern (construct path, check exists, read text, split lines, fallback). Could share a helper.

### src/ghostty.ts (33 lines)
- **Clarity**: Good, with a thorough header comment explaining macOS limitation.
- **Safety**: Session name validated with `/^[\w-]+$/` (P2). However, the validated name is then interpolated into a `--command` string: `bash -c "tmux set-option -t ${tmuxSession} ..."`. If the regex were ever relaxed, this becomes shell injection. The string interpolation pattern is inherently fragile even with the guard.
- **Test coverage**: **Zero tests.** This is the only source module with no test file at all.

### src/ib-commands.ts (117 lines)
- **Clarity**: Excellent. Clean, uniform pattern. Pluggable runner for testability.
- **Consistency**: Every command follows the same `runIb(args, cwd)` pattern.
- **Safety**: Uses array-form `Bun.spawn` — immune to shell injection. Good.

### src/index.ts (103 lines)
- **Clarity**: Straightforward CLI dispatch.
- **Consistency**: Fine.
- **Safety**: No input sanitization on `args[1]` passed to `addRepo`/`removeRepo`, but those functions resolve the path, so this is acceptable.
- **Test coverage**: **Zero tests.** Not critical since it's thin CLI glue, but the `agents` debug command has untested logic.

### src/parse-state.ts (196 lines)
- **Clarity**: Well-structured priority chain with comments explaining each rule.
- **Consistency**: Pure function, no side effects — excellent design.
- **Duplicate**: `filterHookSpinners` is applied twice (to `last15` and `last20`). Minor.

### src/registry.ts (76 lines)
- **Clarity**: Simple and clean.
- **Safety**: `removeRepo` has a subtle logic issue (P3): when removing by name, it filters by `r.name !== repoPath` — if two repos have the same name, both get removed. Unlikely but worth noting.
- **Consistency**: Uses `Bun.write` for saves, `Bun.file` for reads. Consistent.

### src/tmux-poller.ts (164 lines)
- **Clarity**: Good. Race condition handling is well-documented.
- **Safety**: Race condition guard (`this.tmuxSession !== targetSession`) is correct.
- **Note**: `onWidth` callback fires a detached promise (`getTmuxWindowWidth(…).then(…)`) with no error handling — if it rejects, it becomes an unhandled rejection (P3).

### src/usage.ts (215 lines)
- **Clarity**: Good. Cache/lock/backoff strategy is well-documented.
- **Safety**: Lock file approach is best-effort (not atomic) — acceptable for rate-limiting, not for correctness guarantees.
- **Duplicate**: Error handling for non-ok response (lines 177-188) and error response (lines 192-202) are nearly identical — both compute backoff and write cache the same way. (P3)
- **Test coverage**: Only pure functions tested (`formatResetTime`, `parseUsageResponse`). `fetchUsage`, `readAccessToken`, cache/lock logic are untested.

### src/watcher.ts (171 lines)
- **Clarity**: Clean. Debounce and fallback poll are well-separated.
- **Safety**: No guard against concurrent `refresh()` calls — if a fs.watch event fires during a fallback poll, two refreshes run simultaneously. The `polling` flag only guards `pollStates`. (P2)
- **Consistency**: Good separation from agents.ts.

### src/tui/dashboard.ts (2983 lines)
- **Clarity**: The largest file by far. Well-organized into component classes, but the sheer size makes navigation difficult. The `DashboardComponent` class alone is ~1600 lines.
- **Duplicate code (P1)**:
  - `handleDialogInput` for "textarea" and "new-agent-form" types share ~80% identical input handling logic (backspace, character input, word-delete, Enter for newlines, Tab/Shift-Tab focus cycling). This is the single largest duplication in the codebase.
  - `wrapTextareaLines` (line 60) is a simpler, non-ANSI-aware version of `wrapSingleLine` from `wrap.ts`. Could reuse.
  - Multiple `appendChar`/`appendPromptChar` lambdas with identical logic.
- **Safety**:
  - `handleOpenDiffTool` (line 1921): `tool.split(" ")` is fragile for diff tool paths containing spaces. (P2)
  - `handleOpenWorktree` (line 1896): `Bun.$\`open ${pathToOpen}\`.quiet()` — Bun's shell template tag should handle this safely, but paths with special chars could still cause issues. (P3)
  - `handleSnapshot` (line 2027): `Bun.$\`mkdir -p ${debugDir}\`.quiet()` — same concern. (P3)
- **Consistency**: ANSI constants defined as module-level `const` — good. Color scheme detection is well-isolated.

### src/tui/split-pane.ts (67 lines)
- **Clarity**: Clean, focused component.
- **Consistency**: Good.

### src/tui/wrap.ts (78 lines)
- **Clarity**: Well-documented. Handles wide characters and ANSI codes correctly.
- **Consistency**: Good.

### src/tui/folder-browser.ts (87 lines)
- **Consistency issue (P3)**: Uses `readdirSync`/`existsSync` (synchronous) while the rest of the codebase uses async `readdir`/`Bun.file().exists()`. This blocks the event loop during folder navigation.

---

## Test Assessment

### src/agents.test.ts — 37 tests
- **Real tests**: Yes. Tests actual file I/O with temp directories. Meaningful assertions on agent structure, tree building, connectors.
- **Edge cases**: Empty dirs, malformed JSON, missing meta.json, orphaned agents, multi-level trees.
- **Quality**: Excellent. The `flattenAgentTree` connector tests are particularly thorough.

### src/ib-commands.test.ts — 17 tests
- **Real tests**: Yes, via mock runner. Verifies correct args and cwd for every command.
- **Limitation**: Only tests that the right args are passed — doesn't test the default `Bun.spawn` runner. Acceptable for unit tests.
- **Quality**: Good coverage of all commands including options combinations.

### src/parse-state.test.ts — 30 tests
- **Real tests**: Excellent. Tests the actual parser against realistic tmux output patterns.
- **Edge cases**: Priority ordering, trailing blanks, stale WAITING, quoted completion signals, hook spinners.
- **Quality**: Very thorough. The priority tests explicitly verify the ordering rules.

### src/registry.test.ts — 7 tests
- **Real tests**: Yes. Uses temp dir with HOME override.
- **Quality**: Good but minimal. Missing: remove by name, concurrent access, malformed registry file recovery.

### src/tmux-poller.test.ts — 11 tests
- **Real tests**: Yes. Monkey-patches `Bun.spawn` (fragile but functional).
- **Edge cases**: Race condition with stale output, null agent, spawn throws.
- **Quality**: Good. The race condition test (delayed mock) is well-designed.

### src/usage.test.ts — 11 tests
- **Real tests**: Yes for pure functions. No tests for `fetchUsage` or caching logic.
- **Gap**: The most complex logic (cache TTL, lock files, backoff) is completely untested.

### src/watcher.test.ts — 17 tests
- **Real tests**: Yes. Properly mocks the agents module. Tests debounce with fake timers.
- **Edge cases**: Error recovery, concurrent state changes, fs.watch integration.
- **Quality**: Excellent. The fake timer tests are well-structured.

### src/tui/ansi-validation.test.ts — 5 tests
- **Real tests**: Integration tests verifying pi-tui handles ANSI correctly.
- **Quality**: Good validation that the framework works as expected.

### src/tui/dashboard.test.ts — 112 tests
- **Real tests**: Yes. Tests actual input handling, dialog flows, scroll logic.
- **Quality**: Thorough. Covers kill/nuke/resume/pause/reassign/merge/send/new-agent flows, scroll clamping, indicator edge cases (never "1 more"), multi-level navigation.
- **Gap**: No tests for `render()` output (visual correctness), `launchDashboard`, color scheme detection.

### src/tui/split-pane.test.ts — 16 tests
- **Real tests**: Yes. Tests rendering, padding, truncation, ANSI handling.
- **Quality**: Good. Covers edge cases (empty, zero-length, fullWidth toggle).

### src/tui/wrap.test.ts — 14 tests
- **Real tests**: Yes. Tests wrapping with ANSI codes, CJK characters, boundary conditions.
- **Quality**: Excellent. Wide character handling test is important.

### src/tui/folder-browser.test.ts — 7 tests
- **Real tests**: Yes. Uses temp directories with actual filesystem.
- **Quality**: Good. Tests ancestors, children, sorting, git detection, hidden dir exclusion.

---

## Prioritized Issues

### P0 — Critical
None.

### P1 — High

1. **dashboard.ts is a 2983-line monolith.** The `DashboardComponent` class handles input routing, dialog rendering, agent actions, pane management, polling, and more. This makes it hard to navigate, test individual features, and maintain. The dialog input handling alone (~350 lines) could be its own module.

2. **Massive duplicate code in dialog input handling.** The "textarea" and "new-agent-form" dialog types share ~80% identical input handling logic (character input, backspace, word-delete, Enter/newlines, Tab/Shift-Tab focus cycling). Each has its own `appendChar`/`appendPromptChar` lambda with identical bodies. A shared text-editing handler would eliminate ~100 lines of duplication.

### P2 — Medium

3. **No tests for ghostty.ts.** The only source module with zero test coverage. Session name validation, Ghostty availability check, and spawn behavior are all untestable currently.

4. **`handleOpenDiffTool` splits tool path on spaces.** `tool.split(" ")` (dashboard.ts:1921) breaks for tool paths like `/Applications/My Tool.app/Contents/MacOS/mytool`. Should use a proper argument parsing approach or document the limitation.

5. **No guard against concurrent `refresh()` in watcher.ts.** `pollStates` has a `this.polling` guard, but `refresh()` has no equivalent. A rapid fs.watch event during a fallback poll could trigger two simultaneous `refresh()` calls, leading to interleaved state updates.

6. **Shell interpolation in ghostty.ts despite validation.** The session name is validated then interpolated into a bash command string. While currently safe, this pattern is fragile — a future change to the regex could introduce injection. Consider using separate args instead of string interpolation.

7. **Usage.ts fetchUsage has zero test coverage for its core logic.** Cache TTL, lock file acquisition, backoff calculations, and API error handling are complex but completely untested.

### P3 — Low

8. **`makeAgent` test helper duplicated across 4+ test files** with slight variations (different parameter signatures, different defaults). A shared test utility would reduce maintenance burden.

9. **`wrapTextareaLines` in dashboard.ts reimplements line wrapping** without ANSI awareness. Could reuse `wrapSingleLine` from wrap.ts (textarea content is plain text, but using the existing function would be more consistent).

10. **folder-browser.ts uses synchronous `readdirSync`/`existsSync`** while the rest of the codebase uses async I/O. Blocks the event loop during folder navigation. Low impact since folder browsing is interactive and fast.

11. **`removeRepo` can remove multiple repos** if they share the same name (registry.ts:61). The name-based removal path filters by `r.name !== repoPath`, removing all matches.

12. **`onWidth` callback in TmuxPoller fires a detached promise** (tmux-poller.ts:81) with no `.catch()`. If `getTmuxWindowWidth` rejects, it becomes an unhandled promise rejection.

13. **Duplicate backoff logic in usage.ts** (lines 177-188 and 192-202). Both non-ok response and error response paths compute backoff and write cache identically. Could extract a `handleFailure` helper.

14. **Bare `catch {}` blocks** in agents.ts (`readAgentsFromDir`, `readPendingQuestions`) swallow all errors. Fine for expected cases (missing dirs) but masks unexpected failures.

15. **`stripAnsi` is redefined in dashboard.test.ts** with a simpler regex than the one in parse-state.ts. The test version doesn't handle OSC sequences. Not a bug (test-only) but inconsistent.

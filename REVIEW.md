# Code Review — itsybitsy codebase

Reviewed: 2026-03-08
Scope: All files under `src/`, all test files, supporting modules.

---

## Critical Issues

### 1. `wrapSingleLine` breaks surrogate pairs / multi-codepoint emoji
**File:** `src/tui/wrap.ts:45-57`
The wrap function iterates by `line[i]` (UTF-16 code units), not by grapheme cluster. Characters outside the BMP (emoji like 🚀, flags, skin-toned emoji) are represented as surrogate pairs in JavaScript strings. Indexing by `line[i]` will split a surrogate pair across two iterations, producing garbled output and incorrect width calculations. The `visibleWidth(char)` call on a lone surrogate will return incorrect results.

**Fix:** Use a grapheme-aware iterator (e.g., `Intl.Segmenter` or `for...of` on the string which iterates codepoints, not code units). The ANSI escape detection would need adjustment too.

### 2. `pollStates` and `refresh` can race, emitting stale data
**File:** `src/watcher.ts:122-143`
`pollStates` checks `if (agents !== this.lastAgents) return;` after awaiting, but it has already called `buildAgentTree` and `flattenAgentTree` which may have mutated `agent.children` on the stale agent list. The guard discards the *emit* but not the *mutation*. If `refresh()` is running concurrently and reads the same agent objects, `buildAgentTree` will see corrupted children arrays.

**Fix:** Either deep-clone agents before mutation, or serialize access so `pollStates` and `refresh` never overlap on the same agent objects.

### 3. `buildAgentTree` mutates agents in place
**File:** `src/agents.ts:251-277`
`buildAgentTree()` sets `agent.children = [...]` on every call. Since the same `Agent` objects are shared between `lastAgents`, `pollStates`, and `refresh`, concurrent calls to `buildAgentTree` on the same objects will produce data races. This is the root of the issue in #2.

### 4. Monkey-patching `globalThis.fetch` in tests leaks across test files
**File:** `src/usage.test.ts:137-142`
Tests reassign `globalThis.fetch` directly. If a test fails before `afterEach` restores it, subsequent tests in other files will see the mock. The `update-check.ts` module uses its own `setTestFetch()` injection which is safer — `usage.ts` should follow the same pattern.

---

## Duplicated Code

### 1. ANSI escape constants duplicated across 6+ files
The constants `RESET`, `BOLD`, `DIM`, `RED`, `GREEN`, `YELLOW`, `BLUE`, `CYAN`, `WHITE`, `BG_RED`, `BG_YELLOW`, etc. are independently defined in:
- `src/tui/dashboard.ts` (lines ~30-42)
- `src/tui/agent-actions.ts` (lines ~10-22)
- `src/tui/agent-tree.ts` (lines ~7-18)
- `src/tui/pane-manager.ts` (lines ~8-20)
- `src/tui/dialog-handler.ts` (lines ~10-22)
- `src/tui/color-scheme.ts` (lines ~3-10)

**Recommendation:** Extract to a shared `src/tui/colors.ts` module. This is the single largest source of duplication in the codebase.

### 2. `MIN_LEFT_WIDTH` / `MAX_LEFT_WIDTH` constants duplicated
- `src/tui/dashboard.ts` (lines ~25-26)
- `src/tui/agent-actions.ts` (lines ~5-6)

Both define `MIN_LEFT_WIDTH = 30` and `MAX_LEFT_WIDTH = 70`. These should live in one place (e.g., dashboard exports them, or a shared constants file).

### 3. State-to-color mapping duplicated
- `src/tui/agent-tree.ts:formatAgentRow` — maps agent state to ANSI color
- `src/tui/pane-manager.ts` — similar state-to-color logic for the status line

Both independently map `running` → green, `waiting` → yellow, `complete` → cyan, etc. A shared `stateColor(state)` helper would DRY this up.

---

## Missing / Weak Tests

### 1. No tests for `wrapSingleLine` with multi-byte / emoji characters
**File:** `src/tui/wrap.test.ts`
Tests cover ASCII and ANSI sequences but never test emoji, CJK characters, or surrogate pairs — exactly the edge case that's broken (see Critical Issue #1).

### 2. No integration test for `AgentWatcher` lifecycle
**File:** `src/watcher.test.ts`
The watcher tests mock `readAllAgents` and `detectAgentStates` but never test the actual `start()`/`stop()` lifecycle with `fs.watch`, timers, or debouncing. The `debounceRefresh` and `pollStates` methods are untested.

### 3. No tests for `readAccessToken` keychain fallback
**File:** `src/usage.ts:83-121`
`readAccessToken()` has two code paths: credentials file and macOS Keychain (`security find-generic-password`). Only the credentials-file path is tested. The keychain path is untested and involves parsing JSON from a subprocess — a likely source of bugs.

### 4. `dashboard.test.ts` uses `as any` extensively for mocking
**File:** `src/tui/dashboard.test.ts` (throughout)
The mock `tui` object is cast with `as any`, which means the tests won't catch if `DashboardComponent` starts depending on new TUI methods. A typed mock or interface would be more robust.

### 5. No test for `captureTmuxOutput` error handling
**File:** `src/tmux-poller.ts`
`captureTmuxOutput()` spawns `tmux capture-pane` and handles exit codes, but the test file (`tmux-poller.test.ts`) doesn't test what happens when `Bun.spawn` throws (e.g., tmux not installed).

### 6. No tests for `color-scheme.ts`
**File:** `src/tui/color-scheme.ts`
The OSC 11 query and Ghostty mode 2031 detection have zero test coverage.

### 7. Folder browser: no test for permission errors
**File:** `src/tui/folder-browser.test.ts`
Tests cover normal operation but never test what happens when `readdir` fails due to permissions. `buildFolderItems` catches errors and returns an empty children list, but this path is untested.

---

## Dead Code

### 1. `computeStateFromContent` may be unused at runtime
**File:** `src/agents.ts`
This function is exported and tested, but I could not find any call site outside of tests. `detectAgentStates()` calls `parseState()` directly from `parse-state.ts`. If `computeStateFromContent` was an earlier iteration, it may be dead code.

### 2. Unused `repoDisplayName` import in some files
Verify whether all imports of `repoDisplayName` from `registry.ts` are actually used — the function is imported in `watcher.ts` and used, but a grep across all files should confirm no stale imports exist.

---

## Inconsistencies

### 1. Test injection patterns vary across modules
- `ib-commands.ts`: Uses `setRunner()` / `resetRunner()` — clean, type-safe
- `tmux-poller.ts`: Monkey-patches `Bun.spawn` in tests — fragile, affects global state
- `usage.ts`: Monkey-patches `globalThis.fetch` — fragile (see Critical #4)
- `update-check.ts`: Uses `setTestFetch()` / `resetTestOverrides()` — clean, type-safe
- `usage.ts`: Uses `setTestDir()` / `resetTestDir()` for paths — clean

The codebase should pick one pattern and use it consistently. The `setRunner`/`resetRunner` style is the safest.

### 2. Error type handling inconsistent
- `watcher.ts:139`: `err instanceof Error ? err : new Error(String(err))` — correct pattern
- `agents.ts` in several places: catches `unknown` but doesn't always wrap
- `ib-commands.ts`: Returns `{ ok, exitCode, stdout, stderr }` — structured, consistent
- Some error paths swallow silently (e.g., `ghostty.ts:25` catches without logging)

### 3. Timer cleanup asymmetry
**File:** `src/watcher.ts:93-111`
`stop()` clears `pollTimer`, `stateTimer`, and `refreshTimer`, but doesn't await any in-progress `refresh()` or `pollStates()` call. After `stop()`, a `refresh` that's already running could still call `this.events.onUpdate()` on a stopped watcher. The `running` flag partially guards this, but `refresh()` doesn't check `this.running` between its async steps.

### 4. `agent.repoName` vs `agent.repoPath` naming
Agents have both `repoName` (display name) and `repoPath` (filesystem path). In `flattenAgentTree`, the `repoInfos` parameter uses `{ name, path }` which maps to these, but the naming isn't self-documenting. The parameter could be typed as `Pick<RepoEntry, ...>` for clarity.

---

## Minor Polish

### 1. Magic numbers in parse-state.ts
**File:** `src/parse-state.ts`
The "last N lines" values (5, 15, 20) used in `parseState()` are hardcoded magic numbers. Named constants would improve readability: `const RECENT_WINDOW = 5`, `const BROAD_WINDOW = 15`, etc.

### 2. `dashboard.ts` is still 1019 lines
Despite extracting `agent-actions.ts`, `agent-tree.ts`, `pane-manager.ts`, and `dialog-handler.ts`, the dashboard file is still large. The `handleInput` method in particular could benefit from further extraction — the keybinding dispatch could be a lookup table.

### 3. `SplitPane` left-pads with spaces but doesn't account for ANSI resets
**File:** `src/tui/split-pane.ts:43-50`
When padding the left pane to exact width, it uses `" ".repeat(pad)` but doesn't insert `RESET` before the separator. If the left pane's last character has styling (e.g., colored background), the padding spaces will inherit that style, causing visual artifacts at the separator.

### 4. `type FetchLike` in update-check.ts could use `typeof fetch`
**File:** `src/update-check.ts:11`
`type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>` could simply be `typeof fetch` for less maintenance burden.

### 5. `isCsiTerminator` could use a comment about OSC sequences
**File:** `src/tui/wrap.ts:12-14`
The function correctly handles CSI sequences but the wrapping code doesn't handle OSC sequences (e.g., hyperlinks `\x1b]8;;url\x07text\x1b]8;;\x07`). If pi-tui ever emits OSC sequences, the wrapper would break. A comment noting this limitation would be helpful.

### 6. Test helper `makeAgent` in `test-utils.ts` only sets minimal fields
**File:** `src/test-utils.ts`
`makeAgent()` returns an agent with many fields set to empty defaults. Tests that need specific fields override them inline, which is fine, but a builder pattern (e.g., `makeAgent().withState("running").build()`) would be more readable for complex test scenarios.

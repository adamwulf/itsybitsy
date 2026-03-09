# Code Review 2 — itsybitsy codebase (fresh eyes)

Reviewed: 2026-03-08
Scope: Full codebase read, first-impressions perspective from a new contributor.

---

## First Impressions

**Project structure: A-**
The layout is immediately legible. `src/index.ts` is the CLI entry, `src/tui/` is the dashboard, and the data layer (`agents.ts`, `registry.ts`, `parse-state.ts`, `watcher.ts`, `tmux-poller.ts`) is well separated. File names map cleanly to responsibilities. A new contributor could orient themselves within 10 minutes.

**README: solid.** Covers installation, usage, and every keybinding. The keybinding table is comprehensive and well-organized. One missing thing: there's no architecture overview or "how it works" section — a 5-line explanation of the data flow (registry -> agents -> watcher -> parse-state -> dashboard) would help newcomers understand *why* the files are organized the way they are.

**Entry point: good, but sprawling.** `src/index.ts` is a well-structured CLI dispatcher with a clean `switch` statement. However, at 450 lines, the `agents`/`tree` case (lines 109-193) does a lot of inline formatting that belongs in its own module. The rest of the cases are clean and easy to follow.

---

## What's Clean

1. **Separation of data and UI is excellent.** `agents.ts` reads data. `parse-state.ts` classifies it. `watcher.ts` orchestrates polling. `dashboard.ts` displays it. No module does double-duty. This is the kind of architecture that makes it possible to refactor the TUI without touching the data layer.

2. **`parse-state.ts` is remarkably well-structured.** The priority-ordered pattern matching is easy to read and reason about. Named window constants (`RECENT_WINDOW`, `STANDARD_WINDOW`, `BROAD_WINDOW`) replaced the magic numbers from the first review — good follow-through. The pure-function design (no side effects, no I/O) makes it trivially testable.

3. **Test injection pattern in `ib-commands.ts`.** The `setRunner()`/`resetRunner()` pattern is clean, type-safe, and doesn't pollute global state. This is the gold standard for testability in this codebase.

4. **`colors.ts` consolidation.** The first review flagged ANSI constants duplicated across 5 files. This was fixed — all TUI files now import from a single `src/tui/colors.ts` module. Clean resolution.

5. **Error handling in `agents.ts`.** The `ReadAgentsResult` pattern (`{ agents, errors }`) is excellent — callers can decide whether to surface errors. The ENOENT handling throughout is defensive without being noisy.

6. **`SplitPane` is elegant.** At 72 lines, it does exactly one thing and does it well. The ANSI reset insertion before padding (line 59-62) shows attention to rendering edge cases.

7. **`computeAge()` is readable.** Simple, no dependencies, easy to test. Same for `formatResetTime()` in `usage.ts`.

8. **`test-utils.ts` with `makeAgent()`.** Good builder with sensible defaults. Tests that need specific configurations override only what matters.

9. **Race condition guards in `TmuxPoller`.** The `targetSession` snapshot pattern (`src/tmux-poller.ts:76-88`) — snapshot before async work, discard if target changed — is a clean solution to a subtle concurrency bug.

10. **The `ActionCtx` interface** (`agent-actions.ts:35-66`). This structural typing approach means `DashboardComponent` satisfies the interface without explicit `implements`, making the actions testable with minimal mocks. Smart design.

---

## Confusing / WTF Moments

### 1. `handleInput` is a 100-line if/else chain
**File:** `src/tui/dashboard.ts:693-834`

This method dispatches ~30 keybindings through a chain of `if/else if` statements. It works, but it's hard to scan. A few surprises buried in it:

- Line 793-798: `x` does *different things* depending on whether a repo header or agent is selected (kill agent vs. remove repo). This context-sensitivity is non-obvious and undocumented in the code.
- Line 802-808: Same for `r` — reassign agent vs. rename repo.
- The ordering matters (e.g., Enter on ERRORS mode at line 772 must come before generic Enter at line 777), but there's no comment explaining why.

A keybinding lookup table or at least a comment block explaining the precedence rules would help.

### 2. `dialog` type narrowing requires `as any` everywhere in tests
**File:** `src/tui/dashboard.test.ts` — 70+ uses of `(dashboard.dialog as any)`

The `DialogState` is a discriminated union with `| null`, and tests need to access fields like `.prompt`, `.focusedButton`, etc. Since `dialog` could be any variant, tests cast to `any` to read fields. This is the single biggest source of `as any` in the codebase.

A helper like `expectDialog<T>(dashboard, 'confirm')` that asserts the type and returns it narrowed would eliminate all of these.

### 3. Worktree path computation duplicated 3 times
**Files:**
- `src/index.ts:44-48` — `agentWorktreePath()`
- `src/tui/agent-actions.ts:479-485` — inline in `handleOpenWorktree`
- `src/tui/agent-actions.ts:510-516` — inline in `handleOpenDiffTool`

All three compute: `agent.repoPath/.ittybitty/{agents|archive}/agent.id/repo`. The `index.ts` version is a proper helper function but isn't imported by `agent-actions.ts`. This means a change to the path structure requires updating 3 places.

### 4. The `agents`/`tree` CLI command is 80 lines of inline formatting
**File:** `src/index.ts:109-193`

This case block does column width computation, color lookups, padding, and formatted output — all inline in the switch case. It's the longest case by far and imports from 4 different TUI modules. Should be extracted to a function (or even its own file), like the `watch` case delegates to `launchDashboard()`.

### 5. `buildAgentTree` mutates agents in place
**File:** `src/agents.ts:185-206`

Still flagged from the first review and still concerning. `buildAgentTree()` sets `agent.children = []` and `agent.orphaned = false` on every call. Since `watcher.ts` shares agent references between `lastAgents`, `pollStates`, and `refresh`, concurrent calls can corrupt children arrays. The `pollStates` method has a stale-reference guard (line 129), but the mutation has already happened by then.

### 6. `ghostty.test.ts` monkey-patches `Bun.which` and `Bun.spawn`
**File:** `src/ghostty.test.ts` — 20+ uses of `as any`

Unlike `ib-commands.ts` (which uses clean `setRunner`/`resetRunner`), `ghostty.ts` has no injection point. Tests directly replace `Bun.which` and `Bun.spawn` with casts, which could leak if a test fails before `afterEach`.

### 7. `modeIndex` vs `rightPane.mode` can diverge
**Files:** `src/tui/dashboard.ts:343`, `src/tui/pane-manager.ts:294-325`

`DashboardComponent.modeIndex` is the index into `PANE_MODES`, and `rightPane.mode` is the string value. These are kept in sync by `cyclePaneMode` and `jumpToMode`, but they're two sources of truth for the same concept. If someone calls `rightPane.setMode()` directly without updating `modeIndex`, the cycle logic breaks. The mode index should either live on `RightPaneComponent` or be computed from it.

### 8. `RightPaneComponent` has 16 public fields
**File:** `src/tui/pane-manager.ts:58-78`

This component has grown to hold: mode, agent, questions, allAgents, scrollOffset, displayHeight, agentLogContent, promptContent, denialsContent, denialFilter, errors, orphanedTmuxSessions, diffContent, diffLoading, statusContent, statusLoading, questionsSelectedIndex, questionsFocused, content, selectedRepoHeader. It's becoming a god object for "everything the right pane needs to know." The content for each pane mode could be encapsulated in per-mode objects.

---

## Architecture Concerns

### 1. Implicit coupling through shared mutable state
The `Agent` objects returned by `readAllAgents()` are passed to `detectAgentStates()` (which mutates `state`), then `buildAgentTree()` (which mutates `children` and `orphaned`), then stored in `lastAgents`. The watcher's `pollStates` can re-read the same objects while `refresh` is rewriting them. The `refreshing`/`polling` flags partially guard this, but the underlying issue is that these functions mutate shared objects instead of returning new ones.

### 2. Dashboard ↔ pane-manager circular knowledge
`pane-manager.ts` exports functions like `cyclePaneMode(ctx, delta)` that take a `PaneCtx`. But `PaneCtx` (line 284-292) contains `rightPane: RightPaneComponent`, `splitPane`, `modeIndex`, etc. — essentially requiring most of `DashboardComponent`'s internals. This means the extraction didn't really separate concerns; it moved code to a different file but kept the coupling. The actions still reach deep into dashboard internals.

### 3. The dialog system grows with every feature
Every new dialog type (there are now 9 variants in the union) adds a branch to `DialogOverlayComponent.buildContent()`, a handler to `handleDialogInput()`, and potentially a builder function. The discriminated union pattern works, but at 9 variants, a registry/strategy pattern might scale better.

### 4. No programmatic API — only CLI
All commands go through `src/index.ts` with `process.exit()` calls scattered throughout (20+ occurrences). If someone wanted to use itsybitsy as a library (e.g., embed the watcher in another tool), they'd need to refactor every `process.exit()` into a return value. The data layer (`agents.ts`, `registry.ts`) is already clean for library use, but `index.ts` binds everything to process lifecycle.

---

## Duplication

### 1. Worktree path computation (3 copies)
Already described in WTF #3 above. `index.ts:44-48`, `agent-actions.ts:479-485`, `agent-actions.ts:510-516`.

### 2. `SpawnFn` / `SpawnResult` type defined twice
- `src/tmux-poller.ts:10-16` — `SpawnResult` + `SpawnRunner`
- `src/usage.ts:27-32` — `SpawnResult` + `SpawnFn`

Both define nearly identical types for injecting `Bun.spawn`. A shared type in a utility module would reduce duplication.

### 3. `FetchLike` type defined twice
- `src/usage.ts:11`
- `src/update-check.ts:11`

Same type, same purpose, different files.

### 4. Agent-specific mode check repeated
- `src/tui/pane-manager.ts:125-126` — `const agentSpecificModes: Set<PaneMode> = new Set([...])`

This set is constructed inline inside `updateContent()` on every call. Should be a module-level constant.

### 5. `requestRender` call pattern
Throughout `dashboard.ts` and `agent-actions.ts`, nearly every state change ends with `ctx.tui?.requestRender()`. While each call is individually necessary, the pattern suggests that state changes should automatically trigger renders (React-style), rather than requiring manual render requests. Not strictly duplication, but a design pattern that could be simplified.

---

## Recommendations

### High priority
1. **Extract `agentWorktreePath()` into `agents.ts`** and import it everywhere. One function, one truth.
2. **Add a typed dialog accessor for tests** — something like `assertDialog(d, 'confirm')` that narrows the type. Would eliminate 70+ `as any` casts in `dashboard.test.ts`.
3. **Make `buildAgentTree` return new agent clones** (or at least new arrays) instead of mutating in place. This would close the race condition with `pollStates`.

### Medium priority
4. **Extract the `agents`/`tree` CLI formatting** from `index.ts` into a standalone function or module.
5. **Add `setWhich`/`setSpawn` injection to `ghostty.ts`** to match the pattern used in `ib-commands.ts` and `tmux-poller.ts`. Kill the `Bun.which = ... as any` pattern in tests.
6. **Unify `SpawnFn`/`SpawnResult` and `FetchLike`** into shared types in a `src/types.ts` or similar.
7. **Make `modeIndex` derived from `rightPane.mode`** instead of being a separate field on dashboard. Compute it when needed with `PANE_MODES.indexOf(rightPane.mode)`.

### Low priority
8. **Consider a keybinding table** in `handleInput` — a `Map<string, () => void>` for simple key dispatches, with special cases handled separately.
9. **Add a brief architecture section to README** — 5 lines explaining the data flow would help new contributors enormously.
10. **Promote `agentSpecificModes`** in `pane-manager.ts:125` to a module-level constant.

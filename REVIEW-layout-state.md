# Layout State Save/Restore — Deep Review

## 1. Current Architecture Overview

### What is saved (`~/.itsybitsy/layout.json`)

```json
{
  "sidebarWidth": 60,
  "splitPaneLeftWidth": 80,
  "heightOffsets": { "tree": 0, "info": 0, "coordinator": 0 },
  "repoCoordinatorHeightOffset": 0
}
```

| Field | Purpose | Default |
|-------|---------|---------|
| `sidebarWidth` | Left sidebar column count | 60 (`SIDEBAR_WIDTH`) |
| `splitPaneLeftWidth` | Tmux pane width in the middle area | 80 (`DEFAULT_LEFT_WIDTH`) |
| `heightOffsets.tree` | Delta applied to agent-tree base height | 0 |
| `heightOffsets.info` | Delta applied to info-panel base height | 0 |
| `heightOffsets.coordinator` | Delta applied to coordinator base height | 0 |
| `repoCoordinatorHeightOffset` | Delta for repo coordinator split in REPO right-pane mode | 0 |

### What is NOT saved but arguably should be

- **Right pane mode** (AGENT LOG, PROMPT, DENIALS, etc.) — resets to default each launch
- **Scroll positions** — ephemeral, probably correct not to save
- **Focus target** — resets to agent-tree, reasonable
- **coordinatorViewMode** (TMUX vs DASHBOARD) — resets to TMUX, reasonable

### Full Lifecycle

1. **Startup** (`launchDashboard()` in dashboard.ts:1901):
   - `loadLayout()` reads `~/.itsybitsy/layout.json`, validates shape (rejects NaN/Infinity)
   - If valid, `dashboard.applyLayout(savedLayout)` is called
   - `resizeCoordinatorTmux(dashboard.sidebarWidth)` is always called (even without saved layout)

2. **applyLayout()** (dashboard.ts:707):
   - Clamps `sidebarWidth` to [30, 120]
   - Clamps `splitPaneLeftWidth` to [MIN_LEFT_WIDTH(40), MAX_LEFT_WIDTH(160)]
   - Copies `heightOffsets` to `sidebar.heightOffsets`
   - Copies `repoCoordinatorHeightOffset` to `rightPane`
   - Sets `layoutRestored = true` (permanently suppresses tmux-reported widths)
   - Sets `pendingTmuxResize = true` (deferred until first `onUpdate` with agents)

3. **Runtime resize** (`[`/`]` keys, dashboard.ts:1520-1543):
   - Focus-aware: sidebar panels adjust `sidebarWidth`, active-agent/right-pane adjust `splitPaneLeftWidth`
   - All agent tmux sessions are resized immediately via `resizeTmuxWindow()`
   - `persistLayout()` is called after every resize

4. **Runtime height resize** (`{`/`}` keys, dashboard.ts:1545-1614):
   - Adjusts `heightOffsets` with neighbor-stealing logic
   - `persistLayout()` is called after every resize

5. **persistLayout()** (dashboard.ts:722):
   - Calls `saveLayoutDebounced()` with a snapshot of current state
   - 500ms debounce window

6. **Shutdown** (Ctrl+C handler, dashboard.ts:1966):
   - `flushPendingSave()` writes any pending debounced state to disk before exit

7. **External consumers** (`ib-commands.ts`):
   - `getSavedTmuxWidth()` and `getSavedSidebarWidth()` read layout.json to size new agent tmux sessions and coordinator sessions at creation time

---

## 2. Bugs

### BUG-1: `layoutRestored` is never cleared — permanently suppresses tmux width sync

**File:** `dashboard.ts:522, 673, 717`

`layoutRestored` is set `true` in `applyLayout()` and **never set back to `false`**. The `onWidth` callback from the tmux poller (line 673) returns early when `layoutRestored` is true. This means:

- After a layout is restored, if a user resizes the tmux session externally (e.g., via `tmux resize-window`), the dashboard will never pick up the change.
- This is intentional for the initial race window (the comment says so), but the flag should be cleared after the pending resize completes — e.g., after `pendingTmuxResize` fires in `onUpdate()`.

**Suggested fix:** Clear `layoutRestored` after the pending tmux resize is processed (around line 965).

### BUG-2: `saveLayoutDebounced` has a confusing dual-state pattern

**File:** `layout.ts:93-103`

The function stores the state in both `pendingState` (for `flushPendingSave`) and in the `setTimeout` closure (for the timer callback). Line 99 writes `state` (the closure-captured parameter), not `pendingState`. This works correctly because each call replaces the timer, but:

- If someone adds logic between "clear old timer" and "set new timer," the `pendingState` and the closure's `state` could diverge.
- It's unnecessarily confusing. The timer callback should use `pendingState` instead.

**Impact:** Currently not a bug because the pattern happens to be correct, but it's fragile and misleading.

### BUG-3: Height offsets can accumulate beyond valid ranges across terminal resizes

**File:** `dashboard.ts:1549-1614`, `sidebar.ts:104-134`

Height offsets are stored as deltas from the *computed base heights*, which depend on `displayHeight` and `itemCount`. If the terminal is resized (making `displayHeight` change), the stored offsets may produce invalid effective heights. The sidebar's clamping logic (lines 116-134) handles the worst case by shrinking from the bottom up, but:

- An offset of +10 saved on a 40-row terminal becomes meaningless on a 20-row terminal
- The clamping is done at render time but the offsets are never normalized — so the saved layout.json may contain offsets that only make sense at one terminal size
- Growing the terminal back doesn't recover the original proportions because the offsets were over-clamped

**Suggested fix:** Either save ratios instead of absolute offsets, or normalize offsets on terminal resize.

### BUG-4: `persistLayout()` is NOT called when tmux-reported width updates the split pane

**File:** `dashboard.ts:669-679`

When `layoutRestored` is false and the tmux poller reports a width (e.g., first launch without a saved layout), the split pane width is updated but `persistLayout()` is never called. This means:

- On first launch, the split pane takes whatever width tmux reports
- If the user exits without manually resizing, no layout.json is ever created
- New agents spawned by `ib new-agent` will use `DEFAULT_TMUX_WIDTH = 80` instead of the actual width

**Impact:** Minor — only matters for the first-launch experience.

---

## 3. Complications and Unclear Patterns

### COMPLICATION-1: MIN_SIDEBAR/MAX_SIDEBAR are duplicated as local constants

**File:** `dashboard.ts:708-709` and `dashboard.ts:1526-1527`

Both `applyLayout()` and the `[`/`]` handler define `MIN_SIDEBAR = 30` and `MAX_SIDEBAR = 120` as local `const` variables. These should be module-level constants (like `MIN_LEFT_WIDTH` and `MAX_LEFT_WIDTH` are in `split-pane.ts`).

### COMPLICATION-2: Three separate default-width constants for the same concept

- `DEFAULT_LEFT_WIDTH = 80` in `dashboard.ts:84` — used as constructor default for `SplitPane`
- `DEFAULT_TMUX_WIDTH = 80` in `layout.ts:132` — used by `getSavedTmuxWidth()` fallback
- `DEFAULT_SIDEBAR_WIDTH = 60` in `layout.ts:146` — used by `getSavedSidebarWidth()` fallback
- `SIDEBAR_WIDTH = 60` in `sidebar.ts:17` — used as initial value in dashboard constructor

`DEFAULT_LEFT_WIDTH` and `DEFAULT_TMUX_WIDTH` are the same value (80) but exist as separate constants with no cross-reference. `DEFAULT_SIDEBAR_WIDTH` and `SIDEBAR_WIDTH` are similarly duplicated at 60.

### COMPLICATION-3: `pendingTmuxResize` depends on agents being loaded

**File:** `dashboard.ts:964-972`

The pending resize only fires when `flatList.length > 0`. If the dashboard starts with zero agents, the resize never happens. When agents are later added, the flag has already been cleared... wait, no — the flag persists until the first `onUpdate` with agents. But there's still a timing issue:

- If an agent is created *after* the flag fires but *before* the next `onUpdate`, that agent won't get resized to the saved width
- The agent gets resized when selected (line 1114), but not proactively

### COMPLICATION-4: Sidebar height offsets interact non-obviously with agent count

The base heights computed by `computeSidebarHeights()` depend on `itemCount` (number of visible tree items). As agents are added/removed, the base heights shift, but the stored offsets remain fixed. This means:

- Adding 5 agents might push the tree's base height from 3 to 7, causing the coordinator to shrink
- But the user's stored `heightOffsets.tree = +4` from a previous resize is still applied on top
- Result: the tree claims much more space than the user intended

The offsets should probably be relative to a fixed reference rather than to a dynamic base.

### COMPLICATION-5: `repoCoordinatorHeightOffset` is not in the SPEC

The SPEC §13.7 shows the layout.json schema without `repoCoordinatorHeightOffset`. This field was added later. The `loadLayout()` function handles it as optional (defaulting to 0), but the SPEC should be updated.

### COMPLICATION-6: Width resize resizes ALL agent tmux sessions

**File:** `agent-actions.ts:908-913`

`handleResizeLeft()` iterates over every agent in the tree and calls `resizeTmuxWindow()` for each. For a large number of agents, this spawns many concurrent tmux processes. There's no batching or throttling.

---

## 4. Sidebar Sub-Panel Height Interactions

### How it works

The sidebar has three sections (agent-tree, info, coordinator) with heights computed by `computeSidebarHeights()`:

1. **Tree height** = `min(MAX_TREE_HEIGHT, max(1, itemCount))` — based on number of visible items
2. **Coordinator height** = `max(5, floor(remaining * 0.4))` — 40% of what's left after tree
3. **Info height** = everything remaining

Height offsets are then applied as deltas to these base values. The `{`/`}` keys implement neighbor-stealing: growing one panel shrinks the one below it (or above for coordinator).

### Problems

1. **Base heights are recomputed every render** but offsets are absolute deltas persisted across renders. When `displayHeight` changes (terminal resize) or `itemCount` changes (agents added/removed), the base values shift but offsets don't, leading to unexpected proportions.

2. **Zero-height panels disappear permanently** within a session. If the coordinator's effective height reaches 0, there's no way to grow it back via `{`/`}` because the coordinator focus target is skipped when its height is 0 (it's hidden, so Tab cycling skips it). The only recovery is to restart and let the offsets reset... but they're persisted, so even restart doesn't help.

3. **`hideCoordinator` mode (coordinator selected)** gives coordinator space to info, but doesn't adjust the height offsets. When switching back to a normal agent, the offset state may produce a layout that looks different from before the coordinator was selected.

---

## 5. Middle vs Right Pane Width Determination

### Current behavior

- `splitPaneLeftWidth` controls the tmux (middle) pane width
- The right pane width is computed as: `terminal_width - sidebarWidth - 1(separator) - splitPaneLeftWidth - 1(separator)`
- The right pane has no independent width state — it's always the remainder
- When `[`/`]` is pressed with active-agent focus, the split pane left width changes (middle grows, right shrinks)
- When `[`/`]` is pressed with right-pane focus, the inverse happens

### Should right pane width be independently saveable?

No — the current model (sidebar width + split-pane left width determine everything) is correct and sufficient. The right pane is the flex element that absorbs terminal width changes. Making it independently saveable would over-constrain the system.

### Issue: Terminal width changes don't trigger re-layout

There's no SIGWINCH handler or `process.stdout.on('resize')` listener. When the terminal is resized:
- pi-tui re-renders at the new width (it passes `process.stdout.columns` to `render()`)
- But tmux sessions are NOT resized to match
- The split-pane left width remains at its saved value, which may be too wide for the new terminal
- The right pane could end up with negative or very small width

The sidebar width is also not clamped against the new terminal width during render, though the `SplitPane.render()` does `Math.min(this.leftWidth, width - sepWidth - 1)` which prevents overflow.

---

## 6. Race Conditions and Ordering Issues

### RACE-1: Layout restore vs tmux poller initial width report

When the dashboard starts with a saved layout:
1. `applyLayout()` sets `splitPaneLeftWidth` and `layoutRestored = true`
2. The tmux poller starts polling and may report a width before `resizeTmuxWindow()` takes effect
3. The `onWidth` callback checks `layoutRestored` and returns early — correct

But because `layoutRestored` is never cleared (BUG-1), this guard becomes permanent.

### RACE-2: `pendingTmuxResize` vs agent creation

1. Layout is restored, `pendingTmuxResize = true`
2. First `onUpdate` fires with some agents, resizes them all, clears the flag
3. A new agent is created seconds later
4. That agent's tmux session was created with `getSavedTmuxWidth()` (reads layout.json) — which is correct
5. But if the user has since resized the split pane, the new agent gets the old width from layout.json
6. It's only corrected when selected (line 1114 does `resizeTmuxWindow`)

### RACE-3: Debounced save vs exit

The `flushPendingSave()` call on Ctrl+C handles this correctly — it cancels the timer and writes immediately. No race here.

### RACE-4: Multiple dashboard instances

If two `ib watch` instances run simultaneously and both resize, they'll overwrite each other's layout.json. The last write wins. No locking mechanism exists. This is low priority since running multiple dashboards is unusual.

---

## 7. Suggestions for Cleanup

### 7.1 Extract layout constants

Move `MIN_SIDEBAR`, `MAX_SIDEBAR` to module-level exports in `layout.ts` alongside `MIN_LEFT_WIDTH` / `MAX_LEFT_WIDTH`. Consolidate `DEFAULT_LEFT_WIDTH` / `DEFAULT_TMUX_WIDTH` into a single constant.

### 7.2 Clear `layoutRestored` after pending resize

In `onUpdate()`, after the `pendingTmuxResize` block (line 972), add:
```ts
this.layoutRestored = false;
```
This restores normal tmux width sync after the initial layout application.

### 7.3 Simplify `saveLayoutDebounced`

Use `pendingState` in the timer callback instead of the closure-captured `state`:
```ts
export function saveLayoutDebounced(state: LayoutState): void {
  pendingState = state;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const toSave = pendingState;
    pendingState = null;
    if (toSave) saveLayout(toSave).catch(() => {});
  }, 500);
}
```

### 7.4 Add terminal resize handler

Listen for `process.stdout.on('resize')` and:
1. Re-clamp `sidebarWidth` against new terminal width
2. Re-clamp `splitPaneLeftWidth` against new available width
3. Resize all agent tmux sessions
4. Persist the clamped layout

### 7.5 Consider ratio-based height offsets

Instead of storing absolute deltas, store the desired height ratios for sidebar panels. This would make the layout stable across terminal resizes. However, this is a larger refactor and the current system works acceptably for the common case (terminal size doesn't change much).

### 7.6 Update SPEC §13.7

Add `repoCoordinatorHeightOffset` to the documented schema in SPEC.md.

### 7.7 Guard against zero-height coordinator recovery

When `{`/`}` resize would reduce a panel to 0, ensure there's a way to grow it back. One option: skip focus cycling for zero-height panels but still allow Tab to reach them for the purpose of resizing up.

---

## 8. Summary of Findings

| ID | Type | Severity | Description |
|----|------|----------|-------------|
| BUG-1 | Bug | Medium | `layoutRestored` never cleared — permanently suppresses tmux width sync |
| BUG-2 | Code smell | Low | Dual-state in `saveLayoutDebounced` — confusing but correct |
| BUG-3 | Bug | Medium | Height offsets invalid after terminal resize |
| BUG-4 | Bug | Low | First-launch tmux width not persisted |
| COMP-1 | Cleanup | Low | Duplicated MIN/MAX_SIDEBAR constants |
| COMP-2 | Cleanup | Low | Three separate default-width constants |
| COMP-3 | Edge case | Low | `pendingTmuxResize` misses late-arriving agents |
| COMP-4 | Design | Medium | Height offsets sensitive to agent count changes |
| COMP-5 | Documentation | Low | `repoCoordinatorHeightOffset` not in SPEC |
| COMP-6 | Performance | Low | Width resize spawns N concurrent tmux processes |
| RACE-1 | Race | Medium | Permanent tmux width suppression (= BUG-1) |
| RACE-2 | Race | Low | New agents may get stale width from layout.json |
| RACE-4 | Race | Very low | Multiple dashboard instances overwrite layout.json |

# itsybitsy UX Parity Check — Post P0-Fix Analysis

**Date:** 2026-03-06
**Scope:** Gaps remaining after recent P0 fixes (full-width panes, usage tracking, poll race conditions, resp.ok check, sub-minute age format).

---

## What Was Fixed (P0 items now resolved)

| Item | Status | Notes |
|------|--------|-------|
| Full-width pane modes (DENIALS, TREE, ERRORS, DIFF, QUESTIONS) | FIXED | `FULL_WIDTH_MODES` set at line 117; `SplitPane.fullWidth` toggled in `cyclePaneMode()` and `jumpToMode()` |
| Usage tracking / API quota display | FIXED | `fetchUsage()` called at startup and every 30s; color-coded in `StatusBarComponent.formatUsage()` |
| Tmux display capture depth (100 → 500 lines) | FIXED | `TmuxPoller` constructor defaults to `lines=500`; display is at parity |
| TmuxPoller race condition guard | FIXED | `targetSession` snapshot before await, discard on mismatch |

---

## Remaining Gaps

### P0 — Still High Impact

#### G-01: All-agent state polling (only selected agent polled)

**ib watch:** Background monitor (150ms) captures tmux for **every** agent and writes `.state` cache files. The agent tree always shows current states for all agents simultaneously.

**itsybitsy:** `TmuxPoller` only polls the **selected** agent at 1s. `detectAgentStates()` in `watcher.ts` captures all agents via `captureTmuxOutput()` but only runs on fs.watch events (debounced 200ms) or the 10s fallback. Between file-system events, agent states can lag by up to 10s.

**File:** `src/tmux-poller.ts` (TmuxPoller only), `src/agents.ts:detectAgentStates()`

**Impact:** Agent tree shows stale states between refreshes. A running agent can complete or error without the tree updating until the next fs.watch event fires.

**Complexity:** Medium. Add a round-robin background cycle in the watcher that polls 1–2 agents per second for state, independently of the display poller.

---

#### G-02: State detection capture depth (100 vs 500 lines)

**ib watch:** Uses 500 lines for both display and state detection from the same capture.

**itsybitsy:** `captureTmuxOutput()` defaults to 100 lines (`src/tmux-poller.ts:89`). `detectAgentStates()` uses this default. Patterns like WAITING at 25+ lines back may be missed.

**File:** `src/tmux-poller.ts:89` — `captureTmuxOutput(tmuxSession, lines = 100)`

**Impact:** State misdetection for active agents with verbose output. The "WAITING" or "I HAVE COMPLETED THE GOAL" marker could be beyond the 100-line window.

**Complexity:** Low. Change default from 100 to 500 in `captureTmuxOutput()`. Verify tests still pass.

---

### P1 — Medium Impact

#### G-03: Pane cycling skips empty ERRORS and QUESTIONS panes

**ib watch:** `watch_calc_next_pane()` (lines 15263–15283) skips the ERRORS pane when `ERRORS_TOTAL_COUNT == 0` and skips QUESTIONS pane when `QUESTIONS_TOTAL_COUNT == 0`.

**itsybitsy:** `cyclePaneMode()` (`src/tui/dashboard.ts:1584`) is simple modular arithmetic — no skip logic. Users land on ERRORS and QUESTIONS even when they are empty.

**File:** `src/tui/dashboard.ts:1584` — `cyclePaneMode()`

**Impact:** Friction — users cycle through visually empty panes on every `p`/`n` press.

**Complexity:** Low. In `cyclePaneMode()`, after computing the new mode index, check: if mode is ERRORS and `rightPane.errors.length === 0`, skip; if mode is QUESTIONS and `rightPane.questions.length === 0`, skip.

---

#### G-04: Diff colorization missing

**ib watch:** DIFF pane colorizes output: green for additions (`+` lines), red for removals (`-` lines), dim for headers (`@@`, `---`, `+++`).

**itsybitsy:** `loadDiff()` at `src/tui/dashboard.ts:1541` splits raw `ib diff` output by `\n` and stores as-is. No colorization.

**File:** `src/tui/dashboard.ts:1541–1546`

**Impact:** Diff is harder to read without color. This is one of the most-used panes for reviewing agent work.

**Complexity:** Low. Post-process `diffContent` lines: lines starting with `+` (not `+++`) → green; lines starting with `-` (not `---`) → red; lines starting with `@@`, `---`, `+++`, or `diff ` → dim.

---

#### G-05: Agent log colorization missing

**ib watch:** Agent log lines are colorized: ISO timestamps dimmed (`COLOR_DIM`), `[bracket]` blocks in cyan.

**itsybitsy:** `readAgentLog()` returns raw lines (`src/agents.ts:readAgentLog`). Displayed as-is in the AGENT LOG pane with no color processing.

**File:** `src/agents.ts` — `readAgentLog()`, or in `syncSelectedAgent()` / `loadAgentLog()` at `src/tui/dashboard.ts:1513`

**Impact:** Timestamps and log section headers are harder to scan. Timestamps being dim lets users focus on the message content.

**Complexity:** Low. Apply regex transforms in `loadAgentLog()`: dim ISO timestamp prefix, cyan `[...]` markers. ANSI in log output should flow through `wrapLines()` correctly.

---

#### G-06: Orphaned worker indicator missing

**ib watch:** Workers whose `manager` field names an agent that no longer exists get a `⚠️` prefix in the tree line.

**itsybitsy:** `buildAgentTree()` (`src/agents.ts:158`) adds orphaned workers to `roots` (correct for positioning), but `formatAgentRow()` (`src/tui/dashboard.ts:133`) shows no visual warning. No `orphaned` flag on the `Agent` type.

**File:** `src/agents.ts:158–173` (`buildAgentTree`), `src/tui/dashboard.ts:133` (`formatAgentRow`)

**Impact:** Users can't tell at a glance if a worker lost its manager — important for debugging stuck hierarchies.

**Complexity:** Low. Add `orphaned: boolean` to `Agent`. In `buildAgentTree()`, when `agent.meta.manager` is set but not found in `byId`, mark `agent.orphaned = true`. In `formatAgentRow()`, prepend a warning indicator (e.g., `[!]` or `⚠ `) when `agent.orphaned`.

---

#### G-07: Error count badge missing from footer

**ib watch:** Footer shows an unread error count in red when errors exist.

**itsybitsy:** `StatusBarComponent.render()` (`src/tui/dashboard.ts:505`) shows a question count badge but no error count badge. The error count is only visible when the ERRORS pane is active.

**File:** `src/tui/dashboard.ts:505–530` (`StatusBarComponent.render`)

**Impact:** Users miss new errors unless they happen to be on the ERRORS pane. Combined with G-03 (no pane skip for empty ERRORS), there's no pull to check the pane.

**Complexity:** Low. Add `errorCount` to `StatusBarComponent`. In `modeLine`, append `${RED}[${count} errors]${RESET}` next to the question badge when `errorCount > 0`. `DashboardComponent.addError()` should update `statusBar.errorCount`; `clearErrors()` should reset it.

---

#### G-08: Scroll direction inconsistency for DIFF and ERRORS panes

**ib watch:** DIFF and ERRORS panes scroll from **top** (like a normal file viewer — scroll down to see more). DENIALS and TREE scroll from bottom. QUESTIONS scrolls from top.

**itsybitsy:** `RightPaneComponent.render()` (`src/tui/dashboard.ts:370`) always uses bottom-anchored scroll (`content.length - available - scrollOffset`) regardless of mode. This means DIFF starts at the **end** of the output rather than the beginning.

**File:** `src/tui/dashboard.ts:370–393` (`RightPaneComponent.render`)

**Impact:** DIFF pane opens showing the end of the diff instead of the file/commit header — requires scrolling backward to get context. ERRORS pane shows newest error last.

**Complexity:** Low-Medium. Define `TOP_ANCHORED_MODES = new Set(["DIFF", "ERRORS", "STATUS", "QUESTIONS"])` and branch in `render()`: top-anchored uses `scrollOffset` as a direct start index; bottom-anchored keeps the current behavior.

---

#### G-09: TREE pane missing prompt column

**ib watch:** Full-width TREE pane shows: `connector + name | state | age | model | prompt`.

**itsybitsy:** TREE pane content (`src/tui/dashboard.ts:308–314`) renders: `indent + icon + repo/id | state | age | model` — the prompt column is absent.

**File:** `src/tui/dashboard.ts:308–314`

**Impact:** The TREE pane is less useful without the prompt, which is the primary way to understand what each agent is doing.

**Complexity:** Low. Append `agent.meta.prompt.replace(/\n/g, " ").slice(0, 40)` to each TREE row, respecting available width.

---

#### G-10: Terminal title not set

**ib watch:** Sets terminal window/tab title to `ib watch: <agent-name>` via `\e]0;...\a` on each frame.

**itsybitsy:** No terminal title is set. `process.stdout.write` is never called with an OSC sequence.

**File:** `src/tui/dashboard.ts` — `syncSelectedAgent()` or `render()`

**Impact:** Users with multiple terminal tabs can't identify which has the dashboard or which agent is selected.

**Complexity:** Low. In `syncSelectedAgent()`, emit `process.stdout.write(\`\x1b]0;itsybitsy: ${selected?.id ?? 'no agent'}\x07\`)`.

---

#### G-11: Minimum terminal size enforcement missing

**ib watch:** Requires 20 rows × 80 columns. Shows a warning message if the terminal is too small.

**itsybitsy:** `render()` checks `process.stdout.rows` for height (`src/tui/dashboard.ts:1792`) but does not enforce a minimum or warn the user.

**File:** `src/tui/dashboard.ts:1765` — `render()`

**Impact:** Very small terminals produce garbled/truncated output with no explanation.

**Complexity:** Low. At the top of `render()`, if `process.stdout.rows < 20 || width < 80`, return a single warning line instead of the full render.

---

#### G-12: Creating state detection wrapper missing

**ib watch:** `compute_state_from_content()` (line 4667) wraps `parse_state()` with two pre-checks: (1) scan first 100 lines for Claude startup indicators; (2) if fewer than 10 output lines and no startup indicators found, return `"creating"`.

**itsybitsy:** `detectAgentStates()` (`src/agents.ts:219`) calls `parseState()` directly on the raw captured output. The `< 10 lines` heuristic and first-100-lines startup check are absent.

**File:** `src/agents.ts:229–234`

**Impact:** Newly spawned agents briefly show as `"unknown"` instead of `"creating"`. Minor lifecycle display issue.

**Complexity:** Low. Add a wrapper `detectState(output: string): AgentState` that: counts non-empty lines; if < 10 and no Claude logo markers present, returns `"creating"`; otherwise delegates to `parseState()`.

---

### P2 — Low Impact / Polish

#### G-13: Scroll step size 5 vs ib's 10 lines

**ib watch:** Each `;`/`l` press scrolls 10 lines.

**itsybitsy:** `handleScrollUp/Down()` (`src/tui/dashboard.ts:1177–1188`) scrolls 5 lines.

**File:** `src/tui/dashboard.ts:1178,1179,1185,1186`

**Complexity:** Low. Change the `5` constants to `10`, or make it a named constant `SCROLL_STEP = 10`.

---

#### G-14: Denial filter intervals differ from ib

**ib watch:** Time filter cycles: `active only` / `24h` / `7d`.

**itsybitsy:** Filter cycles: `all` / `1h` / `10m` (`src/tui/dashboard.ts:120–121`).

**File:** `src/tui/dashboard.ts:120` — `DENIAL_FILTERS`

**Impact:** Minor UX difference. Both provide time filtering, but the intervals don't match ib's. Users switching between tools may expect `24h`/`7d` options.

**Complexity:** Low. Change `DENIAL_FILTERS` to `["all", "24h", "7d"]` and update `filterDenials()` cutoff math. Consider `active` filter (last session only) as a stretch goal.

---

#### G-15: Tree connector style (↳ vs box-drawing)

**ib watch:** Uses traditional box-drawing connectors: `├──`, `└──`, `│` for multi-level trees.

**itsybitsy:** `formatAgentRow()` (`src/tui/dashboard.ts:139`) uses `"  ".repeat(depth) + "↳ "` — a simpler single-level indent indicator that doesn't show parent-child relationships visually for deeper trees.

**File:** `src/tui/dashboard.ts:139`

**Impact:** For trees more than 2 levels deep, the `↳` style makes it hard to see which parent a deep worker belongs to. Box-drawing connectors (`│` on parent lines) make the hierarchy unambiguous.

**Complexity:** Medium. Need to thread knowledge of sibling presence from `flattenAgentTree()` into `formatAgentRow()` — currently only `depth` is passed. The `FlatAgent` type would need an `isLastChild` flag, or pre-compute the connector string in `flattenAgentTree()`.

---

#### G-16: Update checker not implemented

**ib watch:** Background process checks GitHub releases once per hour; shows red notification in footer with clickable OSC-8 hyperlink if update available.

**itsybitsy:** No update checking.

**Complexity:** Low. Periodic `fetch()` to `https://api.github.com/repos/.../releases/latest` + conditional footer text. Not critical since itsybitsy is a different project with different release cadence.

---

## Summary Table

| ID | Description | Priority | Complexity | File |
|----|-------------|----------|------------|------|
| G-01 | All-agent state polling (only selected polled) | P0 | Medium | `src/tmux-poller.ts`, `src/agents.ts` |
| G-02 | State detection capture depth (100 vs 500 lines) | P0 | Low | `src/tmux-poller.ts:89` |
| G-03 | Pane cycling skips empty ERRORS/QUESTIONS | P1 | Low | `src/tui/dashboard.ts:1584` |
| G-04 | Diff colorization missing | P1 | Low | `src/tui/dashboard.ts:1541` |
| G-05 | Agent log colorization missing | P1 | Low | `src/tui/dashboard.ts:1513` |
| G-06 | Orphaned worker indicator missing | P1 | Low | `src/agents.ts:158`, `src/tui/dashboard.ts:133` |
| G-07 | Error count badge missing from footer | P1 | Low | `src/tui/dashboard.ts:505` |
| G-08 | Scroll direction wrong for DIFF/ERRORS (top vs bottom) | P1 | Low-Med | `src/tui/dashboard.ts:370` |
| G-09 | TREE pane missing prompt column | P1 | Low | `src/tui/dashboard.ts:308` |
| G-10 | Terminal title not set | P1 | Low | `src/tui/dashboard.ts` |
| G-11 | Minimum terminal size not enforced | P1 | Low | `src/tui/dashboard.ts:1765` |
| G-12 | Creating state detection wrapper missing | P1 | Low | `src/agents.ts:229` |
| G-13 | Scroll step 5 vs ib's 10 | P2 | Low | `src/tui/dashboard.ts:1178` |
| G-14 | Denial filter intervals differ from ib | P2 | Low | `src/tui/dashboard.ts:120` |
| G-15 | Tree connector style (↳ vs box-drawing) | P2 | Medium | `src/tui/dashboard.ts:139` |
| G-16 | Update checker not implemented | P2 | Low | N/A |

---

## Features itsybitsy Has That ib watch Does NOT

These are intentional itsybitsy improvements — noted here to confirm they are working and not gaps:

| Feature | Key | Notes |
|---------|-----|-------|
| Multi-repo support | — | Registry system; agents from all repos in one dashboard |
| Ghostty integration | `G` | Opens selected agent's tmux session in Ghostty window |
| Command palette | `/` | Fuzzy-searchable list of all commands |
| Textarea for send message | `s` | Multi-line input with Tab focus cycling |
| Resume agent | `R` | `ib resume` without leaving the dashboard |
| Question acknowledge | `Esc` in QUESTIONS | Dismiss without answering |
| ANSI-aware line wrapping | — | `wrapLines()` handles wide chars, skips escape sequences |
| `fs.watch` for instant updates | — | Structural changes reflected immediately |
| Archived agent toggle | `A` | Show/hide archived agents in tree |
| Debug snapshot | `S` | Saves tmux capture + parsed state to debug-logs/ |

---

## Keyboard Shortcut Parity Check

### Shortcuts in ib watch NOT in itsybitsy

| Key | ib action | itsybitsy |
|-----|-----------|-----------|
| `h` | Open settings/setup dialog | Opens **help overlay** (different purpose) |

itsybitsy's `h` key opens a help overlay which is arguably more useful. ib's settings dialog (dialog mode 6) covers use cases handled differently in itsybitsy (registry config, diffTool, etc.). No action needed.

### All other ib watch shortcuts are implemented

| Key | Action | Status |
|-----|--------|--------|
| `j`/`k` / arrows | Select agent (or navigate questions pane) | Implemented |
| `@` | Fuzzy agent jump | Implemented |
| `/` | Fuzzy command/panel jump | Implemented (command palette) |
| `p`/`n` / left/right | Cycle pane mode (counterintuitive arrow mapping preserved) | Implemented |
| `;`/`l` | Scroll both panes | Implemented |
| `d` | Jump to DIFF pane | Implemented |
| `g` | Jump to STATUS pane (or go-to-agent in QUESTIONS) | Implemented |
| `e` | Jump to ERRORS pane | Implemented |
| `q` | Jump to QUESTIONS pane | Implemented |
| `t` | Toggle denial time filter | Implemented |
| `c` | Clear errors (in ERRORS pane) | Implemented |
| `s` | Send message | Implemented (textarea) |
| `m` | Merge | Implemented |
| `x` | Kill | Implemented |
| `!` | Nuke | Implemented |
| `a` | New agent | Implemented |
| `r` | Reassign | Implemented |
| `w` | Open worktree in Finder | Implemented |
| `o` | Open diff in external tool | Implemented |
| `S` | Debug snapshot | Implemented |
| Enter | Answer question (QUESTIONS pane) | Implemented |
| Ctrl-C | Exit | Implemented |

---

## Pane Mode Implementation Status

| Mode | Index | Full-width | Status | Notes |
|------|-------|------------|--------|-------|
| AGENT LOG | 0 | No | Working | Loaded async on agent select |
| INITIAL PROMPT | 1 | No | Working | Loaded async, trims to `[USER TASK]` marker |
| DENIALS | 2 | Yes | Working | Parsed from log, time filter works |
| TREE | 3 | Yes | Partial | Missing prompt column (G-09); missing box-drawing connectors (G-15) |
| ERRORS | 4 | Yes | Partial | Missing error badge in footer (G-07); scroll from bottom instead of top (G-08) |
| DIFF | 5 | Yes | Partial | No colorization (G-04); scroll starts at bottom not top (G-08) |
| STATUS | 6 | No | Working | Loaded on demand via `g`/`d` key |
| QUESTIONS | 7 | Yes | Working | j/k nav, Enter to answer, Esc to acknowledge, g to go-to-agent |

---

## Dialog System Comparison

| ib dialog mode | itsybitsy equivalent | Status |
|----------------|---------------------|--------|
| 0 — None | `null` dialog | Implemented |
| 1 — Send message | `textarea` dialog | Implemented (richer — multi-line) |
| 2 — Kill agent | `confirm` dialog | Implemented |
| 3 — Nuke all agents | `confirm` dialog | Implemented |
| 4 — New agent | `select` → `input` → `select` flow | Implemented |
| 5 — Agent jump (fuzzy) | `fuzzy` dialog | Implemented |
| 6 — Setup/Settings | Help overlay (`help` dialog) | Partial — different purpose |
| 7 — Merge | `confirm` dialog after merge-check | Implemented |
| 8 — External diff tool | Inline handler (no dialog) | Implemented (skips dialog) |
| 9 — Command jump (fuzzy) | `fuzzy` dialog (command palette) | Implemented |
| 10 — Feedback | N/A | Not applicable to itsybitsy |
| 11 — Number input | `input` dialog | Covered by generic input |
| 12 — String input | `input` dialog | Covered by generic input |
| 13 — Permissions editor | Not implemented | Low priority, niche feature |
| 14 — Answer question | `input` dialog | Implemented |
| 15 — Reassign | `input` dialog | Implemented |

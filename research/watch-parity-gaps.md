# ib watch vs itsybitsy — Parity Gap Analysis

Comprehensive comparison of the original bash `ib watch` (lines 14793-22954 in `~/Developer/bash/ittybitty/ib`) against the TypeScript itsybitsy reimplementation. Gaps are prioritized by user-facing impact.

---

## 1. Missing in itsybitsy (ib watch has, itsybitsy does NOT)

### P0 — High Impact

#### 1.1 Tmux polling for ALL agents (state detection)

**ib watch:** Background monitor (150ms) captures tmux pane output for **every** agent, computes and caches state in `.state` files. This means the agent tree always shows accurate, up-to-date states for all agents simultaneously.

**itsybitsy:** `TmuxPoller` only polls the **selected** agent at 1s intervals. State detection for all agents happens in `detectAgentStates()` during `watcher.refresh()`, which runs on fs.watch events (debounced 200ms) or the 10s fallback poll. Between refreshes, states can be stale for up to 10 seconds.

**Where in ib:** Session monitor background subshell, lines 22701-22775. `compute_state_from_content()` at line 4667.

**Impact:** Users see stale states in the tree — an agent could complete or error out and the tree won't update for seconds. This is especially noticeable with many agents.

**Complexity:** Medium. Need a background polling loop that cycles through agents for state capture independently of the selected-agent display poll. Could do round-robin: poll 2-3 agents per second.

---

#### 1.2 Tmux capture depth (500 vs 100 lines)

**ib watch:** Captures 500 lines (`-S -500`) for display and state detection in the background monitor.

**itsybitsy:** `TmuxPoller` captures 100 lines (`-S -100`) for display. `captureTmuxOutput()` captures only 20 lines for state detection.

**Where in ib:** Line 22730: `tmux capture-pane -t "$tmux_session" -p -S -500 -E -`

**Impact:** 20 lines may miss state indicators that scrolled past (e.g., a WAITING that's 25 lines up). 100 lines for display means less scroll-back available.

**Complexity:** Low. Change the `-S` parameter. The 20-line state capture is the riskier gap — increase to at least 50-100.

---

#### 1.3 Usage tracking / API quota display

**ib watch:** Fetches Claude API usage percentages (session and weekly), displays in footer. Color-coded: >80% yellow, >90% red. Includes reset time. Refreshed every 30 seconds.

**itsybitsy:** No usage tracking at all.

**Where in ib:** Footer rendering in `watch_render_footer()`. Usage refresh logic in main loop.

**Impact:** Users have no visibility into API quota consumption while monitoring agents. This is critical for managing costs and avoiding unexpected rate limits.

**Complexity:** Medium. Need to determine how ib fetches usage data (likely via Claude API or a local cache file), then add a periodic fetch + footer display.

---

#### 1.4 Update checker

**ib watch:** Background process checks GitHub releases once per hour. Shows red notification in footer with OSC 8 hyperlink if update available.

**itsybitsy:** No update checking.

**Where in ib:** Update checker background process, spawned at startup.

**Impact:** Low-medium. Users won't know when a new version is available. Less critical for itsybitsy since it's a separate tool, but still useful.

**Complexity:** Low. Periodic `fetch()` to GitHub releases API + conditional footer text.

---

#### 1.5 Denials pane: full-width display

**ib watch:** DENIALS mode hides the tmux left pane and uses the full terminal width for denial content. Same for TREE, ERRORS, DIFF, STATUS, and QUESTIONS modes.

**itsybitsy:** All modes appear to render in the right pane of the split view. The analysis doesn't mention any full-width modes.

**Where in ib:** `watch_render_split_panes()` lines 21610-21778, with full-width mode checks.

**Impact:** Diff output, denial logs, and tree views are cramped in half the terminal width. Diff especially needs full width to be readable.

**Complexity:** Medium. Need to make the `SplitPane` component conditionally hide the left pane for certain modes. The dashboard render logic needs to detect full-width modes and pass full width to the right pane.

---

#### 1.6 Diff colorization

**ib watch:** Diff output is colorized: green for additions, red for removals, dim for headers. Also shows merge status indicator (conflicts, uncommitted changes).

**itsybitsy:** Runs `ib diff` and displays raw output. No mention of colorization or merge status parsing.

**Where in ib:** Diff rendering in right pane mode 5.

**Impact:** Raw diff output is harder to scan. Missing merge status means users can't see at a glance whether a merge will be clean.

**Complexity:** Low-medium. Parse diff output lines and add ANSI color codes. Merge status may come from `ib diff` output or need a separate check.

---

#### 1.7 Denials background collector with time filtering

**ib watch:** Denials are collected by a background subshell that runs every 10 seconds, scanning agent logs. Supports time filters: active only / 24h / 7d (toggled with `t`).

**itsybitsy:** Parses denials from agent log synchronously via `parseDenials()`. Time filter options are `all` / `1h` / `10m` — different granularity from ib's `active` / `24h` / `7d`.

**Where in ib:** Background denials collector, time filter toggle at `t` key.

**Impact:** Minor functional difference — itsybitsy has time filtering, just with different intervals. The background collection difference matters more for performance with large logs.

**Complexity:** Low. Adjust filter intervals if exact parity desired.

---

#### 1.8 Snapshot capture (`S` key)

**ib watch:** `S` captures a tmux snapshot for debugging — saves raw tmux output to a file for later analysis.

**itsybitsy:** `S` saves a debug snapshot (tmux output + parsed state). Appears functionally equivalent based on the keyboard shortcuts table.

**Where in ib:** Snapshot handling in key processing.

**Impact:** Likely at parity. Both save debug snapshots. Verify output format matches.

**Complexity:** N/A (likely already implemented).

---

### P1 — Medium Impact

#### 1.9 Creating state detection (pre-Claude startup)

**ib watch:** `compute_state_from_content()` (line 4667) has a two-tier architecture. Before calling `parse_state()`, it checks the first 100 lines for Claude startup indicators ("Claude Code v", "[USER TASK]", etc.). If not found and fewer than 10 lines, returns "creating". This catches agents that haven't fully started yet.

**itsybitsy:** `parseState()` handles creating state detection inline (checking for permission prompts before Claude logo). But the `compute_state_from_content()` wrapper with its first-100-lines check and <10-lines heuristic appears absent — `detectAgentStates()` calls `parseState()` directly.

**Where in ib:** `compute_state_from_content()` lines 4667-4718.

**Impact:** Newly spawned agents may briefly show as "unknown" instead of "creating" until Claude's startup screen appears. This affects the user's understanding of agent lifecycle.

**Complexity:** Low. Add a wrapper around `parseState()` that checks for startup indicators in the first N lines.

---

#### 1.10 Round-robin state refresh optimization

**ib watch:** Main render loop does round-robin state refresh: only 1 agent gets a direct `get_state()` call per 5 frames. Combined with background monitor caching, this keeps the hot path fast.

**itsybitsy:** `detectAgentStates()` captures tmux for ALL active agents in parallel on every `refresh()`. No caching or round-robin.

**Where in ib:** Round-robin in main loop, state caching in `build_agent_data_file()` lines 6196-6250.

**Impact:** With many agents (10+), parallel tmux captures on every refresh could cause latency spikes. The 10s fallback poll makes this less critical since fs.watch triggers most refreshes.

**Complexity:** Medium. Add a state cache with TTL. On each refresh, only re-poll a subset of agents. Always poll the selected agent.

---

#### 1.11 Meta.json caching with stable optimization

**ib watch:** Multi-level cache for meta.json: tracks modification time, and after 30 frames without change, skips `stat()` call entirely. O(1) index lookup strings.

**itsybitsy:** `readAllAgents()` re-reads all meta.json files from disk on every refresh. No caching.

**Where in ib:** `META_CACHE_IDS[]`, `META_CACHE_DATA[]`, `META_CACHE_MTIME[]`, `META_CACHE_STABLE[]` in `build_agent_data_file()` lines 6000-6098.

**Impact:** Minor performance difference. `Bun.file()` reads are fast, and refreshes are infrequent (fs.watch debounced + 10s poll). Would matter more with 50+ agents.

**Complexity:** Medium. Add an in-memory cache keyed by agent ID with mtime checks.

---

#### 1.12 Agent log colorization

**ib watch:** Agent log lines are colorized: ISO timestamps dimmed, `[brackets]` in cyan.

**itsybitsy:** Agent log content is displayed but no mention of colorization.

**Where in ib:** Log rendering in right pane mode 0, with COLOR_DIM and COLOR_CYAN.

**Impact:** Cosmetic, but log readability is significantly improved with color. Timestamps being dimmed lets users focus on content.

**Complexity:** Low. Simple regex replacements on log lines before display.

---

#### 1.13 External diff tool (`o` key)

**ib watch:** `o` opens an external diff tool (configurable). Has a dedicated dialog mode (mode 8).

**itsybitsy:** `o` key listed in shortcuts as "Open diff in configured external tool". Registry stores `diffTool`. Appears partially implemented.

**Where in ib:** Dialog mode 8 for external diff tool.

**Impact:** Verify implementation completeness. The registry support exists; need to confirm the dialog and tool invocation work end-to-end.

**Complexity:** Low (if already partially implemented).

---

#### 1.14 Orphaned worker indicator

**ib watch:** Workers whose manager no longer exists get an orphan warning prefix in the tree.

**itsybitsy:** No mention of orphan detection or display.

**Where in ib:** `build_tree_lines()` lines 6346-6506, orphan prefix logic.

**Impact:** Users can't tell at a glance if a worker lost its manager. Important for debugging stuck agent hierarchies.

**Complexity:** Low. In `buildAgentTree()`, if `agent.meta.manager` is set but not found in the agent map, mark as orphaned. Add visual indicator in tree row formatting.

---

#### 1.15 Pane skipping (empty panes)

**ib watch:** `watch_calc_next_pane()` (lines 15263-15283) skips ERRORS pane when no errors exist, and skips QUESTIONS pane when no questions exist.

**itsybitsy:** No mention of pane skipping logic.

**Where in ib:** `watch_calc_next_pane()` lines 15263-15283.

**Impact:** Users cycle through empty panes unnecessarily. Minor annoyance but adds friction.

**Complexity:** Low. Add skip conditions in `cyclePaneMode()`.

---

#### 1.16 Terminal title

**ib watch:** Sets terminal title via `\e]0;ib watch: agent-name\a` — shows current agent in tab/window title bar.

**itsybitsy:** No mention of terminal title setting.

**Where in ib:** Title setting in render loop.

**Impact:** When switching between terminal tabs, users can't identify which has the watch dashboard or which agent is selected.

**Complexity:** Low. Single `process.stdout.write('\x1b]0;itsybitsy: ' + agentId + '\x07')` call on selection change.

---

#### 1.17 Minimum terminal size enforcement

**ib watch:** Requires 20 rows x 80 columns minimum. Shows warning if too small.

**itsybitsy:** No mention of minimum size checking.

**Where in ib:** Size validation in `watch_render()`.

**Impact:** Small terminals could produce garbled output. Low probability but easy to guard against.

**Complexity:** Low. Check `process.stdout.rows` and `process.stdout.columns` at render time.

---

### P2 — Low Impact

#### 1.18 FPS control / frame rate management

**ib watch:** Target 10 FPS with rolling 3-frame render time average. Configurable via `CONFIG_FPS`. Sleep to hit target.

**itsybitsy:** Event-driven via pi-tui. Renders on `invalidate()` / `requestRender()`. No explicit FPS control.

**Where in ib:** Frame rate control in main loop, lines 22824-22953.

**Impact:** Event-driven is actually better architecturally — renders only when needed. No gap here unless excessive rendering causes performance issues.

**Complexity:** N/A. Event-driven approach is arguably superior.

---

#### 1.19 Debug mode (`--debug`)

**ib watch:** Timing instrumentation for all render phases. Auto-exits after 100 frames. Shows timing summary (averages, min, max per operation).

**itsybitsy:** No debug/profiling mode.

**Where in ib:** Debug mode flag and timing at lines 22824ff.

**Impact:** Useful for development/optimization only. Not user-facing.

**Complexity:** Low-medium. Add `--debug` flag, wrap render phases with `performance.now()` measurements.

---

#### 1.20 Feedback dialog

**ib watch:** Shown after 3 frames on certain sessions. One-time trigger for collecting user feedback.

**itsybitsy:** No feedback dialog.

**Where in ib:** Dialog mode 10.

**Impact:** None for end users. itsybitsy is a different project and wouldn't use ib's feedback flow.

**Complexity:** N/A. Not needed.

---

#### 1.21 Permissions editor dialog

**ib watch:** Dialog mode 13 for editing agent permissions.

**itsybitsy:** No permissions editor.

**Where in ib:** Dialog mode 13.

**Impact:** Users must edit permissions outside the dashboard. Niche feature.

**Complexity:** Medium. Need to understand ib's permission model and build a dialog for it.

---

#### 1.22 Number input / String input dialogs

**ib watch:** Dedicated dialog modes 11 (number input) and 12 (string input) as generic reusable primitives.

**itsybitsy:** Has `input` and `textarea` dialog types which cover the same use cases.

**Where in ib:** Dialog modes 11, 12.

**Impact:** None. itsybitsy's dialog system is more flexible with typed dialog variants.

**Complexity:** N/A. Already at parity via different design.

---

#### 1.23 Setup/Settings dialog (`h` key)

**ib watch:** `h` opens a setup/settings dialog (dialog mode 6).

**itsybitsy:** `h` shows a help overlay. No settings dialog.

**Where in ib:** Dialog mode 6.

**Impact:** Users can't configure settings from within the dashboard. Low impact since most settings can be managed via CLI or config files.

**Complexity:** Medium. Need to define what settings are configurable and build the dialog.

---

#### 1.24 Scroll step size (10 vs 5 lines)

**ib watch:** Scroll step is 10 lines per `;`/`l` keypress.

**itsybitsy:** Scroll step is 5 lines per keypress.

**Where in ib:** Scroll handling in key processing.

**Impact:** Minor UX difference. 5 lines may actually be better for precision. Consider making configurable.

**Complexity:** Low. Change a constant.

---

#### 1.25 Agent log pre-wrapping in background

**ib watch:** Background monitor pre-wraps agent logs (`tail -200 | fold -w`) and caches them. Parsed every 7 frames or on agent change.

**itsybitsy:** Reads agent log async on agent selection change. Wrapping done at render time.

**Where in ib:** Background monitor log caching, lines 22762-22770.

**Impact:** Potential jank when switching to an agent with a large log file, since wrapping happens synchronously in the render path.

**Complexity:** Low-medium. Could pre-wrap in the async load phase or cache wrapped results.

---

#### 1.26 Tree: max 5 vs 7 visible rows

**ib watch:** Max 5 visible tree rows.

**itsybitsy:** Max 7 visible tree rows.

**Where in ib:** Tree scrolling logic, lines 21023-21046.

**Impact:** itsybitsy shows more agents at once, which is arguably better. Not a gap — intentional improvement.

**Complexity:** N/A.

---

#### 1.27 Agent name truncation to 30 chars

**ib watch:** Agent names truncated to 30 chars with `...` in tree display.

**itsybitsy:** Truncation based on available width (responsive).

**Where in ib:** `build_tree_lines()` line formatting.

**Impact:** itsybitsy's approach is better — adapts to terminal width.

**Complexity:** N/A.

---

---

## 2. itsybitsy has, ib watch does NOT

### 2.1 Multi-repo support

**itsybitsy:** Registry system (`~/.itsybitsy.json`) tracks multiple repos. Dashboard shows agents from all registered repos with `repo/agent-id` prefixed naming.

**ib watch:** Single repo only — monitors the current directory's `.ittybitty/agents/`.

**Impact:** Major feature. Users managing agents across multiple projects see everything in one dashboard.

---

### 2.2 Ghostty integration (`G` key)

**itsybitsy:** `G` opens the selected agent's tmux session in a new Ghostty terminal window. Session name validated to prevent injection.

**ib watch:** No Ghostty integration.

**Impact:** Quick access to agent terminals without manual `tmux attach`.

---

### 2.3 Command palette (`/` key)

**itsybitsy:** `/` opens a fuzzy-searchable command palette listing all available commands.

**ib watch:** `/` opens fuzzy jump to command/panel — similar but may be less comprehensive.

**Impact:** Discoverability. New users can find all commands without memorizing keys.

---

### 2.4 Textarea dialog for send message

**itsybitsy:** Multi-line text input with Tab focus cycling, visual line wrapping, cursor display. Proper editing experience.

**ib watch:** Send message dialog (mode 1) — likely single-line or simpler input.

**Impact:** Better UX for composing longer messages to agents.

---

### 2.5 Resume agent (`R` key)

**itsybitsy:** `R` resumes stopped/complete agents via `ib resume`.

**ib watch:** Not listed in keyboard shortcuts. Resume may require exiting watch.

**Impact:** Workflow efficiency — resume without leaving the dashboard.

---

### 2.6 Question acknowledgment (`Esc` in QUESTIONS pane)

**itsybitsy:** `Esc` acknowledges/dismisses a question via `ib acknowledge`.

**ib watch:** Enter to answer, `g` to go to agent. No explicit acknowledge/dismiss.

**Impact:** Users can clear questions they don't want to answer.

---

### 2.7 pi-tui overlay system for dialogs

**itsybitsy:** Uses pi-tui's native overlay system with proper centering and z-ordering.

**ib watch:** Box-drawing character dialogs rendered inline in the status bar area.

**Impact:** Cleaner dialog rendering, no interference with the main content area.

---

### 2.8 ANSI-aware line wrapping

**itsybitsy:** `wrapLines()` / `wrapSingleLine()` are fully ANSI-aware — skip escape sequences for width calculation, handle wide characters (CJK, emoji).

**ib watch:** `_fold_text()` and `fold -w` are simpler. The pure-bash `_fold_text()` may break ANSI sequences at wrap boundaries.

**Impact:** Better rendering fidelity for tmux output containing colors and special characters.

---

### 2.9 fs.watch for instant structural updates

**itsybitsy:** Uses `fs.watch` on agent directories for near-instant response to agent creation/deletion/metadata changes. 200ms debounce.

**ib watch:** Background monitor at 150ms polls everything. No filesystem events.

**Impact:** More responsive to structural changes while using less CPU (event-driven vs polling).

---

---

## 3. Parity Items (Both implement, possibly differently)

| Feature | ib watch | itsybitsy | Notes |
|---------|----------|-----------|-------|
| **State detection** | `parse_state()` + `compute_state_from_content()` | `parseState()` | Same priority order. itsybitsy missing the `compute_state_from_content` wrapper (see 1.9) |
| **Agent tree** | Box-drawing connectors, 5 rows max | Arrow/icon connectors, 7 rows max | Different visual style, both functional |
| **Split pane** | Manual printf, 60-col left | `SplitPane` component, 60-col left | Same layout, different implementation |
| **Scroll** | Shared offset, 10-line steps | Shared offset, 5-line steps | Same model, different step size |
| **Kill/Nuke** | `x` / `!` keys | `x` / `!` keys | Same |
| **Merge** | `m` key, merge-check then confirm | `m` key, merge-check then confirm | Same flow |
| **Send message** | `s` key | `s` key with textarea | itsybitsy's is richer |
| **New agent** | `a` key | `a` key, multi-step dialog | Same |
| **Fuzzy agent jump** | `@` key | `@` key | Same |
| **Pane cycling** | `p`/`n`, arrows | `p`/`n`, arrows | Same (counterintuitive arrow mapping preserved) |
| **Diff pane** | `d` key, full-width, colorized | `d` key, right pane, no color | Gap: see 1.5, 1.6 |
| **Status pane** | `g` key | `g` key | Same |
| **Questions pane** | `q` key, j/k nav, Enter to answer | `q` key, j/k nav, Enter/Esc | itsybitsy adds Esc dismiss |
| **Denials pane** | Full-width, time filter (active/24h/7d) | Right pane, time filter (all/1h/10m) | Different filters, see 1.5, 1.7 |
| **Errors pane** | `e` key, `c` to clear | `e` key, `c` to clear | Same |
| **Tree pane** | Full-width | Right pane | Gap: see 1.5 |
| **Help** | `h` opens setup dialog | `h` opens help overlay | Different purpose |
| **Reassign** | `r` key | `r` key | Same |
| **Archived toggle** | Not documented | `A` key | itsybitsy addition |
| **Open in Finder** | `w` key | `w` key | Same |
| **State colors** | Inline in render | `STATE_COLORS` map | Same states, same concept |
| **ANSI stripping** | `_strip_ansi()` pure bash | `stripAnsi()` regex | Same purpose |
| **Hook spinner filtering** | `filter_hook_spinners()` | `filterHookSpinners()` | Same logic |

---

## 4. Prioritized Implementation Backlog

| Priority | Item | Complexity | Description |
|----------|------|------------|-------------|
| P0 | Full-width pane modes | Medium | DIFF, DENIALS, TREE, ERRORS, QUESTIONS should hide left pane |
| P0 | All-agent state polling | Medium | Poll all agents for state, not just selected |
| P0 | Increase tmux capture depth | Low | State detection: 20->100 lines. Display: 100->500 lines |
| P0 | Usage tracking display | Medium | Fetch API quota, show in footer with color coding |
| P1 | Diff colorization | Low | Green additions, red removals, dim headers |
| P1 | Creating state wrapper | Low | Pre-parseState check for <10 lines or missing Claude startup |
| P1 | Agent log colorization | Low | Dim timestamps, cyan brackets |
| P1 | Orphaned worker indicator | Low | Detect and mark workers with missing managers |
| P1 | Pane skipping | Low | Skip empty ERRORS/QUESTIONS panes |
| P1 | Terminal title | Low | Set window title to current agent |
| P1 | Min terminal size | Low | Warn if < 20x80 |
| P2 | State caching / round-robin | Medium | Cache states, refresh subset per cycle |
| P2 | Meta.json caching | Medium | Skip re-reads for unchanged files |
| P2 | Debug/profiling mode | Low-Medium | `--debug` flag with timing instrumentation |
| P2 | Update checker | Low | Periodic GitHub release check |
| P2 | Log pre-wrapping | Low-Medium | Wrap during async load, not render |
| P2 | Scroll step size | Low | Make configurable or match ib's 10 lines |
| -- | Feedback dialog | N/A | Not applicable to itsybitsy |
| -- | Permissions editor | Medium | Low priority, niche feature |

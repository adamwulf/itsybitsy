# ib watch - Deep Implementation Analysis

This document provides a detailed technical analysis of the `ib watch` command from the `ib` bash script (`~/Developer/bash/ittybitty/ib`), starting at line 14793. The analysis is intended for comparison against the itsybitsy TypeScript reimplementation.

---

## 1. Architecture Overview

`cmd_watch()` is a single massive bash function (~8,200 lines, lines 14793-22954) that contains:
- All state variables as locals
- Nested helper functions (defined inside `cmd_watch`)
- A main render loop with key processing
- Background subshell processes for I/O

### Background Processes

The watch command spawns **4 background processes**:

1. **Key reader** - reads from `/dev/tty` one char at a time, writes to a temp file
2. **Session monitor** - polls tmux every 150ms, captures pane output, computes agent states, caches wrapped logs
3. **Update checker** - checks for new ib releases once per hour
4. **Denials/diff/status collectors** - started/stopped on demand when switching pane modes

```bash
# Key reader (lines 22666-22684)
(
    exec < /dev/tty 2>/dev/null
    while true; do
        if ! IFS= read -rsn1 k 2>/dev/null; then break; fi
        if [[ -z "$k" ]]; then
            printf '\x1e' >> "$keyfile"  # Enter = record separator marker
        else
            printf "%s" "$k" >> "$keyfile"
        fi
    done
) &

# Session monitor (lines 22701-22775)
(
    while true; do
        # 1. Update heartbeat timestamp
        # 2. List tmux sessions -> write to sessionfile
        # 3. For each agent: capture-pane -S -500 -E -, strip ANSI, write to cache
        # 4. Compute state from content, write to .state file
        # 5. Cache wrapped agent logs (tail -200, fold -w)
        sleep 0.15
    done
) &
```

---

## 2. State Detection Logic

### Overview

State detection has a two-tier architecture:

1. **`compute_state_from_content()`** (line 4667) - called by background monitor, handles "creating" detection from first 100 lines
2. **`parse_state()`** (line 4766) - core pattern matching on last N lines of tmux output

### States

| State | Meaning |
|-------|---------|
| `running` | Agent is actively executing (tool call, thinking, etc.) |
| `waiting` | Agent is idle, waiting for input |
| `complete` | Agent said "I HAVE COMPLETED THE GOAL" |
| `compacting` | Agent is compacting conversation |
| `rate_limited` | Hit API rate limits |
| `creating` | Claude hasn't fully started yet (permission prompts, loading) |
| `stopped` | tmux session doesn't exist |
| `unknown` | No clear indicators found |

### parse_state() Priority Order (lines 4766-5042)

The priority order is critical - higher items override lower ones:

```
1. Creating state - permission prompts before Claude starts (lines 4786-4802)
   Pattern: "Enter to confirm" + ("trust" | "Allow external CLAUDE.md")
   Condition: Only when Claude logo NOT present

2. Compacting (last 5 lines) (lines 4826-4829)
   Pattern: "Compacting conversation" in very_recent (last 5)

3. Tool waiting (last 15 lines) (lines 4838-4842)
   Pattern: ⎿ followed by whitespace + "Waiting"

4. Active running (last 5 lines) (lines 4844-4858)
   Pattern: "(Esc to interrupt" | "(ctrl+c to interrupt" | "⎿  Running"
   Note: Requires opening paren to distinguish from discussion text

5. Rate limited (last 15 lines) (lines 4862-4887)
   Patterns: "rate_limit_error" | "usage limit reached" | "hit your limit" | "/upgrade"
   Case-insensitive for usage limit patterns

6. Complete (last 15 lines) (lines 4889-4898)
   Pattern: "I HAVE COMPLETED THE GOAL" (excluding single-quoted occurrences)
   ```bash
   local lines_unquoted="${last_lines//"'I HAVE COMPLETED THE GOAL'"/}"
   if [[ "$lines_unquoted" == *'I HAVE COMPLETED THE GOAL'* ]]; then
   ```

7. WAITING (last 15 lines) (lines 4900-4924)
   Pattern: WAITING as standalone word on own line (indented or with ⏺ marker)
   ```bash
   if [[ "$last_lines" =~ (^|$'\n')[[:space:]]*WAITING[[:space:]]*($|$'\n') ]] || \
      [[ "$last_lines" =~ (^|$'\n')⏺[[:space:]]*WAITING[[:space:]]*($|$'\n') ]]; then
   ```
   Stale guard: If ⏺ appears AFTER WAITING, agent has resumed -> "running"

8. Other running indicators (last 15 lines) (lines 4926-4936)
   Pattern: "ctrl+b ctrl+b" | "thinking)"

9. Thinking spinners (last 15 lines) (lines 4938-4975)
   Characters: ✽ ✶ ✢ · ✻ ✳ at start of line
   Sub-checks:
   - With interrupt marker -> running
   - With token arrows (↑/↓) -> running
   - Completion time format ("Cogitated for", "thought for") -> skip (not running)
   - Otherwise -> running
   Hook spinners filtered out first via filter_hook_spinners()

10. Permission prompts (last 15 lines) (lines 4983-4997)
    Same as #1 but checked in the last-15 window (not just startup)

11. Broader window spinners (last 20 lines) (lines 4999-5013)
    Same spinner check as #9 but in 20-line window (catches queued messages)

12. Background tasks (last 15 lines) (lines 5015-5024)
    Pattern: ⏵⏵ followed by · and digit+space
    ```bash
    if [[ "$last_lines" =~ ⏵⏵.*·[[:space:]][0-9]+[[:space:]] ]]; then
    ```

13. Race condition guard (last 15 lines) (lines 5026-5037)
    Pattern: "running stop hook" present AND no ⏺ output marker
    Returns "creating" to suppress nudge during transient state

14. Unknown (line 5041)
    Fallback when no patterns match
```

### Hook Spinner Filtering (lines 4740-4754)

Before checking spinners, lines matching hook execution are removed:
```bash
filter_hook_spinners() {
    # Remove lines starting with spinner char that contain "hook"
    if [[ "$line" =~ ^[✽✶✢·✻✳] ]] && [[ "$line" == *hook* ]]; then
        continue
    fi
}
```

### Creating State Detection (in compute_state_from_content, lines 4667-4718)

Before calling `parse_state()`, checks first 100 lines:
1. Look for Claude startup indicators: "Claude Code v", "╭─ Claude Code", "[USER TASK]", "[AGENT CONTEXT]"
2. If NOT found, check for permission prompts ("Enter to confirm" + "trust"/"Allow external")
3. If still not found and fewer than 10 lines, return "creating"

### State Caching (in build_agent_data_file, lines 6196-6250)

- Background monitor writes `.state` files to `TMUX_CACHE_DIR`
- `get_state()` reads `.state` cache first (O(1) file read)
- Fallback: direct tmux capture if no cache
- Round-robin refresh: one agent per frame at frame % 5 offset
- `unknown` state mapped to `waiting` for display

---

## 3. UI Rendering Approach

### Terminal Control

- Uses `tput civis` (hide cursor), `tput clear`, `stty -echo` on startup
- Restores with `tput cnorm`, `tput clear`, `stty echo` on EXIT trap
- Uses ANSI escape sequences for cursor positioning: `\e[row;colH`
- Full screen redraws via `tput cup 0 0` (move to top-left) rather than clear (reduces flicker)
- Terminal title set via `\e]0;ib watch: agent-name\a`

### Frame Rate Control (lines 22824-22953)

```bash
TARGET_FPS="${CONFIG_FPS:-10}"  # Default 10 FPS
TARGET_FRAME_MS=$((1000 / TARGET_FPS))

# Rolling average of last 3 render times
RENDER_TIME_1, RENDER_TIME_2, RENDER_TIME_3

# Sleep to hit target FPS
avg_render_time=$(( (RENDER_TIME_1 + RENDER_TIME_2 + RENDER_TIME_3) / 3 ))
sleep_needed=$((TARGET_FRAME_MS - avg_render_time))
```

### Minimum Terminal Size

Requires 20 rows x 80 columns minimum. Shows warning if too small.

### Screen Layout

```
Row 1-5:    Agent tree (max 5 visible lines, scrollable)
Row 6:      Pane header: "── agent-id ─────┬─── RIGHT PANE NAME ─────"
Row 7-N:    Split panes: left (tmux, 60 cols) │ right (remaining cols)
Row N+1:    Separator: "────────────────────┴────────────────────"
Row N+2:    Footer row 1: help keys (left) + usage stats (right)
Row N+3:    Footer row 2: action keys (left) + fps/clock/version (right)
```

### Left Pane Width

Fixed at `TMUX_WIDTH=60` columns (set as global near line 13).

### Rendering Pipeline (watch_render, line 22226)

```
1. Get terminal size (tput lines/cols)
2. Validate minimum size (20x80)
3. Refresh usage data periodically
4. Update separator cache if size changed
5. Move cursor to 0,0
6. build_agent_data_file() - get agent metadata + states
7. watch_render_tree() - draw top 5-line agent tree
8. watch_render_split_panes() - draw side-by-side tmux + right pane
9. watch_render_footer() - draw 2-line footer with keys/stats
```

### Color Scheme

```bash
COLOR_DIM=$'\e[2m'       # Dim/faint text (separators, timestamps)
COLOR_CYAN=$'\e[36m'     # Cyan for [bracket] blocks in logs
COLOR_YELLOW=$'\e[33m'   # Yellow for warnings (>80% usage)
COLOR_RED=$'\e[31m'      # Red for critical (>90% usage), diff removals
COLOR_GREEN=$'\e[32m'    # Green for diff additions
COLOR_RESET=$'\e[0m'     # Reset all
```

---

## 4. Agent Tree Display

### Data Collection (build_agent_data_file, lines 5951-6262)

Two-pass approach:
1. **Pass 1**: Scan `$AGENTS_DIR/*/meta.json`, cache metadata (manager, age, model, prompt, worker, tmux_session). Uses O(1) index lookup strings for caching.
2. **Tree ordering**: `get_agent_ids_tree_order()` does depth-first traversal. Result cached by agent list hash.
3. **Pass 2**: Write tmpfile in tree order with format: `id|manager|state|age|model|prompt|worker`

### Meta.json Cache (lines 6000-6098)

- Multi-level cache: `META_CACHE_IDS[]`, `META_CACHE_DATA[]`, `META_CACHE_MTIME[]`, `META_CACHE_STABLE[]`
- O(1) lookup via index string: `"|id1:0|id2:1|"` pattern matched with `*"|$id:"*`
- Stable optimization: After 30 frames without change, skip `stat()` call entirely
- Pure bash JSON parsing (regex on each line) instead of jq

### Tree Line Formatting (build_tree_lines, lines 6346-6506)

```
agent-root        running   5m    sonnet   Fix the bug...
├── sub-agent-1   waiting   3m    opus     Implement feature...
│   └── worker-1  complete  2m    haiku    Write tests...
└── sub-agent-2   stopped   10m   sonnet   Review code...
```

- Box-drawing connectors: `├──`, `└──`, `│`
- Agent names truncated to 30 chars with `...`
- Orphaned workers get `⚠️` prefix
- Column alignment: tree_part (variable) | state (8) | age (5) | model (10) | prompt (remainder)

### Tree Scrolling (lines 21023-21046)

- Max 5 visible lines in the header tree
- Selection kept in middle positions (1-3)
- First item always at position 0, last at position 4
- Scroll offset calculated as `SELECTED_INDEX - 2` (clamped)

### Selection Tracking

- `SELECTED_INDEX` - numeric index in flattened tree
- `SELECTED_NAME` - agent ID string, used to maintain selection when list changes
- On each frame: try to find `SELECTED_NAME` in new list, update index if found
- Reverse video highlighting: `\e[7m` for selected line

---

## 5. Tmux Integration

### Background Session Monitor (lines 22701-22775)

Runs every 150ms in a background subshell:

```bash
while true; do
    # 1. List sessions
    sessions=$(tmux list-sessions -F '#{session_name}') || true
    printf '%s' "${sessions//$'\n'/|}" > "$sessionfile"

    # 2. For each agent directory:
    for agent_dir in "$agents_dir"/*/; do
        # Read tmux_session from meta.json (pure bash regex)
        # Check if session exists in sessions list
        # If not: write "stopped" or "creating" to .state file
        # If yes:
        raw_capture=$(tmux capture-pane -t "$tmux_session" -p -S -500 -E - 2>/dev/null)
        _strip_ansi "$raw_capture"
        # Write stripped content to cache file
        # Compute and cache state
        compute_state_from_content "$_STRIP_ANSI_RESULT"
        printf '%s' "$computed_state" > "$tmux_cache_dir/$agent_id.state"
    done

    # 3. Cache wrapped logs for each agent
    for agent_dir in "$agents_dir"/*/; do
        tail -n 200 "$log_file" | fold -w "$wrap_width" > "$log_cache_dir/$agent_id"
    done

    sleep 0.15
done
```

### Key Details

- **Capture command**: `tmux capture-pane -t "$session" -p -S -500 -E -`
  - `-p` outputs to stdout
  - `-S -500` starts 500 lines back
  - `-E -` captures TO end of scrollback (prevents scroll jumping during heavy output)
- **ANSI stripping**: Pure bash `_strip_ansi()` removes `\e[...m` sequences
- **Cache files**: `$TMUX_CACHE_DIR/$agent_id` for content, `$agent_id.state` for computed state
- **Atomic writes**: Write to `.tmp` then `mv` to prevent partial reads
- **Session name resolution**: Reads `tmux_session` from `meta.json` (not constructed from prefix)

### Display (in watch_render_split_panes, lines 21610-21778)

```bash
# Read from cache (or fallback to direct capture)
tmux_output=$(<"$cache_file") 2>/dev/null || true

# Split into lines, calculate scroll window
tmux_start_idx=$((tmux_total - pane_height - SCROLL_OFFSET))

# Render side-by-side with separator
printf '\e[%d;1H\e[K%s\e[%d;%dH %s|%s %s' \
    "$row" "${visible_tmux_lines[$pane_line]}" \
    "$row" "$((left_pane_width + 1))" \
    "$COLOR_DIM" "$COLOR_RESET" "$right_line"
```

---

## 6. Keyboard Shortcuts

### Normal Mode (watch_process_key, lines 22368-22660)

| Key | Action |
|-----|--------|
| `j` / Down | Select next agent (or next question in questions pane) |
| `k` / Up | Select previous agent (or previous question) |
| `@` | Fuzzy jump to agent by name |
| `/` | Fuzzy jump to command/panel |
| `p` | Next right pane mode (forward cycle, skips empty panes) |
| `n` | Previous right pane mode (backward cycle, skips empty panes) |
| Left arrow | Same as `p` (next pane) |
| Right arrow | Same as `n` (previous pane) |
| `;` | Scroll down (older content), 10 lines |
| `l` | Scroll up (newer content), 10 lines |
| `d` | Jump to diff pane |
| `g` | Jump to status pane (or go-to-agent in questions pane) |
| `e` | Jump to errors pane |
| `q` | Jump to questions pane |
| `s` | Open send message dialog |
| `m` | Open merge dialog |
| `x` | Open kill dialog |
| `!` | Open nuke dialog |
| `a` | Open new agent dialog |
| `h` | Open setup/settings dialog |
| `r` | Open reassign dialog |
| `S` | Capture tmux snapshot for debugging |
| `w` | Open agent worktree in Finder |
| `o` | Open external diff tool |
| `c` | Clear all errors (only in errors pane) |
| `t` | Toggle time filter (only in denials pane) |
| Enter | Answer selected question (only in questions pane) |
| Ctrl-C | Exit |

### Escape Sequence Handling (lines 22407-22460)

Three-state machine for arrow keys:
```
0 = normal
1 = got ESC (could be standalone escape or start of sequence)
2 = got ESC+[ (expecting direction char A/B/C/D)
```

### Dialog Modes

| Mode | Dialog | Key to open |
|------|--------|-------------|
| 0 | None (normal mode) | - |
| 1 | Send message | `s` |
| 2 | Kill agent | `x` |
| 3 | Nuke all agents | `!` |
| 4 | New agent | `a` |
| 5 | Agent jump (fuzzy) | `@` |
| 6 | Setup/Settings | `h` |
| 7 | Merge | `m` |
| 8 | External diff tool | - |
| 9 | Command jump (fuzzy) | `/` |
| 10 | Feedback | auto |
| 11 | Number input | - |
| 12 | String input | - |
| 13 | Permissions editor | - |
| 14 | Answer question | Enter |
| 15 | Reassign | `r` |

All dialogs:
- Rendered as centered box-drawing character boxes
- Use dirty flag system (`_DIALOG_DIRTY`) to minimize redraws
- Support Tab/Shift-Tab for focus cycling
- ESC closes (with 3-state machine to distinguish from arrow sequences)
- Text inputs support backspace, Ctrl+U (delete line), Option+Delete (delete word)

---

## 7. Right Pane Modes

```bash
RIGHT_PANE_NAMES=("AGENT LOG" "INITIAL PROMPT" "DENIALS" "TREE" "ERRORS" "DIFF" "STATUS" "QUESTIONS")
# Indices:          0             1                2         3      4        5      6        7
```

### Mode 0: Agent Log
- Pre-wrapped by background process (tail -200, fold -w)
- Parsed every 7 frames (or on agent change)
- Log lines colorized: ISO timestamps dimmed, `[brackets]` in cyan
- Content from `$LOG_CACHE_DIR/$agent_id`

### Mode 1: Initial Prompt
- Reads `$AGENTS_DIR/$selected_id/prompt.txt`
- Trims to `[USER TASK]` marker if present
- Wrapped with pure bash `_fold_text()`

### Mode 2: Denials (full-width)
- Hides tmux left pane, uses full terminal width
- Background collector scans agent logs for "Permission denied" / "Path violation"
- Time filter: active only / 24h / 7d (toggled with `t` key)
- Collector runs every 10 seconds in background subshell

### Mode 3: Tree (full-width)
- Full-width tree display (same format as header but using all rows)
- Selection highlighting with reverse video
- Scroll support

### Mode 4: Errors (full-width)
- Displays async errors (e.g., failed agent creation)
- Newest first
- `c` key clears all errors
- Unread count shown in footer as red badge

### Mode 5: Diff (full-width)
- Background collector runs `git diff` for agent's branch
- Also checks merge status (conflicts, uncommitted changes)
- Colorized: green additions, red removals, dim headers
- Merge status indicator in header

### Mode 6: Status
- Git status from background cache
- Shows commits and changes summary

### Mode 7: Questions (full-width)
- Displays pending questions from agents
- j/k navigates between questions
- Enter opens answer dialog
- `g` jumps to the questioning agent
- Loaded every 3 seconds from `user-questions.json`

### Pane Skipping Logic (lines 15263-15283)
```bash
watch_calc_next_pane() {
    local next_mode=$(( (RIGHT_PANE_MODE + direction + pane_count) % pane_count ))
    # Skip errors pane (mode 4) if there are no errors
    if [[ $next_mode -eq 4 && $ERRORS_TOTAL_COUNT -eq 0 ]]; then
        next_mode=$(( (next_mode + direction + pane_count) % pane_count ))
    fi
    # Skip questions pane (mode 7) if there are no questions
    if [[ $next_mode -eq 7 && $QUESTIONS_TOTAL_COUNT -eq 0 ]]; then
        next_mode=$(( (next_mode + direction + pane_count) % pane_count ))
    fi
}
```

---

## 8. Scroll System

- **Shared scroll offset**: `SCROLL_OFFSET` applies to BOTH left (tmux) and right pane simultaneously
- **Direction**: `SCROLL_OFFSET=0` means bottom/auto-follow (newest). Positive values scroll back.
- **Step size**: 10 lines per `;`/`l` keypress
- **Reset**: Scroll resets to 0 on agent change or pane mode change
- **Clamping**: Scroll clamped to `max(tmux_max_scroll, right_max_scroll)`

```bash
# Scroll calculation (lines 21718-21742)
local tmux_start_idx=$((tmux_total - pane_height - SCROLL_OFFSET))
local right_start_idx=$((right_total - pane_height - SCROLL_OFFSET))
```

For full-width modes (denials, diff, tree, questions), scroll behaves differently:
- Denials/tree: scroll from bottom (like tmux)
- Diff/errors: scroll from top (like a normal viewer)
- Questions: scroll from top

---

## 9. Refresh/Polling Strategy

### Background Monitor (150ms interval)
- Lists tmux sessions
- Captures pane output for ALL agents (500 lines, ANSI-stripped)
- Computes state for each agent and writes to `.state` file
- Caches wrapped agent logs

### Main Loop (target 10 FPS default)
- `build_agent_data_file()` reads cached state from `.state` files
- Round-robin state refresh: only 1 agent gets direct `get_state()` per 5 frames
- Meta.json cache: stable entries (30+ frames) skip `stat()` entirely
- Tree order cache: recomputed only when agent list/manager relationships change
- Log cache: re-parsed every 7 frames (or on agent change)
- Questions: reloaded every 3 seconds
- Usage stats: refreshed every 30 seconds

### Performance Optimizations
- O(1) index lookup strings: `"|id1:idx|id2:idx|"` pattern for hash-like access
- Cached separator strings rebuilt only on terminal resize
- Dialog dirty flags prevent unnecessary redraws
- Pure bash JSON parsing (no jq calls in hot path)
- `_strip_ansi()` is pure bash (no sed/perl subprocess)
- `_fold_text()`, `_tail_file()`, `_tail_string()` all pure bash
- Time cached every 5 frames (`CACHED_NOW`, `CACHED_TIME_STR`)

---

## 10. Special Modes and Flags

### Debug Mode (`--debug`)
- Enables timing instrumentation for all render phases
- Auto-exits after 100 frames
- Suppresses TUI output (renders to /dev/null)
- Shows timing summary on exit (averages, min, max per operation)
- Skips TTY setup (no cursor hide, no stty)
- Records: `build_agent_data`, `state_detection`, `render_tree`, `render_split_panes`, `render_footer`, `total_frame`

### Feedback Dialog
- Shown after 3 frames on certain sessions (controlled by session count/timing)
- One-time trigger per session
- Skipped in debug mode

### Usage Tracking
- Fetches Claude API usage percentages (session and weekly)
- Color-coded: >80% yellow, >90% red
- Includes reset time display
- Fetched every 30 seconds

### Status Messages
- Temporary messages shown in footer (e.g., after snapshot capture)
- Auto-expire after 3 seconds using `$SECONDS` builtin
- Override the action keys text in footer row 2

### Update Checker
- Background process checks GitHub releases once per hour
- Shows red notification in footer if update available
- Uses OSC 8 hyperlink for clickable update link

---

## 11. Key Differences from itsybitsy TypeScript Implementation

Based on the CLAUDE.md notes, the TypeScript implementation has made these architectural choices differently:

| Aspect | ib bash | itsybitsy TS |
|--------|---------|-------------|
| UI framework | Raw ANSI/tput | pi-tui components |
| State detection | `parse_state()` inline | `parseState()` in `parse-state.ts` |
| Tmux polling | Background subshell (150ms) | `setInterval` (~1s), selected agent only |
| Agent data | `build_agent_data_file()` tmpfile | `readAllAgents()` returns `{agents, errors}` |
| Tree building | `build_tree_lines()` + `format_tree_lines()` | `buildAgentTree()` mutates `agent.children` |
| Split pane | Manual printf column math | `SplitPane` component |
| Line wrapping | `_fold_text()` pure bash | `wrapLines()` ANSI-aware |
| Scroll model | `SCROLL_OFFSET` (lines from bottom) | `scrollBack` (lines from end) |
| Key handling | Single-char processing from file | pi-tui `handleInput()` |
| Dialog system | Modal `DIALOG_MODE` integer | Dialog types with variable height |
| Max tree lines | 5 (hardcoded) | 7 (hardcoded) |
| FPS | 10 (configurable) | Not frame-based (event-driven) |
| ANSI stripping | Done in background monitor | Done before `parseState()` |

### State Detection Priority Comparison

The ib bash `parse_state()` priority order maps to itsybitsy's `parseState()` as documented in CLAUDE.md:

```
ib bash                              itsybitsy
─────────                            ─────────
Compacting (last 5)                  Compacting (last 5)
Active running (last 5)              Active running (last 5)
Tool waiting (last 15)               Tool waiting (last 15)
Rate limited (last 15)               Rate limited (last 15)
Complete (last 15)                   Complete (last 15)
WAITING (last 15)                    WAITING (last 15)
Other running (last 15)              Other running (last 15)
Spinners (last 15)                   Spinners (last 15)
Permission prompts (last 15)         Permission prompts (last 15)
Broader spinners (last 20)           Broader spinners (last 20)
Background tasks (last 15)           Background tasks (last 15)
Race condition hook                  Race condition hook
Unknown                              Unknown
```

The two implementations appear to have matching priority orders.

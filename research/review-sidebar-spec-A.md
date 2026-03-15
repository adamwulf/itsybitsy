# Review: SPEC.md Sections 11–13 (Sidebar Layout, Coordinator, Focus System)

**Reviewer**: Agent Manager
**Date**: 2026-03-15
**Scope**: Sections 11–13 of SPEC.md (lines 934–1137) — three-column layout, coordinator Claude session, and focus system

---

## Summary

Sections 11–13 specify a significant TUI redesign: a 60-column fixed sidebar (agent tree + info panel + coordinator) + resizable central pane + cycling right pane, with Tab-based focus cycling that routes input to the focused panel. The coordinator is a system-wide Claude session with restricted permissions (`Bash(ib:*)` only) for coordinating agents across repos.

**Overall Assessment**: The design is **sound and implementable**, with clear intent. However, several specifications lack sufficient detail for unambiguous implementation, and a few edge cases (terminal size, race conditions, height calculations) need tightening before handoff to implementers.

---

## Approve/Reject

**Status**: ✅ **APPROVE with Minor Issues**

The specs are functionally correct and do not conflict with earlier sections. The design choices are reasonable (fixed sidebar width, reference-counted coordinator lifecycle). However, resolve all issues in "Issues Found" before implementation to avoid rework.

---

## Issues Found

### 1. **Terminal Size Minimum Not Specified**
- **Location**: §11.1 (layout diagram)
- **Issue**: The sidebar is fixed at 60 columns. On an 80-column terminal, this leaves only ~20 columns for the central tmux pane + right pane. On narrower terminals (< 80 cols), the layout breaks. The spec does not document a minimum terminal width or graceful degradation behavior (e.g., "sidebar collapses to 40 cols on narrow terminals" or "error if < 120 cols").
- **Impact**: Low (most modern terminals are ≥ 100 cols), but implementers will hit this edge case.
- **Recommendation**: Specify minimum terminal width (suggest 100 columns for comfortable layout, 80 for minimum with degradation).

### 2. **Sidebar Height Allocation Formula Is Vague**
- **Location**: §11.2
- **Issue**: Relative heights are described as:
  - Agent tree: "up to 7 rows (same as current `MAX_TREE_HEIGHT`)"
  - Coordinator: "~40% of available sidebar height, minimum 5 rows"
  - Info panel: "remaining vertical space"

  The use of "~40%" is imprecise. Does this mean: (a) 40% of the **total** sidebar height, or (b) 40% of the **remaining** height after the agent tree? Also, what happens if the total sidebar height is only 10 rows? Does the coordinator still get 5 rows minimum, squeezing the info panel to 0 or negative rows?
- **Impact**: Medium (height layout is core to the design)
- **Recommendation**: Provide a concrete formula:
  ```
  available_height = terminal_rows - headers - separators
  tree_height = min(7, available_height * 0.3)
  coordinator_height = max(5, available_height * 0.4)
  info_height = available_height - tree_height - coordinator_height
  if info_height < 0: error or shrink coordinator to 3 rows minimum
  ```

### 3. **Input Field Height Not Subtracted from Display Height**
- **Location**: §13.4 (input field specification)
- **Issue**: The input field occupies 3 lines (top separator, input, bottom separator). The spec states these "are subtracted from the tmux output display height" but does not specify **where** in the code this subtraction happens or which component is responsible. The dashboard code needs to know:
  - When to subtract (only when focused on `coordinator` or `active-agent`, not `agent-tree`)
  - Whether to adjust `displayHeight` before or after padding to terminal height
- **Impact**: Medium (affects layout consistency and scroll behavior)
- **Recommendation**: Explicitly document:
  ```
  When coordinator or active-agent has focus:
    displayHeight = terminal_rows - headers - separators - 3 (for input field)
  When agent-tree has focus:
    displayHeight = terminal_rows - headers - separators
  Adjust displayHeight in TmuxPaneComponent and coordinator panel render() before padding.
  ```

### 4. **Focus Indicator Specification Is Under-Specified**
- **Location**: §13.3 (focus indicators)
- **Issue**: The spec says "Section header/separator is highlighted (bold or colored)" but does not specify:
  - Which separator (top? bottom? both?)
  - What color/style (bold? inverted? colored?)
  - How to render when the input field is visible (separator + input field + separator — which ones are highlighted?)
  - Render order: is the highlight applied to the separator characters themselves, or the whole line?
- **Impact**: Low–Medium (visual polish; affects UX clarity)
- **Recommendation**: Provide ASCII mockups for each focused state:
  ```
  ──── Coordinator ──── (focused, bold)
  [output lines, wrapped]
  ──────────────────────
  > user input here█
  ──────────────────────
  ```

### 5. **Coordinator Session Cleanup Race Condition**
- **Location**: §12.2 (auto-close behavior)
- **Issue**: The reference counter mechanism decrements on exit: when the counter reaches 0, the session is killed. However, if two `ib watch` instances exit simultaneously, both may read the counter as 1, decrement it to 0, and both attempt to kill the session. The spec does not describe file locking, atomic operations, or error handling for concurrent decrements.
- **Impact**: Low (rare in practice; worst case: attempt to kill already-dead session, which is idempotent)
- **Recommendation**: Either: (a) use an atomic file operation (e.g., `flock`), or (b) document that concurrent exit is unsupported and one instance may fail to clean up the session. Alternatively, document that the session auto-kills after a timeout if left orphaned.

### 6. **Git Repo Initialization at ~/.itsybitsy/ Lacks Safety Checks**
- **Location**: §12.3 (permissions file setup)
- **Issue**: The spec says "initialize a bare git repo there (`git init`)" but does not check if `.git` already exists or if it contains unrelated history. On systems where a user already initialized a git repo at `~/.itsybitsy/`, a fresh `git init` could be confusing or destructive.
- **Impact**: Low (unlikely edge case; `git init` in an existing repo is idempotent)
- **Recommendation**: Add safety check: "If `.git` already exists, skip initialization. If `.git` is a file (not a directory), error with a clear message." Or: use a dedicated `~/.itsybitsy/.clauderc` as a marker instead of relying on git.

### 7. **Coordinator Custom Initial Prompt Interaction Unclear**
- **Location**: §12.5 (session start context)
- **Issue**: The spec says the coordinator receives a "custom initial prompt explaining its role" instead of the standard session-start hook. But it's unclear:
  - Is this prompt **prepended** to the user's first input, or does it **replace** the entire startup context?
  - Does Claude see both the custom prompt and the standard system context, or only the custom prompt?
  - How is this prompt delivered to Claude — via `--session-id`, environment variable, or piped to stdin?
- **Impact**: Medium (affects coordinator behavior and clarity of interaction)
- **Recommendation**: Clarify:
  ```
  The coordinator session is spawned with:
    claude --session-id <uuid> "<custom_prompt>"
  The custom prompt is the ONLY initial context; standard session-start hooks are NOT applied to the coordinator.
  The prompt should end with: "You can now enter 'ib' commands below."
  ```

### 8. **Agent Tree Wrapping/Truncation Rules Not Specified**
- **Location**: §11.3 (compact agent tree format)
- **Issue**: The row format `icon agent-id state age` is specified, but if the terminal is narrower than expected, which fields are truncated or wrapped? If `agent-id` is 16 characters + icon (1) + state (10) + age (3) = 30 characters, and the sidebar is only 60 wide, there's room. But the spec should explicitly state truncation priority: truncate age first? state? agent-id?
- **Impact**: Low (only affects narrow terminals)
- **Recommendation**: Specify truncation priority: "If row exceeds 60 columns: truncate age, then state, then agent-id from the right. Do not wrap to next line."

### 9. **Scroll Indicators for Agent Tree Not Specified**
- **Location**: §11.2 (agent tree height limit)
- **Issue**: The spec says the agent tree "will scroll indicators if more rows exist" but does not specify:
  - What the indicators look like (e.g., `↓` at the bottom, `↑` at the top, `⋮` in the middle?)
  - Whether they occupy a full line or appear inline with the last visible row
  - What they say (e.g., `(+3 more)` or just a symbol?)
- **Impact**: Low (visual detail; doesn't block implementation)
- **Recommendation**: Specify: "If more agents exist below the visible 7 rows, append a symbol `↓ <count>` to the 7th row, replacing content if necessary. If agents above exist and tree is scrolled, show `↑` as the first character."

### 10. **Tab Key Breaks Previous Keyboard Shortcut**
- **Location**: §13.2 (focus cycling)
- **Issue**: The spec says Tab "replaces the previous tree/questions toggle behavior." This is a breaking change for existing users. The spec acknowledges it but does not discuss:
  - What users should do if they still want the old behavior
  - Whether there's a migration path or help text
  - Whether the old tree/questions toggle is still available via a different key
- **Impact**: Low (already documented as intentional change)
- **Recommendation**: Add help text: "Press `?` to see keybindings. The Tab key now cycles focus (agent-tree → coordinator → active-agent). To toggle between tree and questions, use the `p` and `n` keys as before."

### 11. **Info Panel Wrapping Algorithm Not Specified**
- **Location**: §11.4 (summary/prompt wrapping)
- **Issue**: The summary is described as "wrapped to sidebar width" but the spec does not specify:
  - Hard-wrap (break at 60 cols even mid-word) or word-wrap (break at word boundaries)?
  - If word-wrap and a word exceeds 60 columns, what happens (truncate, or hard-wrap)?
  - Are ANSI escape sequences stripped before wrapping?
  - How many lines of summary are shown (all, or a fixed number like 3)?
- **Impact**: Low (detail; most wrapping libraries have defaults)
- **Recommendation**: Specify: "Use hard-wrap at 60 columns. Strip ANSI codes before wrapping. Show up to 3 lines of summary; truncate longer text with `…`."

### 12. **Coordinator Input Validation Missing**
- **Location**: §13.4 (input field)
- **Issue**: When a user types into the coordinator input field and presses Enter, the input is sent via `tmux send-keys -t ib-coordinator -l "<message>"`. The spec does not mention:
  - What if the message contains a literal newline (Ctrl-J)? The `-l` flag prevents interpretation, but does it allow newlines?
  - What if the message is empty? Does Enter do nothing, or send an empty line?
  - Is there any input sanitization (e.g., strip control characters)?
- **Impact**: Low (edge cases; `-l` flag handles most safety)
- **Recommendation**: Specify: "Input is sent as-is via `tmux send-keys -l`. Reject Ctrl-C/Ctrl-Z. Allow Enter/Escape for control. Empty input on Enter is allowed (sends empty line). No other sanitization."

---

## Suggestions

### A. Add Terminal Size Guidelines
Add a new subsection §11.6 specifying recommended terminal sizes:
```
### 11.6 Terminal Size Requirements

Recommended minimum: 100 columns × 30 rows.
- Sidebar: 60 columns (fixed)
- Central pane: 20 columns (tmux output)
- Right pane: 20 columns (cycling)
- Header/footer: 4 rows

Narrower terminals (80–99 cols) will have cramped central + right panes.
Narrower than 80 cols: not supported; show error message.
```

### B. Clarify Info Panel Height Calculation
Provide a concrete pseudocode formula in §11.2:
```javascript
const treelines = Math.min(7, availableHeight * 0.3);
const coordinatorLines = Math.max(5, availableHeight * 0.4);
const infoLines = Math.max(1, availableHeight - treeLines - coordinatorLines);
```

### C. Document Display Height Adjustment
In §13.4, add:
```
When rendering TmuxPaneComponent:
  const displayHeight = (coordinator.hasFocus || agent.hasFocus)
    ? terminalRows - headers - 3 - separators
    : terminalRows - headers - separators;
  tmuxPane.render(displayHeight);
```

### D. Add Focus Indicator Mockups
Extend §13.3 with ASCII examples:
```
// When coordinator has focus (bold separator):
────────────────────────────────
│ Coordinator Output
│ (recent messages)
────────────────────────────────
│ > input text here█
────────────────────────────────
```

### E. Add Input Field Size Consistency Note
In §13.4, clarify:
```
The input field occupies exactly 3 rows:
  1. Top separator (matches panel width, e.g., `────────────────`)
  2. `> input text █` (left-aligned, cursor at end)
  3. Bottom separator

When input gains focus, re-render the panel to make space.
When input loses focus (Escape), restore the 3 rows to tmux output display.
```

---

## Conclusion

The specifications are **implementable and correct**. The three-column layout, coordinator session, and focus system are well-designed. However, before handing off to implementation, tighten the vague specifications (height calculation, terminal size, focus indicators, input field integration) so implementers don't waste cycles on edge cases. The 12 issues above are all resolvable with clarifying text or examples — no design changes needed.

**Estimated effort to address**: ~1 hour to revise specs, ~40 hours for implementation and testing.

---

I HAVE COMPLETED THE GOAL


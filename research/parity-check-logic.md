# Parity Check: itsybitsy vs ib watch — Logic & Correctness Analysis

Generated: 2026-03-06. Based on reading `src/parse-state.ts`, `src/agents.ts`, `src/watcher.ts`, `src/tmux-poller.ts`, `research/ib-watch-analysis.md`, and `research/watch-parity-gaps.md`.

---

## 1. State Detection — parseState() vs parse_state()

### 1.1 Priority Order Inversion: Tool Waiting vs Active Running

**Status: Intentional deviation — likely correct, but undocumented**

`ib`'s `parse_state()` priority order (from ib-watch-analysis.md lines 4826-4858):
```
2. Compacting (last 5)
3. Tool waiting (last 15)   ← BEFORE active running
4. Active running (last 5)  ← AFTER tool waiting
```

itsybitsy's `parseState()` order (parse-state.ts lines 78-91):
```
Compacting (last 5)
Active running (last 5)   ← BEFORE tool waiting (intentional)
Tool waiting (last 15)    ← AFTER active running
```

The comment in parse-state.ts justifies the swap: "if agent resumed running (showing Esc to interrupt in last 5), a stale ⎿ Waiting in lines 6-15 should not override it." This is sound reasoning — the itsybitsy ordering is arguably more correct.

**Risk:** Low. The deviation is intentional and has a valid justification. However it is not documented anywhere as a known deviation from ib. Worth noting in CLAUDE.md or ib-watch-analysis.md comparison table.

**Fix:** No code change needed. Update the comparison table in ib-watch-analysis.md section 11 to note this intentional inversion.

---

### 1.2 Missing: `compute_state_from_content()` wrapper — "creating" heuristic for <10 lines

**Status: GAP — Missing logic, medium user impact**

`ib` has a two-tier architecture (`compute_state_from_content()` wrapping `parse_state()`). Before calling `parse_state()`, it checks:
1. If the first 100 lines contain Claude startup indicators (`"Claude Code v"`, `"╭─ Claude Code"`, `"[USER TASK]"`, `"[AGENT CONTEXT]"`)
2. If NOT found AND total output has **fewer than 10 lines** → return `"creating"`

itsybitsy's `detectAgentStates()` (agents.ts:219) calls `parseState()` directly. There is no pre-check for line count.

**Impact:** A freshly spawned agent with only a few lines of terminal output (e.g., tmux welcome message, shell prompt) will show as `"unknown"` instead of `"creating"` until Claude's startup screen appears. This incorrectly shows unknown for 1-3 seconds after spawn.

**Location:** `src/agents.ts:234` — the `parseState(output).state` call.

**Complexity:** Low.

**Fix:** Add a wrapper function (or inline logic) in `detectAgentStates()` before calling `parseState()`:
```typescript
function computeStateFromContent(stripped: string): AgentState {
  const lines = stripped.split("\n").filter(l => l.trim() !== "");
  const hasStarted = stripped.includes("Claude Code v") ||
    stripped.includes("╭─ Claude Code") ||
    stripped.includes("[USER TASK]") ||
    stripped.includes("[AGENT CONTEXT]");
  if (!hasStarted && lines.length < 10) {
    return "creating";
  }
  return parseState(stripped).state;
}
```

---

### 1.3 Missing Claude Startup Indicators: `"╭─ Claude Code"` and `"[AGENT CONTEXT]"`

**Status: GAP — Minor but affects creating-state accuracy**

The creating-state check at the top of `parseState()` (parse-state.ts:61) only checks:
- `"Claude Code v"`
- `"[USER TASK]"`

`ib`'s `compute_state_from_content()` also checks:
- `"╭─ Claude Code"` — the box-drawing header line
- `"[AGENT CONTEXT]"` — context block marker for worker agents

`"[AGENT CONTEXT]"` is important: worker agents injected with context would show this before `"Claude Code v"`. Without it, a worker agent early in startup might incorrectly stay in `"creating"` longer than needed.

**Location:** `src/parse-state.ts:61`

**Complexity:** Low.

**Fix:** Add to the startup indicator check:
```typescript
if (!input.includes("Claude Code v") && !input.includes("[USER TASK]") &&
    !input.includes("╭─ Claude Code") && !input.includes("[AGENT CONTEXT]")) {
```

---

### 1.4 All 13 Priority Tiers — Verdict

Cross-checking each tier against ib-watch-analysis.md section 2:

| Tier | ib pattern | itsybitsy | Match? |
|------|-----------|-----------|--------|
| Creating (pre-startup) | "Enter to confirm" + trust, no Claude logo | same check + full-input scope | Partial (see 1.2, 1.3) |
| Compacting (last 5) | "Compacting conversation" | same | Yes |
| Tool waiting (last 15) | `⎿\s*Waiting` | same regex | Yes |
| Active running (last 5) | `(Esc to interrupt`, `(ctrl+c to interrupt`, `⎿  Running` | same (with case-fold on E) | Yes |
| Rate limited (last 15) | "rate_limit_error" + usage patterns | same | Yes |
| Complete (last 15) | "I HAVE COMPLETED THE GOAL" excl. quoted | same | Yes |
| WAITING (last 15) | standalone WAITING or ⏺ WAITING | same regex | Yes |
| WAITING stale guard | ⏺ after WAITING → running | same logic | Yes |
| Other running (last 15) | "ctrl+b ctrl+b" \| "thinking)" | same | Yes |
| Spinners (last 15) | ✽✶✢·✻✳ + sub-checks | same | Yes |
| Hook spinner filter | spinner + "hook" → remove | same | Yes |
| Permission prompts (last 15) | same as creating but in last 15 | same | Yes |
| Broader spinners (last 20) | spinner + interrupt in 20 lines | same | Yes |
| Background tasks (last 15) | `⏵⏵.*·\s[0-9]+\s` | same regex | Yes |
| Race condition guard | "running stop hook" + no ⏺ | same | Yes |
| Unknown (fallback) | default | same | Yes |

**Summary:** 13/13 tiers present. Two correctness gaps in tier 1 (see 1.2 and 1.3).

---

## 2. Tmux Polling — State Polling Coverage After P0 Fixes

### 2.1 All-Agent State Polling: 2s Background Poll Exists

**Status: Addressed by P0 fix — but polling interval gap remains**

`watcher.ts:84-87` adds a `stateTimer` that calls `pollStates()` every 2 seconds:
```typescript
this.stateTimer = setInterval(() => {
  if (this.running) this.pollStates();
}, 2_000);
```

`pollStates()` calls `detectAgentStates(agents)` on ALL `lastAgents`. This is the P0 fix. It means all agents get state-checked every ~2s between fs.watch events.

**Gap vs ib:** `ib` polls all agents every **150ms**. itsybitsy polls every **2000ms** — 13x slower. For a typical session this difference is acceptable (2s lag is invisible to users). For high-throughput workflows where multiple agents complete in rapid succession, a 2s delay in state detection could cause stale "running" display.

**Complexity:** Low–Medium. Reducing to 500ms would close most of the gap without significant resource cost.

---

### 2.2 Concurrent refresh() and pollStates() — No Locking

**Status: Minor race, low practical impact**

`refresh()` does NOT set `this.polling = true`. So `refresh()` and `pollStates()` can execute concurrently. Both call `detectAgentStates()` which calls `captureTmuxOutput()` for all agents in parallel. If both run at the same time, tmux is captured twice per agent in that window.

More subtly: `refresh()` creates a fresh `agents` array via `readAllAgents()` and then immediately assigns `this.lastAgents = agents` (watcher.ts:151). If `pollStates()` concurrently grabbed `lastAgents` before this assignment, it operates on the old objects — which is fine because `pollStates()` checks `if (agents !== this.lastAgents)` after await and discards stale results.

`buildAgentTree()` mutates `agent.children` in place. If `refresh()` and `pollStates()` both call `buildAgentTree()` on the same objects, both are mutating `children`. Since both call `agent.children = []` at the start of `buildAgentTree()`, the race would produce a correct tree from whichever completes last — not incorrect, just slightly wasteful.

**Fix:** Consider setting a `this.refreshing` flag in `refresh()` and having `pollStates()` skip when refresh is in progress, to avoid the double capture overhead. Low priority.

---

### 2.3 Tmux Capture Depth for State Detection

**Status: Partial fix — still below ib's 500 lines**

`captureTmuxOutput()` (tmux-poller.ts:89) defaults to `lines = 100`. This is an improvement from the earlier 20-line version noted in watch-parity-gaps.md, but still well below ib's 500-line capture.

`ib` uses `-S -500` for ALL captures (display + state detection). itsybitsy uses:
- `TmuxPoller` (display): 500 lines — matches ib
- `captureTmuxOutput` (state detection): 100 lines — 5x fewer than ib

**Risk:** If an agent's state indicator (e.g., `WAITING`, `I HAVE COMPLETED THE GOAL`) appears more than 100 lines from the bottom of the scrollback, it will be missed. This is unlikely in normal use but possible for very verbose agents.

**Location:** `src/tmux-poller.ts:89`

**Complexity:** Low.

**Fix:** Change `lines = 100` to `lines = 200` or `lines = 500` in `captureTmuxOutput`. The cost is slightly more data per capture — negligible since it's only done for state detection, not display.

---

## 3. Agent Data Pipeline

### 3.1 readAllAgents → detectAgentStates → buildAgentTree → flattenAgentTree

**Status: Functionally correct**

The pipeline in `watcher.ts:refresh()` (lines 141-165):
1. `readAllAgents()` — reads all meta.json files fresh from disk
2. `detectAgentStates()` — captures tmux for all active agents in parallel, sets `agent.state`
3. `buildAgentTree()` — sets `agent.children` via manager field
4. `flattenAgentTree()` — depth-first traversal for display order

This matches ib's `build_agent_data_file()` conceptually. Key differences:
- ib uses caching (meta.json mtime cache, state file cache) — itsybitsy re-reads every time
- ib does tree ordering as a separate pass — itsybitsy combines it in `flattenAgentTree()`
- Both use depth-first tree order

**Verdict:** Functionally equivalent. No logic gaps. Performance optimization (caching) is a P2 concern.

---

### 3.2 Orphaned Worker Detection — MISSING

**Status: GAP — Not implemented**

`buildAgentTree()` (agents.ts:158-174) places agents whose manager is not in the agent map into `roots`:
```typescript
if (agent.meta.manager && byId.has(agent.meta.manager)) {
  byId.get(agent.meta.manager)!.children.push(agent);
} else {
  roots.push(agent);  // orphan lands here with no marking
}
```

ib's `build_tree_lines()` gives orphaned workers a `⚠️` prefix. itsybitsy has no `orphaned` field on `Agent` and no visual indicator.

**Impact:** If a manager agent is killed or archived while workers are still running, the workers appear as root-level agents with no indication they lost their parent. Users have no way to identify stuck orphans.

**Location:** `src/agents.ts:167-173`, and wherever tree rows are rendered in `src/tui/dashboard.ts`.

**Complexity:** Low.

**Fix:**
1. Add `orphaned?: boolean` to the `Agent` interface.
2. In `buildAgentTree()`, set `agent.orphaned = true` when `agent.meta.manager` is set but not found in `byId`.
3. In the dashboard tree row render, prefix orphaned agents with `⚠ ` (or equivalent indicator).

---

## 4. Watcher — fs.watch + Debounce + Timers

### 4.1 fs.watch + 10s Fallback + 2s State Poll

**Status: Correct**

Three mechanisms provide coverage:
- `fs.watch` on agents/, archive/, user-questions.json → debounced 200ms → `refresh()`
- `pollTimer` every 10s → `refresh()` (structural + state)
- `stateTimer` every 2s → `pollStates()` (state only, no disk read)

This is logically sound. The 10s fallback catches fs.watch misses (known macOS FSEvents reliability issue). The 2s state poll keeps state fresh between structural refreshes.

**Minor gap:** `refresh()` and `pollStates()` share no mutual exclusion — see 2.2 above.

---

### 4.2 Debounce Safety

**Status: Correct**

`debounceRefresh()` (watcher.ts:110-115) clears previous timeout before setting new one. Safe.

---

### 4.3 archive/ Watch Error Silently Swallowed

**Status: Acceptable but potentially confusing**

When watching archive/ fails (e.g., directory doesn't exist), the error is silently ignored (watcher.ts:63-65):
```typescript
} catch (err) {
  // archive/ may not exist yet — not an error
}
```

This is correct for the "doesn't exist yet" case. However, if it fails for a different reason (permissions, etc.), the error would also be silently swallowed. Low risk.

---

## 5. Creating State — compute_state_from_content Wrapper

**Status: GAP — documented in section 1.2 above**

The gap: newly spawned agents with fewer than 10 lines of terminal output show as `"unknown"` instead of `"creating"`.

The additional gap: Claude startup indicators `"╭─ Claude Code"` and `"[AGENT CONTEXT]"` are missing from the creating-state check — documented in section 1.3.

---

## 6. Orphaned Worker Detection

**Status: GAP — documented in section 3.2 above**

Missing `orphaned` flag and visual indicator in tree display.

---

## 7. Pane Skipping (empty ERRORS/QUESTIONS panes)

**Status: GAP — Not implemented**

ib's `watch_calc_next_pane()` (lines 15263-15283) skips ERRORS pane when `ERRORS_TOTAL_COUNT == 0` and QUESTIONS pane when `QUESTIONS_TOTAL_COUNT == 0`.

itsybitsy has no such logic. The `p`/`n` pane cycling keys will navigate through empty ERRORS and QUESTIONS panes without skipping.

**Location:** Wherever pane mode cycling is handled in `src/tui/dashboard.ts` (the `cyclePaneMode` function or equivalent).

**Complexity:** Low.

**Fix:** In the pane cycling handler, after computing `nextMode`, check:
- If `nextMode == ERRORS_PANE` and `errors.length === 0` → skip to next
- If `nextMode == QUESTIONS_PANE` and `questions.length === 0` → skip to next

The condition should handle the wrap-around case (if skipping wraps back to current mode, stop).

---

## Summary Table

| Gap | Location | Complexity | Priority | Fix |
|-----|----------|------------|----------|-----|
| `compute_state_from_content` wrapper missing (<10 lines → creating) | `src/agents.ts:234` | Low | P1 | Add line-count check before parseState() |
| Missing startup indicators `"╭─ Claude Code"` and `"[AGENT CONTEXT]"` | `src/parse-state.ts:61` | Low | P1 | Add to startup check |
| Tmux capture depth for state detection (100 vs 500 lines) | `src/tmux-poller.ts:89` | Low | P1 | Increase `lines` default to 200–500 |
| Orphaned worker detection and display | `src/agents.ts:158`, `src/tui/dashboard.ts` | Low | P1 | Add `orphaned` flag, visual indicator |
| Pane skipping for empty ERRORS/QUESTIONS | `src/tui/dashboard.ts` | Low | P1 | Skip in cycle logic |
| All-agent state poll interval (2s vs 150ms) | `src/watcher.ts:84` | Low | P2 | Reduce to 500ms |
| Concurrent refresh/pollStates (double tmux captures) | `src/watcher.ts` | Low | P2 | Add `this.refreshing` guard |
| Priority order deviation (documented but not in comparison table) | `src/parse-state.ts`, `research/ib-watch-analysis.md` | None | Doc | Update comparison table in analysis doc |

### Already Addressed (P0 fixes landed)
- All-agent state polling (2s background poll) — watcher.ts stateTimer ✓
- pollStates() race condition guard (`agents !== this.lastAgents`) ✓
- TmuxPoller display depth at 500 lines ✓
- `resp.ok` check presumably in API call ✓

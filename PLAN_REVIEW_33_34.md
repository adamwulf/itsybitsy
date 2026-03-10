# PLAN.md Accuracy Review — Phases 33 & 34

Reviewed against actual source code on 2026-03-10.

---

## Phase 33: Parity Fixes — TUI Watch Features

### Overall structure — ACCURATE
- Source reference `PARITY_HOOKS_TUI.md (section 3)` exists ✓
- Status "Not started" — needs checking against 33a task list (see below)

### Note about 33a/33b removal — PARTIALLY INACCURATE

> "All five keybindings (t, w, o, c, Enter) exist in dashboard.ts"

**Finding:** All five keybindings exist in `dashboard.ts`:
- `t` at line 858
- `c` at line 867
- `w` at line 917
- `o` at line 919
- `Enter` at line 876 (answer question)

✓ Keybinding claim is accurate.

> "Usage tracking is fully implemented via src/usage.ts with status bar display and polling timer."

**Finding:** `src/usage.ts` exists with `fetchUsage()`, caching, and lock-file rate limiting. Dashboard imports `fetchUsage` and `UsageData` (dashboard.ts:30,32). ✓ Accurate.

### 33a: Settings/permissions editor — PARTIALLY INACCURATE

> **File:** `src/tui/dashboard.ts`, `src/tui/dialog-handler.ts`

**Finding:** `dialog-handler.ts` exists ✓. However, a setup dialog with three tabs ("Setup", "Project", "User") already exists at `dialog-handler.ts:697`. Tabs 1 and 2 (`buildConfigTabContent`) already show config values and support editing via `handleSetupConfigTab`.

**Issue:** The task says "Add settings tabs to setup dialog (project/user settings)" — but Project and User tabs already exist with config key editing. The task description is stale/inaccurate. What's actually missing is only the **permissions editor** (allow/deny tool lists), not the settings tabs themselves. The task should be rewritten to reflect this.

---

## Phase 34: Code Quality & Dead Code Cleanup

### Overall structure — ACCURATE
- Source reference `CODE_REVIEW.md` exists ✓
- Status "Not started" — correct

### 34a: Duplicate merge-check case — ACCURATE ✓

**Verified:** `src/index.ts:433` and `src/index.ts:451` both contain `case "merge-check":` with identical bodies. Second is dead code. Line numbers match exactly.

### 34b: Spawn runner count — INACCURATE

> "12 separate module-level mutable spawn runners with set*/reset* boilerplate. 10 of them use the same SpawnFn type"

**Actual count of module-level mutable spawn/test-injection variables:**

| # | File | Variable | Type |
|---|------|----------|------|
| 1 | tmux-poller.ts:11 | `spawnRunner` | SpawnFn |
| 2 | agent-lifecycle.ts:12 | `spawnRunner` | SpawnFn |
| 3 | watchdog.ts:77 | `spawnRunner` | SpawnFn |
| 4 | ib-commands.ts:36 | `killPauseSpawnRunner` | SpawnFn |
| 5 | ib-commands.ts:97 | `nukeResumeSpawnRunner` | SpawnFn |
| 6 | ib-commands.ts:700 | `mergeSpawnRunner` | SpawnFn |
| 7 | ib-commands.ts:980 | `sendSpawnRunner` | SpawnFn |
| 8 | ib-commands.ts:1112 | `newAgentSpawnRunner` | SpawnFn |
| 9 | ib-commands.ts:1878 | `diffStatusSpawnRunner` | SpawnFn |
| 10 | auto-compact.ts:139 | `compactSpawnRunner` | CompactSpawnFn |
| 11 | usage.ts:14 | `fetchFn` | FetchLike |
| 12 | usage.ts:27 | `spawnFn` | SpawnFn |
| 13 | ghostty.ts:14 | `spawnFn` | GhosttySpawnFn |
| 14 | ghostty.ts:13 | `whichFn` | WhichFn |

**Issues:**
1. Total is **14**, not 12. PLAN excludes `fetchFn` and `whichFn` as non-"spawn runners" but never states this.
2. PLAN says "10 of them use the same SpawnFn type" — actual SpawnFn count is **10** (items 1-9 + usage.ts:27). ✓ This part is correct only if you don't count `auto-compact.ts` (which uses CompactSpawnFn, a different type).
3. PLAN says `src/usage.ts` (`setTestSpawn`) uses `FetchLike` — **WRONG**. `setTestSpawn` at usage.ts:30 takes `SpawnFn`. It's `setTestFetch` at usage.ts:17 that uses `FetchLike`. PLAN conflates the two injection points in usage.ts.
4. `auto-compact.ts` uses `CompactSpawnFn` (a simpler type than SpawnFn) — PLAN doesn't mention this distinction.

### 34c: Consolidate runCmd helpers — MOSTLY ACCURATE ✓

**Verified locations and signatures:**

| Variant | File:Line | Drains stderr? | Pattern |
|---------|-----------|----------------|---------|
| `nukeResumeRunCmd` | ib-commands.ts:116 | Pipes but never reads | Deadlock risk ✓ |
| `mergeRunCmd` | ib-commands.ts:716 | `Promise.all` | Correct ✓ |
| `newAgentRunCmd` | ib-commands.ts:1131 | Sequential (`await` after stdout) | Sequential ✓ |
| `diffStatusRunCmd` | ib-commands.ts:1893 | `Promise.all` | Correct ✓ |
| `runCmd` | agent-lifecycle.ts:45 | Pipes but never reads | Deadlock risk ✓ |

- "tmux-poller.ts does NOT have a runCmd variant" — confirmed via grep ✓
- All line numbers match ✓
- Stderr patterns match descriptions ✓

**Minor note:** `newAgentRunCmd` (line 1134) does `await new Response(proc.stderr).text()` — it drains stderr but sequentially after stdout. PLAN calls this "sequential drain, safe but not parallel" which is accurate but slightly misleading — it IS safe against deadlocks because both streams are drained before awaiting exit. The only issue is potential slower performance, not deadlock. PLAN's parenthetical says "safe but not parallel" which is correct, but listing it under the same consolidation task as deadlock-risk variants could imply it's equally problematic.

### 34d: AGENT_CWD_PATTERN — ACCURATE ✓

**Verified:**
- `intercept-task.ts:25`: `/\.ittybitty\/agents\/([^/]+)\/repo(\/|$)/` — capturing group ✓
- `session-start.ts:18`: `/\.ittybitty\/agents\/([^/]+)\/repo(\/|$)/` — capturing group ✓
- `inject-status.ts:37`: `/\.ittybitty\/agents\/[^/]+\/repo(\/|$)/` — non-capturing ✓

All line numbers and capturing vs non-capturing claims match exactly.

### 34e: `as any` in production code — ACCURATE ✓

**Verified at `ib-commands.ts:1255`:**
```ts
const preToolUse = (baseSettings as any)?.hooks?.PreToolUse;
```
Line number and code match exactly.

### 34f: Conflicting AgentProvider types — ACCURATE ✓

**Verified:**
- `watchdog.ts:30`: `type AgentProvider = () => Agent[] | Promise<Agent[]>` — simple function type
- `inject-status.ts:120-124`: `interface AgentProvider { getRepos(), getAgents(), detectStates() }` — multi-method interface

Completely different types with the same name. Line numbers match.

### 34g: catch blocks without error binding — ACCURATE ✓

**Verified:** Grep for `catch {` across `src/` returns exactly **128 occurrences across 23 files**. Both numbers match the PLAN claim precisely.

### 34h: stderr deadlock in runCmd — ACCURATE ✓

Already verified under 34c above. Both `nukeResumeRunCmd` (ib-commands.ts:116-121) and `agent-lifecycle.ts:runCmd` (lines 45-50) pipe stderr but never drain it. Line numbers match.

**Note:** 34h overlaps with 34c — 34c proposes consolidating all 5 variants into a shared helper, while 34h specifically calls out the deadlock fix for the 2 affected variants. If 34c is done first, 34h becomes redundant. If done independently, 34h is a quick targeted fix. PLAN should note this overlap.

### 34i: sed for JSON modification — ACCURATE ✓

**Verified:**
- `ib-commands.ts:394`: `sed -i '' "s/}$/,\\n  \\"claude_pid\\": \\"$CLAUDE_PID\\"\\n}/" "${agentDir}/meta.json"` ✓
- `ib-commands.ts:1684`: identical sed command ✓

Both are inside bash heredoc strings (start script and resume script). Line numbers are exact.

---

## Summary

| Sub-phase | Verdict | Issues |
|-----------|---------|--------|
| 33 (note) | Partially inaccurate | Keybindings/usage ✓, but 33a task is stale — settings tabs already exist |
| 33a | Stale | Project/User config tabs already implemented; only permissions editor missing |
| 34a | ✓ Accurate | Line numbers verified |
| 34b | Inaccurate | Count is 14 not 12; `setTestSpawn` uses SpawnFn not FetchLike; CompactSpawnFn unmentioned |
| 34c | ✓ Accurate | All 5 variants, line numbers, and stderr patterns verified |
| 34d | ✓ Accurate | All 3 patterns, line numbers, and capturing behavior verified |
| 34e | ✓ Accurate | Exact line and code verified |
| 34f | ✓ Accurate | Both types verified as completely different |
| 34g | ✓ Accurate | 128 occurrences across 23 files confirmed |
| 34h | ✓ Accurate | Overlaps with 34c — should note dependency |
| 34i | ✓ Accurate | Both sed occurrences verified |

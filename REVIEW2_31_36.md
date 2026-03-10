# Second-Pass Review: PLAN.md Phases 31 & 36

## Phase 31: Parity Fixes — Hooks & Agent Status

### 31a: Delayed nudge recheck — PASS
Description accurately identifies the missing `sleep 5 && recheck` pattern. The TS code at `agent-status.ts:241-250` writes the timestamp and returns, with no delayed follow-up. Actionable and correct.

### 31b: Stop hook tmux send-keys timing — PASS
Description references lines 356-358 and 369-376. Confirmed: both code paths (`agent-status.ts:356-357` and `368-376`) send message+Enter in a single `send-keys` call. The fix (split into two calls with delay) is well-defined.

### 31c: Complete + unfinished children message — PASS
Code at `agent-status.ts:194` sends `"You have unfinished child agents: {ids}. Check on them before completing."` — shorter than bash's version with specific `ib merge/kill/list/look/status/diff` suggestions. Description is accurate.

### 31d: Nudge message formatting — PASS
Upgraded to should-fix with parse_state false positive explanation. Code at `agent-status.ts:256` confirms: `"Resume your work, or end with WAITING or I HAVE COMPLETED THE GOAL as your final line."` — no quotes around the phrases. The explanation about parse_state stripping quoted occurrences to prevent false positives is a valid rationale for the upgrade. Well-described.

### 31e: main-path comment stripping — PASS
Code at `main-path.ts:53`: regex `^([^&|;]*?)(\s*&&|\s*\|\||\s*;\s*|\s*\|)` does not handle `#` comments. A command like `cd /foo # comment` would resolve to `/foo # comment` (with the comment included). Description and fix are accurate.

### 31f: inject-status question counts — PASS
Code at `inject-status.ts:95-116` (`briefSummary`) counts agents by state but does not read `user-questions.json` or include question counts. Description is accurate.

### 31g: Debug file content in stop hook — PASS
Code at `agent-status.ts:105` writes only `lastMessage` to the debug file. Description correctly notes that tmux capture output and parse_state reason are missing. The cross-reference to watchdog debug logs (36b) is appropriate.

## Phase 36: Watchdog & Lifecycle Improvements

### 36a: Watchdog lock file atomicity — PASS
Code at `watchdog.ts:392-411` confirms the TOCTOU race: `readFileSync` → check PID → `writeFileSync`. The suggestion to use `O_EXCL` or advisory locking is correct. The note about migrating from `require("fs")` to `Bun.file()` is valid — `watchdog.ts:393` and `418` use `require("fs")`.

### 36b: Watchdog debug logs on unknown state — PASS
Added note about bash only saving on first *transition* into unknown. Confirmed: grep for "debug" in `watchdog.ts` returns zero matches — no debug log saving exists anywhere in the watchdog. The `handleUnknown` function (`watchdog.ts:248-261`) only increments counters and notifies manager. The transition-only detail is important for correct implementation. Well-described.

### 36c (was 36d): Model context size configuration — PASS
Correctly renumbered after removing old 36c. Code at `auto-compact.ts:44-52` confirms substring matching with no warning on fallback. The clarification that this is "code quality improvement, not parity issue" is accurate — bash uses the same approach. Description is actionable.

### Old 36c removal (auto-compact wiring) — PASS
Confirmed correctly removed. `watchdog.ts:24` imports `checkAndCompact`, and line 557 calls it in the watchdog loop. Auto-compact is already wired.

## Summary

| Item | Verdict |
|------|---------|
| 31a | PASS |
| 31b | PASS |
| 31c | PASS |
| 31d | PASS |
| 31e | PASS |
| 31f | PASS |
| 31g | PASS |
| 36a | PASS |
| 36b | PASS |
| 36c | PASS |
| Old 36c removal | PASS |

**No NEEDS-WORK or NEW-FINDING items.** All corrections from the first review cycle were applied accurately. Descriptions match the actual code, priorities are reasonable, and action items are well-defined.

# Third-Pass Review: PLAN.md Phases 31 & 36

This review verifies every sub-item against the current codebase for accuracy of file references, line numbers, behavior descriptions, priority ratings, and completeness.

## Phase 31: Parity Fixes — Hooks & Agent Status

### Phase 31 header

- **Source attribution:** Says "PARITY_HOOKS_TUI.md, PARITY_LIFECYCLE.md". Both files exist and contain relevant findings. PARITY_HOOKS_TUI.md covers items 31b, 31e, 31f, 31g (sections 1.3, 1.4, 1.5). PARITY_LIFECYCLE.md covers 31a, 31c, 31d. Correct.
- **Complexity:** "Medium — mostly localized changes in hook files and ib-commands.ts". No ib-commands.ts changes are actually needed in Phase 31 — all items target hook files only. Minor inaccuracy.

**Verdict: NIT** — Complexity description mentions `ib-commands.ts` but no Phase 31 item requires changes there. Suggest: "mostly localized changes in hook files."

---

### 31a: Delayed nudge recheck in stop hook (must-fix) — PASS

**File:** `src/hooks/agent-status.ts` — correct.

- Lines 241-242: debounce check returns early with `{ state, action: "debounced" }`.
- Lines 246-247: writes timestamp, no background recheck scheduled.
- Description accurately captures the missing `sleep 5 && ib hooks agent-status` pattern from bash.
- Priority "must-fix" is justified — agents stuck in debounce state may never recover.

---

### 31b: Stop hook tmux send-keys timing (must-fix) — PASS with NIT

**File:** `src/hooks/agent-status.ts:356-358,369-376` — line numbers are close but slightly imprecise.

- **First code path (nudge/remind):** The `Bun.spawn` call spans lines 356-360 (not just 356-358). The send-keys array literal is on line 357. Lines 358-360 are options, await, and closing brace.
- **Second code path (notify_manager):** The array literal spans lines 369-376. This is accurate, though the `Bun.spawn` call extends to line 379.
- Description correctly identifies that both paths send message+Enter in a single call.
- Reference to `sendMessage()` pattern in `ib-commands.ts` is correct — `ib-commands.ts:1057-1077` uses two separate tmux calls with `-l` flag and a calculated delay.

**Verdict: NIT** — Line range "356-358" would be more precise as "356-360" (or just "356-357" for the array). Not incorrect, just slightly narrow.

---

### 31c: Complete + unfinished children message (should-fix) — PASS

**File:** `src/hooks/agent-status.ts` — correct.

- Line 194: message is `"You have unfinished child agents: ${unfinishedChildren.join(", ")}. Check on them before completing."` — matches description.
- Description correctly notes bash includes specific command suggestions (`ib merge`, `ib kill`, `ib list`, `ib look`, `ib status`, `ib diff`).
- Priority "should-fix" is reasonable.

---

### 31d: Nudge message formatting (should-fix) — PASS

**File:** `src/hooks/agent-status.ts` — correct.

- Line 256: `"Resume your work, or end with WAITING or I HAVE COMPLETED THE GOAL as your final line."` — no quotes around the phrases, exactly as described.
- The explanation about `parse_state` stripping quoted occurrences to prevent false positives is a correct and important functional reason for the quotes (not just cosmetic).
- Priority correctly upgraded from "cosmetic" (first review) to "should-fix" (second review).

**Side note:** PARITY_LIFECYCLE.md line 57 incorrectly marks this as "MATCH" (`Both send the same nudge prompt: "...with 'WAITING' or 'I HAVE COMPLETED THE GOAL'..."`). The parity doc is wrong — TS omits the single quotes. This doesn't affect the PLAN item accuracy but is a stale finding in the source doc.

---

### 31e: main-path comment stripping (should-fix) — PASS

**File:** `src/hooks/main-path.ts` — correct.

- Line 53: regex `^([^&|;]*?)(\s*&&|\s*\|\||\s*;\s*|\s*\|)` does not include `#`.
- A command like `cd /foo # some comment` would resolve to path `/foo # some comment` (with trailing space + comment text).
- Test suggestion (`cd /foo # some comment` → `/foo`) is correct and actionable.

---

### 31f: inject-status question counts (should-fix) — PASS

**File:** `src/hooks/inject-status.ts` — correct.

- `briefSummary()` (lines 95-116) counts by state only. No reference to `user-questions.json` anywhere in the file.
- Second bullet about filtering dead/archived agents is a good detail.
- Priority "should-fix" is appropriate.

---

### 31g: Debug file content in stop hook (nice-to-have) — PASS

**File:** `src/hooks/agent-status.ts` — correct.

- Lines 100-108: debug file writes `lastMessage || "(no message)"` only. Missing: tmux capture output, parse_state reason.
- Cross-reference to `src/watchdog.ts` for unknown-state debug logs is correct — `handleUnknown()` (lines 248-261) has no debug logging.
- Priority "nice-to-have" is appropriate since debug files are diagnostic aids, not functional.

---

## Phase 36: Watchdog & Lifecycle Improvements

### Phase 36 header

- **Source attribution:** "PARITY_LIFECYCLE.md, CODE_REVIEW.md" — both exist and are relevant. Correct.
- **Complexity:** "Low-Medium" — appropriate for these items.

---

### 36a: Watchdog lock file atomicity (medium priority) — PASS

**File:** `src/watchdog.ts:392-411` — line numbers are exact.

- `acquireWatchdogLock()` at lines 392-411 confirmed.
- Line 393: `const { mkdirSync, writeFileSync, readFileSync } = require("fs");` — confirmed `require("fs")` usage.
- Lines 400-406: read + check PID alive.
- Line 409: `writeFileSync` — the write step has no atomicity guarantee.
- TOCTOU race is real and correctly described.
- `O_EXCL` suggestion is appropriate.
- Note about migrating from `require("fs")` to `Bun.file()` is correct and references CODE_REVIEW.md (L1).
- Priority "medium" is appropriate — the race window is tiny and watchdog is typically started once.

---

### 36b: Watchdog debug logs on unknown state (nice-to-have) — PASS

**File:** `src/watchdog.ts` — correct (no specific line numbers given, which is fine since the issue is *absence* of code).

- `handleUnknown()` at lines 248-261 confirmed — only counter increment and manager notification, no debug logging.
- Description correctly notes bash only saves on first *transition* into unknown state (added in second review).
- `debug-logs/` directory pattern matches bash convention.
- Priority "nice-to-have" is appropriate.

---

### 36c: Model context size configuration (low priority) — PASS

**File:** `src/auto-compact.ts:44-52` — line numbers are exact.

- `contextSizeForModel()` at lines 44-52: checks for "4-5"/"4.5" (1M), "4-6"/"4.6" (200K), default 200K.
- No warning on fallback to default — correctly identified.
- Description correctly notes this is "code quality improvement, not a parity issue" (bash uses the same approach).
- Suggestions (log warning, named lookup table) are both reasonable.
- Priority "low" is appropriate.

---

## Summary

| Item | Verdict | Notes |
|------|---------|-------|
| Phase 31 header | NIT | Mentions `ib-commands.ts` in complexity but no item targets it |
| 31a | PASS | Accurate, well-defined |
| 31b | PASS (NIT) | Line range "356-358" slightly narrow (356-360 more complete) |
| 31c | PASS | Accurate |
| 31d | PASS | Accurate, priority correctly upgraded |
| 31e | PASS | Accurate |
| 31f | PASS | Accurate |
| 31g | PASS | Accurate |
| Phase 36 header | PASS | Accurate |
| 36a | PASS | Line numbers exact, description precise |
| 36b | PASS | Accurate, transition-only detail included |
| 36c | PASS | Line numbers exact, correctly scoped as code quality |

**Overall: ALL PASS.** Two minor nits found (Phase 31 header complexity wording, 31b line range slightly narrow). No inaccuracies, no stale info, no missing edge cases. The items are well-defined and actionable.

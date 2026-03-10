# Deep Accuracy Review: PLAN.md Phases 35 & 36

Review date: 2026-03-10. Verified against current source on branch `main` (commit 35928fd).

---

## Phase 35: Test Coverage Improvements

### Phase 35 header

- **Source:** Says "CODE_REVIEW.md (M5, M6, I1)". Verified: M5 is at line 102 (CLI entrypoint tests), M6 at line 109 (TUI module tests), I1 at line 207 (test coverage summary). All exist and are relevant. **PASS.**
- **Complexity:** "Medium-High — several modules need test scaffolding." Reasonable. **PASS.**

---

### 35a: CLI entrypoint tests (high priority) — PASS

**File:** `src/index.ts` (707 lines, no test file)

- Line count verified: `wc -l` returns 707. Correct.
- No `src/index.test.ts` exists. Confirmed.
- "The main CLI switch has no tests, including the duplicate `merge-check` case." — Confirmed. The duplicate `merge-check` at lines 433 and 451 is still present (cross-ref Phase 34a).
- "`collect()` and `findManager()` from inline closures" — Confirmed: `collect` is defined at line 110 as a nested function inside the `list` command handler; `findManager` is defined at line 131 as a nested function inside the same block. Both are closures over `agentsToShow` and `managerFilter`. Accurately described.
- Test command list (`list`, `look`, `diff`, `status`, `tree`, `merge-check`, `questions`, `acknowledge`) — these are all valid CLI commands in the switch statement. The full CLI has more commands (kill, nuke, send, new-agent, resume, reassign, pause, watch, watchdog, hooks, etc.) but those are covered by `ib-commands.test.ts` and `watchdog.test.ts`. The listed subset targets the entrypoint routing logic specifically. Reasonable scope.

---

### 35b: TUI module tests (medium priority) — PASS

**Files:** `src/tui/agent-actions.ts`, `src/tui/pane-manager.ts`, `src/tui/dialog-handler.ts`

- All three files exist. Confirmed via glob.
- No corresponding `.test.ts` files exist for any of them. Confirmed: the `src/tui/` directory has test files for `dashboard`, `split-pane`, `wrap`, `color-scheme`, `ansi-validation`, `folder-browser`, and `setup-dialog` — but none for `agent-actions`, `pane-manager`, or `dialog-handler`.
- Suggested test file names and test scope descriptions are reasonable.

---

### 35c: Test infrastructure improvements (low priority) — FAIL — description is misleading/outdated

**Claim:** "Heavy `as any` usage (81 occurrences across 7 test files) for mock creation."
**Action item:** "Create shared mock factory in `test-utils.ts` that produces properly-typed Agent objects"

**Issues found:**

1. **`test-utils.ts` already exists** with `makeAgent()`, `makeFlatAgent()`, and `makeFlatRepoHeader()` factories. It's already imported by 5 test files (`agents.test.ts`, `dashboard.test.ts`, `ib-commands.test.ts`, `watcher.test.ts`, `watchdog.test.ts`). The action item to "create" it is wrong — it should say "extend and adopt more widely."

2. **The `as any` count (81) is correct**, but the characterization as "for mock creation" is inaccurate. Breakdown by category:
   - `dashboard.test.ts` (45): Most are `agent.state = "running" as any` — casting string literals to a narrower state type. The file already uses `makeAgent` from test-utils. The issue isn't mock creation but state-type narrowing.
   - `usage.test.ts` (8): All are `setTestFetch((...) as any)` — casting mock fetch functions. Unrelated to Agent mocking.
   - `watcher.test.ts` (14): Mix of agent mocks and watcher dependency mocks.
   - `ib-commands.test.ts` (11): Spawn runner mocks.
   - `watchdog.test.ts` (1), `agents.test.ts` (1), `setup-dialog.test.ts` (1): Misc.

   Only a fraction of the 81 `as any` casts would be resolved by improving Agent mock factories. The majority are for non-Agent mock types (spawn runners, fetch functions, TUI dependencies) or state-type narrowing.

3. **Fix suggestion:** Rewrite to: "Extend existing `test-utils.ts` mock factories and add typed helpers for spawn runners, fetch mocks, and agent state assignment to reduce `as any` casts (81 occurrences across 7 test files)."

---

### 35d: Validate `readAgentMeta` more thoroughly (medium priority) — PASS

**File:** `src/agents.ts:70-84` (`readAgentMeta` function)

- Line reference updated from prior review (was `:84`, now `:70-84`). Verified: function starts at line 70, ends at line 88 (including catch block). Lines 70-84 capture the core validation logic through the `as AgentMeta` cast. Close enough, though `:70-88` would cover the full function.
- "Only `id` (line 77) and `tmux_session` (line 81, with string default) are type-checked" — Confirmed:
  - Line 77: `typeof data.id !== "string"` check
  - Lines 81-82: `typeof data.tmux_session !== "string"` check, defaults to `""`
  - Line 84: `return { meta: data as AgentMeta }` — everything else passes through unchecked
- "Other fields (`created_epoch`, `worker`, `model`, `branch`, etc.) are cast without validation" — Confirmed. `AgentMeta` type includes these fields but `readAgentMeta` doesn't validate them.
- Action items are clear and actionable.

---

### 35e: Config type validation (low priority) — PASS

**File:** `src/config.ts:88-106`

- Line reference verified: `readConfig()` function body spans lines 81-106. Lines 88-103 are the `for` loop that processes config keys. The loop at line 90-91 stores `projectVal` directly without checking against `def.type`. Same at lines 95-96 for `userVal`. Confirmed: no runtime type validation anywhere.
- `ConfigKeyDef` (line 7-11) defines a `type: ConfigType` field (`"number" | "boolean" | "string" | "string[]"`) but `readConfig` never uses it.
- The example `"maxAgents": "ten"` would indeed be stored as the string `"ten"` when the config definition expects a number. Correct.
- Action items are clear.

---

## Phase 36: Watchdog & Lifecycle Improvements

### Phase 36 header

- **Source:** "PARITY_LIFECYCLE.md, CODE_REVIEW.md" — Both files exist. PARITY_LIFECYCLE.md has a "Watchdog" section (line 131+) covering lock file, debug logs, and state handling. CODE_REVIEW.md has relevant entries. **PASS.**
- **Complexity:** "Low-Medium" — Reasonable for the scope of changes. **PASS.**

---

### 36a: Watchdog lock file atomicity (medium priority) — PASS with nit

**File:** `src/watchdog.ts:392-411`

- Line reference verified exactly: `acquireWatchdogLock()` defined at line 392, closing brace at line 411.
- TOCTOU race description is accurate:
  - Line 400-405: reads lock file, parses PID, checks if alive
  - Line 409: writes current PID
  - Between lines 405 and 409, another process could do the same check and also proceed to write. Classic TOCTOU.
- `O_EXCL` suggestion is appropriate — Bun supports `Bun.write()` but doesn't directly expose `O_EXCL`. Would need `node:fs` `openSync` with `O_CREAT | O_EXCL` flags, or `Bun.file().writer()` equivalent. The action item is correct in principle but the implementation path needs care.
- "`require("fs")` sync APIs" — Confirmed at lines 393, 418, 432. Three separate `require("fs")` destructurings in `acquireWatchdogLock`, `releaseWatchdogLock`, and `isWatchdogLockHeld`. This is the only file using `require("fs")` in the codebase.
- **Nit:** The action item says "migrate from `require("fs")` sync APIs to `Bun.file()`/`Bun.write()` for consistency (L1 from CODE_REVIEW.md)". However, the `O_EXCL` fix would likely still need `node:fs` `openSync` — so migrating to `Bun.file()` and implementing atomic creation may be conflicting goals. The plan should note that `O_EXCL` may require keeping `node:fs` for the lock acquisition specifically, while migrating the other two functions (`releaseWatchdogLock`, `isWatchdogLockHeld`) to Bun APIs.

---

### 36b: Watchdog debug logs on unknown state (nice-to-have) — PASS

**File:** `src/watchdog.ts`

- Confirmed: no `debug-log` or `debug_log` references anywhere in `src/watchdog.ts`. The TS watchdog does not save debug output on unknown state transitions.
- PARITY_LIFECYCLE.md line 141 confirms: `"unknown" | Same as waiting + saves debug log | Same backoff behavior; no debug log saved | MINOR DIFF`.
- Description about bash saving only on the *transition into* unknown state (not every tick) is a useful implementation detail. Confirmed by the characterization "captures the moment the state became unclear."
- Action items are clear and appropriately scoped.

---

### 36c: Model context size configuration (low priority) — PASS with nit

**File:** `src/auto-compact.ts:44-52`

- Line reference verified: `contextSizeForModel()` spans lines 44-52.
- Function checks:
  - Line 45: `"4-5"` or `"4.5"` → 1,000,000
  - Line 48: `"4-6"` or `"4.6"` → 200,000
  - Line 51: default → 200,000
- "Hardcoded model context sizes with substring matching" — Accurate.
- "New models silently get 200K default with no warning" — Accurate. No log/warning on the default fallback path.
- **Note clarification is accurate:** "This is a code quality improvement, not a parity issue — bash uses the same substring matching approach." Confirmed by the code comment at lines 41-42 ("Matches ib's logic").
- **Nit:** The description doesn't mention that 4.6 models are explicitly handled (lines 48-49) with 200K, which is the same as the default. This explicit branch is redundant code — if 4.6 were removed, behavior would be identical. The plan could note this as minor dead code, though it serves as documentation that 4.6 was considered.

---

## Summary

| Item | Verdict | Issue |
|------|---------|-------|
| 35a | **PASS** | All claims verified |
| 35b | **PASS** | All claims verified |
| 35c | **FAIL** | `test-utils.ts` already exists with `makeAgent()`; action item says "create" when it should say "extend". Most `as any` casts are not for Agent mock creation but for spawn runners, fetch mocks, and state-type narrowing. Description mischaracterizes the problem. |
| 35d | **PASS** | Line references and validation gaps confirmed |
| 35e | **PASS** | Config type bypass confirmed |
| 36a | **PASS** (nit) | `O_EXCL` fix may conflict with "migrate to Bun APIs" goal — note that `node:fs` may still be needed for atomic lock creation |
| 36b | **PASS** | Missing debug log confirmed |
| 36c | **PASS** (nit) | Explicit 4.6 branch is redundant (same as default); could note as minor dead code |

**1 item FAIL (35c), 7 items PASS (2 with nits).**

### Recommended fixes:
1. **35c:** Rewrite to acknowledge existing `test-utils.ts`, change "create" to "extend", and broaden scope beyond Agent mocking to cover spawn runners, fetch mocks, and state-type helpers.
2. **36a (nit):** Note that `O_EXCL` likely requires `node:fs`, so the Bun migration applies to `releaseWatchdogLock`/`isWatchdogLockHeld` but not necessarily to `acquireWatchdogLock`.
3. **36c (nit):** Optionally note that the explicit 4.6 branch (lines 48-49) returns the same value as the default and is effectively dead code.

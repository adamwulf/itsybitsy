# Third-Pass Accuracy Review: PLAN.md Phases 34 & 35

## Phase 34: Code Quality & Dead Code Cleanup

### 34a: Fix duplicate `merge-check` case in CLI (high priority)
**PASS**
- File reference `src/index.ts:433,451` — confirmed: `merge-check` case appears at lines 433 and 451.
- Line count "707 lines" matches `src/index.ts` exactly.
- Description is accurate: second occurrence is dead code due to switch semantics.

### 34b: Consolidate spawn runner injection (medium priority)
**FAIL — count and file list are wrong**
- Claims "12 separate module-level mutable spawn runners." Actual count of `set*Runner`/`set*Spawn` functions in non-test production code: **10** (not 12):
  1. `src/ib-commands.ts`: `setKillPauseSpawnRunner` (L39)
  2. `src/ib-commands.ts`: `setNukeResumeSpawnRunner` (L102)
  3. `src/ib-commands.ts`: `setMergeSpawnRunner` (L703)
  4. `src/ib-commands.ts`: `setSendSpawnRunner` (L985)
  5. `src/ib-commands.ts`: `setNewAgentSpawnRunner` (L1117)
  6. `src/ib-commands.ts`: `setDiffStatusSpawnRunner` (L1881)
  7. `src/tmux-poller.ts`: `setSpawnRunner` (L14)
  8. `src/auto-compact.ts`: `setCompactSpawnRunner` (L142)
  9. `src/watchdog.ts`: `setWatchdogSpawnRunner` (L80)
  10. `src/agent-lifecycle.ts`: `setSpawnRunner` (L15)
  Plus two more with different naming convention:
  11. `src/usage.ts`: `setTestSpawn` (L30)
  12. `src/ghostty.ts`: `setSpawn` (L27)
- OK, so the count of 12 is actually correct when including `usage.ts` and `ghostty.ts` with their differently-named functions (`setTestSpawn`, `setSpawn`). But these have different type signatures (`FetchLike` composite in usage, `GhosttySpawnFn` in ghostty), so lumping them all as "near-identical `set*/reset*` boilerplate" is slightly misleading. The 10 `SpawnFn`-typed ones are near-identical; the other 2 use different interfaces.
- **Nit:** The file list includes `src/usage.ts` but `usage.ts` uses `setTestSpawn` (not `setSpawnRunner`) and has a `FetchLike` dependency too — its runner pattern is not identical.

### 34c: Consolidate `runCmd` helpers (low priority)
**PASS with nits**
- 5 variants confirmed: `nukeResumeRunCmd` (L116), `mergeRunCmd` (L716), `newAgentRunCmd` (L1131), `diffStatusRunCmd` (L1893) in `ib-commands.ts`, plus `runCmd` (L45) in `agent-lifecycle.ts`.
- Deadlock risk analysis is accurate:
  - `nukeResumeRunCmd` (L116): pipes stderr but only reads stdout — confirmed deadlock risk.
  - `agent-lifecycle.ts:runCmd` (L45): same pattern — confirmed deadlock risk.
  - `newAgentRunCmd` (L1131): reads stdout then drains stderr sequentially — confirmed. (Plan says "reads stderr after stdout" which is correct.)
  - `mergeRunCmd` (L716): uses `Promise.all` — confirmed correct.
  - `diffStatusRunCmd` (L1893): uses `Promise.all` — confirmed correct.
- Statement "src/tmux-poller.ts does NOT have a runCmd variant" — confirmed, no `runCmd` function in tmux-poller.ts.
- **Nit:** The line reference for `nukeResumeRunCmd` says `ib-commands:116` which is correct. The reference for `newAgentRunCmd` says `ib-commands:1131` which is correct. The reference for `mergeRunCmd` says `ib-commands:716` which is correct. The reference for `diffStatusRunCmd` says `ib-commands:1893` which is correct. The reference for `agent-lifecycle.ts:runCmd` says "line 45" which is correct.
- **Nit:** The 3 stderr patterns are described as categories but the action item says "Replace all 5 variants" — this is slightly redundant with 34h which also covers the deadlock fix. The plan should clarify that 34c is about unification (single shared helper) while 34h is about the immediate deadlock fix, or merge them.

### 34d: Extract shared constants (low priority)
**PASS**
- `AGENT_CWD_PATTERN` confirmed at:
  - `intercept-task.ts:25`: `/\.ittybitty\/agents\/([^/]+)\/repo(\/|$)/` — capturing group ✓
  - `inject-status.ts:37`: `/\.ittybitty\/agents\/[^/]+\/repo(\/|$)/` — non-capturing ✓
  - `session-start.ts:18`: `/\.ittybitty\/agents\/([^/]+)\/repo(\/|$)/` — capturing group ✓
- Description of the difference (capturing vs non-capturing) is accurate.
- **Nit:** The file reference says `src/hooks/inject-status.ts:37` but should be verified — confirmed at line 37. Correct.

### 34e: Fix `as any` in production code (medium priority)
**PASS**
- `src/ib-commands.ts:1255` — confirmed: `(baseSettings as any)?.hooks?.PreToolUse`.
- Description is accurate.

### 34f: Rename conflicting `AgentProvider` type (low priority)
**PASS with nit**
- `src/watchdog.ts:30` — confirmed: `export type AgentProvider = () => Agent[] | Promise<Agent[]>;`
- `src/hooks/inject-status.ts:120-124` — confirmed: `export interface AgentProvider { getRepos()...; getAgents()...; detectStates()...; }` at lines 120-124.
- These are indeed completely different types with the same name.
- **Nit:** The suggested rename `AgentDataSource` is reasonable but the plan doesn't mention that both are exported, so a rename of either one will affect their respective consumers. This is minor.

### 34g: Audit catch blocks without error binding (low priority)
**FAIL — count is wrong**
- Claims "128 `catch {` blocks across 23 files."
- Actual count: **128 total** across all `.ts` files (test + non-test) — confirmed 128.
- File count: 23 total files — confirmed.
- However, the breakdown is 122 in non-test files and 6 in test files. The description says "across 23 files" — the total file count (test + non-test) is 23 + some test overlap. Let me re-examine: `grep -rl 'catch {' src/ --include='*.ts' | wc -l` returned 23. But this includes test files. The description doesn't distinguish test vs. non-test, which is fine since it says "Multiple" files.
- Wait, actually the total count was 128 (from my earlier check). Non-test files: 122. Test files: 6. Total: 128. 23 total files. So the count of 128 and 23 files is correct.
- **Actually PASS.** The counts check out.

### 34h: Fix stderr deadlock in runCmd variants (medium priority)
**PASS with overlap concern**
- `src/ib-commands.ts:116-121` (`nukeResumeRunCmd`) — confirmed. Lines 116-121 show the function pipes stderr but never drains it.
- `src/agent-lifecycle.ts:45-50` (`runCmd`) — confirmed. Same pattern.
- Overlap with 34c noted: 34c is about consolidation, 34h is about the specific deadlock fix. Both reference the same functions. The plan could note that completing 34c would subsume 34h, but having them separate is fine for tracking.

### 34i: Use `sed` alternative for JSON modification in start.sh/resume.sh (low priority)
**FAIL — line reference is inaccurate**
- Claims `src/ib-commands.ts:392-395`. The `sed` usage at line 392-395 is in a bash heredoc for the start script. This is confirmed.
- However, there's a SECOND identical `sed` usage at line 1682-1685 (in the resume script heredoc) that is not mentioned. The plan only references one location but should reference both. The title says "start.sh/resume.sh" which implies awareness of both, but the line reference only covers the start script.
- **Fix:** Add second line reference `src/ib-commands.ts:1682-1685` for the resume script.

---

## Phase 35: Test Coverage Improvements

### 35a: CLI entrypoint tests (high priority)
**PASS with nits**
- `src/index.ts` at 707 lines — confirmed.
- No `src/index.test.ts` file exists — confirmed.
- The duplicate `merge-check` case is mentioned, cross-referencing 34a — accurate.
- `collect()` function exists at line 110, `findManager()` at line 131 — confirmed as inline closures.
- **Nit:** The suggested test commands (`list`, `look`, `diff`, `status`, `tree`, `merge-check`, `questions`, `acknowledge`) should be verified against the actual CLI switch. The plan lists 8 commands; the actual CLI has more (kill, nuke, send, new-agent, etc.), but those are tested via `ib-commands.test.ts`. The listed subset is reasonable for the entrypoint routing logic.

### 35b: TUI module tests (medium priority)
**PASS**
- `src/tui/agent-actions.ts` exists, no test file — confirmed.
- `src/tui/pane-manager.ts` exists, no test file — confirmed.
- `src/tui/dialog-handler.ts` exists, no test file — confirmed.
- Suggested test file names are reasonable.

### 35c: Test infrastructure improvements (low priority)
**FAIL — count is slightly off**
- Claims "80+ occurrences across 7 test files" of `as any` in test files.
- Actual count: **81** occurrences across **7** test files. So "80+" is technically correct (81 ≥ 80), but it's a soft count that happens to be barely above the threshold.
- **Nit:** Consider updating to "~80 occurrences" or "81 occurrences" for precision, though "80+" is defensible.

### 35d: Validate `readAgentMeta` more thoroughly (medium priority)
**FAIL — line reference is wrong**
- Claims `src/agents.ts:84`. The function `readAgentMeta` is defined at line **70**, not line 84. Line 84 is `return { meta: data as AgentMeta }` — the cast line, not the function definition.
- If the intent is to point to the specific cast (where unvalidated fields pass through), then line 84 is arguably the right reference, but the description says "Only `id` and `tmux_session` are type-checked" which describes the function's validation logic (lines 77-83), not just the cast point.
- **Fix:** Change to `src/agents.ts:70-84` to cover the full function, or `src/agents.ts:77` to point to where validation begins.
- Content is accurate: only `id` (L77) and `tmux_session` (L81) are validated; other fields like `created_epoch`, `worker`, `model` are indeed cast without checks.

### 35e: Config type validation (low priority)
**PASS with nit**
- `src/config.ts:88-106` — confirmed. Lines 88-102 show the config loading loop that stores values without type-checking against `ConfigKeyDef.type`. Line 106 closes the function.
- The description is accurate: values from JSON are stored as-is without runtime type validation.
- **Nit:** The example `"maxAgents": "ten"` nicely illustrates the problem. The action items are clear.

---

## Summary

| Item | Verdict | Issue |
|------|---------|-------|
| 34a | PASS | — |
| 34b | PASS (marginal) | Count of 12 is technically correct but 2 of 12 use different type signatures — "near-identical" is slightly misleading |
| 34c | PASS | Minor overlap with 34h noted |
| 34d | PASS | — |
| 34e | PASS | — |
| 34f | PASS | — |
| 34g | PASS | Counts verified: 128 blocks, 23 files |
| 34h | PASS | Overlap with 34c |
| 34i | **FAIL** | Missing second `sed` location at L1682-1685 (resume script). Title says "start.sh/resume.sh" but line reference only covers start. |
| 35a | PASS | — |
| 35b | PASS | — |
| 35c | PASS (marginal) | 81 occurrences — "80+" is barely accurate |
| 35d | **FAIL** | Line reference `src/agents.ts:84` should be `:70-84` or `:70` (function definition) |
| 35e | PASS | — |

**2 items FAIL, 12 items PASS (2 marginal).**

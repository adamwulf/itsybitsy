# Second-Pass Review: PLAN.md Phases 34 & 35

## Phase 34: Code Quality & Dead Code Cleanup

### 34a: Fix duplicate `merge-check` case — PASS
- Verified: lines 433 and 451 in `src/index.ts` are identical `merge-check` cases. Second is dead code (JS switch falls through to the first match). Description is accurate and actionable.

### 34b: Consolidate spawn runner injection — PASS
- Verified 12 spawn runners:
  - `src/ib-commands.ts`: 6 (killPause, nukeResume, merge, send, newAgent, diffStatus)
  - `src/agent-lifecycle.ts`: 1 (spawnRunner)
  - `src/tmux-poller.ts`: 1 (spawnRunner)
  - `src/watchdog.ts`: 1 (spawnRunner)
  - `src/auto-compact.ts`: 1 (compactSpawnRunner)
  - `src/usage.ts`: 1 (spawnFn/setTestSpawn)
  - `src/ghostty.ts`: 1 (spawnFn/setSpawn)
- Count of 12 is correct. File list is correct including ghostty.ts.

### 34c: Consolidate `runCmd` helpers — NEEDS-WORK
- Verified 5 variants: 4 in ib-commands.ts + 1 in agent-lifecycle.ts. File list correct.
- **Issue:** The description says "They differ in stderr handling — some drain it, some don't" but the reality is more nuanced:
  - `nukeResumeRunCmd` (ib-commands:116): pipes stderr but never drains — **deadlock risk**
  - `agent-lifecycle.ts:runCmd` (line 45): pipes stderr but never drains — **deadlock risk**
  - `newAgentRunCmd` (ib-commands:1131): drains stderr **sequentially** after stdout (line 1134) — not a deadlock but suboptimal
  - `mergeRunCmd` (ib-commands:716): drains correctly with `Promise.all`
  - `diffStatusRunCmd` (ib-commands:1893): drains correctly with `Promise.all`
- The description should distinguish three categories rather than two. `newAgentRunCmd` is a third pattern (sequential drain, safe but not parallel).

### 34d: Extract shared constants — PASS
- Verified all 3 files:
  - `intercept-task.ts:25`: `([^/]+)` — capturing group
  - `session-start.ts:18`: `([^/]+)` — capturing group
  - `inject-status.ts:37`: `[^/]+` — non-capturing
- Description is accurate including the capture group difference note.

### 34e: Fix `as any` in production code — PASS
- Verified: `src/ib-commands.ts:1255` has `(baseSettings as any)?.hooks?.PreToolUse`. Description accurate.

### 34f: Rename conflicting `AgentProvider` type — PASS
- Verified:
  - `src/watchdog.ts:30`: `type AgentProvider = () => Agent[] | Promise<Agent[]>`
  - `src/hooks/inject-status.ts:120-124`: `interface AgentProvider { getRepos, getAgents, detectStates }`
- Completely different shapes, same name. Description accurate.

### 34g: Audit catch blocks without error binding — PASS
- Verified: 128 `catch {` blocks across 23 files. Numbers match exactly.
- Description is well-clarified from round 1 — correctly notes they have meaningful bodies, just no error binding.

### 34h: Fix stderr deadlock in runCmd variants — PASS
- Verified:
  - `nukeResumeRunCmd` (ib-commands:116-121): pipes stderr, never reads it
  - `agent-lifecycle.ts:runCmd` (line 45-50): pipes stderr, never reads it
  - `mergeRunCmd` (ib-commands:716-724): correctly uses `Promise.all`
- Description is accurate. Both files correctly identified.

### 34i: Use `sed` alternative for JSON modification — PASS
- Verified: `src/ib-commands.ts:392-395` uses `sed -i ''` to insert `claude_pid` into meta.json. Description accurate.

### NEW-FINDING: `newAgentRunCmd` also has a stderr handling issue
- `newAgentRunCmd` (ib-commands:1131-1137) drains stderr sequentially AFTER stdout (line 1134). While this avoids the deadlock (stdout is fully consumed first, so the pipe buffer won't block), it's still not using `Promise.all` like the other "correct" implementations. This should be mentioned in 34c or 34h as a third pattern to consolidate.

## Phase 35: Test Coverage Improvements

### 35a: CLI entrypoint tests — NEEDS-WORK
- **Line count:** PLAN says 708 lines; actual is 707 lines. Minor but should be corrected.
- `collect()` and `findManager()` inline closures confirmed at lines 110 and 131. The suggestion to extract them is valid and actionable.
- Otherwise accurate.

### 35b: TUI module tests — PASS
- Confirmed: no test files exist for `agent-actions.ts`, `pane-manager.ts`, or `dialog-handler.ts`.
- All three source files exist. Description is accurate and actionable.

### 35c: Test infrastructure improvements — PASS
- Verified: 81 `as any` occurrences across 7 test files. PLAN says "80+" which is accurate (81 matches "80+").
- File count of 7 is exact.

### 35d: Validate `readAgentMeta` more thoroughly — PASS
- Verified at `src/agents.ts:84`: only `id` (string check) and `tmux_session` (string check with default) are validated. All other fields (`created_epoch`, `worker`, `model`, `branch`, etc.) pass through `as AgentMeta` unchecked.
- Description accurate and actionable.

### 35e: Config type validation — PASS
- Verified at `src/config.ts:88-106`: values from JSON files are stored in `result[def.key]` without any type checking against `def.type`. A string value for a number config key would be silently accepted.
- Description accurate and actionable.

## Summary

| Item | Verdict |
|------|---------|
| 34a | PASS |
| 34b | PASS |
| 34c | NEEDS-WORK — should distinguish 3 stderr patterns (none/sequential/parallel), not just 2 |
| 34d | PASS |
| 34e | PASS |
| 34f | PASS |
| 34g | PASS |
| 34h | PASS |
| 34i | PASS |
| 35a | NEEDS-WORK — line count is 707, not 708 |
| 35b | PASS |
| 35c | PASS |
| 35d | PASS |
| 35e | PASS |
| NEW | `newAgentRunCmd` sequential stderr drain is a third pattern not called out in 34c or 34h |

Overall: phases 34 and 35 are well-defined and accurate after the first review cycle. Two minor corrections needed (34c nuance, 35a line count) and one new finding about `newAgentRunCmd`'s stderr pattern.

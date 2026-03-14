# itsybitsy Documentation Consistency Review Report

**Date:** 2026-03-14
**Reviewed by:** 4 worker agents (lifecycle, hooks, config/TUI, state/README/CLAUDE)
**Source of truth:** Source code

---

## Summary

| Category | Count |
|----------|-------|
| SPEC.md inconsistencies (must fix — SPEC should be 100% accurate) | 10 |
| CLAUDE.md inconsistencies | 4 |
| README.md inconsistencies | 2 |
| Code comment inconsistencies | 1 |
| **Total** | **17** |

---

## SPEC.md Inconsistencies

These are the highest priority since SPEC.md is supposed to be 100% accurate.

### S1. §5.2 meta.json schema missing `watchdog_pid` field
- **What SPEC says:** §5.2 meta.json example (lines 392–406) and fields table (lines 409–422) do NOT include `watchdog_pid`
- **What code does:** `ib-commands.ts` lines 492 and 1839 write `watchdog_pid` to `meta.json`. §1.1 step 16 and §8.5 both reference it.
- **Fix:** Add `watchdog_pid` to §5.2 example and fields table

### S2. §1.1 creation steps missing prompt summary generation
- **What SPEC says:** §1.1 lists creation steps ending at step 17 ("Output"), no step for prompt summary
- **What code does:** After the watchdog spawn, `generatePromptSummary()` is called (fire-and-forget). This is documented in §8.9 but missing from §1.1's step list.
- **Fix:** Add a step to §1.1 referencing §8.9 for prompt summary generation

### S3. §5.1 watchdog debug log filename uses generic `<state>` placeholder
- **What SPEC says:** §5.1 directory listing shows `watchdog-<epoch>-<state>.txt` (implying multiple states possible)
- **What code does:** `watchdog.ts` line 295 hardcodes `watchdog-${timestamp}-unknown.txt`; §8.5 also documents "only 'unknown' state is logged"
- **Fix:** §5.1 should use `watchdog-<epoch>-unknown.txt` to match §8.5 and actual code

### S4. §8.5 watchdog state table omits `rateLimitBypassed` resets
- **What SPEC says:** §8.5 table documents counter/completion flag resets for running/creating/compacting states but never mentions `rateLimitBypassed`
- **What code does:** `handleRunning()` resets both `completionNotified` AND `rateLimitBypassed` (line 326); `handleCreating()` and `handleCompacting()` each reset `rateLimitBypassed`
- **Fix:** Add `rateLimitBypassed` reset to the running/creating/compacting rows in §8.5 table

### S5. §6.4 intercept-task matcher says `Task` — code uses `Task|Agent`
- **What SPEC says:** §6.4 "Matcher field" says `Task`; §6.4 item 2 says "Only intercepts Task tool"; §6.6 says "PreToolUse hook on Task matcher"
- **What code does:** `intercept-task.ts` line 41 and `installInterceptHook` use `Task|Agent` matcher (both Task and Agent tools are intercepted)
- **Note:** Per-agent install reportedly still uses just `Task` — this may be an internal code inconsistency too
- **Fix:** Update §6.4 and §6.6 to say `Task|Agent` and document that both Task and Agent tools are intercepted

### S6. §6.6 main-path hook says "deny with JSON + stderr message"
- **What SPEC says:** §6.6 describes the main-path hook as writing "deny with JSON + stderr message"
- **What code does:** `main-path.ts` line 128 writes JSON to **stdout only**; no stderr write
- **Fix:** Remove "stderr message" from §6.6 description

### S7. §6.2 background task check "last 15 lines" context is misleading
- **What SPEC says:** §6.2 background task check uses "last 15 lines"
- **What code does:** `agent-status.ts` lines 140–157: the 15-line capped capture only runs when the initial tmux capture was null; otherwise the full initial capture is used
- **Fix:** Clarify in §6.2 that the 15-line limit is a fallback when initial capture returns null

### S8. SPEC.md omits multi-repo registry entirely
- **What SPEC says:** No mention of `~/.itsybitsy/repos.json`, `ib add`/`ib remove` commands, or migration from old `~/.itsybitsy.json` format
- **What code does:** `registry.ts` line 26 writes to `~/.itsybitsy/repos.json`; migration from old format (including `diffTool` → `externalDiffTool` rename) is implemented
- **Fix:** Add a section to SPEC.md documenting the registry, repos.json path, add/remove commands, and migration

### S9. SPEC.md has no section on the Setup/Hooks dialog
- **What SPEC says:** `externalDiffTool` is "written back via the settings dialog" (vague); no further description of the Setup dialog
- **What code does:** The Setup dialog has two tabs: **Hooks** (tab 0) and **Config** (tab 1), confirmed by `SETUP_TAB_NAMES = ['Hooks', 'Config']`. A permissions-editor dialog also exists.
- **Fix:** Add a section to SPEC.md documenting the Setup dialog structure, its two tabs, and the permissions editor

### S10. §6.4 externalDiffTool migration undocumented
- **What SPEC says:** Mentions `externalDiffTool` exists in config but doesn't document the migration from old `diffTool` key in registry format
- **What code does:** Migration renames `diffTool` → `externalDiffTool` when reading old registry files
- **Fix:** Document the migration in the new registry section (see S8)

---

## CLAUDE.md Inconsistencies

### C1. Parse-state priority order missing `creating` state (first priority)
- **Location:** CLAUDE.md line ~170 (parse-state.ts priority order section)
- **What it says:** `Compacting (last 5) > Active running (last 5) > ...`
- **What code does:** The **first** check in `parseState()` (SPEC §1.3 Priority 1, `parse-state.ts:76-88`) is the `creating` state for workspace trust prompts when no startup markers are present in the full input. CLAUDE.md omits this and starts the list at Compacting.
- **Fix:** Prepend `Creating (workspace trust prompt, full input) >` to the priority list

### C2. Config section lists removed `fps` config key
- **Location:** CLAUDE.md line ~209
- **What it says:** `Defines all config keys (maxAgents, model, fps, createPullRequests, ...)`
- **What code does:** `fps` was fully removed from `config.ts` (commit: "Remove fps config key entirely"). SPEC.md correctly omits it.
- **Fix:** Remove `fps` from the config key list

### C3. `readAllAgents()` return type description is incomplete
- **Location:** CLAUDE.md line ~163
- **What it says:** `readAllAgents() returns { agents, errors } — always check errors`
- **What code does:** `ReadAgentsResult` has three fields: `{ agents, errors, orphanedTmuxSessions }`. The third field is omitted.
- **Fix:** Update to `readAllAgents() returns { agents, errors, orphanedTmuxSessions } — always check errors`

### C4. State detection flow skips `computeStateFromContent()` intermediate step
- **Location:** CLAUDE.md lines ~148–151
- **What it says:** `detectAgentStates() calls captureTmuxOutput() ... then feeds output through parseState()`
- **What code does:** `agents.ts:406-407` calls `computeStateFromContent()` first as a pre-check; only if it returns `null` does `parseState()` get called. CLAUDE.md skips this intermediate step.
- **Fix:** Add the `computeStateFromContent()` pre-check to the description

---

## README.md Inconsistencies

### R1. Architecture section has stale registry path
- **Location:** README.md line ~55
- **What it says:** `registry.ts — Stores which repo paths to monitor (~/.itsybitsy.json)`
- **What code does:** Registry now writes to `~/.itsybitsy/repos.json` (`registry.ts:26`)
- **Fix:** Update to `~/.itsybitsy/repos.json`

### R2. Configuration section has three errors
- **Location:** README.md lines ~126–135
- **What it says:**
  ```json
  Optional config in ~/.itsybitsy.json:
  { "repos": [], "diffTool": "code --diff" }
  ```
- **Three errors:**
  1. **Wrong path:** Should be `~/.itsybitsy/config.json`, not `~/.itsybitsy.json`
  2. **Wrong key name:** `diffTool` was renamed to `externalDiffTool` (`config.ts:26`)
  3. **Wrong location for `repos`:** `repos` lives in `~/.itsybitsy/repos.json`, not in the config file
- **Fix:** Update path to `~/.itsybitsy/config.json`, rename `diffTool` → `externalDiffTool`, remove `repos` from the config example

---

## Code Comment Inconsistencies

### CC1. `dialog-handler.ts:51` comment has wrong tab 0 name
- **Location:** `src/tui/dialog-handler.ts` line 51
- **What it says:** `tab: number; // 0=Setup, 1=Config`
- **What code does:** `SETUP_TAB_NAMES = ['Hooks', 'Config']` — tab 0 is `Hooks`, not `Setup`
- **Fix:** Update comment to `// 0=Hooks, 1=Config`

---

## Recommended Fix Priority

1. **SPEC.md S5, S6** — Incorrect hook behavior descriptions (Task vs Task|Agent, stdout vs stderr)
2. **SPEC.md S8, S9** — Missing entire sections (registry, Setup dialog)
3. **SPEC.md S1, S2** — meta.json schema and creation step list incomplete
4. **SPEC.md S3, S4, S7, S10** — Minor accuracy issues
5. **CLAUDE.md C1–C4** — Implementation notes corrections
6. **README.md R1, R2** — User-facing documentation errors (stale paths/keys)
7. **CC1** — Code comment typo

# Second-Pass Review: PLAN.md Phases 32 and 33

Verifying accuracy after round-1 corrections were applied.

## Phase 32: Parity Fixes — CLI Commands

### 32a: Settings file location — PASS
Correctly downgraded to "nice-to-have / documentation." Description accurately states this was an intentional Phase 26c decision. Code confirmed: `defaultSettingsPath()` at ib-commands.ts:2041 returns `~/.claude/settings.json` (global). Action items (document divergence, optional `--local` flag) are reasonable and well-scoped.

### 32b: `ib list --json` — PASS
Accurate. index.ts list case (line 73) parses `--manager` but no `--json`. Nice-to-have rating appropriate.

### 32c: `ib look --follow` — PASS
Accurate. index.ts look case (line 286) has `--all` and `--lines` but no `--follow`. Should-fix rating appropriate.

### 32d: `ib diff --stat` — PASS
Accurate. index.ts diff case (line 354) has no `--stat` parsing. Nice-to-have rating appropriate.

### 32e: `ib status` improvements — PASS
Rewording is accurate. Description now correctly says "bash determines this from the caller's current HEAD" rather than "actual parent branch." Code confirmed at index.ts:386: `git log --oneline main..HEAD` hardcodes `main`. The bullet about using `meta.json` parent branch with `main` as default is a reasonable improvement over hardcoding.

### 32f: `ib send --from` — PASS
Rewording is accurate. Description now correctly notes that `sendMessage()` already supports `fromAgent` (confirmed at ib-commands.ts:1011,1030) and auto-detects from cwd (lines 1031-1041). Only CLI arg parsing in index.ts:403-412 is missing — confirmed no `--from` extraction before `args.slice(2).join(" ")`. Action items are precise and actionable.

### 32g: Other missing CLI commands — PASS
All sub-items verified:
- No `log` command in index.ts switch — confirmed
- No `--prompt-file` in new-agent parsing — confirmed
- No `parse-state` command — confirmed
- No `--all` flag on questions command — confirmed
- diff merge-base overlap with 32e noted — confirmed at index.ts:360 (`git merge-base HEAD main` hardcodes `main`)

## Phase 33: Parity Fixes — TUI Watch Features

### Removal of 33a/33b — PASS
Correctly removed. The note at line 1258 accurately explains why: all five keybindings (`t`, `w`, `o`, `c`, `Enter`) exist in dashboard.ts, and usage tracking is fully implemented via `src/usage.ts` with status bar display and 240s polling timer.

### 33a (renumbered from 33c): Settings/permissions editor — PASS
Accurately describes the remaining gap. No settings/permissions editor exists in dashboard.ts (grep confirmed). Description is actionable: settings tabs, permissions editor, number/string input dialogs. Nice-to-have rating is appropriate given complexity.

## Gap Analysis — Any Missed Items?

### NEW-FINDING: `ib diff` already uses merge-base (partial)

The diff command at index.ts:360 already uses `git merge-base HEAD main` — it's not purely hardcoding `main` in the same way as status. It uses merge-base but with `main` as the target rather than looking up the parent branch. The 32g note about this is accurate but could clarify that diff already does merge-base (just with wrong target), while status (32e) doesn't use merge-base at all (uses `main..HEAD` range directly). This is a minor distinction but worth noting for implementation.

### NEW-FINDING: `ib status` also missing `--json` flag

Bash `ib status` supports `--json` output (similar to `ib list --json`). This isn't mentioned in 32e or 32g. Low priority — nice-to-have at most.

## Summary

| Item | Verdict |
|------|---------|
| 32a | PASS — accurately downgraded and well-described |
| 32b | PASS |
| 32c | PASS |
| 32d | PASS |
| 32e | PASS — rewording is accurate |
| 32f | PASS — rewording is accurate |
| 32g | PASS |
| 33 removal note | PASS — correctly explains why 33a/33b were removed |
| 33a (settings editor) | PASS |
| NEW: diff vs status merge-base nuance | Minor clarification opportunity |
| NEW: `ib status --json` missing from plan | Low-priority gap |

**Overall: Phases 32 and 33 are now accurate and well-defined. No blocking issues found. Two minor new findings noted above.**

# Third-Pass Review: PLAN.md Phases 32 and 33

Verifying accuracy after round-1 and round-2 corrections were applied.

## Phase 32: Parity Fixes — CLI Commands

### Header / Metadata — PASS
- Source reference "PARITY_HOOKS_TUI.md (sections 2.1–2.8)" is accurate — that document has sections 2.1 through 2.8 covering CLI commands.
- "Not started" status, "Low-Medium" complexity — appropriate.

### 32a: Settings file location — PASS (one nit)
- File reference `src/ib-commands.ts` (`installSafetyHooks`, `uninstallSafetyHooks`) — CORRECT (lines 2165, 2214).
- `defaultSettingsPath()` at line 2041 returns `~/.claude/settings.json` — CONFIRMED.
- Description correctly notes this was intentional in Phase 26c, not a bug.
- Priority "nice-to-have / documentation" — appropriate.
- Action items (document divergence, optional `--local` flag) — reasonable.

**Nit:** The second action item says "Optionally consider adding" — the double-hedging ("optionally" + "consider") is weak. Suggest either "Consider adding" or just drop the bullet if it's truly optional future work.

### 32b: `ib list --json` — PASS
- File reference `src/index.ts` (list command) — CORRECT (line 73).
- No `--json` flag exists — CONFIRMED.
- Priority "nice-to-have" — appropriate.

### 32c: `ib look --follow` — PASS
- File reference `src/index.ts` (look command) — CORRECT (line 286).
- No `--follow` flag — CONFIRMED.
- Description says "runs `tmux attach -r -t <session>`" — correct tmux read-only attach syntax.
- Priority "should-fix" — appropriate.

### 32d: `ib diff --stat` — PASS (one nit)
- File reference `src/index.ts` (diff command) — CORRECT (line 354).
- No `--stat` flag — CONFIRMED.
- Priority "nice-to-have" — appropriate.

**Nit:** Description says "runs `git diff --stat` instead of full diff." Bash actually runs `git diff --stat "$MERGE_BASE..$BRANCH_NAME"` — it's a stat of the merge-base range, not a bare `git diff --stat`. The implementation should mirror this (stat against the merge-base), but the current wording could be read as just `git diff --stat` against working tree. Minor ambiguity.

### 32e: `ib status` improvements — PASS (two nits)
- File reference `src/index.ts` (status command) — CORRECT (line 381).
- Description of what TS currently does ("plain git output") — CONFIRMED: `git log --oneline main..HEAD` (line 386) + `git status --short` (line 394).
- Merge-base bullet correctly notes bash uses caller's current HEAD.
- Priority "should-fix" — appropriate.
- All four action items are accurate and actionable.

**Nit 1:** The merge-base bullet says "from `meta.json` or default to `main`" — but meta.json doesn't have a `parent_branch` field. The parent branch must be *derived* from meta.json's `manager` field: if manager exists → `agent/<manager-id>`, otherwise `main`. This is exactly what `session-start.ts:57` does. The PLAN should say "derived from `meta.json`'s `manager` field" rather than implying meta.json has a parent branch directly.

**Nit 2:** The section header example says `═══ Commits (N) vs main ═══` — but the bullet above it says to use the parent branch instead of hardcoding `main`. The example should use a dynamic placeholder like `═══ Commits (N) vs <parent-branch> ═══` for consistency.

### 32f: `ib send --from` — PASS
- File reference `src/index.ts` — CORRECT (line 403).
- Description correctly notes `sendMessage()` already supports `opts.fromAgent` (confirmed at ib-commands.ts:1011) and auto-detects from cwd (lines 1031-1041).
- CLI gap confirmed: index.ts:406 does `args.slice(2).join(" ")` with no `--from` extraction.
- Two action items are precise and correctly scoped to CLI-only changes.
- Priority "should-fix" — appropriate.

### 32g: Other missing CLI commands — PASS (one nit)
All sub-items verified:
- `ib log <message>` — no log command in index.ts switch — CONFIRMED.
- `ib new-agent --prompt-file <path>` — no `--prompt-file` in flag parsing (lines 507-528 parse `--worker`, `--model`, `--name`, `--no-worktree`, `--yolo`, `--allow`, `--deny` only) — CONFIRMED.
- `ib parse-state` — no parse-state command — CONFIRMED.
- `ib questions --all` — no `--all` flag on questions command — CONFIRMED.
- `ib status --json` — added from review 2 finding. Not in PARITY_HOOKS_TUI.md but valid. Note says "same as `ib list --json`" which is slightly misleading — they're different commands with different outputs, but the JSON output concept is the same.
- `ib diff` merge-base note: correctly distinguishes from 32e ("diff already uses merge-base but with `main`; status doesn't use merge-base at all"). CONFIRMED at index.ts:360 vs 386.

**Nit:** The `ib status --json` parenthetical "(nice-to-have, same as `ib list --json`)" is confusing. It's not the same command — suggest rewording to "(nice-to-have, analogous to `ib list --json`)".

---

## Phase 33: Parity Fixes — TUI Watch Features

### Header / Metadata — PASS
- Source reference "PARITY_HOOKS_TUI.md (section 3)" — CORRECT (that document's section 3 covers TUI Watch).
- "Not started" status, "Medium" complexity — appropriate.

### Removal note for original 33a/33b — PASS
The note at line 1259 is accurate:
- `t` exists at dashboard.ts:858 (denial time filter toggle) — CONFIRMED.
- `w` exists at dashboard.ts:917 (`handleOpenWorktree`) — CONFIRMED.
- `o` exists at dashboard.ts:919 (`handleOpenDiffTool`) — CONFIRMED.
- `c` exists at dashboard.ts:867 (clear errors) — CONFIRMED.
- `Enter` exists at dashboard.ts:876 (answer question in QUESTIONS pane) — CONFIRMED.
- Usage tracking fully implemented via `src/usage.ts`, imported at dashboard.ts:30, displayed in status bar (lines 190, 204-221, 235-251), polled every 240s (line 476) — CONFIRMED.

### 33a (renumbered): Settings/permissions editor — PASS (one nit)
- File references `src/tui/dashboard.ts`, `src/tui/dialog-handler.ts` — both files exist, CONFIRMED.
- Description accurately describes the gap: bash has multi-tab settings + permissions editor; TS has basic setup dialog only.
- Three action items are clear and actionable.
- Priority "nice-to-have" — appropriate given the complexity.

**Nit:** The description says "settings tabs" but doesn't specify what the tabs would contain beyond "project settings, user settings." For implementability, it could reference the config keys in `src/config.ts` that would be editable. Very minor — not blocking.

---

## Summary

| Item | Verdict | Issues |
|------|---------|--------|
| 32a | PASS | Minor: double-hedging on optional flag |
| 32b | PASS | None |
| 32c | PASS | None |
| 32d | PASS | Minor: `git diff --stat` should clarify it's against merge-base range |
| 32e | PASS | Minor: meta.json doesn't have parent_branch directly (must derive from manager); section header example contradicts dynamic branch bullet |
| 32f | PASS | None |
| 32g | PASS | Minor: "same as `ib list --json`" wording is slightly misleading |
| 33 note | PASS | None |
| 33a | PASS | Minor: could reference config.ts for implementability |

**Overall: All items PASS. No inaccuracies found. Six minor nits identified — all are wording/clarity improvements, none are factual errors or missing information. Phases 32 and 33 are accurate, well-defined, and ready for implementation.**

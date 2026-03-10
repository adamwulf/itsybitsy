# Deep Accuracy Review: PLAN.md Phases 31 and 32

Independent review against the current source code. Every claim verified by reading the referenced files.

---

## Phase 31: Parity Fixes — Hooks & Agent Status

### Phase 31 Header

- **Source:** "PARITY_HOOKS_TUI.md, PARITY_LIFECYCLE.md" — both files exist. Correct.
- **Complexity:** "Medium — mostly localized changes in hook files." — Accurate. All 7 sub-items target hook files (`agent-status.ts`, `main-path.ts`, `inject-status.ts`) or `watchdog.ts`. No `ib-commands.ts` changes needed.

**Verdict: PASS**

---

### 31a: Delayed nudge recheck in stop hook

- **File:** `src/hooks/agent-status.ts` — correct.
- **Claim:** TS lacks scheduled follow-up after debounce. CONFIRMED at lines 241-243: returns `{ state, action: "debounced" }` with no background recheck. Timestamp is written (lines 246-247) but no `setTimeout` or background spawn follows.
- **Priority "must-fix":** Justified — without recheck, an agent debounced at the wrong moment may never get nudged again if no further tool calls trigger the hook.

**Verdict: PASS**

---

### 31b: Stop hook tmux send-keys timing

- **File:** `src/hooks/agent-status.ts:356-360,369-376` — line numbers verified:
  - Lines 356-360: first `Bun.spawn` call for nudge/remind actions. Line 357 has the array `["tmux", "send-keys", "-t", tmuxSession, result.message, "Enter"]` — message and Enter in one call, no `-l` flag.
  - Lines 368-379: second `Bun.spawn` call for notify_manager. Same pattern — message+Enter in one call, no `-l` flag.
- **Claim about `sendMessage()` pattern in `ib-commands.ts`:** CONFIRMED at lines 1057-1077 — uses `-l` flag in first call, then `Bun.sleep(delay)`, then separate `"Enter"` call. This is the correct pattern.
- **Issue is real:** Without `-l`, tmux interprets special characters in the message as key sequences. Without the delay+separate-Enter, long messages may not be fully received before Enter is pressed.

**Verdict: PASS** — Line range "356-360" is accurate (previous review noted "356-358" was slightly narrow, but the PLAN already says 356-360).

---

### 31c: Complete + unfinished children message

- **File:** `src/hooks/agent-status.ts` — correct.
- **Claim:** TS sends shorter message. CONFIRMED at line 194: `"You have unfinished child agents: ${unfinishedChildren.join(", ")}. Check on them before completing."` — no command suggestions included.
- **Claim about bash:** Says bash includes `ib merge`, `ib kill`, `ib list`, `ib look`, `ib status`, `ib diff`. Consistent with parity doc.

**Verdict: PASS**

---

### 31d: Nudge message formatting

- **File:** `src/hooks/agent-status.ts` — correct.
- **Claim:** TS omits single quotes around `WAITING` and `I HAVE COMPLETED THE GOAL`. CONFIRMED at line 256: `"Resume your work, or end with WAITING or I HAVE COMPLETED THE GOAL as your final line."` — no quotes.
- **Claim about `parse_state` stripping:** CONFIRMED at `parse-state.ts:126`: `last15.replace(/'I HAVE COMPLETED THE GOAL'/g, "")` — strips single-quoted occurrences before checking for the bare phrase. Without quotes in the nudge message, the nudge text itself would match as a completion signal. This is a functional issue, not cosmetic.
- **Priority "should-fix":** Could arguably be "must-fix" given the false-positive risk, but "should-fix" is reasonable since the stop hook typically runs before the nudge text appears in tmux output.

**Verdict: PASS**

---

### 31e: main-path comment stripping

- **File:** `src/hooks/main-path.ts` — correct.
- **Claim:** Regex doesn't handle `#` comments. CONFIRMED at line 53: `^([^&|;]*?)(\s*&&|\s*\|\||\s*;\s*|\s*\|)` — no `#` in the character class or as an alternative.
- **Actual behavior:** `cd /foo # some comment` — the regex won't match (no `&&`, `||`, `;`, or `|` present), so the entire string `"/foo # some comment"` becomes the cd target. After quote stripping, this resolves to path `/foo # some comment` which doesn't exist.
- **Edge case not mentioned:** `cd /foo # some comment && ls` — the regex *would* match on `&&`, extracting `/foo # some comment` as the target. So `#` stripping is needed even when compound operators are present.
- **Test suggestion** in PLAN is correct and actionable.

**Verdict: PASS**

---

### 31f: inject-status question counts

- **File:** `src/hooks/inject-status.ts` — correct.
- **Claim:** `briefSummary()` doesn't include question counts. CONFIRMED: `briefSummary()` at lines 95-116 counts states only (`running`, `waiting`, `complete`, `rate_limited`, `stopped`, `creating`). No reference to `user-questions.json` or `readPendingQuestions` anywhere in the file.
- **Second bullet about filtering dead/archived agents:** Reasonable — `readPendingQuestions` may return questions from agents that have been killed/archived.

**Verdict: PASS**

---

### 31g: Debug file content in stop hook

- **File:** `src/hooks/agent-status.ts` — correct.
- **Claim:** Debug file only saves `lastMessage`. CONFIRMED at lines 100-108: `writeFile(debugPath, lastMessage || "(no message)")`. The tmux capture output (`tmuxOutput` variable, line 73) and parse state reason (from `result.state`, line 92) are both available in scope but not written.
- **Cross-reference to `watchdog.ts`:** CONFIRMED — `handleUnknown()` (lines 248-261) has counter increment and manager notification but no debug file writing.

**Verdict: PASS**

---

## Phase 32: Parity Fixes — CLI Commands

### Phase 32 Header

- **Source:** "PARITY_HOOKS_TUI.md (sections 2.1–2.8)" — correct.
- **Status/Complexity:** "Not started", "Low-Medium per item" — appropriate.

**Verdict: PASS**

---

### 32a: Settings file location

- **File:** `src/ib-commands.ts` (`installSafetyHooks`, `uninstallSafetyHooks`) — CONFIRMED at lines 2165 and 2214.
- **Claim:** TS writes to `~/.claude/settings.json` (global). CONFIRMED: `defaultSettingsPath()` at line 2041 returns `join(homedir(), ".claude", "settings.json")`.
- **Claim about intentional Phase 26c change:** Plausible and well-documented.
- **Note:** `_repoPath` parameter is unused in both functions (underscore prefix confirms) — the repo path is irrelevant since hooks go to global settings. This is consistent with the "intentional" claim.

**Verdict: PASS**

---

### 32b: `ib list --json`

- **File:** `src/index.ts` (list command at line 73) — correct.
- **Claim:** No `--json` flag exists. CONFIRMED: the list case (lines 73-163) only parses `--manager`.

**Verdict: PASS**

---

### 32c: `ib look --follow`

- **File:** `src/index.ts` (look command at line 286) — correct.
- **Claim:** No `--follow` flag. CONFIRMED: look case (lines 286-308) only parses `--all` and `--lines`.
- **Suggested implementation** `tmux attach -r -t <session>` is correct tmux syntax for read-only attach.

**Verdict: PASS**

---

### 32d: `ib diff --stat`

- **File:** `src/index.ts` (diff command at line 354) — correct.
- **Claim:** No `--stat` flag. CONFIRMED: diff case (lines 354-380) runs `git diff mergeBase` with no `--stat` option.
- **Accuracy concern:** Description says "runs `git diff --stat "$MERGE_BASE..$BRANCH"`" for bash. The TS implementation should use `git diff --stat ${mergeBase}..HEAD` (range syntax matching bash), not just `git diff --stat mergeBase` (which would diff against working tree). The description is slightly ambiguous but the parenthetical "(stat of merge-base range, matching bash behavior)" clarifies intent.

**Verdict: PASS** — minor wording ambiguity, not incorrect.

---

### 32e: `ib status` improvements

- **File:** `src/index.ts` (status command at line 381) — correct.
- **Claim:** TS just shows plain git output. CONFIRMED: lines 386-400 run `git log --oneline main..HEAD` and `git status --short` with no header, no agent ID, no branch name, no `--stat`, no section headers.
- **Merge-base claim:** Says to use parent branch "derived from `meta.json`'s `manager` field: if manager exists use `agent/<manager-id>`, otherwise default to `main`". This derivation logic is correct and matches the pattern in `session-start.ts`.
- **Current code hardcodes `main`:** CONFIRMED at line 386: `"main..HEAD"`.
- **Section header example:** PLAN says `═══ Commits (N) vs <parent-branch> ═══` — consistent with dynamic branch suggestion.

**Verdict: PASS**

---

### 32f: `ib send --from`

- **File:** `src/index.ts` (send command at line 403) — correct.
- **Claim:** `sendMessage()` already supports `opts.fromAgent`. CONFIRMED at `ib-commands.ts:1011`: `opts?: { fromAgent?: string; cwd?: string }`.
- **Claim:** CLI argument parsing is missing. CONFIRMED: `index.ts:406` does `args.slice(2).join(" ")` — no `--from` extraction. The `fromAgent` parameter is never passed from the CLI.
- **Auto-detection from cwd:** CONFIRMED at `ib-commands.ts:1031-1041` — detects sender from `.ittybitty/agents/` path pattern. This works when called from within an agent worktree, but the CLI `--from` flag would be needed when calling from outside.

**Verdict: PASS**

---

### 32g: Other missing CLI commands

Verified each sub-item:

1. **`ib log <message>`** — No `log` case in index.ts switch. CONFIRMED absent.
2. **`ib new-agent --prompt-file <path>`** — Flag parsing (lines 507-528) handles `--worker`, `--model`, `--name`, `--no-worktree`, `--yolo`, `--allow`, `--deny`. No `--prompt-file`. CONFIRMED absent.
3. **`ib parse-state`** — No `parse-state` case. CONFIRMED absent.
4. **`ib questions --all`** — Questions case (lines 330-353) has no `--all` flag. CONFIRMED absent.
5. **`ib status --json`** — No `--json` in status case. CONFIRMED absent. Description says "(nice-to-have, analogous to `ib list --json`)" — wording is clear.
6. **`ib diff` merge-base hardcoding** — CONFIRMED at line 360: `["git", "merge-base", "HEAD", "main"]` — hardcodes `main` instead of using parent branch. Description correctly distinguishes from 32e: diff already uses merge-base but with wrong branch; status doesn't use merge-base at all.

**Verdict: PASS**

---

## Additional Findings (not in previous reviews)

### ISSUE: Duplicate `merge-check` case in index.ts

`index.ts` has two identical `case "merge-check":` blocks — one at line 433 and another at line 451. The second is dead code (the first will always match). This is a latent bug/code smell that Phase 32 doesn't mention. Not directly a PLAN accuracy issue, but worth noting for cleanup.

### ISSUE: Phase 31b — neither send-keys path uses `-l` flag

Both tmux send-keys calls in `agent-status.ts` (lines 357, 369-375) lack the `-l` (literal) flag. The PLAN correctly identifies the missing delay/split-Enter pattern but doesn't explicitly call out the missing `-l` flag. Without `-l`, special characters in messages (like `$`, `!`, etc.) could be interpreted as tmux key bindings rather than literal text. The `sendMessage()` pattern in `ib-commands.ts:1058` uses `-l` — the fix should include this.

### OBSERVATION: Phase 31a implementation approach

The PLAN suggests `setTimeout` or `Bun.spawn` for the delayed recheck. Since `agent-status.ts` is a CLI entry point that exits after processing (line 386: `console.log(result.state)`), `setTimeout` won't work — the process will have exited. Only `Bun.spawn` with a detached/background process would work. The PLAN mentions both options but doesn't flag this constraint.

---

## Summary

| Item | Verdict | Notes |
|------|---------|-------|
| Phase 31 header | PASS | Accurate |
| 31a | PASS | Implementation note: setTimeout won't work (process exits) |
| 31b | PASS | Additional finding: missing `-l` flag not called out |
| 31c | PASS | Accurate |
| 31d | PASS | Accurate, correctly identifies functional risk |
| 31e | PASS | Accurate |
| 31f | PASS | Accurate |
| 31g | PASS | Accurate |
| Phase 32 header | PASS | Accurate |
| 32a | PASS | Accurate |
| 32b | PASS | Accurate |
| 32c | PASS | Accurate |
| 32d | PASS | Minor wording ambiguity on range syntax |
| 32e | PASS | Accurate, parent branch derivation correctly described |
| 32f | PASS | Accurate |
| 32g | PASS | All 6 sub-items verified |

**Overall: ALL PASS.** No factual errors found. Two new findings not caught by previous reviews: (1) the missing `-l` flag in 31b's tmux calls should be explicitly mentioned, and (2) the `setTimeout` suggestion in 31a won't work since the hook process exits. One unrelated code issue discovered: duplicate `merge-check` case in `index.ts`.

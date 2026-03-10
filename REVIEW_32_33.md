# Review: PLAN.md Phases 32 and 33

## Phase 32: Parity Fixes — CLI Commands

### 32a: Settings file location — PARTIALLY ACCURATE (reword)

**Claim:** Bash writes to `.claude/settings.local.json` (project-local). TS writes to `~/.claude/settings.json` (global). This is flagged as critical.

**Evidence:**
- Bash `ib` at line 12971: `local SETTINGS_FILE=".claude/settings.local.json"` — confirmed project-local.
- TS `ib-commands.ts:2041`: `defaultSettingsPath()` returns `join(homedir(), ".claude", "settings.json")` — confirmed global.
- Phase 26c at PLAN.md line 1037-1040 explicitly states this was an intentional change: "Change `installSafetyHooks`... to write to `~/.claude/settings.json` instead of `<repoPath>/.claude/settings.local.json`"

**Assessment:** The factual observation is accurate — there IS a difference. However, calling this "critical" is inappropriate because Phase 26c documents it as an intentional design decision. This is not a parity bug; it's a conscious divergence. The item already acknowledges this ("Phase 26c intentionally changed this") but still rates it critical.

**Recommendation:** Reword to remove "critical" severity. Change to an evaluation/documentation item only: "Evaluate whether global hook installation should be documented as an intentional divergence from bash ib, or whether project-local installation should be offered as an option alongside global." Should be "nice-to-have" at most.

---

### 32b: `ib list --json` — ACCURATE

**Claim:** Missing `--json` flag on `ib list`.

**Evidence:**
- Bash `ib` at line 7179: `--json) JSON_OUTPUT=true; shift ;;` — confirmed present in bash.
- TS `index.ts:73-162` (list/ls case): parses `--manager` flag but no `--json` flag.

**Assessment:** Accurate. Bash has `--json`, TS does not. Rating "nice-to-have" is appropriate.

**Recommendation:** Keep as-is.

---

### 32c: `ib look --follow` — ACCURATE

**Claim:** Missing `--follow` flag on `ib look`.

**Evidence:**
- Bash `ib` at line 7532: `--follow) FOLLOW=true; shift ;;` — confirmed present, documented as "Watch live (like tail -f)".
- Bash line 7551: example `ib look task-a1b2 --follow`
- TS `index.ts:286-308` (look case): parses `--all` and `--lines` but no `--follow`.

**Assessment:** Accurate. Bash has `--follow` which does `tmux attach -r`, TS does not. Rating "should-fix" is appropriate since this is a useful interactive feature.

**Recommendation:** Keep as-is.

---

### 32d: `ib diff --stat` — ACCURATE

**Claim:** Missing `--stat` flag on `ib diff`.

**Evidence:**
- Bash `ib` at line 7759: `--stat) STAT_ONLY=true; shift ;;` — confirmed present.
- Bash line 7827-7828: `if [[ "$STAT_ONLY" == true ]]; then git diff --stat "$MERGE_BASE..$BRANCH_NAME"`
- TS `index.ts:354-379` (diff case): no `--stat` parsing.

**Assessment:** Accurate. Rating "nice-to-have" is appropriate.

**Recommendation:** Keep as-is.

---

### 32e: `ib status` improvements — PARTIALLY ACCURATE (needs correction)

**Claim:** Bash shows headers, structured output, and `git diff --stat` summary. TS just shows plain git output. Says to "use `git merge-base` with the agent's actual parent branch (not hardcoded `main`)."

**Evidence:**

Bash `ib status` (lines 7706-7745):
- Shows agent ID, branch name, worktree path
- Uses `git merge-base HEAD "$BRANCH_NAME"` — note: HEAD here is the **caller's branch** (typically main but could be any branch)
- Shows section headers like `═══ Commits ($commit_count) vs $TARGET_BRANCH ═══`
- Shows `git diff --stat` summary

TS `ib status` (index.ts:381-401):
- Runs from agent worktree (`cwd = agentWorktreePath(agent)`)
- Uses `git log --oneline main..HEAD` — **hardcoded `main`**
- Uses `git status --short` — no headers, no agent ID, no diff stat

**Assessment:** The factual claims are accurate. However, there's a subtle but important issue with the "actual parent branch" phrasing. Bash uses `HEAD` of the **main repo** (the branch you're currently on), not the agent's configured parent. The PLAN says "actual parent branch" which is ambiguous. Since TS runs from the worktree, the equivalent would be to determine the parent branch from the agent's meta or use `main` as default. The real issue is that bash works relative to the caller's current branch while TS hardcodes `main`.

**Recommendation:** Reword the merge-base bullet to: "Use the parent branch (from meta.json or default to `main`) instead of hardcoding `main`, matching bash's behavior of comparing against the caller's HEAD." Everything else is accurate and should be kept.

---

### 32f: `ib send --from` — PARTIALLY ACCURATE (needs correction)

**Claim:** Bash supports `--from <id>` to auto-prefix messages. TS is missing this.

**Evidence:**

Bash `ib` at line 7394-7421:
- `--from` flag: `--from) ... shift 2 ;;`
- Auto-detection in worktrees (line 7415): "When run from within an agent's worktree, --from is automatically detected"

TS `sendMessage()` (ib-commands.ts:1008-1011):
```ts
export async function sendMessage(
  agent: Agent,
  message: string,
  opts?: { fromAgent?: string; cwd?: string }
)
```
- **Already supports `fromAgent` via opts** (line 1030: `let fromId = opts?.fromAgent ?? ""`)
- **Already auto-detects sender from cwd** (lines 1031-1041)
- **Already formats with prefix** (line 1047: `fullMessage = \`[sent by agent ${fromId}]: ${message}\``)

TS CLI (index.ts:403-413):
- Does NOT parse `--from` flag — just joins all args after the agent ID as the message.

**Assessment:** The claim that `sendMessage()` needs a `--from` flag is **partially wrong**. The function already supports it via `opts.fromAgent`, and auto-detection already works. The only missing piece is the CLI argument parsing in `index.ts` to wire `--from` to the existing `opts.fromAgent`. The PLAN description implies the function needs modification ("Add `--from` flag to `sendMessage()`") when it only needs CLI wiring.

**Recommendation:** Reword to: "Add `--from` flag parsing in `index.ts` send case, passing it to the existing `sendMessage(agent, message, { fromAgent })` parameter. The underlying function already supports this." Remove the note about modifying `sendMessage()`.

---

### 32g: Other missing CLI commands — PARTIALLY ACCURATE (mixed)

**Sub-items:**

1. **`ib log <message>`** — ACCURATE
   - Bash has `cmd_log()` at line 13973: writes timestamped messages to agent.log
   - TS has no `log` command in the switch statement
   - Rating "nice-to-have" is appropriate

2. **`ib new-agent --prompt-file <path>`** — ACCURATE
   - Bash at line 6625: `--prompt-file) PROMPT=$(<"$2"); shift 2 ;;`
   - TS `index.ts:507-528`: no `--prompt-file` in flag parsing
   - Rating "nice-to-have" is appropriate

3. **`ib parse-state`** — ACCURATE
   - Bash at line 2712: `parse-state|test-*)` case exists
   - TS has no `parse-state` command
   - Useful as a debug command

4. **`ib questions --all`** — ACCURATE
   - Bash at line 14312-14325: `--all, -a   Show all questions (including acknowledged)`
   - TS `index.ts:330-352`: no `--all` flag parsing for questions command

5. **`ib diff` — use `git merge-base` with actual parent branch, not hardcoded `main`** — ACCURATE but duplicates 32e
   - TS diff (index.ts:360): `git merge-base HEAD main` — hardcoded `main`
   - Bash diff (line 7825): `git merge-base HEAD "$BRANCH_NAME"` — uses HEAD of caller
   - **However**, this item duplicates the same issue described in 32e. The diff command is separate from status, but the fix description overlaps.

**Assessment:** All claims are individually accurate. The `ib diff` merge-base item overlaps with 32e (which covers status). Both diff and status have the same hardcoded-main issue.

**Recommendation:** Keep all items but note that the `ib diff` merge-base fix should be bundled with 32e since they share the same root cause.

---

## Phase 33: Parity Fixes — TUI Watch Features

### 33a: Missing keybindings — INACCURATE (already implemented)

**Claim:** The following keybindings are missing: `t`, `w`, `o`, `c`, `Enter`

**Evidence from dashboard.ts:**

| Key | Claimed Missing? | Actual Status | Code Location |
|-----|-----------------|---------------|---------------|
| `t` | Yes | **ALREADY IMPLEMENTED** — toggles denial time filter | dashboard.ts:858-864 |
| `w` | Yes | **ALREADY IMPLEMENTED** — `handleOpenWorktree()` | dashboard.ts:917, agent-actions.ts:465 |
| `o` | Yes | **ALREADY IMPLEMENTED** — `handleOpenDiffTool()` | dashboard.ts:919, agent-actions.ts:501 |
| `c` | Yes | **ALREADY IMPLEMENTED** — clears errors in ERRORS pane | dashboard.ts:867-868 |
| `Enter` | Yes | **ALREADY IMPLEMENTED** — opens answer dialog in QUESTIONS pane | dashboard.ts:876-879 |

**Assessment:** **INACCURATE.** All five keybindings already exist in the codebase. This phase item appears to have been written from a parity review document that predates the actual implementations.

**Recommendation:** **REMOVE this entire sub-item.** All claimed missing keybindings are already implemented.

---

### 33b: Usage tracking in dashboard — INACCURATE (already implemented)

**Claim:** Bash shows session/weekly usage % in status bar. TS should add this.

**Evidence:**

TS already has full usage tracking:
- `src/usage.ts` exists — full implementation with API calls, caching, lock files
- `dashboard.ts:30`: `import { fetchUsage } from "../usage"`
- `dashboard.ts:190`: `usage: UsageData | null = null`
- `dashboard.ts:204-221`: Usage displayed in status bar header
- `dashboard.ts:235-251`: `formatUsage()` method formatting session % and weekly %
- `dashboard.ts:476-477`: Polls every 240 seconds: `this.usageTimer = setInterval(() => this.refreshUsage(), 240_000)`
- `dashboard.ts:503-511`: `refreshUsage()` method calling `fetchUsage()`

**Assessment:** **INACCURATE.** Usage tracking is already fully implemented — the module exists, it's imported, it's displayed in the status bar, and it polls on a timer. This is not a missing feature.

**Recommendation:** **REMOVE this entire sub-item.** Usage tracking is already complete.

---

### 33c: Settings/permissions editor — ACCURATE

**Claim:** Bash has a full settings editor with tabs. TS does not have this.

**Evidence:**

Bash `ib watch`:
- Line 14997-14998: `SETTINGS_FOCUS_USER`, `SETTINGS_FOCUS_PROJECT` — separate tab focus tracking
- Line 17023-17029: renders setup tab, project config tab, user config tab
- Line 17481: `settings_render_config_tab()` — renders config items
- Line 19626-19792: `watch_dialog_init_permissions_editor()`, `watch_dialog_render_permissions_editor()`, `watch_dialog_key_permissions_editor()` — full permissions editor

TS dashboard:
- Has `h` keybinding for `handleSetup()` — but this is a setup dialog, not a settings editor
- No evidence of project/user config tab rendering
- No permissions editor implementation found

**Assessment:** Accurate. Bash has a comprehensive multi-tab settings UI with project settings, user settings, and a permissions allow/deny list editor. TS has a basic setup dialog but nothing comparable. Rating "nice-to-have" is appropriate given the complexity.

**Recommendation:** Keep as-is. This is a genuine missing feature.

---

## Summary

| Item | Verdict | Action |
|------|---------|--------|
| 32a | Partially accurate | Reword: remove "critical" — this was an intentional Phase 26c decision |
| 32b | Accurate | Keep as-is |
| 32c | Accurate | Keep as-is |
| 32d | Accurate | Keep as-is |
| 32e | Partially accurate | Reword: clarify merge-base behavior (bash uses caller's HEAD, not "actual parent branch") |
| 32f | Partially accurate | Reword: `sendMessage()` already supports fromAgent, only CLI arg parsing needed |
| 32g | Partially accurate | Keep items, note diff merge-base overlaps with 32e |
| **33a** | **INACCURATE** | **REMOVE — all 5 keybindings already exist** |
| **33b** | **INACCURATE** | **REMOVE — usage tracking already fully implemented** |
| 33c | Accurate | Keep as-is |

### Key finding

Phase 33 is largely obsolete — 2 of 3 sub-items describe features that already exist. Only 33c (settings/permissions editor) is a genuine gap. This suggests the parity review document that Phase 33 was based on is outdated.

# ib/ittybitty Dependency Audit — Updated Report (v2)

**Date:** 2026-03-09
**Auditor:** agent-ff777123

## Executive Summary

The previous audit (REVIEW_IB_DEPS.md by agent-964e1024) is **significantly outdated**. Most of the 24+ items it flagged have been fixed. The codebase has **zero remaining `ib` CLI invocations** — `runIb()` has been completely removed, and all commands are natively implemented.

---

## What's Been Fixed (vs. old review)

| Old Finding | Status |
|---|---|
| `runIb()` calls in index.ts CLI commands | **Fixed** — all use native ib-commands.ts functions |
| `Bun.spawn(["ib", "watchdog", ...])` | **Fixed** — now `Bun.spawn(["itsybitsy", "watchdog", ...])` (line 1758) |
| `reassignAgent()` was passthrough | **Fixed** — native at line 531 |
| `mergeCheckAgent()` was passthrough | **Fixed** — native at line 636 |
| `diffAgent()` / `statusAgent()` passthrough | **Fixed** — native at lines 1896/1917 |
| `acknowledgeQuestion()` passthrough | **Fixed** — native at line 1996 |
| `hooksStatus` + install/uninstall passthroughs | **Fixed** — native, reads/writes settings.local.json directly |
| `Bun.which("ib")` startup guard | **Fixed** — removed |
| Hook commands using `ib` prefix | **Fixed** — all use `itsybitsy` prefix (lines 1257-1279) |
| `Bash(ib:*)` in agent permissions | **Fixed** — now `Bash(itsybitsy:*)` (line 1216) |
| PATH comment "so 'ib' is available" | **Fixed** — now says "so 'itsybitsy' is available" (lines 378, 1657) |

---

## Remaining `ib` References

### Category 1: Agent-Facing Instructions in session-start.ts (~39 occurrences)

**File:** `src/hooks/session-start.ts`
**Lines:** 84-209, 233-281
**What:** Instructions injected into spawned Claude agents at session start. Tell agents to use `ib new-agent`, `ib look`, `ib send`, `ib merge`, `ib kill`, `ib resume`, `ib ask`, `ib diff`, `ib status`, `ib list`, `ib questions`, `ib acknowledge`, `ib log`.

**Verdict: INTENTIONAL but potentially should migrate.** These agent instructions tell Claude agents (running in tmux) to use `ib` as their CLI. However, `itsybitsy` now has matching subcommands for every single one of these. The question is whether `ib` (bash script) or `itsybitsy` (compiled binary) should be the canonical CLI for agents.

**Recommendation:** Replace `ib` with `itsybitsy` in agent instructions. Since hooks already use `itsybitsy` and PATH is set up for `itsybitsy`, agents should use `itsybitsy` too. This would eliminate the dependency on the `ib` bash script entirely.

### Category 2: User/Agent-Facing Messages in ib-commands.ts (3 occurrences)

| Line | Message | Context |
|---|---|---|
| 241 | `Use 'ib kill ${agent.id}' instead.` | Error when trying to nuke a worker |
| 440 | `Use 'ib look ${agent.id}' to view output` | Success message after resume |
| 1987 | `Use 'ib resume ${agent.id}' to continue.` | Success message after pause |

**Verdict: Should fix.** These are messages returned to the TUI or to Claude agents. They should reference `itsybitsy` consistently.

### Category 3: Agent-Facing Messages in intercept-task.ts (2 occurrences)

| Line | Message | Context |
|---|---|---|
| 132 | `ib agent spawn failed: ${result.stderr \|\| "unknown error"}` | Failure message to calling agent |
| 151 | `ib agent ${id} has been spawned... ib look ${id}` | Success message to calling agent |

**Verdict: Should fix.** These messages are sent back to Claude agents after task interception.

### Category 4: Agent Path Hook Denial Message (1 occurrence)

**File:** `src/hooks/agent-path.ts:86`
**Message:** `"TaskCreate is not available. Use ib new-agent --worker to spawn worker agents instead."`

**Verdict: Should fix.** Should say `itsybitsy new-agent --worker`.

### Category 5: Dashboard UI Labels (3 occurrences)

| File:Line | Label | Context |
|---|---|---|
| `dashboard.ts:619` | `"DIFF — run ib diff"` | Pane mode selector |
| `dashboard.ts:620` | `"STATUS — run ib status"` | Pane mode selector |
| `agent-actions.ts:649` | `"Redirect Task tool calls to spawn ib agents"` | Setup dialog description |

**Verdict: Should fix.** These are shown to itsybitsy TUI users, not agents.

### Category 6: intercept-task.ts Skip List (1 occurrence)

**File:** `src/hooks/intercept-task.ts:20`
**Value:** `"ib-merge"` in `SKIP_SUBAGENT_TYPES`

**Verdict: KEEP.** This is the name of a Claude Code skill/subagent type, not an `ib` CLI reference.

### Category 7: Comments Referencing ib (Documentation) (~30+ occurrences)

Across `ib-commands.ts`, `agent-lifecycle.ts`, `watchdog.ts`, `parse-state.ts`, `auto-compact.ts`. Examples:
- "mirrors do_kill in ib bash"
- "Matches ib's get_agent_context_usage() logic"
- "replaces `ib kill <id> --force`"

**Verdict: KEEP.** These document the provenance of ported code. Valuable for maintenance.

### Category 8: Test Files (many occurrences)

- `agent-path.test.ts:39-57` — Tests for `Bash(ib:*)` pattern matching (ensures `ib` commands are allowed)
- `ib-commands.test.ts:2708-2943` — Tests that ib-prefixed hooks are NOT detected as itsybitsy hooks (important for migration)
- `session-start.test.ts:58-94` — Tests that agent instructions contain `ib` commands
- Various temp dir names like `ib-test-`, `ib-na-test-`

**Verdict: KEEP (mostly).** The hook detection tests are critical — they ensure itsybitsy correctly distinguishes its own hooks from legacy ib hooks. The session-start tests would need updating if Category 1 is fixed. Temp dir names are cosmetic.

### Category 9: `.ittybitty` Directory Paths (many occurrences)

Used throughout `agents.ts`, `config.ts`, `ib-commands.ts`, etc. for:
- `.ittybitty/agents/` — agent data directory
- `.ittybitty/archive/` — archived agents
- `.ittybitty.json` — config files
- `.ittybitty/hooks/` — custom hooks

**Verdict: KEEP.** This is the actual directory structure used by the ib ecosystem. Changing this would be a breaking change that affects the bash `ib` tool and all existing agent data.

### Category 10: File/Module Names

- `src/ib-commands.ts` / `src/ib-commands.test.ts` — The main commands module

**Verdict: KEEP (low priority cosmetic).** Renaming would be a large refactor with no functional benefit.

### Category 11: IB_ Environment Variables (7 occurrences)

**File:** `src/ib-commands.ts:1727-1734`
`IB_AGENT_ID`, `IB_AGENT_TYPE`, `IB_AGENT_DIR`, `IB_AGENT_BRANCH`, `IB_AGENT_MANAGER`, `IB_AGENT_PROMPT`, `IB_AGENT_MODEL` — passed to post-create-agent hooks.

**Verdict: KEEP.** These are part of the hook API contract shared with the ib bash tool. Changing them would break user-defined hooks.

### Category 12: SpawnFn/setSpawnRunner Pattern (many occurrences)

Across `tmux-poller.ts`, `agent-lifecycle.ts`, `ib-commands.ts`, `watchdog.ts`, `usage.ts`, `ghostty.ts`.

**Verdict: KEEP — not ib-related.** This is a test injection pattern for `Bun.spawn`. Has nothing to do with the `ib` CLI.

---

## Priority Recommendations

| Priority | Action | Files | Effort |
|---|---|---|---|
| **High** | Replace `ib` with `itsybitsy` in session-start.ts agent instructions | session-start.ts, session-start.test.ts | Medium |
| **Medium** | Fix user-facing messages in ib-commands.ts | ib-commands.ts:241,440,1987 | Small |
| **Medium** | Fix agent-facing messages in intercept-task.ts | intercept-task.ts:132,151 | Small |
| **Medium** | Fix denial message in agent-path.ts | agent-path.ts:86 | Small |
| **Medium** | Fix dashboard UI labels | dashboard.ts:619-620, agent-actions.ts:649 | Small |
| **Low** | Update REVIEW_IB_DEPS.md (outdated) | REVIEW_IB_DEPS.md | Small |
| **None** | Comments, test names, .ittybitty paths, IB_ env vars, SpawnFn | Various | N/A |

---

## Scorecard (Current State)

| Category | Status |
|---|---|
| Core lifecycle commands | 100% native |
| CLI subcommands | 100% native |
| TUI dashboard operations | 100% native |
| Hook infrastructure | 100% native (uses `itsybitsy` prefix) |
| Hook management (install/uninstall) | 100% native |
| Watchdog | 100% native |
| Agent permissions | Uses `Bash(itsybitsy:*)` |
| **Runtime `ib` CLI invocations** | **ZERO** |
| Agent instruction text | Still references `ib` (~39 places) |
| User/agent-facing messages | ~10 places still say `ib` |

---

## Bottom Line

itsybitsy is functionally **100% self-contained** — it never shells out to `ib`. The remaining work is purely cosmetic: updating message strings and agent instructions from `ib` to `itsybitsy`.

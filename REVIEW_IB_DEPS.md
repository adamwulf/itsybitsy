# itsybitsy — ib CLI Dependency Audit

**Date:** 2026-03-09
**Auditor:** agent-964e1024

## Summary

itsybitsy is approximately **70% self-contained**. Core lifecycle operations (kill, nuke, pause, resume, merge, new-agent, send) are implemented natively. However, **12 runtime ib CLI invocations remain** across two categories: CLI passthrough commands in index.ts, and passthrough wrappers in ib-commands.ts. Additionally, agent hooks reference `ib` commands that run inside spawned agent environments.

---

## Natively Implemented Commands (No ib dependency)

| Command | Function | File | Status |
|---------|----------|------|--------|
| kill | `killAgent()` | src/ib-commands.ts:84 | Native |
| nuke | `nukeAgent()` | src/ib-commands.ts:202 | Native |
| nuke --all | `nukeAllAgents()` | src/ib-commands.ts:281 | Native |
| pause | `pauseAgent()` | src/ib-commands.ts:1756 | Native |
| resume | `resumeAgent()` | src/ib-commands.ts:347 | Native |
| merge | `mergeAgent()` | src/ib-commands.ts:649 | Native |
| send | `sendMessage()` | src/ib-commands.ts:882 | Native |
| new-agent | `newAgent()` | src/ib-commands.ts:1174 | Native |
| look | CLI in index.ts:189 | src/index.ts:189 | Native (tmux capture-pane) |
| info | CLI in index.ts:213 | src/index.ts:213 | Native (reads meta.json) |
| diff | CLI in index.ts:257 | src/index.ts:257 | Native (git diff) |
| status | CLI in index.ts:284 | src/index.ts:284 | Native (git log + status) |
| questions | CLI in index.ts:233 | src/index.ts:233 | Native (reads question files) |
| agents/tree | CLI in index.ts:102 | src/index.ts:102 | Native |

## Remaining ib CLI Dependencies

### Category 1: ib-commands.ts passthrough wrappers (called by TUI dashboard)

These functions in ib-commands.ts simply call `runIb()` which spawns `Bun.spawn(["ib", ...])`:

| # | Function | File:Line | Exact Code | Severity |
|---|----------|-----------|------------|----------|
| 1 | `reassignAgent()` | src/ib-commands.ts:562-566 | `runIb(["reassign", agent.id, ...])` | **Blocking** — used by TUI agent actions |
| 2 | `mergeCheckAgent()` | src/ib-commands.ts:569-570 | `runIb(["merge-check", agent.id], ...)` | **Blocking** — used by TUI merge flow |
| 3 | `diffAgent()` | src/ib-commands.ts:1738-1739 | `runIb(["diff", agent.id], ...)` | **Blocking** — used by TUI pane manager |
| 4 | `statusAgent()` | src/ib-commands.ts:1742-1743 | `runIb(["status", agent.id], ...)` | **Blocking** — used by TUI pane manager |
| 5 | `acknowledgeQuestion()` | src/ib-commands.ts:1807-1808 | `runIb(["acknowledge", questionId], ...)` | **Blocking** — used by TUI agent actions |
| 6 | `hooksStatus()` | src/ib-commands.ts:1812-1813 | `runIb(["hooks", "status"], ...)` | Non-blocking — setup dialog only |
| 7 | `interceptHooksStatus()` | src/ib-commands.ts:1817-1818 | `runIb(["hooks", "status", "--intercept"], ...)` | Non-blocking — setup dialog only |
| 8 | `installSafetyHooks()` | src/ib-commands.ts:1822-1823 | `runIb(["hooks", "install"], ...)` | Non-blocking — setup dialog only |
| 9 | `uninstallSafetyHooks()` | src/ib-commands.ts:1827-1828 | `runIb(["hooks", "uninstall"], ...)` | Non-blocking — setup dialog only |
| 10 | `installInterceptHook()` | src/ib-commands.ts:1832-1833 | `runIb(["hooks", "install-intercept"], ...)` | Non-blocking — setup dialog only |
| 11 | `uninstallInterceptHook()` | src/ib-commands.ts:1837-1838 | `runIb(["hooks", "uninstall-intercept"], ...)` | Non-blocking — setup dialog only |

### Category 2: index.ts CLI passthrough commands

These CLI subcommands use `runIb()` to shell out to `ib`:

| # | Command | File:Line | Exact Code | Severity |
|---|---------|-----------|------------|----------|
| 12 | `send` | src/index.ts:315 | `runIb(["send", agent.id, message], agent.repoPath)` | **Blocking** — native impl exists in ib-commands.ts but CLI doesn't use it |
| 13 | `kill` | src/index.ts:323 | `runIb(["kill", agent.id, ...extraArgs], agent.repoPath)` | **Blocking** — native impl exists in ib-commands.ts but CLI doesn't use it |
| 14 | `merge` | src/index.ts:331 | `runIb(["merge", agent.id, ...extraArgs], agent.repoPath)` | **Blocking** — native impl exists in ib-commands.ts but CLI doesn't use it |
| 15 | `resume` | src/index.ts:339 | `runIb(["resume", agent.id, ...extraArgs], agent.repoPath)` | **Blocking** — native impl exists in ib-commands.ts but CLI doesn't use it |
| 16 | `new-agent` | src/index.ts:376 | `runIb(["new-agent", ...ibArgs], repoPath)` | **Blocking** — native impl exists in ib-commands.ts but CLI doesn't use it |
| 17 | `acknowledge` | src/index.ts:407 | `runIb(["acknowledge", questionId], repoPath)` | **Blocking** — no native impl exists |

### Category 3: newAgent() spawns `ib watchdog`

| # | Location | File:Line | Exact Code | Severity |
|---|----------|-----------|------------|----------|
| 18 | `newAgent()` | src/ib-commands.ts:1630 | `Bun.spawn(["ib", "watchdog", id], { cwd: rootRepoPath, ... })` | **Blocking** — spawns ib's bash watchdog for each new agent |

### Category 4: Agent hook commands (written into agent settings.json)

These are `ib` commands written into spawned agents' settings files, executed by Claude Code inside agent tmux sessions — not by itsybitsy itself:

| # | Hook | File:Line | Command | Nature |
|---|------|-----------|---------|--------|
| 19 | PreToolUse path check | src/ib-commands.ts:1148 | `ib hook-check-path ${agentId}` | **Agent-side** — runs inside agent |
| 20 | PreToolUse intercept | src/ib-commands.ts:1152 | `ib hooks intercept-task` | **Agent-side** — runs inside agent |
| 21 | Stop hook | src/ib-commands.ts:1163 | `ib hook-status ${agentId}` | **Agent-side** — runs inside agent |
| 22 | PermissionRequest | src/ib-commands.ts:1164 | `ib hook-permission-denied ${agentId}` | **Agent-side** — runs inside agent |
| 23 | SessionStart | src/ib-commands.ts:1166 | `ib hooks session-start` | **Agent-side** — runs inside agent |

### Category 5: resume.sh shell script (written to disk, runs inside tmux)

| # | Location | File:Line | Code | Nature |
|---|----------|-----------|------|--------|
| 24 | resume.sh PATH setup | src/ib-commands.ts:418 | `export PATH="${gitRoot}:$PATH"` with comment "Add git repo root to PATH so 'ib' is available" | **Agent-side** — ensures spawned agents can find ib |
| 25 | newAgent startup script | src/ib-commands.ts:1529 | Same PATH setup in new-agent startup | **Agent-side** |

### Category 6: Startup guard

| # | Location | File:Line | Code | Severity |
|---|----------|-----------|------|----------|
| 26 | watch command | src/index.ts:90-92 | `if (!Bun.which("ib"))` — refuses to start dashboard if ib not on PATH | **Blocking** — prevents self-contained operation |

### Category 7: ib permissions in settings

| # | Location | File:Line | Code | Nature |
|---|----------|-----------|------|--------|
| 27 | Agent settings | src/ib-commands.ts:1102-1103 | `"Bash(ib:*)", "Bash(./ib:*)"` in agent permissions allow list | **Agent-side** — allows agents to run ib |
| 28 | Root repo settings | src/ib-commands.ts:1372-1382 | Adds `Bash(ib:*)` to root repo settings for non-worktree mode | **Agent-side** |

---

## Recommended Fixes by Priority

### High Priority (breaks self-containment)

1. **index.ts CLI commands (items 12-17):** Wire CLI subcommands to call native ib-commands.ts functions instead of `runIb()`. The native implementations already exist for send, kill, merge, resume, and new-agent. Only `acknowledge` needs a native implementation.

2. **`ib watchdog` spawn (item 18):** Replace `Bun.spawn(["ib", "watchdog", id])` with itsybitsy's own built-in watchdog from `src/watchdog.ts`. The watchdog module already exists natively.

3. **`reassignAgent()` (item 1):** Implement natively — it just updates the `manager` field in meta.json and notifies relevant agents.

4. **`mergeCheckAgent()` (item 2):** Implement natively — it checks if an agent's branch can merge cleanly (rebase check logic already exists in `checkRebaseConflicts()`).

5. **`diffAgent()` / `statusAgent()` (items 3-4):** Implement natively using `Bun.spawn(["git", ...])` — the CLI already does this natively in index.ts:257 and index.ts:284. Just reuse that logic.

6. **`acknowledgeQuestion()` (item 5):** Implement natively — write the answer to the question file and send notification to the agent.

7. **Startup guard (item 26):** Remove or relax the `Bun.which("ib")` check. itsybitsy should work without ib on PATH once all native implementations are complete.

### Medium Priority (hook infrastructure)

8. **Hook commands (items 19-23):** These run inside spawned agents. To be fully self-contained, itsybitsy needs to ship its own hook scripts or implement `ib hook-check-path`, `ib hook-status`, `ib hook-permission-denied`, `ib hooks intercept-task`, and `ib hooks session-start` as itsybitsy subcommands.

9. **Hooks management (items 6-11):** Implement `hooksStatus`, `installSafetyHooks`, `uninstallSafetyHooks`, etc. natively — these just read/write Claude Code settings files.

### Low Priority (cosmetic / agent-side)

10. **PATH exports in scripts (items 24-25):** These ensure spawned agents can find `ib`. Once hooks are self-contained, these can be changed to put itsybitsy on PATH instead.

11. **ib permissions in settings (items 27-28):** These allow spawned agents to call ib. Once hooks use itsybitsy, change to `Bash(itsybitsy:*)`.

---

## Document/Comment References (informational only, not runtime dependencies)

These are comments that reference ib's behavior for documentation purposes — no code changes needed:

- src/ib-commands.ts:2 — "Async wrappers for ib mutation commands"
- src/ib-commands.ts:4 — "others delegate to ib CLI"
- src/ib-commands.ts:84,86 — "replaces `ib kill`", "mirrors do_kill in ib bash"
- src/agent-lifecycle.ts:2-3 — "used by multiple ib commands", "mirrors ib bash script"
- src/watchdog.ts:7 — "Coexists with ib's per-agent bash watchdog"
- src/parse-state.ts:2,66 — "Port of ib's parse_state"
- src/auto-compact.ts:5,15,42,58,67 — "Matches ib's ..." (various)
- Various test files — reference ib for naming/descriptions

---

## Scorecard

| Category | Total | Native | ib Passthrough | % Native |
|----------|-------|--------|----------------|----------|
| Core lifecycle (kill/nuke/pause/resume/merge/send/new-agent) | 7 | 7 | 0 | 100% |
| CLI subcommands | 12 | 6 | 6 | 50% |
| TUI dashboard wrappers | 11 | 5 | 6 | 45% |
| Hook infrastructure | 5 | 0 | 5 | 0% |
| Hook management | 6 | 0 | 6 | 0% |
| Watchdog spawn | 1 | 0 | 1 | 0% |
| **Overall runtime calls** | **42** | **18** | **24** | **43%** |

Note: If we exclude agent-side hooks (which run inside spawned agents, not itsybitsy itself), the picture improves: **18 native / 13 passthrough = 58% self-contained** for itsybitsy's own process.

The 6 CLI passthrough commands in index.ts are the lowest-hanging fruit — native implementations already exist in ib-commands.ts, they just need to be wired up.

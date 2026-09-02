# SPEC: Antigravity CLI (`agy`) as an alternative agent model

Status: **Phases 1–3 MERGED on `agent/antigravity` (Phase 1 `7cf0e65`, Phase 2 `288a577`, Phase 3 `b38052f`, 2026-09-02). Live spawn gate PASSED 2026-09-02 13:41 CDT (NOTES §17.11). READY for the user to merge to `main`, rebuild `ib`, and restart `ib watch`.** Written 2026-09-01 by researcher agent `antigravity` on branch `agent/antigravity`. All facts are pinned to `agy` 1.1.23 on macOS with Google OAuth sign-in. Evidence and captures live in `ANTIGRAVITY-CLI-NOTES.md` §17; this file is the design source of truth. Read it next to `SPEC-CODEX-MODEL.md`, whose shape it follows, and the Cross-Cutting Review Checklist in `CLAUDE.md`.

---

## 1. Summary & goal

A user selects `agy:<model-slug>` as an agent's model (e.g. `agy:gemini-3.7-flash-low`, `agy:claude-sonnet-4-6`). itsybitsy launches the **interactive `agy` TUI inside tmux**, exactly as it launches `claude` and `codex`. Permissions are enforced by a **generated PreToolUse hook** that translates the same agent-type allow/deny lists into `agy` tool calls, **deny-by-default**, so the agent **never shows an approval card**. The agent's role instructions are delivered through an **always-on rule file** in the worktree. Auth is the user's job (one browser sign-in; credentials live in the keyring).

Non-goals (v1): no headless `-p` loop; no terminal sandbox; no `agy` custom agents (`--agent`); no coordinators under `agy`; no new dashboard panes.

---

## 2. Authoritative decisions

| # | Decision | Why (evidence in NOTES §17) |
|---|---|---|
| D1 | Selector is `agy:<slug>`; the slug is the first column of `agy models` and is passed verbatim to `--model`. Bare names are rejected as for every CLI. `--effort <low\|medium\|high>` is passed only when the slug does **not** already end in `-low`/`-medium`/`-high` (Gemini slugs encode effort; passing both would be ambiguous). itsybitsy's `xhigh`/`max` map to `high`, as for codex. | `agy models` output; `--help` |
| D2 | Launch = `agy --dangerously-skip-permissions --mode=accept-edits --model <slug> [--effort <e>] --log-file <agentDir>/agy.log -i "<prompt>"` in tmux. Resume = same flags with `--conversation <uuid>` and no `-i`. | A hook `allow` cannot suppress the permission card, but under skip-permissions nothing prompts and a hook `deny` still blocks. `-i` runs the prompt and stays interactive. Resume does not carry `--model`. |
| D3 | **The PreToolUse hook is the only boundary.** Registered in `<worktree>/.agents/hooks.json` under the named hook `ittybitty` for `PreToolUse` (matcher `*`), `PreInvocation`, and `Stop`, each `command` = `<abs ib> hooks agy-<event> <agentId>`, `timeout` 30. No `--add-dir`, no sandbox. | Hooks load from the workspace file only; there is no inline flag. Workspace file tools outside the worktree succeed under skip-permissions, so the hook must gate paths too. |
| D4 | The hook contract is **fail-closed**: crash, non-JSON, `{}`, and timeout all deny. The dispatcher still wraps everything in try/catch and emits an explicit deny with a reason so denials are logged, and exits 0. | Verified for all three failure shapes. |
| D5 | **Pre-trust the worktree before launch.** Add `realpath(worktree)` to `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` (read-modify-write, preserve every other key, guarded by an itsybitsy lock file) before the tmux session starts. Remove the entry at teardown, best effort. The watchdog auto-accepts the trust card only as a fallback. | In an untrusted directory `-i` submits the prompt ~2 s after launch, before the card is answered, with no hooks and no rules loaded. Pre-trusted: hooks load at +30 ms, first turn is gated. |
| D6 | Instructions go in `<worktree>/.agents/rules/ittybitty-agent.md` with frontmatter `trigger: always_on`. Body = the session-start template (wrapper stripped) + inlined project `CLAUDE.md` + inlined user `~/.claude/CLAUDE.md` + the skills catalogue. Never overwrite `AGENTS.md`. No `--agent`. | A bare rule file is ignored; with `trigger: always_on` it loads alongside the repo's own `AGENTS.md`. Workspace custom agents are not discovered; a global one drops the workspace rules. `agy` has no `@file` import. |
| D7 | Both generated files are appended to the worktree `.gitignore` (same helper as codex's `.codex/`). If either path is already **tracked** in the repo, the spawn is refused with a clear error (v1). | Overwriting a tracked file would dirty the worktree and clobber the repo's own hooks. |
| D8 | Sub-agent tools (`invoke_subagent`, `define_subagent`, `manage_subagents`) are always denied with the reason "spawn sub-agents with `ib new-agent`". Every tool not in the translation table is denied unless an agent-type allow list names the raw `agy` tool. | Hook deny now blocks `invoke_subagent` (issue #640 fixed in 1.1.23). |
| D9 | State: `PreInvocation` → `running` and captures `agy_conversation_id`; `Stop` → `waiting`, or `complete` when the last `PLANNER_RESPONSE` in the transcript carries the completion sentinel; `Stop` with non-empty `error` is logged. `Stop` may return `{"decision":"continue","reason":…}` for the uncommitted-work nudge, as `codex-stop` does. | Payloads verified; `continue` re-enters the loop and agy caps it. |
| D10 | Watchdog: gate the Claude-only branches on `classifyAgentCli`; add two `agy` answers — `Enter` on `Do you trust the contents of this project?` (fallback only) and `0` on `How's the CLI experience so far?`. | Card and overlay text captured. |
| D11 | Rendering: leave `altScreenMode` alone (alt-screen by default; the pane shows the current agy screen). No SSH-env tricks. The dashboard treats the pane as screen-only for `agy` agents. | Inline mode needs a global setting and leaves duplicate frames in scrollback; SSH env vars break sign-in. |
| D12 | `meta.model` stores the raw `agy:<slug>`; UI renders it verbatim. New optional meta field `agy_conversation_id`. `claude_pid` keeps its name. | Same as codex. |
| D13 | `~/.gemini/config/` is never written. The only global mutation is the `trustedWorkspaces` entry of D5. | |

---

## 3. Confirmed `agy` facts that shape the code (see NOTES §17 for captures)

- Hook payload common fields: `conversationId`, `workspacePaths[]`, `modelName`, `transcriptPath` (`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`), `artifactDirectoryPath`. No `cwd`. Hook process cwd = `<worktree>/.agents`; env has `ANTIGRAVITY_CONVERSATION_ID`.
- `PreToolUse` input: `toolCall.name`, `toolCall.args`, `stepIdx`. Output: `{"decision":"allow"|"deny","reason":"…"}`. Deny is a silent hard block; the model sees `tool call denied by pre-tool hook: <reason>`.
- Tool args: `run_command{CommandLine,Cwd,WaitMsBeforeAsync}`, `view_file{AbsolutePath}`, `list_dir{DirectoryPath}`, `write_to_file{TargetFile,CodeContent,Overwrite,Description}`, `replace_file_content{TargetFile,TargetContent,ReplacementContent,StartLine,EndLine,AllowMultiple,Instruction,Description}`, `invoke_subagent{Subagents:[{Model,Prompt,Role,TypeName,Workspace}]}`. Every tool also has `toolAction`, `toolSummary`.
- `PreInvocation`/`PostInvocation`: `invocationNum` (from 0, per turn), `initialNumSteps`. `Stop`: `terminationReason` (`NO_TOOL_CALL` on a normal turn end), `error`, `executionNum`, `fullyIdle`. `Stop` output `{}` or `{"decision":"continue","reason":"…"}`.
- Transcript lines: `{step_index, source: USER_EXPLICIT|MODEL, type: USER_INPUT|PLANNER_RESPONSE, status, created_at, content?, tool_calls?}`.
- Log line to verify registration: `hooks_manager.go:…] loaded 1 named hooks from 1 hooks.json file(s)` in the `--log-file`.
- TUI strings: idle = a `>` line between `────` separators with `? for shortcuts` bottom-left; working = `⢿  Running command...` / `⣯  Generating...` / `⣻  Reading file...` with `esc to cancel` bottom-left; tool lines `● Bash(…)`, `● Read(…)`, `● Edit(…)`, `● ListDir(…)`, `● Agent(…)`; status right = `accept-edits · <model label> · <effort>`.

---

## 4. Design

### 4.1 Selector (`src/agent-cli.ts`)

- `AgentCli` gains `"agy"`; `KNOWN_CLIS` gains `"agy"`; error messages list `claude, codex, fugu, agy`.
- `mapEffortForAgy(effort)` = same table as `mapEffortForCodex`. `agySlugHasEffort(slug)` = `/-(low|medium|high)$/`.
- `src/known-models.ts`: add `agy:gemini-3.7-flash-high`, `agy:gemini-3.7-flash-low`, `agy:gemini-3.1-pro-high`, `agy:claude-sonnet-4-6`, `agy:claude-opus-4-6-thinking` with descriptions; discovery only, never a spawn-time allow-list.

### 4.2 Worktree files (`src/agy-config.ts`)

- `buildAgyHooksJson({ibBinaryPath, agentId, timeoutSecs?})` → the JSON text for `.agents/hooks.json`:
  ```json
  {"ittybitty": {
    "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "<abs ib> hooks agy-pre-tool-use <id>", "timeout": 30}]}],
    "PreInvocation": [{"type": "command", "command": "<abs ib> hooks agy-pre-invocation <id>", "timeout": 30}],
    "Stop": [{"type": "command", "command": "<abs ib> hooks agy-stop <id>", "timeout": 30}]
  }}
  ```
  `command` runs under `sh -c`, so `<abs ib>` must pass `isCodexSafeBinaryPath` (reuse it; rename later) and `<agentId>` must pass `isValidAgentId`.
- `buildAgyRulesFile(ctx)` → `---\ntrigger: always_on\ndescription: itsybitsy agent instructions\n---\n` + body. The body reuses `generateInstructions` + `stripIttybittyWrapper` from the codex path, then appends the project `CLAUDE.md` **inlined** (not `@./CLAUDE.md`), the user-global `CLAUDE.md` inlined, and `buildSkillsSection()`. Factor the shared pieces out of `codex-spawn.ts` rather than copying them.
- `AGY_WORKTREE_FILES = [".agents/hooks.json", ".agents/rules/ittybitty-agent.md"]`; `appendGitignoreEntries(worktree, entries)` generalizes `appendCodexGitignoreEntry` (same negation rule).
- `ensureAgyTrustedWorkspace(realWorktree)` / `removeAgyTrustedWorkspace(realWorktree)`: read `~/.gemini/antigravity-cli/settings.json` (create `{}` if missing), add/remove the path in `trustedWorkspaces`, preserve all other keys, write atomically (tmp + rename) under `~/.itsybitsy/.agy-settings.lock` (advisory, same pattern as the outbox lock). Idempotent.

### 4.3 Tool translation (`src/hooks/agy-tools.ts`)

The agent-type allow/deny lists stay in Claude vocabulary. Each `agy` call is translated to a synthetic Claude call and passed through the existing `checkPathAccess`:

| `agy` tool | Synthetic Claude call | Path arg |
|---|---|---|
| `run_command` | `Bash` with `command = CommandLine`, cwd = `Cwd` | via Bash path scanner |
| `view_file` | `Read` | `AbsolutePath` |
| `list_dir` | `LS` | `DirectoryPath` |
| `find_by_name` | `Glob` | `SearchDirectory` if present, else `DirectoryPath` |
| `grep_search` | `Grep` | `SearchPath` if present, else none |
| `write_to_file` | `Write` | `TargetFile` |
| `replace_file_content` | `Edit` | `TargetFile` |
| `multi_replace_file_content` | `MultiEdit` | `TargetFile` |
| `read_url_content` | `WebFetch` | — |
| `search_web` | `WebSearch` | — |
| `manage_task` | `TodoWrite` | — |
| `invoke_subagent`, `define_subagent`, `manage_subagents` | always deny (D8) | — |
| anything else | deny unless the merged allow list contains the raw `agy` name | — |

Unknown arg shapes must not fail open: a file tool whose path arg is missing is denied with "path argument missing". Path isolation forces `allowedPaths` to the worktree (plus the type's `allowedPaths`) exactly as `checkCodexPreToolUse` does for `apply_patch`, so `/tmp` and `~/.itsybitsy` are not writable through file tools.

### 4.4 Hook handlers (`src/hooks/agy-*.ts`)

- `agy-pre-tool-use.ts`: read stdin JSON; resolve the agent from `<agentId>` argv (agent dir, worktree, agents dir, root repo, agent type — copy `resolveAgentContext` from the codex handler into a shared helper); load merged permissions the same way; translate; decide; on allow write `{"decision":"allow","reason":"…"}`; on deny log `[PreToolUse] Permission denied: <tool> (<args>)` to `agent.log` and write `{"decision":"deny","reason":"…"}`. Capture `conversationId` into `meta.agy_conversation_id` if empty (defensive fallback).
- `agy-pre-invocation.ts`: `writeAgentState("running")`; capture `agy_conversation_id`; touch `<agentDir>/agy-hook-heartbeat` (the liveness marker); output `{}`.
- `agy-stop.ts`: state per D9; read the tail of `transcriptPath` (last `PLANNER_RESPONSE` with `content`) and run `detectStateFromMessage`; if `complete` and `git status --porcelain` is non-empty, write `running` back and return the continue payload; else `{}`.
- `agy-dispatcher.ts`: mirrors `codex-dispatcher.ts` (validate agentId first, dynamic import, try/catch, always exit 0 in production, `--dry-run` may exit non-zero and exercises the real handler with a synthetic payload).
- `src/index.ts`: routes `hooks agy-pre-tool-use|agy-pre-invocation|agy-stop [--dry-run]` and help text.

### 4.5 Spawn and resume (`src/agy-spawn.ts`, `src/ib-commands.ts`)

`newAgent()` branches on `parseModel(model).cli === "agy"`:
1. Skip `.claude/settings.local.json`.
2. Refuse if `git ls-files --error-unmatch` reports either worktree file as tracked (D7).
3. Write `.agents/hooks.json` and `.agents/rules/ittybitty-agent.md`; append both to `.gitignore`.
4. `ensureAgyTrustedWorkspace(realpath(worktree))` (D5).
5. Run the dispatcher precheck: `ib hooks agy-pre-tool-use --dry-run <id>` + the two others.
6. Generate `start.sh` via `buildAgyStartContent` (same skeleton as `buildCodexStartContent`: `unset CLAUDECODE …`, SIGHUP trap, `setsid`, stderr sidecar, `ib write-pid`, `wait`, exit-code annotation, exit-check). Launch line per D2 with `-i "$(cat <promptfile>)"`.
`resumeAgent()`: requires `meta.agy_conversation_id`; regenerates the two worktree files (picks up permission edits); re-runs pre-trust and precheck; `buildAgyResumeContent` launches with `--conversation`. Teardown (`archiveAgent` / nuke / retire) calls `removeAgyTrustedWorkspace` best effort. `--coordinator` with `agy:` is rejected (D11-style stub message).

### 4.6 Watchdog, state, dashboard

- `classifyAgentCli` already returns the parsed cli; the three Claude-only branches skip `agy` like codex. Add an `agy` branch: `Enter` when the pane contains `Do you trust the contents of this project?` (fallback), `0` when it contains `How's the CLI experience so far?`.
- Liveness: `runPerAgentWatchdog` for `agy` agents checks that `agy-hook-heartbeat` appears within 60 s of spawn; if not, log loudly and notify the manager (no kill in v1).
- `parseStateForCli` gets an `agy` branch: `esc to cancel` bottom-left or a `⣯`/`⢿`-style spinner line → running; `? for shortcuts` with a bare `>` line → idle (defers to meta state); `Do you trust the contents` → creating. `rate_limited`/`api_error` overrides stay `unknown` until strings are captured.
- Dashboard: model column renders `agy:<slug>` verbatim; `computeChromeSlice` gets an `agy` detector (last two `────` separators, same as Claude's `findLastTwoSeparators` shape) or no trimming.
- `ib state`: orphan pattern for `agy --conversation <uuid>` / `agy --dangerously-skip-permissions` with cwd inside a worktree.

---

## 5. Phases (each ends green on `bun test` + `bunx tsc --noEmit`)

### Phase 1 — Selector, translation, hook handlers, worktree-file builders (no spawn wiring)
**MERGED 2026-09-02** (worker `agent-b99ce619`, 24 commits, tip `7cf0e65`; full suite 5009 pass / 2 known worktree-only dashboard fails / 0 tsc). Seven review rounds (4 boundary, 3 regression) hardened the SHARED Bash scanner for every CLI: model-controlled `Cwd` validated; deny list enforced; settings.json never clobbered; relative `..` traversal denied with a conservative rule (any `..` token carrying quotes, `$`, braces, backticks, backslashes, globs, or a leading `~` is denied outright; heredoc bodies are data); `MultiEdit` in `WRITE_TOOLS`; `checkIbCommandAccess` on `run_command`; every agy `run_command` must be a single command (`findShellMetachar`, now in `src/hooks/shell-metachar.ts`, whose multi-part heredoc delimiter bug and arithmetic-`<<` false heredoc were fixed for coordinators too); the agy boundary files and `.claude/settings*.json` are write-protected through file tools, `sed -i`, and every redirect spelling (`>`, `>>`, `1>`, `&>`, `>|`). Extra modules: `src/hooks/agent-context.ts`, `src/agent-instructions-shared.ts`, `src/worktree-gitignore.ts`, `src/agy-worktree-files.ts`.
Files: `src/agent-cli.ts`, `src/known-models.ts`, `src/config-command.ts` (if it lists CLIs), `src/agy-config.ts`, `src/hooks/agy-tools.ts`, `src/hooks/agy-pre-tool-use.ts`, `src/hooks/agy-pre-invocation.ts`, `src/hooks/agy-stop.ts`, `src/hooks/agy-dispatcher.ts`, `src/index.ts` routes + help, `src/agents.ts` (`agy_conversation_id?: string`). Shared helpers factored out of `codex-spawn.ts` / `codex-pre-tool-use.ts` where reused (no copy-paste of `resolveAgentContext`, `stripIttybittyWrapper`, `buildSkillsSection`).
Tests: `parseModel("agy:gemini-3.7-flash-low")`; unknown cli message lists agy; translation table incl. deny for sub-agent tools and for unknown tools; path isolation denies `view_file` of a sibling worktree, `write_to_file` under `/tmp`, `run_command cat ../other`; allow for in-worktree `Read`/`Write`/allow-listed `git status`; JSON contract shapes; dispatcher deny-on-exception and `--dry-run`; `buildAgyHooksJson` parses and points at the right commands; `buildAgyRulesFile` starts with the `trigger: always_on` frontmatter and inlines both CLAUDE.md files; `ensureAgyTrustedWorkspace` add/remove/idempotent/preserves other keys (use a temp HOME). Claude and codex byte-snapshot tests untouched.

### Phase 2 — Spawn, resume, teardown
`src/agy-spawn.ts`, `newAgent()` / `resumeAgent()` branches, gitignore append, tracked-file refusal, pre-trust, precheck, teardown untrust, coordinator rejection, `ib list-models` entries. Gate: unit tests for the script builders (shell-quoted argv, `-i` present on start and absent on resume, `--conversation` on resume, `--effort` rule) plus a manual spawn: `ib new-agent --model agy:gemini-3.7-flash-low --type worker "…"` appears in `ib list`, runs an allow-listed command with no card, is denied on `cat ../..`, `ib send` reaches it, `ib resume` works.

### Phase 3 — Watchdog, state, dashboard, docs
Watchdog gating + two answers + heartbeat check; `parseStateForCli` agy branch with fixtures from NOTES §17.7; chrome detector; `ib state` pattern; SPEC.md §19 summary; `docs/implementation-notes.md` and `CLAUDE.md` updates. Gate: fixtures-based tests; a real `agy` agent shows running/waiting/complete correctly in `ib watch`.

---

## 6. Risks

1. **Version drift.** 1.1.23 behaviour (silent deny, fail-closed, `-i`, payload keys) can change weekly. Stamp `agy --version` into `meta.agy_version` at spawn and keep the fixtures dated.
2. **Trust file races.** agy rewrites `settings.json` itself on every trust accept and settings change. The lock protects itsybitsy from itsybitsy only; a concurrent user-driven rewrite could drop an entry. Mitigation: the watchdog fallback (D10) and re-running pre-trust on resume.
3. **Hooks silently absent under API-key auth** (issue #893). The heartbeat check surfaces it; v1 only warns.
4. **`Stop` never fires on Linux** (issue #770). macOS verified; the tmux fallback covers idle detection.
5. **Alt-screen capture** shows only the current screen; long transcripts are not scrollable from the dashboard for `agy` agents.
6. **Repos that track `.agents/hooks.json` or the rules path** cannot host `agy` agents in v1 (spawn refuses).
7. **Quota / licensing.** The account on this machine shows `Antigravity Starter Quota`; a 403 on the quota endpoint was seen once. Rate-limit strings are not captured yet.
8. **codex handler omits `checkIbCommandAccess` (parity gap, follow-up).** Phase 1 added the manager-only-`ib`-subcommand relationship check (`ib retire/merge/nuke/pause/resume/reassign <other>`) to the agy PreToolUse handler, matching the claude `hookCheckPath`. The codex `hookCodexPreToolUse` still lacks it, so a codex agent with `Bash(ib:*)` can run those subcommands against agents it does not manage. Not changed in the agy Phase 1 work to keep codex byte-identical; track as a codex-side follow-up (add the same `checkIbCommandAccess` call for Bash before `checkCodexPreToolUse`).
9. **`run_command` reads outside the worktree are allowed.** A single `run_command` such as `cat ~/.ssh/id_rsa` or `cat /etc/passwd` (absolute paths outside the repo, no traversal into a sibling/main-repo) passes the bash gate — the same model claude workers run under, where the shared scanner only isolates sibling-agent and main-repo paths. agy has no sandbox, so this is an inherited default rather than an agy-specific hole. Needs a conscious decision (an allowlist of readable roots, or accepting the claude-parity default) before treating any read as sensitive; not fixed in Phase 1.
10. **macOS Gatekeeper can stall every agy exec in the dynamic loader when the quarantined Homebrew binary's notarization check cannot reach Apple** (observed 2026-09-02 02:18 CDT: `syspolicyd` 'Security policy would not allow process' + a 30 s QUIC lookup with 0 bytes); the spawn then sits at a blank pane with no agy log; remedy is on the user side (approve or de-quarantine the binary).

---

## 7. Process

- Phase commits land on `agent/antigravity`. Each phase is implemented by a `worker` agent from this SPEC, reviewed, and merged with `ib merge --force` by the researcher agent.
- Any load-bearing finding during implementation updates this SPEC before the next phase starts; `ANTIGRAVITY-CLI-NOTES.md` stays evidence-only.

# SPEC: Antigravity CLI (`agy`) as an alternative agent model

Status: **Phases 1–3 MERGED on `agent/antigravity` (Phase 1 `7cf0e65`, Phase 2 `288a577`, Phase 3 `b38052f`, 2026-09-02). Live spawn gate PASSED 2026-09-02 13:41 CDT (NOTES §17.11). READY for the user to merge to `main`, rebuild `ib`, and restart `ib watch`.** Written 2026-09-01 by researcher agent `antigravity` on branch `agent/antigravity`. All facts are pinned to `agy` 1.1.23 on macOS with Google OAuth sign-in. Evidence and captures live in `ANTIGRAVITY-CLI-NOTES.md` §17; this file is the design source of truth. Read it next to `SPEC-CODEX-MODEL.md`, whose shape it follows, and the Cross-Cutting Review Checklist in `CLAUDE.md`.

**Current sandbox and path-policy contract:** Agy uses the shared top-level
`paths:` policy and kernel sandbox. Sandbox enablement defaults to true; the
most-specific explicit `sandbox: true` / `sandbox: false` or `sandbox.enabled`
value wins across type layers and inheritance. Enabled launches and resumes
require the kernel wrapper and egress proxy, and may bypass native prompts.
Disabled launches and resumes omit the wrapper, proxy, and native approval
bypass flags; generated hooks remain active alongside agy's native protections.
Refresh applies the newly resolved policy through the shared lifecycle.

`meta.paths` plus agy-appropriate runtime roots feed `resolvePreparedAccess()`.
A missing paths block defaults all three lists to empty; a partial object keeps
populated entries and defaults only omitted lists. The retired `allowedPaths`
field is rejected. Instructions, `ib info`, and the dashboard report the frozen
kernel state. [SPEC.md](SPEC.md) and
[SPEC-PATH-ALLOWLIST.md](SPEC-PATH-ALLOWLIST.md) define the cross-CLI contract.

---

## 1. Summary & goal

A user selects `agy:<model-slug>` as an agent's model (e.g. `agy:gemini-3.7-flash-low`, `agy:claude-sonnet-4-6`). itsybitsy launches the **interactive `agy` TUI inside tmux**, exactly as it launches `claude` and `codex`. A **generated PreToolUse hook** translates the same agent-type allow/deny lists into `agy` tool calls, **deny-by-default**. With the kernel sandbox enabled, native approval prompts are bypassed inside the wrapper. With it disabled, native approval behavior remains in effect. The agent's role instructions are delivered through an **always-on rule file** in the worktree. Auth is the user's job (one browser sign-in; credentials live in the keyring).

Non-goals (v1): no headless `-p` loop; no `agy` custom agents (`--agent`); no coordinators under `agy`; no new dashboard panes.

---

## 2. Authoritative decisions

| # | Decision | Why (evidence in NOTES §17) |
|---|---|---|
| D1 | Selector is `agy:<slug>`; the slug is the first column of `agy models` and is passed verbatim to `--model`. Bare names are rejected as for every CLI. `--effort <low\|medium\|high>` is passed only when the slug does **not** already end in `-low`/`-medium`/`-high` (Gemini slugs encode effort; passing both would be ambiguous). itsybitsy's `xhigh`/`max` map to `high`, as for codex. **The reserved slug `agy:default` is a sentinel: it launches agy with **no** `--model` and **no** `--effort`, so agy uses its own configured default model (currently Gemini 3.8 Flash High). It is never sent to `--model` — an unknown slug makes agy print "model not recognized" and fall back anyway, so we omit the flag instead.** | `agy models` output; `--help`; the `agy --model gemini` warning |
| D2 | Launch = `agy [--model <slug>] [--effort <e>] --log-file <agentDir>/agy.log -i "<prompt>"` in tmux. Only enabled kernel mode adds `--dangerously-skip-permissions --mode=accept-edits` beneath the kernel wrapper. Disabled mode omits both overrides. Resume uses the same policy with `--conversation <uuid>` and no `-i`. The `--model`/`--effort` pair is omitted entirely for the `agy:default` sentinel (D1). | A hook `allow` cannot suppress the permission card, but under skip-permissions nothing prompts and a hook `deny` still blocks. `-i` runs the prompt and stays interactive. Resume re-passes model and effort except for the default sentinel. |
| D3 | **The PreToolUse hook is installed in both kernel modes.** It is registered in `<worktree>/.agents/hooks.json` under the named hook `ittybitty` for `PreToolUse` (matcher `*`), `PreInvocation`, and `Stop`, each `command` = `<abs ib> hooks agy-<event> <agentId>`, `timeout` 30. Enabled mode requires the shared kernel wrapper; disabled mode retains native protections and hook checks. | Hooks load from the workspace file only; there is no inline flag. The hook gates paths through the shared `paths:` resolver, but remains a hook-only boundary for shell command shapes its advisory scanner cannot model. |
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
- `src/known-models.ts`: mirror the `agy models` catalogue — `agy:default` (the D1 sentinel) plus every reported slug (`gemini-3.8/3.7/3.6-flash-{high,medium,low}`, `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`) with descriptions; discovery only, never a spawn-time allow-list. Refresh when `agy models` changes.
- `AGY_DEFAULT_MODEL` / `isAgyDefaultModel(slug)` in `src/agent-cli.ts` gate the sentinel; `agyModelAndEffortFlags(slug, effort)` in `src/agy-spawn.ts` returns `""` for it (no `--model`/`--effort`) and the D1 fragment otherwise.

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

Unknown arg shapes must not fail open: a file tool whose path arg is missing is
denied with "path argument missing". Path isolation uses the shared prepared
table built from frozen `meta.paths` plus agy-appropriate runtime roots. Missing,
empty blocks grant no configured paths; a partial object retains populated
entries and defaults only omitted member lists to empty. Claude's project and
scratchpad roots are not added. File tools and recognizable literal paths in
`run_command` are resolved through that table. The Bash scan is advisory rather
than a complete shell parser, so it must not be described as equivalent to a
kernel boundary.

### 4.4 Hook handlers (`src/hooks/agy-*.ts`)

- `agy-pre-tool-use.ts`: read stdin JSON; resolve the agent from `<agentId>` argv (agent dir, worktree, agents dir, root repo, agent type — copy `resolveAgentContext` from the codex handler into a shared helper); load merged permissions the same way; translate; decide; on allow write `{"decision":"allow","reason":"…"}`; on deny log `[PreToolUse] Permission denied: <tool> (<args>)` to `agent.log` and write `{"decision":"deny","reason":"…"}`. Capture `conversationId` into `meta.agy_conversation_id` if empty (defensive fallback).
- `agy-pre-invocation.ts`: `writeAgentState("running")`; capture `agy_conversation_id`; touch `<agentDir>/agy-hook-heartbeat` (the liveness marker); output `{}`.
- `agy-stop.ts`: state per D9; read the tail of `transcriptPath` (last `PLANNER_RESPONSE` with `content`) and run `detectStateFromMessage`; if `complete` and `git status --porcelain` is non-empty, write `running` back and return the continue payload; else `{}`.
- `agy-dispatcher.ts`: mirrors `codex-dispatcher.ts` (validate agentId first, dynamic import, try/catch, always exit 0 in production, `--dry-run` may exit non-zero and exercises the real handler with a synthetic payload).
- `src/index.ts`: routes `hooks agy-pre-tool-use|agy-pre-invocation|agy-stop [--dry-run]` and help text.

### 4.5 Spawn and resume (`src/agy-spawn.ts`, `src/ib-commands.ts`)

`newAgent()` branches on `parseModel(model).cli === "agy"`:

1. Resolve and freeze sandbox policy. Enabled mode requires the shared kernel
   wrapper, seal, and egress proxy; missing required components fail closed.
   Disabled mode omits these and the native approval bypass flags. The earlier
   diagnostic `agy --version` probe may already have run.
2. Skip `.claude/settings.local.json`.
3. Refuse if `git ls-files --error-unmatch` reports either worktree file as tracked (D7).
4. Write `.agents/hooks.json` and `.agents/rules/ittybitty-agent.md`; append both to `.gitignore`.
5. `ensureAgyTrustedWorkspace(realpath(worktree))` (D5).
6. Run the dispatcher precheck: `ib hooks agy-pre-tool-use --dry-run <id>` + the two others.
7. Generate `start.sh` via `buildAgyStartContent` (same skeleton as `buildCodexStartContent`: `unset CLAUDECODE …`, SIGHUP trap, `setsid`, stderr sidecar, `ib write-pid`, `wait`, exit-code annotation, exit-check). Launch line per D2 with `-i "$(cat <promptfile>)"`.

`resumeAgent()`: requires `meta.agy_conversation_id`; regenerates the two worktree files (picks up permission edits); re-runs pre-trust and precheck; `buildAgyResumeContent` launches with `--conversation`. Teardown (`archiveAgent` / nuke / retire) calls `removeAgyTrustedWorkspace` best effort. `--coordinator` with `agy:` is rejected (D11-style stub message).

### 4.6 Watchdog, state, dashboard

- Background processes: a live `● [HH:MM:SS] <command> running` row in the separator-bounded task section below the latest `>` input box, followed by a recognized agy status footer, overrides stored `waiting` to derived `running`. The shared detector feeds watchdog resolution, waiting-notification suppression, transient-cache writes, and dashboard reads. It preserves stored `complete`, ignores task rows in transcript/older input boxes, and clears on the next capture after the task row disappears. The agy tmux parser also recognizes this section before WAITING/idle (after the completion sentinel). Evidence: `src/fixtures/agy-background-task.txt`, captured from `sub-builder` on 2026-09-08 with a harmless 120-second background process; trailing spaces removed.
- `classifyAgentCli` already returns the parsed cli; the three Claude-only branches skip `agy` like codex. Add an `agy` branch: `Enter` when the pane contains `Do you trust the contents of this project?` (fallback), `0` when it contains `How's the CLI experience so far?`.
- Liveness: `runPerAgentWatchdog` for `agy` agents checks that `agy-hook-heartbeat` appears within 60 s of spawn; if not, log loudly and notify the manager (no kill in v1).
- `parseStateForCli` gets an `agy` branch: `esc to cancel` bottom-left or a `⣯`/`⢿`-style spinner line → running; `? for shortcuts` with a bare `>` line → idle (defers to meta state); `Do you trust the contents` → creating. `rate_limited`/`api_error` overrides stay `unknown` until strings are captured.
- Dashboard: model column renders `agy:<slug>` verbatim; `computeChromeSlice` anchors the agy input box on the latest `>` and its surrounding separators, guarded by a recognized agy status footer. Background-task rows and their third separator remain in the status area, outside the transcript. Without recognizable chrome, no trimming occurs.
- `ib state`: orphan pattern for `agy --conversation <uuid>` / `agy --dangerously-skip-permissions` / disabled `agy --log-file <path>` with cwd inside a worktree.

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
8. **Shared command authorization must retain CLI parity.** Claude, Codex, and
   agy all call `checkIbCommandAccess` for shell tools. Manager-only lifecycle
   commands require the appropriate relationship; internal sandbox helpers and
   operator-only refresh are denied to agents. Regression coverage includes
   shell chaining and line continuations.
9. **Hook-only shell scanning is incomplete (accepted limitation).** Phase B's
   shared scanner denies recognizable literal read/write paths outside
   `paths.allowRead` / `paths.allowWrite` and logs them, so a direct
   `cat ~/.ssh/id_rsa` no longer represents the current behavior. It is not a
   complete shell parser: dynamic expansion, subprocesses, and unrecognized
   command shapes can evade classification. This limitation remains when kernel sandboxing is disabled, alongside native
   CLI protections. Enabled mode additionally enforces the kernel policy.
10. **macOS Gatekeeper can stall every agy exec in the dynamic loader when the quarantined Homebrew binary's notarization check cannot reach Apple** (observed 2026-09-02 02:18 CDT: `syspolicyd` 'Security policy would not allow process' + a 30 s QUIC lookup with 0 bytes); the spawn then sits at a blank pane with no agy log; remedy is on the user side (approve or de-quarantine the binary).

---

## 7. Process

- Phase commits land on `agent/antigravity`. Each phase is implemented by a `worker` agent from this SPEC, reviewed, and merged with `ib merge --force` by the researcher agent.
- Any load-bearing finding during implementation updates this SPEC before the next phase starts; `ANTIGRAVITY-CLI-NOTES.md` stays evidence-only.

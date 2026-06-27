# itsybitsy implementation notes

Field guide for finding code. SPEC.md is the authoritative behavioral spec; this file points at modules and calls out non-obvious wiring. When a section overlaps SPEC.md, that section is the source of truth.

## Per-agent message-delivery queue (`src/outbox.ts`)

Serializes tmux writes to a single agent so two near-simultaneous sends don't interleave their `send-keys -l` chunks + `Enter` into one merged prompt. See SPEC.md §4.1.1 and §8.5.

- **Queue**: `outbox.jsonl` under `~/.itsybitsy/agents/<id>/`, accessible to every agent's sandbox so cross-agent `ib send` works under the codex `workspace-write` model (codex agents are spawned with `--add-dir <coordinatorHome>` so they can write to centralized state — outboxes, team channels, teams.json). The agent's own meta/log/state still live in the per-worktree dir; only the message queue moved. Path = `agentOutboxDir(id)` = `join(getCoordinatorHome(), "agents", id)`. `OutboxMessage = {id, message, fromAgent, raw, enqueuedAtMs}`. `enqueueOutbox` mkdir's the dir then does a single-line `appendFile` (no message loss). `readOutbox` is FIFO and skips malformed lines. `rewriteOutboxRemoving(dir, deliveredIds)` does tmp+rename of the remainder and re-reads to preserve mid-drain appends, then unlinks when empty. `deleteAgentOutbox` removes queue + lock at teardown, then best-effort rmdir's the per-agent dir.
- **Lock**: `.outbox.lock`, advisory via `open(path, "wx")` (O_CREAT|O_EXCL). `acquireOutboxLock` retries with backoff to ~5s, writes a `<pid>:<uuid>` body (the uuid is an ownership token). `steal` removes a stale lock (mtime > 30s) — set by the inline fallback, never the drain. `releaseOutboxLock`/steal only `unlink` when the on-disk token matches (`unlinkIfToken`), so a stolen-from holder never deletes the thief's lock. Always `releaseOutboxLock` in `finally`. Keyed per-agent (== per tmux session) — **no central dispatcher**.
- **`sendMessage` (ib-commands.ts)**: resolve sender (cwd-detect at ENQUEUE time via `resolveSenderId`) → `enqueueOutbox` to `agentOutboxDir(agent.id)` → if `hasLiveWatchdog(agentDir)` (fresh `meta.transient.json` `watchdog_pid` within `TRANSIENT_FRESH_MS` + `isPidAliveCtx` alive) return immediately (watchdog drains), else `drainOutbox(...,{steal:true})` inline. The hasLiveWatchdog check still reads from the per-worktree `agentDir` (meta.transient.json hasn't moved); only the queue dir is central. `opts.outboxDir` overrides the queue dir (used for the system coordinator, whose queue/lock still live in `getCoordinatorHome()` directly — that path was NOT moved into the central `agents/` subdir).
- **`deliverMessage(agent, queued)`**: the single tmux writer — has-session, prefix format (`user.name` read, `BARE_RENDERED_SENTINELS`), chunked `send-keys -l`, length-scaled delay, `Enter`, recipient/sender logging, `writeAgentState("running")`. `drainOutbox` pops one at a time under the lock with a 250ms settle gap; removes a message only after its `Enter` succeeds (rewrite remainder) — no double-delivery, no loss.
- **Watchdog (watchdog.ts)**: `runPerAgentWatchdog` drains at the top of every tick AND on an `fs.watch` event (debounced 50ms, falls back to per-tick if `fs.watch` throws), coalesced so triggers don't pile up. Injectable via `setPerAgentDrain`/`resetPerAgentDrain`.
- **Coordinator/hook paths**: `sendToSystemCoordinator` passes `outboxDir: getCoordinatorHome()`; BOTH dashboard system-coordinator send paths route through it — the `s`-key dialog (`handleSendToCoordinator`) and the inline coordinator input field (`coordinatorInputField.onSubmit`). `hooks/agent-status.ts` routes self-nudge / `notify_manager` through `sendMessage` (`raw: true`).
- **Watchdog direct writes**: the watchdog's own bare Enters (rate-limit-bypass, permission auto-accept) bypass `deliverMessage` and the file lock, so they're serialized against the fs.watch-driven drain by a per-agent in-process async mutex `runSessionExclusive(agentId, fn)` (promise-chain keyed by id — `tick()` never cross-blocks agents). BOTH the drain and every bare Enter run inside it.

## State detection

Deterministic model. See SPEC.md §1.3.

1. Stop hook (`ib hook-status`) writes `state` to `meta.json` when Claude goes idle (`waiting`, `complete`, or `running`).
2. `ib send` and `ib resume` write `state: "running"` to `meta.json`.
3. `detectAgentStates()` reads state from meta.json with tmux overrides for compacting / rate_limited / api_error / stopped.
4. `MetaState` = `"creating" | "running" | "waiting" | "complete" | "stopped"` (stored). `AgentState` (parse-state.ts) is the broader union that adds `compacting`, `rate_limited`, `api_error`, and `unknown` for runtime overrides.
5. `creating` is also derived from `created_epoch` (< ~6s ago) when the meta state would otherwise be ambiguous.
6. `api_error` is an override surfaced via `isApiError(tmuxOutput)` and the `tmux_api_error` flag in `TransientState`.
7. `parseState()` is retained as legacy for the bash ib reference and the watchdog's rate limit bypass retry loop.
8. Codex agents reach the same `MetaState` via their hooks (SessionStart → running, Stop → waiting/complete). Override states currently surface as `unknown` for codex agents pending codex-specific detection (see SPEC-CODEX-MODEL.md Phase 5).

## TUI

- **SplitPane (`src/tui/split-pane.ts`)**: pi-tui's `Box` is vertical-only. `SplitPane` renders two child components side-by-side by calling each child's `render(width)` independently, then merging lines: left is padded to exact width, separator char inserted, right is truncated.
- **TmuxPoller (`src/tmux-poller.ts`)**: polls only the SELECTED target at ~1s via `setInterval`. The dashboard runs three: selected agent, system coordinator (`ib-coordinator`), and currently selected per-repo coordinator. `setAgent(session)` switches target. Race guard: snapshots `targetSession` before async `Bun.spawn`, discards result if target changed during await. `captureTmuxOutput()` is a separate one-shot export used by `detectAgentStates()` in the watcher.
- **Line wrapping (`src/tui/wrap.ts`)**: `wrapSingleLine(line, width)` and `wrapLines(text, width)` — ANSI-aware hard wrapping. Walks characters, skips ANSI escape sequences for width calculation. ANSI codes at wrap boundaries stay in the current chunk.
- **Pane widths**: single source of truth in `src/tui/widths.ts`. Spawn/resume code uses the async `getSaved*` helpers; dashboard render uses the sync `getLive*` wrappers (or `DashboardComponent.getMainWidth()`). Per-repo coordinators render at `mainWidth`, same as the system coordinator. **Never compute pane widths inline.** Formula: `mainWidth = terminalWidth - sidebarWidth - 1`.
- **Layout persistence**: panel sizes saved to `~/.itsybitsy/layout.json` via debounced write (500ms). Restored on startup with validation (rejects NaN/Infinity, clamps to valid ranges).
- **Dashboard (`src/tui/dashboard.ts`)**: three-column layout (resizable sidebar with agent tree + info panel | resizable tmux pane | cycling right pane). 5 focus targets in normal mode (`FOCUS_ORDER`): agent-tree, info, active-agent, right-pane, repo-coordinator. Tab/Shift+Tab cycles. `[`/`]` resize width (focus-aware), `{`/`}` resize sidebar panel height. Right pane modes: AGENT LOG, INITIAL PROMPT, DENIALS, TREE, ERRORS, DIFF, QUESTIONS, STATUS, REPO. Right pane mode is global state — persists across agent selection changes. `p`/`n` cycle pane modes (p=forward, n=backward). Agent actions: `x` kill, `!` nuke, `R` resume, `r` reassign, `m` merge, `s` send, `a` new-agent. `;`/`l` scroll both panes simultaneously. See SPEC.md §11–13.
- **Coordinator mode**: when coordinator is selected, sidebar shows only tree + info, main area shows coordinator tmux at full width. `n`/`p` toggles between TMUX view and DASHBOARD view (agent overview). Focus order: agent-tree → info → coordinator. See SPEC.md §12.
- **Dialog system**: 10 types — `confirm`, `input`, `select`, `fuzzy`, `help`, `textarea`, `folder-browser`, `new-agent-form`, `setup`, `permissions-editor`. Renders in status bar area, variable height. Separate from dialogs: status-bar timed notices via `showMessage()` (auto-dismiss after 3s, gated by `noticeCounter` to prevent stale timeouts).
- **`executeAndRefresh(fn)`**: wraps simple mutations (try/catch + watcher refresh). Multi-step flows (merge, diff-tool, snapshot) use `.then().catch()` instead because they need intermediate UI or skip refresh.
- **Snapshot (`S` key)**: routes through `handleSnapshot()` in `src/tui/agent-actions.ts`. Writes captured tmux output to `${agent.repoPath}/.ittybitty/${agent.archived ? "archive" : "agents"}/${agent.id}/debug-logs/snapshot-<timestamp>-<state>.txt`; if the user enters a note, writes `snapshot-<timestamp>-<state>-note.txt` next to it.

## Agent data (`src/agents.ts`)

- `readAllAgents()` returns `{ agents, errors, orphanedTmuxSessions, liveTmuxSessions }` — always check errors.
- `FlatEntry` discriminated union: kind: "agent" for agent rows, kind: "repo-header" for repo headers.
- `detectAgentStates()` — single source of truth for state detection.
- `writeAgentState()` atomically writes state to meta.json (used by stop hook, sendMessage, resumeAgent).
- `isCompacting()`, `isRateLimited()`, `hasBackgroundTasks()` — targeted tmux output checks (no full parseState).
- `buildAgentTree()` mutates `agent.children` in place; call it after state detection.
- `resolveAgentIcon(meta)` returns unicode icon (`agentIcon` → coordinator/worker/manager legacy → manager default). `resolveAgentIconChar(meta)` returns single character for text-only contexts.
- `readAgentLog()`, `readAgentPrompt()`, `parseDenials()` — async helpers for right pane content.
- `meta.spawned_by` records the spawner — `agent_id` is either a real agent ID, or one of two `@`-prefixed sentinels: `@system` (the system coordinator) or `@<repo-name>` (a per-repo coordinator). The watchdog routes notifications via these sentinels — `@system` is delivered via `sendToSystemCoordinator`, `@<repo-name>` resolves to that repo's coordinator at notify time so the sentinel survives coordinator restarts. The `notifyManager` / `notifySpawner` precedence in watchdog handlers is mutually exclusive: manager wins if set, else spawner, else nothing.

## Hooks (`src/hooks/`)

Native hook implementations run as Claude Code hook commands. Five fire inside spawned agent sessions; two fire in the primary Claude session that runs `ib watch`. Three additional codex-side hooks exist (see Codex section below).

Agent-session hooks:
- `hook-check-path <agentId>` → `agent-path.ts`: path isolation. Blocks agents from accessing other agents' worktrees or the main repo.
- `hook-status <agentId>` → `agent-status.ts`: stop hook. Detects stuck agents and sends nudge messages. Debounced via timestamp file.
- `hook-permission-denied <agentId>` → `permission-denied.ts`: logs permission denial events to agent.log.
- `hooks intercept-task` → `intercept-task.ts`: PreToolUse hook. Blocks disallowed models and unauthorized task spawning.
- `hooks session-start` → `session-start.ts`: SessionStart hook. Injects role-specific context. Loads type definition, interpolates template body with `{{variable}}` and `{{#if cond}}...{{/if}}` blocks; falls back to hardcoded instructions based on `instructionStyle`. Legacy agents without `agentType` use role detection from `worker`/`coordinator` booleans.

Codex hooks (all dispatched through `codex-dispatcher.ts`):
- `hooks codex-pre-tool-use <agentId>` → `codex-pre-tool-use.ts`: PreToolUse handler — allow/deny + path-isolation for Bash AND apply_patch. For apply_patch, parses the patch body (`*** Add File:` / `*** Update File:` / `*** Delete File:`) and synthesizes a `{toolName: "Write", toolInput: {file_path: <target>}}` call routed through `checkPathAccess` (prepending `"Write"` to the allow list for the synthesized call). Allow output MUST echo back `tool_input` as `updatedInput` (standalone allow fails open). Defaults to deny.
- `hooks codex-session-start <agentId>` → `codex-session-start.ts`: writes `state: "running"` to meta.json; captures `meta.codex_session_id` on first firing (defensive read of both `session_id` AND `sessionId`).
- `hooks codex-stop <agentId>` → `codex-stop.ts`: writes `state: "waiting"` or `"complete"` to meta.json — deterministic, no tmux scraping.
- `codex-dispatcher.ts` — fail-open-safe wrapper. NEVER throws; always exits 0 in production. Validates `<agentId>` before any other work; emits deny + `exit 0` on parse / module-import failure. `--dry-run` is the ONLY path that may exit non-zero (used by spawn-time precheck so callers can refuse cleanly).

Primary-Claude hooks:
- `hooks main-path` → `main-path.ts`: PreToolUse hook for the primary Claude session. Blocks the user's main Claude from `cd`-ing into agent worktrees (`.ittybitty/agents/*`).
- `hooks inject-status` → `inject-status.ts`: UserPromptSubmit hook. Injects a brief agents-status summary, gated by `hooks.injectStatus` config and rate-limited by hashing.

Hooks read input from stdin. Path-check, main-path, intercept-task, and session-start write JSON to stdout and use exit codes (0 allow, 1 deny). Agent-status writes a plain state string. Permission-denied only logs and exits 0. Inject-status returns an additionalContext JSON payload. Codex hooks always emit JSON to stdout and ALWAYS exit 0 in production (codex fails open — any non-zero exit is treated as a hook crash and the tool call proceeds); only `--dry-run` may exit non-zero.

## Agent types (`src/agent-types.ts`)

Agent types are `.md` files with YAML frontmatter in `~/.itsybitsy/agent-types/`. The `.md` file on disk is the primary source of truth — `loadAgentType()` reads only from disk and throws if a file is missing. Default types (manager, worker, coordinator) plus three layer files (`_all.md`, `_non_coordinator.md`, `system.md`) are embedded in the binary via text imports from `docs/agent-types/*.md` and auto-populated on first run via `ensureAgentTypesDir()`.

`AgentType` interface: `name`, `description`, `canSpawnChildren`, `spawnable`, `icon`, `model`, `permissions`, `allowedPaths`, `repos`, `instructionStyle`, `markdownBody`.

- `spawnable` defaults to `true` when absent; `false` marks layer-only files (`_all.md`, `_non_coordinator.md`, `system.md`) that cannot be spawned but whose frontmatter and body merge into spawned agents (`_all.md` into every agent, `_non_coordinator.md` into non-coordinators, `system.md` into the system coordinator).
- `repos` is an optional list constraining which repos a type may be spawned into.
- `allowedPaths` controls file access beyond the worktree: `undefined` = legacy permissive, `[]` = strict (worktree only), entries = allow listed directories. Paths expanded (`~` → homedir, `realpathSync` for symlinks) at agent creation time and stored in `meta.json`. The path hook reads them at runtime (SPEC.md §6.1).

Key exports: `loadAgentType(name)`, `agentTypeExists(name)`, `ensureAgentTypesDir()` (auto-populate on first run), `initAgentTypes()` (backs `ib init-types`), `listAgentTypes()`, `listSpawnableTypeNamesSync()` (TUI scan, filters `spawnable: false`), `validateAllAgentTypes()` (startup validation), `parseAgentTypeFile(content)` (YAML frontmatter parser with nested object and list support). When the directory is missing entirely, `listAgentTypeNamesSync()` falls back to the embedded list so the TUI can render type pickers before files are materialized.

See SPEC.md §2 for behavior.

## Codex CLI integration

Codex-side equivalents of the claude `start.sh` / `resume.sh` assembly. See SPEC.md §18 and SPEC-CODEX-MODEL.md.

**`src/codex-spawn.ts`** — codex-shaped shell scripts mirroring the claude skeleton (SIGHUP trap, `setsid`, `wait` + exit-check, PID capture) but launching the codex CLI.

- `buildCodexStartContent({agentId, ibBinaryPath, codexModel, ...})` — generates `start.sh`. Launches codex with `-m <model> -a never -s workspace-write --dangerously-bypass-hook-trust <inline -c hook flags> "<prompt>"`. PID capture goes through the `ib write-pid` subcommand (not inline `bun -e` — avoids a lost-update race with concurrent meta.json writers).
- `buildCodexResumeContent({agentId, ibBinaryPath, codexSessionId, ...})` — same skeleton, launches `codex resume "<UUID>"`. The agent-type allow/deny lists take effect on the next resume (codex has no live hot-reload).
- `appendCodexGitignoreEntry(worktreePath)` — appends `.codex/` to `.gitignore`. Idempotent; respects `!.codex/` negation.
- `buildCodexAgentsMd(ctx)` / `writeCodexAgentsMd(worktreePath, ctx)` — generates per-agent `<worktree>/AGENTS.md` from the same session-start.ts template that claude uses; strips the outer `<ittybitty>` wrapper. Codex reads `AGENTS.md` natively (replaces claude's session-start injection).
- `resolveIbBinaryPath()` — `Bun.which("ib") → process.execPath` fallback. Returns null on miss; caller fails the spawn.

**`src/codex-config.ts`** — inline `-c` flag builder + shared allow/deny machinery.

- `buildCodexLaunchArgs({ibBinaryPath, agentId, timeoutSecs?})` — returns inline `-c 'hooks.<Event>=[{...}]'` flags. One per `CODEX_REGISTERED_EVENTS` (PreToolUse, SessionStart, Stop). `--dangerously-bypass-hook-trust` is mandatory on every spawn (the hash of the inline payload changes per spawn).
- `isCodexSafeBinaryPath(path)` — rejects `'`, `"`, `\`, control chars. Defense against TOML-in-shell quoting bugs. Called both in `buildCodexLaunchArgs` AND in upstream `newAgent` / `resumeAgent` precheck.
- `loadMergedAgentTypePermissions(agentType)` — reads merged `_all.md` + `_non_coordinator.md` + `<type>.md` allow/deny lists. Same source as `buildAgentSettings` for claude.
- `buildCodexDenyOutput(reason)` / `buildCodexAllowOutput(originalToolInput)` — JSON contract emitters. Allow MUST pair `permissionDecision: "allow"` with `updatedInput` echoing original `tool_input` (standalone allow triggers a codex "unsupported permissionDecision" error and fails open).

## Telegram channel subsystem (`src/channels/`)

The Telegram bridge lives entirely here (NOT in the sibling bash `ittybitty`). Hand-rolled Bot API client — no grammy. Boot (`boot.ts`) runs at `ib watch` start: probe → resolve private chat id → construct `TelegramDispatcher` (inbound long-poll) + `TelegramOutbox` (outbound queue).

- **Inbound**: `dispatcher.ts` long-polls `getUpdates` with `allowed_updates: ["message", "message_reaction"]`, allowlist-filters, coalesces per-chat text into a `<channel source="telegram">` block, and delivers to the system coordinator via `sendToSystemCoordinator(..., {fromAgent: "@telegram"})`. `normalize()` → `NormalizedMessage` (now carries `messageId`). `wrapChannelReminder` surfaces `message_id` (single) / `last_message_id` (burst).
- **Reactions (inbound)**: `message_reaction` updates → `normalizeReaction()` (same allowlist, diffs `old_reaction`/`new_reaction`) → `wrapReactionReminder` → delivered as a distinct `kind="reaction"` event. Not coalesced with text; never enters the offline y/n flow (informational — dropped if coordinator offline).
- **Reactions (outbound)**: `ib tgreact <emoji> [--message-id <id>] [--clear]` → `telegramReact()` (ib-commands.ts) validates the emoji (`reactions.ts`, Telegram's documented set), drops a `<stem>.react.json` `{message_id, emoji}` descriptor into the outbox, polls ≤1s for the result. `TelegramOutbox.processReaction` → `client.setMessageReaction` (one 429-retry). Default target = the last-message cache.
- **Last-message cache** (`last-message-cache.ts`, modeled on `chat-id-cache.ts`): `deliver()` persists the newest inbound `{chat_id, message_id}` to `~/.itsybitsy/channels/telegram/last-message.json` so the separate `ib tgreact` process can react to "the latest message".
- **Outbox** (`outbox.ts`): file-drop queue under `~/.itsybitsy/channels/telegram/outbox/`. Queue unit is the full dropped filename (`<stem>.txt` text or `<stem>.react.json` reaction); result = `<base>.result`. Serialized send chain, fs.watch + 0.5s safety rescan, 5s result retention. `ib tgsend`/`ib tgreact` are the per-shell clients (telegramSend/telegramReact in ib-commands.ts).
- **Token safety**: the bot-token URL must never be logged. `classifyError()` (telegram-client.ts) exists for this; all new code reuses it.

## ib-commands (`src/ib-commands.ts`)

All mutations are native (no more `runIb()` / `IbRunner`). `hooksStatus`, `installSafetyHooks`, `uninstallSafetyHooks`, `installInterceptHook`, `uninstallInterceptHook`, `interceptHooksStatus` read/write `~/.claude/settings.json` directly.

Commands: `killAgent`, `nukeAgent`, `nukeAllAgents`, `pauseAgent`, `resumeAgent`, `reassignAgent`, `mergeCheckAgent`, `mergeAgent`, `sendMessage`, `newAgent`, `diffAgent`, `statusAgent`, `acknowledgeQuestion`.

- Git operations target the agent's repo via `git -C <repoPath>` rather than process-wide `cwd`. Tests inject fake spawn runners via per-command `SpawnContext` instances.
- `newAgent()` calls `ensureAgentTypesDir()` then validates `--type` exists on disk, rejects layer-only types (`spawnable: false`), and stores `agentType` + `agentIcon` in meta.json. Permission lookup: every agent merges `_all.md` `permissions.allow/deny`; non-coordinators additionally merge `_non_coordinator.md`; all merge their type file's own lists. Deduped before writing `settings.local.json`.
- `newAgent()` runs `checkSpawnerWorktreeClean(spawnerCwd)` right after prompt validation and before any side effects (SPEC §1.1 step 1a). Drains `git status --porcelain` directly (NOT via `SpawnContext.run`, which would `.trim()` and strip the porcelain XY column's leading space); both streams are drained concurrently via `Promise.all` to avoid pipe-buffer deadlock on large stderr. Skipped silently when `git rev-parse --is-inside-work-tree` doesn't return `true` (non-git cwd: system coordinator home, raw temp dir). The intercept-task hook forwards Claude's reported `input.cwd` as `_cwd` so the check inspects the spawning agent's worktree, not the hook process's own cwd.
- `newAgent()` branches on `parseModel(model).cli`. **Codex path**: skips `.claude/settings.local.json` entirely, writes the worktree `.gitignore` entry + per-agent `AGENTS.md`, runs the spawn-time dispatcher precheck (`ib hooks codex-pre-tool-use --dry-run <agentId>` + SessionStart + Stop), then generates a codex-shaped `start.sh`. **Claude path**: unchanged — byte-snapshot-guarded at `tests/fixtures/claude-start-sh-baseline.sh`. Coordinators cannot currently be spawned under codex (`--coordinator` + `codex:<model>` is rejected).
- `resumeAgent()` branches on `parseModel(meta.model).cli`. **Codex path**: validates `meta.codex_session_id` present, runs the same precheck, generates codex-shaped `resume.sh` invoking `codex resume "<UUID>"`. **Claude path**: byte-snapshot-guarded at `tests/fixtures/claude-resume-sh-baseline.sh`.
- `ib write-pid <agent-id> <pid>` (`src/index.ts`) routes through `mutateAgentMeta()` in `src/agents.ts` so concurrent meta.json writers can't clobber each other. Used by both claude AND codex `start.sh` + `resume.sh`.

## Agent lifecycle (`src/agent-lifecycle.ts`)

Shared helpers used by multiple ib commands. Mirrors the bash ib teardown / archive / kill / utility functions. All subprocess calls go through `spawnCtx` (a `SpawnContext` from `types.ts`); tests inject a fake runner with `spawnCtx.set(fn)` and reset it with `spawnCtx.reset()`.

## parse-state.ts priority order (legacy)

`parseState()` is deprecated. Retained for backward compatibility with bash ib and the watchdog rate-limit-bypass retry loop. Priority order:

Creating (workspace trust prompt, full input) > Compacting (last 5) > Active running (last 5) > Tool waiting (last 15) > Rate limited (last 15) > Complete (last 15) > WAITING (last 15) > Other running (last 15) > Spinners (last 15) > Permission prompts (last 15) > Broader spinners (last 20) > Background tasks (last 15) > Race condition hook > Unknown.

## Auto-compact (`src/auto-compact.ts`)

Reads Claude transcript JSONL files to determine an agent's context window usage. Matches ib's `get_agent_context_usage()` for transcript parsing. Encodes worktree paths into Claude's project directory naming scheme to locate the correct transcript file.

The actual `/compact` send is **hard-disabled** via the `AUTO_COMPACT_DISABLED = true` kill switch — `sendCompact` short-circuits and logs what it would have sent. Re-enabling requires flipping the constant in source.

## Config (`src/config.ts`)

User-wide configuration; reads from `~/.itsybitsy/config.json`, merges with typed defaults. No per-repo config.

Config keys: `maxAgents`, `model`, `createPullRequests`, `allowAgentQuestions`, `autoCompactThreshold`, `externalDiffTool`, `hooks.injectStatus`, `hooks.statusVisible`, `coordinator.imessage`, `channels.telegram.bot_token`. (Coordinator model lives in `~/.itsybitsy/agent-types/coordinator.md` frontmatter; the former `coordinator.model` config key has been removed.)

Permission lists have migrated out of `config.json` into agent-type layer files (`~/.itsybitsy/agent-types/_all.md`, `_non_coordinator.md`, `<type>.md`) — see SPEC.md §2.3. Deprecated keys (`permissions.*`) trigger a warning at `ib watch` startup pointing to the correct `.md` replacement.

## Validation (`src/validation.ts`)

Input validation helpers that enforce strict character allowlists to prevent shell injection in script templates. Exports:

- `isValidModel()` — alphanumeric, dots, hyphens, underscores
- `isValidToolList()` — alphanumeric, underscores, hyphens, asterisks, parens, colons, dots, spaces, commas
- `isValidAgentId()`, `isValidTmuxSession()` — alphanumeric, hyphens, underscores
- `isValidSessionId()` — hex digits and hyphens

Used wherever user-supplied values are interpolated into shell commands.

## Folder browser (`src/tui/folder-browser.ts`)

Builds the navigable item list for the add-repo folder browser dialog. Given a current path, produces a list of `FolderItem` entries: ancestors from root down to parent, the current folder, and sorted child directories. Each item includes depth, git-repo detection, and ancestor/current flags for rendering the tree-style UI.

## Ghostty (`src/ghostty.ts`)

- `openInGhostty(tmuxSession)` spawns Ghostty with `--command=bash -c 'tmux set-option -t <session> window-size latest && tmux attach -t <session>'`, detached via `proc.unref()`. The `window-size latest` prefix makes tmux re-fit to Ghostty's dimensions on attach; the `bash -c` wrapper prevents Ghostty's login shell flags from being passed to tmux. `+new-window` (reuse existing instance) is GTK-only and not available on macOS, so each call spawns a new Ghostty app.
- `openPathInGhostty(dirPath)` is the directory-opening counterpart — launches a Ghostty window cd'd into `dirPath` (no tmux attach).
- Validates session name with `/^[\w-]+$/` before interpolating into `--command`.
- Both functions return `{ ok, message }`.

## Debugging — `ib state`

`ib state` (or `ib state --json`) lists every agent with its tmux pane PID, claude PID, and watchdog PID, plus liveness for each (✓ alive, ✗ dead, — missing). When pane_pid has child processes that aren't the recorded claude_pid, they show as `[orphans: N]`. Implementation: `src/state-command.ts`.

`ib state` always renders an `ORPHANS` section. Four categories:

- **tmux sessions** — sessions matching `ib-coordinator` (exact) or `ittybitty-<repoId>-<agentId>` that aren't in any registered repo's tracked set.
- **claude processes** — running `claude --resume <id>` / `claude --session-id <uuid>` whose **cwd is inside an itsybitsy worktree** and whose PID isn't recorded in any tracked agent's `meta.json` `claude_pid`. cwd anchor is critical — a user running `claude --resume <id>` in their own terminal must NEVER be flagged. cwd lookup uses `lsof -d cwd` on macOS and `/proc/<pid>/cwd` on Linux.
- **watchdog processes** — running `ib watchdog <agent-id>` whose PID isn't in any agent's `watchdog_pid`.
- **ib watch processes** — every running `ib watch` (informational; no tracked set).

The tracked set is built from ALL agents in ALL registered repos plus the system coordinator's session.

`ib state --cleanup` kills every orphan: `tmux kill-session` for sessions, SIGTERM then SIGKILL for processes. Safety:
- Tracked set is rebuilt **immediately before** cleanup; any orphan that became tracked between gather and cleanup is skipped.
- Before SIGKILL, each PID's command line is re-resolved via `ps -o command=`; if it no longer matches an itsybitsy pattern, SIGKILL is refused (PID-reuse guard).
- Tmux session names are validated with `isValidTmuxSession` before being passed to `tmux kill-session`.

`ib state --cleanup --dry-run` previews what would be killed. In `--json` mode, `cleanup_actions` is added only when `--cleanup` was passed.

**Known limitation**: if you run both bash `ib` and bun `itsybitsy` without a shared `~/.itsybitsy/repos.json`, `--cleanup` from one install will see the other's watchdogs as orphans.

---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Building a Binary

To compile itsybitsy into a standalone executable:

```sh
bun build --compile --minify --sourcemap index.ts --outfile ib
```

This produces a single `ib` binary with no runtime dependencies. To add it to your PATH:

```sh
# Option 1: Add the project directory to your PATH (in ~/.bash_profile or ~/.zshrc)
export PATH=$PATH:/path/to/itsybitsy

# Option 2: Install system-wide
sudo cp ib /usr/local/bin/ib
```

The binary can then be used as `ib` instead of `bun index.ts`. Hook commands like `ib hooks main-path` reference the binary by its installed name.

## Behavioral Specification

**SPEC.md** is the definitive behavioral specification for itsybitsy. Read it before implementing or modifying any agent lifecycle, hook, or orchestration behavior. It documents intentional divergences from the bash reference implementation and unresolved design decisions.

**SPEC-CODEX-MODEL.md** is the design source-of-truth for codex CLI support (`<cli>:<model>` model selector, codex hook architecture, codex spawn/resume paths). Project SPEC.md §18 carries a summary; SPEC-CODEX-MODEL.md has the full evidence trail (Phase 2 spike findings, reviewer feedback, per-phase commit history).

## Code Quality Requirements

After any code changes, always run:
1. `bun test` — all tests must pass
2. `bunx tsc --noEmit` — must report zero TypeScript errors; fix any new errors before committing

## Cross-Cutting Review Checklist

Every new feature or fix must be evaluated from these four perspectives before it is considered complete. A change that looks local may have implications in any of the four — explicitly confirm each, even if only to note "not affected":

1. **General agent functionality** — does the change affect what an agent can do, how it is spawned, how its meta.json is shaped, or how its lifecycle proceeds?
2. **Hooks** — does the change affect any of the agent-session hooks (agent-path, agent-status, permission-denied, intercept-task, session-start) or the primary-Claude hooks (main-path, inject-status)? New paths, new tool categories, and new agent metadata usually require hook updates.
3. **Watchdog** — does the change affect agent state detection, nudge timing, rate-limit recovery, or any background monitoring behavior?
4. **`ib watch` / dashboard** — does the change affect what the TUI displays, which modes are needed, focus/input handling, or layout?

## itsybitsy Implementation Notes

3085 tests across 67 files.

### Per-agent message-delivery queue (src/outbox.ts)
Serializes tmux writes to a single agent so two near-simultaneous sends never interleave their `send-keys -l` chunks + `Enter` into one merged prompt. See SPEC.md §4.1.1 and §8.5.
- **Queue**: `outbox.jsonl` beside `meta.json`. `OutboxMessage = {id, message, fromAgent, raw, enqueuedAtMs}`. `enqueueOutbox` (mkdir's the dir then single-line `appendFile` — no message loss), `readOutbox` (FIFO, skips malformed lines), `rewriteOutboxRemoving(dir, deliveredIds)` (tmp+rename remainder, re-reads to preserve mid-drain appends, unlinks when empty), `deleteAgentOutbox` (removes queue + lock at teardown).
- **Lock**: `.outbox.lock`, advisory via `open(path, "wx")` (O_CREAT|O_EXCL). `acquireOutboxLock` retries with backoff to ~5 s, writes a `<pid>:<uuid>` body (the uuid is an ownership token); `steal` removes a stale lock (mtime > 30 s) — set by the inline fallback, never the drain. `releaseOutboxLock`/steal only `unlink` when the on-disk token matches (`unlinkIfToken`), so a stolen-from holder never deletes the thief's lock. Always `releaseOutboxLock` in `finally`. Keyed per-agent (== per tmux session) — **no central dispatcher**.
- **`sendMessage` (ib-commands.ts)**: resolve sender (cwd-detect at ENQUEUE time via `resolveSenderId`) → `enqueueOutbox` → if `hasLiveWatchdog(agentDir)` (fresh `meta.transient.json` `watchdog_pid` within `TRANSIENT_FRESH_MS` + `isPidAliveCtx` alive) return immediately (watchdog drains), else `drainOutbox(...,{steal:true})` inline. Signature/return shape and `sendSpawnCtx`/`sendDelayOverrideMs` hooks unchanged; with no transient file the inline drain produces identical observable spawn calls. `opts.outboxDir` overrides the queue dir (used for the system coordinator, whose queue/lock live in `getCoordinatorHome()`).
- **`deliverMessage(agent, queued)`**: the single tmux writer — has-session, prefix format (`user.name` read, `BARE_RENDERED_SENTINELS`), chunked `send-keys -l`, length-scaled delay, `Enter`, recipient/sender logging, `writeAgentState("running")`. `drainOutbox` pops one at a time under the lock with a 250 ms settle gap; removes a message only after its `Enter` succeeds (rewrite remainder) — no double-delivery, no loss.
- **Watchdog (watchdog.ts)**: `runPerAgentWatchdog` drains at the top of every tick AND on an `fs.watch` event (debounced 50 ms, falls back to per-tick if `fs.watch` throws), coalesced so triggers don't pile up. Injectable via `setPerAgentDrain`/`resetPerAgentDrain`.
- **Coordinator/hook paths**: `sendToSystemCoordinator` passes `outboxDir: getCoordinatorHome()`; BOTH dashboard system-coordinator send paths route through it — the `s`-key dialog (`handleSendToCoordinator`) and the inline coordinator input field (`coordinatorInputField.onSubmit`). `hooks/agent-status.ts` routes self-nudge / `notify_manager` through `sendMessage` (`raw: true`).
- **Watchdog direct writes**: the watchdog's own bare Enters (rate-limit-bypass, permission auto-accept) bypass `deliverMessage` and the file lock, so they're serialized against the fs.watch-driven drain by a per-agent in-process async mutex `runSessionExclusive(agentId, fn)` (promise-chain keyed by id — `tick()` never cross-blocks agents). BOTH the drain and every bare Enter run inside it, so they can't overlap in either direction (a drain in flight blocks a direct write and vice-versa).

### State detection flow
**Deterministic model (Phase 42 — implemented):**
1. Stop hook (`ib hook-status`) writes `state` to `meta.json` when Claude goes idle (`waiting`, `complete`, or `running`)
2. `ib send` and `ib resume` write `state: "running"` to `meta.json`
3. `detectAgentStates()` reads state from meta.json with tmux overrides for compacting/rate_limited/api_error/stopped
4. `MetaState` = `"creating" | "running" | "waiting" | "complete" | "stopped"` (stored). `AgentState` (parse-state.ts) is the broader union that adds `compacting`, `rate_limited`, `api_error`, and `unknown` for runtime overrides
5. `creating` is written by spawn code for in-progress spawns and is also derived from `created_epoch` (< ~6s ago) when the meta state would otherwise be ambiguous
6. `api_error` is an override surfaced via `isApiError(tmuxOutput)` and the `tmux_api_error` flag in `TransientState`
7. `parseState()` is retained as legacy for the bash ib reference and the watchdog's rate limit bypass retry loop
8. Codex agents reach the same `MetaState` via their Phase 3 hooks (SessionStart → running, Stop → waiting/complete). The override states (compacting, rate_limited, api_error) currently surface as `unknown` for codex agents — Phase 5 of SPEC-CODEX-MODEL.md adds codex-specific override detection, deferred until live codex UI strings are captured.

### SplitPane (src/tui/split-pane.ts)
pi-tui's `Box` is vertical-only. `SplitPane` renders two child components side-by-side by calling each child's `render(width)` independently, then merging lines: left is padded to exact width, separator char inserted, right is truncated. Left width is configurable.

### TmuxPoller (src/tmux-poller.ts)
- Polls only the SELECTED target at ~1s via `setInterval`
- The dashboard runs three `TmuxPoller` instances: one for the selected agent, one for the system coordinator (`ib-coordinator`), and one for the currently selected per-repo coordinator
- `setAgent(session)` switches target; triggers immediate poll
- Race condition guard: snapshots `targetSession` before async `Bun.spawn`, discards result if target changed during await
- `captureTmuxOutput()` is a separate one-shot export used by `detectAgentStates()` in the watcher

### Agent data (src/agents.ts)
- `readAllAgents()` returns `{ agents, errors, orphanedTmuxSessions, liveTmuxSessions }` — always check errors
- `FlatEntry` discriminated union type lives here (not in watcher.ts) since `flattenAgentTree()` produces it — kind: "agent" for agent rows, kind: "repo-header" for repo headers
- `detectAgentStates()` is the single source of truth for state detection — reads `state` from meta.json with tmux overrides for compacting/rate_limited/api_error/stopped
- `writeAgentState()` atomically writes state to meta.json (used by stop hook, sendMessage, resumeAgent)
- `isCompacting()`, `isRateLimited()`, `hasBackgroundTasks()` — targeted tmux output checks (no full parseState)
- `buildAgentTree()` mutates `agent.children` in place; call it after state detection
- `resolveAgentIcon(meta)` — returns unicode icon for agent based on `agentIcon` → coordinator/worker/manager legacy → manager default
- `resolveAgentIconChar(meta)` — returns single character icon for text-only contexts (e.g., status injection)
- `readAgentMeta()` validates `agentIcon` field type (must be string or deleted)
- `readAgentLog()`, `readAgentPrompt()`, `parseDenials()` — async helpers for right pane content
- `meta.spawned_by` (type `SpawnedBy`) records the spawner — `agent_id` is either a real agent ID, or one of two `@`-prefixed sentinels: `@system` (the system coordinator, with `repo_path: null`) or `@<repo-name>` (a per-repo coordinator, with `repo_path` set). The watchdog routes notifications via these sentinels — `@system` is delivered via `sendToSystemCoordinator` (direct tmux send-keys to the `ib-coordinator` session, the same path `ib send @system` uses), `@<repo-name>` resolves to that repo's coordinator at notify time so the sentinel survives coordinator restarts. The `notifyManager` / `notifySpawner` precedence in watchdog handlers is mutually exclusive: manager wins if set, else spawner, else nothing.

### parse-state.ts priority order (legacy)
`parseState()` is deprecated — no longer used for primary state detection. Retained for backward compatibility with bash ib and the watchdog rate limit bypass. Priority order:
Creating (workspace trust prompt, full input) > Compacting (last 5) > Active running (last 5) > Tool waiting (last 15) > Rate limited (last 15) > Complete (last 15) > WAITING (last 15) > Other running (last 15) > Spinners (last 15) > Permission prompts (last 15) > Broader spinners (last 20) > Background tasks (last 15) > Race condition hook > Unknown

### Line wrapping (src/tui/wrap.ts)
- `wrapSingleLine(line, width)` and `wrapLines(text, width)` — ANSI-aware hard wrapping
- Walks characters, skips ANSI escape sequences for width calculation
- ANSI codes at wrap boundaries stay in the current chunk (no state carryover to next line)

### Dashboard (src/tui/dashboard.ts)
- **Layout (Phase 45 — complete):** Three-column layout: resizable sidebar (default 60 cols, range 30–120) with agent tree + info panel | resizable tmux pane | cycling right pane. See SPEC.md §11–13 for full specification.
- **Focus system (Phase 46 — partially complete):** 5 focus targets in normal mode (`FOCUS_ORDER`): agent-tree, info, active-agent, right-pane, repo-coordinator. The repo-coordinator target is in `skipTargets` by default and only participates in cycling when the right pane is in REPO mode. In coordinator mode: agent-tree, info, coordinator. Tab/Shift+Tab cycles focus. Focused panel headers render in reverse video + bold; unfocused render dim. `[`/`]` resize width (focus-aware), `{`/`}` resize sidebar panel height (steals from neighbor). Input fields not yet implemented (deferred to Phase 49).
- **Layout persistence:** Panel sizes (sidebar width, split-pane left width, height offsets) saved to `~/.itsybitsy/layout.json` via debounced write (500ms). Restored on startup with validation (rejects NaN/Infinity, clamps to valid ranges). `heightOffsets.coordinator` is kept in the schema for backward compatibility with existing layout files but is no longer used for rendering.
- **Pane widths — single source of truth:** All pane width math lives in `src/tui/widths.ts`. Spawn/resume code: use the async `getSaved*` helpers. Dashboard render: use the sync `getLive*` wrappers (or `DashboardComponent.getMainWidth()`). Per-repo coordinators render at `mainWidth`, same as the system coordinator. **Never compute pane widths inline.** Formula: `mainWidth = terminalWidth - sidebarWidth - 1`; the rest derive from it.
- **Coordinator System (Phases 47–49 — largely implemented):** Two-tier system: system coordinator (`ib-coordinator` tmux session, `~/.itsybitsy/`, Bash(ib:*) only) + per-repo coordinators (special agents with `coordinator: true` in meta.json, Read/Glob/Grep/LS + ib:*, no Write/Edit, unqualified Bash denied). When coordinator is selected: sidebar shows only tree + info, main area shows coordinator tmux at full width (`mainWidth`). `n`/`p` toggles between TMUX view (coordinator output with input field) and DASHBOARD view (agent overview table). Focus order in coordinator mode: agent-tree → info → coordinator. Per-repo coordinators are first entry under their repo in agent tree. System coordinator spawns agents in repos via `ib new-agent --repo <name> "task"`. Coordinator tmux is created/resized at `mainWidth` and tracks terminal resize via `process.stdout.on('resize')`. See SPEC.md §12.
- Agent tree: max 7 visible rows with scroll indicators; compact format in sidebar (icon + id + state + age)
- Info panel: stoplight indicators (● Claude, ● Watchdog — PID liveness via `process.kill(pid, 0)`), model, summary/prompt
- Right pane modes: AGENT LOG, INITIAL PROMPT, DENIALS, TREE, ERRORS, DIFF, QUESTIONS, STATUS, REPO (9 modes)
- Right pane mode is global state — persists across agent selection changes
- `a` opens new-agent dialog (infers repo from selected agent/header, fallback to first repo)
- Agent actions: `x` kill, `!` nuke, `R` resume, `r` reassign, `m` merge, `s` send, `a` new-agent
- `p`/`n` cycle pane modes (p=forward, n=backward); arrow keys mapped counterintuitively to match ib watch
- TmuxPaneComponent: wraps lines via `wrapLines()`, scroll-back from bottom (`scrollBack` = lines from end, 0 = auto-follow)
- `hasPolled` flag distinguishes "waiting for first poll" from "session not found" — enables graceful stopped/orphaned display
- `displayHeight` computed from `process.stdout.rows` minus header/tree/separators/status, set before each render
- Both panes pad to `displayHeight` for consistent vertical alignment
- `readAgentLog()` is async — loaded on agent selection change, stale-checked by agent ID
- `;`/`l` scroll both tmux (left) and right pane simultaneously
- Dialog system: confirm, input, select, fuzzy, help, textarea, folder-browser, new-agent-form, setup, permissions-editor — renders in status bar area, variable height. Status-bar notices (`showMessage()`) are separate from dialogs.
- `executeAndRefresh()` wraps all mutations: runs the action, catches errors, then triggers watcher refresh

### Hooks (src/hooks/)
Native hook implementations run as Claude Code hook commands. Five fire inside spawned agent sessions; two fire in the primary Claude session that runs `ib watch`. Three additional codex-side hooks also exist — see Codex hook handlers (src/hooks/codex-*.ts) below.

Agent-session hooks:
- `hook-check-path <agentId>` maps to `agent-path.ts`: Path isolation — blocks agents from accessing other agents' worktrees or the main repo. Reads JSON from stdin, outputs allow/deny decision JSON.
- `hook-status <agentId>` maps to `agent-status.ts`: Stop hook — detects stuck agents and sends nudge messages. Debounced via timestamp file.
- `hook-permission-denied <agentId>` maps to `permission-denied.ts`: Logs permission denial events to agent.log.
- `hooks intercept-task` maps to `intercept-task.ts`: PreToolUse hook — blocks disallowed models and unauthorized task spawning.
- `hooks session-start` maps to `session-start.ts`: SessionStart hook — injects role-specific context at session start. Supports agent types: loads type definition, interpolates template body with `{{variable}}` and `{{#if cond}}...{{/if}}` blocks, falls back to hardcoded instructions based on `instructionStyle`. Legacy agents without `agentType` use role detection from `worker`/`coordinator` booleans.
- `hooks codex-pre-tool-use <agentId>` maps to `codex-dispatcher.ts` → `codex-pre-tool-use.ts`: Codex PreToolUse handler — allow/deny + path-isolation for Bash AND apply_patch.
- `hooks codex-session-start <agentId>` maps to `codex-dispatcher.ts` → `codex-session-start.ts`: Codex SessionStart handler — writes `state: "running"` to meta.json + captures `codex_session_id`.
- `hooks codex-stop <agentId>` maps to `codex-dispatcher.ts` → `codex-stop.ts`: Codex Stop handler — writes `state: "waiting"` / `"complete"` to meta.json.

Each codex hook subcommand supports `--dry-run` for the spawn-time dispatcher precheck (used by `newAgent()` and `resumeAgent()` to fail spawns cleanly if the dispatcher doesn't resolve).

Primary-Claude hooks:
- `hooks main-path` maps to `main-path.ts`: PreToolUse hook for the primary Claude session — blocks the user's main Claude from `cd`-ing or otherwise operating inside agent worktrees (`.ittybitty/agents/*`).
- `hooks inject-status` maps to `inject-status.ts`: UserPromptSubmit hook — injects a brief agents-status summary into the primary Claude's context, gated by `hooks.injectStatus` config and rate-limited by hashing.

Hooks read input from stdin. Path-check, main-path, intercept-task, and session-start write JSON to stdout and use exit codes (0 allow, 1 deny). Agent-status writes a plain state string to stdout. Permission-denied only logs to agent.log and exits 0. Inject-status returns an additionalContext JSON payload. Codex hooks always emit JSON to stdout and ALWAYS exit 0 in production (codex's failure mode is fail-open — any non-zero exit is treated as a hook crash and the tool call proceeds); only `--dry-run` may exit non-zero.

### Codex hook handlers (src/hooks/codex-*.ts)
Three codex-side hook handlers dispatched through a fail-open-safe wrapper. Architecture mirrors the claude-side hooks but with strict fail-open mitigation because codex's documented failure mode (crash, malformed JSON, unsupported `permissionDecision`) results in the tool call PROCEEDING.

- `codex-pre-tool-use.ts` — PreToolUse handler. Allow/deny + path-isolation for BOTH `Bash` AND `apply_patch`. For apply_patch, parses the patch body (`*** Add File:` / `*** Update File:` / `*** Delete File:` directives) and synthesizes a `{toolName: "Write", toolInput: {file_path: <target>}}` call routed through `checkPathAccess` (prepending `"Write"` to the allow list for the synthesized call). Allow output MUST echo back `tool_input` as `updatedInput` (standalone allow fails open). Defaults to deny.
- `codex-session-start.ts` — SessionStart handler. Writes `state: "running"` to meta.json via `writeAgentState()`; captures `meta.codex_session_id` on first firing (defensive read of both `session_id` AND `sessionId` to survive a future snake_case → camelCase rename).
- `codex-stop.ts` — Stop handler. Writes `state: "waiting"` or `"complete"` to meta.json — deterministic state, no tmux scraping.
- `codex-dispatcher.ts` — fail-open-safe wrapper around all three handlers. NEVER throws; always exits 0 in production path. Wraps handler logic in try/catch + emits a deny payload on uncaught exception; validates `<agentId>` argv before any other work; emits deny + `exit 0` on parse failure or module-import failure. The `--dry-run` flag (used by spawn-time precheck) is the only path that may exit non-zero, so spawn callers can refuse cleanly when the dispatcher can't resolve.

### Agent types (src/agent-types.ts)
Configurable agent type system. Agent types are `.md` files with YAML frontmatter in `~/.itsybitsy/agent-types/`. The `.md` file on disk is the primary source of truth — `loadAgentType()` reads only from disk and throws if a file is missing. Default types (manager, worker, coordinator) plus three layer files (`_all.md`, `_non_coordinator.md`, `system.md`) are embedded in the binary via text imports from `docs/agent-types/*.md` and auto-populated to disk on first run via `ensureAgentTypesDir()`. When the directory is missing entirely, `listAgentTypeNamesSync()` falls back to the embedded list so the TUI can render type pickers before files are materialised. `AgentType` interface: `name`, `description`, `canSpawnChildren`, `spawnable`, `icon`, `model`, `permissions`, `allowedPaths`, `repos`, `instructionStyle`, `markdownBody`. `spawnable` defaults to `true` when absent; `false` marks layer-only files (`_all.md`, `_non_coordinator.md`, `system.md`) that cannot be spawned via `ib new-agent --type <name>` but whose frontmatter and body merge into spawned agents (`_all.md` into every agent, `_non_coordinator.md` into non-coordinators, `system.md` into the system coordinator). `repos` is an optional string list constraining which repos a type may be spawned into. Key exports: `loadAgentType(name)` (disk-only, throws if not found), `agentTypeExists(name)` (disk-only), `ensureAgentTypesDir()` (auto-populate on first run, no-op if directory exists), `initAgentTypes()` (restore missing embedded files without overwriting existing ones — backs `ib init-types`), `listAgentTypes()`, `listSpawnableTypeNamesSync()` (lightweight sync scan used by TUI — filters out `spawnable: false`), `validateAllAgentTypes()` (startup validation), `parseAgentTypeFile(content)` (YAML frontmatter parser with nested object and list support). Icon is first non-whitespace character of the `icon` field. `allowedPaths` controls file access beyond the worktree: `undefined` = legacy permissive (allow all), `[]` = strict (worktree only), entries = allow listed directories. Paths are expanded (`~` → homedir, `realpathSync` for symlinks) at agent creation time and stored in `meta.json`. The hook-check-path reads them at runtime (see §6.1 in SPEC.md).

### Codex spawn/resume helpers (src/codex-spawn.ts)
Codex-side equivalents of the claude `start.sh` / `resume.sh` assembly. Generates codex-shaped shell scripts mirroring the claude skeleton (SIGHUP trap, `setsid`, `wait` + exit-check, PID capture) but launching the codex CLI instead.
- `buildCodexStartContent({agentId, ibBinaryPath, codexModel, ...})` — generates codex `start.sh` body. Launches codex with `-m <model> -a never -s workspace-write --dangerously-bypass-hook-trust <inline -c hook flags> "<prompt>"`. PID capture goes through the `ib write-pid` subcommand (not an inline `bun -e` snippet — avoids a lost-update race with concurrent meta.json writers).
- `buildCodexResumeContent({agentId, ibBinaryPath, codexSessionId, ...})` — generates codex `resume.sh` body. Same skeleton; launches `codex resume "<UUID>"` with re-passed inline `-c` hook flags + sandbox/approval/trust flags. The agent-type allow/deny lists take effect on the next resume (codex has no live hot-reload).
- `appendCodexGitignoreEntry(worktreePath)` — appends `.codex/` to the worktree's `.gitignore`. Idempotent; respects `!.codex/` negation.
- `buildCodexAgentsMd(ctx)` / `writeCodexAgentsMd(worktreePath, ctx)` — generates per-agent `<worktree>/AGENTS.md` from the same session-start.ts template that claude uses; strips the outer `<ittybitty>` wrapper. Codex reads `AGENTS.md` natively (replaces claude's session-start injection).
- `resolveIbBinaryPath()` — `Bun.which("ib") → process.execPath` fallback chain. Returns null on miss; caller fails the spawn. Eliminates PATH dependency in codex's spawn environment.
- `stripIttybittyWrapper(body)` — drops the outer `<ittybitty>...</ittybitty>` wrapper from the session-start prompt before writing to `AGENTS.md`.

### Codex launch line builder (src/codex-config.ts)
Builds the inline `-c` flag array for the codex CLI launch line and shares allow/deny machinery with the claude side.
- `buildCodexLaunchArgs({ibBinaryPath, agentId, timeoutSecs?})` — returns an array of inline `-c 'hooks.<Event>=[{...}]'` flags for the codex CLI. One flag per `CODEX_REGISTERED_EVENTS` (PreToolUse, SessionStart, Stop). Each payload interpolates the absolute `ib` binary path + agent id. `--dangerously-bypass-hook-trust` is mandatory on every spawn (the hash of the inline payload changes per spawn because `<agentId>` interpolates into it).
- `isCodexSafeBinaryPath(path)` — rejects paths containing `'`, `"`, `\`, or control characters. Defense against TOML-in-shell quoting bugs. Belt-and-suspenders: called both in `buildCodexLaunchArgs` AND in upstream `newAgent` / `resumeAgent` precheck.
- `renderCodexHookFlagPayload(event, ibPath, agentId, timeoutSecs)` — single-flag renderer used internally by `buildCodexLaunchArgs`.
- `loadMergedAgentTypePermissions(agentType)` — reads merged `_all.md` + `_non_coordinator.md` + `<type>.md` allow/deny lists. Same source as `buildAgentSettings` for claude — codex reuses the SAME permission lists, just translates them into a generated hook handler instead of a `permissions.allow/deny` array.
- `buildCodexDenyOutput(reason)` / `buildCodexAllowOutput(originalToolInput)` — JSON contract emitters for the PreToolUse handler. Allow MUST pair `permissionDecision: "allow"` with `updatedInput` echoing the original `tool_input` (standalone allow triggers a codex "unsupported permissionDecision" error and fails open).

### Agent lifecycle (src/agent-lifecycle.ts)
Shared agent lifecycle helpers used by multiple ib commands. Mirrors the ib bash script's teardown, archive, kill, and utility functions. All subprocess calls go through `spawnCtx` (a `SpawnContext` from `types.ts`); tests inject a fake runner with `spawnCtx.set(fn)` and reset it with `spawnCtx.reset()`. Handles formatting timestamps, archiving agent directories, and cleaning up tmux sessions and git worktrees.

### Auto-compact (src/auto-compact.ts)
Reads Claude transcript JSONL files to determine an agent's context window usage percentage. Matches ib's `get_agent_context_usage()` logic for transcript parsing. Encodes worktree paths into Claude's project directory naming scheme to locate the correct transcript file. The actual `/compact` send is **hard-disabled** via the `AUTO_COMPACT_DISABLED = true` kill switch — `sendCompact` short-circuits and logs what it would have sent rather than sending. Re-enabling requires flipping the constant in source.

### Config (src/config.ts)
User-wide configuration system with user and default sources. Config keys: `maxAgents`, `model`, `createPullRequests`, `allowAgentQuestions`, `autoCompactThreshold`, `externalDiffTool`, `hooks.injectStatus`, `hooks.statusVisible`, `coordinator.model`, `coordinator.imessage`, and `channels.telegram.bot_token`. Permission list keys have been migrated out of `config.json` into agent-type layer files (`~/.itsybitsy/agent-types/_all.md`, `_non_coordinator.md`, `<type>.md`) — see SPEC.md §2.3. Deprecated keys (`permissions.all.*`, `permissions.repo.*`, `permissions.manager.*`, `permissions.worker.*`, `permissions.coordinator.*`) trigger a warning at `ib watch` startup pointing to the correct `.md` replacement file. Reads from `~/.itsybitsy/config.json` (user home), merging with typed defaults. No per-repo configuration.

### Folder browser (src/tui/folder-browser.ts)
Builds the navigable item list for the add-repo folder browser dialog. Given a current path, produces a list of `FolderItem` entries: ancestors from root down to parent, the current folder, and sorted child directories. Each item includes depth, git-repo detection, and ancestor/current flags for rendering the tree-style UI.

### ib-commands (src/ib-commands.ts)
- Mutations are implemented natively. `runIb()` and `IbRunner` have been deleted. `hooksStatus`, `installSafetyHooks`, `uninstallSafetyHooks`, `installInterceptHook`, `uninstallInterceptHook`, `interceptHooksStatus` are natively implemented — they read/write `~/.claude/settings.json` (global).
- Git operations target the agent's repo via `git -C <repoPath>` rather than process-wide `cwd`. Tests inject fake spawn runners via per-command `SpawnContext` instances (e.g., `setKillPauseSpawnRunner`, `resetNukeResumeSpawnRunner`).
- Commands: killAgent, nukeAgent, nukeAllAgents, pauseAgent, resumeAgent, reassignAgent, mergeCheckAgent, mergeAgent, sendMessage, newAgent, diffAgent, statusAgent, acknowledgeQuestion
- `newAgent()` calls `ensureAgentTypesDir()` then validates `--type` exists on disk (via `agentTypeExists()`), rejects layer-only types (`_all`, `_non_coordinator`) that have `spawnable: false` in frontmatter, and stores `agentType` and `agentIcon` in meta.json. Permission lookup: every agent merges `_all.md` frontmatter `permissions.allow/deny`; non-coordinator agents additionally merge `_non_coordinator.md`; all agents merge their resolved type file's own `permissions.allow/deny`. The three sources are deduplicated before writing `settings.local.json`.
- `nukeAllAgents(repoPath)` — kills and archives all agents in a repo, plus cleans orphaned tmux sessions
- `pauseAgent(agent)` — stops a running agent by killing its Claude process and tmux session without archiving
- `newAgent()` branches on `parseModel(model).cli`. **Codex path:** skips `.claude/settings.local.json` entirely, writes the worktree `.gitignore` entry + per-agent `AGENTS.md` (via `appendCodexGitignoreEntry` + `writeCodexAgentsMd`), runs the spawn-time dispatcher precheck (`ib hooks codex-pre-tool-use --dry-run <agentId>` + SessionStart + Stop), then generates a codex-shaped `start.sh` via `buildCodexStartContent`. **Claude path:** unchanged — byte-snapshot-guarded at `tests/fixtures/claude-start-sh-baseline.sh` so any drift fails CI. Coordinators cannot currently be spawned under codex: `--coordinator` + `codex:<model>` is rejected with `"codex coordinators not yet implemented; use claude:<model>"` (Phase 4 review HIGH 1).
- `resumeAgent()` branches on `parseModel(meta.model).cli`. **Codex path:** validates `meta.codex_session_id` is present (populated by the SessionStart hook on first spawn), runs the same spawn-time dispatcher precheck, then generates a codex-shaped `resume.sh` via `buildCodexResumeContent` invoking `codex resume "<UUID>"` with re-passed inline `-c` hook flags. **Claude path:** unchanged — byte-snapshot-guarded at `tests/fixtures/claude-resume-sh-baseline.sh`.
- `ib write-pid <agent-id> <pid>` subcommand (`src/index.ts`) routes through `mutateAgentMeta()` in `src/agents.ts` so concurrent meta.json writers can't clobber each other. Used by both claude AND codex `start.sh` + `resume.sh` to write the launched CLI process's PID into meta.json. Replaces an earlier inline `bun -e` snippet that had a lost-update race when a SessionStart hook fired before the PID write completed (Phase 4 review HIGH 2).

### Dialog system (in dashboard.ts / src/tui/dialog-handler.ts)
- 10 dialog types: `confirm`, `input`, `select`, `fuzzy`, `help`, `textarea`, `folder-browser`, `new-agent-form`, `setup`, `permissions-editor`
- Separate from dialogs, the status bar has a timed-notice mechanism: `showMessage()` queues a one-line notice that auto-dismisses after 3s or on any key, gated by `noticeCounter` to prevent stale timeouts from clearing newer notices
- `fuzzy` uses pi-tui's `fuzzyFilter`; wraps items with original indices to map filtered selection back
- `executeAndRefresh(fn)` wraps simple mutations (try/catch + watcher refresh)
- Multi-step flows (merge, diff-tool, snapshot) use `.then().catch()` because they need intermediate UI or skip refresh

### Manager/coordinator agent workflow

When a manager spawns sub-agents to do work, the manager's role is to **review and integrate** — never to re-implement what a sub-agent already did:

- **If the sub-agent's work is correct**: merge it with `ib merge <id> --force`
- **If the work has fixable issues**: send feedback with `ib send <id> "..."` and let the agent fix it
- **If the work is unsalvageable or no longer needed**: kill it with `ib kill <id> --force`

A manager should never duplicate a sub-agent's work by re-implementing it directly. Trust the sub-agent's output, review it, and act accordingly.

### Debugging stuck agents and orphan processes

`ib state` (or `ib state --json`) lists every agent with its tmux pane PID, claude PID, and watchdog PID, plus liveness for each (✓ alive, ✗ dead, — missing). When pane_pid has child processes that aren't the recorded claude_pid, they show as `[orphans: N]`. Use this when an agent is in a strange state, when `ps` shows processes you can't account for, or before/after killing agents to confirm cleanup. Implementation: src/state-command.ts.

`ib state` always renders an `ORPHANS` section after the agent list. Four categories are surfaced:

- **tmux sessions** — sessions matching `ib-coordinator` (system coordinator, exact) or `ittybitty-<repoId>-<agentId>` (every spawned agent + per-repo coordinator) that aren't in any registered repo's tracked set.
- **claude processes** — running `claude --resume <id>` / `claude --session-id <uuid>` whose **cwd is inside an itsybitsy worktree** (`.../.ittybitty/agents/<id>/...`) and whose PID isn't recorded in any tracked agent's `meta.json` `claude_pid`. The cwd anchor is critical — `--resume` and `--session-id` are standard Claude CLI flags, so a user running `claude --resume <id>` in their own terminal must NEVER be flagged. cwd lookup uses `lsof -d cwd` on macOS and `/proc/<pid>/cwd` on Linux.
- **watchdog processes** — running `ib watchdog <agent-id>` whose PID isn't in any agent's `watchdog_pid` (read from both `meta.json` and `meta.transient.json`).
- **ib watch processes** — every running `ib watch` (informational; there is no tracked set).

The tracked set is built from ALL agents in ALL registered repos plus the system coordinator's session — running `ib state` from any repo will not mis-flag legitimate agents from other repos. Each section reads "none" when empty.

`ib state --cleanup` kills every orphan it finds: `tmux kill-session` for sessions, SIGTERM with a short grace then SIGKILL for processes. Safety guarantees:
- The tracked set is rebuilt **immediately before** cleanup; any orphan whose target became tracked between gather and cleanup is skipped (race guard against agents spawned mid-`ib state`).
- Before SIGKILL, each PID's command line is re-resolved via `ps -o command=`; if it no longer matches an itsybitsy pattern, SIGKILL is refused (PID-reuse guard).
- Tmux session names are validated with `isValidTmuxSession` before being passed to `tmux kill-session`.

Each kill attempt is annotated `[killed]` / `[skipped: …]` / `[kill failed: …]` in the re-rendered ORPHANS section. In `--json` mode, a `cleanup_actions` array is added to the JSON payload **only when `--cleanup` was passed** alongside the `agents` and `orphans` fields. `ib state --cleanup --dry-run` previews what would be killed without issuing any kill commands. Under `--dry-run`, every entry in `cleanup_actions` has `killed: false`, `skipped: true`, `error: "dry-run"` so JSON consumers can distinguish "would have killed" from actually-killed without re-deriving from CLI args.

**Known limitation**: if you run both the bash `ib` and the bun `itsybitsy` and they don't share `~/.itsybitsy/repos.json`, `--cleanup` from one install will see the other's watchdogs as orphans. Don't run both simultaneously, or stick with one tracked registry.

### Sending literal strings with `ib send`

The shell expands `$(...)`, backticks, and `$VAR` inside double quotes before `ib` sees the argument. To pass a literal message:

- Single quotes: `ib send <id> 'literal $(foo) string'`
- Escape metacharacters: `ib send <id> "literal \$(foo) string"`
- Heredoc via stdin (safest for multi-line or complex content — `ib send` reads stdin when no message arg is given):
  ```
  ib send <id> <<'EOF'
  ...literal content...
  EOF
  ```

The quoted heredoc terminator (`<<'EOF'`) prevents any expansion inside the body.

### Agent monitoring loop

When running parallel agents, start a 2-minute cron loop to auto-merge completed agents:

1. Use the `loop` skill: `/loop 2m Check on all active ib agents. For any that are complete, verify they ran a review cycle (look for reviewer approval in their output). If they did, merge them with \`ib merge <id> --force\`. If they didn't, send them a message asking them to run a review cycle before completing. Report what you did each round.`
2. Note the job ID returned (e.g. `455a3261`)
3. When all target agents are merged, cancel: `CronDelete` with that job ID

The loop handles: checking completion, enforcing review cycles, merging approved agents, nudging agents that skipped review, and freeing agent slots when sub-reviewers complete.

### Validation (src/validation.ts)
Input validation helpers that enforce strict character allowlists to prevent shell injection in script templates. Exports: `isValidModel()` (alphanumeric, dots, hyphens, underscores), `isValidToolList()` (alphanumeric, underscores, hyphens, asterisks, parens, colons, dots, spaces, commas), `isValidAgentId()` and `isValidTmuxSession()` (alphanumeric, hyphens, underscores), `isValidSessionId()` (hex digits and hyphens). Used wherever user-supplied values are interpolated into shell commands.

### Ghostty (src/ghostty.ts)
- `openInGhostty(tmuxSession)` spawns Ghostty with `--command=bash -c 'tmux set-option -t <session> window-size latest && tmux attach -t <session>'`, detached via `proc.unref()` — the `window-size latest` prefix makes tmux re-fit to Ghostty's dimensions on attach, and the bash -c wrapper prevents Ghostty's login shell flags from being passed to tmux. Note: `+new-window` (reuse existing instance) is GTK-only and not available on macOS, so each call spawns a new Ghostty app.
- `openPathInGhostty(dirPath)` is the directory-opening counterpart — it launches a Ghostty window cd'd into `dirPath` (no tmux attach).
- Validates session name with `/^[\w-]+$/` before interpolating into `--command`
- Both functions return `{ ok, message }` — caller shows result via `showMessage()`

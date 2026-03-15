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

## Code Quality Requirements

After any code changes, always run:
1. `bun test` — all tests must pass
2. `bunx tsc --noEmit` — must report zero TypeScript errors; fix any new errors before committing

## itsybitsy Implementation Notes

All 6 phases complete. 968 tests across 28 files.

### State detection flow
**Deterministic model (Phase 42 — design complete, not yet implemented):**
1. Stop hook (`ib hook-status`) writes `state` to `meta.json` when Claude goes idle (`waiting`, `complete`, or `running`)
2. `ib send` and `ib resume` write `state: "running"` to `meta.json`
3. `detectAgentStates()` reads state from meta.json with tmux overrides for compacting/rate_limited/stopped
4. `creating` is derived from `created_epoch` (< 6s ago), never stored

**Current (legacy) flow:**
1. `watcher.ts` calls `detectAgentStates()` (in `agents.ts`) on every refresh
2. `detectAgentStates()` calls `captureTmuxOutput()` (in `tmux-poller.ts`) for each active agent, then calls `computeStateFromContent()` as a pre-check; only if it returns `null` does it call `parseState()` (in `parse-state.ts`)
3. Archived agents are always set to `stopped` without tmux capture
4. `parseState()` is pure string matching on ANSI-stripped tmux output — never call it on raw ANSI text

### SplitPane (src/tui/split-pane.ts)
pi-tui's `Box` is vertical-only. `SplitPane` renders two child components side-by-side by calling each child's `render(width)` independently, then merging lines: left is padded to exact width, separator char inserted, right is truncated. Left width is configurable.

### TmuxPoller (src/tmux-poller.ts)
- Polls only the SELECTED agent at ~1s via `setInterval`
- `setAgent(session)` switches target; triggers immediate poll
- Race condition guard: snapshots `targetSession` before async `Bun.spawn`, discards result if agent changed during await
- `captureTmuxOutput()` is a separate one-shot export used by `detectAgentStates()` in the watcher

### Agent data (src/agents.ts)
- `readAllAgents()` returns `{ agents, errors, orphanedTmuxSessions }` — always check errors
- `FlatEntry` discriminated union type lives here (not in watcher.ts) since `flattenAgentTree()` produces it — kind: "agent" for agent rows, kind: "repo-header" for repo headers
- `detectAgentStates()` is the single source of truth for state detection — both CLI and watcher use it
- `buildAgentTree()` mutates `agent.children` in place; call it after state detection
- `readAgentLog()`, `readAgentPrompt()`, `parseDenials()` — async helpers for right pane content

### parse-state.ts priority order
Creating (workspace trust prompt, full input) > Compacting (last 5) > Active running (last 5) > Tool waiting (last 15) > Rate limited (last 15) > Complete (last 15) > WAITING (last 15) > Other running (last 15) > Spinners (last 15) > Permission prompts (last 15) > Broader spinners (last 20) > Background tasks (last 15) > Race condition hook > Unknown

### Line wrapping (src/tui/wrap.ts)
- `wrapSingleLine(line, width)` and `wrapLines(text, width)` — ANSI-aware hard wrapping
- Walks characters, skips ANSI escape sequences for width calculation
- ANSI codes at wrap boundaries stay in the current chunk (no state carryover to next line)

### Dashboard (src/tui/dashboard.ts)
- Agent tree: max 7 visible rows with scroll indicators
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
- Dialog system: confirm, text input, select list, fuzzy search, help overlay, timed message — renders in status bar area, variable height
- `executeAndRefresh()` wraps all mutations: runs the action, catches errors, then triggers watcher refresh

### Hooks (src/hooks/)
Five native hook implementations run as Claude Code hook commands inside spawned agent sessions:
- `hook-check-path <agentId>` maps to `agent-path.ts`: Path isolation — blocks agents from accessing other agents' worktrees or the main repo. Reads JSON from stdin, outputs allow/deny decision JSON.
- `hook-status <agentId>` maps to `agent-status.ts`: Stop hook — detects stuck agents and sends nudge messages. Debounced via timestamp file.
- `hook-permission-denied <agentId>` maps to `permission-denied.ts`: Logs permission denial events to agent.log.
- `hooks intercept-task` maps to `intercept-task.ts`: PreToolUse hook — blocks disallowed models and unauthorized task spawning.
- `hooks session-start` maps to `session-start.ts`: SessionStart hook — injects role-specific context at session start.

Hooks read input from stdin. Path-check, intercept-task, and session-start write JSON to stdout and use exit codes (0 allow, 1 deny). Agent-status writes a plain state string to stdout. Permission-denied only logs to agent.log and exits 0.

### Agent lifecycle (src/agent-lifecycle.ts)
Shared agent lifecycle helpers used by multiple ib commands. Mirrors the ib bash script's teardown, archive, kill, and utility functions. Provides a pluggable `SpawnFn` runner (`setSpawnRunner()`/`resetSpawnRunner()`) for test injection. Handles formatting timestamps, archiving agent directories, and cleaning up tmux sessions and git worktrees.

### Auto-compact (src/auto-compact.ts)
Reads Claude transcript JSONL files to determine an agent's context window usage percentage, then sends `/compact` to agents that exceed a configured threshold. Matches ib's `get_agent_context_usage()` logic for transcript parsing. Encodes worktree paths into Claude's project directory naming scheme to locate the correct transcript file.

### Config (src/config.ts)
User-wide configuration system with user and default sources. Defines all config keys (`maxAgents`, `model`, `createPullRequests`, `allowAgentQuestions`, `autoCompactThreshold`, `externalDiffTool`, hooks settings, and per-role permission allow/deny lists). Reads from `~/.itsybitsy/config.json` (user home), merging with typed defaults. No per-repo configuration.

### Folder browser (src/tui/folder-browser.ts)
Builds the navigable item list for the add-repo folder browser dialog. Given a current path, produces a list of `FolderItem` entries: ancestors from root down to parent, the current folder, and sorted child directories. Each item includes depth, git-repo detection, and ancestor/current flags for rendering the tree-style UI.

### ib-commands (src/ib-commands.ts)
- Mutations are implemented natively. `runIb()` and `IbRunner` have been deleted. `hooksStatus`, `installSafetyHooks`, `uninstallSafetyHooks`, `installInterceptHook`, `uninstallInterceptHook`, `interceptHooksStatus` are natively implemented — they read/write `~/.claude/settings.json` (global).
- Always sets `cwd` to `agent.repoPath` — ib requires running from a git repo root
- Commands: killAgent, nukeAgent, nukeAllAgents, pauseAgent, resumeAgent, reassignAgent, mergeCheckAgent, mergeAgent, sendMessage, newAgent, diffAgent, statusAgent, acknowledgeQuestion
- `nukeAllAgents(repoPath)` — kills and archives all agents in a repo, plus cleans orphaned tmux sessions
- `pauseAgent(agent)` — stops a running agent by killing its Claude process and tmux session without archiving

### Dialog system (in dashboard.ts)
- 6 dialog types: `confirm`, `input`, `select`, `message`, `fuzzy`, `help`
- `message` auto-dismisses after 3s or on any key; `messageCounter` prevents stale timeouts
- `fuzzy` uses pi-tui's `fuzzyFilter`; wraps items with original indices to map filtered selection back
- `executeAndRefresh(fn)` wraps simple mutations (try/catch + watcher refresh)
- Multi-step flows (merge, diff-tool, snapshot) use `.then().catch()` because they need intermediate UI or skip refresh

### Manager/coordinator agent workflow

When a manager spawns sub-agents to do work, the manager's role is to **review and integrate** — never to re-implement what a sub-agent already did:

- **If the sub-agent's work is correct**: merge it with `ib merge <id> --force`
- **If the work has fixable issues**: send feedback with `ib send <id> "..."` and let the agent fix it
- **If the work is unsalvageable or no longer needed**: kill it with `ib kill <id> --force`

A manager should never duplicate a sub-agent's work by re-implementing it directly. Trust the sub-agent's output, review it, and act accordingly.

### Agent monitoring loop

When running parallel agents, start a 2-minute cron loop to auto-merge completed agents:

1. Use the `loop` skill: `/loop 2m Check on all active ib agents. For any that are complete, verify they ran a review cycle (look for reviewer approval in their output). If they did, merge them with \`ib merge <id> --force\`. If they didn't, send them a message asking them to run a review cycle before completing. Report what you did each round.`
2. Note the job ID returned (e.g. `455a3261`)
3. When all target agents are merged, cancel: `CronDelete` with that job ID

The loop handles: checking completion, enforcing review cycles, merging approved agents, nudging agents that skipped review, and freeing agent slots when sub-reviewers complete.

### Validation (src/validation.ts)
Input validation helpers that enforce strict character allowlists to prevent shell injection in script templates. Exports: `isValidModel()` (alphanumeric, dots, hyphens, underscores), `isValidToolList()` (alphanumeric, underscores, hyphens, asterisks, parens, colons, dots, spaces, commas), `isValidAgentId()` and `isValidTmuxSession()` (alphanumeric, hyphens, underscores), `isValidSessionId()` (hex digits and hyphens). Used wherever user-supplied values are interpolated into shell commands.

### Ghostty (src/ghostty.ts)
- `openInGhostty(tmuxSession)` spawns `ghostty --command='bash -c "tmux attach -t {session}"'` detached via `proc.unref()` — bash -c wrapper prevents Ghostty's login shell flags from being passed to tmux. Note: `+new-window` (reuse existing instance) is GTK-only and not available on macOS, so each call spawns a new Ghostty app.
- Validates session name with `/^[\w-]+$/` before interpolating into `--command`
- Returns `{ ok, message }` — caller shows result via `showMessage()`

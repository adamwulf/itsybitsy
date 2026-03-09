# itsybitsy — Plan

A cross-repo agent management dashboard for [ittybitty (`ib`)](https://github.com/anthropics/ittybitty), built with Bun and pi-tui.

## Problem

`ib watch` is scoped to a single repo. When running agents across multiple projects simultaneously, there's no unified view — you have to `cd` into each repo separately.

## Goals

This is a **full daily-driver replacement for `ib watch`**, extended to span multiple repos:

- **Unified dashboard** — see all agents across all registered repos in a single TUI
- **Agent tree** — show manager/parent/child relationships, recursively (multi-level)
- **Live tmux output** — view the active Claude session for any agent (like `ib watch` does)
- **Live status** — auto-detect agent state by parsing tmux output (port `parse_state` from `ib`)
- **All `ib` actions** — kill, resume, merge, merge-check, send, new-agent, diff, status, look (log), questions, open in Ghostty
- **Pending questions** — surface `ib questions` in the TUI so agent questions aren't missed
- **Ghostty integration** — open any agent's tmux session as a new Ghostty window
- **Easy distribution** — single compiled binary via `bun build --compile`
- **No browser UI** — terminal only

## Explicit Non-Goals (for now)

- No web/browser UI
- Cross-repo agent messaging (v2 — see below)
- `ib watchdog` — Phase 13 adds a built-in watchdog to itsybitsy. Until then, agents spawned via `ib new-agent` get their own bash watchdog automatically
- `ib ask` — agents asking the user a question is surfaced via `user-questions.json`; no need to shell to `ib ask` directly from itsybitsy
- `ib info` — meta.json is read directly; raw field inspection available as a debug view (`i` keybinding, low priority)
- `ib config` — itsybitsy reads `.ittybitty.json` directly rather than shelling to `ib config`

## Runtime & Dependencies

- **Runtime:** Bun (always use `bun`, never node/ts-node)
- **TUI:** `@mariozechner/pi-tui@0.56.0` (installed, on npm)
- **`ib`:** always use the version on `$PATH`; source lives at `~/Developer/bash/ittybitty/ib` (23,822-line bash script)
- **External deps:** `ib`, `tmux`, `git`, `claude` must be on `$PATH`

## Architecture

### Read vs. Write split

- **Read agent state:** read `.ittybitty/` files directly — faster than shelling to `ib list`
- **Mutations:** shell out to `ib` commands (`ib kill`, `ib resume`, `ib merge`, `ib merge-check`, `ib send`, `ib new-agent`, `ib diff`, `ib status`, `ib acknowledge`)
- **Never** reimplement tmux/git/worktree mutation logic from `ib`
- **Critical:** every `ib` command must be run with `cwd` set to the target repo root — `ib` requires being run from the root of a git repository

### Update strategy

- `fs.watch(path, { recursive: true })` on each repo's `.ittybitty/agents/` — **must use `recursive: true`** or file changes inside `agents/{id}/` subdirectories (e.g., `meta.json`) will never fire events
- On macOS, `FSEvents` (backing `fs.watch`) can occasionally miss rapid events — add a low-frequency fallback poll (every 10s) as a safety net
- Poll `tmux capture-pane` every ~1s for the currently-selected agent's live output only (pause when no agent selected)
- `Promise.all()` across all registered repos for concurrent reads
- Single-threaded Bun async model is sufficient — no worker threads needed

### State detection

Port `parse_state` from `ib` (bash → TypeScript). It pattern-matches the last 5–20 lines of
tmux output (after stripping ANSI codes). States:

| State | Detection |
|---|---|
| `creating` | Permission prompt before Claude starts (`Enter to confirm` + trust/import text, no `Claude Code v` yet) |
| `running` | `(Esc to interrupt`, `⎿  Running`, active spinners with interrupt marker or token arrows |
| `waiting` | `WAITING` on its own line (and no `⏺` output after it), or `⎿  Waiting` |
| `complete` | `I HAVE COMPLETED THE GOAL` in last 15 lines |
| `compacting` | `Compacting conversation` in last 5 lines |
| `rate_limited` | `rate_limit_error`, `usage limit reached`, `hit your limit`, etc. |
| `stopped` | tmux session doesn't exist |
| `unknown` | Empty tmux output or no match |

Key subtleties:
- `compacting` checked before `running` (it also shows `(esc to interrupt)`)
- Active running indicators in last 5 lines checked BEFORE `⎿  Waiting` in last 15 lines (prevents stale tool-waiting from overriding resumed running)
- `⎿  Waiting` (tool waiting) treated as `waiting` not `running`
- Stale `WAITING`: if `⏺` appears after `WAITING`, agent has resumed → `running`
- Hook spinners filtered out before spinner detection
- Broader 20-line window used as last resort for active spinners

### Tmux output capture

```
tmux capture-pane -t {tmux_session} -p -S -{lines} -E -
```
Strip ANSI codes before pattern matching. Show raw output (with ANSI) in the live view pane.
`tmux_session` comes from `meta.json` (e.g., `ittybitty-{repo-uuid}-{agent-id}`).

**ANSI passthrough validated in Phase 3** — `visibleWidth()` and `truncateToWidth()` correctly ignore/preserve ANSI codes. `Text`, `Container`, and custom components all pass ANSI through to the terminal. See `src/tui/ansi-validation.test.ts`.

### pi-tui horizontal layout

The two-pane design (agent tree left, tmux output right) requires pi-tui `Box` to support horizontal side-by-side layout. **Validated in Phase 1:** `Box` only supports vertical layout. A custom `SplitPane` component (`src/tui/split-pane.ts`) renders two children side-by-side by merging their `render()` output line-by-line, padding the left pane and truncating the right.

## File Layout

```
itsybitsy
├── src/
│   ├── index.ts              # CLI entrypoint: add/remove/list/watch/agents subcommands
│   ├── registry.ts           # Read/write ~/.itsybitsy.json
│   ├── registry.test.ts      # Registry unit tests
│   ├── agents.ts             # Read .ittybitty/agents/ + archive/ directly; types for Agent,
│   │                         # AgentState, FlatAgent; tree building; detectAgentStates();
│   │                         # reads user-questions.json; returns structured errors
│   ├── agents.test.ts        # Agent data layer tests
│   ├── parse-state.ts        # Port of ib's parse_state bash logic → TypeScript
│   ├── parse-state.test.ts   # State detection tests
│   ├── usage.ts              # Fetches Claude API quota from Anthropic OAuth API;
│   │                         # caches at ~/.claude/usage-cache.json (10s TTL)
│   ├── usage.test.ts         # Usage fetch/parse tests
│   ├── update-check.ts       # Background npm registry version checker (hourly)
│   ├── update-check.test.ts  # Update checker tests
│   ├── config.ts             # Config reading/writing for .ittybitty.json
│   ├── config.test.ts        # Config tests
│   ├── watcher.ts            # fs.watch({ recursive: true }) on agents/, archive/,
│   │                         # user-questions.json; 10s fallback poll; debounced refresh;
│   │                         # 2s stateTimer for between-refresh state polling
│   ├── watcher.test.ts       # Watcher tests
│   ├── tmux-poller.ts        # Polls tmux capture-pane for the selected agent (~1s, 500 lines);
│   │                         # also exports captureTmuxOutput() for one-shot state detection (500 lines)
│   ├── tmux-poller.test.ts   # Tmux poller tests
│   ├── ib-commands.ts        # Wrappers for ib mutations; cwd = repo root
│   ├── ib-commands.test.ts   # ib-commands tests
│   ├── ghostty.ts            # Open tmux sessions in Ghostty
│   ├── ghostty.test.ts       # Ghostty tests
│   ├── orphan-detection.test.ts # Orphaned tmux session detection tests
│   ├── test-utils.ts         # Shared test helpers
│   └── tui/
│       ├── dashboard.ts      # Main TUI: agent tree + split pane + status bar + dialogs
│       ├── dashboard.test.ts # Dashboard tests
│       ├── agent-tree.ts     # AgentTreeComponent + formatAgentRow
│       ├── agent-actions.ts  # Agent action handlers (kill, merge, send, etc.)
│       ├── pane-manager.ts   # RightPaneComponent + pane mode cycling + async loading
│       ├── dialog-handler.ts # DialogState type + dialog input routing
│       ├── color-scheme.ts   # Terminal color scheme detection + getStateColors
│       ├── folder-browser.ts # Folder browser for adding repos
│       ├── folder-browser.test.ts # Folder browser tests
│       ├── split-pane.ts     # Custom horizontal layout (pi-tui Box is vertical-only);
│       │                     # fullWidth flag hides left pane for DIFF/DENIALS/TREE/ERRORS/QUESTIONS
│       ├── split-pane.test.ts # Split pane tests
│       ├── wrap.ts           # ANSI-aware line wrapping
│       ├── wrap.test.ts      # Wrap tests
│       └── ansi-validation.test.ts  # ANSI passthrough tests
├── research/                 # Deep-dive analysis docs (not shipped)
│   ├── ib-watch-analysis.md        # ib bash watch implementation deep dive
│   ├── itsybitsy-watch-analysis.md # itsybitsy TS implementation deep dive
│   ├── watch-parity-gaps.md        # Initial gap analysis (P0/P1/P2)
│   ├── parity-check-ux.md          # Post-P0 UX parity check (G-01 through G-16)
│   └── parity-check-logic.md       # Post-P0 logic/correctness parity check
├── PLAN.md
├── CLAUDE.md
└── package.json
```

Note: `watcher.ts` and `tmux-poller.ts` are split by concern — `watcher.ts` handles structural changes (agents added/removed/changed via `fs.watch` on `agents/`, `archive/`, `user-questions.json`) and detects state for ALL agents on each refresh; `tmux-poller.ts` handles live output capture for the SELECTED agent only (~1s poll). Different consumers, different error modes, different trigger conditions.

`watcher.ts` runs three timers: (1) `fs.watch` debounced 200ms for instant structural changes, (2) 10s fallback poll for FSEvents misses, (3) 2s `stateTimer` that calls `detectAgentStates()` on cached agents to keep state fresh between structural refreshes without re-reading disk.

Also: `src/usage.ts` — fetches Claude API session+weekly utilization from `GET https://api.anthropic.com/api/oauth/usage`, caches at `~/.claude/usage-cache.json` (10s TTL), reads credentials from `~/.claude/.credentials.json` or macOS Keychain. Dashboard footer refreshes every 30s and color-codes >80% yellow, >90% red.

## .ittybitty/ Directory Structure

```
{repo}/.ittybitty/
├── agents/
│   └── {agent-id}/
│       ├── meta.json       # id, session_id, tmux_session, prompt, manager, created,
│       │                   # created_epoch, worktree, worker, yolo, model, claude_pid
│       ├── agent.log       # Full agent log
│       ├── prompt.txt      # Original prompt
│       ├── start.sh        # Session start script
│       ├── exit-check.sh
│       ├── repo            # Path to the worktree
│       └── debug-logs/     # tmux captures from hooks
├── archive/                # Closed agents (hidden by default in TUI)
├── feedback.json
├── repo-id                 # Unique repo UUID (used in tmux session names)
├── reports/
├── STATUS.md
└── user-questions.json     # Pending questions from agents (see schema below)
```

`meta.json` example:
```json
{
  "id": "agent-1f5f04ce",
  "session_id": "6e8f6acb-825a-494a-be21-d13384e7ac57",
  "tmux_session": "ittybitty-8b157909-agent-1f5f04ce",
  "prompt": "...",
  "manager": null,
  "created": "2026-03-03T17:03:36-06:00",
  "created_epoch": 1772579016,
  "worktree": true,
  "worker": false,
  "yolo": false,
  "model": "sonnet",
  "claude_pid": "31269"
}
```

`worker: true` means the agent cannot spawn sub-agents. Display with a different icon in the tree (e.g., `⚙` vs `◆` for managers).

`user-questions.json` schema:
```json
{
  "questions": [
    {
      "id": "q-abc123",
      "agent": "agent-1f5f04ce",
      "question": "Should I proceed with X?",
      "timestamp": "2026-03-03T17:10:00-06:00",
      "status": "pending"
    }
  ]
}
```
Status values: `pending`, `acknowledged`. Show pending count as a badge in the TUI header.

`ib list --json` output format (for reference, prefer direct file reads):
```json
[{"id":"agent-1f5f04ce","state":"waiting","age":"1d","manager":"-","model":"sonnet","prompt":"..."}]
```

Per-repo `.ittybitty.json` config (read `fps` field to inform polling rate):
```json
{ "fps": 10, "maxAgents": 10, "model": "sonnet" }
```

**Orphan detection:** if a tmux session exists but has no matching `meta.json`, display it as an orphan warning in the TUI.

## Repo Registry (`~/.itsybitsy.json`)

```json
{
  "repos": [
    { "path": "/Users/adamwulf/Developer/muse/muse-ios", "name": "muse-ios" },
    { "path": "/Users/adamwulf/Developer/bash/ittybitty", "name": "ittybitty" }
  ],
  "diffTool": "code --diff"
}
```

`diffTool` is optional. When set, `o` writes `ib diff {id}` output to a temp file and opens it with the configured command: `{diffTool} {tempfile}`. If not set, `o` shows a "No diff tool configured — set diffTool in ~/.itsybitsy.json" message. Read `diffTool` from registry alongside `repos`.

CLI commands:
- `itsybitsy add [path]` — register current or specified dir (default: cwd)
- `itsybitsy remove [path]` — unregister a repo
- `itsybitsy list` — list registered repos
- `itsybitsy watch` — launch TUI dashboard

## TUI Layout (pi-tui)

Broadly matches `ib watch` layout and keybindings so existing users feel at home.

```
┌─────────────────────────────────────────────────────────────┐
│  repo-name  agent-id  state  age  model  prompt...          │  ← agent tree
│    ↳ child-agent-id  state  age  model  prompt...           │    (scrolls with
│  repo2-name agent-id  state  age  model  prompt...          │     selection)
├──────────────────────────────┬──────────────────────────────┤
│                              │                              │
│  live tmux output            │  right pane (cycling)        │
│  (left, fixed ~60 cols)      │  modes: log / prompt /       │
│                              │  denials / tree / errors /   │
│                              │  diff / status / questions   │
│                              │                              │
└──────────────────────────────┴──────────────────────────────┘
  [state badge] [pending questions badge]  j/k @  p/n d g e q  s m x a
```

The agent tree at top shows all agents across all registered repos, grouped by repo, with recursive manager/child indentation. The bottom is split: tmux capture on the left (fixed width), cycling right pane on the right.

### Right Pane Modes (cycle with `p`/`n`)

| Mode | Content |
|---|---|
| 0 — AGENT LOG | `agent.log` read directly |
| 1 — INITIAL PROMPT | Full prompt from `prompt.txt` |
| 2 — DENIALS | Tool denials log (parsed from `agent.log` — look for lines containing `denied`/`not allowed`/`permission denied`/`PreToolUse` hook output) |
| 3 — TREE | Full agent tree (all repos) |
| 4 — ERRORS | Agent creation/async errors |
| 5 — DIFF | `ib diff` output |
| 6 — STATUS | `ib status` output (commits + changes) |
| 7 — QUESTIONS | Pending questions from `user-questions.json` |

### Key Bindings

Matching `ib watch` keybindings exactly where possible; new keys noted.

**Navigation**
- `j` / `k` or ↑ / ↓ — move selection up/down in agent tree (or within questions pane)
- `@` — fuzzy jump to agent by name
- `/` — fuzzy jump to pane mode by name

**Right pane**
- `p` / `n` — cycle right pane mode forward/backward; `←` maps to `p` (forward/next), `→` maps to `n` (backward/previous) — note: counterintuitive arrow direction, matches ib watch exactly
- `d` — jump directly to DIFF pane
- `g` — jump to STATUS pane when in normal context; "go to agent" when in QUESTIONS pane (navigates to the agent that asked the selected question). Note: ib watch's help claims `g` = status jump but it's dead code in the bash implementation — itsybitsy intentionally implements both behaviors correctly
- `e` — jump directly to ERRORS pane
- `q` — jump directly to QUESTIONS pane
- `t` — cycle denials time filter (only active in DENIALS pane, mode 2); 3 filter levels
- `;` — scroll pane down (show older content)
- `l` — scroll pane up (toward bottom / newer content)
- `[` / `]` — resize left pane (decrease / increase width by 5)
- `Tab` / `Shift-Tab` — toggle focus between agent tree and questions list (only in QUESTIONS pane)

**Agent actions**
- `s` — send message to selected agent (dialog)
- `m` — merge agent (runs merge-check first; confirm dialog)
- `x` — kill agent (confirm dialog)
- `!` — force-kill / nuke agent (confirm dialog)
- `a` — new agent (infers repo from selection, dialog: prompt, --worker flags)
- `r` — reassign agent's manager (dialog) ← matches `ib watch`
- `P` — pause a running/waiting agent (confirm dialog) ← new, not in `ib watch`
- `R` — resume a stopped agent ← new, not in `ib watch`
- `G` — open agent's tmux session in Ghostty ← new, not in `ib watch` (`g` is taken by status)
- `w` — open agent worktree in Finder (`open {worktree}`)
- `o` — open diff in external tool: write `ib diff {id}` output to a temp file, then run `{diffTool} {tempfile}` where `diffTool` comes from `~/.itsybitsy.json`; show message if not configured
- `S` — capture tmux snapshot for debugging state detection: capture tmux output for selected agent, run `parseState` on it, write result to `.ittybitty/agents/{id}/debug-logs/snapshot-{timestamp}-{state}.txt`, show status message with filename. **Not** an `ib` subcommand — implement directly using `captureTmuxOutput()` + `parseState()`.
- `c` — clear errors (only active in ERRORS pane)
- `Enter` — answer selected question (QUESTIONS pane); kill orphaned tmux session (ERRORS pane)
- `Escape` — acknowledge question without answering (only active in QUESTIONS pane)

**App**
- `?` — read-only help dialog showing all keybindings; press any key to dismiss
- `h` — setup dialog (hooks status, gitignore check, diff tool config)
- `+` — add repo folder (folder browser dialog)
- `Ctrl-C` — exit

## Ghostty Integration

```
ghostty --command="tmux attach -t {tmux_session}"
```

Degrade gracefully if Ghostty is not available (skip or show error).

## pi-tui API Summary

- `ProcessTerminal` — wraps stdin/stdout
- `TUI extends Container` — root: `new TUI(terminal)`, then `tui.start()` / `tui.stop()`
- `tui.addChild(component)` — add components
- `tui.requestRender()` — trigger re-render
- `tui.setFocus(component)` — route input
- `tui.addInputListener(fn)` — global key handler
- Components implement `render(width): string[]`; optional `handleInput(data)`, `invalidate()`
- Built-ins: `Text`, `TruncatedText`, `Box`, `Spacer`, `SelectList`, `Input`, `Editor`, `Loader`, `Markdown`
- No built-in table — render tables as formatted strings inside `Text`
- **Horizontal layout:** `Box` does NOT support side-by-side. Use custom `SplitPane` (see `src/tui/split-pane.ts`)
- **ANSI passthrough:** Validated. `visibleWidth()`/`truncateToWidth()` handle ANSI correctly

## v2: Cross-Repo Messaging

Agents currently communicate via files in their own `.ittybitty/` dir.
itsybitsy can act as a message broker: write to the destination repo's `.ittybitty/`
in the same format that `ib send` uses. Does not require changes to `ib`.

## Phases

Each phase ends at a usable checkpoint — something that works and can be tested end-to-end.

---

### Phase 1: CLI Foundation -- COMPLETE
**Checkpoint:** `itsybitsy add/remove/list` works. pi-tui horizontal layout validated (Box is vertical-only; custom SplitPane created).

- [x] `src/index.ts` — CLI entrypoint, parse `add/remove/list/watch/agents` subcommands
- [x] `src/registry.ts` — read/write `~/.itsybitsy.json`; add, remove, list repos
- [x] Wire up `itsybitsy add [path]`, `itsybitsy remove [path]`, `itsybitsy list`
- [x] Unit tests for registry (7 tests)
- [x] **Validated pi-tui horizontal Box layout** — Box is vertical-only, created custom `SplitPane` component

---

### Phase 2: Agent Data Layer -- COMPLETE
**Checkpoint:** `itsybitsy agents` prints all agents across all registered repos with correct states (via tmux capture + parseState). Error handling in place.

- [x] `src/agents.ts` — read `.ittybitty/agents/` and `archive/`; `Agent`, `AgentState`, `FlatAgent` types; `readPendingQuestions()`; `detectAgentStates()`; `computeAge()`; structured error reporting
- [x] `src/parse-state.ts` — full port of `parse_state` bash logic; all state rules
- [x] `src/watcher.ts` — `fs.watch({ recursive: true })` on `agents/`, `archive/`, `user-questions.json`; 200ms debounce; 10s fallback poll; calls `detectAgentStates()`
- [x] `src/tmux-poller.ts` — polls selected agent at ~1s; `captureTmuxOutput()` for one-shot state detection; race-condition guard on agent switch
- [x] Basic error handling: try/catch, graceful degradation for missing/malformed `meta.json`, structured `AgentReadError` reporting
- [x] Unit tests: parse-state (43 tests), agents (23 tests)
- [x] Orphan tmux session detection

---

### Phase 3: Basic TUI Dashboard -- COMPLETE
**Checkpoint:** `itsybitsy watch` launches a live TUI with agent tree, state updates via fs.watch + tmux, split pane layout, and keybindings.

- [x] `src/tui/dashboard.ts` — agent tree at top (max 7 rows, scrolls with selection), split pane below (tmux left + cycling right pane)
- [x] Agent tree: recursive manager/child indentation, workers `⚙` vs managers `◆`, state color-coded; archived agents always hidden
- [x] Right pane modes 0–7; `p`/`n` to cycle, direct jump keys `d`/`g`/`e`/`q`; mode persists across agent selection changes
- [x] Keyboard navigation: `j/k` or arrow keys; `;`/`l` scroll pane content
- [x] Watcher events wired to `tui.requestRender()`; TmuxPoller integrated for live output
- [x] Status bar with pending question count badge and keybinding hints
- [x] `Ctrl-C` to quit
- [x] **ANSI passthrough validated** — 7 tests in `ansi-validation.test.ts`

---

### Phase 4: Live Tmux Pane -- COMPLETE
**Checkpoint:** Selecting an agent shows its live Claude session output in a right-hand pane, updating every ~1s.

Note: `tmux-poller.ts` was implemented in Phase 2/3. Phase 4 focuses on rendering quality.

- [x] `src/tmux-poller.ts` — already implemented: polls at ~1s, race-condition guard, integrated into dashboard
- [x] Left pane: ANSI-aware line wrapping (`src/tui/wrap.ts`), scroll-back from bottom with `;`/`l`, auto-follow, display height computed from terminal size
- [x] Right pane mode 0 (AGENT LOG): reads `agent.log` from disk (async loading, handles missing/empty files)
- [x] Graceful display when tmux session doesn't exist: shows agent state, clear "No active tmux session" message for stopped/orphaned agents

---

### Phase 5.1: Core Agent Actions (Mutations) -- COMPLETE
**Checkpoint:** Kill, resume, merge, send, and new-agent all work from the TUI with confirm dialogs.

- [x] `src/ib-commands.ts` — async wrappers for all `ib` mutations; **always sets `cwd` to the target repo root**; functions: `killAgent`, `nukeAgent`, `resumeAgent`, `reassignAgent`, `mergeAgent`, `mergeCheckAgent`, `sendMessage`, `newAgent`, `diffAgent`, `statusAgent`
- [x] `x` — kill agent: confirm dialog showing agent ID, then `ib kill {id}`
- [x] `!` — nuke/force-kill: confirm dialog, then `ib nuke {id} --force`
- [x] `R` — resume stopped agent: `ib resume {id}` (only enabled when agent is stopped/complete)
- [x] `r` — reassign agent's manager: text input dialog, then `ib reassign {id} {new-manager}`
- [x] `m` — merge agent: run `ib merge-check {id}` first, show result in confirm dialog, then `ib merge {id} --force`
- [x] `s` — send message: text input dialog, then `ib send {id} "message"`
- [x] `a` — new agent: infers repo from selection → name → worker toggle → prompt; shells to `ib new-agent`

---

### Phase 5.2: Right Pane Content -- COMPLETE
**Checkpoint:** All right pane modes show real content.

- [x] Right pane mode 1 — INITIAL PROMPT: reads `prompt.txt` from `.ittybitty/agents/{id}/prompt.txt`, falls back to `meta.prompt`
- [x] Right pane mode 2 — DENIALS: parses `agent.log` for `[PreToolUse] Permission denied:` lines with timestamp-based time filter
- [x] Right pane mode 3 — TREE: renders full cross-repo agent tree with age and model info
- [x] Right pane mode 4 — ERRORS: async errors collected by watcher's `onError` callback; `c` to clear
- [x] Right pane mode 5 — DIFF: `ib diff {id}` output, loaded async when pane is active, cached until agent changes
- [x] Right pane mode 6 — STATUS: `ib status {id}` output, loaded async when pane is active, cached until agent changes
- [x] `g` — STATUS pane in normal context; go-to-agent in QUESTIONS pane (selects agent and jumps to AGENT LOG)
- [x] `q` — QUESTIONS pane; `Enter` to answer (acknowledges + sends); `Escape` to acknowledge without answering
- [x] `t` — cycle denials time filter (3 levels: all / 24h / 7d), only active in DENIALS pane

---

### Phase 5.3: Navigation & Remaining Keybindings -- COMPLETE
**Checkpoint:** Fuzzy navigation, questions workflow, and all remaining keybindings work.

- [x] `@` — fuzzy jump to agent by name (pi-tui SelectList dialog overlay)
- [x] `/` — fuzzy jump to pane mode by name (pi-tui SelectList dialog overlay)
- [x] `w` — open agent worktree in Finder: `Bun.$\`open ${agent.worktree}\``; show error if worktree doesn't exist
- [x] `o` — open diff in external tool: write `diffAgent()` output to a temp file (`/tmp/itsybitsy-diff-{id}.txt`), run `{diffTool} {tempfile}`; show "No diff tool configured" message if `diffTool` not set in `~/.itsybitsy.json`
- [x] `?` — read-only help dialog listing all keybindings; press any key to dismiss (use existing message dialog type). Note: originally `h`, moved to `?` in Phase 12A when `h` was reassigned to setup dialog.
- [x] `S` — snapshot for debugging: call `captureTmuxOutput(agent.meta.tmux_session)`, run `parseState()` on stripped output, write full capture + state to `.ittybitty/agents/{id}/debug-logs/snapshot-{timestamp}-{state}.txt`, show status message. **Not** an `ib` subcommand — implement directly.

---

### Phase 6: Ghostty Integration & Distribution -- COMPLETE
**Checkpoint:** Production-ready single binary you can install and use daily.

- [x] `src/ghostty.ts` — `ghostty --command="tmux attach -t {tmux_session}"`; detect if Ghostty is available; degrade gracefully
- [x] `G` keybinding wired up — open selected agent's tmux session in Ghostty (`g` is reserved for STATUS pane / go-to-agent)
- [x] `bun build --compile` produces a single self-contained binary
- [x] README with install instructions and keybinding reference
- [x] Polish error messages: missing `ib`/`tmux`, unreadable repos, malformed `meta.json`

---

---

### Phase 7: ib watch Parity — P0 -- COMPLETE

Deep analysis of `ib watch` (bash, ~8200 lines) vs itsybitsy (TypeScript) produced a full gap inventory. See `research/` for the full analysis docs. P0 gaps are fixed.

**Fixed in this phase:**
- [x] **Tmux capture depth** — `captureTmuxOutput()` default 20→100 lines; `TmuxPoller` display 100→500 lines (matches ib's `-S -500`)
- [x] **Full-width pane modes** — `SplitPane.fullWidth` flag; DIFF, DENIALS, TREE, ERRORS, QUESTIONS hide left pane and use full terminal width
- [x] **All-agent state polling** — `watcher.ts` `stateTimer` (2s) calls `detectAgentStates()` on all agents between `fs.watch` events; keeps state fresh without re-reading disk
- [x] **Claude API usage display** — `src/usage.ts` fetches session+weekly quota from Anthropic OAuth API; dashboard footer shows color-coded percentages (>80% yellow, >90% red) every 30s
- [x] **Flaky fs.watch test** — poll-until-ready with 5s deadline + explicit 10s test timeout

**Known intentional deviation from ib:**
- `parseState()` checks active-running (last 5) before tool-waiting (last 15), opposite of ib's order. Rationale: if agent resumed (Esc visible in last 5), a stale `⎿ Waiting` at line 6–15 should not override. Documented in `research/parity-check-logic.md`.

---

### Phase 8: Quick Wins — Commands & State Detection -- COMPLETE
**Checkpoint:** `!` (nuke) correctly kills descendants, `a` (new-agent) wires up manager hierarchy, `P` pauses agents, dead-agent questions filtered, `creating` state detected more reliably, state detection capture depth matches ib.

These are small, isolated changes — each is a few lines, low risk, and independently testable.

**Command fixes:**
- [x] **Fix `nukeAgent()` to use `ib nuke`** (`src/ib-commands.ts`) — change from `ib kill {id} --force` to `ib nuke {id} --force` so that `!` recursively kills the agent AND all its descendants. Update tests.
- [x] **Add nuke-all capability** (`src/ib-commands.ts`, `src/tui/dashboard.ts`) — add `nukeAllAgents(repoPath)` that calls `ib nuke --force` (no ID = kill all agents in repo). In the dashboard, when `!` is pressed with no agent selected, show confirm dialog for nuke-all. This is the emergency stop feature.
- [x] **Add `--manager` flag to `newAgent()`** (`src/ib-commands.ts`, `src/tui/dashboard.ts`) — add `manager?: string` to `NewAgentOptions`. In the new-agent dialog, if an agent is currently selected and is a manager (not a worker), auto-pass `--manager {selected.id}` to `ib new-agent`. This is critical for correct agent hierarchy when spawning from the TUI.
- [x] **Dead-agent question filtering** (`src/agents.ts`) — in `readPendingQuestions()`, after reading `user-questions.json`, filter out questions whose `agent` ID does not exist in the current `.ittybitty/agents/` directory. Matches ib's `cmd_questions()` which skips dead agents.
- [x] **Pause agent (`P` key)** (`src/ib-commands.ts`, `src/tui/dashboard.ts`) — add `pauseAgent(repoPath, id)` that calls `ib pause {id}`. Add `P` keybinding in dashboard with confirm dialog. Only enabled for running/waiting agents (not already stopped). After pause, agent shows as "stopped" and can be resumed with `R`.

**State detection fixes:**
- [x] **Missing startup indicators** (`src/parse-state.ts`) — add `"╭─ Claude Code"` and `"[AGENT CONTEXT]"` to the creating-state startup check alongside `"Claude Code v"`. Worker agents inject `[AGENT CONTEXT]` before `Claude Code v` appears; `╭─ Claude Code` is the box-drawing header variant.
- [x] **State detection capture depth** (`src/tmux-poller.ts`) — increase `captureTmuxOutput()` default from 100 to 500 lines to match ib's capture depth for state detection. The display poller already uses 500 lines; this aligns the state-detection one-shot calls used by `detectAgentStates()`.
- [x] **`compute_state_from_content` pre-check** (`src/agents.ts`) — in `detectAgentStates()`, before calling `parseState()`, count non-empty lines in the captured output. If < 10 lines AND none of the startup markers (`"Claude Code v"`, `"╭─ Claude Code"`, `"[AGENT CONTEXT]"`) are found, return `"creating"` directly instead of delegating to `parseState()`. This matches ib's `compute_state_from_content()` wrapper.

---

### Phase 9: Dashboard UX — Control Flow & Footer -- COMPLETE
**Checkpoint:** Pane cycling skips empty panes, footer shows error count, terminal title updates, small terminals show a warning, update notifications appear.

All changes in `src/tui/dashboard.ts` — control flow and status bar only, no rendering changes.

- [x] **Pane cycling skips empty panes (G-03)** — in `cyclePaneMode()`, after computing next mode: if ERRORS mode and `errors.length === 0`, skip; if QUESTIONS mode and `questions.length === 0`, skip. Handle wrap-around (don't infinite-loop if all skippable).
- [x] **Error count badge in footer (G-07)** — add `errorCount` to `StatusBarComponent`. Show red `[N errors]` badge next to the question badge when `errorCount > 0`. `addError()` increments, `clearErrors()` resets.
- [x] **Terminal title (G-10)** — emit `\x1b]0;itsybitsy: ${agentId}\x07` on agent selection change. Emit `\x1b]0;itsybitsy\x07` when no agent is selected or on exit.
- [x] **Minimum terminal size (G-11)** — at top of `render()`, if `process.stdout.rows < 20 || width < 80`, render a single warning line ("Terminal too small — need at least 80x20") and return early.
- [x] **Scroll step size (G-13)** — change scroll step constant from `5` to `10` lines to match ib watch. Extract as `const SCROLL_STEP = 10`.
- [x] **Denial filter intervals (G-14)** — change `DENIAL_FILTERS` from `["all", "1h", "10m"]` to `["all", "24h", "7d"]`. Update `filterDenials()` cutoff math accordingly.
- [x] **Update notification** (`src/update-check.ts`, `src/tui/dashboard.ts`) — new module: check for updates once per hour by reading the `version` field from `package.json` (current version) and comparing against the latest version from the npm registry (`https://registry.npmjs.org/itsybitsy/latest`). Show "Update available: vX.X.X" in the dashboard header row if newer version exists. Fetch in background via `setTimeout`, never delay startup or block rendering.

---

### Phase 10: Dashboard Rendering — Colorization & Layout -- COMPLETE
**Checkpoint:** Diff output is colorized, agent log has syntax highlighting, top-anchored panes scroll correctly, TREE shows prompts, orphaned agents and tmux sessions are detected and marked.

Changes in `src/tui/dashboard.ts` render paths + `src/agents.ts` for orphan flags.

**Orphan detection (agents with missing managers):**
- [x] **Orphaned flag on Agent (G-06 part 1)** (`src/agents.ts`) — add `orphaned?: boolean` to `Agent` type. In `buildAgentTree()`, when `agent.meta.manager` is set but not found in `byId`, set `agent.orphaned = true`. Note: this is distinct from orphaned tmux sessions (below) — this flags agents whose parent manager was killed/archived.
- [x] **Orphaned agent indicator (G-06 part 2)** (`src/tui/agent-tree.ts`) — in `formatAgentRow()`, prepend `⚠ ` when `agent.orphaned === true`.

**Orphan tmux session detection:**
- [x] **Detect orphaned tmux sessions** (`src/agents.ts` + `src/tmux-poller.ts`) — after reading all agents, run `tmux list-sessions -F "#{session_name}"` and filter for sessions matching `ittybitty-*`. Compare against known agent tmux session names. Sessions without matching agent data are stale orphans. Returned as `orphanedTmuxSessions` in `ReadAgentsResult`.
- [x] **Display orphan tmux warnings** (`src/tui/pane-manager.ts`) — show orphaned tmux sessions in the ERRORS pane with a message like "⚠ {session_name} (no matching agent)". Count included in the error badge in footer.
- [x] **Orphan cleanup** (`src/tui/agent-actions.ts`) — when viewing ERRORS pane, Enter opens confirm dialog to kill the orphaned tmux session (runs `tmux kill-session -t {session}` via `killTmuxSession()`).

**Colorization:**
- [x] **Diff colorization (G-04)** — post-process `diffContent` lines: `+` lines (not `+++`) get green `\x1b[32m`; `-` lines (not `---`) get red `\x1b[31m`; `@@`/`---`/`+++`/`diff ` lines get dim `\x1b[2m`. Reset `\x1b[0m` at end of each colored line.
- [x] **Agent log colorization (G-05)** — in `loadAgentLog()` post-processing, apply: dim `\x1b[2m` to ISO timestamp prefixes (`\d{4}-\d{2}-\d{2}T` or `[2026-` patterns); cyan `\x1b[36m` for `[bracket]` markers. Reset after each.

**Layout:**
- [x] **Scroll direction for top-anchored panes (G-08)** — define `TOP_ANCHORED_MODES = new Set(["DIFF", "ERRORS", "STATUS", "QUESTIONS"])`. In `RightPaneComponent.render()`, branch: top-anchored uses `scrollOffset` as start index from top (slice forward); bottom-anchored keeps existing scroll-back-from-bottom behavior.
- [x] **TREE pane prompt column (G-09)** — append truncated prompt to each TREE row: `agent.meta.prompt.replace(/\n/g, " ").slice(0, 40)`, respecting available width after agent ID, state, age, and model columns.

---

### Phase 11: Dialog Improvements -- COMPLETE
**Checkpoint:** Reassign uses a proper select list, send dialog supports broadcast to all agents.

Changes in `src/tui/dashboard.ts` dialog handling.

- [x] **Reassign select list** — replace the free-text input dialog for `r` (reassign) with a select list showing all valid managers (non-worker agents) plus a "(No parent - make root)" option. Filter out the agent being reassigned and its descendants (circular dependency prevention). Use the existing fuzzy select dialog infrastructure.
- [x] **Send-to-all toggle** — in the `s` (send) dialog, add a `Ctrl-A` key toggle for "send to all alive agents." When toggled on, show `[ALL]` indicator in the dialog. On confirm, iterate all non-archived agents with active tmux sessions and call `sendMessage()` for each.

---

### Phase 12A: Setup Dialog — Hooks & Status (Tab 0) -- COMPLETE
**Checkpoint:** `h` key opens a setup dialog showing hooks installation status with toggles. `?` key shows the read-only help overlay (moved from `h`).

This is the first half of the setup dialog — Tab 0 only. Self-contained and simpler than config editing.

Files: `src/tui/dashboard.ts`, `src/tui/agent-actions.ts`, `src/tui/dialog-handler.ts`.

**Prerequisites:**
- Move the current `h` help overlay to `?` key. Update the help text and keybinding reference.
- Reassign `h` to open the setup dialog.

**Tab 0 — Setup:**
- [x] **Hooks status display** — call `ib hooks status` (returns lines like `safety-hooks: installed` or `safety-hooks: not installed`). Parse output by splitting on `:` to get hook name and status. Render as a select list of rows, each showing hook name + installed/not-installed badge.
- [x] **Hooks toggle** — `Enter` on a hook row calls `ib hooks install` / `ib hooks uninstall` (or `install-intercept` / `uninstall-intercept` for task interception). Refresh status after toggle.
- [x] **Status indicators** — show read-only status rows for: `.gitignore` contains `.ittybitty` (check via `Bun.file("{repo}/.gitignore").text()` and search for `.ittybitty`), `.itsybitsy.json` exists (check via `Bun.file("~/.itsybitsy.json").exists()`), current `diffTool` value.
- [x] **External diff tool editing** — `Enter` on the diff tool row opens a text input dialog (using existing `input` dialog type) to set/change the value. Saves to `~/.itsybitsy.json` via registry.

**Dialog behavior:**
- Dialog captures all keyboard input while open (existing dialog infrastructure already does this — dialogs intercept `handleInput` before dashboard keys).
- `Escape` dismisses.
- Tab 0 is the only tab in this phase — tab switching UI is added in Phase 12B.

---

### Phase 12B: Setup Dialog — Config Editing (Tabs 1 & 2) -- COMPLETE
**Checkpoint:** Setup dialog has three tabs: Setup (Tab 0 from 12A), Project Settings, User Settings. Config values can be viewed and edited.

Files: `src/tui/dashboard.ts`, `src/config.ts`.

**`src/config.ts` module:**
- [x] `readConfig(repoPath)` — read `.ittybitty.json` from repo, merge with `~/.ittybitty.json` (user), apply defaults. Return `{ value, source: "project" | "user" | "default" }` for each key.
- [x] `writeConfig(filePath, key, value)` — read JSON, set key (supports dot-notation like `hooks.injectStatus`), write back.
- [x] Config key definitions with types: `{ key: string, type: "number" | "boolean" | "string" | "string[]", default: any }`. Full list: `maxAgents` (number, 10), `model` (string, "sonnet"), `fps` (number, 10), `createPullRequests` (boolean, false), `allowAgentQuestions` (boolean, true), `autoCompactThreshold` (number, none), `externalDiffTool` (string, none), `hooks.injectStatus` (boolean, true), `hooks.statusVisible` (boolean, true), `permissions.manager.allow` (string[], []), `permissions.manager.deny` (string[], []), `permissions.worker.allow` (string[], []), `permissions.worker.deny` (string[], []).

**Tab switching:**
- [x] Add tab bar at top of setup dialog: `[Setup] [Project] [User]`. Active tab is highlighted.
- [x] Switch tabs via `1`/`2`/`3` number keys. Left/right arrows also cycle tabs (these keys are free inside the dialog since dialogs capture all input).

**Tab 1 — Project Settings** (`.ittybitty.json`):
- [x] Render config keys as a select list. Each row: `key: value (source)`.
- [x] `Enter` on a row opens the appropriate editor based on type:
  - `number` → existing `input` dialog, validate numeric input
  - `boolean` → toggle immediately (no sub-dialog), re-render
  - `string` → existing `input` dialog
  - `string[]` → existing `select` dialog with options: "Add item" (opens `input`), "Remove item" (shows items as select list), "Back"
- [x] Write changes via `writeConfig()`.

**Tab 2 — User Settings** (`~/.ittybitty.json`):
- [x] Same rendering and editing as Tab 1, but reads/writes `~/.ittybitty.json`.

---

### Phase 13: Built-in Watchdog
**Checkpoint:** itsybitsy monitors all agents in-process, notifying managers of state changes, auto-compacting, and handling rate limits.

New file: `src/watchdog.ts`. This is the highest-complexity feature but also the highest-value for multi-agent reliability.

**Coexistence with bash watchdog:** Agents spawned via `ib new-agent` (which itsybitsy uses) automatically get a bash watchdog (`ib watchdog {id}` in background). The two watchdogs will coexist — both send notifications to managers, and duplicate notifications are harmless (managers already handle repeated messages). Long-term, if ib adds a `--no-watchdog` flag to `ib new-agent`, itsybitsy should pass it. For now, accept the duplication. Update the "Explicit Non-Goals" section to remove the `ib watchdog` line and note that Phase 13 replaces it.

**Core loop:**
- [ ] Run every 5 seconds (matching ib's watchdog poll interval) via `setInterval`.
- [ ] Track `previousState: Map<string, AgentState>` for all agents across all repos.
- [ ] On state transition, trigger the appropriate handler (see below).
- [ ] Consume agent state from `watcher.ts` (register a callback or read cached state) — no duplicate tmux captures.

**State handlers:**
- [ ] `waiting` / `unknown` → increment wait counter. After threshold, send notification to manager via `ib send {manager} "[watchdog]: Your subtask {id} recently started waiting for input"`. Use exponential backoff: 30s → 1m → 2m → 4m → 8m → 16m → 32m → 64m cap.
- [ ] `complete` → send one-time notification to manager: `"[watchdog]: Your subtask {id} recently completed"`. Track `completionNotified` flag; clear on resume.
- [ ] `running` / `creating` / `compacting` → reset wait counter and backoff interval. Clear completion flag if agent resumed.
- [ ] `rate_limited` → bypass the rate limit dialog by sending Enter to the tmux session: `tmux send-keys -t {tmux_session} Enter`. Check usage API (already in `usage.ts`). When session usage drops below 10%, send nudge to agent via `ib send`.
- [ ] `stopped` → reset counters, no notification.

**Auto-compact:**
- [ ] Read `autoCompactThreshold` from `.ittybitty.json` config (via `src/config.ts` from Phase 12B, or read directly if Phase 12B isn't done yet).
- [ ] Read agent context usage % from the Claude transcript file. Path pattern: `~/.claude/projects/{path-hash}/transcript.jsonl` where `{path-hash}` is the agent's worktree path with `/` replaced by `-`. Each line is a JSON object; look for `"type": "summary"` entries with a `"contextPercentage"` or `"costSoFar"` field. Port the parsing logic from ib's `get_agent_context_usage()` function (around line ~3200 in ib) which reads the last summary entry.
- [ ] When usage % exceeds threshold, send `/compact` to agent's tmux session via `tmux send-keys -t {session} "/compact" Enter`.
- [ ] Track `compactSent` flag per agent to avoid duplicate sends; clear when context drops below threshold or agent resumes.

**Dashboard integration:**
- [ ] Watchdog starts automatically with `itsybitsy watch`.
- [ ] Show `[watchdog]` indicator in footer when watchdog is active.

---

### Phase 14 (v2): Cross-Repo Messaging
**Checkpoint:** An agent in repo A can send a message to an agent in repo B from within itsybitsy.

**Protocol:** itsybitsy acts as a message broker. To send a message from agent A (repo X) to agent B (repo Y):
1. Look up agent B's tmux session from its `meta.json`
2. Call `sendMessage(repoY, agentB.id, message)` which shells to `ib send {id} "{message}"` with `cwd` set to repo Y

No new file format needed — reuses existing `ib send` infrastructure.

**Dialog flow for `E` key:**
- [ ] Step 1: Select destination repo (select list from registry, exclude current repo if only one agent)
- [ ] Step 2: Select destination agent (select list of non-archived agents in chosen repo)
- [ ] Step 3: Enter message (text input dialog)
- [ ] Execute: call `sendMessage()` with the destination repo's path
- [ ] No changes required to `ib` itself

---

### Phase 15 (future): Decoupled Agent Storage

**Status:** Aspirational / longer-term architectural change. Not yet planned for implementation.

**Current behavior:** itsybitsy reads agent data from `{repo}/.ittybitty/agents/` — the same directory structure that `ib` uses. This means itsybitsy and ib share agent state seamlessly.

**Proposed change:** When itsybitsy spawns new agents (via `ib new-agent`), store agent metadata files in `~/.itsybitsy/{repo-name}/agents/` instead of `{repo}/.ittybitty/agents/`.

**Motivation:**
- Decouples itsybitsy's agent data from the ib directory structure — itsybitsy could evolve its metadata format independently.
- Keeps agent data out of the repo tree entirely — no `.gitignore` management, no accidental commits.
- Enables itsybitsy-specific metadata (cross-repo references, custom tags, UI state) without polluting ib's directory.
- Centralizes all itsybitsy state under `~/.itsybitsy/` (alongside the existing `~/.itsybitsy.json` registry).
- Note: none of these benefits are currently blocking — they are speculative advantages for future flexibility.

**Tradeoffs:**
- **Breaks compatibility with plain `ib` commands.** If agent files live in `~/.itsybitsy/`, then `ib list`, `ib look`, `ib status`, etc. won't find them (ib reads from `{repo}/.ittybitty/agents/`). This would require either (a) changes to ib to support an alternate agent directory, or (b) itsybitsy maintaining symlinks/mirrors.
- **Dual-source complexity.** During migration, itsybitsy would need to read from both locations. Agents spawned by `ib` directly (outside itsybitsy) would still live in `.ittybitty/`.
- **Watchdog/hooks break.** ib's hooks (`agent-path`, `agent-status`) and watchdog assume the `.ittybitty/agents/` layout. Moving metadata requires updating hook paths.
- **Two users of the same data.** If both ib and itsybitsy need to read/write agent state, having two locations creates synchronization issues.
- **Multi-machine divergence.** If a user runs itsybitsy on two machines (e.g., desktop + laptop), `~/.itsybitsy/` would diverge between them. The current `.ittybitty/` approach naturally syncs via git.
- **Cache invalidation.** A read-only mirror approach (`~/.itsybitsy/{repo}/` as cache) introduces its own sync problems — when does the mirror update? What if ib modifies agent state between mirror syncs? This is a classic cache invalidation problem.

**Prerequisite:** This change only makes sense after itsybitsy has its own built-in watchdog (Phase 13) and no longer depends on ib's watchdog. Even then, it requires coordination with ib's codebase.

**Recommendation:** Keep using `{repo}/.ittybitty/agents/` for now. Revisit after Phases 13–14 are complete and itsybitsy has proven itself as a standalone daily driver. If pursued, start with a read-only mirror (`~/.itsybitsy/{repo}/` as a cache/index of `.ittybitty/agents/`) before attempting a full migration, but be aware of cache invalidation challenges.

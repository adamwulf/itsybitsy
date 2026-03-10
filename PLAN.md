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
│   │                         # AgentState, FlatEntry; tree building; detectAgentStates();
│   │                         # reads user-questions.json; returns structured errors
│   ├── agents.test.ts        # Agent data layer tests
│   ├── parse-state.ts        # Port of ib's parse_state bash logic → TypeScript
│   ├── parse-state.test.ts   # State detection tests
│   ├── usage.ts              # Fetches Claude API quota from Anthropic OAuth API;
│   │                         # caches at ~/.claude/usage-cache.json (10s TTL)
│   ├── usage.test.ts         # Usage fetch/parse tests
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

- [x] `src/agents.ts` — read `.ittybitty/agents/` and `archive/`; `Agent`, `AgentState`, `FlatEntry` types; `readPendingQuestions()`; `detectAgentStates()`; `computeAge()`; structured error reporting
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
- [x] ~~**Update notification**~~ — Removed. The npm registry checker returned false positives from an unrelated package. A GitHub releases checker will replace it in a future phase.

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

### Phase 13: Code Quality & Architecture Cleanup
**Checkpoint:** Codebase is clean, internally consistent, and free of known architectural hacks identified in the code review.

**FlatEntry discriminated union refactor:** *(completed)*
- [x] Replace the `__repo_<name>` dummy Agent hack with a proper discriminated union type:
  ```ts
  type FlatEntry =
    | { kind: "agent"; agent: Agent; depth: number; connector: string }
    | { kind: "repo-header"; repoName: string; repoPath: string; hasAgents: boolean }
  ```
- [x] Update `flattenAgentTree()` in `src/agents.ts` to return `FlatEntry[]`
- [x] Update all consumers: `agent-tree.ts`, `pane-manager.ts`, `dashboard.ts`, `agent-actions.ts`, `index.ts` — branch on `kind` instead of checking `repoHeader`
- [x] Remove the dummy Agent construction in `flattenAgentTree` — no more fake meta.json fields

**Remaining review items:**
- [ ] Add tests for `readAccessToken` keychain fallback path (`src/usage.ts`)
- [ ] Add tests for `color-scheme.ts` OSC 11 query and Ghostty mode 2031 detection
- [x] Add tests for `folder-browser.ts` permission error path

---

### Phase 14: CLI Parity — Native Implementations -- COMPLETE
**Checkpoint:** All `itsybitsy` CLI commands are implemented natively without shelling to `ib`. itsybitsy can fully replace `ib` for day-to-day agent management.

All commands now implemented natively in `src/ib-commands.ts` with shared helpers in `src/agent-lifecycle.ts`:
- [x] **`send <id> <message>`** — direct tmux send-keys with delay calculation, sender auto-detection, logging
- [x] **`kill <id>`** — teardown sequence: kill process, kill tmux, copy settings, remove worktree/branch, archive, cleanup
- [x] **`pause <id>`** — kill process + tmux, preserve agent dir/worktree for resume
- [x] **`resume <id>`** — create resume.sh, spawn tmux session, auto-accept trust, send nudge
- [x] **`nuke [id]`** — teardown agent + descendants (or all), cleanup orphaned sessions
- [x] **`merge <id>`** — pre-rebase conflict check, rebase, merge (ff-only or no-ff), teardown
- [x] **`new-agent <prompt>`** — full agent creation: worktree, meta.json, prompt.txt, start.sh, exit-check.sh, settings, tmux, hooks

658 tests across 19 files. Injectable spawn runners for testability (SpawnFn pattern).

### Phase 14.1: Fix Flaky Test
**Checkpoint:** All tests are deterministic with zero flaky failures.

- [ ] Investigate intermittent test failure: 657 pass / 1 fail (observed ~1 in 6 runs). The failure shows in the summary line but the specific failing test name is not captured in output. Likely a timing-sensitive test in the new Phase 14 native implementations — possibly related to `Bun.sleep` delays, temp directory cleanup races, or mock spawn runner state leaking between tests. Steps:
  1. Run `bun test` in a loop (10+ iterations) to reliably reproduce
  2. Identify the specific test that fails
  3. Fix the root cause (likely needs test isolation improvement or removing timing dependency)

---

### Phase 15: Built-in Watchdog
**Checkpoint:** itsybitsy monitors all agents in-process, notifying managers of state changes, auto-compacting, and handling rate limits.

New file: `src/watchdog.ts`. This is the highest-complexity feature but also the highest-value for multi-agent reliability.

**Coexistence with bash watchdog:** Agents spawned via `ib new-agent` (which itsybitsy uses) automatically get a bash watchdog (`ib watchdog {id}` in background). The two watchdogs will coexist — both send notifications to managers, and duplicate notifications are harmless (managers already handle repeated messages). Long-term, if ib adds a `--no-watchdog` flag to `ib new-agent`, itsybitsy should pass it. For now, accept the duplication. Update the "Explicit Non-Goals" section to remove the `ib watchdog` line and note that Phase 13 replaces it.

**Core loop:**
- [x] Run every 5 seconds (matching ib's watchdog poll interval) via `setInterval`.
- [x] Track `previousState: Map<string, AgentState>` for all agents across all repos.
- [x] On state transition, trigger the appropriate handler (see below).
- [x] Consume agent state from `watcher.ts` (register a callback or read cached state) — no duplicate tmux captures.

**State handlers:**
- [x] `waiting` / `unknown` → increment wait counter. After threshold, send notification to manager via `ib send {manager} "[watchdog]: Your subtask {id} recently started waiting for input"`. Use exponential backoff: 30s → 1m → 2m → 4m → 8m → 16m → 32m → 64m cap.
- [x] `complete` → send one-time notification to manager: `"[watchdog]: Your subtask {id} recently completed"`. Track `completionNotified` flag; clear on resume.
- [x] `running` / `creating` / `compacting` → reset wait counter and backoff interval. Clear completion flag if agent resumed.
- [x] `rate_limited` → bypass the rate limit dialog by sending Enter to the tmux session: `tmux send-keys -t {tmux_session} Enter`. Check usage API (already in `usage.ts`). When session usage drops below 10%, send nudge to agent via `ib send`.
- [x] `stopped` → reset counters, no notification.

**Auto-compact:**
- [x] Read `autoCompactThreshold` from `.ittybitty.json` config (via `src/config.ts` from Phase 12B, or read directly if Phase 12B isn't done yet).
- [x] Read agent context usage % from the Claude transcript file. Path pattern: `~/.claude/projects/{path-hash}/transcript.jsonl` where `{path-hash}` is the agent's worktree path with `/` replaced by `-`. Each line is a JSON object; look for `"type": "summary"` entries with a `"contextPercentage"` or `"costSoFar"` field. Port the parsing logic from ib's `get_agent_context_usage()` function (around line ~3200 in ib) which reads the last summary entry.
- [x] When usage % exceeds threshold, send `/compact` to agent's tmux session via `tmux send-keys -t {session} "/compact" Enter`.
- [x] Track `compactSent` flag per agent to avoid duplicate sends; clear when context drops below threshold or agent resumes.

**Dashboard integration:**
- [x] Watchdog starts automatically with `itsybitsy watch`.
- [x] Show `[watchdog]` indicator in footer when watchdog is active.

---

### Phase 16 (v2): Cross-Repo Messaging
**Checkpoint:** An agent in repo A can send a message to an agent in repo B from within itsybitsy.

**Protocol:** itsybitsy acts as a message broker. To send a message from agent A (repo X) to agent B (repo Y):
1. Look up agent B's tmux session from its `meta.json`
2. Call `sendMessage(repoY, agentB.id, message)` which shells to `ib send {id} "{message}"` with `cwd` set to repo Y

No new file format needed — reuses existing `ib send` infrastructure.

**Dialog flow for `E` key:**
- [x] Step 1: Select destination repo (select list from registry, exclude current repo if only one agent)
- [x] Step 2: Select destination agent (select list of non-archived agents in chosen repo)
- [x] Step 3: Enter message (text input dialog)
- [x] Execute: call `sendMessage()` with the destination repo's path
- [x] No changes required to `ib` itself

---

### Phase 18: Wire CLI Commands to Native Implementations
**Checkpoint:** All `itsybitsy` CLI subcommands (send, kill, merge, resume, new-agent, acknowledge) call native TypeScript implementations instead of shelling to `ib`. The `runIb()` function in `index.ts` is deleted.

This is the lowest-hanging fruit — native implementations already exist in `ib-commands.ts` for send, kill, merge, resume, and new-agent. Only `acknowledge` needs a new native implementation.

**18a: Wire existing native implementations into CLI (items 12–16 from audit)**

Files: `src/index.ts`, `src/ib-commands.ts`

- [ ] **`send` command** (index.ts:307–315) — replace `runIb(["send", ...])` with direct call to `sendMessage(agent, message)` from `ib-commands.ts`. Print result, exit with appropriate code.
- [ ] **`kill` command** (index.ts:318–323) — replace `runIb(["kill", ...])` with `killAgent(agent)`. Parse `--force` flag from `extraArgs`. Print result.
- [ ] **`merge` command** (index.ts:327–331) — replace `runIb(["merge", ...])` with `mergeAgent(agent, { force: extraArgs.includes("--force") })`. Print result.
- [ ] **`resume` command** (index.ts:335–339) — replace `runIb(["resume", ...])` with `resumeAgent(agent)`. Print result.
- [ ] **`new-agent` command** (index.ts:343–377) — replace `runIb(["new-agent", ...])` with `newAgent(repoPath, prompt, opts)`. Parse CLI args into `NewAgentOptions`: `--worker`, `--model`, `--name`, `--no-worktree`, `--yolo`, `--allow`, `--deny`. Print the returned agent ID.

**18b: Native acknowledge implementation (item 17 from audit)**

Files: `src/ib-commands.ts`, `src/index.ts`

- [ ] **`acknowledgeQuestion(repoPath, questionId)`** — implement natively:
  1. Read `{repoPath}/.ittybitty/user-questions.json`
  2. Find the question entry matching `questionId`
  3. If not found, return error
  4. Set `acknowledged: true` and `acknowledged_at: ISO timestamp` on the question entry
  5. Write back the JSON file
  6. Return `{ ok: true, agentId }` so the caller can suggest `itsybitsy send <agent> "answer"`
- [ ] Wire `acknowledge`/`ack` CLI command to call the native implementation instead of `runIb()`

**18c: Remove `runIb()` from index.ts**

- [ ] Delete the `runIb()` function from `index.ts` — it should have zero callers after 18a+18b
- [ ] Verify no other imports of `runIb` exist in the codebase

**Tests:**
- [ ] Unit tests for `acknowledgeQuestion()`: happy path, question-not-found, malformed JSON
- [ ] Integration-style tests verifying CLI argument parsing maps correctly to native function calls (mock the native functions, verify args)

---

### Phase 19: Native TUI Wrappers — reassign, mergeCheck, diff, status, acknowledge
**Checkpoint:** All TUI dashboard wrappers in `ib-commands.ts` call native TypeScript code instead of `runIb()`. The `defaultRunner` / `currentRunner` / `runIb` infrastructure in `ib-commands.ts` is deleted.

**19a: Native `reassignAgent()` (item 1 from audit)**

Files: `src/ib-commands.ts`, `src/agent-lifecycle.ts`

The reassign logic (from ib bash `do_reassign`):
1. Validate agent exists
2. Validate new parent exists and is not a worker
3. Check for circular dependency (new parent is not a descendant of agent)
4. Check for no-op (already has this parent, or already root)
5. Update `manager` field in `meta.json` (set to new parent ID, or `null` for --none)
6. Log the change to `agent.log`
7. Notify old parent, new parent, and agent itself via `sendMessage()`

- [ ] Implement `reassignAgent(agent, newManager)` natively in `ib-commands.ts`:
  - Read meta.json to get old parent
  - Validate new parent: resolve partial ID, check exists, check not worker, check not descendant (use `getDescendantsRecursive` from `agent-lifecycle.ts`)
  - Update meta.json `manager` field using `Bun.write()`
  - Log via `logAgent()`
  - Send notifications to old parent, new parent, and agent via `sendMessage()`
- [ ] Remove the `runIb(["reassign", ...])` call

**19b: Native `mergeCheckAgent()` (item 2 from audit)**

Files: `src/ib-commands.ts`

The merge-check logic (from ib bash `do_merge_check`):
1. Determine target branch (current branch if agent context, else main/master)
2. Check for uncommitted changes in current directory
3. Check for uncommitted changes in agent's worktree
4. Check if agent branch exists
5. Run `checkRebaseConflicts()` (already implemented natively in ib-commands.ts!)

- [ ] Implement `mergeCheckAgent(agent)` natively:
  - Determine target branch using git commands
  - Check uncommitted changes via `git status --porcelain`
  - Check agent branch exists via `git show-ref`
  - Call existing `checkRebaseConflicts()` for conflict detection
  - Return structured result: `{ status: "ok" | "main_uncommitted" | "agent_uncommitted" | "no_branch" | "conflicts", details?: string }`
- [ ] Remove the `runIb(["merge-check", ...])` call

**19c: Native `diffAgent()` and `statusAgent()` (items 3–4 from audit)**

Files: `src/ib-commands.ts`

These are straightforward — the CLI already implements them natively in `index.ts:257` and `index.ts:284`. The TUI wrappers just need the same logic.

- [ ] **`diffAgent(agent)`** — implement natively:
  1. Get agent worktree path via `agentWorktreePath(agent)`
  2. Run `git merge-base HEAD main` in the worktree
  3. Run `git diff {merge-base}` in the worktree
  4. Return stdout as the diff content
- [ ] **`statusAgent(agent)`** — implement natively:
  1. Get agent worktree path
  2. Run `git log --oneline main..HEAD` in the worktree
  3. Run `git status --short` in the worktree
  4. Return combined stdout

- [ ] Remove the `runIb(["diff", ...])` and `runIb(["status", ...])` calls

**19d: Remove `runIb` infrastructure from ib-commands.ts**

- [ ] Delete `defaultRunner`, `currentRunner`, `setRunner()`, `resetRunner()`, and the `runIb()` helper
- [ ] Update any remaining tests that mock `setRunner()` — they should mock the specific spawn runners instead
- [ ] Verify zero references to `runIb` remain in the codebase

**Tests:**
- [ ] `reassignAgent()`: happy path, circular dependency detection, worker-as-parent rejection, same-parent no-op, agent-not-found
- [ ] `mergeCheckAgent()`: clean merge, uncommitted changes (both sides), conflict detection, missing branch
- [ ] `diffAgent()` / `statusAgent()`: basic output capture, worktree-not-found handling

---

### Phase 20: Standalone Watchdog — `itsybitsy watchdog` Background Process
**Checkpoint:** Spawning an agent always launches a watchdog. `itsybitsy watchdog` runs as a standalone background process that reads agents directly from disk — no TUI required. `newAgent()` spawns `itsybitsy watchdog` instead of `ib watchdog {id}`.

Files: `src/ib-commands.ts`, `src/watchdog.ts`, `src/index.ts`

**Architectural principle: `itsybitsy watch` is for humans, not for functionality.**

`itsybitsy watch` (the TUI dashboard) is a UI for the human operator to observe and interact with agents. It is entirely optional — closing it does NOT stop agent monitoring. All functional work (watchdog, hooks, agent lifecycle) happens in background processes that run whether or not the TUI is open.

The standalone `itsybitsy watchdog` process is the **only** watchdog. It reads agents directly from disk on every tick using `readAllAgents()` + `detectAgentStates()` — no TUI dependency. The TUI's only watchdog-related jobs are:
1. Check the lock file and show the `[watchdog]` status indicator if one is running
2. Optionally spawn `itsybitsy watchdog` as a convenience if none is running when the TUI opens

Phase 15-D's TUI integration (`startWatchdog()`/`stopWatchdog()` inline in the TUI process) will be removed as part of this phase. `isWatchdogRunning()` will read the lock file instead of checking module-level state.

**Design: Idempotency via lock file**

Multiple `itsybitsy watchdog` processes (one spawned by each `newAgent()` call, plus one from the TUI) would be wasteful. Use a lock file at `~/.itsybitsy/watchdog.lock` containing the PID. On startup, check if the PID in the lock file is still alive — if so, exit immediately (already covered). If not, write own PID and proceed. On exit, remove the lock file.

**20a: Standalone agent provider**

Files: `src/watchdog.ts`

- [ ] Export `createDiskAgentProvider(registryPath: string): AgentProvider` — a function that, on each call, reads all repos from the registry, calls `readAllAgents()` on each, calls `detectAgentStates()` on the result, and returns the combined flat agent list. This is the standalone watchdog's provider.
- [ ] Add tests for `createDiskAgentProvider()` with mocked `readAllAgents` and `detectAgentStates`.

**20b: Lock file management**

Files: `src/watchdog.ts`

- [ ] Export `acquireWatchdogLock(): boolean` — writes `~/.itsybitsy/watchdog.lock` with current PID. Returns `true` if acquired (either no existing lock, or existing PID is dead). Returns `false` if another watchdog is already running.
- [ ] Export `releaseWatchdogLock(): void` — removes the lock file if it contains our PID.
- [ ] Add process exit handlers to call `releaseWatchdogLock()` on SIGTERM/SIGINT/exit.
- [ ] Add tests for lock acquire/release, stale PID handling.

**20c: `itsybitsy watchdog` CLI command**

Files: `src/index.ts`

- [ ] Add `watchdog` subcommand to the CLI switch statement.
- [ ] On invocation: call `acquireWatchdogLock()` — if returns `false`, print "watchdog already running" and exit 0.
- [ ] Read registry path, call `startWatchdog(createDiskAgentProvider(registryPath))`.
- [ ] Keep the process alive (no `process.exit()` — let the setInterval hold the event loop).
- [ ] Register cleanup: on SIGTERM/SIGINT, call `stopWatchdog()`, `releaseWatchdogLock()`, exit 0.

**20d: Replace `ib watchdog` spawn in `newAgent()`**

Files: `src/ib-commands.ts`

- [ ] Replace `Bun.spawn(["ib", "watchdog", id], ...)` with `Bun.spawn(["itsybitsy", "watchdog"], { cwd: rootRepoPath, stdout: Bun.file(watchdogLog), stderr: Bun.file(watchdogLog) })` — note: no agent ID argument since our watchdog is global.
- [ ] Call `.unref()` on the spawned process so it doesn't prevent the parent from exiting.
- [ ] The spawned process will self-terminate immediately if a watchdog is already running (lock file check in 20b).

**Tests:**
- [ ] `newAgent()` spawns `itsybitsy watchdog`, not `ib watchdog`
- [ ] `acquireWatchdogLock()` returns false when lock is held by a live PID
- [ ] `acquireWatchdogLock()` returns true when lock PID is dead (stale lock)
- [ ] `itsybitsy watchdog` CLI exits cleanly if already running
- [ ] Existing watchdog tests still pass

---

### Phase 21: Native Agent Hooks — itsybitsy Subcommands
**Checkpoint:** Agent settings reference `itsybitsy hook-*` commands instead of `ib hook-*`. Each hook is implemented as an itsybitsy CLI subcommand.

This is the most complex phase. Agent hooks run inside spawned agent tmux sessions — they are invoked by Claude Code's hook system, not by itsybitsy itself. Currently they call `ib hook-check-path`, `ib hook-status`, `ib hook-permission-denied`, `ib hooks intercept-task`, and `ib hooks session-start`.

**Phase 21 can run in parallel with Phases 18–20** since it touches the hook command implementations (new CLI subcommands) rather than the TUI/CLI wiring.

**21a: `itsybitsy hook-check-path <agent-id>` (PreToolUse path isolation)**

Files: `src/index.ts`, new `src/hooks/agent-path.ts`

This hook enforces agent path isolation — prevents agents from accessing files outside their worktree. It reads JSON from stdin (Claude Code's PreToolUse hook format) and outputs a JSON permission decision.

Implementation:
- [ ] Read JSON from stdin: `{ tool_name, tool_input, cwd }`
- [ ] Resolve agent's worktree path from `{agents_dir}/{id}/repo`
- [ ] Resolve root repo path via `git worktree list --porcelain`
- [ ] Read agent's `meta.json` for `worker` flag
- [ ] Read agent's `settings.local.json` for `permissions.allow` list
- [ ] Decision logic (port from ib's `check_pretooluse_access()`):
  1. Block `TaskCreate` with role-specific message
  2. Check if tool is in allow list (pattern matching)
  3. For `Bash` tool: extract cd target, check path
  4. Extract `file_path` or `path` from `tool_input`
  5. Resolve to absolute path using `cwd`
  6. Allow: path within worktree, path is own agent.log
  7. Block: path in other agents' directories
  8. Block: path in main repo (outside worktree)
  9. Allow: all other paths (system files, ~/.claude, etc.)
- [ ] Output JSON: `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow"|"deny", permissionDecisionReason: "..." } }`
- [ ] Log denials to `agent.log` via `logAgent()`
- [ ] Wire as `hook-check-path` subcommand in `src/index.ts`

**21b: `itsybitsy hook-status <agent-id>` (Stop hook — agent nudging)**

Files: `src/index.ts`, new `src/hooks/agent-status.ts`

This hook fires when Claude stops generating. It detects the agent's state and takes action: nudge idle agents, notify managers of completion/waiting, remind about uncommitted changes.

Implementation:
- [ ] Read Stop hook JSON from stdin: `{ last_assistant_message, stop_hook_active, ... }`
- [ ] Detect state from `last_assistant_message` first (more reliable than tmux):
  - Last non-empty line is `"WAITING"` → `waiting`
  - Last non-empty line is `"I HAVE COMPLETED THE GOAL"` → `complete`
  - Otherwise → fall through to tmux-based detection
- [ ] Fall back to tmux-based state detection via `parseState()` from `src/parse-state.ts`
- [ ] Save debug capture to `{agent_dir}/debug-logs/stop-{timestamp}-{state}.txt`
- [ ] State-specific actions:
  - `rate_limited` → skip (watchdog handles this)
  - `running` with background tasks (`⏵⏵` in footer) → skip
  - `unknown` or `running` → debounce (5s), send nudge: "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line."
  - `complete`:
    - Check for uncommitted changes → remind to commit
    - Worker with manager → notify manager: `[hook]: Your subtask {id} just completed`
    - Manager without unfinished children → no action
    - Manager with unfinished children → remind about unmerged sub-agents
  - `waiting` with manager → notify manager: `[hook]: Your subtask {id} is now waiting for input`
- [ ] Wire as `hook-status` subcommand in `src/index.ts`

**21c: `itsybitsy hook-permission-denied <agent-id>` (PermissionRequest logging)**

Files: `src/index.ts`, new `src/hooks/permission-denied.ts`

This hook fires when Claude requests permission for a tool that isn't auto-allowed. In ib bash, this command doesn't have its own implementation — it falls through to the help text (essentially a no-op). The PermissionRequest hook is set up but the actual permission enforcement happens via PreToolUse (`hook-check-path`).

Implementation:
- [ ] Read PermissionRequest JSON from stdin
- [ ] Log the denied tool request to `agent.log`
- [ ] Exit 0 (no permission decision needed — PermissionRequest hooks can't override permissions)
- [ ] Wire as `hook-permission-denied` subcommand in `src/index.ts`

**21d: `itsybitsy hooks intercept-task` (PreToolUse Task interception)**

Files: `src/index.ts`, new `src/hooks/intercept-task.ts`

This hook intercepts Claude's native `Task` tool calls and redirects them to spawn ib/itsybitsy agents instead.

Implementation:
- [ ] Read PreToolUse JSON from stdin: `{ tool_name, tool_input, cwd }`
- [ ] Skip if not `Task` tool (exit 0)
- [ ] Skip if called from a worker agent (check meta.json `worker` flag)
- [ ] Skip if `subagent_type` is in skip list: `Bash`, `statusline-setup`, `claude-code-guide`, `meta-agent`, `ib-merge`
- [ ] Extract `prompt`, `description`, `model` from `tool_input`
- [ ] Validate model (only allow `sonnet`, `opus`, `haiku`, empty)
- [ ] Spawn real agent via `newAgent()` with `--worker` flag
- [ ] Return `permissionDecision: "allow"` with `updatedInput` that transforms the Task into a lightweight `claude-code-guide` stub (reports the spawned agent ID back to the caller)
- [ ] Wire as `hooks intercept-task` subcommand in `src/index.ts` (note: this is a nested subcommand under `hooks`)

**21e: `itsybitsy hooks session-start` (SessionStart context injection)**

Files: `src/index.ts`, new `src/hooks/session-start.ts`

This hook outputs role-specific ittybitty instructions when a Claude Code session starts.

Implementation:
- [ ] Read SessionStart JSON from stdin: `{ cwd, ... }`
- [ ] Detect role from `cwd`:
  - Not in agent worktree → `primary`
  - In agent worktree, `worker=false` in meta.json → `manager`
  - In agent worktree, `worker=true` in meta.json → `worker`
- [ ] Generate role-specific instructions (port `get_ittybitty_instructions()` from ib bash)
- [ ] Output JSON: `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }`
- [ ] Wire as `hooks session-start` subcommand in `src/index.ts`

**Tests:**
- [ ] `hook-check-path`: allow within worktree, block outside worktree, block other agents, allow system paths, cd command extraction, TaskCreate denial
- [ ] `hook-status`: state detection from message text, nudge debouncing, manager notification for complete/waiting, uncommitted changes reminder
- [ ] `hook-permission-denied`: basic logging, JSON parsing
- [ ] `intercept-task`: skip non-Task tools, skip workers, skip list bypass, agent spawning
- [ ] `session-start`: role detection (primary/manager/worker), correct output format

---

### Phase 22: Update Agent Settings to Use itsybitsy Hooks
**Checkpoint:** `buildAgentSettings()` writes `itsybitsy hook-*` commands instead of `ib hook-*` into agent settings. Agent permissions include `Bash(itsybitsy:*)` instead of `Bash(ib:*)`.

**Depends on:** Phase 21 (hooks must exist before agents reference them)

Files: `src/ib-commands.ts`

**22a: Update hook commands in `buildAgentSettings()`**

- [ ] Change `ib hook-check-path ${agentId}` → `itsybitsy hook-check-path ${agentId}` (line 1148)
- [ ] Change `ib hooks intercept-task` → `itsybitsy hooks intercept-task` (line 1152)
- [ ] Change `ib hook-status ${agentId}` → `itsybitsy hook-status ${agentId}` (line 1163)
- [ ] Change `ib hook-permission-denied ${agentId}` → `itsybitsy hook-permission-denied ${agentId}` (line 1144, 1164)
- [ ] Change `ib hooks session-start` → `itsybitsy hooks session-start` (line 1166)

**22b: Update permissions**

- [ ] Change `"Bash(ib:*)", "Bash(./ib:*)"` → `"Bash(itsybitsy:*)"` in agent permissions (line 1102–1103)
- [ ] Change `"Bash(ib:*)"` → `"Bash(itsybitsy:*)"` in root repo settings (line 1372–1382)

**22c: Update PATH exports in startup scripts**

- [ ] In `start.sh` template (line 1528–1530): change `export PATH="${rootRepoPath}:$PATH"` comment from "so 'ib' is available" to "so 'itsybitsy' is available". Ensure itsybitsy binary location is on PATH. If itsybitsy is installed globally (e.g., via `bun link`), no PATH change needed. If running from source, add the project's bin directory.
- [ ] In `resumeAgent()` resume.sh template (line 418): same PATH update.

**Tests:**
- [ ] Verify `buildAgentSettings()` output contains `itsybitsy` commands, not `ib` commands
- [ ] Verify permissions include `Bash(itsybitsy:*)` and not `Bash(ib:*)`
- [ ] Update existing tests that assert on hook command strings

---

### Phase 23: Native Hooks Management
**Checkpoint:** The TUI setup dialog manages hooks natively without shelling to `ib hooks`. The `ib` startup guard is removed.

**Depends on:** Phase 19d (runIb infrastructure removed)

Files: `src/ib-commands.ts`, `src/index.ts`

**23a: Native hooks management functions (items 6–11 from audit)**

These functions manage hooks in the main repo's `.claude/settings.local.json` — they read/write JSON to add or remove hook entries.

- [ ] **`hooksStatus(repoPath)`** — implement natively:
  1. Read `{repoPath}/.claude/settings.local.json`
  2. Check for main-path hook (PreToolUse entry blocking cd into agent worktrees)
  3. Check for status hooks (UserPromptSubmit/PostToolUse status injection)
  4. Check for session-start hook (SessionStart entry)
  5. Return `"installed"` (all present), `"partial"` (some present), or `"not-installed"` (none)
- [ ] **`interceptHooksStatus(repoPath)`** — check for intercept-task hook in PreToolUse entries. Return `"installed"` or `"not-installed"`.
- [ ] **`installSafetyHooks(repoPath)`** — read settings JSON, add missing hooks (main-path, status, session-start), write back. Use `itsybitsy hooks *` commands instead of `ib hooks *` in the hook command strings.
- [ ] **`uninstallSafetyHooks(repoPath)`** — read settings JSON, remove all ib/itsybitsy hook entries, write back.
- [ ] **`installInterceptHook(repoPath)`** — add `intercept-task` PreToolUse entry.
- [ ] **`uninstallInterceptHook(repoPath)`** — remove `intercept-task` PreToolUse entry.

**23b: Remove startup guard (item 26 from audit)**

- [ ] Remove `Bun.which("ib")` check from `index.ts:90–92` — itsybitsy should work without ib on PATH
- [ ] Keep the `Bun.which("tmux")` check — tmux is still required

**Tests:**
- [ ] `hooksStatus()`: all installed, partial, none installed
- [ ] `installSafetyHooks()` / `uninstallSafetyHooks()`: adds/removes correct JSON entries, idempotent
- [ ] `installInterceptHook()` / `uninstallInterceptHook()`: adds/removes intercept-task entry
- [ ] Startup without ib on PATH succeeds

---

### Phase 24: Final Cleanup & Validation
**Checkpoint:** Zero runtime references to `ib` CLI. itsybitsy is 100% self-contained. All tests pass.

**Depends on:** All previous phases (18–23)

Files: all

**24a: Audit and remove all remaining `ib` references**

- [ ] Search entire codebase for `"ib"` string in runtime code paths (exclude comments, test descriptions, PLAN.md, CLAUDE.md)
- [ ] Verify zero calls to `Bun.spawn(["ib", ...])` exist
- [ ] Verify zero calls to `runIb()` exist
- [ ] Verify `Bun.which("ib")` is not called anywhere

**24b: Update documentation and comments**

- [ ] Update `src/ib-commands.ts` module-level comment (line 1–4): remove "others delegate to ib CLI"
- [ ] Update CLAUDE.md non-goals section: remove ib watchdog reference, note full self-containment
- [ ] Update PLAN.md architecture section: remove "Mutations: shell out to `ib` commands" — all mutations are native now
- [ ] Update agent-facing text: any `ib merge`, `ib kill`, `ib send` references in prompts/messages should use `itsybitsy` (but keep backward compatibility — agents can use either if both are on PATH)

**24c: End-to-end validation**

- [ ] Run full test suite: `bun test` — all tests pass
- [ ] Run `bunx tsc --noEmit` — zero TypeScript errors
- [ ] Manual smoke test: spawn agent via `itsybitsy new-agent`, verify hooks fire correctly, verify watchdog monitors agent, kill agent, verify cleanup
- [ ] Test with `ib` removed from PATH: dashboard launches, agents spawn, hooks work, merge/kill/resume work

**Tests:**
- [ ] Add an integration test that asserts no `["ib"` string appears in spawn calls across all source files (grep-based test)

---

### Parallelism Notes for Phases 18–24

The following phases can run in parallel:
- **Phase 18** (CLI wiring) and **Phase 19** (TUI wrappers) are independent — they touch different call sites
- **Phase 20** (watchdog spawn) is independent of 18 and 19
- **Phase 21** (hook implementations) is independent of 18, 19, 20 — it adds new CLI subcommands

Sequential dependencies:
- **Phase 22** depends on **Phase 21** (hooks must exist before settings reference them)
- **Phase 23** depends on **Phase 19d** (runIb removal) but can start in parallel with Phase 22
- **Phase 24** depends on all previous phases

Recommended execution order:
```
Phase 18 ──┐
Phase 19 ──┤
Phase 20 ──┼── all in parallel
Phase 21 ──┘
               ↓
Phase 22 ──┐
Phase 23 ──┼── in parallel (22 depends on 21, 23 depends on 19d)
               ↓
Phase 24 ──── final validation (depends on all)
```

---

### Phase 26: Binary Distribution & Hook Wiring Fixes

**Status:** In progress (agents running as of 2026-03-09)

**Goal:** Make `ib` (the compiled bun binary) a complete drop-in replacement for the bash `ib` script. Discovered during initial binary testing that several hook subcommands were missing, making hooks non-functional in the binary.

#### 26a: Compile to Binary (complete)
- [x] `bun build --compile --minify --sourcemap index.ts --outfile ib` produces standalone binary
- [x] Added `ib` and `index.js.map` to `.gitignore`
- [x] Updated CLAUDE.md build instructions (outfile: `ib`, not `itsybitsy`)
- [x] PATH set to project directory in `~/.bash_profile`

#### 26b: Missing CLI Commands (agent-b403bd1f)
The following commands existed in `ib-commands.ts` but were NOT wired as CLI cases in `index.ts`:
- [ ] `ib hooks main-path` — PreToolUse path isolation hook (reads `IB_AGENT_ID` from env)
- [ ] `ib hooks inject-status [--full] [--if-changed] [--visible]` — status injection hook (reads `IB_AGENT_ID` from env)
- [ ] `ib hooks install` / `uninstall` / `status` — safety hook management
- [ ] `ib hooks intercept-install` / `intercept-uninstall` / `intercept-status` — intercept hook management
- [ ] `ib nuke <id>` — kill + archive agent
- [ ] `ib merge-check <id>` — check for merge conflicts
- [ ] `ib acknowledge` (rename from `ib ack` as primary)

**Root cause of permission prompts:** When hooks fired `ib hooks main-path` against the bun binary, it exited 1 ("Unknown hooks subcommand"), causing Claude Code to fall back to prompting.

**Key finding from bash ib audit:** `cmd_hooks_main_path` in bash ib does NOT use `IB_AGENT_ID` — it only blocks `cd` into `.ittybitty/agents/*/repo` paths. Our bun version is more comprehensive (full per-agent path isolation). For the `IB_AGENT_ID` undefined case (primary Claude session), bun version should exit 0 and allow default behavior.

#### 26c: Global Hook Installation (agent-a0294830)
- [ ] Change `installSafetyHooks`, `uninstallSafetyHooks`, `hooksStatus`, `installInterceptHook`, `uninstallInterceptHook`, `interceptHooksStatus` to write to `~/.claude/settings.json` instead of `<repoPath>/.claude/settings.local.json`
- [ ] Add optional `settingsPath` parameter for test overrides
- [ ] Hooks installed globally apply to all Claude sessions for the user

#### 26d: Documentation & Messaging (agents -4abedf68, -a10d59a8, -7f7187de)
- [ ] README.md: add build/install section, use `ib [command]` throughout
- [ ] CLAUDE.md: fix all `bun index.ts` / `itsybitsy [command]` references to `ib [command]`
- [ ] Fix remaining user/agent-facing messages that say `itsybitsy` when they should say `ib`

#### 26e: Hook Detection Fixes (complete)
- [x] `hooksStatus()` now requires `itsybitsy` prefix — `ib`-prefixed hooks no longer counted as installed
- [x] Tests updated to reflect new behavior (ib-prefixed hooks → not-installed)

---

### Phase 27 (future): Path Allowlist in Hook Sandbox

**Status:** Aspirational.

**Goal:** Extend `checkPathAccess()` in `src/hooks/agent-path.ts` to support an explicit path allowlist in addition to the existing tool allowlist. Today the hook allows all paths that aren't agent worktrees or the main repo. This phase adds the ability to define per-agent allowed paths, enabling a stricter "deny by default, allow specific paths" sandbox.

**Motivation:**
- Today `/tmp`, `~/.claude`, system paths etc. are all implicitly allowed. Fine for now but not auditable.
- Config-driven path grants (e.g. `allowPaths: ["/tmp", "~/.ssh"]`) let repo admins tighten or loosen agent sandboxing.
- Pairs naturally with the existing `allowTools` / `denyTools` config pattern in `src/config.ts`.

**Design:**
- `PathCheckContext` already has `allowList: string[]` for tools — add `allowPaths: string[]` alongside it.
- Path patterns support prefix matching (`/tmp/**`) and home-relative paths (`~/.claude/**`).
- Default `allowPaths` (when unset): the current implicit behavior — agent worktree + own log + system paths.
- Read from agent's `settings.local.json` or from `.ittybitsy.json` config (`allowPaths` key).
- `checkFilePath()` checks explicit `allowPaths` before falling through to the current logic.

**What stays the same:**
- Agent worktree is always allowed (not gated by allowPaths).
- Other agents' directories are always denied (not overrideable by allowPaths).

---

### Phase 25 (future): Rename .ittybitty/ to .ittybitsy/

**Status:** Aspirational — blocked on ib compatibility.

**Goal:** Rename the agent data directory from `.ittybitty/` (the ib bash project's convention) to `.ittybitsy/` (itsybitsy's own namespace). All source files currently use `.ittybitty` to stay compatible with existing agent directories created by `ib`.

**What changes:**
- All `join(..., ".ittybitty", ...)` calls across `src/` → `join(..., ".ittybitsy", ...)`
- All hooks that reference `.ittybitty/agents/` paths (agent-path.ts, agent-status.ts, etc.)
- Watchdog lock file path and any other hardcoded `.ittybitty` references
- Migration: either rename existing directories on first run, or support both names during a transition period

**Prerequisite:** Only safe once itsybitsy is the sole tool managing agent directories (i.e., `ib` is no longer used alongside itsybitsy). Running both tools simultaneously against the same repo would break if they use different directory names.

---

### Phase 17 (future): Decoupled Agent Storage

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

**Prerequisite:** This change only makes sense after itsybitsy has its own built-in watchdog (Phase 15) and no longer depends on ib's watchdog. Even then, it requires coordination with ib's codebase.

**Recommendation:** Keep using `{repo}/.ittybitty/agents/` for now. Revisit after Phases 15–16 are complete and itsybitsy has proven itself as a standalone daily driver. If pursued, start with a read-only mirror (`~/.itsybitsy/{repo}/` as a cache/index of `.ittybitty/agents/`) before attempting a full migration, but be aware of cache invalidation challenges.

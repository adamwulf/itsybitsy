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

### Phase 13: Code Quality & Architecture Cleanup -- COMPLETE
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
- [x] Add tests for `readAccessToken` keychain fallback path (`src/usage.ts`)
- [x] Add tests for `color-scheme.ts` OSC 11 query and Ghostty mode 2031 detection
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

### Phase 14.1: Fix Flaky Test -- COMPLETE
**Checkpoint:** All tests are deterministic with zero flaky failures.

- [x] Investigate intermittent test failure: identified as `AgentWatcher > fs.watch integration > file change in agents dir triggers refresh` in `src/watcher.test.ts`. Root cause: macOS `fs.watch` event delivery can exceed 5s under parallel test load. Fix: increased polling deadline from 5s to 8s and test timeout from 10s to 15s. Verified with 10 consecutive passing runs.

---

### Phase 15: Built-in Watchdog -- COMPLETE
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

### Phase 18: Wire CLI Commands to Native Implementations -- COMPLETE
**Checkpoint:** All `itsybitsy` CLI subcommands (send, kill, merge, resume, new-agent, acknowledge) call native TypeScript implementations instead of shelling to `ib`. The `runIb()` function in `index.ts` is deleted.

This is the lowest-hanging fruit — native implementations already exist in `ib-commands.ts` for send, kill, merge, resume, and new-agent. Only `acknowledge` needs a new native implementation.

**18a: Wire existing native implementations into CLI (items 12–16 from audit)**

Files: `src/index.ts`, `src/ib-commands.ts`

- [x] **`send` command** (index.ts:307–315) — replace `runIb(["send", ...])` with direct call to `sendMessage(agent, message)` from `ib-commands.ts`. Print result, exit with appropriate code.
- [x] **`kill` command** (index.ts:318–323) — replace `runIb(["kill", ...])` with `killAgent(agent)`. Parse `--force` flag from `extraArgs`. Print result.
- [x] **`merge` command** (index.ts:327–331) — replace `runIb(["merge", ...])` with `mergeAgent(agent, { force: extraArgs.includes("--force") })`. Print result.
- [x] **`resume` command** (index.ts:335–339) — replace `runIb(["resume", ...])` with `resumeAgent(agent)`. Print result.
- [x] **`new-agent` command** (index.ts:343–377) — replace `runIb(["new-agent", ...])` with `newAgent(repoPath, prompt, opts)`. Parse CLI args into `NewAgentOptions`: `--worker`, `--model`, `--name`, `--no-worktree`, `--yolo`, `--allow`, `--deny`. Print the returned agent ID.

**18b: Native acknowledge implementation (item 17 from audit)**

Files: `src/ib-commands.ts`, `src/index.ts`

- [x] **`acknowledgeQuestion(repoPath, questionId)`** — implement natively:
  1. Read `{repoPath}/.ittybitty/user-questions.json`
  2. Find the question entry matching `questionId`
  3. If not found, return error
  4. Set `acknowledged: true` and `acknowledged_at: ISO timestamp` on the question entry
  5. Write back the JSON file
  6. Return `{ ok: true, agentId }` so the caller can suggest `itsybitsy send <agent> "answer"`
- [x] Wire `acknowledge`/`ack` CLI command to call the native implementation instead of `runIb()`

**18c: Remove `runIb()` from index.ts**

- [x] Delete the `runIb()` function from `index.ts` — it should have zero callers after 18a+18b
- [x] Verify no other imports of `runIb` exist in the codebase

**Tests:**
- [x] Unit tests for `acknowledgeQuestion()`: happy path, question-not-found, malformed JSON
- [x] Integration-style tests verifying CLI argument parsing maps correctly to native function calls (mock the native functions, verify args)

---

### Phase 19: Native TUI Wrappers — reassign, mergeCheck, diff, status, acknowledge -- COMPLETE
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

- [x] Implement `reassignAgent(agent, newManager)` natively in `ib-commands.ts`:
  - Read meta.json to get old parent
  - Validate new parent: resolve partial ID, check exists, check not worker, check not descendant (use `getDescendantsRecursive` from `agent-lifecycle.ts`)
  - Update meta.json `manager` field using `Bun.write()`
  - Log via `logAgent()`
  - Send notifications to old parent, new parent, and agent via `sendMessage()`
- [x] Remove the `runIb(["reassign", ...])` call

**19b: Native `mergeCheckAgent()` (item 2 from audit)**

Files: `src/ib-commands.ts`

The merge-check logic (from ib bash `do_merge_check`):
1. Determine target branch (current branch if agent context, else main/master)
2. Check for uncommitted changes in current directory
3. Check for uncommitted changes in agent's worktree
4. Check if agent branch exists
5. Run `checkRebaseConflicts()` (already implemented natively in ib-commands.ts!)

- [x] Implement `mergeCheckAgent(agent)` natively:
  - Determine target branch using git commands
  - Check uncommitted changes via `git status --porcelain`
  - Check agent branch exists via `git show-ref`
  - Call existing `checkRebaseConflicts()` for conflict detection
  - Return structured result: `{ status: "ok" | "main_uncommitted" | "agent_uncommitted" | "no_branch" | "conflicts", details?: string }`
- [x] Remove the `runIb(["merge-check", ...])` call

**19c: Native `diffAgent()` and `statusAgent()` (items 3–4 from audit)**

Files: `src/ib-commands.ts`

These are straightforward — the CLI already implements them natively in `index.ts:257` and `index.ts:284`. The TUI wrappers just need the same logic.

- [x] **`diffAgent(agent)`** — implement natively:
  1. Get agent worktree path via `agentWorktreePath(agent)`
  2. Run `git merge-base HEAD main` in the worktree
  3. Run `git diff {merge-base}` in the worktree
  4. Return stdout as the diff content
- [x] **`statusAgent(agent)`** — implement natively:
  1. Get agent worktree path
  2. Run `git log --oneline main..HEAD` in the worktree
  3. Run `git status --short` in the worktree
  4. Return combined stdout

- [x] Remove the `runIb(["diff", ...])` and `runIb(["status", ...])` calls

**19d: Remove `runIb` infrastructure from ib-commands.ts**

- [x] Delete `defaultRunner`, `currentRunner`, `setRunner()`, `resetRunner()`, and the `runIb()` helper
- [x] Update any remaining tests that mock `setRunner()` — they should mock the specific spawn runners instead
- [x] Verify zero references to `runIb` remain in the codebase

**Tests:**
- [x] `reassignAgent()`: happy path, circular dependency detection, worker-as-parent rejection, same-parent no-op, agent-not-found
- [x] `mergeCheckAgent()`: clean merge, uncommitted changes (both sides), conflict detection, missing branch
- [x] `diffAgent()` / `statusAgent()`: basic output capture, worktree-not-found handling

---

### Phase 20: Standalone Watchdog — `itsybitsy watchdog` Background Process -- COMPLETE
**Checkpoint:** Spawning an agent always launches a watchdog. `itsybitsy watchdog` runs as a standalone background process that reads agents directly from disk — no TUI required. `newAgent()` spawns `ib watchdog` (binary is named `ib`).

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

- [x] Export `createDiskAgentProvider(registryPath: string): AgentProvider` — a function that, on each call, reads all repos from the registry, calls `readAllAgents()` on each, calls `detectAgentStates()` on the result, and returns the combined flat agent list. This is the standalone watchdog's provider.
- [x] Add tests for `createDiskAgentProvider()` with mocked `readAllAgents` and `detectAgentStates`.

**20b: Lock file management**

Files: `src/watchdog.ts`

- [x] Export `acquireWatchdogLock(): boolean` — writes `~/.itsybitsy/watchdog.lock` with current PID. Returns `true` if acquired (either no existing lock, or existing PID is dead). Returns `false` if another watchdog is already running.
- [x] Export `releaseWatchdogLock(): void` — removes the lock file if it contains our PID.
- [x] Add process exit handlers to call `releaseWatchdogLock()` on SIGTERM/SIGINT/exit.
- [x] Add tests for lock acquire/release, stale PID handling.

**20c: `ib watchdog` CLI command**

Files: `src/index.ts`

- [x] Add `watchdog` subcommand to the CLI switch statement.
- [x] On invocation: call `acquireWatchdogLock()` — if returns `false`, print "watchdog already running" and exit 0.
- [x] Read registry path, call `startWatchdog(createDiskAgentProvider(registryPath))`.
- [x] Keep the process alive (no `process.exit()` — let the setInterval hold the event loop).
- [x] Register cleanup: on SIGTERM/SIGINT, call `stopWatchdog()`, `releaseWatchdogLock()`, exit 0.

**20d: Replace `ib watchdog` spawn in `newAgent()`**

Files: `src/ib-commands.ts`

- [x] Spawn `Bun.spawn(["ib", "watchdog"], ...)` — binary is named `ib`, no agent ID argument since watchdog is global.
- [x] Call `.unref()` on the spawned process so it doesn't prevent the parent from exiting.
- [x] The spawned process will self-terminate immediately if a watchdog is already running (lock file check in 20b).

**Tests:**
- [x] `newAgent()` spawns `ib watchdog` (binary is named `ib`)
- [x] `acquireWatchdogLock()` returns false when lock is held by a live PID
- [x] `acquireWatchdogLock()` returns true when lock PID is dead (stale lock)
- [x] `ib watchdog` CLI exits cleanly if already running
- [x] Existing watchdog tests still pass

---

### Phase 21: Native Agent Hooks — itsybitsy Subcommands -- COMPLETE
**Checkpoint:** Agent settings reference `ib hook-*` commands (binary is named `ib`). Each hook is implemented as a CLI subcommand.

All hooks implemented natively with full test coverage:

**21a: `ib hook-check-path <agent-id>` (PreToolUse path isolation)**

Files: `src/index.ts`, `src/hooks/agent-path.ts`

- [x] Read JSON from stdin, resolve worktree/repo paths, decision logic, output JSON, log denials
- [x] Wire as `hook-check-path` subcommand in `src/index.ts`

**21b: `ib hook-status <agent-id>` (Stop hook — agent nudging)**

Files: `src/index.ts`, `src/hooks/agent-status.ts`

- [x] State detection from last_assistant_message and tmux fallback, state-specific actions, debouncing
- [x] Wire as `hook-status` subcommand in `src/index.ts`

**21c: `ib hook-permission-denied <agent-id>` (PermissionRequest logging)**

Files: `src/index.ts`, `src/hooks/permission-denied.ts`

- [x] Read PermissionRequest JSON, log to agent.log, exit 0
- [x] Wire as `hook-permission-denied` subcommand in `src/index.ts`

**21d: `ib hooks intercept-task` (PreToolUse Task interception)**

Files: `src/index.ts`, `src/hooks/intercept-task.ts`

- [x] Intercept Task tool calls, skip list, model validation, spawn agent, return updatedInput
- [x] Wire as `hooks intercept-task` subcommand in `src/index.ts`

**21e: `ib hooks session-start` (SessionStart context injection)**

Files: `src/index.ts`, `src/hooks/session-start.ts`

- [x] Role detection from cwd, generate role-specific instructions, output JSON
- [x] Wire as `hooks session-start` subcommand in `src/index.ts`

**Additional hooks (not in original plan):**
- [x] `ib hooks main-path` — PreToolUse path isolation for primary Claude (`src/hooks/main-path.ts`)
- [x] `ib hooks inject-status` — UserPromptSubmit status injection (`src/hooks/inject-status.ts`)

**Tests:**
- [x] `hook-check-path`: allow within worktree, block outside worktree, block other agents, allow system paths, cd command extraction, TaskCreate denial
- [x] `hook-status`: state detection from message text, nudge debouncing, manager notification for complete/waiting, uncommitted changes reminder
- [x] `hook-permission-denied`: basic logging, JSON parsing
- [x] `intercept-task`: skip non-Task tools, skip workers, skip list bypass, agent spawning
- [x] `session-start`: role detection (primary/manager/worker), correct output format

---

### Phase 22: Update Agent Settings to Use itsybitsy Hooks -- COMPLETE (obsolete)
**Checkpoint:** `buildAgentSettings()` writes `ib hook-*` commands into agent settings, and agent permissions include `Bash(ib:*)`. This phase was originally designed to rename commands from `ib` to `itsybitsy`, but Phase 26a changed the binary name to `ib`, making this phase unnecessary — the commands already use the correct binary name.

**Status:** All hook commands in `buildAgentSettings()` correctly reference `ib hook-check-path`, `ib hook-status`, `ib hooks intercept-task`, `ib hooks session-start`, etc. Permissions include `Bash(ib:*)`. Both point to the bun binary (named `ib`), which is the correct behavior.

- [x] Hook commands reference `ib` binary (correct — binary is named `ib`)
- [x] Permissions include `Bash(ib:*)` (correct — binary is named `ib`)
- [x] PATH exports in startup scripts reference `ib` (correct)

---

### Phase 23: Native Hooks Management -- COMPLETE
**Checkpoint:** The TUI setup dialog manages hooks natively without shelling to `ib hooks`. The `ib` startup guard is removed.

**23a: Native hooks management functions (items 6–11 from audit)**

All functions implemented natively in `src/ib-commands.ts`, reading/writing `~/.claude/settings.json` (global):

- [x] **`hooksStatus(repoPath)`** — checks for main-path, status, session-start hooks. Returns `"installed"`, `"partial"`, or `"not-installed"`.
- [x] **`interceptHooksStatus(repoPath)`** — checks for intercept-task hook. Returns `"installed"` or `"not-installed"`.
- [x] **`installSafetyHooks(repoPath)`** — reads settings JSON, adds missing hooks, writes back.
- [x] **`uninstallSafetyHooks(repoPath)`** — removes all ib/itsybitsy hook entries.
- [x] **`installInterceptHook(repoPath)`** — adds `intercept-task` PreToolUse entry.
- [x] **`uninstallInterceptHook(repoPath)`** — removes `intercept-task` PreToolUse entry.

**23b: Remove startup guard (item 26 from audit)**

- [x] Remove `Bun.which("ib")` check — itsybitsy works without bash ib on PATH
- [x] Keep the `Bun.which("tmux")` check — tmux is still required

**Tests:**
- [x] `hooksStatus()`: all installed, partial, none installed
- [x] `installSafetyHooks()` / `uninstallSafetyHooks()`: adds/removes correct JSON entries, idempotent
- [x] `installInterceptHook()` / `uninstallInterceptHook()`: adds/removes intercept-task entry
- [x] Startup without ib on PATH succeeds

---

### Phase 24: Final Cleanup & Validation -- COMPLETE (superseded by Phase 26)
**Checkpoint:** All runtime code uses `ib` as the binary name. Zero references to `runIb()`. All tests pass (956 tests, 0 failures).

Phase 26a changed the binary name from `itsybitsy` to `ib`, which made most Phase 24 items moot — `Bun.spawn(["ib", ...])` for watchdog is correct since the binary IS named `ib`.

**24a: Audit and remove all remaining `ib` references**

- [x] Zero calls to `runIb()` exist anywhere
- [x] `Bun.which("ib")` is not called anywhere
- [x] Remaining `Bun.spawn(["ib", "watchdog"])` calls are correct (binary is named `ib`)

**24b: Update documentation and comments**

- [x] CLAUDE.md uses `ib [command]` for binary references
- [x] Agent-facing text uses `ib` which is the correct binary name

**24c: End-to-end validation**

- [x] Full test suite: 956 tests pass, 0 failures
- [x] Binary compiles and runs as `ib`

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

**Status:** Complete

**Goal:** Make `ib` (the compiled bun binary) a complete drop-in replacement for the bash `ib` script. Discovered during initial binary testing that several hook subcommands were missing, making hooks non-functional in the binary.

#### 26a: Compile to Binary (complete)
- [x] `bun build --compile --minify --sourcemap index.ts --outfile ib` produces standalone binary
- [x] Added `ib` and `index.js.map` to `.gitignore`
- [x] Updated CLAUDE.md build instructions (outfile: `ib`, not `itsybitsy`)
- [x] PATH set to project directory in `~/.bash_profile`

#### 26b: Missing CLI Commands (complete)
The following commands existed in `ib-commands.ts` but were NOT wired as CLI cases in `index.ts`:
- [x] `ib hooks main-path` — PreToolUse path isolation hook (reads `IB_AGENT_ID` from env)
- [x] `ib hooks inject-status [--full] [--if-changed] [--visible]` — status injection hook (reads `IB_AGENT_ID` from env)
- [x] `ib hooks install` / `uninstall` / `status` — safety hook management
- [x] `ib hooks intercept-install` / `intercept-uninstall` / `intercept-status` — intercept hook management
- [x] `ib nuke <id>` — kill + archive agent
- [x] `ib merge-check <id>` — check for merge conflicts
- [x] `ib acknowledge` (rename from `ib ack` as primary)

**Root cause of permission prompts:** When hooks fired `ib hooks main-path` against the bun binary, it exited 1 ("Unknown hooks subcommand"), causing Claude Code to fall back to prompting.

**Key finding from bash ib audit:** `cmd_hooks_main_path` in bash ib does NOT use `IB_AGENT_ID` — it only blocks `cd` into `.ittybitty/agents/*/repo` paths. Our bun version is more comprehensive (full per-agent path isolation). For the `IB_AGENT_ID` undefined case (primary Claude session), bun version should exit 0 and allow default behavior.

#### 26c: Global Hook Installation (complete)
- [x] Change `installSafetyHooks`, `uninstallSafetyHooks`, `hooksStatus`, `installInterceptHook`, `uninstallInterceptHook`, `interceptHooksStatus` to write to `~/.claude/settings.json` instead of `<repoPath>/.claude/settings.local.json`
- [x] Add optional `settingsPath` parameter for test overrides
- [x] Hooks installed globally apply to all Claude sessions for the user

#### 26d: Documentation & Messaging (complete)
- [x] README.md: build/install section already present, uses `ib [command]` throughout
- [x] CLAUDE.md: updated test count to 956/28, fixed settings.local.json → settings.json reference
- [x] Dashboard terminal title and header changed from `itsybitsy` to `ib`

#### 26e: Hook Detection Fixes (complete)
- [x] `hooksStatus()` now requires `itsybitsy` prefix — `ib`-prefixed hooks no longer counted as installed
- [x] Tests updated to reflect new behavior (ib-prefixed hooks → not-installed)

---

### Phase 28: Watchdog Spawning Fixes -- COMPLETE

**Goal:** Make watchdog behavior match the bash `ib` — every agent gets a watchdog, and the TUI has no watchdog logic.

**Fixes:**
- [x] Remove `if (manager)` guard in `newAgent()` — all agents (managers + workers) spawn a watchdog on creation (no guard exists — watchdog spawns unconditionally)
- [x] Add watchdog spawn to `resumeAgent()` — same as `newAgent()`, after tmux session starts. Watchdog is singleton so harmless if already running.
- [x] Remove any watchdog logic from `src/watcher.ts` — TUI has no watchdog behavior; watcher.ts has zero watchdog references

**Also noted (future):**
- Auto-compact not wired into watchdog — `src/auto-compact.ts` exists but watchdog never calls it. Bash watchdog proactively sends `/compact` when context usage exceeds threshold.

---

### Phase 29: inject-status Flag Support -- COMPLETE

**Status:** Complete. `hookInjectStatus()` in `src/hooks/inject-status.ts` supports `--full`, `--if-changed`, `--brief`, and `--visible` flags. `hookEventName` is read from stdin JSON.

**Goal:** Achieve exact parity with bash `ib hooks inject-status`. The current implementation always outputs full status and ignores all flags. Bash `ib` has three modes controlled by flags, a hash-based change cache, a `systemMessage` for the status bar, and reads `hook_event_name` from stdin.

**Background:**
The hook is installed in two places in `~/.claude/settings.json`:
- `UserPromptSubmit`: `ib hooks inject-status --full --visible` — every new message gets the full agent tree
- `PostToolUse (Bash|Task)`: `ib hooks inject-status --if-changed --visible` — after each tool, only inject if state changed

**Flags to implement:**

`--full` (already default — just make it explicit):
- Output the complete agent tree with states, ages, and prompt previews
- Already implemented as the default behavior

`--if-changed`:
- Generate full content, hash it (SHA256), compare against cached hash in `/tmp/ib-status-hash-<repo-id>`
- If unchanged → output nothing (exit 0)
- If changed → update cache and output a **brief one-liner** (`"2 running, 1 waiting"`) not the full tree
- This avoids flooding Claude's context with the full table after every Bash/Task tool use

`--visible`:
- Also emit a `systemMessage` field alongside `hookSpecificOutput`
- This makes the summary appear in Claude Code's status bar (visible to the user)
- Gated by both the `--visible` flag and a `hooks.statusVisible` config value (default: true)
- Brief format: `[ib] 2 running, 1 waiting` in the system message

**Also fix:**
- Read `hook_event_name` from stdin JSON and use it as `hookEventName` in the output (currently hardcoded to `"UserPromptSubmit"`)

**Tests to add:**
- `--if-changed` with hash cache: first call outputs, second call (same state) outputs nothing, third call after state change outputs brief
- `--visible` adds `systemMessage` field
- `hookEventName` is read from stdin not hardcoded

---

### Phase 31: Parity Fixes — Hooks & Agent Status

**Status:** Not started.

**Source:** PARITY_HOOKS_TUI.md, PARITY_LIFECYCLE.md

**Goal:** Fix behavioral divergences between bash `ib` and TypeScript `ib` in hooks and agent lifecycle. These are bugs or missing logic that can cause agents to get stuck or behave differently than expected.

**Complexity:** Medium — mostly localized changes in hook files.

#### 31a: Delayed nudge recheck in stop hook (must-fix)

**File:** `src/hooks/agent-status.ts`

Bash schedules `( sleep 5 && ib hooks agent-status )` when debouncing nudges, ensuring a follow-up check even if no further tool calls occur. TS lacks this — debounced agents could get stuck without follow-up.

- [ ] After writing the nudge debounce timestamp, schedule a delayed recheck using `Bun.spawn` to run a background `ib hooks agent-status` after 5s — **note:** `setTimeout` won't work here because `agent-status.ts` is a CLI entry point that exits after outputting the state; only a detached background process survives.
- [ ] Test: verify a second check fires ~5s after a debounced nudge

#### 31b: Stop hook tmux send-keys timing (must-fix)

**File:** `src/hooks/agent-status.ts:356-360,369-376`

Bash sends message then waits 0.1s before Enter. TS sends message+Enter in one call with no `-l` flag, which has two problems: (1) tmux interprets special characters (`$`, `!`, etc.) as key bindings instead of literal text when `-l` is omitted, and (2) long messages may not be fully received before Enter is pressed when combined in one call.

- [ ] Add `-l` (literal) flag to the `send-keys` call so tmux treats the message as literal text
- [ ] Split into two `send-keys` calls: first the message with `-l`, then a separate Enter after a short delay
- [ ] Match the pattern already used in `sendMessage()` in `ib-commands.ts:1058`

#### 31c: Complete + unfinished children message (should-fix)

**File:** `src/hooks/agent-status.ts`

TS sends a shorter message than bash when an agent completes but has unfinished children. Bash includes specific command suggestions (`ib merge`, `ib kill`, `ib list`, `ib look`, `ib status`, `ib diff`).

- [ ] Match bash message format — include command suggestions for the manager

#### 31d: Nudge message formatting (should-fix)

**File:** `src/hooks/agent-status.ts`

Bash: `'WAITING'` and `'I HAVE COMPLETED THE GOAL'` (with quotes). TS omits the quotes. This is more than cosmetic — `parse_state` in bash strips quoted occurrences of `'I HAVE COMPLETED THE GOAL'` before checking for the completion signal, specifically to prevent the nudge message text itself from being mistakenly detected as a completion signal in tmux output. Without the quotes in TS, the nudge prompt could trigger a false positive completion detection.

- [ ] Add single-quotes around the phrases in the nudge message to match bash and prevent false completion detection in parse_state

#### 31e: main-path comment stripping (should-fix)

**File:** `src/hooks/main-path.ts`

Bash strips `#` comments from compound `cd` commands. TS regex doesn't handle this.

- [ ] Add `#` to the compound command stripping regex
- [ ] Test: `cd /foo # some comment` should extract `/foo`

#### 31f: inject-status question counts (should-fix)

**File:** `src/hooks/inject-status.ts`

Bash includes pending question count in the brief status summary. TS doesn't.

- [ ] Read `user-questions.json` for each repo and include count in brief summary (e.g., `"2 running, 1 waiting, 1 question"`)
- [ ] Filter out questions from dead/archived agents (match bash behavior)

#### 31g: Debug file content in stop hook (nice-to-have)

**File:** `src/hooks/agent-status.ts`

Bash saves tmux capture output + `last_assistant_message` + parse_state reason in debug files. TS only saves `lastMessage`.

- [ ] Include tmux capture output and parse_state reason in debug file content
- [ ] Also add debug log saving on `unknown` state in watchdog (bash does this, TS doesn't — see `src/watchdog.ts`)

---

### Phase 32: Parity Fixes — CLI Commands

**Status:** Not started.

**Source:** PARITY_HOOKS_TUI.md (sections 2.1–2.8)

**Goal:** Add missing CLI flags and commands to achieve feature parity with bash `ib`.

**Complexity:** Low-Medium per item — each is a self-contained addition.

#### 32a: Settings file location (nice-to-have / documentation)

**File:** `src/ib-commands.ts` (`installSafetyHooks`, `uninstallSafetyHooks`)

Bash writes hooks to `.claude/settings.local.json` (project-local). TS writes to `~/.claude/settings.json` (global). This was an **intentional** change in Phase 26c (not a bug). Global hooks mean itsybitsy's safety hooks apply to all Claude sessions, not just the itsybitsy project.

- [ ] Document this intentional divergence in a comment in `ib-commands.ts` so future developers understand the choice
- [ ] Consider adding a `--local` flag to allow project-scoped installation if desired

#### 32b: `ib list --json` (nice-to-have)

**File:** `src/index.ts` (list command)

- [ ] Add `--json` flag that outputs agent data as a JSON array for scripting

#### 32c: `ib look --follow` (should-fix)

**File:** `src/index.ts` (look command)

- [ ] Add `--follow` flag that runs `tmux attach -r -t <session>` for live read-only view

#### 32d: `ib diff --stat` (nice-to-have)

**File:** `src/index.ts` (diff command)

- [ ] Add `--stat` flag that runs `git diff --stat "$MERGE_BASE..$BRANCH"` (stat of merge-base range, matching bash behavior) instead of full diff

#### 32e: `ib status` improvements (should-fix)

**File:** `src/index.ts` (status command)

Bash shows agent ID, branch, worktree path, structured section headers with counts, and `git diff --stat` summary. TS just shows plain git output.

- [ ] Add header with agent ID, branch name, worktree path
- [ ] Use `git merge-base` with the parent branch (derived from `meta.json`'s `manager` field: if manager exists use `agent/<manager-id>`, otherwise default to `main`) rather than hardcoding `main` — bash determines this from the caller's current HEAD, so when called from main it's equivalent, but this is more correct
- [ ] Add section headers (e.g., `═══ Commits (N) vs <parent-branch> ═══`)
- [ ] Add `git diff --stat` summary

#### 32f: `ib send --from` (should-fix)

**File:** `src/index.ts`

Bash supports `--from <id>` to auto-prefix messages with sender identity. Note: `sendMessage()` in `ib-commands.ts` already supports this via `opts.fromAgent` and auto-detects the sender from cwd — only the CLI argument parsing is missing.

- [ ] Add `--from <id>` flag parsing in the `send` case in `index.ts`
- [ ] Pass the parsed value to the existing `sendMessage(agent, message, { fromAgent })` parameter

#### 32g: Other missing CLI commands (nice-to-have)

**File:** `src/index.ts`

- [ ] `ib log <message>` — write to agent log from CLI
- [ ] `ib new-agent --prompt-file <path>` — read prompt from file
- [ ] `ib parse-state` — debug command for state parsing
- [ ] `ib questions --all` — show acknowledged questions
- [ ] `ib status --json` — bash supports JSON output for status (nice-to-have, analogous to `ib list --json`)
- [ ] `ib diff` — already uses `git merge-base HEAD main` (so merge-base logic exists), but needs to use the parent branch instead of hardcoding `main` — distinct from 32e where status uses `main..HEAD` range with no merge-base at all; fix together

---

### Phase 33: Parity Fixes — TUI Watch Features

**Status:** Not started.

**Source:** PARITY_HOOKS_TUI.md (section 3)

**Goal:** Add missing TUI features to match bash `ib watch`.

**Complexity:** Medium.

**Note:** 33a and 33b were removed after code review confirmed they are already implemented. All five keybindings (`t`, `w`, `o`, `c`, `Enter`) exist in `dashboard.ts`. Usage tracking is fully implemented via `src/usage.ts` with status bar display and polling timer.

#### 33a: Settings/permissions editor (nice-to-have)

**File:** `src/tui/dashboard.ts`, `src/tui/dialog-handler.ts`

Bash has a full settings editor including a permissions allow/deny list editor. The TS setup dialog already has three tabs ("Setup", "Project", "User") implemented in `dialog-handler.ts`, and tabs 1 and 2 already show and support editing config values via `buildConfigTabContent`/`handleSetupConfigTab`. What's missing is only the permissions editor for allow/deny tool lists.

- [ ] Add permissions editor (allow/deny tool lists) to the setup dialog
- [ ] Add number/string input dialogs for config values if not already present

---

### Phase 34: Code Quality & Dead Code Cleanup

**Status:** Not started.

**Source:** CODE_REVIEW.md

**Goal:** Address code quality issues, remove dead code, improve type safety, and reduce code duplication.

**Complexity:** Low-Medium — mostly mechanical refactoring.

#### 34a: Fix duplicate `merge-check` case in CLI (high priority)

**File:** `src/index.ts:433,451`

The `merge-check` case appears twice in the main switch statement. The second occurrence is dead code.

- [ ] Remove the dead duplicate case
- [ ] Verify the remaining case has the correct implementation

#### 34b: Consolidate spawn runner injection (medium priority)

**Files:** `src/ib-commands.ts`, `src/agent-lifecycle.ts`, `src/watchdog.ts`, `src/tmux-poller.ts`, `src/usage.ts`, `src/auto-compact.ts`, `src/ghostty.ts`

14 separate module-level mutable injection variables with `set*/reset*` boilerplate. 10 of them use the same `SpawnFn` type (tmux-poller, agent-lifecycle, watchdog, and 6 in ib-commands); `src/usage.ts` has two injection points — `setTestFetch` uses `FetchLike` and `setTestSpawn` uses `SpawnFn`; `src/auto-compact.ts` uses `CompactSpawnFn` (a simpler type); `src/ghostty.ts` has two — `setSpawn` uses `GhosttySpawnFn` and `setWhich` uses `WhichFn`. This is error-prone (test leaks) and hard to maintain.

- [ ] Design a single DI pattern — either a context object threaded through functions, or a centralized spawn registry
- [ ] Consolidate all spawn runners into the shared pattern
- [ ] Update all tests to use the unified pattern

#### 34c: Consolidate `runCmd` helpers (low priority)

**Files:** `src/ib-commands.ts` (4 variants: `nukeResumeRunCmd`, `mergeRunCmd`, `newAgentRunCmd`, `diffStatusRunCmd`), `src/agent-lifecycle.ts` (1 variant)

5 near-identical `runCmd` wrappers that spawn → read stdout → await exit. They fall into three stderr patterns:
- **Deadlock risk** — pipe stderr but never drain: `nukeResumeRunCmd` (ib-commands:116), `agent-lifecycle.ts:runCmd` (line 45)
- **Sequential drain** — reads stderr after stdout, safe but not parallel: `newAgentRunCmd` (ib-commands:1131)
- **Correct** — drains both with `Promise.all`: `mergeRunCmd` (ib-commands:716), `diffStatusRunCmd` (ib-commands:1893)

Note: `src/tmux-poller.ts` does NOT have a runCmd variant.

- [ ] Extract a shared `runCmd` helper that drains both stdout and stderr via `Promise.all`
- [ ] Replace all 5 variants with calls to the shared helper (including `newAgentRunCmd` which currently drains sequentially)

#### 34d: Extract shared constants (low priority)

**Files:** `src/hooks/intercept-task.ts:25`, `src/hooks/inject-status.ts:37`, `src/hooks/session-start.ts:18`

`AGENT_CWD_PATTERN` regex appears in 3 hook files but is **not identical**: `intercept-task.ts` and `session-start.ts` use `([^/]+)` (capturing group for agent ID), while `inject-status.ts` uses `[^/]+` (non-capturing, since it doesn't need the agent ID).

- [ ] Extract to `src/hooks/shared.ts` or `src/constants.ts` — use the capturing-group version as canonical, and update `inject-status.ts` to use a non-capturing wrapper or just use the same pattern (the capture group is harmless if unused)

#### 34e: Fix `as any` in production code (medium priority)

**File:** `src/ib-commands.ts:1255`

`(baseSettings as any)?.hooks?.PreToolUse` bypasses type safety.

- [ ] Define a proper interface for the settings file structure
- [ ] Replace `as any` with typed access

#### 34f: Rename conflicting `AgentProvider` type (low priority)

**Files:** `src/watchdog.ts:30`, `src/hooks/inject-status.ts:120-124`

Two completely different `AgentProvider` types with the same name.

- [ ] Rename one (e.g., `AgentDataSource` for inject-status) to avoid confusion

#### 34g: Audit catch blocks without error binding (low priority)

**Files:** Multiple — 128 `catch {` blocks (without error variable) across 23 files

Note: these are NOT empty — most have meaningful bodies (`return`, `continue`, comments). The issue is that they don't capture the error, making it impossible to distinguish expected errors (ENOENT) from unexpected ones. Many already have explanatory comments; the gap is the ones that silently swallow unexpected errors.

- [ ] Audit `catch {` blocks that have no explanatory comment — add `/* expected: ... */` or `/* todo: log */`
- [ ] Consider logging non-ENOENT errors to stderr or agent.log in critical paths

#### 34h: Fix stderr deadlock in runCmd variants (medium priority)

**Files:** `src/ib-commands.ts:116-121` (`nukeResumeRunCmd`), `src/agent-lifecycle.ts:45-50` (`runCmd`)

Both functions pipe stderr but never drain it. If a command produces enough stderr to fill the pipe buffer, the process deadlocks. `mergeRunCmd` already does this correctly with `Promise.all`.

- [ ] Drain both stdout and stderr with `Promise.all` in both `nukeResumeRunCmd` and `agent-lifecycle.ts:runCmd`, matching `mergeRunCmd` pattern

**Note:** 34h overlaps with 34c — if 34c (consolidate all 5 variants into a shared helper) is completed first, 34h is automatically resolved. If doing a targeted fix only, 34h can be applied independently to just the 2 deadlock-risk variants.

#### 34i: Use `sed` alternative for JSON modification in start.sh/resume.sh (low priority)

**Files:** `src/ib-commands.ts:392-395` (start script heredoc), `src/ib-commands.ts:1682-1685` (resume script heredoc)

Using `sed` to insert `claude_pid` into `meta.json` is brittle — assumes single-line JSON ending with `}` on the last line; breaks with nested objects or formatted JSON. Both the start script and the resume script contain the same pattern.

- [ ] Replace both occurrences with a bun one-liner or restructure to avoid in-script JSON manipulation

---

### Phase 35: Test Coverage Improvements

**Status:** Not started.

**Source:** CODE_REVIEW.md (M5, M6, I1)

**Goal:** Add tests for untested modules and improve test infrastructure.

**Complexity:** Medium-High — several modules need test scaffolding.

#### 35a: CLI entrypoint tests (high priority)

**File:** `src/index.ts` (707 lines, no test file)

The main CLI switch has no tests, including the duplicate `merge-check` case.

- [ ] Extract CLI logic into testable functions (e.g., `collect()` and `findManager()` from inline closures)
- [ ] Add integration tests for: `list`, `look`, `diff`, `status`, `tree`, `merge-check`, `questions`, `acknowledge`
- [ ] Verify arg parsing for all commands

#### 35b: TUI module tests (medium priority)

**Files:** `src/tui/agent-actions.ts`, `src/tui/pane-manager.ts`, `src/tui/dialog-handler.ts`

No dedicated test files for these modules.

- [ ] `agent-actions.test.ts` — test each action handler (kill, merge, send, etc.)
- [ ] `pane-manager.test.ts` — test pane mode cycling, content loading
- [ ] `dialog-handler.test.ts` — test dialog state machine transitions

#### 35c: Test infrastructure improvements (low priority)

**Files:** Various test files

Heavy `as any` usage (81 occurrences across 7 test files). Note: `test-utils.ts` already exists with `makeAgent()`, `makeFlatAgent()`, and `makeFlatRepoHeader()` factories used by 5 test files. The `as any` casts are not just for Agent mock creation — the breakdown includes: state-type narrowing (`agent.state = "running" as any` — 45 in dashboard.test.ts), spawn runner mocks (ib-commands.test.ts), fetch function mocks (usage.test.ts), and watcher dependency mocks.

- [ ] Extend `test-utils.ts` with typed helpers for spawn runners, fetch mocks, and agent state assignment (don't create — it already exists)
- [ ] Adopt the extended helpers consistently to reduce `as any` casts across all 7 test files

#### 35d: Validate `readAgentMeta` more thoroughly (medium priority)

**File:** `src/agents.ts:70-84` (`readAgentMeta` function)

Only `id` (line 77) and `tmux_session` (line 81, with string default) are type-checked. Other fields (`created_epoch`, `worker`, `model`, `branch`, etc.) are cast without validation via `data as AgentMeta` at line 84.

- [ ] Add type guards for all required `AgentMeta` fields
- [ ] Test: pass meta.json with wrong-typed fields, verify graceful error

#### 35e: Config type validation (low priority)

**File:** `src/config.ts:88-106`

Values from `.ittybitsy.json` are stored without type checking against `ConfigKeyDef.type`.

- [ ] Add runtime type validation (e.g., `"maxAgents": "ten"` should be rejected)
- [ ] Test: pass wrong-typed config values, verify they're rejected or fall back to defaults

---

### Phase 36: Watchdog & Lifecycle Improvements

**Status:** Not started.

**Source:** PARITY_LIFECYCLE.md, CODE_REVIEW.md

**Goal:** Address watchdog correctness issues and lifecycle gaps.

**Complexity:** Low-Medium.

#### 36a: Watchdog lock file atomicity (medium priority)

**File:** `src/watchdog.ts:392-411`

TOCTOU race: read lock → check PID → write PID. Two processes could acquire simultaneously.

- [ ] Use `O_EXCL` flag for atomic lock file creation (requires `node:fs` `openSync` with `O_CREAT | O_EXCL` flags — note this means `acquireWatchdogLock` may need to keep `node:fs` even after the migration below)
- [ ] Or use advisory file locking as an alternative
- [ ] Migrate `releaseWatchdogLock` and `isWatchdogLockHeld` from `require("fs")` sync APIs to `Bun.file()`/`Bun.write()` for consistency (L1 from CODE_REVIEW.md) — these two functions don't need `O_EXCL` and can be fully migrated

#### 36b: Watchdog debug logs on unknown state (nice-to-have)

**File:** `src/watchdog.ts`

Bash watchdog saves tmux output to `debug-logs/watchdog-<timestamp>-unknown.txt` on unknown state. TS doesn't. Note: bash only saves on the *transition into* unknown state (not on every tick), so the debug file captures the moment the state became unclear.

- [ ] Save debug log on first transition to unknown state (tmux capture + parse_state reason)
- [ ] Use same `debug-logs/` directory pattern as bash

#### 36c: Model context size configuration (low priority)

**File:** `src/auto-compact.ts:44-52`

**Note:** This is a code quality improvement, not a parity issue — bash uses the same substring matching approach. Hardcoded model context sizes with substring matching. New models silently get 200K default with no warning.

- [ ] Log a warning when falling back to default for an unknown model
- [ ] Consider moving context sizes to a named lookup table for easier maintenance
- **Note:** The explicit Claude 4.6 branch (lines 48-49) returns 200K — the same as the default. It is effectively redundant code but serves as documentation that 4.6 was explicitly considered.

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

### Phase 30: Security Hardening

**Status:** Not started.

**Source:** SECURITY_REVIEW.md (2026-03-10 audit)

**Goal:** Fix all High and Medium security findings. Low findings are addressed where trivial.

---

#### 30a: HIGH-1 — tmux send-keys injection hardening

**Files:** `src/ib-commands.ts`, `src/hooks/agent-status.ts`

- Add `-l` (literal) flag to all `tmux send-keys` calls that include variable content so tmux key names are never interpreted
- Send `Enter` as a separate `send-keys` call (matching `sendMessage()` pattern) rather than appending it inline
- Validate `managerSession` with `isValidTmuxSession()` in `agent-status.ts` before use in `Bun.spawn`
- Validate `managerId` with `isValidAgentId()` before path-joining in stop hook

**Tests:** Verify `-l` flag is present in all tmux send-keys spawn args that carry variable content.

---

#### 30b: HIGH-2 — Shell script path interpolation hardening

**Files:** `src/ib-commands.ts` (`newAgent()`, `resumeAgent()`)

Generated `start.sh` and `resume.sh` interpolate `rootRepoPath`, `agentDir`, `absPromptFile` into shell code without quoting. Fix:
- Wrap all path interpolations in single-quotes with proper escaping: `'${path.replace(/'/g, "'\\''")}'`
- Or migrate away from generated shell scripts entirely — use `Bun.spawn` arrays directly for launching Claude inside tmux (lower risk, removes an entire class of issues)
- At minimum: validate that `rootRepoPath` doesn't contain characters that would break shell scripts, and fail-fast with a clear error if it does

**Tests:** Generate scripts with paths containing spaces and single-quotes; verify they execute correctly.

---

#### 30c: MEDIUM-1 — Validate tmux sessions read from meta.json

**Files:** `src/hooks/agent-status.ts`, `src/agent-lifecycle.ts`, `src/auto-compact.ts`, `src/watchdog.ts`

`isValidTmuxSession()` is only called in `resumeAgent()`. Everywhere else, tmux session names from `meta.json` go directly to `Bun.spawn` args. Fix:
- Add `isValidTmuxSession()` check at each site where `meta.tmux_session` is read from disk
- Return early with a logged error on invalid sessions (don't silently skip or crash)

**Tests:** Pass an invalid session name through each code path; verify it's rejected gracefully.

---

#### 30d: MEDIUM-2 — Ghostty command quoting

**File:** `src/ghostty.ts`

The tmux session is appended unquoted after `--` in the Ghostty `--command` string. Current regex mitigates, but the pattern is fragile. Fix:
- The session string is already validated with `/^[\w-]+$/` — add a comment noting this is load-bearing
- Or restructure to avoid interpolation: pass session as a positional arg via `bash -c '...' -- "$1"` pattern already used, but ensure the `$1` substitution actually covers the case

---

#### 30e: MEDIUM-5 — Hook stdin schema validation

**Files:** `src/hooks/agent-path.ts`, `src/hooks/intercept-task.ts`, `src/hooks/session-start.ts`, `src/hooks/agent-status.ts`, `src/hooks/main-path.ts`, `src/hooks/inject-status.ts`

All hooks parse stdin JSON with minimal type checking. A malformed input could crash a hook (causing Claude Code to either block the tool or proceed without the hook decision). Fix:
- Add basic type guards at each hook entry point: verify `tool_name` is a string, `tool_input` is a non-null object, `cwd` is a string
- On schema violation: log to stderr and exit 0 (allow) — never crash in a hook, as that could break the user's Claude session

**Tests:** Pass each hook `null`, `[]`, `{}`, and string values for required fields; verify it exits 0 gracefully.

---

#### 30f: LOW-3 — Manager ID/session validation in stop hook

**File:** `src/hooks/agent-status.ts`

`meta.manager` is used to path-join and read another agent's `meta.json`, then that agent's `tmux_session` is used in `Bun.spawn`. Add:
- `isValidAgentId(managerId)` check before `join(agentsDir, managerId)`
- `isValidTmuxSession(managerSession)` check before spawning

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

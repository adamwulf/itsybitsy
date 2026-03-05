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
- `ib watchdog` — the TUI's live state detection replaces the need for watchdog notifications
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
│   ├── index.ts           # CLI entrypoint: add/remove/list/watch/agents subcommands
│   ├── registry.ts        # Read/write ~/.itsybitsy.json
│   ├── registry.test.ts   # Registry unit tests (7 tests)
│   ├── agents.ts          # Read .ittybitty/agents/ + archive/ directly; types for Agent,
│   │                      # AgentState, FlatAgent; tree building; detectAgentStates();
│   │                      # reads user-questions.json; returns structured errors
│   ├── agents.test.ts     # Agent data layer tests (23 tests)
│   ├── parse-state.ts     # Port of ib's parse_state bash logic → TypeScript
│   ├── parse-state.test.ts # State detection tests (43 tests)
│   ├── watcher.ts         # fs.watch({ recursive: true }) on agents/, archive/,
│   │                      # user-questions.json; 10s fallback poll; debounced refresh
│   ├── tmux-poller.ts     # Polls tmux capture-pane for the selected agent (~1s interval);
│   │                      # also exports captureTmuxOutput() for one-shot state detection
│   ├── ib-commands.ts     # (Phase 5) Wrappers for ib mutations; cwd = repo root
│   ├── ghostty.ts         # (Phase 6) Open tmux sessions in Ghostty
│   └── tui/
│       ├── dashboard.ts   # Main TUI: agent tree + split pane + status bar
│       ├── split-pane.ts  # Custom horizontal layout (pi-tui Box is vertical-only)
│       └── ansi-validation.test.ts  # ANSI passthrough tests (7 tests)
├── PLAN.md
├── CLAUDE.md
└── package.json
```

Note: `watcher.ts` and `tmux-poller.ts` are split by concern — `watcher.ts` handles structural changes (agents added/removed/changed via `fs.watch` on `agents/`, `archive/`, `user-questions.json`) and detects state for ALL agents on each refresh; `tmux-poller.ts` handles live output capture for the SELECTED agent only (~1s poll). Different consumers, different error modes, different trigger conditions.

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
├── archive/                # Closed agents (hidden by default in TUI; toggle with `a`)
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

**Agent actions**
- `s` — send message to selected agent (dialog)
- `m` — merge agent (runs merge-check first; confirm dialog)
- `x` — kill agent (confirm dialog)
- `!` — force-kill / nuke agent (confirm dialog)
- `a` — new agent (dialog: repo, prompt, --worker/--yolo flags)
- `A` — toggle archived agents visibility
- `r` — reassign agent's manager (dialog) ← matches `ib watch`
- `R` — resume a stopped agent ← new, not in `ib watch`
- `G` — open agent's tmux session in Ghostty ← new, not in `ib watch` (`g` is taken by status)
- `w` — open agent worktree in Finder (`open {worktree}`)
- `o` — open diff in external tool: write `ib diff {id}` output to a temp file, then run `{diffTool} {tempfile}` where `diffTool` comes from `~/.itsybitsy.json`; show message if not configured
- `S` — capture tmux snapshot for debugging state detection: capture tmux output for selected agent, run `parseState` on it, write result to `.ittybitty/agents/{id}/debug-logs/snapshot-{timestamp}-{state}.txt`, show status message with filename. **Not** an `ib` subcommand — implement directly using `captureTmuxOutput()` + `parseState()`.
- `c` — clear errors (only active in ERRORS pane)
- `Enter` — answer selected question (only active in QUESTIONS pane)

**App**
- `h` — read-only help dialog showing all keybindings; press any key to dismiss. Not interactive settings.
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
- [ ] Orphan tmux session detection (deferred to Phase 4/5)

---

### Phase 3: Basic TUI Dashboard -- COMPLETE
**Checkpoint:** `itsybitsy watch` launches a live TUI with agent tree, state updates via fs.watch + tmux, split pane layout, and keybindings.

- [x] `src/tui/dashboard.ts` — agent tree at top (max 7 rows, scrolls with selection), split pane below (tmux left + cycling right pane)
- [x] Agent tree: recursive manager/child indentation, workers `⚙` vs managers `◆`, state color-coded, `a` to toggle archived
- [x] Right pane modes 0–7; `p`/`n` to cycle, direct jump keys `d`/`g`/`e`/`q`; mode persists across agent selection changes
- [x] Keyboard navigation: `j/k` or arrow keys; `;`/`l` scroll pane content
- [x] Watcher events wired to `tui.requestRender()`; TmuxPoller integrated for live output
- [x] Status bar with pending question count badge and keybinding hints
- [x] `Ctrl-C` to quit
- [x] **ANSI passthrough validated** — 7 tests in `ansi-validation.test.ts`

---

### Phase 4: Live Tmux Pane
**Checkpoint:** Selecting an agent shows its live Claude session output in a right-hand pane, updating every ~1s.

Note: `tmux-poller.ts` was implemented in Phase 2/3. Phase 4 focuses on rendering quality.

- [x] `src/tmux-poller.ts` — already implemented: polls at ~1s, race-condition guard, integrated into dashboard
- [x] Left pane: ANSI-aware line wrapping (`src/tui/wrap.ts`), scroll-back from bottom with `;`/`l`, auto-follow, display height computed from terminal size
- [x] Right pane mode 0 (AGENT LOG): reads `agent.log` from disk (async loading, handles missing/empty files)
- [x] Graceful display when tmux session doesn't exist: shows agent state, clear "No active tmux session" message for stopped/orphaned agents

---

### Phase 5.1: Core Agent Actions (Mutations)
**Checkpoint:** Kill, resume, merge, send, and new-agent all work from the TUI with confirm dialogs.

- [ ] `src/ib-commands.ts` — async wrappers for all `ib` mutations; **always sets `cwd` to the target repo root**; functions: `killAgent`, `nukeAgent`, `resumeAgent`, `reassignAgent`, `mergeAgent`, `mergeCheckAgent`, `sendMessage`, `newAgent`, `diffAgent`, `statusAgent`
- [ ] `x` — kill agent: confirm dialog showing agent ID, then `ib kill {id}`
- [ ] `!` — nuke/force-kill: confirm dialog, then `ib kill {id} --force`
- [ ] `R` — resume stopped agent: `ib resume {id}` (only enabled when agent is stopped/complete)
- [ ] `r` — reassign agent's manager: text input dialog, then `ib reassign {id} {new-manager}`
- [ ] `m` — merge agent: run `ib merge-check {id}` first, show result in confirm dialog, then `ib merge {id} --force`
- [ ] `s` — send message: text input dialog, then `ib send {id} "message"`
- [ ] `a` — new agent: repo selector (from registry) → prompt input → optional flags (`--yolo`, `--worker`, `--model`); shells to `ib new-agent`

---

### Phase 5.2: Right Pane Content
**Checkpoint:** All right pane modes show real content. Must be merged before Phase 5.3 begins (both phases touch dashboard.ts).

- [ ] Right pane mode 1 — INITIAL PROMPT: read `prompt.txt` from `.ittybitty/agents/{id}/prompt.txt`
- [ ] Right pane mode 2 — DENIALS: tool denials log (investigate source during implementation: likely filtered from `agent.log` by looking for "PreToolUse" hook lines)
- [ ] Right pane mode 3 — TREE: render full cross-repo agent tree as text (all repos, all agents, indented hierarchy)
- [ ] Right pane mode 4 — ERRORS: async errors collected by watcher; `c` to clear
- [ ] Right pane mode 5 — DIFF: `ib diff {id}` output, loaded async when pane is active
- [ ] Right pane mode 6 — STATUS: `ib status {id}` output, loaded async when pane is active
- [ ] `g` — STATUS pane in normal context; go-to-agent in QUESTIONS pane
- [ ] `q` — QUESTIONS pane; `Enter` to answer selected question via `ib send`; `ib acknowledge` to dismiss without answering
- [ ] `t` — cycle denials time filter (3 levels: all / last hour / last 10 min), only active in DENIALS pane

---

### Phase 5.3: Navigation & Remaining Keybindings
**Checkpoint:** Fuzzy navigation, questions workflow, and all remaining keybindings work. Requires Phase 5.2 to be merged first.

- [ ] `@` — fuzzy jump to agent by name (pi-tui SelectList dialog overlay)
- [ ] `/` — fuzzy jump to pane mode by name (pi-tui SelectList dialog overlay)
- [ ] `w` — open agent worktree in Finder: `Bun.$\`open ${agent.worktree}\``; show error if worktree doesn't exist
- [ ] `o` — open diff in external tool: write `diffAgent()` output to a temp file (`/tmp/itsybitsy-diff-{id}.txt`), run `{diffTool} {tempfile}`; show "No diff tool configured" message if `diffTool` not set in `~/.itsybitsy.json`
- [ ] `h` — read-only help dialog listing all keybindings; press any key to dismiss (use existing message dialog type)
- [ ] `S` — snapshot for debugging: call `captureTmuxOutput(agent.meta.tmux_session)`, run `parseState()` on stripped output, write full capture + state to `.ittybitty/agents/{id}/debug-logs/snapshot-{timestamp}-{state}.txt`, show status message. **Not** an `ib` subcommand — implement directly.

---

### Phase 6: Ghostty Integration & Distribution
**Checkpoint:** Production-ready single binary you can install and use daily.

- [ ] `src/ghostty.ts` — `ghostty --command="tmux attach -t {tmux_session}"`; detect if Ghostty is available; degrade gracefully
- [ ] `G` keybinding wired up — open selected agent's tmux session in Ghostty (`g` is reserved for STATUS pane / go-to-agent)
- [ ] `bun build --compile` produces a single self-contained binary
- [ ] README with install instructions and keybinding reference
- [ ] Polish error messages: missing `ib`/`tmux`, unreadable repos, malformed `meta.json`

---

### Phase 7 (v2): Cross-Repo Messaging
**Checkpoint:** An agent in repo A can send a message to an agent in repo B from within itsybitsy.

- [ ] Design message broker protocol (itsybitsy writes to destination `.ittybitty/` in `ib send` format)
- [ ] `E` keybinding — cross-repo send: pick destination repo + agent, enter message (`e` lowercase is ERRORS pane, `x` is kill-agent)
- [ ] No changes required to `ib` itself

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

**ANSI passthrough in pi-tui must be validated** before committing to Phase 4 — the `render(width): string[]` interface may or may not preserve ANSI sequences. Validate in Phase 3.

### pi-tui horizontal layout

The two-pane design (agent tree left, tmux output right) requires pi-tui `Box` to support horizontal side-by-side layout. **This must be validated in Phase 1** with a throwaway prototype before the design is locked in.

## File Layout

```
itsybitsy
├── src/
│   ├── index.ts           # CLI entrypoint: add/remove/list/watch subcommands
│   ├── registry.ts        # Read/write ~/.itsybitsy.json
│   ├── agents.ts          # Read .ittybitty/agents/ directly; types for Agent, AgentState
│   │                      # Also reads user-questions.json for pending questions
│   ├── parse-state.ts     # Port of ib's parse_state bash logic → TypeScript
│   ├── watcher.ts         # fs.watch({ recursive: true }) on .ittybitty/agents/;
│   │                      # emits agentAdded, agentChanged, agentRemoved events;
│   │                      # low-frequency fallback poll for macOS FSEvents reliability
│   ├── tmux-poller.ts     # Polls tmux capture-pane for the selected agent (~1s interval)
│   ├── ib-commands.ts     # Wrappers for ib mutations; always runs with cwd = repo root
│   ├── ghostty.ts         # Open tmux sessions in Ghostty
│   └── tui/
│       └── dashboard.ts   # Main TUI: agent tree + live tmux pane
├── PLAN.md
├── CLAUDE.md
└── package.json
```

Note: `watcher.ts` and `tmux-poller.ts` are split by concern — `watcher.ts` handles structural changes (agents added/removed/changed via `fs.watch`); `tmux-poller.ts` handles live output capture for the selected agent. Different consumers, different error modes, different trigger conditions.

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
  ]
}
```

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
| 2 — DENIALS | Tool denials log (parsed from `agent.log` or tmux output; source TBD during Phase 5 implementation) |
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
- `a` — new agent (dialog: repo, prompt, --yolo/--worker/--model)
- `r` — reassign agent's manager (dialog) ← matches `ib watch`
- `R` — resume a stopped agent ← new, not in `ib watch`
- `G` — open agent's tmux session in Ghostty ← new, not in `ib watch` (`g` is taken by status)
- `w` — open agent worktree in Finder (matches `ib watch`)
- `o` — open external diff tool if configured (matches `ib watch`)
- `S` — capture tmux snapshot for debugging state detection (matches `ib watch`)
- `c` — clear errors (only active in ERRORS pane)
- `Enter` — answer selected question (only active in QUESTIONS pane)

**App**
- `h` — open settings/setup dialog
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
- **Horizontal layout:** validate that `Box` supports side-by-side layout in Phase 1 prototype
- **ANSI passthrough:** validate that `Text`/`Box` preserve ANSI codes in Phase 3

## v2: Cross-Repo Messaging

Agents currently communicate via files in their own `.ittybitty/` dir.
itsybitsy can act as a message broker: write to the destination repo's `.ittybitty/`
in the same format that `ib send` uses. Does not require changes to `ib`.

## Phases

Each phase ends at a usable checkpoint — something that works and can be tested end-to-end.

---

### Phase 1: CLI Foundation
**Checkpoint:** `itsybitsy add/remove/list` works. You can register and inspect repos from the command line. pi-tui horizontal layout is validated.

- [ ] `src/index.ts` — CLI entrypoint, parse `add/remove/list/watch` subcommands
- [ ] `src/registry.ts` — read/write `~/.itsybitsy.json`; add, remove, list repos
- [ ] Wire up `itsybitsy add [path]`, `itsybitsy remove [path]`, `itsybitsy list`
- [ ] Unit tests for registry
- [ ] **Validate pi-tui horizontal Box layout** with a throwaway prototype — confirm side-by-side panes are possible before Phase 3 commits to the two-pane design

---

### Phase 2: Agent Data Layer
**Checkpoint:** `itsybitsy agents` (debug command) prints all agents across all registered repos with correct states — no TUI yet. Basic error handling in place.

- [ ] `src/agents.ts` — read `.ittybitty/agents/` directly; also scan `.ittybitty/archive/` for archived agents (include `archived: boolean` on the `Agent` type); define `Agent` and `AgentState` types; read `user-questions.json` for pending questions; detect orphan tmux sessions; compute `age` from `created_epoch` (don't leave date math to the TUI layer)
- [ ] `src/parse-state.ts` — port `parse_state` bash logic to TypeScript; all state rules
- [ ] `src/watcher.ts` — `fs.watch(path, { recursive: true })` on each repo's `.ittybitty/agents/`; emit `agentAdded`, `agentChanged`, `agentRemoved` events; `Promise.all` across repos; low-frequency fallback poll (10s) for macOS FSEvents reliability; **dynamic repo registration not supported while watch is running** — restart required after `itsybitsy add/remove`
- [ ] Basic error handling from the start: try/catch around all file reads, graceful degradation for missing/malformed `meta.json`, missing `ib`/`tmux` detected at startup
- [ ] Unit tests for `parse-state.ts` (it's pure string matching — highly testable)

---

### Phase 3: Basic TUI Dashboard
**Checkpoint:** `itsybitsy watch` launches a live TUI showing all agents across all repos, grouped by repo, with their states auto-updating via `fs.watch`.

- [ ] `src/tui/dashboard.ts` — main TUI layout: agent tree at top (scrolls with selection), split pane below (tmux left + cycling right pane)
- [ ] Agent tree: all agents across all repos, grouped by repo, recursive manager/child indentation, workers with distinct icon (`⚙`), state color-coded
- [ ] Right pane modes 0–7 (see layout table above); `p`/`n` to cycle, direct jump keys `d`/`g`/`e`/`q`; **right pane mode is global dashboard state** — persists across agent selection changes (user's pane choice is not reset when they navigate between agents)
- [ ] Keyboard navigation: `j/k` or arrow keys through agent tree; `;`/`l` scroll pane content
- [ ] Wire watcher events to TUI re-renders (`tui.requestRender()`)
- [ ] Status bar showing pending question count badge and available keybindings
- [ ] `Ctrl-C` to quit
- [ ] **Validate ANSI passthrough** in `Text`/`Box` components before Phase 4

---

### Phase 4: Live Tmux Pane
**Checkpoint:** Selecting an agent shows its live Claude session output in a right-hand pane, updating every ~1s.

- [ ] `src/tmux-poller.ts` — polls `tmux capture-pane -t {tmux_session} -p -S -100 -E -` for the selected agent; emits output events; pauses when no agent selected
- [ ] Left pane: render tmux output with ANSI passthrough (fixed ~60 col width, matching `ib watch`'s `TMUX_WIDTH`)
- [ ] Right pane mode 0 (AGENT LOG): render `agent.log` content
- [ ] Graceful display when tmux session doesn't exist (agent stopped or orphaned)

---

### Phase 5: Agent Actions
**Checkpoint:** All core `ib` actions are accessible from the TUI.

- [ ] `src/ib-commands.ts` — async wrappers for all `ib` mutations; **always sets `cwd` to the target repo root**
- [ ] `x` — kill agent (confirm dialog, matches `ib watch`)
- [ ] `!` — nuke/force-kill agent (confirm dialog, matches `ib watch`)
- [ ] `R` — resume stopped agent (`ib resume`)
- [ ] `r` — reassign agent's manager (dialog, matches `ib watch`)
- [ ] `m` — merge agent (run `ib merge-check` first; show result in confirm dialog)
- [ ] `s` — send message (dialog, matches `ib watch`)
- [ ] `a` — new agent dialog: repo selector, prompt input, `--yolo`/`--worker`/`--model` flags; shells to `ib new-agent`
- [ ] `d` — switch to DIFF pane (right pane mode 5, `ib diff` output)
- [ ] `g` — switch to STATUS pane (right pane mode 6) when in normal context; navigate to agent when in QUESTIONS pane
- [ ] `q` — switch to QUESTIONS pane (right pane mode 7); `Enter` to answer selected question via `ib send`; `ib acknowledge` to mark handled
- [ ] `t` — cycle denials time filter (3 levels, only active in DENIALS pane mode 2)
- [ ] Right pane mode 1 — INITIAL PROMPT: read `prompt.txt` directly
- [ ] Right pane mode 2 — DENIALS: tool denials log (investigate source during implementation: likely filtered from `agent.log`)
- [ ] Right pane mode 3 — TREE: full cross-repo agent tree
- [ ] Right pane mode 4 — ERRORS: async errors; `c` to clear
- [ ] `w` — open agent worktree in Finder (matches `ib watch`)
- [ ] `o` — open external diff tool if configured (matches `ib watch`)
- [ ] `@` — fuzzy jump to agent by name (dialog)
- [ ] `/` — fuzzy jump to pane mode (dialog)
- [ ] `h` — settings/setup dialog
- [ ] `S` — capture tmux snapshot for debugging (matches `ib watch`)

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
- [ ] `X` keybinding — cross-repo send: pick destination repo + agent, enter message (`x` is already kill-agent)
- [ ] No changes required to `ib` itself

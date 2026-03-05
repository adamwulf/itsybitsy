# itsybitsy — Plan

A cross-repo agent management dashboard for [ittybitty (`ib`)](https://github.com/anthropics/ittybitty), built with Bun and pi-tui.

## Problem

`ib watch` is scoped to a single repo. When running agents across multiple projects simultaneously, there's no unified view — you have to `cd` into each repo separately.

## Goals

This is a **full daily-driver replacement for `ib watch`**, extended to span multiple repos:

- **Unified dashboard** — see all agents across all registered repos in a single TUI
- **Agent tree** — show manager/parent/child relationships, not just a flat list
- **Live tmux output** — view the active Claude session for any agent (like `ib watch` does)
- **Live status** — auto-detect agent state by parsing tmux output (port `parse_state` from `ib`)
- **All `ib` actions** — kill, merge, send message, new-agent, diff, look (log), open in Ghostty
- **Ghostty integration** — open any agent's tmux session as a new Ghostty window
- **Easy distribution** — single compiled binary via `bun build --compile`
- **No browser UI** — terminal only

## Explicit Non-Goals (for now)

- No web/browser UI
- Cross-repo agent messaging (v2 — see below)

## Runtime & Dependencies

- **Runtime:** Bun (always use `bun`, never node/ts-node)
- **TUI:** `@mariozechner/pi-tui@0.56.0` (installed, on npm)
- **`ib`:** always use the version on `$PATH`; source lives at `~/Developer/bash/ittybitty/ib` (23,822-line bash script)
- **External deps:** `ib`, `tmux`, `git`, `claude` must be on `$PATH`

## Architecture

### Read vs. Write split

- **Read agent state:** read `.ittybitty/` files directly — faster than shelling to `ib list`
- **Mutations:** shell out to `ib` commands (`ib kill`, `ib merge`, `ib send`, `ib new-agent`, `ib diff`)
- **Never** reimplement tmux/git/worktree mutation logic from `ib`

### Update strategy

- `fs.watch` on each repo's `.ittybitty/agents/` for instant file-change events
- Poll `tmux capture-pane` every ~1s for the currently-selected agent's live output
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

## File Layout

```
itsybitsy
├── src/
│   ├── index.ts           # CLI entrypoint: add/remove/list/watch subcommands
│   ├── registry.ts        # Read/write ~/.itsybitsy.json
│   ├── agents.ts          # Read .ittybitty/agents/ directly; types for Agent, AgentState
│   ├── parse-state.ts     # Port of ib's parse_state bash logic → TypeScript
│   ├── watcher.ts         # fs.watch + tmux polling; emits state-change events
│   ├── ib-commands.ts     # Wrappers for ib kill/merge/send/new-agent/diff
│   ├── ghostty.ts         # Open tmux sessions in Ghostty
│   └── tui/
│       └── dashboard.ts   # Main TUI: agent tree + live tmux pane
├── PLAN.md
├── CLAUDE.md
└── package.json
```

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
├── archive/                # Closed agents
├── feedback.json
├── repo-id                 # Unique repo UUID (used in tmux session names)
├── reports/
├── STATUS.md
└── user-questions.json
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

`ib list --json` output format (for reference, prefer direct file reads):
```json
[{"id":"agent-1f5f04ce","state":"waiting","age":"1d","manager":"-","model":"sonnet","prompt":"..."}]
```

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

Left pane: agent tree grouped by repo, with state indicator and age.
Right pane: live tmux output for selected agent (updated every ~1s).
Bottom bar: keybinding hints for current context.

Key bindings (provisional):
- `j/k` or arrow keys — navigate agent list
- `Enter` — select / expand
- `n` — new agent (prompt for repo + task)
- `k` — kill selected agent
- `m` — merge selected agent
- `s` — send message to selected agent
- `d` — diff view for selected agent
- `g` — open in Ghostty
- `q` — quit

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

## v2: Cross-Repo Messaging

Agents currently communicate via files in their own `.ittybitty/` dir.
itsybitsy can act as a message broker: write to the destination repo's `.ittybitty/`
in the same format that `ib send` uses. Does not require changes to `ib`.

## Phases

Each phase ends at a usable checkpoint — something that works and can be tested end-to-end.

---

### Phase 1: CLI Foundation
**Checkpoint:** `itsybitsy add/remove/list` works. You can register and inspect repos from the command line.

- [ ] `src/index.ts` — CLI entrypoint, parse `add/remove/list/watch` subcommands
- [ ] `src/registry.ts` — read/write `~/.itsybitsy.json`; add, remove, list repos
- [ ] Wire up `itsybitsy add [path]`, `itsybitsy remove [path]`, `itsybitsy list`
- [ ] Unit tests for registry

---

### Phase 2: Agent Data Layer
**Checkpoint:** `itsybitsy list` (or a debug command) prints all agents across all registered repos with correct states — no TUI yet.

- [ ] `src/agents.ts` — read `.ittybitty/agents/` directly; define `Agent` and `AgentState` types
- [ ] `src/parse-state.ts` — port `parse_state` bash logic to TypeScript; all state rules
- [ ] `src/watcher.ts` — `fs.watch` on each repo's `.ittybitty/agents/`; emit `agentAdded`, `agentChanged`, `agentRemoved` events; `Promise.all` across repos
- [ ] Unit tests for `parse-state.ts` (it's pure string matching — highly testable)

---

### Phase 3: Basic TUI Dashboard
**Checkpoint:** `itsybitsy watch` launches a live TUI showing all agents across all repos, grouped by repo, with their states auto-updating via `fs.watch`.

- [ ] `src/tui/dashboard.ts` — main TUI layout skeleton using pi-tui
- [ ] Left pane: agent tree grouped by repo, showing `id`, `state`, `age`, `model`, truncated prompt
- [ ] Tree structure: manager agents at root, children indented beneath them
- [ ] State indicators (color-coded by state)
- [ ] Keyboard navigation: `j/k` or arrow keys to move through agent list
- [ ] Wire watcher events to TUI re-renders (`tui.requestRender()`)
- [ ] `q` to quit

---

### Phase 4: Live Tmux Pane
**Checkpoint:** Selecting an agent shows its live Claude session output in a right-hand pane, updating every ~1s.

- [ ] Right pane: `tmux capture-pane -t {tmux_session} -p -S -100 -E -` output rendered as scrollable text
- [ ] Poll every ~1s for the selected agent (only); pause polling when no agent selected
- [ ] ANSI passthrough so colors/formatting from Claude render correctly
- [ ] `Enter` to select agent / toggle focus between panes
- [ ] Graceful display when tmux session doesn't exist (agent stopped)

---

### Phase 5: Agent Actions
**Checkpoint:** All core `ib` actions are accessible from the TUI — kill, merge, send, new-agent, diff.

- [ ] `src/ib-commands.ts` — async wrappers for `ib kill`, `ib merge`, `ib send`, `ib new-agent`, `ib diff`
- [ ] `k` — kill selected agent (confirm prompt)
- [ ] `m` — merge selected agent (confirm prompt)
- [ ] `s` — send message to selected agent (inline input field)
- [ ] `d` — diff view: replace right pane with `ib diff` output for selected agent
- [ ] `n` — new agent: prompt for repo (if multiple registered) and task description; shell to `ib new-agent`
- [ ] `l` — look/log view: show `agent.log` for selected agent in right pane
- [ ] Status bar at bottom showing available keybindings for current context

---

### Phase 6: Ghostty Integration & Distribution
**Checkpoint:** Production-ready single binary you can install and use daily.

- [ ] `src/ghostty.ts` — `ghostty --command="tmux attach -t {tmux_session}"`; detect if Ghostty is available; degrade gracefully
- [ ] `g` keybinding — open selected agent's tmux session in Ghostty
- [ ] `bun build --compile` produces a single self-contained binary
- [ ] README with install instructions and keybinding reference
- [ ] Error handling: missing `ib`/`tmux`, unreadable repos, malformed `meta.json`

---

### Phase 7 (v2): Cross-Repo Messaging
**Checkpoint:** An agent in repo A can send a message to an agent in repo B from within itsybitsy.

- [ ] Design message broker protocol (itsybitsy writes to destination `.ittybitty/` in `ib send` format)
- [ ] `x` keybinding — cross-repo send: pick destination repo + agent, enter message
- [ ] No changes required to `ib` itself

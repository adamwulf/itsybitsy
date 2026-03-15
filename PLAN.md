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
- `ib config` — itsybitsy reads `~/.itsybitsy/config.json` directly rather than shelling to `ib config`

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

**Deterministic model (Phase 42):** Agent state is written to `meta.json` by the stop hook when Claude goes idle. Consumers read state from meta.json with two tmux-based overrides for transient states. See SPEC.md §1.3 for the full specification.

| State | Source | Written to meta.json? |
|---|---|---|
| `creating` | Derived from `created_epoch` (< 6s ago) | No |
| `running` | Written by stop hook (nudge case), `ib send`, `ib resume` | Yes |
| `waiting` | Written by stop hook (`last_assistant_message` ends with `WAITING`) | Yes |
| `complete` | Written by stop hook (`last_assistant_message` ends with `I HAVE COMPLETED THE GOAL`) | Yes |
| `compacting` | Tmux output: "Compacting conversation" in last 5 lines (display-only override) | No |
| `rate_limited` | Tmux output: rate limit patterns in last 15 lines (display-only override) | No |
| `stopped` | No tmux session exists, or agent is archived | No |

**State resolution order** (used by `detectAgentStates()`, `ib list`, `ib watch`, watchdog):
1. Archived → `stopped`
2. No tmux session → `stopped` (or `creating` if < 6s old)
3. Tmux compacting/rate_limited patterns → override to transient state
4. Read `state` from meta.json → use stored value (default `running` if absent)

**Legacy `parseState()`** — the 14-priority tmux pattern matching system remains in the codebase for backward compatibility with the bash reference implementation. It is no longer used for primary state detection in TS. Two targeted helper functions (`isCompacting()`, `isRateLimited()`) extract the relevant patterns for the transient override checks.

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
│   ├── config.ts             # Config reading/writing for ~/.itsybitsy/config.json (user-wide)
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
  "claude_pid": "31269",
  "state": "running",
  "state_updated_at": 1772579046
}
```

`state` is written by the stop hook, `ib send`, and `ib resume`. See SPEC.md §1.3.1. Absent on legacy agents (treated as `"running"` if agent is older than 6s).

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

User-wide `~/.itsybitsy/config.json` config (read `fps` field to inform polling rate):
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

Broadly matches `ib watch` layout and keybindings so existing users feel at home, with an extended sidebar layout.

### Current Layout (Phases 1–41)

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

### New Layout (Phase 42+)

```
┌──────────────┬──────────────────┬──────────────────────┐
│  LEFT SIDEBAR│                  │                       │
│  (60 cols)   │                  │                       │
│              │  live tmux       │  right pane (cycling) │
│  Agent Tree  │  output          │                       │
│  (compact)   │                  │                       │
│──────────────│                  │                       │
│  Info Panel  │                  │                       │
│  ● claude    │                  │                       │
│  ● watchdog  │                  │                       │
│  model: opus │                  │                       │
│  summary...  │                  │                       │
│──────────────│──────────────────│                       │
│  Coordinator │  > input field█  │                       │
│  Claude      │──────────────────│                       │
│  (tmux out)  │                  │                       │
└──────────────┴──────────────────┴──────────────────────┘
  status bar (2 lines)
```

Three-column layout: fixed 60-col sidebar | resizable tmux pane | cycling right pane. The sidebar stacks: compact agent tree, info panel, coordinator Claude. See SPEC.md §11–13 for full specification.

**Key differences from current layout:**
- Agent tree moves from full-width top to sidebar; uses compact format (icon + id + state + age; model/prompt in info panel)
- New info panel shows stoplight indicators (claude/watchdog process alive) and agent details
- New coordinator Claude panel at sidebar bottom — system-wide Claude session with ib:* permissions only
- Focus system: Tab/Shift+Tab cycles between agent-tree, coordinator, active-agent pane
- Input fields: when coordinator or active-agent has focus, a text input area appears at the bottom of the tmux pane; submit sends via `ib send` (agents) or `tmux send-keys` (coordinator)

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
- `Tab` / `Shift-Tab` — cycle focus between agent tree, coordinator, and active agent pane (Phase 42+). Previously: toggle between agent tree and questions list in QUESTIONS pane.

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
CLI entrypoint with `add/remove/list/watch/agents` subcommands, registry module for `~/.itsybitsy.json`, and custom `SplitPane` component (pi-tui Box is vertical-only). 7 registry tests.

---

### Phase 2: Agent Data Layer -- COMPLETE
Agent data reading from `.ittybitty/agents/` and `archive/`, full port of `parse_state` bash logic, `fs.watch` watcher with debounce and fallback poll, tmux poller with race-condition guard, orphan detection, and structured error reporting. 66 tests across agents/parse-state.

---

### Phase 3: Basic TUI Dashboard -- COMPLETE
Live TUI with agent tree (max 7 rows, scroll, recursive indentation), split pane (tmux left + cycling right pane with 8 modes), keyboard navigation, watcher integration, status bar with question badge, and ANSI passthrough validation.

---

### Phase 4: Live Tmux Pane -- COMPLETE
ANSI-aware line wrapping (`wrap.ts`), scroll-back from bottom, auto-follow, terminal-size-aware display height, and graceful handling of missing tmux sessions for stopped/orphaned agents.

---

### Phase 5.1: Core Agent Actions (Mutations) -- COMPLETE
All TUI agent actions with confirm/input dialogs: kill (`x`), nuke (`!`), resume (`R`), reassign (`r`), merge with merge-check (`m`), send message (`s`), new agent (`a`). All backed by `ib-commands.ts` wrappers with `cwd` set to repo root.

---

### Phase 5.2: Right Pane Content -- COMPLETE
All 8 right pane modes showing real content: agent log, initial prompt, denials with time filter, full tree, errors, diff, status, and questions with answer/acknowledge workflow.

---

### Phase 5.3: Navigation & Remaining Keybindings -- COMPLETE
Fuzzy jump to agent (`@`) and pane mode (`/`), open worktree in Finder (`w`), external diff tool (`o`), help overlay (`?`), and tmux snapshot for debugging (`S`).

---

### Phase 6: Ghostty Integration & Distribution -- COMPLETE
Ghostty integration (`G` key), `bun build --compile` binary, README, and polished error messages for missing dependencies.

---

### Phase 7: ib watch Parity — P0 -- COMPLETE
Fixed P0 parity gaps from deep `ib watch` analysis: tmux capture depth (500 lines), full-width pane modes, all-agent state polling (2s timer), Claude API usage display with color-coded footer, and flaky fs.watch test fix. Intentional deviation: `parseState()` checks active-running before tool-waiting (documented in `research/parity-check-logic.md`).

---

### Phase 8: Quick Wins — Commands & State Detection -- COMPLETE
Command fixes: nuke kills descendants, nuke-all emergency stop, `--manager` flag for agent hierarchy, dead-agent question filtering, pause agent (`P` key). State detection fixes: additional startup indicators, capture depth aligned to 500 lines, `compute_state_from_content` pre-check for creating state.

---

### Phase 9: Dashboard UX — Control Flow & Footer -- COMPLETE
Pane cycling skips empty panes, error count badge in footer, terminal title updates on selection, minimum terminal size warning (80x20), scroll step 10 lines, denial filter intervals changed to all/24h/7d. Update notification removed (false positives).

---

### Phase 10: Dashboard Rendering — Colorization & Layout -- COMPLETE
Orphan detection for agents with missing managers (`⚠` indicator) and orphaned tmux sessions (displayed in ERRORS pane with cleanup via Enter). Diff colorization (green/red/dim), agent log syntax highlighting (timestamps dim, brackets cyan). Top-anchored scroll direction for DIFF/ERRORS/STATUS/QUESTIONS panes. TREE pane shows truncated prompts.

---

### Phase 11: Dialog Improvements -- COMPLETE
Reassign uses fuzzy select list (filters out self and descendants). Send dialog supports `Ctrl-A` broadcast to all alive agents.

---

### Phase 12A: Setup Dialog — Hooks & Status (Tab 0) -- COMPLETE
`h` opens setup dialog with hooks status display and toggles (install/uninstall safety and intercept hooks), `.gitignore` and registry status indicators, and external diff tool editing. Help overlay moved from `h` to `?`.

---

### Phase 12B: Setup Dialog — Config Editing (Tabs 1 & 2) -- COMPLETE
`src/config.ts` module with `readConfig()`/`writeConfig()` for `~/.itsybitsy/config.json` (14 config keys with typed defaults). Setup dialog tab bar with Setup and Config tabs. Config tab renders editable select list with type-appropriate editors (number input, boolean toggle, string input, string[] add/remove).

---

### Phase 13: Code Quality & Architecture Cleanup -- COMPLETE
Replaced `__repo_<name>` dummy Agent hack with proper `FlatEntry` discriminated union (`kind: "agent" | "repo-header"`). Updated all consumers to branch on `kind`. Added tests for keychain fallback, color-scheme detection, and folder-browser permissions.

---

### Phase 14: CLI Parity — Native Implementations -- COMPLETE
All CLI commands implemented natively in `src/ib-commands.ts` with `src/agent-lifecycle.ts` helpers: send, kill, pause, resume, nuke, merge (with rebase conflict check), and new-agent (full creation flow). 658 tests across 19 files. Injectable SpawnFn pattern for testability.

### Phase 14.1: Fix Flaky Test -- COMPLETE
Fixed intermittent `fs.watch` test failure by increasing polling deadline (5s→8s) and test timeout (10s→15s) to account for macOS FSEvents latency under parallel load.

---

### Phase 15: Built-in Watchdog -- COMPLETE
`src/watchdog.ts` with 5s poll loop tracking state transitions across all agents. Handlers: waiting/unknown with exponential backoff notifications (30s→64m cap), complete one-time manager notification, rate limit bypass (Enter + usage API check), and auto-compact via transcript JSONL parsing with configurable threshold. Coexists with bash watchdog (duplicate notifications are harmless).

---

### Phase 16: Cross-Repo Messaging -- COMPLETE
`E` key opens multi-step dialog to send messages between agents across repos. Reuses existing `sendMessage()` with destination repo's path as `cwd`. No new file format needed.

---

### Phase 18: Wire CLI Commands to Native Implementations -- COMPLETE
All CLI subcommands (send, kill, merge, resume, new-agent, acknowledge) wired to native TypeScript implementations. `runIb()` deleted from `index.ts`. Native `acknowledgeQuestion()` implemented with tests.

---

### Phase 19: Native TUI Wrappers — reassign, mergeCheck, diff, status, acknowledge -- COMPLETE
All TUI wrappers reimplemented natively: `reassignAgent()` with full validation (circular deps, worker check, notifications), `mergeCheckAgent()` with structured result types, `diffAgent()`/`statusAgent()` via git commands. `runIb` infrastructure deleted from `ib-commands.ts`.

---

### Phase 20: Standalone Watchdog — `itsybitsy watchdog` Background Process -- COMPLETE
Standalone `ib watchdog` CLI process that reads agents from disk via `createDiskAgentProvider()` — no TUI dependency. Idempotent via `~/.itsybitsy/watchdog.lock` with PID-based stale detection. `newAgent()` spawns `ib watchdog` with `.unref()`. TUI inline watchdog removed.

---

### Phase 21: Native Agent Hooks — itsybitsy Subcommands -- COMPLETE
Seven hooks implemented natively as CLI subcommands: `hook-check-path` (path isolation), `hook-status` (stop hook with nudging), `hook-permission-denied` (denial logging), `hooks intercept-task` (Task interception), `hooks session-start` (context injection), `hooks main-path` (primary Claude path isolation), `hooks inject-status` (status injection). Full test coverage.

---

### Phase 22: Update Agent Settings to Use itsybitsy Hooks -- COMPLETE (obsolete)
Made obsolete by Phase 26a changing binary name to `ib`. Hook commands and permissions already reference `ib` correctly.

---

### Phase 23: Native Hooks Management -- COMPLETE
Native hook management functions in `ib-commands.ts` reading/writing `~/.claude/settings.json`: `hooksStatus`, `interceptHooksStatus`, `installSafetyHooks`, `uninstallSafetyHooks`, `installInterceptHook`, `uninstallInterceptHook`. Removed `Bun.which("ib")` startup guard.

---

### Phase 24: Final Cleanup & Validation -- COMPLETE (superseded by Phase 26)
Superseded by Phase 26a changing binary to `ib`. Zero `runIb()` references, all 956 tests passing, binary compiles correctly.

---

### Phase 26: Binary Distribution & Hook Wiring Fixes -- COMPLETE
Made `ib` binary a complete drop-in replacement for bash `ib`. Wired missing CLI commands (hooks main-path, inject-status, install/uninstall/status, nuke, merge-check, acknowledge). Moved hook installation from project-local to `~/.claude/settings.json` (global). Fixed hook detection to require `itsybitsy` prefix. Root cause of permission prompts was hooks exiting 1 on unrecognized subcommands.

---

### Phase 28: Watchdog Spawning Fixes -- COMPLETE
All agents get per-agent watchdogs (removed `if (manager)` guard). Watchdog spawn added to `resumeAgent()`. Global watchdog loop and dashboard indicator removed. (Superseded by Phase 39d for per-process architecture.)

---

### Phase 29: inject-status Flag Support -- COMPLETE
`hookInjectStatus()` supports `--full`, `--if-changed`, `--brief`, and `--visible` flags with SHA256 hash-based change detection cache. `--if-changed` outputs brief one-liner on state change, nothing if unchanged. `--visible` emits `systemMessage` for status bar. `hookEventName` read from stdin JSON.

---

### Phase 31: Parity Fixes — Hooks & Agent Status -- COMPLETE
Fixed hook divergences: delayed nudge recheck via detached `Bun.spawn`, tmux send-keys `-l` flag and split Enter, complete+unfinished children message with command suggestions, quoted `'WAITING'`/`'I HAVE COMPLETED THE GOAL'` in nudge messages, main-path comment stripping, inject-status question counts, and debug file content matching bash format.

---

### Phase 32: Parity Fixes — CLI Commands

**Status:** Complete (all should-fix items done; one nice-to-have remains).

**Source:** PARITY_HOOKS_TUI.md (sections 2.1–2.8)

**Goal:** Add missing CLI flags and commands to achieve feature parity with bash `ib`.

**Complexity:** Low-Medium per item — each is a self-contained addition.

#### 32a: Settings file location (nice-to-have / documentation)

**File:** `src/ib-commands.ts` (`installSafetyHooks`, `uninstallSafetyHooks`)

Bash writes hooks to `.claude/settings.local.json` (project-local). TS writes to `~/.claude/settings.json` (global). This was an **intentional** change in Phase 26c (not a bug). Global hooks mean itsybitsy's safety hooks apply to all Claude sessions, not just the itsybitsy project.

- [x] Document this intentional divergence in a comment in `ib-commands.ts` so future developers understand the choice — done at `src/ib-commands.ts:2356-2363`
- [ ] Consider adding a `--local` flag to allow project-scoped installation if desired — nice-to-have, not implemented

#### 32b: `ib list --json` (nice-to-have)

**File:** `src/index.ts` (list command)

- [x] Add `--json` flag that outputs agent data as a JSON array for scripting — done at `src/index.ts:133,142-173`

#### 32c: `ib look --follow` (should-fix)

**File:** `src/index.ts` (look command)

- [x] Add `--follow` flag that runs `tmux attach -r -t <session>` for live read-only view — done at `src/index.ts:376,382-395`

#### 32d: `ib diff --stat` (nice-to-have)

**File:** `src/index.ts` (diff command)

- [x] Add `--stat` flag that runs `git diff --stat "$MERGE_BASE..$BRANCH"` (stat of merge-base range, matching bash behavior) instead of full diff — done at `src/index.ts:464` and `src/ib-commands.ts:1972-1974`

#### 32e: `ib status` improvements (should-fix)

**File:** `src/ib-commands.ts` (`statusAgent`)

- [x] Add header with agent ID, branch name, worktree path — done at `src/ib-commands.ts:1996-1999`
- [x] Use `git merge-base` with the parent branch (derived from `meta.json`'s `manager` field) — done at `src/ib-commands.ts:1992,2002`
- [x] Add section headers (e.g., `═══ Commits (N) vs <parent-branch> ═══`) — done at `src/ib-commands.ts:2009,2014`
- [x] Add `git diff --stat` summary — done at `src/ib-commands.ts:2029-2033`

#### 32f: `ib send --from` (should-fix)

**File:** `src/index.ts`

- [x] Add `--from <id>` flag parsing in the `send` case in `index.ts` — done at `src/index.ts:479-489`
- [x] Pass the parsed value to the existing `sendMessage(agent, message, { fromAgent })` parameter — done at `src/index.ts:507`

#### 32g: Other missing CLI commands (nice-to-have)

**File:** `src/index.ts`

- [x] `ib log <message>` — write to agent log from CLI — done at `src/index.ts:707-758`
- [x] `ib new-agent --prompt-file <path>` — read prompt from file — done at `src/index.ts:606-612`
- [x] `ib parse-state` — debug command for state parsing — done at `src/index.ts:760-797`
- [x] `ib questions --all` — show acknowledged questions — done at `src/index.ts:437,444-446`
- [ ] `ib status --json` — bash supports JSON output for status (nice-to-have, analogous to `ib list --json`) [^needs review] Not implemented; SPEC.md does not mention `--json` for `ib status` either, so this is a bash-only feature gap
- [x] `ib diff` — uses parent branch from `meta.json` manager field instead of hardcoding `main` — done at `src/ib-commands.ts:1964`

---

### Phase 33: Parity Fixes — TUI Watch Features -- COMPLETE
Permissions editor with Allow/Deny tab switching in setup dialog. All other items (keybindings, usage tracking) confirmed already implemented during audit.

---

### Phase 34: Code Quality & Dead Code Cleanup

**Status:** Partially complete (4 of 9 sub-phases done; 2 partially done; 3 not started).

**Source:** CODE_REVIEW.md

**Goal:** Address code quality issues, remove dead code, improve type safety, and reduce code duplication.

**Complexity:** Low-Medium — mostly mechanical refactoring.

#### 34a: Fix duplicate `merge-check` case in CLI (high priority) ✅

**File:** `src/index.ts`

The duplicate `merge-check` case has been removed. Only one instance remains at line 528.

- [x] Remove the dead duplicate case
- [x] Verify the remaining case has the correct implementation

#### 34b: Consolidate spawn runner injection (medium priority) — Partially complete

**Files:** `src/ib-commands.ts`, `src/agent-lifecycle.ts`, `src/watchdog.ts`, `src/tmux-poller.ts`, `src/usage.ts`, `src/auto-compact.ts`, `src/ghostty.ts`

A `SpawnContext` class was introduced in `src/types.ts` with a shared `runCmd()` helper that drains both stdout and stderr via `Promise.all`. `ib-commands.ts` now uses 5 named `SpawnContext` instances (`killPauseSpawnCtx`, `nukeResumeSpawnCtx`, `mergeSpawnCtx`, `sendSpawnCtx`, `newAgentSpawnCtx`, `diffStatusSpawnCtx`). However, `tmux-poller.ts`, `agent-lifecycle.ts`, `usage.ts`, `ghostty.ts`, and `tui/color-scheme.ts` still use the old module-level `set*/reset*` pattern with bare variables.

- [x] Design a single DI pattern — `SpawnContext` class in `src/types.ts`
- [ ] Consolidate all spawn runners into the shared pattern — `ib-commands.ts` migrated; `tmux-poller.ts`, `agent-lifecycle.ts`, `usage.ts`, `ghostty.ts`, `color-scheme.ts` still use old pattern
- [ ] Update all tests to use the unified pattern

#### 34c: Consolidate `runCmd` helpers (low priority) — Partially complete

**Files:** `src/ib-commands.ts` (4 variants: `nukeResumeRunCmd`, `mergeRunCmd`, `newAgentRunCmd`, `diffStatusRunCmd`), `src/agent-lifecycle.ts` (1 variant)

A shared `runCmd()` was extracted to `src/types.ts` and all 5 wrappers now delegate to `SpawnContext.run()` which calls that shared helper. The wrappers still exist as thin one-liners (e.g., `nukeResumeRunCmd` → `nukeResumeSpawnCtx.run(cmd)`), but the core drain logic is unified. The deadlock risk is eliminated since the shared helper uses `Promise.all`.

- [x] Extract a shared `runCmd` helper that drains both stdout and stderr via `Promise.all`
- [ ] Replace all 5 variants with calls to the shared helper — wrappers still exist as thin delegates; could be inlined but functional correctness is achieved

#### 34d: Extract shared constants (low priority) ✅

**File:** `src/hooks/shared.ts`

`AGENT_CWD_PATTERN` has been extracted to `src/hooks/shared.ts` with the capturing-group version. All three hook files (`intercept-task.ts`, `inject-status.ts`, `session-start.ts`) now import from `shared.ts`.

- [x] Extract to `src/hooks/shared.ts` — canonical capturing-group version, all consumers updated

#### 34e: Fix `as any` in production code (medium priority) ✅

**File:** `src/ib-commands.ts`

No `as any` casts remain in `src/ib-commands.ts`. The settings access has been rewritten with typed access.

- [x] Define a proper interface for the settings file structure
- [x] Replace `as any` with typed access

#### 34f: Rename conflicting `AgentProvider` type (low priority) ✅

**Files:** `src/watchdog.ts`, `src/hooks/inject-status.ts`

`inject-status.ts` now uses `AgentDataSource` (exported at line 156). `watchdog.ts` retains `AgentProvider` (line 35). No name conflict remains.

- [x] Rename one — `inject-status.ts` now uses `AgentDataSource`

#### 34g: Audit catch blocks without error binding (low priority) — Not started

**Files:** Multiple — 142 `catch {` blocks (without error variable) across 23 files (up from 128 at time of review)

Note: these are NOT empty — most have meaningful bodies (`return`, `continue`, comments). The issue is that they don't capture the error, making it impossible to distinguish expected errors (ENOENT) from unexpected ones. Many already have explanatory comments; the gap is the ones that silently swallow unexpected errors.

- [ ] Audit `catch {` blocks that have no explanatory comment — add `/* expected: ... */` or `/* todo: log */`
- [ ] Consider logging non-ENOENT errors to stderr or agent.log in critical paths

#### 34h: Fix stderr deadlock in runCmd variants (medium priority) ✅

**Files:** `src/ib-commands.ts`, `src/agent-lifecycle.ts`

All `runCmd` variants now delegate to `SpawnContext.run()` (or the shared `runCmd()` in `types.ts`), which drains both stdout and stderr via `Promise.all`. The deadlock risk is eliminated. Resolved as a side effect of the `SpawnContext` migration in 34b/34c.

- [x] Drain both stdout and stderr with `Promise.all` in all runCmd variants

#### 34i: Use `sed` alternative for JSON modification in start.sh/resume.sh (low priority) ✅

**Files:** `src/ib-commands.ts:391` (start script heredoc), `src/ib-commands.ts:1696` (resume script heredoc)

Both occurrences now use `bun -e` one-liners that properly parse, modify, and rewrite `meta.json` with `JSON.parse`/`JSON.stringify` instead of `sed`. This handles nested objects and formatted JSON correctly.

- [x] Replace both occurrences with a bun one-liner — done

---

### Phase 35: Test Coverage Improvements -- COMPLETE
CLI entrypoint tests (subprocess-based integration tests for all commands), TUI module tests (`agent-actions`, `pane-manager`, `dialog-handler`), test infrastructure improvements (`setAgentState`, `makeSpawnResult`, `mockFetch` helpers), thorough `readAgentMeta` validation with type guards and defaults, and `validateConfigValue` runtime type validation with fallback to defaults.

---

### Phase 36: Watchdog & Lifecycle Improvements -- PARTIALLY COMPLETE

**Status:** 36a partial, 36b complete, 36c complete.

**Source:** PARITY_LIFECYCLE.md, CODE_REVIEW.md

**Goal:** Address watchdog correctness issues and lifecycle gaps.

**Complexity:** Low-Medium.

#### 36a: Watchdog lock file atomicity (medium priority) -- PARTIALLY COMPLETE

**File:** `src/watchdog.ts:453-511`

TOCTOU race: read lock → check PID → write PID. Two processes could acquire simultaneously.

- [x] Use `O_EXCL` flag for atomic lock file creation (`atomicCreateLock()` at L453 uses `O_CREAT | O_EXCL | O_WRONLY`; `acquireWatchdogLock()` at L464 calls it, falling back to stale-PID check + retry)
- [x] ~~Or use advisory file locking as an alternative~~ (O_EXCL approach chosen)
- [ ] Migrate `releaseWatchdogLock` and `readLockPid` from `node:fs` sync APIs (`readFileSync`, `unlinkSync`) to `Bun.file()`/`Bun.write()` for consistency (L1 from CODE_REVIEW.md) — these two functions don't need `O_EXCL` and can be fully migrated. Note: `isWatchdogLockHeld` was renamed to `readLockPid` during implementation. [^needs review] Still uses `readFileSync`/`unlinkSync` from `node:fs` at L491-510; not a correctness issue but a consistency gap vs project convention of preferring Bun APIs.

#### 36b: Watchdog debug logs on unknown state (nice-to-have) -- COMPLETE

**File:** `src/watchdog.ts:255-299`

Bash watchdog saves tmux output to `debug-logs/watchdog-<timestamp>-unknown.txt` on unknown state. TS now matches.

- [x] Save debug log on first transition to unknown state (`handleUnknown` at L255 checks `tracker.previousState !== "unknown"`, calls `saveUnknownDebugLog` which captures tmux output)
- [x] Use same `debug-logs/` directory pattern as bash (`debug-logs/watchdog-<timestamp>-unknown.txt` at L290-294)

#### 36c: Model context size configuration (low priority) -- COMPLETE

**File:** `src/auto-compact.ts:39-78`

**Note:** This is a code quality improvement, not a parity issue — bash uses the same substring matching approach.

- [x] Log a warning when falling back to default for an unknown model (L72-76: logs once per model via `warnedModels` Set, `resetWarnedModels()` exported for testing)
- [x] Context sizes moved to a named lookup table `MODEL_CONTEXT_SIZES` (L47-55) for easier maintenance
- **Note:** The explicit Claude 4.6 branches (L50-51) return 200K — the same as the default. Effectively redundant but serves as documentation that 4.6 was explicitly considered.

---

### Phase 37: State Detection & Watchdog Parity Fixes -- COMPLETE
Added `isRecentlyCreated()` helper with 6s grace period for `creating` state on missing tmux. Resume watchdog spawn guarded by manager check. SPEC.md callouts #1 and #4 resolved.

---

### Phase 38: Message Passing & Question Parity Fixes -- COMPLETE
Unfinished children check uses tmux state (not dir existence). `ib send` accepts stdin piping. `ib ask` command implemented with top-level check, config check, stale cleanup, and question ID hashing. Removed redundant `acknowledged: true` field. Acknowledge output matches bash hint. SPEC.md callouts #8, #11–14 resolved.

---

### Phase 39: Config, ID Resolution, Spec Clarification & Per-Process Watchdog

**Status:** Complete.

**Source:** SPEC.md callouts #16, #17, #18, #21.

**Goal:** Fix config default logic, ID resolution, reframe the §7.3 permission spec to reflect correct intended behavior, and migrate the TS watchdog from a global loop to per-agent processes that mirror bash.

**Complexity:** Medium (39d is the most complex).

#### 39a: Config model default matches bash order

**File:** `src/config.ts`

**SPEC.md:** §7.2, line ~589

Bash `load_config()` defaults `CONFIG_MODEL` to `""` (empty string) at load time and falls back to `"sonnet"` at spawn time. TS `readConfig()` defaults `model` to `"sonnet"` at the config layer, so it's always `"sonnet"` even when not set.

While the effective behavior is the same, the logic should match:
- [ ] Default `model` to `""` (empty string) in the config defaults/schema
- [ ] In `newAgent()` (or wherever model is passed to claude), fall back to `"sonnet"` if model is empty
- [ ] Update SPEC.md §7.2 to remove the `[^callout]`, describe both bash and TS as defaulting at spawn time

#### 39b: §7.3 Permission resolution — correct intended behavior (spec update only)

**File:** `SPEC.md` only

**SPEC.md:** §7.3, line ~609

The current spec documents bash's fallthrough behavior as-if it is intended design. It is not — bash falls through from worker to manager permissions when `CONFIG_WORKER_ALLOW` is empty (confirmed at `ib:3565–3571`), but this is a bash quirk the user did not intend.

Intended behavior: manager and worker permissions are loaded strictly from their own config keys. There is no fallthrough between types.

- [ ] Rewrite §7.3 step 4 to describe the correct intended behavior: "Workers use `permissions.worker.allow/deny`; managers use `permissions.manager.allow/deny`. There is no fallthrough between types."
- [ ] Add a `[^callout]` noting that bash has a quirk: if `CONFIG_WORKER_ALLOW` is empty, it falls through to `CONFIG_MANAGER_ALLOW`. TS intentionally does not replicate this.

#### 39c: `resolveAgentId` scans tmux sessions and lists ambiguous matches

**File:** `src/agents.ts` (`resolveAgentId` or equivalent)

**SPEC.md:** §8.1, line ~634

Bash resolution:
1. Exact match — check agent directory AND tmux session
2. Substring match — scan all agent directories AND tmux sessions
3. 0 matches → error. 1 match → use it. 2+ matches → error listing all matching IDs.

TS currently only scans agent directories and returns `null` for 0 or 2+ matches without listing what matched.

- [ ] Extend resolution to also scan active tmux sessions (names starting with `ittybitty-`) for both exact and substring matches
- [ ] On 2+ matches, return/throw an error that lists all matching IDs (same as bash output)
- [ ] Add tests for the tmux-session-only match case and ambiguous match listing
- [ ] Update SPEC.md §8.1 to remove the `[^callout]`

#### 39d: Per-process watchdog (one process per agent) -- COMPLETE

**Files:** `src/watchdog.ts`, `src/ib-commands.ts`, `src/index.ts`, `src/tui/dashboard.ts`

**SPEC.md:** §8.5

Migrated TS to per-agent watchdog model matching bash:
- [x] `ib watchdog <id>` runs a self-contained loop for a single agent, exiting when worktree is removed or tmux gone >10s
- [x] `newAgent()` spawns `ib watchdog <id>` for ALL agents (not just sub-agents) — watchdog PID saved to `meta.json`
- [x] `resumeAgent()` likewise spawns `ib watchdog <id>` for ALL agents — watchdog PID saved to `meta.json`
- [x] Removed global watchdog loop (`startWatchdog`/`stopWatchdog`/`tick`/`processAgents`/lock file) from `src/watchdog.ts`
- [x] Removed `isWatchdogRunning()` and `[watchdog]` indicator from dashboard
- [x] `ib watchdog` CLI now requires an agent ID (no global mode)
- [x] Updated SPEC.md §8.5 to describe per-agent watchdog architecture
- [x] Added `watchdog_pid` field to `AgentMeta`

---

### Phase 40: Rate Limit, Reassign, and Post-Create Hook Parity

**Status:** Complete.

**Source:** SPEC.md callouts #22, #24, #25, #26.

**Goal:** Fix rate-limit bypass retry logic, reassign validation and notification gaps, meta.manager null handling, and post-create hook output capture. After each fix, update SPEC.md to remove the `[^callout]`.

**Complexity:** Low–Medium.

#### 40a: Rate limit bypass matches bash 3-attempt retry loop

**File:** `src/watchdog.ts`

**SPEC.md:** §8.5 Watchdog table, `rate_limited` row

Bash uses a synchronous 3-attempt retry loop: sends Enter, waits 2s, checks `parse_state`, repeats up to 3 times. TS sends a single Enter on first detection (`rateLimitBypassed` flag) and relies on the 5s poll cycle for retry.

- [ ] Implement a 3-attempt retry loop: send Enter, wait 2s, capture tmux output, check state via `parseState`, repeat if still `rate_limited`
- [ ] Only set `rateLimitBypassed` (or equivalent cooldown flag) after the loop completes
- [ ] Add tests covering the retry behavior
- [ ] Update SPEC.md §8.5 rate_limited row to remove the `[^callout]`

#### 40b: `reassignAgent` missing validations

**File:** `src/ib-commands.ts` (`reassignAgent`)

**SPEC.md:** §8.6 (or wherever reassign is documented)

TS is missing:
- Validation #3: self-reassign check (agent reassigned to itself as manager) → error
- Validation #7: no-op same-parent check (new manager == current manager) → error

- [ ] Add self-reassign check: if `newManagerId === agentId`, return error
- [ ] Add same-parent check: if `newManagerId === agent.manager`, return error
- [ ] Add tests for both rejected cases
- [ ] Update SPEC.md to remove the `[^callout]`

#### 40c: `reassignAgent` meta.manager and notification parity

**File:** `src/ib-commands.ts` (`reassignAgent`), and anywhere `meta.manager` is read

**SPEC.md:** §8.6

Three divergences to fix:

1. **`meta.manager` null vs `""`**: When reassigning with `--none` (top-level), bash sets `meta.manager` to `null`. TS sets it to `""` (empty string). Fix TS to use `null`. Then audit all TS code that reads `meta.manager` and ensure it handles both `null` and `""` defensively (for backwards compat with existing agent files that may have `""`).

2. **Notification messages**: Update TS notification messages to match bash:
   - Old manager: `"[watchdog]: Agent <id> has been reassigned away from you to <new-manager-id>"` (or `"to top-level"` if no new manager)
   - New manager: `"[watchdog]: Agent <id> has been reassigned to you from <old-manager-id>"` (or `"from top-level"`)

3. **Agent self-notification**: After reassignment, send a message to the reassigned agent itself notifying it of the change (step 5 in bash — currently skipped in TS).

- [ ] Fix `meta.manager` to write `null` instead of `""`
- [ ] Audit all reads of `meta.manager` in the codebase — handle `null | "" | undefined` consistently
- [ ] Update notification messages to match bash format
- [ ] Add agent self-notification step
- [ ] Add tests
- [ ] Update SPEC.md §8.6 to remove the `[^callout]`

---

### Phase 41: Agent Prompt Summary Generation -- COMPLETE
Background `claude -p` with Haiku generates ~30-word summary on agent creation, stored as `summary` in meta.json. TUI agent list displays `summary ?? prompt`. Silently skips on failure.

---

### Phase 42: Deterministic Agent State Tracking -- COMPLETE
Stop hook writes authoritative state (`running`/`waiting`/`complete`) to meta.json with atomic writes (temp+rename). `ib send` and `ib resume` write `state: "running"`. `detectAgentStates()` reads from meta.json with tmux overrides for `compacting`/`rate_limited` only. `creating` derived from `created_epoch`, `stopped` from tmux absence. `unknown` state eliminated. `parseState()` retained as legacy. Legacy agents self-migrate on next idle event. Watchdog and `findUnfinishedChildren()` updated to use meta.json state.

---

### Phase 42: Sidebar Layout & Compact Agent Tree

**Status:** Not started.

**Goal:** Restructure the TUI from a top-tree / bottom-split layout to a sidebar / main-area layout. The sidebar is a fixed 60-column vertical stack. The main area retains the existing split-pane (tmux left + cycling right pane). See SPEC.md §11 for full specification.

**Complexity:** High — this is a significant restructuring of the dashboard component hierarchy and render pipeline.

#### 42a: SidebarComponent

**Files:** `src/tui/sidebar.ts` (new), `src/tui/dashboard.ts`

Create a new `SidebarComponent` that renders three vertically stacked sections:

- [x] Define `SidebarComponent implements Component` with `render(width: number): string[]`
- [ ] Render three sections separated by horizontal rules: agent tree (top), info panel (middle), placeholder for coordinator (bottom)
- [ ] Each section has a header line (e.g., `──── Agents ────`, `──── Info ────`, `──── Coordinator ────`)
- [ ] The sidebar is always exactly 60 columns wide
- [ ] Height allocation: agent tree gets up to `MAX_TREE_HEIGHT` (7) rows; coordinator gets ~40% of remaining height (minimum 5 rows); info panel fills the rest

#### 42b: Compact agent tree format

**Files:** `src/tui/agent-tree.ts`

Modify `formatAgentRow()` to support a compact mode for sidebar rendering:

- [ ] New compact format: `icon agent-id  state  age` — omit model and prompt/summary columns
- [ ] Compact mode activated when rendering width ≤ 60
- [ ] Repo headers unchanged: `▾ repo-name` / `▸ repo-name`
- [ ] Update `computeStateColWidth()` and column width calculations for compact mode
- [ ] Tests for compact format rendering at various widths

#### 42c: InfoPanelComponent

**Files:** `src/tui/info-panel.ts` (new)

Create a new component that displays details for the currently selected agent or repo:

- [ ] `InfoPanelComponent implements Component` with `render(width: number): string[]`
- [ ] Agent selected: show stoplight indicators (● Claude: green/red, ● Watchdog: green/red), model name, summary or prompt text wrapped to width
- [ ] Repo header selected: show repo path, agent count, per-state breakdown
- [ ] Stoplight checks: `process.kill(pid, 0)` wrapped in try/catch to determine PID liveness from `meta.json` `claude_pid` and `watchdog_pid` fields
- [ ] No focus, no interactive elements — purely display
- [ ] Tests for both agent and repo-header display modes, PID liveness edge cases

#### 42d: Dashboard layout restructure

**Files:** `src/tui/dashboard.ts`

Restructure `DashboardComponent.render()` to use the new sidebar layout:

- [ ] Replace the current layout (header → tree → separator → split-pane → separator → status) with: header → outer-split-pane(sidebar | inner-split-pane(tmux | right-pane)) → status
- [ ] The outer split pane has a fixed left width of 60 (sidebar) and the right side is the existing `this.splitPane` (tmux + right pane)
- [ ] Wire `SidebarComponent` into the outer split pane's left side
- [ ] Wire agent tree data flow to the sidebar's agent tree
- [ ] Wire selected agent data to the info panel
- [ ] Set `displayHeight` for all components based on terminal size minus header/status chrome
- [ ] Full-width pane modes (DIFF, DENIALS, TREE, ERRORS, QUESTIONS) still hide the tmux pane but should span the entire main area (not the sidebar)
- [ ] TREE mode: the full-width tree (not compact) uses the main area, while the sidebar still shows the compact tree
- [ ] Separator junction characters (┬, ┴, ┤, ├) at sidebar/main boundary
- [ ] Tests for layout rendering at various terminal sizes

#### 42e: Update keybindings for sidebar layout

**Files:** `src/tui/dashboard.ts`

Adjust keybindings affected by the layout change:

- [ ] `[`/`]` resize keys now resize the tmux/right-pane split within the main area (sidebar width is fixed)
- [ ] Status bar hints updated to reflect any changed keybindings
- [ ] Help dialog (`?`) updated with new layout description
- [ ] Minimum terminal width check: increase from 80 to 140 columns (60 sidebar + 80 main area minimum)

---

### Phase 43: Focus System & Input Fields

**Status:** Not started.

**Goal:** Add a focus cycling system with Tab/Shift+Tab and input fields for message composition. See SPEC.md §13 for full specification.

**Depends on:** Phase 42 (sidebar layout must exist).

**Complexity:** Medium-High — new input routing layer, careful keyboard handling.

#### 43a: FocusManager

**Files:** `src/tui/focus.ts` (new), `src/tui/dashboard.ts`

Create a focus management system:

- [ ] Define `FocusTarget = "agent-tree" | "coordinator" | "active-agent"`
- [ ] `FocusManager` class: tracks current focus, exposes `cycle(delta: 1 | -1)`, `current()`, `setFocus(target)`
- [ ] Focus order: `agent-tree` → `coordinator` → `active-agent` → (wrap)
- [ ] Default focus on startup: `agent-tree`
- [ ] Tests for cycling forward/backward, wrapping

#### 43b: InputFieldComponent

**Files:** `src/tui/input-field.ts` (new)

Create an input field component for message composition:

- [ ] `InputFieldComponent implements Component` with `render(width: number): string[]`
- [ ] Renders 3 lines: top separator (`────────`), input line (`> text█`), bottom separator
- [ ] `handleInput(data: string): boolean` — returns true if input was consumed
- [ ] Supports: printable characters, backspace, Ctrl-A (home), Ctrl-E (end), Ctrl-U (clear line)
- [ ] `onSubmit` callback: fires on Enter with the current text, then clears the field
- [ ] `onCancel` callback: fires on Escape
- [ ] Tests for text editing, submission, cancellation

#### 43c: Focus-aware keyboard routing

**Files:** `src/tui/dashboard.ts`

Restructure `handleInput()` to route based on focus state:

- [ ] Tab → `focusManager.cycle(1)`, Shift+Tab → `focusManager.cycle(-1)` — replaces the old tree/questions toggle
- [ ] When focus is `agent-tree`: existing keybinding behavior (j/k, p/n, action keys, etc.)
- [ ] When focus is `coordinator` or `active-agent`: route printable/editing keys to the input field; suppress dashboard action keys (s, m, x, etc.); Tab/Shift+Tab still cycle; Escape returns focus to `agent-tree`
- [ ] Focus visual indicator: highlight the focused panel's separator/header (bold or colored), dim unfocused panels
- [ ] Tests for keyboard routing in each focus state

#### 43d: Wire input field to tmux pane

**Files:** `src/tui/dashboard.ts`, `src/tui/split-pane.ts`

Integrate the input field into the tmux pane area:

- [ ] When `active-agent` has focus and an agent is selected: render input field at the bottom of the tmux pane area (subtract 3 lines from `tmuxPane.displayHeight`)
- [ ] On submit: call `sendMessage(repoPath, agentId, text)` to deliver the message via `ib send`
- [ ] On cancel (Escape): clear input, return focus to `agent-tree`
- [ ] When focus leaves `active-agent`: hide the input field, restore full tmux display height
- [ ] Tests for input field visibility toggling, message submission

#### 43e: Wire input field to coordinator panel

**Files:** `src/tui/sidebar.ts`, `src/tui/dashboard.ts`

Integrate the input field into the coordinator section of the sidebar:

- [ ] When `coordinator` has focus: render input field at the bottom of the coordinator section (subtract 3 lines from coordinator display height)
- [ ] On submit: send via `tmux send-keys -t ib-coordinator -l "<message>"` followed by a separate `tmux send-keys -t ib-coordinator Enter`
- [ ] On cancel: clear input, return focus to `agent-tree`
- [ ] When focus leaves `coordinator`: hide the input field, restore full coordinator display height
- [ ] Tests for coordinator input submission

---

### Phase 44: Coordinator Claude Session

**Status:** Not started.

**Goal:** Auto-spawn and manage a system-wide coordinator Claude Code session. See SPEC.md §12 for full specification.

**Depends on:** Phase 42 (sidebar with coordinator panel), Phase 43 (focus system with input field).

**Complexity:** Medium — tmux session lifecycle management, permissions configuration, second TmuxPoller instance.

#### 44a: Coordinator session lifecycle

**Files:** `src/coordinator.ts` (new)

Implement coordinator session spawn/teardown:

- [ ] `ensureCoordinatorSession(): Promise<string>` — checks if `ib-coordinator` tmux session exists; if not, creates it with `tmux new-session -d -s ib-coordinator -c ~/.itsybitsy/`
- [ ] Write a minimal `~/.itsybitsy/.claude/settings.local.json` with coordinator permissions (only `Bash(ib:*)`, deny everything else)
- [ ] Start Claude Code inside the session: `tmux send-keys -t ib-coordinator 'claude --model opus "You are the itsybitsy coordinator..."' Enter`
- [ ] `killCoordinatorSession(): Promise<void>` — checks if other `ib watch` instances are attached; if not, kills the session. Detection: `tmux list-clients -t ib-coordinator` to check for other attached clients (or use a simple reference counter file at `~/.itsybitsy/coordinator.clients`)
- [ ] Session name constant: `IB_COORDINATOR_SESSION = "ib-coordinator"`
- [ ] Tests for session creation, reuse, cleanup

#### 44b: Coordinator TmuxPoller

**Files:** `src/tui/dashboard.ts`, `src/tui/sidebar.ts`

Add a second TmuxPoller for the coordinator session:

- [ ] Create a dedicated `TmuxPoller` instance targeting `ib-coordinator`
- [ ] Poll at ~1s interval, same as the agent poller
- [ ] Feed output to a `TmuxPaneComponent` embedded in the sidebar's coordinator section
- [ ] Start polling on dashboard startup, stop on exit
- [ ] The coordinator poller runs continuously (unlike the agent poller which switches targets on selection)

#### 44c: Dashboard integration

**Files:** `src/tui/dashboard.ts`

Wire coordinator lifecycle into the dashboard:

- [ ] On `launchDashboard()`: call `ensureCoordinatorSession()` before starting the TUI
- [ ] On Ctrl-C exit: call `killCoordinatorSession()` after stopping the TUI
- [ ] Pass coordinator tmux output to the sidebar for rendering
- [ ] Handle the case where the coordinator session dies mid-operation: show "Coordinator stopped" in the panel, offer to restart
- [ ] Tests for startup/shutdown lifecycle

#### 44d: Coordinator prompt and permissions

**Files:** `src/coordinator.ts`

Define the coordinator's initial configuration:

- [ ] Initial prompt (see SPEC.md §12.5 for text)
- [ ] Settings template: permissions deny list includes Read, Write, Edit, MultiEdit, Glob, Grep, LS, NotebookEdit, WebFetch, WebSearch, Task, Agent
- [ ] Model: `opus`
- [ ] Working directory: `~/.itsybitsy/` (ensure it exists, create if needed)
- [ ] No git worktree, no agent ID, no watchdog
- [ ] Tests for settings generation

---

### Parallelism Notes for Phases 42–44

**Phase 42** must complete first — it establishes the sidebar layout that Phases 43 and 44 build upon.

**Phase 43** (focus system) and **Phase 44** (coordinator) have a dependency: Phase 44c needs the focus system from Phase 43 to route input to the coordinator. However, 44a (session lifecycle) and 44b (poller) can start in parallel with Phase 43.

Recommended execution order:
```
Phase 42 ──── (must complete first)
               ↓
Phase 43a-c ──┐
Phase 44a-b ──┼── in parallel
               ↓
Phase 43d-e ──── (needs focus system + coordinator)
Phase 44c-d ──── (needs focus system + coordinator poller)
```

---

## Future Work

The following phases are aspirational — not yet planned for implementation. They represent longer-term architectural improvements or ideas that depend on prerequisite work being completed first.

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

**Status:** Partial. Some items addressed organically; most remain unimplemented.

**Source:** SECURITY_REVIEW.md (2026-03-10 audit)

**Goal:** Fix all High and Medium security findings. Low findings are addressed where trivial.

---

#### 30a: HIGH-1 — tmux send-keys injection hardening

**Status:** Partial.

**Files:** `src/ib-commands.ts`, `src/hooks/agent-status.ts`

- [x] Add `-l` (literal) flag to all `tmux send-keys` calls that include variable content so tmux key names are never interpreted — **Mostly done.** `sendMessage()` (ib-commands.ts:1072) and `agent-status.ts` (lines 423, 441) use `-l`. **However, `resumeAgent()` (ib-commands.ts:428) sends `nudgePrompt` without `-l`.** [^needs review]
- [x] Send `Enter` as a separate `send-keys` call (matching `sendMessage()` pattern) rather than appending it inline — **Done.** All sites send Enter separately. Note: `auto-compact.ts:188` sends `/compact` + `Enter` together without `-l`, but `/compact` is a hardcoded literal, not variable content.
- [ ] Validate `managerSession` with `isValidTmuxSession()` in `agent-status.ts` before use in `Bun.spawn` — **Not done.** `managerSession` (line 438) goes directly to `Bun.spawn` without validation. [^needs review]
- [ ] Validate `managerId` with `isValidAgentId()` before path-joining in stop hook — **Not done.** `managerId` (line 435) is used in `join(agentsDir, managerId)` without validation. (Overlaps with 30f.) [^needs review]

**Tests:** Existing tests verify `-l` flag in `sendMessage` path. No tests for the `resumeAgent` nudge gap.

---

#### 30b: HIGH-2 — Shell script path interpolation hardening

**Status:** Not implemented.

**Files:** `src/ib-commands.ts` (`newAgent()`, `resumeAgent()`)

Generated `start.sh` (ib-commands.ts:1683–1697) and `resume.sh` (ib-commands.ts:378–392) interpolate `rootRepoPath`, `agentDir`, `absPromptFile` into shell code using JS template literals inside double-quoted shell strings. No escaping is applied. Fix:
- [ ] Wrap all path interpolations in single-quotes with proper escaping: `'${path.replace(/'/g, "'\\''")}'` [^needs review]
- [ ] Or migrate away from generated shell scripts entirely — use `Bun.spawn` arrays directly for launching Claude inside tmux (lower risk, removes an entire class of issues)
- [ ] At minimum: validate that `rootRepoPath` doesn't contain characters that would break shell scripts, and fail-fast with a clear error if it does [^needs review]

**Tests:** No tests exist for paths with spaces or special characters in generated scripts.

---

#### 30c: MEDIUM-1 — Validate tmux sessions read from meta.json

**Status:** Not implemented.

**Files:** `src/hooks/agent-status.ts`, `src/agent-lifecycle.ts`, `src/auto-compact.ts`, `src/watchdog.ts`

`isValidTmuxSession()` is only called in `resumeAgent()` (ib-commands.ts:339). Everywhere else, tmux session names from `meta.json` go directly to `Bun.spawn` args:
- `agent-lifecycle.ts`: lines 106, 109, 183, 297, 303, 305, 309, 315, 317 — no validation [^needs review]
- `auto-compact.ts`: line 188 (`sendCompact`) and line 222 — no validation [^needs review]
- `watchdog.ts`: lines 215, 282–286, 358–369, 805–822 — no validation [^needs review]
- `agent-status.ts`: lines 87, 146, 413, 421–432 — no validation [^needs review]

- [ ] Add `isValidTmuxSession()` check at each site where `meta.tmux_session` is read from disk
- [ ] Return early with a logged error on invalid sessions (don't silently skip or crash)

**Tests:** No tests exist for invalid session name rejection.

---

#### 30d: MEDIUM-2 — Ghostty command quoting

**Status:** Partial — mitigated but not fully addressed.

**File:** `src/ghostty.ts`

The session is validated with `/^[\w-]+$/` (ghostty.ts:44) before interpolation into the `--command` string (line 51). However, the session is still interpolated directly (`-- ${tmuxSession}`) rather than passed as a properly quoted positional arg:
- [x] The session string is already validated with `/^[\w-]+$/` — existing, with early-return on invalid names
- [ ] Add a comment noting this validation is load-bearing for security [^needs review]
- [ ] Or restructure to avoid interpolation: use proper `$1` positional arg substitution (currently `$1` is used for the session inside `bash -c`, but `${tmuxSession}` is appended directly after `--` without shell quoting — the `$1` pattern is incomplete) [^needs review]

---

#### 30e: MEDIUM-5 — Hook stdin schema validation

**Status:** Partial — 3 of 6 hooks have try/catch around JSON.parse; none have type guards.

**Files:** `src/hooks/agent-path.ts`, `src/hooks/intercept-task.ts`, `src/hooks/session-start.ts`, `src/hooks/agent-status.ts`, `src/hooks/main-path.ts`, `src/hooks/inject-status.ts`

Current state of JSON.parse error handling:
- `agent-status.ts` (line 348): ✅ Has try/catch, falls back to empty string
- `main-path.ts` (line 105): ✅ Has try/catch, exits 0
- `inject-status.ts` (line 250): ✅ Has try/catch, exits 0
- `agent-path.ts` (line 259): ❌ No try/catch — will crash on malformed JSON [^needs review]
- `intercept-task.ts` (line 160): ❌ No try/catch — will crash on malformed JSON [^needs review]
- `session-start.ts` (line 290): ❌ No try/catch — will crash on malformed JSON [^needs review]

No hooks have type guards verifying `tool_name` is a string, `tool_input` is a non-null object, etc.

- [ ] Add try/catch around JSON.parse in agent-path.ts, intercept-task.ts, session-start.ts
- [ ] Add basic type guards at each hook entry point
- [ ] On schema violation: log to stderr and exit 0 (allow)

**Tests:** No tests exist for malformed stdin input to hooks.

---

#### 30f: LOW-3 — Manager ID/session validation in stop hook

**Status:** Not implemented.

**File:** `src/hooks/agent-status.ts`

`meta.manager` (line 435) is used to path-join and read another agent's `meta.json`, then that agent's `tmux_session` (line 438) is used in `Bun.spawn`. Neither is validated:
- [ ] `isValidAgentId(managerId)` check before `join(agentsDir, managerId)` [^needs review]
- [ ] `isValidTmuxSession(managerSession)` check before spawning [^needs review]

Note: `isValidAgentId()` IS imported and used in agent-status.ts (line 384), but only for the debounce recheck path — not for the `notify_manager` path.

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

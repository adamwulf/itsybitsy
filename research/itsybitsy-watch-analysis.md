# itsybitsy Watch/Dashboard Implementation Analysis

Deep-dive technical analysis of the TypeScript `ib watch` replacement — how it monitors agents, renders the TUI, handles keyboard input, and integrates with tmux.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Startup / Entry Point](#startup--entry-point)
3. [Registry (src/registry.ts)](#registry)
4. [Agent Data Layer (src/agents.ts)](#agent-data-layer)
5. [State Detection (src/parse-state.ts)](#state-detection)
6. [Tmux Polling (src/tmux-poller.ts)](#tmux-polling)
7. [File System Watcher (src/watcher.ts)](#file-system-watcher)
8. [TUI Rendering Architecture](#tui-rendering-architecture)
   - [SplitPane (src/tui/split-pane.ts)](#splitpane)
   - [ANSI-aware Line Wrapping (src/tui/wrap.ts)](#line-wrapping)
   - [Dashboard Component (src/tui/dashboard.ts)](#dashboard-component)
9. [Agent Tree Display](#agent-tree-display)
10. [Tmux Pane Component](#tmux-pane-component)
11. [Right Pane Modes](#right-pane-modes)
12. [Dialog System](#dialog-system)
13. [Keyboard Shortcuts](#keyboard-shortcuts)
14. [Refresh / Polling Strategy](#refresh--polling-strategy)
15. [ib Command Wrappers (src/ib-commands.ts)](#ib-command-wrappers)
16. [Ghostty Integration (src/ghostty.ts)](#ghostty-integration)
17. [Data Flow Summary](#data-flow-summary)

---

## Architecture Overview

itsybitsy is a terminal dashboard for managing Claude Code agents across multiple git repositories. It replaces the `ib watch` bash script with a full TypeScript TUI built on `@mariozechner/pi-tui`.

**Key architectural decisions:**
- Reads `.ittybitty/agents/` directories directly via filesystem (faster than shelling to `ib list`)
- Shells out to `ib` CLI for all mutations (kill, merge, send, new-agent, diff, status)
- Uses `fs.watch` on `.ittybitty/agents/` for instant structural updates
- Polls `tmux capture-pane` every ~1s for the *selected* agent's live output
- Terminal-only rendering via pi-tui (no browser UI)
- `ib` is always resolved from `$PATH`

**File layout:**
```
src/
  index.ts           # CLI entrypoint (add/remove/list/watch/agents)
  registry.ts        # ~/.itsybitsy.json repo registry
  agents.ts          # Read .ittybitty/agents/ and archive/ directories
  parse-state.ts     # Pure string-matching state detection
  tmux-poller.ts     # TmuxPoller class + one-shot captureTmuxOutput()
  watcher.ts         # AgentWatcher: fs.watch + periodic refresh
  ib-commands.ts     # Async wrappers for ib mutation commands
  ghostty.ts         # Open tmux session in Ghostty terminal
  tui/
    dashboard.ts     # Main TUI: components, input handling, dialog system
    split-pane.ts    # Side-by-side rendering of two components
    wrap.ts          # ANSI-aware hard line wrapping
```

---

## Startup / Entry Point

**File:** `src/index.ts`

The CLI dispatches on `process.argv[2]`. The `watch` subcommand validates `ib` and `tmux` on PATH, then dynamically imports and launches the dashboard:

```typescript
case "watch": {
  if (!Bun.which("ib")) {
    console.error("Error: 'ib' not found on PATH.");
    process.exit(1);
  }
  if (!Bun.which("tmux")) {
    console.error("Error: 'tmux' not found on PATH.");
    process.exit(1);
  }
  const { launchDashboard } = await import("./tui/dashboard");
  await launchDashboard();
  break;
}
```

---

## Registry

**File:** `src/registry.ts`

Stores registered repos in `~/.itsybitsy.json`. Each entry has `path` and `name`. Also stores an optional `diffTool` string for external diff viewing.

```typescript
export interface RepoEntry {
  path: string;
  name: string;
}

export interface RegistryData {
  repos: RepoEntry[];
  diffTool?: string;
}
```

Uses `Bun.file()` for reads, `Bun.write()` for saves.

---

## Agent Data Layer

**File:** `src/agents.ts`

### Agent type

```typescript
export interface Agent {
  id: string;
  repoPath: string;       // Absolute path to the repo root
  repoName: string;        // Human-readable repo name
  meta: AgentMeta;         // Parsed from meta.json
  state: AgentState;       // Detected by parseState()
  age: string;             // Human-readable age (e.g. "5m", "2h")
  archived: boolean;       // true if from archive/ directory
  children: Agent[];       // Populated by buildAgentTree()
}
```

### AgentMeta (from meta.json)

```typescript
export interface AgentMeta {
  id: string;
  session_id: string;
  tmux_session: string;
  prompt: string;
  manager: string | null;
  created: string;
  created_epoch: number;
  worktree: boolean;
  worker: boolean;
  yolo: boolean;
  model: string;
  claude_pid: string;
}
```

### Reading agents

`readAllAgents(repos)` reads from both `.ittybitty/agents/` (active) and `.ittybitty/archive/` (archived) directories for each repo. Returns `{ agents, errors }` — errors are reported but don't stop the process:

```typescript
async function readAgentsFromDir(dir, repoPath, repoName, archived): Promise<ReadAgentsResult> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const { meta, error } = await readAgentMeta(join(dir, entry.name));
    // ...push to agents or errors
  }
}
```

### Building the tree

`buildAgentTree(agents)` creates parent-child relationships based on `agent.meta.manager`:

```typescript
export function buildAgentTree(agents: Agent[]): Agent[] {
  const byId = new Map<string, Agent>();
  for (const agent of agents) {
    agent.children = [];  // MUTATES in place
    byId.set(agent.id, agent);
  }
  const roots: Agent[] = [];
  for (const agent of agents) {
    if (agent.meta.manager && byId.has(agent.meta.manager)) {
      byId.get(agent.meta.manager)!.children.push(agent);
    } else {
      roots.push(agent);
    }
  }
  return roots;
}
```

### Flattening for display

`flattenAgentTree(roots)` does depth-first traversal, returning `FlatAgent[]` with `{ agent, depth }` for indentation:

```typescript
export interface FlatAgent {
  agent: Agent;
  depth: number;
}
```

### Helper functions

- `readAgentLog(agent)` — reads `agent.log` file, returns `string[]`
- `readAgentPrompt(agent)` — reads `prompt.txt`, falls back to `meta.prompt`
- `parseDenials(logLines)` — extracts `[PreToolUse] Permission denied:` lines with timestamps
- `computeAge(createdEpoch)` — converts epoch to `"5s"`, `"3m"`, `"2h"`, `"1d"`
- `readPendingQuestions(repoPath)` — reads `user-questions.json` for pending questions

---

## State Detection

**File:** `src/parse-state.ts`

Pure string matching on ANSI-stripped tmux output. **Never call on raw ANSI text.**

### States

```typescript
export type AgentState =
  | "creating"       // Permission screens before Claude starts
  | "running"        // Actively executing
  | "waiting"        // Tool waiting or WAITING state
  | "complete"       // "I HAVE COMPLETED THE GOAL"
  | "compacting"     // Conversation compaction in progress
  | "rate_limited"   // Hit API rate/usage limits
  | "stopped"        // No tmux session (set by caller, NOT by parseState)
  | "unknown";       // No patterns matched
```

### Priority order (highest to lowest)

1. **Creating** (pre-Claude) — permission prompts before Claude logo appears
2. **Compacting** (last 5 lines) — `"Compacting conversation"`
3. **Active running** (last 5 lines) — `(Esc to interrupt)`, `(ctrl+c to interrupt)`, `⎿  Running`
4. **Tool waiting** (last 15 lines) — `⎿  Waiting` (tool execution in progress)
5. **Rate limited** (last 15 lines) — `rate_limit_error`, usage limit patterns
6. **Complete** (last 15 lines) — `I HAVE COMPLETED THE GOAL` (excludes quoted occurrences)
7. **WAITING** (last 15 lines) — standalone `WAITING` on its own line, with stale check
8. **Other running** (last 15 lines) — `ctrl+b ctrl+b`, `thinking)`
9. **Spinners** (last 15 lines) — `✽✶✢·✻✳` characters (hook spinners filtered out)
10. **Permission prompts** (last 15 lines) — workspace trust prompts after Claude has started
11. **Broader spinners** (last 20 lines) — spinners with interrupt markers in wider window
12. **Background tasks** (last 15 lines) — `⏵⏵` pattern in status bar
13. **Race condition hook** — `"running stop hook"` without `⏺`
14. **Unknown** — no patterns matched

### Key implementation details

**ANSI stripping:**
```typescript
export function stripAnsi(text: string): string {
  return text.replace(
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b_.*?\x07|\x1b[()][AB012]/g,
    ""
  );
}
```

**Hook spinner filtering** — lines starting with a spinner char that also contain "hook" are excluded:
```typescript
function filterHookSpinners(text: string): string {
  const spinnerChars = "✽✶✢·✻✳";
  return text.split("\n")
    .filter((line) => {
      if (spinnerChars.includes(line.charAt(0)) && line.includes("hook")) return false;
      return true;
    })
    .join("\n");
}
```

**Stale WAITING detection** — if `⏺` appears after the last WAITING, the agent has resumed:
```typescript
const afterWaiting = last15.split("WAITING").pop() ?? "";
if (afterWaiting.includes("⏺")) {
  return { state: "running", reason: "agent output ⏺ after stale WAITING" };
}
```

**Completion signal exclusion** — quoted `'I HAVE COMPLETED THE GOAL'` (in watchdog prompts) is stripped before checking:
```typescript
const unquoted15 = last15.replace(/'I HAVE COMPLETED THE GOAL'/g, "");
if (unquoted15.includes("I HAVE COMPLETED THE GOAL")) {
  return { state: "complete", reason: "I HAVE COMPLETED THE GOAL in last 15 lines" };
}
```

---

## Tmux Polling

**File:** `src/tmux-poller.ts`

Two distinct polling mechanisms:

### 1. TmuxPoller class (continuous, for display)

Polls the **selected** agent at ~1s intervals. Used by the dashboard for live output display.

```typescript
export class TmuxPoller {
  private tmuxSession: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lines: number;  // Default: 100

  setAgent(tmuxSession: string | null): void {
    this.tmuxSession = tmuxSession;
    if (tmuxSession && this.running) {
      this.poll();  // Immediate poll on agent change
    }
  }

  start(): void {
    this.running = true;
    this.timer = setInterval(() => {
      if (this.running && this.tmuxSession) this.poll();
    }, 1000);
  }
```

**Race condition guard:** snapshots `targetSession` before async spawn, discards result if agent changed:
```typescript
private async poll(): Promise<void> {
  const targetSession = this.tmuxSession;
  if (!targetSession) return;
  // ... Bun.spawn tmux capture-pane ...
  if (this.tmuxSession !== targetSession) return;  // Agent changed during await
}
```

**tmux command used:**
```
tmux capture-pane -t <session> -p -S -100 -E -
```
- `-p` — print to stdout
- `-S -100` — start 100 lines back from cursor
- `-E -` — end at the current cursor position

Emits both raw (with ANSI) and stripped output via `onOutput(raw, stripped)`.

### 2. captureTmuxOutput() (one-shot, for state detection)

Used by `detectAgentStates()` in the watcher. Captures only 20 lines (sufficient for state parsing):

```typescript
export async function captureTmuxOutput(tmuxSession: string, lines = 20): Promise<string | null> {
  const proc = Bun.spawn(
    ["tmux", "capture-pane", "-t", tmuxSession, "-p", `-S`, `-${lines}`, "-E", "-"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const raw = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;  // Session doesn't exist
  return stripAnsi(raw);
}
```

---

## File System Watcher

**File:** `src/watcher.ts`

`AgentWatcher` monitors structural changes to agent directories and emits consolidated updates.

### Watched paths (per repo)

- `.ittybitty/agents/` (recursive) — agent creation/deletion/metadata changes
- `.ittybitty/archive/` (recursive) — archived agent changes
- `.ittybitty/user-questions.json` — pending questions

### Refresh strategy

```typescript
export class AgentWatcher {
  async start(): Promise<void> {
    await this.refresh();  // Initial load

    // fs.watch on each repo's directories
    for (const repo of this.repos) {
      watch(agentsDir, { recursive: true }, () => this.debounceRefresh());
      watch(archiveDir, { recursive: true }, () => this.debounceRefresh());
      watch(questionsFile, () => this.debounceRefresh());
    }

    // Fallback poll every 10s for macOS FSEvents reliability
    this.pollTimer = setInterval(() => {
      if (this.running) this.refresh();
    }, 10_000);
  }
}
```

**Debouncing:** 200ms debounce on fs.watch events to avoid rapid successive refreshes:
```typescript
private debounceRefresh(): void {
  if (this.refreshTimer) clearTimeout(this.refreshTimer);
  this.refreshTimer = setTimeout(() => {
    if (this.running) this.refresh();
  }, 200);
}
```

### refresh() flow

1. `readAllAgents(repos)` — read meta.json from all repos
2. `detectAgentStates(agents)` — capture tmux + parseState for each active agent
3. `buildAgentTree(agents)` — set parent-child relationships
4. `flattenAgentTree(roots)` — depth-first traversal for display
5. `readPendingQuestions()` — check user-questions.json for each repo
6. Emit `onUpdate(agents, flatList, questions)`

### detectAgentStates()

In `agents.ts`, runs tmux capture in parallel for all active agents:

```typescript
export async function detectAgentStates(agents: Agent[]): Promise<void> {
  const active = agents.filter((a) => !a.archived);
  await Promise.all(
    active.map(async (agent) => {
      const output = await captureTmuxOutput(agent.meta.tmux_session);
      if (output === null) { agent.state = "stopped"; return; }
      agent.state = parseState(output).state;
    })
  );
  // Archived agents always get "stopped"
  for (const agent of agents) {
    if (agent.archived) agent.state = "stopped";
  }
}
```

---

## TUI Rendering Architecture

Built on `@mariozechner/pi-tui`:

```typescript
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const dashboard = new DashboardComponent();
tui.addChild(dashboard);
tui.start();
```

Components implement `Component` interface: `render(width): string[]`, optional `handleInput(data)`, `invalidate()`.

### SplitPane

**File:** `src/tui/split-pane.ts`

pi-tui's `Box` is vertical-only. `SplitPane` renders two components side-by-side:

```typescript
export class SplitPane implements Component {
  render(width: number): string[] {
    const lw = Math.min(this.leftWidth, width - sepWidth - 1);
    const rw = width - lw - sepWidth;
    const leftLines = this.left.render(lw);
    const rightLines = this.right.render(rw);
    // Merge: pad left to exact width, add separator, truncate right
    for (let i = 0; i < maxLines; i++) {
      const leftPadded = /* pad or truncate to lw */;
      const rightTruncated = truncateToWidth(rl, rw, "");
      result.push(leftPadded + this.separator + rightTruncated);
    }
    return result;
  }
}
```

Default separator: `"│"`. Left width: 60 columns.

### Line Wrapping

**File:** `src/tui/wrap.ts`

ANSI-aware hard wrapping that preserves escape codes:

```typescript
export function wrapSingleLine(line: string, width: number): string[] {
  // Walks characters, skips ANSI CSI sequences for width calculation
  // ANSI codes at wrap boundaries stay in the current chunk
  // Uses visibleWidth() from pi-tui for character width measurement
  // Handles wide characters (CJK, emoji)
}

export function wrapLines(text: string, width: number): string[] {
  // Split on newlines, then wrap each line individually
}
```

CSI terminator detection (ECMA-48): bytes 0x40-0x7E.

### Dashboard Component

**File:** `src/tui/dashboard.ts`

`DashboardComponent` is the root component. It composes:

```
┌─────────────────────────────────────────────────┐
│ itsybitsy — agent dashboard          [notices]  │ ← Header (1 line)
│─────────────────────────────────────────────────│ ← Separator
│ ◆ repo/agent-1  running  5m  opus  prompt...    │
│   ↳ ⚙ repo/worker-1  waiting  2m  sonnet ...   │ ← Agent Tree (max 7 rows)
│ ◆ repo/agent-2  complete  1h  opus  prompt...   │
│─────────────────────────────────────────────────│ ← Separator
│ [tmux live output]    │ [right pane content]    │ ← SplitPane (fills remaining)
│ ...                   │ ...                     │
│─────────────────────────────────────────────────│ ← Separator
│ [0] AGENT LOG  [2 questions]                    │ ← Status bar (2 lines)
│ j/k:nav  ;/l:scroll  p/n:pane  ...             │
└─────────────────────────────────────────────────┘
```

**Display height calculation:**
```typescript
render(width: number): string[] {
  const bottomHeight = 2;      // status bar
  const separatorHeight = 1;   // bottom separator
  const usedHeight = lines.length + separatorHeight + bottomHeight;
  const terminalRows = process.stdout.rows || 24;
  const availableHeight = Math.max(5, terminalRows - usedHeight);
  this.tmuxPane.displayHeight = availableHeight;
  this.rightPane.displayHeight = availableHeight;
}
```

---

## Agent Tree Display

**Component:** `AgentTreeComponent` (in dashboard.ts)

- Max visible rows: **7** (`MAX_TREE_HEIGHT`)
- Scrolling with `▲ N more` / `▼ N more` indicators
- Selected row highlighted with `BOLD + reverse video (\x1b[7m])`
- Archived agents hidden by default (toggle with `A`)

**Row format:**
```
[indent] icon repo/id  state  age  model  [archived] prompt_preview
```

Icons: `◆` (manager), `⚙` (worker). Indent uses `↳ ` prefix with 2-space depth multiplier.

**State colors:**
| State | Color |
|-------|-------|
| creating | yellow |
| running | green |
| waiting | cyan |
| complete | blue |
| compacting | magenta |
| rate_limited | red |
| stopped | dim/gray |
| unknown | white |

```typescript
function formatAgentRow(agent, depth, selected, width): string {
  const indent = depth === 0 ? "" : "  ".repeat(depth) + "↳ ";
  const icon = agent.meta.worker ? "⚙" : "◆";
  const stateColor = STATE_COLORS[agent.state] ?? STATE_COLORS.unknown;
  const sel = selected ? `${BOLD}\x1b[7m` : "";
  // ... truncated to width
}
```

---

## Tmux Pane Component

**Component:** `TmuxPaneComponent` (in dashboard.ts)

Left side of the split pane. Shows live tmux output for the selected agent.

### States

1. **No agent selected** — `"No agent selected"`
2. **Waiting for first poll** (`hasPolled = false`) — `"Waiting for tmux output..."`
3. **Polled but empty** (`hasPolled = true`, no output) — graceful stopped/orphaned display showing agent state
4. **Active output** — wrapped lines with scroll-back support

### Scroll-back

`scrollBack` counts lines from the bottom (0 = auto-follow newest):

```typescript
render(width: number): string[] {
  const wrapped = wrapLines(this.rawOutput, width);
  const maxScrollBack = Math.max(0, wrapped.length - this.displayHeight);
  // Slice visible window from bottom
  const contentHeight = this.scrollBack > 0 ? this.displayHeight - 1 : this.displayHeight;
  const end = wrapped.length - this.scrollBack;
  const start = Math.max(0, end - contentHeight);
  // Show scroll indicator when scrolled back
  if (this.scrollBack > 0) {
    lines.push(`── ↓ ${this.scrollBack} lines below ──`);
  }
}
```

### hasPolled flag

Distinguishes "waiting for first poll" from "session not found":
- Before any poll completes: shows "Waiting for tmux output..."
- After poll with empty result: shows agent state and "No active tmux session"

---

## Right Pane Modes

**Component:** `RightPaneComponent` (in dashboard.ts)

8 modes, cycled with `p`/`n` keys or jumped to with shortcut keys:

```typescript
const PANE_MODES = [
  "AGENT LOG",       // agent.log file content
  "INITIAL PROMPT",  // prompt.txt or meta.prompt
  "DENIALS",         // Parsed [PreToolUse] Permission denied lines
  "TREE",            // Full agent tree (all repos)
  "ERRORS",          // Runtime errors collected by watcher
  "DIFF",            // ib diff output (loaded on demand)
  "STATUS",          // ib status output (loaded on demand)
  "QUESTIONS",       // Pending user-questions.json items
] as const;
```

### Mode details

**AGENT LOG** — reads `agent.log` async on agent selection change. Stale-checked by agent ID.

**INITIAL PROMPT** — reads `prompt.txt` (falls back to `meta.prompt`). Loaded async on agent selection.

**DENIALS** — parses agent.log for `[PreToolUse] Permission denied:` lines. Supports time filtering with `t` key:
```typescript
const DENIAL_FILTERS = ["all", "1h", "10m"] as const;
```

**DIFF** — runs `ib diff <agent-id>` on demand (key `d`). Loading state shown. Force-refreshes each time `d` is pressed.

**STATUS** — runs `ib status <agent-id>` on demand (key `g`). Same loading pattern as DIFF.

**QUESTIONS** — shows pending questions with j/k navigation. Enter to answer, Esc to acknowledge, g to jump to the agent.

**ERRORS** — collected from watcher `onError`. Press `c` to clear.

**TREE** — renders full flat agent tree with state colors.

### Scroll behavior

Right pane uses tail-snapping: `scrollOffset` means lines scrolled back from the bottom (0 = following tail):

```typescript
render(width: number): string[] {
  const available = Math.max(1, this.displayHeight - 1);
  const maxOffset = Math.max(0, this.content.length - available);
  const start = Math.max(0, this.content.length - available - this.scrollOffset);
  const visible = this.content.slice(start, start + available);
}
```

---

## Dialog System

7 dialog types rendered as centered bordered box overlays via pi-tui's overlay system:

### Dialog types

| Type | Purpose | Input handling |
|------|---------|---------------|
| `confirm` | Yes/no questions | `y`/`n` keys |
| `input` | Single-line text input | Type + Enter/Esc |
| `textarea` | Multi-line text input | Tab to cycle focus (text/send/cancel), Enter for newlines |
| `select` | List selection | j/k + Enter |
| `fuzzy` | Fuzzy search + select | Type to filter, j/k, Enter |
| `message` | Auto-dismissing notification | Any key or 3s timeout |
| `help` | Help overlay | Any key to dismiss |

### Overlay rendering

```typescript
private showDialog(dialog: NonNullable<DialogState>) {
  this._dialog = dialog;
  if (!this.overlayHandle && this.tui) {
    this.overlayHandle = this.tui.showOverlay(this.dialogOverlay, {
      width: DIALOG_WIDTH,  // 60 columns
      anchor: "center",
    });
  }
}
```

### Message auto-dismiss

Uses a counter to prevent stale timeouts from dismissing newer messages:
```typescript
private showMessage(text: string) {
  const id = ++this.messageCounter;
  this.showDialog({ type: "message", text });
  setTimeout(() => {
    if (this._dialog?.type === "message" && this.messageCounter === id) {
      this.closeDialog();
    }
  }, 3000);
}
```

### Textarea dialog

Used for `send message`. Features:
- Multi-line editing with Enter for newlines
- Tab cycles focus: text -> send -> cancel -> text
- Visual line wrapping within the dialog
- Cursor block `█` shown at end of text
- Backspace handles line joins (deleting at start of line merges with previous)
- Scroll follows bottom (cursor always at end — append-only)

```typescript
function wrapTextareaLines(lines: string[], width: number): string[] {
  // Hard wraps at width, adds trailing empty line when last line fills exactly
  // so cursor block has room to render
}
```

### Fuzzy search

Uses pi-tui's `fuzzyFilter`. Wraps items with original indices to map filtered selection back:

```typescript
function fuzzyFilterIndices(items: string[], query: string): number[] {
  const indexed = items.map((text, index) => ({ text, index }));
  const filtered = fuzzyFilter(indexed, query, (item) => item.text);
  return filtered.map((item) => item.index);
}
```

Used for:
- `@` — fuzzy jump to agent
- `/` — command palette (all commands searchable)

---

## Keyboard Shortcuts

### Navigation
| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down (or navigate questions in QUESTIONS pane) |
| `k` / `↑` | Move selection up |
| `@` | Fuzzy jump to agent |
| `/` | Command palette (fuzzy search all commands) |

### Pane control
| Key | Action |
|-----|--------|
| `p` / `←` | Cycle right pane mode forward |
| `n` / `→` | Cycle right pane mode backward |
| `d` | Jump to DIFF mode (force refresh) |
| `g` | Jump to STATUS mode (or go-to-agent in QUESTIONS pane) |
| `e` | Jump to ERRORS mode |
| `q` | Jump to QUESTIONS mode |
| `t` | Cycle denial time filter (all/1h/10m, in DENIALS pane) |
| `c` | Clear errors (in ERRORS pane) |

### Scrolling
| Key | Action |
|-----|--------|
| `;` | Scroll up 5 lines (both tmux and right pane) |
| `l` | Scroll down 5 lines (both panes) |

### Agent actions
| Key | Action |
|-----|--------|
| `s` | Send message (textarea dialog) |
| `m` | Merge agent (merge-check then confirm) |
| `x` | Kill agent (confirm dialog) |
| `!` | Force kill/nuke agent (confirm dialog) |
| `R` | Resume agent (stopped/complete only) |
| `r` | Reassign to new manager (input dialog) |
| `a` | New agent (multi-step: repo select -> prompt -> flags) |
| `A` | Toggle archived agents visibility |

### External tools
| Key | Action |
|-----|--------|
| `w` | Open worktree in Finder |
| `o` | Open diff in configured external tool |
| `G` | Open agent's tmux session in Ghostty |
| `S` | Save debug snapshot (tmux output + parsed state) |

### Questions pane
| Key | Action |
|-----|--------|
| `Enter` | Answer selected question |
| `Esc` | Acknowledge (dismiss) question |
| `g` | Go to question's agent |

### Application
| Key | Action |
|-----|--------|
| `h` | Show help overlay |
| `Ctrl-C` | Quit |

### Dialog input
| Key | Action |
|-----|--------|
| `Esc` | Cancel/close any dialog |
| `y`/`n` | Confirm dialog |
| `j`/`k`, `↑`/`↓` | Select list / fuzzy navigation |
| `Enter` | Submit / select |
| `Backspace` | Delete character |
| `Tab` | Cycle focus in textarea (text -> send -> cancel) |

---

## Refresh / Polling Strategy

Three layers of updates keep the dashboard current:

### 1. fs.watch (instant, structural)
- Fires on any file change in `.ittybitty/agents/` or `.ittybitty/archive/`
- Also watches `user-questions.json`
- Debounced to 200ms to batch rapid changes
- Triggers full `refresh()`: re-read all agents, detect states, rebuild tree

### 2. Fallback poll (10s, reliability)
- `setInterval` at 10,000ms
- Guards against macOS FSEvents dropping events
- Same `refresh()` call as fs.watch

### 3. tmux capture-pane poll (1s, display)
- Only polls the **selected** agent (not all agents)
- Captures 100 lines of output for display
- Race-condition-safe with session snapshot
- Emits raw output to `TmuxPaneComponent` for rendering

### 4. Manual refresh via executeAndRefresh
After any mutation (kill, merge, send, etc.), `watcher.refresh()` is called:

```typescript
private async executeAndRefresh(fn: () => Promise<void>) {
  try { await fn(); }
  catch (err) { this.showMessage(`Error: ${err}`); }
  this.watcher?.refresh();
}
```

---

## ib Command Wrappers

**File:** `src/ib-commands.ts`

All mutations shell out to `ib` via `Bun.spawn()`. Safe argument passing (no word-splitting):

```typescript
const defaultRunner: IbRunner = async (args, cwd) => {
  const proc = Bun.spawn(["ib", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  // ...
};
```

**Always sets `cwd` to `agent.repoPath`** — ib requires running from a git repo root.

### Available commands

| Function | ib command |
|----------|-----------|
| `killAgent(agent)` | `ib kill <id>` |
| `nukeAgent(agent)` | `ib kill <id> --force` |
| `resumeAgent(agent)` | `ib resume <id>` |
| `reassignAgent(agent, manager)` | `ib reassign <id> <manager>` |
| `mergeCheckAgent(agent)` | `ib merge-check <id>` |
| `mergeAgent(agent)` | `ib merge <id> --force` |
| `sendMessage(agent, message)` | `ib send <id> <message>` |
| `newAgent(repoPath, prompt, opts)` | `ib new-agent [--worker] [--yolo] [--model M] <prompt>` |
| `diffAgent(agent)` | `ib diff <id>` |
| `statusAgent(agent)` | `ib status <id>` |
| `acknowledgeQuestion(repoPath, id)` | `ib acknowledge <id>` |

### Test injection

```typescript
export function setRunner(runner: IbRunner) { currentRunner = runner; }
export function resetRunner() { currentRunner = defaultRunner; }
```

---

## Ghostty Integration

**File:** `src/ghostty.ts`

Opens a tmux session in a new Ghostty terminal window:

```typescript
export async function openInGhostty(tmuxSession: string): Promise<{ ok: boolean; message: string }> {
  // Validate session name: only alphanumeric, hyphens, underscores
  if (!/^[\w-]+$/.test(tmuxSession)) {
    return { ok: false, message: "Invalid tmux session name" };
  }
  const proc = Bun.spawn(
    ["ghostty", `--command=tmux attach -t ${tmuxSession}`],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
  proc.unref();  // Don't block parent process
  return { ok: true, message: "Opened in Ghostty" };
}
```

Session name validation prevents command injection since `--command` takes a shell string.

---

## Data Flow Summary

```
launchDashboard()
  ├── loadRegistry() → repos
  ├── Create TUI + DashboardComponent
  ├── Create AgentWatcher(repos)
  │     ├── fs.watch on agents/, archive/, user-questions.json
  │     └── 10s fallback poll
  ├── Create TmuxPoller (1s interval)
  └── tui.start()

AgentWatcher.refresh()
  ├── readAllAgents(repos) → { agents, errors }
  ├── detectAgentStates(agents)
  │     └── For each active agent:
  │           captureTmuxOutput(session, 20) → stripped text
  │           parseState(stripped) → { state, reason }
  ├── buildAgentTree(agents) → roots
  ├── flattenAgentTree(roots) → flatList
  ├── readPendingQuestions(repos) → questions
  └── dashboard.onUpdate(agents, flatList, questions)
        ├── Update AgentTreeComponent
        ├── Update RightPaneComponent
        ├── syncSelectedAgent()
        │     ├── Reset tmux pane if agent changed
        │     ├── Load agent.log + prompt.txt (async)
        │     └── tmuxPoller.setAgent(session)
        └── tui.requestRender()

TmuxPoller.poll() [every 1s for selected agent]
  ├── tmux capture-pane -t <session> -p -S -100 -E -
  ├── Race condition check (session unchanged?)
  └── tmuxPane.rawOutput = raw → tui.requestRender()

User input → dashboard.handleInput(data)
  ├── Dialog input (if active) → handleDialogInput()
  ├── Navigation (j/k/↑/↓) → agentTree.moveSelection()
  ├── Pane cycling (p/n/←/→) → cyclePaneMode()
  ├── Agent actions (s/m/x/!/R/r/a) → show dialog → executeAndRefresh()
  └── Scroll (;/l) → tmuxPane.scroll + rightPane.scroll
```

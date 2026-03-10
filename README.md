# itsybitsy

A cross-repo agent management dashboard for [ittybitty (`ib`)](https://github.com/anthropics/ittybitty). Provides a unified TUI to monitor, control, and interact with Claude Code agents across multiple repositories simultaneously — a full replacement for `ib watch` that spans all your projects.

## Prerequisites

- [ib](https://github.com/anthropics/ittybitty) — the ittybitty CLI
- [tmux](https://github.com/tmux/tmux) — terminal multiplexer (`brew install tmux`)
- [Bun](https://bun.sh) — JavaScript runtime (only needed for building)

## Installation

```sh
git clone <repo-url> && cd itsybitsy
bun install
bun build --compile --minify --sourcemap index.ts --outfile ib
```

Then add it to your PATH:

```sh
# Option 1: Add the project directory to your PATH (in ~/.bash_profile or ~/.zshrc)
export PATH=$PATH:/path/to/itsybitsy

# Option 2: Install system-wide
sudo cp ib /usr/local/bin/ib
```

## Usage

```sh
# Register repos to monitor
ib add /path/to/project
ib add                  # adds current directory

# List registered repos
ib list

# Unregister a repo
ib remove /path/to/project

# Launch the dashboard
ib watch
```

## Architecture

itsybitsy reads agent data natively from disk for speed, but delegates all mutations to the `ib` CLI to avoid reimplementing write-side logic (kill, merge, send, new-agent, etc.). The data flow:

```
registry.ts        — Stores which repo paths to monitor (~/.itsybitsy.json)
  ↓
agents.ts          — Reads .ittybitty/agents/{id}/meta.json directly from each repo
  ↓
parse-state.ts     — Classifies agent state (running/waiting/complete/stopped/…)
                     from tmux capture-pane output via pure string matching
  ↓
watcher.ts         — Drives updates: fs.watch on .ittybitty/agents/ for instant
                     detection, plus ~1s tmux polling for the selected agent
  ↓
dashboard.ts       — TUI component tree using pi-tui; handles input and rendering
  ↓
ib-commands.ts     — Shells out to `ib` for all mutations (Bun.spawn, no shell)
```

The TUI uses a custom `SplitPane` component to render two panes side-by-side, since pi-tui's `Box` only supports vertical layout. Each child renders independently; `SplitPane` merges their output line-by-line with padding and a separator.

## Keybindings

### Navigation

| Key | Action |
|-----|--------|
| `j` / `k` or `Up` / `Down` | Move selection in agent tree |
| `@` | Fuzzy jump to agent |
| `/` | Fuzzy jump to pane mode |

### Pane Control

| Key | Action |
|-----|--------|
| `p` / `n` or `Left` / `Right` | Cycle right pane mode |
| `d` | Jump to DIFF pane |
| `g` | Jump to STATUS pane (or go-to-agent in QUESTIONS pane) |
| `e` | Jump to ERRORS pane |
| `q` | Jump to QUESTIONS pane |
| `t` | Cycle denials time filter (in DENIALS pane) |
| `c` | Clear errors (in ERRORS pane) |
| `;` | Scroll up (older content) |
| `l` | Scroll down (newer content) |

### Agent Actions

| Key | Action |
|-----|--------|
| `s` | Send message to agent |
| `m` | Merge agent (runs merge-check first) |
| `x` | Kill agent |
| `!` | Force-kill / nuke agent |
| `R` | Resume stopped agent |
| `r` | Reassign agent's manager |
| `a` | Create new agent |

### Open / External

| Key | Action |
|-----|--------|
| `w` | Open agent worktree in Finder |
| `o` | Open diff in external diff tool |
| `G` | Open tmux session in Ghostty |
| `S` | Save debug snapshot |

### App

| Key | Action |
|-----|--------|
| `h` | Show help dialog |
| `Ctrl-C` | Quit |

## Configuration

Optional config in `~/.itsybitsy.json`:

```json
{
  "repos": [],
  "diffTool": "code --diff"
}
```

Set `diffTool` to enable the `o` keybinding for opening diffs in an external tool.

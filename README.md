# itsybitsy

itsybitsy is a multi-agent orchestration system built from three ordinary tools: **git**, **tmux**, and the coding CLIs you already use. It compiles to a single binary, `ib`, which spawns, monitors, and merges fleets of Claude Code (and Codex) agents across all of your repositories. A terminal dashboard, `ib watch`, shows every agent in every repo at once.

The binary and the on-disk directory names (`ib`, `.ittybitty/`) come from the bash prototype ("ittybitty") that this project reimplements and replaces. [SPEC.md](./SPEC.md) documents the behavior, including the intentional divergences from that prototype.

## Philosophy

Most agent frameworks wrap a model API and invent a new runtime around it. itsybitsy goes the other way: it composes tools that already work, and it keeps every part inspectable.

- **Real CLIs, not API wrappers.** An agent is a normal interactive `claude` (or `codex`) session — the same program you run by hand, with the same tools, UI, and hooks. There is no special "agent mode". You can watch any agent's terminal (`ib look <id>`), attach to it (`ib look <id> --follow`), and simply type to it.
- **tmux is the runtime.** Every agent lives in its own detached tmux session. Agents keep working when the dashboard is closed. There is no daemon: if `tmux ls` shows the session, the agent exists.
- **git worktrees are the isolation.** Each agent works on its own branch (`agent/<id>`) in its own worktree. Agents cannot trample your checkout or each other. To review an agent, run `ib diff`; to integrate it, run `ib merge`. It is plain git underneath, and the commit history stays intact.
- **Plain files are the state.** Everything about an agent lives in `.ittybitty/agents/<id>/` inside the repo: `meta.json`, `prompt.txt`, scripts, logs. No database, no server. The dashboard reads these files directly, and so can you.
- **One writer.** Reads come straight from disk and tmux. Every mutation (spawn, send, merge, retire) goes through an `ib` command — and agents use those same commands to manage *their* sub-agents.

The result is an orchestration system where you can always see what an agent is doing, take the controls yourself at any moment, and clean up with normal git and tmux commands if anything goes wrong.

## What you need

- [Bun](https://bun.sh) — builds (and can run) the project
- [tmux](https://github.com/tmux/tmux) — hosts the agent sessions (`brew install tmux`)
- [Claude Code](https://code.claude.com) — the `claude` CLI that agents run
- Optional: the OpenAI Codex CLI (for `codex:*` models), [Ghostty](https://ghostty.org) (for the "open terminal" keybindings), and a Telegram bot token (to talk to your agents from your phone)

## Install

```sh
git clone <repo-url> && cd itsybitsy
bun install
bun run build            # produces the `ib` binary
sudo cp ib /usr/local/bin/ib
```

Instead of copying the binary, you can add the project directory to your `PATH`. Either way, `ib` must be on `PATH` — the hooks and agent sessions invoke it by name.

## Quick start

```sh
cd ~/code/myproject
ib add                 # register this repo
ib hooks install       # install the Claude Code safety hooks (recommended)

ib new-agent --type worker "Fix the flaky test in src/foo.test.ts"

ib watch               # open the dashboard
```

The spawn creates a worktree on branch `agent/<id>`, writes the prompt, and starts an interactive Claude Code session in a detached tmux session. From the dashboard (or the CLI) you can then:

```sh
ib agents              # tree of every agent in every repo, with states
ib look <id>           # see the agent's live terminal
ib send <id> "also update the docs"
ib diff <id>           # review its changes
ib merge <id>          # merge its branch and close it
ib retire <id>         # or: archive it without merging
```

Every command prints usage with `--help`.

## How it works

### Anatomy of an agent

```
<repo>/.ittybitty/agents/<id>/
├── repo/          # git worktree on branch agent/<id>
├── meta.json      # type, state, model, manager, PIDs, …
├── prompt.txt     # the task
├── start.sh       # launches the CLI inside tmux
└── logs, summaries, outbox
```

The tmux session is named `ittybitty-<repo-id>-<agent-id>`. A per-agent **watchdog** process monitors the session: it detects the agent's state from the terminal output, nudges agents that stall (capped at 10 reminders per episode), waits out rate limits and resumes the session, and notifies the agent's manager when work completes. Messages to an agent go through a per-agent **outbox** queue, so concurrent senders cannot interleave into one garbled prompt.

### Agent types

Every agent has a type, defined by a markdown file in `~/.itsybitsy/agent-types/<name>.md`. The frontmatter declares the type's model, reasoning effort, permissions, and whether it may spawn sub-agents; the body becomes instructions injected into the agent's session at start:

```markdown
---
name: researcher
description: Specialized research worker
inherits: worker
permissions:
  allow:
    - WebFetch
    - WebSearch
---

## Research Notes

Use the web tools to investigate...
```

Built-in types are installed on first run: `manager` (the default; may spawn sub-agents), `worker` (a leaf; may not), `coordinator`, and `system`, plus two layer files (`_all.md`, `_non_coordinator.md`) whose permissions and instructions apply to every matching agent. To create a custom type, add a new `.md` file and spawn with `--type <name>`. Types can inherit from each other (`inherits:`) and can be restricted to specific repos (`repos:`). See [docs/agent-types/README.md](./docs/agent-types/README.md).

```sh
ib list-types          # what can I spawn?
ib show-type worker    # full resolved definition
ib init-types          # restore missing built-ins (never overwrites)
```

### The hierarchy

Agents form a management tree: **you** → the **system coordinator** (`@system`, auto-spawned by `ib watch`, coordinates across repos) → per-repo **coordinators** (optional) → **managers** → **workers**. A manager spawns sub-agents branched from its own branch, reviews their diffs, sends feedback, and merges their work upward — the same `ib` commands you use, gated by hooks so leaf agents cannot spawn. Coordinators are deliberately restricted: they orchestrate through `ib` commands but cannot read or write code themselves.

### Agent states

The dashboard and `ib agents` show one state per agent, detected from `meta.json` plus the live tmux output:

| State | Meaning |
|---|---|
| `creating` | Session is starting up |
| `running` | Actively working |
| `waiting` | Idle — waiting on input or another agent |
| `complete` | Signaled its goal is done |
| `compacting` | Summarizing context |
| `rate_limited` | Hit API rate limits (watchdog auto-resumes) |
| `api_error` / `api_terms` / `api_safeguard` | Terminal API failures |
| `stopped` | Session ended |
| `unknown` | State unclear |

Transient labels (`merging`, `restarting`, `op_stuck`) appear while a lifecycle operation is in flight.

### Talking to agents

`ib send` delivers a message into an agent's session — even a completed or stopped one, which restarts and responds. Targets:

| Target | Delivers to |
|---|---|
| `<agent-id>` | An agent, by id or nickname |
| `@system` | The system coordinator |
| `@coordinator` | Your repo's coordinator (cwd-detected) |
| `@<repo>` | A repo's coordinator |
| `@<repo>/<agent-id>` | An agent in a specific repo |
| `@<team>` | Every member of a team |

Agents ask you questions with `ib ask`; `ib questions` lists what is pending and `ib acknowledge` clears one. Teams are named groups for broadcast: `ib team create/add/remove/list/delete`, `ib roster <name>`.

### Models

Models are selected as `<cli>:<model>` — for example `claude:opus` or `codex:gpt-5-codex` — so one flag picks both the CLI and the model. `ib list-models` shows the known selectors. Reasoning effort is threaded the same way: `--effort low|medium|high|xhigh|max` (Codex has no `xhigh`/`max`; both map to its `high`). Defaults live in config and in the agent-type files.

### Telegram (optional)

Set a bot token (`ib config set channels.telegram.bot_token <token>`) and allow your chat (`ib tgallow <chat_id>`), and itsybitsy becomes a two-way bridge: messages from your phone are delivered to the system coordinator, and agents can reply with `ib tgsend`, react with `ib tgreact`, and send files with `ib tgsendfile`. Attachments, reactions, and a few slash commands (`/restart`, `/context`, `/compact`) work in both directions.

## The dashboard

`ib watch` is a full-screen TUI: a sidebar tree of every repo and agent (with a Teams view on `0`/`1`), a live view of the selected agent's terminal, an info panel, a chat pane for the system coordinator, and a right pane that cycles between diff, git status, errors, and pending questions.

### Keybindings

Press `?` in the dashboard for this list.

| Group | Key | Action |
|---|---|---|
| Navigate | `j` / `k` / `↑↓` | Select agent |
| | `0` / `1` | Switch sidebar (Teams / Agents) |
| | `@` | Fuzzy jump to agent/repo |
| | `/` | Fuzzy mode picker |
| Panes | `p` / `n` / `←→` | Cycle right pane mode |
| | `d` / `g` / `e` / `q` | Diff / status / errors / questions |
| | `[` / `]` | Resize split |
| | `;` / `l` | Scroll up / down |
| Actions | `s` / `E` | Send message / cross-repo send |
| | `a` | New agent |
| | `m` | Merge (runs merge-check first) |
| | `x` / `!` | Retire / nuke |
| | `R` / `P` | Resume / pause |
| | `r` / `N` | Reassign manager / nickname |
| | `b` | Add permission; `Tab` toggles sub-agent spawning |
| | `T` / `t` | Create team / add agent to team |
| Repos | `+` / `A` | Add repo |
| | `x` / `D` | Remove repo (on a repo header) |
| | `r` | Rename repo (on a repo header) |
| | `f` | Fix resolvable health warnings |
| | `V` | Cycle filter: all / non-empty / running-only |
| | `.` | Pin repo (stays visible under `V`) |
| Open | `w` / `o` / `O` | Worktree in Finder / external diff / diff vs manager |
| | `G` / `C` | Ghostty: repo worktree / agent's tmux session |
| | `S` | Save debug snapshot |
| App | `h` | Setup dialog (hooks + config) |
| | `?` / `Ctrl-C` | Help / quit |

## CLI overview

| Group | Commands |
|---|---|
| Repos | `add`, `remove`, `list`, `push` |
| Spawning | `new-agent` (`new`), `list-types`, `show-type`, `init-types`, `list-models` |
| Monitoring | `watch`, `agents` (`tree`), `look`, `status`, `diff`, `info`, `state`, `questions` |
| Messaging | `send`, `ask`, `acknowledge`, `log` |
| Lifecycle | `merge-check`, `merge`, `retire`, `rehire`, `resume`, `respawn` (`restart`), `nuke`, `nickname` |
| Teams | `team create/add/remove/list/delete`, `roster` |
| Setup | `config`, `hooks install/uninstall/status`, `hooks intercept-*` |
| Telegram | `tgallow`, `tgdeny`, `tgsend`, `tgreact`, `tgsendfile` |

`ib state --cleanup` finds and kills orphaned tmux sessions and processes; add `--dry-run` to preview.

## Hooks

Claude Code hooks are the steering layer. Two installs affect **your own** Claude session, via `~/.claude/settings.json`:

- **Safety hooks** (`ib hooks install`) keep your primary Claude session out of agent worktrees and inject a brief agents-status summary into its context.
- **The intercept hook** (`ib hooks intercept-install`) redirects Claude's built-in `Task` sub-agent tool to spawn real `ib` agents instead — so delegation lands in the same observable tmux + worktree world.

Each **agent's** hooks need no install step: they are written into the agent's `settings.local.json` at spawn, and enforce path isolation, report state changes, inject the agent-type instructions at session start, and gate sub-agent spawning.

`ib hooks status` / `ib hooks intercept-status` show what is installed; the matching `uninstall` commands remove it cleanly.

## Slash commands

itsybitsy auto-installs two Claude Code slash commands (to `~/.claude/commands/`, never overwriting existing files). Use them after editing agent-type files so a running agent picks up the changes:

| Command | Action |
|---|---|
| `/respawn` | Restart this agent's Claude session in the same worktree; the SessionStart hook re-reads `~/.itsybitsy/agent-types/`. |
| `/restart` | Alias for `/respawn`. |

Both shell out to `ib respawn`, which also works directly from the CLI: `ib respawn <id>`, or `ib respawn @system` for the system coordinator.

## Configuration

User-wide config lives in `~/.itsybitsy/config.json`, managed with `ib config list|get|set|add|remove|unset`:

| Key | Default | Meaning |
|---|---|---|
| `model` | `claude:opus` | Default model selector for new agents |
| `effort` | `xhigh` | Default reasoning effort |
| `maxAgents` | `10` | Max concurrent agents per repo |
| `allowAgentQuestions` | `true` | Let agents ask the user questions |
| `externalDiffTool` | — | Enables `o`/`O` (e.g. `"code --diff"`) |
| `createPullRequests` | `false` | Tell top-level agents to open a PR when done (needs `gh` + a remote) |
| `notifications.sayOnQuestion` | `true` | Speak when an agent asks a question |
| `tree.groupByParent` | `false` | Group repos under their parent directory |
| `hooks.injectStatus` / `hooks.statusVisible` | `true` | Agents-status injection in the main session |
| `channels.telegram.bot_token` | — | Telegram bridge |

Per-agent-type permissions do **not** live here — they live in the agent-type `.md` files (old `permissions.*` config keys are deprecated and print migration hints).

## Going deeper

- [SPEC.md](./SPEC.md) — the authoritative behavioral spec: lifecycle, hooks, state detection, coordinators, teams
- [SPEC-CODEX-MODEL.md](./SPEC-CODEX-MODEL.md) — design source-of-truth for Codex CLI support
- [docs/implementation-notes.md](./docs/implementation-notes.md) — field guide to the code: what lives where
- [docs/agent-types/README.md](./docs/agent-types/README.md) — authoring and customizing agent types

## Development

```sh
bun test               # all tests must pass
bunx tsc --noEmit      # zero TypeScript errors
bun run build          # rebuild the `ib` binary
```

After rebuilding, confirm the binary dispatches: `ib list-types` should print a table.

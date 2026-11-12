# itsybitsy

itsybitsy is a multi-agent orchestration system built from three ordinary tools: **git**, **tmux**, and the coding CLIs you already use. It compiles to a single binary, `ib`, which spawns, monitors, and merges fleets of Claude Code (and Codex) agents across all of your repositories. A terminal dashboard, `ib watch`, shows every agent in every repo at once.

The `ib` binary replaces the bash prototype ("ittybitty"). Per-repo state lives in `.itsybitsy/`. [SPEC.md](./SPEC.md) documents the behavior and intentional divergences from that prototype.

## Philosophy

Most agent frameworks wrap a model API and invent a new runtime around it. itsybitsy goes the other way: it composes tools that already work, and it keeps every part inspectable.

- **Real CLIs, not API wrappers.** An agent is a normal interactive `claude` (or `codex`) session — the same program you run by hand, with the same tools, UI, and hooks. There is no special "agent mode". You can watch any agent's terminal (`ib look <id>`), attach to it (`ib look <id> --follow`), and simply type to it.
- **tmux is the runtime.** Every agent lives in its own detached tmux session. Agents keep working when the dashboard is closed. There is no daemon: if `tmux ls` shows the session, the agent exists.
- **git worktrees are the isolation.** Each agent works on its own branch (`agent/<id>`) in its own worktree. Agents cannot trample your checkout or each other. To review an agent, run `ib diff`; to integrate it, run `ib merge`. It is plain git underneath, and the commit history stays intact.
- **Plain files are the state.** Everything about an agent lives in `.itsybitsy/agents/<id>/` inside the repo: `meta.json`, `prompt.txt`, scripts, logs. No database, no server. The dashboard reads these files directly, and so can you.
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
ib add                      # register this repo
ib hooks install            # install the safety hooks
ib hooks intercept-install  # install the Task interception hook

ib new-agent --type worker "Fix the flaky test in src/foo.test.ts"

ib watch                    # open the dashboard
```

Install both hook sets before you start. They are not installed for you. You can also install them from the dashboard with `h`; see [Hooks](#hooks).

The spawn creates a worktree on branch `agent/<id>`, writes the prompt, and starts an interactive Claude Code session in a detached tmux session. From the dashboard (or the CLI) you can then:

```sh
ib agents              # tree of every agent in every repo, with states
ib look <id>           # see the agent's live terminal
ib send <id> "also update the docs"
ib diff <id>           # review its changes
ib merge <id>          # merge its branch and close it
ib merge <id> --keep   # or: merge the same way but leave it running
ib retire <id>         # or: archive it without merging
```

Every command prints usage with `--help`.

## How it works

### Anatomy of an agent

```
<repo>/.itsybitsy/agents/<id>/
├── repo/          # git worktree on branch agent/<id>
├── meta.json      # type, state, model, manager, PIDs, …
├── prompt.txt     # the task
├── start.sh       # launches the CLI inside tmux
└── logs, summaries, outbox
```

The tmux session is named `itsybitsy-<repo-id>-<agent-id>`. A per-agent **watchdog** process monitors the session: it detects the agent's state from the terminal output, nudges agents that stall (capped at 10 reminders per episode), waits out rate limits and resumes the session, and notifies the agent's manager when work completes. Messages to an agent go through a per-agent **outbox** queue, so concurrent senders cannot interleave into one garbled prompt.

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

Built-in types are installed on first run: `manager` (the default; may spawn sub-agents), `worker` (a leaf; may not), `repo-coordinator` (a per-repo coordinator), and `system-coordinator` (the system coordinator's layer), plus two layer files (`_all.md`, `_non_coordinator.md`) whose permissions and instructions apply to every matching agent. To create a custom type, add a new `.md` file and spawn with `--type <name>`. Types can inherit from each other (`inherits:`) and can be restricted to specific repos (`repos:`). See [docs/agent-types/README.md](./docs/agent-types/README.md).

```sh
ib list-types          # what can I spawn?
ib show-type worker    # full resolved definition
ib init-types          # restore missing built-ins (never overwrites)
```

### Kernel sandbox rollout

Ordinary agents and per-repository coordinators run inside macOS `sandbox-exec`, using the read/write/deny paths and network policy in their agent-type Markdown. This applies to Claude, Codex/fugu, and agy on spawn and resume; unsupported sandbox setup fails closed. There is no Markdown `sandbox.enabled` toggle.

The global `@system` coordinator remains unsandboxed in this staged rollout. Existing running agents do not become sandboxed retroactively: update the live type configuration, install the matching binary and helpers, then refresh/reset repository agents. Start with one worker pilot before migrating the rest. See [the rollout guide](docs/SANDBOX-ROLLOUT.md) for configuration preflight, validation limits, and migration steps.

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

Set a bot token (`ib config set channels.telegram.bot_token <token>`) and allow your chat (`ib tgallow <chat_id>`), and itsybitsy becomes a two-way bridge: messages from your phone are delivered to the system coordinator, and the system coordinator can reply with `ib tgsend`, react with `ib tgreact`, and send files with `ib tgsendfile`. Other agents cannot use these three commands. Attachments, reactions, and a few slash commands (`/restart`, `/context`, `/compact`) work in both directions.

## The dashboard

`ib watch` is a full-screen TUI: a sidebar tree of every repo and agent (with Agents / Teams / Favorites tabs on `1`/`2`/`3`), a live view of the selected agent's terminal, an info panel, a chat pane for the system coordinator, and a right pane that cycles between diff, git status, errors, and pending questions.

### Keybindings

Press `?` in the dashboard for this list.

| Group | Key | Action |
|---|---|---|
| Navigate | `j` / `k` / `↑↓` | Select agent |
| | `1` / `2` / `3` | Switch sidebar (Agents / Teams / Favorites) |
| | `@` | Fuzzy jump to agent/repo/coordinator |
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
| | `T` / `t` | Create team / add agent to a team or remove it from one |
| | `.` | Favorite / unfavorite agent (★, Favorites tab) |
| Teams tab | `t` | Edit roster (on a team) |
| | `x` | Disband team / remove a member (on a team) |
| | `x` | Remove from team / retire (on a member; asks which) |
| Repos | `+` / `A` | Add repo |
| | `x` / `D` | Remove repo (on a repo header) |
| | `r` | Rename repo (on a repo header) |
| | `f` | Fix resolvable health warnings |
| | `V` | Cycle filter: all / non-empty / running-only |
| | `.` | Pin repo (on a repo header; stays visible under `V`) |
| Open | `w` / `o` / `O` | Worktree in Finder / external diff / diff vs manager |
| | `G` / `C` | Ghostty: repo worktree / agent's tmux session |
| | `S` | Save debug snapshot |
| App | `h` | Setup dialog (hooks + config) |
| | `?` / `Ctrl-C` | Help / quit |

## CLI overview

| Group | Commands |
|---|---|
| Repos | `add`, `remove`, `list`, `push`, `pull` |
| Spawning | `new-agent` (`new`), `list-types`, `show-type`, `init-types`, `list-models` |
| Monitoring | `watch`, `agents` (`tree`), `look`, `status`, `diff`, `info`, `state`, `questions` |
| Messaging | `send`, `ask`, `acknowledge`, `log` |
| Lifecycle | `merge-check`, `merge`, `retire`, `rehire`, `resume`, `respawn` (`restart`), `nuke`, `nickname` |
| Teams | `team create/add/remove/list/delete`, `roster` |
| Setup | `config`, `hooks install/uninstall/status`, `hooks intercept-*` |
| Telegram | `tgallow`, `tgdeny`, `tgsend`, `tgreact`, `tgsendfile` |

`ib state --cleanup` finds and kills orphaned tmux sessions and processes; add `--dry-run` to preview.

`ib pull <repo>` fast-forwards main from each remote, or rebases it with `--rebase-merges` when it has diverged. It never forces, never rebases away commits another remote's main already has, and does nothing with uncommitted changes. A conflicted rebase is aborted; add `--interactive` to leave it in progress, with the conflicted files and next steps printed.

## Hooks

Claude Code hooks are how itsybitsy steers Claude. There are two groups: the hooks for **your own** Claude session, which you install once, and the hooks for **agent** sessions, which itsybitsy writes for you.

### Your own Claude session: install both

Enable both hook sets. Neither is installed automatically. Both are written to `~/.claude/settings.json`, so they apply to every Claude Code session you start, in every repo.

| Hook set | What it does | Install with |
|---|---|---|
| **Safety hooks** | Stops your Claude from `cd`-ing into agent worktrees. Adds a summary of agent status to its context on each prompt, and after a `Bash` or `Task` call when the status has changed. At session start, tells it how to use `ib`. | `ib hooks install` |
| **Task interception** | Makes Claude's built-in sub-agent tools (`Task`, `Agent`, `TaskCreate`) spawn real `ib` manager agents, so delegated work runs in its own tmux session and worktree where you can see it. Also denies `AskUserQuestion` (Claude is told to use `ib ask`) and `sleep` polling loops. | `ib hooks intercept-install` |

**From the dashboard:**

1. Register at least one repo (`ib add`, or `+` in the dashboard). Until a repo is registered, the dialog cannot install hooks.
2. Run `ib watch` and press `h`. The setup dialog opens on its **Hooks** tab, which lists **Safety hooks** and **Task interception**: `[x]` installed, `[~]` partly installed, `[ ]` not installed.
3. Select each row with `j`/`k` and press `Enter` to install it. Do this for both rows until both show `[x]`. (`Enter` on a row that is already installed uninstalls it.)
4. Press `Esc` to close.

**From the command line:**

```sh
ib hooks install            # safety hooks
ib hooks intercept-install  # Task interception
```

Both commands are safe to run again: they only add what is missing.

**Check that both are installed:**

```sh
ib hooks status             # prints: installed | partial | not-installed
ib hooks intercept-status   # prints: installed | not-installed
```

`partial` means that some of the safety hooks are missing from `~/.claude/settings.json`, for example after a hand edit. Run `ib hooks install` again (or press `Enter` on the row) to add them back.

After installing, start a new Claude session (or restart the ones that are open) so that it loads the hooks. The hooks call `ib` by name, so `ib` must stay on your `PATH`.

To remove them, run `ib hooks uninstall` and `ib hooks intercept-uninstall`, or press `Enter` on an installed row in the `h` dialog. Only itsybitsy's entries are removed. Your other settings stay as they are.

### Agent sessions: nothing to install

Each agent's hooks are written into its `settings.local.json` when it is spawned. They enforce path isolation, report state changes, inject the agent-type instructions at session start, and gate sub-agent spawning.

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

`./bounce.sh` runs `./build.sh` and then `./ib watch` in a loop: each time `ib watch` quits, it counts down 5 seconds, rebuilds, and relaunches. Press Ctrl-C during the countdown to stop the loop. It rebuilds only this checkout's `./ib`, so merged ib work reaches hooks and agents only when the `ib` on your `PATH` is that file: add the project directory to `PATH` (or symlink `ib` to it) rather than copying the binary to `/usr/local/bin`.

The system coordinator can start a bounce itself with `ib bounce`, which quits `ib watch` 5 seconds later (so Claude Code can save the coordinator's last turn first); the relaunched `ib watch` resumes the coordinator's session, tells it when the bounce happened and whether `ib` was rebuilt, and then sends it "ib watch has restarted after a bounce". `ib bounce` refuses unless exactly one `ib watch` is running and `bounce.sh` started it. A bounce leaves per-repo coordinators running.

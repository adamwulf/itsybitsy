# itsybitsy — Plan

A cross-repo agent management dashboard for [ittybitty (`ib`)](https://github.com/anthropics/ittybitty), built with Bun and pi-mono's TUI/web-ui libraries.

## Problem

`ib watch` and `ib list` are scoped to a single repo. When running agents across multiple projects simultaneously, there's no unified view — you have to `cd` into each repo separately.

## Goals

- **Unified dashboard** — see all running agents across all registered repos in one place
- **Launch agents** — spawn new agents in any registered repo from the dashboard
- **Ghostty integration** — open any agent's tmux session as a new Ghostty window or tab
- **Easy distribution** — single compiled binary via `bun build --compile`, no runtime dependencies beyond `ib`, `tmux`, `git`, and `claude`

## Approach

- **Runtime:** Bun
- **TUI:** [`@mariozechner/pi-tui`](https://github.com/badlogic/pi-mono/tree/main/packages/tui) — terminal UI with differential rendering
- **Web UI (optional):** [`@mariozechner/pi-web-ui`](https://github.com/badlogic/pi-mono/tree/main/packages/web-ui) — browser-based dashboard alternative
- **Agent data:** shell out to `ib list`, `ib look`, `ib status` per registered repo and aggregate results
- **Repo registry:** stored in `~/.itsybitsy.json`

## Architecture

```
itsybitsy
├── src/
│   ├── index.ts          # CLI entrypoint
│   ├── registry.ts       # Read/write ~/.itsybitsy.json repo registry
│   ├── ib.ts             # Shell out to ib commands, parse output
│   ├── tui/              # pi-tui dashboard
│   │   └── dashboard.ts  # Main TUI view: agent list across repos
│   └── ghostty.ts        # Open tmux sessions in Ghostty tabs/windows
├── PLAN.md
├── CLAUDE.md
└── package.json
```

## Ghostty Integration

Ghostty supports opening new windows/tabs via:
- `ghostty --command="tmux attach -t <session>"` — new window on a tmux session
- AppleScript may allow opening a tab in the existing window vs. a new window
- Ghostty's IPC/socket system (`ghostty +` commands) — needs investigation

Ghostty integration should degrade gracefully if Ghostty is not the active terminal.

## Repo Registry (`~/.itsybitsy.json`)

```json
{
  "repos": [
    { "path": "/Users/adamwulf/Developer/muse/muse-ios", "name": "muse-ios" },
    { "path": "/Users/adamwulf/Developer/bash/ittybitty", "name": "ittybitty" }
  ]
}
```

Commands to manage:
- `itsybitsy add [path]` — register current or specified repo
- `itsybitsy remove [path]` — unregister a repo
- `itsybitsy list` — list registered repos

## Next Steps

- [ ] Explore `pi-tui` API and build a minimal proof-of-concept dashboard
- [ ] Implement `registry.ts` — read/write `~/.itsybitsy.json`
- [ ] Implement `ib.ts` — shell out to `ib list` and parse agent state per repo
- [ ] Build the TUI dashboard: table of agents grouped by repo, with status
- [ ] Investigate Ghostty tab/window opening mechanism
- [ ] Implement Ghostty integration for attaching to agent tmux sessions
- [ ] Add `itsybitsy add/remove/list` CLI commands for repo registry
- [ ] Compile to single binary and test distribution
- [ ] (Optional) Add `pi-web-ui` browser dashboard as alternative view

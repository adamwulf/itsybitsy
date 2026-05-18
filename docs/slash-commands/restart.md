---
description: "Alias for /respawn: stop this agent's Claude session and start a fresh one in the same worktree so updated agent-type markdown files are re-read"
allowed-tools: ["Bash(ib:*)"]
---

`/restart` is an alias for `/respawn`. Same behavior:

Run `ib respawn` once. It will:

1. Detect the current agent from this session's working directory.
2. Schedule a detached restart: kill this Claude session and (for non-coordinator agents) start a fresh `claude --resume <session-id>` in the same worktree, OR (for coordinators) tear down and respawn the coordinator with rebuilt permissions and hooks.
3. The new Claude session re-runs the SessionStart hook, which re-reads the agent-type `.md` files from `~/.itsybitsy/agent-types/` — so any edits you've made are now active.

After running `ib respawn`, this session will end. The replacement session takes over the same tmux session.

**Do not** run `ib respawn` more than once.

Report what you ran in one line, then stop.

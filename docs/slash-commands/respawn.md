---
description: "Stop this agent's Claude session and start a fresh one in the same worktree so updated agent-type markdown files are re-read"
allowed-tools: ["Bash(ib:*)"]
---

You have been asked to respawn this agent's Claude session. Use this when you've edited your own agent-type markdown file (e.g. `~/.itsybitsy/agent-types/coordinator.md`, `worker.md`, `manager.md`, `_all.md`, or `_non_coordinator.md`) and want the changes to take effect.

Run `ib respawn` once. It will:

1. Detect the current agent from this session's working directory.
2. Schedule a detached restart: kill this Claude session and (for non-coordinator agents) start a fresh `claude --resume <session-id>` in the same worktree, OR (for coordinators) tear down and respawn the coordinator with rebuilt permissions and hooks.
3. The new Claude session re-runs the SessionStart hook, which re-reads the agent-type `.md` files from `~/.itsybitsy/agent-types/` — so any edits you've made are now active.

After running `ib respawn`, this session will end. The replacement session takes over the same tmux session. Reattach with `tmux attach -t <session-name>` if you were viewing it directly, or just watch the dashboard.

**Do not** run `ib respawn` more than once — it is idempotent but unnecessary noise.

Report what you ran in one line, then stop.

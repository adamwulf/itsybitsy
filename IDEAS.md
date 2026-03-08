# itsybitsy — Ideas & Future Directions

## Persistent Per-Repo Coordinator Agent

Run a single long-lived coordinator agent per repository, launched from the **real repo root** (not a worktree). This coordinator:

- Stays running continuously, monitoring the repo and receiving user requests
- Is the single entry point for all work on that repo — users describe what they want, the coordinator figures out how to accomplish it
- Spawns **lead builder agents** (managers, in worktrees) for each user request, tracks their progress, and reports results back
- Can parallelize independent tasks by spawning multiple builders simultaneously
- Maintains context about the repo's current state, active agents, and recent history across sessions

### Why this is valuable
- No need to manually `ib new-agent` for every task — just talk to the coordinator
- Coordinator accumulates institutional knowledge about the repo over time
- Automatic sequencing/parallelization of dependent vs. independent tasks
- Single place to check status of all in-flight work for a repo

### Open questions
- How does the coordinator receive requests? (stdin? a watched file? a socket?)
- How does it persist state across restarts?
- How do multiple repos' coordinators relate to each other (cross-repo tasks)?
- Should itsybitsy itself have UI for routing requests to a repo's coordinator?

## Agent Respawn (Resume Killed Agents)

When an agent is killed, preserve enough information to fully resurrect it later.

### What to store in `meta.json`
- **Claude session ID** — written at agent startup (available from `CLAUDE_SESSION_ID` env var or the `.jsonl` filename in `~/.claude/projects/<path>/`). Enables `claude --resume <id>` to restore full conversation context, not just restart from scratch.
- **Branch name** — already derivable from agent ID, but should be explicit.

### What to change in `ib kill`
- Instead of deleting the worktree and branch, just detach the worktree (`git worktree remove --force`) but **keep the branch**. Mark state as `killed` in `meta.json`.
- Archive the meta.json as today, but preserve the branch in git.

### `ib respawn <id>`
Reads the archived `meta.json` and:
1. Re-checks out the branch into a fresh worktree
2. Runs `claude --resume <session-id>` in that worktree — full conversation context restored
3. Re-registers the agent as active

### Why this is valuable
- Agents killed by mistake or due to resource pressure can be fully recovered
- Conversation context is preserved, not just the goal — the agent remembers what it was doing
- Enables a "pause and resume later" workflow for long-running agents
- **Institutional memory**: a new agent can respawn an old one and ask "why did you implement X this way?" or "what edge cases did you consider?" — getting a contextually-aware answer rather than reverse-engineering from code and git history alone

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

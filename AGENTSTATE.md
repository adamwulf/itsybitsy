# Hook-Driven Agent State Tracking

## Problem with Current Approach

itsybitsy currently determines agent state by polling `tmux capture-pane` output and running
it through `parseState()` — a priority-ordered regex matcher over ANSI-stripped text. This has
several weaknesses:

- **`unknown` state**: when output doesn't match any pattern, state is unknowable
- **Polling cost**: every watcher refresh captures tmux output for each active agent
- **Latency**: state is only as fresh as the poll interval
- **Fragility**: any change to Claude's output format can silently break state detection

## Proposed Architecture: Hook-Driven State in meta.json

State transitions are driven by lifecycle events (hooks and explicit actions), not by parsing
tmux output. `meta.json` is the source of truth for agent state. The watcher only reads
`meta.json` — it never writes.

### State Machine

```
                      ib new-agent
                           │
                           ▼
                       creating
                           │
                    ib send (first prompt)
                           │
                           ▼
        ┌──────────── running ◄────────────────────┐
        │                  │                        │
        │           Claude exits                    │
        │         (stop hook fires)                 │
        │                  │                        │
        │      ┌───────────┼───────────┐            │
        │      ▼           ▼           ▼            │
        │   waiting    complete   rate_limited       │
        │      │                       │            │
        │   ib send              ib send (resume)   │
        │      └───────────────────────────────────►┘
        │
        │  (tmux session gone)
        └──────────► stopped
                        │
                    ib resume
                        │
                        └──────────────────────────►running
```

### State Definitions

| State | Set by | Meaning |
|-------|--------|---------|
| `creating` | `ib new-agent` writes to meta.json | Agent spawned, waiting for first prompt |
| `running` | any `ib send` writes to meta.json | Claude is processing or will process next message |
| `waiting` | stop hook detects idle output | Claude finished a turn, idle, ready for input |
| `complete` | stop hook detects completion signal | Agent signaled "I HAVE COMPLETED THE GOAL" |
| `rate_limited` | stop hook detects rate limit prompt | Hit API rate limit, waiting for reset |
| `stopped` | tmux session not found | Session killed or exited without hook; needs `ib resume` |

**No `unknown` state** — every agent is always in one of the above.

### Hook Responsibilities

**`ib new-agent`**: writes `state: "creating"` to `meta.json` before launching tmux.

**On `ib send`** (any message to an agent): writes `state: "running"` to `meta.json` before
delivering the message. This covers:
- Initial prompt (creating → running)
- User messages (waiting → running)
- Resume after rate limit (rate_limited → running)

**Stop hook** (fires when Claude's process exits, tmux session persists):
1. Capture current tmux pane output
2. Parse for one of three terminal states:
   - Idle/waiting prompt → write `state: "waiting"`
   - Completion signal ("I HAVE COMPLETED THE GOAL") → write `state: "complete"`
   - Rate limit prompt → write `state: "rate_limited"`
3. If none match: send a message to the agent asking it to end with `WAITING` or
   `I HAVE COMPLETED THE GOAL` — this keeps the agent in `running` state until
   it stops again with a parseable output.

**tmux session missing**: detected by the watcher at read time (no poll needed) → `stopped`.

### Compacting

Context compaction causes Claude to exit and auto-restart. The stop hook fires on exit.

**Recommended approach**: treat compaction as `running` — do not write `compacting` to
meta.json. The stop hook can detect compaction output and skip writing any state change,
leaving the state as `running`. The agent will resume automatically.

If ib fires a separate compaction-start hook in the future, a `compacting` state could be
added trivially.

### What the Watcher No Longer Needs

- `captureTmuxOutput()` per-agent on every refresh (eliminated for state detection)
- `parseState()` on watcher refresh path (only needed in stop hook now)
- `detectAgentStates()` polling loop

The watcher simply reads `meta.json` for each agent — state is always current.

## Benefits

1. **No `unknown`** — every transition is explicit
2. **No polling** — state updates are push-based via hooks
3. **Accuracy** — state reflects actual lifecycle events, not inferred from text output
4. **Simplicity** — watcher becomes a pure reader of pre-computed state
5. **Speed** — no tmux spawn per agent on refresh

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Hook not configured | Detect missing hook at startup, warn user |
| Hook crash / silent failure | State stays `running` (acceptable; same as current unknown) |
| meta.json write contention | Only hooks write; watcher reads only — no contention |
| `ib resume` without hook | `ib resume` itself writes `running` to meta.json |

## Implementation Plan

> **Prerequisite**: This should only be built after itsybitsy has fully taken over all agent
> lifecycle management from `ittybitty` — including spawning, running, hook installation,
> and agent management. Building this on top of `ittybitty`'s hook system would create tight
> coupling to infrastructure we intend to replace.

### Phase: Hook-Driven State (future)

1. **`ib new-agent` integration** — when itsybitsy spawns agents, write `state: "creating"` to
   `meta.json` at creation time.

2. **`ib send` integration** — before delivering any message, write `state: "running"` to
   `meta.json`.

3. **Stop hook** — register a hook that fires on Claude exit; parse final tmux output and
   write the correct state (waiting/complete/rate_limited), or send the fallback message.

4. **Watcher simplification** — remove `detectAgentStates()` and `captureTmuxOutput()` from
   the refresh loop. Read state directly from `meta.json`.

5. **`stopped` detection** — in the watcher, if `meta.json` shows a non-stopped state but
   the tmux session is gone, write `stopped` (or treat as stopped at read time).

6. **Remove `parseState()`** from hot path — keep it only in the stop hook. Eventually
   replace with a simpler pattern match (only three states to detect, not twelve).

7. **Tests** — unit test the stop hook logic; integration test the full state machine.

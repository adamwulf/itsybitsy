# iroh peering: remote agent screens and remote merge/retire/rehire

Status: requested by Adam on 2026-11-23. This plan follows [iroh-remote-messaging.md](iroh-remote-messaging.md) and [iroh-unified-repos.md](iroh-unified-repos.md).

## Goal (Adam, 2026-11-23)

> "viewing any remote agent's screen with scrollback (today only the other machine's @system is visible, about 200 lines) — lets add this"
>
> "merging, retiring and rehiring remote agents — and this too"

## Bar (Adam's calibration)

The golden path must work, and it must be hard for an agent to get wrong by accident. This is not adversarial, enterprise-grade hardening, and the sandbox owns file permissions. Reuse the existing peer request, exchange and caller-gate machinery. Add no new transport or trust mechanisms.

## A. Remote agent screens with scrollback

**Today.** Highlighting a peer's `@system` row fetches that machine's coordinator pane (the `coordinator-pane` request) about every 2 seconds. The view is read-only and covers about 200 lines. Remote agent rows show no screen.

**Change**

1. **New pane request.** A new peer request asks for any agent's pane, identified by its registered repo name and agent id. It reuses the shared `clientExchange` and `sendReply`, and Rule T teardown, like the other requests.
   - The responder resolves the agent from its own registry.
   - It captures that agent's tmux pane with the same verified capture the local dashboard uses: escape codes kept, then sanitized for display.
   - It returns the text with the agent's state.
   - An unknown agent, or one whose session is gone, gets a standard error reply.
2. **Scrollback.** The request carries how many lines to fetch, computed like the local pane: visible height plus scroll offset plus 10, with a floor of 200 and a cap of 5,000 lines. Scrolling back in the dashboard raises the next request's line count. The peer `@system` pane uses the same scrollback rule instead of its fixed 200 lines.
3. **Dashboard behaviour.** Highlighting a remote agent row requests its pane immediately, then about every 2 seconds, with at most one outstanding request per peer. This matches the peer `@system` pane, including the rules for pausing while a dialog is open, timing out, and discarding stale results.
   - The pane is read-only.
   - `s` still opens the message editor for that agent.
4. **Caller gate.** The caller is decided the same way as for the peer `@system` pane today: the dashboard's startup human-caller decision. There is no CLI command for this.

## B. Remote merge, retire and rehire

**Today.** Remote agent rows refuse merge, retire and rehire with "Read-only remote agent". Starting a new agent (`new-agent`) is the only remote lifecycle action.

**Change**

1. **New lifecycle request.** A new peer request carries `{action: merge | retire | rehire | resume, repo, id}`. The dashboard keys mirror local rows: `m` merge (merge check first), `x` retire (confirmed), `R` resume (no dialog). Rehire of a retired agent is CLI-only (`ib rehire <machine>/<agent>`), resolved from the receiving machine's archive, because retired agents are not shown as rows. The responder resolves the agent from its own registry and runs its normal local code path, the same `mergeAgent`, `retireAgent` or `rehireAgent` the local dashboard calls. It returns that command's result: ok, or the error text. The other machine therefore behaves exactly as if its own user had pressed the key. For example, a merge conflict returns the normal conflict error.
2. **Who may do it.** Default: the same rule as a remote start, meaning any paired machine, but only when initiated by a human. That covers the dashboard's startup human-caller decision and a human terminal outside tmux. Agents cannot merge, retire or rehire remote agents for now. Later gating can go through agent-type `.md` files, as with remote start.
3. **Dashboard.** On a remote agent row, the local merge, retire and rehire keys work with the same confirmation dialogs as local rows. While the request runs, the row shows a pending notice. When it ends, a notice shows the remote result. The receiving machine shows `<A> merged|retired|rehired <id> in <repo>`.
4. **CLI.** `ib merge`, `ib retire` and `ib rehire` accept `<machine>/<agent>`, using the same qualified-address resolution as `ib send`. They work only from a human terminal outside tmux; otherwise the existing clear refusal applies. `--force` keeps its local meaning on the remote side.
5. **Waiting for the result.** The command waits for the result, the same as a remote new-agent. Merge waits up to 2 minutes, retire and rehire up to 30 seconds. A timeout reports `outcome unknown — check <machine>`.

## Phases

- **R1. Remote agent screens (A).**
- **R2. Remote merge, retire and rehire (B).**

The two are independent and can be built in parallel. Each phase gets a review cycle under Adam's bar. Afterwards, add Phase 8 checklist steps for viewing a remote agent's screen, scrolling back, and merging, retiring and rehiring a remote agent from both the dashboard and the CLI.

## Defaults pending Adam's confirmation

1. Remote merge, retire and rehire are human-only, the same as remote start.
2. Scrollback is capped at 5,000 lines per request.
3. The CLI covers merge, retire and rehire. Remote screens are dashboard-only.
4. The CLI waits for the result: 2 minutes for merge, 30 seconds for retire and rehire.

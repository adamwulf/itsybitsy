# iroh peering: remote coordinator view and remote sends

Status: Feature A built on 2026-11-22.

This plan follows `iroh-unified-repos.md` (Phases 6–7, on main). Adam asked for two features on 2026-11-22:

1. **Remote coordinators in the tree.** When peers are connected, show each peer's coordinator under our coordinator, with the peer name in italic. The row is selectable. Highlighting it shows that machine's coordinator log.
2. **Sending messages to agents on peers.**

Both features run on the existing trusted ALPN `itsybitsy/peer/1` and reuse its allowlist rules (§20.4): the responder checks the allowlist when it accepts a stream and checks it again before it answers. Each feature is a new op.

## A. Remote coordinator view

- **Tree.**
  - Under the `@system` row, add one row for each paired peer: `<peer name>`, in italic, followed by that machine's coordinator state.
  - When the peer is unreachable, the row is dimmed and shows how long ago it was last seen.
  - The row has its own key in the tree, so selection and navigation work as they do for other rows.
  - Per-repo coordinators stay hidden.
- **Log.** While the row is highlighted, `ib watch` sends `{"op":"coordinator-pane"}` about every 2 s. No request is sent while the row is not highlighted.
  - The reply is the coordinator pane's capture: the same text the local pane shows, with ANSI escapes limited to the existing allowlist.
  - The reply is capped. A request that fails keeps the last capture and shows the error.
- **Responder.**
  - It captures the coordinator pane itself.
  - It writes one `watch.log` line the first time each peer reads the pane.
  - It does not run any command on behalf of the requester.
- **Guard.**
  - The row stays read-only. It has no input box, and retire, resume and every other action are refused with a notice.
  - This changes if Adam answers B.1 to include the coordinator.

## B. Remote sends

**REVISED (Adam, 2026-11-22): mirror local `ib send` exactly.**

- A remote send carries its sender: `{"from":{"kind":"user"}}` or `{"from":{"kind":"agent","id":"<machine>/<repo>/<agent>"}}`.
- The receiving machine delivers it exactly as it would a local send from that sender:
  - The same queue, through `agentOutboxDir` and the watchdog.
  - The same formatting: a user send follows the user rules, including slash and bang passthrough. An agent send is shown as `[sent by agent <machine>/<repo>/<id>]`.
  - The same `ib send` gate rules for agents.
- **Senders:**
  - `ib send <machine>/...` from the CLI, for both users and agents. The 6b resolver already parses these forms.
  - The `ib watch` input box, when a remote row is selected. This counts as a user send.
- The CLI hands the message to the local `ib watch`, which owns the endpoint, and waits up to about 10 s for the receiver's ok or error.
- If no `ib watch` is running, the send fails with a clear error.
- Sandboxed agents keep using the watchdog broker, as they do for cross-repo sends.

The bullets below are the original, superseded proposal. They are kept for reference.

- **Sender: a human in `ib watch` only (first step).**
  - With a remote agent row selected, the input box sends a `{"op":"send","repo","agent","message"}` request to that peer.
  - The request uses the recipient's registry name and id.
  - The message is size-capped.
  - The CLI form, `ib send <machine>/<repo>/<agent>`, still fails with "not supported yet". So do sends from agents. See question B.1.
- **Receiver.**
  1. It runs the allowlist checks.
  2. It resolves the repo and agent in its own registry.
  3. It enqueues the message through its normal outbox, into the recipient's own queue (`agentOutboxDir`), so watchdog delivery, dedupe and queue rules apply unchanged.
  4. It writes a `watch.log` line and shows a notice: "<peer> sent a message to <agent>".
  5. It replies `{"ok":true}` or `{"ok":false,"error"}`.
- **Attribution.** The recipient sees `[sent by <peer name>]: <message>`.
- **Always prefixed.** A remote send is NEVER `raw`, and NEVER uses the user slash/bang passthrough (§4.x).
  - Without this rule, a remote `!cmd` would run a shell command in the recipient's pane, and a remote `/clear` would wipe its context.
  - A leading `/` or `!` is therefore delivered after the prefix, as plain text.
- **Sender UI.**
  - The send returns as soon as the receiver has queued the message. A success shows "Sent to <machine>/<agent>". A failure shows the receiver's error.
  - No delivery confirmation is waited for. That matches local `ib send`.

## Cross-cutting

- **Agents.**
  - For A, no `meta.json` change and no new agent-facing command.
  - For B, the receiving machine's watchdog delivers the message exactly as it delivers a local send.
- **Hooks.** Unchanged for the first step. A CLI or agent path in B.1 would need gate changes.
- **Watchdog.** Unchanged. It delivers from the queue as usual.
- **`ib watch`.**
  - The tree gets the remote coordinator rows.
  - The output pane shows the remote capture.
  - The input box works on remote agent rows.
  - Notices appear on both sides.

## Questions for Adam (recommendation first)

- **A.0 Which coordinator: DECIDED (Adam, 2026-11-22).** The system coordinator (`@system`).
- **A.1 Exposure.** Any paired machine can read this machine's coordinator screen. Pairing is the trust decision, as it is for remote starts. Adam asked for the feature, so this is taken as accepted.
- **A.2 Refresh rate: DECIDED (Adam, 2026-11-22).** About 2 s while the row is highlighted, for now.
- **A.3 Read-only.** The coordinator row has no sends until B decides whether it gets them.
- **B.0 DECIDED (Adam, 2026-11-22).** Remote sends mirror local `ib send` exactly, and the sender is either a user or an agent. B.1–B.3 below are superseded. What remains to confirm:
  - **(i)** A remote user send keeps slash and bang passthrough. A human on the other machine can run `/clear` or `!cmd` in agent panes here.
  - **(ii)** The receiver trusts the sending machine's user or agent label. It cannot verify that label. This is the same trust it already gives that machine's local classification.
  - **(iii)** Remote sends need `ib watch` running on both machines.
  - **(iv)** The CLI waits up to about 10 s for the receiver's result.
  - **Answers (Adam, 2026-11-22):** (i) yes, (ii) yes, (iii) yes.
  - **(iv) revised.** The receiver checks the request, adds it to the recipient's queue, and acknowledges at once. The sender returns as soon as that acknowledgement arrives. It never waits for delivery. This matches local `ib send`, which also returns once the message is queued. The message then reaches the agent through the receiver's watchdog, and the agent's response shows up in later polls.
    - The 10 s limit is only a timeout, used when the other machine does not answer at all.
    - A validation error comes back in the acknowledgement, the same as a local `ib send` to an unknown agent. Examples: an unknown repo or agent, or a gate refusal.
- **B.1 Who may send.** Recommended: (a) a human in `ib watch` first.
  - (b) Also humans through `ib send <machine>/...` from the CLI. The CLI would need to hand the request to the running `ib watch`, which owns the endpoint.
  - (c) Agents too, so an agent on one machine can message an agent on the other.
  - Should the remote coordinator row accept sends as well?
- **B.2 Trust.** Recommended: any paired peer may send to any agent here. This is the same rule as remote start.
- **B.3 Prefix.** Recommended: remote sends are always prefixed, with no slash or bang passthrough.
- **Order.** A, then B, each with the usual two-reviewer cycle. Both start after the Peers-tab move is merged, because they touch the same dashboard code.

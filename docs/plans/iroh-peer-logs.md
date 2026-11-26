# Exporting connection logs from both peers

Status: proposal, waiting on Adam (2026-11-25).

Goal: when the iroh link between two installs misbehaves, one command
collects what both `ib watch` processes logged, so Adam or an agent can read
both sides of the same event.

## How the link works today

- `ib watch` owns the iroh endpoint (`src/peers/service.ts`, SPEC.md §20.3).
  Its poller (`src/peers/poller.ts`) dials each paired peer on the trusted
  ALPN and asks for `agents` every 5 s, with a 15 s deadline per request. One
  connection per peer stays open between polls. Each side also accepts the
  other's dial, so a pair normally has two connections.
- Paths are relayed (n0 relays) or direct UDP. `service.ts` `logPath` logs the
  selected path and RTT when a connection opens and on each path change.

## What is logged today

Everything goes to `~/.itsybitsy/watch.log` (`src/watch-log.ts`): rotated at
1 MB into `watch.log.1` and `watch.log.2`, so about 3 MB in all, which is a few
days of history. Peering lines:

- endpoint: `peering: binding at boot…`, `endpoint bound as …`, rebind and
  backoff lines, `incoming connection failed: …`;
- dialer (poller): `connected to <peer>`, then one line per change of failure:
  `request timed out`, `timed out` (QUIC idle), `closed by peer: 0`, `closed`;
- acceptor: `<id> connected`, `refused …`, `not a peer`;
- both: `dialed|accepted <peer>: relayed via … | direct to …, rtt N ms` and
  `path changed: …`;
- remote operations (sends, starts, lifecycle, pane reads) and transfers.

Native panics (for example in the iroh addon) end up in
`~/.itsybitsy/watch-stderr.log` when `ib watch` runs under `bounce.sh`, and
`[crash]`, `[exit]` and `[bounce.sh]` records are in `watch.log` (SPEC.md §8.14).

## What is missing for debugging

Read from this machine's log for 2026-11-23 to 2026-11-26.

1. **One side only.** The most common failure is
   `adam's laptop: request timed out` → `closed` → redial a few seconds
   later. Whether the laptop received the poll, answered late, or was asleep
   is only in the laptop's log, and nothing collects that log.
2. **The answering side does not log its timing.** A slow `agents` answer
   (agent detection, a stalled event loop) looks the same from the dialer as a
   network drop.
3. **A misleading line.** At 2026-11-26T01:26:05 the log reads
   `pairing lookup failed: Peer connection closed` and then
   `refused a request from bb5521e473: no longer a peer; closing`. The lookup
   was aborted because the connection had closed, not because the peer was
   removed (`serveTrustedConnection` in `peer-link.ts` treats a failed lookup
   as "not a peer").
4. **No stall or sleep marker** apart from Telegram's
   `wake from sleep detected`, which is logged only when the Telegram channel
   runs.
5. **The two clocks are never compared.** Merging two logs by timestamp can
   put events in the wrong order.

## Proposed v1

### Command

```
ib peer logs [<machine>] [--since <duration>] [--out <dir>]
```

- Defaults: every paired peer, `--since 24h`,
  `--out ~/.itsybitsy/log-exports/<UTC stamp>/`.
- Writes one directory:
  - `<this machine>.log`: lines from `watch.log.2`, `.1` and `watch.log` newer
    than `--since`, oldest first. Lines with no timestamp (continuation lines
    of a `[crash]` record) stay with the line before them.
  - `<peer>.log`: the same lines from the peer, fetched over the trusted link.
  - `merged.log`: both, interleaved by timestamp, each line prefixed
    `[<machine>]`.
  - `summary.txt`: for each machine, the ib version, machine name, short id
    and paired peers; also the export time, an estimate of the clock offset
    (the peer's clock minus the midpoint of the request), and whether the
    remote part was cut short or failed.
- Prints the directory and one line per peer, for example
  `adam's laptop: 2314 lines, clock +0.4 s` or
  `adam's laptop: unreachable (Machine is disconnected); local log only`.
  Exits 1 when any peer failed. The local part is always written.

### Wire

- A new trusted-link op `logs` with `{since}`. The reply is
  `{op: "logs", now, version, name, text, truncated}`.
- The reply stays under the existing 1 MB cap (`PEER_MAX_REPLY_BYTES`): the
  newest lines are kept and `truncated` is set. Deadline 30 s.
- It uses the poller's live connection, like pane reads; no new dial.
- A peer running an older `ib` answers with an error, which is reported as
  `peer's ib does not support logs`.
- The answering side logs one line, like the coordinator-pane read:
  `peer link: <peer> (<id>) read the watch log (N lines)`.

### From the CLI to `ib watch`

The request goes through the existing peer outbox (`src/peers/peer-outbox.ts`)
as a third kind beside send and lifecycle. Like `ib merge <machine>/…`, it
needs `ib watch` running on this machine.

### Who can run it

`ib peer` is human-only: the agent hook denies it. v1 keeps that rule. Adam
runs the command, and agents read the export directory, which is a plain
directory under `~/.itsybitsy`. To let worktree agents run it themselves, the
request would have to go through the watchdog broker the way remote sends do,
because sandboxed agents cannot write to the peer outbox. That roughly doubles
the work, so it is a follow-up.

## Optional logging additions (each needs approval)

- **A. Answer timing.** When answering a request takes 5 s or more, log
  `peer link: answered agents for <peer> in 12.3 s`. This tells a slow far
  side apart from a network problem behind `request timed out`.
- **B. Fix the misleading `no longer a peer` line.** A lookup aborted by the
  connection closing logs that and closes quietly, without saying the peer was
  unpaired.
- **C. Event-loop stall line** while the endpoint is bound: when a 1 s timer
  fires 5 s or more late, log `peering: event loop stalled for 9.8 s`. This
  also catches sleep.
- **D. Connection age and path on failure lines:**
  `request timed out (up 7m12s, direct, rtt 12 ms)`.

## Files

`src/peers/{peer-link,service,peer-outbox,peer-command}.ts`, a new
`src/peers/logs-export.ts` with tests, SPEC.md §20.4, and
`docs/implementation-notes.md`. Nothing changes in `ib-commands.ts`,
`watcher.ts` or the dashboard, which the scheduled-tasks work is likely to
touch.

## Cross-cutting checklist

1. Agent functionality: not affected.
2. Hooks: not affected in v1 (`ib peer` stays human-only).
3. Watchdog: not affected in v1.
4. `ib watch`: answers the new op and runs the outbox kind. No UI change.

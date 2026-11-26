# Exporting connection logs from both peers

Status: decided by Adam on 2026-11-25; being implemented on `agent/connection-logs`.

Goal: when the iroh link between two installs misbehaves, one command
collects what both `ib watch` processes logged, so Adam, @system or another
agent can read both sides of the same event.

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
  `request timed out`, `timed out` (iroh), `closed by peer: 0`, `closed`;
- acceptor: `<id> connected`, `refused …`, `not a peer`;
- both: `dialed|accepted <peer>: relayed via … | direct to …, rtt N ms` and
  `path changed: …`;
- remote operations (sends, starts, lifecycle, pane reads) and transfers.

Native panics (for example in the iroh addon) end up in
`~/.itsybitsy/watch-stderr.log` when `ib watch` runs under `bounce.sh`.
`[crash]`, `[exit]` and `[bounce.sh]` records are in `watch.log` (SPEC.md §8.14).

## What the CI machine's log showed

Adam's report: when the CI machine's display turns off, the laptop loses the
link. In this machine's `watch.log` for 2026-11-25 to 2026-11-26, the
Telegram timer-gap check logged `wake from sleep detected` four times: at
18:42:18Z (slept about 66 s), 01:26:05Z (about 65 s), 01:31:41Z (about 21 s)
and 01:36:51Z (about 119 s). Each time:

- the laptop's connection into this machine had closed while this machine was
  frozen;
- dials the laptop made during the freeze failed here at wake with
  `Incoming.accept: TimedOut`, and then a new connection came in;
- the log said `refused a request from bb5521e473: no longer a peer`, right
  after `pairing lookup failed: Peer connection closed`.

That last line is wrong: the lookup was aborted because the connection had
closed, and `serveTrustedConnection` treats any failed lookup as "not a peer".
The side that accepted the connection also logged nothing when it closed. The
Telegram check measures a timer gap, so on its own it can't tell a system
sleep from a suspended process. The `system: …` lines from the
system-event-logging work (OS sleep, wake, display and lock notifications,
plus `pmset` entries read after a wake) give the OS view in the same file.

## Decisions

- **Logging rule:** every line states what the process observed when it wrote
  it, never an inferred cause.
- **Disconnect lines on both ends**, in one format:
  `peer link: <name> (<short id>): disconnected (dialed|accepted, up <dur>): <reason>`.
- **Fix the misleading "no longer a peer" line.** A lookup aborted by the
  connection closing is not a refusal.
- **Answer timing:** when a request/reply op takes 5 s or more to answer, log
  `peer link: answered <op> for <name> (<short id>) in 12.3 s`.
- **Late-timer line** while the endpoint is bound:
  `peering: 1 s timer ran 9.8 s late`. The line states only the measurement;
  it does not guess between a blocked loop, a suspended process and a sleep.
- **`ib export-logs [<machine>] [--out <dir>]`** copies the full `watch.log`,
  `watch.log.1` and `watch.log.2` from this machine and from each paired peer
  into `~/.itsybitsy/log-exports/<UTC stamp>/<machine>/`, plus an
  `export.txt` that holds only facts: ids, versions, file sizes, the measured
  clock difference and its uncertainty, and any fetch error. There is no
  merged file and no analysis.
- **Transport:** the peer's files come over a new framed trusted-link op, in
  the style of `agent-diff`. The CLI reaches `ib watch` through the peer
  outbox.
- **Access:** humans and @system. The agent hook denies the command to every
  other agent, as it does for `ib bounce`. `ib peer` stays human-only.

## Cross-cutting checklist

1. Agent functionality: @system's default prompt
   (`docs/agent-types/system-coordinator.md`) gains the `ib export-logs`
   paragraph. An installed `system-coordinator.md` gets this paragraph by
   hand; there is no migration (`ib init-types` restores only missing files).
   Otherwise not affected.
2. Hooks: `export-logs` is allowed only for @system among agents.
3. Watchdog: not affected.
4. `ib watch`: answers the new op, runs the new outbox kind and writes the
   new log lines. Two visible changes:
   - The Peers tab's error text (`lastError`) for an agents poll that gets
     no answer changed from `request timed out` to
     `no reply to the agents poll within 15 s`.
   - A watch-log copy is a transfer, so the keep rule (SPEC §20.4 "Slow
     links") can now hold a link's displayed state (connected, its last
     lists, a remote pane) through timeouts during a watch-log copy. On the
     machine that answered the copy, it also holds for 60 s after that
     machine's reply write ended ok. A timeout kept near the end of that
     window holds until its next 15 s check.

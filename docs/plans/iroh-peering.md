# iroh peering plan

## Goal

Two itsybitsy installs on two laptops connect over [iroh](https://www.iroh.computer),
a peer-to-peer QUIC library in which each identity is an ed25519 public key.
Each install has its own key pair.

Pairing works like this:

1. You enter install B's public key in install A's watch window.
2. B shows an 8-character code.
3. You type that code into A.
4. You give each side a name for the other.

After pairing, each install trusts the other and can find it by key. Each
`ib watch` sidebar tree then shows the other install's repos and agents, with
one read-only section per install.

## Research findings

**iroh from Bun.** n0 publishes official Node bindings, `@number0/iroh`. They
use napi-rs and are built from `n0-computer/iroh-ffi`. Version 1.2.0 came out
in Oct 2026. These are the calls this plan uses:

- `SecretKey.generate()`, `.toBytes()`, `.fromBytes()`, `.public()`
- `Endpoint.bind({ secretKey, alpns })`, `ep.id()`, `ep.acceptNext()`,
  `ep.close()`
- `ep.connect(new EndpointAddr(id), alpn)` dials a peer by its id alone.
- `conn.remoteId()` returns the peer's authenticated id.
- `conn.openBi()` / `acceptBi()`, `writeAll`, `read(limit)`, `finish`
- `EndpointId.fromString()`, `.toString()`, `.fmtShort()`. An id is 64
  lowercase hex characters, and the short form is the first 10.

**Phase 0 (done, see [iroh-spike-findings.md](iroh-spike-findings.md)).** All
five checks passed on Bun 1.3.10 with `@number0/iroh` 1.2.0:

- Two processes found each other by id alone through n0, and
  `conn.remoteId()` matched the dialing side's id.
- A plain `import` embeds the addon in a binary built with the exact `ib`
  flags, and that binary runs from a directory with no `node_modules`.
- The addon adds about 12.3 MB (71 → 83 MB). A run that never loads it
  showed no measurable change in `--version` CPU time.
- Loading the addon costs about 25 ms of CPU but 230–400 ms of wall time in
  the compiled binary, on every load.
- A relay-disabled loopback on `127.0.0.1` connects in 1–2 ms.
- The process exits once `ep.close()` has been called.

Its only macOS build is arm64. Both laptops are Apple Silicon, so this is
fine.

API quirks the code has to handle:

- Every byte buffer is a plain `Array<number>`. `Uint8Array` and `Buffer` are
  rejected.
- Every error is a plain `Error` with `code: "GenericFailure"`. The meaning is
  only in the message text.
- `EndpointId.fromString` accepts only exact lowercase hex. Input must be
  trimmed and lowercased first.
- `read(limit)` returns whatever chunk has arrived. `readToEnd(limit)` throws
  `TooLong` when the stream is over the limit.
- A failed handshake rejects `accept()` on the server, so the accept loop must
  catch errors per connection. A loop without that catch died, and every
  later dial to it hung.
- A dial can take up to 30 s to fail.
- A pending `acceptNext()` keeps Bun alive until `ep.close()` is called, at
  which point it resolves with `null`.

**Connecting by key alone.** `Endpoint.bind()` applies the n0 preset, which
turns on n0's public relays and discovery:

- Discovery publishes signed pkarr records to n0's DNS server, and looks peers
  up through `dns.iroh.link`.
- Given only an id, iroh finds the peer's relay or direct address and
  hole-punches to it.
- Traffic is end-to-end encrypted. The relays and DNS see ids and IP
  addresses, but not content.
- Moving to our own relays later should only change the relay map passed to
  `bind`, since `RelayMode.customFromUrls` exists.

**How it fits itsybitsy.**

- `ib` is a single Bun binary. Every hook and statusline call starts it, so
  start time matters (see AGENTS.md, `--bytecode`).
- The only long-running user process is `ib watch`. Telegram already runs
  there: `src/channels/boot.ts`, booted from `src/tui/dashboard.ts` around
  line 3800. It starts in the background after the TUI mounts, never blocks
  the TUI, and logs to `watch.log`. It has no single-instance lock. A second
  `ib watch` finds out about the first only through Telegram's 409 reply.
- The sidebar tree is built from the `FlatEntry` union in `src/agents.ts`
  (`agent`, `repo-header`, `parent-header`, `system-coordinator`).
- Agents can read all of `~/.itsybitsy`, because of the read floor in
  `docs/agent-types/_all.md`. Only `sealed/` is denied, so a secret key
  stored there needs its own deny entry.
- `ensureAgentTypesDir()` writes the agent-type templates only on first run.

## Design

### Integration

- `@number0/iroh` becomes a root dependency, so `bun test` can load it from
  `node_modules`.
- Only `src/peers/iroh.ts` imports it, and only through a dynamic `import()`,
  the same way `ib watch` loads Telegram.
- Only `ib watch` ever loads the addon. Hooks and the `ib peer` commands
  never do, so their start time does not change.
- `ib peer id` derives the public key from `secret.key` with `node:crypto`
  (ed25519). A test checks that the result matches what iroh reports for the
  same key.
- `src/peers/iroh.ts` is a thin wrapper:
  - it converts `Uint8Array` to `Array<number>` and back at the boundary;
  - it turns the addon's errors into short messages;
  - it exposes only the calls this plan uses.
- `ib watch` calls `ep.close()` on exit.

### Process model

- The endpoint lives in `ib watch`, so peering only works while `ib watch` is
  running.
- `ib watch` binds the endpoint at boot if `peers.json` lists at least one
  peer, or when you open the Peers dialog. An install that never pairs never
  touches the network.
- Once bound, the endpoint stays up until `ib watch` exits, or until its
  accept loop fails.
- **Self-heal.** After a failure (a bind that fails, or the accept loop
  failing), `ib watch` closes the endpoint, releases the lock, and rebinds on
  its own through the same path (the lock, then the bind, then the poller).
  It waits 5 s, then doubles the wait each time up to 60 s; a successful bind
  resets the wait. It retries only while `peers.json` lists a peer or the
  Peers dialog is open. It stops when another live `ib watch` holds the lock
  (peering shows as disabled, and the lock is not polled) and on exit.
  Opening the dialog while a retry is pending binds at once instead. Each
  failure is one `watch.log` line with its wait; once the wait reaches 60 s,
  a repeat of the same failure is not logged again. Recovery is logged, and
  the dialog shows "retrying in N s" with the last error.

**One endpoint per machine.** Two endpoints with the same key would fight: the
relay keeps one connection per id, the discovery records would overwrite each
other, and requests could reach either process. So only one `ib watch` owns
the endpoint:

1. Before binding, `ib watch` creates `~/.itsybitsy/peer/endpoint.lock` with
   `O_CREAT|O_EXCL` and writes `<pid> <startEpoch>` into it. `startEpoch` is
   its real process start time.
2. If the lock exists and its process is alive (the same pid with the same
   start time), this `ib watch` skips peering.
   It logs "peering disabled: ib watch pid N owns the endpoint" to
   `watch.log`, and its Peers dialog says the same.
3. If that process is gone, this `ib watch` takes the lock over. "Gone" means
   the pid is dead, or it now belongs to a process with a different start
   time. A different start time can happen after a reboot. The owner deletes
   the lock when it exits.

A second `ib watch` tries for the lock only at the two bind moments above
(and a retry that finds the lock held stops there). So once the owner exits,
opening Peers or restarting moves peering to the second one. This works like Telegram, where the first poller wins.

### Key generation and storage

- `loadOrCreateIdentity()` in `src/peers/identity.ts` reads
  `~/.itsybitsy/peer/secret.key`, which holds 32 bytes as hex. If the file is
  missing, it generates a key and writes the file with mode 0600, inside a
  directory with mode 0700.
- The same key is used on every run, so the install's id never changes.
- Trusted peers live in `~/.itsybitsy/peer/peers.json` as
  `[{id, name, pairedAt}]`. The file is written atomically. Peers are keyed by
  id, and the name is only a label.
- `~/.itsybitsy/peer/secret.key` is added to `paths.deny` in the embedded
  `_all.md`. That one entry blocks the key at both the hook layer and the
  kernel layer, the same way `sealed` is blocked. Adam adds the same line to
  his installed `_all.md` by hand; there is no migration code.
- No agent can write anything under `~/.itsybitsy/peer/`, so no agent can add
  a trusted peer. Ordinary agents don't have it in `allowWrite`. `@system` is
  not kernel-sandboxed, and its hook table can write all of `~/.itsybitsy`, so
  `peer/` is on its protected write list (`systemProtectedWritePaths`).

### Pairing

`ib watch` gets a new **Peers dialog**, opened with `I` (currently unused). It
shows this install's id, the paired peers with their connection state, and a
"Pair with id" input.

Pairing uses its own ALPN, `itsybitsy/pair/1`, on one connection. Each
request and reply has its own bi stream:

- A writes one JSON message and calls `finish`.
- B reads it with `readToEnd(4096)`, writes one JSON reply, and calls
  `finish`.

This needs no framing code. B ties the pending code to the connection.

1. On B, open the Peers dialog to read B's id (64 hex characters), and leave
   it open. B accepts pairing only while that dialog is open.
2. On A, paste B's id. A trims and lowercases it, checks it with
   `EndpointId.fromString`, dials B, and sends `pair-hello`.
3. B accepts the request only if its Peers dialog is open and no other
   pairing is pending (incoming or outgoing). If either check fails, B replies
   `pair-refused {reason}` and closes, and A shows the reason. If A's id (from
   `conn.remoteId()`) is already in B's `peers.json`, B replies `pair-ok`
   right away, with no code, because B already trusts that key. A then saves
   B and goes to step 7.
4. B generates a code and shows: "Pairing request from <A short id>. Code:
   XXXX-XXXX. Expires in 2 min." B replies `pair-code-shown`.
5. A shows a code input, together with A's own short id so you can match it
   against B's screen. You type the code, and A sends `pair-code {code}`.
6. B checks the code. If it is right and has not expired, B saves A in
   `peers.json`, replies `pair-ok`, and closes. A then saves B.
7. Both screens ask "Name for <short id>:". You type a name on each side. Each
   side names the other locally, and the names are never exchanged. Pressing
   Esc keeps the short id as the name. Names are trimmed, limited to 32
   printable characters, and have control characters stripped.

**Code.**

- 8 characters from the Crockford base32 alphabet
  (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), drawn with `crypto.getRandomValues`.
  That gives 40 bits.
- Shown as `XXXX-XXXX`.
- Input ignores case, dashes and spaces, and reads O as 0 and I or L as 1.

**Expiry.** The code lasts 2 minutes. After that, B discards it, replies
`pair-fail {reason: "expired"}`, and closes. Esc on either side closes the
stream, and the other side shows "pairing cancelled".

**Wrong code.** Each code gets one attempt. On a wrong code, B discards the
code, replies `pair-fail {reason: "wrong-code"}`, and closes. Both screens say
so. To retry, start again from A, and B shows a new code. Each 40-bit code
allows one guess and is shown on B's screen, so guessing is not a practical
attack.

**Why this order is safe.**

- A dialed B's id, and QUIC proves the other end holds B's key. So A has
  authenticated B.
- B trusts the key from `conn.remoteId()` only after the code shows that
  whoever drives that connection can see B's screen.
- Requiring B's dialog to be open, the busy rule, and the short ids shown on
  both screens keep a stranger who dials at the same moment from slipping in.

**Lost final reply.** If A never receives `pair-ok`, B trusts A but A does not
trust B. Pairing again fixes it. B already trusts A's id, so step 3 replies
`pair-ok` without a code.

### Reconnection

- Each `ib watch` that owns the endpoint and has at least one peer binds at
  boot with the same key. Discovery republishes its current relay and
  addresses.
- The trusted ALPN, `itsybitsy/peer/1`, accepts only ids listed in
  `peers.json`, re-read on every accept. Any other id is closed before
  anything is read.
- The accept loop catches errors per connection. One bad handshake must not
  stop it.
- Every 5 s, `ib watch` dials each peer by id. It keeps a live connection open
  between polls, and iroh handles network changes and sleep/wake. A failed
  dial is retried on the next tick.
- A peer never has two dials in flight at once. A dial can take up to 30 s to
  fail, so ticks that come in while a dial is pending are skipped.
- Each peer's state is kept in memory: connected, or last seen N ago plus the
  last error. The state shows in that peer's tree section header and in the
  Peers dialog. Nothing is written to disk.
- You only need to pair again if one side loses `secret.key` (which gives it a
  new id) or runs `ib peer remove`.
- Removal is one-sided. After it, the other side's polls fail with "not a
  peer".

### First connected feature: remote repos and agents in the tree

**Protocol.**

- On the trusted ALPN, the dialer sends `{"op":"agents"}`.
- The responder answers from `watcher.lastDetectedAgents`: the watcher's
  latest list *after* state detection, which is the list `onUpdate`
  receives. The answer costs no extra IO.
  It must not use `watcher.lastAgents`, which is assigned before detection and
  says "unknown" while detection runs.
- For each agent, the answer carries `{id, nickname, repoName, repoPath,
  state, agentType, manager}`, plus the repo's registry name (added
  2026-11-17), capped at 1 MB in total. Fully qualified row ids
  (`machine/repo/agent`) use the registry name, so renaming a repo's nickname
  never changes an agent's id. `manager` lets the
  receiving side nest agents the way it nests local ones.
- The answer never includes prompts, logs, or tmux output.

**Tree.** The local tree stays exactly as it is now. Below it, each paired
install gets its own section:

```
◆ Laptop B · connected            ← peer-header (name, connection state)
  itsybitsy                       ← remote repo header
    ├ worker-abc   running
    └ manager-def  waiting
  other-repo
    └ agent-123    complete
```

- The section uses new `FlatEntry` kinds: `peer-header`, `remote-repo-header`
  and `remote-agent`. They are new kinds rather than flags on the existing
  ones, so the type checker forces every `switch` over the tree to handle
  them. That way, no code path that expects a local agent can be handed a
  remote one by accident.
- Remote rows are selectable, so the cursor and scrolling work. When a remote
  agent is selected, the center pane shows a placeholder: "Remote agent on
  <peer> (read-only)". The info panel shows the fields above.
- Any action key on a remote row is refused with a "read-only remote agent"
  notice. The action keys are retire, merge, send, resume, nuke, new-agent,
  favorite, team, and the rest. The refusal is one guard in the dashboard's
  key dispatch, not a check in each handler.
- When a peer is unreachable, its section shows the last list it received,
  dimmed, with "last seen N ago". A peer that has never answered shows only
  its header.

**CLI (v1).**

- `ib peer id` prints this install's id.
- `ib peer list` prints paired peers (name and id).
- `ib peer remove <name|id>` removes a peer.
- `checkIbCommandAccess` denies every `ib peer` command to agent sessions.
  Peering is human-only in v1. This also avoids `ib peer id` behaving
  differently depending on whether the agent sandbox, which denies
  `secret.key`, is on.

Pairing happens only in the watch window. There is no `ib peer add`.

## Phases

0. **Spike: done.** All five checks passed. See
   [iroh-spike-findings.md](iroh-spike-findings.md) and `spikes/iroh/`.
1. **Identity and peer store:**
   - the root `@number0/iroh` dependency and the `src/peers/iroh.ts` wrapper;
   - `src/peers/identity.ts`, including the `node:crypto` id derivation;
   - the endpoint lock and the `peers.json` store;
   - `ib peer id|list|remove`, the `_all.md` deny line, and the hook gate.

   Write unit tests. Rebuild the real `ib` and measure its `--version` CPU
   time before and after, because the spike measured only a tiny entry.
2. **Pairing:**
   - code helpers: generate, normalize, constant-time compare, expiry;
   - the pair protocol over a transport seam;
   - the Peers dialog on `I`, including name entry;
   - binding the endpoint in `ib watch` when the dialog opens. This takes the
     endpoint lock and calls `ep.close()` on exit. Phase 2 is the first phase
     to bind the endpoint. Binding at boot when peers exist comes in Phase 3,
     together with the trusted ALPN.

   Tests drive the protocol through the seam and the dialog through the
   existing dashboard test helpers. Real-endpoint tests use `presetMinimal`,
   `RelayMode.disabled()` and `bindAddr("127.0.0.1:0")`, and dial
   `ep.addr().directAddresses()`. They need no network, and a round trip
   takes a few milliseconds.
3. **Trusted link:** the trusted ALPN, the allowlisted accept loop, the
   `agents` op, the 5 s poller, and in-memory peer state.
4. **Tree:** the peer sections in the sidebar, the read-only guard, the
   center-pane placeholder, and the info panel.
5. **Two-laptop check:** you test it by hand on two laptops. I can't reach a
   second machine.

## Cross-cutting checklist

- **Agent functionality:** not affected. No changes to `meta.json` or the
  agent lifecycle.
- **Hooks:** one `_all.md` deny entry for `secret.key`, and a gate in
  `checkIbCommandAccess` that denies every `ib peer` command to agent
  sessions.
- **Watchdog:** not affected. Remote agents are never watched locally.
- **`ib watch`:** the most affected area:
  - the Peers dialog on `I`, plus its help entry;
  - a background endpoint next to Telegram, logging to `watch.log`;
  - the new `FlatEntry` kinds and peer sections in the tree;
  - the read-only guard in the key dispatch;
  - the remote-agent placeholder in the center pane.

## Out of scope for v1

Future direction: one repo list across machines, with each agent assigned to a
machine. See [unified-multi-machine-repos.md](unified-multi-machine-repos.md).

- Any action on remote agents: send, retire, merge, resume, and so on.
- Viewing a remote agent's tmux.
- Live updates for a selected remote agent. This is planned for later; v1
  only polls every 5 s.
- The remote install's system coordinator.
- Remote rows in the Favorites and Teams tabs, or under the V filter.
- Collapsing peer sections.
- Renaming peers (remove and pair again instead).
- A self-hosted relay. This is planned for later; see Research findings.
- Key rotation.
- Handing the endpoint to another `ib watch` while the owner is still
  running.
- Intel Macs.
- Migration code for existing `_all.md` files.

## Decisions (Adam, 2026-11-15)

1. B accepts pairing only while its Peers dialog is open.
2. A code expires after 2 minutes and gets one attempt.
3. You type a name for each peer while pairing.
4. The first feature is the other install's repos and agents in a new tree
   section, one section per install.
5. Peering works only while `ib watch` runs.
6. Use n0's public relays and DNS for now. Our own relays come later.
7. Both laptops are Apple Silicon.
8. Adam adds the `secret.key` deny line to his installed `_all.md` by hand.
9. A selected remote agent shows the center-pane placeholder and its info
   panel fields. Nothing more.
10. Peers are polled every 5 s for now. Later, a selected remote agent
    should get live updates, but that is out of scope for v1.

## Open questions

None yet. Phase 0 may raise some.

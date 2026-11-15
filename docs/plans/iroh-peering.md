# iroh peering plan

## Goal

Two itsybitsy installs on two laptops connect over [iroh](https://www.iroh.computer)
(peer-to-peer QUIC, where each identity is an ed25519 public key). Each install
has its own key pair. You enter install B's public key on install A's watch
window. B then shows an 8-character code, and you type that code into A. From
then on, each install trusts the other, finds it by key, and the first thing
they share is their agent lists (read-only).

## Research findings

**iroh from Bun.** n0 publishes official Node bindings, `@number0/iroh`
(napi-rs, built from `n0-computer/iroh-ffi`). Version 1.2.0 came out in Oct 2026.
This plan needs:

- `SecretKey.generate()`, `.toBytes()`, `.fromBytes()`, `.public()`
- `Endpoint.bind({ secretKey, alpns })`, `ep.id()`, `ep.acceptNext()`, `ep.close()`
- `ep.connect(new EndpointAddr(id), alpn)`: dial using only the id
- `conn.remoteId()`: the peer's authenticated id
- `conn.openBi()` / `acceptBi()`, `writeAll`, `read(limit)`, `finish`
- `EndpointId.fromString()`, `.toString()` (base32), `.fmtShort()`

Caveats:

- The package targets Node ≥ 20.3 and does not mention Bun.
- Its only macOS build is arm64. There is no Intel build.
- Bun embeds `.node` addons in `bun build --compile` output only when the file
  is `require`d directly. The napi-rs loader picks the binary at runtime, so
  we may need to require `@number0/iroh-darwin-arm64/*.node` ourselves.
- None of this has been tried yet. Phase 0 checks it.

**Connecting by key alone.** `Endpoint.bind()` applies the n0 preset, which
turns on n0's public relays and discovery. Discovery publishes signed pkarr
records to n0's DNS server and looks peers up through `dns.iroh.link`. With
only an id, iroh finds the peer's relay or direct address and hole-punches to
it. Traffic is end-to-end encrypted. The relays and DNS can see ids and IP
addresses, but not content.

**How it fits itsybitsy.**

- `ib` is a single Bun binary. Every hook and statusline call starts it, so
  start time matters (see AGENTS.md, `--bytecode`).
- The only long-running user process is `ib watch`. Telegram already runs
  there: `src/channels/boot.ts`, booted from `src/tui/dashboard.ts` around
  L3800. It starts in the background after the TUI mounts, never blocks it,
  and logs to `watch.log`.
- Agents can read all of `~/.itsybitsy` (the read floor in
  `docs/agent-types/_all.md`). Only `sealed/` is denied, so a secret key there
  needs its own deny entry.
- `ensureAgentTypesDir()` writes templates only on first run.

## Design

### Integration

`src/peers/` loads `@number0/iroh` with a dynamic `import()`, the same way
`ib watch` loads Telegram. Only `ib watch` and `ib peer ...` load the addon.
Hooks never do, so `ib`'s start time does not change.

If Phase 0 fails, the fallback is a small Rust sidecar binary that `ib watch`
spawns, talking JSON over stdio. That fallback would come back to you for
approval first.

### Process model

- The endpoint lives in `ib watch`, so peering only works while `ib watch` is
  running.
- `ib watch` binds the endpoint in two cases: at boot, when `peers.json` lists
  at least one peer, or when you open the Peers dialog.
- An install that never pairs never touches the network.
- Once bound, the endpoint stays up until `ib watch` exits.
- Only one `ib watch` per machine owns the endpoint. Two endpoints with the
  same key would fight: the relay keeps one connection per id, discovery
  records overwrite each other, and requests could reach either process.
- Before binding, `ib watch` creates `~/.itsybitsy/peer/endpoint.lock` with
  `O_CREAT|O_EXCL` and writes its pid.
- If the lock already exists and that pid is alive, this `ib watch` skips
  peering. It logs "peering disabled: ib watch pid N owns the endpoint" to
  `watch.log`, and its Peers dialog says the same.
- A lock whose pid is dead gets taken over. The owner deletes the lock when it
  exits.
- A second `ib watch` tries for the lock only at the two bind moments above.
  So after the owner exits, opening Peers or restarting moves peering over.
- This matches Telegram today: the first poller wins, and a second `ib watch`
  gets a 409 and turns its routing off.

### Key generation and storage

- `loadOrCreateIdentity()` (in `src/peers/identity.ts`) reads
  `~/.itsybitsy/peer/secret.key`, which holds 32 bytes as hex.
- If the file is missing, it generates a key and writes it with mode 0600 in a
  0700 directory.
- The same key is used on every run, so the install's id never changes.
- Trusted peers are stored in `~/.itsybitsy/peer/peers.json` as
  `[{id, name, pairedAt}]`, written atomically. Entries are keyed by id; the
  name is only a label.
- `~/.itsybitsy/peer/secret.key` is added to `paths.deny` in `_all.md`. That
  one entry blocks it at both the hook layer and the kernel layer, the same
  way `sealed` is blocked.
- Agents cannot write to `~/.itsybitsy/peer/`, because it is not in
  `allowWrite`. So no agent can add a trusted peer.

### Pairing (Adam's flow)

The watch window gets a new **Peers dialog**, opened with `I` (a free key). It
shows this install's id, the paired peers with their last contact time, and an
input labeled "Pair with id".

Pairing uses its own ALPN, `itsybitsy/pair/1`, and runs over one bi stream.
Messages are newline-delimited JSON, each at most 4 KB.

1. On B, you open Peers to read B's id. Keep B's dialog open.
2. On A, you enter B's id. A checks it with `EndpointId.fromString`, dials B,
   and sends `pair-hello {name: <A's hostname>}`.
3. B accepts the request only if all of these hold:
   - its Peers dialog is open;
   - no other pairing is pending;
   - A's id (from `conn.remoteId()`) is not already paired.

   If one fails, B replies `pair-refused {reason}` and closes. A shows the
   reason.
4. B generates the code and shows: "Pairing request from <A name>
   (<A short id>). Code: XXXX-XXXX. Expires in 2 min." It replies
   `pair-code-shown {name: <B's hostname>}`.
5. A shows a code input, along with A's own short id so you can match it
   against B's screen. You type the code, and A sends `pair-code {code}`.
6. B checks the code:
   - **Right code, not expired:** B saves A in `peers.json`, replies
     `pair-ok`, and closes. A then saves B. Both show "Paired with <name>".

**Code.** Eight characters from Crockford base32
(`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), drawn with `crypto.getRandomValues`.
That is 40 bits. It is shown as `XXXX-XXXX`. Input ignores case, dashes, and
spaces, and reads O as 0 and I or L as 1.

**Expiry.** A code lasts 2 minutes. When it expires, B throws the code away
and replies `pair-fail {reason: "expired"}` (the same message as a wrong code,
see below). Both screens then say so. Pressing Esc on either side closes the
stream, and the other side shows "pairing cancelled".

**Wrong code.** Each code gets exactly one attempt:

1. B throws the code away, replies `pair-fail {reason: "wrong-code"}`, and
   closes.
2. Both screens say so.
3. To retry, start again from A. B then shows a new code.

A guesser gets one try per 40-bit code, and every code appears on B's screen,
so guessing is not practical.

**Why this order is safe.**

- A dialed B's id, and QUIC proves that B holds B's key, so A has
  authenticated B.
- The code proves that whoever holds the A side of the connection can see B's
  screen. So B trusts the key from `conn.remoteId()` only after the person
  standing at both machines confirms it.
- The busy rule and the displayed short ids stop a stranger who dials at the
  same moment from slipping in.

**Lost final reply.** If A never receives `pair-ok`, B trusts A but A does
not trust B. Pairing again fixes it: B accepts a re-pair from an id it already
trusts and just replies `pair-ok`. This is the only exception to the "already
paired" refusal in step 3.

### Reconnection

- Each `ib watch` that has at least one peer binds at boot with the same key.
  Discovery then republishes its current relay and addresses.
- The trusted ALPN `itsybitsy/peer/1` accepts only ids listed in
  `peers.json`, re-read on every accept. Any other id is closed before
  anything is read.
- Every 15 s, `ib watch` dials each peer by id. It keeps a live connection
  open; iroh handles network changes and sleep/wake.
- If a dial fails, it retries on the next tick. The last error goes to
  `~/.itsybitsy/peer/status.json`.
- You only need to pair again if a side loses `secret.key` (which gives it a
  new id) or runs `ib peer remove`.
- Removal is one-sided. The other install's polls then start failing with
  "not a peer".

### First connected feature: remote agent list (read-only)

- On the trusted ALPN, the dialer sends `{"op":"agents"}`.
- The responder answers from its watcher's latest snapshot
  (`watcher.lastAgents`), so the reply costs no extra IO. The answer is a list
  of `{id, nickname, repo: basename, state, agentType}`, capped at 1 MB. It
  never includes prompts, paths, or logs.
- The 15 s poll writes the results to `status.json`.
- `ib peer list` prints each peer, how old its data is, and its agents.

CLI commands in v1:

- `ib peer id`
- `ib peer list`
- `ib peer remove <name|id>`

Pairing happens only in the watch window. There is no `ib peer add`.
`checkIbCommandAccess` denies `ib peer remove` to agent sessions.

## Phases

0. **Spike (gate).** In a scratch project:
   - Run two Bun endpoints that dial each other by id alone and exchange a
     message.
   - Build with the exact `bun build --compile` flags from AGENTS.md, run the
     binary from another directory, and confirm the addon is embedded.
   - Measure the change in binary size and in `ib --version` CPU time.
   - Check whether a relay-disabled loopback on `127.0.0.1` works. If it does,
     later tests can skip the network.

   I report back before Phase 1.
1. `src/peers/identity.ts`, the `peers.json` store, `ib peer id|list|remove`,
   the `_all.md` deny line, and the hook gate, with unit tests.
2. Pairing: the code helpers (generate, normalize, constant-time compare,
   expiry), the pair protocol over a transport seam, and the Peers dialog with
   the `I` key. Tests drive the protocol through the seam and the dialog
   through existing dashboard test helpers.
3. The trusted ALPN, the allowlisted accept loop, the `agents` op, the poller,
   `status.json`, and remote agents in `ib peer list`.
4. You test it by hand on two laptops. I cannot reach a second machine.

## Cross-cutting checklist

- **Agent functionality:** not affected. No change to `meta.json` or the
  agent lifecycle.
- **Hooks:** one `_all.md` deny entry for `secret.key`, plus a gate on
  `ib peer remove` in `checkIbCommandAccess`.
- **Watchdog:** not affected.
- **`ib watch`:** a new Peers dialog on `I` (it also needs a help entry), a
  background endpoint next to Telegram, and logs in `watch.log`. A "Peers"
  header light is a likely follow-up.

## Out of scope for v1

Messages to remote agents or the remote coordinator; any remote mutation;
remote agent lists in the dashboard; a self-hosted relay; key rotation; handing
the endpoint to another `ib watch` while the owner is still running; Intel Macs; migration code for existing
`_all.md` files; renaming peers.

## Open questions

1. **Pairing window.** I recommend that B accept pairing only while its Peers
   dialog is open. You open it there anyway to read B's id. This keeps
   unpaired installs off the network, and a stranger who knows B's id can't
   pop up dialogs on it. Your flow as written would accept pairing at any
   time. OK to require the open dialog?
2. **Code rules.** Is a 2-minute expiry with one attempt per code OK?
3. **Names.** Each side labels the other with that machine's hostname. OK, or
   do you want to type a name while pairing?
4. **First feature.** I recommend the read-only agent list: it has no side
   effects and proves the link works. The alternative is messages delivered to
   the remote system coordinator, the way Telegram inbound works. Which do you
   want first?
5. **Lifetime.** Is it acceptable that peering only works while `ib watch`
   runs, or do you want a separate daemon?
6. **n0 infrastructure.** n0's public relays and DNS see ids and IP
   addresses, but not content. Is that acceptable?
7. **Hardware.** Are both laptops Apple Silicon? There is no Intel build.
8. **Existing installs.** Will you add the `secret.key` deny line to your
   installed `~/.itsybitsy/agent-types/_all.md` by hand, with no migration
   code?

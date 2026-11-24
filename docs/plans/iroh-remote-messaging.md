# iroh peering: messages and file attachments across machines

Status: APPROVED on 2026-11-23, with Adam's answers recorded under "Decisions (Adam, 2026-11-23)" below. M1 and M2 are merged on the phase branch. M3a is built: local CLI snapshots, sender access checks and live attachment limits in Config. M3b is built on this branch. M4 (two-machine acceptance) remains pending. This plan supersedes feature B of [iroh-remote-coordinator-and-send.md](iroh-remote-coordinator-and-send.md); the decisions recorded there still apply. It follows [iroh-unified-repos.md](iroh-unified-repos.md).

## Goal (Adam, 2026-11-22 and 2026-11-23)

A human or an agent on machine A can send a message, with file attachments, to an agent on machine B. B can reply the same way. Adam's flow:

> to be sent → copied to the target machine's tmp folder → path rewritten to that new location → message sent to agent.

> That way agents can send files back and forth as needed.

## Decisions already made

These came from Adam through @system.

- **Remote `ib send` mirrors local `ib send` exactly.**
  - A text-only user send supports leading `/` and `!` passthrough. A message with staged attachments sets `noPassthrough`.
  - An agent send arrives as `[sent by agent <machine>/<repo>/<id>]`.
  - The receiver trusts the sender's user-or-agent label.
- **Acknowledge on queue.** The receiver validates the message, queues it, and acknowledges. The sender returns on that acknowledgement and never waits for delivery. A validation error comes back in the acknowledgement.
- **Remote sends need `ib watch` running on both machines.**
- **Any paired machine may send.** Gating through the agent-type `.md` files comes later. No code is written for that gating now.
- **Queue keying is unchanged.** Keyed agents use `machine/repo/agent`. Keyless (legacy) agents use the flat `agents/<id>/` folder (option C).

## What exists today

- **Dashboard staging (`src/message-attachments.ts`, SPEC §4.1.2).** When Send is pressed, the dashboard scans the final text for absolute and dot-relative file references, skipping backtick code. It copies each regular file into `/tmp/itsybitsy-attachments-XXXX/<n>/<name>`, rewrites the reference, and marks the message `noPassthrough`.
  - Live project references are left literal.
  - Snapshots are never deleted by `ib`.
  - CLI and agent sends stage only explicit `--attach` files.
- **Telegram.** Inbound files are downloaded to `~/.itsybitsy/channels/telegram/inbound/<chat>/<ms>-<name>`. @system sees that local path in the message.
- **Sandboxed agents.** Their `ib send` goes through the watchdog send broker (SPEC-SANDBOX §4C.9). A broker request cannot name a file.
- **iroh streams.** They support `read(limit)` and `readExact(n)` on receive, and `write` / `writeAll` / `finish` on send. That makes chunked streaming possible on one bi stream.

## Design

### 1. How attachments are chosen: explicit and deterministic

- **CLI and agents.** Use `ib send <target> --attach <file>`, repeatable.
  - Only files named with `--attach` are ever transferred.
  - The message text is never scanned for the CLI.
  - `--attach` also works for LOCAL targets. It does the same copy and rewrite into a local `/tmp` snapshot, so local and remote behave identically.
- **Dashboard.** The input box on a remote agent row keeps today's §4.1.2 detection on the final text, such as a drag-and-drop path. The detected files become the explicit attachment list.
  - Relative and live project references stay literal and are not transferred. On B they mean B's own worktree.
- **Telegram.** @system forwards a downloaded file with `--attach ~/.itsybitsy/channels/telegram/inbound/...`.
- **Heredoc, `-f` and stdin.** These supply the message body only. Attachments come only from `--attach`.

### 2. Path rewriting: only transferred paths

The receiver rewrites the message after every file has been verified.

Each file carries its original `--attach` arguments and its canonical absolute path. A spelling belongs to one file. The receiver replaces literal spellings and their unquoted, single-quoted, or double-quoted `spellPath` forms when whitespace or a text edge bounds both ends. It formats the destination with the same quoting style. This rule applies to the whole message, including code samples.

For any message with attachments, the receiver appends a blank line and a mapping in transfer order, even when every file appeared in the text:

```
Attachments copied to this machine:
- ./image.png → /tmp/itsybitsy-attachments-example/0/image.png
```

### 3. Wire protocol

There is no new ALPN. A new op `send` runs on the trusted ALPN `itsybitsy/peer/1`, one bi stream per message.

**Request framing.** The four-byte big-endian prefix `00 00 01 57` gives the length of this 343-byte UTF-8 JSON header, excluding the displayed line break.

```json
{"op":"send","id":"6ed350b1-b70e-4b50-bfb5-56a4a93752b8","from":{"kind":"user"},"target":{"kind":"agent","repo":"photos","agent":"worker-1"},"message":"Read ./greeting.txt","files":[{"name":"greeting.txt","size":5,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824","spellings":["./greeting.txt","/src/greeting.txt"]}]}
```

The next five bytes are `68 65 6c 6c 6f` (ASCII `hello`). The sender then issues a single FIN. For multiple files, their raw bodies follow in manifest order and the FIN follows the last body. For zero files, the FIN immediately follows the header.

The sending system coordinator uses `{"kind":"system"}` with no id. The receiver derives its `<peer>/@system` attribution from the authenticated pairing. An agent sender uses `{"kind":"agent","id":"desk/photos/worker-1"}` in `from`. An agent target can omit `repo` to use the receiver’s normal resolver. The other target forms are `{"kind":"system"}` for the system coordinator and `{"kind":"repo-coordinator","repo":"photos"}` for a repo coordinator.

**Reply:** `{"ok":true,"id":"<uuid>"}` or `{"op":"error","reason":"<message>"}`.

**Limits:**

| Limit | Value |
|---|---|
| Header | at most 256 KB |
| Per file | at most 25 MB |
| Per message (all files) | at most 100 MB |
| Files per message | at most 20 |

The receiver checks these limits against the header BEFORE it reads any file bytes, and enforces them again while reading. Bytes beyond the declared size are an error.

**Streaming and integrity:**

- The receiver streams each file in chunks of 64 KB and computes its SHA-256 while it writes to disk.
- A size or hash mismatch rejects the WHOLE message.
- There is no compression and no archive handling. Nothing is ever unpacked.

**Timeouts and cancellation:**

- Either side gives up after 20 s with no progress.
- The sender's overall deadline scales with the size: 30 s plus 1 s per MB.
- Cancelling closes the stream: Ctrl-C in the CLI, or Esc in the dashboard while sending. The receiver then deletes the partial directory.

**Progress:**

- Over 5 MB, the CLI prints `sending N files (X MB) to <machine>…` and a final result line.
- The dashboard shows a "sending…" notice, then the result.

**Concurrency:**

- At most one inbound transfer per peer.
- At most two inbound transfers in total.
- Anything beyond that gets `busy, try again`.

### 4. Receiving (machine B)

1. The allowlist is checked when the stream is accepted, as for every request.
2. The header is validated: limits, file names and target. The target resolves in B's registry with the normal resolver, and must be a live agent.
3. B creates `mkdtemp("/tmp/itsybitsy-attachments-")` (mode 0700) and one subdirectory `<n>/` per file (0700). This matches the local convention.
4. Each file is written with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600. It is never made executable.
5. File names are sanitized:
   - Take the basename only.
   - Strip `\p{Cc}` and `\p{Cf}`.
   - Replace `/`, `\` and NUL.
   - Reject an empty name, `.` and `..`.
   - Cut the name to 200 bytes, keeping the extension.
   - Fall back to `attachment` if nothing usable is left.

   Each file has its own `<n>/` subdirectory, so names cannot collide.
6. Sizes and hashes are verified, then the allowlist is checked again.
7. The message is rewritten (§2).
8. The message is queued through the normal `sendMessage` path into the recipient's own queue (`agentOutboxDir`, keyed or flat), with sender attribution. `noPassthrough` is set when files were staged, exactly as local §4.1.2 does.
9. B writes a `watch.log` line, shows the notice `<peer> sent a message (N files) to <agent>`, and replies ok.

**No partial delivery.** Any failure before step 8 deletes the whole directory, queues nothing, and returns the error.

**Idempotency.** B keeps the ids it accepted in memory for 10 minutes. A repeat of the same id replies ok and does not queue again. The sender never retries automatically. If the stream ends after B may have accepted, the sender reports "outcome unknown — check the agent".

**Retention.** Accepted files follow local §4.1.2: they stay in `/tmp` until the operating system cleans it, and are never deleted on delivery.

**Receiver read access.**

- The files belong to the same user.
- Sandboxed agents already have `/private/tmp` in their read and write floor (SPEC-SANDBOX §4C), and the hook path tables have the same `/tmp` floor.
- So no `paths.allowRead` change is needed. If a future profile narrows `/private/tmp`, it must add `/private/tmp/itsybitsy-attachments-*` to `allowRead`.

### 5. Sending (machine A): who reads the file

The sender must be able to read every attached file. The file is copied out BEFORE `ib watch` sends anything, so `ib watch` never reads a path on someone else's behalf.

- **Direct CLI handoff for humans, the system coordinator and verified unsandboxed shared-checkout repo coordinators.**
  - The CLI resolves each `--attach` path and requires a regular file. It also requires the file to be within the limits.
  - For an agent caller, the CLI checks each canonical path against that agent's access table with the same `resolvePreparedAccess` read check that the hooks use. This also enforces `paths.deny`, which closes the relative-path hook-scanner gap from `hook-gaps-from-iroh-review.md` for `--attach`.
  - It then copies each file, with its hash, into a request directory `~/.itsybitsy/peer-outbox/<uuid>/` (mode 0700). The request directory contains `request.json` and `files/<n>`.
  - The running `ib watch` polls that directory every 250 ms. Directory watches do not fire on macOS. It claims a request by renaming it, sends it, and writes `result.json`.
  - The CLI waits for the acknowledgement. It times out after 10 s plus the transfer time.
  - With no `ib watch` owning the endpoint, it fails with "remote sends need ib watch running on this machine".
- **Every worktree agent uses its own watchdog (§4C.9 of SPEC-SANDBOX).**
  - The CLI enforces the sender’s read policy. A kernel sandbox also enforces read access when enabled. The CLI copies the files into its own `<agentDir>/send-attachments/<id>/`.
  - The broker request carries its ID, target, original message and wire manifest. The watchdog derives numbered source paths from its own agent directory and the validated request ID.
  - The watchdog takes files only from that directory, then hands the request to `peer-outbox` the same way.
- **Always refused, for every sender:** anything under `~/.itsybitsy/peer/` (the secret key and trusted peers) or `~/.itsybitsy/sealed/`.

### 6. Who can send what

- Agent senders follow the same `ib send` rules as local sends.
- The resolver is 6b's resolver: the `machine/agent` and `machine/repo/agent` forms, same-repo-first, and ambiguity fails.
- A user send through `ib watch` counts as the user.
- On the receiving machine, B's normal queue and watchdog rules apply.

### 7. UI

- **Dashboard input on a remote agent row.** It is enabled for user sends, and drag-and-drop attachments work as they do locally. The remote row guard still refuses every other action.
- **Notices.** A notice appears on both machines, and a line is written to `watch.log` on both.
- **Peers tab.** Unchanged. It keeps the per-peer status and the last error line.
- **Remote coordinator view.** Unchanged and read-only, unless Adam answers open question 3 with yes.

## Security review

- **Path traversal.** Names are reduced to a sanitized basename inside per-file `<n>/` directories created by `mkdtemp`. Nothing from the wire becomes a directory path.
- **Symlinks.**
  - The sender uses `realpath` and requires a regular file, and copies it before handoff.
  - The receiver creates fresh directories and opens files with `O_NOFOLLOW|O_EXCL`.
- **Zip bombs.** Nothing is ever decompressed or unpacked.
- **Huge files and denial of service.**
  - Caps are checked against the header before any bytes are read, and enforced again while reading.
  - Only 1 inbound transfer per peer and 2 in total.
  - A 20 s no-progress timeout.
  - Partial transfers are deleted.
- **Untrusted filenames.** They are sanitized, and shown only after control and format characters are stripped. They are never executed: files are written 0600, never chmod +x, and never run.
- **Secrets.** `~/.itsybitsy/peer/` and `sealed/` are always refused, and agent senders are held to their own read access (§5).
- **Spoofed sender label.** Accepted: the receiver trusts the paired machine's classification, the same trust it gives local classification. User passthrough is disabled for staged messages.
- **Hook gaps.** The scanner gap for relative paths (`hook-gaps-from-iroh-review.md`) does not apply to `--attach`, because the CLI checks the canonical path itself. The other gaps listed there are unchanged and out of scope.

## Phases

Every phase uses Codex workers and gets a two-reviewer cycle. My own full `bun test` and `tsc` run follows each one. Nothing is merged or pushed without Adam's go-ahead.

- **M1. Pure pieces, tests first.**
  - The attachment manifest: path resolution and the regular-file check.
  - Filename sanitizing.
  - The path rewriter, which touches only transferred paths, plus the `Attachments:` line.
  - The frame codec: header, length prefix and chunk reader.
  - The limits.
- **M2. Remote text sends without files.**
  - The `send` op, receiver queueing through `sendMessage` with attribution and passthrough rules, and idempotency.
  - The `peer-outbox` handoff from the CLI to `ib watch`.
  - The sandboxed broker route.
  - The dashboard input on remote agent rows, and notices.
  - The `ib send <machine>/…` CLI path.
- **M3. Attachments.**
  - **M3a built.** Local `ib send --attach`, live limits in Config, canonical sender read checks and the sandboxed single-link check on opened files.
  - **M3b built.** Remote `ib send --attach`, verified broker handoff, streamed receipt, dashboard file detection, progress and cancellation.
  - Dashboard staging for remote targets.
  - Streaming transfer and receiving.
  - The access check for agent senders, and the `peer/` and `sealed/` refusal.
  - Cancellation and progress.
- **M4. Docs and the Phase 8 checklist.** Add these two-laptop steps: a text send in both directions, a file send in both directions, a size-limit refusal, and an offline peer.

## Decisions (Adam, 2026-11-23). These supersede the values above.

1. **Limits.**
   - **Per file:** 1 GB.
   - **Per message:** 2 GB total and at most 20 files. These are my values, since Adam set only the per-file limit.
   - **Header:** 256 KB.
   - **CONFIGURABLE (Adam, 2026-11-23).** All three limits are persisted settings in the user config JSON. You edit them in `ib watch` under `h`, on the Config tab:

     | Key | Default | Allowed range |
     |---|---|---|
     | `peering.attachments.maxFileMB` | 1024 | integer, 0–65536 |
     | `peering.attachments.maxMessageMB` | 2048 | integer, 0–131072. Must be at least `maxFileMB` when both values are positive. |
     | `peering.attachments.maxFiles` | 20 | integer, 0–100 |

     - **Zero disables attachments (Adam, 2026-11-23).** If any of the three limits is 0, every attachment is rejected, including empty 0-byte files. A message with no attachments still goes through.
       - The check is "limit is 0 → reject", made before any size comparison.
       - The config UI says "0 = attachments disabled".
       - The error names the limit, its value and the machine, for example: "attachments are disabled on laptop (peering.attachments.maxFileMB = 0)".

     - **Units.** MB means MiB.
     - **Bad values.** The config UI refuses an invalid value with a message. A bad value already in the file falls back to its default and logs a warning that names the key.
     - **Sender.** It checks its own limits before reading or transferring anything.
     - **Receiver.** It enforces ITS OWN limits, read live for each request, so a peer cannot override them.
     - **Size rejection.** A rejection names the limit that was exceeded, its value and the machine that set it. For example: "laptop refused big.iso (1.4 GB): its limit is 1 GB per file (peering.attachments.maxFileMB)".
   - **Fixed constants.** The chunk size, header cap, idle timeout and disk margin stay as named constants in `src/peers/transfer-limits.ts`. They are implementation details, not policy.
   - **Requirements at these sizes:**
     - Streaming must keep memory bounded. Data moves in 64 KB chunks, the hash is computed as data arrives, and nothing is buffered whole.
     - The receiver checks free disk space before it accepts a message. It uses `statfs` on `/tmp` and requires the total size plus a 1 GB margin.
     - Progress shows on both sides, and cancel works on both sides.
   - **Timeouts.** They are generous: there is no overall deadline, and a transfer fails only after 60 s with no progress in either direction. That allows for a 1 GB file over a slow relay.
   - **Sender handoff.** The CLI checks the named regular file against the verified open handle and forces a descriptor-based copy-on-write clone. APFS shares storage with the source. Filesystems without clone support use a cancellable copy from the same handle in 64 KiB chunks. The CLI verifies the identity, exact length and SHA-256 of the private snapshot. The watchdog applies the same snapshot checks to each securely opened broker input.
2. **`--attach`.** Yes: `ib send <target> --attach <file>`, repeatable. It also works for local sends, with the same copy and rewrite.
3. **The other machine's coordinators.** Yes. Remote sends may reach the other machine's `@system` and its repo coordinators:
   - the CLI forms `<machine>/@system` and `<machine>/@<repo>`;
   - typing into the remote coordinator row. Its input box is enabled for user sends, and every other action on that row is still refused.
   The other machine's normal `@system` and repo-coordinator send rules apply.
4. **Retention.** Yes. Received files stay in `/tmp`, `ib` never deletes them, and the operating system cleans them up later.

## Open questions for Adam (answered above)

1. **Limits.** 25 MB per file, 100 MB per message, 20 files. Recommended: yes.
2. **How agents attach.** Use an explicit `ib send <target> --attach <file>`, repeatable, and keep drag-and-drop detection in the dashboard. `--attach` also works for local sends, with the same copy and rewrite. Recommended: yes.
3. **Sending to the other machine's @system.** This covers `ib send <machine>/@system` and typing into the remote coordinator row. Recommended: yes, with the same rules as a local @system send.
4. **Retention.** Received files stay in `/tmp` like local attachments, cleaned by the operating system, and `ib` never deletes them. Recommended: yes.

## Behaviour changes beyond M3b

- **Sender identity.** Local sends, team history, team creation, questions, logs and child spawns identify the calling agent from its worktree or recorded process. An identified agent can omit the identity flags or name itself. A human sending from a sibling tmux window in the agent’s checkout is credited as the user. A registered repo coordinator with a dotted ID can record its launcher PID. Rehire running agy agents after upgrading so sends from a shared checkout or scratch directory retain their identity when `ps` is denied.
- A second send to `@system` arriving during a long delivery is drained by the current inline sender, even after the second sender finishes waiting for the lock.
- A live drainer retains its delivery lock across long messages. Reclaiming an old lock requires evidence that its owner exited or its PID was reused.
- A sandboxed worker can send text or attachments to a unique bare agent ID in another local repo through its watchdog.

A worktree CLI under the kernel sandbox sends local `--attach` requests through its own watchdog. The CLI verifies its sources and creates a protected lease. The watchdog verifies a private copy of the numbered bodies, publishes it by rename from protected staging, and enqueues the rewritten message as the originating agent with `noPassthrough`. A self-send goes into the requester's own queue for its regular watchdog drain. Local text sends, unsandboxed and human sends, dashboard sends, and Telegram keep their existing routes.

Delivered attachment directories under `/tmp/itsybitsy-attachments-*` and the corresponding `/private/tmp` paths are read-only to agents. This includes local `--attach`, dashboard snapshots and published receiver snapshots. Agents can read the original and edit a copy elsewhere in their scratch space or project.

An audit of ib source, the agent-type instructions, SPEC and README found no instruction telling agents to write, append or edit files inside a delivered directory. The production creators are local CLI staging in `src/peers/local-attachments.ts`, local dashboard sends in `src/message-attachments.ts`, dashboard attachment prompts in `src/tui/attachment-prompt.ts`, remote publication in `src/peers/receive-message.ts`, and sandboxed local publication by the watchdog in `src/peers/remote-attachments.ts`. SPEC §4.1 and §20 describe the path and staging behavior. README describes editing attachment limits and the message draft. These are configuration and composition actions.

Local sends and remote receipts use the same hardened queue. Its existing JSONL format is unchanged. Before appending, the sender terminates an unterminated last line. A directory flock serializes dedupe and append with the watchdog’s read-and-replace operation. The watchdog releases that lock before typing into tmux. The queue reader and writer refuse symlinks, hard-linked files, FIFOs and other special files.

## M3b follow-ups (non-blocking)

- **Native transport.** If the reply reader is still pending after a timeout or cancellation, teardown closes the shared connection. The iroh-ffi receive mutex stays held until the read settles.
- **Agent-local behavior.** A text-send request supplies its client PID. An agent can also change the progress file its own CLI observes. These affect its own sends and waits.
- **Confinement.** With the outer itsybitsy kernel sandbox off, the hook enforces read-only access to delivered attachments. Child processes can modify them. The pinned Codex native filesystem profile cannot express a write-only deny glob. The hook matches delivered attachment names case-insensitively for default APFS. On a case-sensitive volume it can also deny a differently cased sibling.
- **Broker origin.** The same-repo REPOAGENTS write grant lets a sandboxed manager drop requests into a child's or sibling's broker queue. All normal spawn, lifecycle, ask and send submissions use the caller's own queue, including managers sending to children, teams and @system. Denying writes just to queue leaves would still allow replacement of the tree through a writable ancestor. A proposed fix is to put protected per-agent mailboxes outside the tree managers can write to and authenticate publication there.
- **Crash recovery and replay.** A crash between attachment publication and queue append can leave a retained snapshot in `/tmp`. A legacy empty or damaged endpoint lock requires the manual deletion described in the Peers tab. A crash after tmux delivery but before queue removal can retype one local message. The receiving watcher remembers accepted wire IDs for up to ten minutes, or until restart. A paired peer could submit the same frame after takeover, just as it could submit a new message. All shipped senders create a fresh ID for each submission and never retry an opened stream.
- **Clock changes.** When process start times cannot be read, a calendar change can briefly distort the displayed endpoint heartbeat freshness. The next heartbeat corrects it.
- **Existing issues tracked elsewhere.** The shared broker envelope reader, the flat outbox used for keyless agent IDs, and the window for pairing revocation at queue append.

- **Sandboxed repo coordinators.** A shared-checkout repo coordinator can attach locally through a live watchdog broker. Its normal shared checkout has no `<agentDir>/repo` worktree, and the per-agent watchdog currently exits when that directory is absent. Without a live broker the CLI explains the limitation before staging. Supporting local attachments in that configuration would require keeping the broker available for shared-checkout coordinators.

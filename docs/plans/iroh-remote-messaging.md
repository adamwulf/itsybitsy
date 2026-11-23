# iroh peering: messages and file attachments across machines

Status: APPROVED on 2026-11-23, with Adam's answers recorded under "Decisions (Adam, 2026-11-23)" below. M1–M4 are in progress. This plan supersedes feature B of [iroh-remote-coordinator-and-send.md](iroh-remote-coordinator-and-send.md); the decisions recorded there still apply. It follows [iroh-unified-repos.md](iroh-unified-repos.md).

## Goal (Adam, 2026-11-22 and 2026-11-23)

A human or an agent on machine A can send a message, with file attachments, to an agent on machine B. B can reply the same way. Adam's flow:

> to be sent → copied to the target machine's tmp folder → path rewritten to that new location → message sent to agent.

> That way agents can send files back and forth as needed.

## Decisions already made

These came from Adam through @system.

- **Remote `ib send` mirrors local `ib send` exactly.**
  - A user send follows user rules, including `/` and `!` passthrough.
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
  - Plain CLI and agent `ib send` does NOT stage anything.
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

- **Text references.** Each reference in the message that exactly matches an attached file is replaced with B's path, quoted with `spellPath`. A reference matches when it is the same `--attach` spelling, or the same path after resolving `~` and the cwd, as found by `references()` outside code spans.
- **Unreferenced attachments.** An attached file the text never mentions is appended as `\n\nAttachments: <path> <path>`, so the agent always learns where it is.
- **Nothing else changes.** Other text, other paths and code spans are left untouched. A path that was not transferred is never rewritten.

### 3. Wire protocol

There is no new ALPN. A new op `send` runs on the trusted ALPN `itsybitsy/peer/1`, one bi stream per message.

**Request framing:**

```
u32 big-endian header length
UTF-8 JSON header:
  {"op":"send","id":"<uuid>","from":{"kind":"user"}|{"kind":"agent","id":"<machine>/<repo>/<agent>"},
   "target":{"repo":"<registryName>","agent":"<id or nickname>"}, "message":"<text>",
   "files":[{"name":"<basename>","size":<bytes>,"sha256":"<hex>"}]}
then, for each file in order, exactly `size` raw bytes, then finish()
```

**Reply:** `{"ok":true,"id":"<uuid>"}` or `{"ok":false,"error":"<message>"}`.

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

- **Human or unsandboxed agent: the CLI handoff.**
  - The CLI resolves each `--attach` path and requires a regular file. It also requires the file to be within the limits.
  - For an agent caller, the CLI checks each canonical path against that agent's access table with the same `resolvePreparedAccess` read check that the hooks use. This also enforces `paths.deny`, which closes the relative-path hook-scanner gap from `hook-gaps-from-iroh-review.md` for `--attach`.
  - It then copies each file, with its hash, into a request directory `~/.itsybitsy/peer-outbox/<uuid>/` (mode 0700). The request directory contains `request.json` and `files/<n>`.
  - The running `ib watch` polls that directory every 250 ms. Directory watches do not fire on macOS. It claims a request by renaming it, sends it, and writes `result.json`.
  - The CLI waits for the acknowledgement. It times out after 10 s plus the transfer time.
  - With no `ib watch` owning the endpoint, it fails with "remote sends need ib watch running on this machine".
- **Sandboxed agent: through the watchdog broker.**
  - The CLI runs inside its kernel sandbox, so the kernel enforces read access. It copies the files into its own `<agentDir>/send-attachments/<id>/`.
  - The broker request names only that request id.
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
  - `ib send --attach`, for local and remote targets.
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
   - **Where they live:** all limits are named constants in one module, `src/peers/transfer-limits.ts`.
   - **Requirements at these sizes:**
     - Streaming must keep memory bounded. Data moves in 64 KB chunks, the hash is computed as data arrives, and nothing is buffered whole.
     - The receiver checks free disk space before it accepts a message. It uses `statfs` on `/tmp` and requires the total size plus a 1 GB margin.
     - Progress shows on both sides, and cancel works on both sides.
   - **Timeouts.** They are generous: there is no overall deadline, and a transfer fails only after 60 s with no progress in either direction. That allows for a 1 GB file over a slow relay.
   - **Sender handoff.** It copies with `COPYFILE_FICLONE`. On APFS that makes a clone, which is nearly instant and uses no extra space, so a 1 GB `--attach` does not double disk use. On other filesystems it falls back to a normal copy.
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

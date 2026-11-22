# iroh peering, next phase: one repo list across machines

Phase 6 built 2026-11-20; 6a/6b merged 2026-11-21. Phase 7 in progress (build plan below); Phase 8 is Adam's two-laptop checklist. This phase follows [iroh-peering.md](iroh-peering.md)
Phases 0–4, plus the self-heal and full-id work, all on `agent/iroh-peering`.

It **supersedes** "remote agents shown as tree sections"
(iroh-peering.md → "First connected feature", Tree part). The peer sections
are removed. It realizes part of
[unified-multi-machine-repos.md](unified-multi-machine-repos.md). Cloning a
repo onto a machine that doesn't have it remains out of scope.

## What Adam asked for

1. **One repo list.** A repo that exists on several machines appears once in
   the tree.
2. **All agents together.** Under each repo, show every agent in that repo,
   local and remote.
3. **Italic remote agents.** Agents on another machine are drawn in italic.
4. **Machine picker.** When more than one machine is connected, the New Agent
   dialog lets him pick the machine the agent runs on. It defaults to this
   machine. With only one machine there is no picker.

## Design

### Matching repos across machines

- Repos match by **registry name**, ignoring case. Since 2026-11-17 a registry
  name is unique on each machine, so a name identifies at most one repo per
  machine.
- Paths are never compared, because they normally differ between machines.
- Different registry names produce two entries. To align them, first save any
  notes, nickname, or default agent type you want to keep from the registration
  you plan to remove. On that machine, run `ib remove <path>`, then
  `ib add <path> <name>` with the matching name. Restore the saved settings
  on the new registration, then reload or restart `ib watch` on that machine
  so its dashboard and peers see the new name.
- Adam decided this on 2026-11-20: equal registered names mean the same repo,
  and nothing fancier is used.

### What the trusted link carries

The reply to `agents` becomes `{repos, agents}`:

- `repos`: one `{registryName, displayName}` per repo registered on that
  machine, including repos with no agents.
  - The tree needs it to show a repo that exists only on the other machine.
  - The machine picker needs it to know which machines have the repo.
- `agents`: the existing eight fields, unchanged. They are `id`, `nickname`,
  `repoName`, `repoPath`, `state`, `agentType` and `manager`, plus
  `repoRegistryName`. From these:
  - **status** is `state`;
  - **repo id** is `repoRegistryName`.
- **Machine name** is NOT sent. The receiver already knows who answered: it
  has the authenticated id, and its `peers.json` maps that id to the name
  typed when pairing.
  - A remote agent's full id stays `<peer name>/<repo>/<agent>`.
  - The info panel shows the machine name, plus that peer's connection state.

Both laptops run the same build, so there is no compatibility handling for
the reply change.

### Tree

- **One header per repo.** There is one header per matched registry name,
  covering this machine and every peer whose last list includes the repo.
  - If the repo exists here, the header shows the local display name.
    Otherwise it shows the remote display name.
- **Agent order under a header:**
  - local agents first, in today's order and nesting;
  - then each peer's agents, in `peers.json` order, nested by manager within
    that machine. A manager is always on the same machine as its agents.
- **Remote agent rows:**
  - drawn in italic (SGR 3);
  - also dimmed when their peer is unreachable, showing the last list
    received (as today).
- **Remote-only repos** still get a header. All agents under it are italic.
- The unified tree removes `peer-header`. A `remote-repo-header` now identifies a repo registered only on peers. Peer
  connection state stays visible in two places: the Peers dialog (`I`), and
  the info panel of a selected remote agent ("Machine: <name> · connected" or
  "last seen N ago").
- **Keys:**
  - Agent keys are unchanged (`machine/repo/agent`).
  - A repo header's key becomes machine-independent, derived from the
    registry name. Pins stay keyed by local path.
- **The read-only guard** still applies to every remote agent row. On a repo
  header:
  - Local repo actions (remove, rename, pin, fix, and so on) work only when
    the repo exists on this machine. On a remote-only header they are refused
    with a notice.
  - In Phase 6, `a` on a remote-only header explains that remote starts come in the next phase. Phase 7 enables the machine picker.
- **V filter:** it now applies to remote agent rows too, because they live in
  the main tree (open question 3).
- **Favorites and Teams tabs** stay local-only.

### New Agent dialog: picking a machine

- **When the Machine field appears.** The form shows it only when at least
  one connected peer has this repo.
- **Options:**
  - this machine, if the repo is registered here, which is the default;
  - each connected peer that has the repo.
  - If the repo exists only remotely, the first such peer is the default.
- **Changing machine.** The field cycles like the Type field.
- **Type list.** The list stays this machine's types. The remote machine
  checks the type and returns a clear error if it doesn't have it.
- **Attachments.** Attachment staging runs only for this machine. A remote
  prompt is sent as plain text; local file paths in it won't exist there.
  The form says so when a remote machine is selected.
- **Submitting to a remote machine.** The form sends `new-agent` over the
  trusted link and waits up to 30 s.
  - On success it closes and shows "Created agent <id> on <peer>". The row
    appears on the next poll, within 5 s.
  - On failure it shows the error.

### Remote new-agent request

- **Request.** It uses its own bi stream on `itsybitsy/peer/1`:
  `{"op":"new-agent","repo":"<registryName>","type":"<type>","name":"<optional>","prompt":"<text>"}`.
  - The request cap is raised to 256 KB for this op only. `agents` keeps its
    4 KB cap.
- **Responder checks, in order:**
  1. The allowlist, re-checked as for every request.
  2. The repo name is registered here.
  3. The type exists, is spawnable, and is not `repo-coordinator`. No
     coordinators are started remotely.
  4. The name passes the existing agent-name validation.
  5. The prompt is non-empty and within the cap.
- **Spawning.** The responder then calls the same
  `newAgent(repo.path, prompt, { type, name })` that pressing `a` in its own
  `ib watch` calls.
  - It passes no extra options: no model, effort, spawner or permissions
    override.
  - Hooks, sandbox, agent-type permissions and every spawn gate therefore
    apply exactly as for a local human spawn.
- **Reply:** `{"ok":true,"id":"<id>"}` or `{"ok":false,"error":"<message>"}`.
- **Visibility.** The receiving machine logs each request to `watch.log` and
  shows a notice: "<peer> started agent <id> in <repo>".
- **Permission model:**
  - Only a human, in `ib watch`'s New Agent dialog, can send the request.
  - There is no CLI path: no `ib new-agent --machine`, and `ib peer` stays
    human-only.
  - Agents cannot reach it, and the hook and security gates are unchanged.
  - Any paired peer may make the request, because pairing is the trust
    decision (open question 2).
- **Still refused on remote agents:** send, retire, merge, resume and
  everything else.

### Qualified agent names (Adam, 2026-11-20)

**What was decided before.** On 2026-11-16, fully qualified ids
(`machine/repo/agent`) were decided for the `ib watch` TREE only. CLI
commands were explicitly left on bare ids "for now". SPEC §17.1 recorded
this: "CLI commands (`ib send`, …) and `teams.json` keep bare ids". That
decision now extends to queues and addressing.

**The message queue key (superseded by [SPEC §4.1.1](../../SPEC.md#411-per-agent-outbox-queue-serialized-delivery)).**
A stored `meta.queue_key` stays fixed, including when the repo is registered
later. Agents without a stored key keep using the flat
`~/.itsybitsy/agents/<agent>/` folder, which same-ID legacy agents share
across repos.

Original proposal:
- A queue lives at `~/.itsybitsy/agents/<machine>/<repo>/<agent>/`:
  - `machine` is this machine's name;
  - `repo` is the registered repo name;
  - `agent` is the agent id.
- Agents can be spawned in a repo that is not registered. For such a repo the
  repo segment is `~<repoId>`, the 8-hex id from `<repo>/.itsybitsy/repo-id`.
  `~` is outside the registry-name alphabet, so this segment can never equal
  a registered name. If the repo is registered later, its queue moves to the
  registered name, with no migration.
- This is the same key the tree uses, so same-named agents in different repos
  or on different machines never share a queue.
- There is no migration. Old flat `~/.itsybitsy/agents/<agent>/` dirs are
  ignored.
- This fixes the bug where same-named agents in two repos could receive each
  other's messages.

**Address forms.**
- `agent`
- `machine/agent`
- `machine/repo/agent`
- the existing `@repo/agent` (this machine), `@repo`, `@system`,
  `@coordinator` and `@team`

**Resolving a bare name (or `machine/agent`).** Ids and nicknames match
exactly.
1. If the caller runs inside a repo on this machine and that repo has the
   name, that agent is used. This keeps today's same-repo-first rule, so a
   manager can still reach its own workers by bare name. Adam confirmed this
   on 2026-11-20.
2. Otherwise, collect every match across all local repos and all connected
   machines:
   - one match: use it;
   - several matches: FAIL, naming the exact qualified forms found, adding the
     repo part where it is needed. Examples: "'foo' exists on laptop-a and
     laptop-b; use laptop-a/foo or laptop-b/foo", or
     "laptop-a/app/foo or laptop-a/web/foo";
   - none: not found.

**Where connected machines' agents come from.**
- `ib watch` writes `~/.itsybitsy/peer/remote-agents.json` atomically on
  every poller change. Each entry holds machine, repo, id, nickname, state,
  and when it was last seen.
- CLI processes read that file and ignore peers that are no longer
  connected.
- This replaces the earlier "peer state is memory only" rule. CLI commands
  are separate processes, so they need it on disk. `secret.key` stays denied.

**A target that resolves to a remote agent.**
- `ib send`: "sending to agents on other machines is not supported yet".
- `look`, `status`, `retire` and the like: "remote agents are read-only".
  This holds until those features exist.

**One resolver.**
- Every command that takes an agent uses the same resolver. That covers send,
  look, status, diff, merge, retire, rehire, ack, resume, pause, nuke and the
  rest.
- The hook gates use the same resolver too: the manager-only ownership
  checks and the `@system` rules. The gate and the command therefore always
  agree on which agent is meant, which is the lesson from the hook-gaps work.

## Phases

6. **Unified tree (built):**
   - the `repos` list in the `agents` reply;
   - repo matching and merged headers;
   - italic (and dimmed when stale) remote rows under their repo;
   - removing the peer sections;
   - the info-panel machine line;
   - the guard rules for headers;
   - the V filter for remote rows;
   - docs.

   Tests: matching (same name, different paths; case; remote-only; local-only),
   order and nesting, italic and dim, keys, the header guard, and the V filter.
6a. **Qualified queue key:** the outbox fix, in progress in parallel with
    Phase 6. Tests: the same name in two repos; coordinators whose folders
    share a name; the same name under two machine names.
6b. **One agent resolver, after Phase 6:**
    - the address forms and the ambiguity rule above;
    - `remote-agents.json`, written by the poller;
    - the same resolver in every agent-taking command and in the hook gates.

    6b also covers a bug that a review found on 2026-11-20. The watchdog
    looks up who to notify by bare id:
    - the manager is searched for across ALL repos (`src/watchdog.ts` ~460);
    - the coordinator spawner is searched for by folder basename (~524–529),
      even though `spawned_by.repo_path` already records its repo.

    So it can notify the wrong agent. The fix scopes the manager lookup to the
    agent's own repo and the spawner lookup to the recorded repo path.

    Tests: a unique name; a name ambiguous across two machines; a name
    ambiguous across repos; each qualified form; an unknown name; the gate
    agreeing with the command; and notifications reaching the right manager
    and spawner when same-id agents exist in two repos.
7. **Remote new-agent:**
   - the `new-agent` op and the responder's checks and spawn, with `newAgent`
     injected;
   - the 256 KB request cap for this op;
   - the Machine field in the form, and the remote submit, timeout and
     notices on both sides;
   - docs.

   Tests: every responder refusal; a real-endpoint loopback that starts an
   agent through a stubbed `newAgent`; and the form with zero, one and two
   connected peers.
8. **Two-laptop check:** Adam pairs, sees merged repos with italic remote
   agents, starts an agent on the other laptop from this one, and sees it
   appear.

Each phase gets the usual two-reviewer cycle before it is merged.

### Phase 7 build plan (started 2026-11-21)

Adam's go-ahead came on 2026-11-21, relayed by @system. One Codex worker builds Phase 7 in the order below and commits after each step. Then two Codex reviewers check it, and review rounds continue until a round finds no code issues.

Open question 2 is built as recommended: any paired peer may start agents here, and this machine gets a `watch.log` line and a notice.

1. **Wire.**
   - Add `{"op":"new-agent",...}` and its reply to `peer-link.ts`.
   - The responder reads the request up to 256 KB, then applies the 4 KB cap to every op except `new-agent`.
   - The dialer sends a `new-agent` request on its own bi stream over the trusted ALPN and waits up to 30 s.
2. **Responder.**
   - Run the five checks in order: allowlist, repo registered here, type spawnable and not `repo-coordinator`, name valid, prompt non-empty and within the cap.
   - Then call an injected `newAgent(repoPath, prompt, { type, name })` with no other options.
   - Log a `watch.log` line and raise the notice "<peer> started agent <id> in <repo>".
3. **PeerService API.** Add a method `startRemoteAgent(peerId, request)` that the dashboard calls.
4. **Form.**
   - Show the Machine field in the New Agent dialog only when a connected peer has the repo.
   - The default is this machine, or the first such peer when the repo exists only on peers.
   - The field cycles like Type.
   - When a peer is selected:
     - show a note that attachments are not sent;
     - submitting closes the dialog with "Created agent <id> on <peer>", or shows the error.
   - Pressing `a` on a remote-only header opens the form with that peer selected. This replaces the Phase 6 notice.
5. **Docs.** Update SPEC, the implementation notes and this plan.

**Done when:**
- every responder refusal has a test;
- a real-endpoint loopback test starts an agent through a stubbed `newAgent`;
- the form is tested with zero, one and two connected peers;
- the full suite and `bunx tsc` pass;
- agents still cannot reach the op. No CLI path exists, `ib peer` stays human-only, and the hook gates are unchanged.

### Phase 8 checklist (Adam, two laptops)

Do this on the same build on both laptops, after `agent/iroh-peering` is on main and installed.

1. **Install.** On each laptop, rebuild and install `ib`, then restart `ib watch`.
2. **Pair.**
   - In `ib watch` on laptop A, press `I`.
   - Paste B's id, which B shows under `I`.
   - Type the 8-character code that B shows into A.
   - Name each side.
   - Both Peers dialogs should then show the other laptop as connected.
3. **Merged repos.**
   - Register one repo under the SAME name on both laptops.
   - It should appear once in the tree.
   - Its remote agents should be drawn in italic below the local ones.
4. **Remote-only repo.** A repo registered only on B should show a header on A with only italic rows.
5. **Read-only guard.** On A, select a remote agent. Send, retire and merge should all be refused with a notice. The info panel should show "Machine: <B> · connected".
6. **Remote start.**
   - On A, press `a` on the shared repo.
   - Set Machine to B, pick a type and type a prompt.
   - A should show "Created agent <id> on <B>".
   - B should show "<A> started agent <id> in <repo>".
   - The new row should appear in italic on A within about 5 s.
7. **Refusals.**
   - A remote start with `repo-coordinator`, or a type that B lacks, should show B's error on A.
   - So should a repo that B does not have. One way to test this: unregister the repo on B while A's form is open.
8. **Offline.**
   - Quit `ib watch` on B.
   - Within a few polls, A should dim B's rows.
   - A remote start to B should fail within 30 s with a clear error.
   - Restart B, and A should reconnect without any action.
9. **Names.**
   - Create an agent with the same name on both laptops.
   - On A, `ib send <name>` should go to A's own agent, because the same repo comes first.
   - From outside that repo, the send should fail and list the qualified forms.

## Cross-cutting checklist

- **Agent functionality:** a remote spawn is an ordinary local `newAgent` on
  the receiving machine. No `meta.json` change.
- **Hooks:** unchanged. There is no new agent-facing command, and `ib peer`
  stays human-only.
- **Watchdog:** remote agents are watched only by their own machine, so
  nothing changes here.
- **`ib watch`:** tree, form, info panel, notices.

## Out of scope for this phase

- Cloning a repo onto a machine that doesn't have it.
- Remote actions other than new-agent, and viewing a remote agent's tmux.
- Remote rows in the Favorites and Teams tabs.
- Matching repos that have different names.
- Showing the remote machine's own agent types in the form.
- Attachments for remote spawns.
- A CLI form of a remote spawn.

## Open questions (recommendation first)

1. **Matching: DECIDED (Adam, 2026-11-20).** Repos match by registered repo
   name only, ignoring case. There is no path matching and nothing fancier.
   To align names, follow the steps under [Matching repos across machines](#matching-repos-across-machines).
2. **Permission.** Any paired machine may start agents here, with a log line
   and a notice on this machine. The alternative is a per-peer "may start
   agents here" switch in the Peers dialog.
3. **V filter.** It now applies to remote agent rows, because they are in the
   main tree.

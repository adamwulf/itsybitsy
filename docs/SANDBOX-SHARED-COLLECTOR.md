# Shared sandbox denial collector

Status (2026-10-07, worker `tag-attribution`): **ON**, with **tag attribution**.
`SANDBOX_DENIAL_COLLECTOR_ENABLED` is `true` (`src/sandbox-log-launch.ts`), so
every new sandboxed spawn and resume attaches to the shared collector. Agents
launched before tag attribution have untagged profiles: they stay unattributed
until their next resume or respawn with the rebuilt `ib` (§10). To turn
collection off, see §10. Code: `src/sandbox-collector.ts`,
`src/sandbox-denials.ts`; live evidence: §12.

Background: `docs/SANDBOX-ROLLOUT.md` (the earlier per-launch collector),
`docs/sandbox-denial-probe-evidence.md` (§13: `--level default`; §14: the SBPL
`(with message …)` probe this design rests on), `docs/sandbox-denial-review.md`
(review findings).

## 1. Why

The per-launch design ran, for every sandboxed spawn or resume, its own
`ib sandbox-log-watch` (Bun) → `ib sandbox-log-stream` (Bun helper) →
`/usr/bin/log stream`. Each `log` process is a separate `diagnosticd` client, so
the cost grew with the number of agents (N). With about ten agents at
`--level debug` this cost 3–4 cores. The shared design runs ONE daemon and ONE
`log stream --level default` for every launch; each launch keeps only a small
`attach` process that registers and supervises it.

Until 2026-10-07 the daemon attributed each kernel report by **process
tracking**: it sampled every registered agent's process tree every 20 ms and
matched the report's pid and mach time against observed lifetimes. That missed
children that lived less than one sample, lost descendants re-parented to pid 1,
and cost about 7% CPU with 7 agents. It is gone.

Now every launch's profile **tags every deny**. SBPL `(with message "<text>")`
on a deny rule makes the kernel append `\n<text>` as the LAST line of that
denial's report, in the same event, also on OS-coalesced
`N duplicate report(s) for Sandbox: …` summaries (probe evidence §14: 200/200
burst children, 20/20 short-lived children and a re-parented orphan were
tagged). Every descendant inherits the profile, so the tag identifies the launch
with no process tracking at all.

## 2. Topology

```
launcher (ib new-agent / ib resume / refresh / rehire; unsandboxed)
  prepareSandbox: tag = ib-agent:<128-bit nonce>, new for every spawn and resume
                  tagged profile -> ~/.itsybitsy/sealed/sandbox-logs/<sha256(agentDir)>/sandbox.sb

per launch (unsandboxed start.sh / resume.sh)       one per user (unsandboxed)
---------------------------------------------       -------------------------------------------
preamble: mktemp launch dir, open fd 9 `stop`       ib sandbox-collector serve --lock-fd 3
supervisor subshell:                                  |- ib sandbox-log-stream   (helper, lifeline pipe)
  ib sandbox-collector attach --(sealed files)-->     |    '- /usr/bin/log stream --level default  (ONE)
    reads the tag from the sealed profile             |- tag -> launch map
    holds clients.lock (shared) for its life          |- pump: each report and marker as it arrives
    starts a daemon if daemon.lock is free            '- 1 s loop: inbox, control files, owner checks, heartbeat
  then removes the launch dir
gate: exec 9>&-; exec sandbox-exec -f <sealed profile> … CLI
```

- **The gate only closes fd 9** (this launch's `stop` file, so the sandboxed
  CLI cannot end its own collection) and execs the mandatory `sandbox-exec`
  wrapper. It no longer writes a root request or waits for one.
- **The daemon** runs outside Seatbelt in its own session (detached), with
  `cwd` = `/`, stdin/stdout `/dev/null`, stderr to `collector.log`, and no
  `AGENT_LOG` in its environment. It is not a child of a tmux pane, `ib watch`
  or a watchdog, so none of them can stop it.
- **The stream helper does not change.** The daemon is the only writer of its
  lifeline pipe; when the daemon dies, the helper reads EOF and ends the stream.
- **Static predicate**: `(eventMessage CONTAINS "Sandbox:" AND eventMessage
  CONTAINS "ib-agent:") OR (eventMessage CONTAINS "IBSandboxReady-<nonce>")`,
  where `<nonce>` is random per daemon. Only tagged reports and our readiness
  markers reach the daemon (the other sandbox denials of the host do not), and
  the stream never restarts to add a launch. The predicate names no tag.

**Daemon state**, `~/.itsybitsy/sealed/sandbox-collector/` (mode 0700):

| Entry | Purpose |
|---|---|
| `daemon.lock` | LOCK_EX = the daemon role (§3). |
| `clients.lock` | LOCK_SH held by every live `attach` (§3). |
| `inbox/<launch>` | registration request (temp file + rename); content: the launch directory path. |
| `heartbeat.json` | `{v, pid, nonce, updatedAt, launches}`, written every loop (1 s) for `ib sandbox-collector status` and the `ib watch` Collector light; no lifecycle decision reads it. `nonce` is the first 8 characters of the daemon's marker nonce, never a tag. |
| `collector.log` | daemon diagnostics and rejected registrations (size-capped at start). |
| `stop` | written by `ib sandbox-collector stop`: end collection for every launch (§6). |
| `restart` | written by `ib sandbox-collector restart`: replace the daemon, keep collecting (§6). |

**Per-agent and per-launch artifacts**, in the agent's sealed namespace
`~/.itsybitsy/sealed/sandbox-logs/<sha256(agentDir)>/` (mode 0700):
`sandbox.sb` (the tagged profile, 0600, rewritten by every spawn and resume),
and one `sandbox-log.XXXXXXXX/` per launch with `stop` (fd 9), `ready`,
`failed`, `registration.json` and `done`. The launch's supervisor subshell stays
the ONLY process that removes its launch directory, after `attach` returns.

## 3. Lifecycle: decided by flocks, not by timers

Every lifecycle decision reads kernel lock state. `flock` locks are dropped by
the kernel on any exit, SIGKILL included, so there is no stale lock, no saved
PID and no PID signal anywhere.

- **One daemon.** `daemon.lock` LOCK_EX is the daemon role. Only a process that
  holds it may serve.
- **Starting.** An `attach` tries `daemon.lock` LOCK_EX|LOCK_NB. If it wins, there
  is no daemon, and it is now the one process allowed to start one: it spawns
  `serve --lock-fd 3` with the locked fd as the child's fd 3 and closes its own
  copy. The role passes over through the shared open file description, so it is
  never free in between. `serve` checks the hand-over in two steps: fd 3 must be
  `daemon.lock` itself (same device and inode; `flock` alone would succeed on
  any other file too), and LOCK_EX on it must succeed (through the inherited
  description, or because the role is free; it fails while another description
  holds it). Otherwise it refuses to serve. If the `attach` loses, a daemon (or a
  starter) holds the role and it only registers. There is no retry loop: two
  launches never both start a daemon.
- **Death.** When the daemon dies, its lock is free at once (measured: the
  daemon's own children do not inherit fd 3, so they cannot keep it). Each
  `attach` checks `daemon.lock` every second; the first that wins it logs a
  WARNING, removes its `ready` and starts the next daemon. That daemon
  **re-adopts every live launch** by scanning the sealed launch directories, so
  a launch whose `attach` did not notice the gap is still collected; it gets the
  WARNING "shared collector resumed" instead.
- **Exit.** Every `attach` holds `clients.lock` LOCK_SH for its whole life. When
  the daemon has no launch and an empty inbox, it tries `clients.lock`
  LOCK_EX|LOCK_NB. Winning means no `attach` is alive. It then closes
  `daemon.lock` while it still holds `clients.lock`, and only then closes
  `clients.lock`. An `attach` that arrives in that instant waits in its blocking
  LOCK_SH, then finds `daemon.lock` free and starts a new daemon; it can never
  register with a daemon that is exiting. No idle timer.
- **Bounded starts.** One `attach` starts at most 4 daemons in a row that never
  acknowledge its launch, so a daemon that dies at once on every start (for
  example, `log stream` refuses to run) is not respawned in a loop. Every
  acknowledgement (`ready`) resets the count, so a launch that lives for days
  survives any number of restarts that each worked.
- **Cadences, not deadlines.** The daemon has ONE loop, every **1 s**: it reads
  its own `stop`/`restart` requests and the inbox, checks each launch's `stop`
  file, owner and registrar, re-emits the readiness marker of a launch that is
  not ready yet, and writes the heartbeat. Stream events never wait for it: the
  pump attributes each report as it arrives and writes `ready` as soon as a
  launch's marker comes back. A registering `attach` checks every 50 ms; a
  registered one checks `done` and the lock every second.

**Why the readiness wait needs no faster loop.** A registration waits at most
one pass to be admitted; admission emits the first marker, and the pump
acknowledges it at once. A cold stream can lose that first marker; the next pass
emits another. So a launch is ready about 1–2 s after it registers (live: 1.2 s
for two launches including the daemon's own start), and one whose markers never
come back fails at the 3 s marker deadline, about 4 s after it registers. Both
are inside the preamble's 5 s bound, so the daemon's visible ERROR, not the
preamble's generic one, explains a failure.

**Waits that remain time-bounded**, and why no lock can replace them:

| Wait | Bound | Reason |
|---|---|---|
| Preamble waits for `ready` / `failed` | 5 s | An agent launch must never block on a diagnostic: after 5 s the CLI starts under the mandatory wrapper with a visible ERROR. |
| Readiness marker | 3 s, re-emitted once per loop (1 s) | The unified log gives no acknowledgement. The `logger` marker seen on the live stream is the only proof that the stream delivers events; it cannot be awaited forever. |
| Drain after a launch ends | 1 s | Kernel reports reach the stream asynchronously, and no event marks "all reports for this launch have arrived". |

`attach` itself has no deadline. It waits until the daemon answers (`ready`,
`failed`, `done`), until it wins a free lock (and starts a daemon), or until its
own launch ends (owner gone, `stop` written, SIGTERM).

## 4. Registration, tags and trust model

**Threats** from a sandboxed agent or its descendants: (a) forge a registration so
denials or text reach a log it chooses; (b) redirect a registration to another
`agent.log`; (c) fake readiness or hide its own denials; (d) stop, take over or
impersonate the daemon; (e) use the unsandboxed daemon as a confused deputy;
(f) make a report carry another launch's tag, so it lands in that launch's log.

**Trust boundary: the sealed tree.** The shipped floor (`_all.md` `paths.deny`)
denies `~/.itsybitsy/sealed` to every sandboxed agent, for read and write, and
deny wins over every allow layer. Only unsandboxed processes of the user can
read or write `sealed/sandbox-collector/` or `sealed/sandbox-logs/`. A sandboxed
process also cannot run `log stream` (`Cannot run while sandboxed`) and cannot
open `daemon.lock`, so it cannot be the daemon.

**Tag secrecy.** The tag is `ib-agent:<32 hex>`: a 128-bit nonce from
`randomBytes`, new for every spawn and resume (`newSandboxTag`). It exists in
exactly two places, both sealed: the launch's profile (`<namespace>/sandbox.sb`,
0600) and its `registration.json`. It is never on a command line (`sandbox-exec`
gets the profile path, `attach` reads the tag itself, and the predicate holds
only the `ib-agent:` prefix; live: no process argv held either nonce), never in
an environment variable, and never in a file in the agent directory (`start.sh`,
`meta.json`, `agent.log`: a `[Sandbox]` record names the launch, not the tag),
which every agent of the repository can read. Until this change the profile was
`<agentDir>/sandbox.sb`; it held no secret then. The agent itself cannot read
its own profile either (live: `cat` of it is denied, and that denial is
recorded).

The daemon checks every registration (inbox entry or re-adopted directory):

1. **Launch directory** (`checkLaunchDirectory`): name `^sandbox-log\.[a-zA-Z0-9]+$`;
   an absolute path in `sealed/sandbox-logs/<64 hex>/`; `lstat` shows a real
   directory (not a symlink) owned by our uid with mode 0700. Files in it are
   opened `O_NOFOLLOW | O_NONBLOCK` and must be small regular files. Only such a
   directory is ever written to.
2. **Log binding**: `sandboxLogParent(dirname(agentLog)) === dirname(launchDir)`
   — a launch may only name the `agent.log` of the agent directory whose hash
   names its namespace.
3. **Owner proof**: `registration.json` names the boot session
   (`kern.bootsessionuuid`) and two exact processes, each as PID + birth: the
   owner (`$$` of start.sh/resume.sh) and the registrar (the `attach` process).
   The daemon requires the same boot, a live process at each PID with exactly
   that birth (so a PID reused after a crash or reboot is rejected), the owner
   as the registrar's ancestor within 64 levels (the supervisor subshell sits
   between them), and the kernel reporting both unsandboxed
   (`sandbox_check(pid, NULL, 0) == 0`; a reaped PID reads as sandboxed, so the
   check fails closed). `attach` lives as long as the launch, so the daemon ends
   a launch whose registrar dies. A stale directory (dead or reused registrar,
   other boot) is rejected and marked `done` = `rejected`, so later daemon
   starts skip it instead of re-examining it every time.
4. **Tag**: protocol `v: 2` carries `tag`, which must match `SANDBOX_TAG`
   exactly. A tag that another registered launch already holds is rejected (two
   launches never share a tag). Protocol 1 (no tag) is rejected visibly.
5. **Rejections** go to `collector.log`, never to the unverified `agent.log`
   path. If the launch directory itself passed rule 1, the daemon also writes
   `failed` and `done` (`rejected`) there. The launch's `attach` treats that as
   final, whether it is still registering or already registered, and returns; if
   the launch's owner is still alive it first logs a visible ERROR in its own
   `agent.log` (a launch whose owner already exited ends quietly).
6. **No channel from inside the sandbox**: no socket and no writable path reach
   the daemon. The hooks deny `ib sandbox-collector` to agents
   (`containsInternalIbInvocation`) as defense in depth.
7. **Readiness spoofing**: a marker counts only from `processImagePath ===
   "/usr/bin/logger"`. The marker nonce is visible in `ps` (it is in the
   predicate), so it scopes markers to one daemon but is not a secret. A spoof
   could only fake readiness of a stream the daemon already runs, which never
   weakens enforcement.
8. **Confused deputy**: the daemon writes into agent-writable directories only
   through `appendAgentLog`: `O_NOFOLLOW | O_NONBLOCK | O_APPEND`, regular files
   only. A symlinked `agent.log` cannot redirect its writes, and a FIFO cannot
   block it (which would stall collection for every agent).

**Why a report cannot claim another launch's tag (threat f)** (probe evidence
§14, forgery):

- A `logger` line from inside a sandbox has `processID` = the logger pid,
  `processImagePath` `/usr/bin/logger`, `messageType` Default: it fails the
  kernel-report check (§5). Other kernel lines (AMFI) have `/kernel` too, but a
  different `senderImagePath`.
- A sandboxed process cannot apply a second profile with another tag
  (`sandbox_apply: Operation not permitted`).
- Path and process-name text come BEFORE the tag. Because every deny of our
  profiles is tagged, the real tag is always the last line; text such as
  `x\nib-agent:<other>` in a path stays in the middle.
- A report from a rule WITHOUT our message (for example a system daemon's own
  profile, acting on a path an agent chose) ends with path text. A path ending in
  `\nib-agent:<tag>` would be read as that tag, so the forger needs a secret
  128-bit nonce it cannot read.
- A report the kernel truncated (§5) is never attributed, so a cut that leaves a
  forged line last does not count.

**Residual.** Unsandboxed processes of the user (the user, `@system`, agents
with `sandbox: false`, and a sandboxed spawner through its tmux escape,
SPEC-SANDBOX.md 4C.3) can read the sealed tree, learn a tag, and cause tagged
reports; they can already write any `agent.log` directly.

## 5. Attribution

For each line of the stream, in the pump, as it arrives
(`parseSandboxReport`, `src/sandbox-denials.ts`):

1. **A real kernel report only**: `processID` 0, `processImagePath` `/kernel`,
   `senderImagePath` `/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox`,
   `messageType` Error, a valid `timestamp` and `machTimestamp`, and an
   `eventMessage` that starts with `Sandbox: ` or `N duplicate report(s) for
   Sandbox: ` (N ≥ 1). Anything else is ignored.
2. **Not truncated**: the kernel keeps the first 1008 bytes of a long report and
   appends `<…>`. The tag is last, so it is the first text lost; a report that
   ends in `<…>` is never attributed. With the 41-byte tag, a path of about 850
   bytes or less keeps it.
3. **The tag is the text after the LAST `\n`.** It must equal a registered
   launch's tag exactly (a map lookup). There is no substring search anywhere,
   because path and process-name text can contain `ib-agent:` lines. A report
   with no newline (a rule without our message), or with an unknown tag, is
   unattributed.
4. **The record**: the offender is split from the text before the tag,
   `<name>(<pid>) deny(<n>) <operation> [<target>]`. Kernel p_name is at most
   32 unsanitized bytes, so every feasible delimiter is examined and only an
   unambiguous split is used; an ambiguous one is counted (`ambiguous process
   names omitted=N` in that launch's summary), not recorded. The record is
   `[<timestamp>] [Sandbox] <operation> process="<name>" pid=<pid>
   target="<path>" launch=<launch> boot=<boot> mach=<mach>`, plus
   ` duplicates=N` for an OS-coalesced summary. Strings are JSON-quoted, so a
   path with newlines stays one line. The record never contains the tag.
5. **Budget** (`SandboxOutputBudget`, one per launch): 60 records per minute and
   3 per pid/operation/target per minute, with a 2,048-event deduplication
   cache; suppressed counts go into the launch's 60-second WARNING summary.

A launch's tag is registered from admission until its launch ends (after the
1 s drain), ready or not, so a re-adopted launch is attributed as soon as the
new daemon has admitted it.

**Unattributed, never guessed**: truncated reports; reports with an unknown
tag; reports while no daemon ran (a restart gap) or before a launch was
admitted; reports after a launch ended (an orphan that outlives its launch);
and every report of a launch started before tag attribution (an untagged
profile), until its next resume or respawn.

## 6. Failure handling

Kernel enforcement never depends on the collector: the gate always execs the
mandatory `sandbox-exec` wrapper. Every failure is diagnostic and visible in
`agent.log` (and so in DENIALS).

| Failure | Behaviour (verified where marked) |
|---|---|
| No daemon at launch | The `attach` that wins `daemon.lock` starts one. If none answers within the preamble's 5 s, the CLI starts under the wrapper with an ERROR. |
| Profile has no tag | `attach` fails at once ("the launch profile carries no attribution tag", tested); the CLI starts under the wrapper with an ERROR. |
| Daemon SIGKILL | Lock free at once; the helper reads lifeline EOF and the old stream ends. The first `attach` to win the lock starts a daemon, which re-adopts every live launch with its tag. Reports while no daemon ran are lost; every later tagged report is attributed, re-parented descendants included. |
| `log stream` dies (tested) | Daemon writes ERROR to every launch, gives up the role at once, exits 1; the next daemon starts and re-adopts as above. |
| Registration rejected (tested, including a duplicate tag and a successor's re-adopt scan while the launch's attach is still registered) | Reason in `collector.log`; `failed` and `done` (`rejected`) in the launch directory. The launch's `attach` returns at its next check: with an ERROR in `agent.log` if its owner is alive, quietly if the owner already exited. It never waits on a daemon that holds the role. |
| One launch's `agent.log` unwritable, a FIFO or a symlink (tested) | Writes fail at once (never block, never follow); that launch only is dropped; the others keep their records. |
| `ib sandbox-collector restart`, or SIGTERM to the daemon (tested) | The daemon logs a WARNING to each launch, drops them WITHOUT `done`, gives up the role, then tears down its stream. The attaches start a new daemon, which re-adopts every launch with its tag. Collection continues. |
| `ib sandbox-collector stop` (tested) | Ends collection for every running launch: each gets `collector stopped` and `done`, each attach returns, the daemon exits. Running agents are not collected again until resumed. |
| Daemon alive but stuck (no loop) | A lock cannot show it: the lock stays held. `ib sandbox-collector status` prints the heartbeat age and marks it STALE after 5 s, with the fix: `kill -9 <pid>` (from the heartbeat). The lock then frees and the attaches start a new daemon that re-adopts every launch. Nothing kills it automatically. |
| `ib` rebuilt while a daemon runs | The daemon keeps its binary until it exits (when no launch remains). `registration.json` carries protocol `v`; an unknown version is rejected visibly. After an `ib` that changes the protocol (as tag attribution did, 1 → 2), run `ib sandbox-collector restart` once so new launches register with a new daemon. |

**Blast radius**: one daemon failure touches every agent at once (before: one
launch). Restart plus re-adopt bounds the gap to the time to start a daemon and
see its marker.

## 7. Cleanup

- **Per launch**: owner gone, `stop` written (fd 9 EXIT trap), or registrar gone
  → 1 s drain → `collector stopped` → `done` (holding the registration's token,
  so a reused name cannot end the wrong launch) → `attach` returns → the
  subshell removes the directory. A WARNING says when collection stops while the
  owner still runs (`stop` request, or the registrar died).
- **Per agent**: each spawn and resume overwrites `<namespace>/sandbox.sb`. The
  teardowns that delete the agent's seal (retire, merge, nuke, and the cleanup
  of a failed spawn) also delete the profile, and then the namespace directory
  once no launch directory is left in it (`removeSandboxProfile`). That is best
  effort: a teardown never fails on it, and a leftover profile's tag belongs to
  no live launch.
- **Daemon**: exits when no launch and no `attach` remain (§3); its lifeline
  closes, so the helper and `log stream` end with it; it removes its heartbeat.

## 8. CPU

Live, 2026-10-07, two launches, one 30 s window (`ps` CPU time; §12):

| Process | Process tracking (before) | Tag attribution |
|---|---|---|
| daemon (Bun) | 4.6% with 1 launch, 5.0% with 4 (quiet), 5.3–7.1% with 2 (noisy host) | **0.17%** with 2 launches |
| per-launch `attach` | 0.10–0.47% | 0.10% each |
| stream helper | ~0.1% | 0.07% |
| `log stream` | 1.75–8.6% (host-dependent) | 27.8% on a very noisy host (below) |
| `diagnosticd` | one client | one client (not measured) |

The daemon no longer samples process trees (`proc_listchildpids` at 50 Hz was
most of its cost), and with the tag in the predicate it no longer parses the
host's other sandbox denials: in the window above the stream delivered 1 line
where the old predicate delivered 4,290.

The `log stream` cost depends on system-wide sandbox-denial traffic, not on the
predicate: three standalone streams measured at the same time over the same
30 s, while the host produced about 143 sandbox denials per second, used 19.7%
(the previous predicate), 18.1% (`Sandbox:` OR marker) and 17.3% (this
predicate). Earlier measurements: 1.75% in a quiet period, 8.6% at about 6
denials per second.

## 9. Commands

`ib sandbox-collector attach --dir D --owner PID --agent-log F` (internal, run by
the preamble), `serve [--lock-fd 3]` (internal, the daemon), `status` (running,
pid, launches, heartbeat age, STALE mark), `restart` (replace the daemon, keep
collecting), `stop` (end collection for every running launch).
`ib sandbox-log-watch` is removed; `sandboxStreamExited` and
`closeSandboxLogStream` live in `src/sandbox-log-stream.ts`.

## 10. Turning collection on and off; deploying

Collection is on (2026-10-06). New spawns and resumes attach; running agents
keep their current scripts until resumed or respawned with the rebuilt `ib`.

**Deploying tag attribution** (once): install the rebuilt `ib`, then run
`ib sandbox-collector restart`. A daemon from the older `ib` would otherwise keep
running and reject every protocol-2 registration. The new daemon rejects the
older launches' protocol-1 registrations when it re-adopts them (a visible ERROR
in their `agent.log`); those agents stay unattributed until their next resume or
respawn. No compatibility path exists for untagged launches.

To turn collection off:

1. Set `SANDBOX_DENIAL_COLLECTOR_ENABLED = false` and rebuild `ib`. Then
   `sandboxDenialScriptPreamble()` returns `""` and `sandboxDenialExecPrefix()`
   returns the plain `sandbox-exec` prefix, so new spawns and resumes start no
   collector, no readiness handshake and no gate. Profiles stay tagged (the tag
   changes only the report text, not enforcement).
2. Run `ib sandbox-collector stop` to end collection for launches that are
   already running (§6). They are not collected again until resumed.

## 11. Cross-cutting checklist (AGENTS.md)

1. **Agent lifecycle** — every spawn, resume, refresh and rehire writes a new
   tagged profile into the sealed namespace (`prepareSandbox`); `start.sh` /
   `resume.sh` name that path and run `attach` in the supervisor subshell (all
   CLIs, per-repository coordinators). `meta.json` unchanged; no file in the
   agent directory holds the tag. `@system` stays unsandboxed with no collector.
2. **Hooks** — unchanged: `sandbox-collector` stays in the internal-verb deny
   list, and the sealed-tree floor deny (which now also hides the profile) is
   unchanged. A `rawAllow` deny that cannot be tagged is a type validation
   error.
3. **Watchdog** — not involved: it neither starts nor restarts the daemon.
4. **`ib watch`** — the same `[Sandbox]` and `[SandboxCollector]` records reach
   the DENIALS parser. Records no longer carry `birth=` and may carry
   ` duplicates=N`; the compact DENIALS display shows the count and still
   compacts older records. The "Collector" stoplight (`src/sandbox-collector-light.ts`)
   reads the same lock and heartbeat (`{v, pid, nonce, updatedAt, launches}`,
   now `v` 2 and written every second): grey = off or idle, green = daemon with
   a fresh heartbeat, yellow = no heartbeat yet, a STALE heartbeat (over 5 s),
   or launches attached with no daemon on one probe, red = the same on two
   probes in a row.

Decisions taken with the recommended defaults (the user may revisit): the daemon
exits when no launch remains (by lock, not a timer); a stuck daemon is reported,
never killed by PID; the tag's nonce is per spawn/resume, not per agent; an
untagged (older) launch is rejected rather than tracked by a fallback.

## 12. Validation

**Unit tests**:

- `src/sandbox.test.ts`: every deny of a generated profile carries the tag
  (default, read-only write denies, raw and configured denies, seal-helper
  denies; one tag per deny, a string containing `(deny` is not a rule); a
  `rawAllow` deny that cannot be tagged is refused by generation and
  validation; tags are 128-bit, new per call, malformed tags refused; the
  live macOS `sandbox-exec` probe compiles and enforces the tagged profile.
- `src/sandbox-log-paths.test.ts`: the shipped floor denies the profile path
  (read and write) for spawners and non-spawners, also with broad access.
- `src/ib-commands.test.ts`: spawn and resume write the profile to the sealed
  namespace (0600), `start.sh` names it, no file in the agent directory holds
  the nonce, and a resume keeps the rules under a new tag.
- `src/sandbox-denials.test.ts`: a real kernel report → its tag and offender; a
  coalesced summary keeps its count; `\nib-agent:<other>` in a path with the
  real tag last → the real tag only; a truncated report → rejected; forged
  `logger`-style, wrong processID / image / sender / messageType, sandboxd →
  rejected; an ambiguous process name → offender null, tag kept; the record
  never holds the tag.
- `src/sandbox-collector.test.ts` (26 tests, real processes and flocks; the
  stream is a controlled peer, not `/usr/bin/log`): two launches each get only
  their own records, by exact tag (an unknown tag, a tag followed by a space,
  and another launch's tag in a path are not attributed); a duplicate tag is
  rejected; a finished launch's tag no longer matches; duplicate counts and the
  ambiguous-name summary; the daemon loop runs once a second (one marker and
  one heartbeat per pass, the 3 s marker deadline) while a returned marker and
  a report are handled between passes; `attach` registers its profile's tag and
  refuses an untagged profile; restart and a stream failure leave both launches
  to a successor that re-adopts them and attributes their tags again; plus the
  registration, lock, hand-over, FIFO, stale-directory, start-count and stop
  tests of the previous design.
- `src/sandbox-log-launch.test.ts`: the gate is exactly `exec 9>&-; exec "$@"`
  in front of the wrapper; the CLI inherits no collector variable and no fd 9.

**Live** (2026-10-07, this host, kernel sandbox off for the worker): a scratch
`ib` shim dispatching `sandbox-collector attach|serve` and `sandbox-log-stream`
to this branch's code with an explicit `home` = a private temporary root (HOME
unchanged; the real collector untouched); the real preamble and fd-9 gate; real
tagged profiles from the shipped `_all.md` floor plus a per-launch `forbidden/`
deny, written to each agent's sealed namespace; real `/usr/bin/sandbox-exec`,
`logger` and `log stream`. Two concurrent launches A and B; each CLI did a denied
builtin read (root shell), a denied write by a child shell that exited at once,
and a read of its own sealed profile, then stayed alive 40 s.

| Check | Result |
|---|---|
| Processes | 1 daemon, 1 helper, 1 `log stream`, 2 `attach` |
| Readiness | both `ready` 1.19 s after start, cold (daemon start included) |
| Denied root read, child write, profile read | 3 records in A's log, 3 in B's; each only in its own log (targets in its own `forbidden-*/` and its own namespace); the child's pid recorded although it exited at once |
| Enforcement | all EPERM; `child-write.txt` never created |
| Nonce on a command line | none: no process argv held either nonce |
| CPU over 30 s (2 launches) | daemon 0.17%, helper 0.07%, each `attach` 0.10%, `log stream` 27.8% (host load, §8) |
| CLI exit | `collector stopped` in both logs; launch directories removed; the daemon exited 1 s later; no process, heartbeat or launch directory left |

Earlier live evidence for the shared design (process tracking, 2026-10-06:
two launches, daemon and `log stream` SIGKILL recovery, `restart` through the
real binary) is in this document's history (`git log -p
docs/SANDBOX-SHARED-COLLECTOR.md`); the lock lifecycle it validated did not
change.

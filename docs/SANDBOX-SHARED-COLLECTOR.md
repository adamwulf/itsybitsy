# Shared sandbox denial collector

Status (2026-10-06, worker `log-level-default`): **implemented behind
`SANDBOX_DENIAL_COLLECTOR_ENABLED`, which stays `false`**
(`src/sandbox-log-launch.ts`). While it is false, `sandboxDenialScriptPreamble()`
returns `""` and `sandboxDenialExecPrefix()` returns the plain `sandbox-exec`
prefix, so no launch starts any collector. Turning it on is a separate decision
(§10). Code: `src/sandbox-collector.ts`; live evidence: §12.

Background: `docs/SANDBOX-ROLLOUT.md` (the earlier per-launch collector),
`docs/sandbox-denial-probe-evidence.md` (§13: `--level default`),
`docs/sandbox-denial-review.md` (review findings).

## 1. Why

The per-launch design ran, for every sandboxed spawn or resume, its own
`ib sandbox-log-watch` (Bun) → `ib sandbox-log-stream` (Bun helper) →
`/usr/bin/log stream`. Each `log` process is a separate `diagnosticd` client, so
the cost grew with the number of agents (N). With about ten agents at
`--level debug` this cost 3–4 cores.

Now: ONE daemon and ONE `log stream --level default` serve every launch. The
per-launch helper, stream and Bun collector are gone; each launch keeps only a
small `attach` process (about 0.10–0.15% CPU) that registers it and supervises it.

## 2. Topology

```
per launch (unsandboxed start.sh / resume.sh)       one per user (unsandboxed)
---------------------------------------------       -------------------------------------------
preamble: mktemp launch dir, open fd 9 `stop`       ib sandbox-collector serve --lock-fd 3
supervisor subshell:                                  |- ib sandbox-log-stream   (unchanged helper,
  ib sandbox-collector attach --(sealed files)-->     |    |                      lifeline pipe)
    holds clients.lock (shared) for its life          |    '- /usr/bin/log stream --level default  (ONE)
    starts a daemon if daemon.lock is free            |- one SandboxAttribution per launch
  then removes the launch dir                         '- 20 ms loop: inbox, tree sampling, attribution
gate: root-request -> waits root-ready  (unchanged)
exec sandbox-exec ... CLI               (unchanged)
```

- **The preamble and the gate barely change.** The supervisor subshell runs
  `ib sandbox-collector attach` where it ran `ib sandbox-log-watch`. The `ready`,
  `failed`, `root-request`, `root-ready` and fd 9 `stop` protocol is the same.
- **The daemon** runs outside Seatbelt in its own session (detached), with
  `cwd` = `/`, stdin/stdout `/dev/null`, stderr to `collector.log`, and a
  scrubbed environment (no `AGENT_LOG`, no `IB_SANDBOX_*`). It is not a child of
  a tmux pane, `ib watch` or a watchdog, so none of them can stop it.
- **The stream helper does not change.** The daemon is the only writer of its
  lifeline pipe; when the daemon dies, the helper reads EOF and ends the stream.
- **Static predicate**: the old predicate with one marker clause,
  `eventMessage CONTAINS "IBSandboxReady-<nonce>"`, where `<nonce>` is random per
  daemon. Per-launch markers are `IBSandboxReady-<nonce> <launch> ready`, so the
  stream never restarts to add a launch.

**Daemon state**, `~/.itsybitsy/sealed/sandbox-collector/` (mode 0700):

| Entry | Purpose |
|---|---|
| `daemon.lock` | LOCK_EX = the daemon role (§3). |
| `clients.lock` | LOCK_SH held by every live `attach` (§3). |
| `inbox/<launch>` | registration request (temp file + rename); content: the launch directory path. |
| `heartbeat.json` | written every second for `ib sandbox-collector status` and the `ib watch` Collector light; no lifecycle decision reads it. |
| `collector.log` | daemon diagnostics and rejected registrations (size-capped at start). |
| `stop` | written by `ib sandbox-collector stop`: end collection for every launch (§6). |
| `restart` | written by `ib sandbox-collector restart`: replace the daemon, keep collecting (§6). |

**Per-launch artifacts stay where they were**:
`~/.itsybitsy/sealed/sandbox-logs/<sha256(agentDir)>/sandbox-log.XXXXXXXX/` with
`stop` (fd 9), `root-request`, `root-ready`, `ready`, `failed`, plus
`registration.json` and `done`. The launch's supervisor subshell stays the ONLY
process that removes that directory, after `attach` returns.

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
  `attach` checks `daemon.lock` every second; the first that wins it starts the
  next daemon. That daemon **re-adopts every live launch** by scanning the sealed
  launch directories, so a launch whose `attach` did not notice the gap is still
  collected (this was a real failure in the first live run).
- **Exit.** Every `attach` holds `clients.lock` LOCK_SH for its whole life. When
  the daemon has no launch and an empty inbox, it tries `clients.lock`
  LOCK_EX|LOCK_NB. Winning means no `attach` is alive. It then closes
  `daemon.lock` while it still holds `clients.lock`, and only then closes
  `clients.lock`. An `attach` that arrives in that instant waits in its blocking
  LOCK_SH, then finds `daemon.lock` free and starts a new daemon; it can never
  register with a daemon that is exiting. Measured: the daemon exited 0.2 s after
  the last launch ended. No idle timer.
- **Bounded starts.** One `attach` starts at most 4 daemons in a row that never
  acknowledge its launch, so a daemon that dies at once on every start (for
  example, `log stream` refuses to run) is not respawned in a loop. Every
  acknowledgement (`ready`) resets the count, so a launch that lives for days
  survives any number of restarts that each worked.
- **Cadences, not deadlines.** The daemon samples registered trees every 20 ms
  (attribution coverage), re-reads each launch's `stop` file, owner and
  registrar and its own `stop`/`restart` requests every 250 ms (the 1 s drain
  makes a finer check pointless), and reads the inbox only when the directory's
  mtime changes (with a 250 ms fallback). With no registered root it sleeps
  250 ms per loop (50 ms while a launch waits for its readiness marker). A
  registered `attach` checks `done` and the lock every second.

**Waits that remain time-bounded**, and why no lock can replace them:

| Wait | Bound | Reason |
|---|---|---|
| Preamble waits for `ready` / `failed` | 5 s | Unchanged. An agent launch must never block on a diagnostic: after 5 s the CLI starts under the mandatory wrapper with a visible ERROR. |
| Gate waits for `root-ready` | 2 s | Unchanged, same reason. |
| Readiness marker | 3 s, re-emitted every 100 ms | The unified log gives no acknowledgement. The `logger` marker seen on the live stream is the only proof that the stream delivers events; it cannot be awaited forever. |
| Drain after a launch ends | 1 s | Unchanged from the reviewed collector: kernel reports reach the stream asynchronously, and no event marks "all reports for this process have arrived". |
| Pending report | 500 ms | Unchanged: a report waits for the next tree sample that brackets its timestamp. |

`attach` itself has no deadline. It waits until the daemon answers (`ready`,
`failed`, `done`), until it wins a free lock (and starts a daemon), or until its
own launch ends (owner gone, `stop` written, SIGTERM).

## 4. Registration and trust model

**Threats** from a sandboxed agent or its descendants: (a) forge a registration so
denials or text reach a log it chooses; (b) redirect a registration to another
`agent.log`; (c) fake readiness or hide its own denials; (d) stop, take over or
impersonate the daemon; (e) use the unsandboxed daemon as a confused deputy.

**Trust boundary: the sealed tree.** The shipped floor (`_all.md` `paths.deny`)
denies `~/.itsybitsy/sealed` to every sandboxed agent, and deny wins over every
allow layer. Only unsandboxed processes of the user can write
`sealed/sandbox-collector/` or `sealed/sandbox-logs/` — verified live: a
sandboxed root's write to `inbox/` got EPERM (and was itself recorded as a
`[Sandbox]` denial). A sandboxed process also cannot run `log stream` (`Cannot
run while sandboxed`) and cannot open `daemon.lock`, so it cannot be the daemon.

The daemon checks every registration (inbox entry or re-adopted directory):

1. **Launch directory** (`checkLaunchDirectory`): name `^sandbox-log\.[a-zA-Z0-9]+$`;
   an absolute path in `sealed/sandbox-logs/<64 hex>/`; `lstat` shows a real
   directory (not a symlink) owned by our uid with mode 0700. Files in it are
   opened `O_NOFOLLOW | O_NONBLOCK` and must be small regular files. Only such a
   directory is ever written to.
2. **Log binding (unchanged rule)**: `sandboxLogParent(dirname(agentLog)) ===
   dirname(launchDir)` — a launch may only name the `agent.log` of the agent
   directory whose hash names its namespace.
3. **Owner proof** (replaces "the owner is my ancestor", which a shared daemon
   cannot prove of itself): `registration.json` names the boot session
   (`kern.bootsessionuuid`) and two exact processes, each as PID + birth: the
   owner (`$$` of start.sh/resume.sh) and the registrar (the `attach` process).
   The daemon requires the same boot, a live process at each PID with exactly
   that birth (so a PID reused after a crash or reboot is rejected), the owner
   as the registrar's ancestor within 64 levels (the supervisor subshell sits
   between them), and the kernel reporting both unsandboxed
   (`sandbox_check(pid, NULL, 0) == 0`; a test with the real binding shows a
   reaped PID reads as sandboxed, so the check fails closed). `attach` lives as
   long as the launch, so the daemon ends a launch whose registrar dies. A stale
   directory (dead or reused registrar, other boot) is rejected and marked
   `done` = `rejected`, so later daemon starts skip it instead of re-examining
   it every time.
4. **Root acknowledgement**: the gate (still unsandboxed) writes `root-request` =
   its `$$`. The daemon requires `root.ppid === owner`, a root that is not the
   registrar or one of its ancestors, and a root identity no other launch holds.
   `root-ready` now means **the shared collector acknowledged this root and is
   sampling its tree**.
5. **Rejections** go to `collector.log`, never to the unverified `agent.log`
   path. If the launch directory itself passed rule 1, the daemon also writes
   `failed` and `done` (`rejected`) there. The launch's `attach` treats that as
   final, whether it is still registering or already registered (a successor's
   re-adopt scan can reject a launch whose owner just exited), and returns; if
   the launch's owner is still alive it first logs a visible ERROR in its own
   `agent.log` (a launch whose owner already exited ends quietly).
6. **No channel from inside the sandbox**: no socket and no writable path reach
   the daemon. The hooks deny `ib sandbox-collector` to agents
   (`containsInternalIbInvocation`) as defense in depth.
7. **Readiness spoofing**: a marker counts only from `processImagePath ===
   "/usr/bin/logger"`. The nonce is visible in `ps` (it is in the predicate), so
   it scopes markers to one daemon but is not a secret. A spoof could only fake
   readiness of a stream the daemon already runs, which never weakens
   enforcement.
8. **Confused deputy**: the daemon writes into agent-writable directories only
   through `appendAgentLog`: `O_NOFOLLOW | O_NONBLOCK | O_APPEND`, regular files
   only. A symlinked `agent.log` cannot redirect its writes, and a FIFO cannot
   block it (which would stall collection for every agent).

**Residual (unchanged).** Unsandboxed processes of the user (the user, `@system`,
agents with `sandbox: false`) can write the sealed tree and could forge a
registration; they can already write any `agent.log` directly.

## 5. Attribution

The algorithm is unchanged; only the number of instances per process changes.

- Per launch: one `SandboxAttribution` (root pid + birth, observed descendant
  intervals, `mach_continuous_time` brackets, 4,096 instances, 30 s history),
  `sampleSandboxTree` every 20 ms, one `SandboxOutputBudget` (60 per minute, 3
  per process/operation/target), `formatSandboxRecord` with that launch's name.
- One process reader and one pending queue (512 reports, 500 ms). Each report is
  parsed once and offered to every launch with a registered root:
  - exactly one launch matches → that launch's `agent.log`;
  - none → kept for up to 500 ms, then dropped;
  - two or more → omitted and counted as ambiguous in each matching launch's
    summary (never guess between launches).
- Queue overflow and ambiguous-name parses cannot be attributed to one launch, so
  they count in every active launch's 60-second WARNING summary (each old
  collector also counted every system-wide event it saw).

## 6. Failure handling

Kernel enforcement never depends on the collector: the gate always execs the
mandatory `sandbox-exec` wrapper. Every failure is diagnostic and visible in
`agent.log` (and so in DENIALS).

| Failure | Behaviour (verified live where marked) |
|---|---|
| No daemon at launch | The `attach` that wins `daemon.lock` starts one. If none answers within the preamble's 5 s, the CLI starts under the wrapper with today's ERROR. |
| Daemon SIGKILL (live) | Lock free at once; the helper reads lifeline EOF and the old stream ends. The first `attach` to win the lock starts a daemon, which re-adopts every live launch: WARNING "shared collector resumed; reports while it was down were not collected". Live descendants are found again from the root; only orphans re-parented during the gap are lost. |
| `log stream` dies (live) | Daemon writes ERROR to every launch, gives up the role at once, exits 1; the next daemon starts and re-adopts as above. |
| Registration rejected (tested, including by a successor's re-adopt scan while the launch's attach is still registered) | Reason in `collector.log`; `failed` and `done` (`rejected`) in the launch directory. The launch's `attach` returns at its next check: with an ERROR in `agent.log` if its owner is alive, quietly if the owner already exited. It never waits on a daemon that holds the role. |
| One launch's `agent.log` unwritable, a FIFO or a symlink (tested) | Writes fail at once (never block, never follow); that launch only is dropped; the others keep their records. |
| One tree exceeds 4,096 processes | ERROR to that launch; that launch only is dropped. |
| `ib sandbox-collector restart`, or SIGTERM to the daemon (tested) | The daemon logs a WARNING to each launch, drops them WITHOUT `done`, gives up the role, then tears down its stream. The attaches start a new daemon, which re-adopts every launch. Collection continues. |
| `ib sandbox-collector stop` (tested) | Ends collection for every running launch: each gets `collector stopped` and `done`, each attach returns, the daemon exits. Use it to stop collection now (for example after turning the switch off); running agents are not collected again until resumed. |
| Daemon alive but stuck (no loop) | A lock cannot show it: the lock stays held. `ib sandbox-collector status` prints the heartbeat age and marks it STALE after 5 s, with the fix: `kill -9 <pid>` (from the heartbeat). The lock then frees and the attaches start a new daemon that re-adopts every launch. Nothing kills it automatically (unchanged rule). |
| `ib` rebuilt while a daemon runs | The daemon keeps its binary until it exits (when no launch remains). `registration.json` carries protocol `v`; an unknown version is rejected visibly. |

**Blast radius**: one daemon failure touches every agent at once (before: one
launch). Restart plus re-adopt bounds the gap to the time to start a daemon and
see its marker (live: about 0.2–0.4 s).

## 7. Cleanup

- **Per launch** (unchanged): owner gone, `stop` written (fd 9 EXIT trap), root
  gone, or registrar gone → 1 s drain → `collector stopped` → `done` (holding
  the registration's token, so a reused name cannot end the wrong launch) →
  `attach` returns → the subshell removes the directory.
- **Daemon**: exits when no launch and no `attach` remain (§3); its lifeline
  closes, so the helper and `log stream` end with it; it removes its heartbeat.

## 8. CPU

Measured on one host (details: §12 and evidence §13). The `log stream` cost
depends on system-wide sandbox-denial traffic: 1.75% in a quiet period, 8.6% while
`spotlightknowledged.updater` produced about 6 denials per second — the same for
the shared stream and a standalone one measured at the same time.

| Process | Per-launch design (`--level default`) | Shared design |
|---|---|---|
| `log stream` | N × 1.75–8.6% | 1 × 1.75–8.6% |
| stream helper | N × ~0.1% | 1 × ~0.1% |
| collector loop | N × ~3.5% (one per launch) | 1 daemon: 0.6% with no launch, 4.6% with 1 launch, 5.0% with 4 |
| per-launch `attach` | — | N × 0.10–0.15% (measured live; polls once a second) |
| `diagnosticd` | one client per launch | one client (not measured) |

Daemon loop, in-process CPU over 15 s with quiet launches and a silent stream:

| Launches | Before review round 1 | After (250 ms checks, inbox on change, idle sleep) |
|---|---|---|
| 0 | 2.10–2.15% | 0.60% |
| 1 | 7.16–8.01% | 4.55% |
| 4 | 7.41–8.11% | 5.02% |

What remains is mostly `proc_listchildpids` at 50 Hz (a kernel process-table
walk; only the first walk per 20 ms tick is expensive, so extra trees add little).
Follow-up, not done: one shared children map per tick for all trees, or a
different sampling cadence (the 20 ms sets how early a short-lived child must be
seen to be attributed, so it is a coverage decision).

## 9. Commands

`ib sandbox-collector attach --dir D --owner PID --agent-log F` (internal, run by
the preamble), `serve [--lock-fd 3]` (internal, the daemon), `status` (running,
pid, launches, heartbeat age, STALE mark), `restart` (replace the daemon, keep
collecting), `stop` (end collection for every running launch).
`ib sandbox-log-watch` is removed; `sandboxStreamExited` and
`closeSandboxLogStream` moved to `src/sandbox-log-stream.ts`.

## 10. Turning collection on

1. Review this design and the code.
2. Set `SANDBOX_DENIAL_COLLECTOR_ENABLED = true`. New spawns and resumes then
   attach; running agents keep their current scripts until resumed.
3. Measure `diagnosticd` and the daemon with the real agent count.

## 11. Cross-cutting checklist (AGENTS.md)

1. **Agent lifecycle** — when enabled, `start.sh`/`resume.sh` run `attach` in the
   supervisor subshell (all CLIs, per-repository coordinators); `meta.json`
   unchanged; `@system` stays unsandboxed with no collector. While the switch is
   false, launch scripts are byte-identical to main.
2. **Hooks** — `sandbox-collector` replaces `sandbox-log-watch` in the
   internal-verb deny list; the sealed-tree floor deny is unchanged.
3. **Watchdog** — not involved: it neither starts nor restarts the daemon.
4. **`ib watch`** — the same `[Sandbox]` and `[SandboxCollector]` records reach
   the DENIALS parser. The top bar shows a "Collector" stoplight left of
   "Telegram" (`src/sandbox-collector-light.ts`): grey = off or idle, green =
   daemon with a fresh heartbeat, yellow = no heartbeat yet, a heartbeat that
   `status` calls STALE (over 5 s), or launches attached with no daemon on one
   probe, red = the same
   on two probes in a row. It probes in process every 5 s (only while the switch
   is on) with non-blocking, immediately released locks; `?` help shows details.

Decisions taken with the recommended defaults (the user may revisit): the daemon
exits when no launch remains (by lock, not a timer); a stuck daemon is reported,
never killed by PID; a report matching two launches is omitted; the per-launch
`sandbox-log-watch` is removed; the owner proof uses the live registrar, not a
socket with peer credentials.

## 12. Validation

**Unit tests** (`src/sandbox-collector.test.ts`, 24 tests, real processes and
real flocks; the stream is a controlled peer, not `/usr/bin/log`):

- Registration validation: accept; reject forged name, outside namespace, other
  launch's directory, redirected `agent.log`, protocol, malformed token, a bare
  PID, another boot, dead registrar, owner or registrar PID reused (other birth),
  non-descendant registrar, sandboxed owner or registrar, mode 0755, symlinked
  directory, symlinked `registration.json`.
- `appendAgentLog`: a symlinked `agent.log` is not followed (victim unchanged); a
  FIFO fails at once with no reader and with a reader, and nothing is written.
  Daemon level: a launch with a FIFO `agent.log` fails alone while another
  launch still gets its `[Sandbox]` record.
- The real `sandbox_check` binding: a reaped PID reads as sandboxed (fails
  closed), and the reader agrees with `isSandboxedProcess()` for the test itself.
- `status`: heartbeat age shown; marked STALE with the `kill -9 <pid>` fix once
  the loop has not run for more than 5 s while the lock is held.
- Locks: role exclusivity and shared client locks; the fd 3 hand-over surviving
  the parent and dying with the daemon but not its children; `serve` refusing a
  locked fd on another file; exit-versus-register (with `daemon.lock` and
  `clients.lock` held exclusively, an `attach` in another process writes
  nothing; after both close, it starts exactly one daemon, with an fd that is
  `daemon.lock`).
- Daemon: two launches routed to their own logs only; a duplicate root refused;
  a root whose parent is not the owner, and a root that is the registrar,
  refused (`failed` + `done`, no `root-ready`); per-launch stop and registrar
  death; staying up while a client lock is held and exiting when it is released;
  a redirected registration rejected with `failed` + `done` and no write to the
  victim log; stale directories (dead and reused registrar) rejected, marked
  `done`, and not re-examined by the next daemon.
- `attach`: a new daemon after a stream failure re-adopting a launch whose
  registrar never noticed; giving up after exactly 4 unanswered starts; the
  start count resetting after EVERY acknowledgement, at first registration and
  after a restart (13 starts: three cycles of two unanswered and one
  acknowledged, then 4; removing either reset gives 4 or 7, checked by
  mutation); a registered attach returning when a daemon that holds the role
  rejects its launch (ERROR logged, owner alive); a still-registering attach
  whose owner is gone when the rejection appears ending quietly (0, no ERROR;
  the attach is frozen so its next check sees both, and the old check order
  fails it); a successor's re-adopt scan
  rejecting a launch whose owner just exited, with that launch's attach (in its
  own process, frozen across the replacement so it cannot win the freed lock)
  returning once the successor holds the role, and the successor exiting after
  the other launch ends (both fail without the fix, every run, checked by
  mutation); `stop` (every launch `done`,
  every attach returns, role freed);
  `restart` (no `done`, a new daemon re-adopts both launches); SIGTERM to a
  daemon running as a separate process (same as `restart`, through the real fd 3
  hand-over).

**Live** (2026-10-06, compiled build via a `PATH` shim, the real preamble and gate
with the `enabled` override, real `sandbox-exec` with the `_all.md` floor plus a
disposable deny, real `log stream` and `logger`; two concurrent launches A and B):

| Check | Result |
|---|---|
| Processes | 1 daemon, 1 `log stream --level default`, 1 helper, 2 `attach`; never a second daemon |
| Denied read + write by each root | attributed to the right launch only (pid, birth, target, launch) |
| Forged inbox write from inside the sandbox | EPERM; recorded as a `[Sandbox]` denial in that launch's log; no inbox entry |
| Daemon SIGKILL | old stream gone; one new daemon; both launches resumed (A by re-adoption only); a later denial by A attributed |
| `log stream` SIGKILL | ERROR in both logs; new daemon; both resumed; a later denial by B attributed |
| CLI exit | `collector stopped` in both logs; launch directories removed |
| Daemon exit | 0.2 s after the last launch ended; no stream, helper, heartbeat or process left |
| CPU (30 s, two quiet launches, noisy host) | daemon 7.07%, `log stream` 8.63% (standalone at the same time: 8.56%), helper 0.13%, each `attach` 0.43–0.47% |

**Live re-check after review round 1** (same harness, new build): `registration.json`
carries `boot` and the owner and registrar as PID + birth; `status` showed the pid,
launch count and heartbeat age; both launches' denied reads and writes were
attributed; `ib sandbox-collector restart` through the real binary left both
launches to a new daemon that re-adopted them within 0.7 s (no `done`); a daemon
SIGKILL recovered within 1.1 s; later denials were attributed after both; the
daemon exited once both launches ended and nothing was left. CPU over 20 s with
two quiet launches: daemon 5.30%, `log stream` 6.55%, each `attach` 0.10–0.15%.

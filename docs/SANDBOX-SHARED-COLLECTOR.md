# Shared sandbox denial collector — design proposal

Status: **proposal for review, not implemented** (2026-10-06, worker
`log-level-default`). Denial collection is currently turned off by the gate that
the `disable-denial-collector` agent adds to `src/sandbox-log-launch.ts`. This
document plans how to turn it back on with ONE `log stream` for all sandboxed
agents, instead of one per launch.

Background: `docs/SANDBOX-ROLLOUT.md` (current collector),
`docs/sandbox-denial-probe-evidence.md` (live evidence, §13 for CPU),
`docs/sandbox-denial-review.md` (review findings).

## 1. Why

Today every sandboxed launch (spawn or resume) runs its own chain:
`ib sandbox-log-watch` (Bun) → `ib sandbox-log-stream` (Bun helper) →
`/usr/bin/log stream`. Each `log` process is a separate `diagnosticd` client, and
`diagnosticd` evaluates the predicate and copies every matching event once per
client. The cost grows linearly with the number of agents (N).

Measured on this host (evidence §13), one launch at `--level default`:

| Process | CPU (one core = 100%) |
|---|---|
| `log stream` | 1.67–1.75% (was 15.0% at `--level debug`) |
| collector (Bun, 20 ms loop, two-process tree) | 3.50% |
| stream helper (Bun) | 0.07% |
| `diagnosticd` share | not measured (shared daemon; see §8) |

After the level change the collector's own Bun loop costs more than its `log`
process. A shared design removes N−1 of both.

## 2. Topology

```
per launch (unsandboxed start.sh / resume.sh)     one per user (unsandboxed)
------------------------------------------        ----------------------------------------
preamble: mktemp launch dir, open fd 9 `stop`     ib sandbox-collector serve
ib sandbox-collector register  --(sealed files)-->  |- ib sandbox-log-stream   (existing helper,
  (waits for `ready`)                               |    |                      lifeline pipe)
background supervisor (waits for `done`)            |    '- /usr/bin/log stream --level default  (ONE)
gate: root-request -> waits root-ready              |- per-launch state: attribution, budget, agent.log
exec sandbox-exec ... CLI   (unchanged)             '- 20 ms loop: inbox, tree sampling, attribution
```

- **One daemon per user** (per `$HOME`): `ib sandbox-collector serve`. It runs
  outside Seatbelt, in its own session (detached, `setsid`), with `cwd` = `/`,
  stdin/stdout from `/dev/null`, stderr to its own log, and a scrubbed
  environment (no `AGENT_LOG`, no `IB_SANDBOX_*`, fd 9 closed). It is not a child
  of a tmux pane, `ib watch` or a watchdog, so none of them can stop it.
- **The stream helper does not change.** The daemon is the only writer of the
  helper's lifeline pipe. When the daemon dies for any reason, the helper reads
  EOF and ends its process group, as it does today (no saved-PID signals).
- **Static predicate.** The predicate is today's predicate with one marker
  prefix: `… OR (eventMessage CONTAINS "IBSandboxReady-<nonce>")`, where
  `<nonce>` is 128 random bits made at daemon start. Per-registration markers are
  `IBSandboxReady-<nonce>-<launch>`, so the same clause matches them and the
  stream never needs a restart to add a launch.

**Daemon state directory**, `~/.itsybitsy/sealed/sandbox-collector/` (mode 0700):

| Entry | Purpose |
|---|---|
| `lock` | single-instance lock: `flock(LOCK_EX \| LOCK_NB)` through `bun:ffi`, on an fd held for the daemon's life. The kernel releases it on every kind of exit, including SIGKILL, so there is no stale-lock or PID logic. |
| `inbox/<launch>` | one registration request per launch (written by temp file + rename). Content: the absolute launch directory path. |
| `heartbeat` | rewritten every second: `{v, nonce, pid, startedAt, streamWarm, activeLaunches}`. |
| `collector.log` | the daemon's own diagnostics (size-capped). |
| `stop` | written by `ib sandbox-collector stop` (unsandboxed) to end the daemon. |

**Per-launch artifacts stay where they are**:
`~/.itsybitsy/sealed/sandbox-logs/<sha256(agentDir)>/sandbox-log.XXXXXXXX/`
with `stop` (fd 9), `root-request`, `root-ready`, `ready`, `failed`, plus a new
`registration.json` and `done`. The launch's shell supervisor stays the ONLY
process that removes that directory.

## 3. Registration and trust model

**Threats** from a sandboxed agent or any of its descendants: (a) forge a
registration so that denials or text go to a log it chooses; (b) redirect an
existing registration to another `agent.log`; (c) fake readiness or hide its own
denials; (d) stop, take over or impersonate the daemon.

**Trust boundary: the sealed tree.** The shipped floor (`_all.md` `paths.deny`)
denies `~/.itsybitsy/sealed` to every sandboxed agent, and deny wins over every
allow layer. So only unsandboxed processes of the user can create anything under
`sealed/sandbox-collector/` or `sealed/sandbox-logs/`. The per-launch design
already relies on this boundary for its control files. A sandboxed process also
cannot run `log stream` at all (`Cannot run while sandboxed`, exit 64), so it
cannot act as a daemon even if it took no lock.

**Rules the daemon checks for every inbox entry** (any failure: delete the entry,
write the reason to `collector.log` only, because an unverified entry's
`agent.log` path is not trusted):

1. **Shape.** Entry name matches `^sandbox-log\.[a-zA-Z0-9]+$`. Its content is
   an absolute path whose parent is `sealed/sandbox-logs/<64 hex>` and whose
   basename is the entry name. `lstat` shows a real directory (not a symlink),
   owned by our uid, mode 0700. Files inside are opened with `O_NOFOLLOW`.
2. **Log binding (unchanged rule).** `registration.json` holds
   `{v, agentLog, owner, registrar}`. The daemon requires
   `sandboxLogParent(dirname(agentLog)) === dirname(launchDir)`: a launch
   directory can only name the `agent.log` of the agent directory whose hash
   names its namespace. This stops (b) even between unsandboxed writers.
3. **Owner proof (replaces "owner is my ancestor").** Today the collector is a
   child of the launch script and proves the owner is its ancestor. The daemon
   cannot. Instead the launch script runs `ib sandbox-collector register` as a
   direct foreground child, and that registrar stays alive until it gets an
   answer. The daemon requires: the registrar (pid + birth from
   `registration.json`) is alive with that exact birth; `registrar.ppid ===
   owner`; and the kernel says both are unsandboxed (`sandbox_check(pid, NULL,
   0) == 0`: the call `isSandboxedProcess` in `src/sandbox-detect.ts` makes for
   its own pid, extended to take a pid; that it works on another process of the
   same user must be verified live). The owner's pid + birth are
   then fixed for the launch; any later change of identity ends the launch, as
   today. A stale directory from a dead launch has no live registrar, so it is
   never adopted.
4. **Root acknowledgement (the handshake, new meaning).** The gate is still
   unsandboxed when it writes `root-request` (its own `$$`, by rename). The daemon
   requires `root.ppid === owner`, a root identity that no other launch has
   registered, and a root that is not the daemon or one of its children. Then it
   seeds that launch's attribution with the root and writes `root-ready`.
   `root-ready` now means: **the shared collector acknowledged this root and is
   sampling its tree**. The gate keeps its 2 s limit, and on timeout it still
   writes the ERROR line and execs the mandatory wrapper.
5. **No channel from inside the sandbox.** No socket and no writable path reach
   the daemon. Per-launch stop stays the fd 9 `stop` file. A daemon-wide stop is
   only `ib sandbox-collector stop` from an unsandboxed shell. The hooks add
   `sandbox-collector` to `containsInternalIbInvocation`
   (`src/hooks/agent-path.ts`) as defense in depth.
6. **Readiness spoofing.** A marker counts only with `processImagePath ===
   "/usr/bin/logger"` and the daemon's secret nonce, which lives only under
   `sealed/`. A successful spoof could only fake "ready", which reduces
   diagnostic coverage and never weakens enforcement — the same limit as today.

**Residual (unchanged from today).** Unsandboxed processes of the same user (the
user, the `@system` coordinator, agents with `sandbox: false`) can write the
sealed tree and could forge a registration. They can already write any
`agent.log` directly, so this is not a new exposure.

## 4. Attribution

The algorithm does not change. Only the number of instances in one process
changes.

- Per launch: one `SandboxAttribution` (root pid + birth, observed descendant
  intervals, `mach_continuous_time` brackets, 4,096 instances, 30 s history),
  `sampleSandboxTree` every 20 ms, one `SandboxOutputBudget` (60 per minute, 3
  per process/operation/target), and `formatSandboxRecord` with that launch's
  name. `src/sandbox-denials.ts`, `src/sandbox-process-tree.ts` and
  `src/sandbox-processes.ts` are reused as they are.
- One process reader and one pending queue (512 reports, 500 ms). Each report is
  parsed once (today: once per collector) and offered to every active launch's
  `attribute()`:
  - exactly one launch matches → write to that launch's `agent.log`;
  - none matches → keep for up to 500 ms, then drop (as today);
  - two or more match → omit it and count it as ambiguous. A process instance
    can be in two trees only if one registered root descends from another,
    which normal launches do not do. Omitting keeps the rule "never guess".
- Before its root registers, a launch is not a candidate (today its collector
  drops every report before registration).
- The 60-second `WARNING` summaries stay per launch. Queue overflow cannot be
  attributed to a launch, so its WARNING goes to every active launch.

## 5. Startup and readiness

Launch preamble (replaces today's per-launch collector subshell; the gate is
unchanged):

1. Create the launch directory and open fd 9 on `stop` — as today.
2. Run `ib sandbox-collector register --dir D --owner $$ --agent-log "$AGENT_LOG"`
   in the foreground, limited to 5 s:
   - write `D/registration.json`, then `inbox/<launch>`;
   - if `lock` is free, start `ib sandbox-collector serve` detached. The first
     launcher starts the daemon; the others only register;
   - wait for `D/ready`. The daemon writes `ready` only after it has verified
     the entry (§3) AND observed a NEW marker `IBSandboxReady-<nonce>-<launch>`
     that it emitted with `logger` for this registration. This keeps today's
     guarantee: the stream was live and warm after this launch registered and
     before its CLI starts;
   - if the daemon exits before it answers (crash or idle-exit race), start it
     again, within the same 5 s.
3. Background supervisor (`trap '' HUP`, as today): wait for `D/done` or
   "daemon down" (lock free, or heartbeat older than 10 s). On daemon down,
   append `[SandboxCollector] ERROR: launch=… shared collector stopped; kernel
   enforcement remains required`, touch `failed`, and run `register` again to
   restart and re-adopt (§6). When the launch has ended, remove D.
4. Gate: unchanged (`root-request` → `root-ready`, 2 s, then exec the mandatory
   wrapper in all cases).

If `register` fails, the preamble writes today's ERROR (`collector unavailable
before CLI launch`) and the launch continues under the mandatory wrapper.

**Idle exit.** With no active launch for 60 s, the daemon exits, so no `log`
process runs while no sandboxed agent runs. To close the race with a new
registration, the daemon re-reads `inbox/` after it decides to exit and cancels
the exit if the inbox is not empty; `register` restarts the daemon if the lock
becomes free before its entry is answered.

## 6. Failure handling

Kernel enforcement never depends on the collector: the gate always execs the
mandatory `sandbox-exec` wrapper. Every failure below is diagnostic only and is
made visible in `agent.log` (and so in DENIALS).

| Failure | Behaviour |
|---|---|
| Daemon not running at launch | `register` starts it. No answer in 5 s → ERROR line; the gate skips registration; the CLI runs under the wrapper. |
| `log stream` exits or is signalled | Daemon writes a WARNING to every active `agent.log` (reports missing from T1), restarts the helper with backoff (1, 2, 4 … 30 s), proves the new stream warm with a marker, then writes the end of the gap (T2). After 5 failures in 5 minutes: ERROR to every active log, and the daemon exits 1. |
| Daemon crash or SIGKILL | The kernel releases `lock`; the helper reads lifeline EOF and ends the stream. Each launch supervisor sees the lock free within about 1 s, writes an ERROR line and runs `register`; the first one restarts the daemon. The new daemon re-adopts every launch directory whose owner and root are still alive and still pass §3 (root still a child of the owner). It re-walks each tree from the root, so live descendants are found again; only orphans re-parented while the daemon was down are lost. It writes `WARNING: collector restarted; coverage gap T1–T2`. |
| Daemon alive but stuck (no ticks) | Heartbeat older than 10 s → each supervisor writes an ERROR once. Nothing kills it by PID (keeps today's rule). Manual fix: `ib sandbox-collector restart` from an unsandboxed shell. Documented limit. |
| One launch's `agent.log` cannot be written (nuked) | Drop that launch only. |
| One tree exceeds the 4,096-process capacity | ERROR to that launch, drop that launch only. (Today that collector exits.) |
| `ib` rebuilt while the daemon runs | The daemon keeps its old binary until idle exit or restart. `registration.json` carries a protocol version `v`; an unknown version is refused with a visible ERROR. |

**Blast radius.** One daemon failure now affects every agent at the same time
(today: one launch). Restart plus re-adopt limits the gap; enforcement is not
affected.

## 7. Cleanup

- **Per launch** (as today): owner gone, `stop` written (fd 9 EXIT trap), or root
  gone → 1 s drain → `collector stopped` INFO → daemon writes `done` → the
  supervisor removes the directory. The WARNING for "stop before the registered
  CLI exits" stays.
- **Daemon**: idle exit (§5) closes the lifeline, so the helper and `log stream`
  end with it.
- **`ib state --cleanup`** (optional follow-up): report, without deleting, a
  stale heartbeat with no lock holder and launch directories with no live owner.

## 8. CPU expectations

| N sandboxed agents | Today, `--level debug` | Per launch, `--level default` (this branch) | Shared, `--level default` |
|---|---|---|---|
| `log` processes | N × ~15–27% | N × ~1.75% | 1 × ~1.75% |
| collector Bun processes | N × ~3.5% (+ helper) | N × ~3.5% (+ helper) | 1 loop; sampling work ∝ total processes in all trees |
| `diagnosticd` | ~113–150% with 7–10 clients | not measured (expected lower: Info/Debug no longer routed) | one client |

With 10 agents: about 1.75% + one daemon loop, instead of about 10 × (1.75% +
3.5%) after the level change, or about 3–4 cores before it. The sampling work
for each tree stays, but the 20 ms wake-ups, the runtime overhead and the JSON
parsing happen once instead of N times. `diagnosticd` will be measured by the
manager after deployment; the shared design should be measured the same way
before it ships.

## 9. Turning collection back on (behind the gate)

The gate from `disable-denial-collector` stays the one switch.

1. Add `ib sandbox-collector serve | register | status | stop | restart`
   (new `src/sandbox-collector.ts`), reusing the attribution, process-tree,
   process-reader and stream-helper modules without changes.
2. When the gate is on, `sandboxDenialScriptPreamble` emits the §5 preamble.
   `sandboxDenialExecPrefix` does not change (same handshake files).
3. Remove `ib sandbox-log-watch` once the shared path passes live validation
   (open question 4).
4. Hooks: add `sandbox-collector` to the internal-verb deny list.
5. Live validation with the §13 harness: two or more concurrent launches through
   one daemon with no cross-attribution; daemon SIGKILL then restart and
   re-adopt; stream SIGKILL; idle exit racing a new registration; a forged
   registration from inside a sandbox (expect EPERM on the sealed path); CPU of
   the daemon, `log` and `diagnosticd` with ten agents.
6. Turn the gate on.

## 10. Cross-cutting checklist (AGENTS.md)

1. **Agent lifecycle** — `start.sh` / `resume.sh` preamble changes for all CLIs
   and per-repository coordinators; `meta.json` does not change; `@system` stays
   unsandboxed with no collector.
2. **Hooks** — one new internal verb on the deny list; the sealed-tree floor
   deny does not change.
3. **Watchdog** — not involved, by design: collection stays independent of the
   watchdog, which neither starts nor restarts the daemon.
4. **`ib watch`** — no change: the same `[Sandbox]` and `[SandboxCollector]`
   records reach the DENIALS parser.

## 11. Open questions for the user

1. **Daemon life**: idle exit after 60 s (recommended), or keep it running?
2. **Stuck daemon**: accept a visible ERROR plus manual `restart` (recommended),
   or allow a kill path?
3. **Report matching two launches**: omit (recommended), or write to every
   matching log (what two separate collectors do today)?
4. **`sandbox-log-watch`**: delete it when the shared collector ships
   (recommended: one path to review), or keep it as a fallback for a release?
5. **Owner proof**: is the registrar check in §3 rule 3 enough, or do you want a
   Unix-socket registration with kernel peer credentials (`LOCAL_PEERPID`)?
   That is stronger, but it adds a socket and FFI work, and it protects only
   against unsandboxed writers, which are already trusted.

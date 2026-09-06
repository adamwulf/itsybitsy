# Kernel denial collection review ledger

Round 1 reviewed `a28e0ddc4df71b801b3903b5ce4cf8161e6bcb31`, rebased onto
`main` at `eb5bfa0`. Adam explicitly authorized two researcher reviewers after
the earlier single-worker live investigation. Both requested changes. The
primary Codex agent implemented the fixes; neither reviewer edited production
source or spawned another agent. Both round-one reviewers were retired.

## Round-one dispositions

| Finding | Disposition in the next candidate |
| --- | --- |
| Executable name can forge an earlier PID delimiter | Enumerate every feasible delimiter within the kernel name limit and omit ambiguous reports with a bounded warning count. Tests include the live forged name and a tracked victim. Name equality alone is insufficient and is not used as identity. |
| Agent-writable control files permit silent stop or forged registration | Allocate under the already-denied sealed tree from the unsandboxed script. Clear control environment and close fd 9 before CLI exec. Reject collector ancestors as roots. Warn when stopping before the root exits. |
| Pane leader exit sends HUP to the stream during drain | Stream helper owns a detached session and process group; its stream remains in that group. A real pseudo-terminal regression exercises leader exit. |
| Collector crash orphans stream and leaves artifacts | Collector holds the sole lifeline writer. Helper handles EOF or TERM by signalling its own group, with a one-second grace period. Supervisor alone removes its reserved launch directory after collector return. Tests use real signals and a controlled stream peer. Later host validation confirmed lifeline cleanup after collector SIGKILL for the compiled helper and real log stream. |
| Unsafe suggested shell cleanup using saved child PID | Rejected after reviewer reproduced asynchronous reaping in sh, bash and Bun. No saved PID or pgid cleanup is introduced. |
| Late old EXIT may touch a reused pathname | Script and collector pin the stop inode with open descriptors. Forced pathname-reuse regression confirms the replacement stop file is unchanged. |
| Root request open/write race | Gate writes a temporary file and atomically renames it before registration. |
| Reader pumps can hang after helper crash | Close/cancel both output readers explicitly after helper exit. Regression leaves a controlled grandchild holding both pipes and verifies pending reads finish. |
| Mixed status timestamp/launch labels | Collector and supervisor status use UTC ISO timestamps and launch basename. Original kernel timestamps remain verbatim; historical hook timestamps remain unchanged. |
| Collector errors counted as denials | DENIALS header counts collector alerts separately; rows still share the existing list. |
| Log directory removed while reporting failure | Status append falls back to stderr instead of throwing again in the error handler. |
| FIFO history eviction discards live root first | Evict oldest observed entries first, protect root from capacity eviction, and maintain a PID index for event lookups. |
| Repeated child reads per sampling tick | Reuse the just-read observation for newly discovered children. |

## Diagnostic limits retained deliberately

This is a best-effort diagnostic, not a complete audit. The following safe-direction
coverage losses are documented instead of adding guesses or broader tracking:

- Darwin `proc_listchildpids` returns zero both for no children and some errors;
  the API cannot distinguish those outcomes. Negative/oversized results fail visibly.
- A child whose wall-clock birth precedes its parent after a backward clock step
  is conservatively omitted. Events outside verified continuous-time intervals,
  unsafe-integer event ticks, and unobserved short-lived children are omitted.
- Identical reports with the same boot, event tick and text deduplicate, even if
  the OS emitted two distinct identical attempts within one tick.
- `System Policy: deny(...)`, sandboxd multiline reports, malformed or unsupported
  sources, and OS-coalesced summaries are not attributed. Kernel names are the
  unsanitized `p_name` (up to 32 bytes), not necessarily the 16-byte `comm` or
  requested executable spelling. Ambiguous delimiter splits are dropped.
- Each launch owns a separate system-log subscription. Resource scaling and
  readiness latency under many simultaneous agents remain unmeasured. The
  three-second marker budget, five-second preamble budget, and two-second gate
  budget trade launch delay for visible collection failure. A late readiness
  signal after the preamble timeout does not turn that failed launch into a pass.
- Global `@system` and Linux collection are outside this macOS repository-agent
  phase. Per-repository coordinators use ordinary lifecycle generation.

The helper verifies its live session and group identity before any group signal.
Its stream inherits the same group and only stdio; marker children must not inherit
the collector lifeline. Tests verify that property on the installed Bun runtime.
The collector closes the lifeline first, waits two seconds, then uses the owned
Bun subprocess handle as a bounded fallback. The primary mechanism uses kernel
pipe ownership and live group membership; it does not depend on a saved PID.

A SIGKILL/crash of the minimal helper itself remains exceptional: the collector
reports its death and closes both readers, but its stream can survive until its
next write receives EPIPE. That natural lifetime is not measured. Killing or
wedging the supervisor can leave its reserved directory beneath
`~/.itsybitsy/sealed/sandbox-logs/<agent-directory-hash>/`; current `ib state`
cleanup does not sweep that location. These limitations are explicit and are
not an acceptance or deployment decision.

## Evidence separation

Historical real kernel evidence is preserved in `sandbox-denial-probe-evidence.md`
and its sanitized temporary bundle. Those minimized fixtures had no controlling
terminal and killed the observed collector-crash orphan promptly, so they did
not test the HUP path or natural orphan lifetime. The revised tests exercise real
Darwin processes, pipes, signals, and a pseudo-terminal with a controlled stream
peer. Parser/attribution tests use synthetic reports and observations; generation
tests use fixtures. None of these tests substitutes for fresh host kernel-denial
capture on the revised candidate. Full model CLI/proxy sessions and actual PID
reuse have not been exercised live.

Cross-cutting review: ordinary launch/resume keeps CLI PID through gate exec;
hook policy and hook denial format remain unchanged; watchdog has no collector
dependency; DENIALS renders both kernel records and visibly labelled alerts.
Attachment staging and archived system-coordinator work are untouched.

## Round 2: 5fb75172c48c169e279f1a9652b14324c9919c89

Researchers agent-9907e073 (attribution) and agent-7ceddb24 (lifecycle) independently reviewed this candidate. Attribution approved with a test-flake recommendation; lifecycle requested an earlier main-shell SIGHUP trap. Both were blocked by their PreToolUse allowlists from executing sandbox-exec and system log commands. Their checks did not establish fresh kernel capture or enforcement.

The next revision moves the HUP trap before collector startup/readiness, with a signal-during-readiness test. Fixture path markers now use atomic rename, closing the demonstrated empty-read race. The sampling tick seeds from the already-read root, so a redundant transient read cannot permanently lose it. Further self-review established that parent PID reuse between reading a parent and enumerating its children can falsely establish ancestry even without a clock step. New child edges now require the same parent birth identity observed after all child reads, with continuous-time ordering checks; null or changed parent identity drops those edges. Tests cover ordinary-clock reuse, clock steps, root recovery and already-verified reparenting. Native scratch buffers are reused synchronously; returned observations and PID lists are copied.

Coverage clarifications: descendants reparented before their first observation, including long-lived double-fork daemons, may remain permanently untracked. An adversarial executable name can force ambiguous-report omission; it cannot select a victim identity, and omission is counted in the bounded WARNING summary. Empty per-agent hash parent directories persist even after normal cleanup. Removing them opportunistically would race another launch between mkdir and mktemp; sweeping deleted-agent namespaces is deferred. Raw shell job-termination notices remain in agent.log as diagnostics alongside formatted ERROR records; DENIALS excludes the raw lines.

Reviewer measurements used a synthetic stream peer: readiness was roughly 0.55–0.64 seconds warm and 1.97 seconds cold; collector RSS about 46.9 MB plus a 32.4 MB Bun peer. These are fixture measurements, not production log-stream latency or resource scaling. The lifecycle reviewer exercised the compiled collector and real shared preamble/gate with synthetic NDJSON and an exec wrapper replacing Seatbelt, including HUP, pty teardown and failure cleanup. Preserved evidence is /private/tmp/ib-denial-review2-evidence-agent-7ceddb24/ and explicitly labelled mocked report/stream coverage. The attribution reviewer checked the native ABI on its own process tree, replayed historical real reports, fuzzed 300,000 parser messages with zero wrong parses, and modelled 40,000 reports with zero wrong-instance/non-descendant assignments. Those offline models did not cover the newly identified intra-tick ancestry interleaving; the next review must include it.

## Round 3: 1197f65b868e2e14b3892b0cbd337464a439dd57

Researchers `agent-9907e073` and `agent-7ceddb24` independently approved the
production-source tip `1197f65b868e2e14b3892b0cbd337464a439dd57`. No reviewer
edited production source, installed binaries, changed live agent types, or
touched archived system-coordinator work.

Round-three changes reviewed:

- The shared denial preamble now installs `trap '' HUP` before collector startup
  and readiness waiting. The later per-generator trap remains harmless.
- Fixture path publication uses atomic rename, closing the demonstrated empty
  marker read.
- Native process buffers are reused synchronously, with observations and child
  PID lists copied before the next FFI call.
- `sampleSandboxTree` admits a new parent-child edge only when the same parent
  PID/birth identity is observed after all child reads and each read is ordered
  inside the continuous-time window. A null or changed parent drops those new
  edges while retaining the parent's first observation.

The attribution reviewer replayed the intra-tick PID-reuse model that had
reproduced non-descendant attributions with the old sampler. The current sampler
produced zero wrong-instance and zero non-descendant attributions in both the
baseline and stress model runs; the old sampler still failed in the same harness.
The same reviewer reran parser fuzzing, attribution modelling, native ABI checks,
historical real-report replay, scoped tests, TypeScript, and a scratch build.

The lifecycle reviewer reran scoped lifecycle/UI tests, ib-commands/index/agents
tests, TypeScript, and a scratch compiled build. Using a mocked stream peer with
the compiled candidate and the real shared preamble/gate text, it rechecked the
HUP-readiness case that failed round two, plus success coverage for root and
descendant records, ambiguous-name omission, fd/control-environment clearing,
and cleanup. Those checks were not fresh kernel capture.

## Live host validation: 2026-09-06

After reviewer approval, `agent-7ceddb24` ran a staged host probe from an
authorized Claude context on Darwin 25.6.0. The candidate binary was rebuilt from
`1197f65b868e2e14b3892b0cbd337464a439dd57` and matched the prior scratch build
hash `72c56381096603c5055b1420d002bdf1892ef7fd2d3ce6db64e361eac1f21534`. The
probe used a temporary HOME, a generated Seatbelt floor profile with one
disposable explicit deny path, the real shared preamble and gate text, the
compiled collector/helper, real `/usr/bin/sandbox-exec`, real
`/usr/bin/log stream`, and real `/usr/bin/logger`. It did not run model CLIs, the real proxy,
tmux, dashboard, watchdog, concurrent launches, same-directory overlap, pty
teardown, HUP regression, root self-kill, or owner kill.

Capability passed all eight checks: Seatbelt applied, the generated profile
booted `/usr/bin/true`, a disposable in-process forbidden read returned EPERM,
AGENTDIR read remained allowed, the logger marker emitted, bounded real
`log stream` and `log show` both delivered parsed `/usr/bin/logger` NDJSON marker
events, and `pgrep` observation worked. Predicate-echo events from `/usr/bin/log`
were ignored.

Baseline live capture produced eight real `[Sandbox]` records: root in-process
read/write, root sealed-control tamper on `stop`, `root-request`, `ready`, and
`identity.json`, plus observable-descendant read/write. The records preserved
kernel timestamps, operation, launch, boot, PID, birth identity, and targets.
Real `parseDenials` accepted all eight; a manager-side render through
`RightPaneComponent` in DENIALS mode displayed `8 denial(s)`. No collector alerts
were present, the launch directory was removed, helper and log stream were gone,
fd 9/control variables did not leak, and proxy cleanup ran.

Collector-crash live validation used the probe as a labelled harness supervisor
with an owned collector handle. The compiled collector became ready, the gate
registered the CLI root, helper plus real log stream were present, and killing
the collector with the owned handle produced SIGKILL. The real helper and real
`log stream` exited through the lifeline EOF within 26 ms without any looked-up
PID signal. The harness-labelled `[SandboxCollector] ERROR` was visible and
parsed. Fresh in-process read/write attempts released only after that visible
failure still returned EPERM and did not create the write target; they were not
captured because collection had ended visibly. The manager rendered the captured
crash log through `RightPaneComponent` as `8 denial(s), 1 collector alert(s)`.

The baseline and collector-crash phases were marked failed by the probe's strict
counter only because an optional external `/usr/bin/python3` offender resolved to
the Xcode `xcrun` shim and failed loading `libxcrun.dylib` from `/Applications`
before attempting the disposable forbidden read. The mandatory root, descendant,
sealed-control tamper, parser/display, cleanup, helper-lifeline, and post-failure
enforcement checks passed. Durable evidence is preserved under
`/Users/adamwulf/.claude/projects/-Users-adamwulf-Developer-bun-itsybitsy--ittybitty-agents-agent-7ceddb24-repo/evidence-agent-7ceddb24/`.

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
| Collector crash orphans stream and leaves artifacts | Collector holds the sole lifeline writer. Helper handles EOF or TERM by signalling its own group, with a one-second grace period. Supervisor alone removes its reserved launch directory after collector return. Tests use real signals and a controlled stream peer. Fresh kernel-stream validation is pending. |
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

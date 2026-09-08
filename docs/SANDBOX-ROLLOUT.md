# Staged sandbox rollout

**Configuration update (2026-09-08):** sandboxing now defaults to true and accepts per-type boolean overrides (`sandbox: false` or `sandbox.enabled: false`). The most specific explicit setting wins through layers and inheritance; omission inherits. See [the type guide](agent-types/README.md). Enabled-mode failures still stop launch. Explicit false skips the itsybitsy kernel wrapper, proxy, and kernel-denial collector; hooks continue enforcing paths and native CLI sandbox/approval protections remain active. YOLO / permission-bypass flags are used only with the itsybitsy kernel sandbox enabled, at both spawn and resume. The global `@system` coordinator remains unsandboxed.

The configuration and installation instructions below describe the current default-enabled policy. The later validation ledger records enabled-mode evidence from the earlier rollout; those results do not claim that the new override paths have been installed or live-tested.

## Earlier enabled-mode implementation and validation evidence

The earlier mandatory policy, repository-agent lifecycle, and kernel sandbox-denial
collector are integrated on `agent/sandbox-denial-logs`. The implementation tip
reviewed by two independent researcher agents is
`1197f65b868e2e14b3892b0cbd337464a439dd57`; both reviewers approved that
production-source tip after round-three fixes.

Local validation of that source reported 5,742 bun test passes, zero failures,
29,810 assertions across 120 files, clean TypeScript checking, a successful
147-module compiled build, and a working `ib list-types` smoke. That test total
still includes the two explicitly reported live-test early returns from this
sandboxed Codex environment. It is not an installation or migration result.

Fresh host-side live validation on Darwin 25.6.0 subsequently demonstrated the
collector against the real shared preamble, real gate, generated Seatbelt floor,
compiled collector/helper, real `/usr/bin/sandbox-exec`, and real unified-log
stream. Capability, baseline, and collector-crash phases are recorded below.
The global coordinator launch code is unchanged in this rollout. Neither its
running session nor a newly started `@system` session should be reported as
kernel-sandboxed.

## Configuration contract

- `paths.allowRead`, `paths.allowWrite`, and `paths.deny` remain the authored filesystem rules. Write access includes read access. Denies take precedence.
- `sandbox.rawAllow` and `sandbox.domains` remain configurable. Their lists and the path lists combine through the existing inheritance rules.
- Agent types accept boolean `sandbox: true` / `sandbox: false` or object-form `sandbox.enabled`. The most specific explicit value wins across applicable layers and ancestors. Omission inherits; final resolution defaults true.
- Spawn freezes the resolved boolean in metadata. Resume preserves explicit false and treats omitted enablement as true; enabled policy requires valid frozen paths and sealing. Use operator `ib sandbox refresh` to apply edited type settings in either direction.
- Required runtime paths are added for the worktree, agent bookkeeping, and the selected CLI. The agy state directory is an agy-only runtime root.
- If an enabled policy cannot establish its platform, profile, or proxy, launch fails. Explicit false skips the itsybitsy wrapper and bypass flags while native CLI protections and hooks remain active. The global coordinator remains separately unsandboxed.

## Prepare the existing installation

1. Back up the live agent-type files under `~/.itsybitsy/agent-types` before editing them.
2. Keep intentional enablement overrides, paths, domains, raw rules, and other settings. Add a boolean override only where the inherited/default value should change.
3. Compare the live files with the candidate using `./ib init-types --check`. Reconcile missing entries from `docs/agent-types/_all.md`, preserving intentional type-specific restrictions. The preflight compares path/rule/domain list floors; valid enablement overrides are not errors. A zero exit is required before installation, but does not replace type validation or a live launch test.
4. Run `./ib list-types` and resolve configuration errors. `ib init-types` alone does not update existing customized files.

Preserve customized types when reconciling list floors. A path or domain denial can be addressed in its corresponding policy list; disabling the outer sandbox deliberately switches to native CLI protections plus hooks.

## Validate the candidate pilot

From an environment that permits applying a Seatbelt profile, run:

```sh
bun test
bunx tsc --noEmit
bun run build
./ib list-types
bun test src/sandbox.test.ts --test-name-pattern LIVE
IB_LIVE_BOOT=1 bun test src/sandbox.test.ts --test-name-pattern "LIVE claude boot"
```

Inspect the live test output: a capability skip is not a kernel-enforcement pass. In the initial Codex session even an allow-default profile failed with `sandbox_apply: Operation not permitted`; the Claude worker session applied it successfully.

Test a repository worker launch with the candidate and matching helper binary. Before broad deployment, verify:

- A real model reply travels through the per-agent proxy.
- Normal file and shell tools work within the configured roots.
- A denied read and write are refused by the kernel, including a subprocess operation that does not rely on the advisory hook scanner.
- Hook denials still work, and configured MCP servers start and function under the profile.
- Resume, refresh, respawn, and rehire retain sandbox enforcement and clean up their proxies.
- Each deployed CLI and a per-repository coordinator work under their profiles. The earlier Claude-only boot probe does not prove Codex, fugu, agy, or coordinator integration.

Also exercise explicit false on each deployed CLI: confirm the absence of the itsybitsy wrapper and bypass flags, active native protections and hooks, and successful spawn/resume/rehire. Test refresh in both directions from an unsandboxed operator session. The global coordinator remains outside this stage.

## Install and migrate running agents

Merging source does not replace the installed binary or change a running process. A Seatbelt profile takes effect at launch and is inherited by descendants.

1. Install the reviewed candidate `ib` onto PATH and restart `ib watch` after the configuration preflight and pilot checks. Ensure lifecycle and proxy helpers resolve to the same candidate version.
2. Run `ib sandbox refresh --all` in each registered repository. The command covers the current repository only. It re-derives policy from the current Markdown, updates sealed records as needed, and resumes agents with the refreshed policy. Running agents are paused before policy changes.
3. Handle every reported failure and coordinator skip. Per-repository coordinators use their reset path (`ib resume <coordinator-id>` or dashboard R). Reset can also tear down their children, so schedule it before refreshing those children.
4. Verify each live repository agent was launched by the candidate with its resolved kernel/native protection mode. A new value in Markdown or metadata is not proof that an old process changed.

Restarting the global `@system` coordinator does not sandbox it in this version. Keep that exception visible while observing the repository-agent rollout; global coordinator confinement will require its own reviewed change and migration.

## Failure recovery and limits

Keep the last working binary and configuration backup until rollout is verified. Enabled setup failures never silently disable the sandbox. Correct the reported configuration or deliberately change the type override, then run the supported operator refresh or restart path. Refresh reports transition/rollback failures; retry the documented recovery after resolving the underlying error. Reverting the installed binary restores that version of enforcement.

The hook scanner provides early errors and denial-log entries for recognizable operations. It is not a complete shell parser. The kernel-denial collector adds reports whose process identity and lifetime can be established; absent or unattributable kernel-only events still may not appear in DENIALS.

Spawning agents retain access to the tmux server for lifecycle operations. This is an existing escape from process confinement: they can ask that server to run commands outside their inherited profile. Kernel wrapping does not close that boundary. Non-spawners have the corresponding socket denied.

The agy runtime root is shared state under the user home. Granting it only to agy avoids extending that access to other CLIs; it does not provide per-agent isolation between agy instances.

## Historical enabled-mode collector validation ledger

**Implemented and reviewed at production-source tip
`1197f65b868e2e14b3892b0cbd337464a439dd57`; live host validation completed for
the staged capability, baseline, and collector-crash phases.** Adam authorized
two researcher reviewers after the initial live worker completed. Round two
requested an earlier main-shell HUP trap and found a flaky fixture marker;
self-review strengthened ancestry against parent PID reuse within a sampling
tick. Round three approved those fixes. Global system-coordinator sandbox work
remains deferred.

The candidate adds `ib sandbox-log-watch` to the shared repository-agent start
and resume wiring. A launch-specific shell supervisor starts it outside Seatbelt
before the CLI, independently of `ib watch` and the per-agent watchdog. The
collector observes its own unique `logger` marker in the live unified-log stream
before releasing a CLI registration gate. The gate then execs the original
mandatory `sandbox-exec` command, retaining the PID used by lifecycle code.

Attribution uses proc_pidinfo birth identity and independently observed descendant ancestry, with mach_continuous_time observations bracketing each report timestamp. A new parent-child edge requires the same parent PID/birth identity on both sides of the child read; a reused or unavailable parent drops that edge. The collector never extends an observed interval backwards to birth or forwards to estimated exit. Unknown or previously unobserved reparented children, events outside observed intervals, ambiguous reports, and OS duplicate summaries are omitted. Empty live-stream bootUUID uses the independently obtained running boot identity; persisted or replayed records are not consumed. History is capped at 4,096 instances and 30 seconds, pending reports at 512 entries and 500 milliseconds, with 20 ms polling.

Verified reports append `[Sandbox]` entries with the original timestamp,
operation, offender name/PID/birth, target when present, launch, boot, and
monotonic event identity. Output is capped at 60 entries per minute per launch
and 3 per process/operation/target per minute, with a 2,048-event deduplication
cache. Suppression and collector errors use `[SandboxCollector]` records; errors
and warnings also appear in DENIALS alongside unchanged hook denials.

Every invocation allocates a fresh sandbox-log.XXXXXXXX directory beneath \~/.itsybitsy/sealed/sandbox-logs/<agent-directory-hash>/. The shipped floor denies this tree even when AGENTDIR is writable. Creation happens in the unsandboxed script. An initially empty stop file is opened once by both script and collector; the EXIT trap writes through reserved fd 9, so a late EXIT cannot touch a reused pathname. The gate atomically renames its root request, then closes fd 9 and clears control variables before exec. Only the supervisor removes the reserved directory after the collector returns, including collector crashes. Owner or CLI birth-identity disappearance still ends collection with a one-second drain. Stopping while the registered CLI remains alive produces a visible coverage WARNING. Diagnostic failure never removes the mandatory Seatbelt wrapper.

Historical candidate checks before independent review: 5,657 reported bun test passes, zero failures, 29,486 assertions across 115 files; TypeScript, build, CLI table and command-help smoke passed. After rebasing onto main eb5bfa0, candidate a28e0dd reported 5,720 passes, zero failures, 29,723 assertions across 117 files, plus successful TypeScript/build/smoke. Both totals include the kernel capability and opt-in Claude boot early-return skips described below; neither is a live enforcement/capture pass. The authorized live worker tested corrected candidate d198c4d with the actual shared preamble and gate, generated floor, and synthetic sandboxed shells. Those historical fixtures did not run whole production scripts, model CLIs, the proxy, or a controlling terminal. The review fixes changed production source after that live evidence and required the later fresh validation recorded below. Claude, Codex/fugu, agy, and per-repository coordinator generation remains covered by lifecycle tests.

Round-one fixes validated locally: bun test reported 5,736 passes, zero failures, 29,794 assertions across 119 files (111.20 seconds; /private/tmp/sandbox-denial-logs-round1-fixed-full.log). The same two existing live-test early returns remain skips, not live passes. bunx tsc --noEmit passed. The 146-module build passed, and the rebuilt CLI printed list-types plus help for both internal collector commands. New regressions use real Darwin pipes, group signals and a pseudo-terminal with a controlled stream peer; they do not prove revised kernel capture. Direct capability rechecks still fail here: sandbox-exec exits 71 with sandbox_apply: Operation not permitted; log show exits 64 with Cannot run while sandboxed. At that point fresh independent review and host-side capture validation were still pending.

Round-two fixes validated locally: bun test reported 5,742 passes, zero failures, 29,810 assertions across 120 files (111.50 seconds; /private/tmp/sandbox-denial-logs-round2-fixed-full.log), including the same two explicitly reported live-test early returns. TypeScript checking passed. The rebuilt 147-module CLI printed the type table. Scoped sampling/lifecycle/parser tests passed 50 tests. At that point round-three independent review and revised kernel capture were still pending.

Round-three review approved `1197f65b868e2e14b3892b0cbd337464a439dd57`.
Researchers `agent-9907e073` and `agent-7ceddb24` independently approved the
source after checking the HUP-readiness fix, atomic fixture marker, native buffer
reuse, and `sampleSandboxTree` ancestry hardening. `agent-9907e073` modelled
intra-tick PID reuse and showed the old sampler could accept non-descendant
edges while the current sampler produced zero wrong-instance and zero
non-descendant attributions in both baseline and stress runs. `agent-7ceddb24`
exercised the compiled collector with mocked NDJSON and real process/signal/pty
fixtures, including the HUP-readiness case. Neither reviewer's round-three checks
were fresh kernel capture.

Host-side validation on 2026-09-06 ran three live phases against the same
reproducible 1197f65 build (`sha256
72c56381096603c5055b1420d002bdf1892ef7fd2d3ce6db64e361eac1f21534`) from a
Claude researcher context that could apply Seatbelt profiles and read the unified
log. Capability passed all eight checks: allow-default Seatbelt applied, the
generated floor profile booted `/usr/bin/true`, the generated profile refused a
disposable in-process forbidden read with EPERM, AGENTDIR read remained allowed,
`logger` emitted a marker, bounded real `log stream` and `log show` both returned
parsed `/usr/bin/logger` NDJSON marker events, and `pgrep` observation was
available. The log tool's own predicate-echo events were ignored.

The live baseline phase used the real shared preamble and gate, real
`/usr/bin/sandbox-exec`, compiled collector and stream helper, real
`/usr/bin/log stream`, and the generated floor with a disposable deny path. It
captured eight `[Sandbox]` records in `agent.log`: root in-process read/write,
root attempts to write `stop`, `root-request`, and `ready`, root attempt to read
`identity.json`, and observable-descendant read/write. Records preserved kernel
timestamps, operations, launch label, boot id, PID and birth identity. Real
`parseDenials` accepted all eight records, and the manager rendered the captured
log through `RightPaneComponent` in DENIALS mode as `8 denial(s)`. No collector
ERROR/WARNING was present; the launch directory was removed, the helper/log
stream were gone, fd 9/control environment did not leak, and the proxy cleanup
trap ran.

The live collector-crash phase used the probe process as an explicit harness
supervisor with an owned collector handle; the product shell supervisor's
formatted exit-137 path remains covered by the unit suite. The compiled collector
became ready, the gate registered the CLI root, and helper plus real log stream
were present before injection. Killing the collector by the owned handle produced
SIGKILL, and the real helper plus real `log stream` exited via lifeline EOF within
26 ms without signalling a looked-up PID. The harness-labelled
`[SandboxCollector] ERROR` was visible and parsed. Fresh in-process read/write
attempts released only after that visible failure still returned EPERM and did
not create the write target; those post-failure attempts were not captured
because collection had ended visibly. The manager rendered the captured crash log
through `RightPaneComponent` as `8 denial(s), 1 collector alert(s)`.

Both baseline and collector-crash phases were marked failed by the probe's own
strict counter because an optional external `/usr/bin/python3` offender was the
Xcode `xcrun` shim on this host and failed loading
`/Applications/Xcode.app/Contents/Developer/usr/lib/libxcrun.dylib` before it
attempted the disposable forbidden read. The mandatory root, descendant, sealed
control-file tamper, parser, display, cleanup, and post-failure enforcement
checks passed. Deferred live host phases not run: concurrent launches,
same-agent-directory overlap, pty teardown, HUP regression, root self-kill, and
owner kill. Those remain covered by unit tests and earlier mocked-stream
fixtures, not by this fresh kernel run.

Durable host-probe evidence is under
`/Users/adamwulf/.claude/projects/-Users-adamwulf-Developer-bun-itsybitsy--ittybitty-agents-agent-7ceddb24-repo/evidence-agent-7ceddb24/`
with capability, baseline, and collector-crash run directories. The host rebooted
on 2026-09-06 before these runs and cleared earlier `/private/tmp` evidence
bundles and test logs referenced by historical notes; those historical paths may
no longer exist even though their results are preserved in this document, the
review ledger, and the conversation transcript.

The first full run after the native fixes reported 5,653 passes and two failures:
both source-entry smoke tests received an empty type table from their shared
fixed temporary home. All four entry tests passed on an isolated rerun. Those
tests now use a fresh temporary home per case; the subsequent full run reported
5,655 passes with zero failures. No production type-loading behavior changed. The
failed run is retained at `/private/tmp/sandbox-denial-logs-full-test.log`; the
passing run is `/private/tmp/sandbox-denial-logs-full-test-isolated.log`.
After the signal-exit fix, the full run at
`/private/tmp/sandbox-denial-logs-full-test-signal.log` produced the current
passing total above. Shell regression coverage also confirms collector failure
does not prematurely invoke proxy cleanup while the CLI is still alive.

Self-review covers lifecycle (PID survives gate exec; collector also ends on CLI
exit), hooks (existing hook denial format and permissions retained), watchdog
(no collector dependency or changes), and dashboard (kernel/error records load
through the existing DENIALS reader, with source labels and one timestamp).
Shell tests execute isolated supervisor/gate fixtures for startup failure,
runtime failure while the CLI continues, and overlapping old/new cleanup.
Attribution, malformed-report, reuse, bounded-output, and concurrent-launch
tests use synthetic events/observations; they are not substitutes for live OS
evidence. Unknown or unsafe-integer monotonic timestamps are rejected.

The worker's first collector run on `008c233` found two blocking native-adapter
errors: unified-log event ticks use continuous time (including system sleep),
and `proc_listchildpids` returns a PID count, not bytes. Those errors produced
zero attributed denials despite successful readiness and kernel enforcement.
Both were corrected with regression cases from the live observations, then
verified on the corrected compiled candidate as described below.
The same run validated roughly one-second CLI-exit/SIGTERM cleanup and visible
startup failure with kernel enforcement intact. These are partial results,
not acceptance of the broken candidate's attribution.

Live retesting of `f09280f` captured root and observable-descendant denials,
confirmed concurrent launch isolation and staggered cleanup in separate agent
directories, and rendered a
real captured log through the DENIALS component. Immediate children were enforced
but safely omitted. The worker exercised the compiled collector and real gate
helper with a synthetic owner; it did not yet execute the bash preamble verbatim
or real model CLIs. It also found that Bun leaves `exitCode` null after signal
termination: a killed log-stream child silently stopped collection. Both startup
and runtime guards now check `signalCode` too, including during the drain period.
Regression tests terminate actual disposable subprocesses by signal and by exit
code. Live retesting on `d198c4d` confirmed both start and resume preambles
attribute real root reads/writes, concurrent launches stay isolated, and a killed
stream produces an ERROR, collector exit 1, and cleanup. A killed collector
produces a supervisor ERROR (exit 137). Artifact self-review found those fixtures
attempted the denied read/write before injecting failure, so they do not directly
prove post-failure enforcement. The worker reran both cases with fresh read/write
attempts released only after the failure ERROR was visible: both returned EPERM
and the fresh write target was not created. Post-failure enforcement is now
directly measured; post-failure capture is unavailable because collection has
failed. No dashboard or watchdog ran in the fixtures. Same-agent-directory
old/new overlap is covered by the shell regression test; the live concurrent
fixtures used separate agent directories.

**Historical collector-crash finding and current remedy:** SIGKILL of d198c4d left an orphan log stream and residual launch directory. The worker removed its fixture orphan immediately after checking its captured birth identity, so its natural lifetime was never measured. The revised collector owns a detached stream helper through a stdin lifeline pipe. EOF after collector death makes that helper terminate its own live process group, with bounded escalation; it never signals a stored PID or group number. The helper verifies its session/group identity before spawning the stream. Detachment also prevents pane-session SIGHUP from killing the stream during normal drain. Stream failure is relayed to the collector; the supervisor removes only its reserved directory. A helper crash itself remains a separate exceptional limitation: the collector cancels and closes output readers without hanging, but an orphan log stream may persist until a subsequent write receives EPIPE. A wedged or killed supervisor can leave its reserved directory under the sealed tree; existing state cleanup does not sweep it. No numeric-PID reaper is introduced. These limits are not deployment approval. Historical evidence and sanitized artifacts remain in docs/sandbox-denial-probe-evidence.md and /tmp/ib-denial-probe-evidence-agent-9685061d/final-collector/. The six evidence commits were merged additively and the worker closed. Round-one reviewer findings and dispositions are recorded in docs/sandbox-denial-review.md.

### Capability investigation (2026-09-05)

The initial denial-logging increment was blocked at the live capability probe.
This Codex session's PreToolUse hook initially rejected both commands before execution
with `Tool not in allow list`:

```sh
/usr/bin/sandbox-exec -p '(version 1) (allow default)' /usr/bin/true
/usr/bin/log help stream
```

Adam subsequently granted both command permissions. Retrying reached macOS and
established two OS-level capability failures:

- `sandbox-exec` exited **71**: `sandbox-exec: sandbox_apply: Operation not permitted`.
- `log help stream` exited **64**: `log: Cannot run while sandboxed`.

The host-side probe's `--run` mode also failed honestly with exit **1** after its
`log stream` process exited **64** with the same error. It saved empty raw event
output and the exact stderr/exit result; no sandbox fixture commands ran because
the stream was unavailable. The artifact directory for this attempt is
`/private/var/folders/n3/nm2j2qb55ss7ystx9_vps3lw0000gn/T/ib-denial-probe-fVuqx1`.

Command authorization is no longer the blocker; this execution environment
cannot apply even an allow-default Seatbelt profile or read the unified log.
At that point no event fields, readiness behavior, or safe process-attribution
method had been established. A context permitting both operations was required;
no bypass was attempted. Adam subsequently authorized one worker specifically for live
testing, with implementation and self-review remaining in this Codex session.
That worker subsequently established real read/write reporting; see its evidence
report when integrated. The production candidate still requires live acceptance
with its actual collector and launch gate.

`scripts/probe-sandbox-denials.ts` prepares an isolated temporary fixture using
the current profile generator and shipped `_all.md` floor, with an explicit deny
for disposable read/write targets. Preparation alone executes neither restricted
command. On an authorized macOS host, run:

```sh
bun scripts/probe-sandbox-denials.ts --run
```

The probe starts an independent `log stream`, then exercises the allow-default
capability check, generated-profile boot, immediate denied read, and short-lived
read/write subprocesses. It retains raw NDJSON, stderr, command arguments,
timestamps and observed PIDs in the printed temporary directory. Each captured
stream is capped at 8 MiB with truncation recorded, and collection continues for
ten seconds after the commands finish. It does not install binaries, change agent
types, or require a dashboard/watchdog. Inspect results before sharing: the raw
log predicate can include unrelated system sandbox reports.

This diagnostic script is not the production collector or an automated pass.
Its two-second startup delay is not a readiness guarantee; PIDs are observations, not sufficient
attribution evidence. Inspect errors for missing privileges/profile application
failure and compare actual reports to fixture targets. Determine whether the OS
provides offender birth/audit identity and ancestry distinct from the reporting
process before choosing an attribution mechanism. PID sampling alone cannot
safely resolve delayed reports, PID reuse, or children that exit between samples.
Missing/private fields and dropped or unreported events must remain explicit
limitations. Additional startup-delay and concurrent-launch experiments, plus
real lifecycle/dashboard acceptance checks, remain outstanding.

Local validation of the probe preparation: preparation-only execution passed;
`bunx tsc --noEmit` passed; the scoped non-live sandbox suite passed 98 tests
(2 filtered); the repository-wide non-live suite passed 5,600 tests (11 filtered,
0 failures) using `bun test --test-name-pattern '^(?!.*LIVE)'`. After command
permissions were granted, unfiltered `bun test` exited zero: 5,611 reported passes,
0 failures, 29,376 assertions across 111 files. That total includes two tests
whose bodies returned early: the kernel probe reported the exit-71 nested-profile
capability skip; Claude boot reported its missing `IB_LIVE_BOOT=1` opt-in skip.
Neither is a live pass. These results do not establish kernel-denial capture. Self-review found no
production lifecycle, hook, watchdog, or dashboard changes in this probe-only
increment. No independent reviewers were spawned.

The phase requirements below were established before implementation. The goal
is to capture kernel-only sandbox denials in the affected agent's `agent.log`
and show them in DENIALS alongside existing hook-detected denials.

**Ownership:** `start.sh` and `resume.sh` launch a dedicated collector outside the `sandbox-exec` wrapper, before the agent CLI starts. Collection must remain independent of both `ib watch` and the per-agent watchdog: closing the dashboard or a watchdog failure must not stop it. The launch scripts own the collector for that launch's lifetime.

Implementation sequence:

1. Run a live macOS probe against our generated profiles. Confirm which sandbox violation events are available through the system log, whether access needs additional privileges, and whether reports identify the offending process, operation, and target path. Include startup failures and short-lived subprocesses. Do not infer complete reporting from hook logs or a mocked event.
2. Add a dedicated helper, provisionally `ib sandbox-log-watch`. Start collection before the wrapped CLI for ordinary agents and per-repository coordinators across Claude, Codex/fugu, and agy. Attribute events to the correct launch and its subprocesses; do not rely on a process name or a numeric PID alone. Leave uncertain events unattributed rather than assign them to the wrong agent.
3. Append distinct `[Sandbox]` records to `agent.log`, preserving the event timestamp, operation, process identity, and target path when available. Extend the DENIALS parser to accept them alongside existing hook records. Bound repeated-event output and deduplicate overlapping collection so a denial loop cannot flood the log.
4. Give each launch its own collector identity and artifacts. Exit, resume, and teardown must stop only that launch's collector; a delayed exit from an old launch must not stop a replacement collector or remove its files. Report collector startup or runtime failure visibly. Collection is diagnostic: its failure must neither disable the sandbox nor silently imply there were no denials.

Acceptance checks:

- A real forbidden read and write that bypass the advisory hook scanner produce correctly attributed `[Sandbox]` log entries and appear in DENIALS when the dashboard opens.
- Collection continues with `ib watch` closed and the watchdog stopped.
- Startup and short-lived subprocess denials are captured when the OS reports enough evidence; unsupported or unattributable cases are documented explicitly.
- Concurrent agents, PID reuse, resume, and delayed old-launch cleanup cannot cross-attribute events or stop another collector.
- Existing hook denial display remains intact, and collection failure is visible while kernel enforcement remains active.

Treat OS-event coverage as best-effort diagnostic logging until the live probe establishes its practical limits; do not claim a complete audit of every denied attempt.

## Stage message attachments at send time

Implemented for human message submissions in `ib watch`, independently of kernel-denial collection. Screenshots and other local files reach a running repository agent without expanding its sandbox or restarting it. **No `ib send` command, agent-to-agent send, or watchdog delivery enables staging.** Global system-coordinator sends retain their existing behavior.

When a user drags a local file path into the `ib watch` send-message input, retain the original path in the editable draft. Parse and copy attachments only when the user actually sends the message. Deleting or changing a path before submission must not copy the old file or leave an unused temporary attachment. Live project references are preserved so edit/create instructions keep targeting the agent worktree; only external references become attachments (see SPEC §4.1.2 for relative paths and symlinks).

Send-time behavior:

1. Parse the final submitted message for local file-path references produced by terminal drag/drop. Handle quoted and escaped spaces, Unicode filenames, and multiple paths as data, without executing shell text. Define how relative paths resolve against the selected repository, and leave unrelated prose, URLs, and code unchanged.
2. Copy each referenced file into a uniquely created location under `/tmp`, preserving its filename extension and avoiding collisions or overwriting an existing file. On macOS this resolves under `/private/tmp`, which the repository-agent sandbox already permits. The dashboard performs the copy outside the receiving agent's sandbox.
3. After every copy succeeds, replace only those path references in the outgoing message with their staged paths, quoted or escaped appropriately. Send through the existing message-delivery path. The receiving agent reads the staged snapshot immediately under its existing profile.
4. If a source is missing, unreadable, or cannot be copied, show an actionable error and keep the editable draft. Do not silently send a broken rewritten path or partially deliver the message. Clean up temporary copies created by an abandoned staging attempt. Initially scope staging to files; directory behavior must be explicitly defined before supporting recursive copies.
5. Retain successfully sent attachments long enough for queued delivery and later agent reads. Define retention and cleanup separately from the send acknowledgment; acknowledgment alone must not delete files the agent has not read. Retry handling must avoid duplicate messages and unnecessary duplicate copies.

Acceptance checks:

- Drag/drop alone creates no temporary file; deleting or modifying the path in the draft affects what is copied at send time.
- A screenshot outside the allowed roots is copied only on Send, its path is replaced in the delivered message, and the running agent can read it without a sandbox refresh or restart.
- Quoted paths, escaped spaces, Unicode, multiple files, repeated references, and same-named files from different directories are handled without corrupting surrounding text or colliding.
- A copy failure preserves the draft and prevents partial delivery; cancelled or failed attempts do not leave unused attachments.
- Queued messages, retries, and attachment retention do not leave delivered messages pointing to prematurely removed files.

Implementation choices: explicit dot-relative file references resolve from the destination repository root, separately for each recipient in a fan-out. Only regular files are copied; directories produce an error. Absolute paths support terminal backslash escaping and single/double quotes. URLs and backtick code spans/fences are preserved as text; an unmatched inline backtick is ordinary text. Each attempt creates a unique /tmp/itsybitsy-attachments- directory, with separate subdirectories for distinct source files. Accepted copies have no application-managed expiry: queue acknowledgment does not remove them; external temporary-directory cleanup is the retention limit. Direct and team retries retain accepted-recipient state so only failed recipients are retried with an unchanged draft.

## Later phase: global coordinator sandbox

Resume the separate system-coordinator implementation after the repository-agent pilot, kernel-denial collection, and send-time attachment staging phases. Denial collection and attachment staging can be implemented independently. The system coordinator must establish safe launch adoption, protected configuration and launch records, and cleanup that cannot affect a replacement session or proxy. Its outstanding concurrency and ownership findings remain deferred and are not part of the current rollout.

## Historical context

The earlier Phase A implementation supplied the profile generator, proxy, frozen policies, and seals. Phase B shared the path resolver between hooks and kernel profiles. Their opt-in shipping ledger remains in Git history. That mandatory-only milestone has since been superseded by the current default-enabled override policy described above.

The earlier Phase A implementation supplied the profile generator, proxy, frozen policies, and seals. Phase B shared the path resolver between hooks and kernel profiles. Their opt-in shipping ledger remains in Git history. That mandatory-only milestone has since been superseded by the current default-enabled override policy described above.

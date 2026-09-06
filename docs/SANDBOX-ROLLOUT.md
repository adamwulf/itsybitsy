# Staged sandbox rollout

This rollout requires `sandbox-exec` for ordinary agents and per-repository coordinators, including Claude, Codex/fugu, and agy launch and resume paths. The global `@system` coordinator remains unsandboxed for now. The phase order is: exercise the repository-agent rollout; add launch-script-owned kernel-denial collection and send-time attachment staging; then resume global coordinator sandbox work. The two intermediate phases can proceed independently.

Agent-type Markdown defines filesystem paths, raw Seatbelt rules, and allowed network domains. It does not define an on/off switch. This replaces the former opt-in rollout and its `sandbox.enabled` instructions.

## Implementation and validation status

The mandatory policy and repository-agent lifecycle are integrated on `agent/sandbox-exec-feature`. The integrated branch passed 5,611 tests, TypeScript checking, a local build, and `./ib list-types`. These checks do not mean the binary is installed or existing agents are migrated.

A Claude worker ran the live kernel filesystem and tmux-socket probes successfully. The offline Claude boot test also passed. That test deliberately denies network access and ends by timeout: it does not establish a model reply through the proxy or working MCP servers. Those checks remain part of the candidate pilot before broad deployment.

The global coordinator launch code is unchanged in this rollout. Neither its running session nor a newly started `@system` session should be reported as kernel-sandboxed.

## Configuration contract

- `paths.allowRead`, `paths.allowWrite`, and `paths.deny` remain the authored filesystem rules. Write access includes read access. Denies take precedence.
- `sandbox.rawAllow` and `sandbox.domains` remain configurable. Their lists and the path lists combine through the existing inheritance rules.
- `sandbox.enabled` is retired, regardless of its value. Remove the key from every agent-type file that contains it, including custom types. An omitted sandbox block never authorizes an unsandboxed repository-agent launch.
- Internal metadata can still contain `sandbox.enabled` to identify legacy agents and preserve sealed-record compatibility. Newly resolved policy is always enabled; old disabled metadata must be migrated before resume.
- Required runtime paths are added for the worktree, agent bookkeeping, and the selected CLI. The agy state directory is an agy-only runtime root.
- If the platform, profile, or proxy cannot support the sandbox, repository-agent launch fails. There is no unsandboxed fallback for those agents. The deferred global coordinator is an explicit rollout exception, not a configurable toggle.

## Prepare the existing installation

1. Back up the live agent-type files under `~/.itsybitsy/agent-types` before editing them.
2. Remove `sandbox.enabled` from both built-in and custom type files. Keep their paths, domains, raw rules, and other settings.
3. Compare the live files with the candidate using `./ib init-types --check`. Reconcile missing entries from `docs/agent-types/_all.md`, preserving intentional type-specific restrictions. The preflight reports retired keys in custom files too. A zero exit is required before installation, but does not replace type validation or a live launch test.
4. Run `./ib list-types` and resolve configuration errors. `ib init-types` alone does not update existing customized files.

Do not replace a customized type wholesale to remove a single retired key. Do not restore the old toggle as a workaround for a denied path; correct the applicable path or domain rule.

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

This is a candidate-binary pilot, not a per-type enabled flag. All repository agents started by the candidate follow the mandatory policy; the global coordinator remains outside this stage.

## Install and migrate running agents

Merging source does not replace the installed binary or change a running process. A Seatbelt profile takes effect at launch and is inherited by descendants.

1. Install the reviewed candidate `ib` onto PATH and restart `ib watch` after the configuration preflight and pilot checks. Ensure lifecycle and proxy helpers resolve to the same candidate version.
2. Run `ib sandbox refresh --all` in each registered repository. The command covers the current repository only. It re-derives policy from the current Markdown, updates sealed records, and restarts running agents; stopped agents use the refreshed policy on their next resume.
3. Handle every reported failure and coordinator skip. Per-repository coordinators use their reset path (`ib resume <coordinator-id>` or dashboard R). Reset can also tear down their children, so schedule it before refreshing those children.
4. Verify remaining live repository agents were launched by the candidate under a kernel profile. A new value in Markdown or metadata is not proof that an old process changed.

Restarting the global `@system` coordinator does not sandbox it in this version. Keep that exception visible while observing the repository-agent rollout; global coordinator confinement will require its own reviewed change and migration.

## Failure recovery and limits

Keep the last working binary and the configuration backup until rollout is verified. The new binary has no repository-agent disable switch. For a failed launch, correct its missing runtime path, domain, or profile rule and retry the supported refresh or restart path. Reverting the entire installation to an older binary restores that version of enforcement; it must not be described as keeping mandatory sandboxing.

The hook scanner provides early errors and denial-log entries for recognizable operations. It is not a complete shell parser. The kernel-denial collector adds reports whose process identity and lifetime can be established; absent or unattributable kernel-only events still may not appear in DENIALS.

Spawning agents retain access to the tmux server for lifecycle operations. This is an existing escape from process confinement: they can ask that server to run commands outside their inherited profile. Mandatory wrapping does not close that boundary. Non-spawners have the corresponding socket denied.

The agy runtime root is shared state under the user home. Granting it only to agy avoids extending that access to other CLIs; it does not provide per-agent isolation between agy instances.

## Next phase: collect kernel sandbox denials

**Implementation candidate; live helper fixtures validated. Collector-SIGKILL
cleanup remains unresolved, and independent review/deployment are pending.**
Complete this phase after exercising the repository-agent sandbox and before
resuming global system-coordinator sandbox work.

The candidate adds `ib sandbox-log-watch` to the shared repository-agent start
and resume wiring. A launch-specific shell supervisor starts it outside Seatbelt
before the CLI, independently of `ib watch` and the per-agent watchdog. The
collector observes its own unique `logger` marker in the live unified-log stream
before releasing a CLI registration gate. The gate then execs the original
mandatory `sandbox-exec` command, retaining the PID used by lifecycle code.

Attribution uses `proc_pidinfo` birth identity and independently observed
descendant ancestry, with `mach_continuous_time` observations bracketing each
report's `machTimestamp`. It never extends an observed interval backwards to
process birth or forwards to an estimated exit. PID reuse cannot extend an old
instance's interval. Unknown children, events before first/after last observation,
ambiguous reports, and OS duplicate summaries (whose original event times are
missing) are omitted. Live stream records with empty `bootUUID` use the boot
identity independently obtained by the running collector; persisted/replayed
records are not consumed. History is capped at 4,096 instances and 30 seconds;
pending reports at 512 entries and 500 milliseconds. Polling is every 20 ms.

Verified reports append `[Sandbox]` entries with the original timestamp,
operation, offender name/PID/birth, target when present, launch, boot, and
monotonic event identity. Output is capped at 60 entries per minute per launch
and 3 per process/operation/target per minute, with a 2,048-event deduplication
cache. Suppression and collector errors use `[SandboxCollector]` records; errors
and warnings also appear in DENIALS alongside unchanged hook denials.

Every script invocation allocates a fresh `sandbox-log.XXXXXXXX` directory.
Cleanup signals only that directory's stop file, never a numeric collector PID
or shared filename. The collector also exits if its launch owner's birth identity
changes/disappears and drains for up to one second on normal shutdown. A shell
supervisor reports unexpected collector exits while the CLI continues. The collector
also ends when the registered CLI instance disappears, so an interactive
`exit-check.sh` cannot keep a stale collector alive. Diagnostic
failure never removes or bypasses the required Seatbelt wrapper. No system-wide
collector, dashboard dependency, watchdog dependency, or global `@system` launch
change is introduced.

Candidate checks in the Codex session: 5,657 reported `bun test` passes, zero
failures, 29,486 assertions across 115 files; TypeScript checking and local build
pass. `./ib list-types` prints its table and the new command's help dispatches.
The suite total still includes the kernel capability and opt-in Claude boot
early-return skips described below; it is not a live enforcement/capture pass.
Adam's one authorized worker ran the native process reader, candidate binary,
shell fixtures, and logger. Corrected candidate `d198c4d` passed live stream-failure
and verbatim start/resume preamble fixture validation; subsequent production
source is identical. The fixtures used the actual shared preamble and gate,
generated floor profile, and synthetic sandboxed shells. They did not run full
production script bodies, model CLIs, or the proxy. Claude, Codex/fugu, agy, and
per-repository coordinator generation is covered by automated lifecycle tests.

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
confirmed concurrent launch isolation and replacement cleanup, and rendered a
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
produces a supervisor ERROR (exit 137). Kernel read/write enforcement remained
active in both failure cases; no dashboard or watchdog ran in the fixtures.

**Unresolved crash-cleanup gap:** `SIGKILL` of the collector bypasses its cleanup.
The launch directory remains and its `/usr/bin/log stream` child can remain
orphaned. The shell supervisor makes failure visible but does not terminate that
child or remove the residual directory. Normal CLI exit, SIGTERM, and stream
failure clean up; old-launch cleanup never signals a replacement by numeric PID.
The worker removed only its disposable orphan after matching the birth identity
captured before the kill. This is an observed limitation, not approval to deploy
with orphaned streams. See `docs/sandbox-denial-probe-evidence.md` sections 10–12
for failed-candidate history, corrected live results, and remaining limits.

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

The earlier Phase A implementation supplied the profile generator, proxy, frozen policies, and seals. Phase B shared the path resolver between hooks and kernel profiles. Their opt-in shipping ledger remains in Git history. This staged mandatory rollout supersedes the former instruction to set or unset `sandbox.enabled` and the former assumption that agy must run unwrapped.

The earlier Phase A implementation supplied the profile generator, proxy, frozen policies, and seals. Phase B shared the path resolver between hooks and kernel profiles. Their opt-in shipping ledger remains in Git history. The current mandatory rollout supersedes the former instruction to set or unset `sandbox.enabled` and the former assumption that agy must run unwrapped.

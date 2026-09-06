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

The hook scanner provides early errors and denial-log entries for recognizable operations. It is not a complete shell parser, and kernel-only denials may not appear in the Denials tab.

Spawning agents retain access to the tmux server for lifecycle operations. This is an existing escape from process confinement: they can ask that server to run commands outside their inherited profile. Mandatory wrapping does not close that boundary. Non-spawners have the corresponding socket denied.

The agy runtime root is shared state under the user home. Granting it only to agy avoids extending that access to other CLIs; it does not provide per-agent isolation between agy instances.

## Next phase: collect kernel sandbox denials

**Planned only; not implemented or built in this rollout.** Complete this phase after exercising the repository-agent sandbox and before resuming global system-coordinator sandbox work.

The goal is to capture kernel-only sandbox denials in the affected agent's `agent.log` and show them in the DENIALS pane. Hook-detected denials already reach both places; kernel-only events are not currently collected.

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

When a user drags a local file path into the `ib watch` send-message input, retain the original path in the editable draft. Parse and copy attachments only when the user actually sends the message. Deleting or changing a path before submission must not copy the old file or leave an unused temporary attachment.

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

Implementation choices: explicit dot-relative file references resolve from the selected repository root. Only regular files are copied; directories produce an error. Absolute paths support terminal backslash escaping and single/double quotes. URLs and backtick code spans/fences are preserved as text. Each attempt creates a unique /tmp/itsybitsy-attachments- directory, with separate subdirectories for distinct source files. Accepted copies have no application-managed expiry: queue acknowledgment does not remove them; external temporary-directory cleanup is the retention limit. Direct and team retries retain accepted-recipient state so only failed recipients are retried with an unchanged draft.

## Later phase: global coordinator sandbox

Resume the separate system-coordinator implementation after the repository-agent pilot, kernel-denial collection, and send-time attachment staging phases. Denial collection and attachment staging can be implemented independently. The system coordinator must establish safe launch adoption, protected configuration and launch records, and cleanup that cannot affect a replacement session or proxy. Its outstanding concurrency and ownership findings remain deferred and are not part of the current rollout.

## Historical context

The earlier Phase A implementation supplied the profile generator, proxy, frozen policies, and seals. Phase B shared the path resolver between hooks and kernel profiles. Their opt-in shipping ledger remains in Git history. This staged mandatory rollout supersedes the former instruction to set or unset `sandbox.enabled` and the former assumption that agy must run unwrapped.

The earlier Phase A implementation supplied the profile generator, proxy, frozen policies, and seals. Phase B shared the path resolver between hooks and kernel profiles. Their opt-in shipping ledger remains in Git history. The current mandatory rollout supersedes the former instruction to set or unset `sandbox.enabled` and the former assumption that agy must run unwrapped.

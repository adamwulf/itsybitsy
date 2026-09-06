# Staged sandbox rollout

This rollout requires `sandbox-exec` for ordinary agents and per-repository coordinators, including Claude, Codex/fugu, and agy launch and resume paths. The global `@system` coordinator remains unsandboxed for now. Its sandbox implementation is a separate follow-up after experience with the repository agents.

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

## Global coordinator follow-up

The separate system-coordinator implementation must establish safe launch adoption, protected configuration and launch records, and cleanup that cannot affect a replacement session or proxy. Its outstanding concurrency and ownership findings are not part of this rollout. Resume that work after collecting experience with ordinary agents and per-repository coordinators.

## Historical context

The earlier Phase A implementation supplied the profile generator, proxy, frozen policies, and seals. Phase B shared the path resolver between hooks and kernel profiles. Their opt-in shipping ledger remains in Git history. This staged mandatory rollout supersedes the former instruction to set or unset `sandbox.enabled` and the former assumption that agy must run unwrapped.

The earlier Phase A implementation supplied the profile generator, proxy, frozen policies, and seals. Phase B shared the path resolver between hooks and kernel profiles. Their opt-in shipping ledger remains in Git history. The current mandatory rollout supersedes the former instruction to set or unset `sandbox.enabled` and the former assumption that agy must run unwrapped.

# Sandbox safe test execution plan

## Goal and observed failure

The default `bun test` suite must run inside an agent sandbox without reaching the user's live agents, watchdog queues, tmux sessions, or configuration. Production sandbox detection, caller verification, and permissions must retain their current behavior.

The initial run reported 6876 passes, 16 failures, one skip, and one unhandled error across 140 files. Thirteen CLI parsing tests failed. Three expected spawning to fail but received success; the user observed three real agents being spawned. The CLI helper launches this worktree's source with the real worktree as cwd and only overrides HOME. Sandbox routing can therefore discover the real agent and enqueue work for its watchdog. The existing test preload's in-process mocks do not protect separately launched CLI processes. Other failures involve real sandbox detection, kernel process inspection, and hook caller binding.

## Stage 1 Review the plan

Two independent Codex reviewers assess this plan before implementation: one focuses on isolation and realistic side effects, the other on architecture and retained behavioral coverage. Resolve actionable findings and record the decisions here. Reviewers must not run the unsafe full suite or CLI mutation tests before isolation is implemented.

## Stage 2 Establish isolated CLI execution

Inventory subprocess helpers and mutable external boundaries in the default suite, including direct spawning, watchdog requests, caller ancestry, account-home registry discovery, hooks, and generated shell commands. Focus on routes exercised by the suite, not a generic security framework.

Convert the in-process self-merge test in `src/ib-commands.test.ts` to a temporary agent fixture with an explicit fixture caller cwd. It currently derives the actual agent from process.cwd(); mergeAgent acquires the lifecycle operation before rejecting self-merge, so even mocked spawning still writes the live agent's lock and transient merging state. Preserve the self-merge rejection assertion and production merge semantics. No full-suite execution until in-process lifecycle locks and metadata writes are fixture-only as well as subprocess mutations.

Introduce a shared test-only CLI runner using an absolute worktree entry point, a per-test temporary cwd and HOME, and an explicit minimal environment. Account for account-home lookup and process ancestry: HOME and cwd alone are insufficient. Use explicit test dependencies or a dedicated test subprocess entry point/preload to supply fixture caller identity and external operations. Do not add an environment-variable bypass to production sandbox enforcement or a production test-mode switch.

Unexpected attempts to mutate external state must fail loudly. Test-owned fixture queues and fake watchdog handlers may execute broker protocol behavior. Both direct and brokered command paths must remain covered. Keep real production entry-point smoke coverage for inert commands, including compiled binary dispatch where already required.

Success: CLI tests cannot resolve the live agent or submit to its queue, and any deliberately exercised broker traffic is confined to a temporary fixture directory.

## Stage 3 Make assertions independent of host privileges

Replace parsing tests that rely on a downstream failure with positive assertions of parsed prompts/options and selected action using fake handlers. Preserve aliases, stdin/file/positional precedence, repo lookup and ambiguity, permission denial, and sandbox routing coverage.

Test sandboxed and unsandboxed behavior using explicit injected dependencies. Move real kernel/ancestry/nested-sandbox assertions behind an explicit live-integration opt-in with clearly reported capability prerequisites. Keep deterministic tests for the behavior those probes currently cover; do not blanket-skip failures or weaken assertions. Avoid eager native resource initialization during test collection. Audit the hook caller-binding failure against the same approach.

Success: the default suite is deterministic in this native Codex sandbox; privileged checks are separately runnable on a capable host and unavailable capability is distinguished from a product assertion failure.

## Stage 4 Regression verification

Add regression tests for the observed failure: an agent-shaped cwd and inherited harness context cannot make a CLI parsing test write to a non-fixture watchdog queue. Exercise both broker and direct mutation boundaries, including send/lifecycle operations where the shared runner reaches them. Use sentinel fixture state rather than the actual user's live queue to prove the boundary. Include negative checks proving unexpected operations fail rather than returning fabricated success.

Require fixture-only in-process lifecycle metadata and lock writes, including the self-merge test, before this verification gate. Preserve the real hook caller-resolution algorithm while injecting parent-process and identity observations, and preserve collector readiness/routing coverage with a fake process reader; only the actual privileged OS observations move to live probes.

Run targeted tests first, then the complete `bun test` suite with output captured to a file, then `bunx tsc --noEmit`. If either CLI entry point changes, rebuild using the required flags and verify the compiled list-types command produces a table with a temporary home. Record exact totals and any opt-in integration limits. Do not rerun the unsafe suite before Stage 2 is verified.

## Stage 5 Review the implementation

Commit the implementation and run two independent Codex reviews, covering correctness/coverage and isolation/architecture. Fix every code issue and meaningful documentation issue, excluding cosmetic nits and speculative adversarial cases. Repeat review after code fixes until both reviewers approve. Retire all reviewers and provide the test results, review outcomes, and remaining host-only verification limits.

## Cross cutting acceptance checklist

- General agent functionality: runtime spawn, identity, metadata, and permissions unchanged; tests use fixtures and explicit dependencies.
- Hooks: preserve real caller binding and denial semantics; test ancestry and metadata are isolated.
- Watchdog: production request routing, seal verification, transport, and scheduling unchanged; test queues never refer to live agents.
- Dashboard: no UI changes expected; existing test backstops remain intact.

## Scope

No migrations, backwards compatibility layers, new user-facing sandbox flags, or unrelated refactors. This task does not retire the three accidentally spawned agents without identifying them and confirming their current purpose. Reviewer agents explicitly requested by the user are intentional live spawns.

## Progress

- Architecture review approved by agent-d47b0c44; retired after reporting.
- Isolation review by agent-213eea95 approved the revised plan after the live self-merge metadata mutation was explicitly included; reviewer retired after approval.
- All three implementation workstreams are integrated: CLI isolation, privileged probes, and hook/lifecycle fixtures. The shared CLI runner and guarded driver preserve real parsing, caller algorithms, broker transport and real outbox writes against temporary fixtures. Both self-merge variants now claim and clear lifecycle state only on temporary agents.
- First implementation review: isolation approved (agent-a444bc0b); correctness (agent-429ebf89) requested real send-to-outbox coverage below the action seam and explicit capability reporting for the new live hook ancestry probe. Both were fixed. Manager review also required deterministic collector re-adoption coverage and explicit opt-in gates for the remaining sandbox-exec probes; both were fixed.
- Second implementation review: correctness approved (agent-b42fadbd) and isolation approved (agent-856e0d62), with no remaining findings. All workers were merged and all reviewers retired; no active child agents remain.
- Integrated native Codex sandbox verification: targeted isolation tests **287 pass, 5 skip, 0 fail**; full `bun test` **7176 pass, 11 skip, 0 fail**, 35874 expectations across 142 files in 125.17 seconds. `bunx tsc --noEmit` exited 0 with no errors. `git diff --check main...HEAD` passed.
- The root CLI compiled successfully with all required production flags. The hook allowlist denied the direct smoke command `HOME=/tmp/test-status-smoke-home /tmp/test-status-ib list-types`; manager verification of the compiled table remains pending permission. Worker-reported compiled smoke succeeded, but is not substituted for this pending manager gate.

## Remaining verification limits

The 11 default-suite skips are explicit live integration probes requiring OS privileges or real CLI sessions. Their opt-in commands are documented in `docs/implementation-notes.md`; this native sandbox run does not verify host kernel enforcement. The pre-existing live no-worktree ancestry probe does not use the new capability preflight, and the existing opt-in Codex model probe uses a uniquely named session on the default tmux server. Neither is part of the default suite's new isolation coverage.

The test driver confines the reviewed routes through fixture paths and injected authority, with guards for external operations and sentinel regressions. It is not a general filesystem sandbox for arbitrary future test code. Production caller permissions, sandbox routing, metadata shape, hook enforcement, watchdog scheduling, and dashboard behavior remain unchanged.

# `ib rehire` implementation plan

## Goal

Add `ib rehire <agent-id>` so an agent retired by the new `ib retire`
command can be reconstructed under `.ittybitty/agents/<id>/` and restarted in
its original CLI session with the same identity, worktree contents, metadata,
permissions, hierarchy, and runtime role.

This plan assumes the separate `ib kill` → `ib retire` rename has landed.

## Research findings

The existing archive is useful history, but is not a recovery image.

- `.ittybitty/archive/<timestamp>-<id>/` currently receives `output.log`,
  `agent.log`, `meta.json`, `settings.local.json`, and `debug-logs/`.
- `meta.json` already contains the Claude session ID or Codex rollout ID,
  model, effort, prompt, agent type, manager/spawner relationship, tmux session
  name, worktree mode, and permission-related identity fields.
- Retirement currently removes the worktree and deletes `agent/<id>`. The
  archive does not record the branch HEAD, so committed agent work can become
  unreachable and eventually be garbage-collected.
- Tracked worktree changes and untracked, non-ignored files are not archived.
- `start.sh`, `exit-check.sh`, `prompt.txt`, and coordinator-local `.claude/`
  settings are not archived. `resumeAgent()` needs `exit-check.sh` and uses
  `start.sh` to recover Claude yolo mode.
- The existing `resumeAgent()` implementation already handles CLI-specific
  session resume, tmux recreation, trust prompts, state writes, the resume
  nudge, and watchdog startup. Rehire should reconstruct durable state and
  then delegate to this pipeline.
- Team membership and pending questions are intentionally removed at teardown.
  Pending questions and queued messages are stale runtime state and should stay
  removed. Team memberships are durable collaboration state and should be
  recorded for best-effort restoration.
- Archive directories are named `<timestamp>-<id>`, not `<id>`. Discovery must
  scan `archive/*`, parse each `meta.json`, and match its `meta.id`; joining
  `archive/<id>` is incorrect. Some existing archived-agent readers in
  `src/agents.ts` make that incorrect assumption and should be corrected to use
  the resolved archive descriptor while this path is being made authoritative.
- The command authorization hook only searches active `agents/` metadata.
  A manager-only `rehire` command must authorize against archived metadata in
  both its same-repo and cross-repo passes.
- The hook parser validates target tokens as agent IDs and does not safely
  resolve nicknames. To keep authorization fail-closed, `rehire` accepts the
  immutable exact agent ID only; nickname-based rehire is not supported.
- The dashboard intentionally skips archive scans on refresh. Rehire should
  not add archive polling or a new dashboard state.

## Behavioral contract

### Retirement

Before destructive teardown of a worktree agent, `ib retire` creates a
versioned recovery snapshot:

```text
.ittybitty/archive/<timestamp>-<id>/
  retirement.json
  meta.json
  agent.log
  output.log
  prompt.txt
  start.sh
  exit-check.sh
  settings.local.json
  worktree.patch
  untracked/
  debug-logs/
  .claude/                 # coordinator-local settings, when present
```

`retirement.json` version 1 records:

- agent ID and retirement time;
- original repository and archive identity;
- whether the agent used a worktree;
- the exact worktree HEAD object ID;
- a durable hidden ref that keeps that object reachable;
- paths of preserved untracked files;
- teams pruned during retirement.

For worktree agents, preparation must finish before the process, worktree, or
branch is destroyed:

1. Resolve and validate `HEAD`.
2. Create `refs/ittybitty/retired/<archive-key>/head` at that commit.
3. Write `git diff --binary HEAD` to `worktree.patch`. This preserves the
   resulting tracked file contents and modes; staged-versus-unstaged
   classification is not part of the contract.
4. Enumerate `git ls-files --others --exclude-standard -z` and copy those
   paths without following symlinks into the snapshot.
5. Copy recovery scripts and local settings.
6. Only after every required snapshot step succeeds, continue teardown.

Ignored files, central outbox contents, transient metadata, process IDs, and
pending questions are not recovery state. They remain excluded.

If snapshot preparation fails, retirement fails before destructive teardown.
It must remove any partial hidden ref/snapshot it created and leave the agent
running and its worktree untouched.

No-worktree agents do not own the shared root repository state. Their recovery
snapshot preserves agent-local files and metadata but does not snapshot or
rewrite the root worktree.

### Rehire

`ib rehire <agent-id>`:

1. Scans every registered repository's timestamp-named `archive/*`
   directories, parses each `meta.json`, and matches the immutable exact
   `meta.id`. It never derives an archive path by joining the agent ID. For
   repeated retirements in one repository, the newest valid retirement
   manifest wins; exact-ID matches in multiple repositories are ambiguous and
   rejected.
2. Rejects ambiguity across repositories, an already-active ID or nickname,
   a live tmux session, a conflicting `agent/<id>` branch, malformed metadata,
   or an unsupported snapshot version. It first prunes stale worktree metadata
   and may replace an unclaimed orphan branch only when it still points at the
   retained retirement HEAD.
3. Rejects any archive without a recovery manifest with a generic explanation
   that the archive is not rehirable. This covers legacy retirements as well as
   intentionally destructive merge/nuke archives without misidentifying which
   operation produced the archive.
4. Recreates `.ittybitty/agents/<id>/`, copies archived agent-local files, and
   writes sanitized metadata. It clears `claude_pid`, `watchdog_pid`, transient
   operation state, and replaces state with `stopped`; it preserves
   `tmux_session`, `session_id`, `codex_session_id`, `model`, `effort`,
   `agentType`, `manager`, `spawned_by`, `nickname`, and `worktree`.
   `tmux_session` must equal the deterministic
   `ittybitty-<repo-id>-<agent-id>` value for this repository.
5. For a worktree agent:
   - creates `agent/<id>` and its worktree from the manifest's hidden HEAD ref;
   - applies `worktree.patch`;
   - restores untracked paths without allowing path traversal or symlink
     dereference outside the worktree;
   - restores `.claude/settings.local.json`.
6. For a no-worktree agent, restores agent-local coordinator settings when
   present and continues to use the root repository.
7. Best-effort re-adds the agent to teams that still exist before session
   startup, so membership remains durable if resume must be retried.
   Missing/deleted teams become warnings, not a rollback.
8. Calls the existing `resumeAgent()` implementation to resume the original
   Claude/Codex session and recreate tmux/watchdog state.
9. Keeps the archive and hidden ref immutable so retirement history remains
   auditable. A second rehire is blocked while the agent is active.

If reconstruction fails before an active directory is complete, rehire removes
the partial worktree, branch, and agent directory. If session resume fails
after reconstruction, it leaves a valid stopped agent in place so the user can
inspect it and retry with `ib resume`.

For Codex/Fugu archives where `codex_session_id` was never captured before
retirement, reconstruction still succeeds and leaves a valid stopped agent;
the existing `resumeAgent()` error is surfaced without rolling reconstruction
back.

Every retirement uses its timestamped archive folder name as the archive key,
so retire → rehire → retire creates distinct folders and hidden HEAD refs.
Earlier archives and `refs/ittybitty/retired/*/head` refs remain immutable.

## Implementation structure

### 1. Recovery snapshot primitives

In `src/agent-lifecycle.ts`:

- Define and validate a `RetirementManifestV1` schema.
- Add archive discovery that enumerates timestamped archive directories, reads
  their metadata, and returns an explicit descriptor containing the
  repository, actual archive directory, metadata, and manifest.
- Add a preparation helper that snapshots git state and agent-local recovery
  files before teardown.
- Extend `archiveAgent()` to move/copy the prepared recovery payload and write
  the final manifest after team pruning is known.
- Add cleanup helpers for partial snapshot and reconstruction failures.
- Keep `killAgentProcess()` and other true process/tmux kill terminology
  unchanged.

All archive-derived paths are treated as untrusted input. IDs, ref names,
relative paths, object IDs, and tmux/session identifiers are validated before
filesystem or subprocess use.

### 2. Retirement integration

In `src/ib-commands.ts`, update `retireAgent()` to:

- run recovery preparation before `teardownAgent()`;
- abort non-destructively when preparation fails;
- pass the prepared snapshot through teardown/archive;
- preserve existing team leave notices and orphan-process cleanup.

`nuke` and `merge` remain destructive operations, not implicit retirement.
They continue to use teardown without preparing a rehirable snapshot. This
keeps `rehire` specifically paired with explicit `retire`.

### 3. Rehire command

Add `rehireAgent()` in `src/ib-commands.ts` with a dedicated spawn context for
injectable git/tmux operations. The function performs validation,
reconstruction, rollback, `resumeAgent()` delegation, and team restoration.

Factor small shared helpers out of `newAgent()` only where necessary:

- restoring/building the standard exit script;
- codex `AGENTS.md` regeneration if the archived worktree did not preserve it;
- safe worktree creation/cleanup.

Avoid routing rehire through `newAgent()`: new-agent generates a new identity,
session, prompt, base ref, settings, and creation timestamps, which conflicts
with recovery semantics.

### 4. CLI, hooks, and documentation

- Add command parsing, usage, help, and dispatch in `src/index.ts`.
- Add `rehire` to manager-only hook authorization.
- Teach both the same-repo and cross-repo hook passes to find the same archived
  target descriptor used by command dispatch, then call the existing
  `hasAccess()` relationship check with archived metadata. Per-repo coordinator
  authority should mirror `retire` for non-coordinator targets in that
  repository.
- Keep rehire targets exact-ID-only in both CLI dispatch and hook parsing.
  Nicknames are deliberately rejected so an unparsed nickname cannot bypass
  the manager-only authorization check.
- Correct existing archived-agent path readers in `src/agents.ts` that assume
  `archive/<id>` when they are exercised by the new descriptor, or route them
  through the descriptor so timestamped directories are always used.
- Update `SPEC.md`, `docs/implementation-notes.md`, embedded session-start
  instructions, agent-type docs, and relevant help snapshots.
- Do not add an `ib watch` key binding in this change. Once rehire creates the
  active directory, existing watcher/dashboard behavior picks it up normally.
- The watchdog needs no special rehire branch because `resumeAgent()` already
  starts it.

## Tests

### Lifecycle unit tests

- Manifest serialization/validation and malformed-version rejection.
- Snapshot stores exact HEAD in a durable hidden ref.
- Binary tracked changes and executable-bit changes round-trip.
- Untracked regular files, nested paths, and symlinks round-trip.
- Ignored files are deliberately excluded.
- Path traversal and unsafe archived symlinks are rejected.
- Snapshot failure removes partial state/ref and does not invoke teardown.
- Archive contains runtime scripts, settings, coordinator `.claude/`, and
  pruned team metadata.

### Command tests

- Rehire reconstructs a worktree at the archived commit, applies its patch,
  restores untracked files/settings, sanitizes metadata, and delegates to
  resume.
- Clean worktree, dirty worktree, Claude, Codex/Fugu, no-worktree, manager,
  worker, custom type, and coordinator metadata paths.
- Legacy worktree archive gets a precise non-destructive error.
- Existing active ID, nickname collision, branch collision, live tmux,
  ambiguous archives, missing hidden ref, bad object ID, corrupt patch, and
  partial-copy failures.
- Pre-resume failure rolls back branch/worktree/directory.
- Resume failure leaves a stopped reconstructed agent.
- Existing teams are restored; deleted teams produce warnings.
- Outbox, pending questions, stale PIDs, and transient operation state are not
  restored.
- Two retirements of one ID select the newest manifest and leave both archive
  folders/hidden refs intact.
- Reconstructed metadata preserves and validates the deterministic
  `tmux_session` while clearing only stale process/transient fields.
- A Codex/Fugu archive without `codex_session_id` reconstructs successfully,
  surfaces the resume error, and remains stopped.

### Hook/CLI tests

- `ib rehire <id>` help and dispatch.
- Timestamped-folder scan, exact-ID resolution, newest-retirement selection,
  and cross-repository ambiguity behavior.
- Manager, spawner, per-repo coordinator, cross-repo, and system coordinator
  authorization against archived metadata.
- Non-manager callers are denied.
- A nickname target is rejected by both command dispatch and the hook; it
  cannot fall through as an unparsed unrestricted command.

### Full verification

Run:

```sh
bun test
bunx tsc --noEmit
```

Then run one independent reviewer focused on correctness, recovery safety,
authorization, and cleanup. Resolve every finding and repeat with one reviewer
until approved, as requested.

## Cross-cutting assessment

- **General agent functionality:** affected. Identity, meta restoration,
  hierarchy, worktree contents, session resume, and team membership are the
  core of the feature.
- **Hooks:** affected. Manager-only authorization must resolve archived targets;
  restored settings and Codex dispatch prechecks must remain valid.
- **Watchdog:** behavior reused, not redesigned. Rehire delegates to
  `resumeAgent()`, which already starts a watchdog and records its PID.
- **`ib watch` / dashboard:** no archive scan or new UI state. Existing active
  directory watching discovers the rehydrated agent after reconstruction.

## Explicit non-goals

- Rehiring agents destroyed by `merge` or `nuke`.
- Recovering ignored build products, central outbox messages, pending user
  questions, or transient locks.
- Preserving the distinction between staged and unstaged tracked changes.
- Snapshotting nested repositories or submodule working-tree changes beyond
  the superproject's recorded gitlink.
- Nickname-based rehire; immutable exact agent IDs are required.
- Guaranteeing that an externally deleted Claude/Codex transcript can resume.
  Rehire validates local structure; the underlying CLI remains authoritative
  about session availability.

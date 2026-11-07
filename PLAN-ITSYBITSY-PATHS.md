# Finish the rename: `ittybitty` → `itsybitsy` runtime names

Plan only — no code yet. Base: `main` at `009750dd`. Line numbers are as of that
commit; symbol names are the stable reference.

This supersedes `PLAN.md` Phase 25 (which also misspells the target as
`.ittybitsy/`) and the retired attempt at `de837a25` (`PLAN-RUNTIME-NAMES.md`
plus an `ib migrate-runtime-names` subcommand, kept by
`refs/ittybitty/retired/20261101-155040-ittybitty-itsybitsy/head`). This plan
reuses that attempt's findings, not its code.

## Decisions (made by Adam — not reopened here)

1. `itsybitsy` everywhere: code, tests, fixtures, docs, `.gitignore`.
2. A plain shell script, `scripts/update-repos.sh`, run by hand, moves every
   repo's `<repo>/.ittybitty/` to `<repo>/.itsybitsy/` once.
3. Only retired-agent git refs keep the old name. New retirements write
   `refs/itsybitsy/retired/<archiveKey>/head`. `ib rehire` tries that ref first
   and falls back to `refs/ittybitty/retired/<archiveKey>/head` only when it is
   not found. No other dual-read: no reading `.ittybitty/`, no matching
   `ittybitty-` tmux sessions.

What follows from them:

- The new binary must never run against the old layout, and the old binary must
  never run against the new one. The runbook (Part 3) orders the deploy so they
  can't meet.
- The script moves data and never touches refs, so no ref transaction and no
  `headRef` rewrite are needed.

## What changes

| Runtime name | Old | New | Changed by |
|---|---|---|---|
| Per-repo state dir | `<repo>/.ittybitty/` | `<repo>/.itsybitsy/` | code + script |
| tmux session | `ittybitty-<repoId>-<agentId>` | `itsybitsy-<repoId>-<agentId>` | code + script (`meta.tmux_session`) |
| Retired HEAD ref | `refs/ittybitty/retired/<key>/head` | `refs/itsybitsy/retired/<key>/head` for new retirements | code only; old refs stay |
| Prompt tags | `<ittybitty>`, `<ittybitty-status>` | `<itsybitsy>`, `<itsybitsy-status>` | code |
| agy rule file | `.agents/rules/ittybitty-agent.md` | `.agents/rules/itsybitsy-agent.md` | code + script |
| agy named hook key in `.agents/hooks.json` | `ittybitty` | `itsybitsy` | code + script |
| This repo's `.gitignore` lines | `.ittybitty/`, `.agents/rules/ittybitty-agent.md` | the new names | code |

Both words are 9 characters, so nothing fixed-width shifts.

**Not renamed**

- Agent IDs, nicknames and branches that contain the word (`ittybitty-paths`,
  `agent/ittybitty-itsybitsy`), including their entries in
  `~/.itsybitsy/layout.json`.
- The registered repo `~/Developer/bash/ittybitty` (its `repos.json` name and
  path) and its transcript dir `-Users-adamwulf-Developer-bash-ittybitty`. These
  encode a repo path, not a runtime dir. Every path rewrite below is anchored on
  `<repo>/.ittybitty/`, so they are never touched.
- `~/.itsybitsy/` (already renamed, `src/registry.ts`) and the `ib-coordinator`
  session (`IB_COORDINATOR_SESSION`).
- Existing `refs/ittybitty/retired/*` refs and the `headRef` recorded in existing
  `retirement.json` files.
- History: transcript contents, `agent.log`, `prompt.txt`, `output.log`,
  `debug-logs/`, codex and agy session stores, queued outbox messages.
- Docs text about the bash reference project: `~/Developer/bash/ittybitty/ib`,
  its `.ittybitty.json` config (SPEC.md §7.1 and §7.5 callouts), `research/*`,
  `docs/telegram-reactions-attachments.md`.

## What I could and could not inspect

| Looked at | Found |
|---|---|
| `~/.itsybitsy/repos.json` | 60 repos. Paths with spaces (`~/Documents/Filing Cabinet/…`), one under `~/Library/Containers/…`, one containing the word (`~/Developer/bash/ittybitty`) |
| `~/.itsybitsy/` top level | No `.ittybitty/` inside it. `repos.json` and `layout.json` mention the word only in repo and agent names |
| `~/.itsybitsy/agent-types/*.md` | 9 files (`opus`, `sonnet`, `manager`, `researcher`, `coordinator`, `worker`, `assistant`, `fugu`, `gemini`) say "IttyBitty … Agent" or "the ittybitty … orchestration system" in prose. None in `paths:` |
| `~/.claude/projects/` | 4,865 dir names containing `--ittybitty-agents-`. Claude replaces every non-alphanumeric character with `-` (`Filing-Cabinet`) |
| `~/.claude/settings.json` | No old name |
| My worktree's `.git` file | `gitdir: <repo>/.git/worktrees/repo7`. It points into the main repo, so a move does not break this direction of the link |

**Blocked** by path isolation or the Bash allow list: the main checkout and its
`.git/` (including `info/exclude`); other repos' `.gitignore` and `.git/`; every
agent dir (`<repo>/.ittybitty/agents/<id>/`, my own included); the global git
excludes file (`~/.config/git/ignore`, `git config --global`); `codex resume
--help`; `git --version`.

So the per-agent file inventory in §2.6 comes from the code that writes those
files, not from real dirs. How other repos ignore `.ittybitty/` today is unknown:
ib writes no ignore entry for it, so it is probably Adam's global excludes file.
The prior attempt reported that `adamwulf-hugo` tracks `.ittybitty/repo-id`; I
could not re-check that.

## Part 1 — Code rename

### 1.1 One module: `src/runtime-names.ts`

Every hook imports it, so it imports only `node:path`. It holds:

- **Constants:** `RUNTIME_DIR_NAME = ".itsybitsy"`, `TMUX_SESSION_PREFIX =
  "itsybitsy-"`, `RETIRED_REF_ROOT = "refs/itsybitsy/retired"`,
  `LEGACY_RETIRED_REF_ROOT = "refs/ittybitty/retired"` (the only old name left in
  non-test source), `PROMPT_TAG = "itsybitsy"`, `STATUS_TAG = "itsybitsy-status"`,
  `AGY_HOOK_KEY = "itsybitsy"`, `AGY_RULE_FILE = ".agents/rules/itsybitsy-agent.md"`.
- **Path builders:** `runtimeDir(repo)`, `agentsDir(repo)`, `agentDir(repo, id)`,
  `agentWorktree(repo, id)`, `archiveDir(repo)`, `promptsDir(repo)`,
  `repoIdFile(repo)`, `userQuestionsFile(repo)`, and `storageDir(repo, id,
  archived)` for the `join(repo, ".ittybitty", archived ? "archive" : "agents", id)`
  pattern (`src/agents.ts:1631`, `src/tui/agent-actions.ts:96,1555`,
  `src/index.ts:2635`).
- **tmux:** `tmuxSessionName(repoId, agentId)`, `agentIdFromTmuxSession(name)`
  (`^itsybitsy-[a-f0-9]{8}-(.+)$`), `isAgentTmuxSession(name)` (prefix test).
- **Refs:** `retiredHeadRef(key)`, `legacyRetiredHeadRef(key)`,
  `isRetiredHeadRef(ref, key)` (true for either name).
- **Path parsing:** one helper per shape in use today (table in 1.2). Keep each
  call site's current semantics: first or last occurrence, exact match or prefix,
  `/repo` required or not. This is a rename, not a behavior change. Several
  current regexes leave the dot unescaped (`/.ittybitty\/agents/`). The helpers
  escape it; list those sites in the commit message as the one intentional
  tightening.

### 1.2 Route every use through it

| Category | Sites (non-test `src/`) |
|---|---|
| `join(…, ".ittybitty", …)` (about 90 joins in about 28 files) | `agent-lifecycle.ts`, `agents.ts`, `auto-compact.ts`, `coordinator.ts` (`checkCoordinatorExists`), `health-check.ts`, `hooks/agent-context.ts`, `hooks/agent-path.ts`, `hooks/inject-status.ts`, `hooks/paths-table.ts` (`REPOID`), `hooks/session-start.ts`, `hooks/shared.ts`, `ib-commands.ts` (including `getRepoId`, `loadCustomPrompts`, `askQuestion`, and the sandbox roots `REPOAGENTS`/`REPOID` at :1178 and :1239-1241), `index.ts`, `lifecycle-broker.ts`, `no-worktree-caller.ts`, `resolve-target.ts`, `send-broker.ts`, `spawn-broker.ts`, `state-command.ts` (the `isUnderRuntimeDir` prefix at :351), `tui/agent-actions.ts` (including the debug-logs template string at :2541), `watchdog.ts`, `watcher.ts`, `test-cli-runner.ts` (`isolatedTempRoot`, fixture builders at :233 and :239) |
| Agent ID from a worktree cwd (regex or `indexOf("/.ittybitty/agents/")`) | `hooks/shared.ts` (`AGENT_CWD_PATTERN`, :100), `hooks/main-path.ts` (`AGENT_WORKTREE_PATTERN`), `hooks/session-start.ts:71,938`, `hooks/intercept-task.ts:432`, `ib-commands.ts:3986-3990, 6111-6115, 6170-6176, 6343-6351`, `index.ts:1834, 1862, 2554, 2612` |
| Repo root from a worktree cwd (lazy match) | `index.ts:287`, `no-worktree-caller.ts:118` |
| Exact worktree root (plus `lastIndexOf`) | `resolve-target.ts:99-102`, `index.ts:2139-2141` |
| Agents dir or agent dir prefix (greedy match) | `hooks/slow-hook-logger.ts:22,28`, `hooks/agent-context.ts:335,376`, `agent-lifecycle.ts:965-968,1041` |
| Exact agent dir / suffix | `generate-summary.ts:38` (`isValidAgentDir`), `hooks/agent-context.ts:142` |
| tmux name | built at `ib-commands.ts:744` (rehire) and :6914 (spawn); parsed by `extractAgentIdFromTmuxSession` (:8064-8090); prefix checks in `cleanupOrphanedTmuxSessions` (:1369-1395), `agents.ts:2767-2779`, `isItsybitsyTmuxSession` (`state-command.ts:192`), `agent-lifecycle.ts:1049` |
| Retired refs | §1.3 |
| agy | `AGY_WORKTREE_FILES` (`agy-worktree-files.ts:14`, which is also the protected-file list in `hooks/agent-path.ts:328,376`), `writeAgyWorktreeFiles` (`agy-spawn.ts:473`), the hook key in `buildAgyHooksJson` (`agy-config.ts:88`), the denial message at `hooks/agent-path.ts:194` |
| Prompt tags | `hooks/session-start.ts` (each wrapper, and the `lastIndexOf("</ittybitty>")` splice at :306), `stripItsybitsyWrapper` (`agent-instructions-shared.ts:53-54`), `hooks/inject-status.ts:63,84`. The strip needs only the new tag: it runs on freshly generated text, and nothing reads tags back from a transcript |
| Codex writable roots | `deriveCodexParentRepoRoots` (`ib-commands.ts:1315`, `[".ittybitty", ".claude"]`) |
| Comments | `ask-broker.ts`, `outbox.ts`, `sandbox.ts`, `teams.ts`, `validation.ts`, `agents.ts`, `agy-*.ts`; renamed so the guard test passes |

The root `index.ts`, `build.sh`, `package.json` and
`scripts/probe-sandbox-denials.ts` have no old name.

### 1.3 Retired refs

| Site | Change |
|---|---|
| `prepareAgentRetirement` (`agent-lifecycle.ts:320`) | `headRef = retiredHeadRef(archiveKey)`; the manifest records the new name |
| `parseRetirementManifest` (:120-123) | Accept `isRetiredHeadRef(raw.headRef, raw.archiveKey)`, so old archives keep validating |
| `archiveAgent` pending-payload cleanup (:614-628) | Same predicate; delete exactly the ref the pending manifest names. A retirement interrupted under the old binary names the old ref |
| `prepareAgentRetirement` catch (:350) and `cleanupPreparedRetirement` (:362) | No change: they delete the ref this run created, which always has the new name |
| `rehireAgent` (`ib-commands.ts:842-880`) | New `resolveRetainedHeadRef(repoPath, archiveKey)` in `agent-lifecycle.ts`. It runs `git rev-parse --verify --quiet <ref>^{commit}` on `retiredHeadRef(key)`, then on `legacyRetiredHeadRef(key)`, and the first that resolves wins. The order is fixed: it ignores which name the manifest recorded. If the found ref's object differs from `manifest.gitHead`, fail as corrupt with no fallback, because the fallback is only for "not found". If neither resolves, fail with an error naming both refs. `git worktree add` uses the ref that was found |

Nothing else creates, moves or deletes retired refs (checked with a grep for
`update-ref` and `retired/`). The sandboxed path (`src/lifecycle-broker.ts`)
calls the same functions.

### 1.4 Codex resume after the worktree moves

The worktree path changes, and codex records each session's cwd. The prior
attempt found that codex 0.165.0 can stop at a prompt when the recorded cwd
differs from the launch dir, and nobody is there to answer it. Add `--cd
<workPath>` to the `codex resume` line in `buildCodexResumeContent`
(`src/codex-spawn.ts`). The prior diff is a template: `git diff main...de837a25
-- src/codex-spawn.ts`. I could not run `codex resume --help`. The implementer
confirms the flag or reports that they couldn't, and runbook step 8 checks a
real codex agent. See Open question 3.

Claude needs no code change, because the script renames its transcript dirs
(§2.4 step 8). agy is unverified; see Risks.

### 1.5 `.gitignore` and docs

- `.gitignore:36,51` become `.itsybitsy/` and `.agents/rules/itsybitsy-agent.md`.
  No old lines are kept (decision 1): after the script, no `.ittybitty/` exists.
- Move these docs to the new names: `SPEC.md` (§1.1 items 1a0, 2, 4 and 6; §1.4;
  §1.7; §1.7.1, which must also document the ref fallback; §1.8; §5.1-§5.5; the
  §6.0 table, which says `.ittybitsy`; §8.3; §12), `SPEC-SANDBOX.md`,
  `SPEC-PATH-ALLOWLIST.md`, `SPEC-CODEX-MODEL.md`, `SPEC-ANTIGRAVITY-CLI.md`,
  `docs/implementation-notes.md`, `README.md`, `RENAME-PLAN.md`,
  `SPAWNER-TRACKING-PLAN.md`, `ANTIGRAVITY-CLI-NOTES.md`, `CODEX-CLI-NOTES.md`,
  `docs/*.md`, `docs/plans/ib-rehire.md`, `research-*.md` and `research/*`. Keep
  text about the bash reference project. Mark `PLAN.md` Phase 25 as superseded
  by this file.
- In the `AGENTS.md` orientation table, add `src/runtime-names.ts` and
  `scripts/update-repos.sh`.

### 1.6 Guard test: yes

Add `src/runtime-names-guard.test.ts`. It fails if any non-test `.ts` file
(`index.ts`, `src/**/*.ts` except `*.test.ts`, `scripts/**/*.ts`), any
`docs/agent-types/*.md`, or `.gitignore` matches `/ittybitty/i`, except the one
`LEGACY_RETIRED_REF_ROOT` line in `src/runtime-names.ts`. Two reasons:
`docs/agent-types/` is compiled into the binary and holds the `paths:` floor,
and other branches will rebase onto this change and must not bring the old name
back. Test files aren't guarded, because the fallback and script tests need the
old name.

### 1.7 Left out of the code change

- Detecting or refusing a leftover `.ittybitty/` (Open question 5 has a one-check
  option).
- An `ib migrate-*` subcommand or any compatibility layer.
- `encodeClaudeProjectPath` (`src/auto-compact.ts:22`) replaces only `/` and `.`,
  but Claude also replaces spaces and other characters. That existing bug belongs
  in a separate change; the script uses Claude's real rule.

## Part 2 — `scripts/update-repos.sh`

### 2.1 Form

- It lives at `scripts/update-repos.sh`, mode 755, `#!/bin/bash`, `set -u -o
  pipefail`. It must run on macOS's bash 3.2: no associative arrays and no
  `mapfile`.
- It uses only `git`, `perl` (literal replacements with `\Q…\E`, values passed in
  environment variables; core `JSON::PP` to read `repos.json`), `shasum`, `ps`,
  `lsof`, read-only `tmux`, `mv` and `find`. It never calls `ib`, because the
  installed binary may be either the old one or the new one.
- It uses `git -C "<path>"`. The "no `-C`" rule in Adam's CLAUDE.md governs
  agents' own tool calls, not script content.

```
scripts/update-repos.sh [--apply] [--reverse] [REPO_PATH ...]
```

- With no flags it is a **dry run**: it prints every action it would take and
  every blocker, and writes nothing, not even a log.
- `--apply` makes the changes and tees its output to
  `~/.itsybitsy/migrations/update-repos-<YYYYMMDD-HHMMSS>.log`.
- `--reverse` swaps old and new in every step (rollback, §2.8). It is a dry run
  unless combined with `--apply`.
- `REPO_PATH ...` limits the run to those repos. The default is every `path` in
  `~/.itsybitsy/repos.json`. Each path is also resolved to its git toplevel,
  because `newAgent` puts the runtime dir at `resolveGitRoot(repoPath)`.
  Duplicates are dropped by real path.

### 2.2 Preflight

Preflight covers the whole run, reads only, and finishes before the first write.
Any failure prints each blocker with what clears it, exits 2 and writes nothing.
It runs in dry runs too.

| # | Check | How (nothing is killed) | What clears it |
|---|---|---|---|
| P1 | Not run from inside a runtime dir | `pwd -P` contains neither `/.ittybitty/` nor `/.itsybitsy/agents/` | Run it from a plain terminal |
| P2 | No agent or coordinator tmux session | `tmux list-sessions -F '#{session_name}'`; any `ittybitty-*`, `itsybitsy-*` or `ib-coordinator` session blocks. A non-zero exit saying "no server running" or "error connecting to" means no sessions; any other failure blocks (fail closed) | `ib pause <id>` with the old binary; quit `ib watch` |
| P3 | No `ib` process: `ib watch`, watchdogs, proxies, the collector, hooks | `ps -Ao pid=,args=`, matching a first argument whose basename is `ib` | Quit `ib watch`. Watchdogs exit about 10 seconds after their session ends. A leftover proxy or collector: `kill <pid>` |
| P4 | No process has its cwd under any target repo's `.ittybitty/` or `.itsybitsy/` | `lsof -a -u "$(id -u)" -d cwd -Fpn`, compared with both the registered and the real repo paths. An `lsof` failure blocks | Close that terminal or Claude, codex or agy session |
| P5 | Tools present | `git` with `worktree repair` (git 2.29 or later), `perl -MJSON::PP -e1`, `shasum` | Install the tool |
| P6 | Registry readable, when no paths are given | Parse `~/.itsybitsy/repos.json` | — |

`$HOME` must be set and absolute. P2 and P4 check both names, so `--reverse`
uses the same preflight.

### 2.3 Per-repo classification

Below, OLD is `.ittybitty` and NEW is `.itsybitsy`; `--reverse` swaps them.

| Found | Result |
|---|---|
| The repo path is missing | Warn "missing — skipped". Not an error |
| The repo path is `$HOME` | Error; skip the repo |
| Both OLD and NEW exist | Error "both exist"; skip the repo. Other repos continue |
| OLD is a symlink | Error; skip the repo |
| `git ls-files -- OLD` isn't empty | Error, printing the fix (`git -C <repo> rm -r --cached .ittybitty`, then a commit). A tracked file would show as deleted, and restoring it would recreate OLD |
| OLD only | Migrate: every step |
| NEW only | Already moved. Run steps 3 to 10, which find nothing to do in a finished repo, and print "already migrated — nothing to do". This is also how an interrupted run finishes |
| Neither | "no runtime dir"; skip the repo |

A registered dir that isn't a git repo (`ib add` allows that) skips the git
steps 1, 3 and 4.

### 2.4 Steps

These run in `--apply`; a dry run prints each one as "would …".

| # | Step | Detail |
|---|---|---|
| 1 | Ignore rules | Append `.itsybitsy/` and `.agents/rules/itsybitsy-agent.md` to `$(git rev-parse --git-common-dir)/info/exclude`, under a `# added by itsybitsy scripts/update-repos.sh` comment, each only if that exact line is missing. Every worktree shares this file, and no tracked file changes. It is needed because the spawn dirty-gate (`src/ib-commands.ts:6487-6514`) refuses on `?? .itsybitsy/`, and agy resume writes the new rule file, which old worktree `.gitignore` files don't list. It runs before the move, so `git status` stays clean |
| 2 | Move | `mv <repo>/OLD <repo>/NEW`: one `rename(2)` that carries `agents/`, `archive/`, `prompts/`, `repo-id` and `user-questions.json` |
| 3 | Repair worktrees, immediately | For each `<common-dir>/worktrees/*/gitdir` that names a path under `<repo>/OLD/` (registered or real path form; a relative value from `worktree.useRelativePaths` is resolved against the admin dir first): the new path is the same path under NEW. If `<new>/.git` exists, run `git -C <repo> worktree repair "<new dir>"`, one path per call, because the command exits 1 if any path is bad even when it fixed the others. Working from admin entries also covers nested worktrees such as `agents/<id>/repo/.claude/worktrees/<name>` (Claude's `isolation: "worktree"`). Then verify two things: `git -C <new dir> rev-parse --show-toplevel` equals the new dir, comparing real paths (in a dir without `.git` the command falls through to the parent repo and still succeeds), and the admin `gitdir` now names `<new dir>/.git`. A failure is a repo error that prints the manual `git worktree repair "<path>"`, and the run continues. If `<new>/.git` is missing, warn "stale entry, left in place" |
| 4 | Submodules in worktrees | Under `<common-dir>/worktrees/*/modules/**/config`, replace the `/OLD/agents/` segment in any `core.worktree` that contains it (`git config --file`). These values are relative, so step 3's anchored rule can't match them |
| 5 | Agent and archive records | For each dir D in `NEW/agents/*`, `NEW/archive/*` and `NEW/agents/*/.retirement/runtime`: in `D/meta.json`, rewrite only the `ittybitty-` prefix of the `tmux_session` value, using a regex on that field. Rehire refuses a mismatch (`src/ib-commands.ts:746`), and the field isn't sealed. In `D/start.sh`, `D/resume.sh`, `D/settings.local.json`, `D/.claude/settings.local.json` and `NEW/agents/*/repo/.claude/settings.local.json`, replace the literal `<repo>/OLD/` with `<repo>/NEW/` in both path forms, only in files that contain it. Never touch `retirement.json` or `prepared-retirement.json`: their `headRef` is valid under §1.3 |
| 6 | agy worktree files | In `NEW/agents/*/repo/.agents/`: if `rules/ittybitty-agent.md` exists and is untracked, rename it to `rules/itsybitsy-agent.md`, or delete it if the new file already exists, because agy would otherwise load both always-on rules. In `hooks.json`, rename the `"ittybitty":` key. Resume rewrites both files anyway (`writeAgyWorktreeFiles`), but stopped and archived worktrees shouldn't keep the old name |
| 7 | Sandbox log namespaces | For each `agents/<id>`, rename `~/.itsybitsy/sealed/sandbox-logs/<sha256("<repo>/OLD/agents/<id>")>` to the hash of the NEW path, if the old dir exists and the new one doesn't. `sandboxLogParent` (`src/sandbox-log-paths.ts:10`) hashes `resolve(agentDir)`, which uses the registered path form. Profiles regenerate on resume; this step keeps the denial history, and lets teardown's `removeSandboxProfile` find the dir |
| 8 | Claude transcripts | Rename every `~/.claude/projects/<enc(repo)>--ittybitty-agents-*` to `…--itsybitsy-agents-*`, where `enc` replaces each character outside `[A-Za-z0-9]` with `-`. That is Claude's rule, not `encodeClaudeProjectPath`'s. Use both path forms. If the target exists, skip and warn. Contents aren't changed. See Open question 2 |
| 9 | agy trust list | In `~/.gemini/antigravity-cli/settings.json`, replace the literal `<real repo>/OLD/agents/` with the NEW form. `ensureAgyTrustedWorkspace` stores real paths. Without this the old entries stay forever, because teardown removes only the current path |
| 10 | Report only | (a) `meta.paths` or `meta.sandbox` containing `/OLD/`. Those fields are sealed, so after the deploy run `ib sandbox refresh <id>`. None are expected: runtime roots are injected at launch, and `meta.paths` holds only authored entries. (b) Symlinks under NEW whose target contains `/OLD/` (`find -lname`). (c) `/OLD` in `<repo>/.gitignore` or `<repo>/.claude/settings*.json`. (d) Queued lines in `~/.itsybitsy/agents/*/outbox.jsonl` that mention `/OLD/` |

User-wide, once after all repos, and only if Open question 1 is approved: in
`~/.itsybitsy/agent-types/*.md`, replace `IttyBitty` with `ItsyBitsy` and
`ittybitty` with `itsybitsy`, saving each original as `<file>.pre-itsybitsy`.

### 2.5 What the script never does

- **Run `git worktree prune`**, in any mode or direction. In the prior attempt,
  reviews twice reproduced a prune at this point silently losing a worktree's
  admin dir and staged index. ib itself still prunes later: on every spawn, on
  `ib rehire`, and when `ib watch` auto-resolves an orphaned-worktree warning
  (`src/health-check.ts`). So every repair failure must be fixed before any of
  those run, and the runbook says when.
- Kill anything, touch refs, rewrite transcript or session contents, edit tracked
  files, or call `ib`.
- Edit `~/.claude.json` (Claude's per-path trust records). Adam's own Claude
  session may be running and writing it, and ib already auto-accepts the trust
  prompt on resume (SPEC §1.6 step 4).

### 2.6 Where absolute paths live

| Location | Holds `<repo>/.ittybitty/…`? | Handling |
|---|---|---|
| `agents/<id>/meta.json` | Only the `tmux_session` prefix. `spawned_by.repo_path` is a repo root. `paths` and `sandbox` only if authored that way | Step 5; step 10a |
| `agents/<id>/start.sh` | Yes: prompt, meta, logs, exit-check, `--settings`, sandbox files. Only run at spawn | Step 5 |
| `agents/<id>/resume.sh` | Yes; rewritten on every resume | Step 5 (tidy) |
| `agents/<id>/exit-check.sh` | No (`src/ib-commands.ts:7616-7664`) | — |
| `settings.local.json`: `agents/<id>/.claude/` (no-worktree and coordinators), `repo/.claude/`, archived copies | Not by construction (`buildAgentSettings`, `src/ib-commands.ts:5834`); only inherited project allow entries could | Step 5, normally a no-op |
| `.retirement/` payload of an interrupted retirement | Copies of the files above | Step 5 |
| `archive/<key>/` | The same files; `retirement.json` holds `repoPath` (a repo root) and `headRef` | Step 5; `headRef` untouched |
| `meta.transient.json`, `*.log`, `debug-logs/`, `prompt.txt`, `sandbox-proxy.*`, `sandbox-domains.txt` | Transient state or history | — |
| Untracked symlinks restored by rehire (`archive/<key>/untracked/`) | Possible, with absolute targets | Step 10b |
| Worktree `.git` file | Points at `<repo>/.git/worktrees/<n>`, which doesn't move | — |
| `<common-dir>/worktrees/<n>/gitdir` | Yes | Step 3 |
| `<common-dir>/worktrees/<n>/modules/**/config` (`core.worktree`) | A relative path through OLD | Step 4 |
| `.agents/hooks.json`, `.agents/rules/…` | The key and the file name | Step 6 |
| `~/.itsybitsy/sealed/sandbox-logs/<hash>` | Keyed by a hash of the agent dir | Step 7 |
| Seal records under `~/.itsybitsy/sealed/` | Keyed by repoId and agentId; `repo-id` moves with the dir | — |
| `~/.itsybitsy/agents/<id>/outbox.jsonl` | Message text | Step 10d |
| `~/.claude/projects/<enc>` | The dir name | Step 8 |
| `~/.claude.json` projects map | Trust per path | Not touched (§2.5) |
| `~/.codex/sessions/**` | The recorded cwd | Not touched; `--cd` (§1.4) |
| `~/.gemini/antigravity-cli/settings.json` | `trustedWorkspaces` | Step 9 |
| agy conversation store | Keying unknown | Not touched; see Risks |

### 2.7 Output and exit codes

```
update-repos.sh — DRY RUN (add --apply to change anything)
Preflight: ok (no agent tmux sessions, no ib processes, no cwd under a runtime dir)
[itsybitsy] /Users/adamwulf/Developer/bun/itsybitsy
  would append 2 lines to .git/info/exclude
  would mv .ittybitty -> .itsybitsy
  would repair 9 worktrees
  would rewrite tmux_session in 41 meta.json (33 archived)
  would rewrite paths in 58 files
  would rename 2 agy rule files and 2 hooks.json keys
  would rename 3 sandbox-log dirs and 612 Claude transcript dirs
  warn  stale worktree entry repo4 -> …/.ittybitty/agents/x/repo (gone; left in place)
[muse-ios] already migrated — nothing to do
[nsf-i-corps] no runtime dir — skipped
[foo] ERROR both .ittybitty and .itsybitsy exist — skipped
Summary: 38 to migrate, 1 already migrated, 20 no runtime dir, 0 missing, 1 error
DRY RUN — nothing was changed.
```

(The counts are illustrative.) `--apply` prints the same lines in the past tense,
then the report-only findings and the log path.

| Exit | Meaning |
|---|---|
| 0 | Done, or nothing to do |
| 1 | At least one repo had an error; the other repos are done |
| 2 | Preflight blocked the run; nothing was done |

### 2.8 Idempotency and rollback

- Every step checks before it acts (dir state, exact old prefix, line present,
  target exists). A re-run over a finished repo takes no actions and leaves every
  byte the same.
- If a run is interrupted at any point, re-run the same command. After step 2 the
  repo classifies as "NEW only", and steps 3 to 10 finish it. Run no `ib` command
  between the interruption and the re-run (§2.5).
- **Rollback** is `--reverse`: a dry run first, then `--reverse --apply`. It swaps
  OLD and NEW in steps 2 to 9, including the tmux prefix, and leaves the
  `info/exclude` lines in place (they are harmless). It uses the same preflight,
  and is followed by reinstalling the old `ib` (runbook R). Retirements made
  after the deploy write `refs/itsybitsy/…` with a matching `headRef`. The old
  binary's validator rejects those, so they can't be rehired under the old
  binary.

## Part 3 — Deploy runbook (Adam)

Run every step in a plain terminal, not inside any agent. The manager that owns
this plan (`ittybitty-paths`) has its worktree under `.ittybitty/`, so everything
below starts after all agents have stopped.

1. **Stop everything (old `ib`).** In `ib watch`, press `P` on each running,
   waiting or complete agent, and note which ones to resume later. Quit `ib watch`,
   which stops `ib-coordinator`. Then check:
   ```sh
   ib list            # every agent stopped
   ib state
   ib state --cleanup
   tmux ls            # no ittybitty-* sessions, no ib-coordinator
   ```
   Close any terminal or Claude, codex or agy session inside an agent worktree.
2. **Merge (old `ib`; don't build).**
   ```sh
   cd ~/Developer/bun/itsybitsy
   ib merge ittybitty-paths --force
   ```
   Merging only changes files. Rebuilding `ib` from this `main` now would break
   the hooks of anything still under `.ittybitty/`. Don't run `bun test` in the
   main checkout before step 4 either.
3. **Dry run.**
   ```sh
   scripts/update-repos.sh | tee ~/update-repos-dry-run.txt
   ```
   Clear every blocker and repo error, then repeat until it is clean. For a
   tracked `.ittybitty/repo-id`, check that repo's `git status` before committing
   the fix.
4. **Apply.**
   ```sh
   scripts/update-repos.sh --apply
   ```
   If it exits 1, fix each listed repair failure now with the printed `git
   worktree repair "<path>"`, and re-run until it exits 0. The next spawn, rehire
   or `ib watch` auto-resolve runs `git worktree prune`, which would delete an
   unrepaired worktree's admin dir. Stale entries reported as "gone" need nothing.
5. **Check.** For a few repos, `git -C <repo> worktree list` shows the agent
   worktrees under `.itsybitsy/`, with nothing `prunable` except the stale entries
   the script listed. `ls -d <repo>/.ittybitty` fails for every registered repo.
   `ls ~/.claude/projects | grep -c -- '--ittybitty-agents-'` drops; dirs for
   unregistered or deleted repos remain.
6. **Build and install.**
   ```sh
   cp "$(command -v ib)" ~/ib.pre-itsybitsy
   bun run build
   sudo cp ib "$(command -v ib)"     # skip if the project dir is on PATH
   ib list-types                      # must print a table
   ```
7. **Global ignore.** Add `.itsybitsy/` and `.agents/rules/itsybitsy-agent.md` to
   your global git excludes file (the one `git config --global
   core.excludesFile` names, or `~/.config/git/ignore`), so repos registered later
   don't trip the spawn dirty-gate. Skip this if Open question 5 makes ib handle
   it.
8. **Restart; test one of each before the rest.** Start `ib watch`. Then, watching
   each with `ib look <id>`:
   - **Claude:** `ib resume <id>`, then `ib send <id> "What were you last working
     on?"`. It should remember.
   - **Codex:** `ib resume <id>`. It should reach its input with no directory
     prompt, and remember.
   - **agy:** `ib resume <id>`. It should start and remember, and `git status` in
     its worktree should not list the rule file.
   - **Rehire:** rehire one old retired agent (legacy ref), if you have one you
     don't mind restoring.
   - **New worker:** `ib new-agent --type worker "Print your working directory,
     which must contain .itsybitsy. Run bun test and bunx tsc --noEmit, report
     the results, and change nothing."`

   Then resume the rest with `ib resume <id>`. Leave per-repo coordinators
   stopped: `ib resume` or `R` on one resets it (`src/ib-commands.ts:1698-1709`).
   Agents whose branches predate the rename run old-name source, so rebase them
   before trusting their test results.
9. **Later.** After a week of normal use, delete `~/ib.pre-itsybitsy` and any
   `*.pre-itsybitsy` agent-type backups.

**R. Rollback.**

1. Stop everything as in step 1. If `ib watch` is what failed, don't rely on it:
   run `ib pause <id>` for each agent.
2. Run:
   ```sh
   scripts/update-repos.sh --reverse
   scripts/update-repos.sh --reverse --apply
   sudo cp ~/ib.pre-itsybitsy "$(command -v ib)"
   ib list-types
   ```
3. Run `git revert -m 1 <merge commit>` before any later rebuild.
4. Check any codex or agy agent you resumed after the deploy with `ib look <id>`:
   its session now records the new path.

## Part 4 — Tests

### 4.1 Code rename

- **`src/runtime-names.test.ts`:** the path builders; a tmux build/parse round
  trip with an agent ID that contains `ittybitty`; `isRetiredHeadRef` true for
  both names and false for anything else; each path parser on its current shape,
  including a worktree nested inside another and a repo path that contains the
  word `ittybitty`.
- **Refs** (`src/agent-lifecycle.test.ts` and the rehire tests in
  `src/ib-commands.test.ts`, using real temp git repos):
  - Retire writes `refs/itsybitsy/…`, and the manifest names it.
  - Manifest validation accepts both names.
  - Rehire with only the legacy ref uses it.
  - With both refs, rehire uses the itsybitsy ref, even when the manifest names
    the legacy one.
  - An itsybitsy ref pointing at the wrong object fails as corrupt, with no
    fallback.
  - With neither ref, rehire fails with an error naming both.
  - `archiveAgent` deletes a pending legacy ref and a pending new ref.
- **`src/codex-spawn.test.ts`:** resume content contains `--cd '<worktree>'`, if
  §1.4 is approved.
- **Guard test:** §1.6.
- **Mechanical updates:** the 60 test files that use the old name (59 under
  `src/` plus `tests/parse-state.test.ts`),
  `tests/fixtures/claude-resume-sh-baseline.sh`,
  `src/fixtures/codex-snapshot-input-fail-{1..6}.txt` and
  `src/fixtures/snapshot-idle-prompt-{1,2}.txt`. Use
  exact path and prefix replacements, not a blanket word replace: agent IDs in
  fixtures may legitimately contain the word.
- **HOME/repo collapse.** After the flip, a test that uses one temp dir as both
  `HOME` and the repo gets `<tmp>/.itsybitsy` as both the user-wide home and the
  repo's runtime dir. Working dirs then resolve to `@system`, and assertions pass
  without proving anything. The prior attempt found this in
  `src/ib-commands.test.ts`, `src/agent-lifecycle.test.ts`,
  `src/health-check.test.ts` and `src/hooks/agent-path.test.ts`. Before flipping
  names, audit every `setUserHome`, `setCoordinatorHome` and `process.env.HOME`
  fixture (43 test files) and give each test a separate HOME and repo.
- **CLI tests** keep using `runIsolatedCli` and `createCliFixture`
  (`src/test-cli-runner.ts`), never a direct `Bun.spawn` of an entry point.
  `isolatedTempRoot` checks only the new name.
- **Gate:** `bun test` and `bunx tsc --noEmit`. For the entry-point check, build
  to a scratch `--outfile` (never over the `ib` on PATH) and confirm that
  `<scratch>/ib list-types` prints a table. All of this runs from the
  implementer's worktree, which is still under `.ittybitty/`; runbook step 8 tests
  the real new layout.

### 4.2 The script: `src/update-repos-script.test.ts`

Each test runs `bash scripts/update-repos.sh` with `Bun.spawn` and an explicit
env, because Bun ignores later edits to `process.env`:

- `HOME=<tmp>/home`
- `PATH=<tmp>/stubs:/usr/bin:/bin`
- `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=<tmp>/gitconfig`
- `TMPDIR`, and a cwd outside the checkout

The script isn't an `ib` entry point, so the AGENTS.md `test-cli-runner` rule
doesn't apply. Still, the stubs dir holds an `ib` that records its argv and exits
97, and every test asserts that it never ran.

**Stubs.** `tmux`, `ps` and `lsof` print canned output from files the test writes,
so these tests use **no real tmux**. If a test ever needs real tmux, every call
takes `-L <unique socket>`: a test once ran `kill-server` on the real server and
killed every agent. A `git` wrapper stub logs its argv and then execs
`/usr/bin/git`.

**Fixture** (temp git repos, temp HOME):

- A repo whose path has a space and contains `ittybitty`, plus a second repo.
- A worktree agent with a staged change and an ID that contains `ittybitty`.
- A nested worktree at `agents/<id>/repo/.claude/worktrees/wip` with a staged
  change.
- A no-worktree agent.
- An agy worktree with a rule file and `hooks.json`.
- An archived retired agent: old `tmux_session`, a `retirement.json` with the
  legacy `headRef`, and the legacy ref.
- A stale admin entry whose worktree is gone.
- Transcript dirs for both path forms, an agy `settings.json`, a sandbox-log dir
  under the old hash, and `repos.json`.

**Cases:**

1. **Dry run:** the tree is identical before and after (names and content hashes
   under the temp root), planned actions are printed, exit 0.
2. **Apply:**
   - The dir is renamed.
   - Each worktree, nested one included, resolves with `rev-parse
     --show-toplevel`, and its staged changes are intact.
   - Admin `gitdir` files point at NEW, and the stale entry is still present.
   - `tmux_session` is rewritten in active and archived meta.
   - `headRef` and the legacy ref are unchanged.
   - Transcripts, agy files, the trust entry and the sandbox-log dir have moved.
   - The exclude lines are present, and `git status --porcelain` in the main
     checkout is empty.
   - Repo paths and agent IDs that contain the word are unchanged.
   - The git log has no `git worktree prune`, and the `ib` stub never ran.
3. **Re-run after apply:** no actions, bytes unchanged, exit 0.
4. **Interrupted runs:** a fixture already moved but with old admin entries
   (killed after step 2) is finished by a re-run. With only the exclude lines
   written (killed after step 1), a re-run migrates it.
5. **Both dirs in one repo:** that repo errors, the other migrates, exit 1.
6. **Each preflight blocker** exits 2 with nothing written: tmux showing
   `ittybitty-…` or `ib-coordinator`, an unexpected tmux error, `ps` showing `ib
   watch`, `lsof` showing a cwd under OLD. "no server running" passes.
7. **A tracked file inside OLD:** a repo error with the fix command.
8. **Round trip:** `--apply` and then `--reverse --apply` restore the original
   tree, except the exclude lines.
9. **New code on migrated data** (in process, HOME seam via `setUserHome`, spawn
   runners stubbed): `readAllAgents` finds the migrated agents, and `rehireAgent`
   on the migrated archive passes its tmux check and resolves the legacy ref.

## Part 5 — Cross-cutting checklist

1. **General agent functionality.** Paths, tmux names and new retired refs
   change. Spawn, resume, rehire, merge, retire and nuke all go through
   `src/runtime-names.ts`. The `meta.json` shape doesn't change, only the
   `tmux_session` value. Rehire gains the legacy-ref fallback, and codex resume
   gains `--cd` if that is approved.
2. **Hooks.** Every hook that identifies an agent from its cwd
   (`hooks/shared.ts`, `hooks/main-path.ts`, `hooks/session-start.ts`,
   `hooks/intercept-task.ts`, `hooks/agent-context.ts`,
   `hooks/slow-hook-logger.ts`, `hooks/paths-table.ts`) uses the module's parsers
   with unchanged semantics, so path isolation allows and denies exactly what it
   does today. The agy protected-file list follows `AGY_WORKTREE_FILES`. The tags
   become `<itsybitsy>` and `<itsybitsy-status>`. The module imports only
   `node:path`, so hook start-up cost stays the same. Hooks call the installed
   `ib`, which is why the runbook never mixes a binary with the wrong layout.
3. **Watchdog.** It finds agents through the module and uses `meta.tmux_session`,
   which the script rewrites; orphan detection uses the new prefix. No change to
   timing, nudges or rate-limit recovery. No watchdog may be running during the
   script (P3).
4. **`ib watch`.** `src/watcher.ts` watches `<repo>/.itsybitsy/agents/` and
   `user-questions.json`. Debug-log paths, health checks and orphan detection use
   the module. No layout or input change. Its orphaned-worktree auto-resolve runs
   `git worktree prune`, so repair failures are fixed before it starts (runbook
   step 4).

## Risks

| Risk | Handling |
|---|---|
| Claude `--resume` can't find the session at the new cwd | Step 8 renames the transcript dirs; runbook step 8 checks that one agent remembers |
| Codex prompts about the changed cwd, or rejects `--cd` | Runbook step 8 checks one codex agent before the rest; rollback is available |
| agy resume from a moved dir is unverified (its conversation store wasn't inspected) | Runbook step 8 checks one agy agent; the fallback is a fresh agent |
| A repair fails, and a later prune drops that worktree's admin dir and index | The script never prunes, exits 1 naming each failure, and runbook step 4 fixes them before anything can spawn |
| Gitignored build output in a worktree holds old absolute paths (`.build`, `DerivedData`, virtualenvs) | Not scanned. If a resumed agent's build errors mention `.ittybitty`, do a clean build in that worktree |
| Another branch adds old names after this lands | The guard test fails on rebase |
| A registered repo is offline during the run | It is reported "missing — skipped". Run `scripts/update-repos.sh <path>` before using ib there |

## Open questions for Adam

1. **Agent-type prose.** Should the script rewrite the 9
   `~/.itsybitsy/agent-types/*.md` files ("IttyBitty Worker Agent", "the
   ittybitty multi-agent orchestration system"), keeping `.pre-itsybitsy`
   backups? These are injected into every agent's session start.
   *Recommendation:* yes. The alternative is to edit them by hand.
2. **Claude transcripts.** Should the script rename the
   `~/.claude/projects/<repo>--ittybitty-agents-*` dirs (step 8)? There are about
   4,865 such dirs across all repos today, and only registered repos' prefixes
   would be touched. Without this, every stopped Claude agent's resume and every
   rehire probably starts without its conversation, and auto-compact's
   transcript reads (`src/auto-compact.ts`) miss. *Recommendation:* yes.
3. **Codex resume.** Add `--cd <worktree>` to `codex resume` (§1.4, unverified
   here), or accept that moved codex agents may stop at a prompt or need a fresh
   start? *Recommendation:* add it, once the flag is confirmed.
4. **agy sessions.** The script moves no agy data, only the trust list and the
   worktree files. If agy can't resume from the new path, is starting those agents
   fresh acceptable?
5. **Future repos.** ib writes no ignore entry for its runtime dir today. Should
   `ib` append `.itsybitsy/` to `<common-dir>/info/exclude` when it first creates
   the runtime dir (`getRepoId`, `askQuestion`, `newAgent`), instead of relying on
   the global excludes file (runbook step 7)? This also covers repos made by the
   unmerged "New Repo" button on `agent/create-repo`. Related and optional: refuse
   to create `.itsybitsy/` while `.ittybitty/` exists, pointing at the script. That
   is one existence check at those three creation sites, never on a hook path.
   *Recommendation:* yes to the exclude. The refusal is cheap insurance against a
   skipped repo, but it is new code, so it's your call.
6. **`$HOME` as a repo.** After the rename, a repo registered at `$HOME` would
   have its runtime dir at `~/.itsybitsy/`, colliding with the user-wide home
   (registry, and the outboxes at `~/.itsybitsy/agents/<id>/`). Should `addRepo`
   (`src/registry.ts`) refuse `$HOME`? That is about 3 lines.
   *Recommendation:* yes. The prior attempt also hardened the hook parsers against
   a planted `~/.itsybitsy/agents/<id>/repo`. That is adversarial-state work, so it
   is left out unless you want it.
7. **Tidy-only steps.** Steps 7 (sandbox-log dirs; the kernel sandbox is currently
   off) and 9 (agy trust list) only prevent stale leftovers. Keep them or drop
   them?
8. **Rollback flag.** Keep `--reverse`, which is cheap because the script is
   parametric and one round-trip test covers it? Or drop it and roll back by hand?
9. **Tracked runtime files.** The prior attempt found that `adamwulf-hugo` tracks
   `.ittybitty/repo-id` (not re-checked here; blocked). The script refuses such a
   repo and prints the `git rm -r --cached` and commit for you to run. Is that
   right, or should the script make that commit itself?

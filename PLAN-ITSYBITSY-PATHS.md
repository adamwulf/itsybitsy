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
   repo's `<repo>/.ittybitty/` to `<repo>/.itsybitsy/` once. The migration is
   **one-way**: the script has no reverse mode, and once it has run the fix is
   always forward.
3. Only retired-agent git refs keep the old name. New retirements write
   `refs/itsybitsy/retired/<archiveKey>/head`. `ib rehire` tries that ref first
   and falls back to `refs/ittybitty/retired/<archiveKey>/head` only when it is
   not found. No other dual-read: no reading `.ittybitty/`, no matching
   `ittybitty-` tmux sessions.
4. The script always rewrites the prose in `~/.itsybitsy/agent-types/*.md`, with
   no backups (that dir is already in git).
5. The script renames the Claude transcript dirs for moved worktrees.
6. Codex needs no change: spawn and resume already start tmux with `-c
   <worktree>`. Any codex cwd prompt is a separate issue.
7. If an agy agent can't resume from the moved path, starting it fresh is fine.
8. `addRepo` refuses `$HOME`.
9. No new ib code writes ignore entries or refuses to create `.itsybitsy/`. The
   script's per-repo `info/exclude` step and the runbook's global-excludes step
   cover ignoring.
10. A repo that tracks a file inside `.ittybitty/` is still migrated; the script
    prints the fix afterwards.

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
| Agent-type prose in `~/.itsybitsy/agent-types/*.md` | `IttyBitty`, `ittybitty` | `ItsyBitsy`, `itsybitsy` | script |

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
| `~/.itsybitsy/agent-types/*.md` | 9 files (`opus`, `sonnet`, `manager`, `researcher`, `coordinator`, `worker`, `assistant`, `fugu`, `gemini`) say "IttyBitty … Agent" or "the ittybitty … orchestration system" in prose. None in `paths:`, and none name a path |
| `~/.claude/projects/` | 4,865 dir names containing `--ittybitty-agents-`. Claude replaces every non-alphanumeric character with `-` (`Filing-Cabinet`). No name is 180 characters or longer |
| `~/.claude/settings.json` | No old name |
| My worktree's `.git` file | `gitdir: <repo>/.git/worktrees/repo7`: an absolute path into the main repo. So a move doesn't break this direction of the link, and `worktree.useRelativePaths` was not in effect when this worktree was made |

**Blocked** by path isolation or the Bash allow list: the main checkout and its
`.git/` (including `info/exclude`); other repos' `.gitignore` and `.git/`; every
agent dir (`<repo>/.ittybitty/agents/<id>/`, my own included); the global git
excludes file and global git config (`~/.config/git/ignore`, `git config
--global`); `codex resume --help`; `git --version`; the Claude binary.

So:

- The per-agent file inventory in §2.6 comes from the code that writes those
  files, not from real dirs.
- How other repos ignore `.ittybitty/` today is unknown. ib writes no ignore entry
  for it, so it is probably Adam's global excludes file.
- The prior attempt reported that `adamwulf-hugo` tracks `.ittybitty/repo-id`; I
  could not re-check that.
- I could not confirm Claude's project-dir truncation rule (names over 200
  characters are said to be cut and given a hash suffix) against the installed
  Claude. No current name is long enough for it to matter (§2.4 step 7).

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
  `repoIdFile(repo)`, `userQuestionsFile(repo)`. There is deliberately no
  `storageDir(repo, id, archived)` builder: its archived branch would build
  `archive/<id>`, which never exists, because archives are named
  `archive/<YYYYMMDD-HHMMSS>-<id>`. The sites using that pattern
  (`src/tui/agent-actions.ts:96,1555`, `src/index.ts:2635`) either call the
  existing `agentStorageDir(agent)` (`src/agents.ts:1628`) or keep an inline
  `join(runtimeDir(repo), dir, id)`.
- **tmux:** `tmuxSessionName(repoId, agentId)`, `agentIdFromTmuxSession(name)`
  (`^itsybitsy-[a-f0-9]{8}-(.+)$`), `isAgentTmuxSession(name)` (prefix test).
- **Refs:** `retiredHeadRef(key)`, `legacyRetiredHeadRef(key)`,
  `isRetiredHeadRef(ref, key)` (true for either name).
- **Path parsing:** one helper per shape in use today (table in 1.2). Keep each
  call site's current semantics: first or last occurrence, exact match or prefix,
  `/repo` required or not, agent ID extracted or not. This is a rename, not a
  behavior change. There are three intentional tightenings; list all three in the
  commit message, and test each:
  1. Several current regexes leave the dot unescaped (`/.ittybitty\/agents/`).
     The helpers escape it.
  2. `AGENT_CWD_PATTERN` (`src/hooks/shared.ts:14`) and `AGENT_WORKTREE_PATTERN`
     (`src/hooks/main-path.ts:26`) have no leading `/`, so a dir named
     `x.ittybitty` would match. The helpers require the `/`.
  3. The worktree-prefix sites end at `\/repo` with nothing after it, so
     `…/agents/<id>/repository` also matches: `ib-commands.ts:3986, 6111, 6170,
     6344`, `index.ts:1834, 1862, 2554, 2612` and `isRunningAsAgent`
     (`agent-lifecycle.ts:1041`). The helpers end with `\/repo(\/|$)`, as
     `AGENT_CWD_PATTERN` and `AGENT_WORKTREE_PATTERN` already do.

**The `~/.itsybitsy/agents/<id>` overlap.** After the rename, the user-wide
per-agent dirs (`~/.itsybitsy/agents/<id>/`, holding `outbox.jsonl` and
`claude-rate-limits.json`; `agentOutboxDir`, `src/outbox.ts:51`) have the same
shape as a repo's runtime agent dir. That is safe in normal use, for two reasons:

- Nothing creates `~/.itsybitsy/agents/<id>/repo`, so the worktree parsers, which
  require `/repo`, never match those dirs.
- `resolveAgentFromCwd` resolves any cwd at or under the user-wide home to
  `@system` before it tries the worktree pattern (`src/hooks/shared.ts:85`).

The parsers that do not require `/repo`, and so would match a
`~/.itsybitsy/agents/<id>/…` path, are:

- `hooks/slow-hook-logger.ts:22,28`
- `hooks/agent-context.ts:335,376`
- `scanAndKillOrphans` (`agent-lifecycle.ts:965-968`)
- `hooks/intercept-task.ts:432`
- `isValidAgentDir` (`generate-summary.ts:38`)
- `isolatedTempRoot` (`test-cli-runner.ts:74`)

No process runs with its cwd there and no caller passes such a path, so their
behavior doesn't change; the tests in §4.1 pin it. Hardening the parsers against
a planted `~/.itsybitsy/agents/<id>/repo` is adversarial-state work and is left
out.

### 1.2 Route every use through it

| Category | Sites (non-test `src/`) |
|---|---|
| `join(…, ".ittybitty", …)` (about 90 joins in about 28 files) | `agent-lifecycle.ts`, `agents.ts` (including `agentStorageDir`), `auto-compact.ts`, `coordinator.ts` (`checkCoordinatorExists`), `health-check.ts`, `hooks/agent-context.ts`, `hooks/agent-path.ts`, `hooks/inject-status.ts`, `hooks/paths-table.ts` (`REPOID`), `hooks/session-start.ts`, `hooks/shared.ts`, `ib-commands.ts` (including `getRepoId`, `loadCustomPrompts`, `askQuestion`, and the sandbox roots `REPOAGENTS`/`REPOID` at :1178 and :1239-1241), `index.ts`, `lifecycle-broker.ts`, `no-worktree-caller.ts`, `resolve-target.ts`, `send-broker.ts`, `spawn-broker.ts`, `state-command.ts` (the registered-repo prefix in `cwdUnderRegisteredWorktree`, :351), `tui/agent-actions.ts` (including the debug-logs template string at :2541), `watchdog.ts`, `watcher.ts`, `test-cli-runner.ts` (fixture builders at :233 and :239) |
| Agent ID from a worktree cwd (requires `/repo`) | `AGENT_CWD_PATTERN` (`hooks/shared.ts:14`), `ib-commands.ts:3986-3990, 6111-6115, 6170-6176, 6343-6351`, `index.ts:1834, 1862, 2554, 2612` |
| Is a worktree path (requires `/repo`; no ID) | `AGENT_WORKTREE_PATTERN` (`hooks/main-path.ts:26`), `isRunningAsAgent` (`agent-lifecycle.ts:1041`) |
| Repo root from the **first** `/.ittybitty/agents/` (no ID) | `hooks/shared.ts:100`, `hooks/session-start.ts:71,938` (both after `AGENT_CWD_PATTERN` matched), `hooks/intercept-task.ts:432` (does not require `/repo`) |
| Repo root from a lazy regex (requires `/repo`) | `index.ts:287`; `no-worktree-caller.ts:118`, which also extracts the ID |
| Exact worktree root (plus `lastIndexOf`) | `resolve-target.ts:99-102`, `index.ts:2139-2141` |
| Agents-dir or agent-dir prefix (greedy; `/repo` not required) | `hooks/slow-hook-logger.ts:22,28`, `hooks/agent-context.ts:335,376`, `scanAndKillOrphans` (`agent-lifecycle.ts:965-968`) |
| Exact agent dir, or suffix | `isValidAgentDir` (`generate-summary.ts:38`), `hooks/agent-context.ts:142` |
| Substring guard | `isolatedTempRoot` (`test-cli-runner.ts:74`): checks only the new name |
| tmux name | built at `ib-commands.ts:744` (rehire) and :6914 (spawn); parsed by `extractAgentIdFromTmuxSession` (:8064-8090); prefix checks in `cleanupOrphanedTmuxSessions` (:1369-1395), `agents.ts:2767-2779`, `isItsybitsyTmuxSession` (`state-command.ts:192`), `isRunningAsAgent` (`agent-lifecycle.ts:1049`) |
| Retired refs | §1.3 |
| agy | `AGY_WORKTREE_FILES` (`agy-worktree-files.ts:14`, which is also the protected-file list in `hooks/agent-path.ts:328,376`), `writeAgyWorktreeFiles` (`agy-spawn.ts:473`), the hook key in `buildAgyHooksJson` (`agy-config.ts:88`), the denial message at `hooks/agent-path.ts:194` |
| Prompt tags | `hooks/session-start.ts` (each wrapper, and the `lastIndexOf("</ittybitty>")` splice at :306), `stripItsybitsyWrapper` (`agent-instructions-shared.ts:53-54`), `hooks/inject-status.ts:63,84`. The strip needs only the new tag: it runs on freshly generated text, and nothing reads tags back from a transcript |
| Codex writable roots | `deriveCodexParentRepoRoots` (`ib-commands.ts:1315`, `[".ittybitty", ".claude"]`) |
| Comments | `ask-broker.ts`, `outbox.ts`, `sandbox.ts`, `teams.ts`, `validation.ts`, `agents.ts`, `agy-*.ts`, `hooks/agent-status.ts:556-557`; renamed so the guard test passes |

The root `index.ts`, `test-preload.ts`, `build.sh`, `package.json` and
`scripts/probe-sandbox-denials.ts` have no old name.

### 1.3 Retired refs

| Site | Change |
|---|---|
| `prepareAgentRetirement` (`agent-lifecycle.ts:320`) | `headRef = retiredHeadRef(archiveKey)`; the manifest records the new name |
| `parseRetirementManifest` (:120-123) | Accept `isRetiredHeadRef(raw.headRef, raw.archiveKey)`, so old archives keep validating. Rehire authorization also depends on this: `checkManagerCommandAccess` (`hooks/agent-path.ts:1622-1652, 1733`) prefers archives whose manifest parses |
| `archiveAgent` pending-payload cleanup (:614-628) | Same predicate; delete exactly the ref the pending manifest names. A retirement interrupted under the old binary names the old ref |
| `prepareAgentRetirement` catch (:350) and `cleanupPreparedRetirement` (:362) | No change: they delete the ref this run created, which always has the new name |
| `rehireAgent` (`ib-commands.ts:842-880`) | New `resolveRetainedHeadRef(repoPath, archiveKey)` in `agent-lifecycle.ts`. It runs `git rev-parse --verify --quiet <ref>^{commit}` on `retiredHeadRef(key)`, then on `legacyRetiredHeadRef(key)`, and the first that resolves wins. The order is fixed: it ignores which name the manifest recorded. If the found ref's object differs from `manifest.gitHead`, fail as corrupt with no fallback, because the fallback is only for "not found". If neither resolves, fail with an error naming both refs. `git worktree add` uses the ref that was found |

Nothing else creates, moves or deletes retired refs (checked with a grep for
`update-ref` and `retired/`). The sandboxed path (`src/lifecycle-broker.ts:281`,
`ownArchiveOnly`) calls the same functions.

### 1.4 `addRepo` refuses `$HOME`

After the rename, a repo registered at `$HOME` would put its runtime dir at
`~/.itsybitsy/`, colliding with the user-wide home (the registry, and the
per-agent dirs under `~/.itsybitsy/agents/`). In `addRepo`
(`src/registry.ts:142`), refuse a path whose real path equals the real path of
`userHome()`, with a clear message. This takes about 3 lines, plus a test in
`src/registry.test.ts`. The script also refuses such a repo (§2.3).

### 1.5 `.gitignore` and docs

- `.gitignore:36,51` become `.itsybitsy/` and `.agents/rules/itsybitsy-agent.md`.
  No old lines are kept (decision 1): after the script, no `.ittybitty/` exists.
- `SPEC.md`: change every hit of `git grep -n -i ittybitty SPEC.md` except the
  bash-reference callouts: §7.1 (line 1075), §7.5 (line 1144), the bash half of
  the §1.8 callout (line 332), and §8.8 (line 1386). Also fix the §6.0 table,
  which misspells the name as `.ittybitsy` (lines 813-814). Document the ref
  fallback in §1.7.1 and the `$HOME` refusal in §9.
- Move these docs to the new names: `SPEC-SANDBOX.md`, `SPEC-PATH-ALLOWLIST.md`, `SPEC-CODEX-MODEL.md`,
  `SPEC-ANTIGRAVITY-CLI.md`, `docs/implementation-notes.md`, `README.md`,
  `RENAME-PLAN.md`, `SPAWNER-TRACKING-PLAN.md`, `ANTIGRAVITY-CLI-NOTES.md`,
  `CODEX-CLI-NOTES.md`, `docs/*.md`, `docs/plans/ib-rehire.md`, `research-*.md`
  and `research/*`. Keep text about the bash reference project. Mark `PLAN.md`
  Phase 25 as superseded by this file.
- In the `AGENTS.md` orientation table, add `src/runtime-names.ts` and
  `scripts/update-repos.sh`.

### 1.6 Guard test: yes

Add `src/runtime-names-guard.test.ts`, covering every tracked `*.ts` except
`*.test.ts` (`git ls-files '*.ts'`, which includes the root `index.ts` and
`test-preload.ts`), every `docs/agent-types/*.md`, and `.gitignore`. It fails on:

- `/ittybitty/i` anywhere, except the one `LEGACY_RETIRED_REF_ROOT` line in
  `src/runtime-names.ts`.
- Any `.itsybitsy` in non-comment code outside `src/runtime-names.ts`. A comment
  line is one whose trimmed text starts with `//`, `/*` or `*`. This catches
  every hand-built per-repo path, whatever the form: joins to `agents`,
  `archive`, `repo-id`, `user-questions.json` or `prompts`, a join with a
  variable, a bare `join(repoPath, ".itsybitsy")`, a literal in `indexOf` or
  `includes`, a template string, or a regex with an unescaped dot. There are two
  exceptions for the user-wide home:
  1. `join(<first argument>, ".itsybitsy", …)`, where the text of the first
     argument contains `home` or `Home` (`join(userHome(), …)`, `join(home, …)`,
     `join(registryHome, …)`, `join(sealHome(home), …)`, `join(config.home, …)`).
  2. The text `~/.itsybitsy` anywhere in a string. User-facing messages put it
     mid-string (for example `src/config.ts:133-143`, `src/index.ts:632`), so the
     exception can't require the string to start with it.

  Every user-wide code site on `main` fits one of these, except
  `test-preload.ts:33` (`join(base, ".itsybitsy", "watch.log")`): rename `base` to
  `fakeHome` there.

Two reasons for the guard: `docs/agent-types/` is compiled into the binary and
holds the `paths:` floor, and other branches will rebase onto this change and
must not bring the old name back or bypass the module. Test files aren't guarded,
because the fallback and script tests need the old name.

### 1.7 Left out of the code change

- Detecting or refusing a leftover `.ittybitty/`, and writing ignore entries from
  ib (decision 9).
- Any codex change (decision 6).
- An `ib migrate-*` subcommand or any compatibility layer.
- `encodeClaudeProjectPath` (`src/auto-compact.ts:22`) replaces only `/` and `.`,
  but Claude also replaces spaces and other characters. That existing bug belongs
  in a separate change; the script uses Claude's real rule.
- Out of scope even though they touch these names: `cleanupOrphanedTmuxSessions`
  killing other repos' sessions (keep the current behavior),
  `scanAndKillOrphans` ignoring its `agentsDir` argument, and the health check's
  orphaned-dir false positive (it predates this change).

## Part 2 — `scripts/update-repos.sh`

### 2.1 Form

- It lives at `scripts/update-repos.sh`, mode 755, `#!/bin/bash`, `set -u -o
  pipefail`.
- **It must run on macOS's bash 3.2.** That means no associative arrays, no
  `mapfile`, and no `**` globs (`globstar` is bash 4), so it uses `find`
  instead. Under `set -u`, bash before 4.4 treats `"${arr[@]}"` on an empty array
  as an unbound-variable error: write `${arr[@]+"${arr[@]}"}`, or avoid arrays.
- It uses only `git` 2.31 or later, `perl` (literal replacements with `\Q…\E`,
  values passed in environment variables; core `JSON::PP` to read `repos.json`),
  `ps`, `lsof`, read-only `tmux`, `mv` and `find`.
- It never calls `ib`, because the installed binary may be either the old one or
  the new one.
- Read-only git calls use `git --no-optional-locks`, so a dry run doesn't even
  refresh an index.
- It uses `git -C "<path>"`. The "no `-C`" rule in Adam's CLAUDE.md governs
  agents' own tool calls, not script content.
- It checks the exit status of every write; §2.4 says what a failure stops.

```
scripts/update-repos.sh [--apply] [REPO_PATH ...]
```

- With no flags it is a **dry run**: it prints every action it would take and
  every blocker, and writes nothing, not even a log.
- `--apply` makes the changes and tees its output to
  `~/.itsybitsy/migrations/update-repos-<YYYYMMDD-HHMMSS>.log`.
- `REPO_PATH ...` limits the repo steps to those repos. The default is every
  `path` in `~/.itsybitsy/repos.json`. Each path is also resolved to its git
  toplevel, because `newAgent` puts the runtime dir at
  `resolveGitRoot(repoPath)`. Duplicates are dropped by real path.

### 2.2 Preflight

Preflight covers the whole run, reads only, and finishes before the first write.
Any failure prints each blocker with what clears it, exits 2 and writes nothing.
It runs in dry runs too.

| # | Check | How (nothing is killed) | What clears it |
|---|---|---|---|
| P1 | Not run from inside a runtime dir | `pwd -P` contains neither `/.ittybitty/` nor `/.itsybitsy/agents/` | Run it from a plain terminal |
| P2 | No agent or coordinator tmux session | `tmux list-sessions -F '#{session_name}'`; any `ittybitty-*`, `itsybitsy-*` or `ib-coordinator` session blocks. A non-zero exit saying "no server running" or "error connecting to" means no sessions; any other failure blocks (fail closed) | Press `P` on each agent in `ib watch`, then quit it (there is no `ib pause` command) |
| P3 | No `ib` process: `ib watch`, watchdogs, proxies, the collector, hooks | `ps -Ao pid=,args=`, matching a first argument whose basename is `ib` | Quit `ib watch`. Watchdogs exit about 10 seconds after their session ends. A leftover proxy or collector: `kill <pid>` |
| P4 | No process has its cwd under any target repo's `.ittybitty/` or `.itsybitsy/` | `lsof -a -u "$(id -u)" -d cwd -Fpn`, compared with both the registered and the real repo paths. An `lsof` failure blocks | Close that terminal or Claude, codex or agy session |
| P5 | Tools present | `git` 2.31 or later (for `--path-format=absolute`; `worktree repair` and `worktree lock --reason` are older), `perl -MJSON::PP -e1` | Install the tool |
| P6 | Registry readable, when no paths are given | Parse `~/.itsybitsy/repos.json` | — |

`$HOME` must be set and absolute. P2 and P4 check both names because a re-run
after the deploy (for example, for a repo that was offline) must also see
sessions started by the new binary.

### 2.3 Per-repo classification

Below, OLD is `.ittybitty` and NEW is `.itsybitsy`.

**Classification fails closed.** `[ -d ]` and `[ -e ]` return false on `EPERM`
or `EACCES` too, so a denied stat would quietly skip a repo as "missing" or "no
runtime dir". Instead, the script stats the repo path, OLD and NEW with perl
(`lstat`, then `$!{ENOENT}`). Only `ENOENT` counts as absent; any other error is
a repo error naming the errno. Likewise, a dir counts as non-git only when `git
rev-parse` says "not a git repository"; any other git failure is a repo error.
If any `OLD/agents/*/repo/.git` exists, the repo must be a working git repo, or
it is a repo error before step 1.

| Found | Result |
|---|---|
| The repo path is absent (`ENOENT`) | Warn "missing — skipped". Not an error |
| Any stat of the repo path, OLD or NEW fails other than `ENOENT` | Error naming the errno; skip the repo |
| The repo path is `$HOME` | Error; skip the repo. The message says to `ib remove` that entry before the deploy: `addRepo`'s new refusal (§1.4) only stops new entries and doesn't clean up existing ones |
| Both OLD and NEW exist | Error; skip the repo; other repos continue. The likely cause is a repo skipped earlier as missing, in which the new `ib` then wrote a fresh `.itsybitsy/repo-id` (`getRepoId` and `askQuestion`, `src/ib-commands.ts:5825, 8545`; also `ib sandbox seal --repo-id`, `src/index.ts:2193-2196`). If NEW holds nothing but `repo-id` and empty dirs, the error tells Adam to remove it (`rm -rf '<repo>/.itsybitsy'`) and re-run; the real `repo-id` is the one in OLD. Otherwise it prints what NEW holds (counts of `agents/*`, `archive/*` and `prompts/*`, and whether `user-questions.json` exists) and tells Adam to merge the two dirs by hand before re-running |
| OLD is a symlink | Error; skip the repo |
| OLD only | Migrate: every step |
| NEW only | Already moved. Run steps 3 to 8, which find nothing to do in a finished repo, and print "already migrated — nothing to do". This is also how an interrupted run finishes |
| Neither | "no runtime dir"; skip the repo |

**A file tracked inside OLD** (`git ls-files -- .ittybitty` is not empty) does
not stop the repo; it is migrated like the rest. After the move the script warns
and prints the fix for Adam to run: `git -C <repo> rm -r --cached .ittybitty`,
then a commit. Until that is done, the deleted tracked file makes the checkout
dirty, so ib refuses to spawn there.

A registered dir that git reports as "not a git repository" (`ib add` allows
that), and that has no worktree under OLD, skips the git steps 1, 3 and 4.

### 2.4 Steps

These run in `--apply`; a dry run prints each one as "would …".

**Failure policy.** A failed write in step 1 or step 2 ends that repo: no later
step runs for it. For example, if `mv` fails with `EPERM` on the
`~/Library/Containers/…` repo, its transcripts must not be renamed away. A
failure in step 3 or later is a repo error that sets exit 1. The remaining steps
for that repo still run, and a re-run finishes it.

| # | Step | Detail |
|---|---|---|
| 1 | Ignore rules | Append `.itsybitsy/` and `.agents/rules/itsybitsy-agent.md` to `$(git rev-parse --path-format=absolute --git-common-dir)/info/exclude`, under a `# added by itsybitsy scripts/update-repos.sh` comment, each only if that exact line is missing. (Without `--path-format=absolute`, a main worktree returns the relative `.git`.) Every worktree shares this file, and no tracked file changes. It is needed because the spawn dirty-gate (`src/ib-commands.ts:6487-6514`) refuses on `?? .itsybitsy/`, and agy resume writes the new rule file, which old worktree `.gitignore` files don't list. It runs before the move, so `git status` stays clean |
| 2 | Move | `mv <repo>/OLD <repo>/NEW`: one `rename(2)` that carries `agents/`, `archive/`, `prompts/`, `repo-id` and `user-questions.json` |
| 3 | Repair worktrees, immediately | Look at each `<common-dir>/worktrees/*/gitdir` that names an absolute path under `<repo>/OLD/`, in either the registered or the real path form. The new path is the same path under NEW. If `<new>/.git` exists, run `git -C <repo> worktree repair "<new dir>"`, one path per call, because the command exits 1 if any path is bad even when it fixed the others. Working from admin entries also covers nested worktrees such as `agents/<id>/repo/.claude/worktrees/<name>` (Claude's `isolation: "worktree"`). Then verify two things, comparing **real paths** in both: `git -C <new dir> rev-parse --show-toplevel` equals the new dir (in a dir without `.git` the command falls through to the parent repo and still succeeds), and the admin `gitdir` now names `<new dir>/.git`. The second compare must use real paths too, because repair writes the real path (`/private/var/…`), and a literal compare against `/var/…` would fail falsely, lock the entry and exit 1. A failed repair is handled as below. A relative `gitdir` (`worktree.useRelativePaths`, not in use here) that resolves, against its admin dir, under `<repo>/OLD/` is not supported: it is a repo error handled the same way. If `<new>/.git` is missing, warn "stale entry, left in place" |
| 4 | Submodules in worktrees | For each `config` file that `find "<common-dir>/worktrees" -path '*/modules/*' -name config` finds, replace the `/OLD/agents/` segment in a `core.worktree` that contains it (`git config --file`). These values are relative, so step 3's anchored rule can't match them |
| 5 | Agent and archive records | For each dir D in `NEW/agents/*`, `NEW/archive/*` and `NEW/agents/*/.retirement/runtime`: in `D/meta.json`, rewrite only the `ittybitty-` prefix of the `tmux_session` value, using a regex on that field. Rehire refuses a mismatch (`src/ib-commands.ts:746`), and the field isn't sealed. In `D/start.sh`, `D/resume.sh`, `D/settings.local.json`, `D/.claude/settings.local.json` and `NEW/agents/*/repo/.claude/settings.local.json`, replace the literal `<repo>/OLD/` with `<repo>/NEW/` in both path forms, only in files that contain it. Never touch `retirement.json` or `prepared-retirement.json`: their `headRef` is valid under §1.3 |
| 6 | agy worktree files | In `NEW/agents/*/repo/.agents/`: if `rules/ittybitty-agent.md` exists and is untracked, rename it to `rules/itsybitsy-agent.md`, or delete it if the new file already exists, because agy would otherwise load both always-on rules. In `hooks.json`, rename the `"ittybitty":` key. Resume rewrites both files anyway (`writeAgyWorktreeFiles`), but stopped and archived worktrees shouldn't keep the old name |
| 7 | Claude transcripts | Rename every `~/.claude/projects/<enc(repo)>--ittybitty-agents-*` to `…--itsybitsy-agents-*`, where `enc` replaces each character outside `[A-Za-z0-9]` with `-`. That is Claude's rule, not `encodeClaudeProjectPath`'s. Use both path forms. If the target exists, skip and warn. If the old or the new name is over 200 characters (where Claude is said to truncate and add a hash, which I could not confirm), warn and skip. Contents aren't changed |
| 8 | Report only | (a) `meta.paths` or `meta.sandbox` containing `/OLD/`. Those fields are sealed, so after the deploy run `ib sandbox refresh <id>`. None are expected: runtime roots are injected at launch, and `meta.paths` holds only authored entries. (b) Symlinks under NEW whose target contains `/OLD/` (`find -lname`). (c) `/OLD` in `<repo>/.gitignore` or `<repo>/.claude/settings*.json`. (d) Queued lines in `~/.itsybitsy/agents/*/outbox.jsonl` that mention `/OLD/`. (e) The tracked-file fix from §2.3 |

**A failed repair** (including a relative `gitdir` entry) is handled like this:

1. **Lock the entry**, so nothing prunes it, including `git gc --auto`, which
   prunes worktrees through `gc.worktreePruneExpire`:
   `git -C '<repo>' worktree lock --reason 'update-repos.sh: repair failed'
   '<path the entry records>'`. On a re-run the entry is already locked and the
   lock command exits non-zero. Treat that as success when `<admin dir>/locked`
   exists.
2. **Print diagnostics, not just the command that just failed:** `cat
   '<new dir>/.git'`, the admin entry's dir and its `gitdir` contents, and git's
   error.
3. **Print the manual fix:** `git -C '<repo>' worktree repair '<new dir>'`, then
   `git -C '<repo>' worktree unlock '<new dir>'`. These are for Adam to paste from
   any directory; the no-`-C` rule binds agents, not him. Unlock after the repair:
   until then ib's teardown can't remove the worktree normally, because `git
   worktree remove --force` refuses a locked worktree.
4. Record a repo error and continue.

Such an entry stays locked, and every re-run reports it and exits 1, until Adam
fixes it by hand.

**User-wide, on every run:** in each `~/.itsybitsy/agent-types/*.md` that
contains them, replace `IttyBitty` with `ItsyBitsy` and `ittybitty` with
`itsybitsy`. No backups: that dir is already in git. A dry run prints "would
rewrite N files" and names them. A file without either word is left untouched,
so a re-run changes nothing.

### 2.5 What the script never does

- **Run `git worktree prune`**, or anything that can prune (`git gc`, `git
  worktree remove`), in any mode. In the prior attempt, reviews twice reproduced a
  prune at this point silently losing a worktree's admin dir and staged index.
  - ib itself still prunes later: on every spawn (`src/ib-commands.ts:7114`), on
    `ib rehire` (:781), and when `ib watch` resolves an orphaned-worktree warning
    (`resolveOrphanedWorktree`, `src/health-check.ts:678-691`, which falls back to
    a repo-wide prune).
  - Git prunes too, from `git gc --auto` on ordinary write commands.
  - So until a failed repair is fixed by hand, run **no git writes and no `ib`
    in that repo**. The step 3 lock covers git's own pruning; the runbook says
    when to fix it.
- Kill anything, touch refs, rewrite transcript or session contents, edit tracked
  files, or call `ib`.
- Edit `~/.claude.json` (Claude's per-path trust records). Adam's own Claude
  session may be running and writing it, and ib already auto-accepts the trust
  prompt on resume (SPEC §1.6 step 4).

### 2.6 Where absolute paths live

| Location | Holds `<repo>/.ittybitty/…`? | Handling |
|---|---|---|
| `agents/<id>/meta.json` | Only the `tmux_session` prefix. `spawned_by.repo_path` is a repo root. `paths` and `sandbox` only if authored that way | Step 5; step 8a |
| `agents/<id>/start.sh` | Yes: prompt, meta, logs, exit-check, `--settings`, sandbox files. Only run at spawn | Step 5 |
| `agents/<id>/resume.sh` | Yes; rewritten on every resume | Step 5 (tidy) |
| `agents/<id>/exit-check.sh` | No (`src/ib-commands.ts:7616-7664`) | — |
| `settings.local.json`: `agents/<id>/.claude/` (no-worktree and coordinators), `repo/.claude/`, archived copies | Not by construction (`buildAgentSettings`, `src/ib-commands.ts:5834`); only inherited project allow entries could | Step 5, normally a no-op |
| `.retirement/` payload of an interrupted retirement | Copies of the files above | Step 5 |
| `archive/<key>/` | The same files; `retirement.json` holds `repoPath` (a repo root) and `headRef` | Step 5; `headRef` untouched |
| `meta.transient.json`, `*.log`, `debug-logs/`, `prompt.txt`, `sandbox-proxy.*`, `sandbox-domains.txt` | Transient state or history | — |
| Untracked symlinks restored by rehire (`archive/<key>/untracked/`) | Possible, with absolute targets | Step 8b |
| Worktree `.git` file | Points at `<repo>/.git/worktrees/<n>`, which doesn't move | — |
| `<common-dir>/worktrees/<n>/gitdir` | Yes | Step 3 |
| `<common-dir>/worktrees/<n>/modules/**/config` (`core.worktree`) | A relative path through OLD | Step 4 |
| `.agents/hooks.json`, `.agents/rules/…` | The key and the file name | Step 6 |
| `~/.itsybitsy/sealed/sandbox-logs/<sha256(agent dir)>` | Keyed by a hash of the agent dir | Not touched. The profile regenerates under the new hash on resume; the old dir stays as orphaned history (the kernel sandbox is off) |
| Seal records under `~/.itsybitsy/sealed/` | Keyed by repoId and agentId; `repo-id` moves with the dir | — |
| `~/.itsybitsy/agents/<id>/outbox.jsonl` | Message text | Step 8d |
| `~/.claude/projects/<enc>` | The dir name | Step 7 |
| `~/.claude.json` projects map | Trust per path | Not touched (§2.5) |
| `~/.codex/sessions/**` | The recorded cwd | Not touched (decision 6) |
| `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces` | Real worktree paths | Not touched. Resume re-adds the new path (`ensureAgyTrustedWorkspace`); old entries stay as harmless leftovers |
| `~/.gemini/antigravity-cli/cache/last_conversations.json` | Worktree path → conversation UUID | Not touched: ib resumes agy with `--conversation <uuid>` from `meta.agy_conversation_id`. If an agy agent still can't resume, start it fresh (decision 7) |

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
  would rename 612 Claude transcript dirs
  warn  stale worktree entry repo4 -> …/.ittybitty/agents/x/repo (gone; left in place)
[adamwulf-hugo] …
  warn  .ittybitty/repo-id is tracked; after the move run:
        git -C '/Users/adamwulf/Developer/html/adamwulf-hugo' rm -r --cached .ittybitty
        then commit. Until then ib refuses to spawn in this repo.
[muse-ios] already migrated — nothing to do
[nsf-i-corps] no runtime dir — skipped
[foo] ERROR both .ittybitty and .itsybitsy exist; .itsybitsy holds only repo-id —
      remove it (rm -rf '/…/foo/.itsybitsy') and re-run
[bar] ERROR both .ittybitty and .itsybitsy exist; .itsybitsy holds 1 agent,
      0 archives, user-questions.json — merge the two dirs by hand, then re-run
[rice-teaching] ERROR lstat '…/Rice Teaching/.ittybitty': Operation not permitted — skipped
User-wide
  would rewrite 9 files in ~/.itsybitsy/agent-types
Summary: 36 to migrate, 1 already migrated, 20 no runtime dir, 0 missing, 3 errors
DRY RUN — nothing was changed.
```

(The counts are illustrative.) `--apply` prints the same lines in the past tense,
then the report-only findings and the log path. Every manual command it prints
quotes its paths, so it can be pasted as is for a path with spaces.

| Exit | Meaning |
|---|---|
| 0 | Done, or nothing to do |
| 1 | At least one repo had an error; the other repos are done |
| 2 | Preflight blocked the run; nothing was done |

### 2.8 Idempotency

- Every step checks before it acts (dir state, exact old prefix, line present,
  target exists). A re-run over a finished repo takes no actions and leaves every
  byte the same.
- If a run is interrupted at any point, re-run the same command. After step 2 the
  repo classifies as "NEW only", and steps 3 to 8 finish it. Run no `ib` command
  and no git write between the interruption and the re-run (§2.5).
- There is no reverse mode (decision 2).

## Part 3 — Deploy runbook (Adam)

Run every step in a plain terminal, not inside any agent. The manager that owns
this plan (`ittybitty-paths`) has its worktree under `.ittybitty/`, so everything
below starts after all agents have stopped.

0. **Before you start.** Merge or retire all of `ittybitty-paths`' sub-agents, so
   only the manager itself is left to merge.
1. **Stop everything (old `ib`).** In `ib watch`, press `P` on each running,
   waiting or complete agent, and note which ones to resume later. Quit `ib watch`,
   which stops `ib-coordinator`. Then check:
   ```sh
   ib list            # every agent stopped
   ib state
   ib state --cleanup
   tmux ls            # no ittybitty-* sessions, no ib-coordinator
   ```
   Close any terminal or Claude, codex or agy session inside an agent worktree, and
   any editor or IDE (Xcode, VS Code) open on one.
2. **Save the old binary, then merge (old `ib`; don't build).**
   ```sh
   cp "$(command -v ib)" ~/ib.pre-itsybitsy
   cd ~/Developer/bun/itsybitsy
   ib merge ittybitty-paths --force
   ```
   If the merge conflicts, resume the manager, let it rebase, and then go back to
   step 1. Merging only changes files. Rebuilding `ib` from this `main` now would
   break the hooks of anything still under `.ittybitty/`. Don't run `bun test` in
   the main checkout before step 4 either. From here until step 4, `git status`
   in the main checkout shows `?? .ittybitty/`, because the merge drops that line
   from this repo's `.gitignore`, unless your global excludes cover it. **Don't
   `git add -A` there.**
3. **Dry run.**
   ```sh
   scripts/update-repos.sh | tee ~/update-repos-dry-run.txt
   ```
   Clear every blocker and repo error, then repeat until it is clean:
   - **"both exist":** follow the error text. Remove the new `.itsybitsy/` only
     when it holds nothing but `repo-id`; otherwise merge the two dirs by hand.
   - **A repo registered at `$HOME`:** `ib remove` it now, with the old `ib`.
4. **Apply.**
   ```sh
   scripts/update-repos.sh --apply
   ```
   - **A failed repair:** read the printed diagnostics (the worktree's `.git`
     file, the admin entry) and fix the link. Then run the printed `git -C
     '<repo>' worktree repair '<path>'` and `git -C '<repo>' worktree unlock
     '<path>'`, and re-run the script. The entry stays locked, and the script
     keeps exiting 1, until this is done.
   - **Any other repo error:** a failed write in step 1 or 2 (for example `EPERM`
     moving the `~/Library/Containers/…` repo), a relative `gitdir`, a failure in
     steps 4 to 7, or a stat error. The same goes for a repo reported "missing".
     For each one, before step 6, do one of these:
     - Fix the cause (for example, give the terminal access to that app's data)
       and re-run with that path: `scripts/update-repos.sh --apply '<repo>'`.
     - `ib remove` the repo.
     - Leave it, and use no ib in it until it is migrated.

     A later single-repo run, even after the deploy, again needs every agent
     stopped and `ib watch` quit, because P2 and P3 check every repo.
   - Until a repo's failures are fixed, run no git writes and no `ib` in that repo:
     the next spawn, rehire or `ib watch` fix runs `git worktree prune`.
   - Stale entries reported as "gone" need nothing.
   - For each repo with a tracked-file warning, run the printed `git rm -r
     --cached` and commit, before using ib there.
5. **Check.**
   - For a few repos, `git -C <repo> worktree list` shows the agent worktrees under
     `.itsybitsy/`, with nothing `prunable` except the stale entries the script
     listed.
   - `ls -d <repo>/.ittybitty` fails for every registered repo.
   - `ls ~/.claude/projects | grep -c -- '--ittybitty-agents-'` drops; dirs for
     unregistered or deleted repos remain.
6. **Build and install.**
   ```sh
   bun run build
   sudo cp ib "$(command -v ib)"     # skip if the project dir is on PATH
   ib list-types                      # must print a table
   ```
7. **Global ignore — required before any agent is spawned.** Add `.itsybitsy/`
   and `.agents/rules/itsybitsy-agent.md` to your global git excludes file (the
   one `git config --global core.excludesFile` names, or `~/.config/git/ignore`).
   The script adds `info/exclude` lines only in repos it migrates. The roughly 20
   "no runtime dir" repos, and any repo registered later, get none. The spawn
   dirty-gate (`src/ib-commands.ts:6487-6514`) runs before `getRepoId` creates
   `.itsybitsy/` (:6913), so in such a repo the first spawn succeeds and the
   second is refused on `?? .itsybitsy/`.
8. **Restart; test one of each before the rest.** Start `ib watch`.
   **Never accept an orphaned-dir fix (`f`) for a stopped agent you want to
   keep:** that fix deletes the agent dir. Stopped coordinators and no-worktree
   agents stay flagged even after everything else is resumed. Also hold off on
   the orphaned-worktree fix until the repairs from step 4 are done, because it
   can fall back to a repo-wide prune. Then check each of these with `ib look
   <id>`:
   - **Claude:** `ib resume <id>`, then `ib send <id> "What were you last working
     on?"`. It should remember.
   - **Codex:** `ib resume <id>`, then `ib look <id>`. If codex asks about the
     changed directory, answer it by hand (keep the new worktree) before resuming
     any other codex agent.
   - **agy:** `ib resume <id>`. It should start, and `git status` in its worktree
     should not list the rule file. If it can't pick up its conversation, start a
     fresh agent instead.
   - **Rehire:** rehire one old retired agent (legacy ref), if you have one you
     don't mind restoring.
   - **New worker:** `ib new-agent --type worker "Print your working directory,
     which must contain .itsybitsy. Run bun test and bunx tsc --noEmit, report
     the results, and change nothing."`

   Then resume the rest with `ib resume <id>`. Leave per-repo coordinators
   stopped: `ib resume` or `R` on one resets it (`src/ib-commands.ts:1698-1709`).
   Agents whose branches predate the rename run old-name source, so rebase them
   before trusting their test results.
9. **Later.** Once the new `ib` has worked for a while, delete
   `~/ib.pre-itsybitsy`.

**If something goes wrong.** Before step 4 (`--apply`) has run, the old layout is
intact. If you need to back out, `git revert -m 1 <merge commit>`, and if a new
`ib` was already installed, put back the saved one with `sudo cp
~/ib.pre-itsybitsy "$(command -v ib)"`. Once the script has run, there is no
rollback: the old binary can't read the new layout. Fix forward instead: re-run
the script, repair worktrees by hand, or fix the new code.

## Part 4 — Tests

### 4.1 Code rename

- **`src/runtime-names.test.ts`:**
  - The path builders.
  - A tmux build/parse round trip with an agent ID that contains `ittybitty`.
  - `isRetiredHeadRef` is true for both names and false for anything else.
  - Each path parser on its current shape, including a worktree nested inside
    another and a repo path that contains the word `ittybitty`.
  - The overlap (§1.1): a `~/.itsybitsy/agents/<id>` cwd and a
    `~/.itsybitsy/agents/<id>/outbox.jsonl` path never parse as a worktree, and
    `resolveAgentFromCwd` resolves a cwd under the user-wide home to `@system`
    before it tries the worktree pattern.
  - The three tightenings (§1.1), each one no longer matching:
    `/r/Xitsybitsy/agents/a/repo` (the dot, escaped now),
    `/r/x.itsybitsy/agents/a/repo` (no leading `/`), and
    `/r/.itsybitsy/agents/a/repository` (no `(\/|$)` after `repo`).
- **Refs** (`src/agent-lifecycle.test.ts` and the rehire tests in
  `src/ib-commands.test.ts`, using real temp git repos):
  - Retire writes `refs/itsybitsy/…`, and the manifest names it.
  - Manifest validation accepts both names.
  - Rehire with only the legacy ref uses it.
  - With both refs, rehire uses the itsybitsy ref, even when the manifest names
    the legacy one.
  - An itsybitsy ref pointing at the wrong object fails as corrupt, with no
    fallback.
  - Only the legacy ref exists, and it points at the wrong object: fails as
    corrupt, not as "neither found".
  - With neither ref, rehire fails with an error naming both.
  - `archiveAgent` deletes a pending legacy ref and a pending new ref.
  - Rehire authorization through `checkManagerCommandAccess` with
    `ownArchiveOnly` (`src/hooks/agent-path.ts:1622-1652, 1733`;
    `src/lifecycle-broker.ts:281`). With a single archive this test can't fail:
    with no parseable manifest, `ownArchiveDecision` falls back to `archives[0]`
    (:1625-1626). So the fixture has two archives for the same ID: an older one
    whose `retirement.json` names the legacy ref, with manager M1, and a newer one
    with no `retirement.json`, with manager M2. M1 is allowed and M2 is denied,
    which holds only if the legacy manifest parses.
- **`src/registry.test.ts`:** `addRepo` refuses `$HOME`, given either its path or
  a symlink to it, and still accepts a subdirectory of `$HOME`.
- **Guard test:** §1.6.
- **Mechanical updates:** the 60 test files that use the old name (59 under
  `src/` plus `tests/parse-state.test.ts`),
  `tests/fixtures/claude-resume-sh-baseline.sh`,
  `src/fixtures/codex-snapshot-input-fail-{1..6}.txt` and
  `src/fixtures/snapshot-idle-prompt-{1,2}.txt`. Use exact path and prefix
  replacements, not a blanket word replace: agent IDs in fixtures may
  legitimately contain the word.
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
- **Gate:** `bun test` and `bunx tsc --noEmit` from the implementer's worktree
  (still under `.ittybitty/`). For the entry-point check, build to a scratch
  `--outfile` (never over the `ib` on PATH) and confirm that `<scratch>/ib
  list-types` prints a table.
- **Gate in a new-name worktree.** Run the suite once more from a worktree whose
  cwd has the new shape, so cwd-dependent gates see `.itsybitsy` before the deploy.
  An agent can't use `git -C` (denied by `checkGitDirectoryFlags`, applied at
  `src/hooks/agent-path.ts:1065`) and can't `cd`, so every step below runs from
  the implementer's own worktree. Let G be
  `<tmp>/r/.itsybitsy/agents/agent-gate`, where `<tmp>` is a dir the implementer
  may write, such as its scratchpad.
  0. **Baseline, before the first commit:** `bun test --reporter=junit
     --reporter-outfile=<tmp>/baseline.xml` on the unchanged code.
  1. Write `G/meta.json` with the Write tool: `"id": "agent-gate"`, the
     implementer's own `agentType` and `worker` values, and `"worktree": true`. An
     agent can't read its own `meta.json` (SPEC §6.1 item 10), so take the type
     from its session-start instructions (for example, a worker is `"agentType":
     "worker"`, `"worker": true`). A meta with only `id` makes
     `metaCanSpawnChildren` return true (`src/agent-types.ts:802-814`), which
     flips the two dashboard new-agent tests that fail in a worktree.
  2. `git worktree add --detach G/repo HEAD`, on the committed rename. This adds a
     linked worktree of the real repo.
  3. `ln -s <own worktree>/node_modules G/repo/node_modules`.
  4. `bun --cwd=G/repo test --reporter=junit
     --reporter-outfile=<tmp>/gate.xml`.
  5. The failing tests must match the baseline exactly: the tests expected to
     fail in a worktree (the two dashboard new-agent tests with the cwd-based
     caller gate) fail in both, and nothing else fails.
  6. Clean up only what the gate made: `git worktree remove --force G/repo`, then
     `rm -rf <tmp>/r`.

### 4.2 The script: `src/update-repos-script.test.ts`

Each test runs `/bin/bash scripts/update-repos.sh` (macOS's bash 3.2, never a
`bash` from PATH) with `Bun.spawn` and an explicit env, because Bun ignores later
edits to `process.env`:

- `HOME=<tmp>/home`
- `PATH=<tmp>/stubs:/usr/bin:/bin`
- `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=<tmp>/gitconfig`
- `GIT_CEILING_DIRECTORIES=<tmp>`, so git never falls through to the checkout
  above
- `TMPDIR`, and a cwd outside the checkout

The script isn't an `ib` entry point, so the AGENTS.md `test-cli-runner` rule
doesn't apply. Still, the stubs dir holds an `ib` that records its argv and exits
97, and every test asserts that it never ran.

**Stubs.** `tmux`, `ps` and `lsof` print canned output from files the test writes,
so these tests use **no real tmux**. If a test ever needs real tmux, every call
takes `-L <unique socket>`: a test once ran `kill-server` on the real server and
killed every agent. A `git` wrapper stub logs its argv, fails on `gc`, `worktree
prune` and `worktree remove`, and otherwise execs `/usr/bin/git`.

**Fixture** (temp git repos, temp HOME):

- A repo whose path has a space and contains `ittybitty`. It is registered in its
  `/var/folders/…` form, so the registered and real (`/private/var/…`) path forms
  differ.
- A second repo.
- A worktree agent with a staged change and an ID that contains `ittybitty`.
- A nested worktree at `agents/<id>/repo/.claude/worktrees/wip` with a staged
  change.
- A worktree with an initialized submodule (a local `file://` repo), for step 4.
- A no-worktree agent.
- An agy worktree with a rule file and `hooks.json`.
- An archived retired agent: old `tmux_session`, a `retirement.json` with the
  legacy `headRef`, and the legacy ref.
- A stale admin entry whose worktree is gone.
- Transcript dirs for both path forms, `repos.json`, and agent-type files that
  contain both spellings.

**Cases:**

1. **Dry run:** the tree is identical before and after (names and content hashes
   under the temp root, including each fixture's `.git/index`), planned actions
   are printed, exit 0.
2. **Apply:**
   - The dir is renamed.
   - Each worktree, the nested one included, resolves with `rev-parse
     --show-toplevel`, and its staged changes are intact.
   - `git status` works inside the submodule.
   - Admin `gitdir` files point at NEW, and the stale entry is still present.
   - `tmux_session` is rewritten in active and archived meta.
   - `headRef` and the legacy ref are unchanged.
   - The transcripts and agy files have moved.
   - The exclude lines are present, and `git status --porcelain` in the main
     checkout is empty.
   - Repo paths and agent IDs that contain the word are unchanged.
   - The git log has no `gc`, `worktree prune` or `worktree remove`, and the `ib`
     stub never ran.
3. **Re-run after apply:** no actions, bytes unchanged, exit 0.
4. **Interrupted runs:** a fixture already moved but with old admin entries
   (killed after step 2) is finished by a re-run. With only the exclude lines
   written (killed after step 1), a re-run migrates it.
5. **Both dirs in one repo:** with NEW holding only `repo-id`, the error gives
   the removal hint. With NEW holding an agent dir, it gives the counts and says
   to merge by hand, with no removal hint. In both, the other repo migrates and
   the exit is 1.
6. **Repair failure** (a worktree whose `.git` names a missing admin dir): exit 1;
   the printed diagnostics and the `git -C '<repo>'` repair and unlock commands;
   the entry still present and locked; the other repo migrated; no prune. A
   re-run reports it again, treats the existing lock as success, and still exits
   with 1. A relative-`gitdir` entry under OLD is also locked and is a repo error.
7. **Real-path compare:** the repo registered in its `/var/folders/…` form
   repairs cleanly (repair writes `/private/var/…`), exits 0, and leaves no
   entry locked.
8. **Fail-closed classification:** each of these is a repo error, never
   "missing" or "no runtime dir", and nothing is written for that repo:
   - The repo's parent made mode 000, so `lstat` of the repo fails with `EACCES`.
   - The repo dir made mode 000, so `lstat` of OLD fails.
   - The git stub fails `rev-parse` with an error other than "not a git
     repository".
   - `OLD/agents/a/repo/.git` exists, but git says the repo is "not a git
     repository".
9. **A repo registered at `$HOME`:** a repo error whose message says to `ib
   remove` it.
10. **Move failure** (repo root made read-only, so step 2 fails): that repo's
    transcripts and records are unchanged, exit 1.
11. **Each preflight blocker** exits 2 with nothing written: tmux showing
    `ittybitty-…`, `itsybitsy-…` or `ib-coordinator`, an unexpected tmux error,
    `ps` showing `ib watch`, `lsof` showing a cwd under OLD. "no server running"
    passes.
12. **A tracked file inside OLD:** the repo is migrated, and the warning prints
    the `git rm -r --cached` fix.
13. **Agent types:** after apply, both spellings are rewritten and no
    `.pre-itsybitsy` file exists. A dry run leaves the files byte-identical, and
    a re-run changes nothing.
14. **New code on migrated data** (in process, HOME seam via `setUserHome`, spawn
    runners stubbed): `readAllAgents` finds the migrated agents, and
    `rehireAgent` on the migrated archive passes its tmux check and resolves the
    legacy ref.

## Part 5 — Cross-cutting checklist

1. **General agent functionality.** Paths, tmux names and new retired refs
   change. Spawn, resume, rehire, merge, retire and nuke all go through
   `src/runtime-names.ts`. The `meta.json` shape doesn't change, only the
   `tmux_session` value. Rehire gains the legacy-ref fallback. `addRepo` refuses
   `$HOME`.
2. **Hooks.** Every hook that identifies an agent from its cwd
   (`hooks/shared.ts`, `hooks/main-path.ts`, `hooks/session-start.ts`,
   `hooks/intercept-task.ts`, `hooks/agent-context.ts`,
   `hooks/slow-hook-logger.ts`, `hooks/paths-table.ts`) uses the module's parsers
   with unchanged semantics, apart from the three tightenings in §1.1, so path
   isolation allows and denies exactly what it does today. `@system` resolution
   still runs first, which keeps `~/.itsybitsy/agents/<id>` from being taken for an
   agent. The agy protected-file list follows `AGY_WORKTREE_FILES`. The tags become
   `<itsybitsy>` and `<itsybitsy-status>`. The module imports only `node:path`, so
   hook start-up cost stays the same. Hooks call the installed `ib`, which is why
   the runbook never mixes a binary with the wrong layout.
3. **Watchdog.** It finds agents through the module and uses `meta.tmux_session`,
   which the script rewrites; orphan detection uses the new prefix. No change to
   timing, nudges or rate-limit recovery. No watchdog may be running during the
   script (P3).
4. **`ib watch`.** `src/watcher.ts` watches `<repo>/.itsybitsy/agents/` and
   `user-questions.json`. Debug-log paths, health checks and orphan detection use
   the module. No layout or input change. Its health fixes can delete or prune, so
   the runbook never accepts an orphaned-dir fix for a stopped agent worth keeping,
   and holds off the orphaned-worktree fix until repairs are done (steps 4 and 8).

## Risks

| Risk | Handling |
|---|---|
| Claude `--resume` can't find the session at the new cwd | Step 7 renames the transcript dirs; runbook step 8 checks that one agent remembers |
| agy resume from a moved dir is unverified | Runbook step 8 checks one agy agent; the fallback is a fresh agent (decision 7) |
| A repair fails, and a later prune drops that worktree's admin dir and index | The script never prunes, locks the entry, exits 1 naming each failure, and runbook step 4 fixes them before anything can spawn |
| A repo is offline during the run, then the new `ib` writes `.itsybitsy/repo-id` there | It is reported "missing — skipped". Re-running for it hits "both exist", and the error text gives the recovery |
| Gitignored build output in a worktree holds old absolute paths (`.build`, `DerivedData`, virtualenvs) | Not scanned. If a resumed agent's build errors mention `.ittybitty`, do a clean build in that worktree |
| Another branch adds old names after this lands | The guard test fails on rebase |

## Open questions for Adam

- **Pending:** whether the script should also move `refs/ittybitty/retired/*` to
  `refs/itsybitsy/retired/*`, which would remove the rehire fallback. §1.3 and the
  ref tests assume it does not; a yes means deleting the fallback and adding one
  ref-move step to the script.

# SPEC-PATH-ALLOWLIST.md — Path allow-list for agent types

**Status:** Phase B is implemented on `agent/codex-path-isolation` and recorded as
**ON BRANCH**, not **INSTALLED**, in [the rollout ledger](docs/SANDBOX-ROLLOUT.md).
The current contract is summarized immediately below and specified normatively in
[SPEC.md §6.1](SPEC.md). Sections 0–7 retain the 2026-09-02 research and decision
trail; statements there about `allowedPaths`, permissive defaults, or work still
being proposed describe the historical baseline and are not current behavior.
**Written:** 2026-09-02 by researcher agent `path-isolation`; updated through the
Phase B integration on 2026-09-05.

## Current authoritative implementation

- Agent types use one top-level `paths:` policy with `allowRead`, `allowWrite`,
  and `deny`. Lists union across `_all.md`, `_non_coordinator.md`, inheritance,
  and the leaf type; relative entries anchor at the main repo root and are
  resolved before being frozen in `meta.paths`. `allowedPaths` is retired and
  rejected by validation.
- Missing, empty, and partially populated path lists are normalized to empty
  lists and are equally strict: no unmatched path is allowed. All three
  PreToolUse handlers use the shared resolver after the structural protected-file,
  sibling-agent, and main-checkout checks.
- The shared runtime table contains the CLI-neutral roots. Claude, including
  legacy metadata with no model, additionally receives its Claude project
  directory and scratchpad; those Claude-only roots are excluded from codex,
  fugu, and agy hook tables, matching their kernel profiles.
- The Bash scanner classifies recognizable literal path arguments and common
  write destinations, then consults the same table. It is an advisory visibility
  and early-denial layer, not a shell parser or kernel boundary. Dynamic shell
  expansion and unrecognized command shapes remain an accepted limitation when
  the kernel sandbox is off.
- The Seatbelt kernel wrapper is available for claude and the Codex-backed
  codex/fugu CLIs on macOS. It is unavailable for agy: an agy agent whose
  resolved `sandbox.enabled` is `true` fails closed before launch rather than
  running unwrapped. Instructions, `ib info`, and the dashboard identify that
  state as unavailable.
- Spawn freezes `paths` and `sandbox` in `meta.json`; `ib sandbox refresh`
  re-derives them from the current type layers. Codex resume and refresh also
  regenerate `AGENTS.md` from the agent's current frozen metadata, so its
  instructions describe the policy that will actually be enforced.

---

## 0. Historical summary (pre-Phase-B baseline)

> **Historical record.** Sections 0–5 describe the implementation inspected on
> 2026-09-02, before Phase B. They explain why the work was needed; they do not
> describe the current `paths:` implementation summarized above.

The requested feature already exists in part. Agent-type frontmatter accepts an
`allowedPaths:` list[^1]. The worktree is always allowed before that list is
consulted[^6]. Absolute entries and `~/…` entries work today[^5]. No live
agent-type file uses the field, so every running agent is in the legacy
permissive mode[^25].

The gaps that block the request are:

1. **Relative entries resolve against the wrong directory.** `ib new-agent`
   resolves each entry with `path.resolve()`, so `../fumble` is anchored at the
   cwd of whoever ran `ib new-agent`, not at the new agent's worktree or repo[^5].
2. **The list never applies to paths inside a Bash command line.** For all three
   CLIs, `cat ~/.ssh/id_rsa` passes when `cat` is allow-listed[^8][^23]. Only the
   `cd` target and the file tools go through the allow-list check[^7].
3. **Codex ignores the list.** The codex hook never passes `allowedPaths` into
   the shared checker[^12], and codex's Seatbelt sandbox does not learn the
   entries as writable roots[^14].
4. **Strict mode has no baseline.** `allowedPaths: []` denies `/tmp`, so Claude
   Code's own scratchpad and `~/.claude` (other than the agent's own project
   directory) become unreachable[^6].
5. **The instructions lie in strict mode.** The Path Isolation section still
   tells the agent it can access `~/.claude`, `/tmp` and system paths[^24].
6. **Layer files do not contribute.** `_all.md` and `_non_coordinator.md` cannot
   add allow-list entries; only the type and its `inherits:` chain can[^5][^4].

Relative entries anchor at the **main repo root** the worktree was spawned from,
not the worktree. Adam decided this on 2026-09-02; the reason is in §5.2. An
entry therefore cannot name its own repo root, which is acceptable because steps
10 and 11 deny that root for worktree agents anyway.

---

## 1. Historical baseline inspected on 2026-09-02

### 1.1 Data flow

| Stage | Where | What happens |
|---|---|---|
| Parse | `AgentType.allowedPaths`[^1], `buildAgentTypeFromFrontmatter`[^2] | Absent → `undefined`. Present but not a list → `[]`. |
| Validate | `validateAllAgentTypes`[^3] | Must be a list of strings. Runs at `ib watch` startup. |
| Inherit | `mergeRawFrontmatters`[^4][^26] | Child **replaces** the parent's list. No union. |
| Resolve | `newAgent`[^5] | `~` → home; `path.resolve()`; `realpathSync` when the path exists. |
| Store | `meta.json.allowedPaths`[^5] | Absolute paths only. Copied unchanged on resume[^40]. |
| Enforce (claude) | `hookCheckPath` → `checkFilePath`[^10][^6] | Step 12: exact match or prefix match with `/`. |
| Enforce (agy) | `hookAgyPreToolUse` → `checkAgyPreToolUse`[^19][^18] | Same step 12, forced on. |
| Enforce (codex) | `hookCodexPreToolUse`[^12] | Not passed. See §3. |
| Explain | `buildPathIsolationSection`[^24] | Lists the entries under "additional paths". |
| Show | `ib list-types`[^33] | Prints the entries. `ib watch` does not show them. |

### 1.2 The three modes

SPEC §6.1 defines them[^25]:

- **Absent** (`undefined`): legacy permissive. Everything outside the always-denied
  set is allowed. This is the mode of every live agent today.
- **Empty** (`[]`): strict. Only the always-allowed set.
- **Entries**: the always-allowed set plus the listed subtrees.

### 1.3 The fixed rules that run before the list

`checkFilePath` runs these steps in order[^6]:

| Step | Rule | Result |
|---|---|---|
| 6 | Write tool targets `<wt>/.claude/settings*.json` or an agy boundary file | deny |
| 7 | Path is the worktree or under it | **allow** |
| 8 | Path is the agent's own `agent.log` | allow |
| 9 | Path is under the agent's own `~/.claude/projects/<encoded-worktree>` | allow |
| 10 | Path is under `.ittybitty/agents/` (any agent, including own dir) | deny |
| 11 | Path is under the main repo root but outside the worktree | deny |
| 12 | `allowedPaths` defined → in list = allow, else deny | — |
| 13 | `allowedPaths` undefined → allow | allow |

So the worktree is already auto-allowed. Steps 10 and 11 cannot be overridden by
the list; the test suite pins this[^34].

### 1.4 What the list does NOT govern

`checkPathAccess` sends only three things to `checkFilePath`: a `cd` target, and
the `file_path` / `path` / `notebook_path` of a non-Bash tool[^7]. Every other
Bash command goes to `checkBashCommandPaths`, which never reads
`ctx.allowedPaths`[^8]. That function only:

- denies `git -C`, `--git-dir`, `--work-tree`[^35];
- denies relative `..` traversal that lands in another agent's dir or the main
  repo[^9];
- denies redirect and `sed -i` writes to protected files[^8];
- denies literal absolute references to other agents' dirs or the main repo[^8].

A literal `~` or `$HOME` is never expanded for those scans[^9]. A `..` token that
carries a leading `~`, quotes, `$`, braces, backticks, backslashes or glob
characters is denied outright as unresolvable noise[^9].

---

## 2. Claude agents

**Launch.** `claude --session-id <uuid> [--model] [--effort]` inside the
worktree[^36]. No `--add-dir`, no sandbox flag.

**Boundary.** A PreToolUse hook on every tool runs `ib hook-check-path <id>`[^10].
The allow list comes from the worktree's `.claude/settings.local.json`[^10].
The default allow list includes `Bash(cat:*)`, `ls`, `head`, `tail`, `grep`,
and the file tools[^27].

**What the list governs.** File tools and `cd` (§1.3). Reads and writes through
those tools are fenced.

**Gaps.**

- Bash reads of any path outside the repo pass (§1.4). Under strict mode, `Read
  ~/.ssh/id_rsa` is denied but `cat ~/.ssh/id_rsa` is allowed.
- `~`-prefixed tokens in a Bash command are not resolved for the needle scans[^9].
- Under strict mode, the scratchpad Claude Code hands the session
  (`/private/tmp/claude-<uid>/…/scratchpad`) is denied for file tools because it
  is not in the always-allowed set[^6].

The primary session's hook, `main-path`, is unrelated. It only blocks the user's
own Claude from `cd`-ing into an agent worktree[^28].

---

## 3. Codex agents

**Launch.** `codex -m <model> -a never -s workspace-write
--dangerously-bypass-hook-trust`[^41] plus `--add-dir` for `~/.itsybitsy`,
`~/Library/Caches` on macOS, the git common dir, and the parent repo's
`.ittybitty` and `.claude` subdirectories[^14][^15].

**Sandbox.** `workspace-write` is a write boundary: edits and commands are
confined to cwd[^17] plus the `--add-dir` roots[^14]. It also leaks: `/tmp`, `$TMPDIR`
and `~/.codex/memories` stay writable[^16]. SPEC-CODEX-MODEL therefore makes the
hook the primary boundary and the sandbox defense in depth[^16].

**Boundary.** A PreToolUse hook runs `ib hooks codex-pre-tool-use <id>`[^12].
`apply_patch` targets are extracted and each is checked as a synthetic `Write`
with `allowedPaths` forced to `ctx.allowedPaths ?? [worktree]`[^13].

**What the list governs.** Nothing. `hookCodexPreToolUse` builds the
`PathCheckContext` without `allowedPaths`[^12], even though the shared resolver
reads it from `meta.json`[^11]. The resolver's own comment says "Codex ignores
this field"[^11]. So for codex:

- `apply_patch` is fenced to the worktree only. A type's entries are not honored.
- Bash and every other tool fall through to step 13 (permissive).
- Even if the hook allowed a write into an entry, the Seatbelt sandbox would
  return EPERM, because `--add-dir` roots are built from fixed sources, not from
  `allowedPaths`[^14][^15].

---

## 4. Antigravity (agy) agents

**Launch.** `agy --dangerously-skip-permissions --mode=accept-edits --model <slug>
[--effort] --log-file <agentDir>/agy.log -i "<prompt>"`[^21]. No sandbox and no
`--add-dir`; the hook file is the only boundary[^22].

**Boundary.** `<worktree>/.agents/hooks.json` registers PreToolUse, PreInvocation
and Stop[^22]. Every agy tool is translated to a synthetic Claude call with its
path argument[^20]. `checkAgyPreToolUse` then[^18]:

1. denies sub-agent tools, and unknown tools whose raw name is not
   allow-listed[^20];
2. requires a single command in `run_command` (no metacharacters outside
   quotes)[^18];
3. applies the type's deny list, deny wins[^18];
4. checks the model-controlled `Cwd` of `run_command` as an `LS` with the list
   forced on[^18];
5. runs `checkPathAccess` with `allowedPaths` forced to
   `ctx.allowedPaths ?? [worktree]`[^18].

**What the list governs.** All file tools and the `run_command` cwd. This is the
most complete of the three today.

**Gap.** The same Bash-line hole as claude. SPEC-ANTIGRAVITY-CLI Risk 9 records
it: `cat ~/.ssh/id_rsa` in `run_command` passes, "an inherited default rather
than an agy-specific hole", and asks for "a conscious decision (an allowlist of
readable roots, or accepting the claude-parity default)"[^23].

---

## 5. Comparison

### 5.1 Side by side

| Property | claude | codex | agy |
|---|---|---|---|
| OS sandbox | none | Seatbelt, writes only[^17] | none[^22] |
| Extra writable roots at launch | n/a | fixed `--add-dir` set[^14] | n/a |
| Hook contract on crash | n/a (Claude Code) | fail-open[^12] | fail-closed[^19] |
| File tools fenced by `allowedPaths` | yes[^6] | `apply_patch` to worktree only[^13] | yes, forced on[^18] |
| Command cwd fenced | `cd` target only[^7] | `cd` target only[^7] | `cd` target + `Cwd` arg[^18] |
| Paths inside a command line fenced by the list | no[^8] | no[^8] | no[^8] |
| Multi-command lines | Claude Code re-checks each sub-command | not split by the hook[^13] | denied[^18] |
| Own scratchpad allowed in strict mode | no[^6] | Bash yes (hook step 13, sandbox permits `/tmp`[^16]); `apply_patch` no[^13] | no[^18] |

### 5.2 Why the worktree is the wrong anchor for relative entries

The request proposes resolving `../../fumble` relative to the worktree. The
worktree sits at `<repo>/.ittybitty/agents/<id>/repo`[^10]. Its first four
ancestors are:

| Levels of `..` | Resolves to | Verdict from `checkFilePath` |
|---|---|---|
| 1 | `<repo>/.ittybitty/agents/<id>` | deny, step 10 (only `agent.log` survives) |
| 2 | `<repo>/.ittybitty/agents` | deny, step 10 |
| 3 | `<repo>/.ittybitty` | deny, step 11 |
| 4 | `<repo>` | deny, step 11 |
| 5 | parent of the repo | reachable |

Steps 10 and 11 run before the list and win over it[^6][^34]. So a
worktree-anchored relative entry is dead until it climbs five levels. Under that
anchor, the example `../../fumble` would name a sibling agent directory and be
denied.

Anchoring at the **main repo root** (`rootRepoPath`, which `newAgent` already
derives from the git common dir so it is correct even when a manager inside a
worktree spawns[^37][^38]) gives the natural reading: `../fumble` is the sibling
project of the repo. It is also uniform for non-worktree agents such as
coordinators, whose worktree path IS the repo root[^10].

Inside-worktree relative entries (`./docs`) are pointless under either anchor:
the worktree is already allowed at step 7, and the repo-root copy is denied at
step 11.

### 5.3 The unmerged sandbox branch

`agent/sandbox-feature` (agent stopped 47 days ago) carries a full kernel
sandbox: `src/sandbox.ts`, Seatbelt profile generation, a per-agent proxy, and
codex parity[^29]. It is 28 commits ahead of `agent/antigravity` and 170 commits
behind it[^30]. Its frontmatter uses `sandbox.allowRead` / `sandbox.allowWrite`
and derives them from `allowedPaths` when its own lists are absent[^31].

Its grammar accepts exactly three forms, `/abs`, `~/…`, and globs, and rejects
anything else at spawn with a "relative to what?" error[^32]. `src/sandbox.ts`
enforces this[^39]. Whatever anchor we choose here must be adopted there too,
or the two systems will disagree on the same entry.

---

## 6. Historical proposed design

> This section records the proposal as it evolved. Later subsections supersede
> earlier ones, and the implemented result is the current authoritative summary
> above. In particular, §6.11 retires `allowedPaths` and §6.12 records the final
> no-audit decision.

### 6.1 Entry grammar

One field, `allowedPaths`, four forms, classified by prefix:

| Form | Example | Anchor |
|---|---|---|
| Absolute | `/Users/adam/Developer/shared-lib` | none |
| Home | `~/Documents`, bare `~` | `$HOME`, as today[^5] |
| Relative | `../fumble` | the main repo root the worktree was spawned from (decided, §7) |
| Glob | `**/.env`, `~/secrets/*`, `../fumble/**/*.md` | as the sandbox grammar[^32]; a relative glob is anchored first, then compiled |
| Explicit anchor tokens | `{{repoRoot}}/../fumble`, `{{worktree}}/build` | optional; makes intent visible in the `.md`; not requested |

Bare names without a leading `/`, `~`, `.` or token are a spawn error, mirroring
the sandbox branch's fail-closed rule[^32].

### 6.2 Spawn-time resolution (`newAgent`)

Replace the current block[^5] with:

1. Expand `~`.
2. If the entry is relative, join it to the anchor (§6.1).
3. `path.resolve()`, then `realpathSync` when the path exists.
4. **Reject** an entry that resolves to, or under, `<repo>/.ittybitty/agents`,
   because step 10 will deny it anyway. Print the resolved path in the error so
   the author sees the mistake.
5. **Warn** (do not reject) on an entry that resolves inside the main repo root,
   because step 11 will deny it for worktree agents but not for coordinators.
6. Store the absolute list in `meta.json` as today.

The hooks need no change for file tools: they already receive absolute paths.

### 6.3 Layer contribution (decided: union)

*Superseded in part by §6.11: with the single model there is no mode, so the
"leaf decides the mode" proposal below falls away. The union rule stands.*

Today only the type and its `inherits:` chain feed the list, and a child
replaces its parent[^4][^5]. Adam chose to layer the lists the same way
`permissions.allow` is merged[^4]: **union across `_all.md` →
`_non_coordinator.md` → the `inherits:` chain**. This also matches where the
sandbox spec put its baseline[^31].

Two consequences to pin down in the implementation:

- The "absent = permissive, `[]` = strict" rule needs a home once layers union.
  Proposal: the mode is decided by the **leaf type**. Leaf absent → permissive
  (layers ignored, as today). Leaf present (`[]` or entries) → strict, and the
  effective list is the union of all layers plus the leaf. `_all.md` entries are
  then a baseline that every strict type inherits.
- `mergeRawFrontmatters` must move `allowedPaths` out of `SCALAR_KEYS` into a
  union list, and `newAgent` must read the merged result, not
  `agentTypeDef.allowedPaths` alone[^4][^5]. SPEC §2.2 and the README sentence
  about "replace" change accordingly[^26].

### 6.4 Strict-mode baseline (decided: scratchpad)

Strict mode today denies the scratchpad and `~/.claude`[^6]. Adam agreed that
claude agents get their scratchpad. Always-allowed addition, applied at step 9
alongside the project dir:

- the session scratchpad root
  `/private/tmp/claude-<uid>/<encodeClaudeProjectPath(worktree)>` (claude only;
  see §6.10 answer (a) for the derivation and its caveat);
- nothing else in code. Anything wider (`/tmp`, `$TMPDIR`) goes into `_all.md`
  as a visible baseline entry, per §6.3.

Codex already gets `/tmp` from its sandbox[^16]; the hook should keep parity by
listing the same scratchpad root.

### 6.5 Codex parity

1. Pass `ctxResolved.allowedPaths` into the `PathCheckContext` in
   `hookCodexPreToolUse`[^12], as agy does[^19].
2. Add each resolved entry as an `--add-dir` root in `buildCodexLaunchArgs`[^14],
   so the sandbox and the hook agree. Entries must pass
   `isCodexSafeBinaryPath`[^14]; reject the spawn otherwise.
3. Update the "Codex ignores this field" comment[^11].

### 6.6 Bash command-line fence (decided: yes; layer under discussion, §6.9)

This is what turns "whitelist which paths agents may visit" from a file-tool rule
into a real rule. Adam wants command arguments fenced. Whether the fence is this
hook scanner, the kernel sandbox, or both is the subject of §6.9. The hook-level
design, for all three CLIs, inside `checkBashCommandPaths`[^8]:

1. Tokenize as `checkRelativeTraversalPaths` does (quotes stripped, heredoc
   bodies masked)[^9].
2. Collect candidate paths: tokens that start with `/`, `~`, `~/`, `$HOME`,
   `${HOME}`, and the right-hand side of `--flag=<path>`.
3. Resolve each against cwd and run it through `checkFilePath` with the tool
   name `Bash`.
4. Add a **system read baseline** so toolchains keep working: `/usr`, `/bin`,
   `/sbin`, `/opt/homebrew`, `/Library`, `/System`, `/private/tmp`, `/private/var/folders`,
   `/dev`, `/etc`. Per §6.3 the baseline lives in `_all.md` as ordinary
   `allowedPaths` entries, not in code.
5. Deny a path-looking token that also carries shell noise, the same conservative
   rule the traversal scanner uses[^9].

Only apply this when `allowedPaths` is defined. Legacy permissive agents keep
today's behavior, so nothing changes for live agents until a type opts in.

Expect adversarial review. The traversal scanner needed four rounds to close
glued prefixes, `${IFS}`, empty-quote splices, brace expansion and heredoc
delimiter tricks[^9]. A string scanner can be complete for the honest case and
conservative for the noisy case, but it cannot be a kernel boundary. For a real
read fence, the sandbox branch is the answer (§5.3).

### 6.7 Instructions and display

- `buildPathIsolationSection`[^24] must say "worktree only" plus the entries
  when the list is defined, and drop the "`~/.claude`, `/tmp`, and general system
  paths" sentence in that case.
- `ib info` and the `ib watch` detail pane should show the resolved list. Today
  only `ib list-types` prints it[^33].
- SPEC.md §2.2, §5.2 and §6.1, `docs/implementation-notes.md`, and
  `docs/agent-types/README.md` describe the anchor and the grammar.

### 6.8 Cross-cutting checklist

1. **Agent functionality.** `meta.json.allowedPaths` keeps its shape (absolute
   strings). Spawn gains two validation errors. Resume is unchanged[^40].
2. **Hooks.** claude: step 9 baseline, optional Bash fence. codex: context and
   `--add-dir`. agy: Bash fence only. `session-start` text. `main-path` untouched.
3. **Watchdog.** Not affected. Denials still log `[PreToolUse] Permission denied`
   and the agent keeps running.
4. **`ib watch` / dashboard.** Show the list in the detail pane. The `b` dialog
   edits `permissions` only; adding path edits there is out of scope.

### 6.9 Enforcement layer for command arguments: hook scanner or `sandbox-exec`

Adam asked whether `sandbox-exec` could enforce the fence. It can, and it is
already built: `agent/sandbox-feature` wraps the CLI process in a Seatbelt
profile with a per-agent network proxy, for claude and for codex[^29]. The kernel
sees each path after the shell has expanded it, so none of the string-scanner
holes in §6.6 apply. That branch is the right enforcement layer for command
arguments. `sandbox-exec` is a macOS tool; on any other platform the hook stays
the only layer.

Proposed split:

| Layer | Role | Source of truth |
|---|---|---|
| Kernel (`sandbox-exec`) | The fence. A read or write outside the list fails with EPERM, whatever the spelling. | resolved `allowedPaths` in `meta.json`. The sandbox spec says to derive `allowRead` and `allowWrite` from it[^31], but the code does so only when no layer has a `sandbox:` block[^42], and `_all.md` always has one[^43]. See §6.10 amendment 2. |
| Hook, file tools and `cd` | Fast decision plus a readable "Access denied" reason. Unchanged (§1.3). | the same list |
| Hook, Bash arguments (§6.6) | Advisory. Catches the honest spellings (`/abs`, `~/`, `$HOME`) and explains the denial before the kernel does. Not the security boundary. | the same list |

Integration points for the discussion:

1. **Resolve once.** `newAgent` resolves every entry (absolute, `~`, repo-root
   relative) to an absolute path and stores it (§6.2). The hook and the profile
   generator both consume the stored absolutes. `src/sandbox.ts` never sees a
   relative entry, so its grammar[^39] needs no change for `allowedPaths`.
   Whether `sandbox.allowRead` / `allowWrite` should accept relative entries
   themselves is a separate question.
2. **Mode alignment.** `allowedPaths` absent means permissive; sandbox
   `enabled: false` means no kernel fence. Proposal: a strict `allowedPaths`
   (present in the leaf) with the sandbox disabled is a spawn-time warning
   ("hook-only fence; command arguments are not enforced"), so nobody mistakes
   the advisory layer for the real one.
3. **Union rules must match.** §6.3 unions `allowedPaths`; the sandbox branch
   already unions its lists across layers[^31]. Deny wins there; `allowedPaths`
   has no deny list, so there is nothing to reconcile yet.
4. **Agy.** The sandbox branch covers claude and codex[^29]; agy has no
   sandbox today[^22]. `sandbox-exec` wraps any process, so agy parity is a
   launch-line change in `buildAgyStartContent`[^21], but agy needs its own
   baseline bisection, as claude did[^29]. Until then agy relies on the hook,
   which is one reason to build §6.6 even as an advisory layer.
5. **Ordering.** `sandbox-safety` rebases the branch first. This feature's
   spawn-time pieces (§6.2 resolution, §6.3 union, §6.4 scratchpad, §6.5 codex
   context) do not depend on the sandbox and are small. They can land first so
   the rebased sandbox branch derives its lists from finished `allowedPaths`
   semantics.

### 6.10 Amendments from `sandbox-safety` (2026-09-02)

The `sandbox-safety` agent rebased `agent/sandbox-feature` onto `main` as
`agent/sandbox-safety` (HEAD `e38ae42`) and reviewed §6.9. It agrees with the
split and sent four amendments. I verified the first three against that branch.

**Amendment 1: the shipped kernel profile is a write fence only.** The
`_all.md` baseline lists `/` and bare `~` under `sandbox.allowRead`[^43]. `/`
compiles to a whole-tree subpath and `~` to the whole home, so reads are limited
only by the deny carve-outs. Writes are fenced: `allowWrite` lists specific
directories plus `/private/tmp`, `/private/var/folders` and `/dev`[^43]. Its
proposal, with no code change: replace `/` with the raw rule
`(allow file-read-data (literal "/"))`, drop bare `~`, and list the five
dot-directories and two files claude needs to boot. Types that run `bunx tsc`
without `node_modules` add `~` themselves. Until this lands, "the kernel fences
command-argument reads" is false. I agree.

**Amendment 2: `allowedPaths` never reaches the profile today.**
`mergeSandboxLayerConfigs` calls `resolveSandboxConfig({ allowedPaths })` only
when no layer carries a `sandbox:` block[^42]. `_all.md` always does[^43], so the
derivation the spec describes[^31] is dead code in practice. Its fix: when the
sandbox is enabled, always union the resolved absolute `allowedPaths` into both
`allowRead` and `allowWrite`. `src/sandbox.ts` keeps rejecting relative entries
in `sandbox.allowRead` and `allowWrite`[^39]; `allowedPaths` is the only
relative-capable list. I agree, and this answers my §6.9 point 1 question.

**Amendment 3: the tmux socket is a kernel escape.** SPEC-SANDBOX §4C.3 records
that a process which can write `/private/tmp/tmux-<uid>/` can run
`tmux run-shell` as a child of the unsandboxed tmux server. `_all.md` grants
`/private/tmp` for writing[^43], so the escape is open. Managers need tmux for
`ib new-agent`; workers do not (`ib send` only appends outbox files). Its
proposal: a runtime-injected deny keyed on `metaCanSpawnChildren === false`,
documented as accepted for spawning types. I agree. The same rule covers agy
`run_command`, since agy spawns through `ib new-agent` too[^20].

**Amendment 4: the reverse mode warning.** Sandbox enabled with `allowedPaths`
absent is valid (kernel fences, hook permissive), but EPERM arrives with no
explanation. The session-start text[^24] must say the kernel fence is on and
name the allowed roots. I agree.

**Answers to its two questions.**

(a) *Scratchpad root.* Observed in this session's environment, not documented in
the repo: `/private/tmp/claude-<uid>/<encoded-cwd>/<session-uuid>/scratchpad`,
where `<encoded-cwd>` is the cwd with `/` and `.` replaced by `-`, the same
transform as `encodeClaudeProjectPath`[^44] (this session's value:
`-Users-adamwulf-Developer-bun-itsybitsy--ittybitty-agents-path-isolation-repo`).
Proposed allowed root for both layers:
`/private/tmp/claude-<uid>/<encodeClaudeProjectPath(worktree)>`, one level above
the session id so a respawned session is covered. Take `<uid>` from
`process.getuid()`. Canonicalize by longest existing prefix, as
`canonicalizeSandboxPath` does, because `/tmp` is a symlink and the directory
may not exist at profile time. Keep it in one helper next to
`claudeProjectDirFor`[^45], and verify the layout against a live session before
relying on it, since it is a Claude Code implementation detail.

(b) *Layer entries when the leaf is absent.* Yes, they should still flow into the
kernel lists when the sandbox is enabled. Mechanism: `newAgent` resolves the
layer union once. If the leaf is strict, the union is stored as
`meta.allowedPaths` and the hook is strict. In both cases the union is passed to
`mergeSandboxLayerConfigs`, which stores its own resolved lists in the meta
sandbox block. `meta.allowedPaths` keeps its absent-means-permissive meaning for
the hook, and the kernel gets the union either way.

**One addition from me: the two layers must read one list.** When the sandbox
is enabled, the advisory Bash scan (§6.6) should test tokens against the
kernel's effective `allowRead ∪ allowWrite` from the meta sandbox block, not a
second hard-coded system list. Then the hook never denies what the kernel allows
or the reverse, and `_all.md` does not need to repeat the system read floor
under `allowedPaths`. When the sandbox is disabled, the scan falls back to
`allowedPaths` plus the `_all.md` `sandbox.allowRead` list.

**Caveat accepted from `sandbox-safety`: the hook must also apply the kernel
deny list, and before step 7.** SPEC-SANDBOX §4A.4 works the example
`deny: ["**/.env"]`: the kernel returns EPERM for `<worktree>/.env`, but a deny
evaluated after the worktree allow at step 7 never fires, so the hook would say
"allowed" for a path the kernel refuses[^47]. Three consequences for the hook:

1. Read the sandbox `deny` list from the meta sandbox block and evaluate it
   before step 7, next to the existing protected-file check at step 6[^6].
2. The kernel lists contain globs, so the hook needs `globToSandboxRegex` from
   `src/sandbox.ts`, which is exported[^46], instead of the prefix match in
   `isInAllowedPaths`[^6].
3. Read the effective lists from `meta.json`, frozen at spawn, never from the
   `.md` files, or a resumed agent gets a hook that disagrees with its own
   profile.

It also confirmed the scratchpad shape from a second live session and noted
that the kernel already reaches it today, because `_all.md` grants
`/private/tmp` for reading and writing[^43]; the tmux deny of amendment 3 is a
subpath deny under it, so the scratchpad stays reachable.

**Agreed landing order.** This branch first: §6.2 resolution, §6.3 union, §6.4
scratchpad, §6.5 codex context. Then `agent/sandbox-safety`: the
`mergeSandboxLayerConfigs` union, the `_all.md` read-floor tightening, the tmux
deny. Last: the §6.6 advisory scanner, which matters most for agy because agy
has no kernel layer.

### 6.11 Adam's question: are there two agent types, strict and permissive?

No. No agent type is named strict or permissive. The two words name two
**modes of one frontmatter field**, `allowedPaths`, on any type[^2][^25]:

| Leaf frontmatter | Mode | Hook behaviour |
|---|---|---|
| `allowedPaths` key absent | permissive | steps 7 to 11 (always-allowed and always-denied sets), then step 13 allows everything else |
| `allowedPaths: []` | strict | steps 7 to 11, then step 12 denies everything else |
| `allowedPaths: [entries]` | strict | steps 7 to 11, then step 12 allows only the entries |

The presence of the key in the leaf type's frontmatter decides the mode[^2].
All seven live types omit it, so every live agent is permissive. `meta.json`
carries the field only when the leaf defined it[^5].

**Where path permissions are defined today.** Three places, which is the
problem:

1. In code, per agent, in no `.md` file: the always-allowed set (worktree, own
   `agent.log`, own Claude project dir) and the always-denied set (other agents'
   dirs, main repo, protected files)[^6]. Codex adds hard-coded `--add-dir`
   roots of its own[^14][^15].
2. In the type `.md`: `allowedPaths`, from the leaf and its `inherits:` chain
   only[^4][^5].
3. In the type `.md`, sandbox branch only: the `sandbox:` block (`enabled`,
   `allowRead`, `allowWrite`, `deny`, `rawAllow`, `domains`), unioned across all
   layers with the baseline in `_all.md`[^43], plus runtime-injected roots for
   the agent dir, the git dir, and the repo agents dir[^49].

**Proposed single model.** This matches the stated goal: one kind of agent, all
path permissions in the `.md` files, basic defaults shipped.

1. **One mode, deny by default.** Remove the permissive mode. An agent's
   effective allow set is the union of `_all.md`, `_non_coordinator.md`, the
   `inherits:` chain, and the leaf. A type that wants everything says so:
   `allowedPaths: ["/"]`. The sandbox spec already requires "fully open" to be
   explicit[^48].
2. **One vocabulary.** A top-level `paths:` block with `allowRead`,
   `allowWrite`, and `deny`, one nesting level, parsed like `permissions:`.
   `sandbox-safety` proposed this and it is adopted here. `sandbox:` keeps only
   the kernel-only knobs: `enabled`, `rawAllow`, `domains`. `allowedPaths` is
   retired. No live type uses it, so there is no config migration, but its code
   goes: parse and validation in `agent-types.ts`[^2][^3], the resolution block
   in `newAgent`[^5], hook steps 12 and 13[^6], the session-start text[^24], and
   SPEC §2.2, §5.2, §6.1[^25]. All three lists accept the §6.1 grammar plus
   globs; relative entries anchor at the main repo root. Everything compiles at
   spawn into `meta.json`: absolute paths for plain entries, anchored patterns
   for globs. The hook and the kernel both read `meta.json` (§6.10). A sugar
   `paths.allow: [x]` meaning read plus write can come later if the duplication
   annoys.
3. **Basic defaults live in `_all.md`.** The system read floor (`/usr`, `/bin`,
   `/opt/homebrew`, `/Library`, `/System`, `/private/tmp`,
   `/private/var/folders`, `/dev`, `/private/etc`), the home dot-directories
   claude needs to boot, `~/.itsybitsy`, and the deny carve-outs (`~/.ssh`,
   `~/.aws`, `**/.env`). §6.10 amendment 1 tightens this list first.
4. **Runtime-injected, not in `.md`, because they are per agent:** the
   worktree, own agent dir, own Claude project dir, scratchpad, git common dir,
   and repo agents dir. The kernel already injects most of these as `-D`
   parameters[^49]; the hook hard-codes the same set[^6]. SPEC §6.1 lists them
   as "always on".
5. **Structural denies stay in code:** other agents' dirs, the main repo for
   worktree agents, and the protected files. No `.md` can re-open them.
6. **The kernel switch is the only switch left.** `sandbox.enabled` keeps its
   default in `_all.md`. Off means hook only, on every platform, at advisory
   strength for command arguments. On means kernel plus hook, on macOS. The
   lists are the same either way.
7. **Transition.** With today's `_all.md`, whose read list holds `/` and
   `~`[^43], the hook under this model changes nothing for reads and tightens
   writes to the listed write roots plus the runtime roots. Decision 6 (§7)
   makes the read-floor tightening of §6.10 amendment 1 **required**, not
   optional: with `/` and `~` in the read list, strict is not strict for reads.
   The floor becomes the system directories, the five home dot-directories,
   the two home files, `~/.codex` for codex, and one raw rule for the mandatory
   root listing. Cost: `bunx tsc` in a worktree without `node_modules` needs
   `~` for reading; the fix is `bun install` in the worktree, or the type adds
   `~` itself. That lands on the sandbox branch. Before writes tighten, the
   roots codex receives today through `--add-dir`[^14][^15] must be covered.
   `sandbox-safety` split them by kind, and the split is adopted:
   - **Runtime roots, code-injected, keyed on the resolved
     `canSpawnChildren`:** the git common dir, and the parent repo's
     `.ittybitty/agents` and `.claude` subdirectories. A spawning type gets
     them for writing (child agent dir, `settings.local.json`) and keeps the
     tmux socket; a non-spawning type gets them read-only and loses the tmux
     socket (§6.10 amendment 3). One key, one rule.
   - **Toolchain caches are per-type entries, not baseline** (revised in
     §6.14): named subpaths such as `~/Library/Caches/org.swift.swiftpm`,
     added by the types that need them. The only `~/Library` entry in
     `_all.md` is `~/Library/Keychains`, read only.
   - **`~/.itsybitsy` floor:** not the whole directory, which codex got only
     because its sandbox is coarse, and not `~/.itsybitsy/agents` alone
     either. Running agents also write `~/.itsybitsy/teams/<team>.channel.jsonl`
     and `<team>.log` on `ib send @<team>`[^50], and `teams.json` plus
     `.teams.lock` at the root through the lazy prune in `ib send` and
     `ib roster` and through `ib team add` / `remove`[^51]. `sandbox-safety`
     verified this, withdrew "agents only", and settled the floor for
     `_all.md` `allowWrite`: `~/.itsybitsy/agents` (subtree),
     `~/.itsybitsy/teams` (subtree), and three literals, `~/.itsybitsy/teams.json`,
     `~/.itsybitsy/teams.json.tmp`, and `~/.itsybitsy/.teams.lock`. The temp
     name must be listed because Seatbelt checks a rename against both the
     source and the destination path; the registry writes `teams.json.tmp` and
     renames it[^57]. If that name ever changes, `ib send @<team>` fails loudly
     with EPERM, which is the right failure. `agent-types/`, `config.json`,
     `repos.json`, and `layout.json` stay read-only; `ib watch` and
     `ib init-types` write them, never a running agent. The floor no longer
     needs Adam; the code settles it.
   Known gap on the sandbox branch, stated by `sandbox-safety`: `ib new-agent`
   from a sandboxed manager is untested and probably fails today, because the
   shipped profile injects the repo agents dir read-only[^49]. The
   `canSpawnChildren`-keyed runtime root above fixes it and lands with the tmux
   deny. No live agent hits it while `enabled` is false everywhere.
8. **Hook operation classes.** Read, Grep, Glob, LS, and `cd` are reads.
   Write, Edit, MultiEdit, NotebookEdit, and codex `apply_patch` are writes.
   Agy tools map through their translation table[^20]. A Bash token is a read,
   and a write when it is a redirect or `sed -i` target[^8]. Other write shapes
   (`mv`, `cp`, `tee`, `mkdir`) are not recognised by the scanner; the kernel is
   authoritative for writes.

**Migration risk.** Once the read floor is tightened, every live agent becomes
strict for reads and writes at the hook on the same day. So before the flip:
land the roots above, and run an **audit mode** for a few days, where the hook
logs would-be denials for **both** reads and writes to `agent.log` without
denying, to collect the entries each type needs. Types whose work
reaches outside their repo add their own entries; the `repos:` field already
scopes such types. Audit mode can only live at the hook layer: `sandbox-exec`
denials never reach the unified log, so the kernel has no audit mode. Per the
zero-baked-in rule it is a frontmatter scalar, `paths.audit: true` in
`_all.md`, resolved like `sandbox.enabled`, and removed once the entries are
collected. Not a `config.json` key, not a code constant.

### 6.12 Adam's questions: read-only versus read-write lists; `sandbox-exec` around every CLI with yolo

**Q1: separate lists for read-write and read-only paths?** Yes. The `paths:`
block of §6.11 already has them: `allowRead`, `allowWrite`, `deny`. The kernel
distinguishes the two operations[^52], and the baseline needs the distinction:
the system directories, the home dot-files, and `~/Library/Keychains` are
read-only; the `~/.itsybitsy` floor, per-type toolchain caches, and project
directories are read-write. One refinement,
which `sandbox-safety` proposes to build: today `allowWrite` compiles to
`file-write*` only[^52], so a path listed only for writing cannot be opened for
reading, a footgun with no real use. So **`allowWrite` means read plus write**
(the generator emits both operations), **`allowRead` is the read-only list**,
and **`deny` wins over both**. An author writes each path once, in the list that
names the strongest access. At the hook: Read, Grep, Glob, LS, and `cd` pass on
either list; Write, Edit, MultiEdit, NotebookEdit, and `apply_patch` pass only
on `allowWrite`.

**Q2: `sandbox-exec` around each CLI, the CLI's own permission-skip flag per
agent, all path control in the sandbox layer?** Yes, recommended, with a precise
meaning for "yolo". `sandbox-safety` and I agree on this; the shipped sandbox
branch already does it for codex (`-a never -s danger-full-access` inside our
profile)[^29]. Extend it to claude (`--dangerously-skip-permissions` when the
sandbox is enabled) and to agy (add the wrapper; agy needs its own baseline
bisection).

What it gives:

1. **Uniform enforcement.** The kernel sees every process (git, bun,
   xcodebuild, MCP servers, sub-shells), for every CLI, whatever the spelling of
   a path. The hook's Bash scanners[^8][^9][^35] lose only one role: fencing
   paths **outside** the repo, which is the kernel's job. They keep their
   structural role, because the kernel **grants** the three roots they
   protect (`sandbox-safety` amendment, accepted): the settings-write guard
   stays, because `<worktree>/.claude/settings.local.json` is inside the
   worktree and the worktree is fully writable in the kernel; the `git -C` /
   `--git-dir` / `--work-tree` guard stays, because the shared git common dir
   is injected read-write as a boot root[^49], so
   `git --git-dir=<repo>/.git update-ref refs/heads/main <sha>` passes the
   kernel; the other-agents needles and the traversal scanner stay, because the
   repo agents dir is read-injected for every agent and write-injected for
   spawners (§6.11 item 7), so a manager writing another agent's `meta.json`
   passes the kernel. This is §6.11 item 5, "structural denies stay in code".
2. **A network fence too**, through the per-agent proxy on the sandbox
   branch[^29].
3. **Hook failure stops being catastrophic.** Codex hooks fail open[^12], and
   a rebuild that takes `ib` off PATH leaves claude with no hook decision. With
   the kernel as the boundary, those windows are bounded by the sandbox.
4. **Codex loses its coarse, leaky sandbox**[^16] in favour of ours.

What "yolo" must mean: skip the CLI's own permission prompts, but **keep the
PreToolUse hooks**. A hook deny still blocks under skip-permissions; this is
verified live for agy[^53] and is documented Claude Code behaviour for claude,
to confirm in the pilot rather than from a desk. The hooks keep the jobs the
kernel cannot express:

1. **Tool policy.** The type's allow and deny lists (deny WebFetch, deny Write
   for a read-only researcher, deny `git push --force` inside an allowed path),
   and the single-command rule for agy and coordinators[^18].
2. **Sub-agent interception.** Task and Agent redirect to `ib new-agent`,
   codex `features.multi_agent=false`[^14], agy sub-agent tools denied[^20].
   The kernel would let a native sub-agent run inside the same sandbox; the
   rule that spawning goes through `ib` is a harness rule, not a path rule.
3. **Structural cross-agent denies.** Seatbelt is per path, not per binary. It
   cannot tell the agent writing another agent's outbox from `ib` doing it on
   the agent's behalf, and for a spawning type it cannot tell "retire my child"
   from "retire a sibling". The relationship gate[^55] stays. Follow-up: move
   that gate into `ib` itself, deriving the caller from cwd as `ib new-agent`
   already does[^54], so it holds even without hooks.
4. **State tracking and instructions.** PreToolUse marks the agent running,
   Stop reads the state line, session-start renders the instructions[^24].
5. **Readable reasons and audit mode** (§6.10, §6.11). The kernel has no audit
   mode: `sandbox-exec` denials never reach the unified log; the spike proved
   bisection is the only way[^56].

Conditions and costs, to state plainly:

- **Never yolo without the kernel.** The permission-skip flag is passed only
  when the agent's sandbox is enabled. A spawn with the sandbox off keeps
  today's prompting mode.
- **macOS only.** `sandbox-exec` is deprecated by Apple but still present, and
  Claude Code's and codex's own sandboxes depend on it too. Linux falls back to
  hook-only.
- **The read floor must land first** (§6.10 amendment 1), or the kernel is a
  write fence only.
- **The spawn-keyed runtime root and tmux rule must land** (§6.10 amendment 3,
  §6.11 item 7), or `ib new-agent` from a sandboxed manager fails.
- **Baselines per toolchain.** The claude and codex boot floors are
  bisected[^29]; heavy toolchains (Xcode, simulators, Docker) are not, and each
  new one is a manual bisection because the kernel cannot audit[^56].
  Mitigation: types opt in one at a time as each toolchain is verified, and
  `rawAllow` covers syscalls and mach services. Note that a type cannot opt
  **out** once a layer above it enables the sandbox: `sandbox.enabled` is
  OR-merged across the chain, and a descendant may never switch off a sandbox
  enabled by an ancestor[^58]. See the end state below.
- **MCP servers under the profile are untested** (a backlog item on the
  sandbox branch).
- **The tmux socket stays an accepted escape for spawning types** until
  `ib new-agent` is routed through an unsandboxed helper.
- **Keychain-backed git credentials remain reachable**, because
  `~/Library/Keychains` is in the read floor.
- **The prompt safety net is gone.** Under yolo, a hook that returns no
  decision no longer falls back to a prompt. Acceptable only because the kernel
  holds paths and network; tool policy is unenforced during such a window.
- **Codex's fail-open hook contract** must be re-judged once its prompts are
  gone; a pilot item.
- **Residual for the system coordinator in hook-only mode** (found in the
  Phase B review of the write guard, 2026-09-05). Its worktree root is its
  whole `~/.itsybitsy` home, so the hook guards writes to the type directory,
  the config and registry files, and the seal directory structurally, for the
  write tools and for Bash redirect and in-place-edit targets. The command
  shapes the scanner does not model (`tee`, `cp`, `mv`, `mkdir`, and a symlink
  created and then written through) reach those files unguarded while the
  system coordinator runs without the kernel. The advisory scanner (§6.6)
  logs the honest spellings; the kernel closes the rest once the coordinator
  is sandboxed. Accepted and documented, not fixed at the hook.

End state, corrected after `sandbox-safety` flagged the merge rule: "true in
`_all.md` with per-type opt-out" is not implementable, because a layer can only
tighten[^58]. Three ways out, for Adam to choose; `sandbox-safety` recommends
the first for the transition and the third for the end state, and I agree:

- **(a) Transition:** `_all.md` keeps `enabled: false`; types opt in one by one
  as each toolchain is verified.
- **(b) Last-wins merge:** rejected by the sandbox spec, because it lets a leaf
  switch off a floor.
- **(c) End state:** `_all.md` sets `enabled: true`; a type that cannot yet be
  fenced writes **explicit** wide allows (`allowRead: ["/"]` plus the write
  roots Xcode needs) instead of disabling. That keeps the network proxy and
  matches "fully open is explicit"[^48].

The `paths:` block is the one place path control is defined. The kernel
enforces it; the hook explains it and keeps the tool, structural, and harness
rules.

### 6.13 Adam's question: does the more specific entry win between `allowRead` and `allowWrite`?

Yes, at both layers. The two layers reach it by different mechanisms, so they
need one shared test oracle. Adam's two examples, and the rule that produces
them:

| Entries | Path | Result |
|---|---|---|
| `allowWrite: ~/Documents`, `allowRead: ~/Documents/Important` | `~/Documents/Important/x` | read only |
| same | `~/Documents/other/x` | read and write |
| `allowRead: ~`, `allowWrite: ~/Documents` | `~/Documents/x` | read and write |
| same | `~/Desktop/x` | read only |

**The rule.** For a path P and an operation, read or write:

1. If any `deny` entry matches P, deny. Deny wins over everything at any
   depth, the existing rule[^59]. So `allowRead ~/Documents/Important` under a
   write root makes it read-only, while `deny ~/Documents/Important` makes it
   unreadable too. They are different tools.
2. Otherwise find the **most specific** plain entry, across the union of
   `allowRead` and `allowWrite` from all layers plus the runtime roots, that is
   P or an ancestor of P. Most specific means the longest canonical path. Its
   list decides: `allowWrite` gives read and write; `allowRead` gives read only.
3. If the same canonical path is in both lists, **writing is allowed**. Adam
   decided this on 2026-09-02 at 16:19. Listing a path twice is redundant, not
   a restriction. (Both agents had recommended a validation error; overruled.)
4. No match means deny.

**Order never matters; only specificity does.** Adam asked this directly on
2026-09-02 and the answer is yes. The order in which an author lists entries
in a `.md` file, the order of the lists, and the order of the layers have no
effect. The merged set is sorted by the specificity key before anything is
emitted or evaluated, so the profile order is derived, never authored, and the
kernel's last-match rule is an internal mechanism the author never sees.
Within one list, order cannot matter at all, because every entry grants the
same access. Where two entries have the **same** key and different access, the
tie is broken by a fixed rule, not by position. For the same canonical path in
both lists, rule 3 applies: **write wins**, and the generator emits the
read-only entry before the write entry so the allow-write is the last match.
For two **different** globs that share a literal prefix and sit in different
lists, prefix depth cannot separate them and "the same path" does not apply;
v1 treats that as a **validation error** at spawn, fail-closed like the
bare-name rule[^32], with `deny` as the tool for carve-outs. A later version
can add a secondary key for glob specificity. The oracle tests feed every
fixture in shuffled order and must get the same answer.

Three implementation notes from `sandbox-safety`, accepted, no semantic
change: (1) order independence needs a **total** sort key, or the shuffled
test cannot demand a byte-identical profile: primary the specificity key,
secondary the canonical path lexically, tertiary the operation with read
before write; the same key is used in the generator and in
`resolvePathAccess`, so they agree by construction. (2) The write-wins tie is
applied at merge time by moving an exact duplicate out of `allowRead` into
`allowWrite`, since write implies read; no duplicate reaches the generator or
the resolver, and the profile carries one rule pair for that path. The lists
stored in `meta.json` stay as authored, after resolution to absolute paths but
without the dedupe, so `ib info`, the dashboard, and audit messages show the
author's intent; only the resolver and the generator dedupe, through one
shared normalize step. (3) The same glob in both lists is an exact tie and
writes; same-prefix globs in the same list never conflict; two different
globs with one prefix in different lists are the v1 validation error.

**Specificity key**, pinned with `sandbox-safety`: for a plain entry, the
segment count of its canonical path. For a glob, the literal prefix before the
first metacharacter; a glob and a plain entry with the same prefix tie on the
key, and the glob sorts later because it matches fewer paths. Two different
globs with the same prefix and different access are a validation error in v1,
as stated above, never a list-order question. A glob's rules affect only the paths it matches; it
never changes the decision for a path it does not match. The deny list is
absolute and outside this ordering. So `allowWrite: ~/Documents` plus
`allowRead: ~/Documents/**/*.pdf` makes the PDFs read-only and everything else
under Documents writable.

**Kernel.** Seatbelt decides by the **last matching rule**[^59], and the
generator already relies on this by emitting config denies last[^52]. So the
compiler sorts the merged entries by the specificity key ascending, ancestors
first, and emits per entry: `allowRead` gives `(allow file-read* X)` plus
`(deny file-write* X)`; `allowWrite` gives `(allow file-read* X)` plus
`(allow file-write* X)`. The explicit write-deny on every read-only entry is
what makes the first example hold; the order is what makes the second hold.
Config denies come last, unchanged.

**The runtime roots must be sorted into the same table, not emitted first.**
This is the one point where I differ from `sandbox-safety`'s walk-through,
which emits the runtime roots before the type entries. If they come first, any
read-only ancestor of the worktree, such as `allowRead: ~/Developer` to browse
sibling projects, or today's `allowRead: ~`[^43], emits a later
`(deny file-write* ~/Developer)` that is the last match for a write inside the
worktree, and every agent of that type loses write access to its own worktree.
Sorted by depth, the worktree is deeper, its write allow comes later, and it
wins. The same holds for the agent dir, the git dir, the scratchpad, and the
project dir. Runtime roots are ordinary `allowWrite` entries in the table; a
type entry nested inside one can still narrow it, and `deny **/.env` still
fires inside the worktree (§6.10). `sandbox-safety` accepted this and
confirmed it is real against today's `_all.md`, whose `allowRead: "~"`[^43]
would have cost every agent its own worktree. Fix adopted on its branch: the
runtime roots join the specificity table and sort by the depth of their
resolved value, which the generator has at profile time. This changes
`generateProfile`, which today emits the runtime-root rules first[^49], and
will be noted in SPEC-SANDBOX §4A.7 and §5.1.

**Hook.** One pure function in `src/sandbox.ts`,
`resolvePathAccess(absPath, op, { allowRead, allowWrite, deny })`, returns
allow or deny: deny list first; then the most specific matching entry across
both lists decides; no match denies. The runtime roots are passed in as
`allowWrite` entries so specificity includes them; they are an input list
tagged write, not a separate "always allowed" set, so the hook and the
generator feed the function the same table. `checkFilePath` calls it
after the structural steps 6, 10, and 11[^6]; the always-allowed steps 7 to 9
fold into the table as runtime write roots, which is what puts deny before the
worktree allow (§6.10). The same function is the oracle for the generator
tests.

**Tests, shared by both layers.** One table-driven oracle: each row is
(entries per list, path, operation, expected). The hook evaluator and a
simulator that walks the emitted profile in order with last-match semantics
must both return the expected answer for every row, so the layers cannot
drift. Rows:

- write root with a nested read-only subtree: read allowed in the subtree,
  write denied in the subtree, write allowed in a sibling and in the parent;
- read root with a nested write subtree: write allowed in the subtree, write
  denied in the parent, read allowed everywhere under the root;
- three levels alternating write, read, write: the innermost wins at each
  level;
- the same path in both lists: write wins (decided), in every list order;
- two different globs with one prefix in different lists: validation error at
  spawn;
- a read-only ancestor of a runtime root (`allowRead: ~/Developer`): the
  worktree, agent dir, git dir, scratchpad, and project dir stay writable;
- today's `_all.md` verbatim, `allowRead: "~"` plus its write roots: every
  write root stays writable;
- a type `allowRead` nested inside the worktree (`<worktree>/vendor`): that
  subtree becomes read-only, proving narrowing still works after the sort;
- `deny` inside a write root and inside a read-only subtree: both operations
  denied;
- entries from different layers, a read root in `_all.md` and a write subtree
  in the leaf: specificity over the union;
- a relative entry resolved to an absolute path that nests inside an absolute
  entry from another layer;
- canonicalization: `/tmp/x` against `/private/tmp/x`, trailing slashes, `~`
  expansion, with specificity computed on canonical forms;
- the prefix trap: `~/Documents` must not match `~/Documents2`;
- a glob in `allowRead` under a plain write root (`~/Documents/**/*.pdf`):
  matched files read-only, unmatched files writable, whatever the list order;
- order independence: every fixture is also run with its entries, lists, and
  layers shuffled, and must give the same answer and the same emitted profile;
- profile-order test: emitted rules are sorted by the specificity key, every
  read-only entry carries its write-deny, config denies come last;
- a property test over random nested entry sets: hook, simulator, and a
  reference most-specific evaluator agree;
- on macOS, the suite compiles the profile and probes the two scenarios live
  with `sandbox-exec`, because last-match-wins for nested subpaths has been
  relied on but never probed live (`sandbox-safety`'s addition).

### 6.14 The plan, as Adam summarized it, confirmed with precisions

Adam restated the plan in four points on 2026-09-02 at 16:26. All four are
correct. The precisions below are the parts a reader would otherwise get
wrong.

**1. `sandbox-exec` on all CLIs.** Yes. Precisions: macOS only, hook-only
elsewhere. Per type during the transition, because `sandbox.enabled` can only
be switched on by a layer, never off (§6.12); the end state is on in `_all.md`
with explicit wide allows for a type that cannot yet be fenced. Agy needs its
own boot-floor bisection before it can be wrapped. Two pilot checks remain:
that a hook deny still blocks claude under skip-permissions, and MCP servers
under the profile.

**2. Yolo for each CLI so the sandbox holds the path logic.** Yes, with two
precisions. Yolo means "skip the CLI's own permission prompts", and it is
passed only when that agent's sandbox is enabled; never yolo without the
kernel. The sandbox holds all path logic for the filesystem **outside the
structural roots**. The hooks stay, and keep: the structural rules that live
inside roots the kernel grants (the agent's own settings file inside the
writable worktree, `git --git-dir` against the shared git directory, other
agents' directories inside the repo agents dir), tool policy, sub-agent
interception, the manager-only `ib` commands, state tracking, readable denial
reasons, and audit mode (§6.12).

**3. Read and write paths defined by the agent-type `.md` files.** Yes:

- One `paths:` block with `allowRead` (read only), `allowWrite` (read and
  write), and `deny`.
- The files build one set: the union across `_all.md`, `_non_coordinator.md`,
  the `inherits:` chain, and the leaf, plus the runtime roots of point 4.
  Order never matters (§6.13).
- The most specific entry wins between read and write; the same path in both
  lists writes; `deny` wins over everything at any depth; globs rank by their
  literal prefix.
- A path in no list is disallowed for both operations. A missing `paths` key
  is strict, not permissive. Fully open must be written out as
  `allowRead: ["/"]`. Caveat: this is true only after the `_all.md` read floor
  is tightened (§6.10 amendment 1); today it lists `/` and `~` for reading.

**4. Pre-allowed paths.** Yes, in two kinds. **Runtime roots** are per agent,
injected by code, and never appear in a `.md`: the agent's worktree (read and
write), its agent dir with `agent.log` and `meta.json`, the shared git common
dir (read and write; `git --git-dir` stays hook-guarded), the repo agents dir
(read for all, write for spawning types, which also keep the tmux socket), the
Claude project dir under `~/.claude/projects`, and the scratchpad under
`/private/tmp/claude-<uid>/`. Not the main repo root: that stays denied for
worktree agents. **Baseline entries** live in `_all.md` and are editable:

- `~/.itsybitsy`: read for the whole directory; write for `agents`, `teams`,
  `teams.json`, `teams.json.tmp`, and `.teams.lock`; `agent-types/`,
  `config.json`, `repos.json`, `layout.json` read only (§6.11 item 7).
- The system read floor: `/usr`, `/bin`, `/sbin`, `/System`, `/Library`,
  `/opt/homebrew`, `/private/etc`, `/private/var`, `/dev`, plus the raw
  root-listing rule; write for `/private/tmp` (tmux socket denied for
  non-spawners) and `/private/var/folders`.
- The home boot set for claude: `~/.claude`, `~/.claude.json`, `~/.local`,
  `~/.bun`, `~/.gitconfig`; `~/.codex` for codex; agy's own set once bisected.
- `~/Library`, to Adam's question "how specific can we be": very. The
  verified boot floor needs exactly **one** `~/Library` path, `~/Library/Keychains`
  read only (keychain-backed OAuth and git credentials; writes go through
  `securityd`, not the process; an accepted reachability, §6.12). That is the
  only `~/Library` entry in `_all.md`. Toolchain caches are **per-type entries
  with named subpaths**, found by bisection because the kernel cannot audit:
  `~/Library/Caches/org.swift.swiftpm` for SwiftPM (xcodebuild aborts during
  package resolution without it[^14]), `~/Library/Caches/pip`,
  `~/Library/Caches/Homebrew`; bun's cache lives under `~/.bun`, already in
  the floor. A coarse `~/Library/Caches` is a fallback a type may choose, not
  the floor. Xcode and simulator types add their own entries the same way
  (`~/Library/Developer/CoreSimulator`, `~/Library/Logs`; DerivedData stays
  inside the worktree per the repo's build rules). `sandbox-safety` revised
  the earlier "Caches in the baseline" idea to this, and I agree; §6.11 item 7
  and §6.12 are aligned.
- Deny carve-outs in the baseline: `~/.ssh`, `~/.aws`, `**/.env`.

**Two precisions `sandbox-safety` is giving Adam, repeated here.** "Agent repo
root" means the agent's worktree plus its agent dir, never the main repo root;
coordinators are the exception, because their worktree is the repo root. And
"not in the list means disallowed" holds for reads, writes, and directory
listings, but file metadata (`stat`: existence, size, mtime) is granted
globally because the bisection proved it mandatory, and the root directory
listing is allowed by the raw rule.

**Pre-denied regardless of any list:** other agents' directories, the main
repo outside the worktree, the agent's own `.claude/settings*.json` and agy
boundary files for writing, and the tmux socket for non-spawning types.

---

## 7. Historical decisions (Adam, 2026-09-02)

1. **Anchor.** Relative entries resolve against the main repo root the worktree
   was spawned from. An entry cannot name that root itself; accepted, because
   steps 10 and 11 deny it for worktree agents anyway.
2. **Layers.** The original decision used the then-current `allowedPaths` name:
   union the path policy across `_all.md`, `_non_coordinator.md`, and the
   `inherits:` chain, the same way `permissions` merge. The implemented
   top-level `paths:` block carries that union rule. The later strict-default
   decision superseded §6.3's idea that the leaf decides the mode.
3. **Strict baseline.** Claude agents get their scratchpad. Anything wider is an
   `_all.md` entry.
4. **Command arguments.** Fence them. Adam raised `sandbox-exec`; §6.9 gives the
   position. The enforcement layer is to be settled with the `sandbox-safety`
   agent.
5. **Ordering.** `antigravity` is merged to `main` and this branch is rebased
   onto it. `agent/sandbox-feature` is being rebased by `sandbox-safety`. Do not
   merge it yet. Adam, `sandbox-safety`, and `path-isolation` will discuss the
   strategy next.
6. **Default mode, after reading the discussion.** Key absent means strict.
   An agent gets only its worktree and the default paths: the runtime roots and
   the `_all.md` baseline. This is §6.11 item 1. The permissive mode is gone,
   and with it the "leaf decides the mode" idea in §6.3.

---

## 8. Implementation history and build order

Adam asked on 2026-09-02 at 16:32 which agent builds first and which builds on
top. The answer follows from where the shared code lives: `src/sandbox.ts`
(canonicalizer, glob compiler, profile generator), the `sandbox:` frontmatter
merge, the meta sandbox block, and the spawn wiring exist only on
`agent/sandbox-safety`[^29][^39][^52]. The `paths:` block integrates with all
of them, so it must be built on top of that branch, not on bare `main`.

This **reverses** the order set in §6.9 point 5. That order was set when
`allowedPaths` was the source of truth; the single model retired it, and the
`paths:` block is now a refactor of machinery `sandbox-safety` already owns
and has 141 tests for: the one-level block parse and validation, the union
across layers, the `meta.json` persistence and resume replay, the
canonicalizer, the glob compiler, and the generator. `sandbox-safety` proposed
the reversal and I agree: if `path-isolation` built `paths:` fresh on `main`,
there would be two list-merge systems to reconcile on rebase.

**Phase A, `sandbox-safety` builds first, on `agent/sandbox-safety`:**

1. Move `allowRead`, `allowWrite`, `deny` out of `sandbox:` into a top-level
   `paths:` block; `sandbox:` keeps `enabled`, `rawAllow`, `domains`.
2. `allowWrite` emits read and write; merge-time dedupe of an exact duplicate
   into `allowWrite`; the total-key specificity sort with the runtime roots in
   the table; a write-deny per read-only entry; config denies last.
3. The shared `resolvePathAccess(absPath, op, lists)` in `src/sandbox.ts`,
   the table-driven oracle, the shuffled-order rows, and the live
   `sandbox-exec` probe on macOS.
4. The `_all.md` floors: the read floor to the bisected set, the settled
   `~/.itsybitsy` write floor, `~/Library/Keychains` only.
5. The spawn-keyed repo-agents write root and tmux deny.
6. Claude `--dangerously-skip-permissions` when enabled.

Output: a `paths:` block with the absolute, `~`, and glob grammar, unioned,
sorted, generated, and one resolver function, all tested.

**Phase B, `path-isolation` builds on top, rebased onto that branch:**

1. The relative-to-repo-root grammar in the `newAgent` resolve step (§6.2),
   resolving once and storing the authored-resolved lists in `meta.json`.
2. Retire `allowedPaths` everywhere (§6.11 item 2).
3. The hook calls `resolvePathAccess` after the structural steps with the
   runtime roots folded in as write entries, strict by default; the codex and
   agy handlers pass the lists; codex `--add-dir` parity for the non-sandboxed
   path.
4. The scratchpad runtime root; the advisory Bash scanner (§6.6, against the
   resolver); session-start text; `ib info` and dashboard display; SPEC §2.2,
   §5.2, §6.1 and the implementation notes. The proposed `paths.audit` mode was
   dropped before Phase B began and was not implemented.
5. `ib init-types --check`: diff the `paths:` and `sandbox:` blocks of the
   live layer files against the embedded ones and print what is missing.
   Agreed with `sandbox-safety` on 2026-09-04 as a Phase B item; listed in
   the gate preconditions.
6. ~~`ib sandbox refresh`~~ moved to Phase A (item A7, `sandbox-safety`),
   because the resume code is theirs. It re-derives an existing agent's
   sandbox block and path lists from the current `.md` files, rewrites its
   `meta.json`, and resumes it. Required by the enable-all gate, because a
   resumed agent otherwise rebuilds its profile from the config frozen in its
   own `meta.json`[^60], and `/respawn` is a pause plus resume that keeps that
   block, so flipping `_all.md` in either direction changes nothing for live
   agents.

**Shipping ledger and the gate.** Adam asked on 2026-09-02 at 16:55 for
documentation that says what is shipped and when, and for a clear gate that
describes how to enable the sandbox for all agents even if existing agents
break. Both live in `docs/SANDBOX-ROLLOUT.md`. `path-isolation` wrote the
seed; `sandbox-safety` owns the file from its Phase A docs step, because its
branch lands on `main` first; `path-isolation` fills the Phase B rows on
rebase. One file. "Shipped" means installed: on `main`, `ib` rebuilt and on
PATH, `ib watch` restarted.

**Phase A progress and the interface Phase B consumes** (reported by
`sandbox-safety` on 2026-09-02 at 18:16). A1 is merged on
`agent/sandbox-safety` at `3503607` after two review rounds: the top-level
`paths:` block parsed, validated, and unioned across layers; `sandbox:` keeps
`enabled`, `rawAllow`, `domains` and rejects the moved keys with a pointer;
`allowWrite` emits read and write; exact ties collapse into `allowWrite` at
normalize time by compiled-key equality, so `/tmp` against `/private/tmp` and
`~` against its absolute form count as the same path; cross-list different
globs with one canonical prefix are a validation error; `meta.json` `paths` is
frozen at spawn as authored, even with the sandbox disabled, and resume
replays it byte-identical; an enabled meta with no `paths` block is refused on
resume, fail-hard. The legacy `allowedPaths` derivation into the kernel is
gone; `allowedPaths` itself is untouched for Phase B to retire. A2 (the sort,
runtime roots in the table, `resolvePathAccess`, the oracle and live tests) is
building. Exports Phase B consumes from `src/sandbox.ts`: `PathsConfig`,
`resolvePathsConfig`, `canonicalizePathsConfig`, `normalizePathsConfig`,
`validatePathsFrontmatter`, `canonicalizeGlobPrefix`, `canonicalizeSandboxPath`,
and, from A2, `resolvePathAccess(absPath, op, { allowRead, allowWrite, deny,
runtimeRoots })`; `mergeSandboxLayerConfigs` is exported from
`src/ib-commands.ts` and returns `{ sandbox, paths }`.

**A2 merged** on `agent/sandbox-safety` at `8918447` (reported 21:27, two
review rounds, all approved). The resolver interface Phase B calls, final:

- `prepareAccessTable(table, roots) -> PreparedAccessTable`: sorted and
  compiled once, pure, safe to cache per agent; home baked in at prepare time;
  no environment reads at resolve time. `table = { allowRead, allowWrite, deny }`
  as canonical absolute paths (run `canonicalizePathsConfig` on the meta
  lists); `roots = Array<{ name, path, op: "read" | "write" }>` for the
  runtime roots: worktree, agent dir, git dir, repo agents dir, and Phase B's
  scratchpad and project dir.
- `resolvePreparedAccess(prepared, absPath, op) -> "allow" | "deny"`: the
  target is canonicalized inside (longest existing prefix, `/tmp` to
  `/private/tmp`), so both spellings resolve identically; relative input
  throws. Deny wins at any depth; otherwise the most specific matching entry
  decides; no match denies.
- `resolvePathAccess(absPath, op, table, roots)` is prepare plus resolve for
  one-shot use. Exported types: `PathsConfig`, `PreparedAccessTable`,
  `OrderedPathEntry`, `CompiledPath`.
- Boundary (SPEC-SANDBOX §4A.8): the resolver models the paths table only,
  not `sandbox.rawAllow`, which can widen or narrow the kernel; the one
  sanctioned divergence after A3 is the root listing rule.
- Proven equal, resolver against the SBPL oracle against the live macOS
  kernel, on Adam's two examples, the `~`-read trap, today's floor verbatim,
  ties, deny at any depth, and the glob arms.

A3 (floor tightening, spawn-keyed roots, tmux-socket deny, live claude boot
gate) is building with a Claude worker. Ledger note: codex builders cannot
run `sandbox-exec`, because a nested Seatbelt refuses `sandbox_apply`, and one
wedged for ninety minutes on a long `ib send`; live-gated pieces are built by
Claude workers from here on.

**A3 merged** on `agent/sandbox-safety` at `bd0a2c4` (reported 2026-09-03
00:02, two review rounds, approved). Shipped: the `_all.md` floor is the
verified minimum (no `/` or `~` in `allowRead`; the root listing through
`rawAllow`; the settled `~/.itsybitsy` write floor; `~/Library/Keychains`
only); spawn-keyed runtime roots (`REPOAGENTS`, and `PARENTCLAUDE` for
`<repo>/.claude`, writable only when the resolved `canSpawnChildren` is
true); the tmux socket closed for non-spawners with both a file deny and a
network-outbound deny after `rawAllow`, because a review found that a
unix-socket `connect()` is gated by network rules, not file rules, proven live
with `nc -U`; the socket dir derived from `$TMUX`, else
`TMUX_TMPDIR/tmux-<uid>`; a live probe of 62 rows; an opt-in live boot gate
(`IB_LIVE_BOOT=1`) proving claude boots under the new floor.

Two consequences for Phase B:

1. **Trust boundary, found in review.** The agent dir is a kernel write root,
   because hooks write `meta.json` there. So `meta.canSpawnChildren` and
   `meta.agentType` are agent-editable, and a non-spawner could respawn itself
   into a spawner profile. A4 closes it with a **sealed record** at
   `~/.itsybitsy/sealed/<repoId>-<agentId>.json` (profile inputs plus sha256),
   written by `newAgent`, refresh, and rehire, and for a sandboxed spawner
   through a synchronous unsandboxed tmux `run-shell` helper; the seal dir
   joins the `_all.md` deny list; resume, respawn, and refresh compare and
   fail hard on mismatch. Residual: a spawner can still reach the seal dir
   through the tmux socket, the accepted spawner escape. The hook does not
   read the seal.
2. **Hook inputs.** The runtime roots passed to `prepareAccessTable` must
   include the spawn-keyed operations (`REPOAGENTS` read or write, and
   `PARENTCLAUDE` write, keyed on `metaCanSpawnChildren`) to match the kernel;
   `TMUXSOCK` is a deny entry, not a root. A4 also ships
   `ib sandbox refresh <id> | --all` and claude `--dangerously-skip-permissions`
   emitted only inside the `sandbox-exec` wrapper when enabled.

**Hook-side item this exposes, for Phase B (B3).** The hook reads its lists
from `meta.json` at every call, and today it lets the agent write that file
through Bash: the settings-write guard covers only `.claude/settings*.json` and
the agy boundary files[^8], the absolute-needle scan allows any path under the
agent's own dir[^8], and the traversal scanner allows `../meta.json` from the
worktree for the same reason[^9]; only the Write and Edit tools are stopped, by
step 10[^6]. In kernel mode the frozen profile and the seal make this
harmless. In hook-only mode (sandbox disabled, agy today, Linux) it is a
self-widening path. Phase B adds `<agentDir>/meta.json` to the protected-file
set for writes, both for the write tools and for the Bash redirect and
`sed -i` guard, mirroring the settings-file rule. The kernel cannot tell the
agent's redirect from `ib` writing the file; the hook can, because it sees the
command.

**Phase A complete** on `agent/sandbox-safety` (reported 2026-09-03 14:11;
tip `d34fbf6` then, `005b66f` on 2026-09-04 with seal fixes; `main` moved to
`ff4f54d`). A4 (`c7ed698`): claude skip-permissions only inside the wrapper;
`ib sandbox refresh`; the sealed record, re-sealed on the dashboard `b`
toggle. A5 (`d34fbf6`): `docs/SANDBOX-ROLLOUT.md` seeded from the `8725b37`
draft, Phase A rows filled, Phase B and C rows left for `path-isolation`.
Ships `enabled: false`, zero live change. Merge to `main` is Adam's call.

**The invariant Adam asked for: missing `paths:` equals empty equals deny,
end to end.** The kernel side holds after A1: an undefined block resolves to
three empty lists, layers without a block are filtered out, and the old
permissive derivation is gone. The hook side is Phase B, and it is the only
fence when the kernel is off, for agy, and on other platforms. On `main` today
the hook treats absent as permissive. B3 removes every such path, listed here
so the guarantee is checkable:

1. `checkFilePath` step 13, the allow-everything fallback[^6].
2. Step 12 itself, which fires only when `ctx.allowedPaths` is defined[^6].
3. The codex handler's context built without `allowedPaths`, so Bash and
   every non-`apply_patch` tool fall to step 13, and the `apply_patch`
   fallback to the worktree alone[^12][^13].
4. The agy handler's fallback to the worktree alone[^18].
5. The `@system` branch of `hookCheckPath`, which leaves the list undefined
   on purpose for the legacy fallback[^10].
6. `hookCheckPath` when `meta.json` is missing or unparseable, which leaves
   the list undefined and therefore permissive[^10].

After B3 every handler builds one table from `meta.paths` (empty lists when
the key is absent) plus the runtime roots with the spawn-keyed operations and
the tmux socket as a deny, and calls `resolvePathAccess`. An unreadable
`meta.json` denies with a reason. Two fail-open answers in `hookCheckPath`,
`allow` on malformed stdin and on a non-string `tool_name`[^10], become deny,
matching agy. Tests pin missing, empty, absent meta, and malformed stdin to
deny for all three handlers.

**Historical pre-decision install analysis.** At this point in the design, no
live agent had a `paths` key in its `meta.json`. The kernel profile is frozen at spawn, so
they are unaffected until refreshed. The hook reads `meta.paths` at every
call, so the moment Phase B is **installed**, every live agent becomes strict
at the hook: worktree plus runtime roots only, not even the `_all.md` read
floor, because that floor is not in their `meta.json`. This is decision 6
applied. The rollout row "after Phase B installed, live agents unchanged
until refreshed" was therefore wrong for the hook. The report initially
presented immediate refresh and a proposed `paths.audit` mode as alternatives;
Adam's later decision below selected the three-step immediate install and
dropped audit entirely. The `@system` coordinator has no `meta.json`; its lists come from
`_all.md` plus `system.md`, resolved at launch and stored where the hook can
read them; missing is deny there too. No `paths.audit` flag was implemented.

**Refresh confirmed, and a sharper edge** (`sandbox-safety`, 2026-09-04
17:42). `ib sandbox refresh` rewrites `meta.paths` and `meta.sandbox` from
the current `.md` files unconditionally, sandbox enabled or not; only the seal
verify and re-seal are gated on enabled. It also pauses and resumes the
agent, so `--all` restarts every non-stopped agent. The edge: Adam's **live**
`~/.itsybitsy/agent-types/_all.md` has no `paths:` block. The tightened floor
lives in the embedded `docs/agent-types/_all.md`, and `ib init-types` writes
only files that are missing, never updating an existing one[^61]. So a
refresh alone would populate every agent's `meta.paths` with an empty floor,
and the hook would still allow only the worktree and the runtime roots. The
final Phase B install is therefore **three steps**, in this order:

1. Add the `paths:` floor (read floor and write floor) from the embedded
   `docs/agent-types/_all.md` to the live `~/.itsybitsy/agent-types/_all.md`.
2. Install Phase B: merge, rebuild `ib`, copy to PATH, restart `ib watch`.
3. Run `ib sandbox refresh --all` in each repo.

This replaces the wrong rollout row "after Phase B installed, live agents
unchanged until refreshed"; `path-isolation` corrects the Phase B rows in
`docs/SANDBOX-ROLLOUT.md` on rebase. Proposed Phase B helper so step 1 is not
a hand edit: `ib init-types --check` (or `ib sandbox floor`), which diffs the
`paths:` and `sandbox:` blocks of the live layer files against the embedded
ones and prints what is missing; the gate doc lists it as a precondition
check. The kernel half of the invariant is pinned by tests on the sandbox
branch at `d757031`, the new rebase target.

**Adam's decisions before Phase B started (2026-09-05 12:04).** Install right
away; **no audit-only mode**; `paths.audit` is dropped from the plan. Path
denials must appear in the **Denials tab of `ib watch`** for an agent, so Adam
can watch an agent trying to reach a path. That tab parses the agent log for
lines beginning `[PreToolUse] Permission denied:`[^62], so hook path denials
already land there; Phase B keeps that prefix and appends the operation, the
resolved path, and the rule that denied it, so the row says what was tried
and why. Kernel denials never reach the agent log[^56], so the advisory Bash
scanner (§6.6) is **required**, not optional: it is the visibility layer for
command-line paths, turning an honest `cat ~/.ssh/id_rsa` into a logged hook
denial before the kernel refuses it. The Phase B install is the three-step
sequence above, run at once.

**Phase B execution (started 2026-09-05).** Three Claude workers, each
followed by a two-reviewer cycle; codex workers are excluded because they
cannot run `sandbox-exec`. Worker 1, spawn side: `src/agent-types.ts`,
`newAgent` and `refreshAgentSandbox` in `src/ib-commands.ts`, the relative
anchor helper in `src/sandbox.ts`, `src/index.ts`, `ib init-types --check`,
SPEC §2.2 and §5.2. Worker 2, hook side, in parallel: a new
`src/hooks/paths-table.ts` that builds the `PathAccessTable` from `meta.paths`
plus the runtime roots (computed from the hook context, including the git
common dir and the tmux socket dir, with the scratchpad and project dir
appended as write roots), the three handlers rebuilt on
`resolvePreparedAccess`, the six absent-means-allow paths removed, malformed
input denied, `<agentDir>/meta.json` protected, the denial log line. Worker 3,
after worker 2 lands: the advisory Bash scanner, session-start wording,
`ib info` and dashboard display, SPEC §6.1, implementation notes, and the
Phase B rows of the rollout document. Interface facts for the workers, read
from the merged `main`: `sandboxPathAccessTable(paths, params)` builds the
table from `SandboxProfileParams` (`AGENTDIR`, `WORKTREE`, `GITDIR`,
`REPOAGENTS`, `PARENTCLAUDE`, `TMUXSOCK`, `canSpawnChildren`, `HOME`);
`prepareAccessTable` and `resolvePreparedAccess` are the per-agent cached
form; `validatePathsFrontmatter` compiles every entry with the absolute, `~`,
and glob grammar and so rejects relative entries today; `metaCanSpawnChildren`
lives in `src/agent-types.ts`; `resolveTmuxSocketDir` lives in
`src/ib-commands.ts` and must move to a light module before a hook imports it;
`AgentMeta` already types `paths` and `sandbox`; the profile parameter values
are not stored in `meta.json`.

**Historical parallel option during Phase A** (not the final execution plan):
`path-isolation` could start the pieces that touched none of `agent-types.ts`,
`newAgent`, or `sandbox.ts`: Bash-scanner tokenization in `agent-path.ts`
against a resolver interface, session-start text, the codex hook context, and
the `ib info` display. The then-proposed audit-mode plumbing was later dropped.
The branch would then rebase onto the sandbox branch for resolver integration
and `allowedPaths` retirement.

**Merge order.** `agent/sandbox-safety` merges to `main` after Phase A; it
ships with `enabled: false`, so no live agent changes behaviour. Then
`agent/path-isolation` rebases onto `main`, finishes Phase B, and merges.

**Phase C, pilot.** Enable the sandbox on one supported (claude, codex, or fugu) type
in this repo, confirm the two pilot checks (a hook deny under the CLI's
permission-bypass/no-prompt mode; MCP under the profile), then enable supported
types one by one. There is no audit mode. Agy kernel sandboxing is unavailable;
an enabled agy policy fails closed before launch until a supported wrapper and
boot floor exist.

**Phase B integration note (branch status, 2026-09-05).** The original
`agent/path-isolation` work and both Sol continuation branches are merged on
`agent/codex-path-isolation` at `1ec1529`. This includes the repo-anchored
`paths:` grammar, `allowedPaths` retirement, deny-by-default shared hook table,
protected writes, `ib init-types --check`, session-start text, policy displays,
and SPEC / implementation-note updates. The reachable integration commits are
the inherited advisory scanner `a239357`, scanner coverage `165475d`,
redirect/destination hardening `1ec1529`, kernel `PROJECTDIR`/`SCRATCHPAD`
spawn/refresh wiring `0480d68`, and instruction/lifecycle wiring `81d018d`.
The final central-review fixes align CLI-specific roots and safe partial-list
display at `7cc63fa`, then harden agy rejection and Codex instruction refresh at
`11f0ebc`.
Phase B is **ON BRANCH**, not yet `INSTALLED` in the rollout ledger. Audit mode
was dropped before implementation and does not ship.

## 9. Limitations of this report

- Codex read behavior under `workspace-write` is taken from the repo's research
  notes[^17], not re-tested live in this session.
- The commit counts in §5.3 come from `git log` range listings on 2026-09-02.
- The `antigravity` agent supplied a written map of the hooks on request; every
  claim in this report was then verified against the code it named. Its two
  additions that I could not verify in code (kernel read behavior) are cited to
  the research notes instead.

---

[^1]: [`AgentType.allowedPaths` field](src/agent-types.ts:AgentType)
[^2]: [absent → undefined, present → list or []](src/agent-types.ts:buildAgentTypeFromFrontmatter)
[^3]: [startup validation: must be a list of strings](src/agent-types.ts:validateAllAgentTypes)
[^4]: [`allowedPaths` and `repos` replace; permissions union](src/agent-types.ts:mergeRawFrontmatters)
[^5]: [resolution block: `~` expansion, `resolve()`, `realpathSync`, stored in meta.json](src/ib-commands.ts:newAgent)
[^6]: [steps 6–13 in order](src/hooks/agent-path.ts:checkFilePath)
[^7]: [Bash: only `cd` reaches checkFilePath; file tools pass file_path/path/notebook_path](src/hooks/agent-path.ts:checkPathAccess)
[^8]: [needle scans, traversal, settings write; no allowedPaths lookup](src/hooks/agent-path.ts:checkBashCommandPaths)
[^9]: [tokenizer, noise rule, four candidate forms, heredoc masking](src/hooks/agent-path.ts:checkRelativeTraversalPaths)
[^10]: [CLI entry: reads meta.allowedPaths, allow list from settings.local.json, worktree = agentDir/repo](src/hooks/agent-path.ts:hookCheckPath)
[^11]: [shared resolver reads meta.allowedPaths; comment "Codex ignores this field"](src/hooks/agent-context.ts:resolveAgentContext)
[^12]: [codex handler builds PathCheckContext without allowedPaths](src/hooks/codex-pre-tool-use.ts:hookCodexPreToolUse)
[^13]: [apply_patch forced to ctx.allowedPaths ?? [worktree]](src/hooks/codex-pre-tool-use.ts:checkCodexPreToolUse)
[^14]: [`--add-dir` for coordinator home, Library/Caches, extraWritableRoots](src/codex-config.ts:buildCodexLaunchArgs)
[^15]: [codex writable roots: git common dir + parent repo subdirs](src/ib-commands.ts:newAgent)
[^16]: [SPEC-CODEX-MODEL §3.2: workspace-write leaks /tmp, $TMPDIR, ~/.codex/memories; hook is the enforcement layer](SPEC-CODEX-MODEL.md:71-73)
[^17]: [workspace-write: auto file edits + command execution within cwd; .git/.codex/.agents read-only](SETTINGS-HOOKS-RESEARCH.md:532-537)
[^18]: [agy decision function: single command, deny list, Cwd gate, forced allowedPaths](src/hooks/agy-pre-tool-use.ts:checkAgyPreToolUse)
[^19]: [agy handler passes ctxResolved.allowedPaths; fail-closed](src/hooks/agy-pre-tool-use.ts:hookAgyPreToolUse)
[^20]: [agy tool translation table](src/hooks/agy-tools.ts:translateAgyTool)
[^21]: [agy launch line](src/agy-spawn.ts:buildAgyStartContent)
[^22]: [agy: hooks.json is the only boundary, no sandbox, no --add-dir](src/agy-config.ts:1-16)
[^23]: [SPEC-ANTIGRAVITY-CLI Risk 9: run_command reads outside the worktree](SPEC-ANTIGRAVITY-CLI.md:146)
[^24]: [Path Isolation section text](src/hooks/session-start.ts:buildPathIsolationSection)
[^25]: [SPEC §6.1 allowedPaths modes](SPEC.md:750-755)
[^26]: [SPEC §2.2 inherits: allowedPaths replaces](SPEC.md:319)
[^27]: [default allow list for regular agents](src/settings-builder.ts:REGULAR_AGENT_DEFAULT_ALLOW)
[^28]: [primary-session hook blocks cd into agent worktrees only](src/hooks/main-path.ts:checkMainPath)
[^29]: [git history, branch agent/sandbox-feature, not on this branch: commits "Wire Seatbelt sandbox and per-agent proxy" (fff8803), "Add Codex parity for per-agent sandbox" (b7ba36b); list with `git log agent/antigravity..agent/sandbox-feature --oneline`](.git)
[^30]: [git range counts on 2026-09-02: `git log agent/antigravity..agent/sandbox-feature --oneline` = 28 commits, `git log agent/sandbox-feature..agent/antigravity --oneline` = 170 commits](.git)
[^31]: [SPEC-SANDBOX decision 4: derive kernel lists from allowedPaths; baseline in _all.md — file lives only on branch agent/sandbox-feature, read with `git show agent/sandbox-feature:SPEC-SANDBOX.md`](SPEC-SANDBOX.md:263-273)
[^32]: [SPEC-SANDBOX §4A.2: three anchor forms; bare names rejected "relative to what?" — file lives only on branch agent/sandbox-feature, read with `git show agent/sandbox-feature:SPEC-SANDBOX.md`](SPEC-SANDBOX.md:361-395)
[^33]: [`ib list-types` prints allowedPaths](src/index.ts:2393-2395)
[^34]: [tests: steps 10/11 win over allowedPaths; ~/.claude/projects root denied in strict mode](src/hooks/agent-path.test.ts:1599-1741)
[^35]: [git -C / --git-dir / --work-tree guard](src/hooks/shared.ts:checkGitDirectoryFlags)
[^36]: [claude launch line in start.sh](src/ib-commands.ts:5412-5445)
[^37]: [rootRepoPath from resolveGitRoot](src/ib-commands.ts:newAgent)
[^38]: [resolveGitRoot uses --git-common-dir](src/agent-lifecycle.ts:resolveGitRoot)
[^39]: [relative globs rejected at spawn — file lives only on branch agent/sandbox-feature, read with `git show agent/sandbox-feature:src/sandbox.ts`](src/sandbox.ts:147-150)
[^40]: [resume copies meta.allowedPaths through](src/ib-commands.ts:1553)
[^41]: [codex start.sh launch line](src/codex-spawn.ts:buildCodexStartContent)
[^42]: [allowedPaths reaches resolveSandboxConfig only when no layer has a sandbox block — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:src/ib-commands.ts`](src/ib-commands.ts:mergeSandboxLayerConfigs)
[^43]: [sandbox baseline: allowRead lists "/" (line 13) and "~" (line 31); allowWrite lists "/private/tmp" (line 38) — file version on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:docs/agent-types/_all.md`](docs/agent-types/_all.md:12-40)
[^44]: [project-dir encoding: replace `/` and `.` with `-`](src/auto-compact.ts:encodeClaudeProjectPath)
[^45]: [own Claude project dir helper](src/hooks/agent-path.ts:claudeProjectDirFor)
[^46]: [exported glob compiler — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:src/sandbox.ts`](src/sandbox.ts:globToSandboxRegex)
[^47]: [SPEC-SANDBOX §4A.4 worked example: deny all .env, even inside the worktree — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:SPEC-SANDBOX.md`](SPEC-SANDBOX.md:418-435)
[^48]: [SPEC-SANDBOX: fully-open is explicit-only, `allowRead: ["/"]` — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:SPEC-SANDBOX.md`](SPEC-SANDBOX.md:326-327)
[^49]: [runtime-injected roots AGENTDIR, GITDIR, REPOAGENTS as `-D` params — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:src/sandbox.ts`](src/sandbox.ts:405-409)
[^50]: [team channel files under `<coordinator home>/teams/`: `<team>.channel.jsonl` and `<team>.log`](src/team-channel.ts:89-105)
[^51]: [teams.json at `~/.itsybitsy/`, read-modify-write under `.teams.lock` by `ib team add`/`remove`, lazy prune in `ib send` / `ib roster`, and teardown prune](src/teams.ts:1-40)
[^52]: [allowRead compiles to `file-read*`, allowWrite to `file-write*` only — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:src/sandbox.ts`](src/sandbox.ts:414-417)
[^53]: [SPEC-ANTIGRAVITY-CLI D2: under skip-permissions nothing prompts and a hook deny still blocks](SPEC-ANTIGRAVITY-CLI.md:20)
[^54]: [caller identity derived from cwd for the `ib new-agent` gate](src/ib-commands.ts:readCallerMetaFromCwd)
[^55]: [manager-only ib subcommand gate](src/hooks/agent-path.ts:checkIbCommandAccess)
[^56]: [spike finding: the unified-log harvest does not surface sandbox-exec denials; use bisection — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:docs/SANDBOX-SPIKE-FINDINGS.md`](docs/SANDBOX-SPIKE-FINDINGS.md:26)
[^57]: [registry atomic write: `teams.json.tmp` then rename; lock file `.teams.lock`](src/teams.ts:53-143)
[^58]: [sandbox.enabled OR-merged across the chain; a descendant may never switch off a sandbox enabled by an ancestor — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:src/agent-types.ts`](src/agent-types.ts:462-506)
[^59]: [SPEC-SANDBOX §4A.4: "SBPL = last matching rule decides"; precedence rule, deny wins over any allow at both layers; filesystem denies emitted last — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:SPEC-SANDBOX.md`](SPEC-SANDBOX.md:426-446)
[^60]: [resume prepares the sandbox from `agent.meta.sandbox`, the frozen config, not from the type files — file lives on branch agent/sandbox-safety, read with `git show agent/sandbox-safety:src/ib-commands.ts`](src/ib-commands.ts:1531-1548)
[^61]: [`ib init-types` writes only the missing embedded files; existing files keep their edits](src/agent-types.ts:initAgentTypes)
[^62]: [the Denials tab parses agent.log lines `[YYYY-MM-DD HH:MM:SS] [PreToolUse] Permission denied:`](src/agents.ts:parseDenials)

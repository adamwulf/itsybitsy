# SPEC-PATH-ALLOWLIST.md — Path allow-list for agent types

**Status:** DRAFT. Research report plus a design proposal. Nothing here is implemented.
**Written:** 2026-09-02 by researcher agent `path-isolation` on branch `agent/path-isolation`,
first on the `antigravity` agent's HEAD (`184c671`), then rebased onto `main` after that
branch merged.
**Decisions:** Adam answered the five questions on 2026-09-02. The answers are in §7 and
applied in §6. The enforcement strategy for command arguments (§6.9) is still under
discussion with Adam and the `sandbox-safety` agent, who is rebasing `agent/sandbox-feature`.

---

## 0. Summary

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

## 1. What exists today

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

## 6. Proposed design

### 6.1 Entry grammar

One field, `allowedPaths`, four forms, classified by prefix:

| Form | Example | Anchor |
|---|---|---|
| Absolute | `/Users/adam/Developer/shared-lib` | none |
| Home | `~/Documents`, bare `~` | `$HOME`, as today[^5] |
| Relative | `../fumble` | the main repo root the worktree was spawned from (decided, §7) |
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

---

## 7. Decisions (Adam, 2026-09-02)

1. **Anchor.** Relative entries resolve against the main repo root the worktree
   was spawned from. An entry cannot name that root itself; accepted, because
   steps 10 and 11 deny it for worktree agents anyway.
2. **Layers.** Union `allowedPaths` across `_all.md`, `_non_coordinator.md`, and
   the `inherits:` chain, the same way `permissions` merge. §6.3 proposes that
   the leaf decides the mode.
3. **Strict baseline.** Claude agents get their scratchpad. Anything wider is an
   `_all.md` entry.
4. **Command arguments.** Fence them. Adam raised `sandbox-exec`; §6.9 gives the
   position. The enforcement layer is to be settled with the `sandbox-safety`
   agent.
5. **Ordering.** `antigravity` is merged to `main` and this branch is rebased
   onto it. `agent/sandbox-feature` is being rebased by `sandbox-safety`. Do not
   merge it yet. Adam, `sandbox-safety`, and `path-isolation` will discuss the
   strategy next.

---

## 8. Limitations of this report

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

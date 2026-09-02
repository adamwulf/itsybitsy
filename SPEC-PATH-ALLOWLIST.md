# SPEC-PATH-ALLOWLIST.md — Path allow-list for agent types

**Status:** DRAFT. Research report plus a design proposal. Nothing here is implemented.
**Written:** 2026-09-02 by researcher agent `path-isolation` on branch `agent/path-isolation`,
reset to the `antigravity` agent's HEAD (`184c671`).
**Open decisions** are marked **[DECISION]** and collected in §7.

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

Recommendation for the anchor of relative entries: the **main repo root**, not
the worktree. The reason is in §5.2. This is the first **[DECISION]**.

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
| Relative | `../fumble`, `./vendor` | **[DECISION]** repo root (recommended) or worktree |
| Explicit anchor tokens | `{{repoRoot}}/../fumble`, `{{worktree}}/build` | optional; makes intent visible in the `.md` |

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

### 6.3 Layer contribution **[DECISION]**

Today only the type and its `inherits:` chain feed the list, and a child
replaces its parent[^4][^5]. Two options:

- **A. Keep replace.** Simple. A baseline must be repeated in every strict type.
- **B. Union across `_all.md` → `_non_coordinator.md` → chain**, with `[]` in the
  leaf meaning "strict, ignore layers". This mirrors how `permissions.allow` is
  merged[^4] and how the sandbox spec put its baseline in `_all.md`[^31].

Recommendation: **B**, because a baseline (§6.4) is otherwise unmaintainable.

### 6.4 Strict-mode baseline **[DECISION]**

Strict mode today denies the scratchpad and `~/.claude`[^6]. Proposed
always-allowed additions, applied at step 9 alongside the project dir:

- the session scratchpad root `/private/tmp/claude-<uid>/<encoded-cwd>/` (claude
  only; derived the same way as the project dir);
- nothing else by default. `/tmp` as a whole stays opt-in because it is shared
  with every other agent.

Codex already gets `/tmp` from its sandbox[^16]; the hook should keep parity by
listing the same scratchpad root.

### 6.5 Codex parity

1. Pass `ctxResolved.allowedPaths` into the `PathCheckContext` in
   `hookCodexPreToolUse`[^12], as agy does[^19].
2. Add each resolved entry as an `--add-dir` root in `buildCodexLaunchArgs`[^14],
   so the sandbox and the hook agree. Entries must pass
   `isCodexSafeBinaryPath`[^14]; reject the spawn otherwise.
3. Update the "Codex ignores this field" comment[^11].

### 6.6 Bash command-line fence **[DECISION]**

This is what turns "whitelist which paths agents may visit" from a file-tool rule
into a real rule. Proposed, for all three CLIs, inside `checkBashCommandPaths`[^8]:

1. Tokenize as `checkRelativeTraversalPaths` does (quotes stripped, heredoc
   bodies masked)[^9].
2. Collect candidate paths: tokens that start with `/`, `~`, `~/`, `$HOME`,
   `${HOME}`, and the right-hand side of `--flag=<path>`.
3. Resolve each against cwd and run it through `checkFilePath` with the tool
   name `Bash`.
4. Add a **system read baseline** so toolchains keep working: `/usr`, `/bin`,
   `/sbin`, `/opt/homebrew`, `/Library`, `/System`, `/private/tmp`, `/private/var/folders`,
   `/dev`, `/etc`. Baseline lives in `_all.md` under a new `systemPaths:` key or
   is hard-coded; **[DECISION]**.
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

---

## 7. Decisions needed

1. **Anchor for relative entries.** Repo root (recommended, §5.2) or worktree as
   originally proposed. Explicit `{{repoRoot}}` / `{{worktree}}` tokens can be
   added either way.
2. **Layer contribution.** Replace (today) or union with `[]` as the strict
   override (recommended, §6.3).
3. **Strict-mode baseline.** Scratchpad only (recommended, §6.4), or `/tmp`.
4. **Bash command-line fence.** In scope now (§6.6), or deferred to the sandbox
   branch. Without it, the allow-list fences file tools and `cd`, not `cat`.
5. **Sandbox branch.** Rebase and merge it first, or build the hook-level
   feature now and port the grammar to it later.

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

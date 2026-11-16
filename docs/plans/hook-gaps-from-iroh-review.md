# Hook gaps found during the iroh Phase 1 review

The reviewers of iroh peering Phase 1 found these gaps on 2026-11-16. The
review was on branch `agent/iroh-peering`, merge `edc3594f`. None are fixed.
Most predate peering. They are recorded here so each can be fixed and reviewed
as its own change.

**Background.**

- The agent-path hook checks Bash commands with an *advisory* scanner, in
  `src/hooks/agent-path.ts` (`tokenizeBashPaths`, `scanBashCommandPaths`,
  `checkBashSettingsWrite`).
- For a sandboxed agent, the kernel profile is the real boundary.
- `@system` runs unsandboxed. Its working directory is `~/.itsybitsy`, and its
  worktree root is all of `~/.itsybitsy`. So for `@system` the hooks are the
  only boundary.
- `@system` also takes Telegram input.
- Adam's kernel sandbox is currently OFF. Until it is turned on, the hooks are
  the only boundary for every agent.

"Verified" below means a reviewer ran a probe against the real hook functions.
"Reported" means a reviewer read the code but did not probe it.

## 1. The Bash scanner never checks relative paths against `paths.deny`

**What.** The scanner resolves only paths that start with `/`, `~` or `$HOME`.
A relative token is never compared with `paths.deny`.

**Effect.**

- `@system` (cwd `~/.itsybitsy`, `Bash(ib:*)`) can run
  `ib tgsendfile peer/secret.key`. `telegramSendFile` resolves the path, and
  the unsandboxed `ib watch` outbox uploads the iroh secret key to the
  Telegram chat.
- `cat peer/secret.key` works the same way, for any agent whose allow list
  has `cat`.
- The same applies to every `paths.deny` entry, `sealed/` included. Any
  unsandboxed agent can reach a denied file through a relative path from a
  cwd above it.
- The absolute and `~` spellings are denied.

**Status.** Verified (round-2 review) with `checkIbCommandAccess`,
`checkPathAccess` and `findShellMetachar`. SPEC §12.1.3 now states this gap.

**Fix direction.** Resolve relative tokens against cwd before the
`paths.deny` check, the way the write-target check already resolves redirect
targets.

**Rejected alternative.** A special case in `telegramSendFile`, because
`cat` plus `ib tgsend` would still leak the key.

## 2. Grep on a directory reads denied files inside it

**What.** For the Grep tool, the hook checks only the search root.

**Effect.** With the kernel sandbox off, a Grep over `~/.itsybitsy/peer` (or
over `~/.itsybitsy`) reads `secret.key`. The same goes for any `**/.env` under
a searched directory.

**Status.** Reported (round-2 review). Not probed.

**Fix direction.** Deny a Grep whose root contains a `paths.deny` entry, or
pass the deny entries to Grep as excludes. Turning the kernel sandbox on closes
this for sandboxed agents, but not for `@system`.

## 3. `containsInternalIbInvocation` misses commands glued to operators

**What.** The internal-verb gate (`ib hooks`, `ib write-pid`, `ib sandbox-*`)
splits tokens on whitespace only. For example, `ib list;ib write-pid ...`
produces the token `list;ib`, whose basename is not `ib`.

**Effect.** This gate runs before the `@system` early return in
`checkIbCommandAccess`, so `@system` can run internal verbs through glued
chains.

**Status.** Found by the Phase 1 worker. Not probed.

**Fix direction.** Have this gate use `splitShellWord`, the same function the
`ib peer` and Telegram gates now use. That is about a one-line change. It
needs its own review because it changes a security gate.

## 4. No gate resolves shell expansions

**What.** The `ib` subcommand gates read literal words only.

**Effect.** These all run `ib peer id` but get past the `ib peer` gate:

- `ib $X id` (with `X=peer` set earlier in the chain)
- `ib $(echo peer) id`
- `ib $'peer' id`
- `ib $"peer" id`
- `ib {peer,} id`

**Status.**

- The first three are also stopped by the coordinator metachar gate
  (`findShellMetachar`, SPEC §12.2.4) and, for agents other than `@system`,
  by the chained-command check. Reported.
- `ib $"peer" id` (locale quoting) and `ib {peer,} id` (brace expansion) get
  past BOTH the gate and `findShellMetachar`. So `@system` has a live gap
  here. Verified (round-2 review).

**Fix direction.** Deny any `ib` subcommand word that contains an expansion
character (`$`, `{`, a backtick). Alternatively, add `$"` and brace patterns to
`findShellMetachar`.

## 5. `@system` skips the chained-command check, and the nuke regex misses newline chains

**What.**

- `checkIbCommandAccess` returns early for `@system` before the
  chained-command check that other agents get. Each `ib` gate that must
  cover `@system` therefore has to sit before that return and handle chains
  itself.
- The nuke regex misses `ib list` followed by a newline and then `ib nuke`.

**Status.** Verified (round-1 review) at the `checkIbCommandAccess` level.
Whether intercept-task's `findShellMetachar` stops the newline form in a live
`@system` session was not checked.

**Fix direction.** Run the chained-command check for `@system` too, with
`ib` as the only allowed command, or make each `@system`-relevant gate
chain-aware.

## 6. A glued redirect gets past the settings/meta write guard for ordinary agents

**What.** Both redirect checks in `checkBashSettingsWrite` and
`scanBashCommandPaths` expect the token to *start* with `>` or `N>`. So a
redirect glued to the word before it is not recognized.

**Effect.** `echo '{}'>.claude/settings.local.json` is allowed by the hook. An
agent could rewrite its own permissions or hook settings. The same form also
writes under `~/.itsybitsy/peer/` for `@system`, but there the coordinator
metachar gate stops it. SPEC §12.1.3 documents that this protection depends
on that gate.

**Status.** Verified (round-2 review).

**Fix direction.** Feed `splitShellWord`'s operator splitting into
redirect-target detection, so `word>target` yields the target.

## Suggested order

1. **#1 and #6.** These are real escapes with a realistic trigger: a Telegram
   request, or a natural relative path.
2. **#4.** Close the `$"…"` and brace-expansion forms.
3. **#3 and #5.** Gate hardening for `@system`.
4. **#2.** Low priority once the kernel sandbox is on, but still open for
   `@system`.

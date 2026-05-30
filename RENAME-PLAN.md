# Rename Agent Feature — Implementation Plan (Nickname Design)

## Goal

Let a user give an agent a friendly **nickname** without disturbing its identity. The
agent's `id` stays the canonical, immutable identity; we add an optional `nickname` field
to `meta.json`. The agent then answers to **both** its `id` and its `nickname` anywhere a
user or another agent types an agent name (`ib send`, `ib look`, dashboard selection,
etc.). New-agent creation rejects names that collide with any existing `id` **or**
`nickname`.

## Why nickname (not physical rename)

The agent `id` is woven into ~7 on-disk/runtime artifacts — directory name, git branch
(`agent/<id>`), git worktree path, tmux session (`ittybitty-<repoId>-<id>`), `meta.json`
path, the hook commands baked into `settings.local.json` (`ib hook-check-path <id>` …),
and Claude's transcript dir (`~/.claude/projects/<encoded-worktree>/<session_id>.jsonl`).
A physical rename would have to move/rewrite all of them and restart Claude.

A nickname touches **none** of that. Decisive advantages:

- **No Claude state changes.** Transcript dir, `session_id`, and `--resume` are untouched —
  the resumed (or still-running) agent keeps its full conversation context.
- **No pause/restart.** The agent can be nicknamed *while running*. Nothing is torn down.
- **No git ops, no dir moves, no settings regeneration, no rollback machinery.**
- **No broken references.** Children's `meta.manager` and `meta.spawned_by.agent_id` still
  point at the immutable `id`, so the tree never breaks. Notifications become a courtesy,
  not a correctness requirement.

## Feasibility (verified against the codebase)

Resolution is **centralized**, which is what makes this a small change:

- `matchAgentById` (`index.ts:61-68`) is the single chokepoint — currently matches `a.id`
  only. `findAgentById`, `requireAgent`, and `resolveTarget` all route through it. Adding
  `|| a.meta.nickname === id` here makes agents resolvable by nickname **everywhere**
  (`ib send`, `ib look`, `ib status`, dashboard selection, …).
- `ib send` is clean: `send` case (`index.ts:1119`) → `resolveTarget` → `matchAgentById` →
  Agent → `sendMessage`. The tmux session is read from `agent.meta.tmux_session`
  (`ib-commands.ts:1857`), never matched against the typed name. **Zero changes** in
  send/deliver/outbox.
- `AgentMeta` (`agents.ts:49-69`) is a flat object; add `nickname?: string`. The
  `readAgentMeta` cache (`agents.ts:621`) is mtime-keyed → auto-invalidates. `nickname` is
  a string primitive, so the `copyAgentMeta` spread (`agents.ts:642`) already isolates it —
  no cache/test change there. All meta writers round-trip the whole object, so they
  preserve `nickname`.

### Two callouts (from verification)

1. **Never index `nickname` into the `byId` map.** `buildAgentTree` (`agents.ts:911-925`)
   builds a `Map` keyed by `agent.id` to resolve `manager`. Indexing nicknames there could
   let a nickname **shadow** another agent's id. Keep `nickname` a pure **input alias** —
   used only in `matchAgentById`'s OR-match — never as an internal key. All other id-keyed
   sets are tmux/PID-keyed and safe.
2. **New-agent collision is filesystem-based today.** The current id-collision check is a
   dir-exists test (`ib-commands.ts:2531-2535`), not an in-memory id scan. Nicknames aren't
   directory names, so **nickname collision detection needs a fresh `readAllAgents()`** that
   this code path doesn't currently do. The rename command itself also needs that read for
   its own collision checks.

## Scope

### 1. Data model
- Add `nickname?: string` to `AgentMeta` (`agents.ts:49-69`).
- Add a type-guard for it in `readAgentMeta` validation (~`agents.ts:701`) — must be a
  string or absent (reject other types, like the existing `agentIcon` guard).

### 2. Resolution (the core behavior)
- In `matchAgentById` (`index.ts:61-68`), add an **exact** nickname tier with explicit
  precedence — **id wins over nickname, and nickname is matched exactly only (never as a
  prefix)**. The existing contract (`index.test.ts:176-186`) is "exact id beats prefix"; we
  insert exact-nickname between exact-id and id-prefix:
  ```ts
  const exactId = agents.find((a) => a.id === id);
  if (exactId) return { match: exactId, ambiguous: [] };
  const exactNick = agents.find((a) => a.meta.nickname === id);   // exact, AFTER id
  if (exactNick) return { match: exactNick, ambiguous: [] };
  const matches = agents.filter((a) => a.id.startsWith(id));       // prefix stays id-only
  ```
  Naively OR-ing `a.id === id || a.meta.nickname === id` into the first `find` is a **bug**:
  `find` returns whichever array element matches *either* first, so id would NOT reliably
  win. The validator (§3, reject nickname == any existing id) makes that collision
  impossible in practice, but the code must still encode the precedence so a stale
  `meta.json` can't produce nondeterminism. Resolution makes agents resolvable by nickname
  across `ib send`, `ib look`, `ib info`, `ib status`, `ib kill`, `ib merge`, `ib resume`,
  `requireAgent`, `resolveTarget`, and dashboard selection (all route through
  `matchAgentById`, verified).
- **`resolveAgentId` is a SECOND resolution path that will NOT pick up nicknames.**
  `resolveAgentId` (`ib-commands.ts:3270`) scans directory + tmux-session names (not
  `meta.json`) and backs the `--manager` flag at new-agent time (`ib-commands.ts:2358`).
  **Decision: `--manager <name>` requires the real id** — document it, don't silently leave
  it. (Managers are always referenced by their immutable id internally, so this is fine.)
- **Do NOT** touch `watchdog.ts:218` `findAgent` (it resolves only manager ids, which are
  always real ids — leave id-only).
- **Do NOT** index nickname into the `byId` map in `buildAgentTree` (`agents.ts:912-925`,
  callout 1) — a nickname there could shadow another agent's real id.

### 3. The `rename` (set-nickname) command — `renameAgent(agent, nickname)`
A small, mostly-validation command. No pause, no git, no file moves.

1. **Validate `nickname`** via a shared `validateAgentName(name, repos)` helper — extracted
   from the new-agent checks so id and nickname share one validator. **It takes the repo
   list as a parameter** (the repo-collision check needs it; new-agent already has `repos`
   in scope at `ib-commands.ts:2508`, and `renameAgent` must `await listRepos()` and pass
   it in). Checks:
   - Allowlist `/^[a-zA-Z0-9_\-]+$/` (`ib-commands.ts:2486`) — already bars `@`, `.`, spaces.
   - Reject reserved `coordinator` / `system` (`ib-commands.ts:2489/2500/2503`).
   - Reject repo collisions against **both** the repo name AND the repo nickname — reuse the
     exact predicate `repos.find(r => repoDisplayName(r) === name || r.name === name)`
     (`ib-commands.ts:2520`). **Note:** `RepoEntry.nickname` is a *pre-existing, distinct*
     concept (`registry.ts:8`, `repoDisplayName = repo.nickname ?? repo.name`). Do not
     conflate it with `meta.nickname` (agent). Agent nicknames must not collide with repo
     names or repo nicknames.
2. **Read all agents GLOBALLY** (`readAllAgents()` over ALL registered repos) for in-memory
   collision checks (callout 2). **Nicknames are globally unique** — resolution spans all
   repos (`findAgentById`/`resolveTarget` read all repos then `matchAgentById` over the
   global set), even though id-collision prevention is only per-repo today. So:
   - Reject if `nickname` equals any existing agent's `id` (global) — ids aren't globally
     unique, so this must scan every repo.
   - Reject if `nickname` equals any **other** agent's `nickname` (global).
   - Reject if `nickname === agent.id` (a no-op alias; use `--clear` to remove instead).
   - Allow re-setting the same agent's existing nickname to a new value (overwrite).
3. **Write / clear** `meta.nickname` into the agent's `meta.json` (whole-object round-trip,
   like `writeAgentState` — confirmed all writers preserve the field). Cache
   auto-invalidates (mtime-keyed).
   - Set: `meta.nickname = nickname`.
   - **Clear** (`--clear` or empty arg): `delete meta.nickname` — **delete the field, never
     write `""`** (an empty-string nickname would serialize into meta and could match edge
     cases). `--clear` **skips `validateAgentName` entirely**.
4. **Log** to `agent.log`: `Nicknamed "<nickname>" (id <id>)` (or `Cleared nickname (id <id>)`).
5. **No notifications** (decided by Adam). A nickname breaks no references — `ib send <id>`
   to the original id still works, and children's `meta.manager`/`spawned_by.agent_id` still
   point at the immutable id — so there's nothing to announce. (This drops the whole
   spawner/manager/child notification surface the earlier draft carried.)
6. Return the standard `{ ok, stdout?, stderr? }` shape.

### 4. new-agent validation update (`ib-commands.ts`, newAgent)
- Replace the inline name checks with the shared `validateAgentName(name, repos)`.
- After the existing filesystem id-collision check, add an in-memory pass over a **global**
  `readAllAgents()` rejecting the new id if it collides with any existing **nickname**
  (callout 2). A new agent's id must not equal an existing nickname, just as a nickname must
  not equal an existing id — symmetric, both global.

### 5. CLI wiring (`src/index.ts`)
Add a `case "nickname":` to the dispatch switch (`index.ts:403`). **No `rename` alias**
(decided by Adam — the id is unchanged, so `nickname` is the honest verb). No-arg **shows**
the current nickname rather than erroring:

```ts
case "nickname": {
  const repos = await listRepos();
  const agent = await requireAgent(args[1], repos);   // resolves by id OR nickname
  const rest = args.slice(2);
  const clear = rest.includes("--clear");
  const nickname = clear ? "" : rest[0];
  if (!clear && !nickname) {
    // no-arg: show current nickname
    console.log(agent.meta.nickname ?? "(no nickname set)");
    process.exit(0);
  }
  const { renameAgent } = await import("./ib-commands");
  await printAndExit(await renameAgent(agent, clear ? null : nickname));  // null = clear
  break;
}
```
(`renameAgent(agent, null)` clears; `renameAgent(agent, "<name>")` sets.)

### 6. Dashboard wiring (`src/tui/dashboard.ts` + `src/tui/agent-actions.ts`)
- Bind **`N`** to nickname (verified unbound; `n` is pane-cycle-backward, so `n`/`N` is
  distinct — slightly non-obvious but no conflict). `R`=resume, `P`=pause,
  `r`=reassign/rename-repo, `N`=nickname.
- Add `handleRename` in `agent-actions.ts` mirroring `handleReassign`/`handleRenameRepo`
  (`agent-actions.ts:450`/`1533`): input dialog pre-filled with the current nickname (or
  id), validate, call `ctx.executeAndRefresh(() => renameAgent(agent, nickname))`, show a
  notice. Selection is id-keyed and unaffected — no re-selection needed.
- **Fuzzy finder (`@` jump) must include the nickname.** `handleFuzzyAgent`
  (`agent-actions.ts:830-836`) builds its search string from repoName/id/state/age/prompt —
  **not** the nickname. Append `agent.meta.nickname` to that string so `@` can jump by
  nickname (otherwise nicknames are un-findable in the exact place they're meant to help).
- Register the action in the command palette (`dashboard.ts:1040-1053` — that list is the
  palette, not a "help legend") as `N nickname`.

### 7. Display — single shared `agentDisplayName(agent)` helper
Compact width forces the format (a long id + `(id)` won't fit the ≤60-col sidebar):
- **Compact dashboard tree (≤60 cols):** show the **nickname ALONE** (replacing the id).
  Factor a single `agentDisplayName(agent)` → `nickname ?? id` used by **both**
  `agentNamePrefixWidth` (`agent-tree.ts:42-45`) **and** `formatAgentRow`'s `namePrefix`
  (`agent-tree.ts:64-72`) — one function, not two parallel edits, or the columns misalign.
- **Info panel (always show the real id):** render `nickname (id: <id>)` where there's room
  (`dashboard.ts:207/222`) so the canonical id is always visible/copyable.
- **`ib list` text (`index.ts:522`):** `nickname (id)` (free-form, fits).
- **`ib list --json` (`index.ts:462-475`):** always emit `nickname: a.meta.nickname ?? null`
  so consumers don't have to feature-detect.

## Tests (`src/ib-commands.test.ts` + others)

`renameAgent` describe block (pattern: `mkdtemp` + `meta.json` blobs + `makeAgent` +
per-command spawn-runner mock, like `reassignAgent` at 4546-4783):
- Happy path: nickname written to `meta.json`; agent then resolvable by nickname via
  `findAgentById`/`resolveTarget`; existing `id` still resolves.
- **Precedence:** typed name == one agent's id AND another agent's nickname → **id wins**;
  nickname matched exactly only (a nickname does NOT match a typed prefix).
- Overwrite: setting a new nickname over an old one replaces it.
- Clear: `--clear`/null **deletes** the field (asserts the key is absent, not `""`).
- Negative: invalid name (regex), reserved (`coordinator`/`system`), repo-name AND
  repo-nickname collision, nickname == an existing id (global), nickname == another agent's
  nickname (global, incl. **cross-repo**), nickname == own id.
- **byId shadow guard:** a nickname equal to some other agent's id does NOT shadow it in
  `buildAgentTree` (manager resolution still finds the real id).

Other test files:
- `src/index.test.ts`: `nickname` CLI dispatch (set, `--clear`, no-arg shows current);
  `requireAgent` resolves by nickname.
- new-agent validation: a new id colliding with an existing nickname (global) is rejected.
- `agent-actions`/dashboard: nickname renders in the tree row; fuzzy finder matches nickname.

## Cross-cutting review checklist (from CLAUDE.md)

1. **General agent functionality** — YES: adds an optional `meta.json` field + a new
   resolution alias. Lifecycle/spawn unchanged (no pause/resume). Note `--manager <name>`
   still requires the real id (`resolveAgentId` doesn't consult nicknames).
2. **Hooks** — **Intentionally not changed** (not "unaffected by accident").
   `session-start.ts` is the one place the agent learns its own identity (`You are … agent
   ${ctx.agentId}`, `session-start.ts:436/545`); we **deliberately leave it id-only** —
   nickname is for *others* addressing the agent, and the agent doesn't need to know its own
   nickname. Nickname never reaches `settings.local.json`, path isolation, or any hook
   command (those key off the immutable id), so isolation is genuinely unaffected.
3. **Watchdog** — **Not affected.** `findAgent` (manager/spawner resolution) stays id-only;
   nudge timing / state detection untouched. (No notifications, so the notify helpers aren't
   even used.)
4. **`ib watch` / dashboard** — YES: new `N` key + `handleRename` dialog + nickname in the
   tree row, both nickname + id in the info panel, `ib list`, and the `@` fuzzy finder.
   Selection stays id-keyed.

## Decisions (locked)

- **Nickname design** (not physical rename) — per Adam: smaller change, no Claude state
  change, agent answers to both id and nickname.
- **No notifications** — `ib send <id>` still works and no references break, so nothing to
  announce to manager/spawner/children.
- **`N` dashboard key** (verified unbound).
- **Precedence:** exact id > exact nickname > id-prefix; nickname matched exactly only.
- **Global nickname uniqueness** (validated across all repos).
- **`--manager` requires real id** (documented limitation; `resolveAgentId` is name-based).
- **Hooks left id-only** (agent isn't told its own nickname).
- **CLI:** `ib nickname <id> <name>` — no `rename` alias; no-arg shows current; `--clear`
  (or empty) deletes the field.
- **Display:** compact tree = nickname-only; info panel shows **both** nickname + id; `ib
  list` shows `nickname (id)`.

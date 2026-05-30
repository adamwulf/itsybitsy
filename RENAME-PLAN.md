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
- In `matchAgentById` (`index.ts:61-68`), add `|| a.meta.nickname === id` to the match.
  This single line makes the agent resolvable by nickname across `ib send`, `ib look`,
  `ib status`, `requireAgent`, `resolveTarget`, and dashboard selection.
- **Do NOT** touch `watchdog.ts:218` `findAgent` (it resolves only manager ids, which are
  always real ids — leave id-only).
- **Do NOT** index nickname into the `byId` map in `buildAgentTree` (callout 1).

### 3. The `rename` (set-nickname) command — `renameAgent(agent, nickname)`
A small, mostly-validation command. No pause, no git, no file moves.

1. **Validate `nickname`** via a shared `validateAgentName(name)` helper (extracted from
   the new-agent checks so id and nickname share one validator):
   - Allowlist `/^[a-zA-Z0-9_\-]+$/` (`ib-commands.ts:2486`).
   - Reject reserved `coordinator` / `system` (and `@`-prefixed, already barred by the
     regex) (`ib-commands.ts:2500-2505`).
   - Reject repo-name collisions (`ib-commands.ts:2520`).
2. **Read all agents** (`readAllAgents()`) for in-memory collision checks (callout 2):
   - Reject if `nickname` equals any existing agent's `id` (would make the alias ambiguous).
   - Reject if `nickname` equals any **other** agent's `nickname`.
   - Reject if `nickname === agent.id` (a no-op alias; allow clearing instead — see below).
   - Allow re-setting the same agent's existing nickname to a new value (overwrite).
3. **Write** `meta.nickname = nickname` into the agent's `meta.json` (whole-object
   round-trip, like `writeAgentState`). Cache auto-invalidates (mtime-keyed).
4. **Log** to `agent.log`: `Nicknamed "<nickname>" (id <id>)`.
5. **Notify** (courtesy — not load-bearing; mirror `reassignAgent`'s `notifyAgent` helper,
   `ib-commands.ts:1137-1170`, `fromAgent` = the agent's id):
   - The agent itself: `[watchdog]: You now also answer to the nickname "<nickname>".`
   - The manager (`meta.manager`, if set): `[watchdog for <id>]: Agent <id> now also goes by "<nickname>".`
   - The spawner (`meta.spawned_by.agent_id`, routed like `notifySpawner`, `watchdog.ts:274-333`;
     skip if spawner === manager to avoid a double-send).
   - Each child (`meta.manager === id`): `[watchdog]: Your manager <id> now also goes by "<nickname>".`
   - All sends silently skip targets without a `tmux_session` (same as reassign).
6. Return the standard `{ ok, stdout?, stderr? }` shape.

**Clearing a nickname:** support `ib rename <id> --clear` (or empty nickname) to delete the
field. Decision needed only on the exact flag spelling — default to `--clear`.

### 4. new-agent validation update (`ib-commands.ts`, newAgent)
- Replace the inline name checks with the shared `validateAgentName`.
- After the existing filesystem id-collision check, add an in-memory pass over
  `readAllAgents()` rejecting the new id if it collides with any existing **nickname**
  (callout 2). (A new agent's id must not equal an existing nickname, just as a nickname
  must not equal an existing id.)

### 5. CLI wiring (`src/index.ts`)
Add a `case "rename":` to the dispatch switch (`index.ts:403`):

```ts
case "rename": {
  const repos = await listRepos();
  const agent = await requireAgent(args[1], repos);   // resolves by id OR nickname
  const rest = args.slice(2);
  const clear = rest.includes("--clear");
  const nickname = clear ? "" : rest[0];
  if (!clear && !nickname) { console.error("usage: ib rename <id> <nickname> | ib rename <id> --clear"); process.exit(1); }
  const { renameAgent } = await import("./ib-commands");
  await printAndExit(await renameAgent(agent, nickname));
  break;
}
```

### 6. Dashboard wiring (`src/tui/dashboard.ts` + `src/tui/agent-actions.ts`)
- Bind **`N`** to rename (set nickname). `R`=resume, `P`=pause, `r`=reassign/rename-repo,
  `N`=nickname. Confirm `N` is unbound before wiring.
- Add `handleRename` in `agent-actions.ts` mirroring `handleRenameRepo`: input dialog
  pre-filled with the current nickname (or id), validate, call
  `ctx.executeAndRefresh(() => renameAgent(agent, nickname))`, show a notice. Selection is
  unaffected (the `id` is unchanged), so no re-selection logic is needed.
- Add `N nickname` to the help legend (`dashboard.ts:1046-1048`).

### 7. Display (cosmetic — surface the nickname where the id shows)
Where an agent has a nickname, show it as **`<nickname>`** with the id available (e.g.
`<nickname> (<id>)` in wider contexts, `<nickname>` alone in compact ones). Call sites:
- Dashboard tree row: `agent-tree.ts:72` (`formatAgentRow`) — and keep the width helper at
  `agent-tree.ts:45` in sync.
- `ib list`: `index.ts:522`; `--json`: `index.ts:462` (add a `nickname` field).
- Dashboard info/labels: `dashboard.ts:183/207/222/1295/2216`.
All cosmetic; decide the exact format (`nickname (id)` vs `nickname`) during implementation,
defaulting to showing the nickname with the id in parentheses where width allows.

## Tests (`src/ib-commands.test.ts` + others)

`renameAgent` describe block (pattern: `mkdtemp` + `meta.json` blobs + `makeAgent` +
per-command spawn-runner mock, like `reassignAgent` at 4546-4783):
- Happy path: nickname written to `meta.json`; agent then resolvable by nickname via
  `findAgentById`/`resolveTarget`; notifications to manager/spawner/children/self with the
  exact strings; existing `id` still resolves.
- Overwrite: setting a new nickname over an old one replaces it.
- Clear: `--clear` removes the field.
- Negative: invalid name (regex), reserved (`coordinator`/`system`), repo-name collision,
  nickname == an existing id, nickname == another agent's nickname, nickname == own id.
- Callout guards: a nickname does NOT shadow another agent's id in `buildAgentTree`
  (resolve a manager whose id equals some other agent's nickname → still resolves to the
  real id).

Other test files:
- `src/index.test.ts`: `rename` CLI dispatch case; `requireAgent` resolves by nickname.
- new-agent validation: new id colliding with an existing nickname is rejected.
- `agent-tree`/dashboard: nickname renders in the row.

## Cross-cutting review checklist (from CLAUDE.md)

1. **General agent functionality** — YES: adds a `meta.json` field and a new resolution
   alias. Lifecycle/spawn unchanged (no pause/resume). meta shape gains optional `nickname`.
2. **Hooks** — **Not affected.** Hook commands key off the immutable `id`; nickname never
   reaches `settings.local.json`, path isolation, or any hook. (Confirm: the session-start
   instructions reference the agent by id — fine to leave, or optionally mention the
   nickname; default: leave as id.)
3. **Watchdog** — Minimal: `findAgent` (manager resolution) stays id-only — **not affected**.
   The watchdog's notify helpers are reused as the model for the courtesy notifications, but
   nudge timing / state detection are untouched.
4. **`ib watch` / dashboard** — YES: new `N` key + `handleRename` dialog + nickname display
   in the tree/info/list. Selection stays id-keyed (unchanged), so no focus-follow logic.

## Decisions (locked)

- **Nickname design** (not physical rename) — per Adam: smaller change, no Claude state
  change, agent answers to both id and nickname.
- **3a — `N` dashboard key.**
- **Notifications** — keep them as a courtesy to manager + spawner + children (mutually
  exclusive manager-over-spawner), since the relationship surface was explicitly requested,
  even though nothing breaks without them.

## Open question (small)

- **Clear-nickname flag spelling** — default `ib rename <id> --clear`. Confirm or adjust
  during the plan review.

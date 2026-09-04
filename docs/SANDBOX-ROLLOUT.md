# Sandbox rollout: shipping ledger and the enable-all gate

**Audience:** the operator (Adam). **Owner:** `sandbox-safety` owns this file,
because `agent/sandbox-safety` lands on `main` first. This is the single rollout
document — there is no second one. The seed came from `agent/path-isolation`'s
draft[^seed]; this version fills in the Phase A reality from
`agent/sandbox-safety`. `path-isolation` fills the Phase B rows when it rebases.
Design lives in `SPEC-SANDBOX.md` and, for Phase B/C, in `SPEC-PATH-ALLOWLIST.md`.

**The word "shipped" means INSTALLED.** An item is shipped only when it is on
`main`, the `ib` binary rebuilt (`bun run build`) and copied onto PATH
(`/usr/local/bin/ib`), and `ib watch` restarted. Hooks and spawns call the
installed binary, so a merge to `main` alone changes nothing at runtime. Nothing
in this document is INSTALLED yet: every Phase A row is still on the branch.

---

## 1. Shipping ledger

Status vocabulary, in order of progress:

`NOT STARTED` → `IN PROGRESS` → `ON BRANCH <sha>` → `ON MAIN <sha>` →
`INSTALLED <date>`.

`ON BRANCH` means merged onto its working branch and green there; `ON MAIN`
means merged to `main` but not yet rebuilt/restarted; `INSTALLED` is the only
state that means "shipped" (see the rule above).

### Phase A — `sandbox-safety`, branch `agent/sandbox-safety`

Every Phase A row below is `ON BRANCH agent/sandbox-safety` today
(2026-09-03). None is on `main`.

| # | Item | Status | Tip sha |
|---|---|---|---|
| A0 | Foundation: Seatbelt profile generator, per-agent Bun proxy + lifecycle, codex `danger-full-access` parity, fail-hard preconditions; rebased onto `main`[^a0] | ON BRANCH | `e38ae42` |
| A1 | `paths:` block split out of `sandbox:` (`sandbox:` keeps `enabled`/`rawAllow`/`domains`); `allowWrite` emits read+write; exact cross-list ties collapse to `allowWrite`; `meta.paths` frozen at spawn even when disabled; an enabled meta with no `paths` block is refused on resume[^a1] | ON BRANCH | `3503607` |
| A2 | Most-specific-wins access table: one shared total sort, `resolvePathAccess()`, the SBPL last-match oracle, seeded order permutations, and the LIVE `sandbox-exec` probe on macOS; runtime roots sit in the table; the resolver models the `paths` table only, not `rawAllow`[^a2] | ON BRANCH | `8918447` |
| A3 | `_all.md` floor tightened to the verified minimum (`allowRead` drops `/` and `~`; the root listing moves to the `rawAllow` line `(allow file-read-data (literal "/"))`; the `~/.itsybitsy` write floor; `~/Library/Keychains` only); runtime roots keyed on resolved `canSpawnChildren` (REPOAGENTS write for a spawner / read otherwise; PARENTCLAUDE write for a spawner); the tmux socket denied for non-spawners with both a file deny and a network-outbound deny; the LIVE claude boot gate made opt-in (`IB_LIVE_BOOT=1`)[^a3] | ON BRANCH | `bd0a2c4` |
| A4 | claude `--dangerously-skip-permissions` emitted only inside the `sandbox-exec` wrapper when enabled (G1); `ib sandbox refresh <id> \| --all` re-derives an existing agent's frozen sandbox from the current `.md` files (G2); the sealed record closes the agent-editable-meta boundary for non-spawners, re-sealed on the dashboard `b` spawn toggle (G3)[^a4] | ON BRANCH | `c7ed698` |
| A5 | This rollout document (`docs/SANDBOX-ROLLOUT.md`): the single shipping ledger + enable-all gate + pilot + rollback | ON BRANCH | `d41c06d` |

**A→sub-phase mapping.** The commits between `main` (`a5a51b1`) and
`agent/sandbox-safety` group as: A0 foundation ends at `e38ae42`; A1 (the
`paths:` split) ends at `3503607`; A2 (the resolver + oracle + live probe) ends
at `8918447`; A3 (floor + spawn keying + tmux deny + opt-in boot gate) ends at
`bd0a2c4`; A4 (skip-permissions + refresh + sealed record) ends at `c7ed698`.
`git log --oneline main..agent/sandbox-safety` is the authoritative list.

### Phase B — `path-isolation`, branch `agent/path-isolation`, rebased onto Phase A

Owned by `path-isolation`; the rows are for it to fill on rebase[^b].

| # | Item | Status |
|---|---|---|
| B1 | Relative-to-repo-root grammar resolved once in `newAgent`; authored-resolved lists stored in `meta.json` | NOT STARTED |
| B2 | `allowedPaths` retired everywhere (parse, validate, `newAgent`, hook steps, session-start text, SPEC) | NOT STARTED |
| B3 | Hook calls `resolvePathAccess` after the structural steps, runtime roots folded in, strict by default; codex and agy handlers pass the lists; codex `--add-dir` parity for the non-sandboxed path; `<agentDir>/meta.json` added to the hook's protected-file set (self-widening path in hook-only mode) | NOT STARTED |
| B4 | Scratchpad runtime root at both layers; audit mode (`paths.audit: true` logs would-be denials without denying); advisory Bash scanner against the resolver | NOT STARTED |
| B5 | Session-start strict/kernel-on wording; `ib info` and dashboard show the resolved lists and sandbox state; SPEC + implementation-notes updated; this ledger's Phase B rows completed | NOT STARTED |

### Phase C — pilot and rollout

| # | Item | Status |
|---|---|---|
| C1 | Pilot: one non-spawner type in this repo with `sandbox.enabled: true` (and `paths.audit: true` once B4 lands) | NOT STARTED |
| C2 | Pilot check: the agent boots, reaches the model through the proxy, runs its normal tools, and a hook `PreToolUse` deny still blocks under `--dangerously-skip-permissions` | NOT STARTED |
| C3 | Pilot check: configured MCP servers work under the profile | NOT STARTED |
| C4 | Toolchain entries collected (from audit logs / bisection) and added to the types that need them | NOT STARTED |
| C5 | Enable-all gate passed (§3) | NOT STARTED |
| C6 | Agy wrapper built after its own boot-floor bisection (agy has no sandbox wrapper today) | NOT STARTED |

---

## 2. What runs where, at each point in time

| Point in time | Live agents | New spawns |
|---|---|---|
| **Today** — Phase A on `agent/sandbox-safety`; `main` at `a5a51b1` | No kernel sandbox exists on `main` at all. On the branch, `_all.md` ships `enabled: false`[^disabled], so **no agent is sandboxed** — every `_all.md` baseline is disabled and nothing changes for a live agent until a type sets `sandbox.enabled: true`. | Same. |
| **After merge** — Phase A on `main`, rebuilt, restarted | Unchanged. Every layer still ships `enabled: false`[^disabled], so still **no behavior change**. | Unchanged, until a type opts in. |
| **After a type opts in** — one type sets `sandbox.enabled: true` | Unchanged until refreshed (§3.2): a live agent replays its frozen profile[^frozen]. | Agents **of that type** get the kernel Seatbelt profile + per-agent proxy. |
| **After the enable-all gate** (§3) | Sandboxed once `ib sandbox refresh --all` re-derives them, per repo. | Sandboxed. |

---

## 3. The gate: enable the sandbox for ALL agents

This is the procedure Adam asked for: turn the kernel sandbox on for **every**
agent, accepting that existing agents may break.

### 3.1 One switch is enough, and a leaf cannot switch it back off

`sandbox.enabled` is **OR-merged** across the type layers — any layer that sets
it `true` wins, and no descendant layer can set it back to `false`[^ormerge].
Setting it `true` in `~/.itsybitsy/agent-types/_all.md` therefore enables it for
every type. A type that cannot yet be fenced does **not** disable the sandbox
(it can't); instead it writes **explicit wide allows** — `allowRead: ["/"]` plus
the write roots it needs — which keeps the network proxy in place and matches
the "fully-open is explicit-only" rule[^open]. So the end state is `_all.md`
`enabled: true` plus, for any not-yet-fenceable type, an explicit wide `paths`
block on that type — never `enabled: false` on a leaf.

### 3.2 Why flipping `_all.md` alone changes nothing for live agents

A resumed or respawned agent rebuilds its profile from the sandbox block
**frozen in its own `meta.json`** at spawn time, not from the current `.md`
files. `/respawn` is a pause-plus-resume for every non-coordinator, so it
re-reads the type's markdown *body* but keeps the frozen `sandbox`/`paths`
blocks through any number of respawns[^frozen][^refresh]. `ib sandbox refresh`
(A4 G2) is the deliberate re-derivation: it re-runs the same layer merge
`newAgent` does, rewrites `meta.sandbox` + `meta.paths`, and resumes the agent
so the new frozen block is the one replayed[^refresh]. The switch therefore has
two parts — edit the file, **then** refresh live agents. The reverse is equally
true: setting the file back to `false` does not un-sandbox a running agent until
it is refreshed. This is deliberate: a security-config change goes through an
explicit, logged command.

### 3.3 Preconditions — all must hold before the switch

- [ ] The `_all.md` **read floor is tightened** (done in A3: `/` and `~`
      dropped from `allowRead`, root listing via `rawAllow`)[^a3]. With `/` or
      `~` still in `allowRead`, the kernel fences writes only.
- [ ] The **`~/.itsybitsy` write floor** is in `_all.md` (A3); without it a
      running agent cannot write outboxes/teams state and `ib send` breaks[^a3].
- [ ] **Spawn-keyed roots and the tmux deny** are in (A3); without them
      `ib new-agent` from a sandboxed spawner fails on a read-only repo agents
      dir[^a3].
- [ ] The **pilot on one type passed** (Phase C, §4 — currently **pending**):
      a hook deny still blocks under `--dangerously-skip-permissions`, and MCP
      servers work under the profile.
- [ ] **Audit mode** ran on every type that will be enabled and the toolchain
      entries it surfaced were added (Phase C, C4 — pending; audit mode itself
      is Phase B, B4).
- [ ] **agy is handled.** agy has **no sandbox wrapper today**[^agy], so agy
      agents **cannot be sandboxed** — they must stay disabled or be excluded
      until agy gets its own boot-floor bisection (Phase C, C6 — pending).
      Because a leaf cannot switch `enabled` off (§3.1), "excluded" means the
      agy types either are not enabled by leaving them off a repo, or the
      rollout waits for C6.
- [ ] `ib list-types` validates cleanly (a bad `paths:` block fails validation).

### 3.4 The switch

1. In `~/.itsybitsy/agent-types/_all.md`, set `sandbox.enabled: true`.
2. For any type that cannot yet be fenced, give it the explicit wide `paths`
   block of §3.1 (`allowRead: ["/"]` + its write roots) rather than trying to
   disable it.
3. **Rebuild `ib`** (`bun run build`), copy it onto PATH, and **restart
   `ib watch`**.
4. Run **`ib sandbox refresh --all` in each registered repo** — it refreshes
   only the current repo's agents[^refresh], so run it per repo. Every active
   agent's `meta.json` is re-derived from the current `.md` files and the agent
   is resumed under the new profile; stopped agents pick it up on their next
   resume; coordinators are reported as a skip[^refresh].
5. Watch `ib watch`: an agent that hits `EPERM` shows it in its pane.

### 3.5 What breaks, stated plainly

- **(a) `bunx tsc` on an uninstalled worktree.** The floor dropped `~`, so a
  worktree without `node_modules` that scans several home locations gets
  `EPERM`. Fix: `bun install` in the worktree, or add `~` to that type's
  `allowRead`[^a3][^allmd].
- **(b) Any path outside the worktree + the floor.** A sandboxed agent that
  reads or writes anywhere the merged `paths` table does not allow gets `EPERM`
  until its type adds the path[^inherit]. Kernel denials do **not** reach the
  unified log[^spike]; use the hook's audit lines (Phase B) and, when they
  don't show it, bisect. Then add the path to that type's `paths.allowWrite` /
  `allowRead` and `ib sandbox refresh <id>`.
- **(c) The tmux-socket escape stays OPEN for spawner types.** A spawner keeps
  its tmux socket (it needs it for `ib new-agent`), and anything that can write
  that socket can run unsandboxed via `tmux run-shell`. This is an **accepted
  limitation** for spawning types[^tmux].
- **(d) Network-dependent tools.** Egress is forced through the per-agent proxy,
  which allows only the apex domains in `sandbox.domains`; a tool that must reach
  any other host fails closed until its domain is added to `sandbox.domains`
  (proxy apex entries are exact, so subdomains need their own entry)[^proxy].
- **(e) agy agents cannot be sandboxed yet** — no wrapper (§3.3)[^agy].

### 3.6 Recovery / rollback

1. Set `sandbox.enabled: false` in `~/.itsybitsy/agent-types/_all.md`.
2. Rebuild `ib`, copy it onto PATH, restart `ib watch`.
3. Run `ib sandbox refresh --all` per repo. A live agent keeps its **frozen
   enabled profile** until it is refreshed (§3.2) — the file alone does not
   un-sandbox a running agent[^frozen][^refresh].

---

## 4. Pilot checklist (Phase C — pending)

The gate (§3) must not fire until this pilot passes. It is **pending**: nothing
below has been run.

1. **Pick one non-spawner type** in this repo. Set `sandbox.enabled: true` on
   that type and run `ib sandbox refresh <id>` for one of its agents.
2. **Verify LIVE**, in order:
   - **It boots.** Run the opt-in boot gate[^a3]:
     ```
     IB_LIVE_BOOT=1 bun test src/sandbox.test.ts --test-name-pattern "LIVE claude boot"
     ```
     This proves the floor boots claude with no SIGABRT (claude then hangs on
     the kernel-denied network to exit 143 — the fail-closed proof).
   - **It reaches the model through the proxy.** Confirm a **real reply** from
     the running agent. This is the stronger gate the offline boot gate cannot
     give: the boot gate hangs on the denied network by design, so only a live
     reply proves the allowed domains + proxy actually carry model traffic.
   - **It runs its normal tools** without spurious `EPERM`.
   - **A hook `PreToolUse` deny still blocks under
     `--dangerously-skip-permissions`.** Confirm the flag suppresses claude's
     *own* permission gate but the itsybitsy hook still denies (a
     denied-by-hook Bash/file op is refused)[^skip].
3. **MCP under the profile.** Boot any configured MCP server for that type; it
   is a claude child, so it is sandboxed and needs its interpreter paths and its
   own domains — add anything not already in `_all.md`[^mcp].
4. **Toolchain entries.** Fold whatever the audit surfaced (C4) into the types
   that need them.
5. **Enable type by type**, re-running steps 1–3 per type.
6. **agy last**, after its own boot-floor bisection (C6)[^agy].

---

## 5. Trust-boundary note

The sealed record (A4 G3) **closes the non-spawner self-promotion path**.
Because `AGENTDIR` is a kernel write root (hooks write `meta.json` there),
`meta.canSpawnChildren` / `meta.agentType` are agent-editable, and resume /
respawn re-derive the runtime roots from `meta` — so without a countermeasure a
sandboxed non-spawner could edit its own meta and respawn into a spawner
profile. A4 G3 records the profile inputs (plus a sha256) in a per-agent seal
written by an **unsandboxed** lifecycle op, under `~/.itsybitsy/sealed`, a
directory the `_all.md` `deny` carves out of **every** sandboxed agent's reach;
resume, respawn, and refresh **fail hard** on any mismatch between `meta` and
the seal[^seal].

**Residual (accepted).** A **spawner** can still reach the seal dir the same way
it reaches everything else off-limits — through its **tmux socket**, the
accepted spawner escape. So the seal hardens the **non-spawner** boundary, not
the spawner one; closing the spawner path means closing the tmux escape itself,
which is out of scope[^tmux][^residual].

---

[^seed]: [SANDBOX-ROLLOUT.md draft seed](https://claude.ai/code) — branch `agent/path-isolation`, commit `8725b37`, read with `git show agent/path-isolation:docs/SANDBOX-ROLLOUT.md`.
[^a0]: [SPEC-SANDBOX.md §5.1 (profile generator), §5.2 (per-agent proxy + lifecycle), §4B (codex `danger-full-access`), §5.5 (fail-hard preconditions)](../SPEC-SANDBOX.md) — foundation commit `e38ae42` on `agent/sandbox-safety`.
[^a1]: [SPEC-SANDBOX.md §4A.7 guarantees (frozen `meta.paths`, enabled-without-paths refused) and §7 "Top-level `paths:` split" / "Write implies read"](../SPEC-SANDBOX.md) — A1 tip `3503607`.
[^a2]: [SPEC-SANDBOX.md §4A.8 "Most specific entry wins" (shared total sort, `resolvePathAccess`, SBPL oracle, live macOS probe, resolver boundary)](../SPEC-SANDBOX.md) — A2 tip `8918447`; resolver in [src/sandbox.ts#resolvePathAccess](../src/sandbox.ts).
[^a3]: [SPEC-SANDBOX.md §4A.7 "A3 floor tightening", §4C.3 (tmux socket file + network-outbound deny), §7 "A3 floor tightening + spawn-keyed roots"](../SPEC-SANDBOX.md) and the shipped floor [docs/agent-types/_all.md](agent-types/_all.md) — A3 tip `bd0a2c4`.
[^a4]: [SPEC-SANDBOX.md §4B.1 (claude `--dangerously-skip-permissions` under the kernel), §5.6 (`ib sandbox refresh`), §4C.3 (sealed record)](../SPEC-SANDBOX.md) — A4 tip `c7ed698`; seal helpers in [src/agent-seal.ts](../src/agent-seal.ts).
[^b]: [SPEC-PATH-ALLOWLIST.md §8 "Build order" (Phase B / Phase C)](https://claude.ai/code) — branch `agent/path-isolation`, read with `git show agent/path-isolation:SPEC-PATH-ALLOWLIST.md`.
[^disabled]: [docs/agent-types/_all.md](agent-types/_all.md) — `sandbox.enabled: false` ships in the baseline; nothing runs sandboxed until a type sets it `true`.
[^frozen]: [SPEC-SANDBOX.md §4A.7 guarantee 1 and §5.4 ("profile is fixed at exec")](../SPEC-SANDBOX.md) — spawn resolves and freezes `meta.sandbox`/`meta.paths`; resume replays from meta and does not re-read the `.md` files; editing `_all.md` affects new spawns only.
[^refresh]: [SPEC-SANDBOX.md §5.6 (`ib sandbox refresh <id> | --all`: re-derives from the current `.md` files, resumes; `--all` covers the current repo only; coordinators skipped)](../SPEC-SANDBOX.md).
[^ormerge]: [SPEC-SANDBOX.md §7 "Inheritance → union" — "The scalar `sandbox.enabled` uses OR-merge (any layer `true` wins)"](../SPEC-SANDBOX.md); merge in [src/ib-commands.ts#mergeSandboxLayerConfigs](../src/ib-commands.ts).
[^open]: [SPEC-SANDBOX.md §7 "Enforcement model → Model B" / §4A.0 — "Fully-open is explicit-only (`allowRead: ["/"]`)"](../SPEC-SANDBOX.md).
[^inherit]: [SPEC-SANDBOX.md §4C — a Seatbelt profile is inherited by every descendant (hooks, `ib`, MCP, Bash children); under `(deny default)` an unlisted path is `EPERM`](../SPEC-SANDBOX.md).
[^spike]: [docs/SANDBOX-SPIKE-FINDINGS.md — the unified-log harvest does not surface `sandbox-exec` denials; use bisection](SANDBOX-SPIKE-FINDINGS.md).
[^tmux]: [SPEC-SANDBOX.md §4C.3 "tmux socket = sandbox escape (accepted shipped limitation)" — denied for non-spawners, kept for spawners](../SPEC-SANDBOX.md).
[^proxy]: [SPEC-SANDBOX.md §5.2 (per-agent Bun proxy), §4C.4 (MCP egress under the same allowlist), §4B (apex entries are exact)](../SPEC-SANDBOX.md) and the shipped `sandbox.domains` in [docs/agent-types/_all.md](agent-types/_all.md).
[^agy]: [SPEC-SANDBOX.md §4B.1 — "agy has no wrapper yet and is out of scope"](../SPEC-SANDBOX.md); [SPEC-PATH-ALLOWLIST.md §8 "Phase C" — agy gets its wrapper after its own boot-floor bisection](https://claude.ai/code) (branch `agent/path-isolation`).
[^allmd]: [docs/agent-types/_all.md](agent-types/_all.md) — the `allowRead` comment documents the `bunx tsc` cost of dropping `~`.
[^skip]: [SPEC-SANDBOX.md §4B.1 — `--dangerously-skip-permissions` is emitted only inside the `sandbox-exec` wrapper when the sandbox is enabled; it suppresses claude's own prompts, not the itsybitsy hook denies](../SPEC-SANDBOX.md).
[^mcp]: [SPEC-SANDBOX.md §4C.4 "MCP servers" — stdio MCP servers are claude children, so they are sandboxed and need their interpreter paths + their own domains](../SPEC-SANDBOX.md).
[^seal]: [SPEC-SANDBOX.md §4C.3 "Trust boundary CLOSED for non-spawners by the SEALED RECORD (A4 G3)" and §4C.5](../SPEC-SANDBOX.md); [src/agent-seal.ts](../src/agent-seal.ts) and the `~/.itsybitsy/sealed` deny in [docs/agent-types/_all.md](agent-types/_all.md).
[^residual]: [SPEC-SANDBOX.md §4C.3 "Residual (accepted)" / §4C.5 — a spawner still reaches the seal dir via its tmux socket](../SPEC-SANDBOX.md).

# Sandbox rollout: shipping ledger and the enable-all gate

**Audience:** the operator (Adam). This is the single rollout document. It began
as the `path-isolation` seed[^seed], was filled with the Phase A implementation
from `sandbox-safety`, and now records the integrated Phase B branch. Design
lives in `SPEC-SANDBOX.md` and, for Phase B/C, in `SPEC-PATH-ALLOWLIST.md`.

**The word "shipped" means INSTALLED.** An item is shipped only when it is on
`main`, the `ib` binary rebuilt (`bun run build`) and copied onto PATH
(`/usr/local/bin/ib`), and `ib watch` restarted. Hooks and spawns call the
installed binary, so a merge to `main` alone changes nothing at runtime. The
ledger records repository state; it does not claim an operator installation
unless a row explicitly says `INSTALLED`.

---

## 1. Shipping ledger

Status vocabulary, in order of progress:

`NOT STARTED` → `IN PROGRESS` → `ON BRANCH <branch>` → `ON MAIN` →
`INSTALLED <date>`. The adjacent **Tip sha** column pins the code revision.

`ON BRANCH` means merged onto its working branch and green there; `ON MAIN`
means merged to `main` but not yet rebuilt/restarted; `INSTALLED` is the only
state that means "shipped" (see the rule above).

### Phase A — `sandbox-safety`, branch `agent/sandbox-safety`

Every Phase A row below is reachable from `main`. The tip shas are the rebased
commits that landed there; none of the rows claims the separate runtime
`INSTALLED` state.

| # | Item | Status | Tip sha |
|---|---|---|---|
| A0 | Foundation: Seatbelt profile generator, per-agent Bun proxy + lifecycle, codex `danger-full-access` parity, fail-hard preconditions; rebased onto `main`[^a0] | ON MAIN | `e3ddbe8` |
| A1 | `paths:` block split out of `sandbox:` (`sandbox:` keeps `enabled`/`rawAllow`/`domains`); `allowWrite` emits read+write; exact cross-list ties collapse to `allowWrite`; `meta.paths` frozen at spawn even when disabled; an enabled meta with no `paths` block is refused on resume[^a1] | ON MAIN | `b571f6c` |
| A2 | Most-specific-wins access table: one shared total sort, `resolvePathAccess()`, the SBPL last-match oracle, seeded order permutations, and the LIVE `sandbox-exec` probe on macOS; runtime roots sit in the table; the resolver models the `paths` table only, not `rawAllow`[^a2] | ON MAIN | `4df425b` |
| A3 | `_all.md` floor tightened to the verified minimum (`allowRead` drops `/` and `~`; the root listing moves to the `rawAllow` line `(allow file-read-data (literal "/"))`; the `~/.itsybitsy` write floor; `~/Library/Keychains` only); runtime roots keyed on resolved `canSpawnChildren` (REPOAGENTS write for a spawner / read otherwise; PARENTCLAUDE write for a spawner); the tmux socket denied for non-spawners with both a file deny and a network-outbound deny; the LIVE claude boot gate made opt-in (`IB_LIVE_BOOT=1`)[^a3] | ON MAIN | `9703ba1` |
| A4 | claude `--dangerously-skip-permissions` emitted only inside the `sandbox-exec` wrapper when enabled (G1); `ib sandbox refresh <id> \| --all` re-derives an existing agent's frozen sandbox from the current `.md` files (G2); the sealed record closes the agent-editable-meta boundary for non-spawners, re-sealed on the dashboard `b` spawn toggle (G3)[^a4] | ON MAIN | `34a74c5` |
| A5 | This rollout document (`docs/SANDBOX-ROLLOUT.md`): the single shipping ledger + enable-all gate + pilot + rollback | ON MAIN | `5d7e0ad` |

**A→sub-phase mapping.** After rebase and merge, the main-reachable phase tips
are: A0 `e3ddbe8`; A1 `b571f6c`; A2 `4df425b`; A3 `9703ba1`; A4
`34a74c5`; A5 `5d7e0ad`. The original pre-rebase shas remain in the linked
design history, while this ledger names the commits present in the current
history.

### Phase B — `path-isolation`, continued on `agent/codex-path-isolation`

The original `agent/path-isolation` work and both Sol continuation branches are
merged on `agent/codex-path-isolation`: surface/documentation first, then the
advisory scanner, kernel `PROJECTDIR`/`SCRATCHPAD` wiring, and Codex/agy lifecycle
propagation. The rows below identify the integrated implementation commits.
Installation and the Phase C pilot remain separate steps.[^b]

| # | Item | Status | Tip sha |
| --- | ---- | ------ | ------- |
| B1 | Relative-to-repo-root grammar resolved once in `newAgent`; authored-resolved lists stored in `meta.json`; spawn and refresh reject escapes to `/` or the home root | ON BRANCH `agent/codex-path-isolation` | `51228df` |
| B2 | `allowedPaths` retired everywhere (parse, validate, `newAgent`, hook steps, session-start text, SPEC); a type that declares it is a validation error | ON BRANCH `agent/codex-path-isolation` | `2877028` |
| B3 | Hook calls `resolvePreparedAccess` after the structural steps, runtime roots folded in, strict by default; Claude, codex, and agy handlers pass the lists; codex `--add-dir` parity for the non-sandboxed path; `<agentDir>/meta.json` and the system coordinator's configuration are protected from writes | ON BRANCH `agent/codex-path-isolation` | `854f0e1` |
| B4 | CLI-appropriate runtime roots at hook and kernel layers; advisory Bash scanner against the shared resolver. Claude project/scratchpad roots are Claude-only. Audit mode was deliberately dropped before Phase B began.[^b] | ON BRANCH `agent/codex-path-isolation` | Hook table `bb258d0`; inherited scanner `a239357`; scanner tests `165475d`; redirect/destination hardening `1ec1529`; kernel roots `0480d68`; CLI root alignment `7cc63fa`; legacy-Claude roots `d9a96cb`; final scanner/schema hardening `e9fc804` |
| B5 | Session-start strict/kernel wording; `ib info` and dashboard show normalized resolved lists and CLI-specific sandbox availability; SPEC + implementation notes and this ledger updated. Codex resume/refresh regenerates `AGENTS.md` from current frozen metadata. | ON BRANCH `agent/codex-path-isolation` | Surface `7472325` + `1d57313`; rollout `e9697f3`; instruction/lifecycle wiring `81d018d`; lifecycle hardening `11f0ebc` |
| B6 | `ib init-types --check` compares the live layer `paths:` and `sandbox:` blocks with the embedded floor and returns a nonzero exit when they drift | ON BRANCH `agent/codex-path-isolation` | `8fa6b52` |

### Phase C — pilot and rollout

| # | Item | Status |
|---|---|---|
| C1 | Pilot: one claude non-spawner type in this repo with `sandbox.enabled: true` | NOT STARTED |
| C2 | Pilot check: the agent boots, reaches the model through the proxy, runs its normal tools, and a hook `PreToolUse` deny still blocks under `--dangerously-skip-permissions` | NOT STARTED |
| C3 | Pilot check: configured MCP servers work under the profile | NOT STARTED |
| C4 | Toolchain entries collected (from hook denial logs / kernel bisection) and added to the types that need them | NOT STARTED |
| C5 | Enable-all gate passed (§3) | NOT STARTED |
| C6 | Agy sandbox support designed and built after its own boot-floor bisection; until then an enabled agy policy fails closed as unsupported | NOT STARTED |

---

## 2. What runs where, at each point in time

| Point in time | Live agents | New spawns |
|---|---|---|
| **Before Phase A is installed** | No itsybitsy kernel sandbox exists. | Same. |
| **After Phase A is installed** | Every embedded layer ships `enabled: false`[^disabled], so there is still **no behavior change** for a live agent. | Unchanged, until a type opts in. |
| **After Phase B is installed, before refresh** | The **hook changes immediately** because it reads `meta.paths` on every call. A legacy live agent with no `paths` key becomes strict at the hook: worktree + runtime roots only. Its **kernel profile stays frozen** until refresh. This is why the three-step Phase B install below must be performed as one operation. | New agents receive the resolved live type floor in `meta.paths`; the hook is strict immediately. The kernel remains off unless their resolved `sandbox.enabled` is true. |
| **After a supported type opts in** — one claude/codex/fugu type sets `sandbox.enabled: true` | Unchanged until refreshed (§3.2): a live agent replays its frozen profile[^frozen]. | New claude/codex/fugu agents **of that type** get the kernel Seatbelt profile + per-agent proxy. Agy fails closed as unsupported. |
| **After the enable-all gate** (§3) | Supported agents are sandboxed once `ib sandbox refresh --all` re-derives them, per repo; agy refresh is reported unsupported. | New claude/codex/fugu agents are sandboxed; agy cannot launch while the inherited policy is enabled. |

### 2.1 Installing Phase B without stranding live agents

Perform these **three steps in order, as one operation**:

1. Add the embedded `paths:` floor to the live
   `~/.itsybitsy/agent-types/_all.md`. From the Phase B checkout, run
   `bun index.ts init-types --check` (the candidate `ib init-types --check`)
   and resolve every reported `paths:` / `sandbox:` difference; **exit 0 is a
   precondition for step 2**. `ib init-types` does not overwrite an existing
   customized file.
2. Install Phase B: merge it, rebuild and copy `ib` onto PATH, and restart
   `ib watch`.
3. Run `ib sandbox refresh --all` in **each registered repo**. This writes the
   resolved floor into every live agent's `meta.paths`; it refreshes the frozen
   kernel policy for supported agents whose sandbox is enabled and reports agy
   as unsupported rather than launching it unwrapped.

Do not install step 2 against a live `_all.md` that still lacks the floor. In
that window the hook immediately interprets a missing `meta.paths` as empty and
allows only the worktree plus runtime roots.

---

## 3. The gate: enable the sandbox for ALL agents

This is the procedure Adam asked for: turn the kernel sandbox on for **every**
agent, accepting that existing agents may break.

### 3.1 One switch is enough, and a leaf cannot switch it back off

`sandbox.enabled` is **OR-merged** across the type layers — any layer that sets
it `true` wins, and no descendant layer can set it back to `false`[^ormerge].
Setting it `true` in `~/.itsybitsy/agent-types/_all.md` therefore resolves true
for every type. A supported claude/codex/fugu type that cannot yet be narrowly fenced
does **not** disable the sandbox (it can't); instead it writes **explicit wide
allows** — `allowRead: ["/"]` plus the write roots it needs — which keeps the
network proxy in place and matches the "fully-open is explicit-only" rule[^open].
This widening cannot create an agy kernel wrapper: agy fails closed while the
inherited setting is true. The supported end state is `_all.md` `enabled: true`
plus explicit wide `paths` only where necessary — never `enabled: false` on a
leaf.

### 3.2 Why flipping `_all.md` alone changes no live kernel profile

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

This frozen-profile rule is about the **kernel**. Once Phase B is installed,
the path hook itself runs the new deny-by-default code immediately and reads
each call's current `meta.paths`; a missing key is empty, never permissive.
Follow the Phase B three-step install in §2.1 so live agents receive the floor
without a strict-but-floorless interval.

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
- [ ] `ib init-types --check` exits 0: every live layer's `paths:` and
      `sandbox:` blocks match the embedded floor. This is required before the
      Phase B install sequence in §2.1 and again before enable-all.
- [ ] The advisory hook denials and kernel bisection identified the toolchain
      entries each type needs, and those entries were added (Phase C, C4 —
      pending). Phase B deliberately ships no audit mode.
- [ ] **agy is handled.** agy has **no sandbox wrapper today**[^agy]. An agy
      spawn/resume whose resolved `sandbox.enabled` is `true` fails closed as
      unsupported before any unwrapped process launches, and the instructions,
      `ib info`, and dashboard say the sandbox is unavailable. Because a leaf
      cannot switch `enabled` off (§3.1), a global `_all.md` enable means agy
      cannot launch; complete C6 or accept that operational exclusion before
      the enable-all switch.
- [ ] `ib list-types` validates cleanly (a bad `paths:` block fails validation).

### 3.4 The switch

1. In `~/.itsybitsy/agent-types/_all.md`, set `sandbox.enabled: true`.
2. For any supported claude/codex/fugu type that cannot yet be fenced, give it the explicit wide `paths`
   block of §3.1 (`allowRead: ["/"]` + its write roots) rather than trying to
   disable it.
3. **Rebuild `ib`** (`bun run build`), copy it onto PATH, and **restart
   `ib watch`**.
4. Run **`ib sandbox refresh --all` in each registered repo** — it refreshes
   only the current repo's agents[^refresh], so run it per repo. Every active
   agent's `meta.json` is re-derived from the current `.md` files and the agent
   is resumed under the new profile where supported; stopped agents pick it up
   on their next resume; agy failures and coordinator skips are reported.[^refresh]
5. Watch the Denials tab in `ib watch`: the hook explains honest denied path
   attempts before the kernel returns `EPERM`. A kernel-only denial is not
   harvested into the log and still requires bisection.[^spike]

### 3.5 What breaks, stated plainly

- **(a) `bunx tsc` on an uninstalled worktree.** The floor dropped `~`, so a
  worktree without `node_modules` that scans several home locations gets
  `EPERM`. Fix: `bun install` in the worktree, or add `~` to that type's
  `allowRead`[^a3][^allmd].
- **(b) Any path outside the worktree + the floor.** A sandboxed agent that
  reads or writes anywhere the merged `paths` table does not allow gets `EPERM`
  until its type adds the path[^inherit]. Kernel denials do **not** reach the
  unified log[^spike]; use Phase B's hook denial lines (including the advisory
  Bash scanner for honest command-line paths) and, when they do not show it,
  bisect. Then add the path to that type's `paths.allowWrite` /
  `allowRead` and `ib sandbox refresh <id>`.
- **(c) The tmux-socket escape stays OPEN for spawner types.** A spawner keeps
  its tmux socket (it needs it for `ib new-agent`), and anything that can write
  that socket can run unsandboxed via `tmux run-shell`. This is an **accepted
  limitation** for spawning types[^tmux].
- **(d) Network-dependent tools.** Egress is forced through the per-agent proxy,
  which allows only the apex domains in `sandbox.domains`; a tool that must reach
  any other host fails closed until its domain is added to `sandbox.domains`
  (proxy apex entries are exact, so subdomains need their own entry)[^proxy].
- **(e) agy agents cannot be sandboxed yet** — no wrapper (§3.3). They fail
  closed rather than launching unwrapped when their resolved policy is enabled.[^agy]
- **(f) The system coordinator is advisory in hook-only mode.** Its worktree
  root is all of `~/.itsybitsy`, so the hook structurally blocks writes to
  `agent-types/`, `config.json`, `repos.json`, `layout.json`, and `sealed/` for
  file tools plus recognized Bash paths and write destinations. The scanner
  covers redirects, `sed -i`, `tee`, `cp`/`mv`, and common write verbs, but it
  is not a shell parser: dynamic expansion, subprocesses, alternate command
  shapes, and symlink races can evade it while the kernel is off. This is an
  accepted residual; the kernel closes it when the system coordinator is
  sandboxed (SPEC-PATH-ALLOWLIST.md §6.12).

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

1. **Pick one claude non-spawner type** in this repo. Set
   `sandbox.enabled: true` on that type and run `ib sandbox refresh <id>` for
   one of its agents. After this Claude-specific boot gate, repeat the live
   policy/MCP checks for codex/fugu types before enabling them broadly.
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
4. **Toolchain entries.** Fold what the hook denial logs and kernel bisection
   surfaced (C4) into the types that need them.
5. **Enable type by type**, re-running steps 1–3 per type.
6. **agy remains excluded from kernel rollout** until its own supported wrapper
   and boot-floor bisection exist (C6). Its enabled-policy failure is the
   fail-closed guard, not a sandbox implementation.[^agy]

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

[^seed]: [Path-isolation implementation history](../SPEC-PATH-ALLOWLIST.md) — the rollout seed was commit `8725b37` on the historical `agent/path-isolation` branch.
[^a0]: [SPEC-SANDBOX.md §5.1 (profile generator), §5.2 (per-agent proxy + lifecycle), §4B (codex `danger-full-access`), §5.5 (fail-hard preconditions)](../SPEC-SANDBOX.md) — main-reachable foundation tip `e3ddbe8`.
[^a1]: [SPEC-SANDBOX.md §4A.7 guarantees (frozen `meta.paths`, enabled-without-paths refused) and §7 "Top-level `paths:` split" / "Write implies read"](../SPEC-SANDBOX.md) — main-reachable A1 tip `b571f6c`.
[^a2]: [SPEC-SANDBOX.md §4A.8 "Most specific entry wins" (shared total sort, `resolvePathAccess`, SBPL oracle, live macOS probe, resolver boundary)](../SPEC-SANDBOX.md) — main-reachable A2 tip `4df425b`; resolver in [src/sandbox.ts#resolvePathAccess](../src/sandbox.ts).
[^a3]: [SPEC-SANDBOX.md §4A.7 "A3 floor tightening", §4C.3 (tmux socket file + network-outbound deny), §7 "A3 floor tightening + spawn-keyed roots"](../SPEC-SANDBOX.md) and the shipped floor [docs/agent-types/_all.md](agent-types/_all.md) — main-reachable A3 tip `9703ba1`.
[^a4]: [SPEC-SANDBOX.md §4B.1 (claude `--dangerously-skip-permissions` under the kernel), §5.6 (`ib sandbox refresh`), §4C.3 (sealed record)](../SPEC-SANDBOX.md) — main-reachable A4 tip `34a74c5`; seal helpers in [src/agent-seal.ts](../src/agent-seal.ts).
[^b]: [SPEC-PATH-ALLOWLIST.md §8, "Implementation history and build order"](../SPEC-PATH-ALLOWLIST.md).
[^disabled]: [docs/agent-types/_all.md](agent-types/_all.md) — `sandbox.enabled: false` ships in the baseline; nothing runs sandboxed until a type sets it `true`.
[^frozen]: [SPEC-SANDBOX.md §4A.7 guarantee 1 and §5.4 ("profile is fixed at exec")](../SPEC-SANDBOX.md) — spawn resolves and freezes `meta.sandbox`/`meta.paths`; resume replays from meta and does not re-read the `.md` files; editing `_all.md` affects new spawns only.
[^refresh]: [SPEC-SANDBOX.md §5.6 (`ib sandbox refresh <id> | --all`: re-derives from the current `.md` files, resumes; `--all` covers the current repo only; coordinators skipped)](../SPEC-SANDBOX.md); agy's current refresh refusal is implemented in [`refreshAgentSandbox`](../src/ib-commands.ts:refreshAgentSandbox).
[^ormerge]: [SPEC-SANDBOX.md §7 "Inheritance → union" — "The scalar `sandbox.enabled` uses OR-merge (any layer `true` wins)"](../SPEC-SANDBOX.md); merge in [src/ib-commands.ts#mergeSandboxLayerConfigs](../src/ib-commands.ts).
[^open]: [SPEC-SANDBOX.md §7 "Enforcement model → Model B" / §4A.0 — "Fully-open is explicit-only (`allowRead: ["/"]`)"](../SPEC-SANDBOX.md).
[^inherit]: [SPEC-SANDBOX.md §4C — a Seatbelt profile is inherited by every descendant (hooks, `ib`, MCP, Bash children); under `(deny default)` an unlisted path is `EPERM`](../SPEC-SANDBOX.md).
[^spike]: [docs/SANDBOX-SPIKE-FINDINGS.md — the unified-log harvest does not surface `sandbox-exec` denials; use bisection](SANDBOX-SPIKE-FINDINGS.md).
[^tmux]: [SPEC-SANDBOX.md §4C.3 "tmux socket = sandbox escape (accepted shipped limitation)" — denied for non-spawners, kept for spawners](../SPEC-SANDBOX.md).
[^proxy]: [SPEC-SANDBOX.md §5.2 (per-agent Bun proxy), §4C.4 (MCP egress under the same allowlist), §4B (apex entries are exact)](../SPEC-SANDBOX.md) and the shipped `sandbox.domains` in [docs/agent-types/_all.md](agent-types/_all.md).
[^agy]: [SPEC-SANDBOX.md §4B.1 — agy has no wrapper yet and is out of scope](../SPEC-SANDBOX.md); current fail-closed lifecycle guards are in [`newAgent`, `resumeAgent`, and `refreshAgentSandbox`](../src/ib-commands.ts:newAgent), and display wording comes from [`kernelSandboxStatus`](../src/agent-cli.ts:kernelSandboxStatus).
[^allmd]: [docs/agent-types/_all.md](agent-types/_all.md) — the `allowRead` comment documents the `bunx tsc` cost of dropping `~`.
[^skip]: [SPEC-SANDBOX.md §4B.1 — `--dangerously-skip-permissions` is emitted only inside the `sandbox-exec` wrapper when the sandbox is enabled; it suppresses claude's own prompts, not the itsybitsy hook denies](../SPEC-SANDBOX.md).
[^mcp]: [SPEC-SANDBOX.md §4C.4 "MCP servers" — stdio MCP servers are claude children, so they are sandboxed and need their interpreter paths + their own domains](../SPEC-SANDBOX.md).
[^seal]: [SPEC-SANDBOX.md §4C.3 "Trust boundary CLOSED for non-spawners by the SEALED RECORD (A4 G3)" and §4C.5](../SPEC-SANDBOX.md); [src/agent-seal.ts](../src/agent-seal.ts) and the `~/.itsybitsy/sealed` deny in [docs/agent-types/_all.md](agent-types/_all.md).
[^residual]: [SPEC-SANDBOX.md §4C.3 "Residual (accepted)" / §4C.5 — a spawner still reaches the seal dir via its tmux socket](../SPEC-SANDBOX.md).

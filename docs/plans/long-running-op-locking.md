# Plan: Concurrency guards & stuck-op detection for long-running agent operations

## Problem

`mergeCheckAgent`, `mergeAgent`, and `resumeAgent` each take seconds-to-tens-of-seconds to
run, but the system has no durable, cross-process record that one is in flight. Consequences
today:

- **No merge guard at all.** `handleMerge` (`src/tui/agent-actions.ts:498`) wraps each `m`
  press in an independent `executeAndRefresh` promise with no lock. Mashing `m` (merge-check
  alone can take ~5s) races two operations. The confirm dialog narrows the window by accident,
  not by design.
- **Resume guard is in-memory only.** `resumingAgentIds` (a `Set<string>` at
  `src/tui/agent-actions.ts:53`) blocks a double-press *within one process*. It does nothing
  for `ib merge`/`ib resume` from a shell, a second `ib watch`, or another agent. The only
  durable cross-process guard resume has is `resumeAgent`'s `tmux has-session` liveness check
  (`src/ib-commands.ts:412-423`) — and merge has no equivalent because merge does its tmux work
  *last*.
- **No stuck detection.** If a merge hangs on a git op, nothing times out, no state reflects
  it, and the watchdog has no signal. Worse: merge *kills* the agent's tmux session partway
  through (`src/ib-commands.ts:1357`), so the agent's own watchdog has usually already exited
  (`src/watchdog.ts:997-1007`) and cannot be the thing that notices.

## Goal

A **simple, durable, cross-process** marker that:
1. Refuses a conflicting long-running op while one is already in flight (covers the full
   matrix: check/merge/restart vs. each other, in any combination).
2. Reclaims automatically when the holder process has died (crash) — no manual cleanup path.
3. Surfaces a *stuck* op (alive but running past a timeout, or dead-holder) in `ib watch`.

Non-goals: no new lock-file format, no PID-bookkeeping subsystem, no per-op cron. Reuse what
exists.

## Design

### Reuse `meta.transient.json` — do NOT add a `.lock` file

`meta.transient.json` already is the codebase's single-writer, freshness-stamped,
PID-liveness-gated side-channel (`src/agents.ts:248`, comment at 239-247). The merge/resume
functions are the natural owners of their own op status. Adding a `.lock` file would mean a new
format + atomic-acquire code + cleanup path — exactly the overengineering we're avoiding. One
new optional field on the existing struct is enough.

### 1. New field on `TransientState` (`src/agents.ts`)

```ts
export type AgentOperationKind = "merge_check" | "merging" | "restarting";

export interface AgentOperation {
  kind: AgentOperationKind;
  pid: number;          // process running the op (process.pid of mergeAgent/resumeAgent caller)
  started_at_ms: number;
}

export interface TransientState {
  // ...existing fields...
  operation?: AgentOperation | null;   // present only while an op is in flight
}
```

`readAgentTransient` must tolerate the field's absence (older files) and validate its shape
when present (object with `kind` in the allowed set, numeric `pid` > 0, numeric
`started_at_ms` > 0); malformed → treat as absent, do not reject the whole transient read.

**Important interaction with the existing single-writer assumption.** Today the watchdog is
the *only* writer of `meta.transient.json` (`src/watchdog.ts:1038`), and the comment at
`agents.ts:244` leans on that ("single writer — no locks needed"). Adding merge/resume as
writers breaks that invariant: a `writeAgentTransient` from `mergeAgent` could clobber a fresh
watchdog snapshot (or vice-versa) via last-write-wins on the whole file.

**Fix (both plan reviewers agreed): route ALL transient writes through one shared
read-modify-write helper.** Do not hand-roll RMW at each call site.

```ts
// agents.ts — single RMW primitive. Reads current transient (or a zeroed default),
// applies fn, writes atomically (.tmp + rename). Best-effort try/catch, ENOENT-safe,
// mirroring writeAgentTransient/deleteAgentTransient idioms (agents.ts:296, :311).
export async function updateAgentTransient(
  agentDir: string,
  fn: (cur: TransientState) => TransientState,
): Promise<void>

// Thin wrappers over updateAgentTransient, touching ONLY operation:
export async function setAgentOperation(agentDir, op: AgentOperation): Promise<void>
export async function clearAgentOperation(agentDir): Promise<void>
```

The watchdog's snapshot write at `src/watchdog.ts:1030-1038` must also go through
`updateAgentTransient` (set its four tmux fields + `updated_at_ms`/`watchdog_pid`, **preserving
whatever `operation` is on disk**) instead of building a fresh literal that omits `operation`.
This is the one cross-cutting subtlety — get it wrong and the watchdog erases the merge marker
on its next 5s tick.

**Race surface — accepted as RMW (open question #3 resolved):** the worst case is a lost
`operation` write, which degrades to today's behavior ("guard didn't engage"), never
corruption. The holder is a hand-triggered op racing a 5s watchdog cadence — the collision
window is negligible. A stricter lock is exactly the overengineering this plan rejects. Routing
every writer through the one `updateAgentTransient` helper keeps the footgun in a single place.

### 2. The guard — at the top of each long-running op

Add a shared preflight to the very start of `mergeCheckAgent`, `mergeAgent`, and
`resumeAgent` (before any slow work):

```ts
// returns { ok: true } to proceed, or { ok:false, stderr } to refuse.
// Lives in ib-commands.ts; imports isPidAliveCtx from agents.ts for the liveness
// check (only the private _isPidAlive exists in agents.ts — use the exported
// injectable isPidAliveCtx.fn so tests can stub it).
async function acquireAgentOperation(agentDir, kind): Promise<...> {
  const t = await readAgentTransient(agentDir);
  const op = t?.operation;
  if (op && op.pid > 0 && isPidAliveCtx.fn(op.pid)) {
    return { ok:false, stderr:`Agent is currently ${humanize(op.kind)} (pid ${op.pid}) — try again when it finishes` };
  }
  // op absent, or holder dead → reclaim. Log reclaim if we overwrote a dead holder.
  await setAgentOperation(agentDir, { kind, pid: process.pid, started_at_ms: Date.now() });
  return { ok:true };
}
```

- Each op wraps its **entire body** in `try { ...work... } finally { await
  clearAgentOperation(agentDir) }`. Both `mergeCheckAgent` and `mergeAgent` have many early
  `return`s scattered through their bodies (verified) — a single try/finally wrapping everything
  after the guard is the only shape that clears on every return path. A crash mid-op leaves the
  marker behind (which is what enables dead-holder reclaim and stuck detection).
- `resumeAgent` keeps its existing `tmux has-session` liveness refusal — that is a *different*
  guard (don't clobber a genuinely-running agent) and stays. The new op-guard sits above it and
  covers the "another op is mid-flight" case the tmux check can't see (e.g. a merge that hasn't
  reached its tmux step yet).

**Clear-on-success ordering (confirmed trace — was previously hedged):** `mergeAgent` removes
the agent dir at `src/ib-commands.ts:1402` (inside the step 17-19 `archive` block;
`archiveAgent` itself copies artifacts but does NOT remove the dir — line 1402 does). The
`finally` therefore runs *after* the dir is gone on the success path, so `clearAgentOperation`
writes into a now-deleted dir and must swallow ENOENT. This is free: `clearAgentOperation` is
built on `updateAgentTransient`, which reuses the best-effort `try/catch` idiom of
`writeAgentTransient` (`agents.ts:296-305`) and `deleteAgentTransient` (`agents.ts:311-317`) —
both already no-op on a missing dir/file. Place the clear as the **first line of the
`finally`**; it is the single clear point (no double-clear on the failure path).

**Coordinator early-return (must-fix — plan was previously silent):** `resumeAgent`
early-returns into `resetCoordinator(agent)` for coordinators at `src/ib-commands.ts:399-401`,
*before* the existing tmux-liveness guard. The op-guard must be placed at the **very top of
`resumeAgent`, above the coordinator branch (above line 399)**, so coordinator resets are also
guarded against double-`R`. Use op kind `restarting` for both paths. Note: the coordinator row
renders via the separate `CoordinatorState` union (`src/coordinator.ts:575`), which has no
`restarting`/`op_stuck` member — surfacing the in-flight/stuck state in the coordinator row is
**explicitly out of scope** for this change (the guard still *prevents* the double-op; it just
won't paint a special color on the coordinator row). Call this out so it's a conscious cut, not
an oversight.

**retire/nuke bypass the guard (must-state):** `retireAgent`/`nukeAgent` are the recovery path for
a wedged op — they must NOT acquire or be blocked by the op-guard. A stuck merge is exactly when
the user needs to retire. They already remove the agent dir, which clears any marker for free.
`pauseAgent` and `reassignAgent` stay unguarded too (out of scope — pause already kills the
process; reassign only touches the meta.json manager field and doesn't race the slow git ops).
Do not expand the guarded set beyond merge-check / merge / restart.

**This replaces `resumingAgentIds` as the source of truth — delete the in-memory set entirely
(open question #4 resolved).** Keep the UI's immediate `setNotice("Merging…/Resuming…")`
feedback, but one durable guard is the whole point; two guards means two things to reason about
and a redundant test surface. The dashboard `m`/`R` handlers (`handleMerge`, `handleResume`)
surface the refusal `stderr` verbatim, so a mashed key shows "Agent is currently merging…"
instead of racing.

### 3. Render states + stuck detection in `detectAgentStates` (NOT the per-agent watchdog)

The agent's own watchdog exits ~10s after its tmux session dies, and merge kills that session
mid-op — so the per-agent watchdog is the *wrong* place to catch a stuck merge. The right place
is `detectAgentStates()` (`src/agents.ts:1066`): it runs every ~2s in the always-on `ib watch`
loop, already iterates every agent, and already does PID-liveness checks.

Add to the `AgentState` union (`src/parse-state.ts:9`) three render-only states (open
question #1 resolved: **one** `op_stuck`, not `merge_stuck`/`restart_stuck` — `operation.kind`
is still on disk for detail, and one stuck state means one fewer color + render-site to touch;
open question #2 resolved: merge-check and merge **collapse to a single `merging` render
label** — the distinct *guard* kinds `merge_check`/`merging` stay on disk so the refusal message
can still say "merge-checking" vs "merging", only the painted state collapses):

```ts
| "merging"        // render label for both merge_check and merging op kinds
| "restarting"     // resume / coordinator-reset in flight
| "op_stuck"       // op present, holder dead OR started_at older than 300s
```

**CRITICAL ordering fix (the showstopper Reviewer B caught).** The naïve placement "before the
compacting/rate-limited overrides" (~`agents.ts:1172`) is WRONG. The `claude_pid` liveness gate
at `src/agents.ts:1122-1131` returns `stopped` *before* the transient is ever read at line 1171
— and a wedged merge is precisely the case where `claude_pid` has already been killed
(`mergeAgent` kills Claude at `ib-commands.ts:1357`, well before the dir is removed). So an
op-check placed below line 1122 would render `stopped` and never fire for the common stuck-merge
case, defeating the entire feature.

**Fix:** hoist the single `readAgentTransient` read up to *before* the `claude_pid` gate
(line 1122), and put the op-branch immediately after that read. The existing fast-path block at
1172 then reuses the same `transient` variable (no second disk read on the hot path). Concretely:

```ts
// MOVE this read up to just below the `if (!tmuxSession) { ... }` block (~line 1112),
// ABOVE the claude_pid gate at line 1122:
const transient = await readAgentTransient(agentDir);

// NEW op-branch — runs before the claude_pid gate so a killed-Claude mid-merge
// still resolves to merging/op_stuck instead of stopped:
const op = transient?.operation;
if (op) {
  const holderDead = op.pid > 0 && !isPidAliveCtx.fn(op.pid);
  const tooOld = nowMsCtx.fn() - op.started_at_ms > OP_STUCK_TIMEOUT_MS; // 300_000
  if (holderDead || tooOld) { agent.state = "op_stuck"; return; }
  agent.state = op.kind === "restarting" ? "restarting" : "merging";
  return;
}
// ...then the existing claude_pid gate (1122), complete fast-path (1145),
// and the freshness-gated compacting/rate-limited fast-path (1172, now reusing
// the hoisted `transient`) follow unchanged.
```

Why the op-branch must NOT be gated behind the watchdog-freshness check: the
`updated_at_ms`-fresh + watchdog-alive gate at line 1172 exists to decide whether to trust the
*watchdog's* tmux classification. The `operation` field is written by merge/resume, not the
watchdog, and during a merge the watchdog has often already exited — so gating the op-check
behind watchdog liveness would hide exactly the stuck merges we care about. Read `operation`
straight from disk, unconditionally, and keep the compacting/rate-limited fast-path's existing
freshness+watchdog-alive gate intact.

`OP_STUCK_TIMEOUT_MS = 300_000` (5 minutes) — per user. Long enough that a big rebase never
false-positives; merge already logs per-step `timed()` durations to `watch.log`, so we can tune
from real data later if needed.

### 4. Styling + every render site (`src/tui/color-scheme.ts` and beyond)

**CRITICAL CORRECTION (Reviewer B): there is NO compiler safety net.** `getStateColors()`
returns a loose `Record<string, string>` and every consumer looks up `colors[state] ?? FALLBACK`
— there is no `Record<AgentState, …>`, no exhaustive `switch`, and no `never`-exhaustiveness
check anywhere in `src/`. Adding union members compiles clean; missing render sites **silently**
fall back to a default color or get dropped from summaries. The implementer MUST update each
site below by hand — `tsc` will NOT flag a miss.

Add to **both** the light and dark maps in `getStateColors()` (`src/tui/color-scheme.ts:26-37`):

```
merging: YELLOW, restarting: YELLOW, op_stuck: RED,
```

YELLOW = in-progress/benign (working), RED = needs attention (wedged), reading clearly against
`running`=GREEN and `rate_limited`=RED. (Open question color choice resolved: YELLOW/RED, not
CYAN — CYAN risks confusion with other informational states.)

**Manual render-site checklist — update every one (none caught by tsc):**

- `src/tui/color-scheme.ts:29` and `:34` — the two `getStateColors()` maps (above).
- `src/index.ts:508`, `:656`, `:865` — `stateColors[state] ?? DIM` lookups (three list/table
  renderers). New states without a color entry render `DIM`; the color entries above fix all
  three at once, but confirm each `displayState()` passes the new literals through unchanged.
- `src/hooks/inject-status.ts:108` — the `briefSummary` **order array** (`["running","waiting",
  …]`). New states are silently DROPPED from the injected status summary unless added here.
  Decide intentionally whether `merging`/`restarting`/`op_stuck` should appear in the primary
  Claude's status summary (recommended: yes for `op_stuck` at least, since it's actionable).
- `src/hooks/inject-status.ts:77`, `:103` — `formatAgentStatus`/`briefSummary` string
  passthrough; new states render as raw `[merging]` — functionally fine, no change required, but
  verify.
- `displayState()` / `formatAgentStatus()` (agent-tree + dashboard compact format) — pass the
  state through as a raw label, so `merging`/`op_stuck` display as text. Fine; no change needed,
  but listed so the implementer confirms rather than assumes.
- `src/coordinator.ts:575` `CoordinatorState` — a **separate** union (`"stopped" | "compacting"
  | "rate_limited" | "running"`), NOT `AgentState`. Per the coordinator out-of-scope decision in
  §2, do **not** add the new states here; the coordinator row won't paint merging/op_stuck. Left
  explicitly untouched.

The implementer should still re-grep for `"compacting"` / `"rate_limited"` as anchors before
finishing, in case a new render site has been added since this plan was written.

## Scope of edits (files)

- `src/agents.ts` — `AgentOperation` type + `AgentOperationKind` (`"merge_check" | "merging" |
  "restarting"`); `operation` field on `TransientState`; validation in `readAgentTransient`;
  `updateAgentTransient` RMW primitive + `setAgentOperation`/`clearAgentOperation` wrappers;
  **hoisted transient read + op-branch** in `detectAgentStates` (above the `claude_pid` gate at
  line 1122); `OP_STUCK_TIMEOUT_MS` const.
- `src/ib-commands.ts` — `acquireAgentOperation` shared preflight (imports `isPidAliveCtx` from
  agents.ts); wire into `mergeCheckAgent`, `mergeAgent`, and **the very top of `resumeAgent`
  above the coordinator early-return at line 399**, each with one try/finally wrapping the whole
  body. Do NOT touch `retireAgent`/`nukeAgent`/`pauseAgent`/`reassignAgent` (unguarded by design).
- `src/parse-state.ts` — extend `AgentState` union (`merging`, `restarting`, `op_stuck`).
- `src/watchdog.ts` — route the transient write at line 1030-1038 through `updateAgentTransient`
  so it preserves an existing `operation` field (read-merge, not fresh-literal-omit).
- `src/tui/color-scheme.ts` — `merging`/`restarting`=YELLOW, `op_stuck`=RED in both maps.
- `src/index.ts` — verify the three `stateColors[...] ?? DIM` sites (508, 656, 865) render the
  new states (covered by the color-map entries; confirm `displayState` passthrough).
- `src/hooks/inject-status.ts` — add new states to the `briefSummary` order array (line 108) as
  decided (at least `op_stuck`).
- `src/tui/agent-actions.ts` — **delete** `resumingAgentIds` and its test helpers; surface guard
  refusal `stderr` in `handleMerge`/`handleResume`; keep `setNotice` immediate feedback.
- Re-grep `"compacting"`/`"rate_limited"` to catch any render site added since this plan.

## Cross-cutting review checklist (per CLAUDE.md)

1. **General agent functionality** — adds a transient op marker to the lifecycle; no change to
   spawn or meta.json *durable* shape (field lives in `meta.transient.json`). meta.json
   untouched on purpose: ops are ephemeral, transient is the right home.
2. **Hooks** — not affected. Hooks don't read/write `operation`.
3. **Watchdog** — affected: must preserve `operation` on its transient writes (the one subtle
   bit). Stuck *detection* lives in `detectAgentStates`, not the per-agent watchdog, precisely
   because merge kills the session the watchdog depends on.
4. **`ib watch` / dashboard** — affected: 3 new render states need colors + manual updates at
   every render site (no tsc safety net); `m`/`R` handlers surface durable-guard refusals.

**`ib state` / `ib state --cleanup` interaction (Reviewer A):** `ib state` already reads
`readAgentTransient` (`src/state-command.ts:116`, `:392`). Two notes for the implementer, so a
future maintainer doesn't wire this wrong: (a) the `operation.pid` is the *holder* of the op —
possibly a legitimate `ib watch` or shell `ib merge` — and must **never** be added to
`ib state --cleanup`'s kill set; it is not an orphan to reap. (b) No new cleanup machinery is
needed: a stuck marker self-heals on the next `acquireAgentOperation` (dead-holder reclaim) and
is removed outright when the agent dir is killed/nuked. Optionally `ib state` could *display* a
stuck op for visibility, but that is a nice-to-have, not required for this change.

**Recovery from a stuck op (Reviewer A):** the user-visible answer to "what do I DO about an
`op_stuck` agent" is **retire or nuke it** — those bypass the guard (§2) and remove the dir, which
clears the marker. A dedicated "force-clear op" keybind is gold-plating and out of scope; the
retire/nuke escape hatch is sufficient and mostly already works. The plan must verify retire/nuke
are not themselves blocked by the guard.

## Testing

- **Guard:** with `operation` set + live pid → second `mergeCheckAgent`/`mergeAgent`/
  `resumeAgent` returns `ok:false` with the "currently …" message. With dead pid → reclaims and
  proceeds. (Use the existing `mergeSpawnCtx`/`nukeResumeSpawnCtx` fake-runner injection and the
  `isPidAliveCtx` injection.)
- **Coordinator guard:** mashing resume on a coordinator does not run two `resetCoordinator`
  calls — the guard at the top of `resumeAgent` (above line 399) refuses the second.
- **Clear on success & failure:** op marker is gone after a successful merge (dir removed) and
  after a *failed* merge (op cleared via `finally`, agent still present). `clearAgentOperation`
  on a removed dir does not throw (ENOENT swallowed).
- **retire/nuke bypass:** `retireAgent`/`nukeAgent` succeed on an agent with an `operation` marker
  set (live or dead holder) — they are not refused by the guard.
- **Stuck detection — ordering regression guard (the showstopper):** `detectAgentStates`
  returns `op_stuck` (not `stopped`) when `operation` is set with a **dead `claude_pid`** — this
  is the explicit test that the op-branch runs ABOVE the `claude_pid` liveness gate. Also returns
  `op_stuck` when `started_at_ms` older than 300s (inject `nowMsCtx`), and `merging`/`restarting`
  for a fresh, live op.
- **Watchdog preserves operation:** a watchdog transient write (via `updateAgentTransient`) does
  not erase an existing `operation` field.
- **Transient back-compat:** an old transient file with no `operation` reads fine; a malformed
  `operation` is ignored without failing the whole read.
- **Render passthrough:** new states resolve to YELLOW/RED via `getStateColors()` and appear in
  the inject-status summary where added.
- `bun test` green; `bunx tsc --noEmit` zero errors. **Note: tsc does NOT enforce render-site
  coverage** (loose `Record<string,string>` everywhere) — coverage is enforced by the manual
  checklist in §4 and the render-passthrough test above, not the compiler.

## Open questions — RESOLVED (round 1 review)

1. One `op_stuck` vs. `merge_stuck`/`restart_stuck`? → **One `op_stuck`.** `operation.kind` is on
   disk for detail; one fewer state member / color / render site.
2. Collapse `merge_check` + `merging` render label? → **Yes.** Distinct guard *kinds*
   (`merge_check`/`merging`) stay on disk for the refusal message; only the painted state
   collapses to `merging`.
3. RMW on the shared transient vs. stricter? → **RMW**, routed through one `updateAgentTransient`
   helper. Worst case is a missed guard (= today's behavior), never corruption.
4. Keep `resumingAgentIds` or delete? → **Delete.** One durable source of truth; removes a
   redundant guard + its test surface.

## Changes applied after round 1 review (provenance)

- **Showstopper (Reviewer B):** op-branch in `detectAgentStates` must be hoisted above the
  `claude_pid` gate (line 1122), else a wedged merge resolves `stopped` and stuck-detection never
  fires. — §3, rewritten with the corrected placement + a dedicated regression test.
- **False tsc-safety (Reviewer B):** no exhaustive switch / `Record<AgentState,…>` exists; added
  the manual render-site checklist (`index.ts` ×3, `inject-status.ts:108`) and corrected the
  Testing note. — §4 + Testing.
- **Coordinator gap (both):** guard pinned above the `resetCoordinator` early-return; coordinator
  row stuck-rendering explicitly out of scope (separate `CoordinatorState` union). — §2.
- **retire/nuke bypass (Reviewer A):** stated explicitly as the recovery path; guarded set held to
  merge-check / merge / restart. — §2 + Cross-cutting.
- **`ib state --cleanup` (Reviewer A):** op-holder PID ruled out of the cleanup kill set; no new
  cleanup machinery needed. — Cross-cutting.
- **Single RMW helper (both):** all three writers (merge, resume, watchdog) route through
  `updateAgentTransient`; removes the watchdog-clobber footgun. — §1.
- **Prose cleanup (both):** `finally`/dir-deletion ordering stated as a confirmed trace, not a
  self-Q&A. — §2.

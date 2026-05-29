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
watchdog snapshot (or vice-versa) via last-write-wins on the whole file. The plan handles this
with two small, dedicated helpers that do a **read-modify-write of only the `operation`
field**, preserving every other field from whatever is currently on disk:

```ts
// agents.ts — both do read-merge-write, touching ONLY operation.
export async function setAgentOperation(agentDir, op: AgentOperation): Promise<void>
export async function clearAgentOperation(agentDir): Promise<void>
```

These read the current transient (or a zeroed default if none), set/delete `operation`, and
write atomically (`.tmp` + rename, same as `writeAgentTransient`). The watchdog's own
`writeAgentTransient` at line 1038 must likewise be changed to **preserve an existing
`operation` field** rather than omit it (its snapshot literal currently lists every field; it
should read-merge the current `operation` through, or call a shared merge helper). This is the
one cross-cutting subtlety — get it right or the watchdog will erase the merge marker on its
next 5s tick.

> Reviewer note to confirm: is read-modify-write on a ~6-field JSON file across the
> watchdog (5s cadence) and a hand-triggered merge an acceptable race surface, or do we want a
> stricter approach? The window is tiny and the worst case (a lost `operation` write) degrades
> to "guard didn't engage" — same as today — never to corruption. Defaulting to read-modify-
> write for simplicity unless review objects.

### 2. The guard — at the top of each long-running op

Add a shared preflight to the very start of `mergeCheckAgent`, `mergeAgent`, and
`resumeAgent` (before any slow work):

```ts
// returns { ok: true } to proceed, or { ok:false, stderr } to refuse.
async function acquireAgentOperation(agentDir, kind): Promise<...> {
  const t = await readAgentTransient(agentDir);
  const op = t?.operation;
  if (op && op.pid > 0 && isPidAlive(op.pid)) {
    return { ok:false, stderr:`Agent is currently ${humanize(op.kind)} (pid ${op.pid}) — try again when it finishes` };
  }
  // op absent, or holder dead → reclaim. Log reclaim if we overwrote a dead holder.
  await setAgentOperation(agentDir, { kind, pid: process.pid, started_at_ms: Date.now() });
  return { ok:true };
}
```

- Each op wraps its body in `try { ...work... } finally { await clearAgentOperation(agentDir) }`
  so a crash mid-op leaves the marker behind (which is what enables dead-holder reclaim and
  stuck detection).
- `resumeAgent` keeps its existing `tmux has-session` liveness refusal — that is a *different*
  guard (don't clobber a genuinely-running agent) and stays. The new op-guard sits above it and
  covers the "another op is mid-flight" case the tmux check can't see (e.g. a merge that hasn't
  reached its tmux step yet).
- `mergeAgent`/`mergeCheckAgent` currently delete the agent dir on success (`mergeAgent` step
  17-19). `clearAgentOperation` must be a **no-op if the dir/file is already gone** (it is —
  `writeAgentTransient`/the read are best-effort, but verify the `finally` doesn't throw on a
  removed dir). The `finally` runs before `archiveAgent` removes the dir? No — confirm ordering:
  the simplest correct placement is to clear the op as the *first* line of the `finally`, and
  for `mergeAgent` the op naturally vanishes with the dir, so the explicit clear becomes a
  best-effort no-op. Make the helper swallow ENOENT.

**This replaces `resumingAgentIds` as the source of truth.** Keep the UI's immediate
`setNotice("Merging…/Resuming…")` feedback, but the in-memory set is removed (or kept only as
a micro-optimization that the durable guard backstops). The dashboard `m`/`R` handlers
(`handleMerge`, `handleResume`) surface the refusal `stderr` verbatim, so a mashed key shows
"Agent is currently merging…" instead of racing.

### 3. Render states + stuck detection in `detectAgentStates` (NOT the per-agent watchdog)

The agent's own watchdog exits ~10s after its tmux session dies, and merge kills that session
mid-op — so the per-agent watchdog is the *wrong* place to catch a stuck merge. The right place
is `detectAgentStates()` (`src/agents.ts:1066`): it runs every ~2s in the always-on `ib watch`
loop, already iterates every agent, and already does PID-liveness checks.

Add to the `AgentState` union (`src/parse-state.ts:9`) two render-only states:

```ts
| "merging"        // covers merge_check + merging — one user-facing label is enough
| "restarting"     // resume in flight
| "op_stuck"       // op present, holder dead OR started_at older than 300s
```

> Decision for reviewers: do we want **one** `op_stuck` state, or distinct
> `merge_stuck`/`restart_stuck`? Leaning toward a single `op_stuck` (simpler; the underlying
> `operation.kind` is still on disk for anyone who needs detail). Confirm.

In `detectAgentStates`, when reading transient (it already reads it at `agents.ts:1171`), add a
branch **before** the compacting/rate-limited overrides:

```ts
const op = transient?.operation;
if (op) {
  const holderDead = op.pid > 0 && !isPidAliveCtx.fn(op.pid);
  const tooOld = nowMsCtx.fn() - op.started_at_ms > OP_STUCK_TIMEOUT_MS; // 300_000
  if (holderDead || tooOld) { agent.state = "op_stuck"; return; }
  agent.state = op.kind === "restarting" ? "restarting" : "merging";
  return;
}
```

Note: the existing freshness gate (`updated_at_ms` fresh + watchdog alive) is about trusting the
*watchdog's* tmux classification. The `operation` field is written by merge/resume, not the
watchdog, so the op branch must NOT be gated behind watchdog liveness — read `operation`
straight from disk regardless of watchdog freshness. Structure the code so the op check happens
on the transient read unconditionally, and the compacting/rate-limited fast-path keeps its
existing freshness+watchdog-alive gate.

`OP_STUCK_TIMEOUT_MS = 300_000` (5 minutes) — per user. Long enough that a big rebase never
false-positives; merge already logs per-step `timed()` durations to `watch.log`, so we can tune
from real data later if needed.

### 4. Styling for the new render states (`src/tui/color-scheme.ts`)

Add to both the light and dark maps in `getStateColors()` (`src/tui/color-scheme.ts:26-37`):

```
merging: CYAN, restarting: CYAN, op_stuck: RED,
```

(Or YELLOW for in-progress / RED for stuck — pick during review for contrast against
`running`=GREEN, `rate_limited`=RED.) Any other place that switches exhaustively on
`AgentState` (icon/label maps, the agent-tree compact renderer) must add cases — grep for an
existing state literal like `"compacting"` to find them all and avoid a non-exhaustive-switch
TS error.

## Scope of edits (files)

- `src/agents.ts` — `AgentOperation` type; `operation` field on `TransientState`; validation in
  `readAgentTransient`; `setAgentOperation`/`clearAgentOperation` helpers; op branch in
  `detectAgentStates`; `OP_STUCK_TIMEOUT_MS` const.
- `src/ib-commands.ts` — `acquireAgentOperation` shared preflight; wire into
  `mergeCheckAgent`, `mergeAgent`, `resumeAgent` with `try/finally`.
- `src/parse-state.ts` — extend `AgentState` union.
- `src/watchdog.ts` — make the transient write at line 1038 preserve an existing `operation`
  field (read-merge instead of omit).
- `src/tui/color-scheme.ts` — colors for `merging`/`restarting`/`op_stuck`.
- `src/tui/agent-actions.ts` — remove/relegate `resumingAgentIds`; surface guard refusal text
  in `handleMerge`/`handleResume`. (Keep `setNotice` immediate feedback.)
- Any other exhaustive `AgentState` switch (icons/labels) — grep and update.

## Cross-cutting review checklist (per CLAUDE.md)

1. **General agent functionality** — adds a transient op marker to the lifecycle; no change to
   spawn or meta.json *durable* shape (field lives in `meta.transient.json`). meta.json
   untouched on purpose: ops are ephemeral, transient is the right home.
2. **Hooks** — not affected. Hooks don't read/write `operation`.
3. **Watchdog** — affected: must preserve `operation` on its transient writes (the one subtle
   bit). Stuck *detection* lives in `detectAgentStates`, not the per-agent watchdog, precisely
   because merge kills the session the watchdog depends on.
4. **`ib watch` / dashboard** — affected: 3 new render states need colors + any exhaustive
   switches; `m`/`R` handlers surface durable-guard refusals.

## Testing

- **Guard:** with `operation` set + live pid → second `mergeCheckAgent`/`mergeAgent`/
  `resumeAgent` returns `ok:false` with the "currently …" message. With dead pid → reclaims and
  proceeds. (Use the existing `mergeSpawnCtx`/`nukeResumeSpawnCtx` fake-runner injection and an
  `isPidAlive` injection.)
- **Clear on success & failure:** op marker is gone after a successful merge (dir removed) and
  after a *failed* merge (op cleared via `finally`, agent still present).
- **Stuck detection:** `detectAgentStates` returns `op_stuck` when (a) holder pid dead, or
  (b) `started_at_ms` older than 300s (inject `nowMsCtx`). Returns `merging`/`restarting` for a
  fresh, live op.
- **Watchdog preserves operation:** a watchdog transient write does not erase an existing
  `operation` field.
- **Transient back-compat:** an old transient file with no `operation` reads fine; a malformed
  `operation` is ignored without failing the whole read.
- `bun test` green; `bunx tsc --noEmit` zero errors (the union extension will force exhaustive
  switches to be updated — that's the compiler doing our coverage check).

## Open questions for plan review

1. One `op_stuck` state vs. `merge_stuck`/`restart_stuck`? (Leaning: one.)
2. Collapse `merge_check` + `merging` into a single `merging` render label? (Leaning: yes — the
   distinct *guard* kinds still exist on disk; only the user-facing render collapses.)
3. Read-modify-write on the shared transient acceptable, or stricter? (Leaning: RMW; worst case
   is a missed guard, never corruption.)
4. Keep `resumingAgentIds` as a cheap same-process fast-path backed by the durable guard, or
   delete entirely? (Leaning: delete — one source of truth is simpler.)

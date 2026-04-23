# Background Shell & Active-Children State Tracking — Plan

> Location note: This repo's existing planning docs live at repo root (`PLAN.md`, `AGENT-TYPES-PLAN.md`, `SPAWNER-TRACKING-PLAN.md`). The task requested `docs/plans/background-shell-state.md`, but since there is no `docs/plans/` tree and in-progress plans follow the repo-root convention, this doc is placed at `BACKGROUND-SHELL-STATE-PLAN.md`.

> **Revision v2** (post-review): incorporates reviewer feedback. Key changes from v1: (a) predicate for "active child" narrowed to `{running, creating}` — `waiting` and `complete` explicitly excluded to avoid transitive-waiting deadlock and ensure `complete` children still escalate to users for merge/kill. (b) Counter-pause semantics for `handleWaiting` specified exactly (check-before-increment). (c) `hasActiveChildren` I/O profile clarified — reads stored `meta.state` only, no per-child tmux calls. (d) `notifySpawner` added explicitly to gap table and implementation checklist. (e) Layering clarified: for Case 1 watchdog, the resolver override is primary, `handleWaiting` bg-check is redundancy. (f) §7.3 strengthened — complete-branch transitive notifications are called out as EXPLICITLY UNFIXED after this change. (g) Expanded test matrix.

---

## 1. Problem Statement

itsybitsy's current state-tracking logic marks an agent as `waiting` as soon as Claude goes idle after emitting the literal token `WAITING` as its last line. When the agent has:

- **Case 1**: One or more **background shells** running in its tmux pane (visible in the tmux footer as `⏵⏵ accept edits on · 1 shell`), OR
- **Case 2**: One or more **active sub-agents** (children in states `running`, `creating`, `compacting`, `rate_limited`),

...the agent is still effectively doing work — either directly via an in-flight `Bash` tool call with `run_in_background=true`, or indirectly by orchestrating sub-agents. Treating it as `waiting` causes two undesirable behaviors:

1. **Stop hook** (`src/hooks/agent-status.ts`) immediately sends `[hook]: Your subtask <id> is now waiting for input` to the parent manager on the very first idle transition (no debounce).
2. **Watchdog** (`src/watchdog.ts` `handleWaiting`) increments the wait counter and, after 30 seconds of sustained `waiting` state, sends `[watchdog]: Your subtask <id> recently started waiting for input`, and continues sending via exponential backoff.

Both message prefixes (`[hook]`, `[watchdog]`) appear in the user's notification stream, so a single "stuck waiting" condition can produce notification noise from two independent layers.

**Evidence — Case 1 (background shell):**
`ib look agent-b3d3acfb --lines 50` on this branch shows the agent signed off with `WAITING` after backgrounding a `swift run ... sweep` command. Its tmux footer reads:

```
⏵⏵ accept edits on · 1 shell
```

and an inline status line reads:

```
✻ Churned for 12m 32s · 1 shell still running
```

The `ib list` output still shows this agent with state `waiting`, and both the stop hook (immediately) and the watchdog (after 30s) notify its parent (agent-976d9ddf) of a "waiting" child — even though the 1200/20 sweep it kicked off is still running in the background shell.

**Evidence — Case 2 (active children):**
Same repo, same session: agent-c03ee516 spawned two reviewer sub-agents (`agent-9aea90c3`, `agent-8c8989de`) and emitted `WAITING`. Its tmux footer shows no shell count (just `⏵⏵ accept edits on (shift+tab to cycle)`), but both reviewers are `running`. The parent (agent-aa6e273b) is notified that agent-c03ee516 is "waiting" even though the work-in-progress tree below it is not idle. This is a common pattern for every manager that spawns children and parks at `WAITING`.

**Goal:** Do not notify a manager about a child that has work in flight — whether via background shells or via active sub-agents.

---

## 2. Current Flow

### 2.1 Writers of `meta.json.state`

There are three writers (see `SPEC.md` §1.3.1 — only `running`/`waiting`/`complete` are written to disk):

1. **Stop hook** — `src/hooks/agent-status.ts:66-80` (`processStopHook`). On Claude idle, reads `last_assistant_message` from stdin and maps:
   - last non-empty line `"WAITING"` → `state = "waiting"` (`src/hooks/agent-status.ts:43-58` `detectStateFromMessage`).
   - `"I HAVE COMPLETED THE GOAL"` → `state = "complete"`.
   - anything else → `state = "running"`.
   The hook calls `writeAgentState()` (`src/agents.ts:124-139`) unconditionally before doing any other work.
2. **`ib send`** — writes `running` via `writeAgentState()` after sending tmux input (`src/ib-commands.ts`).
3. **`ib resume`** — writes `running` via `writeAgentState()` on resume.

### 2.2 Readers of state

1. **`detectAgentStates()`** — `src/agents.ts:583-629`. Used by `watcher.ts` for the TUI. Resolution order:
   1. archived → `stopped`
   2. no tmux session → `stopped` (or `creating` within grace period)
   3. `isCompacting(output)` → `compacting` override
   4. `isRateLimited(output)` → `rate_limited` override
   5. `meta.state` → return stored value (`running`/`waiting`/`complete`)
   6. legacy fallback → `running` (or `creating` within grace period)

   **There is no background-shell override in this function.** `hasBackgroundTasks()` exists in `src/agents.ts:191-196` but is not called here.

2. **`resolveWatchdogState()`** — `src/watchdog.ts:645-653`. Per-agent watchdog's state resolver, called every 5s (`POLL_INTERVAL_MS`). Mirrors `detectAgentStates()` step 3→5:
   - `isCompacting` → `compacting`
   - `isRateLimited` → `rate_limited`
   - else `meta.state` or `"running"` fallback.

   Also has no background-shell override.

### 2.3 `hasBackgroundTasks` — current usage

`src/agents.ts:191-196`:

```ts
export function hasBackgroundTasks(tmuxOutput: string): boolean {
  const stripped = stripAnsi(tmuxOutput);
  const lines = stripped.split("\n");
  const last15 = lines.slice(-15).join("\n");
  return /⏵⏵.*·\s\d+\s/.test(last15);
}
```

Called from **exactly one site**: `src/hooks/agent-status.ts:123`, inside the `if (state === "running")` branch. It suppresses the nudge-on-running case (the "Resume your work…" prompt).

**It is never called when the stop hook has determined `state === "waiting"` or `state === "complete"`.** So if the agent's last line was `WAITING` and it has a live background shell, the hook writes `state: "waiting"` (line 80) and then proceeds directly to `notify_manager` (line 194-199) without looking at tmux output at all.

### 2.4 `parseState()` (legacy) — where background tasks used to be considered

`src/parse-state.ts:199-201` contains the "background tasks in status bar" rule:

```ts
if (/⏵⏵.*·\s[0-9]+\s/.test(last15)) {
  return { state: "running", reason: "background tasks in status bar" };
}
```

But this rule is evaluated **after** the `WAITING` rule on line 141. So even legacy parseState would classify the current tmux pane as `waiting`, not `running` — the legacy parser doesn't actually solve Case 1 either. This is why the bash `ib` reference and itsybitsy agree on current (buggy) behavior.

Furthermore, `parseState()` is deprecated (`src/parse-state.ts:68-75`) — not used for primary detection. Its "background tasks" rule is effectively dead code for live state tracking, retained only for the watchdog's rate-limit bypass retry loop.

### 2.5 Notification paths — who notifies whom

**`[hook]` (stop hook)** — fires once per Claude idle event:

- `state === "waiting"` + has active manager → `notify_manager` action (`src/hooks/agent-status.ts:191-200`).
- `state === "complete"` + clean git + has active manager → `notify_manager` action (`src/hooks/agent-status.ts:162-170`).
- `state === "complete"` + no manager + unfinished children → `remind_children` (`src/hooks/agent-status.ts:172-186`). Uses `findUnfinishedChildren()` (`src/hooks/agent-status.ts:283-348`), which already checks child state against `UNFINISHED_META_STATES = {running, waiting, complete}` plus `creating`. **This only runs when there is no manager** — if a manager exists, children are not consulted.
- `state === "running"` + has background tasks → `action: "none"` (`src/hooks/agent-status.ts:123-125`). This is the only existing guard on the notification path, and it only covers the `running` branch for Case 1.

The actual tmux `send-keys` happens in `executeResultActions` (`src/hooks/agent-status.ts:433-505`).

**`[watchdog]` (per-agent watchdog)** — fires on a 5s poll, rate-limited by `notifyInterval` (initial 6 ticks = 30s, doubles up to 64 min):

- `handleWaiting` (`src/watchdog.ts:254-273`) → after threshold ticks, calls `notifyManager` with `"[watchdog]: Your subtask <id> recently started waiting for input"` and `notifySpawner` with analogous text. No background-shell check, no active-children check.
- `handleComplete` (`src/watchdog.ts:339-353`) → one-shot `notifyManager` + `notifySpawner` on entry. Cleared only when the agent transitions back to `running`. Also no guards.
- `handleUnknown` (`src/watchdog.ts:280-304`) → same backoff pattern. With deterministic state tracking this path is largely dead (see SPEC §8.5 "`unknown` state removed" callout), but the handler still exists.

The watchdog shares `captureTmuxOutput()` already on every tick to evaluate the compacting/rate-limited overrides (`src/watchdog.ts:741`), so the tmux output is already in hand when `handleWaiting` runs.

### 2.6 TUI state color (for context on new-state impact)

`src/tui/color-scheme.ts:29-35`:
- `running` = GREEN, `waiting` = YELLOW, `complete` = BLUE, `compacting` = MAGENTA, `rate_limited` = RED, `stopped` = DIM_GRAY, `creating` = YELLOW, `unknown` = WHITE.

If a new state is introduced, a color must be added here and to the dark-mode variant, plus the state legend (`src/tui/agent-tree.ts:20` already normalizes `unknown` → `running` for display).

---

## 3. Tmux Footer Patterns

### 3.1 Background-shell indicator (Case 1)

Captured verbatim from agent-b3d3acfb's tmux pane footer (`ib look agent-b3d3acfb --lines 50`):

```
  repo | Opus 4.7
  agent/agent-b3d3acfb
  ctx: 7% sess: 11% (59m) week: 81% (12h)
  ⏵⏵ accept edits on · 1 shell
```

There is also a mid-pane status line that Claude itself renders while churning:

```
✻ Churned for 12m 32s · 1 shell still running
```

**Discriminator:** The literal `⏵⏵` glyph followed later by `· N ` (middle-dot, space, digit(s), space). This is exactly what `hasBackgroundTasks()` matches with `/⏵⏵.*·\s\d+\s/`. Verified with `bun -e '/⏵⏵.*·\s\d+\s/.test("⏵⏵ accept edits on · 1 shell")' → true`.

**Negative control** — agent-c03ee516 (no background shells running, but has sub-agents):

```
  ⏵⏵ accept edits on (shift+tab to cycle)
```

The `· N shell` fragment is absent. Regex does not match. Confirmed correct.

**Note on variants:** When the agent uses `plan mode` or `bypass permissions`, the first part of the footer changes (`⏵⏵ plan mode on`, `⏵⏵ bypass permissions`, etc.), but the `· N shell` suffix remains the discriminator. The current regex tolerates this because of the `.*`.

### 3.2 Active-children indicator (Case 2)

There is no tmux-level indicator that a parent has active children. The parent's tmux pane looks the same whether its children are busy or finished — this is state about *other* agents. The data must come from `meta.json` files of the parent's children, which `findUnfinishedChildren()` already walks.

---

## 4. Gap Analysis

### 4.1 Case 1 — Background shells

| Layer | Current Behavior | Gap |
|---|---|---|
| **Stop hook, `running` branch** | Calls `hasBackgroundTasks()`, returns `action: "none"` if a background shell exists. | ✅ Correct. |
| **Stop hook, `waiting` branch** (`src/hooks/agent-status.ts:191-203`) | Writes `state: "waiting"` and unconditionally `notify_manager`. | ❌ No background-shell check. This is the direct cause of the premature `[hook]` notification. |
| **Stop hook, `complete` branch** | Checks unfinished children (only when no manager), uncommitted git. | ❌ No background-shell check. Less critical — `complete` implies the agent actively signed off — but still wrong if the agent said "COMPLETED" while a background shell lingers. |
| **`detectAgentStates()` (TUI)** (`src/agents.ts:583-629`) | Has `isCompacting` / `isRateLimited` tmux overrides; no background-shell override. | ❌ The TUI shows `waiting` (yellow) even though the agent is working. Also means the watchdog can't pick up a "there is shell activity here" signal from state alone. |
| **Watchdog `resolveWatchdogState`** (`src/watchdog.ts:645-653`) | Same override structure as `detectAgentStates`; no background-shell override. | ❌ `handleWaiting` fires after 30s and keeps firing on backoff. |
| **Watchdog `handleWaiting`** (`src/watchdog.ts:254-273`) | Sends `[watchdog]: … recently started waiting` with no guard. | ❌ Even if upstream state were overridden to `running`, a belt-and-braces guard here would avoid future regression. |

### 4.2 Case 2 — Active children

| Layer | Current Behavior | Gap |
|---|---|---|
| **Stop hook, `waiting` branch** | Unconditional `notify_manager`. | ❌ Does not check children. |
| **Stop hook, `complete` branch** | `findUnfinishedChildren()` is called, but **only** in the `no-manager` path. If manager exists, notifies manager without checking. | ❌ Inverted logic for Case 2: a manager that signals complete while children are mid-work should not be reported up until children settle. (Related but separate from the notification-suppression ask; called out as an explicit unfixed limitation in §7.3.) |
| **`detectAgentStates()`** | Considers only the agent's own tmux + meta.json. | ❌ No visibility into child state. |
| **Watchdog `resolveWatchdogState`** | Per-agent watchdog only reads the focal agent. `loadAllAgentsForNotification` fetches all agents but only for the notification-target lookup. | ❌ Children information is available but not consulted for state resolution. |
| **Watchdog `handleWaiting` — `notifyManager`** | Receives `allAgents` as its third arg, so siblings are reachable by filtering `meta.manager === agent.id`, but it never walks them. | ❌ Cheap to add: flat-filter `allAgents` and short-circuit notification when any child is non-terminal. |
| **Watchdog `handleWaiting` — `notifySpawner`** (`src/watchdog.ts:263-267`) | Same unconditional call as `notifyManager`, targeting the cross-repo spawner. | ❌ Needs the same guard as `notifyManager`. A parent spawned from another repo gets just as noisy as a same-repo manager. |

### 4.3 Summary

- The deterministic `meta.state` machinery is correct about what the agent *said* (`WAITING`). It is silent about what the agent is *doing* (background shells) or what its children are *doing*.
- The stop hook and watchdog both act on the stored state without consulting either of those two dimensions on the `waiting` path.
- Case 1 has a narrow, existing helper (`hasBackgroundTasks`) used only in the `running` branch of the stop hook.
- Case 2 has a broader helper (`findUnfinishedChildren`) used only in the `complete`/no-manager branch of the stop hook; the watchdog has direct access to child records via `agent.children`.

---

## 5. Design Options

Options A–D consider Case 1 alone (background shells). Options E–F target Case 2 (active children). Option G is the combined approach.

### Option A — Suppress in the stop hook: write `running` instead of `waiting` (Case 1)

When the stop hook's `detectStateFromMessage` returns `"waiting"` but tmux shows a background shell, write `state: "running"` to meta.json instead.

- **Pros**: Fixes both `[hook]` and `[watchdog]` notifications at a single source of truth (meta.json). No new state. TUI naturally shows `running` (GREEN). Aligns with "intent = work is in flight."
- **Cons**: Distorts the agent's self-reported state — future-Claude reading meta.json will see `running` even though its last line was `WAITING`. This could confuse resume logic or debugging. Loses the "the model asked to park" signal.
- **TUI impact**: None (existing `running` color).
- **SPEC impact**: §6.2 table needs a new row: `running | Stored state was waiting but background shells active | Overwrite to running, no action`. §1.3.1 note about meta.json truthfulness.
- **Test impact**: `processStopHook` tests must add a case where `last_assistant_message = "WAITING"` + `captureOutput` returns background-shell text → expects `state: "running"`, `action: "none"`.
- **Deterministic-model risk**: Medium. Phase 42's model is "meta.state reflects Claude's self-signal; tmux overrides are transient and separate." Writing `running` when Claude said `WAITING` breaks that invariant.

### Option B — Override in `detectAgentStates` + `resolveWatchdogState` (Case 1)

Keep meta.state as written (`waiting`), but add a tmux override:

```
if (hasBackgroundTasks(output)) agent.state = "running";
```

Applied *after* compacting/rate_limited, *before* reading meta.state.

- **Pros**: Preserves the deterministic-model invariant — meta.json still records `waiting`. Overrides live in the same two functions that already do compacting/rate-limited overrides, so the mental model is consistent. Fixes both `[hook]` (via a new check in agent-status.ts, since that path doesn't use these resolvers) and watchdog at the same logical level. Works for the TUI automatically.
- **Cons**: Does not by itself fix the `[hook]` path — the stop hook runs in the agent's own process and writes before resolvers run. Still requires a parallel guard in agent-status.ts's `waiting` branch. Two places to keep in sync.
- **TUI impact**: Agent shows `running` (GREEN) while idle-with-shell. Good: matches user intuition. Possible downside: loses the "sent WAITING" signal visually. Acceptable if the info panel surfaces the underlying `meta.state`.
- **SPEC impact**: §1.3 resolution order gets a new step 3a: "tmux background-shell pattern → `running`". §8.5 watchdog state resolution updated correspondingly.
- **Test impact**: New tests in `agents.test.ts` for `detectAgentStates()` background-shell override; similar for watchdog's `resolveWatchdogState`.
- **Deterministic-model risk**: Low. This is structurally identical to the existing `compacting`/`rate_limited` overrides — transient tmux signals win over stored state.

### Option C — New state `running-bg` (or `waiting-bg`) (Case 1)

Introduce a distinct state so the TUI can display "waiting, but with work in flight" and consumers can make nuanced decisions.

- **Pros**: Makes the distinction explicit in the TUI (e.g., dim yellow or yellow+bold). Watchdog can have a dedicated handler that no-ops on notification. Preserves the fact that the agent *said* WAITING while marking it non-notifiable.
- **Cons**: Expands the state enum — every consumer (color scheme, sort keys, tests, sidebar legends, info panel, `listAgentTypes`, serialization) needs an update. `AgentState` union in `parse-state.ts:9-17` + every switch/if chain downstream. Larger blast radius. Doesn't fit neatly in the two-tier model (`meta.state` stores `running/waiting/complete`; derived states are compacting/rate_limited/stopped/creating). Adding a derived state for "background" is fine in principle but multiplies the combinations.
- **TUI impact**: Big — new color, new legend entry, decide whether to treat as `waiting`-like or `running`-like for sorting/filtering.
- **SPEC impact**: §1.3 state table (§1.3 and table around line 72), §8.5 watchdog behavior table. Nontrivial doc write.
- **Test impact**: Wide — every test that builds an AgentState touches the new value.
- **Deterministic-model risk**: Low, but spec-creep risk is high.

### Option D — Guard the watchdog's and stop hook's notify action (Case 1)

Leave state as `waiting`. Add a guard at the exact notification site: before firing `[hook]: … waiting for input` or `[watchdog]: … recently started waiting`, re-check tmux for background shells; suppress if present.

- **Pros**: Minimally invasive. No new state, no state-model changes. Notification-only fix. Each layer owns its own check.
- **Cons**: TUI still shows `waiting` (yellow) for an agent that's working. Two notification guards to maintain. Tmux capture on the watchdog path is already done; on the hook path it's one extra tmux call.
- **TUI impact**: None (state is unchanged) — arguably a *con*, since users looking at the TUI get no signal that the agent is actually busy.
- **SPEC impact**: §6.2 and §8.5 tables get new "unless background shells are active" conditions on the waiting→notify rows.
- **Test impact**: Guard tests at both sites; state-model tests unchanged.
- **Deterministic-model risk**: Lowest.

### Option E — Manager-side child check before notifying (Case 2)

Before sending `[hook]` or `[watchdog]` waiting-notifications to a parent, walk the would-be-notified agent's children; if any child is in `running`/`creating`/`compacting`/`rate_limited`, suppress the notification.

- **Pros**: Direct fix for the "manager spawned children and parked at WAITING" case. Reuses `findUnfinishedChildren`-style logic (already present in the complete/no-manager path of the stop hook). Watchdog already has `allAgents` + `agent.children` in hand.
- **Cons**: "Active child" is fuzzy — a child in `waiting` with its own background shell should count as active, otherwise we miss the transitive case. If we include `waiting` as "non-terminal," we swing the other way and never notify. Need a clear predicate: **terminal** = `stopped` or `complete` (with no further activity expected by the user); **non-terminal** = everything else. This is essentially the existing `UNFINISHED_META_STATES` (`src/hooks/agent-status.ts:275`) plus transient states.
- **TUI impact**: None (state unchanged). Could optionally add an info-panel line "Has N active children — notification suppressed."
- **SPEC impact**: §6.2 and §8.5 table updates. A new subsection describing "child-activity guard."
- **Test impact**: Stop hook and watchdog tests for parent-with-active-child and parent-with-only-stopped-children cases.
- **Deterministic-model risk**: Low — it's a notification-layer check, not a state rewrite.

### Option F — Debounced variant of Option E (Case 2)

Same as E, but suppress only within the first ~30 seconds of the parent entering `waiting`. After that window, notify even if children are still busy, so a parent stuck forever isn't silently orphaned.

- **Pros**: Safety net against "parent dies waiting for a child that's broken."
- **Cons**: Adds a timer. Hard to pick a good threshold — a 30-minute review cycle would still notify mid-review. Leaks the problem back into manager inboxes.
- **TUI impact**: None.
- **SPEC impact**: Same as E, plus the debounce rule.
- **Test impact**: Same as E, plus time-window tests.
- **Deterministic-model risk**: Low.

### Option G — Combined: "work in flight" override covering both cases

A single override function, e.g., `hasWorkInFlight(agent, allAgents) = hasBackgroundTasks(tmuxOutput) || hasActiveChildren(agent)`, is applied:

1. In `detectAgentStates()` and `resolveWatchdogState()` — **only for Case 1** (background shells), since they don't have access to `allAgents` without a signature change. The tmux-based check remains a tmux override.
2. In the **notification path** of the stop hook (`state === "waiting"` branch) and the watchdog (`handleWaiting`, and arguably `handleComplete`) — for **both cases**: suppress notification when `hasWorkInFlight` is true.

- **Pros**: Single mental model ("don't bother the parent while the child has work to do"). Symmetric across both layers. Extensible to future cases (e.g., pending user questions = work in flight too).
- **Cons**: The two layers get slightly different predicates — the state resolver only knows about tmux, the notifier knows about tmux + children. Ok if documented.
- **TUI impact**: Background-shell agents display as `running`. Child-active parents still display as `waiting` (we don't fabricate state from the parent's POV since the parent really is waiting on its children). This is arguably *correct* — the parent *is* waiting; we just don't nag about it.
- **SPEC impact**: Two locations — state resolution (§1.3) gains the background-shell tmux override; notifier tables (§6.2, §8.5) gain a combined "has work in flight" guard.
- **Test impact**: Moderate — unit tests for `hasWorkInFlight`; integration-style tests for each guard site.
- **Deterministic-model risk**: Low, matches Option B's reasoning plus a pure notification-layer check for children.

### Options considered and rejected early

- **Rewriting meta.json from the watchdog** to keep the state model coherent with Case 2: rejected — state in meta.json is "what Claude said last," not "what the tree looks like." The watchdog should not rewrite the child's self-signal because the child has busy grandchildren.
- **Teaching `parseState` to handle this**: rejected — parseState is deprecated; adding logic there would only paper over the deterministic model.

---

## 6. Recommendation

**Adopt Option G: "work in flight" guard, layered.**

Specifically:

1. **State-resolution layer** — add a background-shell override to both `detectAgentStates()` (`src/agents.ts`) and `resolveWatchdogState()` (`src/watchdog.ts`). Placement: after compacting/rate_limited, before reading `meta.state`.

   ```
   if (meta.state === "waiting" && hasBackgroundTasks(output)) state = "running";
   ```

   Scoped to `meta.state === "waiting"` so we don't override `complete` (the agent explicitly signed off) or `running` (already correct). This is Option B restricted to a clear condition.

2. **Notification layer** — add a combined `hasWorkInFlight` guard in:
   - `src/hooks/agent-status.ts` `processStopHook`, `state === "waiting"` branch (before `notify_manager`): suppress if `hasBackgroundTasks(tmuxOutput)` OR `hasActiveChildren(agentId, agentsDir)`.
   - `src/watchdog.ts` `handleWaiting`: suppress `notifyManager`/`notifySpawner` if `hasBackgroundTasks(output)` OR any child in `allAgents` with `meta.manager === agent.id` and state ∈ `{running, creating, compacting, rate_limited}`.

   The stop hook path re-reads tmux (one extra `captureTmuxOutput` call — same as existing running-branch check). The watchdog already has tmux + `allAgents` in hand, so no extra I/O.

**Why G over the alternatives:**

- **Beats A** (rewrite state to `running` on WAITING): preserves the "meta.state = what Claude said" invariant. The same information is conveyed via the transient tmux override in the resolvers, matching the existing pattern for compacting/rate_limited.
- **Beats B alone**: B doesn't address Case 2 at all. B covers Case 1 at the TUI + watchdog-resolver level but still leaves the stop hook's `waiting` branch firing `[hook]` prematurely (the stop hook doesn't use the resolvers). The notifier-layer guard in G closes that gap.
- **Beats C** (new state): avoids a cross-cutting enum change for a behavior that can be expressed as a tmux override.
- **Beats D alone**: D ignores the TUI signal and ignores Case 2. G's resolver change gives the TUI the correct color for Case 1; the notifier guard handles Case 2.
- **Beats E alone**: E handles Case 2 but not Case 1.
- **Beats F**: a time-debounce is an escape hatch for a problem the user doesn't actually have (the user's complaint is exactly "notified too early"); adding a delayed re-notify brings the noise back.

**Layer responsibility (answering the "which layer gets the guard" question):**

- **Case 1, stop hook**: notifier guard in the `waiting` branch. The stop hook runs before any resolver, so this is the only place that can suppress the `[hook]` notification.
- **Case 1, watchdog**: the resolver override (step 4 in §7.1) is the **primary** suppression — with that in place, `resolveWatchdogState` returns `"running"` for a waiting-with-shell agent, so `handleWaiting` is never dispatched to; the `running` handler runs instead (which is a no-op for notification). The `hasBackgroundTasks` check proposed in §7.1 step 3 for `handleWaiting` is **belt-and-braces redundancy** — useful if the resolver ever gets refactored, but not the primary fix. This redundancy is deliberate; it is documented in the checklist so a future reader doesn't delete it as dead code.
- **Case 1, TUI**: the resolver override shows the agent as `running` (GREEN), matching user intuition.
- **Case 2, stop hook + watchdog**: notifier guard in both. The state resolver does NOT rewrite the parent's own state — the parent really is waiting (on its children). We suppress upward notification only.

**Scope non-goal:** `handleComplete` in the watchdog (and the complete-branch of the stop hook, when a manager exists) has a similar "child still busy" smell but is outside the reported problem. It's listed in §7.3 as an explicitly unfixed limitation so it isn't accidentally bundled into this change. A user should expect that after this fix lands, the `[hook]` and `[watchdog]` notifications for **waiting** agents respect work-in-flight, but the **complete**-branch notifications do not.

---

## 7. Implementation Checklist

### 7.1 Code changes

Ordered. Each bullet is one commit-scoped unit; test changes go with their code.

1. **Extract a shared predicate** `hasActiveChildren(agentId: string, agentsDir: string, opts?) → Promise<boolean>` in `src/hooks/agent-status.ts` (near `findUnfinishedChildren`).

   **Canonical predicate (the "active" set — this is ground truth for both the stop hook and the watchdog):**

   > A child is **active** iff `meta.manager === agentId` AND `!meta.archived` AND (`meta.state === "running"` OR `isRecentlyCreated(meta.created_epoch)`).

   **Explicitly NOT in the active set:** `waiting`, `complete`, `stopped`, or any child whose tmux session is gone. Rationale:
   - **`waiting` excluded**: a chain of all-`waiting` agents means genuine human-intervention deadlock — the top of the chain *must* be notified so the user can unstick it. Including `waiting` as "active" would silence the chain indefinitely (see design note below for the worked example).
   - **`complete` excluded**: a `complete` child is done and awaiting merge/kill. Suppressing the parent's "I am waiting" notification because children are `complete` just delays the "please merge me" signal. The user wants to know.
   - **`creating` handled via `isRecentlyCreated(meta.created_epoch)`**: matches the existing `findUnfinishedChildren` treatment — `creating` is derived state, not stored.
   - **`compacting` / `rate_limited` automatic**: these are transient tmux-overrides at resolution time, but the *stored* `meta.state` remains `"running"`. So a child that is currently `compacting` still reads `meta.state === "running"` in meta.json and is correctly counted as active without a per-child tmux capture.

   **I/O profile**: reads each sibling agent's `meta.json` file (one `readdir` + one `readFile` per child). **Does NOT call `captureTmuxOutput` per child** — this is an intentional deviation from `findUnfinishedChildren`, which does. Rationale: `findUnfinishedChildren` is called on `complete` to decide whether to show "remind children" text to the user (latency isn't critical); `hasActiveChildren` is called on every `waiting` stop-hook and every 5s watchdog tick (latency matters). Reading stored `meta.state` is O(N children) file reads, no process spawns. Corner case: a child with stale `meta.state = "running"` whose tmux process actually died will be counted as active until the watchdog's 10s grace period writes `stopped` — fail-safe direction (slightly over-suppress instead of under-suppress).

   **Fail-open on I/O errors**: wrap the `readdir` in a try/catch and return `false` (not `true`) on failure — matching `findUnfinishedChildren`'s existing behavior. The priority is "notify when in doubt." Test this explicitly (see §7.1 step 2 test list).

   **Test injection**: add `opts.getChildState?: (tmuxSession: string) => Promise<string>` in the signature for consistency with `findUnfinishedChildren`, but note that `hasActiveChildren` does not actually use it under the default implementation (since we read meta.state, not live state). Left in place in case future revisions need tmux-aware checks. Unit tests in `src/hooks/agent-status.test.ts`:
   - `hasActiveChildren returns true for child with meta.state === "running"`
   - `returns true for child with isRecentlyCreated === true`
   - `returns false for child with meta.state === "waiting"`
   - `returns false for child with meta.state === "complete"`
   - `returns false for archived child even if meta.state === "running"`
   - `returns false when agentsDir is unreadable (fail-open)`

2. **Stop hook `waiting` branch** — `src/hooks/agent-status.ts:191-203`:
   - Read tmux output (same pattern as the existing `running` branch at lines 107-122, with the same `captureOutput` opts injection).
   - If `hasBackgroundTasks(tmuxOutput)` → return `{ state, action: "none" }`.
   - Else if `await hasActiveChildren(agentId, agentsDir)` → return `{ state, action: "none" }`.
   - Else fall through to existing `notify_manager`.
   - Tests in `src/hooks/agent-status.test.ts`:
     - `waiting + background shell → action "none"`.
     - `waiting + active child (running) → action "none"`.
     - `waiting + only waiting children → action "notify_manager"` (transitive-waiting deadlock prevention — the top of an all-waiting chain MUST be told).
     - `waiting + only complete children → action "notify_manager"` (user needs to merge/kill; don't suppress).
     - `waiting + only stopped children → action "notify_manager"` (regression — no children are actually doing work).
     - `waiting + mixed: one running + one waiting → action "none"` (at least one active).
     - `waiting + hasActiveChildren throws (agentsDir unreadable) → action "notify_manager"` (fail-open).
     - `waiting + tmux output is null → action "notify_manager"` (fail-open; same as existing running-branch behavior when tmux is gone).

   > **Design note — why `waiting` children don't count as "active"**: the reflexive instinct is "a waiting child still has context, let's suppress the parent." But Claude agents at `meta.state = "waiting"` have tmux panes that are idle; when a tmux-send message arrives from a child's stop hook, it lands in the input buffer without re-running Claude. So a parent parked at `waiting` does *not* automatically wake up when its child notifies it. This means: if we treated `waiting` as "active", a tree where every node is at `waiting` would produce zero notifications to the user — classic deadlock, requiring the user to independently notice something is stuck. The correct semantic is "`waiting` children propagate upward normally so each layer's backoff clock runs"; suppression is reserved for cases where the child is *actively doing work* (running, creating, or in a transient tmux-override state).

3. **Watchdog `handleWaiting`** — `src/watchdog.ts:254-273`:
   - **Note on layering**: after step 4 (resolver override) lands, `resolveWatchdogState` returns `"running"` for waiting-with-background-shell agents, so `handleWaiting` is not dispatched to in that case; the no-op `running` handler runs. Therefore the background-shell check inside `handleWaiting` is **belt-and-braces redundancy**, not the primary Case 1 fix. Keep it as a safety net and note this in a code comment so a future reader doesn't remove it as dead code. The primary role of the `handleWaiting` changes is Case 2 (active children), which the resolver override cannot address.

   Implementation sketch (ordering matters — check BEFORE increment):

   ```ts
   async function handleWaiting(agent, tracker, allAgents) {
     // Capture tmux to check background shells (belt-and-braces for Case 1).
     const output = await captureTmuxOutput(agent.meta.tmux_session);
     const bgActive = output !== null && hasBackgroundTasks(output);
     const childActive = anyChildActive(agent.id, allAgents);

     if (bgActive || childActive) {
       // Suppress notification AND do not advance the counter — the agent
       // isn't actually idle. When suppression lifts, waitCounter resumes
       // from where it stopped. Leaving the counter paused (rather than
       // resetting to 0 or arming to threshold-1) is a deliberate choice:
       // it means a short blip of activity won't reset a long backoff,
       // but it does mean that if the activity clears right after suppression
       // began, the manager waits a few more ticks for the normal threshold —
       // which is the right tradeoff for the "don't spam on flapping" case.
       return;
     }

     tracker.waitCounter++;
     if (tracker.waitCounter >= tracker.notifyInterval) {
       await notifyManager(agent, "[watchdog]: Your subtask ... waiting", allAgents);
       await notifySpawner(agent, "[watchdog]: Agent ... waiting", allAgents);
       tracker.waitCounter = 0;
       tracker.notifyInterval = Math.min(tracker.notifyInterval * 2, MAX_NOTIFY_TICKS);
     }
   }
   ```

   **Counter behavior (explicit, per reviewer feedback)**: the check happens BEFORE `waitCounter++`. When suppression fires, `waitCounter` retains its previous value; on the next tick, if suppression has lifted, `waitCounter++` resumes from the paused value. If the threshold had already been crossed before suppression began, the next clear tick notifies immediately. Note that because `waitCounter` is reset to 0 after every notification (line 270 in current code), "paused after notification" means paused at 0 (with a doubled `notifyInterval`) — still correct: the backoff isn't reset, which prevents notification flapping.

   **Both `notifyManager` AND `notifySpawner` are suppressed** — symmetric treatment, since both fire on the same condition inside `handleWaiting`.

   **Walking children — flat-filter only**. Define `anyChildActive(parentId, allAgents)` as:

   ```ts
   function anyChildActive(parentId: string, allAgents: Agent[]): boolean {
     return allAgents.some(a =>
       a.meta.manager === parentId &&
       !a.archived &&
       (a.meta.state === "running" || isRecentlyCreated(a.meta.created_epoch))
     );
   }
   ```

   Flat-filter over `allAgents` is used **for both call sites** (`watcher.ts` processAgents path AND `runPerAgentWatchdog` path) to avoid depending on `buildAgentTree()`, which is NOT called in `loadAllAgentsForNotification` (src/watchdog.ts:841-843 — the existing comment documents this intentional omission). Flat-filter reads stored `meta.state` directly, same as `hasActiveChildren` in step 1; in fact they should share the `anyChildActive` implementation (export from `src/agents.ts` and import in both places).

   Tests in `src/watchdog.test.ts`:
   - `handleWaiting` with background-shell tmux output → no notification, counter NOT advanced.
   - `handleWaiting` with one active child (`running`) in `allAgents` → no notification, counter NOT advanced.
   - `handleWaiting` with only `waiting` children → notification fires after threshold.
   - `handleWaiting` with only `complete` children → notification fires after threshold.
   - `handleWaiting` with only `stopped`/archived children → notification fires after threshold.
   - `handleWaiting` across multiple ticks — counter advances normally when clear, pauses when suppressed.
   - **Counter-pause behavioral test**: suppressed for 3 ticks (counter stays at 0), then clear for 6 ticks (counter reaches threshold), notification fires on the 9th tick total. Verifies suppression does not advance the counter.
   - **Pause-across-backoff test**: after one notification has fired and `notifyInterval` has doubled to 12, subsequent suppression for several ticks does not reset `notifyInterval` — it remains at 12.
   - **`notifySpawner` guard**: cross-repo spawner lookup returns a valid spawner agent; verify `notifySpawner` is suppressed alongside `notifyManager`.

4. **State-resolver override (Case 1 only)** — add to both:
   - `detectAgentStates()` in `src/agents.ts:583-629`: after the `isRateLimited(output)` check, add `if (agent.meta.state === "waiting" && hasBackgroundTasks(output)) { agent.state = "running"; return; }`.
   - `resolveWatchdogState()` in `src/watchdog.ts:645-653`: same check, mirrored.
   - Scope note: this override is **only for `meta.state === "waiting"`**. It does NOT fire for `"complete"` (agent signed off intentionally; preserve that) or `"running"` (already correct).
   - Tests in `src/agents.test.ts` + `src/watchdog.test.ts`:
     - `meta.state = "waiting"`, tmux has background shell → resolved state = `running`.
     - `meta.state = "waiting"`, tmux without shell → `waiting`.
     - `meta.state = "complete"`, tmux has background shell → `complete` (not overridden — agent explicitly signed off).
     - `meta.state = "running"`, tmux has background shell → `running` (no change — regression guard).
     - `meta.state = "waiting"`, tmux is null (session gone) → `stopped` (existing precedence still wins; override doesn't fire because no output).

5. **`loadAllAgentsForNotification`** — `src/watchdog.ts:834-850`: no change required. Add a short code comment at the flat-filter site in `handleWaiting` (step 3) documenting that we flat-filter on `meta.manager` rather than walking `agent.children` precisely because the per-agent watchdog path does not build a tree. This avoids a future maintainer accidentally introducing an `agent.children` dependency that would silently break the CLI watchdog.

### 7.2 SPEC.md updates

- **§1.3 State Detection Flow** (around line 85-99): add step 3.5 "If `meta.state === 'waiting'` and tmux shows `⏵⏵.*·\s\d+\s` (background shells) → `running`."
- **§6.2 Stop Hook Actions table** (around line 684-693): add rows (predicate wording must exactly match `hasActiveChildren` in code — only `running` or `creating` children count as "active"; `waiting` and `complete` children do NOT):
  - `waiting | Background tasks active (⏵⏵.*·\s\d+\s in last 15 lines of tmux) | No action (agent is working via background tasks)`
  - `waiting | Has at least one direct child with meta.state === "running" OR isRecentlyCreated(created_epoch) | No action (child still working)`
  - `waiting | Has manager, no background tasks, no active children | Notify manager (existing)`
- **§8.5 Watchdog Monitoring Behaviors table** (around line 1014-1021): update the `waiting` row to: "Increment waiting counter unless (a) tmux shows background shells OR (b) agent has at least one direct child in `{running, creating}` — in which case suppress notification and pause counter. Otherwise existing backoff."
- Add a short subsection "8.5.x Work-in-flight suppression" explaining the invariant. **Scoped wording** (important — avoid broader phrasings that creep toward "any descendant in a non-terminal state"):

  > We suppress upward notification of a waiting agent when that agent has work in flight. "Work in flight" means one of:
  > 1. **Direct background shell** — the agent's own tmux footer shows `⏵⏵.*·\s\d+\s` (e.g., `⏵⏵ accept edits on · 1 shell`), OR
  > 2. **Direct active child** — the agent has at least one immediate child (`meta.manager === parentId`) whose `meta.state === "running"` OR which is within the `isRecentlyCreated` grace period (i.e., still `creating`).
  >
  > "Transitive" suppression is bounded to this one-level walk. We do NOT recurse into grandchildren to determine a parent's suppression status; the `running`/`creating` check on direct children is sufficient because each layer's watchdog independently applies this guard. If a grandchild is running, the child-manager will have its own direct active child and suppress its own notification; that upward silence propagates naturally without the parent ever needing to look past its immediate children. Critically, `waiting` and `complete` children are **not** "work in flight" — the top of a parked chain must still be told, and `complete` children need user merge/kill.

### 7.3 Out-of-scope / explicitly unfixed

Called out so the user (and any future reader) knows these remain after this change ships:

- **Complete-branch transitive notifications — explicitly unfixed.** After this change lands, the following bug class STILL misbehaves: a manager agent spawns children, signals `I HAVE COMPLETED THE GOAL` while children are still `running`. The stop hook's `complete` branch (src/hooks/agent-status.ts:162-170) notifies the grandparent because `findUnfinishedChildren` is only consulted in the no-manager path. The watchdog's `handleComplete` (src/watchdog.ts:339-353) similarly notifies the grandparent once. This is the same bug class as Case 2 shifted to `complete`. It is **not** fixed by this plan. Users will continue to see `[hook]: Your subtask <id> just completed` and `[watchdog]: … recently completed` for managers that completed prematurely. File a follow-up ticket; it is a similar shape fix (reuse `hasActiveChildren`) but is outside the reported bug scope.
- **Agents that signal `I HAVE COMPLETED THE GOAL` with a background shell still running**: the state resolver override only fires for `meta.state === "waiting"`. An agent that wrote `complete` while a background shell lingers will show as `complete` in the TUI and notify upward. Arguably a user error (the agent should not have signed off), and arguably something the stop hook `complete` branch should catch — but this plan does not address it.
- **`handleUnknown` path** (`src/watchdog.ts:280-304`): in practice `unknown` should not occur anymore (§8.5 removal note says `unknown` → `running` fallback with deterministic state). Leave as-is.
- **Dashboard / info panel hint**: consider adding an info-panel line "Active children: N" or "1 bg shell — notifications suppressed" when the Case 1/2 suppression fires, so the user can tell *why* a parent is quiet. Purely cosmetic; out of scope for this behavioral fix.

None of these unfixed items reintroduce the reported bug — they are separate, adjacent issues the user may want to follow up on.

---

## 8. References (file:line)

- `src/agents.ts:124-139` — `writeAgentState`
- `src/agents.ts:161-166` — `isCompacting`
- `src/agents.ts:172-185` — `isRateLimited`
- `src/agents.ts:191-196` — `hasBackgroundTasks` (only consumer today: `src/hooks/agent-status.ts:123`)
- `src/agents.ts:583-629` — `detectAgentStates`
- `src/hooks/agent-status.ts:43-58` — `detectStateFromMessage`
- `src/hooks/agent-status.ts:66-207` — `processStopHook` (the full decision table)
- `src/hooks/agent-status.ts:104-127` — `running` branch with existing background-shell guard
- `src/hooks/agent-status.ts:133-189` — `complete` branch
- `src/hooks/agent-status.ts:191-203` — `waiting` branch (the Case 1 and Case 2 gap)
- `src/hooks/agent-status.ts:275-348` — `findUnfinishedChildren` (reusable model for `hasActiveChildren`)
- `src/hooks/agent-status.ts:466-498` — `notify_manager` tmux send
- `src/parse-state.ts:141` — legacy `WAITING` rule
- `src/parse-state.ts:199-201` — legacy background-tasks rule (after WAITING — known to lose)
- `src/watchdog.ts:254-273` — `handleWaiting` (the Case 1/2 gap on the watchdog side)
- `src/watchdog.ts:339-353` — `handleComplete` (listed as follow-up)
- `src/watchdog.ts:471-510` — `processAgents` (how handlers are dispatched, counters reset)
- `src/watchdog.ts:645-653` — `resolveWatchdogState`
- `src/watchdog.ts:834-850` — `loadAllAgentsForNotification`
- `src/tui/color-scheme.ts:29-35` — state colors (no change needed under Option G)
- `SPEC.md:670-699` — stop-hook spec
- `SPEC.md:997-1031` — watchdog spec

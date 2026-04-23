# Background Shell & Active-Children State Tracking — Plan

> Location note: This repo's existing planning docs live at repo root (`PLAN.md`, `AGENT-TYPES-PLAN.md`, `SPAWNER-TRACKING-PLAN.md`). The task requested `docs/plans/background-shell-state.md`, but since there is no `docs/plans/` tree and in-progress plans follow the repo-root convention, this doc is placed at `BACKGROUND-SHELL-STATE-PLAN.md`.

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
| **Stop hook, `complete` branch** | `findUnfinishedChildren()` is called, but **only** in the `no-manager` path. If manager exists, notifies manager without checking. | ❌ Inverted logic for Case 2: a manager that signals complete while children are mid-work should not be reported up until children settle. (Related but separate from the notification-suppression ask; flag for discussion.) |
| **`detectAgentStates()`** | Considers only the agent's own tmux + meta.json. | ❌ No visibility into child state. |
| **Watchdog `resolveWatchdogState`** | Per-agent watchdog only reads the focal agent. `loadAllAgentsForNotification` fetches all agents but only for the notification-target lookup. | ❌ Children information is available but not consulted for state resolution. |
| **Watchdog `handleWaiting`** | Receives `allAgents` as its third arg, so children are reachable via `agent.children`, but it never walks them. | ❌ Cheap to add: iterate `agent.children` (already built by `buildAgentTree`) and short-circuit notification when any child is in a non-terminal state. |

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

- Case 1 gets **both** a state-resolution override (so TUI/watchdog see `running`) **and** a notifier guard in the stop hook (because the stop hook writes before the resolver ever runs).
- Case 2 gets **only** a notifier guard (stop hook `waiting` branch + watchdog `handleWaiting`). It does not rewrite state, because the parent really is waiting; we just suppress the upward notification.

**Scope non-goal:** `handleComplete` in the watchdog (and the complete-branch of the stop hook, when a manager exists) has a similar "child still busy" smell but is outside the reported problem. It's listed in §7 as an optional follow-up so it isn't accidentally bundled into this change.

---

## 7. Implementation Checklist

### 7.1 Code changes

Ordered. Each bullet is one commit-scoped unit; test changes go with their code.

1. **Extract a shared predicate** `hasActiveChildren(agentId: string, agentsDir: string, opts?) → Promise<boolean>` in `src/hooks/agent-status.ts` (near `findUnfinishedChildren`), or factor out a lighter sibling that returns a boolean instead of a list. Predicate: any child with `meta.manager === agentId`, not archived, with `meta.state ∈ {"running", "waiting", "complete"}` AND tmux session exists, OR `isRecentlyCreated`. Mirror the existing `findUnfinishedChildren` logic.
   - New unit tests in `src/hooks/agent-status.test.ts`.

2. **Stop hook `waiting` branch** — `src/hooks/agent-status.ts:191-203`:
   - Read tmux output (same pattern as the existing `running` branch at lines 107-122, with the same `captureOutput` opts injection).
   - If `hasBackgroundTasks(tmuxOutput)` → return `{ state, action: "none" }`.
   - Else if `await hasActiveChildren(agentId, agentsDir)` → return `{ state, action: "none" }`.
   - Else fall through to existing `notify_manager`.
   - Add `opts.getChildState` pass-through for `hasActiveChildren` the same way `findUnfinishedChildren` uses it.
   - Tests in `src/hooks/agent-status.test.ts`:
     - `waiting + background shell → action "none"`.
     - `waiting + active child (running) → action "none"`.
     - `waiting + active child (waiting) → action "none"` (transitive — a parked child is still work in flight; see design note below).
     - `waiting + only stopped children → action "notify_manager"` (regression).
     - `waiting + no tmux output (null) → action "notify_manager"` (fail-open for tmux gone).

   > Design note on "child in waiting counts as work in flight": adopting this transitively means a chain of agents all parked at WAITING will suppress notifications up the chain indefinitely. This is correct behavior — if no one has work in flight, the *leaf* waiting agent will notify its manager, who will then propagate up naturally as it's told about the child. Each layer's notification is driven by its own child activity, not the leaf.

3. **Watchdog `handleWaiting`** — `src/watchdog.ts:254-273`:
   - Before the existing threshold check, capture tmux output (already done earlier in the loop — thread it through, or add a `captureTmuxOutput` call here).
   - Compute `bgActive = hasBackgroundTasks(output)` and `childActive = anyChildNonTerminal(agent, allAgents)`.
   - If either is true, skip the `notifyManager`/`notifySpawner` calls and also **do not reset/advance `waitCounter`** (so that if the condition clears, the next tick notifies immediately if it's past the threshold; or alternatively clamp `waitCounter` to `notifyInterval - 1`). Decision: skip advance, so counter pauses. This is consistent with the "the agent isn't actually idle" framing.
   - New local helper `anyChildNonTerminal(agent, allAgents)` that walks `agent.children` (one level) and returns `true` if any child has `state ∈ {running, creating, compacting, rate_limited}`. Note: tree is built in `processAgents` via `buildAgentTree()` — verify `agent.children` is populated at this point. Per `watcher.ts:223`, yes: `pollStates()` calls `buildAgentTree` before `onUpdate`. Per-agent watchdog path: `loadAllAgentsForNotification` does NOT call `buildAgentTree` — need to add that call there (`src/watchdog.ts:834-850`), OR walk `allAgents` flat-filtering on `meta.manager === agent.id`. Flat filter is simpler and more robust.
   - Tests in `src/watchdog.test.ts`:
     - `handleWaiting` with background-shell tmux output → no notification.
     - `handleWaiting` with one active child in `allAgents` → no notification.
     - `handleWaiting` with only stopped/complete children → notification fires.
     - `handleWaiting` across multiple backoff cycles — counter does not advance while suppressed.

4. **State-resolver override (Case 1 only)** — add to both:
   - `detectAgentStates()` in `src/agents.ts:583-629`: after the `isRateLimited(output)` check, add `if (agent.meta.state === "waiting" && hasBackgroundTasks(output)) { agent.state = "running"; return; }`.
   - `resolveWatchdogState()` in `src/watchdog.ts:645-653`: same check, mirrored.
   - Tests in `src/agents.test.ts` + `src/watchdog.test.ts`:
     - `meta.state = "waiting"`, tmux has background shell → resolved state = `running`.
     - `meta.state = "waiting"`, tmux without shell → `waiting`.
     - `meta.state = "complete"`, tmux has background shell → `complete` (not overridden).
     - `meta.state = "running"`, tmux has background shell → `running` (no change).

5. **Update `loadAllAgentsForNotification` (if flat-filter isn't chosen for step 3)** — `src/watchdog.ts:834-850`: call `buildAgentTree(agents)` on the returned list so `agent.children` is populated before `handleWaiting` is invoked. Otherwise, document the flat-filter choice with a comment.

### 7.2 SPEC.md updates

- **§1.3 State Detection Flow** (around line 85-99): add step 3.5 "If `meta.state === 'waiting'` and tmux shows `⏵⏵.*·\s\d+\s` (background shells) → `running`."
- **§6.2 Stop Hook Actions table** (around line 684-693): add rows:
  - `waiting | Background tasks active | No action (agent is working via background tasks)`
  - `waiting | Has active children (non-terminal: running/waiting/complete/creating) | No action (children still working)`
  - `waiting | Has manager, no background tasks, no active children | Notify manager (existing)`
- **§8.5 Watchdog Monitoring Behaviors table** (around line 1014-1021): update the `waiting` row to: "Increment waiting counter unless (a) tmux shows background shells OR (b) agent has non-terminal children — in which case suppress notification and pause counter. Otherwise existing backoff."
- Add a short subsection "8.5.x Work-in-flight suppression" explaining the invariant: we never upward-notify a manager about a child that is directly (background shell) or transitively (via grandchildren) doing work.

### 7.3 Out-of-scope / follow-ups

Listed so a future agent knows these exist but aren't part of this change:

- Complete-branch symmetry: same guard for `state === "complete"` in stop hook + watchdog `handleComplete`. Would need a story for agents that genuinely completed while a leftover background shell (zombie) still lingers.
- Cross-repo spawner notifications (`notifySpawner`) get the same guard by construction (they're called right next to `notifyManager`); called out in tests.
- `handleUnknown` path: in practice `unknown` should not occur anymore (§8.5 removal note). Leave as-is.
- Dashboard: consider an info-panel line "Active children: N" or "1 bg shell" when the state override fires, so the suppression is visible to the user. Purely cosmetic.

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

# SPEC: Codex CLI as an alternative agent model

Status: **DRAFT — design.** Phase 0 IMPLEMENTED + merged. Phases 1–7 pending.
Branch: `agent/codex-agent`. Author: codex-agent (manager). Last updated: 2026-05-30 (consolidated rewrite after research + design rounds).
Companion docs (supporting evidence, do not duplicate here):
- `SETTINGS-HOOKS-RESEARCH.md` — authoritative Claude vs Codex settings/hooks reference (every claim evidence-tagged).
- `MODEL-NAME-FORMAT-PROPOSAL.md` — design proposal that drove the §5.1 + Phase 1 design.
- `CODEX-CLI-NOTES.md` — raw research notes + binary facts.

> This SPEC governs adding OpenAI's **Codex CLI** (`codex`, v0.135.0) as a per-agent
> alternative to the `claude` CLI. It MUST be read alongside the project `SPEC.md`
> and the Cross-Cutting Review Checklist in `CLAUDE.md` (agent functionality, hooks,
> watchdog, `ib watch`). Every phase ends in a verifiable acceptance gate
> (`bun test` + `bunx tsc --noEmit` green).
>
> **Process rule:** any exploratory agent that surfaces a load-bearing finding
> triggers a SPEC update before the next implementation phase starts. Supporting
> docs (research, proposals, notes) are evidence-only; this SPEC is the single
> design source of truth.

---

## 1. Summary & goal

A user selects an agent's CLI explicitly via a **`<cli>:<model>`** model string
(e.g. `claude:opus`, `claude:claude-opus-4-7`, `codex:gpt-5.1-codex`,
`codex:o3-mini`). itsybitsy parses the prefix to choose the underlying CLI —
**no inference**, no hidden model→CLI guessing table. A codex agent launches the
**interactive `codex` TUI inside tmux** — exactly the way `claude` agents are
launched today — instead of `claude`. The agent's permissions are enforced by a
**generated PreToolUse hook script** translating the existing agent-type `.md`
permission lists, configured **deny-by-default** so the agent **never shows an
approval prompt** and runs unattended in tmux.

Non-goals (this SPEC): no headless/`codex exec` agent loop; no new dashboard
panes; no multi-provider abstraction beyond claude|codex; no change to Claude
agents' core launch behavior (other than the `<cli>:<model>` parse).

---

## 2. Authoritative decisions (from the user)

| # | Decision | Status |
|---|---|---|
| D1 | **`<cli>:<model>`** is the model string. The CLI is NAMED, not inferred. `claude:` and `codex:` prefixes are **required**. Bare names (`opus`, `o3`) are **rejected** as invalid. | NEW (2026-05-30) — supersedes the original "model name implies CLI" wording. |
| D2 | Codex agents launch **headed/interactive in tmux**, like Claude — NOT `codex exec`. Preserves `C` (open-in-Ghostty → live interactive session). | Unchanged. |
| D3 | **Reuse the same agent-type permission lists** (`_all.md` / `_non_coordinator.md` / `<type>.md`). Translate `allow`/`deny` into a generated PreToolUse hook script on the codex side (no `permissions.allow/deny` array equivalent in codex). | Refined (was "translate to Codex hook rules"; the research confirmed the only path is a generated script). |
| D4 | **Auto-deny anything not granted by a hook; never prompt.** Codex runs unattended in tmux and must never surface an approval modal. | Unchanged. |
| D5 | **No backwards compatibility, no migration.** Existing meta.json / config files with bare names are invalid under the new format; user (sole user) fixes them by hand. | NEW (2026-05-30). |
| D6 | **Unknown CLI = hard-reject at spawn** with a clear message ("Unknown CLI '<X>' in model '<X>:<model>'; known: claude, codex"). No silent fallback. | NEW (2026-05-30). |
| D7 | Scope = SPEC + phased implementation, verified incrementally. Phase 0 already merged. | Updated. |
| D8 | **Display the canonical `<cli>:<model>` form everywhere.** Dashboard info-panel, agent-tree column, anywhere the model is shown. Under D1/D5 all stored values are already qualified — UI just renders them verbatim. | NEW (2026-05-30). |
| D9 | **Every agent-type's `.md` frontmatter may set `model:`** (qualified `<cli>:<model>` form). Applies to all types: `system.md` (system coordinator), `coordinator.md` (per-repo coordinator), `manager.md`, `worker.md`, plus any user-defined types. Coordinators are NOT claude-only — they can be set to a codex model via their agent-type frontmatter. | NEW (2026-05-30). |

---

## 3. Confirmed Codex capability mapping (v0.135.0)

Authoritative reference: `SETTINGS-HOOKS-RESEARCH.md` (every claim evidence-tagged). Load-bearing facts that drive this SPEC:

### 3.1 What works as we hoped
- **Sub-models:** `codex -m <MODEL>` selects the model. `-m` is **free-form / server-validated** — codex does NOT enumerate model names at the CLI. [research §B5]
- **Interactive launch:** bare `codex [OPTIONS] [PROMPT]` runs the interactive TUI; positional prompt seeds the session, like `claude "<prompt>"`. [research §B5]
- **Hook events match Claude:** `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, `SubagentStart`, `SubagentStop`. [research §B2/B3]
- **PreToolUse JSON contract ≈ Claude:** identical `hookSpecificOutput.{permissionDecision, permissionDecisionReason}` shape; one field renamed (`modifiedToolInput` → `updatedInput`); exit code 2 = block on both. [research §B3, §C]
- **Never-prompt:** `-a never` = "Never ask for user approval; execution failures are immediately returned to the model." [research §B5] Combined with deny-by-default PreToolUse = D4.
- **Per-worktree isolation works.** A `<worktree>/.codex/config.toml` is loaded if `[projects."<abs path>"].trust_level = "trusted"` is set in `~/.codex/config.toml`. **No `CODEX_HOME` relocation needed.** [research §B1] This is the chosen isolation strategy; `CODEX_HOME` is a documented fallback only.
- **Native session-start instructions:** Codex reads `AGENTS.md` in the worktree natively. [research §C] Replaces inline session-start injection.

### 3.2 Real gaps we must work around
- **`apply_patch` does NOT fire PreToolUse hooks** (open issue openai/codex#16732). [research §B3] ⇒ Hooks gate Bash but not file edits. The OS **sandbox** (`-s workspace-write`) is the real boundary for file edits.
- **No `permissions.allow/deny` array equivalent** in codex; no `--allowedTools`/`--disallowedTools` CLI flags. [research §C "Where there is NO clean equivalent"] ⇒ We MUST translate the agent-type allow/deny lists into a **generated PreToolUse hook script** (Bash or similar) executed per tool call. This is the only path.
- **`Task` interception is irrelevant** — codex has no `Task` tool. The equivalent is the `SubagentStart` event (documented but not yet battle-tested per issues #14754/#18888). [research §C] ⇒ `intercept-task` is a no-op on codex; gate sub-agent spawning via `SubagentStart` if/when needed.
- **No system-prompt CLI flag** (no `--append-system-prompt`). [research §C] ⇒ Use the worktree `AGENTS.md` instead.
- **`-a never` is "never PROMPT", not "deny everything by default."** Without our PreToolUse hook a command would be ALLOWED (subject to sandbox); with the hook returning deny-by-default, denied commands return to the model rather than escalating to a human. The hook is what makes D4 true.
- **Hash-pinned hook trust.** Codex hashes every hook command; any edit invalidates trust and the hook is **silently skipped** until re-trusted. [research §B4] ⇒ itsybitsy MUST pass `--dangerously-bypass-hook-trust` on every spawn (our hook source is first-party and vetted). Without it, regenerating the hook silently disables it — a permission-bypass disaster.
- **No hot-reload.** Codex config + hooks require a fresh session to pick up edits (Claude reloads `permissions`/`hooks` live). [research §C] ⇒ Mutations require respawn.
- **Permission model is 2D.** Codex: `-a {untrusted|on-request|never} × -s {read-only|workspace-write|danger-full-access}`. Claude: 1D `--permission-mode`. [research §C] ⇒ Map our equivalent of `acceptEdits` to **`-a never -s workspace-write`**.
- **No `.local`-style override file.** No `.codex/config.local.toml`. [research §B1] ⇒ Either gitignore the per-worktree `.codex/config.toml`, or accept that it's in-repo. We will gitignore it (it's per-agent, ephemeral, agent-specific).
- **PreToolUse is not airtight** (OpenAI's own caveat — model may route around a blocked tool via another path). [research §B3] ⇒ Sandbox is the real boundary; hooks are policy + logging — same posture as Claude.

### 3.3 Canonical codex launch line (target)

```
codex -m <MODEL> -a never -s workspace-write \
      -C <worktree> \
      --dangerously-bypass-hook-trust \
      "<prompt>"
```

Where `<MODEL>` is the **model half** of the parsed `<cli>:<model>` (the `codex:` prefix is stripped). The per-worktree `<worktree>/.codex/config.toml` (written at spawn time) supplies the `[hooks]` block + any other config. `--dangerously-bypass-hook-trust` is **mandatory on every invocation** because the generated hook script's hash changes every spawn.

`~/.codex/config.toml` must have `[projects."<abs worktree path>"].trust_level = "trusted"` for the project layer to load. This is set once during the worktree setup.

---

## 4. itsybitsy seams (verified file anchors)

| Seam | Location | Notes |
|------|----------|-------|
| AgentMeta type | `src/agents.ts:49` | `model: string` at :60; `session_id` at :51; **`codex_session_id?: string`** added in Phase 0 for codex resume. No `cli` field (parsed on demand per D1). |
| Model default | `src/config.ts:24` (`model` default `"opus"`); coordinator `:32` | Both defaults become **invalid** under D1/D5 — must be re-spelled to `"claude:opus"` in Phase 1. |
| Model precedence | `src/ib-commands.ts:2551–2552` (`--model > type.model > config.model > 'opus'`) | Default literal updated to `"claude:opus"` in Phase 1. |
| isValidModel | `src/validation.ts:7–9` allowlist `^[a-zA-Z0-9._-]+$` | **Must widen** to `^[a-zA-Z0-9._:-]+$` in Phase 1 — without this, every qualified model is rejected. This is the one load-bearing one-character change. |
| VALID_MODELS allowlists | `src/config-command.ts:6` (`["sonnet","opus","haiku"]`), `src/hooks/intercept-task.ts:24` (same set + `""`) | Replace with `parseModel + KNOWN_CLIS` validation (must accept any `<known-cli>:<model>`). |
| session UUID | `src/ib-commands.ts:2723` `crypto.randomUUID()`; stored `:2781` `session_id` | Codex has its own rollout-id model; capture into `codex_session_id` after first launch. |
| Spawn `claude` cmd | `src/ib-commands.ts` `newAgent()` — `claudeArgs` built `2989–3010`; generated `start.sh` written from `:3072`; launch lines **`3111`/`3113`** (`setsid claude --session-id … "$(cat promptfile)"` / bare `claude --session-id …`); `CLAUDE_PID=$!` at `:3115`; SIGHUP `trap '' HUP` at `:3091` | **Branch point for codex launch.** Pass `parseModel(model).model` (NOT the raw `<cli>:<model>`) to `--model`. |
| Resume `claude` cmd | `src/ib-commands.ts` `resumeAgent()` — args ~587–590, `resume.sh` written 619–709, `claude --resume …` launch lines ~663/665, SIGHUP-ignore insulation 635–644 | Codex resume differs: `codex resume <id>` via `codex_session_id` (not `claude --resume <uuid>`). |
| Hook reg + perms | `src/settings-builder.ts` + `buildAgentSettings()` in `ib-commands.ts` (~2163–2267); writes `settings.local.json` (`hooks` block + `permissions.allow/deny`) | Codex needs a parallel writer for `<worktree>/.codex/config.toml` + a generated PreToolUse hook script (no `permissions.allow/deny` equivalent on codex). |
| Permission `.md` merge | `src/agent-types.ts` (`_all.md`, `_non_coordinator.md`, `<type>.md`) | Shared source of truth; consumed by both writers. |
| Hook dispatch | `src/index.ts` routes `hook-check-path` / `hook-status` / `hooks intercept-task` / `hooks session-start` → `src/hooks/*.ts` | Add codex-shaped subcommands. |
| State detection | `detectAgentStates()` in `src/agents.ts` + `src/parse-state.ts` | **Claude-UI-specific** — branch on parsed cli. Prefer codex `SessionStart`/`Stop` hooks writing state deterministically over TUI scraping. |
| Watchdog | `src/watchdog.ts` `runPerAgentWatchdog` | Rate-limit bare-Enter / permission auto-accept / nudges assume Claude UI; codex needs its own signatures. |
| Ghostty attach | `src/ghostty.ts` `openInGhostty(tmuxSession)` | CLI-agnostic (attaches tmux) — "just works" for D2 once codex runs in tmux. |
| Info-panel rendering | `src/tui/info-panel.ts:120` (`Model: ${meta.model}`) and `src/tui/agent-tree.ts:64,93` | Render the raw model string verbatim (e.g. `claude:opus`); no special split required. |
| Config-dialog model edit | `src/tui/dialog-handler.ts:480–499` | Becomes a `select` dialog seeded with the §6.2 default set + "Custom…" entry. Cosmetic; defer to a later phase if needed. |

---

## 5. Design

### 5.1 Model string format & parsing (D1, D5, D6)

The model string is **always** `<cli>:<model>`. Bare names are rejected.

**Grammar:**
```
model-string := cli ":" model-rest
cli          := [A-Za-z][A-Za-z0-9-]*        ; alphanumeric+dash, must start with a letter
model-rest   := <everything after the FIRST ":">  ; greedy to end; preserved verbatim
```

- Split on the **first** colon, model is greedy-to-end. So `claude:claude-opus-4-7` → `{cli:"claude", model:"claude-opus-4-7"}`. Greedy-to-end is safe because no current claude/codex model id contains a colon.
- The `cli` half is compared **case-insensitive**, whitespace-trimmed, against `KNOWN_CLIS`. The `model` half is preserved verbatim (preserves case for `claude --model`).

**New module surface (`src/agent-cli.ts`):**
```ts
export type AgentCli = "claude" | "codex";
export const KNOWN_CLIS = new Set<AgentCli>(["claude", "codex"]);

export interface ParsedModel { cli: AgentCli; model: string; }

/** Parse "<cli>:<model>". Throws if missing colon, malformed, or unknown cli. */
export function parseModel(input: string): ParsedModel;

/** Thin wrapper kept for back-compat callers. Equivalent to parseModel(model).cli. */
export function resolveCli(model: string): AgentCli;
```

**Validation order at spawn:**
1. `isValidModel(input)` — shell-safety syntactic check (widened to allow `:`).
2. `parseModel(input)` — throws on missing/wrong colon, malformed cli, or unknown cli (D6: hard-reject).
3. Pass `parseModel(input).model` (the model half) to the CLI flag; branch the launch on `parseModel(input).cli`.

**What Phase 0's code becomes:**
- `CODEX_MODELS`, `CODEX_MODEL_PREFIXES`, boundary-aware prefix matching → **DELETED**. No more inference.
- `resolveCli` → thin wrapper over `parseModel`.
- `isCodexModel(m)` → `parseModel(m).cli === "codex"` (kept for callers; no callers outside the tests today).

### 5.2 No new meta field for CLI; one new field for resume
- `model` stays the discriminator. `parseModel(meta.model).cli` is computed on demand.
- **`codex_session_id?: string`** (already added in Phase 0) on `AgentMeta`. Populated after first codex launch (captured from codex's rollout output / `~/.codex` state) for `codex resume`. `session_id` (the generated UUID) remains for claude.

### 5.3 Spawn (D2 + D4)

In `newAgent()`, branch the generated `start.sh` on `parseModel(model).cli`:
- **claude:** unchanged (except the model passed to `--model` is the parsed model half, not the raw `claude:opus`).
- **codex:** generate a `start.sh` that launches the canonical line from §3.3 in tmux (same `setsid … &` + `wait` skeleton, same pid-file capture). Store the codex PID in `claude.pid` for back-compat with the watchdog (or generalize to `agent.pid` with a back-compat read — decided in Phase 4).

Permission mapping reference (for claude callers translating intent):
| Claude `--permission-mode` | Codex equivalent |
|---|---|
| `acceptEdits` | `-a never -s workspace-write` ← itsybitsy default for codex agents |
| `plan` | `-a untrusted -s read-only` |
| `bypassPermissions` / `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` (aka `--yolo`) |

### 5.4 Permissions → generated PreToolUse hook script (D3 + D4)

Codex has no `permissions.allow/deny` array, no `--allowedTools` flag. The ONLY way to express our agent-type allow/deny lists is a **generated PreToolUse hook script** invoked per tool call.

At spawn (Phase 3), `buildCodexConfig()`:
1. Reads the SAME merged allow/deny lists (`_all.md` + `_non_coordinator.md` + `<type>.md`).
2. Writes `<worktree>/.codex/config.toml` containing:
   - `model = "<parsed model half>"`
   - `approval_policy = "never"`
   - `sandbox_mode = "workspace-write"`
   - `[[hooks.PreToolUse]]` registering a generated hook script under `<worktree>/.codex/hooks/pre-tool-use.sh` (or similar).
   - Optionally additional `[[hooks.SessionStart]]` / `[[hooks.Stop]]` for state-detection (§5.6).
3. Writes a generated `<worktree>/.codex/hooks/pre-tool-use.sh` script that reads the codex stdin JSON, matches `tool_name` + `tool_input.command` against the merged allow/deny lists, and prints the deny-by-default JSON contract.
   - Alternative: have the script call `ib hooks codex-pre-tool-use <agentId>` and put the matching logic in TypeScript (`src/hooks/codex-pre-tool-use.ts`) — preferred for consistency with the existing claude hooks. The script then is a one-liner.
4. Adds `[projects."<abs worktree path>"].trust_level = "trusted"` to `~/.codex/config.toml` (once per worktree) so the project layer loads. **This is the one cross-worktree write** we make; required by the codex trust model.
5. Adds `.codex/` to the worktree's `.gitignore` (no `.local`-style file exists in codex).
6. Writes a per-agent `<worktree>/AGENTS.md` containing the role/session-start instructions (replaces what `session-start.ts` injects for Claude).

**Trust:** `--dangerously-bypass-hook-trust` is passed on **every** spawn (hash-pinned trust requires this; see §3.2).

**Defense in depth:** the `workspace-write` sandbox is the real boundary for `apply_patch` edits (which don't fire PreToolUse hooks); hooks gate Bash + MCP calls.

### 5.5 Codex PreToolUse hook handler (D3 + D4)

New `src/hooks/codex-pre-tool-use.ts`, dispatched from `src/index.ts`:
- Reads codex's stdin JSON (`tool_name`, `tool_input.command`, `cwd`, `session_id`, …).
- Applies the same allow/deny matching used for Claude (reuse the matcher logic, not a fork of the rules — share with `intercept-task` / `agent-path` as a library function).
- Emits codex's stdout contract: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny","permissionDecisionReason":…}}`. **Default = deny.**
- Also covers path isolation (the codex analog of `agent-path`/`main-path`) so codex agents stay in their worktree. (Caveat: `.git`, `.codex`, `.agents` are already OS-enforced read-only under `workspace-write` per research §B5.)

`intercept-task` does **not** need a codex equivalent — codex has no `Task` tool. If/when we need to gate codex sub-agent spawning, use the `SubagentStart` event.

### 5.6 State detection (the hard part)

`parse-state.ts` greps Claude's TUI strings; codex's TUI differs. Two complementary tactics:
1. **Hook-driven state writes (preferred, deterministic):** wire codex's `SessionStart` → `running`, `Stop` → `waiting`/`complete`, mirroring the Phase-42 deterministic flow (`ib hook-status` writes `state` to meta.json via `writeAgentState()`). Avoids brittle screen-scraping. The native `AGENTS.md` instructions can even tell the agent to emit specific markers if needed.
2. **Codex tmux overrides:** a small `parse-state-codex.ts` (or codex branch) for the override states the hooks can't capture (rate-limited, api_error, compacting) by matching codex's actual UI strings (gathered empirically in Phase 5 — formerly Phase 4).

`detectAgentStates()` branches on `parseModel(meta.model).cli` to pick the codex path.

### 5.7 Watchdog

`runPerAgentWatchdog` branches on cli:
- Drop/disable Claude-only behaviors that don't apply (permission auto-accept is unnecessary — `-a never` + hooks already prevent prompts).
- Re-derive idle/nudge and rate-limit signatures from codex's UI/output (Phase 6 — formerly Phase 5).
- Per-agent outbox delivery, fs.watch drains, and `runSessionExclusive` mutex are CLI-agnostic and stay.

### 5.8 Resume + lifecycle

- `resumeAgent()` branches: codex uses its session/rollout id (`codex resume <id>` / `--last`) read from `codex_session_id`. The `resume.sh` template is regenerated branched on cli.
- kill / merge / diff / nuke are git- and tmux-level → unaffected.
- `openInGhostty` is tmux-level → unaffected (D2 satisfied for free).

---

## 6. Phased plan (each phase has an acceptance gate)

Every phase MUST end green on `bun test` + `bunx tsc --noEmit` before the next begins.

### Phase 0 — Model→CLI resolver + meta plumbing ✅ MERGED
Status: complete on `agent/codex-agent` (commits `ed91375` + `d59f171`).
- `src/agent-cli.ts` created with `AgentCli`, `resolveCli`, `isCodexModel`, plus the (now-obsolete) `CODEX_MODELS` set + prefix matching.
- `codex_session_id?: string` added to `AgentMeta` (`src/agents.ts:49`).
- `resolveCli` wired at the model-precedence seam (`ib-commands.ts:~2579`) — no behavior change yet (claude spawn byte-identical).
- **Note:** Phase 1 below will delete the `CODEX_MODELS`/prefix machinery this phase introduced and replace it with explicit parsing. That code was correct under the original D1 wording but is superseded by the new D1 (explicit prefix required).

### Phase 1 — Explicit `<cli>:<model>` format (the new D1) 🆕
**Goal:** replace bare-name routing with parsed `<cli>:<model>`. No backwards compat (D5); hard-reject unknown cli (D6).

Code that lands (design intent for the implementer):
1. `src/agent-cli.ts`: add `parseModel`, `KNOWN_CLIS`; delete `CODEX_MODELS`/`CODEX_MODEL_PREFIXES`/prefix matching; reduce `resolveCli` to `parseModel(m).cli`; re-base `isCodexModel` on the parsed cli.
2. `src/validation.ts:7`: widen `isValidModel` to allow `:` (`^[a-zA-Z0-9._:-]+$`). **One-line, load-bearing.**
3. `src/config.ts:24,32`: change `model` and `coordinator.model` defaults from `"opus"` to `"claude:opus"`.
4. `src/ib-commands.ts`:
   - At the spawn (`~3010–3012`) and resume (`~587–590`) seams, pass `parseModel(model).model` to `--model` (not the raw string).
   - After `isValidModel` (`:2570`) add a `parseModel`-throws check → spawn rejects with the D6 message on unknown cli.
   - Store the **raw** input string in meta (`:2800`, unchanged) so meta is human-readable / round-trippable.
5. `src/coordinator.ts:419–436`: parse `coordinator.model`; pass the model half to `--model`; branch the launch on the parsed cli (per D9 — coordinators are NOT claude-only; any `<cli>:<model>` is valid). Full codex-coordinator wiring lands in Phases 3–7 alongside regular codex agents.
6. `src/agent-types.ts`: confirm the existing `model?: string` frontmatter field accepts the qualified form; merge logic at agent-creation time uses `parseModel` for validation, just like CLI/config inputs. Applies to `system.md`, `coordinator.md`, `manager.md`, `worker.md`, and any user-defined types (per D9).
7. `src/config-command.ts:6,74–78`: replace the hard-coded `VALID_MODELS` allowlist with `parseModel + KNOWN_CLIS` validation.
8. `src/hooks/intercept-task.ts:24,269–304`: same — accept any qualified `<known-cli>:<model>` string.
9. `src/tui/info-panel.ts:120` + `src/tui/agent-tree.ts:64,93`: render `meta.model` verbatim — per D8, all stored values are already qualified, so no special split required.
10. Rewrite the relevant `src/agent-cli.test.ts` blocks: bare codex names (e.g. `o3`) now must be rejected (not routed to codex); qualified names (`codex:o3`) route to codex. Add `parseModel` tests (split-on-first-colon, greedy model, colon-in-model, malformed cli, unknown cli throws).

**Gate:**
- `bun test` green. Only `src/agent-cli.test.ts` is rewritten (the intentional inversion); every other test stays green.
- `bunx tsc --noEmit` — 0 errors.
- `ib new-agent --model "claude:opus" "task"` spawns identically to today's `--model opus` (assert the generated `start.sh` line for a claude agent is byte-identical to a Phase-0 spawn with `--model opus`, except for the model arg literal).
- `ib new-agent --model "opus" "task"` is **rejected** at spawn with a clear message.
- `ib new-agent --model "gemini:foo" "task"` is **rejected** at spawn with `Unknown CLI 'gemini' in model 'gemini:foo'; known: claude, codex`.
- `parseModel("codex:gpt-5.1-codex")` → `{cli:"codex", model:"gpt-5.1-codex"}` (unit test) — gives Phases 3/4 a deterministic cli.

### Phase 2 — Spike: verify interactive codex + deny semantics (manual)
Unchanged from the prior Phase 1; just renumbered.
- Manually run interactive `codex -m <some-model> -a never -s workspace-write --dangerously-bypass-hook-trust` in a tmux session with a trivial deny-all PreToolUse hook (registered via a throwaway per-worktree `.codex/config.toml` + trust entry).
- **Resolve THE crux:** does a hook `deny` in *interactive* mode block silently (return to model, no modal)? Document the exact working launch line + how the codex session/rollout id is captured for resume + whether the worktree-local hook actually fires (the per-worktree design's load-bearing assumption).
- **Gate:** a written findings note (append to `CODEX-CLI-NOTES.md` AND fold into this SPEC §3) with the verified launch command, no-modal confirmation, session-id capture method, and worktree-hook-fires confirmation. NO code.

### Phase 3 — Codex config / hook writer
- `buildCodexConfig()` writes per-worktree `<worktree>/.codex/config.toml` + generated `<worktree>/.codex/hooks/pre-tool-use.sh` (which calls `ib hooks codex-pre-tool-use <agentId>`) + `<worktree>/AGENTS.md` (session-start instructions). Adds `[projects."<abs>"].trust_level = "trusted"` to `~/.codex/config.toml` once per worktree. Adds `.codex/` to the worktree `.gitignore`. Trust handled by `--dangerously-bypass-hook-trust` on every spawn.
- `src/hooks/codex-pre-tool-use.ts` implements the codex-shaped allow/deny handler emitting the codex JSON contract. Default = deny.
- **Gate:** unit tests asserting (a) generated `config.toml` is valid TOML, (b) the hook script is generated correctly, (c) the handler's allow/deny matches the merged `.md` lists, (d) the codex JSON contract is correct. Manual: `codex` loads the config; an allow-listed cmd runs; a non-listed cmd is denied — no prompt.

### Phase 4 — Spawn path (headed, in tmux)
- Branch `start.sh` assembly in `newAgent()` on `parseModel(model).cli` → launch the canonical line from §3.3. Capture PID + codex session id → meta (`codex_session_id`).
- **Gate:** `ib new-agent --model "codex:<model>" "task"` spawns a codex agent visible in `ib list` / dashboard; `C` opens it in Ghostty as a live interactive session; it performs an allow-listed action; it never prompts. Claude agents unaffected.

### Phase 5 — State detection for codex
- Hook-driven `running`/`waiting`/`complete` writes (§5.6.1) — `SessionStart`/`Stop` hooks call `ib hook-status <agentId>` which writes state to meta.json. Plus a minimal codex-specific tmux-overrides parser (§5.6.2) for rate_limited/api_error/compacting.
- Branch `detectAgentStates()` on parsed cli.
- **Gate:** a codex agent shows correct states through a full task (creating → running → waiting/complete) in the dashboard; overrides (rate_limited / api_error) recognized from real codex output captured in this phase.

### Phase 6 — Watchdog for codex
- CLI-branch `runPerAgentWatchdog`: codex idle/nudge + rate-limit handling; disable inapplicable Claude-only behaviors (permission auto-accept is unnecessary since `-a never` + hooks block prompts).
- **Gate:** a stuck codex agent gets nudged; a simulated rate-limit recovers; no spurious bare-Enter behavior; outbox + state-exclusive mutex still work cross-cli.

### Phase 7 — Resume + lifecycle
- `resumeAgent()` codex branch (`codex resume` via `codex_session_id`); regenerate `resume.sh` branched on cli; confirm kill/merge/diff/nuke unaffected (they're git+tmux-level).
- **Gate:** resume re-attaches the same codex session in tmux; merge of a codex agent's branch works end-to-end.

### Phase 8 — Docs, SPEC.md, tests
- Fold this SPEC into project `SPEC.md`; update `CLAUDE.md` implementation notes; ensure full test coverage; `bunx tsc --noEmit` clean.
- **Gate:** SPEC.md updated; test count increased; CI-green.

---

## 7. Risks / open questions

1. **THE CRUX (Phase 2 gate):** does interactive `codex -a never` + deny hook block silently (no modal)? The whole D4 guarantee rests on this. Still UNVERIFIED.
2. **`apply_patch` doesn't fire PreToolUse hooks** (openai/codex#16732). File edits aren't gated by hooks today — the `-s workspace-write` sandbox is the real boundary. Document this so users don't over-trust the hook for edits. (Bash + MCP calls ARE gated.)
3. **Hash-pinned trust + mandatory bypass.** Every spawn must pass `--dangerously-bypass-hook-trust`; without it our regenerated hook silently disables itself. There is no config-key to pre-trust by hash. Codify in `buildCodexConfig()`.
4. **No hot-reload.** Codex config/hook edits require a fresh session. Mutating an agent's permissions mid-session means killing+respawning, not editing.
5. **`SubagentStart` is documented but not battle-tested** (issues #14754/#18888). If/when we need to gate codex sub-agent spawning, plan to verify it fires reliably before relying on it.
6. **State-detection brittleness.** Prefer hook-driven deterministic state over scraping codex's TUI; treat tmux overrides as a thin supplement. (Phase 5.)
7. **Codex version drift.** All facts pinned to v0.135.0; flags/contracts may change. Add a `codex --version` check + a `codex doctor`-style health note at spawn.
8. **`PermissionRequest` event.** Codex's docs show `permissionDecision: ask` only on `PermissionRequest`, not `PreToolUse` (research §B3 / §C). With `-a never` + deny-by-default our hook returns only allow/deny; we should never see `PermissionRequest`. Verify in Phase 2.
9. **No `--allowedTools` / `--disallowedTools` / `permissions.allow/deny`.** The generated PreToolUse hook script is the only path. (Architecturally fine, but more code than Claude needs.)
10. **`~/.codex/config.toml` trust list grows per worktree.** Each spawn adds one `[projects."<abs>"].trust_level = "trusted"`. This is user-global state; cleanup on agent archive is worth considering (low priority).

---

## 8. Process

- This SPEC is the **single design source of truth**. Supporting docs (`SETTINGS-HOOKS-RESEARCH.md`, `MODEL-NAME-FORMAT-PROPOSAL.md`, `CODEX-CLI-NOTES.md`) are evidence-only.
- **Any exploratory agent that surfaces a load-bearing finding triggers a SPEC update before the next implementation phase starts.** This SPEC was rewritten on 2026-05-30 to fold in the settings/hooks research (commit `d3c6c3d`) and the model-name format proposal (commit `bc88426`). Future research rounds follow the same rule.
- Phase commits land on `agent/codex-agent`; reviewed by 2 worker reviewers (one adversarial) before merge per `CLAUDE.md`.

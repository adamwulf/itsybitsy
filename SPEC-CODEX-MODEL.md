# SPEC: Codex CLI as an alternative agent model

Status: **DRAFT — design only, no implementation.**
Branch: `agent/codex-agent`. Author: codex-agent (manager). Date: 2026-05-30.
Companion scratch notes (raw research + binary facts): `CODEX-CLI-NOTES.md`.

> This SPEC governs adding OpenAI's **Codex CLI** (`codex`, v0.135.0) as a per-agent
> alternative to the `claude` CLI. It MUST be read alongside the project `SPEC.md`
> and the Cross-Cutting Review Checklist in `CLAUDE.md` (agent functionality, hooks,
> watchdog, `ib watch`). Every phase below ends in a verifiable acceptance gate.

---

## 1. Summary & goal

A user selects a **Codex model name** (e.g. `gpt-5-codex`, `o3`) as an agent's `model`.
itsybitsy recognizes it as a Codex model and launches the **interactive `codex` TUI inside
tmux** — exactly the way `claude` agents are launched today — instead of `claude`. The
agent's permissions are enforced by a **PreToolUse hook** translating the existing
agent-type `.md` permission lists, configured **deny-by-default** so the agent **never
shows an approval prompt** and runs unattended in tmux.

Non-goals (this SPEC): no headless/`codex exec` agent loop; no new dashboard panes; no
multi-provider abstraction beyond claude|codex; no change to Claude agents' behavior.

---

## 2. Authoritative decisions (from the user)

| # | Decision |
|---|----------|
| D1 | The selector is the **model name**, NOT a new `cli` field. Codex's own model names become valid `model` values. itsybitsy infers the CLI from the model name. |
| D2 | Codex agents launch **headed/interactive in tmux**, like Claude — NOT `codex exec`. This preserves `C` (open-in-Ghostty → live interactive session). |
| D3 | **Reuse the same agent-type permission lists and hook structure.** Translate `_all.md` / `_non_coordinator.md` / `<type>.md` allow/deny into Codex hook rules. |
| D4 | **Auto-deny anything not granted by a hook; never prompt.** Codex runs unattended in tmux and must never surface an approval modal. |
| D5 | Scope now = SPEC only, phased so we build + verify incrementally. |

---

## 3. Confirmed Codex capability mapping (v0.135.0)

Full evidence in `CODEX-CLI-NOTES.md`. The load-bearing facts:

- **Sub-models:** `codex -m <MODEL>` selects the model → D1 works.
- **Interactive launch:** bare `codex [OPTIONS] [PROMPT]` runs the interactive TUI → D2 works (positional prompt seeds the session, like `claude "<prompt>"`).
- **Hooks ≈ Claude Code:** events `PreToolUse`/`PostToolUse`/`SessionStart`/`UserPromptSubmit`/`Stop`/… declared in `~/.codex/config.toml` as `[[hooks.PreToolUse]]` with `matcher` + `command`. PreToolUse stdout `{"hookSpecificOutput":{"permissionDecision":"allow"|"deny","permissionDecisionReason":…}}` (or exit 2) blocks before execution → D3/D4 work.
- **Never-prompt:** `-a never` (`approval_policy="never"`) ⇒ Codex never escalates to a human; blocked/failed actions return to the model. Combined with a deny-by-default PreToolUse hook = D4.
- **Hook trust:** new/changed local hooks require trust; automation uses `--dangerously-bypass-hook-trust` (or pre-trust once). Codex-only wrinkle vs Claude.
- **Isolation knobs:** `CODEX_HOME` env (relocate config/state home), `-p <profile>`, `-c key=value` (inline TOML), `-C <dir>`, `--add-dir`, `--ignore-user-config`, `--ignore-rules`.
- **Defense in depth:** `-s workspace-write` (OS sandbox) + execpolicy `.rules`. Per OpenAI's own docs PreToolUse is not airtight (model may route around a blocked tool), so the sandbox is the real boundary; hooks are policy/logging — same posture as Claude.

**Canonical codex launch line (target):**
```
codex -m <MODEL> -a never -s workspace-write [hook-config flags] "<prompt>"
```
where `[hook-config flags]` is whichever isolation strategy Phase 2 selects
(per-agent `CODEX_HOME`, or `-p <profile>`, or `-c hooks.…` overrides) plus trust handling.

---

## 4. itsybitsy seams (verified file anchors)

| Seam | Location | Notes |
|------|----------|-------|
| AgentMeta type | `src/agents.ts:49` | `model: string` at :60; `session_id` at :51. **No `cli` field** (per D1, none needed). |
| Model default | `src/config.ts:24` (`model` default `"opus"`); coordinator `:32` | |
| Model precedence | `src/ib-commands.ts:2551–2552` (`--model > type.model > config.model > 'opus'`) | resolver hooks in here |
| session UUID | `src/ib-commands.ts:2723` `crypto.randomUUID()`; stored `:2781` `session_id` | Codex has its own rollout-id model |
| Spawn `claude` cmd | `src/ib-commands.ts` `newAgent()` — `claudeArgs` built `2989–3010`; generated `start.sh` written from `:3072`; launch lines **`3111`/`3113`** (`setsid claude --session-id "<uuid>" … "$(cat promptfile)"` / bare `claude --session-id …`); `CLAUDE_PID=$!` at `:3115`; SIGHUP `trap '' HUP` at `:3091` | **branch point for codex launch** |
| Resume `claude` cmd | `src/ib-commands.ts` `resumeAgent()` — args ~587–590, `resume.sh` written 619–709, `claude --resume "<sid>"` launch lines ~663/665, SIGHUP-ignore insulation 635–644 | codex resume differs (session-id model) |
| Hook reg + perms | `src/settings-builder.ts` + `buildAgentSettings()` in `ib-commands.ts` (~2163–2267); writes `settings.local.json` (`hooks` block + `permissions.allow/deny`) | codex needs a parallel writer for `config.toml` |
| Permission `.md` merge | `src/agent-types.ts` (`_all.md`, `_non_coordinator.md`, `<type>.md`) | shared source of truth |
| Hook dispatch | `src/index.ts` routes `hook-check-path` / `hook-status` / `hooks intercept-task` / `hooks session-start` → `src/hooks/*.ts` | add codex hook subcommand(s) |
| State detection | `detectAgentStates()` in `src/agents.ts` + `src/parse-state.ts` | **Claude-UI-specific** — biggest new piece |
| Watchdog | `src/watchdog.ts` `runPerAgentWatchdog` | rate-limit bare-Enter / permission auto-accept / nudges assume Claude UI |
| Ghostty attach | `src/ghostty.ts` `openInGhostty(tmuxSession)` | CLI-agnostic (attaches tmux) — should "just work" for D2 once codex runs in tmux |

---

## 5. Design

### 5.1 Model → CLI resolution (D1)
New module `src/agent-cli.ts`:
```ts
export type AgentCli = "claude" | "codex";
// Known Codex model names / prefixes; extensible (config-overridable later).
const CODEX_MODELS: ReadonlySet<string> = new Set([ /* gpt-5-codex, o3, o4-mini, … */ ]);
export function resolveCli(model: string): AgentCli { … }   // codex iff model ∈ CODEX_MODELS (or prefix match); else claude
export function isCodexModel(model: string): boolean;
```
- Single source of truth for "which CLI runs this model." Called wherever the launch/resume/state/watchdog code currently assumes claude.
- Claude remains the default for every unknown model (no regression).
- The known-Codex set is editable in code now; a `config.json` override (e.g. `codexModels: string[]`) is a later nicety, not Phase 0.

### 5.2 No new meta field for CLI; one new field for resume
- `model` stays the discriminator (D1). `resolveCli(meta.model)` is computed on demand.
- Codex's session/rollout id ≠ a UUID we generate. Add **`codex_session_id?: string`** to `AgentMeta` (optional, claude agents leave it unset). Populated after first launch (captured from codex's rollout output / `~/.codex` state) for `codex resume`. `session_id` (the generated UUID) remains for claude.

### 5.3 Spawn (D2 + D4)
In `newAgent()`, branch the generated `start.sh` on `resolveCli(model)`:
- **claude:** unchanged.
- **codex:** launch interactive `codex -m <model> -a never -s workspace-write <hook-config> "$(cat promptfile)"` in tmux (same `setsid … &` + `wait` skeleton, same pid-file capture → write to `claude.pid`/a generalized `agent.pid`). `-a never` satisfies "never prompt" (D4).
- The prompt-as-positional-arg works for interactive codex (confirmed in `--help`).
- Keep `claude.pid` semantics (the watchdog reads it) — store the codex PID there, or generalize to `agent.pid` with a back-compat read. Decide in Phase 3.

### 5.4 Permissions → Codex hook config (D3 + D4)
New writer `buildCodexConfig()` (sibling to `settings-builder.ts`):
- Reads the SAME merged allow/deny lists (`_all.md` + `_non_coordinator.md` + `<type>.md`).
- Emits a Codex hook config: `[[hooks.PreToolUse]]` (+ `SessionStart`/`Stop` as needed) pointing `command` at an `ib` subcommand (e.g. `ib hooks codex-pre-tool-use <agentId>`), with **deny-by-default** logic in that handler.
- **Isolation:** prefer a **per-agent `CODEX_HOME`** (e.g. inside the agent dir) so each agent's `config.toml` + rollout state is sandboxed and we never mutate the user's `~/.codex`. (`-p <profile>` or `-c` overrides are fallbacks; chosen in Phase 2.) Note: auth lives in `CODEX_HOME/auth.json` — a per-agent home must still reach valid ChatGPT auth (symlink/copy `auth.json`, or set `CODEX_HOME` to a dir that layers auth). Resolve in Phase 2.
- **Trust:** pre-trust the generated hook once at spawn, or pass `--dangerously-bypass-hook-trust` (our hook source is first-party and vetted). Pick the least-surprising option in Phase 1/2.

### 5.5 Codex PreToolUse hook handler (D3 + D4)
New `src/hooks/codex-pre-tool-use.ts`, dispatched from `src/index.ts`:
- Reads Codex's stdin JSON (`tool_name`, `tool_input.command`, `cwd`, …).
- Applies the same allow/deny matching used for Claude (reuse the matcher logic, not a fork of the rules).
- Emits Codex's stdout contract: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny","permissionDecisionReason":…}}`. **Default = deny.**
- Also covers path isolation (the codex analog of `agent-path`/`main-path`) so codex agents stay in their worktree.

### 5.6 State detection (the hard part)
`parse-state.ts` greps Claude's TUI strings; codex's TUI differs. Two complementary tactics:
1. **Hook-driven state writes (preferred, deterministic):** wire codex's `SessionStart` → `running`, `Stop` → `waiting`/`complete`, mirroring the deterministic model (`ib hook-status` writes `state` to meta.json via `writeAgentState()`). This reuses the Phase-42 deterministic flow and avoids brittle screen-scraping.
2. **Codex tmux overrides:** a small `parse-state-codex.ts` (or codex branch) for the override states the hooks can't capture (rate-limited, api_error, compacting) by matching codex's actual UI strings (gathered empirically in Phase 4).
`detectAgentStates()` branches on `resolveCli(meta.model)` to pick the codex path.

### 5.7 Watchdog
`runPerAgentWatchdog` branches on CLI:
- Drop/disable Claude-only behaviors that don't apply (permission auto-accept is unnecessary — `-a never` + hooks already prevent prompts).
- Re-derive idle/nudge and rate-limit signatures from codex's UI/output (Phase 5).
- Per-agent outbox delivery, fs.watch drains, and `runSessionExclusive` mutex are CLI-agnostic and stay.

### 5.8 Resume + lifecycle
- `resumeAgent()` branches: codex uses its session/rollout id (`codex resume <id>` / `--last`) read from `codex_session_id`, not `claude --resume <uuid>`.
- kill / merge / diff / nuke are git- and tmux-level → unaffected.
- `openInGhostty` is tmux-level → unaffected (D2 satisfied for free).

---

## 6. Phased plan (each phase has an acceptance gate)

Every phase MUST end green on `bun test` + `bunx tsc --noEmit` before the next begins.

### Phase 0 — Model→CLI resolver + meta plumbing
- Add `src/agent-cli.ts` (`resolveCli`, `isCodexModel`, known-Codex set).
- Add `codex_session_id?: string` to `AgentMeta` (`src/agents.ts:49`).
- Wire `resolveCli` at the model-precedence seam (`ib-commands.ts:2551`) and the spawn branch point (`start.sh` assembly, launch lines `3111`/`3113`) — no behavior change yet (claude path byte-identical).
- **Gate:** unit tests for `resolveCli` (claude default, codex names → codex, unknown → claude). All existing tests + tsc green. Claude spawn path byte-identical.

### Phase 1 — Spike: verify interactive codex + deny semantics (manual)
- Manually run interactive `codex -a never -s workspace-write` in a tmux session with a trivial deny-everything PreToolUse hook.
- **Resolve the OPEN question:** does a hook `deny` in *interactive* mode block silently (return to model, no modal)? Confirm `--dangerously-bypass-hook-trust` vs pre-trust behavior. Confirm prompt-as-positional works.
- Capture the exact working launch line + trust step + how the codex session/rollout id is obtained for resume.
- **Gate:** a written findings note (append to `CODEX-CLI-NOTES.md`) with the verified launch command, no-modal confirmation, and session-id capture method. NO code.

### Phase 2 — Codex config / hook writer
- `buildCodexConfig()` + per-agent `CODEX_HOME` (incl. auth reachability) writing `config.toml` with `[[hooks.PreToolUse]]` (+ SessionStart/Stop), deny-by-default, translating the shared `.md` lists. Trust handling per Phase 1.
- **Gate:** unit test asserting generated `config.toml` is valid TOML, references the ib hook command, and encodes the merged allow/deny. Manual: `codex` loads the config without error; an allow-listed cmd runs, a non-listed cmd is denied — no prompt.

### Phase 3 — Spawn path (headed, in tmux)
- Branch `start.sh` assembly in `newAgent()` on `resolveCli(model)` → launch interactive codex per §5.3. Capture PID + codex session id → meta.
- **Gate:** `ib new-agent --model <codex-model> "task"` spawns a codex agent visible in `ib list`/dashboard; `C` opens it in Ghostty as a live interactive session; it performs an allow-listed action; it never prompts. Claude agents unaffected.

### Phase 4 — State detection for codex
- Hook-driven `running`/`waiting`/`complete` writes (§5.6.1) + minimal codex tmux overrides (§5.6.2). Branch `detectAgentStates()`.
- **Gate:** a codex agent shows correct states through a full task (creating → running → waiting/complete) in the dashboard; overrides (rate_limited/api_error) recognized from real codex output captured in this phase.

### Phase 5 — Watchdog for codex
- CLI-branch `runPerAgentWatchdog`: codex idle/nudge + rate-limit handling; disable inapplicable Claude-only behaviors.
- **Gate:** a stuck codex agent gets nudged; a simulated rate-limit recovers; no spurious bare-Enter behavior.

### Phase 6 — Resume + lifecycle
- `resumeAgent()` codex branch (`codex resume` via `codex_session_id`); confirm kill/merge/diff unaffected.
- **Gate:** resume re-attaches the same codex session in tmux; merge of a codex agent's branch works end-to-end.

### Phase 7 — Docs, SPEC.md, tests
- Fold this into `SPEC.md`; update `CLAUDE.md` implementation notes; ensure full test coverage; `bunx tsc --noEmit` clean.
- **Gate:** SPEC.md updated; test count increased; CI-green.

---

## 7. Risks / open questions
1. **Interactive deny = no modal?** (Phase 1 gate — the whole D4 guarantee rests on this.)
2. **Per-agent `CODEX_HOME` auth.** ChatGPT auth lives in `CODEX_HOME/auth.json`; a per-agent home must reach valid auth without copying secrets around insecurely. (Phase 2.)
3. **Hook enforcement is soft** (OpenAI's caveat). The `-s workspace-write` sandbox is the real boundary; document this so users don't over-trust the hook. (Mirrors Claude's posture.)
4. **State-detection brittleness.** Prefer hook-driven deterministic state over scraping codex's TUI; treat tmux overrides as a thin supplement. (Phase 4.)
5. **Codex version drift.** All facts pinned to 0.135.0; flags/contracts may change. Add a `codex --version` check + a `codex doctor`-style health note at spawn.
6. **Known-Codex model set maintenance.** New OpenAI models won't route to codex until added; consider a `config.json` override list (post-Phase-0).

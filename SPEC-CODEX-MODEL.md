# SPEC: Codex CLI as an alternative agent model

Status: **DRAFT — design.** Phase 0 + Phase 1 + Phase 2 spike all IMPLEMENTED, reviewed, and merged on `agent/codex-agent`. Phase 3 implementation in review (4 commits on `agent/agent-cebe1d6c`, 3547 tests pass + tsc clean, general reviewer APPROVE, adversarial reviewer REQUEST_CHANGES with 3 HIGH triaged + sent back to worker). Phase 2 is docs-only (3 commits, +534 lines on `CODEX-CLI-NOTES.md`) and resolved THE CRUX (D4 silent-deny confirmed) plus the inline-`-c` registration architecture. Phases 4–8 pending.
Branch: `agent/codex-agent`. Author: codex-agent (manager). Last updated: 2026-05-30 (post-Phase-3-review SPEC update: §6 Phase 3 ↔ Phase 4 boundary clarified — three spawn-co-located deliverables moved to Phase 4; §6 Phase 3 gate criterion (c) tightened to require /private/tmp deny + (e) extended to dispatcher fail-open + (h) added for meta.json tmp-write race; §5.4 step 5/6 marked as Phase 4; §5.5 dispatcher fail-open requirement called out explicitly; §5.5 apply_patch synthesized-Write contract documented as path-only-gating intentional behavior; §4 seam table updated for `src/codex-config.ts` module location).
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
- **Never-prompt VERIFIED (Phase 2 spike Q1):** `-a never` + a PreToolUse hook returning `permissionDecision: "deny"` blocks **silently in interactive tmux** — no modal, no approval UI. TUI shows a one-line `• PreToolUse hook (blocked)` entry with the reason; model receives the deny as tool-output and continues autonomously. D4 confirmed end-to-end.
- **Inline-`-c` hook registration bypasses the project-trust gate (Phase 2 spike Q2).** Registering hooks entirely via `-c 'hooks.PreToolUse=[{...}]'` on the codex CLI is the chosen path. No on-disk `<worktree>/.codex/config.toml` is required and no entry in `~/.codex/config.toml` is needed. This is the isolation strategy for itsybitsy. (On-disk per-worktree config + `[projects."<abs>"].trust_level = "trusted"` is documented but UNUSED — see §3.2 for why we did not adopt it.) `CODEX_HOME` relocation is also not used (breaks auth — see §3.2).
- **Native session-start instructions:** Codex reads `AGENTS.md` in the worktree natively. [research §C] Replaces inline session-start injection.
- **PreToolUse fires for `apply_patch` on v0.135.0 (Phase 2 follow-up).** Earlier docs (openai/codex#16732) suggested apply_patch was exempt; empirical verification shows the hook fires with the full patch body in `tool_input.command` (containing `*** Add File:` / `*** Update File:` / `*** Delete File:` directives with target paths). itsybitsy can gate file edits via the same hook handler that gates Bash — see §5.5. **Hook is the primary boundary, not the sandbox.**

### 3.2 Real gaps we must work around
- ~~**`apply_patch` does NOT fire PreToolUse hooks** (open issue openai/codex#16732).~~ **RESOLVED (Phase 2 follow-up):** apply_patch DOES fire PreToolUse on v0.135.0 with the full patch body (including target paths) in `tool_input.command`. The hook is the primary boundary for both Bash AND file edits. See §5.5 for the unified path-extraction approach.
- **`-s workspace-write` allows writes to `/tmp`, `$TMPDIR`, and `~/.codex/memories` by default (Phase 2 follow-up).** Codex's default `writable_roots` on macOS includes `/private/tmp` (= `/tmp`), `/private/var/folders/.../T`, and `~/.codex/memories` in addition to cwd. The sandbox alone does NOT keep a codex agent inside its worktree — writes to these paths succeed without firing the hook. **Hook is the enforcement layer; sandbox is defense-in-depth.** Writes to non-writable roots like `~/Documents` or `../../parent` are MODEL-level declines (codex's system prompt lists writable_roots) — an adversarial prompt could bypass model self-restriction, so the hook must still gate.
- **No `permissions.allow/deny` array equivalent** in codex; no `--allowedTools`/`--disallowedTools` CLI flags. [research §C "Where there is NO clean equivalent"] ⇒ We MUST translate the agent-type allow/deny lists into a **generated PreToolUse hook handler** invoked per tool call. The handler is implemented as a TypeScript dispatcher (`ib hooks codex-pre-tool-use <agentId>`) — same architecture as the existing claude hooks. No on-disk shell script is needed.
- **`Task` interception is irrelevant** — codex has no `Task` tool. The equivalent is the `SubagentStart` event (documented but not yet battle-tested per issues #14754/#18888). [research §C] ⇒ `intercept-task` is a no-op on codex; gate sub-agent spawning via `SubagentStart` if/when needed.
- **No system-prompt CLI flag** (no `--append-system-prompt`). [research §C] ⇒ Use the worktree `AGENTS.md` instead.
- **`-a never` is "never PROMPT", not "deny everything by default."** Without our PreToolUse hook a command would be ALLOWED (subject to sandbox); with the hook returning deny-by-default, denied commands return to the model rather than escalating to a human. The hook is what makes D4 true.
- **Hash-pinned hook trust.** Codex hashes every hook command; any edit invalidates trust and the hook is **silently skipped** until re-trusted. [research §B4] ⇒ itsybitsy MUST pass `--dangerously-bypass-hook-trust` on every spawn (our hook source is first-party and vetted). Without it, regenerating the hook silently disables it — a permission-bypass disaster.
- **No hot-reload.** Codex config + hooks require a fresh session to pick up edits (Claude reloads `permissions`/`hooks` live). [research §C] ⇒ Mutations require respawn.
- **Permission model is 2D.** Codex: `-a {untrusted|on-request|never} × -s {read-only|workspace-write|danger-full-access}`. Claude: 1D `--permission-mode`. [research §C] ⇒ Map our equivalent of `acceptEdits` to **`-a never -s workspace-write`**.
- **No `.local`-style override file and no on-disk per-worktree config is used.** Hooks are registered via inline `-c` at launch time (Phase 2 spike Q2); no per-worktree config.toml is written by itsybitsy. `<worktree>/.codex/hooks/` is added to `.gitignore` to cover any incidental files (e.g. hook logs).
- **`CODEX_HOME` relocation breaks auth (Phase 2 spike B2).** Setting `CODEX_HOME=<per-agent-path>` triggers the first-time-login flow because `~/.codex/auth.json` isn't in the redirected home. **NOT pursued** (per user direction — no symlink workaround either). itsybitsy uses global `~/.codex/` for auth + sessions + memories; per-agent isolation comes from cwd + inline `-c` hooks + the worktree path-isolation matcher in the hook handler.
- **Hook failure mode is FAIL-OPEN (Phase 2 spike B1).** Per the codex docs at `developers.openai.com/codex/hooks`: a hook that crashes, emits malformed JSON, or returns an unsupported `permissionDecision` is marked failed and the tool call PROCEEDS. The hook handler MUST wrap all logic in try/catch and emit a deny payload on exception. See §5.5 for the defense-in-depth requirements.
- **`permissionDecision: "allow"` requires being paired with `updatedInput` (Phase 2 spike B1).** Standalone `permissionDecision: "allow"` triggers `error: PreToolUse hook returned unsupported permissionDecision:allow` and fails open. Explicit allow must echo the original `tool_input` back as `updatedInput` (a no-op rewrite). Alternative is to emit `{}` and rely on "no decision = proceed" (works empirically but undocumented).
- **PreToolUse is not airtight** (OpenAI's own caveat — model may route around a blocked tool via another path). [research §B3] ⇒ Hooks + sandbox layered together is the defense; either alone is insufficient.

### 3.3 Canonical codex launch line (Phase 2 verified)

```
codex -m <MODEL> -a never -s workspace-write \
      --dangerously-bypass-hook-trust \
      -c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-pre-tool-use <agentId>",timeout=30}]}]' \
      -c 'hooks.SessionStart=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-session-start <agentId>",timeout=30}]}]' \
      -c 'hooks.Stop=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-stop <agentId>",timeout=30}]}]' \
      "<prompt>"
```

Where `<MODEL>` is the **model half** of the parsed `<cli>:<model>` (the `codex:` prefix is stripped), `<abs ib>` is the absolute path to the `ib` binary resolved at spawn time (NOT a bare `ib` — codex's spawn environment may have a different PATH; see §5.5), and `<agentId>` is the itsybitsy agent id (ASCII, regex-validated, safe to interpolate).

**No on-disk config file is written.** Per Phase 2 spike Q2, the inline-`-c` registration bypasses codex's project-config-walk and trust gate entirely. No `<worktree>/.codex/config.toml` is created and no entry is added to `~/.codex/config.toml`.

`-C <worktree>` is OPTIONAL — codex inherits cwd from the parent shell (tmux is already created in the worktree by itsybitsy). Add it only as defensive belt-and-braces if a future codex version changes cwd resolution.

`--dangerously-bypass-hook-trust` is **mandatory on every invocation** because the inline hook command's hash changes every spawn (the `<agentId>` interpolates into it). User has explicitly accepted this bypass — see Authoritative Decision D4.

**Path-safety precondition (per reviewer #2 #3):** the `<abs ib>` path is interpolated into a TOML string literal inside a shell single-quoted argument. Before constructing the `-c` payload, itsybitsy MUST validate that the resolved binary path contains no `'`, `"`, `\`, or control characters. If it does, fail the spawn with a clear error pointing the user at the unsafe install path. (itsybitsy's default install paths are safe; this guards against user-customized installs.)

**Model availability:** under a ChatGPT-plan account, only models in `~/.codex/models_cache.json` work. As of v0.135.0 + ChatGPT auth: `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review`. API-key billing may expose others. `gpt-5-codex` is NOT available on ChatGPT auth (HTTP 400). itsybitsy cannot pre-validate model availability client-side — an invalid model surfaces as HTTP 400 after the first prompt.

---

## 4. itsybitsy seams (verified file anchors)

| Seam | Location | Notes |
|------|----------|-------|
| AgentMeta type | `src/agents.ts:49` | `model: string` at :60; `session_id` at :51; **`codex_session_id?: string`** added in Phase 0 for codex resume. No `cli` field (parsed on demand per D1). |
| Model default | `src/config.ts:24` (`model` default `"claude:opus"`); coordinator `:32` (also `"claude:opus"`) | ✅ DONE in Phase 1 — defaults updated from bare `"opus"` to qualified form (D5: no back-compat). |
| Model precedence | `src/ib-commands.ts` newAgent (`--model > <type>.md model > _non_coordinator.md model > _all.md model > config.model > 'claude:opus'`); main's `0791dd6` layered walk preserved through rebase | ✅ DONE in Phase 1 — default literal is `"claude:opus"`; main's layered walk + parseModel validation integrated. |
| isValidModel | `src/validation.ts:14` allowlist `^[a-zA-Z0-9._:-]+$` | ✅ DONE in Phase 1 — widened to allow `:` (the one load-bearing one-character change; without it every qualified model would be rejected at spawn). |
| VALID_MODELS allowlists | `src/config-command.ts:6` (`["sonnet","opus","haiku"]`), `src/hooks/intercept-task.ts:24` (same set + `""`) | Replace with `parseModel + KNOWN_CLIS` validation (must accept any `<known-cli>:<model>`). |
| session UUID | `src/ib-commands.ts:2723` `crypto.randomUUID()`; stored `:2781` `session_id` | Codex has its own rollout-id model; capture into `codex_session_id` after first launch. |
| Spawn `claude` cmd | `src/ib-commands.ts` `newAgent()` — `claudeArgs` built `2989–3010`; generated `start.sh` written from `:3072`; launch lines **`3111`/`3113`** (`setsid claude --session-id … "$(cat promptfile)"` / bare `claude --session-id …`); `CLAUDE_PID=$!` at `:3115`; SIGHUP `trap '' HUP` at `:3091` | **Branch point for codex launch.** Pass `parseModel(model).model` (NOT the raw `<cli>:<model>`) to `--model`. |
| Resume `claude` cmd | `src/ib-commands.ts` `resumeAgent()` — args ~587–590, `resume.sh` written 619–709, `claude --resume …` launch lines ~663/665, SIGHUP-ignore insulation 635–644 | Codex resume differs: `codex resume <id>` via `codex_session_id` (not `claude --resume <uuid>`). |
| Hook reg + perms | `src/settings-builder.ts` + `buildAgentSettings()` in `ib-commands.ts` (~2163–2267); writes `settings.local.json` (`hooks` block + `permissions.allow/deny`) | Codex parallel: **`buildCodexLaunchArgs()` in `src/codex-config.ts`** (Phase 3, separate module — kept out of `ib-commands.ts` for unit-test isolation). Inline-`-c` payload builder (NOT an on-disk config writer), called from the codex branch of `start.sh` assembly in Phase 4. Output is one `-c 'hooks.<Event>=[...]'` flag per registered event (PreToolUse, SessionStart, Stop), with `command="<abs ib> hooks codex-<event> <agentId>"` interpolated. Per-spawn path-safety check on `<abs ib>` (no quotes/backslashes/control chars). No on-disk codex config file is created. |
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

### 5.4 Permissions → inline PreToolUse hook handler (D3 + D4)

Codex has no `permissions.allow/deny` array, no `--allowedTools` flag. We express our agent-type allow/deny lists as a **TypeScript PreToolUse handler** (`src/hooks/codex-pre-tool-use.ts`) dispatched from `src/index.ts`, registered with codex via inline `-c` flags at spawn time. **No on-disk codex config is written** (Phase 2 spike Q2 — the on-disk path is silently ignored without a trust entry in `~/.codex/config.toml`, and inline-`-c` registration bypasses the trust gate cleanly).

At spawn (Phase 3), `buildCodexLaunchArgs()`:
1. Reads the SAME merged allow/deny lists (`_all.md` + `_non_coordinator.md` + `<type>.md`).
2. Resolves the absolute path to the `ib` binary (`<abs ib>`, e.g. `process.execPath` or a cached `which ib` result). **Path-safety check:** reject the spawn with a clear error if `<abs ib>` contains `'`, `"`, `\`, or control characters — these would break the TOML-in-shell quoting in the `-c` payload.
3. Generates one `-c` flag per registered hook event (PreToolUse + state-detection events from §5.6), each with the same shape:
   - `-c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-pre-tool-use <agentId>",timeout=30}]}]'`
   - `-c 'hooks.SessionStart=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-session-start <agentId>",timeout=30}]}]'`
   - `-c 'hooks.Stop=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-stop <agentId>",timeout=30}]}]'`
4. `model` (`-m`), `approval_policy` (`-a never`), `sandbox_mode` (`-s workspace-write`) are passed as CLI flags, not via `-c`. Per-spawn fail-open hardening: the `command=` value above invokes `ib` directly with no shell wrapper, so any non-zero exit before our handler runs (binary missing, dispatcher crash, `<agentId>` argv parse failure) results in codex fail-open. Mitigation lives in §5.5 (handler-level try/catch + a spawn-time precheck).
5. (Phase 4) Adds `<worktree>/.codex/` to the worktree's `.gitignore` to cover any incidental files (hook logs, sentinel files, future per-agent scratch). No `.codex/config.toml` is created by itsybitsy; if codex itself drops anything there it's gitignored. Slid out of Phase 3 — see Phase 4 in §6.
6. (Phase 4) Writes a per-agent `<worktree>/AGENTS.md` containing the role/session-start instructions (replaces what `session-start.ts` injects for Claude). Slid out of Phase 3 — see Phase 4 in §6.
7. **`~/.codex/config.toml` is NEVER modified by itsybitsy.** The user's existing trust entries, model defaults, and other config are left untouched. (Closes Risk #10.)

**Trust:** `--dangerously-bypass-hook-trust` is passed on **every** spawn (hash-pinned trust requires this; the inline-`-c` payload's hash changes per spawn because `<agentId>` interpolates into it; see §3.2). User-approved bypass per D4.

**Launch-line length:** three inline `-c` payloads with absolute paths is ~600–800 bytes. macOS `ARG_MAX` is ~1 MB so we have several orders of magnitude of headroom; not a concern.

**Defense in depth:** Per Phase 2 follow-up, the hook fires for BOTH `Bash` AND `apply_patch` on v0.135.0 (issue #16732 appears resolved). The hook is the primary boundary; `-s workspace-write` is secondary (and leaky on macOS — it permits `/tmp`, `$TMPDIR`, `~/.codex/memories` by default). See §5.5 for the path-extraction approach that gates both tool types.

### 5.5 Codex PreToolUse hook handler (D3 + D4)

New `src/hooks/codex-pre-tool-use.ts`, dispatched from `src/index.ts` via `ib hooks codex-pre-tool-use <agentId>`:

**Inputs (stdin JSON, verified empirically in Phase 2):**
- `tool_name` — `"Bash"`, `"apply_patch"`, MCP tool names, etc.
- `tool_input.command` — for Bash, the shell command string; for `apply_patch`, the full patch body including `*** Begin Patch` / `*** Add File: <path>` / `*** Update File: <path>` / `*** Delete File: <path>` / `*** End Patch` directives with target paths.
- `cwd` — the agent's worktree (already canonicalized; use directly for path comparisons, no symlink resolution needed).
- `session_id` — the codex rollout id (snake_case on v0.135.0). **Capture this into `meta.codex_session_id` on first hook firing** if the field is empty (Phase 7 resume support). **Defensively read both `session_id` AND `sessionId`** in case a future codex version renames the field (per reviewer #2 #7).
- `hook_event_name`, `turn_id`, `tool_use_id`, `model`, `permission_mode`, `transcript_path` — additional metadata; log but not used for the deny decision.

**Logic:**
1. Resolve agent-type allow/deny lists (same merged source as the claude-side hook): `_all.md` + `_non_coordinator.md` + `<type>.md`. Reuse the matcher logic as a shared library function (don't fork).
2. **Path-isolation matcher** (the codex analog of `agent-path`):
   - For `tool_name === "Bash"`: existing shell-command path detection (extract paths from `tool_input.command` via the same regex/parser used in `agent-path.ts`).
   - For `tool_name === "apply_patch"`: parse the patch body — grep lines starting with `*** Add File:`, `*** Update File:`, `*** Delete File:` and extract the path after the colon. Each path is the target the agent wants to write to.
   - Deny if ANY extracted path resolves outside the worktree (parent itsybitsy repo, sibling agent worktree, etc.). Allow if all resolve inside or to a known-safe writable_root (cwd, `/tmp` SCOPED to known-safe subpaths IF we want, etc. — defer to a follow-up decision).
3. Apply allow/deny matching from the agent-type lists.
4. **Always include `permissionDecisionReason`** on deny (omitting it triggers a separate codex error path).

**Outputs (codex stdout contract, exit 0):**
- **Deny:** `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>"}}`. Confirmed in Phase 2 spike Q1 to silently block in interactive `-a never` mode (no modal).
- **Allow:** emit `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":<echo of original tool_input>}}`. Standalone `permissionDecision: "allow"` is rejected by codex as "unsupported permissionDecision:allow" and FAIL-OPENs (Phase 2 spike B1). The echo-back-original-input pattern is a no-op rewrite, documented and verified working. **Alternative (Option B):** emit `{}` or no decision and rely on codex defaulting to allow. Empirically works but undocumented; keep Option A unless codex adds rewrite-detection telemetry, in which case flip.
- **Default (no match):** deny.

**Fail-open hardening (CRITICAL — codex's documented hook failure mode is FAIL-OPEN per `developers.openai.com/codex/hooks`):**
- Wrap ALL handler logic in a try/catch; emit a deny payload on ANY exception. Never let the process throw or exit non-zero.
- Validate `<agentId>` as the first argv before any other work; on parse failure emit deny and exit 0.
- Emit valid JSON to stdout on every code path. Never emit a partial JSON write.
- Out-of-process failures (binary missing from PATH, dispatcher crash before `codex-pre-tool-use.ts` runs) cannot be caught by the handler itself. Mitigations layered: (1) §5.4 step 2 resolves an ABSOLUTE path to `ib` at spawn time, eliminating PATH dependency. (2) The dispatcher in `src/index.ts` MUST itself be fail-open-safe — missing/invalid `<agentId>`, module-import failure, or any pre-handler error MUST emit a deny payload + `exit 0` (NOT `exit non-zero` — codex treats non-zero exit as fail-open crash). The `--dry-run` flag exists on the dispatcher in Phase 3. (3) (Phase 4) Spawn-time precheck *caller* runs `ib hooks codex-pre-tool-use --dry-run <agentId>` before launching codex; fail the spawn cleanly if the dispatcher doesn't resolve.

**Session-id capture (Phase 7 prep, reviewer #1 recommendation):**
- The PreToolUse handler captures `session_id` into `meta.codex_session_id` only on FIRST firing — but this misses sessions where the agent never triggers a tool call (rare but possible).
- The `SessionStart` handler (§5.6) is the right home for session-id capture: it ALWAYS fires regardless of tool calls. The PreToolUse handler should still capture defensively as a fallback (in case SessionStart fails or codex changes the event firing order).

`intercept-task` does **not** need a codex equivalent — codex has no `Task` tool. If/when we need to gate codex sub-agent spawning, use the `SubagentStart` event.

### 5.6 State detection (the hard part)

`parse-state.ts` greps Claude's TUI strings; codex's TUI differs. Two complementary tactics:
1. **Hook-driven state writes (preferred, deterministic):** wire codex's `SessionStart` → `running`, `Stop` → `waiting`/`complete`, mirroring the Phase-42 deterministic flow (`ib hook-status` writes `state` to meta.json via `writeAgentState()`). Avoids brittle screen-scraping. The native `AGENTS.md` instructions can even tell the agent to emit specific markers if needed.
   - **`SessionStart` is also the primary session-id capture point** (reviewer #1 recommendation): it always fires regardless of whether the agent triggers a tool call. Handler reads `session_id` from stdin and writes `meta.codex_session_id` if empty. PreToolUse handler (§5.5) captures defensively as a fallback.
2. **Codex tmux overrides:** a small `parse-state-codex.ts` (or codex branch) for the override states the hooks can't capture (rate-limited, api_error, compacting) by matching codex's actual UI strings (gathered empirically in Phase 5 — formerly Phase 4).

All state-detection hooks are registered via the same inline-`-c` pattern as PreToolUse (§5.4 step 3): `-c 'hooks.SessionStart=[{matcher=".*",hooks=[{type="command",command="<abs ib> hooks codex-session-start <agentId>",timeout=30}]}]'`, etc.

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

### Phase 1 — Explicit `<cli>:<model>` format (the new D1) ✅ MERGED
Status: complete on `agent/codex-agent` (rebased onto main; reviewed by 2 worker reviewers, both APPROVE). Commits:
- `8c14eed` feat(codex): Phase 1 — parseModel + KNOWN_CLIS, drop bare-name prefix matching
- `90fc3f3` feat(codex): Phase 1 — route spawn/resume/coordinator through parseModel
- `138e85a` test(codex): Phase 1 — invert agent-cli tests + migrate fixtures to qualified models
- `a35d482` test(codex): post-rebase fixture migration to qualified `<cli>:<model>` (also fixes one test-isolation bug uncovered by Phase 1's strict validation)

Gate met: **3281 pass / 0 fail; tsc 0 errors.**

What landed (design intent from the original Phase 1 spec, all 10 steps):
1. ✅ `src/agent-cli.ts`: `parseModel` + `KNOWN_CLIS` added; `CODEX_MODELS` / `CODEX_MODEL_PREFIXES` / boundary-aware prefix matching DELETED (no more inference); `resolveCli` reduced to a thin wrapper over `parseModel(m).cli`; `isCodexModel` re-based on the parsed cli.
2. ✅ `src/validation.ts:14`: `isValidModel` regex widened to `^[a-zA-Z0-9._:-]+$`.
3. ✅ `src/config.ts:24,32`: `model` and `coordinator.model` defaults updated to `"claude:opus"`.
4. ✅ `src/ib-commands.ts`: spawn (newAgent) + resume (resumeAgent) now run `parseModel` in a try/catch that surfaces the D6 message on failure; the parsed **model half** (e.g. `"opus"`) is passed to `--model` rather than the raw qualified string; meta.json stores the **raw** qualified value verbatim. The `agentCli` const is kept (currently unused) as the Phase 4 spawn-branch seam.
5. ✅ `src/coordinator.ts:428`: parses `coordinator.model`; non-claude cli is HARD-REJECTED with `"codex coordinators not yet implemented; use claude:<model>"` (D9 stub — full codex-coordinator support lands later).
6. ✅ `src/agent-types.ts`: any non-empty `model:` frontmatter is validated via `parseModel` in `validateAllAgentTypes` (which the dashboard calls at startup), so a bare-name slip in `_all.md` / `_non_coordinator.md` / `<type>.md` surfaces with a clear file-name + parseModel error. The "empty `model:` = inherit" convention is preserved.
7. ✅ `src/config-command.ts:6,81`: replaced hard-coded `VALID_MODELS` allowlist with `parseModel + KNOWN_CLIS` validation.
8. ✅ `src/hooks/intercept-task.ts:32-38`: `isAcceptableTaskModel` uses `parseModel`; bare names + unknown CLIs are silently coerced to `""` (defensive carryover, documented).
9. ✅ `src/tui/info-panel.ts` + `src/tui/agent-tree.ts`: render `meta.model` verbatim (per D8 — already qualified post-Phase-1).
10. ✅ `src/agent-cli.test.ts`: all bare-name route tests inverted (now assert THROW); new `parseModel` tests cover split-on-first-colon, greedy model, colon-in-model, malformed cli, unknown cli throws with the D6 message regex.

Integration with main: rebase of `agent/codex-agent` onto main (`6143297`) replayed the 9 commits cleanly with 2 keep-both conflict resolutions in `src/ib-commands.ts` (Phase 0 resolver block kept alongside main's layered-walk comment, no semantic overlap). The agent-types loader × parseModel integration was verified by both reviewers as the highest-value check.

User-facing follow-up (per D5, your call): any bare-name `model:` value in your installed `~/.itsybitsy/agent-types/*.md` or `~/.itsybitsy/config.json` will now be rejected at `ib watch` startup with a clear error. Migrate to the qualified `<cli>:<model>` form by hand.

### Phase 2 — Spike: verify interactive codex + deny semantics (manual) ✅ MERGED
Status: complete on `agent/codex-agent`. Three commits:
- `64b8202` docs(codex): Phase 2 spike findings — silent-deny + inline-c hook registration (+320)
- `736b8b2` docs(codex): Phase 2 — add canonical-launch-line TL;DR to spike findings (+41)
- `a808fce` docs(codex): Phase 2 follow-up — apply_patch sandbox boundary verified on v0.135.0 (+173)

Gate met: findings folded into `CODEX-CLI-NOTES.md` (+534 lines) AND this SPEC (§3.1, §3.2, §3.3, §4 seam table, §5.4, §5.5, §5.6, §7 risks all updated). NO code changes (per gate spec).

Verified empirically on `codex-cli 0.135.0`, ChatGPT-auth, `gpt-5.4-mini`:
1. ✅ **THE CRUX (Q1):** `permissionDecision: "deny"` blocks silently in interactive `-a never` mode. No modal, no approval UI. D4 confirmed end-to-end. Two worker reviewers (general + adversarial) both validated the evidence.
2. ✅ **Q2 (worktree hook fires):** on-disk `<worktree>/.codex/config.toml` is silently ignored without a `~/.codex/config.toml` trust entry. **Inline `-c hooks.PreToolUse=[...]` bypasses the project-trust gate entirely** — this is the chosen registration path. No on-disk codex config and no `~/.codex/config.toml` modification.
3. ✅ **Q3 (session-id):** captured from PreToolUse stdin (`session_id` field) AND from `SessionStart` stdin (preferred — always fires). Rollout files at `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<UUID>.jsonl` as fallback. `codex resume <UUID>` re-attaches.
4. ✅ **Q4 (launch line):** `-C <worktree>` is optional; ChatGPT-auth limits models to `gpt-5.5` / `gpt-5.4-mini` / `codex-auto-review`; hook registration moves from on-disk → inline `-c`. See §3.3 for the verified line.

Phase 2 follow-up (apply_patch + sandbox) flipped two SPEC assumptions:
- **`apply_patch` DOES fire PreToolUse on v0.135.0** (issue #16732 appears resolved). The hook receives the full patch body with target paths in `tool_input.command`. itsybitsy's hook handler gates BOTH Bash AND file edits.
- **`-s workspace-write` allows writes to `/tmp`, `$TMPDIR`, `~/.codex/memories` by default.** Sandbox is leaky on macOS; the hook is the primary boundary.

Reviewer #2 raised 11 issues; manager triage merged 5 actionable items into the SPEC patch (#7 field-name stability, #10 SPEC patch completeness across §3.1/§4/§6/§5.6, #11 reframe inferences as observations, plus #3 path-safety preconditions and #2 fail-open coverage outside TypeScript). Items #4/#5 (bypass-trust blast radius / CODEX_HOME symlink workaround) explicitly closed by user direction — NOT pursued.

### Phase 3 — Codex inline-`-c` launch builder + hook handler (HANDLERS-ONLY)
Scope clarification (post-Phase-3 review, 2026-05-30): three spawn-co-located deliverables originally listed here have been **moved to Phase 4** because they live in `src/ib-commands.ts` alongside the start.sh assembly — implementing them in Phase 3 would have required a partial spawn-path edit that Phase 4 must rewrite anyway. The moved items are: (i) `<worktree>/.codex/` gitignore wiring, (ii) per-agent `<worktree>/AGENTS.md` generation, (iii) spawn-time `--dry-run` precheck *caller* (the `--dry-run` *flag* itself ships in Phase 3 on the dispatcher; only the caller-side invocation slides). See Phase 4 below.

- `buildCodexLaunchArgs()` in `src/codex-config.ts` returns the inline-`-c` flag array per §5.4. Reads merged allow/deny lists from `_all.md` + `_non_coordinator.md` + `<type>.md`; resolves `<abs ib>` with path-safety check (no `'`, `"`, `\`, or control chars); emits one `-c 'hooks.<event>=[{...}]'` per registered event (PreToolUse + SessionStart + Stop).
- `src/hooks/codex-pre-tool-use.ts` implements the allow/deny handler per §5.5: reads stdin JSON; extracts paths from `tool_input.command` for BOTH Bash (existing shell parser) AND `apply_patch` (parse `*** Add/Update/Delete File:` directives); applies path-isolation + allow/deny list matching; emits `permissionDecision: "deny"` (with `permissionDecisionReason`) OR `permissionDecision: "allow"` paired with `updatedInput` echoing the original `tool_input`; defaults to deny. Wraps ALL logic in try/catch and emits deny on exception (codex fail-open mitigation).
- `src/hooks/codex-session-start.ts` + `src/hooks/codex-stop.ts` for state-detection (per §5.6) — write `state` to meta.json via `writeAgentState()`; SessionStart additionally captures `session_id` into `meta.codex_session_id` if empty (with `sessionId` defensive fallback). Concurrent writes to `meta.json` MUST use a per-write unique tmp suffix (e.g. `metaPath + ".tmp." + crypto.randomUUID()`) to avoid clobbering racing mutations from PreToolUse-driven captures.
- `src/index.ts` routes `hooks codex-pre-tool-use` / `hooks codex-session-start` / `hooks codex-stop` → the new handlers, including the `--dry-run` flag (caller-side invocation in Phase 4). **The dispatcher itself MUST be fail-open-safe:** missing/invalid `<agentId>`, module-import failure, or any other dispatcher-level error MUST emit a deny payload to stdout and `exit 0`, never `exit non-zero`. Codex treats any non-zero dispatcher exit as a fail-open hook crash (tool call proceeds).
- **Gate:** unit tests asserting (a) `buildCodexLaunchArgs()` produces well-formed `-c` payloads (parseable TOML; correct event names; correct command interpolation); (b) path-safety rejection fires for unsafe `<abs ib>` paths; (c) the handler's allow/deny matches the merged `.md` lists for Bash AND apply_patch tool calls — including a regression guard that apply_patch to `/private/tmp` is DENIED (the path-isolation branch MUST require target inside worktree, NOT fall through to `checkPathAccess`'s legacy permissive branch); (d) the codex JSON contract is correct (deny with reason; allow + echo-back `updatedInput`); (e) the handler emits deny on uncaught exception AND the dispatcher emits deny on missing/invalid agentId or module-import failure; (f) SessionStart handler writes `codex_session_id` to meta.json on first firing; (g) defensive `sessionId`/`session_id` read works; (h) two concurrent `meta.json` writes (writeAgentState + captureCodexSessionId) both land via unique tmp suffix. Manual verification deferred to Phase 4 once spawn path is wired.

**apply_patch synthesized-Write contract (post-Phase-3 §5.5 footnote):** the PreToolUse handler treats apply_patch as path-only-gated: it extracts target paths from the patch body, requires them inside the worktree (or in the agent's configured `allowedPaths`), and reuses `checkPathAccess`'s path-isolation logic via a synthesized `{toolName: "Write", toolInput: {file_path: <target>}}` call (prepending `"Write"` to the allow list for the synthesized call). The agent's merged allow/deny list is **not** consulted for tool-name matching on apply_patch — this is intentional and matches codex's tool surface (apply_patch is codex's analog of Claude's Write+Edit). Operators who want to forbid file edits entirely should use `-a never -s read-only` instead of relying on tool-name allow lists.

### Phase 4 — Spawn path (headed, in tmux)
- Branch `start.sh` assembly in `newAgent()` on `parseModel(model).cli` → launch the canonical line from §3.3. Capture PID + codex session id → meta (`codex_session_id`).
- **Moved from Phase 3 (handler infrastructure landed in Phase 3, spawn wiring lands here):**
  - `<worktree>/.codex/` added to the worktree's `.gitignore` (covers incidental files even though we don't write a `config.toml`).
  - Per-agent `<worktree>/AGENTS.md` generated with role/session-start instructions (Claude-side equivalent: `session-start.ts` injection).
  - Spawn-time precheck *caller*: invoke `ib hooks codex-pre-tool-use --dry-run <agentId>` (and the SessionStart + Stop counterparts) before launching codex; fail the spawn cleanly if any dispatcher doesn't resolve (out-of-process fail-open mitigation; the `--dry-run` flag itself shipped in Phase 3).
- **Gate:** `ib new-agent --model "codex:<model>" "task"` spawns a codex agent visible in `ib list` / dashboard; `C` opens it in Ghostty as a live interactive session; it performs an allow-listed action; it never prompts. The spawn-time precheck fires (verify by temporarily breaking the dispatcher in a test branch — spawn must refuse). `.gitignore` contains `.codex/`; `AGENTS.md` is generated in the worktree. Claude agents unaffected.

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

1. ~~**THE CRUX (Phase 2 gate):** does interactive `codex -a never` + deny hook block silently (no modal)?~~ **RESOLVED (Phase 2 spike Q1).** Silent deny confirmed end-to-end on v0.135.0 in interactive tmux. D4 holds.
2. ~~**`apply_patch` doesn't fire PreToolUse hooks** (openai/codex#16732).~~ **RESOLVED (Phase 2 follow-up).** apply_patch DOES fire PreToolUse on v0.135.0 with the full patch body in `tool_input.command`. Our hook handler gates both Bash AND file edits. Note: `-s workspace-write` is leaky on macOS (permits `/tmp`, `$TMPDIR`, `~/.codex/memories` by default) — the hook MUST do path-isolation; sandbox alone is insufficient.
3. **Hash-pinned trust + mandatory bypass.** Every spawn must pass `--dangerously-bypass-hook-trust`; without it our inline `-c` hook silently disables itself. There is no config-key to pre-trust by hash. Codified in `buildCodexLaunchArgs()` per §5.4. User-accepted bypass per D4. Scope of the flag was not empirically tested beyond hook-trust (reviewer #2 #4 closed by user as not pursued); revisit if codex's release notes ever change the flag's semantics.
4. **No hot-reload.** Codex config/hook edits require a fresh session. Mutating an agent's permissions mid-session means killing+respawning, not editing.
5. **`SubagentStart` is documented but not battle-tested** (issues #14754/#18888). If/when we need to gate codex sub-agent spawning, plan to verify it fires reliably before relying on it.
6. **State-detection brittleness.** Prefer hook-driven deterministic state over scraping codex's TUI; treat tmux overrides as a thin supplement. (Phase 5.)
7. **Codex version drift.** All facts pinned to v0.135.0; flags/contracts may change. Add a `codex --version` check at spawn and stamp it in meta.json so we can correlate state-detection failures against version bumps (reviewer #2 #7). Defensively read hook-payload fields (`session_id` AND `sessionId`) to survive snake_case → camelCase renames.
8. **`PermissionRequest` event.** Codex's docs show `permissionDecision: ask` only on `PermissionRequest`, not `PreToolUse` (research §B3 / §C). With `-a never` + deny-by-default our hook returns only allow/deny; we should never see `PermissionRequest`. **Verified in Phase 2 spike** — never observed during interactive testing.
9. **No `--allowedTools` / `--disallowedTools` / `permissions.allow/deny`.** The inline-`-c` PreToolUse handler is the only path. (Architecturally fine, but more code than Claude needs.)
10. ~~**`~/.codex/config.toml` trust list grows per worktree.**~~ **RESOLVED (Phase 2 spike Q2).** Inline `-c hooks.PreToolUse=[...]` registration bypasses the project-trust gate entirely. `~/.codex/config.toml` is never modified by itsybitsy. No per-worktree cleanup needed.
11. **Codex hook contract is FAIL-OPEN (Phase 2 spike B1).** `permissionDecision: "allow"` requires being paired with `updatedInput` (a no-op echo-back rewrite is the safe expression of explicit allow). Standalone allow / crashes / malformed JSON / unsupported decisions ALL result in the tool call PROCEEDING per the documented behavior at `developers.openai.com/codex/hooks`. Our handler must: (a) wrap all logic in try/catch + emit deny on exception; (b) resolve `<abs ib>` at spawn time (no PATH dependency); (c) validate `<agentId>` argv before any other work; (d) include a spawn-time precheck (`--dry-run`) to verify dispatcher resolves. Monitor hook-fail rate via PostToolUse or external telemetry to detect gating regressions in production.
12. **ChatGPT-account model availability is constrained (Phase 2 spike Q4).** Only models in `~/.codex/models_cache.json` are reachable: `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review`. `gpt-5-codex` returns HTTP 400. itsybitsy cannot pre-validate client-side; surface the HTTP 400 cleanly in the TUI after first prompt.
13. **`CODEX_HOME` relocation breaks auth (Phase 2 spike B2).** No `auth.json` in the redirected home → first-time-login flow every spawn. Decided **NOT pursued** (per user direction — no symlink workaround either). Global `~/.codex/` is the chosen home; per-agent isolation comes from cwd + inline-`-c` hooks + the path-isolation matcher in the handler.
14. **Inline-`-c` TOML-in-shell path safety (reviewer #2 #3).** The `<abs ib>` path is interpolated into a TOML string literal inside a shell single-quoted argument. `buildCodexLaunchArgs()` must reject the spawn if `<abs ib>` contains `'`, `"`, `\`, or control characters. itsybitsy's default install paths are safe; this guards against user-customized installs in paths with apostrophes or quotes.
15. **Q2 negative-result methodology has residual confound (reviewer #2 #1).** The "on-disk config.toml is silently ignored without trust" finding was tested with potentially-different script paths between arms and without a clean-`~/.codex/`-per-arm protocol. The PRACTICAL conclusion (use inline `-c`) is unaffected because we picked inline-`-c` for its own merits, not because the on-disk path is definitively broken. Treat "on-disk path status" as UNVERIFIED rather than KNOWN-BROKEN; revisit only if a future codex version changes the trust model and we want to re-evaluate.

---

## 8. Process

- This SPEC is the **single design source of truth**. Supporting docs (`SETTINGS-HOOKS-RESEARCH.md`, `MODEL-NAME-FORMAT-PROPOSAL.md`, `CODEX-CLI-NOTES.md`) are evidence-only.
- **Any exploratory agent that surfaces a load-bearing finding triggers a SPEC update before the next implementation phase starts.** This SPEC was rewritten on 2026-05-30 to fold in the settings/hooks research (commit `d3c6c3d`) and the model-name format proposal (commit `bc88426`). Future research rounds follow the same rule.
- Phase commits land on `agent/codex-agent`; reviewed by 2 worker reviewers (one adversarial) before merge per `CLAUDE.md`.

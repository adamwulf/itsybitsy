# Model-Name Format Proposal — explicit `<cli>:<model>` selector

Status: **DESIGN ONLY — no code changed.** Branch: `agent/agent-0af94b45` (forked from `agent/codex-agent`).
Author: agent-0af94b45 (worker, for codex-agent). Date: 2026-05-30.
Companion docs: `SPEC-CODEX-MODEL.md`, `CODEX-CLI-NOTES.md`, `SETTINGS-HOOKS-RESEARCH.md`.

> **Evidence tags.** Every claim is tagged: `[OFFICIAL: <url>]` (official docs),
> `[code: src/X:N]` (verified in this repo on this branch), `[research: SETTINGS-HOOKS-RESEARCH.md §X]`
> (the merged settings/hooks reference), or `[inference]`. Per the manager's honesty
> directive, no `--help` claim is tagged `[CLI-HELP]` — `claude --help` / `codex --help`
> are blocked by this harness's allowlist, so all flag semantics are cited to official docs.

---

## 1. Executive summary

Today itsybitsy *guesses* which CLI a model belongs to: `resolveCli("o3") → codex`, `resolveCli("opus") → claude`, via a hand-maintained `CODEX_MODELS` set + prefix table `[code: src/agent-cli.ts:43-90]`. That guess is the only thing standing between a user and a mis-routed agent, and it must be re-edited every time OpenAI ships a model. This proposal replaces the guess with an **explicit, self-describing model string**: `"<cli>:<model>"` (e.g. `claude:opus`, `claude:claude-opus-4-7`, `codex:gpt-5.1-codex`, `codex:o3-mini`). The CLI is named, not inferred; a future `gemini` CLI drops in as `gemini:<model>` with **zero resolver edits**. To protect the existing 3256 tests and every meta.json / config default already on disk, I recommend **option (b): keep bare names as a Claude shorthand** (`"opus"` is sugar for `"claude:opus"`), so nothing on disk has to be migrated and Phase 0's `resolveCli("opus") → claude` contract is *preserved by construction*. The codex-guessing machinery (`CODEX_MODELS`, `CODEX_MODEL_PREFIXES`, prefix matching) is **deleted** — a parsed `cli` half is authoritative, so there is nothing left to guess. New surface area is small: a `parseModel()` function, a `KNOWN_CLIS` set for validation, a one-character widening of `isValidModel` to permit `:`, and a scrollable default model set for the settings UI.

---

## 2. Recommendation & reasoning

**Recommended: Option (b) — bare names stay valid as Claude shorthand; the `<cli>:` prefix is required only for non-Claude CLIs.**

| | (a) Deprecate bare names (require `claude:opus` everywhere) | (b) Keep bare names as Claude shorthand ✅ |
|---|---|---|
| Existing meta.json files | Must be rewritten (`model: "opus"` → `"claude:opus"`) — a real migration with failure modes for archived agents | Untouched. `"opus"` parses to `{cli:"claude", model:"opus"}` forever `[inference from grammar below]` |
| `config.ts` defaults (`model`, `coordinator.model` = `"opus"`) `[code: src/config.ts:24,32]` | Must change the default literal + the `VALID_MODELS` allowlist | Defaults stay `"opus"`; still valid |
| User's installed Claude settings (`model: "claude-opus-4-7"`) `[research: SETTINGS-HOOKS-RESEARCH.md §A1]` | Would need `claude:` prefixing | Already valid (bare full-name → claude) |
| Phase 0 tests (`resolveCli("opus") → claude`, 30+ cases) `[code: src/agent-cli.test.ts:6-19]` | Rewritten | **Pass unchanged** |
| Agent-type `.md` `model:` frontmatter | Each must be prefixed | Both forms accepted; nothing to edit (no shipped type sets a model `[code: docs/agent-types/* has no model: line]`) |
| Risk of a stale archived agent failing to parse | High (hard cutover) | None |
| Conceptual cleanliness | Higher (one canonical form) | Slightly lower (two spellings for Claude) |

Reasoning: Adam **already merged Phase 0 with a bare-name `resolveCli`** `[code: src/agent-cli.ts:99-101]`, and the whole point of D1 (`SPEC-CODEX-MODEL.md` §2) was "the model name is the selector, no regression for Claude." Option (b) is the *only* choice that keeps that guarantee literally true: a bare name has always meant Claude, and it continues to. Option (a) buys one canonical spelling at the cost of a disk migration touching every agent dir, every config, and the user's own `~/.claude/settings.json` — a lot of blast radius for cosmetics, against a project rule of "slow is smooth." We can always *display* and *suggest* the canonical `claude:opus` form in the UI (§6) while *accepting* the bare form on input — best of both.

**What happens to Phase 0's `resolveCli`:** it survives as a **thin wrapper** — `resolveCli(model) === parseModel(model).cli` `[inference]`. The bare-name codex-guessing (`CODEX_MODELS` set + prefix matching) is **deleted**, because once a model carries its own `cli:` we never guess; and a *bare* `o3` now resolves to **claude** (the shorthand default), not codex. That is a deliberate, documented behavior change (see §5 and Open Questions Q1) — bare OpenAI names are no longer auto-routed; you write `codex:o3`.

---

## 3. Parsing grammar & validation

### 3.1 Grammar

```
model-string   := qualified | bare
qualified      := cli ":" model-rest
cli            := [A-Za-z][A-Za-z0-9-]*          ; alphanumeric + dash, must start with a letter
model-rest     := <everything after the FIRST ":">   ; greedy to end of string; MAY itself contain ":"
bare           := model-rest-without-leading-cli-colon ; legacy Claude shorthand (no recognised cli prefix)
```

- **Split on the *first* colon, model is greedy-to-end.** `parseModel("codex:gpt-5.1-codex")` → `{cli:"codex", model:"gpt-5.1-codex"}`. If a model id ever contains a colon (e.g. a hypothetical `claude:some:weird:snapshot`), everything after the first colon is the model: `{cli:"claude", model:"some:weird:snapshot"}`. `[inference]` Greedy-to-end is the safe rule because Anthropic's documented `--model` values are bare aliases (`sonnet`/`opus`/`haiku`) or dotted-dashed full names (`claude-opus-4-8`, `claude-opus-4-7`) — none contain colons `[research: SETTINGS-HOOKS-RESEARCH.md §A4, "Sets the model… sonnet, opus, or a model's full name"]` — and Codex `-m` is free-form/server-validated `[OFFICIAL: developers.openai.com/codex/cli/reference, "Override the model set in configuration"]`, so split-on-first-colon never truncates a real id. Split-on-*last*-colon would mis-handle a colon-bearing model; split-on-first is strictly safer.
- **A value with NO colon is a bare name** → treated as `{cli:"claude", model:<value>}` (option (b)). This is the back-compat path: `"opus"`, `"sonnet"`, `"haiku"`, `"claude-opus-4-7"` all parse to claude. `[inference, consistent with code: src/agent-cli.test.ts:6-19]`
- **A leading token that is alphanumeric+dash followed by `:` is a `cli` prefix** — but only if the token *before* the colon is a syntactically valid cli (`[A-Za-z][A-Za-z0-9-]*`). A value like `gpt-3.5-turbo` has no colon → bare → claude; a value like `weird:thing` where `weird` is not in `KNOWN_CLIS` is a *syntactically* qualified string with an *unknown* cli (see §3.3 validation).

### 3.2 `parseModel` — placement & shape

Lives in **`src/agent-cli.ts`** (the existing resolver module, so all CLI-resolution logic stays in one file) `[code: src/agent-cli.ts]`:

```ts
export type AgentCli = "claude" | "codex";          // unchanged today; widened per-CLI later
export const KNOWN_CLIS = new Set<AgentCli>(["claude", "codex"]);
export const DEFAULT_CLI: AgentCli = "claude";

export interface ParsedModel { cli: string; model: string; }

/** Split "<cli>:<model>" (greedy model). No colon ⇒ bare ⇒ {cli: DEFAULT_CLI, model}. */
export function parseModel(input: string): ParsedModel { … }

/** True iff parseModel(input).cli is in KNOWN_CLIS. */
export function isKnownCli(input: string): boolean { … }

/** Thin wrapper kept for back-compat callers. Equivalent to parseModel(model).cli. */
export function resolveCli(model: string): AgentCli { … }
```

### 3.3 Validation rules

1. **Syntactic** (`isValidModel`, used before shell interpolation `[code: src/validation.ts:7-9]`): must currently widen its allowlist `^[a-zA-Z0-9._-]+$` to **also permit `:`** → `^[a-zA-Z0-9._:-]+$`. Without this, *every* qualified model fails validation at `[code: src/ib-commands.ts:2570]` and `[code: src/ib-commands.ts:569]`. This is the single most important code change for the feature to function; the colon is shell-safe (not a metacharacter inside the double-quoted, already-validated interpolations).
2. **Known-CLI** (semantic): after parsing, `parseModel(input).cli` should be checked against `KNOWN_CLIS`.
   - **Recommendation: warn-and-default to Claude for an *unknown* cli, hard-reject only for a *malformed* one.** A genuinely malformed string (fails `isValidModel`) is rejected at spawn (as today). A *well-formed-but-unknown* cli (e.g. `gemini:foo` before a gemini integration exists) should **warn and fall back to launching claude with the whole string as the model**, OR hard-reject — see Open Question Q3. My lean is **hard-reject at spawn with a clear message** ("Unknown CLI 'gemini' in model 'gemini:foo'; known: claude, codex") because silently launching `claude --model gemini:foo` would produce a confusing downstream Claude error, whereas a spawn-time rejection is actionable. Warn-and-default is the gentler choice if Adam prefers never to block a spawn.
3. **Per-CLI model validation:** itsybitsy does **not** validate the model *half* against a server list — both CLIs validate their own models (`codex -m` is server-validated `[OFFICIAL: cli/reference]`; `claude --model` accepts aliases or full names `[research: §A4]`). itsybitsy only enforces the shell-safety allowlist. This keeps us out of the business of tracking every model name — exactly the maintenance burden this proposal removes.

---

## 4. Touchpoints — every place a model string lives today

All line numbers verified on this branch (`agent/agent-0af94b45`) on 2026-05-30.

| # | File:line | What it does today | Under the new design |
|---|---|---|---|
| 1 | `src/agent-cli.ts:43-90` `[code]` | `CODEX_MODELS` set + `CODEX_MODEL_PREFIXES` + boundary-aware prefix match → *guesses* codex vs claude from a bare name | **DELETE** the set, the prefix table, and `isCodexModel`'s prefix logic. Add `parseModel`, `KNOWN_CLIS`, `DEFAULT_CLI`. `resolveCli` → `parseModel(m).cli`. |
| 2 | `src/agent-cli.ts:99-101` `[code]` | `resolveCli(model)` — public API | Kept as a thin wrapper over `parseModel`. Same signature/return type → no caller churn. |
| 3 | `src/validation.ts:7-9` `[code]` | `isValidModel` allowlist `^[a-zA-Z0-9._-]+$` — **rejects `:`** | Widen to `^[a-zA-Z0-9._:-]+$`. **Load-bearing**: without it every qualified model is rejected at spawn/resume. |
| 4 | `src/config.ts:24` `[code]` | `model` default `"opus"` | Unchanged (bare = claude). Optionally re-spell to `"claude:opus"` later for clarity — not required. |
| 5 | `src/config.ts:32` `[code]` | `coordinator.model` default `"opus"` | Unchanged, same reasoning. |
| 6 | `src/config-command.ts:6` `[code]` | `const VALID_MODELS = ["sonnet","opus","haiku"]` — gate for `ib config set model` | Replace with a validator that accepts bare Claude aliases **and** any `parseModel`-parseable `<known-cli>:<model>`. Must accept `codex:gpt-5.1-codex`, `claude:claude-opus-4-7`, etc. (Today it would reject every codex model.) |
| 7 | `src/config-command.ts:74-78` `[code]` | enforces `VALID_MODELS.includes(rawValue)` | Switch to the new validator (parse + known-cli check). |
| 8 | `src/ib-commands.ts:2552-2567` `[code]` | model precedence: `--model > type.model > config.model > "opus"` | Unchanged. The *resolved* string is then `parseModel`d for the spawn branch. |
| 9 | `src/ib-commands.ts:2570` `[code]` | `isValidModel(model)` reject gate (spawn) | Passes now that `:` is allowed (touchpoint #3). Add a `KNOWN_CLIS` check here per §3.3. |
| 10 | `src/ib-commands.ts:2579` `[code]` | `const agentCli = resolveCli(model)` (Phase 0 seam, no branch yet) | Becomes `parseModel(model)` → `{cli, model}`; later phases branch the spawn on `cli` and pass `model` (the *unprefixed* half) to the CLI flag. |
| 11 | `src/ib-commands.ts:3010-3012` `[code]` | spawn: `claudeArgs … --model ${model}` (passes the WHOLE string) | Must pass the **parsed `model` half**, not the raw `claude:opus`. For a claude agent, `claude --model opus`. (Today it would pass `claude:opus` to claude.) |
| 12 | `src/ib-commands.ts:2800` `[code]` | writes `model: model || null` into meta.json | Stores the **raw input string** (`"claude:opus"` or `"opus"`) verbatim — meta is the source of truth and stays human-readable / round-trippable. Parsing happens at read time. |
| 13 | `src/ib-commands.ts:566-591` `[code]` | resume: reads `agent.meta.model`, validates, `claude --resume … --model ${model}` | Same fix as #11: parse, pass the model half to the flag, branch on cli in a later phase. |
| 14 | `src/coordinator.ts:419-436` `[code]` | hard-codes `claude --resume … --model ${model}` / `claude --model ${model}` for the **system coordinator** | Parse `coordinator.model`; pass the model half to `--model`; the coordinator is claude-only for now, but should still strip a `claude:` prefix if present. (Today it would pass `claude:opus` literally.) |
| 15 | `src/hooks/intercept-task.ts:24` `[code]` | `VALID_MODELS = new Set(["sonnet","opus","haiku",""])` — sanitizes the model on a spawned Task | Extend to accept qualified strings (or parse + re-validate the model half). This hook blocks unauthorized **Task** spawns; a codex agent has no Task tool `[research: §PART C, "Codex has no Task tool"]`, so this is a claude-only path — but it must not reject a legitimate `claude:opus`. |
| 16 | `src/hooks/intercept-task.ts:269-304` `[code]` | extracts/validates `model` from the Task tool input | Same as #15 — accept the qualified form. |
| 17 | `src/tui/info-panel.ts:120` `[code]` | renders `Model: ${agent.meta.model}` in the dashboard info panel | Works as-is (shows `claude:opus`). Optionally split into "CLI: codex / Model: gpt-5.1-codex" for clarity — cosmetic, not required. |
| 18 | `src/tui/agent-tree.ts:64,93` `[code]` | renders `agent.meta.model` as a column in the full-mode tree row | Works as-is. A long `codex:gpt-5.1-codex-max` may widen the column — purely cosmetic. |
| 19 | `src/auto-compact.ts:71-85,126-151` `[code]` | `contextSizeForModel(model)` substring-matches `"4-5"`/`"4.5"` to size the context window | A qualified `claude:claude-opus-4-8` still contains the substring, so matching is unaffected; **and** auto-compact is hard-disabled (`AUTO_COMPACT_DISABLED = true`) per CLAUDE.md. No change needed; note it so a future re-enable parses the model half. |
| 20 | `src/tui` setup/config dialog (`dialog-handler.ts:480-499` config tab) `[code]` | edits the `model` config key (free input/select) | The model-picker UX (§6) plugs in here — offer the scrollable default set instead of free text. |
| 21 | `src/agent-types.ts:36,538` `[code]` | `model?: string` frontmatter field, parsed from `<type>.md` | Accept either bare or qualified (§6.3). No shipped type sets a model `[code: docs/agent-types/* has no model: line]`, so nothing to migrate. |
| 22 | Prompt prefixes / message delivery (`src/outbox.ts` `deliverMessage`) `[code: per CLAUDE.md §outbox]` | renders `user.name`, not the model | **Not affected** — message prefixes don't carry the model string. Confirmed: no `meta.model` read in the delivery path. |

**Cross-cutting checklist (CLAUDE.md) for this design-only change:** (1) *Agent functionality* — only the model *string format* changes; spawn/lifecycle shapes are untouched until later phases. (2) *Hooks* — `intercept-task`'s model sanitizer (#15/#16) must accept qualified strings; no other hook reads the model. (3) *Watchdog* — does not read `meta.model`; **not affected**. (4) *`ib watch`/dashboard* — info-panel (#17) and agent-tree (#18) display the string verbatim; renders fine, optional cosmetic split later.

---

## 5. Interaction with Phase 0 — what survives, what dies

| Phase 0 artifact `[code: src/agent-cli.ts]` | Fate under this design |
|---|---|
| `export type AgentCli = "claude" \| "codex"` | **Survives.** Reused by `KNOWN_CLIS`/`parseModel`. |
| `CODEX_MODELS` set (`:43-52`) | **DELETED.** No more bare-name guessing. |
| `CODEX_MODEL_PREFIXES` (`:61-66`) + boundary prefix match (`:87-89`) | **DELETED.** The `cli:` prefix is authoritative. |
| `normalizeModel` (`:69-71`) | Trim/lowercase logic is **folded into** `parseModel` (the `cli` half is compared case-insensitively against `KNOWN_CLIS`; the model half is passed through verbatim to preserve case for `claude --model`). |
| `isCodexModel(model)` (`:79-90`) | **Re-implemented** as `parseModel(m).cli === "codex"` — same name, same boolean return, but now driven by the explicit prefix, not a guess. (Or deprecate in favor of `parseModel`; keep if callers exist — none do today outside the test.) |
| `resolveCli(model)` (`:99-101`) | **Survives** as a thin wrapper: `parseModel(model).cli`. Same signature, same `AgentCli` return → zero churn at the call sites (`ib-commands.ts:2579`). |

**Confirming the manager's guess:** yes — "CODEX_MODELS + prefix matching can be DELETED, replaced by `parseModel` + a tiny `KNOWN_CLIS` for validation; `resolveCli` becomes a thin wrapper over `parseModel`." That is exactly the design above. The one nuance to flag explicitly: **a bare `o3` now routes to claude, not codex** (it's Claude shorthand). Phase 0's tests assert bare codex *names* route to codex `[code: src/agent-cli.test.ts:52-87]` — those specific assertions must be **rewritten/removed** (see §7). That is the intended semantic shift, not a regression: under explicit selection you write `codex:o3`.

---

## 6. Settings / user-facing UX

### 6.1 Where the picker lives

Two surfaces touch the model today:
- **`ib config set model <value>`** (CLI) — gated by `VALID_MODELS` `[code: src/config-command.ts:6,74-78]`.
- **The setup/config dialog** in `ib watch` — the "config editing" tab (`handleSetupConfigTab`) edits config keys including `model` `[code: src/tui/dialog-handler.ts:497-498, 480-499]`; the setup-dialog tests already exercise editing the `model` key `[code: src/tui/setup-dialog.test.ts:439-447,512-515]`.

**Recommendation:** turn the `model` (and `coordinator.model`) editor in the config dialog from a free-text input into a **`select` dialog** (itsybitsy already has a `select` dialog type per CLAUDE.md §dialog-system) seeded with the default set below, plus a "Custom…" entry that drops to free-text for power users / pinned snapshots not in the list. The CLI `ib config set model` stays free-form but validates via `parseModel` + `KNOWN_CLIS`.

### 6.2 Default scrollable model set (grouped by CLI)

```
Claude
  claude:opus                          (alias — latest Opus)
  claude:sonnet                        (alias — latest Sonnet)
  claude:haiku                         (alias — latest Haiku)
  claude:claude-opus-4-8               (pinned)
  claude:claude-opus-4-7               (pinned — the user's current settings default) [research: §A1]
  claude:claude-sonnet-4-6             (pinned)
  claude:claude-haiku-4-5-20251001     (pinned snapshot)

Codex
  codex:gpt-5-codex
  codex:gpt-5.1-codex
  codex:gpt-5.1-codex-max
  codex:gpt-5.1-codex-mini
  codex:o3
  codex:o3-mini
  codex:o4-mini
```

The Codex group is grounded in the installed binary's model cache (`gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-min`, `gpt-5.1-codex-mini`, plus reasoning models `o3`/`o3-mini`/`o4-mini`/`o3-pro`) `[research: SETTINGS-HOOKS-RESEARCH.md — manager note quoting ~/.codex/models_cache.json]`. I dropped `gpt-5.1-codex-min` from the *default* list (it's the same family as `-mini`, likely an internal/short variant) and omitted `o3-pro` to keep the default scroll short — both remain selectable via "Custom…". The Claude pinned list matches the Phase-0 test's own enumeration of valid Claude models `[code: src/agent-cli.test.ts:6-14]` and the model IDs in the environment block. The bare aliases stay first in each group because they're the zero-friction default and remain valid under option (b).

### 6.3 User-extensible vs code-only

**Recommendation: ship the default set in code, but make it *augmentable* via an optional `config.json` `models: string[]` array** `[inference]`. Rationale: OpenAI/Anthropic ship models faster than itsybitsy releases; a code-only list reintroduces exactly the maintenance treadmill this proposal removes. The picker would render `[...DEFAULT_MODELS, ...config.models]` (deduped). This is a *display/convenience* list only — it never gates what's *valid* (validity is `parseModel` + `KNOWN_CLIS` + `isValidModel`), so an unlisted `claude:claude-opus-4-9` still works the moment it exists, with no edit. (This mirrors the SPEC's own "config.json override for the codex model set is a later nicety" note — here it's even lower-stakes because it's cosmetic, not semantic.) Defer the actual `models` config key to the implementation phase; not required for correctness.

### 6.4 Agent-type frontmatter `model:`

Given option (b), `<type>.md` `model:` frontmatter **accepts either bare or qualified** `[inference, consistent with code: src/agent-types.ts:538]`. A type author can write `model: opus` (claude) or `model: codex:o3-mini`. Validation reuses the same `parseModel`/`isValidModel` path at agent-creation time. No shipped type sets a model today `[code: docs/agent-types/*]`, so this is purely additive.

---

## 7. Effect on tests — what changes, what stays

The feature must keep all existing tests green (3256 today per the manager; CLAUDE.md cites 3085). Only **`src/agent-cli.test.ts`** has assertions that *intentionally invert* under explicit selection:

**Stays green unchanged** (these encode the option-(b) contract and are *desirable* to keep):
- `claudeModels` block (`opus`/`sonnet`/`haiku`/`claude-opus-4-8`/… → claude) `[code: src/agent-cli.test.ts:6-19]` — still true; bare = claude.
- `empty/whitespace → claude` `[code: :44-50]` — still true (bare empty → default cli claude).
- `gpt-4`, `gemini-pro`, `llama-3`, `totally-made-up-model` → claude `[code: :22-42]` — still true; no recognised `cli:` prefix → bare → claude.

**Must be rewritten** (they assert the *guessing* that this design removes):
- `known codex models -> codex (exact)` `[code: :52-68]`: `resolveCli("gpt-5-codex") → codex` becomes `→ claude` (bare). Rewrite to `resolveCli("codex:gpt-5-codex") → codex`.
- `codex prefix variants -> codex` `[code: :70-87]`: same inversion → rewrite each to the `codex:` form.
- `boundary-aware prefix matching` `[code: :89-106]`: the whole boundary-matching concern **disappears** with the prefix table; delete this block (or repurpose to assert `codex:o35` → codex, claude:… → claude, i.e. the cli half is taken literally).
- `case-insensitive matching` / `whitespace tolerance` `[code: :108-133]`: keep but re-target — the **cli half** is case-insensitive (`Codex:o3` → codex) and whitespace-trimmed; the **model half** is preserved verbatim. Rewrite assertions accordingly.
- `isCodexModel` block `[code: :141-190]` and `isCodexModel and resolveCli agree` `[code: :192-229]`: re-target to qualified inputs.

**New tests to add** (Phase 0.5): `parseModel` grammar (split-on-first-colon, greedy model, colon-in-model, bare → claude, unknown-cli detection), `isValidModel` accepts `:`, `KNOWN_CLIS` membership, round-trip `meta.model` stores raw string.

**No other test file should break**, because: (a) `config.ts` defaults are unchanged (option b); (b) `intercept-task`/`config-command` `VALID_MODELS` widen to a *superset* of today's accepted values, so previously-accepted strings still pass; (c) info-panel/agent-tree render the string verbatim and their tests assert presence of `meta.model`, not a specific format `[code: src/tui/info-panel.test.ts, agent-tree]`. The implementer must run `bun test` + `bunx tsc --noEmit` and confirm zero new failures beyond the intentional `agent-cli.test.ts` rewrites.

---

## 8. Effect on the phased SPEC — proposed **Phase 0.5**

This proposal slots in as **Phase 0.5**, between Phase 0 (already merged) and Phase 2/3 (the codex config writer + spawn branch), so those phases consume a deterministic, explicit `cli` instead of an inferred one. **Phase 1 (the manual interactive-deny verification spike) is unaffected** — it's about codex runtime behavior, not model naming. Phases 2/3 *benefit*: the spawn branch reads `parseModel(model).cli` (authoritative) and passes `parseModel(model).model` to the CLI flag.

### Phase 0.5 — Explicit `<cli>:<model>` selector

**Code that lands (design intent for the implementer):**
1. `src/agent-cli.ts`: add `parseModel`, `KNOWN_CLIS`, `DEFAULT_CLI`; delete `CODEX_MODELS`/`CODEX_MODEL_PREFIXES`/prefix-matching; reduce `resolveCli` to `parseModel(m).cli`; re-base `isCodexModel` on the parsed cli.
2. `src/validation.ts`: widen `isValidModel` to allow `:` (`^[a-zA-Z0-9._:-]+$`).
3. `src/ib-commands.ts`: at the spawn (`:3010-3012`) and resume (`:586-591`) seams, pass `parseModel(model).model` to `--model` (not the raw string); add a `KNOWN_CLIS` check after `isValidModel` (`:2570`); store the **raw** string in meta (`:2800`, unchanged).
4. `src/coordinator.ts:419-436`: strip a leading `claude:` from `coordinator.model` before `--model`.
5. `src/config-command.ts` + `src/hooks/intercept-task.ts`: replace the hard-coded `VALID_MODELS` allowlists with `parseModel`+`KNOWN_CLIS` validation (accept bare Claude + any known-cli qualified).
6. (Optional, can defer) settings dialog `model` editor → `select` with the §6.2 default set + "Custom…".

**Cutover for existing meta.json / config:** **none.** Option (b) means every on-disk `"opus"`/`"claude-opus-4-7"`/`"sonnet"` already parses correctly. No migration script, no archived-agent risk. (If Adam later chooses option (a), a separate migration phase rewrites `meta.model` across all agent dirs + both config defaults + the user's settings — explicitly *not* part of Phase 0.5.)

**Verification / acceptance gates:**
- `bun test` — green. The only edits are the intentional `agent-cli.test.ts` rewrites (§7) + new `parseModel` tests; every other test must stay green untouched.
- `bunx tsc --noEmit` — **zero** errors.
- **No claude-agent regression:** spawning with a bare `opus` (or `claude:opus`) produces a byte-identical `claude --model opus …` launch line vs today (assert in a test that `parseModel("opus").model === "opus"` and `parseModel("claude:opus").model === "opus"`). The generated `start.sh` for a claude agent is unchanged.
- **Codex routing:** `parseModel("codex:gpt-5.1-codex")` → `{cli:"codex", model:"gpt-5.1-codex"}` (unit test), giving Phases 2/3 a deterministic cli with no inference.
- **Unknown cli:** `parseModel("gemini:x").cli === "gemini"`, `isKnownCli("gemini:x") === false`, and (per the §3.3 decision) spawn rejects with a clear message.

---

## 9. Open questions for Adam

1. **Bare OpenAI names lose auto-routing.** Under option (b), bare `o3` / `gpt-5-codex` now resolve to **claude**, not codex (you must write `codex:o3`). Phase 0 deliberately routed those to codex. Confirm this is the intended trade — explicit-over-magic — and that no workflow relies on bare codex names. (My recommendation: yes, accept it; it's the whole point.)
2. **Option (a) vs (b) final call.** I recommend (b) (no migration, keeps Phase 0's contract). If you want the single canonical `claude:opus` form on disk, that's option (a) + a migration phase — say the word and I'll spec the migration.
3. **Unknown-CLI policy: hard-reject vs warn-and-default?** My lean is hard-reject at spawn (`Unknown CLI 'gemini'…`) because silently launching claude with a `gemini:…` model produces a confusing downstream error. Warn-and-default-to-claude is the gentler option. Your call.
4. **Display the canonical form in the UI even when bare is stored?** e.g. info-panel shows `claude:opus` for a `meta.model` of `"opus"`. Nice for clarity, tiny extra code. Want it?
5. **`config.json models: string[]` augment list — in Phase 0.5 or deferred?** It's cosmetic (validity never depends on it). I'd defer to keep Phase 0.5 small.
6. **Should `coordinator.model` and the per-repo coordinators ever be non-claude?** Today the coordinator launch is claude-only `[code: src/coordinator.ts:434-436]`. Phase 0.5 just makes it *parse* a `claude:` prefix; full codex-coordinator support would be a later phase.

---

## 10. Summary of the one change that matters most

If only one thing lands first: **widen `isValidModel` to allow `:`** `[code: src/validation.ts:7-9]`. Without it, every qualified model string is rejected at the spawn/resume validation gates and the whole format is dead on arrival. Everything else (parsing, deletion of the guess table, UX) builds on that one-character allowlist change.

/**
 * Model → CLI resolution (SPEC-CODEX-MODEL.md §5.1).
 *
 * itsybitsy launches one of two underlying agent CLIs depending on the agent's
 * `model` name (Decision D1: the model name IS the selector — there is no
 * separate `cli` meta field). OpenAI's Codex CLI model names route to `codex`;
 * everything else (and every unknown model) routes to `claude`.
 *
 * This is the single source of truth for "which CLI runs this model." Callers in
 * the spawn / resume / state / watchdog code consult `resolveCli(meta.model)`
 * instead of hardcoding `claude`.
 *
 * Claude is the default for EVERY model that is not a known Codex model, so
 * adding this resolver introduces no regression for existing Claude agents.
 */

export type AgentCli = "claude" | "codex";

/**
 * Known OpenAI Codex CLI model names.
 *
 * Matching is done two ways (see `isCodexModel`):
 *   1. Exact name match against this set (case-insensitive, whitespace-trimmed).
 *   2. Sensible prefix match against `CODEX_MODEL_PREFIXES` so versioned /
 *      dated / sized variants of the same family (e.g. `gpt-5-codex-2025-xx`,
 *      `o3-mini`, `o4-mini-high`) resolve to codex without enumerating each one.
 *
 * Keep this list in one place so it is trivial to extend as OpenAI ships new
 * Codex models. A `config.json` override (e.g. `codexModels: string[]`) is a
 * deliberate later nicety — NOT part of Phase 0.
 *
 * Pinned to the model families current as of Codex CLI v0.135.0 (2026-05-30):
 *   - gpt-5-codex     (the dedicated Codex model family)
 *   - o3 / o3-mini    (OpenAI reasoning models usable via `codex -m`)
 *   - o4-mini         (OpenAI reasoning model usable via `codex -m`)
 */
const CODEX_MODELS: ReadonlySet<string> = new Set([
  "gpt-5-codex",
  "o3",
  "o3-mini",
  "o4-mini",
]);

/**
 * Prefixes that mark a model as Codex even when the exact name is not in
 * `CODEX_MODELS` (covers versioned / dated / sized variants of each family).
 * Compared case-insensitively against the trimmed, lowercased model name.
 *
 * Ordering / specificity does not matter — any match means "codex".
 */
const CODEX_MODEL_PREFIXES: readonly string[] = [
  "gpt-5-codex", // gpt-5-codex, gpt-5-codex-2025-xx-xx, gpt-5-codex-high, …
  "o3", // o3, o3-mini, o3-pro, …
  "o4-mini", // o4-mini, o4-mini-high, …
];

/** Normalize a raw model string for matching: trim surrounding whitespace, lowercase. */
function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * True iff `model` is a known OpenAI Codex CLI model (exact or prefix match).
 *
 * Case-insensitive and tolerant of surrounding whitespace. Empty / whitespace-
 * only input is NOT a Codex model (→ false → resolves to claude default).
 */
export function isCodexModel(model: string): boolean {
  const normalized = normalizeModel(model);
  if (!normalized) return false;
  if (CODEX_MODELS.has(normalized)) return true;
  return CODEX_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Resolve which CLI should run a given model.
 *
 * Returns `"codex"` iff the model is a known Codex model (see `isCodexModel`);
 * otherwise `"claude"`. Claude is the default for every unknown / Claude model
 * so existing agents are never re-routed.
 */
export function resolveCli(model: string): AgentCli {
  return isCodexModel(model) ? "codex" : "claude";
}

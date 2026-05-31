/**
 * Static discovery + spawn-time validation list of model selectors.
 *
 * This list serves two purposes:
 *
 * 1. **Discovery** — `ib list-models` renders these so users can see what to
 *    pass to `--model`.
 * 2. **Spawn-time validation** — `newAgent()` rejects `codex:<model>` requests
 *    whose model is not in this list, BEFORE launching the codex CLI. This
 *    prevents the half-broken "agent sits in unknown state after HTTP 400"
 *    failure mode (see bug report 2026-05-31, agent-26165de0 in muse-ios).
 *
 * Maintenance:
 * - Add a new codex entry when codex CLI gains support for a new model AND
 *   that model is confirmed reachable on the typical ChatGPT-plan account
 *   (visible in `~/.codex/models_cache.json`). API-key-only models may still
 *   be reachable for some users; if you add such a model, document the
 *   account-plan caveat in the `description`.
 * - The claude side can be updated as Anthropic announces new model IDs.
 *
 * Validation rules live in `parseModel`/`KNOWN_CLIS` (src/agent-cli.ts); the
 * round-trip between this list and `parseModel` is guarded by
 * known-models.test.ts.
 */

import type { AgentCli } from "./agent-cli";

export interface KnownModel {
  cli: AgentCli;
  model: string;
  description?: string;
}

export const KNOWN_MODELS: KnownModel[] = [
  // Claude
  { cli: "claude", model: "opus", description: "Alias — current Opus" },
  { cli: "claude", model: "sonnet", description: "Alias — current Sonnet" },
  { cli: "claude", model: "haiku", description: "Alias — current Haiku" },
  { cli: "claude", model: "claude-opus-4-7", description: "Opus 4.7" },
  { cli: "claude", model: "claude-opus-4-8", description: "Opus 4.8" },
  { cli: "claude", model: "claude-sonnet-4-6", description: "Sonnet 4.6" },
  { cli: "claude", model: "claude-haiku-4-5-20251001", description: "Haiku 4.5" },
  // Codex — restricted to models reachable on a typical ChatGPT-plan account
  // (verified against ~/.codex/models_cache.json, codex-cli 0.135.0 + ChatGPT
  // auth). API-key-only models (e.g. gpt-5.3-codex) are intentionally omitted
  // because they fail with HTTP 400 on ChatGPT plans, producing the
  // half-broken "agent stuck in unknown state" failure mode. If you add a
  // model here, confirm it works for the typical account; otherwise users
  // hit the same bug we just fixed.
  { cli: "codex", model: "gpt-5.5", description: "Frontier — complex coding, computer use, research" },
  { cli: "codex", model: "gpt-5.4-mini", description: "Fast/efficient mini — responsive coding + subagents" },
  { cli: "codex", model: "codex-auto-review", description: "Codex review specialist" },
];

/**
 * Returns true iff `<cli>:<model>` matches an entry in KNOWN_MODELS.
 *
 * Used by `newAgent()` to reject unknown codex model names BEFORE launching
 * the codex CLI. The check is case-sensitive on the model half (codex model
 * names use lowercase + digits + dots/hyphens) and exact-match on the cli
 * half. Callers should `parseModel()` first to normalize the cli half;
 * `isKnownModel` doesn't reparse.
 */
export function isKnownModel(parsed: { cli: AgentCli; model: string }): boolean {
  return KNOWN_MODELS.some((entry) => entry.cli === parsed.cli && entry.model === parsed.model);
}

/**
 * Returns the list of `<cli>:<model>` selectors known for a given CLI, used
 * in error messages so the user can pick a valid alternative without running
 * `ib list-models` separately.
 */
export function listKnownSelectorsForCli(cli: AgentCli): string[] {
  return KNOWN_MODELS.filter((entry) => entry.cli === cli).map((entry) => `${entry.cli}:${entry.model}`);
}

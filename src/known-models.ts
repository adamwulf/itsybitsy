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
 * - The codex side is sourced from https://developers.openai.com/codex/models
 *   (last refresh: commit 6f6e35d, 2026-05-31). Refresh when OpenAI updates
 *   that page.
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
  // Codex — sourced from https://developers.openai.com/codex/models (2026-05-31)
  // NOTE: gpt-5.3-codex was previously listed but is intentionally omitted —
  // bug repro (agent-26165de0 in muse-ios, 2026-05-31) confirmed the codex
  // CLI rejects it with HTTP 400 "not supported when using Codex with a
  // ChatGPT account". The remaining entries are believed reachable but have
  // not been individually account-tested; an API-key-only model would still
  // surface a runtime HTTP 400 at first prompt rather than a spawn-time
  // rejection (residual risk we accept — the upstream page is our truth).
  { cli: "codex", model: "gpt-5.5", description: "Frontier — complex coding, computer use, research" },
  { cli: "codex", model: "gpt-5.4", description: "Flagship — strong reasoning + tool use" },
  { cli: "codex", model: "gpt-5.4-mini", description: "Fast/efficient mini — responsive coding + subagents" },
  { cli: "codex", model: "gpt-5.3-codex-spark", description: "Preview — near-instant real-time iteration (text-only)" },
  { cli: "codex", model: "gpt-5.2", description: "Legacy — previous general-purpose coding/agentic model" },
  // Sakana Fugu — launched by Codex with Sakana's OpenAI-compatible Responses
  // API. These are intentionally short selector aliases; `fugu:ultra` maps to
  // Sakana's API model id `fugu-ultra` in fuguCodexModelId().
  { cli: "fugu", model: "fugu", description: "Sakana Fugu — routed multi-agent model" },
  { cli: "fugu", model: "ultra", description: "Sakana Fugu Ultra — higher-capability routed model" },
];

/** Map an itsybitsy Fugu selector to Sakana's API model ID. */
export function fuguCodexModelId(model: string): string {
  switch (model) {
    case "fugu": return "fugu";
    case "ultra": return "fugu-ultra";
    default: throw new Error(`Unknown Fugu model selector: ${model}`);
  }
}

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

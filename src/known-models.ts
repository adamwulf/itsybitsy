/**
 * Static discovery list of model selectors.
 *
 * `ib list-models` renders these so users can see common selectors to pass to
 * `--model`. This is not a spawn-time allow-list: Codex model availability
 * changes faster than ib releases, and ChatGPT-plan vs API-key codex accounts
 * can expose different model sets. `newAgent()` validates selector syntax, then
 * passes the model half through to the underlying CLI.
 *
 * Maintenance:
 * - The codex side is sourced from https://developers.openai.com/codex/models.
 *   Refresh when OpenAI updates that page.
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
  // Codex — sourced from https://developers.openai.com/codex/models.
  { cli: "codex", model: "gpt-5.6-sol", description: "Flagship GPT-5.6 — complex coding, computer use, research, cybersecurity" },
  { cli: "codex", model: "gpt-5.6-terra", description: "Balanced GPT-5.6 — everyday work, strong reasoning + tool use" },
  { cli: "codex", model: "gpt-5.6-luna", description: "Fast GPT-5.6 — repeatable tasks at lower cost" },
  { cli: "codex", model: "gpt-5.5", description: "Previous-generation frontier — complex coding, computer use, research" },
  { cli: "codex", model: "gpt-5.4", description: "Frontier — strong reasoning + tool use" },
  { cli: "codex", model: "gpt-5.4-mini", description: "Fast/efficient mini — responsive coding + subagents" },
  { cli: "codex", model: "gpt-5.3-codex-spark", description: "Preview — near-instant real-time iteration (text-only)" },
  // Sakana Fugu — launched by Codex with Sakana's OpenAI-compatible Responses
  // API. The model half of the selector is the verbatim Sakana API model id,
  // passed straight through to `codex -m` exactly like the `codex:` cli does
  // (no remapping).
  { cli: "fugu", model: "fugu", description: "Sakana Fugu — routed multi-agent model" },
  { cli: "fugu", model: "fugu-ultra", description: "Sakana Fugu Ultra — higher-capability routed model" },
];

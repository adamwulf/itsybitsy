/**
 * Static discovery layer — validation lives in parseModel/KNOWN_CLIS
 * (src/agent-cli.ts); round-trip guarded by known-models.test.ts.
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
  { cli: "codex", model: "gpt-5.5", description: "Frontier — complex coding, computer use, research" },
  { cli: "codex", model: "gpt-5.4", description: "Flagship — strong reasoning + tool use" },
  { cli: "codex", model: "gpt-5.4-mini", description: "Fast/efficient mini — responsive coding + subagents" },
  { cli: "codex", model: "gpt-5.3-codex", description: "Industry-leading coding model" },
  { cli: "codex", model: "gpt-5.3-codex-spark", description: "Preview — near-instant real-time iteration (text-only)" },
  { cli: "codex", model: "gpt-5.2", description: "Legacy — previous general-purpose coding/agentic model" },
];

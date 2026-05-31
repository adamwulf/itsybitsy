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
  // Codex
  { cli: "codex", model: "gpt-5-codex" },
  { cli: "codex", model: "gpt-5.1-codex" },
  { cli: "codex", model: "gpt-5.1-codex-mini" },
  { cli: "codex", model: "o3-mini" },
  { cli: "codex", model: "o3-pro" },
  { cli: "codex", model: "o4-mini" },
  { cli: "codex", model: "o4-mini-high" },
];

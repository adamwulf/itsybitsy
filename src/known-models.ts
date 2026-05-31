/**
 * Curated list of `<cli>:<model>` selectors known to work with each underlying
 * agent CLI. Static — no probing, no runtime detection. Surfaced by
 * `ib list-models` so users can discover valid selectors without grepping the
 * source.
 *
 * This is the DISCOVERY layer. Validation lives in `parseModel` / `KNOWN_CLIS`
 * (src/agent-cli.ts); a known-model name that fails parseModel is a bug —
 * src/known-models.test.ts guards that round-trip.
 */

import type { AgentCli } from "./agent-cli";

export interface KnownModel {
  cli: AgentCli;
  model: string;
  /** `<cli>:<model>` — the exact selector accepted by `ib new-agent --model`. */
  full: string;
  description?: string;
}

export const KNOWN_MODELS: KnownModel[] = [
  // Claude
  { cli: "claude", model: "opus", full: "claude:opus", description: "Alias — current Opus" },
  { cli: "claude", model: "sonnet", full: "claude:sonnet", description: "Alias — current Sonnet" },
  { cli: "claude", model: "haiku", full: "claude:haiku", description: "Alias — current Haiku" },
  { cli: "claude", model: "claude-opus-4-7", full: "claude:claude-opus-4-7", description: "Opus 4.7" },
  { cli: "claude", model: "claude-opus-4-8", full: "claude:claude-opus-4-8", description: "Opus 4.8" },
  { cli: "claude", model: "claude-sonnet-4-6", full: "claude:claude-sonnet-4-6", description: "Sonnet 4.6" },
  { cli: "claude", model: "claude-haiku-4-5-20251001", full: "claude:claude-haiku-4-5-20251001", description: "Haiku 4.5" },
  // Codex
  { cli: "codex", model: "gpt-5-codex", full: "codex:gpt-5-codex" },
  { cli: "codex", model: "gpt-5.1-codex", full: "codex:gpt-5.1-codex" },
  { cli: "codex", model: "gpt-5.1-codex-mini", full: "codex:gpt-5.1-codex-mini" },
  { cli: "codex", model: "o3-mini", full: "codex:o3-mini" },
  { cli: "codex", model: "o3-pro", full: "codex:o3-pro" },
  { cli: "codex", model: "o4-mini", full: "codex:o4-mini" },
  { cli: "codex", model: "o4-mini-high", full: "codex:o4-mini-high" },
];

/**
 * Model → CLI resolution (SPEC-CODEX-MODEL.md §5.1).
 *
 * itsybitsy launches one of two underlying agent CLIs depending on the agent's
 * `model` name. Per Decision D1 the model string is ALWAYS the explicit form
 * `<cli>:<model>` (e.g. `claude:opus`, `claude:claude-opus-4-7`,
 * `codex:gpt-5.1-codex`, `codex:o3-mini`). The CLI is NAMED, never inferred —
 * there is no hidden model→CLI guessing table. Bare names (`opus`, `o3`) are
 * rejected as invalid (D1/D5: no back-compat).
 *
 * This is the single source of truth for "which CLI runs this model." Callers in
 * the spawn / resume / state / watchdog code consult `parseModel(meta.model)`
 * (or the thin `resolveCli` / `isCodexModel` wrappers) instead of hardcoding
 * `claude`.
 */

/**
 * The selector prefix in an agent model string. `fugu` is Codex-backed, but
 * remains a distinct selector so agent-type files can express the provider
 * explicitly (`fugu:fugu`, `fugu:fugu-ultra`).
 */
export type AgentCli = "claude" | "codex" | "fugu";

/** The set of CLIs itsybitsy knows how to launch. */
export const KNOWN_CLIS: ReadonlySet<AgentCli> = new Set<AgentCli>(["claude", "codex", "fugu"]);

/** True when the selector is launched by the Codex CLI rather than Claude. */
export function isCodexBackedCli(cli: AgentCli): boolean {
  return cli === "codex" || cli === "fugu";
}

/** A parsed `<cli>:<model>` string: the resolved CLI and the verbatim model half. */
export interface ParsedModel {
  cli: AgentCli;
  model: string;
}

/** A syntactically valid cli token: starts with a letter, then alphanumeric + dash. */
const CLI_TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Parse a `<cli>:<model>` model string (SPEC-CODEX-MODEL.md §5.1).
 *
 * Rules:
 *   - Split on the FIRST colon; the model half is greedy-to-end (everything
 *     after the first `:`) and is preserved VERBATIM (case + any further colons).
 *   - The cli half is whitespace-trimmed and compared case-insensitively against
 *     `KNOWN_CLIS`.
 *
 * Throws a typed `Error` on:
 *   - missing colon (a bare name like `opus`),
 *   - a malformed cli token (must match `^[A-Za-z][A-Za-z0-9-]*$`),
 *   - an unknown cli not in `KNOWN_CLIS` (D6: hard-reject).
 *
 * Examples:
 *   parseModel("claude:opus")           -> { cli: "claude", model: "opus" }
 *   parseModel("codex:gpt-5.1-codex")   -> { cli: "codex",  model: "gpt-5.1-codex" }
 *   parseModel("claude:weird:value")    -> { cli: "claude", model: "weird:value" }
 *   parseModel("opus")                  -> throws (missing colon)
 *   parseModel("gemini:foo")            -> throws (unknown cli)
 */
export function parseModel(input: string): ParsedModel {
  const colon = input.indexOf(":");
  if (colon < 0) {
    throw new Error(
      `Invalid model '${input}': expected '<cli>:<model>' (e.g. 'claude:opus'); known CLIs: claude, codex, fugu`,
    );
  }

  // cli half: whitespace-trimmed, case-insensitive against KNOWN_CLIS.
  const rawCli = input.slice(0, colon).trim();
  // model half: everything after the FIRST colon, verbatim (greedy-to-end).
  const model = input.slice(colon + 1);

  if (!CLI_TOKEN.test(rawCli)) {
    throw new Error(
      `Malformed CLI '${rawCli}' in model '${input}': a CLI name must match ^[A-Za-z][A-Za-z0-9-]*$`,
    );
  }

  const cli = rawCli.toLowerCase();
  if (!KNOWN_CLIS.has(cli as AgentCli)) {
    throw new Error(`Unknown CLI '${cli}' in model '${input}'; known: claude, codex, fugu`);
  }

  return { cli: cli as AgentCli, model };
}

/**
 * Resolve which CLI should run a given model string. Thin wrapper over
 * `parseModel` (D1: the cli is the explicit prefix, never inferred). Throws on
 * an invalid / unknown model string, same as `parseModel`.
 */
export function resolveCli(model: string): AgentCli {
  return parseModel(model).cli;
}

/**
 * True iff `model` is a codex model string (`codex:<model>`). Thin wrapper over
 * `parseModel`; throws on an invalid / unknown model string.
 */
export function isCodexModel(model: string): boolean {
  return isCodexBackedCli(parseModel(model).cli);
}

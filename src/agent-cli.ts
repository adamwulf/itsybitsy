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
 * explicitly (`fugu:fugu`, `fugu:fugu-ultra`). `agy` launches the Antigravity
 * CLI (`agy`) — see SPEC-ANTIGRAVITY-CLI.md.
 */
export type AgentCli = "claude" | "codex" | "fugu" | "agy";

/** The set of CLIs itsybitsy knows how to launch. */
export const KNOWN_CLIS: ReadonlySet<AgentCli> = new Set<AgentCli>(["claude", "codex", "fugu", "agy"]);

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
      `Invalid model '${input}': expected '<cli>:<model>' (e.g. 'claude:opus'); known CLIs: claude, codex, fugu, agy`,
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
    throw new Error(`Unknown CLI '${cli}' in model '${input}'; known: claude, codex, fugu, agy`);
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

/** Legacy absent/bare models belong to Claude; invalid qualified models grant no CLI-specific roots. */
export function metadataCli(model: unknown): AgentCli | undefined {
  if (model == null || model === "" || model === "null") return "claude";
  // Live pre-selector agents used names such as sonnet/opus. readAgentMeta also
  // coerces an absent model to "unknown". This metadata compatibility does not
  // relax parseModel: new spawns still require the qualified selector.
  if (typeof model === "string" && /^[a-zA-Z0-9._-]+$/.test(model)) return "claude";
  try {
    return typeof model === "string" ? parseModel(model).cli : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Describe the kernel sandbox status for display. Sandboxing is now MANDATORY for
 * every supported CLI (claude, codex, fugu, agy), so a wrappable CLI reports the
 * agent's frozen state: "enabled" for a post-mandatory agent, or "disabled" for a
 * legacy agent whose frozen metadata predates it (that agent must be migrated via
 * `ib sandbox refresh` before it can launch again). An unknown CLI has no wrapper.
 */
export function kernelSandboxStatus(meta: { model?: unknown; sandbox?: { enabled?: boolean } }): string {
  const cli = metadataCli(meta.model);
  if (!cli) return "unavailable (unknown CLI)";
  return meta.sandbox?.enabled === true ? "enabled" : "disabled";
}

/**
 * True iff `model` is a codex model string (`codex:<model>`). Thin wrapper over
 * `parseModel`; throws on an invalid / unknown model string.
 */
export function isCodexModel(model: string): boolean {
  return isCodexBackedCli(parseModel(model).cli);
}

/**
 * Map itsybitsy's 5-level effort scale down to codex's `model_reasoning_effort`
 * value set. Codex only understands `low` / `medium` / `high` — it has no
 * `xhigh` / `max` — so the two highest itsybitsy levels collapse onto codex's
 * `high`:
 *
 *   low    -> low
 *   medium -> medium
 *   high   -> high
 *   xhigh  -> high
 *   max    -> high
 *
 * Any unrecognized input (should never happen — the caller validates against
 * `isValidEffort` first) also falls back to `high`, matching the default effort
 * (`xhigh`, which maps to `high`). Keeping the mapping here — next to
 * `parseModel` — means the codex arg-builder (`buildCodexLaunchArgs`) stays a
 * thin `-c` pusher and only ever sees an already-mapped codex value.
 */
export function mapEffortForCodex(effort: string): string {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return "high";
  }
}

/**
 * Map itsybitsy's 5-level effort scale down to the Antigravity CLI's
 * `--effort` value set (SPEC-ANTIGRAVITY-CLI.md D1). `agy` understands only
 * `low` / `medium` / `high` — the same subset as codex — so the two highest
 * itsybitsy levels collapse onto `high`, exactly as `mapEffortForCodex` does.
 * Kept as a distinct function (rather than an alias) so the two CLIs can
 * diverge later without a silent cross-wire.
 */
export function mapEffortForAgy(effort: string): string {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return "high";
  }
}

/**
 * True when an `agy` model slug already encodes a reasoning effort as a
 * trailing `-low` / `-medium` / `-high` segment (e.g. `gemini-3.7-flash-low`).
 * Per D1, itsybitsy passes `--effort <e>` ONLY when the slug does NOT already
 * carry one, because Gemini slugs bake the effort into the name and passing
 * both would be ambiguous.
 */
export function agySlugHasEffort(slug: string): boolean {
  return /-(low|medium|high)$/.test(slug);
}

/**
 * The sentinel `agy` model half meaning "launch agy with NO `--model` and NO
 * `--effort`, so agy uses its OWN configured default model" (currently Gemini
 * 3.8 Flash High). Selected as `agy:default`. Unlike a real slug this is never
 * passed to `--model`: agy rejects an unknown slug with a "model not
 * recognized" warning and falls back to its default anyway, so we omit the flag
 * entirely instead of provoking the warning. Effort is suppressed too — the
 * point of `agy:default` is agy's untouched defaults. `parseModel` still yields
 * `{ cli: "agy", model: "default" }` and `isValidModel("default")` passes, so
 * the selector round-trips like any other.
 */
export const AGY_DEFAULT_MODEL = "default";

/** True when an `agy` model half is the `agy:default` sentinel (see AGY_DEFAULT_MODEL). */
export function isAgyDefaultModel(agyModel: string): boolean {
  return agyModel === AGY_DEFAULT_MODEL;
}

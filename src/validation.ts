/**
 * Input validation helpers for shell-interpolated values.
 * Prevents shell injection by enforcing strict character allowlists.
 */

/**
 * Validate a model string for shell interpolation: alphanumeric, dots, hyphens,
 * underscores, and colons. The colon is needed for the `<cli>:<model>` form
 * (e.g. `claude:opus`, `codex:gpt-5.1-codex`); it is shell-safe (not a
 * metacharacter inside the already-quoted interpolations). This is a
 * syntactic/shell-safety check only — semantic CLI validation is `parseModel`.
 */
export function isValidModel(value: string): boolean {
  return /^[a-zA-Z0-9._:-]+$/.test(value);
}

/**
 * The finite set of reasoning-effort levels the Claude CLI accepts via
 * `--effort <level>` (verbatim from `claude --help`). Codex's
 * `model_reasoning_effort` is a narrower subset (`low`/`medium`/`high`); the
 * itsybitsy-side value is validated against this full set and mapped down for
 * codex by `mapEffortForCodex` in agent-cli.ts.
 */
const VALID_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * Validate an effort level for shell interpolation. Unlike `isValidModel`'s
 * broad character allowlist, effort is a closed enum — so we validate against
 * the known finite set. This is both a semantic check (only real levels) and a
 * shell-safety check (an enum member can't contain a metacharacter). Rejects
 * the empty string, wrong case (`"XHIGH"`), unknown levels (`"extreme"`), and
 * any injection payload (`"high$(whoami)"`).
 */
export function isValidEffort(value: string): boolean {
  return VALID_EFFORT_LEVELS.has(value);
}

/** Validate a comma-separated tool list for --allowedTools / --disallowedTools. */
export function isValidToolList(value: string): boolean {
  // Each token: alphanumeric, underscores, hyphens, asterisks, parens, colons, dots, spaces, slashes, tildes
  return /^[a-zA-Z0-9_*()\-:,. /~]+$/.test(value);
}

/** Validate an agent ID: alphanumeric, hyphens, underscores only. */
export function isValidAgentId(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

/**
 * Peer senders may also be repo coordinators named after a dotted checkout
 * basename: ones created before coordinator ids were sanitized
 * (coordinatorIdFromFolderName), or on a peer that does not sanitize yet.
 */
export function isValidPeerSenderIdSegment(value: string): boolean {
  return value !== "." && value !== ".." && isValidAgentId(value.replaceAll(".", "_"));
}

/**
 * Input-time filter for agent-name fields (new-agent Name field, nickname
 * dialog). Replaces every character outside `[a-zA-Z0-9-]` with `-`. Stricter
 * than `validateAgentName` — the validator also accepts underscore for
 * back-compat with names already on disk — but the input filter only emits
 * what is unambiguously a fresh, idiomatic name.
 */
export function sanitizeAgentNameInput(text: string): string {
  return text.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** Validate a tmux session name: alphanumeric, hyphens, underscores only. */
export function isValidTmuxSession(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

/**
 * Build a tmux `-t` target string that forces exact-match on the session name.
 *
 * tmux's `-t` flag does unambiguous-prefix matching by default, which causes
 * `itsybitsy-foo` to silently match `itsybitsy-foo-codex` if that's the only
 * other match. The `=` modifier forces verbatim matching, with one caveat:
 *
 * - Session-target commands (has-session, kill-session, attach, list-clients)
 *   accept either `=name` or `=name:`.
 * - Window/pane-target commands (capture-pane, send-keys, display-message,
 *   set-option -w, set-hook, resize-window, list-panes, kill-pane) treat
 *   `=name` as a literal session named `=name` and fail with "can't find
 *   pane/session". They require `=name:` so tmux parses it as "exact-match
 *   session, then default window/pane".
 *
 * `=name:` is universally accepted by both kinds of targets, so callers can
 * use this helper everywhere without thinking about the distinction.
 */
export function tmuxSessionTarget(session: string): string {
  return "=" + session + ":";
}

/**
 * Validate a team name: alphanumeric, hyphens, underscores only (same allowlist
 * as agent IDs), bounded to a reasonable length (§16.1 — "a reasonable length
 * cap"). Max 64 chars keeps team names well within any filesystem/display limit
 * while still allowing descriptive names.
 */
export function isValidTeamName(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(value);
}

/**
 * Validate a repo name: same allowlist as team names. Repo names share the
 * flat `@` namespace with team names, so any character that breaks shell
 * tokenization (notably spaces) would break `@<repo>/<agent-id>` addressing.
 */
export function isValidRepoName(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(value);
}

/**
 * The registry name the `ib watch` folder browser gives a folder: lowercased,
 * each run of whitespace turned into "-", then every character outside
 * [a-z0-9_-] dropped. Returns "" when nothing is left. Both the [ Add ] and
 * the [ New Repo ] paths use it, so they name a folder the same way, and
 * cleanMachineName (src/machine-name.ts) applies the same rules to machine
 * names. It lives here, in a module with no imports, so machine-name.ts can
 * use it without importing the registry.
 */
export function repoNameFromFolder(folderName: string): string {
  return folderName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
}

/** Validate a Claude session ID (UUID format): hex digits and hyphens only. */
export function isValidSessionId(value: string): boolean {
  return /^[a-fA-F0-9-]+$/.test(value);
}

/**
 * Validate a filesystem path for shell script interpolation.
 * Rejects null bytes and newlines which can't be safely quoted in shell scripts.
 */
export function isValidShellPath(value: string): boolean {
  if (!value) return false;
  // Null bytes and newlines cannot be safely handled in shell scripts
  return !/[\x00\n\r]/.test(value);
}

/**
 * Single-quote a string for safe interpolation into bash scripts.
 * Uses the standard shell quoting idiom: replace each ' with '\'' then wrap in single quotes.
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Input validation helpers for shell-interpolated values.
 * Prevents shell injection by enforcing strict character allowlists.
 */

/** Validate a Claude model name: alphanumeric, dots, hyphens, underscores only. */
export function isValidModel(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

/** Validate a comma-separated tool list for --allowedTools / --disallowedTools. */
export function isValidToolList(value: string): boolean {
  // Each token: alphanumeric, underscores, hyphens, asterisks, parens, colons, dots, spaces
  return /^[a-zA-Z0-9_*()\-:,. ]+$/.test(value);
}

/** Validate an agent ID: alphanumeric, hyphens, underscores only. */
export function isValidAgentId(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

/** Validate a tmux session name: alphanumeric, hyphens, underscores only. */
export function isValidTmuxSession(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
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

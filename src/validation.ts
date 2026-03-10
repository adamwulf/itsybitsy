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

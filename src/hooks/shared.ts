/**
 * Shared constants and patterns used across hook implementations.
 */

/**
 * Matches agent worktree paths: .ittybitty/agents/<agentId>/repo
 * Capturing group 1 contains the agent ID.
 */
export const AGENT_CWD_PATTERN = /\.ittybitty\/agents\/([^/]+)\/repo(\/|$)/;

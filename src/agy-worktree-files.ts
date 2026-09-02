/**
 * The files itsybitsy writes into an agy agent's worktree (SPEC-ANTIGRAVITY-CLI.md
 * §4.2, D3 + D6): the hooks registration and the always-on rule file. Kept in a
 * tiny neutral module so both the agy config builders and the shared path guard
 * (src/hooks/agent-path.ts) reference one source of truth without a layering
 * cycle (agent-path must not depend on agy-config).
 *
 * These are the agy boundary — if an agent could rewrite them it would disable
 * its own permission gate on the next resume — so agent-path treats them as
 * protected (write-denied, reads allowed), the same as .claude/settings*.json.
 */
export const AGY_WORKTREE_FILES = [
  ".agents/hooks.json",
  ".agents/rules/ittybitty-agent.md",
] as const;

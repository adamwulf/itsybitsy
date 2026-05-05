/**
 * Resolve the default agent type for a repo, used both by the InfoPanel cycle
 * field and the new-agent dialog. Single source of truth: a repo's saved
 * `defaultAgentType` wins when it still exists in `available`; otherwise
 * fall back to `manager`, then to the first available type.
 */
export function resolveDefaultAgentType(
  saved: string | undefined,
  available: string[],
): string {
  if (saved && available.includes(saved)) return saved;
  if (available.includes("manager")) return "manager";
  return available[0] ?? "manager";
}

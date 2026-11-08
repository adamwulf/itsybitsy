/**
 * The names of the two coordinator agent types — the only coordinator-specific
 * type names. Each one names a type file, `docs/agent-types/<name>.md`
 * (embedded) and `~/.itsybitsy/agent-types/<name>.md` (installed). A per-repo
 * coordinator is identified by `meta.agentType === REPO_COORDINATOR_TYPE`
 * alone; meta.json has no separate coordinator flag.
 *
 * Only the TYPE names live here. These other "coordinator" / "system" names are
 * separate and keep their spelling: the reserved agent IDs `coordinator` and
 * `system`, the `ib-coordinator` tmux session, the `@system` / `@<repo>`
 * addresses (`SYSTEM_AGENT_ID`), the `coord` role label, the TUI focus
 * targets, and the `_non_coordinator` layer file.
 */

/** The per-repo coordinator type (`repo-coordinator.md`). Spawned with `ib new-agent --type repo-coordinator`. */
export const REPO_COORDINATOR_TYPE = "repo-coordinator";

/**
 * The system coordinator's type (`system-coordinator.md`): a layer file
 * (`spawnable: false`) that supplies the global `@system` coordinator's model,
 * permissions, paths and prompt body.
 */
export const SYSTEM_COORDINATOR_TYPE = "system-coordinator";

/**
 * Whether `typeName` is one of the two coordinator types. Coordinators get the
 * `_all` layer but skip the `_non_coordinator` layer.
 */
export function isCoordinatorType(typeName: string | undefined): boolean {
  return typeName === REPO_COORDINATOR_TYPE || typeName === SYSTEM_COORDINATOR_TYPE;
}

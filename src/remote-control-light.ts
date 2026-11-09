/** The `ib watch` top-bar light for the system coordinator's Remote Control
 * (SPEC.md §15.5.2). It compares what `system-coordinator.md` asks for with
 * whether the coordinator is running with Remote Control:
 *
 * - **configured**: `system-coordinator.md` has `remoteControl: true` now. It
 *   is resolved with `loadAgentType()`, the same call the launch uses, so a
 *   layer that fails to load counts as off here as it does there.
 * - **launched**: the coordinator's `settings.local.json` exists, parses, and
 *   does not carry `disableRemoteControl: true` (`settingsLaunched`), AND the
 *   coordinator is not stopped. `ensureSystemCoordinator()` writes that file
 *   at every launch and leaves it alone while the session is alive, so it
 *   records how the last launch was configured. A stop leaves the file in
 *   place, so the caller passes the coordinator's stopped state separately.
 *
 * The two files are read in process, never by spawning
 * ({@link readRemoteControlFiles}); combining them with the stopped state
 * ({@link remoteControlStatus}) does no IO, so the dashboard can redo it on
 * every watcher update.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { loadAgentType } from "./agent-types";
import { SYSTEM_COORDINATOR_TYPE } from "./coordinator-type-names";
import { systemCoordinatorSettingsPath } from "./coordinator";

/** null hides the indicator. */
export type RemoteControlLight = "green" | "yellow" | null;

export type RemoteControlState =
  | "off"          // hidden: not configured, and not launched (or the coordinator is stopped)
  | "on"           // green: configured and launched
  | "pending-on"   // yellow: configured, but the running coordinator was launched without it
  | "pending-off"  // yellow: not configured, but the running coordinator was launched with it
  | "stopped";     // yellow: configured, but the coordinator is stopped

/** What the two files say. */
export interface RemoteControlFiles {
  configured: boolean;
  /** The settings file of the last launch does not turn Remote Control off. */
  settingsLaunched: boolean;
}

export interface RemoteControlStatus {
  light: RemoteControlLight;
  state: RemoteControlState;
}

export interface RemoteControlFilesOptions {
  /** Resolves `system-coordinator.md`. Defaults to `loadAgentType("system-coordinator")`.
   *  A throw counts as not configured. */
  loadSystemCoordinatorType?: () => Promise<{ remoteControl?: boolean }>;
  /** The coordinator's settings file. Defaults to `systemCoordinatorSettingsPath()`. */
  settingsPath?: string;
}

const LIGHTS: Record<RemoteControlState, RemoteControlLight> = {
  off: null, on: "green", "pending-on": "yellow", "pending-off": "yellow", stopped: "yellow",
};

/** Far above any settings file itsybitsy writes; a larger file is not read. */
const MAX_SETTINGS_BYTES = 1024 * 1024;

async function configured(opts: RemoteControlFilesOptions): Promise<boolean> {
  try {
    const type = await (opts.loadSystemCoordinatorType ?? (() => loadAgentType(SYSTEM_COORDINATOR_TYPE)))();
    return type.remoteControl === true;
  } catch {
    return false;
  }
}

/** True when the settings file is a readable JSON object without
 *  `disableRemoteControl: true`. Missing, unreadable or malformed is false. */
function settingsLaunched(path: string): boolean {
  let fd: number | undefined;
  try {
    // Never block on a FIFO; read only a regular file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return false;
    const settings: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return false;
    return (settings as Record<string, unknown>).disableRemoteControl !== true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function readRemoteControlFiles(opts: RemoteControlFilesOptions = {}): Promise<RemoteControlFiles> {
  return {
    configured: await configured(opts),
    settingsLaunched: settingsLaunched(opts.settingsPath ?? systemCoordinatorSettingsPath()),
  };
}

/** The light for the files and the coordinator's state. `coordinatorStopped`
 *  must be true only for a coordinator known to be stopped, not one whose
 *  state is unknown or that is being launched. */
export function remoteControlStatus(files: RemoteControlFiles, coordinatorStopped: boolean): RemoteControlStatus {
  const launched = files.settingsLaunched && !coordinatorStopped;
  const state: RemoteControlState = files.configured
    ? (launched ? "on" : coordinatorStopped ? "stopped" : "pending-on")
    : (launched ? "pending-off" : "off");
  return { light: LIGHTS[state], state };
}

/** The help panel's lines for the light, each short enough for the about 48
 *  columns free there. Empty when the light is hidden. */
export function remoteControlDetail(status: RemoteControlStatus): string[] {
  switch (status.state) {
    case "off": return [];
    case "on": return ["on"];
    case "pending-on": return ["turned on in system-coordinator.md;", "restart the coordinator (R) to apply"];
    case "pending-off": return ["turned off in system-coordinator.md;", "still on until the coordinator restarts (R)"];
    case "stopped": return ["on in system-coordinator.md;", "coordinator stopped: start it (R)"];
  }
}

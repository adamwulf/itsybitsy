/** The `ib watch` top-bar light for the system coordinator's Remote Control
 * (SPEC.md §15.5.2). It compares two things, both read in process, never by
 * spawning:
 *
 * - **configured**: `system-coordinator.md` has `remoteControl: true` now. It
 *   is resolved with `loadAgentType()`, the same call the launch uses, so a
 *   layer that fails to load counts as off here as it does there.
 * - **launched**: the coordinator's `settings.local.json` exists, parses, and
 *   does not carry `disableRemoteControl: true`. `ensureSystemCoordinator()`
 *   writes that file at every launch and leaves it alone while the session is
 *   alive, so it records how the running coordinator was started.
 *
 * The file is re-read on every probe, so the probe after a restart sees the
 * file the relaunch wrote.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { loadAgentType } from "./agent-types";
import { SYSTEM_COORDINATOR_TYPE } from "./coordinator-type-names";
import { systemCoordinatorSettingsPath } from "./coordinator";

/** null hides the indicator. */
export type RemoteControlLight = "green" | "yellow" | null;

export type RemoteControlState =
  | "off"          // hidden: neither configured nor launched
  | "on"           // green: configured and launched
  | "pending-on"   // yellow: configured, but the coordinator was launched without it
  | "pending-off"; // yellow: not configured, but the coordinator was launched with it

export interface RemoteControlStatus {
  light: RemoteControlLight;
  state: RemoteControlState;
}

export interface RemoteControlStatusOptions {
  /** Resolves `system-coordinator.md`. Defaults to `loadAgentType("system-coordinator")`.
   *  A throw counts as not configured. */
  loadSystemCoordinatorType?: () => Promise<{ remoteControl?: boolean }>;
  /** The coordinator's settings file. Defaults to `systemCoordinatorSettingsPath()`. */
  settingsPath?: string;
}

const LIGHTS: Record<RemoteControlState, RemoteControlLight> = {
  off: null, on: "green", "pending-on": "yellow", "pending-off": "yellow",
};

/** Far above any settings file itsybitsy writes; a larger file is not read. */
const MAX_SETTINGS_BYTES = 1024 * 1024;

async function configured(opts: RemoteControlStatusOptions): Promise<boolean> {
  try {
    const type = await (opts.loadSystemCoordinatorType ?? (() => loadAgentType(SYSTEM_COORDINATOR_TYPE)))();
    return type.remoteControl === true;
  } catch {
    return false;
  }
}

/** True when the settings file is a readable JSON object without
 *  `disableRemoteControl: true`. Missing, unreadable or malformed is false. */
function launched(path: string): boolean {
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

export async function readRemoteControlStatus(opts: RemoteControlStatusOptions = {}): Promise<RemoteControlStatus> {
  const isConfigured = await configured(opts);
  const isLaunched = launched(opts.settingsPath ?? systemCoordinatorSettingsPath());
  const state: RemoteControlState = isConfigured
    ? (isLaunched ? "on" : "pending-on")
    : (isLaunched ? "pending-off" : "off");
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
  }
}

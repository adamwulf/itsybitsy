import { join } from "path";
import { homedir } from "os";
import { chmod, stat } from "fs/promises";

export type ConfigSource = "user" | "default";
export type ConfigType = "number" | "boolean" | "string" | "string[]";

export interface ConfigKeyDef {
  key: string;
  type: ConfigType;
  default: unknown;
}

export interface ConfigEntry {
  value: unknown;
  source: ConfigSource;
}

export type ConfigResult = Record<string, ConfigEntry>;

export const CONFIG_KEYS: ConfigKeyDef[] = [
  { key: "maxAgents", type: "number", default: 10 },
  { key: "model", type: "string", default: "opus" },
  { key: "createPullRequests", type: "boolean", default: false },
  { key: "allowAgentQuestions", type: "boolean", default: true },
  { key: "autoCompactThreshold", type: "number", default: undefined },
  { key: "externalDiffTool", type: "string", default: undefined },
  { key: "hooks.injectStatus", type: "boolean", default: true },
  { key: "hooks.statusVisible", type: "boolean", default: true },
  { key: "coordinator.model", type: "string", default: "opus" },
  { key: "coordinator.imessage", type: "boolean", default: false },
  { key: "channels.telegram.bot_token", type: "string", default: "" },
  { key: "channels.telegram.chat_id", type: "string", default: "" },
];

function getNestedValue(obj: Record<string, unknown>, dotKey: string): unknown {
  const parts = dotKey.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, dotKey: string, value: unknown): void {
  const parts = dotKey.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (current[part] == null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

export function validateConfigValue(value: unknown, type: ConfigType): boolean {
  switch (type) {
    case "number":
      return typeof value === "number" && !isNaN(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "string[]":
      return Array.isArray(value) && value.every((v: unknown) => typeof v === "string");
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return {};
    return (await file.json()) as Record<string, unknown>;
  } catch { /* expected: file missing or malformed JSON */
    return {};
  }
}

let overrideUserConfigPath: string | undefined;

export function setUserConfigPath(path: string): void {
  overrideUserConfigPath = path;
}

export function resetUserConfigPath(): void {
  overrideUserConfigPath = undefined;
}

export function defaultUserConfigPath(): string {
  return overrideUserConfigPath ?? join(process.env.HOME ?? homedir(), ".itsybitsy", "config.json");
}

export interface ReadConfigOptions {
  userConfigPath?: string;
}

export async function readConfig(options?: ReadConfigOptions): Promise<ConfigResult> {
  const userPath = options?.userConfigPath ?? defaultUserConfigPath();
  const userData = await readJsonFile(userPath);

  const result: ConfigResult = {};

  for (const def of CONFIG_KEYS) {
    const userVal = getNestedValue(userData, def.key);
    if (userVal !== undefined && validateConfigValue(userVal, def.type)) {
      result[def.key] = { value: userVal, source: "user" };
      continue;
    }

    const defaultVal = Array.isArray(def.default) ? [...def.default] : def.default;
    result[def.key] = { value: defaultVal, source: "default" };
  }

  return result;
}

interface DeprecatedConfigKey {
  key: string;
  message: string;
}

const DEPRECATED_CONFIG_KEYS: DeprecatedConfigKey[] = [
  { key: "permissions.manager.allow", message: "Config key 'permissions.manager.allow' is deprecated. Permissions now live in agent type files (~/.itsybitsy/agent-types/). Remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.manager.deny", message: "Config key 'permissions.manager.deny' is deprecated. Permissions now live in agent type files (~/.itsybitsy/agent-types/). Remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.worker.allow", message: "Config key 'permissions.worker.allow' is deprecated. Permissions now live in agent type files (~/.itsybitsy/agent-types/). Remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.worker.deny", message: "Config key 'permissions.worker.deny' is deprecated. Permissions now live in agent type files (~/.itsybitsy/agent-types/). Remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.coordinator.allow", message: "Config key 'permissions.coordinator.allow' is deprecated. Coordinator permissions now live in ~/.itsybitsy/agent-types/coordinator.md frontmatter. Migrate any entries there and remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.coordinator.deny", message: "Config key 'permissions.coordinator.deny' is deprecated. Coordinator permissions now live in ~/.itsybitsy/agent-types/coordinator.md frontmatter. Migrate any entries there and remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.all.allow", message: "Config key 'permissions.all.allow' is deprecated. Move these entries into ~/.itsybitsy/agent-types/_all.md frontmatter under 'permissions.allow:' and remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.all.deny", message: "Config key 'permissions.all.deny' is deprecated. Move these entries into ~/.itsybitsy/agent-types/_all.md frontmatter under 'permissions.deny:' and remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.repo.allow", message: "Config key 'permissions.repo.allow' is deprecated. Move these entries into ~/.itsybitsy/agent-types/_non_coordinator.md frontmatter under 'permissions.allow:' and remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.repo.deny", message: "Config key 'permissions.repo.deny' is deprecated. Move these entries into ~/.itsybitsy/agent-types/_non_coordinator.md frontmatter under 'permissions.deny:' and remove this key from ~/.itsybitsy/config.json." },
];

/**
 * Check for deprecated config keys in the user config file.
 * Returns an array of warning messages for any deprecated keys found with values.
 */
export async function checkDeprecatedConfigKeys(): Promise<string[]> {
  const userPath = defaultUserConfigPath();
  const userData = await readJsonFile(userPath);
  const warnings: string[] = [];
  for (const entry of DEPRECATED_CONFIG_KEYS) {
    const val = getNestedValue(userData, entry.key);
    if (val !== undefined) {
      warnings.push(entry.message);
    }
  }
  return warnings;
}

/**
 * Ensure a config file has mode 0600 (owner read/write only). The bot token
 * lives in this file (Phase 0 decision), so any path that touches the config
 * must enforce the tight perms. Best-effort: failures (e.g. on filesystems
 * that don't support chmod) are swallowed.
 */
export async function ensureConfigFilePerms(filePath: string): Promise<void> {
  try {
    const st = await stat(filePath);
    // Mask is the low 9 bits (mode permissions).
    if ((st.mode & 0o777) !== 0o600) {
      await chmod(filePath, 0o600);
    }
  } catch { /* expected when file is missing or chmod is unsupported */ }
}

export async function writeConfig(filePath: string, key: string, value: unknown): Promise<void> {
  const data = await readJsonFile(filePath);
  setNestedValue(data, key, value);
  await Bun.write(filePath, JSON.stringify(data, null, 2) + "\n");
  await ensureConfigFilePerms(filePath);
}

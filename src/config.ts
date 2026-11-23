import { join } from "path";
import { accountHome, userHome } from "./home";
import { chmod, stat } from "fs/promises";
import { DEFAULT_ATTACHMENT_SETTINGS, resolveTransferLimits, attachmentSettingKey, attachmentSettings, validateAttachmentSetting } from "./peers/transfer-limits";

export type ConfigSource = "user" | "default";
export type ConfigType = "number" | "boolean" | "string" | "string[]";

export interface ConfigKeyDef {
  key: string;
  type: ConfigType;
  default: unknown;
  /** Do not render the stored value in interactive settings or `config list`. */
  sensitive?: boolean;
}

export interface ConfigEntry {
  value: unknown;
  source: ConfigSource;
  /** The Config editor shows the actual value to repair, alongside its constraint. */
  repair?: { value: string; source: ConfigSource; issue: string };
}

export type ConfigResult = Record<string, ConfigEntry>;

export const CONFIG_KEYS: ConfigKeyDef[] = [
  { key: "user.name", type: "string", default: "" },
  { key: "maxAgents", type: "number", default: 10 },
  { key: "model", type: "string", default: "claude:opus" },
  { key: "effort", type: "string", default: "xhigh" },
  { key: "createPullRequests", type: "boolean", default: false },
  { key: "allowAgentQuestions", type: "boolean", default: true },
  { key: "autoCompactThreshold", type: "number", default: undefined },
  { key: "externalDiffTool", type: "string", default: undefined },
  { key: "hooks.injectStatus", type: "boolean", default: true },
  { key: "hooks.statusVisible", type: "boolean", default: true },
  { key: "hooks.injectTimestamp", type: "boolean", default: false },
  { key: "coordinator.imessage", type: "boolean", default: false },
  { key: "coordinator.remoteControlName", type: "string", default: "" },
  { key: "channels.telegram.bot_token", type: "string", default: "" },
  { key: "peering.attachments.maxFileMB", type: "number", default: DEFAULT_ATTACHMENT_SETTINGS.maxFileMB },
  { key: "peering.attachments.maxMessageMB", type: "number", default: DEFAULT_ATTACHMENT_SETTINGS.maxMessageMB },
  { key: "peering.attachments.maxFiles", type: "number", default: DEFAULT_ATTACHMENT_SETTINGS.maxFiles },
  { key: "providers.fugu.api_key", type: "string", default: "", sensitive: true },
  { key: "notifications.sayOnQuestion", type: "boolean", default: true },
  { key: "tree.groupByParent", type: "boolean", default: false },
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

export async function readConfigFileStrict(filePath: string): Promise<Record<string, unknown>> {
  try {
    const data = await Bun.file(filePath).json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a JSON object");
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
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
  return overrideUserConfigPath ?? join(userHome(), ".itsybitsy", "config.json");
}

/** Read this machine's current policy for each attachment request. */
export async function readTransferLimits() {
  const path = overrideUserConfigPath ?? join(accountHome(), ".itsybitsy", "config.json");
  const data = await readConfigFileStrict(path).catch((error: Error) => {
    throw new Error(`Cannot read attachment limits from ${path}: ${error.message}`, { cause: error });
  });
  const { limits, warnings } = resolveTransferLimits(rawAttachmentSettings(data));
  for (const warning of warnings) console.warn(warning);
  return limits;
}

function rawAttachmentSettings(data: Record<string, unknown>) {
  const raw = getNestedValue(data, "peering.attachments");
  return typeof raw === "object" && raw !== null ? raw : {};
}

export interface ReadConfigOptions {
  userConfigPath?: string;
}

export async function readConfig(options?: ReadConfigOptions): Promise<ConfigResult> {
  const userPath = options?.userConfigPath ?? defaultUserConfigPath();
  const userData = await readJsonFile(userPath);

  const raw = rawAttachmentSettings(userData);
  const effective = attachmentSettings(resolveTransferLimits(raw).limits);
  const result: ConfigResult = {};

  for (const def of CONFIG_KEYS) {
    const userVal = getNestedValue(userData, def.key);
    const setting = attachmentSettingKey(def.key);
    if (setting) {
      const value = effective[setting];
      const entry: ConfigEntry = { value, source: userVal === value ? "user" : "default" };
      const edited = userVal === undefined ? def.default : userVal;
      const issue = validateAttachmentSetting(setting, edited, raw);
      if (issue) {
        const display = JSON.stringify(edited);
        entry.repair = { value: display, source: userVal === undefined ? "default" : "user", issue: `${setting} = ${display}. ${issue}` };
      }
      result[def.key] = entry;
      continue;
    }
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
  { key: "coordinator.model", message: "Config key 'coordinator.model' is deprecated. Coordinator model now lives in ~/.itsybitsy/agent-types/system-coordinator.md (the system coordinator) and repo-coordinator.md (per-repo coordinators) frontmatter as 'model: <cli>:<model>'. Migrate the value there and remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.manager.allow", message: "Config key 'permissions.manager.allow' is deprecated. Permissions now live in agent type files (~/.itsybitsy/agent-types/). Remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.manager.deny", message: "Config key 'permissions.manager.deny' is deprecated. Permissions now live in agent type files (~/.itsybitsy/agent-types/). Remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.worker.allow", message: "Config key 'permissions.worker.allow' is deprecated. Permissions now live in agent type files (~/.itsybitsy/agent-types/). Remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.worker.deny", message: "Config key 'permissions.worker.deny' is deprecated. Permissions now live in agent type files (~/.itsybitsy/agent-types/). Remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.coordinator.allow", message: "Config key 'permissions.coordinator.allow' is deprecated. Coordinator permissions now live in ~/.itsybitsy/agent-types/repo-coordinator.md frontmatter. Migrate any entries there and remove this key from ~/.itsybitsy/config.json." },
  { key: "permissions.coordinator.deny", message: "Config key 'permissions.coordinator.deny' is deprecated. Coordinator permissions now live in ~/.itsybitsy/agent-types/repo-coordinator.md frontmatter. Migrate any entries there and remove this key from ~/.itsybitsy/config.json." },
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

export function validateConfigEdit(data: Record<string, unknown>, key: string, value: unknown) {
  const setting = attachmentSettingKey(key);
  return setting && validateAttachmentSetting(setting, value, rawAttachmentSettings(data));
}

export async function writeConfig(filePath: string, key: string, value: unknown): Promise<void> {
  const data = await readConfigFileStrict(filePath);
  const error = validateConfigEdit(data, key, value);
  if (error) throw new Error(error);
  setNestedValue(data, key, value);
  await Bun.write(filePath, JSON.stringify(data, null, 2) + "\n");
  await ensureConfigFilePerms(filePath);
}

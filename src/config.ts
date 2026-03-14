import { join } from "path";
import { homedir } from "os";

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
  { key: "fps", type: "number", default: 10 },
  { key: "createPullRequests", type: "boolean", default: false },
  { key: "allowAgentQuestions", type: "boolean", default: true },
  { key: "autoCompactThreshold", type: "number", default: undefined },
  { key: "externalDiffTool", type: "string", default: undefined },
  { key: "hooks.injectStatus", type: "boolean", default: true },
  { key: "hooks.statusVisible", type: "boolean", default: true },
  { key: "permissions.manager.allow", type: "string[]", default: [] },
  { key: "permissions.manager.deny", type: "string[]", default: [] },
  { key: "permissions.worker.allow", type: "string[]", default: [] },
  { key: "permissions.worker.deny", type: "string[]", default: [] },
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

export async function writeConfig(filePath: string, key: string, value: unknown): Promise<void> {
  const data = await readJsonFile(filePath);
  setNestedValue(data, key, value);
  await Bun.write(filePath, JSON.stringify(data, null, 2) + "\n");
}

import { readConfig, writeConfig, CONFIG_KEYS, validateConfigValue, defaultUserConfigPath, ensureConfigFilePerms, type ConfigKeyDef } from "./config";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { parseModel } from "./agent-cli";

const ARRAY_KEYS = CONFIG_KEYS.filter((k) => k.type === "string[]").map((k) => k.key);
// Keys whose values are model strings: must be the qualified `<cli>:<model>` form (D1/D5).
const MODEL_KEYS = new Set(["model", "coordinator.model"]);

function findKey(key: string): ConfigKeyDef | undefined {
  return CONFIG_KEYS.find((k) => k.key === key);
}

function printAvailableKeys(): void {
  console.error("Available keys: " + CONFIG_KEYS.map((k) => k.key).join(", "));
}

function printArrayKeys(): void {
  console.error("Array keys: " + ARRAY_KEYS.join(", "));
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return {};
    return (await file.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getNestedValue(obj: Record<string, unknown>, dotKey: string): unknown {
  const parts = dotKey.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function deleteNestedValue(obj: Record<string, unknown>, dotKey: string): boolean {
  const parts = dotKey.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (current[part] == null || typeof current[part] !== "object") return false;
    current = current[part] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1]!;
  if (lastKey in current) {
    delete current[lastKey];
    return true;
  }
  return false;
}

async function ensureConfigDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function parseSetValue(key: string, rawValue: string, def: ConfigKeyDef): { value: unknown; error?: string } {
  if (def.type === "number") {
    if (!/^[0-9]+$/.test(rawValue)) {
      return { value: null, error: `'${key}' must be a number, got '${rawValue}'` };
    }
    return { value: parseInt(rawValue, 10) };
  }
  if (def.type === "boolean") {
    if (rawValue !== "true" && rawValue !== "false") {
      return { value: null, error: `'${key}' must be true or false, got '${rawValue}'` };
    }
    return { value: rawValue === "true" };
  }
  if (def.type === "string") {
    if (MODEL_KEYS.has(key)) {
      // Per D1/D5 model strings must be the qualified `<cli>:<model>` form
      // (e.g. "claude:opus", "codex:gpt-5.1-codex"). Bare names ("opus") are
      // rejected; unknown CLIs are rejected with the D6 message.
      try {
        parseModel(rawValue);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          value: null,
          error: `'${key}' must be a qualified '<cli>:<model>' string (e.g. 'claude:opus', 'codex:gpt-5.1-codex'): ${reason}`,
        };
      }
    }
    return { value: rawValue };
  }
  return { value: rawValue };
}

function printHelp(): void {
  console.log("ib config — Manage itsybitsy configuration");
  console.log("");
  console.log("Subcommands:");
  console.log("  list, ls              List all config keys with values and sources");
  console.log("  get <key>             Get value for a config key");
  console.log("  set <key> <value>     Set a scalar config value");
  console.log("  add <key> <value>     Add a value to an array config key");
  console.log("  remove <key> <value>  Remove a value from an array config key");
  console.log("  unset <key>           Remove a key, reverting to default");
  console.log("  help, -h, --help      Show this help");
  console.log("");
  console.log("Available keys:");
  for (const def of CONFIG_KEYS) {
    const defaultStr = def.default === undefined ? "unset" : JSON.stringify(def.default);
    console.log(`  ${def.key.padEnd(30)} ${def.type.padEnd(10)} default: ${defaultStr}`);
  }
  console.log("");
  console.log("Examples:");
  console.log("  ib config set model claude:sonnet");
  console.log("  ib config set maxAgents 5");
  console.log("  ib config set hooks.injectStatus false");
  console.log("  ib config set hooks.injectTimestamp true");
  console.log("  ib config unset model");
  console.log("  ib config get model");
}

export async function runConfigCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
    printHelp();
    return;
  }

  switch (subcommand) {
    case "list":
    case "ls": {
      const config = await readConfig();
      for (const def of CONFIG_KEYS) {
        const entry = config[def.key]!;
        const valueStr = entry.value === undefined ? "" : (Array.isArray(entry.value) ? JSON.stringify(entry.value) : String(entry.value));
        if (entry.value === undefined && entry.source === "default") {
          console.log(`${def.key} = (unset)`);
        } else {
          console.log(`${def.key} = ${valueStr} (${entry.source})`);
        }
      }
      console.log("");
      console.log("Sources: (user) = ~/.itsybitsy/config.json, (default) = built-in default");
      break;
    }

    case "get": {
      const key = args[1];
      if (!key) {
        console.error("Error: key required. Usage: ib config get <key>");
        printAvailableKeys();
        process.exit(1);
      }
      const def = findKey(key);
      if (!def) {
        console.error(`Unknown config key: '${key}'`);
        printAvailableKeys();
        process.exit(1);
      }
      const config = await readConfig();
      const entry = config[key]!;
      if (entry.value === undefined) {
        console.log("");
      } else if (Array.isArray(entry.value)) {
        console.log(JSON.stringify(entry.value));
      } else {
        console.log(String(entry.value));
      }
      break;
    }

    case "set": {
      const key = args[1];
      const rawValue = args[2];
      if (!key || rawValue === undefined) {
        console.error("Error: key and value required. Usage: ib config set <key> <value>");
        process.exit(1);
      }
      const def = findKey(key);
      if (!def) {
        console.error(`Unknown config key: '${key}'`);
        printAvailableKeys();
        process.exit(1);
      }
      if (def.type === "string[]") {
        console.error(`'${key}' is an array key. Use 'ib config add' / 'ib config remove' instead.`);
        process.exit(1);
      }
      const { value, error } = parseSetValue(key, rawValue, def);
      if (error) {
        console.error(error);
        process.exit(1);
      }
      const cfgPath = defaultUserConfigPath();
      await ensureConfigDir(cfgPath);
      await writeConfig(cfgPath, key, value);
      console.log(`Set ${key} = ${rawValue}`);
      break;
    }

    case "add": {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        console.error("Error: key and value required. Usage: ib config add <key> <value>");
        printArrayKeys();
        process.exit(1);
      }
      if (!ARRAY_KEYS.includes(key)) {
        console.error(`'${key}' is not an array key.`);
        printArrayKeys();
        process.exit(1);
      }
      const cfgPath = defaultUserConfigPath();
      await ensureConfigDir(cfgPath);
      const data = await readJsonFile(cfgPath);
      const existing = getNestedValue(data, key);
      const arr = Array.isArray(existing) ? existing as string[] : [];
      if (arr.includes(value)) {
        console.log(`Value '${value}' already exists in ${key}`);
        break;
      }
      arr.push(value);
      await writeConfig(cfgPath, key, arr);
      console.log(`Added '${value}' to ${key}`);
      break;
    }

    case "remove": {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        console.error("Error: key and value required. Usage: ib config remove <key> <value>");
        printArrayKeys();
        process.exit(1);
      }
      if (!ARRAY_KEYS.includes(key)) {
        console.error(`'${key}' is not an array key.`);
        printArrayKeys();
        process.exit(1);
      }
      const cfgPath = defaultUserConfigPath();
      const file = Bun.file(cfgPath);
      if (!(await file.exists())) {
        console.error(`Config file not found: ~/.itsybitsy/config.json`);
        process.exit(1);
      }
      const data = await readJsonFile(cfgPath);
      const existing = getNestedValue(data, key);
      const arr = Array.isArray(existing) ? existing as string[] : [];
      const idx = arr.indexOf(value);
      if (idx === -1) {
        console.log(`Value '${value}' not found in ${key}`);
        break;
      }
      arr.splice(idx, 1);
      await writeConfig(cfgPath, key, arr);
      console.log(`Removed '${value}' from ${key}`);
      break;
    }

    case "unset": {
      const key = args[1];
      if (!key) {
        console.error("Error: key required. Usage: ib config unset <key>");
        process.exit(1);
      }
      const def = findKey(key);
      if (!def) {
        console.error(`Unknown config key: '${key}'`);
        printAvailableKeys();
        process.exit(1);
      }
      const cfgPath = defaultUserConfigPath();
      const file = Bun.file(cfgPath);
      if (!(await file.exists())) {
        console.error(`Config file not found: ~/.itsybitsy/config.json`);
        process.exit(1);
      }
      const data = await readJsonFile(cfgPath);
      const existed = deleteNestedValue(data, key);
      if (!existed) {
        console.log(`Key '${key}' is not set`);
        break;
      }
      await Bun.write(cfgPath, JSON.stringify(data, null, 2) + "\n");
      await ensureConfigFilePerms(cfgPath);
      console.log(`Unset ${key} (reverted to default)`);
      break;
    }

    default:
      console.error(`Error: Unknown subcommand '${subcommand}'`);
      console.error("Run 'ib config --help' for usage.");
      process.exit(1);
  }
}

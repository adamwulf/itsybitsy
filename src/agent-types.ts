/**
 * Agent type definitions: load, parse, and resolve agent types from
 * ~/.itsybitsy/agent-types/<name>/AGENTTYPE.md files.
 *
 * Each file uses YAML frontmatter + markdown body (similar to Claude Code skills).
 */

import { join } from "path";
import { homedir } from "os";

export const AGENT_TYPES_DIR = join(process.env.HOME ?? homedir(), ".itsybitsy", "agent-types");

export interface AgentTypeDefinition {
  name: string;
  description: string;
  canSpawnChildren: boolean;
  canBeParent: boolean;
  permissions: {
    allow: string[];
    deny: string[];
  };
  model?: string;
  coordinator?: boolean;
  promptBody: string;
}

/**
 * Parse YAML frontmatter + markdown body from an agent type file.
 * Expects `---` delimiters around YAML frontmatter.
 */
export function parseAgentTypeFile(content: string): AgentTypeDefinition {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    throw new Error("Agent type file must start with YAML frontmatter (---)");
  }

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) {
    throw new Error("Agent type file has unclosed YAML frontmatter");
  }

  const frontmatterStr = trimmed.substring(3, endIdx).trim();
  const body = trimmed.substring(endIdx + 3).trim();

  // Simple YAML parser for the subset we need
  const frontmatter = parseSimpleYaml(frontmatterStr);

  const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
  if (!name) {
    throw new Error("Agent type file must have a 'name' field in frontmatter");
  }

  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  const canSpawnChildren = frontmatter.canSpawnChildren === true;
  const canBeParent = frontmatter.canBeParent !== undefined ? frontmatter.canBeParent === true : true;
  const model = typeof frontmatter.model === "string" ? frontmatter.model : undefined;
  const coordinator = frontmatter.coordinator === true ? true : undefined;

  // Parse permissions
  const permsRaw = frontmatter.permissions as Record<string, unknown> | undefined;
  const allow = parseStringArray(permsRaw?.allow);
  const deny = parseStringArray(permsRaw?.deny);

  return {
    name,
    description,
    canSpawnChildren,
    canBeParent,
    permissions: { allow, deny },
    model,
    coordinator,
    promptBody: body,
  };
}

/** Parse a value that should be a string array (from YAML list) */
function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * Simple YAML parser that handles the subset we need:
 * - Top-level scalar keys (string, boolean, number)
 * - Top-level object with one level of nesting (permissions.allow/deny)
 * - YAML lists (sequences)
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let currentKey = "";
  let currentObj: Record<string, unknown> | null = null;
  let currentList: string[] | null = null;
  let currentListKey = "";

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // List item (indented with -)
    const listMatch = /^\s+-\s+(.+)$/.exec(line);
    if (listMatch && currentList !== null) {
      currentList.push(listMatch[1]!.trim());
      continue;
    }

    // If we were building a list, save it
    if (currentList !== null) {
      if (currentObj && currentListKey) {
        currentObj[currentListKey] = currentList;
      } else {
        result[currentListKey] = currentList;
      }
      currentList = null;
      currentListKey = "";
    }

    // Nested key (indented, part of an object)
    const nestedMatch = /^(\s{2,})(\w+):\s*(.*)$/.exec(line);
    if (nestedMatch && currentKey && currentObj) {
      const nestedKey = nestedMatch[2]!;
      const nestedVal = nestedMatch[3]!.trim();
      if (nestedVal === "") {
        // Start of a list
        currentList = [];
        currentListKey = nestedKey;
      } else if (nestedVal.startsWith("[")) {
        currentObj[nestedKey] = parseInlineArray(nestedVal);
      } else {
        currentObj[nestedKey] = parseScalar(nestedVal);
      }
      continue;
    }

    // If we were building an object and hit a non-nested line, save it
    if (currentObj) {
      result[currentKey] = currentObj;
      currentObj = null;
      currentKey = "";
    }

    // Top-level key: value
    const topMatch = /^(\w+):\s*(.*)$/.exec(line);
    if (topMatch) {
      const key = topMatch[1]!;
      const val = topMatch[2]!.trim();
      if (val === "") {
        // Could be an object or list — start collecting
        currentKey = key;
        currentObj = {};
      } else if (val.startsWith("[")) {
        // Inline array: [item1, item2]
        result[key] = parseInlineArray(val);
      } else {
        result[key] = parseScalar(val);
      }
    }
  }

  // Flush any remaining list
  if (currentList !== null) {
    if (currentObj && currentListKey) {
      currentObj[currentListKey] = currentList;
    } else {
      result[currentListKey] = currentList;
    }
  }

  // Flush any remaining object
  if (currentObj && currentKey) {
    result[currentKey] = currentObj;
  }

  return result;
}

function parseScalar(val: string): string | boolean | number {
  if (val === "true") return true;
  if (val === "false") return false;
  const num = Number(val);
  if (!isNaN(num) && val !== "") return num;
  // Strip surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

function parseInlineArray(val: string): string[] {
  // Parse [item1, item2, item3]
  const inner = val.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((s) => {
    const trimmed = s.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  });
}

/**
 * Load an agent type definition from disk.
 * Looks in ~/.itsybitsy/agent-types/<name>/AGENTTYPE.md
 */
export async function loadAgentType(typeName: string): Promise<AgentTypeDefinition | null> {
  const filePath = join(AGENT_TYPES_DIR, typeName, "AGENTTYPE.md");
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const content = await file.text();
    return parseAgentTypeFile(content);
  } catch {
    return null;
  }
}

/**
 * Return a built-in agent type definition for the three legacy types.
 */
export function getBuiltinType(typeName: "manager" | "worker" | "coordinator"): AgentTypeDefinition {
  switch (typeName) {
    case "manager":
      return {
        name: "manager",
        description: "Manager agent that can spawn and coordinate sub-agents",
        canSpawnChildren: true,
        canBeParent: true,
        permissions: { allow: [], deny: [] },
        promptBody: "",
      };
    case "worker":
      return {
        name: "worker",
        description: "Worker agent that executes tasks assigned by a manager",
        canSpawnChildren: false,
        canBeParent: false,
        permissions: { allow: [], deny: [] },
        promptBody: "",
      };
    case "coordinator":
      return {
        name: "coordinator",
        description: "Per-repo coordinator that manages agents via ib commands",
        canSpawnChildren: true,
        canBeParent: true,
        coordinator: true,
        permissions: { allow: [], deny: [] },
        promptBody: "",
      };
  }
}

/**
 * Resolve an agent type by name. Tries loading from disk first,
 * then falls back to built-in types for manager/worker/coordinator.
 * Throws for unknown types that aren't found on disk.
 */
export async function resolveAgentType(typeName: string): Promise<AgentTypeDefinition> {
  // Try disk first
  const fromDisk = await loadAgentType(typeName);
  if (fromDisk) return fromDisk;

  // Fall back to built-in types
  if (typeName === "manager" || typeName === "worker" || typeName === "coordinator") {
    return getBuiltinType(typeName);
  }

  throw new Error(`Unknown agent type: '${typeName}'. Create it at ${join(AGENT_TYPES_DIR, typeName, "AGENTTYPE.md")}`);
}

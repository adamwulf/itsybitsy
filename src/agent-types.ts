/**
 * Agent types system: load and parse agent type definitions from ~/.itsybitsy/agent-types/
 */

import { join } from "path";
import { homedir } from "os";
import { Glob } from "bun";

export interface AgentType {
  name: string;
  description: string;
  canSpawnChildren: boolean;
  model?: string;
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  instructionStyle: "manager" | "worker" | "coordinator";
  markdownBody?: string;
}

/**
 * Parse YAML front matter from a markdown file and extract metadata + body.
 * Front matter is between --- delimiters at the start of the file.
 * Supports nested objects (one level deep) and YAML arrays.
 */
export function parseAgentTypeFile(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const lines = content.split("\n");

  // Check if starts with ---
  if (lines[0] !== "---") {
    return { frontmatter: {}, body: content };
  }

  // Find closing ---
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  // Parse YAML-like front matter with support for nested objects
  const fmLines = lines.slice(1, endIdx);
  const frontmatter: Record<string, unknown> = {};

  let currentParent: string | null = null;
  let currentObj: Record<string, unknown> | null = null;

  for (const line of fmLines) {
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    // Check if this is an indented child line (part of a nested object)
    const indentMatch = line.match(/^(\s+)(\S.*)/);
    if (indentMatch && currentParent && currentObj) {
      const childLine = indentMatch[2]!.trim();
      const colonIdx = childLine.indexOf(":");
      if (colonIdx !== -1) {
        const key = childLine.substring(0, colonIdx).trim();
        const valueStr = childLine.substring(colonIdx + 1).trim();
        if (valueStr.startsWith("- ")) {
          // YAML list item as value of parent.key — treat as single-item array start
          currentObj[key] = [valueStr.substring(2).trim().replace(/^["']|["']$/g, "")];
        } else if (valueStr === "") {
          // Empty value in nested context starts a list (e.g. allow:\n    - Read)
          currentObj[key] = [];
        } else {
          currentObj[key] = parseSimpleValue(valueStr);
        }
        continue;
      }
      // Could be a YAML list item (- value) under a key
      if (childLine.startsWith("- ")) {
        // Append to the last key in currentObj
        const lastKey = Object.keys(currentObj).pop();
        if (lastKey && Array.isArray(currentObj[lastKey])) {
          (currentObj[lastKey] as unknown[]).push(childLine.substring(2).trim().replace(/^["']|["']$/g, ""));
        }
        continue;
      }
    }

    // Top-level key
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim();
    const valueStr = trimmed.substring(colonIdx + 1).trim();

    // If value is empty, this starts a nested object
    if (valueStr === "") {
      currentParent = key;
      currentObj = {};
      frontmatter[key] = currentObj;
    } else {
      // Close any open nested object
      currentParent = null;
      currentObj = null;
      frontmatter[key] = parseSimpleValue(valueStr);
    }
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();

  return { frontmatter, body };
}

/**
 * Parse a simple YAML value: booleans, numbers, strings, inline arrays.
 */
function parseSimpleValue(valueStr: string): unknown {
  if (valueStr === "true") return true;
  if (valueStr === "false") return false;
  // Only parse as number if it's a non-empty string that looks like a number
  if (valueStr !== "" && !isNaN(Number(valueStr)) && valueStr.trim() !== "") {
    return Number(valueStr);
  }
  if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
    const itemsStr = valueStr.substring(1, valueStr.length - 1);
    if (itemsStr.trim() === "") return [];
    return itemsStr
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""));
  }
  // String value — strip surrounding quotes
  return valueStr.replace(/^["']|["']$/g, "");
}

/**
 * Get the built-in default types.
 */
export function getBuiltinTypes(): Record<string, AgentType> {
  return {
    manager: {
      name: "manager",
      description: "Manages sub-agents and coordinates work",
      canSpawnChildren: true,
      instructionStyle: "manager",
    },
    worker: {
      name: "worker",
      description: "Executes tasks assigned by a manager",
      canSpawnChildren: false,
      instructionStyle: "worker",
    },
    coordinator: {
      name: "coordinator",
      description: "Read-only coordinator that manages agents without writing code",
      canSpawnChildren: true,
      instructionStyle: "coordinator",
      permissions: {
        deny: ["Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"],
      },
    },
  };
}

/**
 * Load an agent type definition from ~/.itsybitsy/agent-types/<name>.md
 * User-defined files override built-in defaults. Falls back to built-in manager
 * if the type is not found anywhere.
 */
export async function loadAgentType(name: string): Promise<AgentType> {
  const builtins = getBuiltinTypes();

  // Try user-defined file first (allows overriding built-ins)
  const home = process.env.HOME || homedir();
  const typeFile = join(home, ".itsybitsy", "agent-types", `${name}.md`);

  try {
    const file = Bun.file(typeFile);
    if (await file.exists()) {
      const content = await file.text();
      const { frontmatter, body } = parseAgentTypeFile(content);

      const permissions = typeof frontmatter.permissions === "object" && frontmatter.permissions !== null
        ? frontmatter.permissions as Record<string, unknown>
        : undefined;
      const getString = (val: unknown, fallback: string): string =>
        typeof val === "string" ? val : fallback;

      return {
        name: getString(frontmatter.name, name),
        description: getString(frontmatter.description, ""),
        canSpawnChildren: frontmatter.canSpawnChildren === true,
        model: getString(frontmatter.model, "") || undefined,
        permissions: permissions ? {
          allow: Array.isArray(permissions.allow) ? permissions.allow as string[] : undefined,
          deny: Array.isArray(permissions.deny) ? permissions.deny as string[] : undefined,
        } : undefined,
        instructionStyle: (getString(frontmatter.instructionStyle, "") as AgentType["instructionStyle"]) || "worker",
        markdownBody: body || undefined,
      };
    }
  } catch {
    // File doesn't exist or can't be read — fall through to built-in
  }

  // Fall back to built-in
  if (builtins[name]) {
    return builtins[name]!;
  }

  // Unknown type — return manager default
  return builtins.manager!;
}

/**
 * List all available agent types (built-in + user-defined in ~/.itsybitsy/agent-types/).
 * User-defined types with the same name as built-ins override them.
 */
export async function listAgentTypes(): Promise<AgentType[]> {
  const types: Map<string, AgentType> = new Map();
  const builtins = getBuiltinTypes();

  // Add built-ins first
  for (const [name, type] of Object.entries(builtins)) {
    types.set(name, type);
  }

  // Add/override with user-defined types from ~/.itsybitsy/agent-types/
  const home = process.env.HOME || homedir();
  const typesDir = join(home, ".itsybitsy", "agent-types");

  try {
    const glob = new Glob("*.md");
    for await (const file of glob.scan(typesDir)) {
      const name = file.replace(/\.md$/, "");
      try {
        const type = await loadAgentType(name);
        types.set(name, type);
      } catch {
        // Skip files that can't be parsed
      }
    }
  } catch {
    // Types directory doesn't exist or can't be read
  }

  return Array.from(types.values());
}

/**
 * Resolve an agent type by name. Alias for loadAgentType — tries user-defined
 * file first, falls back to built-in, defaults to manager for unknown types.
 */
export const resolveAgentType = loadAgentType;

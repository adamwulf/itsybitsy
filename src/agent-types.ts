/**
 * Agent types system: load and parse agent type definitions from ~/.itsybitsy/agent-types/
 */

import { join } from "path";
import { homedir } from "os";
import { Glob } from "bun";
import managerMd from '../docs/agent-types/manager.md' with { type: 'text' };
import workerMd from '../docs/agent-types/worker.md' with { type: 'text' };
import coordinatorMd from '../docs/agent-types/coordinator.md' with { type: 'text' };

const EMBEDDED_TYPES: Record<string, string> = {
  'manager': managerMd,
  'worker': workerMd,
  'coordinator': coordinatorMd,
};

export interface AgentType {
  name: string;
  description: string;
  canSpawnChildren: boolean;
  model?: string;
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  icon?: string;
  allowedPaths?: string[];
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
  let currentListKey: string | null = null; // tracks which nested key receives list items

  for (const line of fmLines) {
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    // Check if this is an indented child line (part of a nested object or top-level list)
    const indentMatch = line.match(/^(\s+)(\S.*)/);
    if (indentMatch && currentParent) {
      const childLine = indentMatch[2]!.trim();

      // Top-level list: parent has no nested subkeys yet and child is a list item
      if (childLine.startsWith("- ") && currentObj && Object.keys(currentObj).length === 0 && !currentListKey) {
        // Convert from tentative nested object to top-level list
        const value = childLine.substring(2).trim().replace(/^["']|["']$/g, "");
        const arr = Array.isArray(frontmatter[currentParent]) ? frontmatter[currentParent] as unknown[] : [];
        arr.push(value);
        frontmatter[currentParent] = arr;
        currentObj = null; // no longer a nested object
        continue;
      }

      // Continue appending to an existing top-level list
      if (childLine.startsWith("- ") && !currentObj && Array.isArray(frontmatter[currentParent])) {
        const value = childLine.substring(2).trim().replace(/^["']|["']$/g, "");
        (frontmatter[currentParent] as unknown[]).push(value);
        continue;
      }

      // Nested object handling
      if (currentObj) {
        const colonIdx = childLine.indexOf(":");
        if (colonIdx !== -1) {
          const key = childLine.substring(0, colonIdx).trim();
          const valueStr = childLine.substring(colonIdx + 1).trim();
          if (valueStr.startsWith("- ")) {
            // YAML list item as value of parent.key — treat as single-item array start
            currentObj[key] = [valueStr.substring(2).trim().replace(/^["']|["']$/g, "")];
            currentListKey = key;
          } else if (valueStr === "") {
            // Empty value in nested context starts a list (e.g. allow:\n    - Read)
            currentObj[key] = [];
            currentListKey = key;
          } else {
            currentObj[key] = parseSimpleValue(valueStr);
            currentListKey = null;
          }
          continue;
        }
        // Could be a YAML list item (- value) under a nested key
        if (childLine.startsWith("- ")) {
          // Append to the tracked list key in currentObj
          if (currentListKey && Array.isArray(currentObj[currentListKey])) {
            (currentObj[currentListKey] as unknown[]).push(childLine.substring(2).trim().replace(/^["']|["']$/g, ""));
          }
          continue;
        }
      }
    }

    // Transitioning to a top-level line: close any open nested object or list
    if (currentParent) {
      if (currentObj && Object.keys(currentObj).length === 0) {
        // Pending empty-value key that never got nested children → store as ""
        frontmatter[currentParent] = "";
      }
      // currentObj with content is already stored via reference in frontmatter[currentParent]
      // top-level lists are already stored directly in frontmatter[currentParent]
      currentParent = null;
      currentObj = null;
      currentListKey = null;
    }

    // Top-level key
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim();
    const valueStr = trimmed.substring(colonIdx + 1).trim();

    // If value is empty, tentatively start a nested object
    // (will be converted to "" if no indented children follow)
    if (valueStr === "") {
      currentParent = key;
      currentObj = {};
      currentListKey = null;
      frontmatter[key] = currentObj;
    } else {
      frontmatter[key] = parseSimpleValue(valueStr);
    }
  }

  // Flush any trailing empty-value key that never got nested children
  if (currentParent && currentObj && Object.keys(currentObj).length === 0) {
    frontmatter[currentParent] = "";
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();

  return { frontmatter, body };
}

const VALID_INSTRUCTION_STYLES = new Set<AgentType["instructionStyle"]>(["manager", "worker", "coordinator"]);

function validateInstructionStyle(value: string): AgentType["instructionStyle"] {
  if (VALID_INSTRUCTION_STYLES.has(value as AgentType["instructionStyle"])) {
    return value as AgentType["instructionStyle"];
  }
  return "manager";
}

/**
 * Parse a simple YAML value: booleans, numbers, strings, inline arrays.
 */
function parseSimpleValue(valueStr: string): unknown {
  if (valueStr === "true") return true;
  if (valueStr === "false") return false;
  // Only parse as number if it's a non-empty string that looks like a number
  if (valueStr !== "" && !isNaN(Number(valueStr))) {
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
      icon: "◆",
      instructionStyle: "manager",
    },
    worker: {
      name: "worker",
      description: "Executes tasks assigned by a manager",
      canSpawnChildren: false,
      icon: "⚙",
      instructionStyle: "worker",
    },
    coordinator: {
      name: "coordinator",
      description: "Read-only coordinator that manages agents without writing code",
      canSpawnChildren: true,
      icon: "◇",
      instructionStyle: "coordinator",
      permissions: {
        deny: ["Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"],
      },
    },
  };
}

/**
 * Ensure ~/.itsybitsy/agent-types/ directory exists and populate it with
 * embedded type files on first run. If the directory already exists, does nothing.
 */
export async function ensureAgentTypesDir(): Promise<void> {
  const home = process.env.HOME || homedir();
  const typesDir = join(home, ".itsybitsy", "agent-types");
  const { mkdir, stat } = await import("fs/promises");

  try {
    // Check if path exists and is a directory
    const stats = await stat(typesDir);
    if (stats.isDirectory()) {
      // Directory already exists, don't overwrite anything
      return;
    }
    // Path exists but is not a directory (e.g., a file) — delete it
    // This handles the case where an empty file was created instead of a dir
    await Bun.file(typesDir).delete();
  } catch {
    // Path doesn't exist, continue to create it
  }

  // Create the directory and all parents
  await mkdir(typesDir, { recursive: true });

  // Write all embedded type files
  for (const [name, content] of Object.entries(EMBEDDED_TYPES)) {
    const filePath = join(typesDir, `${name}.md`);
    await Bun.write(filePath, content);
  }
}

/**
 * Check if an agent type exists (as a file in ~/.itsybitsy/agent-types/<name>.md).
 * Does NOT check built-in types — those must be written to disk by ensureAgentTypesDir().
 */
export async function agentTypeExists(name: string): Promise<boolean> {
  const home = process.env.HOME || homedir();
  const typeFile = join(home, ".itsybitsy", "agent-types", `${name}.md`);
  try {
    return await Bun.file(typeFile).exists();
  } catch {
    return false;
  }
}

/**
 * Load an agent type definition from ~/.itsybitsy/agent-types/<name>.md
 * Throws an error if the file does not exist.
 */
export async function loadAgentType(name: string): Promise<AgentType> {
  const home = process.env.HOME || homedir();
  const typeFile = join(home, ".itsybitsy", "agent-types", `${name}.md`);

  const file = Bun.file(typeFile);
  if (!(await file.exists())) {
    throw new Error(`Unknown agent type '${name}'. Run 'ib init-types' to restore default type files, or create ${typeFile}`);
  }

  const content = await file.text();
  const { frontmatter, body } = parseAgentTypeFile(content);

  const permissions = typeof frontmatter.permissions === "object" && frontmatter.permissions !== null
    ? frontmatter.permissions as Record<string, unknown>
    : undefined;
  const getString = (val: unknown, fallback: string): string =>
    typeof val === "string" ? val : fallback;

  // Extract icon: first non-whitespace character of the icon field
  const rawIcon = getString(frontmatter.icon, "");
  const iconChar = rawIcon.match(/\S/)?.[0] || undefined;

  // Parse allowedPaths: distinguish between absent (undefined) and present-but-empty ([])
  let allowedPaths: string[] | undefined = undefined;
  if ("allowedPaths" in frontmatter) {
    allowedPaths = Array.isArray(frontmatter.allowedPaths)
      ? (frontmatter.allowedPaths as string[])
      : [];
  }

  return {
    name: getString(frontmatter.name, name),
    description: getString(frontmatter.description, ""),
    canSpawnChildren: frontmatter.canSpawnChildren === true,
    icon: iconChar,
    model: getString(frontmatter.model, "") || undefined,
    permissions: permissions ? {
      allow: Array.isArray(permissions.allow) ? permissions.allow as string[] : undefined,
      deny: Array.isArray(permissions.deny) ? permissions.deny as string[] : undefined,
    } : undefined,
    allowedPaths,
    instructionStyle: validateInstructionStyle(getString(frontmatter.instructionStyle, "")),
    markdownBody: body || undefined,
  };
}

/**
 * List all available agent types from ~/.itsybitsy/agent-types/.
 * Only returns types that exist as .md files on disk.
 */
export async function listAgentTypes(): Promise<AgentType[]> {
  const types: AgentType[] = [];
  const home = process.env.HOME || homedir();
  const typesDir = join(home, ".itsybitsy", "agent-types");

  try {
    const glob = new Glob("*.md");
    for await (const file of glob.scan(typesDir)) {
      const name = file.replace(/\.md$/, "");
      try {
        const type = await loadAgentType(name);
        types.push(type);
      } catch {
        // Skip files that can't be parsed
      }
    }
  } catch {
    // Types directory doesn't exist or can't be read
  }

  return types;
}

/**
 * Validate all agent type files in ~/.itsybitsy/agent-types/.
 * Returns an array of error messages. Empty array means all valid.
 */
export async function validateAllAgentTypes(): Promise<string[]> {
  const errors: string[] = [];
  const home = process.env.HOME || homedir();
  const typesDir = join(home, ".itsybitsy", "agent-types");

  try {
    const glob = new Glob("*.md");
    for await (const file of glob.scan(typesDir)) {
      const filePath = join(typesDir, file);
      try {
        const content = await Bun.file(filePath).text();
        const { frontmatter } = parseAgentTypeFile(content);

        // Validate required fields
        if (frontmatter.canSpawnChildren !== undefined && typeof frontmatter.canSpawnChildren !== "boolean") {
          errors.push(`${file}: canSpawnChildren must be true or false, got "${frontmatter.canSpawnChildren}"`);
        }

        // Validate instructionStyle if present
        if (frontmatter.instructionStyle !== undefined) {
          if (typeof frontmatter.instructionStyle !== "string") {
            errors.push(`${file}: instructionStyle must be a string, got ${typeof frontmatter.instructionStyle}`);
          } else if (!VALID_INSTRUCTION_STYLES.has(frontmatter.instructionStyle as AgentType["instructionStyle"])) {
            errors.push(`${file}: instructionStyle must be "manager", "worker", or "coordinator", got "${frontmatter.instructionStyle}"`);
          }
        }

        // Validate permissions structure
        if (frontmatter.permissions !== undefined) {
          if (typeof frontmatter.permissions !== "object" || frontmatter.permissions === null) {
            errors.push(`${file}: permissions must be an object with allow/deny arrays`);
          } else {
            const perms = frontmatter.permissions as Record<string, unknown>;
            if (perms.allow !== undefined && !Array.isArray(perms.allow)) {
              errors.push(`${file}: permissions.allow must be a list`);
            }
            if (perms.deny !== undefined && !Array.isArray(perms.deny)) {
              errors.push(`${file}: permissions.deny must be a list`);
            }
          }
        }

        // Validate model if present
        if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
          errors.push(`${file}: model must be a string`);
        }
      } catch (err) {
        errors.push(`${file}: failed to parse — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch {
    // Types directory doesn't exist — that's fine, no files to validate
  }

  return errors;
}

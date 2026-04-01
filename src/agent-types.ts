/**
 * Agent types system: load and parse agent type definitions from ~/.itsybitsy/agent-types/
 */

import { join } from "path";
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

  // Parse YAML-like front matter (simple key: value parsing)
  const fmLines = lines.slice(1, endIdx);
  const frontmatter: Record<string, unknown> = {};

  for (const line of fmLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim();
    const valueStr = trimmed.substring(colonIdx + 1).trim();

    // Simple value parsing: booleans, numbers, strings, arrays
    if (valueStr === "true") {
      frontmatter[key] = true;
    } else if (valueStr === "false") {
      frontmatter[key] = false;
    } else if (!isNaN(Number(valueStr))) {
      frontmatter[key] = Number(valueStr);
    } else if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
      // Simple array parsing: [item1, item2]
      const itemsStr = valueStr.substring(1, valueStr.length - 1);
      frontmatter[key] = itemsStr
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      // String value
      frontmatter[key] = valueStr.replace(/^["']|["']$/g, "");
    }
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();

  return { frontmatter, body };
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
 * Falls back to built-in defaults if the file doesn't exist.
 */
export async function loadAgentType(name: string): Promise<AgentType> {
  const builtins = getBuiltinTypes();

  if (builtins[name]) {
    return builtins[name]!;
  }

  // Try to load from file
  const home = process.env.HOME || require("os").homedir();
  const typeFile = join(home, ".itsybitsy", "agent-types", `${name}.md`);

  try {
    const file = Bun.file(typeFile);
    if (await file.exists()) {
      const content = await file.text();
      const { frontmatter, body } = parseAgentTypeFile(content);

      return {
        name: (frontmatter.name as string) || name,
        description: (frontmatter.description as string) || "",
        canSpawnChildren: (frontmatter.canSpawnChildren as boolean) ?? false,
        model: (frontmatter.model as string) || undefined,
        permissions: (frontmatter.permissions as AgentType["permissions"]) || undefined,
        instructionStyle: (frontmatter.instructionStyle as AgentType["instructionStyle"]) || "worker",
        markdownBody: body || undefined,
      };
    }
  } catch {
    // File doesn't exist or can't be read
  }

  // Return default manager if not found
  return builtins.manager!;
}

/**
 * List all available agent types (built-in + user-defined in ~/.itsybitsy/agent-types/).
 */
export async function listAgentTypes(): Promise<AgentType[]> {
  const types: Map<string, AgentType> = new Map();
  const builtins = getBuiltinTypes();

  // Add built-ins
  for (const [name, type] of Object.entries(builtins)) {
    types.set(name, type);
  }

  // Add user-defined types from ~/.itsybitsy/agent-types/
  const home = process.env.HOME || require("os").homedir();
  const typesDir = join(home, ".itsybitsy", "agent-types");

  try {
    const dir = Bun.file(typesDir);
    const isDir = await dir.exists().catch(() => false);
    if (isDir) {
      try {
        // List .md files in the directory using Glob
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
        // glob failed, try with readdir alternative
      }
    }
  } catch {
    // Types directory doesn't exist
  }

  return Array.from(types.values());
}

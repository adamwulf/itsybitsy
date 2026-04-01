/**
 * Agent type system — load and parse agent type definitions from .md files.
 * Agent types define role-specific behavior: prompts, permissions, spawn rules, model.
 */

import { join } from "path";
import { homedir } from "node:os";

/**
 * Agent type frontmatter extracted from .md file.
 * Defines permissions, spawn capability, model, and other role-specific behavior.
 */
export interface AgentTypeFrontmatter {
  name: string; // Unique type identifier (e.g., "manager", "worker", "reviewer")
  description: string; // Purpose/intent
  canSpawnChildren: boolean; // Can this type spawn sub-agents?
  canBeParent?: boolean; // Can this type have children? (default: same as canSpawnChildren)
  model?: string; // Preferred model: "sonnet", "opus", "haiku"
  coordinator?: boolean; // Special coordinator role
  permissions?: {
    allow?: string[]; // Allowed tools (e.g., ["Read", "Grep", "Glob"])
    deny?: string[]; // Denied tools
  };
}

/**
 * Complete agent type definition: frontmatter + prompt body.
 * The body is injected into session-start context.
 */
export interface AgentType {
  frontmatter: AgentTypeFrontmatter;
  body: string; // Markdown body to inject as session-start instructions
}

/**
 * Load an agent type by name from ~/.itsybitsy/agent-types/<name>/AGENTTYPE.md.
 * Returns null if not found (caller should use fallback/default).
 */
export async function loadAgentType(typeName: string): Promise<AgentType | null> {
  const typeDir = join(homedir(), ".itsybitty", "agent-types", typeName);
  const typeFile = Bun.file(join(typeDir, "AGENTTYPE.md"));

  try {
    if (!(await typeFile.exists())) {
      return null;
    }

    const content = await typeFile.text();
    const parsed = parseAgentTypeMarkdown(content);
    if (!parsed) return null;

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Parse agent type markdown file with YAML frontmatter + body.
 * Format:
 * ---
 * name: identifier
 * description: purpose
 * canSpawnChildren: true|false
 * [optional other fields]
 * ---
 * # Markdown body
 */
export function parseAgentTypeMarkdown(content: string): AgentType | null {
  // Extract frontmatter (between --- delimiters)
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return null;
  }

  const frontmatterText = frontmatterMatch[1]!;
  const body = frontmatterMatch[2]!.trim();

  // Parse YAML-like frontmatter (simple line-based parsing, not full YAML)
  const frontmatter = parseFrontmatter(frontmatterText);
  if (!frontmatter || !frontmatter.name || !frontmatter.description) {
    return null;
  }

  return {
    frontmatter: frontmatter as AgentTypeFrontmatter,
    body,
  };
}

/**
 * Parse simple YAML-like frontmatter (line-based, not full YAML parser).
 * Supports: key: value, key: [item1, item2], key: {nested: value}.
 */
function parseFrontmatter(text: string): Partial<AgentTypeFrontmatter> | null {
  const result: Record<string, unknown> = {};

  const lines = text.split("\n");
  let currentKey = "";
  let inArray = false;
  let inObject = false;
  let arrayItems: string[] = [];
  let objectStr = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for simple key: value
    const colonMatch = trimmed.match(/^([a-zA-Z_.]+):\s*(.*)$/);
    if (colonMatch) {
      currentKey = colonMatch[1]!;
      const value = colonMatch[2]!.trim();

      // Check for array start
      if (value.startsWith("[")) {
        inArray = true;
        arrayItems = [];
        if (value === "[") {
          // Multi-line array
        } else if (value.endsWith("]")) {
          // Single-line array: [item1, item2]
          inArray = false;
          const itemsStr = value.slice(1, -1);
          arrayItems = itemsStr
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""));
          result[currentKey] = arrayItems;
        } else {
          // Array starts here: [item1,
          const itemsStr = value.slice(1);
          arrayItems = [itemsStr.replace(/,\s*$/, "")];
        }
        continue;
      }

      // Check for object start
      if (value.startsWith("{")) {
        inObject = true;
        objectStr = value;
        if (value.endsWith("}")) {
          // Single-line object
          inObject = false;
          result[currentKey] = parseObjectValue(value);
        }
        continue;
      }

      // Simple value: string, number, boolean
      result[currentKey] = parseSimpleValue(value);
      continue;
    }

    // Continue multi-line array
    if (inArray) {
      if (trimmed.endsWith("]")) {
        inArray = false;
        const item = trimmed.slice(0, -1).trim();
        if (item) {
          arrayItems.push(item.replace(/^["']|["']$/g, "").replace(/,\s*$/, ""));
        }
        result[currentKey] = arrayItems;
      } else if (trimmed.endsWith(",")) {
        arrayItems.push(trimmed.slice(0, -1).trim().replace(/^["']|["']$/g, ""));
      } else {
        arrayItems.push(trimmed.replace(/^["']|["']$/g, ""));
      }
      continue;
    }

    // Continue multi-line object
    if (inObject) {
      objectStr += "\n" + line;
      if (trimmed.endsWith("}")) {
        inObject = false;
        result[currentKey] = parseObjectValue(objectStr);
      }
      continue;
    }
  }

  return result as Partial<AgentTypeFrontmatter>;
}

/**
 * Parse a simple YAML value: string, number, boolean, null.
 */
function parseSimpleValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "") return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^[\d.]+$/.test(value)) return parseFloat(value);
  // Remove quotes if present
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a simple YAML object: {key: value, ...}.
 * Supports only simple nested values (strings, numbers, booleans).
 */
function parseObjectValue(value: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Remove outer braces and split by comma (naive; doesn't handle nested braces)
  const inner = value.replace(/^{/, "").replace(/}$/, "").trim();
  if (!inner) return result;

  // Split by comma and parse key: value pairs
  const pairs = inner.split(",");
  for (const pair of pairs) {
    const match = pair.match(/^\s*([a-zA-Z_]+)\s*:\s*(.+)$/);
    if (match) {
      const key = match[1]!;
      const val = match[2]!.trim();
      result[key] = parseSimpleValue(val);
    }
  }

  return result;
}

/**
 * Get the effective canSpawnChildren flag for an agent type.
 * For coordinator type or undefined type, coordinators always spawn.
 */
export function canAgentTypeSpawnChildren(agentType: AgentType | null): boolean {
  if (!agentType) return false;
  if (agentType.frontmatter.coordinator === true) return true;
  return agentType.frontmatter.canSpawnChildren === true;
}

/**
 * Get built-in fallback instructions for legacy "manager" and "worker" types.
 * Used when no .md file is found (backward compatibility).
 */
export function getBuiltInType(typeName: string): AgentType | null {
  if (typeName === "manager") {
    return {
      frontmatter: {
        name: "manager",
        description: "Manager agent that can spawn and coordinate sub-agents",
        canSpawnChildren: true,
        model: "opus",
      },
      body: "", // Session-start will inject hardcoded manager instructions
    };
  }

  if (typeName === "worker") {
    return {
      frontmatter: {
        name: "worker",
        description: "Worker agent that executes assigned tasks",
        canSpawnChildren: false,
        model: "opus",
      },
      body: "", // Session-start will inject hardcoded worker instructions
    };
  }

  return null;
}

/**
 * Resolve an agent type: try to load from .md, fall back to built-in, return null if not found.
 * Also supports migration: if type looks like a boolean ("manager"/"worker"), map it.
 */
export async function resolveAgentType(typeName: string): Promise<AgentType | null> {
  // Try to load from disk first
  const custom = await loadAgentType(typeName);
  if (custom) return custom;

  // Fall back to built-in types
  const builtin = getBuiltInType(typeName);
  if (builtin) return builtin;

  return null;
}

/**
 * Convert legacy meta.json with worker:boolean to type:string.
 * Returns type name for agents that have only worker field.
 */
export function migrateWorkerToType(meta: { worker?: boolean; type?: string }): string {
  // Already migrated
  if (meta.type) return meta.type;

  // Legacy worker field
  if (meta.worker === true) return "worker";

  // Default to manager
  return "manager";
}

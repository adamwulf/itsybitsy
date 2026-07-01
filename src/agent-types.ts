/**
 * Agent types system: load and parse agent type definitions from ~/.itsybitsy/agent-types/
 */

import { join } from "path";
import { homedir } from "os";
import { readdirSync, readFileSync } from "fs";
import { Glob } from "bun";
import managerMd from '../docs/agent-types/manager.md' with { type: 'text' };
import workerMd from '../docs/agent-types/worker.md' with { type: 'text' };
import coordinatorMd from '../docs/agent-types/coordinator.md' with { type: 'text' };
import systemLayerMd from '../docs/agent-types/system.md' with { type: 'text' };
import allLayerMd from '../docs/agent-types/_all.md' with { type: 'text' };
import nonCoordinatorLayerMd from '../docs/agent-types/_non_coordinator.md' with { type: 'text' };
import { parseModel } from './agent-cli';
import { isValidEffort } from './validation';

const EMBEDDED_TYPES: Record<string, string> = {
  'manager': managerMd,
  'worker': workerMd,
  'coordinator': coordinatorMd,
  'system': systemLayerMd,
  '_all': allLayerMd,
  '_non_coordinator': nonCoordinatorLayerMd,
};

export interface AgentType {
  name: string;
  description: string;
  canSpawnChildren: boolean;
  /**
   * Whether this agent type can be spawned directly via `ib new-agent --type <name>`.
   * Defaults to `true` when absent. Types with `spawnable: false` are layer-only
   * files (e.g. `_all.md`, `_non_coordinator.md`) whose frontmatter permissions
   * and markdown body merge into every spawned agent.
   */
  spawnable?: boolean;
  model?: string;
  /**
   * Reasoning-effort level threaded to the underlying CLI (Claude's
   * `--effort <level>`, codex's `model_reasoning_effort`). One of
   * `low|medium|high|xhigh|max`. Inheritable the same way `model` is (child
   * replaces when present and non-empty — an empty string means inherit).
   * Absent → the spawn falls through to the `"xhigh"` default (see §2 item 4).
   */
  effort?: string;
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  icon?: string;
  allowedPaths?: string[];
  /**
   * If defined, this type can only be spawned in repos whose name or nickname
   * matches an entry. Checked by `newAgent` before any worktree or tmux
   * allocation. Absent → no restriction (type works in any repo).
   */
  repos?: string[];
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
        // A YAML list item under a nested key. Must be checked BEFORE the
        // colon branch, since list values can legitimately contain `:`
        // (e.g. `- "Bash(xcodebuild:*)"`).
        if (childLine.startsWith("- ")) {
          if (currentListKey && Array.isArray(currentObj[currentListKey])) {
            (currentObj[currentListKey] as unknown[]).push(childLine.substring(2).trim().replace(/^["']|["']$/g, ""));
          }
          continue;
        }
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
 * Ensure ~/.itsybitsy/agent-types/ directory exists and populate it with
 * embedded type files on first run. If the directory already exists, does nothing.
 * Use {@link initAgentTypes} to restore missing files without overwriting existing ones.
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
 * Ensure the agent-types directory exists and restore any missing embedded
 * type files without overwriting existing ones. Returns the list of file
 * names that were created.
 *
 * Intended for `ib init-types`: users can delete a built-in `.md` to restore
 * a stock copy without losing their edits to the others.
 */
export async function initAgentTypes(): Promise<string[]> {
  const home = process.env.HOME || homedir();
  const typesDir = join(home, ".itsybitsy", "agent-types");
  const { mkdir, stat } = await import("fs/promises");

  // Make sure the directory exists (without writing any embedded files yet)
  try {
    const stats = await stat(typesDir);
    if (!stats.isDirectory()) {
      // Path exists but is not a directory — remove the stale file
      await Bun.file(typesDir).delete();
      await mkdir(typesDir, { recursive: true });
    }
  } catch {
    await mkdir(typesDir, { recursive: true });
  }

  // Write only the missing embedded files
  const created: string[] = [];
  for (const [name, content] of Object.entries(EMBEDDED_TYPES)) {
    const fileName = `${name}.md`;
    const filePath = join(typesDir, fileName);
    if (!(await Bun.file(filePath).exists())) {
      await Bun.write(filePath, content);
      created.push(fileName);
    }
  }
  return created;
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
 * Read an agent type file from disk and return its raw parsed frontmatter + body.
 * Does NOT resolve inheritance or apply any defaults — callers that want the
 * resolved `AgentType` should use {@link loadAgentType} instead.
 *
 * Throws if the file does not exist. Use {@link agentTypeExists} to check first
 * when the absence should not be an error.
 */
async function readRawTypeFile(
  name: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
  const home = process.env.HOME || homedir();
  const typeFile = join(home, ".itsybitsy", "agent-types", `${name}.md`);

  const file = Bun.file(typeFile);
  if (!(await file.exists())) {
    throw new Error(
      `Unknown agent type '${name}'. Run 'ib init-types' to restore default type files, or create ${typeFile}`,
    );
  }

  const content = await file.text();
  return parseAgentTypeFile(content);
}

/**
 * Treat an `inherits:` frontmatter value as "set" only when it's a non-empty
 * string. Absent keys and the empty-string sentinel (`inherits:` with no
 * value, or `inherits: ""`) both resolve to "no parent" — matching the
 * `model: ""` convention used elsewhere.
 */
function inheritsParentName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Walk the inheritance chain starting at `name`, returning each step's raw
 * parsed file in root-first order (so `[root, ..., leaf]`). Throws on cycles
 * (including self-inheritance) and missing parents.
 */
async function resolveChain(
  name: string,
  visited: string[] = [],
): Promise<Array<{ name: string; frontmatter: Record<string, unknown>; body: string }>> {
  // Cycle check — includes self-inheritance (name === visited[-1])
  if (visited.includes(name)) {
    const chain = [...visited, name].join(" -> ");
    throw new Error(`Circular inheritance detected: ${chain}`);
  }

  let raw: { frontmatter: Record<string, unknown>; body: string };
  try {
    raw = await readRawTypeFile(name);
  } catch (err) {
    if (visited.length === 0) {
      // Leaf type doesn't exist — re-throw the clean "unknown agent type" message
      throw err;
    }
    // Missing parent — produce a child-aware error
    const child = visited[visited.length - 1]!;
    const home = process.env.HOME || homedir();
    const expectedPath = join(home, ".itsybitsy", "agent-types", `${name}.md`);
    throw new Error(
      `Type '${child}' inherits from unknown type '${name}' (file not found: ${expectedPath})`,
    );
  }

  const parent = inheritsParentName(raw.frontmatter.inherits);
  if (parent === null) {
    return [{ name, frontmatter: raw.frontmatter, body: raw.body }];
  }

  const parentChain = await resolveChain(parent, [...visited, name]);
  return [...parentChain, { name, frontmatter: raw.frontmatter, body: raw.body }];
}

/**
 * Merge a root-first chain of raw `{frontmatter, body}` records into a single
 * record. Scalar fields take the descendant's value when the key is **present**
 * in the descendant's frontmatter. `permissions.allow` / `permissions.deny`
 * are unioned (deduped via Set) across the entire chain. `allowedPaths` and
 * `repos` are replaced (not merged) when the descendant declares them.
 *
 * The `name` and `spawnable` keys are intentionally not set here — the caller
 * (`buildAgentTypeFromFrontmatter`) is responsible for the final `name` (from
 * the filename) and `spawnable` (read from the leaf file only).
 */
function mergeRawFrontmatters(
  chain: Array<{ name: string; frontmatter: Record<string, unknown>; body: string }>,
): { frontmatter: Record<string, unknown>; body: string } {
  const merged: Record<string, unknown> = {};

  // Scalar keys that follow the "present in child → replace" rule.
  const SCALAR_KEYS = new Set([
    "description",
    "canSpawnChildren",
    "icon",
    "model",
    "effort",
    "instructionStyle",
    "allowedPaths",
    "repos",
  ]);

  // Keys that treat an explicit empty string as "inherit / no override" —
  // matching PLAN-INHERITS.md's rules table (icon must be present *and
  // non-empty*; model's empty string collapses to the inherit convention).
  // Without this, a child that declares `icon:`, `model:`, or `effort:` with no
  // value silently wipes the parent's value to undefined. `effort` follows
  // `model`'s convention so a child declaring a blank `effort:` inherits the
  // parent's value. description and instructionStyle keep the strict
  // "present → replace" rule.
  const EMPTY_STRING_INHERITS = new Set(["icon", "model", "effort"]);

  // Accumulated permission lists (unioned across the chain, deduped below).
  const allAllow: string[] = [];
  const allDeny: string[] = [];

  // Accumulated body parts — concatenated root-first with blank-line
  // separators in PLAN-BODY-APPEND.md. Each entry's body is already trimmed
  // by parseAgentTypeFile, so no re-trim here.
  const bodyParts: string[] = [];

  for (const entry of chain) {
    const fm = entry.frontmatter;

    for (const key of Object.keys(fm)) {
      if (SCALAR_KEYS.has(key)) {
        // Skip empty-string values for icon/model — those mean "inherit",
        // matching the PLAN-INHERITS.md rule and the existing `""` → undefined
        // coercion in buildAgentTypeFromFrontmatter.
        if (EMPTY_STRING_INHERITS.has(key) && fm[key] === "") continue;
        merged[key] = fm[key];
      }
    }

    // Permissions — union across the chain.
    if (typeof fm.permissions === "object" && fm.permissions !== null) {
      const perms = fm.permissions as Record<string, unknown>;
      if (Array.isArray(perms.allow)) {
        for (const v of perms.allow) if (typeof v === "string") allAllow.push(v);
      }
      if (Array.isArray(perms.deny)) {
        for (const v of perms.deny) if (typeof v === "string") allDeny.push(v);
      }
    }

    // Body — root-first concatenation. Skip empties so missing-body
    // ancestors don't produce stray blank lines.
    if (entry.body.length > 0) {
      bodyParts.push(entry.body);
    }
  }

  const body = bodyParts.join("\n\n");

  // Emit merged permissions only when something accumulated.
  if (allAllow.length > 0 || allDeny.length > 0) {
    const permsOut: Record<string, string[]> = {};
    if (allAllow.length > 0) permsOut.allow = Array.from(new Set(allAllow));
    if (allDeny.length > 0) permsOut.deny = Array.from(new Set(allDeny));
    merged.permissions = permsOut;
  }

  return { frontmatter: merged, body };
}

/**
 * Build the final `AgentType` record from an already-merged frontmatter + body.
 * Applies defaults (e.g. `canSpawnChildren: false` when absent) — which is why
 * chain resolution must happen before this step, not after, so that a child's
 * explicit `canSpawnChildren: false` correctly overrides a parent's `true`.
 *
 * The `name` field is always set from the caller-supplied `name` argument
 * (the filename), never read from the merged frontmatter — the plan's
 * "name is never inherited" rule is enforced here.
 *
 * The `spawnable` flag is supplied separately so it can be read from the leaf
 * file only. See §Why `spawnable` is not inherited in PLAN-INHERITS.md.
 */
function buildAgentTypeFromFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
  name: string,
  leafSpawnable: boolean,
): AgentType {
  const getString = (val: unknown, fallback: string): string =>
    typeof val === "string" ? val : fallback;

  const permissions = typeof frontmatter.permissions === "object" && frontmatter.permissions !== null
    ? (frontmatter.permissions as Record<string, unknown>)
    : undefined;

  // Extract icon: first non-whitespace character of the icon field.
  const rawIcon = getString(frontmatter.icon, "");
  const iconChar = rawIcon.match(/\S/)?.[0] || undefined;

  // Parse allowedPaths: distinguish between absent (undefined) and present-but-empty ([]).
  let allowedPaths: string[] | undefined = undefined;
  if ("allowedPaths" in frontmatter) {
    allowedPaths = Array.isArray(frontmatter.allowedPaths)
      ? (frontmatter.allowedPaths as string[])
      : [];
  }

  // Parse repos: absent → undefined; present non-array → undefined (the
  // validator is the actual gate for bad shapes — defensive here). Entries
  // are trimmed and empties dropped.
  let repos: string[] | undefined = undefined;
  if ("repos" in frontmatter) {
    if (Array.isArray(frontmatter.repos)) {
      const entries: string[] = [];
      for (const v of frontmatter.repos) {
        if (typeof v === "string") {
          const t = v.trim();
          if (t.length > 0) entries.push(t);
        }
      }
      repos = entries;
    }
    // Non-array shapes fall through → repos stays undefined (validator reports).
  }

  return {
    name,
    description: getString(frontmatter.description, ""),
    canSpawnChildren: frontmatter.canSpawnChildren === true,
    spawnable: leafSpawnable,
    icon: iconChar,
    model: getString(frontmatter.model, "") || undefined,
    effort: getString(frontmatter.effort, "") || undefined,
    permissions: permissions
      ? {
          allow: Array.isArray(permissions.allow) ? (permissions.allow as string[]) : undefined,
          deny: Array.isArray(permissions.deny) ? (permissions.deny as string[]) : undefined,
        }
      : undefined,
    allowedPaths,
    repos,
    instructionStyle: validateInstructionStyle(getString(frontmatter.instructionStyle, "")),
    markdownBody: body || undefined,
  };
}

/**
 * Load an agent type definition from ~/.itsybitsy/agent-types/<name>.md,
 * resolving `inherits:` chains via `resolveChain` and merging permissions
 * across the whole chain (see PLAN-INHERITS.md).
 *
 * Throws if the file does not exist, if the chain contains a cycle, or if
 * any parent in the chain is missing.
 */
export async function loadAgentType(name: string): Promise<AgentType> {
  const chain = await resolveChain(name);
  const leaf = chain[chain.length - 1]!;
  // `spawnable` is read from the leaf file only — see PLAN-INHERITS.md
  // §"Why `spawnable` is not inherited".
  const leafSpawnable = leaf.frontmatter.spawnable === false ? false : true;
  const { frontmatter, body } = mergeRawFrontmatters(chain);
  return buildAgentTypeFromFrontmatter(frontmatter, body, name, leafSpawnable);
}

/**
 * Synchronously list agent type names from ~/.itsybitsy/agent-types/
 * without parsing the files. Returns the basenames of *.md files,
 * sorted alphabetically. Falls back to the embedded default type names
 * when the directory doesn't exist yet (e.g. before ensureAgentTypesDir
 * has run). Used by UI code that needs to cycle through types without
 * blocking on disk I/O or YAML parsing.
 */
export function listAgentTypeNamesSync(): string[] {
  const home = process.env.HOME || homedir();
  const typesDir = join(home, ".itsybitsy", "agent-types");
  try {
    const names = readdirSync(typesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    if (names.length > 0) return names;
  } catch {
    // fall through to embedded defaults
  }
  return Object.keys(EMBEDDED_TYPES).sort();
}

/**
 * Synchronously list spawnable agent types as `{name, description}` pairs.
 * Used by both the new-agent UI cyclers (which only care about names) and
 * session-start templates that render the `{{availableTypes}}` placeholder.
 *
 * Performs a single lightweight scan of each `.md` file's frontmatter to
 * extract `spawnable` and `description` together — no full parse is
 * required. Layer-only files (`spawnable: false`) are excluded.
 *
 * Listing order is alphabetical (inherited from {@link listAgentTypeNamesSync}).
 */
export function listSpawnableAgentTypesSync(): Array<{ name: string; description: string }> {
  const allNames = listAgentTypeNamesSync();
  const home = process.env.HOME || homedir();
  const typesDir = join(home, ".itsybitsy", "agent-types");

  const result: Array<{ name: string; description: string }> = [];
  for (const name of allNames) {
    const filePath = join(typesDir, `${name}.md`);
    let content: string | undefined;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      // File gone between listing and read — fall back to embedded content if we know it
      content = EMBEDDED_TYPES[name];
    }
    if (content === undefined) {
      // Directory didn't exist and no embedded default — assume spawnable, no description
      result.push({ name, description: "" });
      continue;
    }
    const { spawnable, description } = readFrontmatterScalars(content);
    if (spawnable) {
      result.push({ name, description });
    }
  }
  return result;
}

/**
 * Synchronously list the names of types that can be spawned directly
 * (i.e. their frontmatter does not declare `spawnable: false`).
 * Used by UI cyclers in the new-agent dialog so layer-only files like
 * `_all.md` / `_non_coordinator.md` never appear as spawn choices.
 *
 * Implemented on top of {@link listSpawnableAgentTypesSync} so the disk
 * scan and fallback semantics stay in one place.
 */
export function listSpawnableTypeNamesSync(): string[] {
  return listSpawnableAgentTypesSync().map((t) => t.name);
}

/**
 * Lightweight sync extractor: read both `spawnable` and `description`
 * from a frontmatter block in a single pass. Avoids the full parser so
 * this stays cheap enough to call from UI render paths and the
 * session-start hook.
 *
 * - `spawnable` is true unless explicitly declared `spawnable: false`.
 * - `description` is the trimmed value of the top-level `description:`
 *   key, with surrounding single/double quotes stripped. An absent key
 *   yields an empty string.
 *
 * Only top-level keys are considered: lines beginning with whitespace
 * (i.e. nested values like `permissions:\n  description: ...`) are
 * skipped so a nested key never accidentally shadows the top-level one.
 *
 * YAML block scalars (`description: |`, `description: >`) are not
 * supported — same limitation as the full parser. The literal `|` or
 * `>` would be returned as the description string. None of the
 * embedded defaults use this form.
 */
function readFrontmatterScalars(content: string): { spawnable: boolean; description: string } {
  let spawnable = true;
  let description = "";
  const lines = content.split("\n");
  if (lines[0] !== "---") return { spawnable, description };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---") break;
    // Skip nested keys: anything indented is part of a nested object/list,
    // not a top-level frontmatter key.
    if (/^\s/.test(line)) continue;
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    const valueStr = line.substring(colonIdx + 1).trim();

    if (key === "spawnable") {
      if (valueStr === "false") spawnable = false;
    } else if (key === "description") {
      description = valueStr.replace(/^["']|["']$/g, "");
    }
  }
  return { spawnable, description };
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

  // Collect the basenames we see — used afterwards to try loading each type
  // so cycles / missing parents are caught at `ib watch` startup rather than
  // at spawn time.
  const seenBasenames: string[] = [];

  try {
    const glob = new Glob("*.md");
    for await (const file of glob.scan(typesDir)) {
      const filePath = join(typesDir, file);
      const basename = file.replace(/\.md$/, "");
      seenBasenames.push(basename);
      try {
        const content = await Bun.file(filePath).text();
        const { frontmatter } = parseAgentTypeFile(content);

        // Validate required fields
        if (frontmatter.canSpawnChildren !== undefined && typeof frontmatter.canSpawnChildren !== "boolean") {
          errors.push(`${file}: canSpawnChildren must be true or false, got "${frontmatter.canSpawnChildren}"`);
        }

        if (frontmatter.spawnable !== undefined && typeof frontmatter.spawnable !== "boolean") {
          errors.push(`${file}: spawnable must be true or false, got "${frontmatter.spawnable}"`);
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

        // Validate model if present. Per D1/D5 the value must be the qualified
        // `<cli>:<model>` form (e.g. "claude:opus", "codex:gpt-5.1-codex").
        // Empty string is the "inherit" convention (see EMPTY_STRING_INHERITS).
        if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
          errors.push(`${file}: model must be a string`);
        } else if (typeof frontmatter.model === "string" && frontmatter.model !== "") {
          try {
            parseModel(frontmatter.model);
          } catch (err) {
            errors.push(`${file}: invalid model — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Validate effort if present. Must be one of low|medium|high|xhigh|max.
        // Empty string is the "inherit" convention (see EMPTY_STRING_INHERITS),
        // mirroring model above.
        if (frontmatter.effort !== undefined && typeof frontmatter.effort !== "string") {
          errors.push(`${file}: effort must be a string`);
        } else if (typeof frontmatter.effort === "string" && frontmatter.effort !== "" && !isValidEffort(frontmatter.effort)) {
          errors.push(`${file}: invalid effort '${frontmatter.effort}' — must be one of low, medium, high, xhigh, max`);
        }

        // Validate allowedPaths if present
        if (frontmatter.allowedPaths !== undefined) {
          if (!Array.isArray(frontmatter.allowedPaths)) {
            errors.push(`${file}: allowedPaths must be a list of directory paths`);
          } else {
            for (const p of frontmatter.allowedPaths) {
              if (typeof p !== "string") {
                errors.push(`${file}: allowedPaths entries must be strings, got ${typeof p}`);
                break;
              }
            }
          }
        }

        // Validate `inherits:` shape
        if (frontmatter.inherits !== undefined) {
          if (typeof frontmatter.inherits !== "string") {
            errors.push(`${file}: inherits must be a string (the name of the parent type)`);
          } else if (frontmatter.spawnable === false && frontmatter.inherits.trim().length > 0) {
            // Layer files (spawnable: false) may not use `inherits:` — a layer
            // inheriting an unrelated type's body would silently prepend that
            // body to every spawned agent's prompt.
            errors.push(
              `${file}: layer files (spawnable: false) cannot use 'inherits:' — layer files inject their body into every agent and inheritance would be surprising.`,
            );
          }
        }

        // Validate `repos:` shape (see PLAN-INHERITS.md §Part 2).
        if (frontmatter.repos !== undefined) {
          if (typeof frontmatter.repos === "string") {
            errors.push(
              `${file}: repos must be a YAML list of strings; got string "${frontmatter.repos}". Use [${frontmatter.repos}] or a multi-line list.`,
            );
          } else if (!Array.isArray(frontmatter.repos)) {
            errors.push(`${file}: repos must be a list of strings.`);
          } else if (frontmatter.repos.length === 0) {
            errors.push(
              `${file}: repos must be absent (no restriction) or a non-empty list; an empty list makes the type unspawnable.`,
            );
          } else {
            for (const r of frontmatter.repos) {
              if (typeof r !== "string") {
                errors.push(`${file}: repos entries must be strings; got ${typeof r}.`);
                break;
              }
            }
          }
        }
      } catch (err) {
        errors.push(`${file}: failed to parse — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch {
    // Types directory doesn't exist — that's fine, no files to validate
  }

  // Second pass: try to resolve every type's inheritance chain so cycles and
  // missing parents surface at startup rather than at spawn time. Layer files
  // (spawnable: false) are still attempted — a clean chain resolution for a
  // layer is harmless, and failure modes (e.g. layer with `inherits:`) are
  // already reported by the per-file pass above.
  for (const basename of seenBasenames) {
    try {
      await loadAgentType(basename);
    } catch (err) {
      errors.push(`${basename}.md: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return errors;
}

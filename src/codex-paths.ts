import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  orderedEntryMatches,
  prepareAccessTable,
  type OrderedPathEntry,
  type PathsConfig,
} from "./sandbox";

type Access = "read" | "write" | "deny";

function fail(pattern: string, reason: string): never {
  throw new Error(`Cannot translate Codex path ${JSON.stringify(pattern)}: ${reason}`);
}

function subtreeRoot(entry: OrderedPathEntry): string | undefined {
  if (entry.kind === "plain") return entry.canonical;
  if (entry.canonical.endsWith("/**")) {
    const root = entry.canonical.slice(0, -3) || "/";
    if (!/[*?]/.test(root)) return root;
  }
}

/** Whether an entry authorizes every descendant, not just the directory name. */
function coversSubtree(entry: OrderedPathEntry, path: string): boolean {
  return entry.kind === "plain"
    ? orderedEntryMatches(entry, path)
    : entry.canonical.endsWith("/**") && orderedEntryMatches(entry, `${path === "/" ? "" : path}/`);
}

function scanRoot(pattern: string): string {
  if (pattern.startsWith("**/")) return "/";
  const firstGlob = pattern.search(/[*?]/);
  return pattern.slice(0, pattern.lastIndexOf("/", firstGlob)) || "/";
}

function literalPrefix(entry: OrderedPathEntry): string {
  return entry.kind === "plain" ? entry.canonical : entry.canonical.split(/[*?]/, 1)[0]!;
}

function mayOverlap(left: OrderedPathEntry, right: OrderedPathEntry): boolean {
  const a = literalPrefix(left);
  const b = literalPrefix(right);
  return a.startsWith(b) || b.startsWith(a);
}

function exactKey(path: string): string {
  // Codex detects [] as glob syntax too, even though our grammar treats them
  // literally. Escaping them still fails its read/write glob validation.
  if (/[*?\[\]]/.test(path)) fail(path, "Codex cannot represent this literal filename as an exact allow entry");
  return path;
}

function denyKey(entry: OrderedPathEntry): string {
  const pattern = entry.canonical;
  if (entry.kind === "plain") return exactKey(pattern);
  // globset has additional syntax and only supports ** as a whole component.
  // Passing these through could narrow a deny (and thereby broaden access).
  if (/[\[\]{}\\]/.test(pattern) || pattern.split("/").some((part) => part.includes("**") && part !== "**")) {
    fail(pattern, "deny glob syntax differs from Codex; use literal paths or whole-component * / ? / ** patterns");
  }
  return pattern.startsWith("**/") ? `/${pattern}` : pattern;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Translate frozen, canonical policy to Codex 0.165 filesystem entries.
 * Exact paths and literal-prefix /** rules remain live subtree grants, even
 * when absent. Other allow globs are launch/resume snapshots: regular files
 * and existing roots of fully authorized /** subtrees only. Symlinks are not
 * followed. No enclosing-directory grant substitutes for a file pattern.
 *
 * Throws on unsupported semantics or scan errors, so callers must not recover
 * by granting a parent directory. This translates configured paths only;
 * inherited Codex workspace/runtime permissions remain the caller's concern.
 */
export async function resolveCodexPathGrants(paths: PathsConfig): Promise<Record<string, Access>> {
  const prepared = prepareAccessTable({ ...paths, runtimeRoots: [], runtimeDenyRoots: [] });
  for (const entry of [...prepared.allow, ...prepared.deny]) {
    if (entry.canonical.split("/").some((part) => part === "." || part === "..")) {
      fail(entry.canonical, "expected canonical paths without . or .. components");
    }
  }
  const grants: Record<string, Access> = {};
  for (const entry of prepared.deny) grants[denyKey(entry)] = "deny";

  // A candidate is either an exact snapshot file or an authorized subtree.
  const candidates = new Map<string, "file" | "subtree">();
  const denied = (path: string) => prepared.deny.some((entry) => orderedEntryMatches(entry, path));
  const deniedSubtree = (path: string) => prepared.deny.some((entry) => coversSubtree(entry, path));

  for (const [index, entry] of prepared.allow.entries()) {
    const root = subtreeRoot(entry);
    if (root !== undefined) {
      candidates.set(exactKey(root), "subtree");
      continue;
    }
    const pattern = entry.canonical;
    const base = scanRoot(pattern);
    // A later whole-subtree rule decides every possible match here. Avoid
    // needless scans/rejections, including redundant basename-anywhere rules.
    const redundantEarlier = prepared.allow.slice(0, index).some((earlier, earlierIndex) =>
      earlier.op === entry.op && coversSubtree(earlier, base)
      && !prepared.allow.slice(earlierIndex + 1, index).some((between) => between.op !== entry.op && mayOverlap(entry, between)));
    if (deniedSubtree(base) || redundantEarlier || prepared.allow.slice(index + 1).some((later) => coversSubtree(later, base))) continue;
    if (pattern.startsWith("**/")) {
      fail(pattern, "basename-anywhere allow snapshots require an unbounded filesystem scan; use an absolute glob root");
    }
    if (entry.op === "read") {
      const overriddenWrite = prepared.allow.slice(0, index).find((other, otherIndex) =>
        other.op === "write" && (other.kind === "plain" || other.canonical.endsWith("/**")) && mayOverlap(entry, other)
        && !prepared.allow.slice(otherIndex + 1, index).some((later) => later.op === "read" && coversSubtree(later, base)));
      if (overriddenWrite) {
        fail(pattern, `snapshot read glob may narrow write rule ${JSON.stringify(overriddenWrite.canonical)}; future matching names would remain writable. Use exact read paths or trailing /** subtree rules`);
      }
    }

    const subtreePattern = pattern.endsWith("/**") ? pattern.slice(0, -3) : undefined;
    const directoryMatcher = subtreePattern === undefined ? undefined : prepareAccessTable({
      allowRead: [subtreePattern], allowWrite: [], deny: [], runtimeRoots: [], runtimeDenyRoots: [],
    }).allow[0]!;
    const searchPattern = subtreePattern ?? pattern;
    const depthLimit = searchPattern.includes("**") ? Infinity : searchPattern.slice(base === "/" ? 1 : base.length + 1).split("/").length;

    async function walk(directory: string, depth: number): Promise<void> {
      // Recheck each traversed directory; never follow a directory symlink,
      // including one introduced in a frozen literal prefix since spawn.
      if (await realpath(directory) !== directory) fail(pattern, `snapshot directory changed canonical location: ${directory}`);
      for (const child of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, child.name);
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          if (deniedSubtree(path)) continue;
          if (directoryMatcher && orderedEntryMatches(directoryMatcher, path)) {
            candidates.set(exactKey(path), "subtree");
          } else if (depth < depthLimit) {
            await walk(path, depth + 1);
          }
        } else if (child.isFile() && orderedEntryMatches(entry, path) && !denied(path)) {
          // Recheck type/canonical name before materializing the file grant.
          // As with every launch snapshot, later filesystem mutation is not
          // an inode lock; the caller must regenerate grants on resume.
          if ((await lstat(path)).isFile() && await realpath(path) === path) candidates.set(exactKey(path), "file");
        }
      }
    }

    let stat;
    try {
      stat = await lstat(base);
    } catch (error) {
      if (isMissing(error)) continue;
      fail(pattern, `snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (stat.isSymbolicLink()) fail(pattern, `snapshot root is now a symlink: ${base}`);
      if (stat.isDirectory()) await walk(base, 1);
    } catch (error) {
      fail(pattern, `snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const [path, kind] of candidates) {
    if (denied(path) || deniedSubtree(path)) continue;
    // Reuse the shared resolver's sorted entries and matcher, without doing
    // another filesystem canonicalization of already-checked snapshot paths.
    // A directory-name match alone must never become a subtree grant.
    const winner = prepared.allow.filter((entry) => kind === "subtree"
      ? coversSubtree(entry, path)
      : orderedEntryMatches(entry, path)).at(-1);
    if (winner && grants[path] !== "deny") grants[path] = winner.op;
  }
  return grants;
}

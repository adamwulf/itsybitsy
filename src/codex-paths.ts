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

type PatternEdge = { to: number; literal?: string; crossSlash?: boolean };
type PatternState = { epsilon: number[]; edges: PatternEdge[] };
type PatternMachine = { states: PatternState[]; accept: Set<number> };

/**
 * A small automaton for reachability, not permission decisions (those still
 * use the shared resolver). Unlike a literal-prefix check it distinguishes
 * sibling components even after wildcards. A globstar followed by a slash has
 * a zero-directory branch;
 * embedded ** retains the existing grammar's cross-directory behavior.
 * Treating ** as including newlines is conservative for reachability only.
 */
function patternMachine(pattern: string, plain = false): PatternMachine {
  const states: PatternState[] = [{ epsilon: [], edges: [] }];
  let current = 0;
  const state = () => states.push({ epsilon: [], edges: [] }) - 1;
  const character = (literal: string) => {
    const next = state();
    states[current]!.edges.push({ to: next, literal });
    current = next;
  };
  const star = (crossSlash: boolean) => {
    const next = state();
    states[current]!.epsilon.push(next);
    states[current]!.edges.push({ to: current, crossSlash });
    current = next;
  };
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (!plain && char === "*" && pattern[index + 1] === "*" && pattern[index + 2] === "/") {
      const loop = state();
      const next = state();
      states[current]!.epsilon.push(loop, next);
      states[loop]!.edges.push({ to: loop, crossSlash: true }, { to: next, literal: "/" });
      current = next;
      index += 2;
    } else if (!plain && char === "*") {
      const globstar = pattern[index + 1] === "*";
      star(globstar);
      if (globstar) index++;
    } else if (!plain && char === "?") {
      const next = state();
      states[current]!.edges.push({ to: next, crossSlash: false });
      current = next;
    } else {
      character(char);
    }
  }
  const accept = new Set([current]);
  if (plain) {
    if (pattern !== "/") character("/");
    star(true);
    accept.add(current);
  }
  return { states, accept };
}

function acceptsCharacter(edge: PatternEdge, character: string): boolean {
  return edge.literal === undefined ? edge.crossSlash === true || character !== "/" : edge.literal === character;
}

/** Product-automaton search: is there any path accepted by both patterns? */
function patternsOverlap(left: PatternMachine, right: PatternMachine): boolean {
  const pending: [number, number][] = [[0, 0]];
  const seen = new Set<number>();
  while (pending.length) {
    const [a, b] = pending.pop()!;
    const key = a * right.states.length + b;
    if (seen.has(key)) continue;
    seen.add(key);
    if (left.accept.has(a) && right.accept.has(b)) return true;
    const first = left.states[a]!;
    const second = right.states[b]!;
    for (const next of first.epsilon) pending.push([next, b]);
    for (const next of second.epsilon) pending.push([a, next]);
    for (const x of first.edges) for (const y of second.edges) {
      if (x.literal !== undefined ? acceptsCharacter(y, x.literal)
        : y.literal === undefined || acceptsCharacter(x, y.literal)) pending.push([x.to, y.to]);
    }
  }
  return false;
}

function epsilonClosure(machine: PatternMachine, states: Set<number>): Set<number> {
  const pending = [...states];
  while (pending.length) {
    for (const next of machine.states[pending.pop()!]!.epsilon) {
      if (!states.has(next)) { states.add(next); pending.push(next); }
    }
  }
  return states;
}

function mayMatchDescendant(machine: PatternMachine, directory: string): boolean {
  let states = epsilonClosure(machine, new Set([0]));
  const prefix = `${directory === "/" ? "" : directory}/`;
  for (let index = 0; index < prefix.length; index++) {
    const next = new Set<number>();
    for (const current of states) for (const edge of machine.states[current]!.edges) {
      if (acceptsCharacter(edge, prefix[index]!)) next.add(edge.to);
    }
    states = epsilonClosure(machine, next);
    if (states.size === 0) return false;
  }
  // Every compiled state can reach an accepting state. A nonempty state set
  // therefore means some suffix could match, even if it does not yet exist.
  return states.size > 0;
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
  const machines = new Map(prepared.allow.map((entry) => [entry, patternMachine(entry.canonical, entry.kind === "plain")]));
  const mayOverlap = (left: OrderedPathEntry, right: OrderedPathEntry) => patternsOverlap(machines.get(left)!, machines.get(right)!);
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
    const searchMachine = patternMachine(searchPattern);

    async function walk(directory: string): Promise<void> {
      // Recheck each traversed directory; never follow a directory symlink,
      // including one introduced in a frozen literal prefix since spawn.
      if (await realpath(directory) !== directory) fail(pattern, `snapshot directory changed canonical location: ${directory}`);
      for (const child of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, child.name);
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          if (deniedSubtree(path)) continue;
          if (directoryMatcher && orderedEntryMatches(directoryMatcher, path)) {
            if ((await lstat(path)).isDirectory() && await realpath(path) === path) candidates.set(exactKey(path), "subtree");
          } else if (mayMatchDescendant(searchMachine, path)) {
            await walk(path);
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
      if (stat.isDirectory()) await walk(base);
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

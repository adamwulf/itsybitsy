import { join, resolve, basename, isAbsolute } from "path";
import { userHome } from "./home";
import { mkdir, open, realpath, rename, stat, unlink } from "fs/promises";
import { resolveGitRoot } from "./agent-lifecycle";
import { coordinatorIdFromFolderName } from "./coordinator";
// teams.ts imports listRepos/repoDisplayName FROM this module, so a static
// `import { getTeam } from "./teams"` forms an import cycle. It is SAFE here
// because we only dereference `getTeam`/`normalizeTeamName` INSIDE the async
// checkNewRepoEntry (which addRepo calls) and renameRepo functions — long
// after both modules finish initializing (never at module-init / top-level).
// See SPEC §16.1 (bidirectional repo↔team name-collision refusal).
import { getTeam, normalizeTeamName } from "./teams";
import { isValidRepoName } from "./validation";

export interface RepoEntry {
  path: string;
  name: string;
  nickname?: string;
  defaultAgentType?: string;
  notes?: string;
}

/** Returns nickname if set, otherwise name (basename). */
export function repoDisplayName(repo: RepoEntry): string {
  return repo.nickname ?? repo.name;
}

/** Outcome of resolving a user-typed key to a single registered repo. */
export type RepoResolution =
  | { ok: true; repo: RepoEntry }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; candidates: RepoEntry[] };

/**
 * Resolve a user-typed repo key to a single registered repo. This is the ONE
 * resolver every by-name lookup shares (`ib new-agent --repo`, `ib send
 * @<repo>`, `ib push <repo-id>`, `ib remove <name>`), so they all agree.
 *
 * A key is matched, in one flat pass, against:
 *   - the directory basename (RepoEntry.name), case-INSENSITIVELY
 *   - the registry id / nickname (RepoEntry.nickname), case-INSENSITIVELY
 *   - an absolute or relative filesystem path (RepoEntry.path), matched exactly
 *     and — for a path-shaped key — against resolve(cwd, key) so a relative
 *     path works too
 *
 * A "/" is the ONLY marker that puts a key exclusively in the path namespace: a
 * valid repo name/nickname is `[A-Za-z0-9_-]+` (see isValidRepoName — no "/"),
 * so a key that contains "/" can only be a path and skips name matching. Every
 * other key (bare like "pandora" OR dotted like "milestonemade.com" — a real
 * registered basename) is tried as a name/nickname AND against an exact path,
 * but is NEVER fed to resolve(cwd, key): that keeps a bare/dotted name from
 * colliding with a repo that merely happens to live at `<cwd>/<name>`.
 *
 * Ambiguity — one key matching two DIFFERENT registered repos, e.g. repo A's
 * basename equals repo B's nickname — is reported with the full candidate list
 * so the caller can print a clear error instead of silently picking one. A
 * single repo matched more than one way (name AND its exact path) is deduped by
 * path, so it stays one unambiguous match.
 */
export function resolveRepo(
  key: string,
  repos: RepoEntry[],
  cwd: string = process.cwd(),
): RepoResolution {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, reason: "not-found" };

  const hasSlash = trimmed.includes("/");
  const lower = trimmed.toLowerCase();
  const resolvedPath = hasSlash ? resolve(cwd, trimmed) : null;

  const matches = repos.filter((r) => {
    // Path namespace: an exact path always counts; resolve(cwd, key) only for a
    // slashed (path-shaped) key, so a bare/dotted name never resolves as a path.
    const pathMatch = r.path === trimmed || r.path === resolvedPath;
    // Name namespace: skipped only for a slashed key. Dotted basenames stay here.
    const nameMatch =
      !hasSlash &&
      (r.name.toLowerCase() === lower ||
        (r.nickname !== undefined && r.nickname.toLowerCase() === lower));
    return pathMatch || nameMatch;
  });

  // Dedupe by path so a single repo matched on more than one field (its name and
  // its exact path, say) is never mistaken for an ambiguous pair — and a stray
  // duplicate-path registry entry can't inflate the candidate count either.
  const unique = Array.from(new Map(matches.map((r) => [r.path, r])).values());
  if (unique.length === 0) return { ok: false, reason: "not-found" };
  if (unique.length === 1) return { ok: true, repo: unique[0]! };
  return { ok: false, reason: "ambiguous", candidates: unique };
}

/**
 * Human-readable error for a failed resolveRepo(), reused by every call site so
 * the wording stays uniform. Not-found keeps the historical "Repo not found:
 * <key>" wording; ambiguous lists every candidate with its path.
 */
export function repoResolutionError(
  key: string,
  res: Exclude<RepoResolution, { ok: true }>,
): string {
  if (res.reason === "ambiguous") {
    const list = res.candidates
      .map((r) => `  - ${repoDisplayName(r)} (${r.path})`)
      .join("\n");
    return `Ambiguous repo "${key}" matches multiple registered repos:\n${list}`;
  }
  return `Repo not found: ${key}`;
}

export interface RegistryData {
  repos: RepoEntry[];
}

function itsybitsyDir(): string {
  return join(userHome(), ".itsybitsy");
}

function registryPath(): string {
  return join(itsybitsyDir(), "repos.json");
}

/** Registry entries can contain names derived from folder names, including dots. */
export function isStoredRepoName(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && !value.includes("/") &&
    value !== "." && value !== ".." && !value.startsWith("~");
}

/** Queue identity requires a complete registry. Only a fresh install (ENOENT) has no entries. */
export async function readRegistryStrict(): Promise<RegistryData> {
  const path = registryPath();
  try {
    const data = await Bun.file(path).json();
    if (!Array.isArray(data?.repos)) throw new Error("expected a repos array");
    for (const [index, repo] of data.repos.entries()) {
      if (typeof repo?.path !== "string" || !isAbsolute(repo.path) ||
          !isStoredRepoName(repo.name) ||
          [repo.nickname, repo.defaultAgentType, repo.notes].some((v) => v !== undefined && typeof v !== "string")) {
        throw new Error(`invalid repository entry at index ${index}`);
      }
    }
    return { repos: data.repos };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { repos: [] };
    throw new Error(`Cannot read repo registry ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export async function loadRegistry(): Promise<RegistryData> {
  try {
    const data = await Bun.file(registryPath()).json();
    return { repos: Array.isArray(data?.repos) ? data.repos : [] };
  } catch {
    return { repos: [] };
  }
}

export async function saveRegistry(data: RegistryData): Promise<void> {
  await mkdir(itsybitsyDir(), { recursive: true });
  const path = registryPath();
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  const existing = await stat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
    return null;
  });
  const file = await open(tmp, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(data, null, 2) + "\n");
      if (existing) await file.chmod(existing.mode & 0o7777);
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * The registry name the `ib watch` folder browser gives a folder: lowercased,
 * each run of whitespace turned into "-", then every character outside
 * [a-z0-9_-] dropped. Returns "" when nothing is left. Both the [ Add ] and
 * the [ New Repo ] paths use it, so they name a folder the same way.
 */
export function repoNameFromFolder(folderName: string): string {
  return folderName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
}

/** The way forward from a taken name for `ib add` and the folder browser's [ Add ]: name the repo yourself. */
export const ADD_NAME_HINT = "use ib add <path> <name>";
/** The way forward from a taken name for [ New Repo ], which names the repo after the folder it creates. */
export const NEW_REPO_NAME_HINT = "choose another folder name";

async function repoRootFolderName(path: string): Promise<string> {
  return basename((await resolveGitRoot(path, AbortSignal.timeout(2_000))) || path);
}

/**
 * Why `repoName` at `resolvedPath` cannot be added to `registry`, or null if
 * it can. These are addRepo's rules, kept in one place so createRepo can check
 * them before it creates a folder on disk. `nameHint` ends a refusal of a taken
 * name (another repo's or a team's): what the caller can do instead.
 */
export async function checkNewRepoEntry(
  resolvedPath: string,
  repoName: string,
  registry: RegistryData,
  nameHint: string = ADD_NAME_HINT,
): Promise<string | null> {
  const canonicalRepo = await realpath(resolvedPath).catch(() => resolve(resolvedPath));
  const canonicalHome = await realpath(userHome()).catch(() => resolve(userHome()));
  if (canonicalRepo === canonicalHome) {
    return "Cannot register $HOME as a repo: its runtime directory would collide with ~/.itsybitsy user-wide state";
  }
  if (!isValidRepoName(repoName)) {
    return `"${repoName}" is not a valid repo name — use alphanumeric, hyphens, underscores only (1-64 chars)`;
  }

  // "coordinator" is reserved for system coordinator addressing (SPEC §12.3.1)
  if (repoName === "coordinator") {
    return `"coordinator" is a reserved name — rename the directory or use a custom name`;
  }

  // Reject a repo name that collides with an EXISTING team — `@<repo>` and
  // `@<team>` share one flat `@` namespace, so an after-the-fact repo of the
  // same name would silently shadow the team (the resolver checks repos before
  // teams). Bidirectional with team-create's collision refusal (SPEC §16.1).
  // Case-SENSITIVE strict lookup, matching the resolver and getTeam's exact keys.
  if ((await getTeam(normalizeTeamName(repoName))) !== null) {
    return `"${repoName}" is already a team name — choose a different repo name; ${nameHint}`;
  }

  // Check for duplicate
  if (registry.repos.some((r) => r.path === resolvedPath)) {
    return `Already registered: ${resolvedPath}`;
  }

  // Two folders that differ only in case or in the characters the coordinator
  // ID replaces ("a.b" and "a_b") give the same ID, so they clash too.
  const folderName = await repoRootFolderName(resolvedPath);
  const coordinatorId = coordinatorIdFromFolderName(folderName);
  const lowerCoordinatorId = coordinatorId.toLowerCase();
  for (const existing of registry.repos) {
    if (coordinatorIdFromFolderName(await repoRootFolderName(existing.path)).toLowerCase() === lowerCoordinatorId) {
      return `Cannot register ${resolvedPath}: its coordinator id "${coordinatorId}" (from repo root folder name "${folderName}") is already used by registered repo "${existing.name}" (${existing.path}). A repo's coordinator is named after its folder, so two registered repos cannot have folder names that give the same coordinator id.`;
    }
  }

  // Repo names are unique, case-insensitively: a repo's name is the middle
  // segment of its agents' row keys in `ib watch` (`<machine>/<repo>/<agent>`,
  // SPEC §17.1). A nickname counts as a name, since it is what the tree shows.
  // Only new entries are checked; duplicates already registered stay.
  const lower = repoName.toLowerCase();
  const clash = registry.repos.find((r) => r.name.toLowerCase() === lower || r.nickname?.toLowerCase() === lower);
  if (clash) {
    return `"${repoName}" is already the name of a registered repo (${clash.path}) — repo names must be unique; ${nameHint}`;
  }

  return null;
}

export async function addRepo(repoPath: string, name?: string): Promise<{ ok: boolean; message: string }> {
  const resolved = resolve(repoPath);
  const repoName = name ?? basename(resolved);
  const registry = await readRegistryStrict();

  const error = await checkNewRepoEntry(resolved, repoName, registry);
  if (error) {
    return { ok: false, message: error };
  }

  registry.repos.push({ path: resolved, name: repoName });
  await saveRegistry(registry);
  return { ok: true, message: `Added: ${repoName} (${resolved})` };
}

export async function removeRepo(repoPath: string): Promise<{ ok: boolean; message: string }> {
  const resolved = resolve(repoPath);
  const registry = await readRegistryStrict();
  const before = registry.repos.length;
  registry.repos = registry.repos.filter((r) => r.path !== resolved);
  let removedPath = resolved;

  if (registry.repos.length === before) {
    // No exact path match — fall back to the shared resolver so `ib remove`
    // accepts a registry id / basename (case-insensitively) just like every
    // other by-name lookup.
    const res = resolveRepo(repoPath, registry.repos);
    if (!res.ok) {
      return { ok: false, message: repoResolutionError(repoPath, res) };
    }
    removedPath = res.repo.path;
    registry.repos = registry.repos.filter((r) => r.path !== removedPath);
  }

  await saveRegistry(registry);
  return { ok: true, message: `Removed: ${removedPath}` };
}

export async function renameRepo(repoPath: string, nickname: string): Promise<{ ok: boolean; message: string }> {
  const resolved = resolve(repoPath);
  const registry = await readRegistryStrict();
  const entry = registry.repos.find((r) => r.path === resolved);
  if (!entry) {
    return { ok: false, message: `Not found: ${resolved}` };
  }
  const trimmed = nickname.trim();
  if (trimmed) {
    if (!isValidRepoName(trimmed)) {
      return { ok: false, message: `"${trimmed}" is not a valid repo name — use alphanumeric, hyphens, underscores only (1-64 chars)` };
    }
    // "coordinator" is reserved for system coordinator addressing (SPEC §12.3.1)
    if (trimmed === "coordinator") {
      return { ok: false, message: `"coordinator" is a reserved name` };
    }
    // Reject nicknames that collide with another repo's display name or basename
    const lower = trimmed.toLowerCase();
    const collision = registry.repos.find((r) =>
      r.path !== resolved && (repoDisplayName(r).toLowerCase() === lower || r.name.toLowerCase() === lower)
    );
    if (collision) {
      return { ok: false, message: `Name "${trimmed}" already used by ${collision.path}` };
    }
    // Also reject a nickname that collides with an EXISTING team name — `@<repo>`
    // (by nickname) and `@<team>` share one flat `@` namespace (SPEC §16.1).
    // Case-SENSITIVE strict lookup. Only checked when SETTING a nickname;
    // clearing it (empty branch below) needs no team check.
    if ((await getTeam(normalizeTeamName(trimmed))) !== null) {
      return { ok: false, message: `Name "${trimmed}" is already a team name` };
    }
    entry.nickname = trimmed;
  } else {
    delete entry.nickname;
  }
  await saveRegistry(registry);
  return { ok: true, message: `Renamed ${entry.name} → ${trimmed || entry.name}` };
}

export async function setRepoDefaultAgentType(
  repoPath: string,
  type: string | null,
): Promise<{ ok: boolean; message: string }> {
  const resolved = resolve(repoPath);
  const registry = await readRegistryStrict();
  const entry = registry.repos.find((r) => r.path === resolved);
  if (!entry) {
    return { ok: false, message: `Not found: ${resolved}` };
  }
  const trimmed = type?.trim() ?? "";
  if (trimmed) {
    entry.defaultAgentType = trimmed;
  } else {
    delete entry.defaultAgentType;
  }
  await saveRegistry(registry);
  return {
    ok: true,
    message: trimmed
      ? `Set default agent type for ${entry.name} → ${trimmed}`
      : `Cleared default agent type for ${entry.name}`,
  };
}

export async function setRepoNotes(
  repoPath: string,
  notes: string | null,
): Promise<{ ok: boolean; message: string }> {
  const resolved = resolve(repoPath);
  const registry = await readRegistryStrict();
  const entry = registry.repos.find((r) => r.path === resolved);
  if (!entry) {
    return { ok: false, message: `Not found: ${resolved}` };
  }
  const value = notes ?? "";
  if (value.length > 0) {
    entry.notes = value;
  } else {
    delete entry.notes;
  }
  await saveRegistry(registry);
  return {
    ok: true,
    message: value.length > 0
      ? `Set notes for ${entry.name}`
      : `Cleared notes for ${entry.name}`,
  };
}

export async function listRepos(): Promise<RepoEntry[]> {
  const registry = await loadRegistry();
  return registry.repos;
}

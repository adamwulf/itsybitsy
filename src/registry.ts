import { join, resolve, basename } from "path";
import { userHome } from "./home";
import { mkdir } from "fs/promises";
// teams.ts imports listRepos/repoDisplayName FROM this module, so a static
// `import { getTeam } from "./teams"` forms an import cycle. It is SAFE here
// because we only dereference `getTeam`/`normalizeTeamName` INSIDE the async
// addRepo/renameRepo functions — long after both modules finish initializing
// (never at module-init / top-level). See SPEC §16.1 (bidirectional repo↔team
// name-collision refusal).
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
 *     and against resolve(cwd, key) so a relative path works too
 *
 * Names and paths occupy DISJOINT namespaces: a valid repo name/nickname is
 * `[A-Za-z0-9_-]+` (see isValidRepoName — no "/" and no "."), so a key that
 * contains "/" or "." can only ever be a path attempt, and a bare token can
 * only ever be a name attempt. That split keeps `resolve(cwd, "<name>")` from
 * ever colliding with a repo that happens to live at `<cwd>/<name>`.
 *
 * Ambiguity — one key matching two DIFFERENT registered repos, e.g. repo A's
 * basename equals repo B's nickname — is reported with the full candidate list
 * so the caller can print a clear error instead of silently picking one.
 */
export function resolveRepo(
  key: string,
  repos: RepoEntry[],
  cwd: string = process.cwd(),
): RepoResolution {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, reason: "not-found" };

  const looksLikePath = trimmed.includes("/") || trimmed.includes(".");
  let matches: RepoEntry[];
  if (looksLikePath) {
    const resolved = resolve(cwd, trimmed);
    matches = repos.filter((r) => r.path === trimmed || r.path === resolved);
  } else {
    const lower = trimmed.toLowerCase();
    matches = repos.filter(
      (r) =>
        r.name.toLowerCase() === lower ||
        (r.nickname !== undefined && r.nickname.toLowerCase() === lower),
    );
  }

  // Dedupe by path so a single repo matched on more than one field (e.g. its
  // name equals its own nickname) is never mistaken for an ambiguous pair.
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

export async function loadRegistry(): Promise<RegistryData> {
  try {
    const file = Bun.file(registryPath());
    if (!(await file.exists())) {
      return { repos: [] };
    }
    const data = await file.json();
    if (!data || !Array.isArray(data.repos)) {
      return { repos: [] };
    }
    return { repos: data.repos } as RegistryData;
  } catch { /* expected: file missing or malformed JSON */
    return { repos: [] };
  }
}

export async function saveRegistry(data: RegistryData): Promise<void> {
  await mkdir(itsybitsyDir(), { recursive: true });
  await Bun.write(registryPath(), JSON.stringify(data, null, 2) + "\n");
}

export async function addRepo(repoPath: string, name?: string): Promise<{ ok: boolean; message: string }> {
  const resolved = resolve(repoPath);
  const repoName = name ?? basename(resolved);

  if (!isValidRepoName(repoName)) {
    return { ok: false, message: `"${repoName}" is not a valid repo name — use alphanumeric, hyphens, underscores only (1-64 chars)` };
  }

  // "coordinator" is reserved for system coordinator addressing (SPEC §12.3.1)
  if (repoName === "coordinator") {
    return { ok: false, message: `"coordinator" is a reserved name — rename the directory or use a custom name` };
  }

  // Reject a repo name that collides with an EXISTING team — `@<repo>` and
  // `@<team>` share one flat `@` namespace, so an after-the-fact repo of the
  // same name would silently shadow the team (the resolver checks repos before
  // teams). Bidirectional with team-create's collision refusal (SPEC §16.1).
  // Case-SENSITIVE strict lookup, matching the resolver and getTeam's exact keys.
  if ((await getTeam(normalizeTeamName(repoName))) !== null) {
    return { ok: false, message: `"${repoName}" is already a team name — choose a different repo name (e.g. ib add <path> <name>)` };
  }

  const registry = await loadRegistry();

  // Check for duplicate
  if (registry.repos.some((r) => r.path === resolved)) {
    return { ok: false, message: `Already registered: ${resolved}` };
  }

  registry.repos.push({ path: resolved, name: repoName });
  await saveRegistry(registry);
  return { ok: true, message: `Added: ${repoName} (${resolved})` };
}

export async function removeRepo(repoPath: string): Promise<{ ok: boolean; message: string }> {
  const resolved = resolve(repoPath);
  const registry = await loadRegistry();
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
  const registry = await loadRegistry();
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
    const collision = registry.repos.find((r) =>
      r.path !== resolved && (repoDisplayName(r) === trimmed || r.name === trimmed)
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
  const registry = await loadRegistry();
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
  const registry = await loadRegistry();
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

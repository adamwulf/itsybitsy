import { join, resolve, basename } from "path";
import { homedir } from "os";
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

export interface RegistryData {
  repos: RepoEntry[];
}

function itsybitsyDir(): string {
  return join(process.env.HOME ?? homedir(), ".itsybitsy");
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

  if (registry.repos.length === before) {
    // Try matching by name — only remove the first match
    const idx = registry.repos.findIndex((r) => r.name === repoPath);
    if (idx === -1) {
      return { ok: false, message: `Not found: ${repoPath}` };
    }
    registry.repos.splice(idx, 1);
  }

  await saveRegistry(registry);
  return { ok: true, message: `Removed: ${resolved}` };
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

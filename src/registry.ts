import { join } from "path";

export interface RepoEntry {
  path: string;
  name: string;
}

export interface RegistryData {
  repos: RepoEntry[];
}

function registryPath(): string {
  return join(process.env.HOME ?? require("os").homedir(), ".itsybitsy.json");
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
    return data as RegistryData;
  } catch {
    return { repos: [] };
  }
}

export async function saveRegistry(data: RegistryData): Promise<void> {
  await Bun.write(registryPath(), JSON.stringify(data, null, 2) + "\n");
}

export async function addRepo(repoPath: string, name?: string): Promise<{ ok: boolean; message: string }> {
  const resolved = require("path").resolve(repoPath);
  const registry = await loadRegistry();

  // Check for duplicate
  if (registry.repos.some((r) => r.path === resolved)) {
    return { ok: false, message: `Already registered: ${resolved}` };
  }

  // Validate .ittybitty dir exists
  const ittybittyDir = join(resolved, ".ittybitty");
  const dirExists = await Bun.file(join(ittybittyDir, "repo-id")).exists();
  if (!dirExists) {
    // Allow adding even without .ittybitty, but warn
  }

  const repoName = name ?? require("path").basename(resolved);
  registry.repos.push({ path: resolved, name: repoName });
  await saveRegistry(registry);
  return { ok: true, message: `Added: ${repoName} (${resolved})` };
}

export async function removeRepo(repoPath: string): Promise<{ ok: boolean; message: string }> {
  const resolved = require("path").resolve(repoPath);
  const registry = await loadRegistry();
  const before = registry.repos.length;
  registry.repos = registry.repos.filter((r) => r.path !== resolved);

  if (registry.repos.length === before) {
    // Try matching by name
    const byName = registry.repos.filter((r) => r.name !== repoPath);
    if (byName.length === before) {
      return { ok: false, message: `Not found: ${repoPath}` };
    }
    registry.repos = byName;
  }

  await saveRegistry(registry);
  return { ok: true, message: `Removed: ${resolved}` };
}

export async function listRepos(): Promise<RepoEntry[]> {
  const registry = await loadRegistry();
  return registry.repos;
}

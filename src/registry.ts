import { join, resolve, basename } from "path";
import { homedir } from "os";

export interface RepoEntry {
  path: string;
  name: string;
}

export interface RegistryData {
  repos: RepoEntry[];
  diffTool?: string;
}

function registryPath(): string {
  return join(process.env.HOME ?? homedir(), ".itsybitsy.json");
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
  const resolved = resolve(repoPath);
  const registry = await loadRegistry();

  // Check for duplicate
  if (registry.repos.some((r) => r.path === resolved)) {
    return { ok: false, message: `Already registered: ${resolved}` };
  }

  const repoName = name ?? basename(resolved);
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

export async function listRepos(): Promise<RepoEntry[]> {
  const registry = await loadRegistry();
  return registry.repos;
}

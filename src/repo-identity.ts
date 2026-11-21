import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { agentDir, agentDirSuffix, agentsDir } from "./runtime-names";

/** A sandbox may grant access to agents/ while denying realpath of its repo root. */
export function canonicalRepoPath(path: string, id?: string): string {
  try { return realpathSync.native(path); } catch { /* Try the accessible agents directory. */ }
  const dir = agentsDir(path);
  const accessible = id ? agentDir(path, id) : dir;
  try {
    const actual = realpathSync.native(accessible);
    const suffix = id ? agentDirSuffix(id) : agentsDir("/");
    if (actual.endsWith(suffix) && !lstatSync(dir).isSymbolicLink() &&
        !lstatSync(dirname(dir)).isSymbolicLink() && (!id || !lstatSync(accessible).isSymbolicLink())) {
      return actual.slice(0, -suffix.length) || "/";
    }
  } catch { /* The repo may be absent or inaccessible. */ }
  return resolve(path);
}

export function sameRepoPath(left: string, right: string | null | undefined, id?: string): boolean {
  return !!right && (left === right || canonicalRepoPath(left, id) === canonicalRepoPath(right, id));
}

import { mkdir } from "fs/promises";
import * as runtimeNames from "./runtime-names";

/**
 * Read the repo-id from .itsybitsy/repo-id (or create one).
 * Mirrors get_repo_id() in ib bash.
 */
export async function getRepoId(repoPath: string): Promise<string> {
  const repoIdFile = runtimeNames.repoIdFile(repoPath);
  let existing = "";
  try {
    existing = (await Bun.file(repoIdFile).text()).trim();
  } catch (err) {
    // Only a file that is genuinely absent may be (re)created. Any other read
    // failure (a sandboxed agent's EPERM/EACCES, an I/O error) means an id may
    // already exist that we simply cannot see; generating a new one would
    // silently re-key every tmux session name (`itsybitsy-<repoId>-<agent>`)
    // and sealed record of the repo. Fail loudly instead.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new Error(
        `Cannot read repository id ${repoIdFile}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Refusing to generate a new id over one that may already exist.`,
      );
    }
  }
  if (/^[0-9a-f]{8}$/.test(existing)) return existing;
  if (existing) throw new Error(`Invalid repository id in ${repoIdFile}: expected 8 lowercase hexadecimal characters`);

  // Generate new 8 hex char ID
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const newId = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  await mkdir(runtimeNames.runtimeDir(repoPath), { recursive: true });
  await Bun.write(repoIdFile, newId + "\n");
  return newId;
}

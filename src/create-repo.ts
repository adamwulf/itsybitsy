/**
 * Create a brand-new git repo in an existing folder and register it. This is
 * the work behind the [ New Repo ] button of the `ib watch` "Add Repository"
 * folder browser; it lives outside the TUI so it can be tested on its own.
 */

import { join, resolve } from "path";
import { mkdir, stat } from "fs/promises";
import { SpawnContext } from "./types";
import { addRepo, checkNewRepoEntry, loadRegistry, repoNameFromFolder } from "./registry";

/**
 * Runs the two git commands. Production uses the real `Bun.spawn`, so git
 * runs with the user's own config and identity. Tests swap in a runner that
 * gives git a throwaway identity (see src/test-git-identity.ts).
 */
export const createRepoSpawnCtx = new SpawnContext();

export interface CreateRepoResult {
  ok: boolean;
  message: string;
  /** Set once the folder exists on disk, even when a later step failed. */
  path?: string;
}

/**
 * True when `dir` has a `.git` entry: a directory, or the file a worktree or
 * submodule uses. This is the folder browser's `FolderItem.isGit` test.
 */
export async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Create `<parentDir>/<folderName>`, run `git init` and an empty
 * "Initial commit" in it, then add it to the registry.
 *
 * Every check that can fail without touching the disk runs first: the folder
 * name, a parent that is already a git repo, and the registry rules addRepo
 * enforces. The folder is created without `recursive`, so an existing folder
 * is refused. If git or the registry fails after the folder exists, the
 * result names the folder and nothing is deleted.
 */
export async function createRepo(parentDir: string, folderName: string): Promise<CreateRepoResult> {
  const name = folderName.trim();
  if (!name) {
    return { ok: false, message: "Folder name is empty" };
  }
  if (name === "." || name === ".." || name.includes("/")) {
    return { ok: false, message: `"${name}" is not a folder name — it must not be "." or ".." or contain "/"` };
  }

  const parent = resolve(parentDir);
  if (await hasGitEntry(parent)) {
    return { ok: false, message: `${parent} is already a git repo — pick a folder outside a repo` };
  }

  const repoName = repoNameFromFolder(name);
  if (!repoName) {
    return { ok: false, message: `Cannot derive a valid name from ${name}` };
  }

  const target = join(parent, name);
  const entryError = await checkNewRepoEntry(target, repoName, await loadRegistry());
  if (entryError) {
    return { ok: false, message: entryError };
  }

  try {
    await mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, message: `Already exists: ${target}` };
    }
    return { ok: false, message: `Cannot create ${target}: ${(err as Error).message}` };
  }

  const init = await runGit(["git", "init", target]);
  if (!init.ok) {
    return { ok: false, message: `Created ${target}, but git init failed: ${init.output}`, path: target };
  }

  const commit = await runGit(["git", "-C", target, "commit", "--allow-empty", "-m", "Initial commit"]);
  if (!commit.ok) {
    return { ok: false, message: `Created ${target}, but git commit failed: ${commit.output}`, path: target };
  }

  // addRepo reports a refusal in its result but THROWS when the registry
  // write fails; either way the folder exists, so the error must name it.
  let added: { ok: boolean; message: string };
  try {
    added = await addRepo(target, repoName);
  } catch (err) {
    added = { ok: false, message: (err as Error).message };
  }
  if (!added.ok) {
    return { ok: false, message: `Created ${target}, but could not add it: ${added.message}`, path: target };
  }
  return { ok: true, message: `Created and added: ${repoName} (${target})`, path: target };
}

/**
 * Run one git command. `output` is git's stderr (or stdout when stderr is
 * empty) folded onto one line, since the result is shown in the dashboard's
 * one-line notice.
 */
async function runGit(cmd: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr, exitCode } = await createRepoSpawnCtx.run(cmd);
    const text = (stderr || stdout).split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
    return { ok: exitCode === 0, output: text || `exit code ${exitCode}` };
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}

import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** A live fd prevents inode recycling. Darwin volfs addresses the vnode by
 * device and inode; Linux procfs addresses the open directory by descriptor. */
export async function pinnedPath(handle: FileHandle) {
  if (process.platform !== "darwin") return `/proc/self/fd/${handle.fd}`;
  const info = await handle.stat({ bigint: true });
  return `/.vol/${info.dev}/${info.ino}`;
}

async function openDirectory(path: string, create: boolean): Promise<FileHandle> {
  if (path === "/") return open(path, directoryFlags);
  if (process.platform === "darwin") {
    try { return await open(path, directoryFlags | 0x20000000 /* O_NOFOLLOW_ANY */); }
    catch (err) { if (!create || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  const parent = await openDirectory(dirname(path), create);
  try {
    const child = join(await pinnedPath(parent), basename(path));
    if (create) await mkdir(child, { mode: 0o700 }).catch(err => { if (err.code !== "EEXIST") throw err; });
    return await open(child, directoryFlags);
  } finally { await parent.close(); }
}

export async function withPinnedDirectory<T>(directory: string, create: boolean, use: (path: string, handle: FileHandle) => Promise<T>) {
  const path = resolve(directory);
  const physical = process.platform === "darwin" ? path.replace(/^\/(tmp|var)(?=\/|$)/, "/private/$1") : path;
  const handle = await openDirectory(physical, create);
  try { return await use(await pinnedPath(handle), handle); }
  finally { await handle.close(); }
}

/** The parent must already exist; an exited agent is never recreated. */
export async function openBrokerResults(agentDir: string, create: boolean) {
  return withPinnedDirectory(agentDir, false, async parent => {
    const child = join(parent, "spawn-results");
    if (create) await mkdir(child, { mode: 0o700 }).catch(err => { if (err.code !== "EEXIST") throw err; });
    return open(child, directoryFlags);
  });
}

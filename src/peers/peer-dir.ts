import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { peerDir } from "../runtime-names";

/**
 * Create `~/.itsybitsy/peer/` with mode 0700 when it is missing, and return
 * its path. The parent is created with default permissions: a recursive mkdir
 * with a mode would also apply 0700 to `~/.itsybitsy` itself.
 */
export async function ensurePeerDir(): Promise<string> {
  const dir = peerDir();
  await mkdir(dirname(dir), { recursive: true });
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return dir;
}

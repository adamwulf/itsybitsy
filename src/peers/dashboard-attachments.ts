import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { references } from "../message-attachments";
import { userHome } from "../home";
import { canonicalizeSandboxPath } from "../sandbox";

/** Use the input field's parser. A peer's repo path is a display string:
 * compare its spelling, but never look it up on the local filesystem. */
export async function dashboardAttachmentPaths(text: string, remoteRoot?: string, localRoot?: string) {
  const paths = new Set<string>();
  const local = localRoot && canonicalizeSandboxPath(localRoot);
  const inside = (root: string | undefined, path: string) => !!root && (path === root || path.startsWith(root + "/"));
  for (const ref of references(text)) {
    let path = ref.path;
    if (!path.startsWith("/") && !path.startsWith("~/")) continue;
    for (;;) {
      const absolute = path.startsWith("~/") ? resolve(userHome(), path.slice(2)) : path;
      if (inside(remoteRoot, absolute)) break;
      try {
        const info = await stat(absolute);
        if (local && inside(local, canonicalizeSandboxPath(absolute))) break;
        if (!info.isFile()) throw new Error(`Attachment is not a regular file: ${path}`);
        paths.add(path);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        if (!ref.quote && /^\/[\w-]+$/.test(path)) break;
        if (!ref.quote && /[.,;:!\)\]}]$/.test(path)) { path = path.slice(0, -1); continue; }
        if (local && inside(local, canonicalizeSandboxPath(absolute))) break;
        throw new Error(`Cannot stage attachment ${JSON.stringify(path)}: file not found`);
      }
    }
  }
  return [...paths];
}

import { realpathArgument } from "./attachment-manifest";
import { resolve } from "node:path";
import { references } from "../message-attachments";
import { userHome } from "../home";
import { canonicalizeSandboxPath } from "../sandbox";

/** Use the input field's parser. A peer's repo path is a display string:
 * compare its spelling, but never look it up on the local filesystem. */
export async function dashboardAttachmentPaths(text: string, remoteRoot?: string, localRoot?: string) {
  const paths = new Map<string, { argument: string; source: string }>();
  const local = localRoot && canonicalizeSandboxPath(localRoot);
  const inside = (root: string | undefined, path: string) => !!root && (path === root || path.startsWith(root + "/"));
  for (const ref of references(text)) {
    let path = ref.path;
    if (!path.startsWith("/") && !path.startsWith("~/")) continue;
    for (;;) {
      const absolute = path.startsWith("~/") ? userHome() + path.slice(1) : path;
      try {
        const source = await realpathArgument(absolute);
        if (inside(local, source)) break;
        paths.set(path, { argument: path, source });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        if (!ref.quote && /^\/[\w-]+$/.test(path)) break;
        if (!ref.quote && /[.,;:!\)\]}]$/.test(path)) { path = path.slice(0, -1); continue; }
        if (inside(remoteRoot, resolve(absolute)) || (local && inside(local, canonicalizeSandboxPath(absolute)))) break;
        throw new Error(`Cannot stage attachment ${JSON.stringify(path)}: file not found`);
      }
    }
  }
  return [...paths.values()];
}

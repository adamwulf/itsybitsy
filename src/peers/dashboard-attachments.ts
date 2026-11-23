import { realpathArgument } from "./attachment-manifest";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { references } from "../message-attachments";
import { userHome } from "../home";
import { canonicalizeSandboxPath } from "../sandbox";

async function resolveMissingReference(path: string) {
  const suffix: string[] = [];
  let prefix = path;
  for (;;) {
    try {
      const existing = await realpathArgument(prefix);
      const firstMissing = suffix.at(-1);
      if (firstMissing) {
        const leaf = await lstat(join(existing, firstMissing)).catch(err => {
          if (err.code !== "ENOENT") throw err;
        });
        if (leaf?.isSymbolicLink()) throw new Error(`Unresolved attachment: ${path}`);
      }
      return resolve(existing, ...suffix.reverse());
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || prefix === "/") throw err;
      suffix.push(basename(prefix));
      prefix = dirname(prefix);
    }
  }
}

/** Use the input field's parser. A peer's repo path is a display string:
 * compare its spelling, but never look it up on the local filesystem. */
export async function dashboardAttachmentPaths(text: string, remoteRoot?: string, localRoot?: string) {
  let noPassthrough = false;
  const paths = new Map<string, { argument: string; source: string }>();
  const local = localRoot && canonicalizeSandboxPath(localRoot);
  const inside = (root: string | undefined, path: string) => !!root && (path === root || path.startsWith(root + "/"));
  for (const ref of references(text)) {
    let path = ref.path;
    const relative = !path.startsWith("/") && !path.startsWith("~/");
    if (relative && !localRoot) {
      if (ref.start === 0) noPassthrough = true;
      continue;
    }
    for (;;) {
      const absolute = path.startsWith("~/") ? userHome() + path.slice(1) : relative ? localRoot + "/" + path : path;
      try {
        const source = await realpathArgument(absolute);
        if (ref.start === 0) noPassthrough = true;
        if (relative || inside(local, source)) break;
        paths.set(path, { argument: path, source });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        if (!ref.quote && /[.,;:!\)\]}]$/.test(path)) { path = path.slice(0, -1); continue; }
        const localPath = await resolveMissingReference(absolute);
        if (!ref.quote && /^\/[\w-]+$/.test(path)) break;
        if (relative) { if (ref.start === 0) noPassthrough = true; break; }
        const peerOnly = !inside(localRoot, absolute) && inside(remoteRoot, absolute) && inside(remoteRoot, resolve(absolute));
        if (peerOnly || inside(local, localPath)) {
          if (ref.start === 0) noPassthrough = true;
          break;
        }
        throw new Error(`Cannot stage attachment ${JSON.stringify(path)}: file not found`);
      }
    }
  }
  return { paths: [...paths.values()], noPassthrough };
}

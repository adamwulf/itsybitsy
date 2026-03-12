/**
 * Open a tmux session in a new Ghostty window.
 *
 * Note: Ghostty's `+new-window` action (which would reuse a running instance) is
 * GTK-only and does not work on macOS. On macOS there is no CLI mechanism to open
 * a new window in an existing Ghostty process, so we spawn a new Ghostty instance
 * each time. This means a new app appears in the Dock per session — accepted limitation.
 */

import { InjectionContext } from "./types";

type WhichFn = (cmd: string) => string | null;
type GhosttySpawnFn = (cmd: string[], opts?: object) => { unref(): void };

export const spawnCtx = new InjectionContext<GhosttySpawnFn>(Bun.spawn as GhosttySpawnFn);
export const whichCtx = new InjectionContext<WhichFn>(Bun.which as WhichFn);

export async function openPathInGhostty(
  dirPath: string
): Promise<{ ok: boolean; message: string }> {
  if (!whichCtx.fn("ghostty")) {
    return { ok: false, message: "Ghostty not found on PATH" };
  }
  try {
    // SECURITY: Validate path contains no control characters (C0, DEL) or null bytes.
    if (dirPath.length === 0 || /[\x00-\x1f\x7f]/.test(dirPath)) {
      return { ok: false, message: "Invalid directory path" };
    }
    // Ghostty's CLI requires --key=value (with equals sign). The entire command
    // is one string value that Ghostty splits with shell-like parsing.
    // Escape single quotes in the path so it survives single-quoting.
    const escapedPath = dirPath.replace(/'/g, "'\\''");
    const proc = spawnCtx.fn(["ghostty", `--command=bash -c 'cd ${escapedPath} && exec bash -l'`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    return { ok: true, message: "Opened in Ghostty" };
  } catch (err) {
    return { ok: false, message: `${err}` };
  }
}

export async function openInGhostty(
  tmuxSession: string
): Promise<{ ok: boolean; message: string }> {
  if (!whichCtx.fn("ghostty")) {
    return { ok: false, message: "Ghostty not found on PATH" };
  }
  try {
    // SECURITY: This /^[\w-]+$/ validation is load-bearing — it is the primary
    // defense against shell injection via tmux session names. Do not weaken or remove.
    if (!/^[\w-]+$/.test(tmuxSession)) {
      return { ok: false, message: "Invalid tmux session name" };
    }
    // Ghostty's CLI requires --key=value (with equals sign). The entire command
    // is one string value that Ghostty splits with shell-like parsing.
    // tmuxSession is validated to /^[\w-]+$/ so it is safe to interpolate directly.
    // Set window-size to 'latest' so tmux resizes to Ghostty's dimensions when attaching.
    const proc = spawnCtx.fn(["ghostty", `--command=bash -c 'tmux set-option -t ${tmuxSession} window-size latest && tmux attach -t ${tmuxSession}'`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    return { ok: true, message: "Opened in Ghostty" };
  } catch (err) {
    return { ok: false, message: `${err}` };
  }
}

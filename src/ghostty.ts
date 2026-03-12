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
    // SECURITY: Validate path contains no control characters or null bytes.
    if (!/^[^\x00-\x1f]+$/.test(dirPath) || dirPath.length === 0) {
      return { ok: false, message: "Invalid directory path" };
    }
    const proc = spawnCtx.fn(["ghostty", `--working-directory=${dirPath}`], {
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
    // Wrap in bash -c so Ghostty's login shell flags (--posix --login) go to bash, not tmux.
    // Set window-size to 'latest' so tmux resizes to Ghostty's dimensions when attaching.
    // Sessions are created at 60 cols by ib and don't auto-resize on re-attach without this.
    // Session name is passed as a separate argument (positional $1) — never interpolated
    // into the shell code string — so it cannot break out of the quoting context.
    const proc = spawnCtx.fn(["ghostty", "--command", "bash", "-c", 'tmux set-option -t "$1" window-size latest && tmux attach -t "$1"', "_", tmuxSession], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    return { ok: true, message: "Opened in Ghostty" };
  } catch (err) {
    return { ok: false, message: `${err}` };
  }
}

/**
 * Open a tmux session in a new Ghostty window.
 *
 * Note: Ghostty's `+new-window` action (which would reuse a running instance) is
 * GTK-only and does not work on macOS. On macOS there is no CLI mechanism to open
 * a new window in an existing Ghostty process, so we spawn a new Ghostty instance
 * each time. This means a new app appears in the Dock per session — accepted limitation.
 */

type WhichFn = (cmd: string) => string | null;
type GhosttySpawnFn = (cmd: string[], opts?: object) => { unref(): void };

let whichFn: WhichFn = Bun.which as WhichFn;
let spawnFn: GhosttySpawnFn = Bun.spawn as GhosttySpawnFn;

/** Override Bun.which for testing. */
export function setWhich(fn: WhichFn): void {
  whichFn = fn;
}

/** Reset Bun.which to default. */
export function resetWhich(): void {
  whichFn = Bun.which as WhichFn;
}

/** Override Bun.spawn for testing. */
export function setSpawn(fn: GhosttySpawnFn): void {
  spawnFn = fn;
}

/** Reset Bun.spawn to default. */
export function resetSpawn(): void {
  spawnFn = Bun.spawn as GhosttySpawnFn;
}

export async function openInGhostty(
  tmuxSession: string
): Promise<{ ok: boolean; message: string }> {
  if (!whichFn("ghostty")) {
    return { ok: false, message: "Ghostty not found on PATH" };
  }
  try {
    // Validate session name contains only safe characters (alphanumeric, hyphens, underscores)
    if (!/^[\w-]+$/.test(tmuxSession)) {
      return { ok: false, message: "Invalid tmux session name" };
    }
    // Wrap in bash -c so Ghostty's login shell flags (--posix --login) go to bash, not tmux.
    // Set window-size to 'latest' so tmux resizes to Ghostty's dimensions when attaching.
    // Sessions are created at 60 cols by ib and don't auto-resize on re-attach without this.
    // Pass session name as a positional parameter ($1) to avoid shell interpolation
    const proc = spawnFn(["ghostty", `--command=bash -c 'tmux set-option -t "$1" window-size latest && tmux attach -t "$1"' -- ${tmuxSession}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    return { ok: true, message: "Opened in Ghostty" };
  } catch (err) {
    return { ok: false, message: `${err}` };
  }
}

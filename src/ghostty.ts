/**
 * Open a tmux session in a new Ghostty window.
 *
 * Note: Ghostty's `+new-window` action (which would reuse a running instance) is
 * GTK-only and does not work on macOS. On macOS there is no CLI mechanism to open
 * a new window in an existing Ghostty process, so we spawn a new Ghostty instance
 * each time. This means a new app appears in the Dock per session — accepted limitation.
 */

export async function openInGhostty(
  tmuxSession: string
): Promise<{ ok: boolean; message: string }> {
  if (!Bun.which("ghostty")) {
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
    const proc = Bun.spawn(["ghostty", `--command=bash -c "tmux set-option -t ${tmuxSession} window-size latest && tmux attach -t ${tmuxSession}"`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    return { ok: true, message: "Opened in Ghostty" };
  } catch (err) {
    return { ok: false, message: `${err}` };
  }
}

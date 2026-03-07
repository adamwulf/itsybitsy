/**
 * Open a tmux session in a new Ghostty window.
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
    // Wrap in bash -c so Ghostty's login shell flags (--posix --login) go to bash, not tmux
    const proc = Bun.spawn(["ghostty", `--command=bash -c "tmux attach -t ${tmuxSession}"`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    return { ok: true, message: "Opened in Ghostty" };
  } catch (err) {
    return { ok: false, message: `${err}` };
  }
}

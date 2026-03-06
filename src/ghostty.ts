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
    // Ghostty's --command takes a single shell string; array-style args aren't possible here
    const proc = Bun.spawn(["ghostty", `--command=tmux attach -t ${tmuxSession}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    return { ok: true, message: "Opened in Ghostty" };
  } catch (err) {
    return { ok: false, message: `${err}` };
  }
}

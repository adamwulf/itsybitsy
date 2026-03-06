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
    Bun.spawn(["ghostty", `--command=tmux attach -t ${tmuxSession}`]);
    return { ok: true, message: "Opened in Ghostty" };
  } catch (err) {
    return { ok: false, message: `${err}` };
  }
}

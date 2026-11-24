/**
 * `C` on a remote agent in `ib watch` (SPEC §20.5): a local tmux session
 * running `ib peer attach` on that agent, opened in Ghostty the way `C` opens
 * a local agent's session (src/ghostty.ts).
 *
 * The session is named `ib-remote-<peer short id>-<repo>-<agent>-<hash>`,
 * outside the `itsybitsy-` prefix, so orphan cleanup never takes it for an
 * agent's. When
 * it already exists (the window was closed but `ib peer attach` still runs)
 * `C` opens it again instead of starting a second attach. It ends when `ib
 * peer attach` exits.
 */

import { createHash } from "node:crypto";
import { openInGhostty } from "../ghostty";
import { InjectionContext } from "../types";
import { isValidAgentId } from "../validation";
import { shortPeerId } from "./store";

export interface TerminalWindowDeps {
  /** Run one tmux command; resolves with its exit code. */
  runTmux(args: string[]): Promise<number>;
  openInGhostty(session: string): Promise<{ ok: boolean; message: string }>;
}

/** Injectable so a dashboard test pressing `C` never reaches the real tmux server. */
export const terminalWindowCtx = new InjectionContext<TerminalWindowDeps>({
  runTmux: async (args) => Bun.spawn(["tmux", ...args], { stdout: "ignore", stderr: "ignore" }).exited,
  openInGhostty,
});

/**
 * Agent ids repeat across repos, so the repo is part of the name (characters
 * outside `[\w-]` as `_`, for reading). Both may contain `-`, and the
 * replacement merges names, so a hash of the exact `<repo>/<agent>` ends it.
 */
export function remoteTerminalSession(peerId: string, repo: string, agent: string): string {
  const safeRepo = repo.replace(/[^\w-]/g, "_");
  const hash = createHash("sha256").update(`${repo}/${agent}`).digest("hex").slice(0, 8);
  return `ib-remote-${shortPeerId(peerId)}-${safeRepo ? `${safeRepo}-` : ""}${agent}-${hash}`;
}

export interface RemoteTerminalRow {
  peerId: string;
  peerName: string;
  /** The agent's registry repo on the peer. */
  repo: string;
  agent: string;
}

/** Start (or reuse) the local session for `row` and open it in Ghostty. Never throws. */
export async function openRemoteTerminal(row: RemoteTerminalRow, deps: TerminalWindowDeps = terminalWindowCtx.fn): Promise<{ ok: boolean; message: string }> {
  // The id and repo come from the peer: the session name must match
  // openInGhostty's /^[\w-]+$/, and the target must parse as three segments.
  if (!isValidAgentId(row.agent)) return { ok: false, message: "Invalid remote agent id" };
  const repoName = row.repo.length > 0 && !/[/\p{Cc}\p{Cf}]/u.test(row.repo) ? row.repo : "";
  const session = remoteTerminalSession(row.peerId, repoName, row.agent);
  const repo = repoName ? `${repoName}/` : "";
  try {
    if (await deps.runTmux(["has-session", "-t", `=${session}`]) !== 0) {
      // Several arguments: tmux runs `ib` directly, never through a shell.
      const started = await deps.runTmux(["new-session", "-d", "-s", session, "ib", "peer", "attach", `${row.peerId}/${repo}${row.agent}`]);
      if (started !== 0) return { ok: false, message: `Could not start tmux session ${session}` };
    }
    const opened = await deps.openInGhostty(session);
    if (!opened.ok) return { ok: false, message: `${opened.message}; attach with: tmux attach -t ${session}` };
    return { ok: true, message: `Opened ${row.peerName}/${repo}${row.agent} in Ghostty` };
  } catch (err) {
    return { ok: false, message: `Remote terminal: ${err instanceof Error ? err.message : String(err)}` };
  }
}

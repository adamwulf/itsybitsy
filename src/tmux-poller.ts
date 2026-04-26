/**
 * Polls tmux capture-pane for the selected agent (~1s interval).
 * Separate concern from watcher.ts: this handles live output capture
 * for display, while watcher handles structural agent changes.
 */

import { stripAnsi } from "./parse-state";
import { SpawnContext } from "./types";

/** Spawn context for tmux poller operations */
export const spawnCtx = new SpawnContext();

export interface TmuxPollerEvents {
  /** Raw tmux output (with ANSI) for display */
  onOutput: (raw: string, stripped: string) => void;
  onWidth?: (width: number) => void;
  onError?: (error: Error) => void;
}

export class TmuxPoller {
  private tmuxSession: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private events: TmuxPollerEvents;
  private lines: number;

  constructor(events: TmuxPollerEvents, lines = 200) {
    this.events = events;
    this.lines = lines;
  }

  /**
   * Update the scrollback length captured per poll. Triggers an immediate
   * poll if the value changed AND a session is set AND the poller is running,
   * so the next render reflects the new buffer size without waiting up to 1s
   * for the next tick.
   */
  setLines(n: number): void {
    if (n === this.lines) return;
    this.lines = n;
    if (this.tmuxSession && this.running) {
      this.poll();
    }
  }

  /** Set the agent to poll. Pass null to pause polling. */
  setAgent(tmuxSession: string | null): void {
    // Short-circuit when the session hasn't changed — the dashboard calls
    // setAgent() on every onUpdate (~2s), so without this guard we'd fire a
    // redundant poll() and getTmuxWindowWidth() every state-poll tick even
    // when the user hasn't switched agents.
    if (this.tmuxSession === tmuxSession) return;
    this.tmuxSession = tmuxSession;
    // Immediately poll on agent change, and query the tmux window width once
    // for this session. Width only changes on terminal resize or our own
    // resizeTmuxWindow() calls, so polling it every tick wastes posix_spawn.
    if (tmuxSession && this.running) {
      this.poll();
      if (this.events.onWidth) {
        const target = tmuxSession;
        getTmuxWindowWidth(target).then((w) => {
          if (w !== null && this.tmuxSession === target) {
            this.events.onWidth!(w);
          }
        }).catch(() => {
          // Silently ignore — width query is best-effort
        });
      }
    }
  }

  start(): void {
    this.running = true;
    this.timer = setInterval(() => {
      if (this.running && this.tmuxSession) {
        this.poll();
      }
    }, 1000);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    // Snapshot the session before async work to detect agent switches
    const targetSession = this.tmuxSession;
    if (!targetSession) return;

    try {
      const proc = spawnCtx.runner(
        ["tmux", "capture-pane", "-t", targetSession, "-p", `-S`, `-${this.lines}`, "-E", "-"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const raw = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      // Discard result if the agent changed while we were awaiting
      if (this.tmuxSession !== targetSession) return;

      if (exitCode !== 0) {
        // tmux session doesn't exist
        this.events.onOutput("", "");
        return;
      }

      const stripped = stripAnsi(raw);
      this.events.onOutput(raw, stripped);
      // Note: window width is queried once in setAgent() rather than on every
      // poll tick — it only changes on terminal resize or resizeTmuxWindow()
      // calls, so per-tick polling wasted ~1 posix_spawn/sec.
    } catch (err) {
      // Discard errors for stale polls too
      if (this.tmuxSession !== targetSession) return;
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** Get the width of a tmux window for a session */
export async function getTmuxWindowWidth(tmuxSession: string): Promise<number | null> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "display-message", "-t", tmuxSession, "-p", "#{window_width}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const width = parseInt(raw.trim(), 10);
    return isNaN(width) ? null : width;
  } catch { /* expected: tmux not running or session gone */
    return null;
  }
}

/** Resize a tmux window to a given width */
export async function resizeTmuxWindow(tmuxSession: string, width: number): Promise<boolean> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "resize-window", "-t", tmuxSession, "-x", String(width)],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch { /* expected: tmux not running or session gone */
    return false;
  }
}

/**
 * Clear the manual size override on a tmux window, switching to automatic
 * client-driven sizing. Call this before attaching a new client (e.g. Ghostty)
 * so the client's terminal dimensions take effect instead of the fixed width
 * set by `tmux new-session -d -x 60`.
 */
export async function clearTmuxWindowSizeOverride(tmuxSession: string): Promise<boolean> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "resize-window", "-A", "-t", tmuxSession],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch { /* expected: tmux not running or session gone */
    return false;
  }
}

/**
 * List all tmux session names. Returns empty array if tmux is not running.
 */
export async function listTmuxSessions(): Promise<string[]> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "list-sessions", "-F", "#{session_name}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];
    return raw.trim().split("\n").filter((s) => s.length > 0);
  } catch { /* expected: tmux server not running */
    return [];
  }
}

/**
 * Kill a tmux session by name.
 */
export async function killTmuxSession(sessionName: string): Promise<boolean> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "kill-session", "-t", sessionName],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch { /* expected: tmux not running or session already gone */
    return false;
  }
}

/**
 * Check if a tmux session has any attached clients (e.g. opened in Ghostty/Terminal.app).
 * Returns true if at least one client is attached.
 */
export async function hasAttachedClient(tmuxSession: string): Promise<boolean> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "list-clients", "-t", tmuxSession, "-F", "#{client_name}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    return raw.trim().split("\n").some((s) => s.length > 0);
  } catch { /* expected: tmux not running or session gone */
    return false;
  }
}

/**
 * Capture tmux output for a single agent (one-shot).
 * Used by watcher to detect agent state.
 */
export async function captureTmuxOutput(tmuxSession: string, lines = 5000): Promise<string | null> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "capture-pane", "-t", tmuxSession, "-p", `-S`, `-${lines}`, "-E", "-"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return null; // session doesn't exist
    return stripAnsi(raw);
  } catch { /* expected: tmux not running or session gone */
    return null;
  }
}

/**
 * Send literal text to a tmux session via send-keys -l, followed by Enter.
 * Returns true on success.
 */
export async function sendTmuxKeys(tmuxSession: string, text: string): Promise<boolean> {
  try {
    const sendProc = spawnCtx.runner(
      ["tmux", "send-keys", "-t", tmuxSession, "-l", text],
      { stdout: "pipe", stderr: "pipe" },
    );
    const sendExit = await sendProc.exited;
    if (sendExit !== 0) return false;

    const enterProc = spawnCtx.runner(
      ["tmux", "send-keys", "-t", tmuxSession, "Enter"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const enterExit = await enterProc.exited;
    return enterExit === 0;
  } catch {
    return false;
  }
}

/**
 * Polls tmux capture-pane for the selected agent (~1s interval).
 * Separate concern from watcher.ts: this handles live output capture
 * for display, while watcher handles structural agent changes.
 */

import { stripAnsi } from "./parse-state";
import { SpawnContext } from "./types";
import { tmuxSessionTarget } from "./validation";

/** Spawn context for tmux poller operations */
export const spawnCtx = new SpawnContext();

export interface TmuxPollerEvents {
  /** Raw tmux output (with ANSI, tabs expanded) for display */
  onOutput: (raw: string, stripped: string) => void;
  onWidth?: (width: number) => void;
  onError?: (error: Error) => void;
}

export type TmuxCaptureResult =
  | { status: "ok"; output: string }
  | { status: "error"; error: string; exitCode: number | null };

export type TmuxSessionProbeResult =
  | { status: "live" }
  | { status: "missing"; error: string }
  | { status: "unknown"; error: string; exitCode: number | null };

export type TmuxPaneProbeResult =
  | { status: "live" }
  | { status: "dead" }
  | { status: "unknown"; error: string; exitCode: number | null };

// pi-tui v0.56.0's visibleWidth() expands \t to 3 spaces but its slicing
// helpers (sliceWithWidth/sliceByColumn/extractSegments) measure \t as 0
// columns via graphemeWidth (its leadingNonPrintingRegex strips control
// chars). The mismatch causes lines to exceed terminal width and crash the
// TUI when tmux capture-pane output contains literal tabs (e.g. codex agents
// editing .pbxproj). Pre-expand tabs to 3 spaces here so every TmuxPoller
// consumer gets tab-safe output without having to remember to expand at the
// callback site.
export function expandTabs(s: string): string {
  return s.includes("\t") ? s.replace(/\t/g, "   ") : s;
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

  /** True while the interval timer is active (i.e. between start() and stop()). */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Resume polling after a stop(). Starts the interval timer and, if a session
   * is already set, fires an immediate poll so the pane isn't stale for up to
   * 1s after becoming visible again. No-op if already running.
   */
  resume(): void {
    if (this.running) return;
    this.start();
    if (this.tmuxSession) {
      this.poll();
    }
  }

  private async poll(): Promise<void> {
    // Snapshot the session before async work to detect agent switches
    const targetSession = this.tmuxSession;
    if (!targetSession) return;

    try {
      // -J joins tmux's soft-wrapped continuation lines back into one logical
      // line (it preserves program-emitted \n, only rejoining lines tmux itself
      // wrapped). We reflow ourselves in the display path (wordWrapLines) so the
      // whole scrollback renders at ONE width — capture-pane -p alone returns
      // older lines hard-wrapped at the width the session had when they scrolled
      // in, which mixes wrap widths within a single buffer after resizeTmuxWindow.
      const proc = spawnCtx.runner(
        ["tmux", "capture-pane", "-t", tmuxSessionTarget(targetSession), "-p", "-J", `-S`, `-${this.lines}`, "-E", "-"],
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

      const expanded = expandTabs(raw);
      const stripped = stripAnsi(expanded);
      this.events.onOutput(expanded, stripped);
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
      ["tmux", "display-message", "-t", tmuxSessionTarget(tmuxSession), "-p", "#{window_width}"],
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
      ["tmux", "resize-window", "-t", tmuxSessionTarget(tmuxSession), "-x", String(width)],
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
      ["tmux", "resize-window", "-A", "-t", tmuxSessionTarget(tmuxSession)],
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
      ["tmux", "kill-session", "-t", tmuxSessionTarget(sessionName)],
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
      ["tmux", "list-clients", "-t", tmuxSessionTarget(tmuxSession), "-F", "#{client_name}"],
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
  const result = await captureTmuxOutputResult(tmuxSession, lines);
  return result.status === "ok" ? result.output : null;
}

/**
 * Capture tmux output without collapsing every failure into "session missing".
 *
 * A failed capture is an unavailable observation, not proof that the session
 * disappeared. Lifecycle callers use this result to avoid reaping a live
 * agent after a transient spawn/tmux error; the legacy nullable wrapper above
 * remains for display-only callers.
 */
export async function captureTmuxOutputResult(
  tmuxSession: string,
  lines = 5000
): Promise<TmuxCaptureResult> {
  try {
    // -J joins tmux's soft-wrapped continuation lines back into single logical
    // lines (program-emitted \n are preserved). State detection consumes these
    // UNWRAPPED logical lines so a marker never straddles a physical wrap
    // boundary and the last-N-line windows measure real content, not the pane's
    // former wrap width. See parse-state.ts windows (RECENT/STANDARD/BROAD).
    const proc = spawnCtx.runner(
      ["tmux", "capture-pane", "-t", tmuxSessionTarget(tmuxSession), "-p", "-J", `-S`, `-${lines}`, "-E", "-"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [raw, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      return {
        status: "error",
        error: stderr.trim() || `tmux capture-pane exited ${exitCode}`,
        exitCode,
      };
    }
    return { status: "ok", output: stripAnsi(raw) };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      exitCode: null,
    };
  }
}

/**
 * Probe one exact tmux session and distinguish confirmed absence from an
 * unavailable observation. Only `missing` is safe evidence for lifecycle
 * teardown; permission errors and unexpected tmux failures are `unknown`.
 */
export async function probeTmuxSession(tmuxSession: string): Promise<TmuxSessionProbeResult> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "has-session", "-t", tmuxSessionTarget(tmuxSession)],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0) return { status: "live" };

    const detail = stderr.trim() || `tmux has-session exited ${exitCode}`;
    // Only a response from a reachable tmux server that names the exact
    // missing session is affirmative absence. Socket/server visibility
    // failures remain unknown: a sandbox may simply be unable to see the
    // authoritative server.
    if (/^can't find session:/i.test(detail)) {
      return { status: "missing", error: detail };
    }
    return { status: "unknown", error: detail, exitCode };
  } catch (error) {
    return {
      status: "unknown",
      error: error instanceof Error ? error.message : String(error),
      exitCode: null,
    };
  }
}

/**
 * Ask tmux for authoritative pane-dead metadata. Pane contents are not safe
 * lifecycle evidence because an agent can quote tmux's "Pane is dead" banner
 * while inspecting source or tests.
 */
export async function probeTmuxPane(tmuxSession: string): Promise<TmuxPaneProbeResult> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "list-panes", "-t", tmuxSessionTarget(tmuxSession), "-F", "#{pane_dead}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return {
        status: "unknown",
        error: stderr.trim() || `tmux list-panes exited ${exitCode}`,
        exitCode,
      };
    }

    const states = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (states.length === 0 || states.some((state) => state !== "0" && state !== "1")) {
      return {
        status: "unknown",
        error: `unexpected tmux pane_dead output: ${stdout.trim() || "<empty>"}`,
        exitCode,
      };
    }
    return states.every((state) => state === "1") ? { status: "dead" } : { status: "live" };
  } catch (error) {
    return {
      status: "unknown",
      error: error instanceof Error ? error.message : String(error),
      exitCode: null,
    };
  }
}

/**
 * Send the Escape key to a tmux session. Used to interrupt a stuck/long-running
 * agent without closing it.
 */
export async function sendTmuxEscape(tmuxSession: string): Promise<boolean> {
  try {
    const proc = spawnCtx.runner(
      ["tmux", "send-keys", "-t", tmuxSessionTarget(tmuxSession), "Escape"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Polls tmux capture-pane for the selected agent (~1s interval).
 * Separate concern from watcher.ts: this handles live output capture
 * for display, while watcher handles structural agent changes.
 */

import { stripAnsi } from "./parse-state";
import type { SpawnFn } from "./types";

/** Pluggable spawn runner — defaults to Bun.spawn, overridable for tests */
let spawnRunner: SpawnFn = Bun.spawn as SpawnFn;

/** Override the spawn runner (for testing) */
export function setSpawnRunner(runner: SpawnFn): void {
  spawnRunner = runner;
}

/** Reset to the default Bun.spawn runner */
export function resetSpawnRunner(): void {
  spawnRunner = Bun.spawn as SpawnFn;
}

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

  constructor(events: TmuxPollerEvents, lines = 500) {
    this.events = events;
    this.lines = lines;
  }

  /** Set the agent to poll. Pass null to pause polling. */
  setAgent(tmuxSession: string | null): void {
    this.tmuxSession = tmuxSession;
    // Immediately poll on agent change
    if (tmuxSession && this.running) {
      this.poll();
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
      const proc = spawnRunner(
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

      // Also query tmux window width
      if (this.events.onWidth) {
        getTmuxWindowWidth(targetSession).then((w) => {
          if (w !== null && this.tmuxSession === targetSession) {
            this.events.onWidth!(w);
          }
        }).catch(() => {
          // Silently ignore — width query is best-effort
        });
      }
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
    const proc = spawnRunner(
      ["tmux", "display-message", "-t", tmuxSession, "-p", "#{window_width}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const width = parseInt(raw.trim(), 10);
    return isNaN(width) ? null : width;
  } catch {
    return null;
  }
}

/** Resize a tmux window to a given width */
export async function resizeTmuxWindow(tmuxSession: string, width: number): Promise<boolean> {
  try {
    const proc = spawnRunner(
      ["tmux", "resize-window", "-t", tmuxSession, "-x", String(width)],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
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
    const proc = spawnRunner(
      ["tmux", "resize-window", "-A", "-t", tmuxSession],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * List all tmux session names. Returns empty array if tmux is not running.
 */
export async function listTmuxSessions(): Promise<string[]> {
  try {
    const proc = spawnRunner(
      ["tmux", "list-sessions", "-F", "#{session_name}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];
    return raw.trim().split("\n").filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Kill a tmux session by name.
 */
export async function killTmuxSession(sessionName: string): Promise<boolean> {
  try {
    const proc = spawnRunner(
      ["tmux", "kill-session", "-t", sessionName],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux session has any attached clients (e.g. opened in Ghostty/Terminal.app).
 * Returns true if at least one client is attached.
 */
export async function hasAttachedClient(tmuxSession: string): Promise<boolean> {
  try {
    const proc = spawnRunner(
      ["tmux", "list-clients", "-t", tmuxSession, "-F", "#{client_name}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    return raw.trim().split("\n").some((s) => s.length > 0);
  } catch {
    return false;
  }
}

/**
 * Capture tmux output for a single agent (one-shot).
 * Used by watcher to detect agent state.
 */
export async function captureTmuxOutput(tmuxSession: string, lines = 500): Promise<string | null> {
  try {
    const proc = spawnRunner(
      ["tmux", "capture-pane", "-t", tmuxSession, "-p", `-S`, `-${lines}`, "-E", "-"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return null; // session doesn't exist
    return stripAnsi(raw);
  } catch {
    return null;
  }
}

/**
 * Polls tmux capture-pane for the selected agent (~1s interval).
 * Separate concern from watcher.ts: this handles live output capture
 * for display, while watcher handles structural agent changes.
 */

import { stripAnsi } from "./parse-state";

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
      const proc = Bun.spawn(
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
    const proc = Bun.spawn(
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
    const proc = Bun.spawn(
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
 * Capture tmux output for a single agent (one-shot).
 * Used by watcher to detect agent state.
 */
export async function captureTmuxOutput(tmuxSession: string, lines = 500): Promise<string | null> {
  try {
    const proc = Bun.spawn(
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

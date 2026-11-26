/**
 * The scheduler (SPEC §21.2): inside `ib watch`, fires the due runs of the
 * scheduled tasks in this machine's store (src/scheduled-tasks.ts) and starts
 * their agents, here or on a paired peer.
 *
 * Every {@link SCHEDULER_TICK_MS} a tick looks, for each task, for the latest
 * fire time after the previous tick and at or before now. It fires that run
 * when it is at most {@link SCHEDULER_GRACE_MS} old; an older one was missed
 * (the dashboard was closed, the machine slept, the event loop stalled) and is
 * skipped. The first tick looks back from the scheduler's start by the grace,
 * so a run that fell due while `ib watch` restarted still fires, and nothing
 * older does. A run is claimed in the
 * store before it starts, so of several open dashboards only one starts it,
 * and its result (the agent id or the error) is recorded. A run that fails is
 * not retried.
 */

import { REPO_COORDINATOR_TYPE, SYSTEM_COORDINATOR_TYPE } from "./coordinator-type-names";
import type { newAgent } from "./ib-commands";
import type { RepoEntry } from "./registry";
import { nextFireTime, type ScheduledTask } from "./scheduled-tasks";

/** How often the scheduler ticks. */
export const SCHEDULER_TICK_MS = 30_000;

/** How late a run may still fire. An older fire time is a missed run and is skipped. */
export const SCHEDULER_GRACE_MS = 2 * 60_000;

type RunOutcome = { agentId: string } | { error: string };

export interface SchedulerDeps {
  /** The clock (epoch ms). */
  now(): number;
  readTasks(): Promise<ScheduledTask[]>;
  claimRun(id: string, slot: number): Promise<ScheduledTask | null>;
  recordResult(id: string, slot: number, outcome: RunOutcome): Promise<void>;
  /** Start `task`'s agent on this machine. Resolves to the new agent's id; throws when it cannot start. */
  startLocal(task: ScheduledTask, prompt: string): Promise<string>;
  /** Start `task`'s agent on the paired machine `task.machine`. `signal` aborts it when the scheduler stops. */
  startRemote(task: ScheduledTask, prompt: string, signal: AbortSignal): Promise<string>;
  /**
   * False while another `ib watch` on this machine owns the peer endpoint:
   * that dashboard has the peer links, so it fires the remote tasks and this
   * one leaves them unclaimed.
   */
  remoteRunsHere(): boolean;
  /** This machine's name (src/machine-name.ts), for the prompt header. */
  machineName: string;
  /** The name to show for a task's target machine: this machine's for null, else the peer's. */
  targetName(machine: string | null): string;
  /** watch.log. */
  log(line: string): void;
  /** A dashboard notice. */
  notice(text: string, kind: "info" | "error"): void;
  /** After a local start, so the new agent's row appears. */
  refresh(): void;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `Wed 2026-11-25 09:30`, in this machine's local time. */
export function formatSlot(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The prompt a scheduled run starts its agent with: a context header, a blank
 * line, then the user's prompt. The completion sentinel is quoted, as in the
 * stop-hook nudge: the pane-based state parsers ignore a quoted one, so the
 * prompt on screen never reads as the agent having completed.
 */
export function scheduledPrompt(task: Pick<ScheduledTask, "id" | "cron" | "autoRetire" | "prompt">, slot: number, machineName: string): string {
  const header = [
    `[Scheduled task ${task.id}: itsybitsy started this agent automatically at ${formatSlot(slot)} (local time on ${machineName}), ` +
      `on the cron schedule "${task.cron}". This is a scheduled run, not a live request from the user.]`,
  ];
  if (task.autoRetire) {
    header.push("When you end with 'I HAVE COMPLETED THE GOAL', this agent is retired automatically: its work is archived, not merged.");
  }
  return `${header.join("\n")}\n\n${task.prompt}`;
}

/**
 * The run of `cron` a tick that covers (`after`, `now`] should look at: the
 * latest fire time in that window, and whether it is still within the grace.
 * Null when the window has no fire time.
 */
export function dueRun(cron: string, after: number, now: number): { slot: number; missed: boolean } | null {
  // Only a fire time at or after now - grace can fire, so the search for the
  // latest starts there: a long sleep costs a few lookups, not one per run missed.
  let latest: number | null = null;
  for (let slot = nextFireTime(cron, Math.max(after, now - SCHEDULER_GRACE_MS - 1)); slot !== null && slot <= now; slot = nextFireTime(cron, slot)) {
    latest = slot;
  }
  if (latest !== null) return { slot: latest, missed: false };
  const first = nextFireTime(cron, after);
  return first !== null && first <= now ? { slot: first, missed: true } : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Scheduler {
  private lastTick: number;
  private current: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  private lastReadError: string | null = null;

  /**
   * The first tick's window starts the grace before now, so a run due while
   * `ib watch` restarted (an `ib bounce`) still fires; the store's claim keeps
   * a run the previous instance claimed from firing twice.
   */
  constructor(private readonly deps: SchedulerDeps) {
    this.lastTick = deps.now() - SCHEDULER_GRACE_MS;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), SCHEDULER_TICK_MS);
  }

  /** Stop ticking and abort a remote start in flight; resolves once the current tick ends. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort(new Error("Dashboard shutting down"));
    return this.current ?? Promise.resolve();
  }

  /** One tick. A tick called while another runs does nothing: the next one covers its window. */
  tick(): Promise<void> {
    if (this.current || this.stopped) return this.current ?? Promise.resolve();
    this.current = this.runTick().finally(() => { this.current = null; });
    return this.current;
  }

  private async runTick(): Promise<void> {
    const after = this.lastTick;
    const now = this.deps.now();
    this.lastTick = now;
    let tasks: ScheduledTask[];
    try {
      tasks = await this.deps.readTasks();
      this.lastReadError = null;
    } catch (err) {
      // Logged once until it changes: a malformed file would otherwise log every tick.
      const message = errorMessage(err);
      if (message !== this.lastReadError) this.deps.log(`scheduler: cannot read the scheduled tasks: ${message}`);
      this.lastReadError = message;
      return;
    }
    for (const task of tasks) {
      if (this.stopped) return;
      try {
        await this.runTask(task, after, now);
      } catch (err) {
        this.deps.log(`scheduler: ${task.id}: ${errorMessage(err)}`);
      }
    }
  }

  private async runTask(task: ScheduledTask, after: number, now: number): Promise<void> {
    const due = dueRun(task.cron, after, now);
    if (!due) return;
    if (due.missed) {
      this.deps.log(`scheduler: ${task.id} skipped its run due ${formatSlot(due.slot)}: more than ${SCHEDULER_GRACE_MS / 60_000} min late`);
      return;
    }
    if (task.machine !== null && !this.deps.remoteRunsHere()) return;
    const claimed = await this.deps.claimRun(task.id, due.slot);
    if (!claimed) return;
    const machine = this.deps.targetName(claimed.machine);
    this.deps.log(`scheduler: ${claimed.id} fired its run due ${formatSlot(due.slot)}: starting ${claimed.agentType} in ${claimed.repo} on ${machine}`);
    let outcome: RunOutcome;
    try {
      const prompt = scheduledPrompt(claimed, due.slot, this.deps.machineName);
      const agentId = claimed.machine === null
        ? await this.deps.startLocal(claimed, prompt)
        : await this.deps.startRemote(claimed, prompt, this.abort.signal);
      outcome = { agentId };
      this.deps.log(`scheduler: ${claimed.id} started agent ${agentId} on ${machine}`);
      this.deps.notice(`Scheduled task started ${agentId} on ${machine}`, "info");
      if (claimed.machine === null) this.deps.refresh();
    } catch (err) {
      const error = errorMessage(err);
      outcome = { error };
      this.deps.log(`scheduler: ${claimed.id} failed to start on ${machine}: ${error}`);
      this.deps.notice(`Scheduled task ${claimed.id} failed on ${machine}: ${error}`, "error");
    }
    await this.deps.recordResult(claimed.id, due.slot, outcome);
  }
}

/** What {@link startLocalScheduledAgent} needs; `ib watch` passes the registry and `newAgent`. */
export interface LocalStartDeps {
  listRepos(): Promise<RepoEntry[]>;
  newAgent: typeof newAgent;
}

/**
 * A local start: the repo is matched by registry name, ignoring case, as a
 * remote start matches it (src/peers/new-agent.ts), and `newAgent` runs as
 * the dashboard's New Agent form calls it.
 */
export async function startLocalScheduledAgent(task: ScheduledTask, prompt: string, deps: LocalStartDeps): Promise<string> {
  const repo = (await deps.listRepos()).find(r => r.name.toLowerCase() === task.repo.toLowerCase());
  if (!repo) throw new Error(`Repo ${task.repo} is not registered on this machine`);
  if (task.agentType === REPO_COORDINATOR_TYPE || task.agentType === SYSTEM_COORDINATOR_TYPE) {
    throw new Error(`Cannot schedule a ${task.agentType}`);
  }
  const result = await deps.newAgent(repo.path, prompt, { type: task.agentType, autoRetire: task.autoRetire });
  if (!result.ok) throw new Error(result.stderr || result.stdout || "Could not start agent");
  return result.stdout.trim();
}

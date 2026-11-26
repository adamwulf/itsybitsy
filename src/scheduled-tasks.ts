/**
 * The scheduled-task store (SPEC §21): `~/.itsybitsy/scheduled-tasks.json`, a
 * JSON array of {@link ScheduledTask}.
 *
 * A task belongs to the machine whose file holds it: that machine's `ib watch`
 * fires it, starting an agent on itself or, through the peer link, on the
 * paired machine the task names. Schedules are 5-field cron expressions (or
 * Bun's nicknames such as `@daily`), read in this machine's local time zone by
 * `Bun.cron.parse`.
 *
 * Every read-modify-write runs under an exclusive flock on
 * `scheduled-tasks.lock`, and every write replaces the whole file atomically
 * (temp file + rename), so readers never see a torn file. The lock is what
 * lets {@link claimScheduledRun} keep two open dashboards from both firing the
 * same run.
 */

import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { flock, LOCK_EX, LOCK_NB } from "./file-lock";
import { normalizePeerId } from "./peers/store";
import { scheduledTasksFile, scheduledTasksLockFile } from "./runtime-names";

export interface ScheduledTask {
  /** `task-<8 hex>`, unique in this file. */
  id: string;
  /** Where the agent starts: null for this machine, else a paired peer's id (64 lowercase hex). */
  machine: string | null;
  /** The repo's registry name on the target machine. */
  repo: string;
  /** The agent type to spawn (a spawnable, non-coordinator type). */
  agentType: string;
  /** The user's prompt. The scheduler adds a context header before it (scheduledPrompt). */
  prompt: string;
  /** A cron expression, evaluated in this machine's local time zone. */
  cron: string;
  /** Retire the spawned agent once it signals `I HAVE COMPLETED THE GOAL`. */
  autoRetire: boolean;
  /** The fire time (epoch ms) of the last run claimed: the cron slot, not when it was claimed. */
  lastRunAt?: number;
  /** The id of the agent the last run started, once it started. */
  lastAgentId?: string;
  /** Why the last run failed to start, if it did. */
  lastError?: string;
}

/** The fields a user creates or edits; the rest belong to the store and scheduler. */
export type ScheduledTaskInput = Pick<ScheduledTask, "machine" | "repo" | "agentType" | "prompt" | "cron" | "autoRetire">;

/** scheduled-tasks.json exists but is not a valid task list. */
export class ScheduledTaskStoreError extends Error {
  constructor(message: string) {
    super(`${scheduledTasksFile()}: ${message}`);
    this.name = "ScheduledTaskStoreError";
  }
}

/**
 * `Bun.cron.parse` (Bun 1.4): the first fire strictly after `from`, in local
 * time, or null when there is none; throws on an invalid expression. The
 * bun-types this project builds against predate it, hence the cast.
 */
const parseCron = (expression: string, from: number): Date | null =>
  (Bun as unknown as { cron: { parse(expression: string, from: number): Date | null } }).cron.parse(expression, from);

/** Why `cron` is not a usable schedule, or null when it is. */
export function cronProblem(cron: string): string | null {
  if (!cron.trim()) return "Schedule is empty";
  try {
    return parseCron(cron.trim(), Date.now()) ? null : "Schedule never fires";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The first fire time (epoch ms) strictly after `after`, in local time, or
 * null when `cron` is invalid or never fires again.
 */
export function nextFireTime(cron: string, after: number): number | null {
  try {
    return parseCron(cron.trim(), after)?.getTime() ?? null;
  } catch {
    return null;
  }
}

/** Why `input` cannot be stored, or null when it can. */
export function scheduledTaskProblem(input: ScheduledTaskInput): string | null {
  if (input.machine !== null && normalizePeerId(input.machine) !== input.machine) return "Machine is not a peer id";
  if (!input.repo.trim()) return "Repo is required";
  if (!input.agentType.trim()) return "Agent type is required";
  if (!input.prompt.trim()) return "Prompt is required";
  return cronProblem(input.cron);
}

function parseTasks(text: string): ScheduledTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ScheduledTaskStoreError("not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new ScheduledTaskStoreError("not a JSON array");
  return parsed.map((entry, index) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const str = (key: string) => (typeof e[key] === "string" ? (e[key] as string) : undefined);
    const id = str("id");
    if (!id) throw new ScheduledTaskStoreError(`entry ${index} has no id`);
    const task: ScheduledTask = {
      id,
      machine: typeof e.machine === "string" ? e.machine : null,
      repo: str("repo") ?? "",
      agentType: str("agentType") ?? "",
      prompt: str("prompt") ?? "",
      cron: str("cron") ?? "",
      autoRetire: e.autoRetire === true,
    };
    if (typeof e.lastRunAt === "number") task.lastRunAt = e.lastRunAt;
    if (str("lastAgentId") !== undefined) task.lastAgentId = str("lastAgentId");
    if (str("lastError") !== undefined) task.lastError = str("lastError");
    return task;
  });
}

/**
 * The tasks, in file order. A missing file is an empty list. A file that is
 * not a valid task list throws {@link ScheduledTaskStoreError} rather than
 * reading as empty, so a later write cannot silently drop every task.
 */
export async function readScheduledTasks(): Promise<ScheduledTask[]> {
  let text: string;
  try {
    text = await readFile(scheduledTasksFile(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseTasks(text);
}

async function writeTasks(tasks: ScheduledTask[]): Promise<void> {
  const path = scheduledTasksFile();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await Bun.write(tmp, `${JSON.stringify(tasks, null, 2)}\n`);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Run `work` on the current task list under the store lock; it returns the list to write, or null to write nothing. */
async function mutate<T>(work: (tasks: ScheduledTask[]) => { write: ScheduledTask[] | null; result: T }): Promise<T> {
  const lockPath = scheduledTasksLockFile();
  await mkdir(dirname(lockPath), { recursive: true });
  const fd = openSync(lockPath, "a");
  try {
    const deadline = performance.now() + 10_000;
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      if (performance.now() >= deadline) throw new Error("Timed out waiting for the scheduled-tasks lock");
      await Bun.sleep(10);
    }
    const { write, result } = work(await readScheduledTasks());
    if (write) await writeTasks(write);
    return result;
  } finally {
    closeSync(fd); // closing the descriptor releases the flock
  }
}

function newTaskId(tasks: readonly ScheduledTask[]): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = `task-${Buffer.from(bytes).toString("hex")}`;
    if (!tasks.some(t => t.id === id)) return id;
  }
}

function cleanInput(input: ScheduledTaskInput): ScheduledTaskInput {
  const problem = scheduledTaskProblem(input);
  if (problem) throw new Error(problem);
  return { ...input, repo: input.repo.trim(), agentType: input.agentType.trim(), cron: input.cron.trim() };
}

/** Add a task. Throws when the input is invalid (scheduledTaskProblem). */
export async function createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
  const fields = cleanInput(input);
  return mutate(tasks => {
    const task: ScheduledTask = { id: newTaskId(tasks), ...fields };
    return { write: [...tasks, task], result: task };
  });
}

/**
 * Replace a task's user fields, keeping its id and last-run fields. Throws
 * when the input is invalid or no task has `id`.
 */
export async function updateScheduledTask(id: string, input: ScheduledTaskInput): Promise<ScheduledTask> {
  const fields = cleanInput(input);
  return mutate(tasks => {
    const index = tasks.findIndex(t => t.id === id);
    if (index === -1) throw new Error(`No scheduled task ${id}`);
    const task: ScheduledTask = { ...tasks[index]!, ...fields };
    return { write: tasks.with(index, task), result: task };
  });
}

/** Remove a task. False when no task has `id`. */
export async function deleteScheduledTask(id: string): Promise<boolean> {
  return mutate(tasks => {
    const kept = tasks.filter(t => t.id !== id);
    return kept.length === tasks.length ? { write: null, result: false } : { write: kept, result: true };
  });
}

/**
 * Claim the run of task `id` due at `slot` (a fire time, epoch ms). Succeeds
 * only when the task still exists and no run at or after `slot` was claimed;
 * it then records `lastRunAt = slot`, clears the last run's agent and error,
 * and returns the task as stored. Returns null when the run is not this
 * caller's to start (already claimed, or the task was deleted).
 */
export async function claimScheduledRun(id: string, slot: number): Promise<ScheduledTask | null> {
  return mutate(tasks => {
    const index = tasks.findIndex(t => t.id === id);
    const current = tasks[index];
    if (!current || (current.lastRunAt ?? -Infinity) >= slot) return { write: null, result: null };
    const { lastAgentId: _agent, lastError: _error, ...rest } = current;
    const task: ScheduledTask = { ...rest, lastRunAt: slot };
    return { write: tasks.with(index, task), result: task };
  });
}

/**
 * Record how the run claimed at `slot` ended: the started agent's id, or why
 * it failed to start. Ignored when the task is gone or a later run was claimed.
 */
export async function recordScheduledRunResult(id: string, slot: number, outcome: { agentId: string } | { error: string }): Promise<void> {
  await mutate(tasks => {
    const index = tasks.findIndex(t => t.id === id);
    const current = tasks[index];
    if (!current || current.lastRunAt !== slot) return { write: null, result: undefined };
    const task: ScheduledTask = "agentId" in outcome
      ? { ...current, lastAgentId: outcome.agentId }
      : { ...current, lastError: outcome.error };
    return { write: tasks.with(index, task), result: undefined };
  });
}

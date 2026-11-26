import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resetUserHome, setUserHome } from "./home";
import { scheduledTasksFile } from "./runtime-names";
import {
  claimScheduledRun,
  createScheduledTask,
  cronProblem,
  deleteScheduledTask,
  nextFireTime,
  readScheduledTasks,
  recordScheduledRunResult,
  ScheduledTaskStoreError,
  updateScheduledTask,
  type ScheduledTaskInput,
} from "./scheduled-tasks";

const PEER = "a".repeat(64);
const INPUT: ScheduledTaskInput = {
  machine: null, repo: "itsybitsy", agentType: "worker", prompt: "Check the build", cron: "30 9 * * 1-5", autoRetire: true,
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-scheduled-tasks-"));
  setUserHome(home);
});

afterEach(async () => {
  resetUserHome();
  await rm(home, { recursive: true, force: true });
});

describe("cron helpers", () => {
  test("cronProblem accepts 5-field expressions and nicknames, and names the problem otherwise", () => {
    expect(cronProblem("30 9 * * 1-5")).toBeNull();
    expect(cronProblem("@daily")).toBeNull();
    expect(cronProblem("")).toBe("Schedule is empty");
    expect(cronProblem("30 9 * *")).toContain("5 space-separated fields");
  });

  test("nextFireTime is the first local fire strictly after the given time", () => {
    const slot = new Date(2026, 10, 25, 9, 30).getTime();
    expect(nextFireTime("30 9 * * *", slot - 1)).toBe(slot);
    expect(nextFireTime("30 9 * * *", slot)).toBe(new Date(2026, 10, 26, 9, 30).getTime());
    expect(nextFireTime("not cron", slot)).toBeNull();
  });
});

describe("store", () => {
  test("a missing file is an empty list", async () => {
    expect(await readScheduledTasks()).toEqual([]);
  });

  test("a malformed file throws instead of reading as empty", async () => {
    await mkdir(dirname(scheduledTasksFile()), { recursive: true });
    await writeFile(scheduledTasksFile(), "{}");
    await expect(readScheduledTasks()).rejects.toBeInstanceOf(ScheduledTaskStoreError);
  });

  test("create, update and delete round-trip through the file", async () => {
    const created = await createScheduledTask({ ...INPUT, cron: "  0 * * * *  " });
    expect(created.id).toMatch(/^task-[0-9a-f]{8}$/);
    expect(created.cron).toBe("0 * * * *");
    expect(await readScheduledTasks()).toEqual([created]);

    const updated = await updateScheduledTask(created.id, { ...INPUT, machine: PEER, prompt: "New prompt" });
    expect(updated).toEqual({ ...INPUT, id: created.id, machine: PEER, prompt: "New prompt" });
    expect(await readScheduledTasks()).toEqual([updated]);

    expect(await deleteScheduledTask(created.id)).toBe(true);
    expect(await deleteScheduledTask(created.id)).toBe(false);
    expect(await readScheduledTasks()).toEqual([]);
  });

  test("invalid input is refused", async () => {
    await expect(createScheduledTask({ ...INPUT, cron: "nope" })).rejects.toThrow();
    await expect(createScheduledTask({ ...INPUT, prompt: "  " })).rejects.toThrow("Prompt is required");
    await expect(createScheduledTask({ ...INPUT, machine: "not-a-peer" })).rejects.toThrow("Machine is not a peer id");
    await expect(updateScheduledTask("task-missing", INPUT)).rejects.toThrow("No scheduled task task-missing");
  });

  test("a run is claimed once per slot, and its result is recorded only for that slot", async () => {
    const { id } = await createScheduledTask(INPUT);
    const [first, second] = await Promise.all([claimScheduledRun(id, 1000), claimScheduledRun(id, 1000)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await claimScheduledRun(id, 999)).toBeNull();

    await recordScheduledRunResult(id, 1000, { agentId: "agent-12345678" });
    expect((await readScheduledTasks())[0]).toMatchObject({ lastRunAt: 1000, lastAgentId: "agent-12345678" });

    expect(await claimScheduledRun(id, 2000)).toMatchObject({ lastRunAt: 2000 });
    await recordScheduledRunResult(id, 1000, { error: "stale" });
    await recordScheduledRunResult(id, 2000, { error: "peer offline" });
    const [task] = await readScheduledTasks();
    expect(task).toMatchObject({ lastRunAt: 2000, lastError: "peer offline" });
    expect(task!.lastAgentId).toBeUndefined();

    const edited = await updateScheduledTask(id, { ...INPUT, prompt: "Edited" });
    expect(edited).toMatchObject({ lastRunAt: 2000, lastError: "peer offline" });
    expect(await claimScheduledRun("task-missing", 3000)).toBeNull();
  });
});

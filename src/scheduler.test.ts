import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUserHome, setUserHome } from "./home";
import type { IbCommandResult } from "./ib-commands";
import {
  claimScheduledRun,
  createScheduledTask,
  readScheduledTasks,
  recordScheduledRunResult,
  type ScheduledTask,
} from "./scheduled-tasks";
import {
  dueRun,
  formatSlot,
  SCHEDULER_GRACE_MS,
  scheduledPrompt,
  Scheduler,
  startLocalScheduledAgent,
  type SchedulerDeps,
} from "./scheduler";

const PEER = "b".repeat(64);
/** Local time, as cron reads it. Wed 2026-11-25. */
const at = (h: number, m: number, s = 0) => new Date(2026, 10, 25, h, m, s).getTime();

const TASK: ScheduledTask = {
  id: "task-0000abcd", machine: null, repo: "app", agentType: "worker", prompt: "Check the build", cron: "30 9 * * *", autoRetire: false,
};

/** A scheduler over an in-memory task list whose claim behaves like the store's. */
function harness(tasks: ScheduledTask[], start: number) {
  let clock = start;
  const claimed = new Map<string, number>();
  const logs: string[] = [];
  const notices: [string, string][] = [];
  const deps = {
    now: () => clock,
    readTasks: mock(async () => tasks),
    claimRun: mock(async (id: string, slot: number) => {
      const task = tasks.find(t => t.id === id);
      if (!task || (claimed.get(id) ?? -Infinity) >= slot) return null;
      claimed.set(id, slot);
      return { ...task, lastRunAt: slot };
    }),
    recordResult: mock(async (_id: string, _slot: number, _outcome: { agentId: string } | { error: string }) => {}),
    startLocal: mock(async (_task: ScheduledTask, _prompt: string) => "agent-new"),
    startRemote: mock(async (_task: ScheduledTask, _prompt: string, _signal: AbortSignal) => "agent-remote"),
    remoteRunsHere: () => true,
    machineName: "Studio",
    targetName: (machine: string | null) => machine === null ? "Studio" : "Laptop",
    log: (line: string) => logs.push(line),
    notice: (text: string, kind: "info" | "error") => notices.push([text, kind]),
    refresh: mock(() => {}),
  } satisfies SchedulerDeps;
  const scheduler = new Scheduler(deps);
  return { scheduler, deps, logs, notices, setNow: (ms: number) => { clock = ms; } };
}

describe("scheduledPrompt", () => {
  test("formats the fire slot in local time", () => {
    expect(formatSlot(at(9, 30))).toBe("Wed 2026-11-25 09:30");
    expect(formatSlot(new Date(2026, 0, 4, 17, 5).getTime())).toBe("Sun 2026-01-04 17:05");
  });

  test("puts the context header, a blank line, then the user's prompt", () => {
    expect(scheduledPrompt(TASK, at(9, 30), "Studio")).toBe(
      `[Scheduled task task-0000abcd: itsybitsy started this agent automatically at Wed 2026-11-25 09:30 (local time on Studio), ` +
      `on the cron schedule "30 9 * * *". This is a scheduled run, not a live request from the user.]\n\nCheck the build`,
    );
  });

  test("with auto-retire, adds a second header line with the sentinel quoted", () => {
    expect(scheduledPrompt({ ...TASK, autoRetire: true }, at(9, 30), "Studio")).toBe(
      `[Scheduled task task-0000abcd: itsybitsy started this agent automatically at Wed 2026-11-25 09:30 (local time on Studio), ` +
      `on the cron schedule "30 9 * * *". This is a scheduled run, not a live request from the user.]\n` +
      `When you end with 'I HAVE COMPLETED THE GOAL', this agent is retired automatically: its work is archived, not merged.\n\nCheck the build`,
    );
  });
});

describe("dueRun", () => {
  test("is the latest fire time in the window, missed when older than the grace", () => {
    expect(dueRun("* * * * *", at(9, 0), at(9, 2, 30))).toEqual({ slot: at(9, 2), missed: false });
    expect(dueRun("30 9 * * *", at(9, 0), at(9, 30) + SCHEDULER_GRACE_MS)).toEqual({ slot: at(9, 30), missed: false });
    expect(dueRun("30 9 * * *", at(9, 0), at(9, 30) + SCHEDULER_GRACE_MS + 1)).toEqual({ slot: at(9, 30), missed: true });
    expect(dueRun("30 9 * * *", at(9, 30), at(9, 31))).toBeNull();
    expect(dueRun("not cron", at(9, 0), at(10, 0))).toBeNull();
  });
});

describe("Scheduler tick", () => {
  test("fires a due run: claims the slot, starts the agent with the header, records the id and refreshes", async () => {
    const h = harness([TASK], at(9, 29, 40));
    h.setNow(at(9, 30, 10));
    await h.scheduler.tick();
    expect(h.deps.claimRun.mock.calls).toEqual([[TASK.id, at(9, 30)]]);
    expect(h.deps.startLocal.mock.calls).toEqual([[{ ...TASK, lastRunAt: at(9, 30) }, scheduledPrompt(TASK, at(9, 30), "Studio")]]);
    expect(h.deps.recordResult.mock.calls).toEqual([[TASK.id, at(9, 30), { agentId: "agent-new" }]]);
    expect(h.deps.refresh).toHaveBeenCalledTimes(1);
    expect(h.notices).toEqual([["Scheduled task started agent-new on Studio", "info"]]);
    expect(h.logs).toEqual([
      "scheduler: task-0000abcd fired its run due Wed 2026-11-25 09:30: starting worker in app on Studio",
      "scheduler: task-0000abcd started agent agent-new on Studio",
    ]);
  });

  test("fires nothing due before it started", async () => {
    const h = harness([TASK], at(9, 30, 10));
    h.setNow(at(9, 30, 40));
    await h.scheduler.tick();
    expect(h.deps.claimRun).not.toHaveBeenCalled();
    expect(h.deps.startLocal).not.toHaveBeenCalled();
  });

  test("fires a run up to the grace late, after a stalled tick", async () => {
    const h = harness([TASK], at(9, 29));
    h.setNow(at(9, 31, 30));
    await h.scheduler.tick();
    expect(h.deps.startLocal).toHaveBeenCalledTimes(1);
  });

  test("skips a run missed by more than the grace, and logs it", async () => {
    const h = harness([TASK], at(9, 0));
    h.setNow(at(9, 33)); // woke from sleep three minutes after the run
    await h.scheduler.tick();
    expect(h.deps.claimRun).not.toHaveBeenCalled();
    expect(h.deps.startLocal).not.toHaveBeenCalled();
    expect(h.logs).toEqual(["scheduler: task-0000abcd skipped its run due Wed 2026-11-25 09:30: more than 2 min late"]);
    // The missed run stays skipped.
    h.setNow(at(9, 33, 30));
    await h.scheduler.tick();
    expect(h.deps.claimRun).not.toHaveBeenCalled();
  });

  test("fires at most one run per task per tick, the latest, and never the same one twice", async () => {
    const h = harness([{ ...TASK, cron: "* * * * *" }], at(9, 0));
    h.setNow(at(9, 2, 30));
    await h.scheduler.tick();
    expect(h.deps.claimRun.mock.calls).toEqual([[TASK.id, at(9, 2)]]);
    h.setNow(at(9, 2, 50));
    await h.scheduler.tick();
    expect(h.deps.claimRun).toHaveBeenCalledTimes(1);
    h.setNow(at(9, 3, 20));
    await h.scheduler.tick();
    expect(h.deps.claimRun.mock.calls.at(-1)).toEqual([TASK.id, at(9, 3)]);
    expect(h.deps.startLocal).toHaveBeenCalledTimes(2);
  });

  test("starts nothing when the claim returns null", async () => {
    const h = harness([TASK], at(9, 29, 40));
    h.deps.claimRun.mockResolvedValue(null);
    h.setNow(at(9, 30, 10));
    await h.scheduler.tick();
    expect(h.deps.claimRun).toHaveBeenCalledTimes(1);
    expect(h.deps.startLocal).not.toHaveBeenCalled();
    expect(h.deps.recordResult).not.toHaveBeenCalled();
    expect(h.notices).toEqual([]);
  });

  test("a task's failure is recorded and does not stop the other tasks", async () => {
    const other = { ...TASK, id: "task-0000beef", repo: "web" };
    const h = harness([TASK, other], at(9, 29, 40));
    h.deps.startLocal.mockImplementation(async task => {
      if (task.id === TASK.id) throw new Error("Repo app is not registered on this machine");
      return "agent-web";
    });
    h.setNow(at(9, 30, 10));
    await h.scheduler.tick();
    expect(h.deps.recordResult.mock.calls).toEqual([
      [TASK.id, at(9, 30), { error: "Repo app is not registered on this machine" }],
      [other.id, at(9, 30), { agentId: "agent-web" }],
    ]);
    expect(h.notices).toEqual([
      ["Scheduled task task-0000abcd failed on Studio: Repo app is not registered on this machine", "error"],
      ["Scheduled task started agent-web on Studio", "info"],
    ]);
    expect(h.logs).toContain("scheduler: task-0000abcd failed to start on Studio: Repo app is not registered on this machine");
    expect(h.deps.refresh).toHaveBeenCalledTimes(1);
  });

  test("a task whose claim throws is logged and the tick goes on", async () => {
    const other = { ...TASK, id: "task-0000beef" };
    const h = harness([TASK, other], at(9, 29, 40));
    const claim = h.deps.claimRun.getMockImplementation()!;
    h.deps.claimRun.mockImplementation(async (id, slot) => {
      if (id === TASK.id) throw new Error("Timed out waiting for the scheduled-tasks lock");
      return claim(id, slot);
    });
    h.setNow(at(9, 30, 10));
    await h.scheduler.tick();
    expect(h.logs).toContain("scheduler: task-0000abcd: Timed out waiting for the scheduled-tasks lock");
    expect(h.deps.startLocal.mock.calls.map(([task]) => task.id)).toEqual([other.id]);
  });

  test("an unreadable task file is logged once until it changes", async () => {
    const h = harness([TASK], at(9, 0));
    h.deps.readTasks.mockRejectedValue(new Error("scheduled-tasks.json: not valid JSON"));
    for (const minute of [1, 2, 3]) {
      h.setNow(at(9, minute));
      await h.scheduler.tick();
    }
    expect(h.logs).toEqual(["scheduler: cannot read the scheduled tasks: scheduled-tasks.json: not valid JSON"]);
  });

  test("never runs two ticks at once", async () => {
    const h = harness([TASK], at(9, 29, 40));
    const spawn = Promise.withResolvers<string>();
    h.deps.startLocal.mockReturnValue(spawn.promise);
    h.setNow(at(9, 30, 10));
    const first = h.scheduler.tick();
    await Bun.sleep(0);
    expect(h.deps.startLocal).toHaveBeenCalledTimes(1);
    h.setNow(at(9, 30, 40));
    const second = h.scheduler.tick();
    expect(h.deps.readTasks).toHaveBeenCalledTimes(1);
    spawn.resolve("agent-new");
    await Promise.all([first, second]);
    expect(h.deps.claimRun).toHaveBeenCalledTimes(1);
  });

  test("a remote task starts through startRemote with the stop signal, and is left alone where another dashboard owns the peers", async () => {
    const remote = { ...TASK, machine: PEER, autoRetire: true };
    const h = harness([remote], at(9, 29, 40));
    let here = false;
    const deps = { ...h.deps, remoteRunsHere: () => here };
    const scheduler = new Scheduler(deps);
    const other = new Scheduler(deps);
    h.setNow(at(9, 30, 10));
    await scheduler.tick();
    expect(h.deps.claimRun).not.toHaveBeenCalled();

    here = true;
    const started = Promise.withResolvers<void>();
    h.deps.startRemote.mockImplementation((_task, _prompt, signal) => {
      started.resolve();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    const tick = other.tick();
    await started.promise;
    expect(h.deps.startRemote.mock.calls[0]!.slice(0, 2)).toEqual([{ ...remote, lastRunAt: at(9, 30) }, scheduledPrompt(remote, at(9, 30), "Studio")]);
    await other.stop();
    await tick;
    expect(h.deps.recordResult.mock.calls).toEqual([[remote.id, at(9, 30), { error: "Dashboard shutting down" }]]);
    expect(h.notices).toEqual([["Scheduled task task-0000abcd failed on Laptop: Dashboard shutting down", "error"]]);
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });
});

describe("Scheduler with the store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ib-scheduler-"));
    setUserHome(home);
  });
  afterEach(async () => {
    resetUserHome();
    await rm(home, { recursive: true, force: true });
  });

  function storeScheduler(start: number, startLocal: SchedulerDeps["startLocal"]) {
    let clock = start;
    const scheduler = new Scheduler({
      now: () => clock,
      readTasks: readScheduledTasks, claimRun: claimScheduledRun, recordResult: recordScheduledRunResult,
      startLocal, startRemote: async () => { throw new Error("unused"); }, remoteRunsHere: () => true,
      machineName: "Studio", targetName: () => "Studio", log: () => {}, notice: () => {}, refresh: () => {},
    });
    return { scheduler, setNow: (ms: number) => { clock = ms; } };
  }

  test("a failed start is recorded and not retried, and a second dashboard does not fire the claimed run", async () => {
    const task = await createScheduledTask({ machine: null, repo: "app", agentType: "worker", prompt: "Check", cron: "30 9 * * *", autoRetire: false });
    const startLocal = mock(async () => { throw new Error("Maximum number of agents reached"); });
    const first = storeScheduler(at(9, 29, 40), startLocal);
    const second = storeScheduler(at(9, 29, 40), startLocal);
    first.setNow(at(9, 30, 10));
    await first.scheduler.tick();
    expect(await readScheduledTasks()).toEqual([{ ...task, lastRunAt: at(9, 30), lastError: "Maximum number of agents reached" }]);

    second.setNow(at(9, 30, 20));
    await second.scheduler.tick();
    first.setNow(at(9, 30, 40));
    await first.scheduler.tick();
    expect(startLocal).toHaveBeenCalledTimes(1);
  });

  test("a started run records the agent id", async () => {
    const task = await createScheduledTask({ machine: null, repo: "app", agentType: "worker", prompt: "Check", cron: "30 9 * * *", autoRetire: true });
    const run = storeScheduler(at(9, 29, 40), async () => "agent-1234");
    run.setNow(at(9, 30, 10));
    await run.scheduler.tick();
    expect(await readScheduledTasks()).toEqual([{ ...task, lastRunAt: at(9, 30), lastAgentId: "agent-1234" }]);
  });
});

describe("startLocalScheduledAgent", () => {
  const ok = (stdout: string): IbCommandResult => ({ ok: true, exitCode: 0, stdout, stderr: "" });
  const listRepos = async () => [{ name: "MyApp", path: "/repos/my-app" }];

  test("matches the registry name ignoring case and passes the type and auto-retire switch to newAgent", async () => {
    const newAgent = mock(async () => ok("agent-77\n"));
    expect(await startLocalScheduledAgent({ ...TASK, repo: "myapp", autoRetire: true }, "the prompt", { listRepos, newAgent })).toBe("agent-77");
    expect(newAgent.mock.calls as unknown[]).toEqual([["/repos/my-app", "the prompt", { type: "worker", autoRetire: true }]]);
  });

  test("throws for an unregistered repo, a coordinator type, or a failed spawn", async () => {
    const newAgent = mock(async (): Promise<IbCommandResult> => ({ ok: false, exitCode: 1, stdout: "", stderr: "Error: max agents reached" }));
    await expect(startLocalScheduledAgent(TASK, "p", { listRepos, newAgent })).rejects.toThrow("Repo app is not registered on this machine");
    await expect(startLocalScheduledAgent({ ...TASK, repo: "MyApp", agentType: "repo-coordinator" }, "p", { listRepos, newAgent }))
      .rejects.toThrow("Cannot schedule a repo-coordinator");
    expect(newAgent).not.toHaveBeenCalled();
    await expect(startLocalScheduledAgent({ ...TASK, repo: "MyApp" }, "p", { listRepos, newAgent })).rejects.toThrow("Error: max agents reached");
  });
});

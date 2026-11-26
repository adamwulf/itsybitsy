import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resetUserHome, setUserHome } from "../home";
import { stripAnsi } from "../parse-state";
import type { PeerLinkState } from "../peers/poller";
import { peersFile, scheduledTasksFile } from "../runtime-names";
import { createScheduledTask, nextFireTime, readScheduledTasks, type ScheduledTask, type ScheduledTaskInput } from "../scheduled-tasks";
import { waitFor } from "../test-utils";
import { handleSetup, type ActionCtx } from "./agent-actions";
import { RED } from "./colors";
import { buildSetupContent, handleDialogInput, SCHEDULED_TAB, type DialogCtx, type DialogState } from "./dialog-handler";
import {
  buildScheduledTabContent, buildScheduledTaskFormContent, formatFireTime, scheduledTaskTypes,
  type ScheduledTabState, type ScheduledTaskFormDialog,
} from "./scheduled-dialog";
import { assertDialog } from "./test-helpers";

const PEER_B = "b".repeat(64);
const PEER_C = "c".repeat(64);
const UNPAIRED = "d".repeat(64);
const TASK: ScheduledTaskInput = {
  machine: null, repo: "itsybitsy", agentType: "worker", prompt: "Check the build\nthen report", cron: "30 9 * * 1-5", autoRetire: true,
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-scheduled-tab-"));
  setUserHome(home);
});

afterEach(async () => {
  resetUserHome();
  await rm(home, { recursive: true, force: true });
});

async function writePeers(peers: Array<{ id: string; name: string }>): Promise<void> {
  await mkdir(dirname(peersFile()), { recursive: true });
  await Bun.write(peersFile(), JSON.stringify(peers.map(peer => ({ ...peer, pairedAt: "2026-11-01T00:00:00.000Z" }))));
}

async function writeTasks(tasks: ScheduledTask[]): Promise<void> {
  await mkdir(dirname(scheduledTasksFile()), { recursive: true });
  await Bun.write(scheduledTasksFile(), JSON.stringify(tasks));
}

function link(id: string, name: string, connected: boolean, repos: string[] = []): PeerLinkState {
  return {
    id, name, connected,
    connectedAt: connected ? 1 : null,
    lastOkAt: connected ? 1 : null,
    lastError: connected ? null : "dial failed",
    coordinator: null,
    repos: repos.map(registryName => ({ registryName, displayName: registryName, remoteUrl: null, relPath: null })),
    agents: null,
    questions: null,
  };
}

/** The slice of the dashboard the setup dialog and its Scheduled tab use. */
function makeHost(options: { repos?: string[]; links?: PeerLinkState[] } = {}) {
  let current: DialogState = null;
  const notices: string[] = [];
  const view = { links: options.links ?? [] };
  const host = {
    get dialog() { return current; },
    get _dialog() { return current; },
    repos: (options.repos ?? ["itsybitsy"]).map(name => ({ name, path: `/repos/${name}` })),
    peerService: { view: () => view },
    tui: { requestRender() {} },
    agentTree: { machineName: "studio" },
    showDialog(dialog: NonNullable<DialogState>) { current = dialog; },
    closeDialog() { current = null; },
    setNotice(text: string) { notices.push(text); },
  };
  return { ctx: host as unknown as ActionCtx & DialogCtx, notices, view };
}

function press(ctx: DialogCtx, ...keys: string[]): void {
  for (const key of keys) handleDialogInput(ctx, key);
}

function type(ctx: DialogCtx, text: string): void {
  press(ctx, ...Array.from(text));
}

function isLoaded(dialog: DialogState): boolean {
  return dialog?.type === "setup" && !!dialog.scheduled && (dialog.scheduled.tasks !== null || dialog.scheduled.error !== null);
}

async function loadedTab(ctx: ActionCtx): Promise<ScheduledTabState> {
  await waitFor(() => isLoaded(ctx.dialog), { message: "the Scheduled tab to load" });
  const dialog = assertDialog(ctx.dialog, "setup");
  expect(dialog.tab).toBe(SCHEDULED_TAB);
  return dialog.scheduled!;
}

async function openTab(ctx: ActionCtx): Promise<ScheduledTabState> {
  handleSetup(ctx, SCHEDULED_TAB);
  return loadedTab(ctx);
}

/** Wait for the tab a Save, Cancel or delete reopens. */
async function reopenedTab(ctx: ActionCtx, previous: ScheduledTabState): Promise<ScheduledTabState> {
  await waitFor(() => isLoaded(ctx.dialog) && assertDialog(ctx.dialog, "setup").scheduled !== previous, { message: "the Scheduled tab to reopen" });
  return assertDialog(ctx.dialog, "setup").scheduled!;
}

function tabText(ctx: ActionCtx): string {
  return stripAnsi(buildSetupContent(assertDialog(ctx.dialog, "setup"), 66).contentLines.join("\n"));
}

function formText(form: ScheduledTaskFormDialog): string {
  return stripAnsi(buildScheduledTaskFormContent(form, 66).contentLines.join("\n"));
}

/** Rendered text with its line wrapping undone, for checking wrapped prose. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Move the form's focus with Tab until it is on `field`. */
function focus(ctx: DialogCtx, form: ScheduledTaskFormDialog, field: ScheduledTaskFormDialog["focused"]): void {
  for (let i = 0; i < 10 && form.focused !== field; i++) press(ctx, "\t");
  expect(form.focused).toBe(field);
}

describe("Scheduled tab switching", () => {
  function setupDialog(tab: number, onTabChange: (tab: number) => void): Extract<NonNullable<DialogState>, { type: "setup" }> {
    return { type: "setup", tab, items: [], selectedIndex: 0, onAction: () => {}, onTabChange };
  }

  test("4 selects Scheduled from the other tabs, and 1-3 leave it", () => {
    for (const tab of [0, 1]) {
      const switched: number[] = [];
      const { ctx } = makeHost();
      ctx.showDialog(setupDialog(tab, t => switched.push(t)));
      press(ctx, "4");
      expect(switched).toEqual([SCHEDULED_TAB]);
    }
    const switched: number[] = [];
    const { ctx } = makeHost();
    ctx.showDialog(setupDialog(SCHEDULED_TAB, t => switched.push(t)));
    press(ctx, "4", "5", "1", "3");
    expect(switched).toEqual([0, 2]);
  });

  test("Tab and Shift+Tab cycle through all four tabs", () => {
    const step = (tab: number, key: string) => {
      let to = -1;
      const { ctx } = makeHost();
      ctx.showDialog(setupDialog(tab, t => { to = t; }));
      press(ctx, key);
      return to;
    };
    expect([0, 1, 2, 3].map(tab => step(tab, "\t"))).toEqual([1, 2, 3, 0]);
    expect([0, 1, 2, 3].map(tab => step(tab, "\x1b[Z"))).toEqual([3, 0, 1, 2]);
  });

  test("h then 4 opens the Scheduled tab, which reads the tasks", async () => {
    await createScheduledTask(TASK);
    const { ctx } = makeHost({ repos: [] });
    handleSetup(ctx);
    expect(assertDialog(ctx.dialog, "setup").tab).toBe(0);
    press(ctx, "4");
    const tab = await loadedTab(ctx);
    expect(tab.tasks!.map(t => t.cron)).toEqual([TASK.cron]);
    expect(assertDialog(ctx.dialog, "setup").tab).toBe(SCHEDULED_TAB);
  });

  test("digits and action letters typed into the Schedule and Prompt fields stay in them", async () => {
    const { ctx } = makeHost();
    await openTab(ctx);
    press(ctx, "a");
    const form = assertDialog(ctx.dialog, "scheduled-task-form");
    focus(ctx, form, "cron");
    type(ctx, "*/5 1-4 * * 1");
    expect(form.cron).toBe("*/5 1-4 * * 1");
    focus(ctx, form, "prompt");
    type(ctx, "a 4 x j k 1");
    expect(form.buffer.getText()).toBe("a 4 x j k 1");
    expect(ctx.dialog).toBe(form);
  });
});

describe("Scheduled tab list", () => {
  test("an empty list says how to add a task", async () => {
    const { ctx } = makeHost();
    await openTab(ctx);
    expect(tabText(ctx)).toContain("No scheduled tasks. Press a to add one.");
    expect(tabText(ctx)).toContain("a: add, Enter: edit, x: delete");
    expect(assertDialog(ctx.dialog, "setup").tab).toBe(SCHEDULED_TAB);
  });

  test("a task shows its schedule, target, type, auto-retire, first prompt line and next run", async () => {
    await createScheduledTask(TASK);
    const { ctx } = makeHost();
    await openTab(ctx);
    const text = tabText(ctx);
    expect(text).toContain("> 30 9 * * 1-5  This machine/itsybitsy  worker  auto-retire");
    expect(text).toContain("    Check the build");
    expect(text).not.toContain("then report");
    expect(text).toContain(`    next: ${formatFireTime(nextFireTime(TASK.cron, Date.now())!)}`);
  });

  test("a task without auto-retire does not say so", async () => {
    await createScheduledTask({ ...TASK, autoRetire: false });
    const { ctx } = makeHost();
    await openTab(ctx);
    expect(tabText(ctx)).not.toContain("auto-retire");
  });

  test("a task that has run shows the last run: the agent it started, or its error in red", async () => {
    const ranAt = new Date(2026, 10, 24, 9, 30).getTime();
    await writeTasks([
      { id: "task-00000001", ...TASK, lastRunAt: ranAt, lastAgentId: "agent-7" },
      { id: "task-00000002", ...TASK, cron: "@daily", lastRunAt: ranAt, lastError: "No such repo" },
    ]);
    const { ctx } = makeHost();
    await openTab(ctx);
    const text = tabText(ctx);
    expect(text).toContain(`last run: ${formatFireTime(ranAt)} started agent-7`);
    expect(text).toContain(`last run: ${formatFireTime(ranAt)} failed: No such repo`);
    expect(text).not.toContain("next:");
    const raw = buildSetupContent(assertDialog(ctx.dialog, "setup"), 66).contentLines;
    expect(raw.find(line => line.includes("failed:"))).toContain(RED);
    expect(raw.find(line => line.includes("started agent-7"))).not.toContain(RED);
  });

  test("a peer task names the peer from peers.json, or its short id when it is no longer paired", async () => {
    await writePeers([{ id: PEER_B, name: "Laptop B" }]);
    await createScheduledTask({ ...TASK, machine: PEER_B, repo: "web" });
    await createScheduledTask({ ...TASK, machine: UNPAIRED, repo: "api" });
    const { ctx } = makeHost();
    await openTab(ctx);
    const text = tabText(ctx);
    expect(text).toContain("Laptop B/web");
    expect(text).toContain(`${UNPAIRED.slice(0, 10)} (unpaired)/api`);
  });

  test("j/k and the arrows move the selection; a long list keeps it visible", async () => {
    for (let minute = 0; minute < 12; minute++) await createScheduledTask({ ...TASK, cron: `${minute} 9 * * *` });
    const { ctx } = makeHost();
    const tab = await openTab(ctx);
    press(ctx, "j", "\x1b[B");
    expect(tab.selectedIndex).toBe(2);
    press(ctx, "k", "\x1b[A", "k");
    expect(tab.selectedIndex).toBe(0);
    const window = () => buildScheduledTabContent(tab, 66, 18).map(stripAnsi);
    expect(window()).toContain("  ↓ 8 more");
    for (let i = 0; i < 20; i++) press(ctx, "j");
    expect(tab.selectedIndex).toBe(11);
    expect(window()).toContain("  ↑ 8 more");
    expect(window()).toContain("> 11 9 * * *  This machine/itsybitsy  worker  auto-retire");
    expect(window().length).toBeLessThanOrEqual(18);
  });

  test("a malformed task file shows the store's error and allows no edits", async () => {
    await mkdir(dirname(scheduledTasksFile()), { recursive: true });
    await Bun.write(scheduledTasksFile(), "{ not json");
    const { ctx } = makeHost();
    const tab = await openTab(ctx);
    expect(tab.error).toContain("not valid JSON");
    expect(tabText(ctx).replaceAll("\n", "")).toContain(`${scheduledTasksFile()}: not valid JSON`);
    const setup = ctx.dialog;
    press(ctx, "a", "\r", "x");
    expect(ctx.dialog).toBe(setup);
    expect(await Bun.file(scheduledTasksFile()).text()).toBe("{ not json");
  });

  test("Esc closes setup from the Scheduled tab", async () => {
    const { ctx } = makeHost();
    await openTab(ctx);
    press(ctx, "\x1b");
    expect(ctx.dialog).toBeNull();
  });
});

describe("Scheduled task form", () => {
  test("a adds a task: the fields round-trip through the store and the new task is selected", async () => {
    await createScheduledTask({ ...TASK, cron: "@daily" });
    const { ctx } = makeHost({ repos: ["itsybitsy", "web"] });
    const tab = await openTab(ctx);
    press(ctx, "a");
    const form = assertDialog(ctx.dialog, "scheduled-task-form");
    expect(form.task).toBeNull();
    expect(buildScheduledTaskFormContent(form, 66).title).toBe("New Scheduled Task");
    expect(form.focused).toBe("machine");
    expect(formText(form)).toContain("Machine: This machine");
    expect(formText(form)).toContain("Repo: itsybitsy");
    expect(form.agentType).toBe("manager");

    focus(ctx, form, "repo");
    press(ctx, " ");
    expect(formText(form)).toContain("Repo: web");
    focus(ctx, form, "agentType");
    press(ctx, " ");
    const agentType = form.agentType;
    expect(agentType).not.toBe("manager");
    focus(ctx, form, "cron");
    expect(formText(form)).toContain("min hour day month weekday, e.g. 30 9 * * 1-5");
    type(ctx, "15 8 * * 1");
    expect(formText(form)).toContain(`next: ${formatFireTime(nextFireTime("15 8 * * 1", Date.now())!)}`);
    focus(ctx, form, "autoRetire");
    expect(formText(form)).toContain("[ ] Auto-retire");
    expect(flat(formText(form))).toContain("retire the agent when it signals I HAVE COMPLETED THE GOAL (archived, not merged)");
    press(ctx, " ");
    expect(formText(form)).toContain("[x] Auto-retire");
    press(ctx, "\r");
    expect(form.autoRetire).toBe(false);
    press(ctx, " ");
    focus(ctx, form, "prompt");
    type(ctx, "Triage new issues");
    press(ctx, "\r");
    type(ctx, "and label them");
    focus(ctx, form, "save");
    press(ctx, "\r");

    const reopened = await reopenedTab(ctx, tab);
    const stored = await readScheduledTasks();
    expect(stored).toHaveLength(2);
    expect(stored[1]).toEqual({
      id: stored[1]!.id, machine: null, repo: "web", agentType, prompt: "Triage new issues\nand label them", cron: "15 8 * * 1", autoRetire: true,
    });
    expect(reopened.tasks!.map(t => t.id)).toEqual(stored.map(t => t.id));
    expect(reopened.selectedIndex).toBe(1);
  });

  test("Enter edits the selected task: it keeps its id and last run, and stays selected", async () => {
    const first = await createScheduledTask({ ...TASK, cron: "@daily" });
    await writeTasks([first, { id: "task-00000002", ...TASK, lastRunAt: 1_700_000_000_000, lastAgentId: "agent-3" }]);
    const { ctx } = makeHost();
    const tab = await openTab(ctx);
    press(ctx, "j", "\r");
    const form = assertDialog(ctx.dialog, "scheduled-task-form");
    expect(buildScheduledTaskFormContent(form, 66).title).toBe("Edit Scheduled Task");
    expect([form.cron, form.agentType, form.autoRetire, form.buffer.getText()]).toEqual([TASK.cron, "worker", true, TASK.prompt]);

    focus(ctx, form, "cron");
    press(ctx, "\x7f", "\x7f", "\x7f");
    type(ctx, "0");
    focus(ctx, form, "autoRetire");
    press(ctx, " ");
    focus(ctx, form, "prompt");
    type(ctx, " today");
    focus(ctx, form, "save");
    press(ctx, "\r");

    const reopened = await reopenedTab(ctx, tab);
    const stored = await readScheduledTasks();
    expect(stored[0]).toEqual(first);
    expect(stored[1]).toEqual({
      id: "task-00000002", ...TASK, cron: "30 9 * * 0", autoRetire: false, prompt: `${TASK.prompt} today`,
      lastRunAt: 1_700_000_000_000, lastAgentId: "agent-3",
    });
    expect(reopened.selectedIndex).toBe(1);
  });

  test("the schedule is checked as it is typed", async () => {
    const { ctx } = makeHost();
    await openTab(ctx);
    press(ctx, "a");
    const form = assertDialog(ctx.dialog, "scheduled-task-form");
    expect(formText(form)).toContain("Schedule is empty");
    focus(ctx, form, "cron");
    type(ctx, "30 9 * *");
    expect(formText(form)).toContain("Invalid cron expression");
    const raw = buildScheduledTaskFormContent(form, 66).contentLines;
    expect(raw.find(line => line.includes("Invalid cron"))).toContain(RED);
    type(ctx, " 1");
    expect(formText(form)).toContain(`next: ${formatFireTime(nextFireTime("30 9 * * 1", Date.now())!)}`);
    expect(formText(form)).not.toContain("Invalid");
  });

  test("a refused Save shows the store's error inline and keeps the draft", async () => {
    const { ctx } = makeHost();
    await openTab(ctx);
    press(ctx, "a");
    const form = assertDialog(ctx.dialog, "scheduled-task-form");
    focus(ctx, form, "cron");
    type(ctx, "@hourly");
    focus(ctx, form, "save");
    press(ctx, "\r");
    await waitFor(() => form.error !== undefined && !form.saving, { message: "the Save to fail" });
    expect(form.error).toBe("Prompt is required");
    expect(ctx.dialog).toBe(form);
    expect(form.cron).toBe("@hourly");
    expect(formText(form)).toContain("Prompt is required");
    expect(await readScheduledTasks()).toEqual([]);
  });

  test("Esc and Cancel return to the Scheduled tab without saving", async () => {
    const task = await createScheduledTask(TASK);
    const { ctx } = makeHost();
    let tab = await openTab(ctx);
    press(ctx, "\r");
    let form = assertDialog(ctx.dialog, "scheduled-task-form");
    focus(ctx, form, "cron");
    type(ctx, "junk");
    press(ctx, "\x1b");
    tab = await reopenedTab(ctx, tab);
    expect(tab.selectedIndex).toBe(0);

    press(ctx, "a");
    form = assertDialog(ctx.dialog, "scheduled-task-form");
    focus(ctx, form, "prompt");
    type(ctx, "never saved");
    focus(ctx, form, "cancel");
    press(ctx, "\r");
    await reopenedTab(ctx, tab);
    expect(await readScheduledTasks()).toEqual([task]);
  });

  test("Save is disabled when the machine has no known repo, and says why", async () => {
    const { ctx } = makeHost({ repos: [] });
    await openTab(ctx);
    press(ctx, "a");
    const form = assertDialog(ctx.dialog, "scheduled-task-form");
    const text = formText(form);
    expect(text).toContain("Repo: (none)");
    expect(text).toContain("No repos are registered on this machine.");
    focus(ctx, form, "cron");
    type(ctx, "@daily");
    focus(ctx, form, "prompt");
    type(ctx, "Check");
    focus(ctx, form, "cancel");
    press(ctx, "\t");
    expect(form.focused).toBe("machine"); // the disabled Save is skipped
    form.focused = "save";
    press(ctx, "\r");
    expect(form.saving).toBeUndefined();
    expect(ctx.dialog).toBe(form);
    expect(await readScheduledTasks()).toEqual([]);
  });

  test("Machine lists this machine, then every paired peer in file order with its link status; a peer's repos come from its connected link", async () => {
    await writePeers([{ id: PEER_B, name: "Laptop B" }, { id: PEER_C, name: "Laptop C" }]);
    const { ctx, view } = makeHost({ links: [link(PEER_B, "Laptop B", false), link(PEER_C, "Laptop C", true, ["web", "api"])] });
    await openTab(ctx);
    press(ctx, "a");
    const form = assertDialog(ctx.dialog, "scheduled-task-form");
    expect(form.machines().map(m => [m.name, m.status])).toEqual([["This machine", null], ["Laptop B", "offline"], ["Laptop C", "connected"]]);

    press(ctx, " ");
    expect(form.machine).toBe(PEER_B);
    expect(formText(form)).toContain("Machine: Laptop B  offline");
    expect(flat(formText(form))).toContain("Laptop B is offline: its repos are known only while it is connected.");
    expect(formText(form)).toContain("Repo: (none)");

    press(ctx, " ");
    expect(form.machine).toBe(PEER_C);
    expect(formText(form)).toContain("Machine: Laptop C  connected");
    expect(formText(form)).toContain("Repo: web");
    focus(ctx, form, "repo");
    press(ctx, " ");
    expect(formText(form)).toContain("Repo: api");

    // The link comes up while the form is open.
    view.links = [link(PEER_B, "Laptop B", true, ["docs"]), view.links[1]!];
    focus(ctx, form, "machine");
    press(ctx, "\x1b[D");
    expect(form.machine).toBe(PEER_B);
    expect(formText(form)).toContain("Repo: docs");
    press(ctx, "\x1b[D");
    expect(form.machine).toBeNull();
    expect(formText(form)).toContain("Repo: itsybitsy");
  });

  test("the form fits a 24-row terminal with a repo warning, a schedule error and a long prompt", async () => {
    await writePeers([{ id: PEER_B, name: "Laptop B" }]);
    const { ctx } = makeHost({ links: [link(PEER_B, "Laptop B", false)] });
    await openTab(ctx);
    press(ctx, "a", " ");
    const form = assertDialog(ctx.dialog, "scheduled-task-form");
    form.cron = "30 9 * *";
    for (let i = 0; i < 8; i++) form.buffer.handleInput(i ? "\r" : "line");
    const lines = buildScheduledTaskFormContent(form, 66).contentLines;
    expect(stripAnsi(lines.join("\n"))).toContain("Invalid cron expression");
    expect(lines.length).toBeLessThanOrEqual(22); // 24 rows, less the box's top and bottom border
  });

  test("editing keeps the task's repo, and its machine when no longer paired, as choices", async () => {
    await writePeers([{ id: PEER_B, name: "Laptop B" }]);
    await createScheduledTask({ ...TASK, machine: PEER_B, repo: "web" });
    await createScheduledTask({ ...TASK, machine: UNPAIRED, repo: "api" });
    const { ctx } = makeHost({ links: [link(PEER_B, "Laptop B", false)] });
    const tab = await openTab(ctx);
    press(ctx, "\r");
    let form = assertDialog(ctx.dialog, "scheduled-task-form");
    expect(formText(form)).toContain("Machine: Laptop B  offline");
    expect(formText(form)).toContain("Repo: web");
    expect(formText(form)).not.toContain("its repos are known");

    press(ctx, "\x1b");
    await reopenedTab(ctx, tab);
    press(ctx, "j", "\r");
    form = assertDialog(ctx.dialog, "scheduled-task-form");
    expect(form.machines().map(m => m.id)).toEqual([null, PEER_B, UNPAIRED]);
    expect(formText(form)).toContain(`Machine: ${UNPAIRED.slice(0, 10)} (unpaired)`);
    expect(formText(form)).toContain("Repo: api");
    focus(ctx, form, "save");
    press(ctx, "\r");
    await waitFor(() => ctx.dialog?.type === "setup", { message: "the Save to finish" });
    expect((await readScheduledTasks())[1]).toMatchObject({ machine: UNPAIRED, repo: "api" });
  });

  test("Type offers the spawnable types without the two coordinator types", async () => {
    const types = scheduledTaskTypes();
    expect(types).toContain("manager");
    expect(types).toContain("worker");
    expect(types).not.toContain("repo-coordinator");
    expect(types).not.toContain("system-coordinator");
    const { ctx } = makeHost();
    await openTab(ctx);
    press(ctx, "a");
    const form = assertDialog(ctx.dialog, "scheduled-task-form");
    expect(form.availableTypes).toEqual(types);
    focus(ctx, form, "agentType");
    const seen = new Set<string>();
    for (let i = 0; i < types.length + 1; i++) {
      seen.add(form.agentType);
      press(ctx, " ");
    }
    expect([...seen].sort()).toEqual([...types].sort());
  });
});

describe("Scheduled task delete", () => {
  test("x asks first: Cancel keeps the task, Delete removes it and selects its neighbor", async () => {
    const first = await createScheduledTask({ ...TASK, cron: "@daily" });
    const second = await createScheduledTask(TASK);
    const third = await createScheduledTask({ ...TASK, cron: "@hourly" });
    const { ctx } = makeHost();
    let tab = await openTab(ctx);
    press(ctx, "j", "x");
    let confirm = assertDialog(ctx.dialog, "confirm");
    expect(confirm.prompt).toBe(`Delete the scheduled task "${TASK.cron}" on This machine/itsybitsy?`);
    expect(confirm.focusedButton).toBe("cancel");
    press(ctx, "\r");
    tab = await reopenedTab(ctx, tab);
    expect(tab.selectedIndex).toBe(1);
    expect(await readScheduledTasks()).toEqual([first, second, third]);

    press(ctx, "x");
    press(ctx, "\x1b");
    tab = await reopenedTab(ctx, tab);
    expect(await readScheduledTasks()).toEqual([first, second, third]);

    press(ctx, "x");
    confirm = assertDialog(ctx.dialog, "confirm");
    press(ctx, "\t");
    expect(confirm.focusedButton).toBe("confirm");
    press(ctx, "\r");
    tab = await reopenedTab(ctx, tab);
    expect(await readScheduledTasks()).toEqual([first, third]);
    expect(tab.tasks!.map(t => t.id)).toEqual([first.id, third.id]);
    expect(tab.selectedIndex).toBe(1);
  });

  test("deleting the last task selects the one before it", async () => {
    const first = await createScheduledTask({ ...TASK, cron: "@daily" });
    await createScheduledTask(TASK);
    const { ctx } = makeHost();
    let tab = await openTab(ctx);
    press(ctx, "j", "x", "\t", "\r");
    tab = await reopenedTab(ctx, tab);
    expect(await readScheduledTasks()).toEqual([first]);
    expect(tab.selectedIndex).toBe(0);
  });
});

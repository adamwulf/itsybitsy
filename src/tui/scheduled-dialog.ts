/**
 * The Scheduled tab of setup (`h` then `4`; SPEC.md §21.4): the tasks in
 * `scheduled-tasks.json` (src/scheduled-tasks.ts), and the form that adds or
 * edits one. The tab reads the task file and `peers.json` when it opens; it
 * is not refreshed while shown. The form's Machine, Repo and Type fields cycle
 * like the New Agent form's, and its prompt is the same multi-line TextBuffer.
 *
 * The scheduler that fires the tasks lives elsewhere; this module only edits
 * the store through its API.
 */

import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import { listSpawnableTypeNamesSync } from "../agent-types";
import { isCoordinatorType } from "../coordinator-type-names";
import { peerLinkStatus, type PeerLinkState, type PeerLinkStatus } from "../peers/poller";
import { readPeers, shortPeerId, type Peer } from "../peers/store";
import {
  createScheduledTask, cronProblem, deleteScheduledTask, nextFireTime, readScheduledTasks, updateScheduledTask,
  type ScheduledTask, type ScheduledTaskInput,
} from "../scheduled-tasks";
import { cancelPaste, resolvePasteText, sanitizePasteForSingleLine } from "./clipboard";
import { BOLD, DIM, GREEN, RED, RESET } from "./colors";
import { resolveDefaultAgentType } from "./default-agent-type";
import { renderTextareaBlock, type DialogCtx, type DialogState } from "./dialog-handler";
import { peerLinkStateText } from "./peers-dialog";
import { deleteWord, TextBuffer } from "./text-buffer";
import { wordWrapLines } from "./wrap";

/** What the tab and the form need from the dashboard. ActionCtx satisfies it. */
export interface ScheduledHost {
  readonly dialog: DialogState;
  /** This machine's registered repos; `name` is the registry name. */
  readonly repos: ReadonlyArray<{ name: string }>;
  readonly peerService: { view(): { readonly links: readonly PeerLinkState[] } } | null;
  readonly tui: { requestRender(): void } | null;
  showDialog(dialog: NonNullable<DialogState>): void;
  closeDialog(): void;
  setNotice(text: string, kind: "info" | "error"): void;
}

/** How to (re)open the tab. */
export interface ScheduledTabOptions {
  /** Select this task once the list is read. */
  select?: string;
  /** Read the list only after this settles (a delete in flight). It must not reject. */
  after?: Promise<unknown>;
}

/** Reopen setup on the Scheduled tab. */
export type ReopenScheduledTab = (options: ScheduledTabOptions) => void;

export type ScheduledTabState = {
  /** The tasks in file order; null while the file is read. */
  tasks: ScheduledTask[] | null;
  /** Why the task file could not be read. Shown in red; nothing can be added, edited or deleted. */
  error: string | null;
  /** peers.json, for the machine names, read with the tasks. */
  peers: Peer[];
  /** Why peers.json could not be read. */
  peersError: string | null;
  selectedIndex: number;
  onAdd(): void;
  onEdit(task: ScheduledTask): void;
  onDelete(task: ScheduledTask): void;
};

/** The form's fields in Tab order. */
export const SCHEDULED_FORM_FIELDS = ["machine", "repo", "agentType", "cron", "autoRetire", "prompt", "cancel", "save"] as const;
export type ScheduledFormField = (typeof SCHEDULED_FORM_FIELDS)[number];

/** A Machine choice: `status` is null for this machine, "unpaired" for a peer no longer in peers.json. */
export type ScheduledMachineChoice = { id: string | null; name: string; status: PeerLinkStatus | "unpaired" | null };

export type ScheduledTaskFormDialog = {
  type: "scheduled-task-form";
  /** The task being edited, or null for a new one. */
  task: ScheduledTask | null;
  /** This machine, then the peers of peers.json in file order, with their live link status. */
  machines(): ScheduledMachineChoice[];
  /** The repos `machine` offers now, or why it offers none. */
  repoChoices(machine: string | null): { repos: string[]; why: string | null };
  machine: string | null;
  /** The last repo picked; the Repo field shows it while `machine` offers it, else the first repo offered. */
  repo: string;
  agentType: string;
  availableTypes: string[];
  cron: string;
  autoRetire: boolean;
  buffer: TextBuffer;
  focused: ScheduledFormField;
  /** Set while Save writes the store; the form ignores keys until it settles. */
  saving?: boolean;
  /** Why the last Save failed. */
  error?: string;
  onSave(input: ScheduledTaskInput): void;
  /** Esc or Cancel: back to the Scheduled tab. */
  onCancel(): void;
};

const FIRE_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** A fire time in local time, e.g. `Wed, Nov 26 at 09:30`. */
export function formatFireTime(ms: number): string {
  return FIRE_TIME_FORMAT.format(new Date(ms));
}

export const SCHEDULE_FORMAT_HINT = "min hour day month weekday, e.g. 30 9 * * 1-5";
export const AUTO_RETIRE_NOTE = "retire the agent when it signals I HAVE COMPLETED THE GOAL (archived, not merged)";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Store text shown in the TUI: a lastError can carry a peer's words, so control characters go. */
function printable(text: string): string {
  return text.replace(/\p{Cc}/gu, " ");
}

function sameRepoName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A task's machine in the list: `This machine`, the peer's name, or its short id when it is not paired. */
export function scheduledMachineName(machine: string | null, peers: readonly Peer[], peersError: string | null): string {
  if (machine === null) return "This machine";
  const peer = peers.find(p => p.id === machine);
  if (peer) return peer.name;
  // Unreadable peers.json: the peer may still be paired.
  return peersError === null ? `${shortPeerId(machine)} (unpaired)` : shortPeerId(machine);
}

// --- The tab ---

/**
 * The Scheduled tab's state, read in the background: the dialog shows
 * `Loading…` until the task file and peers.json are read.
 */
export function openScheduledTab(host: ScheduledHost, reopen: ReopenScheduledTab, options: ScheduledTabOptions = {}): ScheduledTabState {
  const state: ScheduledTabState = {
    tasks: null,
    error: null,
    peers: [],
    peersError: null,
    selectedIndex: 0,
    onAdd: () => showScheduledTaskForm(host, null, state, reopen),
    onEdit: task => showScheduledTaskForm(host, task, state, reopen),
    onDelete: task => confirmScheduledTaskDelete(host, state, task, reopen),
  };
  void (async () => {
    await options.after;
    const [tasks, peers] = await Promise.allSettled([readScheduledTasks(), readPeers()]);
    if (peers.status === "fulfilled") state.peers = peers.value;
    else state.peersError = errorText(peers.reason);
    if (tasks.status === "fulfilled") {
      state.selectedIndex = Math.max(0, tasks.value.findIndex(t => t.id === options.select));
      state.tasks = tasks.value;
    } else {
      state.error = errorText(tasks.reason);
    }
    host.tui?.requestRender();
  })();
  return state;
}

function confirmScheduledTaskDelete(host: ScheduledHost, state: ScheduledTabState, task: ScheduledTask, reopen: ReopenScheduledTab): void {
  const tasks = state.tasks ?? [];
  const index = tasks.findIndex(t => t.id === task.id);
  const neighbor = tasks[index + 1] ?? tasks[index - 1];
  const where = `${scheduledMachineName(task.machine, state.peers, state.peersError)}/${task.repo}`;
  host.showDialog({
    type: "confirm",
    prompt: `Delete the scheduled task "${printable(task.cron)}" on ${printable(where)}?`,
    confirmLabel: "Delete",
    focusedButton: "cancel",
    confirmColor: RED,
    onYes: () => {
      const done = deleteScheduledTask(task.id).then(
        deleted => { if (!deleted) host.setNotice("The scheduled task was already deleted", "info"); },
        err => host.setNotice(`Delete failed: ${errorText(err)}`, "error"),
      );
      reopen({ select: neighbor?.id, after: done });
    },
    onCancel: () => reopen({ select: task.id }),
  });
}

/** Keys on the Scheduled tab, after setup's tab navigation. */
export function handleScheduledTabInput(ctx: DialogCtx, s: ScheduledTabState, data: string): boolean {
  // Loading, or a file that cannot be read: nothing to move through or change.
  if (s.tasks === null || s.error !== null) return true;
  const selected = s.tasks[s.selectedIndex];
  if (matchesKey(data, Key.down) || data === "j") {
    s.selectedIndex = Math.max(0, Math.min(s.tasks.length - 1, s.selectedIndex + 1));
  } else if (matchesKey(data, Key.up) || data === "k") {
    s.selectedIndex = Math.max(0, s.selectedIndex - 1);
  } else if (data === "a") {
    s.onAdd();
  } else if (matchesKey(data, Key.enter)) {
    if (selected) s.onEdit(selected);
  } else if (data === "x") {
    if (selected) s.onDelete(selected);
  } else {
    return true;
  }
  ctx.tui?.requestRender();
  return true;
}

/** One task's lines in the list: 3, and a 4th once it has run. */
function taskLines(task: ScheduledTask, selected: boolean, s: ScheduledTabState, innerWidth: number, now: number): string[] {
  const head = [
    task.cron,
    `${scheduledMachineName(task.machine, s.peers, s.peersError)}/${task.repo}`,
    task.agentType,
    ...(task.autoRetire ? ["auto-retire"] : []),
  ].map(printable).join("  ");
  const first = selected
    ? `${GREEN}> ${BOLD}${truncateToWidth(head, innerWidth - 2, "…")}${RESET}`
    : `  ${truncateToWidth(head, innerWidth - 2, "…")}`;
  const detail = (text: string, color: string) => `    ${color}${truncateToWidth(printable(text), innerWidth - 4, "…")}${RESET}`;
  const lines = [first, `    ${truncateToWidth(printable(task.prompt.split("\n")[0] ?? ""), innerWidth - 4, "…")}`];
  const next = nextFireTime(task.cron, now);
  lines.push(next !== null ? detail(`next: ${formatFireTime(next)}`, DIM) : detail(cronProblem(task.cron) ?? "Schedule never fires", RED));
  if (task.lastRunAt !== undefined) {
    const last = `last run: ${formatFireTime(task.lastRunAt)}`;
    if (task.lastError !== undefined) lines.push(detail(`${last} failed: ${task.lastError}`, RED));
    else lines.push(detail(task.lastAgentId !== undefined ? `${last} started ${task.lastAgentId}` : last, DIM));
  }
  return lines;
}

/** The Scheduled tab's lines under the hint, at most `maxLines` (the selected task stays visible). */
export function buildScheduledTabContent(s: ScheduledTabState, innerWidth: number, maxLines: number, now = Date.now()): string[] {
  const wrapRed = (text: string) => wordWrapLines(text, innerWidth).map(line => `${RED}${line}${RESET}`);
  if (s.error !== null) return wrapRed(s.error);
  if (s.tasks === null) return ["Loading scheduled tasks…"];
  const lines = s.peersError === null ? [] : wrapRed(s.peersError);
  const tasks = s.tasks;
  if (tasks.length === 0) return [...lines, "No scheduled tasks. Press a to add one."];

  // Tasks are separated by a blank line. When they do not all fit, the
  // window grows from the selected task, a task below then one above, in
  // the room left after the ↑ and ↓ lines.
  const groups = tasks.map((task, i) => taskLines(task, i === s.selectedIndex, s, innerWidth, now));
  const room = maxLines - lines.length;
  let start = 0;
  let end = tasks.length;
  if (groups.reduce((sum, group) => sum + group.length + 1, -1) > room) {
    const budget = room - 2;
    start = s.selectedIndex;
    end = start + 1;
    let used = groups[start]!.length;
    for (let grew = true; grew;) {
      grew = false;
      if (end < groups.length && used + 1 + groups[end]!.length <= budget) { used += 1 + groups[end++]!.length; grew = true; }
      if (start > 0 && used + 1 + groups[start - 1]!.length <= budget) { used += 1 + groups[--start]!.length; grew = true; }
    }
  }
  if (start > 0) lines.push(`${DIM}  ↑ ${start} more${RESET}`);
  for (let i = start; i < end; i++) {
    if (i > start) lines.push("");
    lines.push(...groups[i]!);
  }
  if (end < tasks.length) lines.push(`${DIM}  ↓ ${tasks.length - end} more${RESET}`);
  return lines;
}

// --- The form ---

/** The spawnable types a task can start: every spawnable type but the two coordinators. */
export function scheduledTaskTypes(): string[] {
  return listSpawnableTypeNamesSync().filter(name => !isCoordinatorType(name));
}

function showScheduledTaskForm(host: ScheduledHost, task: ScheduledTask | null, s: ScheduledTabState, reopen: ReopenScheduledTab): void {
  const returnTo = task?.id ?? s.tasks?.[s.selectedIndex]?.id;
  host.showDialog(newScheduledTaskForm(host, task, s.peers, {
    onSaved: saved => reopen({ select: saved.id }),
    onCancel: () => reopen({ select: returnTo }),
  }));
}

/**
 * The add/edit form. When editing, the task's machine, repo and type stay
 * choices even when they are no longer paired, reported or spawnable, so
 * editing one field never retargets the task.
 */
export function newScheduledTaskForm(
  host: ScheduledHost,
  task: ScheduledTask | null,
  peers: readonly Peer[],
  done: { onSaved(task: ScheduledTask): void; onCancel(): void },
): ScheduledTaskFormDialog {
  const types = scheduledTaskTypes();
  if (task && !types.includes(task.agentType)) types.push(task.agentType);
  const links = () => host.peerService?.view().links ?? [];
  const machines = (): ScheduledMachineChoice[] => {
    const current = links();
    const choices: ScheduledMachineChoice[] = [
      { id: null, name: "This machine", status: null },
      ...peers.map(peer => ({ id: peer.id, name: peer.name, status: peerLinkStatus(current.find(link => link.id === peer.id)) })),
    ];
    if (task?.machine && !peers.some(peer => peer.id === task.machine)) {
      choices.push({ id: task.machine, name: shortPeerId(task.machine), status: "unpaired" });
    }
    return choices;
  };
  const repoChoices = (machine: string | null): { repos: string[]; why: string | null } => {
    let repos: string[];
    let why: string;
    if (machine === null) {
      repos = host.repos.map(repo => repo.name);
      why = "No repos are registered on this machine.";
    } else {
      const choice = machines().find(m => m.id === machine);
      const link = links().find(l => l.id === machine);
      const name = choice?.name ?? shortPeerId(machine);
      repos = link?.connected ? (link.repos ?? []).map(repo => repo.registryName) : [];
      why = choice?.status === "unpaired" ? `${name} is no longer paired.`
        : link?.connected ? `${name} reports no repos.`
        : `${name} is ${choice?.status ?? "offline"}: its repos are known only while it is connected.`;
    }
    if (task && task.machine === machine && !repos.some(repo => sameRepoName(repo, task.repo))) repos = [...repos, task.repo];
    return { repos, why: repos.length ? null : why };
  };

  const form: ScheduledTaskFormDialog = {
    type: "scheduled-task-form",
    task,
    machines,
    repoChoices,
    machine: task?.machine ?? null,
    repo: task?.repo ?? "",
    agentType: task?.agentType ?? resolveDefaultAgentType(undefined, types),
    availableTypes: types,
    cron: task?.cron ?? "",
    autoRetire: task?.autoRetire ?? false,
    buffer: new TextBuffer(task ? task.prompt.split("\n") : undefined),
    focused: "machine",
    onSave: async input => {
      if (form.saving) return;
      form.saving = true;
      form.error = undefined;
      host.tui?.requestRender();
      try {
        const saved = task ? await updateScheduledTask(task.id, input) : await createScheduledTask(input);
        if (host.dialog === form) done.onSaved(saved);
        else host.setNotice("Scheduled task saved", "info");
      } catch (err) {
        form.error = errorText(err);
      } finally {
        form.saving = false;
        host.tui?.requestRender();
      }
    },
    onCancel: () => done.onCancel(),
  };
  return form;
}

/** The repo the Repo field shows and Save stores, or null when the machine offers none. */
export function scheduledFormRepo(form: ScheduledTaskFormDialog): string | null {
  const { repos } = form.repoChoices(form.machine);
  return repos.find(repo => sameRepoName(repo, form.repo)) ?? repos[0] ?? null;
}

/** What Save would store, or null while Save is disabled (no repo). */
export function scheduledFormInput(form: ScheduledTaskFormDialog): ScheduledTaskInput | null {
  const repo = scheduledFormRepo(form);
  if (repo === null) return null;
  return {
    machine: form.machine,
    repo,
    agentType: form.agentType,
    prompt: form.buffer.getText().trim(),
    cron: form.cron,
    autoRetire: form.autoRetire,
  };
}

/** Step a cycling field (Machine, Repo, Type) by `delta`. */
function cycleField(form: ScheduledTaskFormDialog, delta: 1 | -1): void {
  const step = <T>(items: readonly T[], index: number): T | undefined =>
    items.length ? items[index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length] : undefined;
  if (form.focused === "machine") {
    const machines = form.machines();
    form.machine = step(machines, machines.findIndex(m => m.id === form.machine))?.id ?? null;
  } else if (form.focused === "repo") {
    const { repos } = form.repoChoices(form.machine);
    const current = scheduledFormRepo(form);
    const next = step(repos, current === null ? -1 : repos.indexOf(current));
    if (next !== undefined) form.repo = next;
  } else if (form.focused === "agentType") {
    const next = step(form.availableTypes, form.availableTypes.indexOf(form.agentType));
    if (next !== undefined) form.agentType = next;
  }
}

/** Single-line editing of the Schedule field, the New Agent form's Name rules. */
function editCron(form: ScheduledTaskFormDialog, data: string, render: () => void): void {
  if (matchesKey(data, Key.alt("backspace"))) {
    form.cron = deleteWord(form.cron);
  } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
    form.cron = form.cron.slice(0, -1);
  } else {
    const apply = (text: string) => {
      form.cron += sanitizePasteForSingleLine(text);
      render();
    };
    const pasted = resolvePasteText(data, apply);
    if (pasted !== null) apply(pasted);
    else if (data.length === 1 && data >= " ") form.cron += data;
  }
}

/** Keys in the form. Esc is handled with the other dialogs' (handleDialogInput), and calls onCancel. */
export function handleScheduledTaskFormInput(ctx: DialogCtx, form: ScheduledTaskFormDialog, data: string): boolean {
  const render = () => ctx.tui?.requestRender();
  const saveDisabled = scheduledFormRepo(form) === null;
  const move = (dir: 1 | -1) => {
    const fields = SCHEDULED_FORM_FIELDS;
    let index = fields.indexOf(form.focused);
    do {
      index = (index + dir + fields.length) % fields.length;
    } while (fields[index] === "save" && saveDisabled);
    form.focused = fields[index]!;
  };

  if (matchesKey(data, Key.tab)) move(1);
  else if (matchesKey(data, Key.shift("tab"))) move(-1);
  else {
    switch (form.focused) {
      case "machine":
      case "repo":
      case "agentType":
        // Left/Right also work on terminals that cannot distinguish Shift+Space.
        if (matchesKey(data, Key.shift("space")) || matchesKey(data, Key.left)) cycleField(form, -1);
        else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || matchesKey(data, Key.right)) cycleField(form, 1);
        break;
      case "cron":
        if (matchesKey(data, Key.enter)) move(1);
        else editCron(form, data, render);
        break;
      case "autoRetire":
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) form.autoRetire = !form.autoRetire;
        break;
      case "prompt":
        form.buffer.handleInput(data, render);
        break;
      case "cancel":
      case "save":
        if (matchesKey(data, Key.enter)) {
          // A late Ctrl+V clipboard read must not change the prompt after Save or Cancel.
          cancelPaste();
          if (form.focused === "cancel") {
            ctx.closeDialog();
            form.onCancel();
            return true;
          }
          const input = scheduledFormInput(form);
          if (input) form.onSave(input);
        } else if (matchesKey(data, Key.right)) {
          move(1);
        } else if (matchesKey(data, Key.left)) {
          move(-1);
        } else if (form.buffer.handleInput(data, render)) {
          form.focused = "prompt";
        }
        break;
    }
  }
  render();
  return true;
}

function machineLabel(choice: ScheduledMachineChoice): string {
  if (choice.status === null) return choice.name;
  if (choice.status === "unpaired") return `${choice.name} (unpaired)`;
  return `${choice.name}  ${peerLinkStateText(choice.status)}`;
}

/** Build content for the scheduled-task form. */
export function buildScheduledTaskFormContent(form: ScheduledTaskFormDialog, innerWidth: number): { title: string; contentLines: string[] } {
  const lines: string[] = [];
  const cycleHint = ` ${DIM}[Space/Enter/→ next, Shift+Space/← prev]${RESET}`;
  const cycler = (field: ScheduledFormField, label: string, value: string, choices: number) => {
    const focused = form.focused === field;
    const text = focused ? `${BOLD}${GREEN}${label}: ${value}${RESET}` : `${DIM}${label}:${RESET} ${value}`;
    lines.push(truncateToWidth(text + (focused && choices > 1 ? cycleHint : ""), innerWidth, ""));
  };
  const labelFor = (field: ScheduledFormField, label: string) => form.focused === field ? `${BOLD}${label}${RESET}` : `${DIM}${label}${RESET}`;
  const note = (text: string, color = DIM) => wordWrapLines(text, innerWidth - 2).map(line => `  ${color}${line}${RESET}`);

  const machines = form.machines();
  const machine = machines.find(m => m.id === form.machine) ?? machines[0]!;
  cycler("machine", "Machine", machineLabel(machine), machines.length);
  const { repos, why } = form.repoChoices(form.machine);
  cycler("repo", "Repo", scheduledFormRepo(form) ?? `${DIM}(none)${RESET}`, repos.length);
  if (why !== null) lines.push(...note(why, RED));
  cycler("agentType", "Type", form.agentType, form.availableTypes.length);
  lines.push("");

  const cursor = form.focused === "cron" ? "█" : "";
  lines.push(truncateToWidth(`${labelFor("cron", "Schedule:")} ${form.cron}${cursor}`, innerWidth, ""));
  lines.push(...note(SCHEDULE_FORMAT_HINT));
  const problem = cronProblem(form.cron);
  const next = problem === null ? nextFireTime(form.cron, Date.now()) : null;
  lines.push(...(next === null ? note(problem ?? "Schedule never fires", RED) : [`  next: ${formatFireTime(next)}`]));

  // No blank line before Auto-retire: the form must fit a 24-row terminal (SPEC §11.5) with an error shown.
  const box = `[${form.autoRetire ? "x" : " "}] Auto-retire`;
  lines.push(form.focused === "autoRetire" ? `${BOLD}${GREEN}${box}${RESET} ${DIM}(Space/Enter toggles)${RESET}` : box);
  lines.push(...note(AUTO_RETIRE_NOTE));
  lines.push("");

  lines.push(form.focused === "prompt" ? `${BOLD}Prompt:${RESET} ${DIM}(required)${RESET}` : `${DIM}Prompt: (required)${RESET}`);
  const { outputLines, hasScrollIndicator } = renderTextareaBlock(form.buffer, innerWidth, form.focused === "prompt");
  lines.push(...outputLines);
  if (hasScrollIndicator) lines.push(`${DIM}↑${RESET}`);

  const saveEnabled = repos.length > 0;
  const save = form.focused === "save"
    ? `${BOLD}${saveEnabled ? GREEN : DIM}[ Save ]${RESET}`
    : saveEnabled ? "[ Save ]" : `${DIM}[ Save ]${RESET}`;
  const cancel = form.focused === "cancel" ? `${BOLD}${GREEN}[ Cancel ]${RESET}` : "[ Cancel ]";
  lines.push(`  ${cancel}   ${save}`);
  if (form.saving) lines.push(`${DIM}Saving…${RESET}`);
  if (form.error) lines.push(...wordWrapLines(form.error, innerWidth).map(line => `${RED}${line}${RESET}`));
  return { title: form.task ? "Edit Scheduled Task" : "New Scheduled Task", contentLines: lines };
}

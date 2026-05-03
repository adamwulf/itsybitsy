/**
 * System coordinator configuration, prompt, permissions, and lifecycle.
 * Per-repo coordinator settings, prompt, and lifecycle.
 * See SPEC.md §12.1 (system) and §12.2 (per-repo) for the full specification.
 */

import { join, basename } from "path";
import { homedir } from "os";
import { readFileSync, existsSync } from "node:fs";
import { readConfig } from "./config";
import { captureTmuxOutput, resizeTmuxWindow } from "./tmux-poller";
import { isCompacting, isRateLimited } from "./agents";
import { SpawnContext } from "./types";
import { getTmuxWidthForAgent } from "./tui/widths";
import { loadAgentType, ensureAgentTypesDir } from "./agent-types";
import { isValidSessionId, isValidModel } from "./validation";

/**
 * Encode an absolute path into Claude's project-directory naming scheme:
 * replace both `/` and `.` with `-`. Inlined here (rather than importing from
 * auto-compact) because both modules need the same encoding without a
 * cross-domain dependency.
 */
function encodeClaudeProjectPath(p: string): string {
  return p.replace(/[/.]/g, "-");
}

export const IB_COORDINATOR_SESSION = "ib-coordinator";

/** Spawn context for coordinator operations — injectable for testing. */
export const coordinatorSpawnCtx = new SpawnContext();

/** Sleep function — injectable for testing. */
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

export function setCoordinatorSleepFn(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}

export function resetCoordinatorSleepFn(): void {
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
}

/** Override the itsybitsy home directory for testing. */
let overrideHome: string | undefined;

export function setCoordinatorHome(path: string): void {
  overrideHome = path;
}

export function resetCoordinatorHome(): void {
  overrideHome = undefined;
}

function itsybitsyHome(): string {
  return overrideHome ?? join(process.env.HOME ?? homedir(), ".itsybitsy");
}

/**
 * Public accessor for the system coordinator's home directory (`~/.itsybitsy/`).
 * Used by `ib new-agent` to recognize when its CWD is the system coordinator
 * and stamp the new agent's `spawned_by` with the `@system` sentinel.
 * Honors the test override set via `setCoordinatorHome`.
 */
export function getCoordinatorHome(): string {
  return itsybitsyHome();
}

function refsPath(): string {
  return join(itsybitsyHome(), "coordinator.refs");
}

function clearedMarkerPath(): string {
  return join(itsybitsyHome(), "coordinator-session.cleared");
}

function coordinatorTranscriptDir(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".claude", "projects", encodeClaudeProjectPath(itsybitsyHome()));
}

/**
 * Cleared-marker timestamp (ms epoch). Transcripts with mtime <= this value
 * are ignored when resuming — that's how `x` says "everything before now
 * is dead." Returns 0 when no marker exists.
 */
async function readClearedMarker(): Promise<number> {
  try {
    const file = Bun.file(clearedMarkerPath());
    if (!(await file.exists())) return 0;
    const raw = (await file.text()).trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Write the cleared-marker so subsequent resumes ignore prior transcripts. */
async function writeClearedMarker(): Promise<void> {
  await Bun.write(clearedMarkerPath(), String(Date.now()) + "\n");
}

/**
 * Returns the session id of the newest non-cleared transcript, or null.
 * Picking the newest each time (rather than persisting an id) sidesteps
 * Claude's mid-conversation session-id rotation.
 */
async function findLatestCoordinatorTranscriptId(): Promise<string | null> {
  const dir = coordinatorTranscriptDir();
  const clearedAt = await readClearedMarker();
  let entries: { id: string; mtimeMs: number }[];
  try {
    const { readdir, stat } = await import("fs/promises");
    const names = await readdir(dir);
    entries = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!isValidSessionId(id)) continue;
      try {
        const s = await stat(join(dir, name));
        if (s.mtimeMs <= clearedAt) continue;
        entries.push({ id, mtimeMs: s.mtimeMs });
      } catch { /* skip */ }
    }
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0]!.id;
}

/**
 * Initial prompt text for the system coordinator (SPEC §12.1.5).
 * Injected as additionalContext by the SessionStart hook on every session
 * start (fresh and resumed). See `src/hooks/session-start.ts`.
 */
export const SYSTEM_COORDINATOR_PROMPT = `You are the itsybitsy system coordinator. You manage agents across all registered repos using \`ib\` commands. You can list agents (\`ib list\`), send messages to agents (\`ib send <agent-id> "message"\`), merge (\`ib merge\`), kill (\`ib kill\`), create agents (\`ib new-agent\`), and check status (\`ib status\`, \`ib diff\`). You do NOT have access to Read, Write, Edit, or any file tools — only \`ib\` Bash commands. You coordinate work at the system level — for repo-specific coordination, delegate to per-repo coordinators. To send messages to per-repo coordinators, use \`ib send @<repo-name> "message"\` (e.g., \`ib send @itsybitsy "review the latest PR"\`). Do NOT use \`ib send @system\` — that routes back to you.`;

/**
 * Hardcoded allow list for the system coordinator.
 * Only ib commands and ToolSearch are permitted.
 */
const SYSTEM_COORDINATOR_ALLOW = ["Bash(ib:*)", "ToolSearch"];

/**
 * Hardcoded deny list for the system coordinator.
 * Blocks all file access, web access, and agent spawning tools.
 * Note: unqualified "Bash" is NOT denied here — Claude Code's permission
 * resolution removes the entire Bash tool when "Bash" appears in deny,
 * which prevents the qualified "Bash(ib:*)" allow from working. Instead,
 * only Bash(ib:*) is in the allow list, so non-ib commands require manual
 * approval (which effectively blocks them in the unattended tmux session).
 */
const SYSTEM_COORDINATOR_DENY = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "TaskCreate",
  "TaskOutput",
  "Agent",
  "KillShell",
  "EnterPlanMode",
  "ExitPlanMode",
];

/**
 * Build the settings.local.json content for the system coordinator.
 *
 * Layer merge: the hardcoded SYSTEM_COORDINATOR_ALLOW/DENY constants are the
 * floor. The `_all.md` and `system.md` agent-type layer files contribute
 * additional allow/deny entries via their frontmatter; any allow entry that
 * appears in SYSTEM_COORDINATOR_DENY is silently dropped so a layer can never
 * override the hardcoded denies. Deny lists are unioned. The result is
 * deduplicated via Set.
 *
 * Per-repo coordinator permissions live in
 * ~/.itsybitsy/agent-types/coordinator.md and are not read here.
 */
export async function buildSystemCoordinatorSettings(): Promise<{
  permissions: { allow: string[]; deny: string[] };
}> {
  // Ensure the embedded layer files exist on disk
  try {
    await ensureAgentTypesDir();
  } catch {
    // If this fails, fall through — loadAgentType will throw and we'll skip the layer
  }

  // Load _all.md permissions layer (applies to every agent, including system coordinator)
  let allAllow: string[] = [];
  let allDeny: string[] = [];
  try {
    const allLayer = await loadAgentType("_all");
    allAllow = allLayer.permissions?.allow ?? [];
    allDeny = allLayer.permissions?.deny ?? [];
  } catch (err) {
    console.error(`Warning: failed to load _all agent type layer: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Load system.md permissions layer (system-coordinator-specific overrides)
  let systemAllow: string[] = [];
  let systemDeny: string[] = [];
  try {
    const systemLayer = await loadAgentType("system");
    systemAllow = systemLayer.permissions?.allow ?? [];
    systemDeny = systemLayer.permissions?.deny ?? [];
  } catch (err) {
    console.error(`Warning: failed to load system agent type layer: ${err instanceof Error ? err.message : String(err)}`);
  }

  const hardcodedDenySet = new Set(SYSTEM_COORDINATOR_DENY);

  // Filter out layer allow entries that conflict with hardcoded deny
  const filteredAllAllow = allAllow.filter((entry) => !hardcodedDenySet.has(entry));
  const filteredSystemAllow = systemAllow.filter((entry) => !hardcodedDenySet.has(entry));

  const finalAllow = [
    ...new Set([...SYSTEM_COORDINATOR_ALLOW, ...filteredAllAllow, ...filteredSystemAllow]),
  ];
  const finalDeny = [
    ...new Set([...SYSTEM_COORDINATOR_DENY, ...allDeny, ...systemDeny]),
  ];

  return { permissions: { allow: finalAllow, deny: finalDeny } };
}

/**
 * Strip control characters that could inject tmux key sequences.
 * Removes all chars with code points < 0x20 (C0 controls) and 0x7F (DEL).
 * This prevents Ctrl-C/D/Escape injection via tmux send-keys -l.
 */
export function sanitizeTmuxInput(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      result += text[i];
    }
  }
  return result;
}

/** Check if the ib-coordinator tmux session exists. */
async function tmuxSessionExists(): Promise<boolean> {
  const { exitCode } = await coordinatorSpawnCtx.run([
    "tmux", "has-session", "-t", IB_COORDINATOR_SESSION,
  ]);
  return exitCode === 0;
}

/**
 * Poll the ib-coordinator tmux session until Claude's UI is ready.
 * Mirrors the readiness pattern used by autoAcceptWorkspaceTrustForNewAgent in
 * ib-commands.ts: capture the pane every 500ms and look for the Claude logo
 * (`Claude Code v`) or a previously-injected user task marker (`[USER TASK]`).
 *
 * Returns true once the readiness marker appears, false if the poll exhausts
 * its attempt budget (~15s).
 */
export async function waitForCoordinatorReady(): Promise<boolean> {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await sleepFn(500);
    const output = await captureTmuxOutput(IB_COORDINATOR_SESSION, 200);
    if (output === null) continue;
    if (output.includes("Claude Code v") || output.includes("[USER TASK]")) {
      return true;
    }
  }
  return false;
}

/**
 * Ensure ~/.itsybitsy/ exists and is a git repo.
 * Creates directory, runs git init, writes .gitignore with '*'.
 */
async function ensureHomeRepo(): Promise<void> {
  const home = itsybitsyHome();
  const { mkdir } = await import("fs/promises");
  await mkdir(home, { recursive: true });

  // Check if already a git repo
  const { exitCode } = await coordinatorSpawnCtx.run([
    "git", "-C", home, "rev-parse", "--git-dir",
  ]);
  if (exitCode !== 0) {
    await coordinatorSpawnCtx.run(["git", "init", home]);
  }

  // Write .gitignore with '*' to prevent accidental commits
  const gitignorePath = join(home, ".gitignore");
  await Bun.write(gitignorePath, "*\n");
}

/**
 * Write settings.local.json and coordinator-prompt.txt to ~/.itsybitsy/.
 *
 * The settings file includes the four agent hooks (path-check, intercept-task,
 * permission-denied, session-start), all keyed to the `@system` sentinel agent
 * ID. The Stop hook is intentionally omitted — the system coordinator has its
 * own state detection in `detectSystemCoordinatorState()`.
 *
 * `spinnerTipsEnabled: false` matches per-repo coordinators (see
 * `src/ib-commands.ts`, the `coordinatorMode` branch).
 */
async function writeCoordinatorFiles(): Promise<void> {
  const home = itsybitsyHome();
  const { mkdir } = await import("fs/promises");

  // Write .claude/settings.local.json
  const claudeDir = join(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");
  const baseSettings = await buildSystemCoordinatorSettings();
  // The literal "@system" appears in the hook command strings on purpose: the
  // settings file is consumed by Claude Code (which invokes these as
  // command-line args), not by TS code that could read SYSTEM_AGENT_ID. Both
  // values must stay in sync — see `src/hooks/shared.ts` (SYSTEM_AGENT_ID),
  // `src/index.ts` (hook-check-path / hook-permission-denied entry points),
  // and `src/hooks/session-start.ts` (agentIdArg branch).
  const settings = {
    ...baseSettings,
    spinnerTipsEnabled: false,
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "ib hook-check-path @system" }] },
        { matcher: "Task|Agent|TaskCreate|Bash|AskUserQuestion", hooks: [{ type: "command", command: "ib hooks intercept-task" }] },
      ],
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: "ib hook-permission-denied @system" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start @system" }] }],
    },
  };
  await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // Write coordinator-prompt.txt
  const promptPath = join(home, "coordinator-prompt.txt");
  await Bun.write(promptPath, SYSTEM_COORDINATOR_PROMPT + "\n");
}

/**
 * - "existing": the tmux session was already alive — nothing was launched.
 * - "resumed": `claude --resume <id>` ran and reached the ready marker.
 * - "fresh":   a fresh `claude` session was launched. The SessionStart hook
 *              injects SYSTEM_COORDINATOR_PROMPT as additionalContext.
 */
export type CoordinatorSpawnMode = "existing" | "resumed" | "fresh";
let lastSpawnMode: CoordinatorSpawnMode = "existing";
export function getLastCoordinatorSpawnMode(): CoordinatorSpawnMode {
  return lastSpawnMode;
}

/**
 * Ensure the system coordinator tmux session is running. If alive, returns
 * immediately. Otherwise launches Claude — resuming the newest non-cleared
 * transcript when one exists, falling back to a fresh launch otherwise. The
 * SessionStart hook injects SYSTEM_COORDINATOR_PROMPT as additionalContext on
 * every session start (fresh and resumed), so no prompt paste happens here.
 * If `--resume` is attempted but Claude's UI never reaches the ready marker,
 * the session is killed, the cleared-marker is written, and a single
 * fresh-launch retry runs.
 */
export async function ensureSystemCoordinator(): Promise<string> {
  return await ensureSystemCoordinatorImpl(false);
}

async function ensureSystemCoordinatorImpl(retryAfterResumeFailure: boolean): Promise<string> {
  if (await tmuxSessionExists()) {
    lastSpawnMode = "existing";
    return IB_COORDINATOR_SESSION;
  }

  const home = itsybitsyHome();

  await ensureHomeRepo();
  await writeCoordinatorFiles();

  // One-shot cleanup of the old file-based inbox directory (now unused).
  await (await import("fs/promises")).rm(join(home, "coordinator-inbox"), { recursive: true, force: true }).catch(() => {});

  // Create tmux session — use mainWidth (full middle+right area) so it matches the coordinator rendering
  const coordTmuxWidth = await getTmuxWidthForAgent(true);
  const { exitCode } = await coordinatorSpawnCtx.run([
    "tmux", "new-session", "-d", "-x", String(coordTmuxWidth), "-s", IB_COORDINATOR_SESSION, "-c", home,
  ]);

  if (exitCode !== 0) {
    // TOCTOU: another instance created the session — that's fine
    if (await tmuxSessionExists()) {
      lastSpawnMode = "existing";
      return IB_COORDINATOR_SESSION;
    }
    throw new Error("Failed to create system coordinator tmux session");
  }
  await coordinatorSpawnCtx.run(["tmux", "set-option", "-w", "-t", IB_COORDINATOR_SESSION, "history-limit", "50000"]);
  // window-size manual prevents tmux from auto-resizing the window to the
  // latest attached client's terminal size. The dashboard sizes the session
  // to the rendered pane width; the default ("latest") would silently shrink
  // it back when other clients attach/detach.
  await coordinatorSpawnCtx.run(["tmux", "set-option", "-w", "-t", IB_COORDINATOR_SESSION, "window-size", "manual"]);

  const config = await readConfig();
  const rawModel = (config["coordinator.model"]?.value as string) ?? "opus";
  // Reject malformed model names — they would otherwise be interpolated into
  // the shell command below.
  const model = isValidModel(rawModel) ? rawModel : "opus";
  const imessage = config["coordinator.imessage"]?.value === true;

  // Resume the newest non-cleared transcript. Skip on the post-failure retry
  // so a single bad transcript can't trap us in an infinite loop.
  const resumeId = retryAfterResumeFailure ? null : await findLatestCoordinatorTranscriptId();

  const channels: string[] = [];
  if (imessage) channels.push("plugin:imessage@claude-plugins-official");
  const baseCmd = resumeId
    ? `claude --resume ${resumeId} --model ${model}`
    : `claude --model ${model}`;
  const claudeCmd = channels.length > 0
    ? `${baseCmd} --channels ${channels.join(" ")}`
    : baseCmd;
  await coordinatorSpawnCtx.run([
    "tmux", "send-keys", "-t", IB_COORDINATOR_SESSION,
    claudeCmd, "Enter",
  ]);

  // Wait for Claude's UI to be ready so the resume-failure fallback below
  // can detect the case where `claude --resume` never reaches the marker
  // (corrupt or version-mismatched transcript) and recover with a fresh
  // launch. The SessionStart hook supplies the prompt itself.
  const ready = await waitForCoordinatorReady();

  if (resumeId && !ready) {
    // Resume failed (likely a corrupt or version-mismatched transcript). Kill
    // the dead session, write the cleared marker so this transcript is
    // skipped, and retry once as a fresh launch.
    await coordinatorSpawnCtx.run(["tmux", "kill-session", "-t", IB_COORDINATOR_SESSION]);
    await writeClearedMarker();
    return await ensureSystemCoordinatorImpl(true);
  }

  // The SessionStart hook injects SYSTEM_COORDINATOR_PROMPT as additionalContext
  // on every session start (fresh and resumed). Nothing to paste here — just
  // record the spawn mode so callers can tell what happened.
  lastSpawnMode = resumeId ? "resumed" : "fresh";

  return IB_COORDINATOR_SESSION;
}

/**
 * Read live PIDs from the coordinator.refs file.
 * Returns an array of PIDs that are currently alive.
 */
async function readLivePids(): Promise<number[]> {
  const path = refsPath();
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const content = await file.text();
    const pids = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => parseInt(l, 10))
      .filter((n) => !isNaN(n));

    // Prune stale PIDs
    return pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Atomically write PIDs to the refs file (write temp → rename).
 */
async function writePidsAtomic(pids: number[]): Promise<void> {
  const path = refsPath();
  const tmpPath = path + ".tmp." + process.pid;
  const content = pids.map((p) => String(p)).join("\n") + "\n";
  await Bun.write(tmpPath, content);
  const { rename } = await import("fs/promises");
  await rename(tmpPath, path);
}

/**
 * Acquire a reference to the system coordinator.
 * Appends the current process PID to coordinator.refs after pruning stale PIDs.
 */
export async function acquireSystemCoordinator(): Promise<void> {
  const livePids = await readLivePids();
  const myPid = process.pid;
  if (!livePids.includes(myPid)) {
    livePids.push(myPid);
  }
  await writePidsAtomic(livePids);
}

/**
 * Release a reference to the system coordinator.
 * Removes the current process PID from coordinator.refs.
 * If no live PIDs remain, calls onLastRef (if provided) then kills the tmux session.
 */
export async function releaseSystemCoordinator(
  onLastRef?: () => Promise<void>
): Promise<void> {
  const livePids = await readLivePids();
  const myPid = process.pid;
  const remaining = livePids.filter((pid) => pid !== myPid);
  await writePidsAtomic(remaining);

  if (remaining.length === 0) {
    if (onLastRef) {
      await onLastRef();
    }
    await coordinatorSpawnCtx.run([
      "tmux", "kill-session", "-t", IB_COORDINATOR_SESSION,
    ]);
  }
}

/** Restart the system coordinator — kill the tmux session and re-create. */
export async function restartSystemCoordinator(): Promise<void> {
  await coordinatorSpawnCtx.run([
    "tmux", "kill-session", "-t", IB_COORDINATOR_SESSION,
  ]);
  await ensureSystemCoordinator();
}

/**
 * Discard the system coordinator: kill its tmux session, write the cleared
 * marker so prior transcripts are ignored on the next launch, and remove the
 * current process PID from coordinator.refs (so a stale ref doesn't keep the
 * tmux session "logically alive" for the next acquire).
 *
 * Used by the dashboard `x` action on the system coordinator. Distinct from
 * `restartSystemCoordinator` (which resumes the prior session).
 */
export async function discardSystemCoordinator(): Promise<void> {
  await coordinatorSpawnCtx.run([
    "tmux", "kill-session", "-t", IB_COORDINATOR_SESSION,
  ]);
  await writeClearedMarker();
  const livePids = await readLivePids();
  const remaining = livePids.filter((pid) => pid !== process.pid);
  await writePidsAtomic(remaining);
}

export type CoordinatorState = "stopped" | "compacting" | "rate_limited" | "running";

/**
 * Detect the system coordinator's current state from tmux output.
 * See SPEC.md §12.1.6 for priority order.
 */
export async function detectSystemCoordinatorState(): Promise<CoordinatorState> {
  // No session → stopped
  if (!(await tmuxSessionExists())) {
    return "stopped";
  }

  // Capture tmux output — only the last 50 lines are inspected (compacting:
  // last 5, rate_limited: last 15), so request just 50 to avoid the default
  // 5000-line capture cost.
  const output = await captureTmuxOutput(IB_COORDINATOR_SESSION, 50);
  if (output === null) {
    return "stopped";
  }

  // Compacting in last 5 lines
  if (isCompacting(output)) {
    return "compacting";
  }

  // Rate limited in last 15 lines
  if (isRateLimited(output)) {
    return "rate_limited";
  }

  return "running";
}

/**
 * Resize the system coordinator's tmux window to the given width.
 * Called when the sidebar width changes so the coordinator output
 * wraps at the correct column count.
 */
export async function resizeCoordinatorTmux(width: number): Promise<void> {
  await resizeTmuxWindow(IB_COORDINATOR_SESSION, width);
}

// ---------------------------------------------------------------------------
// Per-repo coordinator support (SPEC §12.2)
// ---------------------------------------------------------------------------

/**
 * Hardcoded allow list for per-repo coordinators (SPEC §12.2.4).
 * Read-only file access + ib commands + read-only git commands.
 */
const PER_REPO_COORDINATOR_ALLOW = [
  "Bash(ib:*)",
  "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
  "Bash(git show:*)", "Bash(git ls-files:*)",
  "Bash(pwd:*)", "Bash(ls:*)",
  "Read", "Glob", "Grep", "LS",
  "TodoWrite", "ToolSearch",
];

/**
 * Hardcoded deny list for per-repo coordinators (SPEC §12.2.4).
 * Blocks all file writes, web access, and agent spawning via built-in tools.
 * Note: unqualified "Bash" is NOT denied — see SYSTEM_COORDINATOR_DENY comment.
 */
const PER_REPO_COORDINATOR_DENY = [
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "WebFetch", "WebSearch", "Task", "TaskCreate", "TaskOutput", "Agent", "KillShell",
  "EnterPlanMode", "ExitPlanMode",
];

/**
 * Build the settings permissions for a per-repo coordinator.
 * Coordinators can read the codebase and run ib commands, but cannot write code.
 * See SPEC §12.2.4 for the full specification.
 *
 * Layer merge: the hardcoded PER_REPO_COORDINATOR_ALLOW/DENY constants are the
 * floor. The `_all.md` and `coordinator.md` agent-type layer files contribute
 * additional allow/deny entries via their frontmatter; any allow entry that
 * appears in PER_REPO_COORDINATOR_DENY is silently dropped so a layer can
 * never override the hardcoded denies. Deny lists are unioned. The result is
 * deduplicated via Set.
 *
 * Note: `_non_coordinator.md` is intentionally NOT merged — per-repo
 * coordinators are coordinators.
 */
export async function buildPerRepoCoordinatorSettings(): Promise<{
  permissions: { allow: string[]; deny: string[] };
}> {
  // Ensure the embedded layer files exist on disk
  try {
    await ensureAgentTypesDir();
  } catch {
    // If this fails, fall through — loadAgentType will throw and we'll skip the layer
  }

  // Load _all.md permissions layer (applies to every agent)
  let allAllow: string[] = [];
  let allDeny: string[] = [];
  try {
    const allLayer = await loadAgentType("_all");
    allAllow = allLayer.permissions?.allow ?? [];
    allDeny = allLayer.permissions?.deny ?? [];
  } catch (err) {
    console.error(`Warning: failed to load _all agent type layer: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Load coordinator.md permissions layer (per-repo coordinator-specific permissions)
  let coordAllow: string[] = [];
  let coordDeny: string[] = [];
  try {
    const coordLayer = await loadAgentType("coordinator");
    coordAllow = coordLayer.permissions?.allow ?? [];
    coordDeny = coordLayer.permissions?.deny ?? [];
  } catch (err) {
    console.error(`Warning: failed to load coordinator agent type layer: ${err instanceof Error ? err.message : String(err)}`);
  }

  const hardcodedDenySet = new Set(PER_REPO_COORDINATOR_DENY);

  // Filter out layer allow entries that conflict with hardcoded deny
  const filteredAllAllow = allAllow.filter((entry) => !hardcodedDenySet.has(entry));
  const filteredCoordAllow = coordAllow.filter((entry) => !hardcodedDenySet.has(entry));

  const finalAllow = [
    ...new Set([...PER_REPO_COORDINATOR_ALLOW, ...filteredAllAllow, ...filteredCoordAllow]),
  ];
  const finalDeny = [
    ...new Set([...PER_REPO_COORDINATOR_DENY, ...allDeny, ...coordDeny]),
  ];

  return { permissions: { allow: finalAllow, deny: finalDeny } };
}

/**
 * Per-repo coordinator session start prompt (SPEC §12.2.6).
 * Parameterized with the repo name.
 */
export function perRepoCoordinatorPrompt(repoName: string): string {
  return `You are a per-repo coordinator for the \`${repoName}\` repository. Your agent ID is \`${repoName}\`. You can read files and code in this repo using Read, Glob, Grep, and LS. You coordinate work by spawning and managing worker agents using \`ib\` commands. You do NOT write code directly — instead, spawn worker agents with \`ib new-agent --type worker "task"\` to implement changes. Review their work with \`ib diff <id>\` and merge with \`ib merge <id>\`. To send messages to the system coordinator, use \`ib send @system "message"\`. Workers send messages to you with \`ib send @coordinator "message"\`. When sending messages that contain shell metacharacters like \`$(...)\`, backticks, or \`$VAR\`, use single quotes (\`ib send <id> 'literal $(foo)'\`), escape with backslash, or pipe via a quoted heredoc (\`ib send <id> <<'EOF'\\n...\\nEOF\`) — the shell expands these inside double quotes before \`ib\` receives them.`;
}

/**
 * Determine the coordinator agent ID for a repo.
 * Uses the repo basename (e.g., "muse-ios" for /Users/adam/Developer/muse-ios).
 * This enables `ib send muse-ios "message"` for consistent messaging.
 */
export function getCoordinatorAgentId(repoPath: string): string {
  return basename(repoPath);
}

/**
 * Check if a coordinator already exists for a repo.
 * Scans all agents in the repo for one with coordinator:true in meta.json.
 * Also checks whether a non-coordinator agent with the repo basename already exists (collision).
 *
 * Returns:
 *   { exists: true, isCoordinator: true, agentId: string } — coordinator found
 *   { exists: false, collision: true } — no coordinator, but basename-named non-coordinator agent exists
 *   { exists: false, collision: false } — no coordinator and no collision
 */
export async function checkCoordinatorExists(repoPath: string): Promise<
  | { exists: true; isCoordinator: true; agentId: string }
  | { exists: false; collision: boolean }
> {
  const agentsDir = join(repoPath, ".ittybitty", "agents");

  if (!existsSync(agentsDir)) {
    return { exists: false, collision: false };
  }

  const repoBasename = basename(repoPath);
  let hasCollision = false;

  try {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(agentsDir, entry.name, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const raw = readFileSync(metaPath, "utf8");
        const meta = JSON.parse(raw);
        if (meta.coordinator === true) {
          return { exists: true, isCoordinator: true, agentId: entry.name };
        }
        // Check for name collision with repo basename
        if (entry.name === repoBasename) {
          hasCollision = true;
        }
      } catch {
        // Can't parse — check name collision only
        if (entry.name === repoBasename) {
          hasCollision = true;
        }
      }
    }
  } catch {
    return { exists: false, collision: false };
  }

  return { exists: false, collision: hasCollision };
}

/**
 * Get the repo basename from a repo path.
 */
export function getRepoBasename(repoPath: string): string {
  return basename(repoPath);
}

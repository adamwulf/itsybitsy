/**
 * Phase 21b: Stop hook — agent nudging.
 * Detects agent state from last_assistant_message or tmux output,
 * then takes appropriate action (nudge, notify manager, remind commit, etc.).
 */

import { join, dirname } from "path";
import { readdir, readFile, writeFile, mkdir, access } from "fs/promises";
import { logAgent } from "../agent-lifecycle";
import { parseState } from "../parse-state";
import { captureTmuxOutput } from "../tmux-poller";
import { isValidAgentId, isValidTmuxSession } from "../validation";
import { writeAgentState, hasBackgroundTasks, isRecentlyCreated } from "../agents";
import type { MetaState } from "../agents";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StopHookResult {
  state: string;
  action:
    | "none"
    | "nudge"
    | "notify_manager"
    | "remind_commit"
    | "remind_children"
    | "debounced";
  message?: string;
}

export interface ProcessStopHookOpts {
  captureOutput?: () => Promise<string | null>;
  checkGitStatus?: () => Promise<string>;
  getChildState?: (tmuxSession: string) => Promise<string>;
  now?: number;
}

// ── detectStateFromMessage ───────────────────────────────────────────────────

/**
 * Detect state from last_assistant_message (pure function, no I/O).
 * Returns 'waiting', 'complete', or '' (empty = fall through).
 */
export function detectStateFromMessage(lastMessage: string): string {
  const lines = lastMessage.split("\n");
  // Find last non-empty line
  let lastLine = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed !== "") {
      lastLine = trimmed;
      break;
    }
  }

  if (lastLine === "WAITING") return "waiting";
  if (lastLine === "I HAVE COMPLETED THE GOAL") return "complete";
  return "";
}

// ── processStopHook ──────────────────────────────────────────────────────────

/**
 * Core testable logic for the stop hook.
 * Uses deterministic state from last_assistant_message exclusively — no tmux fallback.
 */
export async function processStopHook(
  agentId: string,
  lastMessage: string,
  agentDir: string,
  agentsDir: string,
  opts?: ProcessStopHookOpts,
): Promise<StopHookResult> {
  // 1. Determine state from last_assistant_message
  const detected = detectStateFromMessage(lastMessage);
  const state: MetaState = detected === "waiting" ? "waiting"
    : detected === "complete" ? "complete"
    : "running";

  // 2. Write state to meta.json (deterministic — always writes)
  await writeAgentState(agentDir, state);

  // 3. Save debug capture
  try {
    const debugDir = join(agentDir, "debug-logs");
    await mkdir(debugDir, { recursive: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const debugPath = join(debugDir, `stop-${timestamp}-${state}.txt`);
    const debugParts: string[] = [];
    debugParts.push("--- deterministic state ---");
    debugParts.push(`${state} (from last_assistant_message)`);
    debugParts.push("");
    debugParts.push("--- last_assistant_message ---");
    debugParts.push(lastMessage || "(no message)");
    await writeFile(debugPath, debugParts.join("\n"));
  } catch {
    /* ignore debug write failures */
  }

  // 4. Log
  await logAgent(agentDir, `[hook] Stop hook triggered, state=${state}`);

  // ── State actions ──────────────────────────────────────────────────────

  if (state === "running") {
    // Check for background tasks (⏵⏵ pattern in recent tmux output).
    let bgOutput: string | null = null;
    if (opts?.captureOutput) {
      bgOutput = await opts.captureOutput();
    } else {
      try {
        const metaPath = join(agentDir, "meta.json");
        const metaRaw = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaRaw);
        if (meta.tmux_session) {
          if (!isValidTmuxSession(meta.tmux_session)) {
            console.error(`[agent-status] Invalid tmux session name: ${meta.tmux_session}`);
          } else {
            bgOutput = await captureTmuxOutput(meta.tmux_session, 15);
          }
        }
      } catch { /* ignore */ }
    }
    if (bgOutput && hasBackgroundTasks(bgOutput)) {
      return { state, action: "none" };
    }
    // Fall through to nudge handling below
  }

  if (state === "running") {
    return await handleNudge(agentId, agentDir, state, opts?.now);
  }

  if (state === "complete") {
    // Check uncommitted changes
    let porcelain = "";
    if (opts?.checkGitStatus) {
      porcelain = await opts.checkGitStatus();
    } else {
      try {
        const repoDir = join(agentDir, "repo");
        const proc = Bun.spawn(
          ["git", "-C", repoDir, "status", "--porcelain"],
          { stdout: "pipe", stderr: "pipe" },
        );
        porcelain = await new Response(proc.stdout).text();
        await proc.exited;
      } catch {
        /* ignore */
      }
    }

    if (porcelain.trim() !== "") {
      return {
        state,
        action: "remind_commit",
        message:
          "You have uncommitted changes. Please commit your work using git add && git commit before completing.",
      };
    }

    // Read meta.json manager field
    const meta = await readMeta(agentDir);

    if (meta?.manager && await isManagerActive(agentsDir, meta.manager)) {
      return {
        state,
        action: "notify_manager",
        message: `[hook]: Your subtask ${agentId} just completed`,
      };
    }

    // No manager (or manager is archived/missing) — check for unfinished children
    const unfinishedChildren = await findUnfinishedChildren(
      agentsDir,
      agentId,
      opts?.getChildState ? { getChildState: opts.getChildState } : undefined,
    );
    if (unfinishedChildren.length > 0) {
      const childCount = unfinishedChildren.length;
      const childList = unfinishedChildren.join(", ");
      return {
        state,
        action: "remind_children",
        message: `You have ${childCount} unfinished sub-agent(s) that need attention: ${childList}. Before you can complete, you must merge or kill each sub-agent using 'ib merge <id>' or 'ib kill <id>'. Use 'ib list' to check their status, 'ib look <id>' to see their output, 'ib status <id>' for their commits, and 'ib diff <id>' to review their changes.`,
      };
    }

    return { state, action: "none" };
  }

  if (state === "waiting") {
    const meta = await readMeta(agentDir);

    if (meta?.manager && await isManagerActive(agentsDir, meta.manager)) {
      return {
        state,
        action: "notify_manager",
        message: `[hook]: Your subtask ${agentId} is now waiting for input`,
      };
    }

    return { state, action: "none" };
  }

  // All other states
  return { state, action: "none" };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function handleNudge(
  agentId: string,
  agentDir: string,
  state: string,
  now?: number,
): Promise<StopHookResult> {
  const nudgePath = join(agentDir, "last-nudge");
  const currentTime = now ?? Math.floor(Date.now() / 1000);

  // Read last-nudge timestamp
  let lastNudgeTime = 0;
  try {
    const content = await readFile(nudgePath, "utf-8");
    lastNudgeTime = parseInt(content.trim(), 10);
    if (isNaN(lastNudgeTime)) lastNudgeTime = 0;
  } catch {
    /* file doesn't exist */
  }

  // Debounce: less than 5s since last nudge
  if (lastNudgeTime > 0 && currentTime - lastNudgeTime < 5) {
    return { state, action: "debounced" };
  }

  // Write current timestamp
  try {
    await writeFile(nudgePath, String(currentTime));
  } catch {
    /* ignore */
  }

  return {
    state,
    action: "nudge",
    message:
      "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line.",
  };
}

async function readMeta(
  agentDir: string,
): Promise<{ manager?: string; tmux_session?: string; archived?: boolean } | null> {
  try {
    const metaPath = join(agentDir, "meta.json");
    const raw = await readFile(metaPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Check if a manager agent exists and is not archived.
 * Returns false if the manager's directory doesn't exist, meta.json is missing/malformed,
 * or the manager has been archived.
 */
async function isManagerActive(agentsDir: string, managerId: string): Promise<boolean> {
  const managerMeta = await readMeta(join(agentsDir, managerId));
  if (!managerMeta) return false;
  if (managerMeta.archived) return false;
  return true;
}

/** States stored in meta.json that count as "unfinished" */
const UNFINISHED_META_STATES = new Set(["running", "waiting", "complete"]);

/**
 * Find children of a parent agent that are still unfinished.
 * Uses meta.json state + tmux session existence (no full tmux parsing).
 * Unfinished = meta.json state is running/waiting/complete AND tmux session exists,
 * OR agent is recently created (< 6s).
 */
export async function findUnfinishedChildren(
  agentsDir: string,
  parentId: string,
  opts?: { getChildState?: (tmuxSession: string) => Promise<string> },
): Promise<string[]> {
  const unfinished: string[] = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childDir = join(agentsDir, entry.name);
      const metaPath = join(childDir, "meta.json");
      try {
        const raw = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(raw);
        if (meta.manager !== parentId) continue;
        if (meta.archived) continue;

        // Check if recently created (< 6s) — always unfinished
        if (isRecentlyCreated(meta.created_epoch)) {
          unfinished.push(entry.name);
          continue;
        }

        // For test injection: use getChildState if provided
        if (opts?.getChildState) {
          const tmuxSession = meta.tmux_session;
          if (tmuxSession && isValidTmuxSession(tmuxSession)) {
            const childState = await opts.getChildState(tmuxSession);
            if (UNFINISHED_META_STATES.has(childState) || childState === "creating") {
              unfinished.push(entry.name);
            }
          }
          continue;
        }

        // Check tmux session existence
        const tmuxSession = meta.tmux_session;
        if (!tmuxSession || !isValidTmuxSession(tmuxSession)) {
          // No tmux session → stopped → not unfinished
          continue;
        }

        const output = await captureTmuxOutput(tmuxSession);
        if (output === null) {
          // Tmux session doesn't exist → stopped → not unfinished
          continue;
        }

        // Tmux exists — read state from meta.json
        const metaState = meta.state;
        if (metaState && UNFINISHED_META_STATES.has(metaState)) {
          unfinished.push(entry.name);
        } else if (!metaState) {
          // Legacy: no state field, tmux exists → treat as running (unfinished)
          unfinished.push(entry.name);
        }
      } catch {
        /* skip malformed meta */
      }
    }
  } catch {
    /* agentsDir may not exist */
  }
  return unfinished;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI entry point for the stop hook.
 * Reads stdin JSON, processes the hook, and executes tmux actions.
 */
export async function hookStatus(agentId: string): Promise<void> {
  // Read stdin
  const stdinText = await new Response(Bun.stdin.stream()).text();
  let lastMessage = "";
  try {
    const parsed = JSON.parse(stdinText);
    lastMessage = parsed.last_assistant_message ?? "";
  } catch {
    /* stdin may not be valid JSON */
  }

  // Derive agentDir from cwd
  const cwd = process.cwd();
  let agentDir = "";
  let agentsDir = "";

  const agentMatch = cwd.match(/(.*\/.ittybitty\/agents\/[^/]+)/);
  if (agentMatch) {
    agentDir = agentMatch[1]!;
    agentsDir = dirname(agentDir);
  } else {
    // Construct from agentsDir pattern
    const ittybittyMatch = cwd.match(/(.*\/.ittybitty)/);
    if (ittybittyMatch) {
      agentsDir = join(ittybittyMatch[1]!, "agents");
      agentDir = join(agentsDir, agentId);
    } else {
      // Last resort
      console.log("unknown");
      return;
    }
  }

  const result = await processStopHook(
    agentId,
    lastMessage,
    agentDir,
    agentsDir,
  );

  // Schedule delayed recheck if debounced (31a)
  if (result.action === "debounced" && isValidAgentId(agentId)) {
    const recheckFile = join(agentDir, "nudge-recheck");
    let recheckExists = false;
    try {
      await access(recheckFile);
      recheckExists = true;
    } catch {
      /* doesn't exist */
    }
    if (!recheckExists) {
      try {
        await writeFile(recheckFile, "1");
        const proc = Bun.spawn(
          [
            "bash",
            "-c",
            `sleep 5 && rm -f "${recheckFile}" && ib hooks agent-status "${agentId}"`,
          ],
          { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
        );
        proc.unref();
      } catch {
        /* ignore spawn failures */
      }
    }
  }

  // Execute tmux actions and print state
  await executeResultActions(result, agentDir, agentsDir);
}

/**
 * Execute tmux actions based on the stop hook result.
 * Extracted from hookStatus for testability.
 * Returns "ok" on success, or an error string if validation fails.
 */
export async function executeResultActions(
  result: StopHookResult,
  agentDir: string,
  agentsDir: string,
): Promise<string> {
  const meta = await readMeta(agentDir);
  const tmuxSession = meta?.tmux_session as string | undefined;

  if (tmuxSession && !isValidTmuxSession(tmuxSession)) {
    console.error(`[agent-status] Invalid tmux session name: ${tmuxSession}`);
    console.log(result.state);
    return "invalid_session";
  }

  if (
    result.message &&
    (result.action === "nudge" ||
      result.action === "remind_commit" ||
      result.action === "remind_children")
  ) {
    if (tmuxSession) {
      const sendProc = Bun.spawn(
        ["tmux", "send-keys", "-t", tmuxSession, "-l", result.message],
        { stdout: "pipe", stderr: "pipe" },
      );
      await sendProc.exited;
      await Bun.sleep(100);
      const enterProc = Bun.spawn(
        ["tmux", "send-keys", "-t", tmuxSession, "Enter"],
        { stdout: "pipe", stderr: "pipe" },
      );
      await enterProc.exited;
    }
  } else if (result.action === "notify_manager" && result.message) {
    const managerId = meta?.manager as string | undefined;
    if (managerId) {
      if (!isValidAgentId(managerId)) {
        console.error(`Invalid manager agent ID: ${managerId}`);
        console.log(result.state);
        return `invalid_manager_id`;
      }
      const managerMeta = await readMeta(join(agentsDir, managerId));
      // Skip if manager is archived or missing
      if (!managerMeta || managerMeta.archived) {
        console.log(result.state);
        return "ok";
      }
      const managerSession = managerMeta?.tmux_session as string | undefined;
      if (managerSession) {
        if (!isValidTmuxSession(managerSession)) {
          console.error(`Invalid manager tmux session: ${managerSession}`);
          console.log(result.state);
          return `invalid_manager_session`;
        }
        const sendProc = Bun.spawn(
          ["tmux", "send-keys", "-t", managerSession, "-l", result.message],
          { stdout: "pipe", stderr: "pipe" },
        );
        await sendProc.exited;
        await Bun.sleep(100);
        const enterProc = Bun.spawn(
          ["tmux", "send-keys", "-t", managerSession, "Enter"],
          { stdout: "pipe", stderr: "pipe" },
        );
        await enterProc.exited;
      }
    }
  }

  // Print state to stdout
  console.log(result.state);
  return "ok";
}

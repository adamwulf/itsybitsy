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
import { isValidAgentId } from "../validation";

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
 */
export async function processStopHook(
  agentId: string,
  lastMessage: string,
  agentDir: string,
  agentsDir: string,
  opts?: ProcessStopHookOpts,
): Promise<StopHookResult> {
  // 1. Try detectStateFromMessage first
  let state = detectStateFromMessage(lastMessage);

  // 2. If empty, fall back to tmux
  // Keep tmuxOutput around for background task check later
  let tmuxOutput: string | null = null;
  let parseReason: string | undefined;
  if (!state) {
    if (opts?.captureOutput) {
      tmuxOutput = await opts.captureOutput();
    } else {
      // Read meta.json for tmux_session
      try {
        const metaPath = join(agentDir, "meta.json");
        const metaRaw = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaRaw);
        if (meta.tmux_session) {
          tmuxOutput = await captureTmuxOutput(meta.tmux_session);
        }
      } catch {
        /* meta.json may not exist */
      }
    }

    if (tmuxOutput) {
      const result = parseState(tmuxOutput);
      state = result.state;
      parseReason = result.reason;
    } else {
      state = "unknown";
    }
  }

  // 3. Save debug capture — include tmux output, parse-state reason, and last_assistant_message
  try {
    const debugDir = join(agentDir, "debug-logs");
    await mkdir(debugDir, { recursive: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const debugPath = join(debugDir, `stop-${timestamp}-${state}.txt`);
    const debugParts: string[] = [];
    if (tmuxOutput) {
      debugParts.push(tmuxOutput);
      debugParts.push("");
      debugParts.push("--- parse-state -v output ---");
      debugParts.push(`${state} (matched: ${parseReason ?? "n/a"})`);
      debugParts.push("");
    }
    debugParts.push("--- last_assistant_message ---");
    debugParts.push(lastMessage || "(no message)");
    await writeFile(debugPath, debugParts.join("\n"));
  } catch {
    /* ignore debug write failures */
  }

  // 4. Log
  await logAgent(agentDir, `[hook] Stop hook triggered, state=${state}`);

  // ── State actions ──────────────────────────────────────────────────────

  if (state === "rate_limited") {
    return { state, action: "none" };
  }

  if (state === "running") {
    // Check for background tasks (⏵⏵ pattern in recent tmux output).
    // The bash version checks for the full footer pattern: ⏵⏵.*·\s\d+\s
    let bgOutput = tmuxOutput;
    if (!bgOutput && opts?.captureOutput) {
      bgOutput = await opts.captureOutput();
    } else if (!bgOutput) {
      // Capture fresh for background task check
      try {
        const metaPath = join(agentDir, "meta.json");
        const metaRaw = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaRaw);
        if (meta.tmux_session) {
          bgOutput = await captureTmuxOutput(meta.tmux_session, 15);
        }
      } catch { /* ignore */ }
    }
    if (bgOutput && /⏵⏵.*·\s\d+\s/.test(bgOutput)) {
      return { state, action: "none" };
    }
    // Fall through to unknown/running handling below
  }

  if (state === "unknown" || state === "running") {
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

    if (meta?.manager) {
      return {
        state,
        action: "notify_manager",
        message: `[hook]: Your subtask ${agentId} just completed`,
      };
    }

    // No manager — check for unfinished children
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

    if (meta?.manager) {
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
): Promise<{ manager?: string; tmux_session?: string } | null> {
  try {
    const metaPath = join(agentDir, "meta.json");
    const raw = await readFile(metaPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** States that count as "unfinished" — these children need attention before parent can complete */
const UNFINISHED_STATES = new Set(["creating", "running", "waiting", "complete"]);

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
      const metaPath = join(agentsDir, entry.name, "meta.json");
      try {
        const raw = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(raw);
        if (meta.manager !== parentId) continue;
        if (meta.archived) continue;

        // Determine the child's actual state via tmux
        let childState = "unknown";
        const tmuxSession = meta.tmux_session;
        if (tmuxSession) {
          if (opts?.getChildState) {
            childState = await opts.getChildState(tmuxSession);
          } else {
            const output = await captureTmuxOutput(tmuxSession);
            if (output) {
              childState = parseState(output).state;
            }
            // output === null means no tmux session → stopped/unknown
          }
        }

        if (UNFINISHED_STATES.has(childState)) {
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

  // Execute tmux actions
  const meta = await readMeta(agentDir);
  const tmuxSession = meta?.tmux_session as string | undefined;

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
      const managerMeta = await readMeta(join(agentsDir, managerId));
      const managerSession = managerMeta?.tmux_session;
      if (managerSession) {
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
}

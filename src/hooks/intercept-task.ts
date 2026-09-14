/**
 * Hook: intercept Claude Task tool calls and spawn ib agents instead.
 */

import { join } from "path";
import { newAgent } from "../ib-commands";
import { checkGitDirectoryFlags, resolveAgentFromCwd, SYSTEM_AGENT_ID } from "./shared";
import { loadAgentType, metaCanSpawnChildren } from "../agent-types";
import { parseModel } from "../agent-cli";
import { findShellMetachar } from "./shell-metachar";
import { isValidAgentId } from "../validation";
import { resolveBoundHookAgent } from "./agent-context";

export interface InterceptResult {
  action: "skip" | "intercept";
  output?: object;
  spawnedAgentId?: string;
}

const SKIP_SUBAGENT_TYPES = [
  "Bash",
  "statusline-setup",
  "claude-code-guide",
  "meta-agent",
  "ib-merge",
];

interface InterceptAgentIdentity {
  agentId: string;
  agentDir: string;
  syntheticMeta?: Record<string, unknown>;
  /** Shared repository root for a validated worktree:false agent. */
  noWorktreeRepoPath?: string;
}

/**
 * Resolve the caller identity without trusting a model-controlled id by itself.
 * Existing worktree/system cwd resolution is used when no explicit identity is
 * supplied. An explicit id is authenticated against the registered agent and
 * its cwd/process identity, so it cannot fall back to a forged worktree shape
 * or let one agent invoke the hook as a sibling.
 */
async function resolveInterceptAgent(
  cwd: string,
  explicitAgentId?: string,
): Promise<InterceptAgentIdentity | null> {
  if (!explicitAgentId) return resolveAgentFromCwd(cwd);
  if (!isValidAgentId(explicitAgentId)) return null;

  let bound;
  try {
    bound = await resolveBoundHookAgent(explicitAgentId, cwd);
  } catch {
    return null;
  }
  return {
    agentId: explicitAgentId,
    agentDir: bound.agentDir,
    noWorktreeRepoPath: bound.meta.worktree === false ? bound.repoPath : undefined,
  };
}

/**
 * Validate a Task-tool-supplied model string. Empty (no override) is fine —
 * the spawn step inherits from agent-type / config. Non-empty values must be
 * the qualified `<cli>:<model>` form (D1/D5); anything else is silently
 * coerced to `""` so a malformed Task `model:` arg doesn't fail the spawn.
 */
function isAcceptableTaskModel(value: string): boolean {
  if (value === "") return true;
  try {
    parseModel(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if this is a Bash tool call from a coordinator session that contains
 * shell metacharacters or --output in git commands (SPEC §12.2.4).
 * Returns a deny result if blocked, or null to proceed normally.
 */
async function checkCoordinatorBashRestrictions(
  input: { tool_name: string; tool_input: Record<string, unknown>; cwd: string },
  resolved: InterceptAgentIdentity | null,
): Promise<InterceptResult | null> {
  if (input.tool_name !== "Bash") return null;

  // Resolve agent identity. The system coordinator's synthetic meta carries
  // `agentType: "system"`; per-repo coordinators have `agentType: "coordinator"`
  // on disk. Both should get the same restrictions (no shell metacharacters,
  // no --output, no -C/--git-dir/--work-tree).
  if (!resolved) return null;

  let agentType: string | undefined;
  if (resolved.syntheticMeta) {
    agentType = resolved.syntheticMeta.agentType as string | undefined;
  } else {
    try {
      const metaFile = Bun.file(join(resolved.agentDir, "meta.json"));
      if (await metaFile.exists()) {
        const meta = await metaFile.json();
        agentType = typeof meta.agentType === "string" ? meta.agentType : undefined;
      }
    } catch {
      // If we can't read meta, treat as not a coordinator
    }
  }

  const isCoordinator = agentType === "coordinator" || agentType === "system";
  if (!isCoordinator) return null;

  const command = (input.tool_input.command as string) ?? "";

  // Block shell metacharacters (quote- and heredoc-aware).
  const hit = findShellMetachar(command);
  if (hit) {
    return {
      action: "intercept",
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Coordinator Bash commands cannot contain shell metacharacters outside quotes (found: ${hit}). Put literal text inside single quotes ('…'), double quotes (\"…\"), or a quoted-delimiter heredoc (<<'EOF' … EOF).`,
        },
      },
    };
  }

  // Block --output in git commands (can write files without shell metacharacters)
  if (/^git\s/.test(command) && command.includes("--output")) {
    return {
      action: "intercept",
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Coordinator git commands cannot use --output flag (file write bypass)",
        },
      },
    };
  }

  // Block directory-changing flags in git commands (bypasses path isolation)
  const blockedFlag = checkGitDirectoryFlags(command);
  if (blockedFlag) {
    return {
      action: "intercept",
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `The ${blockedFlag} flag is not allowed with git. Run git commands from your working directory instead.`,
        },
      },
    };
  }

  return null;
}

/**
 * Detect Bash commands whose purpose is to busy-wait / poll for a sub-agent,
 * and deny them with a pointer to the WAITING workflow (SPEC §8.5 / §8.5.1).
 *
 * Agents sometimes try to "wait" for a sub-agent by sleeping or spinning a
 * polling loop (e.g. `sleep 45; ib look x`, `until …; do sleep 5; done`).
 * These waste tokens and are blocked by Claude Code's built-ins anyway. The
 * correct behavior is to emit WAITING and let the per-agent watchdog notify
 * the agent when the sub-agent completes or needs input. Denying here (as a
 * PreToolUse hook) pre-empts the built-in deny so the agent sees OUR message.
 *
 * Applies to ALL agent types (worker, manager, coordinator) — any of them
 * might try to sleep-wait — so this is independent of agent identity.
 *
 * Conservative matching (avoid false positives on commands that merely
 * mention "sleep"):
 *  - The command IS or STARTS WITH `sleep <number>` (anchored at start).
 *  - A `while`/`until` loop (anchored at start) whose body contains `sleep`.
 */
function checkBusyWaitBash(
  input: { tool_name: string; tool_input: Record<string, unknown> }
): InterceptResult | null {
  if (input.tool_name !== "Bash") return null;

  const command = (input.tool_input.command as string) ?? "";

  // A command that is, or starts with, `sleep <number>` — covers
  // `sleep 45`, `sleep 5 && ib list`, `sleep 30 ; ib status x`.
  const startsWithSleep = /^\s*sleep\s+[0-9.]+/i.test(command);

  // A `while`/`until` loop whose body contains a `sleep` call — covers
  // `until …; do sleep 5; done`, `while …; do sleep 2; done`.
  const isPollingLoop =
    /^\s*(while|until)\b/i.test(command) && /\bsleep\b/i.test(command);

  if (!startsWithSleep && !isPollingLoop) return null;

  return {
    action: "intercept",
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Don't sleep or busy-loop to wait for sub-agents — it spins tokens and these wait commands are blocked anyway. To wait, make 'WAITING' the LAST line of your message and stop. A per-agent watchdog will notify you when a sub-agent completes or needs input — you don't need to poll. When you're notified, resume with 'ib look <id>' / 'ib diff <id>'.",
      },
    },
  };
}

export async function processTaskIntercept(
  input: {
    tool_name: string;
    tool_input: Record<string, unknown>;
    cwd: string;
    /** Explicit hook identity, validated against worktree:false metadata. */
    agentId?: string;
  },
  opts?: {
    spawnAgent?: (
      repoPath: string,
      prompt: string,
      spawnOpts: Record<string, unknown>
    ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  }
): Promise<InterceptResult> {
  const resolved = await resolveInterceptAgent(input.cwd, input.agentId);

  // An explicit hook identity is meaningful only when the shared-repo
  // ancestor chain validates it as this worktree:false agent. Never degrade a
  // stale, forged, or malformed explicit id into primary-Claude behavior:
  // that would turn an identity failure into manager privileges.
  if (input.agentId !== undefined && !resolved) {
    return {
      action: "intercept",
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Cannot validate the explicit itsybitsy agent identity for this repository.",
        },
      },
    };
  }

  // 0. Check coordinator Bash restrictions (SPEC §12.2.4)
  const coordBlock = await checkCoordinatorBashRestrictions(input, resolved);
  if (coordBlock) return coordBlock;

  // 0.5. Deny busy-wait / poll Bash commands for ALL agent types (SPEC §8.5).
  // Runs before the `tool_name !== 'Task'…` early-return so it applies to
  // workers, managers, and coordinators alike.
  const busyWaitBlock = checkBusyWaitBash(input);
  if (busyWaitBlock) return busyWaitBlock;

  // 1. Deny AskUserQuestion — agents must use `ib ask` instead
  if (input.tool_name === "AskUserQuestion") {
    let isWorker = false;
    if (resolved) {
      // Prefer synthetic meta when present (e.g., @system); otherwise read disk.
      let meta: Record<string, unknown> | null = resolved.syntheticMeta ?? null;
      if (!meta) {
        try {
          const metaFile = Bun.file(join(resolved.agentDir, "meta.json"));
          if (await metaFile.exists()) {
            meta = (await metaFile.json()) as Record<string, unknown>;
          }
        } catch {
          // If we can't read meta, treat as manager-like (non-agent fallback)
        }
      }
      if (meta) {
        // This deliberately does NOT reuse `metaCanSpawnChildren` (the spawn
        // gate's shared predicate). This is a *messaging* choice, not a security
        // gate, and it prefers to fail OPEN to manager-style ("use `ib ask`")
        // where the spawn gate fails CLOSED: an unknown/broken type, or a
        // manager toggled off via the 'b' dialog, is likely top-level and may
        // have no manager to "report to", so the `ib ask` hint is the safer
        // fallback than "report to your manager". Only a clearly-identified
        // leaf (worker type / legacy `worker: true`) gets the worker message.
        if (meta.agentType && typeof meta.agentType === "string") {
          // The `system` agent type is a layer file (no canSpawnChildren) —
          // short-circuit to manager-style messaging since @system is top-level.
          if (meta.agentType !== "system") {
            try {
              const agentType = await loadAgentType(meta.agentType as string);
              if (!agentType.canSpawnChildren) isWorker = true;
            } catch {
              // Unknown type — treat as manager-like
            }
          }
        } else if (meta.worker === true) {
          // Backward compat: legacy agents without agentType
          isWorker = true;
        }
      }
    }

    const reason = isWorker
      ? "Workers cannot ask the user questions directly. Report your question or findings to your manager agent instead."
      : "Use `ib ask \"question\"` instead of AskUserQuestion. The ittybitty system routes questions through its own dashboard and question-acknowledgement flow.";

    return {
      action: "intercept",
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      },
    };
  }

  // 2. Only intercept Task, Agent, and TaskCreate tools
  if (input.tool_name !== "Task" && input.tool_name !== "Agent" && input.tool_name !== "TaskCreate") {
    return { action: "skip" };
  }

  // 3. Check if calling from a worker agent or from an agent type that can't spawn children
  if (resolved) {
    let meta: Record<string, unknown> | null = resolved.syntheticMeta ?? null;
    if (!meta) {
      try {
        const metaFile = Bun.file(join(resolved.agentDir, "meta.json"));
        if (await metaFile.exists()) {
          meta = (await metaFile.json()) as Record<string, unknown>;
        }
      } catch {
        // If we can't read meta, continue with intercept
      }
    }
    if (meta) {
      // The system coordinator spawns agents via `ib new-agent --repo <name>`,
      // never via Task/Agent/TaskCreate. Spawning here would resolve repoPath
      // to `~/.itsybitsy/` (not a registered repo) and produce confusing
      // failures. In practice Claude can never reach this branch — the system
      // coordinator's settings.local.json puts Task/Agent/TaskCreate in its
      // deny list. Keep this explicit deny (with its specific guidance) as
      // defense-in-depth, and BEFORE the shared predicate below: for @system,
      // Task is simply the wrong mechanism, not a lack of spawn permission —
      // `metaCanSpawnChildren` classifies @system as *able* to spawn (true).
      if (meta.agentType === "system") {
        return {
          action: "intercept",
          output: {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "The system coordinator spawns agents via `ib new-agent --repo <name>`, not Task/Agent/TaskCreate.",
            },
          },
        };
      }

      // Single source of truth shared with the `ib new-agent` CLI caller gate
      // (see `newAgent` in ib-commands.ts): a leaf agent must be blocked
      // identically whether it reaches spawning via the Task/Agent tool (here)
      // or by running `ib new-agent` directly. `metaCanSpawnChildren` encodes
      // the full precedence — per-agent `canSpawnChildren` override > agentType
      // `canSpawnChildren` (an unknown/broken type is fail-closed to "cannot
      // spawn") > legacy `worker` boolean. When it returns true, allow the Task
      // and fall through to the spawn below.
      if (!(await metaCanSpawnChildren(meta))) {
        return {
          action: "intercept",
          output: {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Workers cannot create tasks or spawn sub-agents. Only manager agents can spawn workers.",
            },
          },
        };
      }
    }
  }

  // 4. Check subagent_type skip list
  const subagentType = input.tool_input.subagent_type as string | undefined;
  if (subagentType && SKIP_SUBAGENT_TYPES.includes(subagentType)) {
    return { action: "skip" };
  }

  // 5. Extract prompt, description, model
  const prompt = (input.tool_input.prompt as string) ?? "";
  const description = (input.tool_input.description as string) ?? "";
  let model = (input.tool_input.model as string) ?? "";

  // 6. Validate model — accept the qualified `<cli>:<model>` form (D1/D5)
  // or empty (inherit from agent-type / config). Anything malformed is
  // silently dropped to "" so a bad Task `model:` arg doesn't block the spawn.
  if (!isAcceptableTaskModel(model)) {
    model = "";
  }

  // 6b. The Task/Agent `model` argument is the native-spawn equivalent of
  // `--model`, and it is user-only (§1a0): an agent — even a spawn-permitted
  // manager or coordinator — must let its spawned child inherit the model from
  // the agent-type layers / config, never pin it. `resolved` present ⇒ an agent
  // caller (primary Claude has no resolved agent and stays unrestricted; @system
  // was already intercepted above). Mirrors the `ib new-agent --model` deny in
  // checkIbCommandAccess and the newAgent() backstop. Checked against the RAW
  // arg so a malformed value that step 6 would coerce away still reports the
  // attempt clearly rather than silently spawning with an inherited model.
  if (resolved && typeof input.tool_input.model === "string" && input.tool_input.model.trim()) {
    return {
      action: "intercept",
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "The Task `model` argument is user-only — a spawned sub-agent inherits its model from its agent type; ask the user if a different model is needed.",
        },
      },
    };
  }

  // 7. Determine agent prompt
  const agentPrompt = prompt || description;
  if (!agentPrompt.trim()) {
    return { action: "skip" };
  }

  // 8. Determine repoPath
  let repoPath = resolved?.noWorktreeRepoPath ?? input.cwd;
  if (!resolved?.noWorktreeRepoPath) {
    const ittybittyIdx = input.cwd.indexOf("/.ittybitty/agents/");
    if (ittybittyIdx !== -1) {
      repoPath = input.cwd.substring(0, ittybittyIdx);
    }
  }

  // 9. Determine calling agent ID. @system cannot reach here — the explicit
  // deny above intercepts it before fall-through. Worktree agents pass their
  // ID; primary Claude (no resolved agent) leaves callingAgentId undefined,
  // which causes the spawn step to create a manager rather than a worker.
  const callingAgentId = resolved && resolved.agentId !== SYSTEM_AGENT_ID
    ? resolved.agentId
    : undefined;

  // 10. Spawn agent
  // Only set type+manager when called from an agent context (callingAgentId present).
  // From primary Claude, spawn managers (not workers).
  // _cwd forwards Claude's reported cwd so newAgent can auto-detect the spawning
  // agent's manager (and, indirectly, pick the right parent worktree to dirty-
  // check) from Claude's reported cwd rather than the hook process's own cwd.
  let result: { ok: boolean; stdout: string; stderr: string };
  const spawnOpts: Record<string, unknown> = {
    type: callingAgentId ? "worker" : undefined,
    manager: callingAgentId,
    model: model || undefined,
    _cwd: input.cwd,
  };

  if (opts?.spawnAgent) {
    result = await opts.spawnAgent(repoPath, agentPrompt, spawnOpts);
  } else {
    result = await newAgent(repoPath, agentPrompt, spawnOpts as Parameters<typeof newAgent>[2]);
  }

  // 11. Extract agent ID from stdout
  const agentIdMatch = /(agent-[a-f0-9]+)/.exec(result.stdout);
  const spawnedId = agentIdMatch ? agentIdMatch[1]! : undefined;

  // 12. Spawn failure
  if (!result.ok) {
    return {
      action: "intercept",
      spawnedAgentId: spawnedId,
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `ib agent spawn failed: ${result.stderr || "unknown error"}. Do NOT retry — investigate the error.`,
        },
      },
    };
  }

  // 13. Success — deny the original tool to prevent double-spawn.
  // Using "deny" is required because it's the only way to prevent the original
  // Task/Agent tool from also executing (which would create a duplicate).
  // The denial reason clearly communicates that this was a SUCCESSFUL redirect,
  // not a failure. The additionalContext reinforces this.
  const id = spawnedId ?? "unknown";
  return {
    action: "intercept",
    spawnedAgentId: spawnedId,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `SUCCESS: Your task was intercepted and redirected to ib agent ${id}. The agent is now running autonomously. This "deny" is expected behavior — it prevents duplicate execution. Do NOT retry or re-spawn. Monitor progress: ib look ${id}`,
      },
    },
  };
}

export async function hookInterceptTask(rawStdin?: string, agentId?: string): Promise<void> {
  const raw = rawStdin ?? await new Response(Bun.stdin.stream()).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`intercept-task: failed to parse stdin JSON: ${raw.slice(0, 200)}\n`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Failed to parse stdin" } }));
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(`intercept-task: stdin is not a JSON object\n`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  const data = parsed as Record<string, unknown>;

  // Validate tool_name is a string
  if (data.tool_name !== undefined && typeof data.tool_name !== "string") {
    process.stderr.write(`intercept-task: tool_name is not a string\n`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  // Validate tool_input is a non-null object
  if (data.tool_input !== undefined && (typeof data.tool_input !== "object" || data.tool_input === null)) {
    process.stderr.write(`intercept-task: tool_input is not an object\n`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  const result = await processTaskIntercept({
    tool_name: (data.tool_name as string) ?? "",
    tool_input: (data.tool_input as Record<string, unknown>) ?? {},
    cwd: (data.cwd as string) ?? process.cwd(),
    agentId,
  });

  if (result.action === "skip") {
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Allowed",
      },
    };
    process.stdout.write(JSON.stringify(output));
  } else {
    process.stdout.write(JSON.stringify(result.output));
  }
}

/**
 * Hook: intercept Claude Task tool calls and spawn ib agents instead.
 */

import { join } from "path";
import { newAgent } from "../ib-commands";
import type { IbCommandResult } from "../ib-commands";
import { AGENT_CWD_PATTERN } from "./shared";
import { canSpawnChildren as checkCanSpawnChildren } from "../agents";
import type { AgentMeta } from "../agents";

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

const VALID_MODELS = new Set(["sonnet", "opus", "haiku", ""]);

/**
 * Shell metacharacters blocked for coordinator Bash commands (SPEC §12.2.4).
 * These prevent chained commands that bypass Bash(ib:*) prefix matching.
 */
const SHELL_METACHARACTERS = /[;|&`><]|\$\(|\$\{|\$'|\n|\r/;

/**
 * Check if this is a Bash tool call from a coordinator session that contains
 * shell metacharacters or --output in git commands (SPEC §12.2.4).
 * Returns a deny result if blocked, or null to proceed normally.
 */
async function checkCoordinatorBashRestrictions(
  input: { tool_name: string; tool_input: Record<string, unknown>; cwd: string }
): Promise<InterceptResult | null> {
  if (input.tool_name !== "Bash") return null;

  // Detect coordinator session via cwd pattern and meta.json
  const cwdMatch = AGENT_CWD_PATTERN.exec(input.cwd);
  if (!cwdMatch) return null;

  const agentId = cwdMatch[1]!;
  const agentDir = input.cwd.substring(
    0,
    input.cwd.indexOf(".ittybitty/agents/" + agentId) +
      ".ittybitty/agents/".length +
      agentId.length
  );

  let isCoordinator = false;
  try {
    const metaFile = Bun.file(join(agentDir, "meta.json"));
    if (await metaFile.exists()) {
      const meta = await metaFile.json();
      isCoordinator = meta.coordinator === true;
    }
  } catch {
    // If we can't read meta, not a coordinator
  }

  if (!isCoordinator) return null;

  const command = (input.tool_input.command as string) ?? "";

  // Block shell metacharacters
  if (SHELL_METACHARACTERS.test(command)) {
    return {
      action: "intercept",
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Coordinator Bash commands cannot contain shell metacharacters (;, |, &, `, >, <, $() etc.)",
        },
      },
    };
  }

  // Block --output in git commands (can write files without shell metacharacters)
  if (command.startsWith("git") && command.includes("--output")) {
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

  return null;
}

export async function processTaskIntercept(
  input: {
    tool_name: string;
    tool_input: Record<string, unknown>;
    cwd: string;
  },
  opts?: {
    spawnAgent?: (
      repoPath: string,
      prompt: string,
      spawnOpts: Record<string, unknown>
    ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  }
): Promise<InterceptResult> {
  // 0. Check coordinator Bash restrictions (SPEC §12.2.4)
  const coordBlock = await checkCoordinatorBashRestrictions(input);
  if (coordBlock) return coordBlock;

  // 1. Only intercept Task, Agent, and TaskCreate tools
  if (input.tool_name !== "Task" && input.tool_name !== "Agent" && input.tool_name !== "TaskCreate") {
    return { action: "skip" };
  }

  // 2. Check if calling from a worker agent — workers cannot spawn sub-agents
  const cwdMatch = AGENT_CWD_PATTERN.exec(input.cwd);
  if (cwdMatch) {
    const agentId = cwdMatch[1]!;
    const agentDir = input.cwd.substring(
      0,
      input.cwd.indexOf(".ittybitty/agents/" + agentId) +
        ".ittybitty/agents/".length +
        agentId.length
    );
    try {
      const metaFile = Bun.file(join(agentDir, "meta.json"));
      if (await metaFile.exists()) {
        const meta = await metaFile.json() as AgentMeta;
        // Check if this agent type can spawn children
        const canSpawn = await checkCanSpawnChildren(meta);
        if (!canSpawn) {
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
    } catch {
      // If we can't read meta, continue with intercept
    }
  }

  // 3. Check subagent_type skip list
  const subagentType = input.tool_input.subagent_type as string | undefined;
  if (subagentType && SKIP_SUBAGENT_TYPES.includes(subagentType)) {
    return { action: "skip" };
  }

  // 4. Extract prompt, description, model
  const prompt = (input.tool_input.prompt as string) ?? "";
  const description = (input.tool_input.description as string) ?? "";
  let model = (input.tool_input.model as string) ?? "";

  // 5. Validate model
  if (!VALID_MODELS.has(model)) {
    model = "";
  }

  // 6. Determine agent prompt
  const agentPrompt = prompt || description;
  if (!agentPrompt.trim()) {
    return { action: "skip" };
  }

  // 7. Determine repoPath
  let repoPath = input.cwd;
  const ittybittyIdx = input.cwd.indexOf("/.ittybitty/agents/");
  if (ittybittyIdx !== -1) {
    repoPath = input.cwd.substring(0, ittybittyIdx);
  }

  // 8. Determine calling agent ID
  const callingAgentId = cwdMatch ? cwdMatch[1]! : undefined;

  // 9. Spawn agent
  // Only set worker+manager when called from an agent context (callingAgentId present).
  // From primary Claude, spawn managers (not workers).
  let result: { ok: boolean; stdout: string; stderr: string };
  const spawnOpts: Record<string, unknown> = {
    worker: callingAgentId ? true : undefined,
    manager: callingAgentId,
    model: model || undefined,
  };

  if (opts?.spawnAgent) {
    result = await opts.spawnAgent(repoPath, agentPrompt, spawnOpts);
  } else {
    result = await newAgent(repoPath, agentPrompt, spawnOpts as Parameters<typeof newAgent>[2]);
  }

  // 10. Extract agent ID from stdout
  const agentIdMatch = /(agent-[a-f0-9]+)/.exec(result.stdout);
  const spawnedId = agentIdMatch ? agentIdMatch[1]! : undefined;

  // 11. Spawn failure
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

  // 12. Success — deny the original tool to prevent double-spawn.
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

export async function hookInterceptTask(rawStdin?: string): Promise<void> {
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

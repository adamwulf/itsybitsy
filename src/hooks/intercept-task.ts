/**
 * Hook: intercept Claude Task tool calls and spawn ib agents instead.
 */

import { join } from "path";
import { newAgent } from "../ib-commands";
import type { IbCommandResult } from "../ib-commands";
import { AGENT_CWD_PATTERN } from "./shared";

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
  // 1. Only intercept Task tool
  if (input.tool_name !== "Task") {
    return { action: "skip" };
  }

  // 2. Check if calling from a worker agent
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
        const meta = await metaFile.json();
        if (meta.worker === true) {
          return { action: "skip" };
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
          permissionDecision: "allow",
          updatedInput: {
            subagent_type: "claude-code-guide",
            prompt: `Respond with only this message: ib agent spawn failed: ${result.stderr || "unknown error"}`,
            description: "Task intercepted by ittybitty (spawn failed)",
          },
        },
      },
    };
  }

  // 12. Success
  const id = spawnedId ?? "unknown";
  return {
    action: "intercept",
    spawnedAgentId: spawnedId,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          subagent_type: "claude-code-guide",
          prompt: `Respond with only this message: ib agent ${id} has been spawned to handle the original task. Monitor with: ib look ${id}`,
          description: "Task intercepted by ittybitty",
        },
      },
    },
  };
}

export async function hookInterceptTask(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();
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

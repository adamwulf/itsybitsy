/**
 * Hook: intercept Claude Task tool calls and spawn ib agents instead.
 */

import { join } from "path";
import { newAgent } from "../ib-commands";
import { checkGitDirectoryFlags, resolveAgentFromCwd, SYSTEM_AGENT_ID } from "./shared";
import { loadAgentType } from "../agent-types";
import { parseModel } from "../agent-cli";

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
 * Shell metacharacters blocked for coordinator Bash commands (SPEC §12.2.4).
 * These prevent chained commands that bypass Bash(ib:*) prefix matching.
 *
 * The guard is a small lexical pass that tracks quoting state so literal
 * metacharacters inside single quotes, double quotes, or a quoted-delimiter
 * heredoc body are allowed (those characters are shell-inert in that
 * context), while metacharacters that are still shell-active in their
 * context — unquoted separators/redirects, command substitution, ANSI-C
 * quoting, command-separator newlines — remain blocked.
 *
 * Blocked constructs (when shell-active in their context):
 *   - Command separators / chaining:  ;  &  &&  ||  newline / carriage return
 *   - Pipes:                          |  ||
 *   - Redirection:                    >  >>  <   (but `<<` heredoc openers
 *                                                 are handled specially —
 *                                                 quoted-delimiter heredocs
 *                                                 are allowed)
 *   - Subshells:                      ( … )
 *   - Command substitution:           `…`   $(…)
 *   - Parameter expansion that can run code: $(…)  $'…'   ${…} when it
 *                                            contains `$(` or backtick
 *   - ANSI-C quoting:                 $'…'   (can encode literal newlines
 *                                             that bypass other checks)
 *
 * Explicitly ALLOWED (literal text in a quoted context):
 *   - Anything between matched single quotes:        '… ; | & ` > < $( …'
 *   - Inside double quotes, the redirect/separator
 *     characters are inert literals:                 "… ; | & > < …"
 *     but `…` and $(…) and $'…' inside double quotes are still command
 *     substitution and remain blocked.
 *   - The body of a quoted-delimiter heredoc:
 *           ib send agent <<'EOF'
 *           anything ; | & ` $(...) goes here
 *           EOF
 *     The body of an *unquoted* delimiter heredoc still undergoes $/`
 *     expansion, so $( and backticks remain blocked there.
 */
function findShellMetachar(command: string): string | null {
  let i = 0;
  const n = command.length;

  // Heredoc state, populated when we consume a `<<` opener.
  // `delimiter` is the terminator word; `expand` indicates whether the body
  // is still subject to $ / backtick expansion (unquoted delimiter).
  let heredoc: { delimiter: string; expand: boolean } | null = null;

  while (i < n) {
    const c = command[i]!;

    // ---- Inside an active heredoc body ----
    if (heredoc) {
      // Look for the terminator at the start of a line. Bash matches the
      // delimiter on a line whose only non-newline content is the delimiter
      // (leading tabs only if `<<-` was used; we treat any leading whitespace
      // forgivingly because false negatives just mean we keep scanning).
      // Find the end of this line.
      let lineEnd = command.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      const line = command.substring(i, lineEnd);
      const trimmed = line.replace(/^\s+/, "").replace(/\s+$/, "");
      if (trimmed === heredoc.delimiter) {
        // End of heredoc body. Resume normal scanning after the newline.
        i = lineEnd < n ? lineEnd + 1 : lineEnd;
        heredoc = null;
        continue;
      }

      // Still in body. If the delimiter was unquoted, $/` expansion is live;
      // flag the same constructs we would flag in a double-quoted string.
      if (heredoc.expand) {
        if (c === "`") return "backtick command substitution";
        if (c === "$") {
          const next = command[i + 1];
          if (next === "(") return "$( command substitution";
          if (next === "'") return "$' ANSI-C quoting";
          // ${…} alone doesn't run a command, but `${…}` containing $( or `
          // would be flagged on those characters as we walk into them.
        }
      }
      // All other characters in the body are literal data.
      i++;
      continue;
    }

    // ---- Single-quoted: literally everything until the next ' ----
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) {
        // Unterminated single quote — treat the rest as literal. Either the
        // user made a typo (the shell would also error) or the command was
        // truncated; in neither case can the unread tail run anything.
        return null;
      }
      i = close + 1;
      continue;
    }

    // ---- Double-quoted: backtick, $(, $' still dangerous; rest literal ----
    if (c === '"') {
      i++;
      while (i < n) {
        const d = command[i]!;
        if (d === "\\") {
          // Inside "...", backslash only escapes $, `, ", \, newline. For
          // our purposes we just skip the next character — even if bash
          // would treat the backslash as literal, the following character
          // can't be a shell-active metachar that we'd misclassify.
          i += 2;
          continue;
        }
        if (d === "`") return "backtick command substitution";
        if (d === "$") {
          const next = command[i + 1];
          if (next === "(") return "$( command substitution";
          if (next === "'") return "$' ANSI-C quoting";
        }
        if (d === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // ---- Unquoted backslash escapes the next character ----
    if (c === "\\") {
      // An escaped newline is line-continuation, which is harmless (bash
      // treats it as whitespace). An escaped metachar becomes literal.
      i += 2;
      continue;
    }

    // ---- $ forms outside quotes ----
    if (c === "$") {
      const next = command[i + 1];
      if (next === "(") return "$( command substitution";
      if (next === "'") return "$' ANSI-C quoting";
      // $VAR and ${VAR} alone don't run code. The original guard blocked
      // ${…} too out of caution, but plain parameter expansion is safe and
      // commonly appears (e.g., `ib send agent ${MSG}`). Allow it.
      i++;
      continue;
    }

    // ---- Backtick command substitution (unquoted) ----
    if (c === "`") return "backtick command substitution";

    // ---- Command separators / chaining ----
    if (c === ";") return "; command separator";
    if (c === "\n" || c === "\r") return "newline command separator";
    if (c === "|") return "| pipe or || chain";
    if (c === "&") return "& background or && chain";

    // ---- Subshells ----
    if (c === "(") return "( subshell";
    if (c === ")") return ") subshell";

    // ---- Redirection ----
    if (c === ">") return "> redirect";
    if (c === "<") {
      // `<<` opens a heredoc. Inspect the delimiter to decide whether the
      // body is literal (quoted delimiter) or expandable (unquoted).
      if (command[i + 1] === "<") {
        // Skip `<<`, optional `-`, and any whitespace.
        let j = i + 2;
        if (command[j] === "-") j++;
        while (j < n && (command[j] === " " || command[j] === "\t")) j++;

        // Read the delimiter. Bash supports 'EOF', "EOF", \EOF, or bare EOF.
        let quoted = false;
        let delim = "";
        const dc = command[j];
        if (dc === "'") {
          quoted = true;
          const end = command.indexOf("'", j + 1);
          if (end === -1) return "< redirect"; // malformed; treat as redirect
          delim = command.substring(j + 1, end);
          j = end + 1;
        } else if (dc === '"') {
          quoted = true;
          // Parse a double-quoted delimiter, honoring backslash escapes the
          // same way bash does for the delimiter word.
          let k = j + 1;
          let buf = "";
          while (k < n && command[k] !== '"') {
            if (command[k] === "\\" && k + 1 < n) {
              buf += command[k + 1];
              k += 2;
            } else {
              buf += command[k];
              k++;
            }
          }
          if (k >= n) return "< redirect"; // malformed
          delim = buf;
          j = k + 1;
        } else if (dc === "\\") {
          // \EOF — backslash quotes the delimiter (no expansion in body).
          quoted = true;
          let k = j + 1;
          let buf = "";
          while (k < n && /[A-Za-z0-9_]/.test(command[k]!)) {
            buf += command[k];
            k++;
          }
          delim = buf;
          j = k;
        } else {
          // Bare delimiter — unquoted, body undergoes $/` expansion.
          let k = j;
          let buf = "";
          while (k < n && /[A-Za-z0-9_]/.test(command[k]!)) {
            buf += command[k];
            k++;
          }
          if (buf === "") {
            // No delimiter word found — treat as plain `<<` redirect.
            return "< redirect";
          }
          delim = buf;
          j = k;
        }

        // The rest of the command line (up to the next newline) is still
        // normal shell syntax — only the heredoc *body* (after the next
        // newline) is in heredoc mode. Skip to and consume the newline.
        const nl = command.indexOf("\n", j);
        if (nl === -1) {
          // No body in the command string (e.g., never closed). Nothing
          // dangerous to scan further; the command is malformed but inert.
          return null;
        }
        // Scan the rest of this line as normal shell. We recurse implicitly
        // by adjusting i and continuing the outer loop, but to keep the
        // logic simple we just jump to the newline. Anything between `j`
        // and the newline would be e.g. ` | tee log` — pipes after the
        // heredoc opener — which we want to keep blocking. So scan it.
        const tail = command.substring(j, nl);
        const tailHit = findShellMetachar(tail);
        if (tailHit) return tailHit;

        // Enter heredoc body.
        heredoc = { delimiter: delim, expand: !quoted };
        i = nl + 1;
        continue;
      }
      return "< redirect";
    }

    i++;
  }

  return null;
}

/**
 * Check if this is a Bash tool call from a coordinator session that contains
 * shell metacharacters or --output in git commands (SPEC §12.2.4).
 * Returns a deny result if blocked, or null to proceed normally.
 */
async function checkCoordinatorBashRestrictions(
  input: { tool_name: string; tool_input: Record<string, unknown>; cwd: string }
): Promise<InterceptResult | null> {
  if (input.tool_name !== "Bash") return null;

  // Resolve agent identity. The system coordinator's synthetic meta carries
  // `agentType: "system"`; per-repo coordinators have `agentType: "coordinator"`
  // on disk. Both should get the same restrictions (no shell metacharacters,
  // no --output, no -C/--git-dir/--work-tree).
  const resolved = resolveAgentFromCwd(input.cwd);
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

  // 1. Deny AskUserQuestion — agents must use `ib ask` instead
  if (input.tool_name === "AskUserQuestion") {
    const resolved = resolveAgentFromCwd(input.cwd);
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
        // agentType takes precedence over legacy worker boolean when present
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
  const resolved = resolveAgentFromCwd(input.cwd);
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
      // agentType takes precedence over legacy worker boolean when present
      if (meta.agentType && typeof meta.agentType === "string") {
        // The system coordinator spawns agents via `ib new-agent --repo <name>`,
        // never via Task/Agent/TaskCreate. Spawning here would resolve repoPath
        // to `~/.itsybitsy/` (not a registered repo) and produce confusing
        // failures. In practice Claude can never reach this branch — the
        // system coordinator's settings.local.json puts Task/Agent/TaskCreate
        // in its deny list. Keep this explicit deny as defense-in-depth.
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
        try {
          const agentType = await loadAgentType(meta.agentType as string);
          if (!agentType.canSpawnChildren) {
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
          // canSpawnChildren=true — allow Task, fall through to spawn
        } catch {
          // Unknown type — fall through to intercept (safer default).
        }
      } else if (meta.worker === true) {
        // Backward compat: legacy agents without agentType
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

  // 7. Determine agent prompt
  const agentPrompt = prompt || description;
  if (!agentPrompt.trim()) {
    return { action: "skip" };
  }

  // 8. Determine repoPath
  let repoPath = input.cwd;
  const ittybittyIdx = input.cwd.indexOf("/.ittybitty/agents/");
  if (ittybittyIdx !== -1) {
    repoPath = input.cwd.substring(0, ittybittyIdx);
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
  let result: { ok: boolean; stdout: string; stderr: string };
  const spawnOpts: Record<string, unknown> = {
    type: callingAgentId ? "worker" : undefined,
    manager: callingAgentId,
    model: model || undefined,
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

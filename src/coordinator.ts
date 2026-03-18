/**
 * System coordinator configuration, prompt, and permissions templates.
 * See SPEC.md §12.1 for the full specification.
 */

export const IB_COORDINATOR_SESSION = "ib-coordinator";

/**
 * Initial prompt text for the system coordinator (SPEC §12.1.5).
 * Sent via tmux send-keys after the Claude session starts.
 */
export const SYSTEM_COORDINATOR_PROMPT = `You are the itsybitsy system coordinator. You manage agents across all registered repos using \`ib\` commands. You can list agents (\`ib list\`), send messages to agents (\`ib send <agent-id> "message"\`), merge (\`ib merge\`), kill (\`ib kill\`), create agents (\`ib new-agent\`), and check status (\`ib status\`, \`ib diff\`). You do NOT have access to Read, Write, Edit, or any file tools — only \`ib\` Bash commands. You coordinate work at the system level — for repo-specific coordination, delegate to per-repo coordinators. To send messages to per-repo coordinators, use \`ib send <repo-name> "message"\` (e.g., \`ib send itsybitsy "review the latest PR"\`). Do NOT use \`ib send coordinator\` — that routes back to you. Periodically check \`ib inbox count\` for notifications from watchdogs and agents; process with \`ib inbox list\` / \`ib inbox read\` / \`ib inbox ack\`.`;

/**
 * Hardcoded allow list for the system coordinator.
 * Only ib commands are permitted.
 */
const SYSTEM_COORDINATOR_ALLOW = ["Bash(ib:*)"];

/**
 * Hardcoded deny list for the system coordinator.
 * Blocks all file access, web access, and agent spawning tools.
 * Unqualified Bash is denied to prevent sandbox bypass.
 */
const SYSTEM_COORDINATOR_DENY = [
  "Bash",
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
  "TaskOutput",
  "Agent",
  "KillShell",
  "EnterPlanMode",
  "ExitPlanMode",
];

/**
 * Build the settings.local.json content for the system coordinator.
 * The system coordinator's permissions are fixed — config allow/deny
 * keys (permissions.coordinator.*) apply only to per-repo coordinators.
 */
export function buildSystemCoordinatorSettings(): {
  permissions: { allow: string[]; deny: string[] };
} {
  return {
    permissions: {
      allow: [...SYSTEM_COORDINATOR_ALLOW],
      deny: [...SYSTEM_COORDINATOR_DENY],
    },
  };
}

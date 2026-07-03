/**
 * PreToolUse path isolation hook.
 * Ported from ib bash script's check_pretooluse_access().
 *
 * Enforces that agents can only access files within their own worktree,
 * their own agent.log, and general system paths.
 */

import { join, resolve, dirname, basename } from "path";
import { homedir } from "os";
import { realpath, stat } from "fs/promises";
import { realpathSync } from "fs";
import { logAgent } from "../agent-lifecycle";
import { writeAgentState } from "../agents";
import { isValidAgentId } from "../validation";
import { checkGitDirectoryFlags, resolveAgentFromCwd, SYSTEM_AGENT_ID } from "./shared";
// Single source of truth for the encoding — see src/auto-compact.ts
import { encodeClaudeProjectPath } from "../auto-compact";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PathCheckInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
}

export interface PathCheckContext {
  agentId: string;
  agentDir: string;
  worktreePath: string;
  agentsDir: string;
  rootRepo: string;
  allowList: string[];
  allowedPaths?: string[];
}

export interface HookDecision {
  decision: "allow" | "deny";
  reason: string;
}

// ── Pattern matching ─────────────────────────────────────────────────────────

/**
 * Check if a tool name + input matches an allow-list pattern.
 *
 * Patterns:
 * - "Bash(prefix:*)": matches Bash tool where command starts with prefix
 * - "Bash(exact command)": matches Bash tool where command equals exact string
 * - "ToolName": exact tool name match
 */
export function toolMatchesPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
  pattern: string
): boolean {
  // Check for Bash(prefix:*) pattern
  const bashMatch = pattern.match(/^Bash\(([^:]+):\*\)$/);
  if (bashMatch) {
    const prefix = bashMatch[1]!;
    if (toolName === "Bash") {
      const command = String(toolInput.command ?? "");
      if (command === prefix || command.startsWith(prefix + " ")) {
        return true;
      }
    }
    return false;
  }

  // Check for Bash(exact command) pattern — no :* wildcard
  const exactBashMatch = pattern.match(/^Bash\((.+)\)$/);
  if (exactBashMatch) {
    if (toolName === "Bash") {
      const exactCommand = exactBashMatch[1]!;
      const command = String(toolInput.command ?? "");
      return command === exactCommand;
    }
    return false;
  }

  // Exact tool name match
  return pattern === toolName;
}

/**
 * Check if a file path is in the allowed paths list.
 * Matches exact directory paths or path prefixes.
 *
 * A path is allowed if:
 * - filePath === allowed (exact match)
 * - filePath.startsWith(allowed + '/') (prefix match with directory separator)
 *
 * Examples:
 * - filePath: /home/user/allowed, allowed: /home/user/allowed → true (exact)
 * - filePath: /home/user/allowed/file.txt, allowed: /home/user/allowed → true (prefix)
 * - filePath: /home/user/allowed-other, allowed: /home/user/allowed → false (partial name)
 */
export function isInAllowedPaths(filePath: string, allowedPaths: string[]): boolean {
  for (const allowed of allowedPaths) {
    if (filePath === allowed || filePath.startsWith(allowed + "/")) {
      return true;
    }
  }
  return false;
}

// ── Settings file protection ─────────────────────────────────────────────────

/**
 * Tool names that mutate files. Used to gate the settings*.json write block —
 * Read/Glob/Grep/LS on settings.json must still be allowed.
 */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * Check if an absolute, normalized path points directly to a settings*.json
 * file inside <worktreePath>/.claude/. Files in subdirectories of .claude do
 * not match — only files immediately under .claude.
 */
export function isWorktreeSettingsFile(filePath: string, worktreePath: string): boolean {
  const claudeDir = join(worktreePath, ".claude");
  if (dirname(filePath) !== claudeDir) return false;
  return /^settings.*\.json$/.test(basename(filePath));
}

// ── Pure decision logic ──────────────────────────────────────────────────────

/**
 * Determine whether to allow or deny a tool invocation.
 * Pure function — no I/O, fully testable.
 */
export function checkPathAccess(
  input: PathCheckInput,
  ctx: PathCheckContext
): HookDecision {
  const { toolName, toolInput, cwd } = input;
  const { agentDir, worktreePath, agentsDir, rootRepo, allowList } = ctx;

  // 1. Check allow list (TaskCreate is handled by intercept-task hook)
  let inAllowList = false;
  for (const pattern of allowList) {
    if (!pattern) continue;
    if (toolMatchesPattern(toolName, toolInput, pattern)) {
      inAllowList = true;
      break;
    }
  }

  if (!inAllowList) {
    return { decision: "deny", reason: "Tool not in allow list" };
  }

  // 2. Special handling for Bash tool — check cd commands
  if (toolName === "Bash") {
    const command = String(toolInput.command ?? "");

    if (command.startsWith("cd ") || command === "cd") {
      // Extract cd target
      let cdTarget = command.slice(3).trim();

      // Remove surrounding quotes if present
      if ((cdTarget.startsWith('"') && cdTarget.endsWith('"')) ||
          (cdTarget.startsWith("'") && cdTarget.endsWith("'"))) {
        cdTarget = cdTarget.slice(1, -1);
      }

      // Empty cd target → allow (cd to home)
      if (!cdTarget || !cdTarget.trim()) {
        return { decision: "allow", reason: "Tool in allow list" };
      }

      // Use cd target as file_path for further path checks below
      return checkFilePath(cdTarget, cwd, toolName, ctx);
    }

    // Check bash command for references to restricted directories
    const bashDenial = checkBashCommandPaths(command, ctx);
    if (bashDenial) return bashDenial;

    // Not a cd command — allowed by allow list, no path check needed
    return { decision: "allow", reason: "Tool in allow list" };
  }

  // 3. Extract file_path or path or notebook_path from toolInput
  const filePath = (toolInput.file_path as string | undefined) ??
                   (toolInput.path as string | undefined) ??
                   (toolInput.notebook_path as string | undefined);

  if (!filePath) {
    return { decision: "allow", reason: "Tool in allow list" };
  }

  return checkFilePath(filePath, cwd, toolName, ctx);
}

/**
 * Reason string used when a bash command is denied for mutating the agent's
 * own .claude/settings*.json. Exported so tests can assert against it.
 */
export const SETTINGS_WRITE_DENY_REASON =
  "Access denied: agents cannot modify their own .claude/settings*.json (use 'ib' to change permissions)";

/**
 * Detect whether a bash command writes to <worktreePath>/.claude/settings*.json.
 *
 * Best-effort detection — perfect bash parsing isn't possible, but we cover:
 *   - `> .claude/settings*.json`   (truncate redirect)
 *   - `>> .claude/settings*.json`  (append redirect)
 *   - `sed -i ... .claude/settings*.json`  (in-place edit)
 * Both relative (`.claude/settings*.json`) and absolute
 * (`<worktreePath>/.claude/settings*.json`) forms are matched.
 *
 * Read-only commands like `cat`, `grep`, or `jq` without redirection are
 * intentionally left alone.
 */
function checkBashSettingsWrite(
  command: string,
  worktreePath: string
): HookDecision | null {
  // Match a settings file token: either a path ending in /.claude/settings*.json
  // or just .claude/settings*.json (when relative). The boundary chars are
  // start-of-string/space/quote/= on the left and end-of-string/space/quote/;/&/|
  // on the right.
  //
  // Two passes:
  //   1. Find every settings-file occurrence at a word boundary.
  //   2. For each occurrence, classify the immediate left-context as a write
  //      redirect (> / >>) or check whether the command line starts with
  //      `sed -i` and references the file as an argument.
  const settingsRe = /(^|[\s'"=])((?:\/[^\s'"=;&|<>]*)?\.claude\/settings[^\s'"=;&|<>/]*\.json)/g;
  let match: RegExpExecArray | null;
  while ((match = settingsRe.exec(command)) !== null) {
    const matchedPath = match[2]!;
    const tokenStart = match.index + match[1]!.length;

    // Only flag paths that resolve into our own .claude/. For absolute paths,
    // require the path to begin with worktreePath + "/.claude/". For relative
    // paths (starting with `.claude/`), accept unconditionally — the agent's
    // cwd is inside its worktree, so this is the only .claude/ they can write.
    if (matchedPath.startsWith("/")) {
      if (!matchedPath.startsWith(worktreePath + "/.claude/")) continue;
    } else if (!matchedPath.startsWith(".claude/")) {
      continue;
    }

    // Look back from tokenStart, skipping whitespace, to find a > or >>.
    let i = tokenStart - 1;
    while (i >= 0 && (command[i] === " " || command[i] === "\t")) i--;
    if (i >= 0 && command[i] === ">") {
      return { decision: "deny", reason: SETTINGS_WRITE_DENY_REASON };
    }
  }

  // sed -i / sed -i'<suffix>' / sed --in-place — any of these followed somewhere
  // by a settings file argument is a mutation.
  const sedInPlace = /(^|[\s;&|])sed\s+(?:-i\S*|--in-place\S*)/;
  if (sedInPlace.test(command)) {
    settingsRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = settingsRe.exec(command)) !== null) {
      const matchedPath = m[2]!;
      if (matchedPath.startsWith("/")) {
        if (!matchedPath.startsWith(worktreePath + "/.claude/")) continue;
      } else if (!matchedPath.startsWith(".claude/")) {
        continue;
      }
      return { decision: "deny", reason: SETTINGS_WRITE_DENY_REASON };
    }
  }

  return null;
}

/**
 * Check a bash command string for references to restricted directories.
 * Catches commands like `cat /repo/.ittybitty/agents/agent-other/...`
 * or commands referencing the root repo directly.
 *
 * Only checks paths at word boundaries (preceded by space, quote, =, or start of string)
 * to avoid false positives from substring matches within longer paths.
 */
function checkBashCommandPaths(
  command: string,
  ctx: PathCheckContext
): HookDecision | null {
  const { agentDir, agentsDir, worktreePath, rootRepo } = ctx;

  // Block git commands that use directory-changing flags (bypasses path isolation).
  const blockedFlag = checkGitDirectoryFlags(command);
  if (blockedFlag) {
    return { decision: "deny", reason: `The ${blockedFlag} flag is not allowed with git. Run git commands from your working directory instead.` };
  }

  // Block bash mutations of <worktreePath>/.claude/settings*.json — agents
  // must not grant themselves new permissions by rewriting their settings.
  const settingsDenial = checkBashSettingsWrite(command, worktreePath);
  if (settingsDenial) return settingsDenial;

  // Check for references to other agents' directories
  if (agentsDir) {
    const needle = agentsDir + "/";
    let pos = 0;
    while ((pos = command.indexOf(needle, pos)) !== -1) {
      // Only match at path boundaries (start of string, after space/quote/=)
      if (pos === 0 || " '\"=".includes(command[pos - 1]!)) {
        const pathFromHere = command.slice(pos);
        // Allow if the path is under our own agent directory
        if (!pathFromHere.startsWith(agentDir + "/") && !pathFromHere.startsWith(agentDir + " ")) {
          return { decision: "deny", reason: "Access denied: bash command references other agents' directory" };
        }
      }
      pos++;
    }
  }

  // Check for references to root repo (when it's not the worktree)
  if (rootRepo && rootRepo !== worktreePath) {
    const needle = rootRepo + "/";
    let pos = 0;
    while ((pos = command.indexOf(needle, pos)) !== -1) {
      // Only match at path boundaries
      if (pos === 0 || " '\"=".includes(command[pos - 1]!)) {
        const pathFromHere = command.slice(pos);
        // Allow if the path is under our own worktree
        if (!pathFromHere.startsWith(worktreePath + "/") && !pathFromHere.startsWith(worktreePath + " ") && pathFromHere !== worktreePath) {
          return { decision: "deny", reason: "Access denied: bash command references main repo" };
        }
      }
      pos++;
    }
  }

  return null;
}

/**
 * Compute the fully-resolved absolute path to an agent's Claude project
 * directory (`~/.claude/projects/<encoded-worktree>`). The directory may not
 * exist yet — in that case we fall back to the resolve() result so the match
 * against realpath'd inbound file paths still works once it's created.
 */
export function claudeProjectDirFor(worktreePath: string): string {
  const encoded = encodeClaudeProjectPath(worktreePath);
  let projectDir = resolve(join(homedir(), ".claude", "projects", encoded));
  try {
    projectDir = realpathSync(projectDir);
  } catch {
    // Directory doesn't exist yet — keep the resolve() result
  }
  return projectDir;
}

/**
 * Check whether a resolved file path is allowed.
 * Shared by both Bash cd and general file-path tools.
 */
function checkFilePath(
  rawPath: string,
  cwd: string,
  toolName: string,
  ctx: PathCheckContext
): HookDecision {
  const { agentDir, worktreePath, agentsDir, rootRepo } = ctx;

  // 4. Resolve relative to absolute using cwd
  let filePath = rawPath;
  if (!filePath.startsWith("/")) {
    filePath = join(cwd, filePath);
  }

  // 5. Normalize: resolve . and .. via path.resolve, then try realpathSync for symlinks
  filePath = resolve(filePath);
  try {
    filePath = realpathSync(filePath);
  } catch {
    // Path doesn't exist yet — keep the resolve() result
  }

  // 6. Block: writes to <worktreePath>/.claude/settings*.json — agents must
  // not grant themselves new permissions by editing their own settings file.
  // Reads are allowed; only mutation tools are blocked here.
  if (WRITE_TOOLS.has(toolName) && isWorktreeSettingsFile(filePath, worktreePath)) {
    return {
      decision: "deny",
      reason: "Access denied: agents cannot modify their own .claude/settings*.json (use 'ib' to change permissions)",
    };
  }

  // 7. Allow: path within worktree
  if (filePath.startsWith(worktreePath + "/") || filePath === worktreePath) {
    return { decision: "allow", reason: "Tool in allow list, path in worktree" };
  }

  // 8. Allow: own agent.log
  if (filePath === join(agentDir, "agent.log")) {
    return { decision: "allow", reason: "Tool in allow list, accessing own log" };
  }

  // 9. Allow: own Claude project dir (where Claude Code spills oversized tool
  // responses and stores transcripts — ~/.claude/projects/<encoded-worktree>).
  const projectDir = claudeProjectDirFor(worktreePath);
  if (filePath === projectDir || filePath.startsWith(projectDir + "/")) {
    return { decision: "allow", reason: "Tool in allow list, accessing own Claude project dir" };
  }

  // 10. Block: other agents' directories
  // Guard: an empty agentsDir means there are no sibling agents to isolate
  // against (e.g. the @system context — see hookCheckPath). Without the
  // guard, `"" + "/"` becomes `/`, which startsWith() matches against every
  // absolute path and produces a dishonest "cannot cd into other agents'
  // worktrees" denial for unrelated files.
  if (agentsDir !== "" && filePath.startsWith(agentsDir + "/")) {
    if (toolName === "Bash") {
      return { decision: "deny", reason: "Access denied: cannot cd into other agents' worktrees" };
    }
    return { decision: "deny", reason: "Access denied: cannot access other agents' files" };
  }

  // 11. Block: main repo (outside worktree)
  if (rootRepo && filePath.startsWith(rootRepo + "/") && !filePath.startsWith(worktreePath + "/")) {
    return { decision: "deny", reason: "Access denied: work in your worktree, not the main repo" };
  }

  // 12. allowedPaths-based access control
  if (ctx.allowedPaths !== undefined) {
    // allowedPaths is defined: check if path is in the list
    if (isInAllowedPaths(filePath, ctx.allowedPaths)) {
      return { decision: "allow", reason: "Tool in allow list, path in allowedPaths" };
    }
    // Path is not in allowedPaths — deny
    return { decision: "deny", reason: "Access denied: path not in allowedPaths" };
  }

  // 13. Legacy fallback: allow all other paths (system files, ~/.claude, etc.)
  return { decision: "allow", reason: "Tool in allow list" };
}

// ── ib command manager access check ─────────────────────────────────────────

/**
 * ib subcommands that require manager relationship (calling agent must be the
 * target agent's manager). Read-only / communication commands (send, look,
 * diff, status, merge-check) are intentionally excluded and remain unrestricted.
 * merge-check is read-only (checks mergeability without mutating) — workers
 * need to run it as a preflight before asking their manager to merge.
 */
const IB_MANAGER_ONLY_COMMANDS = new Set([
  "retire",
  "rehire",
  "nuke",
  "merge",
  "resume",
  "pause",
  "reassign",
]);

/**
 * Parse an `ib <subcommand> <agent-id> [flags...]` command string.
 * Returns { subcommand, targetId } when parsed, or null if not an ib command
 * that targets a specific agent.
 *
 * NOTE: This only matches commands starting with exactly "ib ". Alternate
 * invocations like `./ib retire` or `/usr/local/bin/ib retire` are not matched.
 * This is safe because agents are expected to have only `Bash(ib:*)` in their
 * allowList (not broader `Bash(*)`), so alternate paths are already blocked
 * by the allowList check before this function is called.
 */
export function parseIbCommand(command: string): { subcommand: string; targetId: string } | null {
  // Must start with "ib " or be exactly "ib"
  if (command !== "ib" && !command.startsWith("ib ")) return null;

  const parts = command.trim().split(/\s+/);
  // parts[0] = "ib", parts[1] = subcommand, parts[2] = agent-id (possibly)
  if (parts.length < 3) return null;

  const subcommand = parts[1]!;
  // Find first non-flag argument as the target ID
  const targetId = parts.slice(2).find((p) => !p.startsWith("-"));
  if (!targetId) return null;
  if (!isValidAgentId(targetId)) return null;

  return { subcommand, targetId };
}

/**
 * Check whether a Bash `ib <cmd> <target>` call is permitted for the calling
 * agent. Manager-only commands (retire, merge, nuke, etc.) require that the
 * calling agent is listed as the target's manager in meta.json.
 *
 * Returns a deny decision if the check fails, or null to continue normally.
 */
export async function checkIbCommandAccess(
  command: string,
  callingAgentId: string,
  agentsDir: string
): Promise<HookDecision | null> {
  // @system has system-wide authority; skip relationship checks. Must come
  // BEFORE callerRepoRoot resolution below — for @system, agentsDir is "" and
  // resolve("", "..", "..") would resolve relative to process.cwd(), producing
  // a misleading caller repo path. Also keeps this bypass robust against
  // future refactors that move parsing logic.
  if (callingAgentId === SYSTEM_AGENT_ID) return null;

  const parsed = parseIbCommand(command);
  if (!parsed) return null;
  if (!IB_MANAGER_ONLY_COMMANDS.has(parsed.subcommand)) return null;

  const targetId = parsed.targetId;
  const requestedSubcommand = parsed.subcommand;
  const targetMetaPath = join(agentsDir, targetId, "meta.json");
  const callerRepoRoot = resolve(agentsDir, "..", "..");

  /** Check if a meta.json grants access to the calling agent (manager or spawner).
   *
   * `meta.spawned_by.agent_id` may be a real agent ID, or an `@`-prefixed
   * sentinel. The `@<repo-name>` sentinel is owned by that repo's per-repo
   * coordinator, whose actual agent ID is the repo basename — so we grant
   * access when the caller's ID matches the repo basename and the caller is
   * a coordinator. The `@system` sentinel is never a same-agent caller (the
   * system coordinator runs from `~/.itsybitsy/`, outside any registered
   * repo), so it is ignored here.
   */
  async function hasAccess(meta: Record<string, unknown>): Promise<boolean> {
    // Allow if caller is the manager
    if (typeof meta.manager === "string" && meta.manager === callingAgentId) {
      return true;
    }
    // Allow if caller is the spawner.
    const sb = meta.spawned_by as { agent_id?: string; repo_path?: string | null } | undefined;
    if (!sb || typeof sb.agent_id !== "string") return false;

    // Real agent ID: existing path — match by ID and repo_path.
    if (!sb.agent_id.startsWith("@")) {
      if (
        sb.agent_id === callingAgentId &&
        typeof sb.repo_path === "string" &&
        resolve(sb.repo_path) === callerRepoRoot
      ) {
        return true;
      }
      return false;
    }

    // @<repo-name> sentinel: caller must be the per-repo coordinator of that
    // repo. We require all of:
    //   1. repo_path is a string and resolves to the caller's own repo root
    //   2. caller's meta.agentType === "coordinator"
    //   3. caller's agent ID matches the repo name (per-repo coordinators
    //      use the repo basename as their ID — see getCoordinatorAgentId)
    if (sb.agent_id !== SYSTEM_AGENT_ID) {
      const repoName = sb.agent_id.slice(1);
      if (typeof sb.repo_path !== "string") return false;
      if (resolve(sb.repo_path) !== callerRepoRoot) return false;
      if (callingAgentId !== repoName) return false;
      try {
        const callerMetaFile = Bun.file(join(agentsDir, callingAgentId, "meta.json"));
        if (await callerMetaFile.exists()) {
          const callerMeta = await callerMetaFile.json();
          if (callerMeta && callerMeta.agentType === "coordinator") {
            return true;
          }
        }
      } catch { /* fall through */ }
    }
    return false;
  }

  async function hasCoordinatorBypass(meta: Record<string, unknown>): Promise<boolean> {
    if (
      !["retire", "rehire", "reassign"].includes(requestedSubcommand) ||
      meta.agentType === "coordinator"
    ) return false;
    try {
      const callerMetaFile = Bun.file(join(agentsDir, callingAgentId, "meta.json"));
      if (!(await callerMetaFile.exists())) return false;
      const callerMeta = await callerMetaFile.json();
      return callerMeta?.agentType === "coordinator";
    } catch {
      return false;
    }
  }

  // Same-repo check: target exists in calling agent's repo
  try {
    const metaFile = Bun.file(targetMetaPath);
    if (await metaFile.exists()) {
      let meta: Record<string, unknown>;
      try {
        meta = await metaFile.json();
      } catch {
        // File exists but can't be parsed — deny rather than falling through
        // to cross-repo check which could match a different agent with the same ID
        return {
          decision: "deny",
          reason: `Access denied: cannot read meta for agent '${targetId}'`,
        };
      }

      // Per-repo coordinator bypass: a per-repo coordinator may run 'retire' or
      // 'reassign' on any non-coordinator agent within its own repo, even when
      // it is not the target's manager or spawner. Only applies same-repo and
      // never to other coordinators. (SPEC §12.2)
      if (await hasCoordinatorBypass(meta)) return null;

      if (await hasAccess(meta)) return null; // allow
      return {
        decision: "deny",
        reason: `Access denied: only the manager or spawner of '${targetId}' can run 'ib ${parsed.subcommand}'`,
      };
    }
  } catch { /* exists() failed — fall through to cross-repo check */ }

  // Rehire targets live under timestamped archive folders, not agents/<id>.
  // Resolve the newest recoverable same-repo archive and authorize against its
  // immutable metadata using the same manager/spawner rules as active agents.
  if (parsed.subcommand === "rehire") {
    try {
      const { findRetiredAgentArchives } = await import("../agent-lifecycle");
      const archived = (await findRetiredAgentArchives(callerRepoRoot, targetId))
        .find((entry) => entry.manifest !== null);
      if (archived) {
        const meta = archived.meta as unknown as Record<string, unknown>;
        if (await hasCoordinatorBypass(meta)) return null;
        if (await hasAccess(meta)) return null;
        return {
          decision: "deny",
          reason: `Access denied: only the manager or spawner of '${targetId}' can run 'ib rehire'`,
        };
      }
    } catch { /* fall through to cross-repo archive search */ }
  }

  // Cross-repo check: target not in this repo — search other repos
  try {
    const { listRepos } = await import("../registry");
    const repos = await listRepos();
    for (const repo of repos) {
      // Skip our own repo (already checked above)
      if (resolve(repo.path) === callerRepoRoot) continue;

      const crossMetaPath = join(repo.path, ".ittybitty", "agents", targetId, "meta.json");
      const crossMetaFile = Bun.file(crossMetaPath);
      if (await crossMetaFile.exists()) {
        let meta: Record<string, unknown>;
        try {
          meta = await crossMetaFile.json();
        } catch {
          return {
            decision: "deny",
            reason: `Access denied: cannot read meta for agent '${targetId}'`,
          };
        }
        if (await hasAccess(meta)) return null; // allow
        return {
          decision: "deny",
          reason: `Access denied: only the spawner or manager of '${targetId}' can run 'ib ${parsed.subcommand}'`,
        };
      }

      if (parsed.subcommand === "rehire") {
        const { findRetiredAgentArchives } = await import("../agent-lifecycle");
        const archived = (await findRetiredAgentArchives(repo.path, targetId))
          .find((entry) => entry.manifest !== null);
        if (archived) {
          if (await hasAccess(archived.meta as unknown as Record<string, unknown>)) {
            return null;
          }
          return {
            decision: "deny",
            reason: `Access denied: only the spawner or manager of '${targetId}' can run 'ib rehire'`,
          };
        }
      }
    }
  } catch { /* ignore — deny below */ }

  return {
    decision: "deny",
    reason: `Access denied: agent '${targetId}' not found in any registered repo`,
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI entry for hook-check-path subcommand.
 * Reads stdin JSON, resolves context, calls checkPathAccess(), outputs JSON.
 */
export async function hookCheckPath(agentId: string, rawStdin?: string): Promise<void> {
  // Read JSON from stdin (use pre-read value if provided)
  const raw = rawStdin ?? await new Response(Bun.stdin.stream()).text();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    process.stderr.write(`hook-check-path: failed to parse stdin JSON: ${raw.slice(0, 200)}\n`);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Failed to parse stdin" } }));
    return;
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    process.stderr.write(`hook-check-path: stdin is not a JSON object\n`);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  const data = json as Record<string, unknown>;

  // Validate tool_name is a string
  if (data.tool_name !== undefined && typeof data.tool_name !== "string") {
    process.stderr.write(`hook-check-path: tool_name is not a string\n`);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  // Validate tool_input is a non-null object
  if (data.tool_input !== undefined && (typeof data.tool_input !== "object" || data.tool_input === null)) {
    process.stderr.write(`hook-check-path: tool_input is not an object\n`);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  const toolName: string = (data.tool_name as string) ?? "";
  const toolInput: Record<string, unknown> = (data.tool_input as Record<string, unknown>) ?? {};
  const cwd: string = (data.cwd as string) ?? process.cwd();

  let agentsDir: string;
  let agentDir: string;
  let worktreePath: string;
  let allowedPaths: string[] | undefined = undefined;
  let rootRepo = "";

  if (agentId === SYSTEM_AGENT_ID) {
    // System coordinator: it owns its own directory entirely. There is no
    // outer agents-dir to isolate against and no main-repo to block.
    // Treating ~/.itsybitsy/ as both agentDir and worktreePath lets the
    // existing path checks (worktree-contains, agentsDir-blocks, rootRepo-blocks)
    // degrade naturally:
    //   - agentsDir = ""     → cross-agent blocks never fire.
    //   - rootRepo = worktree → main-repo block never fires.
    //   - allowedPaths = undefined → legacy permissive fallback.
    const resolved = resolveAgentFromCwd(cwd);
    // Prefer the resolved home (handles symlinked HOME) when available.
    const home = resolved?.agentDir ?? join(process.env.HOME ?? "", ".itsybitsy");
    agentsDir = "";
    agentDir = home;
    worktreePath = home;
    rootRepo = home;
  } else {
    // Resolve agent directory from cwd pattern
    // cwd is typically: .../.ittybitty/agents/{id}/repo/...
    const cwdMatch = cwd.match(/(.*\/.ittybitty\/agents)/);
    agentsDir = resolve(cwdMatch ? cwdMatch[1]! : join(process.cwd(), ".ittybitty", "agents"));

    agentDir = join(agentsDir, agentId);
    worktreePath = join(agentDir, "repo");
    let isNoWorktree = false;

    // Resolve worktree to absolute path if it exists
    try {
      worktreePath = await realpath(worktreePath);
    } catch {
      // Worktree dir doesn't exist — agent may be a non-worktree agent (e.g., coordinator)
      isNoWorktree = true;
    }

    // Read meta.json for worktree field and allowedPaths
    try {
      const metaFile = Bun.file(join(agentDir, "meta.json"));
      if (await metaFile.exists()) {
        const meta = await metaFile.json();
        if (meta.worktree === false) isNoWorktree = true;
        // Parse allowedPaths from meta.json (should be an array of strings or undefined)
        if (Array.isArray(meta.allowedPaths)) {
          allowedPaths = (meta.allowedPaths as unknown[]).filter((p): p is string => typeof p === "string");
        }
      }
    } catch { /* ignore */ }

    // For non-worktree agents (e.g., coordinators), worktreePath is the repo root
    if (isNoWorktree) {
      // Derive repo root: agents dir is <repo>/.ittybitty/agents
      const repoRoot = resolve(agentsDir, "..", "..");
      worktreePath = repoRoot;
    }

    // Detect root repo via git worktree list --porcelain
    try {
      const proc = Bun.spawn(
        ["git", "-C", worktreePath, "worktree", "list", "--porcelain"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const match = output.match(/^worktree (.+)$/m);
        if (match) {
          rootRepo = resolve(match[1]!);
        }
      }
    } catch { /* ignore */ }

    // PreToolUse fires before every tool call — flip state to 'running' so
    // tmux send-keys messages from other agents (e.g. notify_manager) and
    // background-tool completions don't leave the agent stuck at 'waiting'.
    // Skipped for @system because there is no meta.json to write to.
    await writeAgentState(agentDir, "running");
  }

  // Read settings.local.json for allow list (works for both @system and worktree agents)
  let allowList: string[] = [];
  try {
    const settingsPath = join(worktreePath, ".claude", "settings.local.json");
    const settingsFile = Bun.file(settingsPath);
    if (await settingsFile.exists()) {
      const settings = await settingsFile.json();
      if (Array.isArray(settings?.permissions?.allow)) {
        allowList = settings.permissions.allow;
      }
    }
  } catch { /* ignore */ }

  // Check ib manager-only command access before path checks
  const ctx = { agentId, agentDir, worktreePath, agentsDir, rootRepo, allowList, allowedPaths };
  let decision: HookDecision;
  if (toolName === "Bash") {
    const command = String(toolInput.command ?? "");
    decision = await checkIbCommandAccess(command, agentId, agentsDir)
      ?? checkPathAccess({ toolName, toolInput, cwd }, ctx);
  } else {
    decision = checkPathAccess({ toolName, toolInput, cwd }, ctx);
  }

  // Log denials
  if (decision.decision === "deny") {
    const params = formatToolInput(toolInput);
    const suffix = params ? ` (${params})` : "";
    await logAgent(agentDir, `[PreToolUse] Permission denied: ${toolName}${suffix}`);
  }

  // Output JSON decision
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  };

  console.log(JSON.stringify(output));
}

/** Format tool input params for logging (compact key=value pairs) */
function formatToolInput(toolInput: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(toolInput)) {
    if (typeof value === "string") {
      const truncated = value.length > 60 ? value.slice(0, 57) + "..." : value;
      parts.push(`${key}=${truncated}`);
    }
  }
  return parts.join(", ");
}

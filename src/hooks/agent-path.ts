/**
 * PreToolUse path isolation hook.
 * Ported from ib bash script's check_pretooluse_access().
 *
 * Enforces that agents can only access files within their own worktree,
 * their own agent.log, and general system paths.
 */

import { join, resolve, dirname, basename } from "path";
import { userHome } from "../home";
import { realpath, stat } from "fs/promises";
import { realpathSync } from "fs";
import { logAgent } from "../agent-lifecycle";
import { writeAgentState } from "../agents";
import { isValidAgentId } from "../validation";
import { checkGitDirectoryFlags, resolveAgentFromCwd, SYSTEM_AGENT_ID } from "./shared";
import { AGY_WORKTREE_FILES } from "../agy-worktree-files";
import { heredocBodyRanges } from "./shell-metachar";
import {
  buildAgentAccessTable,
  buildSystemAccessTable,
  claudeProjectDirFor,
  pathDenialReason,
} from "./paths-table";
import { canonicalizeSandboxPath, resolvePreparedAccess, type PathOperation, type PreparedAccessTable } from "../sandbox";

// Re-exported for existing callers/tests that import it from this module; the
// definition moved to ./paths-table to break the import cycle.
export { claudeProjectDirFor };

/**
 * Deny reason for a bash token that mixes a `..` path segment with shell
 * expansion/quoting we cannot resolve safely (empty quotes, `$…`, `${…}`,
 * backticks, backslashes, a leading `~`). Rather than emulate the shell, the
 * traversal scanner fails closed on these.
 */
export const TRAVERSAL_NOISE_DENY_REASON =
  "Access denied: path contains `..` combined with shell expansion or quoting that cannot be resolved safely. " +
  "If this is literal text (a commit message, an `ib send` body), put it in a quoted-delimiter heredoc " +
  "(<<'EOF' … EOF) or pass it via a file (e.g. `git commit -F <file>`) instead of on the command line.";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PathCheckInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
}

/**
 * A path whose WRITES are denied while reads are left untouched — a structural
 * guard, NOT a `paths.deny` entry (deny would block reads too, and every agent
 * legitimately reads these files). Enforced BEFORE the resolver even though the
 * resolver's runtime roots would otherwise grant the write (e.g. AGENTDIR is a
 * kernel write root; @system's whole `~/.itsybitsy` is its worktree root).
 */
export interface ProtectedWritePath {
  /** Canonical absolute path. */
  path: string;
  /** true → the path and everything under it; false → exactly this file. */
  subtree: boolean;
  /** The deny reason, naming the file, shown in the Denials tab. */
  reason: string;
}

export interface PathCheckContext {
  agentId: string;
  agentDir: string;
  worktreePath: string;
  agentsDir: string;
  rootRepo: string;
  allowList: string[];
  /**
   * The prepared filesystem access table (meta.paths ∪ the spawn-keyed runtime
   * roots, plus the tmux-socket deny), built once per hook invocation by
   * buildAgentAccessTable / buildSystemAccessTable. A missing paths block
   * produces empty allow lists — so anything outside the runtime roots is
   * denied. There is no "undefined means allow" mode: the field is required.
   */
  access: PreparedAccessTable;
  /**
   * Files/dirs whose WRITES are denied (reads untouched). For a normal agent:
   * its own `<agentDir>/meta.json`. For @system: the agent-types dir, config.json,
   * repos.json, layout.json and the sealed dir under `~/.itsybitsy`, none of
   * which @system may rewrite to widen itself (its worktree root is its whole home).
   */
  protectedWritePaths: ProtectedWritePath[];
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

// ── Settings file protection ─────────────────────────────────────────────────

/**
 * Tool names that mutate files. Used to gate the settings*.json write block —
 * Read/Glob/Grep/LS on settings.json must still be allowed. MultiEdit is
 * included so an agent (claude directly, or agy via multi_replace_file_content)
 * cannot rewrite its own .claude/settings.local.json to self-escalate.
 */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

/** File tools whose schemas require one of the supported path fields. */
const REQUIRED_PATH_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "LS"]);

/** Search tools may omit their path and search relative to the hook cwd. */
const CWD_FALLBACK_PATH_TOOLS = new Set(["Glob", "Grep"]);

/** Path fields understood across Claude, codex synthesis, and agy translation. */
const TOOL_PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

/** Build a stable fail-closed reason for malformed nested tool input. */
function invalidToolInputReason(detail: string): HookDecision {
  return { decision: "deny", reason: `Invalid tool input schema: ${detail}` };
}

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

/** Deny reason for mutating an agy agent's own hook/rule boundary files. */
export const AGY_BOUNDARY_WRITE_DENY_REASON =
  "Access denied: agents cannot modify their own agy hook/rule files (.agents/hooks.json, .agents/rules/ittybitty-agent.md)";

/**
 * Deny reason for an agent writing its OWN `<agentDir>/meta.json`. The hook
 * reads its path lists (and canSpawnChildren) from that file at every call, so
 * an agent that could rewrite it could widen its own access. In kernel mode the
 * frozen profile + sealed record already stop this; the hook adds the same guard
 * for hook-only mode (sandbox disabled, agy, Linux). Mirrors the settings-file
 * rule. Exported so tests can assert against it.
 */
export const META_WRITE_DENY_REASON =
  "Access denied: agents cannot modify their own meta.json (the hook reads its path lists from it)";

/**
 * Deny reason for a WRITE to a protected coordinator-configuration path (the
 * @system agent-types dir, config.json, repos.json, layout.json, sealed). Names
 * the file so the Denials tab shows exactly what was refused. Reads are allowed.
 * Exported so tests can assert against it.
 */
export function protectedConfigWriteDenyReason(path: string): string {
  return `Access denied: ${path} is a protected coordinator configuration path (agents may read it, not modify it — use 'ib' to change configuration)`;
}

/**
 * The protected-write list for a normal worktree agent: only its own meta.json
 * (the hook reads its path lists and canSpawnChildren from it).
 *
 * The path is canonicalized (longest-existing-prefix, resolving symlinks) so it
 * matches the realpath'd inbound path in checkFilePath even when a parent
 * directory is a symlink — `agentDir` here is derived from cwd and is NOT
 * necessarily realpath'd.
 */
export function agentProtectedWritePaths(agentDir: string): ProtectedWritePath[] {
  return [{
    path: canonicalizeSandboxPath(join(agentDir, "meta.json")),
    subtree: false,
    reason: META_WRITE_DENY_REASON,
  }];
}

/**
 * The protected-write list for the @system coordinator, whose worktree root is
 * its whole `~/.itsybitsy` home: the agent-types dir (widening its own layers),
 * config.json / repos.json / layout.json (widening the harness), and the sealed
 * dir. `itsybitsyHome` is the resolved `~/.itsybitsy` directory. Each path is
 * canonicalized (symlink-resolving) so a symlinked parent cannot defeat the
 * match against the realpath'd inbound path.
 */
export function systemProtectedWritePaths(itsybitsyHome: string): ProtectedWritePath[] {
  const dir = (name: string): ProtectedWritePath => {
    const p = canonicalizeSandboxPath(join(itsybitsyHome, name));
    return { path: p, subtree: true, reason: protectedConfigWriteDenyReason(p) };
  };
  const file = (name: string): ProtectedWritePath => {
    const p = canonicalizeSandboxPath(join(itsybitsyHome, name));
    return { path: p, subtree: false, reason: protectedConfigWriteDenyReason(p) };
  };
  return [
    dir("agent-types"),
    file("config.json"),
    file("repos.json"),
    file("layout.json"),
    dir("sealed"),
  ];
}

/**
 * Return the deny reason if `filePath` is a protected WRITE target, else null.
 * A subtree entry matches the path and everything under it; a file entry matches
 * exactly. Shared by the file-tool check (step 6) and the Bash redirect/sed guard.
 */
export function matchProtectedWrite(
  protectedWritePaths: ProtectedWritePath[],
  filePath: string,
): string | null {
  for (const entry of protectedWritePaths) {
    if (entry.subtree) {
      if (filePath === entry.path || filePath.startsWith(entry.path + "/")) return entry.reason;
    } else if (filePath === entry.path) {
      return entry.reason;
    }
  }
  return null;
}

/**
 * Deny reason when `meta.json` is missing or unparseable. The hook builds its
 * access table from `meta.paths`; without a readable meta there is no table, so
 * it fails CLOSED rather than falling back to a permissive default (the
 * invariant: missing == deny). Exported so tests can assert against it.
 */
export const META_UNREADABLE_DENY_REASON =
  "Access denied: meta.json is missing or unreadable — cannot resolve the agent's path lists";

/**
 * Classify a write target as a PROTECTED worktree file that agents must not
 * rewrite — either `.claude/settings*.json` (permission self-escalation) or an
 * agy boundary file (`.agents/hooks.json` / the always-on rule file, whose
 * rewrite would disable the hook gate on the next resume). Returns the kind so
 * the caller picks the right deny reason, or null for any other path. Reads are
 * never gated here — only the WRITE_TOOLS callers consult this.
 */
export function worktreeProtectedFileKind(
  filePath: string,
  worktreePath: string,
): "settings" | "agy" | null {
  if (isWorktreeSettingsFile(filePath, worktreePath)) return "settings";
  for (const rel of AGY_WORKTREE_FILES) {
    if (filePath === join(worktreePath, rel)) return "agy";
  }
  return null;
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

  if (typeof cwd !== "string") {
    return invalidToolInputReason("cwd must be a string");
  }

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
    if (typeof toolInput.command !== "string") {
      return invalidToolInputReason("Bash requires a string command");
    }
    const command = toolInput.command;

    if (command.startsWith("cd ") || command === "cd") {
      // Extract cd target
      let cdTarget = command.slice(3).trim();

      // Remove surrounding quotes if present
      if ((cdTarget.startsWith('"') && cdTarget.endsWith('"')) ||
          (cdTarget.startsWith("'") && cdTarget.endsWith("'"))) {
        cdTarget = cdTarget.slice(1, -1);
      }

      // Empty cd target → the shell would cd to the home directory. Check it
      // like any other path (read op) rather than auto-allowing: home is not a
      // runtime root, so a strict agent is denied — matching the invariant.
      if (!cdTarget || !cdTarget.trim()) {
        cdTarget = userHome();
      }

      // Use cd target as file_path for further path checks below
      return checkFilePath(cdTarget, cwd, toolName, ctx);
    }

    // Check bash command for references to restricted directories
    const bashDenial = checkBashCommandPaths(command, cwd, ctx);
    if (bashDenial) return bashDenial;

    // Not a cd command — allowed by allow list, no path check needed
    return { decision: "allow", reason: "Tool in allow list" };
  }

  // 3. Extract file_path / path / notebook_path without coercion. A present
  // malformed field fails closed; required-path tools also deny when none is
  // present. Glob/Grep deliberately support their schemas' cwd fallback, but
  // still run that fallback through the same structural/resolver checks.
  let filePath: string | undefined;
  for (const key of TOOL_PATH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(toolInput, key)) continue;
    const value = toolInput[key];
    if (typeof value !== "string" || value.length === 0) {
      return invalidToolInputReason(`${toolName}.${key} must be a non-empty string path`);
    }
    if (filePath === undefined) {
      filePath = value;
    }
  }

  if (filePath === undefined) {
    if (REQUIRED_PATH_TOOLS.has(toolName)) {
      return invalidToolInputReason(`${toolName} requires a path argument`);
    }
    if (CWD_FALLBACK_PATH_TOOLS.has(toolName)) {
      return checkFilePath(cwd, cwd, toolName, ctx);
    }
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
 * Detect a bash command that WRITES (redirect `>`/`>>` or in-place `sed -i`) to
 * one of the agent's protected files — `.claude/settings*.json` (permission
 * self-escalation), the agy boundary files (`.agents/hooks.json` / the rule
 * file, whose rewrite disables the hook gate on the next resume), or any
 * `protectedWritePaths` entry (a normal agent's own `<agentDir>/meta.json`, or
 * @system's agent-types/config/sealed). The hook can tell the agent's redirect
 * from `ib` writing the file, because it sees the command; the kernel cannot.
 *
 * Each candidate write-target token is RESOLVED against cwd (join + resolve +
 * realpathSync-when-it-exists, the same way checkFilePath does) and compared with
 * the resolved protected files via `worktreeProtectedFileKind` and
 * `matchProtectedWrite`, rather than literal-matching the raw token. That closes
 * obfuscated spellings the old regex missed — `.agents/rules/../hooks.json`,
 * `./.agents/hooks.json`, and the absolute `…/.agents/rules/../hooks.json` (and
 * the same for `.claude/settings` and the protected paths).
 *
 * Best-effort target extraction: a `>` / `>>` token's following token (or a
 * glued `>file`), and — when `sed -i` / `--in-place` is present — every token as
 * a possible file argument. Reads without redirection are left alone.
 */
function checkBashSettingsWrite(
  command: string,
  cwd: string,
  worktreePath: string,
  protectedWritePaths: ProtectedWritePath[]
): HookDecision | null {
  // Resolve one candidate write-target token and deny if it lands on a protected
  // file. Strips one layer of surrounding quotes first.
  const denyForTarget = (rawToken: string): HookDecision | null => {
    let t = rawToken;
    if (
      t.length >= 2 &&
      ((t[0] === "'" && t[t.length - 1] === "'") || (t[0] === '"' && t[t.length - 1] === '"'))
    ) {
      t = t.slice(1, -1);
    }
    if (!t) return null;
    // Redirect and sed targets support the same leading home anchors as the
    // advisory Bash scanner. Expand before canonicalization so @system cannot
    // address a protected file as ~/.itsybitsy/config.json, $HOME/…, or
    // ${HOME}/… and have the raw spelling miss the protected-path table.
    if (startsWithPathAnchor(t)) {
      t = expandBashPathPortion(t, userHome());
    }
    const absolute = t.startsWith("/") ? resolve(t) : resolve(join(cwd, t));
    // Resolve the longest existing parent as well as the leaf. Redirect
    // targets commonly do not exist yet, and on macOS /var aliases
    // /private/var; exact-only realpath would leave that spelling mismatch.
    const resolved = canonicalizeSandboxPath(absolute);
    const kind = worktreeProtectedFileKind(resolved, worktreePath);
    if (kind === "settings") return { decision: "deny", reason: SETTINGS_WRITE_DENY_REASON };
    if (kind === "agy") return { decision: "deny", reason: AGY_BOUNDARY_WRITE_DENY_REASON };
    const protectedReason = matchProtectedWrite(protectedWritePaths, resolved);
    if (protectedReason) return { decision: "deny", reason: protectedReason };
    return null;
  };

  const tokens = command.split(/\s+/);

  // Redirect targets: an optional fd digit(s) or `&`, then `>` / `>>`, then an
  // optional `|` force-clobber, then either the following token (with a space)
  // or a glued target — so `>`, `>>`, `1>`, `2>>`, `&>`, `>|`, and `1>|file` are
  // all covered.
  for (let idx = 0; idx < tokens.length; idx++) {
    const m = tokens[idx]!.match(/^(?:&|\d+)?(>>?)\|?(.*)$/);
    if (!m) continue;
    const gluedTarget = m[2]!;
    if (gluedTarget) {
      const d = denyForTarget(gluedTarget);
      if (d) return d;
    } else {
      const target = tokens[idx + 1];
      if (target) {
        const d = denyForTarget(target);
        if (d) return d;
      }
    }
  }

  // sed -i / sed -i'<suffix>' / sed --in-place: any file argument that resolves
  // to a protected file is an in-place mutation.
  const sedInPlace = /(^|[\s;&|])sed\s+(?:-i\S*|--in-place\S*)/;
  if (sedInPlace.test(command)) {
    for (const tok of tokens) {
      const d = denyForTarget(tok);
      if (d) return d;
    }
  }

  return null;
}

/**
 * Replace every heredoc BODY range (from heredocBodyRanges) with spaces so the
 * body — data like commit messages and `ib send` payloads that legitimately
 * carries `..`, apostrophes and absolute paths — is never tokenized, while every
 * char offset OUTSIDE the bodies stays put. Shared by the relative-traversal
 * scanner and the advisory Bash path scanner so both agree on what is data.
 */
function maskHeredocBodies(command: string): string {
  const bodyRanges = heredocBodyRanges(command);
  if (bodyRanges.length === 0) return command;
  let out = "";
  let pos = 0;
  for (const r of [...bodyRanges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(pos, r.start);
    if (start > pos) out += command.slice(pos, start);
    const end = Math.min(command.length, r.end);
    if (end > start) out += " ".repeat(end - start);
    pos = Math.max(pos, end);
  }
  out += command.slice(pos);
  return out;
}

/**
 * Detect a RELATIVE-path traversal in a bash command that escapes the worktree
 * into another agent's directory or the main checkout. The absolute-needle
 * scans (checkBashCommandPaths) only catch absolute references — a relative
 * `../..` resolves identically at the shell but has no absolute needle to match.
 *
 * The shell can rewrite a token in ways `path.resolve` cannot follow — empty
 * quotes (`../..''/x`), parameter expansion (`${FOO:-../..}/x`), brace
 * expansion (`../..{,}/x`), backslashes (`..\/..\/x`), a leading `~`. Rather
 * than emulate more of the shell, this scanner is CONSERVATIVE: after the
 * whitespace split and stripping only surrounding quotes, a token that contains
 * `..` AND any in-token shell-noise character (single/double quote, `$`, `{`,
 * `}`, backtick, backslash, or a LEADING `~`) is DENIED outright — it "cannot be
 * resolved safely". Git ranges (`HEAD..main`, `origin/main..origin/dev`,
 * `HEAD~2..HEAD^`) carry no noise (the `~`/`^` sit mid-token) and pass through.
 *
 * Only CLEAN tokens go through the segment logic. `..` is a traversal risk only
 * when it is a WHOLE path segment (`form.split("/")` contains `".."`). Each
 * candidate form is resolved against `cwd` and gated by the same two rules the
 * absolute needles use:
 *   - inside `agentsDir` but outside this agent's own `agentDir` → deny
 *   - inside `rootRepo` (the main checkout) but outside the worktree → deny
 * A path resolving to (or under) the agent's own `agentDir` — e.g. bare `..`
 * from the worktree — stays allowed, and anything resolving entirely outside the
 * repo is left to the same (permissive) treatment absolute references get.
 *
 * Glued FLAG prefixes still need care even when clean: `--output=../../x` hides
 * the path from `path.resolve` (which treats `--output=..` as a directory NAME).
 * So for a clean token we test up to FOUR forms and deny if ANY escapes: the
 * whole token; the suffix from the first `..` (drops the glued prefix); and,
 * when the token has `=`, the right-hand side plus its own suffix-from-first-`..`.
 * Over-denial for contrived shapes like `a/b/../../..` is accepted as the safe
 * direction.
 *
 * Heredoc BODY lines are excluded (masked to spaces) before tokenizing — they
 * are data (commit messages, `ib send` bodies) that legitimately contain `..`
 * and apostrophes. The opener line and lines after the terminator stay scanned.
 *
 * Known safe-direction OVER-denies (denied though harmless; the caller-facing
 * reason names the workarounds — a quoted-delimiter heredoc or `-F <file>`):
 *   - `printf '..\n'` — a quoted `..` argument carrying a backslash.
 *   - a one-line `git commit -m "…"` or `ib send <id> "…"` where a word ending
 *     in `..` is glued to the closing quote (e.g. `…resolver.."`) — the split
 *     token `resolver.."` strips the quote to `resolver..` and reads as a `..`
 *     path segment.
 *   - a quoted RELATIVE path containing a space (the whitespace split breaks the
 *     quoted argument, so an inner `../x` token is examined on its own).
 */
function checkRelativeTraversalPaths(
  command: string,
  cwd: string,
  ctx: PathCheckContext
): HookDecision | null {
  const { agentDir, agentsDir, worktreePath, rootRepo } = ctx;

  // Return a deny decision when `resolved` escapes into another agent's dir or
  // the main checkout; null when it is the agent's own dir or outside the repo.
  const escapeDenial = (resolved: string): HookDecision | null => {
    // The agent's own directory (and anything under it) is allowed — bare `..`
    // from the worktree lands on agentDir, mirroring an absolute self-reference.
    if (resolved === agentDir || resolved.startsWith(agentDir + "/")) return null;
    // Inside another agent's directory (under agentsDir, not our own) → deny.
    if (agentsDir && resolved.startsWith(agentsDir + "/")) {
      return { decision: "deny", reason: "Access denied: bash command references other agents' directory" };
    }
    // Inside the main checkout but outside the worktree → deny.
    if (
      rootRepo &&
      rootRepo !== worktreePath &&
      (resolved === rootRepo || resolved.startsWith(rootRepo + "/")) &&
      resolved !== worktreePath &&
      !resolved.startsWith(worktreePath + "/")
    ) {
      return { decision: "deny", reason: "Access denied: bash command references main repo" };
    }
    return null;
  };

  // Mask heredoc body lines (data) to spaces so they aren't tokenized, keeping
  // char offsets stable for everything else.
  const scannable = maskHeredocBodies(command);

  for (let token of scannable.split(/\s+/)) {
    if (!token) continue;
    // Strip only one layer of surrounding matching quotes (what the shell peels
    // off before the path is used). We deliberately do NOT try to emulate any
    // other shell rewriting — see the noise rule below.
    if (
      token.length >= 2 &&
      ((token[0] === "'" && token[token.length - 1] === "'") ||
        (token[0] === '"' && token[token.length - 1] === '"'))
    ) {
      token = token.slice(1, -1);
    }
    if (!token.includes("..")) continue; // no traversal risk

    // Noise rule: a `..` mixed with shell expansion/quoting/globbing we can't
    // resolve safely — fail closed rather than guess how the shell rewrites it.
    // Globs (`*?[]`) are included because a `..` token like
    // `../../../../../itsyb*/SPEC.md` matches the repo dir name at runtime but
    // resolves to a literal (non-escaping) segment here.
    if (/['"$`{}\\*?[\]]/.test(token) || token.startsWith("~")) {
      return { decision: "deny", reason: TRAVERSAL_NOISE_DENY_REASON };
    }

    // Clean token → resolve the candidate forms (whole, suffix-from-first-`..`,
    // and the `=` RHS with its own suffix) and deny if any escapes.
    const candidates = new Set<string>();
    const addForms = (s: string) => {
      if (s) candidates.add(s);
      const idx = s.indexOf("..");
      if (idx > 0) candidates.add(s.slice(idx)); // suffix dropping a glued prefix
    };
    addForms(token);
    const eq = token.indexOf("=");
    if (eq !== -1) addForms(token.slice(eq + 1)); // RHS of `--flag=<path>`

    for (const cand of candidates) {
      // Absolute paths are handled by the needle scans; skip them here.
      if (cand.startsWith("/")) continue;
      // Only forms where `..` is a whole path segment (excludes `HEAD..main`).
      if (!cand.split("/").includes("..")) continue;
      const denial = escapeDenial(resolve(cwd, cand));
      if (denial) return denial;
    }
  }
  return null;
}

// ── Advisory Bash path scanner (SPEC-PATH-ALLOWLIST.md §6.6) ──────────────────

/** Verbs whose every path-looking argument is a WRITE target. */
const BASH_WRITE_ALL_ARGS = new Set(["mkdir", "touch", "rm", "rmdir", "chmod"]);

/**
 * The deny reason for a path-looking Bash token that carries shell
 * expansion/quoting the string scanner cannot resolve safely (a leftover quote,
 * a `$` other than the leading `$HOME`, a backtick, a brace, or a backslash).
 * Fails closed like the traversal scanner and names the token plus the fix.
 */
export function bashPathNoiseDenyReason(token: string): string {
  return (
    `Access denied: path-looking argument \`${token}\` mixes shell expansion or quoting ` +
    `that cannot be resolved safely. If this is literal text (a commit message, an ` +
    `\`ib send\` body), put it in a quoted-delimiter heredoc (<<'EOF' … EOF) or pass it ` +
    `via a file (e.g. \`git commit -F <file>\`) instead of on the command line.`
  );
}

/** Does a (quote-stripped) string begin with a path anchor the scanner resolves? */
function startsWithPathAnchor(s: string): boolean {
  return (
    s.startsWith("/") ||
    s === "~" ||
    s.startsWith("~/") ||
    s === "$HOME" ||
    s.startsWith("$HOME/") ||
    s === "${HOME}" ||
    s.startsWith("${HOME}/")
  );
}

/** Strip the one matching quote layer that the simple Bash tokenizer supports. */
function stripBashSurroundingQuotes(token: string): string {
  if (
    token.length >= 2 &&
    ((token[0] === "'" && token[token.length - 1] === "'") ||
      (token[0] === '"' && token[token.length - 1] === '"'))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Return the path PORTION of a token if it is path-looking, else null:
 *   - a bare path anchor (`/x`, `~`, `~/x`, `$HOME/x`, `${HOME}/x`);
 *   - a `--flag=<path>` whose right-hand side is a path anchor;
 *   - a glued short flag `-X<path>` whose right-hand side is a path anchor.
 * A token that starts with a letter, a digit, a URL scheme, a git range, or a
 * dash with no path suffix returns null — it is never a path.
 */
function bashPathPortion(token: string): string | null {
  if (startsWithPathAnchor(token)) return token;
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    if (eq > 2) {
      // --flag=<path>
      const rhs = token.slice(eq + 1);
      return startsWithPathAnchor(rhs) ? rhs : null;
    }
    return null;
  }
  if (token.startsWith("-") && token.length > 2) {
    // -X<path>: X is exactly one short-option character and the right-hand
    // side starts immediately after it. Do not reinterpret a value such as
    // `-abc/etc` as the unrelated absolute path `/etc`.
    const rhs = token.slice(2);
    if (startsWithPathAnchor(rhs)) return rhs;
  }
  return null;
}

/**
 * True when a path PORTION carries shell noise the scanner cannot resolve: a
 * quote, backtick, brace, backslash, or a `$` that is NOT the leading `$HOME` /
 * `${HOME}`. Glob chars (`*?[]`) are deliberately NOT noise — the caller reduces
 * a glob to its literal directory prefix instead.
 */
function bashPathPortionIsNoise(portion: string): boolean {
  let rest = portion;
  if (rest.startsWith("${HOME}")) rest = rest.slice("${HOME}".length);
  else if (rest.startsWith("$HOME")) rest = rest.slice("$HOME".length);
  return /['"`{}\\$]/.test(rest);
}

/** Expand a leading `~` / `$HOME` / `${HOME}` in a noise-free portion to an absolute path. */
function expandBashPathPortion(portion: string, home: string): string {
  if (portion === "~") return home;
  if (portion.startsWith("~/")) return join(home, portion.slice(2));
  if (portion === "$HOME" || portion === "${HOME}") return home;
  if (portion.startsWith("$HOME/")) return join(home, portion.slice("$HOME/".length));
  if (portion.startsWith("${HOME}/")) return join(home, portion.slice("${HOME}/".length));
  return portion; // already absolute
}

/** Reduce an absolute path that may contain a glob to the literal directory before the first `*`/`?`/`[`. */
function bashLiteralDirPrefix(absPath: string): string {
  const globIdx = absPath.search(/[*?[]/);
  if (globIdx === -1) return absPath;
  const slashIdx = absPath.lastIndexOf("/", globIdx);
  return slashIdx <= 0 ? "/" : absPath.slice(0, slashIdx);
}

/**
 * Advisory scan of a Bash command line for path-looking arguments that the
 * per-agent access table (`ctx.access`) denies — the visibility layer required
 * by SPEC-PATH-ALLOWLIST.md §8 (2026-09-05): kernel denials never reach
 * `agent.log`, so the Denials tab of `ib watch` only sees command-line paths
 * that the HOOK denies. It never allows what the table denies and never denies
 * what the table allows: each candidate is resolved through the SAME
 * `resolvePreparedAccess` the file-tool check uses, with the reason worded by
 * `pathDenialReason`. Runs after the structural checks (traversal, protected
 * writes, cross-agent and main-repo needles), which fire first with their own
 * reasons. Only invoked from the Bash branch of checkPathAccess, so it covers
 * claude Bash, the agy `run_command` translated to Bash, and the codex shell.
 *
 * Operation class (SPEC §6.11 item 8): a redirect target (`>`/`>>`/`1>`/`2>`/
 * `&>`/`>|`, glued or separate), a `sed -i` / `--in-place` argument, a `tee`
 * argument, the last argument of `cp`/`mv`, and every argument of `mkdir`,
 * `touch`, `rm`, `rmdir`, `chmod` are WRITES; every other path-looking token is
 * a READ. The protected-file guard (checkBashSettingsWrite) already ran first.
 */
function scanBashCommandPaths(
  command: string,
  cwd: string,
  ctx: PathCheckContext,
): HookDecision | null {
  const home = userHome();
  // Heredoc bodies are data — never scan them (mirrors the traversal scanner).
  const tokens = maskHeredocBodies(command).split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  // Resolve one candidate path against the table for the given op; deny (with the
  // resolver's own reason) only when the resolver denies. cwd is unused for
  // absolute/home-expanded candidates but kept for symmetry with the file check.
  const denyIfRejected = (
    portion: string,
    op: PathOperation,
    rawToken: string,
  ): HookDecision | null => {
    if (bashPathPortionIsNoise(portion)) {
      return { decision: "deny", reason: bashPathNoiseDenyReason(rawToken) };
    }
    const abs = bashLiteralDirPrefix(expandBashPathPortion(portion, home));
    try {
      // Literal needles cannot see a symlink alias into the main checkout or
      // another agent. Apply the same structural boundary as file tools after
      // resolving the candidate, before an authored allow can grant it.
      const canonical = canonicalizeSandboxPath(abs);
      const boundaryDenial = checkWorktreeBoundary(canonical, ctx);
      if (boundaryDenial) return boundaryDenial;
      if (resolvePreparedAccess(ctx.access, canonical, op) === "deny") {
        return { decision: "deny", reason: pathDenialReason(ctx.access, canonical, op) };
      }
    } catch {
      // This scanner is the only path fence in hook-only mode. An unexpected
      // resolver failure must fail closed; allowing here could turn a malformed
      // spelling into a write the access table would have denied.
      return { decision: "deny", reason: bashPathNoiseDenyReason(rawToken) };
    }
    return null;
  };

  // ── Classify write-target token indices ──
  const forcedWriteIndex = new Set<number>();
  const redirectSyntaxIndex = new Set<number>();
  const redirectTargetIndex = new Set<number>();
  const gluedWriteTargets: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    // A redirect operator: optional fd digits or `&`, then `>`/`>>`, an optional
    // `|` force-clobber, then either a glued target or (empty) the next token.
    const m = tokens[i]!.match(/^(?:&|\d+)?(>>?)\|?(.*)$/);
    if (!m) continue;
    redirectSyntaxIndex.add(i);
    if (m[2]) gluedWriteTargets.push(m[2]);
    else {
      forcedWriteIndex.add(i + 1);
      redirectTargetIndex.add(i + 1);
    }
  }

  const verb = tokens[0]!;
  const sedInPlace = /(^|[\s;&|])sed\s+(?:-i\S*|--in-place\S*)/.test(command);
  const sedIndex = sedInPlace ? tokens.indexOf("sed") : -1;
  const teeIndex = tokens.indexOf("tee");
  const isCpMv = verb === "cp" || verb === "mv";
  const isWriteVerb = BASH_WRITE_ALL_ARGS.has(verb);
  let cpMvWriteIndex = -1;
  if (isCpMv) {
    // Redirections are shell syntax, not cp/mv arguments. Select the final
    // command argument after excluding both redirect operators and their
    // separate targets, so `cp src /dest > /log` still treats /dest as WRITE.
    for (let i = 1; i < tokens.length; i++) {
      if (redirectSyntaxIndex.has(i) || redirectTargetIndex.has(i)) continue;
      cpMvWriteIndex = i;
    }
  }

  const opForIndex = (i: number): PathOperation => {
    if (forcedWriteIndex.has(i)) return "write";
    if (sedIndex !== -1 && i > sedIndex) return "write";
    if (teeIndex !== -1 && i > teeIndex) return "write";
    if (isWriteVerb && i > 0) return "write";
    if (i === cpMvWriteIndex) return "write";
    return "read";
  };

  // A glued redirect target (`>/tmp/x`, `2>>log`) is always a WRITE.
  for (const target of gluedWriteTargets) {
    // The shell accepts a quote layer immediately after the operator, as in
    // `>"/tmp/x"`; normalize it just like an ordinary whitespace token.
    const portion = bashPathPortion(stripBashSurroundingQuotes(target));
    if (portion === null) continue;
    const d = denyIfRejected(portion, "write", target);
    if (d) return d;
  }

  for (let i = 0; i < tokens.length; i++) {
    const rawToken = tokens[i]!;
    // Strip one layer of surrounding matching quotes (what the shell peels off).
    const token = stripBashSurroundingQuotes(rawToken);
    const portion = bashPathPortion(token);
    if (portion === null) continue;
    const d = denyIfRejected(portion, opForIndex(i), rawToken);
    if (d) return d;
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
  cwd: string,
  ctx: PathCheckContext
): HookDecision | null {
  const { agentDir, agentsDir, worktreePath, rootRepo } = ctx;

  // Block git commands that use directory-changing flags (bypasses path isolation).
  const blockedFlag = checkGitDirectoryFlags(command);
  if (blockedFlag) {
    return { decision: "deny", reason: `The ${blockedFlag} flag is not allowed with git. Run git commands from your working directory instead.` };
  }

  // Block RELATIVE-path traversal that escapes the worktree. The absolute-needle
  // scans below only catch absolute references; a relative `../..` resolves the
  // same way at the shell but slips past them. Resolve every token that carries
  // a `..` path SEGMENT against the call's cwd and apply the same rules as the
  // absolute needles.
  const traversalDenial = checkRelativeTraversalPaths(command, cwd, ctx);
  if (traversalDenial) return traversalDenial;

  // Block bash mutations of the agent's protected files (.claude/settings*.json,
  // the agy boundary files, and every ctx.protectedWritePaths entry — a normal
  // agent's own meta.json, or @system's config/agent-types/sealed) — agents must
  // not grant themselves new permissions, disable their own hook gate, or rewrite
  // the files the hook and harness read their configuration from.
  const settingsDenial = checkBashSettingsWrite(command, cwd, worktreePath, ctx.protectedWritePaths);
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
    const needle = rootRepo;
    let pos = 0;
    while ((pos = command.indexOf(needle, pos)) !== -1) {
      const beforeIsBoundary = pos === 0 || /[\s'"=|;&<>()]/.test(command[pos - 1]!);
      const afterRoot = command[pos + needle.length];
      const afterIsBoundary =
        afterRoot === undefined || afterRoot === "/" || /[\s'"`|;&<>()]/.test(afterRoot);
      if (beforeIsBoundary && afterIsBoundary) {
        const pathFromHere = command.slice(pos);
        const afterWorktree = pathFromHere[worktreePath.length];
        const isOwnWorktree =
          pathFromHere.startsWith(worktreePath) &&
          (afterWorktree === undefined || afterWorktree === "/" || /[\s'"`|;&<>()]/.test(afterWorktree));
        if (!isOwnWorktree) {
          return { decision: "deny", reason: "Access denied: bash command references main repo" };
        }
      }
      pos++;
    }
  }

  // Advisory: resolve every path-looking argument against the access table so a
  // command reaching outside the allowed roots is denied with a readable reason
  // and logged to the Denials tab (kernel denials never reach agent.log). Runs
  // LAST so the structural checks above keep their specific reasons.
  const scanDenial = scanBashCommandPaths(command, cwd, ctx);
  if (scanDenial) return scanDenial;

  return null;
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
  const { worktreePath } = ctx;

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

  // The structural steps (6, 10, 11) run BEFORE the resolver so the hook stays
  // STRICTER than the kernel inside the agent dir and the main repo: the
  // resolver's table lists AGENTDIR / GITDIR / REPOAGENTS as runtime roots (to
  // match what the kernel grants), but the hook must still refuse an agent
  // rewriting its own meta.json, reaching a sibling's dir, or touching the main
  // checkout's .git through a file tool. Steps 7/8/9/12/13 are folded into the
  // single resolvePreparedAccess call at the end.

  // 6. Block: writes to a PROTECTED file — <worktreePath>/.claude/settings*.json
  // (permission self-escalation), the agy boundary files (.agents/hooks.json /
  // the rule file, whose rewrite disables the hook gate on the next resume), or
  // any ctx.protectedWritePaths entry (a normal agent's own meta.json; for
  // @system the agent-types dir, config.json, repos.json, layout.json, sealed —
  // all self-widening). Reads are allowed; only mutation tools are blocked.
  if (WRITE_TOOLS.has(toolName)) {
    const kind = worktreeProtectedFileKind(filePath, worktreePath);
    if (kind === "settings") return { decision: "deny", reason: SETTINGS_WRITE_DENY_REASON };
    if (kind === "agy") return { decision: "deny", reason: AGY_BOUNDARY_WRITE_DENY_REASON };
    const protectedReason = matchProtectedWrite(ctx.protectedWritePaths, filePath);
    if (protectedReason) return { decision: "deny", reason: protectedReason };
  }

  const boundaryDenial = checkWorktreeBoundary(filePath, ctx, toolName);
  if (boundaryDenial) return boundaryDenial;

  // Resolver: the worktree, own agent.log's dir, project dir, scratchpad and any
  // configured paths.allow* are runtime/allow entries in the table; everything
  // else is denied (empty lists => deny by default). Write tools resolve as a
  // write op; reads (and cd) as a read op.
  const op: PathOperation = WRITE_TOOLS.has(toolName) ? "write" : "read";
  const decision = resolvePreparedAccess(ctx.access, filePath, op);
  if (decision === "allow") {
    return { decision: "allow", reason: `Tool in allow list, ${op} ${filePath} permitted by paths` };
  }
  return { decision: "deny", reason: pathDenialReason(ctx.access, filePath, op) };
}

/** Structural steps shared by file tools, cd, and canonical Bash candidates. */
function checkWorktreeBoundary(
  filePath: string,
  ctx: PathCheckContext,
  toolName = "Read",
): HookDecision | null {
  const { agentDir, worktreePath, agentsDir, rootRepo } = ctx;

  // 10. Block: other agents' directories, and the agent's OWN dir except its
  // worktree and its agent.log. The worktree (a runtime root) and the own log
  // are allowed via the resolver below; everything else under the agent dir —
  // meta.json, prompt.txt, outbox, etc. — stays denied here, keeping the hook
  // stricter than the kernel's AGENTDIR write root.
  // Guard: an empty agentsDir means there are no sibling agents to isolate
  // against (e.g. the @system context — see hookCheckPath). Without the guard,
  // `"" + "/"` becomes `/`, which startsWith() matches every absolute path.
  if (agentsDir !== "" && filePath.startsWith(agentsDir + "/")) {
    const inWorktree = filePath === worktreePath || filePath.startsWith(worktreePath + "/");
    const isOwnLog = filePath === join(agentDir, "agent.log");
    if (!inWorktree && !isOwnLog) {
      if (toolName === "Bash") {
        return { decision: "deny", reason: "Access denied: cannot cd into other agents' worktrees" };
      }
      return { decision: "deny", reason: "Access denied: cannot access other agents' files" };
    }
  }

  // 11. Block: main repo (outside worktree). The worktree itself and paths under
  // it are excluded (they are allowed by the resolver); the main checkout's .git
  // — a kernel write root — stays denied to file tools here. The agents dir is
  // excluded too — it lives under the main repo but is step 10's domain (which
  // already allowed the worktree + own agent.log and denied the rest), so
  // step 11 must not re-block the own agent.log that step 10 let through.
  if (
    rootRepo &&
    (filePath === rootRepo || filePath.startsWith(rootRepo + "/")) &&
    filePath !== worktreePath &&
    !filePath.startsWith(worktreePath + "/") &&
    !(agentsDir !== "" && filePath.startsWith(agentsDir + "/"))
  ) {
    return { decision: "deny", reason: "Access denied: work in your worktree, not the main repo" };
  }

  return null;
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
      const archives = await findRetiredAgentArchives(callerRepoRoot, targetId);
      const archived =
        archives.find((entry) => entry.manifest !== null) ?? archives[0];
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
        const archives = await findRetiredAgentArchives(repo.path, targetId);
        const archived =
          archives.find((entry) => entry.manifest !== null) ?? archives[0];
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
  try {
    await hookCheckPathImpl(agentId, rawStdin);
  } catch (err) {
    // Last-ditch explicit deny: Claude treats a hook crash as an unreliable
    // boundary. Keep this outside the implementation so unexpected failures
    // during stdin reads, context resolution, state writes, or logging cannot
    // escape without a deny decision.
    const detail = err instanceof Error ? err.message : String(err);
    try {
      process.stderr.write(`hook-check-path: unexpected processing failure: ${detail}\n`);
    } catch { /* best effort */ }
    try {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Unexpected hook processing failure: ${detail}`,
        },
      }));
    } catch { /* no remaining output channel */ }
  }
}

async function hookCheckPathImpl(agentId: string, rawStdin?: string): Promise<void> {
  // Read JSON from stdin (use pre-read value if provided)
  const raw = rawStdin ?? await new Response(Bun.stdin.stream()).text();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Malformed stdin → DENY (fail closed). Historically this allowed; the
    // invariant (SPEC §8) requires no fail-open answer here.
    process.stderr.write(`hook-check-path: failed to parse stdin JSON: ${raw.slice(0, 200)}\n`);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Failed to parse stdin" } }));
    return;
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    process.stderr.write(`hook-check-path: stdin is not a JSON object\n`);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  const data = json as Record<string, unknown>;

  // Validate tool_name is a string
  if (data.tool_name !== undefined && typeof data.tool_name !== "string") {
    process.stderr.write(`hook-check-path: tool_name is not a string\n`);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  // Validate tool_input is a non-null object
  if (
    data.tool_input !== undefined &&
    (typeof data.tool_input !== "object" || data.tool_input === null || Array.isArray(data.tool_input))
  ) {
    process.stderr.write(`hook-check-path: tool_input is not an object\n`);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  if (data.cwd !== undefined && typeof data.cwd !== "string") {
    process.stderr.write(`hook-check-path: cwd is not a string\n`);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Invalid stdin schema" } }));
    return;
  }

  const toolName: string = (data.tool_name as string) ?? "";
  const toolInput: Record<string, unknown> = (data.tool_input as Record<string, unknown>) ?? {};
  const cwd: string = (data.cwd as string) ?? process.cwd();

  let agentsDir: string;
  let agentDir: string;
  let worktreePath: string;
  let rootRepo = "";
  // The prepared access table for this invocation. Both branches assign it or
  // return early on a build failure — there is no permissive default.
  let access!: PreparedAccessTable;
  // Files/dirs whose writes are denied structurally (reads untouched).
  let protectedWritePaths: ProtectedWritePath[] = [];

  if (agentId === SYSTEM_AGENT_ID) {
    // System coordinator: it owns its own directory entirely. There is no
    // outer agents-dir to isolate against and no main-repo to block.
    //   - agentsDir = ""     → cross-agent blocks never fire.
    //   - rootRepo = worktree → main-repo block never fires.
    // Its path lists come from _all.md ∪ system.md (buildSystemAccessTable),
    // resolved live; a missing list there is strict (deny), never permissive.
    const resolved = resolveAgentFromCwd(cwd);
    // Prefer the resolved home (handles symlinked HOME) when available.
    const home = resolved?.agentDir ?? join(userHome(), ".itsybitsy");
    agentsDir = "";
    agentDir = home;
    worktreePath = home;
    rootRepo = home;
    // @system's worktree root is its whole ~/.itsybitsy home, so the resolver
    // would grant writes to the agent-types dir and the harness config files;
    // deny those writes structurally so @system cannot widen itself.
    protectedWritePaths = systemProtectedWritePaths(home);
    try {
      access = await buildSystemAccessTable(userHome());
    } catch {
      // Even a layer-load failure must not fail open.
      await emitPathDecision(agentDir, toolName, toolInput, {
        decision: "deny",
        reason: META_UNREADABLE_DENY_REASON,
      });
      return;
    }
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

    // Read meta.json — REQUIRED. The hook resolves its path lists from it, so a
    // missing or unparseable meta.json DENIES (fail closed) rather than building
    // a permissive table (the invariant, SPEC-PATH-ALLOWLIST.md §8).
    let meta: Record<string, unknown> | null = null;
    try {
      const metaFile = Bun.file(join(agentDir, "meta.json"));
      if (await metaFile.exists()) {
        const parsed = await metaFile.json();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          meta = parsed as Record<string, unknown>;
        }
      }
    } catch { meta = null; }
    if (!meta) {
      await emitPathDecision(agentDir, toolName, toolInput, {
        decision: "deny",
        reason: META_UNREADABLE_DENY_REASON,
      });
      return;
    }
    if (meta.worktree === false) isNoWorktree = true;

    // For non-worktree agents (e.g., coordinators), worktreePath is the repo root
    if (isNoWorktree) {
      // Derive repo root: agents dir is <repo>/.ittybitty/agents
      const repoRoot = resolve(agentsDir, "..", "..");
      worktreePath = repoRoot;
    }

    // Detect root repo via git worktree list --porcelain
    try {
      const proc = Bun.spawn(
        ["git", "worktree", "list", "--porcelain"],
        { cwd: worktreePath, stdout: "pipe", stderr: "pipe" }
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

    // A normal agent may not rewrite its own meta.json (the hook reads its path
    // lists and canSpawnChildren from it).
    protectedWritePaths = agentProtectedWritePaths(agentDir);

    // Build the access table from meta.paths ∪ the spawn-keyed runtime roots. A
    // build failure (e.g. an invalid frozen paths block) denies, never fails open.
    try {
      access = await buildAgentAccessTable({
        meta,
        agentDir,
        worktreePath,
        agentsDir,
        rootRepo,
        home: userHome(),
      });
    } catch {
      await emitPathDecision(agentDir, toolName, toolInput, {
        decision: "deny",
        reason: META_UNREADABLE_DENY_REASON,
      });
      return;
    }
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
  const ctx: PathCheckContext = { agentId, agentDir, worktreePath, agentsDir, rootRepo, allowList, access, protectedWritePaths };
  let decision: HookDecision;
  if (toolName === "Bash") {
    const command = String(toolInput.command ?? "");
    decision = await checkIbCommandAccess(command, agentId, agentsDir)
      ?? checkPathAccess({ toolName, toolInput, cwd }, ctx);
  } else {
    decision = checkPathAccess({ toolName, toolInput, cwd }, ctx);
  }

  await emitPathDecision(agentDir, toolName, toolInput, decision);
}

/**
 * Emit a PreToolUse hook decision: log denials to agent.log and print the JSON
 * contract. The log keeps the exact `[PreToolUse] Permission denied: <tool>
 * <suffix>` prefix that parseDenials (src/agents.ts) matches, and appends
 * ` — <reason>` so the Denials tab of `ib watch` shows the operation, the
 * resolved path, and the rule that denied it.
 */
async function emitPathDecision(
  agentDir: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  decision: HookDecision,
): Promise<void> {
  if (decision.decision === "deny") {
    const params = formatToolInput(toolInput);
    const suffix = params ? ` (${params})` : "";
    await logAgent(agentDir, `[PreToolUse] Permission denied: ${toolName}${suffix} — ${decision.reason}`);
  }
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  }));
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

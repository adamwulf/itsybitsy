/**
 * Builds the codex CLI launch argument array per SPEC-CODEX-MODEL.md §5.4.
 *
 * Codex has no `permissions.allow/deny` array equivalent and no on-disk
 * config layer that itsybitsy uses: per the Phase 2 spike, the only reliable
 * way to register a PreToolUse hook in a per-agent worktree is via inline
 * `-c hooks.PreToolUse=[...]` CLI overrides. This module emits exactly those
 * `-c` flags for the three events itsybitsy wires (PreToolUse, SessionStart,
 * Stop), each pointing at an `ib hooks codex-<event> <agentId>` dispatcher.
 *
 * This module is INTENTIONALLY scoped to launch-flag construction. The
 * mandatory `--dangerously-bypass-hook-trust` flag, the model flags
 * (`-m`/`-a`/`-s`), and the actual spawn-time integration with `start.sh` are
 * Phase 4 work.
 */

import { homedir } from "os";
import { join } from "path";
import { isValidAgentId } from "./validation";
import { getCoordinatorHome } from "./coordinator";

/** Hook events codex fires that itsybitsy registers a handler for. */
export type CodexHookEvent = "PreToolUse" | "SessionStart" | "Stop";

/** Default hook timeout in seconds; matches the Phase 2 spike's verified value. */
export const DEFAULT_CODEX_HOOK_TIMEOUT_SECS = 30;

/** Map each hook event to the ib subcommand that handles it. */
const HOOK_DISPATCHER: Record<CodexHookEvent, string> = {
  PreToolUse: "codex-pre-tool-use",
  SessionStart: "codex-session-start",
  Stop: "codex-stop",
};

/**
 * Hook events registered on every codex agent spawn, in stable order.
 * The order is documented (PreToolUse first, then state hooks) so the
 * resulting CLI line is deterministic across runs.
 */
export const CODEX_REGISTERED_EVENTS: readonly CodexHookEvent[] = [
  "PreToolUse",
  "SessionStart",
  "Stop",
];

export interface BuildCodexLaunchArgsInput {
  /** Absolute path to the `ib` binary used to dispatch hook calls. */
  ibBinaryPath: string;
  /** Agent ID — must satisfy `isValidAgentId`. Interpolated into the hook command. */
  agentId: string;
  /**
   * Absolute path to the agent's directory (the directory that already
   * houses meta.json, agent.log, claude.stderr.log, watchdog.log). Codex's
   * `log_dir` is set to `<agentDir>/codex` so its plaintext TUI log lives
   * alongside the rest of the per-agent diagnostics. archiveAgent moves
   * `<agentDir>` wholesale, so no separate cleanup is needed.
   *
   * Must be quote-safe: the path is interpolated into a TOML string literal
   * which sits inside a shell single-quoted argument. `'`, `"`, `\`, and
   * control characters are rejected at build time.
   */
  agentDir: string;
  /** Optional override for the per-hook timeout in seconds. */
  timeoutSecs?: number;
  /**
   * Extra directories Codex should treat as writable while in workspace-write
   * mode. Used for git worktrees: the working tree lives under the agent dir,
   * but git metadata writes go through the resolved common git dir.
   */
  extraWritableRoots?: string[];
}

export interface CodexLaunchArgs {
  /** Final flat argv suffix (already includes the `-c flag` pairs). */
  args: string[];
}

/**
 * Reject ib-binary paths that would break the TOML-in-shell quoting in the
 * inline `-c` payload. The path lives inside a TOML double-quoted string,
 * which itself sits inside a shell single-quoted argument. A `'` would close
 * the shell argument; a `"` or `\` would corrupt the TOML; control characters
 * are rejected as defense-in-depth.
 *
 * itsybitsy's default install paths are safe; this guards user-customized
 * installs in paths with apostrophes or quotes.
 */
export function isCodexSafeBinaryPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("'") || path.includes('"') || path.includes("\\")) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Render a single inline `-c hooks.<event>=[...]` flag payload (without the
 * leading `-c` token). Splitting this out lets the tests parse-and-inspect
 * the TOML body for each event independently.
 */
export function renderCodexHookFlagPayload(
  event: CodexHookEvent,
  ibBinaryPath: string,
  agentId: string,
  timeoutSecs: number,
): string {
  const cmd = `${ibBinaryPath} hooks ${HOOK_DISPATCHER[event]} ${agentId}`;
  return `hooks.${event}=[{matcher=".*",hooks=[{type="command",command="${cmd}",timeout=${timeoutSecs}}]}]`;
}

/**
 * Build the `-c` flag array that codex consumes to register itsybitsy's
 * PreToolUse + SessionStart + Stop hooks for a given agent.
 *
 * Per SPEC §5.4:
 *   - One `-c 'hooks.<Event>=[{...}]'` flag per registered event.
 *   - `command` interpolates the absolute path to `ib` with the agent ID.
 *   - `<abs ib>` MUST be path-safe (no apostrophes/quotes/backslashes/control chars).
 *   - `<agentId>` MUST satisfy `isValidAgentId` (no shell-metachar risk).
 *
 * Throws a descriptive error rather than returning a malformed flag list when
 * any precondition fails — callers handle the spawn rejection.
 */
export function buildCodexLaunchArgs(input: BuildCodexLaunchArgsInput): CodexLaunchArgs {
  const { ibBinaryPath, agentId, agentDir } = input;
  const timeoutSecs = input.timeoutSecs ?? DEFAULT_CODEX_HOOK_TIMEOUT_SECS;

  if (!isCodexSafeBinaryPath(ibBinaryPath)) {
    throw new Error(
      `Unsafe ib binary path for codex launch: ${JSON.stringify(ibBinaryPath)} contains quotes, backslashes, or control characters. ` +
        `Reinstall ib to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
    );
  }
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for codex launch: ${JSON.stringify(agentId)}`);
  }
  // agentDir is interpolated into the inline `-c log_dir="…"` TOML string
  // which itself sits inside a shell single-quoted argument. Reuse the
  // ib-binary-path safety predicate — the character set we forbid (apostrophe,
  // double-quote, backslash, control chars) is the same for both contexts.
  if (!isCodexSafeBinaryPath(agentDir)) {
    throw new Error(
      `Unsafe agent directory path for codex launch: ${JSON.stringify(agentDir)} contains quotes, backslashes, or control characters. ` +
        `Move the agent directory to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
    );
  }
  if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0 || !Number.isInteger(timeoutSecs)) {
    throw new Error(`Invalid codex hook timeout: ${timeoutSecs}`);
  }

  const args: string[] = [];
  // Always grant the codex agent write access to the entire coordinator home
  // (`~/.itsybitsy/`). Codex agents run with `-s workspace-write`, which only
  // permits writes inside the worktree and explicit `--add-dir` roots — without
  // this, `ib send <other-agent> ...` (per-agent outbox under `agents/`),
  // `ib send @<team>` (team channels under `teams/`), and team membership writes
  // (`teams.json`) would all fail with EPERM. One root covers every piece of
  // centralized state and any future additions. The trust boundary is identical
  // to giving the agent the `ib` binary at all.
  const coordinatorHome = getCoordinatorHome();
  if (!isCodexSafeBinaryPath(coordinatorHome)) {
    throw new Error(
      `Unsafe coordinator home for codex launch: ${JSON.stringify(coordinatorHome)} contains quotes, backslashes, or control characters. ` +
        `Reinstall ib so the coordinator home lives at a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
    );
  }
  args.push("--add-dir", coordinatorHome);
  // Always grant write access to ~/Library/Caches. macOS toolchains (SwiftPM,
  // xcodebuild's manifest loader, Homebrew helpers, Xcode itself) write
  // diagnostics, package manifests, and intermediate artifacts here BEFORE
  // any `-derivedDataPath` redirection takes effect. Without this, even a
  // simple `xcodebuild build` aborts during package resolution with EPERM on
  // ~/Library/Caches/org.swift.swiftpm. The directory is shared user state
  // (every macOS app writes to it), so the trust boundary is no narrower than
  // giving the agent the `ib` binary at all.
  const libraryCaches = join(process.env.HOME ?? homedir(), "Library", "Caches");
  if (!isCodexSafeBinaryPath(libraryCaches)) {
    throw new Error(
      `Unsafe Library/Caches path for codex launch: ${JSON.stringify(libraryCaches)} contains quotes, backslashes, or control characters. ` +
        `Move $HOME to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
    );
  }
  args.push("--add-dir", libraryCaches);
  for (const root of input.extraWritableRoots ?? []) {
    if (!isCodexSafeBinaryPath(root)) {
      throw new Error(
        `Unsafe extra writable root for codex launch: ${JSON.stringify(root)} contains quotes, backslashes, or control characters. ` +
          `Move the directory to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
      );
    }
    args.push("--add-dir", root);
  }
  for (const event of CODEX_REGISTERED_EVENTS) {
    args.push("-c", renderCodexHookFlagPayload(event, ibBinaryPath, agentId, timeoutSecs));
  }
  // Disable codex's native multi-agent collaboration tools (spawn_agent,
  // send_input, resume_agent, wait_agent, close_agent). All sub-agent spawning
  // MUST go through `ib new-agent` so the harness owns the lifecycle
  // (meta.json, watchdog, path-isolation, tracked tmux session). The claude
  // side enforces this via the intercept-task hook; this is the codex
  // equivalent — codex's native tools cannot fire if the feature is off.
  args.push("-c", "features.multi_agent=false");
  // Allow outbound network access under workspace-write. Claude agents already
  // have unrestricted network; matching that for codex unblocks SwiftPM /
  // package-manager fetches (e.g. xcodebuild resolving GitHub-hosted deps).
  // Revisit when we add per-agent-type capability gating.
  args.push("-c", "sandbox_workspace_write.network_access=true");
  // Disable the "Co-authored-by: Codex <noreply@openai.com>" commit trailer.
  // codex's commit_attribution is a TOML string — an empty string in TOML
  // is `""` (two adjacent double quotes); when codex sees this it skips
  // appending the trailer entirely. User preference: commits made by codex
  // agents should look like normal local commits.
  args.push("-c", 'commit_attribution=""');
  // Redirect codex's log dir into <agentDir>/codex so the plaintext TUI log
  // (codex-tui.log, opt-in only when log_dir is set explicitly) lives next
  // to the other per-agent diagnostics. archiveAgent() moves <agentDir>
  // wholesale, so the codex/ subdir gets cleaned up with the agent. Codex
  // creates the directory on first write — we don't pre-create it.
  args.push("-c", `log_dir="${agentDir}/codex"`);
  // Suppress codex's onboarding tooltips on the TUI welcome screen — they
  // clutter the pane the watchdog scrapes for state.
  args.push("-c", "tui.show_tooltips=false");
  // Keep Codex's native status line useful inside the manager pane. Show the
  // model, context budget, and ChatGPT session/weekly usage limits.
  args.push("-c", 'tui.status_line=["model-with-reasoning","context-remaining","five-hour-limit","weekly-limit"]');
  return { args };
}

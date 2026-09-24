/**
 * Antigravity CLI (`agy`) worktree-file + trust helpers (SPEC-ANTIGRAVITY-CLI.md
 * §4.2). Pure builders plus the two on-disk mutations the spawn path composes:
 *
 *   1. `.agents/hooks.json` — registers itsybitsy's PreToolUse / PreInvocation /
 *      Stop hooks under the named hook `ittybitty` (D3). This is the ONLY
 *      permission boundary — there is no sandbox, no `--add-dir` (D3).
 *   2. `.agents/rules/ittybitty-agent.md` — the always-on rule file carrying the
 *      agent's role instructions + the skills catalog (D6). Project and
 *      user-wide instructions are not copied in: agy reads the repo's own
 *      `AGENTS.md` and its global `~/.gemini/GEMINI.md` natively.
 *   3. The `trustedWorkspaces` entry in `~/.gemini/antigravity-cli/settings.json`
 *      (D5): the worktree MUST be pre-trusted before launch or `-i` runs the
 *      first turn before the trust card is answered, with no hooks loaded.
 *
 * No subprocesses are spawned from this module. Spawn/resume wiring is Phase 2.
 */

import { join, dirname } from "path";
import { userHome } from "./home";
import { mkdir, open, stat, unlink, rename } from "fs/promises";
import { isValidAgentId } from "./validation";
import { isCodexSafeBinaryPath } from "./codex-config";
import type { SessionContext } from "./hooks/session-start";
import { buildAgentRoleBody } from "./agent-instructions-shared";

/** Default hook timeout in seconds — matches the codex default and D3's value. */
export const DEFAULT_AGY_HOOK_TIMEOUT_SECS = 30;

// The two files itsybitsy writes into an agy agent's worktree (D3 + D6) live in
// the neutral src/agy-worktree-files.ts so the shared path guard can reference
// them too. Re-exported here so existing importers keep resolving it from
// "./agy-config". Both are appended to the worktree `.gitignore`; a spawn is
// refused (Phase 2) if either is already tracked in the repo (D7).
export { AGY_WORKTREE_FILES } from "./agy-worktree-files";

/** Hook events agy fires that itsybitsy registers a handler for, in stable order. */
const AGY_HOOK_DISPATCHER = {
  PreToolUse: "agy-pre-tool-use",
  PreInvocation: "agy-pre-invocation",
  Stop: "agy-stop",
} as const;

export interface BuildAgyHooksJsonInput {
  /** Absolute path to the `ib` binary used to dispatch hook calls. */
  ibBinaryPath: string;
  /** Agent id — must satisfy `isValidAgentId`. Interpolated into the hook command. */
  agentId: string;
  /** Optional override for the per-hook timeout in seconds. */
  timeoutSecs?: number;
}

/**
 * Build the JSON text for `<worktree>/.agents/hooks.json` (D3). Registers the
 * three itsybitsy hooks under the named hook `ittybitty`. `command` runs under
 * `sh -c`, so `<abs ib>` must be path-safe (no apostrophes / quotes /
 * backslashes / control chars — reuse `isCodexSafeBinaryPath`) and `<agentId>`
 * must satisfy `isValidAgentId`.
 *
 * PreToolUse carries a `matcher: "*"` + `hooks[]` wrapper; PreInvocation and
 * Stop are direct command entries in an array (matching the agy 1.1.23 schema
 * captured in ANTIGRAVITY-CLI-NOTES.md §17).
 *
 * Throws a descriptive error rather than returning a malformed file when any
 * precondition fails — callers handle the spawn rejection.
 */
export function buildAgyHooksJson(input: BuildAgyHooksJsonInput): string {
  const { ibBinaryPath, agentId } = input;
  const timeoutSecs = input.timeoutSecs ?? DEFAULT_AGY_HOOK_TIMEOUT_SECS;

  if (!isCodexSafeBinaryPath(ibBinaryPath)) {
    throw new Error(
      `Unsafe ib binary path for agy launch: ${JSON.stringify(ibBinaryPath)} contains quotes, backslashes, or control characters. ` +
        `Reinstall ib to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
    );
  }
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for agy hooks.json: ${JSON.stringify(agentId)}`);
  }
  if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0 || !Number.isInteger(timeoutSecs)) {
    throw new Error(`Invalid agy hook timeout: ${timeoutSecs}`);
  }

  const cmd = (event: keyof typeof AGY_HOOK_DISPATCHER): string =>
    `${ibBinaryPath} hooks ${AGY_HOOK_DISPATCHER[event]} ${agentId}`;

  const doc = {
    ittybitty: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: cmd("PreToolUse"), timeout: timeoutSecs }],
        },
      ],
      PreInvocation: [{ type: "command", command: cmd("PreInvocation"), timeout: timeoutSecs }],
      Stop: [{ type: "command", command: cmd("Stop"), timeout: timeoutSecs }],
    },
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Build the body for `<worktree>/.agents/rules/ittybitty-agent.md` (D6). The
 * always-on rule file frontmatter is followed by:
 *   - the session-start instruction template (wrapper stripped),
 *   - the skills catalog.
 *
 * The same role content codex receives as `developer_instructions`, with the
 * `trigger: always_on` frontmatter so agy loads it alongside the repo's own
 * `AGENTS.md`. Project and user-wide instructions are not copied in: agy reads
 * the repo's `AGENTS.md` natively and its user-wide `~/.gemini/GEMINI.md` (a
 * symlink to `~/.claude/CLAUDE.md` shares one file with Claude).
 */
export async function buildAgyRulesFile(ctx: SessionContext): Promise<string> {
  const frontmatter =
    "---\ntrigger: always_on\ndescription: itsybitsy agent instructions\n---\n";
  return frontmatter + (await buildAgentRoleBody(ctx));
}

// The generalized `.gitignore` append helper (`appendGitignoreEntries`) lives in
// the neutral `src/worktree-gitignore.ts` so neither CLI module depends on the
// other. The Phase 2 agy spawn path composes it with `AGY_WORKTREE_FILES`.

// ── Workspace trust (~/.gemini/antigravity-cli/settings.json) ────────────────

/**
 * Absolute path to agy's settings file. HOME-relative so tests can point at a
 * temp HOME (the real file is never touched in tests).
 */
export function agySettingsPath(): string {
  const home = userHome();
  return join(home, ".gemini", "antigravity-cli", "settings.json");
}

/** Advisory lock path guarding itsybitsy's own read-modify-write of the settings file. */
export function agySettingsLockPath(): string {
  const home = userHome();
  return join(home, ".itsybitsy", ".agy-settings.lock");
}

/**
 * Run `fn` while holding an advisory lock on the agy settings file (same
 * pattern as the outbox lock: O_CREAT|O_EXCL create, retry with backoff to
 * ~5s, steal a stale lock older than 30s). The lock protects itsybitsy from
 * itsybitsy — a concurrent agy-driven rewrite is a separate risk covered by
 * the watchdog fallback (SPEC §6 risk 2).
 */
async function withAgySettingsLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = agySettingsLockPath();
  await mkdir(dirname(lockPath), { recursive: true });
  const timeoutMs = 5000;
  const backoffMs = 25;
  const staleMs = 30_000;
  const deadline = Date.now() + timeoutMs;
  let held = false;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      held = true;
      break;
    } catch (err) {
      if ((err as { code?: string })?.code !== "EEXIST") throw err;
      // Held by someone. Steal if the lock looks stale (crashed holder).
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // Lock vanished between EEXIST and stat — retry immediately.
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`could not acquire agy settings lock at ${lockPath}`);
    }
    await Bun.sleep(backoffMs);
  }
  try {
    return await fn();
  } finally {
    if (held) await unlink(lockPath).catch(() => {});
  }
}

/**
 * Read the agy settings JSON object.
 *
 * A MISSING file (or a genuinely empty one — nothing to preserve) returns `{}`.
 * An EXISTING file that fails to parse, or parses to something other than a
 * JSON object, THROWS a descriptive error rather than returning `{}` — the
 * caller (ensureAgyTrustedWorkspace) would otherwise rewrite the file with only
 * `trustedWorkspaces`, silently destroying whatever the user had there. Failing
 * loud lets the spawn refuse and leaves the user's file untouched.
 */
async function readAgySettings(): Promise<Record<string, unknown>> {
  const path = agySettingsPath();
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const raw = await file.text();
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `agy settings file at ${path} is not valid JSON (${(err as Error).message}); ` +
        `refusing to overwrite it — fix or remove the file and retry.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `agy settings file at ${path} is not a JSON object; ` +
        `refusing to overwrite it — fix or remove the file and retry.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Atomically write the agy settings object (tmp + rename), creating dirs. */
async function writeAgySettings(obj: Record<string, unknown>): Promise<void> {
  const path = agySettingsPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await Bun.write(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, path);
}

/**
 * Read the current `trustedWorkspaces` array, defaulting to [] for a missing
 * or non-array value (defensive — a malformed value can't be meaningfully
 * preserved, so it's rebuilt).
 */
function readTrustedWorkspaces(settings: Record<string, unknown>): string[] {
  const tw = settings.trustedWorkspaces;
  if (Array.isArray(tw)) return tw.filter((p): p is string => typeof p === "string");
  return [];
}

/**
 * Add `realWorktree` to `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`
 * (D5). Read-modify-write under the advisory lock, preserving every other key,
 * atomic tmp+rename. Idempotent — an already-trusted path is a no-op (but the
 * file may still be normalized on rewrite). Pass the REALPATH of the worktree
 * so it matches the path agy resolves.
 */
export async function ensureAgyTrustedWorkspace(realWorktree: string): Promise<void> {
  await withAgySettingsLock(async () => {
    const settings = await readAgySettings();
    const trusted = readTrustedWorkspaces(settings);
    if (trusted.includes(realWorktree)) {
      // Already present — but only skip the write if the stored value was
      // already a clean array (nothing to normalize).
      if (Array.isArray(settings.trustedWorkspaces)) return;
    }
    if (!trusted.includes(realWorktree)) trusted.push(realWorktree);
    settings.trustedWorkspaces = trusted;
    await writeAgySettings(settings);
  });
}

/**
 * Remove `realWorktree` from `trustedWorkspaces` (D5 teardown). Read-modify-write
 * under the advisory lock, preserving every other key. Idempotent and best-effort
 * — a missing file or absent entry is a no-op.
 */
export async function removeAgyTrustedWorkspace(realWorktree: string): Promise<void> {
  await withAgySettingsLock(async () => {
    const file = Bun.file(agySettingsPath());
    if (!(await file.exists())) return;
    // Teardown is best-effort: an unparseable file is left untouched with a
    // warning rather than throwing (unlike ensure, which must refuse the spawn).
    let settings: Record<string, unknown>;
    try {
      settings = await readAgySettings();
    } catch (err) {
      console.warn(`[agy] untrust skipped — ${(err as Error).message}`);
      return;
    }
    const trusted = readTrustedWorkspaces(settings);
    if (!trusted.includes(realWorktree)) {
      // Nothing to remove; only rewrite if the stored value was malformed.
      if (Array.isArray(settings.trustedWorkspaces)) return;
    }
    settings.trustedWorkspaces = trusted.filter((p) => p !== realWorktree);
    await writeAgySettings(settings);
  });
}

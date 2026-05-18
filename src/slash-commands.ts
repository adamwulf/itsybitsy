/**
 * Slash command management.
 *
 * itsybitsy ships a small set of agent-facing slash commands (currently
 * `/respawn` and `/restart`). These are markdown files that Claude Code
 * reads from `~/.claude/commands/<name>.md`. They are bundled into the
 * binary via text imports and written to disk on first run, mirroring the
 * agent-types initialization pattern.
 *
 * Both names land in the same handler — `restart.md` is documented as an
 * alias for `respawn.md`. The body of either tells Claude to run
 * `ib respawn`, which schedules a detached self-restart.
 */

import { join } from "path";
import { homedir } from "os";
import respawnMd from "../docs/slash-commands/respawn.md" with { type: "text" };
import restartMd from "../docs/slash-commands/restart.md" with { type: "text" };

/**
 * Embedded slash commands shipped with itsybitsy. Keyed by command name
 * (no `.md` suffix, no leading slash). The body is the full markdown file
 * including frontmatter.
 */
export const EMBEDDED_SLASH_COMMANDS: Record<string, string> = {
  respawn: respawnMd,
  restart: restartMd,
};

/**
 * Return the absolute path of the user-global Claude Code commands directory
 * (`~/.claude/commands/`). Honors the `HOME` env var so tests can redirect it.
 */
export function getGlobalClaudeCommandsDir(): string {
  return join(process.env.HOME ?? homedir(), ".claude", "commands");
}

/**
 * Ensure `~/.claude/commands/<name>.md` exists for every embedded slash
 * command. Files that already exist are NOT overwritten — users are free
 * to customize them, and an upgrade should not stomp their edits. Returns
 * the list of file names that were created (empty if nothing was missing).
 *
 * Called by `ensureAgentTypesDir`-adjacent first-run paths so the slash
 * commands appear without an explicit init step.
 */
export async function ensureSlashCommands(): Promise<string[]> {
  const dir = getGlobalClaudeCommandsDir();
  const { mkdir } = await import("fs/promises");
  await mkdir(dir, { recursive: true });

  const created: string[] = [];
  for (const [name, content] of Object.entries(EMBEDDED_SLASH_COMMANDS)) {
    const fileName = `${name}.md`;
    const filePath = join(dir, fileName);
    if (!(await Bun.file(filePath).exists())) {
      await Bun.write(filePath, content);
      created.push(fileName);
    }
  }
  return created;
}

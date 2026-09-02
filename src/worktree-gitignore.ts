/**
 * Neutral worktree `.gitignore` helper shared by the codex and agy spawn paths.
 *
 * Both CLIs drop generated files into the agent's worktree that must not end up
 * tracked (`.codex/` for codex; `.agents/hooks.json` + the rule file for agy).
 * This module owns the single append implementation so neither CLI module has
 * to depend on the other's (codex-spawn.ts previously imported this from
 * agy-config.ts — backwards layering).
 */

import { join } from "path";

export type GitignoreEntryOutcome = "appended" | "already-present" | "negation-respected";

/**
 * Append each of `entries` to `<worktree>/.gitignore` if not already present.
 * The codex path passes `[".codex/"]`; the agy path passes its worktree files.
 * Idempotent per entry, single read + single write.
 *
 * Trailing-slash equivalence is honored (`.codex` ≡ `.codex/`), and an explicit
 * negation (`!<entry>`) is treated as the user's intent to TRACK that path —
 * that entry is skipped and reported as "negation-respected" (last-match-wins
 * gitignore semantics would otherwise silently reverse the user's intent).
 *
 * Returns a per-entry outcome map. The file is only rewritten when at least one
 * entry was appended, so an all-present / all-negated call leaves the file
 * byte-for-byte untouched.
 */
export async function appendGitignoreEntries(
  worktreePath: string,
  entries: readonly string[],
): Promise<Record<string, GitignoreEntryOutcome>> {
  const gitignorePath = join(worktreePath, ".gitignore");
  const file = Bun.file(gitignorePath);
  let existing = "";
  if (await file.exists()) {
    existing = await file.text();
  }
  const trimmedLines = existing.split(/\r?\n/).map((l) => l.trim());

  const results: Record<string, GitignoreEntryOutcome> = {};
  const toAppend: string[] = [];
  for (const entry of entries) {
    const base = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const hasNegation = trimmedLines.some((l) => l === `!${base}` || l === `!${base}/`);
    if (hasNegation) {
      results[entry] = "negation-respected";
      continue;
    }
    const hasEntry = trimmedLines.some((l) => l === base || l === `${base}/`);
    if (hasEntry) {
      results[entry] = "already-present";
      continue;
    }
    toAppend.push(entry);
    results[entry] = "appended";
    // Treat the entry as present for the rest of this batch so a duplicate in
    // `entries` isn't appended twice.
    trimmedLines.push(entry);
  }

  if (toAppend.length > 0) {
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
    const appendBlock =
      (needsLeadingNewline ? "\n" : "") + toAppend.map((e) => e + "\n").join("");
    await Bun.write(gitignorePath, existing + appendBlock);
  }
  return results;
}

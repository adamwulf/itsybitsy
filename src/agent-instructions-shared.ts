/**
 * Shared instruction-building helpers for the non-Claude agent CLIs.
 *
 * Codex receives its role context as `-c developer_instructions="…"`;
 * Antigravity (`agy`) reads it from an always-on rule file. Both start from
 * the same Claude `session-start` template, strip the Claude-only
 * `<ittybitty>` XML wrapper, and append a directory of the read-on-demand
 * skills. Those pieces are CLI-agnostic and live here so codex-spawn.ts and
 * agy-config.ts share one implementation (no copy-paste).
 *
 * Project and user-wide instructions are never copied in: every CLI reads the
 * repo's `AGENTS.md` natively (Claude Code 2.1.277+, codex, agy), and each
 * reads its own global file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
 * `~/.gemini/GEMINI.md`). `missingAgentsMdWarning` flags a repo that still
 * keeps its instructions only in `CLAUDE.md`.
 *
 * codex-spawn.ts re-exports the builders so existing importers are unaffected.
 */

import { join } from "path";
import { userHome } from "./home";
import { readdir } from "fs/promises";
import type { SessionContext } from "./hooks/session-start";

/**
 * The role text every non-Claude CLI receives: the Claude session-start
 * instructions (`generateInstructions`) with the `<ittybitty>` wrapper
 * stripped, followed by the skills catalog. The CLI adapters add only their
 * own encoding — codex launches it as `-c developer_instructions`
 * (`buildCodexDeveloperInstructions`), agy prepends rule-file frontmatter
 * (`buildAgyRulesFile`). The skills section is "" when there are no skills, so
 * it never leaves a dangling header.
 */
export async function buildAgentRoleBody(ctx: SessionContext): Promise<string> {
  // Lazy import: ib-commands.ts imports this module statically, and
  // session-start → teams → ib-commands would otherwise form an import cycle.
  const { generateInstructions } = await import("./hooks/session-start");
  const body = stripIttybittyWrapper(await generateInstructions(ctx));
  const skillsSection = await buildSkillsSection();
  return [body, skillsSection].filter((s) => s.length > 0).join("\n");
}

/**
 * Spawn-time check for the non-Claude CLIs. Codex and agy read a project's
 * instructions from `AGENTS.md`, never from `CLAUDE.md`, and itsybitsy does
 * not copy `CLAUDE.md` into their instructions. Returns a one-line warning when
 * the worktree root has `CLAUDE.md` (or `.claude/CLAUDE.md`) but no
 * `AGENTS.md`, so the user knows the agent starts without the project's
 * instructions; null otherwise. A symlinked `AGENTS.md` counts as present.
 */
export async function missingAgentsMdWarning(
  worktreePath: string,
  cli: string,
  agentId: string,
): Promise<string | null> {
  if (await Bun.file(join(worktreePath, "AGENTS.md")).exists()) return null;
  for (const claudeMd of ["CLAUDE.md", join(".claude", "CLAUDE.md")]) {
    if (await Bun.file(join(worktreePath, claudeMd)).exists()) {
      return (
        `${cli} agent '${agentId}' starts without the project instructions: the repo has ` +
        `${claudeMd} but no AGENTS.md, and ${cli} does not read CLAUDE.md. Rename it ` +
        `(git mv ${claudeMd} AGENTS.md); Claude Code 2.1.277+ reads AGENTS.md too.`
      );
    }
  }
  return null;
}

/**
 * Remove a single outer `<ittybitty>...</ittybitty>` wrapper. If the input
 * doesn't start with the open tag (or doesn't have a matching close tag),
 * returns the input unchanged — Claude-side templating may evolve, but a
 * codex/agy agent's instruction file should never embed an XML tag the CLI
 * won't recognize.
 */
export function stripIttybittyWrapper(body: string): string {
  const openTag = "<ittybitty>";
  const closeTag = "</ittybitty>";
  const openIdx = body.indexOf(openTag);
  if (openIdx === -1) return body;
  // Use lastIndexOf so we drop the outer wrapper even if the body contains
  // an inner reference to <ittybitty> (templates do mention the tag in some
  // commentary).
  const closeIdx = body.lastIndexOf(closeTag);
  if (closeIdx === -1 || closeIdx <= openIdx) return body;
  const inner = body.slice(openIdx + openTag.length, closeIdx).trim();
  // Preserve any text before the open tag (rare) and after the close tag
  // (also rare) so we don't accidentally drop trailing team-awareness blocks
  // that were spliced before the close tag.
  const before = body.slice(0, openIdx).trim();
  const after = body.slice(closeIdx + closeTag.length).trim();
  return [before, inner, after].filter((s) => s.length > 0).join("\n\n") + "\n";
}

/**
 * Build a "Skills" catalog section so a non-Claude agent can discover the same
 * read-on-demand workflow guides ("skills") that Claude exposes as `/slash`
 * commands. These CLIs cannot invoke skills as slash commands, so this section
 * is purely a directory: it tells the agent each skill's name, the absolute
 * path to its `SKILL.md`, and the raw YAML frontmatter (name + description) so
 * the agent can decide when a task matches and read the full file on demand.
 * The skill BODY is never inlined — that would bloat the instruction file for
 * no benefit.
 *
 * Skills live under `~/.claude/skills/<name>/SKILL.md`. We resolve HOME via the
 * shared {@link userHome} seam so a fake HOME in tests points at a temp dir.
 * The `skillsDir` param defaults to the real path so production callers are
 * unchanged; tests pass a temp dir.
 *
 * Only the FIRST `---`...`---` frontmatter block is parsed — skill bodies
 * contain `key:`-looking prose lines that would false-match a whole-file grep.
 * A subdirectory with no `SKILL.md` is skipped; a `SKILL.md` with no leading
 * frontmatter is still listed (name only, empty frontmatter block). Skills are
 * sorted alphabetically by directory name for deterministic output.
 *
 * Graceful degradation is total: a missing skills dir, an unreadable entry, or
 * a malformed `SKILL.md` is skipped rather than thrown — instruction-file
 * generation must never fail because of skills. Returns "" when no skills are
 * found so the caller can omit the section header entirely.
 */
export async function buildSkillsSection(
  skillsDir: string = join(
    userHome(),
    ".claude",
    "skills",
  ),
): Promise<string> {
  // Sort directory names alphabetically so the rendered output is stable and a
  // test can assert it (no Date/random anywhere in this path).
  let names: string[];
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    names = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    // Missing (or unreadable) skills dir — no section.
    return "";
  }

  const blocks: string[] = [];
  for (const name of names) {
    const skillMdPath = join(skillsDir, name, "SKILL.md");
    let contents: string;
    try {
      const file = Bun.file(skillMdPath);
      if (!(await file.exists())) continue; // subdir without a SKILL.md — skip
      contents = await file.text();
    } catch {
      // Unreadable SKILL.md — skip rather than fail the whole instruction file.
      continue;
    }
    const frontmatter = extractFrontmatter(contents);
    // Emit the raw frontmatter verbatim inside a fenced block. The fence length
    // is computed dynamically (see fenceFor) so a frontmatter that itself
    // contains a ``` run can't terminate the fence early and corrupt this block
    // — and everything after it. An empty frontmatter still lists the skill by
    // name so the agent knows it exists.
    const fence = fenceFor(frontmatter);
    const fenced = frontmatter.length > 0
      ? fence + "\n" + frontmatter + "\n" + fence
      : fence + "\n" + fence;
    blocks.push(`### ${name}\nPath: ${skillMdPath}\nFrontmatter:\n${fenced}`);
  }

  if (blocks.length === 0) return "";

  const intro =
    "These are instruction files, not slash commands — you cannot invoke them " +
    "as `/name`. When a task matches a skill's description, read its SKILL.md " +
    "at the absolute path below and follow it.";
  return (
    "## Skills (read-on-demand workflow guides)\n\n" +
    intro +
    "\n\n" +
    blocks.join("\n\n") +
    "\n"
  );
}

/**
 * Compute a markdown code-fence (run of backticks) long enough to safely wrap
 * `text` verbatim. A fence must be strictly longer than the longest run of
 * consecutive backticks anywhere inside the content, otherwise that inner run
 * would close the fence early. We return `max(3, longestRun + 1)` backticks so
 * the common case stays a normal ```-fence while user-authored frontmatter that
 * embeds a fenced example can't corrupt the surrounding instruction file.
 */
function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Extract the raw text BETWEEN the first two `---` delimiter lines of a
 * `SKILL.md` (the YAML frontmatter region), returned verbatim and trimmed of
 * surrounding blank lines. We deliberately do NOT parse the YAML into a struct
 * — the caller wants the frontmatter shown as-is — and we only look at the
 * leading block so skill-body prose with `key:`-shaped lines can't false-match.
 *
 * Returns "" when the file doesn't open with a `---` line (no frontmatter) or
 * when there's no closing `---`, so the caller lists the skill name-only.
 */
function extractFrontmatter(contents: string): string {
  // Split on /\r?\n/ so a CRLF-line-ended SKILL.md doesn't leave a trailing \r
  // on each interior line of the verbatim frontmatter we emit.
  const lines = contents.split(/\r?\n/);
  // Frontmatter must be the very first line.
  if (lines[0]?.trim() !== "---") return "";
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return lines.slice(1, i).join("\n").trim();
    }
  }
  // Opened with `---` but never closed — treat as no usable frontmatter.
  return "";
}

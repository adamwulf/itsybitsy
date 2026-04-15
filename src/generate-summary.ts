/**
 * Standalone script for generating an agent prompt summary using claude -p with Haiku.
 * Spawned as a detached subprocess by newAgent() so it survives parent process.exit().
 *
 * Usage: ib generate-summary <agentDir>
 *
 * Reads prompt.txt from the agent directory, summarizes it via claude -p,
 * and merges the summary into meta.json. Exits silently on any failure.
 */

import { join } from "path";

/**
 * Validate that agentDir looks like a legitimate .ittybitty/agents/ path.
 * Prevents arbitrary file system access via the CLI subcommand.
 */
export function isValidAgentDir(agentDir: string): boolean {
  // Must be an absolute path containing the .ittybitty/agents/ structure
  return agentDir.startsWith("/") && /\/\.ittybitty\/agents\/[^/]+$/.test(agentDir);
}

export async function generateSummary(agentDir: string): Promise<void> {
  if (!isValidAgentDir(agentDir)) return;

  const promptPath = join(agentDir, "prompt.txt");
  const metaPath = join(agentDir, "meta.json");

  // Read the agent's prompt
  const promptFile = Bun.file(promptPath);
  if (!(await promptFile.exists())) return;
  const prompt = await promptFile.text();
  if (!prompt.trim()) return;

  // Ask Haiku for a summary
  const summaryPrompt = `Summarize the following agent task in at most 30 words:\n\n${prompt}`;
  const proc = Bun.spawn(["claude", "-p", summaryPrompt, "--model", "claude-haiku-4-5-20251001", "--tools", ""], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return;

  const summary = text.trim();
  if (!summary) return;

  // Read current meta.json, merge summary, write back
  try {
    const metaFile = Bun.file(metaPath);
    if (!(await metaFile.exists())) return;
    const meta = await metaFile.json();
    meta.summary = summary;
    await Bun.write(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } catch { /* ignore corrupt meta.json */ }
}

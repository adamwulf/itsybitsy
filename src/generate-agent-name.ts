/**
 * Generate a short kebab-case name for an agent by asking Haiku to describe the task.
 * Used at spawn time to build descriptive agent IDs like `login-bug-fix-abc12345`.
 *
 * Never throws — on any failure returns "agent" so the ID falls back to `agent-<hex>`.
 */

const RESERVED_NAMES = new Set(["coordinator", "system", "agent"]);

const SYSTEM_PROMPT = `You are naming a software engineering agent. Given the task description below, output a short kebab-case slug (1-3 words) that describes the task. Examples:
- "fix the login bug" → "login-bug-fix"
- "add dark mode to settings" → "dark-mode"
- "refactor the database layer" → "db-refactor"

Rules:
- Use only lowercase letters, digits, and hyphens (a-z, 0-9, -)
- Maximum 16 characters
- Do not include the word "agent"
- Output ONLY the slug — no quotes, no explanation, no punctuation, no newline before/after`;

/** Build the claude -p command array for naming. Exported for testing. */
export function buildAgentNameCommand(prompt: string): string[] {
  const combined = SYSTEM_PROMPT + "\n\nTask prompt:\n" + prompt;
  // --tools "" matches the flag used by generate-summary.ts to disable all tools,
  // preventing Haiku from attempting to execute the task instead of naming it.
  return ["claude", "-p", combined, "--model", "claude-haiku-4-5-20251001", "--tools", ""];
}

/**
 * Sanitize a raw LLM output into a safe agent-name slug.
 * Returns "agent" if the cleaned value is empty, pure digits, or a reserved name.
 */
export function sanitizeAgentName(raw: string): string {
  if (typeof raw !== "string") return "agent";

  let s = raw.trim();

  // Strip triple-backtick code fences (possibly with language tag)
  s = s.replace(/^```[a-zA-Z0-9]*\s*/m, "").replace(/```$/m, "").trim();

  // Strip surrounding backticks or quotes (single, double, smart quotes)
  s = s.replace(/^[`"'\u2018\u2019\u201C\u201D]+/, "").replace(/[`"'\u2018\u2019\u201C\u201D]+$/, "").trim();

  // Strip leading "name:" / "Name:" prefix
  s = s.replace(/^name\s*:\s*/i, "").trim();

  // Re-strip quotes that might surround the value after removing the prefix
  s = s.replace(/^[`"'\u2018\u2019\u201C\u201D]+/, "").replace(/[`"'\u2018\u2019\u201C\u201D]+$/, "").trim();

  // Lowercase
  s = s.toLowerCase();

  // Replace disallowed chars with '-'
  s = s.replace(/[^a-z0-9-]/g, "-");

  // Collapse runs of '-'
  s = s.replace(/-+/g, "-");

  // Trim leading/trailing '-'
  s = s.replace(/^-+/, "").replace(/-+$/, "");

  // Truncate to 16 chars, then re-trim trailing '-'
  if (s.length > 16) s = s.substring(0, 16);
  s = s.replace(/-+$/, "");

  if (!s) return "agent";
  if (/^\d+$/.test(s)) return "agent";
  if (RESERVED_NAMES.has(s)) return "agent";

  return s;
}

/** Override for testing — set via setAgentNameGenerator / resetAgentNameGenerator */
let agentNameGeneratorOverride: ((prompt: string) => Promise<string>) | null = null;

export function setAgentNameGenerator(fn: (prompt: string) => Promise<string>): void {
  agentNameGeneratorOverride = fn;
}

export function resetAgentNameGenerator(): void {
  agentNameGeneratorOverride = null;
}

export interface GenerateAgentNameOptions {
  timeoutMs?: number;
}

/**
 * Spawn claude -p with Haiku to generate a short kebab-case agent name for the given prompt.
 * Always returns a sanitized name; falls back to "agent" on any error, timeout, or empty output.
 */
export async function generateAgentName(
  prompt: string,
  options?: GenerateAgentNameOptions,
): Promise<string> {
  if (agentNameGeneratorOverride) {
    try {
      const raw = await agentNameGeneratorOverride(prompt);
      return sanitizeAgentName(raw);
    } catch {
      return "agent";
    }
  }

  if (!prompt || !prompt.trim()) return "agent";

  const timeoutMs = options?.timeoutMs ?? 8000;
  const cmd = buildAgentNameCommand(prompt);

  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* ignore */ }
    }, timeoutMs);

    let text = "";
    try {
      text = await new Response(proc.stdout).text();
    } catch {
      clearTimeout(timer);
      return "agent";
    }

    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (timedOut) return "agent";
    if (exitCode !== 0) return "agent";
    if (!text.trim()) return "agent";

    return sanitizeAgentName(text);
  } catch {
    return "agent";
  }
}

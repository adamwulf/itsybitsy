/**
 * Agent-session PostToolUse hook: injects the current wall-clock time into the
 * agent's context after every tool call.
 *
 * Installed in each spawned agent's `settings.local.json` on the `PostToolUse`
 * event (matcher `*`). Claude only ever gives a conversation a coarse
 * session-level timestamp; this hook stamps a fresh time after each tool call
 * so the agent has a per-message sense of elapsed wall-clock time. The injected
 * `additionalContext` is written into the transcript and persists for the rest
 * of the conversation (until a compaction), so the timestamps accumulate into a
 * rough timeline.
 *
 * Opt-in: gated behind the `hooks.injectTimestamp` config key (default false).
 * The hook entry is always present in agent settings, but the body short-
 * circuits unless the config is enabled — so toggling the config takes effect on
 * already-running agents without re-spawning them.
 *
 * Distinct from `inject-status.ts`, which targets the PRIMARY Claude session
 * with an agents overview; this targets AGENT sessions with a timestamp only.
 */

import { readConfig } from "../config";
import { resolveAgentFromCwd } from "./shared";

/** Subset of the PostToolUse hook stdin JSON this hook reads. */
export interface InjectTimestampInput {
  hook_event_name?: string;
}

/** Shape of the hook's stdout payload when it injects. */
export interface InjectTimestampOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

/**
 * Format an epoch (in milliseconds) as a human-readable local timestamp with
 * timezone abbreviation plus the raw epoch in seconds.
 *
 * Example: `2026-05-29 14:32:07 CDT (epoch 1748547127)`
 *
 * `formatToParts` is used rather than `format()` so the layout is independent
 * of locale punctuation (e.g. `en-US` would otherwise emit a comma between the
 * date and time).
 *
 * `timeZone` defaults to the machine's local timezone (the production path —
 * the agent wants its own local wall-clock time). Tests pass an explicit IANA
 * zone for determinism, since `Intl` resolves the local zone once at process
 * start and ignores later `process.env.TZ` mutations.
 */
export function formatTimestamp(epochMs: number, timeZone?: string): string {
  const d = new Date(epochMs);
  const fmt = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  // `hour12: false` can yield "24" for midnight in some runtimes — normalize.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const epochSeconds = Math.floor(epochMs / 1000);
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second} ${parts.timeZoneName} (epoch ${epochSeconds})`;
}

/**
 * Build the `additionalContext` payload for the PostToolUse hook output.
 */
export function buildTimestampContext(epochMs: number, timeZone?: string): string {
  return `Current time: ${formatTimestamp(epochMs, timeZone)}`;
}

/**
 * Pure decision core for the hook: given the raw stdin, whether the cwd is an
 * agent context, whether the config is enabled, and the current time, returns
 * the output payload to write — or `null` when the hook should stay silent.
 *
 * All environment inputs are passed in so this is fully unit-testable without
 * `process.exit`, stdin, the filesystem, or the wall clock. The CLI wrapper
 * `hookInjectTimestamp` supplies the production values.
 */
export function computeTimestampOutput(opts: {
  rawStdin: string;
  isAgentContext: boolean;
  enabled: boolean;
  epochMs: number;
  timeZone?: string;
}): InjectTimestampOutput | null {
  let data: InjectTimestampInput;
  try {
    data = JSON.parse(opts.rawStdin) as InjectTimestampInput;
  } catch {
    return null;
  }

  // Defense-in-depth: this hook is only wired into agent settings, but if it
  // somehow fires outside an agent worktree, stay silent.
  if (!opts.isAgentContext) return null;

  // Opt-in: only inject when explicitly enabled.
  if (!opts.enabled) return null;

  const hookEventName = String(data.hook_event_name ?? "PostToolUse");

  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: buildTimestampContext(opts.epochMs, opts.timeZone),
    },
  };
}

/**
 * CLI entry point for `ib hooks inject-timestamp`.
 *
 * Reads stdin JSON, confirms agent context, checks the `hooks.injectTimestamp`
 * config, and (if enabled) writes a PostToolUse `additionalContext` payload to
 * stdout. Stays silent (no output, exit 0) in every other case.
 *
 * `epochMs` is injectable for tests; in production it is omitted and the hook
 * reads the current time.
 */
export async function hookInjectTimestamp(
  rawStdin?: string,
  epochMs?: number,
): Promise<void> {
  const raw = rawStdin ?? (await new Response(Bun.stdin.stream()).text());

  const isAgentContext = resolveAgentFromCwd(process.cwd()) !== null;

  // Only read config if we still might inject — avoids a disk read on the
  // common short-circuit paths (bad JSON / non-agent cwd).
  let enabled = false;
  if (isAgentContext) {
    const config = await readConfig();
    enabled = config["hooks.injectTimestamp"]?.value === true;
  }

  const output = computeTimestampOutput({
    rawStdin: raw,
    isAgentContext,
    enabled,
    epochMs: epochMs ?? Date.now(),
  });

  if (output === null) {
    process.exit(0);
    return;
  }

  process.stdout.write(JSON.stringify(output));
}

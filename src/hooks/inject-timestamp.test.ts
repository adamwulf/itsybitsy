import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatTimestamp,
  buildTimestampContext,
  computeTimestampOutput,
  hookInjectTimestamp,
} from "./inject-timestamp";
import { resetUserConfigPath, setUserConfigPath } from "../config";
import {
  resetBoundNoWorktreeCallerResolver,
  resetNoWorktreeRepoRootsLoader,
  setBoundNoWorktreeCallerResolver,
  setNoWorktreeRepoRootsLoader,
} from "./agent-context";

// A fixed epoch used across tests: 2025-05-29 19:32:07 UTC.
const FIXED_EPOCH_MS = 1748547127000;
const FIXED_EPOCH_SECONDS = 1748547127;

// `Intl` resolves the local timezone once at process start and ignores later
// `process.env.TZ` mutations, so tests pass an explicit IANA zone for
// determinism rather than mutating the environment.

describe("formatTimestamp", () => {
  test("formats local time with timezone abbreviation and raw epoch seconds", () => {
    // 19:32:07 UTC is 14:32:07 in America/Chicago (CDT, summer).
    expect(formatTimestamp(FIXED_EPOCH_MS, "America/Chicago")).toBe(
      `2025-05-29 14:32:07 CDT (epoch ${FIXED_EPOCH_SECONDS})`,
    );
  });

  test("respects the provided timezone (UTC)", () => {
    expect(formatTimestamp(FIXED_EPOCH_MS, "UTC")).toBe(
      `2025-05-29 19:32:07 UTC (epoch ${FIXED_EPOCH_SECONDS})`,
    );
  });

  test("respects the provided timezone (Tokyo, offset-style zone name)", () => {
    // 19:32:07 UTC is 04:32:07 next day in Asia/Tokyo (+09:00). The short zone
    // name for Tokyo resolves to an offset form ("GMT+9") in this ICU build
    // rather than "JST" — assert the date/time, not the exact zone label.
    expect(formatTimestamp(FIXED_EPOCH_MS, "Asia/Tokyo")).toMatch(
      new RegExp(`^2025-05-30 04:32:07 .+ \\(epoch ${FIXED_EPOCH_SECONDS}\\)$`),
    );
  });

  test("uses zero-padded two-digit month/day/time fields", () => {
    // 2025-01-02 03:04:05 UTC
    const epochMs = Date.UTC(2025, 0, 2, 3, 4, 5);
    expect(formatTimestamp(epochMs, "UTC")).toBe(
      `2025-01-02 03:04:05 UTC (epoch ${Math.floor(epochMs / 1000)})`,
    );
  });

  test("normalizes midnight to 00 rather than 24", () => {
    const epochMs = Date.UTC(2025, 5, 1, 0, 0, 0); // 2025-06-01 00:00:00 UTC
    expect(formatTimestamp(epochMs, "UTC")).toContain("2025-06-01 00:00:00 UTC");
  });

  test("floors sub-second epoch to whole seconds", () => {
    // 999ms past the fixed second should still report the same epoch seconds.
    expect(formatTimestamp(FIXED_EPOCH_MS + 999, "UTC")).toContain(
      `(epoch ${FIXED_EPOCH_SECONDS})`,
    );
  });

  test("defaults to the machine local timezone when none is given", () => {
    // Without an explicit zone the output still parses into the expected shape;
    // we don't assert the zone name (it varies by host) but the rest is fixed.
    const out = formatTimestamp(FIXED_EPOCH_MS);
    expect(out).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} .+ \(epoch 1748547127\)$/,
    );
  });
});

describe("buildTimestampContext", () => {
  test("prefixes the timestamp with a no-ack muzzle and human-readable label", () => {
    expect(buildTimestampContext(FIXED_EPOCH_MS, "America/Chicago")).toBe(
      `[information only, no ack required] Current time: 2025-05-29 14:32:07 CDT (epoch ${FIXED_EPOCH_SECONDS})`,
    );
  });
});

describe("computeTimestampOutput", () => {
  const base = {
    rawStdin: JSON.stringify({ hook_event_name: "PostToolUse" }),
    isAgentContext: true,
    enabled: true,
    epochMs: FIXED_EPOCH_MS,
    timeZone: "America/Chicago",
  };

  test("emits the payload when in an agent context, enabled, and valid JSON", () => {
    expect(computeTimestampOutput(base)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `[information only, no ack required] Current time: 2025-05-29 14:32:07 CDT (epoch ${FIXED_EPOCH_SECONDS})`,
      },
    });
  });

  test("returns null on invalid JSON (short-circuit, stays silent)", () => {
    expect(computeTimestampOutput({ ...base, rawStdin: "not json" })).toBeNull();
  });

  test("returns null on empty stdin", () => {
    expect(computeTimestampOutput({ ...base, rawStdin: "" })).toBeNull();
  });

  test("returns null when not in an agent context", () => {
    expect(computeTimestampOutput({ ...base, isAgentContext: false })).toBeNull();
  });

  test("returns null when the config is disabled", () => {
    expect(computeTimestampOutput({ ...base, enabled: false })).toBeNull();
  });

  test("defaults hookEventName to PostToolUse when absent from stdin", () => {
    const out = computeTimestampOutput({ ...base, rawStdin: "{}" });
    expect(out?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  test("echoes back the provided hook_event_name", () => {
    const out = computeTimestampOutput({
      ...base,
      rawStdin: JSON.stringify({ hook_event_name: "SomeOtherEvent" }),
    });
    expect(out?.hookSpecificOutput.hookEventName).toBe("SomeOtherEvent");
  });

  test("never throws when all gates fail at once (malformed JSON + non-agent + disabled)", () => {
    // All three gates independently return null, so this can't prove gate
    // *ordering* — its value is confirming the JSON.parse SyntaxError is caught
    // and no exception escapes for any combination of failing gates.
    expect(
      computeTimestampOutput({ rawStdin: "{", isAgentContext: false, enabled: false, epochMs: FIXED_EPOCH_MS }),
    ).toBeNull();
  });

  test("omitting timeZone uses the machine local zone (production wiring)", () => {
    // The CLI wrapper never passes timeZone, so production formats in local
    // time. We don't assert the zone label (host-dependent) but pin the shape.
    const out = computeTimestampOutput({
      rawStdin: JSON.stringify({ hook_event_name: "PostToolUse" }),
      isAgentContext: true,
      enabled: true,
      epochMs: FIXED_EPOCH_MS,
    });
    expect(out?.hookSpecificOutput.additionalContext).toMatch(
      new RegExp(`^\\[information only, no ack required\\] Current time: \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} .+ \\(epoch ${FIXED_EPOCH_SECONDS}\\)$`),
    );
  });
});

describe("hookInjectTimestamp cwd identity resolution", () => {
  let root: string;
  let originalCwd: string;
  let configPath: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await mkdtemp(join(tmpdir(), "inject-timestamp-context-"));
    configPath = join(root, "config.json");
    await Bun.write(configPath, JSON.stringify({ hooks: { injectTimestamp: true } }));
    setUserConfigPath(configPath);
    setNoWorktreeRepoRootsLoader(async () => [root]);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    resetUserConfigPath();
    resetBoundNoWorktreeCallerResolver();
    resetNoWorktreeRepoRootsLoader();
    await rm(root, { recursive: true, force: true });
  });

  async function invoke(agentId?: string): Promise<string> {
    let output = "";
    await hookInjectTimestamp(
      JSON.stringify({ hook_event_name: "PostToolUse" }),
      FIXED_EPOCH_MS,
      agentId,
      { write: (chunk) => { output += chunk; } },
    );
    return output;
  }

  test.each([".", "src/deep"])(
    "validated worktree:false identity injects from %s",
    async (relativeCwd) => {
      const agentId = "agent-timestamp1";
      const agentDir = join(root, ".ittybitty", "agents", agentId);
      const cwd = relativeCwd === "." ? root : join(root, relativeCwd);
      await mkdir(agentDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await Bun.write(
        join(agentDir, "meta.json"),
        JSON.stringify({ id: agentId, worktree: false }),
      );
      setBoundNoWorktreeCallerResolver(async () => ({
        meta: { id: agentId, worktree: false },
        agentDir,
        repoPath: root,
      }));
      process.chdir(cwd);

      const output = await invoke(agentId);

      expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(
        `epoch ${FIXED_EPOCH_SECONDS}`,
      );
    },
  );

  test("existing worktree context still injects without an explicit id", async () => {
    const worktree = join(root, ".ittybitty", "agents", "agent-existing1", "repo");
    await mkdir(worktree, { recursive: true });
    process.chdir(worktree);

    expect(JSON.parse(await invoke()).hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  test("registered no-worktree timestamp identity survives a standalone fake cwd but rejects a sibling claim", async () => {
    const callerId = "agent-timecaller1";
    const siblingId = "agent-timesibling1";
    const callerDir = join(root, ".ittybitty", "agents", callerId);
    const siblingDir = join(root, ".ittybitty", "agents", siblingId);
    const fakeRoot = await mkdtemp(join(tmpdir(), "inject-timestamp-fake-"));
    try {
      const fakeCwd = join(fakeRoot, ".ittybitty", "agents", siblingId, "repo");
      await mkdir(callerDir, { recursive: true });
      await mkdir(siblingDir, { recursive: true });
      await mkdir(fakeCwd, { recursive: true });
      await Bun.write(join(callerDir, "meta.json"), JSON.stringify({ id: callerId, worktree: false }));
      await Bun.write(join(siblingDir, "meta.json"), JSON.stringify({ id: siblingId, worktree: false }));
      setBoundNoWorktreeCallerResolver(async () => ({
        meta: { id: callerId, worktree: false },
        agentDir: callerDir,
        repoPath: root,
      }));
      process.chdir(fakeCwd);

      expect(JSON.parse(await invoke(callerId)).hookSpecificOutput.additionalContext).toContain("Current time:");
      expect(await invoke(siblingId)).toBe("");
    } finally {
      process.chdir(originalCwd);
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  test("primary Claude stays silent even when timestamp injection is configured", async () => {
    process.chdir(root);

    expect(await invoke()).toBe("");
  });

  test("unvalidated explicit identity stays silent", async () => {
    process.chdir(root);

    expect(await invoke("agent-missing01")).toBe("");
  });

  test("CLI dispatcher forwards an unauthenticated explicit id to silent handling", async () => {
    const agentId = "agent-timecli01";
    const agentDir = join(root, ".ittybitty", "agents", agentId);
    const cwd = join(root, "nested");
    const cliHome = join(root, "home");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(join(cliHome, ".itsybitsy"), { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: agentId, worktree: false }),
    );
    await Bun.write(
      join(cliHome, ".itsybitsy", "config.json"),
      JSON.stringify({ hooks: { injectTimestamp: true } }),
    );

    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "index.ts"), "hooks", "inject-timestamp", agentId],
      {
        cwd,
        env: { ...process.env, HOME: cliHome },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.write(JSON.stringify({ hook_event_name: "PostToolUse" }));
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("");
  });
});

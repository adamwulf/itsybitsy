import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { hookStatusline, statuslineRunnerCtx } from "./statusline";
import { CLAUDE_RATE_LIMITS_FILE } from "../claude-rate-limits";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";
import { setUserHome, resetUserHome } from "../home";

const NOW_MS = Date.UTC(2026, 9, 3, 23, 0, 0);
const NOW_S = NOW_MS / 1000;

describe("hookStatusline", () => {
  let home: string;
  let projectDir: string;
  let runs: { command: string; input: string }[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "statusline-hook-test-"));
    projectDir = join(home, "project");
    await mkdir(join(projectDir, ".claude"), { recursive: true });
    setUserHome(home);
    setCoordinatorHome(join(home, ".itsybitsy"));
    const calls: { command: string; input: string }[] = [];
    runs = calls;
    statuslineRunnerCtx.set(async (command, input) => {
      calls.push({ command, input });
      return { stdout: `line from ${command}\n`, exitCode: 0 };
    });
  });

  afterEach(async () => {
    statuslineRunnerCtx.reset();
    resetCoordinatorHome();
    resetUserHome();
    await rm(home, { recursive: true, force: true });
  });

  async function writeUserSettings(settings: unknown): Promise<void> {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  }

  function statuslineInput(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      cwd: projectDir,
      workspace: { project_dir: projectDir },
      rate_limits: {
        five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 },
        seven_day: { used_percentage: 11, resets_at: NOW_S + 86_400 },
      },
      ...extra,
    });
  }

  function recordPath(agentId: string): string {
    return join(home, ".itsybitsy", "agents", agentId, CLAUDE_RATE_LIMITS_FILE);
  }

  test("records rate_limits and passes the user's statusline output through", async () => {
    await writeUserSettings({ statusLine: { type: "command", command: "~/.claude/statusline-command.sh", padding: 0 } });
    const stdin = statuslineInput();

    const result = await hookStatusline(stdin, "agent-a", NOW_MS);

    expect(result).toEqual({ output: "line from ~/.claude/statusline-command.sh\n", exitCode: 0 });
    expect(runs).toEqual([{ command: "~/.claude/statusline-command.sh", input: stdin }]);
    expect(await Bun.file(recordPath("agent-a")).json()).toEqual({
      updatedAt: NOW_S,
      five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 },
      seven_day: { used_percentage: 11, resets_at: NOW_S + 86_400 },
    });
  });

  test("the project's statusLine wins over the user's", async () => {
    await writeUserSettings({ statusLine: { type: "command", command: "user-statusline" } });
    await writeFile(
      join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "project-statusline" } }),
    );

    const result = await hookStatusline(statuslineInput(), "agent-a", NOW_MS);

    expect(result.output).toBe("line from project-statusline\n");
    expect(runs.map((r) => r.command)).toEqual(["project-statusline"]);
  });

  test("prints nothing without a user statusline but still records", async () => {
    const result = await hookStatusline(statuslineInput(), "agent-a", NOW_MS);

    expect(result).toEqual({ output: "", exitCode: 0 });
    expect(runs).toEqual([]);
    expect(await Bun.file(recordPath("agent-a")).exists()).toBe(true);
  });

  test("never runs ib's own statusline wrapper", async () => {
    await writeUserSettings({ statusLine: { type: "command", command: "ib hooks statusline agent-a" } });

    const result = await hookStatusline(statuslineInput(), "agent-a", NOW_MS);

    expect(result.output).toBe("");
    expect(runs).toEqual([]);
  });

  test("an invalid agent ID skips the record but the statusline still runs", async () => {
    await writeUserSettings({ statusLine: { type: "command", command: "user-statusline" } });

    const result = await hookStatusline(statuslineInput(), "../escape", NOW_MS);

    expect(result.output).toBe("line from user-statusline\n");
    expect(await Bun.file(join(home, ".itsybitsy", "escape", CLAUDE_RATE_LIMITS_FILE)).exists()).toBe(false);
    expect(await Bun.file(recordPath("../escape")).exists()).toBe(false);
  });

  test("the system coordinator's @system ID is recorded", async () => {
    await hookStatusline(statuslineInput(), "@system", NOW_MS);

    expect(await Bun.file(recordPath("@system")).exists()).toBe(true);
  });

  test("an input without rate_limits writes no record", async () => {
    const stdin = JSON.stringify({ cwd: projectDir, workspace: { project_dir: projectDir } });

    await hookStatusline(stdin, "agent-a", NOW_MS);

    expect(await Bun.file(recordPath("agent-a")).exists()).toBe(false);
  });

  test("input that is not JSON still runs the user's statusline", async () => {
    await writeUserSettings({ statusLine: { type: "command", command: "user-statusline" } });

    const result = await hookStatusline("not json", "agent-a", NOW_MS);

    expect(result.output).toBe("line from user-statusline\n");
    expect(runs).toEqual([{ command: "user-statusline", input: "not json" }]);
    expect(await Bun.file(recordPath("agent-a")).exists()).toBe(false);
  });

  test("CLI: records the input and prints the user's statusline byte-for-byte", async () => {
    // Real entry point, real /bin/sh runner, a harmless printf as the user's
    // statusline. Output must pass through unchanged — no added newline.
    await writeUserSettings({ statusLine: { type: "command", command: "printf 'line one\\nline two\\n'" } });
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "index.ts"), "hooks", "statusline", "agent-cli"],
      {
        cwd: projectDir,
        env: { ...process.env, HOME: home },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.write(statuslineInput());
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("line one\nline two\n");
    const record = await Bun.file(recordPath("agent-cli")).json();
    expect(record.five_hour).toEqual({ used_percentage: 9, resets_at: NOW_S + 3600 });
  });

  test("passes the statusline's exit code through and survives a runner failure", async () => {
    await writeUserSettings({ statusLine: { type: "command", command: "user-statusline" } });
    statuslineRunnerCtx.set(async () => ({ stdout: "partial\n", exitCode: 3 }));
    expect(await hookStatusline(statuslineInput(), "agent-a", NOW_MS)).toEqual({ output: "partial\n", exitCode: 3 });

    statuslineRunnerCtx.set(async () => {
      throw new Error("spawn failed");
    });
    expect(await hookStatusline(statuslineInput(), "agent-a", NOW_MS)).toEqual({ output: "", exitCode: 0 });
  });
});

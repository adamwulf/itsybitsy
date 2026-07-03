import { test, expect, describe } from "bun:test";
import { hasHelpFlag, printCommandHelp } from "./index";

describe("hasHelpFlag", () => {
  test("detects --help anywhere after the command", () => {
    expect(hasHelpFlag(["send", "--help"])).toBe(true);
    expect(hasHelpFlag(["send", "agent-x", "--help"])).toBe(true);
    expect(hasHelpFlag(["team", "add", "name", "id", "--help"])).toBe(true);
  });

  test("detects -h short form anywhere after the command", () => {
    expect(hasHelpFlag(["new-agent", "-h"])).toBe(true);
    expect(hasHelpFlag(["new-agent", "--type", "worker", "-h"])).toBe(true);
  });

  test("returns false when the command itself is --help", () => {
    // The dispatcher handles top-level --help before reaching this helper;
    // hasHelpFlag explicitly ignores args[0].
    expect(hasHelpFlag(["--help"])).toBe(false);
    expect(hasHelpFlag(["-h"])).toBe(false);
  });

  test("returns false when no help flag is present", () => {
    expect(hasHelpFlag([])).toBe(false);
    expect(hasHelpFlag(["send"])).toBe(false);
    expect(hasHelpFlag(["send", "agent-x", "hello"])).toBe(false);
  });
});

describe("printCommandHelp", () => {
  // Capture console.log output so we don't pollute test output and can assert
  // on the printed text.
  function captureStdout(fn: () => void): string {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };
    try {
      fn();
    } finally {
      console.log = original;
    }
    return lines.join("\n");
  }

  test("returns true and prints help for a known command", () => {
    let result = false;
    const out = captureStdout(() => {
      result = printCommandHelp("new-agent");
    });
    expect(result).toBe(true);
    expect(out).toContain("Usage: ib new-agent");
    expect(out).toContain("--type");
  });

  test("returns false and prints nothing for an unknown command", () => {
    let result = true;
    const out = captureStdout(() => {
      result = printCommandHelp("definitely-not-a-command");
    });
    expect(result).toBe(false);
    expect(out).toBe("");
  });

  test("prints sub-grouped command help when given the full key", () => {
    let result = false;
    const out = captureStdout(() => {
      result = printCommandHelp("team add");
    });
    expect(result).toBe(true);
    expect(out).toContain("Usage: ib team add");
  });
});

// ─── End-to-end: subprocess invocations of the CLI entrypoint ───────────────

describe("CLI --help end-to-end", () => {
  async function runCli(cliArgs: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", ...cliArgs], {
      cwd: import.meta.dir.replace(/\/src$/, ""),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: "/tmp/ib-test-nonexistent-home" },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("new-agent --help prints command-specific usage and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["new-agent", "--help"]);
    expect(stdout).toContain("Usage: ib new-agent");
    expect(stdout).toContain("--type");
    expect(stdout).toContain("--model");
    expect(exitCode).toBe(0);
  });

  test("send -h prints command-specific usage and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["send", "-h"]);
    expect(stdout).toContain("Usage: ib send");
    expect(stdout).toContain("@system");
    expect(exitCode).toBe(0);
  });

  test("retire --help exits 0 and does not actually try to retire", async () => {
    const { stdout, exitCode } = await runCli(["retire", "--help"]);
    expect(stdout).toContain("Usage: ib retire");
    expect(exitCode).toBe(0);
  });

  test("team add --help prints sub-subcommand usage", async () => {
    const { stdout, exitCode } = await runCli(["team", "add", "--help"]);
    expect(stdout).toContain("Usage: ib team add");
    expect(exitCode).toBe(0);
  });

  test("team --help prints the team group overview", async () => {
    const { stdout, exitCode } = await runCli(["team", "--help"]);
    expect(stdout).toContain("Usage: ib team <subcommand>");
    expect(stdout).toContain("create");
    expect(stdout).toContain("add");
    expect(exitCode).toBe(0);
  });

  test("config set --help prints sub-subcommand usage", async () => {
    const { stdout, exitCode } = await runCli(["config", "set", "--help"]);
    expect(stdout).toContain("Usage: ib config set");
    expect(exitCode).toBe(0);
  });

  test("hooks --help prints the hooks group overview", async () => {
    const { stdout, exitCode } = await runCli(["hooks", "--help"]);
    expect(stdout).toContain("Usage: ib hooks <subcommand>");
    expect(stdout).toContain("install");
    expect(stdout).toContain("intercept-install");
    expect(exitCode).toBe(0);
  });

  test("list -h alias resolves to list help (not ls)", async () => {
    const { stdout, exitCode } = await runCli(["ls", "-h"]);
    expect(stdout).toContain("Usage: ib list");
    expect(stdout).toContain("Aliases: ls");
    expect(exitCode).toBe(0);
  });

  test("state --help shows --cleanup and --dry-run", async () => {
    const { stdout, exitCode } = await runCli(["state", "--help"]);
    expect(stdout).toContain("Usage: ib state");
    expect(stdout).toContain("--cleanup");
    expect(stdout).toContain("--dry-run");
    expect(exitCode).toBe(0);
  });

  test("normal commands still work — `models` lists models", async () => {
    // Regression guard: no help flag means the command runs normally.
    const { stdout, exitCode } = await runCli(["list-models"]);
    expect(stdout).toContain("CLAUDE");
    expect(exitCode).toBe(0);
  });
});

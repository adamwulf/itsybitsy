/**
 * Unit tests for src/sandbox-launch.ts — the CLI-agnostic sandbox launch
 * primitives shared by the per-repo launcher (ib-commands.ts) and the system
 * coordinator launcher (coordinator.ts / sandbox-system-launch). These assert the
 * subprocess-gate refusals, the shell-quoting of the exec prefix, and the two
 * proxy-preamble modes (per-agent meta persist vs @system pid-file only).
 */

import { test, expect, describe } from "bun:test";
import {
  type SandboxCommandRunner,
  resolveSandboxExecPath,
  sandboxDefinitionArgs,
  sandboxExecShellPrefix,
  lintSandboxProfile,
  sandboxProxyScriptPreamble,
} from "./sandbox-launch";

/** A scripted runner: matches an argv shape to a fixed result, else exit 0/empty. */
function makeRunner(
  handler: (cmd: string[]) => { stdout?: string; stderr?: string; exitCode?: number } | undefined,
): SandboxCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(cmd: string[]) {
      calls.push(cmd);
      const r = handler(cmd) ?? {};
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
    },
  };
}

describe("resolveSandboxExecPath", () => {
  test("throws on a non-darwin platform (Seatbelt is macOS-only)", async () => {
    const runner = makeRunner(() => ({ stdout: "/usr/bin/sandbox-exec", exitCode: 0 }));
    await expect(resolveSandboxExecPath(runner, { platform: "linux" })).rejects.toThrow(
      /Seatbelt requires macOS \(current platform: linux\)/,
    );
    // The platform gate short-circuits before probing `which`.
    expect(runner.calls.length).toBe(0);
  });

  test("throws when `which sandbox-exec` fails or returns nothing", async () => {
    const missing = makeRunner((cmd) =>
      cmd[0] === "which" ? { stdout: "", exitCode: 1 } : undefined,
    );
    await expect(resolveSandboxExecPath(missing, { platform: "darwin" })).rejects.toThrow(
      /sandbox-exec not found \(macOS only\)/,
    );
    // exit 0 but empty stdout is also a failure.
    const empty = makeRunner((cmd) => (cmd[0] === "which" ? { stdout: "  \n", exitCode: 0 } : undefined));
    await expect(resolveSandboxExecPath(empty, { platform: "darwin" })).rejects.toThrow(
      /sandbox-exec not found/,
    );
  });

  test("returns the first line of `which` stdout on success", async () => {
    const runner = makeRunner((cmd) =>
      cmd[0] === "which" && cmd[1] === "sandbox-exec"
        ? { stdout: "/usr/bin/sandbox-exec\n/other\n", exitCode: 0 }
        : undefined,
    );
    expect(await resolveSandboxExecPath(runner, { platform: "darwin" })).toBe("/usr/bin/sandbox-exec");
    expect(runner.calls[0]).toEqual(["which", "sandbox-exec"]);
  });
});

describe("sandboxDefinitionArgs", () => {
  test("expands a parameter map into -D key=value argv pairs", () => {
    expect(sandboxDefinitionArgs({ AGENTDIR: "/a", WORKTREE: "/w" })).toEqual([
      "-D", "AGENTDIR=/a",
      "-D", "WORKTREE=/w",
    ]);
  });

  test("empty map → no args", () => {
    expect(sandboxDefinitionArgs({})).toEqual([]);
  });
});

describe("sandboxExecShellPrefix", () => {
  test("defaults to the safe absolute /usr/bin/sandbox-exec (never a bare PATH lookup), no trailing space", () => {
    const prefix = sandboxExecShellPrefix("/tmp/a b/sandbox.sb", { AGENTDIR: "/x y", WORKTREE: "/w" });
    expect(prefix).toBe("'/usr/bin/sandbox-exec' -f '/tmp/a b/sandbox.sb' -D 'AGENTDIR=/x y' -D 'WORKTREE=/w'");
    expect(prefix.endsWith(" ")).toBe(false);
    // Never emits a bare `sandbox-exec` token that would re-resolve PATH.
    expect(prefix.startsWith("sandbox-exec ")).toBe(false);
  });

  test("empty parameter map → just the exec + -f profile, no trailing space", () => {
    expect(sandboxExecShellPrefix("/tmp/sandbox.sb", {})).toBe("'/usr/bin/sandbox-exec' -f '/tmp/sandbox.sb'");
  });

  test("threads the resolved sandbox-exec path so the LINTED binary is the one launched (path with spaces)", () => {
    // Manager finding: resolveSandboxExecPath returns an absolute path; that exact
    // path must appear (shell-quoted) in the emitted launch — not a bare re-resolved
    // `sandbox-exec`. A path with a space proves the quoting keeps it one argument.
    const execPath = "/opt/my sandbox/sandbox-exec";
    const prefix = sandboxExecShellPrefix("/tmp/p.sb", { AGENTDIR: "/a" }, execPath);
    expect(prefix).toBe("'/opt/my sandbox/sandbox-exec' -f '/tmp/p.sb' -D 'AGENTDIR=/a'");
    // The exact linted path leads the launch, shell-quoted as a single token.
    expect(prefix.startsWith("'/opt/my sandbox/sandbox-exec' ")).toBe(true);
  });

  test("rejects an empty or non-absolute sandbox-exec path (never a bare PATH lookup)", () => {
    expect(() => sandboxExecShellPrefix("/tmp/p.sb", {}, "")).toThrow(/requires an absolute sandbox-exec path/);
    expect(() => sandboxExecShellPrefix("/tmp/p.sb", {}, "sandbox-exec")).toThrow(
      /requires an absolute sandbox-exec path/,
    );
    expect(() => sandboxExecShellPrefix("/tmp/p.sb", {}, "./sandbox-exec")).toThrow(
      /requires an absolute sandbox-exec path/,
    );
  });
});

describe("lintSandboxProfile", () => {
  test("resolves when `sandbox-exec … /usr/bin/true` exits 0", async () => {
    const runner = makeRunner((cmd) => (cmd[0] === "/usr/bin/sandbox-exec" ? { exitCode: 0 } : undefined));
    await expect(
      lintSandboxProfile(runner, "/usr/bin/sandbox-exec", "/tmp/p.sb", { AGENTDIR: "/a" }),
    ).resolves.toBeUndefined();
    // The lint invokes sandbox-exec with -f <profile>, the -D pairs, and /usr/bin/true.
    expect(runner.calls[0]).toEqual([
      "/usr/bin/sandbox-exec", "-f", "/tmp/p.sb", "-D", "AGENTDIR=/a", "/usr/bin/true",
    ]);
  });

  test("throws with the compile error on a nonzero exit", async () => {
    const runner = makeRunner((cmd) =>
      cmd[0] === "/usr/bin/sandbox-exec" ? { stderr: "syntax error near (", exitCode: 1 } : undefined,
    );
    await expect(
      lintSandboxProfile(runner, "/usr/bin/sandbox-exec", "/tmp/p.sb", {}),
    ).rejects.toThrow(/sandbox\.sb failed to compile: syntax error near \(/);
  });
});

describe("sandboxProxyScriptPreamble", () => {
  test("persistPidToMeta:true (default) emits the ib write-proxy-pid line + proxy exports", () => {
    const preamble = sandboxProxyScriptPreamble({ agentDir: "/agents/x", port: 41999, agentId: "agent-x" });
    // Proxy boot + port + exports.
    expect(preamble).toContain("PROXY_PORT=41999");
    expect(preamble).toContain("ib sandbox-proxy-launch --port \"$PROXY_PORT\"");
    expect(preamble).toContain("--domains '/agents/x/sandbox-domains.txt'");
    // Proxy connection-attempt logging: full record → sandbox-proxy.log,
    // allowlist-denied → agent.log (fed to the DENIALS pane).
    expect(preamble).toContain("--log '/agents/x/sandbox-proxy.log'");
    expect(preamble).toContain("--agent-log '/agents/x/agent.log'");
    expect(preamble).toContain("trap cleanup_sandbox_proxy EXIT");
    expect(preamble).toContain('export http_proxy="http://localhost:$PROXY_PORT"');
    // The per-agent meta persist lines.
    expect(preamble).toContain('PROXY_PID=$(cat "$PROXY_PID_FILE")');
    expect(preamble).toContain("ib write-proxy-pid 'agent-x' \"$PROXY_PID\" \"$PROXY_PORT\"");
  });

  test("persistPidToMeta:false (the @system coordinator) omits write-proxy-pid but keeps the proxy + exports", () => {
    const preamble = sandboxProxyScriptPreamble({ agentDir: "/coord/home", port: 42000, persistPidToMeta: false });
    expect(preamble).toContain("PROXY_PORT=42000");
    expect(preamble).toContain("ib sandbox-proxy-launch --port \"$PROXY_PORT\"");
    expect(preamble).toContain("trap cleanup_sandbox_proxy EXIT");
    expect(preamble).toContain('export https_proxy="$http_proxy"');
    // No meta persist: neither the write-proxy-pid call nor the PROXY_PID read.
    expect(preamble).not.toContain("write-proxy-pid");
    expect(preamble).not.toContain('PROXY_PID=$(cat "$PROXY_PID_FILE")');
    // The pid still lands in the --pid-file for the coordinator to read.
    expect(preamble).toContain("--pid-file \"$PROXY_PID_FILE\"");
  });

  test("throws when persistPidToMeta is true but no agentId is supplied", () => {
    expect(() => sandboxProxyScriptPreamble({ agentDir: "/x", port: 1 })).toThrow(
      /requires agentId when persistPidToMeta is true/,
    );
  });

  test("agentId may be omitted when persistPidToMeta is false", () => {
    expect(() => sandboxProxyScriptPreamble({ agentDir: "/x", port: 1, persistPidToMeta: false })).not.toThrow();
  });
});

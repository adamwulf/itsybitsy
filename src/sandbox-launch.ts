/**
 * CLI-agnostic sandbox LAUNCH machinery, extracted from ib-commands.ts so the
 * system-coordinator launcher (src/coordinator.ts, via the sandbox-system-launch
 * worker) can reuse the exact same primitives WITHOUT importing the heavy
 * ib-commands module or editing sandbox.ts.
 *
 * These are the low-level, worktree-agnostic pieces of a sandboxed launch:
 *   - `resolveSandboxExecPath` — the platform gate + `which sandbox-exec`.
 *   - `sandboxDefinitionArgs` / `sandboxExecShellPrefix` — turn a profile's
 *     `-D key=value` parameter map into argv / a shell-quoted launch prefix.
 *   - `lintSandboxProfile` — the `sandbox-exec -f … /usr/bin/true` compile check.
 *   - `sandboxProxyScriptPreamble` — the per-launch egress-proxy bootstrap that
 *     start.sh / resume.sh source before the CLI line. The `ib write-proxy-pid`
 *     line (which needs a meta.json) is opt-out via `persistPidToMeta:false` so
 *     the @system coordinator — which has no meta.json — can reuse it.
 *
 * The profile CONTENT (generateProfile, SandboxProfileParams, the parameter
 * values) still lives in sandbox.ts; this module only knows how to *invoke* a
 * profile and wire the proxy. Nothing here assumes a git worktree, so a generic
 * non-git home (the system coordinator) can supply its own roots and reuse all
 * of it unchanged.
 */

import { join } from "path";
import { shellQuote } from "./validation";

/**
 * A minimal command runner: `run(argv)` resolves with the child's captured
 * stdout/stderr and exit code. Both `newAgentSpawnCtx`/`nukeResumeSpawnCtx`
 * (ib-commands.ts) and a bare `Bun.spawn` wrapper (the coordinator) satisfy it.
 */
export interface SandboxCommandRunner {
  run(cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Resolve the absolute path to `sandbox-exec`, gating on macOS first. Throws a
 * `sandbox refused: …` error (the same wording every launcher surfaces) when the
 * platform is not darwin or the binary is not found. `opts.platform` defaults to
 * `process.platform`; callers with a platform test seam pass their resolved value.
 */
export async function resolveSandboxExecPath(
  runner: SandboxCommandRunner,
  opts?: { platform?: NodeJS.Platform },
): Promise<string> {
  const platform = opts?.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(`sandbox refused: Seatbelt requires macOS (current platform: ${platform})`);
  }
  const whichResult = await runner.run(["which", "sandbox-exec"]);
  if (whichResult.exitCode !== 0 || !whichResult.stdout.trim()) {
    throw new Error("sandbox refused: sandbox-exec not found (macOS only)");
  }
  return whichResult.stdout.trim().split(/\r?\n/)[0]!;
}

/** The `-D key=value` argv pairs for a lint / direct `sandbox-exec` invocation. */
export function sandboxDefinitionArgs(parameterValues: Record<string, string>): string[] {
  return Object.entries(parameterValues).flatMap(([key, value]) => ["-D", `${key}=${value}`]);
}

/**
 * The shell-quoted `<sandbox-exec> -f <profile> -D <k=v> …` prefix spliced ahead
 * of the CLI launch line in start.sh / resume.sh. Takes the profile path and the
 * parameter map directly (not a worktree-shaped PreparedSandbox) so the system
 * coordinator can call it with just its own values. No trailing space — callers
 * append their own separator before the command.
 *
 * `sandboxExecPath` is the ABSOLUTE executable to launch — thread the SAME path
 * resolved (and linted) by {@link resolveSandboxExecPath} so the binary that was
 * compile-checked is exactly the one launched; a bare `sandbox-exec` here would
 * re-resolve `PATH` at launch and could run a different binary. It defaults to a
 * safe fixed system path (`/usr/bin/sandbox-exec`), NEVER a bare `PATH` lookup,
 * and must be absolute — an empty or relative value is rejected.
 */
export function sandboxExecShellPrefix(
  profilePath: string,
  parameterValues: Record<string, string>,
  sandboxExecPath: string = "/usr/bin/sandbox-exec",
): string {
  if (!sandboxExecPath.startsWith("/")) {
    throw new Error(
      `sandboxExecShellPrefix requires an absolute sandbox-exec path, got ${JSON.stringify(sandboxExecPath)} (a bare PATH lookup would let the launched binary differ from the linted one)`,
    );
  }
  const parts = [shellQuote(sandboxExecPath), "-f", shellQuote(profilePath)];
  for (const [key, value] of Object.entries(parameterValues)) {
    parts.push("-D", shellQuote(`${key}=${value}`));
  }
  return parts.join(" ");
}

/**
 * Compile-check a generated profile by running the real `sandbox-exec` against
 * `/usr/bin/true`. Throws `sandbox refused: sandbox.sb failed to compile: …` on a
 * nonzero exit so a broken profile fails the launch before any CLI starts.
 */
export async function lintSandboxProfile(
  runner: SandboxCommandRunner,
  sandboxExecPath: string,
  profilePath: string,
  parameterValues: Record<string, string>,
): Promise<void> {
  const lintResult = await runner.run([
    sandboxExecPath,
    "-f", profilePath,
    ...sandboxDefinitionArgs(parameterValues),
    "/usr/bin/true",
  ]);
  if (lintResult.exitCode !== 0) {
    const detail = lintResult.stderr.trim() || `exit ${lintResult.exitCode}`;
    throw new Error(`sandbox refused: sandbox.sb failed to compile: ${detail}`);
  }
}

/** Options for {@link sandboxProxyScriptPreamble}. */
export interface SandboxProxyPreambleOptions {
  /** Directory holding sandbox-domains.txt + the proxy log/pid/ready sidecars. */
  agentDir: string;
  /** The allocated (and preflighted) localhost proxy port. */
  port: number;
  /**
   * Agent id for the `ib write-proxy-pid` line. Required when
   * `persistPidToMeta` is true (the default); ignored otherwise.
   */
  agentId?: string;
  /**
   * Emit the `ib write-proxy-pid <agentId> …` line that records the proxy pid in
   * the agent's meta.json (default true). Pass false for the @system coordinator,
   * which has no meta.json (write-proxy-pid rejects it) and reads the pid back
   * from `<agentDir>/sandbox-proxy.pid` (the `--pid-file`) instead.
   */
  persistPidToMeta?: boolean;
}

/**
 * Render the shell preamble that boots the per-launch egress proxy OUTSIDE
 * Seatbelt and exports `http(s)_proxy` for the wrapped CLI. Sourced by start.sh /
 * resume.sh right after their `log()` definition; the CLI launch line (wrapped by
 * {@link sandboxExecShellPrefix}) follows. The proxy is the only permitted egress
 * — the profile denies direct network-outbound — so this MUST run for a launch to
 * reach the network.
 *
 * With `persistPidToMeta:true` (default) the pid is both written to the
 * `--pid-file` and recorded in meta.json via `ib write-proxy-pid`. With it false
 * the meta write is omitted (the coordinator has no meta.json) and only the
 * `--pid-file` carries the pid.
 */
export function sandboxProxyScriptPreamble(opts: SandboxProxyPreambleOptions): string {
  const persistPidToMeta = opts.persistPidToMeta ?? true;
  if (persistPidToMeta && (opts.agentId === undefined || opts.agentId === "")) {
    throw new Error("sandboxProxyScriptPreamble requires agentId when persistPidToMeta is true");
  }
  const domainsPath = shellQuote(join(opts.agentDir, "sandbox-domains.txt"));
  const proxyLogPath = shellQuote(join(opts.agentDir, "sandbox-proxy.log"));
  const pidPath = shellQuote(join(opts.agentDir, "sandbox-proxy.pid"));
  const readyPath = shellQuote(join(opts.agentDir, "sandbox-proxy.ready"));
  // The meta-persist block — byte-identical to the pre-extraction output when on.
  const persistBlock = persistPidToMeta
    ? `PROXY_PID=$(cat "$PROXY_PID_FILE")\n` +
      `ib write-proxy-pid ${shellQuote(opts.agentId!)} "$PROXY_PID" "$PROXY_PORT" || log "write-proxy-pid failed (exit=$?)"\n`
    : "";
  return `
# Start the per-agent proxy outside Seatbelt. The launcher detaches/unrefs the
# proxy before returning; the agent CLI alone is wrapped below. Fail closed if the
# actual bind loses the small race after the parent-process port preflight.
PROXY_PORT=${opts.port}
PROXY_PID_FILE=${pidPath}
PROXY_READY_FILE=${readyPath}
rm -f "$PROXY_PID_FILE" "$PROXY_READY_FILE"
if ! ib sandbox-proxy-launch --port "$PROXY_PORT" --domains ${domainsPath} --log ${proxyLogPath} --pid-file "$PROXY_PID_FILE" --ready-file "$PROXY_READY_FILE"; then
    log "sandbox refused: proxy could not bind localhost:$PROXY_PORT"
    exit 1
fi
cleanup_sandbox_proxy() {
    local proxy_pid
    proxy_pid=$(cat "$PROXY_PID_FILE" 2>/dev/null || true)
    if [[ "$proxy_pid" =~ ^[1-9][0-9]*$ ]]; then kill "$proxy_pid" 2>/dev/null || true; fi
    rm -f "$PROXY_PID_FILE" "$PROXY_READY_FILE"
}
trap cleanup_sandbox_proxy EXIT
${persistBlock}export http_proxy="http://localhost:$PROXY_PORT"
export https_proxy="$http_proxy"
export HTTP_PROXY="$http_proxy"
export HTTPS_PROXY="$http_proxy"
export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="$no_proxy"
`;
}

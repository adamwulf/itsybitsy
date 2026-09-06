import { isIP } from "node:net";
import { appendFileSync } from "node:fs";
import { unlink } from "node:fs/promises";

const MAX_HEADER_BYTES = 64 * 1024;
export const SANDBOX_PROXY_HEALTH_PATH = "/__itsybitsy_sandbox_proxy_health";

export interface SandboxProxyServer {
  port: number;
  stop(): void;
}

export interface SandboxProxyLaunchOptions {
  port: number;
  domainsFile: string;
  logFile: string;
  /**
   * The agent's `agent.log`. Allowlist-denied attempts are also appended here
   * (one `[SandboxProxy]` line each) so they surface in the DENIALS pane next to
   * the kernel sandbox denials. Passed explicitly — never derived from logFile.
   */
  agentLogFile: string;
  pidFile: string;
  readyFile: string;
  executable?: string;
  commandPrefix?: string[];
  timeoutMs?: number;
}

/**
 * Where the running proxy appends structured connection-attempt records.
 * `proxyLog` (the `sandbox-proxy.log`) receives EVERY attempt outcome;
 * `agentLog` (the agent's `agent.log`) receives ONLY allowlist-denied attempts.
 * Both are optional so port-preflight / allocation helpers can omit them.
 */
export interface SandboxProxyLogTargets {
  proxyLog?: string;
  agentLog?: string;
}

/**
 * Append one complete newline-terminated line to a log file. O_APPEND makes the
 * single write atomic at end-of-file, so concurrent writers (the kernel-denial
 * collector, hooks, lifecycle) never interleave. A write failure (e.g. the log
 * dir is gone at teardown) is swallowed — logging must never break the proxied
 * connection.
 */
function appendLogLine(path: string | undefined, line: string): void {
  if (!path) return;
  try {
    appendFileSync(path, line);
  } catch {
    /* log target may be gone at teardown; never surface to the request path */
  }
}

/**
 * One `sandbox-proxy.log` record. The target is JSON-quoted so a CONNECT host
 * carrying control characters / newlines cannot forge a second log line — this
 * mirrors `formatSandboxRecord`'s quoting in `src/sandbox-denials.ts`.
 */
export function formatProxyAttempt(
  outcome: "allowed" | "denied" | "failed",
  host: string,
  port: number,
  reason?: string,
): string {
  const target = JSON.stringify(`${host}:${port}`);
  const reasonPart = reason ? ` reason=${JSON.stringify(reason)}` : "";
  return `[${new Date().toISOString()}] [proxy] ${outcome} target=${target}${reasonPart}\n`;
}

/** One `agent.log` denial record in the DENIALS-pane `[SandboxProxy]` format. */
export function formatAgentDenial(host: string, port: number): string {
  return `[${new Date().toISOString()}] [SandboxProxy] denied network-outbound target=${JSON.stringify(`${host}:${port}`)}\n`;
}

function normalizeHostname(value: string): string | null {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  try {
    // URL.hostname performs IDNA-to-ASCII conversion for both configured
    // Unicode domains and CONNECT hostnames. DNS names are case-insensitive.
    const normalized = new URL(`http://${unbracketed}`).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    return normalized || null;
  } catch {
    return null;
  }
}

/** Match an allowlist entry using exact-apex or one-or-more-subdomain rules. */
export function sandboxDomainMatches(hostname: string, entry: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host || isIP(host) !== 0) return false;

  const trimmed = entry.trim();
  if (trimmed.startsWith("*.")) {
    const apex = normalizeHostname(trimmed.slice(2));
    return apex !== null && host !== apex && host.endsWith(`.${apex}`);
  }

  const exact = normalizeHostname(trimmed);
  return exact !== null && host === exact;
}

export function isSandboxDomainAllowed(hostname: string, domains: readonly string[]): boolean {
  return domains.some((entry) => sandboxDomainMatches(hostname, entry));
}

export async function readSandboxDomains(path: string): Promise<string[]> {
  const content = await Bun.file(path).text();
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(`http://${authority}`);
    if (!parsed.port) return null;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function allowedTarget(host: string, port: number, domains: readonly string[]): boolean {
  return (port === 80 || port === 443)
    && isIP(host) === 0
    && isSandboxDomainAllowed(host, domains);
}

function response(status: number, reason: string, body = ""): string {
  return `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/**
 * Start one allowlist proxy. Bun's raw TCP server is used because CONNECT must
 * switch from HTTP header parsing to a byte-for-byte bidirectional tunnel.
 */
export function startSandboxProxyServer(
  port: number,
  domains: readonly string[],
  hostname = "localhost",
  connectFn: (options: any) => Promise<any> = Bun.connect,
  logTargets: SandboxProxyLogTargets = {},
): SandboxProxyServer {
  const socketHandlers = {
      open(socket: any) {
        socket.data = { buffer: Buffer.alloc(0), upstream: null, pending: [] as Buffer[], tunnel: false, outcomeLogged: false };
      },
      data(socket: any, chunk: Uint8Array) {
        const state = socket.data as {
          buffer: Buffer;
          upstream: any;
          pending: Buffer[];
          tunnel: boolean;
          outcomeLogged: boolean;
        };
        const bytes = Buffer.from(chunk);
        if (state.tunnel) {
          if (state.upstream) state.upstream.write(bytes);
          else state.pending.push(bytes);
          return;
        }

        state.buffer = Buffer.concat([state.buffer, bytes]);
        if (state.buffer.length > MAX_HEADER_BYTES) {
          socket.end(response(431, "Request Header Fields Too Large"));
          return;
        }
        const headerEnd = state.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headerBytes = state.buffer.subarray(0, headerEnd + 4);
        const remainder = state.buffer.subarray(headerEnd + 4);
        const header = headerBytes.toString("latin1");
        const lines = header.slice(0, -4).split("\r\n");
        const requestLine = lines[0] ?? "";
        const match = /^(\S+)\s+(\S+)\s+(HTTP\/1\.[01])$/.exec(requestLine);
        if (!match) {
          socket.end(response(400, "Bad Request"));
          return;
        }

        const method = match[1]!.toUpperCase();
        const target = match[2]!;
        if (method !== "CONNECT" && target === SANDBOX_PROXY_HEALTH_PATH) {
          socket.end(response(200, "OK", "ok"));
          return;
        }

        let host: string;
        let targetPort: number;
        let initialPayload: Buffer;
        if (method === "CONNECT") {
          const authority = parseAuthority(target);
          if (!authority) {
            socket.end(response(400, "Bad CONNECT Target"));
            return;
          }
          host = authority.host;
          targetPort = authority.port;
          initialPayload = remainder;
        } else {
          let url: URL;
          try {
            url = new URL(target);
          } catch {
            socket.end(response(400, "Absolute URI Required"));
            return;
          }
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            socket.end(response(400, "Unsupported Scheme"));
            return;
          }
          host = url.hostname.replace(/^\[|\]$/g, "");
          targetPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
          const originTarget = `${url.pathname || "/"}${url.search}`;
          const forwardedLines = [`${match[1]} ${originTarget} ${match[3]}`];
          for (const line of lines.slice(1)) {
            if (!/^proxy-connection\s*:/i.test(line)) forwardedLines.push(line);
          }
          initialPayload = Buffer.concat([
            Buffer.from(`${forwardedLines.join("\r\n")}\r\n\r\n`, "latin1"),
            remainder,
          ]);
        }

        // Record at most one outcome per connection attempt. `denied` returns
        // early; `allowed`/`failed` are mutually exclusive (upstream opened vs.
        // upstream unreachable) but the guard also absorbs any error/catch race.
        const logOutcome = (outcome: "allowed" | "failed", reason?: string) => {
          if (state.outcomeLogged) return;
          state.outcomeLogged = true;
          appendLogLine(logTargets.proxyLog, formatProxyAttempt(outcome, host, targetPort, reason));
        };

        if (!allowedTarget(host, targetPort, domains)) {
          appendLogLine(logTargets.proxyLog, formatProxyAttempt("denied", host, targetPort, "not in allowlist"));
          appendLogLine(logTargets.agentLog, formatAgentDenial(host, targetPort));
          socket.end(response(403, "Forbidden", "sandbox proxy: target denied\n"));
          return;
        }

        state.tunnel = true;
        void connectFn({
          hostname: host,
          port: targetPort,
          socket: {
            open(upstream: any) {
              state.upstream = upstream;
              logOutcome("allowed");
              if (method === "CONNECT") {
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (initialPayload.length > 0) upstream.write(initialPayload);
              } else {
                upstream.write(initialPayload);
              }
              for (const pending of state.pending) upstream.write(pending);
              state.pending.length = 0;
            },
            data(_upstream: any, data: Uint8Array) {
              socket.write(data);
            },
            close() {
              try { socket.end(); } catch { /* client already closed */ }
            },
            error() {
              if (!state.upstream) {
                logOutcome("failed", "upstream unreachable");
                try { socket.end(response(502, "Bad Gateway")); } catch { /* closed */ }
              } else {
                try { socket.end(); } catch { /* closed */ }
              }
            },
          },
        }).catch(() => {
          logOutcome("failed", "upstream unreachable");
          try { socket.end(response(502, "Bad Gateway")); } catch { /* closed */ }
        });
      },
      close(socket: any) {
        try { socket.data?.upstream?.end(); } catch { /* already closed */ }
      },
      error() {
        // Per-connection errors close that socket; the listener remains alive.
      },
  };

  const listeners: any[] = [];
  if (hostname === "localhost") {
    const ipv4 = Bun.listen({ hostname: "127.0.0.1", port, exclusive: true, socket: socketHandlers });
    listeners.push(ipv4);
    try {
      listeners.push(Bun.listen({ hostname: "::1", port: ipv4.port, exclusive: true, socket: socketHandlers }));
    } catch (err) {
      ipv4.stop(true);
      throw err;
    }
  } else {
    listeners.push(Bun.listen({ hostname, port, exclusive: true, socket: socketHandlers }));
  }

  return {
    port: listeners[0].port,
    stop() {
      for (const listener of listeners) listener.stop(true);
    },
  };
}

/** Bind and immediately release a port. Used by fail-hard spawn preflight. */
export function assertSandboxProxyPortAvailable(port: number): void {
  const server = startSandboxProxyServer(port, []);
  server.stop();
}

/** Allocate a fresh localhost port, proving that it can be bound first. */
export function allocateSandboxProxyPort(): number {
  const server = startSandboxProxyServer(0, []);
  const port = server.port;
  server.stop();
  return port;
}

export async function isSandboxProxyHealthy(port: number, timeoutMs = 750): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket: any) {
          socket.write(`GET ${SANDBOX_PROXY_HEALTH_PATH} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        },
        data(socket: any, data: Uint8Array) {
          const ok = Buffer.from(data).toString("latin1").startsWith("HTTP/1.1 200");
          finish(ok);
          try { socket.end(); } catch { /* closed */ }
        },
        close() {
          finish(false);
        },
        error() {
          finish(false);
        },
      },
    }).catch(() => finish(false));
  });
}

/** Spawn the long-lived proxy detached from the launcher's pane/process group. */
export async function launchSandboxProxyDetached(
  options: SandboxProxyLaunchOptions,
): Promise<number> {
  await Promise.all([
    unlink(options.pidFile).catch(() => {}),
    unlink(options.readyFile).catch(() => {}),
  ]);
  const commandPrefix = options.commandPrefix ?? [options.executable ?? "ib"];
  const proc = Bun.spawn([
    ...commandPrefix,
    "sandbox-proxy",
    "--port", String(options.port),
    "--domains", options.domainsFile,
    "--log", options.logFile,
    "--agent-log", options.agentLogFile,
    "--pid-file", options.pidFile,
    "--ready-file", options.readyFile,
  ], {
    stdin: "ignore",
    stdout: Bun.file(options.logFile),
    stderr: Bun.file(options.logFile),
    detached: true,
  });
  proc.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    if (await Bun.file(options.readyFile).exists().catch(() => false)) {
      if (await isSandboxProxyHealthy(options.port)) return proc.pid;
    }
    if (proc.exitCode !== null) break;
    await Bun.sleep(25);
  }

  try { process.kill(proc.pid, "SIGTERM"); } catch { /* already exited */ }
  throw new Error(`sandbox proxy could not bind localhost:${options.port}`);
}

/** Long-running implementation behind the internal `ib sandbox-proxy` command. */
export async function runSandboxProxy(options: {
  port: number;
  domainsFile: string;
  logFile: string;
  agentLogFile: string;
  pidFile: string;
  readyFile: string;
}): Promise<never> {
  const domains = await readSandboxDomains(options.domainsFile);
  const server = startSandboxProxyServer(options.port, domains, "localhost", Bun.connect, {
    proxyLog: options.logFile,
    agentLog: options.agentLogFile,
  });
  await Bun.write(options.pidFile, `${process.pid}\n`);
  await Bun.write(options.readyFile, `ready ${server.port}\n`);

  const shutdown = () => {
    server.stop();
    void unlink(options.readyFile).catch(() => {});
    void unlink(options.pidFile).catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return await new Promise<never>(() => {});
}

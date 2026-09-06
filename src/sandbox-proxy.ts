import { isIP } from "node:net";
import { appendFileSync, closeSync, openSync } from "node:fs";
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
 * The JSON-quoted `target="host:port"` field shared by both record formats.
 * Quoting is what stops a crafted host from forging a second log line — WHATWG
 * URL parsing rejects control characters, whitespace and newlines in a host,
 * but a literal `"` IS a valid host code point, so the escape is load-bearing.
 * This mirrors `formatSandboxRecord`'s quoting in `src/sandbox-denials.ts`.
 * The proxy strips the brackets from an IPv6 literal when parsing, so they are
 * restored here: `[::1]:443`, never the ambiguous `::1:443`.
 */
function formatTarget(host: string, port: number): string {
  const shown = isIP(host) === 6 ? `[${host}]` : host;
  return JSON.stringify(`${shown}:${port}`);
}

/** One `sandbox-proxy.log` record. */
export function formatProxyAttempt(
  outcome: "allowed" | "denied" | "failed",
  host: string,
  port: number,
  reason?: string,
): string {
  const reasonPart = reason ? ` reason=${JSON.stringify(reason)}` : "";
  return `[${new Date().toISOString()}] [proxy] ${outcome} target=${formatTarget(host, port)}${reasonPart}\n`;
}

/** One `agent.log` denial record in the DENIALS-pane `[SandboxProxy]` format. */
export function formatAgentDenial(host: string, port: number): string {
  return `[${new Date().toISOString()}] [SandboxProxy] denied network-outbound target=${formatTarget(host, port)}\n`;
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

interface SocketWriteQueue {
  socket: any;
  source: any;
  chunks: Buffer[];
  paused: boolean;
  ending: boolean;
  closed: boolean;
}

function writeQueue(socket: any, source: any): SocketWriteQueue {
  return { socket, source, chunks: [], paused: false, ending: false, closed: false };
}

function flushWrites(queue: SocketWriteQueue): void {
  if (queue.closed) return;
  while (queue.socket && queue.chunks.length > 0) {
    const chunk = queue.chunks[0]!;
    const written = queue.socket.write(chunk);
    if (written < chunk.length) {
      if (written > 0) queue.chunks[0] = chunk.subarray(written);
      break;
    }
    queue.chunks.shift();
  }
  if (queue.chunks.length > 0) {
    if (!queue.paused && queue.source) {
      queue.paused = true;
      // Bun can deliver a few MiB of data callbacks after pause(); those bytes
      // stay queued, so the per-connection bound is a few MiB, not one chunk.
      queue.source.pause();
    }
  } else if (queue.ending) {
    // Bun end() synchronously fires close(), re-entering the paired queue's
    // flushWrites; mark this queue closed before that can happen.
    queue.closed = true;
    try { queue.socket?.end(); } catch { /* already closed */ }
  } else if (queue.paused) {
    queue.paused = false;
    queue.source.resume();
  }
}

function enqueueWrite(queue: SocketWriteQueue, bytes: Uint8Array | string): void {
  if (queue.closed || bytes.length === 0) return;
  // Bun's data buffers are borrowed; retain our own bytes until drain.
  queue.chunks.push(Buffer.from(bytes));
  flushWrites(queue);
}

function endAfterWrites(queue: SocketWriteQueue): void {
  queue.ending = true;
  flushWrites(queue);
}

function discardWrites(queue: SocketWriteQueue): void {
  queue.closed = true;
  queue.chunks.length = 0;
}

interface ProxyConnection {
  buffer: Buffer;
  upstream: any;
  toClient: SocketWriteQueue;
  toUpstream: SocketWriteQueue;
  tunnel: boolean;
  outcomeLogged: boolean;
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
        socket.data = {
          buffer: Buffer.alloc(0), upstream: null,
          toClient: writeQueue(socket, null), toUpstream: writeQueue(null, socket),
          tunnel: false, outcomeLogged: false,
        } satisfies ProxyConnection;
      },
      data(socket: any, chunk: Uint8Array) {
        const state = socket.data as ProxyConnection;
        const bytes = Buffer.from(chunk);
        if (state.tunnel) {
          enqueueWrite(state.toUpstream, bytes);
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
        // Initial and pre-connect bytes share the same FIFO as tunnel traffic.
        enqueueWrite(state.toUpstream, initialPayload);
        state.buffer = Buffer.alloc(0);
        void connectFn({
          hostname: host,
          port: targetPort,
          socket: {
            open(upstream: any) {
              logOutcome("allowed");
              if (state.toClient.closed) {
                discardWrites(state.toUpstream);
                upstream.end();
                return;
              }
              state.upstream = upstream;
              state.toUpstream.socket = upstream;
              state.toClient.source = upstream;
              if (method === "CONNECT") {
                enqueueWrite(state.toClient, "HTTP/1.1 200 Connection Established\r\n\r\n");
              }
              flushWrites(state.toUpstream);
            },
            data(_upstream: any, data: Uint8Array) {
              enqueueWrite(state.toClient, data);
            },
            drain() {
              flushWrites(state.toUpstream);
            },
            close() {
              discardWrites(state.toUpstream);
              endAfterWrites(state.toClient);
            },
            error() {
              if (!state.upstream) {
                logOutcome("failed", "upstream unreachable");
                try { socket.end(response(502, "Bad Gateway")); } catch { /* closed */ }
              } else {
                discardWrites(state.toUpstream);
                endAfterWrites(state.toClient);
              }
            },
          },
        }).catch(() => {
          logOutcome("failed", "upstream unreachable");
          try { socket.end(response(502, "Bad Gateway")); } catch { /* closed */ }
        });
      },
      drain(socket: any) {
        flushWrites((socket.data as ProxyConnection).toClient);
      },
      close(socket: any) {
        const state = socket.data as ProxyConnection;
        discardWrites(state.toClient);
        // Client-close only: let a paused upstream observe FIN. Resuming the
        // client on upstream close could discard the response still flushing.
        if (state.toClient.paused) {
          state.toClient.paused = false;
          state.toClient.source.resume();
        }
        endAfterWrites(state.toUpstream);
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
  // The proxy's stdout/stderr share `logFile` with the structured `[proxy]`
  // records it appends itself. Hand the child an O_APPEND descriptor: a
  // `Bun.file(logFile)` stdio target is positional (offset 0, no O_APPEND), so
  // any runtime output from the proxy — a startup error, an uncaught exception
  // trace — would overwrite the head of the file and corrupt those records
  // (and each restart would overwrite the previous incarnation's output).
  const stdioFd = openSync(options.logFile, "a");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([
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
      stdout: stdioFd,
      stderr: stdioFd,
      detached: true,
    });
  } finally {
    // The child holds its own copy of the descriptor; the launcher's is done.
    closeSync(stdioFd);
  }
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

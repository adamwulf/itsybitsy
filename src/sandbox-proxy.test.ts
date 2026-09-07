import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection, createServer, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import {
  allocateSandboxProxyPort,
  assertSandboxProxyPortAvailable,
  formatAgentDenial,
  formatProxyAttempt,
  isSandboxDomainAllowed,
  isSandboxProxyHealthy,
  launchSandboxProxyDetached,
  sandboxDomainMatches,
  startSandboxProxyServer,
} from "./sandbox-proxy";

async function proxyExchange(
  port: number,
  request: string,
  afterEstablished?: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    let sentTunnelData = false;
    const timer = setTimeout(() => reject(new Error(`proxy exchange timed out: ${output}`)), 2_000);
    const finish = () => {
      clearTimeout(timer);
      resolve(output);
    };
    void Bun.connect({
      hostname: "localhost",
      port,
      socket: {
        open(socket: any) {
          socket.write(request);
        },
        data(socket: any, data: Uint8Array) {
          output += Buffer.from(data).toString("latin1");
          if (afterEstablished && output.includes("200 Connection Established") && !sentTunnelData) {
            sentTunnelData = true;
            socket.write(afterEstablished);
            return;
          }
          if (output.includes("echo:") || output.includes("Forbidden") || output.includes("upstream-ok")) {
            try { socket.end(); } catch { /* closed */ }
            finish();
          }
        },
        close() {
          finish();
        },
        error(_socket: any, error: Error) {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function fakeUpstreamConnect(options: any): Promise<any> {
  const upstream = {
    write(data: Uint8Array | string) {
      const text = Buffer.from(data as any).toString("latin1");
      if (text.startsWith("GET ")) {
        options.socket.data(upstream, Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nupstream-ok"));
      } else {
        options.socket.data(upstream, Buffer.from(`echo:${text}`));
      }
      return Buffer.byteLength(data);
    },
    end() {},
    pause() {},
    resume() {},
  };
  options.socket.open(upstream);
  return Promise.resolve(upstream);
}

describe("sandbox proxy domain matching", () => {
  test("apex entries are exact and do not include subdomains", () => {
    expect(sandboxDomainMatches("github.com", "github.com")).toBe(true);
    expect(sandboxDomainMatches("api.github.com", "github.com")).toBe(false);
  });

  test("wildcards match one or more labels but not the apex", () => {
    expect(sandboxDomainMatches("a.x.com", "*.x.com")).toBe(true);
    expect(sandboxDomainMatches("a.b.x.com", "*.x.com")).toBe(true);
    expect(sandboxDomainMatches("x.com", "*.x.com")).toBe(false);
  });

  test("matching is case-insensitive and normalizes IDNs to punycode", () => {
    expect(sandboxDomainMatches("API.GITHUB.COM", "api.github.com")).toBe(true);
    expect(sandboxDomainMatches("xn--bcher-kva.example", "bücher.example")).toBe(true);
  });

  test("IP literals are always denied", () => {
    expect(isSandboxDomainAllowed("127.0.0.1", ["127.0.0.1", "*"])).toBe(false);
    expect(isSandboxDomainAllowed("::1", ["::1"])).toBe(false);
  });
});

describe("sandbox proxy CONNECT and HTTP behavior", () => {
  test("zero and short upstream writes retain initial bytes ahead of later tunnel bytes", async () => {
    const expected = "initial-payload:later-tunnel-payload";
    let received = "";
    let writes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", async options => {
      const upstream = {
        write(data: Buffer) {
          const count = writes++ === 0 ? 0 : Math.min(3, data.length);
          received += data.subarray(0, count).toString();
          if (received === expected) {
            options.socket.data(upstream, Buffer.from(`echo:${received}`));
          } else {
            clearTimeout(timer);
            timer = setTimeout(() => options.socket.drain?.(upstream), 5);
          }
          return count;
        },
        pause() {},
        resume() {},
        end() {},
      };
      options.socket.open(upstream);
      // Bound the stub's lifetime so a pump that loses bytes reaches the byte
      // assertion instead of timing out while waiting for the complete echo.
      closeTimer = setTimeout(() => options.socket.close(upstream), 1_500);
      return upstream;
    });
    try {
      const output = await proxyExchange(proxy.port,
        "CONNECT allowed.example:443 HTTP/1.1\r\n\r\ninitial-payload:",
        "later-tunnel-payload");
      expect(received).toBe(expected);
      expect(output).toContain(`echo:${expected}`);
      expect(writes).toBeGreaterThan(2);
    } finally {
      clearTimeout(timer);
      clearTimeout(closeTimer);
      proxy.stop();
    }
  });

  test("a slow client pauses the upstream and client close resumes it", async () => {
    let pauseCalls = 0;
    let sent = 0;
    const maxBytes = 64 * 1024 * 1024;
    const sentUntilBlocked = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", async options => {
      const upstream = {
        write(data: Buffer) { return data.length; },
        pause() { pauseCalls++; },
        resume() { resumed.resolve(); },
        end() {},
      };
      options.socket.open(upstream);
      // The client never reads. Stop producing as soon as the proxy pauses us,
      // with a finite ceiling so disabling pause fails an assertion quickly.
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      while (pauseCalls === 0 && sent < maxBytes) {
        options.socket.data(upstream, chunk);
        sent += chunk.length;
      }
      sentUntilBlocked.resolve();
      return upstream;
    });
    const client = createConnection({ host: "127.0.0.1", port: proxy.port });
    const failed = Promise.withResolvers<never>();
    const timeout = setTimeout(() => failed.reject(new Error("backpressure lifecycle timed out")), 2_000);
    try {
      client.on("error", failed.reject);
      client.pause();
      client.on("connect", () => client.write("CONNECT allowed.example:443 HTTP/1.1\r\n\r\n"));
      await Promise.race([sentUntilBlocked.promise, failed.promise]);
      expect(pauseCalls).toBeGreaterThan(0);
      expect(sent).toBeLessThan(maxBytes);
      client.destroy();
      await Promise.race([resumed.promise, failed.promise]);
    } finally {
      clearTimeout(timeout);
      client.destroy();
      proxy.stop();
    }
  });

  for (const direction of ["download", "upload"] as const) {
    test(`CONNECT preserves a 64 MiB ${direction} with a slow reader`, async () => {
      // Node streams handle the test sender's backpressure independently of
      // the real Bun socket pump under test. Hashes also catch reordering and
      // reuse of borrowed data buffers, not just missing bytes.
      const payload = randomBytes(64 * 1024 * 1024);
      const expectedHash = createHash("sha256").update(payload).digest("hex");
      const receivedHash = createHash("sha256");
      let received = 0;
      let upstreamSocket: Socket | undefined;
      const resumeTimers = new Set<ReturnType<typeof setTimeout>>();
      const slowRead = (socket: Socket, chunk: Buffer) => {
        received += chunk.length;
        receivedHash.update(chunk);
        socket.pause();
        const timer = setTimeout(() => {
          resumeTimers.delete(timer);
          socket.resume();
        }, 2);
        resumeTimers.add(timer);
      };
      const completed = Promise.withResolvers<void>();
      const upstream = createServer(socket => {
        upstreamSocket = socket;
        socket.on("error", completed.reject);
        if (direction === "download") socket.end(payload);
        else {
          socket.on("data", chunk => slowRead(socket, Buffer.from(chunk)));
          socket.on("end", completed.resolve);
        }
      });
      await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
      const upstreamPort = (upstream.address() as { port: number }).port;
      const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", options =>
        Bun.connect({ ...options, hostname: "127.0.0.1", port: upstreamPort }));
      const client = createConnection({ host: "127.0.0.1", port: proxy.port });
      const timeout = setTimeout(() => completed.reject(new Error(
        `${direction}: received ${received} of ${payload.length} bytes`,
      )), 20_000);
      try {
        let header = Buffer.alloc(0);
        let established = false;
        client.on("error", completed.reject);
        client.on("connect", () => {
          // Include early tunnel bytes with CONNECT to exercise initialPayload.
          const request = Buffer.from("CONNECT allowed.example:443 HTTP/1.1\r\n\r\n");
          client.write(direction === "upload"
            ? Buffer.concat([request, payload.subarray(0, 1024)]) : request);
        });
        client.on("data", data => {
          let chunk = Buffer.from(data);
          if (!established) {
            header = Buffer.concat([header, chunk]);
            const end = header.indexOf("\r\n\r\n");
            if (end === -1) return;
            if (header.subarray(0, end).toString() !== "HTTP/1.1 200 Connection Established") {
              completed.reject(new Error(`Unexpected CONNECT response: ${header.toString()}`));
              return;
            }
            established = true;
            if (direction === "upload") client.end(payload.subarray(1024));
            chunk = header.subarray(end + 4);
          }
          if (direction === "download") slowRead(client, chunk);
        });
        if (direction === "download") client.on("end", completed.resolve);
        await completed.promise;
        expect(received).toBe(payload.length);
        expect(receivedHash.digest("hex")).toBe(expectedHash);
      } finally {
        clearTimeout(timeout);
        for (const timer of resumeTimers) clearTimeout(timer);
        client.destroy();
        proxy.stop();
        upstreamSocket?.destroy();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
    }, 25_000);
  }

  test("allowed CONNECT establishes a bidirectional tunnel", async () => {
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", fakeUpstreamConnect);
    try {
      const output = await proxyExchange(
        proxy.port,
        "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n",
        "ping",
      );
      expect(output).toContain("200 Connection Established");
      expect(output).toContain("echo:ping");
    } finally {
      proxy.stop();
    }
  });

  test("denied CONNECT is refused without dialing upstream", async () => {
    let dialed = false;
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", async () => {
      dialed = true;
      throw new Error("must not dial");
    });
    try {
      const output = await proxyExchange(
        proxy.port,
        "CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n",
      );
      expect(output).toContain("403 Forbidden");
      expect(dialed).toBe(false);
    } finally {
      proxy.stop();
    }
  });

  test("ports other than 80 and 443 and IP-literal CONNECTs are refused", async () => {
    const proxy = startSandboxProxyServer(0, ["allowed.example", "127.0.0.1"], "localhost", fakeUpstreamConnect);
    try {
      const wrongPort = await proxyExchange(proxy.port, "CONNECT allowed.example:22 HTTP/1.1\r\n\r\n");
      const ipLiteral = await proxyExchange(proxy.port, "CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n");
      expect(wrongPort).toContain("403 Forbidden");
      expect(ipLiteral).toContain("403 Forbidden");
    } finally {
      proxy.stop();
    }
  });

  test("absolute-URI HTTP is allowlisted and forwarded in origin form", async () => {
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", fakeUpstreamConnect);
    try {
      const output = await proxyExchange(
        proxy.port,
        "GET http://allowed.example/path?q=1 HTTP/1.1\r\nHost: allowed.example\r\n\r\n",
      );
      expect(output).toContain("upstream-ok");
    } finally {
      proxy.stop();
    }
  });

  test("each proxy consults only its own agent allowlist", async () => {
    const agentA = startSandboxProxyServer(0, ["a.example"], "localhost", fakeUpstreamConnect);
    const agentB = startSandboxProxyServer(0, ["b.example"], "localhost", fakeUpstreamConnect);
    try {
      const aToA = await proxyExchange(agentA.port, "CONNECT a.example:443 HTTP/1.1\r\n\r\n", "A");
      const aToB = await proxyExchange(agentA.port, "CONNECT b.example:443 HTTP/1.1\r\n\r\n");
      const bToB = await proxyExchange(agentB.port, "CONNECT b.example:443 HTTP/1.1\r\n\r\n", "B");
      expect(aToA).toContain("echo:A");
      expect(aToB).toContain("403 Forbidden");
      expect(bToB).toContain("echo:B");
    } finally {
      agentA.stop();
      agentB.stop();
    }
  });

  test("occupied port preflight fails", () => {
    const proxy = startSandboxProxyServer(0, []);
    try {
      expect(() => assertSandboxProxyPortAvailable(proxy.port)).toThrow();
    } finally {
      proxy.stop();
    }
  });

  test("detached launcher writes lifecycle files and serves health checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-proxy-launch-"));
    const port = allocateSandboxProxyPort();
    const domainsFile = join(dir, "domains.txt");
    const pidFile = join(dir, "proxy.pid");
    const readyFile = join(dir, "proxy.ready");
    await Bun.write(domainsFile, "allowed.example\n");
    let pid: number | null = null;
    try {
      pid = await launchSandboxProxyDetached({
        port,
        domainsFile,
        logFile: join(dir, "proxy.log"),
        agentLogFile: join(dir, "agent.log"),
        pidFile,
        readyFile,
        commandPrefix: [process.execPath, join(import.meta.dir, "index.ts")],
      });
      expect(await Bun.file(pidFile).text()).toBe(`${pid}\n`);
      expect(await Bun.file(readyFile).exists()).toBe(true);
      expect(await isSandboxProxyHealthy(port)).toBe(true);
    } finally {
      if (pid !== null) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the proxy's own stdio appends to the log and never overwrites earlier records", async () => {
    // `sandbox-proxy.log` is shared between the structured `[proxy]` records the
    // proxy appends and the child's stdout/stderr. A positional stdio target
    // (offset 0) would let a startup error overwrite the head of the file; the
    // launcher must hand the child an O_APPEND descriptor instead. Drive the
    // failure path: a missing domains file makes `ib sandbox-proxy` print the
    // error to stderr and exit 1.
    const dir = await mkdtemp(join(tmpdir(), "sandbox-proxy-stdio-"));
    const logFile = join(dir, "proxy.log");
    const earlier = '[2026-09-06T20:00:00.000Z] [proxy] denied target="denied.example:443" reason="not in allowlist"\n';
    await Bun.write(logFile, earlier);
    try {
      await expect(launchSandboxProxyDetached({
        port: allocateSandboxProxyPort(),
        domainsFile: join(dir, "missing-domains.txt"),
        logFile,
        agentLogFile: join(dir, "agent.log"),
        pidFile: join(dir, "proxy.pid"),
        readyFile: join(dir, "proxy.ready"),
        commandPrefix: [process.execPath, join(import.meta.dir, "index.ts")],
        timeoutMs: 10_000,
      })).rejects.toThrow("sandbox proxy could not bind");
      const text = await Bun.file(logFile).text();
      // The earlier record is intact at the head; the child's stderr follows it.
      expect(text.startsWith(earlier)).toBe(true);
      expect(text.length).toBeGreaterThan(earlier.length);
      expect(text.slice(earlier.length)).toContain("missing-domains.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sandbox proxy connection logging", () => {
  test("denied target logs to both the proxy log and the agent log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-proxy-log-"));
    const proxyLog = join(dir, "sandbox-proxy.log");
    const agentLog = join(dir, "agent.log");
    let dialed = false;
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", async () => {
      dialed = true;
      throw new Error("must not dial");
    }, { proxyLog, agentLog });
    try {
      const output = await proxyExchange(
        proxy.port,
        "CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n",
      );
      expect(output).toContain("403 Forbidden");
      expect(dialed).toBe(false);
      const proxyText = await Bun.file(proxyLog).text();
      expect(proxyText).toContain(`[proxy] denied target="denied.example:443" reason="not in allowlist"`);
      const agentText = await Bun.file(agentLog).text();
      expect(agentText).toContain(`[SandboxProxy] denied network-outbound target="denied.example:443"`);
      // The agent-log denial must be a single, complete newline-terminated line.
      expect(agentText.endsWith("\n")).toBe(true);
      expect(agentText.trimEnd().split("\n")).toHaveLength(1);
    } finally {
      proxy.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("allowed target logs only to the proxy log, never the agent log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-proxy-log-"));
    const proxyLog = join(dir, "sandbox-proxy.log");
    const agentLog = join(dir, "agent.log");
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", fakeUpstreamConnect, { proxyLog, agentLog });
    try {
      const output = await proxyExchange(
        proxy.port,
        "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n",
        "ping",
      );
      expect(output).toContain("echo:ping");
      const proxyText = await Bun.file(proxyLog).text();
      expect(proxyText).toContain(`[proxy] allowed target="allowed.example:443"`);
      // No denial occurred, so the agent log is never touched (never created).
      expect(await Bun.file(agentLog).exists()).toBe(false);
    } finally {
      proxy.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("upstream failure logs a failed line to the proxy log, never the agent log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-proxy-log-"));
    const proxyLog = join(dir, "sandbox-proxy.log");
    const agentLog = join(dir, "agent.log");
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", async () => {
      throw new Error("upstream unreachable");
    }, { proxyLog, agentLog });
    try {
      const output = await proxyExchange(
        proxy.port,
        "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n",
      );
      expect(output).toContain("502 Bad Gateway");
      const proxyText = await Bun.file(proxyLog).text();
      expect(proxyText).toContain(`[proxy] failed target="allowed.example:443" reason="upstream unreachable"`);
      expect(proxyText).not.toContain("[proxy] allowed");
      expect(await Bun.file(agentLog).exists()).toBe(false);
    } finally {
      proxy.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the health-check path is never logged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-proxy-log-"));
    const proxyLog = join(dir, "sandbox-proxy.log");
    const agentLog = join(dir, "agent.log");
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", fakeUpstreamConnect, { proxyLog, agentLog });
    try {
      expect(await isSandboxProxyHealthy(proxy.port)).toBe(true);
      expect(await Bun.file(proxyLog).exists()).toBe(false);
      expect(await Bun.file(agentLog).exists()).toBe(false);
    } finally {
      proxy.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a host with control characters / a quote cannot forge a second log line", () => {
    // new URL() sanitizes CONNECT hosts before they reach the formatter, so the
    // JSON quoting is the anti-forgery boundary — exercise it directly with a
    // host carrying a newline and a double quote.
    const forged = formatAgentDenial(`evil.example:443"\n[2026-01-01T00:00:00.000Z] [SandboxProxy] denied network-outbound target="pwned`, 443);
    expect(forged.endsWith("\n")).toBe(true);
    // Exactly one physical line of content: the injected newline is escaped.
    expect(forged.trimEnd().split("\n")).toHaveLength(1);
    expect(forged).toContain("\\n");
    expect(forged).toContain('\\"');

    const proxyLine = formatProxyAttempt("denied", `bad\nhost`, 443, "not in allowlist");
    expect(proxyLine.endsWith("\n")).toBe(true);
    expect(proxyLine.trimEnd().split("\n")).toHaveLength(1);
    expect(proxyLine).toContain("\\n");
  });

  test("a literal double quote in a host is escaped, not a line breaker", async () => {
    // WHATWG URL parsing accepts `"` as a host code point, so `%22` in a CONNECT
    // authority reaches the formatter as a real quote. It must be escaped so the
    // record stays one well-formed line.
    const dir = await mkdtemp(join(tmpdir(), "sandbox-proxy-log-"));
    const proxyLog = join(dir, "sandbox-proxy.log");
    const agentLog = join(dir, "agent.log");
    const proxy = startSandboxProxyServer(0, ["allowed.example"], "localhost", async () => {
      throw new Error("must not dial");
    }, { proxyLog, agentLog });
    try {
      const output = await proxyExchange(proxy.port, "CONNECT evil%22example:443 HTTP/1.1\r\n\r\n");
      expect(output).toContain("403 Forbidden");
      const agentText = await Bun.file(agentLog).text();
      expect(agentText.trimEnd().split("\n")).toHaveLength(1);
      expect(agentText).toContain('target="evil\\"example:443"');
    } finally {
      proxy.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("IPv6 literal targets are bracketed in the target field", () => {
    // The proxy strips brackets when parsing the authority; the record must put
    // them back so `[::1]:443` is not logged as the ambiguous `::1:443`.
    expect(formatAgentDenial("::1", 443)).toContain('target="[::1]:443"');
    expect(formatProxyAttempt("denied", "2001:db8::1", 80, "not in allowlist")).toContain('target="[2001:db8::1]:80"');
    expect(formatProxyAttempt("denied", "127.0.0.1", 443)).toContain('target="127.0.0.1:443"');
    expect(formatProxyAttempt("allowed", "allowed.example", 443)).toContain('target="allowed.example:443"');
  });
});

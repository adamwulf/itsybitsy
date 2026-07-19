import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  allocateSandboxProxyPort,
  assertSandboxProxyPortAvailable,
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
    },
    end() {},
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
});

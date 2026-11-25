import { afterEach, describe, expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import {
  IrohError,
  irohAddonLoaderCtx,
  isIrohTooLong,
  loadIroh,
  parseIrohCloseReason,
  shortIrohMessage,
  type Iroh,
  type IrohEndpoint,
} from "./iroh";

const HEX64 = /^[0-9a-f]{64}$/;

afterEach(() => {
  irohAddonLoaderCtx.reset();
});

describe("loadIroh wrapper (real addon)", () => {
  test("a generated key's bytes are a 32-byte Uint8Array that round-trips to the same id", async () => {
    const iroh = await loadIroh();
    const key = iroh.SecretKey.generate();
    const bytes = key.toBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
    const id = key.public().toString();
    expect(id).toMatch(HEX64);
    expect(iroh.SecretKey.fromBytes(bytes).public().toString()).toBe(id);
  });

  test("fmtShort is the first 10 hex characters of the id", async () => {
    const iroh = await loadIroh();
    const id = iroh.SecretKey.generate().public();
    expect(id.fmtShort()).toBe(id.toString().slice(0, 10));
  });

  test("EndpointId.fromString parses a full id back to itself", async () => {
    const iroh = await loadIroh();
    const id = iroh.SecretKey.generate().public().toString();
    expect(iroh.EndpointId.fromString(id).toString()).toBe(id);
  });

  test("addon errors come back as short IrohErrors naming the call", async () => {
    const iroh = await loadIroh();
    const id = iroh.SecretKey.generate().public().toString();
    let caught: unknown;
    try {
      iroh.EndpointId.fromString(id.toUpperCase());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IrohError);
    expect((caught as IrohError).op).toBe("EndpointId.fromString");
    expect((caught as IrohError).message).toBe("EndpointId.fromString: failed to decode hex string");

    expect(() => iroh.SecretKey.fromBytes(new Uint8Array(31))).toThrow(
      new IrohError("SecretKey.fromBytes", "SecretKey requires exactly 32 bytes"),
    );
  });
});

describe("endpoints over a relay-disabled loopback (real addon, no network)", () => {
  const ALPN = "itsybitsy/test/1";
  const endpoints: IrohEndpoint[] = [];

  afterEach(async () => {
    for (const ep of endpoints.splice(0)) await ep.close();
  });

  async function bindLocal(iroh: Iroh, alpns: string[]): Promise<IrohEndpoint> {
    const ep = await iroh.Endpoint.bind({
      secretKey: iroh.SecretKey.generate().toBytes(),
      alpns,
      preset: { kind: "local", bindAddr: "127.0.0.1:0" },
    });
    endpoints.push(ep);
    return ep;
  }

  test("binds with the given key, dials by id + direct addresses, and moves one message each way", async () => {
    const iroh = await loadIroh();
    const key = iroh.SecretKey.generate();
    const server = await iroh.Endpoint.bind({ secretKey: key.toBytes(), alpns: [ALPN], preset: { kind: "local", bindAddr: "127.0.0.1:0" } });
    endpoints.push(server);
    expect(server.id().toString()).toBe(key.public().toString());
    expect(server.directAddresses()[0]).toMatch(/^127\.0\.0\.1:\d+$/);
    const client = await bindLocal(iroh, []);

    const served = (async () => {
      const incoming = await server.acceptNext();
      if (!incoming) throw new Error("acceptNext returned null");
      const conn = await incoming.accept();
      const stream = await conn.acceptBi();
      const request = new TextDecoder().decode(await stream.readToEnd(100));
      await stream.writeAll(new TextEncoder().encode(`echo ${request}`));
      await stream.finish();
      return { remoteId: conn.remoteId().toString(), alpn: conn.alpn(), closed: await conn.closed() };
    })();

    const conn = await client.connect(server.id().toString(), ALPN, server.directAddresses());
    expect(conn.remoteId().toString()).toBe(server.id().toString());
    expect(conn.closeInfo()).toBeNull();
    const stream = await conn.openBi();
    await stream.writeAll(new TextEncoder().encode("hello"));
    await stream.finish();
    const reply = await stream.readToEnd(100);
    expect(reply).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(reply)).toBe("echo hello");
    conn.close(7, "bye (for now)");
    expect(conn.closeInfo()).toEqual({ byPeer: false, reason: "closed" });

    expect(await served).toEqual({
      remoteId: client.id().toString(),
      alpn: ALPN,
      closed: { byPeer: true, code: 7, reason: "bye (for now)" },
    });
  });

  test("a pending call on the other side fails, and closeInfo already says who closed and why", async () => {
    const iroh = await loadIroh();
    const server = await bindLocal(iroh, [ALPN]);
    const client = await bindLocal(iroh, []);
    const accepted = server.acceptNext().then((incoming) => incoming!.accept());
    const conn = await client.connect(server.id().toString(), ALPN, server.directAddresses());
    const serverConn = await accepted;
    const pending = serverConn.acceptBi();
    conn.close(2, "expired");
    await expect(pending).rejects.toBeInstanceOf(IrohError);
    expect(serverConn.closeInfo()).toEqual({ byPeer: true, code: 2, reason: "expired" });
  });

  test("readToEnd over the limit fails with the TooLong error", async () => {
    const iroh = await loadIroh();
    const server = await bindLocal(iroh, [ALPN]);
    const client = await bindLocal(iroh, []);
    const read = (async () => {
      const conn = await (await server.acceptNext())!.accept();
      const stream = await conn.acceptBi();
      try {
        await stream.readToEnd(10);
        return null;
      } catch (err) {
        return err;
      }
    })();
    const conn = await client.connect(server.id().toString(), ALPN, server.directAddresses());
    const stream = await conn.openBi();
    await stream.writeAll(new Uint8Array(50));
    await stream.finish();
    const err = await read;
    expect(isIrohTooLong(err)).toBe(true);
    expect(isIrohTooLong(new IrohError("RecvStream.readToEnd", "other"))).toBe(false);
    conn.close(0, "done");
  });

  test("a dial on an ALPN the other side does not offer is a short IrohError", async () => {
    const iroh = await loadIroh();
    const server = await bindLocal(iroh, [ALPN]);
    const client = await bindLocal(iroh, []);
    // The server's side of the failed handshake rejects its accept().
    const serverSide = server.acceptNext().then((incoming) => incoming!.accept()).then(
      () => "accepted",
      (err: unknown) => (err instanceof IrohError ? err.op : "other"),
    );
    let caught: unknown;
    try {
      await client.connect(server.id().toString(), "itsybitsy/other/1", server.directAddresses());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IrohError);
    expect((caught as IrohError).op).toBe("Endpoint.connect");
    expect((caught as IrohError).message).not.toContain("\n");
    expect(await serverSide).toBe("Incoming.accept");
  });

  test("both ends report their selected direct path; a stream's priority is set before its first write; a path watch stops", async () => {
    const iroh = await loadIroh();
    const server = await bindLocal(iroh, [ALPN]);
    const client = await bindLocal(iroh, []);
    const served = (async () => {
      const conn = await (await server.acceptNext())!.accept();
      const paths = conn.paths();
      const stream = await conn.acceptBi();
      await stream.writeAll(await stream.readToEnd(100));
      await stream.finish();
      await conn.closed();
      return paths;
    })();
    const conn = await client.connect(server.id().toString(), ALPN, server.directAddresses());
    const direct = { selected: true, relay: false, remoteAddr: expect.stringMatching(/:\d+$/), rttMs: expect.any(Number) };
    expect(conn.paths().filter((path) => path.selected)).toEqual([direct]);
    const stop = conn.watchPathSelection(() => {});
    const stream = await conn.openBi();
    expect(await stream.priority()).toBe(0);
    await stream.setPriority(-1);
    expect(await stream.priority()).toBe(-1);
    await stream.writeAll(new TextEncoder().encode("low"));
    await stream.finish();
    expect(new TextDecoder().decode(await stream.readToEnd(100))).toBe("low");
    stop();
    conn.close(0, "done");
    expect((await served).filter((path) => path.selected)).toEqual([direct]);
  });

  test("close() resolves a pending acceptNext with null", async () => {
    const iroh = await loadIroh();
    const ep = await bindLocal(iroh, [ALPN]);
    const pending = ep.acceptNext();
    await ep.close();
    endpoints.splice(endpoints.indexOf(ep), 1);
    expect(await pending).toBeNull();
  });
});

describe("parseIrohCloseReason", () => {
  test("a close by the other side carries its code and its own reason text", () => {
    expect(parseIrohCloseReason("closed by peer: cancelled (code 1)")).toEqual({ byPeer: true, code: 1, reason: "cancelled" });
    expect(parseIrohCloseReason("closed by peer: protocol error: bad (json) code 7 (code 3)")).toEqual({
      byPeer: true,
      code: 3,
      reason: "protocol error: bad (json) code 7",
    });
    expect(parseIrohCloseReason("closed by peer:  (code 0)")).toEqual({ byPeer: true, code: 0, reason: "" });
  });

  test("anything else is not by the peer", () => {
    expect(parseIrohCloseReason("closed")).toEqual({ byPeer: false, reason: "closed" });
    expect(parseIrohCloseReason("timed out")).toEqual({ byPeer: false, reason: "timed out" });
  });
});

describe("shortIrohMessage", () => {
  test("keeps only the first non-empty line, whitespace collapsed", () => {
    const err = new Error("\n  No addressing information available\nCaused by:\n    All address lookup services failed");
    expect(shortIrohMessage(err)).toBe("No addressing information available");
    expect(shortIrohMessage(new Error("a   b\tc"))).toBe("a b c");
  });

  test("cuts a long message to 160 characters", () => {
    const short = shortIrohMessage(new Error("x".repeat(500)));
    expect(short.length).toBe(160);
    expect(short.endsWith("…")).toBe(true);
  });

  test("handles non-Error throws and empty messages", () => {
    expect(shortIrohMessage("plain string")).toBe("plain string");
    expect(shortIrohMessage(new Error(""))).toBe("unknown error");
  });
});

describe("loader seam", () => {
  test("a failed load is rethrown as an IrohError with op load", async () => {
    irohAddonLoaderCtx.set(async () => {
      throw new Error("dlopen failed\nmore detail");
    });
    await expect(loadIroh()).rejects.toThrow(new IrohError("load", "dlopen failed"));
  });
});

test("only src/peers/iroh.ts references @number0/iroh, and only through a dynamic import", async () => {
  const srcDir = resolve(import.meta.dir, "..");
  const self = relative(srcDir, import.meta.path);
  const pkg = ["@number0", "iroh"].join("/");
  // Any import form: `from "pkg"`, `import "pkg"`, `import("pkg")`, `require("pkg")`,
  // including subpaths such as the platform package.
  const anyImport = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["']${pkg}`);
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: srcDir })) {
    if (file === self || file === "peers/iroh.ts") continue;
    if (anyImport.test(await Bun.file(resolve(srcDir, file)).text())) offenders.push(file);
  }
  expect(offenders).toEqual([]);

  const wrapper = await Bun.file(resolve(srcDir, "peers/iroh.ts")).text();
  const mentions = wrapper.split("\n").filter((line) => line.includes(pkg));
  // Code mentions: the type-only `typeof import(...)` and the loader's `import(...)`.
  const code = mentions.filter((line) => !/^\s*(\*|\/\/)/.test(line));
  expect(code.length).toBe(2);
  for (const line of code) {
    expect(line).toContain(`import("${pkg}")`);
    expect(line).not.toMatch(/\bfrom\s+["']/);
    expect(line).not.toContain("require(");
  }
});

test("a path watch takes the addon's node-style (err, event) callback and reports only path selections", async () => {
  const { IrohConnection } = await import("./iroh");
  let emit: ((err: unknown, event: unknown) => void) | undefined;
  let stops = 0;
  const conn = new IrohConnection({
    watchPathEvents: (callback: (err: unknown, event: unknown) => void) => {
      emit = callback;
      return { stop: async () => { stops++; } };
    },
  } as never);
  let selections = 0;
  const stop = conn.watchPathSelection(() => selections++);
  emit!(null, { kind: "Opened", id: "1", remoteAddr: "10.0.0.2:4433" });
  emit!(null, { kind: "Selected", id: "1", remoteAddr: "10.0.0.2:4433" });
  emit!(null, { kind: "Closed", id: "0", remoteAddr: "https://relay.example./" });
  emit!(null, { kind: "Lagged", missed: 3 });
  expect(selections).toBe(1);
  stop();
  expect(stops).toBe(1);
});

test("native cancellation waits for both halves even when stop and reset reject", async () => {
  const { IrohBiStream } = await import("./iroh");
  const reset = Promise.withResolvers<void>();
  const stream = new IrohBiStream({ recv: { stop: async () => { throw Error("closed stream"); } },
    send: { reset: () => reset.promise } } as never);
  let finished = false;
  const cancelled = stream.cancel().finally(() => { finished = true; });
  await Bun.sleep(0);
  expect(finished).toBe(false);
  reset.reject(Error("stream reset failed"));
  await cancelled;
  expect(finished).toBe(true);
});

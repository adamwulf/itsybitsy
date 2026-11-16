// Phase 0 spike roles. Loaded by entry.ts with a dynamic import, so the
// --version path never touches the addon.
import {
  Endpoint,
  EndpointAddr,
  EndpointId,
  RelayMode,
  SecretKey,
  presetMinimal,
  presetN0DisableRelay,
} from "./iroh.ts";
import type { Connection } from "./iroh.ts";

const ALPN = bytes("itsybitsy/spike/1");
const READ_LIMIT = 64 * 1024;

function bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function text(b: number[]): string {
  return new TextDecoder().decode(Uint8Array.from(b));
}

function toHex(b: number[]): string {
  return Buffer.from(b).toString("hex");
}

function fromHex(s: string): number[] {
  return Array.from(Buffer.from(s.trim(), "hex"));
}

function log(role: string, msg: string): void {
  console.log(`[${role} ${new Date().toISOString()}] ${msg}`);
}

function describePaths(conn: Connection): string {
  return conn
    .paths()
    .map((p) => `${p.isRelay ? "relay" : "ip"} ${p.remoteAddr}${p.isSelected ? " (selected)" : ""}`)
    .join(", ");
}

// Load the key file, or generate one, save it, and reload it to confirm the
// id survives the round trip.
async function loadOrCreateKey(path: string): Promise<SecretKey> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    const generated = SecretKey.generate();
    const raw = generated.toBytes();
    log("key", `generated; toBytes() is ${Array.isArray(raw) ? "Array" : typeof raw} of length ${raw.length}`);
    await Bun.write(path, toHex(raw) + "\n");
    const reloaded = SecretKey.fromBytes(fromHex(await Bun.file(path).text()));
    const same = reloaded.public().equals(generated.public());
    log("key", `saved to ${path}; generated id ${generated.public().toString()}`);
    log("key", `reloaded id  ${reloaded.public().toString()} (same as generated: ${same})`);
    if (!same) throw new Error("reloaded key has a different id");
    return reloaded;
  }
  const loaded = SecretKey.fromBytes(fromHex(await file.text()));
  log("key", `loaded existing key from ${path}; id ${loaded.public().toString()}`);
  return loaded;
}

type Net = "n0" | "n0-norelay" | "minimal";

function parseNet(args: string[]): Net {
  const i = args.indexOf("--net");
  if (i < 0) return "n0";
  const v = args[i + 1];
  if (v === "n0" || v === "n0-norelay" || v === "minimal") return v;
  throw new Error(`unknown --net ${v}`);
}

// n0: Endpoint.bind() (n0 preset: relays + discovery).
// n0-norelay: builder + presetN0DisableRelay (discovery on, relays off).
// minimal: builder + presetMinimal + RelayMode.disabled() (no external deps).
async function bindEndpoint(net: Net, secretKey: number[] | undefined, alpns: number[][]): Promise<Endpoint> {
  if (net === "n0") {
    return Endpoint.bind(secretKey ? { secretKey, alpns } : { alpns });
  }
  const b = Endpoint.builder();
  if (net === "n0-norelay") {
    presetN0DisableRelay(b);
  } else {
    presetMinimal(b);
    b.relayMode(RelayMode.disabled());
  }
  if (secretKey) b.secretKey(secretKey);
  b.alpns(alpns);
  return b.bind();
}

function portOf(ep: Endpoint): number {
  const addrs = ep.addr().directAddresses();
  const first = addrs.find((a) => a.startsWith("127.0.0.1:")) ?? addrs.find((a) => !a.startsWith("["));
  if (!first) throw new Error(`no IPv4 direct address in ${JSON.stringify(addrs)}`);
  return Number(first.slice(first.lastIndexOf(":") + 1));
}

async function serveOne(role: string, ep: Endpoint): Promise<void> {
  const incoming = await ep.acceptNext();
  if (!incoming) throw new Error("acceptNext returned null");
  const conn = await (await incoming.accept()).connect();
  log(role, `conn.remoteId() = ${conn.remoteId().toString()}`);
  log(role, `paths: ${describePaths(conn)}`);
  const bi = await conn.acceptBi();
  const msg = await bi.recv.readToEnd(READ_LIMIT);
  log(role, `received ${msg.length} bytes: ${JSON.stringify(text(msg))}`);
  await bi.send.writeAll(msg);
  await bi.send.finish();
  const reason = await conn.closed();
  log(role, `connection closed: ${reason}`);
}

async function dialOnce(role: string, ep: Endpoint, addr: EndpointAddr, message: string): Promise<void> {
  const t0 = performance.now();
  const conn = await ep.connect(addr, ALPN);
  log(role, `connected in ${(performance.now() - t0).toFixed(0)} ms; remoteId ${conn.remoteId().toString()}`);
  log(role, `paths: ${describePaths(conn)}`);
  const bi = await conn.openBi();
  await bi.send.writeAll(bytes(message));
  await bi.send.finish();
  const echo = await bi.recv.readToEnd(READ_LIMIT);
  log(role, `echo: ${JSON.stringify(text(echo))} (matches: ${text(echo) === message})`);
  conn.close(0n, bytes("bye"));
}

export async function listen(args: string[]): Promise<void> {
  const keyPath = args[0];
  if (!keyPath) throw new Error("usage: listen <keyfile> [--net n0|n0-norelay|minimal]");
  const net = parseNet(args);
  const sk = await loadOrCreateKey(keyPath);
  const ep = await bindEndpoint(net, sk.toBytes(), [ALPN]);
  log("listener", `net=${net}; ep.id() = ${ep.id().toString()} (equals key's public: ${ep.id().equals(sk.public())})`);
  if (net === "n0") {
    await ep.online();
    log("listener", `online; home relay ${ep.addr().relayUrl()}`);
  } else {
    log("listener", `direct addresses ${JSON.stringify(ep.addr().directAddresses())}; port ${portOf(ep)}`);
  }
  log("listener", `LISTENER_ID ${ep.id().toString()}`);
  await serveOne("listener", ep);
  await ep.close();
  log("listener", `ep.close() resolved; isClosed ${ep.isClosed()}`);
}

export async function dial(args: string[]): Promise<void> {
  const idString = args[0];
  if (!idString) throw new Error("usage: dial <id> [--net ...] [--port N]");
  const net = parseNet(args);
  const pi = args.indexOf("--port");
  const id = EndpointId.fromString(idString);
  const addr = pi >= 0 ? new EndpointAddr(id, null, [`127.0.0.1:${args[pi + 1]}`]) : new EndpointAddr(id);
  const ep = await bindEndpoint(net, undefined, []);
  log("dialer", `net=${net}; DIALER_ID ${ep.id().toString()}`);
  log("dialer", `dialing ${addr.toString()}`);
  await dialOnce("dialer", ep, addr, `hello from ${ep.id().fmtShort()}`);
  await ep.close();
  log("dialer", `ep.close() resolved; isClosed ${ep.isClosed()}`);
}

// E probe: bind an endpoint and return, with or without ep.close().
export async function bindOnly(args: string[]): Promise<void> {
  const net = parseNet(args);
  const ep = await bindEndpoint(net, undefined, [ALPN]);
  if (net === "n0") await ep.online();
  log("bind-only", `net=${net}; bound ${ep.id().fmtShort()}`);
  if (args.includes("--accept")) {
    // Leave an acceptNext() pending, the way an accept loop would.
    ep.acceptNext().then(
      (inc) => log("bind-only", `pending acceptNext() resolved: ${inc === null ? "null" : "an Incoming"}`),
      (err) => log("bind-only", `pending acceptNext() rejected: ${String(err)}`),
    );
    log("bind-only", "acceptNext() left pending");
  }
  if (args.includes("--close")) {
    await ep.close();
    log("bind-only", "ep.close() resolved");
  } else {
    log("bind-only", "returning WITHOUT ep.close()");
  }
}

// D in one process: both endpoints relay-disabled, dialing 127.0.0.1:PORT.
export async function loopback(args: string[]): Promise<void> {
  const net = parseNet(args);
  if (net === "n0") throw new Error("loopback needs --net n0-norelay or --net minimal");
  const server = await bindEndpoint(net, SecretKey.generate().toBytes(), [ALPN]);
  const port = portOf(server);
  log("loopback", `net=${net}; server id ${server.id().toString()}; addrs ${JSON.stringify(server.addr().directAddresses())}`);
  const client = await bindEndpoint(net, undefined, []);
  log("loopback", `client id ${client.id().toString()}`);
  const serving = serveOne("loopback-server", server);
  await dialOnce("loopback-client", client, new EndpointAddr(server.id(), null, [`127.0.0.1:${port}`]), "loopback hello");
  await serving;
  await client.close();
  await server.close();
  log("loopback", "both endpoints closed");
}

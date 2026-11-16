// API surprises probe: byte types, id formats, read limits, error shapes.
// Usage: bun spikes/iroh/probe-api.ts [--n0-unknown]
// Everything runs over relay-disabled loopback except --n0-unknown, which
// dials a random id through the n0 preset to see how a dial to nobody fails.
import { Endpoint, EndpointAddr, EndpointId, RelayMode, SecretKey, presetMinimal } from "./iroh.ts";

const ALPN = Array.from(new TextEncoder().encode("itsybitsy/spike/1"));

function show(label: string, v: unknown): void {
  console.log(`${label}: ${v}`);
}

function errShape(e: unknown): string {
  if (!(e instanceof Error)) return `non-Error ${typeof e}: ${String(e)}`;
  const extra = Object.keys(e).length ? ` own keys ${JSON.stringify(Object.keys(e))}` : "";
  const code = (e as { code?: unknown }).code;
  return `${e.constructor.name} message=${JSON.stringify(e.message)} code=${JSON.stringify(code)}${extra}`;
}

async function attempt(label: string, fn: () => unknown): Promise<void> {
  try {
    const v = await fn();
    show(label, `ok -> ${typeof v === "object" && v !== null ? v.constructor.name : JSON.stringify(v)}`);
  } catch (e) {
    show(label, `throws ${errShape(e)}`);
  }
}

async function bindLocal(alpns: number[][]): Promise<Endpoint> {
  const b = Endpoint.builder();
  presetMinimal(b);
  b.relayMode(RelayMode.disabled());
  b.bindAddr("127.0.0.1:0");
  b.alpns(alpns);
  return b.bind();
}

function loopAddr(ep: Endpoint): EndpointAddr {
  return new EndpointAddr(ep.id(), null, ep.addr().directAddresses());
}

const sk = SecretKey.generate();
const id = sk.public();
show("SecretKey.toBytes() type", `${sk.toBytes().constructor.name} length ${sk.toBytes().length}`);
show("EndpointId.toString()", `${JSON.stringify(id.toString())} (length ${id.toString().length})`);
show("EndpointId.fmtShort()", JSON.stringify(id.fmtShort()));
await attempt("SecretKey.fromBytes(Uint8Array)", () => SecretKey.fromBytes(Uint8Array.from(sk.toBytes()) as unknown as number[]));
await attempt("SecretKey.fromBytes(Buffer)", () => SecretKey.fromBytes(Buffer.from(sk.toBytes()) as unknown as number[]));
await attempt("SecretKey.fromBytes(31 bytes)", () => SecretKey.fromBytes(sk.toBytes().slice(0, 31)));
await attempt("SecretKey.fromBytes([256, ...])", () => SecretKey.fromBytes([256, ...sk.toBytes().slice(1)]));
await attempt("EndpointId.fromString(uppercase hex)", () => EndpointId.fromString(id.toString().toUpperCase()));
await attempt("EndpointId.fromString(fmtShort)", () => EndpointId.fromString(id.fmtShort()));
await attempt("EndpointId.fromString('not-an-id')", () => EndpointId.fromString("not-an-id"));
await attempt("EndpointId.fromString(' ' + id)", () => EndpointId.fromString(" " + id.toString()));

if (process.argv.includes("--n0-unknown")) {
  const ep = await Endpoint.bind({ alpns: [] });
  const t0 = performance.now();
  await attempt("n0 connect to random unknown id", () => ep.connect(new EndpointAddr(SecretKey.generate().public()), ALPN));
  show("  took ms", (performance.now() - t0).toFixed(0));
  await ep.close();
  process.exit(0);
}

// Loopback server with an echo-ish handler that sends a 100 KB payload.
const server = await bindLocal([ALPN]);
const client = await bindLocal([]);
show("server bound sockets (bindAddr 127.0.0.1:0)", JSON.stringify(server.boundSockets()));
show("server addr().directAddresses()", JSON.stringify(server.addr().directAddresses()));

const big = Array.from({ length: 100_000 }, (_, i) => i % 251);
const serving = (async () => {
  for (;;) {
    const inc = await server.acceptNext();
    if (!inc) return;
    // A failed handshake (e.g. ALPN mismatch) rejects accept()/connect();
    // an accept loop has to catch per connection or it dies on the first one.
    try {
      const conn = await (await inc.accept()).connect();
      const bi = await conn.acceptBi();
      await bi.recv.readToEnd(16);
      await bi.send.writeAll(big);
      await bi.send.finish();
      await conn.closed().catch(() => {});
    } catch (e) {
      show("  [server] per-connection error", errShape(e));
    }
  }
})();

{
  const conn = await client.connect(loopAddr(server), ALPN);
  const bi = await conn.openBi();
  await attempt("writeAll(Uint8Array)", () => bi.send.writeAll(new TextEncoder().encode("x") as unknown as number[]));
  await bi.send.finish();
  const chunk = await bi.recv.read(65_536);
  show("recv.read(65536) on a 100000-byte stream returns", `${chunk.constructor.name} of ${chunk.length} bytes`);
  await attempt("recv.readToEnd(1000) on the remaining bytes", () => bi.recv.readToEnd(1000));
  conn.close(0n, []);
}
{
  const conn = await client.connect(loopAddr(server), ALPN);
  const bi = await conn.openBi();
  await bi.send.writeAll([1]);
  await bi.send.finish();
  const all = await bi.recv.readToEnd(1_000_000);
  show("recv.readToEnd(1000000)", `${all.length} bytes`);
  const after = await bi.recv.read(10).then((v) => `${v.constructor.name} of ${v.length}`, (e) => `throws ${errShape(e)}`);
  show("recv.read(10) after end of stream", after);
  conn.close(0n, []);
}

await attempt("connect with an ALPN the server does not offer", () =>
  client.connect(loopAddr(server), Array.from(new TextEncoder().encode("itsybitsy/other/1"))),
);
{
  const t0 = performance.now();
  await attempt("connect to a random id at the server's address", () =>
    client.connect(new EndpointAddr(SecretKey.generate().public(), null, server.addr().directAddresses()), ALPN),
  );
  show("  took ms", (performance.now() - t0).toFixed(0));
}
{
  const t0 = performance.now();
  await attempt("connect to a closed port 127.0.0.1:9 (relays off, no discovery)", () =>
    client.connect(new EndpointAddr(SecretKey.generate().public(), null, ["127.0.0.1:9"]), ALPN),
  );
  show("  took ms", (performance.now() - t0).toFixed(0));
}
{
  const t0 = performance.now();
  const conn = await client.connect(loopAddr(server), ALPN);
  show("connect after the failures above took ms", (performance.now() - t0).toFixed(0));
  conn.close(42n, Array.from(new TextEncoder().encode("bye-reason")));
  show("closeReason() after local close", JSON.stringify(conn.closeReason()));
  await attempt("openBi() on a closed connection", () => conn.openBi());
}

await client.close();
await server.close();
await serving;
await attempt("Endpoint.connect after close", () => client.connect(loopAddr(server), ALPN));
console.log("probe done");

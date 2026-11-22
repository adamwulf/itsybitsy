/**
 * One pairing end to end through the REAL wrapper and addon: two PeerServices,
 * each bound with presetMinimal + RelayMode.disabled() + bindAddr 127.0.0.1:0
 * (no relays, no discovery, no outside service), the dialer reaching the other
 * through its direct addresses. Each side has its own temporary home through
 * the userHome() seam.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUserHome, setUserHome } from "../home";
import { waitFor } from "../test-utils";
import { loadOrCreateIdentity } from "./identity";
import { loadIroh, type IrohEndpoint } from "./iroh";
import { generatePairCode } from "./pair-code";
import { PeerService, type ServiceEndpoint } from "./service";
import { addPeer, readPeers, shortPeerId } from "./store";

const homes: string[] = [];
afterEach(async () => {
  resetUserHome();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/**
 * userHome() is one global, and both services run in this process, so every
 * call that reads it runs under a lock with its side's home set.
 */
let homeChain: Promise<unknown> = Promise.resolve();
function inHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const run = homeChain.then(async () => {
    setUserHome(home);
    try {
      return await fn();
    } finally {
      resetUserHome();
    }
  });
  homeChain = run.catch(() => {});
  return run;
}

test("two real loopback endpoints pair, and each peers.json ends up with the other's id and name", async () => {
  const iroh = await loadIroh();
  /** Direct addresses by endpoint id, so a dial by id can reach the other loopback endpoint. */
  const addresses = new Map<string, string[]>();
  const logs: string[] = [];

  async function makeSide(label: string): Promise<{ service: PeerService; home: string }> {
    const home = await mkdtemp(join(tmpdir(), `ib-pair-real-${label}-`));
    homes.push(home);
    const service = new PeerService({
      resolveCaller: async () => null,
      acquireLock: async () => ({ acquired: true }),
      releaseLock: async () => true,
      loadIdentity: () => inHome(home, loadOrCreateIdentity),
      bindEndpoint: async (secretKey, alpns): Promise<ServiceEndpoint> => {
        const ep: IrohEndpoint = await iroh.Endpoint.bind({ secretKey, alpns, preset: { kind: "local", bindAddr: "127.0.0.1:0" } });
        addresses.set(ep.id().toString(), ep.directAddresses());
        return {
          acceptNext: () => ep.acceptNext(),
          connect: (id, alpn) => ep.connect(id, alpn, addresses.get(id)),
          close: () => ep.close(),
        };
      },
      readPeers: () => inHome(home, readPeers),
      addPeer: (peer) => inHome(home, () => addPeer(peer)),
      generateCode: () => generatePairCode(),
      now: () => Date.now(),
      setTimer: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      log: (line) => logs.push(`${label}: ${line}`),
      snapshot: () => ({ repos: [], agents: [] }),
    });
    return { service, home };
  }

  const a = await makeSide("a");
  const b = await makeSide("b");
  try {
    a.service.openDialog();
    b.service.openDialog();
    await waitFor(() => a.service.view().status.kind === "listening" && b.service.view().status.kind === "listening", {
      message: "both endpoints listening",
      timeoutMs: 10_000,
    });
    const idA = a.service.view().selfId!;
    const idB = b.service.view().selfId!;
    expect(idA).not.toBe(idB);

    expect(a.service.pairWith(idB)).toBeNull();
    await waitFor(() => a.service.view().session?.stage.stage === "code-entry", { message: "A at the code prompt", timeoutMs: 10_000 });
    const shown = b.service.view().session;
    expect(shown?.role).toBe("responder");
    expect(shown?.peerId).toBe(idA);
    if (shown?.stage.stage !== "code-shown") throw new Error(`B is not showing a code: ${JSON.stringify(shown?.stage)}`);

    a.service.submitCode(shown.stage.code.toLowerCase());
    await waitFor(() => a.service.view().session?.stage.stage === "naming" && b.service.view().session?.stage.stage === "naming", {
      message: "both at the name prompt",
      timeoutMs: 10_000,
    });
    a.service.submitName("Laptop B");
    b.service.submitName(null);
    await waitFor(() => a.service.view().session?.stage.stage === "done" && b.service.view().session?.stage.stage === "done", {
      message: "both done",
      timeoutMs: 10_000,
    });

    const peersA = await inHome(a.home, readPeers);
    const peersB = await inHome(b.home, readPeers);
    expect(peersA.map((p) => [p.id, p.name])).toEqual([[idB, "Laptop B"]]);
    expect(peersB.map((p) => [p.id, p.name])).toEqual([[idA, shortPeerId(idA)]]);
  } finally {
    await a.service.shutdown();
    await b.service.shutdown();
  }
  expect(logs.filter((line) => line.includes("failed"))).toEqual([]);
});

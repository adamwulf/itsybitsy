import { describe, expect, test } from "bun:test";
import { waitFor } from "../test-utils";
import { PAIR_CODE_TTL_MS } from "./pair-code";
import {
  FINAL_REPLY_LINGER_MS,
  HELLO_TIMEOUT_MS,
  PAIR_CLOSE,
  PAIR_MAX_MESSAGE_BYTES,
  PairInitiator,
  PairProtocolError,
  PairResponder,
  decodePairMessage,
  describePairFailure,
  encodePairMessage,
  failureFromClose,
  parsePairTarget,
  respondToPairing,
  type PairConnection,
  type PairMessage,
  type PairRefusal,
  type PairStream,
} from "./pairing";
import { sanitizePeerName, shortPeerId, type Peer } from "./store";
import { createFakeClock, createMemoryLink, type MemoryConnection } from "./test-pair-transport";

const ID_A = "a1".repeat(32);
const ID_B = "b2".repeat(32);
const SHORT_A = shortPeerId(ID_A);
const SHORT_B = shortPeerId(ID_B);
const CODE = "ABCD1234";

/** An in-memory peers.json for one side. */
function memoryStore(initial: Peer[] = []) {
  let peers = initial.map((p) => ({ ...p }));
  let writes = 0;
  return {
    get peers(): Peer[] {
      return peers;
    },
    get writes(): number {
      return writes;
    },
    readPeers: async (): Promise<Peer[]> => peers.map((p) => ({ ...p })),
    addPeer: async (p: { id: string; name: string; pairedAt?: string }): Promise<Peer> => {
      writes++;
      const stored = { id: p.id, name: sanitizePeerName(p.name, p.id), pairedAt: p.pairedAt ?? `paired-${writes}` };
      peers = [...peers.filter((x) => x.id !== p.id), stored];
      return { ...stored };
    },
  };
}

interface SetupOptions {
  /** B's admission answer; default admits. */
  refusal?: PairRefusal;
  aPeers?: Peer[];
  bPeers?: Peer[];
  /** Hook called when B saves a peer, before the save resolves. */
  onBSave?: () => void;
}

/** A and B over an in-memory link: B serving it with respondToPairing, A not started yet. */
function setup(options: SetupOptions = {}) {
  const clock = createFakeClock();
  const link = createMemoryLink(ID_A, ID_B);
  const storeA = memoryStore(options.aPeers);
  const storeB = memoryStore(options.bPeers);
  const logs: string[] = [];
  let responder: PairResponder | null = null;
  let admitCalls = 0;
  const responderDone = respondToPairing(link.b, {
    readPeers: storeB.readPeers,
    addPeer: async (p) => {
      options.onBSave?.();
      return storeB.addPeer(p);
    },
    log: (line) => logs.push(`B: ${line}`),
    onChange: () => {},
    setTimer: clock.setTimer,
    now: clock.now,
    generateCode: () => CODE,
    admit: (session) => {
      admitCalls++;
      if (options.refusal) return options.refusal;
      responder = session;
      return null;
    },
  });
  const initiator = new PairInitiator(ID_B, {
    readPeers: storeA.readPeers,
    addPeer: storeA.addPeer,
    log: (line) => logs.push(`A: ${line}`),
    onChange: () => {},
    setTimer: clock.setTimer,
    dial: async (id) => {
      expect(id).toBe(ID_B);
      return link.a;
    },
  });
  return {
    clock,
    link,
    storeA,
    storeB,
    logs,
    initiator,
    responderDone,
    responder: (): PairResponder => {
      if (!responder) throw new Error("B admitted no session");
      return responder;
    },
    admitCalls: () => admitCalls,
  };
}

/** Raw A side: write one message on a new bi stream and read the reply bytes (or the failure). */
async function rawRequest(conn: PairConnection, bytes: Uint8Array): Promise<Uint8Array | Error> {
  try {
    const stream = await conn.openBi();
    await stream.writeAll(bytes);
    await stream.finish();
    return await stream.readToEnd(PAIR_MAX_MESSAGE_BYTES);
  } catch (err) {
    return err as Error;
  }
}

const text = (s: string) => new TextEncoder().encode(s);

describe("pair protocol: happy path", () => {
  test("hello → code shown → right code → both save each other, then both name the other", async () => {
    const stagesAtBSave: string[] = [];
    const t = setup({
      onBSave: () => {
        stagesAtBSave.push(t.initiator.stage.stage);
      },
    });
    await t.initiator.start();
    expect(t.initiator.stage).toEqual({ stage: "code-entry" });
    expect(t.responder().stage).toEqual({ stage: "code-shown", code: CODE, expiresAt: t.clock.now() + PAIR_CODE_TTL_MS });
    expect(t.responder().peerId).toBe(ID_A);

    // Typed loosely: lowercase, dash, an O for the 0 is not in this code.
    await t.initiator.submitCode("abcd-1234");
    expect(t.initiator.stage).toEqual({ stage: "naming", savedName: SHORT_B });
    // B saved A BEFORE replying pair-ok: A was still waiting for the verdict.
    expect(stagesAtBSave).toEqual(["verifying"]);
    await t.responderDone;
    expect(t.responder().stage).toEqual({ stage: "naming", savedName: SHORT_A });
    expect(t.storeA.peers.map((p) => [p.id, p.name])).toEqual([[ID_B, SHORT_B]]);
    expect(t.storeB.peers.map((p) => [p.id, p.name])).toEqual([[ID_A, SHORT_A]]);
    // A closed after reading pair-ok; B saw that close and did not close again.
    expect(t.link.a.closes).toEqual([{ code: PAIR_CLOSE.done, reason: "done" }]);
    expect(t.link.b.closes).toEqual([]);
    expect(t.clock.pending()).toBe(0);

    const pairedAtA = t.storeA.peers[0]!.pairedAt;
    await t.initiator.submitName("  Laptop B  ");
    await t.responder().submitName("Laptop A");
    expect(t.initiator.stage).toEqual({ stage: "done", name: "Laptop B", alreadyPaired: false });
    expect(t.responder().stage).toEqual({ stage: "done", name: "Laptop A", alreadyPaired: false });
    expect(t.storeA.peers).toEqual([{ id: ID_B, name: "Laptop B", pairedAt: pairedAtA }]);
    expect(t.storeB.peers.map((p) => [p.id, p.name])).toEqual([[ID_A, "Laptop A"]]);
    expect(t.initiator.isPending()).toBe(false);
    expect(t.responder().isPending()).toBe(false);
  });

  test("Esc (or a blank name) at the name prompt keeps the short id", async () => {
    const t = setup();
    await t.initiator.start();
    await t.initiator.submitCode(CODE);
    await t.responderDone;
    await t.initiator.submitName(null);
    await t.responder().submitName("   ");
    expect(t.initiator.stage).toEqual({ stage: "done", name: SHORT_B, alreadyPaired: false });
    expect(t.responder().stage).toEqual({ stage: "done", name: SHORT_A, alreadyPaired: false });
    expect(t.storeA.writes).toBe(1);
    expect(t.storeB.writes).toBe(1);
  });

  test("the session is pending (busy) through naming, and Esc does not cancel once paired", async () => {
    const t = setup();
    await t.initiator.start();
    expect(t.initiator.isPending()).toBe(true);
    await t.initiator.submitCode(CODE);
    expect(t.initiator.isPending()).toBe(true);
    t.initiator.cancel();
    expect(t.initiator.stage.stage).toBe("naming");
  });
});

describe("pair protocol: already paired", () => {
  test("B already trusts A: pair-ok with no code; A saves B and asks for a name, B keeps its name for A", async () => {
    const t = setup({ bPeers: [{ id: ID_A, name: "Old A", pairedAt: "earlier" }] });
    await t.initiator.start();
    expect(t.initiator.stage).toEqual({ stage: "naming", savedName: SHORT_B });
    await t.responderDone;
    expect(t.responder().stage).toEqual({ stage: "done", name: "Old A", alreadyPaired: true });
    expect(t.storeB.writes).toBe(0);
    expect(t.storeB.peers).toEqual([{ id: ID_A, name: "Old A", pairedAt: "earlier" }]);
    expect(t.storeA.peers.map((p) => p.id)).toEqual([ID_B]);
    expect(t.clock.pending()).toBe(0);
  });

  test("A keeps a name it already gave B", async () => {
    const t = setup({
      aPeers: [{ id: ID_B, name: "Laptop B", pairedAt: "earlier" }],
      bPeers: [{ id: ID_A, name: "Old A", pairedAt: "earlier" }],
    });
    await t.initiator.start();
    expect(t.initiator.stage).toEqual({ stage: "naming", savedName: "Laptop B" });
    await t.initiator.submitName(null);
    expect(t.initiator.stage).toEqual({ stage: "done", name: "Laptop B", alreadyPaired: false });
  });
});

describe("pair protocol: wrong code", () => {
  test("one attempt: B replies wrong-code, discards the code and saves nothing", async () => {
    const t = setup();
    await t.initiator.start();
    await t.initiator.submitCode("ZZZZ-ZZZZ");
    expect(t.initiator.stage).toEqual({ stage: "failed", failure: { kind: "wrong-code" } });
    await t.responderDone;
    expect(t.responder().stage).toEqual({ stage: "failed", failure: { kind: "wrong-code" } });
    expect(t.storeA.peers).toEqual([]);
    expect(t.storeB.peers).toEqual([]);
    expect(t.link.a.closes).toEqual([{ code: PAIR_CLOSE.done, reason: "done" }]);
    // The expiry timer went with the code.
    expect(t.clock.pending()).toBe(0);
  });
});

describe("pair protocol: expiry (fake clock)", () => {
  test("at expiry B discards the code and closes; A, waiting at the code prompt, shows expired", async () => {
    const t = setup();
    await t.initiator.start();
    t.clock.advance(PAIR_CODE_TTL_MS - 1);
    expect(t.responder().stage.stage).toBe("code-shown");
    t.clock.advance(1);
    expect(t.responder().stage).toEqual({ stage: "failed", failure: { kind: "expired" } });
    expect(t.link.b.closes).toEqual([{ code: PAIR_CLOSE.expired, reason: "expired" }]);
    await waitFor(() => t.initiator.stage.stage === "failed", { message: "A sees the expiry" });
    expect(t.initiator.stage).toEqual({ stage: "failed", failure: { kind: "expired" } });
    await t.responderDone;
    expect(t.storeB.peers).toEqual([]);
  });

  test("a code that arrives after expiry, before the timer ran, gets pair-fail expired even when right", async () => {
    const t = setup();
    await t.initiator.start();
    t.clock.jump(PAIR_CODE_TTL_MS);
    await t.initiator.submitCode(CODE);
    expect(t.initiator.stage).toEqual({ stage: "failed", failure: { kind: "expired" } });
    await t.responderDone;
    expect(t.responder().stage).toEqual({ stage: "failed", failure: { kind: "expired" } });
    expect(t.storeA.peers).toEqual([]);
    expect(t.storeB.peers).toEqual([]);
    expect(t.clock.pending()).toBe(0);
  });
});

describe("pair protocol: cancel", () => {
  test("Esc on A at the code prompt closes with the cancel code; B shows pairing cancelled", async () => {
    const t = setup();
    await t.initiator.start();
    t.initiator.cancel();
    expect(t.initiator.stage).toEqual({ stage: "failed", failure: { kind: "cancelled" } });
    expect(t.link.a.closes).toEqual([{ code: PAIR_CLOSE.cancelled, reason: "cancelled" }]);
    await t.responderDone;
    expect(t.responder().stage).toEqual({ stage: "failed", failure: { kind: "cancelled" } });
    expect(t.clock.pending()).toBe(0);
  });

  test("Esc on B while its code is shown closes with the cancel code; A shows pairing cancelled", async () => {
    const t = setup();
    await t.initiator.start();
    t.responder().cancel();
    expect(t.responder().stage).toEqual({ stage: "failed", failure: { kind: "cancelled" } });
    expect(t.link.b.closes).toEqual([{ code: PAIR_CLOSE.cancelled, reason: "cancelled" }]);
    expect(t.clock.pending()).toBe(0);
    await waitFor(() => t.initiator.stage.stage === "failed", { message: "A sees the cancel" });
    expect(t.initiator.stage).toEqual({ stage: "failed", failure: { kind: "cancelled" } });
    await t.responderDone;
  });

  test("Esc on A while its code is being checked: B shows pairing cancelled", async () => {
    const t = setup();
    await t.initiator.start();
    const submitted = t.initiator.submitCode(CODE);
    t.initiator.cancel();
    await submitted;
    expect(t.initiator.stage).toEqual({ stage: "failed", failure: { kind: "cancelled" } });
    await t.responderDone;
    expect(t.responder().stage.stage).toBe("failed");
    expect(t.storeA.peers).toEqual([]);
  });

  test("Esc on A while dialing: the late connection is closed with the cancel code", async () => {
    const link = createMemoryLink(ID_A, ID_B);
    let resolveDial!: (conn: MemoryConnection) => void;
    const store = memoryStore();
    const initiator = new PairInitiator(ID_B, {
      ...store,
      log: () => {},
      onChange: () => {},
      setTimer: createFakeClock().setTimer,
      dial: () => new Promise((resolve) => (resolveDial = resolve)),
    });
    const started = initiator.start();
    initiator.cancel();
    expect(initiator.stage).toEqual({ stage: "failed", failure: { kind: "cancelled" } });
    resolveDial(link.a);
    await started;
    expect(link.a.closes).toEqual([{ code: PAIR_CLOSE.cancelled, reason: "cancelled" }]);
  });
});

describe("pair protocol: refusals", () => {
  test("busy: B replies pair-refused busy and starts no session", async () => {
    const t = setup({ refusal: "busy" });
    await t.initiator.start();
    expect(t.initiator.stage).toEqual({ stage: "failed", failure: { kind: "refused", reason: "busy" } });
    await t.responderDone;
    expect(t.admitCalls()).toBe(1);
    expect(() => t.responder()).toThrow();
    expect(t.link.a.closes).toEqual([{ code: PAIR_CLOSE.done, reason: "done" }]);
    expect(t.storeA.peers).toEqual([]);
    expect(t.logs).toContain(`B: pairing: refused ${SHORT_A} (busy)`);
  });

  test("dialog closed: B replies pair-refused not-accepting", async () => {
    const t = setup({ refusal: "not-accepting" });
    await t.initiator.start();
    expect(t.initiator.stage).toEqual({ stage: "failed", failure: { kind: "refused", reason: "not-accepting" } });
    await t.responderDone;
    expect(t.storeA.peers).toEqual([]);
    expect(t.storeB.peers).toEqual([]);
  });

  test("B closes a refused connection itself when A never does", async () => {
    const t = setup({ refusal: "busy" });
    const reply = await rawRequest(t.link.a, encodePairMessage({ op: "pair-hello" }));
    expect(decodePairMessage(reply as Uint8Array)).toEqual({ op: "pair-refused", reason: "busy" });
    t.clock.advance(FINAL_REPLY_LINGER_MS);
    await t.responderDone;
    expect(t.link.b.closes).toEqual([{ code: PAIR_CLOSE.done, reason: "done" }]);
  });
});

describe("pair protocol: malformed messages", () => {
  for (const [label, bytes, reason] of [
    ["not JSON", text("not json"), "message is not JSON"],
    ["oversized", new Uint8Array(PAIR_MAX_MESSAGE_BYTES + 1).fill(0x20), `message longer than ${PAIR_MAX_MESSAGE_BYTES} bytes`],
    ["an unknown op", text('{"op":"pair-nope"}'), 'unknown op "pair-nope"'],
    ["a JSON array", text("[1,2]"), "message is not a JSON object"],
    ["out of turn (pair-code first)", encodePairMessage({ op: "pair-code", code: CODE }), "expected pair-hello, got pair-code"],
  ] as const) {
    test(`B closes with a clear error on ${label} instead of pair-hello`, async () => {
      const t = setup();
      const reply = await rawRequest(t.link.a, bytes);
      expect(reply).toBeInstanceOf(Error);
      expect(t.link.a.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.error, reason });
      await t.responderDone;
      expect(t.admitCalls()).toBe(0);
    });
  }

  for (const [label, bytes, reason] of [
    ["not JSON", text("not json"), "message is not JSON"],
    ["oversized", new Uint8Array(PAIR_MAX_MESSAGE_BYTES + 1).fill(0x20), `message longer than ${PAIR_MAX_MESSAGE_BYTES} bytes`],
    ["an unknown op", text('{"op":"pair-nope"}'), 'unknown op "pair-nope"'],
  ] as const) {
    test(`a code-stage message that is ${label} closes with the error code, spends the code and saves nothing`, async () => {
      const t = setup();
      const first = await rawRequest(t.link.a, encodePairMessage({ op: "pair-hello" }));
      expect(decodePairMessage(first as Uint8Array)).toEqual({ op: "pair-code-shown" });
      expect(t.clock.pending()).toBe(1); // the code's expiry
      expect(await rawRequest(t.link.a, bytes)).toBeInstanceOf(Error);
      await t.responderDone;
      expect(t.link.a.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.error, reason });
      expect(t.responder().stage).toEqual({ stage: "failed", failure: { kind: "error", detail: reason } });
      expect(t.clock.pending()).toBe(0);
      expect(t.storeB.peers).toEqual([]);
    });
  }

  test("a pair-code on a stream opened before pair-code-shown is a blind guess: it spends the one attempt", async () => {
    const t = setup();
    const helloStream = await t.link.a.openBi();
    const codeStream = await t.link.a.openBi();
    await codeStream.writeAll(encodePairMessage({ op: "pair-code", code: "ZZZZ9999" }));
    await codeStream.finish();
    await helloStream.writeAll(encodePairMessage({ op: "pair-hello" }));
    await helloStream.finish();
    expect(decodePairMessage(await helloStream.readToEnd(PAIR_MAX_MESSAGE_BYTES))).toEqual({ op: "pair-code-shown" });
    expect(decodePairMessage(await codeStream.readToEnd(PAIR_MAX_MESSAGE_BYTES))).toEqual({ op: "pair-fail", reason: "wrong-code" });
    t.link.a.close(PAIR_CLOSE.done, "done");
    await t.responderDone;
    expect(t.responder().stage).toEqual({ stage: "failed", failure: { kind: "wrong-code" } });
    expect(t.clock.pending()).toBe(0);
    expect(t.storeB.peers).toEqual([]);
  });

  test("B closes with an error when the second message is not pair-code", async () => {
    const t = setup();
    const first = await rawRequest(t.link.a, encodePairMessage({ op: "pair-hello" }));
    expect(decodePairMessage(first as Uint8Array)).toEqual({ op: "pair-code-shown" });
    await rawRequest(t.link.a, encodePairMessage({ op: "pair-hello" }));
    await t.responderDone;
    expect(t.link.a.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.error, reason: "expected pair-code, got pair-hello" });
    expect(t.responder().stage).toEqual({ stage: "failed", failure: { kind: "error", detail: "expected pair-code, got pair-hello" } });
    expect(t.clock.pending()).toBe(0);
  });

  for (const [label, reply, detail] of [
    ["a malformed reply", "{}", "message has no op"],
    ["an unknown reason", '{"op":"pair-refused","reason":"nope"}', "pair-refused has an unknown reason"],
    ["an out-of-turn reply", '{"op":"pair-fail","reason":"expired"}', "unexpected pair-fail in reply to pair-hello"],
  ] as const) {
    test(`A closes with a clear error on ${label}`, async () => {
      const link = createMemoryLink(ID_A, ID_B);
      const store = memoryStore();
      const initiator = new PairInitiator(ID_B, {
        ...store,
        log: () => {},
        onChange: () => {},
        setTimer: createFakeClock().setTimer,
        dial: async () => link.a,
      });
      const fakeB = (async () => {
        const stream = await link.b.acceptBi();
        await stream.readToEnd(PAIR_MAX_MESSAGE_BYTES);
        await stream.writeAll(text(reply));
        await stream.finish();
      })();
      await initiator.start();
      await fakeB;
      expect(initiator.stage).toEqual({ stage: "failed", failure: { kind: "error", detail } });
      expect(link.b.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.error, reason: detail });
    });
  }

  test("A shows the error B reported when B closes with the error code", async () => {
    const t = setup();
    await t.initiator.start();
    t.link.b.close(PAIR_CLOSE.error, "could not save the pairing");
    await waitFor(() => t.initiator.stage.stage === "failed", { message: "A sees B's error close" });
    expect(t.initiator.stage).toEqual({
      stage: "failed",
      failure: { kind: "error", detail: "the other side reported: could not save the pairing" },
    });
  });
});

describe("pair protocol: B's wait for pair-hello", () => {
  test("a connection that sends nothing is closed with the error code after 10 s (fake clock)", async () => {
    const t = setup();
    expect(HELLO_TIMEOUT_MS).toBe(10_000);
    t.clock.advance(HELLO_TIMEOUT_MS - 1);
    expect(t.link.a.closeInfo()).toBeNull();
    t.clock.advance(1);
    await t.responderDone;
    expect(t.link.a.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.error, reason: "no pair-hello" });
    expect(t.admitCalls()).toBe(0);
    expect(t.clock.pending()).toBe(0);
    expect(t.logs).toContain(`B: pairing: no pair-hello from ${SHORT_A} within 10 s`);
  });

  test("a pair-hello that is started but never finished is cut off the same way", async () => {
    const t = setup();
    const stream = await t.link.a.openBi();
    await stream.writeAll(text('{"op":"pair-'));
    t.clock.advance(HELLO_TIMEOUT_MS);
    await t.responderDone;
    expect(t.link.a.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.error, reason: "no pair-hello" });
    expect(t.admitCalls()).toBe(0);
  });

  test("a pair-hello in time cancels the timeout", async () => {
    const t = setup();
    await t.initiator.start();
    expect(t.clock.pending()).toBe(1); // only the code's expiry
    t.clock.advance(HELLO_TIMEOUT_MS);
    expect(t.responder().stage.stage).toBe("code-shown");
    t.initiator.cancel();
    await t.responderDone;
  });
});

describe("pair protocol: read failures close the connection", () => {
  /** B's end of a link whose `failOn`-th accepted stream fails to read with a non-protocol error. */
  function failingReads(failOn: number) {
    const link = createMemoryLink(ID_A, ID_B);
    let accepted = 0;
    const conn: PairConnection = {
      remoteId: link.b.remoteId,
      openBi: () => link.b.openBi(),
      acceptBi: async (): Promise<PairStream> => {
        const stream = await link.b.acceptBi();
        if (++accepted !== failOn) return stream;
        return {
          writeAll: (bytes) => stream.writeAll(bytes),
          finish: () => stream.finish(),
          readToEnd: async () => {
            throw new Error("RecvStream.readToEnd: stream reset by peer");
          },
        };
      },
      close: (code, reason) => link.b.close(code, reason),
      closed: () => link.b.closed(),
      closeInfo: () => link.b.closeInfo(),
    };
    return { link, conn };
  }

  function responderDeps(clock = createFakeClock()) {
    const store = memoryStore();
    const logs: string[] = [];
    return {
      clock,
      store,
      logs,
      deps: {
        ...store,
        log: (line: string) => logs.push(line),
        onChange: () => {},
        setTimer: clock.setTimer,
        now: clock.now,
        generateCode: () => CODE,
        admit: () => null,
      },
    };
  }

  test("a failed pair-hello read that is not a protocol error closes with the error code", async () => {
    const { link, conn } = failingReads(1);
    const { clock, logs, deps } = responderDeps();
    const done = respondToPairing(conn, deps);
    await rawRequest(link.a, encodePairMessage({ op: "pair-hello" }));
    await done;
    expect(link.a.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.error, reason: "connection error" });
    expect(clock.pending()).toBe(0);
    expect(logs).toContain(
      `pairing: connection from ${SHORT_A} failed before pair-hello: RecvStream.readToEnd: stream reset by peer`,
    );
  });

  test("a failed code-stage read closes with the error code, spends the code and saves nothing", async () => {
    const { link, conn } = failingReads(2);
    const { clock, store, deps } = responderDeps();
    let session: PairResponder | null = null;
    const done = respondToPairing(conn, {
      ...deps,
      admit: (s) => {
        session = s;
        return null;
      },
    });
    expect(decodePairMessage((await rawRequest(link.a, encodePairMessage({ op: "pair-hello" }))) as Uint8Array)).toEqual({
      op: "pair-code-shown",
    });
    await rawRequest(link.a, encodePairMessage({ op: "pair-code", code: CODE }));
    await done;
    expect(link.a.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.error, reason: "connection error" });
    expect(session!.stage).toEqual({
      stage: "failed",
      failure: { kind: "connection-failed", detail: "RecvStream.readToEnd: stream reset by peer" },
    });
    expect(clock.pending()).toBe(0);
    expect(store.peers).toEqual([]);
  });
});

describe("pair protocol: connection failures", () => {
  test("a failed dial is a connection failure with the dial's error", async () => {
    const initiator = new PairInitiator(ID_B, {
      ...memoryStore(),
      log: () => {},
      onChange: () => {},
      setTimer: createFakeClock().setTimer,
      dial: async () => {
        throw new Error("Endpoint.connect: timed out");
      },
    });
    await initiator.start();
    expect(initiator.stage).toEqual({
      stage: "failed",
      failure: { kind: "connection-failed", detail: "Endpoint.connect: timed out" },
    });
  });

  test("a connection that drops without a code is a connection failure", () => {
    expect(failureFromClose({ byPeer: false, reason: "timed out" })).toEqual({ kind: "connection-failed", detail: "timed out" });
    expect(failureFromClose({ byPeer: true, code: PAIR_CLOSE.done, reason: "done" })).toEqual({
      kind: "connection-failed",
      detail: "the other side closed the connection",
    });
    expect(failureFromClose({ byPeer: true, code: PAIR_CLOSE.cancelled, reason: "x" })).toEqual({ kind: "cancelled" });
    expect(failureFromClose({ byPeer: true, code: PAIR_CLOSE.expired, reason: "x" })).toEqual({ kind: "expired" });
  });

  test("text from the other side is cleaned before it is shown", () => {
    const failure = failureFromClose({ byPeer: true, code: PAIR_CLOSE.error, reason: `bad\x1b[31m\nthing ${"x".repeat(200)}` });
    expect(failure.kind).toBe("error");
    const detail = (failure as { detail: string }).detail;
    expect(detail).not.toMatch(/\p{Cc}/u);
    expect(detail.length).toBeLessThan(130);
  });

  test("format characters (bidi overrides, zero-width marks) are dropped from the other side's text", () => {
    const failure = failureFromClose({ byPeer: true, code: PAIR_CLOSE.error, reason: "bad‮⁦​thing" });
    expect(failure).toEqual({ kind: "error", detail: "the other side reported: badthing" });
  });
});

describe("messages", () => {
  test("every message round-trips through encode/decode", () => {
    const all: PairMessage[] = [
      { op: "pair-hello" },
      { op: "pair-code-shown" },
      { op: "pair-refused", reason: "not-accepting" },
      { op: "pair-refused", reason: "busy" },
      { op: "pair-ok" },
      { op: "pair-code", code: CODE },
      { op: "pair-fail", reason: "wrong-code" },
      { op: "pair-fail", reason: "expired" },
    ];
    for (const message of all) expect(decodePairMessage(encodePairMessage(message))).toEqual(message);
    expect(new TextDecoder().decode(encodePairMessage({ op: "pair-hello" }))).toBe('{"op":"pair-hello"}');
  });

  test("anything else is a PairProtocolError", () => {
    for (const bad of ["", "null", "42", '"pair-hello"', '{"op":42}', '{"op":"pair-code"}', '{"op":"pair-fail","reason":"nope"}']) {
      expect(() => decodePairMessage(text(bad))).toThrow(PairProtocolError);
    }
    expect(() => decodePairMessage(Uint8Array.from([0xff, 0xfe]))).toThrow(new PairProtocolError("message is not UTF-8"));
  });
});

describe("parsePairTarget (the Pair with id input)", () => {
  test("accepts a pasted id with surrounding whitespace and uppercase", () => {
    expect(parsePairTarget(`  ${ID_B.toUpperCase()}\n`, ID_A)).toEqual({ ok: true, id: ID_B });
  });

  test("rejects empty input, a short id, non-hex and this install's own id", () => {
    expect(parsePairTarget("   ", ID_A)).toEqual({ ok: false, error: "Paste the other install's id (ib peer id prints it)." });
    expect(parsePairTarget(SHORT_B, ID_A)).toEqual({ ok: false, error: "Not an id: an id is 64 hex characters." });
    expect(parsePairTarget("z".repeat(64), ID_A)).toEqual({ ok: false, error: "Not an id: an id is 64 hex characters." });
    expect(parsePairTarget(ID_A, ID_A)).toEqual({ ok: false, error: "That is this install's own id." });
    expect(parsePairTarget(ID_A, null)).toEqual({ ok: true, id: ID_A });
  });
});

describe("describePairFailure", () => {
  test("names the other install where it matters", () => {
    expect(describePairFailure({ kind: "refused", reason: "busy" }, "b2b2b2b2b2")).toContain("b2b2b2b2b2 is busy");
    expect(describePairFailure({ kind: "refused", reason: "not-accepting" }, "b2b2b2b2b2")).toContain("Peers dialog open");
    expect(describePairFailure({ kind: "cancelled" }, "x")).toBe("Pairing cancelled.");
    expect(describePairFailure({ kind: "expired" }, "x")).toBe("The code expired. Pairing failed.");
  });
});

/**
 * The one module that loads the iroh addon (`@number0/iroh`), and only through
 * the dynamic import in {@link loadIroh}. Nothing else in the codebase imports
 * the package (src/peers/iroh.test.ts checks this).
 *
 * Loading the addon costs ~25 ms of CPU and 230-400 ms of wall time in the
 * compiled binary (docs/plans/iroh-spike-findings.md), so only `ib watch`
 * loads it. Hooks and the `ib peer` commands never do.
 *
 * A thin wrapper over the addon's quirks:
 *   - the addon takes and returns byte buffers as plain `Array<number>` and
 *     rejects `Uint8Array`/`Buffer`; this module converts at the boundary, so
 *     callers only see `Uint8Array`;
 *   - every addon error is a plain `Error` with `code: "GenericFailure"` whose
 *     meaning is only in its (often multi-line, Rust-debug) message; this module
 *     rethrows each one as an {@link IrohError} with a short one-line message.
 *
 * It exposes only what the current phase uses. Later phases extend it.
 */

import { InjectionContext } from "../types";

/** The addon's module type. A type-only reference: it loads nothing. */
type IrohAddon = typeof import("@number0/iroh");
type AddonSecretKey = InstanceType<IrohAddon["SecretKey"]>;
type AddonEndpointId = InstanceType<IrohAddon["EndpointId"]>;

/** Longest message an {@link IrohError} carries before it is cut. */
const MAX_ERROR_MESSAGE = 160;

/** An addon failure, with the addon's message cut down to one short line. */
export class IrohError extends Error {
  constructor(
    /** The wrapper call that failed, e.g. `"SecretKey.fromBytes"`. */
    readonly op: string,
    /** The shortened addon message. */
    readonly detail: string,
  ) {
    super(`${op}: ${detail}`);
    this.name = "IrohError";
  }
}

/**
 * Shorten an addon error to one line: the first non-empty line of its message,
 * whitespace collapsed, cut at {@link MAX_ERROR_MESSAGE} characters.
 */
export function shortIrohMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const collapsed = line.replace(/\s+/g, " ");
  if (collapsed.length === 0) return "unknown error";
  return collapsed.length > MAX_ERROR_MESSAGE ? `${collapsed.slice(0, MAX_ERROR_MESSAGE - 1)}…` : collapsed;
}

/** Run one addon call, rethrowing its failure as an {@link IrohError}. */
function call<T>(op: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new IrohError(op, shortIrohMessage(err));
  }
}

const toArray = (bytes: Uint8Array): number[] => Array.from(bytes);
const toUint8 = (bytes: number[]): Uint8Array => Uint8Array.from(bytes);

/** An endpoint's id: a 32-byte ed25519 public key, written as 64 lowercase hex characters. */
export class IrohEndpointId {
  constructor(private readonly raw: AddonEndpointId) {}

  /** The full id: 64 lowercase hex characters. */
  toString(): string {
    return call("EndpointId.toString", () => this.raw.toString());
  }

  /** The short id: the first 10 hex characters. */
  fmtShort(): string {
    return call("EndpointId.fmtShort", () => this.raw.fmtShort());
  }
}

/** The secret half of an endpoint identity: 32 bytes. */
export class IrohSecretKey {
  constructor(private readonly raw: AddonSecretKey) {}

  /** The 32 secret-key bytes. */
  toBytes(): Uint8Array {
    return toUint8(call("SecretKey.toBytes", () => this.raw.toBytes()));
  }

  /** The public id this key derives. */
  public(): IrohEndpointId {
    return new IrohEndpointId(call("SecretKey.public", () => this.raw.public()));
  }
}

/** What {@link loadIroh} returns: the wrapped calls this phase uses. */
export interface Iroh {
  SecretKey: {
    /** A new random secret key. */
    generate(): IrohSecretKey;
    /** A secret key from its 32 bytes. */
    fromBytes(bytes: Uint8Array): IrohSecretKey;
  };
  EndpointId: {
    /**
     * Parse a full id. Accepts only 64 lowercase hex characters: trim and
     * lowercase user input first (normalizePeerId in src/peers/store.ts).
     */
    fromString(id: string): IrohEndpointId;
  };
}

function wrap(addon: IrohAddon): Iroh {
  return {
    SecretKey: {
      generate: () => new IrohSecretKey(call("SecretKey.generate", () => addon.SecretKey.generate())),
      fromBytes: (bytes) => new IrohSecretKey(call("SecretKey.fromBytes", () => addon.SecretKey.fromBytes(toArray(bytes)))),
    },
    EndpointId: {
      fromString: (id) => new IrohEndpointId(call("EndpointId.fromString", () => addon.EndpointId.fromString(id))),
    },
  };
}

/**
 * Loads the addon module. Injectable so a test can make loading throw and so
 * prove a code path never reaches the addon.
 */
export const irohAddonLoaderCtx = new InjectionContext<() => Promise<IrohAddon>>(() => import("@number0/iroh"));

/**
 * Load the iroh addon and return the wrapped API. The module system caches
 * the import, so only the first call in a process pays the load cost. A load
 * failure is rethrown as an {@link IrohError} with op `"load"`.
 */
export async function loadIroh(): Promise<Iroh> {
  let addon: IrohAddon;
  try {
    addon = await irohAddonLoaderCtx.fn();
  } catch (err) {
    throw new IrohError("load", shortIrohMessage(err));
  }
  return wrap(addon);
}

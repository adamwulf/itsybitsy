/**
 * The trusted-peer store: `~/.itsybitsy/peer/peers.json`, a JSON array of
 * `{id, name, pairedAt}` (docs/plans/iroh-peering.md, "Key generation and
 * storage").
 *
 * - Peers are keyed by id: 64 lowercase hex characters (an iroh endpoint id).
 *   Input ids are trimmed and lowercased first.
 * - A name is a local label, and the first segment of the peer's row keys in
 *   `ib watch`. The pairing name prompt refuses a name another peer or this
 *   machine has (peerNameProblem); the store itself does not check.
 * - `pairedAt` is an ISO 8601 timestamp.
 * - Every write replaces the whole file atomically (temp file + rename), so a
 *   reader sees the old or the new array, never a torn one.
 *
 * There is no lock around read-modify-write. The only writers are a human
 * running `ib peer remove` and pairing in the one `ib watch` that owns the
 * endpoint, so two writes at the same moment are not expected.
 */

import { readFile, rename, unlink } from "node:fs/promises";
import { peersFile } from "../runtime-names";
import { ensurePeerDir } from "./peer-dir";

export interface Peer {
  /** The peer's endpoint id: 64 lowercase hex characters. */
  id: string;
  /** A local label, at most {@link MAX_PEER_NAME} characters. */
  name: string;
  /** When the pairing completed, as an ISO 8601 timestamp. */
  pairedAt: string;
}

/** Longest peer name, in characters (code points). */
export const MAX_PEER_NAME = 32;
/** Length of the id prefix used as a name when none is given (iroh's short id). */
export const SHORT_ID_LENGTH = 10;

const PEER_ID = /^[0-9a-f]{64}$/;

/** Trim and lowercase an id. Returns null unless the result is 64 hex characters. */
export function normalizePeerId(input: string): string | null {
  const id = input.trim().toLowerCase();
  return PEER_ID.test(id) ? id : null;
}

/** The short form of an id: its first 10 hex characters. */
export function shortPeerId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/**
 * Clean a peer name: control characters stripped, trimmed, cut to
 * {@link MAX_PEER_NAME} characters. An empty result falls back to the id's
 * short form.
 */
export function sanitizePeerName(name: string, id: string): string {
  const stripped = name.replace(/\p{Cc}/gu, "").trim();
  const capped = Array.from(stripped).slice(0, MAX_PEER_NAME).join("").trimEnd();
  return capped.length > 0 ? capped : shortPeerId(id);
}

/**
 * Why `name` cannot become the name of peer `id`, or null if it can (SPEC
 * §20.2). A peer's name is the first segment of its rows' keys in `ib watch`
 * (`<machine>/<repo>/<agent>`, SPEC §17.1), so it may not hold a `/`, and may
 * not equal, case-insensitively, another peer's name or this machine's name.
 * The name is checked as it would be stored (sanitizePeerName). Only the
 * pairing name prompt asks; names already in peers.json are left alone.
 */
export function peerNameProblem(name: string, id: string, peers: readonly Peer[], machineName: string): string | null {
  const stored = sanitizePeerName(name, id);
  if (stored.startsWith("@")) return "A machine name cannot start with @.";
  if (stored.includes("/")) return `A name cannot contain "/".`;
  const lower = stored.toLowerCase();
  if (lower === machineName.toLowerCase()) return `"${machineName}" is this machine's name.`;
  const other = peers.find((p) => p.id !== id && p.name.toLowerCase() === lower);
  if (other) return `Another peer is already named "${other.name}".`;
  return null;
}

/** peers.json exists but is not a valid peer list. */
export class PeerStoreError extends Error {
  constructor(message: string) {
    super(`${peersFile()}: ${message}`);
    this.name = "PeerStoreError";
  }
}

function parsePeers(text: string): Peer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PeerStoreError("not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new PeerStoreError("not a JSON array");
  return parsed.map((entry, index) => {
    const e = (entry ?? {}) as { id?: unknown; name?: unknown; pairedAt?: unknown };
    const id = typeof e.id === "string" ? normalizePeerId(e.id) : null;
    if (!id) throw new PeerStoreError(`entry ${index} has no valid id (64 hex characters)`);
    return {
      id,
      name: sanitizePeerName(typeof e.name === "string" ? e.name : "", id),
      pairedAt: typeof e.pairedAt === "string" ? e.pairedAt : "",
    };
  });
}

/**
 * The paired peers, in file order. A missing file is an empty list. A file
 * that is not a valid peer list throws {@link PeerStoreError} rather than
 * reading as empty, so a later write cannot silently drop every peer.
 */
export async function readPeers(): Promise<Peer[]> {
  let text: string;
  try {
    text = await readFile(peersFile(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parsePeers(text);
}

async function writePeers(peers: Peer[]): Promise<void> {
  await ensurePeerDir();
  const path = peersFile();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await Bun.write(tmp, `${JSON.stringify(peers, null, 2)}\n`);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Add a peer, replacing any entry with the same id. The id is normalized
 * (throws when it is not 64 hex characters), the name sanitized, and
 * `pairedAt` defaults to now. Returns the stored entry.
 */
export async function addPeer(peer: { id: string; name: string; pairedAt?: string }): Promise<Peer> {
  const id = normalizePeerId(peer.id);
  if (!id) throw new Error(`not a peer id (64 hex characters): ${JSON.stringify(peer.id)}`);
  const stored: Peer = {
    id,
    name: sanitizePeerName(peer.name, id),
    pairedAt: peer.pairedAt ?? new Date().toISOString(),
  };
  const previous = await readPeers();
  if (stored.name.startsWith("@") && !previous.some(p => p.id === id && p.name === stored.name)) {
    throw new Error("A machine name cannot start with @.");
  }
  const peers = previous.filter((p) => p.id !== id);
  peers.push(stored);
  await writePeers(peers);
  return stored;
}

export type RemovePeerResult =
  | { ok: true; removed: Peer }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; matches: Peer[] };

/**
 * Remove one peer, chosen by its exact full id (trimmed and lowercased first)
 * or by its exact name. An id match wins. A name that more than one peer has
 * removes nothing and returns those peers, so the caller can ask for an id.
 */
export async function removePeer(target: string): Promise<RemovePeerResult> {
  const peers = await readPeers();
  const id = normalizePeerId(target);
  let match = id ? peers.find((p) => p.id === id) : undefined;
  if (!match) {
    const named = peers.filter((p) => p.name === target);
    if (named.length > 1) return { ok: false, reason: "ambiguous", matches: named };
    match = named[0];
  }
  if (!match) return { ok: false, reason: "not-found" };
  const removedId = match.id;
  await writePeers(peers.filter((p) => p.id !== removedId));
  return { ok: true, removed: match };
}

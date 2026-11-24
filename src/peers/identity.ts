/**
 * This install's peering identity: an ed25519 key pair whose public half is
 * the install's id (docs/plans/iroh-peering.md, "Key generation and storage").
 *
 * `~/.itsybitsy/peer/secret.key` holds the 32 secret-key bytes (the ed25519
 * seed) as 64 lowercase hex characters plus a newline. The same key is used on
 * every run, so the id never changes.
 *
 * Nothing here loads the iroh addon. The seed is 32 random bytes from
 * node:crypto (an iroh SecretKey is exactly that), and the id is derived with
 * node:crypto's ed25519. identity.test.ts checks the result against iroh.
 */

import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { mkdir, readFile, link, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sealDir } from "../agent-seal";
import { safeTransferParent, stagingOwnerStart, sweepEntries, sweepTransferDirectory, writeTransferOwner } from "./transfer-owner";
import { peerSecretKeyFile } from "../runtime-names";
import { ensurePeerDir } from "./peer-dir";

/** PKCS#8 DER header for a raw 32-byte ed25519 private key (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const SEED_BYTES = 32;
const SEED_HEX = /^[0-9a-f]{64}$/;

/**
 * A process that loses the exclusive create can open the file in the moment
 * between the winner's create and its write, and see it empty. Re-read an
 * empty file this many times, this far apart, before calling it malformed.
 */
const EMPTY_READ_RETRIES = 10;
const EMPTY_READ_DELAY_MS = 20;

export interface PeerIdentity {
  /** The 32 secret-key bytes (the ed25519 seed). */
  secretKey: Uint8Array;
  /** This install's id: the ed25519 public key as 64 lowercase hex characters. */
  id: string;
}

/** The id (public key, 64 lowercase hex characters) for a 32-byte ed25519 seed. */
export function deriveEndpointId(seed: Uint8Array): string {
  if (seed.length !== SEED_BYTES) {
    throw new Error(`an ed25519 secret key is ${SEED_BYTES} bytes, got ${seed.length}`);
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(-SEED_BYTES)).toString("hex");
}

/** The secret.key file contents for a seed. */
export function encodeSecretKey(seed: Uint8Array): string {
  return `${Buffer.from(seed).toString("hex")}\n`;
}

/** Parse secret.key contents. Throws when it is not 64 lowercase hex characters. */
export function parseSecretKey(text: string, path: string): Uint8Array {
  const hex = text.trim();
  if (!SEED_HEX.test(hex)) {
    throw new Error(
      `${path} is not 64 lowercase hex characters. It is this install's peering key: ` +
        "fix or remove it by hand (removing it gives this install a new id, and its peers must pair again)",
    );
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

async function readSecretKey(path: string): Promise<Uint8Array> {
  let text = await readFile(path, "utf-8");
  for (let i = 0; i < EMPTY_READ_RETRIES && text.length === 0; i++) {
    await Bun.sleep(EMPTY_READ_DELAY_MS);
    text = await readFile(path, "utf-8");
  }
  return parseSecretKey(text, path);
}

/**
 * Read this install's identity from secret.key, creating the key first when
 * the file does not exist.
 *
 * The sealed 0600 temp is published with an exclusive link, so when two
 * processes race, exactly one writes a key and the other reads it. A
 * malformed file is an error, never overwritten: replacing the key would
 * change the id and break every pairing.
 */
export async function loadOrCreateIdentity(): Promise<PeerIdentity> {
  const path = peerSecretKeyFile();
  await ensurePeerDir();

  const staging = join(sealDir(), ".key-staging");
  await sweepEntries(staging, async name => {
    if (/^[a-f0-9-]{36}$/.test(name)) await sweepTransferDirectory(join(staging, name), performance.now());
  });
  const existing = async () => {
    const secretKey = await readSecretKey(path);
    return { secretKey, id: deriveEndpointId(secretKey) };
  };
  try { return await existing(); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }

  await mkdir(staging, { recursive: true, mode: 0o700 });
  const attempt = join(await safeTransferParent(staging), crypto.randomUUID());
  await mkdir(attempt, { mode: 0o700 });
  try {
    await writeTransferOwner(attempt, { pid: process.pid, start: stagingOwnerStart(process.pid) });
    const secretKey = Uint8Array.from(randomBytes(SEED_BYTES));
    const temp = join(attempt, "key");
    await writeFile(temp, encodeSecretKey(secretKey), { flag: "wx", mode: 0o600 });
    try { await link(temp, path); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return await existing();
      throw err;
    }
    return { secretKey, id: deriveEndpointId(secretKey) };
  } finally { await rm(attempt, { recursive: true, force: true }); }
}

/** This install's id (64 lowercase hex characters), creating the key if it is missing. */
export async function loadOrCreatePeerId(): Promise<string> {
  return (await loadOrCreateIdentity()).id;
}

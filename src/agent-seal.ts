import { createHash, randomUUID } from "crypto";
import { mkdir, rm, rename } from "fs/promises";
import { userHome } from "./home";
import { join } from "path";

import { metaCanSpawnChildren } from "./agent-types";
import {
  resolvePathsConfig,
  resolveSandboxConfig,
  type PathsConfig,
  type SandboxConfig,
} from "./sandbox";

/**
 * The profile inputs that decide a sandboxed agent's kernel roots. These are
 * exactly the fields resume/respawn/refresh re-derive the runtime roots from
 * (SPEC-SANDBOX §4A.8, §4C.3): `agentType` and the resolved `canSpawnChildren`
 * choose REPOAGENTS read-vs-write, PARENTCLAUDE, and the tmux escape; `paths`
 * and `sandbox` are the frozen filesystem/network policy replayed on resume.
 */
export interface SealInputs {
  agentType: string | null;
  /** Resolved via metaCanSpawnChildren (per-agent meta override, then the type). */
  canSpawnChildren: boolean;
  paths: PathsConfig;
  sandbox: SandboxConfig;
}

/** The on-disk sealed record: the canonical inputs plus a sha256 over them. */
export interface SealRecord {
  inputs: SealInputs;
  sha256: string;
}

export type SealVerification =
  | { ok: true }
  | { ok: false; field: string; reason: string };

function sealHome(home?: string): string {
  return home ?? userHome();
}

/**
 * The per-agent sealed-record directory, `~/.itsybitsy/sealed`. `_all.md`
 * `paths.deny` carves this out of every sandboxed agent's reach (deny wins over
 * the `~/.itsybitsy` read floor and cannot be re-opened by any layer), so a
 * non-spawner can neither read nor write it. The `~` here expands via the same
 * `homedir()`/`$HOME` the seatbelt `~` expansion uses, so the write path and the
 * kernel deny always name the same directory.
 */
export function sealDir(home?: string): string {
  return join(sealHome(home), ".itsybitsy", "sealed");
}

/** The seal file for one agent: `<sealDir>/<repoId>-<agentId>.json`. */
export function sealPath(repoId: string, agentId: string, home?: string): string {
  return join(sealDir(home), `${repoId}-${agentId}.json`);
}
export function sealCapabilityPath(repoId: string, agentId: string, home?: string): string {
  return join(sealDir(home), `${repoId}-${agentId}.cap`);
}
export async function sealCapabilityDigest(meta: Record<string, unknown>): Promise<string> {
  return createHash("sha256").update(canonicalSealJson(await computeSealInputs(meta))).digest("hex");
}
export async function newSealCapability(meta: Record<string, unknown>): Promise<{ token: string; digest: string; expires: number }> {
  return { token: randomUUID(), digest: await sealCapabilityDigest(meta), expires: Date.now() + 30_000 };
}
export async function consumeSealCapability(repoId: string, agentId: string, meta: Record<string, unknown>, token: string, home?: string): Promise<boolean> {
  try {
    if (!/^[0-9a-f-]{36}$/.test(token)) return false;
    const path = sealCapabilityPath(repoId, agentId, home);
    const cap = await Bun.file(path).json() as { token?: string; digest?: string; expires?: number };
    if (cap.token !== token || (cap.expires ?? 0) < Date.now()) return false;
    const claimed = `${path}.claimed-${token}`;
    await rename(path, claimed);
    try {
      return cap.digest === await sealCapabilityDigest(meta);
    } finally {
      await rm(claimed, { force: true });
    }
  } catch { return false; }
}

/**
 * Deterministic, key-sorted JSON so the sha256 and cross-record equality are
 * stable regardless of object key insertion order. Array order is preserved —
 * the paths lists are already canonicalized to a stable order upstream.
 */
export function canonicalSealJson(value: unknown): string {
  const encode = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(encode);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        out[key] = encode((node as Record<string, unknown>)[key]);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(encode(value));
}

/**
 * Compute the profile inputs from an agent's meta. `canSpawnChildren` is
 * resolved via metaCanSpawnChildren (which reads the read-only agent-type file
 * when there is no per-agent override); `paths`/`sandbox` are the frozen meta
 * blocks. A later edit to any of these — in particular a non-spawner flipping
 * `meta.canSpawnChildren` or swapping `meta.agentType` to a spawning type — is
 * exactly what the seal detects (SPEC-SANDBOX §4C.3).
 */
export async function computeSealInputs(meta: Record<string, unknown>): Promise<SealInputs> {
  const agentType = typeof meta.agentType === "string" && meta.agentType.length > 0
    ? meta.agentType
    : null;
  return {
    agentType,
    canSpawnChildren: await metaCanSpawnChildren(meta),
    paths: resolvePathsConfig(meta.paths as PathsConfig | undefined),
    sandbox: resolveSandboxConfig({ sandbox: meta.sandbox as SandboxConfig | undefined }),
  };
}

/** Build the record (inputs + sha256 over the canonical inputs JSON). */
export function computeSealRecord(inputs: SealInputs): SealRecord {
  return {
    inputs,
    sha256: createHash("sha256").update(canonicalSealJson(inputs)).digest("hex"),
  };
}

/**
 * Write the sealed record directly. Throws EPERM/EACCES when called from a
 * SANDBOXED process — the seal dir is denied to every sandboxed agent — which
 * `sealAgentRecord` (ib-commands) catches to route the write through the
 * unsandboxed tmux server. Any other error propagates.
 */
export async function writeSealRecordDirect(
  repoId: string,
  agentId: string,
  meta: Record<string, unknown>,
  home?: string,
): Promise<void> {
  const inputs = await computeSealInputs(meta);
  const record = computeSealRecord(inputs);
  await mkdir(sealDir(home), { recursive: true });
  await Bun.write(sealPath(repoId, agentId, home), JSON.stringify(record, null, 2));
}

/** Read a sealed record, or null when the file is missing / unreadable. */
export async function readSealRecord(
  repoId: string,
  agentId: string,
  home?: string,
): Promise<SealRecord | null> {
  try {
    const file = Bun.file(sealPath(repoId, agentId, home));
    if (!(await file.exists())) return null;
    return (await file.json()) as SealRecord;
  } catch {
    return null;
  }
}

/** Delete a sealed record (idempotent — a missing file is not an error). */
export async function deleteSealRecord(
  repoId: string,
  agentId: string,
  home?: string,
): Promise<void> {
  await rm(sealPath(repoId, agentId, home), { force: true });
}

/**
 * Compare an agent's CURRENT meta inputs against its sealed record. Callers gate
 * this on `meta.sandbox.enabled` — a disabled agent has no profile and is never
 * checked. Returns the first differing field so the caller can name it. A
 * missing seal for an enabled agent is a failure with its own reason; a record
 * whose stored sha256 does not match its stored inputs is a tamper failure.
 */
export async function verifyMetaAgainstSeal(
  repoId: string,
  agentId: string,
  meta: Record<string, unknown>,
  home?: string,
): Promise<SealVerification> {
  const record = await readSealRecord(repoId, agentId, home);
  if (!record) {
    return { ok: false, field: "(missing)", reason: "no sealed record" };
  }
  const recomputed = createHash("sha256").update(canonicalSealJson(record.inputs)).digest("hex");
  if (recomputed !== record.sha256) {
    return { ok: false, field: "sha256", reason: "sealed record integrity check failed" };
  }

  const current = await computeSealInputs(meta);
  // Compare field-by-field in a fixed order so the FIRST divergence is named.
  const fields: Array<keyof SealInputs> = ["agentType", "canSpawnChildren", "paths", "sandbox"];
  for (const field of fields) {
    if (canonicalSealJson(current[field]) !== canonicalSealJson(record.inputs[field])) {
      return { ok: false, field, reason: `${field} does not match the sealed record` };
    }
  }
  return { ok: true };
}

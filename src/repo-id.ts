import { mkdir } from "fs/promises";
import * as runtimeNames from "./runtime-names";

async function storedRepoId(repoPath: string): Promise<string | null> {
  const file = runtimeNames.repoIdFile(repoPath);
  let id: string;
  try {
    id = (await Bun.file(file).text()).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read repository id ${file}: ${err}. Refusing to generate a new id over one that may already exist.`);
  }
  if (!id) return null;
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`Invalid repository id in ${file}: expected 8 lowercase hexadecimal characters`);
  return id;
}

/** Teardown can identify an existing queue, but must never mint a new identity. */
export async function readRepoId(repoPath: string): Promise<string> {
  const id = await storedRepoId(repoPath);
  if (!id) throw new Error(`Missing repository id in ${runtimeNames.repoIdFile(repoPath)}`);
  return id;
}

export async function getRepoId(repoPath: string): Promise<string> {
  const existing = await storedRepoId(repoPath);
  if (existing) return existing;
  const repoIdFile = runtimeNames.repoIdFile(repoPath);

  // Generate new 8 hex char ID
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const newId = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  await mkdir(runtimeNames.runtimeDir(repoPath), { recursive: true });
  await Bun.write(repoIdFile, newId + "\n");
  return newId;
}

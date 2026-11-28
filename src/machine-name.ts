/**
 * This machine's name: the first segment of every local row key in `ib watch`
 * and of every fully qualified agent id (`<machine>/<repo>/<agent>`, SPEC
 * §17.1). A paired machine's name is the one typed when pairing
 * (src/peers/store.ts); this one is set once, the first time it is needed,
 * from the macOS computer name (`scutil --get ComputerName`), or the hostname
 * without `.local` when that fails. It is then saved to
 * `~/.itsybitsy/machine-name` and always read from there, so renaming the Mac
 * or a changed hostname does not change it. Edit the file to rename it.
 *
 * The name is always used in its clean form (cleanMachineName): `MacBook Pro`
 * in the file reads as `macbook-pro`. The file itself is never rewritten.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { machineNameFile } from "./runtime-names";
import { repoNameFromFolder } from "./validation";

/** Longest machine name, in characters (code points). */
export const MAX_MACHINE_NAME = 32;

/** The name used when neither the computer name nor the hostname gives one. */
export const FALLBACK_MACHINE_NAME = "local";

/** What initializeMachineName needs from the system; tests pass their own. */
export interface MachineNameDeps {
  /** Run a command; its exit code and stdout. May throw when it cannot start. */
  run(cmd: string[]): Promise<{ exitCode: number; stdout: string }>;
  hostname(): string;
}

export const defaultMachineNameDeps: MachineNameDeps = {
  async run(cmd) {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
  },
  hostname,
};

/**
 * The clean form of a machine name: what commands, fully qualified ids and
 * every text an agent reads use, for this machine and for a paired one
 * (cleanPeerName in src/peers/store.ts). Trimmed, then a repo name's rules
 * (repoNameFromFolder: lowercased, each run of whitespace turned into `-`,
 * every character outside [a-z0-9_-] dropped), then cut to
 * {@link MAX_MACHINE_NAME} characters. `MacBook Pro` → `macbook-pro`. May be empty.
 */
export function cleanMachineName(raw: string): string {
  return repoNameFromFolder(raw.trim()).slice(0, MAX_MACHINE_NAME);
}

/**
 * Safety-only cleanup, without cleanMachineName's lowercasing or character
 * allowlist: control and format characters (bidi overrides, zero-width marks)
 * removed, `/` (the key separator) turned into `-`, trimmed, leading `@`
 * removed, and cut to {@link MAX_MACHINE_NAME} characters; `.` and `..` give
 * "". May be empty. The wire check of an incoming peer sender id
 * (src/peers/send-frame.ts) accepts a machine segment this leaves unchanged,
 * so a peer still running an older ib, which sends its display name
 * (`MacBook Pro/repo/agent`), is still accepted.
 */
export function wireSafeMachineName(raw: string): string {
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\//g, "-").trim().replace(/^[@\s]+/u, "");
  const name = Array.from(cleaned).slice(0, MAX_MACHINE_NAME).join("").trimEnd();
  return name === "." || name === ".." ? "" : name;
}

/** The computer name, else the hostname without `.local`, else the fallback; each cleaned, and an empty one skipped. */
async function detectMachineName(deps: MachineNameDeps): Promise<string> {
  try {
    const result = await deps.run(["scutil", "--get", "ComputerName"]);
    const name = result.exitCode === 0 ? cleanMachineName(result.stdout) : "";
    if (name !== "") return name;
  } catch {
    // scutil missing or not runnable: fall through to the hostname.
  }
  const host = cleanMachineName(deps.hostname().trim().replace(/\.local$/i, ""));
  return host !== "" ? host : FALLBACK_MACHINE_NAME;
}

async function savedMachineName(path: string): Promise<string | null> {
  try {
    let raw = await readFile(path, "utf8");
    // wx creates the directory entry just before the winner writes its name.
    // A reader in that interval waits for the write, without deriving a name.
    for (let attempt = 0; raw === "" && attempt < 10; attempt++) {
      await Bun.sleep(20);
      raw = await readFile(path, "utf8");
    }
    const name = cleanMachineName(raw);
    if (!name) throw new Error(`Invalid machine name in ${path}: it needs a letter, digit, - or _`);
    return name;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read-only identity lookup used by every queue writer and reader. Returns the clean name. */
export async function readMachineName(): Promise<string> {
  const path = machineNameFile();
  const name = await savedMachineName(path);
  if (name === null) throw new Error(`Machine name is missing at ${path}. Start ib watch to initialize it.`);
  return name;
}

/** Initialize at watch launch or spawn, outside the agent sandbox. Returns the clean name. */
export async function initializeMachineName(deps: MachineNameDeps = defaultMachineNameDeps): Promise<string> {
  const path = machineNameFile();
  const saved = await savedMachineName(path);
  if (saved !== null) return saved;
  const name = await detectMachineName(deps);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, name + "\n", { flag: "wx" });
    return name;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return readMachineName();
  }
}

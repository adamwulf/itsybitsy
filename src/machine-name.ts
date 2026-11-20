/**
 * This machine's name: the first segment of every local row key in `ib watch`
 * (`<machine>/<repo>/<agent>`, SPEC §17.1). A paired machine's name is the one
 * typed when pairing (src/peers/store.ts); this one is set once, the first time
 * it is needed, from the macOS computer name (`scutil --get ComputerName`), or
 * the hostname without `.local` when that fails. It is then saved to
 * `~/.itsybitsy/machine-name` and always read from there, so renaming the Mac
 * or a changed hostname does not change it. Edit the file to rename it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { machineNameFile } from "./runtime-names";

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
 * A name made safe for a row key: control and format characters (bidi
 * overrides, zero-width marks) removed, `/` (the key separator) turned into
 * `-`, trimmed, and cut to {@link MAX_MACHINE_NAME} characters. May be empty.
 */
export function sanitizeMachineName(raw: string): string {
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\//g, "-").trim();
  const name = Array.from(cleaned).slice(0, MAX_MACHINE_NAME).join("").trimEnd();
  return name === "." || name === ".." ? "" : name;
}

/** The computer name, else the hostname without `.local`, else the fallback; sanitized. */
async function detectMachineName(deps: MachineNameDeps): Promise<string> {
  try {
    const result = await deps.run(["scutil", "--get", "ComputerName"]);
    const name = result.exitCode === 0 ? sanitizeMachineName(result.stdout) : "";
    if (name !== "") return name;
  } catch {
    // scutil missing or not runnable: fall through to the hostname.
  }
  const host = sanitizeMachineName(deps.hostname().replace(/\.local$/i, ""));
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
    const name = sanitizeMachineName(raw);
    if (!name) throw new Error(`Invalid machine name in ${path}`);
    return name;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read-only identity lookup used by every queue writer and reader. */
export async function readMachineName(): Promise<string> {
  const path = machineNameFile();
  const name = await savedMachineName(path);
  if (name === null) throw new Error(`Machine name is missing at ${path}. Start ib watch to initialize it.`);
  return name;
}

/** Initialize at watch launch, spawn, or watchdog startup, outside the agent sandbox. */
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

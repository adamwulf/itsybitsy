import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resetUserHome, setUserHome } from "./home";
import { FALLBACK_MACHINE_NAME, initializeMachineName, readMachineName, sanitizeMachineName, type MachineNameDeps } from "./machine-name";
import { machineNameFile } from "./runtime-names";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-machine-name-"));
  setUserHome(home);
});

afterEach(async () => {
  resetUserHome();
  await rm(home, { recursive: true, force: true });
});

/** Deps that record every command and answer with the given computer name and hostname. */
function fakeDeps(computerName: { exitCode: number; stdout: string } | Error, host: string) {
  const calls: string[][] = [];
  const deps: MachineNameDeps = {
    async run(cmd) {
      calls.push(cmd);
      if (computerName instanceof Error) throw computerName;
      return computerName;
    },
    hostname: () => host,
  };
  return { deps, calls };
}

describe("sanitizeMachineName", () => {
  test("trims, strips control and format characters, replaces / and caps at 32", () => {
    expect(sanitizeMachineName("  Adam's MacBook Pro\n")).toBe("Adam's MacBook Pro");
    expect(sanitizeMachineName("Mac‮Book​\x07Air")).toBe("MacBookAir");
    expect(sanitizeMachineName("work/home")).toBe("work-home");
    expect(sanitizeMachineName("..")).toBe("");
    expect(sanitizeMachineName(".")).toBe("");
    expect(sanitizeMachineName("x".repeat(40))).toBe("x".repeat(32));
    // The cap counts characters, not UTF-16 units, and leaves no trailing space.
    expect(sanitizeMachineName(`${"🍎".repeat(31)} b`)).toBe("🍎".repeat(31));
    expect(sanitizeMachineName("​ \n")).toBe("");
  });
});

describe("initializeMachineName", () => {
  test("is created once from the computer name, sanitized, and saved", async () => {
    const { deps, calls } = fakeDeps({ exitCode: 0, stdout: " Studio/Mac​\n" }, "ignored.local");
    expect(await initializeMachineName(deps)).toBe("Studio-Mac");
    expect(calls).toEqual([["scutil", "--get", "ComputerName"]]);
    expect(await readFile(machineNameFile(), "utf-8")).toBe("Studio-Mac\n");
  });

  test("the file wins: a later start does not run scutil, and a changed hostname changes nothing", async () => {
    await initializeMachineName(fakeDeps({ exitCode: 0, stdout: "First Name\n" }, "first.local").deps);
    const later = fakeDeps({ exitCode: 0, stdout: "Renamed Mac\n" }, "renamed.local");
    expect(await initializeMachineName(later.deps)).toBe("First Name");
    expect(later.calls).toEqual([]);
  });

  test("a hand-edited file is read, sanitized", async () => {
    await mkdir(dirname(machineNameFile()), { recursive: true });
    await writeFile(machineNameFile(), "  my/box \n");
    const { deps, calls } = fakeDeps({ exitCode: 0, stdout: "Other\n" }, "other.local");
    expect(await initializeMachineName(deps)).toBe("my-box");
    expect(calls).toEqual([]);
  });

  test("falls back to the hostname without .local when scutil fails or exits non-zero", async () => {
    expect(await initializeMachineName(fakeDeps({ exitCode: 1, stdout: "" }, "studio.local").deps)).toBe("studio");
    await rm(machineNameFile());
    expect(await initializeMachineName(fakeDeps(new Error("ENOENT: scutil"), "laptop.local").deps)).toBe("laptop");
    expect(await readFile(machineNameFile(), "utf-8")).toBe("laptop\n");
  });

  test("an empty computer name and hostname give the fallback name", async () => {
    expect(await initializeMachineName(fakeDeps({ exitCode: 0, stdout: "\n" }, ".local").deps)).toBe(FALLBACK_MACHINE_NAME);
  });

  test("a missing identity produces a read-only error even on a writable home", async () => {
    await expect(readMachineName()).rejects.toThrow(`Machine name is missing at ${machineNameFile()}`);
    expect(await readdir(home)).toEqual([]);
  });

  test("concurrent initializers with different candidates return the persisted winner", async () => {
    const bothDetecting = Promise.withResolvers<void>();
    let arrivals = 0;
    function start(candidate: string) {
      return initializeMachineName({
        async run() {
          if (++arrivals === 2) bothDetecting.resolve();
          await bothDetecting.promise;
          return { exitCode: 0, stdout: candidate };
        },
        hostname: () => candidate,
      });
    }
    const names = await Promise.all([start("one"), start("two")]);
    const saved = await readMachineName();
    expect(["one", "two"]).toContain(saved);
    expect(names).toEqual([saved, saved]);
  });

  test("initialization surfaces an invalid saved name", async () => {
    await mkdir(dirname(machineNameFile()), { recursive: true });
    await writeFile(machineNameFile(), "\n");
    await expect(initializeMachineName()).rejects.toThrow("Invalid machine name");
  });
});

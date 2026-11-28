import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resetUserHome, setUserHome } from "./home";
import { cleanMachineName, FALLBACK_MACHINE_NAME, initializeMachineName, readMachineName, wireSafeMachineName, type MachineNameDeps } from "./machine-name";
import { repoNameFromFolder } from "./validation";
import { runIsolatedCli } from "./test-cli-runner";
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

describe("cleanMachineName", () => {
  test("applies the repo-name rules after trimming, then caps at 32", () => {
    expect(cleanMachineName("MacBook Pro")).toBe("macbook-pro");
    expect(cleanMachineName("  Adam's MacBook Pro\n")).toBe("adams-macbook-pro");
    expect(cleanMachineName("Studio \t Mac")).toBe("studio-mac");
    expect(cleanMachineName("Mac‮Book​\x07Air")).toBe("macbookair");
    expect(cleanMachineName("work/home")).toBe("workhome");
    expect(cleanMachineName("@App")).toBe("app");
    expect(cleanMachineName("my_box-2")).toBe("my_box-2");
    expect(cleanMachineName("x".repeat(40))).toBe("x".repeat(32));
    expect(cleanMachineName("..")).toBe("");
    expect(cleanMachineName("山田")).toBe("");
    expect(cleanMachineName("​ \n")).toBe("");
  });

  test("uses repoNameFromFolder's rules, so a repo and a machine of the same name clean alike", () => {
    for (const name of ["MacBook Pro", "Adam's Mac", "a/b c", "Ünïcode Box"]) {
      expect(cleanMachineName(name)).toBe(repoNameFromFolder(name));
    }
  });
});

describe("wireSafeMachineName", () => {
  test("trims, strips control and format characters, replaces / and caps at 32", () => {
    expect(wireSafeMachineName("  Adam's MacBook Pro\n")).toBe("Adam's MacBook Pro");
    expect(wireSafeMachineName("Mac‮Book​\x07Air")).toBe("MacBookAir");
    expect(wireSafeMachineName("work/home")).toBe("work-home");
    expect(wireSafeMachineName("..")).toBe("");
    expect(wireSafeMachineName(".")).toBe("");
    expect(wireSafeMachineName("x".repeat(40))).toBe("x".repeat(32));
    // The cap counts characters, not UTF-16 units, and leaves no trailing space.
    expect(wireSafeMachineName(`${"🍎".repeat(31)} b`)).toBe("🍎".repeat(31));
    expect(wireSafeMachineName("​ \n")).toBe("");
  });
});

describe("initializeMachineName", () => {
  test("is created once from the computer name, cleaned, and saved", async () => {
    const { deps, calls } = fakeDeps({ exitCode: 0, stdout: " MacBook Pro​\n" }, "ignored.local");
    expect(await initializeMachineName(deps)).toBe("macbook-pro");
    expect(calls).toEqual([["scutil", "--get", "ComputerName"]]);
    expect(await readFile(machineNameFile(), "utf-8")).toBe("macbook-pro\n");
  });

  test("the file wins: a later start does not run scutil, and a changed hostname changes nothing", async () => {
    await initializeMachineName(fakeDeps({ exitCode: 0, stdout: "First Name\n" }, "first.local").deps);
    const later = fakeDeps({ exitCode: 0, stdout: "Renamed Mac\n" }, "renamed.local");
    expect(await initializeMachineName(later.deps)).toBe("first-name");
    expect(later.calls).toEqual([]);
  });

  test("a saved display name reads as its clean form, and the file is not rewritten", async () => {
    await mkdir(dirname(machineNameFile()), { recursive: true });
    await writeFile(machineNameFile(), "MacBook Pro\n");
    const { deps, calls } = fakeDeps({ exitCode: 0, stdout: "Other\n" }, "other.local");
    expect(await initializeMachineName(deps)).toBe("macbook-pro");
    expect(await readMachineName()).toBe("macbook-pro");
    expect(calls).toEqual([]);
    expect(await readFile(machineNameFile(), "utf-8")).toBe("MacBook Pro\n");
  });

  test("falls back to the hostname without .local when scutil fails or exits non-zero", async () => {
    expect(await initializeMachineName(fakeDeps({ exitCode: 1, stdout: "" }, "studio.local").deps)).toBe("studio");
    await rm(machineNameFile());
    expect(await initializeMachineName(fakeDeps(new Error("ENOENT: scutil"), "Laptop Two.local").deps)).toBe("laptop-two");
    expect(await readFile(machineNameFile(), "utf-8")).toBe("laptop-two\n");
  });

  test("a computer name that cleans to nothing falls through to the hostname", async () => {
    const { deps, calls } = fakeDeps({ exitCode: 0, stdout: "山田\n" }, "Studio-Mac.local");
    expect(await initializeMachineName(deps)).toBe("studio-mac");
    expect(calls).toEqual([["scutil", "--get", "ComputerName"]]);
  });

  test("an empty computer name and hostname give the fallback name", async () => {
    expect(await initializeMachineName(fakeDeps({ exitCode: 0, stdout: "\n" }, ".local").deps)).toBe(FALLBACK_MACHINE_NAME);
    await rm(machineNameFile());
    expect(await initializeMachineName(fakeDeps({ exitCode: 0, stdout: "!!!\n" }, "山田.local").deps)).toBe(FALLBACK_MACHINE_NAME);
  });

  test("ib watch initializes a fresh home before exiting for an empty registry", async () => {
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "tmux"), "#!/bin/sh\nexit 1\n");
    await chmod(join(bin, "tmux"), 0o700);
    const result = await runIsolatedCli(["watch"], {
      home, env: { PATH: bin }, allowedProcesses: [["scutil", "--get", "ComputerName"]],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("No repos registered");
    expect(await readMachineName()).not.toBe("");
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

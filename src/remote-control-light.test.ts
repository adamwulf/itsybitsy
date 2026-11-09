import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readRemoteControlFiles, remoteControlDetail, remoteControlStatus, type RemoteControlFilesOptions,
} from "./remote-control-light";
import { resetUserHome, setUserHome } from "./home";
import { resetCoordinatorHome, setCoordinatorHome, systemCoordinatorSettingsPath } from "./coordinator";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A temp dir; never the real ~/.itsybitsy or ~/.claude. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "remote-control-light-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The settings file the way writeCoordinatorFiles() writes it, under a temp dir. */
async function settingsFile(disabled: boolean): Promise<string> {
  const path = join(await tempDir(), "settings.local.json");
  await writeFile(path, JSON.stringify({
    ...(disabled ? { disableRemoteControl: true } : {}),
    spinnerTipsEnabled: false,
    hooks: {},
  }, null, 2) + "\n");
  return path;
}

const configuredAs = (remoteControl: boolean): RemoteControlFilesOptions["loadSystemCoordinatorType"] =>
  async () => ({ remoteControl });

// --- Combining the files with the coordinator's state ------------------------

test("neither configured nor launched: hidden, no help lines", () => {
  const status = remoteControlStatus({ configured: false, settingsLaunched: false }, false);
  expect(status).toEqual({ light: null, state: "off" });
  expect(remoteControlDetail(status)).toEqual([]);
});

test("configured and launched: green", () => {
  const status = remoteControlStatus({ configured: true, settingsLaunched: true }, false);
  expect(status).toEqual({ light: "green", state: "on" });
  expect(remoteControlDetail(status)).toEqual(["on"]);
});

test("configured but launched with it off: yellow until a restart applies it", () => {
  const status = remoteControlStatus({ configured: true, settingsLaunched: false }, false);
  expect(status).toEqual({ light: "yellow", state: "pending-on" });
  expect(remoteControlDetail(status)).toEqual([
    "turned on in system-coordinator.md;", "restart the coordinator (R) to apply",
  ]);
});

test("launched with it on but no longer configured: yellow until a restart turns it off", () => {
  const status = remoteControlStatus({ configured: false, settingsLaunched: true }, false);
  expect(status).toEqual({ light: "yellow", state: "pending-off" });
  expect(remoteControlDetail(status)).toEqual([
    "turned off in system-coordinator.md;", "still on until the coordinator restarts (R)",
  ]);
});

test("a stopped coordinator is not launched, whatever its last settings file says", () => {
  for (const settingsLaunched of [true, false]) {
    const configured = remoteControlStatus({ configured: true, settingsLaunched }, true);
    expect(configured).toEqual({ light: "yellow", state: "stopped" });
    expect(remoteControlDetail(configured)).toEqual(["on in system-coordinator.md;", "coordinator stopped: start it (R)"]);
    expect(remoteControlStatus({ configured: false, settingsLaunched }, true)).toEqual({ light: null, state: "off" });
  }
});

test("every help line fits the about 48 columns free in the help panel", () => {
  for (const state of ["off", "on", "pending-on", "pending-off", "stopped"] as const) {
    for (const line of remoteControlDetail({ light: null, state })) expect(line.length).toBeLessThanOrEqual(48);
  }
});

// --- Reading the files --------------------------------------------------------

test("reads configured from the agent type and launched from the settings file", async () => {
  expect(await readRemoteControlFiles({ loadSystemCoordinatorType: configuredAs(true), settingsPath: await settingsFile(false) }))
    .toEqual({ configured: true, settingsLaunched: true });
  expect(await readRemoteControlFiles({ loadSystemCoordinatorType: configuredAs(false), settingsPath: await settingsFile(true) }))
    .toEqual({ configured: false, settingsLaunched: false });
});

test("only a literal disableRemoteControl: true counts as launched off", async () => {
  const path = join(await tempDir(), "settings.local.json");
  await writeFile(path, JSON.stringify({ disableRemoteControl: false }));
  expect(await readRemoteControlFiles({ loadSystemCoordinatorType: configuredAs(true), settingsPath: path }))
    .toEqual({ configured: true, settingsLaunched: true });
});

test("a missing settings file counts as not launched", async () => {
  const settingsPath = join(await tempDir(), "settings.local.json");
  expect(await readRemoteControlFiles({ loadSystemCoordinatorType: configuredAs(true), settingsPath }))
    .toEqual({ configured: true, settingsLaunched: false });
});

test("a settings file that does not parse to a JSON object counts as not launched", async () => {
  const dir = await tempDir();
  for (const [name, content] of [["bad.json", "{ not json"], ["empty.json", ""], ["null.json", "null"],
    ["array.json", "[]"], ["number.json", "1"]] as const) {
    const settingsPath = join(dir, name);
    await writeFile(settingsPath, content);
    expect((await readRemoteControlFiles({ loadSystemCoordinatorType: configuredAs(true), settingsPath })).settingsLaunched)
      .toBe(false);
  }
});

test("an unreadable settings path counts as not launched", async () => {
  const dir = await tempDir();
  // A directory where the file should be.
  const asDir = join(dir, "dir.json");
  await mkdir(asDir);
  expect((await readRemoteControlFiles({ loadSystemCoordinatorType: configuredAs(true), settingsPath: asDir })).settingsLaunched)
    .toBe(false);
  // A file without read permission (root reads it anyway, so check only as a user).
  if (process.getuid?.() !== 0) {
    const noRead = join(dir, "no-read.json");
    await writeFile(noRead, JSON.stringify({}));
    await chmod(noRead, 0o000);
    expect((await readRemoteControlFiles({ loadSystemCoordinatorType: configuredAs(true), settingsPath: noRead })).settingsLaunched)
      .toBe(false);
  }
});

test("a FIFO at the settings path is not read and does not block", async () => {
  const fifo = join(await tempDir(), "settings.local.json");
  expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0); // no writer, ever
  expect((await readRemoteControlFiles({ loadSystemCoordinatorType: configuredAs(true), settingsPath: fifo })).settingsLaunched)
    .toBe(false);
});

test("an agent type that fails to load counts as not configured", async () => {
  const failing = async () => { throw new Error("Type 'system-coordinator' inherits from unknown type 'gone'"); };
  expect(await readRemoteControlFiles({ loadSystemCoordinatorType: failing, settingsPath: await settingsFile(false) }))
    .toEqual({ configured: false, settingsLaunched: true });
});

test("a remoteControl that is not literally true counts as not configured", async () => {
  const loose = async () => ({ remoteControl: "true" as unknown as boolean });
  expect((await readRemoteControlFiles({ loadSystemCoordinatorType: loose, settingsPath: await settingsFile(true) })).configured)
    .toBe(false);
});

/** The real files under a temp home, through the home seams. */
async function withTempHome(fn: (itsybitsy: string) => Promise<void>): Promise<void> {
  const home = await tempDir();
  const itsybitsy = join(home, ".itsybitsy");
  await mkdir(join(itsybitsy, "agent-types"), { recursive: true });
  await mkdir(join(itsybitsy, ".claude"), { recursive: true });
  setUserHome(home);
  setCoordinatorHome(itsybitsy);
  try {
    await fn(itsybitsy);
  } finally {
    resetCoordinatorHome();
    resetUserHome();
  }
}

const systemCoordinatorMd = (frontmatter: string) =>
  `---\nname: system-coordinator\nspawnable: false\n${frontmatter}\n---\n\nSystem coordinator body.\n`;

test("by default it reads system-coordinator.md and the coordinator's own settings file", async () => {
  await withTempHome(async (itsybitsy) => {
    const typeFile = join(itsybitsy, "agent-types", "system-coordinator.md");
    const settingsPath = join(itsybitsy, ".claude", "settings.local.json");
    expect(systemCoordinatorSettingsPath()).toBe(settingsPath);

    await writeFile(typeFile, systemCoordinatorMd("remoteControl: true"));
    await writeFile(settingsPath, JSON.stringify({ spinnerTipsEnabled: false }));
    expect(await readRemoteControlFiles()).toEqual({ configured: true, settingsLaunched: true });

    // A restart rewrites the settings file; the next read sees the new one.
    await writeFile(settingsPath, JSON.stringify({ disableRemoteControl: true }));
    expect(await readRemoteControlFiles()).toEqual({ configured: true, settingsLaunched: false });

    await writeFile(typeFile, systemCoordinatorMd("remoteControl: false"));
    expect(await readRemoteControlFiles()).toEqual({ configured: false, settingsLaunched: false });
  });
});

test("by default a broken inherits: chain in system-coordinator.md counts as not configured", async () => {
  await withTempHome(async (itsybitsy) => {
    await writeFile(join(itsybitsy, "agent-types", "system-coordinator.md"),
      systemCoordinatorMd("remoteControl: true\ninherits: no-such-parent"));
    await writeFile(join(itsybitsy, ".claude", "settings.local.json"), JSON.stringify({}));
    expect(await readRemoteControlFiles()).toEqual({ configured: false, settingsLaunched: true });
  });
});

test("by default a missing system-coordinator.md counts as not configured", async () => {
  await withTempHome(async () => {
    expect(await readRemoteControlFiles()).toEqual({ configured: false, settingsLaunched: false });
  });
});

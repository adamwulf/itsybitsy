import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { processStartEpochSecondsCtx } from "../agents";
import { resetUserHome, setUserHome } from "../home";
import { IB_VERSION } from "../ib-version";
import { peerDir } from "../runtime-names";
import { createCliFixture, type CliFixture } from "../test-cli-runner";
import {
  clockComparison, defaultExportLogsDeps, EXPORT_FILE, exportLogs, machineDirName, runExportLogs, type ExportLogsDeps,
} from "./export-logs";
import { irohAddonLoaderCtx } from "./iroh";
import { requestWatchLog, serveTrustedConnection } from "./peer-link";
import { createPeerOutboxPoll } from "./peer-outbox";
import { addPeer, type Peer } from "./store";
import { createFakeClock, createMemoryLink } from "./test-pair-transport";
import { encodeWatchLogOutput, readWatchLogFiles, type PeerWatchLog } from "./watch-log-files";

const ID_SELF = "ab".repeat(32);
const ID_LAPTOP = "c1".repeat(32);
const ID_OLD = "d2".repeat(32);
const T = 1_800_000_000_000;
const LAPTOP: Peer = { id: ID_LAPTOP, name: "adam's laptop", pairedAt: "2026-11-01T00:00:00.000Z" };
const OLD: Peer = { id: ID_OLD, name: "old laptop", pairedAt: "2026-11-02T00:00:00.000Z" };

const text = (body: string) => Buffer.from(body);

function laptopCopy(): PeerWatchLog {
  return {
    name: "adams-laptop", version: "0.1.3", now: T + 400, sentAt: T, headerAt: T + 200, doneAt: T + 300,
    files: [{ name: "watch.log", body: text("remote\n") }, { name: "watch.log.1", body: text("older\n") }],
  };
}

describe("exportLogs", () => {
  let root: string;
  let out: string[];
  let err: string[];
  let fetched: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ib-export-logs-"));
    out = [];
    err = [];
    fetched = [];
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function fakeDeps(overrides: Partial<ExportLogsDeps> = {}): ExportLogsDeps {
    return {
      readPeers: async () => [LAPTOP, OLD],
      machineName: async () => "desk",
      selfId: async () => ID_SELF,
      readLocalFiles: async () => [{ name: "watch.log", body: text("local\n") }],
      watcherRunning: async () => true,
      fetch: async (peer) => {
        fetched.push(peer.id);
        return peer.id === ID_LAPTOP
          ? { ok: true, exitCode: 0, stdout: encodeWatchLogOutput(laptopCopy()), stderr: "" }
          : { ok: false, exitCode: 1, stdout: "", stderr: 'the peer replied: unknown op "watch-log"' };
      },
      now: () => T,
      exportsRoot: () => join(root, "log-exports"),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      ...overrides,
    };
  }

  const exportDir = () => out[0]!.replace(/^Exported to /, "");
  const read = (...path: string[]) => readFile(join(exportDir(), ...path), "utf8");

  test("copies this machine's files and each peer's into one directory, with facts in export.txt", async () => {
    expect(await runExportLogs([], fakeDeps())).toBe(1);
    expect(basename(exportDir())).toMatch(/^\d{8}T\d{6}Z$/);
    expect(exportDir().startsWith(join(root, "log-exports"))).toBe(true);
    expect(out.slice(1)).toEqual([
      "desk (this machine): 1 file, 0.0 MB",
      "adam's laptop: 2 files, 0.0 MB",
      'old laptop: not fetched: the peer replied: unknown op "watch-log"',
    ]);
    expect(err).toEqual([]);
    expect(await readdir(exportDir())).toEqual(expect.arrayContaining(["adam-s-laptop", "desk", EXPORT_FILE]));
    expect(await readdir(exportDir())).toHaveLength(3);
    expect(await read("desk", "watch.log")).toBe("local\n");
    expect(await read("adam-s-laptop", "watch.log")).toBe("remote\n");
    expect(await read("adam-s-laptop", "watch.log.1")).toBe("older\n");
    expect((await stat(join(exportDir(), "adam-s-laptop"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(exportDir(), "adam-s-laptop", "watch.log"))).mode & 0o777).toBe(0o600);
    expect(await read(EXPORT_FILE)).toBe([
      `ib export-logs, started ${new Date(T).toISOString()} (this machine's clock)`,
      "",
      "machine: desk (this machine)",
      `id: ${ID_SELF}`,
      `ib version: ${IB_VERSION}`,
      `copied at: ${new Date(T).toISOString()}`,
      "directory: desk/",
      "  watch.log    6 bytes",
      "",
      "machine: adam's laptop (paired peer)",
      `id: ${ID_LAPTOP}`,
      "machine name it reports: adams-laptop",
      "ib version: 0.1.3",
      `copied at: ${new Date(T + 400).toISOString()} (its clock)`,
      `request sent at: ${new Date(T).toISOString()} (this machine's clock)`,
      `reply header received at: ${new Date(T + 200).toISOString()} (this machine's clock)`,
      `reply complete at: ${new Date(T + 300).toISOString()} (this machine's clock)`,
      "peer clock − local clock: +0.300 s (± 0.100 s)",
      "directory: adam-s-laptop/",
      "  watch.log    7 bytes",
      "  watch.log.1  6 bytes",
      "",
      "machine: old laptop (paired peer)",
      `id: ${ID_OLD}`,
      'not fetched: the peer replied: unknown op "watch-log"',
      "",
    ].join("\n"));
  });

  test("every peer fetched: exit 0", async () => {
    expect(await runExportLogs([], fakeDeps({ readPeers: async () => [LAPTOP] }))).toBe(0);
  });

  test("without ib watch, this machine is still copied and each peer says why", async () => {
    expect(await runExportLogs([], fakeDeps({ watcherRunning: async () => false }))).toBe(1);
    expect(fetched).toEqual([]);
    expect(out.slice(1)).toEqual([
      "desk (this machine): 1 file, 0.0 MB",
      "adam's laptop: not fetched: ib watch is not running on this machine",
      "old laptop: not fetched: ib watch is not running on this machine",
    ]);
    expect(await read("desk", "watch.log")).toBe("local\n");
    expect(await read(EXPORT_FILE)).toContain("not fetched: ib watch is not running on this machine");
  });

  test("no paired peers: this machine alone, exit 0, and ib watch is not asked", async () => {
    let asked = false;
    expect(await runExportLogs([], fakeDeps({ readPeers: async () => [], watcherRunning: async () => { asked = true; return false; } }))).toBe(0);
    expect(asked).toBe(false);
    expect(out.slice(1)).toEqual(["desk (this machine): 1 file, 0.0 MB"]);
  });

  test("a machine with no watch log says so", async () => {
    expect(await runExportLogs([], fakeDeps({ readPeers: async () => [], readLocalFiles: async () => [] }))).toBe(0);
    expect(out.slice(1)).toEqual(["desk (this machine): 0 files, 0.0 MB"]);
    expect(await read(EXPORT_FILE)).toContain("directory: desk/ (no watch log files)");
  });

  test.each([["ADAM'S LAPTOP", ID_LAPTOP], [ID_OLD.toUpperCase(), ID_OLD]])("<machine> %s is the only peer fetched", async (machine, id) => {
    await runExportLogs([machine], fakeDeps());
    expect(fetched).toEqual([id]);
  });

  test("an unknown or shared machine name fails before anything is written", async () => {
    expect(await runExportLogs(["nobody"], fakeDeps())).toBe(1);
    expect(err).toEqual(['Error: no paired peer has the name or id "nobody"']);
    const twins = [{ ...LAPTOP, name: "twin" }, { ...OLD, name: "Twin" }];
    expect(await runExportLogs(["twin"], fakeDeps({ readPeers: async () => twins }))).toBe(1);
    expect(err[1]).toBe(`Error: 2 peers are named "twin"; use the full id: ${ID_LAPTOP}, ${ID_OLD}`);
    expect(out).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  test("an unreadable peers.json still copies this machine and fails", async () => {
    expect(await runExportLogs([], fakeDeps({ readPeers: async () => { throw new Error("peers.json: not valid JSON"); } }))).toBe(1);
    expect(out.slice(1)).toEqual(["desk (this machine): 1 file, 0.0 MB", "paired peers: not read: peers.json: not valid JSON"]);
    expect(await read(EXPORT_FILE)).toContain("paired peers: not read: peers.json: not valid JSON");
  });

  test("a missing machine name is recorded, and the copy is still written", async () => {
    const deps = fakeDeps({ readPeers: async () => [], machineName: async () => { throw new Error("Machine name is missing at /x. Start ib watch to initialize it."); } });
    expect(await runExportLogs([], deps)).toBe(0);
    expect(out.slice(1)).toEqual(["this machine: 1 file, 0.0 MB"]);
    expect(await read("this-machine", "watch.log")).toBe("local\n");
    expect(await read(EXPORT_FILE)).toContain("machine: this machine\nmachine name: unknown (Machine name is missing at /x. Start ib watch to initialize it.)\n");
  });

  test("--out is created when missing and refused when not empty", async () => {
    const given = join(root, "given", "dir");
    expect(await runExportLogs(["--out", given], fakeDeps({ readPeers: async () => [] }))).toBe(0);
    expect(out[0]).toBe(`Exported to ${given}`);
    expect(await readFile(join(given, "desk", "watch.log"), "utf8")).toBe("local\n");
    expect(await runExportLogs([`--out=${given}`], fakeDeps({ readPeers: async () => [] }))).toBe(1);
    expect(err).toEqual([`Error: ${given} is not empty`]);
  });

  test("two exports in the same second get separate directories", async () => {
    await runExportLogs([], fakeDeps({ readPeers: async () => [] }));
    await runExportLogs([], fakeDeps({ readPeers: async () => [] }));
    const dirs = out.filter((line) => line.startsWith("Exported to ")).map((line) => basename(line));
    expect(dirs[1]).toBe(`${dirs[0]}-2`);
  });

  test.each([
    [["a", "b"], "at most one machine"],
    [["--out"], "--out needs a directory"],
    [["--since", "24h"], "unknown option '--since'"],
  ])("%j is a usage error", async (args, message) => {
    expect(await runExportLogs(args, fakeDeps())).toBe(1);
    expect(err[0]).toContain(message);
    expect(err[1]).toBe("Usage: ib export-logs [<machine>] [--out <dir>]");
  });

  test("Ctrl-C stops a pending fetch, which is reported, and the export is still written", async () => {
    const controller = new AbortController();
    const deps = fakeDeps({
      readPeers: async () => [LAPTOP],
      fetch: (_peer, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ ok: false, exitCode: 130, stdout: "", stderr: "outcome unknown — check adam's laptop" }), { once: true });
        controller.abort();
      }),
    });
    expect(await exportLogs({}, deps, controller.signal)).toBe(1);
    expect(out.at(-1)).toBe("adam's laptop: not fetched: interrupted");
    expect(await read(EXPORT_FILE)).toContain("not fetched: interrupted");
  });
});

describe("machineDirName", () => {
  test("keeps a name safe and distinct", () => {
    const taken = new Set([EXPORT_FILE]);
    expect(machineDirName("adam's laptop", ID_LAPTOP, taken)).toBe("adam-s-laptop");
    expect(machineDirName("../../etc", ID_OLD, taken)).toBe("etc");
    expect(machineDirName("...", ID_SELF, taken)).toBe(ID_SELF.slice(0, 10));
    expect(machineDirName("export.txt", ID_OLD, taken)).toBe(`export.txt-${ID_OLD.slice(0, 10)}`);
    expect(machineDirName("desk", null, taken)).toBe("desk");
    expect(machineDirName("Desk", ID_LAPTOP, taken)).toBe(`Desk-${ID_LAPTOP.slice(0, 10)}`);
    expect(machineDirName("Desk", ID_LAPTOP, taken)).toBe("Desk-2");
  });
});

test("clockComparison bounds the difference by half the round trip", () => {
  expect(clockComparison({ now: T - 250, sentAt: T, headerAt: T + 100 })).toBe("peer clock − local clock: -0.300 s (± 0.050 s)");
  expect(clockComparison({ now: T, sentAt: T, headerAt: T })).toBe("peer clock − local clock: +0.000 s (± 0.000 s)");
});

describe("ib export-logs end to end, against fakes", () => {
  let home: string;
  let loads: number;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ib-export-logs-e2e-"));
    setUserHome(home);
    processStartEpochSecondsCtx.set(() => 100);
    loads = 0;
    irohAddonLoaderCtx.set(async () => {
      loads++;
      throw new Error("ib export-logs must not load the iroh addon");
    });
  });
  afterEach(async () => {
    irohAddonLoaderCtx.reset();
    processStartEpochSecondsCtx.reset();
    resetUserHome();
    await rm(home, { recursive: true, force: true });
  });

  test("the CLI's request goes through the outbox and the trusted link, and the addon is never loaded", async () => {
    await addPeer({ id: ID_LAPTOP, name: "adam's laptop" });
    await writeFile(join(home, ".itsybitsy", "machine-name"), "desk\n");
    await writeFile(join(home, "watch.log"), "local line\n");
    // A live endpoint owner: this test process, standing in for ib watch.
    await Bun.write(join(peerDir(), "endpoint.lock"), String(process.pid));
    const { a, b } = createMemoryLink(ID_SELF, ID_LAPTOP);
    const responder = serveTrustedConnection(b, {
      peerName: async () => "desk", setTimer: createFakeClock().setTimer, log: () => {},
      snapshot: () => ({ repos: [], agents: [], coordinator: null, questions: [] }),
      readWatchLog: async () => ({ name: "adams-laptop", version: "7.7.7", files: [{ name: "watch.log", body: text("remote line\n") }] }),
    });
    const poll = createPeerOutboxPoll();
    let done = false;
    const watcher = (async () => {
      while (!done) {
        await poll(async () => "", () => {}, undefined, undefined, undefined,
          (_peer, transfer) => requestWatchLog(a, createFakeClock().setTimer, transfer.signal).then(encodeWatchLogOutput));
        await Bun.sleep(20);
      }
    })();
    const out: string[] = [];
    try {
      const code = await runExportLogs([], {
        ...defaultExportLogsDeps(),
        readLocalFiles: () => readWatchLogFiles(join(home, "watch.log")),
        stdout: (line) => out.push(line),
      });
      expect(out.slice(1)).toEqual(["desk (this machine): 1 file, 0.0 MB", "adam's laptop: 1 file, 0.0 MB"]);
      expect(code).toBe(0);
      const dir = out[0]!.replace(/^Exported to /, "");
      expect(dir.startsWith(join(home, ".itsybitsy", "log-exports"))).toBe(true);
      expect(await readFile(join(dir, "desk", "watch.log"), "utf8")).toBe("local line\n");
      expect(await readFile(join(dir, "adam-s-laptop", "watch.log"), "utf8")).toBe("remote line\n");
      const report = await readFile(join(dir, EXPORT_FILE), "utf8");
      expect(report).toContain("machine name it reports: adams-laptop\nib version: 7.7.7\n");
      expect(report).toContain("id: none (");
      expect(report).toMatch(/peer clock − local clock: [+-]\d+\.\d{3} s \(± \d+\.\d{3} s\)/);
    } finally {
      done = true;
      await watcher;
      a.close(0, "done");
      await responder;
    }
    expect(loads).toBe(0);
  });
});

describe("ib export-logs (CLI)", () => {
  let cli: CliFixture;

  beforeAll(async () => {
    cli = await createCliFixture();
  });
  afterAll(async () => {
    await cli.cleanup();
  });
  beforeEach(async () => {
    setUserHome(cli.home);
    await rm(peerDir(), { recursive: true, force: true });
    await rm(join(cli.home, ".itsybitsy", "log-exports"), { recursive: true, force: true });
    await writeFile(join(cli.home, ".itsybitsy", "machine-name"), "desk\n");
    await writeFile(join(cli.home, ".itsybitsy", "watch.log"), "seeded line\n");
  });
  afterEach(() => {
    resetUserHome();
  });

  test("with no paired peers it copies this machine's watch log and exits 0", async () => {
    const result = await cli.run(["export-logs"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const [first, second] = result.stdout.trimEnd().split("\n");
    expect(first).toMatch(new RegExp(`^Exported to ${join(cli.home, ".itsybitsy", "log-exports")}/\\d{8}T\\d{6}Z$`));
    expect(second).toMatch(/^desk \(this machine\): 1 file, \d+\.\d MB$/);
    const dir = first!.replace(/^Exported to /, "");
    expect(await readFile(join(dir, "desk", "watch.log"), "utf8")).toContain("seeded line\n");
    expect(await readFile(join(dir, EXPORT_FILE), "utf8")).toContain("machine: desk (this machine)\n");
  });

  test("without ib watch a paired peer is not fetched, and it exits 1", async () => {
    await addPeer({ id: ID_LAPTOP, name: "adam's laptop" });
    const result = await cli.run(["export-logs"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("adam's laptop: not fetched: ib watch is not running on this machine\n");
  });

  test("an unknown machine is an error", async () => {
    const result = await cli.run(["export-logs", "nobody"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no paired peer has the name or id "nobody"');
  });

  test("--help prints the usage", async () => {
    const result = await cli.run(["export-logs", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: ib export-logs [<machine>] [--out <dir>]");
  });
});

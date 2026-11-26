import { describe, expect, test } from "bun:test";
import {
  EVENT_TEXT,
  MAX_PMSET_ENTRIES,
  SYSTEM_EVENTS_SCRIPT,
  SystemEventMonitor,
  formatSleepDuration,
  pmsetSleepWakeEntries,
  summarizeAssertions,
  summarizePowerSource,
  type SystemEventHelper,
} from "./system-events";
import { isSandboxedProcess } from "./sandbox-detect";

// Trimmed from a real `pmset -g assertions` (macOS, 2026-11-25).
const ASSERTIONS = `2026-11-25 19:40:02 -0600
Assertion status system-wide:
   BackgroundTask                 0
   UserIsActive                   1
   PreventUserIdleDisplaySleep    0
   PreventSystemSleep             1
   PreventUserIdleSystemSleep     1
   NetworkClientActive            0
Listed by owning process:
   pid 483(WindowServer): [0x000c2aa000099366] 00:00:09 UserIsActive named: "com.apple.iohideventsystem.queue.tickle"
	Timeout will fire in 591 secs Action=TimeoutActionRelease
   pid 1286(caffeinate): [0x000000ab00018407] 223:35:24 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
	Details: caffeinate asserting forever
	Localized=THE CAFFEINATE TOOL IS PREVENTING SLEEP.
   pid 1286(caffeinate): [0x000000ab00078408] 223:35:24 PreventSystemSleep named: "caffeinate command-line tool"
	Details: caffeinate asserting forever
   pid 38567(caffeinate): [0x000c2d0a000196a2] 00:03:38 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
	Details: caffeinate asserting for 300 secs
   pid 426(powerd): [0x000c2d26000196ba] 00:03:10 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
Kernel Assertions: 0x100=MAGICWAKE
   id=556  level=255 0x100=MAGICWAKE creat=  mod= description=en0 owner=IOSkywalkNetworkBSDClient
Idle sleep preventers: IODisplayWrangler
`;

const BATT = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=27918435)\t100%; charged; 0:00 remaining present: true\n";

// Real `pmset -g log` lines (columns padded with spaces, then a tab).
const PMSET_LOG = [
  "2026-11-22 16:29:40 -0600 Assertions          \tPID 1286(caffeinate) Summary PreventUserIdleSystemSleep \"caffeinate command-line tool\" 55:42:43  id:0x0x100008407 [System: PrevIdle]",
  "2026-11-22 16:29:47 -0600 Sleep               \tEntering Sleep state due to 'Low Power Sleep':TCPKeepAlive=inactive Using Batt (Charge:1%) 6938 secs ",
  "2026-11-22 16:29:49 -0600 Wake Requests       \t[*process=dasd request=SleepService deltaSecs=983]",
  "2026-11-22 17:01:00 -0600 DarkWake            \tDarkWake from Deep Idle [CDN] : due to RTC/Maintenance Using Batt (Charge:1%)          ",
  "2026-11-22 18:25:25 -0600 Wake                \tWake from Hibernate [CDNVA] : due to acattach/UserActivity Assertion Using AC (Charge:1%)           ",
  "2026-11-22 18:25:25 -0600 WakeDetails         \tDriverReason:acattach - DriverDetails:",
  "2026-11-22 18:25:26 -0600 Notification        \tDisplay is turned on",
].join("\n");

describe("summarizeAssertions", () => {
  test("lists non-zero counts, groups holders by process and type, and keeps kernel lines", () => {
    expect(summarizeAssertions(ASSERTIONS)).toBe(
      "UserIsActive=1 PreventSystemSleep=1 PreventUserIdleSystemSleep=1; " +
      "held by WindowServer UserIsActive (00:00:09), " +
      "caffeinate PreventUserIdleSystemSleep x2 (longest 223:35:24), " +
      "caffeinate PreventSystemSleep (223:35:24), " +
      "powerd PreventUserIdleSystemSleep (00:03:10); " +
      "kernel: 0x100=MAGICWAKE; idle sleep preventers: IODisplayWrangler",
    );
  });

  test("says none when nothing is asserted", () => {
    expect(summarizeAssertions("Assertion status system-wide:\n   PreventSystemSleep             0\nListed by owning process:\n")).toBe("none");
  });
});

describe("summarizePowerSource", () => {
  test("reads the source and battery", () => {
    expect(summarizePowerSource(BATT)).toBe("AC Power, battery 100% charged");
    expect(summarizePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t45%; discharging; 3:10 remaining present: true\n"))
      .toBe("Battery Power, battery 45% discharging");
  });

  test("a Mac without a battery has only the source; garbage gives nothing", () => {
    expect(summarizePowerSource("Now drawing from 'AC Power'\n")).toBe("AC Power");
    expect(summarizePowerSource("")).toBe("");
  });
});

describe("pmsetSleepWakeEntries", () => {
  test("keeps only Sleep, Wake and DarkWake, collapses whitespace", () => {
    expect(pmsetSleepWakeEntries(PMSET_LOG, 0).map((e) => e.line)).toEqual([
      "2026-11-22 16:29:47 -0600 Sleep Entering Sleep state due to 'Low Power Sleep':TCPKeepAlive=inactive Using Batt (Charge:1%) 6938 secs",
      "2026-11-22 17:01:00 -0600 DarkWake DarkWake from Deep Idle [CDN] : due to RTC/Maintenance Using Batt (Charge:1%)",
      "2026-11-22 18:25:25 -0600 Wake Wake from Hibernate [CDNVA] : due to acattach/UserActivity Assertion Using AC (Charge:1%)",
    ]);
  });

  test("parses the offset and skips entries at or before the cutoff", () => {
    const sleepAt = Date.parse("2026-11-22T22:29:47Z");
    const entries = pmsetSleepWakeEntries(PMSET_LOG, sleepAt);
    expect(entries.map((e) => e.line.split(" ")[3])).toEqual(["DarkWake", "Wake"]);
    expect(entries[0]!.at).toBe(Date.parse("2026-11-22T23:01:00Z"));
  });
});

test("formatSleepDuration", () => {
  expect(formatSleepDuration(65_400)).toBe("65s");
  expect(formatSleepDuration(725_000)).toBe("12m5s");
  expect(formatSleepDuration(8 * 3_600_000 + 3 * 60_000)).toBe("8h3m");
});

/** A helper whose stdout, stderr and exit the test drives. */
function fakeHelper() {
  const encoder = new TextEncoder();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  const killed: number[] = [];
  const helper: SystemEventHelper = {
    stdout: new ReadableStream({ start(c) { out = c; } }),
    stderr: new ReadableStream({ start(c) { err = c; } }),
    exited: new Promise((resolve) => { exit = resolve; }),
    kill: () => { killed.push(1); },
  };
  return {
    helper,
    killed,
    print: (line: string) => out.enqueue(encoder.encode(`${line}\n`)),
    printErr: (text: string) => err.enqueue(encoder.encode(text)),
    closeErr: () => err.close(),
    /** Resolve the exit without closing the pipes. */
    exitOnly: (code: number) => exit(code),
    exit: (code: number) => {
      out.close();
      err.close();
      exit(code);
    },
  };
}

function setup(opts: { pmsetLog?: string; startAt?: number } = {}) {
  const lines: string[] = [];
  const runs: string[] = [];
  let clock = opts.startAt ?? Date.parse("2026-11-22T22:00:00Z");
  const fake = fakeHelper();
  let spawned = 0;
  const monitor = new SystemEventMonitor({
    log: (line) => lines.push(line),
    spawnHelper: () => { spawned++; return fake.helper; },
    run: async (cmd) => {
      runs.push(cmd.join(" "));
      if (cmd[2] === "assertions") return ASSERTIONS;
      if (cmd[2] === "batt") return BATT;
      if (cmd[2] === "log") return opts.pmsetLog ?? PMSET_LOG;
      throw new Error(`unexpected ${cmd.join(" ")}`);
    },
    now: () => clock,
    platform: "darwin",
  });
  const settle = async () => {
    await Bun.sleep(5);
    await monitor.idle();
  };
  return {
    monitor, fake, lines, runs, settle,
    spawned: () => spawned,
    advance: (ms: number) => { clock += ms; },
  };
}

const ASSERTION_LINE = "held by WindowServer UserIsActive";

describe("SystemEventMonitor", () => {
  test("logs the start state with an assertions snapshot", async () => {
    const t = setup();
    t.monitor.start();
    t.fake.print("ready unlocked");
    await t.settle();
    expect(t.lines.slice(0, 2)).toEqual(["system: listening", "system: keychain at start: unlocked"]);
    expect(t.lines[2]).toStartWith("system: power assertions (start): UserIsActive=1 PreventSystemSleep=1 PreventUserIdleSystemSleep=1; ");
    expect(t.lines[2]).toContain(ASSERTION_LINE);
    expect(t.lines[2]).toEndWith("; power: AC Power, battery 100% charged");
    expect(t.lines).toHaveLength(3);
  });

  test("display sleep and wake log the event and a snapshot", async () => {
    const t = setup();
    t.monitor.start();
    t.fake.print("event display-sleep");
    await t.settle();
    t.fake.print("event display-wake");
    await t.settle();
    expect(t.lines[0]).toBe("system: display sleep");
    expect(t.lines[1]).toStartWith("system: power assertions (display sleep): ");
    expect(t.lines[2]).toBe("system: display wake");
    expect(t.lines[3]).toStartWith("system: power assertions (display wake): ");
  });

  test("a wake logs the sleep length, a snapshot and the new pmset entries once", async () => {
    // Started before the DarkWake, so the earlier Sleep entry is not copied.
    const t = setup({ startAt: Date.parse("2026-11-22T22:30:00Z") });
    t.monitor.start();
    t.fake.print("event will-sleep");
    await t.settle();
    t.advance(65_000);
    t.fake.print("event did-wake");
    await t.settle();
    expect(t.lines[0]).toBe("system: will sleep");
    expect(t.lines[1]).toBe("system: woke (slept ~65s)");
    expect(t.lines.slice(2).filter((l) => l.startsWith("system: power assertions (woke): "))).toHaveLength(1);
    expect(t.lines.filter((l) => l.startsWith("system: pmset: "))).toEqual([
      "system: pmset: 2026-11-22 17:01:00 -0600 DarkWake DarkWake from Deep Idle [CDN] : due to RTC/Maintenance Using Batt (Charge:1%)",
      "system: pmset: 2026-11-22 18:25:25 -0600 Wake Wake from Hibernate [CDNVA] : due to acattach/UserActivity Assertion Using AC (Charge:1%)",
    ]);

    // A second wake with no will-sleep seen: no duration, nothing recopied.
    t.lines.length = 0;
    t.fake.print("event did-wake");
    await t.settle();
    expect(t.lines[0]).toBe("system: woke");
    expect(t.lines.filter((l) => l.startsWith("system: pmset: "))).toEqual([]);
  });

  test("copies at most MAX_PMSET_ENTRIES: the first (the sleep reason) and the newest", async () => {
    const base = Date.parse("2026-11-23T00:00:00Z");
    const log = Array.from({ length: MAX_PMSET_ENTRIES + 3 }, (_, i) => {
      const at = new Date(base + i * 60_000);
      const stamp = `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 19)} +0000`;
      return `${stamp} DarkWake            \tDarkWake ${i}`;
    }).join("\n");
    const t = setup({ pmsetLog: log, startAt: base - 1 });
    t.monitor.start();
    t.fake.print("event did-wake");
    await t.settle();
    const pmset = t.lines.filter((l) => l.startsWith("system: pmset: "));
    expect(pmset[0]).toEndWith("DarkWake DarkWake 0");
    expect(pmset[1]).toBe("system: pmset: 3 entries not shown");
    expect(pmset[2]).toEndWith("DarkWake DarkWake 4");
    expect(pmset).toHaveLength(MAX_PMSET_ENTRIES + 1);
    expect(pmset.at(-1)).toEndWith(`DarkWake DarkWake ${MAX_PMSET_ENTRIES + 2}`);
  });

  test("plain events, keychain changes, and unknown lines", async () => {
    const t = setup();
    t.monitor.start();
    for (const line of [
      "event screen-locked", "event screen-unlocked", "event screensaver-started", "event screensaver-stopped",
      "event session-inactive", "event session-active", "event power-off", "keychain locked", "keychain unlocked",
      "event something-new", "event toString", "garbage",
    ]) t.fake.print(line);
    await t.settle();
    expect(t.lines).toEqual([
      "system: screen locked", "system: screen unlocked", "system: screensaver started", "system: screensaver stopped",
      "system: session inactive", "system: session active", "system: power off requested",
      "system: keychain locked", "system: keychain unlocked",
    ]);
    expect(t.runs).toEqual([]);
  });

  test("an unexpected helper exit is logged with its stderr", async () => {
    const t = setup();
    t.monitor.start();
    t.fake.printErr("execution error: boom (-2700)\n");
    await t.settle();
    t.fake.exit(1);
    await t.settle();
    expect(t.lines).toEqual(["system: listener stopped (exit 1): execution error: boom (-2700)"]);
  });

  test("the exit line waits for stderr that arrives after the exit", async () => {
    const t = setup();
    t.monitor.start();
    t.fake.exitOnly(1);
    await Bun.sleep(5);
    t.fake.printErr("execution error: late (-2700)\n");
    t.fake.closeErr();
    await t.settle();
    expect(t.lines).toEqual(["system: listener stopped (exit 1): execution error: late (-2700)"]);
  });

  test("the exit line does not wait forever for a stderr that never closes", async () => {
    const t = setup();
    t.monitor.start();
    t.fake.exitOnly(1);
    await Bun.sleep(700);
    expect(t.lines).toEqual(["system: listener stopped (exit 1)"]);
  });

  test("stop() kills the helper and silences later lines", async () => {
    const t = setup();
    t.monitor.start();
    t.fake.print("event display-sleep");
    t.monitor.stop();
    expect(t.fake.killed).toHaveLength(1);
    t.fake.exit(143);
    await t.settle();
    expect(t.lines).toEqual([]);
  });

  test("start() is a no-op off macOS and the second time", () => {
    const off = new SystemEventMonitor({ log: () => {}, spawnHelper: () => { throw new Error("spawned"); }, platform: "linux" });
    off.start();
    const t = setup();
    t.monitor.start();
    t.monitor.start();
    expect(t.spawned()).toBe(1);
  });

  test("a failed spawn logs one line", () => {
    const lines: string[] = [];
    const monitor = new SystemEventMonitor({
      log: (l) => lines.push(l),
      spawnHelper: () => { throw new Error("ENOENT osascript"); },
      platform: "darwin",
    });
    monitor.start();
    expect(lines).toEqual(["system: listener failed to start: ENOENT osascript"]);
  });
});

test("every label the script prints has an EVENT_TEXT entry, and the reverse", () => {
  // The NSWorkspace events cannot be triggered in a test, so this is the
  // only check that a label is not misspelled on one side.
  const labels: string[] = [];
  for (const map of ["WORKSPACE", "DISTRIBUTED"]) {
    const body = new RegExp(`var ${map} = \\{([^}]*)\\};`).exec(SYSTEM_EVENTS_SCRIPT)?.[1];
    expect(body).toBeDefined();
    for (const m of body!.matchAll(/: '([a-z-]+)'/g)) labels.push(m[1]!);
  }
  expect(labels.sort()).toEqual(Object.keys(EVENT_TEXT).sort());
});

const realHelper = process.platform === "darwin" && !isSandboxedProcess();

// The production spawn: the helper stays up (its stdin pipe stays open) and
// reports in, through the same defaultSpawnHelper ib watch uses.
test.skipIf(!realHelper)("the default helper starts, stays up, and stops", async () => {
  const lines: string[] = [];
  const monitor = new SystemEventMonitor({ log: (l) => lines.push(l), run: async () => "" });
  try {
    monitor.start();
    const deadline = Date.now() + 10_000;
    while (!lines.includes("system: listening") && Date.now() < deadline) await Bun.sleep(20);
    expect(lines.slice(0, 2)).toEqual(["system: listening", expect.stringMatching(/^system: keychain at start: (locked|unlocked|unknown)$/)]);
    await Bun.sleep(500);
    expect(lines.filter((l) => l.includes("listener stopped"))).toEqual([]);
  } finally {
    monitor.stop();
  }
}, 15_000);

// The real helper: it compiles under osascript, reports the keychain state,
// and exits as soon as its stdin closes (how it dies with ib watch).
test.skipIf(!realHelper)("the osascript helper starts and exits on stdin EOF", async () => {
  const proc = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", SYSTEM_EVENTS_SCRIPT], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = proc.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toMatch(/^ready (locked|unlocked|unknown)\n$/);
    reader.releaseLock();
    proc.stdin.end();
    const code = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout")]);
    expect(code).toBe(0);
  } finally {
    proc.kill();
  }
}, 15_000);

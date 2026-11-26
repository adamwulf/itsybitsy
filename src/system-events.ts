/**
 * macOS system events in watch.log (SPEC.md §8.15), so connection and auth
 * problems can be lined up with what the machine was doing.
 *
 * `ib watch` runs one helper, `osascript -l JavaScript` with the ObjC bridge
 * (no compiled binary, no permission prompt), that observes:
 *  - NSWorkspace: will sleep, did wake, screens did sleep / wake (display
 *    sleep), session resigned / became active (fast user switching), and
 *    will power off (logout, restart or shutdown, which look the same);
 *  - distributed notifications: com.apple.screenIsLocked / screenIsUnlocked
 *    and com.apple.screensaver.didstart / didstop;
 *  - the default keychain's lock state, polled every 10 s with
 *    SecKeychainGetStatus, which never shows a prompt.
 * The helper prints one line per event and this module writes it to watch.log
 * as `system: ...`. At start, on display sleep and wake, and after a system
 * wake, it also logs one line summarising `pmset -g assertions` and `pmset -g batt`
 * (is caffeinate still holding an assertion, is the machine on battery).
 * After a system wake it copies the Sleep, Wake and DarkWake entries that
 * `pmset -g log` gained since its last read, which give the sleep reason
 * (Idle, Clamshell, Low Power, Maintenance...) and each dark wake.
 *
 * Not captured: login (ib watch is not running yet), dark wakes as they
 * happen (only in the pmset lines after the next full wake), and other
 * processes' keychain access failures (only `log stream` sees those, and it
 * costs too much CPU to run all the time, see docs/SANDBOX-SHARED-COLLECTOR.md
 * §8).
 *
 * The helper exits when its stdin reaches EOF, so it dies with ib watch even
 * after a crash or SIGKILL. Like watch-log.ts, nothing here throws: a failed
 * spawn or pmset run logs one line (a failed `pmset -g batt` only drops the
 * power source from its snapshot) and the dashboard carries on.
 */

/**
 * The helper, run as `osascript -l JavaScript -e <script>`. Output lines:
 * `ready <locked|unlocked|unknown>` once, `event <name>` per notification,
 * and `keychain <state>` when the lock state changes. JXA's console.log
 * writes to stderr, so lines go through NSFileHandle stdout instead. A JXA
 * NSData `length` comes back as a string, hence the Number() calls.
 */
export const SYSTEM_EVENTS_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Security');
ObjC.import('stdlib');
var out = $.NSFileHandle.fileHandleWithStandardOutput;
function emit(s) { out.writeData($(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
var WORKSPACE = {
  NSWorkspaceWillSleepNotification: 'will-sleep',
  NSWorkspaceDidWakeNotification: 'did-wake',
  NSWorkspaceScreensDidSleepNotification: 'display-sleep',
  NSWorkspaceScreensDidWakeNotification: 'display-wake',
  NSWorkspaceSessionDidResignActiveNotification: 'session-inactive',
  NSWorkspaceSessionDidBecomeActiveNotification: 'session-active',
  NSWorkspaceWillPowerOffNotification: 'power-off'
};
var DISTRIBUTED = {
  'com.apple.screenIsLocked': 'screen-locked',
  'com.apple.screenIsUnlocked': 'screen-unlocked',
  'com.apple.screensaver.didstart': 'screensaver-started',
  'com.apple.screensaver.didstop': 'screensaver-stopped'
};
var NAMES = {};
var keychain = null;
var kcRef = Ref();
if ($.SecKeychainCopyDefault(kcRef) === 0) keychain = kcRef[0];
function keychainState() {
  if (keychain === null) return 'unknown';
  var status = Ref();
  if ($.SecKeychainGetStatus(keychain, status) !== 0) return 'unknown';
  return (Number(status[0]) & 1) ? 'unlocked' : 'locked';
}
var lastKeychain = keychainState();
ObjC.registerSubclass({
  name: 'IBSystemEventObserver',
  methods: {
    'handle:': {
      types: ['void', ['id']],
      implementation: function (n) {
        var label = NAMES[ObjC.unwrap(n.name)];
        if (label) emit('event ' + label);
      }
    },
    'stdinRead:': {
      types: ['void', ['id']],
      implementation: function (n) {
        var data = n.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
        if (Number(data.length) === 0) $.exit(0);
        n.object.readInBackgroundAndNotify;
      }
    },
    'tick:': {
      types: ['void', ['id']],
      implementation: function (t) {
        var state = keychainState();
        if (state !== lastKeychain) { lastKeychain = state; emit('keychain ' + state); }
      }
    }
  }
});
var observer = $.IBSystemEventObserver.alloc.init;
var workspace = $.NSWorkspace.sharedWorkspace.notificationCenter;
for (var k in WORKSPACE) {
  NAMES[ObjC.unwrap($[k])] = WORKSPACE[k];
  workspace.addObserverSelectorNameObject(observer, 'handle:', $[k], $());
}
var distributed = $.NSDistributedNotificationCenter.defaultCenter;
for (var d in DISTRIBUTED) {
  NAMES[d] = DISTRIBUTED[d];
  distributed.addObserverSelectorNameObjectSuspensionBehavior(observer, 'handle:', d, $(), 4);
}
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(observer, 'stdinRead:', $.NSFileHandleReadCompletionNotification, stdin);
stdin.readInBackgroundAndNotify;
$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(10, observer, 'tick:', $(), true);
emit('ready ' + lastKeychain);
while (true) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(60));
`;

/** Event names the helper prints after `event `, and their watch.log text.
 *  The keys must match the labels in the script's WORKSPACE and DISTRIBUTED
 *  maps; a test checks that. */
export const EVENT_TEXT = {
  "will-sleep": "will sleep",
  "did-wake": "woke",
  "display-sleep": "display sleep",
  "display-wake": "display wake",
  "screen-locked": "screen locked",
  "screen-unlocked": "screen unlocked",
  "screensaver-started": "screensaver started",
  "screensaver-stopped": "screensaver stopped",
  "session-inactive": "session inactive",
  "session-active": "session active",
  "power-off": "power off requested",
} as const;

export type SystemEventName = keyof typeof EVENT_TEXT;

/** Most pmset log entries copied after one wake; a long sleep with Power Nap
 *  can hold dozens of DarkWake / Sleep pairs. The first (the Sleep that says
 *  why) and the newest are kept. */
export const MAX_PMSET_ENTRIES = 40;

/** How long a helper exit waits for the rest of its stderr. */
const STDERR_DRAIN_MS = 500;

/** The parts of a spawned helper this module uses (a fake in tests). */
export interface SystemEventHelper {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface SystemEventMonitorOptions {
  /** Where `system: ...` lines go. ib watch passes logToWatchLog. */
  log: (line: string) => void;
  /** Start the helper. Default: osascript running SYSTEM_EVENTS_SCRIPT. */
  spawnHelper?: () => SystemEventHelper;
  /** Run a command and resolve its stdout; reject on failure. Default: runCommand. */
  run?: (cmd: string[]) => Promise<string>;
  /** Wall clock. Default Date.now. */
  now?: () => number;
  /** Default process.platform; anything but darwin makes start() a no-op. */
  platform?: string;
}

function defaultSpawnHelper(): SystemEventHelper {
  const proc = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", SYSTEM_EVENTS_SCRIPT], {
    // The pipe stays open for the helper's whole life; EOF tells it ib watch is gone.
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.unref();
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

const RUN_TIMEOUT_MS = 15_000;

/** The default `run`: stdout of `cmd`, or a rejection naming a timeout, the
 *  exit code and stderr. Exported for its tests. */
export async function runCommand(cmd: string[], timeoutMs = RUN_TIMEOUT_MS): Promise<string> {
  const startedAt = performance.now();
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Bun's timeout kills with SIGTERM and `exited` resolves to 143. The
  // elapsed check tells it from a process that died of a signal early.
  if (proc.signalCode !== null && performance.now() - startedAt >= timeoutMs) {
    throw new Error(`${cmd.join(" ")} timed out after ${timeoutMs / 1_000} s`);
  }
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}${err.trim() ? `: ${err.trim()}` : ""}`);
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `65s`, `12m5s`, `8h3m`. */
export function formatSleepDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1_000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function ageSeconds(age: string): number {
  const [h, m, s] = age.split(":").map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

/**
 * One line from `pmset -g assertions`: the non-zero system-wide counts, then
 * each holder grouped by process name and assertion type, then the kernel
 * assertions and idle sleep preventers when pmset lists them. For example
 * `PreventSystemSleep=1 PreventUserIdleSystemSleep=1; held by caffeinate
 * PreventUserIdleSystemSleep x3 (longest 223:35:24), powerd
 * PreventUserIdleSystemSleep (00:03:10); kernel: 0x100=MAGICWAKE`.
 */
export function summarizeAssertions(text: string): string {
  const counts: string[] = [];
  const holders = new Map<string, { count: number; longest: string }>();
  const extras: string[] = [];
  let section: "none" | "system" | "owners" = "none";
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("Assertion status system-wide:")) { section = "system"; continue; }
    if (line.startsWith("Listed by owning process:")) { section = "owners"; continue; }
    const kernel = /^Kernel Assertions: (.+)$/.exec(line);
    if (kernel) { section = "none"; extras.push(`kernel: ${kernel[1]!.trim()}`); continue; }
    const preventers = /^Idle sleep preventers: (.+)$/.exec(line);
    if (preventers) { section = "none"; extras.push(`idle sleep preventers: ${preventers[1]!.trim()}`); continue; }
    if (section === "system") {
      const m = /^\s+(\w+)\s+(\d+)$/.exec(line);
      if (m && m[2] !== "0") counts.push(`${m[1]}=${m[2]}`);
    } else if (section === "owners") {
      const m = /^\s+pid \d+\((.+?)\): \[0x[0-9a-fA-F]+\] (\d+:\d\d:\d\d) (\w+) named:/.exec(line);
      if (!m) continue;
      const key = `${m[1]} ${m[3]}`;
      const seen = holders.get(key);
      if (!seen) holders.set(key, { count: 1, longest: m[2]! });
      else {
        seen.count++;
        if (ageSeconds(m[2]!) > ageSeconds(seen.longest)) seen.longest = m[2]!;
      }
    }
  }
  const parts = [counts.length > 0 ? counts.join(" ") : "none"];
  if (holders.size > 0) {
    parts.push(`held by ${[...holders].map(([key, h]) =>
      h.count === 1 ? `${key} (${h.longest})` : `${key} x${h.count} (longest ${h.longest})`).join(", ")}`);
  }
  parts.push(...extras);
  return parts.join("; ");
}

/** `AC Power, battery 100% charged` from `pmset -g batt`; "" when unparsable. */
export function summarizePowerSource(text: string): string {
  const source = /Now drawing from '([^']+)'/.exec(text)?.[1];
  if (!source) return "";
  const battery = /\t(\d+%); ([^;]+);/.exec(text);
  return battery ? `${source}, battery ${battery[1]} ${battery[2]!.trim()}` : source;
}

/** One Sleep / Wake / DarkWake entry of `pmset -g log`. */
export interface PmsetEntry {
  at: number;
  line: string;
}

/**
 * The Sleep, Wake and DarkWake entries of `pmset -g log` stamped after
 * `afterMs`, oldest first, with runs of whitespace collapsed. Other types
 * ("Wake Requests", "Assertions", ...) are skipped: Claude Code alone starts
 * and ends a caffeinate every few minutes.
 */
export function pmsetSleepWakeEntries(text: string, afterMs: number): PmsetEntry[] {
  const entries: PmsetEntry[] = [];
  const re = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([-+]\d\d)(\d\d) (Sleep|Wake|DarkWake)(?: {2,}|\t)\s*(.*)$/;
  for (const raw of text.split("\n")) {
    const m = re.exec(raw);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    if (!Number.isFinite(at) || at <= afterMs) continue;
    const detail = m[6]!.replace(/\s+/g, " ").trim();
    entries.push({ at, line: `${m[1]} ${m[2]} ${m[3]}${m[4]} ${m[5]} ${detail}` });
  }
  return entries;
}

export class SystemEventMonitor {
  private readonly log: (line: string) => void;
  private readonly spawnHelper: () => SystemEventHelper;
  private readonly run: (cmd: string[]) => Promise<string>;
  private readonly now: () => number;
  private readonly platform: string;
  private helper: SystemEventHelper | null = null;
  private stopped = false;
  private willSleepAt: number | null = null;
  /** pmset log entries at or before this were already read (or predate start). */
  private pmsetReadThrough = 0;
  /** Serialises pmset log reads so two quick wakes cannot copy an entry twice. */
  private pmsetChain: Promise<void> = Promise.resolve();
  private stderrTail = "";

  constructor(opts: SystemEventMonitorOptions) {
    this.log = opts.log;
    this.spawnHelper = opts.spawnHelper ?? defaultSpawnHelper;
    this.run = opts.run ?? ((cmd) => runCommand(cmd));
    this.now = opts.now ?? Date.now;
    this.platform = opts.platform ?? process.platform;
  }

  /** Start the helper. A no-op off macOS, after stop(), or when started. */
  start(): void {
    if (this.platform !== "darwin" || this.stopped || this.helper !== null) return;
    this.pmsetReadThrough = this.now();
    let helper: SystemEventHelper;
    try {
      helper = this.spawnHelper();
    } catch (err) {
      this.log(`system: listener failed to start: ${message(err)}`);
      return;
    }
    this.helper = helper;
    void this.readLines(helper.stdout);
    const stderrRead = this.readStderr(helper.stderr);
    // The exit can resolve before the last stderr chunk is read, and that
    // text is the only clue to why the helper died: wait for it, briefly.
    const stderrDrained = () => Promise.race([stderrRead, new Promise<void>((r) => setTimeout(r, STDERR_DRAIN_MS))]);
    void helper.exited.then(
      async (code) => { await stderrDrained(); this.onExit(code); },
      async (err) => { await stderrDrained(); this.onExit(message(err)); },
    );
  }

  /** Stop the helper; later events and pending pmset results are not logged. */
  stop(): void {
    this.stopped = true;
    const helper = this.helper;
    this.helper = null;
    try {
      helper?.kill();
    } catch {
      /* already gone */
    }
  }

  /** Pending pmset runs settled and their lines written (tests). It does not
   *  wait for helper output still in its pipe. */
  async idle(): Promise<void> {
    await this.pmsetChain;
  }

  private write(line: string): void {
    if (!this.stopped) this.log(`system: ${line}`);
  }

  private async readLines(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          this.handleLine(buffer.slice(0, nl).trim());
          buffer = buffer.slice(nl + 1);
        }
      }
    } catch {
      /* the exit handler reports a dead helper */
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-500);
      }
    } catch {
      /* best effort */
    }
  }

  private onExit(code: number | string): void {
    if (this.stopped) return;
    this.helper = null;
    const tail = this.stderrTail.replace(/\s+/g, " ").trim();
    this.write(`listener stopped (exit ${code})${tail ? `: ${tail}` : ""}`);
  }

  private handleLine(line: string): void {
    const space = line.indexOf(" ");
    const kind = space < 0 ? line : line.slice(0, space);
    const arg = space < 0 ? "" : line.slice(space + 1);
    if (kind === "ready") {
      this.write("listening");
      this.write(`keychain at start: ${arg}`);
      this.logAssertions("start");
    } else if (kind === "keychain") {
      this.write(`keychain ${arg}`);
    } else if (kind === "event" && Object.hasOwn(EVENT_TEXT, arg)) {
      this.handleEvent(arg as SystemEventName);
    }
  }

  private handleEvent(name: SystemEventName): void {
    if (name === "will-sleep") {
      this.willSleepAt = this.now();
      this.write("will sleep");
    } else if (name === "did-wake") {
      const slept = this.willSleepAt === null ? "" : ` (slept ~${formatSleepDuration(this.now() - this.willSleepAt)})`;
      this.willSleepAt = null;
      this.write(`woke${slept}`);
      this.logAssertions("woke");
      this.logPmsetHistory();
    } else if (name === "display-sleep" || name === "display-wake") {
      this.write(EVENT_TEXT[name]);
      this.logAssertions(EVENT_TEXT[name]);
    } else {
      this.write(EVENT_TEXT[name]);
    }
  }

  /** One `power assertions (<when>): ...` line. The label says which event it
   *  belongs to, since the line lands when pmset finishes. */
  private logAssertions(when: string): void {
    const read = Promise.all([
      this.run(["/usr/bin/pmset", "-g", "assertions"]),
      this.run(["/usr/bin/pmset", "-g", "batt"]).catch(() => ""),
    ]).then(([assertions, batt]) => {
      const power = summarizePowerSource(batt);
      this.write(`power assertions (${when}): ${summarizeAssertions(assertions)}${power ? `; power: ${power}` : ""}`);
    }, (err) => {
      this.write(`power assertions (${when}) unavailable: ${message(err)}`);
    });
    this.pmsetChain = this.pmsetChain.then(() => read);
  }

  /** Copy the pmset Sleep / Wake / DarkWake entries since the last read. */
  private logPmsetHistory(): void {
    this.pmsetChain = this.pmsetChain.then(async () => {
      let text: string;
      try {
        text = await this.run(["/usr/bin/pmset", "-g", "log"]);
      } catch (err) {
        this.write(`pmset log unavailable: ${message(err)}`);
        return;
      }
      const entries = pmsetSleepWakeEntries(text, this.pmsetReadThrough);
      if (entries.length === 0) return;
      this.pmsetReadThrough = Math.max(...entries.map((e) => e.at));
      if (entries.length <= MAX_PMSET_ENTRIES) {
        for (const e of entries) this.write(`pmset: ${e.line}`);
        return;
      }
      // The first entry is the Sleep with the real reason; after a dark wake
      // every later Sleep says Maintenance. Keep it, then the newest.
      const newest = entries.slice(-(MAX_PMSET_ENTRIES - 1));
      this.write(`pmset: ${entries[0]!.line}`);
      this.write(`pmset: ${entries.length - 1 - newest.length} entries not shown`);
      for (const e of newest) this.write(`pmset: ${e.line}`);
    });
  }
}

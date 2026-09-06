/** Kernel report parsing and conservative attribution; no OS access in this module. */
export interface SandboxReport {
  timestamp: string;
  epoch: number;
  mach: bigint;
  boot: string;
  pid: number;
  process: string;
  operation: string;
  target?: string;
  duplicates: number;
  key: string;
}

export function sandboxTimestampEpoch(timestamp: string): number {
  return Date.parse(timestamp.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) / 1000;
}

export function parseSandboxReport(line: string, boot: string, options: { liveStream?: boolean } = {}): SandboxReport | null {
  if (line.length > 65536) return null;
  try {
    const r = JSON.parse(line);
    if (!r) return null;
    // Actual log stream records on Darwin 25 omit bootUUID (empty string).
    // Only a current live subscription can supply its independently read boot;
    // persisted/replayed input without a boot identity is not admissible.
    if (!(options.liveStream && r.bootUUID === "") && r.bootUUID?.toLowerCase() !== boot.toLowerCase()) return null;
    // These fields identify the reporter, NEVER the offender. Other sources and
    // unverified structured formats remain unsupported, rather than guessed.
    const kernel = r.processID === 0 && r.processImagePath === "/kernel" &&
      r.senderImagePath === "/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox";
    const sandboxd = r.processImagePath === "/usr/libexec/sandboxd" &&
      r.subsystem === "com.apple.sandbox.reporting" && r.category === "violation";
    if (!kernel && !sandboxd) return null;
    if (typeof r.timestamp !== "string" || !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:?\d\d)$/.test(r.timestamp)) return null;
    const epoch = sandboxTimestampEpoch(r.timestamp);
    if (!Number.isFinite(epoch) || !Number.isSafeInteger(r.machTimestamp) || r.machTimestamp <= 0) return null;
    if (typeof r.eventMessage !== "string") return null;
    const m = /^(?:(\d+) duplicate reports? for )?Sandbox: ([^\r\n()]{1,256})\(([1-9]\d*)\) deny\(\d+\) ([a-z][a-z0-9*-]*)(?: ([^\r\n]*))?$/.exec(r.eventMessage);
    if (!m) return null;
    const pid = Number(m[3]);
    const duplicates = m[1] ? Number(m[1]) : 0;
    if (!Number.isSafeInteger(pid) || pid > 2147483647 || !Number.isSafeInteger(duplicates)) return null;
    // Duplicate summaries describe earlier attempts whose timestamps are absent.
    // They cannot safely be attributed using the summary's delivery timestamp.
    if (duplicates) return null;
    const mach = BigInt(r.machTimestamp);
    return { timestamp: r.timestamp, epoch, mach, boot, pid, process: m[2]!,
      operation: m[4]!, target: m[5], duplicates,
      key: `${boot}:${mach}:${r.eventMessage}` };
  } catch { return null; }
}

export interface ProcessObservation {
  pid: number;
  ppid: number;
  birth: string; // proc_bsdinfo seconds:microseconds, not ps's second-resolution lstart
  before: bigint;
  after: bigint;
}

interface Interval extends ProcessObservation { first: bigint; last: bigint; touched: number }
export const processIdentity = (p: Pick<ProcessObservation, "pid" | "birth">) => `${p.pid}:${p.birth}`;

/** Retain only observed lifetimes. Never extrapolate a death time or backdate
 * membership to birth: children that deny before first observation are unknown.
 */
export class SandboxAttribution {
  private intervals = new Map<string, Interval>();
  constructor(readonly root: ProcessObservation, readonly maxEntries = 4096) {}

  observe(samples: ProcessObservation[], now: number): void {
    const current = new Map(samples.map(p => [p.pid, p]));
    const belongs = (p: ProcessObservation, visited = new Set<number>()): boolean => {
      if (visited.has(p.pid) || visited.size > 64) return false;
      if (processIdentity(p) === processIdentity(this.root)) return true;
      // Once verified, a process instance remains a descendant even after its
      // parent exits and the kernel reparents it. Birth identity must still match.
      if (this.intervals.has(processIdentity(p))) return true;
      visited.add(p.pid);
      const parent = current.get(p.ppid);
      if (!parent || compareBirth(parent.birth, p.birth) > 0) return false;
      return belongs(parent, visited);
    };
    for (const p of samples) {
      if (p.before > p.after || !belongs(p)) continue;
      const key = processIdentity(p);
      const existing = this.intervals.get(key);
      if (existing) {
        existing.last = p.before > existing.last ? p.before : existing.last;
        existing.touched = now;
      } else {
        this.intervals.set(key, { ...p, first: p.after, last: p.before, touched: now });
      }
    }
    for (const [key, p] of this.intervals) if (now - p.touched > 30000) this.intervals.delete(key);
    while (this.intervals.size > this.maxEntries) this.intervals.delete(this.intervals.keys().next().value!);
  }

  attribute(report: SandboxReport): ProcessObservation | null {
    const matches = [...this.intervals.values()].filter(p =>
      p.pid === report.pid && p.first <= report.mach && report.mach <= p.last);
    return matches.length === 1 ? matches[0]! : null;
  }

  liveIdentities(): ProcessObservation[] { return [...this.intervals.values()]; }
}

function compareBirth(a: string, b: string): number {
  const [as, au] = a.split(":").map(Number);
  const [bs, bu] = b.split(":").map(Number);
  return as! - bs! || au! - bu!;
}

/** Fixed memory and a per-launch rate limit, including distinct-path floods. */
export class SandboxOutputBudget {
  private seen = new Map<string, boolean>();
  private signatures = new Map<string, number>();
  private window = 0;
  private emitted = 0;
  suppressed = 0;
  accept(report: SandboxReport, identity: ProcessObservation, now: number): boolean {
    if (this.seen.has(report.key)) return false;
    this.seen.set(report.key, true);
    if (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value!);
    if (now - this.window >= 60000) {
      this.window = now;
      this.emitted = 0;
      this.signatures.clear();
    }
    const signature = `${processIdentity(identity)}:${report.operation}:${report.target ?? ""}`;
    const n = this.signatures.get(signature) ?? 0;
    if (this.emitted >= 60 || n >= 3) { this.suppressed++; return false; }
    this.signatures.set(signature, n + 1);
    this.emitted++;
    return true;
  }
}

export function formatSandboxRecord(report: SandboxReport, identity: ProcessObservation, launch: string): string {
  // JSON quoting keeps control characters/path newlines from forging log records.
  return `[${report.timestamp}] [Sandbox] ${report.operation} process=${JSON.stringify(report.process)} pid=${report.pid} birth=${identity.birth} target=${JSON.stringify(report.target ?? null)} launch=${launch} boot=${report.boot} mach=${report.mach}`;
}

/** NDJSON framing with bounded carry; discard an oversized record through its newline. */
export class SandboxLogFramer {
  private carry = "";
  private dropping = false;
  push(text: string): string[] {
    const lines: string[] = [];
    for (const part of text.split(/(?<=\n)/)) {
      const end = part.endsWith("\n");
      if (!this.dropping) {
        if (this.carry.length + part.length > 65536) { this.carry = ""; this.dropping = true; }
        else this.carry += part;
      }
      if (end) {
        if (!this.dropping) lines.push(this.carry.trimEnd());
        this.carry = "";
        this.dropping = false;
      }
    }
    return lines;
  }
}

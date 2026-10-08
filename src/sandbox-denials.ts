/** Kernel denial report parsing, per-launch output limits and record format; no
 * OS access in this module. A report is attributed by the tag its profile put on
 * the deny (sandbox.ts SANDBOX_TAG), never by the offending process. */
import { formatLogTimestamp } from "./log-timestamp";

export interface SandboxReport {
  timestamp: string;
  mach: bigint;
  /** The text after the report's LAST newline. It is a launch's tag only if it
   * equals one exactly; a deny without our message leaves path text here. */
  tag: string;
  /** N of an OS-coalesced "N duplicate report(s) for Sandbox: …" summary, else 0. */
  duplicates: number;
  /** The offender as the kernel printed it, or null when a crafted process name
   * makes the split ambiguous (the report is then counted, not recorded). */
  offender: { pid: number; process: string; operation: string; target?: string } | null;
  key: string;
}

const SANDBOX_KEXT = "/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox";
const TIMESTAMP = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:?\d\d)$/;

/** Parse one NDJSON line of the live stream. Only a real kernel report passes:
 * the log system sets processID, the image paths and messageType, so a
 * sandboxed `logger` (processID = its pid, image /usr/bin/logger, Default)
 * cannot forge one. The caller matches `tag` exactly against registered tags. */
export function parseSandboxReport(line: string): SandboxReport | null {
  if (line.length > 65536) return null;
  try {
    const r = JSON.parse(line);
    if (r?.processID !== 0 || r.processImagePath !== "/kernel" || r.senderImagePath !== SANDBOX_KEXT ||
        r.messageType !== "Error") return null;
    if (typeof r.timestamp !== "string" || !TIMESTAMP.test(r.timestamp) || Number.isNaN(Date.parse(r.timestamp))) return null;
    if (!Number.isSafeInteger(r.machTimestamp) || r.machTimestamp <= 0) return null;
    const message = r.eventMessage;
    if (typeof message !== "string") return null;
    // A path may contain newlines; the tag is always the very last line. The
    // kernel keeps only the first 1008 bytes of a long report and appends `<…>`,
    // so a cut report's last line is path text or a cut tag ending in `<…>`:
    // never a registered tag.
    const lastNewline = message.lastIndexOf("\n");
    if (lastNewline < 0) return null;
    const summary = /^([1-9]\d{0,8}) duplicate reports? for Sandbox: /.exec(message);
    const head = summary ? summary[0].length : message.startsWith("Sandbox: ") ? "Sandbox: ".length : -1;
    if (head < 0) return null;
    const mach = BigInt(r.machTimestamp);
    return { timestamp: r.timestamp, mach, tag: message.slice(lastNewline + 1),
      duplicates: summary ? Number(summary[1]) : 0, offender: splitOffender(message.slice(head, lastNewline)),
      key: `${mach}:${message}` };
  } catch { return null; }
}

/** `<name>(<pid>) deny(<n>) <operation> [<target>]`. Kernel p_name is at most 32
 * bytes and printed without sanitizing the delimiter, so a name such as
 * "Ra(12345) deny(1) n " can forge an earlier split. Examine EVERY feasible
 * delimiter and keep only an unambiguous split. UTF-16 length is a conservative
 * upper bound for the 32 bytes. */
function splitOffender(body: string): SandboxReport["offender"] {
  const splits: NonNullable<SandboxReport["offender"]>[] = [];
  const delimiter = /^\(([1-9]\d*)\) deny\(\d+\) ([a-z][a-z0-9*-]*)(?: ([\s\S]*))?$/;
  for (let index = 1; index <= Math.min(32, body.length); index++) {
    if (body[index] !== "(") continue;
    const m = delimiter.exec(body.slice(index));
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) continue;
    splits.push({ pid, process: body.slice(0, index), operation: m[2]!, target: m[3] });
  }
  return splits.length === 1 ? splits[0]! : null;
}

/** Fixed memory and a per-launch rate limit, including distinct-path floods. */
export class SandboxOutputBudget {
  private seen = new Map<string, boolean>();
  private signatures = new Map<string, number>();
  private window = 0;
  private emitted = 0;
  suppressed = 0;
  accept(report: SandboxReport, now: number): boolean {
    if (this.seen.has(report.key)) return false;
    this.seen.set(report.key, true);
    if (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value!);
    if (now - this.window >= 60000) {
      this.window = now;
      this.emitted = 0;
      this.signatures.clear();
    }
    const o = report.offender;
    const signature = `${o?.pid}:${o?.operation}:${o?.target ?? ""}`;
    const n = this.signatures.get(signature) ?? 0;
    if (this.emitted >= 60 || n >= 3) { this.suppressed++; return false; }
    this.signatures.set(signature, n + 1);
    this.emitted++;
    return true;
  }
}

/** The `[Sandbox]` line for agent.log. It never contains the tag: other agents
 * can read agent.log, and the tag's nonce must stay secret. The bracket is the
 * kernel's event time in agent.log's local format; `mach=` keeps the precise time. */
export function formatSandboxRecord(report: SandboxReport, launch: string, boot: string): string {
  const o = report.offender!;
  // JSON quoting keeps control characters/path newlines from forging log records.
  return `[${formatLogTimestamp(new Date(report.timestamp))}] [Sandbox] ${o.operation} process=${JSON.stringify(o.process)} pid=${o.pid} ` +
    `target=${JSON.stringify(o.target ?? null)} launch=${launch} boot=${boot} mach=${report.mach}` +
    (report.duplicates ? ` duplicates=${report.duplicates}` : "");
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

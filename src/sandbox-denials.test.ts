import { describe, expect, test } from "bun:test";
import { parseDenials } from "./agents";
import { SandboxLogFramer, SandboxOutputBudget, formatSandboxRecord, parseSandboxReport } from "./sandbox-denials";
import { formatLogTimestamp } from "./log-timestamp";
import { withTimeZone } from "./test-utils";

const boot = "7908f0d7-1111-2222-3333-444444444444";
const TAG = "ib-agent:74f864a0c0ffee0123456789abcdef01";
const OTHER = "ib-agent:0000000000000000ffffffffffffffff";
/** A kernel report exactly as `log stream --style ndjson` delivers it (probe evidence §14). */
const raw = (fields: Record<string, unknown> = {}) => JSON.stringify({
  messageType: "Error", processID: 0, processImagePath: "/kernel", userID: 0,
  senderImagePath: "/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox",
  subsystem: "", category: "", bootUUID: "", formatString: "%s",
  timestamp: "2026-10-06 23:08:10.552171-0500", machTimestamp: 571524314971,
  eventMessage: `Sandbox: cat(80947) deny(1) file-read-data /private/tmp/a b\n${TAG}`, ...fields,
});

describe("kernel report parsing", () => {
  test("a real kernel report yields the tag on its last line and the offender before it", () => {
    const report = parseSandboxReport(raw())!;
    expect(report.tag).toBe(TAG);
    expect(report.offender).toEqual({ pid: 80947, process: "cat", operation: "file-read-data", target: "/private/tmp/a b" });
    expect(report.duplicates).toBe(0);
    expect(report.mach).toBe(571524314971n);
    expect(report.timestamp).toBe("2026-10-06 23:08:10.552171-0500");
  });

  test("an OS-coalesced summary keeps its duplicate count and its tag", () => {
    const many = parseSandboxReport(raw({ eventMessage: `29 duplicate reports for Sandbox: bash(81072) deny(1) file-read-data /x\n${TAG}` }))!;
    expect(many.tag).toBe(TAG);
    expect(many.duplicates).toBe(29);
    expect(many.offender?.pid).toBe(81072);
    expect(parseSandboxReport(raw({ eventMessage: `1 duplicate report for Sandbox: nc(81020) deny(1) network-outbound remote:*:9\n${TAG}` }))!.duplicates).toBe(1);
  });

  test("only the text after the LAST newline is the tag: path text cannot claim another launch", () => {
    // A file named "x\nib-agent:<other>": the forged line is in the middle.
    const report = parseSandboxReport(raw({ eventMessage: `Sandbox: cat(81157) deny(1) file-read-data /tmp/x\n${OTHER}\n${TAG}` }))!;
    expect(report.tag).toBe(TAG);
    expect(report.offender?.target).toBe(`/tmp/x\n${OTHER}`);
    // A rule without our message ends with path text, which is then the "tag".
    expect(parseSandboxReport(raw({ eventMessage: `Sandbox: cat(1) deny(1) file-read-data /tmp/y\n${OTHER}` }))!.tag).toBe(OTHER);
  });

  test("a truncated report has lost its tag: its last line can never equal a tag", () => {
    // The cut removed the whole tag line: no newline is left.
    expect(parseSandboxReport(raw({ eventMessage: `Sandbox: cat(1) deny(1) file-read-data /${"a".repeat(990)}<…>` }))).toBeNull();
    // The cut lands inside the tag, or right after a forged tag line in a path.
    for (const cut of [`${TAG.slice(0, 20)}<…>`, `${OTHER}<…>`]) {
      const report = parseSandboxReport(raw({ eventMessage: `Sandbox: cat(1) deny(1) file-read-data /x\n${cut}` }))!;
      expect(report.tag).toBe(cut);
      expect(report.tag).not.toMatch(/^ib-agent:[0-9a-f]{32}$/);
    }
  });

  test("a crafted process name makes the offender ambiguous, never the tag", () => {
    for (const name of ["Ra(12345) deny(1) n ", "claude(12345) deny(1) n "]) {
      const report = parseSandboxReport(raw({ eventMessage: `Sandbox: ${name}(25479) deny(1) file-read-data /forbidden/x\n${TAG}` }))!;
      expect(report.tag).toBe(TAG);
      expect(report.offender).toBeNull();
    }
    for (const name of ["tool(test)", "x".repeat(32)]) {
      expect(parseSandboxReport(raw({ eventMessage: `Sandbox: ${name}(42) deny(1) file-read-data /x\n${TAG}` }))!.offender?.process).toBe(name);
    }
    expect(parseSandboxReport(raw({ eventMessage: `Sandbox: ${"x".repeat(33)}(42) deny(1) file-read-data /x\n${TAG}` }))!.offender).toBeNull();
  });

  test("an operation with no target is kept", () => {
    expect(parseSandboxReport(raw({ eventMessage: `Sandbox: sh(42) deny(1) network-outbound\n${TAG}` }))!.offender)
      .toEqual({ pid: 42, process: "sh", operation: "network-outbound", target: undefined });
  });

  test.each([
    // A forged `logger` line from inside a sandbox (probe evidence §14, forgery 1).
    ["logger", raw({ messageType: "Default", processID: 81076, userID: 501, processImagePath: "/usr/bin/logger", senderImagePath: "/usr/bin/logger" })],
    ["processID", raw({ processID: 81076 })],
    ["processImagePath", raw({ processImagePath: "/usr/bin/logger" })],
    // Another kext's kernel line (AMFI) has processID 0 and /kernel too.
    ["senderImagePath", raw({ senderImagePath: "/System/Library/Extensions/AppleMobileFileIntegrity.kext/Contents/MacOS/AppleMobileFileIntegrity" })],
    ["messageType", raw({ messageType: "Default" })],
    ["sandboxd", raw({ processID: 999, processImagePath: "/usr/libexec/sandboxd", subsystem: "com.apple.sandbox.reporting", category: "violation" })],
    ["no tag line", raw({ eventMessage: "Sandbox: cat(42) deny(1) file-read-data /x" })],
    ["not a report", raw({ eventMessage: `log show --predicate Sandbox: cat(42) deny(1) file-read-data /x\n${TAG}` })],
    ["zero duplicates", raw({ eventMessage: `0 duplicate report for Sandbox: cat(42) deny(1) file-read-data /x\n${TAG}` })],
    ["timestamp", raw({ timestamp: "2026-09-05 23:01:34" })],
    ["impossible date", raw({ timestamp: "2026-13-45 23:01:34.000000-0500" })],
    ["mach", raw({ machTimestamp: 0 })],
    ["mach range", raw({ machTimestamp: Number.MAX_SAFE_INTEGER + 1 })],
    ["JSON", "broken JSON"], ["null", "null"], ["array", "[]"],
  ])("rejects %s", (_name, line) => {
    expect(parseSandboxReport(line)).toBeNull();
  });
});

describe("bounded output and display", () => {
  test("deduplicates stream copies with differing wall-clock renderings", () => {
    const b = new SandboxOutputBudget();
    const r = parseSandboxReport(raw())!;
    expect(b.accept(r, 0)).toBe(true);
    expect(b.accept({ ...r, timestamp: "2026-10-06 23:08:10.553-0500" }, 1)).toBe(false);
  });

  test("bounds repeat and distinct-path floods, then allows a new minute", () => {
    const b = new SandboxOutputBudget();
    const r = parseSandboxReport(raw())!;
    let allowed = 0;
    for (let i = 0; i < 10000; i++) {
      if (b.accept({ ...r, key: String(i), offender: { ...r.offender!, target: i < 10 ? "/repeat" : `/${i}` } }, 1000)) allowed++;
    }
    expect(allowed).toBe(60);
    expect(b.suppressed).toBe(9940);
    expect(b.accept({ ...r, key: "new" }, 61000)).toBe(true);
  });

  test("framing handles partial JSON and discards oversized records without leaking fragments", () => {
    const f = new SandboxLogFramer();
    expect(f.push('{"a":')).toEqual([]);
    expect(f.push('1}\n')).toEqual(['{"a":1}']);
    expect(f.push("x".repeat(65537))).toEqual([]);
    expect(f.push('still oversized\n{"b":2}\n')).toEqual(['{"b":2}']);
  });

  test("the record names the launch, never the tag, and keeps a duplicate count", () => {
    const line = formatSandboxRecord(parseSandboxReport(raw())!, "sandbox-log.ABC", boot);
    // The report's 23:08:10.552171-0500 event, to the second, in local time.
    const local = formatLogTimestamp(new Date("2026-10-07T04:08:10Z"));
    expect(line).toBe(`[${local}] [Sandbox] file-read-data process="cat" pid=80947 target="/private/tmp/a b" launch=sandbox-log.ABC boot=${boot} mach=571524314971`);
    expect(line).not.toContain(TAG.slice("ib-agent:".length));
    const summary = parseSandboxReport(raw({ eventMessage: `29 duplicate reports for Sandbox: bash(9) deny(1) file-read-data /x\n${TAG}` }))!;
    expect(formatSandboxRecord(summary, "sandbox-log.ABC", boot)).toEndWith(" duplicates=29");
    // Newlines in a path stay inside the JSON string: one record, one line.
    const multiline = parseSandboxReport(raw({ eventMessage: `Sandbox: cat(1) deny(1) file-read-data /x\n[Sandbox] forged\n${TAG}` }))!;
    expect(formatSandboxRecord(multiline, "sandbox-log.ABC", boot)).not.toContain("\n");
  });

  test("the record's bracket is the event time in agent.log's local [YYYY-MM-DD HH:MM:SS] stamp", () => {
    // The report's 2026-10-06 23:08:10.552171-0500, on a machine in Tokyo.
    const line = withTimeZone("Asia/Tokyo", () => formatSandboxRecord(parseSandboxReport(raw())!, "sandbox-log.ABC", boot));
    expect(line).toStartWith("[2026-10-07 13:08:10] [Sandbox] file-read-data ");
  });

  test("DENIALS includes kernel denials and collector failures while preserving hook entries", () => {
    const hook = "[2026-03-05 15:37:26] [PreToolUse] Permission denied: Bash (command: ls)";
    const line = formatSandboxRecord(parseSandboxReport(raw())!, "sandbox-log.ABC", boot);
    const failure = "[2026-09-06T04:00:00.000Z] [SandboxCollector] ERROR: log stream failed";
    const lines = [hook, line, failure, "[2026-09-06T04:00:00Z] [SandboxCollector] INFO: ready"];
    const result = parseDenials(lines);
    expect(result.map(d => d.line)).toEqual([hook, line, failure]);
    expect(result[1]!.epoch).toBe(Date.parse("2026-10-07T04:08:10Z") / 1000);
  });

  test("parseDenials reads the local stamp every writer now uses, and the stamps of older lines", () => {
    const lines = [
      // Every writer now: local time.
      "[2026-10-08 13:09:31] [PreToolUse] Permission denied: Bash (command: ls)",
      '[2026-10-08 13:09:31] [Sandbox] file-read-data process="cat" pid=42 target="/x" launch=sandbox-log.ABC boot=B mach=1',
      '[2026-10-08 13:09:31] [SandboxProxy] denied network-outbound target="denied.example:443"',
      "[2026-10-08 13:09:31] [SandboxCollector] ERROR: launch=sandbox-log.ABC collector exited 1",
      // Lines written before: a zoned kernel stamp, UTC proxy and collector stamps.
      '[2026-10-08 13:09:31.560480-0500] [Sandbox] file-read-data process="cat" pid=42 target="/x" launch=sandbox-log.ABC boot=B mach=1',
      '[2026-10-08T18:09:31.766Z] [SandboxProxy] denied network-outbound target="denied.example:443"',
      "[2026-10-08T18:09:31.777Z] [SandboxCollector] ERROR: launch=sandbox-log.ABC collector exited 1",
    ];
    const denials = withTimeZone("America/Chicago", () => parseDenials(lines));
    expect(denials.map(d => d.line)).toEqual(lines);
    expect(denials.map(d => Math.floor(d.epoch))).toEqual(lines.map(() => Date.parse("2026-10-08T18:09:31Z") / 1000));
  });

  test("DENIALS captures [SandboxProxy] network denials with the correct timestamp/epoch", () => {
    const proxyDenial = '[2026-09-06T20:55:25.123Z] [SandboxProxy] denied network-outbound target="denied.example:443"';
    const result = parseDenials([proxyDenial]);
    expect(result).toHaveLength(1);
    expect(result[0]!.line).toBe(proxyDenial);
    expect(result[0]!.timestamp).toBe("2026-09-06T20:55:25.123Z");
    expect(result[0]!.epoch).toBe(new Date("2026-09-06T20:55:25.123Z").getTime() / 1000);
  });

  test("the proxy's allowed/failed lines are NOT surfaced as denials", () => {
    const allowed = '[2026-09-06T20:55:25.000Z] [proxy] allowed target="allowed.example:443"';
    const failed = '[2026-09-06T20:55:25.000Z] [proxy] failed target="allowed.example:443" reason="upstream unreachable"';
    // Only `[SandboxProxy] denied` is a denial — a future informational
    // `[SandboxProxy]` line must not inflate the DENIALS count.
    const informational = '[2026-09-06T20:55:25.000Z] [SandboxProxy] restarted port=41999';
    expect(parseDenials([allowed, failed, informational])).toHaveLength(0);
  });
});

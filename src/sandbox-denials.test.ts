import { describe, expect, test } from "bun:test";
import { parseDenials } from "./agents";
import { SandboxAttribution, SandboxLogFramer, SandboxOutputBudget, formatSandboxRecord,
  parseSandboxReport, type ProcessObservation } from "./sandbox-denials";

const boot = "7908f0d7-1111-2222-3333-444444444444";
const raw = (fields: Record<string, unknown> = {}) => JSON.stringify({
  bootUUID: boot, timestamp: "2026-09-05 23:01:34.988314-0500", machTimestamp: 150,
  processID: 0, processImagePath: "/kernel",
  senderImagePath: "/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox",
  subsystem: "", category: "",
  eventMessage: "Sandbox: cat(42) deny(1) file-read-data /private/tmp/a b", ...fields,
});
const obs = (pid: number, ppid: number, birth: string, before: bigint, after = before + 1n): ProcessObservation =>
  ({ pid, ppid, birth, before, after });
const root = obs(40, 10, "1000:1", 10n);
const child = obs(42, 40, "1001:1", 100n);

describe("kernel report parsing", () => {
  test("extracts offender from kernel message, preserving timestamp, path and monotonic identity", () => {
    const event = parseSandboxReport(raw(), boot)!;
    expect(event.pid).toBe(42);
    expect(event.process).toBe("cat");
    expect(event.target).toBe("/private/tmp/a b");
    expect(event.mach).toBe(150n);
    expect(event.timestamp).toBe("2026-09-05 23:01:34.988314-0500");
    expect(event.epoch).toBeCloseTo(Date.parse("2026-09-06T04:01:34.988Z") / 1000, 3);
  });
  test("sandboxd is a reporter too, never used as the offender", () => {
    expect(parseSandboxReport(raw({ processID: 999, processImagePath: "/usr/libexec/sandboxd",
      subsystem: "com.apple.sandbox.reporting", category: "violation" }), boot)?.pid).toBe(42);
  });
  test("observed empty bootUUID is accepted only from a current live subscription", () => {
    const line = raw({ bootUUID: "" });
    expect(parseSandboxReport(line, boot)).toBeNull();
    expect(parseSandboxReport(line, boot, { liveStream: true })?.boot).toBe(boot);
    expect(parseSandboxReport(raw({ bootUUID: "other-boot" }), boot, { liveStream: true })).toBeNull();
  });
  test("path is optional, operation is retained", () => {
    expect(parseSandboxReport(raw({ eventMessage: "Sandbox: sh(42) deny(1) network-outbound" }), boot)?.target).toBeUndefined();
  });
  test.each([
    "broken JSON", "null", "[]", raw({ timestamp: "bad" }), raw({ timestamp: "2026-09-05 23:01:34" }),
    raw({ machTimestamp: 0 }), raw({ machTimestamp: Number.MAX_SAFE_INTEGER + 1 }),
    raw({ bootUUID: "a-different-boot" }), raw({ processID: 42 }),
    raw({ processImagePath: "/usr/bin/logger" }), raw({ senderImagePath: "/tmp/fake" }),
    raw({ eventMessage: "log show --predicate Sandbox: cat(42) deny(1) file-read-data /x" }),
    raw({ eventMessage: "Sandbox: cat(42) deny(1) file-read-data /x\nforged" }),
    raw({ eventMessage: "Sandbox: cat(9999999999999) deny(1) file-read-data /x" }),
    raw({ eventMessage: "1 duplicate report for Sandbox: cat(42) deny(1) file-read-data /x" }),
  ])("rejects malformed, irrelevant, ambiguous or coalesced input %#", line => {
    expect(parseSandboxReport(line, boot)).toBeNull();
  });
});

describe("process lifetime attribution", () => {
  test("needs observations bracketing the event, not a matching PID or birth timestamp alone", () => {
    const a = new SandboxAttribution(root);
    a.observe([root, child], 0);
    const event = parseSandboxReport(raw(), boot)!;
    expect(a.attribute(event)).toBeNull();
    a.observe([obs(40, 10, root.birth, 200n), obs(42, 40, child.birth, 200n)], 100);
    expect(a.attribute(event)?.birth).toBe(child.birth);
    expect(a.attribute({ ...event, mach: 99n })).toBeNull();
    expect(a.attribute({ ...event, mach: 201n })).toBeNull();
  });
  test("PID reuse cannot expand the old lifetime or label an unrelated replacement", () => {
    const a = new SandboxAttribution(root);
    a.observe([root, child], 0);
    a.observe([obs(42, 40, child.birth, 170n)], 1);
    a.observe([obs(42, 999, "1100:1", 190n)], 2);
    expect(a.attribute(parseSandboxReport(raw({ machTimestamp: 200 }), boot)!)).toBeNull();
    expect(a.attribute(parseSandboxReport(raw(), boot)!)?.birth).toBe(child.birth);
  });
  test("reused ancestor PID with birth after child does not prove ancestry", () => {
    const a = new SandboxAttribution(root);
    a.observe([root, obs(41, 40, "2000:0", 90n), obs(42, 41, "1500:0", 100n)], 0);
    a.observe([root, obs(41, 40, "2000:0", 200n), obs(42, 41, "1500:0", 200n)], 1);
    expect(a.attribute(parseSandboxReport(raw(), boot)!)).toBeNull();
  });
  test("concurrent agent launches do not acquire each other's descendants", () => {
    const bRoot = obs(50, 10, "1000:2", 10n);
    const a = new SandboxAttribution(root);
    const b = new SandboxAttribution(bRoot);
    for (const tracker of [a, b]) {
      tracker.observe([root, bRoot, child], 0);
      tracker.observe([obs(42, 40, child.birth, 200n)], 1);
    }
    const event = parseSandboxReport(raw(), boot)!;
    expect(a.attribute(event)?.pid).toBe(42);
    expect(b.attribute(event)).toBeNull();
  });
  test("short-lived unseen children and delayed reports outside observed intervals remain unknown", () => {
    const a = new SandboxAttribution(root);
    a.observe([root], 0);
    a.observe([obs(42, 40, child.birth, 200n), root], 1);
    expect(a.attribute(parseSandboxReport(raw(), boot)!)).toBeNull();
  });
  test("known reparented descendants retain birth identity and expire from history", () => {
    const a = new SandboxAttribution(root);
    a.observe([root, child], 0);
    a.observe([obs(42, 1, child.birth, 200n)], 1);
    expect(a.attribute(parseSandboxReport(raw(), boot)!)).not.toBeNull();
    a.observe([], 30002);
    expect(a.attribute(parseSandboxReport(raw(), boot)!)).toBeNull();
  });
  test("history remains bounded", () => {
    const a = new SandboxAttribution(root, 4);
    a.observe([root, ...Array.from({ length: 30 }, (_, i) => obs(i + 100, root.pid, "1001:0", 100n))], 0);
    expect(a.liveIdentities().length).toBeLessThanOrEqual(4);
  });
});

describe("bounded output and display", () => {
  test("deduplicates stream copies with differing wall-clock renderings", () => {
    const b = new SandboxOutputBudget();
    const r = parseSandboxReport(raw(), boot)!;
    expect(b.accept(r, child, 0)).toBe(true);
    expect(b.accept({ ...r, timestamp: "2026-09-05 23:01:34.989-0500" }, child, 1)).toBe(false);
  });
  test("bounds repeat and distinct-path floods, then allows a new minute", () => {
    const b = new SandboxOutputBudget();
    const r = parseSandboxReport(raw(), boot)!;
    let allowed = 0;
    for (let i = 0; i < 10000; i++) {
      if (b.accept({ ...r, key: String(i), target: i < 10 ? "/repeat" : `/${i}` }, child, 1000)) allowed++;
    }
    expect(allowed).toBe(60);
    expect(b.suppressed).toBe(9940);
    expect(b.accept({ ...r, key: "new" }, child, 61000)).toBe(true);
  });
  test("framing handles partial JSON and discards oversized records without leaking fragments", () => {
    const f = new SandboxLogFramer();
    expect(f.push('{"a":')).toEqual([]);
    expect(f.push('1}\n')).toEqual(['{"a":1}']);
    expect(f.push("x".repeat(65537))).toEqual([]);
    expect(f.push('still oversized\n{"b":2}\n')).toEqual(['{"b":2}']);
  });
  test("DENIALS includes kernel denials and collector failures while preserving hook entries", () => {
    const hook = "[2026-03-05 15:37:26] [PreToolUse] Permission denied: Bash (command: ls)";
    const event = parseSandboxReport(raw(), boot)!;
    const line = formatSandboxRecord(event, child, "sandbox-log.ABC");
    const failure = "[2026-09-06T04:00:00.000Z] [SandboxCollector] ERROR: log stream failed";
    const lines = [hook, line, failure, "[2026-09-06T04:00:00Z] [SandboxCollector] INFO: ready"];
    const result = parseDenials(lines);
    expect(result.map(d => d.line)).toEqual([hook, line, failure]);
    expect(result[1]!.epoch).toBe(event.epoch);
    expect(line).toContain('target="/private/tmp/a b"');
    expect(line).toContain("birth=1001:1");
  });
});

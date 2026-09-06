import { expect, test } from "bun:test";
import { stripAnsi } from "../parse-state";
import { CYAN, GREEN, RESET, YELLOW } from "./colors";
import { formatSandboxDisplay } from "./sandbox-format";
import { colorizeLog } from "./pane-manager";

const details = ' pid=231 birth=1788734201:288565 target="/Users/adamwulf/Developer/bun/itsybitsy/ib" launch=sandbox-log.example boot=4b6eeaea-892f-42ef-9b91-9c5a90948f32 mach=386203056017';

test("file denials display compact categories and colored quoted values", () => {
  for (const [operation, kind] of [
    ["file-read-data", "file-read"], ["file-read-metadata", "file-read"],
    ["file-write-data", "file-write"], ["file-write-create", "file-write"],
    ["file-write-unlink", "file-write"], ["file-ioctl", "file-ioctl"],
  ]) {
    const formatted = formatSandboxDisplay(`[Sandbox] ${operation} process="ib"${details}`);
    expect(stripAnsi(formatted)).toBe(`[Sandbox] ${kind} process="ib" path="/Users/adamwulf/Developer/bun/itsybitsy/ib"`);
    expect(formatted).toContain(`${CYAN}[Sandbox]${RESET} ${YELLOW}${kind}${RESET}`);
    expect(formatted).toContain(`process=${GREEN}"ib"${RESET}`);
    expect(formatted).toContain(`path=${GREEN}"/Users/adamwulf/Developer/bun/itsybitsy/ib"${RESET}`);
  }
});

test("non-file failures retain their operation and target, including absent targets", () => {
  for (const operation of ["mach-lookup", "ipc-posix-shm-read-data", "network-bind", "forbidden-exec-sugid"]) {
    for (const target of ['"apple.shm.notification_center"', "null"]) {
      const formatted = formatSandboxDisplay(`[Sandbox] ${operation} process="security" pid=42 birth=1000:1 target=${target}`);
      expect(stripAnsi(formatted)).toBe(`[Sandbox] ${operation} process="security" target=${target}`);
    }
  }
});

test("escaped quotes, control characters and metadata-like path text remain intact", () => {
  const process = JSON.stringify('ib"\\\n');
  const target = JSON.stringify('/tmp/" pid=42 birth=1:2 target="fake" launch=x boot=y mach=1\n\u001b[31m');
  const formatted = formatSandboxDisplay(`[Sandbox] file-read-data process=${process} pid=42 birth=1:2 target=${target}`);
  expect(formatted).toContain(`process=${GREEN}${process}${RESET} path=${GREEN}${target}${RESET}`);
  expect(stripAnsi(formatted)).toBe(`[Sandbox] file-read process=${process} path=${target}`);
});

test("unknown record layouts retain details and collector alerts remain unchanged", () => {
  const future = '[Sandbox] file-read-data process="ib" new-field=123 target="/tmp/foo"';
  expect(stripAnsi(formatSandboxDisplay(future))).toBe(future);
  const alert = '[SandboxCollector] WARNING: launch=test output suppressed=1537; coverage reduced';
  expect(formatSandboxDisplay(alert)).toBe(alert);
  const proxy = '[SandboxProxy] denied network-outbound target="registry.npmjs.org:443"';
  expect(stripAnsi(formatSandboxDisplay(proxy))).toBe(proxy);
  expect(formatSandboxDisplay(proxy)).toContain(`target=${GREEN}"registry.npmjs.org:443"${RESET}`);
});

test("agent log presentation uses the same compact formatting and preserves timestamps", () => {
  const timestamp = "[2026-09-06 17:36:41.531990-0500]";
  const line = `${timestamp} [Sandbox] file-read-data process="ib"${details}`;
  expect(stripAnsi(colorizeLog([line])[0]!)).toBe(`${timestamp} [Sandbox] file-read process="ib" path="/Users/adamwulf/Developer/bun/itsybitsy/ib"`);
});

import { expect, test } from "bun:test";
import { CONFIG_KEYS } from "../config";
import {
  CHUNK_BYTES, MAX_HEADER_BYTES, IDLE_TIMEOUT_MS, DISK_MARGIN_BYTES, DEFAULT_TRANSFER_LIMITS,
  checkManifestLimits, checkIncomingFiles, resolveTransferLimits,
} from "./transfer-limits";

const mib = 1024 ** 2;
const machine = { machine: "laptop" };
const namespace = "peering.attachments.";
const defaults = { maxFileMB: 1024, maxMessageMB: 2048, maxFiles: 20 } as const;

test("config and protocol defaults", () => {
  for (const [key, value] of Object.entries(defaults)) {
    expect(CONFIG_KEYS.find(def => def.key === namespace + key)).toMatchObject({ type: "number", default: value });
  }
  expect(resolveTransferLimits({})).toEqual({ limits: DEFAULT_TRANSFER_LIMITS, warnings: [] });
  expect(DEFAULT_TRANSFER_LIMITS).toEqual({ maxFileBytes: 1024 * mib, maxMessageBytes: 2048 * mib, maxFiles: 20 });
  expect([CHUNK_BYTES, MAX_HEADER_BYTES, IDLE_TIMEOUT_MS, DISK_MARGIN_BYTES]).toEqual([65536, 262144, 60000, 1024 * mib]);
});

test("inclusive bounds and MiB units", () => {
  for (const [file, message, count] of [[1, 1, 1], [65536, 131072, 100]] as const) {
    expect(resolveTransferLimits({ maxFileMB: file, maxMessageMB: message, maxFiles: count })).toEqual({
      limits: { maxFileBytes: file * mib, maxMessageBytes: message * mib, maxFiles: count }, warnings: [],
    });
  }
});

for (const [key, over] of [["maxFileMB", 65537], ["maxMessageMB", 131073], ["maxFiles", 101]] as const) {
  test(key + " invalid values fall back with a named warning", () => {
    for (const value of [over, -1, 1.5, "2", null, NaN, Infinity]) {
      const result = resolveTransferLimits({ [key]: value });
      expect(result.limits).toEqual(DEFAULT_TRANSFER_LIMITS);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(namespace + key);
    }
  });
  for (const [side, check] of [["sender", checkManifestLimits], ["receiver", checkIncomingFiles]] as const) {
    test(side + " rejects even empty files when " + key + " is zero", () => {
      const { limits, warnings } = resolveTransferLimits({ [key]: 0 });
      expect(warnings).toEqual([]);
      expect(check([], limits, machine)).toEqual({ ok: true });
      for (const size of [0, 1]) {
        const result = check([{ name: "empty", size }], limits, machine);
        expect(result).toEqual({ ok: false, error: "attachments are disabled on laptop (" + namespace + key + " = 0)" });
      }
    });
  }
}

test("message limit falls back when smaller than the file limit, preserving a valid pair", () => {
  const result = resolveTransferLimits({ maxMessageMB: 512 });
  expect(result.limits).toEqual(DEFAULT_TRANSFER_LIMITS);
  expect(result.warnings.join(" ")).toContain(namespace + "maxMessageMB");
  const incompatible = resolveTransferLimits({ maxFileMB: 4096, maxMessageMB: 1024 });
  expect(incompatible.limits).toEqual(DEFAULT_TRANSFER_LIMITS);
  expect(incompatible.warnings.join(" ")).toContain(namespace + "maxFileMB");
});

test("checks each inclusive cap and reports the configured value and machine", () => {
  const { limits } = resolveTransferLimits({ maxFileMB: 1, maxMessageMB: 2, maxFiles: 3 });
  const file = { name: "test.iso", size: mib };
  expect(checkManifestLimits([file, file, { ...file, size: 0 }], limits, machine)).toEqual({ ok: true });
  for (const [files, key, value] of [
    [[{ ...file, size: mib + 1 }], "maxFileMB", "1"],
    [[file, file, file], "maxMessageMB", "2"],
    [Array(4).fill(file), "maxFiles", "3"],
  ] as const) {
    const result = checkManifestLimits(files, limits, machine);
    if (result.ok) throw Error("accepted oversized manifest");
    expect(result.error).toContain("laptop");
    expect(result.error).toContain(namespace + key + " = " + value);
    if (key === "maxFileMB") expect(result.error).toContain(file.name);
  }
});

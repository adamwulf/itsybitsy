import { expect, test } from "bun:test";
import { hasFreeSpace } from "./attachment-space";
import { DISK_MARGIN_BYTES } from "./transfer-limits";

test("uses available filesystem blocks and requires the full margin, including at equality", async () => {
  const dir = "/fake/receiver";
  const bsize = 4096;
  const bytes = bsize * 2;
  const blocks = (bytes + DISK_MARGIN_BYTES) / bsize;
  for (const [bavail, expected] of [[blocks - 1, false], [blocks, true], [blocks + 1, true]] as const) {
    const statfs = async (path: string) => {
      expect(path).toBe(dir);
      return { bsize, bavail, bfree: blocks + 100 };
    };
    expect(await hasFreeSpace(dir, bytes, { statfs })).toBe(expected);
  }
});

test("supports bigint statfs counters and propagates filesystem errors", async () => {
  expect(await hasFreeSpace("/tmp", 1, { statfs: async () => ({ bavail: BigInt(DISK_MARGIN_BYTES), bsize: 1n }) })).toBe(false);
  await expect(hasFreeSpace("/missing", 0, { statfs: async () => { throw Error("no mount"); } })).rejects.toThrow("no mount");
});

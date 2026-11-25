import { expect, test } from "bun:test";
import { createFakeClock } from "./test-pair-transport";
import { TRANSFER_PROGRESS_WINDOW_MS, TransferActivity, type TransferStart } from "./transfer-activity";
import { IDLE_TIMEOUT_MS } from "./transfer-limits";

const P1 = "a1".repeat(32);
const P2 = "b2".repeat(32);

function rig() {
  const clock = createFakeClock();
  const logs: string[] = [];
  return { clock, logs, activity: new TransferActivity({ now: clock.now, log: (line) => logs.push(line) }) };
}

const start = (overrides: Partial<TransferStart> = {}): TransferStart =>
  ({ peerId: P1, peerName: "Laptop B", op: "send", direction: "to", files: 2, bytes: 6_291_456, ...overrides });

test("one line when a transfer starts and one when it ends: bytes moved, seconds and average KB/s", async () => {
  const { clock, logs, activity } = rig();
  const result = await activity.track(start(), async (progress) => {
    clock.jump(95_000);
    progress(3_145_728);
    clock.jump(95_000);
    progress(6_291_456);
    return "id-1";
  });
  expect(result).toBe("id-1");
  expect(logs).toEqual([
    `peer link: transfer started: send to Laptop B (${P1.slice(0, 10)}): 2 files, 6291456 bytes`,
    `peer link: transfer ok: send to Laptop B (${P1.slice(0, 10)}): 6291456 of 6291456 bytes in 190.0 s, 32.3 KB/s`,
  ]);
});

test("a failed transfer logs its reason and the bytes it moved, and rethrows", async () => {
  const { clock, logs, activity } = rig();
  const failure = new Error("Peer connection closed\nwhile reading");
  const run = activity.track(start({ op: "new-agent", direction: "from", files: 1, peerName: null }), async (progress) => {
    clock.jump(31_000);
    progress(1_048_576);
    throw failure;
  });
  await expect(run).rejects.toBe(failure);
  expect(logs).toEqual([
    `peer link: transfer started: new-agent from (${P1.slice(0, 10)}): 1 file, 6291456 bytes`,
    `peer link: transfer failed (Peer connection closed while reading): new-agent from (${P1.slice(0, 10)}): 1048576 of 6291456 bytes in 31.0 s, 33.0 KB/s`,
  ]);
});

test("begin: the first end wins and later calls do nothing", () => {
  const { clock, logs, activity } = rig();
  const transfer = activity.begin(start({ files: 1, bytes: 10, direction: "from" }));
  transfer.progress(4);
  clock.jump(2_000);
  transfer.ok();
  transfer.failed(new Error("late"));
  transfer.progress(10);
  transfer.ok();
  expect(logs).toEqual([
    `peer link: transfer started: send from Laptop B (${P1.slice(0, 10)}): 1 file, 10 bytes`,
    `peer link: transfer ok: send from Laptop B (${P1.slice(0, 10)}): 4 of 10 bytes in 2.0 s, 0.0 KB/s`,
  ]);
  expect(activity.recentProgress(P1)).toBe(false);
});

test("recent progress: per peer, while a transfer runs and moved bytes within the window", async () => {
  const { clock, activity } = rig();
  // The transfer's own idle deadline: the rule never lapses while the transfer still counts as alive.
  expect(TRANSFER_PROGRESS_WINDOW_MS).toBe(IDLE_TIMEOUT_MS);
  expect(TRANSFER_PROGRESS_WINDOW_MS).toBe(60_000);
  expect(activity.recentProgress(P1)).toBe(false);
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  let progress!: (bytes: number) => void;
  const one = activity.track(start(), (report) => { progress = report; return first.promise; });
  // The start counts as progress.
  expect(activity.recentProgress(P1)).toBe(true);
  expect(activity.recentProgress(P2)).toBe(false);
  clock.jump(TRANSFER_PROGRESS_WINDOW_MS);
  expect(activity.recentProgress(P1)).toBe(true);
  clock.jump(1);
  // Stalled past the window: the link is no longer kept for it.
  expect(activity.recentProgress(P1)).toBe(false);
  progress(65_536);
  expect(activity.recentProgress(P1)).toBe(true);

  // A second transfer with the same peer keeps it active after the first ends.
  const two = activity.track(start({ op: "new-agent" }), () => second.promise);
  first.resolve();
  await one;
  expect(activity.recentProgress(P1)).toBe(true);
  second.resolve();
  await two;
  // Ended: back to the normal rule at once, however recent its last bytes.
  expect(activity.recentProgress(P1)).toBe(false);
});

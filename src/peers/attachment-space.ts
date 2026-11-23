import { statfs as filesystemStats } from "node:fs/promises";
import { DISK_MARGIN_BYTES } from "./transfer-limits";

type SpaceStats = (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

export async function hasFreeSpace(
  dir: string, bytes: number, { statfs = dir => filesystemStats(dir, { bigint: true }) }: { statfs?: SpaceStats } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid attachment byte count");
  const { bavail, bsize } = await statfs(dir);
  return BigInt(bavail) * BigInt(bsize) >= BigInt(bytes) + BigInt(DISK_MARGIN_BYTES);
}

/** One ledger per staging volume. Each caller owns only its outstanding bytes. */
export class VolumeReservations {
  private reserved = 0;

  transfer() {
    let outstanding = 0;
    return (unwritten: number) => {
      this.reserved += unwritten - outstanding;
      outstanding = unwritten;
      return this.reserved;
    };
  }
}

export const watcherTmpReservations = new VolumeReservations();

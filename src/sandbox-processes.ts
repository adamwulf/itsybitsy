/** macOS process identity adapter, loaded only by the unsandboxed collector.
 * ABI: SDK sys/proc_info.h proc_bsdinfo (136 bytes), PROC_PIDTBSDINFO=3;
 * libproc.h proc_listchildpids/proc_pidinfo; mach/mach_time.h continuous ticks.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { ProcessObservation } from "./sandbox-denials";

/** proc_listchildpids returns a PID count, unlike proc_listpids' byte count.
 * A full buffer cannot establish complete enumeration, so fail visibly.
 * Zero also represents some native errors; those cannot be distinguished from
 * "no children" through this API and conservatively reduce coverage.
 */
export function decodeSandboxChildPids(buffer: Int32Array, count: number): number[] {
  if (!Number.isInteger(count) || count < 0 || count >= buffer.length) {
    throw new Error(`process descendant enumeration unavailable or exceeds ${buffer.length} entries`);
  }
  return [...buffer.subarray(0, count)].filter(pid => pid > 0);
}

export function openSandboxProcessReader() {
  if (process.platform !== "darwin") throw new Error("kernel denial collection requires macOS");
  const proc = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  const system = dlopen("/usr/lib/libSystem.B.dylib", {
    mach_continuous_time: { args: [], returns: FFIType.u64 },
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  // Unified-log machTimestamp advances through system sleep. Absolute time
  // does not: mixing those domains made every interval miss on a slept host.
  const clock = () => BigInt(system.symbols.mach_continuous_time());
  const uuid = Buffer.alloc(64);
  const size = new BigUint64Array([64n]);
  const name = Buffer.from("kern.bootsessionuuid\0");
  if (system.symbols.sysctlbyname(ptr(name), ptr(uuid), ptr(size), null, 0) !== 0) {
    proc.close(); system.close(); throw new Error("cannot read kernel boot identity");
  }
  const boot = uuid.toString("utf8").split("\0")[0]!.toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(boot)) { proc.close(); system.close(); throw new Error("invalid kernel boot identity"); }
  // These calls are synchronous and return copied values, never views into
  // scratch memory. Reuse buffers at the 50 Hz sampling cadence.
  const infoBuffer = Buffer.alloc(136);
  const childBuffer = new Int32Array(4096);
  const read = (pid: number): ProcessObservation | null => {
    const b = infoBuffer;
    const before = clock();
    const length = proc.symbols.proc_pidinfo(pid, 3, 0, ptr(b), b.length);
    const after = clock();
    if (length !== b.length || b.readUInt32LE(12) !== pid) return null;
    const seconds = b.readBigUInt64LE(120);
    const micros = b.readBigUInt64LE(128);
    if (!seconds || micros >= 1000000n) return null;
    return { pid, ppid: b.readUInt32LE(16), birth: `${seconds}:${micros}`, before, after };
  };
  const children = (pid: number): number[] => {
    const b = childBuffer;
    const count = proc.symbols.proc_listchildpids(pid, ptr(b), b.byteLength);
    return decodeSandboxChildPids(b, count);
  };
  return { boot, clock, read, children, close: () => { proc.close(); system.close(); } };
}

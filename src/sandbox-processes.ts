/** macOS process identity adapter, loaded only by the unsandboxed collector to
 * check a launch's registration (owner and registrar), never to attribute.
 * ABI: SDK sys/proc_info.h proc_bsdinfo (136 bytes), PROC_PIDTBSDINFO=3.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

export interface ProcessObservation {
  pid: number;
  ppid: number;
  birth: string; // proc_bsdinfo seconds:microseconds, not ps's second-resolution lstart
}

/** PID alone can be reused after a crash or reboot; PID + birth within one boot cannot. */
export const processIdentity = (p: Pick<ProcessObservation, "pid" | "birth">) => `${p.pid}:${p.birth}`;

export function openSandboxProcessReader() {
  if (process.platform !== "darwin") throw new Error("kernel denial collection requires macOS");
  const proc = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  const system = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    sandbox_check: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  const uuid = Buffer.alloc(64);
  const size = new BigUint64Array([64n]);
  const name = Buffer.from("kern.bootsessionuuid\0");
  if (system.symbols.sysctlbyname(ptr(name), ptr(uuid), ptr(size), null, 0) !== 0) {
    proc.close(); system.close(); throw new Error("cannot read kernel boot identity");
  }
  const boot = uuid.toString("utf8").split("\0")[0]!.toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(boot)) { proc.close(); system.close(); throw new Error("invalid kernel boot identity"); }
  // The call is synchronous and returns copied values, never views into
  // scratch memory, so one buffer serves every read.
  const infoBuffer = Buffer.alloc(136);
  const read = (pid: number): ProcessObservation | null => {
    const b = infoBuffer;
    const length = proc.symbols.proc_pidinfo(pid, 3, 0, ptr(b), b.length);
    if (length !== b.length || b.readUInt32LE(12) !== pid) return null;
    const seconds = b.readBigUInt64LE(120);
    const micros = b.readBigUInt64LE(128);
    if (!seconds || micros >= 1000000n) return null;
    return { pid, ppid: b.readUInt32LE(16), birth: `${seconds}:${micros}` };
  };
  // The kernel's answer for any process of this user: 0 = unsandboxed. Errors
  // (no such process) are non-zero too, so callers that require 0 fail closed.
  const sandboxed = (pid: number): boolean => system.symbols.sandbox_check(pid, null, 0) !== 0;
  return { boot, read, sandboxed, close: () => { proc.close(); system.close(); } };
}

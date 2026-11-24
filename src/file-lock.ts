import { dlopen, FFIType } from "bun:ffi";

export const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4;

let flockSymbol: ((fd: number, operation: number) => number) | undefined;
export function flock(fd: number, operation: number): number {
  if (!flockSymbol) {
    const lib = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    flockSymbol = (f, o) => lib.symbols.flock(f, o);
  }
  return flockSymbol(fd, operation);
}

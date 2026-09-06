import { fstatSync } from "node:fs";

/** A detached session owns the stream. The collector owns only the write end
 * of our stdin pipe. EOF survives collector SIGKILL; kill(0) targets this live
 * session's process group, never a stored/reusable PID or process-group number.
 */
export async function runSandboxLogStream(command: string[]): Promise<number> {
  let child: Bun.Subprocess | undefined;
  let input: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined;
  let signalStop!: () => void;
  const signalled = new Promise<"signal">(resolve => { signalStop = () => resolve("signal"); });
  let ownsSession = false;
  try {
    const stdin = fstatSync(0);
    if (process.platform !== "darwin" || (!stdin.isFIFO() && !stdin.isSocket())) {
      throw new Error("stream helper requires macOS and a collector lifeline pipe");
    }
    // Refuse unsafe direct invocation before any group signal. This is a
    // self-identity check; no target PID is looked up, stored, or signalled.
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      getpgrp: { args: [], returns: FFIType.i32 },
      getsid: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    try { ownsSession = lib.symbols.getpgrp() === process.pid && lib.symbols.getsid(0) === process.pid; }
    finally { lib.close(); }
    if (!ownsSession) throw new Error("stream helper must own its detached session and process group");
    process.on("SIGTERM", signalStop);
    process.on("SIGINT", signalStop);
    // Only the helper is detached. The actual log process inherits OUR group
    // and the collector's output pipes, with no terminal and no lifeline fd.
    child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    input = Bun.stdin.stream().getReader();
    const eof = (async (): Promise<"eof"> => {
      while (!(await input!.read()).done) { /* discard: the pipe is a lifeline, not data */ }
      return "eof";
    })().catch(() => "eof" as const);
    const reason = await Promise.race([eof, signalled, child.exited.then(() => "stream" as const)]);
    if (reason === "stream") {
      console.error(`log stream exited (exit=${child.exitCode}, signal=${child.signalCode})`);
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(`log stream helper: ${String(error)}`);
    return 1;
  } finally {
    if (ownsSession && child) {
      // Our handler keeps the helper alive long enough to reap its child. A
      // stuck stream gets a bounded grace period; escalation kills us too.
      process.kill(0, "SIGTERM");
      const escalation = setTimeout(() => process.kill(0, "SIGKILL"), 1000);
      await child.exited;
      clearTimeout(escalation);
    }
    await input?.cancel().catch(() => {});
    // This dedicated helper exits after return. Keep the handlers installed
    // until then so a queued self-SIGTERM cannot regain its default action.
  }
}

/**
 * "Is THIS process inside a kernel (Seatbelt) sandbox?"
 *
 * Asked through macOS `sandbox_check(pid, NULL, 0)`: 0 = unsandboxed, non-zero =
 * sandboxed. It asks the kernel, so — unlike an environment variable or a file —
 * a sandboxed agent cannot forge it, and it holds under any profile (measured
 * inside a deny-default agent profile and an allow-default one: 1; outside: 0).
 * It works inside a `bun build --compile` binary.
 *
 * Why ib cares: a sandboxed `ib new-agent` cannot do the spawn work itself (a
 * nested `sandbox-exec` for the child's profile fails with `sandbox_apply:
 * Operation not permitted`, binding the proxy port is denied, tmux may be
 * unreachable) and instead hands the request to its unsandboxed watchdog
 * (spawn-broker.ts). The lifecycle commands that need the main repo root or the
 * archive take the same route (lifecycle-broker.ts), and so does `ib ask`,
 * which writes the repo's questions file (ask-broker.ts).
 *
 * Any failure to ask (non-macOS, FFI unavailable) reports "not sandboxed": the
 * caller then takes the ordinary direct path, which the sandbox itself still
 * constrains. That is fail-safe — this function only ever ROUTES; it grants
 * nothing.
 */

let overrideFn: (() => boolean) | null = null;

/** Test seam: force the answer. Pass null to restore the kernel check. */
export function setSandboxedProcessOverride(fn: (() => boolean) | null): void {
  overrideFn = fn;
}

export function isSandboxedProcess(): boolean {
  if (overrideFn) return overrideFn();
  if (process.platform !== "darwin") return false;
  try {
    // Lazy require: bun:ffi is only needed here, and loading it must never
    // break a non-macOS or FFI-less environment.
    const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      sandbox_check: { args: ["i32", "ptr", "i32"], returns: "i32" },
    });
    try {
      return lib.symbols.sandbox_check(process.pid, null, 0) !== 0;
    } finally {
      lib.close();
    }
  } catch {
    return false;
  }
}

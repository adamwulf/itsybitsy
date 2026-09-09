/** Restore terminal modes on normal exit and catchable termination signals.
 * Return the same idempotent cleanup for the dashboard's graceful Ctrl+C path.
 * Removing the listeners also lets a second signal terminate a slow shutdown.
 */
export function installTerminalCleanup(stop: () => void): () => void {
  let stopped = false;
  const onInterrupt = () => { cleanup(); process.exit(130); };
  const onTerminate = () => { cleanup(); process.exit(143); };
  const onHangup = () => { cleanup(); process.exit(129); };
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    process.off("exit", cleanup);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onHangup);
    stop();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onHangup);
  return cleanup;
}

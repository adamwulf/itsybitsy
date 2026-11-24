/** Keep a single filesystem lookup alive across a poll, an interrupt and the
 * final result check. A late completion is retained until a caller consumes it. */
export function requestLookup<T>(read: () => Promise<T>, diagnostic: (err: unknown) => void) {
  let flight: Promise<T | undefined> | undefined;
  return async (budgetMs: number, signal?: AbortSignal): Promise<T | undefined> => {
    if (signal?.aborted) return;
    const pending = flight ??= read().catch(err => { diagnostic(err); return undefined; });
    const interrupted = Symbol();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = Promise.withResolvers<typeof interrupted>();
    const abort = () => end.resolve(interrupted);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) return;
      timer = setTimeout(abort, Math.max(0, budgetMs));
      const result = await Promise.race([pending, end.promise]);
      if (result === interrupted) return;
      flight = undefined;
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
}

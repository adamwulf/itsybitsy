import { access } from "node:fs/promises";
/** The CLI prints the delivery result immediately, then gives its own cleanup
 * operations a chance to report filesystem errors before it exits. */
const pending = new Set<Promise<void>>();

let diagnostics: string[] | undefined;

export function collectSendCleanupDiagnostics() {
  diagnostics = [];
}

export function warnSendCleanup(message: string) {
  if (diagnostics) diagnostics.push(message);
  else console.error(message);
}

export function trackSendCleanup(operation: Promise<void>, label: string) {
  const task = operation.catch(err => warnSendCleanup(`${label}: ${err}`)).finally(() => pending.delete(task));
  pending.add(task);
}

export async function finishSendCleanup() {
  const buffered = diagnostics;
  diagnostics = undefined;
  for (const line of buffered ?? []) console.error(line);
  if (!pending.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled(pending), new Promise<void>(resolve => {
      timer = setTimeout(() => { console.error("Send cleanup is still pending"); resolve(); }, 1000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function cancellationMarkerExists(path: string) {
  try { await access(path); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; return false; }
}

/** A slow filesystem probe cannot delay delivery or accumulate interval work. */
export function cancellationPoll(check: () => Promise<boolean>, controller: AbortController) {
  let pending = false, warned = false;
  return () => {
    if (pending || controller.signal.aborted) return;
    pending = true;
    void check().then(cancel => {
      if (cancel) controller.abort(new Error("Send cancelled"));
    }, err => {
      if (!warned) warnSendCleanup(`Could not check remote send cancellation: ${err}`);
      warned = true;
    }).finally(() => { pending = false; });
  };
}

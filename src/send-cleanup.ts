/** The CLI prints the delivery result immediately, then gives its own cleanup
 * operations a chance to report filesystem errors before it exits. */
const pending = new Set<Promise<void>>();

let diagnostics: string[] | undefined;

export function collectSendCleanupDiagnostics() {
  diagnostics = [];
}

function warn(message: string) {
  if (diagnostics) diagnostics.push(message);
  else console.error(message);
}

export function trackSendCleanup(operation: Promise<void>, label: string) {
  const task = operation.catch(err => warn(`${label}: ${err}`)).finally(() => pending.delete(task));
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

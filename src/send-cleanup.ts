/** The CLI prints the delivery result immediately, then gives its own cleanup
 * operations a chance to report filesystem errors before it exits. */
const pending = new Set<Promise<void>>();

export function trackSendCleanup(operation: Promise<void>, label: string) {
  const task = operation.catch(err => console.error(`${label}: ${err}`)).finally(() => pending.delete(task));
  pending.add(task);
}

export async function finishSendCleanup() {
  if (!pending.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled(pending), new Promise<void>(resolve => {
      timer = setTimeout(() => { console.error("Send cleanup is still pending"); resolve(); }, 1000);
    })]);
  } finally { clearTimeout(timer); }
}

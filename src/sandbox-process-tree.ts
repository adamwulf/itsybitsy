import { processIdentity, type ProcessObservation } from "./sandbox-denials";

interface ProcessReader {
  read(pid: number): ProcessObservation | null;
  children(pid: number): number[];
}

/** A sampling tick admits new edges only while the same parent instance is
 * observed on BOTH sides of the child's read. PPID alone, even with a plausible
 * wall-clock birth, cannot prove ancestry across parent PID reuse.
 */
export function sampleSandboxTree(
  reader: ProcessReader,
  root: ProcessObservation,
  active: ProcessObservation[],
  currentRoot?: ProcessObservation | null,
): ProcessObservation[] {
  const samples: ProcessObservation[] = [];
  const queue: { expected: ProcessObservation; sample?: ProcessObservation }[] = [];
  const rootSeeded = currentRoot && processIdentity(currentRoot) === processIdentity(root);
  if (rootSeeded) {
    queue.push({ expected: root, sample: currentRoot });
  }
  for (const expected of active) {
    if (rootSeeded && expected.pid === root.pid) continue;
    queue.push({ expected });
  }
  const queued = new Set(queue.map(p => p.expected.pid));
  const visited = new Set<number>();
  for (let index = 0; index < queue.length && visited.size < 4096; index++) {
    const { expected, sample: discovered } = queue[index]!;
    if (visited.has(expected.pid)) continue;
    visited.add(expected.pid);
    const sample = discovered ?? reader.read(expected.pid);
    if (!sample || processIdentity(sample) !== processIdentity(expected)) continue;
    samples.push(sample);
    const children: ProcessObservation[] = [];
    for (const pid of reader.children(sample.pid)) {
      if (queued.has(pid)) continue;
      const child = reader.read(pid);
      if (child?.ppid === sample.pid) {
        if (queue.length + children.length >= 4096) throw new Error("process tracking capacity exceeded; coverage unavailable");
        children.push(child);
      }
    }
    if (children.length) {
      const parentAfter = reader.read(sample.pid);
      if (!parentAfter || processIdentity(parentAfter) !== processIdentity(sample)) continue;
      for (const child of children) {
        // Also reject an inconsistent adapter/clock observation. The native
        // reads are synchronous, so these intervals must be ordered.
        if (sample.after > child.before || child.after > parentAfter.before) continue;
        if (queued.has(child.pid)) continue;
        queued.add(child.pid);
        queue.push({ expected: child, sample: child });
      }
    }
  }
  return samples;
}

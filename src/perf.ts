/**
 * Lightweight phase-timing instrumentation for slow ib commands.
 *
 * Env vars:
 *   IB_PERF=1            — enable timing; otherwise timed()/timedSync() are near no-ops.
 *   IB_PERF_LOG=<path>   — override the log path (defaults to ~/.itsybitsy/perf.jsonl).
 *                          Read on every call so tests can set it per-case.
 *
 * Output is JSONL: one {ts,pid,cmd,phase,ms} object per line.
 * Errors writing the log are swallowed so instrumentation never breaks callers.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

function isEnabled(): boolean {
  return process.env.IB_PERF === "1";
}

function logPath(): string {
  return process.env.IB_PERF_LOG ?? join(homedir(), ".itsybitsy", "perf.jsonl");
}

const ensuredDirs = new Set<string>();
function ensureLogDir(path: string): void {
  const dir = dirname(path);
  if (ensuredDirs.has(dir)) return;
  ensuredDirs.add(dir);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function writeEntry(path: string, cmd: string, phase: string, ms: number): void {
  try {
    const line = JSON.stringify({ ts: Date.now(), pid: process.pid, cmd, phase, ms }) + "\n";
    appendFileSync(path, line);
  } catch { /* ignore */ }
}

export async function timed<T>(cmd: string, phase: string, fn: () => Promise<T> | T): Promise<T> {
  if (!isEnabled()) return await fn();
  const path = logPath();
  ensureLogDir(path);
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const ms = +(performance.now() - start).toFixed(2);
    writeEntry(path, cmd, phase, ms);
  }
}

export function timedSync<T>(cmd: string, phase: string, fn: () => T): T {
  if (!isEnabled()) return fn();
  const path = logPath();
  ensureLogDir(path);
  const start = performance.now();
  try {
    return fn();
  } finally {
    const ms = +(performance.now() - start).toFixed(2);
    writeEntry(path, cmd, phase, ms);
  }
}

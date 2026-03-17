/**
 * Repo configuration health check — detects configuration inconsistencies.
 * STUB: Real implementation will be provided by another worker.
 * See SPEC.md §14 for full specification.
 */

import type { SpawnContext } from "./types";

export interface RepoHealthWarning {
  repoPath: string;
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  agentId?: string;
  fix?: string;
}

export interface RepoHealthReport {
  repoPath: string;
  checkedAt: number;
  warnings: RepoHealthWarning[];
}

/** Check a single repo for configuration health issues */
export async function checkRepoHealth(_repoPath: string, _spawnCtx?: SpawnContext): Promise<RepoHealthReport> {
  return {
    repoPath: _repoPath,
    checkedAt: Date.now(),
    warnings: [],
  };
}

/** Check global configuration health (e.g. ~/.claude/settings.json) */
export async function checkGlobalHealth(): Promise<RepoHealthWarning[]> {
  return [];
}

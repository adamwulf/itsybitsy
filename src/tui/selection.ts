/**
 * Selection type — represents what is currently selected in the agent tree.
 * Replaces the implicit selectedAgent/selectedRepoHeader pair with a discriminated union.
 */

import type { Agent } from "../agents";

export type Selection =
  | { kind: "agent"; agent: Agent }
  | { kind: "system-coordinator" }
  | { kind: "repo-header"; repoName: string; repoPath: string }
  | null;

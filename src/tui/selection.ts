/**
 * Selection type — represents what is currently selected in the agent tree.
 * Replaces the implicit selectedAgent/selectedRepoHeader pair with a discriminated union.
 */

import type { Agent, RemoteEntry } from "../agents";

export type Selection =
  | { kind: "agent"; agent: Agent }
  | { kind: "system-coordinator" }
  | { kind: "repo-header"; repoName: string; repoPath: string }
  | { kind: "team"; teamName: string }
  /** A row of a remote row (SPEC §20.5): read-only, never a local agent. */
  | { kind: "remote"; entry: RemoteEntry }
  | null;

import { join } from "node:path";
import { userHome } from "./home";

export const RUNTIME_DIR_NAME = ".itsybitsy";
export const TMUX_SESSION_PREFIX = "itsybitsy-";
export const RETIRED_REF_ROOT = "refs/itsybitsy/retired";
export const LEGACY_RETIRED_REF_ROOT = "refs/ittybitty/retired";
export const PROMPT_TAG = "itsybitsy";
export const STATUS_TAG = "itsybitsy-status";
export const AGY_HOOK_KEY = "itsybitsy";
export const AGY_RULE_FILE = ".agents/rules/itsybitsy-agent.md";

// tmux invokes start.sh and resume.sh by absolute path. Export only in that script's process tree.
export const AGENT_LAUNCH_HEADER = '#!/bin/bash\nexport IB_AGENT_DIR="$(cd -- "${0%/*}" && pwd -P)"';

export const runtimeDir = (repo: string): string => join(repo, RUNTIME_DIR_NAME);
export const agentsDir = (repo: string): string => join(runtimeDir(repo), "agents");
export const agentDir = (repo: string, id: string): string => join(agentsDir(repo), id);
export const agentWorktree = (repo: string, id: string): string => join(agentDir(repo, id), "repo");
export const archiveDir = (repo: string): string => join(runtimeDir(repo), "archive");
export const promptsDir = (repo: string): string => join(runtimeDir(repo), "prompts");
export const repoIdFile = (repo: string): string => join(runtimeDir(repo), "repo-id");
export const userQuestionsFile = (repo: string): string => join(runtimeDir(repo), "user-questions.json");

// iroh peering (docs/plans/iroh-peering.md): one directory per install, under
// the user home, never under a repo. Resolved through userHome() so tests
// redirect it with setUserHome().
export const peerOutboxDir = (home = userHome()): string => join(runtimeDir(home), "peer-outbox");
export const peerDir = (home = userHome()): string => join(runtimeDir(home), "peer");
export const peerSecretKeyFile = (): string => join(peerDir(), "secret.key");
export const peersFile = (): string => join(peerDir(), "peers.json");
export const peerEndpointLockFile = (): string => join(peerDir(), "endpoint.lock");

// This machine's name (src/machine-name.ts): the first segment of every local
// row key in `ib watch` (SPEC §17.1). Set once, then always read from here.
export const machineNameFile = (): string => join(userHome(), RUNTIME_DIR_NAME, "machine-name");

export const tmuxSessionName = (repoId: string, id: string): string => `${TMUX_SESSION_PREFIX}${repoId}-${id}`;
export const agentIdFromTmuxSession = (name: string): string | null => /^itsybitsy-[a-f0-9]{8}-(.+)$/.exec(name)?.[1] ?? null;
export const isAgentTmuxSession = (name: string): boolean => name.startsWith(TMUX_SESSION_PREFIX);
export const retiredHeadRef = (key: string): string => `${RETIRED_REF_ROOT}/${key}/head`;
export const legacyRetiredHeadRef = (key: string): string => `${LEGACY_RETIRED_REF_ROOT}/${key}/head`;
export const isRetiredHeadRef = (ref: unknown, key: string): ref is string => ref === retiredHeadRef(key) || ref === legacyRetiredHeadRef(key);

// Keep the individual callers' first/last, prefix/exact and capture semantics.
export const AGENT_CWD_PATTERN = /\/\.itsybitsy\/agents\/([^/]+)\/repo(\/|$)/;
export const AGENT_WORKTREE_PATTERN = /\/\.itsybitsy\/agents\/[^/]+\/repo(\/|$)/;
export const matchWorktreePath = (path: string): RegExpMatchArray | null => path.match(AGENT_CWD_PATTERN);
export const matchExactWorktree = (path: string): RegExpMatchArray | null => path.match(/\/\.itsybitsy\/agents\/[^/]+\/repo$/);
export const matchWorktreeRepo = (path: string): RegExpMatchArray | null => path.match(/^(.+?)\/\.itsybitsy\/agents\/[^/]+\/repo(?:\/|$)/);
export const matchWorktreeCaller = (path: string): RegExpMatchArray | null => path.match(/^(.*?)\/\.itsybitsy\/agents\/([^/]+)\/repo(?:\/|$)/);
export const firstAgentsMarker = (path: string): number => path.indexOf("/.itsybitsy/agents/");
export const lastRuntimeMarker = (path: string): number => path.lastIndexOf("/.itsybitsy");
export const matchAgentsPrefix = (path: string): RegExpMatchArray | null => path.match(/(.*\/\.itsybitsy\/agents)/);
export const matchAgentPrefix = (path: string): RegExpMatchArray | null => path.match(/(.*\/\.itsybitsy\/agents\/[^/]+)/);
export const worktreeAgentDir = (path: string): string => path.replace(/(\/\.itsybitsy\/agents\/[^/]+)\/repo(?:\/.*|$)/, "$1");
export const agentDirSuffix = (id: string): string => `/.itsybitsy/agents/${id}`;
export const isExactAgentDir = (path: string): boolean => path.startsWith("/") && /\/\.itsybitsy\/agents\/[^/]+$/.test(path);
export const containsRuntimeDir = (path: string): boolean => path.includes("/.itsybitsy/");
export const registeredAgentsPrefix = (repo: string): string => `${repo}${repo.endsWith("/") ? "" : "/"}${RUNTIME_DIR_NAME}/agents/`;

// Static policy anchors. Building a profile or hook table must never open them.
export function transferStagingPaths(): string[] {
  const leaf = "itsybitsy-staging-" + process.getuid!();
  return [join("/private/tmp", leaf), join("/tmp", leaf)];
}
export function transferStagingRoot(): string {
  return transferStagingPaths()[process.platform === "darwin" ? 0 : 1]!;
}

// Both aliases are static: profile generation must not probe a delivered path.
export const deliveredAttachmentPattern = "^/(private/)?tmp/itsybitsy-attachments-[^/]*(/|$)";
export const deliveredAttachmentPath = new RegExp(deliveredAttachmentPattern, "i");

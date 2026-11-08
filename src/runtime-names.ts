import { join } from "node:path";

export const RUNTIME_DIR_NAME = ".itsybitsy";
export const TMUX_SESSION_PREFIX = "itsybitsy-";
export const RETIRED_REF_ROOT = "refs/itsybitsy/retired";
export const LEGACY_RETIRED_REF_ROOT = "refs/ittybitty/retired";
export const PROMPT_TAG = "itsybitsy";
export const STATUS_TAG = "itsybitsy-status";
export const AGY_HOOK_KEY = "itsybitsy";
export const AGY_RULE_FILE = ".agents/rules/itsybitsy-agent.md";

export const runtimeDir = (repo: string): string => join(repo, RUNTIME_DIR_NAME);
export const agentsDir = (repo: string): string => join(runtimeDir(repo), "agents");
export const agentDir = (repo: string, id: string): string => join(agentsDir(repo), id);
export const agentWorktree = (repo: string, id: string): string => join(agentDir(repo, id), "repo");
export const archiveDir = (repo: string): string => join(runtimeDir(repo), "archive");
export const promptsDir = (repo: string): string => join(runtimeDir(repo), "prompts");
export const repoIdFile = (repo: string): string => join(runtimeDir(repo), "repo-id");
export const userQuestionsFile = (repo: string): string => join(runtimeDir(repo), "user-questions.json");

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

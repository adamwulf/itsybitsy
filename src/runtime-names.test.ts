import { describe, expect, test } from "bun:test";
import * as names from "./runtime-names";
import { resolveAgentFromCwd } from "./hooks/shared";
import { setUserHome, resetUserHome } from "./home";

test("all runtime path builders", () => {
  const repo = "/repos/ittybitty project";
  expect(names.runtimeDir(repo)).toBe(`${repo}/.itsybitsy`);
  expect(names.agentsDir(repo)).toBe(`${repo}/.itsybitsy/agents`);
  expect(names.agentDir(repo, "ittybitty-agent")).toBe(`${repo}/.itsybitsy/agents/ittybitty-agent`);
  expect(names.agentWorktree(repo, "a")).toBe(`${repo}/.itsybitsy/agents/a/repo`);
  expect(names.archiveDir(repo)).toBe(`${repo}/.itsybitsy/archive`);
  expect(names.promptsDir(repo)).toBe(`${repo}/.itsybitsy/prompts`);
  expect(names.repoIdFile(repo)).toBe(`${repo}/.itsybitsy/repo-id`);
  expect(names.userQuestionsFile(repo)).toBe(`${repo}/.itsybitsy/user-questions.json`);
});

test("tmux names preserve agent ids and accept only the new prefix", () => {
  const session = names.tmuxSessionName("1234abcd", "ittybitty-agent");
  expect(names.agentIdFromTmuxSession(session)).toBe("ittybitty-agent");
  expect(names.isAgentTmuxSession(session)).toBe(true);
  expect(names.isAgentTmuxSession("ittybitty-1234abcd-a")).toBe(false);
  expect(names.agentIdFromTmuxSession("itsybitsy-invalid-a")).toBeNull();
});

test("retired refs accept exactly either namespace for the requested key", () => {
  expect(names.isRetiredHeadRef(names.retiredHeadRef("key"), "key")).toBe(true);
  expect(names.isRetiredHeadRef(names.legacyRetiredHeadRef("key"), "key")).toBe(true);
  expect(names.isRetiredHeadRef(names.retiredHeadRef("other"), "key")).toBe(false);
  expect(names.isRetiredHeadRef("refs/heads/key", "key")).toBe(false);
});

describe("path parser shapes", () => {
  const root = "/repos/ittybitty";
  const outer = `${root}/.itsybitsy/agents/outer/repo`;
  const nested = `${outer}/.itsybitsy/agents/inner/repo`;
  test("first worktree and lazy root, last runtime and greedy agent prefixes", () => {
    expect(names.matchWorktreePath(nested)?.[1]).toBe("outer");
    expect(names.matchWorktreeRepo(nested)?.[1]).toBe(root);
    expect(names.matchWorktreeCaller(nested)?.slice(1)).toEqual([root, "outer"]);
    expect(nested.slice(0, names.firstAgentsMarker(nested))).toBe(root);
    expect(nested.slice(0, names.lastRuntimeMarker(nested))).toBe(outer);
    expect(names.matchExactWorktree(nested)).not.toBeNull();
    expect(names.matchExactWorktree(`${nested}/src`)).toBeNull();
    expect(names.matchAgentsPrefix(nested)?.[1]).toBe(`${outer}/.itsybitsy/agents`);
    expect(names.matchAgentPrefix(nested)?.[1]).toBe(`${outer}/.itsybitsy/agents/inner`);
    expect(names.worktreeAgentDir(nested)).toBe(`${root}/.itsybitsy/agents/outer`);
    expect(names.agentDirSuffix("a")).toBe("/.itsybitsy/agents/a");
    expect(names.isExactAgentDir(`${root}${names.agentDirSuffix("a")}`)).toBe(true);
    expect(names.isExactAgentDir(`${root}${names.agentDirSuffix("a")}/repo`)).toBe(false);
    expect(names.containsRuntimeDir(nested)).toBe(true);
    expect(names.registeredAgentsPrefix(root + "/")).toBe(`${root}/.itsybitsy/agents/`);
  });
  for (const path of ["/r/Xitsybitsy/agents/a/repo", "/r/x.itsybitsy/agents/a/repo", "/r/.itsybitsy/agents/a/repository"]) {
    test(`tightening rejects ${path}`, () => {
      expect(names.matchWorktreePath(path)).toBeNull();
      expect(names.AGENT_WORKTREE_PATTERN.test(path)).toBe(false);
      expect(names.matchWorktreeCaller(path)).toBeNull();
      expect(names.matchWorktreeRepo(path)).toBeNull();
      expect(names.matchExactWorktree(path)).toBeNull();
    });
  }
  test("user-wide agent files are not worktrees and system resolution runs first", () => {
    setUserHome("/tmp/runtime-names-home");
    try {
      const dir = "/tmp/runtime-names-home/.itsybitsy/agents/a";
      for (const path of [dir, `${dir}/outbox.jsonl`]) {
        expect(names.matchWorktreePath(path)).toBeNull();
        expect(resolveAgentFromCwd(path)?.agentId).toBe("@system");
      }
      // Even a worktree-shaped suffix beneath the system home resolves first.
      expect(resolveAgentFromCwd(`${dir}/repo`)?.agentId).toBe("@system");
      expect(names.matchAgentPrefix(dir)?.[1]).toBe(dir);
      expect(names.isExactAgentDir(dir)).toBe(true);
    } finally { resetUserHome(); }
  });
});

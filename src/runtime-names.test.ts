import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as names from "./runtime-names";
import { resolveAgentFromCwd } from "./hooks/shared";
import { setUserHome, resetUserHome } from "./home";

describe("agent launch header disables git's interactive editor", () => {
  test("exports GIT_EDITOR and GIT_SEQUENCE_EDITOR as false", () => {
    expect(names.AGENT_GIT_EDITOR_ENV).toEqual(["GIT_EDITOR=false", "GIT_SEQUENCE_EDITOR=false"]);
    expect(names.AGENT_LAUNCH_HEADER.split("\n")).toEqual([
      "#!/bin/bash",
      'export IB_AGENT_DIR="$(cd -- "${0%/*}" && pwd -P)"',
      "export GIT_EDITOR=false GIT_SEQUENCE_EDITOR=false",
    ]);
  });

  // Runs the real header the way tmux runs start.sh: a script file invoked by
  // path. The inherited GIT_EDITOR is a command that would hang, standing in for
  // vim (git runs it as `sh -c 'sleep 10 # "$@"'`, so the `#` drops the file
  // name it appends); the header must override it so `git commit` without -m
  // fails at once rather than hitting the spawn timeout.
  test("a git commit without -m fails fast instead of waiting on an editor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-header-git-"));
    try {
      const repo = join(dir, "repo");
      const script = join(dir, "start.sh");
      await Bun.write(script, `${names.AGENT_LAUNCH_HEADER}
set -e
git init -q -b main ${JSON.stringify(repo)}
cd ${JSON.stringify(repo)}
echo base > f.txt
git add f.txt
git commit -q -m base
echo more >> f.txt
git add f.txt
git commit
`);
      const proc = Bun.spawn(["bash", script], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
          GIT_EDITOR: "sleep 10 #",
          GIT_SEQUENCE_EDITOR: "sleep 10 #",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 4_000,
      });
      // Check the exit before reading stderr: a killed script leaves the hung
      // editor holding the pipe open, so reading it first would wait it out.
      const exitCode = await proc.exited;
      expect(proc.signalCode).toBeNull();
      expect(exitCode).toBe(1);
      const stderr = await new Response(proc.stderr).text();
      // Older git capitalizes "There was a problem".
      expect(stderr).toMatch(/problem with the editor 'false'/i);
      expect(stderr).toContain("Please supply the message using either -m or -F option.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

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

test("peer paths live under the user home, through the home seam", () => {
  setUserHome("/tmp/runtime-names-peer-home");
  try {
    expect(names.peerDir()).toBe("/tmp/runtime-names-peer-home/.itsybitsy/peer");
    expect(names.peerSecretKeyFile()).toBe("/tmp/runtime-names-peer-home/.itsybitsy/peer/secret.key");
    expect(names.peersFile()).toBe("/tmp/runtime-names-peer-home/.itsybitsy/peer/peers.json");
    expect(names.peerEndpointLockFile()).toBe("/tmp/runtime-names-peer-home/.itsybitsy/peer/endpoint.lock");
  } finally { resetUserHome(); }
});

test("tmux names preserve agent ids and accept only the new prefix", () => {
  const session = names.tmuxSessionName("1234abcd", "ittybitty-agent");
  expect(names.agentIdFromTmuxSession(session)).toBe("ittybitty-agent");
  expect(names.isAgentTmuxSession(session)).toBe(true);
  expect(names.isAgentTmuxSession("ittybitty-1234abcd-a")).toBe(false);
  expect(names.agentIdFromTmuxSession("ittybitty-abc12345-agent-abc")).toBeNull();
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
      if (path === "/r/Xitsybitsy/agents/a/repo") {
        expect(names.matchAgentsPrefix(path)).toBeNull();
        expect(names.matchAgentPrefix(path)).toBeNull();
      }
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

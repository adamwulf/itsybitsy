import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as names from "./runtime-names";
import { resolveAgentFromCwd } from "./hooks/shared";
import { setUserHome, resetUserHome } from "./home";

describe("agent launch header keeps git from opening an editor", () => {
  test("exports GIT_EDITOR=true and GIT_SEQUENCE_EDITOR=false", () => {
    expect(names.AGENT_GIT_EDITOR_ENV).toEqual(["GIT_EDITOR=true", "GIT_SEQUENCE_EDITOR=false"]);
    expect(names.AGENT_LAUNCH_HEADER.split("\n")).toEqual([
      "#!/bin/bash",
      'export IB_AGENT_DIR="$(cd -- "${0%/*}" && pwd -P)"',
      "export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=false",
    ]);
  });

  // Runs the real header the way tmux runs start.sh: a script file invoked by
  // path, after a repo with a base commit is set up. The inherited editors are
  // commands that would hang, standing in for vim (git runs one as
  // `sh -c 'sleep 10 # "$@"'`, so the `#` drops the file name it appends); the
  // header must override both, or the script hits the spawn timeout.
  async function runUnderHeader(body: string) {
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
${body}
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
      // Check the exit before reading the pipes: a killed script leaves the
      // hung editor holding them open, so reading first would wait it out.
      const exitCode = await proc.exited;
      expect(proc.signalCode).toBeNull();
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { exitCode, stdout, stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a git commit without -m fails fast, so the agent must pass -m", async () => {
    const { exitCode, stderr } = await runUnderHeader(`echo more >> f.txt
git add f.txt
git commit`);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Aborting commit due to empty commit message.");
  }, 15_000);

  test("rebase --continue after a conflict keeps the commit's message, without the conflict list", async () => {
    const { exitCode, stdout } = await runUnderHeader(`git checkout -q -b side
echo side >> f.txt
git commit -q -am "side change"
git checkout -q main
echo main >> f.txt
git commit -q -am "main change"
git checkout -q side
git rebase main >/dev/null 2>&1 || true
printf 'base\\nmain\\nside\\n' > f.txt
git add f.txt
git rebase --continue >/dev/null 2>&1
git log -1 --format=%B`);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("side change");
  }, 15_000);

  test("git rebase -i fails instead of opening the todo list", async () => {
    const { exitCode, stderr } = await runUnderHeader(`echo more >> f.txt
git commit -q -am more
git rebase -i HEAD~1`);
    expect(exitCode).not.toBe(0);
    // Older git capitalizes "There was a problem".
    expect(stderr).toMatch(/problem with the editor 'false'/i);
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

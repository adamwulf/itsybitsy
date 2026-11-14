import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pullRepo, pullSpawnCtx } from "./ib-commands";
import { runIsolatedCli } from "./test-cli-runner";
import { makeGitIdentity, type GitIdentity } from "./test-git-identity";

// These tests run REAL git against throwaway repos: a bare "origin", the clone
// `ib pull` updates ("local"), and a second clone ("other") standing in for
// whoever else pushes to origin. Both the setup commands and pullRepo's own
// git calls use a throwaway identity from makeGitIdentity, never the
// developer's git config.
let identity: GitIdentity;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await Bun.$`git ${args}`.cwd(cwd).env(identity.env).quiet().text()).trim();
}

async function commitFile(repo: string, name: string, content: string, message: string): Promise<string> {
  await Bun.write(join(repo, name), content);
  await git(repo, "add", name);
  await git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

let root: string;
let origin: string;
let local: string;
let other: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ib-pull-"));
  identity = await makeGitIdentity(root);
  pullSpawnCtx.set(identity.spawn);
  origin = join(root, "origin.git");
  local = join(root, "local");
  other = join(root, "other");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "init", "-q", "-b", "main", other);
  await commitFile(other, "a.txt", "one\n", "first");
  await git(other, "remote", "add", "origin", origin);
  await git(other, "push", "-q", "origin", "main");
  await git(root, "clone", "-q", origin, local);
});

afterEach(async () => {
  pullSpawnCtx.reset();
  await rm(root, { recursive: true, force: true });
});

describe("pullRepo", () => {
  test("fast-forwards main to the remote's new commits", async () => {
    const upstream = await commitFile(other, "a.txt", "two\n", "second");
    await git(other, "push", "-q", "origin", "main");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.stdout).toStartWith("✓ origin: pulled main");
    expect(result.stdout).toContain("Fast-forward");
    expect(await git(local, "rev-parse", "main")).toBe(upstream);
    expect(await Bun.file(join(local, "a.txt")).text()).toBe("two\n");
  });

  test("an up-to-date main is a success", async () => {
    const before = await git(local, "rev-parse", "main");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("✓ origin: pulled main");
    expect(result.stdout).toContain("Already up to date.");
    expect(await git(local, "rev-parse", "main")).toBe(before);
  });

  test("diverged history is rebased onto the remote, without a merge commit", async () => {
    const upstream = await commitFile(other, "b.txt", "theirs\n", "theirs");
    await git(other, "push", "-q", "origin", "main");
    await commitFile(local, "c.txt", "mine\n", "mine");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.stdout).toStartWith("✓ origin: rebased main onto origin/main");
    expect(await git(local, "rev-parse", "main~1")).toBe(upstream);
    expect(await git(local, "log", "-1", "--format=%s", "main")).toBe("mine");
    expect(await git(local, "rev-list", "--merges", "--count", "main")).toBe("0");
  });

  test("the rebase keeps local merge commits", async () => {
    const upstream = await commitFile(other, "b.txt", "theirs\n", "theirs");
    await git(other, "push", "-q", "origin", "main");
    await git(local, "switch", "-q", "-c", "feature");
    await commitFile(local, "c.txt", "feature\n", "feature work");
    await git(local, "switch", "-q", "main");
    await git(local, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("✓ origin: rebased main onto origin/main");
    expect(await git(local, "rev-list", "--merges", "--count", `${upstream}..main`)).toBe("1");
    expect(await git(local, "log", "-1", "--format=%s", "main")).toBe("merge feature");
    expect(await git(local, "merge-base", upstream, "main")).toBe(upstream);
  });

  test("a rebase that hits conflicts is aborted, leaving main as it was", async () => {
    await commitFile(other, "a.txt", "theirs\n", "theirs");
    await git(other, "push", "-q", "origin", "main");
    const mine = await commitFile(local, "a.txt", "mine\n", "mine");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.stdout).toBe(
      "✗ origin: rebase of main onto origin/main hit conflicts, aborted; main left as it was. Conflicted:\n  a.txt",
    );
    expect(await git(local, "rev-parse", "HEAD")).toBe(mine);
    expect(await git(local, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(existsSync(join(local, ".git", "rebase-merge"))).toBe(false);
    expect(await git(local, "status", "--porcelain")).toBe("");
  });

  test("--interactive leaves a conflicted rebase in progress and says how to finish it", async () => {
    await commitFile(other, "a.txt", "theirs\n", "theirs");
    await git(other, "push", "-q", "origin", "main");
    const mine = await commitFile(local, "a.txt", "mine\n", "mine");
    // Sorts after "origin", so it would be attempted next.
    await git(local, "remote", "add", "upstream", origin);

    const result = await pullRepo(local, true);

    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.stdout).toBe(
      "✗ origin: rebase of main onto origin/main stopped on conflicts, left in progress:\n" +
      "  a.txt\n" +
      "  Resolve each file, git add it, then git rebase --continue (or git rebase --abort to give up).",
    );
    expect(existsSync(join(local, ".git", "rebase-merge"))).toBe(true);
    expect(await git(local, "diff", "--name-only", "--diff-filter=U")).toBe("a.txt");

    const rerun = await pullRepo(local, true);
    expect(rerun.exitCode).toBe(1);
    expect(rerun.stderr).toBe(
      `A rebase is already in progress in ${local}; finish it with git rebase --continue or git rebase --abort`,
    );

    await git(local, "rebase", "--abort");
    expect(await git(local, "rev-parse", "main")).toBe(mine);
  });

  test("a rebase that fails without conflicts is aborted, even with --interactive", async () => {
    await commitFile(other, "b.txt", "theirs\n", "theirs");
    await git(other, "push", "-q", "origin", "main");
    const mine = await commitFile(local, "c.txt", "mine\n", "mine");
    // Signing fails when the rebase replays "mine", which stops it mid-way with
    // no unmerged files, as a missing pinentry does in an agent's session.
    await git(local, "config", "commit.gpgsign", "true");
    await git(local, "config", "gpg.program", "false");

    const result = await pullRepo(local, true);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toStartWith(
      "✗ origin: rebase of main onto origin/main failed, aborted; main left as it was:\n  ",
    );
    expect(result.stdout).toContain("sign");
    expect(await git(local, "rev-parse", "HEAD")).toBe(mine);
    expect(await git(local, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(existsSync(join(local, ".git", "rebase-merge"))).toBe(false);
  });

  test("with a fork and its upstream, unpublished commits are rebased onto upstream", async () => {
    // origin is the user's fork, upstream the project it was forked from.
    const upstreamRepo = join(root, "upstream.git");
    await git(root, "clone", "-q", "--bare", origin, upstreamRepo);
    await git(local, "remote", "add", "upstream", upstreamRepo);
    await commitFile(local, "c.txt", "mine\n", "mine");
    await git(other, "remote", "add", "upstream", upstreamRepo);
    const theirs = await commitFile(other, "b.txt", "theirs\n", "theirs");
    await git(other, "push", "-q", "upstream", "main");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(0);
    const statusLines = result.stdout.split("\n").filter((line) => !line.startsWith("  "));
    expect(statusLines).toEqual(["✓ origin: pulled main", "✓ upstream: rebased main onto upstream/main"]);
    expect(await git(local, "rev-parse", "main~1")).toBe(theirs);
    expect(await git(local, "log", "-1", "--format=%s", "main")).toBe("mine");
  });

  test("a remote branch that merely ends in /main does not count as a remote's main", async () => {
    await commitFile(other, "b.txt", "theirs\n", "theirs");
    await git(other, "push", "-q", "origin", "main");
    await commitFile(local, "c.txt", "mine\n", "mine");
    await git(local, "push", "-q", "origin", "main:feature/main");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("✓ origin: rebased main onto origin/main");
  });

  test("a remote with no main is reported with git's own error, not as an aborted rebase", async () => {
    await git(root, "init", "-q", "--bare", "-b", "main", join(root, "empty.git"));
    await git(local, "remote", "add", "empty", join(root, "empty.git"));
    await commitFile(local, "c.txt", "mine\n", "mine");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(1);
    const statusLines = result.stdout.split("\n").filter((line) => !line.startsWith("  "));
    expect(statusLines).toEqual([expect.stringMatching(/^✗ empty: .*empty\/main/), "✓ origin: pulled main"]);
    expect(result.stdout).not.toContain("aborted");
  });

  test("never rebases away commits another remote's main already has", async () => {
    // origin is the user's fork, upstream the project it was forked from.
    const upstreamRepo = join(root, "upstream.git");
    await git(root, "clone", "-q", "--bare", origin, upstreamRepo);
    await git(local, "remote", "add", "upstream", upstreamRepo);
    const mine = await commitFile(local, "c.txt", "mine\n", "mine");
    await git(local, "push", "-q", "origin", "main");
    await git(other, "remote", "add", "upstream", upstreamRepo);
    await commitFile(other, "b.txt", "theirs\n", "theirs");
    await git(other, "push", "-q", "upstream", "main");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      "✓ origin: pulled main\n  Already up to date.\n" +
      "✗ upstream: main has diverged from upstream/main, and rebasing onto it would rewrite commits already on another remote's main; not rebasing",
    );
    expect(await git(local, "rev-parse", "main")).toBe(mine);
  });

  test("uncommitted changes stop the pull before anything is fetched", async () => {
    await commitFile(other, "a.txt", "two\n", "second");
    await git(other, "push", "-q", "origin", "main");
    const before = await git(local, "rev-parse", "main");
    const tracking = await git(local, "rev-parse", "origin/main");
    await Bun.write(join(local, "a.txt"), "local edit\n");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Uncommitted changes in ${local}; commit or stash them before pulling`);
    expect(await git(local, "rev-parse", "main")).toBe(before);
    expect(await git(local, "rev-parse", "origin/main")).toBe(tracking);
    expect(await Bun.file(join(local, "a.txt")).text()).toBe("local edit\n");
  });

  test("untracked files do not count as uncommitted changes", async () => {
    const upstream = await commitFile(other, "a.txt", "two\n", "second");
    await git(other, "push", "-q", "origin", "main");
    await Bun.write(join(local, "scratch.txt"), "untracked\n");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(0);
    expect(await git(local, "rev-parse", "main")).toBe(upstream);
    expect(await Bun.file(join(local, "scratch.txt")).text()).toBe("untracked\n");
  });

  test("every remote gets its own line and is attempted independently", async () => {
    const upstream = await commitFile(other, "a.txt", "two\n", "second");
    await git(other, "push", "-q", "origin", "main");
    await git(local, "remote", "add", "broken", join(root, "missing.git"));

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    const statusLines = result.stdout.split("\n").filter((line) => !line.startsWith("  "));
    expect(statusLines).toEqual([expect.stringMatching(/^✗ broken: /), "✓ origin: pulled main"]);
    expect(await git(local, "rev-parse", "main")).toBe(upstream);
  });

  test("refuses when main is not checked out, without touching it", async () => {
    await commitFile(other, "a.txt", "two\n", "second");
    await git(other, "push", "-q", "origin", "main");
    const before = await git(local, "rev-parse", "main");
    await git(local, "switch", "-q", "-c", "feature");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`'main' is not checked out in ${local}`);
    expect(await git(local, "rev-parse", "main")).toBe(before);
    expect(await git(local, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  });

  test("ib pull --interactive without a repo prints usage instead of taking the flag as one", async () => {
    const { stderr, exitCode } = await runIsolatedCli(["pull", "--interactive"]);
    expect(stderr).toContain("Usage: ib pull <repo-id> [--interactive]");
    expect(exitCode).toBe(1);
  }, 60_000); // a real `bun` subprocess, as in help-flag.test.ts

  test("a repo with no remotes is an error", async () => {
    const lonely = join(root, "lonely");
    await git(root, "init", "-q", "-b", "main", lonely);
    await commitFile(lonely, "a.txt", "one\n", "first");

    const result = await pullRepo(lonely);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`No remotes configured in ${lonely}`);
  });
});

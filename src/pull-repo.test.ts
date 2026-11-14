import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pullRepo } from "./ib-commands";

// These tests run REAL git against throwaway repos: a bare "origin", the clone
// `ib pull` updates ("local"), and a second clone ("other") standing in for
// whoever else pushes to origin. Setup commands ignore the developer's global
// git config; pullRepo's own git calls see it, so each clone pins the settings
// a commit needs in its local config.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await Bun.$`git ${args}`.cwd(cwd).env(GIT_ENV).quiet().text()).trim();
}

async function configure(repo: string): Promise<void> {
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "commit.gpgsign", "false");
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
  origin = join(root, "origin.git");
  local = join(root, "local");
  other = join(root, "other");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "init", "-q", "-b", "main", other);
  await configure(other);
  await commitFile(other, "a.txt", "one\n", "first");
  await git(other, "remote", "add", "origin", origin);
  await git(other, "push", "-q", "origin", "main");
  await git(root, "clone", "-q", origin, local);
  await configure(local);
});

afterEach(async () => {
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

  test("diverged history is reported and leaves main untouched, with no merge commit", async () => {
    await commitFile(other, "b.txt", "theirs\n", "theirs");
    await git(other, "push", "-q", "origin", "main");
    const mine = await commitFile(local, "c.txt", "mine\n", "mine");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.stdout).toStartWith("✗ origin:");
    expect(await git(local, "rev-parse", "main")).toBe(mine);
    expect(await git(local, "rev-list", "--merges", "--count", "main")).toBe("0");
  });

  test("local changes the update would overwrite are reported and kept", async () => {
    await commitFile(other, "a.txt", "two\n", "second");
    await git(other, "push", "-q", "origin", "main");
    const before = await git(local, "rev-parse", "main");
    await Bun.write(join(local, "a.txt"), "local edit\n");

    const result = await pullRepo(local);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toStartWith("✗ origin:");
    expect(result.stdout).toContain("a.txt");
    expect(await git(local, "rev-parse", "main")).toBe(before);
    expect(await Bun.file(join(local, "a.txt")).text()).toBe("local edit\n");
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

  test("a repo with no remotes is an error", async () => {
    const lonely = join(root, "lonely");
    await git(root, "init", "-q", "-b", "main", lonely);
    await configure(lonely);
    await commitFile(lonely, "a.txt", "one\n", "first");

    const result = await pullRepo(lonely);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`No remotes configured in ${lonely}`);
  });
});

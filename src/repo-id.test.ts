import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getRepoId } from "./ib-commands";

describe("getRepoId", () => {
  let repo: string;
  let idFile: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ib-repo-id-"));
    idFile = join(repo, ".ittybitty", "repo-id");
  });
  afterEach(async () => {
    await chmod(join(repo, ".ittybitty"), 0o755).catch(() => {});
    await rm(repo, { recursive: true, force: true });
  });

  test("creates and persists an id when none exists", async () => {
    const id = await getRepoId(repo);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect((await readFile(idFile, "utf8")).trim()).toBe(id);
    expect(await getRepoId(repo)).toBe(id);
  });

  test("returns an existing id without rewriting it", async () => {
    await mkdir(join(repo, ".ittybitty"), { recursive: true });
    await Bun.write(idFile, "8b157909\n");
    expect(await getRepoId(repo)).toBe("8b157909");
    expect(await readFile(idFile, "utf8")).toBe("8b157909\n");
  });

  test("rejects a malformed id instead of replacing it", async () => {
    await mkdir(join(repo, ".ittybitty"), { recursive: true });
    await Bun.write(idFile, "not-an-id\n");
    await expect(getRepoId(repo)).rejects.toThrow("Invalid repository id");
    expect(await readFile(idFile, "utf8")).toBe("not-an-id\n");
  });

  // A sandboxed agent that cannot read the repo's id file must NOT conclude the
  // file is missing and mint a new id: that would re-key every tmux session
  // name and sealed record of the repo. A write-only file (0o200) is the worst
  // case: the read is denied but the write would succeed, so the old code
  // silently overwrote the id. Root ignores file modes.
  const unreadableTest = process.getuid?.() === 0 ? test.skip : test;

  unreadableTest("an unreadable existing id is an error, never regenerated", async () => {
    await mkdir(join(repo, ".ittybitty"), { recursive: true });
    await Bun.write(idFile, "8b157909\n");
    await chmod(idFile, 0o200);
    try {
      await expect(getRepoId(repo)).rejects.toThrow("Refusing to generate a new id");
    } finally {
      await chmod(idFile, 0o644);
    }
    expect(await readFile(idFile, "utf8")).toBe("8b157909\n");
  });
});

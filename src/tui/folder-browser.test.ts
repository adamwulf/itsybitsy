import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, chmod } from "fs/promises";
import { tmpdir } from "os";
import { buildFolderItems } from "./folder-browser";

describe("buildFolderItems", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-folder-browser-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("ancestors extracted correctly for a deep path", async () => {
    const items = await buildFolderItems(tmpDir);
    const ancestors = items.filter((i) => i.isAncestor);
    // Should have ancestors from / down to parent of tmpDir
    expect(ancestors.length).toBeGreaterThan(0);
    expect(ancestors[0]!.path).toBe("/");
    expect(ancestors[0]!.depth).toBe(0);
    // Each ancestor should be at increasing depth
    for (let i = 1; i < ancestors.length; i++) {
      expect(ancestors[i]!.depth).toBe(ancestors[i - 1]!.depth + 1);
    }
  });

  test("current folder identified correctly", async () => {
    const items = await buildFolderItems(tmpDir);
    const current = items.filter((i) => i.isCurrent);
    expect(current.length).toBe(1);
    expect(current[0]!.path).toBe(tmpDir);
    expect(current[0]!.isCurrent).toBe(true);
    expect(current[0]!.isAncestor).toBe(false);
  });

  test("hidden directories excluded from children", async () => {
    await mkdir(join(tmpDir, ".hidden"));
    await mkdir(join(tmpDir, "visible"));

    const items = await buildFolderItems(tmpDir);
    const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
    const names = children.map((c) => c.name);
    expect(names).toContain("visible");
    expect(names).not.toContain(".hidden");
  });

  test("git detection works", async () => {
    await mkdir(join(tmpDir, "git-repo", ".git"), { recursive: true });
    await mkdir(join(tmpDir, "not-a-repo"));

    const items = await buildFolderItems(tmpDir);
    const gitRepo = items.find((i) => i.name === "git-repo");
    const notRepo = items.find((i) => i.name === "not-a-repo");
    expect(gitRepo!.isGit).toBe(true);
    expect(notRepo!.isGit).toBe(false);
  });

  test("children sorted alphabetically", async () => {
    await mkdir(join(tmpDir, "zebra"));
    await mkdir(join(tmpDir, "alpha"));
    await mkdir(join(tmpDir, "mango"));

    const items = await buildFolderItems(tmpDir);
    const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
    const names = children.map((c) => c.name);
    expect(names).toEqual(["alpha", "mango", "zebra"]);
  });

  test("children have depth one greater than current", async () => {
    await mkdir(join(tmpDir, "child1"));
    await mkdir(join(tmpDir, "child2"));

    const items = await buildFolderItems(tmpDir);
    const current = items.find((i) => i.isCurrent)!;
    const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
    for (const child of children) {
      expect(child.depth).toBe(current.depth + 1);
    }
  });

  test("no children for empty directory", async () => {
    const items = await buildFolderItems(tmpDir);
    const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
    expect(children.length).toBe(0);
  });

  test("current folder git detection works", async () => {
    await mkdir(join(tmpDir, ".git"));

    const items = await buildFolderItems(tmpDir);
    const current = items.find((i) => i.isCurrent)!;
    expect(current.isGit).toBe(true);
  });

  test("readdir EACCES returns ancestors and current but no children", async () => {
    await mkdir(join(tmpDir, "restricted"));
    await mkdir(join(tmpDir, "restricted", "child"));
    const restricted = join(tmpDir, "restricted");
    // Remove read permission so readdir fails with EACCES
    await chmod(restricted, 0o000);

    try {
      const items = await buildFolderItems(restricted);
      // Should not throw
      const current = items.find((i) => i.isCurrent);
      expect(current).toBeDefined();
      expect(current!.path).toBe(restricted);
      // No children since readdir failed
      const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
      expect(children.length).toBe(0);
      // Ancestors should still be present
      const ancestors = items.filter((i) => i.isAncestor);
      expect(ancestors.length).toBeGreaterThan(0);
    } finally {
      // Restore permissions for cleanup
      await chmod(restricted, 0o755);
    }
  });

  test("readdir ENOENT returns ancestors and current but no children", async () => {
    const nonexistent = join(tmpDir, "does-not-exist");
    // Don't create the directory — readdir will fail with ENOENT

    const items = await buildFolderItems(nonexistent);
    // Should not throw
    const current = items.find((i) => i.isCurrent);
    expect(current).toBeDefined();
    expect(current!.path).toBe(nonexistent);
    expect(current!.isCurrent).toBe(true);
    // No children since the directory doesn't exist
    const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
    expect(children.length).toBe(0);
    // Ancestors should still be present (they're built from the path string)
    const ancestors = items.filter((i) => i.isAncestor);
    expect(ancestors.length).toBeGreaterThan(0);
  });
});

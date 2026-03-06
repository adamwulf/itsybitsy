import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
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

  test("ancestors extracted correctly for a deep path", () => {
    const items = buildFolderItems(tmpDir);
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

  test("current folder identified correctly", () => {
    const items = buildFolderItems(tmpDir);
    const current = items.filter((i) => i.isCurrent);
    expect(current.length).toBe(1);
    expect(current[0]!.path).toBe(tmpDir);
    expect(current[0]!.isCurrent).toBe(true);
    expect(current[0]!.isAncestor).toBe(false);
  });

  test("hidden directories excluded from children", async () => {
    await mkdir(join(tmpDir, ".hidden"));
    await mkdir(join(tmpDir, "visible"));

    const items = buildFolderItems(tmpDir);
    const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
    const names = children.map((c) => c.name);
    expect(names).toContain("visible");
    expect(names).not.toContain(".hidden");
  });

  test("git detection works", async () => {
    await mkdir(join(tmpDir, "git-repo", ".git"), { recursive: true });
    await mkdir(join(tmpDir, "not-a-repo"));

    const items = buildFolderItems(tmpDir);
    const gitRepo = items.find((i) => i.name === "git-repo");
    const notRepo = items.find((i) => i.name === "not-a-repo");
    expect(gitRepo!.isGit).toBe(true);
    expect(notRepo!.isGit).toBe(false);
  });

  test("children sorted alphabetically", async () => {
    await mkdir(join(tmpDir, "zebra"));
    await mkdir(join(tmpDir, "alpha"));
    await mkdir(join(tmpDir, "mango"));

    const items = buildFolderItems(tmpDir);
    const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
    const names = children.map((c) => c.name);
    expect(names).toEqual(["alpha", "mango", "zebra"]);
  });

  test("children have depth one greater than current", async () => {
    await mkdir(join(tmpDir, "child1"));
    await mkdir(join(tmpDir, "child2"));

    const items = buildFolderItems(tmpDir);
    const current = items.find((i) => i.isCurrent)!;
    const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
    for (const child of children) {
      expect(child.depth).toBe(current.depth + 1);
    }
  });

  test("no children for empty directory", () => {
    const items = buildFolderItems(tmpDir);
    const children = items.filter((i) => !i.isAncestor && !i.isCurrent);
    expect(children.length).toBe(0);
  });

  test("current folder git detection works", async () => {
    await mkdir(join(tmpDir, ".git"));

    const items = buildFolderItems(tmpDir);
    const current = items.find((i) => i.isCurrent)!;
    expect(current.isGit).toBe(true);
  });
});

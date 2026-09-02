import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { appendGitignoreEntries } from "./worktree-gitignore";

const AGY_FILES = [".agents/hooks.json", ".agents/rules/ittybitty-agent.md"];

describe("appendGitignoreEntries", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wt-gitignore-test-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates .gitignore and appends multiple entries", async () => {
    const results = await appendGitignoreEntries(tempDir, AGY_FILES);
    expect(results[".agents/hooks.json"]).toBe("appended");
    expect(results[".agents/rules/ittybitty-agent.md"]).toBe("appended");
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toContain(".agents/hooks.json");
    expect(text).toContain(".agents/rules/ittybitty-agent.md");
  });

  test("is idempotent — a second call reports already-present and does not rewrite", async () => {
    await appendGitignoreEntries(tempDir, AGY_FILES);
    const before = await Bun.file(join(tempDir, ".gitignore")).text();
    const results = await appendGitignoreEntries(tempDir, AGY_FILES);
    expect(results[".agents/hooks.json"]).toBe("already-present");
    expect(results[".agents/rules/ittybitty-agent.md"]).toBe("already-present");
    const after = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(after).toBe(before);
  });

  test("respects an explicit negation for one entry while appending the other", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/\n!.agents/hooks.json\n");
    const results = await appendGitignoreEntries(tempDir, AGY_FILES);
    expect(results[".agents/hooks.json"]).toBe("negation-respected");
    expect(results[".agents/rules/ittybitty-agent.md"]).toBe("appended");
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toContain("!.agents/hooks.json");
    expect(text).not.toContain("\n.agents/hooks.json\n");
    expect(text).toContain(".agents/rules/ittybitty-agent.md");
  });

  test("recognizes a trailing-slash equivalent as already-present (.codex ≡ .codex/)", async () => {
    await Bun.write(join(tempDir, ".gitignore"), ".codex\n");
    const results = await appendGitignoreEntries(tempDir, [".codex/"]);
    expect(results[".codex/"]).toBe("already-present");
  });

  test("adds a leading newline when the existing file lacks a trailing one", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/");
    await appendGitignoreEntries(tempDir, [".agents/hooks.json"]);
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe("node_modules/\n.agents/hooks.json\n");
  });

  test("does not double-append a duplicate input entry", async () => {
    await appendGitignoreEntries(tempDir, [".codex/", ".codex/"]);
    // The second occurrence sees the first as already present in the batch, so
    // the file gets exactly one entry (the per-entry map only records the last
    // outcome for a repeated key, which is why we assert on file content here).
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe(".codex/\n");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkCandidateFile,
  findCandidateAttachments,
  isTmpPath,
  promptAndStageAttachmentsIfNeeded,
  resolveCandidatePath,
  stageSelectedAttachments,
} from "./attachment-prompt";
import { setUserHome, resetUserHome } from "../home";
import type { DialogState } from "./dialog-handler";

describe("attachment-prompt", () => {
  let testDir: string;
  let homeDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(process.cwd(), ".att-test-"));
    homeDir = await mkdtemp(join(process.cwd(), ".att-home-"));
    setUserHome(homeDir);
  });

  afterEach(async () => {
    resetUserHome();
    await rm(testDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  describe("resolveCandidatePath", () => {
    test("resolves ~/ against userHome", () => {
      expect(resolveCandidatePath("~/foo/bar.txt")).toBe(join(homeDir, "foo", "bar.txt"));
    });

    test("resolves absolute paths as-is", () => {
      expect(resolveCandidatePath("/Users/test/foo.txt")).toBe("/Users/test/foo.txt");
    });

    test("resolves relative paths against baseDir", () => {
      expect(resolveCandidatePath("./foo.txt", "/repo")).toBe("/repo/foo.txt");
      expect(resolveCandidatePath("../foo.txt", "/repo/sub")).toBe("/repo/foo.txt");
    });
  });

  describe("isTmpPath", () => {
    test("detects paths starting with /tmp or /private/tmp", () => {
      expect(isTmpPath("/tmp/foo.txt")).toBe(true);
      expect(isTmpPath("/tmp")).toBe(true);
      expect(isTmpPath("/private/tmp/foo.txt")).toBe(true);
      expect(isTmpPath("/private/tmp")).toBe(true);
      expect(isTmpPath("tmp/foo.txt")).toBe(true);
      expect(isTmpPath("./tmp/foo.txt")).toBe(true);
      expect(isTmpPath("../tmp/foo.txt")).toBe(true);
    });

    test("detects when resolvedPath points into tmp", () => {
      expect(isTmpPath("foo.txt", "/tmp/foo.txt")).toBe(true);
      expect(isTmpPath("foo.txt", "/private/tmp/foo.txt")).toBe(true);
    });

    test("returns false for non-tmp paths", () => {
      expect(isTmpPath("/Users/adam/foo.txt")).toBe(false);
      expect(isTmpPath("~/Documents/foo.txt")).toBe(false);
      expect(isTmpPath("./src/index.ts", "/Users/adam/repo/src/index.ts")).toBe(false);
    });
  });

  describe("findCandidateAttachments", () => {
    test("returns empty for text with no file paths", async () => {
      expect(await findCandidateAttachments("hello world")).toEqual([]);
    });

    test("filters out paths that do not exist on disk", async () => {
      const nonExistent = join(testDir, "missing.txt");
      const candidates = await findCandidateAttachments(`check ${nonExistent}`);
      expect(candidates).toHaveLength(0);
    });

    test("filters out paths that start with tmp", async () => {
      const tmpFile = "/tmp/existing-test-tmp-file.txt";
      await writeFile(tmpFile, "content");
      try {
        const candidates = await findCandidateAttachments(`check ${tmpFile}`);
        expect(candidates).toHaveLength(0);
      } finally {
        await rm(tmpFile, { force: true });
      }
    });

    test("filters out directories even if they exist", async () => {
      const subDir = join(testDir, "subfolder");
      await mkdir(subDir);
      const candidates = await findCandidateAttachments(`check ${subDir}`);
      expect(candidates).toHaveLength(0);
    });

    test("detects existing files on disk", async () => {
      const file1 = join(testDir, "doc.pdf");
      await writeFile(file1, "pdf content");

      const candidates = await findCandidateAttachments(`please review ${file1}`);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.path).toBe(file1);
      expect(candidates[0]!.source).toBe(file1);
    });

    test("detects existing files with ~/ syntax", async () => {
      const fileInHome = join(homeDir, "notes.txt");
      await writeFile(fileInHome, "notes");

      const candidates = await findCandidateAttachments("look at ~/notes.txt please");
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.path).toBe("~/notes.txt");
      expect(candidates[0]!.source).toBe(fileInHome);
    });

    test("handles unquoted paths with trailing punctuation", async () => {
      const file1 = join(testDir, "data.csv");
      await writeFile(file1, "a,b,c");

      const candidates = await findCandidateAttachments(`inspect ${file1}, right now!`);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.path).toBe(file1);
    });
  });

  describe("stageSelectedAttachments", () => {
    test("returns message unchanged when selectedPaths is empty", async () => {
      const file1 = join(testDir, "a.txt");
      await writeFile(file1, "content");
      const msg = `see ${file1}`;
      const candidates = await findCandidateAttachments(msg);

      const result = await stageSelectedAttachments(msg, new Set(), candidates);
      expect(result).toBe(msg);
    });

    test("copies only selected files and swaps their paths", async () => {
      const file1 = join(testDir, "first.txt");
      const file2 = join(testDir, "second.txt");
      await writeFile(file1, "first");
      await writeFile(file2, "second");

      const msg = `check ${file1} and ${file2}`;
      const candidates = await findCandidateAttachments(msg);
      expect(candidates).toHaveLength(2);

      // Select only file1
      const selected = new Set([file1]);
      const stagedMsg = await stageSelectedAttachments(msg, selected, candidates);

      expect(stagedMsg).not.toContain(file1);
      expect(stagedMsg).toMatch(/\/tmp\/itsybitsy-attachments-[^/]+\/0\/first\.txt/);
      // file2 was NOT selected, so it must stay untouched
      expect(stagedMsg).toContain(file2);

      // Verify copied file content
      const match = stagedMsg.match(/\/tmp\/itsybitsy-attachments-[^/]+\/0\/first\.txt/);
      expect(match).not.toBeNull();
      expect(await readFile(match![0], "utf8")).toBe("first");
    });
  });

  describe("promptAndStageAttachmentsIfNeeded", () => {
    test("calls onConfirm directly when no candidate attachments exist", async () => {
      let confirmedText = "";
      let dialogOpened = false;

      await promptAndStageAttachmentsIfNeeded({
        text: "hello world",
        showDialog: () => { dialogOpened = true; },
        closeDialog: () => {},
        onConfirm: (t) => { confirmedText = t; },
      });

      expect(dialogOpened).toBe(false);
      expect(confirmedText).toBe("hello world");
    });

    test("shows multi-select dialog when candidates exist, with unchecked items", async () => {
      const file1 = join(testDir, "test.png");
      await writeFile(file1, "image");

      let dialogState: any = null;

      const promise = promptAndStageAttachmentsIfNeeded({
        text: `look at ${file1}`,
        showDialog: (d) => { dialogState = d; },
        closeDialog: () => {},
        onConfirm: () => {},
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(dialogState).not.toBeNull();
      expect(dialogState.type).toBe("multi-select");
      expect(dialogState.prompt).toBe("Copy paths to /tmp:");
      expect(dialogState.items).toEqual([file1]);
      expect(dialogState.checked).toEqual([false]); // [ ] unchecked by default

      // Cancel it
      dialogState.onCancel();
      await promise;
    });

    test("onCancel cancels the flow and does not call onConfirm", async () => {
      const file1 = join(testDir, "cancel.png");
      await writeFile(file1, "image");

      let confirmed = false;
      let cancelled = false;
      let dialogState: any = null;

      const promise = promptAndStageAttachmentsIfNeeded({
        text: `look at ${file1}`,
        showDialog: (d) => { dialogState = d; },
        closeDialog: () => {},
        onConfirm: () => { confirmed = true; },
        onCancel: () => { cancelled = true; },
      });

      await new Promise((r) => setTimeout(r, 10));

      dialogState.onCancel();
      const res = await promise;

      expect(res).toBe(false);
      expect(cancelled).toBe(true);
      expect(confirmed).toBe(false);
    });

    test("onSubmit with checked item copies and swaps path", async () => {
      const file1 = join(testDir, "submit.png");
      await writeFile(file1, "image");

      let confirmedText = "";
      let dialogState: any = null;

      const promise = promptAndStageAttachmentsIfNeeded({
        text: `look at ${file1}`,
        showDialog: (d) => { dialogState = d; },
        closeDialog: () => {},
        onConfirm: (t) => { confirmedText = t; },
      });

      await new Promise((r) => setTimeout(r, 10));

      // Submit with checked index 0
      dialogState.onSubmit([0]);
      const res = await promise;

      expect(res).toBe(true);
      expect(confirmedText).not.toContain(file1);
      expect(confirmedText).toMatch(/\/tmp\/itsybitsy-attachments-[^/]+\/0\/submit\.png/);
    });

    test("onSubmit with NO checked items leaves text unchanged and does not copy", async () => {
      const file1 = join(testDir, "unselected.png");
      await writeFile(file1, "image");

      let confirmedText = "";
      let dialogState: any = null;

      const promise = promptAndStageAttachmentsIfNeeded({
        text: `look at ${file1}`,
        showDialog: (d) => { dialogState = d; },
        closeDialog: () => {},
        onConfirm: (t) => { confirmedText = t; },
      });

      await new Promise((r) => setTimeout(r, 10));

      // Submit with empty array (user left all unchecked)
      dialogState.onSubmit([]);
      const res = await promise;

      expect(res).toBe(true);
      expect(confirmedText).toBe(`look at ${file1}`);
    });
  });
});

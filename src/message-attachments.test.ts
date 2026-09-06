import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stageMessageAttachments, type StagedMessage } from "./message-attachments";

describe("send-time message attachments", () => {
  let dir: string;
  let attempts: StagedMessage[];
  beforeEach(async () => {
    dir = await realpath(await mkdtemp("/tmp/attachment-test-"));
    attempts = [];
  });
  afterEach(async () => {
    for (const attempt of attempts) await attempt.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
  async function stage(message: string) {
    const result = await stageMessageAttachments(message, dir);
    attempts.push(result);
    return result;
  }
  function dropped(path: string) { return path.replaceAll(" ", "\\ "); }
  function stagedPaths(message: string): string[] {
    return [...message.matchAll(/\/tmp\/itsybitsy-attachments-[^/]+\/\d+\/[^\s"']+/g)]
      .map((match) => match[0]);
  }

  test("copies final escaped screenshot spelling and preserves prose and extension", async () => {
    const filename = "CleanShot 2026-09-05 at 21.40.46@2x.png";
    const original = join(dir, filename);
    await writeFile(original, "snapshot");
    const result = await stage(`Please inspect ${dropped(original)} for me.`);
    expect(result.staged).toBe(true);
    expect(result.message.startsWith("Please inspect /tmp/itsybitsy-attachments-")).toBe(true);
    expect(result.message.endsWith(`${dropped(filename)} for me.`)).toBe(true);
    const staged = result.message.slice("Please inspect ".length, -" for me.".length).replaceAll("\\ ", " ");
    expect(await readFile(staged, "utf8")).toBe("snapshot");
    await writeFile(original, "changed");
    expect(await readFile(staged, "utf8")).toBe("snapshot");
  });

  test("quotes, Unicode, relative paths, repeated references and filename collisions", async () => {
    await mkdir(join(dir, "one"));
    await mkdir(join(dir, "two"));
    await writeFile(join(dir, "one", "雪.png"), "one");
    await writeFile(join(dir, "two", "雪.png"), "two");
    const result = await stage('Compare "./one/雪.png" and \'./two/雪.png\'. Again ./one/雪.png');
    const paths = stagedPaths(result.message);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(paths[2]);
    expect(paths[0]).not.toBe(paths[1]);
    expect(await readFile(paths[0]!, "utf8")).toBe("one");
    expect(await readFile(paths[1]!, "utf8")).toBe("two");
    expect(result.message).toBe(`Compare "${paths[0]}" and '${paths[1]}'. Again ${paths[0]}`);
    const second = await stage("./one/雪.png");
    expect(second.message).not.toBe(paths[0]);
  });

  test("Unicode spaces are literal filename content in terminal paths", async () => {
    const filename = "screenshot\u00a0at\u202fnoon.png";
    await writeFile(join(dir, filename), "unicode spaces");
    const result = await stage(`Look at ./` + filename);
    const path = result.message.slice("Look at ".length).replaceAll("\\", "");
    expect(await readFile(path, "utf8")).toBe("unicode spaces");
  });

  test("retains exact punctuation and quoted apostrophes without executing text", async () => {
    const file = join(dir, "$(touch SENTINEL).png!");
    await writeFile(file, "literal");
    const result = await stage(`Read '${file}' now.`);
    expect(result.message).toContain("/$(touch SENTINEL).png!' now.");
    expect(await readdir(dir)).toEqual(["$(touch SENTINEL).png!"]);
    const apostrophe = join(dir, "Adam's image.png");
    await writeFile(apostrophe, "literal");
    const escaped = apostrophe.replace(/[ ']/g, "\\$&");
    const quoteResult = await stage(`Image ${escaped}`);
    expect(quoteResult.message).toContain("Adam\\'s\\ image.png");
  });

  test("keeps URLs, slash commands, root, ordinary prose and code unchanged", async () => {
    const message = 'Use https://example.org/a.png, //host/file, /clear and / plus `./example.png`.\n```sh\ncat /missing/code.png\n```';
    const result = await stage(message);
    expect(result.message).toBe(message);
    expect(result.staged).toBe(false);
  });

  test("replaces only a Markdown path and preserves trailing punctuation", async () => {
    await writeFile(join(dir, "image.png"), "image");
    const result = await stage("See [image](./image.png), thanks.");
    expect(result.message).toMatch(/^See \[image\]\(\/tmp\/itsybitsy-attachments-[^/]+\/0\/image.png\), thanks\.$/);
  });

  test("missing files, incomplete quoting and directories fail without staging any files", async () => {
    await writeFile(join(dir, "good.png"), "good");
    const before = (await readdir("/tmp")).filter((name) => name.startsWith("itsybitsy-attachments-"));
    await expect(stage('./good.png ./missing.png')).rejects.toThrow("Cannot stage attachment");
    await expect(stage('"./good.png')).rejects.toThrow("Unclosed quote");
    await expect(stage('./good.png\\')).rejects.toThrow("Incomplete escape");
    await expect(stage(dir)).rejects.toThrow("directories are not copied");
    await expect(stage('"./good.png."')).rejects.toThrow("Cannot stage attachment");
    const after = (await readdir("/tmp")).filter((name) => name.startsWith("itsybitsy-attachments-"));
    expect(after).toEqual(before);
  });

  test("deduplicates symlink references and retains the referenced extension", async () => {
    const original = join(dir, "original.data");
    const link = join(dir, "image.png");
    await writeFile(original, "snapshot");
    await symlink(original, link);
    const result = await stage(`${link} ${original}`);
    const paths = stagedPaths(result.message);
    expect(paths[0]).toBe(paths[1]);
    expect(paths[0]!.endsWith(".png")).toBe(true);
    expect(await readFile(paths[0]!, "utf8")).toBe("snapshot");
    await result.cleanup();
    await result.cleanup();
    expect(await Bun.file(paths[0]!).exists()).toBe(false);
  });

  test("cleans the whole staging attempt when a later copy fails", async () => {
    await writeFile(join(dir, "one.png"), "one");
    await writeFile(join(dir, "two.png"), "two");
    const before = (await readdir("/tmp")).filter((name) => name.startsWith("itsybitsy-attachments-"));
    const copy = fsPromises.copyFile;
    let calls = 0;
    const spy = spyOn(fsPromises, "copyFile").mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("simulated copy failure");
      await copy(...args);
    });
    try {
      await expect(stage("./one.png ./two.png")).rejects.toThrow("simulated copy failure");
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
    const after = (await readdir("/tmp")).filter((name) => name.startsWith("itsybitsy-attachments-"));
    expect(after).toEqual(before);
  });
});

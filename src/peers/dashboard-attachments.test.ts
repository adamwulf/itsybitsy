import { tmpdir } from "node:os";
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processStartEpochSecondsCtx } from "../agents";
import { resetUserHome, setUserHome } from "../home";
import { peerAttachmentCandidates, stagePeerAttachments } from "./dashboard-attachments";

async function withProject(use: (project: string, outside: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ib-peer-candidates-"));
  try {
    const project = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(project);
    await mkdir(outside);
    await use(project, outside);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("a missing path stays raw text and is never an error", async () => {
  await withProject(async (project) => {
    const text = `see ${join(project, "gone.png")}, ~/nowhere/x.txt and /nonexistent/fake.png`;
    expect(await peerAttachmentCandidates(text, project)).toEqual({ candidates: [], noPassthrough: false });
    expect(await peerAttachmentCandidates("/nonexistent/fake.png", project)).toEqual({ candidates: [], noPassthrough: true });
    expect(await peerAttachmentCandidates("/nonexistent/fake.png")).toEqual({ candidates: [], noPassthrough: true });
  });
});

test("a leading missing slash-command name still passes through unless quoted", async () => {
  expect(await peerAttachmentCandidates("/clear")).toEqual({ candidates: [], noPassthrough: false });
  expect(await peerAttachmentCandidates("/compact.")).toEqual({ candidates: [], noPassthrough: false });
  expect(await peerAttachmentCandidates("'/clear'")).toEqual({ candidates: [], noPassthrough: true });
  expect(await peerAttachmentCandidates("/no/such/command")).toEqual({ candidates: [], noPassthrough: true });
});

test("files outside the checkout start checked; live and relative ones start unchecked", async () => {
  await withProject(async (project, outside) => {
    const external = join(outside, "report.txt");
    const live = join(project, "live.ts");
    await writeFile(external, "report");
    await writeFile(live, "live");
    const text = `compare ${external} with ${live} and ./live.ts`;
    expect(await peerAttachmentCandidates(text, project)).toEqual({ candidates: [
      { argument: external, source: await realpath(external), checked: true },
      { argument: live, source: await realpath(live), checked: false },
      { argument: "./live.ts", source: await realpath(live), checked: false },
    ], noPassthrough: false });
    // Without a local checkout a relative reference names nothing here.
    expect(await peerAttachmentCandidates(text)).toEqual({ candidates: [
      { argument: external, source: await realpath(external), checked: true },
      { argument: live, source: await realpath(live), checked: true },
    ], noPassthrough: false });
    expect(await peerAttachmentCandidates("./live.ts")).toEqual({ candidates: [], noPassthrough: true });
  });
});

test("a /tmp file is offered checked, since the peer cannot read this machine's /tmp", async () => {
  const dir = await mkdtemp("/tmp/ib-peer-candidate-");
  try {
    const file = join(dir, "shot.png");
    await writeFile(file, "png");
    expect(await peerAttachmentCandidates(`look at ${file}`)).toEqual({
      candidates: [{ argument: file, source: await realpath(file), checked: true }], noPassthrough: false,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a directory stays raw text, but a leading one still blocks passthrough", async () => {
  await withProject(async (_project, outside) => {
    expect(await peerAttachmentCandidates(`list ${outside}`)).toEqual({ candidates: [], noPassthrough: false });
    expect(await peerAttachmentCandidates(outside)).toEqual({ candidates: [], noPassthrough: true });
  });
});

test("trailing punctuation is trimmed, quotes are kept, and each spelling is offered once", async () => {
  await withProject(async (project, outside) => {
    const file = join(outside, "notes.txt");
    await writeFile(file, "notes");
    const text = `read ${file}. Then "${file}" and ${file}`;
    expect(await peerAttachmentCandidates(text, project)).toEqual({
      candidates: [{ argument: file, source: await realpath(file), checked: true }], noPassthrough: false,
    });
    // Inside quotes the punctuation is part of the name.
    expect(await peerAttachmentCandidates(`read "${file}."`, project)).toEqual({ candidates: [], noPassthrough: false });
  });
});

async function withStaging(start: number | null, use: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "ib-peer-stage-"));
  setUserHome(home);
  const stagingRoot = spyOn(await import("../runtime-names"), "transferStagingRoot").mockReturnValue(join(home, "staging"));
  processStartEpochSecondsCtx.set(() => start);
  try {
    await Bun.write(join(home, ".itsybitsy/machine-name"), "sender");
    await use(home);
  } finally {
    stagingRoot.mockRestore();
    processStartEpochSecondsCtx.reset();
    resetUserHome();
    await rm(home, { recursive: true, force: true });
  }
}

test("staging copies the selected files and cleanup removes the outgoing directory", async () => {
  await withStaging(123, async (home) => {
    const source = join(home, "notes.txt");
    await Bun.write(source, "contents");
    const staged = await stagePeerAttachments([{ argument: source, source: await realpath(source) }]);
    expect(staged.files).toHaveLength(1);
    expect(staged.files[0]).toMatchObject({ name: "notes.txt", size: 8 });
    expect(staged.files[0]!.spellings).toContain(source);
    expect(await Bun.file(join(staged.filesDir, "0")).text()).toBe("contents");
    await staged.cleanup();
    expect(await Bun.file(join(staged.filesDir, "0")).exists()).toBe(false);
    expect(await Array.fromAsync(new Bun.Glob("staging/outgoing/*").scan({ cwd: home, onlyFiles: false }))).toEqual([]);
  });
});

test("a staging failure removes the outgoing directory before it rejects", async () => {
  await withStaging(null, async (home) => {
    const source = join(home, "notes.txt");
    await Bun.write(source, "contents");
    await expect(stagePeerAttachments([{ argument: source, source: await realpath(source) }]))
      .rejects.toThrow("Cannot verify the outgoing attachment owner");
    expect(await Array.fromAsync(new Bun.Glob("staging/outgoing/*").scan({ cwd: home, onlyFiles: false }))).toEqual([]);
  });
});

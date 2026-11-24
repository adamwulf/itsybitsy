import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgent } from "../test-utils";
import { captureAgentDiff, EMPTY_DIFF, MAX_AGENT_DIFF_BYTES, prepareDiffCopy } from "./agent-diff";
import { requestAgentDiff, serveTrustedConnection } from "./peer-link";
import { encodeFrameHeader } from "./send-frame";
import { createFakeClock, createMemoryLink } from "./test-pair-transport";
import { OWNER_EXPIRY_MS, stagingArea, stagingOwnerStart, sweepDiffCopies, writeTransferOwner } from "./transfer-owner";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ib-agent-diff-")); });
afterEach(() => rm(root, { recursive: true, force: true }));

test("a remote diff round trip reproduces committed additions, uncommitted text and binary changes at the base", async () => {
  const repo = join(root, "app");
  const worktree = join(root, "worker", "repo");
  await mkdir(repo);
  await Bun.$`git init -qb main`.cwd(repo).quiet();
  await Bun.write(join(repo, "tracked"), "before\n");
  await Bun.write(join(repo, "image"), Buffer.from([0, 1, 2]));
  await Bun.$`git add tracked image`.cwd(repo).quiet();
  await Bun.$`git -c user.name=test -c user.email=test@example.org commit -qm base`.cwd(repo).quiet();
  const base = (await Bun.$`git rev-parse HEAD`.cwd(repo).text()).trim();
  await Bun.$`git worktree add -qb worker ${worktree}`.cwd(repo).quiet();
  const agent = makeAgent({ id: "worker", repoRegistryName: "App", repoPath: repo });
  agent.storageDir = join(root, "worker");
  const { a, b } = createMemoryLink("aa".repeat(32), "bb".repeat(32));
  const server = serveTrustedConnection(b, {
    captureDiff: (repo, id) => captureAgentDiff([agent], repo, id),
    peerName: async () => "A", snapshot: () => ({ repos: [], agents: [], coordinator: null }),
    setTimer: createFakeClock().setTimer, log() {},
  });
  try {
    const read = () => requestAgentDiff(a, "app", "worker");
    await Bun.write(join(worktree, "untracked"), "ignore");
    await expect(read()).rejects.toThrow(EMPTY_DIFF);
    await expect(requestAgentDiff(a, "other", "worker")).rejects.toThrow("not found");
    const added = "nested/雪 file.txt";
    await Bun.write(join(worktree, added), "committed\n");
    await Bun.$`git add -- ${added}`.cwd(worktree).quiet();
    await Bun.$`git -c user.name=test -c user.email=test@example.org commit -qm addition`.cwd(worktree).quiet();
    await Bun.write(join(worktree, "tracked"), "edited without staging\n".repeat(50_000));
    await Bun.write(join(worktree, "image"), Buffer.from([0, 4, 5, 0]));
    const expected = (await Bun.$`git diff --binary ${base}`.cwd(worktree).quiet()).stdout;
    await Bun.$`git config diff.noprefix true`.cwd(worktree).quiet();
    await Bun.$`git config diff.mnemonicPrefix true`.cwd(worktree).quiet();
    await Bun.$`git config diff.relative true`.cwd(worktree).quiet();
    await Bun.$`git config core.quotePath false`.cwd(worktree).quiet();
    await Bun.$`git config color.ui always`.cwd(worktree).quiet();
    const diff = await read();
    expect(diff.base).toBe(base);
    expect(diff.patch.length).toBeGreaterThan(1_048_576);
    expect(diff.patch.equals(expected)).toBe(true);
    expect(diff.patch.toString()).toContain("GIT binary patch");

    const staging = join(root, "staging");
    const { cwd } = await prepareDiffCopy(repo, "App", "Laptop B", diff, staging);
    expect((await Bun.$`git rev-parse HEAD`.cwd(cwd).text()).trim()).toBe(base);
    expect((await Bun.$`git merge-base HEAD main`.cwd(cwd).text()).trim()).toBe(base);
    expect((await Bun.$`git diff --binary ${base}`.cwd(cwd).quiet()).stdout.equals(expected)).toBe(true);
    expect(await Bun.file(join(cwd, "image")).bytes()).toEqual(Uint8Array.of(0, 4, 5, 0));
    expect(await Bun.file(join(cwd, added)).text()).toBe("committed\n");
    expect(existsSync(join(cwd, "untracked"))).toBe(false);
    const missing = "e".repeat(40);
    await expect(prepareDiffCopy(repo, "App", "Laptop B", { ...diff, base: missing }, staging))
      .rejects.toThrow(`Fetch or pull App first: commit ${missing} from Laptop B is not in your copy`);
    await expect(prepareDiffCopy(repo, "App", "Laptop B", { ...diff, patch: Buffer.from("broken") }, staging))
      .rejects.toThrow(/^error: No valid patches in input/);
    expect(await readdir(join(staging, "diffs"))).toHaveLength(1);
    await rm(worktree, { recursive: true });
    await expect(read()).rejects.toThrow("Worktree no longer exists");
  } finally { a.close(0, "done"); await server; }
});

test.each([[1, "hash mismatch"], [MAX_AGENT_DIFF_BYTES + 1, "Malformed agent-diff header"]] as const)(
  "rejects an invalid framed patch (declared size %i)", async (size, reason) => {
    const { a, b } = createMemoryLink("aa".repeat(32), "bb".repeat(32));
    try {
      const pending = requestAgentDiff(a, "app", "worker");
      const stream = await b.acceptBi();
      await stream.readToEnd(4096);
      await stream.writeAll(encodeFrameHeader({ op: "agent-diff", base: "a".repeat(40), size, sha256: "0".repeat(64) }));
      await stream.writeAll(Uint8Array.of(0));
      await stream.finish();
      await expect(pending).rejects.toThrow(reason);
    } finally { a.close(0, "done"); }
  });

test("pruning requires a copy older than a day and a dead owner", async () => {
  const staging = join(root, "staging");
  const area = await stagingArea(staging, "diffs");
  const dead = await mkdtemp(join(area, "copy-"));
  const live = await mkdtemp(join(area, "copy-"));
  const unknown = await mkdtemp(join(area, "copy-"));
  await writeTransferOwner(dead, { pid: 2147483647, start: null });
  await writeTransferOwner(live, { pid: process.pid, start: stagingOwnerStart(process.pid) });
  await sweepDiffCopies(staging);
  expect(existsSync(dead)).toBe(true);
  await sweepDiffCopies(staging, Date.now() + OWNER_EXPIRY_MS + 1000);
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(unknown)).toBe(true);
});

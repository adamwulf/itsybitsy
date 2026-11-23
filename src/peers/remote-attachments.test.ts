import { expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processStartEpochSecondsCtx } from "../agents";
import { hashFile } from "./attachment-manifest";
import { brokerAttachmentStage, cloneAttachments } from "./remote-attachments";

test("remote staging verifies the clone against the manifest and removes changed copies", async () => {
  const root = await mkdtemp("/tmp/ib-remote-stage-");
  const source = join(root, "original");
  await writeFile(source, "known");
  const handle = await open(source, "r");
  try {
    const entry = { handle, source, argument: source, name: "original", size: 5, spellings: [source], sha256: await hashFile({ handle, size: 5 }) };
    const dir = join(root, "files");
    expect(await cloneAttachments(dir, [entry])).toEqual([{ name: entry.name, size: 5, spellings: [source], sha256: entry.sha256 }]);
    expect((await stat(join(dir, "0"))).mode & 0o777).toBe(0o600);
    await rm(source);
    await writeFile(source, "other");
    const fallback = join(root, "fallback");
    await cloneAttachments(fallback, [entry], undefined, async () => false);
    expect(await Bun.file(join(fallback, "0")).text()).toBe("known");
    const changed = join(root, "changed");
    await expect(cloneAttachments(changed, [entry])).rejects.toThrow("changed after manifest");
    expect(await Bun.file(join(changed, "0")).exists()).toBe(false);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog takes only numbered, single-link files within its request and verifies their bytes", async () => {
  const root = await mkdtemp("/tmp/ib-broker-stage-");
  try {
    const parent = join(root, "send-attachments");
    const id = "a".repeat(32);
    const request = join(parent, id);
    await mkdir(request, { recursive: true });
    const source = join(request, "0");
    await writeFile(source, "abc");
    const files = [{ name: "../../other", spellings: ["/elsewhere"], size: 3, sha256: new Bun.CryptoHasher("sha256").update("abc").digest("hex") }];
    const stage = brokerAttachmentStage(root, id, files);
    await stage(join(root, "valid"));
    expect(await Bun.file(source).exists()).toBe(false);
    expect(await Bun.file(join(root, "valid/0")).text()).toBe("abc");
    await writeFile(source, "xyz");
    await expect(stage(join(root, "changed"))).rejects.toThrow("hash mismatch");
    await rm(source);
    await symlink(join(root, "valid/0"), source);
    await expect(stage(join(root, "linked-file"))).rejects.toThrow();
    await rm(request, { recursive: true });
    await symlink(join(root, "valid"), request);
    await expect(stage(join(root, "linked-request"))).rejects.toThrow();
    await expect(brokerAttachmentStage(root, "../elsewhere", files)(join(root, "invalid-id"))).rejects.toThrow("Invalid broker");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("watchdog reclaims a dead CLI's staging before publication and leaves a live lease alone", async () => {
  const root = await mkdtemp("/tmp/ib-broker-lease-");
  processStartEpochSecondsCtx.set(() => 128);
  try {
    const { sweepStagingLease } = await import("../send-broker");
    const { spawnRequestDir } = await import("../spawn-broker");

    const id = "c".repeat(32);
    const path = join(root, "send-attachments", id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "0"), "partial");
    const marker = join(spawnRequestDir(root), "." + id + ".staging");
    await Bun.write(marker, "");
    const lease = join(path, "lease");
    await Bun.write(lease, JSON.stringify({ pid: process.pid, start: 128 }));
    await sweepStagingLease(root, id, Date.now() + 25 * 3600_000);
    expect(await Bun.file(join(path, "0")).exists()).toBe(true);
    await Bun.write(lease, JSON.stringify({ pid: 2147483647, start: 1 }));
    await rm(marker);
    await rm(spawnRequestDir(root), { recursive: true });
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await Bun.write(join(elsewhere, "." + id + ".staging"), "untouched");
    await symlink(elsewhere, spawnRequestDir(root));
    const { sweepStagingRequests } = await import("../send-broker");
    await sweepStagingRequests(root, Date.now());
    expect(await Bun.file(join(elsewhere, "." + id + ".staging")).text()).toBe("untouched");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await Bun.file(lease).exists()).toBe(false);
  } finally { processStartEpochSecondsCtx.reset(); await rm(root, { recursive: true, force: true }); }
});

test.each([null, 129])("reclaim staging only after owner mismatch or expiry (observed start %s)", async observed => {
  const { sweepStagingLease } = await import("../send-broker");
  const { spawnRequestDir } = await import("../spawn-broker");
  const root = await mkdtemp("/tmp/ib-lease-identity-");
  const id = "d".repeat(32);
  const dir = join(root, "send-attachments", id);
  try {
    await mkdir(dir, { recursive: true });
    await Bun.write(join(spawnRequestDir(root), "." + id + ".staging"), "");
    await Bun.write(join(dir, "lease"), JSON.stringify({ pid: process.pid, start: 128 }));
    await Bun.write(join(dir, "0"), "staged");
    processStartEpochSecondsCtx.set(() => observed);
    await sweepStagingLease(root, id, Date.now());
    expect(await Bun.file(join(dir, "0")).exists()).toBe(observed === null);
    if (observed === null) await sweepStagingLease(root, id, Date.now() + 25 * 3600_000);
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    processStartEpochSecondsCtx.reset();
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard stages the canonical file selected through a project symlink and keeps its spelling", async () => {
  const { dashboardAttachmentPaths } = await import("./dashboard-attachments");
  const { buildAttachmentManifest } = await import("./attachment-manifest");
  const root = await mkdtemp("/tmp/ib-dashboard-select-");
  try {
    const project = join(root, "project");
    const alias = join(project, "alias");
    const external = join(root, "external");
    await mkdir(project);
    await writeFile(external, "selected");
    await symlink(external, alias);
    const { paths: inputs } = await dashboardAttachmentPaths(alias, project, project);
    await rm(alias);
    await writeFile(alias, "different");
    expect(await dashboardAttachmentPaths(alias, project, project)).toEqual({ paths: [], noPassthrough: true });
    expect(await dashboardAttachmentPaths("/clear", project, project)).toEqual({ paths: [], noPassthrough: false });
    const entries = await buildAttachmentManifest(inputs, { home: root, cwd: project, machine: "desk" });
    try {
      expect(entries).toHaveLength(1);
      expect(entries[0]!.spellings[0]).toBe(alias);
      expect(await entries[0]!.handle.readFile("utf8")).toBe("selected");
    } finally { await Promise.all(entries.map(entry => entry.handle.close())); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    await writeFile(source, "other");
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
    expect(await Bun.file(join(root, "valid/0")).text()).toBe("abc");
    await writeFile(source, "xyz");
    await expect(stage(join(root, "changed"))).rejects.toThrow("hash mismatch");
    await rm(source);
    await symlink(join(root, "valid/0"), source);
    await expect(stage(join(root, "linked-file"))).rejects.toThrow();
    await rm(request, { recursive: true });
    await symlink(join(root, "valid"), request);
    await expect(stage(join(root, "linked-request"))).rejects.toThrow();
    expect(() => brokerAttachmentStage(root, "../elsewhere", files)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

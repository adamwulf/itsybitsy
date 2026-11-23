import { expect, test } from "bun:test";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashFile } from "./attachment-manifest";
import { cloneAttachments } from "./remote-attachments";

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

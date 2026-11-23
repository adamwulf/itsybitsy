import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readdir, realpath, rm, stat, truncate } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeAgentTransient } from "../agents";
import { createCliFixture, type CliFixture, type FixtureAgent } from "../test-cli-runner";
import { buildAttachmentManifest, hashFile } from "./attachment-manifest";
import { copyLocalAttachments } from "./local-attachments";

let fixture: CliFixture;
let recipient: FixtureAgent;
const snapshots: string[] = [];
beforeEach(async () => {
  fixture = await createCliFixture();
  recipient = await fixture.addAgent(await fixture.addRepo("project"), "reader");
  await Bun.write(join(fixture.home, ".itsybitsy/machine-name"), "desk");
  await writeAgentTransient(recipient.agentDir, {
    updated_at_ms: Date.now(), watchdog_pid: process.pid, tmux_compacting: false,
    tmux_rate_limited: false, tmux_api_error: false, tmux_api_safeguard: false, has_background_tasks: false,
  });
});
afterEach(async () => {
  for (const root of snapshots.splice(0)) await rm(root, { recursive: true, force: true });
  await fixture.cleanup();
});

const queue = () => Bun.file(join(fixture.home, ".itsybitsy/agents/reader/outbox.jsonl"));
const send = (...args: string[]) => fixture.run(["send", "reader", ...args], { actions: { sendMessage: "real" } });

test.each([1, 2])("queues %i verified private snapshots, rewriting all spellings", async count => {
  const first = join(fixture.cwd, "one");
  const bytes = Buffer.alloc(180_021, "abc");
  await Bun.write(first, bytes);
  const source = await realpath(first);
  const args = ["--attach", "./one", "--attach", source, "--attach", "./one"];
  if (count === 2) {
    await Bun.write(join(fixture.cwd, "two"), "another");
    args.push("--attach", "two");
  }
  const run = await send(...args, "!read ./one " + source + " ./one");
  expect(run.exitCode, run.stderr).toBe(0);
  const record = JSON.parse((await queue().text()).trim());
  expect(record.noPassthrough).toBe(true);
  const [body, mapping] = record.message.split("\n\n");
  const [heading, ...lines] = mapping.split("\n");
  expect(heading).toBe("Attachments copied to this machine:");
  expect(lines).toHaveLength(count);
  const path = lines[0].split(" → ")[1];
  expect(path).toMatch(/^\/tmp\/itsybitsy-attachments-[^/]+\/0\/one$/);
  const root = dirname(dirname(path));
  snapshots.push(root);
  expect(body).toBe(`!read ${path} ${path} ${path}`);
  expect(await Bun.file(path).bytes()).toEqual(new Uint8Array(bytes));
  for (const dir of [root, dirname(path)]) expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  if (count === 2) {
    expect(lines[1]).toBe(`- two → ${root}/1/two`);
    expect(await Bun.file(join(root, "1/two")).text()).toBe("another");
  }
});

test.each([
  ["maxFileMB", 1, [1048577]], ["maxMessageMB", 1, [700000, 700000]], ["maxFiles", 1, [0, 0]],
  ["maxFileMB", 0, [0]], ["maxMessageMB", 0, [0]], ["maxFiles", 0, [0]],
] as const)("enforces %s = %i on the sending machine before queueing", async (key, value, sizes) => {
  await Bun.write(join(fixture.home, ".itsybitsy/config.json"), JSON.stringify({
    peering: { attachments: { maxFileMB: 1, [key]: value } },
  }));
  const args = [];
  for (const [i, size] of sizes.entries()) {
    const name = String(i);
    const path = join(fixture.cwd, name);
    await Bun.write(path, "");
    await truncate(path, size);
    args.push("--attach", name);
  }
  const run = await send(...args, "read");
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`desk (peering.attachments.${key} = ${value})`);
  expect(await queue().exists()).toBe(false);
});

test("refuses protected files and remote attachments", async () => {
  const secret = join(fixture.home, ".itsybitsy/peer/fixture");
  await Bun.write(secret, "fixture");
  expect((await send("--attach", secret, "read")).stderr).toContain("protected attachment");
  const remote = await fixture.run(["send", "laptop/@system", "--attach", "missing", "read"]);
  expect(remote.stderr).toContain("attachments to other machines come in the next update");
  expect(await queue().exists()).toBe(false);
});

test("a same-size mutation after validation removes the entire partial snapshot", async () => {
  const dest = join(fixture.root, "snapshots");
  await mkdir(dest);
  const paths = ["first", "second"].map(name => join(fixture.cwd, name));
  for (const path of paths) await Bun.write(path, basename(path));
  const manifest = await buildAttachmentManifest(paths, { cwd: fixture.cwd, home: fixture.home, machine: "desk" });
  try {
    const verified = await Promise.all(manifest.map(async entry => ({ ...entry, sha256: await hashFile(entry) })));
    await Bun.write(paths[1]!, "CHANGE");
    await expect(copyLocalAttachments("read", verified, undefined, dest)).rejects.toThrow("hash mismatch");
    expect(await readdir(dest)).toEqual([]);
  } finally {
    await Promise.all(manifest.map(entry => entry.handle.close()));
  }
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, link, mkdir, readdir, realpath, rm, stat, truncate } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeAgentTransient } from "../agents";
import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as space from "./attachment-space";
import { remoteCliCaller } from "./peer-outbox";
import { resetUserHome, setUserHome } from "../home";
import { createCliFixture, type CliFixture, type FixtureAgent } from "../test-cli-runner";
import { buildAttachmentManifest, hashFile } from "./attachment-manifest";
import * as config from "../config";
import { copyLocalAttachments, resolveAttachmentSender, stageLocalAttachments } from "./local-attachments";

let fixture: CliFixture;
let recipient: FixtureAgent;
const snapshots: string[] = [];
beforeEach(async () => {
  fixture = await createCliFixture();
  recipient = await fixture.addAgent(await fixture.addRepo("project"), "reader");
  await Bun.write(join(fixture.home, ".itsybitsy/machine-name"), "desk");
  await writeAgentTransient(recipient.agentDir, {
    updated_at_ms: Date.now(), watchdog_pid: process.pid, tmux_compacting: false,
    tmux_rate_limited: false, tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false, has_background_tasks: false,
  });
});
afterEach(async () => {
  for (const root of snapshots.splice(0)) await rm(root, { recursive: true, force: true });
  resetUserHome();
  await fixture.cleanup();
});

const human = { pid: 300, parents: [[300, 1]] as [number, number][], terminal: "human" as const, identityCurrent: true };
const queue = () => Bun.file(join(fixture.home, ".itsybitsy/agents/reader/outbox.jsonl"));
const send = (...args: string[]) => fixture.run(["send", "reader", ...args], { ancestry: human, actions: { sendMessage: "real" } });

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

test.each([false, true])("an unwrapped caller respects its worktree deny rule with sandbox.enabled=%s", async enabled => {
  const path = join(recipient.repoPath, ".itsybitsy/agents/sender/repo/private");
  const sender = await fixture.addAgent(recipient.repoPath, "sender", { paths: { deny: [await realpath(recipient.repoPath) + "/.itsybitsy/agents/sender/repo/private"] }, sandbox: { enabled } });
  await Bun.write(path, "fixture");
  const run = await fixture.run(["send", "reader", ...(enabled ? [] : ["--from", "@system"]), "--attach", "./private", "read"], {
    cwd: sender.sessionCwd, allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain("paths.deny");
  expect(run.stderr).toContain(await realpath(path));
  expect(await queue().exists()).toBe(false);
});

test.each(["ordinary", "protected link"] as const)(
  "sandboxed CLI with %s checks the opened source locally", async scenario => {
    setUserHome(fixture.home);
    const sender = await fixture.addAgent(recipient.repoPath, "sender", { sandbox: { enabled: true } });
    const file = join(sender.sessionCwd, "report");
    if (scenario === "protected link") {
      const secret = join(fixture.home, ".itsybitsy/sealed/example");
      await Bun.write(secret, "fixture");
      await link(secret, file);
    } else await Bun.write(file, "ordinary data");
    const run = () => fixture.run(["send", "reader", "--attach", "./report", "inspect"], {
      sandboxed: true, cwd: sender.sessionCwd, actions: { sendMessage: "real" }, allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
    });
    const result = await run();
    if (scenario !== "ordinary") {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("has multiple hard links; copy it to a new file first");
      expect(await queue().exists()).toBe(false);
      return;
    }
    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(await queue().text());
    expect(record).toMatchObject({ fromAgent: "sender", noPassthrough: true });
    const destination = record.message.split(" → ")[1];
    snapshots.push(dirname(dirname(destination)));
    expect(await Bun.file(destination).text()).toBe("ordinary data");
  },
);

test.skipIf(process.getuid?.() === 0)("sandbox-routed CLI reports a kernel read refusal before contacting its watchdog", async () => {
  const sender = await fixture.addAgent(recipient.repoPath, "sender", { sandbox: { enabled: true } });
  const file = join(sender.sessionCwd, "unreadable");
  await Bun.write(file, "test fixture");
  await chmod(file, 0);
  const result = await fixture.run(["send", "reader", "--attach", "./unreadable", "read"], {
    sandboxed: true, cwd: sender.sessionCwd, actions: { sendMessage: "real" }, allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/EACCES|permission denied/i);
  expect(await queue().exists()).toBe(false);
});

test.each(["@system", "@project"])("sends an attachment to %s through the coordinator's ordinary handler", async target => {
  await fixture.addAgent(recipient.repoPath, "project", { agentType: "repo-coordinator", worktree: false });
  await Bun.write(join(fixture.cwd, "figure"), "fixture");
  const result = await fixture.run(["send", target, "--attach", "figure"], {
    stdin: "Read figure", ancestry: human, actions: { sendToSystemCoordinator: "record", sendMessage: "record" },
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const action = result.actions[0]!;
  const system = target === "@system";
  expect(action.name).toBe(system ? "sendToSystemCoordinator" : "sendMessage");
  const body = action.args[system ? 0 : 1] as string;
  const destination = body.split(" → ")[1]!;
  snapshots.push(dirname(dirname(destination)));
  expect(body).toStartWith("Read " + destination);
  expect(action.args[system ? 1 : 2]).toEqual({ noPassthrough: true });
});

test("team members receive the same verified snapshot", async () => {
  const second = await fixture.addAgent(recipient.repoPath, "editor");
  await Bun.write(join(second.agentDir, "meta.transient.json"), Bun.file(join(recipient.agentDir, "meta.transient.json")));
  await Bun.write(join(fixture.home, ".itsybitsy/teams.json"), JSON.stringify({
    teams: { review: { created_epoch: 1, created_by: "", members: ["reader", "editor"] } },
  }));
  await Bun.write(join(fixture.cwd, "figure"), "fixture");
  const result = await fixture.run(["send", "@review", "--attach", "figure", "Read figure"], { ancestry: human, actions: { teamSend: "real" } });
  expect(result.exitCode, result.stderr).toBe(0);
  const reader = JSON.parse(await queue().text());
  const destination = reader.message.split(" → ")[1];
  snapshots.push(dirname(dirname(destination)));
  const editor = JSON.parse(await Bun.file(join(fixture.home, ".itsybitsy/agents/editor/outbox.jsonl")).text());
  expect(reader).toMatchObject({ noPassthrough: true, team: "review" });
  expect(editor).toMatchObject({ noPassthrough: true, team: "review", message: reader.message });
  expect(await Bun.file(destination).text()).toBe("fixture");
});

test("an unreadable transfer policy refuses the send", async () => {
  await mkdir(join(fixture.home, ".itsybitsy/config.json"));
  await Bun.write(join(fixture.cwd, "file"), "fixture");
  const result = await send("--attach", "file", "read");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Cannot read attachment limits");
  expect(await queue().exists()).toBe(false);
  const text = await send("ordinary text");
  expect(text.exitCode, text.stderr).toBe(0);
  expect(JSON.parse(await queue().text()).message).toBe("ordinary text");
});

test.each(["@system", "repo coordinator"])("%s attachments follow that sender's own paths.deny", async kind => {
  const state = join(fixture.home, ".itsybitsy");
  const file = join(state, "private-fixture");
  await Bun.write(file, "example");
  const system = kind === "@system";
  if (system) {
    await Bun.write(join(state, "agent-types/system-coordinator.md"), `---\nname: system-coordinator\npaths:\n  deny:\n    - "${file}"\n---\n`);
  } else {
    await fixture.addAgent(recipient.repoPath, "project", { agentType: "repo-coordinator", worktree: false,
      claude_pid: "200", claude_pid_epoch: 100, sandbox: { enabled: false }, paths: { deny: [file] } });
  }
  const result = await fixture.run(["send", "reader", "--attach", file, "read"], {
    cwd: system ? state : recipient.repoPath,
    ancestry: { ...human, terminal: "agent", parents: [[300, 200], [200, 1]], systemPanePid: 200 },
    allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
  });
  expect(result.stderr).toContain("paths.deny");
  expect(result.stderr).toContain(await realpath(file));
  expect(await queue().exists()).toBe(false);
});

test("attachments refuse an unidentified caller", async () => {
  const result = await fixture.run(["send", "reader", "--attach", "file", "read"]);
  expect(result.stderr).toContain("cannot verify the sender");
  expect(await queue().exists()).toBe(false);
});

test("sandbox caller lookup opens its agent directory and no unrelated repo root", async () => {
  setUserHome(fixture.home);
  const sender = await fixture.addAgent(recipient.repoPath, "sender", { sandbox: { enabled: true } });
  const cwd = await realpath(sender.sessionCwd);
  const other = await realpath(await fixture.addRepo("unrelated"));
  const human = spyOn(remoteCliCaller, "isHuman").mockResolvedValue(false);
  const sync = spyOn(fs, "realpathSync");
  const asyncRead = spyOn(fsPromises, "realpath");
  try {
    expect((await resolveAttachmentSender(cwd)).kind).toBe("agent");
    const opened = [...sync.mock.calls, ...asyncRead.mock.calls].map(([path]) => String(path));
    expect(opened).toContain(dirname(cwd));
    expect(opened.filter(path => path === other || path.startsWith(other + "/"))).toEqual([]);
  } finally {
    asyncRead.mockRestore();
    sync.mockRestore();
    human.mockRestore();
  }
});

test("insufficient staging space refuses before creating any snapshot", async () => {
  const dest = join(fixture.root, "copies");
  await mkdir(dest);
  const path = join(fixture.cwd, "file");
  await Bun.write(path, "data");
  const entries = await buildAttachmentManifest([path], { cwd: fixture.cwd, home: fixture.home, machine: "desk" });
  const available = spyOn(space, "hasFreeSpace").mockResolvedValue(false);
  try {
    const verified = [{ ...entries[0]!, sha256: await hashFile(entries[0]!) }];
    await expect(copyLocalAttachments("read", verified, undefined, dest)).rejects.toThrow("1 GiB reserve");
    expect(available).toHaveBeenCalledWith(dest, 4);
    expect(await readdir(dest)).toEqual([]);
    expect(await queue().exists()).toBe(false);
  } finally {
    available.mockRestore();
    await entries[0]!.handle.close();
  }
});

test.each(["-f", "--file", "--from", "--attach", ""])("--attach requires a path before %j", async option => {
  const result = await send("--attach", ...(option ? [option] : []));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--attach requires a path");
  expect(await queue().exists()).toBe(false);
});

test("--attach before the target combines with a file body and explicit attribution", async () => {
  await Bun.write(join(fixture.cwd, "-f"), "snapshot");
  await Bun.write(join(fixture.cwd, "body"), "Read ./-f");
  const run = await fixture.run(["send", "--attach", "./-f", "reader", "-f", "body", "--from", "writer"], {
    ancestry: human, actions: { sendMessage: "real" },
  });
  expect(run.exitCode, run.stderr).toBe(0);
  const record = JSON.parse(await queue().text());
  const destination = record.message.split(" → ")[1];
  snapshots.push(dirname(dirname(destination)));
  expect(record).toMatchObject({ fromAgent: "writer", noPassthrough: true });
  expect(record.message.split("\n")[0]).toBe("Read " + destination);
  expect(await Bun.file(destination).text()).toBe("snapshot");
});

test("failed attachment staging never falls back to sending the original text", async () => {
  const sender = await fixture.addAgent(recipient.repoPath, "sender", { sandbox: { enabled: true } });
  await Bun.write(join(sender.sessionCwd, "first"), "ok");
  const run = await fixture.run(["send", "reader", "--attach", "first", "--attach", "missing", "!read first missing"], {
    cwd: sender.sessionCwd, sandboxed: true, actions: { sendMessage: "record" }, allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain("missing");
  expect(run.actions).toEqual([]);
  expect(await queue().exists()).toBe(false);
});

test("a bad individual limit uses its default and logs the key", async () => {
  await Bun.write(join(fixture.home, ".itsybitsy/config.json"), '{"peering":{"attachments":{"maxFiles":"typo"}}}');
  await Bun.write(join(fixture.cwd, "report"), "ok");
  const result = await send("--attach", "report", "read");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toContain("peering.attachments.maxFiles");
  expect(result.stderr).toContain("Using 20");
  const record = JSON.parse(await queue().text());
  snapshots.push(dirname(dirname(record.message.split(" → ")[1])));
});

test("a config change after copying refuses the snapshot and cleans it up", async () => {
  setUserHome(fixture.home);
  const source = join(fixture.cwd, "report");
  await Bun.write(source, "copied");
  let root = "";
  const make = fsPromises.mkdtemp.bind(fsPromises);
  const filesystem: { mkdtemp(prefix: string): Promise<string> } = fsPromises;
  const dirs = spyOn(filesystem, "mkdtemp").mockImplementationOnce(async prefix => {
    root = await make(prefix);
    return root;
  });
  const read = config.readTransferLimits;
  const policy = spyOn(config, "readTransferLimits").mockImplementation(async () => {
    if (root) {
      expect(await Bun.file(join(root, "0/report")).text()).toBe("copied");
      await Bun.write(join(fixture.home, ".itsybitsy/config.json"), '{"peering":{"attachments":{"maxFiles":0}}}');
    }
    return read();
  });
  try {
    await expect(stageLocalAttachments("read", [source], { kind: "user" })).rejects.toThrow("maxFiles = 0");
    expect(policy).toHaveBeenCalledTimes(2);
    expect(root).not.toBe("");
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    dirs.mockRestore();
    policy.mockRestore();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

test("a shared-checkout worker sends with its own policy even from another agent's worktree", async () => {
  const allowed = join(recipient.repoPath, "public");
  const denied = join(recipient.sessionCwd, "private");
  await Bun.write(allowed, "share");
  await Bun.write(denied, "keep");
  await fixture.addAgent(recipient.repoPath, "worker", { worktree: false, agentType: "worker",
    model: "claude:opus", sandbox: { enabled: false }, claude_pid: "200", claude_pid_epoch: 100,
    paths: { deny: [denied] } });
  const sendFile = (cwd: string, path: string) => fixture.run(["send", "reader", "--attach", path, "read"], {
    cwd, ancestry: { ...human, terminal: "agent", parents: [[300, 200], [200, 1]] },
    allowedProcesses: [["git", "rev-parse", "--git-common-dir"]], actions: { sendMessage: "real" },
  });
  const refusal = await sendFile(recipient.sessionCwd, denied);
  expect(refusal.stderr).toContain("paths.deny");
  expect(await queue().exists()).toBe(false);
  const accepted = await sendFile(recipient.repoPath, allowed);
  expect(accepted.exitCode, accepted.stderr).toBe(0);
  const record = JSON.parse(await queue().text());
  snapshots.push(dirname(dirname(record.message.split(" → ")[1])));
  expect(record.fromAgent).toBe("worker");
});

test("a case-insensitive registration matches the sender directory by identity", async () => {
  const alias = join(dirname(recipient.repoPath), basename(recipient.repoPath).toUpperCase());
  if (!await stat(alias).then(() => true, () => false)) return;
  await fixture.writeRegistry({ version: 1, repos: [{ path: alias, name: "project" }] });
  const sender = await fixture.addAgent(recipient.repoPath, "sender", { sandbox: { enabled: false } });
  await Bun.write(join(sender.sessionCwd, "report"), "ok");
  const result = await fixture.run(["send", "reader", "--attach", "report", "read"], {
    cwd: sender.sessionCwd, actions: { sendMessage: "real" }, allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const record = JSON.parse(await queue().text());
  snapshots.push(dirname(dirname(record.message.split(" → ")[1])));
  expect(record.fromAgent).toBe("sender");
});

test("tilde arguments use the sender's HOME while protected trees belong to the account", async () => {
  const account = join(fixture.root, "account");
  const protectedFile = join(account, ".itsybitsy/sealed/private");
  await Bun.write(protectedFile, "private");
  await Bun.write(join(account, "x"), "account data");
  await Bun.write(join(fixture.home, "x"), "sender data");
  const run = (file: string) => fixture.run(["send", "reader", "--attach", file, "read"], {
    accountHome: account, ancestry: human, actions: { sendMessage: "real" },
  });
  const accountConfig = join(account, ".itsybitsy/config.json");
  const senderConfig = join(fixture.home, ".itsybitsy/config.json");
  const disabled = JSON.stringify({ peering: { attachments: { maxFiles: 0 } } });
  await Bun.write(accountConfig, disabled);
  expect((await run("~/x")).stderr).toContain("peering.attachments.maxFiles = 0");
  expect(await queue().exists()).toBe(false);
  await Bun.write(accountConfig, "{}");
  await Bun.write(senderConfig, disabled);
  expect((await run(protectedFile)).stderr).toContain("protected attachment path");
  expect(await queue().exists()).toBe(false);
  const sent = await run("~/x");
  expect(sent.exitCode, sent.stderr).toBe(0);
  const destination = JSON.parse(await queue().text()).message.split(" → ")[1];
  snapshots.push(dirname(dirname(destination)));
  expect(await Bun.file(destination).text()).toBe("sender data");
});

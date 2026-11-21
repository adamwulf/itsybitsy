import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, readdir, rm } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { agentOutboxDir, readOutbox, deleteAgentOutbox } from "./outbox";
import { deleteClaudeRateLimits, CLAUDE_RATE_LIMITS_FILE } from "./claude-rate-limits";
import { archiveAgent, prepareAgentRetirement } from "./agent-lifecycle";
import { writeAgentTransient } from "./agents";
import { drainOutbox, sendMessage, setSendSpawnRunner, resetSendSpawnRunner } from "./ib-commands";
import { setUserHome, resetUserHome } from "./home";
import { createCliFixture, type CliFixture } from "./test-cli-runner";
import { makeAgent, makeSpawnResult } from "./test-utils";
import { machineNameFile } from "./runtime-names";

describe("fully qualified agent queues", () => {
  let cli: CliFixture;
  let repoA: string;
  let repoB: string;
  let calls: string[][];
  const queue = (repo: string, id: string, machine = "studio") =>
    join(cli.home, ".itsybitsy", "agents", machine, repo, id);

  beforeEach(async () => {
    cli = await createCliFixture();
    setUserHome(cli.home);
    await Bun.write(machineNameFile(), "studio");
    // The paths end in the same basename, with distinct registry names and nicknames.
    repoA = await cli.addRepo("shared");
    repoB = await cli.addRepo("shared");
    await cli.writeRegistry({ repos: [
      { path: repoA, name: "alpha", nickname: "first" },
      { path: repoB, name: "beta", nickname: "second" },
    ] });
    calls = [];
    setSendSpawnRunner((cmd) => { calls.push(cmd); return makeSpawnResult(); });
  });

  afterEach(async () => {
    resetSendSpawnRunner();
    resetUserHome();
    await cli.cleanup();
  });

  async function plant(repo: string, id: string, session: string, opts: { coordinator?: boolean; key?: string } = {}) {
    const agent = await cli.addAgent(repo, id, {
      tmux_session: session,
      queue_key: opts.key,
      ...(opts.coordinator ? { agentType: "repo-coordinator", worktree: false } : {}),
    });
    if (opts.key) await mkdir(join(cli.home, ".itsybitsy", "agents", opts.key), { recursive: true });
    await writeAgentTransient(agent.agentDir, {
      watchdog_pid: process.pid, updated_at_ms: Date.now(), has_background_tasks: false,
      tmux_compacting: false, tmux_rate_limited: false, tmux_api_error: false,
      tmux_api_terms: false, tmux_api_safeguard: false,
    });
    return agent;
  }

  async function send(target: string, message: string) {
    const result = await cli.run(["send", target, message], {
      cwd: repoA, actions: { sendMessage: "real" },
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  }

  test("cross-repo send, drain and archive isolate identically named agents", async () => {
    const a = await plant(repoA, "review", "session-A", { key: "studio/alpha/review" });
    await plant(repoB, "review", "session-B", { key: "studio/beta/review" });
    const legacy = join(cli.home, ".itsybitsy", "agents", "review", "outbox.jsonl");
    const legacyLine = JSON.stringify({ id: "legacy", message: "old", fromAgent: "", raw: true });
    await Bun.write(legacy, legacyLine);
    const aQueue = queue("alpha", "review");
    const bQueue = queue("beta", "review");
    await send("@first/review", "for A");
    expect(await readOutbox(bQueue)).toEqual([]);
    await send("@beta/review", "for B");
    const pendingB = await readOutbox(bQueue);
    expect(pendingB.map((m) => m.message)).toEqual(["for B"]);
    expect((await readOutbox(aQueue)).map((m) => m.message)).toEqual(["for A"]);
    expect(await readdir(a.agentDir)).not.toContain("outbox.jsonl");

    const agent = makeAgent({ id: "review", repoPath: repoA });
    agent.meta.tmux_session = "session-A";
    agent.meta.queue_key = "studio/alpha/review";
    await drainOutbox(agent, agentOutboxDir(agent));
    const keys = calls.filter((cmd) => cmd.includes("send-keys"));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((cmd) => cmd.includes("=session-A:"))).toBe(true);
    expect(keys.flat().join(" ")).toContain("for A");
    expect(keys.flat().join(" ")).not.toContain("for B");
    expect(await readOutbox(aQueue)).toEqual([]);
    expect(await readOutbox(bQueue)).toEqual(pendingB);

    await send("@alpha/review", "undelivered");
    await archiveAgent(repoA, agent.id, a.agentDir);
    expect(await Bun.file(join(aQueue, "outbox.jsonl")).exists()).toBe(false);
    expect(await Bun.file(legacy).text()).toBe(legacyLine);
    expect(await readOutbox(bQueue)).toEqual(pendingB);
  });

  test("same-basename repo coordinators each receive their own messages", async () => {
    await plant(repoA, "shared", "session-A", { coordinator: true, key: "studio/alpha/shared" });
    await plant(repoB, "shared", "session-B", { coordinator: true, key: "studio/beta/shared" });
    await send("@coordinator", "own coordinator");
    await send("@beta", "other coordinator");
    expect((await readOutbox(queue("alpha", "shared"))).map((m) => m.message)).toEqual(["own coordinator"]);
    expect((await readOutbox(queue("beta", "shared"))).map((m) => m.message)).toEqual(["other coordinator"]);
  });

  test("stored machine identities separate otherwise identical queues", () => {
    const dirFor = (machine: string) => agentOutboxDir({
      id: "review", meta: { queue_key: `${machine}/alpha/review` },
    });
    expect(dirFor("studio")).toBe(queue("alpha", "review"));
    expect(dirFor("work-laptop")).toBe(queue("alpha", "review", "work-laptop"));
  });

  test("send, inline drain and archive follow the saved key across registration and machine changes", async () => {
    const id = "review";
    const key = "studio/alpha/review";
    const agent = makeAgent({ repoPath: repoA, id });
    agent.meta.queue_key = key;
    agent.meta.tmux_session = "itsybitsy-deadbeef-review";
    const planted = await plant(repoA, id, agent.meta.tmux_session, { key });
    await Bun.write(join(planted.agentDir, "meta.json"), JSON.stringify(agent.meta));

    const dir = queue("alpha", id);
    await cli.writeRegistry({ repos: [{ path: repoA, name: "renamed" }] });
    await rm(machineNameFile());
    await send("@renamed/review", "while registered");
    await cli.writeRegistry({ repos: [] });
    expect((await sendMessage(agent, "after removal", { cwd: "/" })).ok).toBe(true);
    expect((await readOutbox(dir)).map((m) => m.message)).toEqual(["while registered", "after removal"]);

    // No heartbeat: sendMessage now takes the inline drain for the same queue.
    await rm(join(planted.agentDir, "meta.transient.json"));
    expect((await sendMessage(agent, "drain", { cwd: "/" })).ok).toBe(true);
    expect(await readOutbox(dir)).toEqual([]);
    const typed = calls.filter((cmd) => cmd.includes("send-keys") && cmd.includes("-l")).flat().join(" ");
    for (const message of ["while registered", "after removal", "drain"]) expect(typed).toContain(message);
    await Bun.write(join(dir, "outbox.jsonl.tmp"), "pending");
    await archiveAgent(repoA, id, planted.agentDir);
    expect(await readdir(join(dir, ".."))).not.toContain(id);
  });

  test.each(["../repo/review", "/repo/review", "host/repo/other", "host/repo/x/review", "", null])(
    "refuses an invalid stored key without falling back (%p)", async (key) => {
      const agent = makeAgent({ repoPath: repoA, id: "review" });
      Object.assign(agent.meta, { queue_key: key });
      expect(() => agentOutboxDir(agent)).toThrow("Invalid queue key");
    },
  );

  test.each(["outbox.jsonl", "outbox.jsonl.tmp", ".outbox.lock", CLAUDE_RATE_LIMITS_FILE, CLAUDE_RATE_LIMITS_FILE + ".tmp.123"])(
    "surfaces an unlink error removing %s", async (file) => {
      const dir = queue("alpha", "review");
      await mkdir(join(dir, file), { recursive: true });
      const remove = file.startsWith(CLAUDE_RATE_LIMITS_FILE) ? deleteClaudeRateLimits : deleteAgentOutbox;
      const warnings = await remove(dir);
      expect(warnings.some((w) => w.startsWith(`Warning: could not unlink ${join(dir, file)}:`))).toBe(true);
      expect(await readdir(dir)).toContain(file);
    },
  );

  test.each([true, false])("corrupt live metadata never selects a guessed queue (snapshot %p)", async (prepare) => {
    const id = "review";
    const key = "studio/original/review";
    const planted = await cli.addAgent(repoA, id, { queue_key: key, tmux_session: "itsybitsy-deadbeef-review" });
    const prepared = prepare ? await prepareAgentRetirement(repoA, id, planted.agentDir, false) : undefined;
    const original = join(queue("original", id), "outbox.jsonl");
    const other = join(queue("alpha", id), "outbox.jsonl");
    await Bun.write(original, "original messages");
    await Bun.write(other, "other agent's messages");
    await Bun.write(join(planted.agentDir, "meta.json"), "{");
    const result = await archiveAgent(repoA, id, planted.agentDir, prepared);
    expect(await Bun.file(other).text()).toBe("other agent's messages");
    if (prepare) {
      expect(result.warnings).toEqual([]);
      expect(await Bun.file(original).exists()).toBe(false);
      expect((await Bun.file(join(result.archivePath!, "meta.json")).json()).queue_key).toBe(key);
    } else {
      expect(result.warnings.join("\n")).toContain("skipped queue cleanup");
      expect(result.warnings.join("\n")).toContain(join(planted.agentDir, "meta.json"));
      expect(await Bun.file(original).text()).toBe("original messages");
    }
  });

  test.each(["missing", "unreadable"])("archive distinguishes %s metadata when a legacy queue exists", async (condition) => {
    const id = "review";
    const planted = await cli.addAgent(repoA, id);
    const path = join(planted.agentDir, "meta.json");
    await rm(path);
    if (condition === "unreadable") await mkdir(path); // readAgentMeta gets EISDIR
    await Bun.write(join(planted.agentDir, "output.log"), "captured output");
    const file = join(cli.home, ".itsybitsy", "agents", id, "outbox.jsonl");
    await Bun.write(file, "pending legacy message");
    const result = await archiveAgent(repoA, id, planted.agentDir);
    if (condition === "missing") {
      expect(result.warnings).toEqual([]);
      expect(await Bun.file(file).exists()).toBe(false);
    } else {
      expect(result.warnings.join("\n")).toContain(path);
      expect(await Bun.file(file).text()).toBe("pending legacy message");
    }
  });

  test("same-id keyless agents share the flat queue across repos", async () => {
    const id = "review";
    const a = await plant(repoA, id, "session-A");
    await plant(repoB, id, "session-B");
    const dir = join(cli.home, ".itsybitsy", "agents", id);
    expect(existsSync(dir)).toBe(false);

    await send("@first/review", "for A");
    await send("@beta/review", "for B");
    expect((await readOutbox(dir)).map(m => m.message)).toEqual(["for A", "for B"]);

    // Legacy lookup needs neither the machine name nor a usable registry.
    await rm(machineNameFile());
    await Bun.write(join(cli.home, ".itsybitsy", "repos.json"), "{");
    await rm(join(a.agentDir, "meta.transient.json"));
    const agentA = makeAgent({ id, repoPath: repoA });
    agentA.meta.tmux_session = "session-A";
    expect((await sendMessage(agentA, "inline", { cwd: "/" })).ok).toBe(true);
    const typed = calls.filter(cmd => cmd.includes("-l")).map(cmd => cmd.at(-1));
    expect(typed).toEqual(["[sent by user]: for A", "[sent by user]: for B", "[sent by user]: inline"]);
    expect(await readOutbox(dir)).toEqual([]);

    const agentB = makeAgent({ id, repoPath: repoB });
    agentB.meta.tmux_session = "session-B";
    expect((await sendMessage(agentB, "leftover", { cwd: "/" })).ok).toBe(true);
    expect((await readOutbox(dir)).map(m => m.message)).toEqual(["leftover"]);
    await archiveAgent(repoA, id, a.agentDir);
    expect(existsSync(dir)).toBe(false);
  });
});

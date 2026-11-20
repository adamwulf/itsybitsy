import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readdir } from "fs/promises";
import { join } from "path";
import { agentOutboxDir, readOutbox } from "./outbox";
import { archiveAgent } from "./agent-lifecycle";
import { writeAgentTransient } from "./agents";
import { drainOutbox, setSendSpawnRunner, resetSendSpawnRunner } from "./ib-commands";
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

  async function plant(repo: string, id: string, session: string, coordinator = false) {
    const agent = await cli.addAgent(repo, id, {
      tmux_session: session,
      ...(coordinator ? { agentType: "repo-coordinator", worktree: false } : {}),
    });
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
    const a = await plant(repoA, "review", "session-A");
    await plant(repoB, "review", "session-B");
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
    await drainOutbox(agent, await agentOutboxDir(agent));
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
    await plant(repoA, "shared", "session-A", true);
    await plant(repoB, "shared", "session-B", true);
    await send("@coordinator", "own coordinator");
    await send("@beta", "other coordinator");
    expect((await readOutbox(queue("alpha", "shared"))).map((m) => m.message)).toEqual(["own coordinator"]);
    expect((await readOutbox(queue("beta", "shared"))).map((m) => m.message)).toEqual(["other coordinator"]);
  });

  test("machine identity separates otherwise identical queues", async () => {
    expect(await agentOutboxDir(makeAgent({ repoPath: repoA, id: "review" }))).toBe(queue("alpha", "review"));
    await Bun.write(machineNameFile(), "work/laptop");
    expect(await agentOutboxDir(makeAgent({ repoPath: repoA, id: "review" }))).toBe(queue("alpha", "review", "work-laptop"));
  });

  test("an unregistered agent without a repo id in its session fails clearly", async () => {
    await cli.writeRegistry({ repos: [] });
    await expect(agentOutboxDir(makeAgent({ repoPath: repoB, id: "review" })))
      .rejects.toThrow("unregistered and tmux_session has no repository id");
  });

  test("an unregistered repo with a registered repo's name uses its own repo id", async () => {
    await cli.writeRegistry({ repos: [{ path: repoA, name: "shared" }] });
    await Bun.write(join(repoB, ".itsybitsy", "repo-id"), "3fa9c2d1\n");
    expect(await agentOutboxDir(makeAgent({ repoPath: repoA, id: "review" }))).toBe(queue("shared", "review"));
    expect(await agentOutboxDir({ repoPath: repoB, id: "review", meta: { tmux_session: "itsybitsy-3fa9c2d1-review" } })).toBe(queue("~3fa9c2d1", "review"));
  });
});

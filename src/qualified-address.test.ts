import * as fsPromises from "node:fs/promises";
import { spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { processStartEpochSecondsCtx } from "./agents";
import { fixtureProcessStart } from "./test-cli-driver";
import { waitFor } from "./test-utils";
import { processSpawnRequests as pollFixtureWatchdog, type SpawnServerDeps, spawnRequestDir, spawnResultDir } from "./spawn-broker";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, open, readdir, realpath, rename, symlink, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setUserHome, resetUserHome } from "./home";
import { addMember, getTeam } from "./teams";
import { checkIbCommandAccess } from "./hooks/agent-path";
import { pollPeerOutbox } from "./peers/peer-outbox";
import type { SendHeader } from "./peers/send-frame";
import { resolveSendTarget } from "./resolve-target";
import { createCliFixture, type CliFixture } from "./test-cli-runner";

// The isolated CLI runs under the test harness. The watchdog's ps lookup
// has its own fixture in send-broker.test.ts.
function processSpawnRequests(id: string, repo: string, deps: SpawnServerDeps = {}) {
  return pollFixtureWatchdog(id, repo, { ...deps, send: { verifySendProcess: async () => true, ...deps.send } });
}

describe("qualified agent addresses", () => {
  let cli: CliFixture;
  let app: string;
  let web: string;
  let worktree: string;

  async function peer(connected = true, ownerPid = process.pid) {
    const generation = crypto.randomUUID();
    await Bun.write(join(cli.home, ".itsybitsy", "peer", "endpoint.lock"), ownerPid + "\n" + generation);
    await Bun.write(join(cli.home, ".itsybitsy", "peer", "remote-agents.json"), JSON.stringify({ generation, peers: [{
      name: "laptop-b", id: "peer-id", connected, lastOkAt: 15,
      agents: [{ repo: "remote", id: "remote-id", nickname: "foo", state: "waiting" }],
    }] }));
  }

  beforeEach(async () => {
    processStartEpochSecondsCtx.set(fixtureProcessStart);
    cli = await createCliFixture();
    setUserHome(cli.home);
    await Bun.write(join(cli.home, ".itsybitsy", "machine-name"), "laptop-a");
    app = await cli.addRepo("App", { nickname: "Application" });
    web = await cli.addRepo("Web");
    worktree = (await cli.addAgent(app, "mgr")).sessionCwd;
    await Bun.write(join(worktree, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Bash(ib:*)"] },
    }));
    await cli.addAgent(app, "foo", { manager: "mgr" });
  });
  afterEach(async () => {
    processStartEpochSecondsCtx.reset();
    resetUserHome();
    await cli.cleanup();
  });

  const human = { terminal: "human" as const, pid: 300, parents: [[300, 1]] as [number, number][], identityCurrent: true };
  const retire = (address: string, cwd = cli.cwd) =>
    cli.run(["retire", address], { cwd, actions: { retireAgent: "record" } });

  const hookKinds = ["claude", "codex", "agy"] as const;
  async function dispatchHook(kind: typeof hookKinds[number], id: string, command: string, cwd: string, requestedCwd = cwd) {
    const argv = kind === "claude" ? ["hook-check-path", id] : ["hooks", `${kind}-pre-tool-use`, id];
    const stdin = kind === "agy"
      ? { toolCall: { name: "run_command", args: { CommandLine: command, Cwd: requestedCwd } } }
      : { tool_name: "Bash", tool_input: { command }, cwd: requestedCwd };
    const result = await cli.run(argv, {
      cwd, stdin: JSON.stringify(stdin), allowedProcesses: [["git", "worktree", "list", "--porcelain"], ["git", "rev-parse", "--git-common-dir"]],
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    return kind === "agy" ? output : {
      decision: output.hookSpecificOutput.permissionDecision,
      reason: output.hookSpecificOutput.permissionDecisionReason,
    };
  }

  test("send help and missing-target usage both describe remote attachments", async () => {
    expect((await cli.run(["send", "--help"])).stdout).toContain("local or paired remote recipients");
    expect((await cli.run(["send"])).stderr).toContain("local or paired remote recipients");
  });

  test("a unique local bare name resolves with no peer cache or with a disconnected peer", async () => {
    expect((await retire("foo")).actions[0]?.args[0]).toMatchObject({ id: "foo", repoPath: app });
    await peer(false);
    expect((await retire("foo")).actions[0]?.args[0]).toMatchObject({ repoPath: app });
    expect((await retire("remote-id")).stderr.trim()).toBe("Agent not found: remote-id");
  });

  test("address resolution only reads the install's machine name", async () => {
    const machineFile = join(cli.home, ".itsybitsy", "machine-name");
    await rm(machineFile);
    expect((await retire("foo")).actions[0]?.args[0]).toMatchObject({ repoPath: app });
    const qualified = await retire("laptop-a/foo");
    expect(qualified.actions).toEqual([]);
    expect(qualified.stderr).toContain("Machine name is missing");
    await cli.addAgent(web, "foo");
    const ambiguous = await retire("foo");
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.actions).toEqual([]);
    expect(ambiguous.stderr.trim()).toBe("'foo' is ambiguous; use @App/foo or @Web/foo");
    expect((await retire("@App/foo")).actions[0]?.args[0]).toMatchObject({ repoPath: app });
    expect((await retire("@Web/foo")).actions[0]?.args[0]).toMatchObject({ repoPath: web });
    expect(await Bun.file(machineFile).exists()).toBe(false);
  });

  test("an unclean endpoint owner exit leaves no connected peers", async () => {
    const owner = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      await peer(true, owner.pid);
      expect((await retire("foo")).stderr).toContain("exists on laptop-a and laptop-b");
    } finally {
      owner.kill(9);
      await owner.exited;
    }
    expect((await retire("foo")).actions[0]?.args[0]).toMatchObject({ repoPath: app });
  });

  test("a stale endpoint lease is ignored when the process birth time is unavailable", async () => {
    await peer();
    const lock = join(cli.home, ".itsybitsy", "peer", "endpoint.lock");
    await utimes(lock, new Date(0), new Date(0));
    expect((await retire("foo")).actions[0]?.args[0]).toMatchObject({ repoPath: app });
  });

  test("an alias of the owning repo retains same-repo precedence and ownership", async () => {
    const alias = join(cli.root, "aliased-app");
    await symlink(app, alias);
    await cli.writeRegistry({ version: 1, repos: [{ path: alias, name: "App" }, { path: web, name: "Web" }] });
    await cli.addAgent(web, "foo");
    for (const cwd of [app, worktree]) {
      expect((await retire("foo", cwd)).actions[0]?.args[0]).toMatchObject({ repoPath: alias });
    }
    const aliasedWorktree = alias + worktree.slice(app.length);
    for (const kind of hookKinds) {
      expect(await dispatchHook(kind, "mgr", "ib retire foo", worktree, aliasedWorktree)).toMatchObject({ decision: "allow" });
      expect(await dispatchHook(kind, "mgr", "ib retire laptop-a/Web/foo", worktree, aliasedWorktree)).toMatchObject({
        decision: "deny", reason: expect.stringContaining("manager or spawner"),
      });
    }
  });

  test("agy checks the same repo as the CLI when Cwd follows a symlink before going up", async () => {
    await cli.addAgent(web, "foo", { manager: "someone-else" });
    await mkdir(join(web, "nested"));
    await symlink(join(web, "nested"), join(worktree, "link"));
    expect((await retire("foo", web)).actions[0]?.args[0]).toMatchObject({ id: "foo", repoPath: web });
    const gate = (cwd: string, command = "ib retire foo") => dispatchHook("agy", "mgr", command, worktree, cwd);
    expect(await gate(worktree)).toMatchObject({ decision: "allow" });
    expect(await gate("link/..")).toMatchObject({ decision: "deny", reason: expect.stringContaining("manager or spawner") });
    expect(await gate("link/..", "ls")).toMatchObject({ decision: "deny", reason: expect.stringContaining("Cwd rejected") });
    expect(await gate("missing/..")).toMatchObject({ decision: "deny", reason: expect.stringContaining("directory identity") });
  });

  test("all three dispatchers deny a substitution opener split by a continuation", async () => {
    const command = 'ib send foo "text $' + "\\" + '\n(printf marker)"';
    for (const kind of hookKinds) {
      expect(await dispatchHook(kind, "mgr", command, worktree)).toMatchObject({
        decision: "deny", reason: expect.stringContaining("command substitution"),
      });
    }
  });

  test("all three dispatchers allow a literal target on the next continued line", async () => {
    for (const kind of hookKinds) {
      for (const indent of ["", "  "]) {
        const command = "ib retire " + "\\" + "\n" + indent + "foo";
        expect(await dispatchHook(kind, "mgr", command, worktree)).toMatchObject({ decision: "allow" });
      }
    }
  });

  test("agy checks joined shell syntax even for an allow-listed non-ib command", async () => {
    expect(await dispatchHook("agy", "mgr", "ls .", worktree)).toMatchObject({ decision: "allow" });
    const command = 'ls "text $' + "\\" + '\n(printf marker)"';
    expect(await dispatchHook("agy", "mgr", command, worktree)).toMatchObject({
      decision: "deny", reason: expect.stringContaining("run_command cannot contain shell metacharacters"),
    });
  });

  test("the owning repo of an unregistered worktree precedes registered repos and peers", async () => {
    await cli.writeRegistry({ version: 1, repos: [{ path: web, name: "Web" }] });
    await cli.addAgent(web, "foo");
    await peer();
    expect((await retire("foo", worktree)).actions[0]?.args[0]).toMatchObject({ repoPath: app });
    // The Claude hook authenticates against the registry before the resolver is called.
    expect(await dispatchHook("claude", "mgr", "ib retire foo", worktree)).toMatchObject({
      decision: "deny", reason: expect.stringContaining("registered"),
    });
  });

  test("machine-wide searches refuse partial visibility even with a visible local match", async () => {
    const dir = join(web, ".itsybitsy", "agents");
    await rm(dir, { recursive: true });
    await Bun.write(dir, "unlistable");
    for (const [target, cwd] of [["foo", cli.cwd], ["laptop-a/foo", app]] as const) {
      const result = await retire(target, cwd);
      expect(result.actions).toEqual([]);
      expect(result.stderr).toContain(dir);
      expect(result.stderr).toContain("machine/repo/agent");
    }
    expect((await retire("laptop-a/App/foo")).actions[0]?.args[0]).toMatchObject({ repoPath: app });
  });

  test("empty @ address segments cannot dispatch to the team or coordinator", async () => {
    expect((await cli.run(["team", "create", "crew"])).exitCode).toBe(0);
    await addMember("crew", "foo");
    await cli.addAgent(app, "App", { agentType: "repo-coordinator" });
    for (const argv of [["send", "@crew/", "hi"], ["retire", "@App/"]]) {
      const actions = { teamSend: "record", retireAgent: "record" } as const;
      const valid = argv.map((arg) => arg.endsWith("/") ? arg.slice(0, -1) : arg);
      expect((await cli.run(valid, { actions })).actions).toHaveLength(1);
      const result = await cli.run(argv, { actions });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe(`Agent not found: ${argv[1]}`);
      expect(result.actions).toEqual([]);
    }
  });

  test("team add and remove reject a selection whose stored id routes to another repo", async () => {
    await cli.addAgent(web, "foo");
    expect((await cli.run(["team", "create", "crew"])).exitCode).toBe(0);
    const wrongRepo = "laptop-a/App/foo";
    const add = await cli.run(["team", "add", "crew", wrongRepo]);
    expect(add.exitCode).toBe(1);
    expect(add.stderr).toContain("bare id 'foo'");
    expect((await getTeam("crew"))?.members).toEqual([]);
    await addMember("crew", "foo"); // The stored id routes to Web.
    const remove = await cli.run(["team", "remove", "crew", wrongRepo]);
    expect(remove.exitCode).toBe(1);
    expect(remove.stderr).toContain("bare id 'foo'");
    expect((await getTeam("crew"))?.members).toEqual(["foo"]);
  });

  test("rehire deduplicates repeated archive ids and reports reusable nicknames", async () => {
    async function archive(key: string, id: string) {
      await Bun.write(join(web, ".itsybitsy", "archive", key, "meta.json"), JSON.stringify({ id, nickname: "former" }));
    }
    await archive("first", "old-one");
    await archive("second", "old-one");
    const rehire = (target: string) => cli.run(["rehire", target], { cwd: web, actions: { rehireAgent: "record" } });
    expect((await rehire("former")).actions[0]?.args[0]).toBe("old-one");
    await archive("third", "old-two");
    for (const target of ["former", "@Web/former", "laptop-a/Web/former"]) {
      const result = await rehire(target);
      expect(result.stderr).toContain("@Web/old-one or @Web/old-two");
      expect(result.actions).toEqual([]);
    }
  });

  test("rehire suggestions from an unregistered worktree round-trip as bare immutable ids", async () => {
    await cli.writeRegistry({ version: 1, repos: [{ path: web, name: "Web" }] });
    for (const id of ["first-id", "second-id"]) {
      await Bun.write(join(app, ".itsybitsy", "archive", `20261121-120000-${id}`, "meta.json"),
        JSON.stringify({ id, nickname: "former" }));
    }
    const run = (target: string) => cli.run(["rehire", target], { cwd: worktree, actions: { rehireAgent: "record" } });
    const ambiguous = await run("former");
    expect(ambiguous.exitCode).toBe(1);
    const suggestions = ambiguous.stderr.trim().split("; use ")[1]?.split(" or ");
    expect(suggestions).toEqual(["first-id", "second-id"]);
    for (const id of suggestions!) {
      expect((await run(id)).actions[0]?.args).toEqual([id, { repoPath: app }]);
    }
  });

  test("targeted ack requires the child's manager even for the system coordinator", async () => {
    const system = join(cli.home, ".itsybitsy");
    for (const kind of hookKinds) {
      // The system coordinator uses Claude. Other dispatchers reject its id
      // before opening an agent session.
      const reason = kind === "claude" ? /only the manager/ : /invalid agent[- ]id/i;
      expect(await dispatchHook(kind, "@system", "ib ack @App/foo", system)).toMatchObject({
        decision: "deny", reason: expect.stringMatching(reason),
      });
    }
    const result = await cli.run(["ack", "@App/foo"], { cwd: system });
    expect(result.stderr).toContain("only foo's manager (mgr)");
    expect(result.exitCode).toBe(1);
  });

  test("remote agent and coordinator addresses resolve for sends only", async () => {
    await peer();
    for (const address of ["remote-id", "LAPTOP-B/foo", "laptop-B/ReMoTe/foo"]) {
      expect((await resolveSendTarget(address, [], cli.cwd)).remote)
        .toEqual({ peer: "peer-id", target: { kind: "agent", repo: "remote", agent: "remote-id" } });
      expect((await retire(address)).stderr.trim()).toBe("remote agents are read-only");
    }
    for (const [target, shape] of [["@system", { kind: "system" }], ["@photos", { kind: "repo-coordinator", repo: "photos" }]] as const) {
      expect((await resolveSendTarget("laptop-b/" + target, [], cli.cwd)).remote?.target).toEqual(shape);
      expect((await retire("laptop-b/" + target)).stderr.trim()).toBe("remote agents are read-only");
    }
    for (const kind of hookKinds) {
      expect(await dispatchHook(kind, "mgr", "ib send laptop-b/remote/remote-id hi", worktree)).toMatchObject({ decision: "allow" });
    }
  });

  test("remote CLI hands the verified sender to the watcher and prints the acknowledgement", async () => {
    await peer();
    const agentDir = join(app, ".itsybitsy", "agents", "mgr");
    await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
    let processing: Promise<void> | undefined;
    const watchdog = setInterval(() => {
      processing ??= processSpawnRequests("mgr", app, { verifySeal: async () => ({ ok: true }) })
        .then(() => {}).finally(() => { processing = undefined; });
    }, 25);
    const seen: SendHeader[] = [];
    const timer = setInterval(() => { void pollPeerOutbox(async (id, header) => {
      expect(id).toBe("peer-id");
      seen.push(header);
      if (header.message === "refuse") throw new Error("Recipient stopped");
      return header.id;
    }, line => { throw new Error(line); }); }, 25);
    const send = (args: string[], cwd = cli.cwd, terminal: "human" | "tmux" | "agent" | undefined = cwd === cli.cwd ? "human" : undefined) => cli.run(["send", "laptop-b/remote/remote-id", ...args], { cwd, ancestry: { ...human, terminal } });
    try {
      expect((await send(["hi"])).stdout.trim()).toBe("Sent to remote/remote-id");
      expect((await send(["refuse"])).stderr.trim()).toBe("Recipient stopped");
      expect((await send(["--from", "mgr", "hello"], worktree)).exitCode).toBe(0);
      expect((await send(["--from", "imposter", "hello"], worktree)).stderr).toContain("--from must match");
      const system = join(cli.home, ".itsybitsy");
      expect((await send(["human at home"], system, "human")).exitCode).toBe(0);
      const fromHome = (parent: number) => cli.run(["send", "laptop-b/remote/remote-id", "system message"], {
        cwd: system, ancestry: { ...human, terminal: "agent", systemPanePid: 200, parents: [[300, parent], [parent, 1]] },
      });
      expect((await fromHome(250)).stderr).toContain("cannot verify the sender");
      expect((await fromHome(200)).exitCode).toBe(0);
      expect((await send(["plain tmux"], cli.cwd, "tmux")).stderr).toContain("cannot verify the sender");
      expect((await send(["agent tmux"], worktree, "tmux")).exitCode).toBe(0);
      expect((await send(["moved"], cli.cwd, "agent")).stderr).toContain("cannot verify the sender");
      const fake = join(app, ".itsybitsy", "agents", "fake", "repo");
      await mkdir(fake, { recursive: true });
      expect((await send(["bad"], fake)).stderr).toContain("cannot verify the sender");
      expect(seen.map(h => h.from)).toEqual([{ kind: "user" }, { kind: "user" },
        { kind: "agent", id: "laptop-a/App/mgr" }, { kind: "user" }, { kind: "system" }, { kind: "agent", id: "laptop-a/App/mgr" }]);
      const registry = join(cli.home, ".itsybitsy", "repos.json");
      await Bun.write(registry, JSON.stringify({ repos: [] }));
      expect((await send(["unregistered agent"], worktree)).stderr).toContain("repo to be registered");
      expect((await send(["terminal in unregistered worktree"], worktree, "human")).stderr).toContain("repo to be registered");
      expect((await send(["unregistered human"], cli.cwd, "human")).exitCode).toBe(0);
      expect(seen.at(-1)?.from).toEqual({ kind: "user" });
      expect(seen.every(h => h.files.length === 0)).toBe(true);
    } finally { clearInterval(timer); clearInterval(watchdog); await processing; }
  });

  test.each([false, true])("remote CLI publishes the original text, manifest and verified bytes (broker=%s)", async broker => {
    await peer();
    const cwd = broker ? worktree : cli.cwd;
    await Bun.write(join(cwd, "report"), "snapshot");
    const agentDir = dirname(worktree);
    await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
    let processing: Promise<number> | undefined;
    const watchdog = setInterval(() => {
      if (broker) processing ??= processSpawnRequests("mgr", app, { verifySeal: async () => ({ ok: true }) })
        .finally(() => { processing = undefined; });
    }, 25);
    const seen: SendHeader[] = [];
    const timer = setInterval(() => { void pollPeerOutbox(async (_peer, header, transfer) => {
      expect(await Bun.file(join(transfer.filesDir!, "0")).text()).toBe("snapshot");
      seen.push(header);
      return header.id;
    }, () => {}); }, 25);
    try {
      const result = await cli.run(["send", "laptop-b/remote/remote-id", "--attach", "./report", "read ./report"], {
        cwd, ancestry: human, sandboxed: broker, allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(seen).toMatchObject([{ message: "read ./report", from: { kind: broker ? "agent" : "user" },
        files: [{ name: "report", size: 8, spellings: ["./report", await realpath(join(cwd, "report"))] }] }]);
      if (broker) {
        // A short-lived CLI may exit after ACK while its cleanup is pending.
        // The watchdog reclaims the lease on its next post-expiry pass.
        clearInterval(watchdog);
        await processing;
        await processSpawnRequests("mgr", app, { transferJobs: new Map(), now: () => Date.now() + 25 * 3600_000 });
        expect(await readdir(join(agentDir, "send-attachments"))).toEqual([]);
      }
    } finally { clearInterval(timer); clearInterval(watchdog); await processing; }
  });

  test.each(["local recipient", "self", "changed bytes", "dead before append", "dead before self append"])("sandboxed local --attach through the worktree watchdog: %s", async mode => {
    const agentDir = dirname(worktree);
    const recipient = mode.includes("self") ? "mgr" : "foo";
    const live = JSON.stringify({ watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false,
      tmux_rate_limited: false, has_background_tasks: false });
    await Bun.write(join(agentDir, "meta.transient.json"), live);
    await Bun.write(join(app, ".itsybitsy", "agents", recipient, "meta.transient.json"), live);
    await Bun.write(join(worktree, "report"), "original");
    const controller = new AbortController();
    const send = cli.run(["send", "@App/" + recipient, "--attach", "./report", "read ./report"], {
      cwd: worktree, sandboxed: true, ancestry: human, interrupt: controller.signal,
      allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
    });
    try {
      await Promise.race([waitFor(async () => (await readdir(spawnRequestDir(agentDir)).catch(() => [])).some(n => n.endsWith(".json"))),
        send.then(result => { throw Error("CLI exited before handoff: " + result.stderr); })]);
      const [id] = await readdir(join(agentDir, "send-attachments"));
      if (mode === "changed bytes") await Bun.write(join(agentDir, "send-attachments", id!, "0"), "modified");
      const death = mode.startsWith("dead before");
      const open = fsPromises.open;
      const { pid } = await Bun.file(join(agentDir, "send-attachments", id!, "lease")).json();
      const held = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
        const file = await open(...args);
        if (death && String(args[0]).endsWith("/outbox.jsonl")) {
          processStartEpochSecondsCtx.set(current => fixtureProcessStart(current) + (current === pid ? 1 : 0));
        }
        return file;
      });
      try { await processSpawnRequests("mgr", app, { verifySeal: async () => ({ ok: true }), send: { attachmentTempDir: cli.cwd } }); }
      finally { held.mockRestore(); }
      const result = await send;
      const queue = Bun.file(join(cli.home, ".itsybitsy", "agents", recipient, "outbox.jsonl"));
      if (death) {
        expect(result.stderr).toContain("Cannot verify the staging lease owner");
        expect(await queue.text()).toBe("");
      } else if (mode === "changed bytes") {
        expect(result.stderr).toContain("hash mismatch");
        expect(await queue.exists()).toBe(false);
        expect((await readdir(cli.cwd)).filter(n => n.startsWith("itsybitsy-attachments-"))).toEqual([]);
      } else {
        expect(result.exitCode, result.stderr).toBe(0);
        const queued = JSON.parse((await queue.text()).trim());
        expect(queued).toMatchObject({ fromAgent: "mgr", noPassthrough: true });
        const [dir] = (await readdir(cli.cwd)).filter(n => n.startsWith("itsybitsy-attachments-"));
        const path = join(cli.cwd, dir!, "0", "report");
        expect(queued.message).toContain("read " + path);
        expect(queued.message).toContain("./report");
        expect(await Bun.file(path).text()).toBe("original");
        expect(await readdir(join(cli.cwd, dir!))).toEqual(["0"]);
      }
      expect(await readdir(join(cli.cwd, "staging", "incoming"))).toEqual([]);
    } finally { controller.abort(); await send; }
  });

  test.each(["unavailable", "mismatched", "changed during copy"])("watchdog refuses a remote send with %s owner evidence", async evidence => {
    await peer();
    const agentDir = dirname(worktree);
    await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
    const controller = new AbortController();
    await Bun.write(join(worktree, "report"), "body");
    const send = cli.run(["send", "laptop-b/remote-id", "--attach", "report", "read"], {
      cwd: worktree, sandboxed: true, ancestry: human, interrupt: controller.signal,
      allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
    });
    try {
      await waitFor(async () => (await readdir(spawnRequestDir(agentDir)).catch(() => [])).some(n => n.endsWith(".json")));
      const [id] = await readdir(join(agentDir, "send-attachments"));
      const { sweepStagingLease } = await import("./send-broker");
      await sweepStagingLease(agentDir, id!, Date.now());
      const stamp = await Bun.file(join(agentDir, "send-attachments", id!, "owner.json")).json();
      expect(stamp.start).toBe(fixtureProcessStart(stamp.pid));
      processStartEpochSecondsCtx.set(pid => {
        if (evidence === "unavailable") return null;
        const copying = existsSync(join(agentDir, "send-attachments", id!, "0"));
        return fixtureProcessStart(pid) + (pid === stamp.pid && (evidence !== "changed during copy" || !copying) ? 1 : 0);
      });
      await processSpawnRequests("mgr", app, { verifySeal: async () => ({ ok: true }) });
      expect(await send).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Cannot verify the staging lease owner") });
      expect((await readdir(join(cli.home, ".itsybitsy/peer-outbox")).catch(() => [])).filter(name => !name.startsWith("."))).toEqual([]);
    } finally { controller.abort(); await send; }
  });

  test("worktree Ctrl-C resets a claimed attachment transfer and releases both staging directories", async () => {
    await peer();
    const agentDir = dirname(worktree);
    await Bun.write(join(worktree, "report"), "body");
    await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
    const controller = new AbortController();
    const cliSend = cli.run(["send", "laptop-b/remote-id", "--attach", "report", "read"], {
      cwd: worktree, sandboxed: true, ancestry: human, interrupt: controller.signal,
      allowedProcesses: [["git", "rev-parse", "--git-common-dir"]],
    });
    try {
      await waitFor(async () => (await readdir(spawnRequestDir(agentDir)).catch(() => [])).some(n => n.endsWith(".json")));
      const jobs = new Map<string, Promise<void>>();
      const deps = { verifySeal: async () => ({ ok: true as const }), transferJobs: jobs };
      expect(await processSpawnRequests("mgr", app, deps)).toBe(1);
      const broker = jobs.get(agentDir)!;
      const extra = "b".repeat(32);
      await Bun.write(join(spawnRequestDir(agentDir), extra + ".json"), JSON.stringify({ op: "remote-send" }));
      await processSpawnRequests("mgr", app, deps);
      expect((await Bun.file(join(spawnResultDir(agentDir), extra + ".json")).json()).stderr).toContain("busy");
      const base = join(cli.home, ".itsybitsy/peer-outbox");
      await Promise.race([
        waitFor(async () => (await readdir(base).catch(() => [])).some(n => !n.startsWith("."))),
        cliSend.then(result => { throw new Error("CLI exited before peer-outbox publication: " + result.stderr); }),
      ]);
      const entered = Promise.withResolvers<void>();
      let reset = false;
      let filesDir = "";
      const watcher = pollPeerOutbox(async (_peer, _header, transfer) => {
        filesDir = transfer.filesDir!;
        entered.resolve();
        return new Promise((_, reject) => transfer.signal!.addEventListener("abort", () => {
          reset = true;
          reject(transfer.signal!.reason);
        }));
      }, () => {});
      await entered.promise;
      controller.abort();
      expect(await cliSend).toMatchObject({ exitCode: 130, stderr: expect.stringContaining("outcome unknown — check the recipient") });
      await Promise.all([broker, watcher]);
      expect(reset).toBe(true);
      await expect(readdir(filesDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(agentDir, "send-attachments"))).toEqual([]);
    } finally { controller.abort(); await cliSend; }
  });

  test("only the watchdog verifies a remote sender whose common Git directory is denied", async () => {
    await peer();
    const git = join(await realpath(app), ".git");
    const agent = await cli.addAgent(app, "private-git", { sandbox: { enabled: true }, paths: { deny: [git, git + "/**"] } });
    const run = (args: string[]) => cli.run(["send", ...args], { cwd: agent.sessionCwd, sandboxed: true });
    await Bun.write(join(agent.sessionCwd, "report"), "fixture");
    const local = await run(["mgr", "--attach", "report", "read"]);
    expect(local.stderr).toContain("cannot verify the sender for attachments");
    expect(local.actions).toEqual([]);

    await Bun.write(join(agent.agentDir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
    const messages: SendHeader[] = [];
    const timer = setInterval(() => { void pollPeerOutbox(async (_id, header) => {
      messages.push(header);
      return header.id;
    }, () => {}); }, 25);
    const mode = (await Bun.file(git).stat()).mode & 0o777;
    try {
      // Model the client kernel boundary. Restore the watchdog's access only
      // once the CLI has actually submitted its request.
      await chmod(git, 0);
      const remote = run(["laptop-b/remote/remote-id", "hello"]);
      await waitFor(async () => (await readdir(spawnRequestDir(agent.agentDir)).catch(() => [])).some(name => name.endsWith(".json")));
      await chmod(git, mode);
      await processSpawnRequests(agent.id, app, { verifySeal: async () => ({ ok: true }) });
      const result = await remote;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(messages).toMatchObject([{ message: "hello", from: { id: "laptop-a/App/private-git" } }]);
      await expect(readdir(join(agent.agentDir, "send-attachments"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await chmod(git, mode); clearInterval(timer); }
  });

  test("a worktree without a live watchdog reports validation errors before liveness", async () => {
    const file = join(worktree, "large-message");
    await Bun.write(file, "x".repeat(300 * 1024));
    const send = (args: string[]) => cli.run(["send", "laptop-b/remote-id", ...args], { cwd: worktree, ancestry: human });
    expect((await send(["-f", file])).stderr).toContain("Send header exceeds 262144 bytes");
    expect((await cli.run(["send", "laptop-b/remote-id", "-f", file], { ancestry: human })).stderr)
      .toContain("Send header exceeds 262144 bytes");
    expect((await send(["hi"])).stderr).toContain("need its watchdog running");
  });

  test("a collision-suffixed coordinator sends remotely and attaches locally under its actual id", async () => {
    await cli.addAgent(app, "App", { worktree: true });
    const id = "App-a3f1";
    await cli.addAgent(app, id, { agentType: "repo-coordinator", worktree: false, claude_pid: "200",
      claude_pid_epoch: 100, sandbox: { enabled: false } });
    await peer();
    const ancestry = { pid: 300, parents: [[300, 200], [200, 1]] as [number, number][], identityCurrent: true };
    const headers: SendHeader[] = [];
    const timer = setInterval(() => { void pollPeerOutbox(async (_peer, header) => {
      headers.push(header);
      return header.id;
    }, () => {}); }, 25);
    try {
      const remote = await cli.run(["send", "laptop-b/remote/remote-id", "hi"], { cwd: app, ancestry });
      expect(remote.exitCode, remote.stderr).toBe(0);
      expect(headers[0]?.from).toEqual({ kind: "agent", id: "laptop-a/App/" + id });
      await Bun.write(join(app, "report"), "snapshot");
      const local = await cli.run(["send", "mgr", "--attach", "report", "read"], { cwd: app, ancestry,
        actions: { sendMessage: "record" }, allowedProcesses: [["git", "rev-parse", "--git-common-dir"]] });
      expect(local.exitCode, local.stderr).toBe(0);
      const args = local.actions[0]!.args;
      const destination = String(args[1]).split(" → ")[1]!;
      try {
        expect(args[2]).toMatchObject({ fromAgent: id, noPassthrough: true });
        expect(await Bun.file(destination).text()).toBe("snapshot");
      } finally { await rm(dirname(dirname(destination)), { recursive: true, force: true }); }
    } finally { clearInterval(timer); }
  });

  test("a shared checkout distinguishes its dotted coordinator, a human, and unverifiable ancestry", async () => {
    const repo = await cli.addRepo("project.com");
    await cli.addAgent(repo, "project.com", {
      agentType: "repo-coordinator", worktree: false, claude_pid: "200", claude_pid_epoch: 100,
    });
    const alias = join(cli.cwd, "registered-alias");
    await symlink(repo, alias);
    const registryFile = Bun.file(join(cli.home, ".itsybitsy", "repos.json"));
    const registry = await registryFile.json();
    registry.repos.find((entry: { name: string }) => entry.name === "project.com").path = alias;
    await Bun.write(registryFile, JSON.stringify(registry));
    await peer();
    const senders: SendHeader["from"][] = [];
    const timer = setInterval(() => { void pollPeerOutbox(async (_id, header) => {
      senders.push(header.from);
      return header.id;
    }, () => {}); }, 25);
    const send = (parents: [number, number][], identityCurrent: boolean, terminal?: "human", sandboxed = false) =>
      cli.run(["send", "laptop-b/remote/remote-id", "hi"], { cwd: repo, sandboxed,
        ancestry: { pid: 300, parents, identityCurrent, terminal } });
    try {
      expect((await send([[300, 200], [200, 1]], true)).exitCode).toBe(0);
      expect((await send([[300, 200], [200, 1]], true, undefined, true)).stderr)
        .toContain("remote sends from a sandboxed repo coordinator are not supported yet");
      await cli.addAgent(repo, "launching", { worktree: false, claude_pid: "" });
      expect((await send([[300, 1]], true, "human")).exitCode).toBe(0);
      expect((await send([[300, 200], [200, 1]], false)).stderr).toContain("cannot verify the sender");
      expect((await send([], true)).stderr).toContain("cannot verify the sender");
      await cli.addAgent(repo, "moving", { worktree: true, claude_pid: "400", claude_pid_epoch: 123 });
      expect((await send([[300, 400], [400, 1]], true)).stderr).toContain("cannot verify the sender");
      expect(senders).toEqual([{ kind: "agent", id: "laptop-a/project.com/project.com" }, { kind: "user" }]);
    } finally { clearInterval(timer); }
  });

  test("SIGINT while -f is waiting for text cancels before either handoff", async () => {
    const fifo = join(cli.cwd, "slow-message");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const interrupt = new AbortController();
    const send = cli.run(["send", "laptop-b/remote/remote-id", "-f", fifo], { cwd: worktree, interrupt: interrupt.signal });
    const writer = await open(fifo, "w"); // The CLI has opened the read side and cannot receive EOF yet.
    try {
      interrupt.abort();
      expect(await send).toMatchObject({ exitCode: 130, stdout: "", stderr: "cancelled before sending\n" });
    } finally { await writer.close(); }
    expect(await readdir(spawnRequestDir(join(app, ".itsybitsy", "agents", "mgr"))).catch(() => [])).toEqual([]);
    expect(await readdir(join(cli.home, ".itsybitsy", "peer-outbox")).catch(() => [])).toEqual([]);
  });

  for (const broker of [false, true]) {
    test.each([false, true])(`CLI SIGINT arbitrates a ${broker ? "broker" : "direct"} send (claimed=%s)`, async claimed => {
      await peer();
      const interrupt = new AbortController();
      const agentDir = join(app, ".itsybitsy", "agents", "mgr");
      await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
        watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
      }));
      const send = cli.run(["send", "laptop-b/remote/remote-id", "interrupt me"], {
        cwd: broker ? worktree : cli.cwd, ancestry: human, sandboxed: broker, interrupt: interrupt.signal,
      });
      const queue = broker ? spawnRequestDir(agentDir) : join(cli.home, ".itsybitsy", "peer-outbox");
      let ready = "";
      try {
        await waitFor(async () => {
          const name = (await readdir(queue).catch(() => [])).find(n => !n.startsWith("."));
          if (name) ready = join(queue, name);
          return !!name;
        });
        if (claimed) await rename(ready, ready + ".claimed");
        interrupt.abort();
        const result = await send;
        expect(result.exitCode).toBe(130);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(claimed ? "outcome unknown" : "cancelled before sending");
        expect(await readdir(queue)).not.toContain(ready.slice(queue.length + 1));
      } finally { interrupt.abort(); await send; }
    });
  }

  test("remote sends diagnose a missing watcher from its lock", async () => {
    const result = await cli.run(["send", "laptop-b/remote/remote-id", "hi"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe("remote sends need ib watch running on this machine");
  });

  test("an unclaimed CLI handoff times out and cannot be sent later", async () => {
    await peer();
    const result = await cli.run(["send", "laptop-b/remote/remote-id", "hi"], { timeoutMs: 15_000, ancestry: human });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("timed out before ib watch claimed");
    await pollPeerOutbox(async () => { throw new Error("unexpected send"); }, () => {});
    expect((await (await import("node:fs/promises")).readdir(join(cli.home, ".itsybitsy", "peer-outbox"))).filter(name => !name.startsWith("."))).toEqual([]);
  }, 16_000);

  test("leading @ belongs to repo addressing", async () => {
    const { sanitizeMachineName } = await import("./machine-name");
    const { peerNameProblem } = await import("./peers/store");
    expect(sanitizeMachineName(" @ @App ")).toBe("App");
    expect(peerNameProblem("@App", "id", [], "here")).toContain("cannot start with @");
    await peer();
    const path = join(cli.home, ".itsybitsy", "peer", "remote-agents.json");
    const cache = await Bun.file(path).json();
    cache.peers[0].name = "@App";
    await Bun.write(path, JSON.stringify(cache));
    expect((await resolveSendTarget("@App/foo", [{ path: app, name: "App" }], cli.cwd)).agent?.id).toBe("foo");
    expect((await resolveSendTarget("remote-id", [], cli.cwd)).remote).toBeUndefined();
  });

  test("ambiguous bare names show the shortest exact forms per machine", async () => {
    await peer();
    expect((await retire("foo")).stderr.trim()).toBe("'foo' exists on laptop-a and laptop-b; use laptop-a/foo or laptop-b/foo");
    await cli.addAgent(web, "web-id", { nickname: "foo" });
    expect((await retire("foo")).stderr.trim()).toBe(
      "'foo' exists on laptop-a and laptop-b; use laptop-a/App/foo or laptop-a/Web/foo or laptop-b/foo");
    expect((await retire("laptop-a/foo", app)).stderr.trim()).toBe(
      "'foo' exists on laptop-a; use laptop-a/App/foo or laptop-a/Web/foo");
  });

  test("ambiguity suggestions shell-quote spaces and apostrophes", async () => {
    await peer();
    const file = join(cli.home, ".itsybitsy", "machine-name");
    for (const [machine, quoted] of [["Studio Mac", "'Studio Mac/foo'"], ["Adam's Mac", "'Adam'\\''s Mac/foo'"]] as const) {
      await Bun.write(file, machine);
      const [, suggestions] = (await retire("foo")).stderr.trim().split("; use ");
      expect(suggestions?.split(" or ").sort()).toEqual([quoted, "laptop-b/foo"]);
    }
  });

  test("qualified local names ignore machine and registry name case and preserve exact id and nickname case", async () => {
    await cli.addAgent(web, "web-id", { nickname: "OnlyWeb" });
    for (const address of ["Laptop-A/OnlyWeb", "laptop-A/wEB/OnlyWeb", "@web/web-id"]) {
      expect((await retire(address, app)).actions[0]?.args[0]).toMatchObject({ id: "web-id", repoPath: web });
    }
    for (const address of ["laptop-a/Wed/OnlyWeb", "laptop-a/web/onlyweb", "laptop-a/Application/foo", "missing"]) {
      expect((await retire(address)).stderr.trim()).toBe(`Agent not found: ${address}`);
    }
    expect((await retire("unknown/foo")).stderr.trim()).toBe("Unknown machine: unknown");
  });

  test("qualified rehire passes the archived id and repo through the CLI and ownership gate", async () => {
    await Bun.write(join(web, ".itsybitsy", "archive", "20261120-120000-foo", "meta.json"),
      JSON.stringify({ id: "foo", nickname: "former", manager: "mgr" }));
    const address = "laptop-a/WEB/former";
    const result = await cli.run(["rehire", address], { cwd: app, actions: { rehireAgent: "record" } });
    expect(result.actions[0]?.args).toEqual(["foo", { repoPath: web }]);
    expect(await checkIbCommandAccess(`ib rehire ${address}`, "mgr", join(web, ".itsybitsy", "agents"), app)).toBeNull();
    expect((await checkIbCommandAccess(`ib rehire ${address}`, "mgr", join(app, ".itsybitsy", "agents"), app))?.decision).toBe("deny");
  });

  test("manager and system gates use the command's cwd, ambiguity and qualified repo", async () => {
    await cli.addAgent(web, "foo", { manager: "mgr" }); // same manager id in a different repo
    const gate = (address: string, cwd: string, caller = "mgr") =>
      checkIbCommandAccess(`ib retire '${address}'`, caller, join(app, ".itsybitsy", "agents"), cwd);
    for (const cwd of [app, worktree]) {
      expect(await gate("foo", cwd)).toBeNull();
      expect((await retire("foo", cwd)).actions[0]?.args[0]).toMatchObject({ repoPath: app });
    }
    const ambiguous = await retire("foo");
    expect(ambiguous.exitCode).toBe(1);
    for (const caller of ["mgr", "@system"]) {
      expect((await gate("foo", cli.cwd, caller))?.reason).toBe("Access denied: " + ambiguous.stderr.trim());
    }
    expect((await gate("LAPTOP-A/Web/foo", worktree))?.decision).toBe("deny");
    expect(await gate("LAPTOP-A/Web/foo", worktree, "@system")).toBeNull();
    expect((await retire("LAPTOP-A/Web/foo", worktree)).actions[0]?.args[0]).toMatchObject({ repoPath: web });
    expect(await gate("LAPTOP-A/App/foo", cli.cwd)).toBeNull();
  });
});

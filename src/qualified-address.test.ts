import { waitFor } from "./test-utils";
import { processSpawnRequests, spawnRequestDir } from "./spawn-broker";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, open, readdir, rename, symlink, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setUserHome, resetUserHome } from "./home";
import { addMember, getTeam } from "./teams";
import { checkIbCommandAccess } from "./hooks/agent-path";
import { pollPeerOutbox } from "./peers/peer-outbox";
import type { SendHeader } from "./peers/send-frame";
import { resolveSendTarget } from "./resolve-target";
import { createCliFixture, type CliFixture } from "./test-cli-runner";

describe("qualified agent addresses", () => {
  let cli: CliFixture;
  let app: string;
  let web: string;
  let worktree: string;

  async function peer(connected = true, ownerPid = process.pid) {
    await Bun.write(join(cli.home, ".itsybitsy", "peer", "endpoint.lock"), String(ownerPid));
    await Bun.write(join(cli.home, ".itsybitsy", "peer", "remote-agents.json"), JSON.stringify([{
      name: "laptop-b", id: "peer-id", connected, lastOkAt: 15,
      agents: [{ repo: "remote", id: "remote-id", nickname: "foo", state: "waiting" }],
    }]));
  }

  beforeEach(async () => {
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
        expect(result.stderr).toContain(claimed ? "outcome unknown" : "withdrawn");
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
    cache[0].name = "@App";
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

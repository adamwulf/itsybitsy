import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { setUserHome, resetUserHome } from "./home";
import { addMember, getTeam } from "./teams";
import { checkIbCommandAccess } from "./hooks/agent-path";
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

  test("a unique remote id or nickname produces the command-specific error", async () => {
    await peer();
    expect((await retire("remote-id")).stderr.trim()).toBe("remote agents are read-only");
    for (const address of ["remote-id", "LAPTOP-B/foo", "laptop-B/ReMoTe/foo"]) {
      const sent = await cli.run(["send", address, "hello"]);
      expect(sent.exitCode).toBe(1);
      expect(sent.stderr.trim()).toBe("sending to agents on other machines is not supported yet");
    }
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

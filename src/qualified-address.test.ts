import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setUserHome, resetUserHome } from "./home";
import { checkIbCommandAccess } from "./hooks/agent-path";
import { createCliFixture, type CliFixture } from "./test-cli-runner";

describe("qualified agent addresses", () => {
  let cli: CliFixture;
  let app: string;
  let web: string;
  let worktree: string;

  async function peer(connected = true) {
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
    await cli.addAgent(app, "foo", { manager: "mgr" });
  });
  afterEach(async () => {
    resetUserHome();
    await cli.cleanup();
  });

  const retire = (address: string, cwd = cli.cwd) =>
    cli.run(["retire", address], { cwd, actions: { retireAgent: "record" } });

  test("a unique local bare name resolves with no peer cache or with a disconnected peer", async () => {
    expect((await retire("foo")).actions[0]?.args[0]).toMatchObject({ id: "foo", repoPath: app });
    await peer(false);
    expect((await retire("foo")).actions[0]?.args[0]).toMatchObject({ repoPath: app });
    expect((await retire("remote-id")).stderr.trim()).toBe("Agent not found: remote-id");
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

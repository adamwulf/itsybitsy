/**
 * `ib ack <agent-id>` (SPEC §8.5.2): the owner gate, persistence,
 * idempotence, and invalidation of the ack by the shared state writer —
 * including state changes that land between two watchdog polls.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from "fs/promises";
import { homedir, tmpdir } from "os";
import { makeAgent } from "./test-utils";
import type { Agent } from "./agents";
import { currentAck, readAgentAck, writeAgentState } from "./agents";
import { parseAgentTypeFile } from "./agent-types";
import {
  anchorRelativePaths,
  canonicalizePathsConfig,
  canonicalizeSandboxPath,
  generateProfile,
  resolvePathsConfig,
  resolveSandboxConfig,
  resolveTmuxSocketDir,
  sandboxProfileParameterValues,
  type PathsConfig,
  type SandboxConfig,
  type SandboxProfileParams,
} from "./sandbox";
import {
  ackAgent,
  ackAllSubagents,
  setNewAgentNoWorktreeCallerResolver,
  resetNewAgentNoWorktreeCallerResolver,
} from "./ib-commands";

let root: string;

/** `<root>/<repo>/.ittybitty/agents/<id>` with a meta.json and a worktree dir. */
async function writeAgent(repo: string, id: string, meta: Record<string, unknown>): Promise<string> {
  const agentDir = join(root, repo, ".ittybitty", "agents", id);
  await mkdir(join(agentDir, "repo"), { recursive: true });
  await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `ittybitty-r-${id}`, ...meta }, null, 2));
  return agentDir;
}

/** The Agent that `requireAgent` would hand to `ackAgent`, read from disk. */
async function agentFor(repo: string, id: string): Promise<Agent> {
  const meta = JSON.parse(await readFile(join(root, repo, ".ittybitty", "agents", id, "meta.json"), "utf-8"));
  return makeAgent({ id, repoPath: join(root, repo), meta: { ...makeAgent({ id }).meta, ...meta } });
}

/** The cwd of agent `id`'s session: its worktree. */
function sessionOf(repo: string, id: string): string {
  return join(root, repo, ".ittybitty", "agents", id, "repo");
}

async function readMeta(repo: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, repo, ".ittybitty", "agents", id, "meta.json"), "utf-8"));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ib-ack-"));
  // No worktree:false agents here: keep caller resolution off the real
  // registry and /bin/ps, so it identifies a worktree caller by its cwd.
  setNewAgentNoWorktreeCallerResolver(async () => null);
  await writeAgent("repo", "mgr", { manager: null, state: "running" });
  await writeAgent("repo", "child", { manager: "mgr", state: "waiting", state_updated_at: 1234 });
});

afterEach(async () => {
  resetNewAgentNoWorktreeCallerResolver();
  await rm(root, { recursive: true, force: true });
});

describe("ackAllSubagents — manager shortcut", () => {
  test("acknowledges waiting and complete direct children only, across repeated calls", async () => {
    await writeAgent("repo", "done", { manager: "mgr", state: "complete" });
    await writeAgent("repo", "busy", { manager: "mgr", state: "running" });
    await writeAgent("repo", "unknown", { manager: "mgr", state: "unknown" });
    await writeAgent("repo", "missing", { manager: "mgr" });
    await writeAgent("repo", "grandchild", { manager: "child", state: "waiting" });
    await writeAgent("repo", "unrelated", { manager: "other-mgr", state: "waiting" });
    await writeAgent("other", "foreign", { manager: "mgr", state: "waiting" });
    const archiveDir = join(root, "repo", ".ittybitty", "archive", "retired");
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(archiveDir, "meta.json"), JSON.stringify({ id: "retired", manager: "mgr", state: "complete" }));

    const opts = { _cwd: sessionOf("repo", "mgr") };
    const first = await ackAllSubagents(opts);
    expect(first.ok).toBe(true);
    expect(first.stdout).toContain("Acknowledged child (waiting)");
    expect(first.stdout).toContain("Acknowledged done (complete)");
    expect(first.stdout).toContain("Skipped 3");
    const child = await readMeta("repo", "child");
    const done = await readMeta("repo", "done");
    expect(child.ack).toMatchObject({ by: "mgr", state: "waiting" });
    expect(done.ack).toMatchObject({ by: "mgr", state: "complete" });
    for (const id of ["mgr", "busy", "unknown", "missing", "grandchild", "unrelated"]) {
      expect((await readMeta("repo", id)).ack).toBeUndefined();
    }
    expect((await readMeta("other", "foreign")).ack).toBeUndefined();
    expect(JSON.parse(await readFile(join(archiveDir, "meta.json"), "utf-8")).ack).toBeUndefined();

    const again = await ackAllSubagents(opts);
    expect(again.ok).toBe(true);
    expect(again.stdout).toContain("child is already acknowledged");
    expect(again.stdout).toContain("done is already acknowledged");
    expect(await readMeta("repo", "child")).toEqual(child);
    expect(await readMeta("repo", "done")).toEqual(done);
  });

  test("no children succeeds without changing another manager's children", async () => {
    await writeAgent("repo", "child", { manager: "someone-else", state: "waiting" });
    const result = await ackAllSubagents({ _cwd: sessionOf("repo", "mgr") });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("No direct sub-agents to acknowledge.");
    expect((await readMeta("repo", "child")).ack).toBeUndefined();
  });

  test("human and unverifiable callers are refused", async () => {
    const human = await ackAllSubagents({ _cwd: join(root, "repo") });
    expect(human.ok).toBe(false);
    expect(human.stderr).toContain("manager's own agent session");
    setNewAgentNoWorktreeCallerResolver(async () => { throw new Error("ambiguous agent records"); });
    const unverified = await ackAllSubagents({ _cwd: sessionOf("repo", "mgr") });
    expect(unverified.ok).toBe(false);
    expect(unverified.stderr).toContain("cannot verify the caller");
    expect((await readMeta("repo", "child")).ack).toBeUndefined();
  });

  test("a read failure is reported while successful acknowledgements are kept", async () => {
    const brokenDir = await writeAgent("repo", "broken", { manager: "mgr", state: "waiting" });
    await writeFile(join(brokenDir, "meta.json"), "{broken JSON");
    // Newly created records are omitted as possible in-progress spawns.
    await utimes(brokenDir, new Date(0), new Date(0));
    let resolutions = 0;
    setNewAgentNoWorktreeCallerResolver(async () => {
      resolutions++;
      return null;
    });
    const result = await ackAllSubagents({ _cwd: sessionOf("repo", "mgr") });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("broken");
    expect(result.stdout).toContain("Acknowledged child (waiting)");
    expect((await readMeta("repo", "child")).ack).toMatchObject({ by: "mgr", state: "waiting" });
    expect(resolutions).toBe(1);
  });

  test("a child starting a new turn during a batch is skipped successfully", async () => {
    const childDir = join(root, "repo", ".ittybitty", "agents", "child");
    for (let i = 0; i < 10; i++) {
      await writeAgent("repo", "child", { manager: "mgr", state: "waiting" });
      const [result] = await Promise.all([
        ackAllSubagents({ _cwd: sessionOf("repo", "mgr") }),
        writeAgentState(childDir, "running"),
      ]);
      expect(result.ok).toBe(true);
      expect(result.stderr).toBe("");
      expect((await readMeta("repo", "child")).state).toBe("running");
      expect(await readAgentAck(childDir)).toBeNull();
    }
  });

  test("the CLI dispatches bare ack from a manager session", async () => {
    // Inject the resolver override in the subprocess too, so process ancestry
    // can never select a real registered worktree:false agent for this test.
    const script = join(root, "cli.ts");
    await Bun.write(script,
      `import { setNewAgentNoWorktreeCallerResolver } from ${JSON.stringify(join(import.meta.dir, "ib-commands.ts"))};\n` +
      `import { main } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};\n` +
      "setNewAgentNoWorktreeCallerResolver(async () => null);\nawait main();\n");
    const proc = Bun.spawn({
      cmd: [process.execPath, script, "ack"],
      cwd: sessionOf("repo", "mgr"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Acknowledged child (waiting)");
    expect((await readMeta("repo", "child")).ack).toMatchObject({ by: "mgr", state: "waiting" });
  });
});

describe("ackAgent — owner gate", () => {
  test("the child's manager acknowledges its waiting state; nothing else in meta.json changes", async () => {
    const before = await readMeta("repo", "child");
    const result = await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("repo", "mgr") });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Acknowledged child (waiting)");
    const after = await readMeta("repo", "child");
    const { ack, ...rest } = after;
    expect(rest).toEqual(before); // state, state_updated_at, session: untouched
    expect(ack).toEqual({ state: "waiting", by: "mgr", at: expect.any(Number) });
    const log = await readFile(join(root, "repo", ".ittybitty", "agents", "child", "agent.log"), "utf-8");
    expect(log).toContain("[ack] mgr acknowledged the waiting state");
  });

  test("a complete child can be acknowledged", async () => {
    await writeAgent("repo", "child", { manager: "mgr", state: "complete" });
    const result = await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("repo", "mgr") });
    expect(result.ok).toBe(true);
    expect((await readMeta("repo", "child")).ack).toMatchObject({ state: "complete", by: "mgr" });
  });

  test("refused for a sibling, a spawner that is not the manager, and a human shell", async () => {
    await writeAgent("repo", "sib", { manager: "mgr", state: "running" });
    await writeAgent("repo", "spawner", { manager: null, state: "running" });
    await writeAgent("repo", "child", {
      manager: "mgr",
      state: "waiting",
      spawned_by: { agent_id: "spawner", repo_path: join(root, "repo") },
    });
    const before = await readMeta("repo", "child");

    for (const cwd of [sessionOf("repo", "sib"), sessionOf("repo", "spawner"), join(root, "repo")]) {
      const result = await ackAgent(await agentFor("repo", "child"), { _cwd: cwd });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("only child's manager (mgr) can acknowledge it");
    }
    expect(await readMeta("repo", "child")).toEqual(before);
  });

  test("refused for an agent with the manager's id in another repo", async () => {
    await writeAgent("other", "mgr", { manager: null, state: "running" });
    const result = await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("other", "mgr") });
    expect(result.ok).toBe(false);
    expect((await readMeta("repo", "child")).ack).toBeUndefined();
  });

  test("refused when the child was reassigned after it was listed (checked under the meta lock)", async () => {
    const listed = await agentFor("repo", "child"); // snapshot says manager: mgr
    await writeAgent("repo", "child", { manager: "someone-else", state: "waiting" });
    const result = await ackAgent(listed, { _cwd: sessionOf("repo", "mgr") });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("no longer managed by mgr");
    expect((await readMeta("repo", "child")).ack).toBeUndefined();
  });

  test("refused for a child with no manager", async () => {
    await writeAgent("repo", "child", { manager: null, state: "waiting" });
    const result = await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("repo", "mgr") });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("has no manager");
  });

  test("an unverifiable caller is refused (fail closed)", async () => {
    setNewAgentNoWorktreeCallerResolver(async () => { throw new Error("ambiguous agent records"); });
    const result = await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("repo", "mgr") });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("cannot verify the caller of 'ib ack': ambiguous agent records");
    expect((await readMeta("repo", "child")).ack).toBeUndefined();
  });
});

describe("ackAgent — state gate and idempotence", () => {
  test("only waiting or complete can be acknowledged (no running / unknown / missing state)", async () => {
    for (const state of ["running", "unknown", undefined]) {
      await writeAgent("repo", "child", { manager: "mgr", ...(state ? { state } : {}) });
      const result = await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("repo", "mgr") });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("only acknowledges a sub-agent that is waiting or complete");
      expect((await readMeta("repo", "child")).ack).toBeUndefined();
    }
  });

  test("acknowledging the same episode again changes nothing", async () => {
    const child = await agentFor("repo", "child");
    await ackAgent(child, { _cwd: sessionOf("repo", "mgr") });
    const first = await readFile(join(root, "repo", ".ittybitty", "agents", "child", "meta.json"), "utf-8");

    const again = await ackAgent(child, { _cwd: sessionOf("repo", "mgr") });
    expect(again.ok).toBe(true);
    expect(again.stdout).toBe("child is already acknowledged (waiting); nothing changed");
    expect(await readFile(join(root, "repo", ".ittybitty", "agents", "child", "meta.json"), "utf-8")).toBe(first);
  });
});

describe("ack persistence and invalidation", () => {
  const childDir = () => join(root, "repo", ".ittybitty", "agents", "child");

  test("the ack is on disk: a fresh reader (e.g. a restarted watchdog) sees it", async () => {
    await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("repo", "mgr") });
    expect(await readAgentAck(childDir())).toMatchObject({ state: "waiting", by: "mgr" });
  });

  test("rewriting the same state keeps the ack; any state change drops it", async () => {
    await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("repo", "mgr") });
    await writeAgentState(childDir(), "waiting");
    expect(await readAgentAck(childDir())).not.toBeNull();
    await writeAgentState(childDir(), "complete");
    expect(await readAgentAck(childDir())).toBeNull();
    expect((await readMeta("repo", "child")).ack).toBeUndefined();
  });

  test("a waiting → running → waiting flip between two polls does not inherit the old ack", async () => {
    await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("repo", "mgr") });
    await writeAgentState(childDir(), "running");
    await writeAgentState(childDir(), "waiting");
    expect(await readAgentAck(childDir())).toBeNull();
    // The new episode can be acknowledged again.
    const again = await ackAgent(await agentFor("repo", "child"), { _cwd: sessionOf("repo", "mgr") });
    expect(again.stdout).toContain("Acknowledged child (waiting)");
  });

  test("an ack racing a state change never survives it", async () => {
    for (let i = 0; i < 10; i++) {
      await writeAgent("repo", "child", { manager: "mgr", state: "waiting" });
      const child = await agentFor("repo", "child");
      await Promise.all([
        ackAgent(child, { _cwd: sessionOf("repo", "mgr") }),
        writeAgentState(childDir(), "running"),
      ]);
      const meta = await readMeta("repo", "child");
      expect(meta.state).toBe("running");
      expect(meta.ack).toBeUndefined();
    }
  });

  test("currentAck needs the stored state and the current manager to match", () => {
    const ack = { state: "waiting", by: "mgr", at: 5 };
    expect(currentAck({ state: "waiting", manager: "mgr", ack })).toEqual({ state: "waiting", by: "mgr", at: 5 });
    expect(currentAck({ state: "complete", manager: "mgr", ack })).toBeNull();
    expect(currentAck({ state: "waiting", manager: "new-mgr", ack })).toBeNull(); // reassigned
    expect(currentAck({ state: "running", manager: "mgr", ack: { ...ack, state: "running" } })).toBeNull();
    expect(currentAck({ state: "waiting", manager: "mgr", ack: "yes" })).toBeNull();
    expect(currentAck({ state: "waiting", manager: "mgr" })).toBeNull();
  });
});

describe("LIVE: ib ack inside a manager's kernel sandbox", () => {
  // Opt-in: it compiles the `ib` binary and runs it under sandbox-exec.
  //   IB_LIVE_ACK=1 bun test src/ib-ack.test.ts --test-name-pattern LIVE
  test("the compiled ib resolves caller and child and writes the ack itself: no broker, no repo root", async () => {
    if (process.env.IB_LIVE_ACK !== "1") {
      console.log("LIVE ib ack: SKIPPED (set IB_LIVE_ACK=1 to run it)");
      return;
    }
    const sandboxExec = Bun.which("sandbox-exec");
    if (process.platform !== "darwin" || !sandboxExec) {
      console.log("LIVE ib ack: SKIPPED (sandbox-exec is absent; macOS only)");
      return;
    }
    const capability = Bun.spawnSync({ cmd: [sandboxExec, "-p", "(version 1)(allow default)", "/usr/bin/true"], stderr: "pipe" });
    if (capability.exitCode !== 0) {
      console.log(`LIVE ib ack: SKIPPED (cannot apply a profile here: ${capability.stderr.toString().trim()})`);
      return;
    }

    // The repo lives under the real home, outside every floor root, like a
    // real ~/Developer checkout: the profile grants only the runtime roots.
    const repoBase = canonicalizeSandboxPath(await mkdtemp(join(homedir(), "itsybitsy-ack-live-")));
    const scratch = canonicalizeSandboxPath(await mkdtemp(join(tmpdir(), "itsybitsy-ack-live-")));
    try {
      const repo = join(repoBase, "repo");
      const agentsDir = join(repo, ".ittybitty", "agents");
      const mgrDir = join(agentsDir, "mgr");
      const childDir = join(agentsDir, "child");
      for (const dir of [join(repo, ".git"), join(repo, ".claude"), join(repo, ".ittybitty", "archive"), join(mgrDir, "repo"), join(childDir, "repo")]) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(join(repo, ".ittybitty", "repo-id"), "abcd1234\n");
      await writeFile(join(mgrDir, "meta.json"), JSON.stringify({ id: "mgr", manager: null, state: "running", worktree: true, tmux_session: "ittybitty-abcd1234-mgr" }));
      await writeFile(join(childDir, "meta.json"), JSON.stringify({ id: "child", manager: "mgr", state: "waiting", state_updated_at: 1234, worktree: true, tmux_session: "ittybitty-abcd1234-child" }));

      // `ib`'s registry ($HOME/.itsybitsy/repos.json) lists the repo. The
      // profile's HOME stays the real home, as in production, so the caller
      // resolver's registry read (OS-account home) behaves as it does there.
      const ibHome = join(scratch, "home");
      await mkdir(join(ibHome, ".itsybitsy"), { recursive: true });
      await writeFile(join(ibHome, ".itsybitsy", "repos.json"), JSON.stringify({ repos: [{ path: repo, name: "repo" }] }));

      const ib = join(scratch, "ib");
      const build = Bun.spawnSync({
        cmd: [process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", join(import.meta.dir, "..", "index.ts"), "--outfile", ib],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (build.exitCode !== 0) throw new Error(`LIVE ib ack: build failed: ${build.stderr.toString()}`);

      // The manager's profile, built from the same inputs prepareSandbox uses.
      const floor = parseAgentTypeFile(await Bun.file(join(import.meta.dir, "../docs/agent-types/_all.md")).text()).frontmatter;
      const paths = canonicalizePathsConfig(anchorRelativePaths(resolvePathsConfig(floor.paths as PathsConfig), repo), homedir());
      const config = resolveSandboxConfig({ sandbox: floor.sandbox as SandboxConfig });
      const params: SandboxProfileParams = {
        AGENTDIR: mgrDir,
        WORKTREE: join(mgrDir, "repo"),
        GITDIR: join(repo, ".git"),
        REPOAGENTS: agentsDir,
        PARENTCLAUDE: join(repo, ".claude"),
        REPOID: join(repo, ".ittybitty", "repo-id"),
        TMUXSOCK: resolveTmuxSocketDir(process.getuid?.() ?? 0),
        canSpawnChildren: true,
        HOME: homedir(),
      };
      const runner = async (profileParams: SandboxProfileParams) => {
        const profilePath = join(scratch, `mgr-${profileParams.canSpawnChildren}.sb`);
        await writeFile(profilePath, generateProfile(config, paths, profileParams));
        const defArgs = Object.entries(sandboxProfileParameterValues(paths, profileParams)).flatMap(([k, v]) => ["-D", `${k}=${v}`]);
        return (cmd: string[]) => {
          const out = Bun.spawnSync({
            cmd: [sandboxExec, "-f", profilePath, ...defArgs, ...cmd],
            cwd: join(mgrDir, "repo"),
            env: { ...process.env, HOME: ibHome },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 30_000,
          });
          return { exitCode: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
        };
      };
      const run = await runner(params);

      // The profile really hides what the lifecycle broker exists for.
      expect(run(["/bin/ls", repo]).exitCode).not.toBe(0);
      expect(run(["/bin/ls", join(repo, ".ittybitty", "archive")]).exitCode).not.toBe(0);

      // Control: the same caller under a non-spawner profile (agents dir
      // read-only) resolves everything but the kernel refuses the write. So
      // the pass below rests on the spawner's REPOAGENTS write grant, and a
      // denied write fails closed.
      const readOnly = await runner({ ...params, canSpawnChildren: false });
      const denied = readOnly([ib, "ack", "child"]);
      expect(denied.exitCode).toBe(1);
      expect(denied.stderr).toContain("could not update meta.json for 'child'");
      expect(JSON.parse(await readFile(join(childDir, "meta.json"), "utf-8")).ack).toBeUndefined();

      const acked = run([ib, "ack", "child"]);
      if (acked.exitCode !== 0) {
        throw new Error(`LIVE ib ack failed in the sandbox (exit ${acked.exitCode})\nstdout: ${acked.stdout}\nstderr: ${acked.stderr}`);
      }
      expect(acked.stdout).toContain("Acknowledged child (waiting)");
      const meta = JSON.parse(await readFile(join(childDir, "meta.json"), "utf-8"));
      expect(meta.ack).toMatchObject({ state: "waiting", by: "mgr" });
      expect(meta.state).toBe("waiting");
      expect(meta.state_updated_at).toBe(1234);
      // Nothing was queued for a watchdog.
      expect(await Bun.file(join(mgrDir, "spawn-requests")).exists()).toBe(false);

      const again = run([ib, "ack", "child"]);
      expect(again.stdout).toContain("already acknowledged");
      console.log(`LIVE ib ack: PASSED in the sandbox — ${acked.stdout.trim()} | ${again.stdout.trim()}`);
    } finally {
      await rm(repoBase, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});

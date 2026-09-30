import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { setUserHome, resetUserHome } from "../home";
import { hookCodexUserPromptSubmit, hookCodexUserPromptSubmitDryRun } from "./codex-user-prompt-submit";
import { runCodexDispatcher } from "./codex-dispatcher";
import { buildCodexLaunchArgs } from "../codex-config";
import { canonicalizeSandboxPath } from "../sandbox";
import { mutateAgentMeta } from "../agents";

describe("hookCodexUserPromptSubmit — a submitted prompt writes running", () => {
  let tempDir: string;
  let agentDir: string;
  let out: string[];
  const write = (chunk: string) => { out.push(chunk); return chunk.length; };
  const run = (meta: Record<string, unknown>, stdin = JSON.stringify({ prompt: "hi" })) =>
    writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-ups01", model: "codex:gpt-5.4", ...meta }))
      .then(() => hookCodexUserPromptSubmit("agent-ups01", { rawStdin: stdin, agentDirOverride: agentDir, write }));
  const readMeta = async () => JSON.parse(await readFile(join(agentDir, "meta.json"), "utf-8"));

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-ups-"));
    agentDir = join(tempDir, "agent-ups01");
    await mkdir(agentDir, { recursive: true });
    out = [];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("waiting → running, and the manager's ack for the waiting state is gone", async () => {
    await run({ manager: "agent-mgr01", state: "waiting", ack: { state: "waiting", by: "agent-mgr01", at: 1 } });
    const meta = await readMeta();
    expect(meta.state).toBe("running");
    expect(meta.ack).toBeUndefined();
    expect(out).toEqual(["{}"]);
  });

  test("complete → running (a human typing into a finished agent starts a new turn), ack gone", async () => {
    await run({ manager: "agent-mgr01", state: "complete", ack: { state: "complete", by: "agent-mgr01", at: 1 } });
    const meta = await readMeta();
    expect(meta.state).toBe("running");
    expect(meta.ack).toBeUndefined();
  });

  test("stopped is not written (a stale prompt must not revive a stopped record)", async () => {
    await run({ state: "stopped" });
    expect((await readMeta()).state).toBe("stopped");
    expect(out).toEqual(["{}"]);
  });

  test("malformed stdin still applies the rule and prints {}", async () => {
    await run({ state: "waiting" }, "not json");
    expect((await readMeta()).state).toBe("running");
    expect(out).toEqual(["{}"]);
  });

  test("an invalid agent id prints {} and writes nothing", async () => {
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-ups01", state: "waiting" }));
    await hookCodexUserPromptSubmit("bad id", { rawStdin: "{}", agentDirOverride: agentDir, write });
    expect(out).toEqual(["{}"]);
    expect((await readMeta()).state).toBe("waiting");
  });

  test("the dispatcher's failure payload for this event is {} (never plain text or empty)", async () => {
    const captured: string[] = [];
    const result = await runCodexDispatcher("user-prompt-submit", undefined, {
      deps: { write: (chunk) => { captured.push(chunk); return chunk.length; } },
    });
    expect(result.exitCode).toBe(0);
    expect(captured).toEqual(["{}"]);

    const failed = await runCodexDispatcher("user-prompt-submit", "agent-ups01", {
      deps: {
        write: (chunk) => { captured.push(chunk); return chunk.length; },
        invokeHandler: async () => { throw new Error("load failed"); },
      },
    });
    expect(failed.exitCode).toBe(0);
    expect(captured[1]).toBe("{}");
  });
});

describe("hookCodexUserPromptSubmitDryRun", () => {
  let tempHome: string;
  let agentDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codex-ups-dryrun-"));
    setUserHome(tempHome);
    agentDir = join(tempHome, ".ittybitty", "agents", "agent-dryrun01");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "agent-dryrun01", worktree: true, model: "codex:gpt-5.4", state: "waiting" }),
    );
  });

  afterEach(async () => {
    resetUserHome();
    await rm(tempHome, { recursive: true, force: true });
  });

  test("succeeds and does not change meta.json", async () => {
    const before = await Bun.file(join(agentDir, "meta.json")).text();
    const origCwd = process.cwd();
    process.chdir(join(agentDir, "repo"));
    try {
      await hookCodexUserPromptSubmitDryRun("agent-dryrun01");
    } finally {
      process.chdir(origCwd);
    }
    expect(await Bun.file(join(agentDir, "meta.json")).text()).toBe(before);
  });

  test("throws when meta.json is missing or the id is invalid", async () => {
    const origCwd = process.cwd();
    process.chdir(tempHome);
    try {
      await expect(hookCodexUserPromptSubmitDryRun("agent-missing")).rejects.toThrow(/meta\.json not found/);
    } finally {
      process.chdir(origCwd);
    }
    await expect(hookCodexUserPromptSubmitDryRun("bad agent id")).rejects.toThrow(/Invalid agent id/);
  });
});

describe("LIVE: codex UserPromptSubmit on the installed codex", () => {
  // Opt-in: launches a real interactive codex (real model turns) in its own
  // tmux session against a temp fixture and a temp `ib` build. Nothing else is
  // touched: the hook commands point at the temp build, not the installed ib.
  //   IB_LIVE_CODEX=1 bun test src/hooks/codex-user-prompt-submit.test.ts --test-name-pattern LIVE
  // IB_LIVE_CODEX=preflight checks the hook wrappers against the temp build
  // and fixture, then stops before launching codex.
  test("fires for the initial, typed, and queued prompts; writes running; drops the ack; no JSON errors", async () => {
    const mode = process.env.IB_LIVE_CODEX;
    if (mode !== "1" && mode !== "preflight") {
      console.log("LIVE codex UserPromptSubmit: SKIPPED (set IB_LIVE_CODEX=1 to run it)");
      return;
    }

    const root = canonicalizeSandboxPath(await mkdtemp(join(tmpdir(), "ib-live-codex-ups-")));
    const session = `ib-live-codex-ups-${process.pid}`;
    const agentId = "agent-livecodex1";
    const repo = join(root, "repo");
    const agentDir = join(repo, ".ittybitty", "agents", agentId);
    const worktree = join(agentDir, "repo");
    const metaPath = join(agentDir, "meta.json");
    // One ordered log for BOTH hooks. Each wrapper appends its line after its
    // handler has finished, with the stored state (and "+ack" when an ack is
    // present) read before and after the handler.
    const eventsLog = join(root, "events.log");
    const payloadLog = join(root, "payloads.log");
    let tmux = "";
    const sh = (cmd: string[], cwd?: string) => {
      const out = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
      return { exitCode: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
    };
    const pane = () => tmux ? sh([tmux, "capture-pane", "-p", "-J", "-t", session, "-S", "-200"]).stdout : "(no pane)";
    const meta = async () => JSON.parse(await readFile(metaPath, "utf-8"));
    type HookEvent = { kind: string; before: string; after: string };
    const events = async (): Promise<HookEvent[]> => {
      if (!(await Bun.file(eventsLog).exists())) return [];
      return (await Bun.file(eventsLog).text()).split("\n").filter(Boolean).map((line) => {
        const m = line.match(/^(\w+) before=(\S+) after=(\S+)$/);
        return { kind: m?.[1] ?? line, before: m?.[2] ?? "?", after: m?.[3] ?? "?" };
      });
    };
    const eventText = async () => (await Bun.file(eventsLog).exists()) ? await Bun.file(eventsLog).text() : "(no events)";
    const fail = async (message: string): Promise<never> => {
      throw new Error(
        `LIVE codex UserPromptSubmit: ${message}\nmeta: ${JSON.stringify(await meta())}\n` +
        `--- events.log ---\n${await eventText()}\n--- pane ---\n${pane()}`,
      );
    };
    const waitFor = async (label: string, check: () => Promise<boolean>, timeoutMs = 120_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await check()) return;
        await Bun.sleep(100);
      }
      await fail(`timed out waiting for ${label}`);
    };
    /** One prompt: exactly one ups line (after=running) then one stop line (after=waiting). */
    const expectTurn = async (label: string, from: number, upsBefore: string[]) => {
      await waitFor(`${label}: ups then stop`, async () => (await events()).length >= from + 2);
      const [ups, stop] = (await events()).slice(from, from + 2);
      if (ups!.kind !== "ups" || !upsBefore.includes(ups!.before) || ups!.after !== "running" ||
          stop!.kind !== "stop" || stop!.after !== "waiting") {
        await fail(`${label}: expected "ups before=${upsBefore.join("|")} after=running" then "stop ... after=waiting"`);
      }
    };
    const type = (text: string, key: "Enter" | "Tab") => {
      sh([tmux, "send-keys", "-t", session, "-l", text]);
      Bun.spawnSync({ cmd: ["sleep", "0.5"] });
      sh([tmux, "send-keys", "-t", session, key]);
    };
    const setState = (state: string, withAck: boolean) => mutateAgentMeta(agentDir, (m) => {
      m.state = state;
      if (withAck) m.ack = { state, by: "agent-livemgr1", at: 1 };
    });

    try {
      await mkdir(worktree, { recursive: true });
      sh(["git", "init", "-q"], worktree);
      const fixtureMeta = JSON.stringify({
        id: agentId, worktree: true, manager: "agent-livemgr1", model: "codex:default", state: "waiting",
      });
      await writeFile(metaPath, fixtureMeta);

      // A temp build: the hooks must run THIS code, not the installed ib.
      const ib = join(root, "ib");
      const build = sh([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", join(import.meta.dir, "..", "..", "index.ts"), "--outfile", ib]);
      if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr}`);

      // Wrap both state hooks. The handler's stdout stays the wrapper's only
      // stdout; the state is read by parsing meta.json (the ack object has its
      // own "state" key, so no text matching).
      const readState =
        `"${process.execPath}" -e 'try{const m=JSON.parse(require("fs").readFileSync("${metaPath}","utf8"));` +
        `console.log((m.state??"none")+(m.ack?"+ack":""))}catch{console.log("?")}'`;
      const makeWrapper = async (kind: "ups" | "stop", subcommand: string): Promise<string> => {
        const path = join(root, `${kind}-wrapper.sh`);
        await writeFile(path, [
          "#!/bin/sh",
          `st() { ${readState}; }`,
          "before=$(st)",
          `echo "--- ${kind}" >> "${payloadLog}"`,
          `out=$(tee -a "${payloadLog}" | "${ib}" hooks ${subcommand} "$1")`,
          "after=$(st)",
          `echo "${kind} before=$before after=$after" >> "${eventsLog}"`,
          `printf '%s' "$out"`,
          "",
        ].join("\n"));
        await chmod(path, 0o755);
        return path;
      };
      const upsWrapper = await makeWrapper("ups", "codex-user-prompt-submit");
      const stopWrapper = await makeWrapper("stop", "codex-stop");

      // Preflight the wrappers against the fixture (no codex): each must print
      // exactly the handler's JSON and log one ordered line. Then reset.
      const runWrapper = (wrapper: string, payload: string) => {
        const out = Bun.spawnSync({ cmd: ["/bin/sh", wrapper, agentId], cwd: worktree, stdin: Buffer.from(payload), stdout: "pipe", stderr: "pipe" });
        return out.stdout.toString();
      };
      await mutateAgentMeta(agentDir, (m) => { m.ack = { state: "waiting", by: "agent-livemgr1", at: 1 }; });
      expect(runWrapper(upsWrapper, JSON.stringify({ cwd: worktree, prompt: "preflight" }))).toBe("{}");
      expect(runWrapper(stopWrapper, JSON.stringify({ cwd: worktree, last_assistant_message: "WAITING" }))).toBe("{}");
      expect(await events()).toEqual([
        { kind: "ups", before: "waiting+ack", after: "running" },
        { kind: "stop", before: "running", after: "waiting" },
      ]);
      await writeFile(metaPath, fixtureMeta);
      await rm(eventsLog, { force: true });
      await rm(payloadLog, { force: true });
      if (mode === "preflight") {
        console.log("LIVE codex UserPromptSubmit: PREFLIGHT PASSED (wrappers log ordered, JSON-parsed state; codex not launched)");
        return;
      }

      const codex = Bun.which("codex");
      tmux = Bun.which("tmux") ?? "";
      if (!codex || !tmux) {
        console.log("LIVE codex UserPromptSubmit: SKIPPED (codex or tmux is not on PATH)");
        return;
      }

      const { args } = buildCodexLaunchArgs({
        ibBinaryPath: ib,
        agentId,
        agentDir,
        extraWritableRoots: [join(repo, ".ittybitty")],
      });
      const launch = args.map((arg) => arg
        .replace(`${ib} hooks codex-user-prompt-submit ${agentId}`, `${upsWrapper} ${agentId}`)
        .replace(`${ib} hooks codex-stop ${agentId}`, `${stopWrapper} ${agentId}`));
      expect(launch.filter((arg) => arg.includes(upsWrapper) || arg.includes(stopWrapper)).length).toBe(2);

      const started = sh([
        tmux, "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", worktree,
        codex, "-a", "never", "-s", "workspace-write", "--dangerously-bypass-hook-trust", ...launch,
        "Reply with exactly the single word WAITING and nothing else.",
      ]);
      if (started.exitCode !== 0) throw new Error(`tmux new-session failed: ${started.stderr}`);

      // (e) The initial prompt fires the hook; its turn ends in Stop → waiting.
      // (e) The initial prompt: SessionStart wrote running just before.
      await expectTurn("initial prompt", 0, ["running", "waiting"]);

      // (a/b) A typed prompt — `ib send` delivers with the same send-keys -l +
      // Enter — on an acknowledged waiting agent: running, and the ack is gone.
      await setState("waiting", true);
      let from = (await events()).length;
      type("Reply with exactly the single word WAITING and nothing else.", "Enter");
      await expectTurn("typed prompt on an acked waiting agent", from, ["waiting+ack"]);

      // An acknowledged COMPLETE agent a human types into: running, ack gone.
      await setState("complete", true);
      from = (await events()).length;
      type("Reply with exactly the single word WAITING and nothing else.", "Enter");
      await expectTurn("typed prompt on an acked complete agent", from, ["complete+ack"]);

      // (c) A message queued with Tab while a long turn runs. The queued
      // prompt's ups must come AFTER the long turn's stop, with before=waiting:
      // it started its own turn and did the turn-start write (which also drops
      // any ack written after the long Stop).
      from = (await events()).length;
      type("Write the numbers from 1 to 150, one per line, then a last line with exactly WAITING.", "Enter");
      await waitFor("the long prompt's ups", async () => (await events()).length >= from + 1);
      await Bun.sleep(1_000);
      type("Reply with exactly the single word WAITING and nothing else.", "Tab");
      if ((await events()).slice(from).some((e) => e.kind === "stop")) {
        await fail("inconclusive — the long turn ended before the message could be queued");
      }
      await waitFor("the long and the queued turns to end", async () => {
        const after = (await events()).slice(from);
        return after.length >= 4 || after.filter((e) => e.kind === "stop").length >= 2;
      }, 240_000);
      const turns = (await events()).slice(from, from + 4);
      const order = turns.map((e) => e.kind).join(",");
      if (order === "ups,ups,stop,stop") {
        await fail("UserPromptSubmit fired at queue time; the queued turn has no turn-start write");
      }
      if (order === "ups,stop,stop") {
        await fail("the queued turn did not fire UserPromptSubmit at all");
      }
      if (order !== "ups,stop,ups,stop" || turns.some((e) => e.kind === "ups" && e.after !== "running") ||
          turns[2]!.before !== "waiting") {
        await fail(`queued prompt: expected ups,stop,ups(before=waiting after=running),stop; got ${order}`);
      }

      // (d) No hook failure or invalid-JSON report anywhere in the pane.
      const text = pane();
      expect(text).not.toMatch(/invalid user prompt submit JSON output/i);
      expect(text).not.toMatch(/UserPromptSubmit hook \(failed\)/i);
      console.log(
        `LIVE codex UserPromptSubmit: PASSED\n--- events.log ---\n${await eventText()}` +
        `--- payloads ---\n${await Bun.file(payloadLog).text()}`,
      );
    } finally {
      if (tmux) sh([tmux, "kill-session", "-t", session]);
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});

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
  test("fires for the initial, typed, and queued prompts; writes running; drops the ack; no JSON errors", async () => {
    if (process.env.IB_LIVE_CODEX !== "1") {
      console.log("LIVE codex UserPromptSubmit: SKIPPED (set IB_LIVE_CODEX=1 to run it)");
      return;
    }
    const codex = Bun.which("codex");
    const tmux = Bun.which("tmux");
    if (!codex || !tmux) {
      console.log("LIVE codex UserPromptSubmit: SKIPPED (codex or tmux is not on PATH)");
      return;
    }

    const root = canonicalizeSandboxPath(await mkdtemp(join(tmpdir(), "ib-live-codex-ups-")));
    const session = `ib-live-codex-ups-${process.pid}`;
    const agentId = "agent-livecodex1";
    const repo = join(root, "repo");
    const agentDir = join(repo, ".ittybitty", "agents", agentId);
    const worktree = join(agentDir, "repo");
    const firedLog = join(root, "ups-fired.log");
    const payloadLog = join(root, "ups-payloads.log");
    const sh = (cmd: string[], cwd?: string) => {
      const out = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
      return { exitCode: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
    };
    const pane = () => sh([tmux, "capture-pane", "-p", "-J", "-t", session, "-S", "-200"]).stdout;
    const meta = async () => JSON.parse(await readFile(join(agentDir, "meta.json"), "utf-8"));
    const fired = async () => (await Bun.file(firedLog).exists()) ? (await Bun.file(firedLog).text()).split("\n").filter(Boolean).length : 0;
    const waitFor = async (label: string, check: () => Promise<boolean>, timeoutMs = 120_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await check()) return;
        await Bun.sleep(100);
      }
      throw new Error(
        `LIVE codex UserPromptSubmit: timed out waiting for ${label}\n` +
        `meta: ${JSON.stringify(await meta())}\nhook firings: ${await fired()}\n--- pane ---\n${pane()}`,
      );
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
      await writeFile(join(agentDir, "meta.json"), JSON.stringify({
        id: agentId, worktree: true, manager: "agent-livemgr1", model: "codex:default", state: "waiting",
      }));

      // A temp build: the hooks must run THIS code, not the installed ib.
      const ib = join(root, "ib");
      const build = sh([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", join(import.meta.dir, "..", "..", "index.ts"), "--outfile", ib]);
      if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr}`);
      // The UserPromptSubmit command is wrapped to record each firing (and its
      // payload) before running the real handler; its stdout is the handler's.
      const wrapper = join(root, "ups-wrapper.sh");
      await writeFile(
        wrapper,
        `#!/bin/sh\necho fired >> ${firedLog}\ntee -a ${payloadLog} | ${ib} hooks codex-user-prompt-submit "$1"\n`,
      );
      await chmod(wrapper, 0o755);

      const { args } = buildCodexLaunchArgs({
        ibBinaryPath: ib,
        agentId,
        agentDir,
        extraWritableRoots: [join(repo, ".ittybitty")],
      });
      const launch = args.map((arg) => arg.startsWith("hooks.UserPromptSubmit=")
        ? arg.replace(`${ib} hooks codex-user-prompt-submit ${agentId}`, `${wrapper} ${agentId}`)
        : arg);
      expect(launch.some((arg) => arg.includes(wrapper))).toBe(true);

      const started = sh([
        tmux, "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", worktree,
        codex, "-a", "never", "-s", "workspace-write", "--dangerously-bypass-hook-trust", ...launch,
        "Reply with exactly the single word WAITING and nothing else.",
      ]);
      if (started.exitCode !== 0) throw new Error(`tmux new-session failed: ${started.stderr}`);

      // (e) The initial prompt fires the hook; its turn ends in Stop → waiting.
      await waitFor("the initial prompt to fire the hook", async () => (await fired()) >= 1);
      await waitFor("the initial turn to end (Stop → waiting)", async () => (await meta()).state === "waiting");

      // (a/b) A typed prompt — `ib send` delivers with the same send-keys -l +
      // Enter — on an acknowledged waiting agent: running, ack gone.
      await setState("waiting", true);
      let before = await fired();
      type("Reply with exactly the single word WAITING and nothing else.", "Enter");
      await waitFor("the typed prompt to fire the hook", async () => (await fired()) > before);
      await waitFor("running with the ack gone", async () => {
        const m = await meta();
        return m.ack === undefined && (m.state === "running" || m.state === "waiting");
      });
      await waitFor("the typed turn to end", async () => (await meta()).state === "waiting");

      // An acknowledged COMPLETE agent a human types into: running, ack gone.
      await setState("complete", true);
      before = await fired();
      type("Reply with exactly the single word WAITING and nothing else.", "Enter");
      await waitFor("the prompt on a complete agent to fire the hook", async () => (await fired()) > before);
      await waitFor("complete → running/waiting with the ack gone", async () => {
        const m = await meta();
        return m.ack === undefined && m.state !== "complete";
      });
      await waitFor("that turn to end", async () => (await meta()).state === "waiting");

      // (c) A message queued with Tab while a long turn runs.
      before = await fired();
      type("Write the numbers from 1 to 150, one per line, then a last line with exactly WAITING.", "Enter");
      await waitFor("the long turn to fire the hook", async () => (await fired()) === before + 1);
      await Bun.sleep(1_000);
      type("Reply with exactly the single word WAITING and nothing else.", "Tab");
      if ((await meta()).state !== "running" || (await fired()) !== before + 1) {
        throw new Error(
          "LIVE codex UserPromptSubmit: inconclusive — the long turn ended (or the Tab message ran at once) " +
          `before a message could be queued\n--- pane ---\n${pane()}`,
        );
      }
      await waitFor("the queued prompt to fire the hook (2 firings)", async () => (await fired()) >= before + 2, 180_000);
      await waitFor("the queued turn to end", async () => (await meta()).state === "waiting", 180_000);

      // (d) No hook failure or invalid-JSON report anywhere in the pane.
      const text = pane();
      expect(text).not.toMatch(/invalid user prompt submit JSON output/i);
      expect(text).not.toMatch(/UserPromptSubmit hook \(failed\)/i);
      console.log(
        `LIVE codex UserPromptSubmit: PASSED — ${await fired()} firings\n` +
        `payloads:\n${await Bun.file(payloadLog).text()}`,
      );
    } finally {
      sh([tmux, "kill-session", "-t", session]);
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});

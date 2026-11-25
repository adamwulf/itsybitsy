import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { existsSync, readFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import { resetWatchLogPath, setWatchLogPath } from "../watch-log";
import { describeFatalReason, installWatchCrashHandlers, type WatchCrashDeps } from "./watch-crash";

const SRC = resolve(import.meta.dir, "..");

function readLog(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** A named frame, so the test can find it in the recorded stack. */
function explodeForCrashTest(): never {
  throw new TypeError("attachment frame out of range");
}

function thrown(): Error {
  try {
    explodeForCrashTest();
  } catch (err) {
    return err as Error;
  }
}

describe("installWatchCrashHandlers", () => {
  let tmp: string;
  let logPath: string;
  let target: EventEmitter;
  let calls: string[];
  let deps: Partial<WatchCrashDeps>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "watch-crash-test-"));
    logPath = join(tmp, "watch.log");
    setWatchLogPath(logPath);
    target = new EventEmitter();
    calls = [];
    deps = {
      target,
      // The real logToWatchLog (the default): its appendFileSync is what makes the entry synchronous.
      exit: (code) => { calls.push(`exit:${code}`); },
      writeStderr: (text) => { calls.push(`stderr:${text}`); },
      pid: 4242,
      uptime: () => 12.34,
    };
  });

  afterEach(async () => {
    resetWatchLogPath();
    await rm(tmp, { recursive: true, force: true });
  });

  test("an uncaught exception writes one [crash] entry with the full stack before anything else, then restores the terminal and exits 1", () => {
    const handlers = installWatchCrashHandlers(deps);
    handlers.setRestoreTerminal(() => {
      // The record is already on disk when the teardown starts.
      calls.push(`restore (log had crash entry: ${readLog(logPath).includes("[crash]")})`);
    });
    const err = thrown();

    target.emit("uncaughtException", err);

    // No await between the emit and this read: the write was synchronous.
    const log = readLog(logPath);
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[crash\] ib watch died: uncaughtException \(pid 4242, uptime 12\.3s\)\n/);
    expect(log).toContain("    TypeError: attachment frame out of range\n");
    expect(log).toContain("explodeForCrashTest");
    // Every stack line is in the entry, indented under the header.
    for (const line of err.stack!.split("\n")) expect(log).toContain(`    ${line}`);
    expect(log.match(/\[crash\]/g)).toHaveLength(1);

    expect(calls[0]).toBe("restore (log had crash entry: true)");
    expect(calls[1]).toStartWith("stderr:ib watch crashed (uncaughtException); the error is also in ");
    expect(calls[1]).toContain("TypeError: attachment frame out of range");
    expect(calls[2]).toBe("exit:1");
    expect(calls).toHaveLength(3);
    handlers.uninstall();
  });

  test("an unhandled rejection with an Error is recorded the same way and exits 1", () => {
    const handlers = installWatchCrashHandlers(deps);
    const err = thrown();

    target.emit("unhandledRejection", err, Promise.resolve());

    const log = readLog(logPath);
    expect(log).toContain("[crash] ib watch died: unhandledRejection (pid 4242, uptime 12.3s)");
    expect(log).toContain("explodeForCrashTest");
    expect(calls.at(-1)).toBe("exit:1");
    handlers.uninstall();
  });

  test("a non-Error rejection is recorded in its inspect form", () => {
    const handlers = installWatchCrashHandlers(deps);

    target.emit("unhandledRejection", { code: "ECONNRESET", received: 6_291_456 }, Promise.resolve());

    const log = readLog(logPath);
    expect(log).toContain("[crash] ib watch died: unhandledRejection");
    expect(log).toContain("    non-Error value: {");
    expect(log).toContain("ECONNRESET");
    expect(log).toContain("6291456");
    expect(calls.at(-1)).toBe("exit:1");
    handlers.uninstall();
  });

  test("describeFatalReason covers strings, undefined and values that throw when printed", () => {
    expect(describeFatalReason("stream reset")).toBe("non-Error value: 'stream reset'");
    expect(describeFatalReason(undefined)).toBe("non-Error value: undefined");
    const hostile = new Proxy({}, { get() { throw new Error("no"); }, ownKeys() { throw new Error("no"); } });
    expect(() => describeFatalReason(hostile)).not.toThrow();
    const noStack = new RangeError("bad length");
    noStack.stack = undefined;
    expect(describeFatalReason(noStack)).toBe("[RangeError: bad length]");
    const replacedStack = new Error("lost head");
    replacedStack.stack = "some other text";
    expect(describeFatalReason(replacedStack)).toStartWith("Error: lost head\n");
  });

  test("an Error's code and cause are kept, in the log entry and on stderr", () => {
    const handlers = installWatchCrashHandlers(deps);
    const err = Object.assign(
      new Error("socket hang up", { cause: new TypeError("iroh stream closed by peer") }),
      { code: "ECONNRESET" },
    );

    target.emit("unhandledRejection", err, Promise.resolve());

    const log = readLog(logPath);
    expect(log).toContain("    Error: socket hang up\n");
    expect(log).toContain("code: 'ECONNRESET'");
    expect(log).toContain("[cause]: TypeError: iroh stream closed by peer");
    const stderr = calls.find((c) => c.startsWith("stderr:"))!;
    expect(stderr).toContain("code: 'ECONNRESET'");
    expect(stderr).toContain("[cause]: TypeError: iroh stream closed by peer");
    handlers.uninstall();
  });

  test("a teardown that throws still exits 1, with the entry written", () => {
    const handlers = installWatchCrashHandlers(deps);
    handlers.setRestoreTerminal(() => { throw new Error("tty gone"); });

    target.emit("uncaughtException", thrown());

    expect(readLog(logPath)).toContain("[crash] ib watch died: uncaughtException");
    expect(calls.at(-1)).toBe("exit:1");
    handlers.uninstall();
  });

  test("a second fatal error while the first is handled exits without a second entry", () => {
    const handlers = installWatchCrashHandlers(deps);
    target.emit("uncaughtException", thrown());
    target.emit("unhandledRejection", new Error("late"), Promise.resolve());

    expect(readLog(logPath).match(/\[crash\]/g)).toHaveLength(1);
    expect(calls.filter((c) => c === "exit:1")).toHaveLength(2);
    handlers.uninstall();
  });

  test("an orderly quit writes one [exit] line naming the quit", () => {
    const handlers = installWatchCrashHandlers(deps);
    handlers.noteQuit("Ctrl+C");

    target.emit("exit", 0);

    const lines = readLog(logPath).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Z \[exit\] ib watch exiting with code 0, quit via Ctrl\+C \(pid 4242, uptime 12\.3s\)$/);
    handlers.uninstall();
  });

  test("the [exit] line after a crash names the crash, even if a quit was under way", () => {
    const handlers = installWatchCrashHandlers(deps);
    handlers.noteQuit("ib bounce");
    target.emit("unhandledRejection", new Error("boom"), Promise.resolve());
    handlers.noteQuit("Ctrl+C");

    target.emit("exit", 1);

    expect(readLog(logPath)).toContain("[exit] ib watch exiting with code 1, crashed (unhandledRejection) (pid 4242, uptime 12.3s)");
    handlers.uninstall();
  });

  test("any other exit (a handled signal, a process.exit) writes a bare [exit] line", () => {
    const handlers = installWatchCrashHandlers(deps);

    target.emit("exit", 143);

    expect(readLog(logPath)).toMatch(/\[exit\] ib watch exiting with code 143 \(pid 4242, uptime 12\.3s\)\n$/);
    handlers.uninstall();
  });

  test("uninstall detaches every listener", () => {
    const handlers = installWatchCrashHandlers(deps);
    for (const event of ["uncaughtException", "unhandledRejection", "exit"]) expect(target.listenerCount(event)).toBe(1);
    handlers.uninstall();
    for (const event of ["uncaughtException", "unhandledRejection", "exit"]) expect(target.listenerCount(event)).toBe(0);
  });
});

// The handlers on the real `process`, in a child: the manual check from the
// task, kept as a test. Bun's own default is to print the error and exit 1
// with nothing in watch.log.
describe("installWatchCrashHandlers on a real process", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "watch-crash-proc-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function runCrashingChild(trigger: string): Promise<{ exitCode: number; stdout: string; stderr: string; log: string }> {
    const logPath = join(tmp, "watch.log");
    const script = `
      import { installWatchCrashHandlers } from ${JSON.stringify(join(import.meta.dir, "watch-crash.ts"))};
      const handlers = installWatchCrashHandlers();
      handlers.setRestoreTerminal(() => process.stdout.write("RESTORED\\n"));
      setTimeout(() => process.stdout.write("STILL RUNNING\\n"), 500);
      function receiveAttachmentChunk() { ${trigger} }
      setTimeout(receiveAttachmentChunk, 10);
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: tmp,
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { HOME: tmp, TMPDIR: tmp, PATH: "/usr/bin:/bin", IB_WATCH_LOG_PATH: logPath },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, stdout, stderr, log: readLog(logPath) };
  }

  test("an unhandled rejection leaves a [crash] entry and an [exit] line, restores the terminal and exits 1", async () => {
    const run = await runCrashingChild(`void Promise.reject(new Error("peer stream reset mid-attachment"));`);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("RESTORED\n");
    expect(run.stderr).toContain("ib watch crashed (unhandledRejection)");
    expect(run.stderr).toContain("Error: peer stream reset mid-attachment");
    expect(run.log).toMatch(/Z \[crash\] ib watch died: unhandledRejection \(pid \d+, uptime \d+\.\ds\)\n    Error: peer stream reset mid-attachment\n/);
    expect(run.log).toContain("receiveAttachmentChunk");
    expect(run.log).toMatch(/Z \[exit\] ib watch exiting with code 1, crashed \(unhandledRejection\) \(pid \d+/);
  });

  test("an uncaught exception leaves a [crash] entry and exits 1", async () => {
    const run = await runCrashingChild(`throw new RangeError("offset beyond 6 MB attachment");`);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("RESTORED\n");
    expect(run.log).toContain("[crash] ib watch died: uncaughtException");
    expect(run.log).toContain("    RangeError: offset beyond 6 MB attachment");
    expect(run.log).toContain("receiveAttachmentChunk");
  });
});

// Hooks and the other `ib` commands keep Bun's default crash handling: only
// `ib watch` (launchDashboard) installs these handlers.
describe("crash handlers are installed for ib watch only", () => {
  async function sourceFiles(): Promise<{ path: string; text: string }[]> {
    const files: { path: string; text: string }[] = [];
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: SRC, absolute: true })) {
      if (path.endsWith(".test.ts") || path.endsWith(".d.ts")) continue;
      files.push({ path, text: await Bun.file(path).text() });
    }
    return files;
  }

  test("launchDashboard is the only caller of installWatchCrashHandlers, before its first await", async () => {
    const callers = (await sourceFiles())
      .filter((f) => f.text.includes("installWatchCrashHandlers(") && !f.path.endsWith(join("tui", "watch-crash.ts")))
      .map((f) => relative(SRC, f.path));
    expect(callers).toEqual([join("tui", "dashboard.ts")]);

    const source = await Bun.file(join(SRC, "tui", "dashboard.ts")).text();
    const body = source.slice(source.indexOf("export async function launchDashboard(): Promise<void> {"));
    const install = body.indexOf("installWatchCrashHandlers()");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(body.indexOf("await "));
    expect(source.match(/installWatchCrashHandlers\(/g)).toHaveLength(1);
    // The teardown is handed over, and a quit names itself for the [exit] line.
    expect(body).toContain("crashHandlers.setRestoreTerminal(");
    expect(body.slice(body.indexOf("const quitDashboard = "))).toContain("crashHandlers.noteQuit(");
  });

  test("only the `watch` command calls launchDashboard", async () => {
    const callers = (await sourceFiles())
      .filter((f) => /\blaunchDashboard\(\)/.test(f.text.replace(/export async function launchDashboard\(\)/, "")))
      .map((f) => relative(SRC, f.path));
    expect(callers).toEqual(["index.ts"]);

    const index = await Bun.file(join(SRC, "index.ts")).text();
    const watchCase = index.slice(index.indexOf('case "watch": {'));
    const call = watchCase.indexOf("await launchDashboard();");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(watchCase.indexOf("case ", 1));
    expect(index.match(/launchDashboard\(\)/g)).toHaveLength(1);
  });

  test("importing the CLI, the dashboard and the hooks installs no crash listener", async () => {
    await import("../index");
    await import("./dashboard");
    for await (const path of new Bun.Glob("hooks/*.ts").scan({ cwd: SRC, absolute: true })) {
      if (!path.endsWith(".test.ts")) await import(path);
    }
    const ours = new Set(["watchCrashOnUncaughtException", "watchCrashOnUnhandledRejection", "watchCrashOnExit"]);
    // The names are real: a fresh install on a stand-in carries them.
    const probe = new EventEmitter();
    installWatchCrashHandlers({ target: probe, exit: () => {}, log: () => {} });
    expect(new Set([...probe.listeners("uncaughtException"), ...probe.listeners("unhandledRejection"), ...probe.listeners("exit")].map((fn) => fn.name))).toEqual(ours);
    for (const event of ["uncaughtException", "unhandledRejection", "exit"] as const) {
      expect(process.listeners(event).filter((fn) => ours.has(fn.name))).toEqual([]);
    }
  });
});

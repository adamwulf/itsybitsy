import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { existsSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { isBounceScriptProcess } from "./coordinator";
import { waitFor } from "./test-utils";

// bounce.sh's crash records (SPEC §8.14): after each `ib watch` run it appends
// how the run ended to watch.log, and it tees ib watch's stderr into
// watch-stderr.log. These tests run a copy of the real script against a stand-in
// ./ib and ./build.sh, never the real ib.

const BOUNCE = resolve(import.meta.dir, "..", "bounce.sh");
const STDERR_LOG_MAX_BYTES = 2_097_152;
/** A run's own deadline. Every internal wait stays under it... */
const DEADLINE_MS = 15_000;
/** ...and bun's per-test timeout sits above it, so a hung run is killed by
 *  the deadline (whole group) rather than by bun (which skips cleanup). */
const TEST_TIMEOUT_MS = 30_000;

interface RunResult { exitCode: number | null; signalCode: string | null; stdout: string; stderr: string }

/**
 * Start argv as the leader of a new process group; bash, the stand-in ib and
 * tee all join it. At DEADLINE_MS the whole group gets SIGKILL, so a hung
 * stand-in or tee cannot hold the pipes open. stop() does the same at once
 * unless the run already finished.
 */
function startGroup(argv: string[], env: Record<string, string>, cwd: string): { pid: number; result: Promise<RunResult>; stop(): void } {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  let settled = false;
  const killGroup = () => {
    if (settled) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
  };
  const deadline = setTimeout(killGroup, DEADLINE_MS);
  const result = (async () => {
    try {
      // The pipes close only when tee, which bounce.sh starts per launch, is done too.
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      await child.exited;
      return { exitCode: child.exitCode, signalCode: child.signalCode, stdout, stderr };
    } finally {
      settled = true;
      clearTimeout(deadline);
    }
  })();
  return { pid: child.pid, result, stop: killGroup };
}

async function run(argv: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  const group = startGroup(argv, env, cwd);
  try {
    return await group.result;
  } finally {
    group.stop();
  }
}

test("bounce.sh passes bash -n", async () => {
  const result = await run(["/bin/bash", "-n", BOUNCE], { PATH: "/usr/bin:/bin" }, import.meta.dir);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
}, TEST_TIMEOUT_MS);

test("describe_exit decodes a death by signal", async () => {
  const source = readFileSync(BOUNCE, "utf8");
  const fn = source.match(/^describe_exit\(\) \{\n[\s\S]*?^\}\n/m)?.[0];
  expect(fn).toBeDefined();
  const cases: [number, string][] = [
    [0, "status 0"],
    [1, "status 1"],
    [128, "status 128"],
    [133, "status 133 (signal 5, SIGTRAP)"],
    [134, "status 134 (signal 6, SIGABRT)"],
    [137, "status 137 (signal 9, SIGKILL)"],
    [139, "status 139 (signal 11, SIGSEGV)"],
    [255, "status 255 (signal 127)"],
  ];
  const script = `${fn}\n${cases.map(([status]) => `describe_exit ${status}`).join("\n")}\n`;
  const result = await run(["/bin/bash", "-c", script], { PATH: "/usr/bin:/bin" }, import.meta.dir);
  expect(result.stdout.trimEnd().split("\n")).toEqual(cases.map(([, text]) => text));
}, TEST_TIMEOUT_MS);

describe("bounce.sh loop", () => {
  let root: string;
  let checkout: string;
  let home: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bounce-sh-"));
    checkout = join(root, "checkout");
    home = join(root, "home");
    const bin = join(root, "bin");
    await mkdir(checkout);
    await mkdir(home);
    await mkdir(bin);
    await copyFile(BOUNCE, join(checkout, "bounce.sh"));
    await writeFile(join(checkout, "build.sh"), "#!/bin/bash\nexit 0\n");
    // The stand-in ib: `pull` succeeds; each `watch` launch is numbered,
    // records its parent's command line, writes to stderr and ends as below.
    // The third asks bounce.sh itself to stop, ending the loop.
    await writeFile(join(checkout, "ib"), `#!/bin/bash
dir="$(dirname "$0")"
case "$1" in
  pull) exit 0 ;;
  watch)
    n=$(( $(cat "$dir/launches" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$dir/launches"
    ps -o command= -p "$PPID" > "$dir/parent-$n"
    echo "fake ib watch stderr, launch $n" >&2
    case "$n" in
      1) kill -KILL $$ ;;
      2) exit 3 ;;
      *) kill -TERM "$PPID"; exit 0 ;;
    esac
    ;;
esac
`);
    // The 5-second countdown, without the wait.
    await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    for (const file of [join(checkout, "build.sh"), join(checkout, "ib"), join(bin, "sleep")]) await chmod(file, 0o755);
    env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("relaunches after each exit, records how each run ended, and keeps a copy of stderr", async () => {
    const stderrLog = join(home, ".itsybitsy", "watch-stderr.log");
    // Over the cap: the first launch moves it aside.
    await mkdir(join(home, ".itsybitsy"));
    await writeFile(stderrLog, "x".repeat(STDERR_LOG_MAX_BYTES + 1));

    const result = await run(["/bin/bash", join(checkout, "bounce.sh")], env, root);

    // The loop ran until the third launch stopped it.
    expect(result.signalCode).toBe("SIGTERM");
    expect(readFileSync(join(checkout, "launches"), "utf8").trim()).toBe("3");
    // Every launch is still a direct child of bounce.sh: its parent passes
    // the check `ib bounce` makes.
    for (const n of [1, 2, 3]) {
      const parent = readFileSync(join(checkout, `parent-${n}`), "utf8").trim();
      expect(isBounceScriptProcess(parent)).toBe(true);
    }

    const watchLog = readFileSync(join(home, ".itsybitsy", "watch.log"), "utf8");
    expect(watchLog.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \[bounce\.sh\] ib watch exited with status 137 \(signal 9, SIGKILL\)$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \[bounce\.sh\] ib watch exited with status 3$/),
    ]);

    // stderr still reaches the terminal, and a copy lands in watch-stderr.log
    // under one separator per launch.
    for (const n of [1, 2, 3]) expect(result.stderr).toContain(`fake ib watch stderr, launch ${n}\n`);
    const copy = readFileSync(stderrLog, "utf8").split("\n").filter(Boolean);
    expect(copy).toEqual([
      expect.stringMatching(/^===== \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z bounce\.sh launching ib watch =====$/),
      "fake ib watch stderr, launch 1",
      expect.stringMatching(/^===== .* bounce\.sh launching ib watch =====$/),
      "fake ib watch stderr, launch 2",
      expect.stringMatching(/^===== .* bounce\.sh launching ib watch =====$/),
      "fake ib watch stderr, launch 3",
    ]);
    // The oversized log was moved aside whole, not appended to.
    expect(statSync(`${stderrLog}.1`).size).toBe(STDERR_LOG_MAX_BYTES + 1);
  }, TEST_TIMEOUT_MS);

  // `ib watch` ignores Ctrl-C once its quit has restored the terminal, and a
  // slow quit can still write to stderr. The terminal's Ctrl-C reaches the
  // whole foreground process group, tee included. A tee that died there would
  // make ib watch's next stderr write fail: an uncaught EPIPE that the crash
  // handler turns into a [crash] in the middle of a quit. Two things keep tee
  // alive: bash starts the process substitution with SIGINT ignored (job
  // control is off in a script), and `tee -i`. Measured on macOS bash 3.2: a
  // plain `tee -a` passes this test too, so it guards the property (say,
  // against moving tee into a pipeline, where SIGINT is not ignored), not the
  // flag alone.
  test("a Ctrl-C during ib watch's shutdown does not kill tee: later stderr still reaches the terminal and the file", async () => {
    await writeFile(join(checkout, "ib"), `#!/bin/bash
dir="$(dirname "$0")"
case "$1" in
  pull) exit 0 ;;
  watch)
    n=$(( $(cat "$dir/launches" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$dir/launches"
    if [ "$n" = 1 ]; then
      # Like ib watch partway through a quit: Ctrl-C is ignored.
      trap '' INT
      : > "$dir/ready"
      while [ ! -f "$dir/go" ]; do /bin/sleep 0.02; done
      echo "late stderr line, written after the Ctrl-C" >&2
      exit 0
    fi
    kill -TERM "$PPID"
    exit 0
    ;;
esac
`);
    // bounce.sh leads its own process group, as the foreground job of a
    // terminal does, so the group kill below is a terminal Ctrl-C.
    const group = startGroup(["/bin/bash", join(checkout, "bounce.sh")], env, root);
    try {
      await waitFor(() => existsSync(join(checkout, "ready")), { timeoutMs: 10_000, message: "first launch ready" });
      process.kill(-group.pid, "SIGINT");
      // Let every process in the group act on the signal before the write.
      await Bun.sleep(200);
      await writeFile(join(checkout, "go"), "");
      const result = await group.result;

      // The loop went on to a second launch, which stopped it.
      expect(readFileSync(join(checkout, "launches"), "utf8").trim()).toBe("2");
      expect(result.signalCode).toBe("SIGTERM");
      expect(result.stderr).toContain("late stderr line, written after the Ctrl-C\n");
      expect(readFileSync(join(home, ".itsybitsy", "watch-stderr.log"), "utf8")).toContain("late stderr line, written after the Ctrl-C\n");
      // The first launch exited normally, not by SIGPIPE.
      expect(readFileSync(join(home, ".itsybitsy", "watch.log"), "utf8")).toMatch(/\[bounce\.sh\] ib watch exited with status 0\n$/);
    } finally {
      group.stop();
    }
  }, TEST_TIMEOUT_MS);

  test("writes the exit line where IB_WATCH_LOG_PATH points, as ib watch does", async () => {
    const redirected = join(root, "elsewhere", "watch.log");

    await run(["/bin/bash", join(checkout, "bounce.sh")], { ...env, IB_WATCH_LOG_PATH: redirected }, root);

    expect(readFileSync(redirected, "utf8")).toContain("[bounce.sh] ib watch exited with status 137 (signal 9, SIGKILL)");
    expect(existsSync(join(home, ".itsybitsy", "watch.log"))).toBe(false);
  }, TEST_TIMEOUT_MS);
});

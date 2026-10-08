import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxDenialExecPrefix, sandboxDenialScriptPreamble } from "./sandbox-log-launch";
import { shellQuote } from "./validation";
import { removeSandboxProfile, sandboxLogParent, sandboxProfilePath } from "./sandbox-log-paths";
import { withTimeZone } from "./test-utils";

async function fixture(mode: "success" | "startup-failure" | "runtime-failure" | "collector-sigkill" | "slow-ready") {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-launch-test-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  // Controlled protocol peer: tests shell ownership, not real kernel capture.
  await writeFile(join(bin, "ib"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --dir ]; then dir="$2"; shift; fi
  shift
done
${mode === "startup-failure" ? "exit 27" : ""}
${mode === "slow-ready" ? `: > ${shellQuote(join(dir, "collector-entered"))}; sleep 0.5` : ""}
: > "$dir/ready"
${mode === "runtime-failure" ? "sleep 0.15; exit 31" : ""}
${mode === "collector-sigkill" ? 'sleep 0.15; kill -KILL "$$"' : ""}
while [ ! -s "$dir/stop" ]; do sleep 0.01; done
`);
  await chmod(join(bin, "ib"), 0o755);
  // The launcher writes the agent's profile into its namespace before any launch.
  await mkdir(sandboxLogParent(dir, dir), { recursive: true });
  await writeFile(sandboxProfilePath(dir, dir), "(version 1)\n");
  const wrapper = join(bin, "required-wrapper");
  await writeFile(wrapper, `#!/bin/sh\nprintf 'wrapped\\n' >> ${shellQuote(join(dir, "enforcement"))}\nexec "$@"\n`);
  await chmod(wrapper, 0o755);
  const children: Bun.Subprocess[] = [];
  const start = async (name: string, seconds: number, cliCommand = `/bin/sleep ${seconds}`) => {
    const script = join(dir, `${name}.sh`);
    await writeFile(script, `#!/bin/bash
AGENT_LOG=${shellQuote(join(dir, "agent.log"))}
cleanup_sandbox_proxy() { printf 'cleanup\\n' >> ${shellQuote(join(dir, "proxy-cleanup"))}; }
${sandboxDenialScriptPreamble(dir, dir, true)}
printf '%s' "$IB_SANDBOX_LOG_DIR" > ${shellQuote(join(dir, `${name}-dir.tmp`))}
mv -f ${shellQuote(join(dir, `${name}-dir.tmp`))} ${shellQuote(join(dir, `${name}-dir`))}
${sandboxDenialExecPrefix(shellQuote(wrapper), true)} ${cliCommand} &
cli=$!
wait "$cli"
`);
    // A zone that is not UTC, so the agent.log stamps show local time is used.
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TZ: "America/Chicago" };
    const child = Bun.spawn(["/bin/bash", script], { env, stdout: "ignore", stderr: "ignore" });
    children.push(child);
    return child;
  };
  return { dir, start, cleanup: async () => {
    for (const child of children) { if (child.exitCode === null) child.kill(); }
    const parent = sandboxLogParent(dir, dir);
    for (const name of await readdir(parent).catch(() => [])) await writeFile(join(parent, name, "stop"), "stop\n").catch(() => {});
    await Bun.sleep(50);
    await rm(dir, { recursive: true, force: true });
  } };
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("fixture did not reach expected state");
}

test("collector startup failure is visible and the required wrapper still executes", async () => {
  const f = await fixture("startup-failure");
  try {
    const child = await f.start("start", 0);
    expect(await child.exited).toBe(0);
    expect(await readFile(join(f.dir, "enforcement"), "utf8")).toBe("wrapped\n");
    const log = await readFile(join(f.dir, "agent.log"), "utf8");
    expect(log).toContain("collector exited 27");
    expect(log).toContain("collector unavailable before CLI launch");
    // Both lines carry agent.log's local [YYYY-MM-DD HH:MM:SS] stamp: read as
    // the script's local time it is now, which a UTC stamp is not.
    const stamps = [...log.matchAll(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] \[SandboxCollector\] ERROR: /gm)].map(m => m[1]!);
    expect(stamps).toHaveLength(2);
    for (const stamp of stamps) {
      const at = withTimeZone("America/Chicago", () => new Date(stamp.replace(" ", "T")).getTime());
      expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
    }
  } finally { await f.cleanup(); }
});

test("supervisor reports runtime collector failure while CLI continues without dashboard or watchdog", async () => {
  const f = await fixture("runtime-failure");
  try {
    const child = await f.start("start", 0.8);
    await until(async () => (await Bun.file(join(f.dir, "agent.log")).text().catch(() => "")).includes("collector exited 31"));
    expect(child.exitCode).toBeNull();
    expect(await Bun.file(join(f.dir, "proxy-cleanup")).exists()).toBe(false);
    expect(await child.exited).toBe(0);
    expect(await readFile(join(f.dir, "proxy-cleanup"), "utf8")).toBe("cleanup\n");
    expect(await readFile(join(f.dir, "enforcement"), "utf8")).toBe("wrapped\n");
  } finally { await f.cleanup(); }
});

test("late old-launch cleanup does not stop a replacement or remove its artifacts", async () => {
  const f = await fixture("success");
  try {
    const old = await f.start("old", 0.3);
    await until(() => Bun.file(join(f.dir, "old-dir")).exists());
    const replacement = await f.start("resume", 0.9);
    await until(() => Bun.file(join(f.dir, "resume-dir")).exists());
    const oldDir = await readFile(join(f.dir, "old-dir"), "utf8");
    const newDir = await readFile(join(f.dir, "resume-dir"), "utf8");
    expect(oldDir).not.toBe(newDir);
    expect(await old.exited).toBe(0);
    await until(async () => !await Bun.file(join(oldDir, "ready")).exists());
    expect(await readFile(join(newDir, "stop"), "utf8")).toBe("");
    expect(await Bun.file(join(newDir, "ready")).exists()).toBe(true);
    expect(replacement.exitCode).toBeNull();
    expect(await replacement.exited).toBe(0);
  } finally { await f.cleanup(); }
});

test("the supervisor removes the agent's namespace after its launch, but only once the profile is gone", async () => {
  const f = await fixture("success");
  try {
    const parent = sandboxLogParent(f.dir, f.dir);
    const profile = sandboxProfilePath(f.dir, f.dir);
    // While the agent exists, its profile keeps the namespace.
    const kept = await f.start("kept", 0);
    await until(() => Bun.file(join(f.dir, "kept-dir")).exists());
    const keptDir = await readFile(join(f.dir, "kept-dir"), "utf8");
    expect(await kept.exited).toBe(0);
    await until(async () => !existsSync(keptDir));
    await Bun.sleep(100);
    expect(existsSync(profile)).toBe(true);
    // A teardown while a launch still runs removes the profile, but the launch
    // directory keeps the namespace; its supervisor removes both afterwards.
    const running = await f.start("running", 0.5);
    await until(() => Bun.file(join(f.dir, "running-dir")).exists());
    removeSandboxProfile(f.dir, f.dir);
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(parent)).toBe(true);
    expect(await running.exited).toBe(0);
    await until(async () => !existsSync(parent));
  } finally { await f.cleanup(); }
});

test("switched off, the helpers add no collector block and keep the exact sandbox-exec prefix", () => {
  // The switch-off path: launch scripts then match the plain sandbox-exec launch.
  expect(sandboxDenialScriptPreamble("/tmp/test", "/tmp/home", false)).toBe("");
  const prefix = "'/usr/bin/sandbox-exec' -f '/tmp/test/sandbox.sb' -D 'AGENTDIR=/tmp/test'";
  expect(sandboxDenialExecPrefix(prefix, false)).toBe(prefix);
  // On, the same prefix runs behind the fd 9 gate, unchanged at its end; the
  // gate waits for nothing and names no collector file.
  const gated = sandboxDenialExecPrefix(prefix, true);
  expect(gated).toBe(`/bin/sh -c 'exec 9>&-; exec "$@"' sandbox-log-gate ${prefix}`);
});

test("gate preserves arguments and wrapper exit status", async () => {
  const prefix = sandboxDenialExecPrefix("/bin/sh -c 'test \"$1\" = \"a b\" && exit 23' wrapper", true);
  const child = Bun.spawn(["/bin/sh", "-c", `${prefix} 'a b'`], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(23);
});

test("CLI inherits neither collector control variables nor reserved fd 9", async () => {
  const f = await fixture("success");
  try {
    const probe = join(f.dir, "probe.sh");
    await writeFile(probe, `#!/bin/sh\n[ -z "\${IB_SANDBOX_LOG_DIR+x}" ] || exit 10\n[ ! -e /dev/fd/9 ] || exit 12\n`);
    const child = await f.start("start", 0, `/bin/sh ${shellQuote(probe)}`);
    expect(await child.exited).toBe(0);
  } finally { await f.cleanup(); }
});

test("old EXIT writes the original stop inode even after its pathname is reused", async () => {
  const f = await fixture("runtime-failure");
  try {
    const old = await f.start("old", 0.9);
    await until(() => Bun.file(join(f.dir, "old-dir")).exists());
    const dir = await readFile(join(f.dir, "old-dir"), "utf8");
    await until(async () => (await Bun.file(join(f.dir, "agent.log")).text().catch(() => "")).includes("collector exited 31"));
    await until(async () => !await Bun.file(join(dir, "ready")).exists());
    // Force an otherwise astronomically unlikely mktemp-name reuse after the
    // sole supervisor removal, while the old launch still has its EXIT trap.
    await mkdir(dir);
    await writeFile(join(dir, "stop"), "replacement");
    expect(await old.exited).toBe(0);
    expect(await readFile(join(dir, "stop"), "utf8")).toBe("replacement");
  } finally { await f.cleanup(); }
});

test("supervisor removes its reserved directory after collector SIGKILL and reports failure", async () => {
  const f = await fixture("collector-sigkill");
  try {
    const child = await f.start("start", 0.8);
    await until(() => Bun.file(join(f.dir, "start-dir")).exists());
    const dir = await readFile(join(f.dir, "start-dir"), "utf8");
    await until(async () => (await Bun.file(join(f.dir, "agent.log")).text().catch(() => "")).includes("collector exited 137"));
    await until(async () => !await Bun.file(join(dir, "ready")).exists());
    expect(child.exitCode).toBeNull();
    expect(await child.exited).toBe(0);
    expect(await readFile(join(f.dir, "enforcement"), "utf8")).toBe("wrapped\n");
  } finally { await f.cleanup(); }
});

test("SIGHUP during collector readiness does not abort the launch", async () => {
  const f = await fixture("slow-ready");
  try {
    const preamble = sandboxDenialScriptPreamble(f.dir, f.dir, true);
    expect(preamble.indexOf("trap '' HUP")).toBeLessThan(preamble.indexOf("collector_wait=0"));
    const child = await f.start("start", 0);
    await until(() => Bun.file(join(f.dir, "collector-entered")).exists());
    expect(await Bun.file(join(f.dir, "enforcement")).exists()).toBe(false);
    child.kill("SIGHUP");
    expect(await child.exited).toBe(0);
    expect(await readFile(join(f.dir, "enforcement"), "utf8")).toBe("wrapped\n");
  } finally { await f.cleanup(); }
});

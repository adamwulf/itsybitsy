import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxDenialExecPrefix, sandboxDenialScriptPreamble } from "./sandbox-log-launch";
import { shellQuote } from "./validation";

async function fixture(mode: "success" | "startup-failure" | "runtime-failure") {
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
: > "$dir/ready"
while [ ! -f "$dir/root-request" ] && [ ! -f "$dir/stop" ]; do sleep 0.01; done
: > "$dir/root-ready"
${mode === "runtime-failure" ? "sleep 0.15; exit 31" : ""}
while [ ! -f "$dir/stop" ]; do sleep 0.01; done
`);
  await chmod(join(bin, "ib"), 0o755);
  const wrapper = join(bin, "required-wrapper");
  await writeFile(wrapper, `#!/bin/sh\nprintf 'wrapped\\n' >> ${shellQuote(join(dir, "enforcement"))}\nexec "$@"\n`);
  await chmod(wrapper, 0o755);
  const children: Bun.Subprocess[] = [];
  const start = async (name: string, seconds: number) => {
    const script = join(dir, `${name}.sh`);
    await writeFile(script, `#!/bin/bash
AGENT_LOG=${shellQuote(join(dir, "agent.log"))}
cleanup_sandbox_proxy() { printf 'cleanup\\n' >> ${shellQuote(join(dir, "proxy-cleanup"))}; }
${sandboxDenialScriptPreamble(dir)}
printf '%s' "$IB_SANDBOX_LOG_DIR" > ${shellQuote(join(dir, `${name}-dir`))}
${sandboxDenialExecPrefix(shellQuote(wrapper))} /bin/sleep ${seconds} &
cli=$!
wait "$cli"
`);
    const child = Bun.spawn(["/bin/bash", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "ignore", stderr: "ignore" });
    children.push(child);
    return child;
  };
  return { dir, start, cleanup: async () => {
    for (const child of children) { if (child.exitCode === null) child.kill(); }
    for (const name of await readdir(dir)) if (name.startsWith("sandbox-log.")) await writeFile(join(dir, name, "stop"), "");
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
    expect(await Bun.file(join(oldDir, "stop")).exists()).toBe(true);
    expect(await Bun.file(join(newDir, "stop")).exists()).toBe(false);
    expect(await Bun.file(join(newDir, "ready")).exists()).toBe(true);
    expect(replacement.exitCode).toBeNull();
    expect(await replacement.exited).toBe(0);
  } finally { await f.cleanup(); }
});

test("gate preserves arguments and wrapper exit status when collection is unavailable", async () => {
  const prefix = sandboxDenialExecPrefix("/bin/sh -c 'test \"$1\" = \"a b\" && exit 23' wrapper");
  const child = Bun.spawn(["/bin/sh", "-c", `${prefix} 'a b'`], {
    env: { ...process.env, IB_SANDBOX_LOG_DIR: "" }, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(23);
});

import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSandboxLogStream } from "./sandbox-log-watch";

async function until(predicate: () => Promise<boolean>, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("stream fixture timed out");
}

// Real Darwin processes, pipes and signals; the stream is a controlled peer,
// NOT /usr/bin/log. These tests make no claim about kernel-report capture.
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-stream-test-"));
  const ready = join(dir, "ready");
  const done = join(dir, "done");
  const peer = join(dir, "peer.ts");
  const helper = join(dir, "helper.ts");
  await writeFile(peer, `
    import { dlopen, FFIType } from "bun:ffi";
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { getpgrp: {args:[],returns:FFIType.i32}, getsid: {args:[FFIType.i32],returns:FFIType.i32} });
    await Bun.write(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,pgid:lib.symbols.getpgrp(),sid:lib.symbols.getsid(0)}));
    process.on("SIGTERM", async () => { await Bun.write(${JSON.stringify(done)}, "TERM"); process.exit(0); });
    setInterval(async () => {
      if (await Bun.file(${JSON.stringify(join(dir, "crash-peer"))}).exists()) process.kill(process.pid, "SIGKILL");
      if (await Bun.file(${JSON.stringify(join(dir, "finish-peer"))}).exists()) {
        await Bun.write(${JSON.stringify(done)}, "finished"); process.exit(0);
      }
    }, 10);
  `);
  await writeFile(helper, `
    import { runSandboxLogStream } from ${JSON.stringify(join(import.meta.dir, "sandbox-log-stream.ts"))};
    process.exit(await runSandboxLogStream([${JSON.stringify(process.execPath)}, ${JSON.stringify(peer)}]));
  `);
  const handles: Bun.Subprocess[] = [];
  const spawn = (detached = true) => {
    const child = Bun.spawn([process.execPath, helper], { detached, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    handles.push(child);
    return child;
  };
  return { dir, ready, done, helper, spawn, handles, cleanup: async () => {
    for (const h of handles) if (h.exitCode === null && h.signalCode === null) h.kill();
    await Promise.all(handles.map(h => h.exited));
    await rm(dir, {recursive:true, force:true});
  }};
}

const darwinTest = process.platform === "darwin" ? test : test.skip;

darwinTest("detached helper owns the peer group and EOF ends its child", async () => {
  const f = await fixture();
  try {
    const h = f.spawn();
    await until(() => Bun.file(f.ready).exists());
    const peer = JSON.parse(await readFile(f.ready, "utf8"));
    expect(peer.pgid).toBe(h.pid);
    expect(peer.sid).toBe(h.pid);
    expect(peer.pid).not.toBe(h.pid);
    await h.stdin.end();
    expect(await h.exited).toBe(0);
    expect(await readFile(f.done, "utf8")).toBe("TERM");
  } finally { await f.cleanup(); }
});

darwinTest("direct non-detached helper refuses before spawning or signalling", async () => {
  const f = await fixture();
  try {
    const h = f.spawn(false);
    expect(await h.exited).toBe(1);
    expect(await new Response(h.stderr).text()).toContain("must own its detached session");
    expect(await Bun.file(f.ready).exists()).toBe(false);
  } finally { await f.cleanup(); }
});

darwinTest("immediate lifeline EOF is handled even before helper startup", async () => {
  const f = await fixture();
  try {
    const h = f.spawn();
    await h.stdin.end();
    expect(await h.exited).toBe(0);
  } finally { await f.cleanup(); }
});

darwinTest("stream signal death is relayed as failure without waiting for EOF", async () => {
  const f = await fixture();
  try {
    const h = f.spawn();
    await until(() => Bun.file(f.ready).exists());
    await writeFile(join(f.dir, "crash-peer"), "");
    expect(await h.exited).toBe(1);
    expect(await new Response(h.stderr).text()).toContain("signal=SIGKILL");
  } finally { await f.cleanup(); }
});

darwinTest("helper SIGTERM uses group teardown", async () => {
  const f = await fixture();
  try {
    const h = f.spawn();
    await until(() => Bun.file(f.ready).exists());
    h.kill();
    expect(await h.exited).toBe(0);
    expect(await readFile(f.done, "utf8")).toBe("TERM");
  } finally { await f.cleanup(); }
});

darwinTest("helper crash cannot hang collector pumps on inherited stream pipes", async () => {
  const f = await fixture();
  try {
    const h = f.spawn();
    await until(() => Bun.file(f.ready).exists());
    const out = h.stdout.getReader();
    const err = h.stderr.getReader();
    const pendingOut = out.read();
    const pendingErr = err.read();
    h.kill("SIGKILL");
    await h.exited;
    await closeSandboxLogStream(h, [out, err]);
    expect((await pendingOut).done).toBe(true);
    expect((await pendingErr).done).toBe(true);
    // This exceptional helper-crash test ends its controlled peer by a host
    // marker, never by a saved PID. Real log orphan lifetime is not claimed.
  } finally {
    await writeFile(join(f.dir, "finish-peer"), "");
    await until(() => Bun.file(f.done).exists());
    await f.cleanup();
  }
});

darwinTest("collector SIGKILL closes lifeline despite a later marker child", async () => {
  const f = await fixture();
  try {
    const driver = join(f.dir, "collector.ts");
    await writeFile(driver, `
      const h = Bun.spawn([${JSON.stringify(process.execPath)}, ${JSON.stringify(f.helper)}], {detached:true,stdin:"pipe",stdout:"ignore",stderr:"ignore"});
      while (!await Bun.file(${JSON.stringify(f.ready)}).exists()) await Bun.sleep(10);
      // A concurrent marker subprocess must not inherit the lifeline write end.
      const marker = Bun.spawn(["/bin/sleep", "2"], {stdin:"ignore",stdout:"ignore",stderr:"ignore"});
      await Bun.write(${JSON.stringify(join(f.dir, "marker-started"))}, "");
      process.kill(process.pid, "SIGKILL");
    `);
    const c = Bun.spawn([process.execPath, driver], {stdout:"ignore",stderr:"pipe"});
    f.handles.push(c);
    expect(await c.exited).not.toBe(0);
    expect(c.signalCode).toBe("SIGKILL");
    await until(() => Bun.file(f.done).exists(), 1000);
    expect(await Bun.file(join(f.dir, "marker-started")).exists()).toBe(true);
  } finally { await f.cleanup(); }
});

darwinTest("pane session leader exit does not HUP the detached stream during drain", async () => {
  const f = await fixture();
  try {
    const collector = join(f.dir, "collector.ts");
    await writeFile(collector, `
      const h = Bun.spawn([${JSON.stringify(process.execPath)}, ${JSON.stringify(f.helper)}], {detached:true,stdin:"pipe",stdout:"ignore",stderr:"ignore"});
      process.on("SIGHUP", () => {});
      while (!await Bun.file(${JSON.stringify(f.ready)}).exists()) await Bun.sleep(10);
      await Bun.write(${JSON.stringify(join(f.dir, "collector-ready"))}, "");
      await Bun.sleep(500);
      await Bun.write(${JSON.stringify(join(f.dir, "survived"))}, String(h.exitCode === null && h.signalCode === null));
      await h.stdin.end();
      process.exit(await h.exited);
    `);
    const leader = join(f.dir, "leader.sh");
    // bash is the session leader under the pty; its exit sends foreground HUP.
    await writeFile(leader, `#!/bin/bash\n(${JSON.stringify(process.execPath)} ${JSON.stringify(collector)}) &\nwhile [ ! -f ${JSON.stringify(join(f.dir, "collector-ready"))} ]; do sleep 0.01; done\nexit 0\n`);
    const driver = join(f.dir, "pty_driver.py");
    await writeFile(driver, `import os, pty\npid, fd = pty.fork()\nif pid == 0:\n    os.execl('/bin/bash', 'bash', ${JSON.stringify(leader)})\nos.waitpid(pid, 0)\nos.close(fd)\n`);
    const p = Bun.spawn(["/usr/bin/python3", driver], {stdout:"ignore",stderr:"pipe"});
    f.handles.push(p);
    const code = await p.exited;
    const stderr = await new Response(p.stderr).text();
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    await until(() => Bun.file(f.done).exists());
    expect(await readFile(join(f.dir, "survived"), "utf8")).toBe("true");
  } finally { await f.cleanup(); }
});

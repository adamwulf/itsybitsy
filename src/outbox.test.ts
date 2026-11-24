import * as fs from "node:fs/promises";
import { spyOn, test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  enqueueOutbox,
  readOutbox,
  rewriteOutboxRemoving,
  deleteAgentOutbox,
  acquireOutboxLock,
  releaseOutboxLock,
  outboxPath,
  outboxLockPath,
  type OutboxMessage,
} from "./outbox";

describe("outbox queue", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "outbox-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test.each(["symlink", "FIFO", "hardlink"])("refuses a %s queue for reads and appends", async kind => {
    const target = join(dir, "protected");
    await writeFile(target, "original");
    const fs = await import("node:fs/promises");
    if (kind === "symlink") await fs.symlink(target, outboxPath(dir));
    else if (kind === "hardlink") await fs.link(target, outboxPath(dir));
    else expect(Bun.spawnSync(["mkfifo", outboxPath(dir)]).exitCode).toBe(0);
    await expect(readOutbox(dir)).rejects.toThrow("single-link regular");
    await expect(enqueueOutbox(dir, { message: "hi", fromAgent: "", raw: false })).rejects.toThrow("single-link regular");
    expect(await readFile(target, "utf8")).toBe("original");
  });

  test.each(["symlink", "FIFO"])("a %s delivery lock is never read, stolen or released", async kind => {
    const target = join(dir, "other");
    const path = outboxLockPath(dir);
    await writeFile(target, "1:token");
    if (kind === "symlink") await fs.symlink(target, path);
    else expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    expect(await acquireOutboxLock(dir, { steal: true, staleMs: -1, timeoutMs: 0 })).toBeNull();
    await releaseOutboxLock({ dir, path, token: "token" });
    const info = await fs.lstat(path);
    expect(kind === "symlink" ? info.isSymbolicLink() : info.isFIFO()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("1:token");
  });

  test.each(["", "\n", "\n{broken"])("appending after a legacy record with tail %j preserves both complete records", async tail => {
    await writeFile(outboxPath(dir), JSON.stringify({ id: "old", message: "legacy", raw: false, fromAgent: "" }) + tail);
    await enqueueOutbox(dir, { id: "new", message: "new", fromAgent: "", raw: false });
    expect((await readOutbox(dir)).map(m => m.id)).toEqual(["old", "new"]);
  });

  test("a concurrent append survives a drain paused immediately before replacement", async () => {
    for (const id of ["one", "two"]) await enqueueOutbox(dir, { id, message: id, fromAgent: "", raw: false });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const rename = fs.rename;
    const spy = spyOn(fs, "rename").mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; return rename(...args);
    });
    try {
      const drain = rewriteOutboxRemoving(dir, new Set(["one"]));
      await entered.promise;
      const append = Bun.spawn([process.execPath, "-e", `
        import { open } from "node:fs/promises";
        import { flock, LOCK_EX, LOCK_NB } from "./src/file-lock";
        import { enqueueOutbox } from "./src/outbox";
        const dir = process.argv[1];
        const fd = await open(dir, "r");
        console.log(flock(fd.fd, LOCK_EX | LOCK_NB) === 0 ? "unlocked" : "locked");
        await fd.close();
        await enqueueOutbox(dir, { id: "three", message: "three", fromAgent: "", raw: false });
      `, dir], { stdout: "pipe", stderr: "inherit" });
      const { value } = await append.stdout.getReader().read();
      expect(new TextDecoder().decode(value).trim()).toBe("locked");
      expect((await readOutbox(dir)).map(m => m.id)).toEqual(["one", "two"]);
      release.resolve(); await drain; expect(await append.exited).toBe(0);
      expect((await readOutbox(dir)).map(m => m.id)).toEqual(["two", "three"]);
    } finally { release.resolve(); spy.mockRestore(); }
  });

  test("enqueue then read returns the message in FIFO order", async () => {
    await enqueueOutbox(dir, { message: "first", fromAgent: "", raw: false, id: "1", enqueuedAtMs: 1 });
    await enqueueOutbox(dir, { message: "second", fromAgent: "agent-x", raw: true, id: "2", enqueuedAtMs: 2 });

    const msgs = await readOutbox(dir);
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.message).toBe("first");
    expect(msgs[0]!.fromAgent).toBe("");
    expect(msgs[0]!.raw).toBe(false);
    expect(msgs[1]!.message).toBe("second");
    expect(msgs[1]!.fromAgent).toBe("agent-x");
    expect(msgs[1]!.raw).toBe(true);
  });

  test("enqueue generates a unique id and timestamp when omitted", async () => {
    const rec = await enqueueOutbox(dir, { message: "m", fromAgent: "", raw: false });
    expect(typeof rec.id).toBe("string");
    expect(rec.id.length).toBeGreaterThan(0);
    expect(typeof rec.enqueuedAtMs).toBe("number");
  });

  test("enqueue creates the directory if missing (no message loss)", async () => {
    const nested = join(dir, "a", "b", "c");
    await enqueueOutbox(nested, { message: "deep", fromAgent: "", raw: false });
    const msgs = await readOutbox(nested);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.message).toBe("deep");
  });

  test("readOutbox returns [] for a missing file", async () => {
    expect(await readOutbox(dir)).toEqual([]);
  });

  test("readOutbox skips malformed lines instead of throwing", async () => {
    await writeFile(outboxPath(dir), [
      JSON.stringify({ id: "1", message: "ok", fromAgent: "", raw: false, enqueuedAtMs: 1 }),
      "{ this is not valid json",
      "",
      JSON.stringify({ id: "2", message: "also-ok", fromAgent: "", raw: false, enqueuedAtMs: 2 }),
    ].join("\n") + "\n");

    const msgs = await readOutbox(dir);
    expect(msgs.map((m) => m.message)).toEqual(["ok", "also-ok"]);
  });

  test("rewriteOutboxRemoving keeps the not-yet-delivered remainder", async () => {
    await enqueueOutbox(dir, { message: "a", fromAgent: "", raw: false, id: "a" });
    await enqueueOutbox(dir, { message: "b", fromAgent: "", raw: false, id: "b" });
    await enqueueOutbox(dir, { message: "c", fromAgent: "", raw: false, id: "c" });

    await writeFile(outboxPath(dir) + ".tmp", "interrupted rewrite");
    await rewriteOutboxRemoving(dir, new Set(["a"]));
    expect(await Bun.file(outboxPath(dir) + ".tmp").exists()).toBe(false);
    let msgs = await readOutbox(dir);
    expect(msgs.map((m) => m.id)).toEqual(["b", "c"]);

    await rewriteOutboxRemoving(dir, new Set(["a", "b", "c"]));
    msgs = await readOutbox(dir);
    expect(msgs).toEqual([]);
    // File removed when empty
    expect(await Bun.file(outboxPath(dir)).exists()).toBe(false);
  });

  test("rewriteOutboxRemoving preserves a message appended mid-drain", async () => {
    await enqueueOutbox(dir, { message: "a", fromAgent: "", raw: false, id: "a" });
    await enqueueOutbox(dir, { message: "b", fromAgent: "", raw: false, id: "b" });
    // Simulate another process appending while we hold the lock.
    await enqueueOutbox(dir, { message: "late", fromAgent: "", raw: false, id: "late" });

    // We "delivered" a and b; the rewrite must keep the late append.
    await rewriteOutboxRemoving(dir, new Set(["a", "b"]));
    const msgs = await readOutbox(dir);
    expect(msgs.map((m) => m.id)).toEqual(["late"]);
  });

  test("deleteAgentOutbox removes both the queue and the lock", async () => {
    await enqueueOutbox(dir, { message: "x", fromAgent: "", raw: false });
    await writeFile(outboxLockPath(dir), String(process.pid));
    await deleteAgentOutbox(dir);
    expect(await Bun.file(outboxPath(dir)).exists()).toBe(false);
    expect(await Bun.file(outboxLockPath(dir)).exists()).toBe(false);
  });

  // Dedupe: a stuck sender that re-fires the SAME notification every tick must
  // not grow the queue unbounded. enqueueOutbox caps at one PENDING copy per
  // (fromAgent, message, raw, team).
  test("enqueue skips an exact-duplicate (same fromAgent+message+raw+team)", async () => {
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false });
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false });
    const msgs = await readOutbox(dir);
    expect(msgs.length).toBe(1);
  });

  test("the skipped enqueue returns the SAME id as the first (the existing record)", async () => {
    const first = await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false });
    const second = await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false });
    expect(second.id).toBe(first.id);
  });

  test("a DIFFERENT message from the same sender still appends (length 2)", async () => {
    await enqueueOutbox(dir, { message: "one", fromAgent: "agent-x", raw: false });
    await enqueueOutbox(dir, { message: "two", fromAgent: "agent-x", raw: false });
    const msgs = await readOutbox(dir);
    expect(msgs.length).toBe(2);
  });

  test("the SAME message from a DIFFERENT fromAgent still appends (length 2)", async () => {
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false });
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-y", raw: false });
    const msgs = await readOutbox(dir);
    expect(msgs.length).toBe(2);
  });

  test("the same message text with different raw still appends (length 2)", async () => {
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false });
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: true });
    const msgs = await readOutbox(dir);
    expect(msgs.length).toBe(2);
  });

  test("the same message text with different team still appends; same team dedupes", async () => {
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false, team: "backend" });
    // Different team → appends.
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false, team: "frontend" });
    let msgs = await readOutbox(dir);
    expect(msgs.length).toBe(2);
    // Same team as the first → dedupes (still 2).
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false, team: "backend" });
    msgs = await readOutbox(dir);
    expect(msgs.length).toBe(2);
  });

  test("after the pending copy is drained, enqueuing the same message AGAIN appends (dedupe only suppresses while pending)", async () => {
    const first = await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false });
    // Second is suppressed while the first is still pending.
    await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false });
    expect((await readOutbox(dir)).length).toBe(1);

    // Drain the pending copy.
    await rewriteOutboxRemoving(dir, new Set([first.id]));
    expect((await readOutbox(dir)).length).toBe(0);

    // Same message enqueues fresh — dedupe does not permanently blacklist it.
    const again = await enqueueOutbox(dir, { message: "dup", fromAgent: "agent-x", raw: false });
    const msgs = await readOutbox(dir);
    expect(msgs.length).toBe(1);
    expect(again.id).not.toBe(first.id);
  });
});

describe("outbox lock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "outbox-lock-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("acquire succeeds when unlocked and writes <pid>:<token>", async () => {
    const lock = await acquireOutboxLock(dir);
    expect(lock).not.toBeNull();
    const content = await readFile(outboxLockPath(dir), "utf-8");
    // Body is `<pid>:<token>`; the token is recorded on the handle.
    expect(content).toBe(`${process.pid}:${lock!.token}`);
    expect(lock!.token.length).toBeGreaterThan(0);
    await releaseOutboxLock(lock);
    expect(await Bun.file(outboxLockPath(dir)).exists()).toBe(false);
  });

  test("second acquire fails fast (timeout) while first holds the lock", async () => {
    const first = await acquireOutboxLock(dir);
    expect(first).not.toBeNull();

    // No steal, tiny timeout — should give up and return null.
    const second = await acquireOutboxLock(dir, { timeoutMs: 0, backoffMs: 1 });
    expect(second).toBeNull();

    await releaseOutboxLock(first);
    // Now acquirable again.
    const third = await acquireOutboxLock(dir, { timeoutMs: 0 });
    expect(third).not.toBeNull();
    await releaseOutboxLock(third);
  });

  test("steal removes a stale lock (mtime older than staleMs)", async () => {
    // Hold the lock with a "stale" mtime by writing the file directly, then
    // forcing the staleness check via injected now().
    await writeFile(outboxLockPath(dir), "2147483647");
    const lockStat = await stat(outboxLockPath(dir));

    // now() far in the future so the existing lock looks stale.
    const future = lockStat.mtimeMs + 60_000;
    const lock = await acquireOutboxLock(dir, {
      steal: true,
      staleMs: 30_000,
      timeoutMs: 1000,
      backoffMs: 1,
      now: () => future,
    });
    expect(lock).not.toBeNull();
    // The lock now records our pid + a fresh token (stolen + recreated).
    expect(await readFile(outboxLockPath(dir), "utf-8")).toBe(`${process.pid}:${lock!.token}`);
    await releaseOutboxLock(lock);
  });

  test("steal does NOT remove a fresh lock", async () => {
    await writeFile(outboxLockPath(dir), "2147483647");
    const lockStat = await stat(outboxLockPath(dir));

    // now() barely after the lock — within staleMs, so not stealable.
    const lock = await acquireOutboxLock(dir, {
      steal: true,
      staleMs: 30_000,
      timeoutMs: 0,
      backoffMs: 1,
      now: () => lockStat.mtimeMs + 1000,
    });
    expect(lock).toBeNull();
    // Original holder pid untouched.
    expect(await readFile(outboxLockPath(dir), "utf-8")).toBe("2147483647");
  });

  test("release after a steal does NOT delete the thief's lock (ownership token)", async () => {
    // Reproduces the reviewer's hole: holder A acquires; A's lock goes stale;
    // B steals it (re-creates with B's token); A then releases. A's release
    // must be a no-op (token mismatch) so B's lock survives — otherwise a third
    // drainer could acquire while B is still delivering → interleave.
    const a = await acquireOutboxLock(dir);
    expect(a).not.toBeNull();
    const aStat = await stat(outboxLockPath(dir));

    // Simulate A's death before B attempts to reclaim its generation.
    await writeFile(outboxLockPath(dir), `2147483647:${a!.token}`);
    const b = await acquireOutboxLock(dir, {
      steal: true,
      staleMs: 30_000,
      timeoutMs: 1000,
      backoffMs: 1,
      now: () => aStat.mtimeMs + 60_000,
    });
    expect(b).not.toBeNull();
    expect(b!.token).not.toBe(a!.token);

    // A releases — must leave B's lock intact.
    await releaseOutboxLock(a);
    expect(await Bun.file(outboxLockPath(dir)).exists()).toBe(true);
    expect(await readFile(outboxLockPath(dir), "utf-8")).toBe(`${process.pid}:${b!.token}`);

    // B's own release removes it.
    await releaseOutboxLock(b);
    expect(await Bun.file(outboxLockPath(dir)).exists()).toBe(false);
  });

  test("releaseOutboxLock(null) is a no-op", async () => {
    await releaseOutboxLock(null); // must not throw
  });

  // SPEC §16.4 trap: the team field is dropped on the round-trip through the
  // queue file unless BOTH the enqueue WRITE literal and the readOutbox READ
  // literal carry it. These regression tests pin both ends.
  test("a message WITH team survives enqueue → readOutbox", async () => {
    await enqueueOutbox(dir, {
      message: "team msg",
      fromAgent: "agent-a1b2c3d4",
      raw: false,
      team: "backend",
      id: "t1",
      enqueuedAtMs: 1,
    });
    const msgs = await readOutbox(dir);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.team).toBe("backend");
    expect(msgs[0]!.message).toBe("team msg");
  });

  test("a message WITHOUT team reads back team === undefined", async () => {
    await enqueueOutbox(dir, {
      message: "plain msg",
      fromAgent: "",
      raw: false,
      id: "p1",
      enqueuedAtMs: 1,
    });
    const msgs = await readOutbox(dir);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.team).toBeUndefined();
    // The undefined team must NOT be serialized as a key on disk.
    const onDisk = await readFile(outboxPath(dir), "utf-8");
    expect(onDisk).not.toContain("\"team\"");
  });
});

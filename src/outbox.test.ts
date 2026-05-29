import { test, expect, describe, beforeEach, afterEach } from "bun:test";
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

    await rewriteOutboxRemoving(dir, new Set(["a"]));
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
});

describe("outbox lock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "outbox-lock-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("acquire succeeds when unlocked and writes holder pid", async () => {
    const lock = await acquireOutboxLock(dir);
    expect(lock).not.toBeNull();
    const content = await readFile(outboxLockPath(dir), "utf-8");
    expect(content).toBe(String(process.pid));
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
    await writeFile(outboxLockPath(dir), "99999");
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
    // The lock now records our pid (stolen + recreated).
    expect(await readFile(outboxLockPath(dir), "utf-8")).toBe(String(process.pid));
    await releaseOutboxLock(lock);
  });

  test("steal does NOT remove a fresh lock", async () => {
    await writeFile(outboxLockPath(dir), "99999");
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
    expect(await readFile(outboxLockPath(dir), "utf-8")).toBe("99999");
  });

  test("releaseOutboxLock(null) is a no-op", async () => {
    await releaseOutboxLock(null); // must not throw
  });
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUserHome, setUserHome } from "../home";
import { waitFor } from "../test-utils";
import { handoffRemoteMessage, textHeader, pollPeerOutbox } from "./peer-outbox";
import { MAX_HEADER_BYTES } from "./transfer-limits";

let home: string;
let base: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-handoff-"));
  setUserHome(home);
  base = join(home, ".itsybitsy", "peer-outbox");
});
afterEach(async () => { resetUserHome(); await rm(home, { recursive: true, force: true }); });

test.each(["oversize", "symlink", "FIFO"])("refuses a %s peer request without sending", async kind => {
  const id = crypto.randomUUID();
  const dir = join(base, id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "request.json");
  const header = { ...textHeader({ kind: "system" }, "hi", { kind: "user" }), id };
  const envelope = JSON.stringify({ peer: "peer", header });
  if (kind === "oversize") await Bun.write(path, envelope + " ".repeat(MAX_HEADER_BYTES + 129));
  if (kind === "symlink") {
    const valid = join(home, "valid-request.json");
    await Bun.write(valid, envelope);
    await symlink(valid, path);
  }
  if (kind === "FIFO") expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
  let sends = 0;
  await pollPeerOutbox(async () => { sends++; return ""; }, () => {});
  expect(await Bun.file(join(base, ".claimed", id, "result.json")).json()).toMatchObject({ ok: false });
  expect(sends).toBe(0);
});

test.each([false, true])("interrupt after publication (claimed=%s)", async claimed => {
  await Bun.write(join(home, ".itsybitsy", "peer", "endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "hi", { kind: "user" });
  const control = new AbortController();
  const result = handoffRemoteMessage("peer", header, control.signal);
  await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
  const started = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<string>();
  const poll = claimed ? pollPeerOutbox(async () => { started.resolve(); return hold.promise; }, () => {}) : undefined;
  if (claimed) await started.promise;
  control.abort();
  try {
    const outcome = await result;
    expect(outcome.exitCode).toBe(130);
    expect(outcome.stderr).toContain(claimed ? "outcome unknown" : "cancelled before sending");
    expect(await Bun.file(join(base, header.id, "request.json")).exists()).toBe(false);
  } finally { hold.resolve(header.id); await poll; }
});

test("an interrupted direct send never publishes an already-cancelled request", async () => {
  const header = textHeader({ kind: "system" }, "hi", { kind: "user" });
  const outcome = await handoffRemoteMessage("peer", header, AbortSignal.abort());
  expect(outcome).toMatchObject({ exitCode: 130, stderr: expect.stringContaining("cancelled before sending") });
  expect(await Bun.file(join(base, header.id, "request.json")).exists()).toBe(false);
});


test("the complete encoded header is validated before probing watcher liveness", async () => {
  const header = textHeader({ kind: "system" }, "x".repeat(MAX_HEADER_BYTES - 1), { kind: "system" });
  expect(await handoffRemoteMessage("peer", header)).toMatchObject({ ok: false, stderr: "Send header exceeds 262144 bytes" });
});

test("claimed request publishes byte progress and propagates CLI interruption to the stream owner", async () => {
  await Bun.write(join(home, ".itsybitsy", "peer", "endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "read", { kind: "user" });
  const controller = new AbortController();
  const result = handoffRemoteMessage("peer", header, controller.signal);
  await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
  const poll = pollPeerOutbox(async (_peer, _header, transfer) => {
    transfer.onProgress!(192);
    return new Promise((_, reject) => transfer.signal!.addEventListener("abort", () => reject(transfer.signal!.reason), { once: true }));
  }, () => {});
  const claimed = join(base, ".claimed", header.id);
  await waitFor(async () => (await Bun.file(join(claimed, "progress")).json().catch(() => null))?.bytes === 192);
  controller.abort();
  expect(await result).toMatchObject({ exitCode: 130, stderr: "outcome unknown — check the recipient" });
  await poll;
});

test("a claimed cancellation with a failed signal still has an unknown outcome", async () => {
  await Bun.write(join(home, ".itsybitsy", "peer", "endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "hello", { kind: "user" });
  const control = new AbortController();
  const result = handoffRemoteMessage("peer", header, control.signal);
  await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
  const finish = Promise.withResolvers<string>();
  const watcher = pollPeerOutbox(async () => {
    await mkdir(join(base, ".claimed", header.id, "cancel")); // writeFile will receive EISDIR
    control.abort();
    return finish.promise;
  }, () => {});
  try { expect((await result).stderr).toBe("outcome unknown — check the recipient"); }
  finally { finish.resolve(header.id); await watcher; }
});

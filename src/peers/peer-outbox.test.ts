import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUserHome, setUserHome } from "../home";
import { pollPeerOutbox } from "./peer-outbox";
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
  const dir = join(base, crypto.randomUUID());
  await mkdir(dir, { recursive: true });
  const path = join(dir, "request.json");
  if (kind === "oversize") await Bun.write(path, Buffer.alloc(MAX_HEADER_BYTES + 129));
  if (kind === "symlink") await symlink(join(home, "missing"), path);
  if (kind === "FIFO") expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
  let sends = 0;
  await pollPeerOutbox(async () => { sends++; return ""; }, () => {});
  expect(await Bun.file(join(dir, "result.json")).json()).toMatchObject({ ok: false });
  expect(sends).toBe(0);
});

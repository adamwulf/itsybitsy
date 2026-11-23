import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUserHome, setUserHome } from "../home";
import { peerDir, peerSecretKeyFile, peersFile } from "../runtime-names";
import { createCliFixture, type CliFixture } from "../test-cli-runner";
import { deriveEndpointId, parseSecretKey } from "./identity";
import { irohAddonLoaderCtx, loadIroh } from "./iroh";
import { runPeerCommand } from "./peer-command";
import { addPeer, readPeers } from "./store";

const ID_A = "a".repeat(64);
const ID_B = "0123456789abcdef".repeat(4);
const ID_C = "c".repeat(64);

describe("ib peer (CLI)", () => {
  let cli: CliFixture;

  beforeAll(async () => {
    cli = await createCliFixture();
  });

  afterAll(async () => {
    await cli.cleanup();
  });

  beforeEach(async () => {
    // Paths are computed through the home seam, pointed at the fixture's HOME.
    setUserHome(cli.home);
    await rm(peerDir(), { recursive: true, force: true });
  });

  afterEach(() => {
    resetUserHome();
  });

  async function seedPeers(): Promise<void> {
    await addPeer({ id: ID_A, name: "alpha", pairedAt: "2026-11-15T01:00:00.000Z" });
    await addPeer({ id: ID_B, name: "twin", pairedAt: "2026-11-15T02:00:00.000Z" });
    await addPeer({ id: ID_C, name: "twin", pairedAt: "2026-11-15T03:00:00.000Z" });
  }

  test("ib peer id creates the key once and prints the same full id every time", async () => {
    const first = await cli.run(["peer", "id"]);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    const id = first.stdout.trim();

    const keyText = await readFile(peerSecretKeyFile(), "utf-8");
    expect(deriveEndpointId(parseSecretKey(keyText, "secret.key"))).toBe(id);
    expect((await stat(peerSecretKeyFile())).mode & 0o777).toBe(0o600);

    const second = await cli.run(["peer", "id"]);
    expect(second.stdout).toBe(`${id}\n`);
    expect(await readFile(peerSecretKeyFile(), "utf-8")).toBe(keyText);
  });

  test("ib peer list with no peers says so", async () => {
    const result = await cli.run(["peer", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("No paired peers.\n");
  });

  test("ib peer list prints each peer's name, full id and pairedAt", async () => {
    await seedPeers();
    const result = await cli.run(["peer", "list"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toMatch(/^NAME\s+ID\s+PAIRED AT$/);
    expect(lines[1]).toBe(`alpha  ${ID_A}  2026-11-15T01:00:00.000Z`);
    expect(lines[2]).toBe(`twin   ${ID_B}  2026-11-15T02:00:00.000Z`);
    expect(lines[3]).toBe(`twin   ${ID_C}  2026-11-15T03:00:00.000Z`);
  });

  test("ib peer list reports a malformed peers.json instead of listing nothing", async () => {
    await mkdir(peerDir(), { recursive: true });
    await writeFile(peersFile(), "{nope");
    const result = await cli.run(["peer", "list"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("peers.json: not valid JSON");
  });

  test("ib peer remove <name> removes that peer", async () => {
    await seedPeers();
    const result = await cli.run(["peer", "remove", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Removed peer "alpha" (${ID_A}).\n`);
    expect((await readPeers()).map((p) => p.id)).toEqual([ID_B, ID_C]);
  });

  test("ib peer remove <id> removes that peer, even when its name is shared", async () => {
    await seedPeers();
    const result = await cli.run(["peer", "remove", ID_C.toUpperCase()]);
    expect(result.exitCode).toBe(0);
    expect((await readPeers()).map((p) => p.id)).toEqual([ID_A, ID_B]);
  });

  test("ib peer remove with a name several peers share fails and lists their ids", async () => {
    await seedPeers();
    const result = await cli.run(["peer", "remove", "twin"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('2 peers are named "twin"');
    expect(result.stderr).toContain(ID_B);
    expect(result.stderr).toContain(ID_C);
    expect((await readPeers()).length).toBe(3);
  });

  test("ib peer remove with an unknown name or id fails", async () => {
    await seedPeers();
    const result = await cli.run(["peer", "remove", "nobody"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no paired peer has the name or id "nobody"');
    expect((await readPeers()).length).toBe(3);
  });

  test("ib peer remove needs exactly one argument", async () => {
    const none = await cli.run(["peer", "remove"]);
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain("Usage: ib peer remove <name|id>");

    await seedPeers();
    const two = await cli.run(["peer", "remove", "twin", "alpha"]);
    expect(two.exitCode).toBe(1);
    expect(two.stderr).toContain("takes one name or id");
    expect((await readPeers()).length).toBe(3);
  });

  test("ib peer without a known subcommand prints usage and fails", async () => {
    const bare = await cli.run(["peer"]);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("Usage: ib peer <id|list|remove>");

    const unknown = await cli.run(["peer", "add", ID_A]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("unknown peer subcommand 'add'");
  });

  test("--help prints the group and subcommand help", async () => {
    const group = await cli.run(["peer", "--help"]);
    expect(group.exitCode).toBe(0);
    expect(group.stdout).toContain("Usage: ib peer <subcommand>");
    expect(group.stdout).toContain("remove <name|id>");

    const remove = await cli.run(["peer", "remove", "--help"]);
    expect(remove.exitCode).toBe(0);
    expect(remove.stdout).toContain("Usage: ib peer remove <name|id>");
  });
});

describe("ib peer never loads the iroh addon", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ib-peer-noaddon-"));
    setUserHome(home);
  });

  afterEach(async () => {
    irohAddonLoaderCtx.reset();
    resetUserHome();
    await rm(home, { recursive: true, force: true });
  });

  test("id, list and remove succeed while loading the addon throws", async () => {
    let loads = 0;
    irohAddonLoaderCtx.set(async () => {
      loads++;
      throw new Error("ib peer must not load the iroh addon");
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runPeerCommand(["id"])).toBe(0);
      await addPeer({ id: ID_A, name: "alpha" });
      expect(await runPeerCommand(["list"])).toBe(0);
      expect(await runPeerCommand(["remove", "alpha"])).toBe(0);
      expect(error).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join("\n")).toContain(`Removed peer "alpha"`);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    expect(loads).toBe(0);

    // Control: the throwing loader is the one loadIroh uses.
    await expect(loadIroh()).rejects.toThrow("ib peer must not load the iroh addon");
    expect(loads).toBe(1);
  });
});

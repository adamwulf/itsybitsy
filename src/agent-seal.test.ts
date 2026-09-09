import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { applySealCapabilityAction, computeSealInputs, computeSealRecord, consumeSealCapability, newSealCapability, readSealRecordStrict, sealCapabilityPath, sealDir, sealPath, writeSealRecordDirect } from "./agent-seal";

describe("seal capabilities", () => {
  test("valid capability is one-use and rejects replay or wrong token", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const cap = await newSealCapability("write", "repo", "agent", meta);
    await Bun.write(sealCapabilityPath("repo", "agent", cap.token, home), JSON.stringify(cap));
    expect(await consumeSealCapability("write", "repo", "agent", "wrong", meta, home)).toBe(false);
    expect(await consumeSealCapability("write", "repo", "agent", cap.token, meta, home)).toBe(true);
    expect(await consumeSealCapability("write", "repo", "agent", cap.token, meta, home)).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("expired capability is rejected", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const cap = await newSealCapability("write", "repo", "agent", meta);
    cap.expires = 0;
    await Bun.write(sealCapabilityPath("repo", "agent", cap.token, home), JSON.stringify(cap));
    expect(await consumeSealCapability("write", "repo", "agent", cap.token, meta, home)).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("simultaneous same-token claims have one winner", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const cap = await newSealCapability("write", "repo", "agent", meta);
    await Bun.write(sealCapabilityPath("repo", "agent", cap.token, home), JSON.stringify(cap));
    const results = await Promise.all([
      consumeSealCapability("write", "repo", "agent", cap.token, meta, home),
      consumeSealCapability("write", "repo", "agent", cap.token, meta, home),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await rm(home, { recursive: true, force: true });
  });

  test("distinct token capabilities remain isolated", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const first = await newSealCapability("write", "repo", "agent", meta);
    const second = await newSealCapability("write", "repo", "agent", meta);
    await Bun.write(sealCapabilityPath("repo", "agent", first.token, home), JSON.stringify(first));
    await Bun.write(sealCapabilityPath("repo", "agent", second.token, home), JSON.stringify(second));
    expect(await consumeSealCapability("write", "repo", "agent", "00000000-0000-0000-0000-000000000000", meta, home)).toBe(false);
    expect(await consumeSealCapability("write", "repo", "agent", second.token, meta, home)).toBe(true);
    expect(await consumeSealCapability("write", "repo", "agent", first.token, meta, home)).toBe(true);
    await rm(home, { recursive: true, force: true });
  });

  test("capability is bound to action, repository, target, and normalized write inputs", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    const changed = { ...meta, sandbox: { enabled: false } };
    await mkdir(sealDir(home), { recursive: true });

    for (const mismatch of [
      ["delete", "repo", "agent", undefined],
      ["write", "other-repo", "agent", meta],
      ["write", "repo", "other-agent", meta],
      ["write", "repo", "agent", changed],
    ] as const) {
      const cap = await newSealCapability("write", "repo", "agent", meta);
      await Bun.write(sealCapabilityPath("repo", "agent", cap.token, home), JSON.stringify(cap));
      expect(await consumeSealCapability(mismatch[0], mismatch[1], mismatch[2], cap.token, mismatch[3], home)).toBe(false);
    }

    const deleteCap = await newSealCapability("delete", "repo", "agent");
    await Bun.write(sealCapabilityPath("repo", "agent", deleteCap.token, home), JSON.stringify(deleteCap));
    expect(await consumeSealCapability("delete", "repo", "agent", deleteCap.token, undefined, home)).toBe(true);
    await rm(home, { recursive: true, force: true });
  });

  test("an exact delete capability rejects a replaced current seal", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const original = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: ["/original"], allowWrite: [], deny: [] } };
    const replacement = { ...original, paths: { allowRead: ["/replacement"], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const expected = computeSealRecord(await computeSealInputs(original));
    const cap = await newSealCapability("delete", "repo", "agent", undefined, expected);
    await Bun.write(sealCapabilityPath("repo", "agent", cap.token, home), JSON.stringify(cap));
    await writeSealRecordDirect("repo", "agent", replacement, home);
    expect(await consumeSealCapability("delete", "repo", "agent", cap.token, undefined, home)).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("trusted capability actions verify exact write and delete postconditions", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: ["/expected"], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });

    const writeCap = await newSealCapability("write", "repo", "agent", meta);
    await Bun.write(sealCapabilityPath("repo", "agent", writeCap.token, home), JSON.stringify(writeCap));
    await applySealCapabilityAction("write", "repo", "agent", writeCap.token, meta, home);
    const expected = computeSealRecord(await computeSealInputs(meta));
    expect(await readSealRecordStrict("repo", "agent", home)).toEqual(expected);

    const deleteCap = await newSealCapability("delete", "repo", "agent", undefined, expected);
    await Bun.write(sealCapabilityPath("repo", "agent", deleteCap.token, home), JSON.stringify(deleteCap));
    await applySealCapabilityAction("delete", "repo", "agent", deleteCap.token, undefined, home);
    expect(await readSealRecordStrict("repo", "agent", home)).toBeNull();
    await rm(home, { recursive: true, force: true });
  });

  test("strict trusted reads never mistake a corrupt record for absence", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    await mkdir(sealDir(home), { recursive: true });
    await Bun.write(sealPath("repo", "agent", home), "not json");
    await expect(readSealRecordStrict("repo", "agent", home)).rejects.toThrow();
    await rm(home, { recursive: true, force: true });
  });
});

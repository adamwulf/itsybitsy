import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { applySealCapabilityAction, computeSealInputs, computeSealRecord, consumeSealCapability, newSealCapability, readSealRecordStrict, sealCapabilityPath, sealDir, sealPath, writeSealRecordDirect } from "./agent-seal";

const REPO_ID = "deadbeef";

describe("seal capabilities", () => {
  test("valid capability is one-use and rejects replay or wrong token", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const cap = await newSealCapability("write", REPO_ID, "agent", meta);
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", cap.token, home), JSON.stringify(cap));
    expect(await consumeSealCapability("write", REPO_ID, "agent", "wrong", meta, home)).toBe(false);
    expect(await consumeSealCapability("write", REPO_ID, "agent", cap.token, meta, home)).toBe(true);
    expect(await consumeSealCapability("write", REPO_ID, "agent", cap.token, meta, home)).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("expired capability is rejected", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const cap = await newSealCapability("write", REPO_ID, "agent", meta);
    cap.expires = 0;
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", cap.token, home), JSON.stringify(cap));
    expect(await consumeSealCapability("write", REPO_ID, "agent", cap.token, meta, home)).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("simultaneous same-token claims have one winner", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const cap = await newSealCapability("write", REPO_ID, "agent", meta);
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", cap.token, home), JSON.stringify(cap));
    const results = await Promise.all([
      consumeSealCapability("write", REPO_ID, "agent", cap.token, meta, home),
      consumeSealCapability("write", REPO_ID, "agent", cap.token, meta, home),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await rm(home, { recursive: true, force: true });
  });

  test("distinct token capabilities remain isolated", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const first = await newSealCapability("write", REPO_ID, "agent", meta);
    const second = await newSealCapability("write", REPO_ID, "agent", meta);
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", first.token, home), JSON.stringify(first));
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", second.token, home), JSON.stringify(second));
    expect(await consumeSealCapability("write", REPO_ID, "agent", "00000000-0000-0000-0000-000000000000", meta, home)).toBe(false);
    expect(await consumeSealCapability("write", REPO_ID, "agent", second.token, meta, home)).toBe(true);
    expect(await consumeSealCapability("write", REPO_ID, "agent", first.token, meta, home)).toBe(true);
    await rm(home, { recursive: true, force: true });
  });

  test("capability is bound to action, repository, target, and normalized write inputs", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    const changed = { ...meta, sandbox: { enabled: false } };
    await mkdir(sealDir(home), { recursive: true });

    for (const mismatch of [
      ["delete", REPO_ID, "agent", undefined],
      ["write", "cafebabe", "agent", meta],
      ["write", REPO_ID, "other-agent", meta],
      ["write", REPO_ID, "agent", changed],
    ] as const) {
      const cap = await newSealCapability("write", REPO_ID, "agent", meta);
      await Bun.write(sealCapabilityPath(REPO_ID, "agent", cap.token, home), JSON.stringify(cap));
      expect(await consumeSealCapability(mismatch[0], mismatch[1], mismatch[2], cap.token, mismatch[3], home)).toBe(false);
    }

    const deleteCap = await newSealCapability("delete", REPO_ID, "agent");
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", deleteCap.token, home), JSON.stringify(deleteCap));
    expect(await consumeSealCapability("delete", REPO_ID, "agent", deleteCap.token, undefined, home)).toBe(true);
    await rm(home, { recursive: true, force: true });
  });

  test("an exact delete capability rejects a replaced current seal", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const original = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: ["/original"], allowWrite: [], deny: [] } };
    const replacement = { ...original, paths: { allowRead: ["/replacement"], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const expected = computeSealRecord(await computeSealInputs(original));
    const cap = await newSealCapability("delete", REPO_ID, "agent", undefined, expected);
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", cap.token, home), JSON.stringify(cap));
    await writeSealRecordDirect(REPO_ID, "agent", replacement, home);
    expect(await consumeSealCapability("delete", REPO_ID, "agent", cap.token, undefined, home)).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("trusted capability actions verify exact write and delete postconditions", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: ["/expected"], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });

    const writeCap = await newSealCapability("write", REPO_ID, "agent", meta);
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", writeCap.token, home), JSON.stringify(writeCap));
    await applySealCapabilityAction("write", REPO_ID, "agent", writeCap.token, meta, home);
    const expected = computeSealRecord(await computeSealInputs(meta));
    expect(await readSealRecordStrict(REPO_ID, "agent", home)).toEqual(expected);

    const deleteCap = await newSealCapability("delete", REPO_ID, "agent", undefined, expected);
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", deleteCap.token, home), JSON.stringify(deleteCap));
    await applySealCapabilityAction("delete", REPO_ID, "agent", deleteCap.token, undefined, home);
    expect(await readSealRecordStrict(REPO_ID, "agent", home)).toBeNull();
    await rm(home, { recursive: true, force: true });
  });

  test("verify capability is bound to normalized metadata and reports valid, missing, and mismatch", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: ["/expected"], allowWrite: [], deny: [] } };
    const changed = { ...meta, sandbox: { enabled: false } };
    await writeSealRecordDirect(REPO_ID, "agent", meta, home);

    const validCap = await newSealCapability("verify", REPO_ID, "agent", meta);
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", validCap.token, home), JSON.stringify(validCap));
    expect(await applySealCapabilityAction("verify", REPO_ID, "agent", validCap.token, meta, home)).toEqual({ ok: true });

    const changedCap = await newSealCapability("verify", REPO_ID, "agent", changed);
    await Bun.write(sealCapabilityPath(REPO_ID, "agent", changedCap.token, home), JSON.stringify(changedCap));
    expect(await applySealCapabilityAction("verify", REPO_ID, "agent", changedCap.token, changed, home)).toEqual({
      ok: false,
      field: "sandbox",
      reason: "sandbox does not match the sealed record",
    });

    const missingCap = await newSealCapability("verify", REPO_ID, "missing-agent", meta);
    await Bun.write(sealCapabilityPath(REPO_ID, "missing-agent", missingCap.token, home), JSON.stringify(missingCap));
    expect(await applySealCapabilityAction("verify", REPO_ID, "missing-agent", missingCap.token, meta, home)).toEqual({
      ok: false,
      field: "(missing)",
      reason: "no sealed record",
    });
    await rm(home, { recursive: true, force: true });
  });

  test("seal constructors and capability issuer reject traversal before filesystem mutation", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    const escaped = join(home, ".itsybitsy", "escaped-agent.json");

    expect(() => sealPath("../escaped", "agent", home)).toThrow("invalid seal repository id");
    expect(() => sealPath(REPO_ID, "../agent", home)).toThrow("invalid seal agent id");
    await expect(newSealCapability("write", "../escaped", "agent", meta)).rejects.toThrow("invalid seal repository id");
    await expect(writeSealRecordDirect("../escaped", "agent", meta, home)).rejects.toThrow("invalid seal repository id");
    expect(await Bun.file(escaped).exists()).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("strict trusted reads never mistake a corrupt record for absence", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    await mkdir(sealDir(home), { recursive: true });
    await Bun.write(sealPath(REPO_ID, "agent", home), "not json");
    await expect(readSealRecordStrict(REPO_ID, "agent", home)).rejects.toThrow();
    await rm(home, { recursive: true, force: true });
  });
});

import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { consumeSealCapability, newSealCapability, sealCapabilityPath, sealDir } from "./agent-seal";

describe("seal capabilities", () => {
  test("valid capability is one-use and rejects replay or wrong token", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const cap = await newSealCapability(meta);
    await Bun.write(sealCapabilityPath("repo", "agent", cap.token, home), JSON.stringify(cap));
    expect(await consumeSealCapability("repo", "agent", meta, "wrong", home)).toBe(false);
    expect(await consumeSealCapability("repo", "agent", meta, cap.token, home)).toBe(true);
    expect(await consumeSealCapability("repo", "agent", meta, cap.token, home)).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("expired capability is rejected", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const cap = await newSealCapability(meta);
    cap.expires = 0;
    await Bun.write(sealCapabilityPath("repo", "agent", cap.token, home), JSON.stringify(cap));
    expect(await consumeSealCapability("repo", "agent", meta, cap.token, home)).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("simultaneous same-token claims have one winner", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const cap = await newSealCapability(meta);
    await Bun.write(sealCapabilityPath("repo", "agent", cap.token, home), JSON.stringify(cap));
    const results = await Promise.all([
      consumeSealCapability("repo", "agent", meta, cap.token, home),
      consumeSealCapability("repo", "agent", meta, cap.token, home),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await rm(home, { recursive: true, force: true });
  });

  test("distinct token capabilities remain isolated", async () => {
    const home = `/tmp/seal-cap-${crypto.randomUUID()}`;
    const meta = { agentType: "worker", sandbox: { enabled: true }, paths: { allowRead: [], allowWrite: [], deny: [] } };
    await mkdir(sealDir(home), { recursive: true });
    const first = await newSealCapability(meta);
    const second = await newSealCapability(meta);
    await Bun.write(sealCapabilityPath("repo", "agent", first.token, home), JSON.stringify(first));
    await Bun.write(sealCapabilityPath("repo", "agent", second.token, home), JSON.stringify(second));
    expect(await consumeSealCapability("repo", "agent", meta, "00000000-0000-0000-0000-000000000000", home)).toBe(false);
    expect(await consumeSealCapability("repo", "agent", meta, second.token, home)).toBe(true);
    expect(await consumeSealCapability("repo", "agent", meta, first.token, home)).toBe(true);
    await rm(home, { recursive: true, force: true });
  });
});

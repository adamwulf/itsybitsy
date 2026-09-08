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
});

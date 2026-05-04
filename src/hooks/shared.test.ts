import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { realpathSync } from "fs";
import { resolveAgentFromCwd, SYSTEM_AGENT_ID } from "./shared";

describe("resolveAgentFromCwd — system coordinator identity", () => {
  let tempHome: string;
  let resolvedHome: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "shared-cwd-"));
    process.env.HOME = tempHome;
    // Pre-create ~/.itsybitsy/ so realpath resolves cleanly.
    await mkdir(join(tempHome, ".itsybitsy"), { recursive: true });
    resolvedHome = realpathSync(join(tempHome, ".itsybitsy"));
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("resolves to @system when cwd is the home itself", () => {
    const resolved = resolveAgentFromCwd(resolvedHome);
    expect(resolved).not.toBeNull();
    expect(resolved!.agentId).toBe(SYSTEM_AGENT_ID);
    expect(resolved!.agentDir).toBe(resolvedHome);
    expect(resolved!.syntheticMeta?.agentType).toBe("system");
    expect(resolved!.syntheticMeta?.worker).toBe(false);
  });

  test("resolves to @system when cwd is the .claude subdirectory", async () => {
    const subdir = join(resolvedHome, ".claude");
    await mkdir(subdir, { recursive: true });

    const resolved = resolveAgentFromCwd(subdir);
    expect(resolved).not.toBeNull();
    expect(resolved!.agentId).toBe(SYSTEM_AGENT_ID);
    expect(resolved!.agentDir).toBe(resolvedHome);
  });

  test("resolves to @system when cwd is the agent-types subdirectory", async () => {
    const subdir = join(resolvedHome, "agent-types");
    await mkdir(subdir, { recursive: true });

    const resolved = resolveAgentFromCwd(subdir);
    expect(resolved).not.toBeNull();
    expect(resolved!.agentId).toBe(SYSTEM_AGENT_ID);
    expect(resolved!.agentDir).toBe(resolvedHome);
  });

  test("resolves to @system when cwd is a deeply nested subdirectory", async () => {
    const nested = join(resolvedHome, "agent-types", "custom", "nested");
    await mkdir(nested, { recursive: true });

    const resolved = resolveAgentFromCwd(nested);
    expect(resolved).not.toBeNull();
    expect(resolved!.agentId).toBe(SYSTEM_AGENT_ID);
  });

  test("does NOT match a sibling directory whose name shares the prefix", async () => {
    // ~/.itsybitsy-other should not resolve to @system even though its path
    // starts with ~/.itsybitsy. The check uses `home + "/"` as the prefix.
    const sibling = join(tempHome, ".itsybitsy-other");
    await mkdir(sibling, { recursive: true });

    const resolved = resolveAgentFromCwd(sibling);
    expect(resolved).toBeNull();
  });

  test("returns null for an unrelated cwd", () => {
    const resolved = resolveAgentFromCwd("/tmp");
    expect(resolved).toBeNull();
  });
});

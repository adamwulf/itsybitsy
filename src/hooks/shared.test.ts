import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { realpathSync } from "fs";
import {
  resolveAgentFromCwd,
  SYSTEM_AGENT_ID,
  extractApplyPatchPaths,
  buildCodexAllowOutput,
  buildCodexDenyOutput,
} from "./shared";

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

describe("extractApplyPatchPaths", () => {
  test("returns empty list for empty input", () => {
    expect(extractApplyPatchPaths("")).toEqual([]);
  });

  test("extracts Add File path", () => {
    const body = [
      "*** Begin Patch",
      "*** Add File: src/hello.ts",
      "+console.log('hi');",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchPaths(body)).toEqual(["src/hello.ts"]);
  });

  test("extracts Update File path", () => {
    const body = "*** Begin Patch\n*** Update File: src/existing.ts\n*** End Patch\n";
    expect(extractApplyPatchPaths(body)).toEqual(["src/existing.ts"]);
  });

  test("extracts Delete File path", () => {
    const body = "*** Begin Patch\n*** Delete File: src/gone.ts\n*** End Patch\n";
    expect(extractApplyPatchPaths(body)).toEqual(["src/gone.ts"]);
  });

  test("extracts multiple paths in document order", () => {
    const body = [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+a",
      "*** Update File: b.ts",
      "*** Delete File: c.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchPaths(body)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("handles absolute paths (codex canonicalizes /tmp to /private/tmp)", () => {
    const body = "*** Begin Patch\n*** Add File: /private/tmp/escape.txt\n+I escaped\n*** End Patch\n";
    expect(extractApplyPatchPaths(body)).toEqual(["/private/tmp/escape.txt"]);
  });

  test("handles trailing whitespace on the path", () => {
    const body = "*** Add File:   src/spaces.ts   \n";
    expect(extractApplyPatchPaths(body)).toEqual(["src/spaces.ts"]);
  });

  test("ignores non-directive lines", () => {
    const body = [
      "Some intro text",
      "*** Begin Patch",
      "+++ b/foo",
      "*** Add File: real.ts",
      "extra commentary",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchPaths(body)).toEqual(["real.ts"]);
  });

  test("handles \\r\\n line endings", () => {
    const body = "*** Add File: src/win.ts\r\n*** Update File: src/win2.ts\r\n";
    expect(extractApplyPatchPaths(body)).toEqual(["src/win.ts", "src/win2.ts"]);
  });
});

describe("buildCodexDenyOutput", () => {
  test("emits well-formed JSON with reason", () => {
    const out = buildCodexDenyOutput("path outside worktree");
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("path outside worktree");
  });

  test("always includes permissionDecisionReason field", () => {
    const parsed = JSON.parse(buildCodexDenyOutput("x"));
    expect(Object.prototype.hasOwnProperty.call(parsed.hookSpecificOutput, "permissionDecisionReason")).toBe(true);
  });
});

describe("buildCodexAllowOutput", () => {
  test("echoes original tool_input verbatim in updatedInput", () => {
    const originalInput = { command: "ls -la", extra: "meta" };
    const out = buildCodexAllowOutput(originalInput);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(parsed.hookSpecificOutput.updatedInput).toEqual(originalInput);
  });

  test("preserves nested object structures", () => {
    const original = { command: "x", nested: { a: 1, b: [2, 3] } };
    const parsed = JSON.parse(buildCodexAllowOutput(original));
    expect(parsed.hookSpecificOutput.updatedInput).toEqual(original);
  });

  test("never emits a standalone allow without updatedInput", () => {
    const parsed = JSON.parse(buildCodexAllowOutput({}));
    expect(Object.prototype.hasOwnProperty.call(parsed.hookSpecificOutput, "updatedInput")).toBe(true);
  });
});

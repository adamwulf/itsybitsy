import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  hookAgyPreInvocation,
  hookAgyPreInvocationDryRun,
  AGY_HEARTBEAT_FILENAME,
} from "./agy-pre-invocation";

describe("hookAgyPreInvocation", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agy-preinv-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-inv01");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "agent-inv01", model: "agy:gemini-3.7-flash-low", claude_pid: "", state: "waiting" }),
    );
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function run(stdin: string): Promise<string> {
    let captured = "";
    await hookAgyPreInvocation("agent-inv01", {
      rawStdin: stdin,
      agentDirOverride: agentDir,
      write: (chunk: string) => { captured += chunk; return chunk.length; },
    });
    return captured;
  }

  test("outputs an empty-object no-op", async () => {
    const out = await run(JSON.stringify({ conversationId: "conv-1", invocationNum: 0 }));
    expect(JSON.parse(out)).toEqual({});
  });

  test("writes running state to meta.json", async () => {
    await run(JSON.stringify({ conversationId: "conv-1" }));
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.state).toBe("running");
  });

  test("captures agy_conversation_id (primary capture point)", async () => {
    await run(JSON.stringify({ conversationId: "conv-primary-42" }));
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.agy_conversation_id).toBe("conv-primary-42");
  });

  test("touches the liveness heartbeat marker", async () => {
    await run(JSON.stringify({ conversationId: "conv-1" }));
    const beat = Bun.file(join(agentDir, AGY_HEARTBEAT_FILENAME));
    expect(await beat.exists()).toBe(true);
  });

  test("still emits {} on malformed stdin (state write best-effort)", async () => {
    const out = await run("{not json");
    expect(JSON.parse(out)).toEqual({});
  });

  test("invalid agent id emits {} and does not throw", async () => {
    let captured = "";
    await hookAgyPreInvocation("bad id here", {
      rawStdin: "{}",
      write: (chunk: string) => { captured += chunk; return chunk.length; },
    });
    expect(JSON.parse(captured)).toEqual({});
  });

  test("skipMetaWrites leaves state and heartbeat untouched", async () => {
    await hookAgyPreInvocation("agent-inv01", {
      rawStdin: JSON.stringify({ conversationId: "conv-x" }),
      agentDirOverride: agentDir,
      skipMetaWrites: true,
      write: () => true,
    });
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.state).toBe("waiting");
    expect(meta.agy_conversation_id).toBeUndefined();
    expect(await Bun.file(join(agentDir, AGY_HEARTBEAT_FILENAME)).exists()).toBe(false);
  });
});

describe("hookAgyPreInvocationDryRun", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agy-preinv-dry-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-invdry");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-invdry", state: "waiting" }));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("succeeds when meta.json exists and leaves meta untouched", async () => {
    const origCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await hookAgyPreInvocationDryRun("agent-invdry");
    } finally {
      process.chdir(origCwd);
    }
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.state).toBe("waiting");
  });

  test("throws when meta.json is missing", async () => {
    const origCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await expect(hookAgyPreInvocationDryRun("agent-nope")).rejects.toThrow(/meta\.json not found/);
    } finally {
      process.chdir(origCwd);
    }
  });
});

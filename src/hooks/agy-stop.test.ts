import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  hookAgyStop,
  hookAgyStopDryRun,
  deriveAgyStopState,
  extractLastPlannerResponseText,
} from "./agy-stop";

// ── extractLastPlannerResponseText ───────────────────────────────────────────

describe("extractLastPlannerResponseText", () => {
  test("returns the last PLANNER_RESPONSE content (string form)", () => {
    const jsonl = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "hi" }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "first response" }),
      JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "I HAVE COMPLETED THE GOAL" }),
    ].join("\n");
    expect(extractLastPlannerResponseText(jsonl)).toBe("I HAVE COMPLETED THE GOAL");
  });

  test("skips the tail-most PLANNER_RESPONSE that has no content", () => {
    const jsonl = [
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "real answer" }),
      JSON.stringify({ type: "PLANNER_RESPONSE" }),
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "" }),
    ].join("\n");
    expect(extractLastPlannerResponseText(jsonl)).toBe("real answer");
  });

  test("extracts text from an array-of-parts content shape", () => {
    const jsonl = JSON.stringify({
      type: "PLANNER_RESPONSE",
      content: [{ text: "line one" }, "line two"],
    });
    expect(extractLastPlannerResponseText(jsonl)).toBe("line one\nline two");
  });

  test("skips malformed JSONL lines", () => {
    const jsonl = ["not json", JSON.stringify({ type: "PLANNER_RESPONSE", content: "ok" }), "{broken"].join("\n");
    expect(extractLastPlannerResponseText(jsonl)).toBe("ok");
  });

  test("returns undefined when there is no PLANNER_RESPONSE with content", () => {
    const jsonl = JSON.stringify({ type: "USER_INPUT", content: "hi" });
    expect(extractLastPlannerResponseText(jsonl)).toBeUndefined();
  });

  test("returns undefined for empty input", () => {
    expect(extractLastPlannerResponseText("")).toBeUndefined();
  });
});

// ── deriveAgyStopState ───────────────────────────────────────────────────────

describe("deriveAgyStopState", () => {
  test("undefined message → waiting", () => {
    expect(deriveAgyStopState(undefined)).toBe("waiting");
  });
  test("completion sentinel → complete", () => {
    expect(deriveAgyStopState("summary\nI HAVE COMPLETED THE GOAL")).toBe("complete");
  });
  test("WAITING sentinel → waiting", () => {
    expect(deriveAgyStopState("done for now\nWAITING")).toBe("waiting");
  });
  test("ordinary end-of-turn → waiting", () => {
    expect(deriveAgyStopState("here is the answer")).toBe("waiting");
  });
});

// ── hookAgyStop ──────────────────────────────────────────────────────────────

describe("hookAgyStop", () => {
  let tempDir: string;
  let agentDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agy-stop-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-stop01");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "agent-stop01", model: "agy:gemini-3.7-flash-low", claude_pid: "", state: "running" }),
    );
    transcriptPath = join(tempDir, "transcript.jsonl");
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function run(stdin: string, deps: Parameters<typeof hookAgyStop>[1] = {}): Promise<string> {
    let captured = "";
    await hookAgyStop("agent-stop01", {
      rawStdin: stdin,
      agentDirOverride: agentDir,
      write: (chunk: string) => { captured += chunk; return chunk.length; },
      ...deps,
    });
    return captured;
  }

  test("ordinary turn end writes waiting and emits {}", async () => {
    await writeFile(transcriptPath, JSON.stringify({ type: "PLANNER_RESPONSE", content: "the answer" }));
    const out = await run(JSON.stringify({ transcriptPath }));
    expect(JSON.parse(out)).toEqual({});
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.state).toBe("waiting");
  });

  test("completion sentinel with a clean tree writes complete and emits {}", async () => {
    await writeFile(transcriptPath, JSON.stringify({ type: "PLANNER_RESPONSE", content: "I HAVE COMPLETED THE GOAL" }));
    const out = await run(JSON.stringify({ transcriptPath }), { checkGitStatus: async () => "" });
    expect(JSON.parse(out)).toEqual({});
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.state).toBe("complete");
  });

  test("completion with uncommitted changes writes running back and returns the continue nudge", async () => {
    await writeFile(transcriptPath, JSON.stringify({ type: "PLANNER_RESPONSE", content: "I HAVE COMPLETED THE GOAL" }));
    const out = await run(JSON.stringify({ transcriptPath }), { checkGitStatus: async () => " M src/x.ts\n" });
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe("continue");
    expect(parsed.reason).toContain("uncommitted changes");
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.state).toBe("running");
  });

  test("missing transcript defaults to waiting", async () => {
    const out = await run(JSON.stringify({ transcriptPath: join(tempDir, "does-not-exist.jsonl") }));
    expect(JSON.parse(out)).toEqual({});
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.state).toBe("waiting");
  });

  test("logs a non-empty agy error field", async () => {
    await run(JSON.stringify({ transcriptPath, error: "backend 403" }), { readTranscript: async () => undefined });
    const log = await Bun.file(join(agentDir, "agent.log")).text();
    expect(log).toContain("agy reported error: backend 403");
  });

  test("malformed stdin still emits a valid no-op", async () => {
    const out = await run("{not json");
    expect(JSON.parse(out)).toEqual({});
  });

  test("invalid agent id emits {} without throwing", async () => {
    let captured = "";
    await hookAgyStop("bad id here", {
      rawStdin: "{}",
      write: (chunk: string) => { captured += chunk; return chunk.length; },
    });
    expect(JSON.parse(captured)).toEqual({});
  });
});

describe("hookAgyStopDryRun", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agy-stop-dry-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-stopdry");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-stopdry", state: "running" }));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("succeeds when meta.json exists and leaves meta untouched", async () => {
    const origCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await hookAgyStopDryRun("agent-stopdry");
    } finally {
      process.chdir(origCwd);
    }
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.state).toBe("running");
  });

  test("throws when meta.json is missing", async () => {
    const origCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await expect(hookAgyStopDryRun("agent-nope")).rejects.toThrow(/meta\.json not found/);
    } finally {
      process.chdir(origCwd);
    }
  });
});

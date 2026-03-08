import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { readConfig, writeConfig, CONFIG_KEYS } from "./config";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

let tmpDir: string;
let userCfgPath: string;

const opts = () => ({ userConfigPath: userCfgPath });

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "config-test-"));
  userCfgPath = join(tmpDir, "user-config.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("readConfig", () => {
  test("returns all defaults when no config files exist", async () => {
    const result = await readConfig(tmpDir, opts());

    expect(result["maxAgents"]).toEqual({ value: 10, source: "default" });
    expect(result["model"]).toEqual({ value: "sonnet", source: "default" });
    expect(result["fps"]).toEqual({ value: 10, source: "default" });
    expect(result["createPullRequests"]).toEqual({ value: false, source: "default" });
    expect(result["allowAgentQuestions"]).toEqual({ value: true, source: "default" });
    expect(result["autoCompactThreshold"]).toEqual({ value: undefined, source: "default" });
    expect(result["externalDiffTool"]).toEqual({ value: undefined, source: "default" });
    expect(result["hooks.injectStatus"]).toEqual({ value: true, source: "default" });
    expect(result["hooks.statusVisible"]).toEqual({ value: true, source: "default" });
    expect(result["permissions.manager.allow"]).toEqual({ value: [], source: "default" });
    expect(result["permissions.worker.deny"]).toEqual({ value: [], source: "default" });
  });

  test("has entries for all CONFIG_KEYS", async () => {
    const result = await readConfig(tmpDir, opts());
    for (const def of CONFIG_KEYS) {
      expect(result[def.key]).toBeDefined();
    }
  });

  test("reads project config values", async () => {
    const projectPath = join(tmpDir, ".ittybitty.json");
    await Bun.write(projectPath, JSON.stringify({ maxAgents: 5, model: "opus" }));

    const result = await readConfig(tmpDir, opts());
    expect(result["maxAgents"]).toEqual({ value: 5, source: "project" });
    expect(result["model"]).toEqual({ value: "opus", source: "project" });
    expect(result["fps"]).toEqual({ value: 10, source: "default" });
  });

  test("reads nested project config values", async () => {
    const projectPath = join(tmpDir, ".ittybitty.json");
    await Bun.write(
      projectPath,
      JSON.stringify({
        hooks: { injectStatus: false },
        permissions: { manager: { allow: ["Edit", "Read"] } },
      })
    );

    const result = await readConfig(tmpDir, opts());
    expect(result["hooks.injectStatus"]).toEqual({ value: false, source: "project" });
    expect(result["hooks.statusVisible"]).toEqual({ value: true, source: "default" });
    expect(result["permissions.manager.allow"]).toEqual({ value: ["Edit", "Read"], source: "project" });
    expect(result["permissions.manager.deny"]).toEqual({ value: [], source: "default" });
  });

  test("reads user config values when no project config", async () => {
    await Bun.write(userCfgPath, JSON.stringify({ model: "opus", fps: 5 }));

    const result = await readConfig(tmpDir, opts());
    expect(result["model"]).toEqual({ value: "opus", source: "user" });
    expect(result["fps"]).toEqual({ value: 5, source: "user" });
    expect(result["maxAgents"]).toEqual({ value: 10, source: "default" });
  });

  test("project config overrides user config", async () => {
    await Bun.write(userCfgPath, JSON.stringify({ maxAgents: 8, model: "opus" }));
    const projectPath = join(tmpDir, ".ittybitty.json");
    await Bun.write(projectPath, JSON.stringify({ maxAgents: 3 }));

    const result = await readConfig(tmpDir, opts());
    expect(result["maxAgents"]).toEqual({ value: 3, source: "project" });
    expect(result["model"]).toEqual({ value: "opus", source: "user" });
  });

  test("default arrays are independent across calls", async () => {
    const result1 = await readConfig(tmpDir, opts());
    const arr1 = result1["permissions.manager.allow"]!.value as string[];
    arr1.push("mutated");

    const result2 = await readConfig(tmpDir, opts());
    expect(result2["permissions.manager.allow"]!.value).toEqual([]);
  });

  test("handles malformed JSON gracefully", async () => {
    const projectPath = join(tmpDir, ".ittybitty.json");
    await Bun.write(projectPath, "not valid json {{{");

    const result = await readConfig(tmpDir, opts());
    expect(result["maxAgents"]).toEqual({ value: 10, source: "default" });
  });
});

describe("writeConfig", () => {
  test("creates new file with key-value", async () => {
    const filePath = join(tmpDir, "config.json");
    await writeConfig(filePath, "maxAgents", 20);

    const data = await Bun.file(filePath).json();
    expect(data.maxAgents).toBe(20);
  });

  test("preserves existing keys when writing", async () => {
    const filePath = join(tmpDir, "config.json");
    await Bun.write(filePath, JSON.stringify({ model: "opus", fps: 5 }));

    await writeConfig(filePath, "maxAgents", 20);

    const data = await Bun.file(filePath).json();
    expect(data.model).toBe("opus");
    expect(data.fps).toBe(5);
    expect(data.maxAgents).toBe(20);
  });

  test("overwrites existing key", async () => {
    const filePath = join(tmpDir, "config.json");
    await Bun.write(filePath, JSON.stringify({ maxAgents: 10 }));

    await writeConfig(filePath, "maxAgents", 25);

    const data = await Bun.file(filePath).json();
    expect(data.maxAgents).toBe(25);
  });

  test("writes with 2-space indent and trailing newline", async () => {
    const filePath = join(tmpDir, "config.json");
    await writeConfig(filePath, "model", "haiku");

    const text = await Bun.file(filePath).text();
    expect(text).toBe('{\n  "model": "haiku"\n}\n');
  });

  test("writes boolean values", async () => {
    const filePath = join(tmpDir, "config.json");
    await writeConfig(filePath, "createPullRequests", true);

    const data = await Bun.file(filePath).json();
    expect(data.createPullRequests).toBe(true);
  });

  test("writes array values", async () => {
    const filePath = join(tmpDir, "config.json");
    await writeConfig(filePath, "permissions.manager.allow", ["Edit", "Read"]);

    const data = await Bun.file(filePath).json();
    expect(data.permissions.manager.allow).toEqual(["Edit", "Read"]);
  });
});

describe("dot-notation key handling", () => {
  test("creates nested structure for dot-notation key", async () => {
    const filePath = join(tmpDir, "config.json");
    await writeConfig(filePath, "hooks.injectStatus", false);

    const data = await Bun.file(filePath).json();
    expect(data.hooks).toEqual({ injectStatus: false });
  });

  test("creates deeply nested structure", async () => {
    const filePath = join(tmpDir, "config.json");
    await writeConfig(filePath, "permissions.worker.deny", ["Bash"]);

    const data = await Bun.file(filePath).json();
    expect(data.permissions.worker.deny).toEqual(["Bash"]);
  });

  test("preserves sibling keys in nested objects", async () => {
    const filePath = join(tmpDir, "config.json");
    await Bun.write(
      filePath,
      JSON.stringify({
        hooks: { injectStatus: true, statusVisible: true },
      })
    );

    await writeConfig(filePath, "hooks.injectStatus", false);

    const data = await Bun.file(filePath).json();
    expect(data.hooks.injectStatus).toBe(false);
    expect(data.hooks.statusVisible).toBe(true);
  });

  test("writes multiple dot-notation keys sequentially", async () => {
    const filePath = join(tmpDir, "config.json");
    await writeConfig(filePath, "permissions.manager.allow", ["Edit"]);
    await writeConfig(filePath, "permissions.manager.deny", ["Bash"]);
    await writeConfig(filePath, "permissions.worker.allow", ["Read"]);

    const data = await Bun.file(filePath).json();
    expect(data.permissions.manager.allow).toEqual(["Edit"]);
    expect(data.permissions.manager.deny).toEqual(["Bash"]);
    expect(data.permissions.worker.allow).toEqual(["Read"]);
  });

  test("overwrites primitive with nested object when needed", async () => {
    const filePath = join(tmpDir, "config.json");
    await Bun.write(filePath, JSON.stringify({ hooks: "was-a-string" }));

    await writeConfig(filePath, "hooks.injectStatus", false);

    const data = await Bun.file(filePath).json();
    expect(data.hooks).toEqual({ injectStatus: false });
  });

  test("readConfig reads back what writeConfig wrote", async () => {
    const projectPath = join(tmpDir, ".ittybitty.json");
    await writeConfig(projectPath, "maxAgents", 7);
    await writeConfig(projectPath, "hooks.injectStatus", false);
    await writeConfig(projectPath, "permissions.worker.deny", ["Bash", "Write"]);

    const result = await readConfig(tmpDir, opts());
    expect(result["maxAgents"]).toEqual({ value: 7, source: "project" });
    expect(result["hooks.injectStatus"]).toEqual({ value: false, source: "project" });
    expect(result["permissions.worker.deny"]).toEqual({ value: ["Bash", "Write"], source: "project" });
  });
});

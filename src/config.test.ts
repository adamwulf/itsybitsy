import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { readConfig, writeConfig, CONFIG_KEYS, validateConfigValue } from "./config";
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
    const result = await readConfig(opts());

    expect(result["maxAgents"]).toEqual({ value: 10, source: "default" });
    expect(result["model"]).toEqual({ value: "opus", source: "default" });
    expect(result["createPullRequests"]).toEqual({ value: false, source: "default" });
    expect(result["allowAgentQuestions"]).toEqual({ value: true, source: "default" });
    expect(result["autoCompactThreshold"]).toEqual({ value: undefined, source: "default" });
    expect(result["externalDiffTool"]).toEqual({ value: undefined, source: "default" });
    expect(result["hooks.injectStatus"]).toEqual({ value: true, source: "default" });
    expect(result["hooks.statusVisible"]).toEqual({ value: true, source: "default" });
    expect(result["permissions.all.allow"]).toEqual({ value: [], source: "default" });
    expect(result["permissions.all.deny"]).toEqual({ value: [], source: "default" });
    expect(result["permissions.coordinator.allow"]).toEqual({ value: [], source: "default" });
    expect(result["permissions.coordinator.deny"]).toEqual({ value: [], source: "default" });
  });

  test("has entries for all CONFIG_KEYS", async () => {
    const result = await readConfig(opts());
    for (const def of CONFIG_KEYS) {
      expect(result[def.key]).toBeDefined();
    }
  });

  test("reads user config values", async () => {
    await Bun.write(userCfgPath, JSON.stringify({ model: "opus", maxAgents: 5 }));

    const result = await readConfig(opts());
    expect(result["model"]).toEqual({ value: "opus", source: "user" });
    expect(result["maxAgents"]).toEqual({ value: 5, source: "user" });
    expect(result["createPullRequests"]).toEqual({ value: false, source: "default" });
  });

  test("reads nested user config values", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({
        hooks: { injectStatus: false },
        permissions: { coordinator: { allow: ["Edit", "Read"] } },
      })
    );

    const result = await readConfig(opts());
    expect(result["hooks.injectStatus"]).toEqual({ value: false, source: "user" });
    expect(result["hooks.statusVisible"]).toEqual({ value: true, source: "default" });
    expect(result["permissions.coordinator.allow"]).toEqual({ value: ["Edit", "Read"], source: "user" });
    expect(result["permissions.coordinator.deny"]).toEqual({ value: [], source: "default" });
  });

  test("default arrays are independent across calls", async () => {
    const result1 = await readConfig(opts());
    const arr1 = result1["permissions.all.allow"]!.value as string[];
    arr1.push("mutated");

    const result2 = await readConfig(opts());
    expect(result2["permissions.all.allow"]!.value).toEqual([]);
  });

  test("handles malformed JSON gracefully", async () => {
    await Bun.write(userCfgPath, "not valid json {{{");

    const result = await readConfig(opts());
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
    await Bun.write(filePath, JSON.stringify({ model: "opus", createPullRequests: true }));

    await writeConfig(filePath, "maxAgents", 20);

    const data = await Bun.file(filePath).json();
    expect(data.model).toBe("opus");
    expect(data.createPullRequests).toBe(true);
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
    await writeConfig(filePath, "permissions.coordinator.allow", ["Edit", "Read"]);

    const data = await Bun.file(filePath).json();
    expect(data.permissions.coordinator.allow).toEqual(["Edit", "Read"]);
  });
});

describe("validateConfigValue", () => {
  test("validates number type", () => {
    expect(validateConfigValue(10, "number")).toBe(true);
    expect(validateConfigValue(0, "number")).toBe(true);
    expect(validateConfigValue("ten", "number")).toBe(false);
    expect(validateConfigValue(NaN, "number")).toBe(false);
    expect(validateConfigValue(true, "number")).toBe(false);
  });

  test("validates boolean type", () => {
    expect(validateConfigValue(true, "boolean")).toBe(true);
    expect(validateConfigValue(false, "boolean")).toBe(true);
    expect(validateConfigValue("yes", "boolean")).toBe(false);
    expect(validateConfigValue(1, "boolean")).toBe(false);
  });

  test("validates string type", () => {
    expect(validateConfigValue("opus", "string")).toBe(true);
    expect(validateConfigValue("", "string")).toBe(true);
    expect(validateConfigValue(123, "string")).toBe(false);
    expect(validateConfigValue(null, "string")).toBe(false);
  });

  test("validates string[] type", () => {
    expect(validateConfigValue(["Edit", "Read"], "string[]")).toBe(true);
    expect(validateConfigValue([], "string[]")).toBe(true);
    expect(validateConfigValue("not-an-array", "string[]")).toBe(false);
    expect(validateConfigValue([1, 2], "string[]")).toBe(false);
    expect(validateConfigValue(["ok", 3], "string[]")).toBe(false);
  });
});

describe("config type validation in readConfig", () => {
  test("maxAgents: string falls back to default", async () => {
    await Bun.write(userCfgPath, JSON.stringify({ maxAgents: "ten" }));

    const result = await readConfig(opts());
    expect(result["maxAgents"]).toEqual({ value: 10, source: "default" });
  });

  test("model: number falls back to default", async () => {
    await Bun.write(userCfgPath, JSON.stringify({ model: 123 }));

    const result = await readConfig(opts());
    expect(result["model"]).toEqual({ value: "opus", source: "default" });
  });

  test("createPullRequests: string falls back to default", async () => {
    await Bun.write(userCfgPath, JSON.stringify({ createPullRequests: "yes" }));

    const result = await readConfig(opts());
    expect(result["createPullRequests"]).toEqual({ value: false, source: "default" });
  });

  test("permissions.coordinator.allow: string falls back to default", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ permissions: { coordinator: { allow: "not-an-array" } } })
    );

    const result = await readConfig(opts());
    expect(result["permissions.coordinator.allow"]).toEqual({ value: [], source: "default" });
  });

  test("correctly typed values still work", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ maxAgents: 5, model: "opus", createPullRequests: true })
    );

    const result = await readConfig(opts());
    expect(result["maxAgents"]).toEqual({ value: 5, source: "user" });
    expect(result["model"]).toEqual({ value: "opus", source: "user" });
    expect(result["createPullRequests"]).toEqual({ value: true, source: "user" });
  });

  test("user config values with wrong types fall through to default", async () => {
    await Bun.write(userCfgPath, JSON.stringify({ maxAgents: "eight", model: 999 }));

    const result = await readConfig(opts());
    expect(result["maxAgents"]).toEqual({ value: 10, source: "default" });
    expect(result["model"]).toEqual({ value: "opus", source: "default" });
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
    await writeConfig(filePath, "permissions.repo.deny", ["Bash"]);

    const data = await Bun.file(filePath).json();
    expect(data.permissions.repo.deny).toEqual(["Bash"]);
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
    await writeConfig(filePath, "permissions.coordinator.allow", ["Edit"]);
    await writeConfig(filePath, "permissions.coordinator.deny", ["Bash"]);
    await writeConfig(filePath, "permissions.repo.allow", ["Read"]);

    const data = await Bun.file(filePath).json();
    expect(data.permissions.coordinator.allow).toEqual(["Edit"]);
    expect(data.permissions.coordinator.deny).toEqual(["Bash"]);
    expect(data.permissions.repo.allow).toEqual(["Read"]);
  });

  test("overwrites primitive with nested object when needed", async () => {
    const filePath = join(tmpDir, "config.json");
    await Bun.write(filePath, JSON.stringify({ hooks: "was-a-string" }));

    await writeConfig(filePath, "hooks.injectStatus", false);

    const data = await Bun.file(filePath).json();
    expect(data.hooks).toEqual({ injectStatus: false });
  });

  test("readConfig reads back what writeConfig wrote", async () => {
    await writeConfig(userCfgPath, "maxAgents", 7);
    await writeConfig(userCfgPath, "hooks.injectStatus", false);
    await writeConfig(userCfgPath, "permissions.repo.deny", ["Bash", "Write"]);

    const result = await readConfig(opts());
    expect(result["maxAgents"]).toEqual({ value: 7, source: "user" });
    expect(result["hooks.injectStatus"]).toEqual({ value: false, source: "user" });
    expect(result["permissions.repo.deny"]).toEqual({ value: ["Bash", "Write"], source: "user" });
  });
});

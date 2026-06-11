import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  readConfig,
  writeConfig,
  CONFIG_KEYS,
  validateConfigValue,
  checkDeprecatedConfigKeys,
  setUserConfigPath,
  resetUserConfigPath,
  ensureConfigFilePerms,
} from "./config";
import { join } from "path";
import { mkdtemp, rm, stat, chmod } from "fs/promises";
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

    expect(result["user.name"]).toEqual({ value: "", source: "default" });
    expect(result["maxAgents"]).toEqual({ value: 10, source: "default" });
    expect(result["model"]).toEqual({ value: "claude:opus", source: "default" });
    expect(result["createPullRequests"]).toEqual({ value: false, source: "default" });
    expect(result["allowAgentQuestions"]).toEqual({ value: true, source: "default" });
    expect(result["autoCompactThreshold"]).toEqual({ value: undefined, source: "default" });
    expect(result["externalDiffTool"]).toEqual({ value: undefined, source: "default" });
    expect(result["hooks.injectStatus"]).toEqual({ value: true, source: "default" });
    expect(result["hooks.statusVisible"]).toEqual({ value: true, source: "default" });
    // Permission list keys have all been removed from CONFIG_KEYS; they now live in
    // ~/.itsybitsy/agent-types/*.md frontmatter (coordinator.md, _all.md, _non_coordinator.md).
    expect(result["permissions.all.allow"]).toBeUndefined();
    expect(result["permissions.all.deny"]).toBeUndefined();
    expect(result["permissions.repo.allow"]).toBeUndefined();
    expect(result["permissions.repo.deny"]).toBeUndefined();
    expect(result["permissions.coordinator.allow"]).toBeUndefined();
    expect(result["permissions.coordinator.deny"]).toBeUndefined();
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
      })
    );

    const result = await readConfig(opts());
    expect(result["hooks.injectStatus"]).toEqual({ value: false, source: "user" });
    expect(result["hooks.statusVisible"]).toEqual({ value: true, source: "default" });
  });

  test("default arrays are independent across calls", async () => {
    // `autoCompactThreshold` is one of the few remaining default values that's
    // a non-primitive (undefined) — we just re-read twice to confirm repeated
    // reads return independent copies for any keys we may add later.
    const result1 = await readConfig(opts());
    const result2 = await readConfig(opts());
    expect(result1["maxAgents"]).toEqual(result2["maxAgents"]);
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
    await writeConfig(filePath, "permissions.repo.allow", ["Edit", "Read"]);

    const data = await Bun.file(filePath).json();
    expect(data.permissions.repo.allow).toEqual(["Edit", "Read"]);
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
    expect(result["model"]).toEqual({ value: "claude:opus", source: "default" });
  });

  test("createPullRequests: string falls back to default", async () => {
    await Bun.write(userCfgPath, JSON.stringify({ createPullRequests: "yes" }));

    const result = await readConfig(opts());
    expect(result["createPullRequests"]).toEqual({ value: false, source: "default" });
  });

  test("permissions.repo.allow key is not in CONFIG_KEYS", async () => {
    // permissions.repo.* keys have been removed from CONFIG_KEYS — they now
    // live in ~/.itsybitsy/agent-types/_non_coordinator.md frontmatter.
    await Bun.write(
      userCfgPath,
      JSON.stringify({ permissions: { repo: { allow: ["anything"] } } })
    );

    const result = await readConfig(opts());
    expect(result["permissions.repo.allow"]).toBeUndefined();
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
    expect(result["model"]).toEqual({ value: "claude:opus", source: "default" });
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
    await writeConfig(filePath, "permissions.all.allow", ["Edit"]);
    await writeConfig(filePath, "permissions.all.deny", ["Bash"]);
    await writeConfig(filePath, "permissions.repo.allow", ["Read"]);

    const data = await Bun.file(filePath).json();
    expect(data.permissions.all.allow).toEqual(["Edit"]);
    expect(data.permissions.all.deny).toEqual(["Bash"]);
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

    const result = await readConfig(opts());
    expect(result["maxAgents"]).toEqual({ value: 7, source: "user" });
    expect(result["hooks.injectStatus"]).toEqual({ value: false, source: "user" });
  });
});

describe("checkDeprecatedConfigKeys", () => {
  beforeEach(() => {
    setUserConfigPath(userCfgPath);
  });

  afterEach(() => {
    resetUserConfigPath();
  });

  test("returns empty when no deprecated keys are set", async () => {
    await Bun.write(userCfgPath, JSON.stringify({ model: "opus" }));
    const warnings = await checkDeprecatedConfigKeys();
    expect(warnings).toEqual([]);
  });

  test("warns when permissions.coordinator.allow is set", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ permissions: { coordinator: { allow: ["Bash(*)"] } } })
    );
    const warnings = await checkDeprecatedConfigKeys();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("permissions.coordinator.allow");
    expect(warnings[0]).toContain("coordinator.md");
  });

  test("warns when permissions.coordinator.deny is set", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ permissions: { coordinator: { deny: ["Write"] } } })
    );
    const warnings = await checkDeprecatedConfigKeys();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("permissions.coordinator.deny");
    expect(warnings[0]).toContain("coordinator.md");
  });

  test("warns when coordinator.model is set and points to coordinator.md", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ coordinator: { model: "claude:sonnet" } })
    );
    const warnings = await checkDeprecatedConfigKeys();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("coordinator.model");
    expect(warnings[0]).toContain("coordinator.md");
  });

  test("warns for both coordinator and legacy manager/worker keys", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({
        permissions: {
          coordinator: { allow: ["Read"], deny: ["Write"] },
          manager: { allow: ["Bash"] },
          worker: { deny: ["Edit"] },
        },
      })
    );
    const warnings = await checkDeprecatedConfigKeys();
    expect(warnings.length).toBe(4);
    expect(warnings.some((w) => w.includes("permissions.coordinator.allow"))).toBe(true);
    expect(warnings.some((w) => w.includes("permissions.coordinator.deny"))).toBe(true);
    expect(warnings.some((w) => w.includes("permissions.manager.allow"))).toBe(true);
    expect(warnings.some((w) => w.includes("permissions.worker.deny"))).toBe(true);
  });

  test("warns when permissions.all.allow is set and points to _all.md", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ permissions: { all: { allow: ["Read"] } } })
    );
    const warnings = await checkDeprecatedConfigKeys();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("permissions.all.allow");
    expect(warnings[0]).toContain("_all.md");
  });

  test("warns when permissions.all.deny is set and points to _all.md", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ permissions: { all: { deny: ["Bash"] } } })
    );
    const warnings = await checkDeprecatedConfigKeys();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("permissions.all.deny");
    expect(warnings[0]).toContain("_all.md");
  });

  test("warns when permissions.repo.allow is set and points to _non_coordinator.md", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ permissions: { repo: { allow: ["Edit"] } } })
    );
    const warnings = await checkDeprecatedConfigKeys();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("permissions.repo.allow");
    expect(warnings[0]).toContain("_non_coordinator.md");
  });

  test("warns when permissions.repo.deny is set and points to _non_coordinator.md", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ permissions: { repo: { deny: ["Write"] } } })
    );
    const warnings = await checkDeprecatedConfigKeys();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("permissions.repo.deny");
    expect(warnings[0]).toContain("_non_coordinator.md");
  });

  test("CONFIG_KEYS does not include the newly deprecated permission list keys", () => {
    const keys = CONFIG_KEYS.map((def) => def.key);
    expect(keys).not.toContain("permissions.all.allow");
    expect(keys).not.toContain("permissions.all.deny");
    expect(keys).not.toContain("permissions.repo.allow");
    expect(keys).not.toContain("permissions.repo.deny");
  });
});

describe("channels.telegram config keys", () => {
  test("CONFIG_KEYS contains channels.telegram.bot_token and no chat_id", () => {
    const keys = CONFIG_KEYS.map((def) => def.key);
    expect(keys).toContain("channels.telegram.bot_token");
    expect(keys).not.toContain("channels.telegram.chat_id");
  });

  test("default value is empty string", async () => {
    const result = await readConfig(opts());
    expect(result["channels.telegram.bot_token"]).toEqual({ value: "", source: "default" });
  });

  test("reads user-supplied bot_token", async () => {
    await Bun.write(
      userCfgPath,
      JSON.stringify({ channels: { telegram: { bot_token: "abc:xyz" } } })
    );
    const result = await readConfig(opts());
    expect(result["channels.telegram.bot_token"]).toEqual({ value: "abc:xyz", source: "user" });
  });
});

describe("ensureConfigFilePerms / writeConfig 0600 enforcement", () => {
  test("writeConfig leaves the file at mode 0600 for a fresh file", async () => {
    const filePath = join(tmpDir, "perms-fresh.json");
    await writeConfig(filePath, "channels.telegram.bot_token", "secret");
    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("writeConfig tightens looser perms (0644 → 0600)", async () => {
    const filePath = join(tmpDir, "perms-loose.json");
    await Bun.write(filePath, JSON.stringify({}));
    await chmod(filePath, 0o644);
    let st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o644);

    await writeConfig(filePath, "channels.telegram.bot_token", "secret");
    st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("ensureConfigFilePerms is a no-op when the file is missing", async () => {
    // No throw, no file created.
    await ensureConfigFilePerms(join(tmpDir, "does-not-exist.json"));
  });

  test("ensureConfigFilePerms tightens existing looser perms", async () => {
    const filePath = join(tmpDir, "perms-existing.json");
    await Bun.write(filePath, "{}");
    await chmod(filePath, 0o666);
    await ensureConfigFilePerms(filePath);
    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("ensureConfigFilePerms is a no-op when perms are already 0600", async () => {
    const filePath = join(tmpDir, "perms-already.json");
    await Bun.write(filePath, "{}");
    await chmod(filePath, 0o600);
    await ensureConfigFilePerms(filePath);
    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

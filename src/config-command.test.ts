import { test, expect, beforeEach, afterEach, describe, spyOn } from "bun:test";
import { runConfigCommand } from "./config-command";
import { setUserConfigPath, resetUserConfigPath, CONFIG_KEYS } from "./config";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";

let tmpDir: string;
let cfgDir: string;
let cfgPath: string;

let exitSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "config-cmd-test-"));
  cfgDir = join(tmpDir, ".itsybitsy");
  cfgPath = join(cfgDir, "config.json");
  await mkdir(cfgDir, { recursive: true });
  setUserConfigPath(cfgPath);

  exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("EXIT");
  });
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  resetUserConfigPath();
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  await rm(tmpDir, { recursive: true, force: true });
});

function logged(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

function errored(): string {
  return errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

// ── help ──

describe("config help", () => {
  test("no subcommand shows help", async () => {
    await runConfigCommand([]);
    expect(logged()).toContain("ib config");
    expect(logged()).toContain("Subcommands:");
  });

  test("help subcommand shows help", async () => {
    await runConfigCommand(["help"]);
    expect(logged()).toContain("ib config");
  });

  test("-h shows help", async () => {
    await runConfigCommand(["-h"]);
    expect(logged()).toContain("ib config");
  });

  test("--help shows help", async () => {
    await runConfigCommand(["--help"]);
    expect(logged()).toContain("ib config");
  });
});

// ── unknown subcommand ──

describe("unknown subcommand", () => {
  test("exits with error", async () => {
    await expect(runConfigCommand(["bogus"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("Unknown subcommand 'bogus'");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── list ──

describe("config list", () => {
  test("lists all keys with defaults", async () => {
    await runConfigCommand(["list"]);
    const output = logged();
    expect(output).toContain("maxAgents = 10 (default)");
    expect(output).toContain("model = opus (default)");
    expect(output).toContain("autoCompactThreshold = (unset)");
    expect(output).toContain("permissions.repo.allow = [] (default)");
    // permissions.coordinator.* keys have been removed from CONFIG_KEYS;
    // coordinator permissions now live in ~/.itsybitsy/agent-types/coordinator.md.
    expect(output).not.toContain("permissions.coordinator.allow");
    // Legend line
    expect(output).toContain("Sources:");
  });

  test("ls alias works", async () => {
    await runConfigCommand(["ls"]);
    expect(logged()).toContain("maxAgents");
  });

  test("shows user values", async () => {
    await Bun.write(cfgPath, JSON.stringify({ model: "sonnet", maxAgents: 5 }));
    await runConfigCommand(["list"]);
    const output = logged();
    expect(output).toContain("model = sonnet (user)");
    expect(output).toContain("maxAgents = 5 (user)");
    expect(output).toContain("createPullRequests = false (default)");
  });

  test("lists all CONFIG_KEYS entries", async () => {
    await runConfigCommand(["list"]);
    const output = logged();
    for (const def of CONFIG_KEYS) {
      expect(output).toContain(def.key);
    }
  });
});

// ── get ──

describe("config get", () => {
  test("gets default value", async () => {
    await runConfigCommand(["get", "maxAgents"]);
    expect(logged()).toBe("10");
  });

  test("gets user value", async () => {
    await Bun.write(cfgPath, JSON.stringify({ maxAgents: 42 }));
    await runConfigCommand(["get", "maxAgents"]);
    expect(logged()).toBe("42");
  });

  test("gets string value", async () => {
    await Bun.write(cfgPath, JSON.stringify({ model: "sonnet" }));
    await runConfigCommand(["get", "model"]);
    expect(logged()).toBe("sonnet");
  });

  test("gets boolean value", async () => {
    await runConfigCommand(["get", "createPullRequests"]);
    expect(logged()).toBe("false");
  });

  test("gets array value as JSON", async () => {
    await Bun.write(cfgPath, JSON.stringify({ permissions: { repo: { allow: ["Bash(*)"] } } }));
    await runConfigCommand(["get", "permissions.repo.allow"]);
    expect(logged()).toBe('["Bash(*)"]');
  });

  test("gets empty array default", async () => {
    await runConfigCommand(["get", "permissions.repo.deny"]);
    expect(logged()).toBe("[]");
  });

  test("unset key prints empty string", async () => {
    await runConfigCommand(["get", "autoCompactThreshold"]);
    expect(logged()).toBe("");
  });

  test("missing key argument exits with error", async () => {
    await expect(runConfigCommand(["get"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("key required");
    expect(errored()).toContain("Available keys:");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("unknown key exits with error", async () => {
    await expect(runConfigCommand(["get", "nonexistent"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("Unknown config key: 'nonexistent'");
    expect(errored()).toContain("Available keys:");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── set ──

describe("config set", () => {
  test("sets number value", async () => {
    await runConfigCommand(["set", "maxAgents", "5"]);
    expect(logged()).toBe("Set maxAgents = 5");
    const data = await Bun.file(cfgPath).json();
    expect(data.maxAgents).toBe(5);
  });

  test("sets boolean true", async () => {
    await runConfigCommand(["set", "createPullRequests", "true"]);
    expect(logged()).toBe("Set createPullRequests = true");
    const data = await Bun.file(cfgPath).json();
    expect(data.createPullRequests).toBe(true);
  });

  test("sets boolean false", async () => {
    await runConfigCommand(["set", "createPullRequests", "false"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.createPullRequests).toBe(false);
  });

  test("sets string value", async () => {
    await runConfigCommand(["set", "model", "sonnet"]);
    expect(logged()).toBe("Set model = sonnet");
    const data = await Bun.file(cfgPath).json();
    expect(data.model).toBe("sonnet");
  });

  test("sets nested key", async () => {
    await runConfigCommand(["set", "hooks.injectStatus", "false"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.hooks.injectStatus).toBe(false);
  });

  test("creates config file and directory", async () => {
    const newDir = join(tmpDir, "new", ".itsybitsy");
    const newPath = join(newDir, "config.json");
    setUserConfigPath(newPath);
    await runConfigCommand(["set", "maxAgents", "3"]);
    const data = await Bun.file(newPath).json();
    expect(data.maxAgents).toBe(3);
  });

  test("preserves existing config values", async () => {
    await Bun.write(cfgPath, JSON.stringify({ model: "opus" }));
    await runConfigCommand(["set", "maxAgents", "7"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.model).toBe("opus");
    expect(data.maxAgents).toBe(7);
  });

  test("rejects invalid number", async () => {
    await expect(runConfigCommand(["set", "maxAgents", "abc"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("'maxAgents' must be a number, got 'abc'");
  });

  test("rejects negative number", async () => {
    await expect(runConfigCommand(["set", "maxAgents", "-1"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("'maxAgents' must be a number, got '-1'");
  });

  test("rejects float number", async () => {
    await expect(runConfigCommand(["set", "maxAgents", "3.5"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("'maxAgents' must be a number, got '3.5'");
  });

  test("rejects invalid boolean", async () => {
    await expect(runConfigCommand(["set", "createPullRequests", "yes"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("'createPullRequests' must be true or false, got 'yes'");
  });

  test("rejects invalid model", async () => {
    await expect(runConfigCommand(["set", "model", "gpt4"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("'model' must be one of: sonnet, opus, haiku");
  });

  test("rejects array key", async () => {
    await expect(runConfigCommand(["set", "permissions.repo.allow", "foo"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("array key");
    expect(errored()).toContain("ib config add");
  });

  test("rejects deprecated permissions.coordinator.allow as unknown key", async () => {
    await expect(runConfigCommand(["set", "permissions.coordinator.allow", "foo"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("Unknown config key: 'permissions.coordinator.allow'");
  });

  test("rejects unknown key", async () => {
    await expect(runConfigCommand(["set", "unknown", "val"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("Unknown config key: 'unknown'");
  });

  test("missing key and value exits with error", async () => {
    await expect(runConfigCommand(["set"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("key and value required");
  });

  test("missing value exits with error", async () => {
    await expect(runConfigCommand(["set", "maxAgents"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("key and value required");
  });
});

// ── add ──

describe("config add", () => {
  test("adds value to array", async () => {
    await runConfigCommand(["add", "permissions.repo.allow", "Bash(*)"]);
    expect(logged()).toBe("Added 'Bash(*)' to permissions.repo.allow");
    const data = await Bun.file(cfgPath).json();
    expect(data.permissions.repo.allow).toEqual(["Bash(*)"]);
  });

  test("adds to existing array", async () => {
    await Bun.write(cfgPath, JSON.stringify({ permissions: { repo: { allow: ["Read"] } } }));
    await runConfigCommand(["add", "permissions.repo.allow", "Write"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.permissions.repo.allow).toEqual(["Read", "Write"]);
  });

  test("prevents duplicates", async () => {
    await Bun.write(cfgPath, JSON.stringify({ permissions: { repo: { allow: ["Bash(*)"] } } }));
    await runConfigCommand(["add", "permissions.repo.allow", "Bash(*)"]);
    expect(logged()).toBe("Value 'Bash(*)' already exists in permissions.repo.allow");
    const data = await Bun.file(cfgPath).json();
    expect(data.permissions.repo.allow).toEqual(["Bash(*)"]);
  });

  test("creates config file", async () => {
    const newPath = join(tmpDir, "new2", ".itsybitsy", "config.json");
    setUserConfigPath(newPath);
    await runConfigCommand(["add", "permissions.repo.deny", "Edit"]);
    const data = await Bun.file(newPath).json();
    expect(data.permissions.repo.deny).toEqual(["Edit"]);
  });

  test("rejects non-array key", async () => {
    await expect(runConfigCommand(["add", "model", "opus"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("not an array key");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("missing key and value exits with error", async () => {
    await expect(runConfigCommand(["add"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("key and value required");
  });

  test("missing value exits with error", async () => {
    await expect(runConfigCommand(["add", "permissions.repo.allow"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("key and value required");
  });

  test("works with all array keys", async () => {
    for (const key of [
      "permissions.all.allow",
      "permissions.all.deny",
      "permissions.repo.allow",
      "permissions.repo.deny",
    ]) {
      logSpy.mockClear();
      await runConfigCommand(["add", key, "TestTool"]);
      expect(logged()).toContain(`Added 'TestTool' to ${key}`);
    }
  });

  test("rejects deprecated permissions.coordinator.allow as non-array key", async () => {
    await expect(runConfigCommand(["add", "permissions.coordinator.allow", "Bash(*)"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("'permissions.coordinator.allow' is not an array key.");
    expect(errored()).not.toContain("permissions.coordinator.allow,");
    expect(errored()).not.toContain(", permissions.coordinator.allow");
  });
});

// ── remove ──

describe("config remove", () => {
  test("removes value from array", async () => {
    await Bun.write(cfgPath, JSON.stringify({ permissions: { repo: { deny: ["Bash(*)", "Edit"] } } }));
    await runConfigCommand(["remove", "permissions.repo.deny", "Bash(*)"]);
    expect(logged()).toBe("Removed 'Bash(*)' from permissions.repo.deny");
    const data = await Bun.file(cfgPath).json();
    expect(data.permissions.repo.deny).toEqual(["Edit"]);
  });

  test("missing value prints message and succeeds", async () => {
    await Bun.write(cfgPath, JSON.stringify({ permissions: { repo: { deny: ["Edit"] } } }));
    await runConfigCommand(["remove", "permissions.repo.deny", "Bash(*)"]);
    expect(logged()).toBe("Value 'Bash(*)' not found in permissions.repo.deny");
  });

  test("config file not found exits with error", async () => {
    const missingPath = join(tmpDir, "missing", "config.json");
    setUserConfigPath(missingPath);
    await expect(runConfigCommand(["remove", "permissions.repo.allow", "X"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("Config file not found");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("rejects non-array key", async () => {
    await expect(runConfigCommand(["remove", "model", "opus"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("not an array key");
  });

  test("missing arguments exits with error", async () => {
    await expect(runConfigCommand(["remove"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("key and value required");
  });

  test("removes from empty array (not in array)", async () => {
    await Bun.write(cfgPath, JSON.stringify({}));
    await runConfigCommand(["remove", "permissions.repo.allow", "X"]);
    expect(logged()).toBe("Value 'X' not found in permissions.repo.allow");
  });
});

// ── unset ──

describe("config unset", () => {
  test("unsets an existing key", async () => {
    await Bun.write(cfgPath, JSON.stringify({ model: "sonnet", maxAgents: 5 }));
    await runConfigCommand(["unset", "model"]);
    expect(logged()).toBe("Unset model (reverted to default)");
    const data = await Bun.file(cfgPath).json();
    expect(data.model).toBeUndefined();
    expect(data.maxAgents).toBe(5);
  });

  test("unsets nested key", async () => {
    await Bun.write(cfgPath, JSON.stringify({ hooks: { injectStatus: false, statusVisible: true } }));
    await runConfigCommand(["unset", "hooks.injectStatus"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.hooks.injectStatus).toBeUndefined();
    expect(data.hooks.statusVisible).toBe(true);
  });

  test("unsets array key", async () => {
    await Bun.write(cfgPath, JSON.stringify({ permissions: { repo: { allow: ["Bash(*)"] } } }));
    await runConfigCommand(["unset", "permissions.repo.allow"]);
    expect(logged()).toBe("Unset permissions.repo.allow (reverted to default)");
    const data = await Bun.file(cfgPath).json();
    expect(data.permissions.repo.allow).toBeUndefined();
  });

  test("key not set prints message", async () => {
    await Bun.write(cfgPath, JSON.stringify({}));
    await runConfigCommand(["unset", "model"]);
    expect(logged()).toBe("Key 'model' is not set");
  });

  test("config file not found exits with error", async () => {
    const missingPath = join(tmpDir, "missing", "config.json");
    setUserConfigPath(missingPath);
    await expect(runConfigCommand(["unset", "model"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("Config file not found");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("unknown key exits with error", async () => {
    await Bun.write(cfgPath, JSON.stringify({}));
    await expect(runConfigCommand(["unset", "bogus"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("Unknown config key: 'bogus'");
  });

  test("missing key exits with error", async () => {
    await expect(runConfigCommand(["unset"])).rejects.toThrow("EXIT");
    expect(errored()).toContain("key required");
  });
});

// ── edge cases ──

describe("edge cases", () => {
  test("set number zero", async () => {
    await runConfigCommand(["set", "maxAgents", "0"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.maxAgents).toBe(0);
  });

  test("set externalDiffTool (string with no model validation)", async () => {
    await runConfigCommand(["set", "externalDiffTool", "delta"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.externalDiffTool).toBe("delta");
  });

  test("add then remove leaves empty array", async () => {
    await runConfigCommand(["add", "permissions.repo.allow", "Bash(*)"]);
    logSpy.mockClear();
    await runConfigCommand(["remove", "permissions.repo.allow", "Bash(*)"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.permissions.repo.allow).toEqual([]);
  });

  test("set overwrites previous value", async () => {
    await runConfigCommand(["set", "maxAgents", "5"]);
    logSpy.mockClear();
    await runConfigCommand(["set", "maxAgents", "10"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.maxAgents).toBe(10);
  });

  test("set all valid models", async () => {
    for (const model of ["sonnet", "opus", "haiku"]) {
      logSpy.mockClear();
      await runConfigCommand(["set", "model", model]);
      expect(logged()).toBe(`Set model = ${model}`);
    }
  });

  test("set autoCompactThreshold", async () => {
    await runConfigCommand(["set", "autoCompactThreshold", "80"]);
    const data = await Bun.file(cfgPath).json();
    expect(data.autoCompactThreshold).toBe(80);
  });
});

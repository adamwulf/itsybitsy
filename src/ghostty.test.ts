import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { openInGhostty } from "./ghostty";

describe("openInGhostty", () => {
  let originalWhich: typeof Bun.which;
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalWhich = Bun.which;
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.which = originalWhich;
    Bun.spawn = originalSpawn;
  });

  describe("session name validation", () => {
    test("rejects session name with spaces", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      const result = await openInGhostty("bad session");
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("rejects session name with semicolons", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      const result = await openInGhostty("session;rm -rf /");
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("rejects session name with quotes", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      const result = await openInGhostty('session"name');
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("rejects session name with backticks", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      const result = await openInGhostty("session`whoami`");
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("rejects empty session name", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      const result = await openInGhostty("");
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("accepts alphanumeric session name", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      let spawnArgs: any[] = [];
      Bun.spawn = ((...args: any[]) => {
        spawnArgs = args;
        return { unref: () => {} };
      }) as any;
      const result = await openInGhostty("agent123");
      expect(result.ok).toBe(true);
    });

    test("accepts session name with hyphens and underscores", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      Bun.spawn = ((...args: any[]) => ({ unref: () => {} })) as any;
      const result = await openInGhostty("agent-abc_123");
      expect(result.ok).toBe(true);
    });
  });

  describe("Ghostty availability check", () => {
    test("returns error when ghostty is not found on PATH", async () => {
      Bun.which = (() => null) as any;
      const result = await openInGhostty("my-session");
      expect(result).toEqual({ ok: false, message: "Ghostty not found on PATH" });
    });

    test("does not spawn when ghostty is not found", async () => {
      Bun.which = (() => null) as any;
      let spawned = false;
      Bun.spawn = ((...args: any[]) => {
        spawned = true;
        return { unref: () => {} };
      }) as any;
      await openInGhostty("my-session");
      expect(spawned).toBe(false);
    });
  });

  describe("spawn behavior", () => {
    test("spawns ghostty with correct command args", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      let spawnArgs: any[] = [];
      Bun.spawn = ((...args: any[]) => {
        spawnArgs = args;
        return { unref: () => {} };
      }) as any;

      await openInGhostty("test-session");

      const cmdArray = spawnArgs[0] as string[];
      expect(cmdArray[0]).toBe("ghostty");
      expect(cmdArray[1]).toContain("tmux attach -t test-session");
      expect(cmdArray[1]).toContain("tmux set-option -t test-session window-size latest");
    });

    test("spawns with stdio ignored", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      let spawnOpts: any = null;
      Bun.spawn = ((...args: any[]) => {
        spawnOpts = args[1];
        return { unref: () => {} };
      }) as any;

      await openInGhostty("test-session");

      expect(spawnOpts.stdio).toEqual(["ignore", "ignore", "ignore"]);
    });

    test("calls unref on spawned process", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      let unrefCalled = false;
      Bun.spawn = ((...args: any[]) => ({
        unref: () => { unrefCalled = true; },
      })) as any;

      await openInGhostty("test-session");

      expect(unrefCalled).toBe(true);
    });

    test("returns success result on successful spawn", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      Bun.spawn = ((...args: any[]) => ({ unref: () => {} })) as any;

      const result = await openInGhostty("test-session");

      expect(result).toEqual({ ok: true, message: "Opened in Ghostty" });
    });

    test("returns error result when spawn throws", async () => {
      Bun.which = (() => "/usr/bin/ghostty") as any;
      Bun.spawn = ((...args: any[]) => {
        throw new Error("spawn failed");
      }) as any;

      const result = await openInGhostty("test-session");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("spawn failed");
    });
  });
});

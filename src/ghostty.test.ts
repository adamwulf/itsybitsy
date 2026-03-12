import { test, expect, describe, afterEach } from "bun:test";
import { openInGhostty, openPathInGhostty, whichCtx, spawnCtx } from "./ghostty";

describe("openInGhostty", () => {
  afterEach(() => {
    whichCtx.reset();
    spawnCtx.reset();
  });

  describe("session name validation", () => {
    test("rejects session name with spaces", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      const result = await openInGhostty("bad session");
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("rejects session name with semicolons", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      const result = await openInGhostty("session;rm -rf /");
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("rejects session name with quotes", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      const result = await openInGhostty('session"name');
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("rejects session name with backticks", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      const result = await openInGhostty("session`whoami`");
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("rejects empty session name", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      const result = await openInGhostty("");
      expect(result).toEqual({ ok: false, message: "Invalid tmux session name" });
    });

    test("accepts alphanumeric session name", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      spawnCtx.set((...args: any[]) => ({ unref: () => {} }));
      const result = await openInGhostty("agent123");
      expect(result.ok).toBe(true);
    });

    test("accepts session name with hyphens and underscores", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      spawnCtx.set((...args: any[]) => ({ unref: () => {} }));
      const result = await openInGhostty("agent-abc_123");
      expect(result.ok).toBe(true);
    });
  });

  describe("Ghostty availability check", () => {
    test("returns error when ghostty is not found on PATH", async () => {
      whichCtx.set(() => null);
      const result = await openInGhostty("my-session");
      expect(result).toEqual({ ok: false, message: "Ghostty not found on PATH" });
    });

    test("does not spawn when ghostty is not found", async () => {
      whichCtx.set(() => null);
      let spawned = false;
      spawnCtx.set((...args: any[]) => {
        spawned = true;
        return { unref: () => {} };
      });
      await openInGhostty("my-session");
      expect(spawned).toBe(false);
    });
  });

  describe("spawn behavior", () => {
    test("spawns ghostty with correct command args", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      let spawnArgs: any[] = [];
      spawnCtx.set((...args: any[]) => {
        spawnArgs = args;
        return { unref: () => {} };
      });

      await openInGhostty("test-session");

      const cmdArray = spawnArgs[0] as string[];
      expect(cmdArray[0]).toBe("ghostty");
      expect(cmdArray[1]).toBe("--command");
      expect(cmdArray[2]).toBe("bash");
      expect(cmdArray[3]).toBe("-c");
      // Shell code uses $1 — session name must NOT appear in the script string
      expect(cmdArray[4]).toContain('tmux attach -t "$1"');
      expect(cmdArray[4]).toContain('tmux set-option -t "$1"');
      expect(cmdArray[4]).not.toContain("test-session");
      // Positional placeholder and session name are separate array elements
      expect(cmdArray[5]).toBe("_");
      expect(cmdArray[6]).toBe("test-session");
    });

    test("session name is never interpolated into shell code", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      let spawnArgs: any[] = [];
      spawnCtx.set((...args: any[]) => {
        spawnArgs = args;
        return { unref: () => {} };
      });

      await openInGhostty("agent-abc_123");

      const cmdArray = spawnArgs[0] as string[];
      const shellCode = cmdArray[4];
      // The shell script must only reference $1, never the actual session name
      expect(shellCode).not.toContain("agent-abc_123");
      // The session name must be passed as a separate positional argument
      expect(cmdArray[6]).toBe("agent-abc_123");
    });

    test("spawns with stdio ignored", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      let spawnOpts: any = null;
      spawnCtx.set((...args: any[]) => {
        spawnOpts = args[1];
        return { unref: () => {} };
      });

      await openInGhostty("test-session");

      expect(spawnOpts.stdio).toEqual(["ignore", "ignore", "ignore"]);
    });

    test("calls unref on spawned process", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      let unrefCalled = false;
      spawnCtx.set((...args: any[]) => ({
        unref: () => { unrefCalled = true; },
      }));

      await openInGhostty("test-session");

      expect(unrefCalled).toBe(true);
    });

    test("returns success result on successful spawn", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      spawnCtx.set((...args: any[]) => ({ unref: () => {} }));

      const result = await openInGhostty("test-session");

      expect(result).toEqual({ ok: true, message: "Opened in Ghostty" });
    });

    test("returns error result when spawn throws", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      spawnCtx.set((...args: any[]) => {
        throw new Error("spawn failed");
      });

      const result = await openInGhostty("test-session");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("spawn failed");
    });
  });
});

describe("openPathInGhostty", () => {
  afterEach(() => {
    whichCtx.reset();
    spawnCtx.reset();
  });

  describe("path validation", () => {
    test("rejects empty path", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      const result = await openPathInGhostty("");
      expect(result).toEqual({ ok: false, message: "Invalid directory path" });
    });

    test("rejects path with null bytes", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      const result = await openPathInGhostty("/tmp/foo\x00bar");
      expect(result).toEqual({ ok: false, message: "Invalid directory path" });
    });

    test("rejects path with control characters", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      const result = await openPathInGhostty("/tmp/foo\nbar");
      expect(result).toEqual({ ok: false, message: "Invalid directory path" });
    });

    test("rejects path with DEL character", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      const result = await openPathInGhostty("/tmp/foo\x7fbar");
      expect(result).toEqual({ ok: false, message: "Invalid directory path" });
    });

    test("accepts valid absolute path", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      spawnCtx.set((...args: any[]) => ({ unref: () => {} }));
      const result = await openPathInGhostty("/Users/test/project");
      expect(result.ok).toBe(true);
    });

    test("accepts path with spaces", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      spawnCtx.set((...args: any[]) => ({ unref: () => {} }));
      const result = await openPathInGhostty("/Users/test/my project");
      expect(result.ok).toBe(true);
    });
  });

  describe("Ghostty availability check", () => {
    test("returns error when ghostty is not found on PATH", async () => {
      whichCtx.set(() => null);
      const result = await openPathInGhostty("/tmp/test");
      expect(result).toEqual({ ok: false, message: "Ghostty not found on PATH" });
    });
  });

  describe("spawn behavior", () => {
    test("spawns ghostty with --working-directory flag", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      let spawnArgs: any[] = [];
      spawnCtx.set((...args: any[]) => {
        spawnArgs = args;
        return { unref: () => {} };
      });

      await openPathInGhostty("/Users/test/project");

      const cmdArray = spawnArgs[0] as string[];
      expect(cmdArray[0]).toBe("ghostty");
      expect(cmdArray[1]).toBe("--working-directory=/Users/test/project");
    });

    test("does not use --command flag", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      let spawnArgs: any[] = [];
      spawnCtx.set((...args: any[]) => {
        spawnArgs = args;
        return { unref: () => {} };
      });

      await openPathInGhostty("/Users/test/project");

      const cmdArray = spawnArgs[0] as string[];
      expect(cmdArray).not.toContain("--command");
    });

    test("spawns with stdio ignored", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      let spawnOpts: any = null;
      spawnCtx.set((...args: any[]) => {
        spawnOpts = args[1];
        return { unref: () => {} };
      });

      await openPathInGhostty("/Users/test/project");

      expect(spawnOpts.stdio).toEqual(["ignore", "ignore", "ignore"]);
    });

    test("calls unref on spawned process", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      let unrefCalled = false;
      spawnCtx.set((...args: any[]) => ({
        unref: () => { unrefCalled = true; },
      }));

      await openPathInGhostty("/Users/test/project");

      expect(unrefCalled).toBe(true);
    });

    test("returns success result on successful spawn", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      spawnCtx.set((...args: any[]) => ({ unref: () => {} }));

      const result = await openPathInGhostty("/Users/test/project");

      expect(result).toEqual({ ok: true, message: "Opened in Ghostty" });
    });

    test("returns error result when spawn throws", async () => {
      whichCtx.set(() => "/usr/bin/ghostty");
      spawnCtx.set((...args: any[]) => {
        throw new Error("spawn failed");
      });

      const result = await openPathInGhostty("/Users/test/project");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("spawn failed");
    });
  });
});

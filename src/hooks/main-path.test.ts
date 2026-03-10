import { test, expect, describe } from "bun:test";
import { checkMainPath } from "./main-path";
import type { MainPathInput } from "./main-path";

describe("checkMainPath", () => {
  // ── Bash fixtures from ib test suite ────────────────────────────────────

  describe("allow cases", () => {
    test("allow-cd-normal-path: cd to /usr/local/bin is allowed", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /usr/local/bin" },
        cwd: "/some/path",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });

    test("allow-cd-to-home: bare cd is allowed", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd" },
        cwd: "/some/path",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });

    test("allow-non-bash-tool: Read tool even with agent path is allowed", () => {
      const input: MainPathInput = {
        tool_name: "Read",
        tool_input: { file_path: "/Users/dev/project/.ittybitty/agents/test/repo/file.txt" },
        cwd: "/some/path",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });

    test("allow-non-cd-bash: ls command is allowed", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "ls -la /some/path" },
        cwd: "/some/path",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });

    test("allow-cd-compound-non-agent: cd to normal path with && is allowed", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/dev/project/src && npm test" },
        cwd: "/Users/dev/project",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });
  });

  describe("deny cases", () => {
    test("deny-cd-agent-worktree: cd to agent repo is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/dev/project/.ittybitty/agents/test-agent/repo" },
        cwd: "/Users/dev/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
      expect(result.reason).toContain("agent worktree");
    });

    test("deny-cd-agent-worktree-subdir: cd to agent repo subdir is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/dev/project/.ittybitty/agents/test-agent/repo/src" },
        cwd: "/Users/dev/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });

    test("deny-cd-compound-and: cd to agent path with && is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/dev/project/.ittybitty/agents/test-agent/repo && chmod +x script.sh" },
        cwd: "/Users/dev/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });

    test("deny-cd-compound-or: cd to agent path with || is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/dev/project/.ittybitty/agents/test-agent/repo || echo failed" },
        cwd: "/Users/dev/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });

    test("deny-cd-compound-pipe: cd to agent path with | is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/dev/project/.ittybitty/agents/test-agent/repo | cat" },
        cwd: "/Users/dev/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });

    test("deny-cd-compound-semicolon: cd to agent path with ; is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/dev/project/.ittybitty/agents/test-agent/repo; ls -la" },
        cwd: "/Users/dev/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });

    test("deny-cd-multiple-chain: cd to agent path with multiple && is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/dev/project/.ittybitty/agents/test-agent/repo && git add . && git commit -m test" },
        cwd: "/Users/dev/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });
  });

  // ── Additional edge cases ───────────────────────────────────────────────

  describe("additional edge cases", () => {
    test("cd with empty target after trim is allowed", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd   " },
        cwd: "/some/path",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });

    test("cd to relative agent path resolves against cwd", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd .ittybitty/agents/agent-abc123/repo" },
        cwd: "/Users/me/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });

    test("cd with .. resolved against cwd targets agent worktree is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd ../project/.ittybitty/agents/agent-xyz/repo" },
        cwd: "/Users/me/other",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });

    test("cd with double-quoted agent path is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: 'cd "/Users/me/project/.ittybitty/agents/agent-abc/repo"' },
        cwd: "/Users/me/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });

    test("cd with single-quoted agent path is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd '/Users/me/project/.ittybitty/agents/agent-abc/repo'" },
        cwd: "/Users/me/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
    });

    test("cd to .ittybitty/agents (no /repo) is allowed", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/me/project/.ittybitty/agents" },
        cwd: "/Users/me/project",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });

    test("cd to .ittybitty/agents/some-id (no /repo) is allowed", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/me/project/.ittybitty/agents/agent-abc123" },
        cwd: "/Users/me/project",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });

    test("cd with shell comment is allowed for normal path", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /foo # some comment" },
        cwd: "/some/path",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });

    test("cd with shell comment to agent worktree is blocked", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: { command: "cd /Users/dev/project/.ittybitty/agents/test-agent/repo # checkout" },
        cwd: "/Users/dev/project",
      };
      const result = checkMainPath(input);
      expect(result.action).toBe("block");
      expect(result.reason).toContain("agent worktree");
    });

    test("missing command field defaults to empty string, allowed", () => {
      const input: MainPathInput = {
        tool_name: "Bash",
        tool_input: {},
        cwd: "/some/path",
      };
      expect(checkMainPath(input)).toEqual({ action: "allow" });
    });

    test("non-Bash tools (Write, Edit, Task) are all allowed", () => {
      for (const tool of ["Write", "Edit", "Task", "Grep", "Glob"]) {
        const input: MainPathInput = {
          tool_name: tool,
          tool_input: { file_path: "/Users/me/.ittybitty/agents/agent-x/repo/file.ts" },
          cwd: "/some/path",
        };
        expect(checkMainPath(input)).toEqual({ action: "allow" });
      }
    });
  });
});

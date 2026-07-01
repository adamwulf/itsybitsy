import { test, expect, describe } from "bun:test";
import { isValidModel, isValidEffort, isValidToolList, isValidAgentId, isValidTmuxSession, isValidSessionId, isValidShellPath, shellQuote } from "./validation";

describe("isValidModel", () => {
  test("accepts typical model names", () => {
    expect(isValidModel("sonnet")).toBe(true);
    expect(isValidModel("claude-sonnet-4-6")).toBe(true);
    expect(isValidModel("claude-opus-4-6")).toBe(true);
    expect(isValidModel("opus")).toBe(true);
    expect(isValidModel("gpt-4.5-turbo")).toBe(true);
    expect(isValidModel("model_v2")).toBe(true);
  });

  test("rejects shell injection attempts", () => {
    expect(isValidModel("opus$(whoami)")).toBe(false);
    expect(isValidModel("opus`id`")).toBe(false);
    expect(isValidModel('opus"; rm -rf /')).toBe(false);
    expect(isValidModel("opus && echo pwned")).toBe(false);
    expect(isValidModel("")).toBe(false);
    expect(isValidModel("model name")).toBe(false);
    expect(isValidModel("opus|cat /etc/passwd")).toBe(false);
  });
});

describe("isValidEffort", () => {
  test("accepts the five known effort levels", () => {
    expect(isValidEffort("low")).toBe(true);
    expect(isValidEffort("medium")).toBe(true);
    expect(isValidEffort("high")).toBe(true);
    expect(isValidEffort("xhigh")).toBe(true);
    expect(isValidEffort("max")).toBe(true);
  });

  test("rejects unknown levels, wrong case, empty, and shell injection", () => {
    expect(isValidEffort("")).toBe(false);
    expect(isValidEffort("XHIGH")).toBe(false);
    expect(isValidEffort("High")).toBe(false);
    expect(isValidEffort("extreme")).toBe(false);
    expect(isValidEffort("ultra")).toBe(false);
    expect(isValidEffort("high$(whoami)")).toBe(false);
    expect(isValidEffort("high`id`")).toBe(false);
    expect(isValidEffort('high"; rm -rf /')).toBe(false);
    expect(isValidEffort("high && echo pwned")).toBe(false);
    expect(isValidEffort("high|cat /etc/passwd")).toBe(false);
    expect(isValidEffort("high medium")).toBe(false);
    expect(isValidEffort(" high")).toBe(false);
  });
});

describe("isValidToolList", () => {
  test("accepts typical tool lists", () => {
    expect(isValidToolList("Bash")).toBe(true);
    expect(isValidToolList("Bash,Read,Write")).toBe(true);
    expect(isValidToolList("Bash(git:*)")).toBe(true);
    expect(isValidToolList("mcp__server__tool")).toBe(true);
    expect(isValidToolList("Bash(ib:*), Read")).toBe(true);
    expect(isValidToolList("Tool-Name")).toBe(true);
    expect(isValidToolList("Bash(./screensnap)")).toBe(true);
    expect(isValidToolList("Bash(./screensnap:*)")).toBe(true);
    expect(isValidToolList("Bash(~/bin/foo:*)")).toBe(true);
    expect(isValidToolList("Bash(/usr/local/bin/tool:*)")).toBe(true);
  });

  test("rejects shell injection attempts", () => {
    expect(isValidToolList("Bash$(whoami)")).toBe(false);
    expect(isValidToolList("Bash`id`")).toBe(false);
    expect(isValidToolList('Bash"; rm -rf /')).toBe(false);
    expect(isValidToolList("")).toBe(false);
    expect(isValidToolList("Bash\necho pwned")).toBe(false);
    expect(isValidToolList("Tool|cat")).toBe(false);
  });
});

describe("isValidAgentId", () => {
  test("accepts typical agent IDs", () => {
    expect(isValidAgentId("agent-a1b2c3d4")).toBe(true);
    expect(isValidAgentId("my_agent")).toBe(true);
    expect(isValidAgentId("agent123")).toBe(true);
  });

  test("rejects path traversal and injection", () => {
    expect(isValidAgentId("../../etc")).toBe(false);
    expect(isValidAgentId("agent/../../passwd")).toBe(false);
    expect(isValidAgentId("agent id")).toBe(false);
    expect(isValidAgentId("")).toBe(false);
    expect(isValidAgentId("agent$(whoami)")).toBe(false);
    expect(isValidAgentId("agent;ls")).toBe(false);
  });
});

describe("isValidTmuxSession", () => {
  test("accepts typical tmux session names", () => {
    expect(isValidTmuxSession("ittybitty-abc123-agent-deadbeef")).toBe(true);
    expect(isValidTmuxSession("my_session")).toBe(true);
  });

  test("rejects shell injection attempts", () => {
    expect(isValidTmuxSession("session$(whoami)")).toBe(false);
    expect(isValidTmuxSession("session;ls")).toBe(false);
    expect(isValidTmuxSession("")).toBe(false);
    expect(isValidTmuxSession("session name")).toBe(false);
  });
});

describe("isValidSessionId", () => {
  test("accepts UUID-format session IDs", () => {
    expect(isValidSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidSessionId("abcdef1234567890")).toBe(true);
    expect(isValidSessionId("a1b2-c3d4")).toBe(true);
  });

  test("rejects shell injection attempts", () => {
    expect(isValidSessionId("$(whoami)")).toBe(false);
    expect(isValidSessionId("`id`")).toBe(false);
    expect(isValidSessionId('"; rm -rf /')).toBe(false);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("uuid with spaces")).toBe(false);
  });
});

describe("isValidShellPath", () => {
  test("accepts normal paths", () => {
    expect(isValidShellPath("/usr/local/bin")).toBe(true);
    expect(isValidShellPath("/home/user/my project")).toBe(true);
    expect(isValidShellPath("/tmp/it's a test")).toBe(true);
    expect(isValidShellPath("/path/with spaces/and (parens)")).toBe(true);
    expect(isValidShellPath("/path/with-special_chars.v2")).toBe(true);
    expect(isValidShellPath("/path/$HOME/stuff")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidShellPath("")).toBe(false);
  });

  test("rejects paths with null bytes", () => {
    expect(isValidShellPath("/path/with\x00null")).toBe(false);
  });

  test("rejects paths with newlines", () => {
    expect(isValidShellPath("/path/with\nnewline")).toBe(false);
    expect(isValidShellPath("/path/with\r\nnewline")).toBe(false);
  });
});

describe("shellQuote", () => {
  test("quotes simple paths", () => {
    expect(shellQuote("/usr/local/bin")).toBe("'/usr/local/bin'");
  });

  test("quotes paths with spaces", () => {
    expect(shellQuote("/my project/path")).toBe("'/my project/path'");
  });

  test("escapes single quotes", () => {
    expect(shellQuote("/it's a path")).toBe("'/it'\\''s a path'");
  });

  test("handles multiple single quotes", () => {
    expect(shellQuote("it's got it's quotes")).toBe("'it'\\''s got it'\\''s quotes'");
  });

  test("neutralizes dollar signs and backticks", () => {
    const quoted = shellQuote("/path/$HOME/`whoami`");
    expect(quoted).toBe("'/path/$HOME/`whoami`'");
  });

  test("neutralizes double quotes and semicolons", () => {
    const quoted = shellQuote('/path"; rm -rf /');
    expect(quoted).toBe("'/path\"; rm -rf /'");
  });
});

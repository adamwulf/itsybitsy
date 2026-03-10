import { test, expect, describe } from "bun:test";
import { isValidModel, isValidToolList, isValidAgentId, isValidTmuxSession, isValidSessionId } from "./validation";

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

describe("isValidToolList", () => {
  test("accepts typical tool lists", () => {
    expect(isValidToolList("Bash")).toBe(true);
    expect(isValidToolList("Bash,Read,Write")).toBe(true);
    expect(isValidToolList("Bash(git:*)")).toBe(true);
    expect(isValidToolList("mcp__server__tool")).toBe(true);
    expect(isValidToolList("Bash(itsybitsy:*), Read")).toBe(true);
    expect(isValidToolList("Tool-Name")).toBe(true);
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

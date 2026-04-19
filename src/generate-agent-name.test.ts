import { test, expect, describe, afterEach } from "bun:test";
import {
  sanitizeAgentName,
  buildAgentNameCommand,
  generateAgentName,
  setAgentNameGenerator,
  resetAgentNameGenerator,
} from "./generate-agent-name";

describe("sanitizeAgentName", () => {
  test("passes through valid slug", () => {
    expect(sanitizeAgentName("login-fix")).toBe("login-fix");
  });

  test("lowercases uppercase letters", () => {
    expect(sanitizeAgentName("LoginFix")).toBe("loginfix");
  });

  test("replaces spaces with hyphens", () => {
    expect(sanitizeAgentName("dark mode toggle")).toBe("dark-mode-toggle");
  });

  test("collapses multiple hyphens", () => {
    expect(sanitizeAgentName("foo---bar")).toBe("foo-bar");
  });

  test("trims leading and trailing hyphens", () => {
    expect(sanitizeAgentName("---foo-bar---")).toBe("foo-bar");
  });

  test("strips surrounding double quotes", () => {
    expect(sanitizeAgentName('"login-fix"')).toBe("login-fix");
  });

  test("strips surrounding single quotes", () => {
    expect(sanitizeAgentName("'login-fix'")).toBe("login-fix");
  });

  test("strips surrounding backticks", () => {
    expect(sanitizeAgentName("`login-fix`")).toBe("login-fix");
  });

  test("strips smart quotes", () => {
    expect(sanitizeAgentName("\u201Clogin-fix\u201D")).toBe("login-fix");
  });

  test("strips markdown code fences", () => {
    expect(sanitizeAgentName("```\nlogin-fix\n```")).toBe("login-fix");
  });

  test("strips markdown code fences with language tag", () => {
    expect(sanitizeAgentName("```text\nlogin-fix\n```")).toBe("login-fix");
  });

  test("strips 'name:' prefix", () => {
    expect(sanitizeAgentName("name: login-fix")).toBe("login-fix");
  });

  test("strips 'Name:' prefix case-insensitive", () => {
    expect(sanitizeAgentName("Name: login-fix")).toBe("login-fix");
  });

  test("strips quotes after 'name:' prefix", () => {
    expect(sanitizeAgentName('name: "login-fix"')).toBe("login-fix");
  });

  test("replaces emojis with hyphens (then collapses)", () => {
    expect(sanitizeAgentName("login\u{1F680}fix")).toBe("login-fix");
  });

  test("replaces non-ascii chars with hyphens", () => {
    expect(sanitizeAgentName("café-update")).toBe("caf-update");
  });

  test("replaces punctuation with hyphens", () => {
    expect(sanitizeAgentName("fix!bug?now")).toBe("fix-bug-now");
  });

  test("truncates to 16 chars", () => {
    expect(sanitizeAgentName("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnop");
  });

  test("truncation trims trailing hyphens after slicing", () => {
    expect(sanitizeAgentName("abcdefghijklmno-pqr")).toBe("abcdefghijklmno");
  });

  test("returns 'agent' for empty string", () => {
    expect(sanitizeAgentName("")).toBe("agent");
  });

  test("returns 'agent' for only whitespace", () => {
    expect(sanitizeAgentName("   \n\t  ")).toBe("agent");
  });

  test("returns 'agent' for only hyphens", () => {
    expect(sanitizeAgentName("---")).toBe("agent");
  });

  test("returns 'agent' for pure digits", () => {
    expect(sanitizeAgentName("12345")).toBe("agent");
  });

  test("returns 'agent' for reserved 'coordinator'", () => {
    expect(sanitizeAgentName("coordinator")).toBe("agent");
  });

  test("returns 'agent' for reserved 'system'", () => {
    expect(sanitizeAgentName("system")).toBe("agent");
  });

  test("returns 'agent' for reserved 'agent'", () => {
    expect(sanitizeAgentName("agent")).toBe("agent");
  });

  test("handles non-string input defensively", () => {
    expect(sanitizeAgentName(undefined as unknown as string)).toBe("agent");
    expect(sanitizeAgentName(null as unknown as string)).toBe("agent");
  });

  test("strips trailing newlines and whitespace", () => {
    expect(sanitizeAgentName("login-fix\n\n")).toBe("login-fix");
  });

  test("keeps digits mixed in words", () => {
    expect(sanitizeAgentName("v2-rewrite")).toBe("v2-rewrite");
  });
});

describe("buildAgentNameCommand", () => {
  test("includes claude -p, system+task prompts, and haiku model", () => {
    const cmd = buildAgentNameCommand("do the thing");
    expect(cmd[0]).toBe("claude");
    expect(cmd[1]).toBe("-p");
    expect(cmd[2]).toContain("Task prompt:");
    expect(cmd[2]).toContain("do the thing");
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-haiku-4-5-20251001");
  });

  test("includes --tools with empty string to disable tools", () => {
    const cmd = buildAgentNameCommand("x");
    const toolsIdx = cmd.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(cmd[toolsIdx + 1]).toBe("");
  });
});

describe("generateAgentName", () => {
  afterEach(() => {
    resetAgentNameGenerator();
  });

  test("returns sanitized name from override", async () => {
    setAgentNameGenerator(async () => "LoginFix");
    expect(await generateAgentName("any prompt")).toBe("loginfix");
  });

  test("returns 'agent' when override returns empty string", async () => {
    setAgentNameGenerator(async () => "");
    expect(await generateAgentName("any prompt")).toBe("agent");
  });

  test("returns 'agent' when override returns whitespace", async () => {
    setAgentNameGenerator(async () => "   \n   ");
    expect(await generateAgentName("any prompt")).toBe("agent");
  });

  test("returns 'agent' when override throws", async () => {
    setAgentNameGenerator(async () => { throw new Error("boom"); });
    expect(await generateAgentName("any prompt")).toBe("agent");
  });

  test("returns 'agent' when override returns reserved name", async () => {
    setAgentNameGenerator(async () => "coordinator");
    expect(await generateAgentName("any prompt")).toBe("agent");
  });

  test("sanitizes markdown-wrapped output from override", async () => {
    setAgentNameGenerator(async () => "```\nsome-task\n```");
    expect(await generateAgentName("any prompt")).toBe("some-task");
  });

  test("truncates long output from override", async () => {
    setAgentNameGenerator(async () => "abcdefghijklmnopqrstuvwxyz");
    expect(await generateAgentName("any prompt")).toBe("abcdefghijklmnop");
  });

  test("returns 'agent' for empty prompt (no override)", async () => {
    resetAgentNameGenerator();
    expect(await generateAgentName("")).toBe("agent");
    expect(await generateAgentName("   ")).toBe("agent");
  });
});

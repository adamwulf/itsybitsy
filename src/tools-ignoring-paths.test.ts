import { describe, expect, test } from "bun:test";
import {
  isMcpToolName,
  isValidToolsIgnoringPathsEntry,
  metaToolsIgnoringPaths,
  sanitizeToolsIgnoringPaths,
  toolIgnoresPaths,
  toolsIgnoringPathsEntryError,
  unionToolsIgnoringPaths,
} from "./tools-ignoring-paths";

const BUILT_IN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "LS", "Glob", "Grep",
  "Bash", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "ToolSearch",
  "apply_patch",
];

describe("toolIgnoresPaths", () => {
  test("an exact entry matches only that tool", () => {
    const entries = ["mcp__sosumi__fetchAppleDocumentation"];
    expect(toolIgnoresPaths("mcp__sosumi__fetchAppleDocumentation", entries)).toBe(true);
    expect(toolIgnoresPaths("mcp__sosumi__searchAppleDocumentation", entries)).toBe(false);
  });

  test("a server prefix glob matches every tool of that server", () => {
    const entries = ["mcp__sosumi__*"];
    expect(toolIgnoresPaths("mcp__sosumi__fetchAppleDocumentation", entries)).toBe(true);
    expect(toolIgnoresPaths("mcp__sosumi__searchAppleDocumentation", entries)).toBe(true);
  });

  test("a prefix glob does not match another server that shares its prefix", () => {
    const entries = ["mcp__sosumi__*"];
    expect(toolIgnoresPaths("mcp__sosumi2__fetch", entries)).toBe(false);
    expect(toolIgnoresPaths("mcp__sosum__fetch", entries)).toBe(false);
  });

  test("server names with dashes and underscores match", () => {
    expect(toolIgnoresPaths("mcp__claude-in-chrome__tabs_context_mcp", ["mcp__claude-in-chrome__*"])).toBe(true);
    expect(toolIgnoresPaths("mcp__claude_ai_Gmail__get_message", ["mcp__claude_ai_Gmail__get_message"])).toBe(true);
  });

  test("a tool on no list does not match", () => {
    expect(toolIgnoresPaths("mcp__other__fetch", ["mcp__sosumi__*", "mcp__docs__read"])).toBe(false);
    expect(toolIgnoresPaths("mcp__sosumi__fetch", [])).toBe(false);
    expect(toolIgnoresPaths("mcp__sosumi__fetch", undefined)).toBe(false);
  });

  test("built-in tools never match, even if invalid entries reached the list", () => {
    // These entries can only reach the hook through a corrupt store; the
    // validator and the loader reject them. The matcher must still refuse.
    const hostile = [...BUILT_IN_TOOLS, "*", "mcp__*", "mcp____*", "**", "mcp__sosumi__*"];
    for (const tool of BUILT_IN_TOOLS) {
      expect(toolIgnoresPaths(tool, hostile)).toBe(false);
    }
  });

  test("an invalid entry is skipped while a valid one still matches", () => {
    expect(toolIgnoresPaths("mcp__x__y", ["*", "mcp__*", "mcp__x__*"])).toBe(true);
    expect(toolIgnoresPaths("mcp__x__y", ["*", "mcp__*"])).toBe(false);
  });
});

describe("isMcpToolName", () => {
  test("accepts mcp__<server>__<tool> and rejects everything else", () => {
    expect(isMcpToolName("mcp__sosumi__fetchAppleDocumentation")).toBe(true);
    expect(isMcpToolName("mcp__claude-in-chrome__tabs_context_mcp")).toBe(true);
    for (const tool of BUILT_IN_TOOLS) expect(isMcpToolName(tool)).toBe(false);
    expect(isMcpToolName("mcp__sosumi")).toBe(false);
    expect(isMcpToolName("mcp__sosumi__")).toBe(false);
    expect(isMcpToolName("mcp____fetch")).toBe(false);
    expect(isMcpToolName("mcp__sosumi__*")).toBe(false);
  });
});

describe("toolsIgnoringPathsEntryError", () => {
  test("accepts exact MCP tool names and server prefix globs", () => {
    for (const entry of [
      "mcp__sosumi__*",
      "mcp__sosumi__fetchAppleDocumentation",
      "mcp__claude-in-chrome__*",
      "mcp__claude_ai_Gmail__get_message",
    ]) {
      expect(toolsIgnoringPathsEntryError(entry)).toBeNull();
      expect(isValidToolsIgnoringPathsEntry(entry)).toBe(true);
    }
  });

  test("rejects built-in tool names", () => {
    for (const tool of ["Read", "Bash", "Write", "Glob", "Edit", "Grep", "NotebookEdit", "apply_patch"]) {
      expect(toolsIgnoringPathsEntryError(tool)).toContain("is not an MCP tool");
    }
  });

  test("rejects a bare *", () => {
    expect(toolsIgnoringPathsEntryError("*")).toContain("every tool");
  });

  test("rejects mcp__* and other entries with no server name", () => {
    expect(toolsIgnoringPathsEntryError("mcp__*")).toContain("has no server name");
    expect(toolsIgnoringPathsEntryError("mcp____*")).toContain("has no server name");
    expect(toolsIgnoringPathsEntryError("mcp____fetch")).toContain("has no server name");
    expect(toolsIgnoringPathsEntryError("mcp__")).toContain("has no server name");
  });

  test("rejects a * anywhere but the whole tool name after mcp__<server>__", () => {
    for (const entry of ["mcp__sosumi__fetch*", "mcp__so*__*", "mcp__sosumi*", "mcp__sosumi__*__x", "mcp__s*s__fetch"]) {
      expect(toolsIgnoringPathsEntryError(entry)).toContain("* in the wrong place");
    }
  });

  test("rejects an MCP prefix with no tool part, whitespace and non-strings", () => {
    expect(toolsIgnoringPathsEntryError("mcp__sosumi")).not.toBeNull();
    expect(toolsIgnoringPathsEntryError("mcp__sosumi__")).not.toBeNull();
    expect(toolsIgnoringPathsEntryError("mcp__sosumi__fetch docs")).not.toBeNull();
    expect(toolsIgnoringPathsEntryError("")).not.toBeNull();
    expect(toolsIgnoringPathsEntryError(42)).toContain("must be strings");
    expect(toolsIgnoringPathsEntryError(null)).toContain("must be strings");
  });
});

describe("sanitize / union / meta", () => {
  test("sanitize keeps valid entries in order, drops invalid ones and duplicates", () => {
    expect(sanitizeToolsIgnoringPaths(["mcp__a__*", "Read", "*", "mcp__b__c", "mcp__a__*", 7])).toEqual([
      "mcp__a__*",
      "mcp__b__c",
    ]);
  });

  test("sanitize turns a non-list into an empty list", () => {
    expect(sanitizeToolsIgnoringPaths("mcp__a__*")).toEqual([]);
    expect(sanitizeToolsIgnoringPaths(undefined)).toEqual([]);
    expect(sanitizeToolsIgnoringPaths({ 0: "mcp__a__*" })).toEqual([]);
  });

  test("union merges layers in order, deduplicated, skipping missing layers", () => {
    expect(unionToolsIgnoringPaths([["mcp__a__*"], undefined, ["mcp__b__c", "mcp__a__*"]])).toEqual([
      "mcp__a__*",
      "mcp__b__c",
    ]);
  });

  test("metaToolsIgnoringPaths reads the frozen list and drops invalid entries", () => {
    expect(metaToolsIgnoringPaths({ toolsIgnoringPaths: ["mcp__sosumi__*", "Bash"] })).toEqual(["mcp__sosumi__*"]);
    expect(metaToolsIgnoringPaths({})).toEqual([]);
    expect(metaToolsIgnoringPaths({ toolsIgnoringPaths: "mcp__sosumi__*" })).toEqual([]);
  });
});

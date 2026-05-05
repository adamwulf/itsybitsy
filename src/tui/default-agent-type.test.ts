import { test, expect, describe } from "bun:test";
import { resolveDefaultAgentType } from "./default-agent-type";

describe("resolveDefaultAgentType", () => {
  test("returns saved value when present and available", () => {
    expect(resolveDefaultAgentType("worker", ["manager", "worker", "coordinator"])).toBe("worker");
  });

  test("falls back to manager when saved value is missing from list", () => {
    expect(resolveDefaultAgentType("vanished", ["manager", "worker"])).toBe("manager");
  });

  test("falls back to manager when saved is undefined", () => {
    expect(resolveDefaultAgentType(undefined, ["coordinator", "manager", "worker"])).toBe("manager");
  });

  test("falls back to first available when manager is not available", () => {
    expect(resolveDefaultAgentType(undefined, ["coordinator", "worker"])).toBe("coordinator");
  });

  test("returns 'manager' string when list is empty", () => {
    expect(resolveDefaultAgentType(undefined, [])).toBe("manager");
  });

  test("ignores empty saved string and uses fallback", () => {
    // empty string is falsy → treated as unset
    expect(resolveDefaultAgentType("", ["manager", "worker"])).toBe("manager");
  });
});

import { test, expect, describe } from "bun:test";
import { KNOWN_MODELS } from "./known-models";
import { parseModel } from "./agent-cli";

describe("KNOWN_MODELS", () => {
  test("every entry round-trips through parseModel", () => {
    for (const entry of KNOWN_MODELS) {
      const parsed = parseModel(entry.full);
      expect(parsed.cli).toBe(entry.cli);
      expect(parsed.model).toBe(entry.model);
    }
  });

  test("every entry's full matches `<cli>:<model>`", () => {
    for (const entry of KNOWN_MODELS) {
      expect(entry.full).toBe(`${entry.cli}:${entry.model}`);
    }
  });

  test("entries are unique by `full`", () => {
    const seen = new Set<string>();
    for (const entry of KNOWN_MODELS) {
      expect(seen.has(entry.full)).toBe(false);
      seen.add(entry.full);
    }
  });

  test("contains at least one entry per known CLI", () => {
    const clis = new Set(KNOWN_MODELS.map((m) => m.cli));
    expect(clis.has("claude")).toBe(true);
    expect(clis.has("codex")).toBe(true);
  });
});

import { test, expect, describe } from "bun:test";
import { KNOWN_MODELS } from "./known-models";
import { parseModel } from "./agent-cli";

describe("KNOWN_MODELS", () => {
  test("every entry round-trips through parseModel", () => {
    for (const entry of KNOWN_MODELS) {
      const full = `${entry.cli}:${entry.model}`;
      const parsed = parseModel(full);
      expect(parsed.cli).toBe(entry.cli);
      expect(parsed.model).toBe(entry.model);
    }
  });

  test("entries are unique by `<cli>:<model>`", () => {
    const seen = new Set<string>();
    for (const entry of KNOWN_MODELS) {
      const full = `${entry.cli}:${entry.model}`;
      expect(seen.has(full)).toBe(false);
      seen.add(full);
    }
  });

  test("contains at least one entry per known CLI", () => {
    const clis = new Set(KNOWN_MODELS.map((m) => m.cli));
    expect(clis.has("claude")).toBe(true);
    expect(clis.has("codex")).toBe(true);
    expect(clis.has("fugu")).toBe(true);
  });
});

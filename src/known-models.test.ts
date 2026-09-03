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
    expect(clis.has("agy")).toBe(true);
  });

  test("includes the current Antigravity (agy) selectors from `agy models`", () => {
    const selectors = new Set(KNOWN_MODELS.map((m) => `${m.cli}:${m.model}`));
    // The itsybitsy sentinel that omits --model/--effort (agy's own default).
    expect(selectors.has("agy:default")).toBe(true);
    // Current-generation Gemini Flash (all three efforts) + Pro + non-Gemini.
    expect(selectors.has("agy:gemini-3.8-flash-high")).toBe(true);
    expect(selectors.has("agy:gemini-3.8-flash-medium")).toBe(true);
    expect(selectors.has("agy:gemini-3.8-flash-low")).toBe(true);
    expect(selectors.has("agy:gemini-3.1-pro-high")).toBe(true);
    expect(selectors.has("agy:gemini-3.1-pro-low")).toBe(true);
    expect(selectors.has("agy:claude-sonnet-4-6")).toBe(true);
    expect(selectors.has("agy:claude-opus-4-6-thinking")).toBe(true);
    expect(selectors.has("agy:gpt-oss-120b-medium")).toBe(true);
  });

  test("includes current GPT-5.6 codex selectors", () => {
    const selectors = new Set(KNOWN_MODELS.map((m) => `${m.cli}:${m.model}`));
    expect(selectors.has("codex:gpt-5.6-sol")).toBe(true);
    expect(selectors.has("codex:gpt-5.6-terra")).toBe(true);
    expect(selectors.has("codex:gpt-5.6-luna")).toBe(true);
  });
});

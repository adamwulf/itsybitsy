import { test, expect, describe } from "bun:test";
import { resolveCli, isCodexModel, parseModel, mapEffortForCodex, KNOWN_CLIS, type AgentCli } from "./agent-cli";

describe("parseModel", () => {
  describe("split on first colon, model is greedy-to-end (SPEC §5.1)", () => {
    test("simple claude alias", () => {
      expect(parseModel("claude:opus")).toEqual({ cli: "claude", model: "opus" });
    });

    test("dotted-dashed full claude model name", () => {
      expect(parseModel("claude:claude-opus-4-7")).toEqual({
        cli: "claude",
        model: "claude-opus-4-7",
      });
    });

    test("codex model", () => {
      expect(parseModel("codex:gpt-5.1-codex")).toEqual({
        cli: "codex",
        model: "gpt-5.1-codex",
      });
    });

    test("Fugu selector", () => {
      expect(parseModel("fugu:fugu-ultra")).toEqual({ cli: "fugu", model: "fugu-ultra" });
    });

    test("codex prefix variants", () => {
      expect(parseModel("codex:gpt-5-codex")).toEqual({
        cli: "codex",
        model: "gpt-5-codex",
      });
      expect(parseModel("codex:o3")).toEqual({ cli: "codex", model: "o3" });
      expect(parseModel("codex:o3-mini")).toEqual({ cli: "codex", model: "o3-mini" });
      expect(parseModel("codex:o4-mini")).toEqual({ cli: "codex", model: "o4-mini" });
    });

    test("greedy model preserves embedded colons (split on FIRST colon only)", () => {
      expect(parseModel("claude:weird:value")).toEqual({
        cli: "claude",
        model: "weird:value",
      });
      expect(parseModel("codex:a:b:c")).toEqual({
        cli: "codex",
        model: "a:b:c",
      });
    });

    test("cli half taken literally — boundary-aware prefix logic deleted; the cli is the cli", () => {
      // The old prefix table would have routed `o35`/`o3x` to claude. Now they
      // are simply the model half of a `codex:` qualified string — the cli is
      // explicitly "codex" so there is no inference at all.
      expect(parseModel("codex:o35")).toEqual({ cli: "codex", model: "o35" });
      expect(parseModel("codex:o3x")).toEqual({ cli: "codex", model: "o3x" });
      expect(parseModel("codex:gpt-5-codexx")).toEqual({
        cli: "codex",
        model: "gpt-5-codexx",
      });
    });

    test("model half is preserved verbatim (case sensitive)", () => {
      expect(parseModel("claude:Sonnet").model).toBe("Sonnet");
      expect(parseModel("codex:GPT-5-Codex").model).toBe("GPT-5-Codex");
    });
  });

  describe("cli half is case-insensitive + whitespace-trimmed; model half is not", () => {
    test("uppercase cli", () => {
      expect(parseModel("CLAUDE:opus")).toEqual({ cli: "claude", model: "opus" });
      expect(parseModel("CODEX:o3")).toEqual({ cli: "codex", model: "o3" });
    });

    test("mixed-case cli", () => {
      expect(parseModel("Claude:opus")).toEqual({ cli: "claude", model: "opus" });
      expect(parseModel("Codex:o3-mini")).toEqual({ cli: "codex", model: "o3-mini" });
    });

    test("whitespace around the cli is trimmed", () => {
      expect(parseModel("  claude:opus")).toEqual({ cli: "claude", model: "opus" });
      expect(parseModel("\tcodex:o3")).toEqual({ cli: "codex", model: "o3" });
    });

    test("whitespace INSIDE / AFTER the model half is preserved verbatim", () => {
      // The model half is sliced from the first colon to end of string; only
      // the cli half is trimmed.
      expect(parseModel("claude: opus")).toEqual({ cli: "claude", model: " opus" });
      expect(parseModel("codex:gpt ")).toEqual({ cli: "codex", model: "gpt " });
    });
  });

  describe("throws on bare names (D1/D5: no back-compat)", () => {
    const bareNames = [
      "opus",
      "sonnet",
      "haiku",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "gpt-5-codex",
      "gpt-5.1-codex",
      "o3",
      "o3-mini",
      "o4-mini",
      "gpt-4",
      "gemini-pro",
      "totally-made-up-model",
    ];
    for (const m of bareNames) {
      test(`'${m}' throws (missing colon)`, () => {
        expect(() => parseModel(m)).toThrow();
      });
    }
  });

  describe("throws on missing colon", () => {
    test("empty string throws", () => {
      expect(() => parseModel("")).toThrow();
    });
    test("whitespace-only throws", () => {
      expect(() => parseModel("   ")).toThrow();
    });
    test("bare alphanumeric throws", () => {
      expect(() => parseModel("opus")).toThrow();
    });
  });

  describe("throws on malformed cli", () => {
    test("cli starting with a digit throws", () => {
      expect(() => parseModel("1bad:foo")).toThrow(/Malformed CLI/);
    });
    test("cli starting with a dash throws", () => {
      expect(() => parseModel("-bad:foo")).toThrow(/Malformed CLI/);
    });
    test("cli containing a dot throws (dot is not in the cli alphabet)", () => {
      expect(() => parseModel("c.l.i:foo")).toThrow(/Malformed CLI/);
    });
    test("empty cli (string starts with colon) throws", () => {
      expect(() => parseModel(":foo")).toThrow(/Malformed CLI/);
    });
  });

  describe("throws on unknown cli (D6: hard-reject)", () => {
    test("gemini:foo throws with the D6 message", () => {
      expect(() => parseModel("gemini:foo")).toThrow(
        /Unknown CLI 'gemini' in model 'gemini:foo'; known: claude, codex/,
      );
    });
    test("openai:gpt-4 throws", () => {
      expect(() => parseModel("openai:gpt-4")).toThrow(/Unknown CLI 'openai'/);
    });
    test("aider:foo throws", () => {
      expect(() => parseModel("aider:foo")).toThrow(/Unknown CLI 'aider'/);
    });
    test("d6 message lists known CLIs", () => {
      expect(() => parseModel("anthropic:opus")).toThrow(/known: claude, codex/);
    });
  });

  describe("KNOWN_CLIS membership", () => {
    test("contains claude, codex, and fugu", () => {
      expect(KNOWN_CLIS.has("claude")).toBe(true);
      expect(KNOWN_CLIS.has("codex")).toBe(true);
      expect(KNOWN_CLIS.has("fugu")).toBe(true);
    });
    test("has size 3 (claude + codex + fugu)", () => {
      expect(KNOWN_CLIS.size).toBe(3);
    });
  });
});

describe("resolveCli (thin wrapper over parseModel)", () => {
  describe("returns claude for qualified claude strings", () => {
    const claudeModels = [
      "claude:claude",
      "claude:opus",
      "claude:sonnet",
      "claude:haiku",
      "claude:claude-opus-4-8",
      "claude:claude-sonnet-4-6",
      "claude:claude-haiku-4-5-20251001",
    ];
    for (const model of claudeModels) {
      test(`'${model}' -> claude`, () => {
        expect(resolveCli(model)).toBe("claude");
      });
    }
  });

  describe("returns codex for qualified codex strings", () => {
    const codexModels = [
      "codex:gpt-5-codex",
      "codex:gpt-5.1-codex",
      "codex:gpt-5.1-codex-max",
      "codex:gpt-5.1-codex-min",
      "codex:gpt-5.1-codex-mini",
      "codex:o3",
      "codex:o3-mini",
      "codex:o3-pro",
      "codex:o4-mini",
      "codex:o4-mini-high",
      "codex:o4-mini-2025-04-16",
      "codex:o35",
      "codex:gpt-5-codexx",
    ];
    for (const model of codexModels) {
      test(`'${model}' -> codex`, () => {
        expect(resolveCli(model)).toBe("codex");
      });
    }
  });

  describe("throws on bare names (no back-compat)", () => {
    const bare = ["opus", "sonnet", "gpt-5-codex", "o3", ""];
    for (const m of bare) {
      test(`'${JSON.stringify(m)}' throws`, () => {
        expect(() => resolveCli(m)).toThrow();
      });
    }
  });

  describe("case-insensitive cli", () => {
    const cases: ReadonlyArray<[string, AgentCli]> = [
      ["CLAUDE:opus", "claude"],
      ["Codex:o3", "codex"],
      ["CoDeX:GPT-5-Codex", "codex"],
    ];
    for (const [input, expected] of cases) {
      test(`'${input}' -> ${expected}`, () => {
        expect(resolveCli(input)).toBe(expected);
      });
    }
  });

  test("return type is the AgentCli union", () => {
    const cli: AgentCli = resolveCli("claude:opus");
    expect(cli === "claude" || cli === "codex").toBe(true);
  });
});

describe("isCodexModel (thin wrapper over parseModel)", () => {
  test("true for qualified codex models", () => {
    expect(isCodexModel("codex:gpt-5-codex")).toBe(true);
    expect(isCodexModel("codex:o3")).toBe(true);
    expect(isCodexModel("codex:o3-mini")).toBe(true);
    expect(isCodexModel("codex:o4-mini")).toBe(true);
    expect(isCodexModel("codex:gpt-5.1-codex-max")).toBe(true);
  });

  test("false for qualified claude models", () => {
    expect(isCodexModel("claude:opus")).toBe(false);
    expect(isCodexModel("claude:sonnet")).toBe(false);
    expect(isCodexModel("claude:claude-opus-4-8")).toBe(false);
  });

  test("throws on bare names", () => {
    expect(() => isCodexModel("opus")).toThrow();
    expect(() => isCodexModel("gpt-5-codex")).toThrow();
    expect(() => isCodexModel("o3")).toThrow();
    expect(() => isCodexModel("")).toThrow();
  });

  test("throws on unknown cli", () => {
    expect(() => isCodexModel("gemini:foo")).toThrow(/Unknown CLI 'gemini'/);
  });

  test("case-insensitive cli", () => {
    expect(isCodexModel("CODEX:o3")).toBe(true);
    expect(isCodexModel("CLAUDE:opus")).toBe(false);
  });
});

describe("isCodexModel and resolveCli agree on qualified inputs", () => {
  const samples = [
    "claude:opus",
    "claude:sonnet",
    "claude:claude-opus-4-8",
    "codex:gpt-5-codex",
    "codex:gpt-5.1-codex",
    "codex:gpt-5.1-codex-max",
    "codex:gpt-5.1-codex-mini",
    "codex:o3",
    "codex:o3-mini",
    "codex:o3-pro",
    "codex:o4-mini",
    "codex:o35",
    "codex:gpt-5-codexx",
    "CODEX:O3",
    "Claude:opus",
  ];
  for (const model of samples) {
    test(`consistent for '${model}'`, () => {
      const expected: AgentCli = isCodexModel(model) ? "codex" : "claude";
      expect(resolveCli(model)).toBe(expected);
    });
  }
});

describe("mapEffortForCodex — collapse the itsybitsy 5-level scale to codex's low/medium/high", () => {
  test("low and medium pass through unchanged", () => {
    expect(mapEffortForCodex("low")).toBe("low");
    expect(mapEffortForCodex("medium")).toBe("medium");
  });

  test("high, xhigh, and max all map to codex 'high' (codex has no xhigh/max)", () => {
    expect(mapEffortForCodex("high")).toBe("high");
    expect(mapEffortForCodex("xhigh")).toBe("high");
    expect(mapEffortForCodex("max")).toBe("high");
  });

  test("the default effort ('xhigh') lands on codex 'high'", () => {
    // Belt-and-suspenders: the shared default is xhigh, so a codex agent with
    // no explicit override must resolve to codex 'high'.
    expect(mapEffortForCodex("xhigh")).toBe("high");
  });

  test("unrecognized input falls back to 'high'", () => {
    // Never expected to fire (callers validate with isValidEffort first), but
    // the mapping must be total — an unmapped value must not become undefined.
    expect(mapEffortForCodex("")).toBe("high");
    expect(mapEffortForCodex("bogus")).toBe("high");
  });
});

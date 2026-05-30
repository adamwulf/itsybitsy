import { test, expect, describe } from "bun:test";
import { resolveCli, isCodexModel, type AgentCli } from "./agent-cli";

describe("resolveCli", () => {
  describe("claude is the default (no regression)", () => {
    const claudeModels = [
      "claude",
      "opus",
      "sonnet",
      "haiku",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ];
    for (const model of claudeModels) {
      test(`'${model}' -> claude`, () => {
        expect(resolveCli(model)).toBe("claude");
      });
    }
  });

  describe("unknown / unrelated models fall back to claude", () => {
    const unknownModels = [
      "gpt-4",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-3.5-turbo",
      "gemini-pro",
      "llama-3",
      "mistral-large",
      "totally-made-up-model",
      "o", // not o3/o4-mini — must not prefix-match
      "o2",
      "o5",
      "codex", // bare 'codex' is not a model name
    ];
    for (const model of unknownModels) {
      test(`'${model}' -> claude`, () => {
        expect(resolveCli(model)).toBe("claude");
      });
    }
  });

  describe("empty / whitespace-only -> claude", () => {
    for (const model of ["", " ", "   ", "\t", "\n"]) {
      test(`'${JSON.stringify(model)}' -> claude`, () => {
        expect(resolveCli(model)).toBe("claude");
      });
    }
  });

  describe("known codex models -> codex (exact)", () => {
    const codexModels = ["gpt-5-codex", "o3", "o3-mini", "o4-mini"];
    for (const model of codexModels) {
      test(`'${model}' -> codex`, () => {
        expect(resolveCli(model)).toBe("codex");
      });
    }
  });

  describe("codex prefix variants -> codex", () => {
    const prefixVariants = [
      "gpt-5-codex-2025-06-01",
      "gpt-5-codex-high",
      "gpt-5-codex-preview",
      "o3-pro",
      "o3-mini-2025-01-31",
      "o4-mini-high",
      "o4-mini-2025-04-16",
    ];
    for (const model of prefixVariants) {
      test(`'${model}' -> codex`, () => {
        expect(resolveCli(model)).toBe("codex");
      });
    }
  });

  describe("case-insensitive matching", () => {
    const cases = ["GPT-5-CODEX", "Gpt-5-Codex", "O3", "O3-Mini", "O4-MINI", "o4-Mini-High"];
    for (const model of cases) {
      test(`'${model}' -> codex`, () => {
        expect(resolveCli(model)).toBe("codex");
      });
    }
  });

  describe("surrounding-whitespace tolerance", () => {
    const cases = [
      "  gpt-5-codex  ",
      "\to3\t",
      " o4-mini\n",
      "\n gpt-5-codex \n",
      "  O3-MINI  ",
    ];
    for (const model of cases) {
      test(`'${JSON.stringify(model)}' -> codex`, () => {
        expect(resolveCli(model)).toBe("codex");
      });
    }
    test("whitespace around a claude model still -> claude", () => {
      expect(resolveCli("  opus  ")).toBe("claude");
    });
  });

  test("return type is the AgentCli union", () => {
    const cli: AgentCli = resolveCli("opus");
    expect(cli === "claude" || cli === "codex").toBe(true);
  });
});

describe("isCodexModel", () => {
  test("true for known codex models", () => {
    expect(isCodexModel("gpt-5-codex")).toBe(true);
    expect(isCodexModel("o3")).toBe(true);
    expect(isCodexModel("o3-mini")).toBe(true);
    expect(isCodexModel("o4-mini")).toBe(true);
  });

  test("true for prefix variants", () => {
    expect(isCodexModel("gpt-5-codex-high")).toBe(true);
    expect(isCodexModel("o3-pro")).toBe(true);
    expect(isCodexModel("o4-mini-high")).toBe(true);
  });

  test("false for claude / unknown models", () => {
    expect(isCodexModel("opus")).toBe(false);
    expect(isCodexModel("sonnet")).toBe(false);
    expect(isCodexModel("claude-opus-4-8")).toBe(false);
    expect(isCodexModel("gpt-4o")).toBe(false);
    expect(isCodexModel("o2")).toBe(false);
    expect(isCodexModel("o5")).toBe(false);
  });

  test("false for empty / whitespace-only", () => {
    expect(isCodexModel("")).toBe(false);
    expect(isCodexModel("   ")).toBe(false);
    expect(isCodexModel("\t\n")).toBe(false);
  });

  test("case-insensitive and whitespace-tolerant", () => {
    expect(isCodexModel("  GPT-5-CODEX  ")).toBe(true);
    expect(isCodexModel("\tO3\t")).toBe(true);
  });
});

describe("isCodexModel and resolveCli agree", () => {
  const samples = [
    "claude",
    "opus",
    "sonnet",
    "haiku",
    "claude-opus-4-8",
    "gpt-4o",
    "o2",
    "o5",
    "codex",
    "",
    "   ",
    "gpt-5-codex",
    "o3",
    "o3-mini",
    "o4-mini",
    "gpt-5-codex-high",
    "o3-pro",
    "o4-mini-2025-04-16",
    "  GPT-5-CODEX  ",
    "\tO3\t",
  ];
  for (const model of samples) {
    test(`consistent for '${JSON.stringify(model)}'`, () => {
      const expected: AgentCli = isCodexModel(model) ? "codex" : "claude";
      expect(resolveCli(model)).toBe(expected);
    });
  }
});

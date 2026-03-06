import { test, expect, describe } from "bun:test";
import {
  parseOSC11Response,
  computeLuminance,
  luminanceToScheme,
} from "./color-scheme";

describe("parseOSC11Response", () => {
  test("parses 4-digit hex values (black)", () => {
    const result = parseOSC11Response("rgb:0000/0000/0000");
    expect(result).toEqual({ r: 0, g: 0, b: 0 });
  });

  test("parses 4-digit hex values (white)", () => {
    const result = parseOSC11Response("rgb:ffff/ffff/ffff");
    expect(result).toEqual({ r: 1, g: 1, b: 1 });
  });

  test("parses 4-digit hex values (mid-gray)", () => {
    const result = parseOSC11Response("rgb:8000/8000/8000");
    expect(result).not.toBeNull();
    expect(result!.r).toBeCloseTo(0x8000 / 0xffff, 4);
    expect(result!.g).toBeCloseTo(0x8000 / 0xffff, 4);
    expect(result!.b).toBeCloseTo(0x8000 / 0xffff, 4);
  });

  test("parses 2-digit hex values (white)", () => {
    const result = parseOSC11Response("rgb:FF/FF/FF");
    expect(result).toEqual({ r: 1, g: 1, b: 1 });
  });

  test("parses 2-digit hex values (black)", () => {
    const result = parseOSC11Response("rgb:00/00/00");
    expect(result).toEqual({ r: 0, g: 0, b: 0 });
  });

  test("parses 2-digit hex values (red)", () => {
    const result = parseOSC11Response("rgb:FF/00/00");
    expect(result).toEqual({ r: 1, g: 0, b: 0 });
  });

  test("parses response embedded in OSC escape", () => {
    const result = parseOSC11Response("\x1b]11;rgb:1c1c/1c1c/1c1c\x07");
    expect(result).not.toBeNull();
    expect(result!.r).toBeCloseTo(0x1c1c / 0xffff, 4);
  });

  test("returns null for empty string", () => {
    expect(parseOSC11Response("")).toBeNull();
  });

  test("returns null for malformed input", () => {
    expect(parseOSC11Response("rgb:not/valid/hex")).toBeNull();
  });

  test("returns null for missing channels", () => {
    expect(parseOSC11Response("rgb:FF/FF")).toBeNull();
  });

  test("returns null for completely unrelated input", () => {
    expect(parseOSC11Response("hello world")).toBeNull();
  });
});

describe("computeLuminance", () => {
  test("black has luminance 0", () => {
    expect(computeLuminance(0, 0, 0)).toBe(0);
  });

  test("white has luminance 1", () => {
    expect(computeLuminance(1, 1, 1)).toBeCloseTo(1, 4);
  });

  test("pure red", () => {
    expect(computeLuminance(1, 0, 0)).toBeCloseTo(0.2126, 4);
  });

  test("pure green", () => {
    expect(computeLuminance(0, 1, 0)).toBeCloseTo(0.7152, 4);
  });

  test("pure blue", () => {
    expect(computeLuminance(0, 0, 1)).toBeCloseTo(0.0722, 4);
  });

  test("mid-gray", () => {
    expect(computeLuminance(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 4);
  });
});

describe("luminanceToScheme", () => {
  test("low luminance returns dark", () => {
    expect(luminanceToScheme(0)).toBe("dark");
    expect(luminanceToScheme(0.1)).toBe("dark");
    expect(luminanceToScheme(0.49)).toBe("dark");
  });

  test("high luminance returns light", () => {
    expect(luminanceToScheme(0.5)).toBe("light");
    expect(luminanceToScheme(0.7)).toBe("light");
    expect(luminanceToScheme(1)).toBe("light");
  });

  test("boundary at 0.5 returns light", () => {
    expect(luminanceToScheme(0.5)).toBe("light");
  });
});

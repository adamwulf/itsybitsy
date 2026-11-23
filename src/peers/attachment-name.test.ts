import { expect, test } from "bun:test";
import { sanitizeAttachmentName } from "./attachment-name";

test("returns just the final component for either path separator", () => {
  expect(sanitizeAttachmentName("/../../elsewhere/report.txt")).toBe("report.txt");
  expect(sanitizeAttachmentName("..\\dir\\report.txt")).toBe("report.txt");
});

test("strips control and format characters, replaces NUL, and preserves Unicode", () => {
  expect(sanitizeAttachmentName("雪\x1b\u0085\u202e🌻\0.txt")).toBe("雪🌻_.txt");
});

test("unusable basenames fall back", () => {
  for (const name of ["", "/", "../.", "../..", "\u200f\n"]) {
    expect(sanitizeAttachmentName(name)).toBe("attachment");
  }
});

test("cuts at a UTF-8 code point boundary and keeps the extension", () => {
  expect(sanitizeAttachmentName("🌻".repeat(60) + ".写真")).toBe("🌻".repeat(48) + ".写真");
  expect(sanitizeAttachmentName("x." + "雪".repeat(100))).toBe("x." + "雪".repeat(66));
});

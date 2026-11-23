import { expect, test } from "bun:test";
import { rewriteAttachmentPaths } from "./attachment-paths";

const photo = { spellings: ["./old", "~/photo.jpg"], destination: "/tmp/new photo.jpg" };

test("rewrites exact references and every alias, preserving quotes and other text", () => {
  const message = `See ./old  './old'\n"~/photo.jpg" ./old-copy /other/old ./old`;
  expect(rewriteAttachmentPaths(message, [photo])).toBe(`See /tmp/new\\ photo.jpg  '/tmp/new photo.jpg'\n"/tmp/new photo.jpg" ./old-copy /other/old /tmp/new\\ photo.jpg`);
});

test("leaves inline code and fenced blocks intact", () => {
  const code = "`./old`\n```\n./old\n```";
  expect(rewriteAttachmentPaths(code + "\n./old", [photo])).toBe(code + "\n/tmp/new\\ photo.jpg");
});

test("appends only unreferenced destinations in file order using terminal spelling", () => {
  const mappings = [photo, { spellings: ["./seen"], destination: "/tmp/seen" }, { spellings: ["./x"], destination: "/tmp/x#" }];
  expect(rewriteAttachmentPaths("./seen `./old`", mappings)).toBe("/tmp/seen `./old`\n\nAttachments: /tmp/new\\ photo.jpg /tmp/x\\#");
});

test("text-only messages pass through verbatim, including unmatched quotes", () => {
  const text = "Read '/tmp/example";
  expect(rewriteAttachmentPaths(text, [])).toBe(text);
});

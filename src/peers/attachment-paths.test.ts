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

test("punctuation matches exactly first and Markdown link delimiters stay in place", () => {
  const plain = { spellings: ["./file.png"], destination: "/tmp/plain" };
  const literal = { spellings: ["./file.png,"], destination: "/tmp/comma" };
  expect(rewriteAttachmentPaths("[x](./file.png), ./file.png,", [plain, literal])).toBe("[x](/tmp/plain), /tmp/comma");
  expect(rewriteAttachmentPaths("./file.png,", [plain])).toBe("/tmp/plain,");
});

test("repeated space-containing paths match only at a complete token boundary", () => {
  const mapping = [{ spellings: ["./a b.png"], destination: "/tmp/new name" }];
  const input = `"./a b.png".bak "./a b.png" './a b.png' ./a\\ b.png ./a\\ b.png`;
  expect(rewriteAttachmentPaths(input, mapping)).toBe(`"./a b.png".bak "/tmp/new name" '/tmp/new name' /tmp/new\\ name /tmp/new\\ name`);
});

test("code fences require a closing line and inline backtick runs match by width", () => {
  const example = "```js\nconst ticks = '```'; ./old\n```not a close\n./old\n````\n`` example ``` ./old ``";
  expect(rewriteAttachmentPaths(example + " ./old", [photo])).toBe(example + " /tmp/new\\ photo.jpg");
});

test("malformed unrelated references are preserved and valid references still match", () => {
  const text = "\"./unfinished\ninspect ./old ./bad\\";
  expect(rewriteAttachmentPaths(text, [photo])).toBe("\"./unfinished\ninspect /tmp/new\\ photo.jpg ./bad\\");
});

test("bare filenames in prose stay literal and their attachments are appended", () => {
  expect(rewriteAttachmentPaths("inspect file.png", [{ spellings: ["file.png"], destination: "/tmp/one" }]))
    .toBe("inspect file.png\n\nAttachments: /tmp/one");
});

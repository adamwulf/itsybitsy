import { expect, test } from "bun:test";
import { rewriteAttachmentPaths } from "./attachment-paths";

const photo = { spellings: ["./old", "~/photo"], destination: "/tmp/new photo" };
const list = "\n\nAttachments copied to this machine:\n- ./old → /tmp/new\\ photo";

test("replaces literal, escaped, single- and double-quoted paths at whitespace boundaries", () => {
  const mapping = [{ spellings: ["a b.png", "./a b.png"], destination: "/tmp/new name" }];
  const message = `a b.png\t"./a b.png" './a b.png' ./a\\ b.png\na b.png`;
  expect(rewriteAttachmentPaths(message, mapping)).toBe(
    `/tmp/new\\ name\t"/tmp/new name" '/tmp/new name' /tmp/new\\ name\n/tmp/new\\ name` +
    "\n\nAttachments copied to this machine:\n- a b.png → /tmp/new\\ name",
  );
});

test("matches exact transferred spellings regardless of surrounding Markdown", () => {
  expect(rewriteAttachmentPaths("sample: ` ./old ` or ~/photo", [photo]))
    .toBe("sample: ` /tmp/new\\ photo ` or /tmp/new\\ photo" + list);
});

test("leaves punctuation, quoted filename suffixes, URLs and other paths intact", () => {
  const text = 'See ./old, ./old) "./a b.png".bak https://example.com/./old ./old.txt';
  expect(rewriteAttachmentPaths(text, [photo, { spellings: ["./a b.png"], destination: "/tmp/b" }]))
    .toBe(text + list + "\n- ./a b.png → /tmp/b");
});

test("lists all files in manifest order even if every file or no file was rewritten", () => {
  const second = { spellings: ["report", "./report"], destination: "/tmp/report" };
  const block = list + "\n- report → /tmp/report";
  expect(rewriteAttachmentPaths("", [photo, second])).toBe(block);
  expect(rewriteAttachmentPaths("./report ./old", [photo, second])).toBe("/tmp/report /tmp/new\\ photo" + block);
});

test("rewrites only the original text and prefers a longer exact spelling at the same position", () => {
  const files = [{ spellings: ["a"], destination: "b" }, { spellings: ["a b"], destination: "a" }];
  expect(rewriteAttachmentPaths("a b a", files)).toBe("a b\n\nAttachments copied to this machine:\n- a → b\n- a b → a");
});

test("no attachments leave even malformed text untouched", () => {
  expect(rewriteAttachmentPaths("inspect '/tmp/unfinished", [])).toBe("inspect '/tmp/unfinished");
});

test("the expanded text and the mapping share a UTF-8 byte budget", () => {
  const mapping = [{ spellings: ["x", "x"], destination: "📸".repeat(20) }];
  expect(() => rewriteAttachmentPaths("x ".repeat(1000), mapping, 1024)).toThrow("1024 bytes");
});

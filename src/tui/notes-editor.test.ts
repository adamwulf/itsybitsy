import { test, expect, describe } from "bun:test";
import { NotesEditorComponent } from "./notes-editor";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("NotesEditorComponent", () => {
  test("setText splits on newlines", () => {
    const e = new NotesEditorComponent();
    e.setText("a\nb\nc");
    expect(e.getText()).toBe("a\nb\nc");
  });

  test("setText with empty string clears the buffer", () => {
    const e = new NotesEditorComponent();
    e.setText("seeded");
    e.setText("");
    expect(e.getText()).toBe("");
  });

  test("appends printable characters", () => {
    const e = new NotesEditorComponent();
    e.setText("");
    e.handleInput("h");
    e.handleInput("i");
    expect(e.getText()).toBe("hi");
  });

  test("backspace removes the last character", () => {
    const e = new NotesEditorComponent();
    e.setText("abc");
    e.handleInput("\x7f");
    expect(e.getText()).toBe("ab");
  });

  test("Enter inserts a newline", () => {
    const e = new NotesEditorComponent();
    e.setText("a");
    e.handleInput("\r");
    e.handleInput("b");
    expect(e.getText()).toBe("a\nb");
  });

  test("alt+backspace deletes the last word", () => {
    const e = new NotesEditorComponent();
    e.setText("hello world");
    e.handleInput("\x1b\x7f");
    expect(e.getText()).toBe("hello ");
  });

  test("does not consume Tab — dashboard owns sub-field cycling", () => {
    const e = new NotesEditorComponent();
    e.setText("abc");
    expect(e.handleInput("\t")).toBe(false);
    expect(e.getText()).toBe("abc");
  });

  test("does not consume Escape — dashboard owns revert", () => {
    const e = new NotesEditorComponent();
    e.setText("abc");
    expect(e.handleInput("\x1b")).toBe(false);
    expect(e.getText()).toBe("abc");
  });

  test("does not consume Shift-Tab", () => {
    const e = new NotesEditorComponent();
    expect(e.handleInput("\x1b[Z")).toBe(false);
  });

  test("renders placeholder when empty and not active", () => {
    const e = new NotesEditorComponent();
    e.setText("");
    e.active = false;
    const lines = e.render(40).map(stripAnsi);
    expect(lines.join("\n")).toContain("(no notes)");
  });

  test("renders cursor at end when active", () => {
    const e = new NotesEditorComponent();
    e.setText("abc");
    e.active = true;
    const lines = e.render(40).map(stripAnsi);
    expect(lines.join("\n")).toContain("abc█");
  });

  test("scrolls to keep the last line visible when content exceeds visibleLines", () => {
    const e = new NotesEditorComponent();
    e.visibleLines = 3;
    e.setText("l1\nl2\nl3\nl4\nl5");
    e.active = false;
    const lines = e.render(40).map(stripAnsi);
    expect(lines.length).toBe(3);
    // The last logical line should be visible; the first should have scrolled off.
    expect(lines.join("\n")).toContain("l5");
    expect(lines.join("\n")).not.toContain("l1");
  });

  test("wraps long lines within width", () => {
    const e = new NotesEditorComponent();
    e.setText("x".repeat(20));
    e.active = false;
    // width 10 → text width 8 (2-char prefix), so 20 / 8 = 3 wrapped rows.
    const lines = e.render(10).map(stripAnsi);
    const joined = lines.join("");
    // All 20 characters should appear across the wrapped rows.
    expect((joined.match(/x/g) ?? []).length).toBe(20);
  });
});

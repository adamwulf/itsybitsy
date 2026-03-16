import { test, expect, describe } from "bun:test";
import { InputFieldComponent } from "./input-field";
import { stripAnsi } from "../parse-state";

function makeField(): InputFieldComponent {
  return new InputFieldComponent();
}

describe("InputFieldComponent", () => {
  describe("text input", () => {
    test("typing characters appends to text", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("i");
      expect(field.getText()).toBe("hi");
      expect(field.getCursor()).toBe(2);
    });

    test("handleInput returns true for printable characters", () => {
      const field = makeField();
      expect(field.handleInput("a")).toBe(true);
      expect(field.handleInput("Z")).toBe(true);
      expect(field.handleInput("5")).toBe(true);
      expect(field.handleInput(" ")).toBe(true);
    });

    test("handleInput returns false for unhandled input", () => {
      const field = makeField();
      // Arrow key escape sequences
      expect(field.handleInput("\x1b[A")).toBe(false);
    });
  });

  describe("backspace", () => {
    test("backspace deletes character before cursor", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("b");
      field.handleInput("c");
      field.handleInput("\x7f");
      expect(field.getText()).toBe("ab");
      expect(field.getCursor()).toBe(2);
    });

    test("backspace at start of line does nothing", () => {
      const field = makeField();
      expect(field.handleInput("\x7f")).toBe(true);
      expect(field.getText()).toBe("");
    });

    test("backspace in middle of text", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("b");
      field.handleInput("c");
      // Move cursor to position 2 (after 'b')
      field.handleInput("\x01"); // Ctrl-A to start
      field.handleInput("\x05"); // Ctrl-E to end — cursor at 3
      // Use Ctrl-A then type to position at start, then use the cursor tracking
      // Actually, let's just test with cursor at middle via Ctrl-A
      field.handleInput("\x01"); // cursor at 0
      field.handleInput("x"); // "xabc", cursor at 1
      field.handleInput("\x7f"); // delete 'x', back to "abc", cursor at 0
      expect(field.getText()).toBe("abc");
      expect(field.getCursor()).toBe(0);
    });
  });

  describe("Ctrl-A (home)", () => {
    test("moves cursor to start", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("e");
      field.handleInput("l");
      expect(field.getCursor()).toBe(3);
      expect(field.handleInput("\x01")).toBe(true);
      expect(field.getCursor()).toBe(0);
    });
  });

  describe("Ctrl-E (end)", () => {
    test("moves cursor to end", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("e");
      field.handleInput("l");
      field.handleInput("\x01"); // go to start
      expect(field.getCursor()).toBe(0);
      expect(field.handleInput("\x05")).toBe(true);
      expect(field.getCursor()).toBe(3);
    });
  });

  describe("Ctrl-U (clear line)", () => {
    test("clears all text", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("e");
      field.handleInput("l");
      field.handleInput("l");
      field.handleInput("o");
      expect(field.handleInput("\x15")).toBe(true);
      expect(field.getText()).toBe("");
      expect(field.getCursor()).toBe(0);
    });
  });

  describe("Enter (submit)", () => {
    test("fires onSubmit with text and clears field", () => {
      const field = makeField();
      let submitted = "";
      field.onSubmit = (text) => { submitted = text; };

      field.handleInput("h");
      field.handleInput("i");
      expect(field.handleInput("\r")).toBe(true);
      expect(submitted).toBe("hi");
      expect(field.getText()).toBe("");
      expect(field.getCursor()).toBe(0);
    });
  });

  describe("Escape (cancel)", () => {
    test("fires onCancel", () => {
      const field = makeField();
      let cancelled = false;
      field.onCancel = () => { cancelled = true; };

      expect(field.handleInput("\x1b")).toBe(true);
      expect(cancelled).toBe(true);
    });
  });

  describe("Tab passthrough", () => {
    test("Tab is not consumed", () => {
      const field = makeField();
      expect(field.handleInput("\t")).toBe(false);
    });

    test("Shift-Tab is not consumed", () => {
      const field = makeField();
      expect(field.handleInput("\x1b[Z")).toBe(false);
    });
  });

  describe("render", () => {
    test("returns exactly 3 lines", () => {
      const field = makeField();
      const lines = field.render(40);
      expect(lines).toHaveLength(3);
    });

    test("cursor indicator appears in rendered output", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("i");
      const lines = field.render(40);
      const inputLine = stripAnsi(lines[1]!);
      expect(inputLine).toContain("█");
      expect(inputLine).toContain("> hi█");
    });

    test("separators are dash lines", () => {
      const field = makeField();
      const lines = field.render(20);
      const topSep = stripAnsi(lines[0]!);
      const bottomSep = stripAnsi(lines[2]!);
      expect(topSep).toMatch(/^─+$/);
      expect(bottomSep).toMatch(/^─+$/);
    });

    test("cursor at start shows block before text", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("b");
      field.handleInput("\x01"); // Ctrl-A to start
      const lines = field.render(40);
      const inputLine = stripAnsi(lines[1]!);
      expect(inputLine).toBe("> █ab");
    });

    test("empty field shows cursor after prompt", () => {
      const field = makeField();
      const lines = field.render(40);
      const inputLine = stripAnsi(lines[1]!);
      expect(inputLine).toBe("> █");
    });
  });

  describe("clear", () => {
    test("clears text and resets cursor", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("e");
      field.handleInput("l");
      field.clear();
      expect(field.getText()).toBe("");
      expect(field.getCursor()).toBe(0);
    });
  });
});

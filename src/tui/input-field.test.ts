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
    test("backspace deletes character at end of line", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("b");
      field.handleInput("c");
      field.handleInput("\x7f");
      expect(field.getText()).toBe("ab");
    });

    test("backspace at start of line does nothing (single line)", () => {
      const field = makeField();
      expect(field.handleInput("\x7f")).toBe(true);
      expect(field.getText()).toBe("");
    });

    test("backspace joins lines when current line is empty", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("b");
      field.handleInput("\r"); // new line
      expect(field.getLines()).toEqual(["ab", ""]);
      field.handleInput("\x7f"); // backspace joins
      expect(field.getLines()).toEqual(["ab"]);
      expect(field.getText()).toBe("ab");
    });
  });

  describe("multi-line editing", () => {
    test("Enter creates new line", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("i");
      field.handleInput("\r"); // Enter
      expect(field.getLines()).toEqual(["hi", ""]);
      expect(field.getText()).toBe("hi\n");
    });

    test("typing after Enter appends to new line", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("\r");
      field.handleInput("b");
      expect(field.getLines()).toEqual(["a", "b"]);
      expect(field.getText()).toBe("a\nb");
    });

    test("multiple Enter presses create multiple lines", () => {
      const field = makeField();
      field.handleInput("x");
      field.handleInput("\r");
      field.handleInput("\r");
      field.handleInput("y");
      expect(field.getLines()).toEqual(["x", "", "y"]);
    });
  });

  describe("Alt+Backspace (word delete)", () => {
    test("deletes last word on current line", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("e");
      field.handleInput("l");
      field.handleInput("l");
      field.handleInput("o");
      field.handleInput(" ");
      field.handleInput("w");
      field.handleInput("o");
      field.handleInput("r");
      field.handleInput("l");
      field.handleInput("d");
      expect(field.getText()).toBe("hello world");
      // Alt+Backspace
      field.handleInput("\x1b\x7f");
      expect(field.getText()).toBe("hello ");
    });

    test("joins with previous line when current line is empty", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("b");
      field.handleInput("\r"); // new line
      expect(field.getLines()).toEqual(["ab", ""]);
      // Alt+Backspace on empty line joins
      field.handleInput("\x1b\x7f");
      expect(field.getLines()).toEqual(["ab"]);
    });
  });

  describe("Ctrl-U (clear all lines)", () => {
    test("clears all text", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("e");
      field.handleInput("l");
      field.handleInput("\r");
      field.handleInput("l");
      field.handleInput("o");
      expect(field.handleInput("\x15")).toBe(true);
      expect(field.getText()).toBe("");
      expect(field.getLines()).toEqual([""]);
    });
  });

  describe("Ctrl-A and Ctrl-E", () => {
    test("Ctrl-A is consumed", () => {
      const field = makeField();
      field.handleInput("h");
      expect(field.handleInput("\x01")).toBe(true);
    });

    test("Ctrl-E is consumed", () => {
      const field = makeField();
      field.handleInput("h");
      expect(field.handleInput("\x05")).toBe(true);
    });
  });

  describe("Tab / focus cycling", () => {
    test("Tab moves focus to send button", () => {
      const field = makeField();
      expect(field.getFocus()).toBe("text");
      expect(field.handleInput("\t")).toBe(true); // consumed
      expect(field.getFocus()).toBe("send");
    });

    test("Tab from send is not consumed (pass through to dashboard)", () => {
      const field = makeField();
      field.handleInput("\t"); // go to send
      expect(field.getFocus()).toBe("send");
      expect(field.handleInput("\t")).toBe(false); // not consumed
    });

    test("Shift-Tab from text is not consumed", () => {
      const field = makeField();
      expect(field.getFocus()).toBe("text");
      expect(field.handleInput("\x1b[Z")).toBe(false);
    });

    test("Shift-Tab from send returns to text", () => {
      const field = makeField();
      field.handleInput("\t"); // go to send
      expect(field.getFocus()).toBe("send");
      expect(field.handleInput("\x1b[Z")).toBe(true); // consumed
      expect(field.getFocus()).toBe("text");
    });
  });

  describe("Submit (Enter on Send)", () => {
    test("Enter on send button fires onSubmit with joined lines", () => {
      const field = makeField();
      let submitted = "";
      field.onSubmit = (text) => { submitted = text; };

      field.handleInput("h");
      field.handleInput("i");
      field.handleInput("\r"); // new line (not submit — we're in text focus)
      field.handleInput("!"); // second line
      field.handleInput("\t"); // Tab to [Send]
      expect(field.getFocus()).toBe("send");
      field.handleInput("\r"); // Enter on [Send] = submit
      expect(submitted).toBe("hi\n!");
      expect(field.getText()).toBe("");
      expect(field.getFocus()).toBe("text");
    });

    test("Enter in text focus creates new line, does not submit", () => {
      const field = makeField();
      let submitted = "";
      field.onSubmit = (text) => { submitted = text; };

      field.handleInput("h");
      field.handleInput("i");
      field.handleInput("\r"); // Enter in text mode → new line
      expect(submitted).toBe(""); // not submitted
      expect(field.getLines()).toEqual(["hi", ""]);
    });
  });

  describe("Escape (cancel)", () => {
    test("fires onCancel and clears text", () => {
      const field = makeField();
      let cancelled = false;
      field.onCancel = () => { cancelled = true; };

      field.handleInput("h");
      field.handleInput("i");
      expect(field.handleInput("\x1b")).toBe(true);
      expect(cancelled).toBe(true);
      expect(field.getText()).toBe("");
    });
  });

  describe("typing while on Send refocuses to text", () => {
    test("printable char while on send switches back to text", () => {
      const field = makeField();
      field.handleInput("\t"); // go to send
      expect(field.getFocus()).toBe("send");
      field.handleInput("x");
      expect(field.getFocus()).toBe("text");
      expect(field.getText()).toBe("x");
    });
  });

  describe("render", () => {
    test("single-line returns separator + content + bottom separator (3 lines)", () => {
      const field = makeField();
      const lines = field.render(40);
      expect(lines).toHaveLength(3);
    });

    test("multi-line increases render height", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("\r");
      field.handleInput("b");
      const lines = field.render(40);
      expect(lines).toHaveLength(4); // sep + 2 content + sep
    });

    test("cursor indicator appears in rendered output", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("i");
      const lines = field.render(40);
      const inputLine = stripAnsi(lines[1]!);
      expect(inputLine).toContain("█");
      expect(inputLine).toContain("❯ hi█");
    });

    test("top separator is dash line", () => {
      const field = makeField();
      const lines = field.render(20);
      const topSep = stripAnsi(lines[0]!);
      expect(topSep).toMatch(/^─+$/);
    });

    test("bottom separator contains [Send]", () => {
      const field = makeField();
      const lines = field.render(40);
      const bottomSep = stripAnsi(lines[lines.length - 1]!);
      expect(bottomSep).toContain("[Send]");
      expect(bottomSep).toContain("─");
    });

    test("empty field shows cursor after prompt", () => {
      const field = makeField();
      const lines = field.render(40);
      const inputLine = stripAnsi(lines[1]!);
      expect(inputLine).toBe("❯ █");
    });

    test("second line uses indent prefix instead of ❯", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("\r");
      field.handleInput("b");
      const lines = field.render(40);
      const line1 = stripAnsi(lines[1]!);
      const line2 = stripAnsi(lines[2]!);
      expect(line1).toBe("❯ a");
      expect(line2).toContain("  b█"); // indented, with cursor on last line
    });

    test("[Send] button highlighted when focused", () => {
      const field = makeField();
      field.handleInput("\t"); // focus send
      const lines = field.render(40);
      const bottomSep = lines[lines.length - 1]!;
      // When focused on send, should contain bold/green escape codes
      expect(bottomSep).toContain("\x1b[1m"); // BOLD
      expect(bottomSep).toContain("[Send]");
    });

    test("cursor not shown when send is focused", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("i");
      field.handleInput("\t"); // focus send
      const lines = field.render(40);
      const inputLine = stripAnsi(lines[1]!);
      expect(inputLine).toBe("❯ hi"); // no cursor block
    });
  });

  describe("getHeight", () => {
    test("returns 3 for single-line input", () => {
      const field = makeField();
      expect(field.getHeight(40)).toBe(3);
    });

    test("returns 4 for two-line input", () => {
      const field = makeField();
      field.handleInput("a");
      field.handleInput("\r");
      field.handleInput("b");
      expect(field.getHeight(40)).toBe(4);
    });

    test("caps at MAX_VISIBLE_LINES + 2", () => {
      const field = makeField();
      // Create 10 lines
      for (let i = 0; i < 10; i++) {
        field.handleInput("x");
        field.handleInput("\r");
      }
      // MAX_VISIBLE_LINES = 5, so height = 5 + 2 = 7
      expect(field.getHeight(40)).toBe(7);
    });
  });

  describe("clear", () => {
    test("clears text and resets to single empty line", () => {
      const field = makeField();
      field.handleInput("h");
      field.handleInput("e");
      field.handleInput("\r");
      field.handleInput("l");
      field.clear();
      expect(field.getText()).toBe("");
      expect(field.getLines()).toEqual([""]);
      expect(field.getFocus()).toBe("text");
    });
  });

  describe("per-agent buffers", () => {
    test("switchAgent saves and restores text", () => {
      const field = makeField();
      field.switchAgent("agent-a");
      field.handleInput("h");
      field.handleInput("e");
      field.handleInput("l");
      field.handleInput("l");
      field.handleInput("o");
      expect(field.getText()).toBe("hello");

      // Switch to agent-b
      field.switchAgent("agent-b");
      expect(field.getText()).toBe(""); // agent-b has no buffer

      field.handleInput("w");
      field.handleInput("o");
      field.handleInput("r");
      field.handleInput("l");
      field.handleInput("d");
      expect(field.getText()).toBe("world");

      // Switch back to agent-a
      field.switchAgent("agent-a");
      expect(field.getText()).toBe("hello");

      // Switch back to agent-b
      field.switchAgent("agent-b");
      expect(field.getText()).toBe("world");
    });

    test("switchAgent preserves multi-line buffers", () => {
      const field = makeField();
      field.switchAgent("agent-a");
      field.handleInput("l");
      field.handleInput("1");
      field.handleInput("\r");
      field.handleInput("l");
      field.handleInput("2");
      expect(field.getLines()).toEqual(["l1", "l2"]);

      field.switchAgent("agent-b");
      expect(field.getLines()).toEqual([""]);

      field.switchAgent("agent-a");
      expect(field.getLines()).toEqual(["l1", "l2"]);
    });

    test("clear removes per-agent buffer", () => {
      const field = makeField();
      field.switchAgent("agent-a");
      field.handleInput("x");
      field.clear();

      field.switchAgent("agent-b");
      field.switchAgent("agent-a");
      expect(field.getText()).toBe(""); // cleared buffer not restored
    });

    test("submit clears per-agent buffer", () => {
      const field = makeField();
      field.switchAgent("agent-a");
      let submitted = "";
      field.onSubmit = (text) => { submitted = text; };

      field.handleInput("x");
      field.handleInput("\t"); // Tab to send
      field.handleInput("\r"); // Submit
      expect(submitted).toBe("x");

      // Switch away and back — buffer should be gone
      field.switchAgent("agent-b");
      field.switchAgent("agent-a");
      expect(field.getText()).toBe("");
    });

    test("switchAgent to null saves current buffer", () => {
      const field = makeField();
      field.switchAgent("agent-a");
      field.handleInput("x");
      field.switchAgent(null);
      expect(field.getText()).toBe("");

      field.switchAgent("agent-a");
      expect(field.getText()).toBe("x");
    });

    test("empty buffer is not saved", () => {
      const field = makeField();
      field.switchAgent("agent-a");
      // Don't type anything
      field.switchAgent("agent-b");
      field.switchAgent("agent-a");
      expect(field.getText()).toBe(""); // no stale buffer
    });
  });
});

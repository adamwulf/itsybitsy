import { test, expect, describe } from "bun:test";
import { FocusManager, buildFocusSeparator } from "./focus";
import type { FocusTarget } from "./focus";
import { RESET, BOLD, DIM, DIM_GRAY, REVERSE } from "./colors";

describe("FocusManager", () => {
  test("defaults to agent-tree on startup", () => {
    const fm = new FocusManager();
    expect(fm.current()).toBe("agent-tree");
  });

  test("accepts a custom initial focus", () => {
    const fm = new FocusManager("coordinator");
    expect(fm.current()).toBe("coordinator");
  });

  test("cycle(+1) moves forward through focus order", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(1);
    expect(fm.current()).toBe("coordinator");
    fm.cycle(1);
    expect(fm.current()).toBe("active-agent");
  });

  test("cycle(+1) wraps from active-agent back to agent-tree", () => {
    const fm = new FocusManager("active-agent");
    fm.cycle(1);
    expect(fm.current()).toBe("agent-tree");
  });

  test("cycle(-1) moves backward through focus order", () => {
    const fm = new FocusManager("active-agent");
    fm.cycle(-1);
    expect(fm.current()).toBe("coordinator");
    fm.cycle(-1);
    expect(fm.current()).toBe("agent-tree");
  });

  test("cycle(-1) wraps from agent-tree to active-agent", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(-1);
    expect(fm.current()).toBe("active-agent");
  });

  test("full forward cycle returns to start", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(1); // coordinator
    fm.cycle(1); // active-agent
    fm.cycle(1); // agent-tree
    expect(fm.current()).toBe("agent-tree");
  });

  test("full backward cycle returns to start", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(-1); // active-agent
    fm.cycle(-1); // coordinator
    fm.cycle(-1); // agent-tree
    expect(fm.current()).toBe("agent-tree");
  });

  test("setFocus() jumps directly to a target", () => {
    const fm = new FocusManager("agent-tree");
    fm.setFocus("active-agent");
    expect(fm.current()).toBe("active-agent");
    fm.setFocus("coordinator");
    expect(fm.current()).toBe("coordinator");
    fm.setFocus("agent-tree");
    expect(fm.current()).toBe("agent-tree");
  });

  test("setFocus() then cycle() continues from new position", () => {
    const fm = new FocusManager("agent-tree");
    fm.setFocus("coordinator");
    fm.cycle(1);
    expect(fm.current()).toBe("active-agent");
  });

  test("multiple rapid cycles are stable", () => {
    const fm = new FocusManager("agent-tree");
    for (let i = 0; i < 100; i++) fm.cycle(1);
    // 100 % 3 = 1, so should be at index 1 = coordinator
    expect(fm.current()).toBe("coordinator");
  });
});

describe("buildFocusSeparator", () => {
  test("focused separator contains REVERSE escape code", () => {
    const sep = buildFocusSeparator("Agents", 30, true);
    expect(sep).toContain(REVERSE);
    expect(sep).toContain("Agents");
  });

  test("unfocused separator contains DIM escape code", () => {
    const sep = buildFocusSeparator("Agents", 30, false);
    expect(sep).toContain(DIM);
    expect(sep).toContain("Agents");
    expect(sep).not.toContain(REVERSE);
  });

  test("focused separator uses BOLD for title", () => {
    const sep = buildFocusSeparator("Info", 20, true);
    expect(sep).toContain(BOLD);
  });

  test("separator contains dash characters", () => {
    const sep = buildFocusSeparator("Test", 20, true);
    expect(sep).toContain("─");
  });

  test("separator handles width equal to title length", () => {
    // " Title " = 7 chars, width = 7 means 0 dashes
    const sep = buildFocusSeparator("Title", 7, false);
    expect(sep).toContain("Title");
  });

  test("separator handles width smaller than title", () => {
    // Should not crash, just no dashes
    const sep = buildFocusSeparator("Very Long Title", 5, false);
    expect(sep).toContain("Very Long Title");
  });

  test("focused and unfocused separators are visually distinct", () => {
    const focused = buildFocusSeparator("Agents", 30, true);
    const unfocused = buildFocusSeparator("Agents", 30, false);
    expect(focused).not.toBe(unfocused);
  });
});

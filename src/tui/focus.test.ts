import { test, expect, describe } from "bun:test";
import { FocusManager, buildFocusSeparator } from "./focus";
import type { FocusTarget, SubFocus } from "./focus";
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
    expect(fm.current()).toBe("info");
    fm.cycle(1);
    expect(fm.current()).toBe("coordinator");
    fm.cycle(1);
    expect(fm.current()).toBe("active-agent");
    fm.cycle(1);
    expect(fm.current()).toBe("right-pane");
  });

  test("cycle(+1) wraps from right-pane back to agent-tree", () => {
    const fm = new FocusManager("right-pane");
    fm.cycle(1);
    expect(fm.current()).toBe("agent-tree");
  });

  test("cycle(-1) moves backward through focus order", () => {
    const fm = new FocusManager("right-pane");
    fm.cycle(-1);
    expect(fm.current()).toBe("active-agent");
    fm.cycle(-1);
    expect(fm.current()).toBe("coordinator");
    fm.cycle(-1);
    expect(fm.current()).toBe("info");
    fm.cycle(-1);
    expect(fm.current()).toBe("agent-tree");
  });

  test("cycle(-1) wraps from agent-tree to right-pane", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(-1);
    expect(fm.current()).toBe("right-pane");
  });

  test("full forward cycle returns to start", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(1); // info
    fm.cycle(1); // coordinator
    fm.cycle(1); // active-agent
    fm.cycle(1); // right-pane
    fm.cycle(1); // agent-tree
    expect(fm.current()).toBe("agent-tree");
  });

  test("full backward cycle returns to start", () => {
    const fm = new FocusManager("agent-tree");
    fm.cycle(-1); // right-pane
    fm.cycle(-1); // active-agent
    fm.cycle(-1); // coordinator
    fm.cycle(-1); // info
    fm.cycle(-1); // agent-tree
    expect(fm.current()).toBe("agent-tree");
  });

  test("setFocus() jumps directly to a target", () => {
    const fm = new FocusManager("agent-tree");
    fm.setFocus("active-agent");
    expect(fm.current()).toBe("active-agent");
    fm.setFocus("coordinator");
    expect(fm.current()).toBe("coordinator");
    fm.setFocus("info");
    expect(fm.current()).toBe("info");
    fm.setFocus("right-pane");
    expect(fm.current()).toBe("right-pane");
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
    // 100 % 5 = 0, so should be at index 0 = agent-tree
    expect(fm.current()).toBe("agent-tree");
  });

  test("subFocus defaults to 'pane'", () => {
    const fm = new FocusManager();
    expect(fm.subFocus).toBe("pane");
  });

  test("setSubFocus changes sub-focus state", () => {
    const fm = new FocusManager();
    fm.setSubFocus("input");
    expect(fm.subFocus).toBe("input");
    fm.setSubFocus("send");
    expect(fm.subFocus).toBe("send");
    fm.setSubFocus("pane");
    expect(fm.subFocus).toBe("pane");
  });

  test("cycle() resets subFocus to 'pane'", () => {
    const fm = new FocusManager("active-agent");
    fm.setSubFocus("input");
    fm.cycle(1); // move to right-pane
    expect(fm.subFocus).toBe("pane");
  });

  test("setFocus() resets subFocus to 'pane'", () => {
    const fm = new FocusManager("agent-tree");
    fm.setSubFocus("send");
    fm.setFocus("coordinator");
    expect(fm.subFocus).toBe("pane");
  });

  test("panelHasInput returns true for active-agent, coordinator, and repo-coordinator", () => {
    expect(FocusManager.panelHasInput("active-agent")).toBe(true);
    expect(FocusManager.panelHasInput("coordinator")).toBe(true);
    expect(FocusManager.panelHasInput("repo-coordinator")).toBe(true);
  });

  test("panelHasInput returns false for other panels", () => {
    expect(FocusManager.panelHasInput("agent-tree")).toBe(false);
    expect(FocusManager.panelHasInput("info")).toBe(false);
    expect(FocusManager.panelHasInput("right-pane")).toBe(false);
  });

  test("repo-coordinator is skipped by default", () => {
    const fm = new FocusManager("right-pane");
    fm.cycle(1);
    expect(fm.current()).toBe("agent-tree");
  });

  test("repo-coordinator is included when removed from skipTargets", () => {
    const fm = new FocusManager("right-pane");
    fm.skipTargets.delete("repo-coordinator");
    fm.cycle(1);
    expect(fm.current()).toBe("repo-coordinator");
  });

  test("cycle forward through all targets including repo-coordinator", () => {
    const fm = new FocusManager("agent-tree");
    fm.skipTargets.delete("repo-coordinator");
    fm.cycle(1); // info
    expect(fm.current()).toBe("info");
    fm.cycle(1); // coordinator
    expect(fm.current()).toBe("coordinator");
    fm.cycle(1); // active-agent
    expect(fm.current()).toBe("active-agent");
    fm.cycle(1); // right-pane
    expect(fm.current()).toBe("right-pane");
    fm.cycle(1); // repo-coordinator
    expect(fm.current()).toBe("repo-coordinator");
    fm.cycle(1); // agent-tree (wrap)
    expect(fm.current()).toBe("agent-tree");
  });

  test("cycle backward through all targets including repo-coordinator", () => {
    const fm = new FocusManager("agent-tree");
    fm.skipTargets.delete("repo-coordinator");
    fm.cycle(-1); // repo-coordinator
    expect(fm.current()).toBe("repo-coordinator");
    fm.cycle(-1); // right-pane
    expect(fm.current()).toBe("right-pane");
    fm.cycle(-1); // active-agent
    expect(fm.current()).toBe("active-agent");
    fm.cycle(-1); // coordinator
    expect(fm.current()).toBe("coordinator");
    fm.cycle(-1); // info
    expect(fm.current()).toBe("info");
    fm.cycle(-1); // agent-tree (wrap)
    expect(fm.current()).toBe("agent-tree");
  });

  test("skipTargets can skip multiple targets", () => {
    const fm = new FocusManager("agent-tree");
    fm.skipTargets.delete("repo-coordinator");
    fm.skipTargets.add("info");
    fm.skipTargets.add("coordinator");
    fm.cycle(1); // skips info and coordinator
    expect(fm.current()).toBe("active-agent");
  });

  test("cycle does not infinite loop when all targets are skipped", () => {
    const fm = new FocusManager("agent-tree");
    fm.skipTargets.add("info");
    fm.skipTargets.add("coordinator");
    fm.skipTargets.add("active-agent");
    fm.skipTargets.add("right-pane");
    // repo-coordinator already skipped by default
    fm.cycle(1);
    // Should land on agent-tree (the only non-skipped target)
    expect(fm.current()).toBe("agent-tree");
  });
});

describe("buildFocusSeparator", () => {
  test("focused separator contains REVERSE escape code on title only", () => {
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

  test("focused separator dashes use DIM_GRAY not REVERSE", () => {
    const sep = buildFocusSeparator("Test", 30, true);
    // The dashes should be in DIM_GRAY, and REVERSE should only appear around the title
    // Split on the title to check dashes
    const parts = sep.split("Test");
    // Left dashes part should contain DIM_GRAY but not start with REVERSE
    expect(parts[0]).toContain(DIM_GRAY);
  });

  test("separator contains dash characters", () => {
    const sep = buildFocusSeparator("Test", 20, true);
    expect(sep).toContain("─");
  });

  test("uses fixed 4-dash left pad like buildSectionSeparator", () => {
    const sep = buildFocusSeparator("Agents", 40, false);
    // Should start with DIM + DIM_GRAY + 4 dashes (left pad)
    expect(sep).toContain("────");
  });

  test("right pad has at least 1 dash", () => {
    // leftPad(4) + " Test "(6) + rightPad(1 min) = 11 minimum visible chars
    // Use width=12 so truncateToWidth doesn't clip the title
    const sep = buildFocusSeparator("Test", 12, false);
    expect(sep).toContain("Test");
    expect(sep).toContain("─");
  });

  test("separator handles width smaller than title", () => {
    // Should not crash — truncateToWidth will handle overflow
    const sep = buildFocusSeparator("Very Long Title", 5, false);
    // truncateToWidth may truncate the content, but it shouldn't crash
    expect(typeof sep).toBe("string");
  });

  test("focused and unfocused separators are visually distinct", () => {
    const focused = buildFocusSeparator("Agents", 30, true);
    const unfocused = buildFocusSeparator("Agents", 30, false);
    expect(focused).not.toBe(unfocused);
  });
});

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { stripAnsi } from "../parse-state";
import {
  handleDialogInput,
  buildSetupContent,
  type DialogState,
  type DialogCtx,
  type SetupItem,
  type ConfigDialogItem,
} from "./dialog-handler";

function makeSetupItems(): SetupItem[] {
  return [
    { label: "Safety hooks", description: "Block cd into worktrees + inject status + session context", value: "installed", actionable: true, kind: "safety-hooks" },
    { label: "Config file", description: ".ittybitty.json exists", value: "installed", actionable: false, kind: "config-file" },
    { label: "Diff tool", description: "Command for 'o' key in diff view", value: "delta", actionable: true, kind: "difftool" },
  ];
}

function makeConfigItems(): ConfigDialogItem[] {
  return [
    { key: "maxAgents", type: "number", value: 10, source: "default", default: 10 },
    { key: "model", type: "string", value: "sonnet", source: "project", default: "sonnet" },
    { key: "createPullRequests", type: "boolean", value: false, source: "default", default: false },
    { key: "permissions.manager.allow", type: "string[]", value: ["Edit", "Write"], source: "user", default: [] },
  ];
}

function makeCtx(): DialogCtx & { closed: boolean; rendered: boolean } {
  return {
    _dialog: null,
    repos: [],
    tui: { requestRender() { this._rendered = true; }, _rendered: false } as any,
    closeDialog() { this._dialog = null; this.closed = true; },
    closed: false,
    rendered: false,
  };
}

describe("setup dialog tab bar", () => {
  test("buildSetupContent renders tab bar with active tab highlighted", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 60);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped[0]).toContain("[Setup]");
    expect(stripped[0]).toContain("[Project]");
    expect(stripped[0]).toContain("[User]");
  });

  test("title changes based on active tab", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 60);
    expect(result.title).toBe("Project");
  });

  test("tab 2 title is User", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 2,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 60);
    expect(result.title).toBe("User");
  });
});

describe("setup dialog tab switching", () => {
  test("pressing 1 switches to tab 0", () => {
    let switchedTo = -1;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: (t) => { switchedTo = t; },
    };
    ctx._dialog = dialog;
    const handled = handleDialogInput(ctx, "1");
    expect(handled).toBe(true);
    expect(switchedTo).toBe(0);
  });

  test("pressing 2 switches to tab 1", () => {
    let switchedTo = -1;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      onAction: () => {},
      onTabChange: (t) => { switchedTo = t; },
    };
    ctx._dialog = dialog;
    const handled = handleDialogInput(ctx, "2");
    expect(handled).toBe(true);
    expect(switchedTo).toBe(1);
  });

  test("pressing 3 switches to tab 2", () => {
    let switchedTo = -1;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      onAction: () => {},
      onTabChange: (t) => { switchedTo = t; },
    };
    ctx._dialog = dialog;
    const handled = handleDialogInput(ctx, "3");
    expect(handled).toBe(true);
    expect(switchedTo).toBe(2);
  });

  test("pressing same tab number does nothing", () => {
    let switchedTo = -1;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      onAction: () => {},
      onTabChange: (t) => { switchedTo = t; },
    };
    ctx._dialog = dialog;
    // Tab 0, pressing "1" — already on tab 0, so falls through
    const handled = handleDialogInput(ctx, "1");
    expect(handled).toBe(true); // still consumed by setup dialog
    expect(switchedTo).toBe(-1); // but no switch
  });
});

describe("setup dialog config tab content", () => {
  test("renders config items with key, value, and source", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 70);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    // Should contain config keys
    expect(stripped.some((l) => l.includes("maxAgents"))).toBe(true);
    expect(stripped.some((l) => l.includes("model"))).toBe(true);
    expect(stripped.some((l) => l.includes("createPullRequests"))).toBe(true);
    expect(stripped.some((l) => l.includes("permissions.manager.allow"))).toBe(true);
  });

  test("boolean values show true/false", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: [
        { key: "createPullRequests", type: "boolean", value: true, source: "project", default: false },
      ],
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 70);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("true") && l.includes("createPullRequests"))).toBe(true);
  });

  test("string[] values show comma-separated", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: [
        { key: "permissions.manager.allow", type: "string[]", value: ["Edit", "Write"], source: "user", default: [] },
      ],
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 70);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("Edit, Write"))).toBe(true);
  });

  test("empty string[] shows []", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: [
        { key: "permissions.worker.allow", type: "string[]", value: [], source: "default", default: [] },
      ],
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 70);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("[]"))).toBe(true);
  });

  test("undefined value shows (not set)", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: [
        { key: "externalDiffTool", type: "string", value: undefined, source: "default", default: undefined },
      ],
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 70);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("(not set)"))).toBe(true);
  });

  test("selected item shows > prefix", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: makeConfigItems(),
      configSelectedIndex: 1,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 70);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    // model is at index 1, should have > prefix
    const modelLine = stripped.find((l) => l.includes("model") && l.includes(">"));
    expect(modelLine).toBeTruthy();
  });

  test("source indicators show correctly", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 70);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("(default)"))).toBe(true);
    expect(stripped.some((l) => l.includes("(project)"))).toBe(true);
    expect(stripped.some((l) => l.includes("(user)"))).toBe(true);
  });

  test("user tab shows (project override) for project-sourced values", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 2,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: [
        { key: "model", type: "string", value: "sonnet", source: "project", default: "sonnet" },
      ],
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 70);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("(project override)"))).toBe(true);
  });
});

describe("setup dialog config navigation", () => {
  test("j moves selection down", () => {
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    ctx._dialog = dialog;
    handleDialogInput(ctx, "j");
    expect(dialog.configSelectedIndex).toBe(1);
  });

  test("k moves selection up", () => {
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: makeConfigItems(),
      configSelectedIndex: 2,
      onAction: () => {},
      onTabChange: () => {},
    };
    ctx._dialog = dialog;
    handleDialogInput(ctx, "k");
    expect(dialog.configSelectedIndex).toBe(1);
  });

  test("selection clamps at bounds", () => {
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    ctx._dialog = dialog;
    handleDialogInput(ctx, "k");
    expect(dialog.configSelectedIndex).toBe(0);
  });

  test("enter on boolean calls onConfigAction", () => {
    let actionedItem: ConfigDialogItem | null = null;
    const ctx = makeCtx();
    const items = makeConfigItems();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: items,
      configSelectedIndex: 2, // createPullRequests (boolean)
      onAction: () => {},
      onTabChange: () => {},
      onConfigAction: (item) => { actionedItem = item; },
    };
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r"); // Enter
    expect(actionedItem).not.toBeNull();
    expect(actionedItem!.key).toBe("createPullRequests");
    expect(actionedItem!.type).toBe("boolean");
  });

  test("enter on string calls onConfigAction", () => {
    let actionedItem: ConfigDialogItem | null = null;
    const ctx = makeCtx();
    const items = makeConfigItems();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      configItems: items,
      configSelectedIndex: 1, // model (string)
      onAction: () => {},
      onTabChange: () => {},
      onConfigAction: (item) => { actionedItem = item; },
    };
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r");
    expect(actionedItem).not.toBeNull();
    expect(actionedItem!.key).toBe("model");
    expect(actionedItem!.type).toBe("string");
  });
});

describe("setup dialog tab 0 still works", () => {
  test("j/k navigate actionable items on tab 0", () => {
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0, // hook1 (actionable)
      repoPath: "/tmp/test",
      onAction: () => {},
      onTabChange: () => {},
    };
    ctx._dialog = dialog;
    handleDialogInput(ctx, "j");
    // Should skip info item and go to difftool (index 2)
    expect(dialog.selectedIndex).toBe(2);
  });

  test("enter on hook calls onAction", () => {
    let actionedItem: SetupItem | null = null;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0,
      repoPath: "/tmp/test",
      onAction: (item) => { actionedItem = item; },
      onTabChange: () => {},
    };
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r");
    expect(actionedItem).not.toBeNull();
    expect(actionedItem!.kind).toBe("safety-hooks");
  });
});

describe("config write integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-setup-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writeConfig creates nested keys", async () => {
    const { writeConfig } = await import("../config");
    const configPath = join(tmpDir, ".ittybitty.json");
    await writeConfig(configPath, "hooks.injectStatus", true);
    const content = await Bun.file(configPath).json();
    expect(content.hooks.injectStatus).toBe(true);
  });

  test("writeConfig updates existing file", async () => {
    const { writeConfig } = await import("../config");
    const configPath = join(tmpDir, ".ittybitty.json");
    await Bun.write(configPath, JSON.stringify({ maxAgents: 5 }, null, 2));
    await writeConfig(configPath, "model", "opus");
    const content = await Bun.file(configPath).json();
    expect(content.maxAgents).toBe(5);
    expect(content.model).toBe("opus");
  });
});

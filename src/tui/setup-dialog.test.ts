import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { stripAnsi } from "../parse-state";
import {
  handleDialogInput,
  buildSetupContent,
  buildPermissionsEditorContent,
  type DialogState,
  type DialogCtx,
  type SetupItem,
  type ConfigDialogItem,
} from "./dialog-handler";

function makeSetupItems(): SetupItem[] {
  return [
    { label: "Safety hooks", description: "Block cd into worktrees + inject status + session context", value: "installed", actionable: true, kind: "safety-hooks" },
    { label: "Task interception", description: "Redirect Task tool calls to spawn ib agents", value: "not installed", actionable: true, kind: "intercept-hook" },
  ];
}

function makeConfigItems(): ConfigDialogItem[] {
  return [
    { key: "maxAgents", type: "number", value: 10, source: "default", default: 10 },
    { key: "model", type: "string", value: "sonnet", source: "user", default: "sonnet" },
    { key: "createPullRequests", type: "boolean", value: false, source: "default", default: false },
    { key: "permissions.coordinator.allow", type: "string[]", value: ["Edit", "Write"], source: "user", default: [] },
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

      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 60);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped[0]).toContain("[Hooks]");
    expect(stripped[0]).toContain("[Config]");
  });

  test("title changes based on active tab", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,

      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 60);
    expect(result.title).toBe("Config");
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

      onAction: () => {},
      onTabChange: (t) => { switchedTo = t; },
    };
    ctx._dialog = dialog;
    const handled = handleDialogInput(ctx, "2");
    expect(handled).toBe(true);
    expect(switchedTo).toBe(1);
  });

  test("Tab key cycles to next tab", () => {
    let switchedTo = -1;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0,

      onAction: () => {},
      onTabChange: (t) => { switchedTo = t; },
    };
    ctx._dialog = dialog;
    const handled = handleDialogInput(ctx, "\t");
    expect(handled).toBe(true);
    expect(switchedTo).toBe(1);
  });

  test("Tab key wraps from last tab to first", () => {
    let switchedTo = -1;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,

      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: (t) => { switchedTo = t; },
    };
    ctx._dialog = dialog;
    const handled = handleDialogInput(ctx, "\t");
    expect(handled).toBe(true);
    expect(switchedTo).toBe(0);
  });

  test("Shift+Tab cycles to previous tab", () => {
    let switchedTo = -1;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,

      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: (t) => { switchedTo = t; },
    };
    ctx._dialog = dialog;
    const handled = handleDialogInput(ctx, "\x1b[Z");
    expect(handled).toBe(true);
    expect(switchedTo).toBe(0);
  });

  test("Shift+Tab wraps from first tab to last", () => {
    let switchedTo = -1;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0,

      onAction: () => {},
      onTabChange: (t) => { switchedTo = t; },
    };
    ctx._dialog = dialog;
    const handled = handleDialogInput(ctx, "\x1b[Z");
    expect(handled).toBe(true);
    expect(switchedTo).toBe(1);
  });

  test("pressing same tab number does nothing", () => {
    let switchedTo = -1;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0,

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
    expect(stripped.some((l) => l.includes("permissions.coordinator.allow"))).toBe(true);
  });

  test("boolean values show true/false", () => {
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 1,
      items: makeSetupItems(),
      selectedIndex: 0,

      configItems: [
        { key: "createPullRequests", type: "boolean", value: true, source: "user", default: false },
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

      configItems: [
        { key: "permissions.coordinator.allow", type: "string[]", value: ["Edit", "Write"], source: "user", default: [] },
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

      configItems: [
        { key: "permissions.repo.allow", type: "string[]", value: [], source: "default", default: [] },
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

      configItems: makeConfigItems(),
      configSelectedIndex: 0,
      onAction: () => {},
      onTabChange: () => {},
    };
    const result = buildSetupContent(dialog, 70);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("(default)"))).toBe(true);
    expect(stripped.some((l) => l.includes("(user)"))).toBe(true);
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

      onAction: () => {},
      onTabChange: () => {},
    };
    ctx._dialog = dialog;
    handleDialogInput(ctx, "j");
    // Should go to intercept-hook (index 1)
    expect(dialog.selectedIndex).toBe(1);
  });

  test("enter on hook calls onAction", () => {
    let actionedItem: SetupItem | null = null;
    const ctx = makeCtx();
    const dialog: Extract<NonNullable<DialogState>, { type: "setup" }> = {
      type: "setup",
      tab: 0,
      items: makeSetupItems(),
      selectedIndex: 0,

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
    const configPath = join(tmpDir, "config.json");
    await writeConfig(configPath, "hooks.injectStatus", true);
    const content = await Bun.file(configPath).json();
    expect(content.hooks.injectStatus).toBe(true);
  });

  test("writeConfig updates existing file", async () => {
    const { writeConfig } = await import("../config");
    const configPath = join(tmpDir, "config.json");
    await Bun.write(configPath, JSON.stringify({ maxAgents: 5 }, null, 2));
    await writeConfig(configPath, "model", "opus");
    const content = await Bun.file(configPath).json();
    expect(content.maxAgents).toBe(5);
    expect(content.model).toBe("opus");
  });
});

// --- Permissions editor dialog tests ---

function makePermsDialog(overrides?: Partial<Extract<NonNullable<DialogState>, { type: "permissions-editor" }>>): Extract<NonNullable<DialogState>, { type: "permissions-editor" }> {
  return {
    type: "permissions-editor",
    roleKey: "permissions.coordinator",
    tab: 0,
    allowList: ["Edit", "Write"],
    denyList: ["Bash"],
    focus: 0,
    inputMode: false,
    inputValue: "",
    scrollOffset: 0,
    onSave: () => {},
    ...overrides,
  };
}

describe("permissions editor rendering", () => {
  test("renders title with role name", () => {
    const dialog = makePermsDialog();
    const result = buildPermissionsEditorContent(dialog, 60);
    expect(result.title).toBe("Coordinator Permissions");
  });

  test("renders title for repo role", () => {
    const dialog = makePermsDialog({ roleKey: "permissions.repo" });
    const result = buildPermissionsEditorContent(dialog, 60);
    expect(result.title).toBe("Repo Permissions");
  });

  test("renders tab bar with Allow and Deny", () => {
    const dialog = makePermsDialog();
    const result = buildPermissionsEditorContent(dialog, 60);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped[0]).toContain("[Allow]");
    expect(stripped[0]).toContain("[Deny]");
  });

  test("renders allow list items on allow tab", () => {
    const dialog = makePermsDialog();
    const result = buildPermissionsEditorContent(dialog, 60);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("Edit") && l.includes("[Del]"))).toBe(true);
    expect(stripped.some((l) => l.includes("Write") && l.includes("[Del]"))).toBe(true);
  });

  test("renders deny list items on deny tab", () => {
    const dialog = makePermsDialog({ tab: 1 });
    const result = buildPermissionsEditorContent(dialog, 60);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("Bash") && l.includes("[Del]"))).toBe(true);
  });

  test("renders Add field", () => {
    const dialog = makePermsDialog();
    const result = buildPermissionsEditorContent(dialog, 60);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("Add:"))).toBe(true);
  });

  test("renders Done button", () => {
    const dialog = makePermsDialog();
    const result = buildPermissionsEditorContent(dialog, 60);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("[ Done ]"))).toBe(true);
  });

  test("shows cursor in input mode", () => {
    const dialog = makePermsDialog({ inputMode: true, inputValue: "Read" });
    const result = buildPermissionsEditorContent(dialog, 60);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("Add: Read"))).toBe(true);
  });

  test("empty list shows only Add and Done", () => {
    const dialog = makePermsDialog({ allowList: [], denyList: [] });
    const result = buildPermissionsEditorContent(dialog, 60);
    const stripped = result.contentLines.map((l) => stripAnsi(l));
    expect(stripped.some((l) => l.includes("[Del]"))).toBe(false);
    expect(stripped.some((l) => l.includes("Add:"))).toBe(true);
    expect(stripped.some((l) => l.includes("[ Done ]"))).toBe(true);
  });
});

describe("permissions editor navigation", () => {
  test("j moves focus down", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog();
    ctx._dialog = dialog;
    handleDialogInput(ctx, "j");
    expect(dialog.focus).toBe(1);
  });

  test("k moves focus up", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ focus: 1 });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "k");
    expect(dialog.focus).toBe(0);
  });

  test("focus clamps at 0", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ focus: 0 });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "k");
    expect(dialog.focus).toBe(0);
  });

  test("focus can reach Add and Done", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ focus: 1 }); // last item (Write)
    ctx._dialog = dialog;
    handleDialogInput(ctx, "j"); // focus = 2 = Add (list has 2 items)
    expect(dialog.focus).toBe(2);
    handleDialogInput(ctx, "j"); // focus = 3 = Done
    expect(dialog.focus).toBe(3);
  });

  test("left arrow switches to Allow tab", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ tab: 1 });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\x1b[D"); // left arrow
    expect(dialog.tab).toBe(0);
    expect(dialog.focus).toBe(0);
  });

  test("right arrow switches to Deny tab", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ tab: 0 });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\x1b[C"); // right arrow
    expect(dialog.tab).toBe(1);
    expect(dialog.focus).toBe(0);
  });

  test("escape closes dialog", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog();
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\x1b"); // escape
    expect(ctx._dialog).toBeNull();
  });
});

describe("permissions editor add/delete", () => {
  test("enter on Add activates input mode", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ focus: 2 }); // focus on Add (2 items in allow)
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r");
    expect(dialog.inputMode).toBe(true);
    expect(dialog.inputValue).toBe("");
  });

  test("typing in input mode appends characters", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ inputMode: true, inputValue: "" });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "R");
    handleDialogInput(ctx, "e");
    handleDialogInput(ctx, "a");
    handleDialogInput(ctx, "d");
    expect(dialog.inputValue).toBe("Read");
  });

  test("enter in input mode adds item to current list", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ inputMode: true, inputValue: "Read" });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r");
    expect(dialog.allowList).toEqual(["Edit", "Write", "Read"]);
    expect(dialog.inputMode).toBe(false);
    expect(dialog.inputValue).toBe("");
  });

  test("enter in input mode adds to deny list when on deny tab", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ tab: 1, inputMode: true, inputValue: "WebFetch" });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r");
    expect(dialog.denyList).toEqual(["Bash", "WebFetch"]);
    expect(dialog.inputMode).toBe(false);
  });

  test("enter on list item deletes it", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ focus: 0 }); // focus on "Edit"
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r");
    expect(dialog.allowList).toEqual(["Write"]);
  });

  test("enter on second item deletes it", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ focus: 1 }); // focus on "Write"
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r");
    expect(dialog.allowList).toEqual(["Edit"]);
  });

  test("backspace in input mode removes last character", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ inputMode: true, inputValue: "Read" });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\x7f"); // backspace
    expect(dialog.inputValue).toBe("Rea");
  });

  test("escape in input mode exits input mode", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ inputMode: true, inputValue: "partial" });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\x1b"); // escape
    expect(dialog.inputMode).toBe(false);
    expect(dialog.inputValue).toBe("");
  });

  test("empty input on enter does not add item", () => {
    const ctx = makeCtx();
    const dialog = makePermsDialog({ inputMode: true, inputValue: "   " });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r");
    // Whitespace-only should be trimmed and not added
    expect(dialog.allowList).toEqual(["Edit", "Write"]);
    expect(dialog.inputMode).toBe(false);
  });
});

describe("permissions editor save", () => {
  test("enter on Done calls onSave with both lists", () => {
    let savedAllow: string[] = [];
    let savedDeny: string[] = [];
    let saveCalled = false;
    const ctx = makeCtx();
    const dialog = makePermsDialog({
      focus: 3, // Done button (2 items + Add + Done)
      onSave: (allow, deny) => { savedAllow = allow; savedDeny = deny; saveCalled = true; },
    });
    ctx._dialog = dialog;
    handleDialogInput(ctx, "\r");
    expect(saveCalled).toBe(true);
    expect(savedAllow).toEqual(["Edit", "Write"]);
    expect(savedDeny).toEqual(["Bash"]);
  });

  test("save reflects modifications to lists", () => {
    let savedAllow: string[] = [];
    let savedDeny: string[] = [];
    let saveCalled = false;
    const ctx = makeCtx();
    const dialog = makePermsDialog({
      onSave: (allow, deny) => { savedAllow = allow; savedDeny = deny; saveCalled = true; },
    });
    ctx._dialog = dialog;

    // Delete first allow item
    dialog.focus = 0;
    handleDialogInput(ctx, "\r"); // deletes "Edit"
    expect(dialog.allowList).toEqual(["Write"]);

    // Add a new item
    dialog.focus = 1; // Add button (1 item remaining)
    handleDialogInput(ctx, "\r"); // enter input mode
    dialog.inputValue = "Read";
    handleDialogInput(ctx, "\r"); // add it
    expect(dialog.allowList).toEqual(["Write", "Read"]);

    // Save
    dialog.focus = 3; // Done (2 items + Add + Done)
    handleDialogInput(ctx, "\r");
    expect(saveCalled).toBe(true);
    expect(savedAllow).toEqual(["Write", "Read"]);
    expect(savedDeny).toEqual(["Bash"]);
  });
});

import { test, expect, describe } from "bun:test";
import { buildHooksBlock, COORDINATOR_INTERCEPT_MATCHER, REGULAR_AGENT_INTERCEPT_MATCHER } from "./settings-builder";

describe("buildHooksBlock — byte-identical with prior inline literals", () => {
  test("system coordinator (no Stop, intercept w/ Bash, sessionStart w/ agentId)", () => {
    const result = buildHooksBlock({
      agentId: "@system",
      includeStop: false,
      interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: true,
    });
    // Reconstruct what writeCoordinatorFiles used to produce inline.
    const expected = {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "ib hook-check-path @system" }] },
        { matcher: "Task|Agent|TaskCreate|Bash|AskUserQuestion", hooks: [{ type: "command", command: "ib hooks intercept-task" }] },
      ],
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: "ib hook-permission-denied @system" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "ib hook-mark-running @system" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start @system" }] }],
    };
    expect(JSON.stringify(result, null, 2)).toBe(JSON.stringify(expected, null, 2));
  });

  test("per-repo coordinator (Stop, intercept w/ Bash, sessionStart w/ agentId)", () => {
    const id = "my-repo";
    const result = buildHooksBlock({
      agentId: id,
      includeStop: true,
      interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: true,
    });
    // Reconstruct what the per-repo coord branch in newAgent used to produce inline.
    const expected = {
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-status ${id}` }] }],
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-permission-denied ${id}` }] }],
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: `ib hook-check-path ${id}` }] },
        { matcher: "Task|Agent|TaskCreate|Bash|AskUserQuestion", hooks: [{ type: "command", command: "ib hooks intercept-task" }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `ib hook-mark-running ${id}` }] }],
      SessionStart: [{ hooks: [{ type: "command", command: `ib hooks session-start ${id}` }] }],
    };
    expect(JSON.stringify(result, null, 2)).toBe(JSON.stringify(expected, null, 2));
  });

  test("regular agent w/o intercept (Stop, no intercept, sessionStart w/o agentId)", () => {
    const id = "agent-abc12345";
    const result = buildHooksBlock({
      agentId: id,
      includeStop: true,
      interceptMatcher: null,
      sessionStartIncludesAgentId: false,
    });
    // Reconstruct what buildAgentSettings used to produce inline (intercept off).
    const expected = {
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-status ${id}` }] }],
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-permission-denied ${id}` }] }],
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: `ib hook-check-path ${id}` }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `ib hook-mark-running ${id}` }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
    };
    expect(JSON.stringify(result, null, 2)).toBe(JSON.stringify(expected, null, 2));
  });

  test("regular agent w/ intercept (Stop, intercept w/o Bash, sessionStart w/o agentId)", () => {
    const id = "agent-abc12345";
    const result = buildHooksBlock({
      agentId: id,
      includeStop: true,
      interceptMatcher: REGULAR_AGENT_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: false,
    });
    // Reconstruct what buildAgentSettings used to produce inline (intercept on, manager).
    const expected = {
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-status ${id}` }] }],
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-permission-denied ${id}` }] }],
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: `ib hook-check-path ${id}` }] },
        { matcher: "Task|Agent|TaskCreate|AskUserQuestion", hooks: [{ type: "command", command: "ib hooks intercept-task" }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `ib hook-mark-running ${id}` }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
    };
    expect(JSON.stringify(result, null, 2)).toBe(JSON.stringify(expected, null, 2));
  });

  test("intercept matcher constants match the original literals", () => {
    expect(COORDINATOR_INTERCEPT_MATCHER).toBe("Task|Agent|TaskCreate|Bash|AskUserQuestion");
    expect(REGULAR_AGENT_INTERCEPT_MATCHER).toBe("Task|Agent|TaskCreate|AskUserQuestion");
  });
});

describe("buildHooksBlock — inject-timestamp PostToolUse hook", () => {
  test("omitting includeTimestamp produces no PostToolUse key (backward compatible)", () => {
    const result = buildHooksBlock({
      agentId: "agent-abc12345",
      includeStop: true,
      interceptMatcher: null,
      sessionStartIncludesAgentId: false,
    });
    expect("PostToolUse" in result).toBe(false);
  });

  test("includeTimestamp false produces no PostToolUse key", () => {
    const result = buildHooksBlock({
      agentId: "agent-abc12345",
      includeStop: true,
      interceptMatcher: null,
      sessionStartIncludesAgentId: false,
      includeTimestamp: false,
    });
    expect("PostToolUse" in result).toBe(false);
  });

  test("regular agent w/ timestamp (Stop, no intercept) adds PostToolUse after PreToolUse and appends inject-timestamp to UserPromptSubmit", () => {
    const id = "agent-abc12345";
    const result = buildHooksBlock({
      agentId: id,
      includeStop: true,
      interceptMatcher: null,
      sessionStartIncludesAgentId: false,
      includeTimestamp: true,
    });
    const expected = {
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-status ${id}` }] }],
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-permission-denied ${id}` }] }],
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: `ib hook-check-path ${id}` }] },
      ],
      PostToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "ib hooks inject-timestamp" }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: `ib hook-mark-running ${id}` }] },
        { hooks: [{ type: "command", command: "ib hooks inject-timestamp" }] },
      ],
      SessionStart: [{ hooks: [{ type: "command", command: "ib hooks session-start" }] }],
    };
    expect(JSON.stringify(result, null, 2)).toBe(JSON.stringify(expected, null, 2));
  });

  test("PostToolUse is emitted directly after PreToolUse in key order", () => {
    const result = buildHooksBlock({
      agentId: "agent-abc12345",
      includeStop: true,
      interceptMatcher: REGULAR_AGENT_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: false,
      includeTimestamp: true,
    });
    const keys = Object.keys(result);
    const preIdx = keys.indexOf("PreToolUse");
    const postIdx = keys.indexOf("PostToolUse");
    expect(postIdx).toBe(preIdx + 1);
  });

  test("timestamp hook uses matcher '*' to fire on every tool call", () => {
    const result = buildHooksBlock({
      agentId: "agent-abc12345",
      includeStop: true,
      interceptMatcher: null,
      sessionStartIncludesAgentId: false,
      includeTimestamp: true,
    });
    const postToolUse = result.PostToolUse as Array<{ matcher: string }>;
    expect(postToolUse[0]!.matcher).toBe("*");
  });

  test("includeTimestamp false leaves UserPromptSubmit as a single hook-mark-running entry", () => {
    const id = "agent-abc12345";
    const result = buildHooksBlock({
      agentId: id,
      includeStop: true,
      interceptMatcher: null,
      sessionStartIncludesAgentId: false,
      includeTimestamp: false,
    });
    const userPromptSubmit = result.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    expect(userPromptSubmit).toHaveLength(1);
    expect(userPromptSubmit[0]!.hooks[0]!.command).toBe(`ib hook-mark-running ${id}`);
  });

  test("includeTimestamp true appends inject-timestamp as a second UserPromptSubmit entry", () => {
    const id = "agent-abc12345";
    const result = buildHooksBlock({
      agentId: id,
      includeStop: true,
      interceptMatcher: null,
      sessionStartIncludesAgentId: false,
      includeTimestamp: true,
    });
    const userPromptSubmit = result.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    expect(userPromptSubmit).toHaveLength(2);
    // Order matters: state-flip runs first (signals "running" before injection
    // appears in the agent's context), timestamp injection second.
    expect(userPromptSubmit[0]!.hooks[0]!.command).toBe(`ib hook-mark-running ${id}`);
    expect(userPromptSubmit[1]!.hooks[0]!.command).toBe("ib hooks inject-timestamp");
  });

  // The includeStop:false + includeTimestamp:true combination never occurs in
  // production (only coordinators use includeStop:false, and they never request
  // the timestamp hook). The code path exists, though, so pin its key order so a
  // future caller that combines them gets the documented layout.
  test("includeStop:false branch also inserts PostToolUse directly after PreToolUse", () => {
    const result = buildHooksBlock({
      agentId: "@system",
      includeStop: false,
      interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: true,
      includeTimestamp: true,
    });
    const keys = Object.keys(result);
    expect(keys).toEqual([
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "UserPromptSubmit",
      "SessionStart",
    ]);
    const postToolUse = result.PostToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(postToolUse[0]!.matcher).toBe("*");
    expect(postToolUse[0]!.hooks[0]!.command).toBe("ib hooks inject-timestamp");
  });
});

describe("buildHooksBlock — Telegram tgtyping hook (@system coordinator only)", () => {
  test("includeTelegramTyping: true appends `ib tgtyping` to UserPromptSubmit AND PostToolUse", () => {
    const result = buildHooksBlock({
      agentId: "@system",
      includeStop: false,
      interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: true,
      includeTelegramTyping: true,
    });

    const userPromptSubmit = result.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const commands = userPromptSubmit.flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(commands).toContain("ib tgtyping");

    const postToolUse = result.PostToolUse as Array<{ hooks: Array<{ command: string }> }>;
    expect(postToolUse).toBeDefined();
    const postCommands = postToolUse.flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(postCommands).toContain("ib tgtyping");
  });

  test("includeTelegramTyping: true does NOT add the hook to Stop", () => {
    // Stop is not present for @system at all (includeStop: false); this test
    // pins the documented decision so the indicator decays naturally on idle.
    const result = buildHooksBlock({
      agentId: "@system",
      includeStop: false,
      interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: true,
      includeTelegramTyping: true,
    });
    expect(result.Stop).toBeUndefined();
  });

  test("UserPromptSubmit tgtyping entry comes AFTER hook-mark-running", () => {
    const result = buildHooksBlock({
      agentId: "@system",
      includeStop: false,
      interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: true,
      includeTelegramTyping: true,
    });
    const userPromptSubmit = result.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const commands = userPromptSubmit.flatMap((entry) => entry.hooks.map((h) => h.command));
    const markIdx = commands.indexOf("ib hook-mark-running @system");
    const typingIdx = commands.indexOf("ib tgtyping");
    expect(markIdx).toBeGreaterThanOrEqual(0);
    expect(typingIdx).toBeGreaterThan(markIdx);
  });

  test("regular agents do NOT include `ib tgtyping` in any hook array", () => {
    const result = buildHooksBlock({
      agentId: "agent-abc12345",
      includeStop: true,
      interceptMatcher: REGULAR_AGENT_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: false,
    });

    const allCommands = Object.values(result).flatMap((arr: unknown) =>
      (arr as Array<{ hooks: Array<{ command: string }> }>).flatMap((entry) =>
        entry.hooks.map((h) => h.command),
      ),
    );
    expect(allCommands).not.toContain("ib tgtyping");
  });

  test("per-repo coordinators do NOT include `ib tgtyping` (only @system does)", () => {
    // Per-repo coordinators don't get the tgtyping hook either — only the
    // @system coordinator handles Telegram routing.
    const result = buildHooksBlock({
      agentId: "my-repo",
      includeStop: true,
      interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: true,
    });
    const allCommands = Object.values(result).flatMap((arr: unknown) =>
      (arr as Array<{ hooks: Array<{ command: string }> }>).flatMap((entry) =>
        entry.hooks.map((h) => h.command),
      ),
    );
    expect(allCommands).not.toContain("ib tgtyping");
  });

  test("includeTelegramTyping omitted → no PostToolUse key (backward compatible)", () => {
    const result = buildHooksBlock({
      agentId: "@system",
      includeStop: false,
      interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: true,
    });
    expect("PostToolUse" in result).toBe(false);
  });

  test("includeTimestamp + includeTelegramTyping coexist — inject-timestamp first, tgtyping second in PostToolUse", () => {
    const result = buildHooksBlock({
      agentId: "@system",
      includeStop: false,
      interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
      sessionStartIncludesAgentId: true,
      includeTimestamp: true,
      includeTelegramTyping: true,
    });
    const postToolUse = result.PostToolUse as Array<{ hooks: Array<{ command: string }> }>;
    const commands = postToolUse.flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(commands).toEqual(["ib hooks inject-timestamp", "ib tgtyping"]);
  });
});

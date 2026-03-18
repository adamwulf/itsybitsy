import { test, expect, describe } from "bun:test";
import {
  IB_COORDINATOR_SESSION,
  SYSTEM_COORDINATOR_PROMPT,
  buildSystemCoordinatorSettings,
} from "./coordinator";

describe("IB_COORDINATOR_SESSION", () => {
  test("has expected session name", () => {
    expect(IB_COORDINATOR_SESSION).toBe("ib-coordinator");
  });
});

describe("SYSTEM_COORDINATOR_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof SYSTEM_COORDINATOR_PROMPT).toBe("string");
    expect(SYSTEM_COORDINATOR_PROMPT.length).toBeGreaterThan(0);
  });

  test("mentions ib commands", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib list");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib send");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib merge");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib kill");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib new-agent");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib status");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib diff");
  });

  test("mentions inbox commands", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib inbox count");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib inbox list");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib inbox read");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib inbox ack");
  });

  test("warns against sending to self", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain(
      "Do NOT use `ib send coordinator`"
    );
  });

  test("explains delegation to per-repo coordinators", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("per-repo coordinators");
    expect(SYSTEM_COORDINATOR_PROMPT).toContain("ib send <repo-name>");
  });

  test("states no file tool access", () => {
    expect(SYSTEM_COORDINATOR_PROMPT).toContain(
      "do NOT have access to Read, Write, Edit, or any file tools"
    );
  });
});

describe("buildSystemCoordinatorSettings", () => {
  test("returns permissions object with allow and deny", () => {
    const settings = buildSystemCoordinatorSettings();
    expect(settings).toHaveProperty("permissions");
    expect(settings.permissions).toHaveProperty("allow");
    expect(settings.permissions).toHaveProperty("deny");
  });

  test("allows only Bash(ib:*)", () => {
    const settings = buildSystemCoordinatorSettings();
    expect(settings.permissions.allow).toEqual(["Bash(ib:*)"]);
  });

  test("denies unqualified Bash", () => {
    const settings = buildSystemCoordinatorSettings();
    expect(settings.permissions.deny).toContain("Bash");
  });

  test("denies all file access tools", () => {
    const settings = buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("Read");
    expect(deny).toContain("Write");
    expect(deny).toContain("Edit");
    expect(deny).toContain("MultiEdit");
    expect(deny).toContain("Glob");
    expect(deny).toContain("Grep");
    expect(deny).toContain("LS");
  });

  test("denies web access tools", () => {
    const settings = buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("WebFetch");
    expect(deny).toContain("WebSearch");
  });

  test("denies agent/task spawning tools", () => {
    const settings = buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("Task");
    expect(deny).toContain("TaskOutput");
    expect(deny).toContain("Agent");
  });

  test("denies other restricted tools", () => {
    const settings = buildSystemCoordinatorSettings();
    const deny = settings.permissions.deny;
    expect(deny).toContain("NotebookEdit");
    expect(deny).toContain("KillShell");
    expect(deny).toContain("EnterPlanMode");
    expect(deny).toContain("ExitPlanMode");
  });

  test("deny list has exactly 17 entries", () => {
    const settings = buildSystemCoordinatorSettings();
    expect(settings.permissions.deny).toHaveLength(17);
  });

  test("returns fresh arrays on each call (no shared mutation)", () => {
    const a = buildSystemCoordinatorSettings();
    const b = buildSystemCoordinatorSettings();
    expect(a.permissions.allow).not.toBe(b.permissions.allow);
    expect(a.permissions.deny).not.toBe(b.permissions.deny);
    a.permissions.allow.push("extra");
    expect(b.permissions.allow).not.toContain("extra");
  });
});

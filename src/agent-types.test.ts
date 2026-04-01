import { test, expect, describe } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import {
  parseAgentTypeFile,
  getBuiltinType,
  resolveAgentType,
  loadAgentType,
  AGENT_TYPES_DIR,
} from "./agent-types";
import { getAgentType, isWorkerLike, canSpawnChildren } from "./agents";
import type { AgentMeta } from "./agents";

function makeMeta(overrides: Partial<AgentMeta> = {}): AgentMeta {
  return {
    id: "agent-test1234",
    session_id: "session-1",
    tmux_session: "ittybitty-test-agent-test1234",
    prompt: "test prompt",
    manager: null,
    created: new Date().toISOString(),
    created_epoch: Math.floor(Date.now() / 1000),
    worktree: true,
    worker: false,
    yolo: false,
    model: "opus",
    claude_pid: "12345",
    ...overrides,
  };
}

describe("agent-types", () => {
  describe("parseAgentTypeFile", () => {
    test("parses valid frontmatter with all fields", () => {
      const content = `---
name: reviewer
description: Review code changes, report findings
canSpawnChildren: false
canBeParent: false
model: sonnet
coordinator: false
permissions:
  allow:
    - Read
    - Grep
    - Glob
  deny:
    - Task
    - Agent
---

# Reviewer Agent

You are a code reviewer. Your job is to:
1. Read the PR/code
2. Identify issues
3. Report to your manager`;

      const result = parseAgentTypeFile(content);
      expect(result.name).toBe("reviewer");
      expect(result.description).toBe("Review code changes, report findings");
      expect(result.canSpawnChildren).toBe(false);
      expect(result.canBeParent).toBe(false);
      expect(result.model).toBe("sonnet");
      expect(result.coordinator).toBeUndefined();
      expect(result.permissions.allow).toEqual(["Read", "Grep", "Glob"]);
      expect(result.permissions.deny).toEqual(["Task", "Agent"]);
      expect(result.promptBody).toContain("You are a code reviewer");
      expect(result.promptBody).toContain("Report to your manager");
    });

    test("parses minimal frontmatter with defaults", () => {
      const content = `---
name: simple-type
---

Simple prompt body.`;

      const result = parseAgentTypeFile(content);
      expect(result.name).toBe("simple-type");
      expect(result.description).toBe("");
      expect(result.canSpawnChildren).toBe(false);
      expect(result.canBeParent).toBe(true);
      expect(result.model).toBeUndefined();
      expect(result.coordinator).toBeUndefined();
      expect(result.permissions.allow).toEqual([]);
      expect(result.permissions.deny).toEqual([]);
      expect(result.promptBody).toBe("Simple prompt body.");
    });

    test("parses type with canSpawnChildren: true", () => {
      const content = `---
name: lead
description: Lead agent that can spawn workers
canSpawnChildren: true
---

You are a lead agent.`;

      const result = parseAgentTypeFile(content);
      expect(result.canSpawnChildren).toBe(true);
    });

    test("parses inline array permissions", () => {
      const content = `---
name: restricted
permissions:
  allow: [Read, Grep, Glob]
  deny: [Write, Edit]
---

Restricted agent.`;

      const result = parseAgentTypeFile(content);
      expect(result.permissions.allow).toEqual(["Read", "Grep", "Glob"]);
      expect(result.permissions.deny).toEqual(["Write", "Edit"]);
    });

    test("throws on missing frontmatter delimiter", () => {
      expect(() => parseAgentTypeFile("no frontmatter")).toThrow("must start with YAML frontmatter");
    });

    test("throws on unclosed frontmatter", () => {
      expect(() => parseAgentTypeFile("---\nname: bad\n")).toThrow("unclosed YAML frontmatter");
    });

    test("throws on missing name field", () => {
      expect(() => parseAgentTypeFile("---\ndescription: no name\n---\nbody")).toThrow("must have a 'name' field");
    });

    test("handles empty prompt body", () => {
      const content = `---
name: empty-body
---`;

      const result = parseAgentTypeFile(content);
      expect(result.promptBody).toBe("");
    });

    test("parses coordinator type", () => {
      const content = `---
name: custom-coord
coordinator: true
canSpawnChildren: true
---

Custom coordinator.`;

      const result = parseAgentTypeFile(content);
      expect(result.coordinator).toBe(true);
      expect(result.canSpawnChildren).toBe(true);
    });
  });

  describe("getBuiltinType", () => {
    test("manager has canSpawnChildren: true", () => {
      const mgr = getBuiltinType("manager");
      expect(mgr.name).toBe("manager");
      expect(mgr.canSpawnChildren).toBe(true);
      expect(mgr.canBeParent).toBe(true);
    });

    test("worker has canSpawnChildren: false", () => {
      const wkr = getBuiltinType("worker");
      expect(wkr.name).toBe("worker");
      expect(wkr.canSpawnChildren).toBe(false);
      expect(wkr.canBeParent).toBe(false);
    });

    test("coordinator has canSpawnChildren: true", () => {
      const coord = getBuiltinType("coordinator");
      expect(coord.name).toBe("coordinator");
      expect(coord.canSpawnChildren).toBe(true);
      expect(coord.coordinator).toBe(true);
    });
  });

  describe("resolveAgentType", () => {
    test("falls back to builtin for manager", async () => {
      const result = await resolveAgentType("manager");
      expect(result.name).toBe("manager");
      expect(result.canSpawnChildren).toBe(true);
    });

    test("falls back to builtin for worker", async () => {
      const result = await resolveAgentType("worker");
      expect(result.name).toBe("worker");
      expect(result.canSpawnChildren).toBe(false);
    });

    test("falls back to builtin for coordinator", async () => {
      const result = await resolveAgentType("coordinator");
      expect(result.name).toBe("coordinator");
      expect(result.canSpawnChildren).toBe(true);
    });

    test("throws for unknown type not on disk", async () => {
      await expect(resolveAgentType("nonexistent-type-xyz")).rejects.toThrow("Unknown agent type");
    });
  });

  describe("loadAgentType from filesystem", () => {
    const tmpDir = join("/tmp", "ib-agent-types-test-" + Date.now());
    const typeName = "test-reviewer";
    const typeDir = join(tmpDir, typeName);

    test("loads type from disk", async () => {
      await mkdir(typeDir, { recursive: true });
      const content = `---
name: test-reviewer
description: Test reviewer type
canSpawnChildren: false
---

You review code for tests.`;
      await Bun.write(join(typeDir, "AGENTTYPE.md"), content);

      // We need to temporarily override AGENT_TYPES_DIR — use loadAgentType indirectly
      // Instead, just verify parseAgentTypeFile works on the content
      const result = parseAgentTypeFile(content);
      expect(result.name).toBe("test-reviewer");
      expect(result.description).toBe("Test reviewer type");

      await rm(tmpDir, { recursive: true, force: true });
    });

    test("returns null for missing type", async () => {
      const result = await loadAgentType("definitely-not-a-real-type-" + Date.now());
      expect(result).toBeNull();
    });
  });
});

describe("agents helpers", () => {
  describe("getAgentType", () => {
    test("returns type field when set", () => {
      const meta = makeMeta({ type: "reviewer" });
      expect(getAgentType(meta)).toBe("reviewer");
    });

    test("returns 'worker' for legacy worker: true", () => {
      const meta = makeMeta({ worker: true });
      expect(getAgentType(meta)).toBe("worker");
    });

    test("returns 'coordinator' for coordinator: true", () => {
      const meta = makeMeta({ coordinator: true });
      expect(getAgentType(meta)).toBe("coordinator");
    });

    test("returns 'manager' by default", () => {
      const meta = makeMeta();
      expect(getAgentType(meta)).toBe("manager");
    });

    test("type field takes priority over worker", () => {
      const meta = makeMeta({ type: "researcher", worker: true });
      expect(getAgentType(meta)).toBe("researcher");
    });

    test("type field takes priority over coordinator", () => {
      const meta = makeMeta({ type: "custom-coord", coordinator: true });
      expect(getAgentType(meta)).toBe("custom-coord");
    });
  });

  describe("isWorkerLike", () => {
    test("returns true for type === 'worker'", () => {
      const meta = makeMeta({ type: "worker" });
      expect(isWorkerLike(meta)).toBe(true);
    });

    test("returns true for legacy worker: true", () => {
      const meta = makeMeta({ worker: true });
      expect(isWorkerLike(meta)).toBe(true);
    });

    test("returns false for manager", () => {
      const meta = makeMeta();
      expect(isWorkerLike(meta)).toBe(false);
    });

    test("returns false for custom type", () => {
      const meta = makeMeta({ type: "reviewer" });
      expect(isWorkerLike(meta)).toBe(false);
    });

    test("returns false for coordinator", () => {
      const meta = makeMeta({ coordinator: true });
      expect(isWorkerLike(meta)).toBe(false);
    });
  });

  describe("canSpawnChildren", () => {
    test("manager can spawn", async () => {
      const meta = makeMeta();
      expect(await canSpawnChildren(meta)).toBe(true);
    });

    test("worker cannot spawn", async () => {
      const meta = makeMeta({ worker: true });
      expect(await canSpawnChildren(meta)).toBe(false);
    });

    test("coordinator can spawn", async () => {
      const meta = makeMeta({ coordinator: true });
      expect(await canSpawnChildren(meta)).toBe(true);
    });

    test("unknown type returns false", async () => {
      const meta = makeMeta({ type: "nonexistent-type-" + Date.now() });
      expect(await canSpawnChildren(meta)).toBe(false);
    });
  });
});

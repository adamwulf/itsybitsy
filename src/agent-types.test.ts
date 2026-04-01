import { test, expect, describe } from "bun:test";
import {
  parseAgentTypeMarkdown,
  canAgentTypeSpawnChildren,
  getBuiltInType,
  resolveAgentType,
  migrateWorkerToType,
  type AgentType,
} from "./agent-types";

describe("agent-types", () => {
  describe("parseAgentTypeMarkdown", () => {
    test("parses simple agent type with frontmatter", () => {
      const markdown = `---
name: reviewer
description: Code review agent
canSpawnChildren: false
---

# Reviewer Agent

You review code and provide feedback.`;

      const result = parseAgentTypeMarkdown(markdown);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.frontmatter.name).toBe("reviewer");
        expect(result.frontmatter.description).toBe("Code review agent");
        expect(result.frontmatter.canSpawnChildren).toBe(false);
        expect(result.body).toContain("# Reviewer Agent");
        expect(result.body).toContain("You review code");
      }
    });

    test("parses agent type with all frontmatter fields", () => {
      const markdown = `---
name: manager
description: Manages sub-agents
canSpawnChildren: true
canBeParent: true
model: opus
coordinator: false
---

# Manager Agent

Manages work.`;

      const result = parseAgentTypeMarkdown(markdown);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.frontmatter.name).toBe("manager");
        expect(result.frontmatter.canSpawnChildren).toBe(true);
        expect(result.frontmatter.canBeParent).toBe(true);
        expect(result.frontmatter.model).toBe("opus");
        expect(result.frontmatter.coordinator).toBe(false);
      }
    });

    test("parses boolean values correctly", () => {
      const markdown = `---
name: worker
description: Worker agent
canSpawnChildren: false
coordinator: true
---

Worker instructions`;

      const result = parseAgentTypeMarkdown(markdown);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.frontmatter.canSpawnChildren).toBe(false);
        expect(result.frontmatter.coordinator).toBe(true);
      }
    });

    test("returns null for invalid markdown (missing frontmatter)", () => {
      const markdown = `# Just content
No frontmatter here`;

      const result = parseAgentTypeMarkdown(markdown);
      expect(result).toBeNull();
    });

    test("returns null for invalid frontmatter (missing required fields)", () => {
      const markdown = `---
description: Missing name field
canSpawnChildren: false
---

Content`;

      const result = parseAgentTypeMarkdown(markdown);
      expect(result).toBeNull();
    });

    test("preserves multiline body content", () => {
      const markdown = `---
name: test
description: Test agent
canSpawnChildren: false
---

# Line 1
## Line 2
- bullet 1
- bullet 2

Code block:
\`\`\`
code here
\`\`\``;

      const result = parseAgentTypeMarkdown(markdown);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.body).toContain("# Line 1");
        expect(result.body).toContain("## Line 2");
        expect(result.body).toContain("- bullet 1");
        expect(result.body).toContain("Code block:");
      }
    });
  });

  describe("canAgentTypeSpawnChildren", () => {
    test("returns true for types with canSpawnChildren: true", () => {
      const agentType: AgentType = {
        frontmatter: {
          name: "manager",
          description: "Manages agents",
          canSpawnChildren: true,
        },
        body: "Manager instructions",
      };
      expect(canAgentTypeSpawnChildren(agentType)).toBe(true);
    });

    test("returns false for types with canSpawnChildren: false", () => {
      const agentType: AgentType = {
        frontmatter: {
          name: "worker",
          description: "Worker agent",
          canSpawnChildren: false,
        },
        body: "Worker instructions",
      };
      expect(canAgentTypeSpawnChildren(agentType)).toBe(false);
    });

    test("returns false for null type", () => {
      expect(canAgentTypeSpawnChildren(null)).toBe(false);
    });

    test("returns true for coordinator type regardless of canSpawnChildren", () => {
      const agentType: AgentType = {
        frontmatter: {
          name: "coordinator",
          description: "Coordinator",
          canSpawnChildren: false,
          coordinator: true,
        },
        body: "Coordinator instructions",
      };
      expect(canAgentTypeSpawnChildren(agentType)).toBe(true);
    });
  });

  describe("getBuiltInType", () => {
    test("returns built-in manager type", () => {
      const result = getBuiltInType("manager");
      expect(result).not.toBeNull();
      if (result) {
        expect(result.frontmatter.name).toBe("manager");
        expect(result.frontmatter.description).toContain("Manager");
        expect(result.frontmatter.canSpawnChildren).toBe(true);
      }
    });

    test("returns built-in worker type", () => {
      const result = getBuiltInType("worker");
      expect(result).not.toBeNull();
      if (result) {
        expect(result.frontmatter.name).toBe("worker");
        expect(result.frontmatter.description).toContain("Worker");
        expect(result.frontmatter.canSpawnChildren).toBe(false);
      }
    });

    test("returns null for unknown type", () => {
      const result = getBuiltInType("unknown-type");
      expect(result).toBeNull();
    });
  });

  describe("migrateWorkerToType", () => {
    test("returns type field if already set", () => {
      const meta = { type: "custom", worker: true };
      expect(migrateWorkerToType(meta)).toBe("custom");
    });

    test("returns 'worker' if worker: true", () => {
      const meta = { worker: true };
      expect(migrateWorkerToType(meta)).toBe("worker");
    });

    test("returns 'manager' if worker is false or undefined", () => {
      expect(migrateWorkerToType({ worker: false })).toBe("manager");
      expect(migrateWorkerToType({})).toBe("manager");
    });

    test("prefers type over worker field", () => {
      const meta = { type: "reviewer", worker: true };
      expect(migrateWorkerToType(meta)).toBe("reviewer");
    });
  });

  describe("resolveAgentType", () => {
    test("resolves built-in manager type without file access", async () => {
      const result = await resolveAgentType("manager");
      expect(result).not.toBeNull();
      if (result) {
        expect(result.frontmatter.name).toBe("manager");
      }
    });

    test("resolves built-in worker type without file access", async () => {
      const result = await resolveAgentType("worker");
      expect(result).not.toBeNull();
      if (result) {
        expect(result.frontmatter.name).toBe("worker");
      }
    });

    test("returns null for unknown type", async () => {
      const result = await resolveAgentType("nonexistent-type-xyz");
      expect(result).toBeNull();
    });
  });

  describe("backward compatibility", () => {
    test("legacy meta with worker field is migrated to type", () => {
      const legacyMeta = { id: "agent-123", worker: true };
      const type = migrateWorkerToType({ worker: legacyMeta.worker });
      expect(type).toBe("worker");
    });

    test("legacy meta with worker: false becomes manager", () => {
      const legacyMeta = { id: "agent-123", worker: false };
      const type = migrateWorkerToType({ worker: legacyMeta.worker });
      expect(type).toBe("manager");
    });

    test("getBuiltInType returns manager and worker", () => {
      const manager = getBuiltInType("manager");
      const worker = getBuiltInType("worker");
      expect(manager?.frontmatter.canSpawnChildren).toBe(true);
      expect(worker?.frontmatter.canSpawnChildren).toBe(false);
    });
  });

  describe("permissions in agent types", () => {
    test("parses custom agent type with body", () => {
      const markdown = `---
name: reviewer
description: Code review agent
canSpawnChildren: false
---

# Reviewer Agent

You are a code reviewer. Your job is to:
1. Read code changes
2. Identify issues
3. Report findings`;

      const result = parseAgentTypeMarkdown(markdown);
      expect(result?.frontmatter.name).toBe("reviewer");
      expect(result?.frontmatter.canSpawnChildren).toBe(false);
      expect(result?.body).toContain("# Reviewer Agent");
      expect(result?.body).toContain("code changes");
    });

    test("distinguishes between types and roles", () => {
      const custom: AgentType = {
        frontmatter: {
          name: "custom-reviewer",
          description: "Custom reviewer",
          canSpawnChildren: false,
        },
        body: "Custom reviewer instructions",
      };
      expect(canAgentTypeSpawnChildren(custom)).toBe(false);
      expect(custom.frontmatter.name).toBe("custom-reviewer");
    });
  });
});

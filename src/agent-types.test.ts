import { test, expect } from "bun:test";
import { parseAgentTypeFile, loadAgentType, listAgentTypes, getBuiltinTypes, ensureAgentTypesDir, agentTypeExists } from "./agent-types";

test("parseAgentTypeFile: parses frontmatter and body", () => {
  const content = `---
name: test-type
description: "A test agent type"
canSpawnChildren: true
model: sonnet
instructionStyle: manager
---

# Test Instructions

This is the markdown body.
`;

  const { frontmatter, body } = parseAgentTypeFile(content);

  expect(frontmatter.name).toBe("test-type");
  expect(frontmatter.description).toBe("A test agent type");
  expect(frontmatter.canSpawnChildren).toBe(true);
  expect(frontmatter.model).toBe("sonnet");
  expect(frontmatter.instructionStyle).toBe("manager");
  expect(body).toContain("# Test Instructions");
  expect(body).toContain("This is the markdown body.");
});

test("parseAgentTypeFile: handles missing frontmatter", () => {
  const content = "Just some content without frontmatter";
  const { frontmatter, body } = parseAgentTypeFile(content);

  expect(frontmatter).toEqual({});
  expect(body).toBe("Just some content without frontmatter");
});

test("parseAgentTypeFile: handles unclosed frontmatter", () => {
  const content = `---
name: incomplete
no closing delimiter`;

  const { frontmatter, body } = parseAgentTypeFile(content);

  expect(frontmatter).toEqual({});
  expect(body).toBe(content);
});

test("parseAgentTypeFile: parses boolean values", () => {
  const content = `---
name: test
canSpawnChildren: true
enabled: false
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(frontmatter.canSpawnChildren).toBe(true);
  expect(frontmatter.enabled).toBe(false);
});

test("parseAgentTypeFile: parses nested permissions object", () => {
  const content = `---
name: researcher
permissions:
  allow: [Read, Grep, Glob]
  deny: [Write, Edit]
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  const perms = frontmatter.permissions as Record<string, unknown>;
  expect(perms).toBeDefined();
  expect(typeof perms).toBe("object");
  expect(Array.isArray(perms.allow)).toBe(true);
  expect(perms.allow).toEqual(["Read", "Grep", "Glob"]);
  expect(Array.isArray(perms.deny)).toBe(true);
  expect(perms.deny).toEqual(["Write", "Edit"]);
});

test("parseAgentTypeFile: parses multi-line YAML lists under nested objects", () => {
  const content = `---
name: researcher
permissions:
  allow:
    - Read
    - Grep
    - Glob
  deny:
    - Write
    - Edit
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  const perms = frontmatter.permissions as Record<string, unknown>;
  expect(perms).toBeDefined();
  expect(Array.isArray(perms.allow)).toBe(true);
  expect(perms.allow).toEqual(["Read", "Grep", "Glob"]);
  expect(Array.isArray(perms.deny)).toBe(true);
  expect(perms.deny).toEqual(["Write", "Edit"]);
});

test("parseAgentTypeFile: parses top-level multi-line YAML lists", () => {
  const content = `---
name: researcher
tools:
  - Read
  - Grep
  - Glob
model: sonnet
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(frontmatter.name).toBe("researcher");
  expect(Array.isArray(frontmatter.tools)).toBe(true);
  expect(frontmatter.tools).toEqual(["Read", "Grep", "Glob"]);
  expect(frontmatter.model).toBe("sonnet");
});

test("parseAgentTypeFile: parses simple array format", () => {
  const content = `---
tools: [Tool1, Tool2, Tool3]
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(Array.isArray(frontmatter.tools)).toBe(true);
  expect((frontmatter.tools as string[]).length).toBe(3);
  expect((frontmatter.tools as string[]).includes("Tool1")).toBe(true);
});

test("parseAgentTypeFile: handles empty string values correctly", () => {
  const content = `---
name: test
description:
model:
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  // Empty values should parse as empty strings, not become 0 or objects
  expect(frontmatter.name).toBe("test");
  expect(frontmatter.description).toBe("");
  expect(frontmatter.model).toBe("");
});

test("parseAgentTypeFile: handles empty inline array", () => {
  const content = `---
tools: []
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(Array.isArray(frontmatter.tools)).toBe(true);
  expect((frontmatter.tools as string[]).length).toBe(0);
});

test("parseAgentTypeFile: handles quoted string values", () => {
  const content = `---
name: "quoted name"
description: 'single quoted'
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(frontmatter.name).toBe("quoted name");
  expect(frontmatter.description).toBe("single quoted");
});

test("parseAgentTypeFile: handles numeric values", () => {
  const content = `---
maxTurns: 50
priority: 1.5
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(frontmatter.maxTurns).toBe(50);
  expect(frontmatter.priority).toBe(1.5);
});

test("parseAgentTypeFile: skips comments", () => {
  const content = `---
name: test
# This is a comment
canSpawnChildren: true
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(frontmatter.name).toBe("test");
  expect(frontmatter.canSpawnChildren).toBe(true);
  expect(Object.keys(frontmatter).length).toBe(2);
});

test("getBuiltinTypes: returns manager, worker, coordinator", async () => {
  const builtins = getBuiltinTypes();

  expect(builtins.manager).toBeDefined();
  expect(builtins.worker).toBeDefined();
  expect(builtins.coordinator).toBeDefined();

  expect(builtins.manager!.name).toBe("manager");
  expect(builtins.manager!.canSpawnChildren).toBe(true);
  expect(builtins.manager!.instructionStyle).toBe("manager");

  expect(builtins.worker!.name).toBe("worker");
  expect(builtins.worker!.canSpawnChildren).toBe(false);
  expect(builtins.worker!.instructionStyle).toBe("worker");

  expect(builtins.coordinator!.name).toBe("coordinator");
  expect(builtins.coordinator!.canSpawnChildren).toBe(true);
  expect(builtins.coordinator!.instructionStyle).toBe("coordinator");
  expect(builtins.coordinator!.permissions?.deny).toContain("Write");
  expect(builtins.coordinator!.permissions?.deny).toContain("Edit");
});

test("loadAgentType: loads manager type from embedded file", async () => {
  // Ensure types dir is populated first
  const { ensureAgentTypesDir } = await import("./agent-types");
  await ensureAgentTypesDir();

  const type = await loadAgentType("manager");

  expect(type.name).toBe("manager");
  expect(type.description).toBe("Manages sub-agents and coordinates work");
  expect(type.canSpawnChildren).toBe(true);
  expect(type.instructionStyle).toBe("manager");
});

test("loadAgentType: loads worker type from embedded file", async () => {
  // Ensure types dir is populated first
  const { ensureAgentTypesDir } = await import("./agent-types");
  await ensureAgentTypesDir();

  const type = await loadAgentType("worker");

  expect(type.name).toBe("worker");
  expect(type.description).toBe("Executes tasks assigned by a manager");
  expect(type.canSpawnChildren).toBe(false);
  expect(type.instructionStyle).toBe("worker");
});

test("loadAgentType: loads coordinator type from embedded file", async () => {
  // Ensure types dir is populated first
  const { ensureAgentTypesDir } = await import("./agent-types");
  await ensureAgentTypesDir();

  const type = await loadAgentType("coordinator");

  expect(type.name).toBe("coordinator");
  expect(type.canSpawnChildren).toBe(true);
  expect(type.permissions?.deny).toContain("Write");
});

test("loadAgentType: throws for unknown type", async () => {
  // Ensure types dir is populated first
  const { ensureAgentTypesDir } = await import("./agent-types");
  await ensureAgentTypesDir();

  let threw = false;
  let errorMsg = "";
  try {
    await loadAgentType("nonexistent-type-xyz");
  } catch (err) {
    threw = true;
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  expect(threw).toBe(true);
  expect(errorMsg).toContain("Unknown agent type");
});

test("listAgentTypes: includes all built-in types", async () => {
  const types = await listAgentTypes();

  const names = types.map((t) => t.name);

  expect(names).toContain("manager");
  expect(names).toContain("worker");
  expect(names).toContain("coordinator");
});

test("listAgentTypes: returns array of AgentTypes", async () => {
  const types = await listAgentTypes();

  expect(Array.isArray(types)).toBe(true);
  expect(types.length).toBeGreaterThanOrEqual(3);

  // Each type should have required fields
  for (const type of types) {
    expect(type.name).toBeDefined();
    expect(typeof type.name).toBe("string");
    expect(typeof type.canSpawnChildren).toBe("boolean");
    expect(["manager", "worker", "coordinator"]).toContain(type.instructionStyle);
  }
});

test("ensureAgentTypesDir: creates directory and populates files", async () => {
  // First call should create and populate
  await ensureAgentTypesDir();

  // All three built-in types should now exist
  const managerExists = await agentTypeExists("manager");
  const workerExists = await agentTypeExists("worker");
  const coordinatorExists = await agentTypeExists("coordinator");

  expect(managerExists).toBe(true);
  expect(workerExists).toBe(true);
  expect(coordinatorExists).toBe(true);
});

test("ensureAgentTypesDir: does nothing when directory already exists", async () => {
  // First call populates the directory
  await ensureAgentTypesDir();

  // Second call should be idempotent and not fail
  await ensureAgentTypesDir();

  // Files should still exist
  const managerExists = await agentTypeExists("manager");
  expect(managerExists).toBe(true);
});

test("agentTypeExists: returns true for existing type files", async () => {
  // Ensure directory is populated
  await ensureAgentTypesDir();

  const managerExists = await agentTypeExists("manager");
  const workerExists = await agentTypeExists("worker");
  const coordinatorExists = await agentTypeExists("coordinator");

  expect(managerExists).toBe(true);
  expect(workerExists).toBe(true);
  expect(coordinatorExists).toBe(true);
});

test("agentTypeExists: returns false for nonexistent types", async () => {
  // Ensure directory is populated
  await ensureAgentTypesDir();

  const nonexistentExists = await agentTypeExists("nonexistent-type-xyz");
  expect(nonexistentExists).toBe(false);
});

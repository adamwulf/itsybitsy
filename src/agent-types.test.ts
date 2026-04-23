import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { parseAgentTypeFile, loadAgentType, listAgentTypes, ensureAgentTypesDir, initAgentTypes, agentTypeExists } from "./agent-types";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

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

describe("initAgentTypes", () => {
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "itsybitsy-init-types-"));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("creates directory and writes all embedded files when missing", async () => {
    const created = await initAgentTypes();

    expect(created.sort()).toEqual(["_all.md", "_non_coordinator.md", "coordinator.md", "manager.md", "worker.md"]);
    expect(await agentTypeExists("manager")).toBe(true);
    expect(await agentTypeExists("worker")).toBe(true);
    expect(await agentTypeExists("coordinator")).toBe(true);
    expect(await agentTypeExists("_all")).toBe(true);
    expect(await agentTypeExists("_non_coordinator")).toBe(true);
  });

  test("restores a missing file without touching existing customizations", async () => {
    // First populate
    await initAgentTypes();

    // User customizes manager and deletes worker
    const typesDir = join(tempHome, ".itsybitsy", "agent-types");
    const customManager = "---\nname: manager\n---\nCustomized!";
    await Bun.write(join(typesDir, "manager.md"), customManager);
    await Bun.file(join(typesDir, "worker.md")).delete();

    // Re-run init
    const created = await initAgentTypes();

    expect(created).toEqual(["worker.md"]);
    // Customized manager remains untouched
    const managerContents = await Bun.file(join(typesDir, "manager.md")).text();
    expect(managerContents).toBe(customManager);
    // Worker was restored
    expect(await agentTypeExists("worker")).toBe(true);
  });

  test("returns empty array when nothing needs to be created", async () => {
    await initAgentTypes();
    const created = await initAgentTypes();
    expect(created).toEqual([]);
  });
});

test("parseAgentTypeFile: parses allowedPaths from list syntax", () => {
  const content = `---
name: restricted
allowedPaths:
  - /home/user/project
  - /data
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(Array.isArray(frontmatter.allowedPaths)).toBe(true);
  expect(frontmatter.allowedPaths).toEqual(["/home/user/project", "/data"]);
});

test("parseAgentTypeFile: parses allowedPaths from inline array", () => {
  const content = `---
name: restricted
allowedPaths: [/home/user/project, /data]
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(Array.isArray(frontmatter.allowedPaths)).toBe(true);
  expect(frontmatter.allowedPaths).toEqual(["/home/user/project", "/data"]);
});

test("parseAgentTypeFile: allowedPaths absent means undefined", () => {
  const content = `---
name: unrestricted
canSpawnChildren: true
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(frontmatter.allowedPaths).toBeUndefined();
});

test("parseAgentTypeFile: allowedPaths empty array is preserved", () => {
  const content = `---
name: strict
allowedPaths: []
---
body`;

  const { frontmatter } = parseAgentTypeFile(content);

  expect(Array.isArray(frontmatter.allowedPaths)).toBe(true);
  expect((frontmatter.allowedPaths as unknown[]).length).toBe(0);
});

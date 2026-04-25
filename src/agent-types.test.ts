import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { parseAgentTypeFile, loadAgentType, listAgentTypes, ensureAgentTypesDir, initAgentTypes, agentTypeExists, validateAllAgentTypes, listSpawnableAgentTypesSync, listSpawnableTypeNamesSync } from "./agent-types";
import { buildAvailableTypesSection } from "./hooks/session-start";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { interpolateTemplate } from "./hooks/session-start";

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

// ── inherits: / repos: inheritance tests (see PLAN-INHERITS.md) ──────────────

describe("loadAgentType: inherits", () => {
  const originalHome = process.env.HOME;
  let tempHome: string;
  let typesDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "itsybitsy-inherits-"));
    process.env.HOME = tempHome;
    typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function writeType(name: string, content: string): Promise<void> {
    await Bun.write(join(typesDir, `${name}.md`), content);
  }

  test("scalar field overrides when present in child", async () => {
    await writeType("parent", `---
name: parent
description: parent description
model: sonnet
---
body`);
    await writeType("child", `---
name: child
inherits: parent
description: new description
---
body`);

    const type = await loadAgentType("child");
    expect(type.description).toBe("new description");
    expect(type.model).toBe("sonnet"); // inherited
  });

  test("scalar field inherits when child omits it", async () => {
    await writeType("parent", `---
name: parent
description: parent description
model: haiku
---
body`);
    await writeType("child", `---
name: child
inherits: parent
---
body`);

    const type = await loadAgentType("child");
    expect(type.model).toBe("haiku");
    expect(type.description).toBe("parent description");
  });

  test("model: empty string in child inherits parent's model (not wipes to undefined)", async () => {
    // PLAN-INHERITS.md rules table: `model` — Child replaces if key is
    // **present** and non-empty string (empty string → inherit, matches
    // existing `""` → undefined coercion).
    await writeType("parent", `---
name: parent
model: opus
---
body`);
    await writeType("child", `---
inherits: parent
model: ""
---
body`);

    const type = await loadAgentType("child");
    expect(type.model).toBe("opus");
  });

  test("icon: empty string in child inherits parent's icon (not wipes to undefined)", async () => {
    // PLAN-INHERITS.md rules table: `icon` — Child replaces if key is
    // **present** and non-empty. An empty child icon means "inherit".
    // (Use a BMP character — the legacy iconChar extractor returns the first
    // UTF-16 code unit, which splits astral-plane emoji; that pre-existing
    // quirk is orthogonal to the inheritance rule exercised here.)
    await writeType("parent", `---
name: parent
icon: "M"
---
body`);
    await writeType("child", `---
inherits: parent
icon: ""
---
body`);

    const type = await loadAgentType("child");
    expect(type.icon).toBe("M");
  });

  test("canSpawnChildren: false on child overrides true on parent (raw-frontmatter-merge regression)", async () => {
    await writeType("parent", `---
name: parent
canSpawnChildren: true
---
body`);
    await writeType("child", `---
name: child
inherits: parent
canSpawnChildren: false
---
body`);

    const type = await loadAgentType("child");
    expect(type.canSpawnChildren).toBe(false);
  });

  test("name is never inherited", async () => {
    // Even if parent's frontmatter declares name: other, the resolved type name
    // is always the filename basename.
    await writeType("parent", `---
name: other
description: parent
---
body`);
    await writeType("child", `---
inherits: parent
---
body`);

    const type = await loadAgentType("child");
    expect(type.name).toBe("child");
  });

  test("spawnable is never inherited", async () => {
    // Parent with spawnable: false should NOT propagate to a child that omits it.
    // Keeps the sync scanner (listSpawnableTypeNamesSync) and async loader in sync.
    await writeType("parent", `---
name: parent
spawnable: false
---
body`);
    await writeType("child", `---
inherits: parent
---
body`);

    const type = await loadAgentType("child");
    expect(type.spawnable).toBe(true);
  });

  test("permissions.allow merges and dedupes across chain", async () => {
    await writeType("parent", `---
name: parent
permissions:
  allow: [Read, Grep]
---
body`);
    await writeType("child", `---
inherits: parent
permissions:
  allow: [Grep, Edit]
---
body`);

    const type = await loadAgentType("child");
    expect(type.permissions?.allow?.sort()).toEqual(["Edit", "Grep", "Read"]);
  });

  test("permissions.deny merges and dedupes across chain", async () => {
    await writeType("parent", `---
name: parent
permissions:
  deny: [Write, Bash]
---
body`);
    await writeType("child", `---
inherits: parent
permissions:
  deny: [Bash, NotebookEdit]
---
body`);

    const type = await loadAgentType("child");
    expect(type.permissions?.deny?.sort()).toEqual(["Bash", "NotebookEdit", "Write"]);
  });

  test("multi-level chain (A -> B -> C) merges and overrides correctly in order", async () => {
    await writeType("a", `---
name: a
description: A-desc
model: opus
permissions:
  allow: [Read]
---
body A`);
    await writeType("b", `---
inherits: a
description: B-desc
model: sonnet
permissions:
  allow: [Grep]
---
`);
    await writeType("c", `---
inherits: b
permissions:
  allow: [Edit]
---
`);

    const type = await loadAgentType("c");
    // B overrides A's description; C inherits B's (no override)
    expect(type.description).toBe("B-desc");
    // B overrides A's model; C inherits B's
    expect(type.model).toBe("sonnet");
    // All three allow lists merged
    expect(type.permissions?.allow?.sort()).toEqual(["Edit", "Grep", "Read"]);
    // Body inherits from A (B and C have empty bodies)
    expect(type.markdownBody).toBe("body A");
  });

  test("markdownBody inherits when child body is empty", async () => {
    await writeType("parent", `---
name: parent
---
Parent body content.`);
    await writeType("child", `---
inherits: parent
---
`);

    const type = await loadAgentType("child");
    expect(type.markdownBody).toBe("Parent body content.");
  });

  test("markdownBody appends child body after parent body when both non-empty", async () => {
    // PLAN-BODY-APPEND.md: bodies concatenate root-first with blank-line
    // separators so a child extending a manager/base type gets the parent's
    // boilerplate first, then the child's own additions.
    await writeType("parent", `---
name: parent
---
Parent body.`);
    await writeType("child", `---
inherits: parent
---
Child body.`);

    const type = await loadAgentType("child");
    expect(type.markdownBody).toBe("Parent body.\n\nChild body.");
  });

  test("markdownBody concatenates three-level chain root-first", async () => {
    await writeType("a", `---
name: a
---
A content`);
    await writeType("b", `---
inherits: a
---
B content`);
    await writeType("c", `---
inherits: b
---
C content`);

    const type = await loadAgentType("c");
    expect(type.markdownBody).toBe("A content\n\nB content\n\nC content");
  });

  test("markdownBody skips empty ancestors without adding blank separators", async () => {
    // Middle ancestor has no body — the join should not leave an extra
    // blank-line artifact between the root and the leaf.
    await writeType("a", `---
name: a
---
A content`);
    await writeType("b", `---
inherits: a
---
`);
    await writeType("c", `---
inherits: b
---
C content`);

    const type = await loadAgentType("c");
    expect(type.markdownBody).toBe("A content\n\nC content");
  });

  test("allowedPaths replaces (not merges) when child defines it", async () => {
    await writeType("parent", `---
name: parent
allowedPaths:
  - /parent/path
---
body`);
    await writeType("child", `---
inherits: parent
allowedPaths:
  - /child/path
---
body`);

    const type = await loadAgentType("child");
    expect(type.allowedPaths).toEqual(["/child/path"]);
  });

  test("allowedPaths: [] on child correctly overrides parent's non-empty list", async () => {
    await writeType("parent", `---
name: parent
allowedPaths: [/parent/path, /another]
---
body`);
    await writeType("child", `---
inherits: parent
allowedPaths: []
---
body`);

    const type = await loadAgentType("child");
    expect(type.allowedPaths).toEqual([]);
  });

  test("repos replaces when child defines it", async () => {
    await writeType("parent", `---
name: parent
repos: [repo-a, repo-b]
---
body`);
    await writeType("child", `---
inherits: parent
repos: [repo-c]
---
body`);

    const type = await loadAgentType("child");
    expect(type.repos).toEqual(["repo-c"]);
  });

  test("empty-string inherits treated as absent", async () => {
    // `inherits: ""` and `inherits:` with no value both mean "no parent".
    await writeType("standalone", `---
name: standalone
inherits: ""
description: self
---
body`);

    const type = await loadAgentType("standalone");
    expect(type.description).toBe("self");
  });

  test("missing parent throws with a helpful message", async () => {
    await writeType("child", `---
inherits: nonexistent-parent
---
body`);

    let thrown: unknown;
    try {
      await loadAgentType("child");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Type 'child' inherits from unknown type 'nonexistent-parent'");
  });

  test("self-cycle (A inherits A) throws Circular inheritance", async () => {
    await writeType("self", `---
inherits: self
---
body`);

    let thrown: unknown;
    try {
      await loadAgentType("self");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Circular inheritance");
    expect((thrown as Error).message).toContain("self");
  });

  test("two-node cycle (A -> B -> A) throws", async () => {
    await writeType("a", `---
inherits: b
---
`);
    await writeType("b", `---
inherits: a
---
`);

    let thrown: unknown;
    try {
      await loadAgentType("a");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Circular inheritance");
  });

  test("three-node cycle (A -> B -> C -> A) throws", async () => {
    await writeType("a", `---
inherits: b
---
`);
    await writeType("b", `---
inherits: c
---
`);
    await writeType("c", `---
inherits: a
---
`);

    let thrown: unknown;
    try {
      await loadAgentType("a");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Circular inheritance");
  });

  test("inherited body interpolates with child's context (not parent's)", async () => {
    // Parent body uses {{agentId}} — when loaded through the child, the
    // child's agent id should render. This verifies that inheritance doesn't
    // break interpolateTemplate (the body is owned by the child type load).
    await writeType("parent", `---
name: parent
---
Hello from agent {{agentId}}.`);
    await writeType("child", `---
inherits: parent
---
`);

    const type = await loadAgentType("child");
    expect(type.markdownBody).toBe("Hello from agent {{agentId}}.");

    const rendered = interpolateTemplate(type.markdownBody!, {
      role: "manager",
      agentId: "agent-child-abc",
      agentManager: "",
      parentBranch: "main",
      branchName: "agent/agent-child-abc",
      worktreePath: "/tmp/wt",
      rootRepoPath: "/tmp/repo",
    });
    expect(rendered).toBe("Hello from agent agent-child-abc.");
  });

  test("listAgentTypes: chain-valid types appear; chain-broken types are excluded", async () => {
    await writeType("good", `---
name: good
description: ok
---
`);
    await writeType("broken", `---
inherits: does-not-exist
---
`);

    const types = await listAgentTypes();
    const names = types.map((t) => t.name).sort();
    expect(names).toContain("good");
    // broken has a missing parent → loadAgentType throws → skipped
    expect(names).not.toContain("broken");
  });
});

describe("validateAllAgentTypes: inherits + repos", () => {
  const originalHome = process.env.HOME;
  let tempHome: string;
  let typesDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "itsybitsy-validate-"));
    process.env.HOME = tempHome;
    typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function writeType(name: string, content: string): Promise<void> {
    await Bun.write(join(typesDir, `${name}.md`), content);
  }

  test("rejects layer file (spawnable: false) with inherits:", async () => {
    await writeType("manager", `---
name: manager
description: a manager
---
`);
    await writeType("_all", `---
name: _all
spawnable: false
inherits: manager
---
`);

    const errors = await validateAllAgentTypes();
    const layerErr = errors.find(
      (e) => e.startsWith("_all.md") && e.includes("layer files") && e.includes("inherits"),
    );
    expect(layerErr).toBeDefined();
  });

  test("flags circular chains at startup", async () => {
    await writeType("a", `---
inherits: b
---
`);
    await writeType("b", `---
inherits: a
---
`);

    const errors = await validateAllAgentTypes();
    // At least one of a.md / b.md should surface a Circular error
    const hasCycle = errors.some((e) => e.includes("Circular inheritance"));
    expect(hasCycle).toBe(true);
  });

  test("flags missing parent at startup", async () => {
    await writeType("orphan", `---
inherits: gone
---
`);

    const errors = await validateAllAgentTypes();
    const missing = errors.find((e) => e.includes("unknown type 'gone'"));
    expect(missing).toBeDefined();
  });

  test("rejects non-string inherits (array)", async () => {
    await writeType("bad", `---
inherits: [a, b]
---
`);

    const errors = await validateAllAgentTypes();
    const err = errors.find((e) => e.startsWith("bad.md") && e.includes("inherits must be a string"));
    expect(err).toBeDefined();
  });

  test("rejects non-string inherits (boolean)", async () => {
    await writeType("bad", `---
inherits: true
---
`);

    const errors = await validateAllAgentTypes();
    const err = errors.find((e) => e.startsWith("bad.md") && e.includes("inherits must be a string"));
    expect(err).toBeDefined();
  });

  test("rejects non-string inherits (object)", async () => {
    await writeType("bad", `---
inherits:
  name: manager
---
`);

    const errors = await validateAllAgentTypes();
    const err = errors.find((e) => e.startsWith("bad.md") && e.includes("inherits must be a string"));
    expect(err).toBeDefined();
  });

  test("rejects bare-string repos with a suggestion to use list form", async () => {
    await writeType("bad", `---
repos: muse-ios
---
`);

    const errors = await validateAllAgentTypes();
    const err = errors.find(
      (e) =>
        e.startsWith("bad.md") &&
        e.includes("repos must be a YAML list of strings") &&
        e.includes('"muse-ios"'),
    );
    expect(err).toBeDefined();
  });

  test("rejects empty repos list (unspawnable trap)", async () => {
    await writeType("bad", `---
repos: []
---
`);

    const errors = await validateAllAgentTypes();
    const err = errors.find(
      (e) => e.startsWith("bad.md") && e.includes("empty list makes the type unspawnable"),
    );
    expect(err).toBeDefined();
  });

  test("numeric repos entries are coerced to strings by the parser (no false positives)", async () => {
    // The simple YAML parser converts block-list and inline-array numeric
    // tokens to strings (`- 1` → "1"). This test documents that behavior
    // so the validator's "repos entries must be strings" check is reserved
    // for shapes the parser can't flatten — e.g. direct object entries
    // (covered by the next test).
    await writeType("coerced", `---
repos:
  - 1
  - 2
---
`);

    const errors = await validateAllAgentTypes();
    // No errors should be reported for this file — numeric tokens become
    // string "1"/"2" after parsing, and the validator accepts strings.
    const hasFileErrors = errors.some((e) => e.startsWith("coerced.md"));
    expect(hasFileErrors).toBe(false);

    const type = await loadAgentType("coerced");
    expect(type.repos).toEqual(["1", "2"]);
  });

  test("rejects object repos (not a list)", async () => {
    await writeType("bad", `---
repos:
  foo: bar
---
`);

    const errors = await validateAllAgentTypes();
    // Depending on how the parser treats nested object, either shape error or
    // list-of-strings error should fire.
    const err = errors.find(
      (e) => e.startsWith("bad.md") && (e.includes("repos must be a list of strings") || e.includes("repos must be a YAML list of strings") || e.includes("repos entries must be strings")),
    );
    expect(err).toBeDefined();
  });
});

describe("loadAgentType: repos field", () => {
  const originalHome = process.env.HOME;
  let tempHome: string;
  let typesDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "itsybitsy-repos-load-"));
    process.env.HOME = tempHome;
    typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function writeType(name: string, content: string): Promise<void> {
    await Bun.write(join(typesDir, `${name}.md`), content);
  }

  test("repos absent -> AgentType.repos === undefined", async () => {
    await writeType("unrestricted", `---
name: unrestricted
description: no repo restriction
---
body`);

    const type = await loadAgentType("unrestricted");
    expect(type.repos).toBeUndefined();
  });

  test("repos list populates AgentType.repos", async () => {
    await writeType("restricted", `---
name: restricted
repos: [muse-ios, muse-mac]
---
body`);

    const type = await loadAgentType("restricted");
    expect(type.repos).toEqual(["muse-ios", "muse-mac"]);
  });

  test("repos inherits from parent when child omits it", async () => {
    await writeType("parent", `---
name: parent
repos: [parent-repo]
---
body`);
    await writeType("child", `---
inherits: parent
---
body`);

    const type = await loadAgentType("child");
    expect(type.repos).toEqual(["parent-repo"]);
  });

  test("repos on child overrides parent's list entirely", async () => {
    await writeType("parent", `---
name: parent
repos: [parent-repo, shared-repo]
---
body`);
    await writeType("child", `---
inherits: parent
repos: [child-repo]
---
body`);

    const type = await loadAgentType("child");
    expect(type.repos).toEqual(["child-repo"]);
  });
});

describe("buildAvailableTypesSection / listSpawnableAgentTypesSync", () => {
  const originalHome = process.env.HOME;
  let tempHome: string;
  let typesDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "itsybitsy-available-types-"));
    process.env.HOME = tempHome;
    typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function writeType(name: string, content: string): Promise<void> {
    await Bun.write(join(typesDir, `${name}.md`), content);
  }

  test("listSpawnableAgentTypesSync returns name + description for spawnable types", async () => {
    await writeType("manager", `---
name: manager
description: Manages sub-agents and coordinates work
---
body`);
    await writeType("worker", `---
name: worker
description: Implements a focused task
---
body`);

    const types = listSpawnableAgentTypesSync();
    expect(types).toEqual([
      { name: "manager", description: "Manages sub-agents and coordinates work" },
      { name: "worker", description: "Implements a focused task" },
    ]);
  });

  test("listSpawnableAgentTypesSync excludes layer types (spawnable: false)", async () => {
    await writeType("manager", `---
name: manager
description: Manages sub-agents
---
body`);
    await writeType("_all", `---
name: _all
spawnable: false
description: Layer file
---
body`);
    await writeType("_non_coordinator", `---
name: _non_coordinator
spawnable: false
description: Another layer file
---
body`);

    const types = listSpawnableAgentTypesSync();
    const names = types.map((t) => t.name);
    expect(names).toContain("manager");
    expect(names).not.toContain("_all");
    expect(names).not.toContain("_non_coordinator");
  });

  test("listSpawnableAgentTypesSync handles missing description gracefully", async () => {
    await writeType("plain", `---
name: plain
---
body`);

    const types = listSpawnableAgentTypesSync();
    expect(types).toEqual([{ name: "plain", description: "" }]);
  });

  test("listSpawnableAgentTypesSync strips quotes from description", async () => {
    await writeType("quoted", `---
name: quoted
description: "A quoted description"
---
body`);

    const types = listSpawnableAgentTypesSync();
    expect(types[0]?.description).toBe("A quoted description");
  });

  test("buildAvailableTypesSection produces markdown with header and list", async () => {
    await writeType("manager", `---
name: manager
description: Manages sub-agents
---
body`);
    await writeType("worker", `---
name: worker
description: Implements a focused task
---
body`);

    const section = buildAvailableTypesSection();
    expect(section).toContain("### Available Agent Types");
    expect(section).toContain("`ib new-agent --type <name> \"task\"`");
    expect(section).toContain("`manager` — Manages sub-agents");
    expect(section).toContain("`worker` — Implements a focused task");
  });

  test("buildAvailableTypesSection excludes layer types from output", async () => {
    await writeType("manager", `---
name: manager
description: Manages sub-agents
---
body`);
    await writeType("_all", `---
name: _all
spawnable: false
description: Layer file
---
body`);

    const section = buildAvailableTypesSection();
    expect(section).toContain("`manager`");
    expect(section).not.toContain("_all");
    expect(section).not.toContain("Layer file");
  });

  test("buildAvailableTypesSection omits em-dash when description is empty", async () => {
    await writeType("plain", `---
name: plain
---
body`);

    const section = buildAvailableTypesSection();
    expect(section).toContain("- `plain`");
    expect(section).not.toContain("- `plain` —");
  });

  test("listSpawnableAgentTypesSync ignores nested description: keys", async () => {
    // A nested key like permissions.description would be incorrectly picked
    // up by a flat scan. The top-level description should win.
    await writeType("nested", `---
name: nested
description: top-level
permissions:
  description: nested-should-be-ignored
---
body`);

    const types = listSpawnableAgentTypesSync();
    expect(types).toEqual([{ name: "nested", description: "top-level" }]);
  });

  test("listSpawnableAgentTypesSync returns empty description when only nested description: is present", async () => {
    await writeType("only-nested", `---
name: only-nested
permissions:
  description: nested-only
---
body`);

    const types = listSpawnableAgentTypesSync();
    expect(types).toEqual([{ name: "only-nested", description: "" }]);
  });

  test("listSpawnableTypeNamesSync still returns names only after refactor", async () => {
    await writeType("manager", `---
name: manager
description: Manages sub-agents
---
body`);
    await writeType("worker", `---
name: worker
description: Worker
---
body`);
    await writeType("_all", `---
name: _all
spawnable: false
---
body`);

    expect(listSpawnableTypeNamesSync()).toEqual(["manager", "worker"]);
  });
});

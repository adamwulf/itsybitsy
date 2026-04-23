# Agent Type Inheritance + Repo Restriction — Implementation Plan (Revised)

Revised after review cycle #1. Resolves all ranked punch-list items from both reviewers.

---

## Overview

Two independent additions to the agent-types system:

1. **`inherits: <parent-type>`** — YAML frontmatter field that makes a type inherit scalar fields (with override) and permission lists (with merge) from another type.
2. **`repos: [name, ...]`** — YAML frontmatter field that restricts which registered repos a type can be spawned in.

Both changes are scoped to the agent-type resolution layer (`src/agent-types.ts`) and a small additive check in `newAgent` (for `repos`). Downstream consumers — `ib-commands.ts` permission assembly, `session-start.ts`, `intercept-task.ts`, `coordinator.ts` — see the merged/resolved `AgentType` and do not need code changes beyond the new `repos` check.

---

# Part 1 — `inherits:`

## Resolution model

The resolver operates on **raw parsed frontmatter objects**, not on already-constructed `AgentType` records. This matters because an `AgentType` built per-file would have already applied defaults (e.g., `canSpawnChildren: frontmatter.canSpawnChildren === true` → `false` when absent), collapsing the "absent vs explicit false" distinction. By merging raw frontmatters first and constructing the `AgentType` once at the end, `canSpawnChildren: false` declared on a child correctly overrides a parent's `true`.

Pipeline (new):

```
loadAgentType("researcher")
  1. resolveChain("researcher") → [raw_base, raw_mid, raw_leaf]   (root-first)
  2. mergedFrontmatter = mergeRawFrontmatters(chain)
  3. buildAgentTypeFromFrontmatter(mergedFrontmatter, mergedBody, name="researcher")
```

### Chain resolution

`resolveChain(name, visited: string[])` reads `<name>.md`, parses frontmatter, and if `inherits:` is set, recurses on the parent. `visited` carries the chain so far; if `parent ∈ visited`, throw `Circular inheritance detected: a → b → c → a`. Self-inheritance is the degenerate case of the same check.

Missing parent throws: `Type '<child>' inherits from unknown type '<parent>' (file not found: ~/.itsybitsy/agent-types/<parent>.md)`.

Chain returns root-first: `[root, ..., leaf]`. Merge folds left-to-right, so descendants overwrite.

### Merge rules

Merge input: a list of `{frontmatter, body}` pairs (root → leaf). Output: a single `{frontmatter, body}`.

| Field | Rule |
|---|---|
| `name` | **Never inherited.** Always set to the filename (basename minus `.md`) in `buildAgentTypeFromFrontmatter`. |
| `description` | Child's frontmatter value replaces parent's if the key is **present** in child. |
| `canSpawnChildren` | Child replaces if key is **present** in child (including explicit `false`). |
| `icon` | Child replaces if key is **present** and non-empty. |
| `model` | Child replaces if key is **present** and non-empty string (empty string → inherit, matches existing `""` → `undefined` coercion in `loadAgentType`). |
| `instructionStyle` | Child replaces if key is **present**. |
| `allowedPaths` | Child replaces if key is **present** (replacement, not merge — matches existing "`[]` = strict" semantics). |
| `repos` | Child replaces if key is **present** (replacement, not merge — see Part 2). |
| `markdownBody` | Child replaces if child body is **non-empty** (after `.trim()`). |
| `permissions.allow` | **Union across chain**, deduped via `Set`. |
| `permissions.deny` | **Union across chain**, deduped via `Set`. |
| `spawnable` | **NOT inherited.** Always read from the target file only. See §spawnable below. |
| `inherits` | Metadata only — never written onto the resolved `AgentType`. |

"Present" means the YAML key appears literally in the frontmatter source. We detect this via `Object.keys(frontmatter).includes(key)` — safe because the parser in `parseAgentTypeFile` only ever writes keys drawn from the source (verified by reading src/agent-types.ts:50-184).

#### Empty-string `inherits:`

An explicit empty string (`inherits:` with no value, or `inherits: ""`) is treated as **absent** (no parent). This matches the `model: ""` → inherit/no-override convention.

#### Why `spawnable` is not inherited

`listSpawnableTypeNamesSync` (src/agent-types.ts:389) does a lightweight sync scan of each file's own frontmatter for `spawnable: false`. It does not resolve inheritance. If `spawnable` were inherited, a file without the field but whose parent has `spawnable: false` would be filtered by `loadAgentType` but still appear in the sync scanner — they'd disagree. Making `spawnable` non-inherited keeps both consistent.

Documented behavior: `spawnable: false` is a per-file declaration. A type that wants to be non-spawnable must say so in its own frontmatter.

#### Why `permissions` merges but `allowedPaths` and `repos` replace

`permissions` is additive by design — the existing `_all.md` / `_non_coordinator.md` layer system already merges allow/deny via `Set`. Inheritance extends that model for type chains.

`allowedPaths` and `repos` are **access restrictions**; merging them would quietly widen the attack surface (a strict child with `allowedPaths: []` inheriting from a permissive parent would inadvertently get the parent's paths). Replace-on-redefine keeps the child in control. A child that wants to extend the parent's list must copy+extend explicitly.

### Layer files (`_all.md`, `_non_coordinator.md`)

**Layer files may NOT use `inherits:`.** `validateAllAgentTypes` rejects `inherits:` in any file whose own frontmatter has `spawnable: false`. Rationale: layer files inject their body into every spawned agent. A layer inheriting an unrelated type's body would silently prepend that body to every agent's prompt — a high-blast-radius footgun. Disallowing this closes the loophole at zero cost (users can always edit the layer file directly).

Error message: `_all.md: layer files (spawnable: false) cannot use 'inherits:' — layer files inject their body into every agent and inheritance would be surprising.`

### Hot-path note

`intercept-task.ts:151,201` calls `loadAgentType(agentType)` on every tool-use hook invocation. Under inheritance, each call walks the chain and re-reads every file. Chain depth is user-controlled; in practice 1–3 hops. Sub-millisecond on APFS. If profiling ever flags this, the fix is a short-lived in-process cache keyed on resolved type name — left as a follow-up, not required for v1.

### Migration / backwards compatibility

- Existing `manager.md`, `worker.md`, `coordinator.md`, `_all.md`, `_non_coordinator.md` do not declare `inherits:` — they resolve identically (single-file chain → same result). No behavioral change.
- Users authoring new types with `inherits:` and then downgrading to an older `ib` binary: the older binary's `loadAgentType` ignores unknown frontmatter keys, so the child file is read standalone (missing the parent's fields). This is a graceful failure — the type loads but lacks merged permissions. Documented in `docs/agent-types/README.md`.

## Code changes — Part 1

### `src/agent-types.ts`

1. **New private helper**: `parseAgentTypeFileRaw(content)` returns `{ frontmatter, body }`. (Thin rename of existing `parseAgentTypeFile` export — keep the export name; helper just clarifies the role.)
2. **New function**: `resolveChain(name: string, visited: string[] = []): Promise<Array<{name: string; frontmatter: Record<string, unknown>; body: string}>>`. Reads `<name>.md`, parses, recurses on `inherits:` if present. Throws on cycles and missing parents with the error messages above.
3. **New function**: `mergeRawFrontmatters(chain: Array<{frontmatter, body}>): {frontmatter, body}`. Folds left-to-right per the rules table. Only merges frontmatters — `buildAgentTypeFromFrontmatter` applies defaults.
4. **New function**: `buildAgentTypeFromFrontmatter(frontmatter, body, name): AgentType`. Factored out of existing `loadAgentType` body (src/agent-types.ts:340-354). Uses `name` parameter for the `AgentType.name` field (never reads from frontmatter → guarantees rule "`name` is never inherited"). Reads `spawnable` directly from the leaf file (caller passes the leaf's raw `spawnable`).
5. **Rewrite `loadAgentType(name)`**: compose `resolveChain` → `mergeRawFrontmatters` → `buildAgentTypeFromFrontmatter`. Read `spawnable` from the leaf file separately so chain-merge doesn't affect it.
6. **Extend `validateAllAgentTypes`**:
   - Reject non-string `inherits` with `"${file}: inherits must be a string (the name of the parent type)"`.
   - Reject `inherits` in layer files (`spawnable: false`) with the error above.
   - After per-file checks, call `loadAgentType(basename)` in a try/catch for every type file; push any thrown error to the errors list. Catches cycles and missing parents at `ib watch` startup.

### No changes required in

- `src/ib-commands.ts` — already uses `await loadAgentType(...)`, which now transparently returns the merged type.
- `src/hooks/session-start.ts` — same.
- `src/hooks/intercept-task.ts` — same.
- `src/coordinator.ts` — `buildPerRepoCoordinatorSettings` uses hardcoded allow/deny plus `_all.md` merge. It does NOT load `coordinator.md`. Because layer files can't use `inherits:` (new rule), no action needed. A future PR can choose to honor `coordinator.md` inheritance here; it's intentionally out of scope now because this path is security-sensitive and a misconfigured chain could widen coordinator permissions.

### Tests (`src/agent-types.test.ts`)

All new tests MUST use the `mkdtemp` + `process.env.HOME` swap pattern from `describe("initAgentTypes")` at src/agent-types.test.ts:338 (per reviewer #2 punch-list item 7). Top-level `test(...)` blocks rely on the real HOME and will pollute/consume user config.

Test cases (each asserts message text where validation is expected to fail):

- **Scalars override**: child with `description: "new"` overrides parent's `description`.
- **Scalars inherit**: child omits `model` → inherits parent's `model`.
- **`canSpawnChildren: false` on child overrides true on parent** (regression for the raw-frontmatter-merge decision).
- **`name` is never inherited** — even if parent's frontmatter has `name: other`, child resolves to its own filename.
- **`spawnable` is never inherited** — child without `spawnable:` and parent with `spawnable: false` → child is spawnable (regression for sync/async consistency).
- **`permissions.allow` merges and dedupes** across chain.
- **`permissions.deny` merges and dedupes** across chain.
- **Multi-level chain (A → B → C)**: merges and overrides correctly in order.
- **`markdownBody` inherits** when child body is empty.
- **`markdownBody` overrides** when child body is non-empty.
- **`allowedPaths` replaces** (not merges) when child defines it.
- **`allowedPaths: []` on child** correctly overrides parent's non-empty list.
- **`repos` replaces** when child defines it (see Part 2).
- **Empty-string `inherits: ""`** treated as absent.
- **Missing parent** throws with `"Type 'child' inherits from unknown type 'missing'"` — assert message content.
- **Self-cycle (A inherits A)** throws `"Circular inheritance"` and includes the chain.
- **Two-node cycle (A → B → A)** throws.
- **Three-node cycle (A → B → C → A)** throws.
- **Layer file with `inherits:`** — `_all.md` with `inherits: manager` → `validateAllAgentTypes` returns an error listing the layer filename.
- **`validateAllAgentTypes` flags circular chains** at startup.
- **`validateAllAgentTypes` flags missing parent** at startup.
- **Non-string `inherits`** (array/object/boolean) flagged by `validateAllAgentTypes`.
- **Inherited body interpolates with child's context**: child without body, parent body contains `{{agentId}}` → `generateInstructions` renders the child's agent ID, not the parent's (ensures inheritance doesn't break `interpolateTemplate`).
- **Tree of types still allows `listAgentTypes()` to return all**: chain-valid types appear; chain-broken types are still excluded (existing behavior preserved).

---

# Part 2 — `repos:` restriction

## Semantics

`repos:` in an agent type's frontmatter is either:

- **Absent** — no restriction (current default). Type can be spawned in any repo.
- **A non-empty YAML list of strings** (`[a, b]` or block list) — the root repo's basename **or** nickname must match one entry. Otherwise `ib new-agent --type <type>` fails with a clear error.
- **Anything else** — validation error at `ib watch` startup.

### Rejected forms (validation errors)

| Form | Error |
|---|---|
| `repos: muse-ios` (bare string) | `repos must be a YAML list of strings; got string "muse-ios". Use [muse-ios] or a multi-line list.` |
| `repos: []` (empty list) | `repos must be absent (no restriction) or a non-empty list; an empty list makes the type unspawnable.` |
| `repos: [1, 2]` | `repos entries must be strings; got number.` |
| `repos: {}` (object) | `repos must be a list of strings.` |

Rejecting `repos: []` matches reviewer #2's punch-list item 6 and reviewer #1's item 15 — a YAML typo silently disabling a type is worse than the type failing loudly at startup.

### Matching rule

Given `rootRepoPath` (resolved via `resolveGitRoot`):

1. Look up `listRepos().find(r => r.path === rootRepoPath)`.
2. If registered: a match requires the `repos` list to contain the repo's **basename** (`entry.name`) OR its **nickname** (`entry.nickname`, if set).
3. If unregistered: fall back to `basename(rootRepoPath)`. Matches only via basename.

Case-sensitive. Entries trimmed of surrounding whitespace.

### Unknown-name warning

`validateAllAgentTypes` additionally produces a **warning** (not error) if any `repos` entry matches neither a current basename nor nickname in `repos.json`. The warning names the type file and the unresolved entry. Startup does not abort — users may register the repo later; this is a nudge, not a fence.

**Implementation note**: `validateAllAgentTypes` currently returns `string[]` of errors. Add a second parallel function (or extend the return shape to `{errors: string[], warnings: string[]}`) and have the caller at `ib watch` startup print warnings at INFO level. If extending the shape is more invasive than worth the nudge, we can demote to an error or defer. **Decision**: defer the warning to a follow-up if it balloons scope — warnings are not strictly required for v1.

### Inheritance interaction

`repos` **replaces** on child definition, never merges (see rules table). Child without `repos:` inherits parent's `repos` (if any). This means:

- To add a restriction on top of an unrestricted parent: set `repos:` in the child.
- To remove a parent's restriction: there is no syntactic way in v1. Document this: "to undo a parent's `repos` restriction, either remove `inherits:` or use an intermediate parent without `repos`." No sentinel-string escape hatch in v1 (keeps YAML shape simple; punch-list item 17 noted).

### `newAgent` check placement

In `src/ib-commands.ts:newAgent`, insert the check **after** `const agentTypeDef = await loadAgentType(typeName);` (line 1468) and **before** the coordinator-mode branch at line 1475. Rationale:

- Must run after `loadAgentType` so the resolved (potentially inherited) `repos` list is available.
- Must run before worktree/tmux/agent-dir creation so rejection leaves no residue.
- Must run before the coordinator idempotency check — a restricted coordinator type spawned in the wrong repo should fail with the repo error, not silently succeed via idempotency.

```ts
if (agentTypeDef.repos !== undefined) {
  const repos = await listRepos();
  const entry = repos.find(r => r.path === rootRepoPath);
  const basenameOnly = basename(rootRepoPath);
  const candidates = entry
    ? [entry.name, entry.nickname].filter((s): s is string => typeof s === "string" && s.length > 0)
    : [basenameOnly];
  const allowed = agentTypeDef.repos.map(s => s.trim()).filter(Boolean);
  const ok = candidates.some(c => allowed.includes(c));
  if (!ok) {
    const display = entry ? repoDisplayName(entry) : basenameOnly;
    return {
      ok: false, exitCode: 1, stdout: "",
      stderr: `Error: agent type '${typeName}' is restricted to repos [${allowed.join(", ")}]; current repo '${display}' (path: ${rootRepoPath}) is not in that list`,
    };
  }
}
```

`listRepos` and `repoDisplayName` are already imported at src/ib-commands.ts:34. `basename` from `path` is used elsewhere in the file.

### Coordinator interaction

A restricted `coordinator.md` with `repos: [foo]` means system-coordinator-spawned per-repo coordinators will fail for any repo other than `foo`. This is a legitimate and possibly desired use case (e.g., restricting the personal-assistant pattern to one repo). Documented behavior; not a bug.

### `--name` bypass

The existing `--name` flag overrides agent-id generation but not type resolution. The `repos` check runs before name generation, so `--name foo --type restricted` still fails correctly if the repo doesn't match. Confirmed by reading src/ib-commands.ts:1699.

## Code changes — Part 2

### `src/agent-types.ts`

1. Extend `AgentType` interface:
   ```ts
   /** If defined, this type can only be spawned in repos whose name or nickname matches an entry. */
   repos?: string[];
   ```
2. In `buildAgentTypeFromFrontmatter`: parse `repos` analogously to `allowedPaths`:
   - Absent → `undefined`
   - Array of strings → trim each, drop empties, assign
   - Any other shape → validation should have caught it; defensive: treat as `undefined` here (validator is the actual gate).
3. In `validateAllAgentTypes`: add `repos` checks per the validation table above.

### `src/ib-commands.ts`

Add the `repos` check in `newAgent` as shown above. No other changes.

### Tests (`src/agent-types.test.ts` + `src/ib-commands.test.ts`)

**`agent-types.test.ts`** (same HOME-swap pattern):

- `repos` absent → `AgentType.repos === undefined`.
- `repos: [muse-ios, muse-mac]` → `AgentType.repos === ["muse-ios", "muse-mac"]`.
- `repos` inherits from parent when child omits it.
- `repos` on child overrides parent's list entirely.
- `validateAllAgentTypes` rejects `repos: "muse-ios"` (string) with a message that names the file and suggests the list form.
- `validateAllAgentTypes` rejects `repos: []` with the "empty list makes the type unspawnable" message.
- `validateAllAgentTypes` rejects `repos: [1, 2]` ("entries must be strings").
- `validateAllAgentTypes` rejects `repos: {}` (object).

**`ib-commands.test.ts`** (extend existing `newAgent` fixture pattern):

- `newAgent` accepts when type's `repos` includes the current repo's basename.
- `newAgent` accepts when type's `repos` includes the current repo's nickname (not basename).
- `newAgent` rejects with a clear message when the current repo matches no entry.
- `newAgent` accepts (regression) when `repos` is absent — existing types continue to work.
- `newAgent` rejects when `repos` is inherited from a parent and current repo doesn't match.
- `newAgent` accepts when the repo is unregistered but its basename appears in `repos`.

---

## Docs

- **`SPEC.md` §2.6**: add `inherits` and `repos` rows to the frontmatter fields table. Note the per-field merge rules (override / merge / replace / never-inherited).
- **`SPEC.md` §2.5 (or similar)**: add a sentence: `spawnable` is per-file (never inherited) and layer files (`spawnable: false`) cannot use `inherits:`.
- **`docs/agent-types/README.md`**: add two worked examples:
  1. `researcher.md` with `inherits: worker` and extra `permissions.allow`.
  2. A type restricted to specific repos via `repos: [muse-ios, muse-mac]`.
- Mention briefly that older `ib` binaries ignore unknown frontmatter fields and will read the child file as-is (graceful degradation).

---

## Out of scope (deferred)

- TUI display of inherited chain (info panel showing `Type: researcher ← worker`).
- `inheritsFrom?: string[]` on the resolved `AgentType` for debug/display.
- In-process `loadAgentType` cache for hot paths.
- `buildPerRepoCoordinatorSettings` honoring `coordinator.md` inheritance.
- Sentinel value to "remove" an inherited `repos` restriction (e.g., `repos: "*"`).
- Registry-warning validation (`repos:` entry names an unregistered repo) — mentioned as a stretch but skipped from v1 if return-shape change is invasive. Can be promoted to an error via the existing `validateAllAgentTypes` → `string[]` path as a one-line follow-up.

---

## Acceptance criteria

- `bun test` passes (all existing + new tests).
- `bunx tsc --noEmit` reports zero errors.
- `researcher.md` with `inherits: worker` and extra `permissions.allow` produces a resolved type with merged permissions and no `inherits` key exposed on the result.
- A child with `canSpawnChildren: false` correctly overrides a parent with `canSpawnChildren: true`.
- Cycles and missing parents surface as errors at `ib watch` startup (via `validateAllAgentTypes`), not as spawn-time crashes.
- `repos: [foo]` on a type makes `ib new-agent --type <type>` from a non-`foo` repo fail with the error message above and leave no residue (no worktree created, no meta.json).
- `repos: []`, bare-string `repos`, and non-string `repos` entries all fail validation with file+reason messages.
- Existing `manager.md`, `worker.md`, `coordinator.md`, `_all.md`, `_non_coordinator.md` behave identically (no `inherits:` or `repos:` declared — resolved result is unchanged).
